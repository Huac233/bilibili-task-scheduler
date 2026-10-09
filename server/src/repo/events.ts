import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

import { asNumber, asNumberOrNull, asString } from '../db/values.js'

/**
 * Event feed.
 *
 * Everything an external consumer needs to know about "what happened" flows
 * through here, so a notification plugin polls one endpoint with a cursor
 * instead of reimplementing the logic for "is this task stuck", "did the
 * session die", "was this account muted".
 *
 * Events are append-only and consumed by id, not by timestamp: two events can
 * land in the same millisecond, and a timestamp cursor would then either skip
 * one or replay it forever.
 */

export const EventKind = {
  /** A task entered its sending window and started delivering. */
  TaskStarted: 'task_started',
  /** The room went live and a task moved from monitoring to sending. */
  TaskWentLive: 'task_went_live',
  /** A task reached the end of its window. */
  TaskFinished: 'task_finished',
  /** A task stopped because of an unrecoverable error. */
  TaskFailed: 'task_failed',
  /** Sending hit a run of failures — usually rate limiting or content filtering. */
  TaskSendingTrouble: 'task_sending_trouble',
  /** A reconcile action reported a failure; the run continued. */
  ActionFailed: 'action_failed',
  /** A reconcile action is parked — the Platform refused it for now. */
  ActionBlocked: 'action_blocked',
  /** A session expired and a re-scan is required, on any Platform. */
  SessionExpired: 'session_expired',
  /**
   * The Platform is refusing this account outright — Bilibili's `-403`.
   *
   * Account-level, never room-level: a room mute is the room refusing rather than the
   * account, and it is graded `action_stop`, which is what `ActionBlocked` is for. Keeping
   * the two apart is the whole point of this kind, because re-binding an account clears an
   * expired session and clears nothing here.
   */
  AccountRestricted: 'account_restricted',
  /** A session was renewed automatically; informational. */
  SessionRefreshed: 'session_refreshed',
  /**
   * A kind this build does not know, read back from storage.
   *
   * Only ever appears on the way *out*: a row written by a newer build names an
   * event this one has no label for, and relabelling it as some other kind it
   * happens to resemble would be worse than saying so. Never pass this to
   * `appendEvent`.
   */
  Other: 'other'
} as const
export type EventKind = (typeof EventKind)[keyof typeof EventKind]

/**
 * The kinds that name themselves, i.e. every one but `Other`.
 *
 * The complement is the point, and it is why this exists instead of a `kind = 'other'` comparison:
 * `toKind` reads every stored value it does not recognise as `Other`, so "the rows the page labels
 * 「未知事件」" is `kind NOT IN (these)`. A row that literally stored the word is in that bucket as
 * well, which is the same rule read from the other side.
 */
const NAMED_KINDS = Object.values(EventKind).filter(kind => kind !== EventKind.Other)

export const EventSeverity = {
  Info: 'info',
  Warning: 'warning',
  Error: 'error'
} as const
export type EventSeverity = (typeof EventSeverity)[keyof typeof EventSeverity]

export interface SystemEvent {
  readonly id: number
  readonly userId: number
  readonly kind: EventKind
  readonly severity: EventSeverity
  readonly title: string
  readonly detail: string
  /**
   * Which Platform the event is about, as `accounts.platform` spells it.
   *
   * Empty when the event is not about one Platform in particular. A consumer
   * that shows "登录已失效" needs it to say *whose* session died, and with two
   * Platforms bound to one user the title alone cannot tell them apart.
   */
  readonly platform: string
  readonly taskId: number | null
  readonly accountId: number | null
  readonly createdAt: number
}

/** Rows kept per user. Older events are pruned as new ones arrive. */
export const EVENT_RETENTION_PER_USER = 1000

/** Prune every N inserts rather than on every one. */
const PRUNE_EVERY = 100

let insertsSincePrune = 0

/**
 * Reads a stored discriminator back, checking it rather than asserting it.
 *
 * The columns are `TEXT`, so nothing stops a build from having written a kind this
 * one has never heard of. An `as EventKind` here would take that string's word for
 * it — and the whole point of a closed set is that its members are known. An
 * unrecognised kind is surfaced as `Other` instead, which a consumer can act on;
 * the alternative, picking whichever known kind it looks most like, would make the
 * feed lie about what happened.
 *
 * `Object.values<string>` rather than a `readonly string[]` annotation: the widened
 * array makes `.includes` accept anything, which turns the narrowing below into an
 * assertion the check did not actually earn.
 */
function isEventKind(value: string): value is EventKind {
  return Object.values<string>(EventKind).includes(value)
}

function toKind(value: SQLOutputValue | undefined): EventKind {
  const raw = asString(value)
  return isEventKind(raw) ? raw : EventKind.Other
}

