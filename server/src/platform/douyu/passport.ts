import type { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { type ZodType, z } from 'zod'

import { type Account, upsertAccount } from '../../repo/accounts.js'
// The credential values this module's two hops carry — the device id, the session cookie, the second
// hop's `Location` and the one-time `code` in it — go through the shared value rule; the local copy
// this file used to keep was one of five, and the reason that is now one module is at the top of
// `platform/bilibili/index.ts`. Its warning travels with the rule: a one-character value must never
// be added to the list a caller passes (`redactSecrets`'s own note).
import { redactSecrets } from '../../text/redact.js'
// The blob's contract, which this module *writes* rather than defines: the parser and the session
// cookie's name both live with the adapter that reads them. `index.ts` imports `renewFamily` back
// from here, so the two are cyclically dependent on purpose — each side uses the other's exports
// only *inside functions*, never at module scope, so neither is ever evaluated against a
// half-initialised other. A third module owning the blob contract is the alternative, and it is a
// bigger move than the one exchange this needs.
import { parseCredential, SESSION_COOKIE } from './index.js'

/**
 * Douyu scan login, and the web route's renewal of what it lands.
 *
 * This module writes the two kinds of credential blob the adapter can read: the
 * one a scan produces (`completeBind`) and the one a person pastes
 * (`storePastedCredential`). The second exists because the accounts view already
 * ships the form; the first is the real flow, and the two write through the same
 * serializer and the same parser, so there is one blob shape here and not two.
 * `renewFamily` writes that same shape a third time — the same credential, six days
 * later — which is why the family's own clock travels in the blob rather than in this
 * module's memory: a credential that cannot say when its family lapses can only be
 * renewed blind, and renewing blind means renewing on every check.
 *
 * Douyu publishes no password API a third party may use, and the app's requests
 * are signed inside the native client, so the one path that works is the QR
 * handshake the login page itself performs:
 *
 *   1. `POST /scan/generateCode` answers a `code` and the `url` that **is** the QR
 *      content (`makeQrCode(data.url)` → `$qrCon.qrcode({text: url})` — a string to
 *      encode, not an image address), plus the code's own `expire`.
 *   2. The user scans it in the Douyu app and confirms on the phone.
 *   3. `GET /japi/scan/auth?time=<ms>&code=<code>` reports progress; on `error: 0`
 *      its `data.url` is a landing link to `www.douyu.com/api/passport/login`, and
 *      **that** GET is what lands the web session's cookies.
 *
 * **The web route is picked over the PC one deliberately.** The same code can be
 * polled by `GET /lapi/passport/scan/auth` (the PC client's poll) instead, which
 * answers a `short_token` bundle and **no `url`** — so it yields a composite token
 * and nothing else. The two tokens are equivalents (`h5nc/*` was measured accepting
 * both, §2.2 and §4); the **jar** is the difference, and it is not a bonus:
 * `HANDOFF.md` §4 measured the `www.douyu.com/japi/*` family (钓鱼 / 粉丝家园 /
 * 等级任务) refusing a bare token with `1002 用户未登录` however many csrf cookies are
 * added to it, so a bind that drops the jar is a bind that leaves three actions
 * permanently shut. The PC route cannot produce one at all — its success payload has
 * no landing link to follow.
 *
 * **And the same web route is what renews one, which this module also owns.**
 * `renewFamily` replays the two hops a browser makes when it wants a fresh family out of
 * the long login it is already holding: `GET …/wgapi/member/passport/safeAuth`, which
 * answers `302` with a one-time `code` in its `Location`, and a `GET` of that `Location`,
 * which lands the whole new `acf_*` family on its own `Set-Cookie` list. No signature
 * appears anywhere on it, and that is the difference from the PC client's
 * `POST /app/getShortToken`: that one wants `auth=<32 hex>`, and a single-variable test
 * settled the question this repo had left open — the same token and the same request
 * answered `error 0` with the client's own signature against `1004` with an all-zero one —
 * so its algorithm is a blocker this project has no record of, while this route has no
 * equivalent of it. The measurements are in the LTP0-remint probe note of 2026-10-08
 * (`douyu-ltp0-family-remint-2026-10-08.md`), and what they establish is exactly what the
 * two hops below rely on: `LTP0` is the only key (without it the first hop answers
 * `error 16 未登录,请重新登录` and lands no cookie at all, while with it the state of
 * `dy_auth` and of the entire old family changes nothing), and what comes back is new
 * values rather than an echo of the ones that were sent.
 *
 * Three facts about the credential, each of them paid for once already:
 *
 *  - **The composite token's split runs from both ends.** `stk` may itself contain
 *    an underscore, so splitting on the first four underscores from the left shifts
 *    every field after it — a failure that surfaces on the danmaku socket as
 *    `401000206`, which reads exactly like a wrong key. `index.ts`'s
 *    `parseCredential` owns that rule and this module never re-implements it: the
 *    assembled string is handed to that parser, and a blob it cannot read is
 *    refused rather than written.
 *
 *  - **`expiresAt` is the session cookie's own clock, in milliseconds.** It is the
 *    `Set-Cookie` expiry the service declared for `LTP0` — the cookie the long login
 *    actually rests on, `Max-Age=15768000` (182.5 days, §3), issued by this flow's own
 *    poll endpoint — and it is read out of the jar because those attributes are the
 *    only statement of that session's life anywhere: both long-lived Douyu cookies are
 *    ciphertext with nothing readable inside them (§6). `expire_in` says nothing about
 *    this session: it is a *token* lifetime (`604800` in §2.1) belonging to the PC
 *    route, which this module never calls and whose bundle the web route's success
 *    payload does not carry at all (§7). So it is no longer read here. A jar without
 *    the session cookie writes no `expiresAt`: a binder that says "unknown" is cheaper
 *    than one that invents a window. **Nothing turns that stamp into a verdict** — the
 *    adapter's `refresh` never reads it, for any Douyu account, because no local signal
 *    can judge a token dead — so the stamp is a fact a person can read off the row, not a
 *    clock anything grades.
 *
 *  - **`tokenExpiresAt` is the token family's own clock, and it is the one stamp something
 *    does grade.** The five `acf_*` components arrive together and are declared together
 *    (`Max-Age=529200`, 6.125 days), so the family's life is the shortest life any of them
 *    stated, read out of the jar for the same reason `expiresAt` is. What reads it is
 *    `refresh`, and only to answer "is it time to rebuild this family yet": a response that
 *    declares no life at all still leaves a clock this module can state, because the family
 *    landed at an instant it knows (`FAMILY_LIFE_MS` from then), and an absent clock would
 *    mean rebuilding on every check. It is storage for a *schedule*, never a verdict: a
 *    family past its stamp is rebuilt, not declared dead.
 *
 *  - **`webCookies` must never be attached to an `h5nc/*` request.** Sending a web
 *    cookie beside a perfectly valid composite token is what turns
 *    `h5nc/sign/getSign` into `999999 系统错误` (§2.2) — the single most expensive
 *    discovery on this platform, because it made a valid session look like a bad
 *    token and sent a whole line of work chasing a signature. The adapter stores
 *    this jar and never sends it; nothing in *this* module sends it anywhere
 *    either, because no request it makes belongs to the `h5nc/*` family.
 *
 * **No message here carries a credential.** The composite token, the device id and
 * the cookie header are the account, and the adapter's rule — a code is graded on
 * its number, never on a substring of a message — applies to what is *said* about
 * a failure as well: every error text below is a fixed sentence or the service's
 * own `msg`, never an echo of a value.
 */

/* ------------------------------------------------------------------ *
 * Endpoints and cadence
 * ------------------------------------------------------------------ */

/**
 * The login page, and the only origin this flow talks to.
 *
 * The QR family needs no `auth` parameter and no signature: a browser cannot
 * compute the native client's signature, so this family authenticates by cookie
 * (§2.1). `auth` is therefore not invented here — the one endpoint that checks it,
 * `/scan/code`, answers `1004 api身份信息验证失败` and is not on this path.
 */
const PASSPORT_ORIGIN = 'https://passport.douyu.com'
const LOGIN_PAGE = `${PASSPORT_ORIGIN}/member/login`

/** The page a browser has already loaded by the time it asks for a QR code. */
export const LOGIN_PAGE_URL = LOGIN_PAGE

/** `POST`, form body — the page's own `qrGenerateCode`. */
export const GENERATE_CODE_URL = `${PASSPORT_ORIGIN}/scan/generateCode`

/** `GET`, `?time=<ms>&code=<code>` — the page's own `qrCheckScan`. */
export const SCAN_POLL_URL = `${PASSPORT_ORIGIN}/japi/scan/auth`

/**
 * Poll cadence, and how long a generated code is worth polling for.
 *
 * The page's own loop uses 1000 ms (`loopCheck`'s `var e = 1e3`), one second tighter
 * than the Bilibili flow's 2 s interval, and both exist for the same reason: a poll
 * loop must not hammer the service. The *route* paces nothing — a poll there is one
 * HTTP request from the frontend, which cannot outrun its own requests — so this is
 * the cadence `waitForScan` uses and the one a caller that owns the loop should use.
 *
 * The lifetime is the response's own `expire`, which was measured at `300` twice
 * (an earlier probe and a cold call this build made), with `qrLifetimeMs` falling
 * back to this constant when the field is missing or nonsensical.
 */
export const QR_POLL_INTERVAL_MS = 1_000
export const QR_TTL_MS = 300_000

/**
 * The deadline for one request on this flow.
 *
 * Stated here rather than shared with the action-side transport: this module talks to
 * exactly one origin and is deliberately standalone (see the class below), so it
 * carries its own house-default ceiling of 15 s instead of reaching across for it.
 */
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * A desktop Chrome UA.
 *
 * `douyu-qr-full.mjs` sent this exact string and `douyu-fresh-account.mjs` sent a
 * bare `Mozilla/5.0`; both were answered, so the value is a plausible browser's, not
 * part of a contract. Nothing here is selected by it.
 *
 * Byte-identical to `protocol.ts`'s `PC_USER_AGENT`, and kept separate on purpose: this
 * module talks to one origin with its own jar and is deliberately standalone, so a
 * shared header constant would make the login flow depend on the action layer. That is
 * the coupling to resolve first if these two are ever unified — not the string.
 */
const PASSPORT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * The two parameters the page's own request is built from:
 * `{client_id: window.client_id || 1, isMultiAccount: j}`, with `j` the
 * `isMultiAccount` location parameter defaulting to `0`.
 *
 * The claim that a bare call answers `{"error":1,"系统异常，请重试"}` is **not**
 * trusted: `HANDOFF.md` §9.2 retracts it and §7's table records the measurement
 * that replaced it — three bodies (`client_id=1`, `client_id=1&isMultiAccount=0`,
 * and one with extra parameters) all answered `error: 0`. It is still this shape
 * that is sent, because it is the page's own parameter set, observed in the bundle
 * and exercised by both verified probes; a cold call made while writing this module
 * answered `error: 0` as well.
 */
const CLIENT_ID = '1'
const IS_MULTI_ACCOUNT = '0'

/** The three verdicts the page names. See `scanStateOf` for why nothing else needs one. */
export const SCAN_DONE = 0
export const SCAN_CONFIRMING = 1
export const SCAN_FAILED = -1

/**
 * The headers the page's own ajax carries on this origin.
 *
 * `X-Requested-With` is what jQuery sends for any of its calls and what the verified
 * probes sent by hand; `Origin` is redundant on a same-origin request and the page
 * itself does not send it, but it is here because it is part of the header set that
 * was exercised — a header the service has already accepted is cheaper than a theory
 * about which of them it reads. The client fills in `User-Agent` and `Referer`.
 */
const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'x-requested-with': 'XMLHttpRequest',
  origin: PASSPORT_ORIGIN
}

