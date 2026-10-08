<script setup lang="ts">
import {
  NAlert,
  NButton,
  NCard,
  NCollapse,
  NCollapseItem,
  NDescriptions,
  NDescriptionsItem,
  NEmpty,
  NProgress,
  NSpace,
  NSpin,
  NStatistic,
  NTag
} from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { describeError } from '../api/client.js'
import { actionSettingApi, taskApi } from '../api/endpoints.js'
import ActionOptionForm from '../components/ActionOptionForm.vue'
import ActionRecordList from '../components/ActionRecordList.vue'
import TaskEditDialog from '../components/TaskEditDialog.vue'
import { usePlatformStore } from '../stores/platform.js'
import {
  type Account,
  type ActionDescriptor,
  type ActionLog,
  type ActionLogDay,
  type ActionOptionField,
  type ActionOutcome,
  actionLogRows,
  describeLiveStatus,
  describeOutcome,
  type Library,
  type LogSummary,
  type ReconcileToday,
  reconcileTodayOf,
  type SendLog,
  TASK_STATUS_LABEL,
  TASK_STATUS_TAG,
  type TargetFactRead,
  TaskAction,
  type TaskWithProgress
} from '../types/api.js'

/**
 * Task detail: configuration, live progress, and the logs.
 *
 * The Platform and the Action are named through the catalogue, and the sections
 * below follow from the task's **executor** rather than from its Platform:
 *
 *  - a **Send** task has a cursor, a pass counter and a per-message log;
 *  - a **Reconcile** task has none of those — it is work the Platform reports on — so it
 *    shows what the one action it names did, day by day, and its lifetime counters as
 *    context. The send log is hidden for it rather than shown empty, because
 *    "还没有发送记录" would be a lie about a task that never sends anything.
 *
 * **「今天做了没」 and 「历史上做过什么」 are different questions**, and answering them
 * with one aggregate count is what produced the screen this replaces: a task could
 * read 「无需处理 4」 with no way to find out which four, or whether any of them was
 * today. So today is one section, earlier days are another, collapsed by day, and
 * the raw Platform fields are a third — collapsed, and the one place a record's `code`,
 * `action_key` and `detail` are printed verbatim rather than said in names and facts. Two
 * identifiers sit outside it on purpose: the configuration card above prints the Target's key as
 * 「目标」, and a record that named nothing shows its own sentence as its row (`ActionRecordList`
 * says why that row has no fact of its own).
 */
const route = useRoute()
const router = useRouter()
const catalog = usePlatformStore()

/**
 * The Task in the address, as a value rather than a snapshot.
 *
 * It used to be `Number(route.params['id'])` read once in `setup`, which is only right while the
 * component instance and the address change together — and vue-router reuses one instance when two
 * addresses match the same route record, so `/tasks/1` and `/tasks/2` share it. The page then kept
 * showing one Task while the address named another, and the edit dialog, which takes its row from
 * this page, wrote to the row that was still on screen.
 */
const taskId = computed<number>(() => Number(route.params['id']))
const loading = ref(true)
const error = ref('')
const task = ref<TaskWithProgress | null>(null)
const library = ref<Library | null>(null)
const account = ref<Account | null>(null)
const logs = ref<SendLog[]>([])
/** Why the send-attempt log could not be read. Its own slot: see `load`. */
const logsError = ref('')

/** Edit dialog visibility. The server only accepts edits on a paused task. */
const editOpen = ref(false)
const summary = ref<LogSummary>({ total: 0, ok: 0, failed: 0 })

/**
 * How many attempts the send-log list draws.
 *
 * One page of the table, and **the header's three numbers are not it**: they come from
 * `summarizeSendLogs`, one `COUNT(*)`/`SUM(ok)` over the task's whole `send_logs` — bounded by retention
 * and pruned as new rows arrive — while `listSendLogs` answers the newest rows up to the limit asked for
 * here. The sentence inside the card names this constant rather than the number, so the read cap and the
 * sentence explaining it cannot drift apart, which is the arrangement `repo/send-logs.ts` makes for the
 * retention bound on its own side.
 */
