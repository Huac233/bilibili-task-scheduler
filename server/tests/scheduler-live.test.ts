import { describe, expect } from 'vitest'

import { isLive } from '../src/bilibili/live.js'
import type { BuiltServer } from '../src/index.js'
import { platformFor, registerPlatform } from '../src/platform/registry.js'
import { dayKeyOf } from '../src/platform/time.js'
import type {
  ActionDescriptor,
  ActionOutcome,
  FailureKind,
  ProbeResult,
  ReconcileContext,
  RefreshResult,
  SendOutcome
} from '../src/platform/types.js'
import { listAccountsByPlatform } from '../src/repo/accounts.js'
import { appendActionLog } from '../src/repo/action-logs.js'
import { listSendLogs } from '../src/repo/send-logs.js'
import { TaskAction, TaskStatus } from '../src/repo/tasks.js'
import { Scheduler } from '../src/scheduler/runner.js'
import { test as base, registerUser, type Session } from './fixtures.js'

/**
 * Regression tests for three defects found in real use, plus the reconcile settle rule.
 *
 * 1. **A task kept sending after the stream ended.** The live-status probe lived
 *    inside the `monitor` branch of `processTask`, so once a task promoted to
 *    `running` nothing ever re-checked the room: the cached status stayed "live"
 *    and the loop kept sending into a finished stream. The fix hoisted the probe
 *    out and made it unconditional, ahead of the cooldown check.
 *
 * 2. **A task could not be edited after creation.** PATCH only accepted a status
 *    change. It now also takes the scheduling fields — but only while paused,
 *    because editing a running task races the sweep that is already mid-send.
 *
 * 3. **A reconcile task re-ran its whole chore list every interval.** At the
 *    adapters' 300 s default that is 288 rounds a day, each making several requests
 *    whose only possible answer is "already done today" — the most conspicuous thing
 *    this program does to a rate-limiting Platform. `settledToday` reads our own
 *    `action_logs` for the Platform's day before asking again, and the
 *    `reconcile — one run per day` block below is what pins that.
 *
/**
 * 4. **A reconcile run carried every enabled action of the task's shape.** That was the second
 *    correction of the same rule and it was still wrong, because the row's own `action_key` — the
 *    one a person created the task by, and the one the UI shows as 「动作：亲密度任务」 — decided
 *    nothing: 亲密度任务 and 粉丝家园钓鱼 are both per-Room, so a task for one ran both. A run now
 *    carries **the action its Task names, and only that one**, with the shape surviving as a
 *    validation that reports a row which cannot run its own action. The
 *    `reconcile — a run carries the action its Task names` block below pins that, in both
 *    directions, together with the switch that is off and the schedule that must not go quiet.
 *
 * **What changed with the Platform seam.** These tests used to mock
 * `bilibili/live.js` and let the scheduler call `resolveRoom`/`sendDanmaku`
 * directly; the scheduler does not import those any more — it asks
 * `platform/registry.js` for the adapter named on the task and drives it through
 * `Platform`. So the seam is what gets driven here: a stub Platform reports the
 * liveness and the graded failures, and this file asserts what the *scheduler*
 * does with them. That is both more direct (the states under test — `liveStatus`,
 * `FailureKind` — are constructed rather than coaxed out of one Platform's HTTP
 * shapes) and a stronger claim: the key below is registered by nobody else, so a
 * scheduler that had kept any Bilibili-shaped shortcut would fail every case.
 *
 * The grader itself is the adapter's business now. Bilibili decides that a dead
 * session is `account_stop` by asking `/nav`; the scheduler only has to act on the
 * verdict, which is what the `probe failures` block below pins.
 *
 * **And the account has two verdicts, not one.** An expired session and a restricted
 * account both end the task and are two different messages to the person, because re-binding
 * clears the first and does not clear the second. The `account-level failures` block pins
 * that pair in both directions — including the direction that is easy to lose, a genuine
 * `-101` expiry staying an expiry — so the two kinds cannot be folded back into one, which is
 * how `EventKind.AccountRestricted` came to have no writer at all.
 */

/**
 * The stub Platform's identity.
 *
 * Registered at module scope, and unique to this file: `registry.ts` has no way to
 * unregister, so a shared key would leak a stub into whichever file ran next in
 * the same process.
 */
const PLATFORM_KEY = 'testplatform'
const ACTION_KEY = 'test_send'

/**
 * Two reconcile actions, not one.
 *
 * `settledToday` is per action and per day, so "a second action was switched on with
 * nothing recorded for it today" can only be expressed with a second key — and that
 * is the case a task-level "already ran today" flag would fail.
 */
const RECONCILE_ACTION = 'test_reconcile'
const SECOND_RECONCILE_ACTION = 'test_reconcile_second'

/**
 * A reconcile action that **needs a Target**, so that a Task's own room-scoped work is a thing this
 * file can state.
 *
 * Bilibili is the Platform this mirrors: its 点赞 and 观看直播 hang off one anchor's 粉丝牌 and are per
 * Room, while its 点亮粉丝牌 reads the account's whole medal list and carries no target. A stub with
 * only the account-scoped action could not tell "the runner carried what the row named" from "the
 * row's action happened to be the only one switched on", which is the difference the cases below
 * rest on.
 */
const TARGET_RECONCILE_ACTION = 'test_reconcile_target'

/**
 * The second per-Room reconcile action, so that "two Tasks on one room, naming different actions"
 * is a case this file can state.
 *
 * Bilibili is what this mirrors: 亲密度任务 and 粉丝家园钓鱼 are both per-Room, which is exactly the
 * pair the owner reported — a Task created for one of them ran the other. One per-Room action alone
 * could not tell "the runner carried only what the row named" from "there was nothing else on".
 */
const SECOND_TARGET_RECONCILE_ACTION = 'test_reconcile_target_second'

/** The credential blob the adapter is handed. Opaque here — that is the contract. */
const CREDENTIALS = '{"token":"seed-token","did":"seed-device"}'

/** Liveness the stub's next probe reports; each test sets its own. */
function liveProbe(liveStatus: number): ProbeResult {
  return { ok: true, liveStatus, title: '', code: '0', detail: '', failure: 'none' }
}

function failedProbe(code: string, detail: string, failure: FailureKind): ProbeResult {
  return { ok: false, liveStatus: 0, title: '', code, detail, failure }
}

/**
 * A probe the test answers by hand — the seam the `a pause the sweep has already read past` block
 * interleaves through.
 *
 * That window needs **nothing added to the shipping code** to reach, which is the point of reaching it
 * this way: `probe` is an awaited call on a Platform this file already owns, so a stub that stays
 * unanswered holds the sweep exactly where the defect lives — after it has read its snapshot and
 * before it writes anything decided from that snapshot. `reached` is what makes the interleave
 * deterministic rather than a race the rest of the file has to be lucky to observe: the test waits for
 * the sweep to be *inside* the probe before it acts.
 */
interface HangingProbe {
  /** The plan the stub reads for this probe, pending until `release`. */
  readonly plan: () => Promise<ProbeResult>
  /** Resolves once the sweep is inside the probe, so the test can act in the window. */
  readonly reached: Promise<void>
  /** Answers the probe, letting a sweep that has already read its snapshot carry on. */
  readonly release: (result: ProbeResult) => void
}

function hangingProbe(): HangingProbe {
  let announce: () => void = () => {}
  const reached = new Promise<void>(resolve => {
    announce = resolve
  })
  let answer: (result: ProbeResult) => void = () => {}

  return {
    plan: () =>
      new Promise<ProbeResult>(resolve => {
        answer = resolve
        announce()
      }),
    reached,
    release: result => {
      answer(result)
    }
  }
}

/** A plan that answers the same way for every action it is asked about. */
function planOf(outcome: ActionOutcome['outcome'], failure: FailureKind = 'none') {
  return (context: ReconcileContext): Promise<ActionOutcome[]> =>
    Promise.resolve(
      context.enabledActions.map(actionKey => ({
        actionKey,
        // Empty: these are account-scoped actions, and the adapter says so by
        // naming no target.
        targetKey: '',
        outcome,
        detail: `stub ${outcome}`,
        code: 'stub',
        failure,
        // The scheduler writes these straight to `action_logs.items`, so the stub
        // carries one: a plan that reported the run without its parts would exercise
        // a shape no real adapter produces.
        items: [{ kind: 'account', label: 'stub', outcome, detail: `stub ${outcome}`, code: 'stub' }]
      }))
    )
}

/**
 * What the stub answers when it is handed an action of the wrong shape for the task.
 *
 * The shape guard is the **stub's own**, in the stub's own words, and that is the correction: this
 * function used to repeat two of `platform/bilibili/index.ts`'s refusal sentences verbatim, so the file
 * read as if something checked that the adapters still said them when nothing did — the strings were
 * connected by nothing but a copy, and an adapter that reworded its refusal would leave this file
 * describing an answer nobody gives. What the cases below need is not the adapters' wording but *an*
 * answer of the wrong shape, and they assert what they actually check: the refusal is not dispatched, and
 * the codes it would have carried are absent (`loggedCodes(...)`). The adapters' own guards, and their
 * sentences, are pinned in their own files, against their own wire data.
 *
 * A key it agrees with answers `done`, which is the answer the settle rule reads as "this action's
 * day is over". That matters for the per-day cases: `failed` would keep the day open for ever, so a
 * plan that refused everything would make a re-sweep look like the settle rule working.
 */
function shapeGuardPlan(context: ReconcileContext): Promise<ActionOutcome[]> {
  const hasTarget = context.targetKey !== ''
  return Promise.resolve(
    context.enabledActions.map(actionKey => {
      // An unknown key is not this plan's subject; answering "shape agrees" keeps it the
      // stub's own `done` rather than inventing a second refusal.
      const needsTarget = STUB_ACTIONS.find(action => action.key === actionKey)?.needsTarget ?? hasTarget
      const item = (outcome: ActionOutcome['outcome'], detail: string, code: string): ActionOutcome['items'] => [
        { kind: 'account', label: 'stub', outcome, detail, code }
      ]

      if (needsTarget === hasTarget) {
        return {
          actionKey,
          targetKey: context.targetKey,
          outcome: 'done',
          detail: 'stub done',
          code: '0',
          failure: 'none',
          items: item('done', 'stub done', '0')
        }
      }

      return needsTarget
        ? {
            actionKey,
            targetKey: context.targetKey,
            outcome: 'failed',
            detail: 'stub：这个动作要房间，但这一轮没有目标',
            code: 'bad_target',
            failure: 'action_stop',
            items: item('failed', 'stub：这个动作要房间，但这一轮没有目标', 'bad_target')
          }
        : {
            actionKey,
            targetKey: context.targetKey,
            outcome: 'skipped',
            detail: 'stub：这个动作是账号级的，但这一轮带着房间',
            code: 'not_account_scoped',
            failure: 'action_stop',
            items: item('skipped', 'stub：这个动作是账号级的，但这一轮带着房间', 'not_account_scoped')
          }
    })
  )
}

/**
 * The stub Platform's state, as one typed object.
 *
 * `registerPlatform` runs once, at module scope, so the closures it installs can only
 * read module state. That much was already true; what was wrong was the *shape* of
 * that state — seven separate `let`s that this file's `beforeEach` re-assigned one by
 * one, with nothing tying the declarations to the reset. A field added on one side and
 * forgotten on the other carries the previous case's value into the next one, silently.
 * `freshStub()` is the reset, and its return type makes the list exhaustive: a new
 * field is a compile error until the reset knows about it.
 */
interface Stub {
  /** What the stub's next probe reports; each case sets its own. */
  probePlan: () => Promise<ProbeResult>
  probeCalls: number
  /**
   * What the stub's next send answers, and it is a plan rather than a constant because the sentences
   * the interface shows for a rejection come from here: the Platform's own code is what `send_logs`
   * has to end up holding, and a stub that could only succeed could not tell "the code was kept" from
   * "the code was a literal".
   */
  sendPlan: () => Promise<SendOutcome>
  sendCalls: number
  seenCredentials: string
  /** What the stub's next reconcile run reports, one entry per action it was asked about. */
  reconcilePlan: (context: ReconcileContext) => Promise<ActionOutcome[]>
  reconcileCalls: number
  /**
   * One increment per run each action key was handed over in.
   *
   * A key that never appears was never invoked, which is the assertion `reconcileCalls` cannot
   * make: a run that carried the wrong key and a run that carried the right one are one call.
   */
  dispatched: Record<string, number>
  /** The last context the scheduler handed over, so the day it announced is assertable. */
  lastReconcileContext: ReconcileContext | null
  /** What the stub's next session renewal answers. `not_required` unless a case says otherwise. */
  refreshPlan: () => Promise<RefreshResult>
}

