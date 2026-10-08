<script setup lang="ts">
import { NAlert, NButton, NCard, NEmpty, NPopconfirm, NProgress, NSpace, NSpin, NTag, useMessage } from 'naive-ui'
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { describeError } from '../api/client.js'
import { taskApi } from '../api/endpoints.js'
import { usePlatformStore } from '../stores/platform.js'
import {
  type ActionLog,
  type ActionLogSummary,
  actionLogRows,
  describeOutcome,
  isUnsettledOutcome,
  itemNamesTheAction,
  type ReconcileToday,
  reconcileTodayOf,
  TASK_STATUS_LABEL,
  TASK_STATUS_TAG,
  TaskAction,
  type TaskWithProgress
} from '../types/api.js'

/**
 * Task list with live progress.
 *
 * Polls while the tab is visible so a running task's counters move without a
 * manual refresh. The interval stops on unmount and while hidden — a background
 * tab does not need to keep asking.
 *
 * Two kinds of task are rendered differently, and that follows from the executor
 * rather than from the Platform: a **Send** task has a cursor into a Library and
 * a pass counter, while a **Reconcile** task has neither — it asks the Platform
 * what is outstanding and finishes — so showing "第几条 / 第几遍" for one would be
 * inventing a progress figure the server never keeps. A **Reconcile** task names one
 * action, so its row shows what that action did today and its lifetime counters
 * underneath.
 *
 * The Platform and the Action are shown through the catalogue's own labels: the
 * `actionKey` on the task is data, and `send_danmaku` is not what a person calls
 * it.
 */
const router = useRouter()
const message = useMessage()
const catalog = usePlatformStore()

const loading = ref(true)
const tasks = ref<TaskWithProgress[]>([])
const error = ref('')

/**
 * One clock per poll, handed to the "还没到时间" check.
 *
 * Recomputed on every load rather than read from `Date.now()` inside the render,
 * so a row's verdict and the data it came with are from the same instant.
 */
const loadedAt = ref(Date.now())

let timer: ReturnType<typeof setInterval> | null = null

async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true
  try {
    tasks.value = await taskApi.list()
    loadedAt.value = Date.now()
    error.value = ''
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

function startPolling(): void {
  stopPolling()
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') void load(true)
  }, 5000)
}

