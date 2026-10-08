/**
 * Scheduling decision logic.
 *
 * Deliberately pure functions with no clock, database or network access: the rules
 * for what a task does with its turn — should it send right now, which action a
 * reconcile run carries — are the part most likely to have subtle bugs
 * (off-by-one on the time window, a monitor loop that never
 * promotes to running, a cooldown that fires early), and keeping them pure
 * makes every one of those cases a table-driven unit test instead of a live
 * service experiment.
 *
 * This module knows nothing about any Platform. Liveness arrives already
 * normalised — see `ProbeResult.liveStatus` in `platform/types.ts` — so the old
 * import of Bilibili's `LiveStatus` enum is gone; Bilibili's `2` (a replayed
 * recording, which is not live) is folded into `0` by its adapter.
 *
 * `LIVE_STATUS_LIVE` is imported rather than declared here, and that direction
 * matters: it is a value every **adapter** reports into, so it belongs to the seam,
 * not to the scheduler that happens to test it. Declaring it locally is how the same
 * fact ends up with two homes — which is what happened, briefly.
 *
 * `TaskAction` is two different things and the collision is pre-existing: this module's own is
 * the scheduling decision (`wait`/`finish`/`monitor`/`cooldown`/`send`) while the repository's is
 * the executor selector every descriptor carries (`send`/`reconcile`). The repository's is
 * imported as `TaskExecutor` so neither can be read as the other at a call site.
 */

import { type ActionDescriptor, type ActionOutcomeValue, LIVE_STATUS_LIVE } from '../platform/types.js'
import { TaskAction as TaskExecutor } from '../repo/tasks.js'

export type TaskAction =
  /** Before `start_time`. Nothing to do but wait. */
  | { readonly kind: 'wait' }
  /** Past `end_time`. The task is finished. */
  | { readonly kind: 'finish' }
  /** In-window, but the room is not live (or its status is unknown) — poll it. */
  | { readonly kind: 'monitor' }
  /** In-window and live, but the send interval has not elapsed yet. */
  | { readonly kind: 'cooldown'; readonly remainingMs: number }
  /** In-window, live, interval elapsed — send one bullet. */
  | { readonly kind: 'send' }

export interface DecisionInput {
  /** Current time, milliseconds since epoch. */
  readonly now: number
  readonly startTime: number
  readonly endTime: number
  /** Seconds between sends. */
  readonly interval: number
  /** Timestamp of the last successful-or-attempted send; null if never. */
  readonly lastSentAt: number | null
  /** When false, the task sends regardless of live status. */
  readonly requireOnline: boolean
  /** Last observed live status, or null when it has never been checked. */
  readonly liveStatus: number | null
}

/**
 * Decides what a task should do right now.
 *
 * Ordering is significant:
 *   1. the time window is checked first, so a task whose window closed while
 *      offline is still marked finished;
 *   2. online gating comes next, because monitoring is cheaper than sending and
 *      we would rather poll than fire into an empty room;
 *   3. the interval check comes last, so a task that just went live sends
 *      immediately instead of waiting out a cooldown inherited from before.
 */
export function decide(input: DecisionInput): TaskAction {
  if (input.now < input.startTime) return { kind: 'wait' }
  if (input.now >= input.endTime) return { kind: 'finish' }

  if (input.requireOnline && !isRoomLive(input.liveStatus)) {
    return { kind: 'monitor' }
  }

  if (input.lastSentAt !== null) {
    const intervalMs = Math.max(0, input.interval) * 1000
    const elapsed = input.now - input.lastSentAt
    if (elapsed < intervalMs) {
      return { kind: 'cooldown', remainingMs: intervalMs - elapsed }
    }
  }

  return { kind: 'send' }
}

/**
 * What one run does with the Action its Task names when it cannot run it.
 *
 * `run` is the ordinary answer. `unknown` is a row this build cannot serve at all. `stopped` is a
 * row that could run and did not, together with the record to write down for it — which is the
 * whole point of the third case, because a row that silently does nothing is indistinguishable
 * from a row with nothing to do.
 */