/* ------------------------------------------------------------------ *
 * Response schemas
 * ------------------------------------------------------------------ */

/**
 * Douyu types the same number as a JSON number or as a numeric string, so every
 * numeric field in this flow's envelopes passes through this.
 *
 * The union is the gate and `z.coerce.number()` does the retyping: a bare `Number()`
 * transform parsed anything it was given, `'abc'` included, as a *successful* `NaN`,
 * while a bare `z.coerce.number()` would accept `null` as `0` — and `0` here is a
 * verdict (`SCAN_DONE`), not a missing value.
 */
const numeric = z.union([z.number(), z.string()]).pipe(z.coerce.number())

/**
 * The verdict, without the payload.
 *
 * `data` is left unvalidated on purpose. A refusal puts its prose wherever it
 * likes — `999999` arrives as `{"error":999999,"data":"系统错误"}`, which
 * `protocol.ts` already documents — so an envelope that insists `data` is an
 * object turns a service verdict into a parse failure, and a parse failure here is
 * a thrown transport error, which is exactly the confusion this module exists to
 * avoid. The success payload is schema-checked by `qrCodeDataOf` /
 * `scanSuccessOf`, where there is actually something to check.
 */
const envelopeFields = {
  error: numeric,
  msg: z.string().optional()
} as const

function envelopedOptionalData() {
  return z.object({ ...envelopeFields, data: z.unknown().optional() }).catchall(z.unknown())
}

/** `POST /scan/generateCode` — `{error, data?: {code, url, expire}}`. */
export const generateCodeSchema = envelopedOptionalData()

/** `GET /japi/scan/auth` — `{error, data?: {url, ...}}`. */
export const scanPollSchema = envelopedOptionalData()

/**
 * The QR payload, narrowed to what this module uses.
 *
 * `url` is the QR **content**; `code` keys the poll; `expire` is the code's life
 * in seconds and is what the bind session's deadline is taken from.
 */
export const generateCodeDataSchema = z.object({
  code: z.string().min(1),
  url: z.string().min(1),
  expire: numeric.optional()
})
export type GenerateCodeData = z.infer<typeof generateCodeDataSchema>

/**
 * The success payload of a poll.
 *
 * `url` is the landing link the page follows through a JSONP GET
 * (`appClientSuccessHandler` → `getAppClientSuccessJSONP`), and it is required:
 * without it there is no way to land the web session, so a "success" that carries
 * none is a refusal here rather than a silent second-class bind.
 *
 * **`short_token` is not declared, and it was measured never to arrive.** That bundle
 * belongs to the PC route's poll (`/lapi/passport/scan/auth`, the route the note at the
 * top of this file rejected) and the web route does not carry it: the captured success
 * payload is, verbatim,
 * `{"data":{"isAutoReg":0,"provider":"dyapp","url":"…loginType=scanCheck…"},"error":0,"msg":"success"}`
 * (§7 — and §9.2's instruction is exactly this, that a field of a route we do not call
 * must not stay behind as a clock-shaped hole). What the same response *does* carry is
 * the session itself: `LTP0` on its `Set-Cookie` list, which `absorb` now keeps the
 * expiry of, so the credential's clock comes from the jar rather than from this payload.
 *
 * `logoutUrls` is deliberately not declared and not acted on. The page uses it to
 * sign the *browser's other session* out first (`logout-with-login`), which is a
 * state a server-side jar cannot be in — this flow starts from an empty jar and
 * never holds a second account's cookies.
 */
export const scanSuccessSchema = z.object({
  url: z.string().min(1)
})
export type ScanSuccess = z.infer<typeof scanSuccessSchema>

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

/** Thrown when the transport itself fails — network, deadline, non-2xx. */
export class PassportHttpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PassportHttpError'
  }
}

/** A raw response plus its body, used when the caller needs the status or headers. */
interface RawResponse {
  readonly status: number
  readonly headers: Headers
  readonly body: string
}

export interface PassportHttpOptions {
  readonly timeoutMs?: number
  readonly userAgent?: string
  readonly referer?: string
}

/**
 * The one client a bind flow uses.
 *
 * It repeats `bilibili/http.ts`'s shape — a jar that absorbs every `Set-Cookie` and
 * is replayed on later requests, a fixed deadline per request, `redirect: 'manual'`
 * by default — rather than reaching into it, which is the same choice
 * `douyu/index.ts` makes for its room read: the Bilibili transport carries Bilibili
 * defaults (its referer, its `CookieName` table) that have no business inside a
 * Douyu flow.
 *
 * The jar keeps names, values, and the expiry each `Set-Cookie` declared — not path and
 * not domain, which is the shape both this repository's transports have (§7 records the
 * missing path as real and pre-existing). Here the two omissions cost nothing — the flow
 * talks to one origin and the landing hop is asked for the session it already has —
 * while the expiry is the one attribute that cannot be dropped: it is the *only* place
 * this session's lifetime is ever stated (§3), and it is gone the moment the response is
 * discarded. `absorb` below is also the reason it survives at all, so it is where the
 * rule about which attribute wins is written down.
 *
 * `redirect: 'manual'` is not a detail. A login-completion hop that answers `302`
 * can carry the session cookies **on the redirect**, and following it automatically
 * throws those headers away — the mistake `bilibili/http.ts` documents having
 * already been made once.
 */
export class PassportHttp {
  private readonly jar = new Map<string, string>()
  /** When each jar entry stops being good for, in milliseconds. See `absorb`. */
  private readonly expiries = new Map<string, number>()
  private readonly timeoutMs: number
  private readonly userAgent: string
  private readonly referer: string

  constructor(options: PassportHttpOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.userAgent = options.userAgent ?? PASSPORT_USER_AGENT
    this.referer = options.referer ?? LOGIN_PAGE
  }

