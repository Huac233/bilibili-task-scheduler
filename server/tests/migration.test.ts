import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyColumnMigrations, closeDatabase, columnsOf, countOf, openDatabase, tableExists } from '../src/db/index.js'
import { type MigrationHelpers, runMigrations } from '../src/db/migrations.js'
import { DDL, INDEX_DDL, SCHEMA_VERSION } from '../src/db/schema.js'
import type { ActionItem } from '../src/platform/types.js'
import { appendActionLog, listActionLogs } from '../src/repo/action-logs.js'
import { appendEvent, EventKind, listRecentEvents } from '../src/repo/events.js'

/**
 * Schema upgrades.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to an existing table, so anything
 * added after the first release — a column, or a whole reshaped table — never
 * appears on a database created by an older build. These tests build a
 * deliberately stale v1 database by hand and prove `openDatabase` brings it
 * forward. That is the case which would otherwise only show up as a runtime
 * failure on someone's live deployment, with their tasks in it.
 *
 * v1 is reproduced as the released build created it: `bili_accounts` (the
 * refresh token had been added by then), and a `tasks` whose `account_id`
 * references that table **by name**. That reference is what forces the rebuild —
 * SQLite cannot alter a foreign key in place, so pointing `tasks` at `accounts`
 * means replacing the table.
 *
 * ## Why the fixture is a whole v1 database and not just the new tables
 *
 * Because that is the only shape of test that can fail. A test that creates an
 * empty database and asserts the new tables' columns proves the DDL parses — it
 * cannot see the upgrade path, which is the only path a real deployment ever
 * takes. The v2 step was broken in four independent ways, and every one of them
 * was invisible to a shape assertion while being fatal to an upgrade:
 *
 *  1. an index in the DDL naming the new `tasks.platform` column failed the whole
 *     `db.exec`, so no migration ran at all;
 *  2. `events.platform` was never added to an existing `events` table, and every
 *     insert was then swallowed by `appendEvent`'s catch — a silent dead feed;
 *  3. `ALTER TABLE tasks RENAME` carried the old table's indexes away under their
 *     original names, so recreating them mid-rebuild was a no-op and the rebuilt
 *     table ended up with none, silently;
 *  4. `INSERT ... SELECT ... ON CONFLICT` is a syntax error without a WHERE.
 *
 * Keep this file pointed at a hand-built old database. The next defect will be
 * found here too, and nowhere else.
 */

const V1_SCHEMA = `
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE bili_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  uid           TEXT    NOT NULL,
  uname         TEXT    NOT NULL DEFAULT '',
  face          TEXT    NOT NULL DEFAULT '',
  cookies       TEXT    NOT NULL,
  refresh_token TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (user_id, uid)
);

CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  account_id    INTEGER NOT NULL REFERENCES bili_accounts(id) ON DELETE CASCADE,
  library_id    INTEGER,
  task_type     TEXT    NOT NULL DEFAULT 'live',
  target_key    TEXT    NOT NULL,
  target_title  TEXT    NOT NULL DEFAULT '',
  start_time    INTEGER NOT NULL,
  end_time      INTEGER NOT NULL,
  interval      INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'waiting',
  cursor        INTEGER NOT NULL DEFAULT 0,
  loop_count    INTEGER NOT NULL DEFAULT 0,
  sent_count    INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  salt_enabled   INTEGER NOT NULL DEFAULT 1,
  -- v3 drops this one; it is in the fixture because the released v1 had it and an installed v1
  -- database still does. Nothing reads it, here or anywhere.
  monitor_online INTEGER NOT NULL DEFAULT 1,
  require_online INTEGER NOT NULL DEFAULT 1,
  last_sent_at     INTEGER,
  last_live_status INTEGER,
  last_checked_at  INTEGER,
  last_error       TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE send_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  content TEXT    NOT NULL,
  ok      INTEGER NOT NULL,
  code    INTEGER NOT NULL DEFAULT 0,
  error   TEXT    NOT NULL DEFAULT '',
  at      INTEGER NOT NULL
);

-- v1's event feed, before v2 added a platform column to it.
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  severity   TEXT    NOT NULL DEFAULT 'info',
  title      TEXT    NOT NULL,
  detail     TEXT    NOT NULL DEFAULT '',
  task_id    INTEGER,
  account_id INTEGER,
  created_at INTEGER NOT NULL
);

-- The indexes v1 shipped with. They matter to this fixture: ALTER TABLE tasks
-- RENAME TO tasks_v1 drags tasks' indexes along under their original names, so a
-- rebuild that tries to recreate them before the scratch table is dropped ends
-- up with none of them and no error.
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_send_logs_task_at ON send_logs(task_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id, id);
`