const SEND_LOG_PAGE = 100

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN')
}

/** Applies an edit in place — no reload needed, the route returns the full task. */
function onUpdated(next: TaskWithProgress): void {
  task.value = next
}

function accountLabel(value: Account | null): string {
  if (value === null) return '—'
  return value.displayName !== '' ? `${value.displayName}（${value.externalId}）` : value.externalId
}

/** The Action's name as the catalogue gives it, falling back to the raw key. */
function actionLabel(value: TaskWithProgress): string {
  return catalog.actionLabel(value.platform, value.actionKey)
}

/** What the task is aimed at, or "账号自身" for an account-scoped action. */
function targetLabel(value: TaskWithProgress): string {
  if (value.targetTitle !== '') return value.targetTitle
  return value.targetKey !== '' ? `目标 ${value.targetKey}` : '账号自身'
}

/**
 * The Action's own catalogue entry — the source of both its name and the fields it reads.
 *
 * Null while the catalogue is on its way, and for an action a newer build wrote that this one cannot
 * name. The parameters card below is drawn only once this is known, because a form is built out of
 * the field list and nothing may be invented for one that has no declaration: an empty form would
 * read as "there is something here you cannot see".
 */
const descriptor = computed<ActionDescriptor | null>(() =>
  task.value === null ? null : catalog.descriptorOf(task.value.platform, task.value.actionKey)
)

/**
 * The parameters, and **the one thing this page must not do with them**.
 *
 * They belong to the *Action*: the store is `action_settings`, keyed by (person, platform, action), so
 * two Tasks naming one action run with one set of values. This page offers them for editing because
 * this is where a person is standing when a value turns out to be wrong — and it offers **these**
 * values, through the store, never a copy on the Task. A copy would be one fact with two homes, and
 * the second home is the one nobody updates: the run reads `action_settings`.
 */
const optionFields = computed<readonly ActionOptionField[]>(() => descriptor.value?.optionFields ?? [])

/**
 * What is stored for this Task's action, as the parameter form is handed it.
 *
 * The fallback for an action nothing is stored for is the store's shared constant; `optionsOf`'s own
 * note says why a shared reference rather than a fresh `{}` (the form watches this value). The switch
 * the write carries is read from the same store — and it is the server's own answer, because a
 * descriptor is only in hand once the catalogue and the switches landed together.
 */
function storedOptionsOf(current: TaskWithProgress): unknown {
  return catalog.optionsOf(current.platform, current.actionKey)
}

/**
 * The facts of this Task's Target, or `null` while there is nothing to show.
 *
 * **`none` never reaches this ref.** An action this build serves no read for draws no card at all, and
 * the route is the only thing that knows which actions those are: `TargetFactRegistry.read` answers
 * `null` for them and the route turns that into `none`, so the distinction is made where the knowledge
 * is rather than guessed at here.
 */
/**
 * What this page's card can hold: the route's answer with the one member that draws nothing removed.
 *
 * Named rather than left as `TargetFactRead`, and that removal is the invariant `loadTargetFacts`
 * keeps: `none` means this build serves no read for that action, and no card is drawn for it at all —
 * so a page that could hold `none` would have a branch drawing a failure sentence over a read nobody
 * wrote, which is a claim about a Room that nothing established.
 */
type ShownFacts = Exclude<TargetFactRead, { readonly kind: 'none' }>

const targetFacts = ref<ShownFacts | null>(null)

/**
 * Reads what that Room's own panel says, for the Room this Task carries.
 *
 * **A Task with no Target draws nothing and asks nothing**: the read behind these facts is a per-Room
 * read, and an account-scoped action has no Room to read. That is the same discriminator the design
 * splits its two pages by — read here from the Task's own `targetKey`, because this page holds one
 * Task rather than a catalogue entry.
 *
 * A request that never landed is reported in the read's own terms (`unavailable`), because the answer
 * that would have distinguished "no read for this action" from "the read failed" is the one that did
 * not arrive — and the sentence names the read rather than the Room or the action, so it stays true
 * whichever of the two it was.
 */