  /** One request, carrying the jar and absorbing whatever the response sets. */
  async request(url: string, init: RequestInit = {}): Promise<RawResponse> {
    const headers = new Headers(init.headers)
    if (!headers.has('User-Agent')) headers.set('User-Agent', this.userAgent)
    if (!headers.has('Referer')) headers.set('Referer', this.referer)

    const cookieHeader = this.cookieHeader()
    if (cookieHeader !== '') headers.set('Cookie', cookieHeader)

    // The caller's own signal is composed with the deadline rather than replaced:
    // spreading `init` first and then setting `signal` would drop it silently, so a
    // caller that had given up would leave the request running to the deadline.
    // `AbortSignal.timeout` arms an unref'd timer — nothing to clear once the body
    // is in — and an expiry reports `TimeoutError` where the hand-rolled controller
    // could only ever say `AbortError`.
    const deadline = AbortSignal.timeout(this.timeoutMs)
    const signal = init.signal == null ? deadline : AbortSignal.any([deadline, init.signal])

    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        headers,
        signal,
        redirect: init.redirect ?? 'manual'
      })
    } catch (error: unknown) {
      // No URL and no body in the message: this one can be logged, and the URLs on
      // this path carry the scan code and the account's uid.
      throw new PassportHttpError(`passport 请求失败：${reasonText(error)}`)
    }

    const setCookies = response.headers.getSetCookie()
    if (setCookies.length > 0) this.absorb(setCookies)

    // The signal is still live for the body: `fetch` resolves on headers, and a
    // deadline that covered only those would leave a slow body unbounded.
    const body = await response.text()

    if (response.status >= 400) throw new PassportHttpError(`passport 返回 HTTP ${String(response.status)}`)

    return { status: response.status, headers: response.headers, body }
  }

  /** `GET` returning JSON validated against `schema`. */
  async getJson<T>(url: string, schema: ZodType<T>, headers: Readonly<Record<string, string>> = {}): Promise<T> {
    return await this.requestJson(url, schema, { method: 'GET', headers: { ...headers } })
  }

  /** `POST` with a form-encoded body, returning JSON validated against `schema`. */
  async postForm<T>(
    url: string,
    form: Readonly<Record<string, string>>,
    schema: ZodType<T>,
    headers: Readonly<Record<string, string>> = {}
  ): Promise<T> {
    return await this.requestJson(url, schema, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        ...headers
      },
      body: new URLSearchParams(form).toString()
    })
  }

  /** The jar as a `Cookie:` request header value. */
  cookieHeader(): string {
    const parts: string[] = []
    for (const [name, value] of this.jar) parts.push(`${name}=${value}`)
    return parts.join('; ')
  }

  /** One cookie's value, or `undefined`. */
  cookieValue(name: string): string | undefined {
    return this.jar.get(name)
  }

  /**
   * Puts one cookie into the jar by hand, with no clock of its own.
   *
   * The renewal is the only caller, and it is the reason this exists: its first hop must carry
   * `LTP0` and the two device cookies that were captured on it, while the thing those values come
   * from is a stored `Cookie:` header — pairs, with no attributes at all — so there is no
   * `Set-Cookie` here to absorb. The expiry is dropped rather than guessed, which is what
   * `absorb` already does with a response that declared none: a value put in by hand lasts
   * exactly as long as the jar does.
   */
  setCookie(name: string, value: string): void {
    this.jar.set(name, value)
    this.expiries.delete(name)
  }

  /**
   * When the jar's copy of `name` stops being good for, in milliseconds, or null when
   * the `Set-Cookie` that delivered it declared no expiry — a session cookie, which
   * lives exactly as long as the jar does — or when no such cookie was ever absorbed.
   *
   * This is what keeping the attributes is for, and the reason it matters on this
   * platform: neither long-lived Douyu cookie can be read for a clock (both are
   * ciphertext, §6), so the `Set-Cookie` that minted one is the only statement of its
   * life there will ever be. `completeBind` reads the session cookie's value through
   * this rather than through a lifetime guessed from a route this module does not call.
   */
  cookieExpiresAt(name: string): number | null {
    return this.expiries.get(name) ?? null
  }

  /**
   * Merges `Set-Cookie` headers into the jar, expiry attribute included.
   *
   * The `name=value` pair is what gets replayed; the one attribute kept beside it is the
   * one that says when the pair stops being true. `Max-Age` wins when it is declared and
   * `Expires` is the fallback, which is the order RFC 6265 gives and what a browser does
   * — and the difference is not academic here, because the service sends dates in a
   * spelling of its own (`Wed, 14-Oct-2026 01:23:09 GMT`, §2.2), so a jar that trusted
   * `Expires` first would be trusting the form most likely to be unparseable. `Max-Age`
   * is seconds *from this moment*, so it is turned into an instant on arrival; that is
   * the only conversion this module performs on a clock, and it is why the value is
   * recorded rather than the attribute.
   *
   * A `Set-Cookie` declaring neither attribute states that the value lasts as long as the
   * jar does, so any expiry an earlier declaration of the same name had left is dropped:
   * the newest declaration of a name is the one that describes the jar now.
   *
   * An empty value, the literal `deleted` (how this service tombstones one), or a
   * `Max-Age` at or below zero removes the entry outright — with its expiry, which must
   * not outlive the value it belonged to.
   *
   * **No lifetime is ever read out of a cookie's *name* here.** One name can carry two
   * different lives: `acf_auth` arrives as 529200 from `www.douyu.com/api/passport/login`
   * and as 3600 from `apiv2.douyucdn.cn/H5nc/welcome/to`, and `acf_ccn` is 7200 from one
   * endpoint and 604800 from another (§3). The `Set-Cookie` that delivered a value is the
   * only thing that says how long that value is good for.
   */
  private absorb(setCookieHeaders: readonly string[]): void {
    for (const header of setCookieHeaders) {
      const [pair = '', ...attributes] = header.split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (name === '') continue

      const maxAgeSeconds = maxAgeOf(attributeOf(attributes, 'max-age'))
      // `Max-Age=0` is the service's other spelling of the tombstone `deleted` marks.
      if (value === '' || value === 'deleted' || maxAgeSeconds === 0) {
        this.jar.delete(name)
        this.expiries.delete(name)
        continue
      }

      this.jar.set(name, value)
      const expiresAt =
        maxAgeSeconds === null ? dateOf(attributeOf(attributes, 'expires')) : Date.now() + maxAgeSeconds * 1000
      if (expiresAt === null) this.expiries.delete(name)
      else this.expiries.set(name, expiresAt)
    }
  }

  private async requestJson<T>(url: string, schema: ZodType<T>, init: RequestInit): Promise<T> {
    const { body } = await this.request(url, init)

    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch (error: unknown) {
      throw new PassportHttpError(`passport 响应不是 JSON：${reasonText(error)}`)
    }

    const result = schema.safeParse(parsed)
    if (!result.success) {
      const issue = result.error.issues[0]
      const where = issue?.path.join('.') ?? '<root>'
      const detail = issue?.message ?? 'unknown validation error'
      throw new PassportHttpError(`passport 响应形状异常（${where}）：${detail}`)
    }
    return result.data
  }
}

/* ------------------------------------------------------------------ *
 * The flow
 * ------------------------------------------------------------------ */

/**
 * Requests a fresh QR code: warm the page, then ask.
 *
 * The warm-up is the page's own starting state — a browser showing the login box has
 * already fetched `/member/login` — and it is what the verified web-route probe did
 * before this call. **It was then measured not to be required for the call itself**:
 * a cold `generateCode`, with no jar and no warm-up, answered
 * `{"error":0,"data":{"expire":300,"url":…,"code":…}}` with **no `Set-Cookie` at
 * all**. It is kept anyway, because the *poll* and the landing hop were only ever
 * exercised with the page's cookie state in the flow's jar — and one request is
 * cheaper than an untested assumption about which half of this handshake wants it.
 *
 * Returns the whole envelope: a refusal is a verdict, not an exception, and the
 * caller decides how to show it. The return type is inferred from the schema rather
 * than annotated — spelling the envelope out by hand here is exactly how it drifts
 * from the schema later.
 */
export async function generateCode(http: PassportHttp) {
  await http.request(LOGIN_PAGE, { method: 'GET', redirect: 'follow' })
  return await http.postForm(
    GENERATE_CODE_URL,
    { client_id: CLIENT_ID, isMultiAccount: IS_MULTI_ACCOUNT },
    generateCodeSchema,
    PAGE_HEADERS
  )
}

/**
 * Polls the scan state once. The caller drives the loop — over HTTP that means one
 * request per poll — so it can render progress and honour cancellation.
 *
 * `time` is the current **millisecond** stamp, which is what the page sends
 * (`"/japi/scan/auth?time=" + (new Date).getTime()`).
 */
export function pollScan(http: PassportHttp, code: string) {
  const url = `${SCAN_POLL_URL}?time=${String(Date.now())}&code=${encodeURIComponent(code)}`
  return http.getJson(url, scanPollSchema, PAGE_HEADERS)
}

/** Envelope returned by `generateCode`, inferred so it cannot drift from the schema. */
export type GenerateCodeResponse = Awaited<ReturnType<typeof generateCode>>

/** Envelope returned by `pollScan`, inferred so it cannot drift from the schema. */
export type PollResponse = Awaited<ReturnType<typeof pollScan>>

/**
 * Human-readable status derived from the poll's `error`.
 *
 * `-1` is named `expired` and covers both halves of what the page treats as one
 * state: `scan-fail` resets to a fresh code, which is what an invalid code and an
 * expired code both produce, and the response does not distinguish them. The
 * distinction is reported as a question rather than invented.
 *
 * Everything else is `pending`. That is not laziness: the page's `loopCheck`
 * switches on exactly `0`, `1` and `-1` and falls through to the same "keep
 * polling" branch for anything else, so no other value has a meaning to mirror.
 * In particular `-2 客户端还未扫码` is recorded on **this** endpoint as well —
 * `tests/captured`-adjacent dump `dump-scan-auth.txt` has eight `/japi/scan/auth`
 * responses reading `{"error":-2,"msg":"客户端还未扫码"}` before the ninth answers `1` and the
 * tenth `0` — so `-2` lands in the `default` branch below by its **own** name rather than by
 * not existing here. (`HANDOFF.md` §12 records `-2` against `/lapi/passport/qrcode/check`,
 * the *outdated* endpoint a probe used by mistake; that is not the only endpoint that says it,
 * and a mapping that assumed so was resting on a fact that happened to hold for the wrong
 * reason. The verdict — `pending` either way — has always been right.)
 */
export type QrScanState = 'success' | 'scanned' | 'expired' | 'pending'

export function scanStateOf(poll: PollResponse): QrScanState {
  switch (poll.error) {
    case SCAN_DONE:
      return 'success'
    case SCAN_CONFIRMING:
      return 'scanned'
    case SCAN_FAILED:
      return 'expired'
    default:
      return 'pending'
  }
}

/** The QR payload of a `generateCode` response, or null when it was refused. */
export function qrCodeDataOf(response: GenerateCodeResponse): GenerateCodeData | null {
  const parsed = generateCodeDataSchema.safeParse(response.data)
  return parsed.success ? parsed.data : null
}

