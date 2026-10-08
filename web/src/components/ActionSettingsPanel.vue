<script setup lang="ts">
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NFormItem,
  NInput,
  NSpin,
  NSwitch,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import { onMounted, ref } from 'vue'

import { describeError } from '../api/client.js'
import { accountApi, actionSettingApi, platformApi, taskApi } from '../api/endpoints.js'
import { type ActionSwitch, usePlatformStore } from '../stores/platform.js'
import {
  type Account,
  type ActionChoice,
  type ActionChoiceItem,
  type ActionDescriptor,
  type ActionOptionField,
  type ActionWorkflow,
  TASK_STATUS_LABEL,
  type TaskWithProgress
} from '../types/api.js'
import ActionOptionForm from './ActionOptionForm.vue'
import { itemLabel, missingReason, noAccountReason } from './choice-notes.js'
import { toggleActionSwitch } from './costly-action.js'
import { namingNote } from './naming-note.js'

/**
 * The action switchboard, and the two questions a switch cannot answer on its own.
 *
 * This panel is the user-facing half of the "off by default" decision (ADR-0002): which actions a
 * person has allowed, per Platform. It is a switch, not a form — the server's `PUT
 * /api/action-settings` takes one action at a time, because that is how a person changes their mind.
 *
 * Three things are deliberately loud here.
 *
 * **Off is the default, and the panel says why.** An action that is on runs by itself on a timer,
 * and the catalogue contains actions that spend something the account owns, so shipping every action
 * dark is the only way to guarantee that nothing spends an account's balance without a person
 * saying so.
 *
 * **A costly action asks first.** Turning one on opens a confirmation that names the cost; turning
 * it off never asks, because stopping something is not the dangerous direction.
 *
 * **A switch and a Task are two things, and this panel keeps them apart.** The switch answers *may
 * this action run at all*; a Task answers *when, against which Target, and which action*. And a
 * reconcile Task names **exactly one** action — the one it runs — so an action switched on with no
 * Task naming it does nothing at all, silently, and that is what the `#where` block below refuses to
 * let happen quietly: every action says which Tasks name it, or says there is none and offers the one
 * Task that is missing. **Naming is not running**, which is why the list is headed by the naming rather
 * than by the running: the carrier query keeps a `paused` row on purpose, and a paused Task is left
 * alone by the sweep, so each row carries its own status word instead of the heading claiming one for
 * all of them. Merging the two into a single control would hide the safety property the switch exists
 * for, so they stay two parts of one card.
 *
 * **An account-level action's facts are shown here, and what makes them account-level is
 * `needsTarget`.** An action that needs no Target reads facts about the account — the rooms it
 * follows, the rooms it holds a medal in — and those are this page's business. An action aimed at a
 * Room has facts about *that Room* (钓鱼's 形象, the bait in use, the window the service reports),
 * which this page cannot reach at all: the route that resolves a choice source is handed an account
 * id and no target, so a per-Room read has no field to arrive through. That is the design's split —
 * 账号级的归这页，目标级的归任务页 — and the discriminator is the same field the scheduler selects a
 * Task's actions by, so it is not a second concept. **One read serves both purposes**: the same
 * source is displayed on the row and fills the parameter form's list.
 *
 * **The parameter form is the third thing, and it lives here rather than in the view** because this
 * is the file the switches are rendered in and a form is per-action: `ActionSettingsView.vue` draws
 * the page's header count and this panel, so a form that read `optionFields` off the same catalogue
 * would either duplicate that read or reach past this component for it.
 */

const catalog = usePlatformStore()
const message = useMessage()
const dialog = useDialog()

/** The action whose switch is mid-flight, so only that row shows as loading. */
const pending = ref<string | null>(null)
const error = ref('')

/** The accounts a Task could run as. Read once; a Task is created for the one of this Platform. */
const accounts = ref<Account[]>([])

/**
 * Whether that account list actually arrived.
 *
 * Absence and a failed read are two different facts, and only one of them supports 「这个平台还没有
 * 绑定账号」. Set on success alone, like the two list flags beside it: a read that landed is what lets
 * this panel assert anything about the accounts, and `TaskCreateView.vue` words the other half the same
 * way (「账号列表没读到，所以这里既不能说你有账号、也不能说你没有」).
 */
const accountsLoaded = ref(false)

/** The caller's Tasks, for the health note beside a carrying Task. */
const tasks = ref<TaskWithProgress[]>([])

