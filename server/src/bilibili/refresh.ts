import { type BiliCredential, buildCredential, isCredentialComplete, isCredentialRefreshable } from './credential.js'
import type { BiliHttp } from './http.js'

/**
 * Session refresh.
 *
 * Bilibili sessions expire, but a credential that carries `ac_time_value` can
 * be extended in place. The flow is two calls:
 *
 *   1. `cookie/info` reports whether the server currently considers the session
 *      to need renewal. This is *not* derived from the cookie's own expiry —
 *      only the server knows, and guessing leads to either refreshing far too
 *      often (looks like abuse) or too late (session already dead).
 *
 *   2. `cookie/refresh` exchanges the refresh token for fresh cookies, which
 *      arrive as `Set-Cookie` on the response and are absorbed by the transport.
 *
 * Because the cookies are replaced in the jar, callers must persist the jar
 * afterwards — and restore the previous credential if persistence fails, so
 * memory and disk cannot disagree about which session is live.
 */

const COOKIE_INFO_URL = 'https://passport.bilibili.com/x/passport-login/web/cookie/info'
const COOKIE_REFRESH_URL = 'https://passport.bilibili.com/x/passport-login/web/cookie/refresh'

export type RefreshOutcome =
  /** Server says the session is fine; nothing was changed. */
  | { readonly status: 'not_required' }
  /** Fresh cookies were obtained. The caller must persist them. */
  | { readonly status: 'refreshed'; readonly credential: BiliCredential }
  /** The stored refresh token is missing or rejected — a re-scan is needed. */
  | { readonly status: 'relogin_required'; readonly reason: string }
  /** The attempt failed for a transient reason; retrying later is reasonable. */
  | { readonly status: 'failed'; readonly reason: string }

interface CookieInfoPayload {
  readonly code?: unknown
  readonly data?: { readonly refresh?: unknown } | undefined
}

/**
 * The refresh response's relevant half.
 *
 * `data.refresh_token` is the *successor* token: Bilibili rotates it on every
 * successful renewal and invalidates the one just used, so ignoring it caps how many
 * times a session can be extended and leaves a dead token in storage.
 */
interface CookieRefreshPayload {
  readonly code?: unknown
  readonly message?: unknown
  readonly data?: { readonly refresh_token?: unknown } | undefined
}

function readJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/**
 * A sentence from below, with the tokens this exchange carries taken out of it.
 *
 * Both renewal calls put the CSRF token in the query string, and the exchange puts it
 * twice more into the form body beside the refresh token. A server that echoes the
 * request back — or a 4xx page that quotes it — hands those straight back, and the
 * reason this module returns is rendered in the UI and written to a row. The transport
 * redacts what its own cookie jar holds; the refresh token is in no jar, so it is
 * handed in as well.
 */
function redacted(http: BiliHttp, text: string, csrfToken: string, refreshToken: string): string {
  return http.redact(text, [csrfToken, refreshToken])
}

/**
 * Asks the server whether the session needs renewal.
 *
 * Returns `null` when the answer is unusable (bad JSON, non-zero code, missing
 * field) so the caller can distinguish "no refresh needed" from "cannot tell".
 * Treating the two as the same is how a session silently expires.
 */
export async function isRefreshRequired(http: BiliHttp, csrfToken: string): Promise<boolean | null> {
  if (csrfToken === '') return null

  const { body } = await http.request(`${COOKIE_INFO_URL}?csrf=${encodeURIComponent(csrfToken)}`, {
    method: 'GET'
  })

  const payload = readJson(body) as CookieInfoPayload | null
  if (payload === null || typeof payload !== 'object') return null
  if (payload.code !== 0) return null

  const flag = payload.data?.refresh
  if (typeof flag === 'boolean') return flag
  // Older responses used 0/1; accept both rather than treating it as unknown.
  if (typeof flag === 'number') return flag !== 0
  return null
}

/**
 * Exchanges the refresh token for new cookies.
 *
 * The CSRF token is sent twice (`csrf` and `csrf_token`) because Bilibili's
 * endpoints are inconsistent about which name they read — the reference
 * implementations send both, and sending one has been observed to fail.
 */
export async function refreshCredential(
  http: BiliHttp,
  csrfToken: string,
  refreshToken: string
): Promise<RefreshOutcome> {
  if (!isCredentialRefreshable(buildCredential(http.cookies.toJSON(), refreshToken))) {
    return { status: 'relogin_required', reason: '凭据缺少 refresh token，需要重新扫码' }
  }

  const form = new FormData()
  form.append('csrf', csrfToken)
  form.append('csrf_token', csrfToken)
  form.append('refresh_token', refreshToken)

  const response = await http.request(COOKIE_REFRESH_URL, { method: 'POST', body: form })

  const payload = readJson(response.body) as CookieRefreshPayload | null
  if (payload === null || typeof payload !== 'object') {
    return { status: 'failed', reason: '刷新接口返回的不是 JSON' }
  }

  const code = payload.code
  if (typeof code === 'number' && code !== 0) {
    const message = payload.message
    const detail =
      typeof message === 'string' && message !== ''
        ? redacted(http, message, csrfToken, refreshToken)
        : `code ${String(code)}`
    // -101 means the session is gone; anything else is worth retrying later.
    if (code === -101 || code === -111) {
      return { status: 'relogin_required', reason: detail }
    }
    return { status: 'failed', reason: detail }
  }

  // The response's Set-Cookie headers were already absorbed by the transport,
  // so the jar now holds the renewed session.
  //
  // The refresh token rotates along with it: the response carries the successor and
  // the one just used stops working. An absent or empty successor means this
  // deployment does not rotate, so the previous token is kept — blanking it would
  // turn a working account into one that needs a re-scan at the next renewal.
  const rotated = payload.data?.refresh_token
  const nextRefreshToken = typeof rotated === 'string' && rotated !== '' ? rotated : refreshToken

  const credential = buildCredential(http.cookies.toJSON(), nextRefreshToken)
  if (!isCredentialComplete(credential)) {
    return { status: 'failed', reason: '刷新后凭据不完整' }
  }

  return { status: 'refreshed', credential }
}

/**
 * Convenience wrapper: checks, and refreshes only when the server says so.
 *
 * The two calls are not interchangeable — exchanging a token the server does not
 * consider due is wasteful and an unnecessary abuse signal — so callers that just
 * want a live session go through here instead of driving the pair themselves.
 */
export async function refreshIfRequired(
  http: BiliHttp,
  csrfToken: string,
  refreshToken: string
): Promise<RefreshOutcome> {
  let required: boolean | null
  try {
    required = await isRefreshRequired(http, csrfToken)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      status: 'failed',
      reason: `检查刷新状态失败：${redacted(http, reason, csrfToken, refreshToken)}`
    }
  }

  if (required === null) {
    return { status: 'failed', reason: '无法判断是否需要刷新' }
  }
  if (!required) return { status: 'not_required' }

  try {
    return await refreshCredential(http, csrfToken, refreshToken)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    return { status: 'failed', reason: `刷新失败：${redacted(http, reason, csrfToken, refreshToken)}` }
  }
}
