import type { BiliHttp } from './http.js'
import { DEFAULT_WEB_LOCATION, type WbiKeyStore } from './live.js'
import {
  fetchMedalTasks,
  fetchRoomLikeInfo,
  findMedalTask,
  MedalJumpType,
  type MedalTask,
  parseTaskCount,
  parseTaskProgress
} from './medal.js'
import { LikeCode, likeSchema, MISSING_CSRF } from './types.js'
import { encodeWbi } from './wbi.js'

/**
 * 直播间点赞 (like sending)。
 *
 * 两个端点，都能用，且都不在任何 API 文档里 —— BAC 的「直播间操作」章节一直是空
 * 占位符，实现只活在第三方工具里：
 *
 *   A. `POST https://api.live.bilibili.com/xlive/app-ucenter/v1/like_info_v3/like/likeReportV3`
 *      查询串带 `click_time` `room_id` `uid` `anchor_id` `web_location` `csrf`，整体
 *      经 WBI 签名（`w_rid`/`wts`），body 为空。
 *      —— ref-BLTH `src/library/bili-api/index.ts:79-93`
 *      特点：一次请求可以携带 `click_time` 次点赞。
 *
 *   B. `POST https://api.live.bilibili.com/xlive/web-ucenter/v1/interact/likeInteract`
 *      表单体 `roomid` `uid` `ts` `csrf` `csrf_token`，不需要 WBI。
 *      —— ref-bilibili-live-helper `src/api.ts:1001-1012`
 *      特点：一次请求只算一次点赞，要点 30 次就得循环 30 次。
 *
 * 两个实现都在业务失败时返回数据而不是抛异常；传输层错误（网络、超时、非 2xx、
 * 响应形状不符）仍然抛 `BiliHttpError`，与 `sendDanmaku` 保持一致。
 *
 * 原先写在这里的四条「未验证风险」，2026-10-08 的实盘（房间 22908869，主播 uid 2071691173，
 * 笔记 `bili-live-like-live-test-2026-10-08.md`，不在本仓库内）改了三条。别照旧代码的老话术复述：
 *
 *   1. `anti_token` —— **推翻**。端点 A 单独可用：两次调用全程没有任何 token 要求，
 *      响应是 `{"code":0,"message":"OK","ttl":1,"data":{}}`。那个说法只出自一处 TODO
 *      （`ref-bilibili-live-wheel-auto-follow` 里一个已被移除的占位按钮），实盘证据比它硬。
 *   2. B 的 `uid` 语义 —— **仍未验证，但已经不重要**。A 两次都成功，B 一次都没被调用过；
 *      后果见 `LikeInteractOptions`。
 *   3. `click_time=30` —— **成立**。一次请求携带 30 次点赞被完整认账：点赞任务的 `sub_title`
 *      由「每日上限 0/1」翻到「1/1」、`is_done` 翻 `true`、`intimacy` 1→2。
 *      这是回读确认的，不是靠 `code: 0`。
 *   4. B 出自 shallow clone（仅 30 个 commit）—— 仍未变，B 是否已废弃没有证据。
 *
 * 这一版新加的是**先读后写**。日上限与节奏都不是常量，全部逐牌子下发，所以发之前先问平台
 * （`preflightLike`），不在本地记账：
 *
 *   - 房间级开关：`GET /xlive/web-room/v1/index/getInfoByRoom` 的 `data.like_info_v3`
 *     与 `data.module_control_infos.like_module`；
 *   - 勋章级任务：`GetActivatedMedalInfo` 的 `data.task_info` 与 `data.is_lighted`。
 * 两个读端点都由 `medal.ts` 负责。
 *
 * 两个房间级字段**不是**闸门。写清楚，免得下一个人再把它们升格：
 *
 *   - `module_control_infos.like_module` 是房间页面的**模块显示开关**，与点赞能不能被服务端
 *     接受无关。实测反例很硬：那次成功、并被结算 +1 亲密度的点赞，所在房间读回来正是
 *     `like_module = false`。所以本模块不读它，也不因它拒绝 —— 凭它拒绝会让这个动作在**每个
 *     房间**都停住，包括我们唯一证明过它可用的那一个。
 *   - `like_info_v3.click_block` **从未被观测到 `true`**。它读起来像个闸门，但「读起来像」不是
 *     证据，而按未验证字段拒绝是**不安全**的那一侧：凭一个从未出现过的字段拒绝，会让整个动作
 *     静默不工作；一次真的被拒的点赞只花一个请求，而且带回的是我们确实读得懂的码。
 *     所以它只被**记录**并交给调用方（见 `LikeGate` 的 `clickBlock`），不参与判定。将来若观测到
 *     它与「服务端拒绝点赞」同时出现，那时再把它升格为闸门。
 *
 * 两道**不由本模块实现**的前置，接线的人要保证都满足，少一道就是白发：
 *
 *   - 「未点亮的牌子点赞不计亲密度」由 `data.is_lighted` 门控（未点亮的面板只剩「仅点亮」），
 *     本模块把它做成显式拒绝理由 `medal_not_lit`；
 *   - 「只在开播时点赞」是另一条独立前置，参考实现写得很直白：
 *     `if (action == "like" && room.Live_Status != 1) return sent;`
 *     （BLTH `LiveFansMedalTaskRunner.cs:185-186`）。它属于调度器的 `requireOnline`，本模块
 *     不去查直播状态 —— 但两道门禁都要过。
 *
 * 点赞不需要 WebSocket：WS 上的 `LIKE_INFO_V3_CLICK` / `LIKE_INFO_V3_UPDATE` 都是接收侧
 * 事件。
 */

