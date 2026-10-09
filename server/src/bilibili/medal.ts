import { z } from 'zod'

import type { BiliHttp } from './http.js'
import { envelopedOptionalData } from './types.js'

/**
 * 粉丝牌的读侧：一枚牌子的任务面板 + 房间级点赞开关 + 账号自己的整份粉丝牌列表。
 *
 * 这个模块存在的理由是一条架构规则：**问平台还有什么没做，不在本地记账**。本地记账在这套
 * 接口下必然出错 —— 10 枚牌子各读一次 `GetActivatedMedalInfo`（2026-10-08，只读）显示同一条
 * 任务的日上限**逐牌子下发**：level 1 的牌子是 `like=0/1`，level 30 的是 `like=0/10`。
 * 社区那句「上限 10 / 每天最多 300 赞」在高等级牌子上是对的、在低等级牌子上是错的，
 * 所以上限只能读，本地不许存。
 *
 * 三条来自实测、且反直觉的事实，接线前必须知道：
 *
 *   1. **任务表由 `is_lighted` 门控，不是由开播门控。** level 30 那枚牌子所在房间
 *      `live_status = 0`（未开播）却仍有 5 条任务；7 枚未点亮的牌子只有 2 条，且 `sub_title`
 *      直接就是「仅点亮」。⇒ 未点亮的牌子点赞**不计亲密度**，这是一条此前完全没有的前置依赖。
 *   2. **「点赞30次」是每轮批量，不是日上限。** 批量从 `title` 解析（`parseTaskCount`），
 *      日上限从 `sub_title` 的 `n/m` 解析（`parseTaskProgress`），两者都逐牌子下发；一轮发完
 *      要**再读一次**才知道有没有做完（上限 10 的牌子最多 10 轮）。
 *   3. **`sub_title` 的分子是「今日已领取的轮数」，不是点赞次数。** 没有任何字段显示
 *      「已赞 n/30」这类部分进度，所以一次 `click_time=1` 是否被计入**不可判定**；要么按
 *      `title` 凑满一轮，要么不发，不存在「增量补齐」。
 *
 * 三个读端点，都是只读 GET，都不计入点赞预算：
 *
 *   - `GET https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=<R>`
 *     → `data.like_info_v3`，以及同级的 `data.module_control_infos.like_module`。
 *     **点赞状态没有独立端点**：`.../like_info_v3/like/get_room_like_status` 等五条路径实测
 *     全部 `HTTP 404`，真正的读侧是既有端点里的一个字段。这条 GET 不需要 WBI，也不需要 csrf。
 *   - `GET https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/GetActivatedMedalInfo`
 *     → `data.task_info`，以及 `data.is_lighted`。`target_id` 收的是**主播 uid**，
 *     `web_location = 444.260`，`csrf` 回显 `bili_jct`（与 BLTH `bili-api/index.ts:24-28` 同形）。
 *     本模块的读路径要给 csrf，所以调用方显式传进来 —— 不从这里猜、也不从 cookie 里偷。
 *   - `GET https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/panel?page=<n>&page_size=10`
 *     → **账号自己的整份粉丝牌列表，分页**。一行里同时带着这枚牌子的 `is_lighted` 和它那个房间的
 *     `living_status`，所以「哪些牌子熄灭了、其中哪些主播在播」是**一次读的两个答案**，不必逐房间去探
 *     （24 个房间逐个探就是一天几千个请求）。实测（2026-10-08，只读、两次独立全量分页）：
 *     `data.page_info.total_page = 3`，26 枚牌子分三页 —— **只读第一页就是漏读**，前面一轮研究正是
 *     这么漏掉后面两页的。这条 GET 不需要 csrf：`csrf` 只写给 `GetActivatedMedalInfo`。
 *
 * 只声明本模块真正消费的字段。`getInfoByRoom` 的 `data` 有上百个键、且随版本增删，声明得越多，
 * 无关的上游改动就越容易把整条读路径打挂；zod 会丢掉未声明的键，所以少声明在这里是**隔离**，
 * 不是遗漏。三个被刻意排除的字段，连同理由写在这里，免得后来人「补全」它们：
 *   - `module_control_infos.like_module`：它是房间页面的**模块显示开关**，与点赞能不能被服务端
 *     接受无关。实测反例：那次成功、并被结算 +1 亲密度的点赞，所在房间读回来正是
 *     `like_module = false`。所以它既不该进类型，更不该当闸门（`like.ts` 模块头有完整记录）。
 *   - `report_click_limit`（本次 15）：实测 `click_time=30` 在它等于 15 时被完整认账并结算
 *     +1 亲密度，所以它不是 `click_time` 的上限。声明它只会诱使后来人写出一个错误的截断。
 *   - `count_block`：与 `click_block` 并列出现，但语义没有确定，无依据可用。
 *
 * 超时：每个请求都走 `BiliHttp.request`，它自带一个 `AbortSignal.timeout(timeoutMs)`（`http.ts`），
 * 所以这里不自己造 controller、也没有需要和调用方 signal 组合的地方。
 */