/** The landing payload of a poll, or null when the payload is not the documented shape. */
export function scanSuccessOf(poll: PollResponse): ScanSuccess | null {
  const parsed = scanSuccessSchema.safeParse(poll.data)
  return parsed.success ? parsed.data : null
}

/**
 * The service's own prose for a refusal, for a person to read.
 *
 * `msg` first, then a string `data`: Douyu puts the sentence in either place, and
 * `protocol.ts` already records `{"error":999999,"data":"系统错误"}` as the second
 * case. A payload with neither gets a sentence built from the code alone.
 */
export function refusalText(response: {
  readonly error: number
  readonly msg?: string | undefined
  readonly data?: unknown
}): string {
  if (typeof response.msg === 'string' && response.msg !== '') return response.msg
  if (typeof response.data === 'string' && response.data !== '') return response.data
  return `斗鱼返回错误码 ${String(response.error)}`
}

/** The code's life in milliseconds, from the response's own `expire`. */
export function qrLifetimeMs(expireSeconds: number | undefined): number {
  if (expireSeconds === undefined || !Number.isFinite(expireSeconds) || expireSeconds <= 0) return QR_TTL_MS
  return expireSeconds * 1_000
}

/**
 * Polls until the QR code is resolved, the code expires, or the deadline passes.
 *
 * The loop helper the Bilibili flow has under the same name, with the same rules:
 * `onState` fires on change rather than on every poll, the deadline is checked
 * *before* each request so a slow service cannot extend it, and cancellation is
 * honoured through an `AbortSignal`. The routes do not use it — a route polls one
 * step per HTTP request — but a caller that owns the loop (a script, or a test)
 * should not have to re-derive the cadence or the deadline.
 */
export async function waitForScan(
  http: PassportHttp,
  code: string,
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
    if (options.signal?.aborted === true) throw new Error('login cancelled')

    latest = await pollScan(http, code)
    const state = scanStateOf(latest)

    if (state !== lastState) {
      lastState = state
      options.onState?.(state)
    }

    if (state === 'success' || state === 'expired') return latest

    await sleep(intervalMs)
  }

  if (latest === null) throw new Error('QR code was never polled')
  return latest
}

/* ------------------------------------------------------------------ *
 * From a confirmed scan to a stored account
 * ------------------------------------------------------------------ */

/**
 * The five cookies whose values, joined in this order, are the composite token.
 *
 * `<uid>_<biz>_<stk>_<ct>_<ltkid>` — the same five components `parseCredential`
 * reads back, and the same join one reference client performs out of
 * `document.cookie` (`common.js`'s `dyToken`). The *values* never leave this
 * module except inside the credential blob; the names are not secret.
 */
export const TOKEN_COOKIES = ['acf_uid', 'acf_biz', 'acf_stk', 'acf_ct', 'acf_ltkid'] as const

/**
 * Where the device id comes from, in the order the working socket probe resolved
 * it (`probe-socket.ts` loads `dy_did`, then `acf_did`).
 *
 * The token does not carry it, and nothing else can: the danmaku login puts it in
 * `loginreq` as `devid`, `vk` is `md5(rt + <secret> + devid)`, and every
 * `chatmessage` carries it as `dy`. A bind without one is refused rather than
 * filled with a placeholder — one account with two device ids is two sessions, and
 * the guessed value that briefly lived in a probe is exactly the kind of "plausible
 * but wrong" this repository bans.
 */
export const DEVICE_ID_COOKIES = ['dy_did', 'acf_did', 'acf_devid'] as const

/**
 * Where the nickname comes from, and where the display name used to be misread from.
 *
 * `acf_nickname` is the account's name and the only cookie here that is one.
 * `acf_username` is **not** — a live web session was observed carrying
 * `acf_username=456918967`, the account's own uid, URL-encoded. Reading it as a
 * display name is why this platform's row showed a bare number: a value that is not a
 * name was written in the name's place, and the UI had nothing to do but echo it.
 *
 * Neither is a credential, so both are safe to store.
 */
const NICKNAME_COOKIE = 'acf_nickname'
const FORMER_NICKNAME_COOKIE = 'acf_username'

/**
 * The avatar cookie: the site's own `acf_avatar`, which holds a CDN address rather
 * than an image.
 *
 * The one sample this build could read was 82 characters and ended in `_` — no size and
 * no extension, which is how Douyu truncates this particular cookie. The address the CDN
 * serves is the same stem with a size on it (`_small`, `_middle` or `_big`); `avatarUrlOf`
 * below supplies that, so this value is read for its stem and never stored as it stands.
 */
const AVATAR_COOKIE = 'acf_avatar'

/** The `platform` string the `accounts` row carries for this adapter. */
const DOUYU_PLATFORM_KEY = 'douyu'

/**
 * The one message a person sees when the scan worked but the session did not.
 *
 * Written once as a constant because it is the honest description of the missing pieces that are all
 * the same from where the caller stands (a family component the service did not set, a token the
 * adapter cannot read) — none of them is something a caller can act on beyond re-scanning, and the
 * Bilibili route's wording for the same situation is the model.
 *
 * **The device id used to be the third member of that list and is no longer**: it has a sentence of
 * its own below, because it is the one of the three that a retry cannot clear and a *different*
 * action can. Splitting it out is what makes the two sentences true of different sets instead of
 * one sentence being approximately true of all three.
 */
const INCOMPLETE_CREDENTIAL = '扫码已确认，但未能取得完整凭据，请重试'

/**
 * The one message a person sees when the scan landed a usable family but no device id.
 *
 * **It is a state of its own because the evidence says re-scanning cannot help**, and
 * `INCOMPLETE_CREDENTIAL` above says "try again". Every response this flow's own recording contains
 * sets no device cookie: the landing hop answers seventeen names and none of them is a device one
 * (`default-workspace/dump-login-landing.txt`: `PHPSESSID` plus the `acf_*` family), the poll answers
 * `dy_accounts_main` and `LTP0` (`dump-scan-auth.txt`), and the login page's own response headers are
 * in no dump at all. The mechanism points the same way: the page loads `douyu-did.js` and a script
 * writes `dy_did` in the browser, which is a thing `fetch` never does — `douyu-probe/src/read-did.ts`
 * records that as the hypothesis it was written to test. The only `acf_did` `Set-Cookie` in the whole
 * evidence set comes from `apiv2.douyucdn.cn/H5nc/welcome/to`, an endpoint this module deliberately
 * never calls.
 *
 * So the sentence names the route that does work rather than an action that cannot: the paste path
 * takes the device id as a field (`routes/douyu.ts`'s `pastedCredentialSchema` requires it) and the
 * accounts view puts it in a 设备 ID box a person can fill from their own browser. See the note at the
 * read itself for what a proper fix would look like.
 */
const NO_DEVICE_ID =
  '扫码已确认，但没有拿到设备号（斗鱼的设备号由登录页脚本写在浏览器里，HTTP 响应不下发），请改用「粘贴凭据绑定」，把浏览器里的 dy_did 填进「设备 ID」'

/**
 * What a person is told when the service named a landing link this module will not follow.
 *
 * A state of its own rather than `INCOMPLETE_CREDENTIAL`: the scan did work, the cookies may be
 * perfectly good, and re-scanning is not obviously the right move — what was refused was a hop to an
 * origin that is not Douyu's, and a person reading this should be looking at the account they are
 * binding rather than at their QR code.
 */
const LANDING_OFF_HOST = '扫码已确认，但服务端给的落地链接不在斗鱼域名下，没有跟随（会话没有发出去）'

/**
 * The CDN size segment a usable avatar address carries.
 *
 * The three names are Douyu's own: a room payload publishes the same stem as
 * `avatar.small` / `avatar.middle` / `avatar.big`, and the one address this platform has
 * ever had verified (`.../avatar_v3/202510/<stem>_middle.jpg`, seen on the task-center
 * page) is the middle one. `_middle` is therefore what is asked for: it is the size the
 * site itself shows in a 40 px row, and the choice is a size rather than a guess at the
 * address.
 */
const AVATAR_SIZE = '_middle'

/**
 * A usable avatar address out of the cookie's stem.
 *
 * The cookie arrives without a size and without an extension, so the address cannot be
 * used as it stands — and it is not made up either: the stem is the site's own name for
 * this image, and only the size is appended. An address that already carries one of the
 * three sizes is passed through untouched, which keeps a value that is complete working
 * whatever Douyu decides to hand out next.
 *
 * Empty when the session carried no avatar cookie: an absent image is a UI wart, while a
 * URL assembled from nothing would be a fabricated value.
 */
function avatarUrlOf(decoded: string): string {
  if (decoded === '') return ''
  // Checked by suffix rather than rebuilt by stripping one, so a stem that merely
  // contains the text is not mistaken for an address that already has a size.
  if (/_(?:small|middle|big)\.(?:jpg|jpeg|png|gif)$/i.test(decoded)) return decoded
  // The sample value ends in `_`, and the size is not a second one: `_middle.jpg`, not
  // `__middle.jpg`. Any trailing underscore the truncation left is dropped for that
  // reason and no other.
  return `${decoded.replace(/_+$/, '')}${AVATAR_SIZE}.jpg`
}

/**
 * The person's nickname for this session, or `''` when the session carries none.
 *
 * Two cookies are consulted, newest name first. `acf_username` is the older of the two
 * and is **not** a name: a live session carried this account's uid in it, so a value
 * equal to the account's id is refused — writing an id where a name belongs is the
 * defect this exists to end, and the fallback would otherwise reintroduce it on any
 * session where the name cookie is missing. An empty result is the honest one there:
 * `accounts.display_name` and the UI both treat it as "this Platform gave us no name".
 */
