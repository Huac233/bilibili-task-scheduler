/**
 * Wire types shared with the backend.
 *
 * Hand-written rather than generated: the surface is small, and keeping the
 * shapes in one reviewable file makes a backend change visible in the diff
 * instead of hidden inside a codegen step.
 *
 * **No Platform is named in this file, not even in a union.** A Platform, its
 * label and its action catalogue arrive at run time from `GET /api/platforms`,
 * so everything below only has to be able to *carry* them; adding a Platform is a
 * new adapter, never a new literal here.
 *
 * Timestamps are milliseconds since epoch, matching `Date.now()`.
 */

export interface User {
  readonly id: number
  readonly username: string
  readonly createdAt: number
}

/* ------------------------------ actions ------------------------------ */

/**
 * Which executor runs an Action. Mirrors `TaskAction` in `server/src/repo/tasks.ts`.
 *
 * `send` consumes Bullets from a Library and has no completion condition;
 * `reconcile` reads what the Platform reports as outstanding and finishes when
 * nothing is. It is the only branch the UI takes about a task, and it is a
 * property of the executor rather than of any one Platform.
 */
export const TaskAction = {
  Send: 'send',
  Reconcile: 'reconcile'
} as const
export type TaskAction = (typeof TaskAction)[keyof typeof TaskAction]

/**
 * How a person types one of an action's options.
 *
 * Mirrors `ActionOptionKind` in `server/src/platform/types.ts` field for field. Three kinds, and
 * deliberately no `json` member: **a field a person cannot type is not ready to be exposed**, so an
 * option whose value is a document is an option this form refuses to draw rather than one it draws
 * as a free-form text box.
 */
export type ActionOptionKind = 'text' | 'number' | 'choice'

/**
 * One knobs the action reads, as the form needs it.
 *
 * Mirrors `ActionOptionField`. `name` is the key the action reads out of its options, so it is the
 * whole of the option's contract; `label` and `help` are what a person reads; `source` is set
 * exactly when `kind` is `choice` and names where the choices come from — `actionSettingApi.options`
 * resolves it, because a list of what an account currently holds is not a fact a catalogue can know.
 */
export interface ActionOptionField {
  readonly name: string
  readonly label: string
  /** One sentence about the field. May be empty, and `''` is not rendered as a blank line. */
  readonly help: string
  readonly kind: ActionOptionKind
  /** The choice source's key. Present iff `kind` is `choice`. */
  readonly source?: string
}

/**
 * One read an action **shows** about the account, which is deliberately not a knob a person sets.
 *
 * Mirrors `ActionShownRead` in `server/src/platform/types.ts` field for field. It is the sibling of
 * `ActionOptionField` and separate from it on purpose: a field is a decision stored in
 * `action_settings`, and a shown read is a fact read from the Platform, so a name in both would be a
 * name whose control has no meaning.
 *
 * **No `kind`, and that is the whole of "not a parameter".** `ActionOptionKind` is what a form builds
 * a control from, and a read has no control — so the panel displays these under `label` and `help`
 * and offers nothing to tick, which is what 「算出来的，不是填的」 means at this end of the wire.
 * Nothing here is ever rendered as an identifier: `name` is the key the options route is asked by,
 * `label` and `help` are the two sentences a person reads, and `source` names the `ChoiceSource` the
 * route resolves — required, because a read with no source is a read of nothing.
 */
export interface ActionShownRead {
  readonly name: string
  readonly label: string
  /** One sentence saying what the read is and that it is not something to fill in. */
  readonly help: string
  readonly source: string
}

/**
 * What a Platform says it can do.
 *
 * Mirrors `ActionDescriptor` in `server/src/platform/types.ts` field for field:
 * the create form is built out of these, so a field added there becomes a field
 * the form fills in — without the form knowing which Platform it is filling in
 * for. That indirection is the whole point of the create flow.
 */
