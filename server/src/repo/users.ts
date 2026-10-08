import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

import { asNumber, asString } from '../db/values.js'

/**
 * User records for accounts on this system.
 *
 * Row shapes coming out of `node:sqlite` are `Record<string, SQLOutputValue>`,
 * which is `unknown`-ish by design. Everything is funnelled through the small
 * coercion helpers below so the rest of the codebase works with concrete types
 * instead of casting at each call site.
 */

export interface User {
  readonly id: number
  readonly username: string
  readonly createdAt: number
}

/** Internal shape that additionally carries the password hash. Never send this over HTTP. */
export interface UserWithSecret extends User {
  readonly passwordHash: string
}

function rowToUser(row: Record<string, SQLOutputValue>): User {
  return {
    id: asNumber(row['id']),
    username: asString(row['username']),
    createdAt: asNumber(row['created_at'])
  }
}

function rowToUserWithSecret(row: Record<string, SQLOutputValue>): UserWithSecret {
  return { ...rowToUser(row), passwordHash: asString(row['password_hash']) }
}

/** Inserts a user. Throws if the username is taken (UNIQUE constraint). */
export function createUser(db: DatabaseSync, username: string, passwordHash: string, now = Date.now()): User {
  const info = db
    .prepare('INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, now, now)

  const id = asNumber(info.lastInsertRowid)
  return { id, username, createdAt: now }
}

/** Case-sensitive lookup; usernames are stored exactly as typed. */
export function findUserByUsername(db: DatabaseSync, username: string): UserWithSecret | null {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  return row === undefined ? null : rowToUserWithSecret(row)
}

export function findUserById(db: DatabaseSync, id: number): User | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
  return row === undefined ? null : rowToUser(row)
}

/** Total registered accounts. Used to decide whether to keep registration open. */
export function countUsers(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get()
  return row === undefined ? 0 : asNumber(row['n'])
}

/**
 * True when the username is already registered.
 *
 * Distinct from catching the UNIQUE violation so routes can return a friendly
 * message rather than a generic constraint error.
 */
export function usernameExists(db: DatabaseSync, username: string): boolean {
  const row = db.prepare('SELECT 1 AS hit FROM users WHERE username = ? LIMIT 1').get(username)
  return row !== undefined
}