/**
 * `tasks` as v2 shipped it: the definition this build's `DDL` used to carry, `monitor_online` and its
 * trailing comment included.
 *
 * Written out rather than derived from `DDL` by subtracting a line, because what this fixture has to be
 * is the definition an *installed* v2 database holds, not whatever this build's `DDL` happens to be minus
 * an edit — the same reason `V1_SCHEMA` above is written out. The case that compares the end state to a
 * fresh database is what keeps the two from drifting apart. Column order included, so the step under test
 * is asked to do here what it was asked to do in the field.
 *
 * What the cases below assert about it is measured rather than reasoned about — the rows come out with
 * their own values, `send_logs` and `action_logs` still read `REFERENCES tasks(id)`, all three `tasks`
 * indexes are still there, and the column list ends up identical to a fresh database's. (Measured
 * separately on this SQLite: dropping a mid-table column and dropping a trailing one both preserve all of
 * that, and `legacy_alter_table` makes no difference to either.)
 */
const V2_TASKS = `
CREATE TABLE tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     TEXT    NOT NULL,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  library_id   INTEGER          REFERENCES libraries(id) ON DELETE SET NULL,

  action       TEXT    NOT NULL DEFAULT 'send',
  action_key   TEXT    NOT NULL DEFAULT '',

  target_key   TEXT    NOT NULL DEFAULT '',
  target_title TEXT    NOT NULL DEFAULT '',

  start_time   INTEGER NOT NULL,
  end_time     INTEGER NOT NULL,
  interval     INTEGER NOT NULL,

  status       TEXT    NOT NULL DEFAULT 'waiting',

  cursor       INTEGER NOT NULL DEFAULT 0,
  loop_count   INTEGER NOT NULL DEFAULT 0,
  sent_count   INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,

  salt_enabled    INTEGER NOT NULL DEFAULT 1,
  monitor_online  INTEGER NOT NULL DEFAULT 1,  -- wait for live_status = 1
  require_online  INTEGER NOT NULL DEFAULT 1,

  last_sent_at INTEGER,

  last_live_status INTEGER,
  last_checked_at  INTEGER,
  last_error       TEXT NOT NULL DEFAULT '',

  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
`

const COOKIE_JAR = '[{"name":"SESSDATA","value":"x"}]'

/** One row in each table, wired together the way a real v1 database was. */
function seedV1Rows(db: DatabaseSync): void {
  db.prepare("INSERT INTO users (username, password_hash, created_at, updated_at) VALUES ('tester', 'x', 0, 0)").run()
  db.prepare(
    `INSERT INTO bili_accounts (user_id, uid, uname, face, cookies, refresh_token, created_at, updated_at)
     VALUES (1, '987654', '测试账号', 'https://i0.hdslb.com/face.jpg', ?, 'ac-time-value', 100, 200)`
  ).run(COOKIE_JAR)
  // Three behaviour switches with three different values, and `require_online` deliberately the odd one
  // out: it is the switch that survives to v3 (`monitor_online` goes, `salt_enabled` stays), so a
  // rebuild that shifted a column would land a neighbouring value in it and the assertions below would
  // say so. All three `1`s — the column defaults — would look identical on both sides of the bug.
  db.prepare(
    `INSERT INTO tasks (
       user_id, account_id, library_id, task_type, target_key, target_title,
       start_time, end_time, interval, status, cursor, loop_count,
       sent_count, success_count, fail_count, salt_enabled, monitor_online,
       require_online, last_sent_at, last_live_status, last_checked_at, last_error,
       created_at, updated_at
     ) VALUES (1, 1, NULL, 'live', '22637261', '某直播间', 1000, 2000, 30, 'running', 7, 2, 20, 18, 2, 1, 1, 0, 1500, 1, 1600, '', 100, 200)`
  ).run()
  db.prepare("INSERT INTO send_logs (task_id, content, ok, code, error, at) VALUES (1, '你好', 1, 0, '', 1500)").run()
  db.prepare(
    "INSERT INTO events (user_id, kind, severity, title, detail, task_id, account_id, created_at) VALUES (1, 'session_expired', 'error', '登录已失效', '需要重新扫码绑定账号', 1, 1, 1500)"
  ).run()
}