/** A：likeReportV3，带 WBI，一次可携带 `click_time` 次点赞。 */
export const LIKE_REPORT_V3_URL = 'https://api.live.bilibili.com/xlive/app-ucenter/v1/like_info_v3/like/likeReportV3'

/** B：likeInteract，无 WBI，一次只算一次点赞。 */
export const LIKE_INTERACT_URL = 'https://api.live.bilibili.com/xlive/web-ucenter/v1/interact/likeInteract'

/**
 * 单次请求携带的点赞次数**兜底值**：30。
 *
 * 正式路径不用这个常量。每一轮该带多少次点赞，由任务表自己说：`task_info[].title` 是
 * 「点赞30次」，用 `parseTaskCount` 解析出来（`medal.ts`），把结果传进 `LikeOptions.clickTime`；
 * 这里只是「拿不到 title」时的兜底，形状与 BLTH `likeTask.ts:140` 的
 * `parseTitleCount(item.title) ?? 30` 一模一样。
 *
 * 30 也是唯一有实测依据的批量：一次 `click_time=30` 被服务端完整认账并结算 +1 亲密度。
 * 而原先写在这里的「每日点赞亲密度上限 10，即最多 300 赞」**不是常量，是逐牌子下发的**：
 * 同一批面板里 level 1 的牌子是 `like=0/1`、level 30 的是 `like=0/10`。要几轮由那个牌子的
 * `sub_title` 决定，所以本模块既存不下、也不该存。
 */
export const DEFAULT_CLICK_TIME = 30

/**
 * 本地要保留的东西，只剩两件 —— 而且这两件都不是「点赞策略」。
 *
 * 策略在服务端：逐次节奏是房间下发的 `like_info_v3.cooldown`，日额度是勋章任务
 * `task_info[like]` 的 `sub_title` 与 `is_done`（都由 `likeGate` 读）。这里留下的是
 * 「服务端没说」时兜底的下限，以及一个与点赞节流无关的本地时间闸门。
 *
 * 被换掉的两个猜测（都来自 BLTH，都被实盘推翻），写在名字旁边免得回来：
 *   - `MinIntervalMs = 15_000`：房间自己声明的是 `cooldown = 0.35` 秒，15 秒是它的约 40 倍。
 *     换成的 `MinIntervalFloorMs` 只是**下限**，有效间隔取 `max(cooldown * 1000, 350)` ——
 *     服务端报得更慢时以服务端为准。
 *   - `DailyLikeLimit = 5_000`：删掉。「今天还能点几轮」的权威是 `is_done` 与 `sub_title`，
 *     本地再存一个数就是同一个事实的第二个家，两边迟早不一致。
 */
