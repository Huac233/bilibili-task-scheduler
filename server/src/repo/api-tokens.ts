import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

import { asNumber, asNumberOrNull, asString } from '../db/values.js'

/**
 * Long-lived API tokens for external consumers.
 *
 * A session token expires in a week and is meant for a browser. A notification
 * bridge runs unattended for months, so it needs a credential that outlives a
 * session — issued deliberately, revocable independently, and not the user's
 * password.
 *
 * Only a SHA-256 hash is stored. A dump of the database therefore yields no
 * usable tokens, and a token is visible exactly once, in the response that
 * created it. SHA-256 rather than scrypt is correct here: the token is 256 bits
 * of CSPRNG output, so there is no dictionary to attack and nothing for a slow
 * KDF to protect against.
 */

export interface ApiToken {
  readonly id: number
  readonly userId: number
  readonly name: string
  readonly lastUsedAt: number | null
  readonly createdAt: number
}

/** Prefix stamped on issued tokens so a stray one is recognisable in a config file. */
export const TOKEN_PREFIX = 'bts_'

/** Bytes of randomness per token. */
const TOKEN_BYTES = 32

/** Maximum tokens per user. */
export const MAX_TOKENS_PER_USER = 20

function toToken(row: Record<string, SQLOutputValue>): ApiToken {
  return {
    id: asNumber(row['id']),
    userId: asNumber(row['user_id']),
    name: asString(row['name']),
    lastUsedAt: asNumberOrNull(row['last_used_at']),
    createdAt: asNumber(row['created_at'])
  }
}

/** Stable hash used as the storage key. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function countTokens(db: DatabaseSync, userId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?').get(userId)
  return row === undefined ? 0 : asNumber(row['n'])
}

export interface IssuedToken {
  /** Plaintext. Returned once and never retrievable again. */
  readonly token: string
  readonly record: ApiToken
}

export function createApiToken(db: DatabaseSync, userId: number, name: string, now = Date.now()): IssuedToken {
  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('hex')}`
  const info = db
    .prepare('INSERT INTO api_tokens (user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, name, hashToken(token), now)

  const id = asNumber(info.lastInsertRowid)
  const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id)
  if (row === undefined) throw new Error('token vanished immediately after insert')
  return { token, record: toToken(row) }
}

export function listApiTokens(db: DatabaseSync, userId: number): ApiToken[] {
  const rows = db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY id DESC').all(userId)
  return rows.map(toToken)
}

export function revokeApiToken(db: DatabaseSync, userId: number, tokenId: number): boolean {
  const info = db.prepare('DELETE FROM api_tokens WHERE user_id = ? AND id = ?').run(userId, tokenId)
  return asNumber(info.changes) > 0
}

/**
 * Looks up a token by hash.
 *
 * The comparison against the stored hash is redundant given the lookup is by
 * hash equality in SQLite's index, but it is kept so the shape of the code
 * cannot drift into a plaintext comparison later.
 *
 * `last_used_at` is refreshed opportunistically; a failure to do so is not
 * worth failing the request over.
 */
export function resolveApiToken(db: DatabaseSync, token: string, now = Date.now()): ApiToken | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null

  const digest = hashToken(token)
  const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(digest)
  if (row === undefined) return null

  const record = toToken(row)
  const stored = asString(row['token_hash'])
  const a = Buffer.from(stored, 'utf8')
  const b = Buffer.from(digest, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, record.id)
  } catch {
    // Ignored: usage timestamps are diagnostics, not a correctness concern.
  }

  return record
}
