import { describe, expect, it } from 'vitest'

import type { ActionDescriptor } from '../src/platform/types.js'
import { TaskAction } from '../src/repo/tasks.js'
import {
  actionStopFor,
  decide,
  isRoomLive,
  MONITOR_POLL_INTERVAL_MS,
  reconcileSelectionFor,
  shouldPollNow,
  statusForAction
} from '../src/scheduler/logic.js'

const base = {
  now: 1_000_000,
  startTime: 0,
  endTime: 2_000_000,
  interval: 10,
  lastSentAt: null as number | null,
  requireOnline: true,
  liveStatus: 1 as number | null
}

describe('decide', () => {
  it('waits before the start time', () => {
    expect(decide({ ...base, startTime: base.now + 1 }).kind).toBe('wait')
  })

  it('finishes at or after the end time', () => {
    expect(decide({ ...base, endTime: base.now }).kind).toBe('finish')
    expect(decide({ ...base, endTime: base.now - 1 }).kind).toBe('finish')
  })

  it('checks the window before online state, so a closed window still finishes', () => {
    const action = decide({ ...base, endTime: base.now - 1, liveStatus: 0 })
    expect(action.kind).toBe('finish')
  })

  it('monitors when the room is offline and online gating is on', () => {
    expect(decide({ ...base, liveStatus: 0 }).kind).toBe('monitor')
  })

  it('monitors when the live status has never been checked', () => {
    expect(decide({ ...base, liveStatus: null }).kind).toBe('monitor')
  })

  it('treats the round-replay state as not live', () => {
    expect(decide({ ...base, liveStatus: 2 }).kind).toBe('monitor')
  })

  it('sends when live and nothing has been sent yet', () => {
    expect(decide({ ...base, lastSentAt: null }).kind).toBe('send')
  })

  it('cools down while the interval has not elapsed', () => {
    const action = decide({ ...base, lastSentAt: base.now - 4_000, interval: 10 })
    expect(action.kind).toBe('cooldown')
    if (action.kind === 'cooldown') expect(action.remainingMs).toBe(6_000)
  })

  it('sends once the interval has fully elapsed', () => {
    expect(decide({ ...base, lastSentAt: base.now - 10_000, interval: 10 }).kind).toBe('send')
  })

  it('sends immediately when online gating is off, even while offline', () => {
    expect(decide({ ...base, requireOnline: false, liveStatus: 0, lastSentAt: null }).kind).toBe('send')
  })

  it('does not let a stale cooldown block the first send after going live', () => {
    // Never sent before, so no cooldown applies regardless of the clock.
    expect(decide({ ...base, liveStatus: 1, lastSentAt: null }).kind).toBe('send')
  })

  it('treats a zero interval as no cooldown', () => {
    expect(decide({ ...base, lastSentAt: base.now, interval: 0 }).kind).toBe('send')
  })
})

/**
 * A descriptor carrying only the three fields the rule reads.
 *
 * The rest are the neutral values a real catalogue would never use together
 * (`maxMessageLength: 0` on a send action, say) on purpose: a case that started passing because
 * of a cadence or a length would be asserting something this rule has no business deciding.
 *
 * At module scope because two rules are asked about the same catalogue: the executor-scoped
 * `reconcileSelectionFor` below, and `actionStopFor` — which is the half of it that a `send`
 * descriptor reaches, and the reason the two blocks share one descriptor builder rather than two.
 */
const action = (key: string, taskAction: TaskAction, needsTarget: boolean): ActionDescriptor => ({
  key,
  action: taskAction,
  label: key,
  description: '',
  costly: false,
  needsTarget,
  needsLibrary: false,
  maxMessageLength: 0,
  defaultIntervalSeconds: 60,
  minIntervalSeconds: 1
})

/** Bilibili's shape in miniature: two chores that need a Room, one about the account, and a send. */
const catalogue = [
  action('like_danmaku', TaskAction.Reconcile, true),
  action('watch_live', TaskAction.Reconcile, true),
  action('relight_medal', TaskAction.Reconcile, false),
  action('send_danmaku', TaskAction.Send, true)
]