export interface ActionDescriptor {
  /** Stable key stored on a task and in `action_settings`, e.g. `send_danmaku`. */
  readonly key: string
  readonly action: TaskAction
  readonly label: string
  readonly description: string
  /**
   * True when running it spends something the account owns — Douyu's 打卡分鱼丸
   * spends 200 鱼丸 to enter. A stop does not give that back, so the form warns
   * before such a task can be created.
   */
  readonly costly: boolean
  /** Needs a Target (a Room). An account-scoped action such as a check-in does not. */
  readonly needsTarget: boolean
  /** Needs a Library of Bullets. Only Send actions do. */
  readonly needsLibrary: boolean
  /** The Platform's own cap on one message, in characters. */
  readonly maxMessageLength: number
  /** A sensible cadence for a newly created task, in seconds. */
  readonly defaultIntervalSeconds: number
  /**
   * The fastest this action may be scheduled, in seconds. A hard floor.
   *
   * It belongs to the action rather than to the form because it is a Platform
   * fact — one Platform refuses danmaku arriving too fast, another was measured
   * at a floor of roughly two seconds — and the number the create and edit routes
   * enforce is this one. The form uses it for the same reason: so a value the
   * user is allowed to type is a value the route will accept.
   */
  readonly minIntervalSeconds: number
  /**
   * The knobs this action reads out of its stored options, in the order to render them. Absent when
   * it reads none.
   *
   * The fields are the form's vocabulary and never the safety boundary: the action itself refuses
   * anything its own rule does not allow, so an option this form cannot express makes an action do
   * less, never more. `ActionSettingsPanel` says that where a person can read it.
   */
  readonly optionFields?: readonly ActionOptionField[]
  /**
   * The account-level reads this action *shows*, which are **not** parameters a person sets.
   *
   * The sibling of `optionFields`, and read by the same page: `ActionSettingsPanel` displays the
   * sources of its `choice` fields **and** these, in one block, because both are the same kind of
   * fact — an answer from a live source, asked for by name through `GET
   * /api/action-settings/options` and answered with the same success shape and the same failure
   * sentences. What differs is the second use a field's read has: a field's source also fills that
   * field's list in the form, while a shown read belongs to no control at all.
   *
   * Absent rather than empty, for `optionFields`' own reason: "this action shows no read other than
   * its fields'" and "this action shows nothing" are two readings the page draws differently. A read
   * a `choice` field already names as its `source` must **not** be repeated here — it is displayed
   * because the field needs it, and declaring it twice would ask one read as two facts.
   */
  readonly shownReads?: readonly ActionShownRead[]
}

/** A Platform as the catalogue describes it: a key, a display name, its actions. */
export interface Platform {
  readonly key: string
  readonly label: string
  readonly actions: readonly ActionDescriptor[]
}

/* ------------------------------ accounts ------------------------------ */

/**
 * One person's binding to one Platform.
 *
 * Carries identifiers and a display name and nothing else: the credential blob
 * stays on the server, which is why this shape has no field for it.
 */
export interface Account {
  readonly id: number
  readonly platform: string
  readonly displayName: string
  readonly avatar: string
  /** The account's id *on the Platform*: a uid, a room-owner id, a device-scoped id. */
  readonly externalId: string
  readonly createdAt: number
}

/** A Target the Platform recognised, resolved from whatever a person pasted. */
export interface TargetInfo {
  readonly key: string
  readonly title: string
  /**
   * What `title` does not say, as a sentence the page shows beside it — `''` when there is nothing to explain.
   *
   * Mirrors `TargetInfo.titleNote` in `server/src/platform/types.ts`, whose note is the contract's own: a
   * label can be a fallback, and a fallback that does not say it is one reads as an answer. Bilibili's
   * `title` is the Anchor's name when a credential can read it and the broadcast's 标题 when it cannot, and
   * the two are indistinguishable to a reader — so the adapter says why, and **the page draws it as a note
   * beside the label rather than as an error**: the Target did resolve, and a refusal is a thrown
   * `TargetRefusal`, which arrives as a 4xx the page shows in its own error slot.
   *
   * **Empty means "nothing to add", not "no reason recorded"**, which is why it is required here as well:
   * every adapter states which of the two it is rather than leaving a reader to guess from a missing key.
   */
  readonly titleNote: string
  readonly anchorId: string
  readonly anchorName: string
  /** The Platform's own liveness value; only meaningful for live-room targets. */
  readonly liveStatus: number
}

/**
 * One Action's switch.
 *
 * The API merges these over every Platform's catalogue, so an action with no row
 * of its own still appears — as `enabled: false`. Absence means off, which is the
 * ADR-0002 default: a new action ships dark.
 */
export interface ActionSetting {
  readonly platform: string
  readonly actionKey: string
  readonly enabled: boolean
  /**
   * Per-action knobs the Platform adapter understands.
   *
   * `unknown` rather than a shape, and already parsed rather than a JSON string:
   * the seam gives `ActionDescriptor` no schema for these, because they belong to
   * the adapter, so the route stores what the client sent and the UI hands the
   * value straight back on the next write.
   */
  readonly options: unknown
}

/**
 * Where an action would actually run, as `GET /api/action-settings/workflow` answers it.
 *
 * The one thing a person cannot otherwise discover: **an Action switch turned on with no Task
 * naming that action does nothing at all, silently.** A switch says "may this action run", a Task
 * says "when, against which Target, and which action", and a Task names **exactly one** action — the
 * one it runs, decided by its own `actionKey`. `carriers` is that match, and `create` is the way out
 * when it is empty.
 *
 * **Both executors are answered here.** A `send` Task names its action like a reconcile one, so it is
 * a carrier of it too: asking this question of a reconcile run's own rule (`reconcileSelectionFor`)
 * answers `unknown` for every `send` action, which is how the screen came to tell a person with a
 * working send Task that nothing ran it. The route filters by the row's action and target — the half
 * of the run's rule that does not depend on the executor — and leaves the switch to the setting drawn
 * beside it.
 *
 * **`carriers` is the Tasks that *name* it — whether one runs it is its status and the switch beside it.**
 * The naming was the heading this screen used to get wrong in the other direction, and the row's own
 * status word is what the panel says instead of claiming a run for all of them: a `paused` row is on this
 * list on purpose (`server/src/repo/tasks.ts` says why — excluding it would make the create path write a
 * *second* row for the same key, and two rows would run one chore twice), and `listSchedulableTasks`
 * takes only `waiting`/`offline`/`running`, so nothing sweeps it.
 *
 * **What is excluded is the finished and the stopped end.** A Task whose window has closed is finished
 * for good — the sweep takes only live states, and nothing reopens a closed window — and a `failed` or
 * `canceled` row is one somebody or something already ended. Listing one of those here would be this
 * screen calling a dead row a carrier, and it would withhold the `create` that is the way back. Rows
 * that ran their window out are counted by `finishedCarriers` instead, which is what lets the panel say
 * what happened rather than pretend the Task was never made; `failed` and `canceled` rows are counted in
 * neither answer, because a stopped Task is a different sentence with a different remedy.
 *
 * **The switch and the Task stay two facts here**, which is why this shape never collapses them: the
 * switch's own value comes from the setting beside it, and this only answers where the Task is.
 */
