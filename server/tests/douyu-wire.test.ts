import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDatabase, openDatabase } from '../src/db/index.js'
import { ACTIVITY_SIGN_SUCCESS, classifyError } from '../src/platform/douyu/errors.js'
import { douyuPlatform } from '../src/platform/douyu/index.js'
import { GROWTH_POOL_ALREADY_CLOCKED } from '../src/platform/douyu/protocol.js'
import { startOfPlatformDay } from '../src/platform/time.js'
import type { ActionOutcome, PlatformAccount } from '../src/platform/types.js'
import { appendActionLog, settledActionKeysSince } from '../src/repo/action-logs.js'
import { ActionKey } from '../src/repo/tasks.js'

/**
 * The two endpoint flows added with the reads that gate them, driven at the wire.
 *
 * `douyu-adapter.test.ts` mocks the protocol module, which is the right boundary for
 * testing what the *adapter does* with a verdict — but it cannot see a URL, a header, or
 * a body, and three of the facts this file pins are only visible there:
 *
 *  - **the CSRF pair.** 打卡分鱼丸's `dy_token` must equal the header's `dy_cookie`, and
 *    mixing a freshly issued cookie with an older body value is what this family answers
 *    `152101` to — 25 times in a row inside one minute, in the live run that found it. A
 *    single request's shape is the only place that mistake exists.
 *  - **which read is used.** `/h5nc/userSignActivity/getSignInfo` is the latch;
 *    `/h5/SignActivity/getSignInfo` is an anonymous twin that answers `error: 0` with
 *    `signStatus: 0` to anyone, so mistaking one for the other spends 200 鱼丸 per run.
 *  - **the activity gate's narrow header set.** This family answers `999999 系统错误` the
 *    moment an extra credential is attached (§2.2), so "which headers are sent" is a
 *    behaviour and not a style question.
 *
 * Nothing here reaches the network: `fetch` is stubbed and every reply is scripted below.
 * The protocol module and the adapter are both real, so what is exercised is the code that
 * will run, from the URL up.
 */

const TOKEN = '123456789_1_abcdef0123456789_0_69117311'
const DID = '20e8917f4ebe85866a5e94cfaba2f156'

/** Shanghai 06:22 on 2026-10-08 — outside 打卡分鱼丸's 19:00–21:00 check-in window. */
const BEFORE_WINDOW = 1_791_411_776_000

/** Shanghai 2026-10-09 19:30 — inside it. */
const INSIDE_CLOCK_WINDOW = Date.parse('2026-10-09T11:30:00Z')

function account(): PlatformAccount {
  return {
    id: 7,
    platform: 'douyu',
    externalId: '123456789',
    displayName: 'tester',
    avatar: '',
    credentials: JSON.stringify({ token: TOKEN, did: DID }),
    meta: '{}'
  }
}

/** One request as it left this process, before the stub answered it. */
interface Recorded {
  readonly url: string
  readonly method: string
  readonly headers: readonly string[]
  readonly token: string | null
  readonly cookie: string | null
  readonly body: string
}

/** A scripted reply. `setCookie` is what makes the CSRF half of the flow possible at all. */
interface Scripted {
  readonly json: unknown
  readonly setCookie?: string
  /** A reply as the service wrote it, byte for byte. Wins over `json` when present. */
  readonly text?: string
}

const CSRF_PATH = '/h5nc/csrf/getCsrfCookie'
const POOL_STATUS_PATH = '/h5nc/userSignActivity/getSignInfo'
const POOL_JOIN_PATH = '/h5nc/userSignActivity/joinSignActivity'
const POOL_CLOCK_PATH = '/h5nc/userSignActivity/clockSignActivity'
const ACTIVITY_STATUS_PATH = '/japi/carnivalApi/nc/sign/getStatus'
const ACTIVITY_SIGN_PATH = '/japi/carnivalApi/sign/doSign'

const requests: Recorded[] = []

/**
 * Mints a different `dy_cookie` on every call, and counts the mints.
 *
 * Both halves matter. A different value per call is what lets a test show that a second run
 * re-paired instead of reusing the first run's value — which is the whole difference
 * between a retry and a repeat of the mistake. The count is what makes "it minted again"
 * an assertion rather than an inference.
 */
let mints = 0

function mintedCookie(): string {
  mints += 1
  return `dy_cookie=${String(mints).padStart(32, '0')}`
}

/** What each endpoint answers on this run. A test replaces the entry it is about. */
interface Script {
  csrf: Scripted
  poolStatus: Scripted
  join: Scripted
  clock: Scripted
  activityStatus: Scripted
  activitySign: Scripted
}

