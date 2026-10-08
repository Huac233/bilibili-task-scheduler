import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

import { transaction } from '../db/tx.js'
import { asBoolean, asNumber, asNumberOrNull, asString } from '../db/values.js'
import { deleteEventsForTask } from './events.js'

/**
 * Scheduled tasks.
 *
 * A task is a shell: a Platform, an account, a target, a window, an interval, and
 * an action. Two things are deliberately separate:
 *
 *  - `action` names the **executor**. `send` consumes Bullets in order and has no
 *    completion condition; `reconcile` reads what the Platform reports as
 *    outstanding and finishes when nothing is. This is the only branch the
 *    scheduler has.
 *  - `actionKey` names the **concrete thing** that executor does on that Platform
 *    (`send_danmaku`, `sign_in`, `fishball`, ...). It is data, not a column per
 *    feature, so a new Platform action never reaches this file — and a `reconcile`
 *    task runs **exactly the action this names**, because a Task names one Action.
 *    See `findReconcileTask` for what that does to the row's identity.
 *
 * Progress for a `send` task is a cursor plus a completed-pass counter, not a
 * "messages sent" tally: rejected messages still advance the cursor (otherwise one
 * bad bullet blocks the queue forever), so a send count alone could not answer
 * "刷到第几遍了". A `reconcile` task uses neither and reads the Platform instead.
 */

export const TaskStatus = {
  /** Created, waiting for `start_time`. */
  Waiting: 'waiting',
  /** Inside the time window but the room is not live; monitoring. */
  Offline: 'offline',
  /** Actively working. */
  Running: 'running',
  Paused: 'paused',
  Done: 'done',
  Canceled: 'canceled',
  /** Stopped by an unrecoverable error (expired session, deleted room). */
  Failed: 'failed'
} as const
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus]

/** The executors. `actionKey` picks what each one actually does on a Platform. */
export const TaskAction = {
  Send: 'send',
  Reconcile: 'reconcile'
} as const
export type TaskAction = (typeof TaskAction)[keyof typeof TaskAction]

/** Action keys the built-in Platforms provide. Kept here so the scheduler can name them. */
export const ActionKey = {
  SendDanmaku: 'send_danmaku',
  SignIn: 'sign_in',
  Fishball: 'fishball',
  YubaSign: 'yuba_sign',
  ActivitySign: 'activity_sign',
  GrowthPool: 'growth_pool',
  Fishing: 'fishing',
  FanshomeSign: 'fanshome_sign',
  LikeDanmaku: 'like_danmaku',
  WatchLive: 'watch_live',
  /**
   * 把熄灭的粉丝牌重新点亮。与 `like_danmaku` 是两个目的：那个要点的是亲密度（熄灭的牌子不给），
   * 这个要的是点亮本身（熄灭正是它能动手的状态）。见 `platform/bilibili/index.ts` 里它的长注。
   */
  RelightMedal: 'relight_medal',
  /**
   * 一个房间当天到期的亲密度任务。与 `send_danmaku` 也是两个目的：那个要的是把文本读出去（发出去的弹幕
   * 顺带算完成任务），这个只读服务端报的任务清单、只结算不花钱的那部分。见 `platform/douyu/index.ts`
   * 里它的长注。
   */
  IntimacyTasks: 'intimacy_tasks',
  /**
   * 把即将过期的免费道具送进一个指定直播间。
   *
   * **它必须在这里，而且是这条规则唯一的一次**：adapter 的每一个动作都由这个表命名，清仓的
   * 收件房间来自偏好设置而不是任务的目标（`needsTarget: false`），所以这条映射是它被调度器
   * 指名、被 `action_settings`（键是 (人, 平台, 动作)）存下参数的唯一途径。见
   * `platform/douyu/index.ts` 里它自己的长注。
   */
  Clearout: 'clearout_props'
} as const
export type ActionKey = (typeof ActionKey)[keyof typeof ActionKey]

