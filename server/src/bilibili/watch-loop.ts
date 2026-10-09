import { type BiliHttp, BiliHttpError } from './http.js'
import { fetchRoomInfo, isLive, RoomRefusedError } from './live.js'
import { fetchMedalTasks, isTaskDone, MedalJumpType } from './medal.js'
import { SendDanmakuCode } from './types.js'
import {
  type EnterLiveRoomOptions,
  enterLiveRoom,
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  sendLiveHeartbeat,
  type WatchResult,
  type WatchSession
} from './watch-live.js'

/**
 * 观看直播的常驻循环：每个（账号，直播间）一个，跑在调度 sweep 之外。
 *
 * ## 为什么是常驻的
 *
 * 旧做法每个 sweep 开一个新会话、睡一拍、回读、丢掉。那样每次都换一个设备标识，覆盖的时间只有几分之一。
 * 常驻循环进场一次，之后按服务端下发的间隔一拍一拍地走，直到面板说完成。
 *
 * 为什么这样可能更接近服务端想要的样子，有三种互相不排斥的解释，实测一个都没有证明：
 *   - 服务端按拍计分：拍与拍之间断开，就漏掉那几拍；
 *   - 服务端要求连续在场：会话内的拍才算数，拍与拍之间重开会话就断了连续性；
 *   - 服务端惩罚设备变化：同一个 uuid 与 buvid 在一个循环的整个生命里不变，重进场也沿用同一组。
 * 循环的形状对这三种解释都说得通；它不声称其中哪一种为真。
 *
 * ## 生命周期
 *
 * 进场一次，然后循环：睡 `beatMsOf` 算出的时长，发一拍；每 `WATCH_PANEL_READ_EVERY_BEATS` 拍回读一次面板与直播间。
 * 循环停在下面这些结局之一（`WatchEnd`）：
 *   - `done`：面板的 `isTaskDone` 为真。**这是唯一的完成判据**，循环不在本地累加秒数；
 *   - `room_offline`：回读时直播间不在开播（由 `isLive` 判定）；
 *   - `medal_unlit`：回读时粉丝牌已熄灭，熄灭的牌子不计亲密度；
 *   - `account_stop`：-101，登录态已失效，重进场没有用；
 *   - `gave_up`：连续 `WATCH_MAX_CONSECUTIVE_FAILURES` 次进场或心跳失败（拒绝或传输），理由照实交出去；
 *     回读失败到不了这个数（`WATCH_MAX_CONSECUTIVE_FAILURES` 的注释说明了为什么），它由下面的上限收尾；
 *   - `ceiling`：睡过的时长到了 `WATCH_LOOP_CEILING_MS` 仍没完成，停之前最后再读一次面板；
 *   - `stopped`：被 `WatchLoops.discard` 或 `WatchLoops.stopAll` 中止。
 *
 * ## 重进场：有界
 *
 * 进场或心跳被拒（或传输失败），都先等 `WATCH_REENTER_WAIT_MS`，再用**同一个设备**重进场。
 * 连续失败达到 `WATCH_MAX_CONSECUTIVE_FAILURES` 就放弃，不在一个循环里无限重试。成功的一拍会把计数清零。
 *
 * ## 时间的诚实
 *
 * 心跳的 `time` 是循环真正睡过的秒数，它与睡眠用的是同一个数，都来自 `beatMsOf`。睡眠的时长只由 `beatMsOf` 决定，
 * 被本项目的下限（`WATCH_MIN_HEARTBEAT_MS`）与上限（`MAX_HEARTBEAT_INTERVAL_SECONDS`）约束。
 *
 * ## 停止与关停
 *
 * 每个循环持有一个 `AbortController`。睡眠、进场、心跳的在途请求都收它的 signal；中止之后不再发起任何请求。
 * 面板与直播间的回读不接收 signal（`fetchMedalTasks` / `fetchRoomInfo` 没有这个参数），它们由 `BiliHttp` 自己的超时兜底，
 * 所以 `stopAll` 最多多等一次回读。
 *
 * ## 凭据
 *
 * csrf、buvid、uuid 与会话密钥都不进任何上报或日志：每一段文本都经 `BiliHttp.redact` 抠过。
 */

