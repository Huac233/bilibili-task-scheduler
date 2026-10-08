import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { douyuPlatform } from '../src/platform/douyu/index.js'
import type { ActionItem, ActionOutcome, PlatformAccount } from '../src/platform/types.js'
import { ActionKey } from '../src/repo/tasks.js'

/**
 * 清仓（送出即将过期的免费道具）, at the wire — and the three things it is made of that are easy to get wrong.
 *
 * `douyu-adapter.test.ts` mocks the protocol module, which is the right boundary for what the *adapter* does
 * with a verdict but cannot see a URL, a header, or a body. Every fact this action turns on lives there:
 *
 *  - **The reservation is read, not filled in.** A run reads the badge wall for the rooms that hold a medal,
 *    reads each of those rooms' own daily list, and keeps back `Σ (taskTotal - taskNum)` of the 赠送礼物 row —
 *    because「续牌」is 亲密度任务's gifting half, and it draws on the same backpack. The cases below pin both
 *    sides of that: nothing goes out when the stock is at the reservation, and exactly one item goes out the
 *    moment it is one above it.
 *  - **The window is `met`, and the unit is seconds.** `met` is the item's absolute expiry instant, measured
 *    against the official front end's own `getRestTime(expiry) - 1s`; the captured body's `1791734399` is
 *    2026-10-11 23:59:59 (+08). The boundary is asserted on both sides at one-second resolution, and an item
 *    whose `met` cannot be read is **not** sent — the direction that cannot give something away by mistake.
 *  - **It spends through the same sender 亲密度任务 does.** The POST is the captured one, byte for byte,
 *    `propCount=1` per call, aimed at the room the *preferences* name.
 *
 * Nothing here reaches the network: `fetch` is stubbed and every reply is a captured body. The protocol
 * module and the adapter are both real, so what is exercised is the code that runs, from the URL up.
 */

const BODY_BADGES = readFileSync(new URL('./captured/douyu-fan-badges.html', import.meta.url), 'utf8')
const BODY_TASK_OPEN = readFileSync(new URL('./captured/douyu-user-task-list-12293234.json', import.meta.url), 'utf8')
const BODY_TASK_DONE = readFileSync(new URL('./captured/douyu-user-task-list-12306.json', import.meta.url), 'utf8')
const BODY_BACKPACK = readFileSync(new URL('./captured/douyu-prop-backpack-web-12306.json', import.meta.url), 'utf8')
const BODY_DONATE_REQUEST = readFileSync(new URL('./captured/douyu-donate-request-12306.txt', import.meta.url), 'utf8')
const BODY_DONATE_RESPONSE = readFileSync(
  new URL('./captured/douyu-donate-response-12306.json', import.meta.url),
  'utf8'
)

/** The captured backpack's own instant: `met` is 1791734399 s, i.e. 2026-10-11 23:59:59 (+08). */
const CAPTURED_MET = 1_791_734_399
/** A run instant nine and a half hours before that expiry, so the captured item is inside the window. */
const NOW = 1_791_700_000_000
/** 24 hours, and the run instant the two window boundaries are measured from. */
const DAY_MS = 24 * 60 * 60 * 1000
const EDGE_MET = (NOW + DAY_MS) / 1000
/** Three days out: held, readable, and deliberately *outside* the window. */
const FAR_MET = (NOW + 3 * DAY_MS) / 1000

/** One row of a captured list, as the mutations below treat it. */
type Row = Record<string, unknown>

/** The shape a captured **task-list** body has. */
interface CapturedTasks {
  readonly data: { readonly dayTasks: Row[] }
}

/** The shape a captured **`japi/prop`** body has. `list` is mutable: a case replaces the whole inventory. */
interface CapturedProp {
  readonly data: { list: Row[] }
}

/** One row, read through a guard so a shrunken fixture fails with a sentence rather than `undefined`. */
function rowAt(rows: readonly Row[], index: number, what: string): Row {
  const row = rows[index]
  if (row === undefined) throw new Error(`the fixture has no ${what}[${String(index)}]`)
  return row
}

