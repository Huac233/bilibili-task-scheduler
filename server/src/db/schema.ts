/**
 * Database schema.
 *
 * Storage is SQLite via Node's built-in `node:sqlite` — no native module to
 * compile, no external service to run, and the whole database is one file that
 * rides along with the container volume.
 *
 * Three design decisions worth stating up front:
 *
 * 1. **Bullets are rows, not a blob.** A novel import is ~2.2M characters; the
 *    original schema kept the whole ammunition list in one `VARCHAR(1024)`
 *    column, which caps a task at a few hundred characters. Here every
 *    sentence is its own row so a task can carry tens of thousands of them and
 *    progress can be tracked with a cursor.
 *
 * 2. **Progress is a cursor, not a counter.** `cursor` is the index of the
 *    next bullet to send and `loop_count` is how many full passes have
 *    completed, so "发到第几条 / 第几遍" is exact rather than inferred from a
 *    send count that drifts whenever a message is rejected.
 *
 * 3. **Accounts are platform-neutral.** An `accounts` row is one person on one
 *    Platform; everything platform-shaped lives in a `credentials` JSON blob
 *    that only that Platform's adapter interprets. Adding a Platform is
 *    therefore a new adapter, not a new table plus a new foreign key — the
 *    earlier `bili_accounts` table made a second Platform impossible, because
 *    `tasks.account_id` referenced it by name and SQLite cannot alter a foreign
 *    key in place.
 *
 * SQL comments inside DDL below avoid backticks: the whole string is one
 * template literal.
 *
 * `DDL` creates tables only; the indexes live in `INDEX_DDL` and run after the
 * migrations. That split is not a style choice — the reason is written out at
 * `INDEX_DDL` and it is the difference between a v1 database starting and not.
 */

export const SCHEMA_VERSION = 3

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------ --
-- Accounts on this system (not platform accounts)
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ------------------------------------------------------------------ --
-- Bound accounts: one row per person per Platform. One system user may bind
-- several, on the same Platform or across Platforms.
--
-- external_id is the account's id ON the Platform (Bilibili's DedeUserID,
-- Douyu's uid). credentials is a JSON blob whose shape belongs to that
-- Platform's adapter: Bilibili keeps a cookie jar plus a refresh token, Douyu a
-- composite token plus a device id plus a web session.
--
-- Both credential columns are secrets: never log or return them.
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     TEXT    NOT NULL,          -- bilibili | douyu
  external_id  TEXT    NOT NULL,
  display_name TEXT    NOT NULL DEFAULT '',
  avatar       TEXT    NOT NULL DEFAULT '',
  credentials  TEXT    NOT NULL DEFAULT '{}',
  meta         TEXT    NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (user_id, platform, external_id)
);

-- ------------------------------------------------------------------ --
-- Imported text (a novel, a meme list, ...).
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS libraries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  filename    TEXT    NOT NULL DEFAULT '',
  raw_chars   INTEGER NOT NULL DEFAULT 0,
  bullet_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- One sentence per row. seq preserves the original reading order.
CREATE TABLE IF NOT EXISTS bullets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  content    TEXT    NOT NULL,
  char_count INTEGER NOT NULL
);

-- ------------------------------------------------------------------ --
-- Scheduled tasks.
--
-- The shell is platform-neutral: a target, a window, an interval, an action.
-- The "action" column names the EXECUTOR -- 'send' consumes Bullets and never
-- completes, 'reconcile' reads what the Platform reports as outstanding and
-- finishes. The "action_key" column names the concrete thing that executor does
-- on that Platform (send_danmaku, sign_in, fishball, ...), so a new action needs
-- no new column.
--
-- There is one behaviour switch below and not two. An upstream "monitor_online"
-- column sat beside it ("wait for live_status = 1"), nothing in this build ever
-- read or wrote it, and v3 drops it: see the v3 step in db/migrations.ts for the
-- whole of that decision. Do not add a second switch that no code consults.
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     TEXT    NOT NULL,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  library_id   INTEGER          REFERENCES libraries(id) ON DELETE SET NULL,

  action       TEXT    NOT NULL DEFAULT 'send',   -- send | reconcile
  action_key   TEXT    NOT NULL DEFAULT '',       -- send_danmaku | sign_in | ...

  -- Platform-shaped target reference. For live rooms this is the real room id,
  -- not the URL slug. Empty for account-scoped actions.
  target_key   TEXT    NOT NULL DEFAULT '',
  target_title TEXT    NOT NULL DEFAULT '',

  -- Window and cadence
  start_time   INTEGER NOT NULL,
  end_time     INTEGER NOT NULL,
  interval     INTEGER NOT NULL,

  -- Lifecycle: waiting (not started) | offline (monitoring) | running |
  -- paused | done | canceled | failed
  status       TEXT    NOT NULL DEFAULT 'waiting',

  -- Progress
  cursor       INTEGER NOT NULL DEFAULT 0,   -- index of next bullet
  loop_count   INTEGER NOT NULL DEFAULT 0,   -- completed passes
  sent_count   INTEGER NOT NULL DEFAULT 0,   -- attempts this run
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,

  -- Behaviour switches
  salt_enabled    INTEGER NOT NULL DEFAULT 1,
  require_online  INTEGER NOT NULL DEFAULT 1,

  -- Cadence bookkeeping. Separate from updated_at, which other writes touch.
  last_sent_at INTEGER,

  -- Monitor bookkeeping
  last_live_status INTEGER,
  last_checked_at  INTEGER,
  last_error       TEXT NOT NULL DEFAULT '',

  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- ------------------------------------------------------------------ --
