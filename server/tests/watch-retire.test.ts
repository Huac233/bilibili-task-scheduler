import { afterEach, beforeEach, describe, expect, vi } from 'vitest'

import { ROOM_INFO_URL } from '../src/bilibili/live.js'
import { ACTIVATED_MEDAL_INFO_URL } from '../src/bilibili/medal.js'
import { LIVE_TRACE_ENTER_URL, LIVE_TRACE_HEARTBEAT_URL } from '../src/bilibili/watch-live.js'
import type { Db } from '../src/db/index.js'
import { bilibiliPlatform, stopWatchLoops } from '../src/platform/bilibili/index.js'
import { registerPlatform } from '../src/platform/registry.js'
import { upsertAccount } from '../src/repo/accounts.js'
import { setActionEnabled } from '../src/repo/action-settings.js'
import { ActionKey, createTask, deleteTask, TaskAction, TaskStatus, updateTaskStatus } from '../src/repo/tasks.js'
import { createUser } from '../src/repo/users.js'
import { Scheduler } from '../src/scheduler/runner.js'
import { test as base } from './fixtures.js'

/**
 * 「sweep 之后，还想要的常驻工作留下，不再想要的就退场」—— 接缝上测，两半都是真的。
 *
 * `watch-loop.ts` 记着那个缺口：任务被暂停、删掉，或者动作开关关掉时，没有任何东西会去停已经跑起来的观看
 * 循环。修法在 sweep 这一侧 —— 每一轮 sweep 算出「还要什么」，让 Platform 把其余的收掉（`retainResidentWork`）。
 * 这个文件钉的就是那条链的两端：真的 `Scheduler`（真的 `listSchedulableTasks`、真的开关读取、真的调用顺序）
 * 加上真的 B 站适配器（真的循环注册表、真的 `discard`），网络只有 `fetch` 替身。
 *
 * **停没停，只能从外面这样看**：把替身时钟推十拍的长度，一个还在跑的循环会继续下单 —— 所以每条「停掉」的断言
 * 都是心跳数**一个都不涨**（`bilibili-reconcile.test.ts` 里那个 describe 用的也是这个读数；`discard` 只发出
 * 请求、不等它，能证明它到位的只有这个）。反方向那条同样重要，而且更危险：还想要的工作**不许**被停掉。
 *
 * 时钟只伪造 `setTimeout`/`clearTimeout`（循环睡的是它，`watch-loop.ts` 的 `pause`），`Date` 留真的，
 * `AbortSignal.timeout` 于是还是真的超时。`stopWatchLoops` 放在 `unstubAllGlobals` **之前**：中止在途请求
 * 走的就是那个替身 fetch。
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))

const ROOM_ID = 22_908_869
const ANCHOR_ID = 2_071_691_173
const CSRF = 'jct-value-for-test'
const BUVID = 'LIVE-BUVID-FOR-TEST'
const LIKER_UID = '987654'
const HOUR = 60 * 60 * 1000
/** 一次心跳的间隔：`beatMsOf` 在服务端下发 60 秒时就是 60 秒。 */
const BEAT_MS = 60_000

/** 用例插入的任务时间以它为锚，而 sweep 的 `now` 由用例自己给（`decide` 读的就是它）。 */
const NOW = Date.now()

/* ------------------------------------------------------------------ *
 * fetch 替身：按 URL 前缀分派，没有兜底
 * ------------------------------------------------------------------ */

/** `attempt` 是第几次问这个 URL；这个文件里所有回复都与次数无关，只有一个用例会挂住不回。 */
type Route = (attempt: number) => unknown

/** 发出去过的每一个 URL，按顺序：这个文件最要紧的三个读数都是它数出来的。 */
let requests: string[] = []
let logs: string[] = []

/**
 * 装上路由表。**没有兜底回复**：这一版最要紧的断言是「请求数没有涨」，一个默认成功会把多发的那一次盖住，
 * 而一条没预料到的请求（真网的动作）必须当场炸出来，不能悄悄过去。
 *
 * 一个路由可以返回一个**永不落定**的 promise：这是「一轮 sweep 卡在平台调用里」的那个窗口，只有一个用例
 * 用它，用来在「读完任务快照」之后、「交还想不想要」之前插进去。
 */
