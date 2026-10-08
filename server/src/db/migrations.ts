import type { DatabaseSync } from 'node:sqlite'

import { DDL, SCHEMA_VERSION } from './schema.js'
import { transaction } from './tx.js'
import { asNumber, asNumberOrNull, asString } from './values.js'

/**
 * Schema migrations.
 *
 * The `COLUMN_MIGRATIONS` list in `db/index.ts` handles additive columns, which
 * is all this project needed at first. It cannot express a structural change,
 * and the move to platform-neutral accounts is one: `tasks.account_id` used to
 * reference `bili_accounts` by name, and **SQLite cannot alter a foreign key in
 * place**. The only way to point it at a different table is to rebuild `tasks`,
 * which is what the step below does.
 *
 * A step therefore gets the raw handle rather than a query builder: rebuilding a
 * table is a sequence of statements, not one statement, and hiding that behind
 * an abstraction would make the single genuinely dangerous operation in this
 * file harder to read.
 */

export interface MigrationHelpers {
  readonly tableExists: (table: string) => boolean
  readonly columnsOf: (table: string) => string[]
  readonly countOf: (table: string) => number
}

export interface Migration {
  /** Version this step produces. Steps run in ascending order. */
  readonly to: number
  /** One line, for the startup log. */
  readonly describe: string
  readonly up: (db: DatabaseSync, helpers: MigrationHelpers) => void
}

/**
 * v1 → v2: platform-neutral accounts.
 *
 * What moves:
 *  - every `bili_accounts` row becomes an `accounts` row with
 *    `platform = 'bilibili'`; the cookie jar and refresh token go into the
 *    `credentials` JSON blob, under keys the Bilibili adapter owns.
 *  - `tasks` is rebuilt so `account_id` references `accounts`, and every
 *    existing row is stamped `platform='bilibili'`, `action='send'`,
 *    `action_key='send_danmaku'` — the only thing a task could be before now.
 *  - `action_settings` gets one enabled row per user that had a task, so the
 *    new switchboard does not silently switch off work already running.
 *
 * The old table is parked rather than dropped: it holds credentials, and a
 * migration that discards the only copy of something is not one to ship on first
 * run. Drop it by hand once a v2 database has proved itself.
 */
