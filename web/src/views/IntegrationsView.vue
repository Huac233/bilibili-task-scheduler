<script setup lang="ts">
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NCode,
  NEmpty,
  NInput,
  NPopconfirm,
  NSpace,
  NSpin,
  NTag,
  useMessage
} from 'naive-ui'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import { describeError } from '../api/client.js'
import { eventApi, tokenApi } from '../api/endpoints.js'
import { usePlatformStore } from '../stores/platform.js'
import { type ApiToken, describeEventKind, EVENT_LABEL, type SystemEvent } from '../types/api.js'

/**
 * External integrations: API tokens and the event feed.
 *
 * Both live on one page because they serve one task — wiring up an external
 * notifier. A token with no way to see what it would receive is hard to debug,
 * and an event feed with no credential to read it is equally useless.
 *
 * The plaintext token is shown exactly once, in a panel that stays visible until
 * dismissed: it cannot be retrieved later, and a user who navigates away has to
 * revoke and reissue.
 *
 * Every event carries the Platform it is about, which is the only thing that
 * tells two accounts' 「登录已失效」 apart once a second Platform is bound.
 *
 * The feed can be narrowed to a set of event kinds, and that choice is this page's own rather than
 * the account's — `HIDDEN_KINDS_KEY` below says why, and what the AstrBot plugin reads is not it.
 */
const message = useMessage()
const catalog = usePlatformStore()

/** The Platform's own name for an event's Platform key; empty means "no Platform". */
function eventPlatform(key: string): string {
  return catalog.labelOf(key)
}

const loading = ref(true)
const error = ref('')

const tokens = ref<ApiToken[]>([])
const tokenLimit = ref(20)
const newName = ref('')
const creating = ref(false)

/** Set once, right after creation. Never re-fetched. */
const freshToken = ref<string | null>(null)

const events = ref<SystemEvent[]>([])
const eventsLoading = ref(false)

/* ---------------------------- the feed's filter ---------------------------- */

/**
 * How many rows the feed keeps, and how often it re-reads them.
 *
 * Named because the sentence above the feed states both. One number written once in the template and
 * again in the code is one fact with two homes, and the standing rule for this page is that every
 * sentence it shows is one a line of code reads.
 */
const EVENT_FEED_LIMIT = 50
const EVENT_REFRESH_SECONDS = 15

/**
 * The kinds this build can name, in the order their labels are declared.
 *
 * Read out of `EVENT_LABEL` rather than written again: that table is this package's own mirror of
 * `EventKind` in `server/src/repo/events.ts`, and a second list here would be the same fact with a
 * second home — the one nobody edits the day a kind is added. `other` is in it deliberately: it is
 * what the server calls a kind this build cannot name, and a feed can carry one, so it is a thing
 * the owner can hide like any other.
 */
const allEventKinds = Object.keys(EVENT_LABEL)

/**
 * Where the choice lives, and where it deliberately does not.
 *
 * **This browser, not the account.** `GET /api/events` is the cursor endpoint the AstrBot plugin
 * polls; a filter kept with the account and honoured there would do worse than change what the
 * plugin receives — its cursor would walk past the hidden kinds and the retention window would then
 * delete them, i.e. a notification lost for good. So the choice travels with the request that made
 * it, as `kinds` on the feed's own endpoint, and is remembered here. The cost is that it is per
 * browser, which is all that "it survives a reload" asks for.
 *
 * **What is stored is the hidden set rather than the visible one**, so a kind added by a later build
 * arrives visible: an allowlist saved today would keep a new kind hidden for ever, and "nothing
 * disappeared because a filter shipped" has to hold for that build too.
 */
const HIDDEN_KINDS_KEY = 'bts.events.hiddenKinds'

function readHiddenKinds(): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(HIDDEN_KINDS_KEY) ?? 'null')
    if (!Array.isArray(stored)) return []
    return allEventKinds.filter(kind => stored.some((hidden: unknown) => hidden === kind))
  } catch {
    // Unreadable storage, or a value this build did not write: no filter at all, which is the same
    // thing a brand-new browser gets.
    return []
  }
}

function writeHiddenKinds(hidden: string[]): void {
  try {
    window.localStorage.setItem(HIDDEN_KINDS_KEY, JSON.stringify(hidden))
  } catch {
    // Ignored: the choice simply will not survive a reload.
  }
}

/** The kinds the owner has hidden. Empty until he hides one. */
const hiddenKinds = ref<string[]>(readHiddenKinds())

/** What the feed asks for: every kind this build can name, minus the hidden ones. */
const visibleKinds = computed<string[]>(() => allEventKinds.filter(kind => !hiddenKinds.value.includes(kind)))