export interface StandingReport {
  readonly actionKey: string
  readonly outcome: ActionOutcomeValue
  /** A symbolic code for the debug section: `switch_off`, `missing_target`, `unexpected_target`. */
  readonly code: string
  /** One sentence naming what is wrong, in the same words the settings screen uses. */
  readonly detail: string
}

export type ReconcileSelection =
  | { readonly kind: 'run'; readonly actionKey: string }
  /** The catalogue does not declare this key as a Reconcile action, so nothing here can run it. */
  | { readonly kind: 'unknown'; readonly actionKey: string }
  | { readonly kind: 'stopped'; readonly report: StandingReport }

/**
 * The record for a switch that is off, in the one spelling both executors use.
 *
 * Exported because the send executor needs the same three fields and the same sentence: an Action
 * switch gates the running of a Task, not merely its creation, and two executors reporting the same
 * condition in two vocabularies is how the settings screen ends up unable to explain one of them.
 * `blocked`/`switch_off` and the wording are the ones `reconcileSelectionFor` has always produced —
 * copied from it rather than invented, so a reader who knows one channel knows both.
 *
 * `skipped` would be the tempting choice and it is the wrong one: it means "not applicable this run",
 * which is settled — the settled set is `done`, `already` and `skipped`, judged by `isSettledOutcome` in
 * `repo/action-logs.ts` — so a switched-off action marked that way would freeze its own day: flipping the
 * switch on at noon would change nothing until the Platform's next day. `blocked` means "parked, and
 * worth attempting again", which is what a switch that is off is.
 */
export function switchOffReport(descriptor: ActionDescriptor): StandingReport {
  return {
    actionKey: descriptor.key,
    outcome: 'blocked',
    code: 'switch_off',
    detail: `动作开关「${descriptor.label}」没有打开，这个任务不会跑。`
  }
}

/**
 * Why a Task cannot run the Action it names, judged **without asking which executor would run it**.
 *
 * `null` means "the row and its Action agree, and the switch is on". Anything else is the report to
 * write down. This is the half of the rule that is a fact about the **action** — the switch, and
 * whether the Task's own target agrees with `needsTarget` — and it is separated out because a screen
 * asking "which of my Tasks would run this action" has no business knowing that one executor
 * reconciles while another sends: both name their action and both are gated the same way. The
 * executor is what `reconcileSelectionFor` adds on top.
 *
 * A mismatch is judged before the switch, and it is `failed` rather than `blocked`: nothing about
 * waiting fixes it, the row itself has to be replaced, and `failed` is the outcome the UI and the
 * event feed already treat as "this needs a person". Saying "the switch is off" about such a row
 * would send somebody to flip a switch and watch nothing change.
 */
export function actionStopFor(
  descriptor: ActionDescriptor,
  task: { readonly actionKey: string; readonly targetKey: string },
  enabled: boolean
): StandingReport | null {
  const hasTarget = task.targetKey !== ''

  if (descriptor.needsTarget && !hasTarget) {
    return {
      actionKey: descriptor.key,
      outcome: 'failed',
      code: 'missing_target',
      detail: `动作「${descriptor.label}」是对着目标做的，但这个任务没有目标，所以它不会跑。删掉它，再按目标建一个。`
    }
  }

  if (!descriptor.needsTarget && hasTarget) {
    return {
      actionKey: descriptor.key,
      outcome: 'failed',
      code: 'unexpected_target',
      detail: `动作「${descriptor.label}」是围着账号做的，但这个任务带着目标，所以它不会跑。删掉它，再建一个不带目标的任务。`
    }
  }

  if (!enabled) return switchOffReport(descriptor)

  return null
}