/** Same reasoning as `toKind`: an unknown severity must not become a confident one. */
function isEventSeverity(value: string): value is EventSeverity {
  return Object.values<string>(EventSeverity).includes(value)
}

function toSeverity(value: SQLOutputValue | undefined): EventSeverity {
  const raw = asString(value)
  return isEventSeverity(raw) ? raw : EventSeverity.Info
}

function toEvent(row: Record<string, SQLOutputValue>): SystemEvent {
  return {
    id: asNumber(row['id']),
    userId: asNumber(row['user_id']),
    kind: toKind(row['kind']),
    severity: toSeverity(row['severity']),
    title: asString(row['title']),
    detail: asString(row['detail']),
    platform: asString(row['platform']),
    taskId: asNumberOrNull(row['task_id']),
    accountId: asNumberOrNull(row['account_id']),
    createdAt: asNumber(row['created_at'])
  }
}

export interface AppendEventInput {
  readonly userId: number
  readonly kind: EventKind
  readonly severity?: EventSeverity
  readonly title: string
  readonly detail?: string
  /** Defaults to empty: an event about no Platform in particular. */
  readonly platform?: string
  readonly taskId?: number | null
  readonly accountId?: number | null
}

/**
 * Records an event.
 *
 * Deliberately never throws for a bad payload: callers are deep inside the
 * scheduler, where losing a notification is far preferable to interrupting a
 * send. Duplicate suppression is the caller's job, not this function's.
 */