/**
 * 房间级读侧。**不需要 WBI 也不需要 csrf —— 但需要客户端带上会话 cookie。**
 *
 * 「会话 cookie」是 2026-10-09 量到的集合，一次只送一组、同一房间 14709735：`buvid3` 单独送 → `-352`；
 * `SESSDATA` 单独送 → `-352`；`SESSDATA` + `bili_jct` → 也是 `-352`；`SESSDATA` + `bili_jct` +
 * `DedeUserID` → `code 0` 读到主播名 —— 而整只 jar（多一个 `buvid3`）在同一分钟里也回 `code 0`，所以那几次
 * 拒绝是 cookie 集合的事、不是风控。集合定义在 `credential.ts` 的 `credentialToSessionCookies`，客户端由
 * `bilibili/session.ts` 的 `sessionClientFor` 造，完整记录在 `live.ts` 的 `fetchAnchorName`。
 *
 * 模块头部那句「不需要 WBI，也不需要 csrf」是在**本模块这条带凭据的读路径**上量的（读侧客户端由
 * `clientFor` 造，jar 里带着绑定账号的 cookie），所以它推不出「匿名客户端也能读」。实测（2026-10-09，房间
 * 14709735）：无 cookie 时这个端点答 `code -352`、`data` 整个缺席，一个字段都读不到。
 */
export const ROOM_INFO_BY_ROOM_URL = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom'

/** 勋章级读侧（一枚牌子）。 */
export const ACTIVATED_MEDAL_INFO_URL =
  'https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/GetActivatedMedalInfo'

/** 账号级读侧（整份粉丝牌列表，分页）。 */
export const FANS_MEDAL_PANEL_URL = 'https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/panel'

/**
 * 一次问几页里的「几」。
 *
 * 实测抓到的那次请求就是 `page=1&page_size=10`，所以这里逐字照抄。它只决定一次问多少行，
 * **不**决定要读几页 —— 要读几页由每一页自己报的 `page_info.total_page` 说（见 `fetchMedalPanel`）。
 */
export const MEDAL_PANEL_PAGE_SIZE = 10

/**
 * 本实现愿意读的页数上限。
 *
 * **这不是平台事实**，主账号实测只有 3 页。写它的理由是这个循环的上界来自第三方给的数字：
 * 一个谎报的页数会把这个 sweep 拖在里面爬，而 sweep 是串行的（`runner.ts`）—— 一辆车占住了路，
 * 别的任务全在等。所以超出这个数就按「读不懂的形状」拒掉（解析处拒，见 `medalPanelPageSchema`），
 * 报一个重试，而不是去爬它。50 页 = 500 枚牌子，远在任何账号的规模之外。
 */
export const MAX_MEDAL_PANEL_PAGES = 50

/** `web_location`：BLTH 给这个端点用的值（`bili-api/index.ts:24-28` 的默认参数就是它）。 */
export const MEDAL_WEB_LOCATION = '444.260'