export interface ActionWorkflow {
  /** What the action's own declaration asks a Task to be aimed at. */
  readonly wants: {
    readonly needsTarget: boolean
    /** One sentence naming what the action is aimed at, never a field name. */
    readonly shape: string
  }
  /** The Tasks that name it. Empty is the state that used to be invisible. */
  readonly carriers: readonly {
    readonly id: number
    /** The Target's own title, empty when the Task carries no Target or never resolved one. */
    readonly targetTitle: string
    /** The Target as the Platform was told. An identifier, so never rendered. */
    readonly targetKey: string
  }[]
  /**
   * How many Tasks naming this action have run their time window out and will not run again.
   *
   * A count rather than a list, because there is nothing to do to one: `create` is the only move
   * that restarts the action. It is here so the panel can say where a Task its owner remembers
   * making went, instead of leaving a bare 「现在没有任何任务运行它」 to explain it.
   */
  readonly finishedCarriers: number
  /** The Task to create when none runs this action, or null when there is nothing to create. */
  readonly create: {
    readonly needsTarget: boolean
    /**
     * Whether such a Task also needs a text library, which the offer itself has no field for.
     *
     * The route says so because the panel cannot fill that hole: `POST /api/tasks` answers 400
     * 「需要选择文本库」 for a `send` action without one, so a create built from this offer alone would
     * be refused every time. A caller reading this says where the Task really comes from — the create
     * page, which has the picker — instead of drawing a button that cannot work.
     */
    readonly needsLibrary: boolean
    /** The action's own measured cadence, so the created Task is not this form's guess. */
    readonly defaultIntervalSeconds: number
  } | null
}

/**
 * One value a choice-backed option field offers.
 *
 * `value` is what gets stored and is frequently an id, so it is never rendered; `label` and `count`
 * are what a person chooses by. `costsSomething` is the three-valued half: `true` means the Platform
 * marks the item as one it charges for, and `false` means only that the Platform made no such
 * marking — **not** that the item is free. The whole reason Douyu's gift list is chosen by hand is
 * that the Platform's own flags do not separate free from paid, so a form printing 「免费」 for
 * `false` would repeat the mistake the field exists to avoid.
 */
export interface ActionChoiceItem {
  readonly value: string
  readonly label: string
  readonly count: number | null
  readonly costsSomething: boolean | null
}

/**
 * The choices for one field, or why there are none.
 *
 * **A union rather than a list that can be empty**, because the two readings must not collapse: an
 * account holding nothing and an account we could not ask about are different sentences, and an
 * empty list drawn for both is how a person concludes their backpack is empty when the truth is
 * that their session expired.
 */
export type ActionChoice =
  | { readonly kind: 'ok'; readonly items: readonly ActionChoiceItem[] }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * One thing read live about one Target, as the task page reads it.
 *
 * `name` is a stable key the page never renders, `label` says what the fact is about — 「形象」,
 * 「在用鱼饵」 — and `value` is the fact itself as a sentence. **No identifier travels in `value`**: the
 * Room's own id is on the page already, and what these carry is states and quantities.
 *
 * Its sibling `ActionChoice` is the one that is *stored* and re-used by every Task naming an action;
 * this one is read for the Room in front of a person and stored nowhere, which is why the route behind
 * it is handed a Target and the one behind a choice is not.
 */
export interface TargetFact {
  readonly name: string
  readonly label: string
  readonly value: string
}

/**
 * What one read of a Target's own facts answered, or why there is none.
 *
 * **Three members rather than two**, and the third is what lets the page stay silent honestly: `none`
 * is "this build serves no such read for that action", which is a different answer from a read that
 * failed — a page drawing the failure sentence for it would be blaming a read nobody wired. The first
 * two are `ActionChoice`'s own pairing, for its own reason: an account we could not ask about and a
 * Room with nothing set are opposite facts that look identical as a blank.
 */
export type TargetFactRead =
  | { readonly kind: 'ok'; readonly items: readonly TargetFact[] }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'none' }

