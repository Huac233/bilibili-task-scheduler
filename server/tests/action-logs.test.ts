import { describe, expect } from 'vitest'

import type { Db } from '../src/db/index.js'
import { startOfPlatformDay } from '../src/platform/time.js'
import type { ActionItem } from '../src/platform/types.js'
import {
  ActionOutcome,
  appendActionLog,
  clearActionLogs,
  hasActionLogWithCodeSince,
  listActionLogDays,
  listActionLogs,
  listActionLogsBefore,
  listActionLogsSince,
  pruneActionLogs,
  settledActionKeysSince,
  summarizeActionLogs
} from '../src/repo/action-logs.js'
import { ActionKey } from '../src/repo/tasks.js'
import { test as it } from './fixtures.js'

/**
 * The reconcile run log.
 *
 * `send_logs` records Bullets being sent; a reconcile run has no Bullet, so it
 * records what the Platform said about each action instead. What has to hold is
 * that an operator can answer "为什么今天没签到" from this table alone — which
 * action, which target, what came back — and that the counters add up to the
 * rows they claim to describe.
 *
 * `items` is the second half of that question. One row per action is right for
 * "did it run", and wrong for "what did it do": a 鱼吧 walk signs thirty groups and
 * writes one row. The items are where those thirty facts live once the console
 * line has scrolled away, so the column is exercised for what it stores, what it
 * does when it cannot read something, and how a day of it is read back.
 */

const HOUR = 60 * 60 * 1000

/** 2026-03-10 00:00:00 CST, exactly — a fixed instant, since the boundary is the subject. */
const CST_MIDNIGHT = Date.parse('2026-03-09T16:00:00Z')

/**
 * The Platform day the *container's* clock is in when this file runs.
 *
 * The difference from `CST_MIDNIGHT` is what `pruneActionLogs` does with the rows: it never deletes a
 * row from the current Platform day, however many there are, and it prunes everything older down to the
 * newest 500. A case about a day that holds more rows than a read's cap has to be on the current day,
 * or the pruning that happens on the 50th write would delete the rows and the cap would never be the
 * thing under test.
 */
const TODAY = startOfPlatformDay(Date.now())

// The user, the account and the tasks every case below writes against. A hook rather
// than a line in a `beforeEach` beside a `let db`: asking for `db` is what opens the
// database, so the fixture the cases declare is the same one this seeds.
it.beforeEach(({ db }) => {
  seed(db)
})

function seed(db: Db): void {
  db.prepare("INSERT INTO users (username, password_hash, created_at, updated_at) VALUES ('tester', 'x', 0, 0)").run()
  db.prepare(
    `INSERT INTO accounts (user_id, platform, external_id, display_name, avatar, credentials, meta, created_at, updated_at)
     VALUES (1, 'douyu', '456918967', '主号', '', '{}', '{}', 0, 0)`
  ).run()
  db.prepare(
    `INSERT INTO tasks (
       id, user_id, platform, account_id, library_id, action, action_key, target_key, target_title,
       start_time, end_time, interval, status, created_at, updated_at
     ) VALUES (1, 1, 'douyu', 1, NULL, 'reconcile', 'sign_in', '', '', 0, 86400000, 86400, 'running', 0, 0)`
  ).run()
  db.prepare(
    `INSERT INTO tasks (
       id, user_id, platform, account_id, library_id, action, action_key, target_key, target_title,
       start_time, end_time, interval, status, created_at, updated_at
     ) VALUES (2, 1, 'douyu', 1, NULL, 'reconcile', 'fishball', '', '', 0, 86400000, 86400, 'running', 0, 0)`
  ).run()
}

describe('ActionOutcome', () => {
  it('names exactly the five outcomes a reconcile run can report', () => {
    // The same five are the `outcome` field of `ActionOutcome` in
    // `platform/types.ts`. If an adapter grows a sixth, this fails before the
    // log does — an unmapped outcome would otherwise be stored and rendered as
    // something it is not.
    expect(Object.values(ActionOutcome)).toEqual(['done', 'already', 'skipped', 'failed', 'blocked'])
  })
})