/**
 * Whether that Task list actually arrived.
 *
 * The carrier rows come from the workflow route, which answers *which* Tasks name the action and not
 * what they are doing, so every status word under those rows is read off this list — and a status word
 * is exactly what cannot be printed when the list is not there. Set on success alone, like the
 * catalogue's own `loaded` below, and never cleared: the status a row prints is the one the last list
 * that did arrive carried, and a failed re-read does not un-know that list.
 */
const tasksLoaded = ref(false)

/** Where one action would run, keyed by row. Absent means "not answered yet, or the read failed". */
const workflows = ref<Record<string, ActionWorkflow>>({})

/**
 * Whether the attribution read has settled.
 *
 * Needed to tell the two ways a row can have no answer apart: before the read lands, "not answered yet"
 * is the state and there is nothing to report; after it settles, a row still without an answer is a
 * request that failed. Without the flag the panel either flashed a failure sentence on the first paint or
 * drew nothing at all — and drawing nothing is what made the banner's 「下面每个动作都写了哪个任务指名它」
 * a promise the screen could not keep.
 */
const workflowsRead = ref(false)

/** Which action's parameter form is open. One at a time: a form is a place, not a column. */
const openForm = ref<string | null>(null)

/**
 * What one account-level read answered, keyed by row and then by field name.
 *
 * **Absent means "no answer yet" and nothing else**, exactly like the parameter form's own map: the
 * request is in flight and `missingReason(null)` is what the row says meanwhile. Every other outcome
 * is written here as an `unavailable` entry carrying the source's own sentence — a refused read, or
 * the account that is not bound — so the one state missing from this map is the one that genuinely
 * has nothing to report.
 */
const accountReads = ref<Record<string, Record<string, ActionChoice>>>({})

/** The typed Target per row, for an action that is aimed at one. */
const targetInputs = ref<Record<string, string>>({})

/** The Target a resolution ended as, per row, so a person can see what the id became. */
const resolvedTargets = ref<Record<string, string>>({})

/** The row whose Target is mid-resolution, so its button says so. */
const resolving = ref<string | null>(null)

/** The row whose Task is mid-creation. */
const creating = ref<string | null>(null)

function rowKey(platformKey: string, descriptor: ActionDescriptor): string {
  return `${platformKey}/${descriptor.key}`
}

/** Applies a switch change, reverting the row if the server refuses it. */
async function apply(platformKey: string, descriptor: ActionDescriptor, enabled: boolean): Promise<void> {
  pending.value = rowKey(platformKey, descriptor)
  error.value = ''
  try {
    await catalog.setEnabled(platformKey, descriptor.key, enabled)
    message.success(enabled ? `已开启「${descriptor.label}」` : `已关闭「${descriptor.label}」`)
  } catch (cause: unknown) {
    // No local optimistic state to roll back: the switch reads its value from the
    // store, so a failed write simply leaves the row showing what the server has.
    error.value = describeError(cause)
  } finally {
    pending.value = null
  }
}

/**
 * Handles a switch flip.
 *
 * The question a costly action gets asked is not written here: it lives in `toggleActionSwitch`, so
 * the create form's 「开启这个动作」 button asks it too. That matters because this component's own
 * documentation promises it — 「A costly action asks first. Turning one on opens a confirmation that
 * names the cost」 — and a promise a second path can break is not one this screen can keep.
 */
function onToggle(platformKey: string, descriptor: ActionDescriptor, enabled: boolean): void {
  toggleActionSwitch(dialog, descriptor, enabled, value => {
    void apply(platformKey, descriptor, value)
  })
}

/** This Platform's one account, or null when none is bound. */
function accountFor(platformKey: string): Account | null {
  return accounts.value.find(account => account.platform === platformKey) ?? null
}

type PlatformEntry = ActionSwitch

/** One row's key, spelled once so the template and the script cannot disagree about it. */
function rowOf(platformKey: string, entry: PlatformEntry): string {
  return rowKey(platformKey, entry.descriptor)
}

/** The Target typed into one row's box, or `''`. A named accessor because the box is `v-model`ed. */
function targetInputOf(row: string): string {
  return targetInputs.value[row] ?? ''
}

function setTargetInput(row: string, value: string): void {
  targetInputs.value[row] = value
}

/** Where one action would run, or null while that read has not landed. */
function workflowOf(platformKey: string, entry: PlatformEntry): ActionWorkflow | null {
  return workflows.value[rowOf(platformKey, entry)] ?? null
}