/** One captured body with one named change, as `douyu-intimacy-tasks.test.ts` builds them. */
function withBody<T>(body: string, mutate: (payload: T) => void): string {
  const payload: T = JSON.parse(body)
  mutate(payload)
  return JSON.stringify(payload)
}

/** The captured task list for one room, with its 赠送礼物 row owing `owed` more gifts. */
function tasksOwing(owed: number): string {
  return withBody<CapturedTasks>(BODY_TASK_OPEN, payload => {
    const gift = rowAt(payload.data.dayTasks, 2, 'dayTasks')
    gift['taskTotal'] = Math.max(owed, 1)
    gift['taskNum'] = Math.max(owed, 1) - owed
  })
}

/**
 * One prop row, built on the captured 268 row so every unread field is the capture's own.
 *
 * `met` defaults to the capture's own instant — nine and a half hours before the run, so the row is inside
 * the 24-hour window — and `met: null` is how a case leaves the field **absent**, which is a different
 * state from any number and the one this build refuses to guess about.
 */
function prop(fields: { id: number; name?: string; count: number; met?: number | null }): Row {
  const base = { ...rowAt((JSON.parse(BODY_BACKPACK) as CapturedProp).data.list, 0, 'list') }
  const changed: Row = { ...base, id: fields.id, count: fields.count }
  if (fields.name !== undefined) changed['name'] = fields.name
  if (fields.met === null) delete changed['met']
  else changed['met'] = fields.met ?? CAPTURED_MET
  return changed
}

/** The captured backpack read, as the account's current holding. */
function backpackOf(rows: readonly Row[]): string {
  return withBody<CapturedProp>(BODY_BACKPACK, payload => {
    payload.data.list = [...rows]
  })
}

/** The captured donate receipt, as the receipts after each send. */
function receiptOf(rows: readonly Row[]): string {
  return withBody<CapturedProp>(BODY_DONATE_RESPONSE, payload => {
    payload.data.list = [...rows]
  })
}

/** The two medal rooms the captured page lists. */
const ROOM_A = '12293234'
const ROOM_B = '12306'
/** A room id out of Douyu's own front-end bundle: no medal here, so it can only be a destination. */
const ROOM_NO_MEDAL = '74960'

const TOKEN = '123456789_1_abcdef0123456789_0_69117311'
const DID = '20e8917f4ebe85866a5e94cfaba2f156'
const WEB_COOKIES = `acf_auth=1_1_abcdef; acf_uid=456918967; acf_did=${DID}`

const TASKS_PATH = '/japi/interactnc/web/fans/userTaskList'
const BACKPACK_PATH = '/japi/prop/backpack/web/v5'
const DONATE_PATH = '/japi/prop/donate/mainsite/v5'
const BADGES_PATH = '/member/cp/getFansBadgeList'

interface Recorded {
  readonly url: string
  readonly path: string
  readonly method: string
  readonly headers: readonly string[]
  readonly token: string | null
  readonly cookie: string | null
  readonly rid: string | null
  readonly body: string
}

interface Scripted {
  readonly text?: string
  readonly status?: number
  readonly unreachable?: boolean
}

const requests: Recorded[] = []

/** What each endpoint answers on this run. A case replaces the one it is about. */
let badgeScript: () => Scripted
let tasksScript: (rid: string) => Scripted
let backpackScript: () => Scripted
let donateScript: (index: number) => Scripted
let donationsServed: number
let logs: string[]

/**
 * The default fixture: two medal rooms, each owing five gifts, and the captured backpack.
 *
 * `Σ (taskTotal - taskNum)` over those two rooms is **10**, which is also `GIFTS_MAX_PER_RUN` — so the
 * cases that want to watch a send rather than a ceiling move the reservation themselves.
 */
function freshBadges(): () => Scripted {
  return () => ({ text: BODY_BADGES })
}

function freshTasks(): (rid: string) => Scripted {
  return () => ({ text: tasksOwing(5) })
}