export function appendEvent(db: DatabaseSync, input: AppendEventInput, now = Date.now()): void {
  try {
    db.prepare(
      `INSERT INTO events (user_id, kind, severity, title, detail, platform, task_id, account_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.userId,
      input.kind,
      input.severity ?? EventSeverity.Info,
      input.title,
      input.detail ?? '',
      input.platform ?? '',
      input.taskId ?? null,
      input.accountId ?? null,
      now
    )

    insertsSincePrune += 1
    if (insertsSincePrune >= PRUNE_EVERY) {
      insertsSincePrune = 0
      pruneEvents(db, input.userId)
    }
  } catch {
    // Swallowed on purpose: see the doc comment.
  }
}

/**
 * Events after `sinceId`, oldest first.
 *
 * Ascending order matters — a consumer that processes a batch and stores the
 * last id must not miss anything, which descending order would make easy to get
 * wrong.
 */
export function listEventsSince(db: DatabaseSync, userId: number, sinceId: number, limit = 100): SystemEvent[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
    .all(userId, Math.max(0, sinceId), Math.max(1, Math.min(limit, 500)))
  return rows.map(toEvent)
}

/** Bind markers for `count` values: `?, ?, ?`. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

/**
 * The SQL that keeps only the kinds a caller asked for, and the values it binds.
 *
 * **`Other` is a bucket rather than a word, and it is the one case a plain list cannot express.**
 * `toKind` reads every stored value this build does not recognise as `Other`, so a filter naming
 * `Other` has to match those rows too; `kind IN ('other')` would match only a row that literally
 * stored the word — the same mistake, in reverse, that `toKind` exists to avoid. Selecting `Other`
 * *and* a named kind is therefore two conditions rather than one longer list.
 *
 * Values are bound, never interpolated: the only text this builds is `?` and the column name.
 *
 * Never called with an empty list — that request is answered before this point, because `IN ()` is
 * not SQL.
 */
function kindFilter(kinds: readonly EventKind[]): { readonly sql: string; readonly params: readonly string[] } {
  const named = kinds.filter(kind => kind !== EventKind.Other)
  const conditions: string[] = []
  const params: string[] = []

  if (named.length > 0) {
    conditions.push(`kind IN (${placeholders(named.length)})`)
    params.push(...named)
  }
  if (kinds.includes(EventKind.Other)) {
    conditions.push(`kind NOT IN (${placeholders(NAMED_KINDS.length)})`)
    params.push(...NAMED_KINDS)
  }

  return { sql: conditions.join(' OR '), params }
}

/**
 * Newest first, for the in-app activity list.
 *
 * `kinds` is the page's own filter and nobody else's. An absent one means **no filter at all**,
 * which is what every caller that predates this parameter asks for; an **empty list is a caller
 * asking for nothing**, which is an owner who unticked every box. The two are kept apart on
 * purpose — answering the second with the whole feed would show him exactly the noise he just
 * hid — and an empty list cannot reach the SQL below, where `IN ()` would not parse.
 *
 * **The filter belongs in the query rather than over its result.** `IntegrationsView` keeps the
 * newest `limit` rows, so filtering the fifty it happened to fetch would let a hidden kind consume
 * a place in that window: the feed would look short, or empty, while the rows the owner wants sat
 * immediately behind them.
 */
export function listRecentEvents(
  db: DatabaseSync,
  userId: number,
  limit = 50,
  kinds?: readonly EventKind[]
): SystemEvent[] {
  if (kinds !== undefined && kinds.length === 0) return []

  const filter = kinds === undefined ? null : kindFilter(kinds)
  const size = Math.max(1, Math.min(limit, 200))
  const rows =
    filter === null
      ? db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, size)
      : db
          .prepare(`SELECT * FROM events WHERE user_id = ? AND (${filter.sql}) ORDER BY id DESC LIMIT ?`)
          .all(userId, ...filter.params, size)
  return rows.map(toEvent)
}

/** Highest event id for a user, so a fresh consumer can start from "now". */
export function latestEventId(db: DatabaseSync, userId: number): number {
  const row = db.prepare('SELECT MAX(id) AS max_id FROM events WHERE user_id = ?').get(userId)
  if (row === undefined) return 0
  return asNumber(row['max_id'])
}

/**
 * True when a matching event was recorded within `withinMs`.
 *
 * The key is **user + kind + task**, and the task is the part that used to be
 * missing: a user with accounts on two Platforms would have a Bilibili
 * `session_expired` swallow a Douyu one raised inside the same window, because
 * both share the kind and nothing else in the key distinguished them.
 *
 * `taskId === null` means **user-wide**: the check spans every task of that user.
 * That is not a special case for its own sake — the session-refresh job has no
 * task in hand when it raises a `session_expired`, and its question is "did this
 * user already hear about a dead session", which is exactly that query. It is
 * also what this function did before the task id existed, so those callers keep
 * behaving as they did.
 *
 * **The two readings are not symmetric, and this is the coupling to know about before changing
 * either call site.** `(? IS NULL OR task_id = ?)` makes the *wider* key match rows written by the
 * narrower one, so a user-wide check is suppressed by any one Task's event of that kind inside the
 * window — and, in the other direction, a Task's check is suppressed by a user-wide event. That is
 * intended for the pair that actually reaches it: `runner.ts`'s account-level 「登录已失效」 (raised
 * when a renewal cannot happen) and its task-level one (raised when an action is refused at
 * account level) are the same sentence about the same account, and one row for the pair is what keeps
 * a scheduled renewal failure from being announced once per Task. It is a coupling rather than a
 * coincidence, and it is why adding a *different* kind to either call site is not a local change: the
 * kind is the only thing that separates the two channels' keys.
 */
export function hasRecentEvent(
  db: DatabaseSync,
  userId: number,
  kind: EventKind,
  taskId: number | null,
  withinMs: number,
  now = Date.now()
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM events
       WHERE user_id = ? AND kind = ? AND (? IS NULL OR task_id = ?) AND created_at > ?
       LIMIT 1`
    )
    .get(userId, kind, taskId, taskId, now - withinMs)
  return row !== undefined
}

/**
 * Deleting a task removes its events, so the feed does not reference ghosts.
 *
 * Called by `repo/tasks.ts`'s `deleteTask`, in the same transaction as the row it is about — which is
 * what this sentence needed and did not have. `send_logs` and `action_logs` cascade from `tasks`;
 * `events.task_id` carries no foreign key, so a bare `DELETE FROM tasks` left the feed pointing at a
 * task that no longer existed, and `DELETE /api/tasks/:id` did exactly that.
 */
export function deleteEventsForTask(db: DatabaseSync, taskId: number): number {
  const info = db.prepare('DELETE FROM events WHERE task_id = ?').run(taskId)
  return asNumber(info.changes)
}

/**
 * Deleting an account removes the events that named it, for the same reason `deleteEventsForTask`
 * exists: `events.account_id` has no foreign key either, so nothing else would.
 *
 * `repo/accounts.ts`'s `deleteAccount` calls this together with the tasks' own deletion, and the pair
 * is what makes the fix whole: unbinding an account cascades to its `tasks` rows in SQL, and each of
 * those rows is a Task whose events (raised with its `task_id`) would otherwise outlive it too. Left
 * undone, one unbind would leave the feed holding events about an account and a set of Tasks that no
 * longer exist, which is the dangling reference this file's task case was already fixed for.
 */
export function deleteEventsForAccount(db: DatabaseSync, accountId: number): number {
  const info = db.prepare('DELETE FROM events WHERE account_id = ?').run(accountId)
  return asNumber(info.changes)
}

export function pruneEvents(db: DatabaseSync, userId: number, keep = EVENT_RETENTION_PER_USER): number {
  const info = db
    .prepare(
      `DELETE FROM events
       WHERE user_id = ?
         AND id NOT IN (SELECT id FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?)`
    )
    .run(userId, userId, Math.max(1, keep))
  return asNumber(info.changes)
}
