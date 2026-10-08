import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDatabase, openDatabase } from '../src/db/index.js'
import { type BuiltServer, buildServer } from '../src/index.js'
import { type ParsedCredential, parseCredential } from '../src/platform/douyu/index.js'
import {
  completeBind,
  DEVICE_ID_COOKIES,
  DouyuBindSessionStore,
  type FamilyRenewal,
  GENERATE_CODE_URL,
  generateCode,
  LOGIN_PAGE_URL,
  NO_SESSION_TO_RENEW,
  PassportHttp,
  pollScan,
  QR_POLL_INTERVAL_MS,
  QR_TTL_MS,
  qrCodeDataOf,
  qrLifetimeMs,
  refusalText,
  renewFamily,
  SAFE_AUTH_URL,
  SCAN_CONFIRMING,
  SCAN_DONE,
  SCAN_FAILED,
  SCAN_POLL_URL,
  scanStateOf,
  storePastedCredential,
  TOKEN_COOKIES,
  waitForScan
} from '../src/platform/douyu/passport.js'

/**
 * The Douyu scan bind, tested with the network mocked.
 *
 * Two seams, and only two. The flow functions are driven directly — the real
 * `PassportHttp`, the real schemas, the real credential assembly — with `fetch`
 * stubbed, because that is the boundary where the service lives and the shapes are
 * the whole question. Then the routes are driven through the real Fastify instance,
 * because the wiring (session ownership, status codes, what a response does *not*
 * carry) is exactly where a bind goes wrong quietly. The clock stub inside the first
 * seam's section is harness, not a third seam: it takes a wait out of one case, and
 * the bound it encodes is the loop's own deadline.
 *
 * The credential's own contract is never restated here: the blob written by
 * `completeBind` is read back with the adapter's `parseCredential`, so a field this
 * test file names wrongly would fail rather than agree with itself.
 *
 * **No test scans anything.** A QR scan cannot be performed from here and the
 * account behind it is real, so every response below is a fixture.
 */

/* ------------------------------------------------------------------ *
 * The stubbed service
 * ------------------------------------------------------------------ */

/**
 * The one timer this file waits on, made controllable for a single case.
 *
 * `vi.useFakeTimers()` cannot reach it — the waiting loop sleeps through `node:timers/promises`'
 * own `setTimeout`, which no fake clock patches (`tests/fixtures.ts` records the same limit, and
 * the two suites that needed a clock before this one stub the same module). Unlike theirs, this
 * stub **delegates to the real `setTimeout` until a case installs an override**, so the cadence
 * case below still measures the product's own 1000 ms on the machine's own clock.
 */
const { sleepOverride } = vi.hoisted(() => ({ sleepOverride: { fn: null as null | ((ms: number) => unknown) } }))

vi.mock('node:timers/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:timers/promises')>()
  return {
    ...real,
    setTimeout: (ms: number) => (sleepOverride.fn === null ? real.setTimeout(ms) : sleepOverride.fn(ms))
  }
})

interface Recorded {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string
}

type Responder = (url: string) => Response

const fetchMock = vi.fn()
let calls: Recorded[] = []
let responder: Responder = () => json({ error: 0 })

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  if (input instanceof Request) return input.url
  return ''
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, key) => {
    result[key] = value
  })
  return result
}

function json(
  payload: unknown,
  options: { readonly status?: number; readonly setCookie?: readonly string[] } = {}
): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const cookie of options.setCookie ?? []) headers.append('set-cookie', cookie)
  return new Response(JSON.stringify(payload), { status: options.status ?? 200, headers })
}

async function callFetch(url: string, init: RequestInit = {}): Promise<Response> {
  calls.push({
    url,
    method: init.method ?? 'GET',
    headers: headersOf(init),
    body: typeof init.body === 'string' ? init.body : ''
  })
  return await responder(url)
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const UID = '456918967'
/** A `stk` with an underscore in it on purpose — the both-ends split's whole reason. */
const STK = 'ab_cd_0123456789'
const BIZ = '1'
const CT = '0'
const LTKID = '69117311'
const DID = '20e8917f4ebe85866a5e94cfaba2f156'
const NICKNAME = '测试账号'

/**
 * The avatar address as the live session carries it: a stem, a trailing underscore and
 * **no size and no extension**. The usable image is `<stem>_middle.jpg`; the reference
 * account switcher appends the same suffix, and this platform's own task-center page
 * published the same stem with `_middle.jpg` on it.
 */
const AVATAR_STEM = 'https://apic.douyucdn.cn/upload/avatar_v3/202510/f22d0131e9234673ba2bf217020c7128_'
const AVATAR_URL = `${AVATAR_STEM}middle.jpg`

/**
 * The long-lived session cookie, exactly as the poll endpoint declares it (§3):
 * `Max-Age=15768000` — 182.5 days — beside an `Expires` that agreed with it in the
 * capture (§2.1 quotes both, verbatim). Replayed at any other moment the two disagree,
 * which is why the cases below read the `Max-Age` and would notice if it were ignored.
 */
const LTP0_VALUE = 'ltp0-ciphertext-not-a-credential'
const LTP0_COOKIE = `LTP0=${LTP0_VALUE}`
const LTP0_MAX_AGE_MS = 15_768_000_000
const LTP0_SET_COOKIE = `${LTP0_COOKIE}; Max-Age=15768000; Expires=Thu, 08-Apr-2027 10:23:09 GMT; Path=/; Secure; HttpOnly`

/**
 * The token family's own declared life, in milliseconds — `Max-Age=529200`, which is 6.125 days and
 * `604800 × 0.875` rather than the seven days this repo once asserted.
 *
 * A literal rather than a constant imported from the code under test: what the cases below assert is
 * that a *measured* number ends up in the blob, so the measurement has to be on this side.
 */
const FAMILY_LIFE_MS = 529_200_000

/**
 * The clock the expiry cases are derived against, and how they pin it without touching
 * timers: `vi.setSystemTime` with fake timers *off* mocks `Date.*` only, so the flow's
 * real clock — `waitForScan` waits on `node:timers/promises` — keeps running.
 */
const NOW = 1_700_000_000_000

const SCAN_CODE = 'e0f3a1b2c3d4e5f60718293a4b5c6d7e'
const QR_CONTENT = `https://m.douyu.com/topic/scan-login-middle-page?scan_code=${SCAN_CODE}`
const LANDING = `https://www.douyu.com/api/passport/login?uid=${UID}&code=${SCAN_CODE}&loginType=scanCheck`

/**
 * The same landing link, on an origin that is not Douyu's.
 *
 * The negative example the renewal path has had all along (`refuses a Location off Douyu's own
 * hosts…`) and this path did not: the poll payload's `data.url` is a bare non-empty string, and the
 * GET that follows it carries the whole jar — the `LTP0` from the poll's own `Set-Cookie` included.
 */
const OFF_HOST_LANDING = 'https://example.com/api/passport/login?uid=1&code=deadbeef&loginType=scanCheck'

/**
 * The landing hop's own `Set-Cookie` list, **the capture's, name for name — and no device cookie in
 * it.**
 *
 * `default-workspace/dump-login-landing.txt` is that hop (`chat-web.mitm`, the JSONP landing the
 * confirmed scan is sent to), and `douyu-ltp0-renewal-2026-10-08/passport-login-flows.jsonl` carries
 * the same seventeen names for the same request. The fixture used to add `dy_did` to them, and this
 * response never sends it: the `dy_did`/`acf_did` in that capture's *request* headers are the
 * browser profile's, set before the scan began, so a fixture that handed the flow one was granting
 * it a value the service never gave it — which is exactly what hid the fact that this flow has no
 * source for a device id at all. `passport.ts`'s `NO_DEVICE_ID` carries the measurement and the
 * consequence; the case below asserts this list verbatim so it cannot drift back.
 */
const LANDING_COOKIES = [
  'PHPSESSID',
  'acf_auth',
  'acf_jwt_token',
  'acf_dmjwt_token',
  'dy_auth',
  'acf_uid',
  'acf_username',
  'acf_nickname',
  'acf_own_room',
  'acf_groupid',
  'acf_phonestatus',
  'acf_avatar',
  'acf_ct',
  'acf_ltkid',
  'acf_biz',
  'acf_stk',
  'acf_isNewUser'
] as const

/** The page cookie the flow's first hop is recorded landing, in the sibling flow's own spelling. */
const PAGE_SESSION_COOKIE = 'PHPSESSID=page-session; Path=/; Domain=passport.douyu.com'

/**
 * The device cookie the fixture's **first** hop sets, and that placement is a stated assumption.
 *
 * The first hop — `GET https://passport.douyu.com/member/login`, the warm-up `generateCode`
 * performs — is the only hop in this flow whose response headers are in no capture. Every hop that
 * *is* recorded sets no device cookie (`LANDING_COOKIES` above, the poll's `LTP0` +
 * `dy_accounts_main`, and the sibling flow's page hop with an empty list), so this fixture has two
 * ways to express "a scan that can finish": put the value where the service might have put it, or
 * give the flow none and accept that it cannot. It does the first, and is explicit that the
 * mechanism points the other way — `dy_did` is written by `douyu-did.js` into `document.cookie`, and
 * no `fetch` runs a script. The second reading is pinned by the case that runs the whole recorded
 * flow (`page: [PAGE_SESSION_COOKIE]`), and `passport.ts`'s `NO_DEVICE_ID` is where both readings
 * and the fix are written down.
 */
const DEVICE_COOKIE = `dy_did=${DID}; Path=/; Domain=.douyu.com`

/**
 * The landing hop's answer: the capture's names, placeholder values, and the one declared life the
 * bind actually reads.
 *
 * Names and order are `LANDING_COOKIES`'; the values are placeholders because a capture's values are
 * credentials. The `Max-Age` on the five token components is the capture's own measurement
 * (`Max-Age=529200`, `FAMILY_LIFE_MS`) and is applied exactly where the code reads a life — the
 * family's clock — while `acf_avatar` and `PHPSESSID` are declared without one there too.
 */
function cookies(overrides: Record<string, string> = {}): string[] {
  const session: Record<string, string> = {
    PHPSESSID: 'page-session-on-the-landing-host',
    acf_auth: 'auth-placeholder',
    acf_jwt_token: 'jwt-placeholder',
    acf_dmjwt_token: 'dmjwt-placeholder',
    dy_auth: 'dy-auth-placeholder',
    acf_uid: UID,
    // The live session puts the **uid** in `acf_username` and the name in
    // `acf_nickname` — the wrong-cookie read this test fixture used to reproduce.
    acf_username: UID,
    acf_nickname: encodeURIComponent(NICKNAME),
    acf_own_room: '0',
    acf_groupid: '1',
    acf_phonestatus: '1',
    acf_avatar: encodeURIComponent(AVATAR_STEM),
    acf_ct: CT,
    acf_ltkid: LTKID,
    acf_biz: BIZ,
    acf_stk: STK,
    acf_isNewUser: '1',
    ...overrides
  }

  return Object.entries(session)
    .filter(([, value]) => value !== '')
    .map(
      ([name, value]) =>
        `${name}=${value}; Path=/; Domain=.douyu.com${
          // The token's five components are declared together, and the family's life is read out of
          // exactly this attribute — so a fixture that omitted it would exercise the fallback in
          // `passport.ts` instead of the declared clock the capture shows.
          (TOKEN_COOKIES as readonly string[]).includes(name) ? '; Max-Age=529200' : ''
        }`
    )
}

/**
 * The whole handshake, as the service answers it on the web route.
 *
 * The poll's success payload carries the landing link and **nothing else** — no
 * `short_token`, no `expire_in`, which is the captured shape verbatim (§7) — while the
 * session arrives on that same response's own `Set-Cookie` list, which is where the jar
 * picks `LTP0` up. `pollCookies: []` is therefore how a scan that lands no long-lived
 * session at all is expressed.
 *
 * `page` is the first hop's list, and it is the fixture's device-id knob: see `DEVICE_COOKIE` for
 * why the default puts one there and why that is an assumption, and the `page: [PAGE_SESSION_COOKIE]`
 * case below for the reading the evidence supports.
 */
function webRoute(
  options: {
    readonly page?: readonly string[]
    readonly landing?: readonly string[]
    readonly pollCookies?: readonly string[]
  } = {}
): Responder {
  return (url: string): Response => {
    if (url === LOGIN_PAGE_URL) {
      // A page cookie the flow then carries: §7 records `dy_did` as a passport-host
      // cookie, so a jar that is not empty before the landing hop is the real state.
      const headers = new Headers({ 'content-type': 'text/html' })
      for (const cookie of options.page ?? [PAGE_SESSION_COOKIE, DEVICE_COOKIE]) headers.append('set-cookie', cookie)
      return new Response('<!doctype html>', { status: 200, headers })
    }
    if (url === GENERATE_CODE_URL) {
      return json({ error: 0, data: { code: SCAN_CODE, url: QR_CONTENT, expire: 300 } })
    }
    if (url.startsWith('https://passport.douyu.com/japi/scan/auth')) {
      return json({ error: SCAN_DONE, data: { url: LANDING } }, { setCookie: options.pollCookies ?? [LTP0_SET_COOKIE] })
    }
    if (url.startsWith('https://www.douyu.com/api/passport/login')) {
      return json({ error: 0 }, { setCookie: options.landing ?? cookies() })
    }
    return json({ error: 0 })
  }
}

/** One confirmed scan: generate, poll, and hand the poll back. */
async function confirmedScan(http: PassportHttp): Promise<Awaited<ReturnType<typeof pollScan>>> {
  const generated = await generateCode(http)
  const data = qrCodeDataOf(generated)
  if (data === null) throw new Error('the fixture did not produce a QR code')
  return await pollScan(http, data.code)
}

let db: DatabaseSync

function seedUser(username = 'tester'): void {
  db.prepare('INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, 0, 0)').run(
    username,
    'x'
  )
}

function rows(): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM accounts WHERE platform = ? ORDER BY id ASC').all('douyu')
}

