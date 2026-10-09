import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LIKE_INTERACT_URL, LIKE_REPORT_V3_URL } from '../src/bilibili/like.js'
import { MSG_SEND_URL } from '../src/bilibili/live.js'
import { FANS_MEDAL_PANEL_URL } from '../src/bilibili/medal.js'
import { bilibiliPlatform } from '../src/platform/bilibili/index.js'
import type { ActionItem, ActionOutcome, PlatformAccount, ReconcileContext } from '../src/platform/types.js'
import { ActionKey, TaskAction } from '../src/repo/tasks.js'

/**
 * 点亮粉丝牌（`relight_medal`）：读整份粉丝牌列表 → 挑出「熄灭且主播在播」的 → 一枚点一次赞 → 回读确认。
 *
 * 这个文件钉住四件不许自己发明的事：
 *
 *  1. **分页是必须的。** 夹具就是实测那次的分页形状（26 枚 = 10 + 10 + 6，`total_page: 3`），
 *     而且**把一枚有活儿的牌子放在第 3 页**：只读第一页的实现在这里必然红。
 *  2. **一次读同时给出三件事**（有哪些牌子、每枚的 `is_lighted`、每个房间的 `living_status`），
 *     所以整份文件里没有任何一次逐房间的存活探测：夹具里没有 `getInfoByRoom` 的路由，
 *     一旦有人去探，测试会因为「没有为这个请求准备响应」直接炸。
 *  3. **`code: 0` 不是证据。** 假服务端只有在**真的收到点赞**时才把牌子点亮，所以「回读确认」
 *     这条路径是真的被走了一遍 —— 假服务端的这个状态不是本实现的本地记账。
 *  4. **一个弹幕都不发。** 弹幕那条点亮路线是公开的，业主明令禁止；每个用例都断言
 *     `MSG_SEND_URL` 上一次请求都没有（包括点赞被拒、回读失败这些「看起来该回退」的时刻）。
 *
 * 夹具的来源与界限：`DARK_MEDALS` 的 24 行逐字来自实验记录的 §3.4 表（`target_id`、主播名、level、
 * `room_id`），行形状（`medal` 的十五个键、`anchor_info` 三个、`room_info` 三个）逐字来自 §2.5 抓到
 * 的 `data.list[0]`。**实测那一刻 24 个房间全部未开播**，所以假服务端的 `live` 默认是空集，
 * 每个用例自己把要用的主播放进「在播」—— 那是本文件的构造，不是抓包。
 * 两枚对照牌子（§2.2）的 `room_id` 记录里没有：冥驹那一枚用的是点赞实盘那个房间（22908869），
 * 炫妹x 那一枚是占位号，两行都注明了。
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

/** cookie 里的 `DedeUserID`：点赞请求的 `uid` 取它，不取账号行里的任何字段。 */
const LIKER_UID = 987_654
const CSRF = 'jct-value'

/** 一块牌子，按 §3.4 那张表逐字写下来（`live_status` 那一列实测全为 0，所以这里不记它）。 */
interface CapturedMedal {
  readonly targetId: number
  readonly name: string
  readonly level: number
  readonly roomId: number
}

/** 业主那一晚回读没确认的那一枚（§3.4 那张表的第 8 行）。 */
const BACK_2_THE_MOON: CapturedMedal = { targetId: 503_235_511, name: 'Back_2The_Moon', level: 8, roomId: 24_472_839 }

/** §3.4：24 枚熄灭的牌子，顺序也照那张表。 */
const DARK_MEDALS: readonly CapturedMedal[] = [
  { targetId: 5_012_449, name: '小圈宝', level: 21, roomId: 6_107_929 },
  { targetId: 277_376_718, name: 'Lov3camil1e', level: 14, roomId: 22_057_786 },
  { targetId: 8_599_153, name: '喵仙人ovo', level: 14, roomId: 238_736 },
  { targetId: 355_071_645, name: 'BLG_whzy', level: 11, roomId: 25_277_646 },
  { targetId: 191_205_009, name: '春日影゙', level: 10, roomId: 26_509_279 },
  BACK_2_THE_MOON,
  { targetId: 14_861_191, name: '电刑Valentine', level: 7, roomId: 1_225_000 },
  { targetId: 14_861_191, name: '电刑Valentine', level: 7, roomId: 1_225_000 },
  { targetId: 13_557_341, name: '黑灵灵灵灵', level: 7, roomId: 209_929 },
  { targetId: 867_152, name: '蕾蕾大表哥', level: 7, roomId: 81_414 },
  { targetId: 11_950_296, name: '孫燕姿歌迷', level: 7, roomId: 3_312_082 },
  { targetId: 393_241_505, name: '熊猫2_0', level: 6, roomId: 31_739_569 },
  { targetId: 1_995_880_259, name: '行离编辑部', level: 6, roomId: 24_566_452 },
  { targetId: 3_035_105, name: '奈姬niki', level: 5, roomId: 3_415_150 },
  { targetId: 41_425_554, name: '冷猫烤鱼', level: 5, roomId: 1_489_480 },
  { targetId: 56_407_990, name: '咕咕大魔王iii', level: 5, roomId: 1_979_734 },
  { targetId: 295_364_808, name: 'Aimware_Official', level: 5, roomId: 11_691_543 },
  { targetId: 3_546_667_255_073_341, name: '质疑声再大点窝听不见', level: 4, roomId: 32_679_937 },
  { targetId: 410_472_475, name: '不吃华莱', level: 4, roomId: 22_739_413 },
  { targetId: 152_372_895, name: '龙哥别别别', level: 3, roomId: 9_422_637 },
  { targetId: 122_879, name: '敖厂长', level: 3, roomId: 544_586 },
  { targetId: 186_331_790, name: '笨蛋劫', level: 2, roomId: 5_939_054 },
  { targetId: 3_546_596_518_136_538, name: '肉爪坨坨', level: 2, roomId: 31_584_553 },
  { targetId: 12_587_095, name: '红烧鱼香雷姆', level: 1, roomId: 870_426 },
  { targetId: 9_002_201, name: '2Dy神', level: 1, roomId: 8_402_575 }
]

