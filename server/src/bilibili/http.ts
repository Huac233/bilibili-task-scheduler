import type { ZodType } from 'zod'

import { redactCredentialParameters, redactSecrets } from '../text/redact.js'

/**
 * Cookie-aware HTTP transport for Bilibili.
 *
 * The browser-side reference implementation reads cookies straight out of
 * `document.cookie`, which a server cannot do. This module owns the cookie jar
 * explicitly: it absorbs `Set-Cookie` from every response (including the `302`
 * that ends the QR login flow), replays them on later requests, and can be
 * serialised to disk so a login survives a restart.
 */

/**
 * Headers that make requests look like they come from a real browser tab.
 *
 * Byte-identical to the Douyu side's desktop UA (`platform/douyu/protocol.ts`'s
 * `PC_USER_AGENT`, `platform/douyu/passport.ts`'s `PASSPORT_USER_AGENT`), and kept
 * separate on purpose: they describe two Platforms' traffic, so the coupling a shared
 * constant would add across the Platform seam buys nothing and ties Bilibili's headers
 * to Douyu's. Anyone unifying them has to answer for that coupling first.
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * The ceiling for one Bilibili call.
 *
 * Exported because it is the *house* ceiling and not this module's private choice:
 * the Platform adapter passes this same name into the cookie-less clients it builds
 * for anonymous reads, so "an adapter call can never hang" rests on a named, stated
 * value instead of on a default nobody above this module can see.
 */
export const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_REFERER = 'https://live.bilibili.com/'

/**
 * Cookie names this project cares about, for typed access.
 *
 * **A `SessExpires` entry stood here and was deleted, and it is the only member this table has
 * ever lost.** It declared `SESSDATA_expires` as "Expiry of `SESSDATA`, used to detect a stale jar
 * before making calls" — a decision no code in this repo ever made: `grep` for the name in
 * `server/src`, `server/tests`, `web/src` and `web/tests` found only that declaration, the cookie
 * name appears in no capture and in none of the reference implementations under `refs/`, and the
 * jar ignores `Expires`/`Max-Age` on purpose (see `absorb`: a stale session is answered by the
 * `/x/web-interface/nav` read, not by a clock. `platform/bilibili/index.ts` is that reader). So the
 * entry was a name a later reader could have keyed a decision on, with nothing behind it — which is
 * the failure this table's remaining members each have a measurement for. Deleting it is safe in
 * the strict sense as well: nothing else imported it.
 */
export const CookieName = {
  /** Session token — the actual login credential. */
  SessData: 'SESSDATA',
  /** CSRF token; must be echoed as `csrf`/`csrf_token` on write endpoints. */
  Csrf: 'bili_jct',
  /** Numeric account id. */
  UserId: 'DedeUserID',
  /**
   * Device fingerprint cookies.
   *
   * Not credentials, but Bilibili's risk control reads them, and a session that has
   * lost them starts failing in ways that look like rate limiting — so they are part
   * of the set a credential is compared and stored as. See `credential.ts`.
   */
  Buvid3: 'buvid3',
  Buvid4: 'buvid4'
} as const

/** A simple name -> value cookie store. */
export class CookieJar {
  private readonly store: Map<string, string>

  constructor(initial?: Readonly<Record<string, string>>) {
    this.store = new Map(Object.entries(initial ?? {}))
  }

  get(name: string): string | undefined {
    return this.store.get(name)
  }

  set(name: string, value: string): void {
    this.store.set(name, value)
  }

  has(name: string): boolean {
    return this.store.has(name)
  }

  clear(): void {
    this.store.clear()
  }

  /** True when a session cookie is present. Does not validate it against the API. */
  get isAuthenticated(): boolean {
    return this.store.has(CookieName.SessData) && this.store.has(CookieName.Csrf)
  }

  /**
   * The CSRF token, if logged in. Every write endpoint needs this value twice
   * (as `csrf` and `csrf_token`).
   */
  get csrfToken(): string | undefined {
    return this.store.get(CookieName.Csrf)
  }

  /** The logged-in account's numeric uid, as a string. */
  get userId(): string | undefined {
    return this.store.get(CookieName.UserId)
  }

  /** Renders the jar as a `Cookie:` request header value. */
  toHeader(): string {
    const parts: string[] = []
    for (const [name, value] of this.store) {
      parts.push(`${name}=${value}`)
    }
    return parts.join('; ')
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.store)
  }

  static fromJSON(data: Readonly<Record<string, string>>): CookieJar {
    return new CookieJar(data)
  }

  /**
   * Merges `Set-Cookie` header values into the jar. Only the `name=value` pair
   * is kept; `Expires`/`Max-Age` are ignored because a server-side jar is
   * typically short-lived and re-validated through `/x/web-interface/nav`
   * anyway. An empty value (Bilibili's way of clearing a cookie) deletes the
   * entry.
   */
  absorb(setCookieHeaders: readonly string[]): void {
    for (const header of setCookieHeaders) {
      const pair = header.split(';')[0]
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (!name) continue
      if (value === '') this.store.delete(name)
      else this.store.set(name, value)
    }
  }
}

