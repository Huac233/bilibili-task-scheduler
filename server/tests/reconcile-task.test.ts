import { describe, expect } from 'vitest'

import type { Db } from '../src/db/index.js'
import { upsertAccount } from '../src/repo/accounts.js'
import {
  createTask,
  findReconcileTask,
  listCarrierTasksForAction,
  listFinishedCarrierTasksForAction,
  listSchedulableTasks,
  type Task,
  TaskAction,
  TaskStatus,
  updateTaskStatus
} from '../src/repo/tasks.js'
import { createUser } from '../src/repo/users.js'
import { test as base } from './fixtures.js'

/**
 * A reconcile task's identity.
 *
 * This is the lookup the create path asks before inserting, and it is keyed by (Platform, **target**,
 * **action**). Both halves of the key beyond the Platform look like mistakes, so both are pinned here:
 *
 *  - the **target** — Douyu's chores are all account-scoped and carry an empty `target_key`, while a
 *    Platform whose chores hang off one 粉丝牌 needs one row per Room. Five medals are five separate
 *    daily lists, and one row per Platform would give four of them nowhere to run.
 *  - the **action** — a reconcile Task runs exactly the action its own row names, so a second action
 *    on the same Room is a different job rather than a duplicate of the first. Ignoring the action here
 *    is what used to make a create for a second action hand back the row that already existed.
 *
 * The rows are seeded through the repositories — `createUser` and `upsertAccount` — rather
 * than by hand-written INSERTs, because `node:sqlite` enforces foreign keys: what these
 * tasks need is a real user and a real account, and the functions that make one already
 * exist.
 */

const HOUR = 60 * 60 * 1000
const NOW = 1_791_411_776_000

interface Desk {
  readonly userId: number
  readonly accountId: number
}

const it = base.extend<{ desk: Desk }>({
  desk: async ({ db }, use) => {
    const user = createUser(db, 'tester', 'x', NOW)
    const account = upsertAccount(db, user.id, {
      platform: 'douyu',
      externalId: '456918967',
      displayName: '主号',
      avatar: '',
      credentials: '{}'
    })

    await use({ userId: user.id, accountId: account.id })
  }
})

function taskInput(
  desk: Desk,
  overrides: Partial<Parameters<typeof createTask>[2]> = {}
): Parameters<typeof createTask>[2] {
  return {
    platform: 'bilibili',
    accountId: desk.accountId,
    libraryId: null,
    action: TaskAction.Reconcile,
    actionKey: 'like_danmaku',
    // Empty for an account-scoped action, which is what every Douyu chore is.
    targetKey: '',
    targetTitle: '',
    startTime: NOW - HOUR,
    endTime: NOW + 24 * HOUR,
    interval: 300,
    saltEnabled: true,
    requireOnline: false,
    ...overrides
  }
}

function reconcileTask(db: Db, desk: Desk, overrides: Partial<Parameters<typeof createTask>[2]> = {}): Task {
  return createTask(db, desk.userId, taskInput(desk, overrides), NOW)
}

/**
 * Inserts one row with the values a case names, and defaults for the rest.
 *
 * A terminal row cannot be *made* through the routes: the create path rejects an action with no
 * target, and no route writes `done` — the sweep does, when the window closes. So a case about what a
 * terminal row does to the next create states the one fact it is about, rather than reproducing a
 * procedure whose other steps belong to `scheduler-live.test.ts`'s cases. `createTask` is not used
 * for it because that function always writes `waiting`.
 */