export const LikeScheduleGuard = {
  /**
   * 相邻两次点赞请求的硬下限（毫秒）。
   *
   * 服务端权威字段是 `like_info_v3.cooldown`（实测 0.35 秒 = 350 毫秒），这里取的正是那个
   * 实测值，所以正常房间上它不会改变什么；当服务端报得比它更小（含 0）时，由它兜住。
   * 之所以还要留一个下限，是因为单房间每天那 1..10 轮请求一旦被写成一个紧循环，本地就没有
   * 任何东西挡得住 —— 而 `cooldown` 是一间房自己的声明，不是账号级的护栏。
   */
  MinIntervalFloorMs: 350,
  /** 跨天闸门：本地时间 23:55 之后停手。收益按自然日重置，跨日重复领取是纯浪费。 */
  CrossDayStopAt: '23:55',
  /** 跨天闸门的下界：00:05 之前也不发，见上。BLTH `MedalModule.ts:275-277`。 */
  CrossDayResumeAt: '00:05'
} as const

/** `likeRoom` 的入参。 */
export interface LikeOptions {
  /** 真实房间号（长号），不是直播间 URL 里的短号 —— 先过 `resolveRoom`。 */
  readonly roomId: number
  /**
   * 主播 uid。端点用 `anchor_id` 表达它，和点赞者 uid 是两个不同的值。
   * 调用方提供（粉丝勋章数据里的 `target_id`），这里不猜、也不从 cookie 推。
   */
  readonly anchorId: number
  /** 点赞者 uid —— 当前登录账号，由调用方提供（`GetMyMedals` / 粉丝勋章上下文里就有）。 */
  readonly uid: number
  /**
   * 这一轮携带的点赞次数。正式路径由 `likeGate` 从任务表的 `title` 解析后传进来
   * （`parseTaskCount`），不给时才退到 `DEFAULT_CLICK_TIME`。
   */
  readonly clickTime?: number
  /** WBI 签名覆盖的 `web_location`，默认与弹幕一致（`'444.8'`）。 */
  readonly webLocation?: string
}

/**
 * `likeInteract` 的入参。
 *
 * 与 `LikeOptions` 分开是刻意的：这个端点的请求体里**只有一个** id 字段（`uid`），
 * 没有 `anchor_id`，所以它表达不了一次请求两端。
 *
 * `uid` 的语义（点赞者还是主播）**仍然没有被验证**：唯一的参考实现往这个字段里放的是
 * 主播 uid（`likeLive.ts:29` 传 `medal.targetID`），而 2026-10-08 那次实盘两次都走了端点 A、
 * B 一次都没被调用，所以这个问题当场没能被回答。
 *
 * 它**不再是风险**，只是**遗留**：A 已足够，B 是回退路径，B 唯一被用到的场景是「A 单方面变化
 * 了」——到那时这个字段收哪个 id 才需要现查。所以这里保留原样（按调用方约定传点赞者 uid），
 * 而不是删掉或者猜一个：删掉会把一句「待确认」变成一句「没有疑问」，猜一个则会在回退路径
 * 真的被走到时静默地做错事。
 */
export interface LikeInteractOptions {
  /** 真实房间号（长号）。 */
  readonly roomId: number
  /** 点赞者 uid，语义存疑（见上）。 */
  readonly uid: number
}

export type LikeResult = { readonly ok: true } | { readonly ok: false; readonly code: number; readonly error: string }

/** 只看信封层：判定与日志只用到 `code` / `message`。 */
interface LikeEnvelope {
  readonly code: number
  readonly message?: string | undefined
  readonly msg?: string | undefined
}

