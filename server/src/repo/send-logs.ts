import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

import { asNumber, asString, asText } from '../db/values.js'

/**
 * Per-send log.
 *
 * Bounded by retention rather than growing forever: a task at a 10-second
 * interval produces 8,640 rows a day, so an unbounded table would be the first
 * thing to bloat the database. `appendSendLog` prunes opportunistically.
 */

export interface SendLog {
  readonly id: number
  readonly taskId: number
  readonly content: string
  readonly ok: boolean
  /**
   * The Platform's own code, kept as **text** — the same choice, and for the same reason, as
   * `action_logs.code` and `SendOutcome.code`: a code is not arithmetic, and both Platforms send
   * codes that are not numbers (a refusal the adapter grades itself carries a symbolic one). It was
   * a `number` here while the write site passed a literal `0`, which is how the interface came to
   * print `#0` on every failed row; see `runner.ts`'s `sendOne`.
   */
  readonly code: string
  readonly error: string
  readonly at: number
}

/** Rows kept per task. Older entries are deleted as new ones arrive. */
export const LOG_RETENTION_PER_TASK = 500

/** How often to attempt pruning, in writes. Pruning on every insert is wasteful. */
const PRUNE_EVERY = 50

let writesSincePrune = 0

function toLog(row: Record<string, SQLOutputValue>): SendLog {
  return {
    id: asNumber(row['id']),
    taskId: asNumber(row['task_id']),
    content: asString(row['content']),
    ok: asNumber(row['ok']) !== 0,
    // `asText`, not `asString`: the column is declared INTEGER, so a numeric code reads back as a
    // number while a symbolic one reads back as text. `asText`'s comment has the full reason.
    code: asText(row['code']),
    error: asString(row['error']),
    at: asNumber(row['at'])
  }
}

export interface AppendLogInput {
  readonly content: string
  readonly ok: boolean
  /** The Platform's own code, as it reported it. Never a constant — see `SendLog.code`. */
  readonly code: string
  readonly error: string
}

/** Records one attempt. The content stored is what was actually sent (post-salt). */
export function appendSendLog(db: DatabaseSync, taskId: number, input: AppendLogInput, now = Date.now()): void {
  db.prepare('INSERT INTO send_logs (task_id, content, ok, code, error, at) VALUES (?, ?, ?, ?, ?, ?)').run(
    taskId,
    input.content,
    input.ok ? 1 : 0,
    input.code,
    input.error,
    now
  )

  writesSincePrune += 1
  if (writesSincePrune >= PRUNE_EVERY) {
    writesSincePrune = 0
    pruneSendLogs(db, taskId)
  }
}

/** Most recent entries first, for the task detail view. */
export function listSendLogs(db: DatabaseSync, taskId: number, limit = 100): SendLog[] {
  const rows = db
    .prepare('SELECT * FROM send_logs WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT ?')
    // The ceiling is `LOG_RETENTION_PER_TASK` rather than the same number spelled again: two homes for
    // one fact is how a read cap and a retention bound end up disagreeing the day either moves.
    .all(taskId, Math.max(1, Math.min(limit, LOG_RETENTION_PER_TASK)))
  return rows.map(toLog)
}

/** Deletes all but the newest `keep` rows for a task. Returns rows removed. */
export function pruneSendLogs(db: DatabaseSync, taskId: number, keep = LOG_RETENTION_PER_TASK): number {
  const info = db
    .prepare(
      `DELETE FROM send_logs
       WHERE task_id = ?
         AND id NOT IN (
           SELECT id FROM send_logs WHERE task_id = ? ORDER BY id DESC LIMIT ?
         )`
    )
    .run(taskId, taskId, Math.max(1, keep))
  return asNumber(info.changes)
}

/** Aggregate counters for a task, used by the stats endpoint. */
export function summarizeSendLogs(
  db: DatabaseSync,
  taskId: number
): { readonly total: number; readonly ok: number; readonly failed: number } {
  const row = db.prepare('SELECT COUNT(*) AS total, SUM(ok) AS ok FROM send_logs WHERE task_id = ?').get(taskId)

  if (row === undefined) return { total: 0, ok: 0, failed: 0 }
  const total = asNumber(row['total'])
  const ok = asNumber(row['ok'])
  return { total, ok, failed: total - ok }
}

/** Removes every log row for a task (used when a task is deleted and FKs are off). */
export function clearSendLogs(db: DatabaseSync, taskId: number): number {
  const info = db.prepare('DELETE FROM send_logs WHERE task_id = ?').run(taskId)
  return asNumber(info.changes)
}
