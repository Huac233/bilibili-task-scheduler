import type { DatabaseSync } from 'node:sqlite'

import { transaction } from '../db/tx.js'
import { platformAccountOf } from '../platform/account.js'
import { allPlatforms, platformFor } from '../platform/registry.js'
import { dayKeyOf, startOfPlatformDay } from '../platform/time.js'
import type { ActionOutcome, FailureKind, Platform, PlatformAccount } from '../platform/types.js'
import { type Account, getAccountById, listAccountsByPlatform, updateAccountCredentials } from '../repo/accounts.js'
import { appendActionLog, hasActionLogWithCodeSince, settledActionKeysSince } from '../repo/action-logs.js'
import { actionOptions, getActionSetting } from '../repo/action-settings.js'
import { appendEvent, EventKind, EventSeverity, hasRecentEvent } from '../repo/events.js'
import { getBulletAt } from '../repo/libraries.js'
import { appendSendLog } from '../repo/send-logs.js'
import {
  listSchedulableTasks,
  type Task,
  TaskAction,
  TaskStatus,
  updateTaskError,
  updateTaskLastSent,
  updateTaskMonitor,
  updateTaskProgress,
  updateTaskStatus
} from '../repo/tasks.js'
import {
  decide,
  isRoomLive,
  reconcileSelectionFor,
  type StandingReport,
  shouldPollNow,
  switchOffReport
} from './logic.js'
import { applySalt, DEFAULT_SALT_COUNT } from './salt.js'

/**
 * The scheduler.
 *
 * A single timer sweeps all non-terminal tasks and acts on each one. There is no
 * per-task timer and no external queue: at this scale (tens of tasks, each firing
 * at most every 10 seconds) a sweep is simpler to reason about than thousands of
 * pending jobs, and it survives a restart for free because all state lives in the
 * database.
 *
 * Two properties the implementation is careful about:
 *
 *  - **A failing task never blocks the sweep.** Each task is processed inside its
 *    own try/catch; one expired session or one bad room id cannot stop the others
 *    from running.
 *
 *  - **Ticks do not overlap.** A slow network call could otherwise let the next
 *    interval start before the previous sweep finished, doing the work twice. The
 *    `ticking` guard makes that impossible.
 *
 * It knows nothing about any Platform. Everything specific — which endpoints, what
 * a credential looks like, how a failure is graded — arrives through the `Platform`
 * object that `registry.ts` hands back for a task's `platform` column. That is the
 * whole point of the seam: this file used to import `resolveRoom`, `sendDanmaku`,
 * `WbiKeyStore` and `SendDanmakuCode` directly, and detect an expired session by
 * searching an error message for `-101`.
 */

export interface SchedulerDeps {
  readonly db: DatabaseSync
  /**
   * Drops any cached client for an account, so the next use rebuilds it from the
   * renewed credential. Called after a successful refresh; without it the
   * scheduler keeps using the session it already holds and the renewal has no
   * effect.
   */
  readonly forgetAccountClient?: (accountId: number) => void
  readonly log?: (message: string) => void
}

export interface SchedulerOptions {
  /** Sweep period. Sends are gated by `interval`, so this only bounds latency. */
  readonly tickIntervalMs?: number
}

export interface TickReport {
  readonly scanned: number
  readonly sent: number
  readonly reconciled: number
  readonly monitored: number
  readonly finished: number
  readonly failed: number
}

const DEFAULT_TICK_MS = 5_000

/**
 * How long one kind of event is suppressed for, per task.
 *
 * The sweep runs every few seconds, so a persistent condition — a dead session, a
 * muted account — would otherwise emit an event on every pass and drown the
 * consumer. The window is deliberately much longer than the sweep interval.
 */
const EVENT_SUPPRESS_MS = 30 * 60 * 1000

/**
 * How often to look at renewing sessions. Each check is an HTTP round trip per
 * account, and a session does not need renewing on every sweep.
 */
