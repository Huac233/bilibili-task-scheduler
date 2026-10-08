import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { descriptorsWithDeclarations, fieldsOf } from '../src/actions/action-options.js'
import { douyuPlatform } from '../src/platform/douyu/index.js'
import { FISHING_BAIT_EXHAUSTED, FISHING_FISH_ON_THE_LINE } from '../src/platform/douyu/protocol.js'
import type { ActionOutcome, PlatformAccount } from '../src/platform/types.js'
import { ActionKey } from '../src/repo/tasks.js'

/**
 * 粉丝家园钓鱼, at the wire and across a whole cycle.
 *
 * `douyu-adapter.test.ts` mocks the protocol module, which is the right boundary for what the adapter
 * does with a *verdict* — but this action's subject is a sequence: which request comes next, what each
 * one is allowed to carry, and which reading a number was taken from. Four facts this file exists to
 * pin are invisible behind a mock:
 *
 *  - **`ctn` is minted by a read and then travels twice.** The cast's body carries it and so does that
 *    request's own `Cookie:` header — the double submit whose missing half was 粉丝家园签到's one live
 *    403. Same value in both places, and the jar's stale copy replaced rather than joined.
 *  - **the cast's body is verbatim**: `ctn`, `rid`, `baitId`, `ver=1.1`, in the capture's own order.
 *  - **the cost is a subtraction between two named readings**, and the trap is that another pair gives
 *    `0` and the conclusion "casting is free". The happy path uses the capture's own numbers: 1150 read
 *    before the cast, 1130 in the cast's own response.
 *  - **the wait ends at the instant the service named**, which a suite cannot sit through: the fixtures
 *    put that instant just in the past, and one case deliberately moves it 60 ms out to show the sleep
 *    is really the platform's instant and not a constant of this module's.
 *
 * Nothing here reaches the network: `fetch` is stubbed, and every reply is a captured body or a captured
 * body with one field moved. The protocol module and the adapter are both real, so what runs is the code
 * that ships, from the URL up.
 */

const TOKEN = '123456789_1_abcdef0123456789_0_69117311'
const DID = '20e8917f4ebe85866a5e94cfaba2f156'
const ROOM = '12306'

/**
 * The `acf_ccn` the captured badge wall's own headers minted (`Max-Age=7200`, long expired).
 *
 * A real value rather than a placeholder because it is the string the body has to repeat: a made-up one
 * would let a body/header mismatch pass.
 */
const MINTED_CCN = 'cad9e917f2ba07b1eac9ca5e5bfc0dde'

/** The `acf_ccn` the stored jar already carries — the copy a cast must replace, not send beside. */
const HELD_CCN = '22222222222222222222222222222222'

const WEB_COOKIES = `acf_auth=1_1_abcdef; acf_uid=456918967; acf_did=${DID}; acf_ccn=${HELD_CCN}`

/**
 * The badge wall, byte for byte out of the captured response this account's own cookie dump came with.
 *
 * It is read out of a file rather than inlined because it is 7 KB of a page's real indentation, and it
 * is the same fixture `douyu-fanshome.test.ts` uses — the value this action casts with is minted by
 * exactly this response, so the two actions are reading one fact.
 */
const BADGE_TABLE = readFileSync(new URL('./captured/douyu-fan-badges.html', import.meta.url), 'utf8')

const BADGES_PATH = '/member/cp/getFansBadgeList'
const HOME_PATH = '/japi/revenuenc/web/actfans/fishing/homePage'
const CAST_PATH = '/japi/revenuenc/web/actfans/fishing/fishing'
const REEL_PATH = '/japi/revenuenc/web/actfans/fishing/reelIn'
const CODEX_PATH = '/japi/revenuenc/web/actfans/achieve/accList'
const CHIPS_PATH = '/japi/revenuenc/web/actfans/userLottery/panelInfo'

/**
 * The 图鉴, byte for byte out of the captured response.
 *
 * Taken from the probe run's saved body (`douyu-probe/state/runs/2026-10-07T17-02-01-288Z-sign.json`,
 * the `accList` entry), read out of a file for the reason the badge table is: it is 7.9 KB of a
 * payload with thirty-five rows and icon URLs, and a fixture retyped by hand tests the author's idea
 * of the payload. It is the same account and the same room as the rest of this file's captures.
 *
 * **One row matters**: `fishId: 11` is 小龙虾, `firstLight: 0` — unregistered — and `fishId: 11` is
 * exactly what the captured `reelIn` body answers. The one species this account had registered at
 * the time was 泥鳅 (13).
 */
const CAPTURED_CODEX = readFileSync(new URL('./captured/douyu-fishing-acc-list.json', import.meta.url), 'utf8')

/**
 * The chips panel, verbatim (`bodies/act/a27ea430_…_userLottery_panelInfo`).
 *
 * Its `lotteryInfo.score` is 88 here and 81 in the same capture four seconds later, after a
 * `batch=10` draw — which is what makes this number the counter a draw spends rather than one more
 * uninterpretable field.
 */
const CAPTURED_CHIPS = `{"error":0,"msg":"success","data":{"ts":1791452971253,"lotteryInfo":{"score":88,"batch100Lock":0,"lotterySettingScore":1},"disp":{"step":1,"week":97,"day":676,"hour":17,"hcst":1791450000,"hcet":1791453600}}}`

/**
 * The instant every run below is inside a window at: 2026-10-08 18:06:40 (+08).
 *
 * The captured panels carry `matchInfo` `st` 1791453600 / `et` 1791457200 — 18:00–19:00 on that day,
 * the **one-hour** window of that capture, against the twelve-hour one an earlier capture of the same
 * account and room read. A fixed instant inside it keeps a run reproducible, and it is passed in rather
 * than read from the wall clock, which is the whole point of `ReconcileContext.now`.
 */
const INSIDE_WINDOW = 1_791_454_000_000

/** 17:50 the same day: outside that capture's window, and inside the older capture's own. */
const BEFORE_WINDOW = 1_791_453_000_000

/**
 * The instant the captured cast actually went out at: 2026-10-08 17:49:45.958 (+08), **614.042 s
 * before `st`**.
 *
 * This is the measurement the window judgement was wrong about. The panels above report this
 * room's window as `st` 1791453600 (18:00) / `et` 1791457200 (19:00), and the cast this project
 * captured went out a little over ten minutes *before* it: its own response carries `fishStMs`
 * 1791452986292, `error: 0`, `baits[0].cnt` 1150 → 1130, and the reel-in that followed moved
 * `myCh.exp` 1731 → 1732. A cast outside the window is therefore not merely accepted — it pays.
 *
 * **The milliseconds are load-bearing and were not here before.** This constant used to be
 * `1_791_452_985_000` — the capture's `t=1791452985.958` truncated to the second — and that
 * truncation is where the description's "615 秒" came from: a whole-second 17:49:45 is exactly
 * 615 s before `st`, while the instant the capture recorded is 614.042 s before it. The number in
 * the prose and the instant in the fixture are one fact, so they are pinned together by the case
 * below rather than in two places that could drift again.
 */
const CAPTURED_CAST_AT = 1_791_452_985_958