/**
 * How long one loop may live, counted in the seconds it has spent sleeping between its beats.
 *
 * 25 minutes is the reference implementation's session length (BLTH holds one session for
 * `duration < 25 * 60`). The task needs 15 minutes of watching, so a loop the server is crediting ends long
 * before this; the ceiling bounds the case where the panel never flips. Its cost is named where it lands: a
 * server that never credits this chain sees one fresh enter per ceiling plus up to one sweep interval, which
 * is about one new session every 25 to 30 minutes, not one every five.
 *
 * Counted in slept time rather than wall-clock time on purpose: the sleeps are the only waiting this loop
 * does, the latency of a request is not the loop's to bound, and slept time is the quantity a fake clock can
 * drive.
 */
export const WATCH_LOOP_CEILING_MS = 25 * 60 * 1000

/**
 * A panel read, and a liveness read with it, every this many accepted beats.
 *
 * At the server's usual 60 s interval that is every three minutes. A completion is noticed within three
 * minutes of landing, and the panel is not read on every beat (which would double the request count for a
 * verdict that cannot change faster than the server credits it).
 */
export const WATCH_PANEL_READ_EVERY_BEATS = 3

/**
 * Consecutive failed enters and beats a loop tolerates before it gives up: refused, or failed at the transport.
 * A successful beat clears the count.
 *
 * **A panel read or a liveness read that fails is counted the same way and can never reach this bound**, which is
 * the half worth writing down rather than leaving for a reader to rediscover from the loop's shape. `judge` runs
 * immediately after an *accepted* beat, and accepting that beat is what cleared the count, so a read that fails
 * adds at most one before the next accepted beat clears it again. A loop whose beats land but whose verdict cannot
 * be read therefore keeps beating until `WATCH_LOOP_CEILING_MS` ends it. That is the intended trade rather than an
 * oversight: the read is a *verdict*, not a beat, and ending a chain the server is still crediting because the
 * verdict could not be read would throw away the beats that were landing. The failed read is still logged with its
 * reason, and the ceiling is what names that ending.
 *
 * Three, because a refusal that repeats is the server saying no, and every attempt costs a session.
 */
export const WATCH_MAX_CONSECUTIVE_FAILURES = 3

/** How long a loop waits before it enters again after a failure. Counted in the ceiling like every other sleep. */
export const WATCH_REENTER_WAIT_MS = 30_000

/**
 * The floor under one beat's sleep, in milliseconds.
 *
 * The slept time is also what the loop counts toward its ceiling, so a server that named a sub-second interval
 * would otherwise buy a loop tens of thousands of beats inside it. Every interval measured here is about 60 s,
 * and one beat per second is a floor rather than a conversion. `like.ts` gives its own server-owned cadence the
 * same shape (`MinIntervalFloorMs`), for the same reason.
 */
export const WATCH_MIN_HEARTBEAT_MS = 1_000

/** The sentence a dead session reads as, here and in the adapter: one string, so the two cannot drift. */
export const ACCOUNT_STOP_DETAIL = 'B 站登录态已失效，需要重新扫码绑定账号。'

/**
 * How long one beat's sleep is, in milliseconds: the server's interval, under the local floor and over the house
 * ceiling. This is the one place that decides the sleep. The `time` a beat reports is read from the same number,
 * so the wait it made and the wait it claims are the same wait.
 */
export function beatMsOf(session: Pick<WatchSession, 'heartbeatInterval'>): number {
  const intervalMs = session.heartbeatInterval * 1000
  return Math.min(Math.max(intervalMs, WATCH_MIN_HEARTBEAT_MS), MAX_HEARTBEAT_INTERVAL_SECONDS * 1000)
}

/** How a loop ended. Every variant carries the accepted beat count, because that is what the sweep reports. */
export type WatchEnd =
  | { readonly kind: 'done'; readonly beats: number }
  | { readonly kind: 'room_offline'; readonly beats: number }
  | { readonly kind: 'medal_unlit'; readonly beats: number }
  | { readonly kind: 'account_stop'; readonly beats: number; readonly code: string; readonly detail: string }
  | { readonly kind: 'gave_up'; readonly beats: number; readonly code: string; readonly detail: string }
  | { readonly kind: 'ceiling'; readonly beats: number }
  | { readonly kind: 'stopped'; readonly beats: number }

/**
 * What a loop needs to watch one room. The device uuid is not here: the registry owns it, per key, so that a loop
 * which ends and starts again re-enters as the same device.
 */
export interface WatchLoopSpec {
  /** The account's client. Its cookie jar is the session; the loop uses it for its whole life. */
  readonly http: BiliHttp
  /** `bili_jct`, the value the panel read echoes. The caller has checked it is present. */
  readonly csrf: string
  /** The real room id. */
  readonly roomId: number
  /** The Anchor's uid: the panel's `target_id` and the enter's `ruid`. */
  readonly anchorId: number
  readonly parentAreaId: number
  readonly areaId: number
  /** The live domain's device cookie, which the handshake signs with. */
  readonly buvid: string
  readonly log: (line: string) => void
}