const REFRESH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  /**
   * The sweep in flight, as a signal that resolves when its work is over.
   *
   * Deliberately not the `tick()` promise itself: `tick` may hand its caller a promise that rejects,
   * and a signal that rejects is one more thing a waiter has to handle. What a waiter wants to know
   * is "is any of this still going to touch the database", and that is what this answers — it is
   * resolved in the same `finally` that clears `ticking`, so both facts turn over together.
   */
  private inFlight: Promise<void> | null = null
  private lastRefreshCheckAt = 0
  private readonly tickIntervalMs: number
  private readonly log: (message: string) => void

  constructor(
    private readonly deps: SchedulerDeps,
    options: SchedulerOptions = {}
  ) {
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS
    this.log = deps.log ?? ((): void => {})
  }

  /** Starts the sweep loop. Idempotent. */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      // Each task inside `tick` is guarded, but the sweep's own preamble is not:
      // `maybeRefreshAccounts` and `listSchedulableTasks` both run outside that
      // guard, and a throw from either would surface as an unhandled rejection at
      // process level instead of as a line in the log — the opposite of what this
      // scheduler is for.
      void this.tick().catch((error: unknown) => {
        this.log(`sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, this.tickIntervalMs)
    // Do not keep the process alive purely for the scheduler.
    this.timer.unref()
    this.log(`scheduler started (sweep every ${String(this.tickIntervalMs)}ms)`)
  }

  /**
   * Whether the sweep loop is armed — the fact `/api/health` reports as `schedulerReady`.
   *
   * It exists because that field used to be the literal `true`, which is a claim nothing checked and
   * which stayed true on a process whose loop had been stopped. The two callers differ: the entry point
   * starts the loop once the socket is listening, and a test-built server never starts it at all, so the
   * answer is genuinely different in the two and the endpoint can now say which one it is.
   *
   * What it is *not* is "the sweep is running this instant": a loop between two ticks is armed and idle,
   * and this is the field an orchestrator reads to decide whether the process is doing its job at all.
   */
  isRunning(): boolean {
    return this.timer !== null
  }

  /**
   * Stops the loop and **resolves once no sweep is running**.
   *
   * The wait is the whole point, and its absence was a real defect rather than an omission.
   * `clearInterval` stops the *next* sweep, never the current one, and a sweep's awaits are Platform
   * calls that can take tens of seconds — so a shutdown that stopped the scheduler and then closed
   * the database (which is what `index.ts` does, and its comment says so: 「an in-flight send cannot
   * write to a closed handle」) could still have a sweep resume on a closed handle. The old `stop`
   * returned `void`, so no caller *could* wait for the thing it was promising.
   *
   * Hence a promise and not a stronger version of the same silence: a caller either awaits this or
   * does not, and both are visible at the call site. `index.ts`'s shutdown awaits it before it closes
   * the handle; a caller that does not keeps today's best-effort behaviour on purpose. What this must
   * never become is a `setTimeout`-style "give it a moment": the signal is the sweep's own
   * completion, so a waiter that resumes here cannot observe a write after it.
   *
   * A second call is harmless: the loop is already stopped, and the wait is the same wait.
   */
  async stop(): Promise<void> {
    const wasRunning = this.timer !== null
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }

    // One await is enough: with the interval cleared nothing can install a new mark, so this field is
    // either the sweep that was running when `stop` was called or already null.
    await this.inFlight

    // Logged after the wait rather than before it, because "scheduler stopped" is a claim about the
    // moment this resolves — the log line was previously true of the timer and false of the sweep.
    if (wasRunning) this.log('scheduler stopped')
  }

  /**
   * Runs one sweep. Exposed so tests can drive it deterministically instead of
   * waiting on wall-clock time.
   */
  async tick(now: number = Date.now()): Promise<TickReport> {
    const report = { scanned: 0, sent: 0, reconciled: 0, monitored: 0, finished: 0, failed: 0 }
    if (this.ticking) return report

    // The mark `stop` waits on. Installed only by the sweep that actually runs — a second `tick` while
    // one is in flight returns above and must not overwrite (nor later clear) this one's, or `stop`
    // would resolve while the real sweep was still writing.
    let markDone: () => void = (): void => {}
    this.inFlight = new Promise<void>(resolve => {
      markDone = resolve
    })

    this.ticking = true
    try {
      await this.maybeRefreshAccounts(now)

      const tasks = listSchedulableTasks(this.deps.db)
      report.scanned = tasks.length

      for (const task of tasks) {
        try {
          const outcome = await this.processTask(task, now)
          if (outcome === 'send') report.sent += 1
          else if (outcome === 'reconcile') report.reconciled += 1
          else if (outcome === 'monitor') report.monitored += 1
          else if (outcome === 'finish') report.finished += 1
          else if (outcome === 'fail') report.failed += 1
        } catch (error: unknown) {
          // Network hiccups are expected; the task simply tries again next sweep.
          const message = error instanceof Error ? error.message : String(error)
          this.log(`task ${String(task.id)} sweep error: ${message}`)
        }
      }
    } finally {
      // Both facts turn over here and nowhere else: no sweep is running, and no sweep is going to
      // touch the database. A `stop()` waiting on the mark resumes after this.
      this.ticking = false
      this.inFlight = null
      markDone()
    }

    return report
  }

  // ------------------------------------------------------------------ //
  // Session upkeep
  // ------------------------------------------------------------------ //

  /**
   * Extends every session an adapter says it can extend.
   *
   * Asking each Platform's adapter rather than reading a `refresh_token` column is what makes
   * this work for a Platform whose credential cannot be renewed without a person. Douyu renews
   * one — it rebuilds its `acf_*` family from `LTP0` — but holds no local signal that could
   * judge a token dead, so its dead-session case still arrives through the actions, as the
   * server's own `-101` graded `account_stop`. `relogin_required` is therefore the renewal that
   * was asked for and cannot happen — the Platform refusing the exchange, or the adapter holding
   * nothing to present for one — and never a verdict on the token itself.
   */
  private async maybeRefreshAccounts(now: number): Promise<void> {
    if (now - this.lastRefreshCheckAt < REFRESH_CHECK_INTERVAL_MS) return
    this.lastRefreshCheckAt = now

    for (const platform of allPlatforms()) {
      if (platform.refresh === undefined) continue

      for (const account of listAccountsByPlatform(this.deps.db, platform.key)) {
        try {
          const outcome = await platform.refresh(this.platformAccountOf(account))
          if (outcome.status === 'refreshed' && outcome.credentials !== undefined) {
            // Persist before anything else. The adapter hands back the credential it
            // just used, and a Bilibili refresh rotates the refresh token — so
            // dropping this write leaves the *old* token in the database, which the
            // server has already invalidated. The failure would not show up until a
            // restart, and would look like "the session died for no reason".
            updateAccountCredentials(this.deps.db, account.id, outcome.credentials, now)
            this.deps.forgetAccountClient?.(account.id)
            this.log(`account ${String(account.id)}: session refreshed`)
          }
          if (outcome.status === 'failed') {
            // **Logged, and deliberately not raised as an event.** `failed` means one exchange was
            // attempted and produced no usable family; nothing was handed back, so the row still
            // holds a credential that works and the next check — six hours out — tries again. Four
            // attempts a day is a schedule, not an incident, and an event here would put
            // 「登录已失效」 on the feed every six hours for a credential that is still perfectly
            // usable: the same false alarm the refresh rule was narrowed to remove, under a new
            // name. The failure that does deserve the feed is the family actually lapsing, and that
            // one already has a voice — the server's own `-101` on the action paths, graded
            // `account_stop` and shown to a person as `SessionExpired`. What is left for this line
            // to do is let an operator watch the exchange failing while the credential is still good.
            this.log(`account ${String(account.id)}: session renewal failed: ${outcome.detail}`)
          }
          if (outcome.status === 'relogin_required') {
            this.emitAccountOnce(account, platform, now)
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          this.log(`account ${String(account.id)} refresh error: ${message}`)
        }
      }
    }
  }

  /**
   * A renewal that cannot happen needs a human, so `relogin_required` goes on the feed. A
   * successful one does not: it happens on a schedule and nobody wants a notification every six
   * hours saying nothing changed. Neither does a `failed` one — the log line in
   * `maybeRefreshAccounts` states why.
   *
   * The wording survives the narrowing of what raises it, and is checked against both Platforms
   * that reach it, where `relogin_required` is either the refresh exchange refusing the token or
   * a credential with nothing to present for one (a blob that does not parse; a Bilibili jar with
   * no `bili_jct`; a Douyu credential whose renewal is due and which holds no `LTP0`). All of them
   * mean the session cannot be renewed and a re-bind is the remedy, which is exactly what
   * 「登录已失效」 plus that sentence say. A Douyu token that is merely dead is not this case: it
   * is reported by the actions themselves, each in its own terms.
   */
  private emitAccountOnce(account: Account, platform: Platform, now: number): void {
    if (hasRecentEvent(this.deps.db, account.userId, EventKind.SessionExpired, null, EVENT_SUPPRESS_MS, now)) return
    appendEvent(
      this.deps.db,
      {
        userId: account.userId,
        kind: EventKind.SessionExpired,
        severity: EventSeverity.Error,
        title: '登录已失效',
        detail: `${platform.label} 账号的会话已无法自动续期，需要重新绑定。`,
        platform: platform.key,
        accountId: account.id
      },
      now
    )
  }

  // ------------------------------------------------------------------ //
  // Task dispatch
  // ------------------------------------------------------------------ //

  private async processTask(task: Task, now: number): Promise<TaskOutcome> {
    const platform = platformFor(task.platform)
    if (platform === null) {
      this.failTask(task, `未知平台：${task.platform}`, now)
      return 'fail'
    }

    const account = getAccountById(this.deps.db, task.accountId)
    if (account === null) {
      this.failTask(task, `${platform.label} 账号不存在或已被解绑`, now)
      return 'fail'
    }

    return task.action === TaskAction.Reconcile
      ? this.runReconcile(task, platform, account, now)
      : this.runSend(task, platform, account, now)
  }

  /**
   * The reconcile executor: run the one Action this Task names.
   *
   * **The Task's own `actionKey` is the work, and nothing else decides it.** A reconcile Task names
   * exactly one Action, so the run hands the adapter that key and only that one. What used to
   * happen — every enabled key of the Task's own shape — is how a Task whose row said
   * 「动作：亲密度任务」 also ran 粉丝家园钓鱼: both are per-Room, so both matched, and the column a
   * person had just created the Task by decided nothing. `reconcileSelectionFor` holds that rule and
   * the reasons the shape check survived as a validation; what is left here is what the run does with
   * each answer it can come back with.
   *
   * The switchboard's only job is permission: a Task naming an action nobody switched on is parked
   * and **says so**, because "why is nothing happening" otherwise has no answer anywhere — the row
   * would look healthy, the switch would look off, and no screen would connect the two.
   */
  private async runReconcile(task: Task, platform: Platform, account: Account, now: number): Promise<TaskOutcome> {
    const action = decide({
      now,
      startTime: task.startTime,
      endTime: task.endTime,
      interval: task.interval,
      lastSentAt: task.lastSentAt,
      // A reconcile task is not gated on a stream: the adapter decides per action
      // whether a live room is needed at all.
      requireOnline: false,
      liveStatus: null
    })

    if (action.kind === 'wait') return 'idle'
    if (action.kind === 'finish') {
      // `idle` when the write was refused: nothing was finished, and counting it as finished would
      // put a Task in the tick report that the row itself disagrees with.
      return this.finishTask(task, now) ? 'finish' : 'idle'
    }
    if (action.kind === 'cooldown') return 'idle'

    // One row, asked for by the action the Task names — not the Platform's whole switched-on list.
    // Absence means off, which is what `=== true` states without a second notion of "declared".
    const enabled = getActionSetting(this.deps.db, task.userId, task.platform, task.actionKey)?.enabled === true
    const selection = reconcileSelectionFor(platform.actions, task, enabled)

    if (selection.kind === 'unknown') {
      // A row this build cannot serve: a key the adapter no longer declares, or one that is not a
      // Reconcile action at all. The same sentence the send executor uses, because it is the same
      // fact — and because such a row can only ever fail, it fails loudly instead of quietly.
      this.failTask(task, `平台 ${platform.label} 不认识动作 ${task.actionKey}`, now)
      return 'fail'
    }

    if (selection.kind === 'stopped') {
      this.writeStandingReport(task, platform, selection.report, now)
      updateTaskLastSent(this.deps.db, task.id, now)
      return 'monitor'
    }

    const reconcilable = [selection.actionKey]

    // A reconcile run is a daily chore list, not a polling loop.
    //
    // Without this check the sweep re-runs its action every `interval`, and at the adapters' 300 s
    // default that is 288 rounds a day, each making several requests whose only possible answer is
    // "already done". Against a Platform that rate-limits, that is both pointless and the most
    // conspicuous thing this program does. The Platform is the source of truth for what is
    // outstanding, and `action_logs` is where its answer was already written down — so read our own
    // record of today before asking again. `ReconcileContext.dayKey` exists for exactly this, and
    // until now nothing consulted it.
    if (this.settledToday(task, selection.actionKey, now)) {
      updateTaskLastSent(this.deps.db, task.id, now)
      return 'idle'
    }

    const client = this.platformAccountOf(account)

    // **`require_online` gates a room-scoped reconcile Task too, and this is the only layer that can
    // enforce it.** The interface has offered 「等待开播」 for these actions all along — the field is
    // shown for every `needsTarget` action, whichever executor runs it — and the adapters' own
    // documentation hands the precondition over rather than implementing it: 「whether to like into a
    // room that is not streaming is a person's decision, and the seam does not hand `requireOnline`
    // over in `ReconcileContext`, so there is nothing here that could enforce it」
    // (`platform/bilibili/index.ts`, and the same sentence on 观看直播 and on `resolveRoom`). Nothing
    // did enforce it: this function passed a hardcoded `false` into `decide`, never probed, and the
    // column was read by nobody. Enforcing it here rather than in each adapter keeps the switchboard
    // the runner's dependency — and recording the probe's answer on the Task is also what gives the
    // detail page's 「开播状态」 a value, which for a reconcile Task could previously only ever read
    // 「尚未探测」.
    //
    // Only a Task with a Room is gated. `targetKey === ''` means the Action is about the account, and
    // there is no stream to wait for; Douyu's own measurement (an offline room still takes danmaku)
    // is the other half of why this switch is a preference there and a precondition on Bilibili.
    if (task.requireOnline && task.targetKey !== '') {
      if (shouldPollNow(task.lastCheckedAt, now)) {
        let probe: Awaited<ReturnType<Platform['probe']>>
        try {
          probe = await platform.probe(client, task.targetKey)
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error)
          updateTaskError(this.deps.db, task.id, `查询失败：${detail}`, now)
          this.log(`task ${String(task.id)} probe failed: ${detail}`)
          return 'monitor'
        }

        if (!probe.ok) {
          const graded = this.applyFailure(task, platform, probe.failure, probe.detail, probe.code, now)
          return graded === 'fail' ? 'fail' : 'monitor'
        }

        updateTaskMonitor(this.deps.db, task.id, probe.liveStatus, now)

        if (!isRoomLive(probe.liveStatus)) {
          // The stream is not up. Park the Task rather than running its Action: this is the switch the
          // person set, and the status word is the one the task list already uses for it.
          //
          // Parked only while the row is still the one this sweep read. `probe` above is a real await,
          // and the guard below cannot see past the snapshot it reads, so both halves are needed:
          // `writeStatusUnlessMoved` is the half that knows about the person who paused the Task
          // inside that await.
          if (task.status !== TaskStatus.Offline) {
            this.writeStatusUnlessMoved(task, TaskStatus.Offline, now)
          }
          return 'monitor'
        }
      } else if (!isRoomLive(task.lastLiveStatus)) {
        // The cached answer, and the poll is not due yet: same verdict, one request cheaper.
        return 'monitor'
      }
    }

    if (task.status !== TaskStatus.Running) {
      // The Action below writes to the Platform's account — it signs in, it claims what is
      // outstanding — so the promotion is not a note about the run, it is what licenses it. A refusal
      // means the row is no longer the one this sweep read, which a person can bring about while the
      // sweep is elsewhere: inside this Task's probe above, or inside an earlier Task's. The run is
      // then not this sweep's to make, and nothing is lost by skipping it — the next sweep decides
      // again from the row it then reads.
      if (!this.writeStatusUnlessMoved(task, TaskStatus.Running, now)) return 'monitor'
    }

    const outcomes = await platform.reconcile({
      account: client,
      targetKey: task.targetKey,
      enabledActions: reconcilable,
      // What it was switched on with. Read here rather than by the adapter: the
      // switchboard is the runner's dependency, and an adapter that reached into storage for its
      // own settings would be the second reader this seam exists to avoid.
      options: runOptions(reconcilable, actionOptions(this.deps.db, task.userId, task.platform)),
      now,
      dayKey: dayKeyOf(now),
      log: (line: string) => {
        this.log(`task ${String(task.id)}: ${line}`)
      }
    })

    let blocked = false
    for (const outcome of outcomes) {
      appendActionLog(
        this.deps.db,
        {
          taskId: task.id,
          actionKey: outcome.actionKey,
          targetKey: outcome.targetKey,
          outcome: outcome.outcome,
          detail: outcome.detail,
          code: outcome.code,
          // The per-item detail the Platform reported. Without it the row can only
          // say how the run went, and the UI can only count days rather than explain
          // them — which is the state this column was added to end.
          items: outcome.items
        },
        now
      )
      this.reportActionOutcome(task, platform, outcome, now)
      if (isAccountStop(outcome.failure)) {
        this.failTask(task, `${outcome.actionKey}：${outcome.detail}`, now)
        return 'fail'
      }
      if (outcome.failure === 'action_stop') blocked = true
    }

    updateTaskLastSent(this.deps.db, task.id, now)
    // `blocked` means the action is parked until tomorrow; the task itself stays alive.
    return blocked ? 'monitor' : 'reconcile'
  }

  /** Turns one action's outcome into an event, when it is worth telling someone about. */
  private reportActionOutcome(task: Task, platform: Platform, outcome: ActionOutcome, now: number): void {
    if (isAccountStop(outcome.failure)) {
      this.emitAccountStop(task, platform, outcome.failure, outcome.detail, now)
      return
    }
    if (outcome.outcome === 'blocked') {
      // `failure: 'none'` means the Platform parked this action **as a matter of course**,
      // and it is expected back on a later sweep: Douyu's 打卡分鱼丸 before its 19:00 window
      // opens, Bilibili's 观看直播 between one slice and the next. Nothing is broken, so a
      // 「动作受阻」 event would be a false alarm — and an alarm that fires every day for an
      // action that is working exactly as designed is worse than no alarm, because it
      // teaches whoever reads the feed to ignore it. The `code` and `detail` still land in
      // `action_logs`, which is where the debug panel reads them.
      if (outcome.failure === 'none') return
      this.emitOnce(task, platform, EventKind.ActionBlocked, EventSeverity.Warning, '动作受阻', outcome.detail, now)
      return
    }
    if (outcome.outcome === 'failed') {
      this.emitOnce(task, platform, EventKind.ActionFailed, EventSeverity.Warning, '动作失败', outcome.detail, now)
    }
  }

  /**
   * The event an account-level stop raises, by kind.
   *
   * **This is the whole reason `account_restricted` exists.** The two kinds are one verdict
   * to the loop — the task fails either way — and two different instructions to whoever
   * reads the feed: an expired session is cleared by re-binding, a restriction is not.
   * Reporting a restriction as `account_stop` therefore names the wrong remedy, asks for the
   * one action that cannot help, and reports success when it is done.
   *
   * The Platform's own words go into the restricted detail verbatim, because they are what
   * says *which* restriction it is; the sentence after them rules out the remedy this event
   * used to be fused with.
   */
  private emitAccountStop(
    task: Task,
    platform: Platform,
    failure: AccountStopKind,
    detail: string,
    now?: number
  ): void {
    if (failure === 'account_restricted') {
      this.emitOnce(
        task,
        platform,
        EventKind.AccountRestricted,
        EventSeverity.Error,
        '账号被限制',
        `${platform.label} 账号被限制，发送已被平台拒绝：${detail}。这不是登录态问题，重新绑定账号不会解除限制。`,
        now
      )
      return
    }

    this.emitOnce(
      task,
      platform,
      EventKind.SessionExpired,
      EventSeverity.Error,
      '登录已失效',
      `${platform.label} 登录态已过期，需要重新绑定账号。`,
      now
    )
  }

  /**
   * The send executor.
   *
   * The live-status probe runs unconditionally and *before* the cooldown check.
   * That ordering is not incidental: the probe used to live inside the `monitor`
   * branch, so once a task promoted to `running` nothing ever asked whether the
   * room was still live, the cached status stayed "live", and the loop kept
   * sending. A stream ending now gets noticed on the next poll rather than never.
   *
   * **The Action's switch is read here, and that is the deliberate half of this executor** — see the
   * comment at the gate itself, which is the record the owner asked for so that the next reader does
   * not restore the old behaviour as a repair.
   */
  private async runSend(task: Task, platform: Platform, account: Account, now: number): Promise<TaskOutcome> {
    const db = this.deps.db

    const action = decide({
      now,
      startTime: task.startTime,
      endTime: task.endTime,
      interval: task.interval,
      lastSentAt: task.lastSentAt,
      requireOnline: task.requireOnline,
      liveStatus: task.lastLiveStatus
    })

    if (action.kind === 'wait') return 'idle'
    if (action.kind === 'finish') {
      // `idle` when the write was refused: nothing was finished, and counting it as finished would
      // put a Task in the tick report that the row itself disagrees with.
      return this.finishTask(task, now) ? 'finish' : 'idle'
    }

    if (task.targetKey === '') {
      this.failTask(task, '该任务没有目标', now)
      return 'fail'
    }

    // **The Action switch gates a send Task, not merely its creation — and this is a decision, not a
    // bug, so do not "fix" it back.** `README.md` has always promised 「没打开的动作不会被任何任务
    // 执行」, and until now only the create route honoured it: closing the switch after a Task existed
    // left the Task sending. The owner chose to make the code mean the sentence, which is why the
    // report below is written with `reconcileSelectionFor`'s own vocabulary — `blocked`/`switch_off`
    // and the same sentence, once per Platform day — rather than with a second one invented here.
    //
    // **`blocked` rather than `skipped`, and the reconcile path's reason does not carry over.** There the
    // reason is `settledToday`: a settled outcome would freeze the action's own day, so flipping the switch
    // on at noon would do nothing until tomorrow. A send Task never asks `settledToday` — it is called from
    // `runReconcile` and nowhere else — so that half is not what decides this. The value is chosen for what
    // it says about the row: `skipped` means "not applicable this run, nothing outstanding", which is a
    // verdict about the day, while what happened here is that a person closed a switch and a Task still
    // wants to run. `blocked` is the value for parked, and it is the one the reconcile channel already uses
    // for this exact condition, so the two records read as one sentence instead of two. (That record's
    // reader today is its own once-a-day guard — no payload field carries it yet, which is a separate gap
    // rather than a reason to change the value.)
    const descriptor = platform.actions.find(action => action.key === task.actionKey)
    if (descriptor === undefined) {
      // The same sentence `sendOne` fails with, one step earlier: a row naming an action the Platform
      // does not declare can never run, so it must not be parked as though a switch or a stream were
      // what it is waiting for.
      this.failTask(task, `平台 ${platform.label} 不认识动作 ${task.actionKey}`, now)
      return 'fail'
    }

    const enabled = getActionSetting(this.deps.db, task.userId, task.platform, task.actionKey)?.enabled === true
    if (!enabled) {
      // Absence means off, which `=== true` states without a second notion of "declared" — the same
      // reading `runReconcile` makes.
      this.writeStandingReport(task, platform, switchOffReport(descriptor), now)
      updateTaskLastSent(this.deps.db, task.id, now)
      return 'monitor'
    }

    const client = this.platformAccountOf(account)

    if (task.requireOnline && shouldPollNow(task.lastCheckedAt, now)) {
      let probe: Awaited<ReturnType<Platform['probe']>>
      try {
        probe = await platform.probe(client, task.targetKey)
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error)
        updateTaskError(db, task.id, `查询失败：${detail}`, now)
        this.log(`task ${String(task.id)} probe failed: ${detail}`)
        return 'monitor'
      }

      if (!probe.ok) {
        const graded = this.applyFailure(task, platform, probe.failure, probe.detail, probe.code, now)
        return graded === 'fail' ? 'fail' : 'monitor'
      }

      updateTaskMonitor(db, task.id, probe.liveStatus, now)

      // `isRoomLive` rather than a comparison against the normalised value: the
      // scheduler has no business knowing that "live" happens to be 1, and a bare
      // literal here is a second home for a fact the seam already owns.
      if (!isRoomLive(probe.liveStatus)) {
        // Stream ended. Fall back to monitoring so the interval timer starts fresh
        // if it resumes.
        //
        // Parked only while the row is still the one this sweep read, for the reason
        // `writeStatusUnlessMoved` gives: `probe` above is a real await, and `offline` is itself in
        // the sweep's working set, so writing it back over a pause would silently restart the Task
        // the person had just stopped.
        if (task.status !== TaskStatus.Offline) {
          this.writeStatusUnlessMoved(task, TaskStatus.Offline, now)
        }
        return 'monitor'
      }

      if (task.status !== TaskStatus.Running) {
        // Just went live: promote and send immediately rather than waiting out a
        // cooldown that belonged to the previous offline stretch.
        //
        // The promotion licenses the send below and no longer merely annotates it: a person who
        // paused the Task inside that same await asked for nothing to happen to it, and a bullet
        // delivered on a snapshot that no longer holds is something happening to it. A refusal
        // therefore skips both the event and the send — and loses nothing, because a sweep that
        // finds this row live and running next time sends then.
        if (!this.writeStatusUnlessMoved(task, TaskStatus.Running, now)) return 'monitor'
        appendEvent(
          db,
          {
            userId: task.userId,
            kind: EventKind.TaskWentLive,
            title: '直播间开播，开始发送',
            detail: task.targetTitle !== '' ? task.targetTitle : `房间 ${task.targetKey}`,
            platform: task.platform,
            taskId: task.id,
            accountId: task.accountId
          },
          now
        )

        return (await this.sendOne(task, platform, client, now)) ? 'send' : 'fail'
      }
    }

    // `monitor` here means the cached status says offline and the probe was not due
    // yet — sending would be premature.
    if (action.kind === 'monitor' || action.kind === 'cooldown') return 'idle'

    return (await this.sendOne(task, platform, client, now)) ? 'send' : 'fail'
  }

  /**
   * Writes down a condition that lasts for hours — a switch that is off, a row whose own shape cannot
   * run its action — **once per Platform day**.
   *
   * The bound is read off the records themselves (`hasActionLogWithCodeSince`) and not off the
   * Task's `last_sent_at`, and that is the repair of a defect rather than a preference. `last_sent_at`
   * is the *cadence* clock: every successful run stamps it, so on the ordinary timeline — a Task that
   * ran this morning and whose switch somebody closed at noon — the day-stamp was already "today" and
   * the report was never written on the one day it exists to explain. The record cannot be moved by
   * anything but the report, so this asks the same question the report answers. The column keeps its
   * own single meaning, which is the cadence; see `updateTaskLastSent` in `repo/tasks.ts`.
   *
   * `blocked` is silence on the feed, which is what a switch a person flipped deserves: it is not an
   * incident, and `reportActionOutcome` stays quiet for every other parked action too. `failed` is not
   * silent on purpose — a row that waits forever is one somebody has to replace, and the person who
   * can replace it is whoever reads the feed.
   */
  private writeStandingReport(task: Task, platform: Platform, report: StandingReport, now: number): void {
    const dayStart = startOfPlatformDay(now)
    if (hasActionLogWithCodeSince(this.deps.db, task.id, report.actionKey, report.code, dayStart)) return

    appendActionLog(
      this.deps.db,
      {
        taskId: task.id,
        actionKey: report.actionKey,
        targetKey: task.targetKey,
        outcome: report.outcome,
        detail: report.detail,
        code: report.code
      },
      now
    )

    if (report.outcome === 'failed') {
      this.emitOnce(task, platform, EventKind.ActionFailed, EventSeverity.Warning, '动作失败', report.detail, now)
    }
  }

  /**
   * Whether the action this Task names already reached a settled outcome on the Platform's
   * own day.
   *
   * `failed` and `blocked` are deliberately **not** settled. A refusal, or an action
   * we could not complete, is precisely the one worth attempting again — Douyu's
   * 打卡分鱼丸 is `blocked` until its window opens, and a transient failure should get
   * another chance. Everything else (`done`, `already`, `skipped`) means the Platform
   * said there is nothing outstanding, and asking again before the day rolls over
   * cannot change that answer.
   *
   * The day is the Platform's, not the container's: `dayKeyOf` is `Asia/Shanghai`,
   * which is when Douyu resets these obligations.
   */
  private settledToday(task: Task, actionKey: string, now: number): boolean {
    return settledActionKeysSince(this.deps.db, task.id, startOfPlatformDay(now)).includes(actionKey)
  }

  /**
   * Sends one bullet and advances the cursor.
   *
   * The cursor advances even when the send is rejected: a bullet that trips a
   * content filter would otherwise be retried forever and wedge the queue. The
   * failure is recorded in `fail_count` and the send log instead.
   */
  private async sendOne(task: Task, platform: Platform, account: PlatformAccount, now: number): Promise<boolean> {
    const db = this.deps.db

    if (task.libraryId === null) {
      this.failTask(task, '任务未关联文本库', now)
      return false
    }

    const descriptor = platform.actions.find(action => action.key === task.actionKey)
    if (descriptor === undefined) {
      this.failTask(task, `平台 ${task.platform} 不认识动作 ${task.actionKey}`, now)
      return false
    }

    let seq = task.cursor
    let loopCount = task.loopCount

    let content = getBulletAt(db, task.libraryId, seq)
    if (content === null) {
      // Ran off the end: wrap around and count a completed pass.
      seq = 0
      loopCount += 1
      content = getBulletAt(db, task.libraryId, 0)
      if (content === null) {
        this.failTask(task, '文本库为空，无法发送', now)
        return false
      }
    }

    const salted = applySalt(content, {
      count: task.saltEnabled ? DEFAULT_SALT_COUNT : 0,
      maxLength: descriptor.maxMessageLength
    })

    const result = await platform.send(account, task.targetKey, salted.text)

    // **The three writes after the send are one fact, so they are one transaction.**
    //
    // "This attempt happened, and the Task's bookkeeping moved by it" is a single thing to say. Written
    // separately, a crash between them leaves a send log with no cursor advance — which replays the same
    // bullet on the next sweep — or counters counting an attempt whose row never landed. `db/tx.ts` is
    // already what `deleteTask` uses for exactly this shape of reasoning.
    //
    // **What this does not do is make the Platform call itself retractable**, and the difference is worth
    // keeping: if the process dies after the bullet is out and before this commits, the send happened and
    // nothing here records it, and *this* cannot tell that state apart from "never sent" — a savepoint
    // covers local writes only. Distinguishing the two takes a mark written **before** the call, and this
    // build has no column for one. So the replay window is narrowed, not closed, and the next reader
    // should know which of the two they are looking at.
    //
    // **The counters are a check-and-set, and `last_sent_at` deliberately is not.** `task` is a row read at
    // the top of the sweep and `platform.send` above is a real await, so 重置进度 or 恢复 can land in the
    // middle; both clear the counters, and an unconditional write put the pre-reset numbers straight back
    // (`updateTaskProgress` states the case). The clock is not a value derived from that snapshot but the
    // statement "an attempt happened at this instant", true whoever else wrote the row — and dropping it
    // would license a second send inside the cooldown.
    const landed = transaction(db, () => {
      // The Platform's **own** code, not a constant. This wrote a literal `0` for a while, and the
      // interface reads that column on a failed row (`#{code}`), so every rejection was displayed as
      // `#0` — which on both Platforms is the *success* code, i.e. the one value the display must never
      // be able to show for a failure. `result.code` was already in hand and was only being spelled
      // into `last_error` (`applyFailure`) and into the event detail; the log is the third reader and
      // the only one that had been dropped, which is why the store keeps it as text (`SendLog.code`).
      appendSendLog(
        db,
        task.id,
        { content: salted.text, ok: result.ok, code: result.code, error: result.ok ? '' : result.detail },
        now
      )

      const wrote = updateTaskProgress(
        db,
        task.id,
        {
          cursor: seq + 1,
          loopCount,
          sentCount: task.sentCount + 1,
          successCount: task.successCount + (result.ok ? 1 : 0),
          failCount: task.failCount + (result.ok ? 0 : 1)
        },
        {
          cursor: task.cursor,
          loopCount: task.loopCount,
          sentCount: task.sentCount,
          successCount: task.successCount,
          failCount: task.failCount
        },
        now
      )
      updateTaskLastSent(db, task.id, now)
      return wrote
    })

    if (!landed) {
      // Not swallowed, for the reason `writeStatusUnlessMoved` gives: this line is the only trace a
      // person's write and a sweep crossing will leave. The attempt itself is still on the record — the
      // append committed with this same transaction, which is what the rollback is for.
      this.log(`task ${String(task.id)}: progress write refused, the row is no longer the one this sweep read`)
    }

    if (result.ok) return true

    this.applyFailure(task, platform, result.failure, result.detail, result.code, now)
    return false
  }

  /**
   * Loads an account into the shape an adapter takes.
   *
   * The body moved to `platform/account.ts` when the resolve route needed the same mapping; this stays as
   * the scheduler's own door to it, so its three call sites do not each have to carry the database handle.
   */
  private platformAccountOf(account: Account): PlatformAccount {
    return platformAccountOf(this.deps.db, account)
  }

  /**
   * Turns a graded failure into task state and, when it matters, an event.
   *
   * This is the replacement for matching `-101` inside an error message. The code
   * is now the thing that grades, the message is only ever shown to a person, and
   * a Platform that invents new codes cannot silently fall through to "retry
   * forever" without saying so.
   *
   * An account-level stop is both task state and an event, and which event is the
   * adapter's answer to give: the task dies either way, and the person is told to re-bind
   * only when re-binding is what clears it.
   */
  private applyFailure(
    task: Task,
    platform: Platform,
    failure: FailureKind,
    detail: string,
    code: string,
    now: number
  ): 'continuing' | 'fail' {
    if (isAccountStop(failure)) {
      this.failTask(task, detail, now)
      this.emitAccountStop(task, platform, failure, detail)
      return 'fail'
    }

    // An obstruction is worth surfacing immediately: the task keeps "working" while every
    // send is rejected, which looks like nothing is wrong. A muted room is the case this
    // branch is for — the account is healthy and only that room is refusing.
    if (failure === 'action_stop') {
      this.emitOnce(task, platform, EventKind.ActionBlocked, EventSeverity.Warning, '动作受阻', detail)
    }

    updateTaskError(this.deps.db, task.id, code === '' ? detail : `${detail}（${code}）`, now)
    return 'continuing'
  }

  /**
   * Writes a status this sweep decided from its own snapshot, and refuses it when the row has moved.
   *
   * **`task` is a row read at the top of the sweep, and everything between that read and this write is
   * a walk over awaits.** `tick` takes the schedulable Tasks once and then hands each one to a Platform
   * for seconds at a time, so a person can pause a Task inside any of those calls. The pause is written
   * by `routes/tasks.ts`, which reads the row and writes the status in one synchronous block — inside a
   * single sweep the two cannot interleave, but a *sweep* and a *request* can, and the scheduler is the
   * loser whenever it writes a status it decided from the row as it was before.
   *
   * The cost of that loss is not symmetrical, which is why this exists rather than a re-read: `offline`
   * and `running` are both in `listSchedulableTasks`' own working set, so a Task written back into one
   * of them keeps being swept, probed and sent into — the pause stops happening, silently, while the
   * request that asked for it was answered 200. `done` is the other end of the same loss, and
   * `finishTask` states that half.
   *
   * Passing the snapshot's own status as the expected value is deliberately the strictest test
   * available rather than "whatever is still sweepable": the worst this can do is defer a write, and a
   * deferred write costs one sweep, because the next pass re-reads the row and decides again from what
   * it finds. It can never undo a legitimate transition, which is the direction that matters.
   *
   * A refusal is not swallowed. The log line below is the only trace a person's write and a sweep
   * crossing will leave, and the caller is told by the answer so it can stop short of whatever the
   * write was licensing — the send in `runSend`, the Platform run in `runReconcile`.
   */
  private writeStatusUnlessMoved(task: Task, status: TaskStatus, now: number): boolean {
    const landed = updateTaskStatus(this.deps.db, task.id, status, '', now, task.status)
    if (!landed) {
      this.log(`task ${String(task.id)}: status write to ${status} refused, the row is no longer ${task.status}`)
    }
    return landed
  }

  /**
   * The one place a task is marked failed.
   *
   * Defect ② in `HANDOFF.md` §7 was that `TaskStatus.Failed` was written in six
   * places without a single `task_failed` event, so a failed task was silent on
   * the feed. Routing every failure through here is what makes that impossible to
   * reintroduce by hand.
   *
   * **The one status write in this class with no expected value**, and that is a decision rather than
   * an omission. Everything else the sweep writes is its own opinion about a row it read earlier, so a
   * person's pause outranks it; this is not an opinion. It reports what a Platform has just answered
   * about this Task's account — an expired session, a restriction, an Action key this build cannot run —
   * and none of that stops being true because the row was paused a moment ago. Making it conditional
   * would leave such a Task sitting at `paused` and let 恢复 re-discover the same refusal, and it would
   * take the `task_failed` line off the feed with it, since the status and the event are one report of
   * one fact.
   */
  private failTask(task: Task, reason: string, now: number): void {
    updateTaskStatus(this.deps.db, task.id, TaskStatus.Failed, reason, now)
    this.emitOnce(task, platformFor(task.platform), EventKind.TaskFailed, EventSeverity.Error, '任务失败', reason, now)
  }

  /**
   * Marks a Task finished, and answers whether that landed.
   *
   * The write is conditional for the reason `writeStatusUnlessMoved` gives, and `done` is the status
   * where its cost is easiest to state: it is terminal and outside the sweep's set, so a person who
   * paused a Task to edit it would find the row out of their reach — the edit route takes paused rows
   * only, and 重置进度 clears the counters — with nothing on the screen to say what moved. A refused
   * write leaves the pause standing, and the next sweep that reads the row finishes the Task from what
   * it then finds.
   *
   * The `done` guard stays although `listSchedulableTasks` cannot hand this function a finished row
   * today: that query carries a standing warning that somebody will want to add `done` to it, and this
   * is the second line of defence for exactly that day.
   */
  private finishTask(task: Task, now: number): boolean {
    if (task.status === TaskStatus.Done) return false
    if (!this.writeStatusUnlessMoved(task, TaskStatus.Done, now)) return false
    appendEvent(
      this.deps.db,
      {
        userId: task.userId,
        kind: EventKind.TaskFinished,
        title: '任务已完成',
        detail: task.targetTitle !== '' ? task.targetTitle : `房间 ${task.targetKey}`,
        platform: task.platform,
        taskId: task.id,
        accountId: task.accountId
      },
      now
    )
    return true
  }

  /**
   * Emits an event unless the same kind was already recorded for **this task**
   * within the suppression window.
   *
   * Defect ① in `HANDOFF.md` §7 was that the key was user + kind with no task, so
   * with two Platforms a Bilibili `session_expired` silently swallowed a Douyu one
   * raised inside the same thirty minutes. A `null` task still means "user-wide",
   * which is what the account-refresh path wants — there is no task there.
   */
  private emitOnce(
    task: Task,
    platform: Platform | null,
    kind: EventKind,
    severity: EventSeverity,
    title: string,
    detail: string,
    now: number = Date.now()
  ): void {
    if (hasRecentEvent(this.deps.db, task.userId, kind, task.id, EVENT_SUPPRESS_MS, now)) return

    appendEvent(
      this.deps.db,
      {
        userId: task.userId,
        kind,
        severity,
        title,
        detail,
        platform: platform?.key ?? task.platform,
        taskId: task.id,
        accountId: task.accountId
      },
      now
    )
  }
}