/**
 * §2.2 的两枚**已点亮**对照面板。它们的 `room_id` 记录里没有：冥驹用的是点赞实盘那个房间
 * （`bili-live-like-live-test` 记的 22908869 / uid 2071691173），炫妹x 是**占位号**。
 */
const LIT_XIAOMEI: CapturedMedal = { targetId: 299_013_902, name: '炫妹x', level: 30, roomId: 1_000_001 }
const LIT_MINGJU: CapturedMedal = { targetId: 2_071_691_173, name: '冥驹', level: 1, roomId: 22_908_869 }

/** 实测的分页：26 枚 = 第 1 页 10 枚（`list`）+ 第 2 页 10 枚 + 第 3 页 4 枚 + 对照 2 枚（`special_list`）。 */
const DARK_PAGES = 3

/** 肉爪坨坨——刻意放在第 3 页上的那一枚，用来证明「只读第一页」过不了。 */
const THIRD_PAGE_TARGET = 3_546_596_518_136_538

/**
 * 假服务端的状态。
 *
 * **它是平台的状态，不是本实现的记账**：牌子只有在真的收到一次点赞请求之后才会变亮（见 `likeRoute`），
 * 所以「回读确认」在这份测试里是一条真的因果链，而不是把断言抄了两遍。
 */
interface FakeBili {
  /** 已点亮的 `target_id`。初值就是实测那一刻的两枚（§2.2 的对照面板）。 */
  readonly lit: Set<number>
  /** 主播在播的 `target_id`。实测那 25 分钟里 24 个房间全部未开播，所以默认是空集。 */
  readonly live: Set<number>
  /** 点赞认不认账：`false` 用来演「`code: 0` 但服务端没计入」。 */
  countsLikes: boolean
  /**
   * 「平台记下了、列表这一刻还没反映」—— **业主 2026-10-09 那一晚的形状**：19:42 发出的那一下点赞到
   * 19:47 那一轮才在列表里看得见（`原已点亮` 2 → 3）。
   *
   * 置上之后点赞进 `pending`，不碰 `lit`：`settleLikes()` 是那五分钟过去这件事，也就是「两个 sweep
   * 之间，平台把已经接受的写反映出来了」。它和 `countsLikes` 不同时用。
   */
  lagLikes: boolean
  /** 已接受、还没反映出来的那些 `target_id`。只有 `settleLikes()` 会把它们挪进 `lit`。 */
  readonly pending: Set<number>
}

function newFake(): FakeBili {
  return {
    lit: new Set([LIT_XIAOMEI.targetId, LIT_MINGJU.targetId]),
    live: new Set(),
    countsLikes: true,
    lagLikes: false,
    pending: new Set()
  }
}

/**
 * 平台把这段时间里接受的点赞反映出来 —— 两次运行之间过掉的那五分钟，不是本实现的一次本地记账。
 *
 * 它是测试这边的一个动作，因为真假在这里的分界正是**时间**：同一份列表读，早五分钟是熄灭、晚五分钟是
 * 点亮，而动作本身对这两次读说不出区别。业主那一晚就是这个差。
 */
function settleLikes(): void {
  for (const anchorId of server.pending) server.lit.add(anchorId)
  server.pending.clear()
}

/** 一行面板。未声明的键（`medal` 的另外十一个、`room_info.url`）留着，正是为了证明它们会被 zod 丢掉。 */
function panelRow(medal: CapturedMedal, server: FakeBili): unknown {
  return {
    medal: {
      uid: LIKER_UID,
      target_id: medal.targetId,
      target_name: '',
      medal_id: 419_588,
      level: medal.level,
      medal_name: medal.name,
      medal_color: 1_725_515,
      intimacy: 30,
      next_intimacy: 790,
      day_limit: 20_000,
      today_feed: 0,
      is_lighted: server.lit.has(medal.targetId) ? 1 : 0,
      guard_level: 0,
      wearing_status: 0,
      can_delete: true
    },
    anchor_info: { nick_name: medal.name, avatar: 'https://i1.hdslb.com/bfs/face/ce987bff...jpg', verify: -1 },
    room_info: {
      room_id: medal.roomId,
      living_status: server.live.has(medal.targetId) ? 1 : 0,
      url: `https://live.bilibili.com/${String(medal.roomId)}?broadcast_type=0&is_room_feed=1&live_from=28008`
    }
  }
}

/**
 * 一页的响应体。
 *
 * 夹具只有三页，多问一页直接抛：读过头必须当场炸，而不是拿到一份兜底内容继续走。
 */