beforeEach(() => {
  vi.clearAllMocks()
  calls = []
  responder = () => json({ error: 0 })
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => await callFetch(urlOf(input), init))
  vi.stubGlobal('fetch', fetchMock)

  db = openDatabase(':memory:')
  seedUser()
})

afterEach(() => {
  vi.useRealTimers()
  // The stub below must not outlive the one case that installs it: every other case in this
  // file — the cadence case included — is meant to wait on the real timer.
  sleepOverride.fn = null
  vi.unstubAllGlobals()
  closeDatabase()
})

/* ------------------------------------------------------------------ *
 * generateCode
 * ------------------------------------------------------------------ */

describe('generateCode', () => {
  it('starts at the login page, then posts the page\u2019s own two parameters', async () => {
    responder = webRoute()

    const result = await generateCode(new PassportHttp())

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      `GET ${LOGIN_PAGE_URL}`,
      `POST ${GENERATE_CODE_URL}`
    ])
    expect(calls[1]?.body).toBe('client_id=1&isMultiAccount=0')
    expect(calls[1]?.headers['content-type']).toContain('application/x-www-form-urlencoded')
    expect(calls[1]?.headers['x-requested-with']).toBe('XMLHttpRequest')

    expect(result.error).toBe(SCAN_DONE)
    expect(qrCodeDataOf(result)).toEqual({ code: SCAN_CODE, url: QR_CONTENT, expire: 300 })
  })

  it('returns a refusal as data, with the service\u2019s own sentence and no throw', async () => {
    // The shape a refusal takes whatever its code: the prose sits in `data`, which is
    // why the envelope does not insist `data` is an object.
    responder = () => json({ error: 1, data: '系统异常，请重试' })

    const result = await generateCode(new PassportHttp())

    expect(result.error).toBe(1)
    expect(qrCodeDataOf(result)).toBeNull()
    expect(refusalText(result)).toBe('系统异常，请重试')
  })

  it('says something a person can act on when the service gives no prose at all', async () => {
    expect(refusalText({ error: -7 })).toBe('斗鱼返回错误码 -7')
  })
})

/* ------------------------------------------------------------------ *
 * scanStateOf / pollScan
 * ------------------------------------------------------------------ */

describe('scanStateOf', () => {
  it.each([
    [SCAN_DONE, 'success'],
    [SCAN_CONFIRMING, 'scanned'],
    [SCAN_FAILED, 'expired']
  ])('names error %i as %s', (error, expected) => {
    expect(scanStateOf({ error })).toBe(expected)
  })

  it('treats any other code as pending, which is what the page does with them', () => {
    // `-2 客户端还未扫码` is recorded against the *outdated* `qrcode/check` endpoint
    // (§12), so it is not given a meaning here; the bundle's own switch keeps polling
    // for anything that is not 0, 1 or -1.
    for (const error of [-2, 2, 99, 404]) {
      expect(scanStateOf({ error })).toBe('pending')
    }
  })

  it('reads a numeric string code, which this service also sends', async () => {
    // Douyu types the same field as a number or as a numeric string, so the coercion
    // is tested where it happens — at the schema — rather than by hand-building a
    // response the transport would never produce.
    responder = () => json({ error: '0', data: { url: LANDING } })

    const poll = await pollScan(new PassportHttp(), SCAN_CODE)

    expect(poll.error).toBe(SCAN_DONE)
    expect(scanStateOf(poll)).toBe('success')
  })
})

describe('pollScan', () => {
  it('asks with a millisecond clock and the code', async () => {
    const before = Date.now()
    responder = () => json({ error: SCAN_CONFIRMING })

    await pollScan(new PassportHttp(), SCAN_CODE)

    const url = calls[0]?.url ?? ''
    const time = Number(new URL(url).searchParams.get('time'))
    expect(url.startsWith('https://passport.douyu.com/japi/scan/auth?')).toBe(true)
    expect(new URL(url).searchParams.get('code')).toBe(SCAN_CODE)
    // Milliseconds, like the page's own `(new Date).getTime()`, not seconds.
    expect(time).toBeGreaterThanOrEqual(before)
    expect(time).toBeGreaterThan(1_000_000_000_000)
  })
})