/**
 * The state every case starts from: a live room, and a reconcile run that settles.
 *
 * `done` for everything asked about is what the settle tests below then take away one
 * action at a time.
 */
function freshStub(): Stub {
  return {
    probePlan: async () => liveProbe(1),
    probeCalls: 0,
    sendPlan: async () => ({ ok: true, code: '0', detail: '', failure: 'none' }),
    sendCalls: 0,
    seenCredentials: '',
    reconcilePlan: planOf('done'),
    reconcileCalls: 0,
    dispatched: {},
    lastReconcileContext: null,
    refreshPlan: async () => ({ status: 'not_required', detail: 'stub' })
  }
}

/**
 * A `const` object, not a fresh one per test: the Platform registered below captures
 * this exact reference, so replacing it would leave those closures reading a state
 * object no test can reach. The reset mutates it in place instead.
 */
const stub: Stub = freshStub()

/**
 * The stub's catalogue, as a value rather than an inline array.
 *
 * `shapeGuardPlan` reads `needsTarget` off the descriptors the Platform registered, and a second
 * copy of that field would be one fact with two homes: the copy the plan read would be free to
 * disagree with the copy the runner filters on, and the disagreement would read as a passing test.
 */
const STUB_ACTIONS: readonly ActionDescriptor[] = [
  {
    key: ACTION_KEY,
    action: TaskAction.Send,
    label: '测试发送',
    description: '给调度器一个 Send 动作，行为由测试决定。',
    costly: false,
    needsTarget: true,
    needsLibrary: true,
    maxMessageLength: 20,
    defaultIntervalSeconds: 10,
    /** The stub schedules at its own default, so the floor only has to not exceed it. */
    minIntervalSeconds: 1
  },
  {
    key: RECONCILE_ACTION,
    action: TaskAction.Reconcile,
    label: '测试对账',
    description: '给调度器一个 Reconcile 动作，行为由测试决定。',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    /**
     * One second, and that is the point of it: a test must be able to step past the
     * cadence gate and still be testing the settle rule rather than a cooldown.
     */
    defaultIntervalSeconds: 1,
    minIntervalSeconds: 1
  },
  {
    key: SECOND_RECONCILE_ACTION,
    action: TaskAction.Reconcile,
    label: '测试对账（第二个动作）',
    description: '第二个 Reconcile 动作，用来钉住「按动作、按天」的落定判断。',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 1,
    minIntervalSeconds: 1
  },
  {
    key: TARGET_RECONCILE_ACTION,
    action: TaskAction.Reconcile,
    label: '测试对账（按房间）',
    description: '需要目标的 Reconcile 动作，用来钉住「一次运行只带任务自己指名的动作」。',
    costly: false,
    /** The shape under test: this one refuses a task that carries no target, as its kind does. */
    needsTarget: true,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 1,
    minIntervalSeconds: 1
  },
  {
    key: SECOND_TARGET_RECONCILE_ACTION,
    action: TaskAction.Reconcile,
    label: '测试对账（按房间·第二个动作）',
    description: '第二个需要目标的 Reconcile 动作，用来钉住「同一个房间上的两个任务各跑各的」。',
    costly: false,
    needsTarget: true,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 1,
    minIntervalSeconds: 1
  }
]

registerPlatform({
  key: PLATFORM_KEY,
  label: '测试平台',
  actions: STUB_ACTIONS,
  resolveTarget: async (input: string) => ({
    key: input,
    title: '',
    // This stub's label is the pasted text itself, so there is nothing to explain — and the field is
    // required, so a stub that omitted it would be a `TargetInfo` that does not typecheck.
    titleNote: '',
    anchorId: '',
    anchorName: '',
    liveStatus: 0
  }),
  probe: async account => {
    stub.probeCalls += 1
    stub.seenCredentials = account.credentials
    return stub.probePlan()
  },
  send: async account => {
    stub.sendCalls += 1
    stub.seenCredentials = account.credentials
    return stub.sendPlan()
  },
  reconcile: async context => {
    stub.reconcileCalls += 1
    stub.lastReconcileContext = context
    for (const actionKey of context.enabledActions) {
      stub.dispatched[actionKey] = (stub.dispatched[actionKey] ?? 0) + 1
    }
    return stub.reconcilePlan(context)
  },
  // Declared, so that "the sweep asked this Platform and got nothing to do" is a case this
  // file can state. The real adapters' answers are their own business; what the *scheduler*
  // does with one is asserted below.
  refresh: async () => await stub.refreshPlan(),
  // The scheduler hands each Platform the work a pass still wants, after the pass (`platform/types.ts`).
  // This stub starts nothing that outlives a sweep, so there is nothing for it to retire; the handover
  // itself is pinned where a resident loop really exists, in `watch-retire.test.ts`.
  retainResidentWork: () => {}
})

const HOUR = 60 * 60 * 1000

/**
 * Creates a **send** Task through the real route, with hours a case can aim at.
 *
 * The difference from `makeTask` is only the window: that one takes its hours from `Date.now()`, which
 * is right for the cases that drive the sweep with the real clock and useless for a case that has to
 * step a *Platform day* — the standing report's own bound, and the switch that has to gate it. So this
 * is the send half of `makeReconcileTask`'s shape, and the `requireOnline: false` is what keeps a
 * liveness probe (a separate subject with its own cases) out of these ones.
 */
async function makeSendTask(desk: Desk): Promise<number> {
  const response = await desk.server.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: desk.session.auth(),
    payload: {
      platform: PLATFORM_KEY,
      accountId: desk.accountId,
      actionKey: ACTION_KEY,
      targetKey: '12345',
      targetTitle: '测试房间',
      libraryId: desk.libraryId,
      startTime: DAY_ANCHOR - 24 * HOUR,
      endTime: DAY_ANCHOR + 48 * HOUR,
      interval: 10,
      requireOnline: false,
      saltEnabled: false
    }
  })

  expect(response.statusCode).toBe(200)
  const taskId = response.json<{ task: { id: number } }>().task.id
  // A live room and a running Task, which is the state a sweep would have reached on its own.
  desk.server.ctx.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(TaskStatus.Running, taskId)
  return taskId
}

/**
 * The state every case below starts from: one session, this Platform's account, the
 * library the send action consumes, and the switchboard on.
 *
 * The account goes in directly rather than through an API — the app has no route for
 * binding this Platform — and both rows are what the routes and the sweep read, so
 * this is the data a real binding would have produced.
 */
interface Desk {
  readonly server: BuiltServer
  readonly session: Session
  readonly accountId: number
  readonly libraryId: number
}

const it = base.extend<{ desk: Desk }>({
  desk: async ({ server, session }, use) => {
    // The stub's own reset, and the reason it is here rather than in a hook of its own:
    // the Platform registered above reads this state for every call, so a case that
    // replaces a plan must not hand the replacement to the case that runs after it.
    Object.assign(stub, freshStub())

    const now = Date.now()
    const account = server.ctx.db
      .prepare(
        `INSERT INTO accounts (user_id, platform, external_id, display_name, avatar, credentials, meta, created_at, updated_at)
         VALUES (?, ?, '100', ?, '', ?, '{}', ?, ?)`
      )
      .run(session.userId, PLATFORM_KEY, session.username, CREDENTIALS, now, now)

    const library = server.ctx.db
      .prepare(
        `INSERT INTO libraries (user_id, name, bullet_count, raw_chars, created_at)
         VALUES (?, 'lib', 5, 50, ?)`
      )
      .run(session.userId, now)

    // The bullet rows themselves. Without these `getBulletAt` returns null and the
    // scheduler fails the task with "文本库为空" before ever attempting a send —
    // which is what made the promote test look like a scheduling bug.
    const insertBullet = server.ctx.db.prepare(
      'INSERT INTO bullets (library_id, seq, content, char_count) VALUES (?, ?, ?, ?)'
    )
    for (let seq = 0; seq < 5; seq += 1) {
      const content = `测试弹幕第${String(seq)}条`
      insertBullet.run(Number(library.lastInsertRowid), seq, content, content.length)
    }

    // Silence, hence a task: absence of a row means off. The switchboard's own
    // routes are exercised in `platform-routes.test.ts`; here it only has to be on.
    await enableAction({ server, session }, ACTION_KEY)

    await use({
      server,
      session,
      accountId: Number(account.lastInsertRowid),
      libraryId: Number(library.lastInsertRowid)
    })
  }
})

/** Creates a task through the real route, then forces the fields under test. */
async function makeTask(
  desk: Desk,
  overrides: { status?: string; lastLiveStatus?: number; lastCheckedAt?: number } = {}
): Promise<number> {
  const now = Date.now()
  const response = await desk.server.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: desk.session.auth(),
    payload: {
      platform: PLATFORM_KEY,
      accountId: desk.accountId,
      actionKey: ACTION_KEY,
      targetKey: '12345',
      targetTitle: 'test room',
      libraryId: desk.libraryId,
      startTime: now - HOUR,
      endTime: now + HOUR,
      interval: 10,
      requireOnline: true,
      saltEnabled: true
    }
  })

  expect(response.statusCode).toBe(200)
  const taskId = response.json<{ task: { id: number } }>().task.id

  desk.server.ctx.db
    .prepare('UPDATE tasks SET status = ?, last_live_status = ?, last_checked_at = ? WHERE id = ?')
    .run(overrides.status ?? TaskStatus.Running, overrides.lastLiveStatus ?? 1, overrides.lastCheckedAt ?? null, taskId)

  return taskId
}

function statusOf(desk: Desk, taskId: number): string {
  const row = desk.server.ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId)
  return String(row?.['status'])
}

/**
 * Pauses a Task through the route a person uses.
 *
 * The real route rather than `updateTaskStatus` directly, because the claim the block below makes is
 * about a *request* meeting a *sweep*: the handler reads the row and writes the status in one
 * synchronous stretch with no await in it, so inside itself it has no window at all. That is precisely
 * why the scheduler's own earlier snapshot is the half that has to give, and driving the real route is
 * what keeps the test about that rather than about a second write the test invented.
 */
async function pauseTask(desk: Desk, taskId: number): Promise<void> {
  const response = await desk.server.app.inject({
    method: 'PATCH',
    url: `/api/tasks/${String(taskId)}`,
    headers: desk.session.auth(),
    payload: { status: TaskStatus.Paused }
  })
  expect(response.statusCode).toBe(200)
}

/**
 * The sweep under a test's control, with its log lines in hand.
 *
 * A `Scheduler` built here rather than `desk.server.scheduler` for one reason: a refused write is meant
 * to leave a trace, the log is the only place that trace lives, and `fixtures.ts` builds the server's
 * scheduler onto a silenced logger. Only the instance differs — the database, the registered Platform
 * and the routes are the shipping ones.
 */
function sweeping(desk: Desk): { scheduler: Scheduler; lines: string[] } {
  const lines: string[] = []
  return {
    scheduler: new Scheduler({
      db: desk.server.ctx.db,
      log: line => {
        lines.push(line)
      }
    }),
    lines
  }
}

/**
 * Flips one switch through the real route.
 *
 * Takes only the two fixtures it uses rather than a whole `Desk`: the `desk` fixture
 * itself needs this, to seed the switch every case depends on, and there is no `desk`
 * to pass yet at that point.
 */
async function enableAction(desk: Pick<Desk, 'server' | 'session'>, actionKey: string): Promise<void> {
  const response = await desk.server.app.inject({
    method: 'PUT',
    url: '/api/action-settings',
    headers: desk.session.auth(),
    payload: { platform: PLATFORM_KEY, actionKey, enabled: true }
  })
  expect(response.statusCode).toBe(200)
}

