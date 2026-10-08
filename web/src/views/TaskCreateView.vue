<script setup lang="ts">
import {
  NAlert,
  NButton,
  NCard,
  NDatePicker,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { describeError } from '../api/client.js'
import {
  accountApi,
  type CreateTaskPayload,
  intervalFloorMessage,
  intervalFloorOf,
  libraryApi,
  platformApi,
  taskApi
} from '../api/endpoints.js'
import { toggleActionSwitch } from '../components/costly-action.js'
import { namingNote } from '../components/naming-note.js'
import { usePlatformStore } from '../stores/platform.js'
import {
  type Account,
  type ActionDescriptor,
  describeLiveStatus,
  type Library,
  type TargetInfo,
  TaskAction
} from '../types/api.js'
import { FIELD_KEY, NOTICE_KEY } from './task-create-fields.js'

/**
 * Task creation: Platform → Account → Action → the fields that Action asks for.
 *
 * The form is built field by field out of the chosen `ActionDescriptor`, and that
 * is the whole point of it (ADR-0002). A task is a scheduling shell — a Platform,
 * an Account, a window, an interval and an Action — so the only thing that varies
 * between tasks is which Action it runs, and an Action declares what it needs:
 *
 *  - `needsTarget` decides whether a Target picker exists at all. The old form
 *    demanded a room for every task, which is why an account-scoped check-in could
 *    not be expressed.
 *  - `needsLibrary` decides whether the Bullet source is asked for. Only a Send
 *    action consumes one.
 *  - `defaultIntervalSeconds` seeds the cadence, and `costly` decides both the warning below and the
 *    question 「开启这个动作」 asks before it writes the switch — one fact, said the same way the
 *    switchboard says it. The action's switch — off until a person turns it on — is checked *before*
 *    submitting, so the server's 409 is never the first thing a user hears.
 *
 * Nothing here names a Platform. Which Platforms exist, what they can do and how
 * they are labelled all come from `GET /api/platforms`.
 *
 * **Switching action leaves no trace of the previous one.** Two mechanisms carry
 * that, and both are needed:
 *
 *  - `fieldsFor(descriptor)` states which fields an action asks for, as data
 *    (`task-create-fields.ts`). The conditions in the template below are each one
 *    descriptor property, and the DOM test asserts the fields on screen equal
 *    `fieldsFor` exactly — so a condition edited without the corresponding edit
 *    there fails instead of drifting.
 *  - The descriptor watcher resets the state behind every field the new action does
 *    not ask for. A field hidden by a `v-if` but still held in a `ref` is a field
 *    that can still be sent, which is what "「加盐」还在生效" was.
 */

const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const catalog = usePlatformStore()

const accounts = ref<Account[]>([])
const libraries = ref<Library[]>([])
const loading = ref(true)
const error = ref('')

/**
 * Whether the account list actually arrived, and why it did not, in its own slot.
 *
 * **Set by the account read alone**, which is the whole of the fix: the two claims below —
 * 「还没有绑定任何账号」 and 「账号列表没读到」 — are claims about *this* read, and this page has four other
 * things that write a failure (`catalog.ensure` reports into the store, and the target resolution, the
 * switch write and the create each write `error`). Reading the shared slot as "the account list did not
 * arrive" therefore fired the second sentence at a person who really has nothing bound, the first time
 * they mistyped a room number — the same defect `ActionSettingsPanel.vue` answers with the same flag,
 * and `ActionOptionForm.vue` is handed.
 *
 * `accountsError` is separate from `error` for the other half of the pairing: the sentence quotes the
 * server, and `resolveTarget` *clears* the shared slot before it runs, so a quote read from there can
 * stand over another call's message or over nothing at all.
 */
const accountsLoaded = ref(false)
const accountsError = ref('')

/** Whether the library list arrived. The picker's own sentence is a claim about what exists. */
const librariesLoaded = ref(false)

const platformKey = ref<string | null>(null)
const accountId = ref<number | null>(null)
const actionKey = ref<string | null>(null)

const targetInput = ref('')
const target = ref<TargetInfo | null>(null)
const resolving = ref(false)

const libraryId = ref<number | null>(null)

const now = Date.now()
const window = ref<[number, number]>([now + 60_000, now + 2 * 60 * 60 * 1000])
const interval = ref(1)
const saltEnabled = ref(true)
const requireOnline = ref(true)

const submitting = ref(false)
const enabling = ref(false)

/**
 * Set when a cadence had to be raised because the new action's floor is above it.
 *
 * The report's one hard rule about the interval is that an illegal leftover must be
 * *visibly* fixed rather than submitted for a 400, so the correction has to say what
 * it did instead of quietly replacing a number the user typed.
 */
const intervalNotice = ref('')

/* ------------------------------ selection ------------------------------ */

const platform = computed(() => (platformKey.value === null ? null : catalog.platformOf(platformKey.value)))

const descriptor = computed<ActionDescriptor | null>(() => {
  const chosen = platform.value
  const key = actionKey.value
  if (chosen === null || key === null) return null
  return chosen.actions.find(action => action.key === key) ?? null
})

const platformOptions = computed(() => catalog.platforms.map(item => ({ label: item.label, value: item.key })))

/** Only accounts bound to the chosen Platform: a task runs as the account it names. */
const accountOptions = computed(() =>
  accounts.value
    .filter(account => account.platform === platformKey.value)
    .map(account => ({
      label: account.displayName !== '' ? `${account.displayName}（${account.externalId}）` : account.externalId,
      value: account.id
    }))
)

/**
 * The Platform's catalogue, with the cost marked in the list itself.
 *
 * A person picking from a list should be able to see which entries spend
 * something before choosing one, not only after.
 */
const actionOptions = computed(() =>
  (platform.value?.actions ?? []).map(action => ({
    label: action.costly ? `${action.label}（会消耗账号资产）` : action.label,
    value: action.key
  }))
)

const libraryOptions = computed(() =>
  libraries.value.map(library => ({ label: `${library.name}（${String(library.bulletCount)} 条）`, value: library.id }))
)

const isSend = computed(() => descriptor.value?.action === TaskAction.Send)
const needsTarget = computed(() => descriptor.value?.needsTarget === true)
const needsLibrary = computed(() => descriptor.value?.needsLibrary === true)

/** The action's own cadence floor, which is also the one the route enforces. */
const intervalFloor = computed(() => (descriptor.value === null ? 1 : intervalFloorOf(descriptor.value)))

/** True when the typed cadence is faster than the chosen action allows. */
const intervalTooFast = computed(() => descriptor.value !== null && interval.value < intervalFloor.value)

const accountsForPlatform = computed(() => accounts.value.filter(account => account.platform === platformKey.value))

/**
 * True when the account list is *unknown* rather than empty.
 *
 * The two reads on this page are independent — each records its own arrival — so a failure leaves
 * `accounts` at its initial `[]`, which is the same shape as "this person has bound nothing".
 * 「还没有绑定任何账号，请先去「账号」页面绑定一个」 then sends somebody to bind an account they already
 * have, so the page says which of the two it is instead.
 */
const accountsUnknown = computed(() => !accountsLoaded.value && accounts.value.length === 0)

/** Where the library picker's own words come from, in the same three cases as the account select. */
const libraryPlaceholder = computed(() => {
  if (!librariesLoaded.value) return '文本库列表这次没读到'
  return libraries.value.length === 0 ? '还没有文本库，先去「文本库」导入一份' : '选择要发送的文本库'
})

/** Off until a row says otherwise — the server merges the catalogue over the switches. */
const actionEnabled = computed(() => {
  const chosen = platform.value
  const action = descriptor.value
  if (chosen === null || action === null) return false
  return catalog.isEnabled(chosen.key, action.key)
})

const canSubmit = computed(() => {
  const action = descriptor.value
  if (action === null || platform.value === null) return false
  if (accountId.value === null) return false
  // Refusing here as well as disabling the button is deliberate: the 409 the
  // server would answer says the same thing, and the form should not need it to.
  if (!actionEnabled.value) return false
  if (window.value[1] <= window.value[0]) return false
  if (interval.value < intervalFloorOf(action)) return false
  if (action.needsTarget && target.value === null) return false
  if (action.needsLibrary && libraryId.value === null) return false
  return !submitting.value
})

/** How long a "long-term" task runs. The server accepts up to a year. */
const LONG_TERM_DAYS = 365

/** Fills the window with a year-long run starting now. */
function useLongTermWindow(): void {
  const start = Date.now()
  window.value = [start, start + LONG_TERM_DAYS * 24 * 60 * 60 * 1000]
}

/** Window length in whole days, for the long-running hint. */
const windowDurationDays = computed(() => Math.floor((window.value[1] - window.value[0]) / (24 * 60 * 60 * 1000)))

/**
 * Fills what the chosen Platform fixes for us.
 *
 * Called from the Platform watcher and from the initial load. Exactly one account
 * or exactly one Action is preselected because there is no choice to make in that
 * case; anything else is left empty so the user does not confirm a default they
 * did not look at.
 */
function syncPlatformDefaults(key: string | null): void {
  target.value = null
  targetInput.value = ''
  libraryId.value = null

  const bound = key === null ? [] : accounts.value.filter(account => account.platform === key)
  accountId.value = bound.length === 1 ? (bound[0]?.id ?? null) : null

  const actions = key === null ? [] : (catalog.platformOf(key)?.actions ?? [])
  actionKey.value = actions.length === 1 ? (actions[0]?.key ?? null) : null
}

watch(platformKey, syncPlatformDefaults)

/**
 * Re-seeds the cadence when the choice moves to a different action.
 *
 * Both numbers are the action's own, and they are the ones the create route
 * checks — no global floor is applied on top. A descriptor's default can sit below
 * the route's old global floor (one Platform's Send action is 3 seconds, measured
 * against that Platform's rate limiter), which is exactly why the floor had to move
 * onto the descriptor: a form that prefills a default must prefill a value the route
 * accepts. The `max` is a belt on top of that, in case a catalogue ever declares a
 * default under its own floor.
 *
 * **Switching action is not allowed to wipe a cadence the user typed.** The only
 * number that becomes wrong is one below the new action's floor, and even then the
 * correction is stated rather than silent, because the alternative — submitting it —
 * is a 400 the user cannot see coming.
 */
function applyDescriptor(next: ActionDescriptor | null, platformChanged: boolean): void {
  intervalNotice.value = ''

  if (next === null) {
    interval.value = 1
    return
  }

  // A different Platform's cadence says nothing about this one's, so a Platform
  // change is the one case where the old number is abandoned outright.
  if (platformChanged) {
    interval.value = Math.max(intervalFloorOf(next), next.defaultIntervalSeconds)
    return
  }

  const floor = intervalFloorOf(next)
  if (interval.value < floor) {
    interval.value = floor
    // The corrected value and where it came from, rather than the rule said a second way: the rule
    // has one sentence on this form (`intervalFloorMessage`) and this is a different fact — the form
    // moved the number.
    intervalNotice.value = `已把执行间隔改到 ${String(floor)} 秒——这是「${next.label}」自己的下限。`
    return
  }

  // Above the floor the typed number stays: it is still legal here, and a cadence
  // the user chose is the one thing an action switch has no reason to overrule.
}

/**
 * Which Platform the form's other fields were filled in for.
 *
 * Part of the identity on purpose: a Platform change has to clear a Target and a
 * Library, while an action switch on the same Platform has to keep them.
 */
const platformOfSelection = ref<string | null>(null)

/**
 * Applies the new action's rules to the form.
 *
 * The report's complaint was that a field the new action has no business having was
 * still shown — or still took effect. Both halves live here: a field the descriptor
 * no longer asks for is reset to the value it would have on a fresh form, so nothing
 * survives an action switch merely by being in a `ref`.
 */
watch(descriptor, next => {
  const platformChanged = platformOfSelection.value !== platformKey.value
  platformOfSelection.value = platformKey.value

  applyDescriptor(next, platformChanged)

  if (next === null) return

  // A resolved Target belongs to the action it was resolved for, and an action that
  // has no Target must not carry one — the route reads `targetKey` for any action
  // that asks for it, so a leftover here would be a real one.
  if (!next.needsTarget) {
    target.value = null
    targetInput.value = ''
    requireOnline.value = true
  }
  if (!next.needsLibrary) libraryId.value = null
  // 加盐 rewrites each Bullet before it is sent. Reset to the value a fresh form
  // would seed rather than preserved, because a stale `true` here is exactly the
  // "still takes effect" half of the report.
  if (next.action !== TaskAction.Send) saltEnabled.value = true
})

/* ------------------------------- actions ------------------------------- */

async function resolveTarget(): Promise<void> {
  const chosen = platform.value
  if (chosen === null || targetInput.value.trim() === '') return

  resolving.value = true
  error.value = ''
  target.value = null

  try {
    target.value = await platformApi.resolveTarget(chosen.key, targetInput.value.trim())
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    resolving.value = false
  }
}

/**
 * Turns the chosen action's switch on from here, so the form is not a dead end.
 *
 * The question comes first, through the same `toggleActionSwitch` the switchboard uses: 「开启这个
 * 动作」 sits directly under the warning that this action spends what the account owns, and the switch
 * that it flips is the switch the panel says a costly action asks about before it is turned on.
 * Writing it straight through — which this button used to do — made that promise false on this
 * screen only, which is the worst place for it to be false.
 */
function enableAction(): void {
  const action = descriptor.value
  if (platform.value === null || action === null) return

  toggleActionSwitch(dialog, action, true, () => {
    void applyEnabled(action.label)
  })
}

/** The write itself, after the question (when there was one) has been answered. */
async function applyEnabled(label: string): Promise<void> {
  const chosen = platform.value
  const action = descriptor.value
  if (chosen === null || action === null) return

  enabling.value = true
  error.value = ''
  try {
    await catalog.setEnabled(chosen.key, action.key, true)
    message.success(`已开启「${label}」`)
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    enabling.value = false
  }
}

async function submit(): Promise<void> {
  const chosen = platform.value
  const action = descriptor.value
  if (!canSubmit.value || chosen === null || action === null || accountId.value === null) return

  submitting.value = true
  error.value = ''

  // Built conditionally rather than sent with empty values: a Target on an
  // account-scoped action is not "an empty target", it is a field that does not
  // apply, and `interval` is the only one the server would otherwise default.
  const payload: CreateTaskPayload = {
    platform: chosen.key,
    accountId: accountId.value,
    actionKey: action.key,
    startTime: window.value[0],
    endTime: window.value[1],
    interval: interval.value
  }

  if (action.needsTarget && target.value !== null) {
    payload.targetKey = target.value.key
    payload.targetTitle = target.value.title
    payload.requireOnline = requireOnline.value
  }
  if (action.needsLibrary && libraryId.value !== null) {
    payload.libraryId = libraryId.value
  }
  // 加盐 rewrites each Bullet before it is sent, so it is a Send-action concept:
  // asking about it for a check-in would offer a switch that does nothing.
  if (action.action === TaskAction.Send) {
    payload.saltEnabled = saltEnabled.value
  }

  try {
    const created = await taskApi.create(payload)
    // The row the route answered with, which for a reconcile action may be one it wrote **or** one it
    // handed back untouched (`findReconcileTask`) — so this says what the row is and what state it is in
    // rather than that this page made it. One home for the sentence, shared with the settings panel's
    // own create: both asked the same route the same question.
    message.success(namingNote(action.label, created.status))
    await router.push({ name: 'task-detail', params: { id: created.id } })
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    submitting.value = false
  }
}

/**
 * The account read: the list, or null when it did not arrive.
 *
 * Not thrown and not shared: this read's failure is the one sentence on this page that quotes the
 * server, so it is kept where that sentence reads it from. The list is only written once it has
 * arrived, which is the rule `ActionSettingsPanel.vue` states for the same two refs — a failed re-read
 * must not un-know a list that did land.
 */
async function readAccounts(): Promise<Account[] | null> {
  try {
    return await accountApi.list()
  } catch (cause: unknown) {
    accountsError.value = describeError(cause)
    return null
  }
}

/**
 * The library read, on the same terms.
 *
 * Its failure goes to the page's own bar rather than to a slot of its own, because the sentence it
 * supports — 「还没有文本库…」 in the picker — does not quote the server. What it must not do is leave the
 * picker claiming there is no library: that is why its arrival is recorded at all.
 */
async function readLibraries(): Promise<Library[] | null> {
  try {
    return await libraryApi.list()
  } catch (cause: unknown) {
    error.value = describeError(cause)
    return null
  }
}

onMounted(async () => {
  try {
    await catalog.ensure()

    // Started together because they are independent, and each reports itself: one `Promise.all` whose
    // rejection reached a single `error` slot used to make a failed account read take the library list
    // with it, and neither read could say what the other had answered.
    const [accountList, libraryList] = await Promise.all([readAccounts(), readLibraries()])

    if (accountList !== null) {
      accounts.value = accountList
      accountsLoaded.value = true
    }
    if (libraryList !== null) {
      libraries.value = libraryList
      librariesLoaded.value = true
    }

    // Preselection happens after the accounts are known, so "the only account of
    // this Platform" is answered from data rather than from an empty list.
    if (catalog.platforms.length === 1) platformKey.value = catalog.platforms[0]?.key ?? null
    syncPlatformDefaults(platformKey.value)
    if (libraryList !== null && libraryList.length === 1) libraryId.value = libraryList[0]?.id ?? null
  } catch (cause: unknown) {
    // The floor under everything above: neither read throws and `ensure` reports into the store, so this
    // is where a failure this page has not thought of yet still reaches a person.
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <NSpace vertical :size="16">
    <NAlert v-if="error !== ''" type="error">{{ error }}</NAlert>

    <NAlert v-if="!loading && accounts.length === 0 && !accountsUnknown" type="warning">
      还没有绑定任何账号，请先去「账号」页面绑定一个。
    </NAlert>

    <NAlert v-if="!loading && accountsUnknown" type="error">
      账号列表没读到，所以这里既不能说你有账号、也不能说你没有。{{
        accountsError !== '' ? accountsError : '服务端没有说原因'
      }}
    </NAlert>

    <NCard title="创建任务" :loading="loading">
      <NSpace vertical :size="18">
        <NFormItem label="平台">
          <NSelect v-model:value="platformKey" :options="platformOptions" placeholder="选择平台" />
        </NFormItem>

        <NFormItem label="账号">
          <NSelect
            v-model:value="accountId"
            :options="accountOptions"
            :disabled="platformKey === null"
            :placeholder="
              accountsUnknown
                ? '账号列表这次没读到'
                : accountsForPlatform.length === 0
                  ? '这个平台还没有绑定账号'
                  : '选择用哪个账号执行'
            "
          />
        </NFormItem>

        <NFormItem label="动作">
          <NSelect
            v-model:value="actionKey"
            :options="actionOptions"
            :disabled="platformKey === null"
            placeholder="选择这个任务要做什么"
          />
        </NFormItem>

        <!-- The chosen Action's own words, so "what will this do" is answered by
             the adapter that implements it rather than by copy kept here.

             Each notice sits in a fixed key for the same reason the form fields do:
             `NSpace` keys every child it wraps with the literal `1`, so a changing
             set of conditional children is a keyed fragment with duplicate keys. -->
        <div :key="NOTICE_KEY.description">
          <NAlert v-if="descriptor !== null" :bordered="false" type="info" title="动作说明">
            <NSpace vertical :size="6">
              <span class="title">{{ descriptor.label }}</span>
              <span>{{ descriptor.description }}</span>
              <NSpace :size="8">
                <div :key="'kind'">
                  <NTag size="tiny" :bordered="false">
                    {{ descriptor.action === TaskAction.Send ? '发送动作' : '整理动作' }}
                  </NTag>
                </div>
                <div :key="'needs-target'">
                  <NTag v-if="descriptor.needsTarget" size="tiny" :bordered="false">需要目标</NTag>
                </div>
                <div :key="'needs-library'">
                  <NTag v-if="descriptor.needsLibrary" size="tiny" :bordered="false">需要文本库</NTag>
                </div>
                <div :key="'max-length'">
                  <NTag v-if="descriptor.maxMessageLength > 0" size="tiny" :bordered="false">
                    单条上限 {{ descriptor.maxMessageLength }} 字
                  </NTag>
                </div>
              </NSpace>
            </NSpace>
          </NAlert>
        </div>

        <!-- Costly actions spend something the account owns, and stopping the task
             does not give it back — so the warning names that before anything is
             submitted, and the switch for it ships off. What exactly is spent is
             the action's own business: its `description` says so, above. -->
        <div :key="NOTICE_KEY.costly">
          <NAlert v-if="descriptor !== null && descriptor.costly" type="warning" title="这个动作会花掉账号里的东西">
            执行「{{ descriptor.label }}」会消耗账号自己拥有的资产，开销由平台直接扣除。
            花掉的部分不会因为暂停或删除任务而退回，请确认之后再创建。
          </NAlert>
        </div>

        <div :key="NOTICE_KEY.switchOff">
          <NAlert v-if="descriptor !== null && !actionEnabled" type="error">
            <NSpace align="center" justify="space-between">
              <span>
                「{{ descriptor.label }}」现在是关闭状态，没开启的动作不会运行，服务端也会拒绝创建这样的任务。
              </span>
              <NButton size="small" type="primary" :loading="enabling" @click="enableAction">开启这个动作</NButton>
            </NSpace>
          </NAlert>
        </div>

        <!-- Every field below sits in a key that never changes, and the branch lives
             *inside* that wrapper.

             That is not decoration. `NSpace` wraps each child in `<div key={1}>`
             (naive-ui `es/space/src/Space.mjs`), so its keyed fragment carries
             duplicate keys, and Vue's keyed diff then reuses the wrong nodes: with
             the branches as NSpace's own children, changing action multiplied the
             「执行间隔」 field and left 「加盐」 on screen for an action that has no
             such concept. Giving the *wrapper* a stable key keeps NSpace's child
             list every bit as stable as the fields themselves, so nothing has to be
             matched by position on the one render where the set changes. -->

        <!-- Only when the descriptor asks for a Target. -->
        <div :key="FIELD_KEY['目标']">
          <template v-if="needsTarget">
            <NFormItem label="目标">
              <NSpace>
                <NInput
                  v-model:value="targetInput"
                  placeholder="粘贴直播间链接或房间号"
                  style="width: 360px"
                  @keyup.enter="resolveTarget"
                />
                <NButton :loading="resolving" :disabled="platformKey === null" @click="resolveTarget">解析</NButton>
              </NSpace>
            </NFormItem>

            <NAlert v-if="target !== null" type="success" :bordered="false">
              <NSpace align="center">
                <span>{{ target.title !== '' ? target.title : `目标 ${target.key}` }}</span>
                <NTag size="small">ID {{ target.key }}</NTag>
                <div :key="'anchor'">
                  <NTag v-if="target.anchorName !== ''" size="small">{{ target.anchorName }}</NTag>
                </div>
                <NTag size="small" :type="target.liveStatus === 1 ? 'success' : 'default'">
                  {{ describeLiveStatus(target.liveStatus) }}
                </NTag>
              </NSpace>
            </NAlert>
          </template>
        </div>

        <!-- Only when the descriptor asks for a Library. Not clearable: this
             picker exists only because the action needs one, and the server
             answers 400 for a Send action with no library — a task in that state
             would fail every sweep with「任务未关联文本库」. -->
        <div :key="FIELD_KEY['文本库']">
          <NFormItem v-if="needsLibrary" label="文本库">
            <NSelect v-model:value="libraryId" :options="libraryOptions" :placeholder="libraryPlaceholder" />
          </NFormItem>
        </div>

        <NFormItem label="生效时间">
          <NSpace align="center">
            <NDatePicker v-model:value="window" type="datetimerange" clearable style="width: 420px" />
            <NButton size="small" @click="useLongTermWindow">长期执行</NButton>
          </NSpace>
        </NFormItem>

        <div :key="NOTICE_KEY.longTerm">
          <NAlert v-if="windowDurationDays > 30" type="info" :bordered="false">
            这是一个长期任务，将持续约 {{ windowDurationDays }} 天。可以在任务列表里随时暂停或取消。
          </NAlert>
        </div>

        <NFormItem label="执行间隔">
          <NSpace align="center">
            <NInputNumber v-model:value="interval" :min="intervalFloor" :max="86400" style="width: 200px">
              <template #suffix>秒</template>
            </NInputNumber>
            <span class="hint">
              默认来自所选动作{{ descriptor !== null ? `（${String(descriptor.defaultIntervalSeconds)} 秒）` : '' }}，
              最快不能低于 {{ intervalFloor }} 秒
            </span>
          </NSpace>
        </NFormItem>

        <!-- Why the button is disabled, in this form's own words rather than the route's. The number
             is the action's own floor — the same field the route compares against — and the form
             refuses the value here so that the route's 400 is not what a person meets. -->
        <div :key="NOTICE_KEY.floor">
          <NAlert v-if="descriptor !== null && intervalTooFast" type="warning">
            {{ intervalFloorMessage(descriptor) }}
          </NAlert>
        </div>

        <!-- A cadence the form had to raise, said out loud: silently replacing a
             number the user typed is the other half of the same problem. -->
        <div :key="NOTICE_KEY.correction">
          <NAlert v-if="intervalNotice !== ''" type="info" :bordered="false">{{ intervalNotice }}</NAlert>
        </div>

        <div :key="FIELD_KEY['等待开播']">
          <NFormItem v-if="needsTarget" label="等待开播">
            <NSpace align="center">
              <NSwitch v-model:value="requireOnline" />
              <span class="hint">开启后只在目标真正开播时执行（轮播不算开播）</span>
            </NSpace>
          </NFormItem>
        </div>

        <div :key="FIELD_KEY['加盐']">
          <NFormItem v-if="isSend" label="加盐">
            <NSpace align="center">
              <NSwitch v-model:value="saltEnabled" />
              <span class="hint">装得下的那几条会随机插入 2 个字符（多数是标点），降低被判定为刷屏的概率</span>
            </NSpace>
          </NFormItem>
        </div>

        <NSpace>
          <NButton type="primary" :disabled="!canSubmit" :loading="submitting" @click="submit">创建任务</NButton>
          <NButton @click="router.push({ name: 'tasks' })">返回列表</NButton>
        </NSpace>
      </NSpace>
    </NCard>
  </NSpace>
</template>

<style scoped>
.hint {
  color: #888;
  font-size: 13px;
}

.title {
  font-weight: 500;
}
</style>
