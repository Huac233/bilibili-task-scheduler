import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BiliHttp, BROWSER_USER_AGENT, CookieJar } from '../src/bilibili/http.js'
import {
  type LikeGate,
  type LikeGateInput,
  LikeRefusal,
  LikeScheduleGuard,
  likeGate,
  preflightLike
} from '../src/bilibili/like.js'
import {
  ACTIVATED_MEDAL_INFO_URL,
  fetchMedalTasks,
  fetchRoomLikeInfo,
  findMedalTask,
  isTaskDone,
  MedalJumpType,
  type MedalTask,
  parseTaskCount,
  parseTaskProgress,
  ROOM_INFO_BY_ROOM_URL
} from '../src/bilibili/medal.js'
import {
  enterLiveRoom,
  LIVE_TRACE_ENTER_URL,
  LIVE_TRACE_HEARTBEAT_URL,
  sendLiveHeartbeat,
  type WatchSession
} from '../src/bilibili/watch-live.js'

/**
 * 亲密度任务读侧（`medal.ts`）、点赞闸门（`like.ts`）与观看心跳（`watch-live.ts`）的契约测试。
 *
 * 三个模块挤在一个文件里，是因为本轮只允许新建这一个测试文件；它们本来就是一条链
 * （读 → 判断 → 动手），放在一起也读得顺。
 *
 * **fixtures 的来源分两类，注释里逐个标注：**
 *   - 房间点赞开关与勋章任务面板：**实盘原样**（2026-10-08，房间 22908869，主播 uid
 *     2071691173，实盘笔记 `bili-live-like-live-test-2026-10-08.md`，不在本仓库内）。字段名、数字、
 *     中文文案都是照抄的，不是「我以为是这个形状」。
 *   - `x25Kn/E`、`x25Kn/X` 的响应：**没有实盘抓包**（笔记 §6.7 明说未实测），字段名取自参考
 *     实现的返回类型（`ref-bilibili-live-helper/src/api.ts:865-871`、`912-917`），取值是构造的。
 *     所以下面那两条 fixture 只能证明「我们发出去的字节与参考实现一致」，不能证明服务端认。
 *
 * 网络全部 mock：这一个文件里的任何一条断言都不该产生一次真实的点赞或心跳。
 */

const ROOM_ID = 22908869
const ANCHOR_ID = 2071691173
const CSRF = 'jct-value'
const BUVID = 'LIVE-BUVID-VALUE'
const UUID = '00000000-0000-4000-8000-000000000000'
/** 实盘用过的 `wts`（= 2026-10-08 04:41:17Z），拿来做确定性时钟。 */
const T0 = 1791434562000
const T1 = 1791434622000

/* ------------------------------------------------------------------ *
 * 实盘抓到的响应
 * ------------------------------------------------------------------ */

/**
 * `getInfoByRoom` 的 `data`，实盘原样。
 *
 * `module_control_infos`（那次是 `like_module = false`）、`new_switch_info`、`report_click_limit`
 * 这些未声明字段都在这里，正是为了证明「只声明消费的字段」是真的在隔离：它们必须被 zod 丢掉，
 * 而不是把这条读路径打挂或悄悄流进判定。
 */
const ROOM_DATA = {
  like_info_v3: {
    total_likes: 13298333,
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

/**
 * 一次 `click_time=30` 之后同一块面板的 `like` 条目：实盘回读的那一行
 * （`每日上限 1/1`、`is_done: true`），其余四条没变。
 */
const TASKS_AFTER_LIKE = TASKS_BEFORE_LIKE.map(task =>
  task.jump_type === 'like' ? { ...task, sub_title: '每日上限 1/1', is_done: true } : task
)

/** `data`：实盘回读到的完整面板（`intimacy` 等未声明字段也照抄进来）。 */
const MEDAL_DATA = { intimacy: 1, is_lighted: true, free_intimacy: 0, reach_free_intimacy_limit: false }

/** 未点亮的牌子：只有 2 条任务，`sub_title` 直接是「仅点亮」（本轮更正后的实测）。 */
const TASKS_NOT_LIT = [
  { title: '发弹幕', sub_title: '仅点亮', add_text: '亲密度+1', jump_type: 'sendDanmu', is_done: false },
  // title / add_text 在未点亮的面板里没有被记录到（只记到 sub_title 是「仅点亮」），这里沿用
  // 点亮面板里的同名取值；它们在未点亮的用例里不参与判定 —— 闸门在 is_lighted 就拒绝了。
  { title: '点赞30次', sub_title: '仅点亮', add_text: '亲密度+1', jump_type: 'like', is_done: false }
]

/**
 * 日上限逐牌子下发的证据：同一批面板里 level 30 的牌子是 `like=0/10`。
 * （本轮只读到 watchLive / sendDanmu / like 三行的进度，另外两条未记录，所以这里只有三条。）
 */
const TASKS_HIGH_LEVEL = [
  {
    title: '观看直播满15分钟',
    sub_title: '每日上限 0/10',
    add_text: '亲密度+1',
    jump_type: 'watchLive',
    is_done: false
  },
  { title: '发弹幕', sub_title: '每日上限 0/10', add_text: '亲密度+1', jump_type: 'sendDanmu', is_done: false },
  { title: '点赞30次', sub_title: '每日上限 0/10', add_text: '亲密度+1', jump_type: 'like', is_done: false }
]

/* ------------------------------------------------------------------ *
 * fetch 替身
 * ------------------------------------------------------------------ */

interface CapturedCall {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body: string | null
}

let calls: CapturedCall[] = []

/**
 * 按顺序回放响应：非 nav 的请求每来一个就取下一个。
 *
 * 队列空了就**抛**，不留「默认成功」的兜底：这一版新增的读路径最需要防的恰恰是「多发了一次
 * 请求」，一个默认成功会把它盖住。想验证 HTTP 失败时直接放一个 `Response` 进去。
 */
function installFetchMock(replies: readonly unknown[]): void {
  let index = 0

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null
    })

    const reply = replies[index++]
    if (reply === undefined) throw new Error(`没有为第 ${index} 个请求准备响应：${url}`)
    if (reply instanceof Response) return reply
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  })

  vi.stubGlobal('fetch', fetchMock)
}

