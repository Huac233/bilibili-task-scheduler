import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  signGroupAndroid,
  signGroupPc,
  YUBA_ALREADY_SIGNED,
  YUBA_FAST_SIGN_URL,
  YUBA_TOPIC_SIGN_URL
} from '../src/platform/douyu/protocol.js'

/**
 * The 鱼吧 sign twins, driven at the wire with `fetch` stubbed.
 *
 * Fixture provenance, stated per body:
 *  - **measured**: the exact bytes of one reply from the owner's account, 2026-10-10, one board
 *    (group 11244190). Only the PC twin's `1001` is measured this way.
 *  - **measured (fastSign)**: the exact bytes of `fastSign`'s `data: 0` reply, 2026-10-10, group
 *    7366311. Group 11254805's call answered the same two fields the same day.
 *  - **constructed**: built by hand to exercise a branch. Nothing says Douyu answers this way.
 *
 * **What was measured on 2026-10-10 06:54:45 (+08), and at what evidence level.** Board 11254805
 * (「Drop」, followed that morning, never signed): `fastSign` answered `status_code` 200 with `data: 0`,
 * and 0.2 s later the PC twin answered `status_code` 200 with `addLevelScore` 3 — a sign that call
 * placed, because a board whose sign is already in is refused with the `1001` above. So a `fastSign`
 * `0` means this call placed no sign, and the day was still open. **The bytes of those two replies were
 * not kept** (the probe recorded the parsed verdicts beside the HTTP statuses), so the pair below is
 * constructed from the measured values and says so; `signGroupAndroid` and `signGroupPc` in
 * `protocol.ts` carry the whole record of what was and was not measured.
 */

interface SentRequest {
  readonly url: string
  readonly method: string
  readonly referer: string | null
  readonly body: string
}

let sent: SentRequest[] = []
let reply = ''

async function fetchStub(input: string | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? {})
  sent.push({
    url: typeof input === 'string' ? input : input.toString(),
    method: init?.method ?? 'GET',
    referer: headers.get('referer'),
    body: typeof init?.body === 'string' ? init.body : ''
  })
  return new Response(reply, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } })
}

beforeEach(() => {
  sent = []
  reply = ''
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** measured: PC twin reply for group 11244190 on 2026-10-10, the board read as unsigned by every other reading. */
const MEASURED_PC_ALREADY = String.raw`{"status_code":1001,"status":"error","message":"\u4eca\u5929\u5df2\u7ecf\u7b7e\u5230\u8fc7\u4e86","toast_message":"","data":[]}`

/** measured (fastSign): the exact bytes of the `data: 0` reply, 2026-10-10, group 7366311. */
const MEASURED_FASTSIGN_ZERO = '{"data":0,"message":"","status_code":200}'

/**
 * constructed: built from the PC twin's measured `200` (`addLevelScore` 3). That reply's bytes were not
 * kept, so this body carries the two fields the module reads and **no `message`** — whether the measured
 * one was empty (the third-party rule for a fresh sign) is not in the record, and a fixture may not
 * assert it.
 */
const CONSTRUCTED_PC_SIGN_WITH_SCORE = '{"status_code":200,"data":{"addLevelScore":3}}'

describe('signGroupPc', () => {
  it('reads the measured 1001 as already signed, and sends one POST with the group referer', async () => {
    reply = MEASURED_PC_ALREADY

    const result = await signGroupPc('tok', '11244190')

    expect(result).toEqual({ ok: true, code: YUBA_ALREADY_SIGNED, data: { levelScore: 0, alreadySigned: true } })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      url: 'https://yuba.douyu.com/ybapi/topic/sign',
      method: 'POST',
      referer: 'https://yuba.douyu.com/group/11244190',
      body: 'group_id=11244190'
    })
  })

  it('reads a constructed 200 with a positive addLevelScore as a sign performed', async () => {
    // constructed: a PC `200` was measured on 2026-10-10 (see the provenance above), but its bytes
    // were not kept, so this body is built from the measured `addLevelScore` rather than captured.
    reply = '{"status_code":200,"status":"success","message":"","data":{"addLevelScore":5}}'

    const result = await signGroupPc('tok', '11244190')

    expect(result).toEqual({ ok: true, code: 200, data: { levelScore: 5, alreadySigned: false } })
  })

  it('reads a constructed 200 with no score as a score of zero, never as already', async () => {
    // constructed: no `200` without a score has ever been seen.
    reply = '{"status_code":200,"status":"success","message":"","data":{}}'

    const result = await signGroupPc('tok', '11244190')

    expect(result).toEqual({ ok: true, code: 200, data: { levelScore: 0, alreadySigned: false } })
  })

  it('does not read a constructed refusal as already', async () => {
    // constructed: a refusal other than 1001.
    reply = '{"status_code":1002,"status":"error","message":"用户未登陆或token已过期","data":null}'

    const result = await signGroupPc('tok', '11244190')

    expect(result.ok).toBe(false)
    expect(result.code).toBe(1002)
  })
})

describe('signGroupAndroid', () => {
  it('reads the measured fastSign zero as a successful call with a score of zero', async () => {
    reply = MEASURED_FASTSIGN_ZERO

    const result = await signGroupAndroid('tok', '11244190')

    expect(result).toEqual({ ok: true, code: 200, data: 0 })
    expect(sent[0]?.url).toBe('https://mapi-yuba.douyu.com/wb/v3/fastSign')
  })
})

/**
 * The one first sign this project has watched end to end: board 11254805, 2026-10-10 06:54:45 (+08).
 *
 * The two results below are the measured ones. The bodies that produced them were not kept, so the
 * fixtures are constructed — which is why this case asserts the *pair*, the reading that the record in
 * `protocol.ts` rests on, rather than a byte-for-byte replay.
 */
describe('the measured first sign, board 11254805', () => {
  it('leaves the day open on a fastSign zero, and the PC twin is what signs the board', async () => {
    reply = MEASURED_FASTSIGN_ZERO
    const fast = await signGroupAndroid('tok', '11254805')
    expect(fast).toEqual({ ok: true, code: 200, data: 0 })

    reply = CONSTRUCTED_PC_SIGN_WITH_SCORE
    const twin = await signGroupPc('tok', '11254805')
    expect(twin).toEqual({ ok: true, code: 200, data: { levelScore: 3, alreadySigned: false } })

    // The twin's branch is the one that signed: had the board been signed, it would have answered
    // `1001` and reported `alreadySigned` instead of a score.
    expect(sent.map(request => request.url)).toEqual([YUBA_FAST_SIGN_URL, YUBA_TOPIC_SIGN_URL])
  })
})
