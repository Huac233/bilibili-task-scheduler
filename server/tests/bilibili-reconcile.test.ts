import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LIKE_INTERACT_URL, LIKE_REPORT_V3_URL } from '../src/bilibili/like.js'
import { ROOM_INFO_URL } from '../src/bilibili/live.js'
import { ACTIVATED_MEDAL_INFO_URL, ROOM_INFO_BY_ROOM_URL } from '../src/bilibili/medal.js'
import { LIVE_TRACE_ENTER_URL, LIVE_TRACE_HEARTBEAT_URL } from '../src/bilibili/watch-live.js'
import { bilibiliPlatform, stopWatchLoops } from '../src/platform/bilibili/index.js'
import type { ActionOutcome, PlatformAccount, ReconcileContext } from '../src/platform/types.js'
import { ActionKey, TaskAction } from '../src/repo/tasks.js'

/**
 * B 站的两个亲密度动作，在接缝上测：读 → 判断 → 动手 → 回读。
 *
 * 这个文件存在的理由是那三件「不该自己发明」的事：
 *
 *  1. **形状来自实盘。** 任务面板、房间点赞开关、点赞成功信封全部照抄 2026-10-08 的实盘
 *     （房间 22908869，主播 uid 2071691173，笔记 `bili-live-like-live-test-2026-10-08.md`）。
 *     同一批常量在 `bilibili-medal.test.ts` 里也有一份，这是刻意的：一个测试文件就是一个 mock
 *     隔离单元，两个文件各自把抓到的字节当字面量钉住，谁把形状改宽改窄谁自己红，比共享一个夹具
 *     模块少一层耦合。**构造出来的两处**（`Room/get_info` 的响应、心跳链路的响应）在各自注释里
 *     写明没有实盘抓包。
 *  2. **次数与批量都不许硬编码。** 批量取自任务标题、日上限取自 `sub_title`，两个都逐牌子下发，
 *     所以本文件让「上限 1 的牌子」和「上限 10 的牌子」各走完该走的轮数 —— 一个常量的循环不可能
 *     同时通过这两条。
 *  3. **每个 item 都要认得出它所在的记录。** `douyu-adapter.test.ts` 把这条不变量写成关系断言，
 *     这里照做（`expectItemsToAgree`）。
 *
 * 时间被 mock：`node:timers/promises` 的 `setTimeout` 换成立刻返回的替身，于是「等的是服务端下发的
 * 间隔」既被断言了（断言的是**毫秒数**），又不会让测试真的等上几分钟。这也让「900 秒不是心跳周期」
 * 可以钉住：整份文件里没有任何一次 `sleep(900000)`。
 *
 * `watch_live` 那一段还有第二个时钟：常驻观看循环睡的是全局 `setTimeout`，而被替身换掉的那个模块函数管
 * 不到它，所以那个 describe 自己开着假时钟（只伪造 `setTimeout`/`clearTimeout`），循环的拍子由测试推着走。
 */

const { fetchMock, sleepMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), sleepMock: vi.fn() }))

vi.mock('node:timers/promises', () => ({
  setTimeout: sleepMock,
  setImmediate: vi.fn(),
  setInterval: vi.fn()
}))

/* ------------------------------------------------------------------ *
 * 实盘抓到的字节
 * ------------------------------------------------------------------ */

const ROOM_ID = 22_908_869
const ANCHOR_ID = 2_071_691_173
/** cookie 里的 `DedeUserID`。点赞请求的 `uid` 必须取它，而不是账号行里的任何字段。 */
const LIKER_UID = 987_654
const CSRF = 'jct-value'
/** 直播域名下发的设备 cookie。心跳签名用它，所以它不在登录凭据里。 */
const BUVID = 'LIVE-BUVID-VALUE'

/**
 * `getInfoByRoom` 的 `data`，实盘原样。
 *
 * 未声明的键（`module_control_infos` 那次是 `like_module: false`、`report_click_limit: 15`）全部留着，
 * 正是为了证明「只声明消费的字段」在隔离：它们必须被 zod 丢掉，不许流进判定 —— 那次**成功并被结算
 * +1 亲密度**的点赞，所在房间读回来就是 `like_module = false`。
 */
const ROOM_DATA = {
  like_info_v3: {
    total_likes: 13_298_333,
    click_block: false,
    count_block: false,
    cooldown: 0.35,
    report_click_limit: 15,
    report_time_min: 5,
    report_time_max: 10,
    count_show_time: 15,
    like_dm_text: '谢谢你的赞，每点赞30次有概率为主播增加曝光哦～',
    guild_dm_text: '点赞30次可以帮主播冲刺热门榜哦～',
    guild_emo_text: '试试双击点赞 让主播被更多人看到吧～'
  },
  new_switch_info: { danmu_click_switch: 1 },
  module_control_infos: { like_module: false }
}

/** `GetActivatedMedalInfo` 的 `data.task_info`，实盘原样（点赞前）。 */
const TASKS_BEFORE_LIKE = [
  { title: '投喂粉丝灯牌', sub_title: '每日上限 0/1', add_text: '亲密度+6', jump_type: 'feedLight', is_done: false },
  {
    title: '观看直播满15分钟',
    sub_title: '每日上限 0/1',
    add_text: '亲密度+1',
    jump_type: 'watchLive',
    is_done: false
  },
  { title: '投喂礼物', sub_title: '+1亲密度/电池', add_text: '亲密度+1', jump_type: 'sendGift', is_done: false },
  { title: '发弹幕', sub_title: '每日上限 0/1', add_text: '亲密度+1', jump_type: 'sendDanmu', is_done: false },
  { title: '点赞30次', sub_title: '每日上限 0/1', add_text: '亲密度+1', jump_type: 'like', is_done: false }
]

/** 一次 `click_time=30` 之后同一块面板的那一行（实盘回读：`1/1` 且 `is_done` 翻 true）。 */
const TASKS_AFTER_LIKE = TASKS_BEFORE_LIKE.map(task =>
  task.jump_type === 'like' ? { ...task, sub_title: '每日上限 1/1', is_done: true } : task
)

/** 同一个牌子，只有观看任务翻完成：用来证明「攒够没有」是服务端说的那一件事。 */
const TASKS_AFTER_WATCH = TASKS_BEFORE_LIKE.map(task =>
  task.jump_type === 'watchLive' ? { ...task, sub_title: '每日上限 1/1', is_done: true } : task
)

/** `GetActivatedMedalInfo` 的 `data`，实盘字段照抄（本实现只消费其中两个）。 */
const MEDAL_DATA = { intimacy: 1, is_lighted: true, free_intimacy: 0, reach_free_intimacy_limit: false }

/** 未点亮的牌子（实盘）：只有两行，`sub_title` 直接是「仅点亮」。 */
const TASKS_NOT_LIT = [
  { title: '发弹幕', sub_title: '仅点亮', add_text: '亲密度+1', jump_type: 'sendDanmu', is_done: false },
  { title: '点赞30次', sub_title: '仅点亮', add_text: '亲密度+1', jump_type: 'like', is_done: false }
]

/** `likeReportV3` 的成功信封，实盘原样（两次调用都是这一个）。 */
const LIKE_OK = { code: 0, message: 'OK', ttl: 1, data: {} }