function stopPolling(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

async function setStatus(task: TaskWithProgress, status: TaskWithProgress['status']): Promise<void> {
  try {
    await taskApi.setStatus(task.id, status)
    message.success('已更新')
    await load(true)
  } catch (cause: unknown) {
    message.error(describeError(cause))
  }
}

async function reset(id: number): Promise<void> {
  try {
    await taskApi.reset(id)
    message.success('进度已重置')
    await load(true)
  } catch (cause: unknown) {
    message.error(describeError(cause))
  }
}

async function remove(id: number): Promise<void> {
  try {
    await taskApi.remove(id)
    message.success('已删除')
    await load(true)
  } catch (cause: unknown) {
    message.error(describeError(cause))
  }
}

function isTerminal(status: string): boolean {
  return status === 'done' || status === 'canceled' || status === 'failed'
}

/** The Platform's name and the Action's name, both from the catalogue. */
function platformLabel(key: string): string {
  return catalog.labelOf(key)
}

function actionLabel(platform: string, actionKey: string): string {
  return catalog.actionLabel(platform, actionKey)
}

function logRows(summary: ActionLogSummary | undefined): ReturnType<typeof actionLogRows> {
  return summary === undefined ? [] : actionLogRows(summary)
}

/**
 * What today adds up to for a reconcile task.
 *
 * The calculation is `reconcileTodayOf`, and it asks about **one action**: the one this Task's own
 * row names, since a reconcile Task runs exactly that. The switch on it comes from the store (the
 * `actionKey` a Task carries is what the scheduler hands the adapter), and its settled state comes
 * from the task's `settledTodayKeys`, which the server derives with the same query and the same
 * Platform day the scheduler uses. Nothing here infers "today" from the status or from the lifetime
 * counters — those are precisely the two approximations that show a task as finished when it is not,
 * or as untouched when it is.
 */
function todayOf(task: TaskWithProgress): ReconcileToday {
  return reconcileTodayOf(task.actionKey, catalog.switchOf(task.platform, task.actionKey), task.settledTodayKeys)
}

/** The action's catalogue name — what a person calls the one thing this Task does. */
function actionName(task: TaskWithProgress): string {
  return catalog.actionLabel(task.platform, task.actionKey)
}

/** True before the task's window has opened, which is a different story from "没做完". */
function windowNotOpen(task: TaskWithProgress, now: number): boolean {
  return now < task.startTime
}

/** True once the window has closed: from here on the status is `时间窗已结束`. */
function windowClosed(task: TaskWithProgress, now: number): boolean {
  return now >= task.endTime
}

/**
 * Why the day has no verdict, in the words of whichever half could not answer.
 *
 * `reconcileTodayOf` reports its two causes apart because they are not one sentence, and this row
 * used to print the server's for both — so the ordinary first paint, where the task list answers
 * before the catalogue (this view fires `catalog.ensure()` without awaiting it), blamed the server
 * for a fact about this process. A catalogue that never arrives, or one written by a newer build
 * without this Platform, leaves the same sentence standing for good.
 */
function noVerdictNote(task: TaskWithProgress): string {
  const verdict = todayOf(task)
  if (verdict.kind !== 'unknown') return ''
  return verdict.why === 'no-switch'
    ? '动作目录还没读到（或者这个版本的目录里没有这个平台），所以现在还不知道今天的动作落定没有'
    : '服务端没有返回按天的动作状态，这里只显示任务在时间窗内的状态'
}

function startLabel(task: TaskWithProgress): string {
  return new Date(task.startTime).toLocaleString('zh-CN')
}

function targetLabel(task: TaskWithProgress): string {
  if (task.targetTitle !== '') return task.targetTitle
  return task.targetKey !== '' ? `目标 ${task.targetKey}` : '账号自身'
}

/**
 * Today's record for the action this Task names, whatever it last came to.
 *
 * A row answers 「今天这个动作怎么样了」, which is a question about the action rather than about runs:
 * a retry that finally settled, or a parking report followed by a real run, has **one** answer and it
 * is the last one, so the later record replaces the earlier one. The detail page makes the opposite
 * choice for the opposite reason: it is where somebody is looking at the day's history, so it shows
 * every run.
 */
function todayActions(task: TaskWithProgress): readonly ActionLog[] {
  const latest = new Map<string, ActionLog>()
  for (const record of task.actionLogsToday ?? []) latest.set(record.actionKey, record)
  return [...latest.values()]
}

/** The action's catalogue name; a key this build cannot name is described, never shown. */
function recordActionLabel(task: TaskWithProgress, actionKey: string): string {
  return catalog.descriptorOf(task.platform, actionKey)?.label ?? '未知动作'
}

/**
 * What each of the action's things got done, as one line of facts.
 *
 * The per-item fact rather than the per-item outcome word: 「主版块 等级分 +3 · 斗鱼官方手游区 已签」
 * is the answer to 「今天这个动作怎么样了」, where the outcome word only restated the vocabulary
 * the settled rows no longer print. An item named after the action itself contributes its fact
 * alone — the row already carries that name — and a record that named no item stays described by
 * its own sentence, because that sentence is then all there is (see `ActionRecordList`).
 */
function resultLine(task: TaskWithProgress, record: ActionLog): string {
  if (record.items.length === 0) return record.detail
  return record.items
    .map(item =>
      itemNamesTheAction(item, recordActionLabel(task, record.actionKey)) ? item.detail : `${item.label} ${item.detail}`
    )
    .join(' · ')
}

onMounted(async () => {
  // The catalogue supplies both labels on every row; load it alongside the tasks.
  void catalog.ensure()
  await load()
  startPolling()
})

onUnmounted(stopPolling)
</script>

<template>
  <NCard title="任务">
    <template #header-extra>
      <NSpace>
        <NButton @click="router.push({ name: 'library-import' })">导入文本</NButton>
        <NButton @click="router.push({ name: 'action-settings' })">动作开关</NButton>
        <NButton type="primary" @click="router.push({ name: 'task-create' })">创建任务</NButton>
      </NSpace>
    </template>

    <NAlert v-if="error !== ''" type="error" class="mb">{{ error }}</NAlert>

    <NSpin :show="loading">
      <!-- Claimed only when the read succeeded. A failed `GET /api/tasks` leaves the list empty and
           `error` set, and 「还没有任务」 beside it is the one sentence a person acts on. -->
      <NEmpty v-if="tasks.length === 0 && !loading && error === ''" description="还没有任务" />

      <NSpace v-else vertical :size="16">
        <NCard v-for="task in tasks" :key="task.id" size="small">
          <template #header>
            <NSpace align="center">
              <NTag size="small" :bordered="false">{{ platformLabel(task.platform) }}</NTag>
              <span>{{ targetLabel(task) }}</span>
              <NTag size="small" :type="TASK_STATUS_TAG[task.status]">
                {{ TASK_STATUS_LABEL[task.status] }}
              </NTag>
            </NSpace>
          </template>

          <NSpace vertical :size="10">
            <div class="row">
              <span class="label">动作</span>
              <NSpace align="center" :size="8">
                <span>{{ actionLabel(task.platform, task.actionKey) }}</span>
                <NTag size="tiny" :bordered="false">
                  {{ task.action === TaskAction.Send ? '发送动作' : '整理动作' }}
                </NTag>
              </NSpace>
            </div>

            <!-- Send: a cursor into a Library, so "第几条 / 第几遍" is real. -->
            <div v-if="task.action === TaskAction.Send" class="row">
              <span class="label">进度</span>
              <div class="progress">
                <NProgress
                  type="line"
                  :percentage="task.progress.percentInLoop"
                  :height="10"
                  :show-indicator="false"
                  :status="task.status === 'running' ? 'success' : 'default'"
                />
                <span class="hint">
                  第 {{ task.progress.loopCount + 1 }} 遍 ·
                  {{ task.progress.cursor }}<template v-if="task.progress.libraryTotal !== null">/{{ task.progress.libraryTotal }}</template>
                  条
                </span>
              </div>
            </div>

            <!-- Reconcile: no cursor and no passes — the Platform is the only
                 source of truth, so the day is read from `settledTodayKeys` for the
                 one action this Task names, and never from the lifetime counters or
                 from the status alone. -->
            <template v-else>
              <div class="row">
                <span class="label">今日</span>
                <NSpace v-if="todayOf(task).kind === 'done'" align="center" :size="8">
                  <NTag size="small" type="success">今日已完成</NTag>
                  <span class="hint">{{ actionName(task) }} 今天已经落定</span>
                </NSpace>

                <NSpace
                  v-else-if="todayOf(task).kind === 'pending' && windowNotOpen(task, loadedAt)"
                  align="center"
                  :size="8"
                >
                  <NTag size="small">今天还没到执行时间</NTag>
                  <span class="hint">{{ startLabel(task) }} 开始，之后每 {{ task.interval }} 秒核对一次</span>
                  <span class="hint">待办：{{ actionName(task) }}</span>
                </NSpace>

                <!-- The window has closed and the action never settled today. That is the state the
                     status alone used to describe as 「已完成」 while this line said 「还没落定」, and
                     neither sentence alone is the whole truth: nothing more happens today. -->
                <NSpace
                  v-else-if="todayOf(task).kind === 'pending' && windowClosed(task, loadedAt)"
                  align="center"
                  :size="8"
                >
                  <NTag size="small">时间窗已结束，今天的动作没落定</NTag>
                  <span class="hint">窗口已经过完，{{ actionName(task) }} 今天不会再跑</span>
                </NSpace>

                <NSpace v-else-if="todayOf(task).kind === 'pending'" align="center" :size="8">
                  <NTag size="small" type="warning">今天的动作还没落定</NTag>
                  <span class="hint">{{ actionName(task) }}</span>
                </NSpace>

                <NSpace v-else-if="todayOf(task).kind === 'switch-off'" align="center" :size="8">
                  <NTag size="small" type="error">动作开关未打开</NTag>
                  <span class="hint">「{{ actionName(task) }}」没开启，这个任务不会跑</span>
                  <NButton size="tiny" @click="router.push({ name: 'action-settings' })">去动作开关</NButton>
                </NSpace>

                <!-- No verdict, and the sentence comes from `noVerdictNote`: the catalogue is the
                     usual cause here rather than the server, and the row says which one it was. -->
                <NSpace v-else align="center" :size="8">
                  <span class="hint">{{ noVerdictNote(task) }}</span>
                  <span class="hint">
                    时间窗 {{ startLabel(task) }} 起，每 {{ task.interval }} 秒核对一次
                  </span>
                </NSpace>
              </div>

              <!-- Each of today's actions by name and result: the row used to answer
                   "did it run" with a count, which is not a question anybody asks. A tag
                   appears only on an outcome the day has not settled — the header above
                   has already said the rest — and its word comes from `describeOutcome`,
                   so a stored value outside the five is marked with the reading the rest
                   of the system gives it rather than with a tag holding nothing. -->
              <div v-if="todayActions(task).length > 0" class="row">
                <span class="label">今日动作</span>
                <NSpace vertical :size="4" class="results">
                  <div v-for="record in todayActions(task)" :key="record.id" class="result">
                    <span class="result-action">{{ recordActionLabel(task, record.actionKey) }}</span>
                    <NTag
                      v-if="isUnsettledOutcome(record.outcome)"
                      size="tiny"
                      :type="describeOutcome(record.outcome).tag"
                    >
                      {{ describeOutcome(record.outcome).label }}
                    </NTag>
                    <span class="result-detail">{{ resultLine(task, record) }}</span>
                  </div>
                </NSpace>
              </div>

              <!-- What the record table still holds, which is a different question from how today went —
                   and 「累计」 promised a total over the Task's whole life that `summarizeActionLogs` does
                   not compute: it is one `COUNT(*) WHERE task_id = ?` over the rows left after pruning. -->
              <div v-if="logRows(task.actionLogSummary).length > 0" class="row">
                <span class="label">已存记录</span>
                <NSpace :size="12">
                  <NTag v-for="row in logRows(task.actionLogSummary)" :key="row.outcome" size="tiny" :type="row.tag">
                    {{ row.label }} {{ row.count }}
                  </NTag>
                </NSpace>
              </div>
            </template>

            <div class="row">
              <span class="label">统计</span>
              <NSpace :size="16">
                <template v-if="task.action === TaskAction.Send">
                  <span>成功 {{ task.progress.successCount }}</span>
                  <span>失败 {{ task.progress.failCount }}</span>
                </template>
                <span>间隔 {{ task.interval }}s</span>
                <NTag v-if="task.saltEnabled && task.action === TaskAction.Send" size="tiny" type="info">加盐</NTag>
                <NTag v-if="task.requireOnline && task.targetKey !== ''" size="tiny" type="info">等开播</NTag>
              </NSpace>
            </div>

            <div v-if="task.lastError !== ''" class="row">
              <span class="label">错误</span>
              <NTag size="small" type="error">{{ task.lastError }}</NTag>
            </div>

            <NSpace>
              <NButton size="small" @click="router.push({ name: 'task-detail', params: { id: task.id } })">
                详情
              </NButton>

              <NButton
                v-if="task.status === 'running' || task.status === 'offline' || task.status === 'waiting'"
                size="small"
                @click="setStatus(task, 'paused')"
              >
                暂停
              </NButton>

              <NButton v-if="task.status === 'paused'" size="small" type="primary" @click="setStatus(task, 'running')">
                恢复
              </NButton>

              <NButton
                v-if="!isTerminal(task.status)"
                size="small"
                quaternary
                @click="setStatus(task, 'canceled')"
              >
                取消
              </NButton>

              <NButton v-if="isTerminal(task.status)" size="small" type="primary" @click="reset(task.id)">
                重置进度
              </NButton>

              <NPopconfirm @positive-click="() => void remove(task.id)">
                <template #trigger>
                  <NButton size="small" quaternary type="error">删除</NButton>
                </template>
                确定删除这个任务吗？
              </NPopconfirm>
            </NSpace>
          </NSpace>
        </NCard>
      </NSpace>
    </NSpin>
  </NCard>
</template>

<style scoped>
.mb {
  margin-bottom: 16px;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.label {
  width: 48px;
  color: #888;
  font-size: 13px;
  flex-shrink: 0;
}

.progress {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
}

.hint {
  color: #666;
  font-size: 13px;
  white-space: nowrap;
}

.results {
  flex: 1;
  min-width: 0;
}

.result {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.result-action {
  flex-shrink: 0;
}

.result-detail {
  color: #888;
  min-width: 0;
}
</style>
