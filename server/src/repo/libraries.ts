import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

import { transaction } from '../db/tx.js'
import { asNumber, asString } from '../db/values.js'

/**
 * Imported text libraries and their bullets.
 *
 * A 6.5 MB novel produces ~148k bullets, so insertion is the hot path: one
 * transaction with a single reused prepared statement. Wrapping each insert in
 * its own implicit transaction would take minutes instead of about a second.
 */

export interface Library {
  readonly id: number
  readonly userId: number
  readonly name: string
  readonly filename: string
  readonly rawChars: number
  readonly bulletCount: number
  readonly createdAt: number
}

/** Insert chunk size. Large enough to amortise, small enough to stay responsive. */
const INSERT_CHUNK = 2_000

function toLibrary(row: Record<string, SQLOutputValue>): Library {
  return {
    id: asNumber(row['id']),
    userId: asNumber(row['user_id']),
    name: asString(row['name']),
    filename: asString(row['filename']),
    rawChars: asNumber(row['raw_chars']),
    bulletCount: asNumber(row['bullet_count']),
    createdAt: asNumber(row['created_at'])
  }
}

export interface CreateLibraryInput {
  readonly name: string
  readonly filename: string
  readonly rawChars: number
  readonly bullets: readonly string[]
}

/**
 * Inserts a library and all of its bullets atomically.
 *
 * Atomic matters: a partially written library would report a bullet count that
 * does not match its rows, and every cursor-based lookup after that shifts.
 */
export function createLibrary(db: DatabaseSync, userId: number, input: CreateLibraryInput, now = Date.now()): Library {
  return transaction(db, () => {
    const info = db
      .prepare(
        `INSERT INTO libraries (user_id, name, filename, raw_chars, bullet_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(userId, input.name, input.filename, input.rawChars, input.bullets.length, now)

    const libraryId = asNumber(info.lastInsertRowid)
    const stmt = db.prepare('INSERT INTO bullets (library_id, seq, content, char_count) VALUES (?, ?, ?, ?)')

    let seq = 0
    for (let offset = 0; offset < input.bullets.length; offset += INSERT_CHUNK) {
      const chunk = input.bullets.slice(offset, offset + INSERT_CHUNK)
      for (const content of chunk) {
        stmt.run(libraryId, seq, content, content.length)
        seq += 1
      }
    }

    const row = db.prepare('SELECT * FROM libraries WHERE id = ?').get(libraryId)
    if (row === undefined) throw new Error('library vanished immediately after insert')
    return toLibrary(row)
  })
}

export function listLibraries(db: DatabaseSync, userId: number): Library[] {
  const rows = db.prepare('SELECT * FROM libraries WHERE user_id = ? ORDER BY id DESC').all(userId)
  return rows.map(toLibrary)
}

export function getLibrary(db: DatabaseSync, userId: number, libraryId: number): Library | null {
  const row = db.prepare('SELECT * FROM libraries WHERE user_id = ? AND id = ?').get(userId, libraryId)
  return row === undefined ? null : toLibrary(row)
}

export function deleteLibrary(db: DatabaseSync, userId: number, libraryId: number): boolean {
  const info = db.prepare('DELETE FROM libraries WHERE user_id = ? AND id = ?').run(userId, libraryId)
  return asNumber(info.changes) > 0
}

/**
 * Reads one bullet by its position. Returns null when the cursor has run past
 * the end, which the scheduler treats as "a full pass is complete".
 */
export function getBulletAt(db: DatabaseSync, libraryId: number, seq: number): string | null {
  const row = db.prepare('SELECT content FROM bullets WHERE library_id = ? AND seq = ?').get(libraryId, seq)
  if (row === undefined) return null
  const value = row['content']
  return typeof value === 'string' ? value : null
}

/**
 * Reads a contiguous window of bullets. Backs the UI's preview list, so it is
 * capped rather than returning potentially 148k rows.
 */
export function listBullets(
  db: DatabaseSync,
  libraryId: number,
  offset: number,
  limit: number
): { readonly seq: number; readonly content: string }[] {
  const rows = db
    .prepare('SELECT seq, content FROM bullets WHERE library_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?')
    .all(libraryId, Math.max(1, Math.min(limit, 500)), Math.max(0, offset))

  return rows.map(row => ({ seq: asNumber(row['seq']), content: asString(row['content']) }))
}

/** Keeps the library's denormalised count honest after any out-of-band edit. */
export function recountBullets(db: DatabaseSync, libraryId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM bullets WHERE library_id = ?').get(libraryId)
  const count = row === undefined ? 0 : asNumber(row['n'])
  db.prepare('UPDATE libraries SET bullet_count = ? WHERE id = ?').run(count, libraryId)
  return count
}