/**
 * `Room/get_info` 的响应：**构造**，没有抓到过。
 *
 * 字段名来自两份参考实现的 `RoomInfo`（`ref-bilibili-live-helper/src/api.ts:492-493` 的 `area_id` /
 * `parent_area_id`），因为心跳的 `id` 字段要的就是这两个；`room_id`、`uid` 用实盘那个房间的真实值，
 * `live_status: 1` 也是实盘状态（那次点赞成功时房间在播）。
 */
const ROOM_INFO_DATA = {
  room_id: ROOM_ID,
  short_id: 0,
  uid: ANCHOR_ID,
  live_status: 1,
  live_time: 1_791_434_400,
  title: '测试直播间',
  parent_area_id: 1,
  area_id: 283
}

/**
 * 一块 level 30 的牌子（实盘只读到 `like` / `watchLive` / `sendDanmu` 三行，其余补成同一形状）。
 * 上限 10 是实测值，也是「日上限逐牌子下发」的证据里那个上限。
 */
function highLevelPanel(resolution: readonly unknown[]): readonly unknown[] {
  return [
    { title: '投喂粉丝灯牌', sub_title: '每日上限 0/1', add_text: '亲密度+6', jump_type: 'feedLight', is_done: false },
    {
      title: '观看直播满15分钟',
      sub_title: '每日上限 0/10',
      add_text: '亲密度+1',
      jump_type: 'watchLive',
      is_done: false
    },
    { title: '投喂礼物', sub_title: '+1亲密度/电池', add_text: '亲密度+1', jump_type: 'sendGift', is_done: false },
    { title: '发弹幕', sub_title: '每日上限 0/10', add_text: '亲密度+1', jump_type: 'sendDanmu', is_done: false },
    ...resolution
  ]
}

/** 上限 10 那块牌子上，点赞任务的第 `claimed` 轮状态。 */
function likeRow(claimed: number, isDone: boolean): readonly unknown[] {
  return [
    {
      title: '点赞30次',
      sub_title: `每日上限 ${String(claimed)}/10`,
      add_text: '亲密度+1',
      jump_type: 'like',
      is_done: isDone
    }
  ]
}

/**
 * 心跳链路的两个响应：**构造**，这一条链路没有任何实盘抓包（笔记 §6.7 明说未实测）。
 *
 * 字段名取自参考实现的返回类型；`secret_key` 特意写成一眼能认出的字符串，好让「它有没有漏进错误
 * 信息」可断言。`heartbeat_interval` 由服务端下发，所以每个用例自己指定。
 */
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

const NAV_REPLY = {
  code: 0,
  message: '0',
  data: {
    isLogin: true,
    mid: LIKER_UID,
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
    }
  }
}

/* ------------------------------------------------------------------ *
 * fetch 替身：一个按 URL 分派的 router
 * ------------------------------------------------------------------ */

interface CapturedRequest {
  readonly url: string
  readonly method: string
  readonly body: string | null
}

/** 一次回复：JSON 对象，或者一个完整的 `Response`（直播页那条用后者，因为它要带 `Set-Cookie`）。 */
type Reply = unknown | Response

/** `attempt` 是第几次问这个 URL —— 「第一次读」和「回读」的答案本来就不同。 */
type Route = (attempt: number) => Reply

let requests: CapturedRequest[] = []
let logs: string[] = []

/**
 * 装上路由表。前缀匹配，**没有兜底回复**：这一版最需要防的恰恰是「多发了一次请求」，一个默认成功
 * 会把它盖住。
 *
 * 一个路由可以返回一个**永不落定**的 promise：常驻观看循环的请求不在 sweep 的 `await` 链上，所以
 * 「把循环卡在半路」是这一版能证明「sweep 没有等它」的办法。中止那条路同样必要 —— 循环自己的
 * `AbortController` 会中止在途请求，而一个忽略 signal 的替身会让 `loop.finished` 永远悬着，
 * 于是 `stopWatchLoops` 在每个用例之间挂死。
 */
function serve(routes: Readonly<Record<string, Route>>): void {
  const counts = new Map<string, number>()

  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null })

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

/** 一块面板，按读的次数回放；读完最后一个就一直是它。 */
function panelReplies(reads: readonly (readonly unknown[])[]): Route {
  return attempt => ({
    code: 0,
    message: '0',
    data: { ...MEDAL_DATA, task_info: reads[Math.min(attempt, reads.length - 1)] }
  })
}

/** 未点亮的牌子，`is_lighted` 为 false 的那一块。 */
function unlitPanel(): Route {
  return () => ({ code: 0, message: '0', data: { intimacy: 0, is_lighted: false, task_info: TASKS_NOT_LIT } })
}

const roomLikeReplies: Route = () => ({ code: 0, message: '0', data: ROOM_DATA })
const roomInfoReply: Route = () => ({ code: 0, message: '0', data: ROOM_INFO_DATA })
const likeReportReplies: Route = () => LIKE_OK

const LIVE_PAGE_URL = `https://live.bilibili.com/${String(ROOM_ID)}`

/**
 * 直播页：正文是 HTML，会被读走并丢掉；有用的只有那条 `Set-Cookie`（`liveBuvidOf` 的全部目的）。
 * `issuesBuvid = false` 用来演「直播域名没给设备 cookie」这一种失败。
 */
function livePage(issuesBuvid = true): Route {
  return () =>
    new Response('<!doctype html><html><head><title>直播间</title></head></html>', {
      status: 200,
      headers: issuesBuvid
        ? { 'content-type': 'text/html', 'set-cookie': `LIVE_BUVID=${BUVID}; Path=/; Domain=.bilibili.com` }
        : { 'content-type': 'text/html' }
    })
}

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'

/** 常态路由表；用例只覆盖自己关心的那几条。每次重建，因为 `attempt` 计数属于一次 `serve`。 */
function withRoutes(overrides: Readonly<Record<string, Route>> = {}): void {
  serve({
    [LIVE_TRACE_ENTER_URL]: () => enterReply(60),
    [LIVE_TRACE_HEARTBEAT_URL]: () => heartbeatReply(60),
    [LIKE_REPORT_V3_URL]: likeReportReplies,
    [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE]),
    [ROOM_INFO_BY_ROOM_URL]: roomLikeReplies,
    [ROOM_INFO_URL]: roomInfoReply,
    [LIVE_PAGE_URL]: livePage(),
    [NAV_URL]: () => NAV_REPLY,
    ...overrides
  })
}

/* ------------------------------------------------------------------ *
 * 用例的脚手架
 * ------------------------------------------------------------------ */

const CREDENTIALS = JSON.stringify({
  cookies: JSON.stringify({ SESSDATA: 'sessdata-value', bili_jct: CSRF, DedeUserID: String(LIKER_UID) }),
  refreshToken: ''
})

function account(credentials: string = CREDENTIALS): PlatformAccount {
  return {
    id: 7,
    platform: 'bilibili',
    externalId: String(LIKER_UID),
    displayName: 'tester',
    avatar: '',
    credentials,
    meta: '{}'
  }
}

/** 跑一次 reconcile。targetKey 默认是实盘那个房间。 */
async function run(
  enabled: readonly string[],
  targetKey = String(ROOM_ID),
  credentials = CREDENTIALS
): Promise<ActionOutcome[]> {
  const context: ReconcileContext = {
    account: account(credentials),
    targetKey,
    enabledActions: enabled,
    // These cases drive the chore, not the switchboard, so nothing was set on any switch.
    options: {},
    // 实盘那天的 `wts`（2026-10-08 04:41:17Z），固定下来好让日志可复现。
    now: 1_791_434_562_000,
    dayKey: '2026-10-08',
    log: (line: string): void => {
      logs.push(line)
    }
  }

  return await bilibiliPlatform.reconcile(context)
}