/** The fields of one row whose values are read from a source rather than typed. */
function choiceFieldsOf(entry: PlatformEntry): readonly ActionOptionField[] {
  return (entry.descriptor.optionFields ?? []).filter(field => field.kind === 'choice')
}

/**
 * The reads this page displays: those of an action that is about the account itself.
 *
 * **`needsTarget` is the discriminator**, and it is the field the scheduler already selects a Task's
 * actions by — so an action aimed at nothing but the account has facts about the account, and an
 * action aimed at a Room has facts about that Room, which this page cannot reach: the route behind a
 * choice source is handed an account id and no target. Those are shown on the task page, which knows
 * which Room it is about. A target-level action's *parameters* stay here with every other action's —
 * the design keeps one home for a value and gives the task page the same store.
 */
function shownReadsOf(entry: PlatformEntry): readonly ActionOptionField[] {
  return entry.descriptor.needsTarget ? [] : choiceFieldsOf(entry)
}

/** What one field's read answered, or null while that read has not landed. */
function readOf(platformKey: string, entry: PlatformEntry, field: ActionOptionField): ActionChoice | null {
  return accountReads.value[rowOf(platformKey, entry)]?.[field.name] ?? null
}

/** The items one field's read returned. A read that answered nothing has none, and says so itself. */
function readItemsOf(platformKey: string, entry: PlatformEntry, field: ActionOptionField): readonly ActionChoiceItem[] {
  const read = readOf(platformKey, entry, field)
  return read?.kind === 'ok' ? read.items : []
}

/**
 * Reads every account-level fact this page shows, once per field.
 *
 * **One request per field, because the route answers per field** — one source refusing must not take
 * another source's list with it, and the two reads the owner asked for are two different sources.
 * The parameter form reads the same source for itself when it is opened, which is the design's "one
 * read, two purposes" rather than a second mechanism for display: what is displayed and what is
 * tickable come from the same `ChoiceSource`, the same route and the same sentences.
 *
 * Nothing here is re-read after a save. What is displayed is what the *account* holds, and a save
 * writes what a person chose — two different facts, so re-reading after a write would only re-ask a
 * question the write did not change.
 */
async function loadAccountReads(): Promise<void> {
  for (const platform of catalog.catalogue) {
    for (const entry of platform.actions) {
      const fields = shownReadsOf(entry).filter(field => field.source !== undefined)
      if (fields.length === 0) continue

      const row = rowOf(platform.key, entry)
      const accountId = accountFor(platform.key)?.id ?? null
      const answers: Record<string, ActionChoice> = { ...accountReads.value[row] }

      for (const field of fields) {
        if (accountId === null) {
          // Why there is no list is the sentence `noAccountReason` owns: "no account bound" and "the
          // list did not arrive" are two facts, and a read that landed is what supports the first.
          answers[field.name] = { kind: 'unavailable', reason: noAccountReason(accountsLoaded.value) }
          continue
        }
        try {
          answers[field.name] = await actionSettingApi.options(
            platform.key,
            entry.descriptor.key,
            accountId,
            field.name
          )
        } catch (cause: unknown) {
          answers[field.name] = { kind: 'unavailable', reason: describeError(cause) }
        }
      }

      accountReads.value = { ...accountReads.value, [row]: answers }
    }
  }
}

/**
 * What is stored for one action, as the parameter form is handed it.
 *
 * The fallback for an action nothing is stored for is the store's own shared constant, and the note
 * on it says why: the form watches this value to re-seed its controls, so a fresh empty object per
 * render would re-run that watcher on every update and clear the choices it had just fetched.
 */
function storedOptionsOf(platformKey: string, entry: PlatformEntry): unknown {
  return catalog.optionsOf(platformKey, entry.descriptor.key)
}

/**
 * The word for one Task a person can act on.
 *
 * The Target's own title where the Task has one, and the Task's number otherwise. **The Target key
 * itself is not the fallback**: a reconcile Task for a room whose title never resolved would then
 * print a room id, and an identifier belongs in a diagnostic rather than in a sentence. The `#id` is
 * this system's own row number, which is what a person can find on the tasks screen.
 */
function carrierLabel(carrier: ActionWorkflow['carriers'][number]): string {
  return carrier.targetTitle.trim() === '' ? `任务 #${String(carrier.id)}` : carrier.targetTitle
}

