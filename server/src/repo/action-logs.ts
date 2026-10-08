import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

import { asNumber, asString } from '../db/values.js'
import { dayKeyOf, startOfPlatformDay } from '../platform/time.js'
import type { ActionItem } from '../platform/types.js'

/**
 * Per-action run log.
 *
 * `send_logs` is shaped for Bullets: content, ok, code, error. A reconcile run
 * has no Bullet — it has a list of actions the Platform either carried out,
 * already had, skipped, rejected, or parked — so its record is keyed by the
 * action and the target instead. That is what makes "为什么今天没签到" answerable
 * without reading the event feed.
 *
 * A record answers the run; `items` answers the run's parts, and the two are not
 * redundant. One 鱼吧 row says "3 个版块，新签 1、已签 2" while its items say which
 * three, so the detail a person actually wants — which one was skipped, what the
 * check-in awarded — survives in the database instead of existing only as a line
 * on the server's console.
 *
 * Bounded by retention like `send_logs`, and for the same reason: a reconcile
 * task on a short interval would otherwise be the first table to grow without
 * limit. `appendActionLog` prunes opportunistically.
 *
 * `ActionOutcome` here is the value-level counterpart of the `outcome` field of
 * `ActionOutcome` in `platform/types.ts` (the richer shape a reconcile executor
 * returns), so an entry can be logged straight from what the adapter reported
 * without a translation table in between. That file imports this type as
 * `ActionOutcomeValue` for the same reason: two names, two different things, and
 * `ActionItem.outcome` is spelled from this one.
 */

export const ActionOutcome = {
  /** The action ran and changed something — a check-in that succeeded. */
  Done: 'done',
  /** The Platform reported it as already done; a success, not a no-op. */
  Already: 'already',
  /**
   * This run found nothing of that action outstanding.
   *
   * **Not "the Platform confirmed there is nothing to do", which is what this said before and what
   * the producers do not mean.** The two live producers are both this build reading its own
   * answer: a 鱼吧 follow list that comes back empty is reported 「未关注任何版块」 (a sentence this
   * code wrote from an empty array, not one the Platform sent), and the 亲密度任务 **paid** row
   * (「送出“全力守护”礼物」, `taskType` 2) is reported by the same value — a 24-hour task this build refuses
   * to do at all, not one the Platform said nothing about. Both mean "nothing outstanding *from here*",
   * which is why the cadence may treat it as settled — but a caller that reads this as a Platform
   * verdict is reading a fact the Platform never stated. It covers "the action was not applicable",
   * and that is the wider of the two senses.
   *
   * **The paid row is the producer the sentence used to name wrongly, and it is worth the correction:**
   * this said "a 赠送礼物 row", which is `taskType` 3 and is the row this action *does* work on — it reports
   * `blocked` when the allowlist is empty or the backpack is short (`platform/douyu/index.ts`), never this
   * value. The two rows are one field apart in the capture (`taskWhiteGiftId` 24478 against 24468) and one
   * value apart here, which is exactly the kind of pairing a comment must not blur.
   */
  Skipped: 'skipped',
  /** Attempted and rejected. */
  Failed: 'failed',
  /** Parked by the Platform — a balance too small, an activity window shut. */
  Blocked: 'blocked'
} as const
export type ActionOutcome = (typeof ActionOutcome)[keyof typeof ActionOutcome]

export interface ActionLog {
  readonly id: number
  readonly taskId: number
  readonly actionKey: string
  /** The Room the action was aimed at; empty for account-scoped actions. */
  readonly targetKey: string
  readonly outcome: ActionOutcome
  readonly detail: string
  /** The Platform's own code, kept as text so numeric and symbolic codes both fit. */
  readonly code: string
  /** What this action was about, newest-written last. Empty for a run that named nothing. */
  readonly items: readonly ActionItem[]
  readonly at: number
}

/** Rows kept per task. Older entries are deleted as new ones arrive. */
export const ACTION_LOG_RETENTION_PER_TASK = 500

/** How often to attempt pruning, in writes. Pruning on every insert is wasteful. */
const PRUNE_EVERY = 50

let writesSincePrune = 0