describe('appendActionLog', () => {
  it('stores one row per action and lists them newest first', ({ db }) => {
    const at = 1_700_000_000_000

    appendActionLog(
      db,
      { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done, detail: '客户端签到', code: '0' },
      at
    )
    appendActionLog(
      db,
      { taskId: 1, actionKey: ActionKey.Fishball, outcome: ActionOutcome.Already, detail: '今日已领', code: '6305' },
      at + 1000
    )

    const logs = listActionLogs(db, 1)
    expect(logs).toHaveLength(2)
    expect(logs[0]?.actionKey).toBe(ActionKey.Fishball)
    expect(logs[0]?.outcome).toBe(ActionOutcome.Already)
    expect(logs[0]?.code).toBe('6305')
    expect(logs[0]?.at).toBe(at + 1000)
    expect(logs[1]?.actionKey).toBe(ActionKey.SignIn)
    expect(logs[1]?.outcome).toBe(ActionOutcome.Done)
  })

  it('defaults the optional columns instead of writing null into NOT NULL', ({ db }) => {
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.YubaSign, outcome: ActionOutcome.Skipped })

    const log = listActionLogs(db, 1)[0]
    expect(log?.targetKey).toBe('')
    expect(log?.detail).toBe('')
    expect(log?.code).toBe('')
  })

  it('keeps a target for an action that has one, and an empty one for an action that does not', ({ db }) => {
    appendActionLog(db, {
      taskId: 1,
      actionKey: ActionKey.FanshomeSign,
      targetKey: '9999',
      outcome: ActionOutcome.Done,
      code: '200'
    })
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done })

    const logs = listActionLogs(db, 1)
    expect(logs[0]?.targetKey).toBe('')
    expect(logs[1]?.targetKey).toBe('9999')
  })

  it('is scoped to its task', ({ db }) => {
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done })

    expect(listActionLogs(db, 1)).toHaveLength(1)
    expect(listActionLogs(db, 2)).toEqual([])
  })
})

describe('listActionLogs', () => {
  it('clamps the limit rather than trusting it', ({ db }) => {
    for (let i = 0; i < 3; i += 1) {
      appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done }, 1000 + i)
    }

    expect(listActionLogs(db, 1, 2)).toHaveLength(2)
    expect(listActionLogs(db, 1, 0)).toHaveLength(1)
    expect(listActionLogs(db, 1, -5)).toHaveLength(1)
  })
})

describe('summarizeActionLogs', () => {
  it('counts every outcome, and reports an unreadable one as a failure', ({ db }) => {
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done })
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done })
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.YubaSign, outcome: ActionOutcome.Already })
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.Fishball, outcome: ActionOutcome.Blocked })
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.Fishing, outcome: ActionOutcome.Failed })

    // Written by a build that knew an outcome this one does not. It must not be
    // counted as anything that reads like success, and it must not vanish from
    // the summary either: `failed` is the remainder, so the parts still add up
    // to `total`, exactly as `listActionLogs` reads the same row back.
    db.prepare(
      "INSERT INTO action_logs (task_id, action_key, target_key, outcome, detail, code, at) VALUES (1, 'fishing', '', 'paused_by_platform', '', '', 0)"
    ).run()

    const summary = summarizeActionLogs(db, 1)
    expect(summary).toEqual({
      total: 6,
      done: 2,
      already: 1,
      skipped: 0,
      failed: 2,
      blocked: 1
    })
    expect(summary.done + summary.already + summary.skipped + summary.failed + summary.blocked).toBe(summary.total)
    expect(listActionLogs(db, 1).filter(log => log.outcome === ActionOutcome.Failed)).toHaveLength(2)
  })

  it('returns zeroes for a task that has not run yet', ({ db }) => {
    expect(summarizeActionLogs(db, 2)).toEqual({
      total: 0,
      done: 0,
      already: 0,
      skipped: 0,
      failed: 0,
      blocked: 0
    })
  })

  it('counts one task at a time', ({ db }) => {
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done })
    appendActionLog(db, { taskId: 2, actionKey: ActionKey.Fishball, outcome: ActionOutcome.Failed })

    expect(summarizeActionLogs(db, 1).total).toBe(1)
    expect(summarizeActionLogs(db, 2).total).toBe(1)
  })
})