/**
 * The one action a reconcile run carries, or why it carries none.
 *
 * **A Task names exactly one Action, and this is where that is decided.** The rule is one lookup:
 * the row's `actionKey` is the action, and no second notion of scope picks work. `actionKey` used
 * to be display only — the run carried *every* enabled key of the Task's shape — which is how a
 * Task whose row said 「动作：亲密度任务」 also ran 粉丝家园钓鱼: both are per-Room, so both matched
 * the shape, and the column a person created the Task by decided nothing. The row is now
 * authoritative, so the UI can no longer be telling its reader something untrue.
 *
 * **The shape check survives as a validation rather than as a filter.** `needsTarget` is a fact
 * about the action, and a Task whose own target disagrees with it cannot run that action: a
 * `needsTarget` action handed an empty target answers `failed` at the Platform, and an
 * account-scoped one handed a Room is refused by its own adapter guard. Neither is a reason to
 * choose different work — the work is named by the row — so this reports the mismatch instead of
 * quietly reinterpreting the Task. The create route refuses the first direction (a `needsTarget`
 * action with no target) and says nothing about the second, so the second is exactly the row a
 * person can still make by hand, and it is reported rather than accepted.
 *
 * **`blocked` is the outcome for a switched-off action, and the choice is load-bearing.** `skipped`
 * means "not applicable this run: nothing was outstanding", which is a settled outcome — `settledToday`
 * asks `isSettledOutcome` over the stored value, and settled is exactly `done`/`already`/`skipped`, while
 * `failed`, `blocked` and anything this build does not recognise (read as `failed`) are not. Reporting a
 * switch that is off as `skipped` would settle that action's day, so flipping the switch on at noon would
 * do nothing until the Platform's next day: the complaint this channel exists to answer, made worse by a
 * record that says the reason. `blocked` means "parked, and worth attempting again", which is
 * what a switch that is off is.
 *
 * The switch and the shape are `actionStopFor`, which is where they live for both executors; what is
 * left here — and the reason this function is not simply that one — is the **executor** half: only a
 * key the catalogue serves as a Reconcile action can be run by a reconcile run, and anything else is
 * `unknown` rather than a refusal, because a row naming a send action is not a row this executor
 * could ever run.
 */
export function reconcileSelectionFor(
  descriptors: readonly ActionDescriptor[],
  task: { readonly actionKey: string; readonly targetKey: string },
  enabled: boolean
): ReconcileSelection {
  const descriptor = descriptors.find(candidate => candidate.key === task.actionKey)
  if (descriptor === undefined || descriptor.action !== TaskExecutor.Reconcile) {
    return { kind: 'unknown', actionKey: task.actionKey }
  }

  const report = actionStopFor(descriptor, task, enabled)
  if (report !== null) return { kind: 'stopped', report }

  return { kind: 'run', actionKey: descriptor.key }
}

/**
 * Whether a normalised status means "the streamer is actually streaming".
 *
 * The adapter has already done the Platform-specific work: Bilibili's `Round`
 * (2) means it is replaying a recording and nobody is in the room, and its
 * adapter folds that into `0` — treating it as live is the classic way a monitor
 * ends up spamming an empty channel at 3am.
 */
export function isRoomLive(status: number | null): boolean {
  return status === LIVE_STATUS_LIVE
}

/**
 * How long to wait before re-polling live status. Slower than the send
 * interval on purpose: live status changes on the order of minutes, and every
 * probe is an HTTP request against a rate-limited endpoint.
 */
export const MONITOR_POLL_INTERVAL_MS = 15_000

/**
 * Whether a monitor probe is due. Kept separate from `decide` because it
 * depends on `lastCheckedAt`, which the decision function deliberately does not
 * take (it only answers the sending question).
 */
export function shouldPollNow(lastCheckedAt: number | null, now: number, pollMs = MONITOR_POLL_INTERVAL_MS): boolean {
  if (lastCheckedAt === null) return true
  return now - lastCheckedAt >= pollMs
}

/**
 * Maps the current action onto the persisted task status, so the UI can show
 * "waiting for stream" rather than an indistinguishable "in progress".
 */
export function statusForAction(action: TaskAction): 'waiting' | 'offline' | 'running' | 'done' {
  switch (action.kind) {
    case 'wait':
      return 'waiting'
    case 'finish':
      return 'done'
    case 'monitor':
      return 'offline'
    case 'cooldown':
    case 'send':
      return 'running'
  }
}