/**
 * Whether a stored value names a member of `ActionOutcome`.
 *
 * `Object.values<string>` rather than the `readonly string[]` annotation this
 * used to carry: the widened array made `.includes` accept anything, so the
 * answer had to be asserted back with an `as` the check had just earned.
 */
function isActionOutcome(value: string): value is ActionOutcome {
  return Object.values<string>(ActionOutcome).includes(value)
}

/**
 * An outcome read back from storage.
 *
 * An unrecognised value degrades to `failed` rather than to a success: a row
 * written by a build that knew an outcome this one does not must never be
 * counted as "it worked".
 *
 * `unknown` rather than `SQLOutputValue | undefined` because this reads two
 * different things: a column, and an item's `outcome` inside a JSON document where
 * nothing has narrowed the value. Both answer the same way, which is the point —
 * an outcome is judged by the same rule wherever it was written down.
 */
function toOutcome(value: unknown): ActionOutcome {
  const raw = typeof value === 'string' ? value : ''
  return isActionOutcome(raw) ? raw : ActionOutcome.Failed
}

/**
 * The outcomes that mean the Platform's day is over for that action — **the one home of that
 * judgement**, and it is derived rather than spelled again in SQL.
 *
 * The question `settledActionKeysSince` asks is a question *about* the five values above, and it
 * used to be answered twice: by `outcome NOT IN (failed, blocked)` in that function's SQL, and by
 * `toOutcome`'s rule that a value this build does not recognise reads as `failed`. The two
 * spellings disagree about every value outside the five — a row written by a newer build was
 * displayed as a failure and counted as settled, in the same row of the same table — and the
 * disagreement is not cosmetic, because the consumer of the second spelling is `settledToday`,
 * which stops asking the Platform about that action for the rest of the day. Reading it through
 * `toOutcome` makes "is displayed as a failure" and "counts as settled" one judgement.
 *
 * `done`, `already` and `skipped` mean there is nothing outstanding to attempt again; `failed` and
 * `blocked` mean the opposite, and are exactly the two worth retrying.
 */
const SETTLED_OUTCOMES: readonly ActionOutcome[] = [ActionOutcome.Done, ActionOutcome.Already, ActionOutcome.Skipped]

/**
 * Whether one *stored* outcome, as a string that may be one this build has never seen, means the
 * day's work for that action is over.
 *
 * Takes `unknown` rather than `ActionOutcome` because that is what the column holds: the mapping
 * from a raw column value to an outcome has to happen somewhere, and it happens here, once, so a
 * caller cannot make the settledness judgement on a value `toOutcome` was never applied to — which
 * is the defect this replaced.
 *
 * **Not exported, and that is the repair rather than a style choice.** It was exported for a reader that
 * does not exist: the only caller is `settledActionKeysSince` below, and an export is a claim that
 * something outside this file needs it. The judgement still has exactly one home — this function — and
 * the interface derives it rather than restating it (`web/src/types/api.ts` cites it by name for exactly
 * that reason), so nothing is lost by keeping the name inside the module that owns the rule.
 */
