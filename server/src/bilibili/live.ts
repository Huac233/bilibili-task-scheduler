import { fetchNav } from './auth.js'
import type { BiliHttp } from './http.js'
import {
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
 * Live-room operations: resolving room ids, reading live status, and sending
 * danmaku.
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
 * Resolves the number in a room URL to the real room id.
 *
 * Bilibili distinguishes short ids (`live.bilibili.com/22637261`, what users
 * paste) from real room ids (what every live API expects). `room_init` maps
 * one to the other and also reports the streamer's uid and current status, so
 * it is the single call a monitor needs.
 */
export async function resolveRoom(http: BiliHttp, shortId: number): Promise<RoomInit> {
  const response = await http.getJson(`${ROOM_INIT_URL}?id=${shortId}`, roomInitSchema)
  if (response.code !== 0) {
    // This request carried the whole cookie jar, so a server that echoes the request
    // back hands back the session; `redact` removes it before the sentence is thrown.
    const detail = response.msg ?? response.message ?? `code ${response.code}`
    throw new Error(`room_init failed for ${shortId}: ${http.redact(detail)}`)
  }
  return response.data
}

/** Fetches richer room metadata, including title and viewer count. */
export async function fetchRoomInfo(http: BiliHttp, roomId: number): Promise<RoomInfo> {
  const response = await http.getJson(`${ROOM_INFO_URL}?room_id=${roomId}`, roomInfoSchema)
  if (response.code !== 0) {
    const detail = response.msg ?? response.message ?? `code ${response.code}`
    throw new Error(`get_info failed for ${roomId}: ${http.redact(detail)}`)
  }
  return response.data
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