/* ------------------------------------------------------------------ *
 * PassportHttp's jar
 * ------------------------------------------------------------------ */

/**
 * What the jar keeps of a `Set-Cookie`, which is the whole of what this session's
 * lifetime is known from: neither long-lived Douyu cookie can be read for a clock (§6),
 * so the attributes on the response that minted one are the only statement of its life
 * there will ever be.
 */
describe('PassportHttp absorb', () => {
  /**
   * One client, fed each round's `Set-Cookie` list in turn — because a name's newest
   * declaration is the one that describes the jar, and that is a sequence, not a state.
   */
  async function jarAfter(...rounds: readonly (readonly string[])[]): Promise<PassportHttp> {
    const http = new PassportHttp()
    for (const setCookie of rounds) {
      responder = () => json({ error: 0 }, { setCookie })
      await http.request(SCAN_POLL_URL)
    }
    return http
  }

  beforeEach(() => {
    vi.setSystemTime(NOW)
  })

  it('keeps a Max-Age, as the instant the attribute describes', async () => {
    const http = await jarAfter([LTP0_SET_COOKIE])

    // 15768000 seconds from the moment the response arrived: the captured attribute, not
    // a window this adapter could have invented. The fixture carries an `Expires` in 2027
    // as well, so this also settles precedence — a jar reading the date first would answer
    // with that instead.
    expect(http.cookieExpiresAt('LTP0')).toBe(NOW + LTP0_MAX_AGE_MS)
    expect(http.cookieValue('LTP0')).toBe('ltp0-ciphertext-not-a-credential')
  })

  it('prefers Max-Age, and reads Expires in the dash spelling when that is all it has', async () => {
    // Both attributes on one cookie, as this service sends them: 3600 is what a browser
    // uses (`acf_auth`'s App form is the 3600 case, §6) and the 2026 date is what it drops.
    const both = await jarAfter(['acf_auth=opaque; expires=Wed, 14-Oct-2026 01:23:09 GMT; Max-Age=3600'])
    expect(both.cookieExpiresAt('acf_auth')).toBe(NOW + 3_600_000)

    // The date alone. `Wed, 14-Oct-2026` is the service's own spelling — dashes, not RFC
    // 1123 — so it is pinned to a literal rather than to a re-parse here.
    const dateOnly = await jarAfter(['acf_auth=opaque; expires=Wed, 14-Oct-2026 01:23:09 GMT'])
    expect(dateOnly.cookieExpiresAt('acf_auth')).toBe(1_791_940_989_000)
  })

  it('treats a Set-Cookie with no expiry attribute as a session cookie', async () => {
    const http = await jarAfter([LTP0_SET_COOKIE], ['LTP0=replaced; Path=/'])

    // The newest declaration describes the jar now: the value is the new one, and the
    // 182.5 days the earlier response declared went with the value they belonged to.
    expect(http.cookieValue('LTP0')).toBe('replaced')
    expect(http.cookieExpiresAt('LTP0')).toBeNull()
  })

  it('forgets the expiry with the value when the service withdraws a cookie', async () => {
    const http = await jarAfter(['acf_auth=opaque; Max-Age=529200'], ['acf_auth=deleted; Max-Age=0'])

    expect(http.cookieValue('acf_auth')).toBeUndefined()
    expect(http.cookieExpiresAt('acf_auth')).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * completeBind
 * ------------------------------------------------------------------ */

describe('completeBind', () => {
  it('writes a blob the adapter\u2019s own parser accepts, with the jar and the session clock', async () => {
    // The clock is pinned before the poll, because that is the response whose `Set-Cookie`
    // the jar turns into an instant.
    vi.setSystemTime(NOW)
    responder = webRoute()
    const http = new PassportHttp()
    const poll = await confirmedScan(http)
    const now = NOW

    const outcome = await completeBind(db, 1, http, poll, now)
    if (!outcome.ok) throw new Error(`expected a bind, got: ${outcome.error}`)

    // Read back through the adapter rather than re-deriving the field names here.
    const credentials = String(rows()[0]?.['credentials'])
    const parsed = parseCredential(credentials)
    if (parsed === null) throw new Error('the adapter refused the blob this binder wrote')

    expect(parsed.token).toBe(`${UID}_${BIZ}_${STK}_${CT}_${LTKID}`)
    expect(parsed.uid).toBe(UID)
    // The both-ends split: `stk` holds an underscore and nothing after it shifted.
    expect(parsed.stk).toBe(STK)
    expect(parsed.ct).toBe(CT)
    expect(parsed.ltkid).toBe(LTKID)
    expect(parsed.did).toBe(DID)

    // The session cookie's own `Max-Age`, turned into an instant against the clock that
    // absorbed it — and not the `Expires` in 2027 that the same fixture declares, because
    // `Max-Age` is the attribute a browser uses. A literal, not the multiplication re-run.
    expect(parsed.expiresAt).toBe(NOW + LTP0_MAX_AGE_MS)

    // The family's own clock, out of the same response and read for the same reason: the five
    // components were declared `Max-Age=529200` on it, and `refresh` is what schedules the next
    // rebuild from this stamp.
    expect(parsed.tokenExpiresAt).toBe(NOW + FAMILY_LIFE_MS)

    // The whole web cookie jar, as one header value.
    expect(parsed.webCookies).toContain(`acf_stk=${STK}`)
    expect(parsed.webCookies).toContain(`dy_did=${DID}`)
    expect(parsed.webCookies).toContain('acf_uid=')

    const row = rows()[0]
    expect(row?.['external_id']).toBe(UID)
    // The name, not the id the session also carries in `acf_username`: reading the wrong
    // cookie is what put `456918967` in this column and on the account row.
    expect(row?.['display_name']).toBe(NICKNAME)
    expect(row?.['display_name']).not.toBe(UID)
    // The cookie's stem with the CDN size on it, because a stem alone is not an address.
    expect(row?.['avatar']).toBe(AVATAR_URL)
    expect(JSON.parse(String(row?.['meta']))).toEqual({
      boundVia: 'scan-login',
      boundAt: now,
      // A cookie *name*, never a value: what an operator reads to see whether this binding
      // has the long login without opening the credential.
      sessionCookie: 'LTP0'
    })
  })

  /**
   * The two honest answers, both of which have to leave the row unnamed and imageless
   * rather than write something that is not a name or not an address.
   */
  it('writes no name when the session carries only the uid, and no avatar when the cookie is absent', async () => {
    responder = webRoute({ landing: cookies({ acf_nickname: '', acf_avatar: '', acf_username: UID }) })
    const http = new PassportHttp()

    const outcome = await completeBind(db, 1, http, await confirmedScan(http))

    expect(outcome.ok).toBe(true)
    expect(rows()[0]?.['display_name']).toBe('')
    expect(rows()[0]?.['avatar']).toBe('')
  })

  it('leaves a complete avatar address alone instead of adding a second size to it', async () => {
    responder = webRoute({ landing: cookies({ acf_avatar: encodeURIComponent(AVATAR_URL) }) })
    const http = new PassportHttp()

    const outcome = await completeBind(db, 1, http, await confirmedScan(http))

    expect(outcome.ok).toBe(true)
    expect(rows()[0]?.['avatar']).toBe(AVATAR_URL)
  })

  it('finishes the login through the JSONP landing hop, not by reusing the poll', async () => {
    responder = webRoute()
    const http = new PassportHttp()
    await completeBind(db, 1, http, await confirmedScan(http))

    const hop = calls.find(call => call.url.startsWith('https://www.douyu.com/api/passport/login'))
    expect(hop?.url).toContain('callback=appClient_json_callback')
    expect(hop?.url).toContain('scanCheck')
  })

  it('refuses a landing link off Douyu’s own hosts rather than carrying the key to it', async () => {
    // The twin of the renewal path's off-host case, and the one this hop was missing. The URL is the
    // service's own `data.url` and the schema asks only that it be a non-empty string, while the GET
    // that follows it carries the jar the poll response just landed — `LTP0` (182.5 days) included.
    // The response to that GET is also what mints the account's `acf_*` family, so an origin that is
    // not Douyu's could both read a session key and decide whose credential the row is written from.
    responder = (url: string): Response => {
      if (url.startsWith('https://passport.douyu.com/japi/scan/auth')) {
        return json({ error: SCAN_DONE, data: { url: OFF_HOST_LANDING } }, { setCookie: [LTP0_SET_COOKIE] })
      }
      return webRoute()(url)
    }

    const http = new PassportHttp()
    const outcome = await completeBind(db, 1, http, await confirmedScan(http))

    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('不在斗鱼域名下') })
    // The whole reason the host is checked before the request is made: `LTP0` and the device pair
    // never left Douyu's hosts, and nothing was bound either.
    expect(calls.some(call => call.url.startsWith('https://example.com'))).toBe(false)
    expect(rows()).toEqual([])
  })

  it('decides that host at both boundaries: an origin that only looks like Douyu’s, and a real subdomain', async () => {
    // `example.com` was the only negative this guard had, and a guard with one negative is half a
    // guard: the case it exists for is the origin that *reads* as Douyu's, and the case it must not
    // refuse is the real subdomain. `DOUYU_HOST` is `^(www\.|m\.)?douyu\.com$`, so this pins four
    // refusals and one admission, and the refusal is asserted twice — the sentence, and no request
    // ever reaching the URL, because the sentence alone would pass for a hop that happened and was
    // reported afterwards.
    const refused = [
      // A prefix that is not a host boundary.
      'https://notdouyu.com',
      // Douyu's name as somebody else's subdomain — the direction the anchored rule is for.
      'https://douyu.com.evil.example',
      // A host that merely *contains* the name.
      'https://douyu.com.example.org',
      // A real Douyu host that is deliberately not in the set: this hop is served by the site host,
      // and the recorded landing link is `www.douyu.com/api/passport/login`.
      'https://passport.douyu.com'
    ]

    for (const origin of refused) {
      calls = []
      const landing = `${origin}/landing-not-followed`
      responder = (url: string): Response =>
        url.startsWith('https://passport.douyu.com/japi/scan/auth')
          ? json({ error: SCAN_DONE, data: { url: landing } }, { setCookie: [LTP0_SET_COOKIE] })
          : webRoute()(url)

      const http = new PassportHttp()
      const outcome = await completeBind(db, 1, http, await confirmedScan(http))

      expect(outcome, origin).toMatchObject({ ok: false, error: expect.stringContaining('不在斗鱼域名下') })
      expect(
        calls.some(call => call.url.includes('/landing-not-followed')),
        origin
      ).toBe(false)
      expect(rows(), origin).toEqual([])
    }

    // The other boundary: `m.douyu.com` is in the set, so the hop is made and the bind completes.
    // Without this half, a guard that refused *everything* would satisfy every case above.
    calls = []
    const allowed = 'https://m.douyu.com/api/passport/login'
    responder = (url: string): Response => {
      if (url.startsWith('https://passport.douyu.com/japi/scan/auth')) {
        return json({ error: SCAN_DONE, data: { url: `${allowed}?uid=${UID}` } }, { setCookie: [LTP0_SET_COOKIE] })
      }
      if (url.startsWith(allowed)) return json({ error: 0 }, { setCookie: cookies() })
      return webRoute()(url)
    }

    const http = new PassportHttp()
    const outcome = await completeBind(db, 1, http, await confirmedScan(http))

    expect(outcome.ok).toBe(true)
    expect(calls.some(call => call.url.startsWith(allowed))).toBe(true)
    expect(rows()).toHaveLength(1)
  })

  it('lands a jar that arrives on a 302, because the client does not follow redirects', async () => {
    responder = (url: string): Response => {
      if (url.startsWith('https://www.douyu.com/api/passport/login')) {
        const headers = new Headers({ location: 'https://www.douyu.com/' })
        for (const cookie of cookies()) headers.append('set-cookie', cookie)
        return new Response(null, { status: 302, headers })
      }
      return webRoute()(url)
    }

    const http = new PassportHttp()
    const outcome = await completeBind(db, 1, http, await confirmedScan(http))

    expect(outcome.ok).toBe(true)
    expect(parseCredential(String(rows()[0]?.['credentials']))?.did).toBe(DID)
  })

  it('sends the jar it holds back to the flow\u2019s own origin, never to h5nc', async () => {
    responder = webRoute()
    const http = new PassportHttp()

    await completeBind(db, 1, http, await confirmedScan(http))

    // The jar really was in use — otherwise the two assertions below would pass
    // against a flow that never sent a cookie at all.
    expect(calls.some(call => call.headers['cookie'] !== undefined)).toBe(true)

    // The trap: a web cookie beside a valid token turns `h5nc/*` into
    // `999999 系统错误` (§2.2), so no request on this path belongs to that family...
    expect(calls.filter(call => call.url.includes('h5nc'))).toEqual([])

    // ...and nothing the flow carries ever reaches the host that family lives on.
    for (const call of calls) {
      if (call.headers['cookie'] === undefined) continue
      expect(new URL(call.url).hostname).not.toBe('apiv2.douyucdn.cn')
    }
  })

  it('answers the landing hop with the capture’s own cookie names, none of which is a device cookie', () => {
    // The list, verbatim, so a later edit cannot quietly put `dy_did` back into a response that
    // never sent it. `DEVICE_ID_COOKIES` is what the bind reads; the recorded *request* headers
    // carry two of those names because the browser had them before the scan started, which this
    // flow cannot use.
    const landing = cookies()
    const names = landing.map(entry => entry.slice(0, entry.indexOf('=')))

    expect(names).toEqual([...LANDING_COOKIES])
    for (const device of DEVICE_ID_COOKIES) expect(names).not.toContain(device)
  })

  it('refuses a scan that ran the recorded flow end to end, and names the route that has a device id', async () => {
    // Every hop as the capture shows it: the first hop lands the page cookie and nothing else (its
    // own recorded sibling — `passport.douyu.com/index/login` — answers `[]`), the poll lands `LTP0`
    // and `dy_accounts_main`, and the landing hop lands `LANDING_COOKIES`. No response in the flow
    // sets a device cookie, so this is the state a real scan reaches unless the unrecorded first hop
    // is the source `DEVICE_COOKIE` assumes it is — and the sentence has to send a person to the path
    // that works instead of telling them to scan again, which cannot change any of the above.
    responder = webRoute({ page: [PAGE_SESSION_COOKIE] })
    const http = new PassportHttp()

    const outcome = await completeBind(db, 1, http, await confirmedScan(http))

    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('没有拿到设备号') })
    expect(outcome.ok ? '' : outcome.error).toContain('粘贴凭据绑定')
    // The scan worked, so the family was there: the refusal is about the device id alone.
    expect(calls.some(call => call.url.startsWith('https://www.douyu.com/api/passport/login'))).toBe(true)
    expect(rows()).toEqual([])
  })

  it('takes `acf_did` when that is the name the jar holds the device id under', async () => {
    // `DEVICE_ID_COOKIES` is an ordered list of three names and the bind reads the first present
    // one; this is the second member, which no other case in this file reaches.
    responder = webRoute({ page: [PAGE_SESSION_COOKIE, `acf_did=${DID}; Path=/; Domain=.douyu.com`] })
    const http = new PassportHttp()

    const outcome = await completeBind(db, 1, http, await confirmedScan(http))

    expect(outcome.ok).toBe(true)
    expect(parseCredential(String(rows()[0]?.['credentials']))?.did).toBe(DID)
  })

  it('refuses a scan whose token is incomplete, and writes nothing', async () => {
    responder = webRoute({ landing: cookies({ acf_ct: '' }) })
    const http = new PassportHttp()

    const outcome = await completeBind(db, 1, http, await confirmedScan(http))

    expect(outcome.ok).toBe(false)
    expect(rows()).toEqual([])
  })

  it('records no session clock, and says so in meta, when no session cookie was landed', async () => {
    const now = NOW
    responder = webRoute({ pollCookies: [] })
    const http = new PassportHttp()

    const outcome = await completeBind(db, 1, http, await confirmedScan(http), now)
    expect(outcome.ok).toBe(true)

    // No `Set-Cookie` declared a life for anything this flow keeps, so none is written:
    // a binder that invented a window is the defect this case exists to pin away.
    const parsed = parseCredential(String(rows()[0]?.['credentials']))
    expect(parsed?.expiresAt).toBeNull()
    // The jar is still stored — the `japi/*` family needs it — it simply holds no
    // long-lived session, and the row says that too.
    expect(parsed?.webCookies).not.toBe('')
    expect(JSON.parse(String(rows()[0]?.['meta']))).toEqual({ boundVia: 'scan-login', boundAt: now })
  })

  it('ignores a `short_token` in the poll payload, which the web route never sends', async () => {
    // The PC route's bundle offered to *this* route's answer. It is what the binder used to
    // take a lifetime from, and it must now change nothing: its `expire_in` is a 2026
    // instant, the session cookie beside it says 182.5 days from now, and the cookie wins.
    vi.setSystemTime(NOW)
    responder = (url: string): Response =>
      url.startsWith('https://passport.douyu.com/japi/scan/auth')
        ? json(
            { error: SCAN_DONE, data: { url: LANDING, short_token: { expire_in: 1_791_411_776 } } },
            { setCookie: [LTP0_SET_COOKIE] }
          )
        : webRoute()(url)
    const http = new PassportHttp()

    await completeBind(db, 1, http, await confirmedScan(http), NOW)

    const parsed = parseCredential(String(rows()[0]?.['credentials']))
    expect(parsed?.expiresAt).toBe(NOW + LTP0_MAX_AGE_MS)
  })

  it('refuses a confirmed scan that carries no landing link', async () => {
    responder = (url: string): Response =>
      url.startsWith('https://passport.douyu.com/japi/scan/auth')
        ? json({ error: SCAN_DONE, data: { logoutUrls: ['https://www.douyu.com/logout'] } })
        : webRoute()(url)

    const http = new PassportHttp()
    const outcome = await completeBind(db, 1, http, await confirmedScan(http))

    expect(outcome.ok).toBe(false)
    expect(rows()).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * renewFamily
 * ------------------------------------------------------------------ */

/**
 * The `LTP0` → `acf_*` exchange, replayed from the one recorded run of it.
 *
 * `renewal-follow.json` (2026-10-08, the H1/H2 hops) is where every constant below comes from: the
 * four cookie *names* the first hop carried, the sixteen `Set-Cookie` names the second hop answered
 * with, each value's length, and the `Max-Age=529200` every component of the token declared. The
 * values themselves are not in the record — it kept lengths, not secrets — so each one here is that
 * many characters of a name-derived filler, except the five components of the token, whose values
 * are what the reassembly is asserted against and are therefore written out.
 *
 * **Nothing here talks to Douyu.** One exchange has been made, once, and the record of it is the
 * fixture; a second live call would prove nothing the first did not.
 */
const NEW_CODE = 'e0f3a1b2c3d4e5f60718293a4b5c6d7e'
const LANDING_LINK = `https://www.douyu.com/api/passport/login?callback=__jp0&client_id=&code=${NEW_CODE}&isAutoReg=&loginType=safeAuth&nickname=&uid=${UID}`

/** One recorded `Set-Cookie`: its name, the value's length, and the `Max-Age` it declared. */
const RECORDED_FAMILY: readonly (readonly [string, number, string | null])[] = [
  ['PHPSESSID', 26, null],
  ['acf_auth', 125, '529200'],
  ['acf_jwt_token', 258, '529200'],
  ['acf_dmjwt_token', 258, '529200'],
  ['dy_auth', 123, '529200'],
  ['acf_uid', 9, '529200'],
  ['acf_username', 9, '529200'],
  ['acf_nickname', 36, '529200'],
  ['acf_own_room', 1, '529200'],
  ['acf_groupid', 1, '529200'],
  ['acf_phonestatus', 1, '529200'],
  ['acf_avatar', 96, null],
  ['acf_ct', 1, '529200'],
  ['acf_ltkid', 8, '529200'],
  ['acf_biz', 1, '529200'],
  ['acf_stk', 16, '529200']
]

/** The family the stored blob's jar holds, and the token the adapter is holding because of it. */
const OLD_FAMILY = { acf_uid: UID, acf_biz: BIZ, acf_stk: STK, acf_ct: CT, acf_ltkid: LTKID }

/** The rebuilt family: the same account's uid, and five values the response has just minted. */
const NEW_FAMILY = { acf_uid: UID, acf_biz: '2', acf_stk: 'ff778899aabbccdd', acf_ct: '3', acf_ltkid: '69117312' }

/** A cookie the exchange never hears about, to prove a stored jar is merged rather than replaced. */
const KEPT_COOKIE = 'acf_ccn'
const KEPT_VALUE = 'kept_ccn_value'

/** The blob's jar as a bind writes it: the session, the device cookies, the family, a minted csrf. */
const STORED_JAR = [
  `dy_did=${DID}`,
  `acf_did=${DID}`,
  'dy_accounts_main=1',
  LTP0_COOKIE,
  ...Object.entries(OLD_FAMILY).map(([name, value]) => `${name}=${value}`),
  `${KEPT_COOKIE}=${KEPT_VALUE}`
].join('; ')

/** The session cookie's own declared death, as a bind records it and as the renewal must carry it. */
const SESSION_STAMP = NOW + LTP0_MAX_AGE_MS

/** A value of exactly the length the record gives that name. */
function filler(name: string, length: number): string {
  return `${name}${'x'.repeat(length)}`.slice(0, length)
}

/** The second hop's `Set-Cookie` list, rebuilt from the record. */
function rebuiltFamily(family: Readonly<Record<string, string>> = NEW_FAMILY, declaresLife = true): string[] {
  return RECORDED_FAMILY.map(([name, length, declared]) => {
    const value = family[name] ?? filler(name, length)
    const maxAge = declaresLife ? declared : null
    return `${name}=${value}; Path=/${maxAge === null ? '' : `; Max-Age=${maxAge}`}`
  })
}

/**
 * The two hops as the service answers them: a `302` to the landing link, then the family.
 *
 * Every knob is a way the exchange can go wrong and one of the cases below needs: a `Location` it
 * should not follow, an answer that carries no family at all, a family that declares no life.
 */
function renewalRoute(
  options: {
    readonly family?: Readonly<Record<string, string>>
    readonly location?: string
    readonly landingCookies?: readonly string[]
    readonly declaresLife?: boolean
  } = {}
): Responder {
  return (url: string): Response => {
    if (url.startsWith(SAFE_AUTH_URL)) {
      return new Response(null, { status: 302, headers: { location: options.location ?? LANDING_LINK } })
    }
    if (url.startsWith('https://www.douyu.com/api/passport/login')) {
      const setCookie =
        options.landingCookies ?? rebuiltFamily(options.family ?? NEW_FAMILY, options.declaresLife ?? true)
      return json({ error: 0, msg: 'ok', data: [] }, { setCookie })
    }
    return json({ error: 0 })
  }
}

/** The cookie *names* one request carried, in the order it sent them. */
function cookieNamesIn(header: string): string[] {
  return header
    .split(';')
    .map(pair => pair.slice(0, pair.indexOf('=')).trim())
    .filter(name => name !== '')
}

/** The blob a renewal handed back, read through the adapter's own parser. */
function credentialOf(result: FamilyRenewal): ParsedCredential {
  if (!result.ok) throw new Error(`expected a rebuild, got: ${result.reason}`)
  const parsed = parseCredential(result.credentials)
  if (parsed === null) throw new Error('the renewal wrote a blob the adapter cannot read')
  return parsed
}

describe('renewFamily', () => {
  // The jar turns a declared `Max-Age` into an instant against the clock that absorbed it, so the
  // cases that assert one pin the clock — without fake timers, so the transport's own deadline is
  // untouched (see `PassportHttp absorb` above).
  beforeEach(() => {
    vi.setSystemTime(NOW)
  })

  /** One exchange, with the blob's own fields and a pinned clock. */
  async function renew(
    overrides: {
      readonly did?: string
      readonly uid?: string
      readonly webCookies?: string
      readonly expiresAt?: number | null
      readonly now?: number
    } = {}
  ): Promise<FamilyRenewal> {
    return await renewFamily({
      did: DID,
      uid: UID,
      webCookies: STORED_JAR,
      expiresAt: SESSION_STAMP,
      now: NOW,
      ...overrides
    })
  }

  it('replays both hops: the recorded URL, the two referers, and the four cookies of the capture', async () => {
    responder = renewalRoute()

    const result = await renew()

    expect(result.ok).toBe(true)
    // Two hops and no third: `redirect: 'manual'` is what keeps a `302` from being followed on the
    // client's own initiative, which is the mistake that throws a session's headers away.
    expect(calls).toHaveLength(2)

    const first = calls[0]
    const url = new URL(first?.url ?? '')
    expect(`${url.origin}${url.pathname}`).toBe(SAFE_AUTH_URL)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '1',
      redirect_url: 'https://www.douyu.com/',
      did: DID,
      // Milliseconds, like the page's own `(new Date).getTime()`: a cache-buster, not a clock.
      t: String(NOW),
      callback: '__jp0'
    })
    expect(first?.method).toBe('GET')
    expect(first?.headers['referer']).toBe('https://www.douyu.com/')

    // The header the capture shows, name for name. `acf_did` is the point of the assertion: the two
    // device cookies belong on this hop while nothing else called `acf_*` does — the family is
    // host-only for `www.douyu.com` and a browser would never send it to the passport host, so a
    // header assembled from "the whole jar" is the wrong header.
    const sent = cookieNamesIn(first?.headers['cookie'] ?? '')
    expect(sent).toEqual(['dy_did', 'acf_did', 'dy_accounts_main', 'LTP0'])
    expect(sent.filter(name => name.startsWith('acf_'))).toEqual(['acf_did'])
    for (const name of TOKEN_COOKIES) expect(sent).not.toContain(name)
    expect(first?.headers['cookie']).toContain(`dy_did=${DID}`)
    expect(first?.headers['cookie']).toContain(LTP0_COOKIE)

    // The second hop is the `Location` verbatim, made from the passport host, with the same jar.
    const second = calls[1]
    expect(second?.url).toBe(LANDING_LINK)
    expect(second?.headers['referer']).toBe('https://passport.douyu.com/')
    expect(second?.headers['cookie']).toBe(first?.headers['cookie'])
  })

  it('takes the device id from the blob rather than out of the jar', async () => {
    responder = renewalRoute()

    // The jar's own device cookies belong to a *different* login instance — the one the capture's
    // other probe belonged to — and the field is the authority here. A reader that took the value
    // out of the header would ask the service for a device this credential does not belong to,
    // which is the failure this case is here to pin.
    const otherDid = 'f71d67e4fe1f83a5310a3e6a00011701'
    const webCookies = `dy_did=${otherDid}; acf_did=${otherDid}; acf_devid=${otherDid}; ${LTP0_COOKIE}`

    const result = await renew({ webCookies })

    expect(result.ok).toBe(true)
    expect(new URL(calls[0]?.url ?? '').searchParams.get('did')).toBe(DID)

    const sent = calls[0]?.headers['cookie'] ?? ''
    expect(sent).toContain(`dy_did=${DID}`)
    expect(sent).toContain(`acf_did=${DID}`)
    expect(sent).not.toContain(otherDid)
    // `acf_devid` is the third device-cookie name this repo knows, and the capture did not send it
    // on this hop: a name invented onto a request is a name the next reader has to explain away.
    expect(sent).not.toContain('acf_devid')

    // And what comes back still names the field's device id, because that is the credential's.
    expect(credentialOf(result).did).toBe(DID)
  })

  it('reassembles the token out of the new family, in the token’s own order', async () => {
    responder = renewalRoute()

    const parsed = credentialOf(await renew())

    // `<uid>_<biz>_<stk>_<ct>_<ltkid>`, written out here rather than joined from the module's own
    // order, so that this assertion can disagree with the implementation instead of restating it.
    expect(parsed.token).toBe(`${UID}_2_ff778899aabbccdd_3_69117312`)
    // 39 characters, like the token that was stored: five components and four separators.
    expect(parsed.token).toHaveLength(39)
    expect(parsed.token).not.toBe(`${UID}_${BIZ}_${STK}_${CT}_${LTKID}`)
    // And the five fields, read back independently of that order.
    expect(parsed).toMatchObject({ uid: UID, biz: '2', stk: 'ff778899aabbccdd', ct: '3', ltkid: '69117312' })
    expect(parsed.did).toBe(DID)
  })

  it('keeps the session cookie, its stamp and the rest of the jar, and replaces only the family', async () => {
    responder = renewalRoute()

    const parsed = credentialOf(await renew())

    // `LTP0` is not rotated by this exchange: the response does not carry it, and its stamp comes
    // from the credential rather than from the jar — a stored header has no attributes to read.
    expect(parsed.webCookies).toContain(LTP0_COOKIE)
    expect(parsed.expiresAt).toBe(SESSION_STAMP)
    // The new family, and no trace of the one it replaced.
    expect(parsed.webCookies).toContain('acf_stk=ff778899aabbccdd')
    expect(parsed.webCookies).not.toContain(`acf_stk=${STK}`)
    // A cookie the exchange never heard of survives, because the new header is merged over the
    // stored one — which is what a browser has after the same exchange — rather than replacing it.
    expect(parsed.webCookies).toContain(`${KEPT_COOKIE}=${KEPT_VALUE}`)
    // The family's own declared life: what `refresh` schedules the next rebuild from.
    expect(parsed.tokenExpiresAt).toBe(NOW + FAMILY_LIFE_MS)
  })

  it('rebuilds nothing and sends nothing when the jar holds no session cookie', async () => {
    responder = renewalRoute()

    for (const webCookies of ['', `dy_did=${DID}; acf_did=${DID}`, `dy_did=${DID}; LTP0=`]) {
      const result = await renew({ webCookies })

      expect(result, webCookies).toMatchObject({ ok: false, kind: 'no_session' })
      expect(result.ok ? '' : result.reason, webCookies).toBe(NO_SESSION_TO_RENEW)
    }
    // Not one request: there is nothing to present, so nothing is presented.
    expect(calls).toEqual([])
  })

  it('hands the service’s own refusal back, and no credential with it', async () => {
    // The measured shape for a session the exchange will not accept: a `200` whose JSON says why
    // and no `Set-Cookie` at all.
    responder = () => json({ error: 16, msg: '未登录,请重新登录', data: {} })

    const result = await renew()
    const reason = result.ok ? '' : result.reason

    expect(result).toMatchObject({ ok: false, kind: 'no_family' })
    expect(reason).toContain('不是 302')
    // The service's own sentence, which is the one thing here a person can act on.
    expect(reason).toContain('未登录,请重新登录')
    expect(reason).not.toContain(LTP0_VALUE)
    expect(reason).not.toContain(DID)
    // One hop only: there is no `Location` to follow.
    expect(calls).toHaveLength(1)
  })

  it('reports a 302 with nothing to follow, and a Location that is not a URL', async () => {
    responder = (url: string): Response =>
      url.startsWith(SAFE_AUTH_URL) ? new Response(null, { status: 302 }) : json({ error: 0 })

    expect(await renew()).toMatchObject({
      ok: false,
      kind: 'no_family',
      reason: expect.stringContaining('没有带 Location')
    })

    responder = (url: string): Response =>
      url.startsWith(SAFE_AUTH_URL)
        ? new Response(null, { status: 302, headers: { location: 'not a url' } })
        : json({ error: 0 })

    expect(await renew()).toMatchObject({
      ok: false,
      kind: 'no_family',
      reason: expect.stringContaining('不是一个 URL')
    })
    expect(calls).toHaveLength(2)
    // Neither case followed anything: one request per case, both to the passport host.
    expect(calls.every(call => call.url.startsWith(SAFE_AUTH_URL))).toBe(true)
  })

  it('quotes the service’s own refusal out of the JSONP envelope the first hop answers with', async () => {
    // The captured shape, three times across two files: `__jp0({"error":16,"msg":"未登录,请重新登录"})`,
    // and `__jp1(…)` on the next attempt — wrapped, because the request itself asks for
    // `callback=__jp0`. The clause exists so a person can see *why*, and parsing the wrapper as JSON
    // meant it never appeared once: every refusal fell back to "第一跳返回 HTTP 200，不是 302" with no
    // reason attached to it.
    responder = (url: string): Response =>
      url.startsWith(SAFE_AUTH_URL)
        ? new Response('__jp0({"error":16,"msg":"未登录,请重新登录"})', { status: 200 })
        : json({ error: 0 })

    const quoted = await renew()
    expect(quoted).toMatchObject({ ok: false, kind: 'no_family' })
    expect(quoted.ok ? '' : quoted.reason).toContain('（未登录,请重新登录）')

    // …and the bare envelope is still read, which is the shape every other endpoint in this module
    // answers with: the helper accepts both, because the wrapper's own name is not this module's to fix.
    responder = (url: string): Response =>
      url.startsWith(SAFE_AUTH_URL)
        ? new Response('{"error":16,"msg":"未登录,请重新登录"}', { status: 200 })
        : json({ error: 0 })

    const bare = await renew()
    expect(bare.ok ? '' : bare.reason).toContain('（未登录,请重新登录）')
  })

  it('refuses a Location off Douyu’s own hosts rather than carrying the key to it', async () => {
    responder = renewalRoute({ location: `https://example.com/api/passport/login?code=${NEW_CODE}` })

    const result = await renew()

    expect(result).toMatchObject({ ok: false, kind: 'no_family' })
    expect(result.ok ? '' : result.reason).toContain('不在斗鱼域名下')
    // The whole reason the host is checked first: the second hop never happened, so `LTP0` and the
    // device id went nowhere.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url.startsWith(SAFE_AUTH_URL)).toBe(true)
  })

  it('hands nothing back when the second hop lands no family, or only four fifths of one', async () => {
    responder = renewalRoute({ landingCookies: [] })
    expect(await renew()).toMatchObject({
      ok: false,
      kind: 'no_family',
      reason: expect.stringContaining('没有下发完整的 acf_* 家族')
    })

    // A missing `acf_stk` is the case that would surface on the socket as `401000206`, which reads
    // exactly like a wrong key — so a partial family is refused rather than written, and the
    // sentence names the component, because a name is not a secret and it is what makes the report
    // actionable.
    responder = renewalRoute({
      landingCookies: rebuiltFamily().filter(entry => !entry.startsWith('acf_stk='))
    })
    expect(await renew()).toMatchObject({
      ok: false,
      kind: 'no_family',
      reason: expect.stringContaining('缺 acf_stk')
    })
  })

  it('refuses a family that belongs to another account, without naming the uid it named', async () => {
    responder = renewalRoute({ family: { ...NEW_FAMILY, acf_uid: '899023859' } })

    const result = await renew()
    const reason = result.ok ? '' : result.reason

    expect(result).toMatchObject({ ok: false, kind: 'no_family' })
    expect(reason).toContain('不一致')
    expect(reason).not.toContain('899023859')
    expect(reason).not.toContain(UID)
  })

  it('keeps the one-time code out of a sentence a transport failure could have carried it in', async () => {
    // A runtime that echoes the URL in its own message is the case this scrubbing exists for, and
    // the second hop's URL holds the `code` — a credential for exactly one exchange.
    responder = (url: string): Response => {
      if (url.startsWith(SAFE_AUTH_URL)) {
        return new Response(null, { status: 302, headers: { location: LANDING_LINK } })
      }
      throw new Error(`boom: ${LANDING_LINK}`)
    }

    const result = await renew()
    const reason = result.ok ? '' : result.reason

    expect(result).toMatchObject({ ok: false, kind: 'no_family' })
    expect(reason).toContain('第二跳没有到达')
    expect(reason).not.toContain(NEW_CODE)
    expect(reason).not.toContain('api/passport/login')
    expect(reason).toContain('<redacted>')
  })

  it('records the measured life when the response declares none of its own', async () => {
    responder = renewalRoute({ declaresLife: false })

    const parsed = credentialOf(await renew())

    // A family nobody declared a life for is one nothing can schedule, so it takes the measured
    // 6.125 days from the moment it landed — the alternative is an exchange on every check.
    expect(parsed.tokenExpiresAt).toBe(NOW + FAMILY_LIFE_MS)
  })
})

/* ------------------------------------------------------------------ *
 * storePastedCredential
 * ------------------------------------------------------------------ */

describe('storePastedCredential', () => {
  it('writes the same blob shape the scan writes, clock excepted', () => {
    const pasted = `acf_username=${UID}; acf_nickname=${encodeURIComponent(NICKNAME)}; acf_avatar=${encodeURIComponent(AVATAR_STEM)}`
    const outcome = storePastedCredential(db, 1, {
      token: `${UID}_${BIZ}_${STK}_${CT}_${LTKID}`,
      did: DID,
      webCookies: pasted
    })

    expect(outcome.ok).toBe(true)
    const parsed = parseCredential(String(rows()[0]?.['credentials']))
    expect(parsed).toMatchObject({
      uid: UID,
      stk: STK,
      ct: CT,
      ltkid: LTKID,
      did: DID,
      // Neither clock: a `Cookie:` header states no attributes, so there is nothing to read one
      // from. What that costs is one exchange — the first `refresh` rebuilds and records one.
      expiresAt: null,
      tokenExpiresAt: null
    })
    expect(parsed?.webCookies).toBe(pasted)
    // The paste path reads the same two cookies by the same two rules as the scan path.
    expect(rows()[0]?.['display_name']).toBe(NICKNAME)
    expect(rows()[0]?.['avatar']).toBe(AVATAR_URL)
  })

  /**
   * The paste path's session question, which the row records and one adapter member now answers.
   *
   * A `Cookie:` header states no attributes, so a paste can never carry an expiry — which is why no
   * stamp of it may be turned into a verdict. The jar is a different matter, and a narrower one:
   * `refresh` reads the long login out of it for exactly one purpose, which is to rebuild the token
   * family, so a paste carrying `LTP0` can be renewed with no person involved while one carrying
   * none cannot be renewed by anything on this side. What the two states differ in for every action
   * is unchanged, and it is 粉丝家园签到 that says so in its own terms when the session is missing.
   */
  it('records whether the pasted header carried the long-lived session cookie', () => {
    const now = 1_700_000_000_000
    const outcome = storePastedCredential(
      db,
      1,
      { token: `${UID}_${BIZ}_${STK}_${CT}_${LTKID}`, did: DID, webCookies: `dy_did=${DID}; ${LTP0_COOKIE}` },
      now
    )

    expect(outcome.ok).toBe(true)
    expect(JSON.parse(String(rows()[0]?.['meta']))).toEqual({
      boundVia: 'paste',
      boundAt: now,
      sessionCookie: 'LTP0'
    })
  })

  it('binds a paste with no jar at all, leaving the session out of meta rather than guessing', () => {
    const now = 1_700_000_000_000
    const outcome = storePastedCredential(db, 1, { token: `${UID}_${BIZ}_${STK}_${CT}_${LTKID}`, did: DID }, now)

    // Stored, not refused: the token is what drives the socket and it works on its own.
    // What is missing is the long login, which is a fact about the *web* family rather than a
    // verdict on the token: the one action that needs a session (粉丝家园签到) reports its absence
    // as its own `blocked`, and `refresh` says the session cannot be renewed — which is a statement
    // about renewability and not about the token, so this row keeps working either way.
    expect(outcome.ok).toBe(true)
    const parsed = parseCredential(String(rows()[0]?.['credentials']))
    expect(parsed?.expiresAt).toBeNull()
    expect(parsed?.tokenExpiresAt).toBeNull()
    expect(JSON.parse(String(rows()[0]?.['meta']))).toEqual({ boundVia: 'paste', boundAt: now })
  })

  it('refuses a token that is not five components, and says which shape is wanted', () => {
    // Three fields, and note that a *dropped* field cannot be caught this way when
    // `stk` carries an underscore of its own: the both-ends split reassigns the
    // middle, so the count is all this check can be. See the report's residual risk.
    const outcome = storePastedCredential(db, 1, { token: `${UID}_${BIZ}_stk`, did: DID })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? '' : outcome.error).toContain('五个分量')
    expect(outcome.ok ? '' : outcome.error).not.toContain(UID)
    expect(rows()).toEqual([])
  })

  it('re-binds in place rather than creating a second row', () => {
    const input = { token: `${UID}_${BIZ}_${STK}_${CT}_${LTKID}`, did: DID }
    const first = storePastedCredential(db, 1, input)
    const second = storePastedCredential(db, 1, input)

    expect(first.ok && second.ok && first.account.id === second.account.id).toBe(true)
    expect(rows()).toHaveLength(1)
  })

  /**
   * The repair a person already bound does not have to perform by hand.
   *
   * A row written before this fix carries the uid in `display_name` and nothing in
   * `avatar`, because this Platform's binder read the wrong cookie for the first and
   * wrote nothing at all for the second. The generic upsert overwrites both columns from
   * the excluded row, so the next bind replaces them — no delete-and-recreate, and the
   * account id every task points at stays the same.
   */
  it('repairs a row written by the older binder on the next bind', () => {
    const token = `${UID}_${BIZ}_${STK}_${CT}_${LTKID}`
    storePastedCredential(db, 1, { token, did: DID })
    expect(rows()[0]?.['display_name']).toBe('')
    expect(rows()[0]?.['avatar']).toBe('')

    // The old shape, as the earlier build left it.
    db.prepare('UPDATE accounts SET display_name = ?, avatar = ?').run(UID, '')

    const repaired = storePastedCredential(db, 1, {
      token,
      did: DID,
      webCookies: `acf_nickname=${encodeURIComponent(NICKNAME)}; acf_avatar=${encodeURIComponent(AVATAR_STEM)}`
    })

    expect(repaired.ok).toBe(true)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.['display_name']).toBe(NICKNAME)
    expect(rows()[0]?.['avatar']).toBe(AVATAR_URL)
  })
})