describe('items', () => {
  it('stores an action’s items and reads them back unchanged', ({ db }) => {
    const items: ActionItem[] = [
      { kind: 'group', label: '主版块', outcome: 'done', detail: '签到成功，等级分 +3。', code: '200' },
      { kind: 'group', label: '安卓版块', outcome: 'already', detail: '今天已经签到过了。', code: '1001' }
    ]

    appendActionLog(db, { taskId: 1, actionKey: ActionKey.YubaSign, outcome: ActionOutcome.Done, items })

    expect(listActionLogs(db, 1)[0]?.items).toEqual(items)
  })

  it('reads a row written without them as "named nothing", not as a column that is missing', ({ db }) => {
    // The scheduler always passes a list, so this is what every row written before
    // the column existed looks like — and it has to read the same as a run that
    // genuinely had nothing to name, or every reader needs a branch for it.
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done })

    expect(listActionLogs(db, 1)[0]?.items).toEqual([])
  })

  it('drops an item it cannot read rather than the whole row', ({ db }) => {
    db.prepare(
      `INSERT INTO action_logs (task_id, action_key, target_key, outcome, detail, code, items, at)
       VALUES (1, 'yuba_sign', '', 'done', '鱼吧签到：2 个版块', '', ?, 1500)`
    ).run(
      JSON.stringify([
        { kind: 'group', label: '主版块', outcome: 'done', detail: '签到成功。', code: '200' },
        // Not an object at all.
        'nonsense',
        // A kind this build does not know, so the UI has no icon for it.
        { kind: 'planet', label: '未知', outcome: 'done', detail: '', code: '' },
        // A shape that is missing a field the item cannot be built without.
        { kind: 'group', label: 7, outcome: 'done', detail: '', code: '' },
        // An outcome written by a newer build: it must not read as a success, which
        // is the same rule the row's own outcome is read by.
        { kind: 'group', label: '安卓版块', outcome: 'paused_by_platform', detail: '', code: '' }
      ])
    )

    const log = listActionLogs(db, 1)[0]
    // The row itself is untouched: an item is evidence about the run, never the
    // run's verdict, so an unreadable one may not cost the verdict.
    expect(log?.detail).toBe('鱼吧签到：2 个版块')
    expect(log?.items).toEqual([
      { kind: 'group', label: '主版块', outcome: 'done', detail: '签到成功。', code: '200' },
      { kind: 'group', label: '安卓版块', outcome: 'failed', detail: '', code: '' }
    ])
  })

  it('reads a column that is not JSON at all as an empty list', ({ db }) => {
    db.prepare(
      "INSERT INTO action_logs (task_id, action_key, target_key, outcome, detail, code, items, at) VALUES (1, 'sign_in', '', 'done', '', '', 'not json', 1500)"
    ).run()

    expect(listActionLogs(db, 1)[0]?.items).toEqual([])
  })
})