function helpersFor(db: DatabaseSync): MigrationHelpers {
  return {
    tableExists: (table: string) => tableExists(db, table),
    columnsOf: (table: string) => columnsOf(db, table),
    countOf: (table: string) => countOf(db, table)
  }
}

/** Fails loudly rather than yielding `undefined` into every assertion below. */
function one(db: DatabaseSync, sql: string): Record<string, SQLOutputValue> {
  const row = db.prepare(sql).get()
  if (row === undefined) throw new Error(`expected a row from: ${sql}`)
  return row
}

let dir = ''

/** A v1 database on disk, closed and ready for `openDatabase` to pick up. */
function buildV1File(): string {
  const path = join(dir, 'v1.sqlite')
  const db = new DatabaseSync(path)
  db.exec(V1_SCHEMA)
  seedV1Rows(db)
  db.close()
  return path
}

/**
 * A v2 database on disk: what the build before this one installed, one version short of the guard.
 *
 * Built from this build's `DDL` — a v2 database *is* today's tables, since v2 is the release that
 * introduced them — with `tasks` replaced by `V2_TASKS` (see it for why it is written out in full), and
 * stamped `2`, which is the number the previous build wrote and the number `detectVersion` reads.
 *
 * The rows are the point of the upgrade being worth testing at all: a task, and one row in each of the
 * two tables that reference it.
 */
function buildV2File(): string {
  const path = join(dir, 'v2.sqlite')
  const raw = new DatabaseSync(path)
  raw.exec(DDL)
  // After the DDL, not before: `DDL` turns foreign keys on itself, and `tasks` is dropped and recreated
  // below. (The children are still empty here, so this is belt and braces — but a fixture that says what
  // it needs is cheaper to fix than one whose correctness depends on insertion order.)
  raw.exec('PRAGMA foreign_keys = OFF')
  raw.exec('DROP TABLE tasks')
  raw.exec(V2_TASKS)
  raw.exec(INDEX_DDL)

  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '2')").run()
  raw
    .prepare(
      "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (1, 'tester', 'x', 100, 200)"
    )
    .run()
  raw
    .prepare(
      `INSERT INTO accounts (id, user_id, platform, external_id, display_name, created_at, updated_at)
     VALUES (1, 1, 'douyu', '456918967', '斗鱼测试号', 100, 200)`
    )
    .run()
  raw
    .prepare(
      `INSERT INTO tasks (
       id, user_id, platform, account_id, action, action_key, target_key,
       start_time, end_time, interval, status, cursor, loop_count,
       salt_enabled, monitor_online, require_online, created_at, updated_at
     ) VALUES (1, 1, 'douyu', 1, 'reconcile', 'fishball', '456918967', 1000, 2000, 30, 'running', 7, 2, 1, 1, 0, 100, 200)`
    )
    .run()
  raw.prepare("INSERT INTO send_logs (task_id, content, ok, code, error, at) VALUES (1, '你好', 1, 0, '', 1500)").run()
  raw
    .prepare(
      `INSERT INTO action_logs (task_id, action_key, target_key, outcome, detail, code, items, at)
     VALUES (1, 'fishball', '', 'done', '打卡分鱼丸', '0', '[]', 1600)`
    )
    .run()
  raw.close()
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bts-migration-'))
})

