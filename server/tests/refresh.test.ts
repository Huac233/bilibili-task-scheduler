import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BiliHttp, CookieJar } from '../src/bilibili/http.js'
import { refreshIfRequired } from '../src/bilibili/refresh.js'

/**
 * Renewal tests.
 *
 * The behaviour worth protecting is not the happy path but what happens to the
 * **refresh token**. Bilibili rotates it: the response's `data.refresh_token` is the
 * successor, and the token that was just spent is dead from that moment on. Keeping
 * the old one silently caps how many times a session can be extended and leaves a
 * dead value in storage — a mistake that only shows up at the *second* renewal, which
 * is why it is worth a test rather than a comment.
 */

const CSRF = 'csrf-value'
const OLD_TOKEN = 'old-refresh-token'
const OLD_SESSDATA = 'old-sess'

interface CapturedRequest {
  url: string
  method: string
}

let calls: CapturedRequest[] = []

/**
 * Answers `/cookie/info` and `/cookie/refresh`, and nothing else.
 *
 * Throwing on an unexpected URL is deliberate: the throttle is part of the contract
 * (`/cookie/refresh` must not be called when the server says nothing is due), so a
 * stray request should fail the test rather than pass unnoticed.
 */
function installFetchMock(options: { info: unknown; refresh?: unknown; setCookie?: string }): void {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, method: init?.method ?? 'GET' })

    if (url.includes('/cookie/info')) {
      return new Response(JSON.stringify(options.info), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    if (url.includes('/cookie/refresh')) {
      const headers = new Headers({ 'content-type': 'application/json' })
      if (options.setCookie !== undefined) headers.append('set-cookie', options.setCookie)
      return new Response(JSON.stringify(options.refresh), { status: 200, headers })
    }

    throw new Error(`unexpected request: ${url}`)
  })

  vi.stubGlobal('fetch', fetchMock)
}

function loggedInClient(): BiliHttp {
  return new BiliHttp({
    cookies: new CookieJar({ SESSDATA: OLD_SESSDATA, bili_jct: CSRF, DedeUserID: '100' })
  })
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('refreshIfRequired', () => {
  it('asks the server before exchanging anything', async () => {
    installFetchMock({ info: { code: 0, data: { refresh: false } } })

    const outcome = await refreshIfRequired(loggedInClient(), CSRF, OLD_TOKEN)

    expect(outcome).toEqual({ status: 'not_required' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/cookie/info')
  })

  it('keeps the rotated token the response hands back', async () => {
    installFetchMock({
      info: { code: 0, data: { refresh: true } },
      refresh: { code: 0, data: { refresh_token: 'new-refresh-token' } },
      setCookie: 'SESSDATA=new-sess; Path=/; Domain=.bilibili.com'
    })

    const outcome = await refreshIfRequired(loggedInClient(), CSRF, OLD_TOKEN)

    expect(outcome.status).toBe('refreshed')
    if (outcome.status === 'refreshed') {
      expect(outcome.credential.acTimeValue).toBe('new-refresh-token')
      // The response's cookies were absorbed, so the credential is the new session.
      expect(outcome.credential.sessdata).toBe('new-sess')
    }
  })

  it('keeps the previous token when the response does not rotate it', async () => {
    installFetchMock({
      info: { code: 0, data: { refresh: true } },
      refresh: { code: 0, data: {} },
      setCookie: 'SESSDATA=new-sess; Path=/'
    })

    const outcome = await refreshIfRequired(loggedInClient(), CSRF, OLD_TOKEN)

    expect(outcome.status).toBe('refreshed')
    if (outcome.status === 'refreshed') {
      expect(outcome.credential.acTimeValue).toBe(OLD_TOKEN)
    }
  })

  it('treats an empty successor as "no rotation" rather than erasing the token', async () => {
    installFetchMock({
      info: { code: 0, data: { refresh: true } },
      refresh: { code: 0, data: { refresh_token: '' } },
      setCookie: 'SESSDATA=new-sess; Path=/'
    })

    const outcome = await refreshIfRequired(loggedInClient(), CSRF, OLD_TOKEN)

    expect(outcome.status).toBe('refreshed')
    if (outcome.status === 'refreshed') {
      expect(outcome.credential.acTimeValue).toBe(OLD_TOKEN)
    }
  })

  it('survives a success envelope with no data block', async () => {
    installFetchMock({
      info: { code: 0, data: { refresh: true } },
      refresh: { code: 0 },
      setCookie: 'SESSDATA=new-sess; Path=/'
    })

    const outcome = await refreshIfRequired(loggedInClient(), CSRF, OLD_TOKEN)

    expect(outcome.status).toBe('refreshed')
    if (outcome.status === 'refreshed') {
      expect(outcome.credential.acTimeValue).toBe(OLD_TOKEN)
    }
  })

  it('reports a rejected exchange as needing a new scan', async () => {
    installFetchMock({
      info: { code: 0, data: { refresh: true } },
      refresh: { code: -101, message: '账号未登录' }
    })

    const outcome = await refreshIfRequired(loggedInClient(), CSRF, OLD_TOKEN)

    expect(outcome).toEqual({ status: 'relogin_required', reason: '账号未登录' })
  })

  it('does not blank the token when the exchange fails for another reason', async () => {
    installFetchMock({
      info: { code: 0, data: { refresh: true } },
      refresh: { code: -509, message: '请求过于频繁' }
    })

    const outcome = await refreshIfRequired(loggedInClient(), CSRF, OLD_TOKEN)

    expect(outcome).toEqual({ status: 'failed', reason: '请求过于频繁' })
  })

  it('takes the credentials out of a refusal the server echoed back', async () => {
    // The renewal exchange carries the CSRF token in the query string and again in the
    // body beside the refresh token, so a server that quotes the request hands all
    // three back. The reason this module returns is rendered in the UI and written to a
    // row, so the transport's own redaction runs first and the refresh token — which is
    // in no cookie jar — is removed here.
    installFetchMock({
      info: { code: 0, data: { refresh: true } },
      refresh: { code: -509, message: `请求过于频繁：csrf=${CSRF}&refresh_token=${OLD_TOKEN}` }
    })

    const outcome = await refreshIfRequired(loggedInClient(), CSRF, OLD_TOKEN)

    if (outcome.status !== 'failed') throw new Error(`expected a failure, got ${outcome.status}`)
    expect(outcome.reason).not.toContain(CSRF)
    expect(outcome.reason).not.toContain(OLD_TOKEN)
    expect(outcome.reason).toContain('<redacted>')
    // The part a person acts on survives.
    expect(outcome.reason).toContain('请求过于频繁')
  })

  it('takes the credentials out of a transport failure whose text names the URL and the headers', async () => {
    // Deliberately not asserting about the refresh token here: it is only ever a form
    // field, so no transport failure can carry it, and an assertion that cannot fail is
    // worse than no assertion. The two values below are the ones this path can leak —
    // the URL it was asked for and the `Cookie:` header it was asked to send, both of
    // which a misconfigured proxy or an instrumented runtime will happily quote.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const cookie = new Headers(init?.headers).get('cookie') ?? ''
        throw new Error(`request to ${String(input)} failed, Cookie: ${cookie}`)
      })
    )

    const outcome = await refreshIfRequired(loggedInClient(), CSRF, OLD_TOKEN)

    if (outcome.status !== 'failed') throw new Error(`expected a failure, got ${outcome.status}`)
    expect(outcome.reason).not.toContain(CSRF)
    expect(outcome.reason).not.toContain(OLD_SESSDATA)
    expect(outcome.reason).toContain('request failed')
    expect(outcome.reason).toContain('<redacted>')
  })
})