const toV2: Migration = {
  to: 2,
  describe: 'accounts become platform-neutral; tasks carry platform, action and action_key',
  up(db, h) {
    if (!h.tableExists('bili_accounts')) return
    if (!h.tableExists('accounts')) return

    // Re-running is harmless and keeps a half-finished upgrade recoverable: the
    // accounts copied by a previous attempt are replaced from the source.
    db.prepare("DELETE FROM accounts WHERE platform = 'bilibili'").run()

    // ---- 1. accounts ----
    const legacyAccounts = db.prepare('SELECT * FROM bili_accounts ORDER BY id ASC').all()
    const insertAccount = db.prepare(
      `INSERT INTO accounts
         (user_id, platform, external_id, display_name, avatar, credentials, meta, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    /** legacy `bili_accounts.id` -> new `accounts.id` */
    const accountIdMap = new Map<number, number>()

    for (const row of legacyAccounts) {
      const credentials = JSON.stringify({
        cookies: asString(row['cookies']),
        refreshToken: asString(row['refresh_token'])
      })
      const info = insertAccount.run(
        asNumber(row['user_id']),
        'bilibili',
        asString(row['uid']),
        asString(row['uname']),
        asString(row['face']),
        credentials,
        '{}',
        asNumber(row['created_at']),
        asNumber(row['updated_at'])
      )
      accountIdMap.set(asNumber(row['id']), asNumber(info.lastInsertRowid))
    }

    // ---- 2. tasks, rebuilt ----
    if (h.tableExists('tasks')) {
      const before = h.countOf('tasks')

      // `legacy_alter_table` (set by the runner) is what keeps `send_logs.task_id`
      // from being rewritten to follow the rename.
      db.exec('ALTER TABLE tasks RENAME TO tasks_v1')

      // The replacement comes from the DDL, so its definition has exactly one home.
      db.exec(DDL)

      const oldTasks = db.prepare('SELECT * FROM tasks_v1 ORDER BY id ASC').all()
      // `monitor_online` is not in this column list, and it cannot be: the `tasks` the statement writes
      // into is the one `db.exec(DDL)` created a few lines up, and that DDL no longer declares the
      // column. Naming it here would make SQLite reject the whole statement — so the v1 → v2 step would
      // fail on every v1 database rather than migrate it. Its value is not carried over because nothing
      // in this build ever read it; the switch a person is actually offered is `require_online`, which
      // is carried over two lines below.
      const insertTask = db.prepare(
        `INSERT INTO tasks (
           id, user_id, platform, account_id, library_id, action, action_key,
           target_key, target_title, start_time, end_time, interval, status,
           cursor, loop_count, sent_count, success_count, fail_count,
           salt_enabled, require_online, last_sent_at,
           last_live_status, last_checked_at, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )

      let migrated = 0
      for (const task of oldTasks) {
        const mapped = accountIdMap.get(asNumber(task['account_id']))
        if (mapped === undefined) continue // dangling account; caught below
        insertTask.run(
          asNumber(task['id']),
          asNumber(task['user_id']),
          'bilibili',
          mapped,
          asNumberOrNull(task['library_id']),
          'send',
          'send_danmaku',
          asString(task['target_key']),
          asString(task['target_title']),
          asNumber(task['start_time']),
          asNumber(task['end_time']),
          asNumber(task['interval']),
          asString(task['status'], 'waiting'),
          asNumber(task['cursor']),
          asNumber(task['loop_count']),
          asNumber(task['sent_count']),
          asNumber(task['success_count']),
          asNumber(task['fail_count']),
          asNumber(task['salt_enabled'], 1),
          asNumber(task['require_online'], 1),
          asNumberOrNull(task['last_sent_at']),
          asNumberOrNull(task['last_live_status']),
          asNumberOrNull(task['last_checked_at']),
          asString(task['last_error']),
          asNumber(task['created_at']),
          asNumber(task['updated_at'])
        )
        migrated += 1
      }

      // Losing a task silently is the worst possible outcome of an upgrade, so
      // refusing to finish is the only safe response. The runner rolls back.
      if (migrated !== before) {
        throw new Error(
          `migration v2: ${String(before)} tasks before, ${String(migrated)} migrated — ` +
            'a task references an account that does not exist. Nothing was changed.'
        )
      }

      // ---- 3. keep already-working behaviour switched on ----
      //
      // `WHERE 1 = 1` is not a filter. SQLite cannot tell whether the `ON` after
      // a SELECT is introducing this upsert or an outer join, so it requires a
      // WHERE clause before the conflict target; without one the statement is a
      // syntax error and the step dies here. Do not remove it as noise.
      const now = Date.now()
      db.prepare(
        `INSERT INTO action_settings (user_id, platform, action_key, enabled, options, created_at, updated_at)
         SELECT DISTINCT user_id, 'bilibili', 'send_danmaku', 1, '{}', ?, ?
         FROM tasks
         WHERE 1 = 1
         ON CONFLICT(user_id, platform, action_key)
         DO UPDATE SET enabled = 1, updated_at = excluded.updated_at`
      ).run(now, now)

      db.exec('DROP TABLE tasks_v1')
    }

    // ---- 4. park the old account table ----
    if (legacyAccounts.length > 0) {
      db.exec('ALTER TABLE bili_accounts RENAME TO migrated_bili_accounts_v1')
    }
  }
}