afterEach(() => {
  // Closes the handle `openDatabase` opened; without it the file is still held
  // and the directory cannot be removed on Windows.
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('applyColumnMigrations', () => {
  it('leaves a leftover pre-v2 table alone, because a structural step owns it', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(V1_SCHEMA)

    const before = columnsOf(db, 'bili_accounts')
    applyColumnMigrations(db)

    // A current database has no `bili_accounts` at all; a stale one is brought
    // forward by `db/migrations.ts`, never by the additive path, which cannot
    // express a table rebuild.
    expect(columnsOf(db, 'bili_accounts')).toEqual(before)
    db.close()
  })

  it('adds action_logs.items to a database whose action_logs predates the column', () => {
    const path = join(dir, 'pre-items.sqlite')
    const raw = new DatabaseSync(path)

    // The v2 shape of that table from before `items` existed: per-action records, no
    // per-item detail. Built by hand rather than added to `V1_SCHEMA`, because v1 had
    // no `action_logs` at all — and built by hand rather than by dropping the column
    // from a fresh database, because what needs reproducing is what is installed in
    // the field, not what this build would create.
    //
    // The foreign key to `tasks` is left off this reproduction on purpose: SQLite
    // resolves an FK target when the table is created, so satisfying it here would
    // mean declaring `tasks` as well — and `CREATE TABLE IF NOT EXISTS tasks` would
    // then skip the real definition, leaving the fixture on a schema this build does
    // not use. The column under test is `items`; the key is the v1 → v2 cases' subject.
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '2');
      CREATE TABLE action_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    INTEGER NOT NULL,
        action_key TEXT    NOT NULL,
        target_key TEXT    NOT NULL DEFAULT '',
        outcome    TEXT    NOT NULL,
        detail     TEXT    NOT NULL DEFAULT '',
        code       TEXT    NOT NULL DEFAULT '',
        at         INTEGER NOT NULL
      );
      INSERT INTO action_logs (task_id, action_key, target_key, outcome, detail, code, at)
      VALUES (1, 'sign_in', '', 'done', '客户端签到', '0', 1500);
    `)
    raw.close()

    const db = openDatabase(path)
    expect(columnsOf(db, 'action_logs')).toContain('items')

    // The row the older build wrote keeps its sentence, with the new column empty
    // rather than missing: "written before this column existed" and "this run named
    // nothing" have to read as one thing, or every reader needs a branch for the
    // older shape.
    expect(one(db, 'SELECT * FROM action_logs WHERE id = 1')['items']).toBe('[]')

    // A task to hang a row off: the row seeded above predates the key, and the write
    // below runs on the real schema, where `openDatabase` has foreign keys on.
    db.prepare(
      "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (1, 'tester', 'x', 0, 0)"
    ).run()
    db.prepare(
      "INSERT INTO accounts (id, user_id, platform, external_id, created_at, updated_at) VALUES (1, 1, 'douyu', '456918967', 0, 0)"
    ).run()
    db.prepare(
      `INSERT INTO tasks (id, user_id, platform, account_id, start_time, end_time, interval, created_at, updated_at)
       VALUES (1, 1, 'douyu', 1, 0, 86400000, 86400, 0, 0)`
    ).run()

    // Writing is what proves the column is real, and this is the write the upgrade
    // would have broken: the INSERT names every column, so a table without `items`
    // rejects it — on the scheduler's own path, with the day's detail lost.
    const item: ActionItem = {
      kind: 'account',
      label: '客户端签到',
      outcome: 'done',
      detail: '签到成功。',
      code: '0'
    }
    appendActionLog(db, { taskId: 1, actionKey: 'sign_in', outcome: 'done', items: [item] })
    expect(listActionLogs(db, 1)[0]?.items).toEqual([item])
  })
})

describe('v1 → v2', () => {
  it('keeps both DDL strings free of backticks', () => {
    // Structural guard. The DDL is a template literal, so a backtick anywhere
    // inside it — including within a SQL comment — terminates the string early
    // and produces a syntax error pointing at a line far from the actual
    // mistake. This has bitten three separate times; asserting it is cheaper
    // than remembering.
    expect(DDL.includes('`')).toBe(false)
    expect(INDEX_DDL.includes('`')).toBe(false)
  })

  it('keeps the indexes out of the table DDL', () => {
    // The split is load-bearing, not tidiness: an index inside `DDL` either
    // names a column a v1 table does not have (failing the whole exec before any
    // migration can run) or collides with a name the renamed table carried away
    // (silently leaving the rebuilt table unindexed). Both are spelled out at
    // `INDEX_DDL` in db/schema.ts.
    expect(DDL.toUpperCase()).not.toContain('CREATE INDEX')
    expect(INDEX_DDL.toUpperCase()).toContain('CREATE INDEX')
  })

  it('moves every bili_accounts row into accounts, with the credential blob', () => {
    const db = openDatabase(buildV1File())

    const account = one(db, 'SELECT * FROM accounts')
    expect(account['id']).toBe(1)
    expect(account['user_id']).toBe(1)
    expect(account['platform']).toBe('bilibili')
    expect(account['external_id']).toBe('987654')
    expect(account['display_name']).toBe('测试账号')
    expect(account['avatar']).toBe('https://i0.hdslb.com/face.jpg')
    expect(account['created_at']).toBe(100)
    expect(account['updated_at']).toBe(200)

    // The blob shape belongs to the Bilibili adapter; `repo/bili-accounts.ts`
    // packs and unpacks exactly these two keys.
    const credential: unknown = JSON.parse(String(account['credentials']))
    expect(credential).toEqual({ cookies: COOKIE_JAR, refreshToken: 'ac-time-value' })
  })

  it('rebuilds tasks with platform, action and action_key, and repoints account_id', () => {
    const db = openDatabase(buildV1File())

    const task = one(db, 'SELECT * FROM tasks WHERE id = 1')
    expect(task['platform']).toBe('bilibili')
    // The only thing a task could be before v2: a Bilibili danmaku sender.
    expect(task['action']).toBe('send')
    expect(task['action_key']).toBe('send_danmaku')
    expect(task['account_id']).toBe(one(db, 'SELECT * FROM accounts')['id'])

    // Nothing the old row carried is lost.
    expect(task['target_key']).toBe('22637261')
    expect(task['target_title']).toBe('某直播间')
    expect(task['status']).toBe('running')
    expect(task['cursor']).toBe(7)
    expect(task['loop_count']).toBe(2)
    expect(task['sent_count']).toBe(20)
    expect(task['success_count']).toBe(18)
    expect(task['fail_count']).toBe(2)
    expect(task['last_sent_at']).toBe(1500)

    // The columns the new schema replaced or dropped, with no successor.
    expect(columnsOf(db, 'tasks')).not.toContain('task_type')
    expect(columnsOf(db, 'tasks')).not.toContain('monitor_online')

    // The switch people actually get, carried over intact — and it is the odd value of the three
    // (`seedV1Rows` says why), so a rebuild that shifted a column cannot pass this pair.
    expect(task['require_online']).toBe(0)
    expect(task['salt_enabled']).toBe(1)
  })

  it('switches send_danmaku on for a user who already had a task', () => {
    const db = openDatabase(buildV1File())

    const setting = one(db, 'SELECT * FROM action_settings')
    expect(setting['user_id']).toBe(1)
    expect(setting['platform']).toBe('bilibili')
    expect(setting['action_key']).toBe('send_danmaku')
    // Absence means off, so an upgrade that did not write this row would
    // silently stop work that was already running.
    expect(setting['enabled']).toBe(1)
  })

  it('keeps the send log attached to the rebuilt task', () => {
    const db = openDatabase(buildV1File())

    expect(one(db, 'SELECT * FROM send_logs')['task_id']).toBe(1)

    // `legacy_alter_table` is what keeps this reference on `tasks`. Without it
    // the rename would rewrite `send_logs` to follow the scratch table, and the
    // DROP at the end of the step would leave the log pointing at nothing.
    const ddl = String(one(db, "SELECT sql FROM sqlite_master WHERE name = 'send_logs'")['sql'])
    expect(ddl).toContain('REFERENCES tasks(id)')
  })

  it('adds events.platform to a table that predates the column', () => {
    const db = openDatabase(buildV1File())

    expect(columnsOf(db, 'events')).toContain('platform')

    // The row written by v1 is still there, with the new column empty rather
    // than missing.
    const old = one(db, 'SELECT * FROM events WHERE id = 1')
    expect(old['kind']).toBe('session_expired')
    expect(old['title']).toBe('登录已失效')
    expect(old['platform']).toBe('')

    // Writing is what proves the column is real: `appendEvent` swallows its
    // errors by design, so a missing column would show up as an event feed that
    // had gone quiet rather than as a failure anywhere.
    appendEvent(db, { userId: 1, kind: EventKind.TaskFailed, title: '任务失败', platform: 'bilibili' })
    expect(listRecentEvents(db, 1, 1)[0]?.platform).toBe('bilibili')
  })

  it('restores the indexes a table rebuild drops, on the rebuilt table', () => {
    const db = openDatabase(buildV1File())

    // `ALTER TABLE tasks RENAME TO tasks_v1` takes tasks' indexes with it under
    // their original names, so a `CREATE INDEX IF NOT EXISTS` issued while the
    // scratch table still existed was a no-op, and the DROP at the end of the
    // step deleted the index with it. Rebuilt without `INDEX_DDL` afterwards,
    // `tasks` ends up with no indexes at all — silently, which is why this is
    // asserted rather than assumed.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' ORDER BY name ASC")
      .all()
      .map(row => String(row['name']))

    expect(indexes).toEqual(['idx_tasks_platform_action', 'idx_tasks_status', 'idx_tasks_user'])
  })

  it('parks the old account table instead of dropping it, and clears the scratch table', () => {
    const db = openDatabase(buildV1File())

    expect(tableExists(db, 'migrated_bili_accounts_v1')).toBe(true)
    expect(tableExists(db, 'bili_accounts')).toBe(false)
    expect(tableExists(db, 'tasks_v1')).toBe(false)

    // The parked copy still holds the credential: it is the only copy until a v2
    // database has proved itself, so dropping it stays a manual step.
    expect(one(db, 'SELECT * FROM migrated_bili_accounts_v1')['cookies']).toBe(COOKIE_JAR)
  })

  it('records the new version and does not migrate a second time', () => {
    const path = buildV1File()
    const first = openDatabase(path)
    expect(one(first, "SELECT value FROM meta WHERE key = 'schema_version'")['value']).toBe(String(SCHEMA_VERSION))
    closeDatabase()

    const second = openDatabase(path)
    expect(countOf(second, 'accounts')).toBe(1)
    expect(countOf(second, 'tasks')).toBe(1)
  })

  it('refuses to finish when a task references an account that is not there', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(V1_SCHEMA)
    db.exec('PRAGMA foreign_keys = OFF')
    seedV1Rows(db)
    db.prepare(
      `INSERT INTO tasks (
         user_id, account_id, library_id, task_type, target_key, target_title,
         start_time, end_time, interval, status, created_at, updated_at
       ) VALUES (1, 999, NULL, 'live', '605', '', 1000, 2000, 30, 'waiting', 100, 200)`
    ).run()

    // What `openDatabase` does first: every new table exists before a structural
    // step runs, and `tasks` is left as v1 because IF NOT EXISTS is a no-op.
    db.exec(DDL)

    // Dropping a task silently is the worst possible outcome of an upgrade, so
    // the step refuses and the runner rolls the whole thing back.
    expect(() => runMigrations(db, 1, helpersFor(db))).toThrow(/migration v2/)

    expect(tableExists(db, 'bili_accounts')).toBe(true)
    expect(countOf(db, 'bili_accounts')).toBe(1)
    expect(countOf(db, 'tasks')).toBe(2)
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toBeUndefined()
    db.close()
  })
})

