import { setTimeout as sleep } from 'node:timers/promises'

import {
  type BiliCredential,
  buildCredential,
  extractCredentialFromUrl,
  isCredentialComplete,
  isCrossDomainLoginUrl
} from './credential.js'
import type { BiliHttp } from './http.js'
import { CookieJar } from './http.js'
import {
  navSchema,
  QR_POLL_EXPIRED,
  QR_POLL_SCANNED,
  QR_POLL_SUCCESS,
  type QrCodePoll,
  qrCodeGenerateSchema,
  qrCodePollSchema
} from './types.js'

/**
 * Login flow.
 *
 * Bilibili has no username/password API for third-party clients, so the only
 * workable approach is the QR handshake the web frontend uses:
 *
 *   1. `qrcode/generate` returns a URL to render as a QR image plus a
 *      `qrcode_key` used to poll.
 *   2. The user scans it in the Bilibili mobile app.
 *   3. `qrcode/poll` reports progress; on `code === 0` the *same response*
 *      carries the `Set-Cookie` headers that constitute the session.
 *
 * There is no refresh flow worth relying on — when the session dies the user
 * scans again.
 */

const PASSPORT_BASE = 'https://passport.bilibili.com/x/passport-login/web'

/**
 * `/x/web-interface/nav`, the one call behind `fetchNav` below.
 *
 * Private because the call is the interface: the WBI key store in `live.ts` wants the
 * same keys, and it goes through `fetchNav` rather than repeating a URL and a schema
 * that would then have two places to drift.
 */
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'

export const QR_LOGIN_URL = `${PASSPORT_BASE}/qrcode/generate`
export const QR_POLL_URL = `${PASSPORT_BASE}/qrcode/poll`

/** Interval the poll loop should use. Bilibili rate-limits aggressive polling. */
export const QR_POLL_INTERVAL_MS = 2_000

/** How long a generated QR code stays valid before it must be regenerated. */
export const QR_TTL_MS = 180_000

/**
 * Requests a fresh QR code to display.
 *
 * The return type is inferred from the schema rather than annotated: the
 * transport hands back the whole envelope (`{ code, message, data }`), and
 * spelling that out by hand here would drift from the schema over time.
 */
export function generateQrCode(http: BiliHttp) {
  return http.getJson(QR_LOGIN_URL, qrCodeGenerateSchema)
}

/**
 * Polls the scan state once. The caller drives the loop so it can render
 * progress and honour cancellation.
 */
export function pollQrCode(http: BiliHttp, qrcodeKey: string) {
  const url = `${QR_POLL_URL}?qrcode_key=${encodeURIComponent(qrcodeKey)}`
  return http.getJson(url, qrCodePollSchema)
}

/** Envelope returned by `pollQrCode`, inferred so it cannot drift from the schema. */
export type PollResponse = Awaited<ReturnType<typeof pollQrCode>>

/** Human-readable status derived from the poll response's inner `code`. */
export type QrScanState = 'success' | 'expired' | 'scanned' | 'pending' | 'unknown'

export function scanStateOf(poll: QrCodePoll): QrScanState {
  switch (poll.code) {
    case QR_POLL_SUCCESS:
      return 'success'
    case QR_POLL_EXPIRED:
      return 'expired'
    case QR_POLL_SCANNED:
      return 'scanned'
    default:
      return 'pending'
  }
}

/**
 * Reads `/x/web-interface/nav`, which doubles as the session validity check
 * and the source of the WBI signing keys.
 *
 * Note the two-layer result: a populated `data` with `isLogin: false` means
 * the cookies are absent or stale, while a non-zero envelope `code` means the
 * request itself was rejected (usually risk control). Callers need both, so
 * the envelope is returned whole.
 */
export function fetchNav(http: BiliHttp) {
  return http.getJson(NAV_URL, navSchema)
}

export interface LoginStatus {
  readonly authenticated: boolean
  readonly mid: number | null
  readonly uname: string | null
  readonly face: string | null
}

/** Calls `nav` and collapses it into a status object. */
export async function checkLogin(http: BiliHttp): Promise<LoginStatus> {
  const nav = await fetchNav(http)
  // A rejected request carries no `data` at all (the envelope is the optional-data
  // variant for exactly that reason). No payload is not a login either, and it is
  // not an error: the caller wants a yes/no, and this is a no.
  const data = nav.data
  if (nav.code !== 0 || data === undefined || !data.isLogin) {
    return { authenticated: false, mid: null, uname: null, face: null }
  }
  return {
    authenticated: true,
    mid: data.mid ?? null,
    uname: data.uname ?? null,
    face: data.face ?? null
  }
}

/**
 * Polls until the QR code is resolved, the code expires, or the deadline
 * passes. Returns the final poll response so the caller can distinguish
 * expiry from timeout.
 *
 * @param onState Invoked on every state change, for UI feedback.
 */
export async function waitForScan(
  http: BiliHttp,
  qrcodeKey: string,
  options: {
    readonly timeoutMs?: number
    readonly intervalMs?: number
    readonly onState?: (state: QrScanState) => void
    readonly signal?: AbortSignal
  } = {}
): Promise<PollResponse> {
  const timeoutMs = options.timeoutMs ?? QR_TTL_MS
  const intervalMs = options.intervalMs ?? QR_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs

  let lastState: QrScanState | null = null
  let latest: PollResponse | null = null

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error('login cancelled')

    latest = await pollQrCode(http, qrcodeKey)
    const state = scanStateOf(latest.data)

    if (state !== lastState) {
      lastState = state
      options.onState?.(state)
    }

    if (state === 'success' || state === 'expired') return latest

    await sleep(intervalMs)
  }

  if (!latest) throw new Error('QR code was never polled')
  return latest
}

/**
 * Builds a jar from a login response. The cookies are already in
 * `http.cookies` (absorbed by the transport on the 302 / poll response); this
 * exists so callers can snapshot and persist them.
 */
export function snapshotCookies(http: BiliHttp): CookieJar {
  return CookieJar.fromJSON(http.cookies.toJSON())
}

/**
 * Turns a successful poll into a usable credential.
 *
 * Two shapes have to be handled:
 *
 *  - **Same domain.** Bilibili appends the cookies to the redirect URL as query
 *    parameters, so they can be read straight off it.
 *
 *  - **Cross domain.** When an SSO session already exists, the URL points at
 *    `passport.biligame.com/crossDomain?ticket=...`. Reading the URL yields
 *    nothing useful; the cookies only materialise after following the redirect,
 *    so that hop is performed explicitly with `redirect: 'follow'`.
 *
 * The credential is preferred from whichever source is complete, because a
 * partially populated credential fails later in ways that look like rate
 * limiting rather than a bad login.
 */
export async function completeLogin(http: BiliHttp, poll: QrCodePoll, refreshToken: string): Promise<BiliCredential> {
  const loginUrl = poll.url

  if (isCrossDomainLoginUrl(loginUrl)) {
    await http.request(loginUrl, { method: 'GET', redirect: 'follow' })

    const fromCookies = buildCredential(http.cookies.toJSON(), refreshToken)
    if (isCredentialComplete(fromCookies)) return fromCookies

    // Some responses still carry the values on the URL even in this path.
    const fromUrl = extractCredentialFromUrl(loginUrl, refreshToken)
    if (isCredentialComplete(fromUrl)) return fromUrl

    return fromCookies
  }

  const fromUrl = extractCredentialFromUrl(loginUrl, refreshToken)
  if (isCredentialComplete(fromUrl)) return fromUrl

  return buildCredential(http.cookies.toJSON(), refreshToken)
}