function insertRow(db: Db, desk: Desk, values: Record<string, string | number>): number {
  const info = db
    .prepare(
      `INSERT INTO tasks (
         user_id, platform, account_id, library_id, action, action_key,
         target_key, target_title, start_time, end_time, interval, status,
         salt_enabled, require_online, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      desk.userId,
      String(values['platform'] ?? 'bilibili'),
      desk.accountId,
      null,
      String(values['action'] ?? TaskAction.Reconcile),
      String(values['action_key'] ?? 'like_danmaku'),
      String(values['target_key'] ?? ''),
      String(values['target_title'] ?? ''),
      Number(values['start_time'] ?? NOW - HOUR),
      Number(values['end_time'] ?? NOW + 24 * HOUR),
      Number(values['interval'] ?? 300),
      String(values['status'] ?? TaskStatus.Running),
      1,
      0,
      NOW,
      NOW
    )
  return Number(info.lastInsertRowid)
}

describe('findReconcileTask', () => {
  it('finds an account-scoped chore list by its Platform, its empty target, and its action', ({ db, desk }) => {
    const created = reconcileTask(db, desk, { platform: 'douyu', actionKey: 'sign_in' })

    expect(findReconcileTask(db, desk.userId, 'douyu', '', 'sign_in')?.id).toBe(created.id)
    // A target it does not have is not this task: the lookup is exact, not a fallback.
    expect(findReconcileTask(db, desk.userId, 'douyu', '12306', 'sign_in')).toBeNull()
    expect(findReconcileTask(db, desk.userId, 'bilibili', '', 'sign_in')).toBeNull()
    // Nor is a different action on the same pair: that is other work, and its own row.
    expect(findReconcileTask(db, desk.userId, 'douyu', '', 'fishball')).toBeNull()

    const other = createUser(db, 'someone-else', 'x', NOW)
    expect(findReconcileTask(db, other.id, 'douyu', '', 'sign_in')).toBeNull()
  })

  it('keeps one chore list per target, which is what a per-Room action needs', ({ db, desk }) => {
    const first = reconcileTask(db, desk, { targetKey: '12306', targetTitle: '一号房间' })
    const second = reconcileTask(db, desk, { targetKey: '45977', targetTitle: '二号房间' })

    // Two rows for one person on one Platform: a 亲密度 chore list hangs off one anchor's
    // 粉丝牌, so the second room is not a duplicate of the first — it is a different job.
    expect(first.id).not.toBe(second.id)
    expect(findReconcileTask(db, desk.userId, 'bilibili', '12306', 'like_danmaku')?.id).toBe(first.id)
    expect(findReconcileTask(db, desk.userId, 'bilibili', '45977', 'like_danmaku')?.id).toBe(second.id)
  })

  it('keeps one chore list per action on one target, which is what replaces the old rule', ({ db, desk }) => {
    // 亲密度任务 and 粉丝家园钓鱼: one Room, two actions, and two rows — a Task runs exactly the action it
    // names, so these are two jobs and not one job done twice. Under the old (Platform, target) key the
    // second create would have been handed `intimacy`'s row and 钓鱼's Task would not exist at all.
    const intimacy = reconcileTask(db, desk, { actionKey: 'intimacy_tasks', targetKey: '12306' })
    const fishing = reconcileTask(db, desk, { actionKey: 'fishing', targetKey: '12306' })

    expect(intimacy.id).not.toBe(fishing.id)
    expect(findReconcileTask(db, desk.userId, 'bilibili', '12306', 'intimacy_tasks')?.id).toBe(intimacy.id)
    expect(findReconcileTask(db, desk.userId, 'bilibili', '12306', 'fishing')?.id).toBe(fishing.id)
  })

  it('answers the oldest live row for one key, so reusing one is stable', ({ db, desk }) => {
    const first = reconcileTask(db, desk, { platform: 'douyu', actionKey: 'sign_in' })
    const second = reconcileTask(db, desk, { platform: 'douyu', actionKey: 'sign_in' })

    // Two rows for the same key only exist if something inserted them directly. The answer is the
    // first, because a create-or-get that answered differently on each call would create a new row
    // every time.
    expect(findReconcileTask(db, desk.userId, 'douyu', '', 'sign_in')).toMatchObject({ id: first.id })
    expect(second.id).toBeGreaterThan(first.id)
  })

  it('never answers with a task that has stopped, so the work can be recreated', ({ db, desk }) => {
    const created = reconcileTask(db, desk, { platform: 'douyu', actionKey: 'sign_in' })

    for (const status of [TaskStatus.Canceled, TaskStatus.Failed]) {
      updateTaskStatus(db, created.id, status, '', NOW)
      expect(findReconcileTask(db, desk.userId, 'douyu', '', 'sign_in')).toBeNull()
    }
  })

  /**
   * The owner's regression, stated as a task: **a row that has run its window out is terminal too**,
   * so the next create for that key must not be handed the dead row.
   *
   * The window is deliberately still open at `NOW`. A row that reached `done` and whose hours have
   * already passed is the ordinary case, and it is the *easy* one: the create route would hand back
   * the same dead row either way, and only the second case below shows that the answer is about the
   * row rather than about the clock.
   */
  it('never answers with a task whose window has run out, so the work can be restarted', ({ db, desk }) => {
    const finished = reconcileTask(db, desk, { platform: 'douyu', actionKey: 'sign_in' })
    updateTaskStatus(db, finished.id, TaskStatus.Done, '', NOW)

    expect(findReconcileTask(db, desk.userId, 'douyu', '', 'sign_in')).toBeNull()

    // And the row the create path then writes is one the sweep will actually take — which is the
    // whole point of refusing to hand the dead one back.
    const made = reconcileTask(db, desk, { platform: 'douyu', actionKey: 'sign_in' })
    expect(made.id).not.toBe(finished.id)
    expect(listSchedulableTasks(db).map(task => task.id)).toContain(made.id)
  })

  /**
   * The same answer for a row whose window would be *current* right now.
   *
   * This is the case somebody "fixing" the sweep would be tempted to create: a `done` row sitting
   * inside its own window looks like a row that was finished too early, and sweeping it again is the
   * obvious repair. It is not one — `done` is terminal, and hours that happen to cover the instant
   * again do not undo the verdict, because the status route refuses to edit a Task that is not paused
   * and 重置进度 clears counters without reopening a closed window. `listSchedulableTasks` is asked
   * here directly, because that is the question `runner.ts` puts to storage on every pass and the
   * answer has to stay "no" whichever way the hours read.
   */
  it('leaves a done row out of the sweep even when its window would be current', ({ db, desk }) => {
    const finished = insertRow(db, desk, { status: TaskStatus.Done, start_time: NOW - HOUR, end_time: NOW + HOUR })

    expect(listSchedulableTasks(db).map(task => task.id)).not.toContain(finished)
    expect(findReconcileTask(db, desk.userId, 'bilibili', '', 'like_danmaku')).toBeNull()
  })

  /**
   * The storage half of what the settings screen says about one key.
   *
   * `listCarrierTasksForAction` answers with every row that can still run the action — the same
   * question the screen puts to it — so both halves of the fix are asserted together here: a `done`
   * row is in neither answer, and the live row beside it is still there.
   */
  it('stops offering a done row as one of the action’s Tasks, and keeps offering the live one', ({ db, desk }) => {
    const finished = reconcileTask(db, desk, { actionKey: 'like_danmaku', targetKey: '12306' })
    updateTaskStatus(db, finished.id, TaskStatus.Done, '', NOW)
    const live = reconcileTask(db, desk, { actionKey: 'like_danmaku', targetKey: '45977' })

    expect(listCarrierTasksForAction(db, desk.userId, 'bilibili', 'like_danmaku').map(task => task.id)).toEqual([
      live.id
    ])
  })

  /**
   * A **send** Task is a carrier of the action it names, which the query used to filter out.
   *
   * The settings screen puts 「指名这个动作的任务：」 to storage for every action in the catalogue, `send`
   * ones included, and that is the claim the list can support: the Tasks that name the action. (The
   * heading read 「会运行它的任务：」 until the running claim was taken off it, because a `paused` row
   * stands on that list and never runs — `repo/tasks.ts`'s `listCarrierTasksForAction` has the whole
   * reason.) A `send` Task names its action in the same column and
   * `runner.ts`'s `runSend` looks that key up in the same catalogue and hands it to `platform.send`.
   * Filtering on the executor made the screen answer 「现在没有任何任务运行它」 about an action a live
   * Task was running, and withhold the create beside it.
   *
   * The same filter is gone from the finished half, and for the same reason: 「跑完了窗口」 is `done`,
   * which both executors write.
   */
  it('counts a send Task as one of the action’s Tasks, and as one that ran its window out', ({ db, desk }) => {
    const sending = createTask(
      db,
      desk.userId,
      taskInput(desk, { action: TaskAction.Send, actionKey: 'send_danmaku', targetKey: '12306' }),
      NOW
    )

    expect(listCarrierTasksForAction(db, desk.userId, 'bilibili', 'send_danmaku').map(task => task.id)).toEqual([
      sending.id
    ])

    updateTaskStatus(db, sending.id, TaskStatus.Done, '', NOW)

    expect(listCarrierTasksForAction(db, desk.userId, 'bilibili', 'send_danmaku')).toEqual([])
    expect(listFinishedCarrierTasksForAction(db, desk.userId, 'bilibili', 'send_danmaku').map(task => task.id)).toEqual(
      [sending.id]
    )
  })

  it('is not confused by a send task on the same Platform and target', ({ db, desk }) => {
    createTask(
      db,
      desk.userId,
      taskInput(desk, { action: TaskAction.Send, actionKey: 'send_danmaku', targetKey: '12306' }),
      NOW
    )

    // A send loop targets a Room as well, and has nothing to do with the chore list.
    expect(findReconcileTask(db, desk.userId, 'bilibili', '12306', 'send_danmaku')).toBeNull()
  })
})