function loggedInHttp(): BiliHttp {
  return new BiliHttp({ cookies: new CookieJar({ SESSDATA: 'sess-value', bili_jct: CSRF, DedeUserID: '100' }) })
}

function paramsOf(call: CapturedCall): URLSearchParams {
  return new URL(call.url).searchParams
}

/** 取第 n 个请求；少了就抛，别让断言对 `undefined` 生效。 */
function call(index = 0): CapturedCall {
  const found = calls[index]
  if (!found) throw new Error(`没有记录到第 ${index} 个请求`)
  return found
}

/** 放行分支的完整形状（含那个只作记录的 `clickBlock`），用 `Extract` 取出来给断言用。 */
type AllowedGate = Extract<LikeGate, { readonly allowed: true }>

/** 把闸门的两个分支收成一个值，省掉每条用例里重复的收窄。 */
function allowedOf(gate: LikeGate): AllowedGate {
  if (!gate.allowed) throw new Error(`该闸门应当放行，但它拒绝了：${gate.reason}（${gate.detail}）`)
  return gate
}

function refusalOf(gate: LikeGate): { readonly reason: LikeRefusal; readonly detail: string } {
  if (gate.allowed) throw new Error('该闸门应当拒绝，但它放行了')
  return gate
}

/** 一条可以做的点赞任务（实盘原样）。 */
const LIKE_TASK_BEFORE: MedalTask = {
  title: '点赞30次',
  sub_title: '每日上限 0/1',
  add_text: '亲密度+1',
  jump_type: 'like',
  is_done: false
}

