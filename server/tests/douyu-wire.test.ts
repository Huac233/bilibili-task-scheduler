import { beforeEach, describe, expect, it, vi } from 'vitest'

import { douyuPlatform } from '../src/platform/douyu/index.js'
import type { ActionOutcome, PlatformAccount } from '../src/platform/types.js'
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

function freshScript(): Script {
  return {
    csrf: { json: { error: 0, msg: 'ok' } },
    poolStatus: { json: { error: 0, data: { signStatus: 0, ...MEASURED_POOL }, msg: '' } },
    // Verbatim from the live run: the join's `data` carries the pool and **no `signStatus`**,
    // because the activity page sets that to 1 itself after the join succeeds.
    join: { json: { error: 0, data: MEASURED_POOL, msg: '' } },
    // The check-in has never received a correctly-formed request, so this reply is a shape
    // nobody has seen. That is the point of the case that uses it: the adapter must not read
    // anything out of it.
    clock: { json: { error: 0, data: { nobodyHasModelledThis: 1 }, msg: '' } },
    activityStatus: { json: { error: 0, data: { todaySigned: 0 }, msg: '' } },
    activitySign: { json: { error: 31200, msg: '签到成功!', data: {} } }
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

  return new Response(JSON.stringify(answer.json), { status: 200, headers: responseHeaders })
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
    expect(outcome).toMatchObject({ outcome: 'done', code: '0', failure: 'none' })
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