function freshBackpack(): () => Scripted {
  return () => ({ text: BODY_BACKPACK })
}

function freshDonate(): (index: number) => Scripted {
  const base = (JSON.parse(BODY_DONATE_RESPONSE) as CapturedProp).data.list
  return index => ({ text: receiptOf([prop({ id: 268, count: 59 - index }), ...base.slice(1)]) })
}

async function fetchStub(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input.toString()
  const headers = new Headers(init?.headers ?? {})
  const parsed = new URL(url)

  requests.push({
    url,
    path: parsed.pathname,
    method: init?.method ?? 'GET',
    headers: [...headers.keys()].sort(),
    token: headers.get('token'),
    cookie: headers.get('cookie'),
    rid: parsed.searchParams.get('rid'),
    body: typeof init?.body === 'string' ? init.body : ''
  })

  const answer =
    parsed.pathname === DONATE_PATH
      ? donateScript(donationsServed++)
      : parsed.pathname === BACKPACK_PATH
        ? backpackScript()
        : parsed.pathname === BADGES_PATH
          ? badgeScript()
          : tasksScript(parsed.searchParams.get('rid') ?? '')

  if (answer.unreachable === true) throw new TypeError('fetch failed')
  return new Response(answer.text ?? '{}', {
    status: answer.status ?? 200,
    headers: new Headers({ 'content-type': parsed.pathname === BADGES_PATH ? 'text/html' : 'application/json' })
  })
}

beforeEach(() => {
  requests.length = 0
  logs = []
  donationsServed = 0
  badgeScript = freshBadges()
  tasksScript = freshTasks()
  backpackScript = freshBackpack()
  donateScript = freshDonate()
  vi.stubGlobal('fetch', fetchStub)
})

