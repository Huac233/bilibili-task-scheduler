import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { douyuPlatform } from '../src/platform/douyu/index.js'
import type { ActionItem, ActionOutcome, PlatformAccount } from '../src/platform/types.js'
import { ActionKey } from '../src/repo/tasks.js'

/**
 * 亲密度任务, at the wire — the two things it is made of that are easy to get wrong, and the one write it
 * now makes.
 *
 * `douyu-adapter.test.ts` mocks the protocol module, which is the right boundary for what the *adapter*
 * does with a verdict but cannot see a URL, a header, or a body. Every fact this action turns on lives
 * there:
 *
 *  - **`userTaskList` is read with `rid` alone.** No `uid`, no `ctn`, and no CSRF minting flow: all four
 *    captured calls answered `error: 0`, the stored jar carries no `acf_ccn`, none of them set one, and
 *    the page's own request layer defaults `csrf` to `isPost`. The first case asserts the request shape
 *    and, by counting requests, that **nothing minted anything**.
 *  - **Outstanding is the server's own counter** (`taskNum < taskTotal`) and never `taskStatus`. The
 *    captured pair is what makes that assertable: room 12306 reads its 弹幕 task as `1/1` and room
 *    12293234 reads the same task as `0/1` at the same instant in the same account — and 12306's weekly
 *    row reads `taskNum: 1 / taskTotal: 2 / taskStatus: 2`, which a `taskStatus`-based judgement
 *    (`taskStatus === 1 || taskStatus === 2`) calls **completed** while the progress is one day of two.
 *  - **The gifting half sends, one gift per POST, up to the number the server's own counter still wants**
 *    — and only items a person listed (`giftAllowlist`) that the account actually holds (a backpack read).
 *    Three captured bodies make that assertable rather than plausible: the backpack the page read (60 of
 *    prop 268), the donate request itself, and the donate response (the same prop at 59, `usedProp.balance`
 *    and `includePrice` both 0, one broadcast frame naming 「电棍」). `mainsite/v5` is the version in that
 *    request — the three third-party implementations that write `mainsite/v1` are not evidence here.
 *  - **The danmaku half belongs to 发送弹幕, and the paid row to nobody.** The socket is mocked here so that
 *    "this action sent no message of its own" is an assertion rather than a claim about the code, and
 *    `taskType === 2` — the paid 全力守护 gift — has no branch to reach.
 *
 * Nothing here reaches the network: `fetch` is stubbed, every reply is a captured body, and the socket
 * module is mocked rather than merely unused. The protocol module and the adapter are both real, so what is
 * exercised is the code that runs, from the URL up — including the one path that spends, which is exercised
 * with the captured request and response rather than a live account.
 */

const { sendDanmakuMock } = vi.hoisted(() => ({ sendDanmakuMock: vi.fn() }))

// Mocked even though this test expects it never to be used: the action must not be able to reach it at
// all, and a socket that was reached would otherwise be a live connection attempt from a unit test.
vi.mock('../src/platform/douyu/socket.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/platform/douyu/socket.js')>()
  return { ...actual, sendDanmaku: sendDanmakuMock }
})

/**
 * The captured bodies, byte for byte.
 *
 * The task pair is the one the reconnaissance report publishes and the only reads of that endpoint that
 * exist; the three `japi/prop` files are the capture this feature rests on — the backpack read the page
 * made, the donate request the owner sent, and the donate response he got back — taken from
 * `D:\mitmproxy\all-2026-10-08_18-22-04.mitm` through `dump-donate.py`'s filter (`~u /japi/prop/`, not
 * `~u prop`, which matches every `property_info*.json`). They are kept as files rather than inlined
 * because a fixture re-typed by hand tests the author's idea of the payload, and a gift request is the last
 * thing that should be asserted against one.
 */
const BODY_TASK_DONE = readFileSync(new URL('./captured/douyu-user-task-list-12306.json', import.meta.url), 'utf8')
const BODY_TASK_OPEN = readFileSync(new URL('./captured/douyu-user-task-list-12293234.json', import.meta.url), 'utf8')
const BODY_BACKPACK = readFileSync(new URL('./captured/douyu-prop-backpack-web-12306.json', import.meta.url), 'utf8')
const BODY_DONATE_REQUEST = readFileSync(new URL('./captured/douyu-donate-request-12306.txt', import.meta.url), 'utf8')
const BODY_DONATE_RESPONSE = readFileSync(
  new URL('./captured/douyu-donate-response-12306.json', import.meta.url),
  'utf8'
)

/** One row of a captured list, as the mutations below treat it. */
type Row = Record<string, unknown>

/** The shape a captured **task-list** body has: the two lists this file mutates. */
interface CapturedTasks {
  readonly data: { readonly dayTasks: Row[]; readonly weekTasks: Row[] }
}

/**
 * The shape a captured **`japi/prop`** body has: the backpack list, and — on a donate receipt only — the
 * broadcast frames and the two price fields. The two latter are optional because the backpack read carries
 * neither, and a fixture that invented them would be this file's idea of the payload.
 */
interface CapturedProp {
  readonly data: {
    readonly list: Row[]
    readonly messages?: string[]
    readonly usedProp?: Record<string, unknown>
  }
}

/**
 * One row out of a captured list, for the mutations below.
 *
 * Reads through a guard rather than an assertion: `JSON.parse` answers `any` and the index may genuinely be
 * missing, so a fixture that shrank would fail here with a sentence instead of mutating `undefined`.
 */