/**
 * What is known about one carrying Task's health, or the sentence that says why nothing is.
 *
 * **The rows come from one read and these words from another.** The rows are the workflow route's
 * answer — *which* Tasks name this action — and it says nothing about what those Tasks are doing; the
 * status word under each row is read off `taskApi.list()`. So this is the half that can be missing, and
 * every way it can be missing has its own sentence rather than an empty string: a row with a name and
 * no status word is this panel quietly claiming that the Task's health is known and unremarkable.
 *
 *  - **The list did not arrive.** There is no status to print at all, and the project's pairing says so
 *    in words — `TaskCreateView.vue`'s 「账号列表没读到…」, `TaskDetailView.vue`'s 「发送日志这次没读到」,
 *    `TasksView.vue`'s 「动作目录还没读到」, `AccountsView.vue`'s 「扫码结果没读到」, and this panel's own
 *    「平台目录没读到…」. A read that landed is what lets a view assert anything.
 *  - **It arrived and does not hold this id.** The two reads are a moment apart, so a Task deleted in
 *    between is a carrier to the route and absent from the list. Drawing nothing here would be the same
 *    blank as the case above over a different fact.
 *
 * `failed` and `canceled` are the narrowest case. The carrier query excludes both
 * (`server/src/repo/tasks.ts`'s `listCarrierTasksForAction`), and both are terminal to the status route,
 * so a row reaches these two sentences only when its status moved *between* this list read and the
 * workflow read — `/api/tasks/:id/reset` is what puts one back into the schedulable set. They stay
 * because what they report is the list in hand, which is the only thing this function has to go on.
 */
function carrierNote(carrierId: number): string {
  if (!tasksLoaded.value) return '任务状态这次没读到，所以这一行只有一个名字。'
  const task = tasks.value.find(candidate => candidate.id === carrierId)
  if (task === undefined) return '这次读到的任务列表里没有这一行，所以它的状态看不到。'
  if (task.status === 'failed') return '这个任务失败了，它带着的动作也跑不起来。'
  if (task.status === 'canceled') return '这个任务已取消。'
  return `任务状态：${TASK_STATUS_LABEL[task.status]}`
}

/** Opens or closes one action's parameter form. */
function toggleParameters(platformKey: string, descriptor: ActionDescriptor): void {
  const row = rowKey(platformKey, descriptor)
  openForm.value = openForm.value === row ? null : row
}

/** The smallest Task this panel creates: from now until a day out, at the action's own cadence. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Creates the one Task an action is missing.
 *
 * **The Task is created, not implied.** The switch cannot be the thing that writes a row: a Task
 * carries a window and a Target, and neither is a fact the switchboard holds. So this asks the
 * create route for the Task a person's answer describes, and the route is create-or-get on
 * (Platform, target, action) — a second Task for the same three would run the same work twice, so
 * getting the existing one back is the correct answer rather than a failure.
 *
 * The action must already be on for the route to accept this, which is why the offer is only drawn
 * on an action that is enabled: it is exactly the state its owner is in when he presses it.
 */
async function createCarrier(platformKey: string, entry: PlatformEntry): Promise<void> {
  const row = rowOf(platformKey, entry)
  const account = accountFor(platformKey)
  if (account === null) {
    // 「还没有绑定账号」 is a claim about the account list, so it may only be made once that list
    // arrived: an empty `accounts` is also what a failed read leaves behind, and this panel draws the
    // create offer from the attribution read rather than from that one, so a person can be standing
    // here with an account bound and a read that says nothing at all.
    error.value = accountsLoaded.value
      ? '这个平台还没有绑定账号，先绑定一个再创建任务。'
      : '账号列表这次没读到，所以不知道这个平台有没有绑定账号。'
    return
  }

  const wantsTarget = workflowOf(platformKey, entry)?.create?.needsTarget ?? entry.descriptor.needsTarget
  const typed = (targetInputs.value[row] ?? '').trim()

  if (wantsTarget && typed === '') {
    error.value = `「${entry.descriptor.label}」是按目标做的动作，先填上要针对哪个目标。`
    return
  }

  creating.value = row
  error.value = ''
  try {
    let targetKey = ''
    let targetTitle = ''
    if (wantsTarget) {
      resolving.value = row
      const target = await platformApi.resolveTarget(platformKey, typed)
      resolving.value = null
      targetKey = target.key
      targetTitle = target.title
      resolvedTargets.value[row] = targetTitle === '' ? `目标 ${target.key}` : targetTitle
    }

    const now = Date.now()
    const named = await taskApi.create({
      platform: platformKey,
      accountId: account.id,
      actionKey: entry.descriptor.key,
      startTime: now,
      endTime: now + DAY_MS,
      interval:
        workflowOf(platformKey, entry)?.create?.defaultIntervalSeconds ?? entry.descriptor.defaultIntervalSeconds,
      ...(wantsTarget ? { targetKey, targetTitle } : {})
    })

    // What the route answered with, which is a row it wrote **or** one it handed back — and that one
    // may be paused, in which case nothing sweeps it. `namingNote` is that sentence's one home.
    message.success(namingNote(entry.descriptor.label, named.status))
    targetInputs.value[row] = ''
    await refreshRows()
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    resolving.value = null
    creating.value = null
  }
}

