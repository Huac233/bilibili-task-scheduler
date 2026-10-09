/**
 * Bilibili credential extraction and validation.
 *
 * The session is not just `SESSDATA`. Bilibili's risk control also reads the
 * device fingerprint cookies (`buvid3` / `buvid4`), and the login response
 * carries a refresh token (`ac_time_value`) that can extend the session without
 * asking the user to scan again. Storing only `SESSDATA` + `bili_jct` produces a
 * session that works for a while and then starts failing in ways that look like
 * rate limiting but are actually a half-populated credential.
 *
 * Reference: the astrbot bilibili plugin's `bilibili-api-python` credential
 * shape, which this mirrors field for field.
 *
 * The wire names are not repeated here: every cookie is read and written through
 * `http.ts`'s `CookieName` table, which is the one place that says what they are.
 */

import { CookieName } from './http.js'

export interface BiliCredential {
  /** Session token. The actual login. */
  readonly sessdata: string
  /** CSRF token, echoed on writes. */
  readonly biliJct: string
  /** Device fingerprint cookies; empty is tolerated but weakly penalised. */
  readonly buvid3: string
  readonly buvid4: string
  /** Numeric account id. */
  readonly dedeUserId: string
  /** Refresh token from the login poll, used to extend the session. */
  readonly acTimeValue: string
}

/** Fields without which the credential cannot be used at all. */
const REQUIRED_FIELDS: readonly (keyof BiliCredential)[] = ['sessdata', 'biliJct', 'dedeUserId']

/**
 * Hosts Bilibili redirects to when a login session is already established for
 * a different product. Following the redirect is what actually yields cookies.
 */
const CROSS_DOMAIN_HOSTS: readonly string[] = ['passport.biligame.com', 'passport.bilibili.com']

/** Builds a credential from a plain cookie map. Missing fields become empty strings. */
export function buildCredential(cookies: Readonly<Record<string, string>>, refreshToken = ''): BiliCredential {
  return {
    sessdata: cookies[CookieName.SessData] ?? '',
    biliJct: cookies[CookieName.Csrf] ?? '',
    buvid3: cookies[CookieName.Buvid3] ?? '',
    buvid4: cookies[CookieName.Buvid4] ?? '',
    dedeUserId: cookies[CookieName.UserId] ?? '',
    acTimeValue: refreshToken
  }
}

/** True when every field needed for authenticated calls is present. */
export function isCredentialComplete(credential: BiliCredential): boolean {
  return REQUIRED_FIELDS.every(field => credential[field] !== '')
}

/**
 * True when the session can be refreshed in place rather than requiring a
 * re-scan. Requires the refresh token on top of the required fields.
 */
export function isCredentialRefreshable(credential: BiliCredential): boolean {
  return isCredentialComplete(credential) && credential.acTimeValue !== ''
}

/**
 * Detects the cross-domain round trip.
 *
 * Shape: `https://passport.biligame.com/crossDomain?ticket=...`. Visiting it
 * sets the session cookies on the target domain, and the cookies it sets are
 * the ones actually valid for API calls.
 */
export function isCrossDomainLoginUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (!CROSS_DOMAIN_HOSTS.includes(parsed.hostname)) return false
  if (!parsed.pathname.endsWith('/crossDomain')) return false
  return parsed.searchParams.has('ticket')
}

/**
 * Reads a credential out of the login URL's query string.
 *
 * Used for the ordinary (same-domain) success case, where Bilibili simply
 * appends the cookies to the redirect URL instead of setting them.
 */
export function extractCredentialFromUrl(url: string, refreshToken = ''): BiliCredential {
  let query: URLSearchParams
  try {
    query = new URL(url).searchParams
  } catch {
    query = new URLSearchParams()
  }

  return {
    sessdata: query.get(CookieName.SessData) ?? '',
    biliJct: query.get(CookieName.Csrf) ?? '',
    buvid3: query.get(CookieName.Buvid3) ?? '',
    buvid4: query.get(CookieName.Buvid4) ?? '',
    dedeUserId: query.get(CookieName.UserId) ?? '',
    acTimeValue: refreshToken
  }
}

/**
 * Converts a credential into the cookie map the HTTP transport replays.
 *
 * `ac_time_value` is deliberately excluded: it is a refresh token, not a
 * cookie, and sending it as one is both wrong and a needless leak.
 */
export function credentialToCookies(credential: BiliCredential): Record<string, string> {
  const cookies = credentialToSessionCookies(credential)
  if (credential.buvid3 !== '') cookies[CookieName.Buvid3] = credential.buvid3
  if (credential.buvid4 !== '') cookies[CookieName.Buvid4] = credential.buvid4
  return cookies
}

/**
 * The cookies that **are** the session — the three without which a credential cannot be used at all.
 *
 * **This set exists because a read was measured to need this much and no more.** `getInfoByRoom`, the one
 * read that answers a Room's Anchor name (`live.ts`'s `fetchAnchorName`), is refused when asked with no
 * cookie: `200` `{"code":-352,"message":"-352","ttl":1}`, no `data` at all. Measured 2026-10-09 for room
 * 14709735, **one cookie set per call**:
 *
 *     buvid3 alone                       -> -352, no data
 *     SESSDATA alone                     -> -352, no data
 *     SESSDATA + bili_jct                -> -352, no data
 *     SESSDATA + bili_jct + DedeUserID   -> code 0, data.anchor_info.base_info.uname = 「炫神_」
 *     the whole stored jar               -> code 0, the same name
 *
 * The last line is the control rather than a sixth candidate: it was answered in the same minute the
 * subsets were refused, so those refusals are about the cookie set and not about a risk-controlled
 * caller. Two things follow. **The device cookies are not what that read needs** — `buvid3` alone is
 * refused, and the jar that is answered is answered by these three alone, so a client built from this
 * set sends a request that carries its need and nothing wider. **And the account's identity is what it
 * needs**: `DedeUserID` is the whole difference between the two three-cookie calls, and since the answer
 * is the room's own name, the label depends on *some* account's session travelling rather than on which
 * account is selected.
 *
 * `REQUIRED_FIELDS` above names the same three fields; this is that list as cookies, and
 * `tests/credential.test.ts` couples them — dropping any one of these cookies has to make
 * `isCredentialComplete` say no, so the two cannot drift apart in silence.
 */
export function credentialToSessionCookies(credential: BiliCredential): Record<string, string> {
  return {
    [CookieName.SessData]: credential.sessdata,
    [CookieName.Csrf]: credential.biliJct,
    [CookieName.UserId]: credential.dedeUserId
  }
}

/**
 * Redacted summary for logs. Never log the credential itself — `SESSDATA` is
 * a bearer token, and a leaked one lets anyone act as the account.
 */
export function describeCredential(credential: BiliCredential): string {
  return [
    `uid=${credential.dedeUserId === '' ? '<missing>' : credential.dedeUserId}`,
    `sessdata=${credential.sessdata === '' ? 'missing' : `${String(credential.sessdata.length)}ch`}`,
    `biliJct=${credential.biliJct === '' ? 'missing' : `${String(credential.biliJct.length)}ch`}`,
    `buvid=${credential.buvid3 === '' ? 'none' : 'present'}`,
    `refreshable=${isCredentialRefreshable(credential) ? 'yes' : 'no'}`
  ].join(' ')
}
