import { afterEach, expect, it, vi } from 'vitest'

import { BiliHttp, DEFAULT_TIMEOUT_MS } from '../src/bilibili/http.js'
import { fetchAnchorName, RoomRefusedError } from '../src/bilibili/live.js'
import { ROOM_INFO_BY_ROOM_URL } from '../src/bilibili/medal.js'
import { sessionClientFor } from '../src/platform/bilibili/session.js'

/**
 * The read that answers 「who streams in this room」, driven against a stubbed transport.
 *
 * **Why this needs a file of its own.** Its only caller is `resolveTarget`, whose own suite mocks
 * this function at the module boundary and whose assertions are about what the adapter hands back;
 * the payload is pinned by `bilibili-schema.test.ts`, which never sends a request. What neither of
 * those covers is the middle: which URL the read asks, with which id, and what each of the payload's
 * three shapes (a name, no name, a refusal) turns into. That middle is where a wrong field path or a
 * pasted short id would sit silently, because both produce `''` — and `''` is a state the caller
 * treats as a real answer.
 *
 * `fetch` is stubbed and nothing here touches a real room. The fixture is the two fields this read
 * consumes and no others; the endpoint's real payload carries hundreds of keys, which is exactly why
 * the reader declares only the one it takes.
 */

interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly headers: Headers
}

let calls: RecordedCall[] = []

function installFetchMock(reply: unknown): void {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
    if (reply instanceof Response) return reply
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  })

  vi.stubGlobal('fetch', fetchMock)
}

/**
 * A client with no credential at all — which is what this read is *handed* when the person had not picked an
 * account, and **not** a client this endpoint answers: it answers a cookie-less caller `-352` with no `data`
 * (the measurement is `live.ts`'s `fetchAnchorName`). The reader below composes no cookie of its own either
 * way, which is what the case at the end of this file pins from both sides.
 */
function anonymousHttp(): BiliHttp {
  return new BiliHttp({ timeoutMs: DEFAULT_TIMEOUT_MS })
}

/** The room page's payload, narrowed to the one field this read takes. */
function anchorPayload(uname: string): unknown {
  return { code: 0, message: '0', data: { anchor_info: { base_info: { uname } } } }
}

afterEach(() => {
  vi.unstubAllGlobals()
  calls = []
})

it('asks the room page’s payload with the real room id, and reads the name nested under the anchor', async () => {
  installFetchMock(anchorPayload('炫神_'))

  // The reported case's room: `84074` is the id `room_init` mapped the paste to.
  const name = await fetchAnchorName(anonymousHttp(), 84074)

  expect(name).toBe('炫神_')
  expect(calls.map(call => call.url)).toEqual([`${ROOM_INFO_BY_ROOM_URL}?room_id=84074`])
  expect(calls[0]?.method).toBe('GET')
  // The reader contributes no cookie of its own: whatever travelled is the client's, which the case below
  // pins from the other side. A reader that reached into the jar here would be a defect either way.
  expect(calls[0]?.headers.get('cookie')).toBeNull()
})

/**
 * The other side of that: this reader sends what its client carries, and the client is the caller's choice.
 *
 * Which is the whole of the fix for the empty label — the caller has an account and this is the read that
 * needs it — so the pair of cases pins the boundary: the *reader* never invents a credential, and the
 * *caller* supplies one on this path. Which cookies the supplied client holds is
 * `bilibili/credential.ts`'s `credentialToSessionCookies` and is asserted through the real transport in
 * `bilibili-target-label.test.ts`.
 */
it('sends the session cookies of the client it was handed', async () => {
  installFetchMock(anchorPayload('炫神_'))

  const credentialed = sessionClientFor({
    cookies: { SESSDATA: 'sessdata-fixture-4b1e77c0', bili_jct: 'csrf-fixture-9a2f31b6', DedeUserID: '12345678' },
    refreshToken: ''
  })

  await fetchAnchorName(credentialed, 84074)

  expect(calls[0]?.headers.get('cookie')?.split('; ').sort()).toEqual([
    'DedeUserID=12345678',
    'SESSDATA=sessdata-fixture-4b1e77c0',
    'bili_jct=csrf-fixture-9a2f31b6'
  ])
})

it('answers nothing, rather than throwing, when the room reports no name', async () => {
  installFetchMock(anchorPayload(''))

  await expect(fetchAnchorName(anonymousHttp(), 84074)).resolves.toBe('')
})

it('answers nothing when a success arrives with no payload at all', async () => {
  installFetchMock({ code: 0, message: '0' })

  await expect(fetchAnchorName(anonymousHttp(), 84074)).resolves.toBe('')
})

/**
 * The refusal, graded the way both of this module's room readers grade theirs: a number the Platform
 * chose, carried as a field so a caller can tell it from a transport fault.
 *
 * `19002000`（获取初始化数据失败）is what this endpoint answers for a room it will not initialise. Its own
 * payload names no room and carries no anchor, which is why the code has to reach the error.
 *
 * A resolve that succeeds throws here, so a reader that quietly stopped grading a refusal could not
 * pass by asserting a message that was never produced.
 */
async function refusalOf(roomId: number): Promise<RoomRefusedError> {
  try {
    await fetchAnchorName(anonymousHttp(), roomId)
  } catch (error: unknown) {
    if (error instanceof RoomRefusedError) return error
    throw error
  }
  throw new Error(`fetchAnchorName accepted room ${String(roomId)} that its payload refused`)
}

it('throws the Platform’s own code when the payload refuses the room', async () => {
  installFetchMock({ code: 19002000, message: '获取初始化数据失败', msg: '获取初始化数据失败' })

  const failure = await refusalOf(84074)

  expect(failure.code).toBe(19002000)
  expect(failure.message).toContain('获取初始化数据失败')
})