function nicknameOf(cookie: (name: string) => string, uid: string): string {
  const nickname = decodeCookie(cookie(NICKNAME_COOKIE)).trim()
  if (nickname !== '') return nickname

  const former = decodeCookie(cookie(FORMER_NICKNAME_COOKIE)).trim()
  return former === uid ? '' : former
}

/** What a completed bind produced: the stored row, or a sentence saying why not. */
export type BindOutcome =
  | { readonly ok: true; readonly account: Account }
  | { readonly ok: false; readonly error: string }

/**
 * Turns a confirmed scan into a stored account.
 *
 * The order is the flow's own: follow the landing link — **the hop that mints the `acf_*` family the
 * row is written from**, nickname and avatar cookies included, and the only response that states the
 * family's life — assemble the token out of the cookies that hop set, take the device id and the
 * nickname from the same jar, read the *session cookie's* own declared expiry out of the jar
 * (`sessionOf`) and the family's out of the landing response (`familyStampOf`), and only then write
 * the row — through the adapter's own parser, so a blob this module writes is a blob the adapter can
 * read.
 *
 * **The session cookie is not what this hop lands, and the earlier wording here said it was.**
 * "follow the landing link (that GET is what lands the session)" put `LTP0` on the wrong response:
 * the capture has the **poll's own tenth answer** carrying `LTP0` and `dy_accounts_main`
 * (`dump-scan-auth.txt`, the same exchange the comment inside `completeBind` describes), while the
 * landing hop answers the seventeen `acf_*`/`PHPSESSID` names and no session cookie at all
 * (`dump-login-landing.txt`). The two sentences cannot both be true, and the second one is the
 * measured one — `sessionOf` reads the jar, which is why it does not matter *where* the value
 * arrived, but a reader deciding what this hop is for would have been told the wrong thing.
 *
 * **No profile call, and none is needed for either field.** The nickname and the
 * avatar both come out of the jar this handshake already landed: `acf_nickname` is the
 * name, and `acf_avatar` is the address of the site's own avatar image — the cookie the
 * site writes for exactly this purpose and the one the reference account switcher reads
 * for its own avatar rendering. Both are recorded in `NICKNAME_COOKIE`, `AVATAR_COOKIE`
 * and `avatarUrlOf` above.
 *
 * That is a correction rather than a feature. This bind path used to read the
 * **wrong cookie** for the name (`acf_username`, which carries the account's uid) and
 * recorded no avatar at all, so a Douyu row was displayed as its own number. No endpoint
 * had to be verified to fix it and none was invented: inventing one — an OpenAPI v22
 * path that may be a 404 like 钻粉联赛's `dfansact/userSign` — would put a guess in the
 * bind path, where a wrong call fails for a reason nobody can see.
 *
 * **No `meta.refreshable`, and the flag was never what enrolled an account in anything.**
 * `listRefreshableAccounts` keys on it, but the sweep that would run a Douyu renewal
 * enumerates accounts by platform (`scheduler/runner.ts`'s `maybeRefreshAccounts`), so the
 * flag belongs to `bili-accounts.ts`'s own listing and nothing on this side reads it. What
 * is recorded instead is how and when the row was bound, plus whether the jar kept the
 * long-lived session cookie (`bindMeta`) — no secret, and the one fact a support question
 * actually needs, because the jar holding no session is exactly the credential the renewal
 * cannot rebuild. That record is **not** a verdict either: a row whose jar kept no session
 * is a row whose 粉丝家园签到 is `blocked`, reported by that action in its own terms, and a
 * row the renewal answers `relogin_required` for, which says the session cannot be renewed
 * rather than that the token is dead.
 */
export async function completeBind(
  db: DatabaseSync,
  userId: number,
  http: PassportHttp,
  poll: PollResponse,
  now = Date.now()
): Promise<BindOutcome> {
  const success = scanSuccessOf(poll)
  if (success === null) return { ok: false, error: INCOMPLETE_CREDENTIAL }

  // The landing hop. `redirect: 'manual'` (the client's default) because a session
  // that arrives on a 302 would be thrown away by a followed redirect; a hop that
  // carried no session therefore fails below, on the cookies, rather than being
  // retried against whatever the redirect pointed at.
  //
  // **Where it is sent is checked before it is made, and that check is the one this path was
  // missing.** The URL is the service's own `data.url` and `scanSuccessSchema` asks only that it be a
  // non-empty string, while this GET carries the flow's whole jar — which by now holds the `LTP0`
  // the poll response landed (182.5 days) beside the device pair. The response to this GET is also
  // what mints the `acf_*` family the row is written from, so an origin that is not Douyu's could both
  // read a session key and decide whose credential this account is bound with. `renewFamily`'s second
  // hop refuses off-host `Location`s for exactly that reason (see `DOUYU_HOST`); this hop had no such
  // guard and no test until the off-host case below was written.
  if (!isFollowableHost(success.url)) return { ok: false, error: LANDING_OFF_HOST }
  await http.request(jsonpHopUrl(success.url, now), { method: 'GET' })

  const family = rebuiltFamilyOf(http)
  if (!family.ok) return { ok: false, error: INCOMPLETE_CREDENTIAL }

  /**
   * The device id, **from the jar this flow filled — which is the one thing about this path that is
   * not established, and the reason a real scan may end here.**
   *
   * What the evidence supports, all of it outside this repository:
   *
   *  - **No response in the scan flow is recorded setting a device cookie.** The landing hop's
   *    `Set-Cookie` list is seventeen names and the device ones are not among them
   *    (`default-workspace/dump-login-landing.txt` and the same hop in
   *    `douyu-ltp0-renewal-2026-10-08/passport-login-flows.jsonl`); the poll's own tenth answer sets
   *    `dy_accounts_main` and `LTP0` and nothing else (`default-workspace/dump-scan-auth.txt`); the
   *    requests in that same flow *carry* `dy_did` and `acf_did`, and they carry them because the
   *    browser profile already had them before the scan began (`tl-chat-web.txt`'s `reqSession`).
   *  - **The flow's first hop is the only one whose response headers are in no dump** —
   *    `GET https://passport.douyu.com/member/login`, the warm-up `generateCode` performs — so it is
   *    the only place left that could hand this jar a device id.
   *  - **The mechanism says it does not.** That page loads `douyu-did.js` and the device id is
   *    written by a script into `document.cookie`; no `fetch` runs it. `douyu-probe/src/read-did.ts`
   *    exists to test exactly that, and the repo's own end-to-end web probe had to write a did by
   *    hand after a complete scan (`default-workspace/douyu-qr-full.mjs`). The one `acf_did`
   *    `Set-Cookie` anywhere in the evidence set belongs to `apiv2.douyucdn.cn/H5nc/welcome/to`, an
   *    endpoint this module never calls.
   *
   * **So this is what the fixture cannot settle and a read here cannot either.** If the warm-up hop
   * does not set one — the likelier reading — then every scan bind ends at the line below, and the
   * paste path (`routes/douyu.ts`, which takes `did` as a field) is the only working bind. The
   * fixture in `tests/douyu-bind.test.ts` therefore puts the device cookie on that unrecorded hop
   * rather than on the landing hop the capture disproves, and labels it as the assumption it is;
   * one case there exercises the whole recorded flow and asserts the sentence below.
   *
   * **The fix, if someone gets one live look at the warm-up hop: it is disposable rather than a
   * credential.** The id is client-chosen in every source that has one — a page script making one
   * up, the reference implementations hardcoding a constant, `md5(Math.random())` — and the
   * service was measured echoing an arbitrary one back inside `enc_data`
   * (`notes/douyu-anti-automation-report.md`). So minting a 32-hex id here is not inventing a
   * credential; what this module must not do is mint one *and* leave the question open. Either that
   * measurement is confirmed on the socket (`loginreq`'s `devid`, whose `vk` is
   * `md5(rt + secret + devid)` and therefore self-consistent whatever the id is), or the id keeps
   * coming from a person.
   */
  const did = firstCookie(http, DEVICE_ID_COOKIES)
  if (did === '') return { ok: false, error: NO_DEVICE_ID }

  const session = sessionOf(http)

  const credentials = serializeCredential({
    token: family.token,
    did,
    // The whole jar, as one header value: that is what §6 asks be kept, and what
    // the `japi/*` family will need. It is stored and never sent by this module.
    // **Nothing reads it back for a verdict**: the session cookie's presence in it is not a
    // judgement about the token — it is what `refresh` needs in order to rebuild the family at
    // all, while the adapter's other reader of the jar is 粉丝家园签到, which reports an empty
    // one as its own `blocked` rather than leaving a session verdict to be inferred from it.
    webCookies: http.cookieHeader(),
    // The session cookie's own declared death — see `sessionOf`, and note that this
    // is the only thing `expiresAt` has ever held here.
    expiresAt: session.expiresAt,
    // The family's own clock, out of the same jar and for the same reason: the response that
    // minted the five components is the only statement of their life there will ever be. This
    // one is read — by `refresh`, to decide when to rebuild — which is why a bind that lands a
    // family the service declared no `Max-Age` for still writes one (`familyStampOf`).
    tokenExpiresAt: familyStampOf(family, now)
  })

  const parsed = parseCredential(credentials)
  if (parsed === null) return { ok: false, error: INCOMPLETE_CREDENTIAL }

  const account = upsertAccount(
    db,
    userId,
    {
      platform: DOUYU_PLATFORM_KEY,
      // From the adapter's own parser rather than from a cookie read again: the
      // `uid` in the row is then, by construction, the `uid` the token resolves to.
      externalId: parsed.uid,
      displayName: nicknameOf(name => http.cookieValue(name) ?? '', parsed.uid),
      avatar: avatarUrlOf(decodeCookie(http.cookieValue(AVATAR_COOKIE) ?? '')),
      credentials,
      meta: bindMeta('scan-login', now, session.present)
    },
    now
  )

  return { ok: true, account }
}