/* ------------------------------------------------------------------ *
 * The deadline
 * ------------------------------------------------------------------ */

describe('qrLifetimeMs', () => {
  it('uses the response\u2019s own expire, in milliseconds', () => {
    expect(qrLifetimeMs(300)).toBe(300_000)
  })

  it.each([[undefined], [0], [-5], [Number.NaN]])('falls back to the measured default for %s', expire => {
    expect(qrLifetimeMs(expire)).toBe(QR_TTL_MS)
  })
})

describe('DouyuBindSessionStore', () => {
  it('hands a session back to its owner and forgets it once asked to', () => {
    const store = new DouyuBindSessionStore()
    const http = new PassportHttp()
    store.create(SCAN_CODE, 7, http, 300_000, 1_000)

    expect(store.get(SCAN_CODE, 2_000)).toMatchObject({ userId: 7, expiresAt: 301_000 })

    store.remove(SCAN_CODE)
    expect(store.get(SCAN_CODE, 2_000)).toBeNull()
  })

  it('expires a session at its deadline instead of polling a code forever', () => {
    const store = new DouyuBindSessionStore()
    store.create(SCAN_CODE, 7, new PassportHttp(), 300_000, 1_000)

    expect(store.get(SCAN_CODE, 300_999)).not.toBeNull()
    expect(store.get(SCAN_CODE, 301_001)).toBeNull()
    // Removed, not merely hidden: a second read at any time stays null.
    expect(store.get(SCAN_CODE, 2_000)).toBeNull()
  })
})

