import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

import { transaction } from '../db/tx.js'
import { asNumber, asString } from '../db/values.js'
import { deleteEventsForAccount, deleteEventsForTask } from './events.js'

/**
 * Bound accounts, across every Platform.
 *
 * A row is one person on one Platform. Everything platform-shaped lives in the
 * `credentials` and `meta` JSON blobs, whose shapes belong to that Platform's
 * adapter — this module stores and returns them as opaque strings on purpose, so
 * adding a Platform never means touching this file.
 *
 * `credentials` is a secret. It is deliberately absent from the shapes the
 * list/get helpers return; reading it takes an explicit call, which keeps an
 * accidental leak out of a route handler.
 */

export interface Account {
  readonly id: number
  readonly userId: number
  readonly platform: string
  readonly externalId: string
  readonly displayName: string
  readonly avatar: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface UpsertAccountInput {
  readonly platform: string
  /** The account's id on the Platform: Bilibili's DedeUserID, Douyu's uid. */
  readonly externalId: string
  readonly displayName: string
  readonly avatar: string
  /** Serialised, platform-shaped credential blob. */
  readonly credentials: string
  /** Free-form platform extras that are not credentials. */
  readonly meta?: string
}

function toAccount(row: Record<string, SQLOutputValue>): Account {
  return {
    id: asNumber(row['id']),
    userId: asNumber(row['user_id']),
    platform: asString(row['platform']),
    externalId: asString(row['external_id']),
    displayName: asString(row['display_name']),
    avatar: asString(row['avatar']),
    createdAt: asNumber(row['created_at']),
    updatedAt: asNumber(row['updated_at'])
  }
}

/**
 * Inserts or refreshes a binding.
 *
 * Re-binding an account that is already bound — re-scanning Bilibili's QR code,
 * or pasting a fresh Douyu credential — updates its credentials instead of
 * creating a second row, which is what a person expects and what keeps a task's
 * `account_id` meaningful across a re-auth.
 */
export function upsertAccount(db: DatabaseSync, userId: number, input: UpsertAccountInput, now = Date.now()): Account {
  db.prepare(
    `INSERT INTO accounts
       (user_id, platform, external_id, display_name, avatar, credentials, meta, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, platform, external_id) DO UPDATE SET
       display_name = excluded.display_name,
       avatar = excluded.avatar,
       credentials = excluded.credentials,
       meta = excluded.meta,
       updated_at = excluded.updated_at`
  ).run(
    userId,
    input.platform,
    input.externalId,
    input.displayName,
    input.avatar,
    input.credentials,
    input.meta ?? '{}',
    now,
    now
  )

  const row = db
    .prepare('SELECT * FROM accounts WHERE user_id = ? AND platform = ? AND external_id = ?')
    .get(userId, input.platform, input.externalId)
  if (row === undefined) throw new Error('account disappeared immediately after upsert')
  return toAccount(row)
}

export function listAccounts(db: DatabaseSync, userId: number): Account[] {
  const rows = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY platform ASC, id ASC').all(userId)
  return rows.map(toAccount)
}

export function listAccountsForPlatform(db: DatabaseSync, userId: number, platform: string): Account[] {
  const rows = db
    .prepare('SELECT * FROM accounts WHERE user_id = ? AND platform = ? ORDER BY id ASC')
    .all(userId, platform)
  return rows.map(toAccount)
}

export function getAccount(db: DatabaseSync, userId: number, accountId: number): Account | null {
  const row = db.prepare('SELECT * FROM accounts WHERE user_id = ? AND id = ?').get(userId, accountId)
  return row === undefined ? null : toAccount(row)
}

/** Unscoped lookup. The scheduler resolves an account from a task and has no request context. */
export function getAccountById(db: DatabaseSync, accountId: number): Account | null {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId)
  return row === undefined ? null : toAccount(row)
}

/**
 * Unscoped listing for one Platform.
 *
 * Background jobs — the session-refresh sweep above all — have no request context
 * and need every account, not one user's. Scoped per Platform so a job can skip
 * Platforms whose adapter has nothing to renew.
 */
