import type { DatabaseSync } from 'node:sqlite'

import { asNumber } from '../db/values.js'
import {
  type Account,
  getAccountById,
  getAccountCredentials,
  getAccountMeta,
  getAccount as getGenericAccount,
  listAccountsForPlatform,
  deleteAccount as unbindAccount,
  updateAccountCredentials,
  upsertAccount as upsertGenericAccount
} from './accounts.js'

/**
 * Bound Bilibili accounts — a compatibility shim.
 *
 * `bili_accounts` no longer exists at runtime. Schema v2 replaced it with the
 * platform-neutral `accounts` table and `db/migrations.ts` copies every row
 * across, so this file now implements its old surface on top of
 * `repo/accounts.ts` with `platform = 'bilibili'`.
 *
 * It still exists because its callers were written against the Bilibili-only
 * shape: `routes/bili.ts` binds and unbinds accounts, `routes/context.ts` reads
 * cookies to rebuild a client, `scheduler/runner.ts` renews sessions, and
 * `routes/tasks.ts` resolves a task's account. Keeping these names and
 * signatures is what lets the schema change land as one step instead of
 * requiring the Platform seam to be finished in the same commit — a
 * half-migrated tree is worse than one extra file.
 *
 * Two translations happen here and nowhere else, so no caller has to know about
 * the blob:
 *
 *  - `cookies` and `refreshToken` are packed into the `credentials` JSON the
 *    Bilibili adapter owns, and unpacked on the way out.
 *  - The column renames: `uid` is `external_id`, `uname` is `display_name`,
 *    `face` is `avatar`.
 *
 * `cookies` is a credential. It stays absent from the list/get shapes on
 * purpose; reading it takes an explicit call, which keeps an accidental leak out
 * of a route handler.
 *
 * Delete this file once the Platform seam has replaced those callers — until
 * then a Douyu-shaped reader here would be a second place to keep in sync.
 */

/** The only Platform this module ever touches. */
const PLATFORM = 'bilibili'

export interface BiliAccount {
  readonly id: number
  readonly userId: number
  /** Bilibili's DedeUserID, stored as `accounts.external_id`. */
  readonly uid: string
  readonly uname: string
  readonly face: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface UpsertAccountInput {
  readonly uid: string
  readonly uname: string
  readonly face: string
  /** Serialised cookie jar. Goes into the blob as `cookies`. */
  readonly cookies: string
  /** `ac_time_value` from the login poll; empty when the flow did not supply one. */
  readonly refreshToken?: string
}

/** Everything needed to open a session: the cookies and the refresh token. */
export interface StoredCredential {
  readonly cookies: string
  readonly refreshToken: string
}

function toBiliAccount(account: Account): BiliAccount {
  return {
    id: account.id,
    userId: account.userId,
    uid: account.externalId,
    uname: account.displayName,
    face: account.avatar,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  }
}

/**
 * The Bilibili `credentials` shape. It belongs to this Platform, which is why
 * the packing lives here and `accounts.ts` keeps the blob opaque.
 */
interface BiliCredential {
  readonly cookies: string
  readonly refreshToken: string
}

function packCredential(cookies: string, refreshToken: string): string {
  return JSON.stringify({ cookies, refreshToken })
}

/**
 * Reads the blob, or null when it cannot be read.
 *
 * A blob with no cookie string is treated as no credential rather than as an
 * empty one: every caller reads null as "there is no session", and handing back
 * an empty jar would only move the failure one step further out.
 */
function unpackCredential(raw: string | null): BiliCredential | null {
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const record = parsed as Record<string, unknown>
  const cookies = record['cookies']
  if (typeof cookies !== 'string') return null

  const refreshToken = record['refreshToken']
  return { cookies, refreshToken: typeof refreshToken === 'string' ? refreshToken : '' }
}

/**
 * Writes the two fields this Platform owns, keeping any other key in the blob.
 *
 * Merging rather than replacing is deliberate: the blob is the adapter's, and a
 * future revision that stores a device id or a web session alongside the cookie
 * jar must not lose it because a session was renewed through this path.
 */
function mergeCredential(raw: string | null, cookies: string, refreshToken: string): string {
  let existing: Record<string, unknown> = {}

  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        existing = { ...(parsed as Record<string, unknown>) }
      }
    } catch {
      // Unreadable blob: start from empty. There is nothing here worth preserving.
      existing = {}
    }
  }

  return JSON.stringify({ ...existing, cookies, refreshToken })
}

/** The `meta` a re-bind must not clobber, or undefined when the row is new. */
function existingMeta(db: DatabaseSync, userId: number, uid: string): string | undefined {
  const found = listAccountsForPlatform(db, userId, PLATFORM).find(account => account.externalId === uid)
  if (found === undefined) return undefined
  return getAccountMeta(db, found.id) ?? undefined
}