let script: Script

/** The pool's own numbers, as the live run of 2026-10-08 reported them. */
const MEASURED_POOL = { ywTotal: 38400, joinTotal: 192, clockLeftTime: 107999 }

/**
 * The check-in as it was measured on the evening of 2026-10-09 — one account (already 已报名),
 * one night, no room (this family is per account), and every field read off the service rather
 * than off a run.
 *
 * Three named reads rather than one fixture, because the *movement* between them is the fact:
 * the latch clears (`1` → `0`), and the pool pair is replaced wholesale at the check-in
 * (`884800`/`4424` → `78400`/`392` — one entry fee per joiner, 200 鱼丸 each, which is why the
 * same two fields describe a different round rather than a loss). The join that follows answers
 * the round it belongs to: `78800`/`394`. Nothing here asserts the arithmetic itself: Douyu sets
 * that ratio, and a test built on it would go red on a fact this repository does not own.
 */
const BEFORE_CHECK_IN = { signStatus: 1, ywTotal: 884800, joinTotal: 4424 }
const AFTER_CHECK_IN = { signStatus: 0, ywTotal: 78400, joinTotal: 392 }
const AFTER_JOIN = { ywTotal: 78800, joinTotal: 394 }

/**
 * The latch the two `57004` runs of 2026-10-09 19:45 and 19:50 read, verbatim.
 *
 * `signStatus` is still `1` — 已报名 for a round — which is why those runs reached the check-in half
 * at all, and the pool pair is a **different round's** entries rather than the `884800`/`4424` that
 * tonight's check-in closed out. Together with the `0` that same call answered at 19:00:20, this is
 * the whole state that explains the code: a latch saying the account is in a round, and a check-in
 * that had already landed for today.
 */
const ALREADY_CLOCKED_STATE = { signStatus: 1, ywTotal: 596400, joinTotal: 2982 }

/**
 * The one `doSign` body this repo holds from the service, verbatim.
 *
 * Read out of `captured/` rather than retyped as an object literal, and that is the point of the
 * directory: this body carries a field no version of this code models (`redirectUrl`), which is exactly
 * what a hand-written stub loses. `.gitattributes` keeps the file byte-exact (`-text`), so what the stub
 * answers below is what Douyu answered.
 */
const CAPTURED_SIGN_SUCCESS = readFileSync(
  new URL('./captured/douyu-activity-sign-31200.json', import.meta.url),
  'utf8'
)

function freshScript(): Script {
  return {
    csrf: { json: { error: 0, msg: 'ok' } },
    poolStatus: { json: { error: 0, data: { signStatus: 0, ...MEASURED_POOL }, msg: '' } },
    // Verbatim from the live run: the join's `data` carries the pool and **no `signStatus`**,
    // because the activity page sets that to 1 itself after the join succeeds.
    join: { json: { error: 0, data: MEASURED_POOL, msg: '' } },
    // A reply the adapter must not read: the one measured success (2026-10-09) carried the new
    // round's pool pair and nothing else, and this one deliberately names a field that is neither
    // of those — the case below asserts the run succeeds on the code alone. The comment here used
    // to say no correctly-formed request had ever landed on this endpoint; one has now, and the
    // point of the fixture did not change with it.
    clock: { json: { error: 0, data: { nobodyHasModelledThis: 1 }, msg: '' } },
    activityStatus: { json: { error: 0, data: { todaySigned: 0 }, msg: '' } },
    // The activity's own success answer, as captured on 2026-10-09 03:20:35 — not a paraphrase of it.
    activitySign: { json: {}, text: CAPTURED_SIGN_SUCCESS }
  }
}

function scriptedFor(path: string): Scripted {
  if (path === CSRF_PATH) return { ...script.csrf, setCookie: mintedCookie() }
  if (path === POOL_STATUS_PATH) return script.poolStatus
  if (path === POOL_JOIN_PATH) return script.join
  if (path === POOL_CLOCK_PATH) return script.clock
  if (path === ACTIVITY_STATUS_PATH) return script.activityStatus
  if (path === ACTIVITY_SIGN_PATH) return script.activitySign
  // The path alone, never the URL: a query string on this transport carries the token.
  throw new Error(`unscripted request to ${path}`)
}

/**
 * The stub, typed to the one shape this module's callers use: a string URL and an init.
 *
 * `RequestInfo` is not in scope here — this package typechecks without the DOM lib — and a
 * looser signature would only need a cast back at the one call site that installs it.
 */