/**
 * Flips one switch through the real route, with options.
 *
 * The field is the API's own: the route stores whatever the client sends, because the seam describes no
 * options for it to validate — what an option *means* belongs to the adapter on the other side of this
 * channel. Nothing here reads them; the cases at the end of this file are about their delivery.
 */
async function enableActionWithOptions(
  desk: Pick<Desk, 'server' | 'session'>,
  actionKey: string,
  options: unknown
): Promise<void> {
  const response = await desk.server.app.inject({
    method: 'PUT',
    url: '/api/action-settings',
    headers: desk.session.auth(),
    payload: { platform: PLATFORM_KEY, actionKey, enabled: true, options }
  })
  expect(response.statusCode).toBe(200)
}

/**
 * Turns one switch off again, through the same route a person uses.
 *
 * The create route refuses a Task for an action that is off, so a case about "the switch was flipped
 * afterwards" has to create first and flip second — which is also the order a person lives in.
 */
async function disableAction(desk: Pick<Desk, 'server' | 'session'>, actionKey: string): Promise<void> {
  const response = await desk.server.app.inject({
    method: 'PUT',
    url: '/api/action-settings',
    headers: desk.session.auth(),
    payload: { platform: PLATFORM_KEY, actionKey, enabled: false }
  })
  expect(response.statusCode).toBe(200)
}

/** Rows written for one task, which is what `settledToday` actually reads. */
function actionLogCount(desk: Desk, taskId: number): number {
  const row = desk.server.ctx.db.prepare('SELECT COUNT(*) AS n FROM action_logs WHERE task_id = ?').get(taskId)
  return Number(row?.['n'])
}

/**
 * How many runs handed one action key to the adapter.
 *
 * Zero is the assertion the shape cases need, and it is a stronger claim than "it refused": a
 * runner that handed 点赞 over and let it answer `bad_target` would still be three GETs a round
 * against a Platform that rate-limits.
 */
function dispatchCount(actionKey: string): number {
  return stub.dispatched[actionKey] ?? 0
}

/** The action keys one task's rows name, oldest first — the record of what was actually attempted. */
function loggedKeys(desk: Desk, taskId: number): string[] {
  const rows = desk.server.ctx.db
    .prepare('SELECT action_key FROM action_logs WHERE task_id = ? ORDER BY id ASC')
    .all(taskId)
  return rows.map(row => String(row['action_key']))
}

/** The codes one task's rows carry, which is where an adapter's own refusal would show up. */
function loggedCodes(desk: Desk, taskId: number): string[] {
  const rows = desk.server.ctx.db.prepare('SELECT code FROM action_logs WHERE task_id = ? ORDER BY id ASC').all(taskId)
  return rows.map(row => String(row['code']))
}

/** Events of one kind on the feed, which is the whole of what "did it say session_expired" means. */
function eventCount(desk: Desk, kind: string): number {
  const row = desk.server.ctx.db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ?').get(kind)
  return Number(row?.['n'])
}

/** The cadence stamp, which the sweep writes on the asking *and* the skipping path. */
function lastSentAtOf(desk: Desk, taskId: number): number | null {
  const row = desk.server.ctx.db.prepare('SELECT last_sent_at FROM tasks WHERE id = ?').get(taskId)
  const value = row?.['last_sent_at']
  return typeof value === 'number' ? value : null
}

/**
 * The liveness the sweep last recorded for a Task, which is what the detail page's 「开播状态」 reads.
 *
 * A reconcile Task had no value here at all before the sweep probed one: `updateTaskMonitor`'s only
 * caller was inside the send branch's require-online gate.
 */
function lastLiveStatusOf(desk: Desk, taskId: number): number | null {
  const row = desk.server.ctx.db.prepare('SELECT last_live_status FROM tasks WHERE id = ?').get(taskId)
  const value = row?.['last_live_status']
  return typeof value === 'number' ? value : null
}

/**
 * A fixed instant in the middle of a Shanghai day — 2026-03-10 10:00 CST.
 *
 * The settle rule keys on the *Platform's* day, so a test that drove the sweep with
 * `Date.now()` would pass everywhere except in the minutes before local midnight,
 * when the second tick would cross the boundary and legitimately ask again. `tick`
 * takes its `now` as an argument precisely so a test can supply one; every tick in
 * the block below does.
 */
const DAY_ANCHOR = Date.parse('2026-03-10T02:00:00Z')

/** Ten minutes later: far past the stub's one-second cadence, same Shanghai day. */
const LATER_SAME_DAY = DAY_ANCHOR + 10 * 60 * 1000

/** 2026-03-11 01:00 CST: the next day on the Platform's clock. */
const NEXT_PLATFORM_DAY = DAY_ANCHOR + 15 * HOUR

/** 2026-03-10 00:30 CST — the same Shanghai day, but 2026-03-09 in UTC. */
const SHANGHAI_EARLY = Date.parse('2026-03-09T16:30:00Z')

/**
 * Creates a reconcile task through the real route.
 *
 * The window is deliberately wide: several cases tick at instants a day apart, and a
 * window that closed in between would make the task *finish* — which looks like the
 * sweep declining to ask, for a reason that has nothing to do with what is being
 * tested.
 */
async function makeReconcileTask(desk: Desk, actionKey: string = RECONCILE_ACTION): Promise<number> {
  await enableAction(desk, actionKey)

  const response = await desk.server.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: desk.session.auth(),
    payload: {
      platform: PLATFORM_KEY,
      accountId: desk.accountId,
      actionKey,
      // No targetKey, no libraryId: both stub reconcile actions are account-scoped,
      // which is the descriptor's whole point.
      startTime: DAY_ANCHOR - 24 * HOUR,
      endTime: DAY_ANCHOR + 48 * HOUR
    }
  })

  expect(response.statusCode).toBe(200)
  return response.json<{ task: { id: number } }>().task.id
}

/**
 * Creates a reconcile task **with** a target through the real route.
 *
 * The room-scoped half of the pair `makeReconcileTask` makes: this is the chore list that hangs off
 * one anchor's 粉丝牌, and the empty-target row above is the account-scoped one. Two rows of the
 * *same* room-scoped action would be one row, because the create path is create-or-get keyed by
 * (Platform, target, action) — so a second room-scoped Task is always a second action, which is what
 * `SECOND_TARGET_RECONCILE_ACTION` is for.
 */
async function makeTargetReconcileTask(desk: Desk, actionKey: string = TARGET_RECONCILE_ACTION): Promise<number> {
  await enableAction(desk, actionKey)

  const response = await desk.server.app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: desk.session.auth(),
    payload: {
      platform: PLATFORM_KEY,
      accountId: desk.accountId,
      actionKey,
      targetKey: '12345',
      targetTitle: '测试房间',
      startTime: DAY_ANCHOR - 24 * HOUR,
      endTime: DAY_ANCHOR + 48 * HOUR
    }
  })

  expect(response.statusCode).toBe(200)
  return response.json<{ task: { id: number } }>().task.id
}

describe('live-status probing while running', () => {
  it('detects the stream ending and returns the task to monitoring', async ({ desk }) => {
    const taskId = await makeTask(desk)
    stub.probePlan = async () => liveProbe(0)

    await desk.server.scheduler.tick(Date.now())

    expect(statusOf(desk, taskId)).toBe(TaskStatus.Offline)
  })

  it('treats a round-robin stream (status 2) as not live', async ({ desk }) => {
    const taskId = await makeTask(desk)
    stub.probePlan = async () => liveProbe(2)

    await desk.server.scheduler.tick(Date.now())

    // Two halves of one fact. The adapter's half: Bilibili's raw `2` — 轮播, a
    // recording being replayed, nobody actually streaming — is not live.
    expect(isLive(2)).toBe(false)
    // The scheduler's half: anything the probe did not call live parks the task,
    // because the value has already been normalised to 0/1 by the adapter.
    expect(statusOf(desk, taskId)).toBe(TaskStatus.Offline)
  })

  it('does not drop a task whose stream is still live', async ({ desk }) => {
    const taskId = await makeTask(desk)
    stub.probePlan = async () => liveProbe(1)

    await desk.server.scheduler.tick(Date.now())

    expect(statusOf(desk, taskId)).not.toBe(TaskStatus.Offline)
  })

  it('does not probe again before the poll interval elapses', async ({ desk }) => {
    await makeTask(desk, { lastCheckedAt: Date.now() })

    await desk.server.scheduler.tick(Date.now())

    expect(stub.probeCalls).toBe(0)
  })

  it('promotes a monitoring task when the room goes live', async ({ desk }) => {
    const taskId = await makeTask(desk, { status: TaskStatus.Offline, lastLiveStatus: 0 })
    stub.probePlan = async () => liveProbe(1)

    await desk.server.scheduler.tick(Date.now())

    expect(statusOf(desk, taskId)).toBe(TaskStatus.Running)
    // Promotion sends immediately rather than waiting out a cooldown that belonged
    // to the offline stretch.
    expect(stub.sendCalls).toBe(1)
  })

  it('records a went-live event on the feed', async ({ desk }) => {
    await makeTask(desk, { status: TaskStatus.Offline, lastLiveStatus: 0 })
    stub.probePlan = async () => liveProbe(1)

    await desk.server.scheduler.tick(Date.now())

    const event = desk.server.ctx.db
      .prepare("SELECT kind FROM events WHERE kind = 'task_went_live' ORDER BY id DESC LIMIT 1")
      .get()
    expect(event).toBeDefined()
  })

  it('hands the adapter the stored credential blob unchanged', async ({ desk }) => {
    await makeTask(desk)

    await desk.server.scheduler.tick(Date.now())

    // The scheduler reads the blob because the adapter needs it, and does not
    // interpret it: the shape belongs to the Platform and differs per Platform.
    expect(stub.seenCredentials).toBe(CREDENTIALS)
  })
})

/**
 * A sweep that writes a status it decided from a row a person changed in the meantime.
 *
 * `tick` reads the schedulable Tasks once and then walks them, and the walk is all awaits — a probe, a
 * send, a reconcile run, seconds each. A pause that lands inside any of them is invisible to the sweep,
 * because the status it is about to write was decided from the row as it stood before. The two statuses
 * at stake (`offline`, `running`) are both inside `listSchedulableTasks`' own set, so what is lost is not
 * a stale screen: the Task keeps being swept — probed, promoted, and sent into — while the request that
 * asked for the pause was answered 200. That is item **D3**, and every case below fails on the code
 * before the fix, in the direction of the pause not surviving.
 *
 * The fix is one statement rather than a re-read: `updateTaskStatus` takes the status the caller decided
 * from and writes only while the row still holds it. So these cases assert more than "the pause stood" —
 * they assert the two consequences that give that any weight, which are that a promotion that did not
 * land must not send, and that a Platform run the promotion licensed must not happen either.
 *
 * `failTask` is the deliberate exception and the last case pins it: that write reports what a Platform
 * has just answered about the account, which a pause cannot make untrue.
 */
