import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVITY_ALREADY_SIGNED,
  ACTIVITY_SIGN_SUCCESS,
  CLIENT_SIGN_ALREADY_SIGNED,
  classifyError,
  DouyuProtocolError,
  DouyuTransportError
} from '../src/platform/douyu/errors.js'
import { douyuPlatform, parseCredential } from '../src/platform/douyu/index.js'
import {
  ACTIVITY_SIGN_STATUS_URL,
  CSRF_COOKIE_URL,
  clientSignDataSchema,
  FAN_BADGES_URL,
  FANSHOME_ALREADY_SIGNED,
  FANSHOME_CSRF_COOKIE,
  FISH_BALL_ALREADY_CLAIMED,
  FISH_BALL_BALANCE_URL,
  GROWTH_POOL_CLOCK_URL,
  GROWTH_POOL_STATUS_URL,
  growthPoolJoinSchema,
  growthPoolStatusSchema,
  OPFOY_SIGN_ALIAS,
  YUBA_ALREADY_SIGNED,
  YUBA_FAST_SIGN_URL
} from '../src/platform/douyu/protocol.js'
import type { ActionOutcome, PlatformAccount, RefreshResult } from '../src/platform/types.js'
import { ActionKey, TaskAction } from '../src/repo/tasks.js'

/**
 * The Douyu adapter, tested at the seam.
 *
 * The network is mocked at exactly the three boundaries this adapter has: the
 * protocol module, the danmaku socket, and `fetch` — which is the room-metadata
 * read the adapter owns because `protocol.ts` covers account actions only. The
 * adapter itself is the real one, so every case below exercises the code the
 * scheduler will call rather than a re-statement of its decisions.
 *
 * Nothing here touches a real account: the check-in, fish-ball and 鱼吧 paths are
 * mocked by construction, and only `send` has a live counterpart — run separately,
 * once, against one room, by design.
 */

const {
  fetchCsrfCookieMock,
  sendClientSignMock,
  readFishBallBalanceMock,
  claimFishBallMock,
  listFollowedGroupsMock,
  signGroupAndroidMock,
  readFanBadgesMock,
  signFansHomeMock,
  signActivityMock,
  readActivitySignStatusMock,
  readGrowthPoolStatusMock,
  joinGrowthPoolMock,
  clockGrowthPoolMock,
  sendDanmakuMock,
  fetchMock
} = vi.hoisted(() => ({
  fetchCsrfCookieMock: vi.fn(),
  sendClientSignMock: vi.fn(),
  readFishBallBalanceMock: vi.fn(),
  claimFishBallMock: vi.fn(),
  listFollowedGroupsMock: vi.fn(),
  signGroupAndroidMock: vi.fn(),
  readFanBadgesMock: vi.fn(),
  signFansHomeMock: vi.fn(),
  signActivityMock: vi.fn(),
  readActivitySignStatusMock: vi.fn(),
  readGrowthPoolStatusMock: vi.fn(),
  joinGrowthPoolMock: vi.fn(),
  clockGrowthPoolMock: vi.fn(),
  sendDanmakuMock: vi.fn(),
  fetchMock: vi.fn()
}))

// `importOriginal` keeps the real constants — 6305, 31015, 31200, -1, the alias, and the
// growth pool's schemas and codes — so the assertions below are against the values the
// protocol layer actually exports rather than against a second copy in this file.
vi.mock('../src/platform/douyu/protocol.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/platform/douyu/protocol.js')>()
  return {
    ...actual,
    fetchCsrfCookie: fetchCsrfCookieMock,
    sendClientSign: sendClientSignMock,
    readFishBallBalance: readFishBallBalanceMock,
    claimFishBall: claimFishBallMock,
    listFollowedGroups: listFollowedGroupsMock,
    signGroupAndroid: signGroupAndroidMock,
    readFanBadges: readFanBadgesMock,
    signFansHome: signFansHomeMock,
    signActivity: signActivityMock,
    readActivitySignStatus: readActivitySignStatusMock,
    readGrowthPoolStatus: readGrowthPoolStatusMock,
    joinGrowthPool: joinGrowthPoolMock,
    clockGrowthPool: clockGrowthPoolMock
  }
})

vi.mock('../src/platform/douyu/socket.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/platform/douyu/socket.js')>()
  return { ...actual, sendDanmaku: sendDanmakuMock }
})

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The shape §2.1 measures: 9 digits of uid, then biz, a 16-character stk, ct, ltkid. */
const TOKEN = '123456789_1_abcdef0123456789_0_69117311'
const DID = '20e8917f4ebe85866a5e94cfaba2f156'

function account(credentials: string = JSON.stringify({ token: TOKEN, did: DID })): PlatformAccount {
  return {
    id: 7,
    platform: 'douyu',
    externalId: '123456789',
    displayName: 'tester',
    avatar: '',
    credentials,
    meta: '{}'
  }
}

const CREDENTIAL_ARGS = {
  uid: '123456789',
  biz: '1',
  stk: 'abcdef0123456789',
  ct: '0',
  ltkid: '69117311'
}

function roomPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    room: {
      room_id: 12306,
      room_name: '电棍的直播间',
      owner_name: '电棍',
      owner_uid: 310260,
      show_status: 1,
      ...overrides
    }
  }
}

function roomResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/** A `DouyuResult` refusal, classified by the real table so the mock cannot drift. */
function refused(code: number | null, message = 'refused') {
  return { ok: false, code, message, classification: classifyError(code ?? 0) }
}

/** A group as `myFollow` reports it. */
function group(id: string, name = `鱼吧 ${id}`): unknown {
  return { group_id: id, group_name: name }
}

/**
 * The web session 粉丝家园 needs, and the two rooms the captured badge wall lists.
 *
 * The header carries `acf_ccn` on purpose: it is the value the *adapter* must not reach for while
 * the read is handing it another one, and a fixture without it could not tell the two apart. The
 * cookie's own name comes from the module so that a rename cannot leave this fixture holding a
 * cookie nothing looks for — which would make the fallback case pass for the wrong reason.
 */
const HELD_CCN = 'held_ccn_value'
const MINTED_CCN = 'minted_ccn_value'
const WEB_COOKIES = `acf_auth=1_1_abcdef; acf_uid=123456789; ${FANSHOME_CSRF_COOKIE}=${HELD_CCN}`

/** The blob the binder writes once the web flow has been walked. */
function webCredentials(): string {
  return JSON.stringify({ token: TOKEN, did: DID, webCookies: WEB_COOKIES })
}

/** A 粉丝牌 row as the badge wall describes it: the room, and the anchor it is held against. */
/**
 * One badge-wall row, with 今日亲密度.
 *
 * The third field is carried because the row now has it (`FanBadge.todayIntimacy`, the page's fourth cell)
 * and a mock that omitted it would be describing a page this build no longer reads. The default is `0`,
 * which is what the captured row for room 12293234 reads.
 */
function badge(roomId: string, anchorName: string, todayIntimacy: number | null = 0): unknown {
  return { roomId, anchorName, todayIntimacy }
}

/** The two rooms this account actually holds (the captured page's own rows, 今日亲密度 included). */
function badgeList(csrf: string | null = MINTED_CCN): unknown {
  return { badges: [badge('12293234', '145oni', 0), badge('12306', '电棍', 2)], csrf }
}

/**
 * A key no catalogue row declares, for the cases about a key this build cannot name.
 *
 * They used `ActionKey.Fishing` — a member of the key table that had no descriptor, because the
 * action was in the vocabulary before it was implemented. Fishing is implemented now, so those two
 * cases need a key that really is absent from the catalogue; if one of them ever starts passing for
 * a different reason, this constant is where to look first.
 */
const UNKNOWN_ACTION_KEY = 'write_poetry'

function outcomeOf(outcomes: readonly ActionOutcome[], actionKey: string): ActionOutcome {
  const found = outcomes.find(candidate => candidate.actionKey === actionKey)
  if (found === undefined) throw new Error(`no outcome for ${actionKey}`)
  return found
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)

  fetchCsrfCookieMock.mockResolvedValue({ ok: true, code: 0, data: 'dy_cookie_value' })
  sendClientSignMock.mockResolvedValue({
    ok: true,
    code: 0,
    data: {
      alreadySignedToday: false,
      status: {
        sign_today: '2026-10-08',
        sign_cnt: 1,
        sign_sum: 1,
        sign_rd: 7,
        sign_md: 1,
        sign_exp: 15,
        sign_exps: 10,
        sign_cexp: 10
      }
    }
  })
  readFishBallBalanceMock.mockResolvedValue({ ok: true, code: 0, data: { num: 20, time: 15 } })
  claimFishBallMock.mockResolvedValue({ ok: true, code: 0, data: null })
  listFollowedGroupsMock.mockResolvedValue({ ok: true, code: 200, data: [group('1')] })
  signGroupAndroidMock.mockResolvedValue({ ok: true, code: 200, data: { levelScore: 3, alreadySigned: false } })
  // 粉丝家园's default: the badge wall answers, and both rooms answer the one 200 body this
  // endpoint has ever been seen to send — 「今日已签到」.
  readFanBadgesMock.mockResolvedValue(badgeList())
  signFansHomeMock.mockResolvedValue({ ok: true, code: FANSHOME_ALREADY_SIGNED, data: { alreadySigned: true } })
  signActivityMock.mockResolvedValue({ ok: true, code: 31200, data: { alreadySigned: false } })
  // The activity gate's default: today is not signed, so the write goes through.
  readActivitySignStatusMock.mockResolvedValue({ ok: true, code: 0, data: { todaySigned: 0 } })
  // 打卡分鱼丸's default: the account is not in this round, so the run signs up.
  readGrowthPoolStatusMock.mockResolvedValue({ ok: true, code: 0, data: { signStatus: 0 } })
  joinGrowthPoolMock.mockResolvedValue({ ok: true, code: 0, data: { ywTotal: 38400, joinTotal: 192 } })
  clockGrowthPoolMock.mockResolvedValue({ ok: true, code: 0, data: {} })
  sendDanmakuMock.mockResolvedValue({ ok: true, code: 0, data: { elapsedMs: 9, len: 50 } })
  fetchMock.mockResolvedValue(roomResponse(roomPayload()))
})

/* ------------------------------------------------------------------ *
 * The catalogue
 * ------------------------------------------------------------------ */

interface ExpectedAction {
  readonly key: string
  readonly action: TaskAction
  readonly label: string
  readonly costly: boolean
  readonly needsTarget: boolean
  readonly needsLibrary: boolean
  readonly maxMessageLength: number
  readonly defaultIntervalSeconds: number
}

/**
 * The catalogue, one measured row at a time.
 *
 * **`needsTarget` and `needsLibrary` are pinned per row here because there is no rule between them
 * and `action`.** This table used to be accompanied by a loop asserting `needsTarget === isSend`,
 * which read like a rule and only held while every per-Room action on this Platform happened to be a
 * Send one — 亲密度任务 is a Reconcile action that needs a Room, exactly as Bilibili's 点赞 and 观看
 * 直播 are, and 钓鱼 is the second one. The reverse rule (「reconcile 一定不需要目标」) is wrong in the
 * other direction: seven of the ten rows are account-scoped. So the two fields mean "a Room identifies
 * this action" and "it consumes Bullets", each row states its own answer, and the case below asserts
 * only that the set asking for a Room is not the set asking for a Library.
 */
const EXPECTED_ACTIONS: readonly ExpectedAction[] = [
  {
    key: ActionKey.SendDanmaku,
    action: TaskAction.Send,
    label: '发送弹幕',
    costly: false,
    needsTarget: true,
    needsLibrary: true,
    // Characters, and 70 is where the server silently truncates rather than refusing.
    maxMessageLength: 70,
    // Above the measured ~2 s floor; 1664 ms was refused with res=290.
    defaultIntervalSeconds: 3
  },
  {
    key: ActionKey.SignIn,
    action: TaskAction.Reconcile,
    label: '客户端签到',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300
  },
  {
    key: ActionKey.Fishball,
    action: TaskAction.Reconcile,
    label: '看广告鱼丸',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300
  },
  {
    key: ActionKey.YubaSign,
    action: TaskAction.Reconcile,
    label: '鱼吧签到',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300
  },
  {
    key: ActionKey.ActivitySign,
    action: TaskAction.Reconcile,
    label: '任务中心签到',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300
  },
  {
    key: ActionKey.GrowthPool,
    action: TaskAction.Reconcile,
    label: '打卡分鱼丸',
    costly: true,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300
  },
  {
    key: ActionKey.FanshomeSign,
    action: TaskAction.Reconcile,
    label: '粉丝家园签到',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300
  },
  {
    key: ActionKey.IntimacyTasks,
    action: TaskAction.Reconcile,
    label: '亲密度任务',
    // It sends gifts now — one per POST, and only items the owner listed on 「允许使用的礼物」 — and a gift
    // is public and cannot be un-sent, so it is the third action here that keeps itself dark until a person
    // turns it on. This read `false` while the gifting half was unwritten; the field said then which day
    // would change it, and this is that day.
    costly: true,
    /** Per Room, and one of the **two** Reconcile rows here that are: the tasks hang off one 粉丝牌. */
    needsTarget: true,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300
  },
  {
    key: ActionKey.Fishing,
    action: TaskAction.Reconcile,
    label: '粉丝家园钓鱼',
    // It spends bait — 20 a cast, measured — which is what keeps it dark until a person turns it on.
    costly: true,
    /** Per Room: the panel is read with a `rid`, and the 形象 hangs off that same room. */
    needsTarget: true,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300
  },
  {
    key: ActionKey.Clearout,
    action: TaskAction.Reconcile,
    label: '送出即将过期的免费道具',
    // It sends free 道具 to an anchor's room as public gifts, which cannot be un-sent — the same reason
    // 亲密度任务 is costly, and the same reason the allowlist exists beside it.
    costly: true,
    /** Account-scoped: the room the items go to is 「默认倾泻直播间」 in this action's own options. */
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300
  }
]