/**
 * 把响应信封分类成 `LikeResult`，并在签名失败时让 WBI 键失效。
 *
 * `error` 优先取 `message`：两个参考实现都从 `message` 里取人类可读的原因
 * （BLTH `MedalModule.ts:328`、live-helper `api.ts:1011` 的 `assert`）。
 *
 * 取出来的那句话要先过 `http.redact`：端点 A 把 `csrf` 放进查询串、端点 B 把它放进请求体，
 * 而点赞被拒是服务端最可能把请求回显回来的场合 —— `medal.ts` 为同一条查询串早就这么做了，
 * 这条路上原先没有。
 */
function classify(http: BiliHttp, response: LikeEnvelope, wbi?: WbiKeyStore): LikeResult {
  if (response.code === LikeCode.Ok) return { ok: true }

  if (response.code === LikeCode.SignError) wbi?.invalidate()

  const detail = response.message ?? response.msg ?? `code ${String(response.code)}`
  return {
    ok: false,
    code: response.code,
    error: http.redact(detail)
  }
}

/**
 * 点赞（A：likeReportV3，带 WBI）。
 *
 * 请求形状照抄参考实现：参数进查询串（由 `encodeWbi` 负责签名与 `w_rid`/`wts`），
 * body 为空串，`Content-Type: application/x-www-form-urlencoded`。BLTH 的
 * `Request.post` 在 data 为 `null` 时发的正是 `''`，并带 `Origin`/`Referer`
 * = `https://live.bilibili.com`（`src/library/request/index.ts:72-81,96-100`）；
 * `Referer` 由 `BiliHttp` 默认给出，`Origin` 在这里显式补上。
 */
export async function likeRoom(http: BiliHttp, wbi: WbiKeyStore, options: LikeOptions): Promise<LikeResult> {
  const csrf = http.cookies.csrfToken
  if (!csrf) return MISSING_CSRF

  const keys = await wbi.get(http)
  // 参数顺序沿用参考实现：click_time, room_id, uid, anchor_id, web_location, csrf。
  // 签名覆盖排序后的参数，但请求带的是这个插入顺序（见 wbi.ts 的注释）。
  const query = encodeWbi(
    {
      click_time: options.clickTime ?? DEFAULT_CLICK_TIME,
      room_id: options.roomId,
      uid: options.uid,
      anchor_id: options.anchorId,
      web_location: options.webLocation ?? DEFAULT_WEB_LOCATION,
      csrf
    },
    keys
  )

  const response = await http.requestJson(`${LIKE_REPORT_V3_URL}?${query}`, likeSchema, {
    method: 'POST',
    body: '',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://live.bilibili.com'
    }
  })

  return classify(http, response, wbi)
}

/**
 * 点赞（B：likeInteract，无 WBI）。
 *
 * `ts` 是毫秒时间戳（参考实现传 `Date.now()`）。表单字段顺序也照抄参考实现。
 * `Referer` 覆盖成 `https://www.bilibili.com/` —— 这是 live-helper 为该端点显式设置的
 * 值（`api.ts:998`），与本项目默认的 `live.bilibili.com` 不同；没有别的证据说明该用
 * 哪个，所以照抄唯一能工作的参考。
 *
 * 记牢：这个端点一次请求只算一次点赞，批量点赞的代价是逐次请求 + 逐次节流。
 */
export async function likeInteract(http: BiliHttp, options: LikeInteractOptions): Promise<LikeResult> {
  const csrf = http.cookies.csrfToken
  if (!csrf) return MISSING_CSRF

  const body = new URLSearchParams()
  body.set('roomid', String(options.roomId))
  body.set('uid', String(options.uid))
  body.set('ts', String(Date.now()))
  body.set('csrf', csrf)
  body.set('csrf_token', csrf)

  const response = await http.requestJson(LIKE_INTERACT_URL, likeSchema, {
    method: 'POST',
    body: body.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://www.bilibili.com/'
    }
  })

  return classify(http, response)
}