/**
 * One action's stored options as a plain map, whatever was stored.
 *
 * The field is `unknown` because the shape belongs to the action, so every reader has to narrow it
 * first — and a reader that did not would throw on the `null` a person can genuinely store through
 * the API. Both of these return a fresh object and never the stored one: a form must not be able to
 * write through to a value the store still holds.
 */
export function flattenOptions(options: unknown): Record<string, unknown> {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return {}
  return { ...options }
}

/* ------------------------------- tasks ------------------------------- */

/** Values of `tasks.status`, mirrored from the server's enum. */
export const TaskStatus = {
  Waiting: 'waiting',
  Offline: 'offline',
  Running: 'running',
  Paused: 'paused',
  Done: 'done',
  Canceled: 'canceled',
  Failed: 'failed'
} as const
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus]

/**
 * Human labels for each status, used by the badges.
 *
 * **`done` says the window ended, because that is the whole of what the code means by it.** The
 * scheduler reaches `done` through one path only — `decide`'s `finish`, taken when `now >= endTime`,
 * for either executor — so a Send task that sent 40 of its 100 bullets is `done` the moment its
 * window closes, and a reconcile Task whose action never settled today is `done` too. 「已完成」
 * claimed more than that: on the Send row it read as "the work finished", and on a reconcile row it
 * collided with the day's own question, which is asked and answered elsewhere (「今日已完成」, from
 * `settledTodayKeys`). Two questions, two words — this one names the window.
 */
export const TASK_STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  waiting: '等待开始',
  offline: '等待开播',
  running: '运行中',
  paused: '已暂停',
  done: '时间窗已结束',
  canceled: '已取消',
  failed: '已失败'
}

/** Naive UI tag types, so the badge colour follows the status. */
export const TASK_STATUS_TAG: Readonly<Record<TaskStatus, 'default' | 'info' | 'success' | 'warning' | 'error'>> = {
  waiting: 'default',
  offline: 'info',
  running: 'success',
  paused: 'warning',
  done: 'default',
  canceled: 'error',
  failed: 'error'
}

export interface TaskProgress {
  /** Index of the next bullet to send. Send tasks only. */
  readonly cursor: number
  /** Completed passes over the library. Send tasks only. */
  readonly loopCount: number
  readonly sentCount: number
  readonly successCount: number
  readonly failCount: number
  readonly libraryTotal: number | null
  readonly bulletIndex: number
  /** Percentage through the current pass, 0-100. */
  readonly percentInLoop: number
  readonly remainingInLoop: number | null
}