function serve(routes: Readonly<Record<string, Route>>): void {
  const counts = new Map<string, number>()

  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push(url)

    const key = Object.keys(routes).find(candidate => url.startsWith(candidate))
    if (key === undefined) throw new Error(`没有为这个请求准备响应：${url}`)

    const attempt = counts.get(key) ?? 0
    counts.set(key, attempt + 1)

    const reply = await settleOrAbort(routes[key]?.(attempt), init?.signal)
    if (reply instanceof Response) return reply
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

/** 等一次回复，或者在请求被中止时当场抛 —— 与真 `fetch` 唯一有关的那一点行为。 */
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

/* ------------------------------------------------------------------ *
 * 回复：形状照 `bilibili-reconcile.test.ts` 与 `watch-loop.test.ts`，心跳链路本来就未实测
 * ------------------------------------------------------------------ */

function enterReply(heartbeatInterval: number): unknown {
  return {
    code: 0,
    message: '0',
    data: {
      timestamp: 1_791_434_562,
      heartbeat_interval: heartbeatInterval,
      secret_key: 'secret-key-from-server',
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
      timestamp: 1_791_434_622,
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

/** 面板一直「没完成」：循环于是会一直拍下去，这正是「还在跑」的读数需要的底座。 */
function panelReply(): unknown {
  return {
    code: 0,
    message: '0',
    data: { intimacy: 1, is_lighted: true, task_info: [WATCH_ROW_PENDING] }
  }
}

/** 直播间在播，分区 id 齐（心跳的 `id` 字段要的就是这两个）。 */
function roomReply(): unknown {
  return {
    code: 0,
    message: '0',
    data: {
      room_id: ROOM_ID,
      short_id: 0,
      uid: ANCHOR_ID,
      live_status: 1,
      live_time: 1_791_434_400,
      title: '测试直播间',
      parent_area_id: 1,
      area_id: 283
    }
  }
}

/** 直播页：正文会被读走并丢掉，有用的只有那条 `Set-Cookie`（`liveBuvidOf` 的全部目的）。 */
function livePage(): Response {
  return new Response('<!doctype html><html><head><title>直播间</title></head></html>', {
    status: 200,
    headers: { 'content-type': 'text/html', 'set-cookie': `LIVE_BUVID=${BUVID}; Path=/; Domain=.bilibili.com` }
  })
}

/** 续期检查：sweep 每六小时会问一次（第一次 sweep 就会问），这里服务端说不用续。 */
const COOKIE_INFO_URL = 'https://passport.bilibili.com/x/passport-login/web/cookie/info'
const LIVE_PAGE_URL = `https://live.bilibili.com/${String(ROOM_ID)}`

function withRoutes(overrides: Readonly<Record<string, Route>> = {}): void {
  serve({
    [LIVE_TRACE_ENTER_URL]: () => enterReply(60),
    [LIVE_TRACE_HEARTBEAT_URL]: () => heartbeatReply(60),
    [ACTIVATED_MEDAL_INFO_URL]: panelReply,
    [ROOM_INFO_URL]: roomReply,
    [LIVE_PAGE_URL]: livePage,
    [COOKIE_INFO_URL]: () => ({ code: 0, message: '0', data: { refresh: false } }),
    ...overrides
  })
}

/** 一个形状正确的登录凭据：SESSDATA 是会话，`bili_jct` 是写请求要的那个 cookie。 */
const CREDENTIALS = JSON.stringify({
  cookies: JSON.stringify({ SESSDATA: 'sessdata-value-for-test', bili_jct: CSRF, DedeUserID: LIKER_UID }),
  refreshToken: ''
})

/* ------------------------------------------------------------------ *
 * 脚手架
 * ------------------------------------------------------------------ */

/**
 * 一个注册了真 B 站适配器的进程里，一个账号、一个 `watch_live` 任务、一台调度器。
 *
 * 适配器在这里显式注册：`fixtures.ts` 的 import 图已经会把它带进来（`src/index.ts` → `platform/index.ts`），
 * 但依赖一个 import 副作用来让这个文件跑起来是那种「改一行别人就红」的写法。
 *
 * `requireOnline: false` 把开播探测（另一个题目，`probe` 有自己的用例）挡在这次 sweep 之外；
 * `interval: 1` 让隔一秒的下一次 sweep 真的再跑一遍动作，而不是停在冷却里 —— 「还想要」的那条断言要看的
 * 就是「sweep 真的跑了它，而且没把循环收掉」。
 */
interface Desk {
  readonly db: Db
  readonly userId: number
  readonly accountId: number
  readonly taskId: number
  readonly scheduler: Scheduler
}

registerPlatform(bilibiliPlatform)

const it = base.extend<{ desk: Desk }>({
  desk: async ({ db }, use) => {
    const user = createUser(db, 'watch-retire', 'x', NOW)
    const account = upsertAccount(db, user.id, {
      platform: 'bilibili',
      externalId: LIKER_UID,
      displayName: '主号',
      avatar: '',
      credentials: CREDENTIALS
    })
    setActionEnabled(db, user.id, 'bilibili', ActionKey.WatchLive, true, undefined, NOW)
    const task = createTask(
      db,
      user.id,
      {
        platform: 'bilibili',
        accountId: account.id,
        libraryId: null,
        action: TaskAction.Reconcile,
        actionKey: ActionKey.WatchLive,
        targetKey: String(ROOM_ID),
        targetTitle: '测试直播间',
        startTime: NOW - HOUR,
        endTime: NOW + 24 * HOUR,
        interval: 1,
        saltEnabled: false,
        requireOnline: false
      },
      NOW
    )

    await use({
      db,
      userId: user.id,
      accountId: account.id,
      taskId: task.id,
      scheduler: new Scheduler({
        db,
        log: line => {
          logs.push(line)
        }
      })
    })
  }
})

/** 服务端接受过的心跳数。循环在跑，它就一直涨；被停掉，它一个都不涨。 */
function heartbeats(): number {
  return requests.filter(url => url.startsWith(LIVE_TRACE_HEARTBEAT_URL)).length
}

/** 进场次数，与心跳数一起读，好让「没有第二段循环」也有话可说。 */
function enters(): number {
  return requests.filter(url => url.startsWith(LIVE_TRACE_ENTER_URL)).length
}

/** 让循环自己的 promise 链跑到下一个 await（`setImmediate` 是真的，所以这不是在推时钟）。 */
async function letLoopRun(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** 把时钟推 `ms`，再让被叫醒的那一段跑完。 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await letLoopRun()
}

/**
 * 先让一次 sweep 把循环启动起来，再让它拍一拍 —— 每个用例的共同起点。
 *
 * 这一拍的等待也是「启动没有等循环」的读数：`tick` 返回时进场甚至还没落定，而循环照样在下一次推时钟时拍。
 */
async function startLoop(desk: Desk): Promise<void> {
  const report = await desk.scheduler.tick(NOW)
  expect(report).toMatchObject({ scanned: 1, reconciled: 1 })
  await letLoopRun()
  expect(enters()).toBe(1)

  await advance(BEAT_MS)
  expect(heartbeats()).toBe(1)
}

/**
 * 「不要了」读数的后半句：从那一刻起推十拍的长度，心跳数一个都不涨。
 *
 * `beats` 是那一刻已经拍下的数，随用例不同（这一轮 sweep 之前发生过什么不一样）。十拍而不是一拍，是因为
 * 循环自己也会每隔三拍回读面板与直播间；推得够远，一个还在跑的循环就一定会露出来。
 */
async function nothingKeepsBeating(beats: number): Promise<void> {
  await advance(10 * BEAT_MS)
  expect(heartbeats()).toBe(beats)
  expect(enters()).toBe(1)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  requests = []
  logs = []
  vi.stubGlobal('fetch', fetchMock)
  withRoutes()
})

afterEach(async () => {
  // 循环跑在 sweep 之外，不属于任何用例：`stopWatchLoops` 是模块为此导出的口子（`watchLoops` 本身不导出）。
  // 放在 `unstubAllGlobals` 之前，因为中止在途请求走的就是那个替身 fetch。
  await stopWatchLoops()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/* ------------------------------------------------------------------ *
 * 还想要的，一个都不许停
 * ------------------------------------------------------------------ */

describe('还在跑的任务：sweep 不许碰它的循环', () => {
  it('任务还能跑：每一轮 sweep 之后心跳照旧涨，一拍都不少', async ({ desk }) => {
    // 这是危险的那一边。sweep 每一轮都会把「还想要」交给 Platform，而一次实现失误（交空集合，或者把
    // 「读不到」当成「不要」）会在这里表现为心跳停在 1 —— 代价是这一天的任务，而且没有下一轮把它捡回来。
    await startLoop(desk)

    const second = await desk.scheduler.tick(NOW + 2_000)
    expect(second).toMatchObject({ scanned: 1, reconciled: 1 })
    await advance(BEAT_MS)
    expect(heartbeats()).toBe(2)

    const third = await desk.scheduler.tick(NOW + 4_000)
    expect(third).toMatchObject({ scanned: 1, reconciled: 1 })
    await advance(BEAT_MS)
    expect(heartbeats()).toBe(3)

    // 一直只有一个循环、一个设备：没有第二段进场。
    expect(enters()).toBe(1)
  })
})

/* ------------------------------------------------------------------ *
 * 三种「不要了」，由下一次 sweep 收掉
 * ------------------------------------------------------------------ */

describe('不再想要的任务：下一次 sweep 把循环收掉', () => {
  it('动作开关关掉：那一行还在 sweep 里（报 blocked），但循环停了', async ({ desk }) => {
    await startLoop(desk)

    setActionEnabled(desk.db, desk.userId, 'bilibili', ActionKey.WatchLive, false, undefined, NOW)

    const report = await desk.scheduler.tick(NOW + 2_000)

    // 这一条钉的是「扫到了、但不要了」：关掉开关的行仍然在 sweep 的工作集里（`writeStandingReport` 会为它
    // 写一条 blocked/switch_off），所以停它不是「扫不到」，是 runner 读开关之后没把它放进「还想要」的集合。
    expect(report).toMatchObject({ scanned: 1, monitored: 1 })
    await nothingKeepsBeating(1)
  })

  it('任务被删掉：下一轮 sweep 的工作集里没有它，循环停了', async ({ desk }) => {
    await startLoop(desk)

    expect(deleteTask(desk.db, desk.userId, desk.taskId)).toBe(true)

    const report = await desk.scheduler.tick(NOW + 2_000)

    // 行为没变过：被删掉的行本来就不在 sweep 里，变的只是现在有一个调用会因此把它留下的循环收掉。
    expect(report.scanned).toBe(0)
    await nothingKeepsBeating(1)
  })

  it('任务被暂停：暂停的行不在 sweep 里（`listSchedulableTasks`），循环还是停了', async ({ desk }) => {
    await startLoop(desk)

    updateTaskStatus(desk.db, desk.taskId, TaskStatus.Paused, '', NOW + 1_000)

    const report = await desk.scheduler.tick(NOW + 2_000)

    expect(report.scanned).toBe(0)
    await nothingKeepsBeating(1)
  })

  it('同一个房间上另一个动作的任务：这个 (账号, 房间) 仍被点名，但观看循环照样停', async ({ desk }) => {
    // `ResidentWorkRef` 带着 `actionKey` 就是为了这一条：循环是「观看直播」这个动作的工作，所以「同一对
    // (账号, 房间) 上还有一条任务」不等于「这个循环还要」。这里把观看关掉，换成同一个房间上的一条发送弹幕
    // 任务（开关打开、没有文本库 —— 于是 sweep 会把它判失败，一个请求都不发），这个 (账号, 房间) 于是仍然在
    // 「还想要」的集合里，只是点名它的不是循环的主人。
    await startLoop(desk)

    setActionEnabled(desk.db, desk.userId, 'bilibili', ActionKey.WatchLive, false, undefined, NOW)
    setActionEnabled(desk.db, desk.userId, 'bilibili', ActionKey.SendDanmaku, true, undefined, NOW)
    createTask(
      desk.db,
      desk.userId,
      {
        platform: 'bilibili',
        accountId: desk.accountId,
        libraryId: null,
        action: TaskAction.Send,
        actionKey: ActionKey.SendDanmaku,
        targetKey: String(ROOM_ID),
        targetTitle: '同一个房间',
        startTime: NOW - HOUR,
        endTime: NOW + 24 * HOUR,
        interval: 10,
        saltEnabled: false,
        requireOnline: false
      },
      NOW
    )

    const report = await desk.scheduler.tick(NOW + 2_000)

    // 两条都在 sweep 里：观看那条报 blocked（开关关了），发送那条失败（没有文本库），而这两条任务谁也不为
    // 这个循环作保 —— 循环归「观看直播」这个动作。
    expect(report).toMatchObject({ scanned: 2, monitored: 1, failed: 1 })
    await nothingKeepsBeating(1)
  })

  it('一轮 sweep 走到一半时写下的暂停：这一轮看不见它，下一轮才收', async ({ desk }) => {
    // 延迟到底是多大，这一条把它的形状钉住：「还想要」是从 sweep 在开头读到的那份任务快照算出来的，所以快照
    // 之后写下的暂停要等下一轮 sweep 才生效 —— 是一轮，不是「一直」。
    await startLoop(desk)

    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let announce: () => void = () => {}
    const insidePlatformCall = new Promise<void>(resolve => {
      announce = resolve
    })
    // 第二轮卡在「读直播间」这一步：那一刻它早读完了任务快照，正停在平台调用里。
    withRoutes({
      [ROOM_INFO_URL]: () => {
        announce()
        return held.then(() => roomReply())
      }
    })

    const second = desk.scheduler.tick(NOW + 2_000)
    await insidePlatformCall

    updateTaskStatus(desk.db, desk.taskId, TaskStatus.Paused, '', NOW + 2_500)
    release()
    await second

    // 这一轮交出去的是它读到的那份快照，里面还有这一行 —— 循环这一轮没有被收。
    await advance(BEAT_MS)
    expect(heartbeats()).toBe(2)

    // 下一轮：暂停的行不在工作集里，循环被收掉。
    const third = await desk.scheduler.tick(NOW + 4_000)
    expect(third.scanned).toBe(0)
    await nothingKeepsBeating(2)
  })
})

/* ------------------------------------------------------------------ *
 * 读不到 ≠ 不要
 * ------------------------------------------------------------------ */

describe('sweep 读不到任务时的方向：什么都不停', () => {
  it('任务表读不出来：sweep 当场失败，循环照旧拍', async ({ desk }) => {
    // 这个方向由结构决定，而不是由一个 `catch` 决定：算集合的那一次读抛了，这一轮的调用就走不到，
    // 于是「读不到」永远不可能被当成「这一轮什么都不想要」交出去。
    await startLoop(desk)

    desk.db.exec('DROP TABLE tasks')

    await expect(desk.scheduler.tick(NOW + 2_000)).rejects.toThrow()

    await advance(10 * BEAT_MS)
    expect(heartbeats()).toBe(11)
  })

  it('动作开关读不出来：同一个方向，循环照旧拍', async ({ desk }) => {
    // 「还想要」这个集合是逐个任务读开关读出来的，所以在这里抛也一样：读不到开关的任务不会被当成关了开关
    // 的任务 —— 那正是「杀掉一个还想要的循环」的那条路。
    await startLoop(desk)

    desk.db.exec('DROP TABLE action_settings')

    await expect(desk.scheduler.tick(NOW + 2_000)).rejects.toThrow()

    await advance(10 * BEAT_MS)
    expect(heartbeats()).toBe(11)
  })
})
