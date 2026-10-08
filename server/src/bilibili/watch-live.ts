import { createHmac } from 'node:crypto'

import { z } from 'zod'

import type { BiliHttp } from './http.js'
import { envelopedOptionalData, MISSING_CSRF } from './types.js'

/**
 * 观看直播任务的传输侧：`live-trace.bilibili.com` 上的进场 + 心跳（`x25Kn/E`、`x25Kn/X`）。
 *
 * 任务本身是「观看直播满15分钟」（`jump_type = watchLive`，`add_text = 亲密度+1`，
 * `sub_title = 每日上限 0/1`）。**900 秒是任务要攒的时长，不是心跳周期** —— 周期由服务端
 * 在每次响应里下发（`heartbeat_interval`，秒），所以这个模块一次调用只做**一拍**，
 * 睡多久、攒够没有，都不是它的判断。
 *
 * ## 谁决定「攒够了」
 *
 * 服务端。调用方的形状是**重复调用**，不是本地计时：
 *
 *   1. `enterLiveRoom` 拿一次会话（服务端给 `timestamp` / `secret_key` / `secret_rule` /
 *      `heartbeat_interval`）；
 *   2. 睡 `session.heartbeatInterval` 秒，`sendLiveHeartbeat` 发一拍，它把服务端新下发的
 *      一组值带回下一拍的 `WatchSession`；
 *   3. 隔一段时间用 `medal.ts` 的 `fetchMedalTasks` 重读一次，
 *      `isTaskDone(tasks, MedalJumpType.WatchLive)` 为 `true` 就停 —— **不要本地累加秒数**。
 *      实测已经证明本地记账不成立：日上限逐牌子下发，任务表的有效性还由 `is_lighted` 门控。
 *
 * ## secret 的来源（这条最重要）
 *
 * `secret_key` / `secret_rule` / `timestamp` 全部是**服务端在响应里下发的**，而且每一次心跳
 * 响应都会重新下发一组；它们只在这段会话内有效。这里因此**没有任何硬编码的 secret**：
 * 会话值从 `enterLiveRoom` 的响应流进 `WatchSession`，再从每一拍的响应流回下一拍。
 *
 * 反面教材就在仓库外的那份参考里，写下来是为了别再走一遍：旧版 App 端点
 * `xlive/data-interface/v1/heartbeat/mobileHeartBeat` 的实现把 `"secret_key":
 * "axoaadsffcazxksectbbb"` 直接写在源码里（`bac/bilifan_api.py:445`）—— 那是一个会静默过期
 * 的常量，一旦服务端换值，签名照样算得出来、请求照样发得出去，只是**一分亲密度都不挣**。
 *
 * ## 请求形状的来源，以及它没有被实盘验证这件事
 *
 * 形状来自两份互相独立的实现，字段名逐一对齐：
 *   - `ref-bilibili-live-helper`：`src/api.ts:865-910`（E）、`912-960`（X），
 *     `src/modules/watchLive.ts:24-72`（HMAC 的输入与 `ets`/`time`/`ts` 各是什么）；
 *   - BiliBiliToolPro（C#）：`bac/tool_ILiveTraceApi.cs`（两个端点与 urlencoded 体）、
 *     `tool_LiveHeartBeatCrypto.cs`（HMAC 规则表 0..5）、
 *     `tool_LiveFansMedalTaskRunner.cs:279-373`（会话流转、间隔合法性）。
 *
 * 但**心跳链路本身没有实盘抓包**（笔记 `bili-live-like-live-test-2026-10-08.md` §6.7 明确标注
 * 未实测）。这是本包里唯一一条源头不是实测的请求形状，所以接线的人要先拿一个真账号跑通
 * `enterLiveRoom` 一次、确认 `code: 0` 且响应里有 `secret_key`，再把调度接上去。理由很直接：
 * 一个半通的心跳看起来像「正在工作」，实际一分亲密度都不挣，比不实现更坏。
 *
 * ## 会话是凭据
 *
 * `WatchSession` 里的 `secretKey` 参与签名，`buvid`/`uuid` 是设备标识：三者都**不许进日志、
 * 不许进错误信息**。本模块返回的失败信息只来自服务端自己的 `message`/`msg`，并在返回之前把这三
 * 个值连同 `csrf` 一起抠掉 —— 进场与心跳的请求体里带着它们全部（`benchmark` 就是上一拍的密钥），
 * 而把请求体回显回来正是服务端拒绝时的常见形态。
 *
 * 两道前置门禁与本模块无关，但接线的人要知道两条都要满足：任务表由 `is_lighted` 门控
 * （未点亮的牌子只有「仅点亮」，`medal.ts` 有实测记录），观看/点赞还都要求主播正在开播
 * （BLTH `LiveFansMedalTaskRunner.cs:288-289` 的 `if (room.Live_Status != 1) return;`）。
 *
 * 超时：两个请求都走 `BiliHttp.request`，它自带 `AbortSignal.timeout(timeoutMs)`，所以这里既
 * 不自己造 controller，也没有需要与调用方的 signal 组合的地方。
 */