describe('a pause the sweep has already read past', () => {
  it('does not park a running Task back to offline behind the pause', async ({ desk }) => {
    const taskId = await makeTask(desk)
    const probe = hangingProbe()
    stub.probePlan = probe.plan

    const { scheduler, lines } = sweeping(desk)
    const sweep = scheduler.tick(Date.now())
    await probe.reached
    await pauseTask(desk, taskId)
    probe.release(liveProbe(0))
    await sweep

    // The probe answered "the stream ended", which is what parks a running Task — but the row is no
    // longer the one that verdict was about, and `offline` would hand it straight back to the next
    // sweep: the pause quietly not having happened.
    expect(statusOf(desk, taskId)).toBe(TaskStatus.Paused)
    // A refused write is not silence either. The log line is the only trace a person's request and a
    // sweep crossing will leave anywhere, so this is the half of "do not swallow it" that a screen
    // cannot show.
    expect(lines.some(line => line.includes(`status write to ${TaskStatus.Offline} refused`))).toBe(true)
  })

  it('does not promote a paused Task and send into it', async ({ desk }) => {
    const taskId = await makeTask(desk, { status: TaskStatus.Offline, lastLiveStatus: 0 })
    const probe = hangingProbe()
    stub.probePlan = probe.plan

    const { scheduler } = sweeping(desk)
    const sweep = scheduler.tick(Date.now())
    await probe.reached
    await pauseTask(desk, taskId)
    probe.release(liveProbe(1))
    await sweep

    expect(statusOf(desk, taskId)).toBe(TaskStatus.Paused)
    // The stronger half of the same fact. A person who pauses a Task has asked for nothing to happen to
    // it, and a bullet delivered on a snapshot that no longer holds is something happening to it — so a
    // promotion that was refused has to take its send with it, not merely its status word.
    expect(stub.sendCalls).toBe(0)
  })

  it('does not run the Action a paused reconcile Task was promoted for', async ({ desk }) => {
    const taskId = await makeTargetReconcileTask(desk)
    desk.server.ctx.db
      .prepare('UPDATE tasks SET status = ?, last_live_status = 0, last_checked_at = NULL WHERE id = ?')
      .run(TaskStatus.Offline, taskId)

    const probe = hangingProbe()
    stub.probePlan = probe.plan

    const { scheduler } = sweeping(desk)
    const sweep = scheduler.tick(DAY_ANCHOR)
    await probe.reached
    await pauseTask(desk, taskId)
    probe.release(liveProbe(1))
    await sweep

    expect(statusOf(desk, taskId)).toBe(TaskStatus.Paused)
    // The reconcile half of the same consequence, and the one where the stake is not a bullet but the
    // Platform's own account: signing in and claiming what is outstanding is exactly the work a pause
    // is asking not to happen.
    expect(stub.reconcileCalls).toBe(0)
  })

  it('does not park a paused reconcile Task back to offline either', async ({ desk }) => {
    const taskId = await makeTargetReconcileTask(desk)
    desk.server.ctx.db
      .prepare('UPDATE tasks SET status = ?, last_checked_at = NULL WHERE id = ?')
      .run(TaskStatus.Running, taskId)

    const probe = hangingProbe()
    stub.probePlan = probe.plan

    const { scheduler } = sweeping(desk)
    const sweep = scheduler.tick(DAY_ANCHOR)
    await probe.reached
    await pauseTask(desk, taskId)
    probe.release(liveProbe(0))
    await sweep

    // The reconcile executor's own copy of the park. It has no run behind it to withhold, so the case is
    // here to pin the sibling on both of its branches rather than only on the one with teeth.
    expect(statusOf(desk, taskId)).toBe(TaskStatus.Paused)
  })

  it('does not finish a paused Task, and writes nothing to the feed about it', async ({ desk }) => {
    // Two rows, because the finish branch has no await of its own: `decide` answers `finish` out of the
    // window before this executor touches the Platform at all. The window a pause can land in is the
    // *sweep's*, and a Task ahead of this one is what holds it open — the sweep has read both rows and
    // is inside the first one's probe when the pause arrives.
    await makeTask(desk)
    const second = await makeTask(desk)
    desk.server.ctx.db.prepare('UPDATE tasks SET end_time = ? WHERE id = ?').run(Date.now() - 1_000, second)

    const probe = hangingProbe()
    stub.probePlan = probe.plan

    const { scheduler } = sweeping(desk)
    const sweep = scheduler.tick(Date.now())
    await probe.reached
    await pauseTask(desk, second)
    probe.release(liveProbe(0))
    await sweep

    // `done` is where this matters most: it is terminal and outside the sweep's set, so a person who
    // paused a Task to edit it would find the row out of their reach — the edit route takes paused rows
    // only — with nothing to say what moved. The feed has to stay quiet for the same reason: a
    // 「任务已完成」 event about a Task the row says is paused is a report about a program that did not run.
    expect(statusOf(desk, second)).toBe(TaskStatus.Paused)
    expect(eventCount(desk, 'task_finished')).toBe(0)
  })

  it('still fails a Task whose account the Platform has just refused, pause or no pause', async ({ desk }) => {
    const taskId = await makeTask(desk)
    const probe = hangingProbe()
    stub.probePlan = probe.plan

    const { scheduler } = sweeping(desk)
    const sweep = scheduler.tick(Date.now())
    await probe.reached
    await pauseTask(desk, taskId)
    probe.release(failedProbe('-101', '登录态已过期', 'account_stop'))
    await sweep

    // The exception, pinned so it cannot be tidied away as an inconsistency later. This write is not the
    // sweep's opinion about a row — it is what a Platform answered about the account — and none of it
    // stops being true because the row was paused a moment ago. Making it conditional would leave the
    // Task sitting at `paused`, let 恢复 rediscover the same refusal, and drop the feed line with it.
    expect(statusOf(desk, taskId)).toBe(TaskStatus.Failed)
    expect(eventCount(desk, 'session_expired')).toBe(1)
  })
})

/**
 * 重置进度, seen from the sweep's side.
 *
 * A reset is a request that says "start this Task over", and it lands in the middle of everything the
 * sweep does: the sweep reads its row once and then walks over awaits, so a reset can arrive while a
 * bullet is already out. Two facts follow, and they point in opposite directions — what the reset
 * cleared has to stay cleared, and what the sweep is at that moment writing down has to stay true.
 *
 * Both cases drive the *real* route rather than `resetTaskProgress`, because the claim is about a
 * request meeting a sweep: the handler reads the row and writes it in one synchronous stretch, so the
 * only half that can give is the sweep's snapshot.
 */
describe('POST /api/tasks/:id/reset, seen from the sweep', () => {
  it('clears the cadence clock, so the first send is not judged by the run before it', async ({ desk }) => {
    const taskId = await makeSendTask(desk)

    await desk.server.scheduler.tick(DAY_ANCHOR)
    expect(stub.sendCalls).toBe(1)

    const response = await desk.server.app.inject({
      method: 'POST',
      url: `/api/tasks/${String(taskId)}/reset`,
      headers: desk.session.auth()
    })
    expect(response.statusCode).toBe(200)

    // Two seconds on — **inside** the ten-second cadence the reset just retired. The counters that
    // interval belonged to are gone, so a send judged against the old stamp is this screen saying
    // 「从头再来」 while the Task sits out a timer from a run nobody can see any more. The resume path
    // already clears its own clock for the same reason (`routes/tasks.ts`), and the two routes write one
    // status and one set of counters, so they have to treat that clock the same way.
    await desk.server.scheduler.tick(DAY_ANCHOR + 2_000)
    expect(stub.sendCalls).toBe(2)
  })

  it('is not undone by the counters a send had already computed from the row as it was', async ({ desk }) => {
    const taskId = await makeSendTask(desk)

    // Two real rounds first, so the counters this sweep is about to write are visibly *not* zero: the
    // defect this pins is the reset's zeroes being overwritten by larger numbers from before it, and a
    // Task whose counters were already 0 could hide that behind a coincidence.
    await desk.server.scheduler.tick(DAY_ANCHOR)
    await desk.server.scheduler.tick(DAY_ANCHOR + 11_000)
    expect(stub.sendCalls).toBe(2)
    const before = desk.server.ctx.db.prepare('SELECT cursor, sent_count FROM tasks WHERE id = ?').get(taskId)
    expect(before?.['cursor']).toBe(2)
    expect(before?.['sent_count']).toBe(2)

    const { scheduler, lines } = sweeping(desk)

    let release: () => void = (): void => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    stub.sendPlan = async () => {
      await held
      return { ok: true, code: '0', detail: '', failure: 'none' }
    }

    const sweep = scheduler.tick(DAY_ANCHOR + 22_000)
    // The sweep is inside `platform.send` by now, holding the snapshot it decided from.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(stub.sendCalls).toBe(3)

    const reset = await desk.server.app.inject({
      method: 'POST',
      url: `/api/tasks/${String(taskId)}/reset`,
      headers: desk.session.auth()
    })
    expect(reset.statusCode).toBe(200)

    release()
    await sweep

    // The attempt is history and it stands: the bullet went out, and `send_logs` is where that is
    // written down. Nothing the sweep does about its own bookkeeping may drop it.
    expect(listSendLogs(desk.server.ctx.db, taskId)).toHaveLength(3)

    // The counters do **not** stand, which is the whole point: they were computed from the row as it was
    // before the reset, so writing them would resurrect the numbers a person just cleared — cursor 3 and
    // three sends on a Task 重置进度 has just put back to nothing. The status write beside them was made
    // conditional in the same round (`writeStatusUnlessMoved`); this is the half that was left absolute,
    // and the two would otherwise disagree about the same stale snapshot.
    const row = desk.server.ctx.db
      .prepare('SELECT cursor, loop_count, sent_count, success_count, fail_count FROM tasks WHERE id = ?')
      .get(taskId)
    expect(row?.['cursor']).toBe(0)
    expect(row?.['loop_count']).toBe(0)
    expect(row?.['sent_count']).toBe(0)
    expect(row?.['success_count']).toBe(0)
    expect(row?.['fail_count']).toBe(0)
    expect(statusOf(desk, taskId)).toBe(TaskStatus.Waiting)

    // And the refusal is not swallowed: the log line is the only trace a person's reset and a sweep
    // crossing will leave, exactly as it is for the status write.
    expect(lines.some(line => line.includes('progress write refused'))).toBe(true)
  })
})

describe('probe failures', () => {
  it('records the reason on the task instead of failing silently', async ({ desk }) => {
    const taskId = await makeTask(desk)
    // A transient failure, graded `retry` by the adapter — which is the only thing
    // the scheduler reads. The wording is the adapter's to choose.
    stub.probePlan = async () => failedProbe('transport', '查询直播间失败：room_init 返回 code -352', 'retry')

    await desk.server.scheduler.tick(Date.now())

    const row = desk.server.ctx.db.prepare('SELECT last_error, status FROM tasks WHERE id = ?').get(taskId)
    expect(String(row?.['last_error'])).toContain('查询直播间失败')
    // Transient: the task keeps its place and is retried next sweep.
    expect(row?.['status']).toBe(TaskStatus.Running)
  })

  it('fails the task and says why when the session is dead', async ({ desk }) => {
    const taskId = await makeTask(desk)
    // `account_stop` means nothing will work again until a person re-binds, which is why it
    // kills the task rather than parking it — and why the event says 登录已失效 rather than
    // leaving the reason to be inferred from the task's own state.
    const detail = `${PLATFORM_KEY} 登录态已失效，需要重新扫码绑定账号`
    stub.probePlan = async () => failedProbe('-101', detail, 'account_stop')

    await desk.server.scheduler.tick(Date.now())

    const row = desk.server.ctx.db.prepare('SELECT last_error, status FROM tasks WHERE id = ?').get(taskId)
    expect(row?.['status']).toBe(TaskStatus.Failed)
    // The adapter's own words reach the operator unchanged: the reason a task died
    // is the one thing they have to act on, and rewording it here would lose the
    // Platform's explanation for how to re-bind.
    expect(row?.['last_error']).toBe(detail)

    // A failed task must announce itself: the defect this guards is a dead session
    // that only showed up as a task that quietly stopped doing anything.
    const event = desk.server.ctx.db
      .prepare("SELECT kind FROM events WHERE kind = 'session_expired' ORDER BY id DESC LIMIT 1")
      .get()
    expect(event).toBeDefined()
  })

  it('survives a probe that throws', async ({ desk }) => {
    const taskId = await makeTask(desk)
    stub.probePlan = async () => {
      throw new Error('ECONNRESET')
    }

    await desk.server.scheduler.tick(Date.now())

    // A throwing adapter is a transient fault like any other: it is recorded and
    // the sweep moves on, rather than taking the task — or the loop — down with it.
    const row = desk.server.ctx.db.prepare('SELECT last_error, status FROM tasks WHERE id = ?').get(taskId)
    expect(String(row?.['last_error'])).toContain('查询失败')
    expect(row?.['status']).toBe(TaskStatus.Running)
  })

  it('clears a previous failure once a probe succeeds', async ({ desk }) => {
    const taskId = await makeTask(desk)
    desk.server.ctx.db.prepare('UPDATE tasks SET last_error = ? WHERE id = ?').run('旧的错误', taskId)

    stub.probePlan = async () => liveProbe(1)
    await desk.server.scheduler.tick(Date.now())

    const row = desk.server.ctx.db.prepare('SELECT last_error FROM tasks WHERE id = ?').get(taskId)
    expect(row?.['last_error']).toBe('')
  })
})