function account(webCookies = WEB_COOKIES): PlatformAccount {
  const blob: Record<string, string> = { token: TOKEN, did: DID }
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

interface RunFields {
  readonly storedOptions?: Record<string, unknown>
  readonly account?: PlatformAccount
  readonly now?: number
}

/** The options a person has to fill in before this action can do anything. */
function configured(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { dumpRoomId: ROOM_B, propAllowlist: ['268'], ...extra }
}

/** One run of the action, from the adapter seam down. */
async function run(fields: RunFields = {}): Promise<ActionOutcome> {
  const outcomes = await douyuPlatform.reconcile({
    account: fields.account ?? account(),
    // Account-scoped: an empty target key is what `types.ts` reserves for an action about the account.
    targetKey: '',
    enabledActions: [ActionKey.Clearout],
    options: { [ActionKey.Clearout]: fields.storedOptions ?? configured() },
    now: fields.now ?? NOW,
    dayKey: '2026-10-08',
    log: line => logs.push(line)
  })

  const found = outcomes.find(outcome => outcome.actionKey === ActionKey.Clearout)
  if (found === undefined) throw new Error('no outcome for clearout_props')
  return found
}

/** The requests one endpoint received, in order. */
function requestsTo(path: string): Recorded[] {
  return requests.filter(recorded => recorded.path === path)
}

/** Every POST body this run sent, which is the only thing that leaves a mark. */
function sentPropIds(): string[] {
  return requestsTo(DONATE_PATH).map(call => new URLSearchParams(call.body).get('propId') ?? '')
}

/** The item about one medal room, found by the anchor's name rather than by index. */
function roomItemOf(outcome: ActionOutcome, anchor: string): ActionItem {
  const item = outcome.items.find(candidate => candidate.label === anchor)
  if (item === undefined) throw new Error(`the run reported no item for ${anchor}`)
  return item
}

describe('清仓 — the settings a person must supply', () => {
  it('sends nothing at all until both settings are there, and names the one that is missing', async () => {
    // Nothing stored: no destination and no list. Two states, two sentences, because the next move differs
    // — name a room, or write a list — and neither is a send that failed.
    const bare = await run({ storedOptions: {} })
    expect(bare).toMatchObject({ outcome: 'blocked', code: 'no_dump_room', failure: 'action_stop' })
    expect(bare.detail).toContain('默认倾泻直播间')
    expect(requests).toEqual([])

    const noList = await run({ storedOptions: { dumpRoomId: ROOM_B } })
    expect(noList).toMatchObject({ outcome: 'blocked', code: 'no_prop_allowlist', failure: 'action_stop' })
    expect(noList.detail).toContain('允许使用的道具')
    expect(requests).toEqual([])

    // A cell that is not a room number is the same state as an empty one, and never a `roomId` for a POST.
    const bogus = await run({ storedOptions: { dumpRoomId: 'not-a-room', propAllowlist: ['268'] } })
    expect(bogus).toMatchObject({ outcome: 'blocked', code: 'no_dump_room', failure: 'action_stop' })
    expect(requests).toEqual([])
  })

  it('keeps its own list: 亲密度任务’s allowlist cannot make it spend', async () => {
    // 两个动作，两份清单. The intimacy action's stored list is a different cell, and this action reads its
    // own — so a person who ticked gifts for 亲密度任务 has authorised nothing here.
    const outcome = await run({ storedOptions: { dumpRoomId: ROOM_B, giftAllowlist: ['268'] } })

    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_prop_allowlist' })
    expect(requests).toEqual([])
  })

  it('reports a missing credential and a missing web session as their own states', async () => {
    const noCredential = await run({ account: { ...account(), credentials: 'not a blob' } })
    expect(noCredential).toMatchObject({ outcome: 'failed', code: 'no_credential', failure: 'account_stop' })

    const noSession = await run({ account: account('') })
    expect(noSession).toMatchObject({ outcome: 'blocked', code: 'no_web_session', failure: 'action_stop' })
    expect(noSession.detail).toContain('重新扫码绑定')
    expect(requests).toEqual([])
  })

  it('stops when the badge wall lists nothing, rather than dumping the whole backpack', async () => {
    // An empty wall is either an account with no medals or a reader that failed to find a single row on it —
    // and the second reading is the dangerous one, because with no medal known there is nothing to reserve.
    // Sending is public and cannot be un-sent, so the empty reading stops the run — and it stops it *before*
    // the backpack is read, which is the assertion. (A *dead session* is not this state: that read answers
    // `302` with an empty body, which `readFanBadges` throws on, so it arrives as `failed` instead.)
    badgeScript = () => ({ text: '<table class="fans-badge-list"><tbody></tbody></table>' })

    const outcome = await run()

    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_badges', failure: 'action_stop' })
    expect(requestsTo(BACKPACK_PATH)).toEqual([])
    expect(requestsTo(DONATE_PATH)).toEqual([])
  })
})

describe('清仓 — the reservation', () => {
  it('keeps back what every medal room still needs, and says so per room', async () => {
    // Two rooms, each owing five. The stock is the captured 60, so the reservation is not what stops this
    // run — the per-run ceiling is — but the arithmetic is visible in where it stops computing and in the
    // items: each room's own line carries what was held back for it.
    const outcome = await run()

    expect(roomItemOf(outcome, '145oni')).toMatchObject({
      kind: 'room',
      detail: '今天还差 5 件礼物（这一轮为它留了 5 件）',
      code: '5'
    })
    expect(roomItemOf(outcome, '电棍')).toMatchObject({ detail: '今天还差 5 件礼物（这一轮为它留了 5 件）' })
    expect(outcome.detail).toContain('牌子 2 个、保留 10 件')
    expect(sentPropIds()).toHaveLength(10)
    // One `userTaskList` call per medal room, and no second one: the reservation is a read of every room the
    // account holds a medal in, and the badge wall is what says which those are.
    expect(requestsTo(TASKS_PATH).map(call => call.rid)).toEqual([ROOM_A, ROOM_B])
  })

  it('reads the reservation off the captured bodies themselves', async () => {
    // The two task-list bodies the reconnaissance saved, unchanged: `taskTotal 5 / taskNum 0` on each room's
    // 赠送礼物 row. This is the fixture guard the cases above rest on — if a later capture replaced one of
    // those files with a row that wants nothing, the reservation they assert would be a different number and
    // this is the case that would say so first.
    tasksScript = (rid: string) => ({ text: rid === ROOM_B ? BODY_TASK_DONE : BODY_TASK_OPEN })

    const outcome = await run()

    expect(outcome.detail).toContain('保留 10 件')
    expect(roomItemOf(outcome, '145oni')).toMatchObject({ code: '5' })
    expect(roomItemOf(outcome, '电棍')).toMatchObject({ code: '5' })
  })

  it('sends nothing when the stock is at the reservation, and exactly one item when it is one above', async () => {
    // **Both sides of the line.** 60 in the backpack, 10 held back (two rooms owing five): the run drains
    // down to the reservation and stops. One item above it, one item goes out — which is what makes this a
    // test about the reservation rather than about an empty backpack.
    tasksScript = () => ({ text: tasksOwing(5) })

    backpackScript = () => ({ text: backpackOf([prop({ id: 268, count: 10 })]) })
    const atTheLine = await run()
    expect(atTheLine).toMatchObject({ outcome: 'blocked', code: 'all_reserved', failure: 'none' })
    expect(sentPropIds()).toEqual([])
    // The backpack was read — that read is what produced the answer — and nothing else was spent on it.
    expect(requestsTo(BACKPACK_PATH)).toHaveLength(1)

    requests.length = 0
    backpackScript = () => ({ text: backpackOf([prop({ id: 268, count: 11 })]) })
    const above = await run()
    expect(sentPropIds()).toEqual(['268'])
    expect(above).toMatchObject({ outcome: 'done', code: 'gifts_sent' })
  })

  it('holds the reservation back from every item, not from the total', async () => {
    // **The case that decides which arithmetic this is.** Two items on the list: 3410 expires sooner and the
    // account holds three of it; 268 expires later and the account holds sixty. The reservation is five.
    //
    //  - per item (what this build does): 3410 has no slack at all, so nothing goes out from it; the sends
    //    all come from 268, which has 55.
    //  - from the total (the tempting mistake): 63 - 5 = 58 to spend, and the walk sends the fastest-first
    //    three out of 3410 — leaving 268's stock untouched and 3410 at zero.
    //
    // The second is exactly the under-reservation the design warns about: 续牌 needs five of *something the
    // account still has*, and 3410 gone means the five have to come out of 268 anyway. So the assertion is
    // that 3410 never goes out.
    backpackScript = () => ({
      text: backpackOf([
        prop({ id: 3410, name: '陪伴印章', count: 3, met: Math.floor(NOW / 1000) + 3600 }),
        prop({ id: 268, name: '粉丝荧光棒', count: 60, met: Math.floor(NOW / 1000) + 7200 })
      ])
    })
    tasksScript = () => ({ text: tasksOwing(5) })

    const outcome = await run({ storedOptions: { dumpRoomId: ROOM_B, propAllowlist: ['3410', '268'] } })

    expect(sentPropIds()).toEqual(['268', '268', '268', '268', '268', '268', '268', '268', '268', '268'])
    expect(sentPropIds()).not.toContain('3410')
    // And the run says it was cut short by its own ceiling rather than by an empty backpack.
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'gift_short', failure: 'none' })
    expect(outcome.items[0]?.detail).toContain('本次最多送 10 件')
    expect(outcome.items[0]?.detail).toContain('已送 10 件')
  })

  it('reads the reservation from the same place 亲密度任务 does, and the two agree', async () => {
    // One fixture, two actions: 亲密度任务 sends `taskTotal - taskNum` for its room's 赠送礼物 row, and 清仓
    // reserves the same number for the same room. They read it through the same reader
    // (`readRoomGiftDemand`), so the assertion is that the two numbers are one number — if the arithmetic
    // ever moved into either action's body, this is the case that would catch the drift.
    tasksScript = (rid: string) => ({ text: rid === ROOM_B ? tasksOwing(3) : tasksOwing(0) })

    const intimacy = await douyuPlatform.reconcile({
      account: account(),
      targetKey: ROOM_B,
      enabledActions: [ActionKey.IntimacyTasks],
      options: { [ActionKey.IntimacyTasks]: { giftAllowlist: ['268'] } },
      now: NOW,
      dayKey: '2026-10-08',
      log: line => logs.push(line)
    })
    const giftSends = requestsTo(DONATE_PATH).length
    expect(giftSends).toBe(3)

    requests.length = 0
    backpackScript = () => ({ text: backpackOf([prop({ id: 268, count: 8 })]) })
    const clearout = await run()

    // The other room owes nothing today, so the whole reservation is this room's three — and the stock of
    // eight leaves five to dump, which is what went out.
    expect(roomItemOf(clearout, '145oni')).toMatchObject({ detail: '今天不需要礼物', code: '0' })
    expect(roomItemOf(clearout, '电棍')).toMatchObject({ detail: '今天还差 3 件礼物（这一轮为它留了 3 件）' })
    expect(clearout.detail).toContain('保留 3 件')
    expect(sentPropIds()).toHaveLength(5)
    expect(intimacy[0]?.actionKey).toBe(ActionKey.IntimacyTasks)
  })

  it('sends nothing when one room’s list cannot be read, and never buys a backpack read to find out', async () => {
    // An unknown reservation is not a smaller reservation. Over-reserving costs a few unsent items;
    // under-reserving costs the medal day — and the one reading that cannot under-reserve is "I do not
    // know", which sends nothing. It also stops before the backpack read: no POST is prepared for a
    // reservation that was never computed.
    tasksScript = (rid: string) => (rid === ROOM_A ? { unreachable: true } : { text: tasksOwing(5) })

    const outcome = await run()

    expect(outcome).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
    expect(outcome.detail).toContain('保留量算不出来')
    expect(requestsTo(BACKPACK_PATH)).toEqual([])
    expect(requestsTo(DONATE_PATH)).toEqual([])
  })
})