function panelBody(page: number, server: FakeBili): unknown {
  const perPage = 10
  const start = (page - 1) * perPage
  const rows = page > DARK_PAGES ? [] : DARK_MEDALS.slice(start, start + perPage)
  if (rows.length === 0 && page !== DARK_PAGES) throw new Error(`夹具没有第 ${String(page)} 页`)

  return {
    code: 0,
    message: 'OK',
    ttl: 1,
    data: {
      list: rows.map(medal => panelRow(medal, server)),
      // 实测 26 枚是 `special_list` 与 `list` 的并集；哪一枚落在哪个数组里记录没有写，所以这里把两枚
      // 对照牌子放在 `special_list`、最后一页的 `list` 只放熄灭的那几枚 —— 于是「两个数组都要读」
      // 这件事本身也被钉住了。
      special_list: page === DARK_PAGES ? [panelRow(LIT_XIAOMEI, server), panelRow(LIT_MINGJU, server)] : [],
      page_info: { total_page: DARK_PAGES }
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

type Reply = unknown | Response
type Route = (request: CapturedRequest) => Reply

let requests: CapturedRequest[] = []
let logs: string[] = []
let server: FakeBili = newFake()

/**
 * 装上路由表。前缀匹配，**没有兜底回复**：最需要防的恰恰是「多发了一次请求」或「探了一个房间」，
 * 一个默认成功会把它们盖住。
 */
function serve(routes: Readonly<Record<string, Route>>): void {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const captured: CapturedRequest = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null
    }
    requests.push(captured)

    const key = Object.keys(routes).find(candidate => url.startsWith(candidate))
    if (key === undefined) throw new Error(`没有为这个请求准备响应：${url}`)

    const reply = routes[key]?.(captured)
    if (reply instanceof Response) return reply
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

/** 面板路由的几处「坏掉的方式」，每个用例只挑一个用。 */
interface PanelOptions {
  /** 第几次整份读（从 1 起）开始读不回来 —— 用来演「回读失败」。 */
  readonly failFromRead?: number
  /** 第几次整份读开始被服务端拒绝（业务码）—— 用来演「回读被拒」。 */
  readonly refuseFromRead?: number
  /** 第 1 次整份读里让这一页失败 —— 用来演「半份列表」。 */
  readonly failPage?: number
}

/** 面板：按 `page` 参数回放，并按「第几次整份读」算轮次（这个读一定从第 1 页起）。 */
function panelRoute(options: PanelOptions = {}): Route {
  let round = 0
  return request => {
    const page = Number(new URL(request.url).searchParams.get('page') ?? '')
    if (page === 1) round += 1
    if (options.failFromRead !== undefined && round >= options.failFromRead) {
      return new Response('gateway boom', { status: 502 })
    }
    if (options.refuseFromRead !== undefined && round >= options.refuseFromRead) {
      return { code: -101, message: '账号未登录' }
    }
    if (options.failPage === page && round === 1) {
      return new Response('gateway boom', { status: 502 })
    }
    return panelBody(page, server)
  }
}

const LIKE_OK = { code: 0, message: 'OK', ttl: 1, data: {} }

/**
 * 点赞：**服务端的状态唯一在这里改变**。认账就是把那枚牌子点亮；`countsLikes` 关掉时只回 `code: 0`
 * 而什么都不改 —— 那正是「`code: 0` 不是证据」这个用例要的形状；`lagLikes` 打开时记进 `pending`，
 * 也就是「记下了，但列表还没反映」。
 */
const likeRoute: Route = request => {
  const anchorId = Number(new URL(request.url).searchParams.get('anchor_id'))
  // `lagLikes` 优先：两者同时置上是本文件的构造错误，而「还没反映」是要演的那一个 —— 它比「当场认账」
  // 更接近真实的服务端，所以出问题时应该看见的是它那一侧的行为。
  if (server.lagLikes) server.pending.add(anchorId)
  else if (server.countsLikes) server.lit.add(anchorId)
  return LIKE_OK
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

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'

/** 常态路由表；用例只覆盖自己关心的那几条。 */
function withRoutes(overrides: Readonly<Record<string, Route>> = {}): void {
  serve({
    [FANS_MEDAL_PANEL_URL]: panelRoute(),
    [LIKE_REPORT_V3_URL]: likeRoute,
    [LIKE_INTERACT_URL]: () => ({ code: -400, message: '请求错误' }),
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

function accountOf(credentials: string = CREDENTIALS): PlatformAccount {
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

/**
 * 跑一次 reconcile。
 *
 * `targetKey` 默认是**空串**：这个动作是按账号的，它自己发现房间 —— 带房间的那条路径另有用例。
 */
async function runRelight(targetKey = '', credentials = CREDENTIALS): Promise<ActionOutcome> {
  const context: ReconcileContext = {
    account: accountOf(credentials),
    targetKey,
    enabledActions: [ActionKey.RelightMedal],
    // 点亮粉丝牌 reads no options; this is what an action with nothing set is handed.
    options: {},
    now: 1_791_434_562_000,
    dayKey: '2026-10-08',
    log: (line: string): void => {
      logs.push(line)
    }
  }

  const outcomes = await bilibiliPlatform.reconcile(context)
  const found = outcomes[0]
  if (found === undefined) throw new Error('reconcile 没有返回任何结果')
  return found
}

function requestsTo(urlPrefix: string): CapturedRequest[] {
  return requests.filter(request => request.url.startsWith(urlPrefix))
}

/** 面板请求的 `page` 参数，按顺序。分页读没读全靠它。 */
function pagesRead(): number[] {
  return requestsTo(FANS_MEDAL_PANEL_URL).map(request => Number(new URL(request.url).searchParams.get('page') ?? ''))
}

/** 某个房间上的点赞请求。 */
function likesForRoom(roomId: number): CapturedRequest[] {
  return requestsTo(LIKE_REPORT_V3_URL).filter(
    request => new URL(request.url).searchParams.get('room_id') === String(roomId)
  )
}

function itemOf(outcome: ActionOutcome, label: string): ActionItem {
  const found = outcome.items.find(item => item.label === label)
  if (found === undefined) throw new Error(`记录里没有「${label}」这一行：${JSON.stringify(outcome.items)}`)
  return found
}

/** 睡过的毫秒数，按顺序。回读前的那一次等待靠它断言。 */
function sleptMs(): number[] {
  return sleepMock.mock.calls.map(call => Number(call[0]))
}

beforeEach(() => {
  vi.clearAllMocks()
  requests = []
  logs = []
  server = newFake()
  sleepMock.mockImplementation(async () => undefined)
  vi.stubGlobal('fetch', fetchMock)
  withRoutes()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------ *
 * 目录项
 * ------------------------------------------------------------------ */

describe('点亮粉丝牌的目录项', () => {
  it('是一个账号级的 reconcile 动作，并且把弹幕那条路的代价写在人读得到的地方', () => {
    expect(ActionKey.RelightMedal).toBe('relight_medal')

    const descriptor = bilibiliPlatform.actions.find(action => action.key === ActionKey.RelightMedal)

    expect(descriptor).toMatchObject({
      action: TaskAction.Reconcile,
      label: '点亮粉丝牌',
      costly: false,
      // 24 枚牌子在 24 个房间，业主不要 24 个任务：房间由它自己读出来。
      needsTarget: false,
      needsLibrary: false,
      maxMessageLength: 0,
      defaultIntervalSeconds: 300,
      minIntervalSeconds: 60
    })

    // 四件事必须在人打开开关之前读到：它自己读列表、点赞看不见、点亮不给亲密度、以及那条公开路线的代价。
    expect(descriptor?.description).toContain('自己把整份粉丝牌列表读一遍')
    expect(descriptor?.description).toContain('不会被别人看见')
    expect(descriptor?.description).toContain('不产生亲密度')
    expect(descriptor?.description).toContain('10 条公开可见的弹幕')
    expect(descriptor?.description).toContain('不自动走那条路')
  })

  it('既有的两个亲密度动作一个字都没动', () => {
    // 这条断言是这道题的核心：熄灭牌子点赞**不产亲密度**这个判断是对的，所以它留在原处；
    // 点亮是**另一个目的**，走的是另一个动作。
    const like = bilibiliPlatform.actions.find(action => action.key === ActionKey.LikeDanmaku)
    const watch = bilibiliPlatform.actions.find(action => action.key === ActionKey.WatchLive)

    expect(like).toMatchObject({ needsTarget: true, label: '点赞' })
    expect(watch).toMatchObject({ needsTarget: true, label: '观看直播' })
    expect(bilibiliPlatform.actions.map(action => action.key)).toEqual([
      ActionKey.SendDanmaku,
      ActionKey.LikeDanmaku,
      ActionKey.WatchLive,
      ActionKey.RelightMedal
    ])
  })
})

/* ------------------------------------------------------------------ *
 * 读：分页 + 一次读给出存活
 * ------------------------------------------------------------------ */

describe('读整份粉丝牌列表', () => {
  it('三页全读，第 3 页上的牌子也照样动手', async () => {
    // 肉爪坨坨在第 3 页（§3.4 的倒数第三行）。只读第一页的实现拿不到它。
    server.live.add(THIRD_PAGE_TARGET)

    const outcome = await runRelight()

    // 读 → 动手 → 回读：第 3 页上那枚有活儿，所以整份列表要被读两次。
    expect(pagesRead()).toEqual([1, 2, 3, 1, 2, 3])
    for (const request of requestsTo(FANS_MEDAL_PANEL_URL)) {
      expect(request.method).toBe('GET')
      // 参数逐字照抄实测那次请求。
      expect(new URL(request.url).searchParams.get('page_size')).toBe('10')
    }

    expect(likesForRoom(31_584_553)).toHaveLength(1)
    expect(itemOf(outcome, '肉爪坨坨').outcome).toBe('done')
  })

  it('不逐房间探存活：整份列表里的 living_status 就是答案', async () => {
    // 夹具里没有逐房间读的路由，所以只要有人去探，这个用例会因为「没有为这个请求准备响应」炸掉。
    // 24 个房间逐个探就是一天几千个请求，而这一次读已经把答案带来了。
    server.live.add(5_012_449)

    await runRelight()

    expect(requestsTo('https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom')).toEqual([])
    expect(requestsTo('https://api.live.bilibili.com/room/v1/Room/get_info')).toEqual([])
  })

  it('一页读不回来就整轮不动手：半份列表不许当答案', async () => {
    // 这个动作唯一的完成判据是「没有熄灭的牌子了」，而半份列表恰恰会让人得出这个结论。
    server.live.add(5_012_449)
    withRoutes({ [FANS_MEDAL_PANEL_URL]: panelRoute({ failPage: 2 }) })

    const outcome = await runRelight()

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'retry', code: 'http_502' })
    expect(requestsTo(LIKE_REPORT_V3_URL)).toEqual([])
    // 一页读不回来就停在那里，不去读第 3 页。
    expect(pagesRead()).toEqual([1, 2])
  })
})

/* ------------------------------------------------------------------ *
 * 「没有一枚熄灭且主播在播」—— blocked，不是 skipped
 * ------------------------------------------------------------------ */

describe('没有可动手的牌子时', () => {
  it('实测那一刻：24 个房间全部未开播 → blocked，一个写请求都不发', async () => {
    // 假服务端的 `live` 是空的，就是实测那 25 分钟的样子。
    const outcome = await runRelight()

    // `blocked` 是 runner 不肯当作落定的两个取值之一，所以下一轮 sweep 会再来一次；`skipped` 会把当天
    // 判成完成，然后安静地错过每一个窗口（斗鱼那 546 鱼丸就是同一个坑）。
    expect(outcome).toMatchObject({
      outcome: 'blocked',
      failure: 'none',
      code: 'medal_room_offline',
      targetKey: ''
    })
    expect(requestsTo(LIKE_REPORT_V3_URL)).toEqual([])
    expect(requestsTo(MSG_SEND_URL)).toEqual([])
    // 没有可动手的就不回读、不等：第一次读就是答案。
    expect(pagesRead()).toEqual([1, 2, 3])
    expect(sleptMs()).toEqual([])

    // 一枚牌子一行，26 行：24 枚熄灭的等开播，2 枚对照本来就亮着。
    expect(outcome.items).toHaveLength(26)
    expect(outcome.items.every(item => item.kind === 'room')).toBe(true)
    expect(outcome.items.filter(item => item.outcome === 'blocked')).toHaveLength(24)
    // 那两枚「已点亮」来自第 3 页的 `special_list` —— 两个数组都读了才有它们。
    expect(outcome.items.filter(item => item.outcome === 'already').map(item => item.label)).toEqual(['炫妹x', '冥驹'])
    // 主播名在，标识符不在。
    expect(itemOf(outcome, '敖厂长').code).toBe('medal_room_offline')
    expect(outcome.detail).toContain('点亮 0')
    expect(outcome.detail).toContain('等开播 24')
    expect(outcome.detail).toContain('原已点亮 2')
    expect(outcome.detail).toContain('共 26 枚粉丝牌')
  })

  it('一枚牌子都没有时也是 blocked：两种读法分不开，就不落定', async () => {
    withRoutes({
      [FANS_MEDAL_PANEL_URL]: () => ({
        code: 0,
        message: 'OK',
        data: { list: [], special_list: [], page_info: { total_page: 1 } }
      })
    })

    const outcome = await runRelight()

    expect(outcome).toMatchObject({ outcome: 'blocked', failure: 'none', code: 'no_medals' })
    // 账号级的形状：这一轮连一枚牌子都还没读到，没有房间可以点。
    expect(outcome.items).toEqual([
      { kind: 'account', label: '点亮粉丝牌', outcome: 'blocked', detail: outcome.detail, code: 'no_medals' }
    ])
  })
})

/* ------------------------------------------------------------------ *
 * 点亮：一次点赞 + 回读确认
 * ------------------------------------------------------------------ */

describe('点亮', () => {
  it('一枚：一次 likeReportV3（click_time=30），回读确认之后才算亮', async () => {
    server.live.add(5_012_449)

    const outcome = await runRelight()

    const liked = likesForRoom(6_107_929)
    expect(liked).toHaveLength(1)
    expect(liked[0]?.method).toBe('POST')

    const params = new URL(liked[0]?.url ?? '').searchParams
    // 批量是 30：`like.ts` 的 `DEFAULT_CLICK_TIME`，也就是那个模块「拿不到任务标题」时的兜底。
    // 这里**不读、不存、也不猜任何日上限** —— 熄灭牌子的任务行根本没有 `n/m`。
    expect(params.get('click_time')).toBe('30')
    expect(params.get('anchor_id')).toBe('5012449')
    expect(params.get('uid')).toBe(String(LIKER_UID))

    // 读 → 动手 → 回读：两次整份读，各三页。
    expect(pagesRead()).toEqual([1, 2, 3, 1, 2, 3])
    // 回读之前等一次，而且是**一次**（24 枚一起点亮也只有一次，不是每枚一次）。
    expect(sleptMs()).toHaveLength(1)

    const row = itemOf(outcome, '小圈宝')
    expect(row).toMatchObject({ kind: 'room', outcome: 'done', code: '0' })
    // 点亮不计亲密度必须写在行里：熄灭牌子的两条任务 `add_text` 都是空的。
    expect(row.detail).toContain('不计亲密度')

    // 还有 23 枚在等开播，所以当天不落定 —— 点亮了一枚也不许报 done。
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'medal_room_offline' })
    expect(outcome.detail).toContain('点亮 1')
    expect(outcome.detail).toContain('等开播 23')
    expect(outcome.items.map(item => item.outcome)).toContain(outcome.outcome)
  })

  it('24 个房间全在播时一轮点亮全部，报 done（当天落定）', async () => {
    for (const medal of DARK_MEDALS) server.live.add(medal.targetId)

    const outcome = await runRelight()

    // 一枚一次请求：没有「补足剩余次数」的循环，也没有按上限算出来的轮数。
    expect(requestsTo(LIKE_REPORT_V3_URL)).toHaveLength(24)
    expect(pagesRead()).toEqual([1, 2, 3, 1, 2, 3])
    expect(sleptMs()).toHaveLength(1)

    expect(outcome).toMatchObject({ outcome: 'done', failure: 'none', code: '0' })
    // 记录自己那一行也说清「点亮不计亲密度」—— 那是很多人唯一会读的一行。
    expect(outcome.detail).toContain('点亮 24（不计亲密度）')
    expect(outcome.detail).toContain('原已点亮 2')
    expect(outcome.items.map(item => item.outcome)).toContain('done')
    // 每个房间各只被点一次。
    for (const medal of DARK_MEDALS) expect(likesForRoom(medal.roomId)).toHaveLength(1)
  })

  it('`code: 0` 不是证据：回读没反映过来时记「未确认」，不记点亮、也不记失败', async () => {
    server.live.add(5_012_449)
    server.countsLikes = false

    const outcome = await runRelight()

    expect(requestsTo(LIKE_REPORT_V3_URL)).toHaveLength(1)
    // 回读真的发生了（两次整份读）。
    expect(pagesRead()).toEqual([1, 2, 3, 1, 2, 3])

    // 「点赞被拒」和「平台还没反映」在**这一次**读里长得一模一样，所以这一轮不许挑一个来说：它只能说它
    // 读到的那件事。`blocked` 是这份记录里「不落定、下一轮再来」的那个取值 —— 当天没有被判成做完（那会
    // 把一枚熄着的牌子当成点亮），也没有被判成失败（那是业主那晚读到的、它没有挣到的那句话）。
    expect(outcome).toMatchObject({ outcome: 'blocked', failure: 'retry', code: 'medal_relight_unconfirmed' })
    const row = itemOf(outcome, '小圈宝')
    expect(row).toMatchObject({ outcome: 'blocked', code: 'medal_relight_unconfirmed' })
    expect(row.detail).toContain('仍是熄灭')
    // 未确认的那一枚单独数出来：它既不是「等开播」（那几枚一个请求都没发），也不是「点亮」。
    expect(outcome.detail).toContain('未确认 1')
    // 这一句点得出是哪一枚。
    expect(outcome.detail).toContain('「小圈宝」')
    expect(outcome.detail).not.toContain('失败')
    // 剩下那条路只被说出来，不被走。
    expect(logs.join('\n')).toContain('本动作不发')
    expect(requestsTo(MSG_SEND_URL)).toEqual([])
  })

  it('业主那一晚：第一次回读时平台还没反映，这一轮不许说「失败」，下一轮读到它已经亮着', async () => {
    // 2026-10-09 19:42:14 那一轮报的是「失败」，而 19:47:14 那一轮里「原已点亮」从 2 变成了 3 —— 那一下
    // 点赞是成的，所以前一轮报的是一个它没有挣到的失败（业主自己那句话：「估计是回读太快了」）。
    // 这个夹具就是那五分钟：平台记下了那次点赞，列表这一刻还没反映，`settleLikes()` 才反映出来。
    server.live.add(BACK_2_THE_MOON.targetId)
    server.lagLikes = true

    const first = await runRelight()

    expect(requestsTo(LIKE_REPORT_V3_URL)).toHaveLength(1)
    expect(pagesRead()).toEqual([1, 2, 3, 1, 2, 3])
    // 读两次、等一次，等的还是那 1 秒：这一轮没有为了让平台反映过来而把 sweep 堵在这里。
    expect(sleptMs()).toHaveLength(1)
    expect(first).toMatchObject({ outcome: 'blocked', code: 'medal_relight_unconfirmed', failure: 'retry' })
    expect(itemOf(first, 'Back_2The_Moon')).toMatchObject({
      outcome: 'blocked',
      code: 'medal_relight_unconfirmed'
    })
    // 这一句里的每一件都是这一轮读到过的东西：点赞发出去了、1 秒后的回读还是熄灭。
    expect(first.detail).toContain('1 秒后回读仍是熄灭')
    expect(first.detail).toContain('原已点亮 2')
    expect(first.detail).not.toContain('失败')

    // 五分钟后的下一轮：平台已经反映，那一枚第一次读就是亮着的 —— 业主看到的「原已点亮 3」。
    settleLikes()
    const second = await runRelight()

    // 没有第二次点赞：第一次那一下就把它点亮了，这一轮只是读到了它。
    expect(requestsTo(LIKE_REPORT_V3_URL)).toHaveLength(1)
    expect(sleptMs()).toHaveLength(1)
    expect(itemOf(second, 'Back_2The_Moon').outcome).toBe('already')
    expect(second).toMatchObject({ outcome: 'blocked', code: 'medal_room_offline', failure: 'none' })
    expect(second.detail).toContain('原已点亮 3')
    expect(second.detail).not.toContain('失败')
  })

  it('回读失败时也不许当成功：这一轮发出的点赞全部记为确认不了', async () => {
    server.live.add(5_012_449)
    withRoutes({ [FANS_MEDAL_PANEL_URL]: panelRoute({ failFromRead: 2 }) })

    const outcome = await runRelight()

    expect(requestsTo(LIKE_REPORT_V3_URL)).toHaveLength(1)
    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'retry', code: 'http_502' })

    const row = itemOf(outcome, '小圈宝')
    expect(row.outcome).toBe('failed')
    expect(row.code).toBe('http_502')
    // 这一枚的处境写清楚：点赞发出去了，是回读没读成 —— 于是它不能被算成点亮。
    expect(row.detail).toContain('点赞已发出')
    expect(row.detail).toContain('HTTP 502')
    expect(outcome.items.map(item => item.outcome)).toContain(outcome.outcome)
    // 这一次我们并不知道那些牌子还是不是熄灭，所以那句话不许说它们熄着。
    expect(logs.join('\n')).not.toContain('仍是熄灭')
  })

  it('回读被服务端拒绝 -101 时按账号级处理', async () => {
    server.live.add(5_012_449)
    withRoutes({ [FANS_MEDAL_PANEL_URL]: panelRoute({ refuseFromRead: 2 }) })

    const outcome = await runRelight()

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'account_stop', code: '-101' })
    expect(itemOf(outcome, '小圈宝').detail).toContain('回读失败')
    expect(requestsTo(MSG_SEND_URL)).toEqual([])
  })

  it('全部已点亮：报 already，只读一次、不等、不写', async () => {
    for (const medal of [...DARK_MEDALS, LIT_XIAOMEI, LIT_MINGJU]) server.lit.add(medal.targetId)

    const outcome = await runRelight()

    expect(outcome).toMatchObject({ outcome: 'already', failure: 'action_stop', code: 'medal_already_lit' })
    expect(pagesRead()).toEqual([1, 2, 3])
    expect(requestsTo(LIKE_REPORT_V3_URL)).toEqual([])
    expect(sleptMs()).toEqual([])
    expect(outcome.items).toHaveLength(26)
    expect(outcome.items.every(item => item.outcome === 'already')).toBe(true)
    expect(outcome.detail).toContain('原已点亮 26')
  })
})

/* ------------------------------------------------------------------ *
 * 拒绝与凭据
 * ------------------------------------------------------------------ */

describe('拒绝与凭据', () => {
  it('两个点赞端点的码都照原样带出，csrf 被抹掉，而且一个弹幕都不发', async () => {
    server.live.add(5_012_449)
    withRoutes({
      // 服务端把查询串回显出来的情况：那条串里带着 csrf。
      [LIKE_REPORT_V3_URL]: () => ({ code: -352, msg: `风险校验失败：query csrf=${CSRF} rejected` })
    })

    const outcome = await runRelight()

    // A 失败后 `likeWithFallback` 会去打 B：取舍写在 `like.ts` 的模块头里。
    expect(requestsTo(LIKE_INTERACT_URL)).toHaveLength(1)
    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'retry', code: '-400' })

    const row = itemOf(outcome, '小圈宝')
    expect(row.detail).toContain('风险校验失败')
    expect(row.detail).not.toContain(CSRF)
    expect(row.detail).toContain('<redacted>')

    // 「回退」在这个动作里只有一个意思：点赞的两个端点。弹幕那条路是公开的，不是回退。
    expect(requestsTo(MSG_SEND_URL)).toEqual([])
    expect(logs.join('\n')).toContain('本动作不发')
  })

  it('-101 是账号级：停住这个账号，而不是重试', async () => {
    server.live.add(5_012_449)
    withRoutes({ [LIKE_REPORT_V3_URL]: () => ({ code: -101, message: '账号未登录' }) })

    const outcome = await runRelight()

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'account_stop', code: '-101' })
    expect(itemOf(outcome, '小圈宝').outcome).toBe('failed')
  })

  it('凭据里没有 CSRF 而确有牌子要点亮时不动手 —— 读照做，写一个都不发', async () => {
    server.live.add(5_012_449)
    const noCsrf = JSON.stringify({
      cookies: JSON.stringify({ SESSDATA: 'sessdata-value', DedeUserID: String(LIKER_UID) }),
      refreshToken: ''
    })

    const outcome = await runRelight('', noCsrf)

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'account_stop', code: 'not_logged_in' })
    expect(requestsTo(LIKE_REPORT_V3_URL)).toEqual([])
    // 与两个亲密度动作的顺序故意不同：这条动作的读本身是有意义的（「今天没活儿」就是这么读出来的），
    // 所以写的前提在「确实有活儿要干」的那一刻才判，而读已经做完了。
    expect(pagesRead()).toEqual([1, 2, 3])
    expect(logs.join('\n')).toContain('没有写请求所需的 CSRF cookie')
  })

  it('凭据读不出来时按账号级处理，一个请求都不发', async () => {
    const outcome = await runRelight('', '{}')

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'account_stop', code: 'no_credential' })
    expect(outcome.items).toEqual([
      { kind: 'account', label: '点亮粉丝牌', outcome: 'failed', detail: outcome.detail, code: 'no_credential' }
    ])
    expect(requests).toEqual([])
  })

  it('列表读被拒 -101 时按账号级处理，一个点赞都不发', async () => {
    server.live.add(5_012_449)
    withRoutes({ [FANS_MEDAL_PANEL_URL]: () => ({ code: -101, message: '账号未登录' }) })

    const outcome = await runRelight()

    expect(outcome).toMatchObject({ outcome: 'failed', failure: 'account_stop', code: '-101' })
    expect(requestsTo(LIKE_REPORT_V3_URL)).toEqual([])
  })

  it('被带房间的任务叫起来时不重复点亮：这是账号级的动作', async () => {
    // `runner.ts` 把平台上所有启用中的 reconcile 键交给**每一个** reconcile 任务。这个动作自己发现
    // 房间，所以被一个带房间的任务叫起来时，它做的是账号任务那一遍的重复 —— 同一个活干两遍。
    server.live.add(5_012_449)

    const outcome = await runRelight('6107929')

    expect(outcome).toMatchObject({
      outcome: 'skipped',
      failure: 'action_stop',
      code: 'not_account_scoped',
      targetKey: ''
    })
    // 连列表都不读：这一轮不适用。
    expect(requests).toEqual([])
    expect(outcome.items).toHaveLength(1)
    expect(outcome.items[0]).toMatchObject({ kind: 'account', outcome: 'skipped' })
  })
})