/**
 * What the two account-level kinds tell a person, and what they leave behind.
 *
 * The kind is the adapter's verdict and this file hands it over directly, which is what
 * makes these cases structural: `bilibili-adapter.test.ts` pins `-400` 房间全员禁言 as
 * `action_stop`, `-403` 账号被封禁 as `account_restricted` and `-101` 登录态失效 as
 * `account_stop`, and what the sweep does with each verdict is asserted here. Both
 * directions of the last one matter — a one-way test ("a restriction is not an expiry")
 * passes just as happily if someone collapses every account-level failure onto one kind,
 * which is how this regression arrived.
 */
describe('account-level failures', () => {
  it('keeps the task alive when the room is what refused, and says nothing about a session', async ({ desk }) => {
    // The `-400` verdict. The account is healthy and only this room is refusing, so failing
    // the task was the wrong half of the regression: the task is still schedulable the moment
    // the room stops being muted, and a re-bind cannot unmute it either.
    const taskId = await makeTask(desk)
    stub.probePlan = async () => failedProbe('-400', '房间 22637261 全员禁言：房间全员禁言', 'action_stop')

    await desk.server.scheduler.tick(Date.now())

    expect(statusOf(desk, taskId)).toBe(TaskStatus.Running)
    expect(eventCount(desk, 'session_expired')).toBe(0)

    // The obstruction still reaches the feed — 「动作受阻」 is the event for "this is being
    // refused right now", and it carries the room, which is the one thing a person can act on.
    const blocked = desk.server.ctx.db
      .prepare("SELECT title, detail FROM events WHERE kind = 'action_blocked' ORDER BY id DESC LIMIT 1")
      .get()
    expect(blocked?.['title']).toBe('动作受阻')
    expect(String(blocked?.['detail'])).toContain('22637261')
  })

  it('tells a restricted account what applies, instead of asking for a re-bind', async ({ desk }) => {
    // The `-403` verdict: account-level, and not an expiry. Both halves are pinned — the
    // restriction's own event is raised, and the expired-session one is not.
    const taskId = await makeTask(desk)
    stub.probePlan = async () => failedProbe('-403', '账号被封禁', 'account_restricted')

    await desk.server.scheduler.tick(Date.now())

    // Nothing will land while the account is refused, so the task ends — the same state a dead
    // session leaves it in, which is the entirety of what the two kinds share.
    expect(statusOf(desk, taskId)).toBe(TaskStatus.Failed)
    expect(eventCount(desk, 'session_expired')).toBe(0)

    const event = desk.server.ctx.db
      .prepare("SELECT severity, title, detail FROM events WHERE kind = 'account_restricted' ORDER BY id DESC LIMIT 1")
      .get()
    expect(event?.['severity']).toBe('error')
    expect(event?.['title']).toBe('账号被限制')

    const told = String(event?.['detail'])
    // The Platform's own words are what say which restriction it is...
    expect(told).toContain('账号被封禁')
    // ...and no re-bind is asked for. An instruction to re-bind a bound account is exactly
    // what this used to be, and it is an instruction that cannot work.
    expect(told).not.toContain('需要重新绑定')
  })

  it('still reports a genuine expiry as an expired session, never as a restriction', async ({ desk }) => {
    const taskId = await makeTask(desk)
    stub.probePlan = async () => failedProbe('-101', 'B 站登录态已失效，需要重新扫码绑定账号', 'account_stop')

    await desk.server.scheduler.tick(Date.now())

    expect(statusOf(desk, taskId)).toBe(TaskStatus.Failed)
    expect(eventCount(desk, 'session_expired')).toBe(1)
    expect(eventCount(desk, 'account_restricted')).toBe(0)
  })

  it('raises the restriction’s event on the reconcile path too', async ({ desk }) => {
    // The second of the two ways an account-level verdict arrives: a reconcile run reports one
    // outcome per action, and it has to reach the same event and the same task state there.
    const taskId = await makeReconcileTask(desk)
    stub.reconcilePlan = planOf('failed', 'account_restricted')

    await desk.server.scheduler.tick(DAY_ANCHOR)

    expect(statusOf(desk, taskId)).toBe(TaskStatus.Failed)
    expect(eventCount(desk, 'account_restricted')).toBe(1)
    expect(eventCount(desk, 'session_expired')).toBe(0)
  })
})

/**
 * A paste-bound Douyu credential: five components, a device id, and no web session.
 *
 * Both values are the shape a person pastes rather than anything captured, and this file never
 * reaches the network for them: with no session in the jar there is nothing a renewal could present,
 * so the adapter answers without making a call — the two hops need a fixture, not a socket.
 */
const DOUYU_TOKEN = '123456789_1_abcdef0123456789_0_69117311'
const DOUYU_DID = '20e8917f4ebe85866a5e94cfaba2f156'

/**
 * One more account row on the same user, for a Platform this file does not otherwise drive.
 *
 * The refresh sweep walks accounts by Platform rather than by task, so a credential is
 * reachable here with no task, no action switch and no route — which is exactly how a
 * paste-bound account reached the feed in real use.
 *
 * `externalId` is a parameter because the row's unique key is `(user_id, platform, external_id)`: a
 * case that needs two credentials of one Platform needs two ids, and that is the whole reason this
 * is not a constant.
 */
function bindAccount(desk: Desk, platform: string, credentials: string, externalId = '200'): void {
  const now = Date.now()
  desk.server.ctx.db
    .prepare(
      `INSERT INTO accounts (user_id, platform, external_id, display_name, avatar, credentials, meta, created_at, updated_at)
       VALUES (?, ?, ?, '', '', ?, '{}', ?, ?)`
    )
    .run(desk.session.userId, platform, externalId, credentials, now, now)
}

/** An account's stored credential blob, as the sweep would have left it. */
function credentialsOf(desk: Desk, accountId: number): string {
  const row = desk.server.ctx.db.prepare('SELECT credentials FROM accounts WHERE id = ?').get(accountId)
  return String(row?.['credentials'])
}

/**
 * Session upkeep, at the level a person meets it: the feed.
 *
 * This is where the conflation reached the user — the sweep asked a Douyu adapter that answered
 * from the presence of a web cookie as though that were a verdict *on the token*, and a paste-bound
 * account that worked emitted roughly four 「登录已失效」 a day. The rule that replaced it needs two
 * facts before it says anything to anybody: a renewal must be **known to be due** (the family's own
 * stored clock, inside the renewal window), and there must be **no key to present for it**. Only that
 * intersection earns `relogin_required`; everything else is silence, because a credential with
 * nothing to do yet, or one nobody dated, cannot be described as about to lapse. What the token is
 * worth is answered where it is used — the server's own `-101`/`1002` on the action paths.
 *
 * The cases below pin all three directions: the silence for a shape that would otherwise alarm, the
 * one shape that earns the event, and a Platform refusing a renewal it was asked to perform.
 */
describe('the session-refresh sweep', () => {
  it('raises nothing for a Douyu credential with no session that is not known to need a renewal', async ({ desk }) => {
    // Both shapes a paste produces: five components and a device id, with no web session — one with
    // no family clock at all, and one whose family is five days from lapsing. Neither is a credential
    // this sweep can call "about to expire", so neither gets an alarm.
    bindAccount(desk, 'douyu', JSON.stringify({ token: DOUYU_TOKEN, did: DOUYU_DID }))
    bindAccount(
      desk,
      'douyu',
      JSON.stringify({ token: DOUYU_TOKEN, did: DOUYU_DID, tokenExpiresAt: Date.now() + 5 * 24 * HOUR }),
      '201'
    )

    // The accounts and the adapter the sweep would visit, so "nothing was raised" cannot be the
    // silence of a Platform nobody asked: both of the sweep's iterations are checked here.
    expect(listAccountsByPlatform(desk.server.ctx.db, 'douyu')).toHaveLength(2)
    expect(platformFor('douyu')?.refresh).toBeDefined()

    await desk.server.scheduler.tick(Date.now())

    expect(eventCount(desk, 'session_expired')).toBe(0)
  })

  it('tells a person to re-scan when a renewal is due and the Douyu credential has no key for it', async ({ desk }) => {
    // The one Douyu shape that earns the event, and both halves are here: the family's clock is two
    // hours from lapsing, so a replacement is known to be needed, and the jar holds no `LTP0`, so
    // nothing on this side can perform it. The real adapter answers this without a request — a
    // credential with nothing to present is never presented to the service.
    bindAccount(
      desk,
      'douyu',
      JSON.stringify({
        token: DOUYU_TOKEN,
        did: DOUYU_DID,
        webCookies: 'acf_stk=abcdef0123456789',
        tokenExpiresAt: Date.now() + 2 * HOUR
      })
    )

    await desk.server.scheduler.tick(Date.now())

    expect(eventCount(desk, 'session_expired')).toBe(1)
    const event = desk.server.ctx.db
      .prepare("SELECT title, detail FROM events WHERE kind = 'session_expired' ORDER BY id DESC LIMIT 1")
      .get()
    // The same wording the refusal below gets, because it is the same claim: this session cannot be
    // renewed, and re-binding is what fixes that. Nothing here says the token is dead.
    expect(event?.['title']).toBe('登录已失效')
    expect(String(event?.['detail'])).toContain('无法自动续期')
    expect(String(event?.['detail'])).toContain('重新绑定')
  })

  it('still tells a person when a Platform refuses the renewal it was asked for', async ({ desk }) => {
    // The refusal itself is the adapter's business: `bilibili-adapter.test.ts` pins Bilibili's
    // can't-renew shapes as `relogin_required`, and `douyu-adapter.test.ts` pins Douyu's one, while
    // what the sweep does with the status is here.
    stub.refreshPlan = async () => ({ status: 'relogin_required', detail: '凭据缺少 bili_jct，无法续期' })

    await desk.server.scheduler.tick(Date.now())

    expect(eventCount(desk, 'session_expired')).toBe(1)
    const event = desk.server.ctx.db
      .prepare("SELECT severity, title, detail FROM events WHERE kind = 'session_expired' ORDER BY id DESC LIMIT 1")
      .get()
    expect(event?.['severity']).toBe('error')
    // The wording this status raises has to name the session and the remedy: a person reading
    // it is the only one who can act on it.
    expect(event?.['title']).toBe('登录已失效')
    expect(String(event?.['detail'])).toContain('无法自动续期')
    expect(String(event?.['detail'])).toContain('重新绑定')
  })

  it('stores the credential a renewal handed back, so the next sweep reads the new one', async ({ desk }) => {
    // The other half of a renewal, and the one that started this work: an exchange that produced a
    // fresh family with nothing storing it leaves the account's own credential stale, and its reads
    // then answer `1002 用户未登录` until somebody repairs the row by hand. The exchange itself is a
    // fixture case in `douyu-bind.test.ts`; what is pinned here is that the sweep writes what an
    // adapter hands it.
    const renewed = JSON.stringify({ token: '123456789_1_ffeeddccbbaa9988_0_69117311', did: DOUYU_DID })
    expect(credentialsOf(desk, desk.accountId)).not.toBe(renewed)

    stub.refreshPlan = async () => ({ status: 'refreshed', detail: '会话已续期', credentials: renewed })

    await desk.server.scheduler.tick(Date.now())

    expect(credentialsOf(desk, desk.accountId)).toBe(renewed)
  })

  it('gives a failed renewal a log line and nothing louder', async ({ desk }) => {
    // `failed` is the one refresh status whose whole voice is the log, so this case needs a log it
    // can read: the desk's scheduler writes into a silenced Fastify logger (`fixtures.ts` builds the
    // server with `logger: false`), which is why this one is constructed here over the same database.
    // The assertion is about the **volume** as much as about the line — a spent exchange leaves a
    // credential that still works, so the feed has to stay quiet about it.
    const lines: string[] = []
    const scheduler = new Scheduler({ db: desk.server.ctx.db, log: line => lines.push(line) })
    const detail = '重建 acf_* 家族失败：第二跳没有下发完整的 acf_* 家族'
    stub.refreshPlan = async () => ({ status: 'failed', detail })

    await scheduler.tick(Date.now())

    expect(lines).toContain(`account ${String(desk.accountId)}: session renewal failed: ${detail}`)
    expect(credentialsOf(desk, desk.accountId)).toBe(CREDENTIALS)
    expect(eventCount(desk, 'session_expired')).toBe(0)
  })
})

