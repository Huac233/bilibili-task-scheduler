import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'

import { BiliHttp, DEFAULT_TIMEOUT_MS } from '../src/bilibili/http.js'
import { fetchAnchorName, ROOM_INFO_URL, ROOM_INIT_URL, RoomRefusedError } from '../src/bilibili/live.js'
import { ROOM_INFO_BY_ROOM_URL } from '../src/bilibili/medal.js'
import { bilibiliPlatform } from '../src/platform/bilibili/index.js'
import type { PlatformAccount } from '../src/platform/types.js'

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
 * The same endpoint's *answered* shape for this room, and **constructed rather than captured — which is
 * the one thing about this fixture worth saying out loud.**
 *
 * The measured body that carries it is not in this repository and must not be: it is 31 KB of the room
 * page's own module tree, and it holds the binder's `DedeUserID` as a standalone number plus a leaderboard
 * of third-party ids and names (checked with boundary-aware matching — "the digits appear somewhere in the
 * body" is worthless when an 8-digit id can be a slice of an epoch). So this keeps the envelope and the one
 * field the reader consumes, at the depth the real payload nests it, with the `uname` the room actually
 * answered (「炫神_」, which is public and already appears in the repository). `bilibili-schema.test.ts`
 * pins this shape against the real schema; what this fixture adds is that the *reader* sees it.
 */
const GET_INFO_BY_ROOM_ANSWERED = JSON.stringify({
  code: 0,
  message: '0',
  data: { anchor_info: { base_info: { uname: '炫神_' } } }
})

/**
 * A bound account, with cookie values that cannot be mistaken for anything else, and none of them real.
 *
 * The `buvid3` value is a marker rather than a plausible device id because one case below asserts the name
 * read does **not** carry it — and a short or guessable value could be assembled by accident from the
 * other fields' data (`AGENTS.md`'s rule for a marker in a negative assertion).
 */
const ACCOUNT_COOKIES: Readonly<Record<string, string>> = {
  SESSDATA: 'sessdata-fixture-4b1e77c0',
  bili_jct: 'csrf-fixture-9a2f31b6',
  DedeUserID: '12345678',
  buvid3: 'BUVID3-DEVICE-MARKER-MUST-NOT-TRAVEL'
}

/** One bound account, as the seam hands an adapter one. */
function account(): PlatformAccount {
  return {
    id: 3,
    platform: 'bilibili',
    externalId: '12345678',
    displayName: 'tester',
    avatar: '',
    credentials: JSON.stringify({ cookies: JSON.stringify(ACCOUNT_COOKIES), refreshToken: '' }),
    meta: '{}'
  }
}

/** One request the transport made: where it went, and the `Cookie` header it carried. */
interface SentRequest {
  readonly url: string
  readonly cookie: string
}

let sentRequests: SentRequest[] = []

/** Serves each endpoint the body it was handed, and refuses any URL it was not told about. */
function installFetchMock(replies: ReadonlyMap<string, string>): void {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    sentRequests.push({ url, cookie: new Headers(init?.headers).get('Cookie') ?? '' })
    for (const [endpoint, body] of replies) {
      if (url.startsWith(endpoint)) {
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
      }
    }
    throw new Error(`unexpected request: ${url}`)
  })

  vi.stubGlobal('fetch', fetchMock)
}

/** Every URL the transport was asked for, in the order they were asked. */
function urls(): string[] {
  return sentRequests.map(request => request.url)
}

/** The `Cookie` header the request to `endpoint` carried — `''` when it carried none. */
function cookieSentTo(endpoint: string): string | null {
  const request = sentRequests.find(candidate => candidate.url.startsWith(endpoint))
  return request === undefined ? null : request.cookie
}

/** The cookie-less client `resolveTarget` builds for its anonymous reads. */
function anonymousHttp(): BiliHttp {
  return new BiliHttp({ timeoutMs: DEFAULT_TIMEOUT_MS })
}

afterEach(() => {
  vi.unstubAllGlobals()
  sentRequests = []
})

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
  // **No account travelled, so the Anchor read could not have been credentialed — and the label says so
  // rather than leaving the person to guess why this is a 标题.** Spelled out here rather than read back
  // off the adapter's own constant: a test that compares the code's sentence to itself cannot disagree
  // with it.
  expect(target.titleNote).toBe('未选择账号，读不到主播名：B 站只在请求带上账号的登录 cookie 时才给出这个字段')
  // Which id each endpoint wants, in the order they are asked: `room_init` maps the pasted short id,
  // and both room reads take the real one it mapped to.
  expect(urls()).toEqual([
    `${ROOM_INIT_URL}?id=84074`,
    `${ROOM_INFO_BY_ROOM_URL}?room_id=14709735`,
    `${ROOM_INFO_URL}?room_id=14709735`
  ])
})