async function loadTargetFacts(current: TaskWithProgress): Promise<void> {
  targetFacts.value = null
  if (current.targetKey === '') return

  try {
    const read = await actionSettingApi.targetFacts(
      current.platform,
      current.actionKey,
      current.accountId,
      current.targetKey
    )
    targetFacts.value = read.kind === 'none' ? null : read
  } catch (cause: unknown) {
    targetFacts.value = { kind: 'unavailable', reason: `这个目标的实情这次没读到：${describeError(cause)}` }
  }
}

/**
 * What the edit dialog will actually let a person change on this Task, in its own order.
 *
 * 生效时间 and 执行间隔 are always there; the two switches are drawn by `TaskEditDialog` only where
 * they apply to the action naming this Task (`showsTarget`/`showsSalt`, which show both for an action
 * this build cannot name). The hint beside 编辑 used to name all four whatever the action was, so an
 * account-scoped Task's page promised 等待开播 and 加盐 that its dialog does not have.
 */
function editableFieldsOf(value: TaskWithProgress): string {
  const action = catalog.descriptorOf(value.platform, value.actionKey)
  const fields = ['生效时间', '间隔']
  if (action === null || action.needsTarget) fields.push('等待开播')
  if (action === null || action.action === TaskAction.Send) fields.push('加盐')
  return fields.join('、')
}

/**
 * Today's verdict for a reconcile task, asked about **the one action this Task names**.
 *
 * The status above stays a window-lifecycle fact: a reconcile task that has already done everything
 * today correctly reads `waiting`, so "today" is answered by `settledTodayKeys` against the Task's own
 * `actionKey` — and by its switch, because an action nobody switched on will not run however healthy
 * the Task looks — never by the status or the lifetime counters.
 */
function todayOf(value: TaskWithProgress): ReconcileToday {
  return reconcileTodayOf(value.actionKey, catalog.switchOf(value.platform, value.actionKey), value.settledTodayKeys)
}

/** The action's catalogue name — what a person calls the one thing this Task does. */
function actionName(value: TaskWithProgress): string {
  return catalog.actionLabel(value.platform, value.actionKey)
}

/** True before the window opens, which reads differently from "没做完". */
function windowNotOpen(value: TaskWithProgress): boolean {
  return Date.now() < value.startTime
}

/** True once the window has closed: from here on the status word is `时间窗已结束`. */
function windowClosed(value: TaskWithProgress): boolean {
  return Date.now() >= value.endTime
}

/**
 * Why the day has no verdict, in the words of whichever half could not answer.
 *
 * `reconcileTodayOf` keeps its two causes apart because they are not one sentence; this page used to
 * print the server's for both, which is a claim about the server made when the cause was this
 * process's own catalogue (not loaded yet, or a Platform a newer build wrote). Same wording as the
 * list row's, and deliberately so: it is one fact arriving on two screens.
 */
function noVerdictNote(value: TaskWithProgress): string {
  const verdict = todayOf(value)
  if (verdict.kind !== 'unknown') return ''
  return verdict.why === 'no-switch'
    ? '动作目录还没读到（或者这个版本的目录里没有这个平台），所以现在还不知道今天的动作落定没有'
    : '服务端没有返回按天的动作状态，这里只显示任务在时间窗内的状态'
}

/**
 * One send attempt in one word, and the Platform's code behind a failure.
 *
 * `send_logs.code` is the Platform's own answer, kept as text (`SendLog.code`). It was a literal `0`
 * at the writer for a while — leaving `code INTEGER NOT NULL DEFAULT 0` to be read as a code — so this
 * row printed 「失败 #0」 for every rejection, and `0` is what both Platforms return on **success**: the
 * one value the display must never show a failure with.
 *
 * The writer is fixed, so a code is usually the real one and is printed. `0` is still refused here,
 * and for the same reason read the other way round: if the only code in hand is the success code, then
 * a person is owed 「失败」 and nothing more, because `#0` under 「失败」 is the sentence this defect was
 * made of. `''` is the same case — no code came back at all.
 */