/**
 * `task_info[].jump_type` 的**全部实测取值**（2026-10-08，房间 22908869，5 条，顺序固定）。
 *
 * 只登记实测见过的取值。没见过的类型不在这里编，`findMedalTask` 也就查不到它 —— 那正是
 * 想要的：查不到会走到闸门的 `unreadable`（判定所需的输入不存在），而不是被当成一条能做的任务。
 */
export const MedalJumpType = {
  /** 投喂粉丝灯牌 —— 收费（实测 `fans_club_gift_info.gift_id = 31164`）。 */
  FeedLight: 'feedLight',
  /** 观看直播满15分钟 —— 900 秒的心跳循环，见 `watch-live.ts`。 */
  WatchLive: 'watchLive',
  /** 投喂礼物 —— 收费，按量。 */
  SendGift: 'sendGift',
  /** 发弹幕 —— 项目已实现（`live.ts` 的 `sendDanmaku`）。 */
  SendDanmu: 'sendDanmu',
  /** 点赞30次 —— `like.ts`。 */
  Like: 'like'
} as const
export type MedalJumpType = (typeof MedalJumpType)[keyof typeof MedalJumpType]

/**
 * 一条任务。五个字段全部实测存在，`add_text` 也在内 —— 亲密度收益只写在这里（「亲密度+1」），
 * 项目里此前没有任何实现为它建模。
 *
 * `jump_type` 故意是 `z.string()` 而不是枚举：上游加一类任务时，查找查不到就好，不该把整块
 * 面板读挂。这就是 `types.ts` 说的「只声明消费的字段」在取值域上的同一件事。
 */
export const medalTaskSchema = z.object({
  title: z.string(),
  sub_title: z.string(),
  add_text: z.string(),
  jump_type: z.string(),
  is_done: z.boolean()
})
export type MedalTask = z.infer<typeof medalTaskSchema>

/** `GetActivatedMedalInfo` 的 `data`，只声明本模块消费的两个键。 */
export const activatedMedalDataSchema = z.object({
  /**
   * 牌子是否已点亮。它决定 `task_info` 里还有几条活的任务 —— 未点亮时点赞不计亲密度，
   * 所以这个布尔值不是一个装饰字段，而是闸门的输入。
   */
  is_lighted: z.boolean(),
  task_info: z.array(medalTaskSchema)
})
export type ActivatedMedal = z.infer<typeof activatedMedalDataSchema>
export const activatedMedalSchema = envelopedOptionalData(activatedMedalDataSchema)

/** `getInfoByRoom` 的 `data.like_info_v3`：房间级点赞状态。 */
export const likeInfoV3DataSchema = z.object({
  /**
   * 房间累计点赞数 —— 点赞唯一的 room 级回读路径，供展示。没有配对的 before 样本时**不要**
   * 声称增量：本次那个数（13298333）是两次点赞之后才取的。
   */
  total_likes: z.number(),
  /**
   * 语义**未经验证**：从未观测到 `true`（那次成功点赞时它是 `false`）。因此它不参与判定，
   * 只被记录下来交给调用方（`like.ts` 的 `LikeGate.clickBlock`）。
   */
  click_block: z.boolean(),
  /** 逐次点赞的服务端声明冷却，单位**秒**（实测 0.35）。点赞节奏的权威字段。 */
  cooldown: z.number()
})
export type LikeInfoV3 = z.infer<typeof likeInfoV3DataSchema>

/** `getInfoByRoom` 的 `data`，只声明点赞子系统里真正要用的那一个键（排除名单见模块头）。 */
export const roomInfoByRoomDataSchema = z.object({
  like_info_v3: likeInfoV3DataSchema
})
export type RoomLikeInfo = z.infer<typeof roomInfoByRoomDataSchema>
export const roomInfoByRoomSchema = envelopedOptionalData(roomInfoByRoomDataSchema)