-- Which actions a user has switched on, per Platform.
--
-- Absence means off, and that is deliberate: a new action ships dark, and an
-- action that costs the account something -- Douyu's 打卡分鱼丸 spends 200 鱼丸 to
-- enter -- can only ever run because a person turned it on.
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS action_settings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   TEXT    NOT NULL,
  action_key TEXT    NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  -- Per-action knobs the Platform adapter understands, as JSON.
  options    TEXT    NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, platform, action_key)
);

-- ------------------------------------------------------------------ --
-- Per-send log, capped by retention rather than unbounded growth
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS send_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  content TEXT    NOT NULL,
  ok      INTEGER NOT NULL,
  code    INTEGER NOT NULL DEFAULT 0,
  error   TEXT    NOT NULL DEFAULT '',
  at      INTEGER NOT NULL
);

-- ------------------------------------------------------------------ --
-- Per-action run log. send_logs is shaped for Bullets; a reconcile run has no
-- Bullet, so it records what the Platform said instead.
--
-- "items" is the run's per-item detail as JSON: which 鱼吧 were signed, what the
-- check-in awarded. It is a text column rather than a child table because it is
-- display data read whole, always with the row it belongs to and never queried
-- across; see ActionItem in platform/types.ts for the shape being serialised.
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS action_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action_key TEXT    NOT NULL,
  target_key TEXT    NOT NULL DEFAULT '',
  outcome    TEXT    NOT NULL,   -- done | already | skipped | failed | blocked
  detail     TEXT    NOT NULL DEFAULT '',
  code       TEXT    NOT NULL DEFAULT '',
  items      TEXT    NOT NULL DEFAULT '[]',
  at         INTEGER NOT NULL
);

-- ------------------------------------------------------------------ --
-- Replacement rules ("反和谐"): applied to each bullet before sending.
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS replacement_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern    TEXT    NOT NULL,
  replacement TEXT   NOT NULL DEFAULT '',
  is_regex   INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- ------------------------------------------------------------------ --
-- Event feed for external consumers (the AstrBot notification plugin).
--
-- Append-only, consumed by cursor. The id column is the cursor rather than a
-- timestamp, because two events can share a millisecond and a timestamp cursor
-- would then either skip one or replay it forever.
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Machine-readable discriminator; see EventKind in repo/events.ts.
  kind       TEXT    NOT NULL,
  -- info | warning | error
  severity   TEXT    NOT NULL DEFAULT 'info',
  title      TEXT    NOT NULL,
  detail     TEXT    NOT NULL DEFAULT '',
  platform   TEXT    NOT NULL DEFAULT '',
  task_id    INTEGER,
  account_id INTEGER,
  created_at INTEGER NOT NULL
);

-- ------------------------------------------------------------------ --
-- Long-lived tokens for API consumers.
--
-- Only a hash is stored: a leaked database then yields no usable tokens, and
-- the plaintext exists exactly once, in the response that created it.
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS api_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL DEFAULT '',
  token_hash   TEXT    NOT NULL UNIQUE,
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL
);

-- ------------------------------------------------------------------ --
-- Bookkeeping
-- ------------------------------------------------------------------ --
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/**
 * Indexes. Created **after** every structural migration, never as part of `DDL`.
 *
 * Two reasons, both measured against a hand-built v1 database:
 *
 *  1. `CREATE INDEX ... ON tasks(platform, action)` names a column that only the
 *     new table has. `CREATE TABLE IF NOT EXISTS tasks` above it is a no-op on a
 *     v1 database, so that statement failed and `db.exec()` abandoned the rest of
 *     the string — `openDatabase` threw before a single migration step had run, so
 *     no v1 database could start at all. (The exec is not atomic: the statements
 *     before the failure had already been applied. They are all `IF NOT EXISTS`,
 *     which is what makes starting again after a failure safe.)
 *  2. `ALTER TABLE tasks RENAME TO tasks_v1` carries `tasks`'s indexes along under
 *     their original names. A `CREATE INDEX IF NOT EXISTS idx_tasks_status` issued
 *     while `tasks_v1` still existed was therefore a no-op, and the `DROP TABLE
 *     tasks_v1` at the end of the same step deleted the index — leaving the rebuilt
 *     `tasks` with no indexes at all, and with nothing to indicate it.
 *
 * Running them here fixes both: by this point the scratch table is gone, so every
 * index name is free again, and every column an index names exists. Do not fold
 * these back into `DDL`.
 */
export const INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_accounts_user_platform ON accounts(user_id, platform);
CREATE INDEX IF NOT EXISTS idx_libraries_user ON libraries(user_id);
CREATE INDEX IF NOT EXISTS idx_bullets_library_seq ON bullets(library_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_platform_action ON tasks(platform, action);
CREATE INDEX IF NOT EXISTS idx_action_settings_user ON action_settings(user_id, platform);
CREATE INDEX IF NOT EXISTS idx_send_logs_task_at ON send_logs(task_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_action_logs_task_at ON action_logs(task_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_replacement_rules_user ON replacement_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id, id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
`