/** One failed attempt, graded: `accountStop` means re-entering cannot help. */
interface Failure {
  readonly code: string
  readonly detail: string
  readonly accountStop: boolean
}

type Attempt<T> = { readonly ok: true; readonly value: T } | ({ readonly ok: false } & Failure)

/** What one panel-and-room read says about the loop's life. */
type Verdict =
  | { readonly kind: 'pending' }
  | { readonly kind: 'done' }
  | { readonly kind: 'room_offline' }
  | { readonly kind: 'medal_unlit' }
  | { readonly kind: 'account_stop' }
  | { readonly kind: 'unreadable'; readonly code: string; readonly detail: string }

/**
 * One resident viewing loop. It starts when constructed and runs until it ends; `finished` settles with how.
 *
 * Built by `WatchLoops.start`, which is the only caller that should build one: the registry is what keeps one
 * loop per key and one device per key.
 */
export class WatchLoop {
  private readonly controller = new AbortController()
  private accepted = 0
  private failures = 0
  private sleptMs = 0
  private secretKey = ''
  private endState: WatchEnd | undefined = undefined

  /** Settles with how the loop ended. It never rejects: a failure is an ending, reported, not thrown. */
  readonly finished: Promise<WatchEnd>

  constructor(
    private readonly spec: WatchLoopSpec,
    private readonly uuid: string
  ) {
    this.finished = this.run()
  }

  /** Beats the server has accepted so far. A beat that was sent and refused is not counted. */
  get beats(): number {
    return this.accepted
  }

  /** True until the loop has ended or has been asked to stop. */
  get running(): boolean {
    return this.endState === undefined && !this.controller.signal.aborted
  }

  /** How the loop ended, or `undefined` while it has not. */
  get end(): WatchEnd | undefined {
    return this.endState
  }

  /** Stops the loop: an in-flight request is aborted, a sleep ends, and nothing is sent afterwards. */
  stop(): void {
    this.controller.abort()
  }

  private async run(): Promise<WatchEnd> {
    let end: WatchEnd
    try {
      end = await this.live()
    } catch (error: unknown) {
      // Every request below reports its own failure, so reaching here is a bug in this file. It still has to end
      // the loop as a reported state rather than as an unhandled rejection.
      end = this.stopping()
        ? this.stopped()
        : {
            kind: 'gave_up',
            beats: this.accepted,
            code: 'internal',
            detail: `观看循环内部出错：${this.redactedText(errorText(error))}`
          }
    }
    this.endState = end
    this.spec.log(`观看循环结束（${end.kind}），已有 ${String(end.beats)} 拍心跳被服务端接受`)
    return end
  }

  private async live(): Promise<WatchEnd> {
    let session: WatchSession | null = null

    for (;;) {
      if (session === null) {
        const entered = await this.attempt('进场', () =>
          enterLiveRoom(this.spec.http, this.enterOptions(), Date.now(), this.controller.signal)
        )
        if (this.stopping()) return this.stopped()
        if (!entered.ok) {
          const ended = this.refused(entered)
          if (ended !== undefined) return ended
          if (!(await this.pause(WATCH_REENTER_WAIT_MS))) return this.stopped()
          continue
        }
        session = entered.value
        this.spec.log(
          `观看循环：会话已建立，服务端下发的心跳间隔 ${String(session.heartbeatInterval)} 秒，每拍睡 ${String(beatMsOf(session) / 1000)} 秒`
        )
      }

      const current: WatchSession = session
      const beatMs = beatMsOf(current)
      // The ceiling is checked before the sleep, so the loop never sleeps past it. The verdict is read one last
      // time here: a completion that landed between the last read and the ceiling is still reported as done.
      if (this.sleptMs + beatMs > WATCH_LOOP_CEILING_MS) {
        const verdict = await this.judge()
        if (this.stopping()) return this.stopped()
        return this.endOf(verdict) ?? { kind: 'ceiling', beats: this.accepted }
      }

      if (!(await this.pause(beatMs))) return this.stopped()

      const beat = await this.attempt('心跳', () =>
        sendLiveHeartbeat(this.spec.http, current, Date.now(), beatMs / 1000, this.controller.signal)
      )
      if (this.stopping()) return this.stopped()
      if (!beat.ok) {
        const ended = this.refused(beat)
        if (ended !== undefined) return ended
        session = null
        if (!(await this.pause(WATCH_REENTER_WAIT_MS))) return this.stopped()
        continue
      }

      session = beat.value
      this.accepted += 1
      this.failures = 0

      if (this.accepted % WATCH_PANEL_READ_EVERY_BEATS !== 0) continue

      const verdict = await this.judge()
      if (this.stopping()) return this.stopped()
      const ended = this.endOf(verdict)
      if (ended !== undefined) return ended
      if (verdict.kind === 'unreadable') {
        const gaveUp = this.failed(verdict.code, verdict.detail)
        if (gaveUp !== undefined) return gaveUp
      } else {
        this.spec.log(`观看循环：第 ${String(this.accepted)} 拍后回读，面板还没显示完成`)
      }
    }
  }