async function fetchStub(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input.toString()
  const headers = new Headers(init?.headers ?? {})
  const parsed = new URL(url)

  requests.push({
    url,
    method: init?.method ?? 'GET',
    headers: [...headers.keys()].sort(),
    token: headers.get('token'),
    cookie: headers.get('cookie'),
    body: typeof init?.body === 'string' ? init.body : ''
  })

  const answer = scriptedFor(parsed.pathname)
  const responseHeaders = new Headers({ 'content-type': 'application/json' })
  if (answer.setCookie !== undefined) responseHeaders.set('set-cookie', answer.setCookie)

  // A captured reply goes back as the bytes it arrived as; only a made-up one is serialised here.
  const body = answer.text ?? JSON.stringify(answer.json)
  return new Response(body, { status: 200, headers: responseHeaders })
}

beforeEach(() => {
  requests.length = 0
  mints = 0
  script = freshScript()
  vi.stubGlobal('fetch', fetchStub)
})

/** Every request whose path is this one. */
function sentTo(path: string): Recorded[] {
  return requests.filter(recorded => new URL(recorded.url).pathname === path)
}

/** The one request to this path, failing loudly if the run sent none or several. */
function onlyRequestTo(path: string): Recorded {
  const found = sentTo(path)
  if (found.length !== 1) throw new Error(`expected exactly one request to ${path}, saw ${String(found.length)}`)
  const [first] = found
  if (first === undefined) throw new Error(`no request to ${path}`)
  return first
}

/**
 * The CSRF pair as one request carried it, read back where the service reads it.
 *
 * A helper rather than three inline parses, because the assertion "these two are equal" is
 * the *point* of this file and it should read as one sentence at each call site.
 */
function pairOf(recorded: Recorded): { cookie: string | null; dyToken: string | null } {
  const cookie = recorded.cookie === null ? null : (recorded.cookie.split('dy_cookie=')[1] ?? null)
  const dyToken = new URLSearchParams(recorded.body).get('dy_token')
  return { cookie, dyToken }
}

async function reconcile(enabledActions: readonly string[], now: number): Promise<ActionOutcome[]> {
  return await douyuPlatform.reconcile({
    account: account(),
    targetKey: '',
    enabledActions,
    // Every case in this file is about the wire, and none of the actions it drives reads an option.
    options: {},
    now,
    dayKey: '2026-10-08',
    log: () => undefined
  })
}

async function outcomeOf(enabledActions: readonly string[], now: number): Promise<ActionOutcome> {
  const found = (await reconcile(enabledActions, now)).find(outcome => outcome.actionKey === enabledActions[0])
  if (found === undefined) throw new Error(`no outcome for ${String(enabledActions[0])}`)
  return found
}

/**
 * Whether `runner.ts`'s `settledToday` would stop asking about this outcome for the rest of the day.
 *
 * Written through the two real functions instead of as a list of outcome names repeated here:
 * `settledToday` is `settledActionKeysSince` over a Platform-day range, and that query judges every
 * stored row through `repo/action-logs.ts`'s own settled set. So this is the chain the sweep reads —
 * one write, one query — and an outcome outside that set answers `false` here.
 *
 * The three parent rows are written as rows, the way `action-logs.test.ts`'s own `seed` writes them:
 * `action_logs.task_id` has a foreign key, and the repositories that would build these want a user,
 * an account and a Task behind them. This file drives the wire; the subject here is one outcome value.
 */
function settledForTheDay(outcome: ActionOutcome, now: number): boolean {
  const db = openDatabase(':memory:')
  try {
    db.prepare("INSERT INTO users (username, password_hash, created_at, updated_at) VALUES ('tester', 'x', 0, 0)").run()
    db.prepare(
      `INSERT INTO accounts (user_id, platform, external_id, display_name, avatar, credentials, meta, created_at, updated_at)
       VALUES (1, 'douyu', '456918967', '', '', '{}', '{}', 0, 0)`
    ).run()
    db.prepare(
      `INSERT INTO tasks (
         id, user_id, platform, account_id, library_id, action, action_key, target_key, target_title,
         start_time, end_time, interval, status, created_at, updated_at
       ) VALUES (1, 1, 'douyu', 1, NULL, 'reconcile', 'growth_pool', '', '', 0, 86400000, 86400, 'running', 0, 0)`
    ).run()
    appendActionLog(
      db,
      {
        taskId: 1,
        actionKey: outcome.actionKey,
        targetKey: outcome.targetKey,
        outcome: outcome.outcome,
        detail: outcome.detail,
        code: outcome.code,
        items: outcome.items
      },
      now
    )
    return settledActionKeysSince(db, 1, startOfPlatformDay(now)).includes(outcome.actionKey)
  } finally {
    closeDatabase()
  }
}