/**
 * One read, reported on failure instead of thrown.
 *
 * **Two reads used to share one `try`, and neither could say what the other answered.** `Promise.all`
 * rejects to that one catch and reaches neither binding, so a failed `/api/tasks` also threw away the
 * account list — and, because `loadWorkflows` sat after both inside the same `try`, it took every
 * carrier row off the page with it, over a read it does not use. Which half failed is exactly what the
 * sentences under a carrier row are about, so each read reports its own failure to the alert above and
 * answers `null`.
 */
async function readOrReport<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read
  } catch (cause: unknown) {
    error.value = describeError(cause)
    return null
  }
}

/** Re-reads the workflows and the task list, so a row reflects what was just created. */
async function refreshRows(): Promise<void> {
  const taskList = await readOrReport(taskApi.list())
  if (taskList !== null) {
    tasks.value = taskList
    tasksLoaded.value = true
  }
  await loadWorkflows()
}

/**
 * Reads every action's attribution.
 *
 * One request per catalogued action, and the route is asked rather than the answer being derived
 * here, because the rule it applies — a reconcile Task runs the action its own row names — is the
 * scheduler's rule and belongs in one place. A refusal for one action is not worth a banner: that
 * row then falls back to saying only what the switch knows, which is worse than being told which
 * Task runs the action and better than a screen that looks broken.
 */
async function loadWorkflows(): Promise<void> {
  const rows: { key: string; platformKey: string; actionKey: string }[] = []
  for (const platform of catalog.catalogue) {
    for (const entry of platform.actions) {
      rows.push({
        key: rowKey(platform.key, entry.descriptor),
        platformKey: platform.key,
        actionKey: entry.descriptor.key
      })
    }
  }

  const answers = await Promise.all(
    rows.map(async row => ({
      key: row.key,
      workflow: await actionSettingApi.workflow(row.platformKey, row.actionKey).catch(() => null)
    }))
  )

  const landed: Record<string, ActionWorkflow> = {}
  for (const answer of answers) {
    if (answer.workflow !== null) landed[answer.key] = answer.workflow
  }
  workflows.value = landed
  workflowsRead.value = true
}

onMounted(async () => {
  await catalog.ensure()

  // Each read is reported on its own, and the attribution is not inside either of them: the carrier
  // rows come from the workflow route, which answers whether a Task names the action rather than what
  // the Task is doing, so a failed Task list is a missing status word and never a missing row.
  const [accountList, taskList] = await Promise.all([readOrReport(accountApi.list()), readOrReport(taskApi.list())])
  if (accountList !== null) {
    accounts.value = accountList
    accountsLoaded.value = true
  }
  if (taskList !== null) {
    tasks.value = taskList
    tasksLoaded.value = true
  }

  // After the accounts, because every read here is read *for* an account — and its absence is itself
  // one of the two sentences the rows draw.
  await loadAccountReads()

  await loadWorkflows()
})
</script>

