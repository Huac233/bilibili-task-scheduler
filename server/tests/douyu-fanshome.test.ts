import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { douyuPlatform } from '../src/platform/douyu/index.js'
import { FANSHOME_ALREADY_SIGNED, signFansHome } from '../src/platform/douyu/protocol.js'
import type { ActionOutcome, PlatformAccount } from '../src/platform/types.js'
import { ActionKey } from '../src/repo/tasks.js'

/**
 * 粉丝家园签到, at the wire.
 *
 * `douyu-adapter.test.ts` mocks the protocol module, which is the right boundary for what the
 * *adapter does* with a verdict — but it cannot see a URL, a header, a body, or a page, and
 * every fact this action turns on lives there:
 *
 *  - **`ctn` is the `acf_ccn` cookie's value**, so the body and the `cookie` header have to
 *    agree. That is one request's shape and nowhere else.
 *  - **the badge wall is HTML**, and the rooms are read out of markup rather than a payload.
 *  - **both credentials travel** — the web session as `cookie` and the composite token as
 *    `token` — because no experiment has separated the two on this family.
 *  - **no identifier reaches an item.** The room's id goes in the request; the anchor's name
 *    is what a person reads.
 *
 * Nothing here reaches the network: `fetch` is stubbed and every reply is scripted below. The
 * protocol module and the adapter are both real, so what is exercised is the code that runs,
 * from the URL up.
 */

/**
 * The badge wall's own table, byte for byte out of a captured response.
 *
 * Taken from `douyu-probe/state/runs/2026-10-07T17-01-27-002Z-read.json` (the
 * `read-medal-wall` entry's `body`), which is the same response the CSRF cookie in
 * `freshScript` came from — the two halves of one exchange, which is the point of the
 * action. Kept as a file rather than inlined because it is 7 KB of a page's real
 * indentation, and a fixture re-typed by hand is a fixture that tests the author's idea of
 * the markup. It sits in `captured/` rather than in a `data/` directory because the root
 * `.gitignore` excludes `data/` — as runtime state — and a fixture that cannot be committed
 * is a test that passes for exactly one person.
 */
const BADGE_TABLE = readFileSync(new URL('./captured/douyu-fan-badges.html', import.meta.url), 'utf8')

const TOKEN = '123456789_1_abcdef0123456789_0_69117311'
const DID = '20e8917f4ebe85866a5e94cfaba2f156'

/** The rooms the captured page lists, and the anchors it names them by. */
const ROOM_A = '12293234'
const ROOM_B = '12306'

/**
 * The `acf_ccn` the captured badge response minted.
 *
 * Verbatim from that response's `Set-Cookie` (`Max-Age=7200`), so it is inert: it expired two
 * hours after 2026-10-07 17:01. A real value rather than a placeholder because the number is
 * what the body has to repeat, and a made-up one would let a body/header mismatch pass.
 */
const MINTED_CCN = 'cad9e917f2ba07b1eac9ca5e5bfc0dde'

/** The other half of the pair: an `acf_ccn` the account's own cookie header already carried. */
const HELD_CCN = '11111111111111111111111111111111'

/** The web session the binder stores, `acf_ccn` included. Hand-written; the shape is §4's. */
const WEB_COOKIES = `acf_auth=1_1_abcdef; acf_uid=456918967; acf_did=${DID}; acf_ccn=${HELD_CCN}`

/**
 * The same session without an `acf_ccn` — **the state the live run was in**.
 *
 * A jar the binder wrote is the five `acf_*` cookies the scan lands and nothing else: `acf_ccn`
 * is minted by a read and dies at `Max-Age=7200`, so whether a stored jar carries one is luck
 * about when it was written. The failure this file's wire tests grew from was reported against a
 * jar of exactly this shape, which is why it is a fixture rather than a comment.
 */
const WEB_COOKIES_WITHOUT_CCN = `acf_auth=1_1_abcdef; acf_uid=456918967; acf_did=${DID}`