/**
 * Thrown when the transport itself fails (network, timeout, non-2xx), or when an answer arrived and could
 * not be read as what the caller asked for — a payload that is not JSON, a shape the endpoint's schema
 * refuses, a room endpoint reporting success with no room in it. The second kind carries `status: 0`,
 * because there is no HTTP status to report: `0` is this class's own word for "the failure is not a
 * status", and `transportCodeOf` in the adapters reads it that way.
 */
export class BiliHttpError extends Error {
  readonly status: number
  /**
   * The URL the failed call was aimed at, **as the raiser handed it in**.
   *
   * The URL is where a credential travels on this Platform — `?csrf=` on the renewal check,
   * `?qrcode_key=` on the login poll, the one-time `ticket` on the cross-domain hop — and this
   * class exists to be logged from a catch block, so every construction point in this repo passes
   * `this.redact(url)` and the field is redacted for every error that actually reaches a reader.
   *
   * **That is a rule at the call sites rather than a guarantee this class can make**, and the
   * earlier wording ("stored already redacted by the client that raised it") claimed the stronger
   * thing. This constructor cannot enforce it: redaction needs the jar and the parameter table, and
   * a class that did it itself would be a second definition of both. So a caller that hands in a
   * raw URL still gets a `url` holding a credential — the class stores what it is given, verbatim,
   * which is also what lets `tests/bilibili-http.test.ts` construct one directly to read its
   * fields. The rule above is the contract; the `redact` call at each raiser is what keeps it.
   */
  readonly url: string

  constructor(url: string, status: number, message: string) {
    super(message)
    this.name = 'BiliHttpError'
    this.url = url
    this.status = status
  }
}

export interface BiliHttpOptions {
  readonly cookies?: CookieJar
  readonly timeoutMs?: number
  readonly userAgent?: string
  /** Sent as `Referer`. Some live endpoints require a same-site referer. */
  readonly referer?: string
}

/** A raw response plus its body, used when the caller needs status/headers. */
export interface RawResponse {
  readonly status: number
  readonly headers: Headers
  readonly body: string
}

/**
 * The cookie values that must never survive into a sentence this client produces.
 *
 * `buvid3`/`buvid4` are not credentials on their own, but they are part of the set a
 * credential is compared and stored as, and they travel in the same `Cookie:` header
 * as the session — so a server that echoes the request back leaks them together.
 *
 * `DedeUserID` is deliberately absent: it is a public numeric id, and its value is
 * short enough that removing it would shred every sentence it appeared in.
 */
const CREDENTIAL_COOKIES: readonly string[] = [
  CookieName.SessData,
  CookieName.Csrf,
  CookieName.Buvid3,
  CookieName.Buvid4
]

export class BiliHttp {
  readonly cookies: CookieJar
  private readonly timeoutMs: number
  /**
   * The User-Agent this client sends, public because two endpoints carry it in the
   * *body* as well: the live-trace heartbeat sends a `ua` form field that has to be
   * the same string as the header, and the only place that knows which string the
   * header carries is here. A caller-side copy of `BROWSER_USER_AGENT` would drift
   * the moment someone constructs a client with a custom agent.
   */
  readonly userAgent: string
  private readonly referer: string

  constructor(options: BiliHttpOptions = {}) {
    this.cookies = options.cookies ?? new CookieJar()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.userAgent = options.userAgent ?? BROWSER_USER_AGENT
    this.referer = options.referer ?? DEFAULT_REFERER
  }

  /**
   * Takes this client's own credentials out of a sentence.
   *
   * Public because the object holding the credentials is the only one that can remove
   * them: the modules above build sentences out of a response's `message`, and a
   * server that echoes the request back puts the session cookie and the CSRF token
   * into exactly those sentences. Two rules, because a URL carries credentials this
   * client never held — `qrcode_key` on the login poll, the one-time `ticket` on the
   * cross-domain hop — and only their parameter names identify them.
   *
   * `extra` is for values the caller sent that this jar may no longer hold: a refresh
   * token, or the per-session key a heartbeat signs with.
   */
  redact(text: string, extra: readonly string[] = []): string {
    const values = [...extra]
    for (const name of CREDENTIAL_COOKIES) {
      const value = this.cookies.get(name)
      if (value !== undefined) values.push(value)
    }
    // **Values shorter than two characters are dropped, and the guard belongs here because this
    // caller cannot choose its own list.** `redactSecrets` states the contract — a one-character
    // value does not remove a secret, it `replaceAll`s that character into `<redacted>` between
    // every occurrence in the sentence — and this is one of the two callers in the repo whose
    // values arrive from outside.
    //
    // Both halves of the list can carry one. `CREDENTIAL_COOKIES` comes out of `Set-Cookie`
    // headers, which a broken or hostile response writes; `extra` carries `buvid`/`uuid` (read
    // off the live domain's response cookies in `platform/bilibili/index.ts`) and the heartbeat's
    // `secret_key` (read out of a response body). Only the refresh token and the CSRF token here
    // are structurally long enough to be safe without asking.
    //
    // The second cost is the one that makes this more than cosmetics, and it is why the parameter
    // rule cannot cover for it: the shredding happens **first**, and `<redacted>` landing inside a
    // name destroys the `\b(name)=` shape `redactCredentialParameters` matches on. A one-character
    // cookie value would therefore also silence the rule that catches the credentials no value
    // list knows — `qrcode_key` on the login poll, the one-time `ticket` on the cross-domain hop —
    // in exactly the sentence that most needed it. `routes/douyu-backpack.ts:280` keeps the same
    // guard for the same reason.
    const chosen = values.filter(value => value.length > 1)
    return redactCredentialParameters(redactSecrets(text, chosen))
  }