/**
 * 一次读的两种结局。
 *
 * 业务拒绝（未登录、风控 `-412`、契约里没有 `data`）是**数据**，不是异常：调用方是闸门，
 * 它需要一条能上报的理由。传输层错误（网络、超时、非 2xx、形状不符）仍然由 `BiliHttp` 抛，
 * 与 `live.ts`、`like.ts` 一致 —— 那条路要按「重试」而不是「今天不做了」处理。
 *
 * 这条切法与 `platform/douyu/errors.ts` 的 `ErrorClassification` 是同一个想法（能重试的和
 * 不该重试的不能共用一条通道），只是那边有自己的码表，所以这里只是照那个精神写，不跨 seam 引用。
 */
export type BiliRead<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: number; readonly error: string }

/** 信封里本模块要读的四个字段。`catchall` 的索引签名让带额外键的响应也能直接传进来。 */
interface ReadEnvelope<T> {
  readonly code: number
  readonly message?: string | undefined
  readonly msg?: string | undefined
  readonly data?: T | undefined
  readonly [key: string]: unknown
}

/**
 * 信封 → `BiliRead`。
 *
 * `code: 0` 却缺 `data` 的第三种情况被单列出来：它是契约变了，不是业务拒绝，但也不能变成
 * 异常 —— 这条读路径是闸门的输入，抛出去只会把「不知道」伪装成「传输故障」。所以它是
 * `ok: false` 且理由写明缺的是什么。
 */
function unwrap<T>(response: ReadEnvelope<T>, what: string): BiliRead<T> {
  if (response.code !== 0) {
    return {
      ok: false,
      code: response.code,
      error: response.message ?? response.msg ?? `code ${String(response.code)}`
    }
  }
  if (response.data === undefined) return { ok: false, code: response.code, error: `${what}缺失` }
  return { ok: true, data: response.data }
}

/**
 * 读一个房间的点赞开关状态。
 *
 * 入参是**真实房间号**（长号），不是直播间 URL 里的短号 —— 先过 `resolveRoom`，与 `live.ts`
 * 的其它函数一致。
 */
export async function fetchRoomLikeInfo(http: BiliHttp, roomId: number): Promise<BiliRead<RoomLikeInfo>> {
  const response = await http.getJson(`${ROOM_INFO_BY_ROOM_URL}?room_id=${roomId}`, roomInfoByRoomSchema)
  return unwrap(response, 'getInfoByRoom 的 data')
}

/**
 * 读一块粉丝牌的任务面板。
 *
 * 返回的是**整个面板**（`task_info` 加上判定它是否有效所需的 `is_lighted`），而不是只把
 * 任务数组拆出来：实测显示任务表本身由 `is_lighted` 门控，把两者分开返回，就等于把一个
 * 事实劈成两半交给两个调用点，而它们迟早会不一致。
 *
 * `csrf` 是显式入参（`bili_jct` 的值）：这是读路径里唯一要凭据的地方，写在签名上比藏在
 * `http` 里更容易看出谁需要登录态。它只会进查询串，永远不进日志和错误信息。
 */
export async function fetchMedalTasks(
  http: BiliHttp,
  csrf: string,
  anchorId: number
): Promise<BiliRead<ActivatedMedal>> {
  // 参数顺序照抄实测抓到的那个请求：target_id, csrf, web_location。
  const query = new URLSearchParams({
    target_id: String(anchorId),
    csrf,
    web_location: MEDAL_WEB_LOCATION
  })
  const response = await http.getJson(`${ACTIVATED_MEDAL_INFO_URL}?${query.toString()}`, activatedMedalSchema)
  const result = unwrap(response, 'GetActivatedMedalInfo 的 data')
  // 拒绝文本有可能回显查询串，而查询串里有 csrf：上报之前把值抠掉。
  return result.ok ? result : { ...result, error: http.redact(result.error, [csrf]) }
}

/** 在 `task_info` 里找一条任务。找不到返回 `undefined` —— 不按名字模糊匹配，也不造一条。 */
export function findMedalTask(tasks: readonly MedalTask[], jumpType: MedalJumpType): MedalTask | undefined {
  return tasks.find(task => task.jump_type === jumpType)
}

