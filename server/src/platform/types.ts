import type { ActionOutcome as ActionOutcomeValue } from '../repo/action-logs.js'
import type { TaskAction } from '../repo/tasks.js'

/**
 * The five-value outcome vocabulary, re-exported so an adapter can name the type
 * of `ActionItem.outcome` through the seam instead of reaching into `repo/**` for
 * it. It is the same five values `repo/action-logs.ts` declares; see
 * `ActionItem.outcome` below for why the two `ActionOutcome` names must be kept apart.
 */
export type { ActionOutcomeValue }

/**
 * The Platform seam.
 *
 * Everything platform-specific sits behind these interfaces. The scheduler, the
 * routes and the storage layer know only this much: an account, a target, an
 * action, and a typed outcome. Nothing above calls a Bilibili or Douyu function
 * directly, and nothing below knows which Platform it is serving.
 *
 * The shape is drawn from what the two Platforms actually turned out to need,
 * not from an idealised contract:
 *
 *  - **Credential handling differs.** Bilibili renews a cookie jar with a refresh
 *    token, and its renewal can be refused outright. Douyu has a composite token —
 *    five `acf_*` components declared for 6.125 days, not the seven days this repo
 *    once asserted — a device id that the danmaku socket needs, and an optional web
 *    session that the token itself does without. So credentials are an opaque JSON
 *    blob the adapter owns, never a shared struct.
 *  - **Action shapes differ.** A Send action consumes a library of text; a
 *    reconcile action is account-scoped and never touches one. `actionKey` is
 *    data, so a new action is a new adapter entry rather than a new column.
 *  - **Failure grading differs.** Douyu's `1002` and Bilibili's `-101` mean the
 *    same thing — the session is gone, stop the account — but the codes share
 *    nothing, so each adapter grades its own.
 */

/**
 * How a person types one of an action's options.
 *
 * Three kinds rather than "string or list", because the form's control is the whole of what a kind
 * decides — and because none of them is free-form JSON. **A field nobody can type is not ready to
 * be exposed**, so there is deliberately no `json` member: an option whose shape is a document is
 * an option the UI has no business rendering, and adding it here later would be the moment to argue
 * about it rather than to assume it.
 */
export type ActionOptionKind = 'text' | 'number' | 'choice'

/**
 * One value a choice-backed field offers.
 *
 * `value` is what the action is handed; `label` is the only half a person reads. The two are
 * separate because a choice's value is frequently an identifier the Platform assigned — Douyu's
 * gift ids are numbers — and no identifier may appear in user-visible text.
 */
export interface ActionOptionChoice {
  readonly value: string
  readonly label: string
}

/**
 * One knob an action reads, as the form needs it.
 *
 * `name` is the key the adapter reads out of `ReconcileContext.options`, so it is the option's whole
 * contract; `label` and `help` are what a person sees. `source` is set exactly when `kind` is
 * `choice`, and names where the choices come from: a Platform's answer to a live read, resolved
 * through `GET /api/action-settings/options`, which is the one route that turns a source into a
 * list. Nothing in a descriptor may carry the list itself, because a list of what an account
 * currently holds is not a fact a catalogue can know.
 */
export interface ActionOptionField {
  readonly name: string
  readonly label: string
  /** One sentence about the field, or `''` when the label already says everything. */
  readonly help: string
  readonly kind: ActionOptionKind
  /** The choice source. Present iff `kind` is `choice`. */
  readonly source?: string
}

