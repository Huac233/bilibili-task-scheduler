import { fetchNav } from './auth.js'
import { type BiliHttp, BiliHttpError } from './http.js'
import { ROOM_INFO_BY_ROOM_URL } from './medal.js'
import {
  anchorNameSchema,
  type DanmuInfo,
  danmuInfoSchema,
  LiveStatus,
  MISSING_CSRF,
  type RoomInfo,
  type RoomInit,
  roomInfoSchema,
  roomInitSchema,
  SendDanmakuCode,
  sendDanmakuSchema
} from './types.js'
import { encodeWbi, extractWbiKeys, type WbiKeys } from './wbi.js'

/**
 * Live-room operations: resolving room ids, reading live status, reading an
 * anchor's name, and sending danmaku.
 *
 * The write path is the interesting one. Bilibili requires three things to
 * accept a danmaku:
 *   1. a valid session cookie plus the CSRF token (`bili_jct`) echoed twice,
 *   2. a WBI signature on the query string,
 *   3. a multipart body with a specific set of fields.
 * Miss any of them and the call fails with `-111` or a silent drop.
 */

/** `web_location` value Bilibili's own live frontend sends. Overridable. */
export const DEFAULT_WEB_LOCATION = '444.8'

/** Endpoint URLs used by this module. */
export const ROOM_INIT_URL = 'https://api.live.bilibili.com/room/v1/Room/room_init'
export const ROOM_INFO_URL = 'https://api.live.bilibili.com/room/v1/Room/get_info'
export const MSG_SEND_URL = 'https://api.live.bilibili.com/msg/send'
export const DANMU_INFO_URL = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo'

/** Bilibili's default danmaku colour (white) as a decimal RGB int. */
export const DEFAULT_DANMAKU_COLOR = 16_777_215

/** `mode` values accepted by `/msg/send`. */
export const DanmakuMode = {
  /** Scrolls right-to-left. The normal choice. */
  Scroll: 1,
  Bottom: 4,
  Top: 5,
  /** Replaces the previous message from the same sender. */
  Reverse: 6,
  Advanced: 7
} as const
export type DanmakuMode = (typeof DanmakuMode)[keyof typeof DanmakuMode]

/**
 * Caches WBI signing keys. They rotate infrequently (days), so a several-hour
 * TTL keeps request counts low while still recovering from a rotation without
 * a restart.
 *
 * The keys come from `/x/web-interface/nav`, the call `auth.ts` already owns for the
 * session check, so this store asks for them through `fetchNav` instead of holding
 * its own copy of the endpoint.
 */
export class WbiKeyStore {
  private keys: WbiKeys | null = null
  private fetchedAt = 0

  constructor(private readonly ttlMs: number = 6 * 60 * 60 * 1000) {}

  /** Returns cached keys, refreshing them when stale or absent. */
  async get(http: BiliHttp, now: number = Date.now()): Promise<WbiKeys> {
    const isFresh = this.keys !== null && now - this.fetchedAt < this.ttlMs
    if (isFresh && this.keys) return this.keys

    const nav = await fetchNav(http)
    const extracted = extractWbiKeys(nav)
    if (!extracted) {
      throw new Error('WBI keys missing from /x/web-interface/nav — Bilibili likely changed the payload shape')
    }

    this.keys = extracted
    this.fetchedAt = now
    return extracted
  }

  /** Forces the next `get` to refetch. Call after a signature failure. */
  invalidate(): void {
    this.keys = null
    this.fetchedAt = 0
  }
}

/**
 * A room endpoint's refusal: the request arrived, and Bilibili answered a code instead of a room.
 *
 * **The code is a field because the layer above grades on it.** `room_init` documents its code space as
 * `0` for success and `60004` for 直播间不存在 (`RoomInitCode`), and 「the number you pasted names no
 * room」 is a fact about the person's typing rather than about this build's connection — the adapter
 * needs to tell the two apart, and it cannot read that out of a sentence.
 *
 * **Or out of a shape error either, which is the part that used to be wrong.** Parsing the room payload
 * before reading the code means a refusal — which carries no room — fails the parse and arrives as
 * 「unexpected response shape」, throwing away the one field that said what happened. Hence the schemas
 * these two endpoints use tolerate an absent or null `data`, and the readers below read the code first.
 *
 * `message` names no endpoint: `room_init failed for 22637261: …` used to be what a person was shown, and
 * an internal call name is not a sentence. It keeps Bilibili's own words, which is what a log line wants.
 */
export class RoomRefusedError extends Error {
  readonly code: number

  constructor(code: number, detail: string) {
    super(`${detail}（code ${String(code)}）`)
    this.name = 'RoomRefusedError'
    this.code = code
  }
}