/**
 * The two clauses a finished run appends to its own line, as this file's fixtures produce them.
 *
 * Spelled once because three cases assert the whole line and a difference between them would be a
 * difference the reader has to hunt for; the numbers in them are the captured bodies' own (35 species
 * with 泥鳅 the only one registered, and a chips counter of 88).
 */
const CODEX_LINE = '图鉴 35 种、已收录 1 种'
const CHIPS_LINE = '抽奖积分 88、抽奖是另一个动作（这一版只读不花）'

/* ------------------------------------------------------------------ *
 * The captured bodies, verbatim
 * ------------------------------------------------------------------ */

/**
 * `GET …/fishing/homePage` of 17:49:35.958 (+08) — `bodies/act/6fce9598_…_fishing_homePage`.
 *
 * This is the reading the cast's own response is subtracted against: `baits[0].cnt` is **1150** here,
 * and ten seconds later the cast answered **1130**. `stat` is 0, `myCh` is set, and `castBait` is 0 —
 * which is the field the old note read as "the cost of one cast", a number this file's fifth case
 * disproves by arithmetic.
 */
const CAPTURED_IDLE = `{"error":0,"msg":"success","data":{"timeMs":1791452976223,"matchInfo":{"stat":1,"hour":17,"st":1791453600,"et":1791457200,"left":625,"lhour":0},"myCh":{"uid":456918967,"rid":12306,"ctype":2,"clv":4,"exp":1731,"buffs":{"gain":1.2,"fishLv":[4,5]},"wear":1,"time":1761841287},"rods":[{"id":1,"cnt":4,"rid":0,"rodEtMs":0},{"id":2,"cnt":6,"rid":0,"rodEtMs":0},{"id":3,"cnt":3,"rid":0,"rodEtMs":0},{"id":4,"cnt":2,"rid":0,"rodEtMs":0},{"id":5,"cnt":1,"rid":0,"rodEtMs":0}],"seats":[],"baits":[{"id":1,"cnt":1150,"inUse":1},{"id":2,"cnt":200,"inUse":0}],"fishing":{"stat":0,"autoCnt":0,"castBait":0,"fishStMs":0,"fishEtMs":0,"timePerRod":60}}}`

/**
 * `POST …/fishing/fishing`'s own response — `bodies/act/9b1c9083_…_fishing_fishing`, verbatim.
 *
 * Note what it carries and what it does not: `baits` and `fishing`, and **no `matchInfo` and no
 * `myCh`**. That is why the cast's answer has its own schema, and why the window and the 形象 can only
 * ever come from a panel read.
 */
const CAPTURED_CAST = `{"error":0,"msg":"success","data":{"baits":[{"id":1,"cnt":1130,"inUse":1},{"id":2,"cnt":200,"inUse":0}],"seats":[],"rods":[{"id":1,"cnt":4,"rid":0,"rodEtMs":0},{"id":2,"cnt":6,"rid":0,"rodEtMs":0},{"id":3,"cnt":3,"rid":0,"rodEtMs":0},{"id":4,"cnt":2,"rid":0,"rodEtMs":0},{"id":5,"cnt":1,"rid":0,"rodEtMs":0}],"fishing":{"stat":1,"autoCnt":0,"castBait":1,"fishStMs":1791452986292,"fishEtMs":1791453046292,"timePerRod":60}}}`

/** `homePage` of 17:49:46.148 — `bodies/act/b37121ac_…`: the same cast's line, read from the panel. */
const CAPTURED_IN_PROGRESS = `{"error":0,"msg":"success","data":{"timeMs":1791452986428,"matchInfo":{"stat":1,"hour":17,"st":1791453600,"et":1791457200,"left":614,"lhour":0},"myCh":{"uid":456918967,"rid":12306,"ctype":2,"clv":4,"exp":1731,"buffs":{"gain":1.2,"fishLv":[4,5]},"wear":1,"time":1761841287},"rods":[{"id":1,"cnt":4,"rid":0,"rodEtMs":0},{"id":2,"cnt":6,"rid":0,"rodEtMs":0},{"id":3,"cnt":3,"rid":0,"rodEtMs":0},{"id":4,"cnt":2,"rid":0,"rodEtMs":0},{"id":5,"cnt":1,"rid":0,"rodEtMs":0}],"seats":[],"baits":[{"id":1,"cnt":1130,"inUse":1},{"id":2,"cnt":200,"inUse":0}],"fishing":{"stat":1,"autoCnt":0,"castBait":1,"fishStMs":1791452986292,"fishEtMs":1791453046292,"timePerRod":60}}}`

/** `homePage` of 17:50:48.287 — `bodies/act/3649aca9_…`: `stat` 2, the fish is ready to come in. */
const CAPTURED_READY = `{"error":0,"msg":"success","data":{"timeMs":1791453048570,"matchInfo":{"stat":1,"hour":17,"st":1791453600,"et":1791457200,"left":552,"lhour":0},"myCh":{"uid":456918967,"rid":12306,"ctype":2,"clv":4,"exp":1731,"buffs":{"gain":1.2,"fishLv":[4,5]},"wear":1,"time":1761841287},"rods":[{"id":1,"cnt":4,"rid":0,"rodEtMs":0},{"id":2,"cnt":6,"rid":0,"rodEtMs":0},{"id":3,"cnt":3,"rid":0,"rodEtMs":0},{"id":4,"cnt":2,"rid":0,"rodEtMs":0},{"id":5,"cnt":1,"rid":0,"rodEtMs":0}],"seats":[],"baits":[{"id":1,"cnt":1130,"inUse":1},{"id":2,"cnt":200,"inUse":0}],"fishing":{"stat":2,"autoCnt":0,"castBait":1,"fishStMs":0,"fishEtMs":0,"timePerRod":60}}}`

/** `homePage` of 17:50:53.023 — `bodies/act/5088fdb3_…`: back to `stat` 0 after the reel-in. */
const CAPTURED_REELED = `{"error":0,"msg":"success","data":{"timeMs":1791453053023,"matchInfo":{"stat":1,"hour":17,"st":1791453600,"et":1791457200,"left":548,"lhour":0},"myCh":{"uid":456918967,"rid":12306,"ctype":2,"clv":4,"exp":1732,"buffs":{"gain":1.2,"fishLv":[4,5]},"wear":1,"time":1761841287},"rods":[{"id":1,"cnt":4,"rid":0,"rodEtMs":0},{"id":2,"cnt":6,"rid":0,"rodEtMs":0},{"id":3,"cnt":3,"rid":0,"rodEtMs":0},{"id":4,"cnt":2,"rid":0,"rodEtMs":0},{"id":5,"cnt":1,"rid":0,"rodEtMs":0}],"seats":[],"baits":[{"id":1,"cnt":1130,"inUse":1},{"id":2,"cnt":200,"inUse":0}],"fishing":{"stat":0,"autoCnt":0,"castBait":1,"fishStMs":0,"fishEtMs":0,"timePerRod":60}}}`

/**
 * `POST …/fishing/reelIn`'s answer — `bodies/act/510fabbe_…`, verbatim: one fish and **no award**.
 *
 * `awards: []` is the one cycle this project has ever observed, and it is why nothing here promises a
 * reward. The cases that add an award row build one from the lottery's own captured item names, because
 * no award has ever arrived through this endpoint.
 */