/**
 * 服务端是否已把这条任务判为完成。
 *
 * 找不到这条任务时返回 `false`（当作「没做」）：这个谓词的调用方问的是「还要不要动手」，
 * 而回答「找不到但算你做完了」会静默停掉一整天的动作。要区分「没有这条任务」的调用方
 * 用 `findMedalTask` 自己拿 `undefined` —— 闸门就是这么做的。
 */
export function isTaskDone(tasks: readonly MedalTask[], jumpType: MedalJumpType): boolean {
  return findMedalTask(tasks, jumpType)?.is_done ?? false
}

/**
 * 从任务标题里解析每轮要做的次数：「点赞30次」→ 30，「发弹幕10次」→ 10。
 *
 * 单位必须是「次」：同一块面板里还有「观看直播满15分钟」，把它的 15 当成批量就是灾难。
 * 解析不出返回 `undefined` 而不是兜底值 —— 兜底会把「看不懂」变成「按我猜的发」，而实盘
 * 里一个多余的批量就是一次真实的点赞。
 */
export function parseTaskCount(title: string): number | undefined {
  const digits = /(\d+)\s*次/.exec(title)?.[1]
  return digits === undefined ? undefined : Number.parseInt(digits, 10)
}

/** 一条任务的进度。 */
export interface TaskProgress {
  /** 分子：**今日已领取的轮数**，不是点赞次数。 */
  readonly claimed: number
  /** 分母：这个牌子的日上限（逐牌子下发，不是常量）。 */
  readonly limit: number
}

/**
 * 从 `sub_title` 里解析进度：「每日上限 1/1」→ `{ claimed: 1, limit: 1 }`。
 *
 * 解析不出返回 `undefined`：未点亮的牌子这里写的是「仅点亮」，`sendGift` 那类写的是
 * 「+1亲密度/电池」（斜杠后不是数字，所以不会误配）。两种情况都不该被当成 0/0。
 */
export function parseTaskProgress(subTitle: string): TaskProgress | undefined {
  const match = /(\d+)\s*\/\s*(\d+)/.exec(subTitle)
  const claimed = match?.[1]
  const limit = match?.[2]
  if (claimed === undefined || limit === undefined) return undefined
  return { claimed: Number.parseInt(claimed, 10), limit: Number.parseInt(limit, 10) }
}

/* ------------------------------------------------------------------ *
 * 账号自己的整份粉丝牌列表（`fansMedal/panel`）
 * ------------------------------------------------------------------ */

/**
 * `fansMedal/panel` 的一行，只声明消费得上的四个字段。
 *
 * 多声明的代价与上面两个 schema 是同一条：无关的上游改动会变成整条读路径硬失败。而这里少声明的
 * 收益比别处更大 —— 一行的原始形状实测有二十一个键（`medal` 里十五个、`anchor_info` 三个、
 * `room_info` 三个），其中只有下面四个是判定要用的。
 */
export const medalPanelItemSchema = z.object({
  medal: z.object({
    /**
     * **主播 uid**，也正是一次点赞请求要的 `anchor_id`。
     *
     * 同一行里 `medal.uid` 是**持牌人**（实测 14004964），`medal.target_id` 才是主播（实测 5012449，
     * 与逐个房间读回来的 uid 一致）。这两个值写反不会报错，只会把点赞点到别人家去，所以写在这里。
     */
    target_id: z.number(),
    /**
     * 牌子是否点亮，**数字 0/1**。
     *
     * 同一个事实在 `GetActivatedMedalInfo` 里是布尔（实测 `"is_lighted": false`），两个端点两种编码
     * 都实测过，所以两处各按各的写法读，谁也不替谁猜。
     */
    is_lighted: z.number()
  }),
  /** 这一行的名字。`medal.target_name` 实测是空串，主播名只在这里有。 */
  anchor_info: z.object({ nick_name: z.string() }),
  /**
   * 房间号在 `room_info` 里，**不在 `medal` 里**。
   *
   * 这一条单独写下来，因为读错它的代价是**静默**的：前面一轮研究把路径写成 `item.medal.room_id`，
   * 于是拿到 24 个 `undefined`、24 个房间的存活探测被整体跳过，而那次输出里的
   * `room_info_code: -1` 是那个 bug，不是平台答案。
   */
  room_info: z.object({
    room_id: z.number(),
    /**
     * 房间的存活状态，与 `getInfoByRoom` 的 `room_info.live_status` **同编码**（实测 24/24 一致）。
     *
     * 有了它，「哪些牌子熄灭了」和「其中哪些主播在播」就是同一次读的两个答案，不必逐房间去探。
     * `isLive`（`live.ts`）是唯一决定 `2 = 轮播不算在播` 的地方，所以调用方拿它判，不在这里判。
     */
    living_status: z.number()
  })
})
export type MedalPanelItem = z.infer<typeof medalPanelItemSchema>