<template>
  <div class="panel">
    <NAlert v-if="error !== ''" type="error">{{ error }}</NAlert>

    <!-- The reason a costly action ships dark, and **no instance of one**. This note is drawn once, above
         every Platform's card, so an action's name and its price may not appear in it: the price is stated
         in that action's own descriptor, and this file never reads the amount at all — it takes `costly`
         and nothing else — so an example here would be one Platform's fact, in a second home, in a file
         that serves every Platform. It points at the row instead, at the two halves the row already
         draws: the marker `descriptor.costly` puts there, and that descriptor's own `description`,
         rendered on the row below. Nothing new is fetched to make this true — the words are the row's. -->
    <NAlert type="warning" :bordered="false">
      每个动作默认都是关闭的，需要哪个由你在这里亲手打开。原因很直接：打开的动作会按任务间隔自己跑，
      其中有些会花掉账号里的东西——这类动作在下面都标了「会消耗账号资产」，花掉的是什么写在它自己那行说明里，
      所以新动作一律先关着，只有你点名要的那个才会运行。
    </NAlert>

    <NAlert type="info" :bordered="false">
      开关和任务是两回事，这里两件都摆出来。开关回答「这个动作允许不允许跑」；任务回答「什么时候、对着哪个目标跑、跑哪个动作」。
      一个任务只跑它自己指名的那个动作，所以一个动作开着、却没有指名它的任务，它一趟也不会跑——下面每个动作都写了哪个任务指名它（这一次没读到的那一行会自己说明），
      没有的话可以补一个：这里能就地建的会给按钮，需要文本库的去「创建任务」页建。
      <!-- 「指名它」而不是「在跑它」：下面那单子按 action_key 命中取行，它刻意含 paused 行，而扫不到 paused。
           标题已经收到「指名这个动作的任务：」，横幅不能把那个承诺又主张回来。
           而「（这一次没读到的那一行会自己说明）」这句也不是客气话：归属是一个动作一个请求，一行读失败时
           它整块不画，那两个承诺就有一个落空——所以那一行现在有一句自己的话。 -->
    </NAlert>

    <NSpin :show="catalog.loading">
      <!-- 「没有可用的平台」 is a claim about the catalogue, so it is made only once the catalogue
           really arrived (`loaded` is set on success alone). When the read failed, the panel says what
           it does not know — and `catalog.error` finally has a reader: it was written on every failure
           and rendered nowhere, which is how a failed `GET /api/platforms` turned into 「没有可用的平台」. -->
      <NEmpty
        v-if="catalog.catalogue.length === 0 && !catalog.loading && catalog.loaded"
        description="没有可用的平台"
      />

      <NAlert v-else-if="catalog.catalogue.length === 0 && !catalog.loading" type="error">
        平台目录没读到，所以这一页没有东西可显示：{{ catalog.error !== '' ? catalog.error : '服务端没有说原因' }}
      </NAlert>

      <div v-else class="platforms">
        <NCard v-for="platform in catalog.catalogue" :key="platform.key" size="small">
          <template #header>
            <div class="platform-head">
              <span>{{ platform.label }}</span>
              <NTag size="tiny" :bordered="false">
                {{ platform.actions.filter(action => action.enabled).length }} / {{ platform.actions.length }} 已开启
              </NTag>
            </div>
          </template>

          <!--
            One row per action, and every row is a plain element with a stable key rather than an
            `NSpace` child. `NSpace` wraps each child it is given in a `<div key={1}>`
            (naive-ui `es/space/src/Space.mjs`), so its keyed fragment carries duplicate keys and Vue
            reuses the wrong nodes when the child set changes — the trap
            `web/tests/nspace-fragment.test.ts` pins. The child set here changes with the action, so
            the keys are the actions' own.
          -->
          <div class="rows">
            <div v-for="entry in platform.actions" :key="entry.descriptor.key" class="action-row">
              <div class="action-info">
                <div class="action-title">
                  <span class="action-label">{{ entry.descriptor.label }}</span>
                  <NTag v-if="entry.descriptor.costly" size="tiny" type="warning">会消耗账号资产</NTag>
                  <NTag size="tiny" :bordered="false" class="switch-state">
                    {{ entry.enabled ? '已开启' : '已关闭' }}
                  </NTag>
                </div>
                <div class="action-desc">{{ entry.descriptor.description }}</div>

                <!--
                  What this action read about the account, shown rather than only used as a source
                  of choices.

                  The heading claims the shape and the page, both of which are facts the code read:
                  the block exists only for `needsTarget === false` actions, and each item below it is
                  the answer to a read this page made for the bound account. **One read, two
                  purposes** — the same field's source fills the parameter form's list, which is why
                  the sentence says so where a person can check it against both.

                  The list and the failure are drawn apart, never collapsed: `missingReason` carries
                  the three readings (in flight, refused, arrived-and-empty) and only the failure is
                  coloured as one, because an account that follows no rooms and an account we could
                  not ask about are opposite facts that look identical as a blank.
                -->
                <div v-if="shownReadsOf(entry).length > 0" class="account-facts">
                  <div class="facts-line">
                    这个动作不需要目标，所以这几条都是按账号读出来的：它们既是给你看的实情，也是动作参数里那份清单的同一个来源。
                  </div>

                  <div v-for="field in shownReadsOf(entry)" :key="`fact-${field.name}`" class="fact">
                    <span class="fact-label">{{ field.label }}</span>
                    <span class="fact-help">{{ field.help }}</span>

                    <div class="fact-items">
                      <div
                        v-for="item in readItemsOf(platform.key, entry, field)"
                        :key="`fact-${field.name}-${item.value}`"
                        class="fact-item"
                      >
                        {{ itemLabel(item) }}
                      </div>

                      <div
                        v-if="readItemsOf(platform.key, entry, field).length === 0"
                        :class="readOf(platform.key, entry, field)?.kind === 'ok' ? 'note-empty' : 'missing'"
                      >
                        {{ missingReason(readOf(platform.key, entry, field)) }}
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Which Tasks name it. The switch beside it decides whether it *may*; this decides
                     whether anything asks for it, which is the half a person could not see. The heading
                     claims the naming and not the running, because the carrier query keeps a `paused`
                     row on purpose and the sweep leaves such a row alone — the row's own note carries
                     that, so the heading does not have to claim it for all of them. -->
                <div v-if="workflowOf(platform.key, entry) !== null" class="where">
                  <div class="where-shape">{{ workflowOf(platform.key, entry)?.wants.shape }}</div>

                  <div
                    v-if="(workflowOf(platform.key, entry)?.carriers.length ?? 0) > 0"
                    class="carrier-list"
                  >
                    <div class="where-line">指名这个动作的任务：</div>
                    <div
                      v-for="carrier in workflowOf(platform.key, entry)?.carriers ?? []"
                      :key="`carrier-${String(carrier.id)}`"
                      class="carrier"
                    >
                      <span class="carrier-name">{{ carrierLabel(carrier) }}</span>
                      <span class="carrier-note">{{ carrierNote(carrier.id) }}</span>
                    </div>
                  </div>

                  <!-- The state its owner was actually in: on, and no Task asking for it. -->
                  <div v-else class="nowhere">
                    <NAlert type="warning" :bordered="false">
                      现在没有任何任务运行它，所以这个动作开着也不会动。开关只是允许它跑，真正让它跑起来的是一个在任务里
                      指名了这个动作的任务。
                    </NAlert>

                    <!-- Why a person may be looking at this state with a Task of their own in mind.
                         A Task whose window has closed is finished for good, so it is not a carrier —
                         and the count is what stops this panel from answering their question with
                         「现在没有任何任务运行它」 and leaving it there. -->
                    <div
                      v-if="(workflowOf(platform.key, entry)?.finishedCarriers ?? 0) > 0"
                      class="finished-line"
                    >
                      {{ workflowOf(platform.key, entry)?.finishedCarriers }} 个任务已经把时间窗跑完了，不会再跑。
                      要接着跑就重新建一个，建的时候把结束时间往后放。
                    </div>

                    <div v-if="!entry.enabled" class="create-line">
                      先把它打开再建任务：服务端不给关闭的动作建任务。
                    </div>

                    <!--
                      The offer is only made where this panel can carry it out.

                      `create.needsLibrary` is the route's own answer, and it is the half this panel
                      has no field for: a Task for such an action needs a library id, and a create
                      built from the offer alone would come back as the route's 400 (「需要选择文本库」)
                      every single time. Where that is the case, the sentence says where the Task can
                      be made instead of drawing a button that cannot work.
                    -->
                    <div v-else-if="workflowOf(platform.key, entry)?.create?.needsLibrary === true" class="create-line">
                      这个动作还要选一个文本库，所以任务在「创建任务」页建：那里能挑库，也能定下时间窗。
                    </div>

                    <div v-else-if="workflowOf(platform.key, entry)?.create !== null" class="create">
                      <NFormItem
                        v-if="workflowOf(platform.key, entry)?.create?.needsTarget === true"
                        label="针对哪个目标"
                      >
                        <div class="target-line">
                          <NInput
                            :value="targetInputOf(rowOf(platform.key, entry))"
                            placeholder="粘贴直播间链接或房间号"
                            style="width: 320px"
                            @update:value="(value: string) => setTargetInput(rowOf(platform.key, entry), value)"
                          />
                          <span v-if="resolvedTargets[rowOf(platform.key, entry)] !== undefined" class="hint">
                            已解析：{{ resolvedTargets[rowOf(platform.key, entry)] }}
                          </span>
                        </div>
                      </NFormItem>

                      <NButton
                        size="small"
                        type="primary"
                        :loading="creating === rowOf(platform.key, entry)"
                        :disabled="resolving === rowOf(platform.key, entry)"
                        @click="() => void createCarrier(platform.key, entry)"
                      >
                        建一个任务指名它
                      </NButton>
                    </div>
                  </div>
                </div>

                <!-- The attribution read itself, and the only state where a row cannot say which Task names
                     it: `loadWorkflows` answers a refusal with `null` for that action alone, so this is one
                     row's failure rather than the page's. Drawing nothing here is what left the banner's
                     promise unkept, and the once-read flag is what stops the same sentence appearing before
                     the read has had its turn. -->
                <div v-else-if="workflowsRead" class="where">
                  <div class="where-line">这个动作的归属这次没读到，所以这一行只有开关那一半的事实。</div>
                </div>

                <!-- An action that declares no option fields draws no form at all, rather than an
                     empty one: there is nothing a person could set. -->
                <div v-if="(entry.descriptor.optionFields?.length ?? 0) > 0" class="params">
                  <NButton size="tiny" :bordered="false" @click="() => toggleParameters(platform.key, entry.descriptor)">
                    {{ openForm === rowOf(platform.key, entry) ? '收起参数' : '设置参数' }}
                  </NButton>
                </div>
              </div>

              <NSwitch
                :value="entry.enabled"
                :loading="pending === rowOf(platform.key, entry)"
                @update:value="(value: boolean) => onToggle(platform.key, entry.descriptor, value)"
              />

              <!--
                The parameter form, keyed by row so switching action cannot reuse another's. It is handed
                `accountId: null` for two different reasons — nothing bound, or the account list did not
                arrive — so it is handed `accountsLoaded` as well: without that flag the form can only read
                the null as absence, and it would answer a person who has an account bound with
                「这个平台还没有绑定账号」.
              -->
              <div v-if="openForm === rowOf(platform.key, entry)" :key="`form-${rowOf(platform.key, entry)}`" class="form">
                <ActionOptionForm
                  :platform-key="platform.key"
                  :descriptor="entry.descriptor"
                  :account-id="accountFor(platform.key)?.id ?? null"
                  :accounts-loaded="accountsLoaded"
                  :stored-options="storedOptionsOf(platform.key, entry)"
                  @saved="() => void refreshRows()"
                />
              </div>
            </div>
          </div>
        </NCard>
      </div>
    </NSpin>

    <NButton v-if="!catalog.loading" size="small" @click="() => void catalog.load()">重新加载</NButton>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.platforms {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.platform-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rows {
  display: flex;
  flex-direction: column;
}

.action-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid #fafafa;
}