/** 进场（EnterRoom）。 */
export const LIVE_TRACE_ENTER_URL = 'https://live-trace.bilibili.com/xlive/data-interface/v1/x25Kn/E'

/** 心跳（HeartBeat）。 */
export const LIVE_TRACE_HEARTBEAT_URL = 'https://live-trace.bilibili.com/xlive/data-interface/v1/x25Kn/X'

/**
 * 心跳间隔的合理上限（秒）。
 *
 * 来自 BLTH 的同一个判断（`LiveFansMedalTaskRunner.cs:315-320`：`<= 0` 或 `> 300` 一律当作
 * 无效参数并放弃任务）。这个界不是审美：调用方要按返回值睡觉，一个被写坏或被中间设备改过的
 * 大间隔会让「攒够 15 分钟」变成一次永不回头的长睡，而没有任何后续调用能发现它。
 */
export const MAX_HEARTBEAT_INTERVAL_SECONDS = 300

/**
 * 签名规则的编号 → HMAC 算法，取值域与两份参考实现一致（0..5）。
 *
 * 表里没有的编号会**抛**，不按参考实现（live-helper）那样静默返回上一轮的结果：静默的后果是
 * 算出一个服务端不认的签名，然后这个看起来在工作、实际不挣亲密度的循环一直跑下去。C# 那份
 * 实现对未知编号也是抛异常，所以抛才是两份实现共同的选择。
 */
const HMAC_ALGORITHM_BY_RULE: Readonly<Record<number, string>> = {
  0: 'md5',
  1: 'sha1',
  2: 'sha256',
  3: 'sha224',
  4: 'sha512',
  5: 'sha384'
}

/**
 * `x25Kn/E` 与 `x25Kn/X` 共用的 `data`（字段名取自 live-helper 的返回类型）。
 *
 * 参考实现的返回类型里还有一个 `patch_status`，本模块不用它，所以**不声明**：zod 会丢掉未
 * 声明的键，声明一个不消费的字段只是给上游改动多加一个把进场打挂的机会（同一套理由写在
 * `medal.ts` 的模块头）。
 */
export const liveTraceHeartbeatDataSchema = z.object({
  /** 服务端给的时间基准，下一拍的 `ets` 就是它。 */
  timestamp: z.number(),
  /** 下一拍该隔多少秒再来。 */
  heartbeat_interval: z.number(),
  /** 服务端下发的签名密钥，参与下一拍的 HMAC。 */
  secret_key: z.string(),
  /** 服务端下发的签名链：每个编号对应一次 HMAC，按顺序叠加。 */
  secret_rule: z.array(z.number())
})
export type LiveTraceHeartbeatData = z.infer<typeof liveTraceHeartbeatDataSchema>
export const liveTraceHeartbeatSchema = envelopedOptionalData(liveTraceHeartbeatDataSchema)

/**
 * 一段观看会话的全部服务端状态。
 *
 * `sequence` 存的永远是**下一拍要用的序号**：进场用的是 0，第一拍心跳用 1，所以
 * `enterLiveRoom` 返回的会话里它是 1（与参考实现 `watchLive.ts:91-108` 的 `sequence += 1`
 * 同一个位置抬的值）。
 */