/**
 * The credentialed path, which is the ordinary one: on the create-task page a person picks the account
 * before pasting the room, so the label is read with that account's cookies in hand.
 *
 * **The measurement this case is built on, 2026-10-09, room 14709735, one variable per call:**
 *
 * | sent | answered |
 * | --- | --- |
 * | `buvid3` alone | `200` `{"code":-352,"message":"-352","ttl":1}`, no `data` |
 * | `SESSDATA` alone | the same `-352` envelope |
 * | `SESSDATA` + `bili_jct` | the same `-352` envelope |
 * | `SESSDATA` + `bili_jct` + `DedeUserID` | `200` `code: 0`, `data.anchor_info.base_info.uname` = 「炫神_」 |
 * | the whole stored jar | `200` `code: 0`, the same name |
 *
 * Two things follow, and both are what this case pins. **The device cookie is not what the read needs** —
 * `buvid3` alone is refused, and the jar that is answered is answered by its three session cookies alone
 * (the whole-jar call was the *control*: it came back `code: 0` in the same minute the subsets were being
 * refused, so those refusals are about the cookie set rather than about a risk-controlled caller).
 * **And the account's identity is what it needs** — `DedeUserID` is the difference between the two
 * three-cookie calls. Whichever account asks, the answer is the room's own name, so the label does not
 * depend on *which* account is selected; what it depends on is that some account's session travels.
 *
 * `credentialToSessionCookies` (`bilibili/credential.ts`) is where that set is defined and where the
 * numbers are written down; this case is the other end of it.
 */
it('reads the Anchor name through the account’s session cookies, and sends no device cookie', async () => {
  installFetchMock(
    new Map([
      [ROOM_INIT_URL, ROOM_INIT],
      [ROOM_INFO_BY_ROOM_URL, GET_INFO_BY_ROOM_ANSWERED]
    ])
  )

  const target = await bilibiliPlatform.resolveTarget('https://live.bilibili.com/84074', account())

  expect(target.title).toBe('炫神_')
  expect(target.key).toBe('14709735')
  // Nothing to explain: the label *is* the Anchor's name, so the note stays empty rather than repeating
  // what the line already says.
  expect(target.titleNote).toBe('')
  // A name that arrives short-circuits the 标题 read, so this path makes two requests rather than three.
  expect(urls()).toEqual([`${ROOM_INIT_URL}?id=84074`, `${ROOM_INFO_BY_ROOM_URL}?room_id=14709735`])

  // Exactly the session cookies and nothing wider, compared as a set so that the order inside the header
  // is not a fact this case pins. The negative is the half the measurement bought: the device cookie does
  // not travel, because it does not help.
  const cookieHeader = cookieSentTo(ROOM_INFO_BY_ROOM_URL)
  expect(cookieHeader?.split('; ').sort()).toEqual([
    'DedeUserID=12345678',
    'SESSDATA=sessdata-fixture-4b1e77c0',
    'bili_jct=csrf-fixture-9a2f31b6'
  ])
  expect(cookieHeader).not.toContain('BUVID3-DEVICE-MARKER-MUST-NOT-TRAVEL')

  // The reads that answer anonymously still carry nothing: a request sends what it needs and no more.
  expect(cookieSentTo(ROOM_INIT_URL)).toBe('')
})

/**
 * The other half of 「why is this a 标题」: an account *was* in hand and the name still did not arrive.
 *
 * A different sentence from the case above, and the difference is the whole reason the note is a field
 * rather than a boolean: 「未选择账号」 tells a person to pick one, while 「没读到主播名」 tells them the
 * account they picked did not help — and a page that printed the first sentence for both would be sending
 * somebody to fix the one thing that is already right.
 */
it('says only that the name was not read when an account was in hand and Bilibili refused anyway', async () => {
  installFetchMock(
    new Map([
      [ROOM_INIT_URL, ROOM_INIT],
      [ROOM_INFO_BY_ROOM_URL, GET_INFO_BY_ROOM_REFUSAL],
      [ROOM_INFO_URL, GET_INFO]
    ])
  )

  const target = await bilibiliPlatform.resolveTarget('https://live.bilibili.com/84074', account())

  expect(target.title).toBe('铁人')
  expect(target.titleNote).toBe('没读到主播名')
  // The credential travelled on the read that failed — which is what makes the note the shorter sentence
  // rather than the one about no account.
  expect(cookieSentTo(ROOM_INFO_BY_ROOM_URL)).toContain('SESSDATA=sessdata-fixture-4b1e77c0')
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