describe('PATCH /api/tasks/:id — editing', () => {
  it('refuses to edit a running task', async ({ desk }) => {
    const taskId = await makeTask(desk, { status: TaskStatus.Running })

    const response = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(taskId)}`,
      headers: desk.session.auth(),
      payload: { interval: 60 }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toContain('暂停')
  })

  it('edits a paused task and leaves progress untouched', async ({ desk }) => {
    const taskId = await makeTask(desk, { status: TaskStatus.Paused })

    // Simulate progress that must survive the edit.
    desk.server.ctx.db.prepare('UPDATE tasks SET cursor = 3, loop_count = 2 WHERE id = ?').run(taskId)

    const response = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(taskId)}`,
      headers: desk.session.auth(),
      payload: { interval: 45, saltEnabled: false }
    })

    expect(response.statusCode).toBe(200)

    const row = desk.server.ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
    expect(row?.['interval']).toBe(45)
    expect(row?.['salt_enabled']).toBe(0)
    // Progress is what "affects what gets sent next, not what was sent" means.
    expect(row?.['cursor']).toBe(3)
    expect(row?.['loop_count']).toBe(2)
  })

  it('keeps fields the request did not mention', async ({ desk }) => {
    const taskId = await makeTask(desk, { status: TaskStatus.Paused })

    await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(taskId)}`,
      headers: desk.session.auth(),
      payload: { interval: 90 }
    })

    const row = desk.server.ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
    // require_online was true at creation and must still be true.
    expect(row?.['require_online']).toBe(1)
    expect(row?.['salt_enabled']).toBe(1)
  })

  it('allows a long-running window to be set after creation', async ({ desk }) => {
    const taskId = await makeTask(desk, { status: TaskStatus.Paused })
    const now = Date.now()

    const response = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(taskId)}`,
      headers: desk.session.auth(),
      payload: { startTime: now, endTime: now + 300 * 24 * HOUR }
    })

    expect(response.statusCode).toBe(200)
  })

  it('rejects an interval that is not a positive number of seconds', async ({ desk }) => {
    const taskId = await makeTask(desk, { status: TaskStatus.Paused })

    const response = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(taskId)}`,
      headers: desk.session.auth(),
      payload: { interval: 0 }
    })

    expect(response.statusCode).toBe(400)
  })

  it('still allows a plain status change', async ({ desk }) => {
    const taskId = await makeTask(desk, { status: TaskStatus.Paused })

    const response = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(taskId)}`,
      headers: desk.session.auth(),
      payload: { status: TaskStatus.Running }
    })

    expect(response.statusCode).toBe(200)
    expect(statusOf(desk, taskId)).toBe(TaskStatus.Running)
  })

  it('re-checks the room immediately after a resume', async ({ desk }) => {
    const taskId = await makeTask(desk, { status: TaskStatus.Paused })

    // A probe timestamp from a moment ago: without the reset, the interval timer
    // would not be due and the resumed task would sit idle waiting for it.
    desk.server.ctx.db
      .prepare('UPDATE tasks SET last_checked_at = ?, last_sent_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), taskId)

    const response = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(taskId)}`,
      headers: desk.session.auth(),
      payload: { status: TaskStatus.Running }
    })
    expect(response.statusCode).toBe(200)

    const row = desk.server.ctx.db.prepare('SELECT last_checked_at, last_sent_at FROM tasks WHERE id = ?').get(taskId)
    expect(row?.['last_checked_at']).toBeNull()
    expect(row?.['last_sent_at']).toBeNull()
  })

  it('probes on the next sweep after a resume, without waiting for the interval', async ({ desk }) => {
    const taskId = await makeTask(desk, { status: TaskStatus.Paused })

    await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(taskId)}`,
      headers: desk.session.auth(),
      payload: { status: TaskStatus.Running }
    })

    await desk.server.scheduler.tick(Date.now())

    expect(stub.probeCalls).toBeGreaterThan(0)
  })

  it('leaves a paused task entirely alone', async ({ desk }) => {
    await makeTask(desk, { status: TaskStatus.Paused })

    await desk.server.scheduler.tick(Date.now())

    // Paused tasks are not in the schedulable set: no probe, no send, nothing.
    expect(stub.probeCalls).toBe(0)
    expect(stub.sendCalls).toBe(0)
  })

  it("does not let one user edit another user's task", async ({ desk }) => {
    const taskId = await makeTask(desk, { status: TaskStatus.Paused })

    const other = await registerUser(desk.server, 'intruder')

    const response = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(taskId)}`,
      headers: other.auth(),
      payload: { interval: 999 }
    })

    expect(response.statusCode).toBe(404)
  })
})

/**
 * One reconcile run per Platform day.
 *
 * A reconcile task is a daily chore list, not a polling loop. Without
 * `settledToday` the sweep re-runs every enabled action every `interval` — at the
 * adapters' 300 s default, 288 rounds a day of requests whose only possible answer
 * is "already done today". These cases pin the rule at its four edges: settled,
 * not settled because the Platform refused, not settled because the day rolled over,
 * and not settled because a *new* action has no record for today.
 */
describe('reconcile — one run per day', () => {
  it('asks the Platform once, then stops asking while the day’s answer stands', async ({ desk }) => {
    const taskId = await makeReconcileTask(desk)

    await desk.server.scheduler.tick(DAY_ANCHOR)
    expect(stub.reconcileCalls).toBe(1)
    // The adapter is handed the catalogue, not a Platform-specific instruction, and
    // is told which day it is acting on — the field that had no consumer until now.
    expect(stub.lastReconcileContext?.enabledActions).toEqual([RECONCILE_ACTION])
    expect(stub.lastReconcileContext?.dayKey).toBe(dayKeyOf(DAY_ANCHOR))
    expect(actionLogCount(desk, taskId)).toBe(1)

    // Ten minutes on: the task's one-second cadence is long since due, so a second
    // call could only be the sweep failing to consult what it already knows.
    await desk.server.scheduler.tick(LATER_SAME_DAY)
    expect(stub.reconcileCalls).toBe(1)
    expect(actionLogCount(desk, taskId)).toBe(1)
    // And it did reach the reconcile branch before deciding not to ask: the cadence
    // clock is stamped on the asking and the skipping path alike, while a tick that
    // never got there — cooldown, window closed, paused — stamps nothing.
    expect(lastSentAtOf(desk, taskId)).toBe(LATER_SAME_DAY)
  })

  // `for` rather than `each`, and the type checker is what makes it so rather than a preference:
  // `TestForFunctionReturn`'s callback is `(arg, context)` with `context` typed as `TestContext &
  // ExtraContext` — which is where the `desk` fixture comes from — while `TestEachFunction`'s is
  // `(...args)` over the case alone. So `each` cannot hand this callback its fixtures at all, and a
  // spelling that claimed otherwise would be a comment about a signature that does not exist.
  it.for([
    ['today’s settled outcome', DAY_ANCHOR - 60_000, 0],
    ['yesterday’s settled outcome', DAY_ANCHOR - 25 * HOUR, 1]
  ] as const)('reads our own record first: %s decides it', async ([_label, loggedAt, expectedCalls], { desk }) => {
    const taskId = await makeReconcileTask(desk)
    // What a previous run of the same day would have left behind — including one
    // written a moment ago by a process that restarted before the next sweep.
    appendActionLog(
      desk.server.ctx.db,
      { taskId, actionKey: RECONCILE_ACTION, outcome: 'already', detail: '今天已经做过了', code: '0' },
      loggedAt
    )

    await desk.server.scheduler.tick(DAY_ANCHOR)

    // Same task, same instant, same adapter: the only difference between these two
    // cases is the day the record belongs to. That is what makes the pair evidence
    // rather than a coincidence.
    expect(stub.reconcileCalls).toBe(expectedCalls)
  })

  it.for([
    ['failed', 'retry'],
    ['blocked', 'action_stop']
  ] as const)(
    'asks again while an action is %s, because that is the one worth retrying',
    async ([outcome, failure], { desk }) => {
      const taskId = await makeReconcileTask(desk)
      stub.reconcilePlan = planOf(outcome, failure)

      await desk.server.scheduler.tick(DAY_ANCHOR)
      await desk.server.scheduler.tick(LATER_SAME_DAY)

      // `failed` and `blocked` are deliberately not settled: a refusal, or an action the
      // Platform parked until its window opens — Douyu's 打卡分鱼丸 sits at `blocked` —
      // is exactly the one that must be attempted again.
      expect(stub.reconcileCalls).toBe(2)
      expect(actionLogCount(desk, taskId)).toBe(2)
    }
  )

  it('does not cry wolf when the Platform parks an action by design', async ({ desk }) => {
    // `blocked` with `failure: 'none'` is a normal parking, expected back on a later sweep:
    // Douyu's 打卡分鱼丸 before its 19:00 window opens, Bilibili's 观看直播 between one slice
    // and the next. The distinction that matters is `failure`, not the outcome value.
    //
    // Both sides are pinned deliberately. This is enforced by a one-line early return, which
    // is exactly the shape that gets deleted as redundant — and the cost of deleting it is an
    // alarm that fires every day for an action working as designed, which trains whoever reads
    // the feed to ignore it.
    const taskId = await makeReconcileTask(desk)
    stub.reconcilePlan = planOf('blocked', 'none')

    await desk.server.scheduler.tick(DAY_ANCHOR)
    await desk.server.scheduler.tick(LATER_SAME_DAY)

    const raised = desk.server.ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'action_blocked'").get()
    expect(raised?.['n']).toBe(0)

    // Suppressing the event must not suppress the record: the run happened, and the code and
    // detail are what the task detail page's debug section reads.
    expect(actionLogCount(desk, taskId)).toBe(2)
    const logged = desk.server.ctx.db
      .prepare('SELECT outcome, detail FROM action_logs WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId)
    expect(logged?.['outcome']).toBe('blocked')
    // **And the sentence is the Platform's own, passed through untouched.** `planOf` writes 「stub blocked」,
    // which no production sentence says, so a runner that substituted wording of its own — or dropped the
    // adapter's — fails here. This is the assertion the shape-guard stub cannot make on its own, and the
    // reason that stub no longer copies an adapter's refusal sentence into this file.
    expect(logged?.['detail']).toBe('stub blocked')
  })

  it('still raises the event when the Platform actually obstructed the action', async ({ desk }) => {
    await makeReconcileTask(desk)
    stub.reconcilePlan = planOf('blocked', 'action_stop')

    await desk.server.scheduler.tick(DAY_ANCHOR)

    const raised = desk.server.ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'action_blocked'").get()
    expect(raised?.['n']).toBe(1)
  })

  it('asks again on the Platform’s next day', async ({ desk }) => {
    await makeReconcileTask(desk)

    await desk.server.scheduler.tick(DAY_ANCHOR)
    expect(stub.reconcileCalls).toBe(1)

    await desk.server.scheduler.tick(NEXT_PLATFORM_DAY)
    expect(stub.reconcileCalls).toBe(2)
    // A new day, announced by the day key the adapter is given.
    expect(stub.lastReconcileContext?.dayKey).toBe(dayKeyOf(NEXT_PLATFORM_DAY))
  })

  it('uses the Platform’s day, not the container’s', async ({ desk }) => {
    await makeReconcileTask(desk)

    // 00:30 Shanghai on the 10th, which is still 2026-03-09 in UTC.
    await desk.server.scheduler.tick(SHANGHAI_EARLY)
    expect(stub.reconcileCalls).toBe(1)

    expect(dayKeyOf(SHANGHAI_EARLY)).toBe(dayKeyOf(DAY_ANCHOR))
    expect(new Date(SHANGHAI_EARLY).toISOString().slice(0, 10)).not.toBe(
      new Date(DAY_ANCHOR).toISOString().slice(0, 10)
    )

    // A UTC-keyed "today" — what a container defaults to — would call this a new day
    // and re-run the whole chore list eight hours early.
    await desk.server.scheduler.tick(DAY_ANCHOR)
    expect(stub.reconcileCalls).toBe(1)
  })

  it('does not pull a second switched-on action into this Task’s run', async ({ desk }) => {
    await makeReconcileTask(desk)

    await desk.server.scheduler.tick(DAY_ANCHOR)
    expect(stub.reconcileCalls).toBe(1)

    await enableAction(desk, SECOND_RECONCILE_ACTION)

    // Today is settled for the action this Task names, and a second switch does not reopen it: the
    // work is named by the row, not by the Platform's switched-on list.
    await desk.server.scheduler.tick(LATER_SAME_DAY)
    expect(stub.reconcileCalls).toBe(1)

    // Tomorrow, the run that does happen carries one key.
    await desk.server.scheduler.tick(NEXT_PLATFORM_DAY)
    expect(stub.reconcileCalls).toBe(2)
    expect(stub.lastReconcileContext?.enabledActions).toEqual([RECONCILE_ACTION])
  })
})