/**
 * Resolves the number in a room URL to the real room id.
 *
 * Bilibili distinguishes short ids (`live.bilibili.com/22637261`, what users
 * paste) from real room ids (what every live API expects). `room_init` maps
 * one to the other and also reports the streamer's uid and current status, so
 * it is the single call a monitor needs.
 */
export async function resolveRoom(http: BiliHttp, shortId: number): Promise<RoomInit> {
  const url = `${ROOM_INIT_URL}?id=${String(shortId)}`
  // **The code first, then the room**, and the order is the whole of what a refusal needs: `60004`
  // (直播间不存在) arrives with no room beside it, so a reader that parsed the payload first would report a
  // shape problem where Bilibili had said something exact. `fetchRoomInfo` below reads its own answer the
  // same way, and the two share the idiom rather than a helper because the reader, the message and the URL
  // all differ.
  const response = await http.getJson(url, roomInitSchema)
  if (response.code !== 0) {
    // This request carried the whole cookie jar, so a server that echoes the request back hands back the
    // session; `redact` removes it before the sentence is thrown.
    throw new RoomRefusedError(
      response.code,
      http.redact(refusalWordsOf(response.code, response.msg, response.message))
    )
  }

  const room = response.data
  if (room === undefined || room === null) {
    // Success with no room in it is not a missing room — nothing about the number is established — so it
    // keeps the transport's own class and grade. `RoomRefusedError` is for a Platform that said no.
    throw new BiliHttpError(http.redact(url), 0, UNEXPECTED_ROOM_ANSWER)
  }

  return room
}

/** Fetches richer room metadata, including title and viewer count. */
export async function fetchRoomInfo(http: BiliHttp, roomId: number): Promise<RoomInfo> {
  const url = `${ROOM_INFO_URL}?room_id=${String(roomId)}`
  // Read as `resolveRoom` reads its own: `get_info` answers `1` (不存在) to a `room_id` that is not there,
  // and that refusal carries no room either.
  const response = await http.getJson(url, roomInfoSchema)
  if (response.code !== 0) {
    throw new RoomRefusedError(
      response.code,
      http.redact(refusalWordsOf(response.code, response.msg, response.message))
    )
  }

  const room = response.data
  if (room === undefined || room === null) {
    throw new BiliHttpError(http.redact(url), 0, UNEXPECTED_ROOM_ANSWER)
  }

  return room
}

/**
 * The Anchor's display name for one room — the one read that answers it.
 *
 * **The endpoint is `medal.ts`'s constant, imported rather than spelled again.** It is one endpoint
 * with two readers now: that module reads `data.like_info_v3` for the like gate, this one reads
 * `data.anchor_info.base_info.uname` for a Room's label. A second literal here would be the same
 * fact with two homes, and the day Bilibili moves the path exactly one of them would break — the
 * module that no longer reads it is the one that would go unnoticed. That module's header also
 * records the endpoint's own contract, which this read relies on and states nowhere else: **no WBI
 * and no csrf are needed**, so it answers the cookie-less client `resolveTarget` runs on.
 *
 * **Named for the room, not for a user id, and that is the design decision here.** A name can be had
 * from a profile call as well (`live_user/v1/UserInfo/get_anchor_in_room?roomid=`, whose
 * `data.info.uname` the 直播 field tables list), and a caller that already holds a uid could ask
 * `live_user/v1/Master/info`. Neither is chosen: a caller that is *resolving a room* holds the room
 * id, and this is the payload the room's own page reads, so the name a room reports is the name
 * this build shows. It also keeps `resolveTarget` at one read beyond the room lookup.
 *
 * `roomId` is the real room id, never the number in a pasted URL: `room_init` maps the short id to
 * it, and every caller here holds the real one.
 *
 * A throw is transport or a refusal, exactly as `fetchRoomInfo`'s is — the two share the idiom
 * rather than a helper because the reader, the sentence and the key they take all differ. This read
 * is decorative to its only caller, which decides for itself what a failure means.
 */
export async function fetchAnchorName(http: BiliHttp, roomId: number): Promise<string> {
  const url = `${ROOM_INFO_BY_ROOM_URL}?room_id=${String(roomId)}`
  // The code first, then the anchor, the way both readers above read theirs: this endpoint's refusal is
  // a code (`19002000` 获取初始化数据失败), and a reader that demanded an anchor before reading it would
  // report a shape problem where Bilibili had named a state.
  const response = await http.getJson(url, anchorNameSchema)
  if (response.code !== 0) {
    throw new RoomRefusedError(
      response.code,
      http.redact(refusalWordsOf(response.code, response.msg, response.message))
    )
  }

  // A room that reports no name answers `''`, which is what "nothing to say" has to look like: the
  // caller's fallback is about there being no name, and an invented one would read as a real answer.
  return response.data?.anchor_info.base_info.uname ?? ''
}