function gateInput(overrides: Partial<LikeGateInput> = {}): LikeGateInput {
  return {
    clickBlock: false,
    lit: true,
    cooldownSeconds: 0.35,
    task: LIKE_TASK_BEFORE,
    ...overrides
  }
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------ *
 * medal.ts
 * ------------------------------------------------------------------ */

describe('fetchRoomLikeInfo', () => {
  it('走 getInfoByRoom 的 room_id 参数，只取点赞子系统里要用的字段', async () => {
    installFetchMock([{ code: 0, message: '0', data: ROOM_DATA }])

    const result = await fetchRoomLikeInfo(loggedInHttp(), ROOM_ID)

    expect(calls).toHaveLength(1)
    expect(call().url).toBe(`${ROOM_INFO_BY_ROOM_URL}?room_id=${ROOM_ID}`)
    expect(call().method).toBe('GET')

    if (!result.ok) throw new Error(`该读应当成功：${result.error}`)
    expect(result.data.like_info_v3).toEqual({ total_likes: 13298333, click_block: false, cooldown: 0.35 })
  })

  it('未声明的字段被丢掉：report_click_limit(15)、new_switch_info、module_control_infos 都不流进来', async () => {
    installFetchMock([{ code: 0, message: '0', data: ROOM_DATA }])

    const result = await fetchRoomLikeInfo(loggedInHttp(), ROOM_ID)
    if (!result.ok) throw new Error(`该读应当成功：${result.error}`)

    expect(result.data.like_info_v3).toEqual({ total_likes: 13298333, click_block: false, cooldown: 0.35 })
    // 这条断言是设计的一部分，不是形式：实测 click_time=30 在 report_click_limit=15 时被完整
    // 认账，所以它不该出现在类型里，免得后来人拿它去截断 `click_time`。
    expect('report_click_limit' in result.data.like_info_v3).toBe(false)
    expect('count_block' in result.data.like_info_v3).toBe(false)
    expect('new_switch_info' in result.data).toBe(false)
    // module_control_infos 也在这一列：它是页面模块显示开关，实测在它为 false 时点赞照样
    // 被结算，所以它既不该进类型，也不该当闸门。
    expect('module_control_infos' in result.data).toBe(false)
  })

  it('业务拒绝是数据而不是异常：带 -412 且没有 data 的响应也不抛', async () => {
    installFetchMock([{ code: -412, message: '风控校验失败' }])

    const result = await fetchRoomLikeInfo(loggedInHttp(), ROOM_ID)

    expect(result).toEqual({ ok: false, code: -412, error: '风控校验失败' })
  })

  it('code 0 但没有 data 时也只是 ok: false，且说明缺的是什么', async () => {
    installFetchMock([{ code: 0, message: '0' }])

    const result = await fetchRoomLikeInfo(loggedInHttp(), ROOM_ID)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('不该成功')
    expect(result.error).toContain('getInfoByRoom 的 data')
  })
})

describe('fetchMedalTasks', () => {
  it('target_id 收主播 uid，csrf / web_location 按实测顺序进查询串', async () => {
    installFetchMock([{ code: 0, message: '0', data: { ...MEDAL_DATA, task_info: TASKS_BEFORE_LIKE } }])

    await fetchMedalTasks(loggedInHttp(), CSRF, ANCHOR_ID)

    expect(calls).toHaveLength(1)
    expect(call().url.startsWith(`${ACTIVATED_MEDAL_INFO_URL}?`)).toBe(true)
    expect([...paramsOf(call()).keys()]).toEqual(['target_id', 'csrf', 'web_location'])
    expect(paramsOf(call()).get('target_id')).toBe(String(ANCHOR_ID))
    expect(paramsOf(call()).get('csrf')).toBe(CSRF)
    expect(paramsOf(call()).get('web_location')).toBe('444.260')
  })

  it('返回整块面板：五条实测任务与 is_lighted，收益在 add_text 里', async () => {
    installFetchMock([{ code: 0, message: '0', data: { ...MEDAL_DATA, task_info: TASKS_BEFORE_LIKE } }])

    const result = await fetchMedalTasks(loggedInHttp(), CSRF, ANCHOR_ID)
    if (!result.ok) throw new Error(`该读应当成功：${result.error}`)

    expect(result.data.is_lighted).toBe(true)
    expect(result.data.task_info).toHaveLength(5)
    expect(result.data.task_info.map(task => task.jump_type)).toEqual([
      'feedLight',
      'watchLive',
      'sendGift',
      'sendDanmu',
      'like'
    ])
    expect(findMedalTask(result.data.task_info, MedalJumpType.Like)).toEqual({
      title: '点赞30次',
      sub_title: '每日上限 0/1',
      add_text: '亲密度+1',
      jump_type: 'like',
      is_done: false
    })
    // intimacy 这些实盘字段故意没有进类型：没有消费者，声明它只会让上游的无关改动打挂这条读路径。
    expect('intimacy' in result.data).toBe(false)
  })

  it('回读：一次 click_time=30 之后 like 任务变成 1/1 且 is_done 为 true', async () => {
    installFetchMock([{ code: 0, message: '0', data: { ...MEDAL_DATA, task_info: TASKS_AFTER_LIKE } }])

    const result = await fetchMedalTasks(loggedInHttp(), CSRF, ANCHOR_ID)
    if (!result.ok) throw new Error(`该读应当成功：${result.error}`)

    expect(findMedalTask(result.data.task_info, MedalJumpType.Like)?.sub_title).toBe('每日上限 1/1')
    expect(isTaskDone(result.data.task_info, MedalJumpType.Like)).toBe(true)
  })

  it('未点亮的牌子只有两条任务，sub_title 直接是「仅点亮」', async () => {
    installFetchMock([{ code: 0, message: '0', data: { intimacy: 0, is_lighted: false, task_info: TASKS_NOT_LIT } }])

    const result = await fetchMedalTasks(loggedInHttp(), CSRF, ANCHOR_ID)
    if (!result.ok) throw new Error(`该读应当成功：${result.error}`)

    expect(result.data.is_lighted).toBe(false)
    expect(result.data.task_info).toHaveLength(2)
    expect(findMedalTask(result.data.task_info, MedalJumpType.Like)?.sub_title).toBe('仅点亮')
    // 未点亮时这个任务不算「完成」，所以真正的判据是 is_lighted，不是 is_done。
    expect(isTaskDone(result.data.task_info, MedalJumpType.Like)).toBe(false)
  })

  it('服务端拒绝文本里回显的 csrf 会被抹掉再交出来', async () => {
    installFetchMock([{ code: -352, message: `风险校验失败：query csrf=${CSRF} rejected` }])

    const result = await fetchMedalTasks(loggedInHttp(), CSRF, ANCHOR_ID)

    if (result.ok) throw new Error('不该成功')
    expect(result.error).not.toContain(CSRF)
    expect(result.error).toContain('<redacted>')
  })

  it('没有 data 的拒绝同样只是数据', async () => {
    installFetchMock([{ code: -101, message: '账号未登录' }])

    expect(await fetchMedalTasks(loggedInHttp(), CSRF, ANCHOR_ID)).toEqual({
      ok: false,
      code: -101,
      error: '账号未登录'
    })
  })
})

describe('任务表的语法解析', () => {
  it('parseTaskCount 只认「次」：分钟与没有数字的标题都返回 undefined', () => {
    expect(parseTaskCount('点赞30次')).toBe(30)
    expect(parseTaskCount('发弹幕10次')).toBe(10)
    // 「观看直播满15分钟」的 15 不是批量；把它当批量就是灾难。
    expect(parseTaskCount('观看直播满15分钟')).toBeUndefined()
    expect(parseTaskCount('投喂粉丝灯牌')).toBeUndefined()
  })

  it('parseTaskProgress 只认 n/m：「仅点亮」与「+1亲密度/电池」都不算进度', () => {
    expect(parseTaskProgress('每日上限 1/1')).toEqual({ claimed: 1, limit: 1 })
    expect(parseTaskProgress('每日上限 0/10')).toEqual({ claimed: 0, limit: 10 })
    expect(parseTaskProgress('仅点亮')).toBeUndefined()
    expect(parseTaskProgress('+1亲密度/电池')).toBeUndefined()
  })

  it('findMedalTask / isTaskDone 找不到那条任务时分别给 undefined 与 false', () => {
    // 一块没有 like 任务的面板：只剩发弹幕那一条。
    const tasks: readonly MedalTask[] = [
      { title: '发弹幕', sub_title: '仅点亮', add_text: '亲密度+1', jump_type: 'sendDanmu', is_done: false }
    ]

    expect(findMedalTask(tasks, MedalJumpType.Like)).toBeUndefined()
    // 「找不到」不是「做完了」：这里必须是 false，否则闸门会静默停掉一整天的动作。
    expect(isTaskDone(tasks, MedalJumpType.Like)).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * like.ts 的闸门
 * ------------------------------------------------------------------ */

describe('likeGate', () => {
  it('实盘房间 + 未完成的 0/1 任务：放行，批量与间隔都来自服务端', () => {
    const gate = allowedOf(likeGate(gateInput()))

    // 0.35 秒是房间自己声明的（服务端权威），它比本地下限大，所以用它。
    expect(gate.minIntervalMs).toBe(350)
    expect(gate.batchClicks).toBe(30)
    // 进度交出去的是服务端自己的两个原数，不是本地算好的差值：「还差 1 轮」这种话在 0/1 与
    // 9/10 上都成立，而这两件事对读的人完全不是一件事。
    expect(gate.claimed).toBe(0)
    expect(gate.limit).toBe(1)
    // 实盘读到的 click_block 是 false。它只是被带出来，不参与判定。
    expect(gate.clickBlock).toBe(false)
  })

  it('level 30 的牌子：上限 10 来自 sub_title，进度照原样带出', () => {
    const tasks: readonly MedalTask[] = TASKS_HIGH_LEVEL
    const gate = allowedOf(likeGate(gateInput({ task: findMedalTask(tasks, MedalJumpType.Like) })))

    expect(gate.claimed).toBe(0)
    expect(gate.limit).toBe(10)
    expect(gate.batchClicks).toBe(30)
  })

  it('已经领过的轮数照原样带出，不做减法', () => {
    // 2026-10-09 20:41 那次读回来的就是这一行：`每日上限 6/10`。句子要靠这两个数说清
    // 「发出去的已经超过它认账的速度」，所以它们必须是读数本身。
    const gate = allowedOf(likeGate(gateInput({ task: { ...LIKE_TASK_BEFORE, sub_title: '每日上限 6/10' } })))

    expect(gate.claimed).toBe(6)
    expect(gate.limit).toBe(10)
  })

  it('服务端报的 cooldown 更慢时以服务端为准，本地下限不覆盖它', () => {
    const gate = allowedOf(likeGate(gateInput({ cooldownSeconds: 2 })))

    expect(gate.minIntervalMs).toBe(2000)
  })

  it('服务端没报 cooldown（0）时用本地下限兜住', () => {
    const gate = allowedOf(likeGate(gateInput({ cooldownSeconds: 0 })))

    expect(gate.minIntervalMs).toBe(LikeScheduleGuard.MinIntervalFloorMs)
  })

  /**
   * `click_block` **不是**闸门：它从未被观测到 `true`，而凭一个从未出现过的字段拒绝，会让这个
   * 动作静默地整个不工作。所以 `true` 也必须放行，只把这个值交出去供上报。
   *
   * 这条用例就是那条降级的锚：将来若有人把它改回拒绝，它先红。
   */
  it('click_block = true 也放行，只把观测值交出来', () => {
    const gate = allowedOf(likeGate(gateInput({ clickBlock: true })))

    expect(gate.clickBlock).toBe(true)
  })

  /**
   * 每一条拒绝都要有独立、可上报的理由。这一条用例同时钉住「不是静默跳过」：`reason` 必须是
   * 那一个取值，且 `detail` 里说得出原因。
   *
   * 表里没有 `click_block`、没有 `like_module`、也没有「任务表里没有 like 任务」—— 前两个是
   * 不够格当闸门的字段，第三个从没被观测到，已并进 `unreadable`。理由见 `like.ts` 的模块头。
   */
  const refusals: [string, Partial<LikeGateInput>, LikeRefusal][] = [
    ['牌子未点亮', { lit: false }, LikeRefusal.MedalNotLit],
    ['任务已完成', { task: { ...LIKE_TASK_BEFORE, sub_title: '每日上限 1/1', is_done: true } }, LikeRefusal.TaskDone],
    [
      '已达今日上限（is_done 还是 false）',
      { task: { ...LIKE_TASK_BEFORE, sub_title: '每日上限 10/10' } },
      LikeRefusal.LimitReached
    ],
    ['任务表里没有 like 任务', { task: undefined }, LikeRefusal.Unreadable],
    ['牌子没下发 is_lighted', { lit: undefined }, LikeRefusal.Unreadable],
    ['cooldown 不是有效秒数', { cooldownSeconds: Number.NaN }, LikeRefusal.Unreadable],
    ['title 解析不出批量', { task: { ...LIKE_TASK_BEFORE, title: '点赞' } }, LikeRefusal.Unreadable],
    ['sub_title 解析不出进度', { task: { ...LIKE_TASK_BEFORE, sub_title: '未知' } }, LikeRefusal.Unreadable]
  ]

  it.each(refusals)('拒绝：%s', (_name, overrides, reason) => {
    const refusal = refusalOf(likeGate(gateInput(overrides)))

    expect(refusal.reason).toBe(reason)
    expect(refusal.detail.length).toBeGreaterThan(0)
  })

  it('拒绝理由表里没有那两条不够格的字段', () => {
    // 类型层面的保证（成员被删掉后下面两行根本编译不过）之外，再钉一次取值，免得有人晚些时候
    // 把它们作为字符串加回来。
    expect(Object.values(LikeRefusal)).not.toContain('click_blocked')
    expect(Object.values(LikeRefusal)).not.toContain('like_module_off')
    expect(Object.values(LikeRefusal)).not.toContain('like_task_missing')
  })
})

describe('preflightLike', () => {
  it('两个只读 GET（房间 → 勋章），说清楚该怎么发', async () => {
    installFetchMock([
      { code: 0, message: '0', data: ROOM_DATA },
      { code: 0, message: '0', data: { ...MEDAL_DATA, task_info: TASKS_BEFORE_LIKE } }
    ])

    const gate = allowedOf(await preflightLike(loggedInHttp(), { roomId: ROOM_ID, anchorId: ANCHOR_ID }))

    expect(gate.batchClicks).toBe(30)
    expect(gate.claimed).toBe(0)
    expect(gate.limit).toBe(1)
    expect(gate.minIntervalMs).toBe(350)
    expect(gate.clickBlock).toBe(false)

    expect(calls).toHaveLength(2)
    expect(call(0).url).toBe(`${ROOM_INFO_BY_ROOM_URL}?room_id=${ROOM_ID}`)
    expect(call(1).url.startsWith(ACTIVATED_MEDAL_INFO_URL)).toBe(true)
    // 房间那条 GET 不带任何凭据。
    expect(call(0).url).not.toContain(CSRF)
    expect(call(0).headers.get('cookie')).toContain('SESSDATA=sess-value')
  })

  /**
   * 实盘那个房间（`like_module = false`、`click_block = false`）**必须放行**：它正是我们唯一
   * 证明过点赞可用、且被结算 +1 亲密度的那一个。谁要是把 `like_module` 重新做成闸门，这条先红。
   */
  it('实盘抓到的那个房间（like_module = false）照旧放行', async () => {
    installFetchMock([
      { code: 0, message: '0', data: ROOM_DATA },
      { code: 0, message: '0', data: { ...MEDAL_DATA, task_info: TASKS_BEFORE_LIKE } }
    ])

    const gate = allowedOf(await preflightLike(loggedInHttp(), { roomId: ROOM_ID, anchorId: ANCHOR_ID }))

    expect(gate.batchClicks).toBe(30)
    expect(gate.clickBlock).toBe(false)
  })

  it('任务已完成时拒绝，且这一轮一个点赞请求都不发', async () => {
    installFetchMock([
      { code: 0, message: '0', data: ROOM_DATA },
      { code: 0, message: '0', data: { ...MEDAL_DATA, task_info: TASKS_AFTER_LIKE } }
    ])

    const refusal = refusalOf(await preflightLike(loggedInHttp(), { roomId: ROOM_ID, anchorId: ANCHOR_ID }))

    expect(refusal.reason).toBe(LikeRefusal.TaskDone)
    expect(calls).toHaveLength(2)
  })

  it('缺 bili_jct 时一个请求都不发，理由复用那一句话', async () => {
    installFetchMock([])
    const http = new BiliHttp({ cookies: new CookieJar({ SESSDATA: 'sess-value' }) })

    const refusal = refusalOf(await preflightLike(http, { roomId: ROOM_ID, anchorId: ANCHOR_ID }))

    expect(refusal.reason).toBe(LikeRefusal.NotLoggedIn)
    expect(refusal.detail).toBe('未登录：cookie 中缺少 bili_jct')
    expect(calls).toHaveLength(0)
  })

  it('房间读被拒时收成 unreadable，且不再去读勋章', async () => {
    installFetchMock([{ code: -412, message: '风控校验失败' }])

    const refusal = refusalOf(await preflightLike(loggedInHttp(), { roomId: ROOM_ID, anchorId: ANCHOR_ID }))

    expect(refusal.reason).toBe(LikeRefusal.Unreadable)
    expect(refusal.detail).toContain('风控校验失败')
    expect(calls).toHaveLength(1)
  })

  it('勋章读被拒时同样收成 unreadable', async () => {
    installFetchMock([
      { code: 0, message: '0', data: ROOM_DATA },
      { code: -352, msg: '风控校验失败' }
    ])

    const refusal = refusalOf(await preflightLike(loggedInHttp(), { roomId: ROOM_ID, anchorId: ANCHOR_ID }))

    expect(refusal.reason).toBe(LikeRefusal.Unreadable)
    expect(refusal.detail).toContain('风控校验失败')
  })

  it('传输层失败照旧抛，不伪装成一条已判定的拒绝', async () => {
    installFetchMock([new Response('gateway boom', { status: 502 })])

    await expect(preflightLike(loggedInHttp(), { roomId: ROOM_ID, anchorId: ANCHOR_ID })).rejects.toThrow(/HTTP 502/)
  })
})

/* ------------------------------------------------------------------ *
 * watch-live.ts
 * ------------------------------------------------------------------ */

/**
 * 进场与心跳的响应。**字段名**来自参考实现的返回类型，**取值**是构造的（这一条链路没有实盘
 * 抓包）。`secret_key` 刻意写成一眼能认出的字符串，好让「它有没有漏进错误信息」可断言。
 *
 * 两条 fixture 都带着 `patch_status` —— 参考实现的返回类型里有它，而 `watch-live.ts`
 * 故意没有声明它。这样这几条用例顺带证明了「未声明的键不会把进场打挂」。
 */
const ENTER_REPLY = {
  code: 0,
  message: '0',
  data: {
    timestamp: 1791434562,
    heartbeat_interval: 60,
    secret_key: 'secret-key-from-server',
    secret_rule: [0, 2],
    patch_status: 0
  }
}

const HEARTBEAT_REPLY = {
  code: 0,
  message: '0',
  data: {
    timestamp: 1791434622,
    heartbeat_interval: 60,
    secret_key: 'secret-key-rotated',
    secret_rule: [0, 2],
    patch_status: 0
  }
}

const enterOptions = { roomId: ROOM_ID, ruid: ANCHOR_ID, parentAreaId: 1, areaId: 283, buvid: BUVID, uuid: UUID }

async function enterOnce(): Promise<WatchSession> {
  const result = await enterLiveRoom(loggedInHttp(), enterOptions, T0)
  if (!result.ok) throw new Error(`进场应当成功：${result.error}`)
  return result.session
}

describe('enterLiveRoom', () => {
  it('三个 JSON 字符串字段与 ua 按参考实现发出去，会话里带的是服务端下发的值', async () => {
    installFetchMock([ENTER_REPLY])

    const session = await enterOnce()

    expect(calls).toHaveLength(1)
    expect(call().url).toBe(LIVE_TRACE_ENTER_URL)
    expect(call().method).toBe('POST')
    expect(call().headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(call().headers.get('referer')).toBe('https://www.bilibili.com/')

    const body = new URLSearchParams(call().body ?? '')
    expect([...body.keys()]).toEqual([
      'id',
      'device',
      'ruid',
      'ts',
      'is_patch',
      'heart_beat',
      'ua',
      'visit_id',
      'csrf',
      'csrf_token'
    ])
    // 进场用的序号是 0。
    expect(body.get('id')).toBe(JSON.stringify([1, 283, 0, ROOM_ID]))
    expect(body.get('device')).toBe(JSON.stringify([BUVID, UUID]))
    expect(body.get('ruid')).toBe(String(ANCHOR_ID))
    expect(body.get('ts')).toBe(String(T0))
    expect(body.get('is_patch')).toBe('0')
    expect(body.get('heart_beat')).toBe('[]')
    expect(body.get('visit_id')).toBe('')
    expect(body.get('csrf')).toBe(CSRF)
    expect(body.get('csrf_token')).toBe(CSRF)
    // 表单里的 ua 必须与请求头同一个值，否则两个字段会漂。
    expect(body.get('ua')).toBe(BROWSER_USER_AGENT)
    expect(call().headers.get('user-agent')).toBe(BROWSER_USER_AGENT)

    // 会话里的 secret/timestamp/interval 全部来自响应，没有一个是常量。
    expect(session.secretKey).toBe('secret-key-from-server')
    expect(session.secretRule).toEqual([0, 2])
    expect(session.timestamp).toBe(1791434562)
    expect(session.heartbeatInterval).toBe(60)
    // 交出去的是「第一拍要用的」序号。
    expect(session.sequence).toBe(1)
  })

  it('缺 bili_jct 时本地短路', async () => {
    installFetchMock([])
    const http = new BiliHttp({ cookies: new CookieJar({ SESSDATA: 'sess-value' }) })

    const result = await enterLiveRoom(http, enterOptions, T0)

    expect(result).toEqual({ ok: false, code: -101, error: '未登录：cookie 中缺少 bili_jct' })
    expect(calls).toHaveLength(0)
  })
})

describe('sendLiveHeartbeat', () => {
  it('s 是已知答案向量，ets / time / benchmark 取上一拍的会话值', async () => {
    installFetchMock([ENTER_REPLY, HEARTBEAT_REPLY])
    const session = await enterOnce()

    const result = await sendLiveHeartbeat(loggedInHttp(), session, T1)

    expect(calls).toHaveLength(2)
    expect(call(1).url).toBe(LIVE_TRACE_HEARTBEAT_URL)

    const body = new URLSearchParams(call(1).body ?? '')
    expect([...body.keys()]).toEqual([
      's',
      'id',
      'device',
      'ruid',
      'ets',
      'benchmark',
      'time',
      'ts',
      'ua',
      'visit_id',
      'csrf',
      'csrf_token'
    ])

    /**
     * 已知答案：对这段载荷依次做 HMAC-MD5、HMAC-SHA256（规则 [0, 2]），密钥是会话里的
     * `secret-key-from-server`。载荷是保序的 JSON，改一个字段或换一个顺序，这个值就不一样 ——
     * 这条断言是「签名输入正好是参考实现那十个字段、且顺序一致」的唯一离线证明。
     */
    expect(body.get('s')).toBe('23368191a8ccce2be4eeca0b4e1fa75e112b8b06131999f06223484787e5534e')
    expect(body.get('id')).toBe(JSON.stringify([1, 283, 1, ROOM_ID]))
    expect(body.get('ets')).toBe('1791434562')
    expect(body.get('time')).toBe('60')
    expect(body.get('benchmark')).toBe('secret-key-from-server')
    expect(body.get('ts')).toBe(String(T1))
    expect(body.get('ua')).toBe(call(1).headers.get('user-agent'))
    expect(body.get('csrf')).toBe(CSRF)

    if (!result.ok) throw new Error(`心跳应当成功：${result.error}`)
    // 下一拍用服务端**重新下发**的那一组，序号 +1。
    expect(result.session.sequence).toBe(2)
    expect(result.session.secretKey).toBe('secret-key-rotated')
    expect(result.session.timestamp).toBe(1791434622)
  })

  it('密钥轮换：第二拍用新的 secret 签名，不缓存旧值', async () => {
    installFetchMock([
      ENTER_REPLY,
      HEARTBEAT_REPLY,
      { ...HEARTBEAT_REPLY, data: { ...HEARTBEAT_REPLY.data, heartbeat_interval: 60 } }
    ])
    const first = await enterOnce()
    const second = await sendLiveHeartbeat(loggedInHttp(), first, T1)
    if (!second.ok) throw new Error(`第一拍心跳应当成功：${second.error}`)

    await sendLiveHeartbeat(loggedInHttp(), second.session, T1 + 60_000)

    const body = new URLSearchParams(call(2).body ?? '')
    expect(body.get('benchmark')).toBe('secret-key-rotated')
    expect(body.get('id')).toBe(JSON.stringify([1, 283, 2, ROOM_ID]))
    // 换了密钥，签名必然不同 —— 相同就说明第二拍还在用进场那一把。
    expect(body.get('s')).not.toBe('23368191a8ccce2be4eeca0b4e1fa75e112b8b06131999f06223484787e5534e')
  })

  it('服务端下发了不认识的签名规则时不发请求，而不是发一个签错的', async () => {
    installFetchMock([])
    const session: WatchSession = {
      ...enterOptions,
      sequence: 1,
      timestamp: 1791434562,
      heartbeatInterval: 60,
      secretKey: 'secret-key-from-server',
      secretRule: [7]
    }

    await expect(sendLiveHeartbeat(loggedInHttp(), session, T1)).rejects.toThrow(/签名规则 7/)
    expect(calls).toHaveLength(0)
  })

  it('进场响应带不认识的签名规则时同样在源头抛，不建立会话', async () => {
    installFetchMock([{ ...ENTER_REPLY, data: { ...ENTER_REPLY.data, secret_rule: [9] } }])

    await expect(enterLiveRoom(loggedInHttp(), enterOptions, T0)).rejects.toThrow(/签名规则 9/)
  })

  /**
   * 900 秒是任务要攒的时长，**不是**心跳间隔（这个数字在任务标题里：「观看直播满15分钟」）。
   * 一个 900 秒的间隔会被拿去睡觉，所以它必须被挡住。
   */
  it('心跳间隔超出可用范围时抛，不拿它去睡觉', async () => {
    installFetchMock([{ ...ENTER_REPLY, data: { ...ENTER_REPLY.data, heartbeat_interval: 900 } }])

    await expect(enterLiveRoom(loggedInHttp(), enterOptions, T0)).rejects.toThrow(/心跳间隔不可用/)
  })

  it('业务失败返回数据，error 只来自服务端，且不含 secret', async () => {
    installFetchMock([ENTER_REPLY, { code: -352, message: '风控校验失败' }])
    const session = await enterOnce()

    const result = await sendLiveHeartbeat(loggedInHttp(), session, T1)

    expect(result).toEqual({ ok: false, code: -352, error: '风控校验失败' })
    expect(JSON.stringify(result)).not.toContain(session.secretKey)
  })

  /**
   * 上面那条用例里的 `not.toContain(session.secretKey)` **是空断言**：注入的文案里本来就没有那个
   * 值，所以它在任何实现下都成立。这一条把它变成真的 —— 服务端把请求体原样回显回来，正是本文件
   * 开头那句「`secret_key` 刻意写成一眼能认出的字符串，好让『它有没有漏进错误信息』可断言」所指的
   * 形态，原先没有一条用例真去撞它。
   */
  it('服务端把请求体回显进拒绝文案时，心跳带出的值一个都不留', async () => {
    installFetchMock([
      ENTER_REPLY,
      {
        code: -352,
        message: `风控校验失败：benchmark=secret-key-from-server&device=["${BUVID}","${UUID}"]&csrf=${CSRF}`
      }
    ])
    const session = await enterOnce()

    const result = await sendLiveHeartbeat(loggedInHttp(), session, T1)

    if (result.ok) throw new Error('该拒绝不该报成功')
    expect(result.code).toBe(-352)
    // 人要看的那半句还在。
    expect(result.error).toContain('风控校验失败')
    expect(result.error).not.toContain(session.secretKey)
    expect(result.error).not.toContain(BUVID)
    expect(result.error).not.toContain(UUID)
    expect(result.error).not.toContain(CSRF)
    expect(result.error).toContain('<redacted>')
  })

  it('进场被拒时同样不带出 buvid、uuid 与 csrf', async () => {
    installFetchMock([
      {
        code: -352,
        message: `风控校验失败：device=["${BUVID}","${UUID}"]&csrf=${CSRF}&csrf_token=${CSRF}`
      }
    ])

    const result = await enterLiveRoom(loggedInHttp(), enterOptions, T0)

    if (result.ok) throw new Error('该拒绝不该报成功')
    expect(result.error).toContain('风控校验失败')
    expect(result.error).not.toContain(BUVID)
    expect(result.error).not.toContain(UUID)
    expect(result.error).not.toContain(CSRF)
    expect(result.error).toContain('<redacted>')
  })

  it('code 0 但没有 data 是契约变了，抛出来而不是静默给一半状态', async () => {
    installFetchMock([{ code: 0, message: '0' }])

    await expect(enterLiveRoom(loggedInHttp(), enterOptions, T0)).rejects.toThrow(/但没有 data/)
  })

  it('缺 bili_jct 时本地短路', async () => {
    installFetchMock([])
    const http = new BiliHttp({ cookies: new CookieJar({ SESSDATA: 'sess-value' }) })
    const session: WatchSession = {
      ...enterOptions,
      sequence: 1,
      timestamp: 1791434562,
      heartbeatInterval: 60,
      secretKey: 'secret-key-from-server',
      secretRule: [0]
    }

    const result = await sendLiveHeartbeat(http, session, T1)

    expect(result).toEqual({ ok: false, code: -101, error: '未登录：cookie 中缺少 bili_jct' })
    expect(calls).toHaveLength(0)
  })
})