function rowAt(rows: readonly Row[], index: number, what: string): Row {
  const row = rows[index]
  if (row === undefined) throw new Error(`the fixture has no ${what}[${String(index)}]`)
  return row
}

/**
 * One captured body with one named change.
 *
 * The cases the real bodies cannot state — a row that still wants more gifts, one that wants more than a
 * run will send, a receipt with one more taken off the backpack — still start from a real payload, so what
 * they test is the judgement rather than this author's idea of what 斗鱼 sends. Every call site names its
 * mutation, and the body's shape is named at the call site too, so a mutation cannot be written against the
 * wrong file.
 */
function withBody<T>(body: string, mutate: (payload: T) => void): string {
  const payload: T = JSON.parse(body)
  mutate(payload)
  return JSON.stringify(payload)
}

/** The captured backpack read, as the read a test wants it to answer with. */
function backpackHolding(count: number): string {
  return withBody<CapturedProp>(BODY_BACKPACK, payload => {
    rowAt(payload.data.list, 0, 'list')['count'] = count
  })
}

/** The captured receipt, as a test wants the receipt after one send to read. */
function receiptHolding(count: number): string {
  return withBody<CapturedProp>(BODY_DONATE_RESPONSE, payload => {
    rowAt(payload.data.list, 0, 'list')['count'] = count
  })
}

/** The `rid` of the captured task list whose gift row is outstanding, which is also the captured donate's. */
const ROOM_GIFT_OPEN = '12306'
/** The other captured room, whose 弹幕 row is not done. */
const ROOM_OPEN = '12293234'

/** The captured request's own gift: 粉丝荧光棒, the item the allowlist has to name for anything to send. */
const HELD_GIFT_ID = '268'
/**
 * A gift id the account does not hold, taken from the capture: `24468` is the **赠送礼物** row's own
 * `taskWhiteGiftId` (`taskType: 3`), which is what makes it a plausible id for a person to put on
 * the allowlist.
 *
 * **It is not the paid row's id, and this comment used to say it was.** The paid row
 * (「送出“全力守护”礼物」, `taskType: 2`) names `24478` — the captured task list itself has 24478 on
 * `taskType: 2` and 24468 on `taskType: 3`
 * (`tests/captured/douyu-user-task-list-12306.json`, and the same pair in the 12293234 file), and
 * the case near the bottom of this file refuses `24478` by name. The difference is not cosmetic: the
 * id a person may list and the id this action may never send are two different numbers, and a
 * comment that merged them was contradicted inside its own file.
 */
const UNHELD_GIFT_ID = '24468'

const TOKEN = '123456789_1_abcdef0123456789_0_69117311'
const DID = '20e8917f4ebe85866a5e94cfaba2f156'

/**
 * The web session the binder stores.
 *
 * Hand-written and shaped like the captured jar — `acf_*` beside the session cookies — because that
 * credential is what this family authenticates with; the token header travels beside it on the task read
 * for the reason `readRoomDailyTasks` records, and is deliberately **not** sent on the two gift calls,
 * which is what the captured pair did.
 */
const WEB_COOKIES = `acf_auth=1_1_abcdef; acf_uid=456918967; acf_did=${DID}`

const TASKS_PATH = '/japi/interactnc/web/fans/userTaskList'
const BACKPACK_PATH = '/japi/prop/backpack/web/v5'
const DONATE_PATH = '/japi/prop/donate/mainsite/v5'

/** One request as it left this process, before the stub answered it. */
interface Recorded {
  readonly url: string
  readonly path: string
  readonly method: string
  readonly headers: readonly string[]
  readonly token: string | null
  readonly cookie: string | null
  readonly referer: string | null
  readonly body: string
}

/** A scripted reply: a captured body, or — by rejecting — a call that never arrived. */
interface Scripted {
  readonly text?: string
  readonly status?: number
  readonly unreachable?: boolean
}

const requests: Recorded[] = []

/** What each endpoint answers on this run. A test replaces the one it is about. */
let tasksScript: (rid: string) => Scripted
let backpackScript: () => Scripted
/** The `n`th donate of this run, zero-based: what the receipt says after that send. */
let donateScript: (index: number) => Scripted
let donationsServed: number
let logs: string[]

function freshTasks(): (rid: string) => Scripted {
  return rid => ({ text: rid === ROOM_OPEN ? BODY_TASK_OPEN : BODY_TASK_DONE })
}

/** The captured backpack read: prop 268 at 60, which is the count the captured donate took one off. */
function freshBackpack(): () => Scripted {
  return () => ({ text: BODY_BACKPACK })
}

/**
 * The captured response for the first send, and the same body one further down the backpack for each send
 * after it.
 *
 * The captured response is *already* one gift past the captured read — 60 in the read, 59 in the response —
 * so the first reply is served verbatim and the arithmetic of the rest is the one thing this file mutates:
 * a receipt's own `list[]` is where the next round's count comes from, and a run that read it wrong would
 * either stop early or keep sending.
 */
function freshDonate(): (index: number) => Scripted {
  return index => ({ text: index === 0 ? BODY_DONATE_RESPONSE : receiptHolding(59 - index) })
}