/** One box's state: it shows what the feed is really asking for, not what it was initialized with. */
function isKindVisible(kind: string): boolean {
  return !hiddenKinds.value.includes(kind)
}

function setKindVisible(kind: string, visible: boolean): void {
  hiddenKinds.value = visible ? hiddenKinds.value.filter(hidden => hidden !== kind) : [...hiddenKinds.value, kind]
}

/**
 * What the feed says when it has nothing to show: three facts, three sentences.
 *
 * A feed that has never had an event, a filter that excluded everything, and a selection with
 * nothing in it are not the same thing. One sentence for all three would tell a person his service
 * is idle right after he hid the kind that fires.
 */
const emptyFeed = computed<string>(() => {
  if (visibleKinds.value.length === 0) return '没有勾选任何事件类型'
  if (hiddenKinds.value.length > 0) return '没有符合筛选条件的事件'
  return '还没有事件'
})

// A tick is one act rather than two: the choice is written down, and the feed is asked again through
// it straight away — waiting for the next automatic refresh would leave the click looking ignored.
watch(hiddenKinds, () => {
  writeHiddenKinds(hiddenKinds.value)
  void loadEvents()
})

let refreshTimer: ReturnType<typeof setInterval> | null = null

const canCreate = computed(() => newName.value.trim() !== '' && !creating.value)

/** Colour for an event's severity badge. */
function severityType(severity: string): 'default' | 'warning' | 'error' {
  if (severity === 'error') return 'error'
  if (severity === 'warning') return 'warning'
  return 'default'
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN')
}

async function loadTokens(): Promise<void> {
  try {
    const result = await tokenApi.list()
    tokens.value = result.tokens
    tokenLimit.value = result.limit
  } catch (cause: unknown) {
    error.value = describeError(cause)
  }
}

async function loadEvents(): Promise<void> {
  eventsLoading.value = true
  try {
    events.value = await eventApi.recent(visibleKinds.value, EVENT_FEED_LIMIT)
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    eventsLoading.value = false
  }
}

async function createToken(): Promise<void> {
  if (!canCreate.value) return
  creating.value = true
  error.value = ''

  try {
    const result = await tokenApi.create(newName.value.trim())
    freshToken.value = result.token
    newName.value = ''
    await loadTokens()
    message.success('令牌已创建')
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    creating.value = false
  }
}

async function copyToken(): Promise<void> {
  if (freshToken.value === null) return
  try {
    await navigator.clipboard.writeText(freshToken.value)
    message.success('已复制到剪贴板')
  } catch {
    // Clipboard access can be denied; the value stays selectable on screen.
    message.warning('复制失败，请手动选中复制')
  }
}

async function revoke(id: number): Promise<void> {
  try {
    await tokenApi.remove(id)
    tokens.value = tokens.value.filter(item => item.id !== id)
    message.success('已吊销')
  } catch (cause: unknown) {
    message.error(describeError(cause))
  }
}

onMounted(async () => {
  // The Platform labels on the event rows come from the catalogue.
  void catalog.ensure()
  await Promise.all([loadTokens(), loadEvents()])
  loading.value = false

  // Events are pushed by the scheduler, not by user action, so a slow refresh
  // keeps the panel honest without a manual reload.
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void loadEvents()
  }, EVENT_REFRESH_SECONDS * 1000)
})

onUnmounted(() => {
  if (refreshTimer !== null) clearInterval(refreshTimer)
})
</script>

