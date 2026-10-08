import { describe, expect, vi } from 'vitest'

import { QR_POLL_PENDING, QR_POLL_SCANNED } from '../src/bilibili/types.js'
import { GENERATE_CODE_URL, LOGIN_PAGE_URL, SCAN_CONFIRMING, SCAN_POLL_URL } from '../src/platform/douyu/passport.js'
import { test as base } from './fixtures.js'

/**
 * One bind poll at a time, per key.
 *
 * The client polls a bind attempt on a fixed two-second timer with no in-flight marker
 * (`AccountsView.vue`), so any poll slower than that interval overlaps the next — and the poll
 * that reports success is the slow one, because it makes two further calls. Two polls of one code
 * are therefore ordinary rather than exotic, and both of them reach the service: the second one
 * re-asks, the two answers race to write the dialog's state, and the code is driven twice.
 *
 * **This asserts at the route, not at the guard.** `PollSingleFlight` being correct says nothing
 * about whether a route uses it; what is pinned here is the observable promise — a request that
 * arrives while a poll is out is answered **without a second Platform call**.
 */

const QR_KEY = 'a-key-polled-twice'
const GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const POLL = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${QR_KEY}`

function envelope(data: unknown): Response {
  return json({ code: 0, message: 'ok', data })
}

/** A JSON response, for the stub's answers and for the envelopes built on top of it. */
function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof Request) return input.url
  if (input instanceof URL) return input.toString()
  return ''
}

describe('a bind poll that is already in flight', () => {
  base('answers the second request without asking the Platform again', async ({ server, session }) => {
    let polls = 0
    let releaseFirstPoll = (): void => {}
    const held = new Promise<void>(resolve => {
      releaseFirstPoll = resolve
    })

    vi.stubGlobal('fetch', async (input: unknown): Promise<Response> => {
      const url = urlOf(input)
      if (url.startsWith(GENERATE)) {
        return envelope({ url: 'https://passport.bilibili.com/qr', qrcode_key: QR_KEY })
      }
      if (url.startsWith(POLL)) {
        polls += 1
        // Only the first poll is held. A second one that reaches the service — which is exactly
        // what must not happen — answers straight away, so the mistake fails the test instead of
        // deadlocking it, and its state is a different one so the answer alone gives it away.
        if (polls === 1) await held
        return envelope({
          url: '',
          refresh_token: '',
          timestamp: 0,
          code: polls === 1 ? QR_POLL_PENDING : QR_POLL_SCANNED,
          message: ''
        })
      }
      throw new Error(`this test stubbed no answer for ${url}`)
    })

    try {
      const started = await server.app.inject({
        method: 'POST',
        url: '/api/bili/accounts/qrcode',
        headers: session.auth()
      })
      expect(started.statusCode).toBe(200)

      const first = server.app.inject({
        method: 'GET',
        url: `/api/bili/accounts/qrcode/${QR_KEY}`,
        headers: session.auth()
      })

      // Waiting for the service to be reached is what makes the next request overlap the first:
      // it cannot arrive "in flight" until the first one is out.
      await vi.waitFor(() => {
        expect(polls).toBe(1)
      })

      const second = await server.app.inject({
        method: 'GET',
        url: `/api/bili/accounts/qrcode/${QR_KEY}`,
        headers: session.auth()
      })
      // Answering with the state the first poll set out to resolve is what keeps the dialog
      // polling: an error status would end the flow over a collision it cannot avoid.
      expect(second.json()).toMatchObject({ ok: true, state: 'pending' })
      expect(polls).toBe(1)

      releaseFirstPoll()
      const firstResponse = await first
      expect(firstResponse.statusCode).toBe(200)
      expect(firstResponse.json()).toMatchObject({ ok: true, state: 'pending' })

      // **The claim must be released on *this* exit path, and this is the assertion that says so.** The
      // first poll answered a state that is not `success`, which returns out of the handler without
      // consuming anything — so if the `finally { polls.end(key) }` were deleted, the claim would live as
      // long as the session does: every later poll of that key would be answered out of the guard,
      // `pending` for ever, and the scan could never complete. Nothing above catches that — both cases
      // assert only that the *second* request was refused — which is how deleting the release could leave
      // the suite green.
      //
      // The stub's second answer is a different state on purpose (`QR_POLL_SCANNED` against the first
      // poll's `QR_POLL_PENDING`), so a request that reached the Platform cannot be mistaken for one
      // answered out of the claim: `scanned` is reachable only by going out.
      const afterRelease = await server.app.inject({
        method: 'GET',
        url: `/api/bili/accounts/qrcode/${QR_KEY}`,
        headers: session.auth()
      })
      expect(afterRelease.json()).toMatchObject({ ok: true, state: 'scanned' })
      expect(polls).toBe(2)
    } finally {
      releaseFirstPoll()
      vi.unstubAllGlobals()
    }
  })

  /**
   * The same promise on the other Platform's route. Both routes drive one code to a landing hop
   * that spends it, so the guard has to be on both; this case exists because a route is where the
   * guard gets forgotten, and the two routes are separate files.
   */
  base('answers the second Douyu poll without asking the Platform again', async ({ server, session }) => {
    const key = 'douyu-key-polled-twice'
    let polls = 0
    let releaseFirstPoll = (): void => {}
    const held = new Promise<void>(resolve => {
      releaseFirstPoll = resolve
    })

    vi.stubGlobal('fetch', async (input: unknown): Promise<Response> => {
      const url = urlOf(input)
      if (url === LOGIN_PAGE_URL) return new Response('<!doctype html>', { status: 200 })
      if (url === GENERATE_CODE_URL) {
        // Douyu's own envelope: the verdict field is `error`, and the code's life rides in `data`.
        return json({
          error: 0,
          data: { code: key, url: `https://m.douyu.com/topic/scan-login?scan_code=${key}`, expire: 300 }
        })
      }
      if (url.startsWith(SCAN_POLL_URL)) {
        polls += 1
        if (polls === 1) await held
        // `SCAN_CONFIRMING` is `scanned`, which is a different state from the `pending` the first
        // poll is still in — so a second call that reached the service cannot be mistaken for one
        // that did not. `99` is a code the flow has no meaning for, which is `pending`.
        return json(polls === 1 ? { error: 99 } : { error: SCAN_CONFIRMING })
      }
      throw new Error(`this test stubbed no answer for ${url}`)
    })

    try {
      const started = await server.app.inject({
        method: 'POST',
        url: '/api/douyu/accounts/qrcode',
        headers: session.auth()
      })
      expect(started.statusCode).toBe(200)
      expect(started.json<{ key: string }>().key).toBe(key)

      const first = server.app.inject({
        method: 'GET',
        url: `/api/douyu/accounts/qrcode/${key}`,
        headers: session.auth()
      })

      await vi.waitFor(() => {
        expect(polls).toBe(1)
      })

      const second = await server.app.inject({
        method: 'GET',
        url: `/api/douyu/accounts/qrcode/${key}`,
        headers: session.auth()
      })
      expect(second.json()).toMatchObject({ ok: true, state: 'pending' })
      expect(polls).toBe(1)

      releaseFirstPoll()
      const firstResponse = await first
      expect(firstResponse.statusCode).toBe(200)
      expect(firstResponse.json()).toMatchObject({ ok: true, state: 'pending' })

      // The same statement on the other route, and the same trap: `pending` returns early here too, so the
      // claim and the session both outlive it — and the Douyu session lives five minutes, which is an
      // eternity of 「请用手机扫码」 for a dialog polling every two seconds. `SCAN_CONFIRMING` is
      // `scanned` (the stub's second answer), and only a request that went out can produce it.
      const afterRelease = await server.app.inject({
        method: 'GET',
        url: `/api/douyu/accounts/qrcode/${key}`,
        headers: session.auth()
      })
      expect(afterRelease.json()).toMatchObject({ ok: true, state: 'scanned' })
      expect(polls).toBe(2)
    } finally {
      releaseFirstPoll()
      vi.unstubAllGlobals()
    }
  })
})