export interface WatchSession {
  /** 真实房间号（长号）。 */
  readonly roomId: number
  /** 分区 id，来自 `Room/get_info` 的 `parent_area_id`。 */
  readonly parentAreaId: number
  /** 子分区 id，来自同一个响应的 `area_id`。 */
  readonly areaId: number
  /** 主播 uid —— 这个端点的 `ruid`。 */
  readonly ruid: number
  /** `LIVE_BUVID` cookie 的值。 */
  readonly buvid: string
  /** 本次会话自造的设备 uuid，四段式；与服务端无关，但必须前后一致。 */
  readonly uuid: string
  /** 下一拍要用的序号（进场为 0，之后逐拍 +1）。 */
  readonly sequence: number
  /** 上一拍响应里的 `timestamp`，即下一拍的 `ets`。 */
  readonly timestamp: number
  /** 上一拍响应里的 `heartbeat_interval`，单位秒，调用方据此睡觉。 */
  readonly heartbeatInterval: number
  /** 服务端下发的签名密钥。凭据，不许进日志。 */
  readonly secretKey: string
  /** 服务端下发的签名链。 */
  readonly secretRule: readonly number[]
}

/** 进场或心跳的一拍：成功就带着下一拍要用的会话回去，失败就带服务端的拒绝。 */
export type WatchResult =
  | { readonly ok: true; readonly session: WatchSession }
  | { readonly ok: false; readonly code: number; readonly error: string }

/** `enterLiveRoom` 的入参。 */
export interface EnterLiveRoomOptions {
  /** 真实房间号（长号）。 */
  readonly roomId: number
  /** 主播 uid：端点的 `ruid`，不是点赞者 uid。 */
  readonly ruid: number
  /** 房间的一/二级分区 id，来自 `Room/get_info`。 */
  readonly parentAreaId: number
  /** 子分区 id，来自同一个响应。 */
  readonly areaId: number
  /**
   * `LIVE_BUVID` cookie 的值，由调用方提供。
   *
   * 为什么不从 `http.cookies` 里取：这个 cookie 不在登录凭据里，`platform/bilibili/session.ts`
   * 的 `canonicalCookies` 只保留登录那几个，所以服务器的 jar 里通常没有它；它要靠访问一次
   * 直播间首页、从 `Set-Cookie` 里接住（BLTH `LiveDomainService.cs:494-529` 就是这么做的）。
   * 与 `uid`/`anchorId` 一样：调用方给，这里不猜。
   */
  readonly buvid: string
  /** 会话 uuid，默认随机生成一个四段式 uuid。测试里传固定值用。 */
  readonly uuid?: string
}

/** 心跳签名的输入。字段名与**顺序**都照抄参考实现，顺序是载荷的一部分（见下）。 */
interface HeartbeatSignatureInput {
  readonly key: string
  readonly rules: readonly number[]
  readonly parentAreaId: number
  readonly areaId: number
  readonly sequence: number
  readonly roomId: number
  readonly buvid: string
  readonly uuid: string
  /** 上一拍的时间基准。 */
  readonly ets: number
  /** 上一拍的间隔（秒）。 */
  readonly time: number
  /** 当前毫秒时间戳。 */
  readonly ts: number
}

/**
 * 算 `s`：对一段 JSON 依次套用服务端下发的 HMAC 链。
 *
 * 两个必须照抄的细节：
 *   - 载荷是**一段 JSON 字符串**，`JSON.stringify` 保序，所以 `platform` 打头、`ts` 结尾这个
 *     顺序就是签名的一部分；换序会算出一个服务端不认的签名，而且不会有任何报错。
 *     顺序取自 `ref-bilibili-live-helper/src/modules/watchLive.ts:37-52`。
 *   - 链是**串行**的：上一轮的十六进制输出直接当下一轮的输入。
 */
function signHeartbeat(input: HeartbeatSignatureInput): string {
  const payload = JSON.stringify({
    platform: 'web',
    parent_id: input.parentAreaId,
    area_id: input.areaId,
    seq_id: input.sequence,
    room_id: input.roomId,
    buvid: input.buvid,
    uuid: input.uuid,
    ets: input.ets,
    time: input.time,
    ts: input.ts
  })

  let signature = payload
  for (const rule of input.rules) {
    const algorithm = HMAC_ALGORITHM_BY_RULE[rule]
    if (algorithm === undefined) {
      // 消息里只带编号，不带密钥：这个异常会被调度器打出来。
      throw new Error(`直播心跳：服务端下发了不认识的签名规则 ${String(rule)}，无法计算签名`)
    }
    signature = createHmac(algorithm, input.key).update(signature).digest('hex')
  }
  return signature
}

/**
 * 把响应的 `data` 收成会话状态，并在这里挡住值不能用的两种输入。
 *
 * 挡在源头而不是等下一拍：间隔决定调用方睡多久、规则决定下一拍能不能签，两者不合格时越早
 * 报越好 —— 尤其是规则，等下一拍才抛的话，这一拍的会话已经交出去了。
 */