/**
 * v2 → v3: drop `tasks.monitor_online`.
 *
 * The column arrived with an upstream field set, its only comment being 「wait for live_status = 1」,
 * and **nothing in this build ever read it or wrote it** — the switch a person is actually offered is
 * 「等待开播」, which is `require_online` and which `scheduler/logic.ts`'s `decide` reads. It outlived its
 * reader for exactly that reason: a column with no reader looks harmless, and every reader of `tasks`
 * pays for it by having to know which of two similar switches is the real one. v3 removes it rather than
 * documenting it away, which is what the release before this one could only half do: the create path
 * stopped writing it and the field set stopped carrying it, and the column stayed behind.
 *
 * **The column has to be tested for, and that is load-bearing rather than defensive.** The DDL no longer
 * declares `monitor_online`, and `toV2` builds `tasks` *from the DDL* — so a v1 database reaches this step
 * with the column already gone, and an unconditional `ALTER TABLE ... DROP COLUMN` would fail the whole
 * upgrade on precisely the databases the upgrade exists for. `MIGRATIONS` runs steps in ascending order,
 * in one transaction each, so v1 → v3 is v2 (which rebuilds the table without the column) followed by
 * this step doing nothing. The v1 and v2 cases in `tests/migration.test.ts` pin both halves.
 *
 * Unlike the DDL, this is a *structural* step rather than an additive one, and that is why it is here
 * instead of in `COLUMN_MIGRATIONS` in `db/index.ts`: that list only ever adds a column, because that is
 * the one change `ALTER TABLE` cannot get wrong. What a change to `tasks` can take with it is the child
 * tables' `REFERENCES tasks(id)` and `tasks`' own indexes, and both are *measured* rather than reasoned
 * about — with the column mid-table and trailing, and with `legacy_alter_table` (which the runner sets for
 * every step) on and off, the references, the indexes and the rows all survive and `PRAGMA
 * foreign_key_check` reports nothing. The pragma is still load-bearing for the *other* rebuild in this
 * file: `toV2` renames `tasks` deliberately, and its own case asserts what that rename would do to
 * `send_logs` without it. (`INDEX_DDL` runs after the migrations for the same family of reasons; see
 * `schema.ts`.)
 *
 * All of that is asserted in `tests/migration.test.ts`, along with the rows themselves and the column
 * list the file ends up with.
 */
const toV3: Migration = {
  to: 3,
  describe: 'drop the unread tasks.monitor_online column',
  up(db, h) {
    if (!h.tableExists('tasks')) return
    if (!h.columnsOf('tasks').includes('monitor_online')) return
    db.exec('ALTER TABLE tasks DROP COLUMN monitor_online')
  }
}

export const MIGRATIONS: readonly Migration[] = [toV2, toV3]

/** The schema version a database is actually at, inferred when `meta` is silent. */
export function detectVersion(db: DatabaseSync, helpers: MigrationHelpers): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  const raw = row === undefined ? undefined : row['value']
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }
  // `meta` only predates the very first release. If the pre-v2 account table is
  // there the database is v1; otherwise the DDL above just created everything,
  // which means it is already current.
  return helpers.tableExists('bili_accounts') ? 1 : SCHEMA_VERSION
}

/**
 * Brings the database up to `SCHEMA_VERSION`, one transaction per step.
 *
 * Foreign keys are off for the duration because a table rebuild legitimately
 * points references at a table that does not exist yet.
 */
export function runMigrations(
  db: DatabaseSync,
  from: number,
  helpers: MigrationHelpers,
  onStep?: (migration: Migration) => void
): number {
  const pending = MIGRATIONS.filter(migration => migration.to > from).sort((a, b) => a.to - b.to)
  let version = from

  for (const migration of pending) {
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('PRAGMA legacy_alter_table = ON')
    try {
      // The pragmas are set outside the transaction on purpose: SQLite ignores
      // `PRAGMA foreign_keys` while one is open, so a rebuild would run with the
      // flag still on and fail on the reference to the table it is replacing.
      transaction(db, () => {
        migration.up(db, helpers)
        db.prepare(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run(String(migration.to))
      })
    } finally {
      db.exec('PRAGMA legacy_alter_table = OFF')
      db.exec('PRAGMA foreign_keys = ON')
    }
    onStep?.(migration)
    version = migration.to
  }

  return version
}