  /**
   * One panel read and, when the panel is not done, one liveness read. The panel is judged first: its `isTaskDone`
   * is the verdict, and a finished task needs no liveness read at all.
   */
  private async judge(): Promise<Verdict> {
    const { http, csrf, anchorId, roomId } = this.spec

    const panel = await this.call('读取粉丝牌任务', () => fetchMedalTasks(http, csrf, anchorId))
    if (!panel.ok) return { kind: 'unreadable', code: panel.code, detail: panel.detail }
    const medal = panel.value
    if (!medal.ok) {
      if (medal.code === SendDanmakuCode.NotLoggedIn) return { kind: 'account_stop' }
      return {
        kind: 'unreadable',
        code: String(medal.code),
        detail: `读取粉丝牌任务被拒绝（code ${String(medal.code)}）：${this.redactedText(medal.error)}`
      }
    }
    if (isTaskDone(medal.data.task_info, MedalJumpType.WatchLive)) return { kind: 'done' }
    if (!medal.data.is_lighted) return { kind: 'medal_unlit' }

    const room = await this.call('读取直播间信息', () => fetchRoomInfo(http, roomId))
    if (!room.ok) return { kind: 'unreadable', code: room.code, detail: room.detail }
    if (!isLive(room.value.live_status)) return { kind: 'room_offline' }
    return { kind: 'pending' }
  }

  /** A verdict that ends the loop, or `undefined` when the loop should go on. */
  private endOf(verdict: Verdict): WatchEnd | undefined {
    switch (verdict.kind) {
      case 'done':
        return { kind: 'done', beats: this.accepted }
      case 'room_offline':
        return { kind: 'room_offline', beats: this.accepted }
      case 'medal_unlit':
        return { kind: 'medal_unlit', beats: this.accepted }
      case 'account_stop':
        return {
          kind: 'account_stop',
          beats: this.accepted,
          code: String(SendDanmakuCode.NotLoggedIn),
          detail: ACCOUNT_STOP_DETAIL
        }
      case 'pending':
      case 'unreadable':
        return undefined
    }
  }

  /** A failure that ends the loop as account-level, or one more step toward giving up. */
  private refused(attempt: Failure): WatchEnd | undefined {
    if (attempt.accountStop) {
      return {
        kind: 'account_stop',
        beats: this.accepted,
        code: attempt.code,
        detail: ACCOUNT_STOP_DETAIL
      }
    }
    return this.failed(attempt.code, attempt.detail)
  }

  /** Counts one failed request. The count is the bound: it reaching the limit is what gives the loop up. */
  private failed(code: string, detail: string): WatchEnd | undefined {
    this.failures += 1
    this.spec.log(`观看循环：${detail}（连续第 ${String(this.failures)} 次）`)
    if (this.failures < WATCH_MAX_CONSECUTIVE_FAILURES) return undefined
    return { kind: 'gave_up', beats: this.accepted, code, detail }
  }

  /**
   * A session-building or beat call, graded. A business refusal is data (its code decides whether it is an account
   * stop); a throw is a transport failure or a contract change, and its message is kept for the reader.
   */
  private async attempt(what: string, work: () => Promise<WatchResult>): Promise<Attempt<WatchSession>> {
    const result = await this.call(what, work)
    if (!result.ok) return result
    const outcome = result.value
    if (outcome.ok) {
      this.secretKey = outcome.session.secretKey
      return { ok: true, value: outcome.session }
    }
    return {
      ok: false,
      code: String(outcome.code),
      detail: `${what}被拒绝（code ${String(outcome.code)}）：${this.redactedText(outcome.error)}`,
      accountStop: outcome.code === SendDanmakuCode.NotLoggedIn
    }
  }