/**
 * Stores a credential a person pasted, validated before it is written.
 *
 * The same serializer, the same parser and the same row as `completeBind` — the
 * only differences are where the values came from and that nothing is fetched. That
 * is deliberate: a paste path that built its own blob would be a second definition
 * of the contract, and the first time the two drifted the failure would be a
 * `401000206` on the socket, which reads exactly like a wrong key.
 *
 * Both clocks are left out, and that is a property of the input rather than a choice: a pasted
 * `Cookie:` header states no attributes, so there is no `Set-Cookie` here to read a lifetime from
 * — not the session's, and not the family's either. What that costs is exactly one exchange: with
 * no family clock in the blob, `refresh` cannot say whether the family is close to lapsing, so it
 * rebuilds once and records the clock that rebuild lands (see `renewFamily` and `familyStampOf`),
 * after which the same schedule as a scan-bound credential applies. A paste carrying `LTP0` and one
 * carrying none are still not answered identically — the first can be renewed, and the second is
 * the credential the renewal has nothing to present for, which is the one state a person has to fix
 * by scanning. What the two differ in for every *action* is unchanged: the `h5nc/*` family needs
 * only the token, while 粉丝家园签到 needs the session and reports its own `blocked` when the jar
 * has none, and both cases are visible on the row through `bindMeta` — the presence of
 * `sessionCookie` says the jar held the long login, and its absence says it did not.
 *
 * The nickname and the avatar are read out of the pasted cookie header when one was
 * given, by the same two rules the scan path uses — `acf_nickname` for the name and
 * `acf_avatar` for the image, both through the helpers above. Nothing else here looks at
 * `webCookies`, and nothing ever sends it.
 */
export function storePastedCredential(
  db: DatabaseSync,
  userId: number,
  input: { readonly token: string; readonly did: string; readonly webCookies?: string | undefined },
  now = Date.now()
): BindOutcome {
  const webCookies = input.webCookies ?? ''
  const credentials = serializeCredential({
    token: input.token.trim(),
    did: input.did.trim(),
    webCookies: webCookies.trim(),
    // Neither clock: a `Cookie:` header carries pairs and no attributes, so there is nothing here
    // to read a life from — see the doc above for what the family's absence costs and why it costs
    // nothing twice.
    expiresAt: null,
    tokenExpiresAt: null
  })

  const parsed = parseCredential(credentials)
  if (parsed === null) {
    // No value from the request is echoed: a wrong token is a secret typed wrong,
    // and the message's job is to say which shape is wanted.
    return {
      ok: false,
      error: '凭据无法解析：token 需要 <uid>_<biz>_<stk>_<ct>_<ltkid> 五个分量，stk 自身可以含下划线'
    }
  }

  const account = upsertAccount(
    db,
    userId,
    {
      platform: DOUYU_PLATFORM_KEY,
      externalId: parsed.uid,
      displayName: nicknameOf(name => cookieValueIn(webCookies, name), parsed.uid),
      avatar: avatarUrlOf(decodeCookie(cookieValueIn(webCookies, AVATAR_COOKIE))),
      credentials,
      meta: bindMeta('paste', now, cookieValueIn(webCookies, SESSION_COOKIE) !== '')
    },
    now
  )

  return { ok: true, account }
}

/**
 * A pending bind session.
 *
 * Held in memory by the route module, keyed by the QR `code` — the same shape
 * `routes/context.ts`'s `LoginSessionStore` has for Bilibili, and for the same
 * reason: the flow needs one continuous jar, and two people scanning at once must
 * not share one.
 */
export interface DouyuBindSession {
  readonly http: PassportHttp
  readonly userId: number
  readonly createdAt: number
  /** When this session stops being usable. See `DouyuBindSessionStore`. */
  readonly expiresAt: number
}

/**
 * Holds in-flight Douyu binds.
 *
 * Not `ctx.loginSessions`: that store is typed to `BiliHttp`, so borrowing it would
 * put a Bilibili client (and its referer, and its cookie model) inside a Douyu flow
 * — two Platforms sharing a transport is the coupling the `Platform` seam exists to
 * prevent. This one is four methods, and it owns the one thing a bind session needs
 * beyond a jar: a deadline.
 *
 * The default deadline is the QR's own life, not Bilibili's five minutes, because
 * the two services disagree about it and the response says which is which
 * (`data.expire`, measured `300`). A session that outlives its code is useless
 * anyway — the poll answers `-1` for a code the service has forgotten — so the
 * route passes the response's own value and the two agree by construction.
 */
export class DouyuBindSessionStore {
  private readonly sessions = new Map<string, DouyuBindSession>()

  constructor(private readonly defaultTtlMs: number = QR_TTL_MS) {}

  create(key: string, userId: number, http: PassportHttp, ttlMs = this.defaultTtlMs, now = Date.now()): void {
    this.sweep(now)
    this.sessions.set(key, { http, userId, createdAt: now, expiresAt: now + ttlMs })
  }

  get(key: string, now = Date.now()): DouyuBindSession | null {
    const session = this.sessions.get(key)
    if (session === undefined) return null
    if (now > session.expiresAt) {
      this.sessions.delete(key)
      return null
    }
    return session
  }

  remove(key: string): void {
    this.sessions.delete(key)
  }