/** 只跑一个动作，取它那一条 —— 省掉每条用例里的下标。 */
async function runOne(
  actionKey: string,
  targetKey = String(ROOM_ID),
  credentials = CREDENTIALS
): Promise<ActionOutcome> {
  const outcomes = await run([actionKey], targetKey, credentials)
  const found = outcomes[0]
  if (found === undefined) throw new Error('reconcile 没有返回任何结果')
  return found
}

function requestsTo(urlPrefix: string): CapturedRequest[] {
  return requests.filter(request => request.url.startsWith(urlPrefix))
}

/** 睡过的毫秒数，按顺序。心跳节奏与点赞节奏都靠它断言。 */
function sleptMs(): number[] {
  return sleepMock.mock.calls.map(call => Number(call[0]))
}

function paramsOf(request: CapturedRequest): URLSearchParams {
  return new URL(request.url).searchParams
}

function bodyOf(request: CapturedRequest): URLSearchParams {
  return new URLSearchParams(request.body ?? '')
}

beforeEach(() => {
  vi.clearAllMocks()
  requests = []
  logs = []
  sleepMock.mockImplementation(async () => undefined)
  vi.stubGlobal('fetch', fetchMock)
  withRoutes()
})

afterEach(async () => {
  // 观看循环跑在 sweep 之外，所以它不属于任何一个用例：`stopWatchLoops` 是模块为此导出的那个口子，
  // 它也是只在这里能停住循环的地方（`watchLoops` 本身不导出）。放在 `unstubAllGlobals` **之前**，
  // 因为中止在途请求要走的就是那个替身 fetch。
  await stopWatchLoops()
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------ *
 * 目录项
 * ------------------------------------------------------------------ */

describe('两个亲密度动作的目录项', () => {
  it('like_danmaku 用已有的那个 key，声明为 per-room 的日常动作', () => {
    // `ActionKey.LikeDanmaku` 早就在 `repo/tasks.ts` 里声明过，这里只是把它补进目录；不另立拼法。
    expect(ActionKey.LikeDanmaku).toBe('like_danmaku')

    const descriptor = bilibiliPlatform.actions.find(action => action.key === ActionKey.LikeDanmaku)

    expect(descriptor).toMatchObject({
      action: TaskAction.Reconcile,
      label: '点赞',
      costly: false,
      needsTarget: true,
      needsLibrary: false,
      maxMessageLength: 0,
      defaultIntervalSeconds: 300,
      minIntervalSeconds: 60
    })
    // 不花任何东西必须说出来；上限与批量都是服务端下发的，所以那句话里不许有数字。
    expect(descriptor?.description).toContain('不用花任何东西')
    expect(descriptor?.description).toContain('服务端')
  })

  it('watch_live 跟着邻居命名，同样 per-room', () => {
    expect(ActionKey.WatchLive).toBe('watch_live')

    const descriptor = bilibiliPlatform.actions.find(action => action.key === ActionKey.WatchLive)

    expect(descriptor).toMatchObject({
      action: TaskAction.Reconcile,
      label: '观看直播',
      costly: false,
      needsTarget: true,
      needsLibrary: false,
      maxMessageLength: 0,
      defaultIntervalSeconds: 300,
      minIntervalSeconds: 60
    })
    expect(descriptor?.description).toContain('观看满15分钟')
    expect(descriptor?.description).toContain('服务端')
  })

  it('send_danmaku 的收益写在它唯一写得进去的地方', () => {
    const descriptor = bilibiliPlatform.actions.find(action => action.key === ActionKey.SendDanmaku)

    // Send 动作没有 item（`SendOutcome` 里没这个字段），而它的 `detail` 只在失败时被读
    // （`runner.ts` 把它写成发送日志的 error，成功时写字面空串），所以「发弹幕也加亲密度」只能写在
    // 描述里 —— 那正是人决定要不要打开这个开关时读的那句话。
    expect(descriptor?.description).toContain('亲密度')
    expect(descriptor?.description).toContain('每天一次')
  })
})

/* ------------------------------------------------------------------ *
 * like_danmaku
 * ------------------------------------------------------------------ */

describe('like_danmaku', () => {
  it('上限 1 的牌子：一轮就把任务做完，并说出收益', async () => {
    withRoutes({
      // 读一次判断、发一轮、回读一次：第二次读就是实盘那次「1/1 且翻 true」。
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE, TASKS_AFTER_LIKE])
    })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    expect(outcome).toMatchObject({
      actionKey: ActionKey.LikeDanmaku,
      targetKey: String(ROOM_ID),
      outcome: 'done',
      failure: 'none',
      // 成功就是信封 code 0，与 `send` 报 `SendDanmakuCode.Ok` 是同一个写法。
      code: '0'
    })
    // 收益来自服务端自己写的 `add_text`，不是这里编的；轮数与次数是本轮真的发出去的。
    expect(outcome.detail).toContain('亲密度+1')
    expect(outcome.detail).toContain('已发出 1 轮共 30 次点赞')

    expect(requestsTo(LIKE_REPORT_V3_URL)).toHaveLength(1)
    // 读 → 动手 → 回读，所以面板与房间点赞开关各读两次。
    expect(requestsTo(ACTIVATED_MEDAL_INFO_URL)).toHaveLength(2)
    expect(requestsTo(ROOM_INFO_BY_ROOM_URL)).toHaveLength(2)
    // 一轮发完就结束，中间没有等待。
    expect(sleptMs()).toEqual([])
  })

  it('请求形状：批量取自任务标题，uid 取自凭据而不是账号行', async () => {
    withRoutes({
      // 标题里的数字是本文件唯一一处刻意改动实盘取值的地方：批量必须来自标题，所以标题得和实盘的 30
      // 不同，否则「没有硬编码」和「硬编码 30」两条都会通过。
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([
        TASKS_BEFORE_LIKE.map(task => (task.jump_type === 'like' ? { ...task, title: '点赞10次' } : task)),
        TASKS_AFTER_LIKE
      ])
    })

    await runOne(ActionKey.LikeDanmaku)

    const call = requestsTo(LIKE_REPORT_V3_URL)[0]
    if (call === undefined) throw new Error('没有发出点赞请求')
    const params = paramsOf(call)

    expect(call.method).toBe('POST')
    expect(params.get('click_time')).toBe('10')
    expect(params.get('room_id')).toBe(String(ROOM_ID))
    expect(params.get('anchor_id')).toBe(String(ANCHOR_ID))
    expect(params.get('uid')).toBe(String(LIKER_UID))
  })

  it('上限 10 的牌子：轮数由面板决定，一轮一轮加到服务端说完成', async () => {
    // level 30 那块牌子（实盘 `0/10`）：第 n 次回读看到 `n/10`，第 10 次回读看到 `10/10` 且完成。
    // 于是「上限 1 走 1 轮、上限 10 走 10 轮」同时成立 —— 任何常量轮数都不可能两条都过。
    const reads = Array.from({ length: 11 }, (_, index) =>
      index === 10 ? highLevelPanel(likeRow(10, true)) : highLevelPanel(likeRow(index, false))
    )
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies(reads) })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    expect(outcome).toMatchObject({ outcome: 'done', code: '0' })
    expect(requestsTo(LIKE_REPORT_V3_URL)).toHaveLength(10)
    expect(outcome.detail).toContain('已发出 10 轮共 300 次点赞')
    // 每一轮之间都按房间自己声明的 cooldown 等（0.35 秒；本地下限也是 350 毫秒）。
    expect(sleptMs()).toEqual(Array.from({ length: 9 }, () => 350))
  })

  it('任务已完成时一个字都不发，报 already', async () => {
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_AFTER_LIKE]) })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    expect(outcome).toMatchObject({ outcome: 'already', failure: 'action_stop', code: 'like_task_done' })
    // 事实而不是句子：行本身的标签就叫「点赞」，而「今天」由记录自己的 outcome 说，所以这句话里
    // 只剩下了「任务已完成」——原来的「今天的点赞任务已经完成。」把同一件事说了两遍。
    expect(outcome.detail).toContain('任务已完成')
    expect(requestsTo(LIKE_REPORT_V3_URL)).toEqual([])
    // 一次读就够：判定所需的输入第一次就齐了。
    expect(requestsTo(ACTIVATED_MEDAL_INFO_URL)).toHaveLength(1)
  })

  it('上限已满（`1/1` 而还没判完成）时同样不发', async () => {
    withRoutes({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([
        TASKS_BEFORE_LIKE.map(task => (task.jump_type === 'like' ? { ...task, sub_title: '每日上限 1/1' } : task))
      ])
    })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    expect(outcome).toMatchObject({ outcome: 'already', failure: 'action_stop', code: 'like_limit_reached' })
    expect(requestsTo(LIKE_REPORT_V3_URL)).toEqual([])
  })

  it('牌子没点亮（实盘那块）时不动手，报 blocked', async () => {
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: unlitPanel() })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    // `none` 而不是 `action_stop`：这是账号侧还没点亮，没有任何服务端判决，人点亮之后下一次就能做。
    expect(outcome).toMatchObject({ outcome: 'blocked', failure: 'none', code: 'medal_not_lit' })
    // 事实句，不是解释句：说不点亮会怎样、点亮之后会怎样，本来就是在说同一件事的两种说法。
    expect(outcome.detail).toContain('粉丝牌未点亮')
    expect(requestsTo(LIKE_REPORT_V3_URL)).toEqual([])
    // 闸门自己的判决书里带着面板字段名，它只该出现在控制台行里，不该出现在记录里。
    expect(outcome.detail).not.toContain('is_done')
    expect(logs.join('\n')).toContain('medal_not_lit')
  })

  it('计数一直不动时，一轮就收手，并把服务端自己的计数说出来', async () => {
    // 2026-10-09 20:36 那次就是这个形状：10 轮 300 次被服务端原样收下（`code: 0`），而它自己的
    // 计数在那次运行里没有跟着往前走。原先的循环把**入口那一次**读到的 `remainingRounds`（10）
    // 当成本次预算，于是发满 10 轮 —— 收手点是一个冻结在入口的本地数字，不是服务端的计数。
    // 现在收手点是服务端自己的计数：它没有跟着这一轮的发出往前走，就说明这一轮它还没认账，
    // 再发下去只是把同一批赞重复投出去。
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies([highLevelPanel(likeRow(0, false))]) })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    expect(requestsTo(LIKE_REPORT_V3_URL)).toHaveLength(1)
    // `blocked` 而不是 `failed`：没有东西坏掉，服务端就是慢，而 `blocked` 正是 runner 不肯当作
    // 落定的那两个取值之一 —— 当天留着，下一次运行再读。
    expect(outcome).toMatchObject({ outcome: 'blocked', failure: 'retry', code: 'like_unfinished' })
    // 句子里的两个数都是服务端的，一个都不是本地的账。
    expect(outcome.detail).toContain('已发出 1 轮共 30 次点赞')
    expect(outcome.detail).toContain('计数只走到 0/10')
    expect(outcome.detail).toContain('下一次运行再读一次')
  })

  it('计数停在 6/10 不再往前走时，发到它跟不上的那一步为止', async () => {
    // 当晚的两个真实读数：20:36 那次发出 10 轮 300 次；20:41 那次读回来是 6/10（它的预算 4 正是
    // 10 − 6）。计数走到 6 就停住，正是这个循环该停的地方 —— 同一份面板喂给旧代码，它会发满 10 轮、
    // 把 300 次里已经发过的那部分再发一遍。
    withRoutes({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([highLevelPanel(likeRow(0, false)), highLevelPanel(likeRow(6, false))])
    })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    expect(requestsTo(LIKE_REPORT_V3_URL)).toHaveLength(2)
    expect(outcome).toMatchObject({ outcome: 'blocked', failure: 'retry', code: 'like_unfinished' })
    expect(outcome.detail).toContain('已发出 2 轮共 60 次点赞')
    expect(outcome.detail).toContain('计数只走到 6/10')
  })

  it('计数自己追到上限时以完成收场，而不是报失败', async () => {
    // 当晚 20:51:43 的读数就是这件事：什么都没发，计数从 9 自己走到 10/10，`is_done` 翻真。
    // 所以「发出去之后计数才追上来」必须能落在**完成**上 —— 它是那晚真实发生过的结局。
    // 这一条在改动前后都应当通过：它钉的是新出口没有把原来的完成路径挤掉。
    withRoutes({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([highLevelPanel(likeRow(0, false)), highLevelPanel(likeRow(10, true))])
    })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    expect(requestsTo(LIKE_REPORT_V3_URL)).toHaveLength(1)
    expect(outcome).toMatchObject({ outcome: 'done', failure: 'none', code: '0' })
    expect(outcome.detail).toContain('已发出 1 轮共 30 次点赞')
    expect(outcome.detail).toContain('任务已完成（回读确认）')
  })

  it('两个端点的码都照原样带出，服务端自己的话进 detail，csrf 被抹掉', async () => {
    withRoutes({
      // A 失败后 `likeWithFallback` 会去打 B：取舍写在 `like.ts` 的模块头里。两条原因都要留住 ——
      // 运维手上唯一能看到的线索就是「A 说 X、B 说 Y」。
      [LIKE_REPORT_V3_URL]: () => ({ code: -352, msg: `风险校验失败：query csrf=${CSRF} rejected` }),
      [LIKE_INTERACT_URL]: () => ({ code: -400, message: '请求错误' })
    })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    // 回退路径报的是 B 的码（`like.ts` 的既有约定），两条路都试过了。
    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'retry', code: '-400' })
    // 同一个 -400 在 `/msg/send` 上是「房间全员禁言」，在那里按 `action_stop` 处理：码的含义随
    // 端点而定，所以两个端点各判各自的码 —— 这一条就是 `gradeSendCode` 顶上那段注释的依据。
    expect(outcome.detail).toContain('风险校验失败')
    expect(outcome.detail).toContain('请求错误')
    // 认不出来的码不猜语义，但也不许把凭据带回给人看。
    expect(outcome.detail).not.toContain(CSRF)
    expect(outcome.detail).toContain('<redacted>')
    expect(requestsTo(LIKE_INTERACT_URL)).toHaveLength(1)
  })

  it('-101 是账号级：停住这个账号，而不是重试', async () => {
    withRoutes({ [LIKE_REPORT_V3_URL]: () => ({ code: -101, message: '账号未登录' }) })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'account_stop', code: '-101' })
  })

  it('面板读被拒 -101 时按账号级处理，一个点赞请求都不发', async () => {
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: () => ({ code: -101, message: '账号未登录' }) })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'account_stop', code: '-101' })
    expect(requestsTo(LIKE_REPORT_V3_URL)).toEqual([])
  })

  it('房间点赞开关读被拒时收成 fail-closed，也不去动手', async () => {
    withRoutes({ [ROOM_INFO_BY_ROOM_URL]: () => ({ code: -412, message: '风控校验失败' }) })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    // 读不出来就说「这一轮没动手」，而不是猜一个「能发」。
    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'retry', code: '-412' })
    expect(outcome.detail).toContain('风控校验失败')
    expect(requestsTo(LIKE_REPORT_V3_URL)).toEqual([])
  })

  it('缺 CSRF cookie 时本地短路，一个请求都不发', async () => {
    const noCsrf = JSON.stringify({
      cookies: JSON.stringify({ SESSDATA: 'sessdata-value', DedeUserID: String(LIKER_UID) }),
      refreshToken: ''
    })

    const outcome = await runOne(ActionKey.LikeDanmaku, String(ROOM_ID), noCsrf)

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'account_stop', code: 'not_logged_in' })
    expect(outcome.detail).toContain('需要重新扫码绑定')
    expect(requests).toEqual([])
  })

  it('凭据里读不出当前账号身份时不动手', async () => {
    const noUid = JSON.stringify({
      cookies: JSON.stringify({ SESSDATA: 'sessdata-value', bili_jct: CSRF }),
      refreshToken: ''
    })

    const outcome = await runOne(ActionKey.LikeDanmaku, String(ROOM_ID), noUid)

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'account_stop', code: 'missing_uid' })
    expect(requests).toEqual([])
  })

  it('房间读失败时按重试分级，而不是把整轮结果抛出去', async () => {
    // `BiliHttp` 对网络、超时、非 2xx、形状不符都是抛，而一轮 reconcile 不该因为一次网关抖动就丢掉整轮
    // 结果（包括另一个动作已经做完的事）—— `probe`/`send` 对同一个抛是判 `retry`，`like.ts` 也明说
    // 传输层错误由调用方分级。
    withRoutes({ [ROOM_INFO_URL]: () => new Response('gateway boom', { status: 502 }) })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'retry', code: 'http_502' })
    expect(outcome.items).toHaveLength(1)
    expect(requestsTo(LIKE_REPORT_V3_URL)).toEqual([])
  })

  it('面板读失败时同样分级，一个点赞请求都不发', async () => {
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: () => new Response('gateway boom', { status: 502 }) })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'retry', code: 'http_502' })
    expect(outcome.detail).toContain('读取粉丝牌任务失败')
    expect(requestsTo(LIKE_REPORT_V3_URL)).toEqual([])
  })

  it('点赞本身抛在传输层时同样收成一条记录，而不是把整轮结果抛出去', async () => {
    // `like.ts` 故意不吞传输层错误（它自己写着「由调用方按 retry 分级」），而它被裸调在 `reconcile` 里、
    // `reconcile` 没有 try —— 一次抛出会带走整轮的结果（包括另一个动作已经做完的事），也不留一行 action_log。
    withRoutes({ [LIKE_REPORT_V3_URL]: () => new Response('gateway boom', { status: 502 }) })

    const outcome = await runOne(ActionKey.LikeDanmaku)

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'retry', code: 'http_502' })
    expect(outcome.detail).toContain('点赞失败')
  })

  it('目标不是直播间号时停手，一个请求都不发', async () => {
    const outcome = await runOne(ActionKey.LikeDanmaku, 'yyf')

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'action_stop', code: 'bad_target', targetKey: 'yyf' })
    expect(requests).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * watch_live
 * ------------------------------------------------------------------ */