/**
 * Inserts or refreshes a binding. Re-scanning the QR code for an account that
 * is already bound updates its cookies instead of creating a duplicate — which
 * also keeps the tasks pointing at that account meaningful across a re-auth.
 */
export function upsertAccount(
  db: DatabaseSync,
  userId: number,
  input: UpsertAccountInput,
  now = Date.now()
): BiliAccount {
  // Read before the write: `accounts.upsertAccount` overwrites `meta` with what
  // it is given, and this shim has no opinion on a field it does not own.
  const meta = existingMeta(db, userId, input.uid)

  const account = upsertGenericAccount(
    db,
    userId,
    {
      platform: PLATFORM,
      externalId: input.uid,
      displayName: input.uname,
      avatar: input.face,
      credentials: packCredential(input.cookies, input.refreshToken ?? ''),
      ...(meta === undefined ? {} : { meta })
    },
    now
  )

  return toBiliAccount(account)
}

export function listAccounts(db: DatabaseSync, userId: number): BiliAccount[] {
  return listAccountsForPlatform(db, userId, PLATFORM).map(toBiliAccount)
}

export function getAccount(db: DatabaseSync, userId: number, accountId: number): BiliAccount | null {
  const account = getGenericAccount(db, userId, accountId)
  // A Douyu account id must not resolve through a Bilibili-shaped reader.
  if (account === null || account.platform !== PLATFORM) return null
  return toBiliAccount(account)
}

/** Reads the cookie jar for an account. Separate from `getAccount` on purpose. */
export function getAccountCookies(db: DatabaseSync, userId: number, accountId: number): string | null {
  const account = getGenericAccount(db, userId, accountId)
  if (account === null || account.platform !== PLATFORM) return null
  return unpackCredential(getAccountCredentials(db, accountId))?.cookies ?? null
}

/**
 * Unscoped cookie read, keyed by account id alone.
 *
 * The scheduler resolves a client from a task's `account_id` and has no request
 * context, so it cannot supply a user id. Route handlers must use the scoped
 * variant above so a user can never read another user's credential.
 */
export function getAccountCookiesById(db: DatabaseSync, accountId: number): string | null {
  const account = getAccountById(db, accountId)
  if (account === null || account.platform !== PLATFORM) return null
  return unpackCredential(getAccountCredentials(db, accountId))?.cookies ?? null
}

/** Unscoped credential read used by the scheduler and the refresh job. */
export function getAccountCredentialById(db: DatabaseSync, accountId: number): StoredCredential | null {
  const account = getAccountById(db, accountId)
  if (account === null || account.platform !== PLATFORM) return null
  return unpackCredential(getAccountCredentials(db, accountId))
}

/** Persists a renewed credential after a successful refresh. */
export function updateAccountCredential(
  db: DatabaseSync,
  accountId: number,
  cookies: string,
  refreshToken: string,
  now = Date.now()
): void {
  const account = getAccountById(db, accountId)
  if (account === null || account.platform !== PLATFORM) return

  const merged = mergeCredential(getAccountCredentials(db, accountId), cookies, refreshToken)
  updateAccountCredentials(db, accountId, merged, now)
}

/**
 * Accounts that can be refreshed, i.e. those carrying a refresh token.
 *
 * The refresh job needs this before it holds any account, so it cannot go row by
 * row through `getAccountCredentialById`. `repo/accounts.ts` does expose
 * `listRefreshableAccounts`, but it keys off `meta.refreshable`, and nothing
 * writes that field — adopting it here would make the job depend on a marker
 * only this file would ever set. The honest key is the one the old
 * `bili_accounts.refresh_token` column carried: a non-empty refresh token inside
 * the blob. The query is written here rather than in `accounts.ts` because that
 * module deliberately knows nothing about any Platform's credential shape.
 */
export function listRefreshableAccountIds(db: DatabaseSync): { id: number; userId: number }[] {
  const rows = db
    .prepare(
      `SELECT id, user_id FROM accounts
       WHERE platform = ?
         AND COALESCE(json_extract(credentials, '$.refreshToken'), '') <> ''
       ORDER BY id ASC`
    )
    .all(PLATFORM)

  return rows.map(row => ({ id: asNumber(row['id']), userId: asNumber(row['user_id']) }))
}

/** Unbinds an account. Cascades to its tasks via the foreign key. */
export function deleteAccount(db: DatabaseSync, userId: number, accountId: number): boolean {
  const account = getGenericAccount(db, userId, accountId)
  if (account === null || account.platform !== PLATFORM) return false
  return unbindAccount(db, userId, accountId)
}