export interface Task {
  readonly id: number
  readonly userId: number
  readonly platform: string
  readonly accountId: number
  readonly libraryId: number | null
  readonly action: TaskAction
  readonly actionKey: string
  readonly targetKey: string
  readonly targetTitle: string
  readonly startTime: number
  readonly endTime: number
  readonly interval: number
  readonly status: TaskStatus
  readonly cursor: number
  readonly loopCount: number
  readonly sentCount: number
  readonly successCount: number
  readonly failCount: number
  readonly saltEnabled: boolean
  readonly requireOnline: boolean
  readonly lastSentAt: number | null
  readonly lastLiveStatus: number | null
  readonly lastCheckedAt: number | null
  readonly lastError: string
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Whether a stored value names a member of `TaskStatus`.
 *
 * `Object.values<string>` rather than the `readonly string[]` annotation this
 * used to carry: the widened array made `.includes` accept anything, so the
 * answer had to be asserted back with an `as` the check had just earned — and a
 * type predicate is the spelling that keeps the check and the narrowing in one
 * place.
 */
function isTaskStatus(value: string): value is TaskStatus {
  return Object.values<string>(TaskStatus).includes(value)
}

function toStatus(value: SQLOutputValue | undefined): TaskStatus {
  const raw = asString(value, TaskStatus.Waiting)
  return isTaskStatus(raw) ? raw : TaskStatus.Waiting
}

function toAction(value: SQLOutputValue | undefined): TaskAction {
  const raw = asString(value, TaskAction.Send)
  return raw === TaskAction.Reconcile ? TaskAction.Reconcile : TaskAction.Send
}

function toTask(row: Record<string, SQLOutputValue>): Task {
  return {
    id: asNumber(row['id']),
    userId: asNumber(row['user_id']),
    platform: asString(row['platform']),
    accountId: asNumber(row['account_id']),
    libraryId: asNumberOrNull(row['library_id']),
    action: toAction(row['action']),
    actionKey: asString(row['action_key']),
    targetKey: asString(row['target_key']),
    targetTitle: asString(row['target_title']),
    startTime: asNumber(row['start_time']),
    endTime: asNumber(row['end_time']),
    interval: asNumber(row['interval']),
    status: toStatus(row['status']),
    cursor: asNumber(row['cursor']),
    loopCount: asNumber(row['loop_count']),
    sentCount: asNumber(row['sent_count']),
    successCount: asNumber(row['success_count']),
    failCount: asNumber(row['fail_count']),
    saltEnabled: asBoolean(row['salt_enabled'], true),
    requireOnline: asBoolean(row['require_online'], true),
    lastSentAt: asNumberOrNull(row['last_sent_at']),
    lastLiveStatus: asNumberOrNull(row['last_live_status']),
    lastCheckedAt: asNumberOrNull(row['last_checked_at']),
    lastError: asString(row['last_error']),
    createdAt: asNumber(row['created_at']),
    updatedAt: asNumber(row['updated_at'])
  }
}

export interface CreateTaskInput {
  readonly platform: string
  readonly accountId: number
  readonly libraryId: number | null
  readonly action: TaskAction
  readonly actionKey: string
  /** Empty for account-scoped actions such as a daily check-in. */
  readonly targetKey: string
  readonly targetTitle: string
  readonly startTime: number
  readonly endTime: number
  readonly interval: number
  readonly saltEnabled: boolean
  readonly requireOnline: boolean
}

export function createTask(db: DatabaseSync, userId: number, input: CreateTaskInput, now = Date.now()): Task {
  // `monitor_online` used to be written here and the column is now gone: schema v3 dropped it
  // (`migrations.ts`'s `toV3`). It arrived with an upstream field set and nothing in this build ever
  // read it — the switch a person gets is `require_online`. It spent a while as a column kept only to
  // hold its `DEFAULT 1`; listing it here to write a constant was the same defect wearing a hat, which
  // is why it was dropped rather than filled in.
  const info = db
    .prepare(
      `INSERT INTO tasks (
         user_id, platform, account_id, library_id, action, action_key,
         target_key, target_title, start_time, end_time, interval, status,
         salt_enabled, require_online, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      input.platform,
      input.accountId,
      input.libraryId,
      input.action,
      input.actionKey,
      input.targetKey,
      input.targetTitle,
      input.startTime,
      input.endTime,
      input.interval,
      TaskStatus.Waiting,
      input.saltEnabled ? 1 : 0,
      input.requireOnline ? 1 : 0,
      now,
      now
    )

  const id = asNumber(info.lastInsertRowid)
  const task = getTaskById(db, id)
  if (task === null) throw new Error('task vanished immediately after insert')
  return task
}

export function listTasks(db: DatabaseSync, userId: number): Task[] {
  const rows = db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY id DESC').all(userId)
  return rows.map(toTask)
}

export function getTask(db: DatabaseSync, userId: number, taskId: number): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND id = ?').get(userId, taskId)
  return row === undefined ? null : toTask(row)
}

/** Unscoped lookup, used by the scheduler which has no request context. */
export function getTaskById(db: DatabaseSync, taskId: number): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
  return row === undefined ? null : toTask(row)
}

/**
 * The reconcile task for a user on a Platform, **a target**, and **an action**, if it exists.
 *
 * The target belongs to a reconcile task's *identity* rather than to its configuration, which is
 * worth spelling out because the alternative looks tidier and is wrong. Reconcile work is per
 * Platform **and per target** because a Platform's chores are not all account-scoped: Douyu's are —
 * one check-in, one 鱼吧 walk, all of it about the account, stored with an empty `target_key` —
 * while Bilibili's 亲密度 actions hang off one anchor's 粉丝牌 and are therefore per Room. A person
 * holding five medals has five separate sets of chores, and a row per (Platform, target) is what
 * lets each set be settled on its own: with one row per Platform, the other four rooms' chores would
 * have nowhere to run and the one round of them that did would be logged against the wrong target.
 *
 * **The action belongs to the identity for the same reason, and it is what the row now decides.**
 * `action_key` is authoritative: `runner.ts` hands the adapter the action the row names and nothing
 * else, so the same action on the same target is the same row — a second one would do that work
 * twice under a second task id — while a *different* action on the same Room is a different row,
 * because it is different work. The key was display only while a run carried every enabled action
 * of the Task's shape, and that is what made the column a person created a task by decide nothing:
 * a Task whose row said 「动作：亲密度任务」 also ran 粉丝家园钓鱼, both being per-Room.
 *
 * A row made under that older rule — keyed by (Platform, target) alone — keeps the action it was
 * created with and now runs only that one. Every other action that used to ride on it needs a Task
 * that names it, and the switches screen is where that is visible per action: it names the Tasks
 * that run the action and offers to create one where there are none.
 *
 * The create path asks this function first and reuses the row it finds.
 *
 * **The one thing it must never hand back is a row that can never run**, and the three statuses
 * outside its answer are two different reasons rather than one list. `canceled` and `failed` are a
 * Task a person stopped or an error stopped — work the setup asked for and something refused. `done`
 * is a Task that ran its time window to the end: `decide` answers `finish` once `now >= endTime`, and
 * `runner.ts` writes `done` for it. Neither is a row the sweep will take again — `listSchedulableTasks`
 * below explains why it must not be — so a create for this key has to write a **new** row rather than
 * resolve this one, or the action has no way back except deleting the dead row.
 *
 * **`paused` is deliberately *inside* the answer, and the count above is why it is worth saying so.**
 * It is four statuses of seven that this query does not exclude, and one of them — `paused` — is not in
 * `listSchedulableTasks` either, so the two sets differ by exactly that member. The difference is
 * correct rather than a drift to be "fixed": this question is "will this row ever run the action
 * again", and a paused Task will the moment somebody presses 恢复 (the status route allows
 * `paused → running`, and the tasks screen offers it). Excluding it here would not make the two sets
 * agree — it would make the create path hand back a *second* row for the same (Platform, target,
 * action) key, because `findReconcileTask` resolves the paused row, and then two rows would run one
 * job under two task ids, which is the duplicate work `findReconcileTask`'s key exists to prevent.
 * What the screen is called on to do about a paused carrier is say that it is paused, which the status
 * it already has carries.
 *
 * That is what it used to do, and the shape of the dead end is worth keeping: the action's settings
 * screen listed the finished row as one of the Tasks that run the action and withheld the create
 * beside it, while this lookup resolved the same key back to that row — so the one move that would
 * get the action running again was a delete nobody was told about.
 *
 * `done` therefore sits with the two stopped statuses although the reason differs, and the difference
 * is not one that changes the answer here: the question is *will this row ever run again*, and the
 * answer is no for all three. Where they do differ is what a person can do about it — and for a
 * `done` row the answer is the create this lookup stopped resolving backwards, because a `done` row
 * is terminal to the status route too: its hours cannot be edited (`只有暂停中的任务可以编辑`) and
 * 重置进度 clears its counters without reopening a window that has closed.
 */
export function findReconcileTask(
  db: DatabaseSync,
  userId: number,
  platform: string,
  targetKey: string,
  actionKey: string
): Task | null {
  const row = db
    .prepare(
      `SELECT * FROM tasks
       WHERE user_id = ? AND platform = ? AND target_key = ? AND action = ? AND action_key = ?
         AND status NOT IN (?, ?, ?)
       ORDER BY id ASC LIMIT 1`
    )
    .get(
      userId,
      platform,
      targetKey,
      TaskAction.Reconcile,
      actionKey,
      TaskStatus.Canceled,
      TaskStatus.Failed,
      TaskStatus.Done
    )
  return row === undefined ? null : toTask(row)
}

/**
 * Every Task of one Platform that names one action and can still run it — **whichever executor runs
 * it**.
 *
 * **The answer is not about reconcile tasks, and neither the name nor the SQL says it is any more.**
 * It filtered on `action = 'reconcile'` until it was asked a question the executor has nothing to do
 * with: the settings screen's 「指名这个动作的任务：」, which it puts to storage for *every* action in the
 * catalogue, `send` ones included. (The heading read 「会运行它的任务：」 until the words were narrowed to
 * the answer this function can actually give: it is the naming that is asked for here, and the reason
 * is below — a `paused` row stands on this list and the sweep leaves such a row alone, so the running
 * is not a thing the list can claim.) A `send` Task names its action in the same column and is by
 * construction a Task that runs it — `runner.ts`'s `runSend` looks the key up in the same catalogue
 * and hands it to `platform.send` — so filtering on the executor made the screen answer 「现在没有
 * 任何任务运行它」 about an action a live Task was running, and withhold the create beside it. Hence
 * `listCarrierTasksForAction`.
 *
 * **The same question `runner.ts` asks when it picks the work, put to storage**: the run carries the
 * action the row names, so the Tasks that run an action are the Tasks that name it. That equality is
 * what makes this a lookup on `action_key` rather than on a shape: an action switched on with no Task
 * naming it will not run, and the screen that shows the switch has to be able to say so.
 *
 * The *whole* set rather than the first row, because an action aimed at a target is carried by one
 * Task per target and the screen has to show all of them.
 *
 * `failed` and `canceled` are excluded for the reason `findReconcileTask` excludes them and says
 * there: a Task the scheduler gave up on, or one a person stopped, is not a Task that will run, so
 * returning it would let the caller report coverage that is not there.
 *
 * **`done` is excluded for the same reason, and it used to be kept.** The old answer had a cost, and
 * it is the defect this now fixes: a Task whose window has closed is absent from
 * `listSchedulableTasks`, so it never runs again — but it was still returned here, so the action it
 * names was shown as carried by a row that does not carry it, the create offer was withheld, and the
 * create path resolved that same key back to it. An action whose Task had finished could therefore
 * not be restarted at all without somebody guessing that a delete was the way out. The row is real
 * history and it is still listed on the tasks screen; what it cannot be is *coverage*.
 *
 * So the caller's list is the set of rows that can still run the action, and a row that has finished
 * is a **different fact about the same key** rather than a smaller carrier — which is why the settings
 * screen counts the finished ones with `listFinishedCarrierTasksForAction` and says so, instead of
 * this query hiding them by returning a shorter list with no explanation.
 *
 * **This is the storage question and deliberately not the whole of the screen's.** It answers with
 * every replayable row naming the action, one of which may be a row the run refuses: a Task whose own
 * target disagrees with the action's `needsTarget` is answered `failed` and never dispatched.
 * Repeating that shape rule in SQL would give it a second home in a second language, so the caller
 * filters this list through the runner's own rule — `scheduler/logic.ts`'s `actionStopFor`, which is
 * the executor-independent half of `reconcileSelectionFor` and the right one for a caller asking
 * about an **action** rather than about a reconcile run. Applying `reconcileSelectionFor` itself
 * would drop every `send` row: a `send` descriptor is not a Reconcile action, so that function
 * answers `unknown` for it by construction.
 *
 * What neither this nor `actionStopFor` asks is whether a row has *finished*, and that is
 * deliberate too: a row that ran its window out is not a row whose action is the wrong shape, and
 * `actionStopFor` is a judgement about the row's action and target rather than about when it is
 * allowed to run. That is the question the status answers, which is why the two are applied
 * separately — see the callers.
 */
export function listCarrierTasksForAction(
  db: DatabaseSync,
  userId: number,
  platform: string,
  actionKey: string
): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE user_id = ? AND platform = ? AND action_key = ?
         AND status NOT IN (?, ?, ?)
       ORDER BY id ASC`
    )
    .all(userId, platform, actionKey, TaskStatus.Canceled, TaskStatus.Failed, TaskStatus.Done)
  return rows.map(toTask)
}

/**
 * The Tasks of one Platform that name one action and have **run their window out**.
 *
 * The other half of `listCarrierTasksForAction`, and it exists so the count and the list cannot
 * drift: the same rows, one status apart. A caller holding both has the whole truth about a key —
 * these ran, those can still run — which is what the settings screen needs to say, in one sentence,
 * why an action has no carrier today and to offer the create that fixes it.
 *
 * **Executor-agnostic for the same reason its sibling is**, and the two must move together: 「跑完了
 * 窗口」 is `done`, and both executors write it (`runner.ts`'s `finishTask`, once `now >= endTime`) —
 * a `send` Task that ran its window out did run that action, thousands of times, and hiding it here
 * would make the screen say a key has no history while its record proves otherwise. One query
 * filtered `done` and the other `paused`-inclusive; that difference is the whole of the change.
 *
 * Only `done` is counted. `failed` and `canceled` rows are excluded from this answer as well, because
 * they are not Tasks that finished anything: the screen would be explaining a Task that was stopped,
 * which is a different sentence with a different remedy, and one this screen does not offer.
 */
export function listFinishedCarrierTasksForAction(
  db: DatabaseSync,
  userId: number,
  platform: string,
  actionKey: string
): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE user_id = ? AND platform = ? AND action_key = ? AND status = ?
       ORDER BY id ASC`
    )
    .all(userId, platform, actionKey, TaskStatus.Done)
  return rows.map(toTask)
}

/**
 * Deletes a Task and everything written about it.
 *
 * **The events are deleted explicitly because nothing else does it.** `send_logs` and `action_logs`
 * reference the task `ON DELETE CASCADE` and go with it; `events.task_id` has no foreign key, so a
 * bare `DELETE FROM tasks` left the feed pointing at a task that no longer exists — and `DELETE
 * /api/tasks/:id` calls exactly that and nothing else, which made `deleteEventsForTask`'s own
 * sentence ("Deleting a task removes its events, so the feed does not reference ghosts") describe a
 * program that did not exist.
 *
 * One transaction, because the two deletes are one fact: a crash between them leaves the dangling
 * reference this exists to prevent, and a "deleted" Task whose events are still on the feed.
 */
export function deleteTask(db: DatabaseSync, userId: number, taskId: number): boolean {
  return transaction(db, () => {
    const info = db.prepare('DELETE FROM tasks WHERE user_id = ? AND id = ?').run(userId, taskId)
    if (asNumber(info.changes) === 0) return false
    deleteEventsForTask(db, taskId)
    return true
  })
}

/**
 * Writes a Task's status.
 *
 * **`expected` is the check-and-set form, and it exists because the status can be decided from a row
 * that has already moved on.** `expected` is the status the caller made its decision from, and the
 * update then lands only while the row still holds it — one statement, which is the point; a caller
 * that re-read before writing would still have two steps with a window between them.
 *
 * Absent `expected` the write is unconditional, and a caller reaching for that is asserting a fact the
 * row's current status cannot invalidate. The scheduler's `failTask` is the one such caller: it
 * reports what a Platform just answered about a Task's account.
 *
 * Answers whether the statement changed the row, so `false` reads as "the row had moved" rather than
 * as a failure — information the caller has to act on, not swallow.
 */
export function updateTaskStatus(
  db: DatabaseSync,
  taskId: number,
  status: TaskStatus,
  error = '',
  now = Date.now(),
  expected?: TaskStatus
): boolean {
  const info =
    expected === undefined
      ? db
          .prepare('UPDATE tasks SET status = ?, last_error = ?, updated_at = ? WHERE id = ?')
          .run(status, error, now, taskId)
      : db
          .prepare('UPDATE tasks SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = ?')
          .run(status, error, now, taskId, expected)

  return asNumber(info.changes) === 1
}

export interface TaskProgress {
  readonly cursor: number
  readonly loopCount: number
  readonly sentCount: number
  readonly successCount: number
  readonly failCount: number
}

/**
 * Writes the counters after a send attempt — **only while the row is still the one the caller read**.
 *
 * `expected` is required rather than optional, and that is the design: the counters are computed from a
 * snapshot (`sentCount + 1` and friends), so a caller that has not said which snapshot it decided from
 * is a caller that cannot be answered. There is one such caller (`runner.ts`'s `sendOne`) and it hands
 * the row it read at the top of the sweep.
 *
 * **The row can move between that read and this write.** Everything between them is a walk over awaits,
 * and `await platform.send(…)` is seconds long, so 重置进度 or 恢复 can land in the middle — both clear
 * the counters, and an unconditional write put the pre-reset numbers straight back: a Task displaying
 * cursor 1 and 一次发送 that had never been re-run. `updateTaskStatus` gained the same fence in the same
 * round (`expected` there); this is the half that was left absolute, and the two disagreeing about one
 * stale snapshot is exactly what the fence removes.
 *
 * Answers whether the statement changed the row, so `false` reads as "the row had moved" — information
 * the caller has to act on rather than swallow, which is why it is a return value and not a silent
 * no-op.
 */
export function updateTaskProgress(
  db: DatabaseSync,
  taskId: number,
  progress: TaskProgress,
  expected: TaskProgress,
  now = Date.now()
): boolean {
  const info = db
    .prepare(
      `UPDATE tasks
       SET cursor = ?, loop_count = ?, sent_count = ?, success_count = ?, fail_count = ?, updated_at = ?
       WHERE id = ?
         AND cursor = ? AND loop_count = ? AND sent_count = ? AND success_count = ? AND fail_count = ?`
    )
    .run(
      progress.cursor,
      progress.loopCount,
      progress.sentCount,
      progress.successCount,
      progress.failCount,
      now,
      taskId,
      expected.cursor,
      expected.loopCount,
      expected.sentCount,
      expected.successCount,
      expected.failCount
    )

  return asNumber(info.changes) === 1
}

/** Stamps the cadence clock. Called after every attempt, success or not. */
export function updateTaskLastSent(db: DatabaseSync, taskId: number, now = Date.now()): void {
  db.prepare('UPDATE tasks SET last_sent_at = ?, updated_at = ? WHERE id = ?').run(now, now, taskId)
}

/** Records the result of one liveness probe, clearing any previous failure. */
export function updateTaskMonitor(db: DatabaseSync, taskId: number, liveStatus: number, now = Date.now()): void {
  db.prepare(
    'UPDATE tasks SET last_live_status = ?, last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?'
  ).run(liveStatus, now, '', now, taskId)
}

/**
 * Records why a probe could not be completed, without changing the task status.
 *
 * The sweep has a catch-all that logs and moves on. That is right for keeping
 * the loop alive, but it left the operator with no way to see that anything was
 * wrong: a task whose probes all fail just displays "尚未探测" forever. Writing
 * the reason onto the task surfaces it in the UI instead.
 */
export function updateTaskError(db: DatabaseSync, taskId: number, error: string, now = Date.now()): void {
  db.prepare('UPDATE tasks SET last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?').run(
    error,
    now,
    now,
    taskId
  )
}

/**
 * Clears the two clocks a fresh start retires: the cadence clock and the probe clock.
 *
 * One function because **two routes are answering the same question** — 恢复 (`PATCH` to `running`) and
 * 重置进度 — and they clear the same two for the same reason: `last_sent_at` would otherwise judge the
 * next send against an interval that partly elapsed while the Task was not running, and `last_checked_at`
 * would hold the live-status probe back for a timer that has already run. A second spelling of "the
 * clocks" is how one route ends up clearing one of the two, which is exactly what the reset route did
 * until now — it retired the counters and left the cadence clock pointing at the run before.
 */
export function clearTaskClocks(db: DatabaseSync, taskId: number): void {
  db.prepare('UPDATE tasks SET last_sent_at = NULL, last_checked_at = NULL WHERE id = ?').run(taskId)
}

/**
 * Resets the cursor so a finished task can be run again from the top.
 *
 * The clocks go with the counters: see `clearTaskClocks`. Leaving them meant 重置进度 answered
 * "started over" while the first send still waited out a cadence inherited from the run the person had
 * just discarded.
 */
export function resetTaskProgress(db: DatabaseSync, taskId: number, now = Date.now()): void {
  db.prepare(
    `UPDATE tasks
     SET cursor = 0, loop_count = 0, sent_count = 0, success_count = 0, fail_count = 0, updated_at = ?
     WHERE id = ?`
  ).run(now, taskId)
  clearTaskClocks(db, taskId)
}

/**
 * Tasks the scheduler should be looking at: the three states a sweep works on.
 *
 * **Not "everything that is not terminal", which is what this said before.** `paused` is not terminal —
 * the task list offers 恢复 on such a row — and it is deliberately outside this set: pausing a Task is
 * a person asking for nothing to happen to it, and the status route is the only way in and out.
 * `scheduler-live.test.ts` pins that behaviour, so the wording was what needed the fix rather than the
 * query.
 *
 * **`done` is outside this set for a reason somebody will sooner or later want to undo, so it is
 * written down here: a finished Task must not be reopened by adding it to this list.** `decide`
 * answers `finish` as soon as `now >= endTime`, and `done` is what it answers for a row whose window
 * has already closed — so sweeping it again would re-assert the same verdict once per pass, at the
 * cost of a write each time, and the row would flicker between live and finished while doing it. The
 * one state such a row is in is "its window ended", and the interface is being made to say exactly
 * that rather than to hide it: the action's settings screen counts these rows as Tasks that ran their
 * window out instead of as Tasks running the action (`listFinishedCarrierTasksForAction`, plus the
 * create offer that comes back with it), and the tasks screen offers 重置进度, which clears the
 * counters and sets `waiting` **without touching the hours** — so a finished Task whose window is
 * still closed becomes finished again on the next sweep. The move that really restarts one is a new
 * row with a new window, which is the create this change unblocks. Widening this query is not a third
 * move; it is the same dead end with extra writes.
 *
 * The ordering is what makes a sweep's order stable from one pass to the next. The `LIMIT` this used to
 * mention went with the per-user cap: every non-terminal row this returns is swept, and no caller
 * passes a limit.
 */
export function listSchedulableTasks(db: DatabaseSync): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE status IN (?, ?, ?)
       ORDER BY id ASC`
    )
    .all(TaskStatus.Waiting, TaskStatus.Offline, TaskStatus.Running)
  return rows.map(toTask)
}