/**
 * 先打 A，失败再打 B。
 *
 * 回退策略放在这里而不是留给调用方，是因为取舍是固定的：
 *   - 缺 cookie 时 A 已经本地短路返回 `NotLoggedIn`，B 用同一个 cookie 只会同样失败，
 *     所以这个码不再重试（也确实没什么可重试的）；
 *   - 其余失败（签名轮换、风控、未知码）都可能是 A 单方面变化，值得再试 B。
 * 两次都失败时 `error` 拼接了两条原因：运维手上唯一能看到的线索就是「A 说 X、B 说 Y」。
 *
 * A 携带 `click_time` 次点赞、B 一次只算一次 —— 走回退路径意味着这一轮少算了
 * `click_time - 1` 次。多轮形状下不需要在这里补偿：下一次重读会发现 `is_done` 仍是 `false`，
 * 再发一轮就是了。判据只有一个（服务端的 `is_done`），所以绕过回退的缺口自己就会暴露。
 */
export async function likeWithFallback(http: BiliHttp, wbi: WbiKeyStore, options: LikeOptions): Promise<LikeResult> {
  const viaReport = await likeRoom(http, wbi, options)
  if (viaReport.ok) return viaReport
  if (viaReport.code === LikeCode.NotLoggedIn) return viaReport

  const viaInteract = await likeInteract(http, { roomId: options.roomId, uid: options.uid })
  if (viaInteract.ok) return viaInteract

  return { ok: false, code: viaInteract.code, error: `${viaReport.error} / ${viaInteract.error}` }
}

/* ------------------------------------------------------------------ *
 * 动手前的闸门
 * ------------------------------------------------------------------ */

/**
 * 拒绝动手的理由。每一条都是**独立、可上报**的，没有静默跳过，而且每一条都能指着一次观测
 * （证据写在各自的注释里）—— 一条指不出证据的闸门，就是在替用户做他没同意过的决定。
 *
 * 因此这张表里**没有** `click_block` 和 `like_module`：那两个字段都不够格，理由见模块头。
 * 也**没有**「任务表里没有 like 任务」这一条：它从未被观测到（点亮的面板有它、未点亮的「仅点亮」
 * 面板也有它），所以并进了 `unreadable` —— 判定所需的输入不存在，和读不到它，对调用方是同一件事。
 */
export const LikeRefusal = {
  /**
   * cookie 里没有 `bili_jct`：连一次合法的写请求都构造不出来。
   *
   * 依据是**机制**，不是某个码：写端点要两次回显 csrf，缺它的请求只能被拒，所以这里在动手之前
   * 就短路 —— `likeRoom`、`likeInteract`、`sendDanmaku` 一直就是这么做的，本轮也要求它们保持
   * 工作。这不是对某个未验证字段语义的猜测，而是「读侧根本做不了」的状态。
   *
   * `-101` 只是本地借用 live 命名空间的通用码表（`types.ts` 的 `LikeCode.NotLoggedIn`）来表达
   * 这个状态，**本次实盘没有观测到它**（两次点赞都是 `code: 0`）。将来若真的从服务端收到
   * `-101`，那是**另一条独立证据**（服务端在讲会话失效），与这条本地短路不是同一件事，要分别记。
   */
  NotLoggedIn: 'not_logged_in',
  /**
   * 判定所需的输入读不到、读不懂、或根本不存在：读被拒、`cooldown` 不是有效秒数、
   * 任务表里没有 `like` 任务、`title`/`sub_title` 不是实测过的语法。
   *
   * 这是 fail-closed 的诚实形态：说「这次判定不了」，而不是猜一个「能发」。
   */
  Unreadable: 'unreadable',
  /** 牌子未点亮（`is_lighted = false`）。实测：未点亮的牌子只有两条任务，`sub_title` 直接是「仅点亮」，点赞不计亲密度。 */
  MedalNotLit: 'medal_not_lit',
  /** 服务端已判完成（`is_done = true`）。实测：一次 `click_time=30` 之后它由 `false` 翻成 `true`。 */
  TaskDone: 'like_task_done',
  /** `sub_title` 的 `n/m` 已经到位（`n >= m`），没有剩余轮次。实测过两个上限：`1/1` 与 `0/10`。 */
  LimitReached: 'like_limit_reached'
} as const
export type LikeRefusal = (typeof LikeRefusal)[keyof typeof LikeRefusal]

