import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BiliHttp, CookieJar } from '../src/bilibili/http.js'
import { ROOM_INFO_URL } from '../src/bilibili/live.js'
import { ACTIVATED_MEDAL_INFO_URL } from '../src/bilibili/medal.js'
import { LIVE_TRACE_ENTER_URL, LIVE_TRACE_HEARTBEAT_URL } from '../src/bilibili/watch-live.js'
import {
  ACCOUNT_STOP_DETAIL,
  beatMsOf,
  WATCH_LOOP_CEILING_MS,
  type WatchLoop,
  type WatchLoopSpec,
  WatchLoops
} from '../src/bilibili/watch-loop.js'

/**
 * The resident viewing loop, tested at its own seam: a stubbed transport (`fetch`, which `BiliHttp`
 * runs on for real), fake timers for the sleeps, and nothing that reaches Bilibili.
 *
 * What this file pins, in the order the loop's contract states it:
 *   - the sleep is the server's interval under the floor and the ceiling, and `time` is what was slept;
 *   - one loop per key, and one device identity per key for as long as the process runs;
 *   - a loop ends on a panel verdict (done, offline, unlit), a dead session, a bounded failure count,
 *     the lifetime ceiling, or a stop — and a stop never leaves a beat behind it;
 *   - a caller that starts a loop is not made to wait for it;
 *   - no credential reaches a reported detail or a log line.
 *
 * Fake timers drive the sleeps. Only `setTimeout` and `Date` are faked: `setImmediate` stays real, so
 * the microtask-and-stream settling of a stubbed `Response` is not held hostage to the clock.
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))

const KEY = '7/22908869'
const ROOM_ID = 22_908_869
const ANCHOR_ID = 2_071_691_173
const LIKER_UID = '987654'
const CSRF = 'jct-value-for-test'
const SESSDATA = 'sessdata-value-for-test'
const BUVID = 'LIVE-BUVID-FOR-TEST'
const ENTER_TIMESTAMP = 1_791_434_562
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/* ------------------------------------------------------------------ *
 * the transport stub
 * ------------------------------------------------------------------ */

interface Recorded {
  readonly url: string
  readonly body: string | null
}

/** `attempt` counts how many times this URL has been asked, from zero. */
type Route = (attempt: number) => unknown

let recorded: Recorded[] = []
let logs: string[] = []

/**
 * Answers `fetch` by URL prefix and records every request. An unrouted request throws, so a loop that
 * sends something the test did not expect fails loudly rather than being answered by a default.
 *
 * A route may return a promise that never settles; the fetch then waits on the request's own signal,
 * which is how an in-flight request is held and then aborted.
 */
