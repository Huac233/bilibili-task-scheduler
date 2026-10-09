import { z } from 'zod'

/**
 * Bilibili's HTTP responses are untrusted external data, so every payload is
 * parsed with zod at the boundary instead of being asserted into a type. That
 * is what lets the rest of the codebase stay free of `any`: outside data
 * enters as `unknown`, gets validated once, and is typed from then on.
 *
 * Each endpoint below is declared in two parts:
 *   - `xxxData`  — the shape of the `data` field only
 *   - `xxxSchema` — the full envelope, built from `xxxData`
 * and the exported type alias is inferred from `xxxData`. Deriving the type
 * from the enveloped schema instead would type every consumer as the whole
 * `{ code, message, data }` object, which is a mistake worth calling out: it
 * compiles and then reads fields off the wrong level.
 */

/** The common envelope fields present on essentially every Bilibili API response. */
export const envelopeFields = {
  code: z.number(),
  message: z.string().optional(),
  msg: z.string().optional(),
  ttl: z.number().optional()
} as const

/**
 * Full envelope. `.catchall(z.unknown())` is deliberate: several endpoints add
 * their own top-level keys alongside `data` (numeric-string keys such as
 * `"0x0000000"` on `/msg/send`), and a strict object would reject them.
 */
export function enveloped<T extends z.ZodType>(data: T) {
  return z.object({ ...envelopeFields, data }).catchall(z.unknown())
}

/** Envelope variant for endpoints that omit `data` on failure. */
export function envelopedOptionalData<T extends z.ZodType>(data: T) {
  return z.object({ ...envelopeFields, data: data.optional() }).catchall(z.unknown())
}

/* ------------------------------------------------------------------ *
 * Passport / login
 * ------------------------------------------------------------------ */

/** `GET /x/passport-login/web/qrcode/generate` */
export const qrCodeGenerateData = z.object({
  url: z.string(),
  qrcode_key: z.string()
})
export type QrCodeGenerate = z.infer<typeof qrCodeGenerateData>
export const qrCodeGenerateSchema = enveloped(qrCodeGenerateData)

/**
 * `GET /x/passport-login/web/qrcode/poll` — the scan state lives in
 * `data.code`, not the envelope `code`:
 *   0     success (this response also carries the session cookies)
 *   86038 QR expired
 *   86090 scanned, awaiting confirmation
 *   86101 not scanned yet
 */
export const qrCodePollData = z.object({
  url: z.string(),
  refresh_token: z.string(),
  timestamp: z.number(),
  code: z.number(),
  message: z.string()
})
export type QrCodePoll = z.infer<typeof qrCodePollData>
export const qrCodePollSchema = enveloped(qrCodePollData)

export const QR_POLL_SUCCESS = 0
export const QR_POLL_EXPIRED = 86038
export const QR_POLL_SCANNED = 86090
export const QR_POLL_PENDING = 86101

/** `GET /x/web-interface/nav` — session check and source of the WBI keys. */
export const navDataSchema = z.object({
  isLogin: z.boolean(),
  mid: z.number().optional(),
  uname: z.string().optional(),
  face: z.string().optional(),
  wbi_img: z
    .object({
      img_url: z.string(),
      sub_url: z.string()
    })
    .optional()
})
export type NavData = z.infer<typeof navDataSchema>
/**
 * The *optional-data* envelope, deliberately.
 *
 * A rejected request — risk control answering `{"code": -412}` — arrives with no
 * `data` at all, and a strict envelope turns that into "unexpected response shape at
 * data": a shape error that also throws away the one field explaining what happened.
 * Every caller reads `code` first, so `code` has to survive the rejection, and `data`
 * is only there when there is an actual answer about the session.
 */
export const navSchema = envelopedOptionalData(navDataSchema)

/* ------------------------------------------------------------------ *
 * Live room
 * ------------------------------------------------------------------ */

/**
 * `/room/v1/Room/room_init` — maps the number in a room URL (short id) to the
 * real room id every other live endpoint expects.
 *
 * Only fields this application consumes are declared. Bilibili retypes fields
 * over time and documents them inconsistently — `encrypted` is described as a
 * number by older references but arrives as a boolean today — so declaring an
 * unused field buys nothing and turns an irrelevant upstream change into a hard
 * failure of the entire request. Unknown fields are stripped by zod, so leaving
 * them out costs nothing.
 */
export const roomInitDataSchema = z.object({
  room_id: z.number(),
  short_id: z.number(),
  uid: z.number(),
  live_status: z.number(),
  live_time: z.number()
})
export type RoomInit = z.infer<typeof roomInitDataSchema>

/**
 * `room_init`'s code space, out of the reference field table (`room_init`: `0` 成功 / `60004`
 * 直播间不存在).
 *
 * One named constant rather than two, because only one of the two is a fact about the number a person
 * pasted: everything that is not this is a refusal this build has no name for, and
 * `platform/bilibili/index.ts` grades the two differently.
 */
export const RoomInitCode = {
  /** 直播间不存在 — the number names no room. */
  RoomNotFound: 60004
} as const