/** 闸门的输入：读侧的结果，压成三个判断依据加一个观测值。 */
export interface LikeGateInput {
  /**
   * 房间级：`like_info_v3.click_block`。
   *
   * **不参与判定**，只是从读侧一路带到结果里 —— 它从未被观测到 `true`，凭它拒绝会把整个动作
   * 静默关掉（理由写在模块头）。
   */
  readonly clickBlock: boolean
  /** 勋章级：`data.is_lighted`；`undefined` = 这次没下发它。 */
  readonly lit: boolean | undefined
  /** 房间级：`like_info_v3.cooldown`，单位**秒**。节奏的权威字段。 */
  readonly cooldownSeconds: number
  /** 勋章级：`jump_type == "like"` 的那一条；`undefined` = 任务表里没有它。 */
  readonly task: MedalTask | undefined
}

/** 放行时交出「这一轮发多少、隔多久」；拦住时交出理由。 */
export type LikeGate =
  | {
      readonly allowed: true
      /** 两轮之间的最小间隔（毫秒）：服务端的 `cooldown` 与本地下限取大者。 */
      readonly minIntervalMs: number
      /** 这一轮该携带多少次点赞，解析自任务 `title`（「点赞30次」→ 30），不是本地常量。 */
      readonly batchClicks: number
      /**
       * 这一读看到的两个原始数：分子是**今日已领取的轮数**，分母是这块牌子的日上限。
       *
       * 两个都逐牌子下发，**差值「还差几轮」不在这里算** —— 它是这两个数的一次减法，谁需要谁减
       * 一次，而不是再多一个可能和它们不一致的家。调用方要说出「计数只走到 6/10」时，必须拿得到
       * 6 与 10 这两个原数：只报差值的话，「还差 4 轮」看不出它是在 0/10 还是 6/10 上说的，而这两
       * 件事对读的人完全不同 —— 前者是「还没开始」，后者是「发出去的一半还没被认账」。
       *
       * **能不能停，要看下一轮重读出来的 `is_done` 与这两个数**：拿「还差几轮」在本地倒计时，就是
       * 又一次本地记账，而实测已经证明本地记账在这套接口下必然出错（2026-10-08 那次 `click_time=1`
       * 被丢弃与「记下但不够 30」，在读接口下不可区分）。
       */
      readonly claimed: number
      readonly limit: number
      /**
       * `like_info_v3.click_block` 的**观测值**，不是判定的一部分。
       *
       * 放在这里是为了让调用方把它写进 item 的 `code`/`detail`：将来真有人看到 `true`，那条
       * 记录就是把它升格为闸门所需的证据。在那之前，凭它拒绝等于凭一个从未出现过的字段
       * 关掉整个动作。
       */
      readonly clickBlock: boolean
    }
  | { readonly allowed: false; readonly reason: LikeRefusal; readonly detail: string }

function refuse(reason: LikeRefusal, detail: string): LikeGate {
  return { allowed: false, reason, detail }
}

/**
 * 判断这一轮该不该动手。纯函数：读由 `preflightLike` 做完，这里只判断。
 *
 * 顺序不是随意的：牌子能不能算（`is_lighted`）排在最前，因为未点亮时点赞不计亲密度；任务表里
 * 有没有这条任务排在 `is_done` 之前，因为「没有这个任务」和「做完了」在日志里必须分得开。
 *
 * **多轮**：日上限逐牌子下发（实测 level 1 是 1、level 30 是 10），形状是
 * 「读 → 判断 → 发一批 → 再读」，所以这个函数**每一轮之前都要重跑一次**，而不是跑一次发一次。
 */