  /**
   * Performs one request, attaching the cookie jar and absorbing any cookies
   * the response sets.
   *
   * `redirect: 'manual'` is deliberate: Bilibili's login endpoints complete
   * with a `302` that carries the session cookies, and following the redirect
   * automatically would discard them.
   */
  async request(url: string, init: RequestInit = {}): Promise<RawResponse> {
    const headers = new Headers(init.headers)
    if (!headers.has('User-Agent')) headers.set('User-Agent', this.userAgent)
    if (!headers.has('Referer')) headers.set('Referer', this.referer)

    const cookieHeader = this.cookies.toHeader()
    if (cookieHeader) headers.set('Cookie', cookieHeader)

    // The deadline is composed with the caller's own signal rather than replacing
    // it: spreading `init` first and then setting `signal` would silently drop the
    // caller's, so a request the caller had already abandoned would keep running to
    // the deadline. `AbortSignal.timeout` also arms an unref'd timer, so there is
    // nothing to clear once the response is in, and an expiry now reports
    // `TimeoutError` — "The operation was aborted due to timeout" — where the
    // hand-rolled controller could only ever say "This operation was aborted".
    const deadline = AbortSignal.timeout(this.timeoutMs)
    const signal = init.signal == null ? deadline : AbortSignal.any([deadline, init.signal])

    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        headers,
        signal,
        // Default to manual: the login flow's cookies arrive attached to a 302,
        // and following it automatically would discard them. Callers that must
        // follow a hop (the cross-domain login redirect) opt in explicitly.
        redirect: init.redirect ?? 'manual'
      })
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      // The runtime's own text can name the URL it failed on, so it goes through the
      // same rule as everything else here.
      throw new BiliHttpError(this.redact(url), 0, `request failed: ${this.redact(reason)}`)
    }

    const setCookies = response.headers.getSetCookie()
    if (setCookies.length > 0) this.cookies.absorb(setCookies)

    const body = await response.text()

    // 2xx and 3xx both carry usable payloads here; 3xx is the login completion
    // path. Anything else is a transport-level failure.
    if (response.status >= 400) {
      // The first 200 characters are kept because a gateway's own sentence is often
      // the only diagnostic; they are redacted because that same sentence is where a
      // request — and therefore the session and the CSRF token — gets echoed back.
      const detail = this.redact(`HTTP ${response.status}: ${body.slice(0, 200)}`)
      throw new BiliHttpError(this.redact(url), response.status, detail)
    }

    return { status: response.status, headers: response.headers, body }
  }

  /**
   * Sends a request and validates the JSON body against `schema`.
   *
   * Validation failures throw with the offending path included, because an
   * unexpected payload shape is exactly the class of bug that a bare type
   * assertion would have hidden.
   */
  async requestJson<T>(url: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
    const { body } = await this.request(url, init)

    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      // The runtime's own text is deliberately not forwarded. V8's parse error quotes
      // the first characters of the body it rejected, and a *prefix* of a credential is
      // still a credential — no value rule can match a value it only ever sees ten
      // characters of, so the only way to close that is not to repeat the sentence.
      // The length survives instead, and it is what tells an HTML error page apart from
      // a JSON shape that changed.
      throw new BiliHttpError(this.redact(url), 0, `response was not JSON (${String(body.length)} characters)`)
    }

    const result = schema.safeParse(parsed)
    if (!result.success) {
      const issue = result.error.issues[0]
      const where = issue?.path.join('.') ?? '<root>'
      const detail = issue?.message ?? 'unknown validation error'
      // Redacted for the same reason the body slice is: this sentence is composed from
      // what the response supplied. zod 4 names what it *expected* rather than what it
      // received, so nothing here can carry a credential today — the rule is applied
      // because that is a property of the dependency, not of this line.
      throw new BiliHttpError(this.redact(url), 0, `unexpected response shape at ${where}: ${this.redact(detail)}`)
    }
    return result.data
  }

  /** `GET` returning validated JSON. */
  getJson<T>(url: string, schema: ZodType<T>): Promise<T> {
    return this.requestJson(url, schema, { method: 'GET' })
  }

  /** `POST` with a multipart body returning validated JSON. */
  postForm<T>(url: string, form: FormData, schema: ZodType<T>): Promise<T> {
    return this.requestJson(url, schema, { method: 'POST', body: form })
  }
}