/**
 * `room_init`'s envelope, and the one place these two endpoints differ from their neighbours.
 *
 * `envelopedOptionalData` is the right family — a refusal arrives without the room fields — but it
 * tolerates only an *absent* `data`, and this endpoint's refusal body is not captured anywhere in this
 * repo: absent is what `/nav` does when it refuses, while `null` is the other way a JSON API writes
 * "nothing to put here". Either way **the code has to survive the parse**, because it is the only thing
 * that can tell 「that room is not there」 from 「the Platform is not answering」 — and demanding a room
 * payload first is exactly what made a missing room unreadable. A `data` that *is* present still has to
 * be a room, which is what keeps a changed success shape loud. `resolveRoom` is where the readings are
 * separated.
 */
export const roomInitSchema = envelopedOptionalData(roomInitDataSchema.nullable())

/** `/room/v1/Room/get_info` — richer metadata: the fallback read for a title, and the one room read the reconcile actions need. */
export const roomInfoDataSchema = z.object({
  room_id: z.number(),
  short_id: z.number(),
  uid: z.number(),
  live_status: z.number(),
  /** Seconds since epoch when live, `"0000-00-00 00:00:00"` when offline. */
  live_time: z.union([z.number(), z.string()]),
  title: z.string(),
  /**
   * The room's second-level and first-level area ids.
   *
   * Declared for exactly one consumer: the live-trace handshake the 观看直播 action sends,
   * whose `id` field is the JSON array `[parent_area_id, area_id, seq, room_id]`
   * (`bilibili/watch-live.ts` documents the reference implementations it was taken from).
   * They come from this endpoint because that is where both references read them, and a
   * separate request for two fields of a payload already being fetched would be a second
   * home for the same fact.
   *
   * **Optional on purpose, and the reason is the whole "declare only what you consume"
   * rule.** `roomInfoSchema` has three consumers now — `resolveTarget`'s title, the
   * reconcile actions' anchor id, and the handshake — and two of them do not care about
   * areas. Declaring these required would make an upstream rename of either id fail the
   * *entire* room read, including task creation, for a field the caller in question never
   * reads. Optional keeps the blast radius to the one consumer that genuinely needs them,
   * and that consumer reports a missing id as its own failure rather than sending a
   * handshake with an invented area in it.
   */
  parent_area_id: z.number().optional(),
  area_id: z.number().optional()
})
export type RoomInfo = z.infer<typeof roomInfoDataSchema>

/**
 * The same envelope as `roomInitSchema`, tolerating the same refusal — for the same reason.
 *
 * `get_info` answers `1` (不存在) to a `room_id` that is not there, and that refusal carries no room
 * either; a parse that demanded one first would turn it into 「unexpected response shape」, which is a
 * statement about this build's parsing rather than about the room. `fetchRoomInfo` reads the code first,
 * exactly as `resolveRoom` does.
 */
export const roomInfoSchema = envelopedOptionalData(roomInfoDataSchema.nullable())

/**
 * `/xlive/web-room/v1/index/getInfoByRoom` — the payload the live room **page** itself reads.
 *
 * Declared for exactly one field, and that field is the whole reason the read exists:
 * `anchor_info.base_info.uname` is the Anchor's display name. Neither endpoint a Room is looked up
 * through carries a user name — `room_init` answers `room_id`/`short_id`/`uid`/`live_status` and
 * `get_info` answers `uid`/`title`/areas — so neither of them is a source for this field at all, and
 * a guess at one has no way to tell "no name" from "renamed".
 *
 * **The name sits one level deeper than a reference implementation's room type suggests.** The block
 * that carries it is `anchor_info.base_info`, not `anchor_info`: a `uname` read straight off
 * `anchor_info` is `undefined`, which is the kind of wrong answer that still looks like a value.
 *
 * Everything else this payload carries — the page's entire module tree, tens of KB of it — is left
 * undeclared, for the reason `roomInitDataSchema` gives: an unused field declared turns an upstream
 * change into a hard failure of a read whose whole job is a cosmetic name.
 */
export const anchorNameDataSchema = z.object({
  anchor_info: z.object({
    base_info: z.object({
      uname: z.string()
    })
  })
})

/**
 * The same envelope as the two room reads above, and for the same reason: the code has to survive the
 * parse. This endpoint's own documented refusal is `19002000`（获取初始化数据失败）— a room it will not
 * initialise — and a reader that demanded an anchor before reading the code would report a shape
 * problem where Bilibili had named a state.
 *
 * A `data` that *is* present still has to carry the anchor block, also as above: a read that succeeds
 * and says nothing about the anchor is a contract change, and the loud reading of it — `fetchAnchorName`
 * throws, its caller keeps the task and labels it with the room's 标题 instead — leaves a trace, where an
 * optional block would quietly answer `''` for both states.
 *
 * The tolerated absent `data` is the shape Bilibili actually uses for this endpoint's other refusal:
 * `-352` (risk control) arrives as `{"code":-352,"message":"-352","ttl":1}` with no `data` at all, which
 * is what a **cookie-less** client is answered (measured 2026-10-09, kept in
 * `tests/captured/bilibili-getInfoByRoom-14709735-anonymous.json`; `live.ts` 的 `fetchAnchorName` 记着完整实测).
 */