describe('reconcileSelectionFor', () => {
  it('carries the action the row names, and only that one', () => {
    expect(reconcileSelectionFor(catalogue, { actionKey: 'like_danmaku', targetKey: '12306' }, true)).toEqual({
      kind: 'run',
      actionKey: 'like_danmaku'
    })
  })

  it('does not run a neighbouring switched-on action of the same shape', () => {
    // The owner's own report, in the two actions he named: 「为什么创建亲密度任务会去粉丝家园钓鱼」.
    // Both are per-Room, so both used to match a Room's Task; the row names one, so one runs.
    const perRoom = [
      action('intimacy_tasks', TaskAction.Reconcile, true),
      action('fishing', TaskAction.Reconcile, true)
    ]

    expect(reconcileSelectionFor(perRoom, { actionKey: 'intimacy_tasks', targetKey: '12306' }, true)).toEqual({
      kind: 'run',
      actionKey: 'intimacy_tasks'
    })
    expect(reconcileSelectionFor(perRoom, { actionKey: 'fishing', targetKey: '12306' }, true)).toEqual({
      kind: 'run',
      actionKey: 'fishing'
    })
  })

  it('carries an account-scoped action on a row with no target, whatever else is switched on', () => {
    expect(reconcileSelectionFor(catalogue, { actionKey: 'relight_medal', targetKey: '' }, true)).toEqual({
      kind: 'run',
      actionKey: 'relight_medal'
    })
  })

  it('answers `unknown` for a key this build’s catalogue does not declare', () => {
    expect(reconcileSelectionFor(catalogue, { actionKey: 'gone_action', targetKey: '12306' }, true)).toEqual({
      kind: 'unknown',
      actionKey: 'gone_action'
    })
  })

  it('answers `unknown` for a Send action named by a reconcile row', () => {
    // A row whose executor and action disagree can only be hand-made, and no executor could run it:
    // the send path would refuse to consume Bullets under a reconcile task, and this one has none.
    expect(reconcileSelectionFor(catalogue, { actionKey: 'send_danmaku', targetKey: '12306' }, true)).toEqual({
      kind: 'unknown',
      actionKey: 'send_danmaku'
    })
  })

  it('reports a switch that is off, naming it, rather than running nothing quietly', () => {
    const selection = reconcileSelectionFor(catalogue, { actionKey: 'like_danmaku', targetKey: '12306' }, false)

    expect(selection.kind).toBe('stopped')
    if (selection.kind !== 'stopped') return
    // `blocked`, not `skipped`: the action is parked and worth attempting again, which is what the
    // settle rule needs to see — a settled outcome would freeze the day and make flipping the switch
    // on do nothing until the Platform's tomorrow.
    expect(selection.report.outcome).toBe('blocked')
    expect(selection.report.code).toBe('switch_off')
    expect(selection.report.actionKey).toBe('like_danmaku')
    // The switch is named in the words the settings screen uses for it.
    expect(selection.report.detail).toContain('like_danmaku')
    expect(selection.report.detail).toContain('动作开关')
  })

  it('reports a target-scoped action whose row carries no target', () => {
    const selection = reconcileSelectionFor(catalogue, { actionKey: 'like_danmaku', targetKey: '' }, true)

    expect(selection.kind).toBe('stopped')
    if (selection.kind !== 'stopped') return
    expect(selection.report.outcome).toBe('failed')
    expect(selection.report.code).toBe('missing_target')
  })

  it('reports an account-scoped action whose row carries a target', () => {
    // The reverse direction, which the create route says nothing about: a row can still be built by
    // hand this way, and it is reported rather than reinterpreted.
    const selection = reconcileSelectionFor(catalogue, { actionKey: 'relight_medal', targetKey: '12306' }, true)

    expect(selection.kind).toBe('stopped')
    if (selection.kind !== 'stopped') return
    expect(selection.report.outcome).toBe('failed')
    expect(selection.report.code).toBe('unexpected_target')
    // No identifier in a sentence a person reads.
    expect(selection.report.detail).not.toContain('12306')
  })

  it('reports the misconfiguration rather than the switch when both apply', () => {
    // Turning the switch on cannot fix a row that could never run this action, so naming the switch
    // would send somebody to do something that changes nothing.
    const selection = reconcileSelectionFor(catalogue, { actionKey: 'relight_medal', targetKey: '12306' }, false)

    expect(selection.kind).toBe('stopped')
    if (selection.kind !== 'stopped') return
    expect(selection.report.code).toBe('unexpected_target')
  })

  it('leaves a Platform whose reconcile actions are all one shape alone', () => {
    // Every Douyu chore is account-scoped, so each has its own Task with an empty target — which is
    // the case that must not become a filtering casualty.
    const douyu = [
      action('check_in', TaskAction.Reconcile, false),
      action('fishball', TaskAction.Reconcile, false),
      action('send_danmaku', TaskAction.Send, true)
    ]
    expect(reconcileSelectionFor(douyu, { actionKey: 'check_in', targetKey: '' }, true)).toEqual({
      kind: 'run',
      actionKey: 'check_in'
    })
    expect(reconcileSelectionFor(douyu, { actionKey: 'fishball', targetKey: '' }, true)).toEqual({
      kind: 'run',
      actionKey: 'fishball'
    })
  })
})