/* ------------------------------------------------------------------ *
 * 记录与它的 items
 * ------------------------------------------------------------------ */

describe('每条记录都被自己的 item 认得出', () => {
  /**
   * 一条关系断言，而不是逐例断言，因为要排除的失败是安静的那种：一个 `done` 的 item 待在一个
   * `failed` 的记录里，在界面上读起来就是「做成了」。`douyu-adapter.test.ts` 与
   * `bilibili-reconcile.test.ts` 对各自的动作立的是同一条不变量，这里照做。
   */
  function expectItemsToAgree(outcome: ActionOutcome): void {
    expect(outcome.items.length).toBeGreaterThan(0)
    expect(outcome.items.map(item => item.outcome)).toContain(outcome.outcome)
    // 空 targetKey：这条动作是按账号的。
    expect(outcome.targetKey).toBe('')
    for (const item of outcome.items) {
      expect(item.code).not.toBe('')
      expect(item.detail).not.toBe('')
    }
  }

  it('一枚熄灭且主播在播、另有 23 枚等开播时一致', async () => {
    server.live.add(5_012_449)

    const outcome = await runRelight()

    expectItemsToAgree(outcome)
    // 每枚牌子的行都是房间级，名字是主播名（UI 文本），不是任何标识符。
    for (const item of outcome.items) {
      expect(item.kind).toBe('room')
      expect(item.label).not.toMatch(/^\d+$/)
    }
  })

  it('全部在播时一致', async () => {
    for (const medal of DARK_MEDALS) server.live.add(medal.targetId)

    expectItemsToAgree(await runRelight())
  })

  it('列表读失败时一致', async () => {
    withRoutes({ [FANS_MEDAL_PANEL_URL]: () => new Response('gateway boom', { status: 502 }) })

    expectItemsToAgree(await runRelight())
  })

  it('点赞发出、回读还没反映时一致', async () => {
    // 这个新状态（`blocked` + `medal_relight_unconfirmed`）也要满足那条不变量：记录说 `blocked`，
    // 它自己的行里就有一行是 `blocked`；否则界面上那一行读起来会像「做成了」。
    server.live.add(5_012_449)
    server.countsLikes = false

    expectItemsToAgree(await runRelight())
  })
})