/** What a Platform tells the UI it can do. */
export interface ActionDescriptor {
  /** Stable identifier stored on a task and in `action_settings`, e.g. `send_danmaku`. */
  readonly key: string
  /** Which executor runs it. `send` consumes Bullets; `reconcile` finishes chores. */
  readonly action: TaskAction
  /** Shown in the UI. */
  readonly label: string
  readonly description: string
  /**
   * True when running it costs the account something — Douyu's 打卡分鱼丸 spends
   * 200 鱼丸 to enter. Costly actions default to off and say so in the UI.
   */
  readonly costly: boolean
  /**
   * Needs a target (a Room). Account-scoped actions such as a check-in do not.
   *
   * **Orthogonal to `action`, and what that orthogonality is *for* changed with the rule that
   * replaced the shape filter.** It no longer selects work: a reconcile run carries the single action
   * its Task's own row names, decided by `reconcileSelectionFor` in `scheduler/logic.ts`, so nothing
   * here decides which chores a sweep attempts. What it decides now is whether a row **can** run its
   * own action at all — a `needsTarget` action handed an empty target, or an account-scoped one handed
   * a Room, is reported `failed` (`missing_target`, `unexpected_target`) rather than quietly
   * reinterpreted — and it is what the create path and the switches screen ask to know whether a
   * Target has to be chosen, and how to say in a person's words what the action is aimed at.
   *
   * **It is also still why a per-Room chore and an account-scoped one are different rows.** A Task
   * carries one Target, so an action that needs one needs a Task per Target, while an account-scoped
   * action needs exactly one Task per account with an empty key — Bilibili's 点赞 and 观看直播 are per
   * Room, its 点亮粉丝牌 is not, and all three are Reconcile actions. That is the Target half of the
   * create-or-get key `(Platform, target, action)`, and dropping it as redundant would hand a second
   * room the first room's row.
   *
   * It is not a second name for "does this action send text": that is `needsLibrary`, and it only
   * coincides with the Send actions today. Folding the three fields into one rule ("a reconcile action
   * needs no target") deletes a whole class of chore, so they stay separate facts.
   */
  readonly needsTarget: boolean
  /** Needs a Library of Bullets. Only Send actions do. */
  readonly needsLibrary: boolean
  /**
   * The Platform's own cap on one message, in characters.
   *
   * It belongs here rather than in the scheduler because it differs per Platform
   * and per account tier — Bilibili allows 20 for an ordinary account and 30 for
   * a 大航海 — and the salt step needs it to know how much room it has left.
   */
  readonly maxMessageLength: number
  /**
   * The knobs this action reads out of `ReconcileContext.options`, in the order a form
   * should render them. Absent when the action reads none.
   *
   * **The same argument as every other field here, applied to `options`.** Each of them is one
   * sentence the adapter wanted told better, and this one is the field that makes `options`
   * *settable*: until it existed, an option could only be written by hand through the API, because
   * the UI had nothing to build a control from. Absent rather than empty so "this action reads
   * nothing" and "this action reads a list that turned out to be empty" are two different readings,
   * and a descriptor written before this field existed stays valid.
   *
   * The declared fields are the **form's** vocabulary, never the safety boundary: an adapter reads
   * `options` and refuses whatever its own rule does not allow, so an option the form cannot
   * express makes an action do *less*, never more. `web/src/views/ActionSettingsPanel.vue` says so
   * where a person can read it.
   */
  readonly optionFields?: readonly ActionOptionField[]
  /** A sensible cadence, in seconds, for a newly created task. */
  readonly defaultIntervalSeconds: number
  /**
   * The fastest this action may be scheduled, in seconds. A hard floor.
   *
   * It lives here, and not in the route, because it is a Platform fact: Bilibili
   * answers `10031` when danmaku arrive too fast, and Douyu was measured at a floor
   * of roughly two seconds. The route used to carry one global floor of 10s, which
   * was wrong in both directions — it forbade Douyu's measured-safe 3s, and it
   * permitted a 1s Bilibili task that could only ever be rejected and retried
   * forever. Guarding a Platform's cadence is the Platform's business; the route
   * only checks that the number is a positive integer.
   */
  readonly minIntervalSeconds: number
}

/**
 * How bad a failure is, in the only terms the scheduler cares about.
 *
 * `retry` keeps the loop alive; `action_stop` parks this action until the next
 * day; `account_stop` fails the task and raises a session event, because nothing
 * will work again until a person re-binds the account.
 *
 * `account_restricted` fails the task exactly as `account_stop` does — as a verdict on
 * the account the two are one thing, "nothing this account attempts will land until a
 * person acts" — and differs from it **only in what the person is told**, which is itself
 * a thing the scheduler cares about. Re-binding is the remedy for an expired session and
 * useless for an account the Platform is refusing, so a restriction reported as
 * `account_stop` sends someone to re-bind an account that is already bound, and reports
 * success when they do it. Adapters grade a credential problem `account_stop` and a
 * restriction `account_restricted`; nothing else separates the two.
 */
export type FailureKind = 'none' | 'retry' | 'action_stop' | 'account_stop' | 'account_restricted'

export interface SendOutcome {
  readonly ok: boolean
  /** The Platform's own code, as a string so both numeric and symbolic codes fit. */
  readonly code: string
  readonly detail: string
  readonly failure: FailureKind
}

