<script setup lang="ts">
import { NAlert, NCard, NGrid, NGridItem, NSpin, NStatistic, NTag } from 'naive-ui'
import { onMounted, ref } from 'vue'

import { describeError } from '../api/client.js'
import { accountApi, libraryApi, systemApi, taskApi } from '../api/endpoints.js'
import { usePlatformStore } from '../stores/platform.js'
import { TASK_STATUS_LABEL, TASK_STATUS_TAG, TaskAction, type TaskWithProgress } from '../types/api.js'

/**
 * Overview.
 *
 * Counts rather than charts: the questions a user actually has on opening this
 * are "is the scheduler up", "how many accounts am I running", and "what is
 * running right now".
 *
 * Each running task names its Platform and its Action through the catalogue, and
 * an Action that has no cursor shows no cursor figure: "第几遍" belongs to a Send
 * task, and printing it for a check-in would be inventing a number.
 */
const catalog = usePlatformStore()

const loading = ref(true)
const error = ref('')
const accountCount = ref(0)
const libraryCount = ref(0)
const tasks = ref<TaskWithProgress[]>([])
const uptime = ref(0)

onMounted(async () => {
  try {
    void catalog.ensure()
    const [health, accounts, libraries, taskList] = await Promise.all([
      systemApi.health(),
      accountApi.list(),
      libraryApi.list(),
      taskApi.list()
    ])
    uptime.value = health.uptimeSeconds
    accountCount.value = accounts.length
    libraryCount.value = libraries.length
    tasks.value = taskList
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
})

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${String(seconds)} 秒`
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} 分钟`
  if (seconds < 86400) return `${String(Math.floor(seconds / 3600))} 小时`
  return `${String(Math.floor(seconds / 86400))} 天`
}

const runningStatuses = new Set(['running', 'offline', 'waiting'])

function isActive(task: TaskWithProgress): boolean {
  return runningStatuses.has(task.status)
}

/** What the task is aimed at, or "账号自身" for an account-scoped action. */
function targetLabel(task: TaskWithProgress): string {
  if (task.targetTitle !== '') return task.targetTitle
  return task.targetKey !== '' ? `目标 ${task.targetKey}` : '账号自身'
}

/** One line of "what is happening", which differs per executor. */
function taskMeta(task: TaskWithProgress): string {
  if (task.action === TaskAction.Send) {
    return `第 ${String(task.progress.loopCount + 1)} 遍 · 已发 ${String(task.progress.successCount)} 条`
  }
  return '按间隔由平台自动完成'
}

/**
 * A count or a duration, or a dash when this page has no answer.
 *
 * The four reads are one `Promise.all`, so a failure leaves every count at its initial `0` — and
 * 「账号 0」 under an error bar is a claim about a list this page never received. `—` says only that
 * there is no answer, which is the one thing the code can support.
 */
function orDash(value: string | number): string | number {
  return error.value === '' ? value : '—'
}
</script>

<template>
  <NSpin :show="loading">
    <NAlert v-if="error !== ''" type="error" class="mb">{{ error }}</NAlert>

    <NGrid :cols="4" :x-gap="16" :y-gap="16">
      <NGridItem>
        <NCard><NStatistic label="账号" :value="orDash(accountCount)" /></NCard>
      </NGridItem>
      <NGridItem>
        <NCard><NStatistic label="文本库" :value="orDash(libraryCount)" /></NCard>
      </NGridItem>
      <NGridItem>
        <NCard><NStatistic label="进行中任务" :value="orDash(tasks.filter(isActive).length)" /></NCard>
      </NGridItem>
      <NGridItem>
        <NCard>
          <NStatistic label="服务运行时长" :value="orDash(formatUptime(uptime))" />
        </NCard>
      </NGridItem>
    </NGrid>

    <NCard title="任务状态" class="mt">
      <!-- No tasks *or* no answer: the second case draws the error bar above, and this sentence is
           claimed only for the first. -->
      <NAlert v-if="tasks.length === 0 && error === ''" type="info">
        还没有任务，先去「文本库」导入一份弹药，再去「任务」创建。
      </NAlert>

      <div v-else class="task-list">
        <div v-for="task in tasks" :key="task.id" class="task-row">
          <NTag size="small" :bordered="false">{{ catalog.labelOf(task.platform) }}</NTag>
          <div class="task-name">
            {{ targetLabel(task) }}
            <span class="task-action">{{ catalog.actionLabel(task.platform, task.actionKey) }}</span>
          </div>
          <NTag :type="TASK_STATUS_TAG[task.status]" size="small">
            {{ TASK_STATUS_LABEL[task.status] }}
          </NTag>
          <div class="task-meta">{{ taskMeta(task) }}</div>
        </div>
      </div>
    </NCard>
  </NSpin>
</template>

<style scoped>
.mb {
  margin-bottom: 16px;
}

.mt {
  margin-top: 16px;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.task-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.task-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-action {
  color: #888;
  font-size: 13px;
  margin-left: 8px;
}

.task-meta {
  color: #888;
  font-size: 13px;
}
</style>