/**
 * v2 → v3, which drops a column rather than reshaping a table — and is the only step here that an
 * *installed* database of the previous release has to survive.
 *
 * The two ways this can be wrong are both silent: a `DROP COLUMN` that takes `send_logs`/`action_logs`'
 * references or `tasks`' indexes with it, and a step that insists on the column being present, which
 * fails every v1 database — because `toV2` rebuilds `tasks` from a `DDL` that no longer declares it. Both
 * are asserted below instead of being reasoned about.
 */
describe('v2 → v3', () => {
  it('drops monitor_online from the middle of tasks and leaves its neighbours and its rows alone', () => {
    const db = openDatabase(buildV2File())

    expect(columnsOf(db, 'tasks')).not.toContain('monitor_online')
    expect(columnsOf(db, 'tasks')).toContain('salt_enabled')
    expect(columnsOf(db, 'tasks')).toContain('require_online')

    // The row that was there before the drop is still there after it, with the switch that survives
    // holding its own value rather than a neighbour's.
    const task = one(db, 'SELECT * FROM tasks WHERE id = 1')
    expect(task['require_online']).toBe(0)
    expect(task['salt_enabled']).toBe(1)
    expect(task['status']).toBe('running')
    expect(task['cursor']).toBe(7)
    expect(task['action_key']).toBe('fishball')

    // And the file says where it is: this is the number the *previous* build wrote, and the reason the
    // guard above cannot treat "one behind" as "unknown".
    expect(one(db, "SELECT value FROM meta WHERE key = 'schema_version'")['value']).toBe(String(SCHEMA_VERSION))
  })

  it('keeps the child tables pointing at tasks, and tasks indexed, through the drop', () => {
    const db = openDatabase(buildV2File())

    // The two things a schema change to `tasks` can silently take with it: the child tables' references,
    // and `tasks`' own indexes. Asserted rather than reasoned about — measured on SQLite 3.51 with the
    // column mid-table and trailing, and with `legacy_alter_table` on and off, all of them survive — and
    // the index half is the same failure that made `INDEX_DDL` run after the migrations: a renamed table
    // carries its index *names* along, so an index recreated mid-rebuild would be a no-op that the DROP
    // then deleted.
    for (const child of ['send_logs', 'action_logs']) {
      const ddl = String(one(db, `SELECT sql FROM sqlite_master WHERE name = '${child}'`)['sql'])
      expect(ddl).toContain('REFERENCES tasks(id)')
      expect(countOf(db, child)).toBe(1)
    }

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' ORDER BY name ASC")
      .all()
      .map(row => String(row['name']))
    expect(indexes).toEqual(['idx_tasks_platform_action', 'idx_tasks_status', 'idx_tasks_user'])
  })

  it('leaves tasks with exactly the columns a database of this build gets', () => {
    // `V2_TASKS` is history and must not follow this build's `DDL`; this is what says it has not drifted
    // — and it is also the assertion that would catch a v3 step that dropped the wrong column, because
    // `monitor_online` is the only difference between the two tables.
    const db = openDatabase(buildV2File())
    const fresh = new DatabaseSync(':memory:')
    fresh.exec(DDL)

    expect(columnsOf(db, 'tasks')).toEqual(columnsOf(fresh, 'tasks'))
    fresh.close()
  })

  it('does not require the column to be there, because a v1 database arrives without it', () => {
    // A v1 file reaches v3 having just been rebuilt by v2 *from the DDL*, which no longer declares
    // `monitor_online`: a step that dropped it unconditionally would take the whole upgrade down, on
    // exactly the databases the upgrade exists for. The v1 cases above would fail too, but the reason
    // would be a step away from what is being asserted here.
    const db = openDatabase(buildV1File())

    expect(columnsOf(db, 'tasks')).not.toContain('monitor_online')
    expect(countOf(db, 'tasks')).toBe(1)
    expect(one(db, "SELECT value FROM meta WHERE key = 'schema_version'")['value']).toBe(String(SCHEMA_VERSION))
  })

  it('still refuses a file from a newer build, one step past this one', () => {
    // The guard's boundary has to move with `SCHEMA_VERSION` rather than sitting where it was: a file
    // one version ahead is as unknown to this build as one ninety-nine ahead.
    const path = buildV2File()
    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1))
    raw.close()

    expect(() => openDatabase(path)).toThrow(new RegExp(`schema v${String(SCHEMA_VERSION + 1)}`))

    // And the stamp is left as it was. That is the guard's whole point: a build that does not know the
    // file's shape must not write its own number over the only record of it.
    const after = new DatabaseSync(path)
    expect(after.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.['value']).toBe(
      String(SCHEMA_VERSION + 1)
    )
    after.close()
  })
})