/* ------------------------------------------------------------------ *
 * The activity sign-in gate
 * ------------------------------------------------------------------ */

describe('the activity sign-in gate', () => {
  it('reads getStatus with the token and nothing else that identifies a session', async () => {
    await reconcile([ActionKey.ActivitySign], BEFORE_WINDOW)

    const gate = onlyRequestTo(ACTIVITY_STATUS_PATH)

    // The alias is a request parameter, and the query is where this endpoint wants it.
    expect(gate.url).toContain('signAlias=20250521OPFOY_qd2')
    expect(gate.method).toBe('GET')
    expect(gate.token).toBe(TOKEN)
    // The measured shape, and the reason the gate is worth a call of its own: no cookie, no
    // origin, no referer, no csrf. An extra credential is what turns this family's answer
    // into `999999 系统错误` (§2.2), and a read that acquires the habit would fail for a
    // reason nobody would connect back to it.
    expect(gate.headers).toEqual(['accept', 'token', 'user-agent'])
  })

  it('signs after the gate says today is not signed', async () => {
    const outcome = await outcomeOf([ActionKey.ActivitySign], BEFORE_WINDOW)

    expect(sentTo(ACTIVITY_SIGN_PATH)).toHaveLength(1)
    expect(outcome).toMatchObject({ outcome: 'done', code: '31200', failure: 'none' })
  })

  it('takes the captured 31200 as today’s signature, and reads no reward out of it', async () => {
    const outcome = await outcomeOf([ActionKey.ActivitySign], BEFORE_WINDOW)

    // The name is asserted through the constant rather than as a bare number, so the reading this
    // test pins is the one the code states. It moved once: `31200` was named for 「签到成功无礼包」
    // (the page's enum entry), and the capture settled the other direction — the service's own `msg`
    // is 「签到成功!」 and the same second's ledger entry is 「签到礼包」. So the code means the
    // signature landed, and `classifyError` parks the day on it because there is nothing left to do.
    expect(outcome).toMatchObject({ outcome: 'done', failure: 'none' })
    expect(outcome.code).toBe(String(ACTIVITY_SIGN_SUCCESS))
    expect(classifyError(ACTIVITY_SIGN_SUCCESS)).toBe('action_stop')

    // And the body is still not a receipt: `data: {}` is what the capture answered for this endpoint,
    // so the 20 积分 that did land is a fact from the ledger — a read this action does not make. A
    // detail naming a figure would be inventing one.
    expect(outcome.detail).not.toMatch(/积分|礼包/)
  })

  it('sends an empty csrfToken and no cookie — the shape a live run has signed with, not the page’s', async () => {
    await reconcile([ActionKey.ActivitySign], BEFORE_WINDOW)

    const sign = onlyRequestTo(ACTIVITY_SIGN_PATH)

    // Deliberately *not* the captured request's shape, and the difference is recorded rather than
    // drifting: the page mints a token first (`POST /japi/carnival/nc/common/generateCsrf` answers
    // `Set-Cookie: cvl_csrf_token` with `Max-Age=300`) and then sends it in **both** places — the cookie
    // header and this field. This build holds no web session and sends the field empty with no cookie,
    // which is the shape the 2026-10-08 ledger entry (`签到礼包 +20`) is attributed to.
    expect(sign.body).toBe('csrfToken=&signAlias=20250521OPFOY_qd2&useJiYan=false')
    expect(sign.cookie).toBeNull()
    expect(sign.headers).toEqual([
      'accept',
      'content-type',
      'origin',
      'referer',
      'token',
      'user-agent',
      'x-requested-with'
    ])
  })

  it('skips the write entirely when today is already signed', async () => {
    script.activityStatus = { json: { error: 0, data: { todaySigned: 1 }, msg: '' } }

    const outcome = await outcomeOf([ActionKey.ActivitySign], BEFORE_WINDOW)

    expect(sentTo(ACTIVITY_SIGN_PATH)).toHaveLength(0)
    expect(outcome).toMatchObject({ outcome: 'already', failure: 'action_stop' })
    expect(outcome.code).toBe('0')
  })

  it('grades the gate’s 300 as account_stop without quoting the credential', async () => {
    script.activityStatus = { json: { error: 300, msg: '请登录' } }

    const outcome = await outcomeOf([ActionKey.ActivitySign], BEFORE_WINDOW)

    expect(outcome).toMatchObject({ outcome: 'failed', code: '300', failure: 'account_stop' })
    expect(sentTo(ACTIVITY_SIGN_PATH)).toHaveLength(0)
    // The one thing a failure message may never contain. The composite token travels in the
    // `token` header and in every `apiv2` query string, and this string is rendered.
    expect(outcome.detail).not.toContain(TOKEN)
    expect(outcome.detail).not.toContain('token=')
  })
})