describe('watch_live', () => {
  /**
   * 这个 describe 把时钟拿在手里，因为**循环睡的是 `setTimeout`**（`watch-loop.ts` 的 `pause`），而 sweep
   * 自己一秒都不睡：它的契约是「启动、读一次、报告」，循环的拍子只有时钟被推着走时才会发生。只伪造
   * `setTimeout`/`clearTimeout` —— `Date` 保持真实，`AbortSignal.timeout` 也就还是真的超时。
   */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * 让循环自己的 promise 链跑到下一个 await。`setImmediate` 是真的（没被伪造），所以这不是在推进时钟，
   * 只是把替身 fetch 那几层微任务走完。
   */
  async function letLoopRun(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  /** 把时钟推 `ms`，然后让被叫醒的那一段跑完。 */
  async function advanceLoop(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
    await letLoopRun()
  }

  /** 先让 sweep 启动一个循环并拍 `beats` 拍（`beatMsOf` 在 60 秒间隔下就是 60 秒一拍）。 */
  async function startLoopWith(beats: number): Promise<void> {
    const started = await runOne(ActionKey.WatchLive)
    expect(started).toMatchObject({ outcome: 'blocked', code: 'watch_in_progress' })
    for (let beat = 0; beat < beats; beat += 1) await advanceLoop(60_000)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(beats)
  }

  /**
   * 「循环该停」的那五个状态共用的形状：先有一个真在跑的循环，再让一次 sweep 撞上那个状态，最后确认循环
   * 已经不在了。
   *
   * 「不在了」只能从外面这样看：把时钟推十拍的长度，一个还在跑的循环会继续往下拍 —— 多拍几拍取决于状态
   * （面板与直播间是每三拍回读一次，所以四种状态它自己也会在三拍后发现，只有「任务表里没有这一项」它永远
   * 发现不了），因此这里的断言是心跳数**一个都不涨**。`discard` 只发出请求、不等它，能证明它到位的也只有
   * 这个。
   */
  async function stateStopsTheRunningLoop(routes: Readonly<Record<string, Route>>): Promise<ActionOutcome> {
    await startLoopWith(1)

    withRoutes(routes)
    const outcome = await runOne(ActionKey.WatchLive)

    const sent = requestsTo(LIVE_TRACE_HEARTBEAT_URL).length
    await advanceLoop(600_000)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(sent)

    return outcome
  }

  it('面板在 sweep 的回读里判定完成时报 already，并把在跑的循环停掉', async () => {
    // 判定完成的只有面板，而 sweep 每次自己也会读一次；这一条钉的是读数之外的那一半：面板说这一天够了，
    // 那个还在后台拍心跳的循环就必须当场被叫停（它自己也会在三拍后的回读里发现同一件事，但那是三分钟后，
    // 而 sweep 现在就知道）。
    const outcome = await stateStopsTheRunningLoop({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_AFTER_WATCH])
    })

    expect(outcome).toMatchObject({ outcome: 'already', failure: 'action_stop', code: 'watch_task_done' })
  })

  it('循环在跑时报 blocked + watch_in_progress，句子里是循环自己的拍数，这一轮不等它', async () => {
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE]) })

    const started = await runOne(ActionKey.WatchLive)

    // `blocked`（不是 done/already：那会把当天判成落定；也不是 failed：没有东西坏掉），而 `blocked` 正是
    // runner 不肯当作落定的那两个取值之一，所以下一轮 sweep 会接着看。
    expect(started).toMatchObject({ outcome: 'blocked', failure: 'none', code: 'watch_in_progress' })
    // 刚启动的那一段一拍都还没有：这个数字是循环自己的计数，不是 sweep 编的。
    expect(started.detail).toContain('0 拍')
    expect(started.items).toHaveLength(1)

    await advanceLoop(60_000)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toHaveLength(1)

    const observed = await runOne(ActionKey.WatchLive)

    // 同一个循环，它的拍数长了一拍：句子里的数字必须跟着长，因为那一句读的就是 `loop.beats`。
    expect(observed).toMatchObject({ outcome: 'blocked', failure: 'none', code: 'watch_in_progress' })
    expect(observed.detail).toContain('1 拍')
    expect(observed.detail).toContain('这一轮不等它')
  })

  it('循环卡在进场里时 sweep 照样立刻返回，同一个 key 也不会起第二个循环', async () => {
    withRoutes({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE]),
      // 进场永不落定：这一轮能返回，只可能是因为它没有等循环。`runner.ts` 用 `ticking` 守卫把任务串起来，
      // 在这里等一次，就是所有别的任务一起等 25 分钟。
      [LIVE_TRACE_ENTER_URL]: () => new Promise(() => {})
    })

    const first = await runOne(ActionKey.WatchLive)
    const second = await runOne(ActionKey.WatchLive)

    expect(first).toMatchObject({ outcome: 'blocked', code: 'watch_in_progress' })
    expect(second).toMatchObject({ outcome: 'blocked', code: 'watch_in_progress' })
    expect(second.detail).toContain('0 拍')
    // 一次进场：第二次 sweep 先问 `running(key)`，拿回的就是那一个循环，所以没有第二个。
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toHaveLength(1)
  })

  it('上一段循环放弃了自己：下一次 sweep 报出它的结局，报过就取走，再下一次另开一段', async () => {
    withRoutes({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE]),
      // 服务端把请求体回显回来的情况：`benchmark` 字段就是那一拍的会话密钥。
      [LIVE_TRACE_HEARTBEAT_URL]: () => ({
        code: -352,
        message: 'risk: benchmark=secret-key-from-server rejected'
      })
    })

    const started = await runOne(ActionKey.WatchLive)
    expect(started).toMatchObject({ outcome: 'blocked', code: 'watch_in_progress' })

    // 三拍都被拒、两次重进场之间的等待也都走完，循环就放弃了自己。sweep 从不等这件事发生：结局是它下一次
    // 读到时报出来的。
    await advanceLoop(240_000)
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toHaveLength(3)

    const reported = await runOne(ActionKey.WatchLive)

    // 被拒的码决定分级：`-352` 不是账号级，所以是 `retry`；而结局是循环自己的 `gave_up`，不是某个码。
    expect(reported).toMatchObject({ outcome: 'failed', failure: 'retry', code: 'watch_gave_up' })
    // 循环自己的理由是那句 detail，码照原样带在里面。
    expect(reported.detail).toContain('code -352')
    // 循环报出的每一段文本都经 `BiliHttp.redact` 抠过，所以会话密钥连进句子的机会都没有。
    expect(reported.detail).not.toContain('secret-key-from-server')
    expect(reported.detail).toContain('<redacted>')
    expect(JSON.stringify(reported)).not.toContain('secret-key-from-server')

    // `retire` 是取走：同一段结局不会被下一个 sweep 再说一遍（那句话里没有一个字是「放弃了」），
    // 它老老实实另开了一段。
    const after = await runOne(ActionKey.WatchLive)
    expect(after).toMatchObject({ outcome: 'blocked', code: 'watch_in_progress' })
    expect(after.detail).not.toContain('放弃')
    expect(after.detail).toContain('0 拍')
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toHaveLength(4)
  })

  /* 旧的「一个短片」契约里还有三条在**这条接缝上**没有对应物，所以删掉而不是改写：
   *   - 「服务端下发的间隔更短时，一个短片里放得下好几拍」；
   *   - 「服务端下发的间隔比短片还长时，等满一拍就收手（不能假装那段间隔已经过去）」；
   *   - 「服务端把间隔报到毫秒级时，短片按本地下限走，请求数不跟着那个数字放大」。
   * 三条断言的都是**短片自己的睡眠**（`sleptMs()` 与请求数），而 sweep 现在一秒都不睡：睡多久、本地下限与
   * 上限夹在哪里、`time` 写的就是真正睡过的那段，全是循环的事，`watch-loop.test.ts` 里那几条（`beatMsOf`
   * 的两条与「间隔 0.001 秒时按 1 秒睡」）就在钉它们。搬到这里只能是把循环的数当作 sweep 的数报出来 ——
   * 而「这一轮不等它」正是这个动作现在不做的事。 */

  it('进场用的是房间读回来的分区与主播 id，设备 cookie 从直播页接住', async () => {
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE]) })

    await runOne(ActionKey.WatchLive)
    await letLoopRun()

    const call = requestsTo(LIVE_TRACE_ENTER_URL)[0]
    if (call === undefined) throw new Error('没有发出进场请求')
    const body = bodyOf(call)

    // 进场序号是 0；分区那两个 id 来自 `Room/get_info`（本文件里唯一构造出来的房间响应）—— sweep 读它、
    // 再把它们交给循环，所以这一条同时钉住了「这两个 id 是哪里来的」。
    expect(body.get('id')).toBe(JSON.stringify([1, 283, 0, ROOM_ID]))
    expect(body.get('ruid')).toBe(String(ANCHOR_ID))

    const device = JSON.parse(body.get('device') ?? '[]') as unknown[]
    expect(device[0]).toBe(BUVID)
    // uuid 由注册表按（账号，直播间）记住，这里只要求形状是四段式；它必须同时出现在 device 里。
    expect(String(device[1])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    // 直播页只被访问一次，而且是为了那条 Set-Cookie。
    expect(requestsTo(LIVE_PAGE_URL)).toHaveLength(1)
  })

  it('凭据里已经有设备 cookie 时不再去访问直播页', async () => {
    const withBuvid = JSON.stringify({
      cookies: JSON.stringify({
        SESSDATA: 'sessdata-value',
        bili_jct: CSRF,
        DedeUserID: String(LIKER_UID),
        LIVE_BUVID: BUVID
      }),
      refreshToken: ''
    })
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE, TASKS_AFTER_WATCH]) })

    await runOne(ActionKey.WatchLive, String(ROOM_ID), withBuvid)

    expect(requestsTo(LIVE_PAGE_URL)).toEqual([])
  })

  it('任务已完成时不开会话，报 already', async () => {
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_AFTER_WATCH]) })

    const outcome = await runOne(ActionKey.WatchLive)

    expect(outcome).toMatchObject({ outcome: 'already', failure: 'action_stop', code: 'watch_task_done' })
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toEqual([])
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toEqual([])
    expect(sleptMs()).toEqual([])
  })

  it('牌子没点亮时连直播页都不问，报 blocked', async () => {
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: unlitPanel() })

    const outcome = await runOne(ActionKey.WatchLive)

    expect(outcome).toMatchObject({ outcome: 'blocked', failure: 'none', code: 'medal_not_lit' })
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toEqual([])
    expect(requestsTo(LIVE_PAGE_URL)).toEqual([])
  })

  it('任务表里没有观看这一项时不猜，报 failed', async () => {
    withRoutes({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE.filter(task => task.jump_type !== 'watchLive')])
    })

    const outcome = await runOne(ActionKey.WatchLive)

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'retry', code: 'watch_task_missing' })
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toEqual([])
  })

  it('房间响应里没有分区 id 时 fail-closed：会话建不起来就不动手', async () => {
    // 两个分区 id 是可选的（`types.ts`：三个消费者里两个根本不读它），所以缺口在这里判、在这里报，
    // 而不是在解析层把整个房间读打挂 —— 点赞那条链一点都不需要它们。
    const { parent_area_id: _parent, area_id: _area, ...withoutAreas } = ROOM_INFO_DATA
    void _parent
    void _area

    withRoutes({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE]),
      [ROOM_INFO_URL]: () => ({ code: 0, message: '0', data: withoutAreas })
    })

    const outcome = await runOne(ActionKey.WatchLive)

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'retry', code: 'watch_area_missing' })
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toEqual([])
    expect(requestsTo(LIVE_PAGE_URL)).toEqual([])
  })

  it('设备 cookie 拿不到时 fail-closed：不发一个用编造值签名的请求', async () => {
    withRoutes({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE]),
      [LIVE_PAGE_URL]: livePage(false)
    })

    const outcome = await runOne(ActionKey.WatchLive)

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'retry', code: 'no_buvid' })
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toEqual([])
    expect(requestsTo(LIVE_PAGE_URL)).toHaveLength(1)
  })

  it('直播页读失败时按传输层分级，不去开一个没有设备的会话', async () => {
    withRoutes({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE]),
      [LIVE_PAGE_URL]: () => new Response('gateway boom', { status: 502 })
    })

    const outcome = await runOne(ActionKey.WatchLive)

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'retry', code: 'http_502' })
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toEqual([])
  })

  it('心跳被拒 -101：同一个结局里码决定分级，这一次是账号级', async () => {
    withRoutes({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE]),
      [LIVE_TRACE_HEARTBEAT_URL]: () => ({ code: -101, message: '账号未登录' })
    })

    await runOne(ActionKey.WatchLive)
    await advanceLoop(60_000)

    const reported = await runOne(ActionKey.WatchLive)

    // `-101` 是登录态已失效：重进场没有用，所以循环当场以 `account_stop` 收场，而且不再发第二次进场。
    expect(reported).toMatchObject({ outcome: 'failed', failure: 'account_stop', code: '-101' })
    expect(reported.detail).toContain('重新扫码')
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toHaveLength(1)
  })

  it('心跳传输层失败按同一个上限计数，成为一句话里的 HTTP 502，而且网关回显的密钥被抹掉', async () => {
    withRoutes({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE]),
      // 网关把请求体回显出来的情况：`benchmark` 字段就是那一拍的会话密钥。
      [LIVE_TRACE_HEARTBEAT_URL]: () => new Response('bad gateway: benchmark=secret-key-from-server', { status: 502 })
    })

    await runOne(ActionKey.WatchLive)
    await advanceLoop(240_000)

    const reported = await runOne(ActionKey.WatchLive)

    // 这是这一版与「短片」契约分岔的地方，写下来免得下一次被当成漏掉的断言：结局的 `code` 是 sweep 自己的
    // `watch_gave_up`，循环遇见的那一次失败留在它自己的句子里（这里是 `BiliHttpError` 那句 HTTP 502）。
    expect(reported).toMatchObject({ outcome: 'failed', failure: 'retry', code: 'watch_gave_up' })
    expect(reported.detail).toContain('心跳失败')
    expect(reported.detail).toContain('HTTP 502')
    expect(reported.detail).not.toContain('secret-key-from-server')
    expect(reported.detail).toContain('<redacted>')
  })

  it('进场本身抛在传输层时同样收成一条记录，而且一个心跳都不发', async () => {
    withRoutes({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE]),
      // `enterLiveRoom` 也会抛（非 2xx、签不出的间隔），而这一条钉的是它没有把整轮结果带走。
      [LIVE_TRACE_ENTER_URL]: () => new Response('gateway boom', { status: 502 })
    })

    await runOne(ActionKey.WatchLive)
    // 三次进场都抛、两次重进场之间的等待都走完：放弃，而且一拍都没发出去。
    await advanceLoop(60_000)

    const reported = await runOne(ActionKey.WatchLive)

    expect(reported).toMatchObject({ outcome: 'failed', failure: 'retry', code: 'watch_gave_up' })
    expect(reported.detail).toContain('进场失败')
    expect(reported.detail).toContain('HTTP 502')
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toHaveLength(3)
    expect(requestsTo(LIVE_TRACE_HEARTBEAT_URL)).toEqual([])
  })

  /* 这里原来是「服务端把间隔报到毫秒级时，短片按本地下限走，请求数不跟着那个数字放大」。本地下限现在是
   * 循环的（`beatMsOf` 的 `WATCH_MIN_HEARTBEAT_MS`），钉它的是 `watch-loop.test.ts` 的
   * 「间隔 0.001 秒时按 1 秒睡，并且 time 写 1 而不是服务端的数字」；在这里留一条只会重复它。 */

  it('面板读被拒 -101 时按账号级处理，不开会话', async () => {
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: () => ({ code: -101, message: '账号未登录' }) })

    const outcome = await runOne(ActionKey.WatchLive)

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'account_stop', code: '-101' })
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toEqual([])
  })

  /* 下面四条是同一个形状的另一半：**这五种状态里每一种都不该继续拍心跳，所以每一种都要把在跑的循环停掉。**
   * 其中四种循环自己也会在三拍后的回读里发现（面板与直播间就是那时读的），但「任务表里没有这一项」它永远
   * 发现不了（`isTaskDone` 对缺失的那一行答「没做」，面板又是亮的、直播间又在播），那一种只有 sweep 能停。
   * 独立成例而不是合并在一条里，是因为「停掉」的断言（时钟推十拍、心跳数一个不涨）对每一种状态都要各自
   * 成立：漏掉其中一处 `discard`，红的只有对应的那一条。 */

  it('牌子没点亮时停掉在跑的循环，报 blocked + medal_not_lit', async () => {
    const outcome = await stateStopsTheRunningLoop({ [ACTIVATED_MEDAL_INFO_URL]: unlitPanel() })

    expect(outcome).toMatchObject({ outcome: 'blocked', failure: 'none', code: 'medal_not_lit' })
  })

  it('任务表里没有观看这一项时停掉循环，fail-closed 报 failed', async () => {
    const outcome = await stateStopsTheRunningLoop({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE.filter(task => task.jump_type !== 'watchLive')])
    })

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'retry', code: 'watch_task_missing' })
  })

  it('直播间不在开播时停掉循环，报 blocked + watch_room_offline', async () => {
    const outcome = await stateStopsTheRunningLoop({
      [ROOM_INFO_URL]: () => ({ code: 0, message: '0', data: { ...ROOM_INFO_DATA, live_status: 0 } })
    })

    expect(outcome).toMatchObject({ outcome: 'blocked', failure: 'none', code: 'watch_room_offline' })
  })

  it('面板读被拒 -101 时停掉在跑的循环，按账号级处理', async () => {
    const outcome = await stateStopsTheRunningLoop({
      [ACTIVATED_MEDAL_INFO_URL]: () => ({ code: -101, message: '账号未登录' })
    })

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'account_stop', code: '-101' })
    expect(requestsTo(LIVE_TRACE_ENTER_URL)).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * 记录与它的 items
 * ------------------------------------------------------------------ */