describe('the action catalogue', () => {
  it('registers as Douyu under the key the rows carry', () => {
    expect(douyuPlatform.key).toBe('douyu')
    expect(douyuPlatform.label).toBe('斗鱼')
  })

  it('declares exactly the ten measured actions, in order', () => {
    expect(douyuPlatform.actions.map(action => action.key)).toEqual(EXPECTED_ACTIONS.map(action => action.key))
  })

  it.each(EXPECTED_ACTIONS)('$key carries the measured descriptor', expected => {
    const descriptor = douyuPlatform.actions.find(action => action.key === expected.key)
    expect(descriptor).toMatchObject({ ...expected })
    expect(descriptor?.description).not.toBe('')
  })

  it('marks the four actions that spend as costly, and says what each one spends', () => {
    // 打卡分鱼丸 spends 200 鱼丸 on entry, 钓鱼 spends bait that cannot be earned back, and 亲密度任务 and
    // 清仓 give gifts away in public where they cannot be un-sent: four different things to lose, and all
    // four irreversible — which is what `costly` keeps dark until a person turns it on.
    expect(douyuPlatform.actions.filter(action => action.costly).map(action => action.key)).toEqual([
      ActionKey.GrowthPool,
      ActionKey.IntimacyTasks,
      ActionKey.Fishing,
      ActionKey.Clearout
    ])

    const pool = douyuPlatform.actions.find(action => action.key === ActionKey.GrowthPool)
    expect(pool?.description).toContain('200')
    expect(pool?.description).toContain('鱼丸')

    const fishing = douyuPlatform.actions.find(action => action.key === ActionKey.Fishing)
    expect(fishing?.description).toContain('20 枚')
    expect(fishing?.description).toContain('鱼饵')

    // 亲密度任务's sentence has to say both halves of what keeps it honest: the list a person writes is the
    // whole of what may be spent, and what a run reports about a send includes what it was charged.
    const intimacy = douyuPlatform.actions.find(action => action.key === ActionKey.IntimacyTasks)
    expect(intimacy?.description).toContain('允许使用的礼物')
    expect(intimacy?.description).toContain('扣费')

    // 清仓's has to carry four things a person cannot get anywhere else: what it sends, where it sends it
    // (a room from the *preferences*, not the Task), that it holds items back for 亲密度任务's renewal,
    // and that 「允许使用的道具」 is this action's own list.
    const clearout = douyuPlatform.actions.find(action => action.key === ActionKey.Clearout)
    expect(clearout?.description).toContain('默认倾泻直播间')
    expect(clearout?.description).toContain('允许使用的道具')
    expect(clearout?.description).toContain('亲密度任务')
    expect(clearout?.description).toContain('24 小时')
    expect(clearout?.description).toContain('扣费')
  })

  it('describes the activity by the name a person meets it under, not by its alias', () => {
    const activity = douyuPlatform.actions.find(action => action.key === ActionKey.ActivitySign)

    // The description is read by whoever is choosing between switches, and
    // `OPFOY 活动每日签到（signAlias 20250521OPFOY_qd2）。` told that person nothing.
    expect(activity?.description).toContain('任务中心')
    expect(activity?.description).not.toContain(OPFOY_SIGN_ALIAS)

    // The numbers stay, and they are the activity's published rule rather than anything
    // this system reads: a person deciding whether to switch the action on is entitled
    // to know what it pays, which is the whole difference from a run's `detail`.
    expect(activity?.description).toContain('20 活动积分')
    expect(activity?.description).toContain('第 7 天另加 30')
  })

  /**
   * The two shape fields, asserted as facts about *these* rows rather than as a rule.
   *
   * What used to stand here — `expect(descriptor.needsTarget).toBe(isSend)` for every row — was a rule
   * that happened to hold while every per-Room action on this Platform was also a Send action, and it
   * broke the moment 亲密度任务 arrived as a Reconcile action that needs a Room. The rephrasing matters
   * more than the assertion does: 「reconcile 一定不需要目标」 is equally false (seven of these ten rows
   * are account-scoped — the other two that take a Room are 亲密度任务 and 钓鱼), so what the next
   * reader has to find here is "there is no rule", not a narrower one. The count lives in the case
   * below rather than in this sentence, so the two cannot disagree: it filters `needsTarget`.
   */
  it('asks three of ten rows for a Room and one of ten for a Library, which are different sets', () => {
    const perRoom = douyuPlatform.actions.filter(action => action.needsTarget).map(action => action.key)
    const senders = douyuPlatform.actions.filter(action => action.needsLibrary).map(action => action.key)

    expect(perRoom).toEqual([ActionKey.SendDanmaku, ActionKey.IntimacyTasks, ActionKey.Fishing])
    expect(senders).toEqual([ActionKey.SendDanmaku])
  })

  it('tells a person about the web session before they switch 粉丝家园签到 on', () => {
    const fanshome = douyuPlatform.actions.find(action => action.key === ActionKey.FanshomeSign)

    // It is the only action here whose credential is more than the token, and the state without
    // one is `blocked` — so the sentence read *before* the switch is where a person finds out that
    // a re-bind is what such a day would be asking for. Nothing is said about a reward: for this
    // endpoint there is no evidence either way, and a figure here would be the one thing read
    // before deciding whether to trust the action at all.
    expect(fanshome?.description).toContain('网页会话')
    expect(fanshome?.description).toContain('扫码')
    expect(fanshome?.description).not.toMatch(/鱼丸|积分|亲密度/)
  })
})

/* ------------------------------------------------------------------ *
 * The credential blob
 * ------------------------------------------------------------------ */