/** `fansMedal/panel` 的一页。 */
export const medalPanelPageSchema = envelopedOptionalData(
  z.object({
    list: z.array(medalPanelItemSchema),
    /**
     * 另一个数组，**必须一起读**：实测 26 枚牌子是 `special_list` 与 `list` 的并集。
     *
     * 声明成必填而不是可选，是刻意的。可选的意思是「这个键可以不在」，于是一份少了它的响应会安静地
     * 变短 —— 而这个读最贵的失败恰恰是**读短**（漏掉的那一枚可能就是唯一有活儿的一枚）。宁可读失败
     * （判重试，控制台上看得见）也不要读短。
     */
    special_list: z.array(medalPanelItemSchema),
    page_info: z.object({
      /**
       * 总页数，服务端自己说的。上限见 `MAX_MEDAL_PANEL_PAGES`：超出它就是读不懂的形状，在解析处拒掉。
       * 至少 1 页 —— 这个读永远从第 1 页开始，所以 0 是读不懂的答案，而不是「没有牌子」。
       */
      total_page: z.int().min(1).max(MAX_MEDAL_PANEL_PAGES)
    })
  })
)

/**
 * 读账号自己的整份粉丝牌列表，**分页读完**。
 *
 * 分页不是可选的：实测 26 枚牌子在 3 页上（`page_info.total_page = 3`），只读第一页会漏掉后面两页里
 * 所有的牌子 —— 前面一轮研究就是这么漏的。所以这里把服务端自己说的页数读完，并且按**更大的那个**
 * 数走：后一页报得比前一页多时听后一页的。两个方向的代价不对称 —— 少读一页是静默漏读，多读一页
 * 只是一个请求。
 *
 * **一页读不回来就让整次读失败，不留半份列表往下走。** 调用方拿这份列表判「还有没有熄灭的牌子」，
 * 而半份列表恰恰会让它得出「没有了」—— 那正是要防的错。所以第几页失败都是整次失败（判重试）。
 *
 * 返回的是整份列表，按 `target_id` 去重：牌子是逐个主播的，同一枚在两页里各出现一次（服务端忽略
 * `page` 时就是这样）不该变成两次点赞。`special_list` 排在 `list` 前面，只是为了让行的顺序稳定。
 */
export async function fetchMedalPanel(http: BiliHttp): Promise<BiliRead<readonly MedalPanelItem[]>> {
  const medals = new Map<number, MedalPanelItem>()
  // 第 1 页永远读；之后读几页由服务端在 `page_info.total_page` 里说，读完一页再看它有没有变大。
  let totalPage = 1

  for (let page = 1; page <= totalPage; page += 1) {
    const response = await http.getJson(
      `${FANS_MEDAL_PANEL_URL}?page=${String(page)}&page_size=${String(MEDAL_PANEL_PAGE_SIZE)}`,
      medalPanelPageSchema
    )
    const result = unwrap(response, 'fansMedal/panel 的 data')
    if (!result.ok) return result

    totalPage = Math.max(totalPage, result.data.page_info.total_page)

    for (const item of [...result.data.special_list, ...result.data.list]) {
      medals.set(item.medal.target_id, item)
    }
  }

  return { ok: true, data: [...medals.values()] }
}
