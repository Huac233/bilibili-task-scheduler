import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'

import { BiliHttp, DEFAULT_TIMEOUT_MS } from '../src/bilibili/http.js'
import { fetchAnchorName, ROOM_INFO_URL, ROOM_INIT_URL, RoomRefusedError } from '../src/bilibili/live.js'
import { ROOM_INFO_BY_ROOM_URL } from '../src/bilibili/medal.js'
import { bilibiliPlatform } from '../src/platform/bilibili/index.js'

/**
 * The label a resolved target carries, driven against the bodies Bilibili actually answered.
 *
 * **Why this needs a file of its own, and why it is not a copy of `bilibili-adapter.test.ts`.** That
 * file mocks `live.js` at the module boundary — `fetchAnchorName` is a `vi.fn()` the case tells what to
 * answer — so no payload, and no *shape* of payload, can reach the reader through it. The defect this
 * file pins lived in exactly that blind spot: the adapter was reading `getInfoByRoom`'s
 * `data.anchor_info.base_info.uname` through an **anonymous** client, that endpoint answers an anonymous
 * client `code:-352` with no `data` at all, and the mocked reader went on answering a name. So here the
 * real adapter, the real readers and the real schemas run and only the transport is stubbed.
 *
 * Both fixtures are captures, byte-exact (`tests/captured/`, which `.gitattributes` keeps so):
 *
 *  - `bilibili-getInfoByRoom-14709735-anonymous.json` — what that endpoint answered a browser
 *    User-Agent and a same-site `Referer` **and no cookie**, which is the client `resolveTarget` builds.
 *  - `bilibili-get_info-14709735.json` — the same room's 标题 read, which does answer anonymously.
 *
 * The paste in the reported case is `https://live.bilibili.com/84074`: `84074` is the room's `short_id`
 * and `14709735` its `room_id`, so both ids appear below and each endpoint is asserted on the one it
 * wants.
 */

const GET_INFO_BY_ROOM_REFUSAL = readFileSync(
  new URL('./captured/bilibili-getInfoByRoom-14709735-anonymous.json', import.meta.url),
  'utf8'
)
const GET_INFO = readFileSync(new URL('./captured/bilibili-get_info-14709735.json', import.meta.url), 'utf8')

/**
 * **Constructed, not captured.** The four values in it are the ones the captured `get_info` body above
 * carries for this room (`room_id`, `short_id`, `uid`, `live_status`), read back off that capture rather
 * than invented. `room_init` is not the read under test; it is here so the paste travels the whole
 * resolve. `live_time` is `0`, which is what `roomInitDataSchema` requires of it — a number, unlike the
 * `"0000-00-00 00:00:00"` string `get_info` answers with the same fact.
 */
const ROOM_INIT = JSON.stringify({
  code: 0,
  msg: 'ok',
  message: 'ok',
  data: { room_id: 14709735, short_id: 84074, uid: 299013902, live_status: 0, live_time: 0 }
})

let calls: string[] = []

/** Serves each endpoint the body it was handed, and refuses any URL it was not told about. */
function installFetchMock(replies: ReadonlyMap<string, string>): void {
  const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    for (const [endpoint, body] of replies) {
      if (url.startsWith(endpoint)) {
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
      }
    }
    throw new Error(`unexpected request: ${url}`)
  })

  vi.stubGlobal('fetch', fetchMock)
}

/** The cookie-less client `resolveTarget` builds for itself. */
function anonymousHttp(): BiliHttp {
  return new BiliHttp({ timeoutMs: DEFAULT_TIMEOUT_MS })
}

afterEach(() => {
  vi.unstubAllGlobals()
  calls = []
})

/**
 * The regression, in the owner's own paste.
 *
 * The label beside 「已解析：…」 came back `''` because the only read allowed to fill it was refused, and
 * the page's own fallback for an empty label is 「目标 <key>」 — so a person saw less than the 标题 this
 * field carried before the name read existed. The 标题 is worse than a name and better than nothing, and
 * `铁人` is the value the captured `get_info` body holds today. (It is the broadcast's subject line, so
 * it moves with the stream: an earlier note in `bilibili-adapter.test.ts` recorded 「贴人」 for the same
 * room — which is the whole argument for not leaning on it *first*, and not an argument for showing
 * nothing when it is all there is.)
 */
it('labels a resolved room with its 标题 when the Anchor read is the one Bilibili refuses', async () => {
  installFetchMock(
    new Map([
      [ROOM_INIT_URL, ROOM_INIT],
      [ROOM_INFO_BY_ROOM_URL, GET_INFO_BY_ROOM_REFUSAL],
      [ROOM_INFO_URL, GET_INFO]
    ])
  )

  const target = await bilibiliPlatform.resolveTarget('https://live.bilibili.com/84074')

  expect(target.title).toBe('铁人')
  // The real room id, which is the key the page shows in 「目标 14709735」.
  expect(target.key).toBe('14709735')
  // Which id each endpoint wants, in the order they are asked: `room_init` maps the pasted short id,
  // and both room reads take the real one it mapped to.
  expect(calls).toEqual([
    `${ROOM_INIT_URL}?id=84074`,
    `${ROOM_INFO_BY_ROOM_URL}?room_id=14709735`,
    `${ROOM_INFO_URL}?room_id=14709735`
  ])
})

/**
 * The premise of the case above, pinned to the bytes.
 *
 * `-352` arrives with **no `data` at all**, so the reader throws rather than answering `''`: 「the room
 * reports no name」 and 「Bilibili refused to answer」 are two states, and only this layer can tell them
 * apart. A reader that graded a shape error here would look identical from above, which is why the code
 * is asserted rather than only the class.
 */
it('reads the captured refusal as the Platform’s own -352 rather than as a shape it cannot parse', async () => {
  installFetchMock(new Map([[ROOM_INFO_BY_ROOM_URL, GET_INFO_BY_ROOM_REFUSAL]]))

  await expect(fetchAnchorName(anonymousHttp(), 14709735)).rejects.toBeInstanceOf(RoomRefusedError)
  await expect(fetchAnchorName(anonymousHttp(), 14709735)).rejects.toMatchObject({ code: -352 })
})