describe('waitForScan', () => {
  it('polls at the measured cadence and stops when the code is confirmed', async () => {
    responder = () => json({ error: SCAN_CONFIRMING })
    const states: string[] = []
    const http = new PassportHttp()

    // Real time on purpose, here only: `vi.useFakeTimers()` patches the *global* timers, and the
    // loop waits on `node:timers/promises`'s own `setTimeout`, which no fake clock reaches — so
    // the cadence asserted here is the one the product really runs at. The deadline case below
    // asserts a *count* instead, and a count measured against a starved real clock describes the
    // machine's load rather than the deadline: it stubs the timer instead of waiting anything out.
    const polling = waitForScan(http, SCAN_CODE, {
      intervalMs: QR_POLL_INTERVAL_MS,
      timeoutMs: QR_TTL_MS,
      onState: state => states.push(state)
    })

    // The first poll is immediate; the answer flips while the loop is waiting out its
    // interval, so it is the second poll that sees it.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    responder = () => json({ error: SCAN_DONE, data: { url: LANDING } })
    await expect(polling).resolves.toMatchObject({ error: SCAN_DONE })
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)

    // `onState` fires on change: `scanned` once, then `success`.
    expect(states).toEqual(['scanned', 'success'])
  })

  it('gives up at the deadline rather than polling forever', async () => {
    responder = () => json({ error: SCAN_CONFIRMING })

    // Eight intervals fit inside this deadline and the ninth wait would be asked for exactly *at*
    // it, so the loop polls eight times and stops. The count is asserted because it is what says the
    // deadline was honoured rather than merely approached — but it only says that against a clock
    // this case owns: on the real clock the 5 ms waits stretch under parallel load, the rounds
    // starve, and this assertion has been measured at two polls where the arithmetic allows eight.
    //
    // A loop that stopped giving up does not fail the count — it never reaches it. It fails the stub,
    // which refuses to hand out a wait once the clock is at the deadline, so the regression this case
    // exists to catch is reported instead of waited out.
    const intervalMs = 5
    const timeoutMs = 40
    vi.setSystemTime(NOW)
    sleepOverride.fn = async (ms: number) => {
      if (Date.now() >= NOW + timeoutMs) throw new Error('the loop asked to wait past its own deadline')
      vi.setSystemTime(Date.now() + ms)
    }

    const polling = waitForScan(new PassportHttp(), SCAN_CODE, { intervalMs, timeoutMs })
    await expect(polling).resolves.toMatchObject({ error: SCAN_CONFIRMING })
    // One poll per interval inside the deadline: 40 / 5.
    expect(fetchMock.mock.calls.length).toBe(8)
  })

  it('honours cancellation', async () => {
    responder = () => json({ error: SCAN_CONFIRMING })
    const controller = new AbortController()
    controller.abort()

    // Cancelled before the first poll, so this path waits on no timer at all.
    await expect(
      waitForScan(new PassportHttp(), SCAN_CODE, { intervalMs: 1_000, timeoutMs: 3_000, signal: controller.signal })
    ).rejects.toThrow('login cancelled')
  })
})