describe('每条记录都被自己的 item 认得出', () => {
  /**
   * 一条关系断言，而不是逐例断言，因为要排除的失败是**安静**的：一个 `done` 的 item 待在一个
   * `failed` 的记录里，在界面上读起来就是「做成了」。检查是单向的：记录可以比它的 item 更糟
   * （一个账号级失败压过别处的成功），但记录自己的判决必须是它的 item 也认得的那个。
   *
   * `douyu-adapter.test.ts` 对斗鱼那五个动作立的是同一条不变量，这里照做。
   */
  async function expectItemsToAgree(enabled: readonly string[]): Promise<void> {
    const outcomes = await run(enabled)

    expect(outcomes.length).toBeGreaterThan(0)
    for (const outcome of outcomes) {
      expect(outcome.items.length).toBeGreaterThan(0)
      expect(outcome.items.map(item => item.outcome)).toContain(outcome.outcome)
      // 两个动作都挂在某一个直播间的粉丝牌上，所以 item 的 kind 是房间。
      expect(outcome.items[0]?.kind).toBe('room')
      expect(outcome.items[0]?.label).toBe(
        bilibiliPlatform.actions.find(action => action.key === outcome.actionKey)?.label
      )
      // 记录与它的第一条 item 说的是同一件事，包括 code。
      expect(outcome.items[0]).toMatchObject({
        outcome: outcome.outcome,
        detail: outcome.detail,
        code: outcome.code
      })
    }
  }

  it('两条动作都有活干时各说各的，item 与记录一致', async () => {
    withRoutes({
      [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE, TASKS_AFTER_LIKE, TASKS_AFTER_WATCH])
    })

    await expectItemsToAgree([ActionKey.LikeDanmaku, ActionKey.WatchLive])
  })

  it('两条动作都无事可做时一致', async () => {
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_AFTER_LIKE, TASKS_AFTER_WATCH]) })

    await expectItemsToAgree([ActionKey.LikeDanmaku, ActionKey.WatchLive])
  })

  it('点赞因计数没跟上而被搁下时也一致', async () => {
    // 新出口的 `blocked` 也要过同一条不变量：记录说 blocked，它的 item 必须也说 blocked，
    // 而且两句 detail 是同一句 —— 否则界面上会出现「记录说被搁下、行说做成了」。
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies([highLevelPanel(likeRow(0, false))]) })

    await expectItemsToAgree([ActionKey.LikeDanmaku])
  })

  it('会话已死时两条都一致', async () => {
    withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: () => ({ code: -101, message: '账号未登录' }) })

    await expectItemsToAgree([ActionKey.LikeDanmaku, ActionKey.WatchLive])
  })

  it('凭据读不出来时两条都一致', async () => {
    const outcomes = await run([ActionKey.LikeDanmaku, ActionKey.WatchLive], String(ROOM_ID), '{}')

    for (const outcome of outcomes) {
      expect(outcome.items.length).toBeGreaterThan(0)
      expect(outcome.items.map(item => item.outcome)).toContain(outcome.outcome)
    }
  })

  it('认不出来的 key 报 blocked，而且没有 item（label 不许是标识符）', async () => {
    const outcome = await runOne(ActionKey.Fishing)

    expect(outcome).toMatchObject({
      actionKey: ActionKey.Fishing,
      outcome: 'blocked',
      code: 'unknown_action',
      failure: 'none'
    })
    expect(outcome.items).toEqual([])
    // 这句话点的是那个 key 本身，因为除此之外没有别的东西可点 —— 斗鱼那边写的是同一句。
    expect(outcome.detail).toContain(ActionKey.Fishing)
  })
})