  private sweep(now: number): void {
    for (const [key, session] of this.sessions) {
      if (now > session.expiresAt) this.sessions.delete(key)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Rebuilding the family from the long-lived session cookie
 * ------------------------------------------------------------------ */

/**
 * The site's own root, which is both the first hop's `Referer` and its `redirect_url`.
 *
 * Not two facts: the exchange sends the browser back where it came from, and the capture carries
 * the same string in both places (percent-encoded in the query). The second hop's `Referer` is the
 * passport origin instead, because that is where a browser's request comes *from* on the way back.
 */
const DOUYU_ORIGIN = 'https://www.douyu.com'
const SITE_ROOT = `${DOUYU_ORIGIN}/`
const PASSPORT_ROOT = `${PASSPORT_ORIGIN}/`

/** `GET` — the first hop, which answers a redirect and never the family itself. */
export const SAFE_AUTH_URL = `${PASSPORT_ORIGIN}/wgapi/member/passport/safeAuth`

/**
 * The status the first hop answers, and the only one this module treats as progress.
 *
 * Not "any `3xx`": `302` is the measured verdict, and a `301` or `303` would mean the route has
 * been re-pointed — a contract change worth reporting rather than following to see what happens.
 */
const SAFE_AUTH_REDIRECT = 302

/**
 * The hosts a URL the service named may be sent to — **both** hops that follow one.
 *
 * The renewal's second hop carries `LTP0`, so following a `Location` to another origin would hand a
 * 182.5-day key to whoever named it; the bind's landing hop carries the same key, because the poll
 * response lands `LTP0` before it. One regex for both, because it is one rule: a URL this module is
 * told to fetch may only name a Douyu host.
 *
 * The measured `Location` is `https://www.douyu.com/api/passport/login…`, and `m.` is allowed here
 * for the reason `index.ts`'s `ROOM_HOST` allows it there: it is a Douyu host a browser treats as the
 * site. That regex is the same string and is deliberately separate — one decides which links are
 * rooms, this one decides where a credential may be sent, and a change to either says nothing about
 * the other.
 */
const DOUYU_HOST = /^(www\.|m\.)?douyu\.com$/i

/** The JSONP callback name both hops were captured with. Fixed by the page, so never varied here. */
const JSONP_CALLBACK = '__jp0'

/**
 * The fourth cookie the captured first hop sent, and the only one of the four with no other source.
 *
 * Its value is a single character in the capture (`1`). It is passed through from the stored jar
 * when the jar has it, and never invented: a made-up value would be a claim about which account
 * slot the service is being asked for, and nothing on this side knows that.
 */
const ACCOUNTS_COOKIE = 'dy_accounts_main'

/**
 * The two names the first hop carries the device id under, both set to the blob's own `did`.
 *
 * The pair the capture sent, and not every device-cookie name this repo knows: `acf_devid` is the
 * third name `DEVICE_ID_COOKIES` reads when it is *looking* for a did, while a name sent onto a hop
 * with no measurement behind it is a cookie the next reader has to explain away.
 */
const DEVICE_SEND_COOKIES = ['dy_did', 'acf_did'] as const

/**
 * The family's measured life, for a response that declares none of its own.
 *
 * Every component of the token was declared `Max-Age=529200` by the response that minted it —
 * 6.125 days, and `604800 × 0.875` rather than the seven days this repo once asserted — so the
 * blob's clock comes from the response whenever the response states one. This is the fallback for a
 * response that states none, applied to an instant this module knows (the moment the family landed),
 * which makes it a statement about a measured life rather than a guess at one. It exists to keep one
 * promise: a credential whose family clock is absent would be rebuilt on *every* check, and four
 * exchanges a day is a worse answer than a measured 6.125 days. `qrLifetimeMs` makes the same choice
 * for a QR response that carries no `expire`.
 */
const FAMILY_LIFE_MS = 529_200_000

/** What one rebuild produced: a rebuilt credential, or why there is none. */
export type FamilyRenewal =
  | { readonly ok: true; readonly credentials: string }
  | {
      readonly ok: false
      /**
       * Why nothing is being handed back, in the two senses the caller has to tell apart: nothing
       * this module could present (`no_session` — a person has to scan, and no request was made),
       * or an exchange that produced no usable family (`no_family` — an attempt was made, and the
       * next check may well succeed).
       */
      readonly kind: 'no_session' | 'no_family'
      readonly reason: string
    }

/**
 * The one sentence for a credential with no long login in it. See `renewFamily`.
 *
 * Exported because two places have to say it: the mechanism, whose first precondition it is, and
 * `index.ts`'s `refresh`, which answers `relogin_required` with it before the exchange is ever
 * reached. One sentence, one home — a second copy would be free to drift into two different
 * explanations of one state.
 */
export const NO_SESSION_TO_RENEW = '凭据里没有网页会话（LTP0），无法重建 acf_* 家族，需要重新扫码绑定'

/**
 * A family read out of a jar: the token it makes and the life it declared, or the name of the
 * component that was not there.
 *
 * The missing name travels rather than a bare failure because a name is not a secret and a sentence
 * that says which one was absent is the difference between a report a person can act on and one
 * they can only re-run.
 */
type FamilyReading =
  | { readonly ok: true; readonly token: string; readonly expiresAt: number | null }
  | { readonly ok: false; readonly missing: string }

/**
 * The composite token out of a jar, joined in the order the token is made of.
 *
 * `TOKEN_COOKIES` is that order — `<uid>_<biz>_<stk>_<ct>_<ltkid>` — and this is the one place it is
 * applied on the way in, so a bind and a renewal cannot assemble the token two different ways. Both
 * callers want the same three things out of the jar they just landed: all five present, the token
 * they make, and the life the response declared for them.
 *
 * `ok: false` when any of the five is missing or empty. A four-fifths family is not a token, and a
 * blob written from one fails on the socket as `401000206`, which reads exactly like a wrong key.
 *
 * The life is the **shortest** instant the five declared, and a component that declared none
 * contributes nothing to it: the token is only good while all five are, so the earliest declaration
 * is the only honest one — and null, meaning "the service stated no life for any of them", is what
 * `familyStampOf` answers with the measured life instead.
 */
function rebuiltFamilyOf(http: PassportHttp): FamilyReading {
  const parts: string[] = []
  let expiresAt: number | null = null

  for (const name of TOKEN_COOKIES) {
    const value = http.cookieValue(name)
    if (value === undefined || value === '') return { ok: false, missing: name }
    parts.push(value)

    const declared = http.cookieExpiresAt(name)
    if (declared !== null && (expiresAt === null || declared < expiresAt)) expiresAt = declared
  }

  return { ok: true, token: parts.join('_'), expiresAt }
}

/**
 * The instant a family's clock runs out, as the blob records it.
 *
 * What the response declared, or — when it declared nothing — the measured life counted from the
 * moment the family landed. `now` is that moment: a bind passes the instant it is writing its row
 * at, and a renewal passes the instant it made its first hop.
 */
function familyStampOf(family: { readonly expiresAt: number | null }, now: number): number {
  return family.expiresAt ?? now + FAMILY_LIFE_MS
}

/**
 * One `Cookie:` header, with a second header's pairs merged over it — newest declaration wins.
 *
 * The rule is `absorb`'s, applied to the shape a credential is stored in rather than to the shape a
 * response arrives in: one name is one fact, and the later statement of it is the true one. The
 * stored header's order is kept and the names the newer header adds are appended in its order.
 *
 * This is what keeps a renewal from costing the credential anything. The exchange is asked with
 * three or four cookies and answers with a family, so a jar that carried anything else — a minted
 * `acf_ccn`, a cookie another flow wrote — would lose it if the new header were written as it
 * stands, and a credential is the one thing here that cannot be re-derived from anything else.
 *
 * Pairs, not attributes: nothing in a stored header has any, which is why the blob's own two clocks
 * (`expiresAt`, `tokenExpiresAt`) are the only place a lifetime exists.
 */
function mergeCookieHeaders(stored: string, fresh: string): string {
  const merged = new Map<string, string>()
  for (const pair of [...stored.split(';'), ...fresh.split(';')]) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    if (name === '') continue
    merged.set(name, pair.slice(eq + 1).trim())
  }
  return [...merged].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * The JSON inside a JSONP envelope, or the body's own JSON, or `null`.
 *
 * **Both shapes have to be accepted, and the reason is what the capture shows**: this module asks for
 * `callback=__jp0` on every call to the first hop, so the measured refusal bodies are
 * `__jp0({"error":16,…})` and `__jp1({…})` — two attempts, two different wrapper names — while a body
 * that arrives unwrapped is what every other endpoint in this module answers. The wrapper's *name* is
 * nothing this module controls, so it is not matched; the envelope's *shape* is, and a call expression
 * whose single argument is the object is the whole of it.
 *
 * `null` rather than an exception, because every caller here is composing a sentence for a person: a
 * body nobody can read contributes no clause instead of turning a diagnostic into a crash.
 */
function parseJsonpBody(body: string): unknown {
  const trimmed = body.trim()
  const inner = /^[A-Za-z_$][\w$]*\((.*)\)$/s.exec(trimmed)?.[1] ?? trimmed
  try {
    return JSON.parse(inner)
  } catch {
    return null
  }
}

/**
 * The service's own sentence out of a body that should have been a redirect, as a clause.
 *
 * The first hop's refusal is a `200` whose JSON says why — measured three times across two files:
 * `__jp0({"error":16,"msg":"未登录,请重新登录"})`, and that sentence is the one thing a person could act
 * on. **It arrives inside the JSONP envelope this module itself asked for**, which is why the wrapper is
 * stripped first: parsing the wrapper as JSON threw on every refusal, so the clause that exists to say
 * *why* never once reached a person and the report fell back to "第一跳返回 HTTP 200，不是 302" with no
 * reason attached.
 *
 * Anything unreadable yields nothing, and so does a body whose own `error` is zero: a "success" that
 * arrived without a `Location` is a shape this module cannot explain, and quoting `斗鱼返回错误码 0`
 * about it would be inventing a refusal.
 */
function refusalClauseOf(body: string): string {
  const json = parseJsonpBody(body)
  if (json === null) return ''

  const parsed = envelopedOptionalData().safeParse(json)
  if (!parsed.success || parsed.data.error === 0) return ''
  return `（${refusalText(parsed.data)}）`
}

/** The first hop's URL, with the five parameters the captured request carries. */
function safeAuthUrl(did: string, now: number): string {
  const query = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_url: SITE_ROOT,
    did,
    t: String(now),
    callback: JSONP_CALLBACK
  })
  return `${SAFE_AUTH_URL}?${query.toString()}`
}

/** The one shape every failed exchange takes. */
function renewalFailed(reason: string): FamilyRenewal {
  return { ok: false, kind: 'no_family', reason }
}

/**
 * Rebuilds the `acf_*` family out of the long-lived session cookie.
 *
 * Two `GET`s, both replayed from the capture — see the module doc for why this route works where
 * the PC client's `getShortToken` does not. Everything it needs is already in the credential: the
 * device id is the blob's own field (the jar's `acf_devid` looks like the same value and is **not**
 * what the hop is asked with), the session key is inside `webCookies`, and the session's own stamp
 * is carried through untouched — **this exchange does not rotate `LTP0`**: the response does not
 * carry it and its expiry is unchanged, which is what makes a 182.5-day key worth having.
 *
 * **The first hop's cookie header is built, not inherited.** It is the names the captured request
 * sent and no others: the device pair, `dy_accounts_main` when the stored jar has one, and `LTP0`.
 * That is deliberate twice over — the `acf_*` family is host-only for `www.douyu.com` and a browser
 * would not send it to the passport host, and a header built from "the whole jar" is a header whose
 * next failure gets blamed on the wrong thing.
 *
 * **The jar it lands is merged over the blob's own, newest declaration winning** — the rule
 * `absorb` states — so the family's five components come back new while every other cookie the
 * credential was carrying is kept. That is what a browser has after the same exchange.
 *
 * **The second hop's verdict is the cookies it lands, not its status.** The captured answer is a
 * `200` with a JSONP body and the body is not read here; `completeBind`'s landing hop makes the same
 * choice for the same reason, and checking the envelope as well would only add a second, weaker
 * gate in front of the jar.
 *
 * **A complete family is written, and its values are not compared against the ones it replaced.** The
 * measured exchange rotates them — `acf_auth` 129 → 125, `acf_jwt_token` 290 → 258, `dy_auth` 119 →
 * 123 — but an *echo* has never been observed, and a check for one would be a verdict on a case
 * nobody has measured. What the response is held to instead is completeness (all five components)
 * and identity (`acf_uid` is this credential's account), both of which it answers for itself.
 *
 * Nothing that leaves here carries a value from the exchange except the credential itself: the
 * failure sentences name no cookie value, no token, and neither the `code` nor the `Location` of the
 * first hop, because `code` is a credential for one exchange and the transport's own text is
 * scrubbed of all four. What may be named is a *name* — 「缺 acf_stk」 — and a length never is.
 */
export async function renewFamily(input: {
  readonly did: string
  readonly uid: string
  readonly webCookies: string
  readonly expiresAt: number | null
  readonly now?: number
}): Promise<FamilyRenewal> {
  const now = input.now ?? Date.now()
  const ltp0 = cookieValueIn(input.webCookies, SESSION_COOKIE)
  if (ltp0 === '') return { ok: false, kind: 'no_session', reason: NO_SESSION_TO_RENEW }

  const http = new PassportHttp()
  for (const name of DEVICE_SEND_COOKIES) http.setCookie(name, input.did)
  const accounts = cookieValueIn(input.webCookies, ACCOUNTS_COOKIE)
  if (accounts !== '') http.setCookie(ACCOUNTS_COOKIE, accounts)
  http.setCookie(SESSION_COOKIE, ltp0)

  // The device id and the session key travel in this hop's URL and its header; they are the two
  // secrets a transport failure's own text could have picked up.
  const secrets = [input.did, ltp0]

  let first: RawResponse
  try {
    first = await http.request(safeAuthUrl(input.did, now), {
      method: 'GET',
      headers: { referer: SITE_ROOT }
    })
  } catch (error: unknown) {
    return renewalFailed(`重建 acf_* 家族失败：第一跳没有到达（${redactSecrets(reasonText(error), secrets)}）`)
  }

  if (first.status !== SAFE_AUTH_REDIRECT) {
    return renewalFailed(
      `重建 acf_* 家族失败：第一跳返回 HTTP ${String(first.status)}，不是 ${String(SAFE_AUTH_REDIRECT)}${refusalClauseOf(first.body)}`
    )
  }

  const location = first.headers.get('location') ?? ''
  if (location === '') return renewalFailed('重建 acf_* 家族失败：第一跳的 302 没有带 Location')

  let landing: URL
  try {
    landing = new URL(location)
  } catch {
    return renewalFailed('重建 acf_* 家族失败：第一跳给的 Location 不是一个 URL，没有跟随')
  }
  if (!DOUYU_HOST.test(landing.hostname)) {
    // Not followed at all: this hop carries the session key, and a `Location` off Douyu's own hosts
    // is the one thing here that must not be handed a credential to find out about.
    return renewalFailed('重建 acf_* 家族失败：第一跳给的 Location 不在斗鱼域名下，没有跟随（会话没有发出去）')
  }

  // The second hop carries the one-time `code` in its URL, so every sentence built after it is
  // scrubbed of both the `Location` and the `code` inside it.
  const hopSecrets = [...secrets, location, landing.searchParams.get('code') ?? '']

  try {
    await http.request(location, { method: 'GET', headers: { referer: PASSPORT_ROOT } })
  } catch (error: unknown) {
    return renewalFailed(`重建 acf_* 家族失败：第二跳没有到达（${redactSecrets(reasonText(error), hopSecrets)}）`)
  }

  const family = rebuiltFamilyOf(http)
  if (!family.ok) {
    return renewalFailed(
      `重建 acf_* 家族失败：第二跳没有下发完整的 acf_* 家族（缺 ${family.missing}，五个分量少任何一个都不成 token）`
    )
  }

  const credentials = serializeCredential({
    token: family.token,
    did: input.did,
    webCookies: mergeCookieHeaders(input.webCookies, http.cookieHeader()),
    expiresAt: input.expiresAt,
    tokenExpiresAt: familyStampOf(family, now)
  })

  // The same gate `completeBind` passes through, plus one question only renewal can ask: a family
  // that belongs to somebody else must never be written into this row. A credential is what
  // authenticates every action, so a cross-account swap here would be silent and total.
  const parsed = parseCredential(credentials)
  if (parsed === null || parsed.uid !== input.uid) {
    return renewalFailed('重建 acf_* 家族失败：新家族不是这个账号的（acf_uid 与凭据里的 uid 不一致），没有写入')
  }

  return { ok: true, credentials }
}

/* ------------------------------------------------------------------ *
 * Small shared pieces
 * ------------------------------------------------------------------ */

/**
 * The long-lived session cookie as this bind's jar holds it, and the only thing
 * `completeBind` takes a lifetime from.
 *
 * The expiry is the one the service declared for `LTP0` on its own `Set-Cookie` — the
 * `Max-Age` of 182.5 days in §3 — and not the poll payload's `expire_in`, which belongs to
 * the PC route's `short_token` and does not arrive on this route at all (§7). Reading the
 * jar also makes a bind that somehow lands no session cookie record `expiresAt: null`
 * beside `present: false`; that is the honest pair (there is nothing to take a lifetime
 * from). It is not a verdict on the account either: `present: false` decides which actions
 * can run — the `h5nc/*` family needs no session at all — and separately means there is
 * nothing for a renewal to present, which is the one state `refresh` answers
 * `relogin_required` for. Those are two readings of one fact, and neither of them says a
 * token is dead.
 */
function sessionOf(http: PassportHttp): { readonly present: boolean; readonly expiresAt: number | null } {
  const present = (http.cookieValue(SESSION_COOKIE) ?? '') !== ''
  return { present, expiresAt: present ? http.cookieExpiresAt(SESSION_COOKIE) : null }
}

/**
 * The row's `meta`: how and when the bind happened, plus whether it left the jar holding
 * the long-lived session cookie.
 *
 * `boundVia`/`boundAt` were already here and keep their names and order. `sessionCookie`
 * is new, and it is a **cookie name, never a value** — names are not secrets, and this is
 * the part of "is the browser's long login in here?" an operator can read off the row
 * without opening the credential blob. Omitted rather than written as `false` when the jar
 * held none: a paste with no jar is a normal state, and a `false` invites the reading that
 * something had been observed *about* a cookie that was never there.
 */
function bindMeta(boundVia: string, boundAt: number, hasSession: boolean): string {
  const meta: Record<string, string | number> = { boundVia, boundAt }
  if (hasSession) meta['sessionCookie'] = SESSION_COOKIE
  return JSON.stringify(meta)
}

/**
 * The JSONP hop the page makes to finish a login.
 *
 * `jsonpCallback: "appClient_json_callback"` with jQuery's cache-buster (`_`), and
 * nothing else: the callback name is fixed by the page, and the response body is
 * not read here — the jar the hop lands is the evidence, and checking the JSONP
 * envelope as well would only add a second, weaker gate in front of it.
 */
function jsonpHopUrl(url: string, now: number): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}callback=appClient_json_callback&_=${String(now)}`
}

/**
 * Whether a URL the service named may be fetched by this module at all.
 *
 * True only for an **absolute** URL on one of `DOUYU_HOST`'s hosts. A value that is not an absolute
 * URL is false rather than an error: a relative landing link is not something this hop could ever
 * have been sent to, and answering "no" here is what keeps that from reaching the transport.
 */
function isFollowableHost(raw: string): boolean {
  try {
    return DOUYU_HOST.test(new URL(raw).hostname)
  } catch {
    return false
  }
}

/** The first cookie among `names` that is present and non-empty. */
function firstCookie(http: PassportHttp, names: readonly string[]): string {
  for (const name of names) {
    const value = http.cookieValue(name)
    if (value !== undefined && value !== '') return value
  }
  return ''
}

/**
 * One attribute's value out of a `Set-Cookie`'s attribute list, or null.
 *
 * Matched case-insensitively because the wire is not consistent about it — `HttpOnly`
 * sits beside `httponly` in the same capture (§2.2) — and null rather than `''` for a
 * bare flag: `HttpOnly` carries no `=` and therefore no value, while `Max-Age=` claims
 * to declare one and does not.
 */
function attributeOf(attributes: readonly string[], name: string): string | null {
  for (const attribute of attributes) {
    const eq = attribute.indexOf('=')
    if (eq <= 0) continue
    if (attribute.slice(0, eq).trim().toLowerCase() !== name) continue
    const value = attribute.slice(eq + 1).trim()
    return value === '' ? null : value
  }
  return null
}

/**
 * A `Max-Age` attribute as whole seconds, `0` for the tombstone spellings, or null when
 * it is absent or unreadable.
 *
 * `0` and a negative value mean one thing to a browser — expire this now — so the two are
 * folded into a single verdict rather than distinguished. An unreadable value is not
 * turned into a date either: `absorb` falls back to `Expires`, which is what RFC 6265
 * says to do with an attribute it cannot parse.
 */
function maxAgeOf(maxAge: string | null): number | null {
  if (maxAge === null) return null
  const seconds = Number(maxAge)
  if (!Number.isFinite(seconds)) return null
  return seconds <= 0 ? 0 : seconds
}

/** An `Expires` attribute as an instant, or null when it is absent or unreadable. */
function dateOf(expires: string | null): number | null {
  if (expires === null) return null
  const at = Date.parse(expires)
  return Number.isFinite(at) ? at : null
}

/**
 * The credential blob.
 *
 * The shape belongs to `index.ts`, which reads it; this only writes it. The three
 * optional fields are omitted rather than written empty, so a jar-less or
 * stamp-less blob looks exactly like one a person pasted by hand — a shape the
 * adapter already documents as normal.
 *
 * The two clocks are separate fields because they are two different lives — the session
 * cookie's 182.5 days and the token family's 6.125 — and because only one of them is ever read
 * for a decision (`tokenExpiresAt`, by `refresh`, to schedule a rebuild). Merging them would
 * make the session's stamp inherit that decision, which is the conflation that once put four
 * 「登录已失效」 a day on a working account.
 */
function serializeCredential(credential: {
  readonly token: string
  readonly did: string
  readonly webCookies: string
  readonly expiresAt: number | null
  readonly tokenExpiresAt: number | null
}): string {
  const blob: Record<string, string | number> = {
    token: credential.token,
    did: credential.did
  }
  if (credential.webCookies !== '') blob['webCookies'] = credential.webCookies
  if (credential.expiresAt !== null) blob['expiresAt'] = credential.expiresAt
  if (credential.tokenExpiresAt !== null) blob['tokenExpiresAt'] = credential.tokenExpiresAt
  return JSON.stringify(blob)
}

/** A cookie value as display text. A stray `%` is not worth failing a bind over. */
function decodeCookie(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * One cookie's value out of a `Cookie:` header string, or `''`.
 *
 * Used only for the nickname on the paste path: the scan path reads its jar
 * directly, and nothing else about a pasted header is interpreted — it is stored
 * whole, exactly as typed.
 */
function cookieValueIn(header: string, name: string): string {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return ''
}

function reasonText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