function sessionOf(
  state: LiveTraceHeartbeatData,
  base: Omit<WatchSession, 'sequence' | 'timestamp' | 'heartbeatInterval' | 'secretKey' | 'secretRule'>,
  sequence: number,
  url: string
): WatchSession {
  if (!(state.heartbeat_interval > 0) || state.heartbeat_interval > MAX_HEARTBEAT_INTERVAL_SECONDS) {
    throw new Error(`${url} 返回的心跳间隔不可用（heartbeat_interval = ${String(state.heartbeat_interval)}）`)
  }
  for (const rule of state.secret_rule) {
    if (HMAC_ALGORITHM_BY_RULE[rule] === undefined) {
      throw new Error(`${url} 返回了不认识的签名规则 ${String(rule)}`)
    }
  }

  return {
    ...base,
    sequence,
    timestamp: state.timestamp,
    heartbeatInterval: state.heartbeat_interval,
    secretKey: state.secret_key,
    secretRule: state.secret_rule
  }
}

/**
 * 入场一次，拿回会话。
 *
 * 请求体字段照抄参考实现（`ref-bilibili-live-helper/src/api.ts:892-902`）：
 * `id` 是一段 JSON `[parent_area_id, area_id, seq, room_id]`，`device` 是
 * `["<LIVE_BUVID>", "<uuid>"]`，`heart_beat` 是空数组的 JSON —— 三个都是「看着像 JSON、
 * 其实是表单字符串」的字段，抄错形状服务端不会解释。`ua` 与请求头里的 User-Agent 用
 * **同一个** `http.userAgent`，两份参考实现都是这么发的，没有理由让它们能漂开。
 *
 * `is_patch = 0`、`visit_id = ''` 是参考实现的固定值，本模块不解释它们的作用。
 *
 * @param nowMs 可注入的时钟（毫秒），用于测试；生产走 `Date.now()`。
 */
export async function enterLiveRoom(
  http: BiliHttp,
  options: EnterLiveRoomOptions,
  nowMs: number = Date.now()
): Promise<WatchResult> {
  const csrf = http.cookies.csrfToken
  if (!csrf) return MISSING_CSRF

  const uuid = options.uuid ?? randomUuid()
  const ts = nowMs

  const body = new URLSearchParams()
  body.set('id', JSON.stringify([options.parentAreaId, options.areaId, 0, options.roomId]))
  body.set('device', JSON.stringify([options.buvid, uuid]))
  body.set('ruid', String(options.ruid))
  body.set('ts', String(ts))
  body.set('is_patch', '0')
  body.set('heart_beat', JSON.stringify([]))
  body.set('ua', http.userAgent)
  body.set('visit_id', '')
  body.set('csrf', csrf)
  body.set('csrf_token', csrf)

  const response = await http.requestJson(LIVE_TRACE_ENTER_URL, liveTraceHeartbeatSchema, {
    method: 'POST',
    body: body.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // 参考实现给这两个端点显式设的是 www.bilibili.com（`api.ts:889`），与本项目默认的
      // live.bilibili.com 不同；没有别的证据说明该用哪个，所以照抄能工作的那一份。
      Referer: 'https://www.bilibili.com/'
    }
  })

  if (response.code !== 0) {
    const detail = response.message ?? response.msg ?? `code ${String(response.code)}`
    return {
      ok: false,
      code: response.code,
      // `device` carries the buvid and the session uuid; the body carries `csrf` twice.
      error: http.redact(detail, [options.buvid, uuid])
    }
  }
  if (response.data === undefined) {
    throw new Error(`${LIVE_TRACE_ENTER_URL} 回 code 0 但没有 data：进场状态取不到，会话无法建立`)
  }

  const base = {
    roomId: options.roomId,
    parentAreaId: options.parentAreaId,
    areaId: options.areaId,
    ruid: options.ruid,
    buvid: options.buvid,
    uuid
  }
  // 进场用的是序号 0，所以这里交出去的会话带的是「第一拍要用的」1。
  return { ok: true, session: sessionOf(response.data, base, 1, LIVE_TRACE_ENTER_URL) }
}