/**
 * One thing an action was about, as the Platform reported it.
 *
 * A record is the run; an item is what the run touched. A 鱼吧 walk signs thirty
 * groups and reports one outcome for the key and thirty items for the groups, so
 * "which one failed" is answerable without reading a console line — and an item
 * whose `outcome` disagrees with the record it sits inside is worse than no item
 * at all, which is why adapters build both from the same value.
 */
export interface ActionItem {
  /** Which kind of thing this item is about — decides the icon in the UI. */
  readonly kind: 'room' | 'group' | 'account'
  /** Human-facing name: 「斗鱼官方手游区」, 「客户端签到」. Never an identifier. */
  readonly label: string
  /**
   * One of the five outcome values already in `repo/action-logs.ts`.
   *
   * **The name collides with this file's `ActionOutcome` and the two are not the
   * same thing.** `ActionOutcome` (here) is the whole result of one action —
   * key, target, outcome, detail, code, failure grade and items. `ActionOutcome`
   * (`repo/action-logs.ts`) is the five-value vocabulary a result's `outcome`
   * field is spelled from, and the only home those five values have. It is
   * imported here as `ActionOutcomeValue` so that neither name can be read as the
   * other at a call site; this field and `ActionOutcome.outcome` below are both it.
   */
  readonly outcome: ActionOutcomeValue
  /** One sentence a person can read. */
  readonly detail: string
  /** The Platform's raw code, for the debug section only. Never rendered as-is in the main UI. */
  readonly code: string
}

/** One action's result inside a reconcile run. */
export interface ActionOutcome {
  readonly actionKey: string
  /** The Room or account the action was aimed at; empty for account-scoped ones. */
  readonly targetKey: string
  readonly outcome: ActionOutcomeValue
  readonly detail: string
  readonly code: string
  readonly failure: FailureKind
  /**
   * What this action was about, one entry per thing it touched.
   *
   * **Required, and an empty array is a statement**: an action with nothing to
   * name says so, while a missing field would leave "this Platform does not report
   * items" indistinguishable from "this run had none". The scheduler writes the
   * array straight to `action_logs.items`, so the two readings would also be the
   * difference between a UI that can explain a day and one that can only count it.
   */
  readonly items: readonly ActionItem[]
}

/** An account, as the adapters see it. `credentials` and `meta` are raw JSON. */
export interface PlatformAccount {
  readonly id: number
  readonly platform: string
  readonly externalId: string
  readonly displayName: string
  readonly avatar: string
  readonly credentials: string
  readonly meta: string
}

/** A target the Platform recognises, resolved from whatever a person pasted. */
export interface TargetInfo {
  readonly key: string
  readonly title: string
  readonly anchorId: string
  readonly anchorName: string
  /** The Platform's own liveness value; only meaningful for live-room targets. */
  readonly liveStatus: number
}

/**
 * The normalised "the streamer is actually streaming" value.
 *
 * Both Platforms report into it, and each keeps its own raw encoding to itself:
 * Bilibili's `2` is 轮播 — a replayed recording, not a live streamer — and Douyu's `2`
 * is an anchor who is not streaming at all. Folding both onto these two values is what
 * makes the scheduler's liveness test one comparison for every Platform, and a
 * constant per state is enough because the adapter has already done the translating by
 * the time the result is written.
 *
 * `scheduler/logic.ts` still carries its own `LIVE_STATUS_LIVE`; it should import this
 * name instead.
 */
export const LIVE_STATUS_LIVE = 1

/** The complement, written at every adapter's normalisation point. */
export const LIVE_STATUS_OFFLINE = 0

/**
 * One liveness probe.
 *
 * Graded the same way as a send, not returned as a bare number: a probe is
 * exactly where an expired session usually surfaces first, and the old code
 * detected that by searching the error *message* for `-101`. Making the probe
 * report `FailureKind` is what lets the scheduler stop doing that.
 */
export interface ProbeResult {
  readonly ok: boolean
  /**
   * **Normalised by the adapter**: `LIVE_STATUS_LIVE` when the target is live,
   * `LIVE_STATUS_OFFLINE` when it is not. Bilibili's raw value also has a `2` for
   * "replaying a recording", which is not live; Douyu has its own encoding entirely.
   * Normalising here means the scheduler's liveness test is one comparison for every
   * Platform.
   */
  readonly liveStatus: number
  readonly title: string
  readonly code: string
  readonly detail: string
  readonly failure: FailureKind
}