const BADGES_PATH = '/member/cp/getFansBadgeList'
const SIGN_PATH = '/japi/interactnc/web/fanshome/sign'

/** One request as it left this process, before the stub answered it. */
interface Recorded {
  readonly path: string
  readonly method: string
  readonly headers: readonly string[]
  readonly token: string | null
  readonly cookie: string | null
  readonly body: string
}

/** A scripted reply: an envelope, a page, or — by rejecting — a call that never arrived. */
interface Scripted {
  readonly json?: unknown
  readonly text?: string
  readonly status?: number
  readonly setCookie?: string
  readonly unreachable?: boolean
}

const requests: Recorded[] = []

/** What each endpoint answers on this run. A test replaces the half it is about. */
interface Script {
  badges: Scripted
  sign: (rid: string) => Scripted
}

let script: Script
let logs: string[]

/** The captured 403 in full, as the CSRF layer refuses this endpoint. */
const CSRF_REFUSAL = {
  timestamp: 1_791_390_321_714,
  status: 403,
  error: 'Forbidden',
  message: 'csrf auth failed',
  path: SIGN_PATH
}

function freshScript(): Script {
  return {
    // The captured response: the page, and the `acf_ccn` its own headers mint.
    badges: {
      text: BADGE_TABLE,
      setCookie: `acf_ccn=${MINTED_CCN}; expires=Wed, 07-Oct-2026 18:59:19 GMT; Max-Age=7200; path=/`
    },
    // The only 200 body this endpoint has ever answered, verbatim (captured twice).
    sign: () => ({ json: { error: -1, msg: '今日已签到，请明天再来' } })
  }
}

async function fetchStub(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input.toString()
  const headers = new Headers(init?.headers ?? {})
  const body = typeof init?.body === 'string' ? init.body : ''
  const path = new URL(url).pathname

  requests.push({
    path,
    method: init?.method ?? 'GET',
    headers: [...headers.keys()].sort(),
    token: headers.get('token'),
    cookie: headers.get('cookie'),
    body
  })

  const answer = path === BADGES_PATH ? script.badges : script.sign(new URLSearchParams(body).get('rid') ?? '')
  if (answer.unreachable === true) throw new TypeError('fetch failed')

  const responseHeaders = new Headers({
    'content-type': answer.text === undefined ? 'application/json;charset=UTF-8' : 'text/html; charset=UTF-8'
  })
  if (answer.setCookie !== undefined) responseHeaders.set('set-cookie', answer.setCookie)

  return new Response(answer.text ?? JSON.stringify(answer.json ?? {}), {
    status: answer.status ?? 200,
    headers: responseHeaders
  })
}

beforeEach(() => {
  requests.length = 0
  logs = []
  script = freshScript()
  vi.stubGlobal('fetch', fetchStub)
})

function account(webCookies = WEB_COOKIES): PlatformAccount {
  const blob: Record<string, string> = { token: TOKEN, did: DID }
  // The binder omits the field entirely when there is no session, which is what this account's
  // blob looks like today.
  if (webCookies !== '') blob['webCookies'] = webCookies
  return {
    id: 7,
    platform: 'douyu',
    externalId: '456918967',
    displayName: 'tester',
    avatar: '',
    credentials: JSON.stringify(blob),
    meta: '{}'
  }
}

/**
 * The instant every run below uses: Shanghai 06:22 on 2026-10-08.
 *
 * Passed and ignored — this action has no window and reads no clock — but a fixed instant keeps
 * a run in this file reproducible, and `Date.now()` would suggest the code consults it.
 */
const NOW = 1_791_411_776_000

async function run(webCookies = WEB_COOKIES): Promise<ActionOutcome> {
  const outcomes = await douyuPlatform.reconcile({
    account: account(webCookies),
    targetKey: '',
    enabledActions: [ActionKey.FanshomeSign],
    // 粉丝家园签到 has no options; the map is here because a run always carries one.
    options: {},
    now: NOW,
    dayKey: '2026-10-08',
    log: line => logs.push(line)
  })

  const found = outcomes.find(outcome => outcome.actionKey === ActionKey.FanshomeSign)
  if (found === undefined) throw new Error('no outcome for fanshome_sign')
  return found
}