<template>
  <NSpace vertical :size="16">
    <NAlert v-if="error !== ''" type="error">{{ error }}</NAlert>

    <NCard title="API 令牌">
      <template #header-extra>
        <NTag size="small">{{ tokens.length }} / {{ tokenLimit }}</NTag>
      </template>

      <NAlert type="info" :bordered="false" class="mb">
        给外部程序（如 AstrBot 通知插件）使用的长期凭据。令牌等同于你的登录态，
        请勿外泄；不再需要时及时吊销。
      </NAlert>

      <!-- Shown once. Kept on screen until dismissed so a stray click cannot lose it. -->
      <NCard v-if="freshToken !== null" size="small" class="fresh" title="令牌已创建 —— 请立即保存">
        <NSpace vertical :size="10">
          <NAlert type="warning" :bordered="false">
            这是唯一一次显示明文。离开本页后就无法再次获取，只能吊销后重新创建。
          </NAlert>
          <NCode :code="freshToken" word-wrap />
          <NSpace>
            <NButton type="primary" size="small" @click="copyToken">复制</NButton>
            <NButton size="small" @click="freshToken = null">我已保存</NButton>
          </NSpace>
        </NSpace>
      </NCard>

      <NSpace class="add-row" align="center">
        <NInput v-model:value="newName" placeholder="令牌名称，例如 astrbot" style="width: 260px" />
        <NButton type="primary" :disabled="!canCreate" :loading="creating" @click="createToken">
          创建令牌
        </NButton>
      </NSpace>

      <NSpin :show="loading">
        <NEmpty v-if="tokens.length === 0 && !loading" description="还没有创建任何令牌" />

        <NSpace v-else vertical :size="10">
          <div v-for="item in tokens" :key="item.id" class="row">
            <div class="info">
              <div class="name">{{ item.name }}</div>
              <div class="meta">
                创建于 {{ formatTime(item.createdAt) }} ·
                {{ item.lastUsedAt === null ? '从未使用' : `上次使用 ${formatTime(item.lastUsedAt)}` }}
              </div>
            </div>
            <NPopconfirm @positive-click="() => void revoke(item.id)">
              <template #trigger>
                <NButton size="small" quaternary type="error">吊销</NButton>
              </template>
              吊销后使用该令牌的程序会立即失效，确定吗？
            </NPopconfirm>
          </div>
        </NSpace>
      </NSpin>
    </NCard>

    <NCard title="事件流">
      <template #header-extra>
        <NButton size="small" :loading="eventsLoading" @click="loadEvents">刷新</NButton>
      </template>

      <NAlert type="info" :bordered="false" class="mb">
        外部程序通过 <NCode code="GET /api/events?since=<上次的 nextCursor>" /> 拉取增量事件。
        本页只显示下面勾选的事件类型，最近 {{ EVENT_FEED_LIMIT }} 条，每 {{ EVENT_REFRESH_SECONDS }} 秒自动刷新。
      </NAlert>

      <div class="kind-filter">
        <div class="kind-filter-label">显示的事件类型</div>
        <NSpace :size="14" align="center" wrap>
          <NCheckbox
            v-for="kind in allEventKinds"
            :key="kind"
            size="small"
            :checked="isKindVisible(kind)"
            @update:checked="visible => setKindVisible(kind, visible)"
          >
            {{ describeEventKind(kind) }}
          </NCheckbox>
        </NSpace>
      </div>

      <NSpin :show="eventsLoading && events.length === 0">
        <NEmpty v-if="events.length === 0" :description="emptyFeed" />

        <NSpace v-else vertical :size="8">
          <div v-for="event in events" :key="event.id" class="event-row">
            <NTag size="tiny" :bordered="false">#{{ event.id }}</NTag>
            <NTag size="small" :type="severityType(event.severity)">
              {{ describeEventKind(event.kind) }}
            </NTag>
            <NTag v-if="event.platform !== ''" size="small" :bordered="false">
              {{ eventPlatform(event.platform) }}
            </NTag>
            <div class="event-body">
              <div class="event-title">{{ event.title }}</div>
              <div v-if="event.detail !== ''" class="event-detail">{{ event.detail }}</div>
            </div>
            <span class="time">{{ new Date(event.createdAt).toLocaleTimeString('zh-CN') }}</span>
          </div>
        </NSpace>
      </NSpin>
    </NCard>

    <NCard title="如何接入 AstrBot">
      <NSpace vertical :size="8">
        <div>1. 在上方创建一个 API 令牌，保存好明文。</div>
        <div>2. 在 AstrBot 插件里配置两个值：服务器地址（本服务的地址）和刚创建的令牌。</div>
        <div>
          3. 插件定时请求
          <NCode code="GET /api/events?since=<游标>" />，请求头带
          <NCode code="Authorization: Bearer <令牌>" />。
        </div>
        <div>4. 每次拿到响应后，把 <NCode code="nextCursor" /> 存下来，下次原样传回即可。</div>
        <NAlert type="info" :bordered="false">
          事件按 id 升序返回。首次接入时可以先请求一次不带 since 的接口拿
          <NCode code="latestId" />，把它当作起点，避免把历史事件全部推送一遍。
        </NAlert>
      </NSpace>
    </NCard>
  </NSpace>
</template>

<style scoped>
.mb {
  margin-bottom: 16px;
}

.fresh {
  margin-bottom: 20px;
  border: 1px solid #f0a020;
}

.add-row {
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid #f0f0f0;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid #fafafa;
}

.info {
  flex: 1;
  min-width: 0;
}

.name {
  font-weight: 500;
}

.meta {
  color: #888;
  font-size: 13px;
}

.kind-filter {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
}

.kind-filter-label {
  color: #888;
  font-size: 13px;
  margin-bottom: 6px;
}

.event-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid #fafafa;
}

.event-body {
  flex: 1;
  min-width: 0;
}

.event-title {
  font-size: 14px;
}

.event-detail {
  color: #888;
  font-size: 13px;
  margin-top: 2px;
}

.time {
  color: #999;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