export interface ReconcileContext {
  readonly account: PlatformAccount
  /** The task's target; empty for account-scoped actions. */
  readonly targetKey: string
  /** Only these action keys may run — the switchboard decides, not the adapter. */
  readonly enabledActions: readonly string[]
  /**
   * Each enabled action's own options, keyed by action key, already parsed.
   *
   * **Who is authoritative, in one direction.** `action_settings` is the only store, `runner.ts` is
   * the only reader, and an adapter only consumes what it is handed — so a knob a person set on a
   * switch is what the action runs with. Nothing above the seam interprets what an option *means*:
   * the values are the Platform's own shape, which is why `ActionDescriptor` describes no options
   * for the route to validate and why the route stores whatever the client sent.
   *
   * **Every key in `enabledActions` has an entry, and every entry is an object.** An action nobody
   * set anything on carries `{}` rather than nothing, because "no options" is a state an adapter has
   * to read a decision from: a field that could be absent would make every consumer spell `?? {}`
   * and one of them would forget, which is how a setting that can be changed ends up silently
   * ignored. `{}` also keeps the one reading an adapter needs possible — "I was given nothing to
   * work with" — where an absent field would blur it into "this Platform has no such switch".
   */
  readonly options: Readonly<Record<string, unknown>>
  readonly now: number
  /** `YYYY-MM-DD` on the Platform's own day boundary. See `dayKeyOf`. */
  readonly dayKey: string
  readonly log: (line: string) => void
}

export interface RefreshResult {
  readonly status: 'not_required' | 'refreshed' | 'relogin_required' | 'failed'
  readonly detail: string
  /** Present only when the credential actually changed, so the caller can persist it. */
  readonly credentials?: string
}

export interface Platform {
  /** `bilibili` | `douyu`. Stored on accounts and tasks; never shown raw in the UI. */
  readonly key: string
  /** Human-facing name. */
  readonly label: string
  /**
   * The full action catalogue. A person switches these on individually, and the
   * scheduler reconciles this list against `action_settings` — which is why the
   * list lives here rather than in the database.
   */
  readonly actions: readonly ActionDescriptor[]

  /** Turns pasted input (a room URL, a slug, an id) into a target. */
  resolveTarget(input: string): Promise<TargetInfo>

  /** One liveness probe, for actions that need a live room. */
  probe(account: PlatformAccount, targetKey: string): Promise<ProbeResult>

  /** Executor: `send`. One message. */
  send(account: PlatformAccount, targetKey: string, text: string): Promise<SendOutcome>

  /**
   * Executor: `reconcile`. One entry per action it attempted.
   *
   * **A transport failure is graded per action and never thrown past this member.** One action's
   * network blip must not take the run's other results with it: the caller writes whatever comes
   * back, so a throw here loses the whole run — including an action that had already finished its
   * work — and leaves no row behind for anyone to read. Each adapter grades its own transport the
   * way it grades its own codes (`retry`, normally, because the next sweep is a fresh attempt);
   * `bilibili/index.ts` folds every read of both its actions through one `readGraded` helper for
   * exactly this reason. An adapter that lets a throw escape is not conforming to this seam, and a
   * new adapter author copying one that does inherits the defect.
   */
  reconcile(context: ReconcileContext): Promise<ActionOutcome[]>

  /**
   * Credential upkeep, when the Platform can do it without a person.
   *
   * Optional on purpose, and the status worth reading before implementing it is
   * `relogin_required`: it means the credential has to be re-bound by a person **because the
   * renewal cannot happen** — either the Platform refused the exchange it was asked to
   * perform (Bilibili's `/cookie/refresh` rejecting a token it will not accept), or the
   * adapter holds nothing it could present for one, which is Bilibili's two local cases (a
   * blob that does not parse, a jar with no `bili_jct`). It is the only status the scheduler
   * turns into a 「登录已失效」 event, so it is a claim about a credential and never a guess
   * about one: it is answered where the renewal cannot happen, and never as a declaration that
   * a credential is dead by arithmetic on a date — that verdict is the server's to give. Douyu
   * rebuilds its `acf_*` family from `LTP0`, so it answers `relogin_required` only when there is
   * nothing to present for that exchange, and a token it has no signal to judge is left to the
   * server's own `-101` on the action paths while the action that needs a web session reports
   * its absence in its own terms.
   */
  refresh?(account: PlatformAccount): Promise<RefreshResult>
}