/**
 * What a room read says when it reports success and hands over no room.
 *
 * A contract change rather than a verdict, so it is the transport's own class and the transport's own
 * language — `http.ts` composes the other sentences of this kind. It names no endpoint and no field: it
 * becomes part of what a person may read, and the caller's own prefix (`readGraded`'s 「读取直播间信息失败：」)
 * already says which read it was.
 */
const UNEXPECTED_ROOM_ANSWER = 'the answer reported success without a room'

/** A refusal's own words, or a bare code when the envelope said nothing usable. */
function refusalWordsOf(code: number, ...said: readonly (string | undefined)[]): string {
  return said.find(word => word !== undefined && word !== '') ?? `code ${String(code)}`
}

/**
 * True when the room is actively streaming.
 *
 * `Round` (2) is deliberately excluded: in that state Bilibili replays a
 * recording, and sending danmaku into a looped room is not what a monitor
 * keyed on "the streamer went live" should do.
 */
export function isLive(liveStatus: number): boolean {
  return liveStatus === LiveStatus.Live
}

/**
 * Fetches the WebSocket token and endpoint list for a room.
 *
 * NOT CURRENTLY CALLED, and do not wire it up without fixing it first: unlike
 * `/msg/send`, this endpoint requires a WBI signature on the query string, and
 * the call below does not sign. It returns a `v_voucher` payload instead of a
 * token, which surfaces as a confusing schema error rather than an auth one.
 *
 * It exists because reading a room's danmaku stream needs a WebSocket, and that
 * is the natural route for any future feature that reacts to chat. Sending does
 * not — `/msg/send` is plain HTTP.
 */
export async function fetchDanmuInfo(http: BiliHttp, roomId: number): Promise<DanmuInfo> {
  const response = await http.getJson(`${DANMU_INFO_URL}?id=${roomId}&type=0`, danmuInfoSchema)
  if (response.code !== 0) {
    const detail = response.msg ?? response.message ?? `code ${response.code}`
    throw new Error(`getDanmuInfo failed for ${roomId}: ${http.redact(detail)}`)
  }
  return response.data
}

export interface SendDanmakuOptions {
  readonly roomId: number
  readonly message: string
  readonly color?: number
  readonly mode?: DanmakuMode
  readonly fontsize?: number
  readonly webLocation?: string
}

export type SendDanmakuResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: number; readonly error: string }

/**
 * Sends one danmaku.
 *
 * Never throws for API-level failures — a rejected message (rate limit, mute,
 * content filter) is a normal outcome for a scheduler that loops, so it is
 * returned as data for the caller to log and decide on. Transport errors still
 * throw.
 */
export async function sendDanmaku(
  http: BiliHttp,
  wbi: WbiKeyStore,
  options: SendDanmakuOptions
): Promise<SendDanmakuResult> {
  const csrf = http.cookies.csrfToken
  if (!csrf) return MISSING_CSRF

  const signingKeys = await wbi.get(http)
  const query = encodeWbi({ web_location: options.webLocation ?? DEFAULT_WEB_LOCATION }, signingKeys)

  // Field set mirrors Bilibili's own live frontend. Several are effectively
  // constants; `rnd` is a second-level timestamp.
  const form = new FormData()
  form.append('bubble', '2')
  form.append('msg', options.message)
  form.append('color', String(options.color ?? DEFAULT_DANMAKU_COLOR))
  form.append('mode', String(options.mode ?? DanmakuMode.Scroll))
  form.append('fontsize', String(options.fontsize ?? 25))
  form.append('rnd', String(Math.floor(Date.now() / 1000)))
  form.append('roomid', String(options.roomId))
  form.append('room_type', '0')
  form.append('jumpfrom', '0')
  form.append('reply_mid', '0')
  form.append('reply_attr', '0')
  form.append('replay_dmid', '')
  form.append('statistics', '{"appId":100,"platform":5}')
  form.append('csrf', csrf)
  form.append('csrf_token', csrf)

  const response = await http.postForm(`${MSG_SEND_URL}?${query}`, form, sendDanmakuSchema)

  if (response.code !== 0) {
    // A signature error usually means the cached WBI keys rotated.
    if (response.code === SendDanmakuCode.SignError) wbi.invalidate()
    const detail = response.message ?? response.msg ?? `code ${String(response.code)}`
    return {
      ok: false,
      code: response.code,
      // The form body carries `csrf` twice, and a rejected send is the one answer most
      // likely to quote it back; the value sent is redacted alongside the jar's.
      error: http.redact(detail, [csrf])
    }
  }

  return { ok: true }
}

export type { DanmuInfo, RoomInfo, RoomInit }