/* ------------------------------------------------------------------ *
 * 中文文案里不许出现标识符
 * ------------------------------------------------------------------ */

describe('界面读到的字', () => {
  /**
   * 主界面（今日动作那一段）渲染的是 item 的 label 与 detail，以及记录自己的 detail。标识符只许待在
   * `code` 里 —— 那是 UI 折叠起来的调试区才显示的东西。web 侧有一条按同样规则写的用例
   * （`web/tests/task-detail-items.test.ts`），钉的是渲染方；这里钉的是**生产方**：这些句子是适配器
   * 写出来的，所以中文文案里不带字段名、不带动作 key 这件事得在服务端就有保证。
   */
  const IDENTIFIERS = [
    'like_danmaku',
    'watch_live',
    'fishing',
    'jump_type',
    'watchLive',
    'sendDanmu',
    'is_done',
    'is_lighted',
    'sub_title',
    'add_text',
    'like_task_done',
    'like_limit_reached',
    'medal_not_lit',
    'like_unfinished',
    'watch_in_progress',
    'no_buvid',
    'missing_uid',
    'bad_target',
    'unknown_action'
  ]

  function textOf(outcome: ActionOutcome): string {
    return [outcome.detail, ...outcome.items.map(item => `${item.label} ${item.detail}`)].join(' ')
  }

  interface TextCase {
    readonly name: string
    readonly enabled: readonly string[]
    readonly targetKey?: string
    readonly install?: () => void
  }

  const cases: readonly TextCase[] = [
    {
      name: '点赞做完',
      enabled: [ActionKey.LikeDanmaku],
      install: (): void =>
        withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE, TASKS_AFTER_LIKE]) })
    },
    {
      name: '点赞已经完成',
      enabled: [ActionKey.LikeDanmaku],
      install: (): void => withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_AFTER_LIKE]) })
    },
    {
      name: '点赞上限已满',
      enabled: [ActionKey.LikeDanmaku],
      install: (): void =>
        withRoutes({
          [ACTIVATED_MEDAL_INFO_URL]: panelReplies([
            TASKS_BEFORE_LIKE.map(task => (task.jump_type === 'like' ? { ...task, sub_title: '每日上限 1/1' } : task))
          ])
        })
    },
    {
      name: '牌子没点亮',
      enabled: [ActionKey.LikeDanmaku, ActionKey.WatchLive],
      install: (): void => withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: unlitPanel() })
    },
    {
      name: '点赞计数没跟上',
      enabled: [ActionKey.LikeDanmaku],
      install: (): void => withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies([highLevelPanel(likeRow(0, false))]) })
    },
    {
      name: '观看做完',
      enabled: [ActionKey.WatchLive],
      install: (): void =>
        withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_BEFORE_LIKE, TASKS_AFTER_WATCH]) })
    },
    {
      name: '观看任务已完成',
      enabled: [ActionKey.WatchLive],
      install: (): void => withRoutes({ [ACTIVATED_MEDAL_INFO_URL]: panelReplies([TASKS_AFTER_WATCH]) })
    },
    {
      name: '目标不是房间号',
      enabled: [ActionKey.LikeDanmaku, ActionKey.WatchLive],
      targetKey: 'yyf'
    }
  ]

  /**
   * 唯一不在上面那份清单里的句子：**认不出的动作 key**。
   *
   * 它必须点名那个 key（判不出别的），也正因为它点不出别的，它才没有 item —— item 的 label 不许是
   * 标识符，而一个本实现叫不出名字的动作没有目录项可以取名字。斗鱼那边写的是同一句话、同一套理由，
   * 所以它单独一条断言，不进这条「中文里没有标识符」的规则。
   */
  it('每句话里都没有标识符，而 code 里带着它', async () => {
    for (const textCase of cases) {
      textCase.install?.()

      const outcomes = await run(textCase.enabled, textCase.targetKey ?? String(ROOM_ID))
      const text = outcomes.map(textOf).join(' ')

      for (const identifier of IDENTIFIERS) {
        expect(`${textCase.name}: ${text}`).not.toContain(identifier)
      }
      // 也就是说：人读到的是中文句子，而 `code` 是给调试区看的一个稳定标记 —— 它从不写中文。
      for (const outcome of outcomes) {
        expect(outcome.code).not.toBe('')
        expect(outcome.code).not.toMatch(/[\u4E00-\u9FFF]/)
      }
    }
  })
})