/* ------------------------------------------------------------------ *
 * 中文文案里不许出现标识符
 * ------------------------------------------------------------------ */

describe('界面读到的字', () => {
  /**
   * 主界面渲染的是 item 的 label 与 detail，以及记录自己的 detail。标识符只许待在 `code` 里 ——
   * 那是 UI 折叠起来的调试区才显示的东西。`bilibili-reconcile.test.ts` 对两个亲密度动作钉的是同一条
   * 规则，这里钉的是这个动作。
   */
  const IDENTIFIERS = [
    'relight_medal',
    'is_lighted',
    'living_status',
    'room_info',
    'anchor_info',
    'medal_room_offline',
    'medal_already_lit',
    'medal_relight_unconfirmed',
    'no_medals',
    'not_account_scoped',
    'no_credential',
    'like_danmaku',
    'watch_live',
    'jump_type',
    'is_done',
    'sub_title',
    'add_text'
  ]

  function textOf(outcome: ActionOutcome): string {
    return [outcome.detail, ...outcome.items.map(item => `${item.label} ${item.detail}`)].join(' ')
  }

  it('每句话里都没有标识符，而 code 里带着它', async () => {
    const scenarios: readonly (() => Promise<ActionOutcome>)[] = [
      // 什么都没开播（实测那一刻）
      () => runRelight(),
      // 一枚点亮、其余等开播
      () => {
        server.live.add(5_012_449)
        return runRelight()
      },
      // 一枚点不亮（`code: 0` 但没被计入）
      () => {
        server.live.add(5_012_449)
        server.countsLikes = false
        return runRelight()
      },
      // 点赞被拒
      () => {
        server.live.add(5_012_449)
        withRoutes({ [LIKE_REPORT_V3_URL]: () => ({ code: -352, msg: '风控' }) })
        return runRelight()
      },
      // 全部已点亮
      () => {
        for (const medal of [...DARK_MEDALS, LIT_XIAOMEI, LIT_MINGJU]) server.lit.add(medal.targetId)
        return runRelight()
      },
      // 列表读失败
      () => {
        withRoutes({ [FANS_MEDAL_PANEL_URL]: () => new Response('gateway boom', { status: 502 }) })
        return runRelight()
      },
      // 带房间的任务叫起来
      () => runRelight('6107929')
    ]

    for (const scenario of scenarios) {
      const outcome = await scenario()
      const text = textOf(outcome)

      for (const identifier of IDENTIFIERS) {
        expect(text).not.toContain(identifier)
      }
      expect(outcome.code).not.toBe('')
      expect(outcome.code).not.toMatch(/[\u4E00-\u9FFF]/)
    }
  })
})
