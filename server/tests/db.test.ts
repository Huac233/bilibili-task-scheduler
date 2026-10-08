import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDatabase, openDatabase } from '../src/db/index.js'
import { SCHEMA_VERSION } from '../src/db/schema.js'
import { transaction } from '../src/db/tx.js'

/**
 * The database handle, and the transactions that run on it.
 *
 * Both subjects here fail *silently* when they are wrong, which is why they are
 * pinned: a busy timeout of zero turns a concurrent writer into an immediate
 * `SQLITE_BUSY` that only shows up under load, and a transaction that cannot nest
 * turns the second `transaction()` call inside a first into a crash rather than a
 * join. Neither is visible from the happy path.
 */

const ROWS = 'CREATE TEMP TABLE tx_probe (n INTEGER)'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bts-db-'))
})

afterEach(() => {
  // Closes the handle `openDatabase` opened. A refused open closes its own, which is
  // what lets this directory be removed at all on Windows.
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

/** The stamp inside a file, read with a connection of its own so nothing has to be open. */
function stampOf(path: string): string {
  const raw = new DatabaseSync(path)
  const row = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  raw.close()
  return String(row?.['value'])
}

describe('openDatabase', () => {
  it('sets a busy timeout, so a second writer waits instead of failing at once', () => {
    const db = openDatabase(':memory:')
    // The comparison is the point: `DatabaseSync`'s `timeout` option defaults to 0,
    // which means a writer that finds the database locked gives up immediately.
    expect(new DatabaseSync(':memory:').prepare('PRAGMA busy_timeout').get()?.['timeout']).toBe(0)
    expect(db.prepare('PRAGMA busy_timeout').get()?.['timeout']).toBe(5_000)
  })

  /**
   * A file from a *newer* build is refused, and the stamp it carries is left alone.
   *
   * Both halves matter and the second is the one that used to be wrong. `detectVersion` believes
   * whatever integer `meta` holds, `runMigrations` schedules nothing when the file is already "ahead",
   * and the refusal guarded only the *other* direction — so `openDatabase` read `99`, ran no step, and
   * then wrote `2` over the file's only record of what it is. The reachable case is ordinary: rolling
   * an image back, or two containers sharing a volume across a deploy. After that write, a database in
   * a v99 shape reports itself as v2, and the next upgrade runs its v1→v2 steps against it again.
   */
  it('refuses a database from a newer build instead of rewriting it down to this one', () => {
    const path = join(dir, 'from-the-future.sqlite')
    openDatabase(path).prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run()
    expect(stampOf(path)).toBe('99')
    closeDatabase()

    expect(() => openDatabase(path)).toThrow(/schema v99/)
    expect(stampOf(path)).toBe('99')

    // And the refusal is this build's own, not "refuse everything": a file carrying this build's
    // number opens normally. The stamp is put back through a raw connection for exactly the reason
    // above — `openDatabase` is the function that will no longer write it.
    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION))
    raw.close()

    expect(() => openDatabase(path)).not.toThrow()
  })
})

describe('transaction', () => {
  let db: ReturnType<typeof openDatabase>

  beforeEach(() => {
    db = openDatabase(':memory:')
    db.exec(ROWS)
  })

  afterEach(() => {
    closeDatabase()
  })

  const count = (): SQLOutputValue | undefined => db.prepare('SELECT COUNT(*) AS n FROM tx_probe').get()?.['n']

  const insert = (n: number): void => {
    db.prepare('INSERT INTO tx_probe (n) VALUES (?)').run(n)
  }

  it('commits what the function wrote', () => {
    transaction(db, () => {
      insert(1)
      insert(2)
    })
    expect(count()).toBe(2)
  })

  it('rolls the whole unit back when the function throws', () => {
    expect(() =>
      transaction(db, () => {
        insert(1)
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(count()).toBe(0)
  })

  it('rolls back only the inner unit when one transaction runs inside another', () => {
    transaction(db, () => {
      insert(1)
      expect(() =>
        transaction(db, () => {
          insert(2)
          throw new Error('inner')
        })
      ).toThrow('inner')
      insert(3)
    })

    // Two rows, not three and not none: the savepoint took back exactly what the
    // inner call wrote. `BEGIN` inside an open transaction is an error, so this
    // shape used to be a crash — which is what the savepoint is for.
    expect(count()).toBe(2)
  })

  it('rolls the outer unit back too when an inner failure is allowed to escape', () => {
    expect(() =>
      transaction(db, () => {
        insert(1)
        transaction(db, () => {
          throw new Error('inner')
        })
      })
    ).toThrow('inner')
    expect(count()).toBe(0)
  })
})