/**
 * 发一拍心跳。
 *
 * 请求体的 `ets` / `time` / `benchmark` 三个字段是**上一拍的会话值**：`ets` 是上一拍响应里的
 * `timestamp`，`time` 是上一拍**真正等过的间隔**，`benchmark` 是上一拍的 `secret_key`（名字叫
 * benchmark，收到的确实是密钥 —— 两份参考实现都这么传）。`s` 是这场会话的签名。
 *
 * **「真正等过」和「服务端说的那个数」在这里不总是同一个值，所以它由调用方传进来。**
 * 服务端下发 `heartbeat_interval`，调用方睡的是 `platform/bilibili/index.ts` 的 `beatMsOf`
 * —— 那个下限（`WATCH_MIN_HEARTBEAT_MS`）是**本项目自己的**，服务端报一个小于 1 秒的间隔时，
 * 本地仍然睡满 1 秒。此前这里签的、发的都是 `session.heartbeatInterval`（服务端的数），于是
 * 下限一生效，body 说的间隔就比真实睡眠短 —— 一个**没有发生过的间隔被写进了请求**。现在两个
 * 数由参数区分：默认值仍是服务端的间隔（直调本函数的调用方与参考实现一致），循环里显式传它
 * 实际睡过的秒数。字段含义因此始终是「上一拍等过的间隔」，两个方向都不会反过来。
 *
 * 心跳响应会**重新下发** `secret_key`/`secret_rule`/`timestamp`/`heartbeat_interval`，
 * 所以返回的会话是下一拍要用的那一组；丢了它，下一拍的签名就作废。
 *
 * @param nowMs 可注入的时钟（毫秒），用于测试；生产走 `Date.now()`。
 * @param waitedSeconds 上一拍实际等过的秒数；见上面的说明，默认是服务端下发的间隔。
 */
export async function sendLiveHeartbeat(
  http: BiliHttp,
  session: WatchSession,
  nowMs: number = Date.now(),
  waitedSeconds: number = session.heartbeatInterval
): Promise<WatchResult> {
  const csrf = http.cookies.csrfToken
  if (!csrf) return MISSING_CSRF

  const ts = nowMs
  const signature = signHeartbeat({
    key: session.secretKey,
    rules: session.secretRule,
    parentAreaId: session.parentAreaId,
    areaId: session.areaId,
    sequence: session.sequence,
    roomId: session.roomId,
    buvid: session.buvid,
    uuid: session.uuid,
    ets: session.timestamp,
    time: waitedSeconds,
    ts
  })

  const body = new URLSearchParams()
  body.set('s', signature)
  body.set('id', JSON.stringify([session.parentAreaId, session.areaId, session.sequence, session.roomId]))
  body.set('device', JSON.stringify([session.buvid, session.uuid]))
  body.set('ruid', String(session.ruid))
  body.set('ets', String(session.timestamp))
  body.set('benchmark', session.secretKey)
  body.set('time', String(waitedSeconds))
  body.set('ts', String(ts))
  body.set('ua', http.userAgent)
  body.set('visit_id', '')
  body.set('csrf', csrf)
  body.set('csrf_token', csrf)

  const response = await http.requestJson(LIVE_TRACE_HEARTBEAT_URL, liveTraceHeartbeatSchema, {
    method: 'POST',
    body: body.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://www.bilibili.com/'
    }
  })

  if (response.code !== 0) {
    const detail = response.message ?? response.msg ?? `code ${String(response.code)}`
    return {
      ok: false,
      code: response.code,
      // The body carries the session's signing key (`benchmark`), the buvid, the uuid
      // and `csrf` twice — every one of them is a value this call just sent.
      error: http.redact(detail, [session.secretKey, session.buvid, session.uuid])
    }
  }
  if (response.data === undefined) {
    throw new Error(`${LIVE_TRACE_HEARTBEAT_URL} 回 code 0 但没有 data：下一拍的密钥与间隔取不到`)
  }

  const base = {
    roomId: session.roomId,
    parentAreaId: session.parentAreaId,
    areaId: session.areaId,
    ruid: session.ruid,
    buvid: session.buvid,
    uuid: session.uuid
  }
  return { ok: true, session: sessionOf(response.data, base, session.sequence + 1, LIVE_TRACE_HEARTBEAT_URL) }
}

/**
 * 四段式 uuid（版本位 4、变体位 8..b），与服务端无关，只在一次会话里保证 `device` 前后一致。
 *
 * 用 `crypto.randomUUID` 而不是参考实现那段位运算模板：运行时已经有了，手抄一段位运算
 * 只会多一个能被抄错的地方。
 */
function randomUuid(): string {
  return globalThis.crypto.randomUUID()
}
