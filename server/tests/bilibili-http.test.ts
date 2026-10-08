import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { BiliHttp, BiliHttpError, CookieJar } from '../src/bilibili/http.js'

/**
 * The cookie-aware transport, at its own seam.
 *
 * `fetch` is stubbed because both cases below are about the transport's own decisions
 * — *which* signal it hands the request, and what an abort turns into — and neither is
 * visible from above the seam: a caller sees one rejection either way.
 *
 * Real timers: the deadline under test is `AbortSignal.timeout`, which no fake clock
 * reaches.
 */

const fetchMock = vi.fn()

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/**
 * A server that accepts and never answers.
 *
 * The request only settles when its signal aborts, which is what makes "whose abort
 * was it" observable.
 */
function hangsUntilAborted(): void {
  fetchMock.mockImplementation(
    async (_url: unknown, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason)
        })
      })
  )
  vi.stubGlobal('fetch', fetchMock)
}

it('lets the caller abort a request the deadline would not have ended yet', async () => {
  hangsUntilAborted()
  const http = new BiliHttp({ timeoutMs: 60_000 })
  const caller = new AbortController()

  const pending = http.request('https://api.bilibili.com/x/web-interface/nav', { signal: caller.signal })
  // The caller's own reason travels with it, so the message a person reads says who
  // gave up rather than only that something was aborted.
  caller.abort(new Error('the scan window closed'))

  await expect(pending).rejects.toThrow(BiliHttpError)
  await expect(pending).rejects.toThrow('request failed: the scan window closed')
})

it('ends a request the server never answers, and says it was the deadline', async () => {
  hangsUntilAborted()
  const http = new BiliHttp({ timeoutMs: 20 })

  // `TimeoutError`, not the old hand-rolled controller's bare `AbortError`: the text
  // a person reads has to distinguish a slow endpoint from a cancelled one.
  await expect(http.request('https://api.bilibili.com/x/web-interface/nav')).rejects.toThrow(/timeout/i)
})

/*
 * Redaction at the transport's own seam.
 *
 * Every failure below is built out of a response that *echoes the request back*, which
 * is the one thing that can put a credential into a sentence: the URL carries `?csrf=`
 * on the renewal check and `?qrcode_key=` on the login poll, the `Cookie:` header
 * carries the session, and a body the transport quotes is a body that can quote the
 * request. Each case is asserted against the value, not against the marker, so a
 * regression cannot pass by redacting something else.
 */

const SESSDATA = 'sess-value-that-must-not-leak'
const CSRF = 'jct-value-that-must-not-leak'
const BUVID3 = 'buvid3-value-that-must-not-leak'
const COOKIE_INFO_URL = 'https://passport.bilibili.com/x/passport-login/web/cookie/info'

function loggedIn(): BiliHttp {
  return new BiliHttp({
    cookies: new CookieJar({ SESSDATA, bili_jct: CSRF, buvid3: BUVID3, DedeUserID: '100' })
  })
}

/** Answers everything with one response. */
function answers(status: number, body: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status }))
  )
}

/** The transport error a call rejects with, so the test can read its fields. */
async function rejectionOf(promise: Promise<unknown>): Promise<BiliHttpError> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof BiliHttpError) return error
    throw error
  }
  throw new Error('the call should have failed')
}

it('redacts the credentials a gateway echoed back beside its own status', async () => {
  answers(502, `bad gateway: retried GET ${COOKIE_INFO_URL}?csrf=${CSRF} with Cookie: SESSDATA=${SESSDATA}`)

  const error = await rejectionOf(loggedIn().request(`${COOKIE_INFO_URL}?csrf=${CSRF}`))

  expect(error.message).not.toContain(CSRF)
  expect(error.message).not.toContain(SESSDATA)
  // The marker is the point: the sentence still says where the hole is.
  expect(error.message).toContain('<redacted>')
})

it('stores the URL already redacted, because that is the field this class exists to log', async () => {
  answers(404, 'not found')

  const error = await rejectionOf(loggedIn().request(`${COOKIE_INFO_URL}?csrf=${CSRF}`))

  expect(error.url).toBe(`${COOKIE_INFO_URL}?csrf=<redacted>`)
  expect(error.url).not.toContain(CSRF)
})

it('does not quote back the body a JSON parse failure would have quoted', async () => {
  // V8's own parse text quotes the first characters of the body it rejected — and a
  // *prefix* of a credential is still a credential, so no redaction rule could have
  // caught it: a rule can only match a value it sees whole. The only fix is to stop
  // forwarding that sentence.
  answers(200, `${CSRF} trailing`)

  const error = await rejectionOf(loggedIn().requestJson(COOKIE_INFO_URL, z.object({ code: z.number() })))

  expect(error.message).toContain('response was not JSON')
  expect(error.message).not.toContain(CSRF)
  expect(error.message).not.toContain(CSRF.slice(0, 10))
  // The length is the diagnostic that survives, and it is what tells an HTML error page
  // apart from a JSON shape that changed.
  expect(error.message).toContain(`${CSRF.length + ' trailing'.length} characters`)
})

it('redacts the runtime text a transport failure carries', async () => {
  vi.stubGlobal(
    'fetch',
    // Node's own fetch failure text can name the URL it failed on.
    vi.fn(async (input: unknown) => {
      throw new Error(`request to ${String(input)} failed, reason: connect ECONNREFUSED`)
    })
  )

  const error = await rejectionOf(loggedIn().request(`${COOKIE_INFO_URL}?csrf=${CSRF}`))

  expect(error.message).not.toContain(CSRF)
  expect(error.url).not.toContain(CSRF)
})

it('does not use the numeric account id for redaction', async () => {
  // `DedeUserID` is a public id and its value is short: redacting it would shred every
  // sentence that happened to contain the same digits. The session and the CSRF token
  // are the credentials; the id rides along in the jar without being one.
  answers(400, 'room 100 refused at 2026-10-08 12:00:00')

  const error = await rejectionOf(loggedIn().request(COOKIE_INFO_URL))

  expect(error.message).toContain('room 100 refused at 2026-10-08 12:00:00')
})

it('skips a one-character cookie value, which would otherwise silence the parameter rule too', async () => {
  // The boundary `redactSecrets`'s contract states and this caller cannot rely on: a value one
  // character long does not remove a secret, it `replaceAll`s that character into the marker
  // between every occurrence — and the jar's values come out of `Set-Cookie`, which a broken or
  // hostile response writes. `buvid3` is the shape under test here, and the character chosen is
  // `q` deliberately: it is both ordinary prose in the echoed body and the first character of a
  // credential parameter's **name**. Shredding the body puts the marker inside `qrcode_key`, the
  // `\b(name)=` shape stops matching, and the one rule that knows a value no value list holds
  // (`qrcode_key`, the one-time `ticket`) is disabled by the value rule running first.
  const QKEY = 'qr-key-that-must-not-leak'
  const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
  const http = new BiliHttp({ cookies: new CookieJar({ SESSDATA, bili_jct: CSRF, buvid3: 'q' }) })

  answers(502, `bad gateway: GET ${POLL_URL}?qrcode_key=${QKEY} refused (status 0, code 0)`)

  const error = await rejectionOf(http.request(`${POLL_URL}?qrcode_key=${QKEY}`))

  // The sentence survives character for character, the single `q` included.
  expect(error.message).toContain(
    'HTTP 502: bad gateway: GET https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=<redacted> refused (status 0, code 0)'
  )
  // …and with it the parameter rule, whose hole is still visible where the value was.
  expect(error.message).not.toContain(QKEY)
  expect(error.url).toBe(`${POLL_URL}?qrcode_key=<redacted>`)
})