/** Every request whose path is this one. */
function sentTo(path: string): Recorded[] {
  return requests.filter(recorded => recorded.path === path)
}

/** One request's form body, as the service would read it. */
function formOf(recorded: Recorded): URLSearchParams {
  return new URLSearchParams(recorded.body)
}

/**
 * Every value the request carried under one cookie name.
 *
 * A list and not a single value because the count is the assertion: a `Cookie:` header that
 * carries the freshly minted `acf_ccn` *beside* a stale one hands the CSRF layer two candidates
 * for one field, and "the value is present" would be true of that header as well.
 */
function cookiesIn(recorded: Recorded, name: string): string[] {
  return (recorded.cookie ?? '')
    .split(';')
    .map(part => part.trim())
    .filter(part => part.startsWith(`${name}=`))
    .map(part => part.slice(name.length + 1))
}

/** The `acf_ccn` values one sign request carried in its cookie header. */
function sentCcn(recorded: Recorded): string[] {
  return cookiesIn(recorded, 'acf_ccn')
}

describe('the 粉丝家园 sign-in', () => {
  it('reads the badge wall, then signs each room with the value that same read minted', async () => {
    const outcome = await run()

    const read = sentTo(BADGES_PATH)
    expect(read).toHaveLength(1)
    expect(read[0]).toMatchObject({ method: 'GET', token: TOKEN, cookie: WEB_COOKIES })
    // Both credentials, which is the captured call's own shape: the whole web session and the
    // composite token. **Which of the two the service requires was never isolated** — no
    // experiment has separated them on this family — so the pair travels rather than a guess.
    expect(read[0]?.headers).toEqual(['accept', 'accept-language', 'cookie', 'token', 'user-agent'])

    const signs = sentTo(SIGN_PATH)
    expect(signs).toHaveLength(2)
    for (const sign of signs) {
      expect(sign.method).toBe('POST')
      expect(sign.headers).toEqual(['accept', 'accept-language', 'content-type', 'cookie', 'token', 'user-agent'])
      expect(sign.token).toBe(TOKEN)
      // The pair the CSRF layer checks, in the body's own order: `ctn` then `rid`.
      expect(sign.body).toMatch(/^ctn=[0-9a-f]{32}&rid=(12293234|12306)$/)
      // …and the same value as a cookie, **once**: this layer is a double submit, so the body's
      // `ctn` and the request's own `acf_ccn` have to be the same string. Asserting only the body
      // is exactly the assertion that passed while the live request carried no cookie at all.
      expect(sentCcn(sign)).toEqual([MINTED_CCN])
    }

    // `ctn` is what the read minted, **not** the `acf_ccn` the header was carrying: a cookie
    // the service sets in this response is the newest thing it has said about the session, and a
    // browser that had just loaded that page would send exactly it. The captured run's dump
    // lists `acf_ccn` before the read and the response sets it again, so this is the ordinary
    // cookie-lifecycle reading rather than a preference nothing supports.
    expect(formOf(signs[0] as Recorded).get('ctn')).toBe(MINTED_CCN)
    expect(formOf(signs[0] as Recorded).get('ctn')).not.toBe(HELD_CCN)
    expect(signs.map(sign => formOf(sign).get('rid'))).toEqual([ROOM_A, ROOM_B])

    // Both rooms answered the only 200 body this endpoint has ever answered, so the day is done
    // — `already`, parked until tomorrow, which is what a daily reset makes a success.
    expect(outcome).toMatchObject({
      outcome: 'already',
      code: String(FANSHOME_ALREADY_SIGNED),
      failure: 'action_stop',
      detail: '新签 0、已签 2（共 2 个直播间）'
    })

    // One item per room, labelled by **the anchor's name**: the id it was signed with is an
    // identifier, and an item's label is the one field the main UI renders. The detail is the
    // fact and nothing else — 「已签」 — because what this endpoint pays has no evidence behind
    // it, so a number here would be one nobody has ever read.
    expect(outcome.items).toEqual([
      { kind: 'room', label: '145oni', outcome: 'already', detail: '已签', code: '-1' },
      { kind: 'room', label: '电棍', outcome: 'already', detail: '已签', code: '-1' }
    ])
    // …while the console line carries the room as well: the id is what tells two same-named
    // anchors apart, and it is the one field an item's label may never be.
    expect(logs[1]).toBe('粉丝家园「145oni（房间 12293234）」：今天已经签到过了')
    // The line above it is the run's account of the CSRF value: which half it came from, and how
    // long it is — a fingerprint for comparing two runs, and **never the value**, which is a
    // credential for the next two hours and does not go into a log line.
    expect(logs[0]).toBe('粉丝家园：读粉丝牌这次下发了 acf_ccn，本次请求带的 CSRF 值取自它，长度 32')
    expect(logs[0]).not.toContain(MINTED_CCN)
    expect(logs[0]).not.toContain(HELD_CCN)
  })

  it('falls back to the acf_ccn the cookie header carries when the wall mints none', async () => {
    script.badges = { text: BADGE_TABLE }

    await run()

    const signs = sentTo(SIGN_PATH)
    expect(signs).toHaveLength(2)
    expect(formOf(signs[0] as Recorded).get('ctn')).toBe(HELD_CCN)
    // The fallback value goes out in both places too, and still only once — the jar's own copy of
    // the pair must not survive beside the one the request is declaring.
    expect(sentCcn(signs[0] as Recorded)).toEqual([HELD_CCN])
  })

  it('carries the value the read minted as a cookie as well, on a jar that holds no acf_ccn', async () => {
    // The live shape: the badge wall mints one, the stored jar has none, so the body and the
    // cookie header have to get the value from the same place — the response this run just read.
    const outcome = await run(WEB_COOKIES_WITHOUT_CCN)

    const signs = sentTo(SIGN_PATH)
    expect(signs).toHaveLength(2)
    for (const sign of signs) {
      expect(formOf(sign).get('ctn')).toBe(MINTED_CCN)
      expect(sentCcn(sign)).toEqual([MINTED_CCN])
      // The rest of the session still travels: the mint is one cookie added to the jar, not a
      // jar replaced by it.
      expect(cookiesIn(sign, 'acf_auth')).toEqual(['1_1_abcdef'])
      expect(cookiesIn(sign, 'acf_did')).toEqual([DID])
    }
    expect(outcome).toMatchObject({ outcome: 'already', failure: 'action_stop' })
  })

  it('replaces the acf_ccn the jar already carries, rather than sending both', async () => {
    // A stored `acf_ccn` is the likeliest thing in a session header to be stale — it is declared
    // for 7200 seconds — and a header carrying it beside the fresh one leaves the layer to choose
    // between two candidates for `ctn`.
    const outcome = await run()

    const signs = sentTo(SIGN_PATH)
    expect(sentCcn(signs[0] as Recorded)).toHaveLength(1)
    expect(sentCcn(signs[0] as Recorded)).not.toContain(HELD_CCN)
    expect(outcome).toMatchObject({ outcome: 'already' })
  })

  it('sends nothing when neither the read nor the session has a CSRF value, and says so', async () => {
    // Nothing to send, so nothing is sent: no request of this project's has ever passed this
    // layer with an empty `ctn`, and spending a room's attempt on a known-refused request
    // reports a failure where the honest answer is a precondition this run could not meet.
    script.badges = { text: BADGE_TABLE }

    const outcome = await run(WEB_COOKIES_WITHOUT_CCN)

    expect(sentTo(SIGN_PATH)).toEqual([])
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'csrf_unavailable', failure: 'action_stop' })
    // The value is minted by a read, so another run may well have one: `blocked` keeps the day
    // unsettled and the sweep comes back. 网页会话 is named as what is *not* the problem here.
    expect(outcome.detail).toContain('拿不到')
    expect(outcome.detail).not.toContain('重新扫码绑定')
    // The console says which half was missing, which is the fact the disk could not settle when
    // this action's first live failure was being diagnosed.
    expect(logs[0]).toBe('粉丝家园：读粉丝牌这次没有下发 acf_ccn，网页会话里也没有，本次拿不到 CSRF 值')
  })

  it('does not even build an empty ctn, whoever asks it to', async () => {
    // The adapter's guard is the state a person reads; this one is the invariant under it, so a
    // future caller with a value it could not obtain cannot spend a room's attempt on the request
    // this layer is never observed to let through.
    await expect(signFansHome(TOKEN, WEB_COOKIES, '', ROOM_A)).rejects.toThrow(/ctn is empty/)
    expect(sentTo(SIGN_PATH)).toEqual([])
  })

  it('counts a room that actually signed as new, and leaves the reward unsaid', async () => {
    // `error: 0` is the success this project has **never captured**: it comes from the reference
    // implementation's own test of the field. The case pins what this side does with it, not
    // what the service answers — when a real body arrives, the constant is where it lands.
    script.sign = rid =>
      rid === ROOM_A ? { json: { error: 0 } } : { json: { error: -1, msg: '今日已签到，请明天再来' } }

    const outcome = await run()

    expect(outcome).toMatchObject({ outcome: 'done', failure: 'none', detail: '新签 1、已签 1（共 2 个直播间）' })
    expect(outcome.items).toEqual([
      { kind: 'room', label: '145oni', outcome: 'done', detail: '已签', code: '0' },
      { kind: 'room', label: '电棍', outcome: 'already', detail: '已签', code: '-1' }
    ])
  })

  it('sends nothing at all when the account has no web session', async () => {
    const outcome = await run('')

    // The action needs a session beside the token, and this is the state this account is in
    // today. Not a single request may be attempted: the badge wall would answer a logged-out
    // page, and a sign sent without a session is refused at the identity layer — a dead-token
    // reading of a problem that is not the token.
    expect(requests).toEqual([])
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_web_session', failure: 'action_stop' })
    // `blocked` is not settled, so the sweep comes back; `action_stop` is what raises 动作受阻,
    // so the person is told without opening a log — and the sentence names the fix.
    expect(outcome.detail).toContain('网页会话')
    expect(outcome.detail).toContain('重新扫码绑定')
  })

  it('does not write when the badge wall lists no rooms', async () => {
    // Anything that is not the badge table: a logged-out page, a renamed markup, a redirect.
    script.badges = { text: '<html><body><div id="js_login_dialog"></div></body></html>' }

    const outcome = await run()

    expect(sentTo(SIGN_PATH)).toHaveLength(0)
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_badges', failure: 'none' })
    // Two readings and no way to tell them apart here, so neither is asserted: `skipped` would
    // settle the day on the "dead session" one, which is how a dead session becomes a task that
    // looks healthy.
    expect(outcome.detail).toContain('粉丝牌')
    expect(outcome.detail).toContain('网页会话')
  })

  it('grades the CSRF layer’s 403 as a local precondition and stops the walk', async () => {
    script.sign = () => ({ status: 403, json: { ...CSRF_REFUSAL } })

    const outcome = await run()

    // One room, not two: what was refused is the value every room's body carries, so each
    // remaining call would send the same `ctn` and be refused identically. Replaying this shape
    // is what answers 403 again, which is why it is not graded `retry`.
    expect(sentTo(SIGN_PATH)).toHaveLength(1)
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'csrf_rejected', failure: 'action_stop' })
    expect(outcome.detail).toContain('CSRF')
    // The platform's own wording survives; what changed is the sentence after it, which now says
    // what was actually sent — the value in both places — instead of naming a session to fix.
    expect(outcome.detail).toContain('csrf auth failed')
    expect(outcome.detail).toContain('body 与 cookie')
    expect(outcome.items).toEqual([
      {
        kind: 'room',
        label: '145oni',
        outcome: 'failed',
        detail: expect.stringContaining('csrf auth failed'),
        code: 'csrf_rejected'
      }
    ])
    // What the detail does *not* claim is why the platform refused — the captured run kept the
    // response and not the request, so that 403's cause is still unknown. What it can say is what
    // this build sent, and what that rules out.
    expect(outcome.detail).not.toContain('acf_ccn')
    // **A refused value is not a dead session.** The bind that stored this account's token
    // walked the web flow — the jar is there and the badge wall answered it a room list — so a
    // re-bind is not the remedy and pointing at one is a wrong errand.
    expect(outcome.detail).not.toContain('重新扫码绑定')
  })

  it('keeps walking when one room’s call never reaches Douyu', async () => {
    script.sign = rid =>
      rid === ROOM_A ? { unreachable: true } : { json: { error: -1, msg: '今日已签到，请明天再来' } }

    const outcome = await run()

    // Where this walk differs from 鱼吧's: there one page read covers a hundred groups, here a
    // room is a request of its own, so one that did not come back says nothing about the next.
    expect(sentTo(SIGN_PATH)).toHaveLength(2)
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
    expect(outcome.detail).toContain('新签 0、已签 1（共 2 个直播间）、失败 1')
    expect(outcome.items).toEqual([
      {
        kind: 'room',
        label: '145oni',
        outcome: 'failed',
        detail: expect.stringContaining('粉丝家园签到失败'),
        code: 'transport'
      },
      { kind: 'room', label: '电棍', outcome: 'already', detail: '已签', code: '-1' }
    ])
  })

  it('lets an account_stop from one room outrank the room that signed', async () => {
    script.sign = rid => (rid === ROOM_A ? { json: { error: 0 } } : { json: { error: 1002, msg: '用户未登录' } })

    const outcome = await run()

    expect(sentTo(SIGN_PATH)).toHaveLength(2)
    // A run that also signed a room must not be reported as a success: nothing that failed this
    // way works again until a person re-binds.
    expect(outcome).toMatchObject({ outcome: 'failed', code: '1002', failure: 'account_stop' })
    expect(outcome.detail).toContain('新签 1')
    expect(outcome.items.map(item => item.outcome)).toEqual(['done', 'failed'])
  })

  it('reports the badge wall’s own failure as the action’s, and writes nothing', async () => {
    script.badges = { unreachable: true }

    const outcome = await run()

    expect(sentTo(SIGN_PATH)).toEqual([])
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
    expect(outcome.detail).toContain('读取粉丝牌列表失败')
    // The credential is the whole account, and this string is written to a row and rendered.
    expect(outcome.detail).not.toContain(TOKEN)
    expect(outcome.detail).not.toContain(HELD_CCN)
  })

  it('describes a room whose anchor the wall did not name, instead of labelling it with its id', async () => {
    script.badges = {
      text: '<table class="aui_room_table fans-badge-list"><tbody><tr data-fans-room="99999" data-fans-level="1" data-dfans="0"><td>徽章</td></tr></tbody></table>'
    }

    const outcome = await run()

    expect(formOf(sentTo(SIGN_PATH)[0] as Recorded).get('rid')).toBe('99999')
    expect(outcome.items[0]).toMatchObject({ kind: 'room', label: '未命名直播间', outcome: 'already' })
    // The console keeps the id, which is the only thing this room has.
    expect(logs[1]).toBe('粉丝家园「99999」：今天已经签到过了')
    // …and the line before it says the value came from the session rather than from this read,
    // which is the fallback half of the same fact.
    expect(logs[0]).toBe('粉丝家园：读粉丝牌这次没有下发 acf_ccn，本次请求带的 CSRF 值取自网页会话，长度 32')
  })
})