/* ------------------------------------------------------------------ *
 * The routes
 * ------------------------------------------------------------------ */

describe('the Douyu bind routes', () => {
  let server: BuiltServer

  beforeEach(() => {
    // The outer `beforeEach` opened a database for the unit cases; the server owns
    // the one the route cases read through, so the handle used by `rows()` moves.
    closeDatabase()
    server = buildServer({ logger: false, dbPath: ':memory:' })
    db = server.ctx.db
    responder = webRoute()
  })

  afterEach(async () => {
    await server.app.close()
    closeDatabase()
  })

  async function signUp(username: string): Promise<string> {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'password123' }
    })
    const body = response.json<{ token: string }>()
    return body.token
  }

  function auth(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` }
  }

  it('refuses the handshake without a session', async () => {
    const response = await server.app.inject({ method: 'POST', url: '/api/douyu/accounts/qrcode' })

    expect(response.statusCode).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('starts a bind with the QR content and the key, and polls it to an account', async () => {
    const token = await signUp('scanner')

    const started = await server.app.inject({
      method: 'POST',
      url: '/api/douyu/accounts/qrcode',
      headers: auth(token)
    })
    expect(started.statusCode).toBe(200)
    const start = started.json<{ ok: boolean; url: string; key: string }>()
    expect(start).toMatchObject({ ok: true, url: QR_CONTENT, key: SCAN_CODE })

    const polling = `${'/api/douyu/accounts/qrcode'}/${encodeURIComponent(start.key)}`

    // Not scanned yet: the poll reports a state and changes nothing.
    responder = () => json({ error: 2 })
    const pending = await server.app.inject({ method: 'GET', url: polling, headers: auth(token) })
    expect(pending.json<{ state: string }>().state).toBe('pending')

    // Scanned, awaiting the phone's confirmation.
    responder = () => json({ error: SCAN_CONFIRMING })
    const scanned = await server.app.inject({ method: 'GET', url: polling, headers: auth(token) })
    expect(scanned.json<{ state: string }>().state).toBe('scanned')

    // Confirmed: the account is written and returned.
    responder = webRoute()
    const done = await server.app.inject({ method: 'GET', url: polling, headers: auth(token) })
    const body = done.json<{ state: string; account: { platform: string; externalId: string; displayName: string } }>()
    expect(done.statusCode).toBe(200)
    expect(body.state).toBe('success')
    expect(body.account).toMatchObject({ platform: 'douyu', externalId: UID, displayName: NICKNAME })

    // The code is single-use: the session is gone, so a second poll 404s.
    const again = await server.app.inject({ method: 'GET', url: polling, headers: auth(token) })
    expect(again.statusCode).toBe(404)

    // And it is a bound account the platform-neutral list can see.
    const accounts = await server.app.inject({ method: 'GET', url: '/api/accounts', headers: auth(token) })
    expect(accounts.json<{ accounts: { platform: string }[] }>().accounts).toHaveLength(1)
  })

  it('never puts a credential in the bind response', async () => {
    const token = await signUp('quiet')
    const started = await server.app.inject({
      method: 'POST',
      url: '/api/douyu/accounts/qrcode',
      headers: auth(token)
    })
    const key = started.json<{ key: string }>().key

    const done = await server.app.inject({
      method: 'GET',
      url: `/api/douyu/accounts/qrcode/${encodeURIComponent(key)}`,
      headers: auth(token)
    })

    const body = done.body
    expect(body).not.toContain(`${UID}_${BIZ}_${STK}_${CT}_${LTKID}`)
    expect(body).not.toContain(DID)
    expect(body).not.toContain('acf_stk')
  })

  it('reports a service refusal as a 502 with the service\u2019s own words', async () => {
    const token = await signUp('refused')
    responder = () => json({ error: 1, data: '系统异常，请重试' })

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/douyu/accounts/qrcode',
      headers: auth(token)
    })

    expect(response.statusCode).toBe(502)
    expect(response.json<{ error: string }>().error).toBe('系统异常，请重试')
  })

  it('does not let one user poll another user\u2019s code', async () => {
    const mine = await signUp('mine')
    const nosy = await signUp('nosy')

    const started = await server.app.inject({
      method: 'POST',
      url: '/api/douyu/accounts/qrcode',
      headers: auth(mine)
    })
    const key = started.json<{ key: string }>().key

    const response = await server.app.inject({
      method: 'GET',
      url: `/api/douyu/accounts/qrcode/${encodeURIComponent(key)}`,
      headers: auth(nosy)
    })

    expect(response.statusCode).toBe(404)
  })

  it('binds a pasted credential at the path the accounts view already posts to', async () => {
    const token = await signUp('paster')

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/douyu/accounts',
      headers: auth(token),
      payload: { token: `${UID}_${BIZ}_${STK}_${CT}_${LTKID}`, did: DID }
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ ok: boolean; account: { externalId: string } }>()
    expect(body).toMatchObject({ ok: true, account: { externalId: UID } })
    expect(parseCredential(String(rows()[0]?.['credentials']))?.did).toBe(DID)
  })

  it('rejects a pasted credential it cannot parse, without echoing it', async () => {
    const token = await signUp('typo')

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/douyu/accounts',
      headers: auth(token),
      payload: { token: 'not-a-token', did: DID }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toContain('五个分量')
    expect(response.body).not.toContain('not-a-token')
  })

  it('rejects a paste with no device id at the schema, before anything is stored', async () => {
    const token = await signUp('noddid')

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/douyu/accounts',
      headers: auth(token),
      payload: { token: `${UID}_${BIZ}_${STK}_${CT}_${LTKID}` }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('请填写设备号（did）')
    expect(rows()).toEqual([])
  })

  it('keeps the bind routes off the unauthenticated surface', async () => {
    const paste = await server.app.inject({
      method: 'POST',
      url: '/api/douyu/accounts',
      payload: { token: 'x', did: 'y' }
    })
    const poll = await server.app.inject({ method: 'GET', url: `/api/douyu/accounts/qrcode/${SCAN_CODE}` })

    expect(paste.statusCode).toBe(401)
    expect(poll.statusCode).toBe(401)
    expect(rows()).toEqual([])
  })
})