type TaskOutcome = 'send' | 'reconcile' | 'monitor' | 'finish' | 'idle' | 'fail'

/**
 * What one run hands the adapter as its per-action options.
 *
 * The one key is the action this Task names, and the switchboard has it on — that row's `enabled =
 * 1` is what let the run happen — so `actionOptions` has an entry for it and the fallback below is
 * unreachable today. It is here anyway, because `ReconcileContext.options` states an invariant
 * ("every key in `enabledActions` has an entry, and every entry is an object") and the one place
 * that builds the context is the only place that can make it true by construction rather than by an
 * argument about the store. `actionOptions` has already turned anything that was not an object into
 * `{}`, so what is left for this to cover is absence.
 */
function runOptions(keys: readonly string[], stored: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  for (const key of keys) options[key] = stored[key] ?? {}
  return options
}

/**
 * The failure kinds that mean "nothing this account attempts will land until a person acts".
 *
 * `Extract` rather than two literals so the name cannot drift from `FailureKind`, and a
 * guard rather than a `===` at each of the three uses so that the branch which fails the
 * task is structurally unable to know one of the two and forget the other.
 */
type AccountStopKind = Extract<FailureKind, 'account_stop' | 'account_restricted'>

function isAccountStop(failure: FailureKind): failure is AccountStopKind {
  return failure === 'account_stop' || failure === 'account_restricted'
}