describe('清仓 — the window', () => {
  it('sends an item at the edge of 24 hours and not the one a second past it', async () => {
    // `met` is seconds, so the boundary is exactly one second wide and both sides are asserted here: the
    // item whose expiry is `now + 24 h` is inside, and the one a second later is not. An off-by-one in the
    // unit (milliseconds) or in the comparison would show up as 0 sends or 2. The reservation is taken out
    // of the way first — both rooms owing nothing today — so what is left is the window alone.
    tasksScript = () => ({ text: tasksOwing(0) })
    backpackScript = () => ({
      text: backpackOf([
        prop({ id: 3410, name: '陪伴印章', count: 4, met: EDGE_MET }),
        prop({ id: 268, name: '粉丝荧光棒', count: 60, met: EDGE_MET + 1 })
      ])
    })

    const outcome = await run({ storedOptions: { dumpRoomId: ROOM_B, propAllowlist: ['3410', '268'] } })

    expect(sentPropIds()).toEqual(['3410', '3410', '3410', '3410'])
    expect(outcome).toMatchObject({ outcome: 'done', code: 'gifts_sent' })
  })

  it('does not send an item whose expiry it cannot read, and says which state that is', async () => {
    // `met` missing, and `met: 0`. Neither may be read as "due": sending is public and cannot be un-sent,
    // and this build would be guessing the one number the whole action turns on. With something else due,
    // the guess-free items are simply left alone and the run reports that much.
    tasksScript = () => ({ text: tasksOwing(0) })
    backpackScript = () => ({
      text: backpackOf([
        prop({ id: 3410, name: '陪伴印章', count: 2, met: null }),
        prop({ id: 268, name: '粉丝荧光棒', count: 60, met: 0 }),
        prop({ id: 749, name: '第三个', count: 1, met: Math.floor(NOW / 1000) + 3600 })
      ])
    })

    const outcome = await run({ storedOptions: { dumpRoomId: ROOM_B, propAllowlist: ['3410', '268', '749'] } })
    expect(sentPropIds()).toEqual(['749'])

    // And with nothing readable left at all, the state is the one a person has to look at: a contract change
    // reported as itself rather than parked silently.
    requests.length = 0
    backpackScript = () => ({ text: backpackOf([prop({ id: 268, count: 60, met: null })]) })
    const blind = await run({ storedOptions: { dumpRoomId: ROOM_B, propAllowlist: ['268'] } })
    expect(blind).toMatchObject({ outcome: 'blocked', code: 'expiry_unknown', failure: 'action_stop' })
    expect(blind.detail).toContain('到期时刻读不出来')
    expect(sentPropIds()).toEqual([])
    expect(outcome.items.length).toBeGreaterThan(0)
  })

  it('waits when nothing is inside the window, and does not settle the day on it', async () => {
    // The ordinary sweep: an item with days left is not this action's business yet. `blocked` and not
    // `already`/`done`, because a later sweep *today* may find it inside the window — the runner settles a
    // day on those two and this state has to stay watchable.
    tasksScript = () => ({ text: tasksOwing(0) })
    backpackScript = () => ({ text: backpackOf([prop({ id: 268, count: 60, met: FAR_MET })]) })

    const outcome = await run()

    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'nothing_expiring', failure: 'none' })
    expect(outcome.detail).toContain('24 小时')
    expect(sentPropIds()).toEqual([])
    // And the fact a person wants is in the sentence: how long the soonest one has left.
    expect(outcome.items[0]?.detail).toContain('小时才到期')
  })
})

