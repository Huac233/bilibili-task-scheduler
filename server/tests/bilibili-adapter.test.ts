import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BiliHttpError } from '../src/bilibili/http.js'
import { RoomRefusedError } from '../src/bilibili/live.js'
import { navSchema } from '../src/bilibili/types.js'
import { bilibiliPlatform } from '../src/platform/bilibili/index.js'
import { TargetRefusalKind } from '../src/platform/target.js'
import type { FailureKind, PlatformAccount, ReconcileContext } from '../src/platform/types.js'
import { ActionKey, TaskAction } from '../src/repo/tasks.js'

/**
 * The Bilibili adapter, tested at the seam.
 *
 * The network is mocked at exactly the boundaries this adapter has: `live.js` —
 * one HTTP call each in `resolveRoom` / `fetchAnchorName` / `fetchRoomInfo` /
 * `sendDanmaku` — and the
 * global `fetch`, which the session check (`auth.ts`'s `fetchNav`) really goes
 * through. The adapter itself is the real one, and so is `navSchema`, which is why
 * the rejection-envelope case below can pin the schema's optional `data` rather
 * than a mock of it.
 *
 * What this file is *for* is the grading. Everything that turns a Platform number
 * into a `FailureKind` lives in `platform/bilibili/index.ts`, and the seam means
 * the scheduler can only act on the verdict — so if the verdict is wrong, nothing
 * upstream can notice. The cases below are the ones a future edit is most likely to
 * break: three codes that mean three different things and must not be graded alike
 * (房间全员禁言, 账号被封禁, 登录态失效 — the last two are both account-level and only one of
 * them is a credential problem), an unknown code that must not be guessed at, and a room
 * failure whose message happens to contain `-101`, which is exactly the substring match this
 * refactor removed.
 *
 * Nothing here touches a real account or a real room.
 */

const { resolveRoomMock, fetchAnchorNameMock, fetchRoomInfoMock, sendDanmakuMock, fetchMock } = vi.hoisted(() => ({
  resolveRoomMock: vi.fn(),
  fetchAnchorNameMock: vi.fn(),
  fetchRoomInfoMock: vi.fn(),
  sendDanmakuMock: vi.fn(),
  fetchMock: vi.fn()
}))

vi.mock('../src/bilibili/live.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/bilibili/live.js')>()
  // `isLive` and `WbiKeyStore` stay real: the 1/0 normalisation is the adapter's
  // own promise to the scheduler, so asserting it against a mock would be circular.
  return {
    ...actual,
    resolveRoom: resolveRoomMock,
    fetchAnchorName: fetchAnchorNameMock,
    fetchRoomInfo: fetchRoomInfoMock,
    sendDanmaku: sendDanmakuMock
  }
})

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The blob shape `platform/bilibili/session.ts` documents: a cookie jar inside JSON. */
const CREDENTIALS = JSON.stringify({
  cookies: JSON.stringify({ SESSDATA: 'sessdata-value', bili_jct: 'csrf-value', DedeUserID: '987654' }),
  refreshToken: ''
})

/** A blob with no cookie jar: unreadable, and fixable only by a person re-binding. */
const UNREADABLE_CREDENTIALS = '{}'

/**
 * The Anchor's name, as the read that answers it returns one.
 *
 * The reported case's own pair, and the reason this file has a name fixture at all: room `84074`'s
 * 标题 was 「贴人」 — the broadcast's subject line — while the Anchor is 「炫神_」, and the label beside
 * the box the person pasted into named the wrong one of the two.
 */
const ANCHOR_NAME = '炫神_'

const NAV_PATH = '/x/web-interface/nav'

function account(credentials: string = CREDENTIALS): PlatformAccount {
  return {
    id: 7,
    platform: 'bilibili',
    externalId: '987654',
    displayName: 'tester',
    avatar: '',
    credentials,
    meta: '{}'
  }
}

/** A room as `room_init` returns it. */
function room(liveStatus: number): unknown {
  return { room_id: 22637261, short_id: 0, uid: 12345, live_status: liveStatus, live_time: 1 }
}