/** Which endpoint this request went to, and what it answers. */
function answerFor(path: string, search: URLSearchParams): Scripted {
  if (path === DONATE_PATH) return donateScript(donationsServed++)
  if (path === BACKPACK_PATH) return backpackScript()
  return tasksScript(search.get('rid') ?? '')
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
    referer: headers.get('referer'),
    body: typeof init?.body === 'string' ? init.body : ''
  })

  const answer = answerFor(parsed.pathname, parsed.searchParams)
  if (answer.unreachable === true) throw new TypeError('fetch failed')

  return new Response(answer.text ?? '{}', {
    status: answer.status ?? 200,
    headers: new Headers({ 'content-type': 'application/json;charset=UTF-8' })
  })
}

beforeEach(() => {
  requests.length = 0
  logs = []
  donationsServed = 0
  tasksScript = freshTasks()
  backpackScript = freshBackpack()
  donateScript = freshDonate()
  sendDanmakuMock.mockReset()
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

/**
 * The instant every run below uses: Shanghai 06:22 on 2026-10-08.
 *
 * Passed and ignored — this action reads no clock, because the tasks' own counters say what the day owes
 * — but a fixed instant keeps a run reproducible.
 */
const NOW = 1_791_411_776_000

/** What one run is given. */
interface RunFields {
  readonly targetKey?: string
  /** What the switchboard would have stored for this action; nothing, unless a case says otherwise. */
  readonly storedOptions?: Record<string, unknown>
  readonly account?: PlatformAccount
}

/** One run of the action, from the adapter seam down. */
async function run(fields: RunFields = {}): Promise<ActionOutcome> {
  const outcomes = await douyuPlatform.reconcile({
    account: fields.account ?? account(),
    targetKey: fields.targetKey ?? ROOM_GIFT_OPEN,
    enabledActions: [ActionKey.IntimacyTasks],
    options: { [ActionKey.IntimacyTasks]: fields.storedOptions ?? {} },
    now: NOW,
    dayKey: '2026-10-08',
    log: line => logs.push(line)
  })

  const found = outcomes.find(outcome => outcome.actionKey === ActionKey.IntimacyTasks)
  if (found === undefined) throw new Error('no outcome for intimacy_tasks')
  return found
}

/** The requests one endpoint received, in order. */
function requestsTo(path: string): Recorded[] {
  return requests.filter(recorded => recorded.path === path)
}

/** The one request the task read makes, as the cases that assert its shape need it. */
function onlyTaskRead(): Recorded {
  const recorded = requestsTo(TASKS_PATH)[0]
  if (recorded === undefined) throw new Error('the task list was not read')
  return recorded
}

/** The 赠送礼物 row out of a run's items, found by the service's own name for it rather than by index. */
function giftItemOf(outcome: ActionOutcome): ActionItem {
  const item = outcome.items.find(candidate => candidate.label === '赠送礼物')
  if (item === undefined) throw new Error('the run reported no 赠送礼物 item')
  return item
}

/** One run with the allowlist that makes the gifting half possible, aimed at the captured room. */
function runWithAllowlist(ids: readonly string[] = [HELD_GIFT_ID]): Promise<ActionOutcome> {
  return run({ storedOptions: { giftAllowlist: [...ids] } })
}

describe('亲密度任务 — the read', () => {
  it('reads one room by rid alone, with no uid, no ctn and nothing minted', async () => {
    await run()

    const read = onlyTaskRead()
    // One request and no other: the count is the assertion that nothing walked a CSRF flow, and — with no
    // allowlist — that nothing read a backpack either. All four captured task calls answered `error: 0`
    // with no `acf_ccn` anywhere, so a mint would be a request spent on nothing.
    expect(requests).toHaveLength(1)
    expect(read).toMatchObject({ path: TASKS_PATH, method: 'GET' })
    expect(new URL(read.url).searchParams.get('rid')).toBe(ROOM_GIFT_OPEN)
    // No `uid`: the captured pair proved `?rid=` alone answers byte-identically (1939 bytes both). And no
    // `ctn` parameter, which is the CSRF value this family's *sign* needs and this read does not.
    expect([...new URL(read.url).searchParams.keys()]).toEqual(['rid'])
    expect(read.body).toBe('')

    // Both credentials, which is the captured call's own shape: the web session as `cookie`, the
    // composite token as `token`.
    expect(read.headers).toEqual(['accept', 'accept-language', 'cookie', 'referer', 'token', 'user-agent'])
    expect(read.token).toBe(TOKEN)
    expect(read.cookie).toBe(WEB_COOKIES)
    // The 粉丝转职 page this endpoint belongs to, the only referer the captures carried.
    expect(read.referer).toContain('/pages/vibe-lab-fansbadgejobchange')
    expect(read.referer).toContain('sourcekey=FansClubPanel')
    expect(read.referer).toContain(`rid=${ROOM_GIFT_OPEN}`)
  })

  it('sends nothing at all when the account has no web session', async () => {
    // The session is what this family authenticates with, and a request without one answers an identity
    // refusal that reads like a dead token. None is sent, and the outcome names a re-bind as the fix —
    // the same report 粉丝家园签到 makes for the same missing input. It is now load-bearing for the gift
    // calls too: the captured pair carried the session and no `token` header at all.
    const outcome = await run({ account: account('') })

    expect(requests).toEqual([])
    expect(sendDanmakuMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_web_session', failure: 'action_stop' })
    expect(outcome.detail).toContain('网页会话')
    expect(outcome.detail).toContain('重新扫码绑定')
  })

  it('refuses a key that is not a room number without asking the platform anything', async () => {
    const outcome = await run({ targetKey: 'not-a-room' })

    expect(requests).toEqual([])
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'bad_target', failure: 'action_stop' })
  })

  it('grades a refusal from the service, and a call that never arrived, without leaking a credential', async () => {
    tasksScript = () => ({ text: JSON.stringify({ error: 1002, msg: '用户未登录' }) })
    const refused = await run()
    expect(refused).toMatchObject({ outcome: 'failed', code: '1002', failure: 'account_stop' })
    expect(refused.detail).toContain('读取亲密度任务失败')

    tasksScript = () => ({ unreachable: true })
    const unreachable = await run()
    expect(unreachable).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
    expect(unreachable.detail).toContain('读取亲密度任务失败')
    // The row is written to the database and rendered, so neither the token nor the jar may appear in it
    // — `callGraded` strips the values the call itself carried.
    expect(unreachable.detail).not.toContain(TOKEN)
    expect(unreachable.detail).not.toContain(WEB_COOKIES)
  })

  it('reads an empty daily list fail-closed instead of settling the day on it', async () => {
    // Not a captured shape: both real rooms listed three tasks. Two readings, and this side cannot tell
    // them apart — an account holding no 粉丝牌 in this room, or a session the service no longer treats
    // as one. `skipped` would settle the second reading as "nothing to do", which is how a dead session
    // becomes a task that looks healthy.
    tasksScript = () => ({ text: JSON.stringify({ error: 0, msg: 'ok', data: { dayTasks: [], weekTasks: [] } }) })

    const outcome = await run({ storedOptions: { giftAllowlist: [HELD_GIFT_ID] } })

    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_day_tasks', failure: 'none' })
    expect(outcome.detail).toContain('粉丝牌')
    // And nothing was bought to find out: an empty list is answered before any backpack is read.
    expect(requestsTo(BACKPACK_PATH)).toEqual([])
  })
})

describe('亲密度任务 — the judgement', () => {
  it('reports room 12306 by its own counters, and settles only what the server calls settled', async () => {
    const outcome = await run()

    // One item per daily task, named by the service's own `taskName` (a `taskType` number would be an
    // identifier, and an item's label may never be one), carrying the counter it was judged by in `code`
    // and the service's own reward declaration in `detail`.
    expect(outcome.items).toEqual([
      // `1/1` — done, and `already` rather than `done` because nothing this run did put it there. The
      // `+10` is the row's own `intimacyNum`, reported rather than assumed.
      { kind: 'room', label: '发送1条弹幕', outcome: 'already', detail: '弹幕 +10', code: '1/1' },
      // The paid row: `taskWhiteGiftId` 24478 is a paid gift, so the branch that would satisfy it does
      // not exist — a run that did it would spend the owner's money on a public donation.
      {
        kind: 'room',
        label: '送出“全力守护”礼物',
        outcome: 'skipped',
        detail: '全力守护 +25、付费礼物不代做',
        code: '0/1'
      },
      // The gifting row: the one this action may satisfy, gated on the list a person writes — and this
      // account has written none, so the sentence names that and nothing is read or sent for it.
      {
        kind: 'room',
        label: '赠送礼物',
        outcome: 'blocked',
        detail: '赠送 0/5、加成 +50、未发（还没有「允许使用的礼物」清单，这一版不会自己挑一件送）',
        code: '0/5'
      }
    ])

    // The record is the worst of its items and its `code` names which half is unfinished: the day is not
    // settled, and a person is told so without opening a log.
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_gift_allowlist', failure: 'action_stop' })
    expect(outcome.detail).toBe(
      '已结 1、未结 2（共 3 个每日任务）；赠送礼物那一半没有动手：账号里还没有「允许使用的礼物」清单，这一版不会自己挑一件送'
    )
    // The counts line is the run's audit text; the console line is the sweep's. Same facts, no repetition.
    expect(logs).toEqual(['亲密度任务：弹幕 1/1 已结、全力守护 0/1 不做、赠送 0/5 未发'])
  })

  it('reads room 12293234 as the pair room 12306 is not, at the same instant', async () => {
    const outcome = await run({ targetKey: ROOM_OPEN })

    // The same account, the same instant, the same three tasks — and every number differs. There is no
    // global "today is done" field to consult, which is why this action is per Room and why `done` means
    // *this room's* list is settled.
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_gift_allowlist', failure: 'action_stop' })
    expect(outcome.detail).toContain('已结 0、未结 3（共 3 个每日任务）')
    expect(outcome.items.map(item => item.code)).toEqual(['0/1', '0/1', '0/5'])
    expect(outcome.items.map(item => item.outcome)).toEqual(['blocked', 'skipped', 'blocked'])
  })

  it('leaves the danmaku half to 发送弹幕, and sends no message of its own', async () => {
    const outcome = await run({ targetKey: ROOM_OPEN })

    // The design decision, asserted. `send_danmaku` already sends one danmaku and the server credits this
    // task from it, so a second message from here would be a second *public* bullet for the same 10
    // 亲密度 — and someone who switched this action on without 发送弹幕 would get public messages from an
    // action named 亲密度任务.
    expect(outcome.items[0]).toMatchObject({
      label: '发送1条弹幕',
      outcome: 'blocked',
      detail: '弹幕 +10、未做（留给发送弹幕这条动作）',
      code: '0/1'
    })
    expect(sendDanmakuMock).not.toHaveBeenCalled()
    // `blocked` and never `skipped`: the day is not settled, so the sweep keeps watching the room — and it
    // sees the task settle the moment the other action lands a danmaku.
    expect(outcome.items[0]?.outcome).not.toBe('skipped')
  })

  it('judges by the counter in both directions, whatever taskStatus says', async () => {
    // `taskStatus: 1` on a `0/1` task — exactly the reading a `taskStatus`-based judgement calls done.
    // Room 12306's weekly row is this same disagreement in the captured data (`1/2 天` with `taskStatus:
    // 2`), which is why the field is not even parsed.
    tasksScript = () => ({
      text: withBody<CapturedTasks>(BODY_TASK_OPEN, payload => {
        rowAt(payload.data.dayTasks, 0, 'dayTasks')['taskStatus'] = 1
      })
    })
    const lyingStatus = await run({ targetKey: ROOM_OPEN })
    expect(lyingStatus.items[0]).toMatchObject({ outcome: 'blocked', detail: '弹幕 +10、未做（留给发送弹幕这条动作）' })

    // And the mirror: `taskStatus: 0` on a row whose counter has reached its total is settled, because the
    // counter is the whole judgement.
    tasksScript = () => ({
      text: withBody<CapturedTasks>(BODY_TASK_OPEN, payload => {
        const gift = rowAt(payload.data.dayTasks, 2, 'dayTasks')
        gift['taskNum'] = gift['taskTotal']
        gift['taskStatus'] = 0
      })
    })
    const doneCounter = await run({ targetKey: ROOM_OPEN })
    expect(doneCounter.items[2]).toMatchObject({ outcome: 'already', detail: '赠送 5/5、加成 +50', code: '5/5' })
  })

  it('never reports the weekly list, which is where the 1/2 天 trap lives', async () => {
    // A guard on the fixture first: if a later capture replaced this body with something that lost the
    // disagreement, the case below would pass for the wrong reason.
    const captured: CapturedTasks = JSON.parse(BODY_TASK_DONE)
    expect(captured.data.weekTasks[0]).toMatchObject({ taskNum: 1, taskTotal: 2, taskStatus: 2 })

    const outcome = await run()

    // Three items, all daily. A weekly row's progress moves by *days of activity*, so nothing a run does
    // today could settle one: reporting it as an outstanding task would make `done` unreachable for every
    // room, and reporting it by `taskStatus` would print 「已结」 beside 「1/2 天」.
    expect(outcome.items).toHaveLength(3)
    expect(outcome.items.map(item => item.label)).not.toContain('累计发送弹幕2天')
  })

  it('reads a room whose daily tasks are all settled as the day being done', async () => {
    // One documented mutation of a captured body: every daily counter raised to its own total.
    tasksScript = () => ({
      text: withBody<CapturedTasks>(BODY_TASK_DONE, payload => {
        for (const task of payload.data.dayTasks) task['taskNum'] = task['taskTotal']
      })
    })

    const outcome = await run({ storedOptions: { giftAllowlist: [HELD_GIFT_ID] } })

    // `already`, parked for the day: nothing was left to do, and `action_stop` is the grading every settled
    // chore gets. The record's code names the state it settled on. **An allowlist is set and nothing was
    // read for it**: with no outstanding 赠送礼物 row there is no gift to send, and a backpack read would
    // be a request bought with nothing.
    expect(outcome).toMatchObject({
      outcome: 'already',
      code: 'tasks_done',
      failure: 'action_stop',
      detail: '已结 3、未结 0（共 3 个每日任务）'
    })
    expect(outcome.items.map(item => item.detail)).toEqual(['弹幕 +10', '全力守护 +25', '赠送 5/5、加成 +50'])
    expect(requestsTo(BACKPACK_PATH)).toEqual([])
    expect(requestsTo(DONATE_PATH)).toEqual([])
  })

  it('reports a task type this build has never seen, and does not settle on a guess', async () => {
    // A fourth `taskType` is a contract change. Nothing here knows whether such a row spends, so it is
    // reported as unsettled and the action raises 动作受阻 — the safe direction is also the loud one. The
    // row is the gifting one, so what changes is its type and not its counter.
    tasksScript = () => ({
      text: withBody<CapturedTasks>(BODY_TASK_DONE, payload => {
        rowAt(payload.data.dayTasks, 2, 'dayTasks')['taskType'] = 9
      })
    })

    const outcome = await run()

    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'unknown_task_type', failure: 'action_stop' })
    expect(outcome.items[2]).toMatchObject({ outcome: 'blocked', code: '0/5' })
    expect(outcome.items[2]?.detail).toContain('这一版不认识这类任务')
  })

  it('describes a task the service did not name, instead of labelling it with its type', async () => {
    // An item's label is the one field the main UI renders, so a row the service sends no `taskName` for
    // is described rather than shown as its `taskType` — a number, which is an identifier.
    tasksScript = () => ({
      text: withBody<CapturedTasks>(BODY_TASK_OPEN, payload => {
        rowAt(payload.data.dayTasks, 0, 'dayTasks')['taskName'] = ''
      })
    })

    const outcome = await run({ targetKey: ROOM_OPEN })

    expect(outcome.items[0]).toMatchObject({ label: '未命名任务', outcome: 'blocked' })
  })

  it('reads an allowlist that cannot be parsed as no allowlist at all', async () => {
    // The safety property, and it is the same property after the gift request landed: the owner's own
    // reason for the list is 「签到等途径会送便宜的付费道具」, so the backpack holds paid items and the
    // Platform offers no first-party "free" flag — which means a list that failed to parse can only make
    // this action send *less*, never more. Every shape below therefore reports the missing list **and
    // sends nothing**: no backpack is read and no gift POST exists to be made.
    for (const broken of [null, 'giftAllowlist', { giftAllowlist: '268' }, { giftAllowlist: ['oops'] }]) {
      const outcome = await run({ storedOptions: { giftAllowlist: broken } })
      expect(outcome.code).toBe('no_gift_allowlist')
      expect(requestsTo(DONATE_PATH)).toEqual([])
    }
    expect(requestsTo(BACKPACK_PATH)).toEqual([])
  })

  it('never lets the record disagree with its own items', async () => {
    // The invariant `types.ts` states, asserted as a relation rather than per case: an item that says
    // `done` inside a record that says `failed` reads, in the UI, as "it worked".
    const bodies = [
      BODY_TASK_DONE,
      BODY_TASK_OPEN,
      withBody<CapturedTasks>(BODY_TASK_OPEN, payload => {
        rowAt(payload.data.dayTasks, 0, 'dayTasks')['taskType'] = 9
      })
    ]

    for (const body of bodies) {
      tasksScript = () => ({ text: body })
      const outcome = await run({ targetKey: ROOM_OPEN })
      expect(outcome.items.length).toBeGreaterThan(0)
      expect(outcome.items.map(item => item.outcome)).toContain(outcome.outcome)
      expect(outcome.targetKey).toBe(ROOM_OPEN)
    }

    // The same relation with a send in it: five gifts went out, so the record is `done` rather than the
    // `already` its settled 弹幕 row would otherwise give it. The script is put back first — the bodies
    // above left one of their own in place, and a run judged from it would be a different case.
    tasksScript = freshTasks()
    const sent = await runWithAllowlist()
    expect(sent.outcome).toBe('done')
    expect(sent.items.map(item => item.outcome)).toContain('done')
  })

  it('is a per-room action, so its failure item names the room it was aimed at', async () => {
    // Not an account-scoped outcome: the target is kept, because `types.ts` reserves the empty key for
    // actions that are about the account itself.
    tasksScript = () => ({ unreachable: true })
    const outcome = await run()

    expect(outcome.targetKey).toBe(ROOM_GIFT_OPEN)
    expect(outcome.items).toHaveLength(1)
    expect(outcome.items[0]).toMatchObject({ kind: 'room', label: '亲密度任务', outcome: 'failed' })
  })
})