/**
 * A reconcile run carries **the action its Task names, and only that one**.
 *
 * The owner's report, verbatim: 「为什么创建亲密度任务会去粉丝家园钓鱼」. 亲密度任务 and 粉丝家园钓鱼 are both
 * per-Room, so both matched every Room-scoped Task, and the `action_key` on the row — the one the UI
 * prints as 「动作：亲密度任务」 — decided nothing at all.
 *
 * The stub answers whatever it is handed (`shapeGuardPlan`), so a run that carried an extra key is
 * observable rather than merely unasserted, and the counting is per key: "it refused" and "it was
 * never invoked" are different facts, and only the second one stops the requests a rate-limiting
 * Platform sees.
 */
describe('reconcile — a run carries the action its Task names', () => {
  it('does not run a second per-Room action that is switched on — the reported regression', async ({ desk }) => {
    const taskId = await makeTargetReconcileTask(desk, TARGET_RECONCILE_ACTION)
    // 钓鱼: switched on, and of exactly the same shape as the action this Task names. Handed over it
    // would answer `done`, so what follows is a statement about zero calls rather than about how it
    // would have been refused.
    await enableAction(desk, SECOND_TARGET_RECONCILE_ACTION)
    stub.reconcilePlan = shapeGuardPlan

    await desk.server.scheduler.tick(DAY_ANCHOR)

    expect(dispatchCount(TARGET_RECONCILE_ACTION)).toBe(1)
    expect(dispatchCount(SECOND_TARGET_RECONCILE_ACTION)).toBe(0)
    expect(stub.lastReconcileContext?.enabledActions).toEqual([TARGET_RECONCILE_ACTION])
    // And the day's own record names only what was attempted.
    expect(loggedKeys(desk, taskId)).toEqual([TARGET_RECONCILE_ACTION])
  })

  it('does not run the account-scoped action either, however its shape reads', async ({ desk }) => {
    const taskId = await makeTargetReconcileTask(desk, TARGET_RECONCILE_ACTION)
    await enableAction(desk, RECONCILE_ACTION)
    stub.reconcilePlan = shapeGuardPlan

    await desk.server.scheduler.tick(DAY_ANCHOR)

    expect(dispatchCount(RECONCILE_ACTION)).toBe(0)
    expect(stub.lastReconcileContext?.targetKey).toBe('12345')
    expect(stub.lastReconcileContext?.enabledActions).toEqual([TARGET_RECONCILE_ACTION])
    // The adapter's own guard stays where it is — it is the defence against any other caller handing
    // a Room's task to an account-scoped action — and this is the statement that the runner no longer
    // reaches it: it never carries a key the row does not name.
    expect(loggedCodes(desk, taskId)).not.toContain('not_account_scoped')
  })

  it('runs two Tasks on one room, each carrying its own action', async ({ desk }) => {
    // The behaviour that replaces the accidental one: same Room, same person, two rows — and each row
    // runs the action it names. Under the old (Platform, target) key the second create was handed the
    // first row, so this second action had nowhere to run at all.
    const first = await makeTargetReconcileTask(desk, TARGET_RECONCILE_ACTION)
    const second = await makeTargetReconcileTask(desk, SECOND_TARGET_RECONCILE_ACTION)
    expect(second).not.toBe(first)
    stub.reconcilePlan = shapeGuardPlan

    await desk.server.scheduler.tick(DAY_ANCHOR)

    expect(dispatchCount(TARGET_RECONCILE_ACTION)).toBe(1)
    expect(dispatchCount(SECOND_TARGET_RECONCILE_ACTION)).toBe(1)
    expect(loggedKeys(desk, first)).toEqual([TARGET_RECONCILE_ACTION])
    expect(loggedKeys(desk, second)).toEqual([SECOND_TARGET_RECONCILE_ACTION])
  })

  it('settles each Task’s own day, so neither re-sweeps the other’s work', async ({ desk }) => {
    const first = await makeTargetReconcileTask(desk, TARGET_RECONCILE_ACTION)
    const second = await makeTargetReconcileTask(desk, SECOND_TARGET_RECONCILE_ACTION)
    stub.reconcilePlan = shapeGuardPlan

    await desk.server.scheduler.tick(DAY_ANCHOR)
    expect(stub.reconcileCalls).toBe(2)

    // Ten minutes on, a one-second cadence long since due: further calls could only be a Task failing
    // to consult what it already knows.
    await desk.server.scheduler.tick(LATER_SAME_DAY)
    expect(stub.reconcileCalls).toBe(2)
    expect(actionLogCount(desk, first)).toBe(1)
    expect(actionLogCount(desk, second)).toBe(1)
    expect(statusOf(desk, first)).not.toBe(TaskStatus.Failed)
  })

  it('still runs a task on a Platform whose reconcile actions are all one shape', async ({ desk }) => {
    // Douyu's case: every chore is account-scoped, and the row names the one it wants out of them.
    const taskId = await makeReconcileTask(desk)
    await enableAction(desk, SECOND_RECONCILE_ACTION)
    stub.reconcilePlan = shapeGuardPlan

    await desk.server.scheduler.tick(DAY_ANCHOR)

    expect(dispatchCount(RECONCILE_ACTION)).toBe(1)
    expect(dispatchCount(SECOND_RECONCILE_ACTION)).toBe(0)
    expect(stub.lastReconcileContext?.enabledActions).toEqual([RECONCILE_ACTION])
    expect(statusOf(desk, taskId)).toBe(TaskStatus.Running)

    // And that day settles on the same rule as any other.
    await desk.server.scheduler.tick(LATER_SAME_DAY)
    expect(stub.reconcileCalls).toBe(1)
  })
})

/**
 * An Action the switchboard has off says so, instead of vanishing.
 *
 * Nothing used to be written at all in this state: the sweep found no reconcilable key, stamped the
 * cadence and moved on, so the Task looked healthy, the switch looked off, and no screen connected the
 * two — which is the other half of the owner's complaint (「动作开关和实际任务逻辑还是没有理清」).
 *
 * `blocked` rather than `skipped`, and the difference is load-bearing: `settledToday` reads a stored
 * outcome through `isSettledOutcome` (`repo/action-logs.ts`), where settled is `done`/`already`/`skipped`
 * and an unrecognised value is read as `failed` — so a *settled* report here would freeze the action's day
 * and make flipping the switch on at noon do nothing until the Platform's tomorrow.
 */
