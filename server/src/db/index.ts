import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { detectVersion, type MigrationHelpers, runMigrations } from './migrations.js'
import { DDL, INDEX_DDL, SCHEMA_VERSION } from './schema.js'

/**
 * Database handle.
 *
 * Uses Node's built-in `node:sqlite` (`DatabaseSync`) rather than
 * `better-sqlite3`: it ships with the runtime, needs no compiler toolchain, and
 * keeps the image small. The API is synchronous, which is a good fit here — the
 * workload is many small reads/writes, and Fastify's handlers are async anyway.
 *
 * Transactions are not defined here: they live in `db/tx.ts`. `migrations.ts`
 * needs a transaction and this module imports `migrations.ts`, so a `transaction`
 * written here would have to be imported back — a cycle. `tx.ts` imports nothing,
 * which is what lets both use it without one.
 */

export type Db = DatabaseSync

/** Default location; overridable so tests can point at a temp file. */
export const DEFAULT_DB_PATH = process.env['DB_PATH'] ?? 'data/app.sqlite'

let instance: DatabaseSync | null = null

/**
 * Opens (and on first call, creates) the database, bringing it up to
 * `SCHEMA_VERSION`. Idempotent: repeated calls return the same handle.
 *
 * Order matters, and it is the whole reason this function is four steps rather
 * than one. The tables come first so a brand-new database is complete and so an
 * upgrade has every *new* table available to it; migrations then reshape whatever
 * existed before; additive column migrations follow, because they are the cheap
 * tail of the same idea and must never run against a table the structural steps
 * are about to replace.
 *
 * Indexes come last, after the migrations. They cannot be created up front — an
 * index may name a column only a rebuilt table has, which fails the whole `DDL`
 * exec on an old database — and they cannot be created during a rebuild either,
 * because a renamed table keeps its index names and would make them no-ops.
 * `INDEX_DDL` in `schema.ts` spells both failures out; do not move it upwards.
 *
 * A failed `db.exec` is not atomic — statements before the failing one have
 * already been applied. Every statement in both DDL strings is `IF NOT EXISTS`,
 * so re-running after a failure is safe rather than destructive.
 *
 * **A database from a *newer* build is refused rather than brought "down" to this one.** The version
 * stamp is the only record of the file's shape, and this build cannot infer a shape it has never
 * seen; see the guard below for what used to happen instead. Because the DDL runs before the stamp is
 * read (it has to: `detectVersion` reads the `meta` table, which the DDL creates), a refused open may
 * already have added this build's missing tables to that newer file. Refusing earlier is the tidier
 * end state and needs `detectVersion` to work on a file with no `meta` table at all, which is a change
 * to the order documented above rather than to this guard.
 */
export function openDatabase(path: string = DEFAULT_DB_PATH): DatabaseSync {
  if (instance) return instance

  const absolute = path === ':memory:' ? path : resolve(path)
  if (absolute !== ':memory:') {
    mkdirSync(dirname(absolute), { recursive: true })
  }

  // The busy timeout is the difference between waiting and failing. `timeout`
  // defaults to 0, so a second writer — a probe script, a second container on the
  // same volume, or the WAL checkpoint of a connection that is mid-import — makes
  // this one answer `SQLITE_BUSY` on the spot. Five seconds is far longer than any
  // write in this service holds the lock and far shorter than a request timeout.
  const db = new DatabaseSync(absolute, { timeout: 5_000 })
  db.exec(DDL)

  const helpers = migrationHelpers(db)
  const from = detectVersion(db, helpers)

  // A file written by a *newer* build. Every step below assumes the file is older, so none of them
  // is a guard against this direction: `runMigrations` schedules nothing (`MIGRATIONS.filter(to >
  // from)` is empty, so `to === from`), the `throw` under this one cannot fire (its condition needs
  // `from < SCHEMA_VERSION`), and the `INSERT` at the end of this function would overwrite the file's
  // one record of what it is with this build's older number — after which a database in a v4 shape
  // reports itself as v3 and any v3→v4 step is free to run against it again.
  //
  // So the stamp is not a value to normalise; it is the only evidence of the file's shape, and a build
  // that does not know the shape must not write it. The reachable case is an ordinary one rather than
  // an exotic one — rolling an image back, or two containers sharing a volume across a deploy — and
  // the message has to name the one honest remedy, which is to run the newer version again.
  if (from > SCHEMA_VERSION) {
    // The handle is closed before throwing, here and in the sibling refusal below. `openDatabase` is
    // the only owner of it, so a refusal that left it open would hold the file — and on Windows an
    // open handle is what stops the file, and any directory holding it, from being removed, which is a
    // cleanup a test cannot do on the function's behalf because the handle was never handed to it.
    db.close()
    throw new Error(
      `database is at schema v${String(from)} but this build only knows v${String(SCHEMA_VERSION)}; ` +
        'run the newer version against it, or restore a backup taken before it was upgraded'
    )
  }

  const to = runMigrations(db, from, helpers)
  if (to === from && from < SCHEMA_VERSION) {
    // Only reachable if `MIGRATIONS` is missing a step; failing loudly beats
    // running against a schema the code does not expect.
    db.close()
    throw new Error(`database is at schema v${String(from)} but v${String(SCHEMA_VERSION)} is required`)
  }

  applyColumnMigrations(db)
  db.exec(INDEX_DDL)
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(SCHEMA_VERSION))

  instance = db
  return db
}