/**
 * `actionStopFor` — the switch and the shape, judged without asking which executor runs it.
 *
 * Split out of `reconcileSelectionFor` for the settings screen, which asks about an **action**: a
 * `send` descriptor is not a Reconcile action, so the executor-scoped function answers `unknown` for
 * every `send` row, and a screen filtering carriers through it would drop them all.
 *
 * The reason the case above this block is not enough on its own: `reconcileSelectionFor` cannot be
 * asked about a `send` Action at all, so "a send Task is a carrier" is only expressible here.
 */
describe('actionStopFor', () => {
  const send = { actionKey: 'send_danmaku', targetKey: '12306' }
  const accountScoped = { actionKey: 'check_in', targetKey: '' }

  it('is null when the row and its Action agree and the switch is on', () => {
    expect(actionStopFor(action('send_danmaku', TaskAction.Send, true), send, true)).toBeNull()
    expect(actionStopFor(action('check_in', TaskAction.Reconcile, false), accountScoped, true)).toBeNull()
  })

  it('names a missing target as a failure, before the switch is even looked at', () => {
    // The order is deliberate: a row that could not run this Action with the switch on is not a row
    // the switch turns on, and saying "the switch is off" about it sends somebody to flip a switch and
    // watch nothing change.
    const report = actionStopFor(action('send_danmaku', TaskAction.Send, true), { ...send, targetKey: '' }, false)

    expect(report?.code).toBe('missing_target')
    expect(report?.outcome).toBe('failed')
  })

  it('names a target on an account-scoped Action the same way round', () => {
    const report = actionStopFor(
      action('check_in', TaskAction.Reconcile, false),
      { ...accountScoped, targetKey: '9' },
      true
    )

    expect(report?.code).toBe('unexpected_target')
    expect(report?.outcome).toBe('failed')
  })

  it('parks a switch that is off as blocked, in the one sentence both executors use', () => {
    const report = actionStopFor(action('check_in', TaskAction.Reconcile, false), accountScoped, false)

    expect(report?.code).toBe('switch_off')
    expect(report?.outcome).toBe('blocked')
    expect(String(report?.detail)).toContain('动作开关')
  })
})

describe('isRoomLive', () => {
  it('is true only for status 1', () => {
    expect(isRoomLive(1)).toBe(true)
    expect(isRoomLive(0)).toBe(false)
    expect(isRoomLive(2)).toBe(false)
    expect(isRoomLive(null)).toBe(false)
  })
})

describe('shouldPollNow', () => {
  it('polls when never checked', () => {
    expect(shouldPollNow(null, 5_000)).toBe(true)
  })

  it('polls once the poll interval has passed', () => {
    expect(shouldPollNow(0, MONITOR_POLL_INTERVAL_MS)).toBe(true)
    expect(shouldPollNow(0, MONITOR_POLL_INTERVAL_MS - 1)).toBe(false)
  })

  it('honours an explicit poll interval', () => {
    expect(shouldPollNow(1_000, 2_000, 500)).toBe(true)
    expect(shouldPollNow(1_000, 1_400, 500)).toBe(false)
  })
})

describe('statusForAction', () => {
  it('maps each action to the status the UI shows', () => {
    expect(statusForAction({ kind: 'wait' })).toBe('waiting')
    expect(statusForAction({ kind: 'finish' })).toBe('done')
    expect(statusForAction({ kind: 'monitor' })).toBe('offline')
    expect(statusForAction({ kind: 'cooldown', remainingMs: 1 })).toBe('running')
    expect(statusForAction({ kind: 'send' })).toBe('running')
  })
})