function sendResultOf(log: SendLog): string {
  if (log.ok) return '成功'
  return log.code === '' || log.code === '0' ? '失败' : `失败 #${log.code}`
}

/**
 * Today's records, oldest first — the section that answers 「今天做了什么」.
 *
 * The records, not a projection per action: an action that ran three times today has
 * three runs, and the day is the thing being explained. The list page makes the
 * opposite choice for the opposite reason — see `TasksView`.
 */
const todayRecords = computed<readonly ActionLog[]>(() => task.value?.actionLogsToday ?? [])

/** Earlier days, newest first. Collapsed until a person opens one. */
const historyDays = computed<readonly ActionLogDay[]>(() => task.value?.actionLogDays ?? [])

/** A day's heading: the day, then the records this payload carried for it in the counters' own words. */
function dayTitle(day: ActionLogDay): string {
  const counts = new Map<ActionOutcome, number>()
  for (const record of day.records) counts.set(record.outcome, (counts.get(record.outcome) ?? 0) + 1)

  const parts = [...counts].map(([outcome, count]) => `${describeOutcome(outcome).label} ${String(count)}`)
  // **The records, not the day**, and the difference is not a nicety: the payload carries at most
  // `HISTORY_LOG_LIMIT` earlier rows (`server/src/routes/tasks.ts`), so a day with more writes than that
  // arrives cut short — and 「2026-03-09（受阻 1）」 over one of those was this page reading a sample as the
  // day's totals. What the heading is entitled to count is what is under it: the list this entry opens.
  return `${day.dayKey}（下面这 ${String(day.records.length)} 条：${parts.join('、')}）`
}

/**
 * Every record the payload carries, newest first.
 *
 * Both sections feed the debug list, because 「这条是谁写的」 is a question about the
 * raw feed rather than about a day: a code with no timestamp beside it is not
 * something anyone can act on.
 */
const debugRecords = computed<readonly ActionLog[]>(() =>
  [...todayRecords.value, ...historyDays.value.flatMap(day => day.records)].sort((left, right) => right.at - left.at)
)

/**
 * Reads everything this page shows for the Task in the address.
 *
 * Two reads, and **their failures are not one thing**: the detail is what the page is for, while the
 * send-attempt log is an optional extra. Sharing one `try` — which is what this did — meant a failed
 * `logs` call landed in the same `error` slot and took the whole page with it: the template draws the
 * error bar *instead of* everything else, so a task whose configuration had already arrived showed
 * nothing but one error sentence about a query it does not need.
 */
async function load(): Promise<void> {
  const id = taskId.value
  loading.value = true
  error.value = ''
  try {
    const detail = await taskApi.get(id)
    task.value = detail.task
    library.value = detail.library
    account.value = detail.account
    summary.value = detail.logSummary
  } catch (cause: unknown) {
    error.value = describeError(cause)
    task.value = null
  } finally {
    loading.value = false
  }

  // The Target's own facts, and only for a Task that carries one: the read behind them is about one
  // Room. It is a read of its own rather than part of the detail above, because it is a live look at a
  // Platform and the page's own configuration is the database's answer — a failure on this side must
  // not take the page down with it.
  if (task.value !== null) await loadTargetFacts(task.value)

  // Send attempts are the only thing `send_logs` holds; a reconcile task would pay for a query whose
  // answer is always empty.
  if (task.value?.action !== TaskAction.Send) return
  try {
    const logResult = await taskApi.logs(id, SEND_LOG_PAGE)
    logs.value = logResult.logs
    summary.value = logResult.summary
  } catch (cause: unknown) {
    logsError.value = describeError(cause)
  }
}

onMounted(() => {
  // The catalogue names the Platform and the Action on every line; one read, shared with the rest of
  // the app, and this page does not wait for it.
  void catalog.ensure()
  void load()
})

// The address is the identity of this page, so a change to it is a new read. Without this the view
// kept the previous Task on screen — and handed it to the edit dialog, which writes by id.
watch(taskId, () => {
  task.value = null
  library.value = null
  account.value = null
  logs.value = []
  logsError.value = ''
  // The address is a different Room's page, so the previous Room's facts must not stand for one frame
  // under a heading that says they are this Task's.
  targetFacts.value = null
  void load()
})
</script>