export function listAccountsByPlatform(db: DatabaseSync, platform: string): Account[] {
  const rows = db.prepare('SELECT * FROM accounts WHERE platform = ? ORDER BY id ASC').all(platform)
  return rows.map(toAccount)
}

/**
 * Reads an account's credential blob. Separate from the getters above on purpose:
 * callers that do not need credentials never receive them.
 */
export function getAccountCredentials(db: DatabaseSync, accountId: number): string | null {
  const row = db.prepare('SELECT credentials FROM accounts WHERE id = ?').get(accountId)
  if (row === undefined) return null
  const value = row['credentials']
  return typeof value === 'string' ? value : null
}

/** Persists a renewed credential — after a token refresh, say. */
export function updateAccountCredentials(
  db: DatabaseSync,
  accountId: number,
  credentials: string,
  now = Date.now()
): void {
  db.prepare('UPDATE accounts SET credentials = ?, updated_at = ? WHERE id = ?').run(credentials, now, accountId)
}

export function getAccountMeta(db: DatabaseSync, accountId: number): string | null {
  const row = db.prepare('SELECT meta FROM accounts WHERE id = ?').get(accountId)
  if (row === undefined) return null
  const value = row['meta']
  return typeof value === 'string' ? value : null
}

export function updateAccountMeta(db: DatabaseSync, accountId: number, meta: string, now = Date.now()): void {
  db.prepare('UPDATE accounts SET meta = ?, updated_at = ? WHERE id = ?').run(meta, now, accountId)
}

/**
 * Accounts of one Platform that carry something refreshable.
 *
 * **Nothing writes `meta.refreshable` today, so this answers an empty list for every Platform, and
 * the hole is worth naming rather than hiding.** The shape was designed around a Platform adapter
 * deciding what "refreshable" means by putting a truthy marker in its `meta`, which is why this module
 * stays ignorant of credential shape. What the session-refresh job actually calls is neither this nor
 * its unscoped sibling: `runner.ts` walks `listAccountsByPlatform` and asks each adapter, and Douyu's
 * says in as many words that it writes **no** `meta.refreshable` (`platform/douyu/passport.ts`).
 * `repo/bili-accounts.ts` reaches the Bilibili half through `meta.refreshable` on its own path and
 * explains why it does not reuse this function.
 *
 * So the entry point looks authoritative and is a constant. It is kept rather than deleted because the
 * caller that *reads* its contract is a comment in another agent's file, and a function that
 * disappears underneath that reader is the stale reference this repository keeps paying for; deleting
 * it wants the two comment updates to land with it.
 */
export function listRefreshableAccounts(db: DatabaseSync, platform: string): { id: number; userId: number }[] {
  const rows = db
    .prepare(
      "SELECT id, user_id FROM accounts WHERE platform = ? AND json_extract(meta, '$.refreshable') = 1 ORDER BY id ASC"
    )
    .all(platform)
  return rows.map(row => ({ id: asNumber(row['id']), userId: asNumber(row['user_id']) }))
}

/**
 * Unbinds an account, and takes what was written about it with it.
 *
 * The `tasks` rows cascade through the foreign key, and their **events** do not: `events.task_id` and
 * `events.account_id` carry no references, so a bare `DELETE FROM accounts` left the feed pointing at
 * an account and a set of Tasks that no longer existed — `deleteEventsForTask`'s sentence in
 * `repo/events.ts`, applied to the other two columns. Rebinding is the ordinary way out of a dead
 * session, so this is a person's everyday action rather than an edge case.
 *
 * One transaction, because the three deletes are one fact.
 */
export function deleteAccount(db: DatabaseSync, userId: number, accountId: number): boolean {
  return transaction(db, () => {
    // Read before the delete: the cascade takes the rows that name the account, and the events raised
    // with those tasks' ids can only be found while the ids are still there to read.
    const taskIds = db
      .prepare('SELECT id FROM tasks WHERE account_id = ?')
      .all(accountId)
      .map(row => asNumber(row['id']))

    const info = db.prepare('DELETE FROM accounts WHERE user_id = ? AND id = ?').run(userId, accountId)
    if (asNumber(info.changes) === 0) return false

    for (const taskId of taskIds) deleteEventsForTask(db, taskId)
    deleteEventsForAccount(db, accountId)
    return true
  })
}