export const anchorNameSchema = envelopedOptionalData(anchorNameDataSchema.nullable())

/** Values of `live_status` across the room endpoints. */
export const LiveStatus = {
  Offline: 0,
  Live: 1,
  /** 轮播 — the room replays a recording; nobody is actually streaming. */
  Round: 2
} as const

/** `/xlive/web-room/v1/index/getDanmuInfo` — WS token plus endpoint list. */
export const danmuInfoDataSchema = z.object({
  token: z.string(),
  host_list: z.array(
    z.object({
      host: z.string(),
      port: z.number().optional(),
      wss_port: z.number(),
      ws_port: z.number()
    })
  )
})
export type DanmuInfo = z.infer<typeof danmuInfoDataSchema>
export const danmuInfoSchema = enveloped(danmuInfoDataSchema)

/* ------------------------------------------------------------------ *
 * Danmaku sending
 * ------------------------------------------------------------------ */

/**
 * `/msg/send` response `data`. Per-mode results arrive under numeric-string
 * keys, so the inner shape is intentionally loose: a zero envelope `code` is
 * the primary success signal and `mode_info` is only extra detail.
 */
export const sendDanmakuDataSchema = z.object({
  mode_info: z.record(z.string(), z.unknown()).optional(),
  dm_v2: z.unknown().optional()
})
export type SendDanmakuData = z.infer<typeof sendDanmakuDataSchema>
export const sendDanmakuSchema = envelopedOptionalData(sendDanmakuDataSchema)

/** Known `/msg/send` codes worth branching on. */
export const SendDanmakuCode = {
  Ok: 0,
  /** 弹幕内容被拒绝（过长或命中过滤） */
  ContentRejected: 10030,
  /** 发送频率过快 */
  RateLimited: 10031,
  /** 房间全员禁言 */
  RoomMuted: -400,
  /** 账号被封禁 */
  Banned: -403,
  /** 未登录 / 登录态失效 */
  NotLoggedIn: -101,
  /** 签名校验失败 —— WBI 键或 csrf 不对 */
  SignError: -111
} as const

/**
 * The refusal every write path returns when the jar carries no `bili_jct`.
 *
 * A write echoes that cookie twice (`csrf` and `csrf_token`), so a jar without it can
 * only produce a rejected call — `sendDanmaku` and both like endpoints answer this
 * *before* making one, which is the cheaper and more honest refusal. It is written
 * once because it is one sentence a person reads; `-101` (账号未登录) is the live
 * namespace's own name for the state, and the number `LikeCode` carries for the like
 * endpoints is the same one.
 */
export const MISSING_CSRF = {
  ok: false,
  code: SendDanmakuCode.NotLoggedIn,
  error: '未登录：cookie 中缺少 bili_jct'
} as const

/* ------------------------------------------------------------------ *
 * Live-room like (点赞)
 * ------------------------------------------------------------------ */

/**
 * Envelope shared by both live-room like endpoints:
 *   `POST /xlive/app-ucenter/v1/like_info_v3/like/likeReportV3`
 *   `POST /xlive/web-ucenter/v1/interact/likeInteract`
 *
 * `data` is deliberately left unmodelled, and not out of laziness: there is no
 * evidence to model it from. Neither implementation that calls these endpoints
 * reads the body — BLTH declares `data: {}` outright
 * (`library/bili-api/response.ts:25-30`) and `ref-bilibili-live-helper` asserts
 * `code === 0` then discards the payload (`src/api.ts:1008-1011`). Declaring
 * fields for a real endpoint from no evidence turns the first upstream change
 * into an `unexpected response shape` hard failure, while success is decidable
 * from the envelope `code` alone.
 */
export const likeSchema = envelopedOptionalData(z.unknown().optional())

/**
 * Response codes this project can actually justify for the like endpoints.
 *
 * No "liked too fast" / risk-control code is listed on purpose: no reference
 * names one. BLTH reacts to suspected risk control by sleeping 300 s and
 * retrying (`likeTask.ts:127-129`), never by branching on a code.
 */
export const LikeCode = {
  /** 成功 —— 两个实现都以 `code === 0` 判定成功（BLTH `MedalModule.ts:324`；live-helper `api.ts:1011`）。 */
  Ok: 0,
  /**
   * 未登录 / 登录态失效。
   *
   * 点赞端点本身没有错误码文档，这个值来自 live 命名空间的通用码表
   * （BACNext backup `docs/live/danmaku.md:1745` 对 `/msg/send` 明列 `-101`/`-111`），
   * 与本仓库 `SendDanmakuCode` 已采用的语义一致。因此它只用于日志分类和本地短路，
   * 不要当成点赞端点的权威契约。
   */
  NotLoggedIn: -101,
  /** csrf / WBI 签名校验失败。来源同上；`likeRoom` 用它触发 WBI 键失效重取。 */
  SignError: -111
} as const