describe('亲密度任务 — 赠送礼物', () => {
  it('sends the captured request, one gift per POST, and reads the backpack first', async () => {
    const outcome = await runWithAllowlist()

    // A guard on the fixtures first: the request this test reproduces is the captured one — prop 268, one
    // of it, this room — and the receipt that answers it is one gift further down the backpack than the
    // read that preceded it. If a later capture replaced either file, the case below would pass for the
    // wrong reason.
    expect(BODY_DONATE_REQUEST).toBe('propId=268&propCount=1&roomId=12306&bizExt=%7B%22yzxq%22%3A%7B%7D%7D')
    const read: CapturedProp = JSON.parse(BODY_BACKPACK)
    const receipt: CapturedProp = JSON.parse(BODY_DONATE_RESPONSE)
    expect(rowAt(read.data.list, 0, 'list')).toMatchObject({ id: 268, name: '粉丝荧光棒', count: 60 })
    expect(rowAt(receipt.data.list, 0, 'list')).toMatchObject({ count: 59 })

    // One backpack read, at the captured URL — `rid` is required by the endpoint and names no room of ours
    // — without a `token` header, which is what the captured pair sent and what this family's identity is.
    const backpack = requestsTo(BACKPACK_PATH)
    expect(backpack).toHaveLength(1)
    expect(backpack[0]).toMatchObject({ method: 'GET', body: '' })
    expect(new URL(backpack[0]?.url ?? '').searchParams.get('rid')).toBe(ROOM_GIFT_OPEN)
    expect(backpack[0]?.cookie).toBe(WEB_COOKIES)
    expect(backpack[0]?.token).toBeNull()

    // Five POSTs, because the row reads `0/5` — the server's own remainder, and the only number that
    // decides how many gifts this run sends. Each one is the captured request, character for character:
    // `mainsite/v5` and not the `mainsite/v1` three third-party implementations write, `propCount=1` and
    // not a batch, and the same `bizExt` nobody here has measured the meaning of.
    const sent = requestsTo(DONATE_PATH)
    expect(sent).toHaveLength(5)
    for (const call of sent) {
      expect(call.method).toBe('POST')
      expect(call.body).toBe(BODY_DONATE_REQUEST)
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
      expect(call.token).toBeNull()
      expect(call.cookie).toBe(WEB_COOKIES)
      expect(call.referer).toBe(`https://www.douyu.com/${ROOM_GIFT_OPEN}`)
    }

    // One task read, one backpack read, five gifts: no second read of the task list, and no second read of
    // the backpack — the receipt carries it.
    expect(requests).toHaveLength(7)

    // What a person reads: the act leads, the row's own numbers trail it, and nothing in this text is an
    // identifier — the anchor's name comes out of the broadcast frame and the room id stays in the console.
    const gift = giftItemOf(outcome)
    expect(gift).toEqual({
      kind: 'room',
      label: '赠送礼物',
      outcome: 'done',
      detail: '已送 5 件「粉丝荧光棒」给电棍、本次没有扣费（赠送 0/5、加成 +50）',
      code: '0/5'
    })
    for (const identifier of [ROOM_GIFT_OPEN, HELD_GIFT_ID, '310260', '456918967', TOKEN, WEB_COOKIES]) {
      expect(gift.detail).not.toContain(identifier)
    }

    // The record is `done`, and its counts stay the **server's** counters: the row still reads 「未结」 until
    // a read of the task list says otherwise, which is the next sweep's job rather than this one's claim.
    expect(outcome).toMatchObject({ outcome: 'done', code: 'gifts_sent', failure: 'none' })
    expect(outcome.detail).toBe('已结 1、未结 2（共 3 个每日任务）；赠送礼物那一半送了 5 件，这条任务本轮做完')

    // The console line says the id, which is what the request was addressed by, and the sweep's line says
    // what the run did.
    expect(logs).toHaveLength(6)
    expect(logs[0]).toBe(`赠送礼物「粉丝荧光棒」给电棍（房间 ${ROOM_GIFT_OPEN}）：本次没有扣费`)
    expect(logs[5]).toBe('亲密度任务：弹幕 1/1 已结、全力守护 0/1 不做、赠送 0/5 已送 5 件')
    expect(sendDanmakuMock).not.toHaveBeenCalled()
  })

  it('sends what the server still wants and not a gift more', async () => {
    // One documented mutation: the row wants five and has two. The bound is `taskTotal - taskNum` and
    // nothing else — a run that kept a local count of its own sends would send five here.
    tasksScript = () => ({
      text: withBody<CapturedTasks>(BODY_TASK_DONE, payload => {
        rowAt(payload.data.dayTasks, 2, 'dayTasks')['taskNum'] = 2
      })
    })

    const outcome = await runWithAllowlist()

    expect(requestsTo(DONATE_PATH)).toHaveLength(3)
    expect(giftItemOf(outcome).detail).toBe('已送 3 件「粉丝荧光棒」给电棍、本次没有扣费（赠送 2/5、加成 +50）')
    expect(outcome).toMatchObject({ outcome: 'done', code: 'gifts_sent' })
  })

  it('says the person allowed something this account does not hold, instead of sending', async () => {
    // The state that used to be indistinguishable from "no list at all". The list parses and is the
    // owner's; the account simply holds none of it today — a different next move, so a different sentence
    // and a different code. Nothing is sent: the refusal is decided *before* the first POST, which is why
    // the backpack read is the only request this run spends.
    const outcome = await runWithAllowlist([UNHELD_GIFT_ID])

    expect(requestsTo(BACKPACK_PATH)).toHaveLength(1)
    expect(requestsTo(DONATE_PATH)).toEqual([])
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_gift_held', failure: 'action_stop' })
    expect(giftItemOf(outcome).detail).toBe('赠送 0/5、加成 +50、未发（清单里的礼物今天一件也没有）')
    expect(outcome.detail).toContain('清单里的礼物今天一件都没有')
  })

  it('reads a listed gift the backpack holds zero of as not held', async () => {
    // The other way to arrive at the same state, and the one a `count` read is the whole of: the id is on
    // the list **and** in the backpack, at zero. A run that skipped the count would POST for a gift the
    // account does not have.
    backpackScript = () => ({ text: backpackHolding(0) })

    const outcome = await runWithAllowlist([HELD_GIFT_ID])

    expect(requestsTo(BACKPACK_PATH)).toHaveLength(1)
    expect(requestsTo(DONATE_PATH)).toEqual([])
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_gift_held', failure: 'action_stop' })
  })

  it('stops when the backpack runs out, and keeps the row unsettled', async () => {
    // The held item drops to one: the first receipt says the account now holds none of it, so the walk
    // stops there rather than POSTing into a wall. `blocked` — not `done` — because the day's task is not
    // finished, and the next sweep is the one that will see whether it can be.
    backpackScript = () => ({ text: backpackHolding(1) })
    donateScript = () => ({ text: receiptHolding(0) })

    const outcome = await runWithAllowlist()

    expect(requestsTo(DONATE_PATH)).toHaveLength(1)
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'gift_short', failure: 'none' })
    expect(giftItemOf(outcome).detail).toBe(
      '已送 1 件「粉丝荧光棒」给电棍、本次没有扣费、背包里没有能送的东西了（赠送 0/5、加成 +50）'
    )
    expect(outcome.detail).toContain('赠送礼物那一半没送完')
    // Nothing is reported as broken: `failure: 'none'` is what keeps this off the 动作受阻 feed.
    expect(outcome.items.map(item => item.outcome)).toContain('blocked')
  })

  it('stops at its own ceiling, and says so rather than calling the task finished', async () => {
    // The guard on a server-declared number: a row that wanted 25 gifts must not turn one sweep into 25
    // public donations. Ten is the ceiling, the run stops there, and the row stays unsettled — the counter
    // on the next read is what says how much is left.
    tasksScript = () => ({
      text: withBody<CapturedTasks>(BODY_TASK_DONE, payload => {
        rowAt(payload.data.dayTasks, 2, 'dayTasks')['taskTotal'] = 25
      })
    })

    const outcome = await runWithAllowlist()

    expect(requestsTo(DONATE_PATH)).toHaveLength(10)
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'gift_short', failure: 'none' })
    expect(giftItemOf(outcome).detail).toContain('本次最多送 10 件')
  })

  it('stops on a refusal, and tells a retry from a day worth parking by the server’s own word', async () => {
    // A refusal: the gift did not go out, so the walk stops rather than repeating a request that just
    // failed. The code is this table's, and `retryable` — read from the body, beside `settle` rather than
    // through it — is the server's own view of whether trying again is sensible.
    donateScript = () => ({ text: JSON.stringify({ error: 1234, msg: '余额不足', data: { retryable: false } }) })
    const parked = await runWithAllowlist()
    expect(parked).toMatchObject({ outcome: 'failed', code: '1234', failure: 'action_stop' })
    expect(giftItemOf(parked).detail).toContain('未送成（赠送礼物失败：余额不足）')
    // One POST and not five: the refusal is the walk's own stop, and a repeat of a request the service
    // just refused is exactly what `retryable: false` was read to avoid.
    expect(requestsTo(DONATE_PATH)).toHaveLength(1)

    // A second run, so the recorder below is read for it alone.
    requests.length = 0
    donateScript = () => ({ text: JSON.stringify({ error: 1234, msg: '稍后再试', data: { retryable: true } }) })
    const retried = await runWithAllowlist()
    expect(retried).toMatchObject({ outcome: 'failed', code: '1234', failure: 'retry' })

    // **Only `retry` may be moved.** A session verdict is a fact about the credential, and a field whose
    // position on a refusal nobody has measured may never soften it: `1002` stays `account_stop` even with
    // `retryable: true` beside it.
    requests.length = 0
    donateScript = () => ({ text: JSON.stringify({ error: 1002, msg: '用户未登录', data: { retryable: true } }) })
    const session = await runWithAllowlist()
    expect(session).toMatchObject({ outcome: 'failed', code: '1002', failure: 'account_stop' })
    expect(requestsTo(DONATE_PATH)).toHaveLength(1)
  })

  it('stops on a call that never arrived, and says the gift may have landed anyway', async () => {
    // The one failure a gift cannot be undone from: a request with no answer may have reached the room. So
    // the walk stops, the row reports what its receipts said, and the record carries the warning rather
    // than a claim about what happened.
    let served = 0
    donateScript = () => {
      served += 1
      return served === 1 ? { text: BODY_DONATE_RESPONSE } : { unreachable: true }
    }

    const outcome = await runWithAllowlist()

    expect(requestsTo(DONATE_PATH)).toHaveLength(2)
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
    expect(giftItemOf(outcome).detail).toContain('已送 1 件「粉丝荧光棒」给电棍、本次没有扣费；之后一次没能送出')
    expect(outcome.detail).toContain('那一件可能已经送出去了')
    expect(outcome.detail).not.toContain(TOKEN)
    expect(outcome.detail).not.toContain(WEB_COOKIES)
    expect(giftItemOf(outcome).detail).not.toContain(TOKEN)
  })

  it('reports a charged send as charged, and never as free', async () => {
    // No non-zero pair of these fields has ever been captured, so the sentence names the two fields and
    // their numbers instead of a currency or an amount — and it is deliberately not softened into
    // 「可能有扣费」: the endpoint either sent the two zeros or it did not.
    donateScript = () => ({
      text: withBody<CapturedProp>(BODY_DONATE_RESPONSE, payload => {
        const used = payload.data.usedProp
        if (used === undefined) throw new Error('the fixture carries no usedProp')
        used['balance'] = 120
        used['includePrice'] = 10
      })
    })

    const outcome = await runWithAllowlist()

    expect(giftItemOf(outcome).detail).toContain('usedProp.balance=120、usedProp.includePrice=10')
    expect(giftItemOf(outcome).detail).not.toContain('本次没有扣费')
  })

  it('stops the walk when a receipt names no backpack, rather than sending blind', async () => {
    // The gift is out and the receipt is not a shape this build knows. It is **not** a contract error —
    // a throw here would be reported as 「赠送失败」 for a send that happened — so the run keeps the one
    // fact it has, stops the batch, and says what it could not read: this receipt is where a gift's name, a
    // receiver and a price would have come from, and none of the three may be reported as read.
    donateScript = () => ({ text: JSON.stringify({ error: 0, msg: 'success', data: { list: [] } }) })

    const outcome = await runWithAllowlist()

    expect(requestsTo(DONATE_PATH)).toHaveLength(1)
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'gift_short', failure: 'none' })
    expect(giftItemOf(outcome).detail).toContain('扣费情况读不出来')
    expect(giftItemOf(outcome).detail).toContain('本次不再往下送')
  })

  it('still refuses the paid row, which is a gift this action may never send', async () => {
    // `taskType === 2` — 「送出“全力守护”礼物」, `taskWhiteGiftId` 24478 — is a paid gift, and success
    // would spend the owner's money on something that cannot be un-sent. Even with a list that names the
    // paid row's own id, the branch that would satisfy it does not exist.
    const outcome = await runWithAllowlist(['24478'])

    expect(outcome.items[1]).toMatchObject({
      label: '送出“全力守护”礼物',
      outcome: 'skipped',
      detail: '全力守护 +25、付费礼物不代做'
    })
    // The one id the list named is a gift nobody here holds, so the gifting half reports that — and `24478`
    // is never put on the wire by either half of this run.
    for (const call of requestsTo(DONATE_PATH)) expect(call.body).not.toContain('24478')
    expect(requestsTo(DONATE_PATH)).toEqual([])
  })
})