.action-info {
  flex: 1;
  min-width: 0;
}

.action-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-label {
  font-weight: 500;
}

.action-desc {
  color: #888;
  font-size: 13px;
  margin-top: 4px;
}

.where {
  margin-top: 8px;
}

.account-facts {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.facts-line {
  color: #666;
  font-size: 13px;
}

.fact {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.fact-label {
  font-weight: 500;
}

.fact-help {
  color: #888;
}

.fact-items {
  display: flex;
  flex-direction: column;
  flex-basis: 100%;
  gap: 2px;
}

.fact-item {
  color: #333;
}

/* Only a refused read is coloured as a failure; a source that answered nothing is an answer. */
.missing {
  color: #d03050;
}

.note-empty {
  color: #888;
}

.where-shape {
  color: #666;
  font-size: 13px;
}

.where-line {
  color: #666;
  font-size: 13px;
  margin-top: 4px;
}

.carrier-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.carrier {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.carrier-name {
  font-weight: 500;
}

.carrier-note {
  color: #888;
}

.nowhere {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.create-line {
  color: #888;
  font-size: 13px;
}

.finished-line {
  color: #888;
  font-size: 13px;
}

.create {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.target-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.params {
  margin-top: 8px;
}

.form {
  flex-basis: 100%;
  margin-top: 12px;
  padding: 12px;
  background: #fafafa;
  border-radius: 4px;
}

.hint {
  color: #888;
  font-size: 13px;
}
</style>