function serve(routes: Readonly<Record<string, Route>>): void {
  const counts = new Map<string, number>()

  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    recorded.push({ url, body: typeof init?.body === 'string' ? init.body : null })

    const key = Object.keys(routes).find(candidate => url.startsWith(candidate))
    const route = key === undefined ? undefined : routes[key]
    if (key === undefined || route === undefined) throw new Error(`没有为这个请求准备响应：${url}`)

    const attempt = counts.get(key) ?? 0
    counts.set(key, attempt + 1)

    const reply = await settleOrAbort(route(attempt), init?.signal)
    if (reply instanceof Response) return reply
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

function settleOrAbort(work: unknown, signal: AbortSignal | null | undefined): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const abort = (): void => {
      reject(new DOMException('This operation was aborted', 'AbortError'))
    }
    if (signal?.aborted === true) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve(work).then(
      value => {
        signal?.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal?.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

function requestsTo(prefix: string): Recorded[] {
  return recorded.filter(request => request.url.startsWith(prefix))
}

function bodyOf(request: Recorded | undefined): URLSearchParams {
  if (request === undefined) throw new Error('没有这次请求')
  return new URLSearchParams(request.body ?? '')
}

/* ------------------------------------------------------------------ *
 * the replies
 * ------------------------------------------------------------------ */

function enterReply(heartbeatInterval: number, secret = 'secret-key-from-server'): unknown {
  return {
    code: 0,
    message: '0',
    data: {
      timestamp: ENTER_TIMESTAMP,
      heartbeat_interval: heartbeatInterval,
      secret_key: secret,
      secret_rule: [0, 2],
      patch_status: 0
    }
  }
}

function heartbeatReply(heartbeatInterval: number): unknown {
  return {
    code: 0,
    message: '0',
    data: {
      timestamp: ENTER_TIMESTAMP + 60,
      heartbeat_interval: heartbeatInterval,
      secret_key: 'secret-key-rotated',
      secret_rule: [0, 2],
      patch_status: 0
    }
  }
}

const WATCH_ROW_PENDING = {
  title: '观看直播满15分钟',
  sub_title: '每日上限 0/1',
  add_text: '亲密度+1',
  jump_type: 'watchLive',
  is_done: false
}
const WATCH_ROW_DONE = { ...WATCH_ROW_PENDING, sub_title: '每日上限 1/1', is_done: true }

function panelReply(row: unknown, isLighted = true): unknown {
  return { code: 0, message: '0', data: { intimacy: 1, is_lighted: isLighted, task_info: [row] } }
}

function roomReply(liveStatus: number): unknown {
  return {
    code: 0,
    message: '0',
    data: {
      room_id: ROOM_ID,
      short_id: 0,
      uid: ANCHOR_ID,
      live_status: liveStatus,
      live_time: 0,
      title: '测试直播间',
      parent_area_id: 1,
      area_id: 283
    }
  }
}

/** Every route healthy and the panel never done: the baseline each test changes one thing of. */
function healthy(overrides: Readonly<Record<string, Route>> = {}): Record<string, Route> {
  return {
    [LIVE_TRACE_ENTER_URL]: () => enterReply(60),
    [LIVE_TRACE_HEARTBEAT_URL]: () => heartbeatReply(60),
    [ACTIVATED_MEDAL_INFO_URL]: () => panelReply(WATCH_ROW_PENDING),
    [ROOM_INFO_URL]: () => roomReply(1),
    ...overrides
  }
}

/* ------------------------------------------------------------------ *
 * the scaffold
 * ------------------------------------------------------------------ */

function loggedInHttp(): BiliHttp {
  return new BiliHttp({ cookies: new CookieJar({ SESSDATA, bili_jct: CSRF, DedeUserID: LIKER_UID }) })
}

function specFor(http: BiliHttp): WatchLoopSpec {
  return {
    http,
    csrf: CSRF,
    roomId: ROOM_ID,
    anchorId: ANCHOR_ID,
    parentAreaId: 1,
    areaId: 283,
    buvid: BUVID,
    log: (line: string): void => {
      logs.push(line)
    }
  }
}

/** Lets the chained promises of a stubbed request run to their end. Real `setImmediate`, so it is not clock-bound. */
async function settle(): Promise<void> {
  for (let round = 0; round < 25; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** Moves the fake clock forward, and lets whatever that woke run to its next await. */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

let loops: WatchLoops

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  recorded = []
  logs = []
  loops = new WatchLoops()
  vi.stubGlobal('fetch', fetchMock)
  serve(healthy())
})

afterEach(async () => {
  await loops.stopAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/** Starts the loop for `KEY` and lets its first enter answer. */
async function startLoop(overrides: Partial<WatchLoopSpec> = {}): Promise<WatchLoop> {
  const loop = loops.start(KEY, { ...specFor(loggedInHttp()), ...overrides })
  await settle()
  return loop
}

/* ------------------------------------------------------------------ *
 * the sleep
 * ------------------------------------------------------------------ */

describe('beatMsOf：睡多久只由这一个函数决定', () => {
  it('服务端的间隔照原样睡，在本地下限与上限之内', () => {
    expect(beatMsOf({ heartbeatInterval: 60 })).toBe(60_000)
    expect(beatMsOf({ heartbeatInterval: 299.5 })).toBe(299_500)
    expect(beatMsOf({ heartbeatInterval: 300 })).toBe(300_000)
    // 上限那一半只在直接调用上看得到：`sessionOf` 已经把超过 300 秒的间隔挡在会话之外，所以没有哪条
    // 生产路径能把 400 送进来 —— 但「本地下限与上限」这句话里上限那一半仍然要有一个读法。
    expect(beatMsOf({ heartbeatInterval: 400 })).toBe(300_000)
  })

  it('低于下限的间隔按下限睡，而不是按服务端的数字', () => {
    expect(beatMsOf({ heartbeatInterval: 0.001 })).toBe(1_000)
    expect(beatMsOf({ heartbeatInterval: 0.5 })).toBe(1_000)
  })
})

describe('进场与心跳', () => {
  it('同一个 key 只有一个循环：第二次 start 拿回的是那一个，进场也只发生一次', async () => {
    const http = loggedInHttp()
    const first = loops.start(KEY, specFor(http))
    const second = loops.start(KEY, specFor(http))
    await settle()

    expect(second).toBe(first)
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toHaveLength(1)
  })

  it('进场与每一拍用的是同一个设备 uuid 与同一个 buvid', async () => {
    await startLoop()
    await tick(60_000)
    await tick(60_000)

    const enter = bodyOf(requestsTo(LIVE_TRACE_ENTER_URL)[0])
    const beats = requestsTo(LIVE_TRACE_HEARTBEAT_URL).map(request => bodyOf(request))
    expect(beats).toHaveLength(2)

    const [buvid, uuid] = JSON.parse(enter.get('device') ?? '[]') as unknown[]
    expect(buvid).toBe(BUVID)
    expect(String(uuid)).toMatch(UUID_SHAPE)
    for (const beat of beats) {
      expect(beat.get('device')).toBe(JSON.stringify([BUVID, uuid]))
    }
  })

  it('睡的是服务端下发的间隔：59.999 秒时还没拍，满 60 秒才拍，time 写的就是这 60 秒', async () => {
    await startLoop()

    await tick(59_999)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(0)

    await tick(1)
    const beat = bodyOf(requestsTo(LIVE_TRACE_HEARTBEAT_URL)[0])
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(1)
    expect(beat.get('time')).toBe('60')
    expect(beat.get('ets')).toBe(String(ENTER_TIMESTAMP))
  })

  it('间隔 0.001 秒时按 1 秒睡，并且 time 写 1 而不是服务端的数字', async () => {
    serve(
      healthy({
        [LIVE_TRACE_ENTER_URL]: () => enterReply(0.001),
        [LIVE_TRACE_HEARTBEAT_URL]: () => heartbeatReply(0.001)
      })
    )
    await startLoop()

    await tick(999)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(0)

    await tick(1)
    expect(bodyOf(requestsTo(LIVE_TRACE_HEARTBEAT_URL)[0]).get('time')).toBe('1')
  })

  it('间隔 300 秒时整段睡完，不被本地切短', async () => {
    serve(
      healthy({
        [LIVE_TRACE_ENTER_URL]: () => enterReply(300),
        [LIVE_TRACE_HEARTBEAT_URL]: () => heartbeatReply(300)
      })
    )
    await startLoop()

    await tick(299_999)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(0)
    await tick(1)
    expect(bodyOf(requestsTo(LIVE_TRACE_HEARTBEAT_URL)[0]).get('time')).toBe('300')
  })
})

describe('终止条件', () => {
  it('面板回读判定完成就停，停在那一拍之后，不再发心跳', async () => {
    serve(
      healthy({
        // The first panel read is the third beat's (every third accepted beat reads the panel).
        [ACTIVATED_MEDAL_INFO_URL]: () => panelReply(WATCH_ROW_DONE)
      })
    )
    const loop = await startLoop()

    await tick(180_000)
    expect(await loop.finished).toEqual({ kind: 'done', beats: 3 })
    expect(loop.running).toBe(false)

    await tick(600_000)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(3)
  })

  it('回读时直播间已不在开播，就停，并且不再发心跳', async () => {
    serve(healthy({ [ROOM_INFO_URL]: () => roomReply(0) }))
    const loop = await startLoop()

    await tick(180_000)
    expect(await loop.finished).toEqual({ kind: 'room_offline', beats: 3 })

    await tick(600_000)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(3)
  })

  it('回读时粉丝牌已熄灭，就停：熄灭的牌子不计亲密度，再发心跳没有意义', async () => {
    serve(healthy({ [ACTIVATED_MEDAL_INFO_URL]: () => panelReply(WATCH_ROW_PENDING, false) }))
    const loop = await startLoop()

    await tick(180_000)
    expect(await loop.finished).toEqual({ kind: 'medal_unlit', beats: 3 })
  })

  it('进场被拒 -101 就停成 account_stop：不重进场，也不发心跳', async () => {
    serve(healthy({ [LIVE_TRACE_ENTER_URL]: () => ({ code: -101, message: '账号未登录' }) }))
    const loop = await startLoop()

    expect(await loop.finished).toEqual({
      kind: 'account_stop',
      beats: 0,
      code: '-101',
      detail: ACCOUNT_STOP_DETAIL
    })

    await tick(600_000)
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toHaveLength(1)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(0)
  })

  it('心跳被拒 -101 同样停成 account_stop，不重进场', async () => {
    serve(healthy({ [LIVE_TRACE_HEARTBEAT_URL]: () => ({ code: -101, message: '账号未登录' }) }))
    const loop = await startLoop()

    await tick(60_000)
    expect(await loop.finished).toMatchObject({ kind: 'account_stop', beats: 0, code: '-101' })

    await tick(600_000)
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toHaveLength(1)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(1)
  })

  it('面板到头仍没完成：生命周期上限到了就停成 ceiling，而且停之前最后再读一次面板', async () => {
    const loop = await startLoop()

    await tick(WATCH_LOOP_CEILING_MS)

    // 25 beats of 60 s is exactly the ceiling: the 26th would overrun it, so the loop reads once more and stops.
    expect(await loop.finished).toEqual({ kind: 'ceiling', beats: 25 })
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(25)
    // Every third accepted beat (eight reads), then the read at the ceiling.
    expect(requestsTo(ACTIVATED_MEDAL_INFO_URL)).toHaveLength(9)

    await tick(600_000)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(25)
  })

  it('上限数的是睡过的时间，不是墙上的时钟：时钟被外力推走也不提前结束', async () => {
    // `WATCH_LOOP_CEILING_MS` 把这件事写成了决定（slept time, not wall-clock time），而两者在替身时钟下
    // 恰好同步 —— 每一次等待都是 `pause`，所以只有把时钟单独推走才分得开。进程被挂起、机器睡了一觉，都会
    // 让墙上的时钟跑到睡眠前面，而那正是这条注释要挡住的读取方式。
    const loop = await startLoop()
    await tick(60_000)
    expect(loop.beats).toBe(1)

    vi.setSystemTime(Date.now() + WATCH_LOOP_CEILING_MS)
    await tick(60_000)

    expect(loop.running).toBe(true)
    expect(loop.beats).toBe(2)
  })

  it('一次面板读失败不会单独把循环停掉，下一拍成功就清零', async () => {
    serve(
      healthy({
        [ACTIVATED_MEDAL_INFO_URL]: attempt =>
          attempt === 0 ? new Response('gateway boom', { status: 502 }) : panelReply(WATCH_ROW_PENDING)
      })
    )
    const loop = await startLoop()

    await tick(360_000)

    expect(loop.running).toBe(true)
    expect(loop.beats).toBe(6)
  })
})

describe('失败与重进场：有界', () => {
  it('心跳被拒就用同一个设备重进场，连续三次被拒后放弃，并说出码', async () => {
    serve(healthy({ [LIVE_TRACE_HEARTBEAT_URL]: () => ({ code: -352, message: 'risk control' }) }))
    const loop = await startLoop()

    // Enter, beat (refused), wait 30 s, enter, beat (refused), wait 30 s, enter, beat (refused): give up.
    await tick(240_000)
    const end = await loop.finished
    expect(end).toMatchObject({ kind: 'gave_up', beats: 0, code: '-352' })
    expect(end.kind === 'gave_up' ? end.detail : '').toContain('code -352')

    const enters = requestsTo(LIVE_TRACE_ENTER_URL)
    expect(enters).toHaveLength(3)
    expect(new Set(enters.map(request => bodyOf(request).get('device'))).size).toBe(1)

    // Bounded: a loop that has given up does not come back on its own.
    await tick(600_000)
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toHaveLength(3)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(3)
  })

  it('传输层失败（502）按同一个上限计数，放弃时码是 http_502', async () => {
    serve(healthy({ [LIVE_TRACE_HEARTBEAT_URL]: () => new Response('bad gateway', { status: 502 }) }))
    const loop = await startLoop()

    await tick(240_000)
    expect(await loop.finished).toMatchObject({ kind: 'gave_up', code: 'http_502' })
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(3)
  })

  it('进场被拒也有界：三次进场都被拒就放弃，不无限重试', async () => {
    serve(healthy({ [LIVE_TRACE_ENTER_URL]: () => ({ code: -352, message: 'risk control' }) }))
    const loop = await startLoop()

    await tick(60_000)
    expect(await loop.finished).toMatchObject({ kind: 'gave_up', beats: 0, code: '-352' })
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toHaveLength(3)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(0)
  })

  it('中途恢复过的心跳会清零计数，所以偶发的拒绝不会累计成放弃', async () => {
    serve(
      healthy({
        [LIVE_TRACE_HEARTBEAT_URL]: attempt =>
          attempt === 0 || attempt === 2 ? { code: -352, message: 'risk control' } : heartbeatReply(60)
      })
    )
    const loop = await startLoop()

    await tick(360_000)
    expect(loop.running).toBe(true)
    expect(loop.beats).toBeGreaterThanOrEqual(3)
  })

  it('同一个 key 重新开一个循环时，设备 uuid 沿用上一个，不因为重开而换设备', async () => {
    const first = await startLoop()
    await tick(60_000)
    loops.discard(KEY)
    await first.finished

    loops.start(KEY, specFor(loggedInHttp()))
    await settle()

    const devices = requestsTo(LIVE_TRACE_ENTER_URL).map(request => bodyOf(request).get('device'))
    expect(devices).toHaveLength(2)
    expect(devices[1]).toBe(devices[0])
  })
})

describe('不发两拍，也不让调用方等', () => {
  it('在途的心跳没回来时不会有第二拍', async () => {
    serve(healthy({ [LIVE_TRACE_HEARTBEAT_URL]: () => new Promise(() => {}) }))
    await startLoop()

    await tick(60_000)
    await tick(600_000)

    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(1)
  })

  it('start 不等进场：进场一直不回也照样立刻返回一个在跑的循环', () => {
    serve(healthy({ [LIVE_TRACE_ENTER_URL]: () => new Promise(() => {}) }))

    const loop = loops.start(KEY, specFor(loggedInHttp()))

    expect(loop.running).toBe(true)
    expect(loop.beats).toBe(0)
  })
})

describe('停止：中止之后不留下任何一拍', () => {
  it('discard 中止在途的心跳，循环以 stopped 结束，之后不再有请求', async () => {
    serve(healthy({ [LIVE_TRACE_HEARTBEAT_URL]: () => new Promise(() => {}) }))
    const loop = await startLoop()
    await tick(60_000)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(1)

    loops.discard(KEY)

    expect(await loop.finished).toEqual({ kind: 'stopped', beats: 0 })
    await tick(600_000)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(1)
  })

  it('stopAll 等所有循环结束才返回，之后时钟走多久都没有心跳', async () => {
    const loop = await startLoop()
    await tick(60_000)
    expect(loop.beats).toBe(1)

    await loops.stopAll()

    expect(await loop.finished).toEqual({ kind: 'stopped', beats: 1 })
    // 中止一次睡眠必须把它的计时器也收掉（`pause` 里的 `clearTimeout`）：留下的那一个没人等它，
    // 而它还会醒过来。这一条是那半句话唯一的读法 —— 请求数看不出一个多余的计时器。
    expect(vi.getTimerCount()).toBe(0)
    await tick(600_000)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(1)
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toHaveLength(1)
  })
})

describe('凭据不进上报，也不进日志', () => {
  it('被拒的心跳把会话密钥、buvid、uuid 与 csrf 原样回显时，放弃的理由和日志里都没有它们', async () => {
    serve(
      healthy({
        [LIVE_TRACE_HEARTBEAT_URL]: () => ({
          code: -352,
          message: `risk: benchmark=secret-key-from-server device=["${BUVID}"] csrf=${CSRF}`
        })
      })
    )
    const loop = await startLoop()

    await tick(240_000)
    const end = await loop.finished
    const uuid = JSON.parse(bodyOf(requestsTo(LIVE_TRACE_ENTER_URL)[0]).get('device') ?? '[]')[1] as string

    const reported = JSON.stringify(end) + logs.join('\n')
    expect(reported).not.toContain('secret-key-from-server')
    expect(reported).not.toContain(BUVID)
    expect(reported).not.toContain(CSRF)
    expect(reported).not.toContain(uuid)
    expect(reported).toContain('<redacted>')
  })
})