describe('reading a day of it', () => {
  /** Five rows, and where each sits relative to the Platform's midnight is the input. */
  function seedAroundMidnight(db: Db): void {
    appendActionLog(
      db,
      { taskId: 1, actionKey: ActionKey.GrowthPool, outcome: ActionOutcome.Done },
      CST_MIDNIGHT - 25 * HOUR
    )
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done }, CST_MIDNIGHT - 1000)
    appendActionLog(
      db,
      {
        taskId: 1,
        actionKey: ActionKey.YubaSign,
        outcome: ActionOutcome.Done,
        items: [{ kind: 'group', label: '主版块', outcome: 'done', detail: '签到成功。', code: '200' }]
      },
      CST_MIDNIGHT + 1000
    )
    appendActionLog(
      db,
      { taskId: 1, actionKey: ActionKey.Fishball, outcome: ActionOutcome.Failed },
      CST_MIDNIGHT + 2000
    )
  }

  it('counts what retention left behind, which is not a history that is no longer there', ({ db }) => {
    // `routes/tasks.ts` used to call this number the task's *whole history*; what it counts is the
    // retained window, and the two only agree until something is pruned. Two older days of rows with the
    // cap set to three states which one it is — and the direction matters, because "the counters say 10 and
    // the list shows 3" is the disagreement a reader would have to explain away.
    const older = (index: number): number => CST_MIDNIGHT - 48 * HOUR + index * 1000
    for (let index = 0; index < 10; index += 1) {
      appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done }, older(index))
    }

    expect(summarizeActionLogs(db, 1).total).toBe(10)

    pruneActionLogs(db, 1, 3, TODAY)

    const summary = summarizeActionLogs(db, 1)
    expect(summary.total).toBe(3)
    // The parts still add up to the whole of what is left, which is the property `summarizeActionLogs`
    // derives `failed` for.
    expect(summary.done).toBe(3)
    expect(summary.failed).toBe(0)
    expect(listActionLogs(db, 1).map(log => log.at)).toEqual([older(9), older(8), older(7)])
  })

  it('takes a range from one instant, oldest first', ({ db }) => {
    seedAroundMidnight(db)

    expect(listActionLogsSince(db, 1, CST_MIDNIGHT).map(log => log.actionKey)).toEqual([
      ActionKey.YubaSign,
      ActionKey.Fishball
    ])
    // A second earlier and the row written a second before midnight is in scope: the
    // bound is the day's, and the answer moves with it rather than with the clock.
    expect(listActionLogsSince(db, 1, CST_MIDNIGHT - 2000).map(log => log.actionKey)).toEqual([
      ActionKey.SignIn,
      ActionKey.YubaSign,
      ActionKey.Fishball
    ])
  })

  it('keeps the day’s newest rows when the day holds more than the cap', ({ db }) => {
    // A Task parked for a Platform day at a one-minute cadence writes about 1,440 rows, and the
    // interface answers 「为什么刚刚没成」 from the last of them: a cap applied to the day's *oldest*
    // 500 rows returns the morning and loses exactly the row the question is about. The rows are on the
    // current Platform day so retention keeps all of them (see `TODAY`).
    const ROWS = 600
    for (let i = 0; i < ROWS; i += 1) {
      appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Failed }, TODAY + i * 1000)
    }

    const today = listActionLogsSince(db, 1, TODAY, 500)

    expect(today).toHaveLength(500)
    // The newest row of the day survives, and what was dropped is the day's beginning.
    expect(today[499]?.at).toBe(TODAY + (ROWS - 1) * 1000)
    expect(today[0]?.at).toBe(TODAY + (ROWS - 500) * 1000)
    // Still read forwards: the caller's question is "what happened today", and only the *selection* had
    // to be made from the day's end.
    expect(today[0]?.at).toBeLessThan(today[499]?.at ?? 0)
  })

  it('keeps every row at the cap and loses exactly the day’s first one past it', ({ db }) => {
    // The boundary the 600-row case above cannot state, and the number a cap is: at the cap nothing is
    // dropped, one row past it exactly one row goes, and the one that goes is the day's **earliest**. A
    // reader that lost the newest instead, or that truncated at a different number, would still pass the
    // 600-row case — which is why the cap is pinned from both sides here rather than from one.
    const CAP = 500
    for (let i = 0; i < CAP; i += 1) {
      appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Failed }, TODAY + i * 1000)
    }

    const atCap = listActionLogsSince(db, 1, TODAY, CAP)
    expect(atCap).toHaveLength(CAP)
    expect(atCap[0]?.at).toBe(TODAY)

    appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Failed }, TODAY + CAP * 1000)

    const past = listActionLogsSince(db, 1, TODAY, CAP)
    expect(past).toHaveLength(CAP)
    // `TODAY` itself is the row that went; everything after it stayed, and the newest is still the newest.
    expect(past[0]?.at).toBe(TODAY + 1000)
    expect(past[CAP - 1]?.at).toBe(TODAY + CAP * 1000)
  })

  it('carries the items of a day’s records, which is the whole point of reading it back', ({ db }) => {
    seedAroundMidnight(db)

    const today = listActionLogsSince(db, 1, CST_MIDNIGHT)
    expect(today[0]?.items).toEqual([
      { kind: 'group', label: '主版块', outcome: 'done', detail: '签到成功。', code: '200' }
    ])
  })

  it('takes everything before one instant, newest first', ({ db }) => {
    seedAroundMidnight(db)

    expect(listActionLogsBefore(db, 1, CST_MIDNIGHT).map(log => log.actionKey)).toEqual([
      ActionKey.SignIn,
      ActionKey.GrowthPool
    ])
  })

  it('groups earlier records into the Platform days they happened on', ({ db }) => {
    seedAroundMidnight(db)

    const days = listActionLogDays(db, 1, CST_MIDNIGHT)

    // Newest day first — the order the history section is read in — with each day's
    // records in the order they happened, since that is the order a day is read in.
    expect(days.map(day => day.dayKey)).toEqual(['2026-03-09', '2026-03-08'])
    expect(days[0]?.startedAt).toBe(CST_MIDNIGHT - 24 * HOUR)
    expect(days[0]?.records.map(log => log.actionKey)).toEqual([ActionKey.SignIn])
    expect(days[1]?.startedAt).toBe(CST_MIDNIGHT - 48 * HOUR)
    expect(days[1]?.records.map(log => log.actionKey)).toEqual([ActionKey.GrowthPool])

    // Today is not in here: it belongs to `listActionLogsSince`, and a day appearing
    // in both is exactly how a UI ends up showing it twice.
    expect(days.some(day => day.dayKey === '2026-03-10')).toBe(false)
  })

  it('says nothing about a task whose records are all today', ({ db }) => {
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done }, CST_MIDNIGHT + 1)

    expect(listActionLogDays(db, 1, CST_MIDNIGHT)).toEqual([])
  })
})