<template>
  <NSpin :show="loading">
    <NAlert v-if="error !== ''" type="error">{{ error }}</NAlert>

    <NSpace v-else-if="task !== null" vertical :size="16">
      <NCard>
        <template #header>
          <NSpace align="center">
            <NTag size="small" :bordered="false">{{ catalog.labelOf(task.platform) }}</NTag>
            <span>{{ targetLabel(task) }}</span>
            <NTag size="small" :type="TASK_STATUS_TAG[task.status]">{{ TASK_STATUS_LABEL[task.status] }}</NTag>
          </NSpace>
        </template>
        <template #header-extra>
          <NButton size="small" @click="router.push({ name: 'tasks' })">返回</NButton>
        </template>

        <NDescriptions :column="2" label-placement="left" bordered size="small">
          <NDescriptionsItem label="平台">{{ catalog.labelOf(task.platform) }}</NDescriptionsItem>
          <NDescriptionsItem label="动作">
            {{ actionLabel(task) }}
            <NTag size="tiny" :bordered="false" class="ml">
              {{ task.action === TaskAction.Send ? '发送动作' : '整理动作' }}
            </NTag>
          </NDescriptionsItem>
          <NDescriptionsItem label="账号">{{ accountLabel(account) }}</NDescriptionsItem>
          <NDescriptionsItem label="目标">
            {{ task.targetKey !== '' ? task.targetKey : '无（账号级动作）' }}
          </NDescriptionsItem>
          <NDescriptionsItem v-if="task.targetKey !== ''" label="开播状态">
            {{ describeLiveStatus(task.lastLiveStatus) }}
          </NDescriptionsItem>
          <NDescriptionsItem v-if="task.action === TaskAction.Send" label="文本库">
            {{ library !== null ? library.name : '未关联' }}
          </NDescriptionsItem>
          <NDescriptionsItem label="开始时间">{{ formatTime(task.startTime) }}</NDescriptionsItem>
          <NDescriptionsItem label="结束时间">{{ formatTime(task.endTime) }}</NDescriptionsItem>
          <NDescriptionsItem label="执行间隔">{{ task.interval }} 秒</NDescriptionsItem>
          <NDescriptionsItem v-if="task.action === TaskAction.Send" label="加盐">
            {{ task.saltEnabled ? '开启' : '关闭' }}
          </NDescriptionsItem>
        </NDescriptions>

        <NAlert v-if="task.lastError !== ''" type="error" class="mt">{{ task.lastError }}</NAlert>
      </NCard>

      <!--
        The action's own parameters, and the reason they may be edited from here at all.

        **Whose they are is stated, not implied.** They live in `action_settings` under (person,
        platform, action), so a write here moves every Task naming this action — which is exactly what
        the note says, and the note is the whole of what makes an in-place write honest. What the page
        does *not* do is copy them onto the Task: one home for one value, and it is the home the run
        reads.

        This card is drawn whenever the catalogue knows the action, so the way through to the
        preferences page exists for every Task — including one whose action reads nothing, where it
        says so rather than drawing an empty form.
      -->
      <NCard v-if="descriptor !== null" title="这个动作的参数">
        <NSpace vertical :size="12">
          <div v-if="optionFields.length > 0" class="hint">
            这个参数属于<strong>动作</strong>，不只属于这条任务——改它，你其他几条同动作的任务也跟着变。
          </div>
          <div v-else class="hint">这个动作没有可设置的参数。</div>

          <!--
            The same form the preferences page draws, over the same store — handed the Task's own
            `accountId` rather than one read off the accounts list (this page never reads that list,
            and the Task's row always carries the id), and `accounts-loaded` as `true` because the
            flag is consulted only when there is no id at all. A Task whose account row is gone is
            answered by the route's own 「账号不存在」, which is a true sentence about this page's
            situation rather than a claim about a list nobody read.
          -->
          <ActionOptionForm
            v-if="optionFields.length > 0"
            :platform-key="task.platform"
            :descriptor="descriptor"
            :account-id="task.accountId"
            :accounts-loaded="true"
            :stored-options="storedOptionsOf(task)"
          />

          <!-- No `@saved` handler on purpose: the write lands in the store this form re-seeds from,
               and nothing else on this page is built out of the stored options. -->

          <NButton size="small" @click="router.push({ name: 'action-settings' })">去偏好设置</NButton>
        </NSpace>
      </NCard>

      <!--
        The Target's own facts — the half of the design's split that belongs to this page.

        The heading says 「这个目标的实情」 and the note beside it says why they are here rather than on
        the preferences page: that page reads for an *account*, and the route behind a choice source is
        handed an account id and no target, so it has no Room to ask about. This page has one, from the
        address, and that is the whole of the reason the two pages show different things.

        Two answers reach this card and a third never does: `ok` draws the facts, `unavailable` draws
        the sentence (the same refusal the read's own `describeError` gave), and `none` — an action this
        build serves no read for — leaves the card undrawn, because a failure sentence over a read
        nobody wrote would be a claim about a Room that nothing established.
      -->
      <NCard v-if="targetFacts !== null" title="这个目标的实情">
        <NSpace vertical :size="8">
          <div class="hint">
            这些是这条任务的目标自己的实情：偏好设置页是按账号读的，它手上没有直播间，所以这些事实只在这一页出现。
          </div>

          <NSpace v-if="targetFacts.kind === 'ok' && targetFacts.items.length > 0" vertical :size="4">
            <div v-for="fact in targetFacts.items" :key="`fact-${fact.name}`" class="fact-row">
              <span class="fact-name">{{ fact.label }}</span>
              <span class="fact-value">{{ fact.value }}</span>
            </div>
          </NSpace>

          <!-- A read that landed and holds nothing is an answer, and the third of the three readings
               a blank can be: nothing forces a Platform to report a fact about a Room, and drawing
               nothing over it would leave a person unable to tell it from a read that failed. -->
          <div v-else-if="targetFacts.kind === 'ok'" class="hint">
            这次读到了，但这个动作在这个目标上没有可显示的实情。
          </div>

          <div v-else class="err">{{ targetFacts.reason }}</div>
        </NSpace>
      </NCard>

      <NCard size="small" title="任务操作">
        <NSpace align="center">
          <NButton type="primary" :disabled="task.status !== 'paused'" @click="editOpen = true">编辑</NButton>
          <span class="hint">
            {{
              task.status === 'paused'
                ? `可以修改${editableFieldsOf(task)}`
                : '任务暂停后才能编辑'
            }}
          </span>
        </NSpace>
      </NCard>

      <TaskEditDialog
        v-if="task !== null"
        :task="task"
        :show="editOpen"
        @update:show="(value: boolean) => (editOpen = value)"
        @updated="onUpdated"
      />

      <!-- Send: cursor and passes are real numbers the server keeps. -->
      <NCard v-if="task.action === TaskAction.Send" title="进度">
        <NProgress
          type="line"
          :percentage="task.progress.percentInLoop"
          :height="14"
          :status="task.status === 'running' ? 'success' : 'default'"
        />
        <NSpace class="mt" :size="32">
          <NStatistic label="已刷遍数" :value="task.progress.loopCount" />
          <NStatistic label="当前第几条" :value="task.progress.cursor" />
          <NStatistic label="总条数" :value="task.progress.libraryTotal ?? 0" />
          <NStatistic label="成功" :value="task.progress.successCount" />
          <NStatistic label="失败" :value="task.progress.failCount" />
        </NSpace>
      </NCard>

      <!-- Reconcile: no local counter exists, so nothing is invented in its place.
           "Today" comes from settledTodayKeys for the one action this Task names; the
           records under it say what that action actually did, and the counters below are
           the whole history, labelled as such because they answer a different question. -->
      <NCard v-else title="运行情况">
        <NSpace vertical :size="12">
          <div class="row">
            <span class="label">今日</span>

            <NSpace v-if="todayOf(task).kind === 'done'" align="center" :size="8">
              <NTag size="small" type="success">今日已完成</NTag>
              <span class="hint">{{ actionName(task) }} 今天已经落定</span>
            </NSpace>

            <NSpace v-else-if="todayOf(task).kind === 'pending' && windowNotOpen(task)" align="center" :size="8">
              <NTag size="small">今天还没到执行时间</NTag>
              <span class="hint">
                {{ formatTime(task.startTime) }} 开始，之后每 {{ task.interval }} 秒核对一次；待办：{{ actionName(task) }}
              </span>
            </NSpace>

            <!-- The window has closed with the action unsettled. This is the pair that used to
                 contradict itself on one row: a status reading 「已完成」 above a line reading 「今天的
                 动作还没落定」. Neither sentence is wrong on its own, and neither says the whole fact
                 — the window is over, so it will not settle today. -->
            <NSpace v-else-if="todayOf(task).kind === 'pending' && windowClosed(task)" align="center" :size="8">
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

            <!-- No verdict, and the sentence comes from `noVerdictNote` so it names the half that
                 could not answer rather than blaming the server for this process's catalogue. -->
            <span v-else class="hint">
              {{ noVerdictNote(task) }}（{{ formatTime(task.startTime) }} 起，每
              {{ task.interval }} 秒核对一次）
            </span>
          </div>

          <!-- Today's records, one per run: 「客户端签到 · 连签 7 天」, and — when the action did not
               run — the record that says why, which is the half a person could not see before. -->
          <ActionRecordList v-if="todayRecords.length > 0" :platform="task.platform" :records="todayRecords" />
          <span v-else class="hint">今天还没有动作记录，时间窗内还没有核对过。</span>

          <div class="row">
            <!-- The label is what the number is. It read 「累计」, which promised a total over the Task's
                 whole life — and `summarizeActionLogs` is one `COUNT(*) WHERE task_id = ?` over the rows
                 the table still holds, today included. -->
            <span class="label">已存记录</span>
            <NSpace v-if="task.actionLogSummary !== undefined && task.actionLogSummary.total > 0" :size="12">
              <NTag v-for="row in actionLogRows(task.actionLogSummary)" :key="row.outcome" size="small" :type="row.tag">
                {{ row.label }} {{ row.count }}
              </NTag>
            </NSpace>
            <span v-else class="hint">还没有动作记录</span>
          </div>

          <!-- The range, said out loud. The count includes **today** — 「不代表今天」 was the opposite of
               what the query answers — and it stops where the retention stops, which is the half
               「从绑定到现在累计的」 assumed away. -->
          <span v-if="task.actionLogSummary !== undefined" class="hint">
            共 {{ task.actionLogSummary.total }} 条动作记录：这是记录表里现存的条数，含今天；更早的记录超过保留上限就被删掉了。
          </span>
        </NSpace>
      </NCard>

      <!-- Earlier days, one collapsed entry each: what happened, on which day. -->
      <NCard v-if="task.action === TaskAction.Reconcile" title="历史">
        <NEmpty v-if="historyDays.length === 0" description="还没有更早的记录" />

        <NCollapse v-else>
          <NCollapseItem v-for="day in historyDays" :key="day.dayKey" :title="dayTitle(day)">
            <ActionRecordList :platform="task.platform" :records="day.records" />
          </NCollapseItem>
        </NCollapse>
      </NCard>

      <!-- The raw feed. Collapsed by default, and the one place an identifier is
           rendered: `res=356` and `20250521OPFOY_qd2` are what a bug report needs,
           and exactly what a person reading 「今天做了什么」 must not have to parse.
           The record's own `detail` lives here too, beside the code it came with: it is
           the audit line the rows above no longer print, and it stays available rather
           than being thrown away. -->
      <NCollapse v-if="task.action === TaskAction.Reconcile" :default-expanded-names="[]">
        <NCollapseItem title="高级/调试">
          <NSpace vertical :size="8">
            <span class="hint">
              服务端原始字段：平台标识、动作标识、返回码、记录原句——这个区块把这几项原样列出来，上面那些区块说的是名字和事实。
            </span>

            <NEmpty v-if="debugRecords.length === 0" description="还没有记录" />

            <NSpace v-else vertical :size="6">
              <div v-for="record in debugRecords" :key="`debug-${record.id}`" class="debug-row">
                <span class="time">{{ formatTime(record.at) }}</span>
                <span class="mono">{{ task.platform }}</span>
                <span class="mono">{{ record.actionKey }}</span>
                <NTag size="tiny" :type="describeOutcome(record.outcome).tag">
                  {{ describeOutcome(record.outcome).label }}
                </NTag>
                <span class="mono">code={{ record.code }}</span>
                <span v-if="record.targetKey !== ''" class="mono">target={{ record.targetKey }}</span>
                <span class="mono">detail={{ record.detail }}</span>
                <span v-for="(item, index) in record.items" :key="`debug-item-${record.id}-${index}`" class="mono">
                  item[{{ index }}]={{ item.code }}
                </span>
              </div>
            </NSpace>
          </NSpace>
        </NCollapseItem>
      </NCollapse>

      <NCard v-if="task.action === TaskAction.Send" title="发送日志">
        <template #header-extra>
          <NSpace>
            <NTag size="small">共 {{ summary.total }}</NTag>
            <NTag size="small" type="success">成功 {{ summary.ok }}</NTag>
            <NTag size="small" type="error">失败 {{ summary.failed }}</NTag>
          </NSpace>
        </template>

        <NAlert v-if="logsError !== ''" type="error">
          发送日志这次没读到：{{ logsError }}（上面这些仍然是从服务端拿到的。）
        </NAlert>

        <!-- The ranges, said out loud. The three numbers in the header come from `summarizeSendLogs` —
             one `COUNT(*)`/`SUM(ok)` over the task's whole `send_logs`, bounded by retention — while the
             list below is one page of it, newest first (`listSendLogs`). The counters answer *how did this
             task go*; the list answers *what were the last few attempts*, and the page used to leave the
             two to be told apart by nothing at all. Drawn only where there is a range to scope: once that
             read landed — a sentence about what the list below holds is the same claim as the list itself
             — and over a table that holds something, because an empty one has its own answer below. -->
        <span v-if="logsError === '' && summary.total > 0" class="hint">
          共 {{ summary.total }} 条发送记录：这是发送日志表里现存的条数，含下面这一页；更早的记录超过保留上限就被删掉了，下面只列最近 {{ SEND_LOG_PAGE }} 条。
        </span>

        <!-- The empty state is claimed only when the read succeeded: 「还没有发送记录」 and 「这一次没
             读到」 are different facts, and the alert above is the one that says the second. -->
        <NEmpty v-if="logs.length === 0 && logsError === ''" description="还没有发送记录" />

        <NSpace v-else vertical :size="6">
          <div v-for="log in logs" :key="log.id" class="log-row">
            <NTag size="tiny" :type="log.ok ? 'success' : 'error'">
              {{ sendResultOf(log) }}
            </NTag>
            <span class="time">{{ new Date(log.at).toLocaleTimeString('zh-CN') }}</span>
            <span class="content">{{ log.content }}</span>
            <span v-if="log.error !== ''" class="err">{{ log.error }}</span>
          </div>
        </NSpace>
      </NCard>
    </NSpace>
  </NSpin>
</template>

<style scoped>
.hint {
  color: #888;
  font-size: 13px;
}
.mt {
  margin-top: 16px;
}
.ml {
  margin-left: 6px;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.label {
  width: 48px;
  color: #888;
  font-size: 13px;
  flex-shrink: 0;
}

.log-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
  padding: 2px 0;
}

.fact-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}

.fact-name {
  width: 112px;
  flex-shrink: 0;
  color: #888;
}

.fact-value {
  color: #333;
}

.time {
  color: #999;
  font-variant-numeric: tabular-nums;
}

.content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.err {
  color: #d03050;
}

.debug-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
  flex-wrap: wrap;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #666;
}
</style>