/** A `/msg/send` refusal, in the shape the live layer returns one. */
function refused(code: number, error = `refused with code ${String(code)}`) {
  return { ok: false, code, error }
}

/** Answers the session check, and refuses to answer anything else. */
function answerNav(payload: unknown): void {
  fetchMock.mockImplementation(async (input: unknown) => {
    if (String(input).includes(NAV_PATH)) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    throw new Error(`unexpected request: ${String(input)}`)
  })
}

/** Every URL the real transport was asked for, so "made no request" is assertable. */
function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map(call => String(call[0]))
}

/**
 * The sentence one refused `resolveTarget` produced.
 *
 * A helper rather than `rejects.toThrow(...)` everywhere, because half of what these cases assert is
 * a **negative** — a sentence that must *not* carry an internal call name — and `toThrow` can only
 * say what a message contains. A resolve that succeeds throws here, so a widening that quietly started
 * accepting a refusal's input cannot pass by claiming the sentence was absent.
 */
async function refusalMessageOf(input: string): Promise<string> {
  try {
    await bilibiliPlatform.resolveTarget(input)
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`resolveTarget accepted ${input}, and this case needs it refused`)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)

  answerNav({ code: 0, data: { isLogin: true, mid: 987654, uname: 'tester' } })
  resolveRoomMock.mockResolvedValue(room(1))
  fetchAnchorNameMock.mockResolvedValue(ANCHOR_NAME)
  fetchRoomInfoMock.mockResolvedValue({
    room_id: 22637261,
    short_id: 0,
    uid: 12345,
    live_status: 1,
    live_time: 1,
    title: '标题'
  })
  sendDanmakuMock.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------ *
 * The catalogue
 * ------------------------------------------------------------------ */