/** Closes the shared handle. Tests use this between cases. */
export function closeDatabase(): void {
  if (!instance) return
  instance.close()
  instance = null
}

/** Throws if `openDatabase` has not run yet — catches wiring mistakes early. */
export function getDatabase(): DatabaseSync {
  if (!instance) throw new Error('database not opened: call openDatabase() during startup')
  return instance
}

export function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  return row !== undefined
}

export function columnsOf(db: DatabaseSync, table: string): string[] {
  // `PRAGMA table_info` takes an identifier, not a parameter, so the table name is
  // interpolated. It comes from the constant lists in this module, never from input.
  if (!tableExists(db, table)) return []
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(row => String(row['name']))
}

export function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  return columnsOf(db, table).includes(column)
}

export function countOf(db: DatabaseSync, table: string): number {
  if (!tableExists(db, table)) return 0
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
  if (row === undefined) return 0
  const value = row['n']
  return typeof value === 'number' ? value : 0
}

function migrationHelpers(db: DatabaseSync): MigrationHelpers {
  return {
    tableExists: (table: string) => tableExists(db, table),
    columnsOf: (table: string) => columnsOf(db, table),
    countOf: (table: string) => countOf(db, table)
  }
}

/**
 * Convenience for reading a single integer from a `COUNT(*)` style query.
 */
export function scalarOf(db: DatabaseSync, sql: string, ...params: readonly (string | number)[]): number {
  const row = db.prepare(sql).get(...params)
  if (row === undefined) return 0
  const value = Object.values(row)[0]
  return typeof value === 'number' ? value : 0
}

/**
 * Columns added after a release, applied by `applyColumnMigrations`.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to an existing table, so a new column
 * would never appear on a database created by an older build. This is the cheap
 * path for a purely additive change; anything structural belongs in
 * `db/migrations.ts`, which can rebuild a table.
 */
const COLUMN_MIGRATIONS: readonly { table: string; column: string; ddl: string }[] = [
  {
    // `events` gained a `platform` column, and no structural step rebuilds that
    // table: `CREATE TABLE IF NOT EXISTS events` leaves a v1 table exactly as it
    // was, so without this entry the column never appears on an upgraded
    // database. The failure mode is the quiet one — `appendEvent` lists
    // `platform` in its INSERT, SQLite rejects the statement, and that function
    // swallows the error on purpose, so the event feed would go dark with
    // nothing in the log to say so.
    table: 'events',
    column: 'platform',
    ddl: "ALTER TABLE events ADD COLUMN platform TEXT NOT NULL DEFAULT ''"
  },
  {
    // `action_logs` gained an `items` column, and no structural step rebuilds that
    // table either — `CREATE TABLE IF NOT EXISTS action_logs` leaves an older table
    // exactly as it was, so without this entry the column never appears on an
    // upgraded database and every INSERT, which now names it, is rejected.
    //
    // The default is the point rather than decoration: rows written before this
    // column existed keep their detail in `detail` alone, and every reader would
    // otherwise need a branch for "the column is not there" that means the same
    // thing as "this run had no items".
    table: 'action_logs',
    column: 'items',
    ddl: "ALTER TABLE action_logs ADD COLUMN items TEXT NOT NULL DEFAULT '[]'"
  }
]

/**
 * Adds any column that is missing from a database created by an older build.
 *
 * Skips tables that do not exist rather than letting `ALTER TABLE` throw. The
 * caller runs this right after the DDL, so a missing table means an empty
 * database — turning that into a crash would break first run.
 */
export function applyColumnMigrations(db: DatabaseSync): void {
  for (const migration of COLUMN_MIGRATIONS) {
    if (!tableExists(db, migration.table)) continue
    if (!columnExists(db, migration.table, migration.column)) {
      db.exec(migration.ddl)
    }
  }
}