const CAPTURED_REEL_IN = `{"error":0,"msg":"success","data":{"fish":{"id":11,"wei":1,"t":1791453049},"awards":[]}}`

/* ------------------------------------------------------------------ *
 * The stub
 * ------------------------------------------------------------------ */

interface Recorded {
  readonly path: string
  readonly search: string
  readonly method: string
  readonly headers: readonly string[]
  readonly token: string | null
  readonly cookie: string | null
  readonly body: string
}

/** A scripted reply: an envelope, or — by rejecting — a call that never arrived. */
interface Scripted {
  readonly json?: unknown
  readonly text?: string
  readonly status?: number
  readonly setCookie?: string
  readonly unreachable?: boolean
}

/**
 * What each endpoint answers on this run. Panels and casts are **queues**: their last entry answers
 * every further call, so a case scripts only the answers it is about.
 */
interface Script {
  badges: Scripted
  panels: Scripted[]
  casts: Scripted[]
  reel: Scripted
  /** The 图鉴: the read before the first cast, then the one after the last. */
  codex: Scripted[]
  chips: Scripted
}

const requests: Recorded[] = []
let script: Script
let logs: string[]

/** One scripted entry, taken in order and then repeated. */
function next(list: Scripted[], what: string): Scripted {
  const answer = list.length > 1 ? list.shift() : list[0]
  if (answer === undefined) throw new Error(`this case scripted no ${what}`)
  return answer
}

async function fetchStub(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input.toString()
  const headers = new Headers(init?.headers ?? {})
  const parsed = new URL(url)

  requests.push({
    path: parsed.pathname,
    search: parsed.search,
    method: init?.method ?? 'GET',
    headers: [...headers.keys()].sort(),
    token: headers.get('token'),
    cookie: headers.get('cookie'),
    body: typeof init?.body === 'string' ? init.body : ''
  })

  const badges = parsed.pathname === BADGES_PATH
  const answer = badges
    ? script.badges
    : parsed.pathname === HOME_PATH
      ? next(script.panels, 'panel')
      : parsed.pathname === CAST_PATH
        ? next(script.casts, 'cast')
        : parsed.pathname === REEL_PATH
          ? script.reel
          : parsed.pathname === CODEX_PATH
            ? next(script.codex, '图鉴')
            : parsed.pathname === CHIPS_PATH
              ? script.chips
              : throwUnscripted(parsed.pathname)

  if (answer.unreachable === true) throw new TypeError('fetch failed')

  const responseHeaders = new Headers({
    'content-type': badges ? 'text/html; charset=UTF-8' : 'application/json;charset=UTF-8'
  })
  if (answer.setCookie !== undefined) responseHeaders.set('set-cookie', answer.setCookie)

  return new Response(badges ? (script.badges.text ?? BADGE_TABLE) : JSON.stringify(answer.json ?? {}), {
    status: answer.status ?? 200,
    headers: responseHeaders
  })
}

/** A path this case did not script is a mistake in the case, not a platform answer. */
function throwUnscripted(path: string): never {
  throw new Error(`unscripted request to ${path}`)
}

/**
 * One captured body with the fields a case needs moved, and nothing else touched.
 *
 * Written as a mutation of the parsed capture rather than as a hand-built payload, because a fixture
 * retyped by hand tests the author's idea of the payload.
 */
function moved(body: string | unknown, change: (data: Record<string, unknown>) => void): unknown {
  const envelope = (typeof body === 'string' ? JSON.parse(body) : body) as { data: Record<string, unknown> }
  change(envelope.data)
  return envelope
}

/** One body's `fishing` block, for a case that has to move a field inside it. */
function fishingOf(data: Record<string, unknown>): Record<string, unknown> {
  return data['fishing'] as Record<string, unknown>
}

/** One body's bait rows, for a case that has to move a stock or an `inUse`. */
function baitsOf(data: Record<string, unknown>): Record<string, unknown>[] {
  return data['baits'] as Record<string, unknown>[]
}

/**
 * A captured panel with `stat` set, and `fishEtMs` set to an instant **just past**.
 *
 * The two are linked because that is what the service does: `stat: 1` comes with the instant the fish
 * lands, and the other two come with `0`. The captured instant (1791453046292 = 17:50:46 +08) is an
 * absolute one, so waiting to it is a no-op for any clock after that moment and a 61-second sleep for
 * any clock before it — and a suite may not depend on which side of a date it runs on. The one case
 * that wants a real sleep moves the instant out by 60 ms itself.
 */
function atState(body: string, stat: number, instantMs: number = Date.now() - 1000): unknown {
  return moved(body, data => {
    const fishing = fishingOf(data)
    fishing['stat'] = stat
    fishing['fishEtMs'] = stat === 1 ? instantMs : 0
  })
}

/** A panel whose in-use bait has this much stock, everything else captured. */
function atStock(body: string | unknown, cnt: number): unknown {
  return moved(body, data => {
    const [bait] = baitsOf(data)
    if (bait !== undefined) bait['cnt'] = cnt
  })
}

/** What the window says, moved: `st`/`et` are epoch seconds the panel itself hands out per match. */
function atWindow(body: string | unknown, st: number, et: number): unknown {
  return moved(body, data => {
    const match = data['matchInfo'] as Record<string, unknown>
    match['st'] = st
    match['et'] = et
  })
}

/** The captured 图鉴 with one species' `firstLight` set — the only way a species is registered. */
function codexWith(fishId: number, firstLight: number): unknown {
  return moved(CAPTURED_CODEX, data => {
    const entries = data['accList'] as Record<string, unknown>[]
    for (const entry of entries) {
      if (entry['fishId'] === fishId) entry['firstLight'] = firstLight
    }
  })
}

/**
 * Several complete cycles' reads and casts, laid out exactly as the run makes them.
 *
 * **The first round costs three reads and every later round two**, which is worth pinning here rather
 * than discovering by a queue that drifts: a round ends by reading the panel after its reel-in, and
 * that read is the next round's own panel — so the second cast's pre-cast reading is the first cast's
 * post-reel reading, and the stock it reports is the one the first cast left.
 */
function cycles(count: number): { readonly panels: Scripted[]; readonly casts: Scripted[] } {
  const panels: Scripted[] = []
  const casts: Scripted[] = []
  let stock = 1150

  for (let index = 0; index < count; index += 1) {
    if (index === 0) panels.push({ json: atStock(atState(CAPTURED_IDLE, 0), stock) })
    casts.push({ json: atStock(atState(CAPTURED_CAST, 1), stock - 20) })
    panels.push({ json: atStock(atState(CAPTURED_READY, 2), stock - 20) })
    panels.push({ json: atStock(atState(CAPTURED_REELED, 0), stock - 20) })
    stock -= 20
  }

  return { panels, casts }
}

function freshScript(): Script {
  return {
    badges: { setCookie: `acf_ccn=${MINTED_CCN}; expires=Wed, 07-Oct-2026 18:59:19 GMT; Max-Age=7200; path=/` },
    // The cycle's three reads, in the order the action makes them: before the cast, after the wait,
    // and after the reel-in.
    panels: [
      { json: atState(CAPTURED_IDLE, 0) },
      { json: atState(CAPTURED_READY, 2) },
      { json: atState(CAPTURED_REELED, 0) }
    ],
    casts: [{ json: atState(CAPTURED_CAST, 1) }],
    reel: { json: JSON.parse(CAPTURED_REEL_IN) },
    // The same 图鉴 on both sides of the run: a default with no species moving, so a case that wants a
    // new one says so itself.
    codex: [{ json: JSON.parse(CAPTURED_CODEX) }, { json: JSON.parse(CAPTURED_CODEX) }],
    chips: { json: JSON.parse(CAPTURED_CHIPS) }
  }
}