describe('清仓 — the send', () => {
  it('sends the captured request, one item per POST, to the room the preferences name', async () => {
    // The destination is `ROOM_B` here, which is also the room the captured donate was addressed to — so the
    // body is the capture byte for byte, and the two audits that matter are that it goes through 亲密度任务's
    // own sender and that `roomId` follows the setting rather than the medal list.
    expect(BODY_DONATE_REQUEST).toBe('propId=268&propCount=1&roomId=12306&bizExt=%7B%22yzxq%22%3A%7B%7D%7D')

    const outcome = await run()

    const sent = requestsTo(DONATE_PATH)
    expect(sent).toHaveLength(10)
    for (const call of sent) {
      expect(call.method).toBe('POST')
      expect(call.body).toBe(BODY_DONATE_REQUEST)
      // The `japi/prop` family authenticates by the web session alone and sends no `token` header — the
      // captured pair's own shape, and the one thing the sender must not "improve" on.
      expect(call.token).toBeNull()
      expect(call.cookie).toBe(WEB_COOKIES)
      expect(call.headers).toEqual([
        'accept',
        'accept-language',
        'content-type',
        'cookie',
        'origin',
        'referer',
        'user-agent',
        'x-requested-with'
      ])
    }

    // What a person reads: the act leads, and nothing in it is an identifier.
    expect(outcome.items[0]?.detail).toContain('已送 10 件「粉丝荧光棒」给电棍、本次没有扣费')
    expect(logs[0]).toBe(`赠送礼物「粉丝荧光棒」给电棍（房间 ${ROOM_B}）：本次没有扣费`)
    expect(logs.at(-1)).toBe(`清仓：牌子 2 个、保留 10 件、本次送出 10 件（房间 ${ROOM_B}）`)
  })

  it('aims at the configured room, which need not be one of the medal rooms', async () => {
    // `74960` is a room id out of Douyu's own bundle and holds no medal for this account: the POST still goes
    // there, because the destination is a preference and not a medal. Nothing in the walk consults the medal
    // list for a destination — the medal list is only ever a *reservation*.
    const outcome = await run({ storedOptions: { dumpRoomId: ROOM_NO_MEDAL, propAllowlist: ['268'] } })

    const sent = requestsTo(DONATE_PATH)
    expect(sent).toHaveLength(10)
    for (const call of sent) expect(new URLSearchParams(call.body).get('roomId')).toBe(ROOM_NO_MEDAL)
    for (const call of sent) expect(call.body).not.toContain(`roomId=${ROOM_B}`)
    // And the backpack read is addressed by that same room, which is what the endpoint asks for and looks
    // nothing up by.
    expect(requestsTo(BACKPACK_PATH)[0]?.rid).toBe(ROOM_NO_MEDAL)
    expect(outcome).toMatchObject({ code: 'gift_short' })
  })

  it('stops on a refusal and on a call that never arrived, and says what may have landed', async () => {
    tasksScript = () => ({ text: tasksOwing(2) })
    backpackScript = () => ({ text: backpackOf([prop({ id: 268, count: 60, met: Math.floor(NOW / 1000) + 3600 })]) })

    donateScript = () => ({ text: JSON.stringify({ error: 1234, msg: '稍后再试' }) })
    const refused = await run()
    expect(refused).toMatchObject({ outcome: 'failed', code: '1234', failure: 'retry' })
    expect(requestsTo(DONATE_PATH)).toHaveLength(1)
    expect(refused.items[0]?.detail).toContain('未送成（赠送礼物失败：稍后再试）')

    requests.length = 0
    donationsServed = 0
    let served = 0
    donateScript = () => {
      served += 1
      return served === 1 ? freshDonate()(0) : { unreachable: true }
    }
    const unreached = await run()
    expect(unreached).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
    expect(requestsTo(DONATE_PATH)).toHaveLength(2)
    expect(unreached.items[0]?.detail).toContain('之后一次没能送出')
    expect(unreached.detail).toContain('可能已经送出去了')
  })

  it('stops at its own per-run ceiling, and keeps watching instead of settling the day', async () => {
    // 60 in the backpack, 5 owed by one room: 55 could go out, and ten do. `blocked` — not `done` — because
    // the backpack still holds items inside the window and the next sweep is what drains them.
    tasksScript = (rid: string) => ({ text: rid === ROOM_B ? tasksOwing(5) : tasksOwing(0) })
    backpackScript = () => ({ text: backpackOf([prop({ id: 268, count: 60, met: Math.floor(NOW / 1000) + 3600 })]) })

    const outcome = await run()

    expect(sentPropIds()).toHaveLength(10)
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'gift_short', failure: 'none' })
    expect(outcome.items[0]?.detail).toContain('本次最多送 10 件')
    expect(outcome.items[0]?.detail).toContain('已送 10 件')
  })

  it('keeps every credential out of the record and the console line', async () => {
    donateScript = () => ({ unreachable: true })

    const outcome = await run()

    for (const text of [outcome.detail, ...outcome.items.map(item => item.detail), ...logs]) {
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(WEB_COOKIES)
      expect(text).not.toContain('acf_auth')
    }
  })
})