describe('the action catalogue', () => {
  it('registers as Bilibili under the key the rows carry', () => {
    expect(bilibiliPlatform.key).toBe('bilibili')
    expect(bilibiliPlatform.label).toBe('B 站')
  })

  it('declares the two 亲密度 chores, the account-scoped 点亮 action, and nothing that spends', () => {
    expect(bilibiliPlatform.actions.map(action => action.key)).toEqual([
      ActionKey.SendDanmaku,
      ActionKey.LikeDanmaku,
      ActionKey.WatchLive,
      // Account-scoped: it reads the account's own medal list and finds the rooms itself, which is
      // why it is the one entry here whose descriptor says `needsTarget: false`.
      ActionKey.RelightMedal
    ])

    // `ActionKey.SignIn` exists for the Platforms that have one. Bilibili's live
    // check-in is offline — the endpoint answers 签到活动已下线 — so listing it here
    // would put a switch in the UI that can only ever fail. Its absence is the
    // decision this assertion guards.
    expect(bilibiliPlatform.actions.some(action => action.key === ActionKey.SignIn)).toBe(false)

    // The medal's other two chores (投喂粉丝灯牌 / 投喂礼物) each send a gift. Neither is
    // implemented, and a descriptor for one would be a switch with nothing behind it.
    expect(bilibiliPlatform.actions.filter(action => action.costly)).toEqual([])
  })

  it('carries the measured descriptor for send_danmaku', () => {
    const descriptor = bilibiliPlatform.actions.find(action => action.key === ActionKey.SendDanmaku)

    expect(descriptor).toMatchObject({
      action: TaskAction.Send,
      label: '发送弹幕',
      costly: false,
      needsTarget: true,
      needsLibrary: true,
      // Characters. 20 is the ordinary-account cap; a 大航海 gets 30, and declaring
      // the lower one is the safe direction for the salt step.
      maxMessageLength: 20,
      defaultIntervalSeconds: 30
    })
    expect(descriptor?.description).not.toBe('')
  })

  it('runs only what the switchboard enabled, and asks nothing when it enabled nothing', async () => {
    const context: ReconcileContext = {
      account: account(),
      targetKey: '22637261',
      // The scheduler filters `enabledActions` down to keys whose descriptor is a reconcile
      // action, so an empty list is a switchboard with nothing on — and this adapter runs the
      // list it is handed rather than adding an action of its own.
      enabledActions: [],
      // Nothing was set on the switch this case drives, and an empty map is what "no options" is.
      options: {},
      now: Date.now(),
      dayKey: '2026-01-01',
      log: (line: string): void => {
        void line
      }
    }

    expect(await bilibiliPlatform.reconcile(context)).toEqual([])
    expect(fetchedUrls()).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * send
 * ------------------------------------------------------------------ */

describe('send', () => {
  it('reports code 0 as ok', async () => {
    const outcome = await bilibiliPlatform.send(account(), '22637261', '这条消息请忽略')

    expect(outcome).toEqual({ ok: true, code: '0', detail: '', failure: 'none' })
    expect(sendDanmakuMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      roomId: 22637261,
      message: '这条消息请忽略'
    })
    // The verdict came from the protocol layer's data, not from a request this
    // adapter made on its own.
    expect(fetchedUrls()).toEqual([])
  })

  /**
   * The whole `/msg/send` grading table, one row per code it names.
   *
   * Pinned member by member because the defect this guards was not a crash: `-101`, `-400`
   * and `-403` had been collapsed onto one kind, and every other assertion in this file
   * still passed while a muted room failed the task and told a person to re-bind. The codes
   * are written as numbers here on purpose — the claim under test is that these three
   * *numbers* grade three ways, so reading them back through `SendDanmakuCode` would be
   * circular. The `default` branch has the unknown-code case below.
   */
  const GRADING: readonly (readonly [number, FailureKind])[] = [
    [-101, 'account_stop'], // 未登录 / 登录态失效 — the session is gone, and a re-bind is the fix
    [-403, 'account_restricted'], // 账号被封禁 — account-level without being an expiry
    [-400, 'action_stop'], // 房间全员禁言 — this room's state, not the account's
    [10030, 'retry'], // 内容被拒 — this bullet, not the account
    [10031, 'retry'], // 发送过快 — the next attempt may well pass
    [-111, 'retry'] // 签名失败 — sendDanmaku already dropped the cached keys
  ]

  it.each(GRADING)('grades %i as %s', async (code, failure) => {
    sendDanmakuMock.mockResolvedValue(refused(code))

    const outcome = await bilibiliPlatform.send(account(), '22637261', 'x')

    expect(outcome).toMatchObject({ ok: false, code: String(code), failure })
  })

  it('names the muted room in the detail, as the only room that is refusing', async () => {
    // 房间全员禁言 is a fact about one room, and the row a person reads is a task aimed at one
    // room — so the room is what the message has to carry. Nothing here may read as though
    // the account needs anything done to it: a re-bind cannot unmute a room.
    sendDanmakuMock.mockResolvedValue(refused(-400, '房间全员禁言'))

    const outcome = await bilibiliPlatform.send(account(), '22637261', 'x')

    expect(outcome.detail).toContain('22637261')
    expect(outcome.detail).toContain('房间全员禁言')
    expect(outcome.detail).not.toContain('绑定')
  })

  it.each([10030, 10031, -111])('grades %i as retry', async code => {
    sendDanmakuMock.mockResolvedValue(refused(code))
    const outcome = await bilibiliPlatform.send(account(), '22637261', 'x')

    // 内容被拒 / 发送过快 / 签名失败: each is worth another attempt.
    expect(outcome).toMatchObject({ ok: false, code: String(code), failure: 'retry' })
  })

  it('shows the operator Bilibili’s own words', async () => {
    sendDanmakuMock.mockResolvedValue(refused(10030, '弹幕内容涉嫌违规'))
    const outcome = await bilibiliPlatform.send(account(), '22637261', 'x')

    expect(outcome.detail).toBe('弹幕内容涉嫌违规')
  })

  it('retries an unknown code, carrying it verbatim', async () => {
    // The most important case in this file: an unrecognised code must travel back in
    // `code` and `detail` and must not be guessed at. That is what replaced
    // `error.message.includes('-101')`, which fired almost never and, when it did,
    // could not tell a dead session from a room that merely mentioned the number.
    sendDanmakuMock.mockResolvedValue(refused(10099, '一条没人见过的拒绝'))
    const outcome = await bilibiliPlatform.send(account(), '22637261', 'x')

    expect(outcome).toMatchObject({ ok: false, code: '10099', failure: 'retry' })
    expect(outcome.detail).toBe('一条没人见过的拒绝')
  })

  it('grades on the code, never on a substring of the message', async () => {
    // A rate limit whose message happens to mention -101 must stay a retry. Reading
    // the text is the habit the seam removed, and this is where it would come back.
    sendDanmakuMock.mockResolvedValue(refused(10031, '发送过快（对比 code -101 的样例）'))
    const outcome = await bilibiliPlatform.send(account(), '22637261', 'x')

    expect(outcome).toMatchObject({ code: '10031', failure: 'retry' })
  })

  it('stops on a target that is not a room number, without sending anything', async () => {
    const outcome = await bilibiliPlatform.send(account(), 'not-a-room', 'x')

    expect(outcome).toMatchObject({ ok: false, code: 'bad_target', failure: 'action_stop' })
    expect(sendDanmakuMock).not.toHaveBeenCalled()
    expect(fetchedUrls()).toEqual([])
  })

  it('stops the account when the credential cannot be read, without any request', async () => {
    const outcome = await bilibiliPlatform.send(account(UNREADABLE_CREDENTIALS), '22637261', 'x')

    expect(outcome).toMatchObject({ ok: false, code: 'no_credential', failure: 'account_stop' })
    expect(outcome.detail).toContain('重新扫码绑定')
    expect(sendDanmakuMock).not.toHaveBeenCalled()
    expect(fetchedUrls()).toEqual([])
  })

  it('grades a transport failure by its HTTP status', async () => {
    // `sendDanmaku` returns API-level refusals as data, so a throw is transport.
    sendDanmakuMock.mockRejectedValue(new BiliHttpError('https://api.bilibili.com/msg/send', 412, 'HTTP 412'))
    const outcome = await bilibiliPlatform.send(account(), '22637261', 'x')

    expect(outcome).toMatchObject({ ok: false, code: 'http_412', failure: 'retry' })
  })

  it('names a transport failure that carries no status', async () => {
    sendDanmakuMock.mockRejectedValue(new Error('socket hang up'))
    const outcome = await bilibiliPlatform.send(account(), '22637261', 'x')

    expect(outcome).toMatchObject({ ok: false, code: 'transport', failure: 'retry' })
    expect(outcome.detail).toContain('socket hang up')
  })

  it('keeps the CSRF value its request body carried out of the failure it reports', async () => {
    // This action's request puts `csrf`/`csrf_token` in its **body** (`live.ts`), and `http.ts` builds a
    // throw's message out of the response body's first 200 characters — so a server that echoes the
    // request back puts the credential into the sentence that becomes `send_logs.error`. The like
    // endpoints carry their csrf in the *query string*; this call site's is in the body, which is why
    // the adapter hands over the value it sent (`redactSecrets` in `text/redact.ts`) instead of leaving
    // it to a rule that can only match a parameter name in the text.
    sendDanmakuMock.mockRejectedValue(
      new BiliHttpError('https://api.bilibili.com/msg/send', 500, 'HTTP 500: csrf mismatch: csrf-value')
    )

    const outcome = await bilibiliPlatform.send(account(), '22637261', 'x')

    expect(outcome).toMatchObject({ ok: false, code: 'http_500', failure: 'retry' })
    expect(outcome.detail).toContain('<redacted>')
    expect(outcome.detail).not.toContain('csrf-value')
  })
})

/* ------------------------------------------------------------------ *
 * probe
 * ------------------------------------------------------------------ */

describe('probe', () => {
  it('reports a live room as live', async () => {
    const result = await bilibiliPlatform.probe(account(), '22637261')

    expect(result).toMatchObject({ ok: true, liveStatus: 1, code: '0', detail: '', failure: 'none' })
    // The session is checked first, then the room: one `/nav` and one `room_init`.
    expect(fetchedUrls().filter(url => url.includes(NAV_PATH))).toHaveLength(1)
    expect(resolveRoomMock).toHaveBeenCalledWith(expect.anything(), 22637261)
  })

  it.each([
    [1, 1],
    [0, 0],
    // 轮播: a recording on loop. Not a broadcast, so not live.
    [2, 0]
  ])('normalises live_status %i to %i', async (raw, expected) => {
    resolveRoomMock.mockResolvedValue(room(raw))

    const result = await bilibiliPlatform.probe(account(), '22637261')

    expect(result.liveStatus).toBe(expected)
  })

  it('grades /nav answering -101 as a dead session', async () => {
    answerNav({ code: -101, message: '账号未登录' })

    const result = await bilibiliPlatform.probe(account(), '22637261')

    expect(result).toMatchObject({ ok: false, code: '-101', failure: 'account_stop' })
    expect(result.detail).toContain('登录态已失效')
    // The session check comes first on purpose: a dead account is worth knowing
    // before spending a round trip on a room that answers anonymously anyway.
    expect(resolveRoomMock).not.toHaveBeenCalled()
  })

  it('grades code 0 with isLogin false as a dead session', async () => {
    answerNav({ code: 0, data: { isLogin: false } })

    const result = await bilibiliPlatform.probe(account(), '22637261')

    expect(result).toMatchObject({ ok: false, code: '-101', failure: 'account_stop' })
  })

  it('treats a rejection envelope with no data as a retry, not a dead session', async () => {
    // `{"code": -412}` is what risk control answers: no `data` at all. The envelope
    // schema is the *optional-data* one precisely so this survives the parse —
    // `navSchema` is asserted here directly, because if `data` ever became required
    // again the request would throw a shape error and the probe would report a
    // transport code instead of this one, quietly turning a rejection into "session
    // unknown". The code assertion below is what catches that.
    const payload = { code: -412, message: '请求被拦截' }
    expect(navSchema.safeParse(payload).success).toBe(true)
    answerNav(payload)

    const result = await bilibiliPlatform.probe(account(), '22637261')

    expect(result).toMatchObject({ ok: false, code: 'nav_-412', failure: 'retry' })
    expect(result.detail).toContain('会话检查被拒绝')
    // The account may be perfectly fine once the rejection passes, so the room is
    // not even asked about.
    expect(resolveRoomMock).not.toHaveBeenCalled()
  })

  it('retries a payload it cannot parse rather than declaring the account dead', async () => {
    // `navSchema` demands `isLogin` whenever `data` is present, so a body that
    // publishes no session state never reaches the adapter as data — it fails the
    // parse and arrives as a shape error. (The adapter still has a `session_unknown`
    // branch for that state; this schema is what currently makes it unreachable.)
    // What matters is the grade: a shape Bilibili changed is worth another attempt,
    // and must not be read as "the session is gone", which would fail the task and
    // ask a person to re-bind an account that is probably fine.
    answerNav({ code: 0, data: {} })

    const result = await bilibiliPlatform.probe(account(), '22637261')

    expect(result).toMatchObject({ ok: false, code: 'transport', failure: 'retry' })
    expect(result.detail).toContain('会话检查失败')
  })

  it('retries a room failure without reading a code out of its message', async () => {
    // The message contains -101 and *must not* be graded as a dead session: an error
    // raised while asking about a room says nothing about the account. This is the
    // direct replacement for `detail.includes('-101')`, and the assertion that keeps
    // it from coming back.
    resolveRoomMock.mockRejectedValue(new Error('room_init failed for 22637261: code -101'))

    const result = await bilibiliPlatform.probe(account(), '22637261')

    expect(result).toMatchObject({ ok: false, code: 'transport', failure: 'retry' })
    expect(result.detail).toContain('查询直播间失败')
    expect(result.detail).toContain('-101')
  })

  it('parks an action whose target is not a room number, without any request', async () => {
    const result = await bilibiliPlatform.probe(account(), 'yyf')

    expect(result).toMatchObject({ ok: false, code: 'bad_target', failure: 'action_stop' })
    expect(fetchedUrls()).toEqual([])
    expect(resolveRoomMock).not.toHaveBeenCalled()
  })

  it('stops the account when the credential cannot be read, without any request', async () => {
    const result = await bilibiliPlatform.probe(account(UNREADABLE_CREDENTIALS), '22637261')

    expect(result).toMatchObject({ ok: false, code: 'no_credential', failure: 'account_stop' })
    expect(fetchedUrls()).toEqual([])
    expect(resolveRoomMock).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ *
 * resolveTarget
 * ------------------------------------------------------------------ */

describe('resolveTarget', () => {
  it('rejects a host that is not Bilibili’s live host, without any request', async () => {
    for (const input of ['https://example.com/22637261', 'https://live.bilibili.com.evil.test/605']) {
      await expect(bilibiliPlatform.resolveTarget(input)).rejects.toThrow('无法从该链接解析出直播间号')
    }

    expect(fetchedUrls()).toEqual([])
    expect(resolveRoomMock).not.toHaveBeenCalled()
  })

  it.each(['', '   ', 'hello world', 'https://live.bilibili.com/', 'https://live.bilibili.com/abc'])(
    'rejects %j, which names no room',
    async input => {
      await expect(bilibiliPlatform.resolveTarget(input)).rejects.toThrow()
      expect(resolveRoomMock).not.toHaveBeenCalled()
    }
  )

  /**
   * The hazard the shared pattern guards, which `parseInt` alone does not: it stops at
   * the first character it cannot read, so this path segment would quietly become room
   * 22637261 — a valid-looking id belonging to somebody else.
   */
  it.each(['https://live.bilibili.com/22637261abc', '22637261abc'])(
    'rejects %j, which only starts with a room number',
    async input => {
      await expect(bilibiliPlatform.resolveTarget(input)).rejects.toThrow('无法从该链接解析出直播间号')
      expect(resolveRoomMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['22637261', 22637261],
    ['  22637261  ', 22637261],
    ['https://live.bilibili.com/22637261?hotRank=0', 22637261],
    ['live.bilibili.com/605', 605]
  ])('reads the room number out of %j', async (input, expected) => {
    const target = await bilibiliPlatform.resolveTarget(input)

    expect(resolveRoomMock).toHaveBeenCalledWith(expect.anything(), expected)
    // The name is asked of the room the paste maps to, not of the number that was pasted:
    // `getInfoByRoom` takes the real id, exactly as every write endpoint does.
    expect(fetchAnchorNameMock).toHaveBeenCalledWith(expect.anything(), 22637261)
    // The real room id, not the number that was pasted: every write endpoint wants
    // the id `room_init` maps to.
    expect(target).toEqual({
      key: '22637261',
      // The label a person reads, which is a **name**: 「已解析：炫神_」 beside the input, and a task
      // row's `targetTitle`. Never the room's 标题 — see the case below, where both are on offer.
      title: ANCHOR_NAME,
      anchorId: '12345',
      // Empty, and now for a different reason than it used to be: this adapter *does* read the
      // Anchor's name (into `title`, which is the field both the echo and a task row draw), and
      // `anchorName` is the create form's second, smaller tag — filling both would print one name
      // twice on that form.
      anchorName: '',
      liveStatus: 1
    })
  })

  /**
   * The reported defect, with the owner's own strings.
   *
   * Room `84074`'s 标题 was 「贴人」 while its Anchor is 「炫神_」, and the 「已解析：…」 line beside the box
   * he pasted into named the 标题. `toBe` rather than `not.toContain('贴人')` on purpose: equality says
   * the subject line never reached the field, and says it without a two-character marker whose
   * absence a fixture's own data could produce by accident.
   */
  it('names the Anchor rather than the room’s 标题, which the room payload also carries', async () => {
    resolveRoomMock.mockResolvedValue({ room_id: 84074, short_id: 0, uid: 12345, live_status: 1, live_time: 1 })

    const target = await bilibiliPlatform.resolveTarget('84074')

    expect(target.title).toBe(ANCHOR_NAME)
    expect(target.key).toBe('84074')
    // The 标题 read is a **fallback for an absent name**, not a second source consulted anyway: a name
    // that arrives short-circuits it, so this path still makes the number of requests it made before the
    // fallback existed.
    expect(fetchRoomInfoMock).not.toHaveBeenCalled()
  })

  /**
   * An empty name is not a name, so the label falls through to the room's 标题 — the order
   * `resolveTarget` states in full.
   *
   * **This case asserted the opposite until the regression was found, and that belongs on the record.**
   * `''` *is* what the page renders as 「目标 22637261」, so the assertion read as a deliberate choice —
   * and nothing in this file could see its cost, because `fetchAnchorName` is a mock here and no mock
   * knew that every anonymous client is refused. The captured refusal and the real reader are
   * `tests/bilibili-target-label.test.ts`'s job. What this case pins is the order itself.
   */
  it('falls back to the room’s 标题 when the room reports no Anchor name at all', async () => {
    fetchAnchorNameMock.mockResolvedValue('')

    const target = await bilibiliPlatform.resolveTarget('22637261')

    expect(target.title).toBe('标题')
    expect(target.key).toBe('22637261')
    // Asked of the real room id, as every read here is: `get_info` takes what `room_init` mapped to.
    expect(fetchRoomInfoMock).toHaveBeenCalledWith(expect.anything(), 22637261)
  })

  /**
   * The one path prefix a live host puts in front of a room number.
   *
   * `live.bilibili.com/blanc/<id>` is a real, openable room URL, and before this it was refused
   * outright — the parser read the first non-empty segment (`blanc`), demanded digits of it, and gave
   * up. `blanc` is the **only** prefix that is read, and only in the position right after the host:
   * see the refusals below for what that deliberately leaves out.
   */
  it.each([
    ['https://live.bilibili.com/blanc/22637261', 22637261],
    ['live.bilibili.com/blanc/605?broadcast_type=0', 605]
  ])('reads the room number out of the /blanc/ shape %j', async (input, expected) => {
    await bilibiliPlatform.resolveTarget(input)

    expect(resolveRoomMock).toHaveBeenCalledWith(expect.anything(), expected)
  })

  /**
   * The other side of the widening: a room number is still a room number, wherever it sits.
   *
   * A scan that read *any* numeric segment would turn `/p/22637261` or an activity path's number into a
   * room nobody asked for, which is the one thing widening this parser must not do. So an unknown
   * prefix refuses exactly as it did before, and `blanc` does not exempt the segment after it from the
   * digits rule.
   */
  it.each([
    ['https://live.bilibili.com/p/22637261'],
    ['https://live.bilibili.com/blanc/22637261abc'],
    ['https://live.bilibili.com/blanc/'],
    ['https://live.bilibili.com/blanc/605/22637261']
  ])('still refuses %j', async input => {
    await expect(bilibiliPlatform.resolveTarget(input)).rejects.toThrow('无法从该链接解析出直播间号')
    expect(resolveRoomMock).not.toHaveBeenCalled()
  })

  /**
   * A b23.tv short link is a class this build refuses, with a sentence that says so.
   *
   * **What is established is that the class is refused, and nothing about what it points at.** The
   * reference short-link documentation lists formats for 任意/av/BV links and its 直播 row is commented
   * out as 失效, so whether a live room even has a short link is not something this build may assume —
   * and the sentence therefore does not claim one exists. What it does say is why: where a short link
   * goes is only knowable by opening it, and this build does not open links. No request is made, which
   * is what makes that a fact rather than a promise.
   */
  it('refuses a b23.tv short link as a class, naming the class and asking for the URL it opens', async () => {
    const message = await refusalMessageOf('https://b23.tv/av80433022')

    expect(message).toContain('b23.tv')
    expect(message).not.toContain('无法从该链接解析出直播间号')
    expect(fetchedUrls()).toEqual([])
    expect(resolveRoomMock).not.toHaveBeenCalled()
  })

  /**
   * The refusal's grade, at the seam where the route reads it.
   *
   * `60004` is the documented 直播间不存在: the person's number names no room, which is an input
   * problem, and the sentence names the number they typed rather than the call that discovered it.
   * Any other code is a refusal this build cannot name, which is not a verdict about their typing.
   */
  it('grades the documented "no such room" code as a missing room, in a sentence about the number', async () => {
    resolveRoomMock.mockRejectedValue(new RoomRefusedError(60004, '直播间不存在'))

    const message = await refusalMessageOf('22637261')

    expect(message).toContain('没有房间号 22637261')
    expect(message).not.toContain('room_init')
  })

  it('grades a room_init code it cannot name as the Platform not answering', async () => {
    resolveRoomMock.mockRejectedValue(new RoomRefusedError(-412, '请求被拦截'))

    await expect(bilibiliPlatform.resolveTarget('22637261')).rejects.toMatchObject({
      kind: TargetRefusalKind.PlatformUnanswered
    })
  })

  it('lets a transport failure out unchanged, so the route can still answer 502', async () => {
    // The half that must not be turned into a verdict about the input: a 503 from the gateway is the
    // reason 「the same link may well work in a minute」 exists.
    resolveRoomMock.mockRejectedValue(new BiliHttpError('https://api.live.bilibili.com', 503, 'HTTP 503: bad gateway'))

    await expect(bilibiliPlatform.resolveTarget('22637261')).rejects.toBeInstanceOf(BiliHttpError)
  })

  it('does not let a refused name read block a task, and labels it with the 标题 instead', async () => {
    // The code the endpoint actually answers an anonymous client, and the one that shipped the
    // regression: a *refusal* must not be able to take the label away from a read that can answer.
    fetchAnchorNameMock.mockRejectedValue(new Error('getInfoByRoom answered code -352'))

    const target = await bilibiliPlatform.resolveTarget('22637261')

    expect(target.key).toBe('22637261')
    expect(target.title).toBe('标题')
  })

  /**
   * The third step, and the only state that keeps 「目标 <room id>」 reachable.
   *
   * Both reads unavailable is the one case where the label stays `''`; the page's own fallback
   * (`ActionSettingsPanel.vue`'s `echoOf`) then names the room by the key this resolve did confirm, which
   * is the honest answer: a number that resolved and could not be named.
   */
  it('leaves the label empty only when neither read answers', async () => {
    fetchAnchorNameMock.mockRejectedValue(new Error('getInfoByRoom answered code -352'))
    fetchRoomInfoMock.mockRejectedValue(new RoomRefusedError(1, '房间不存在'))

    const target = await bilibiliPlatform.resolveTarget('22637261')

    expect(target.title).toBe('')
    expect(target.key).toBe('22637261')
  })
})

/* ------------------------------------------------------------------ *
 * refresh — the blob boundary
 * ------------------------------------------------------------------ */

describe('refresh', () => {
  // The exchange itself is `bilibili/refresh.ts`, covered by `refresh.test.ts`. What
  // is asserted here is only the part this adapter owns: deciding, before spending a
  // request, that the credential cannot be renewed without a person.
  it('asks for a re-bind when the credential cannot be read', async () => {
    const outcome = await bilibiliPlatform.refresh?.(account(UNREADABLE_CREDENTIALS))

    expect(outcome).toMatchObject({ status: 'relogin_required' })
    expect(fetchedUrls()).toEqual([])
  })

  it('asks for a re-bind when the jar has no csrf cookie to sign the renewal with', async () => {
    const noCsrf = JSON.stringify({
      cookies: JSON.stringify({ SESSDATA: 'sessdata-value' }),
      refreshToken: 'ac-time-value'
    })

    const outcome = await bilibiliPlatform.refresh?.(account(noCsrf))

    // Every write echoes the CSRF cookie, so the attempt could only be rejected.
    expect(outcome).toMatchObject({ status: 'relogin_required' })
    expect(outcome?.detail).toContain('bili_jct')
    expect(fetchedUrls()).toEqual([])
  })
})