/* ------------------------------------------------------------------ *
 * 打卡分鱼丸
 * ------------------------------------------------------------------ */

describe('打卡分鱼丸 at the wire', () => {
  it('pairs the body’s dy_token with the header’s dy_cookie on every write', async () => {
    await reconcile([ActionKey.GrowthPool], BEFORE_WINDOW)

    const issued = onlyRequestTo(CSRF_PATH)
    const read = onlyRequestTo(POOL_STATUS_PATH)
    const join = onlyRequestTo(POOL_JOIN_PATH)

    // The bootstrap itself carries no cookie: it is what issues one.
    expect(issued.cookie).toBeNull()
    expect(issued.token).toBe(TOKEN)

    // The pair, twice. Unequal or missing is what `152101 请求异常` means.
    expect(pairOf(read)).toEqual({
      cookie: '00000000000000000000000000000001',
      dyToken: '00000000000000000000000000000001'
    })
    expect(pairOf(join)).toEqual({
      cookie: '00000000000000000000000000000001',
      dyToken: '00000000000000000000000000000001'
    })
    // And the token travels in the body here, not in the URL, because this family reads it
    // there — the query-string habit belongs to `h5nc/sign/*`.
    expect(new URLSearchParams(join.body).get('token')).toBe(TOKEN)
  })

  it('never falls back to the anonymous twin, which answers “not joined” to anybody', async () => {
    await reconcile([ActionKey.GrowthPool], BEFORE_WINDOW)

    // `/h5/SignActivity/getSignInfo` answers `error: 0` with `signStatus: 0` even with no
    // credential at all, so a run that read it would re-join — and re-spend 200 鱼丸 —
    // every single time. The latch is only ever this endpoint's answer.
    expect(requests.some(recorded => new URL(recorded.url).pathname === '/h5/SignActivity/getSignInfo')).toBe(false)
    expect(onlyRequestTo(POOL_STATUS_PATH).method).toBe('POST')
  })

  it('reads the latch before writing, and does not clock off a join reply that carries none', async () => {
    const outcome = await outcomeOf([ActionKey.GrowthPool], BEFORE_WINDOW)

    // Order is the whole safety property: the latch is read first, and the join reply has no
    // latch in it to read.
    expect(requests.map(recorded => new URL(recorded.url).pathname)).toEqual([
      CSRF_PATH,
      POOL_STATUS_PATH,
      POOL_JOIN_PATH
    ])
    expect(sentTo(POOL_CLOCK_PATH)).toHaveLength(0)
    expect(outcome).toMatchObject({ outcome: 'done', code: '0', failure: 'none' })
  })

  it('sends the check-in inside the window, and reads nothing out of its reply', async () => {
    script.poolStatus = { json: { error: 0, data: { signStatus: 1, ...MEASURED_POOL }, msg: '' } }

    const outcome = await outcomeOf([ActionKey.GrowthPool], INSIDE_CLOCK_WINDOW)

    const clock = onlyRequestTo(POOL_CLOCK_PATH)
    expect(pairOf(clock)).toEqual({
      cookie: '00000000000000000000000000000001',
      dyToken: '00000000000000000000000000000001'
    })
    expect(sentTo(POOL_JOIN_PATH)).toHaveLength(0)
    // The reply above names a field no version of this code knows. The run succeeds on the
    // code alone, which is what "the shape has never been captured, so do not depend on it"
    // has to mean in practice.
    expect(outcome).toMatchObject({ outcome: 'blocked', code: '0', failure: 'none' })
    // `blocked` and not `done` is the check-in half of the day being left open: the code above *is*
    // the clock's own success code, and the row is what tells the sweep to come back and land the
    // 报名 that follows. Nothing here reads the reply's body — the field it carries is not named.
    expect(outcome.detail).not.toContain('nobodyHasModelledThis')
  })

  it('re-pairs on a retry instead of resending the pair that was refused', async () => {
    script.join = { json: { error: 152101, msg: '请求异常' } }

    const first = await outcomeOf([ActionKey.GrowthPool], BEFORE_WINDOW)
    expect(first).toMatchObject({ outcome: 'failed', code: '152101', failure: 'retry' })

    const second = await outcomeOf([ActionKey.GrowthPool], BEFORE_WINDOW)
    expect(second).toMatchObject({ outcome: 'failed', code: '152101', failure: 'retry' })

    // Two runs, two mints, and the second run's pair is a *different* value — the property
    // that makes a retry a re-pairing. Reusing the first run's cookie would reproduce the
    // refusal whatever else changed, which is exactly what the live run saw for 25 attempts.
    expect(sentTo(CSRF_PATH)).toHaveLength(2)
    expect(mints).toBe(2)

    const joins = sentTo(POOL_JOIN_PATH)
    expect(joins).toHaveLength(2)
    const [firstJoin, secondJoin] = joins
    if (firstJoin === undefined || secondJoin === undefined) throw new Error('a run made no join request')
    expect(pairOf(firstJoin)).toEqual({
      cookie: '00000000000000000000000000000001',
      dyToken: '00000000000000000000000000000001'
    })
    expect(pairOf(secondJoin)).toEqual({
      cookie: '00000000000000000000000000000002',
      dyToken: '00000000000000000000000000000002'
    })
  })

  it('writes nothing at all when the latch is a value this build does not know', async () => {
    script.poolStatus = { json: { error: 0, data: { signStatus: 7 }, msg: '' } }

    const outcome = await outcomeOf([ActionKey.GrowthPool], BEFORE_WINDOW)

    // The fail-closed direction that costs nothing: a latch nobody has seen is not read as
    // "not joined", because that reading spends 200 鱼丸 on a guess.
    expect(sentTo(POOL_JOIN_PATH)).toHaveLength(0)
    expect(sentTo(POOL_CLOCK_PATH)).toHaveLength(0)
    expect(outcome).toMatchObject({ outcome: 'blocked', code: '7', failure: 'none' })
  })

  it('parks the day, rather than looping, when the balance cannot pay the entry fee', async () => {
    script.join = { json: { error: 57002, msg: '你的鱼丸不足200 无法参与打卡挑战' } }

    const outcome = await outcomeOf([ActionKey.GrowthPool], BEFORE_WINDOW)

    expect(outcome).toMatchObject({ outcome: 'blocked', code: '57002', failure: 'action_stop' })
    expect(outcome.detail).toContain('鱼丸不足 200')
  })

  it('keeps asking when the service says the window is shut, instead of parking the day', async () => {
    // Measured 2026-10-09: `clockSignActivity` answered 57005 at 18:45 and `0` at 19:00:20, so this
    // is the endpoint's "the window is not open right now" and not a verdict about the account.
    // A run only ever sees it *after* its own `withinLocalWindow` gate has said 19:00–21:00 is
    // open, so what it actually reports is a disagreement between two clocks.
    script.poolStatus = { json: { error: 0, data: { ...BEFORE_CHECK_IN }, msg: '' } }
    script.clock = { json: { error: 57005, msg: '' } }

    const outcome = await outcomeOf([ActionKey.GrowthPool], INSIDE_CLOCK_WINDOW)

    expect(sentTo(POOL_CLOCK_PATH)).toHaveLength(1)
    expect(outcome).toMatchObject({ outcome: 'blocked', code: '57005', failure: 'retry' })
    // `blocked` is not settled, and `retry` does not park the task: the sweep has to come back for
    // the window that is still open on this side, because a parked day forfeits the round — all
    // 200 鱼丸 — over what is usually a skew of seconds.
    expect(outcome.outcome).not.toBe('skipped')
    expect(outcome.failure).not.toBe('action_stop')
    expect(outcome.detail).toContain('下一次运行再试')
    expect(outcome.detail).not.toContain('需要重新绑定')
  })

  it('takes 57004 as today’s card already in place, and settles the day on it', async () => {
    // 2026-10-09 19:45 and 19:50, the owner's own runs: the check-in had landed at 19:00:20, the
    // latch still said 已报名, and `clockSignActivity` answered this — with an empty `msg`, twice.
    // The same pair of runs is what a later round of the day looks like *after* the fix, when it
    // gets that far: the check-in lands, the next sweep joins the new round, and the sweeps after
    // the join read a latch of `1` and reach the clock half again. Either way the number means the
    // same thing and settles the day; what changed is that it is no longer the only way an evening
    // can end.
    script.poolStatus = { json: { error: 0, data: ALREADY_CLOCKED_STATE, msg: '' } }
    script.clock = { json: { error: GROWTH_POOL_ALREADY_CLOCKED, msg: '' } }

    const outcome = await outcomeOf([ActionKey.GrowthPool], INSIDE_CLOCK_WINDOW)

    expect(sentTo(POOL_CLOCK_PATH)).toHaveLength(1)
    // 业主读到的那一句是「打卡失败」，而这一天是打过的 —— 一句话讲一个代码没观察到的状态。
    // `already` 是这份记录里「今天的义务已经履行」的那个取值（客户端签到、活动签到、鱼丸都用它）。
    expect(outcome).toMatchObject({
      outcome: 'already',
      code: String(GROWTH_POOL_ALREADY_CLOCKED),
      failure: 'action_stop'
    })
    expect(outcome.detail).toContain('已打卡')
    expect(outcome.detail).not.toContain('打卡失败')
    // 一个写请求都没有：这一趟是读出来「已经打过」，不是再打一次。
    expect(sentTo(POOL_JOIN_PATH)).toHaveLength(0)
    expect(sentTo(CSRF_PATH)).toHaveLength(1)
    // 而这一天真的停下来了：`already` 在落定的三个取值里，所以 `runner.ts` 的 `settledToday` 从下一轮
    // 起不再问这条动作 —— 否则它会每隔一轮报一次「失败」到当晚结束，而什么都没坏。
    expect(settledForTheDay(outcome, INSIDE_CLOCK_WINDOW)).toBe(true)
  })

  it('leaves the day UNSETTLED after a check-in, so a later sweep lands the next round’s 报名', async () => {
    // The defect the owner reported on 2026-10-10, at the wire and with tonight's own numbers.
    // 「到19:00打卡瓜分完就没有动作了 不会自动报名下一轮」 — and the loss is a real one: a sign-up
    // makes the *next* day's window available, so a re-join deferred to the next platform day
    // skips a whole day of check-in eligibility and the 200 鱼丸 paid for that round buys nothing.
    //
    // Three sweeps now, in the order the real ones run. Sweep 1 reads the latch at `1` and clocks.
    // Sweep 2 — the very next one — reads the `0` the check-in left behind and joins. Sweep 3
    // reads the `1` that join put back, finds the window shut, and writes nothing.
    script.poolStatus = { json: { error: 0, data: { ...BEFORE_CHECK_IN }, msg: '' } }
    script.clock = { json: { error: 0, data: { ywTotal: 78400, joinTotal: 392 }, msg: '' } }

    const clocked = await outcomeOf([ActionKey.GrowthPool], INSIDE_CLOCK_WINDOW)

    // The clock half did land, and the sentence says so — the record must not read as a failure
    // for a run that checked the account in.
    expect(clocked.detail).toContain('已打卡')
    expect(clocked.detail).not.toContain('打卡失败')
    expect(clocked.code).toBe('0')
    // What it is *not* is settled. `done`, `already` and `skipped` are the three values
    // `runner.ts`'s `settledToday` reads, and a settled row here is exactly the behaviour that
    // stops the sweep for the rest of the day — after which the 报名 below never happens.
    expect(clocked.outcome).not.toBe('done')
    expect(clocked.outcome).not.toBe('already')
    expect(clocked.outcome).not.toBe('skipped')
    expect(settledForTheDay(clocked, INSIDE_CLOCK_WINDOW)).toBe(false)
    // The clock landed on the wire, and the join did not: this run did one half.
    expect(sentTo(POOL_CLOCK_PATH)).toHaveLength(1)
    expect(sentTo(POOL_JOIN_PATH)).toHaveLength(0)

    // The latch the check-in leaves behind, as the live probe of 2026-10-09 measured it.
    script.poolStatus = { json: { error: 0, data: { ...AFTER_CHECK_IN }, msg: '' } }
    script.join = { json: { error: 0, data: { ...AFTER_JOIN }, msg: '' } }

    const joined = await outcomeOf([ActionKey.GrowthPool], INSIDE_CLOCK_WINDOW)

    expect(joined).toMatchObject({ outcome: 'done', code: '0' })
    // The join reply's two counters reach exactly one sentence, and it names them 本场奖池 /
    // 人已报名: the night's own reads are what proved that pair is the pool and not a balance.
    expect(joined.detail).toContain('本场奖池')
    expect(joined.detail).toContain('78800')
    // And this is what closes the day: the row the join writes is the settled one, so no later
    // sweep asks about this action until the Platform's day rolls over.
    expect(settledForTheDay(joined, INSIDE_CLOCK_WINDOW)).toBe(true)
    expect(sentTo(POOL_CLOCK_PATH)).toHaveLength(1)
    expect(sentTo(POOL_JOIN_PATH)).toHaveLength(1)

    // Sweep 3, on the state sweeps 1 and 2 left behind: the join put the latch back to `1`, so this
    // run is registered for a new round and the only question is its window. Here it is not open
    // yet — every sweep from the join until the next day's 19:00 looks exactly like this — so the
    // run parks without a write and the round just entered is not clocked a day early.
    script.poolStatus = { json: { error: 0, data: { ...BEFORE_CHECK_IN }, msg: '' } }

    const parked = await outcomeOf([ActionKey.GrowthPool], BEFORE_WINDOW)

    expect(parked).toMatchObject({ outcome: 'blocked', code: 'window_not_open', failure: 'none' })
    expect(parked.detail).toContain('19:00–21:00')
    expect(settledForTheDay(joined, INSIDE_CLOCK_WINDOW)).toBe(true)
    expect(sentTo(POOL_CLOCK_PATH)).toHaveLength(1)
    expect(sentTo(POOL_JOIN_PATH)).toHaveLength(1)
  })

  it('re-offers neither half after the re-join lands, because the join is what settles the day', async () => {
    // The same three sweeps, with the settle question asked in the direction that costs money: a
    // join is reachable *only* from a `0` latch, and the join itself is what turns the latch back
    // into `1`. The join count is the assertion, so a design that could reach 报名 twice inside one
    // round would have to show two join requests here.
    script.poolStatus = { json: { error: 0, data: { ...BEFORE_CHECK_IN }, msg: '' } }
    script.clock = { json: { error: 0, data: {}, msg: '' } }

    const clocked = await outcomeOf([ActionKey.GrowthPool], INSIDE_CLOCK_WINDOW)
    expect(settledForTheDay(clocked, INSIDE_CLOCK_WINDOW)).toBe(false)

    // Every read from here on reports the round the join entered — `1` — which is the state the
    // service is in once 报名 has been accepted.
    script.poolStatus = { json: { error: 0, data: { ...AFTER_CHECK_IN }, msg: '' } }
    script.join = { json: { error: 0, data: { ...AFTER_JOIN }, msg: '' } }
    const joined = await outcomeOf([ActionKey.GrowthPool], INSIDE_CLOCK_WINDOW)
    expect(joined.outcome).toBe('done')
    expect(settledForTheDay(joined, INSIDE_CLOCK_WINDOW)).toBe(true)

    // The late sweeps of that day, on the state the join created: the latch says 已报名 again — for
    // the round just entered — so they reach the check-in half and the service answers 57004, which
    // settles the day. This is the shape the owner's own 19:45 and 19:50 runs took, one round later.
    script.poolStatus = { json: { error: 0, data: { ...ALREADY_CLOCKED_STATE }, msg: '' } }
    script.clock = { json: { error: GROWTH_POOL_ALREADY_CLOCKED, msg: '' } }

    const later = await outcomeOf([ActionKey.GrowthPool], INSIDE_CLOCK_WINDOW)

    expect(later).toMatchObject({ outcome: 'already', failure: 'action_stop' })
    expect(settledForTheDay(later, INSIDE_CLOCK_WINDOW)).toBe(true)
    // One join for one round, whatever the sweep does afterwards: the join of the third round is
    // not reachable from a `1` latch, and the row above is the day's own stop.
    expect(sentTo(POOL_JOIN_PATH)).toHaveLength(1)
  })

  it('reports the closed window without a write, and says when it opens', async () => {
    script.poolStatus = { json: { error: 0, data: { signStatus: 1, ...MEASURED_POOL }, msg: '' } }

    const outcome = await outcomeOf([ActionKey.GrowthPool], BEFORE_WINDOW)

    expect(sentTo(POOL_CLOCK_PATH)).toHaveLength(0)
    // `blocked` and not `skipped`: the scheduler settles `skipped`, and a settled day would
    // never come back for the only window this action has.
    expect(outcome).toMatchObject({ outcome: 'blocked', code: 'window_not_open', failure: 'none' })
    expect(outcome.detail).toContain('19:00–21:00')
    expect(outcome.detail).not.toContain(TOKEN)
  })
})