  /** One request, with a throw folded into a reportable failure. Nothing here rethrows. */
  private async call<T>(what: string, work: () => Promise<T>): Promise<Attempt<T>> {
    try {
      return { ok: true, value: await work() }
    } catch (error: unknown) {
      return {
        ok: false,
        code: codeOf(error),
        detail: `${what}失败：${this.redactedText(errorText(error))}`,
        accountStop: false
      }
    }
  }

  /**
   * Sleeps for `ms`, counted against the ceiling. Resolves `false` when the loop was stopped during the sleep, and
   * clears its timer then: a sleep that was aborted must not leave a timer behind that wakes a loop nobody waits on.
   */
  private pause(ms: number): Promise<boolean> {
    this.sleptMs += ms
    const signal = this.controller.signal
    if (signal.aborted) return Promise.resolve(false)
    return new Promise<boolean>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve(false)
      }
      timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(true)
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private stopping(): boolean {
    return this.controller.signal.aborted
  }

  private stopped(): WatchEnd {
    return { kind: 'stopped', beats: this.accepted }
  }

  private enterOptions(): EnterLiveRoomOptions {
    const { roomId, anchorId, parentAreaId, areaId, buvid } = this.spec
    return { roomId, ruid: anchorId, parentAreaId, areaId, buvid, uuid: this.uuid }
  }

  /** A text this loop is about to report, with every credential it holds taken out. */
  private redactedText(text: string): string {
    return this.spec.http.redact(text, [this.spec.csrf, this.spec.buvid, this.uuid, this.secretKey])
  }
}

/**
 * The loops this process runs, one per key, and the device each key runs as.
 *
 * `key` is whatever stable string the caller builds from (account, room); this class needs nothing from it but
 * stability. Starting a key whose loop is running returns that loop, so a second start cannot make a second loop,
 * and two beats cannot be in flight for one key.
 *
 * The device uuid is remembered per key until `stopAll`. A loop that ends and starts again (at its ceiling, after a
 * give-up, or after the sweep restarts it) re-enters as the same device. Only a process restart mints a new one.
 *
 * **Known gap.** Nothing here hears that a task was paused, deleted, or had its action switched off. The sweep ends
 * a loop early by calling `discard`, and a paused task has no sweep to do that. Such a loop keeps beating until the
 * ceiling ends it, which is at most `WATCH_LOOP_CEILING_MS` after it started, and no sweep restarts it.
 */
export class WatchLoops {
  private readonly loops = new Map<string, WatchLoop>()
  private readonly devices = new Map<string, string>()

  /** The running loop for `key`, starting one when there is none. Never waits for it. */
  start(key: string, spec: WatchLoopSpec): WatchLoop {
    const current = this.loops.get(key)
    if (current?.running) return current

    let uuid = this.devices.get(key)
    if (uuid === undefined) {
      uuid = globalThis.crypto.randomUUID()
      this.devices.set(key, uuid)
    }
    const loop = new WatchLoop(spec, uuid)
    this.loops.set(key, loop)
    return loop
  }

  /** The loop for `key` if it is running. */
  running(key: string): WatchLoop | undefined {
    const loop = this.loops.get(key)
    return loop?.running ? loop : undefined
  }

  /**
   * How the last loop for `key` ended, and forgetting that loop, so the ending is reported once. `undefined` while a
   * loop is running, and when there was none.
   */
  retire(key: string): WatchEnd | undefined {
    const loop = this.loops.get(key)
    if (loop === undefined || loop.running) return undefined
    this.loops.delete(key)
    return loop.end
  }

  /** Stops the loop for `key` and forgets it. Nothing waits for it: a stop is a request, and the loop ends on its own. */
  discard(key: string): void {
    const loop = this.loops.get(key)
    if (loop === undefined) return
    this.loops.delete(key)
    loop.stop()
  }

  /** Stops every loop and forgets every device, then waits until each loop has ended. */
  async stopAll(): Promise<void> {
    const all = [...this.loops.values()]
    this.loops.clear()
    this.devices.clear()
    for (const loop of all) loop.stop()
    await Promise.all(all.map(loop => loop.finished))
  }
}

/** The code a thrown request is reported under. Bilibili's refusals arrive as data and never reach here. */
function codeOf(error: unknown): string {
  if (error instanceof RoomRefusedError) return String(error.code)
  if (error instanceof BiliHttpError && error.status > 0) return `http_${String(error.status)}`
  return 'transport'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