describe('清仓 — the record', () => {
  it('never lets the record disagree with its own items', async () => {
    // The invariant `types.ts` states, as a relation rather than per case: an item that says `done` inside a
    // record that says `failed` reads, in the UI, as "it worked". The states below are the ones this action
    // can reach, and every one of them carries an item whose `outcome` is the record's.
    const bodies: readonly Scripted[] = [
      { text: BODY_BACKPACK },
      { text: backpackOf([prop({ id: 268, count: 10 })]) },
      { text: backpackOf([prop({ id: 268, count: 60 })]) }
    ]

    for (const body of bodies) {
      backpackScript = () => body
      const outcome = await run()
      expect(outcome.items.length).toBeGreaterThan(0)
      expect(outcome.items.map(item => item.outcome)).toContain(outcome.outcome)
      expect(outcome.targetKey).toBe('')
    }

    // And the sending state, where the item that carries the record is the act itself. Sixteen held with ten
    // reserved means six may go out, which is under the per-run ceiling — so the walk finishes what it set
    // out to do and the record is `done`.
    backpackScript = () => ({ text: backpackOf([prop({ id: 268, count: 16 })]) })
    const sent = await run()
    expect(sent.outcome).toBe('done')
    expect(sent.items[0]).toMatchObject({ kind: 'account', label: '送出即将过期的免费道具', outcome: 'done' })
  })
})