/**
 * Whether an action's day is over, which is one judgement and used to be two.
 *
 * `settledActionKeysSince` excluded `failed` and `blocked` by name in its SQL while `toOutcome` read
 * anything it did not recognise as `failed`, so a row written by a build that knew an outcome this one
 * does not was a failure to a reader and a finished day to the cadence. The consumer is
 * `runner.ts`'s `settledToday`, which stops asking the Platform about that action for the rest of the
 * day on the strength of the second reading.
 */
describe('settledActionKeysSince', () => {
  it('does not settle a day on an outcome this build does not recognise', ({ db }) => {
    // The same value `summarizeActionLogs` above is given, and it is read as `failed` there — the
    // comment on `toOutcome` is explicit that it must never be counted as "it worked".
    db.prepare(
      "INSERT INTO action_logs (task_id, action_key, target_key, outcome, detail, code, at) VALUES (1, 'sign_in', '', 'paused_by_platform', '', '', ?)"
    ).run(TODAY + 1000)

    expect(settledActionKeysSince(db, 1, TODAY)).toEqual([])
    expect(listActionLogs(db, 1)[0]?.outcome).toBe(ActionOutcome.Failed)
  })

  it('settles a known finish, and leaves a refusal or a parked action open', ({ db }) => {
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done }, TODAY + 1000)
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.Fishball, outcome: ActionOutcome.Blocked }, TODAY + 2000)
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.YubaSign, outcome: ActionOutcome.Failed }, TODAY + 3000)
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.GrowthPool, outcome: ActionOutcome.Already }, TODAY + 4000)

    expect(settledActionKeysSince(db, 1, TODAY)).toEqual([ActionKey.GrowthPool, ActionKey.SignIn].sort())
  })

  it('leaves a row written before the range out of it', ({ db }) => {
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done }, TODAY - 1)

    expect(settledActionKeysSince(db, 1, TODAY)).toEqual([])
  })
})

/**
 * The bound on a standing report.
 *
 * A standing condition is written once per Platform day, and the bound has to be read off the record
 * rather than off the Task's cadence clock: a successful run stamps that clock too, so a report bounded
 * by it disappears on the day the Task already ran — which is the day somebody is most likely to be
 * asking why nothing is happening. Bounded by `code` as well as by action, so an adapter's own row can
 * neither suppress a report nor be read as one.
 */
describe('hasActionLogWithCodeSince', () => {
  it('answers for that code, that action and that task, from that instant on', ({ db }) => {
    appendActionLog(
      db,
      { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Blocked, code: 'switch_off' },
      TODAY + 1000
    )

    expect(hasActionLogWithCodeSince(db, 1, ActionKey.SignIn, 'switch_off', TODAY)).toBe(true)
    // The instant is exclusive of everything before it, which is how one Platform day is asked about.
    expect(hasActionLogWithCodeSince(db, 1, ActionKey.SignIn, 'switch_off', TODAY + 1000)).toBe(true)
    expect(hasActionLogWithCodeSince(db, 1, ActionKey.SignIn, 'switch_off', TODAY + 1001)).toBe(false)
    // Another action on the same Task, another Task, and another code are all different questions.
    expect(hasActionLogWithCodeSince(db, 1, ActionKey.Fishball, 'switch_off', TODAY)).toBe(false)
    expect(hasActionLogWithCodeSince(db, 2, ActionKey.SignIn, 'switch_off', TODAY)).toBe(false)
    expect(hasActionLogWithCodeSince(db, 1, ActionKey.SignIn, 'missing_target', TODAY)).toBe(false)
  })
})

describe('retention', () => {
  it('prunes all but the newest rows and says how many went', ({ db }) => {
    for (let i = 0; i < 5; i += 1) {
      appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done }, 1000 + i)
    }

    expect(pruneActionLogs(db, 1, 2)).toBe(3)

    const kept = listActionLogs(db, 1)
    expect(kept).toHaveLength(2)
    expect(kept[0]?.at).toBe(1004)
    expect(kept[1]?.at).toBe(1003)
  })

  it('clears one task without touching another', ({ db }) => {
    appendActionLog(db, { taskId: 1, actionKey: ActionKey.SignIn, outcome: ActionOutcome.Done })
    appendActionLog(db, { taskId: 2, actionKey: ActionKey.Fishball, outcome: ActionOutcome.Done })

    expect(clearActionLogs(db, 1)).toBe(1)
    expect(listActionLogs(db, 1)).toEqual([])
    expect(listActionLogs(db, 2)).toHaveLength(1)
  })
})
