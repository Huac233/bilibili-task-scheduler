<script setup lang="ts">
import { NAlert, NButton, NCard, NEmpty, NInput, NSpin, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import { onMounted, onUnmounted, ref } from 'vue'

import { describeError } from '../api/client.js'
import { accountApi, actionSettingApi, platformApi, taskApi } from '../api/endpoints.js'
import { type ActionSwitch, usePlatformStore } from '../stores/platform.js'
import {
  type Account,
  type ActionChoice,
  type ActionChoiceItem,
  type ActionDescriptor,
  type ActionOptionField,
  type ActionShownRead,
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
 * **Two things are loud here, and both of them are the page's rules rather than the row's.** Off is the
 * default, and the panel says why: an action that is on runs by itself on a timer, and the catalogue
 * contains actions that spend something the account owns, so shipping every action dark is the only way
 * to guarantee that nothing spends an account's balance without a person saying so. And a costly action
 * asks first — turning one on opens a confirmation that names the cost, while turning it off never asks,
 * because stopping something is not the dangerous direction. Both are the notes drawn above the first
 * card, which is where a rule about the page belongs, and both are `NAlert`s because both are cautions.
 *
 * **Every row is one block, and the weight inside it follows the job.** 设置参数 is what a person does on
 * an ordinary visit, so it is the row's one filled control; the offer to make the Task that names the
 * action is the repair for a single state, so it is a quiet button beside that control rather than a bar
 * across the card; and the Target box, the sentence about the action's aim and the sentence about where
 * it stands are three parts of that one block instead of three blocks of their own. **Nothing in the row
 * was dropped to get there** — 会消耗账号资产, the aim, which Tasks name the action, the finished-Task
 * count, the Target box and the parameter form are all still on it.
 *
 * **A switch and a Task are two things, and this panel keeps them apart.** The switch answers *may this
 * action run at all*; a Task answers *when, against which Target, and which action*. And a reconcile Task
 * names **exactly one** action — the one it runs — so an action switched on with no Task naming it does
 * nothing at all, silently. That is a *state*, not a fault: it is where anybody stands the moment they
 * switch an action on, so the row says it in one sentence beside the offer that answers it rather than
 * twice, in an alarm. Every action still says which Tasks name it, or says there is none. **Naming is not
 * running**, which is why the list is headed by the naming rather than by the running: the carrier query
 * keeps a `paused` row on purpose, and a paused Task is left alone by the sweep, so each row carries its
 * own status word instead of the heading claiming one for all of them. Merging the two into a single
 * control would hide the safety property the switch exists for, so they stay two parts of one card.
 *
 * **The Target box says what it resolved to, and this page parses nothing.** `POST
 * /api/targets/resolve` is the adapter's own answer to *which room is this* (`Platform.resolveTarget`,
 * whose contract is "turns pasted input into a target"), and the box asks it where the text is typed
 * instead of only at the moment of creation — so a link pasted into a row is answered on that row, by
 * whichever adapter owns that Platform's shapes. A parser here would be one fact with two homes, and the
 * day a Platform starts accepting a short link the page would go on refusing it.
 *
 * **An account-level action's facts are shown here, and what makes them account-level is
 * `needsTarget`.** An action that needs no Target reads facts about the account — the rooms it
 * follows, the rooms it holds a medal in — and those are this page's business. An action aimed at a
 * Room has facts about *that Room* (钓鱼's 形象, the bait in use, the window the service reports),
 * which this page cannot reach at all: the route that resolves a choice source is handed an account
 * id and no target, so a per-Room read has no field to arrive through. That is the design's split —
 * 账号级的归这页，目标级的归任务页 — and the discriminator is the same field the scheduler selects a
 * Task's actions by, so it is not a second concept. **Those reads arrive through two channels, and
 * only one of them is ever a parameter**: a `choice` field's source is displayed on the row *and*
 * fills that field's list in the form below, while a read the action declares in `shownReads` is
 * displayed and is nothing a person sets — which is why `shownReadsOf` is a union, and why the
 * sentence above the list may not claim that every read under it is a parameter's source.
 *
 * **The parameter form lives here rather than in the view** because this
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

/**
 * What one row's Target box resolved to.
 *
 * **The answer is keyed by the text it is about**, and that is the whole of why this is not a string per
 * row. `Platform.resolveTarget` is a request over the network: it answers a moment after it is asked, and
 * a box the person has typed past by then would otherwise be labelled with the answer to the previous
 * question — a wrong sentence where the honest one is no sentence. Comparing the answer's own text
 * against the box's is what makes a stale answer invisible, and it is also what lets the create path
 * reuse an answer instead of asking the same question twice.
 */
const targetEchoes = ref<Record<string, TargetEcho>>({})

/** One answer about one row's box: the text it is about, and what the server said about it. */
interface TargetEcho {
  /** The box's text at the moment it was asked about, unmodified. The key this answer is valid for. */
  readonly text: string
  readonly state: TargetEchoState
}

/**
 * Three states, and the first is the one that must not be drawn as an answer.
 *
 * `resolving` is a read in flight, `ok` is the adapter's own `TargetInfo`, and `failed` carries the
 * route's sentence rather than a blank: a shape the adapter cannot read is a 400 whose message says so
 * (「无法从该链接解析出直播间号」), and a transport fault is a 502 — two facts a single empty string would
 * flatten into one.
 */
type TargetEchoState =
  | { readonly kind: 'resolving' }
  | { readonly kind: 'ok'; readonly key: string; readonly title: string }
  | { readonly kind: 'failed'; readonly reason: string }

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

/**
 * How long a box is left alone before the server is asked what it holds.
 *
 * One ask per pause rather than one per keystroke: the request goes out to a Platform, and a room link
 * is pasted rather than typed. The box's own blur and Enter ask at once, so this delay is only ever what
 * somebody still typing sees — and `web/tests/action-settings-panel.test.ts` unmounts the panel between
 * tests precisely because this timer outlives a detached element.
 */
const RESOLVE_DEBOUNCE_MS = 400

/** The asks still pending, keyed by row, so a second keystroke replaces the first rather than adding one. */
const echoTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Cancels one row's pending ask, if it has one. */
function cancelEcho(row: string): void {
  const timer = echoTimers.get(row)
  if (timer === undefined) return
  clearTimeout(timer)
  echoTimers.delete(row)
}

/** Records what one row's box should say, against the text it is about. */
function setEcho(row: string, text: string, state: TargetEchoState): void {
  targetEchoes.value = { ...targetEchoes.value, [row]: { text, state } }
}

/**
 * Asks the server what one row's box holds, and writes the answer into that row's echo.
 *
 * **The page parses nothing**: which shapes a Platform accepts — a bare number, a room URL, a vanity path
 * — is the adapter's own rule behind `Platform.resolveTarget`, and a second parser here would be one fact
 * with two homes. So the text travels as typed and the answer is the adapter's, sentences included.
 *
 * Two rules keep the asking honest. **An empty box is not asked about**: there is no shape to look up,
 * and the route's own answer to one is its 400 「请输入直播间链接或房间号」, so asking would be a request
 * made only to be refused. And **one ask per text**: the pause and the box's own blur both call this, and
 * only the first gets through — except after a failure, where an explicit blur or Enter is a person
 * asking again about a link that may have been a transient transport fault.
 */
async function resolveEcho(platformKey: string, entry: PlatformEntry): Promise<void> {
  const row = rowOf(platformKey, entry)
  const text = targetInputOf(row)

  if (text.trim() === '') {
    targetEchoes.value = Object.fromEntries(Object.entries(targetEchoes.value).filter(([key]) => key !== row))
    return
  }

  const answered = targetEchoes.value[row]
  if (answered !== undefined && answered.text === text && answered.state.kind !== 'failed') return

  setEcho(row, text, { kind: 'resolving' })
  try {
    const target = await platformApi.resolveTarget(platformKey, text.trim())
    setEcho(row, text, { kind: 'ok', key: target.key, title: target.title })
  } catch (cause: unknown) {
    setEcho(row, text, { kind: 'failed', reason: describeError(cause) })
  }
}

/** Types into one row's box: the text, and the ask that follows it once the typing stops. */
function onTargetInput(platformKey: string, entry: PlatformEntry, value: string): void {
  const row = rowOf(platformKey, entry)
  setTargetInput(row, value)
  cancelEcho(row)
  echoTimers.set(
    row,
    setTimeout(() => {
      echoTimers.delete(row)
      void resolveEcho(platformKey, entry)
    }, RESOLVE_DEBOUNCE_MS)
  )
}

/** Leaves the box, or presses Enter in it: the same ask as the pause makes, now instead of later. */
function resolveEchoNow(platformKey: string, entry: PlatformEntry): void {
  cancelEcho(rowOf(platformKey, entry))
  void resolveEcho(platformKey, entry)
}

/**
 * What one row's box says back, or null when it has nothing to say.
 *
 * Null is two facts with one rendering, and both of them are the honest one: an answer about text the box
 * no longer holds — so the label can never describe a question the person has moved past — and a box that
 * has not been asked about at all. An answer in flight is said as itself rather than drawn as a blank,
 * because a blank beside a box reads as "nothing wrong here".
 */
function echoOf(row: string): { readonly text: string; readonly failed: boolean } | null {
  const echo = targetEchoes.value[row]
  if (echo === undefined || echo.text !== targetInputOf(row)) return null
  if (echo.state.kind === 'resolving') return { text: '正在识别这个目标…', failed: false }
  if (echo.state.kind === 'failed') return { text: echo.state.reason, failed: true }
  // The title is cosmetic in the adapter's own contract (a Bilibili room that answers `room_init` may
  // still fail its second, title-only read), so an answer without one still names the Target it became.
  const named = echo.state.title === '' ? `目标 ${echo.state.key}` : echo.state.title
  return { text: `已解析：${named}`, failed: false }
}

/** Where one action would run, or null while that read has not landed. */
function workflowOf(platformKey: string, entry: PlatformEntry): ActionWorkflow | null {
  return workflows.value[rowOf(platformKey, entry)] ?? null
}

/**
 * Whether this row can make its own Task, here.
 *
 * `create` is the route's own answer, and it is null exactly when something already names the action —
 * the route builds it from `candidates.length > 0`, the same list `carriers` is mapped from — so the offer
 * and the carrier list can never both be drawn. The other two clauses are this panel's own limits: a Task
 * for an action that is switched off is refused by `POST /api/tasks`, and one for a `send` action also
 * needs a text library, which this panel has no picker for.
 */
function canCreate(platformKey: string, entry: PlatformEntry): boolean {
  const create = workflowOf(platformKey, entry)?.create ?? null
  return create !== null && entry.enabled && !create.needsLibrary
}

/**
 * Where the Task has to be made instead, in one sentence, or `''` when it can be made here.
 *
 * Two sentences, both of them a route's own rule read back: the create refuses a switched-off action, and
 * answers 400 「需要选择文本库」 for a Task that needs a library it was not given. A row with a carrier has
 * `create: null` and says nothing here — the carrier list above it is already the answer, and a sentence
 * about where to create a Task that exists would be the panel describing a state it is not in.
 */
function createElsewhere(platformKey: string, entry: PlatformEntry): string {
  const create = workflowOf(platformKey, entry)?.create ?? null
  if (create === null) return ''
  if (!entry.enabled) return '先把它打开再建任务：服务端不给关闭的动作建任务。'
  if (create.needsLibrary) {
    return '这个动作还要选一个文本库，所以任务在「创建任务」页建：那里能挑库，也能定下时间窗。'
  }
  return ''
}

/** Whether the Task this row would make also wants a Target, which is the box's only reason to exist. */
function createWantsTarget(platformKey: string, entry: PlatformEntry): boolean {
  return workflowOf(platformKey, entry)?.create?.needsTarget === true
}

/** The fields of one row whose values are read from a source rather than typed. */
function choiceFieldsOf(entry: PlatformEntry): readonly ActionOptionField[] {
  return (entry.descriptor.optionFields ?? []).filter(field => field.kind === 'choice')
}

/**
 * One field's read in the shape this page draws.
 *
 * The field's `kind` is dropped on the way in, and that is the point: `ActionShownRead` is what the
 * display needs — a name to ask by, two sentences to read, and the source — while `kind` is what a
 * *form* builds a control from. A read that reaches this list is displayed, never set.
 */
function asShownRead(field: ActionOptionField, source: string): ActionShownRead {
  return { name: field.name, label: field.label, help: field.help, source }
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
 *
 * **Two channels feed the list, and the union is the whole of the rule.** A `choice` field's source
 * is one of them, because a field's read is displayed *and* tickable; `descriptor.shownReads` is the
 * other, which exists for the read no field could carry. The two are mutually exclusive *by
 * declaration* — a read a field already names as its `source` is not repeated in `shownReads` — and
 * that declaration is the one thing here no line of code enforces, which is why the second channel is
 * filtered against the first below rather than trusted. A field that names no source is left out
 * rather than drawn: the route answers that name with a 400, so a heading for it would be a claim no
 * read can settle, and the row would sit on 「正在读取可选项…」 for ever.
 */
function shownReadsOf(entry: PlatformEntry): readonly ActionShownRead[] {
  if (entry.descriptor.needsTarget) return []
  const fromFields = choiceFieldsOf(entry).flatMap(field =>
    field.source === undefined ? [] : [asShownRead(field, field.source)]
  )

  // **A name the fields already declared is dropped, and that is the one line behind the sentence above
  // the list.** The two channels are disjoint *by declaration* — the rule is written in
  // `ActionShownRead` (`web/src/types/api.ts`), in `shownReadOf`
  // (`server/src/actions/action-options.ts`) and in `server/src/platform/types.ts`'s `shownReads` — and
  // no line of code checks it: `descriptorsWithDeclarations` merges the two tables without validating
  // them. Concatenating them here would draw one read twice, keyed `fact-${fact.name}` both times, which
  // is the collision `web/tests/nspace-fragment.test.ts` pins for `NSpace`'s literal `key: 1`. The
  // field's declaration wins because it is the one the parameter form also fills from — the same order
  // the options route resolves a doubled name in, a `choice` field first and a `shownReads` entry second
  // — so a violating descriptor degrades to one row instead of two. `web/tests/account-level-facts.test.ts`
  // pins that with a descriptor that breaks the rule on purpose.
  const declared = new Set(fromFields.map(read => read.name))
  const fromShown = (entry.descriptor.shownReads ?? []).filter(read => !declared.has(read.name))

  return [...fromFields, ...fromShown]
}

/** What one read answered, or null while that read has not landed. */
function readOf(platformKey: string, entry: PlatformEntry, read: ActionShownRead): ActionChoice | null {
  return accountReads.value[rowOf(platformKey, entry)]?.[read.name] ?? null
}

/** The items one read returned. A read that answered nothing has none, and says so itself. */
function readItemsOf(platformKey: string, entry: PlatformEntry, read: ActionShownRead): readonly ActionChoiceItem[] {
  const answer = readOf(platformKey, entry, read)
  return answer?.kind === 'ok' ? answer.items : []
}

/**
 * Which class one read's note is drawn with — one per reading `missingReason` words.
 *
 * **Three readings, three classes, and only the refusal is a failure.** `readOf` answers `null` while
 * the request is in flight, so a two-way test on `kind` — `'ok'`, or everything else — drew the in-flight
 * row as `.missing`, `--row-danger`: 「正在读取可选项…」 in the failure's colour on the first frame of every
 * row, over a request with nothing wrong with it. The reading that has arrived empty is not a failure
 * either — it is the *account's* answer — so it keeps the quiet class it already had, and the wait needs
 * one of its own rather than a reuse of that name: a wait and an empty answer are two different facts,
 * and the class names are how the two are told apart. Which colour each name resolves to is the
 * stylesheet's business, and the stylesheet's comment states the rule this function has to keep.
 */
function factNoteClass(platformKey: string, entry: PlatformEntry, read: ActionShownRead): string {
  const answer = readOf(platformKey, entry, read)
  if (answer === null) return 'note-pending'
  return answer.kind === 'ok' ? 'note-empty' : 'missing'
}

/**
 * Reads every account-level fact this page shows, once per name.
 *
 * **One request per read, because the route answers per name** — one source refusing must not take
 * another source's list with it, and the reads the owner asked for are different sources. Where a
 * read is *also* a field's source, the parameter form asks the same source for itself when it is
 * opened, and that is the design's "one read, two purposes" rather than a second mechanism for
 * display: the same `ChoiceSource`, the same route and the same sentences. A `shownReads` entry has
 * no field behind it and is asked for here alone — so both channels reach the screen through one
 * fetch path, which is why this loop needs no idea which of the two a read came from.
 *
 * Nothing here is re-read after a save. What is displayed is what the *account* holds, and a save
 * writes what a person chose — two different facts, so re-reading after a write would only re-ask a
 * question the write did not change.
 */
async function loadAccountReads(): Promise<void> {
  for (const platform of catalog.catalogue) {
    for (const entry of platform.actions) {
      const reads = shownReadsOf(entry)
      if (reads.length === 0) continue

      const row = rowOf(platform.key, entry)
      const accountId = accountFor(platform.key)?.id ?? null
      const answers: Record<string, ActionChoice> = { ...accountReads.value[row] }

      for (const read of reads) {
        if (accountId === null) {
          // Why there is no list is the sentence `noAccountReason` owns: "no account bound" and "the
          // list did not arrive" are two facts, and a read that landed is what supports the first.
          answers[read.name] = { kind: 'unavailable', reason: noAccountReason(accountsLoaded.value) }
          continue
        }
        try {
          answers[read.name] = await actionSettingApi.options(platform.key, entry.descriptor.key, accountId, read.name)
        } catch (cause: unknown) {
          answers[read.name] = { kind: 'unavailable', reason: describeError(cause) }
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
      // The box's own echo is the same read, of the same text, so a row that has already answered what is
      // typed is not asked the same question twice: one question, one answer, whichever path asked it.
      // The comparison is against the text the answer is about, so an edit made between the echo landing
      // and the press falls through to resolving here rather than creating a Task for the wrong room.
      const echoed = targetEchoes.value[row]
      if (echoed !== undefined && echoed.state.kind === 'ok' && echoed.text.trim() === typed) {
        targetKey = echoed.state.key
        targetTitle = echoed.state.title
      } else {
        cancelEcho(row)
        resolving.value = row
        const target = await platformApi.resolveTarget(platformKey, typed)
        resolving.value = null
        targetKey = target.key
        targetTitle = target.title
        // Written back against the box's own text: a create that fails after resolving leaves the answer
        // where the person typed the question, and one that succeeds clears the box, which hides it.
        setEcho(row, targetInputOf(row), { kind: 'ok', key: target.key, title: target.title })
      }
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

/**
 * Drops the Target box's pending asks when the panel goes away.
 *
 * A paused ask that fires after unmount is a request nobody is waiting for, answered into a component that
 * will never render it — and in a test it lands in the *next* test's request log, which is what half of
 * that suite's assertions read.
 */
onUnmounted(() => {
  for (const timer of echoTimers.values()) clearTimeout(timer)
  echoTimers.clear()
})
</script>

<template>
  <div class="panel">
    <NAlert v-if="error !== ''" type="error">{{ error }}</NAlert>

    <!--
      The page's two rules, each a note with its own heading.

      These are the two loud things here, and deliberately so: one is the ADR-0002 default and the other is
      the difference between a switch and a Task. Above the first card is where a rule about the page
      belongs — drawn inside a row it would be repeated once per action, which is what the row's own quiet
      sentences are for. Each heading is that note's own first clause rather than a new claim: a heading is
      the one line a person may read instead of the paragraph, so it cannot say anything the paragraph, and
      the code behind it, does not.
    -->

    <!-- The reason a costly action ships dark, and **no instance of one**. This note is drawn once, above
         every Platform's card, so an action's name and its price may not appear in it: the price is stated
         in that action's own descriptor, and this file never reads the amount at all — it takes `costly`
         and nothing else — so an example here would be one Platform's fact, in a second home, in a file
         that serves every Platform. It points at the row instead, at the two halves the row already
         draws: the marker `descriptor.costly` puts there, and that descriptor's own `description`,
         rendered on the row below. Nothing new is fetched to make this true — the words are the row's. -->
    <NAlert type="warning" :bordered="false" title="每个动作默认都是关闭的，需要哪个由你在这里亲手打开">
      原因很直接：打开的动作会按任务间隔自己跑，
      其中有些会花掉账号里的东西——这类动作在下面都标了「会消耗账号资产」，花掉的是什么写在它自己那行说明里，
      所以新动作一律先关着，只有你点名要的那个才会运行。
    </NAlert>

    <NAlert type="info" :bordered="false" title="开关和任务是两回事">
      这里两件都摆出来。开关回答「这个动作允许不允许跑」；任务回答「什么时候、对着哪个目标跑、跑哪个动作」。
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
                </div>
                <div class="action-desc">{{ entry.descriptor.description }}</div>

                <!--
                  The one block a person acts in: how the action is aimed, where it stands, and the
                  controls that change either.

                  Four things used to be four blocks — a warning about having no Task, a bar across the
                  card offering to create one, a Target box on a line of its own, and a borderless link for
                  the parameters — which said the same thing at four different volumes and left the routine
                  control as the least visible thing on the row. They are one block now, in the order a
                  person reads them: what this action is aimed at, whether anything runs it, the Target a
                  create would need, and then the row's two controls — the parameters first, because that
                  is what a visit is normally for, and the create second, because it is the repair for one
                  state. **The sentences are the same sentences**; where they sit, and how loudly, is what
                  changed.
                -->
                <div class="row-work">
                  <!-- How it is aimed, and which Tasks name it. The switch beside it decides whether it
                       *may*; this decides whether anything asks for it, which is the half a person could
                       not see. The heading claims the naming and not the running, because the carrier
                       query keeps a `paused` row on purpose and the sweep leaves such a row alone — the
                       row's own note carries that, so the heading does not have to claim it for all of
                       them. -->
                  <div v-if="workflowOf(platform.key, entry) !== null" class="where">
                    <div class="where-shape">{{ workflowOf(platform.key, entry)?.wants.shape }}</div>

                    <div v-if="(workflowOf(platform.key, entry)?.carriers.length ?? 0) > 0" class="carrier-list">
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

                    <!--
                      The state its owner is actually in — on, and no Task asking for it — said once.

                      It is where anybody stands the moment they switch an action on, so it is a sentence
                      rather than an alarm, and it carries both halves in one place: that nothing runs it,
                      and that the switch is only permission. This used to be two statements — this
                      sentence inside a warning block, and a button beside it saying the same thing a
                      second time in the accent colour — which is the doubling the owner reported.
                    -->
                    <div v-else class="nowhere">
                      <div class="state-line">
                        现在没有任何任务运行它，所以这个动作开着也不会动——开关只是允许它跑，真正让它跑起来的是一个在任务里指名了这个动作的任务。
                      </div>

                      <!-- Why a person may be looking at this state with a Task of their own in mind.
                           A Task whose window has closed is finished for good, so it is not a carrier —
                           and the count is what stops this panel from answering their question with
                           「现在没有任何任务运行它」 and leaving it there. -->
                      <div v-if="(workflowOf(platform.key, entry)?.finishedCarriers ?? 0) > 0" class="finished-line">
                        {{ workflowOf(platform.key, entry)?.finishedCarriers }} 个任务已经把时间窗跑完了，不会再跑。要接着跑就重新建一个，建的时候把结束时间往后放。
                      </div>
                    </div>
                  </div>

                  <!-- The attribution read itself, and the only state where a row cannot say which Task
                       names it: `loadWorkflows` answers a refusal with `null` for that action alone, so
                       this is one row's failure rather than the page's. Drawing nothing here is what left
                       the banner's promise unkept, and the once-read flag is what stops the same sentence
                       appearing before the read has had its turn. -->
                  <div v-else-if="workflowsRead" class="where">
                    <div class="where-line">这个动作的归属这次没读到，所以这一行只有开关那一半的事实。</div>
                  </div>

                  <div class="row-actions">
                    <!--
                      The Target, and what it resolved to.

                      The label, the box and the answer are one group because they are one question. The box
                      used to sit in a block of its own with its answer nowhere at all, so a person who
                      pasted a link was told nothing until they pressed the button that creates a Task —
                      and that answer is the one the create itself uses, so it is worth having before the
                      press. The read is the Platform adapter's own (`POST /api/targets/resolve`); nothing
                      here parses the text, so whichever shapes an adapter accepts are accepted wherever
                      they are pasted.
                    -->
                    <div
                      v-if="canCreate(platform.key, entry) && createWantsTarget(platform.key, entry)"
                      class="target-group"
                    >
                      <span class="target-label">针对哪个目标</span>
                      <NInput
                        :value="targetInputOf(rowOf(platform.key, entry))"
                        placeholder="粘贴直播间链接或房间号"
                        style="width: 320px"
                        @update:value="(value: string) => onTargetInput(platform.key, entry, value)"
                        @blur="() => resolveEchoNow(platform.key, entry)"
                        @keydown.enter="() => resolveEchoNow(platform.key, entry)"
                      />
                      <span
                        v-if="echoOf(rowOf(platform.key, entry)) !== null"
                        class="target-echo"
                        :class="{ failed: echoOf(rowOf(platform.key, entry))?.failed === true }"
                      >
                        {{ echoOf(rowOf(platform.key, entry))?.text }}
                      </span>
                    </div>

                    <!-- The row's own control, and the row's primary one: an action is visited to set its
                         parameters, and this is the only filled control the row has. An action that
                         declares no option fields draws none — there would be nothing to set. -->
                    <NButton
                      v-if="(entry.descriptor.optionFields?.length ?? 0) > 0"
                      size="small"
                      type="primary"
                      @click="() => toggleParameters(platform.key, entry.descriptor)"
                    >
                      {{ openForm === rowOf(platform.key, entry) ? '收起参数' : '设置参数' }}
                    </NButton>

                    <template v-if="canCreate(platform.key, entry)">
                      <NButton
                        size="small"
                        :loading="creating === rowOf(platform.key, entry)"
                        :disabled="resolving === rowOf(platform.key, entry)"
                        @click="() => void createCarrier(platform.key, entry)"
                      >
                        建一个任务指名它
                      </NButton>
                    </template>

                    <span v-else-if="createElsewhere(platform.key, entry) !== ''" class="create-line">
                      {{ createElsewhere(platform.key, entry) }}
                    </span>
                  </div>
                </div>

                <!--
                  What this action read about the account — or why it could not — shown rather than only
                  used as a source of choices.

                  Last in the row on purpose: these are read-outs, and the list of rooms an account holds
                  a medal in is long, so a block above the controls would push the controls — the one
                  thing on the row a person presses — to wherever the list happens to end.

                  The heading names the level, and claims nothing about a read: the block is drawn from
                  `shownReadsOf`, whose first line is `descriptor.needsTarget`, so 「账号这一级的读」 is a
                  declaration this page read rather than a fact a read produced. **A heading claiming a
                  read is false in a reachable state** — `accountId === null` asks no source at all, and
                  `loadAccountReads` writes `noAccountReason(accountsLoaded)` into the answer itself — and
                  each row already says which case it is in, so that sentence belongs to the row.
                  **The two halves of the facts-line are the two channels, and neither may claim the
                  other's fact**: a `choice` field's source fills the form's list under it, and a
                  `shownReads` entry is displayed and never set. What stood here said every read on the
                  list was a parameter's source, which was true exactly while every displayed read was one
                  — the second channel is what made it false, and the two halves are what hold for both
                  kinds.

                  The list and the failure are drawn apart, never collapsed: `missingReason` carries
                  the three readings (in flight, refused, arrived-and-empty) and only the failure is
                  coloured as one, because an account that follows no rooms and an account we could
                  not ask about are opposite facts that look identical as a blank.
                -->
                <div v-if="shownReadsOf(entry).length > 0" class="account-facts">
                  <div class="facts-line">
                    这个动作不需要目标，所以这几条都是账号这一级的读：动作参数用得上的那几条，参数表单里的清单就是它们的同一个来源；不参与参数的那几条，只看不改。
                  </div>

                  <div v-for="fact in shownReadsOf(entry)" :key="`fact-${fact.name}`" class="fact">
                    <span class="fact-label">{{ fact.label }}</span>
                    <span class="fact-help">{{ fact.help }}</span>

                    <div class="fact-items">
                      <div
                        v-for="item in readItemsOf(platform.key, entry, fact)"
                        :key="`fact-${fact.name}-${item.value}`"
                        class="fact-item"
                      >
                        {{ itemLabel(item) }}
                      </div>

                      <div
                        v-if="readItemsOf(platform.key, entry, fact).length === 0"
                        :class="factNoteClass(platform.key, entry, fact)"
                      >
                        {{ missingReason(readOf(platform.key, entry, fact)) }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="action-switch">
                <NTag size="tiny" :bordered="false" class="switch-state">
                  {{ entry.enabled ? '已开启' : '已关闭' }}
                </NTag>
                <NSwitch
                  :value="entry.enabled"
                  :loading="pending === rowOf(platform.key, entry)"
                  @update:value="(value: boolean) => onToggle(platform.key, entry.descriptor, value)"
                />
              </div>

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
/*
 * The seven `--row-*` names every colour below reads are declared in one place, `App.vue`, and
 * published on the root element — so this stylesheet declares no colour of its own and neither does
 * any other. The panel used to declare the palette itself, on `.panel`; the parameter form, which is
 * also mounted from `TaskDetailView.vue` where there is no `.panel`, could not read that.
 */
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

/*
 * One row per action, divided by a line rather than by whitespace alone.
 *
 * The divider used to be `#fafafa`, which is a surface colour and not a border: on a white card it was
 * invisible, so four rows read as one paragraph of grey sentences. It is the theme's own border colour
 * now, and the row carries enough padding to be an object rather than a line of text.
 */
.action-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--row-line);
}

/* A rule under the last row would be a divider under nothing. */
.action-row:last-child {
  border-bottom: none;
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

/* The action's name leads the row: the one thing at the row's top weight. */
.action-label {
  color: var(--row-title);
  font-size: 15px;
  font-weight: 600;
}

/* The Platform's own sentence about what the action does: the row's second read, and never greyed out to
   the point of being unread — it is the sentence that says what the action is. */
.action-desc {
  color: var(--row-body);
  font-size: 13px;
  margin-top: 2px;
}

/*
 * The switch and its word, kept together at the row's right and out of the block below.
 *
 * The switch answers a different question from anything in there — *may this action run at all*, against
 * *when, against which Target, and which action* — so it keeps its own column, and the word stays beside
 * the control it describes however the row's content re-wraps.
 */
.action-switch {
  display: flex;
  align-items: center;
  gap: 8px;
}

/*
 * The one block a person acts in.
 *
 * A tinted surface rather than a set of gaps, because the sentences and the controls inside it are one
 * subject: how this action is aimed, where it stands, and what a person can do about either. The colour is
 * the theme's `actionColor`, the same surface the parameter form uses — so pressing 设置参数 opens the form
 * into the surface its own control sits on, instead of into a block that has nothing to do with it.
 */
.row-work {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 12px;
  background: var(--row-surface);
  border-radius: var(--row-radius);
}

.where {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* How the action is aimed: definitional, and the same sentence however the row's state changes, so the
   quietest line in the row. */
.where-shape {
  color: var(--row-quiet);
  font-size: 12px;
}

/* The carrier list's heading. It claims the naming and not the running — see the template. */
.where-line {
  color: var(--row-quiet);
  font-size: 12px;
}

/* The state of a row with no Task naming it: one sentence, at the weight of a status rather than of an
   alarm, because it is where anybody stands the moment they switch an action on. */
.state-line {
  color: var(--row-body);
  font-size: 13px;
}

.carrier-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.carrier {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

/* The Task's own name, which is the fact this list exists for. */
.carrier-name {
  color: var(--row-title);
  font-weight: 600;
}

.carrier-note {
  color: var(--row-quiet);
}

.nowhere {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.create-line {
  color: var(--row-quiet);
  font-size: 12px;
}

.finished-line {
  color: var(--row-quiet);
  font-size: 12px;
}

/* What a person does to this row, in the order they read it: the Target, the parameters, the create. */
.row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* The label, the box and the answer to it, as one group — they are one question. */
.target-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.target-label {
  color: var(--row-body);
  font-size: 13px;
  white-space: nowrap;
}

/* What the box resolved to, or why it could not be read. */
.target-echo {
  color: var(--row-quiet);
  font-size: 12px;
}

.target-echo.failed {
  color: var(--row-danger);
}

/* The read-outs, last in the row: see the template for why they may not sit above the controls. */
.account-facts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}

.facts-line {
  color: var(--row-quiet);
  font-size: 12px;
}

.fact {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.fact-label {
  color: var(--row-title);
  font-weight: 600;
}

.fact-help {
  color: var(--row-quiet);
}

.fact-items {
  display: flex;
  flex-direction: column;
  flex-basis: 100%;
  gap: 2px;
}

.fact-item {
  color: var(--row-body);
}

/* Only a refused read is coloured as a failure; a source that answered nothing is an answer. */
.missing {
  color: var(--row-danger);
}

/*
 * And the reading that has no answer yet is neither of those: the request is out, `missingReason(null)`
 * says so, and the row carries that sentence in the quiet colour the rest of a row's read-outs use —
 * the same colour the empty answer resolves to, since neither of them is a fault. It is a name of its
 * own rather than a reuse of `.note-empty` because a wait and an answer of nothing are two different
 * facts, and the template picks between the three by name.
 */
.note-pending {
  color: var(--row-quiet);
}

.note-empty {
  color: var(--row-quiet);
}

.form {
  flex-basis: 100%;
  margin-top: 12px;
  padding: 12px;
  background: var(--row-surface);
  border-radius: var(--row-radius);
}
</style>