export function likeGate(input: LikeGateInput): LikeGate {
  // cooldown 是要拿去睡觉的：NaN 会让 `Math.max` 也变成 NaN，进而让「等一下再发」变成
  // 「立刻再发」。读路径上 zod 已经挡掉 NaN/Infinity，所以这一挡是给直接构造入参的调用方
  // 用的 —— 一个导出函数不该假设自己的输入一定来自那个 schema。
  if (!Number.isFinite(input.cooldownSeconds) || input.cooldownSeconds < 0) {
    return refuse(LikeRefusal.Unreadable, `like_info_v3.cooldown 不是有效秒数（${String(input.cooldownSeconds)}）`)
  }
  if (input.lit === undefined) {
    return refuse(LikeRefusal.Unreadable, '粉丝牌未下发 is_lighted，无法判定任务表是否有效')
  }
  if (!input.lit) {
    return refuse(LikeRefusal.MedalNotLit, '粉丝牌未点亮（is_lighted = false）：任务表只剩「仅点亮」，点赞不计亲密度')
  }

  const task = input.task
  if (task === undefined) {
    return refuse(LikeRefusal.Unreadable, `任务表里没有 jump_type = "${MedalJumpType.Like}" 的任务`)
  }
  if (task.is_done) {
    return refuse(LikeRefusal.TaskDone, `今日点赞任务已完成（is_done = true，sub_title「${task.sub_title}」）`)
  }

  const batchClicks = parseTaskCount(task.title)
  if (batchClicks === undefined) {
    return refuse(
      LikeRefusal.Unreadable,
      `点赞任务的 title「${task.title}」解析不出每轮次数（实测语法形如「点赞30次」）`
    )
  }

  const progress = parseTaskProgress(task.sub_title)
  if (progress === undefined) {
    return refuse(
      LikeRefusal.Unreadable,
      `点赞任务的 sub_title「${task.sub_title}」解析不出进度（实测语法形如「每日上限 0/1」）`
    )
  }
  if (progress.claimed >= progress.limit) {
    return refuse(
      LikeRefusal.LimitReached,
      `已达今日上限（sub_title「${task.sub_title}」，${progress.claimed}/${progress.limit}）`
    )
  }

  return {
    allowed: true,
    minIntervalMs: Math.max(input.cooldownSeconds * 1000, LikeScheduleGuard.MinIntervalFloorMs),
    batchClicks,
    claimed: progress.claimed,
    limit: progress.limit,
    // 只带走，不参与上面任何一次判断。
    clickBlock: input.clickBlock
  }
}

/** `preflightLike` 的入参。 */
export interface LikePreflightOptions {
  /** 真实房间号（长号），不是直播间 URL 里的短号。 */
  readonly roomId: number
  /** 主播 uid —— 勋章读端点的 `target_id`。 */
  readonly anchorId: number
}

/**
 * 动手前的完整前置：两个只读 GET，然后交给 `likeGate` 判断。
 *
 * 传输层错误**不**在这里被吞掉：网络、超时、形状不符照旧抛，调用方按「重试」分级
 * （与 `platform/bilibili/index.ts` 的 `probe`/`send` 同一套）。这里只把「服务端答了，但这个
 * 答案不足以判定」收成 `unreadable`；把两者混成同一个理由，就会让一次超时看起来像一条已经
 * 判定好的拒绝，而前者应该重试、后者不该。
 *
 * 两次读都是只读 GET，不计入点赞预算。
 */
export async function preflightLike(http: BiliHttp, options: LikePreflightOptions): Promise<LikeGate> {
  const csrf = http.cookies.csrfToken
  if (!csrf) return refuse(LikeRefusal.NotLoggedIn, MISSING_CSRF.error)

  const room = await fetchRoomLikeInfo(http, options.roomId)
  if (!room.ok) return refuse(LikeRefusal.Unreadable, `读取房间点赞开关失败：${http.redact(room.error)}`)

  const medal = await fetchMedalTasks(http, csrf, options.anchorId)
  if (!medal.ok) return refuse(LikeRefusal.Unreadable, `读取粉丝牌任务失败：${http.redact(medal.error)}`)

  return likeGate({
    clickBlock: room.data.like_info_v3.click_block,
    lit: medal.data.is_lighted,
    cooldownSeconds: room.data.like_info_v3.cooldown,
    task: findMedalTask(medal.data.task_info, MedalJumpType.Like)
  })
}