describe('reconcile — an action the switchboard has off', () => {
  it('reports the switch by name instead of running nothing quietly', async ({ desk }) => {
    const taskId = await makeReconcileTask(desk)
    // Created while it was on — the create route refuses a Task for a switched-off action — and turned
    // off afterwards, which is the order a person lives in.
    await disableAction(desk, RECONCILE_ACTION)

    await desk.server.scheduler.tick(DAY_ANCHOR)

    expect(stub.reconcileCalls).toBe(0)

    const row = desk.server.ctx.db
      .prepare('SELECT action_key, outcome, code, detail FROM action_logs WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId)
    expect(row?.['action_key']).toBe(RECONCILE_ACTION)
    expect(row?.['outcome']).toBe('blocked')
    expect(row?.['code']).toBe('switch_off')
    // The switch is named in the words the settings screen uses for it.
    expect(String(row?.['detail'])).toContain('测试对账')
  })

  it('runs as soon as the switch is on, because the day never settled', async ({ desk }) => {
    const taskId = await makeReconcileTask(desk)
    await disableAction(desk, RECONCILE_ACTION)
    await desk.server.scheduler.tick(DAY_ANCHOR)
    expect(dispatchCount(RECONCILE_ACTION)).toBe(0)

    await enableAction(desk, RECONCILE_ACTION)
    await desk.server.scheduler.tick(LATER_SAME_DAY)

    // The whole reason the report is `blocked`: the day was parked, not answered.
    expect(stub.reconcileCalls).toBe(1)
    expect(dispatchCount(RECONCILE_ACTION)).toBe(1)
    // The parking report, then the run's own record.
    expect(actionLogCount(desk, taskId)).toBe(2)
  })

  it('writes the report once per Platform day, not once per cadence tick', async ({ desk }) => {
    const taskId = await makeReconcileTask(desk)
    await disableAction(desk, RECONCILE_ACTION)

    await desk.server.scheduler.tick(DAY_ANCHOR)
    await desk.server.scheduler.tick(LATER_SAME_DAY)
    // Same Platform day: the standing condition is already written down, and repeating it would bury
    // the day's real work under the same sentence.
    expect(actionLogCount(desk, taskId)).toBe(1)

    await desk.server.scheduler.tick(NEXT_PLATFORM_DAY)
    expect(actionLogCount(desk, taskId)).toBe(2)
  })

  it('raises no event for a switch a person flipped deliberately', async ({ desk }) => {
    await makeReconcileTask(desk)
    await disableAction(desk, RECONCILE_ACTION)

    await desk.server.scheduler.tick(DAY_ANCHOR)

    expect(eventCount(desk, 'action_blocked')).toBe(0)
    expect(eventCount(desk, 'action_failed')).toBe(0)
  })
})

/**
 * The Action switch gates a **send** Task, and this is a decision rather than a bug fix.
 *
 * `README.md` has always promised 「没打开的动作不会被任何任务执行」, and only the create path honoured
 * it: closing the switch after a Task existed left the Task sending. The owner chose to make the code
 * mean the sentence, so these cases pin the chosen behaviour deliberately — a reader who finds them
 * surprising is reading a verdict, and the reason is written where the check itself is (`runner.ts`'s
 * `runSend`).
 *
 * The report is the reconcile channel's own vocabulary — `blocked`/`switch_off`, once per Platform day,
 * the same sentence naming the same switch — and the value is chosen for what it says about the row rather
 * than for the day. **The reconcile path's reason does not carry over**: there `skipped` would freeze the
 * action's day (`settledToday` reads `isSettledOutcome`), while a send Task never asks `settledToday` at
 * all. `blocked` is still the right value — "parked, and worth attempting again" — and `runner.ts`'s own
 * note at the check says which half of the reasoning survives here and which does not.
 */
describe('send — an action the switchboard has off', () => {
  it('stops a Task that already exists, which the create path alone could not do', async ({ desk }) => {
    const taskId = await makeSendTask(desk)

    await desk.server.scheduler.tick(DAY_ANCHOR)
    expect(stub.sendCalls).toBe(1)

    // Created while the switch was on — the only way the create route will let one exist — and closed
    // afterwards, which is the order a person lives in.
    await disableAction(desk, ACTION_KEY)
    await desk.server.scheduler.tick(LATER_SAME_DAY)

    expect(stub.sendCalls).toBe(1)

    const row = desk.server.ctx.db
      .prepare('SELECT action_key, outcome, code, detail FROM action_logs WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId)
    expect(row?.['action_key']).toBe(ACTION_KEY)
    expect(row?.['outcome']).toBe('blocked')
    expect(row?.['code']).toBe('switch_off')
    // Named in the words the settings screen uses for that switch, which is the point of sharing the
    // vocabulary rather than writing a second sentence here.
    expect(String(row?.['detail'])).toContain('测试发送')
  })

  it('writes the report once per Platform day, not once per cadence tick', async ({ desk }) => {
    const taskId = await makeSendTask(desk)
    await disableAction(desk, ACTION_KEY)

    await desk.server.scheduler.tick(DAY_ANCHOR)
    await desk.server.scheduler.tick(LATER_SAME_DAY)
    expect(actionLogCount(desk, taskId)).toBe(1)

    await desk.server.scheduler.tick(NEXT_PLATFORM_DAY)
    expect(actionLogCount(desk, taskId)).toBe(2)
  })

  it('raises no event for a switch a person flipped deliberately', async ({ desk }) => {
    await makeSendTask(desk)
    await disableAction(desk, ACTION_KEY)

    await desk.server.scheduler.tick(DAY_ANCHOR)

    expect(eventCount(desk, 'action_blocked')).toBe(0)
    expect(eventCount(desk, 'action_failed')).toBe(0)
  })
})

/**
 * A Task that cannot run its action says so **on every day that is true**, including a day it already
 * ran on.
 *
 * The bound used to be read off the Task's `last_sent_at`, which every successful run stamps as well —
 * so on the ordinary timeline (a Task that ran this morning, whose switch somebody closed at noon) the
 * bound read "today" and the report was never written on the one day it exists to explain. This is the
 * case the four cases above could not state: all of them close the switch *before* the first tick, so
 * the cadence column is still `NULL` in every one of them.
 */
describe('a standing report is bounded by the report, not by the cadence clock', () => {
  it('still writes the reason down on a day the Task already ran', async ({ desk }) => {
    const taskId = await makeReconcileTask(desk)

    // A healthy morning: the action runs, its day settles, and `last_sent_at` is today's.
    await desk.server.scheduler.tick(DAY_ANCHOR)
    expect(dispatchCount(RECONCILE_ACTION)).toBe(1)
    expect(loggedCodes(desk, taskId)).toEqual(['stub'])

    await disableAction(desk, RECONCILE_ACTION)
    await desk.server.scheduler.tick(LATER_SAME_DAY)

    // The run's own record, and then the switch's — the `switch_off` row is what "why is nothing
    // happening any more" is answered from, and it disappeared for the rest of the day before this.
    expect(loggedCodes(desk, taskId)).toEqual(['stub', 'switch_off'])
  })
})

/**
 * `require_online` gates a room-scoped reconcile Action, which nothing used to enforce.
 *
 * The interface offers 「等待开播」 for every `needsTarget` action whatever executor runs it, and the
 * adapters' own documentation hands the precondition over rather than implementing it ("the seam does
 * not hand `requireOnline` over in `ReconcileContext`, so there is nothing here that could enforce
 * it" — `platform/bilibili/index.ts`). The runner passed a hardcoded `false` into its own decision and
 * never probed, so the column was stored and read by nobody.
 *
 * The second half of the same fact is what these cases also pin: recording the probe's answer is the
 * only thing that can fill in a reconcile Task's 「开播状态」, which could otherwise only ever read
 * 「尚未探测」.
 */
describe('reconcile — a room-scoped Action waits for the room when the Task asks it to', () => {
  it('holds the Action while the room is offline, and records what the probe saw', async ({ desk }) => {
    const taskId = await makeTargetReconcileTask(desk)
    stub.probePlan = async () => liveProbe(0)

    await desk.server.scheduler.tick(DAY_ANCHOR)

    expect(stub.reconcileCalls).toBe(0)
    expect(dispatchCount(TARGET_RECONCILE_ACTION)).toBe(0)
    expect(statusOf(desk, taskId)).toBe(TaskStatus.Offline)
    expect(lastLiveStatusOf(desk, taskId)).toBe(0)
  })

  it('runs it as soon as the room is live', async ({ desk }) => {
    await makeTargetReconcileTask(desk)
    stub.probePlan = async () => liveProbe(0)
    await desk.server.scheduler.tick(DAY_ANCHOR)
    expect(dispatchCount(TARGET_RECONCILE_ACTION)).toBe(0)

    stub.probePlan = async () => liveProbe(1)
    await desk.server.scheduler.tick(LATER_SAME_DAY)

    expect(dispatchCount(TARGET_RECONCILE_ACTION)).toBe(1)
  })

  it('leaves an account-scoped Action alone, because there is no room to wait for', async ({ desk }) => {
    await makeReconcileTask(desk)
    stub.probePlan = async () => liveProbe(0)

    await desk.server.scheduler.tick(DAY_ANCHOR)

    expect(dispatchCount(RECONCILE_ACTION)).toBe(1)
    expect(stub.probeCalls).toBe(0)
  })
})

/**
 * The send log keeps the Platform's own code.
 *
 * It held a literal `0` for a while, which the task detail page renders on a failed row (`#{code}`) —
 * and on both Platforms `0` is the *success* code, so every rejection was shown as a success code.
 * Both halves of that repair are asserted here: the write (a stale constant would fail either case)
 * and the read (`send_logs.code` is declared `INTEGER`, so a numeric code comes back as a number while
 * a symbolic one comes back as text — reading the column with `asString` would turn the first into an
 * empty string, which is the same defect wearing a different spelling).
 */
describe('send — the log keeps the Platform’s own code', () => {
  it('stores a numeric code instead of a constant', async ({ desk }) => {
    const taskId = await makeSendTask(desk)
    stub.sendPlan = async () => ({ ok: false, code: '10030', detail: '弹幕太长', failure: 'retry' })

    await desk.server.scheduler.tick(DAY_ANCHOR)

    const log = listSendLogs(desk.server.ctx.db, taskId)[0]
    expect(log?.ok).toBe(false)
    expect(log?.code).toBe('10030')
    expect(log?.error).toBe('弹幕太长')
  })

  it('stores a symbolic code too, which the column’s own affinity cannot represent as a number', async ({ desk }) => {
    const taskId = await makeSendTask(desk)
    // The sentence is the stub's own rather than one of the adapter's, for the reason `shapeGuardPlan`
    // states: a copy of an adapter's wording reads as a check on it and is not one. What this case is about
    // is that the *symbolic* code survives the exchange, and the assertion below adds the other half — the
    // sentence travels with it, unedited, which is what the detail page renders.
    const refused = 'stub：这个目标不可能有效'
    stub.sendPlan = async () => ({
      ok: false,
      code: 'bad_target',
      detail: refused,
      failure: 'action_stop'
    })

    await desk.server.scheduler.tick(DAY_ANCHOR)

    const log = listSendLogs(desk.server.ctx.db, taskId)[0]
    expect(log?.code).toBe('bad_target')
    expect(log?.error).toBe(refused)
  })
})

/**
 * `stop()` resolves only once no sweep is running.
 *
 * `clearInterval` stops the *next* sweep and never the current one, and a sweep's awaits are Platform
 * calls that can take tens of seconds — so a shutdown that stops the scheduler and then closes the
 * database (which is what `index.ts` does, and what its comment promises) needs a signal from the
 * sweep itself, not a "give it a moment".
 */
describe('stop', () => {
  it('waits for the sweep in flight instead of returning while it can still write', async ({ desk }) => {
    const scheduler = new Scheduler({ db: desk.server.ctx.db })
    await makeSendTask(desk)

    let release: () => void = (): void => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    stub.sendPlan = async () => {
      await held
      return { ok: true, code: '0', detail: '', failure: 'none' }
    }

    const sweeping = scheduler.tick(DAY_ANCHOR)
    // The sweep is inside `platform.send` by now, and it cannot finish until `release` runs.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(stub.sendCalls).toBe(1)

    let drained = false
    void scheduler.stop().then(() => {
      drained = true
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(drained).toBe(false)

    release()
    await sweeping
    await scheduler.stop()
    expect(drained).toBe(true)
  })
})

/**
 * A Task whose own configuration cannot run the action it names.
 *
 * The create route refuses a `needsTarget` action with no Target and says nothing about the other
 * direction, so an account-scoped action on a row that carries a Room is a row that can still be
 * written — by hand today, and by the old rule's create-or-get before that. It is **reported** rather
 * than reinterpreted: the row names one action now, so there is no second reading of it that could
 * quietly choose other work.
 */
describe('reconcile — a row that cannot run its own action', () => {
  it('reports the mismatch, and reaches the feed, instead of accepting it silently', async ({ desk }) => {
    await enableAction(desk, RECONCILE_ACTION)

    const response = await desk.server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: desk.session.auth(),
      payload: {
        platform: PLATFORM_KEY,
        accountId: desk.accountId,
        actionKey: RECONCILE_ACTION,
        // The reverse of what the create route refuses: an account-scoped action, aimed at a Room.
        targetKey: '12345',
        targetTitle: '测试房间',
        startTime: DAY_ANCHOR - 24 * HOUR,
        endTime: DAY_ANCHOR + 48 * HOUR
      }
    })
    expect(response.statusCode).toBe(200)
    const taskId = response.json<{ task: { id: number } }>().task.id

    await desk.server.scheduler.tick(DAY_ANCHOR)

    expect(dispatchCount(RECONCILE_ACTION)).toBe(0)
    const row = desk.server.ctx.db
      .prepare('SELECT outcome, code FROM action_logs WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId)
    expect(row?.['outcome']).toBe('failed')
    expect(row?.['code']).toBe('unexpected_target')

    // `failed` and not `blocked`: waiting changes nothing, and the person who can replace the row is
    // whoever reads the feed.
    expect(eventCount(desk, 'action_failed')).toBe(1)
  })
})

/**
 * The per-action options channel.
 *
 * `action_settings.options` had a store, a route that stored whatever the client sent, and a UI that
 * echoed it back — and **no consumer at all**, so anything a person set on a switch was silently ignored.
 * `ReconcileContext.options` is the consumer side, and these cases pin the three ways that channel can be
 * wrong: a value that never arrives, an action handed nothing where the seam promises an object, and —
 * the one this shape most invites — one action seeing another action's options, because one Platform's
 * two switches share a single table.
 */
describe('reconcile — the per-action options channel', () => {
  it('hands each action the options its owner stored', async ({ desk }) => {
    await enableActionWithOptions(desk, RECONCILE_ACTION, { threshold: 5 })
    await makeReconcileTask(desk)

    await desk.server.scheduler.tick(DAY_ANCHOR)

    expect(stub.lastReconcileContext?.options[RECONCILE_ACTION]).toEqual({ threshold: 5 })
  })

  it('hands an action nobody set anything on an empty object, never nothing', async ({ desk }) => {
    await makeReconcileTask(desk)

    await desk.server.scheduler.tick(DAY_ANCHOR)

    // The invariant `types.ts` states: every key in `enabledActions` has an entry, and every entry is an
    // object. A field that could be `undefined` would make every adapter spell `?? {}` and one of them
    // would forget — which is how a setting that can be changed ends up ignored for a second time.
    const options = stub.lastReconcileContext?.options
    expect(options).toBeDefined()
    expect(Object.hasOwn(options ?? {}, RECONCILE_ACTION)).toBe(true)
    expect(options?.[RECONCILE_ACTION]).toEqual({})
  })

  it('hands the one action the run carries its own options, and no other action’s', async ({ desk }) => {
    await enableActionWithOptions(desk, RECONCILE_ACTION, { giftAllowlist: ['24468'] })
    await makeReconcileTask(desk)
    // A second action of the same Platform, with options of its own. Through the same route, which
    // also covers the store's other half: a later toggle that omits `options` keeps what is stored,
    // so the first action's values must survive this second write.
    await enableActionWithOptions(desk, SECOND_RECONCILE_ACTION, { somethingElse: true })

    await desk.server.scheduler.tick(DAY_ANCHOR)

    // One key, because a run carries one action — which is also the one way this map could have
    // leaked one action's settings into another's. It cannot, because the other action is not in it.
    expect(stub.lastReconcileContext?.options).toEqual({
      [RECONCILE_ACTION]: { giftAllowlist: ['24468'] }
    })
  })
})