export interface Task {
  readonly id: number
  readonly userId: number
  readonly platform: string
  readonly accountId: number
  readonly libraryId: number | null
  /** The executor. `send` and `reconcile` render differently. */
  readonly action: TaskAction
  /** The concrete action on that Platform; its `label` comes from the catalogue. */
  readonly actionKey: string
  /** Empty for an account-scoped action. */
  readonly targetKey: string
  readonly targetTitle: string
  readonly startTime: number
  readonly endTime: number
  readonly interval: number
  readonly status: TaskStatus
  readonly cursor: number
  readonly loopCount: number
  readonly sentCount: number
  readonly successCount: number
  readonly failCount: number
  readonly saltEnabled: boolean
  /**
   * The 等待开播 switch, and the only liveness gate a Task has.
   *
   * It had a twin on this shape — `monitorOnline`, taken by the create route from the body, stored, and
   * read by no line of any build — and the two were removed together, because wiring the second one would
   * have been the same rule with a second home. The column outlives it with its default; what does not is
   * a field a person could set and nothing would read.
   */
  readonly requireOnline: boolean
  readonly lastLiveStatus: number | null
  readonly lastCheckedAt: number | null
  readonly lastError: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** One action's outcome inside a reconcile run. Mirrors the server's `ActionOutcome`. */
export const ACTION_OUTCOME = {
  Done: 'done',
  Already: 'already',
  Skipped: 'skipped',
  Failed: 'failed',
  Blocked: 'blocked'
} as const
export type ActionOutcome = (typeof ACTION_OUTCOME)[keyof typeof ACTION_OUTCOME]

/**
 * Outcome names, worded so they read correctly as **counters over time**.
 *
 * Deliberately not phrased as "已完成" or "今天…": these labels are used for the
 * lifetime counters only, and the one place that answers "is today done" is the
 * `settledTodayKeys` line. Two vocabularies for two questions, so a reader cannot
 * mistake a history count for today's state.
 */
export const ACTION_OUTCOME_LABEL: Readonly<Record<ActionOutcome, string>> = {
  done: '完成',
  already: '无需处理',
  skipped: '跳过',
  failed: '失败',
  blocked: '受阻'
}

export const ACTION_OUTCOME_TAG: Readonly<Record<ActionOutcome, 'default' | 'info' | 'success' | 'warning' | 'error'>> =
  {
    done: 'success',
    already: 'default',
    skipped: 'info',
    failed: 'error',
    blocked: 'warning'
  }

/**
 * Whether an outcome is one the day has **not** settled on, and therefore one a row must mark.
 *
 * **Derived from the settled set, not from the unsettled two**, which is the direction the server reads
 * it in and the direction this had backwards. The authority is `server/src/repo/action-logs.ts`: its
 * `isSettledOutcome` answers over the **stored** value, with `done`, `already` and `skipped` as the
 * settled three, and every other stored value is read through `toOutcome`, which maps one this build does
 * not recognise to `failed`. So the rule in one clause is "settled iff it is one of those three", and a
 * value outside them is unsettled here for the same reason it is unsettled there.
 *
 * **The comment here used to describe the opposite, and the two spellings disagreed on exactly the input
 * that matters.** It reported `settledActionKeysSince` as an `outcome NOT IN (failed, blocked)` — SQL that
 * no longer exists — and promised that a sixth outcome would land on the same side of the line in both
 * places. After the server was repaired it did not: an unrecognised value became `failed` ⇒ unsettled
 * there, while a two-literal test here called it settled. Inverting the derived set is the fix, and it is
 * the reason this is written as the three rather than as their complement.
 *
 * The settled three need no mark because every list that shows them sits under a heading that has already
 * said so: 「今日已完成」 above today's rows, and a counted day heading above an earlier day's. Four
 * identical 「无需处理」 tags down a column, each of them repeating that heading, is why this exists.
 *
 * A judgment about presentation and nothing else: the outcome labels stay as they are for the counters,
 * which really do count outcomes. `unknown` rather than `ActionOutcome` because what it judges is a value
 * read back from storage — the column holds text, and a build that wrote an outcome this one does not
 * know is exactly the case the direction above is about.
 */
const SETTLED_OUTCOMES: ReadonlySet<string> = new Set([
  ACTION_OUTCOME.Done,
  ACTION_OUTCOME.Already,
  ACTION_OUTCOME.Skipped
])

export function isUnsettledOutcome(value: unknown): boolean {
  return typeof value !== 'string' || !SETTLED_OUTCOMES.has(value)
}

/**
 * Whether a stored value names one of the five.
 *
 * `Object.values<string>` rather than a `readonly string[]` annotation, which is the idiom
 * `server/src/repo/action-logs.ts`'s `isActionOutcome` carries for the same question: a widened array
 * makes `.includes` accept anything, and the answer then has to be asserted back with an `as` the check
 * had just earned.
 */
function isKnownOutcome(value: string): value is ActionOutcome {
  return Object.values<string>(ACTION_OUTCOME).includes(value)
}

/**
 * One stored outcome's word and its mark.
 *
 * Derived from the two tables rather than spelled again: the tag's own union of naive-ui types has one
 * home, and a second copy of it is how the two get to disagree the day a sixth outcome arrives.
 */
type OutcomeWords = {
  readonly label: string
  readonly tag: (typeof ACTION_OUTCOME_TAG)[ActionOutcome]
}

/**
 * One **stored** outcome's word and mark — the display half of the boundary `isUnsettledOutcome` judges.
 *
 * `ACTION_OUTCOME_LABEL` and `ACTION_OUTCOME_TAG` are keyed by the five's own type, so a value read back
 * from storage that is not one of them indexed them as `undefined`: a record row drew a tag containing
 * nothing, `dayTitle` counted a record with no word for it, and the debug panel drew an empty tag — on
 * precisely the value this module calls unsettled. The server reads that value as `failed` by its own
 * rule (`toOutcome`, whose comment is "an unrecognised value degrades to `failed` rather than to a
 * success"), `summarizeActionLogs` derives its `failed` as the remainder so the counters already count it
 * that way, and the server's own screens print 「失败」. So the fallback is that same word and that same
 * mark: a value this build cannot name reads the way the rest of the system already reads it, rather than
 * as a third spelling of one fact — and no cell on the page is left holding nothing.
 *
 * **Word and mark together, because here they are one judgement.** A tag is drawn on an unsettled outcome
 * and no other, which is what `isUnsettledOutcome` is for, so a row reading 「失败」 under the neutral
 * colour the settled values use would be the same half-truth the word exists to remove.
 *
 * `unknown` for the same reason `toOutcome` takes it — this is what the column holds — and the mapping
 * from a raw value to one of the five belongs here once rather than at each reading site.
 */
export function describeOutcome(value: unknown): OutcomeWords {
  const outcome = typeof value === 'string' && isKnownOutcome(value) ? value : ACTION_OUTCOME.Failed
  return { label: ACTION_OUTCOME_LABEL[outcome], tag: ACTION_OUTCOME_TAG[outcome] }
}

/**
 * Per-outcome counters over a reconcile task's `action_logs`.
 *
 * Counts the task's whole history. The server derives `failed` as the remainder,
 * so the parts always add up to `total`, and an outcome a newer build wrote is
 * counted the way it is displayed.
 */
export interface ActionLogSummary {
  readonly total: number
  readonly done: number
  readonly already: number
  readonly skipped: number
  readonly failed: number
  readonly blocked: number
}

/** The summary's nonzero outcomes, in the order the server declares them. */
export function actionLogRows(summary: ActionLogSummary): {
  outcome: ActionOutcome
  label: string
  tag: 'default' | 'info' | 'success' | 'warning' | 'error'
  count: number
}[] {
  const rows: {
    outcome: ActionOutcome
    label: string
    tag: 'default' | 'info' | 'success' | 'warning' | 'error'
    count: number
  }[] = []
  for (const outcome of [
    ACTION_OUTCOME.Done,
    ACTION_OUTCOME.Already,
    ACTION_OUTCOME.Skipped,
    ACTION_OUTCOME.Failed,
    ACTION_OUTCOME.Blocked
  ] as const) {
    const count = summary[outcome]
    if (count > 0) rows.push({ outcome, label: ACTION_OUTCOME_LABEL[outcome], tag: ACTION_OUTCOME_TAG[outcome], count })
  }
  return rows
}

/**
 * One thing a reconcile action was about.
 *
 * Mirrors `ActionItem` in `server/src/platform/types.ts`. The label is the only
 * human-facing name an action's detail has — 「斗鱼官方手游区」, 「客户端签到」 — and it
 * is never an identifier: the Platform's own `code` is, and it belongs to the debug
 * section and nowhere else.
 */
export interface ActionItem {
  readonly kind: ActionItemKind
  readonly label: string
  readonly outcome: ActionOutcome
  readonly detail: string
  readonly code: string
}

/** Which kind of thing an item is about. Mirrors the server's union field for field. */
export type ActionItemKind = 'room' | 'group' | 'account'

/**
 * Words for the three kinds, shown as the item's glyph title.
 *
 * A label per kind rather than one generic word: 「版块」 and 「直播间」 are what tell a
 * person that a 鱼吧 sign-in and a danmaku send are different sorts of thing, which is
 * the whole reason the item carries a kind at all.
 */
export const ACTION_ITEM_KIND_LABEL: Readonly<Record<ActionItemKind, string>> = {
  room: '直播间',
  group: '版块',
  account: '账号'
}

/**
 * Whether an item is the action itself rather than one of the things it acted on.
 *
 * An account-scoped action has exactly one item and both adapters name it from the very
 * catalogue entry the action is named from — `accountOutcome` in the Douyu adapter,
 * `roomOutcome` in Bilibili's — so for those records the two labels are the same string by
 * construction. That equality is the whole signal: it is what lets a row say
 * 「客户端签到 连签 7 天」 instead of naming the action a second time and leaving the fact to a
 * sentence of its own.
 *
 * A name that does not match is not a failure — it is a record whose items really are separate
 * things (「主版块」, 「斗鱼官方手游区」), which each keep their own name.
 */
export function itemNamesTheAction(item: ActionItem, actionLabel: string): boolean {
  return item.label === actionLabel
}

/**
 * One reconcile run's record for one action.
 *
 * Mirrors `ActionLog` in `server/src/repo/action-logs.ts`. `actionKey` and `code` are
 * machine words — `sign_in`, `356` — so the debug section is the only place either is
 * rendered; everything else reads `detail` and `items`.
 */
export interface ActionLog {
  readonly id: number
  readonly taskId: number
  readonly actionKey: string
  readonly targetKey: string
  readonly outcome: ActionOutcome
  readonly detail: string
  readonly code: string
  /** What the action was about. Empty for a run that could name nothing. */
  readonly items: readonly ActionItem[]
  readonly at: number
}

/**
 * One Platform day's earlier records, as the server grouped them.
 *
 * The grouping is the server's because the day boundary is the Platform's: a record
 * written at 23:30 CST belongs to that CST day, and a browser in another timezone
 * that split the list itself would file it under another one.
 */
export interface ActionLogDay {
  /** `YYYY-MM-DD` on the Platform's own day boundary. */
  readonly dayKey: string
  /** The instant that day began, for labelling and ordering. */
  readonly startedAt: number
  readonly records: readonly ActionLog[]
}

/** A task as returned by the list and detail endpoints. */
export interface TaskWithProgress extends Task {
  readonly progress: TaskProgress
  /**
   * Counters over the task's `action_logs`, for a reconcile task.
   *
   * **Whole history, not today.** It counts every row the task ever wrote, so it
   * answers "how often has this run, and how did it go" — it must never be read as
   * "is today done". A task that ran yesterday and has not run today has a healthy
   * summary while today is untouched, which is the exact confusion today's field
   * exists to remove.
   */
  readonly actionLogSummary?: ActionLogSummary
  /**
   * The action keys that already reached a settled outcome on the Platform's
   * current day, ascending and de-duplicated.
   *
   * Present only on a **reconcile** task's payload; a send task has no settled
   * outcomes, so both this and `actionLogSummary` are absent there. `failed` and
   * `blocked` are excluded by construction — those are the ones worth attempting
   * again — and the range is the Platform's own day, not the container's.
   *
   * It comes from the same query the scheduler uses to decide it need not ask the
   * Platform again, so what this UI says about today cannot drift from what the
   * scheduler does about it.
   */
  readonly settledTodayKeys?: readonly string[]
  /**
   * Today's records, oldest first, with the per-item detail each one carries.
   *
   * `settledTodayKeys` answers "did the action run"; this answers "what did it do" —
   * which 鱼吧 was signed, what the check-in awarded. Records rather than a projection
   * per action, because an action that ran three times today has three runs and the
   * day is the thing being explained.
   */
  readonly actionLogsToday?: readonly ActionLog[]
  /**
   * Everything before today's boundary, grouped into Platform days, newest first.
   *
   * The list endpoint answers with an **empty array** rather than with history: it is
   * polled every five seconds and its row shows today, so carrying up to two hundred
   * earlier records per task would buy nothing and be paid for on every poll. An empty
   * array therefore means "this payload was not asked for history", and the detail page
   * — which is asked — is where "this task has none" is answered.
   */
  readonly actionLogDays?: readonly ActionLogDay[]
}

/** What a reconcile task's day adds up to, decided from the payload and the one switch. */
export type ReconcileToday =
  | { readonly kind: 'done' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'switch-off' }
  /**
   * No verdict, and **which of the two things could not answer**, because they are not the same
   * sentence: `no-field` is a server that predates the field, `no-switch` is this process — the
   * catalogue has not loaded yet, or it does not know this Platform.
   */
  | { readonly kind: 'unknown'; readonly why: 'no-field' | 'no-switch' }

/**
 * Answers 「今日做完了吗」 for a reconcile task.
 *
 * **One action, so one question**: a reconcile Task runs exactly the action its own row names, so
 * "today" is whether that action's key is among the task's `settledTodayKeys`. Asking it about the
 * Platform's whole switched-on set — what this used to do — answers for actions this Task does not
 * run, which is how a row could read 「今日还有 2 个待办」 about chores that belonged to another Task.
 *
 * The switch is the other half and it is a different answer, not a missing one: an action nobody
 * switched on will not run however healthy the Task looks, which is why `switch-off` is reported as
 * itself rather than as "待办".
 *
 * `unknown` is the answer whenever the question cannot be answered: no `settledTodayKeys` (a server
 * that predates the field), or `null` for the switch because the catalogue has not loaded or does not
 * know that Platform. Both mean "no verdict", never a guess — an unresolved catalogue would otherwise
 * read as "no actions enabled", which is a real problem being reported falsely.
 *
 * **The two causes travel with the verdict rather than being merged**, because a caller that renders
 * one sentence for both ends up blaming the server for this process's own missing catalogue — which
 * is exactly what the row used to say, on the ordinary first paint, every time.
 */
export function reconcileTodayOf(
  actionKey: string,
  enabled: boolean | null,
  settledKeys: readonly string[] | undefined
): ReconcileToday {
  if (settledKeys === undefined) return { kind: 'unknown', why: 'no-field' }
  if (enabled === null) return { kind: 'unknown', why: 'no-switch' }
  if (!enabled) return { kind: 'switch-off' }
  return settledKeys.includes(actionKey) ? { kind: 'done' } : { kind: 'pending' }
}

/* ------------------------------ libraries ------------------------------ */

export interface Library {
  readonly id: number
  readonly userId: number
  readonly name: string
  readonly filename: string
  readonly rawChars: number
  readonly bulletCount: number
  readonly createdAt: number
}

export interface BulletPage {
  readonly total: number
  readonly bullets: readonly { readonly seq: number; readonly content: string }[]
}

export interface SendLog {
  readonly id: number
  readonly taskId: number
  readonly content: string
  readonly ok: boolean
  /**
   * The Platform's own code for this attempt, **as text**, and the runner's only source for it.
   *
   * Text rather than a number because a code is not arithmetic and not every Platform code is
   * numeric — the adapter grades some refusals itself and writes a symbolic one. The column behind it
   * is declared INTEGER, so `repo/send-logs.ts` reads it through `asText`: a numeric code arrives as a
   * number and a symbolic one as a string, and both have to survive the round trip.
   *
   * It used to be a literal `0` at the writer, which made 「失败 #0」 this page's answer to *every*
   * rejection — and `0` is the success code on both Platforms, i.e. the one value a failed row must
   * never show. The writer stores the Platform's answer now; see `sendResultOf` in `TaskDetailView`.
   */
  readonly code: string
  readonly error: string
  readonly at: number
}

/**
 * What the send-attempt table adds up to for one Task.
 *
 * **The whole retained table, not the page a view draws.** `summarizeSendLogs` is one `COUNT(*)` and one
 * `SUM(ok)` over every row the task still holds — retention bounds it and prunes it as new attempts
 * arrive — while `GET /api/tasks/:id/logs` answers the newest page of it beside these counters. A reader
 * that took the two as one range would be comparing a total with a sample.
 */
export interface LogSummary {
  readonly total: number
  readonly ok: number
  readonly failed: number
}

export interface ReplacementRule {
  readonly pattern: string
  readonly replacement: string
  readonly isRegex: boolean
}

/** A rule persisted in the user's library, as opposed to one typed into an import form. */
export interface StoredRule extends ReplacementRule {
  readonly id: number
  readonly enabled: boolean
  readonly createdAt: number
}

/** Segmentation knobs exposed in the import form. Mirrors `SegmentOptions`. */
export interface SegmentParams {
  readonly delimiters?: readonly string[]
  readonly softDelimiters?: readonly string[]
  readonly splitOnNewline?: boolean
  readonly minLength?: number
  readonly maxLength?: number
  readonly dedupe?: boolean
  readonly replacements?: readonly ReplacementRule[]
}

export interface SegmentStats {
  readonly inputChars: number
  readonly outputCount: number
  readonly droppedTooShort: number
  readonly droppedEmpty: number
  readonly deduped: number
  /**
   * Regex rules the segmenter refused, because the engine would have had to do exponential work on a
   * failing input.
   *
   * **Counted rather than swallowed**, and this form renders it: a rule that silently stops applying
   * is the one failure the pipeline cannot show anyone, and the guard behind this number deliberately
   * over-refuses (a pattern the engine could survive is refused too), so a person meeting it has to be
   * told — otherwise their rule simply disappears from the result.
   */
  readonly unsafeRulesSkipped: number
}

export interface SegmentSummary {
  readonly count: number
  readonly totalChars: number
  readonly minChars: number
  readonly maxChars: number
}

export interface PreviewResult {
  readonly ok: boolean
  readonly truncated: boolean
  readonly sampleChars: number
  readonly stats: SegmentStats
  readonly summary: SegmentSummary
  readonly bullets: readonly string[]
  readonly effectiveOptions: SegmentParams
}

/* ------------------------------- events ------------------------------- */

/** A record in the external-consumer event feed. */
export interface SystemEvent {
  readonly id: number
  readonly kind: string
  readonly severity: 'info' | 'warning' | 'error'
  readonly title: string
  readonly detail: string
  /**
   * Which Platform the event is about, as `accounts.platform` spells it.
   *
   * Empty when the event is about no Platform in particular. It is what lets the
   * activity list say *whose* session expired, which the title alone cannot do
   * once a second Platform is bound.
   */
  readonly platform: string
  readonly taskId: number | null
  readonly accountId: number | null
  readonly createdAt: number
}

/**
 * Human labels for event kinds, shown in the activity list.
 *
 * Keyed by `EventKind` as `server/src/repo/events.ts` declares it — the two
 * reconcile kinds included, because an unlabelled key would surface as raw
 * `action_blocked` in the list.
 */
export const EVENT_LABEL: Readonly<Record<string, string>> = {
  task_started: '任务开始',
  task_went_live: '目标开播',
  task_finished: '任务完成',
  task_failed: '任务失败',
  task_sending_trouble: '发送异常',
  action_failed: '动作失败',
  action_blocked: '动作受阻',
  session_expired: '登录失效',
  account_restricted: '账号受限',
  session_refreshed: '登录已续期',
  /**
   * Not a kind anything writes: the server degrades an unrecognised stored kind to
   * `other` rather than claiming it is one of the known ones. Labelled so the feed
   * says "we cannot name this" instead of showing a bare machine word — and it must
   * never be sent back as an event's kind.
   */
  other: '未知事件'
}

export function describeEventKind(kind: string): string {
  return EVENT_LABEL[kind] ?? kind
}

/** A long-lived credential for an external consumer. The plaintext is never listed. */
export interface ApiToken {
  readonly id: number
  readonly name: string
  readonly lastUsedAt: number | null
  readonly createdAt: number
}

/**
 * Fields a user may change on a paused task.
 *
 * Omitted fields keep their current value — the form sends only what changed.
 * None of them is Platform-shaped, so one patch type serves every action; the
 * form hides the ones an executor has no use for rather than sending them.
 */
export interface TaskEditPatch {
  readonly startTime?: number
  readonly endTime?: number
  readonly interval?: number
  readonly requireOnline?: boolean
  readonly saltEnabled?: boolean
}

export interface HealthInfo {
  readonly ok: boolean
  readonly uptimeSeconds: number
  readonly storage: string
}

/**
 * The liveness values the UI may see.
 *
 * `LiveStatus.Live`/`Offline` are the **normalised** values `ProbeResult` reports
 * on any Platform, which is what a task's `lastLiveStatus` carries. `Round` is
 * Bilibili's raw `2` and can only reach the UI through a freshly resolved
 * Target, never through a probe — the adapters fold it into "not live" before
 * the scheduler ever compares it.
 */
export const LiveStatus = {
  Offline: 0,
  Live: 1,
  Round: 2
} as const

export function describeLiveStatus(status: number | null): string {
  switch (status) {
    case LiveStatus.Live:
      return '直播中'
    case LiveStatus.Round:
      return '轮播中'
    case LiveStatus.Offline:
      return '未开播'
    case null:
      // Distinct from "unknown": the probe has not succeeded yet, which is a
      // different situation from a status the app does not recognise.
      return '尚未探测'
    default:
      return '未知'
  }
}