beforeEach(() => {
  requests.length = 0
  logs = []
  script = freshScript()
  vi.stubGlobal('fetch', fetchStub)
})

/* ------------------------------------------------------------------ *
 * Driving one run
 * ------------------------------------------------------------------ */

function account(webCookies = WEB_COOKIES): PlatformAccount {
  const blob: Record<string, string> = { token: TOKEN, did: DID }
  // The binder omits the field entirely when there is no session, which is what this account's blob
  // looks like today.
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

async function run(
  options: Record<string, unknown> = {},
  targetKey = ROOM,
  now = INSIDE_WINDOW,
  client = account()
): Promise<ActionOutcome> {
  const outcomes = await douyuPlatform.reconcile({
    account: client,
    targetKey,
    enabledActions: [ActionKey.Fishing],
    options: { [ActionKey.Fishing]: options },
    now,
    dayKey: '2026-10-08',
    log: line => logs.push(line)
  })

  const found = outcomes.find(outcome => outcome.actionKey === ActionKey.Fishing)
  if (found === undefined) throw new Error('no outcome for fishing')
  return found
}

/** Every request whose path is this one. */
function sentTo(path: string): Recorded[] {
  return requests.filter(recorded => recorded.path === path)
}

/** The order the run touched these four endpoints in, as one line a failure can be read off. */
function walked(): string[] {
  return requests.map(recorded => recorded.path)
}

/** One request's form body, as the service would read it. */
function formOf(recorded: Recorded): URLSearchParams {
  return new URLSearchParams(recorded.body)
}

/** Every value one request carried under a cookie name — a list, because the count is the assertion. */
function cookiesIn(recorded: Recorded, name: string): string[] {
  return (recorded.cookie ?? '')
    .split(';')
    .map(part => part.trim())
    .filter(part => part.startsWith(`${name}=`))
    .map(part => part.slice(name.length + 1))
}

/* ------------------------------------------------------------------ *
 * The cycle
 * ------------------------------------------------------------------ */

describe('the 钓鱼 cycle', () => {
  it('reads the panel, casts, waits for the instant the panel named, and reels the fish in', async () => {
    const outcome = await run()

    // The order *is* the chore: a read first (it is what the window, the 形象 and the bait come from),
    // the 图鉴 before the first cast (the baseline a species is judged against), the cast, a read to see
    // the transition the wait was for, the reel-in, one more read so the next round starts from what the
    // Platform says — and then the two summary reads on the way out.
    expect(walked()).toEqual([
      BADGES_PATH,
      HOME_PATH,
      CODEX_PATH,
      CAST_PATH,
      HOME_PATH,
      REEL_PATH,
      HOME_PATH,
      CODEX_PATH,
      CHIPS_PATH
    ])

    const read = sentTo(HOME_PATH)[0]
    expect(read?.method).toBe('GET')
    expect(read?.search).toBe('?rid=12306&opt=0')
    // The reads carry no `ctn` and no body: nothing here mints a value to read with.
    expect(read?.body).toBe('')
    expect(read?.headers).toEqual(['accept', 'accept-language', 'cookie', 'referer', 'token', 'user-agent'])

    // The 图鉴 read, with the query the capture and the reference implementation both send.
    const codex = sentTo(CODEX_PATH)[0]
    expect(codex?.method).toBe('GET')
    expect(codex?.search).toBe('?rid=12306&type=1&period=1')
    expect(codex?.body).toBe('')

    // The chips panel, read and **not** spent: buying draws is another action's decision.
    const chips = sentTo(CHIPS_PATH)[0]
    expect(chips?.method).toBe('GET')
    expect(chips?.search).toBe('?rid=12306')

    const cast = sentTo(CAST_PATH)[0]
    if (cast === undefined) throw new Error('the run cast no line')
    expect(cast.method).toBe('POST')
    expect(cast.token).toBe(TOKEN)
    // Verbatim, in the capture's own field order.
    expect(formOf(cast).get('rid')).toBe(ROOM)
    expect(formOf(cast).get('baitId')).toBe('1')
    expect(formOf(cast).get('ver')).toBe('1.1')
    expect(formOf(cast).get('ctn')).toBe(MINTED_CCN)
    // …and the same value in this request's own cookie header, **once**: the jar's copy of `acf_ccn` is
    // replaced rather than joined, because a header carrying two candidates for one field is what the
    // adjacent family's CSRF layer compares. The value is the one the badge read just minted, not the
    // stale one the stored session holds.
    expect(cookiesIn(cast, 'acf_ccn')).toEqual([MINTED_CCN])
    expect(cookiesIn(cast, 'acf_auth')).toEqual(['1_1_abcdef'])

    const reel = sentTo(REEL_PATH)[0]
    if (reel === undefined) throw new Error('the run reeled nothing in')
    // `reelIn` carries only `ctn` and `rid`: the bait was spent by the cast.
    expect(reel.body).toMatch(/^ctn=[0-9a-f]{32}&rid=12306$/)
    expect(reel.headers).toEqual([
      'accept',
      'accept-language',
      'content-type',
      'cookie',
      'referer',
      'token',
      'user-agent'
    ])

    // `done`, and that is not decoration: `runner.ts` settles an action's day on `done`, which is what
    // makes 「钓几次」 a per-day count rather than a per-sweep one. The last three clauses are the run's
    // own account of what it was worth: the window the panel reported (which is what tells a person
    // when to come back), the 图鉴 it left behind, and the chips it did not spend.
    expect(outcome).toMatchObject({
      outcome: 'done',
      failure: 'none',
      detail: `收竿 1 竿、消耗鱼饵 20 枚（共 1 竿）；服务端报的钓鱼窗口 18:00–19:00（matchInfo.stat 1）；${CODEX_LINE}；${CHIPS_LINE}`
    })

    // The row a person reads: the anchor's name, the fish's weight and species, and no identifier. The
    // species clause is the **pre-cast** codex's answer — whether this cast is what registered it is the
    // record's job, and it says so above. The fish's id is in the console line instead.
    expect(outcome.items).toEqual([
      { kind: 'room', label: '电棍', outcome: 'done', detail: '收竿、重 1 斤、小龙虾（图鉴未收录）', code: '0' }
    ])
    expect(outcome.detail).not.toContain('11')

    // The first line is the CSRF value's provenance, and it names this action rather than 粉丝家园:
    // two actions read this same wall for this same value now, and a line naming the wrong one would
    // send its reader to the wrong action's report.
    expect(logs[0]).toBe('钓鱼：读粉丝牌这次下发了 acf_ccn，本次请求带的 CSRF 值取自它，长度 32')
    expect(logs[0]).not.toContain(MINTED_CCN)
    expect(logs[1]).toBe('钓鱼「电棍（房间 12306）」：抛竿（在用鱼饵 1，抛前 1150 枚）')
    expect(logs[2]).toBe('钓鱼「电棍（房间 12306）」：收竿，鱼 11、重 1 斤、小龙虾（图鉴未收录）')
    // The credential is the whole account, and every one of these strings is written to a row.
    for (const line of logs) expect(line).not.toContain(TOKEN)
    expect(outcome.detail).not.toContain(TOKEN)
  })

  it('reports the 图鉴 moving, because that is the run’s durable output', async () => {
    // The captured pair this run is built from: the codex before the cast lists 35 species with 泥鳅 the
    // only one registered, and the very fish the reel-in answers is 小龙虾 — `fishId: 11`, unregistered.
    // The read after the run is the same list with that species lit, which is what 「新增」 means here:
    // a difference between two readings, and not a claim made from one.
    script.codex = [{ json: JSON.parse(CAPTURED_CODEX) }, { json: codexWith(11, 1_791_454_100) }]

    const outcome = await run()

    expect(outcome).toMatchObject({ outcome: 'done' })
    // Two registered species after the run — 泥鳅 was the one before it — and the name of what moved.
    expect(outcome.detail).toContain('图鉴 35 种、已收录 2 种（本次新增 小龙虾）')
    // The item still says what the *pre-cast* codex said, so the row and the record cannot disagree
    // about the same species: the row reports the baseline, the record reports the movement.
    expect(outcome.items[0]?.detail).toBe('收竿、重 1 斤、小龙虾（图鉴未收录）')
  })

  it('says it could not tell what moved when one of the two 图鉴 reads is missing', async () => {
    script.codex = [{ unreachable: true }, { json: JSON.parse(CAPTURED_CODEX) }]

    const outcome = await run()

    // One read on its own cannot say what this run changed, and the line says exactly that rather than
    // comparing against nothing.
    expect(outcome.outcome).toBe('done')
    expect(outcome.detail).toContain(`${CODEX_LINE}（这次没读到上一条，看不出本次新增）`)
    // The row loses its species clause, because there was no baseline to read one from.
    expect(outcome.items[0]?.detail).toBe('收竿、重 1 斤')
  })

  it('never lets a read it only wanted for reporting fail the run', async () => {
    // Both auxiliary reads fail; the cast and the reel-in succeeded, and that is what the day is about.
    // Grading these `retry` would leave the day unsettled and the next sweep would spend another 20 bait
    // to learn what this one already knew.
    script.codex = [{ unreachable: true }, { unreachable: true }]
    script.chips = { unreachable: true }

    const outcome = await run()

    expect(outcome).toMatchObject({ outcome: 'done', failure: 'none' })
    expect(outcome.items).toHaveLength(1)
    expect(outcome.items[0]?.outcome).toBe('done')
    expect(outcome.detail).toContain('收竿 1 竿')
    expect(outcome.detail).not.toContain('图鉴')
    expect(outcome.detail).not.toContain('抽奖')
    expect(logs[1]).toBe('钓鱼「电棍（房间 12306）」：图鉴这次没读到，这一轮钓到的鱼照报')
  })

  it('does not spend a request on a summary for a run that never cast', async () => {
    script.panels = [{ json: moved(CAPTURED_IDLE, data => (data['myCh'] = null)) }]

    const outcome = await run()

    // No 形象, so nothing was cast and nothing is worth summarising: the two auxiliary reads are
    // skipped, and the badge wall is the only other request the run made.
    expect(sentTo(CODEX_PATH)).toEqual([])
    expect(sentTo(CHIPS_PATH)).toEqual([])
    expect(sentTo(HOME_PATH)).toHaveLength(1)
    expect(outcome.outcome).toBe('blocked')
  })

  it('costs 20 bait, measured between the read nearest the cast and the cast’s own answer', async () => {
    // The trap this project paid for four times: the two readings have to bracket the cast. The panel
    // read *before* it says 1150, the cast's own response says 1130, and the difference is the price.
    // The fixtures are the capture's own numbers, so this is the arithmetic that produced "20".
    const outcome = await run()

    expect(sentTo(CAST_PATH)).toHaveLength(1)
    expect(outcome.detail).toContain('消耗鱼饵 20 枚')

    // …and `castBait` — 0 in the panel above and 1 in the cast's response — is not that number. It is
    // modelled nowhere in this build, which is how the misreading is closed structurally.
    const cast = sentTo(CAST_PATH)[0]
    expect(cast?.body).not.toContain('castBait')
  })

  it('counts a run of several casts, subtracting each one’s own pair of readings', async () => {
    const scripted = cycles(2)
    script.panels = scripted.panels
    script.casts = scripted.casts

    const outcome = await run({ casts: 2 })

    expect(sentTo(CAST_PATH)).toHaveLength(2)
    expect(sentTo(REEL_PATH)).toHaveLength(2)
    // One 图鉴 on each side of the whole run, whatever the number of casts: the delta is about the run,
    // not about a cast.
    expect(sentTo(CODEX_PATH)).toHaveLength(2)
    expect(sentTo(CHIPS_PATH)).toHaveLength(1)
    expect(outcome).toMatchObject({ outcome: 'done' })
    expect(outcome.detail).toContain('收竿 2 竿、消耗鱼饵 40 枚（共 2 竿）')
    expect(outcome.items).toHaveLength(2)
    expect(outcome.items.every(item => item.outcome === 'done')).toBe(true)
    // The second cast was measured against the stock the first one left, not against the run's start.
    expect(formOf(sentTo(CAST_PATH)[1] as Recorded).get('baitId')).toBe('1')
  })

  it('never exceeds its own ceiling on 钓几次, however large the option is', async () => {
    const scripted = cycles(12)
    script.panels = scripted.panels
    script.casts = scripted.casts

    const outcome = await run({ casts: 999 })

    // Ten casts is 200 bait at the measured price. The ceiling is this adapter's own guard against a
    // stray digit in a number a person types; the panel's stock is the bound underneath it.
    expect(sentTo(CAST_PATH)).toHaveLength(10)
    expect(outcome.detail).toContain('（共 10 竿）')
  })

  it('reads 钓几次 as a number and refuses everything it cannot read', async () => {
    // Fail-closed in the only direction that spends: an option nobody could read buys one cast, not
    // many. Each of these is a value a form or a hand-written API call can produce.
    for (const casts of ['abc', 0, -3, 1.5, null, ['1']]) {
      requests.length = 0
      script = freshScript()

      const outcome = await run({ casts })

      expect(sentTo(CAST_PATH)).toHaveLength(1)
      expect(outcome.detail).toContain('（共 1 竿）')
    }
  })

  it('reads 钓几次 out of a string as well, because the seam stores what the client sent', async () => {
    const scripted = cycles(2)
    script.panels = scripted.panels
    script.casts = scripted.casts

    const outcome = await run({ casts: '2' })

    expect(sentTo(CAST_PATH)).toHaveLength(2)
    expect(outcome.detail).toContain('（共 2 竿）')
  })

  it('reels an earlier cast’s fish in before casting anything of its own', async () => {
    // `stat: 2` is 「上一次没收杆」 — a fish on the line from a run that stopped early. It is reeled
    // first, which is also the branch `1001007` needs. Both reads before the cast carry 1150, because
    // the reading a cost is measured from is the one **nearest** the cast — and reeling spends nothing,
    // so the read after a reel-in is still that reading. The captured `3649aca9` panel reads 1130,
    // because it was taken after the cast whose cost this run is measuring.
    script.panels = [
      { json: atStock(atState(CAPTURED_READY, 2), 1150) },
      { json: atStock(atState(CAPTURED_REELED, 0), 1150) },
      { json: atStock(atState(CAPTURED_READY, 2), 1130) },
      { json: atStock(atState(CAPTURED_REELED, 0), 1130) }
    ]

    const outcome = await run()

    expect(walked()).toEqual([
      BADGES_PATH,
      HOME_PATH,
      CODEX_PATH,
      REEL_PATH,
      HOME_PATH,
      CAST_PATH,
      HOME_PATH,
      REEL_PATH,
      HOME_PATH,
      CODEX_PATH,
      CHIPS_PATH
    ])
    expect(outcome).toMatchObject({ outcome: 'done' })
    expect(outcome.detail).toContain('收竿 2 竿、消耗鱼饵 20 枚（共 1 竿）')
    // Two fish in, one cast spent: reeling is free, and the fixture's only cast is the one that cost.
    expect(outcome.items).toHaveLength(2)
  })

  it('waits to the instant the cast itself named, and no longer', async () => {
    // The one case that really sleeps, and it sleeps 60 ms because that is what the fixture's
    // `fishEtMs` says. A constant of this module's own would be `timePerRod` — 60 **seconds** — so the
    // upper bound here is what proves the wait is the platform's instant and not a guess.
    script.casts = [{ json: atState(CAPTURED_CAST, 1, Date.now() + 60) }]

    const started = Date.now()
    const outcome = await run()
    const elapsed = Date.now() - started

    expect(outcome.outcome).toBe('done')
    expect(elapsed).toBeGreaterThanOrEqual(50)
    expect(elapsed).toBeLessThan(5_000)
  })
  it('never reports an outcome its own items disagree with', async () => {
    // The seam's one invariant, asserted as a relation rather than per case: an item that contradicts
    // the record it sits inside is worse than no item at all, and one of the five verdicts below is
    // produced by a path a per-case assertion would not have reached.
    const closed = await run({}, ROOM, BEFORE_WINDOW)
    expect(closed.items.map(item => item.outcome)).toContain(closed.outcome)

    requests.length = 0
    script = freshScript()
    script.panels = [{ json: atStock(atState(CAPTURED_IDLE, 0), 4) }]
    const short = await run()
    expect(short.items.length).toBeGreaterThan(0)
    expect(short.items.map(item => item.outcome)).toContain(short.outcome)

    requests.length = 0
    script = freshScript()
    script.casts = [{ unreachable: true }]
    const broken = await run()
    expect(broken.items.map(item => item.outcome)).toContain(broken.outcome)

    requests.length = 0
    script = freshScript()
    const fished = await run()
    expect(fished.items).toHaveLength(1)
    expect(fished.items.map(item => item.outcome)).toContain(fished.outcome)
  })
})

/* ------------------------------------------------------------------ *
 * The refused and unknown states
 * ------------------------------------------------------------------ */

describe('what 钓鱼 refuses to do', () => {
  it('sends the cast at the instant the capture sent it, 614 s before the window the panel reports', async () => {
    // The measurement this case exists for. The panel reports `st` 1791453600 (18:00) / `et`
    // 1791457200 (19:00), and the captured cast went out at 17:49:45.958 — 614.042 s before `st` — and was
    // answered `error: 0`, spent 20 bait (1150 → 1130) and its reel-in moved `myCh.exp` 1731 → 1732.
    // A cast outside the window is accepted and pays, so the window is not what licenses a cast: the
    // service's own answer is, and `blocked` is recorded only when the service refuses.
    const outcome = await run({}, ROOM, CAPTURED_CAST_AT)

    expect(sentTo(CAST_PATH)).toHaveLength(1)
    expect(sentTo(REEL_PATH)).toHaveLength(1)
    expect(outcome).toMatchObject({ outcome: 'done', failure: 'none' })

    // …and the window is still read, because it is what tells a person when to come back and settle.
    // That is now its whole job.
    expect(outcome.detail).toContain('钓鱼窗口 18:00–19:00')
  })

  it('keeps the capture’s own instant for that cast, whose gap to `st` is 614 s and not 615', () => {
    // The boundary, in the one place both halves of the fact can be checked at once: the fixture's
    // instant and the number the description prints are the same measurement, so a truncation of one
    // has to fail here rather than silently become a wrong sentence a person reads.
    const ST_MS = 1_791_453_600_000
    expect(CAPTURED_CAST_AT).toBe(1_791_452_985_958)
    expect((ST_MS - CAPTURED_CAST_AT) / 1000).toBeCloseTo(614.042, 3)
    expect(Math.floor((ST_MS - CAPTURED_CAST_AT) / 1000)).toBe(614)

    // …and this is the truncation the number used to inherit: a whole-second 17:49:45 is 615 s short
    // of `st`, which is where 「开窗前 615 秒」 came from. Kept as a stated arithmetic fact so the next
    // reader can see the two candidate numbers and why one of them is wrong.
    expect(ST_MS - 1_791_452_985_000).toBe(615_000)

    // The sentence read *before* the switch is flipped carries the measured number, and nothing in it
    // says 615 — the strings are the ones `platform/douyu/index.ts` ships.
    const fishing = douyuPlatform.actions.find(action => action.key === ActionKey.Fishing)
    expect(fishing?.description).toContain('开窗前 614 秒')
    expect(fishing?.description).not.toContain('615')
  })

  it('reads the window instead of knowing it: a different match prints its own hours', async () => {
    // 12:00–24:00 on 2026-10-07 (`st` 1791432000 / `et` 1791475200, the older capture's own numbers).
    // A build that hardcoded the hour — or the twelve-hour window — would print the wrong one here.
    // The end prints as `00:00` and that is the Platform's own clock, not a rounding: `et` is an
    // instant, and midnight is hour `0` on the 0–23 clock the panel itself reports `hour` in.
    script.panels = [
      { json: atWindow(atState(CAPTURED_IDLE, 0), 1_791_432_000, 1_791_475_200) },
      { json: atWindow(atState(CAPTURED_READY, 2), 1_791_432_000, 1_791_475_200) },
      { json: atWindow(atState(CAPTURED_REELED, 0), 1_791_432_000, 1_791_475_200) }
    ]

    const outcome = await run({}, ROOM, BEFORE_WINDOW)

    expect(sentTo(CAST_PATH)).toHaveLength(1)
    expect(outcome.outcome).toBe('done')
    expect(outcome.detail).toContain('钓鱼窗口 12:00–00:00')
  })

  it('casts when the panel states no window at all, and reports that it stated none', async () => {
    // `st`/`et` of `0` is a panel nobody has seen either, so the record says what the panel said
    // instead of guessing an hour — and it is a report, not a gate: the cast is still sent.
    script.panels = [
      { json: atWindow(atState(CAPTURED_IDLE, 0), 0, 0) },
      { json: atWindow(atState(CAPTURED_READY, 2), 0, 0) },
      { json: atWindow(atState(CAPTURED_REELED, 0), 0, 0) }
    ]

    const outcome = await run()

    expect(sentTo(CAST_PATH)).toHaveLength(1)
    expect(outcome.outcome).toBe('done')
    expect(outcome.detail).toContain('服务端本次没有报钓鱼窗口')
  })

  it('does not cast for a room whose 形象 is not set, and says it will not set one', async () => {
    script.panels = [{ json: moved(CAPTURED_IDLE, data => (data['myCh'] = null)) }]

    const outcome = await run()

    expect(sentTo(CAST_PATH)).toEqual([])
    expect(sentTo(REEL_PATH)).toEqual([])
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_character', failure: 'action_stop' })
    expect(outcome.detail).toContain('还没有设置形象')
    // The remedy is named as the thing this build will not do, because there is no endpoint here that
    // could: the 形象 is chosen in 粉丝家园's own interface.
    expect(outcome.detail).toContain('粉丝家园')
    expect(outcome.items).toHaveLength(1)
  })

  it('does not cast when no bait is marked as in use', async () => {
    script.panels = [
      {
        json: moved(CAPTURED_IDLE, data => {
          for (const bait of baitsOf(data)) bait['inUse'] = 0
        })
      }
    ]

    const outcome = await run()

    expect(sentTo(CAST_PATH)).toEqual([])
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_bait', failure: 'action_stop' })
    expect(outcome.detail).toContain('「在用」的鱼饵')
  })

  it('stops by the panel’s own stock rather than spending a request to be refused', async () => {
    // 4 bait against a cast that costs 20: the panel has already answered the question, so the cast
    // that would be refused is not sent.
    script.panels = [{ json: atStock(atState(CAPTURED_IDLE, 0), 4) }]

    const outcome = await run()

    expect(sentTo(CAST_PATH)).toEqual([])
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'bait_low', failure: 'action_stop' })
    expect(outcome.detail).toContain('只剩 4 枚')
    expect(outcome.detail).toContain('20 枚')
  })

  it('does not settle the day when the bait ran out after a fish came in', async () => {
    // The combination no case covered: one cast reeled in, and then the shortfall. `done` used to
    // outrank the halt here, and that made `bait_low`'s own sentence — 补上鱼饵之后这个动作会自己继续 —
    // false: `runner.ts` counts `done` as the day being met, so the continuation was the next *platform*
    // day, and the 动作受阻 the same sentence promises was never raised either. A halt is the one thing
    // that must keep the sweep coming back, so it outranks a finished round; the counts stay on the line.
    const scripted = cycles(1)
    script.panels = [...scripted.panels.slice(0, 2), { json: atStock(atState(CAPTURED_REELED, 0), 4) }]
    script.casts = scripted.casts

    const outcome = await run({ casts: 2 })

    expect(sentTo(CAST_PATH)).toHaveLength(1)
    expect(sentTo(REEL_PATH)).toHaveLength(1)
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'bait_low', failure: 'action_stop' })
    expect(outcome.detail).toContain('收竿 1 竿')
    expect(outcome.detail).toContain('只剩 4 枚')
  })

  it('treats the service’s own 1005003 as running out, not as something to retry', async () => {
    script.casts = [{ json: { error: FISHING_BAIT_EXHAUSTED, msg: '鱼饵不足' } }]

    const outcome = await run()

    expect(sentTo(REEL_PATH)).toEqual([])
    // `blocked` rather than a settled outcome: bait can be re-stocked the same day (the lottery hands
    // it out), and 动作受阻 is how whoever is looking finds out that it ran out.
    expect(outcome).toMatchObject({ outcome: 'blocked', code: '1005003', failure: 'action_stop' })
    expect(outcome.detail).toContain('鱼饵不足')
  })

  it('reels first and casts again when a cast answers 1001007', async () => {
    // 「操作失败」 means a fish is already on the line — the reference implementation's branch, and the
    // only reading of it that acts. A refused cast is not a cast that went out, so nothing is spent and
    // nothing is measured from it: the run's 20 bait comes from the one cast that succeeded.
    script.casts = [{ json: { error: FISHING_FISH_ON_THE_LINE, msg: '操作失败' } }, { json: atState(CAPTURED_CAST, 1) }]
    script.panels = [
      { json: atState(CAPTURED_IDLE, 0) },
      { json: atState(CAPTURED_READY, 2) },
      { json: atState(CAPTURED_REELED, 0) }
    ]

    const outcome = await run()

    expect(walked()).toEqual([
      BADGES_PATH,
      HOME_PATH,
      CODEX_PATH,
      CAST_PATH,
      REEL_PATH,
      CAST_PATH,
      HOME_PATH,
      REEL_PATH,
      HOME_PATH,
      CODEX_PATH,
      CHIPS_PATH
    ])
    expect(outcome).toMatchObject({ outcome: 'done' })
    expect(outcome.detail).toContain('收竿 2 竿、消耗鱼饵 20 枚（共 1 竿）')
    expect(logs.some(line => line.includes('1001007'))).toBe(true)
  })

  it('reports the second 1001007 instead of casting a third time', async () => {
    script.casts = [
      { json: { error: FISHING_FISH_ON_THE_LINE, msg: '操作失败' } },
      { json: { error: FISHING_FISH_ON_THE_LINE, msg: '操作失败' } }
    ]
    script.panels = [{ json: atState(CAPTURED_IDLE, 0) }, { json: atState(CAPTURED_REELED, 0) }]

    const outcome = await run()

    expect(sentTo(CAST_PATH)).toHaveLength(2)
    // `retry`, not a park: `1001007` is a generic failure on this Platform and the state it reports is
    // one a later sweep can find changed.
    expect(outcome).toMatchObject({ outcome: 'failed', code: '1001007', failure: 'retry' })
  })

  it('does not reel when the panel never reaches 可收竿 after the cast', async () => {
    // The panel reads keep saying 「钓中」 — a state the capture does have (`b37121ac`), so it is the
    // service's own shape rather than an invented one. It is reported rather than waited out, and the
    // waits are bounded: three reads after the cast, and no fourth.
    script.casts = [{ json: atState(CAPTURED_CAST, 1) }]
    script.panels = [
      { json: atState(CAPTURED_IDLE, 0) },
      { json: atState(CAPTURED_IN_PROGRESS, 1) },
      { json: atState(CAPTURED_IN_PROGRESS, 1) },
      { json: atState(CAPTURED_IN_PROGRESS, 1) }
    ]

    const outcome = await run()

    expect(sentTo(REEL_PATH)).toEqual([])
    // Four reads: the one before the cast and the three the bounded wait allowed. `failure: 'none'`
    // because a fish that lands a beat later is still reeled in by the next sweep, which starts by
    // looking rather than casting.
    expect(sentTo(HOME_PATH)).toHaveLength(4)
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'unknown_fishing_stat', failure: 'none' })
  })

  it('reports a fishing state this build has no move for', async () => {
    script.panels = [{ json: atState(CAPTURED_IDLE, 7) }]

    const outcome = await run()

    expect(sentTo(CAST_PATH)).toEqual([])
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'unknown_fishing_stat', failure: 'none' })
    expect(outcome.detail).toContain('7')
  })

  it('grades a call that never arrived as retry, without throwing past reconcile', async () => {
    script.casts = [{ unreachable: true }]

    const outcome = await run()

    expect(outcome).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
    expect(outcome.detail).toContain('抛竿失败')
    expect(outcome.detail).not.toContain(TOKEN)
    expect(outcome.items[0]?.outcome).toBe('failed')
  })

  it('grades a failed reel-in without losing the cast that went out', async () => {
    script.reel = { unreachable: true }

    const outcome = await run()

    expect(sentTo(CAST_PATH)).toHaveLength(1)
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
    expect(outcome.detail).toContain('收竿失败')
  })

  it('sends nothing at all when the account has no web session', async () => {
    const outcome = await run({}, ROOM, INSIDE_WINDOW, account(''))

    // This family's writes carry `ctn`, which is the web session's own cookie, so a request without one
    // would be refused at the identity layer — a dead-token reading of a problem that is not the token.
    expect(requests).toEqual([])
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_web_session', failure: 'action_stop' })
    expect(outcome.detail).toContain('重新扫码绑定')
  })

  it('does not send when neither the read nor the session has a CSRF value', async () => {
    script.badges = {}
    const outcome = await run({}, ROOM, INSIDE_WINDOW, account(`acf_auth=1_1_abcdef; acf_did=${DID}`))

    expect(sentTo(CAST_PATH)).toEqual([])
    expect(sentTo(REEL_PATH)).toEqual([])
    // `blocked` rather than `failed`: a read mints this value, so another run may well have one, and
    // the message says what is *not* the problem — the session answered the wall a moment ago.
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'csrf_unavailable', failure: 'action_stop' })
    expect(outcome.detail).not.toContain('重新扫码绑定')
    expect(logs[0]).toBe('钓鱼：读粉丝牌这次没有下发 acf_ccn，网页会话里也没有，本次拿不到 CSRF 值')
  })

  it('fails a target that is not a room, and an account with no credential', async () => {
    const badTarget = await run({}, 'not-a-room')

    expect(badTarget).toMatchObject({
      outcome: 'failed',
      code: 'bad_target',
      failure: 'action_stop',
      targetKey: 'not-a-room'
    })
    expect(requests).toEqual([])

    requests.length = 0
    const noCredential = await run({}, ROOM, INSIDE_WINDOW, {
      ...account(),
      credentials: '{}'
    })

    expect(noCredential).toMatchObject({ outcome: 'failed', code: 'no_credential', failure: 'account_stop' })
    expect(requests).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * What a reel-in reports
 * ------------------------------------------------------------------ */

describe('what a reel-in reports', () => {
  it('reports no reward when the service sends none, and never promises one', async () => {
    const outcome = await run()

    // The capture's own answer is `awards: []`, so the row is the fish and nothing else: a figure here
    // would be one nobody has ever read. The assertion is about the **award clause** (`、奖 名字×数`)
    // and not about the word 奖, which the chips line carries legitimately — 抽奖 is another action.
    expect(outcome.items[0]?.detail).toBe('收竿、重 1 斤、小龙虾（图鉴未收录）')
    expect(outcome.detail).not.toMatch(/、奖 /)
  })

  it('reports an award when one arrives, in the Platform’s own words', async () => {
    // No award row has ever been captured through this endpoint, so this row is built from the
    // lottery's own captured item names and ids — the same award space, and the same 鱼丸.
    script.reel = {
      json: {
        error: 0,
        msg: 'success',
        data: {
          fish: { id: 11, wei: 1, t: 1_791_453_049 },
          awards: [{ awardType: 10002, awardId: 0, awardNum: 20, awardName: '鱼丸' }]
        }
      }
    }

    const outcome = await run()

    expect(outcome.items[0]?.detail).toBe('收竿、重 1 斤、小龙虾（图鉴未收录）、奖 鱼丸×20')
    expect(logs[2]).toBe('钓鱼「电棍（房间 12306）」：收竿，鱼 11、重 1 斤、小龙虾（图鉴未收录）、奖 鱼丸×20')
  })

  it('counts an award row it cannot read rather than losing the fish that came with it', async () => {
    // The field names are the reference implementation's expectation, not a measurement, so a
    // deployment that names them differently degrades to a count — the reel-in already happened and the
    // fish is in the account either way.
    script.reel = {
      json: { error: 0, msg: 'success', data: { fish: { id: 11, wei: 1 }, awards: [{ 未知: 1 }] } }
    }

    const outcome = await run()

    expect(outcome.items[0]?.detail).toBe('收竿、重 1 斤、小龙虾（图鉴未收录）、另附 1 项奖励（名字没读出来）')
    expect(outcome.outcome).toBe('done')
  })

  it('keeps the room’s id out of the row when the badge wall does not name it', async () => {
    // The medal is not a gate on this action, so a room the wall does not list is still fished — and it
    // is labelled 「未命名直播间」 rather than by its id, which is the one field an item may never carry.
    script.badges = {
      setCookie: `acf_ccn=${MINTED_CCN}; Max-Age=7200; path=/`,
      text: '<table class="aui_room_table fans-badge-list"><tbody><tr data-fans-room="99999" data-anchor_name="别人"><td>徽章</td></tr></tbody></table>'
    }

    const outcome = await run()

    expect(outcome.outcome).toBe('done')
    expect(outcome.items[0]).toMatchObject({ kind: 'room', label: '未命名直播间' })
    // The console keeps it, which is what tells two same-named anchors apart.
    expect(logs[1]).toBe('钓鱼「12306」：抛竿（在用鱼饵 1，抛前 1150 枚）')
  })
})

/* ------------------------------------------------------------------ *
 * The catalogue entry
 * ------------------------------------------------------------------ */

describe('the 钓鱼 catalogue entry', () => {
  it('is a costly per-Room Reconcile action, which is what keeps it dark until a person turns it on', () => {
    const descriptor = douyuPlatform.actions.find(action => action.key === ActionKey.Fishing)

    expect(descriptor).toMatchObject({
      key: 'fishing',
      action: 'reconcile',
      label: '粉丝家园钓鱼',
      costly: true,
      needsTarget: true,
      needsLibrary: false
    })
    // What a person reads *before* deciding, so the two figures are the measured ones: the bait a cast
    // spends, and the fact that the window is the service's own.
    expect(descriptor?.description).toContain('20 枚')
    expect(descriptor?.description).toContain('钓几次')
  })

  it('declares one number field and no choice-backed one', () => {
    const fields = fieldsOf('douyu', ActionKey.Fishing)

    // 形象 and 在用鱼饵 are readings of the panel, not parameters — see the note beside this table.
    expect(fields).toEqual([
      {
        name: 'casts',
        label: '钓几次',
        help: '今天钓几竿。一竿消耗 20 枚在用的鱼饵（抓包实测），跑完这一轮当天就不再钓，所以要按自己的鱼饵存量填；留空按 1 竿算，最多 10 竿。',
        kind: 'number'
      }
    ])
    expect(fields[0]?.source).toBeUndefined()

    // …and the merge is what publishes it on the adapter's own descriptor rather than beside it.
    const merged = descriptorsWithDeclarations('douyu', douyuPlatform.actions)
    const fishing = merged.find(action => action.key === ActionKey.Fishing)
    expect(fishing?.optionFields).toEqual(fields)
  })
})