function isSettledOutcome(value: unknown): boolean {
  return SETTLED_OUTCOMES.includes(toOutcome(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * One item read back from storage, or null when the entry is not shaped like one.
 *
 * Null drops the entry rather than failing the read: this column holds JSON, and a
 * single malformed item — written by a build whose shape this one does not know, or
 * by a half-finished write — must not turn a whole payload or a whole task page
 * into an error. An item is evidence about the run, never the run's own verdict.
 */
function toItem(entry: unknown): ActionItem | null {
  if (!isRecord(entry)) return null

  const kind = entry['kind']
  const label = entry['label']
  const detail = entry['detail']
  const code = entry['code']
  if (kind !== 'room' && kind !== 'group' && kind !== 'account') return null
  if (typeof label !== 'string' || typeof detail !== 'string' || typeof code !== 'string') return null

  return { kind, label, outcome: toOutcome(entry['outcome']), detail, code }
}

/** The `items` column, parsed. Anything unusable reads as "this run named nothing". */
function toItems(value: unknown): ActionItem[] {
  if (typeof value !== 'string') return []

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const entries: readonly unknown[] = parsed
  const items: ActionItem[] = []
  for (const entry of entries) {
    const item = toItem(entry)
    if (item !== null) items.push(item)
  }
  return items
}

function toLog(row: Record<string, SQLOutputValue>): ActionLog {
  return {
    id: asNumber(row['id']),
    taskId: asNumber(row['task_id']),
    actionKey: asString(row['action_key']),
    targetKey: asString(row['target_key']),
    outcome: toOutcome(row['outcome']),
    detail: asString(row['detail']),
    code: asString(row['code']),
    items: toItems(row['items']),
    at: asNumber(row['at'])
  }
}

export interface AppendActionLogInput {
  readonly taskId: number
  /** The concrete action this Platform run attempted, e.g. `sign_in`. */
  readonly actionKey: string
  /** Empty for account-scoped actions; the task's target is not implied. */
  readonly targetKey?: string
  readonly outcome: ActionOutcome
  readonly detail?: string
  readonly code?: string
  /**
   * The things the action was about, straight from the Platform's `ActionOutcome`.
   *
   * Optional here, and required there, for one reason: this module is a store. It
   * records what a caller hands it and does not go looking for an item list it was
   * not given — but a Platform that forgets to report them is the bug this column
   * exists to end, so the seam is where the field is mandatory.
   */
  readonly items?: readonly ActionItem[]
}

/** Records one action's result inside a reconcile run. */
export function appendActionLog(db: DatabaseSync, input: AppendActionLogInput, now = Date.now()): void {
  db.prepare(
    `INSERT INTO action_logs (task_id, action_key, target_key, outcome, detail, code, items, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.taskId,
    input.actionKey,
    input.targetKey ?? '',
    input.outcome,
    input.detail ?? '',
    input.code ?? '',
    JSON.stringify(input.items ?? []),
    now
  )

  writesSincePrune += 1
  if (writesSincePrune >= PRUNE_EVERY) {
    writesSincePrune = 0
    pruneActionLogs(db, input.taskId, ACTION_LOG_RETENTION_PER_TASK, now)
  }
}

/**
 * The action keys that already reached a settled outcome since `sinceMs`.
 *
 * A **range query** rather than a window over the newest N rows, and the difference is
 * the point: a task whose action is retrying in a loop fills any fixed-size window with
 * its own entries and pushes an earlier, already-settled action out of view — after
 * which the scheduler asks the Platform about an action it had already finished. The
 * caller's question is bounded by the day, so it is asked that way.
 *
 * **Settledness is judged by `isSettledOutcome`, not by a second list of literals in this
 * statement.** The SQL used to exclude `failed` and `blocked` by name while `toOutcome` read
 * anything unrecognised as `failed`, so the same row was a failure to a reader and settled to this
 * function. The rows come back as (key, obtained value) pairs and go through the one mapping.
 *
 * A key is settled when **any** of its rows in the range is, which is what `DISTINCT` streamed into
 * a set gives: a refusal written after a success does not reopen a day that the Platform already
 * finished, and a success written after a refusal does settle it.
 */
export function settledActionKeysSince(db: DatabaseSync, taskId: number, sinceMs: number): string[] {
  const rows = db
    .prepare('SELECT DISTINCT action_key, outcome FROM action_logs WHERE task_id = ? AND at >= ?')
    .all(taskId, sinceMs)

  const settled = new Set<string>()
  for (const row of rows) {
    if (isSettledOutcome(row['outcome'])) settled.add(asString(row['action_key']))
  }
  return [...settled].sort()
}

/**
 * Whether a row carrying this exact `code` was already written for this action since `sinceMs`.
 *
 * **This is the bound on a standing report, and it reads the report rather than the cadence clock.**
 * A standing condition — a switch that is off, a row whose own shape cannot run its action — lasts
 * for hours, so it is written once per Platform day instead of once per cadence tick, which would
 * bury the day's real work under the same sentence. That bound used to be read off the Task's
 * `last_sent_at`, a column every successful run stamps as well: on the ordinary timeline — a Task
 * that ran this morning, whose switch somebody then closed — the condition was true on every pass,
 * so the report was never written on the one day it exists to explain. Asking the record itself is
 * the same question the report answers, and nothing but the report can move it.
 *
 * `code` is what tells one standing condition from another on the same action (`switch_off`,
 * `missing_target`, `unexpected_target`), and it is also what keeps a real run out of the way: an
 * adapter's rows carry the adapter's own codes, so no run can suppress a report and no report can
 * suppress a run.
 */
export function hasActionLogWithCodeSince(
  db: DatabaseSync,
  taskId: number,
  actionKey: string,
  code: string,
  sinceMs: number
): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM action_logs WHERE task_id = ? AND action_key = ? AND code = ? AND at >= ? LIMIT 1')
    .get(taskId, actionKey, code, sinceMs)
  return row !== undefined
}

/**
 * A read's row cap, clamped rather than trusted.
 *
 * The ceiling is the retention bound, which is the most rows an **older** Platform day can have:
 * `pruneActionLogs` keeps every row of the current day plus the newest `keep` of everything before
 * it. That makes this number a **truncation** rather than a ceiling — a Task parked all day at a
 * one-minute cadence writes about 1,440 rows into the current day alone — and it is why every range
 * read here takes the **newest** rows inside its range: a read that returned the oldest 500 of a
 * day would be answering "why did nothing just happen" with this morning, which is the one thing
 * the comment above `listActionLogsSince` says the range query exists to avoid.
 */
function bounded(limit: number): number {
  return Math.max(1, Math.min(limit, ACTION_LOG_RETENTION_PER_TASK))
}

/** Most recent entries first, for the task detail view. */
export function listActionLogs(db: DatabaseSync, taskId: number, limit = 100): ActionLog[] {
  const rows = db
    .prepare('SELECT * FROM action_logs WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT ?')
    .all(taskId, bounded(limit))
  return rows.map(toLog)
}

/**
 * A task's records from one instant onward, **oldest first**.
 *
 * The order is the caller's question. `listActionLogs` answers "what happened
 * last", which reads newest-first; this answers "what happened today", which reads
 * forwards. The bound is a **range** rather than a window over the newest N rows
 * for the reason `settledActionKeysSince` spells out: a task retrying in a loop
 * fills any fixed-size window with its own entries and pushes earlier ones out of
 * view — and here that would mean a day's actions silently disappearing from the
 * day they belong to.
 *
 * **The rows kept when a day holds more than the cap are its newest, not its oldest.** The answer is
 * still read forwards — that is the caller's question, and reversing the array is the whole of the
 * difference — but the selection has to be made from the day's end: at a 60-second cadence a parked
 * Task writes around 1,440 rows into one Platform day, and the interface answers "为什么刚刚没成"
 * from the last row. Taking the first 500 by `at ASC` returns the morning and loses exactly the row
 * the question is about.
 */
export function listActionLogsSince(
  db: DatabaseSync,
  taskId: number,
  sinceMs: number,
  limit = ACTION_LOG_RETENTION_PER_TASK
): ActionLog[] {
  const rows = db
    .prepare('SELECT * FROM action_logs WHERE task_id = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?')
    .all(taskId, sinceMs, bounded(limit))
  return rows.map(toLog).reverse()
}

/** A task's records from before one instant, newest first — the history section. */
export function listActionLogsBefore(
  db: DatabaseSync,
  taskId: number,
  beforeMs: number,
  limit = ACTION_LOG_RETENTION_PER_TASK
): ActionLog[] {
  const rows = db
    .prepare('SELECT * FROM action_logs WHERE task_id = ? AND at < ? ORDER BY at DESC, id DESC LIMIT ?')
    .all(taskId, beforeMs, bounded(limit))
  return rows.map(toLog)
}

/** One Platform day's worth of earlier records, as `listActionLogDays` returns them. */
export interface ActionLogDay {
  /** `YYYY-MM-DD` on the Platform's own day boundary. See `dayKeyOf`. */
  readonly dayKey: string
  /** The instant that day began, so a caller can label or sort without recomputing it. */
  readonly startedAt: number
  readonly records: readonly ActionLog[]
}

/**
 * Earlier records, grouped into the **Platform days** they happened on.
 *
 * Grouping happens here rather than in the UI because the day boundary is the
 * Platform's, not the browser's: a record written at 23:30 CST belongs to that
 * CST day, and a client in another timezone that split the list itself would put
 * it in a different one. Days come newest first and the records inside a day
 * oldest first, so both the list and each day read forwards.
 */
export function listActionLogDays(
  db: DatabaseSync,
  taskId: number,
  beforeMs: number,
  limit = ACTION_LOG_RETENTION_PER_TASK
): ActionLogDay[] {
  const days = new Map<string, { startedAt: number; records: ActionLog[] }>()

  // Newest first, so a day is created by its last record and the map's insertion
  // order is already the order the days are shown in.
  for (const record of listActionLogsBefore(db, taskId, beforeMs, limit)) {
    const startedAt = startOfPlatformDay(record.at)
    const dayKey = dayKeyOf(startedAt)
    const day = days.get(dayKey)
    if (day === undefined) days.set(dayKey, { startedAt, records: [record] })
    else day.records.push(record)
  }

  return [...days].map(([dayKey, day]) => ({ dayKey, startedAt: day.startedAt, records: [...day.records].reverse() }))
}

/** Per-outcome counters for a task, used by the stats endpoint. */
export interface ActionLogSummary {
  readonly total: number
  readonly done: number
  readonly already: number
  readonly skipped: number
  readonly failed: number
  readonly blocked: number
}

/**
 * Counts a task's log rows by outcome, in one query.
 *
 * `failed` is derived as the remainder rather than counted directly, the way
 * `summarizeSendLogs` derives its own `failed` from `total - ok`. Two things
 * follow. The parts always add up to `total`, so a summary can never quietly
 * lose a row. And an outcome written by a build this one does not recognise —
 * which `listActionLogs` also reads back as `failed` — is counted the same way
 * it is displayed, instead of being neither.
 *
 * The outcomes are bound as parameters rather than written into the SQL, so the
 * set of values has exactly one home: the `ActionOutcome` map above.
 */
export function summarizeActionLogs(db: DatabaseSync, taskId: number): ActionLogSummary {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN outcome = ? THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN outcome = ? THEN 1 ELSE 0 END) AS already,
              SUM(CASE WHEN outcome = ? THEN 1 ELSE 0 END) AS skipped,
              SUM(CASE WHEN outcome = ? THEN 1 ELSE 0 END) AS blocked
       FROM action_logs WHERE task_id = ?`
    )
    .get(ActionOutcome.Done, ActionOutcome.Already, ActionOutcome.Skipped, ActionOutcome.Blocked, taskId)

  if (row === undefined) return { total: 0, done: 0, already: 0, skipped: 0, failed: 0, blocked: 0 }

  // Each SUM is 0 rather than NULL when the task has rows, and NULL when it has
  // none; `asNumber` maps both to a number.
  const total = asNumber(row['total'])
  const done = asNumber(row['done'])
  const already = asNumber(row['already'])
  const skipped = asNumber(row['skipped'])
  const blocked = asNumber(row['blocked'])

  return { total, done, already, skipped, failed: total - done - already - skipped - blocked, blocked }
}

/**
 * Deletes all but the newest `keep` rows for a task. Returns rows removed.
 *
 * **Rows from the current Platform day are never deleted**, however many there are.
 * Retention exists to bound the table; settling the day's chores depends on being able
 * to read back what was settled, and a task retrying on a one-second cadence would
 * otherwise prune today's successful rows out from under that answer within minutes —
 * turning a bounded table into a silent correctness hole. A day's worth of even a
 * pathological cadence is a few thousand rows, which is a price worth paying once.
 */
export function pruneActionLogs(
  db: DatabaseSync,
  taskId: number,
  keep = ACTION_LOG_RETENTION_PER_TASK,
  now = Date.now()
): number {
  const info = db
    .prepare(
      `DELETE FROM action_logs
       WHERE task_id = ?
         AND at < ?
         AND id NOT IN (
           SELECT id FROM action_logs WHERE task_id = ? ORDER BY id DESC LIMIT ?
         )`
    )
    .run(taskId, startOfPlatformDay(now), taskId, Math.max(1, keep))
  return asNumber(info.changes)
}

/** Removes every log row for a task (used when a task is deleted and FKs are off). */
export function clearActionLogs(db: DatabaseSync, taskId: number): number {
  const info = db.prepare('DELETE FROM action_logs WHERE task_id = ?').run(taskId)
  return asNumber(info.changes)
}