describe('the credential blob', () => {
  it('splits the composite token from both ends, so an underscore inside stk survives', () => {
    const parsed = parseCredential(JSON.stringify({ token: 'uid_12_ab_cd_9_ltkid', did: DID }))
    expect(parsed).toMatchObject({ uid: 'uid', biz: '12', stk: 'ab_cd', ct: '9', ltkid: 'ltkid' })
  })

  it('reads the documented three-field blob, leaving the optional parts as defaults', () => {
    const parsed = parseCredential(JSON.stringify({ token: TOKEN, did: DID }))
    expect(parsed).toMatchObject({ ...CREDENTIAL_ARGS, token: TOKEN, did: DID, webCookies: '', expiresAt: null })
  })

  it('refuses a token that is not five components, and a blob that is not JSON', () => {
    expect(parseCredential(JSON.stringify({ token: 'uid_1_stk_0', did: DID }))).toBeNull()
    expect(parseCredential(JSON.stringify({ token: TOKEN }))).toBeNull()
    expect(parseCredential('not json')).toBeNull()
    expect(parseCredential('{}')).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * The classification table
 * ------------------------------------------------------------------ */

/**
 * The table's own contract, asserted directly rather than only through a caller.
 *
 * The three "already done" codes arrive on the HTTP families, so `send` and `reconcile`
 * reach them on paths a socket-shaped test cannot; and a dropped entry does not fail
 * loudly there — it turns a parked action into a retry loop that runs all day, which is
 * precisely the silent drift this pins down.
 */
describe('the classification table', () => {
  it.each([CLIENT_SIGN_ALREADY_SIGNED, ACTIVITY_ALREADY_SIGNED, ACTIVITY_SIGN_SUCCESS])(
    'grades %i as action_stop',
    code => {
      expect(classifyError(code)).toBe('action_stop')
    }
  )
})

/* ------------------------------------------------------------------ *
 * send
 * ------------------------------------------------------------------ */

describe('send', () => {
  it('builds the danmaku session out of the blob and reports res=0 as ok', async () => {
    const outcome = await douyuPlatform.send(account(), '12306', '这条消息请忽略')

    expect(outcome).toEqual({ ok: true, code: '0', detail: '', failure: 'none' })
    expect(sendDanmakuMock).toHaveBeenCalledWith(
      { roomId: '12306', deviceId: DID, ...CREDENTIAL_ARGS },
      '这条消息请忽略'
    )
  })

  it('grades res=290 as retry — a cadence problem, not a session problem', async () => {
    sendDanmakuMock.mockResolvedValue(refused(290, 'the message was refused with res 290'))
    const outcome = await douyuPlatform.send(account(), '12306', 'x')

    expect(outcome).toMatchObject({ ok: false, code: '290', failure: 'retry' })
    expect(outcome.detail).toContain('2 秒')
  })

  it('grades res=356 as action_stop and names the content rule behind it', async () => {
    sendDanmakuMock.mockResolvedValue(refused(356, 'the message was refused with res 356'))
    const outcome = await douyuPlatform.send(account(), '12306', 'x')

    expect(outcome).toMatchObject({ ok: false, code: '356', failure: 'action_stop' })
    expect(outcome.detail).toContain('连续字母数字串')
    expect(outcome.detail).toContain('URL')
  })

  it.each([401000206, 1002, 999999])('grades %i as account_stop', async code => {
    sendDanmakuMock.mockResolvedValue(refused(code))
    const outcome = await douyuPlatform.send(account(), '12306', 'x')

    expect(outcome).toMatchObject({ ok: false, code: String(code), failure: 'account_stop' })
  })

  it('retries an unknown code, carrying it verbatim', async () => {
    sendDanmakuMock.mockResolvedValue(refused(4242, 'the message was refused with res 4242'))
    const outcome = await douyuPlatform.send(account(), '12306', 'x')

    expect(outcome).toMatchObject({ ok: false, code: '4242', failure: 'retry' })
  })

  it('retries when no verdict arrived at all', async () => {
    sendDanmakuMock.mockResolvedValue(refused(null, 'timed out after 15000 ms: no chatres came back'))
    const outcome = await douyuPlatform.send(account(), '12306', 'x')

    expect(outcome).toMatchObject({ ok: false, code: 'no_verdict', failure: 'retry' })
  })

  it('grades on the code, never on a substring of the message', async () => {
    // A 290 whose message happens to contain 356 must stay a cadence retry.
    sendDanmakuMock.mockResolvedValue(refused(290, 'compare with res 356 if you like'))
    const outcome = await douyuPlatform.send(account(), '12306', 'x')

    expect(outcome).toMatchObject({ code: '290', failure: 'retry' })
  })

  it('treats a rejected socket as transport, not as a Douyu verdict', async () => {
    sendDanmakuMock.mockRejectedValue(new Error('this runtime has no global WebSocket'))
    const outcome = await douyuPlatform.send(account(), '12306', 'x')

    expect(outcome).toMatchObject({ ok: false, code: 'transport', failure: 'retry' })
    expect(outcome.detail).toContain('no global WebSocket')
  })

  it('stops on a target that is not a room number, without touching the socket', async () => {
    const outcome = await douyuPlatform.send(account(), 'not-a-room', 'x')

    expect(outcome).toMatchObject({ ok: false, code: 'bad_target', failure: 'action_stop' })
    expect(sendDanmakuMock).not.toHaveBeenCalled()
  })

  it('stops the account when the credential cannot be parsed', async () => {
    const outcome = await douyuPlatform.send(account('{}'), '12306', 'x')

    expect(outcome).toMatchObject({ ok: false, code: 'no_credential', failure: 'account_stop' })
    expect(sendDanmakuMock).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ *
 * The wire schemas
 * ------------------------------------------------------------------ */

/**
 * The counter Douyu spells two ways.
 *
 * §2.2 measures both spellings on adjacent endpoints — `sendFishBall` answers
 * `"num":20`, `sendSign` answers `"sign_cnt":"1"` — so a schema that read only one of
 * them would fail on the other. The three cases below are the whole contract: a
 * number, a numeric string, and nothing else.
 */
describe('a counter Douyu types inconsistently', () => {
  const counters = {
    sign_today: '2026-10-08',
    sign_cnt: 1,
    sign_sum: '2',
    sign_rd: 3,
    sign_md: 0,
    sign_exp: 15,
    sign_exps: 12
  }

  it('reads a JSON number and a numeric string alike', () => {
    expect(clientSignDataSchema.safeParse(counters)).toMatchObject({ success: true, data: { sign_sum: 2 } })
  })

  it('rejects text that is not a number, where a Number() transform succeeded with NaN', () => {
    expect(clientSignDataSchema.safeParse({ ...counters, sign_cnt: 'abc' })).toMatchObject({ success: false })
  })

  it('refuses what a bare z.coerce.number() would turn into 0', () => {
    expect(clientSignDataSchema.safeParse({ ...counters, sign_cnt: null })).toMatchObject({ success: false })
  })
})

/* ------------------------------------------------------------------ *
 * probe
 * ------------------------------------------------------------------ */

describe('probe', () => {
  it('normalises show_status 1 to live', async () => {
    const result = await douyuPlatform.probe(account(), '12306')

    expect(result).toMatchObject({ ok: true, liveStatus: 1, title: '电棍的直播间', code: '1', failure: 'none' })
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://www.douyu.com/betard/12306'])
  })

  it('normalises show_status 2 (an anchor who is not streaming) to not live', async () => {
    fetchMock.mockResolvedValue(roomResponse(roomPayload({ show_status: 2 })))
    const result = await douyuPlatform.probe(account(), '12306')

    expect(result).toMatchObject({ ok: true, liveStatus: 0, code: '2', failure: 'none' })
  })

  it('reports a room it could not read at all, graded retry', async () => {
    fetchMock.mockResolvedValue(new Response('<html>not found</html>', { status: 404 }))
    const result = await douyuPlatform.probe(account(), '12306')

    expect(result).toMatchObject({ ok: false, liveStatus: 0, code: 'http_404', failure: 'retry' })
  })

  it('reports a payload that is not a room as transport, not as liveness', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }))
    const result = await douyuPlatform.probe(account(), '12306')

    expect(result).toMatchObject({ ok: false, liveStatus: 0, code: 'transport', failure: 'retry' })
  })

  /**
   * The one input the old `Number()` transform got wrong, at the seam where it cost
   * the most: `'abc'` used to parse as a successful `NaN`, and `NaN === 1` is false, so
   * a room whose `show_status` was unreadable was reported as *offline* — a verdict
   * nothing had established. It has to be a retry instead.
   */
  it('refuses a show_status it cannot read, rather than calling the room offline', async () => {
    fetchMock.mockResolvedValue(roomResponse(roomPayload({ show_status: 'abc' })))
    const result = await douyuPlatform.probe(account(), '12306')

    expect(result).toMatchObject({ ok: false, liveStatus: 0, failure: 'retry' })
  })

  // `12306abc` is the case `parseInt` alone gets wrong: it would read room 12306 out of
  // a key that is not an id at all.
  it.each(['yyf', '12306abc'])('reports a target that is not a room number, without a request', async targetKey => {
    const result = await douyuPlatform.probe(account(), targetKey)

    expect(result).toMatchObject({ ok: false, code: 'bad_target', failure: 'action_stop' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ *
 * resolveTarget
 * ------------------------------------------------------------------ */

describe('resolveTarget', () => {
  const expectedTarget = {
    key: '12306',
    title: '电棍的直播间',
    anchorId: '310260',
    anchorName: '电棍',
    // The raw show_status, as `TargetInfo` documents; `probe` is where it is normalised.
    liveStatus: 1,
    // Empty on purpose, and the reason is the contrast with Bilibili's adapter: this Platform
    // reports the room's own name and the Anchor's name in one payload, so there is never a
    // reason a person has to be told about here. Bilibili is the one that may answer without a
    // name, and that is where `titleNote` carries a sentence.
    titleNote: ''
  }

  it.each([
    ['12306'],
    ['https://www.douyu.com/12306?from=search'],
    ['www.douyu.com/12306'],
    ['https://m.douyu.com/12306']
  ])('accepts %s', async input => {
    await expect(douyuPlatform.resolveTarget(input)).resolves.toEqual(expectedTarget)
  })

  it('follows the room page redirect for a vanity path', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://www.douyu.com/yyf') {
        return new Response(null, { status: 302, headers: { location: '/45977' } })
      }
      return roomResponse(roomPayload({ room_id: 45977 }))
    })

    await expect(douyuPlatform.resolveTarget('https://www.douyu.com/yyf')).resolves.toMatchObject({ key: '45977' })
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://www.douyu.com/yyf',
      'https://www.douyu.com/betard/45977'
    ])
  })

  it.each([['https://example.com/12306'], ['https://yuba.douyu.com/group/123'], ['douyu.com/'], ['nonsense']])(
    'refuses %s rather than guessing at a room',
    async input => {
      await expect(douyuPlatform.resolveTarget(input)).rejects.toThrow('无法从该链接解析出斗鱼房间号')
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  /** The sentence one refused `resolveTarget` produced; see the Bilibili adapter's copy for why. */
  async function refusalMessageOf(input: string): Promise<string> {
    try {
      await douyuPlatform.resolveTarget(input)
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error(`resolveTarget accepted ${input}, and this case needs it refused`)
  }

  /**
   * A room the service does not have is the person's typo, not a gateway fault.
   *
   * `betard/<unknown>` answering a 404 HTML page is the endpoint's own contract for a room that is not
   * there (`fetchRoomMeta`), while a room it *has* and refuses arrives as something else — a 5xx below,
   * or a body that is not a room. This is the distinction: the 404 is about the number that was
   * pasted, and the sentence says which number, because that is the only part a person can act on.
   */
  it('reports a room the service does not have as the input problem it is', async () => {
    fetchMock.mockImplementation(async () => new Response('<html>not found</html>', { status: 404 }))

    const message = await refusalMessageOf('12306')

    expect(message).toContain('没有房间号 12306')
    // Neither the gateway status nor the route's transport sentence: nothing about the connection
    // was wrong, and a person sent to 「稍后再试」 would keep retrying their own typo.
    expect(message).not.toContain('HTTP 404')
    expect(message).not.toContain('查询目标失败')
  })

  it('leaves a room read that failed for any other reason as a transport failure', async () => {
    // The other side of that boundary. Grading this as the input's fault would tell a person their room
    // number is wrong on an afternoon when the service is down, so the status travels as it always did.
    fetchMock.mockImplementation(async () => new Response('upstream is down', { status: 503 }))

    await expect(douyuPlatform.resolveTarget('12306')).rejects.toMatchObject({ status: 503 })
  })
})

/* ------------------------------------------------------------------ *
 * reconcile
 * ------------------------------------------------------------------ */

/**
 * The instant every case below runs at unless it says otherwise: Shanghai 06:22 on
 * 2026-10-08, which is **outside** 打卡分鱼丸's check-in window.
 */
const BEFORE_WINDOW = 1_791_411_776_000

/** Shanghai 2026-10-09 19:30 — inside that window, the only two hours a day it opens. */
const INSIDE_CLOCK_WINDOW = Date.parse('2026-10-09T11:30:00Z')

async function reconcileWith(
  enabledActions: readonly string[],
  now: number = BEFORE_WINDOW
): Promise<{ outcomes: ActionOutcome[]; logs: string[] }> {
  const logs: string[] = []
  const outcomes = await douyuPlatform.reconcile({
    account: account(),
    targetKey: '',
    enabledActions,
    // Every case here is about a verdict, and the action that reads an option is driven in
    // `douyu-intimacy-tasks.test.ts`; an empty map is what a switch nobody set anything on carries.
    options: {},
    now,
    dayKey: '2026-10-08',
    log: line => logs.push(line)
  })
  return { outcomes, logs }
}

describe('reconcile', () => {
  it('runs nothing when nothing is switched on', async () => {
    const { outcomes } = await reconcileWith([])

    expect(outcomes).toEqual([])
    expect(sendClientSignMock).not.toHaveBeenCalled()
  })

  it('returns one outcome per enabled key, in the order given', async () => {
    const { outcomes } = await reconcileWith([ActionKey.Fishball, ActionKey.SignIn])

    expect(outcomes.map(outcome => outcome.actionKey)).toEqual([ActionKey.Fishball, ActionKey.SignIn])
  })

  it('scopes every outcome to the account, never to a room', async () => {
    const { outcomes } = await reconcileWith([
      ActionKey.SignIn,
      ActionKey.Fishball,
      ActionKey.YubaSign,
      ActionKey.FanshomeSign,
      ActionKey.ActivitySign,
      ActionKey.GrowthPool
    ])

    expect(outcomes.every(outcome => outcome.targetKey === '')).toBe(true)
  })

  describe('sign_in', () => {
    it('bootstraps the csrf cookie and signs', async () => {
      const { outcomes, logs } = await reconcileWith([ActionKey.SignIn])

      expect(fetchCsrfCookieMock).toHaveBeenCalledWith(TOKEN)
      expect(sendClientSignMock).toHaveBeenCalledWith(TOKEN, 'dy_cookie_value')
      expect(logs).toEqual([])

      const outcome = outcomeOf(outcomes, ActionKey.SignIn)
      expect(outcome).toMatchObject({ outcome: 'done', failure: 'none' })
      expect(outcome.detail).toContain('连签 7 天')
      expect(outcome.detail).toContain('本次经验 +10')
    })

    it('reports 6305 as already done, and parks it for the day', async () => {
      sendClientSignMock.mockResolvedValue({
        ok: true,
        code: CLIENT_SIGN_ALREADY_SIGNED,
        data: { alreadySignedToday: true, status: null }
      })

      const outcome = outcomeOf((await reconcileWith([ActionKey.SignIn])).outcomes, ActionKey.SignIn)

      expect(outcome).toMatchObject({
        outcome: 'already',
        code: String(CLIENT_SIGN_ALREADY_SIGNED),
        failure: 'action_stop'
      })
    })

    it('carries a dead session through as account_stop', async () => {
      sendClientSignMock.mockResolvedValue(refused(1002, '用户未登录'))

      const outcome = outcomeOf((await reconcileWith([ActionKey.SignIn])).outcomes, ActionKey.SignIn)

      expect(outcome).toMatchObject({ outcome: 'failed', code: '1002', failure: 'account_stop' })
      expect(outcome.detail).toBe('用户未登录')
    })

    it('stops when the csrf bootstrap is refused', async () => {
      fetchCsrfCookieMock.mockResolvedValue(refused(999999, '系统错误'))

      const outcome = outcomeOf((await reconcileWith([ActionKey.SignIn])).outcomes, ActionKey.SignIn)

      expect(outcome).toMatchObject({ outcome: 'failed', code: '999999', failure: 'account_stop' })
      expect(sendClientSignMock).not.toHaveBeenCalled()
    })
  })

  describe('fishball', () => {
    it('reads the balance, claims, and reports the balance', async () => {
      const outcome = outcomeOf((await reconcileWith([ActionKey.Fishball])).outcomes, ActionKey.Fishball)

      expect(readFishBallBalanceMock).toHaveBeenCalledWith(TOKEN)
      // The uid comes from the token, so a claim can only be made for the session holding it.
      expect(claimFishBallMock).toHaveBeenCalledWith(TOKEN, CREDENTIAL_ARGS.uid)
      expect(outcome).toMatchObject({ outcome: 'done', code: '0', failure: 'none' })
      expect(outcome.detail).toContain('20')
    })

    it('maps -1 to already, and that mapping lives in the adapter rather than the global table', async () => {
      claimFishBallMock.mockResolvedValue(refused(FISH_BALL_ALREADY_CLAIMED, '当天已经领过鱼丸'))

      // The global table must not claim -1 means anything: it is also "already done"
      // on unrelated endpoints, so the meaning is only attached here.
      expect(classifyError(FISH_BALL_ALREADY_CLAIMED)).toBe('retry')

      const outcome = outcomeOf((await reconcileWith([ActionKey.Fishball])).outcomes, ActionKey.Fishball)

      expect(outcome).toMatchObject({
        outcome: 'already',
        code: String(FISH_BALL_ALREADY_CLAIMED),
        failure: 'action_stop'
      })
      expect(outcome.detail).toContain('20')
    })

    it('does not claim anything when the balance read fails', async () => {
      readFishBallBalanceMock.mockResolvedValue(refused(1002, '用户未登录'))

      const outcome = outcomeOf((await reconcileWith([ActionKey.Fishball])).outcomes, ActionKey.Fishball)

      expect(outcome).toMatchObject({ outcome: 'failed', code: '1002', failure: 'account_stop' })
      expect(claimFishBallMock).not.toHaveBeenCalled()
    })
  })

  describe('yuba_sign', () => {
    it('attempts every followed group and aggregates them into one outcome', async () => {
      listFollowedGroupsMock.mockResolvedValue({
        ok: true,
        code: 200,
        data: [group('1', '主版块'), group('2', '安卓版块'), group('3', 'PC 版块')]
      })
      signGroupAndroidMock.mockImplementation(async (_token: string, groupId: string) => {
        // fastSign says "already" with a 200 and a zero level score…
        if (groupId === '2') return { ok: true, code: 200, data: { levelScore: 0, alreadySigned: true } }
        // …and the PC twin says it with 1001. Neither may be read as a failure.
        if (groupId === '3') return refused(YUBA_ALREADY_SIGNED, '今天已经签到过了')
        return { ok: true, code: 200, data: { levelScore: 3, alreadySigned: false } }
      })

      const { outcomes, logs } = await reconcileWith([ActionKey.YubaSign])

      expect(outcomes).toHaveLength(1)
      expect(outcomeOf(outcomes, ActionKey.YubaSign)).toMatchObject({ outcome: 'done', failure: 'none' })
      expect(outcomeOf(outcomes, ActionKey.YubaSign).detail).toContain('3 个版块')
      expect(outcomeOf(outcomes, ActionKey.YubaSign).detail).toContain('新签 1')
      // One line per group, so a half-finished run is visible in the sweep's log.
      expect(logs).toHaveLength(3)
      expect(logs[0]).toContain('主版块')
    })

    it('is only a success when nothing new happened — all already means already', async () => {
      listFollowedGroupsMock.mockResolvedValue({ ok: true, code: 200, data: [group('1'), group('2')] })
      signGroupAndroidMock.mockResolvedValue({ ok: true, code: 200, data: { levelScore: 0, alreadySigned: true } })

      const outcome = outcomeOf((await reconcileWith([ActionKey.YubaSign])).outcomes, ActionKey.YubaSign)

      expect(outcome).toMatchObject({ outcome: 'already', failure: 'action_stop' })
    })

    it('skips when the account follows nothing', async () => {
      listFollowedGroupsMock.mockResolvedValue({ ok: true, code: 200, data: [] })

      const outcome = outcomeOf((await reconcileWith([ActionKey.YubaSign])).outcomes, ActionKey.YubaSign)

      expect(outcome).toMatchObject({ outcome: 'skipped', failure: 'none' })
      expect(signGroupAndroidMock).not.toHaveBeenCalled()
    })

    it('reports the walk itself as the failure when the first page cannot be read', async () => {
      listFollowedGroupsMock.mockResolvedValue(refused(1002, '用户未登陆或token已过期'))

      const outcome = outcomeOf((await reconcileWith([ActionKey.YubaSign])).outcomes, ActionKey.YubaSign)

      expect(outcome).toMatchObject({ outcome: 'failed', code: '1002', failure: 'account_stop' })
    })

    it('lets an account_stop outrank a group that signed successfully', async () => {
      listFollowedGroupsMock.mockResolvedValue({ ok: true, code: 200, data: [group('1'), group('2')] })
      signGroupAndroidMock.mockImplementation(async (_token: string, groupId: string) =>
        groupId === '2'
          ? refused(1002, '用户未登陆或token已过期')
          : { ok: true, code: 200, data: { levelScore: 3, alreadySigned: false } }
      )

      const outcome = outcomeOf((await reconcileWith([ActionKey.YubaSign])).outcomes, ActionKey.YubaSign)

      expect(outcome).toMatchObject({ outcome: 'failed', failure: 'account_stop' })
      expect(outcome.detail).toContain('新签 1')
    })

    it('walks to a second page, de-duplicating by group id', async () => {
      const first = Array.from({ length: 30 }, (_unused, index) => group(String(index + 1)))
      listFollowedGroupsMock
        .mockResolvedValueOnce({ ok: true, code: 200, data: first })
        .mockResolvedValueOnce({ ok: true, code: 200, data: [group('31'), group('32')] })

      const { outcomes } = await reconcileWith([ActionKey.YubaSign])

      expect(listFollowedGroupsMock).toHaveBeenCalledTimes(2)
      expect(signGroupAndroidMock).toHaveBeenCalledTimes(32)
      expect(outcomeOf(outcomes, ActionKey.YubaSign).detail).toContain('32 个版块')
    })

    it('stops when the service ignores the page parameter instead of re-signing the page', async () => {
      const page = Array.from({ length: 30 }, (_unused, index) => group(String(index + 1)))
      listFollowedGroupsMock.mockResolvedValue({ ok: true, code: 200, data: page })

      const { outcomes } = await reconcileWith([ActionKey.YubaSign])

      // Page 2 came back as page 1: no new ids, so the walk ends.
      expect(listFollowedGroupsMock).toHaveBeenCalledTimes(2)
      expect(signGroupAndroidMock).toHaveBeenCalledTimes(30)
      expect(outcomeOf(outcomes, ActionKey.YubaSign).detail).toContain('新签 30')
    })
  })

  describe('fanshome_sign', () => {
    /**
     * The one action whose blob needs both halves, so these runs carry a web session.
     *
     * The default blob every other case in this file uses has none, which is exactly the state
     * this account is in today — and that state has a case of its own below.
     */
    async function fanshomeRun(credentials: string = webCredentials()): Promise<{
      outcome: ActionOutcome
      logs: string[]
    }> {
      const logs: string[] = []
      const outcomes = await douyuPlatform.reconcile({
        account: account(credentials),
        targetKey: '',
        enabledActions: [ActionKey.FanshomeSign],
        options: {},
        now: BEFORE_WINDOW,
        dayKey: '2026-10-08',
        log: line => logs.push(line)
      })
      return { outcome: outcomeOf(outcomes, ActionKey.FanshomeSign), logs }
    }

    it('signs each room with the session, and with the ctn the read minted rather than the one in the blob', async () => {
      signFansHomeMock.mockImplementation(async (_token: string, _cookies: string, _ctn: string, rid: string) =>
        rid === '12293234'
          ? { ok: true, code: 0, data: { alreadySigned: false } }
          : { ok: true, code: FANSHOME_ALREADY_SIGNED, data: { alreadySigned: true } }
      )

      const { outcome, logs } = await fanshomeRun()

      // The adapter's whole contract with the protocol layer: it passes the credential in — the
      // token, the session, and the value the read handed it — instead of letting `protocol.ts`
      // reach into the blob. That is what keeps "a web cookie never reaches `h5nc/*`" a
      // structural property of that module rather than a rule somebody has to remember.
      expect(readFanBadgesMock).toHaveBeenCalledWith(TOKEN, WEB_COOKIES)
      expect(signFansHomeMock.mock.calls).toEqual([
        [TOKEN, WEB_COOKIES, MINTED_CCN, '12293234'],
        [TOKEN, WEB_COOKIES, MINTED_CCN, '12306']
      ])
      // …and specifically not the `acf_ccn` the header was carrying: the value the service set in
      // the read's own response is the newest thing it has said about this session.
      expect(signFansHomeMock.mock.calls[0]?.[2]).not.toBe(HELD_CCN)

      expect(outcome).toMatchObject({ outcome: 'done', failure: 'none', detail: '新签 1、已签 1（共 2 个直播间）' })
      expect(outcome.items).toEqual([
        { kind: 'room', label: '145oni', outcome: 'done', detail: '已签', code: '0' },
        { kind: 'room', label: '电棍', outcome: 'already', detail: '已签', code: '-1' }
      ])
      // One console line per room, so a half-signed walk is visible in the sweep's log — behind
      // the walk's opening line, which states where the CSRF value came from. That line is the
      // adapter's own account of the precondition (see `csrfNote`): the origin, and the value's
      // length, never the value.
      expect(logs).toEqual([
        '粉丝家园：读粉丝牌这次下发了 acf_ccn，本次请求带的 CSRF 值取自它，长度 16',
        '粉丝家园「145oni（房间 12293234）」：签到成功',
        '粉丝家园「电棍（房间 12306）」：今天已经签到过了'
      ])
    })

    it('parks the day when every room was already signed', async () => {
      const { outcome } = await fanshomeRun()

      // `-1` is 「今日已签到，请明天再来」 — the day's goal reached, and a daily reset makes it a
      // new attempt tomorrow. It is not in the global table, so only this branch can mean it.
      expect(outcome).toMatchObject({
        outcome: 'already',
        code: String(FANSHOME_ALREADY_SIGNED),
        failure: 'action_stop'
      })
      expect(outcome.detail).toBe('新签 0、已签 2（共 2 个直播间）')
      expect(outcome.items.every(item => item.outcome === 'already')).toBe(true)
    })

    it('falls back to the acf_ccn the blob carries when the read minted none', async () => {
      readFanBadgesMock.mockResolvedValue({ badges: [badge('12306', '电棍')], csrf: null })

      await fanshomeRun()

      expect(signFansHomeMock).toHaveBeenCalledWith(TOKEN, WEB_COOKIES, HELD_CCN, '12306')
    })

    it('reports blocked — and sends nothing at all — when the account has no web session', async () => {
      const outcome = outcomeOf((await reconcileWith([ActionKey.FanshomeSign])).outcomes, ActionKey.FanshomeSign)

      // This action needs a session beside its token, and this is the state the account is in
      // today. The badge wall would answer a logged-out page and a session-less sign is refused
      // at the identity layer, so neither call may be attempted: no read, no write.
      expect(readFanBadgesMock).not.toHaveBeenCalled()
      expect(signFansHomeMock).not.toHaveBeenCalled()
      expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_web_session', failure: 'action_stop' })
      expect(outcome.detail).toContain('网页会话')
      expect(outcome.detail).toContain('重新扫码绑定')
      // An item all the same: a blocked run has to be explainable in the UI, not only in a log.
      expect(outcome.items).toEqual([
        {
          kind: 'account',
          label: '粉丝家园签到',
          outcome: 'blocked',
          detail: outcome.detail,
          code: 'no_web_session'
        }
      ])
    })

    it('does not write when the badge wall listed no room', async () => {
      readFanBadgesMock.mockResolvedValue({ badges: [], csrf: MINTED_CCN })

      const { outcome } = await fanshomeRun()

      // An account holding no 粉丝牌, or a session the page no longer recognises — and nothing
      // here can tell the two apart, so the day is deliberately **not** settled with `skipped`.
      expect(signFansHomeMock).not.toHaveBeenCalled()
      expect(outcome).toMatchObject({ outcome: 'blocked', code: 'no_badges', failure: 'none' })
      expect(outcome.detail).toContain('网页会话')
    })

    it('does not write when no ctn can be assembled at all', async () => {
      readFanBadgesMock.mockResolvedValue({ badges: [badge('12293234', '145oni')], csrf: null })

      // A session that carries no `acf_ccn` and a read that minted none: there is no value to
      // send, and no request of this family has ever passed the CSRF layer with an empty `ctn`.
      // A guess is not sent — and the state is its own, distinct from a refusal of a value that
      // *was* sent, which is why the code is `csrf_unavailable` rather than `csrf_rejected` or
      // `no_web_session`: the session answered the read above.
      const { outcome } = await fanshomeRun(
        JSON.stringify({ token: TOKEN, did: DID, webCookies: 'acf_auth=1_1_abcdef' })
      )

      expect(signFansHomeMock).not.toHaveBeenCalled()
      expect(outcome).toMatchObject({ outcome: 'blocked', code: 'csrf_unavailable', failure: 'action_stop' })
      expect(outcome.detail).toContain('拿不到')
      expect(outcome.detail).not.toContain('重新扫码绑定')
    })

    it('keeps walking past a room the service refuses, and still counts the room that signed', async () => {
      signFansHomeMock.mockImplementation(async (_token: string, _cookies: string, _ctn: string, rid: string) =>
        // 「签到失败，非房间粉丝用户」 is what the probe recorded for a room with no medal; the code it
        // came with was never written down, so this number is a placeholder. The case is about
        // the walk continuing, not about the code — an unclassified one is graded `retry`.
        rid === '12306'
          ? refused(2000, '签到失败，非房间粉丝用户')
          : { ok: true, code: 0, data: { alreadySigned: false } }
      )

      const { outcome } = await fanshomeRun()

      // The room that signed stays signed: a refusal does not end the walk, and it is reported
      // rather than swallowed — but a run that signed a room is a `done`, which is the shared
      // aggregate's order and 鱼吧's own. Only an `account_stop` outranks a success, because
      // nothing works again after one until a person re-binds.
      expect(signFansHomeMock).toHaveBeenCalledTimes(2)
      expect(outcome).toMatchObject({ outcome: 'done', failure: 'none' })
      expect(outcome.detail).toBe('新签 1、已签 0（共 2 个直播间）、失败 1')
      expect(outcome.items).toEqual([
        { kind: 'room', label: '145oni', outcome: 'done', detail: '已签', code: '0' },
        { kind: 'room', label: '电棍', outcome: 'failed', detail: '签到失败，非房间粉丝用户', code: '2000' }
      ])
    })

    it('reports the worst refusal when no room signed at all', async () => {
      signFansHomeMock.mockResolvedValue(refused(2000, '签到失败，非房间粉丝用户'))

      const { outcome } = await fanshomeRun()

      // The other half of the aggregate: with nothing signed and nothing already done, the run
      // is the worst refusal it met, and the room that met it is one of the items below it. When
      // two refusals rank the same — both `retry` here — the first one met is the one quoted.
      expect(signFansHomeMock).toHaveBeenCalledTimes(2)
      expect(outcome).toMatchObject({ outcome: 'failed', code: '2000', failure: 'retry' })
      expect(outcome.detail).toBe('新签 0、已签 0（共 2 个直播间）、失败 2；「145oni」签到失败，非房间粉丝用户')
      expect(outcome.items.every(item => item.outcome === 'failed')).toBe(true)
    })

    it('reports the badge wall’s own failure as the action’s, and writes nothing', async () => {
      readFanBadgesMock.mockRejectedValue(new DouyuTransportError(FAN_BADGES_URL, 0, 'fetch failed'))

      const { outcome } = await fanshomeRun()

      expect(signFansHomeMock).not.toHaveBeenCalled()
      expect(outcome).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
      expect(outcome.detail).toContain('读取粉丝牌列表失败')
    })
  })

  describe('activity_sign', () => {
    it('reads the gate first, then signs when today is not signed', async () => {
      const outcome = outcomeOf((await reconcileWith([ActionKey.ActivitySign])).outcomes, ActionKey.ActivitySign)

      expect(readActivitySignStatusMock).toHaveBeenCalledWith(TOKEN)
      expect(signActivityMock).toHaveBeenCalledWith(TOKEN)
      expect(outcome).toMatchObject({ outcome: 'done', code: '31200', failure: 'none' })
    })

    it('skips the write when the gate already says today is signed', async () => {
      readActivitySignStatusMock.mockResolvedValue({ ok: true, code: 0, data: { todaySigned: 1 } })

      const outcome = outcomeOf((await reconcileWith([ActionKey.ActivitySign])).outcomes, ActionKey.ActivitySign)

      // The gate is what makes this knowable at all: `doSign` answers the same code whether
      // the signature just landed or was already in place.
      expect(signActivityMock).not.toHaveBeenCalled()
      expect(outcome).toMatchObject({ outcome: 'already', failure: 'action_stop' })
      // One word, because the row it lands in is named 「任务中心签到」 and the heading above it
      // has already said the day is done; the record's `outcome` is what says which of the two
      // this was.
      expect(outcome.detail).toBe('已签')
      // The read's own `0`, not `31015`: nothing on this path has received that number, and
      // reporting it would be quoting a response this run never saw.
      expect(outcome.code).toBe('0')
      expect(outcome.items[0]?.code).toBe(OPFOY_SIGN_ALIAS)
    })

    it('grades the gate’s 300 as account_stop, never as “nothing to do”', async () => {
      readActivitySignStatusMock.mockResolvedValue(refused(300, '请登录'))

      const outcome = outcomeOf((await reconcileWith([ActionKey.ActivitySign])).outcomes, ActionKey.ActivitySign)

      // The whole reason the gate is fail-closed. `300` is this family's answer for a token
      // that is not a session; read as "not signed today" it would be a quiet skip, and the
      // account would fall behind behind a task that looks perfectly healthy.
      expect(outcome).toMatchObject({ outcome: 'failed', code: '300', failure: 'account_stop' })
      expect(outcome.detail).toContain('读取任务中心签到状态失败')
      expect(signActivityMock).not.toHaveBeenCalled()
      // And the classification is local: the global table has never seen `300`.
      expect(classifyError(300)).toBe('retry')
    })

    it('does not read an unknown todaySigned as “not signed”, and does not write', async () => {
      readActivitySignStatusMock.mockResolvedValue({ ok: true, code: 0, data: { todaySigned: 2 } })

      const outcome = outcomeOf((await reconcileWith([ActionKey.ActivitySign])).outcomes, ActionKey.ActivitySign)

      expect(outcome).toMatchObject({ outcome: 'blocked', failure: 'none' })
      // The value rides in `code`, where the debug section prints it, instead of becoming a
      // claim in a sentence a person reads.
      expect(outcome.code).toBe('2')
      expect(signActivityMock).not.toHaveBeenCalled()
    })

    it('reports 31015 as already signed, and parks it for the day', async () => {
      signActivityMock.mockResolvedValue({ ok: true, code: ACTIVITY_ALREADY_SIGNED, data: { alreadySigned: true } })

      const outcome = outcomeOf((await reconcileWith([ActionKey.ActivitySign])).outcomes, ActionKey.ActivitySign)

      expect(outcome).toMatchObject({
        outcome: 'already',
        code: String(ACTIVITY_ALREADY_SIGNED),
        failure: 'action_stop'
      })
    })

    it('says what happened as a fact, and leaves the signAlias to the code field', async () => {
      const done = outcomeOf((await reconcileWith([ActionKey.ActivitySign])).outcomes, ActionKey.ActivitySign)

      // `活动「20250521OPFOY_qd2」签到成功。` is what this once said, and it told a person
      // nothing. Two rounds of shortening followed: the activity is named by the row's own
      // label (「任务中心签到」, from the catalogue), the alias — an identifier nobody can read —
      // rides on the item's code, which the debug section renders and the main sections never
      // do, and what is left once both are gone is the fact.
      expect(done.detail).toBe('已签')
      expect(done.detail).not.toContain(OPFOY_SIGN_ALIAS)
      expect(done.code).toBe('31200')
      expect(done.items[0]?.code).toBe(OPFOY_SIGN_ALIAS)

      signActivityMock.mockResolvedValue({ ok: true, code: ACTIVITY_ALREADY_SIGNED, data: { alreadySigned: true } })
      const already = outcomeOf((await reconcileWith([ActionKey.ActivitySign])).outcomes, ActionKey.ActivitySign)

      // The same fact, because it is the same fact: 「今天已经签过了」 is what the record's
      // `already` outcome says, and repeating it in words was the third statement of it.
      expect(already.detail).toBe('已签')
      expect(already.detail).not.toContain(OPFOY_SIGN_ALIAS)
      expect(already.items[0]?.code).toBe(OPFOY_SIGN_ALIAS)
    })

    it('states no reward, because the response carries none', async () => {
      const outcome = outcomeOf((await reconcileWith([ActionKey.ActivitySign])).outcomes, ActionKey.ActivitySign)

      // The activity does pay 积分 — the capture shows a 「签到礼包 +20」 ledger entry written in the
      // same second — but the award is neither in this response (`data: {}` is what the captured
      // `31200` body holds) nor read back by this adapter, and the config's own figure varies by
      // day. Reporting a number this adapter has not read back would be an invention.
      expect(outcome.detail).not.toMatch(/\d/)
    })
  })

  describe('growth_pool', () => {
    /** What `getSignInfo` reports about this round: `0` is 未报名, `1` is 已报名. */
    function inThisRound(signStatus: number) {
      return { ok: true, code: 0, data: { signStatus, ywTotal: 38400, joinTotal: 192 } }
    }

    async function poolRun(now: number = BEFORE_WINDOW): Promise<ActionOutcome> {
      return outcomeOf((await reconcileWith([ActionKey.GrowthPool], now)).outcomes, ActionKey.GrowthPool)
    }

    it('reports blocked — never skipped — when the check-in window has not opened', async () => {
      readGrowthPoolStatusMock.mockResolvedValue(inThisRound(1))

      const outcome = await poolRun()

      // The trap this case exists for. `skipped` is a **settled** outcome, so one here
      // would stop the sweep asking for the rest of the day — silently discarding the only
      // two hours the check-in exists in, which is exactly how this account lost 546 鱼丸
      // across seven missed windows.
      expect(outcome.outcome).toBe('blocked')
      expect(outcome.outcome).not.toBe('skipped')
      expect(outcome).toMatchObject({ code: 'window_not_open', failure: 'none' })
      expect(outcome.detail).toContain('19:00–21:00')
      expect(clockGrowthPoolMock).not.toHaveBeenCalled()
      expect(joinGrowthPoolMock).not.toHaveBeenCalled()
    })

    it('checks in once the window is open, and only then', async () => {
      readGrowthPoolStatusMock.mockResolvedValue(inThisRound(1))

      const outcome = await poolRun(INSIDE_CLOCK_WINDOW)

      expect(clockGrowthPoolMock).toHaveBeenCalledWith(TOKEN, 'dy_cookie_value')
      expect(joinGrowthPoolMock).not.toHaveBeenCalled()
      expect(outcome).toMatchObject({ outcome: 'done', code: '0', failure: 'none' })
      expect(outcome.detail).toContain('21:00')
    })

    it('signs up when the latch says the account is not in this round, and reports the pool', async () => {
      readGrowthPoolStatusMock.mockResolvedValue(inThisRound(0))

      const outcome = await poolRun()

      expect(joinGrowthPoolMock).toHaveBeenCalledWith(TOKEN, 'dy_cookie_value')
      expect(clockGrowthPoolMock).not.toHaveBeenCalled()
      expect(outcome).toMatchObject({ outcome: 'done', code: '0', failure: 'none' })
      expect(outcome.detail).toContain('200 鱼丸')
      expect(outcome.detail).toContain('38400')
      expect(outcome.detail).toContain('192')
      // One item, like every other account-scoped action: the switch a person turned on has
      // a sentence in the main UI rather than only a line in the console.
      expect(outcome.items).toHaveLength(1)
    })

    it('signs up without the pool numbers when the reply does not carry them', async () => {
      readGrowthPoolStatusMock.mockResolvedValue(inThisRound(0))
      joinGrowthPoolMock.mockResolvedValue({ ok: true, code: 0, data: {} })

      const outcome = await poolRun()

      // An upstream rename costs a clause rather than the action — and never a zero-filled
      // claim about a pool nobody counted.
      expect(outcome.outcome).toBe('done')
      expect(outcome.detail).toContain('200 鱼丸')
      expect(outcome.detail).not.toContain('本场奖池')
    })

    it('parks the day when the balance is short of the entry fee', async () => {
      readGrowthPoolStatusMock.mockResolvedValue(inThisRound(0))
      joinGrowthPoolMock.mockResolvedValue(refused(57002, '你的鱼丸不足200 无法参与打卡挑战'))

      const outcome = await poolRun()

      // `blocked` is the vocabulary's own word for a balance the Platform refused on, and
      // `action_stop` because no number of attempts mints 鱼丸.
      expect(outcome).toMatchObject({ outcome: 'blocked', code: '57002', failure: 'action_stop' })
      expect(outcome.detail).toContain('鱼丸不足 200')
    })

    it('treats a CSRF refusal as transient, and re-pairs on the next run', async () => {
      readGrowthPoolStatusMock.mockResolvedValue(inThisRound(0))
      joinGrowthPoolMock.mockResolvedValue(refused(152101, '请求异常'))

      const outcome = await poolRun()

      expect(outcome).toMatchObject({ outcome: 'failed', code: '152101', failure: 'retry' })
      // The sentence says what a person can act on — it is not the session, and it retries —
      // while the pair of parameter names that explains it stays in the code comment above.
      expect(outcome.detail).toContain('与账号会话无关')
      expect(outcome.detail).toContain('重新配对')
      expect(outcome.detail).not.toContain('需要重新绑定')

      // The retry is a **re-pairing**, not a resend: each run mints its own `dy_cookie`
      // rather than reusing the previous value, because the one thing this family's CSRF
      // double submit punishes is a body whose `dy_token` has drifted from the header's
      // `dy_cookie`. A live run saw 25 × `152101` inside one minute from exactly that.
      expect(fetchCsrfCookieMock).toHaveBeenCalledTimes(1)
      await poolRun()
      expect(fetchCsrfCookieMock).toHaveBeenCalledTimes(2)
    })

    it('grades a token the service will not accept as account_stop', async () => {
      readGrowthPoolStatusMock.mockResolvedValue(refused(10001, 'token error'))

      const outcome = await poolRun()

      // `10001` is what this family answers a body with no usable `token`. This adapter
      // always sends one, so seeing it means the session presented was not accepted — and
      // nothing a retry can fix.
      expect(outcome).toMatchObject({ outcome: 'failed', code: '10001', failure: 'account_stop' })
    })

    it('never writes on a latch it cannot name', async () => {
      readGrowthPoolStatusMock.mockResolvedValue(inThisRound(7))

      const outcome = await poolRun()

      // A latch nobody has seen is not read as "not joined": that reading spends 200 鱼丸 on
      // a state this build has no evidence about.
      expect(outcome).toMatchObject({ outcome: 'blocked', code: '7', failure: 'none' })
      expect(joinGrowthPoolMock).not.toHaveBeenCalled()
      expect(clockGrowthPoolMock).not.toHaveBeenCalled()
    })

    it('needs a credential before it can ask anything', async () => {
      const outcomes = await douyuPlatform.reconcile({
        account: account('{}'),
        targetKey: '',
        enabledActions: [ActionKey.GrowthPool],
        options: {},
        now: BEFORE_WINDOW,
        dayKey: '2026-10-08',
        log: () => undefined
      })

      expect(outcomeOf(outcomes, ActionKey.GrowthPool)).toMatchObject({
        outcome: 'failed',
        code: 'no_credential',
        failure: 'account_stop'
      })
      expect(fetchCsrfCookieMock).not.toHaveBeenCalled()
    })

    it('refuses a status payload with no latch, where defaulting one would spend money', () => {
      expect(growthPoolStatusSchema.safeParse({ ywTotal: 38400, joinTotal: 192 })).toMatchObject({ success: false })
      expect(growthPoolStatusSchema.safeParse({ signStatus: '1' })).toMatchObject({
        success: true,
        data: { signStatus: 1 }
      })
    })

    it('reads the measured join reply, whose data carries the pool and no latch', () => {
      // Verbatim from the live run of 2026-10-08. `signStatus` is absent here because the
      // activity page sets it to `1` itself after a successful join — a client-side
      // constant, not a field — and `clockLeftTime` is dropped because it counts to the
      // window opening and says nothing about it closing, so nothing may gate on it.
      const measured = growthPoolJoinSchema.parse({ ywTotal: 38400, joinTotal: 192, clockLeftTime: 107999 })

      expect(measured).toEqual({ ywTotal: 38400, joinTotal: 192 })
    })
  })

  describe('items', () => {
    /** The catalogue's own name for an action — what an item's label has to be. */
    function labelOf(actionKey: string): string {
      const descriptor = douyuPlatform.actions.find(action => action.key === actionKey)
      if (descriptor === undefined) throw new Error(`no descriptor for ${actionKey}`)
      return descriptor.label
    }

    /**
     * Every **account-scoped** action this adapter has an item for: the whole catalogue bar the send
     * action and the two per-Room ones.
     *
     * 亲密度任务 and 钓鱼 are driven with a `rid` in their own files, because these runs carry no target
     * — and a per-Room action handed none answers `bad_target` before it reads anything, which would
     * make the invariant below true for a reason that has nothing to do with items.
     */
    const RECONCILE_ACTIONS = [
      ActionKey.SignIn,
      ActionKey.Fishball,
      ActionKey.YubaSign,
      ActionKey.FanshomeSign,
      ActionKey.ActivitySign,
      ActionKey.GrowthPool
    ] as const

    /**
     * The invariant every run keeps: an item never contradicts its own record.
     *
     * Asserted as a relation rather than per case, because the failure it rules out is
     * silent — a `done` item inside a `failed` record reads, in the UI, as "it worked".
     * The check is one-directional on purpose: a record may report a worse outcome than
     * its items (an `account_stop` in one group outweighs two successes in others), but
     * its own verdict has to be one its items agree with.
     */
    async function expectItemsToAgree(enabled: readonly string[] = RECONCILE_ACTIONS): Promise<void> {
      const { outcomes } = await reconcileWith(enabled)

      expect(outcomes.length).toBeGreaterThan(0)
      for (const outcome of outcomes) {
        expect(outcome.items.length).toBeGreaterThan(0)
        expect(outcome.items.map(item => item.outcome)).toContain(outcome.outcome)
      }
    }

    it('gives every action that is about the account one item, named by the catalogue', async () => {
      const { outcomes } = await reconcileWith([ActionKey.SignIn, ActionKey.Fishball, ActionKey.GrowthPool])

      for (const actionKey of [ActionKey.SignIn, ActionKey.Fishball, ActionKey.GrowthPool]) {
        const outcome = outcomeOf(outcomes, actionKey)
        expect(outcome.items).toHaveLength(1)
        expect(outcome.items[0]).toMatchObject({
          kind: 'account',
          label: labelOf(actionKey),
          outcome: outcome.outcome,
          detail: outcome.detail
        })
      }

      // The `code` is the one field an item may hold something else in, and exactly one
      // action uses that: see the alias case below. Everywhere else the two are the same
      // value, which is what makes the divergence worth a test of its own.
      expect(outcomeOf(outcomes, ActionKey.SignIn).items[0]?.code).toBe(outcomeOf(outcomes, ActionKey.SignIn).code)
      expect(outcomeOf(outcomes, ActionKey.Fishball).items[0]?.code).toBe(outcomeOf(outcomes, ActionKey.Fishball).code)

      // The check-in is the one whose detail is worth reading twice: it has to say
      // what the day awarded, not merely that something happened. Facts joined by 、
      // now, rather than a sentence: 「连签 7 天、本次经验 +10」.
      const signIn = outcomeOf(outcomes, ActionKey.SignIn)
      expect(signIn.items[0]?.detail).toContain('连签 7 天')
      expect(signIn.items[0]?.detail).toContain('本次经验 +10')
      expect(outcomeOf(outcomes, ActionKey.GrowthPool).items[0]?.detail).toContain('200 鱼丸')
    })

    it('gives the 鱼吧 walk one item per group, each with its own verdict', async () => {
      listFollowedGroupsMock.mockResolvedValue({
        ok: true,
        code: 200,
        data: [group('1', '主版块'), group('2', '安卓版块'), group('3', 'PC 版块')]
      })
      signGroupAndroidMock.mockImplementation(async (_token: string, groupId: string) => {
        // The same three answers the aggregate test uses: a fresh sign, `fastSign`
        // saying already with a 200, and the PC twin saying it with 1001.
        if (groupId === '2') return { ok: true, code: 200, data: { levelScore: 0, alreadySigned: true } }
        if (groupId === '3') return refused(YUBA_ALREADY_SIGNED, '今天已经签到过了')
        return { ok: true, code: 200, data: { levelScore: 3, alreadySigned: false } }
      })

      const outcome = outcomeOf((await reconcileWith([ActionKey.YubaSign])).outcomes, ActionKey.YubaSign)

      expect(outcome.items).toEqual([
        { kind: 'group', label: '主版块', outcome: 'done', detail: '等级分 +3', code: '200' },
        { kind: 'group', label: '安卓版块', outcome: 'already', detail: '已签', code: '200' },
        {
          kind: 'group',
          label: 'PC 版块',
          outcome: 'already',
          detail: '已签',
          code: String(YUBA_ALREADY_SIGNED)
        }
      ])
    })

    it('gives a refused group an item that says why', async () => {
      listFollowedGroupsMock.mockResolvedValue({ ok: true, code: 200, data: [group('1', '主版块'), group('2')] })
      signGroupAndroidMock.mockImplementation(async (_token: string, groupId: string) =>
        groupId === '2'
          ? refused(1002, '用户未登陆或token已过期')
          : { ok: true, code: 200, data: { levelScore: 3, alreadySigned: false } }
      )

      const outcome = outcomeOf((await reconcileWith([ActionKey.YubaSign])).outcomes, ActionKey.YubaSign)

      // The record says the run failed; the items say which group did it and why, so
      // "新签 1、失败 1" is not the last thing a person can learn from the database.
      expect(outcome).toMatchObject({ outcome: 'failed', failure: 'account_stop' })
      expect(outcome.items).toEqual([
        { kind: 'group', label: '主版块', outcome: 'done', detail: '等级分 +3', code: '200' },
        { kind: 'group', label: '鱼吧 2', outcome: 'failed', detail: '用户未登陆或token已过期', code: '1002' }
      ])
    })

    it('describes a group the service did not name instead of labelling it with its id', async () => {
      listFollowedGroupsMock.mockResolvedValue({ ok: true, code: 200, data: [{ group_id: '77', group_name: '' }] })

      const { outcomes, logs } = await reconcileWith([ActionKey.YubaSign])
      const outcome = outcomeOf(outcomes, ActionKey.YubaSign)

      // `label` is the one field the main UI renders, so an id may never be it.
      expect(outcome.items[0]?.label).toBe('未命名版块')
      // The console line keeps the id, which is what a person debugging the walk wants.
      expect(logs[0]).toContain('77')
      expect(logs[0]).not.toContain('未命名版块')
    })

    it('agrees with the aggregate when a run does nothing but succeed', async () => {
      await expectItemsToAgree()
      await expectItemsToAgree([ActionKey.SignIn, ActionKey.Fishball, ActionKey.ActivitySign])
    })

    it('agrees with the aggregate when the session is dead', async () => {
      sendClientSignMock.mockResolvedValue(refused(1002, '用户未登录'))
      readFishBallBalanceMock.mockResolvedValue(refused(1002, '用户未登录'))
      listFollowedGroupsMock.mockResolvedValue(refused(1002, '用户未登陆或token已过期'))
      signActivityMock.mockResolvedValue(refused(1002, '用户未登录'))

      await expectItemsToAgree()
    })

    it('agrees with the aggregate when every chore was already done', async () => {
      sendClientSignMock.mockResolvedValue({
        ok: true,
        code: CLIENT_SIGN_ALREADY_SIGNED,
        data: { alreadySignedToday: true, status: null }
      })
      claimFishBallMock.mockResolvedValue(refused(FISH_BALL_ALREADY_CLAIMED, '当天已经领过鱼丸'))
      listFollowedGroupsMock.mockResolvedValue({ ok: true, code: 200, data: [group('1'), group('2')] })
      signGroupAndroidMock.mockResolvedValue({ ok: true, code: 200, data: { levelScore: 0, alreadySigned: true } })
      signActivityMock.mockResolvedValue({ ok: true, code: ACTIVITY_ALREADY_SIGNED, data: { alreadySigned: true } })

      await expectItemsToAgree()
    })

    it('agrees with the aggregate when the 鱼吧 walk half fails', async () => {
      listFollowedGroupsMock.mockResolvedValue({
        ok: true,
        code: 200,
        data: [group('1', '主版块'), group('2', '安卓版块'), group('3', 'PC 版块')]
      })
      signGroupAndroidMock.mockImplementation(async (_token: string, groupId: string) => {
        if (groupId === '3') return refused(0, '服务端异常')
        if (groupId === '2') return { ok: true, code: 200, data: { levelScore: 0, alreadySigned: true } }
        return { ok: true, code: 200, data: { levelScore: 3, alreadySigned: false } }
      })

      await expectItemsToAgree()
    })

    it('agrees with the aggregate when the walk never reached a group', async () => {
      // Nothing followed, and a first page that cannot be read: the item is the
      // action itself, because a group the run never touched has no name to show.
      listFollowedGroupsMock.mockResolvedValue({ ok: true, code: 200, data: [] })
      await expectItemsToAgree([ActionKey.YubaSign])

      listFollowedGroupsMock.mockResolvedValue(refused(1002, '用户未登陆或token已过期'))
      await expectItemsToAgree([ActionKey.YubaSign])
    })

    it('agrees with the aggregate when there is no credential at all', async () => {
      const outcomes = await douyuPlatform.reconcile({
        account: account('{}'),
        targetKey: '',
        enabledActions: RECONCILE_ACTIONS,
        options: {},
        now: 1791411776000,
        dayKey: '2026-10-08',
        log: () => undefined
      })

      for (const outcome of outcomes) {
        expect(outcome.items.length).toBeGreaterThan(0)
        expect(outcome.items.map(item => item.outcome)).toContain(outcome.outcome)
      }
    })

    it('reports a key it cannot name without an item, because a label must come from the catalogue', async () => {
      const outcome = outcomeOf((await reconcileWith([UNKNOWN_ACTION_KEY])).outcomes, UNKNOWN_ACTION_KEY)

      // The one outcome without items: there is no descriptor to label it from, and
      // the key itself is an identifier, which an item's label may never be.
      expect(outcome.items).toEqual([])
    })

    it('agrees with the aggregate when the 粉丝家园 walk runs with a web session', async () => {
      // The other invariant cases run on the blob this account actually has, which has no web
      // session: they see the blocked outcome and not the walk. This one gives the walk its
      // credential, so the per-room items are the thing being checked.
      const outcomes = await douyuPlatform.reconcile({
        account: account(webCredentials()),
        targetKey: '',
        enabledActions: RECONCILE_ACTIONS,
        options: {},
        now: 1791411776000,
        dayKey: '2026-10-08',
        log: () => undefined
      })

      for (const outcome of outcomes) {
        expect(outcome.items.length).toBeGreaterThan(0)
        expect(outcome.items.map(item => item.outcome)).toContain(outcome.outcome)
      }
    })
  })

  it('reports a key this platform does not know instead of throwing the run away', async () => {
    const { outcomes } = await reconcileWith([UNKNOWN_ACTION_KEY])

    expect(outcomeOf(outcomes, UNKNOWN_ACTION_KEY)).toMatchObject({
      outcome: 'blocked',
      code: 'unknown_action',
      failure: 'none'
    })
  })

  it('treats a missing credential as an account-level stop for the keys that need one', async () => {
    const outcomes = await douyuPlatform.reconcile({
      account: account('{}'),
      targetKey: '',
      enabledActions: [ActionKey.SignIn, ActionKey.Fishball, ActionKey.YubaSign, ActionKey.ActivitySign],
      options: {},
      now: 1791411776000,
      dayKey: '2026-10-08',
      log: () => undefined
    })

    expect(outcomes.map(outcome => outcome.failure)).toEqual([
      'account_stop',
      'account_stop',
      'account_stop',
      'account_stop'
    ])
    expect(sendClientSignMock).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ *
 * The transport, graded per action
 * ------------------------------------------------------------------ */

/**
 * The seam rule these cases are about, in `types.ts`'s words: a transport failure is graded
 * **per action** and never thrown past `reconcile`. A throw out of that member discards the whole
 * run's outcomes — including the action that had already finished — and leaves no row behind for
 * a person to read, which is what the runner's single `sweep error` line was the last visible
 * trace of.
 *
 * `protocol.ts` is where those throws are raised, so these cases reject the mocked calls the way
 * it does: a `DouyuTransportError` for a network fault, the deadline or a non-2xx, and a
 * `DouyuProtocolError` for a response that arrived and could not be read. Both classes are the
 * real ones — only the calls that raise them are mocked — so the grading below is the grading
 * that will run.
 */
describe('a call that never reaches Douyu', () => {
  /**
   * A transport failure as `protocol.ts` raises one: this URL carries the token, and the constructor
   * removes it from both the URL and the message it was handed.
   */
  function unreachable(url: string, status = 0, message = 'fetch failed'): DouyuTransportError {
    return new DouyuTransportError(`${url}?token=${TOKEN}`, status, message)
  }

  it('keeps the run when one action’s read never arrives, and loses only that action', async () => {
    readFishBallBalanceMock.mockRejectedValue(unreachable(FISH_BALL_BALANCE_URL, 0, 'The operation was aborted'))

    const { outcomes } = await reconcileWith([ActionKey.Fishball, ActionKey.SignIn])

    // This is the case the whole rule exists for. Before it, this throw left `reconcile`, the
    // runner logged one `task N sweep error` line, and **both** results were lost — the failure
    // and the check-in that had already finished its work.
    expect(outcomes.map(outcome => outcome.actionKey)).toEqual([ActionKey.Fishball, ActionKey.SignIn])

    const fishball = outcomeOf(outcomes, ActionKey.Fishball)
    expect(fishball).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
    expect(fishball.detail).toContain('读取鱼丸余额失败')
    // A failure that carries no Douyu verdict is never folded into one: the claim is not
    // attempted at all, because the balance it is gated on was never read.
    expect(claimFishBallMock).not.toHaveBeenCalled()

    const signIn = outcomeOf(outcomes, ActionKey.SignIn)
    expect(signIn).toMatchObject({ outcome: 'done', failure: 'none' })
    expect(signIn.detail).toContain('连签 7 天')
  })

  it('grades a response that arrived but could not be read as protocol, not as transport', async () => {
    readActivitySignStatusMock.mockRejectedValue(
      new DouyuProtocolError(`${ACTIVITY_SIGN_STATUS_URL}?token=${TOKEN}`, 'response was not JSON: Unexpected token <')
    )

    const outcome = outcomeOf((await reconcileWith([ActionKey.ActivitySign])).outcomes, ActionKey.ActivitySign)

    // `retry` like any other unreached call — an HTML error page from a proxy is usually
    // transient — but named apart from a network fault, because a shape this build cannot read
    // reproduces on every sweep until someone looks at it, and those are different things to do.
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'protocol', failure: 'retry' })
    expect(outcome.detail).toContain('读取任务中心签到状态失败')
    expect(signActivityMock).not.toHaveBeenCalled()
  })

  it('carries the status of a call that answered with one', async () => {
    readFishBallBalanceMock.mockRejectedValue(unreachable(FISH_BALL_BALANCE_URL, 503, 'HTTP 503'))

    const outcome = outcomeOf((await reconcileWith([ActionKey.Fishball])).outcomes, ActionKey.Fishball)

    // The status is structured data in its own right — 5xx is upstream, 4xx is the endpoint —
    // so it is reported rather than flattened into a bare `transport`.
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'http_503', failure: 'retry' })
    expect(outcome.detail).toContain('HTTP 503')
  })

  it('strips the credential out of the sentence, because this one is rendered and stored', async () => {
    readFishBallBalanceMock.mockRejectedValue(
      new DouyuProtocolError(
        `${FISH_BALL_BALANCE_URL}?token=${TOKEN}`,
        `response was not JSON: <html>see /login?token=${TOKEN} for details</html>`
      )
    )

    const outcome = outcomeOf((await reconcileWith([ActionKey.Fishball])).outcomes, ActionKey.Fishball)

    // The one thing a failure message may never contain: the composite token is the whole
    // account credential, and this string is written to a row and rendered.
    expect(outcome.detail).not.toContain(TOKEN)
    expect(outcome.detail).toContain('<redacted>')
  })

  it('redacts the message — not just the URL — and by the union rule, not the Douyu-local list', async () => {
    // Two things at once, because one call site shows both. The message half is the defect the
    // class's own note records being missed: a transport message is whatever the transport said, and
    // `response was not JSON` quotes a body that can echo the URL back. The name set is no longer the
    // Douyu-local `dy_token|jwt_token|token`: it is the union across Platforms in `text/redact.ts`,
    // and `ticket` is one of the names only that union carries — pinned here so a reader who finds the
    // old narrower list in a backup or a review note cannot restore it without a red test.
    readFishBallBalanceMock.mockRejectedValue(
      new DouyuTransportError(
        `${FISH_BALL_BALANCE_URL}?token=${TOKEN}`,
        502,
        'HTTP 502: bad gateway for /api/x?ticket=one-time-ticket&dy_token=abc'
      )
    )

    const outcome = outcomeOf((await reconcileWith([ActionKey.Fishball])).outcomes, ActionKey.Fishball)

    expect(outcome.detail).not.toContain('one-time-ticket')
    expect(outcome.detail).toContain('ticket=<redacted>')
    expect(outcome.detail).not.toContain(TOKEN)
  })

  it('never writes on a latch it could not read, because that write is the one that spends 200 鱼丸', async () => {
    readGrowthPoolStatusMock.mockRejectedValue(unreachable(GROWTH_POOL_STATUS_URL, 0, 'fetch failed'))

    const outcome = outcomeOf((await reconcileWith([ActionKey.GrowthPool])).outcomes, ActionKey.GrowthPool)

    // The safety property of this whole change. 报名 is reachable *only* through a parsed
    // `signStatus`, so a read that never arrived ends the run at the branch above the state
    // machine instead of falling through to a write. Sending 报名 because a read failed would
    // spend 200 鱼丸 on a guess about a latch nobody read.
    expect(joinGrowthPoolMock).not.toHaveBeenCalled()
    expect(clockGrowthPoolMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
    expect(outcome.detail).toContain('读取打卡分鱼丸状态失败')
    // And the read was a genuine attempt: the CSRF pair was minted before it.
    expect(fetchCsrfCookieMock).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when the CSRF pair itself never arrives', async () => {
    fetchCsrfCookieMock.mockRejectedValue(unreachable(CSRF_COOKIE_URL, 0, 'fetch failed'))

    const outcome = outcomeOf((await reconcileWith([ActionKey.GrowthPool])).outcomes, ActionKey.GrowthPool)

    expect(readGrowthPoolStatusMock).not.toHaveBeenCalled()
    expect(joinGrowthPoolMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
    expect(outcome.detail).toContain('获取打卡凭据失败')
  })

  it('reports a write that never arrived as its own retry, claiming no more than that', async () => {
    readGrowthPoolStatusMock.mockResolvedValue({ ok: true, code: 0, data: { signStatus: 1 } })
    clockGrowthPoolMock.mockRejectedValue(unreachable(GROWTH_POOL_CLOCK_URL, 0, 'fetch failed'))

    const outcome = outcomeOf(
      (await reconcileWith([ActionKey.GrowthPool], INSIDE_CLOCK_WINDOW)).outcomes,
      ActionKey.GrowthPool
    )

    // The request may have landed — a timeout says nothing about the service — so the record
    // claims only what is known: this call did not come back. The next sweep reads the latch
    // again rather than remembering this attempt, which is what makes retrying it safe.
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
    expect(outcome.detail).toContain('打卡失败')
  })

  it('ends the 鱼吧 walk on a call that never arrived, naming the group it happened on', async () => {
    listFollowedGroupsMock.mockResolvedValue({
      ok: true,
      code: 200,
      data: [group('1', '主版块'), group('2', '安卓版块')]
    })
    signGroupAndroidMock.mockRejectedValue(unreachable(YUBA_FAST_SIGN_URL, 0, 'fetch failed'))

    const { outcomes, logs } = await reconcileWith([ActionKey.YubaSign])
    const outcome = outcomeOf(outcomes, ActionKey.YubaSign)

    // The group is reported with the transport code — the walk does not invent a verdict for a
    // call that produced none — and the groups it never reached stay uncounted rather than being
    // attempted against a transport that has just failed once.
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'transport', failure: 'retry' })
    expect(outcome.items).toEqual([
      {
        kind: 'group',
        label: '主版块',
        outcome: 'failed',
        detail: expect.stringContaining('鱼吧签到失败'),
        code: 'transport'
      }
    ])
    expect(signGroupAndroidMock).toHaveBeenCalledTimes(1)
    expect(logs[0]).toContain('主版块')
    expect(logs[0]).toContain('transport')
  })
})

/* ------------------------------------------------------------------ *
 * refresh
 * ------------------------------------------------------------------ */

/**
 * `refresh` is optional on the seam, so it is unwrapped once here: every case below
 * is about what Douyu answers, not about whether the member exists.
 */
const refresh = douyuPlatform.refresh
if (refresh === undefined) throw new Error('the Douyu platform must declare refresh')

/**
 * The renewal's own exchange, at the size these cases need, and the two clocks that matter.
 *
 * `SEVEN_DAYS_MS` is `604800` seconds — the distance the old reader took from the PC route's
 * `expire_in` — and it is here as the thing that has to change nothing. `FAMILY_MAX_AGE_MS` is the
 * token family's own measured life, which is what a rebuild is *scheduled* by; the distance between
 * the two is the whole of this member's change.
 */
const LTP0_VALUE = 'ltp0-ciphertext-not-a-credential'
const LTP0 = `LTP0=${LTP0_VALUE}`
const DAY_MS = 86_400_000
const SEVEN_DAYS_MS = 604_800_000
/** A day past the window the old reader used: the report's day-eight case, written once. */
const EIGHT_DAYS_MS = SEVEN_DAYS_MS + DAY_MS
/** `Max-Age=529200` on every component of the token, which is 6.125 days and not seven. */
const FAMILY_MAX_AGE_MS = 529_200_000

/** The landing link the first hop's `Location` names: a 32-character one-time `code`, as measured. */
const RENEWAL_CODE = 'e0f3a1b2c3d4e5f60718293a4b5c6d7e'
const RENEWAL_LANDING = `https://www.douyu.com/api/passport/login?callback=__jp0&client_id=&code=${RENEWAL_CODE}&isAutoReg=&loginType=safeAuth&nickname=&uid=${CREDENTIAL_ARGS.uid}`

/** The family a rebuild mints: the token's own order, and none of the values the blob held. */
const REBUILT_FAMILY: Readonly<Record<string, string>> = {
  acf_uid: CREDENTIAL_ARGS.uid,
  acf_biz: '7',
  acf_stk: 'ffeeddccbbaa9988',
  acf_ct: '8',
  acf_ltkid: '69117400'
}

/** The composite token those five components make, written out rather than joined from the module. */
const REBUILT_TOKEN = `${REBUILT_FAMILY['acf_uid']}_${REBUILT_FAMILY['acf_biz']}_${REBUILT_FAMILY['acf_stk']}_${REBUILT_FAMILY['acf_ct']}_${REBUILT_FAMILY['acf_ltkid']}`

/** That family as the headers that land it. */
function rebuiltFamilyHeaders(): string[] {
  return Object.entries(REBUILT_FAMILY).map(([name, value]) => `${name}=${value}; Max-Age=529200; Path=/`)
}

/**
 * The two hops, as the service answers them: a `302` to the landing link, then the family.
 *
 * `landing` is the knob the failure case needs — an empty list is the second hop having set nothing.
 * A URL that is neither hop throws, so a case that starts making a third request fails loudly rather
 * than quietly taking some other answer for the exchange's own.
 */
function renewalRoute(options: { readonly landing?: readonly string[] } = {}): (url: string) => Response {
  return (url: string): Response => {
    if (url.startsWith('https://passport.douyu.com/wgapi/member/passport/safeAuth')) {
      return new Response(null, { status: 302, headers: { location: RENEWAL_LANDING } })
    }
    if (url.startsWith('https://www.douyu.com/api/passport/login')) {
      const headers: [string, string][] = [['content-type', 'application/json']]
      for (const cookie of options.landing ?? rebuiltFamilyHeaders()) headers.push(['set-cookie', cookie])
      return new Response(JSON.stringify({ error: 0, msg: 'ok', data: [] }), { status: 200, headers })
    }
    throw new Error(`a refresh case made a request that is not one of the two hops: ${url}`)
  }
}

/** A stored blob, with the two things this member reads out of it. */
function storedBlob(
  options: {
    readonly webCookies?: string
    readonly expiresAt?: number | null
    readonly tokenExpiresAt?: number | null
  } = {}
): string {
  const blob: Record<string, string | number> = {
    token: TOKEN,
    did: DID,
    webCookies: options.webCookies ?? `dy_did=${DID}; acf_did=${DID}; ${LTP0}`
  }
  if (options.expiresAt != null) blob['expiresAt'] = options.expiresAt
  if (options.tokenExpiresAt != null) blob['tokenExpiresAt'] = options.tokenExpiresAt
  return JSON.stringify(blob)
}

/** The blob a refresh handed back, read through the adapter's own parser. */
function renewedCredentialOf(result: RefreshResult) {
  const parsed = parseCredential(result.credentials ?? '')
  if (parsed === null) throw new Error('a refreshed result has to carry a credential the adapter can read')
  return parsed
}

describe('refresh', () => {
  it('asks for nothing while the family’s own clock says it is fresh', async () => {
    const result = await refresh(account(storedBlob({ tokenExpiresAt: Date.now() + 6 * DAY_MS })))

    expect(result).toMatchObject({ status: 'not_required', detail: expect.stringContaining('尚未接近到期') })
    expect(result.credentials).toBeUndefined()
    // The whole reason the family's stamp is stored: a check inside a fresh family costs nothing, so
    // the exchange happens about once every five days instead of on every six-hourly sweep.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rebuilds the family inside the window, and hands the result back to be persisted', async () => {
    fetchMock.mockImplementation(async (url: string) => renewalRoute()(url))
    const before = Date.now()
    const session = before + 100 * DAY_MS

    const result = await refresh(account(storedBlob({ tokenExpiresAt: before + DAY_MS / 2, expiresAt: session })))

    expect(result).toMatchObject({ status: 'refreshed', detail: expect.stringContaining('acf_* 家族已重建') })
    const parsed = renewedCredentialOf(result)
    // The token is the new family's, in the token's own order — an old token beside a new family
    // would name credentials the actions no longer hold.
    expect(parsed.token).toBe(REBUILT_TOKEN)
    expect(parsed.token).not.toBe(TOKEN)
    // The session key and its stamp survive untouched, and the family's new clock is the declared
    // life measured from the moment the response arrived — a window rather than an equality,
    // because the clock that turns `Max-Age` into an instant is the jar's, not this test's.
    expect(parsed.webCookies).toContain(LTP0)
    expect(parsed.expiresAt).toBe(session)
    expect(parsed.tokenExpiresAt).toBeGreaterThanOrEqual(before + FAMILY_MAX_AGE_MS)
    expect(parsed.tokenExpiresAt).toBeLessThan(before + FAMILY_MAX_AGE_MS + 60_000)
  })

  it('rebuilds a credential whose family clock was never recorded, and then leaves it alone', async () => {
    fetchMock.mockImplementation(async (url: string) => renewalRoute()(url))

    // Every credential written before that stamp existed, and every pasted one — a `Cookie:` header
    // states no attributes, so neither of them can carry a family clock.
    const first = await refresh(account(storedBlob()))
    expect(first).toMatchObject({
      status: 'refreshed',
      detail: expect.stringContaining('没有记录 acf_* 家族的到期时刻')
    })

    // The rebuild is what writes the clock, so the very next check — with the credential the caller
    // has just stored — asks for nothing. Renewing blind would exchange on every check forever, and
    // never renewing would leave the credential to lapse at six days: only a stamp ends both.
    const second = await refresh(account(first.credentials ?? ''))
    expect(second).toMatchObject({ status: 'not_required' })
    expect(second.credentials).toBeUndefined()
    // Two requests in all: the two hops of the first refresh, and none at all for the second.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('leaves a credential alone — and stays silent — while its family is nowhere near lapsing', async () => {
    // The false alarm this ordering exists to prevent: a credential with **no web session** and a
    // family that is not close to lapsing has nothing to do yet. Reporting a re-bind here would be an
    // alarm about a credential with nothing wrong with it, and an alarm that cannot be justified
    // teaches whoever reads the feed to ignore the one that can.
    for (const webCookies of ['', `dy_did=${DID}`, `dy_did=${DID}; LTP0=`]) {
      const blob = storedBlob({ webCookies, tokenExpiresAt: Date.now() + 6 * DAY_MS })

      const result = await refresh(account(blob))

      expect(result, webCookies).toMatchObject({
        status: 'not_required',
        detail: expect.stringContaining('尚未接近到期')
      })
      expect(result.credentials, webCookies).toBeUndefined()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says nothing for a credential with neither a session nor a family clock', async () => {
    // The other half of the same rule, and the shape every paste has: no key *and* no clock. Nothing
    // can be rebuilt and nothing can be said about when it lapses, so this member raises nothing —
    // "it is about to expire" is not a claim anyone can make about a credential nobody dated. What
    // the token is worth is answered where it is used.
    const result = await refresh(account(storedBlob({ webCookies: '', tokenExpiresAt: null })))

    expect(result).toMatchObject({
      status: 'not_required',
      detail: expect.stringContaining('也说不出它是否快到期')
    })
    expect(result.credentials).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks a person for a re-scan only when a renewal is due and there is no key for it', async () => {
    // The intersection that justifies the answer, and both halves of it are required: the family's own
    // clock says a renewal is needed — inside the window, or already past it — *and* nothing here can
    // present a key. The case above has the second half without the first, and is answered silently.
    for (const tokenExpiresAt of [Date.now() + DAY_MS / 2, Date.now() - EIGHT_DAYS_MS]) {
      const blob = storedBlob({ webCookies: `dy_did=${DID}`, tokenExpiresAt })

      const result = await refresh(account(blob))

      expect(result, String(tokenExpiresAt)).toMatchObject({ status: 'relogin_required' })
      expect(result.detail, String(tokenExpiresAt)).toContain('需要重新扫码绑定')
      expect(result.credentials, String(tokenExpiresAt)).toBeUndefined()
    }
    // Both refused before the exchange: with nothing to present, nothing is presented.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers relogin_required for a blob it cannot read, rather than calling that a refresh', async () => {
    for (const blob of ['{}', 'not a credential', '']) {
      const result = await refresh(account(blob))

      // Not an exception to the rule above but the one input with no clock *and* nothing usable at
      // all: there is no uncertainty here about whether a person is needed, so no unknown is being
      // dressed up as urgency. The seam names this input itself (`types.ts`: "a blob that does not
      // parse"), Bilibili's member answers the same way, and every action on it already fails with
      // `no_credential`.
      expect(result, blob).toMatchObject({ status: 'relogin_required' })
      expect(result.credentials, blob).toBeUndefined()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hands nothing back when the renewal fails, so the row keeps the credential it had', async () => {
    const blob = storedBlob({ tokenExpiresAt: Date.now() + DAY_MS / 2, expiresAt: Date.now() + 100 * DAY_MS })

    // A second hop that landed no family…
    fetchMock.mockImplementation(async (url: string) => renewalRoute({ landing: [] })(url))
    const noFamily = await refresh(account(blob))
    expect(noFamily).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('没有下发完整的 acf_* 家族')
    })

    // …and a first hop that refused instead of redirecting, which is the measured shape of a
    // credential the exchange will not accept at all.
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: 16, msg: '未登录,请重新登录', data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    const refused = await refresh(account(blob))
    expect(refused).toMatchObject({ status: 'failed', detail: expect.stringContaining('未登录,请重新登录') })

    // **Nothing is offered back**, and that is what keeps the stored credential: the caller persists
    // only a `refreshed` result carrying one (`scheduler/runner.ts`), so a spent attempt is a spent
    // attempt and not a credential lost. The row still holds what it held, and the next check
    // retries with the same family — still inside its window, still good.
    for (const result of [noFamily, refused]) {
      expect(result.credentials).toBeUndefined()
      expect(result.status).not.toBe('relogin_required')
    }
    expect(await refresh(account(blob))).toMatchObject({ status: 'failed' })
  })

  it('does not judge a credential dead by a date, however far past the session stamp is', async () => {
    // The two stamps the old arithmetic would have killed on — 1970, and more than the seven days
    // the PC route's `expire_in` named — against a family whose own clock is fresh. The session's
    // stamp is recorded and read for nothing, so neither of them moves this answer.
    for (const expiresAt of [1, Date.now() - EIGHT_DAYS_MS]) {
      const result = await refresh(account(storedBlob({ expiresAt, tokenExpiresAt: Date.now() + 6 * DAY_MS })))

      expect(result, String(expiresAt)).toMatchObject({ status: 'not_required' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rebuilds a family whose own stamp has passed, instead of declaring it dead', async () => {
    fetchMock.mockImplementation(async (url: string) => renewalRoute()(url))

    // A stamp is a schedule, never a verdict: the stalest thing this member can be handed is a
    // family eight days past its clock, and the answer is a rebuild — not `relogin_required`, which
    // would send a person to scan for a credential that renews itself, and not a refusal to act.
    const result = await refresh(account(storedBlob({ tokenExpiresAt: Date.now() - EIGHT_DAYS_MS })))

    expect(result.status).toBe('refreshed')
    expect(result.credentials).toBeDefined()
  })

  it('names no seven-day window in any answer, because no measurement supports one', async () => {
    let respond: (url: string) => Response = renewalRoute()
    fetchMock.mockImplementation(async (url: string) => respond(url))

    const answers: string[] = []
    answers.push((await refresh(account(storedBlob({ tokenExpiresAt: Date.now() + 6 * DAY_MS })))).detail)
    answers.push((await refresh(account(storedBlob({ tokenExpiresAt: Date.now() + DAY_MS / 2 })))).detail)
    answers.push((await refresh(account(storedBlob({ webCookies: '' })))).detail)
    answers.push((await refresh(account('not a credential'))).detail)
    respond = () => renewalRoute({ landing: [] })('https://www.douyu.com/api/passport/login')
    answers.push((await refresh(account(storedBlob({ tokenExpiresAt: Date.now() + DAY_MS / 2 })))).detail)

    expect(answers).toHaveLength(5)
    for (const detail of answers) {
      expect(detail).not.toContain('7 天')
      expect(detail).not.toContain('七天')
      expect(detail).not.toContain('604800')
    }
  })

  it('never says a credential value, a code or a Location in any answer', async () => {
    let respond: (url: string) => Response = renewalRoute()
    fetchMock.mockImplementation(async (url: string) => respond(url))

    const answers: string[] = []
    answers.push((await refresh(account(storedBlob({ tokenExpiresAt: Date.now() + 6 * DAY_MS })))).detail)
    answers.push((await refresh(account(storedBlob({ tokenExpiresAt: Date.now() + DAY_MS / 2 })))).detail)
    answers.push((await refresh(account(storedBlob({ webCookies: '' })))).detail)
    answers.push((await refresh(account('not a credential'))).detail)
    respond = () =>
      new Response(JSON.stringify({ error: 16, msg: '未登录,请重新登录', data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    answers.push((await refresh(account(storedBlob({ tokenExpiresAt: Date.now() + DAY_MS / 2 })))).detail)

    for (const detail of answers) {
      for (const secret of [TOKEN, REBUILT_TOKEN, LTP0_VALUE, DID, RENEWAL_CODE, 'api/passport/login']) {
        expect(detail, secret).not.toContain(secret)
      }
    }
  })
})
