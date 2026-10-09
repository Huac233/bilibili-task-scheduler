import { setTimeout as sleep } from 'node:timers/promises'

import { fetchNav } from '../../bilibili/auth.js'
import { BiliHttp, BiliHttpError, DEFAULT_TIMEOUT_MS } from '../../bilibili/http.js'
import { type LikeGate, LikeRefusal, likeGate, likeWithFallback } from '../../bilibili/like.js'
import {
  fetchAnchorName,
  fetchRoomInfo,
  isLive,
  RoomRefusedError,
  resolveRoom,
  sendDanmaku,
  WbiKeyStore
} from '../../bilibili/live.js'
import {
  fetchMedalPanel,
  fetchMedalTasks,
  fetchRoomLikeInfo,
  findMedalTask,
  isTaskDone,
  MedalJumpType,
  type MedalTask
} from '../../bilibili/medal.js'
import { refreshIfRequired } from '../../bilibili/refresh.js'
import { LikeCode, type RoomInfo, type RoomInit, RoomInitCode, SendDanmakuCode } from '../../bilibili/types.js'
import { enterLiveRoom, sendLiveHeartbeat, type WatchSession } from '../../bilibili/watch-live.js'
import { ActionKey, TaskAction } from '../../repo/tasks.js'
// One home for "is a credential in this string", imported rather than copied. Five copies used to
// answer it — this file's `withoutSecret`, `withoutSecrets` in `douyu/index.ts` and `douyu/passport.ts`,
// `redact` in `bilibili/medal.ts`, and the parameter-name pattern in `douyu/errors.ts` — and they
// drifted: one scrubbed an error's URL while the sentence built from the same exchange went out
// carrying the token, which is the defect `douyu/errors.ts` records. This deliberately **reverses** the
// judgement in `review-units/工艺-平台适配.md` §15.5, which read the copies as the idiom duplication
// `AGENTS.md:72-75` allows and told later readers not to merge them; that read assumed they would not
// drift, and they did.
import { redactSecrets } from '../../text/redact.js'
import { roomIdOf } from '../room.js'
import { TargetRefusal, TargetRefusalKind } from '../target.js'
import {
  type ActionDescriptor,
  type ActionItem,
  type ActionOutcome,
  type ActionOutcomeValue,
  type FailureKind,
  LIVE_STATUS_LIVE,
  LIVE_STATUS_OFFLINE,
  type Platform,
  type PlatformAccount,
  type ProbeResult,
  type ReconcileContext,
  type RefreshResult,
  type SendOutcome,
  type TargetInfo
} from '../types.js'
import { clientFor, cookiesEqual, parseCredential, serializeCredential, sessionClientFor } from './session.js'

/**
 * Bilibili, behind the Platform seam.
 *
 * Everything endpoint-shaped already lives in `server/src/bilibili/` — the cookie
 * jar, the WBI signature, the credential extraction — and this adapter calls it
 * rather than reimplementing it. What sits *here* is only what the seam needs and
 * nothing else previously knew:
 *
 *  - how a stored credential blob becomes a client,
 *  - when Bilibili's raw `live_status` of `2` means "not live" (`isLive` owns that
 *    decision, and this adapter normalises to 1/0 so the scheduler compares once),
 *  - and, the reason the seam exists at all, **which numeric code means stop the
 *    account, and which means try again**.
 *
 * The reconcile actions are the account's 粉丝牌 chores. Two of them are the 亲密度 chores and hang off
 * one anchor's 粉丝牌 — which is why they are per Room. The third, 点亮粉丝牌, is about the medal itself
 * rather than the anchor: it re-lights every dark medal the account holds, discovers its own rooms, and
 * is therefore the one **account-scoped** reconcile action on this Platform (empty `targetKey`, one row
 * for the whole account). Its wire code is not here either: the medal panel and the room's like switches
 * are `bilibili/medal.ts`, the like request and its pre-flight gate are `bilibili/like.ts`, and the
 * viewing heartbeat is `bilibili/watch-live.ts`. What this file adds is the piece none of them owns:
 * **the loop over one day's outstanding work** — read the Platform, act, read it again, and report
 * what each action was about.
 */

/**
 * The action catalogue.
 *
 * Four entries, and the short list is still the honest one. `send_danmaku` is the novelty
 * action; the other three are `reconcile` actions because that is what they are — a daily,
 * idempotent read-then-write chore whose completion the Platform reports. Two of the three
 * are the 亲密度 chores and are **per Room**; 点亮粉丝牌 is about the medal itself, so it is
 * account-scoped and carries an empty target. Douyu's five check-ins sit on the same side of
 * that line.
 *
 * What is deliberately absent, and why — each would be a switch that can only fail or can
 * only spend:
 *
 *  - Bilibili's live 签到 is offline (the research note behind this refactor records `DoSign`
 *    answering 「签到活动已下线」), so a `sign_in` entry would put a switch in the UI that
 *    could only ever fail. `ActionKey.SignIn` exists for the Platforms that do have one.
 *  - The medal's other two chores are the paid ones: 投喂粉丝灯牌 (`feedLight`, 6 亲密度) and
 *    投喂礼物 (`sendGift`, 1 亲密度 per battery) each send a gift, so both would be
 *    `costly: true`. Neither is implemented — a capability list is a statement about what
 *    this build does, and a descriptor with no code behind it is still a switch that looks
 *    like it works.
 *  - The dark medal's **other** lighting route (发弹幕10条) is absent for a different reason,
 *    and it is the one omission worth explaining at length because the data says it works:
 *    ten danmaku into the room, publicly. See `reconcileRelightMedal` for why this build
 *    declines it and what it says instead of doing it.
 */
const ACTIONS: readonly ActionDescriptor[] = [
  {
    key: ActionKey.SendDanmaku,
    action: TaskAction.Send,
    label: '发送弹幕',
    /**
     * The reward is in this sentence for a reason worth writing down: **a Send action reports
     * no items** — `SendOutcome` has no such field — and its `detail` is only ever read on a
     * failure, because `runner.ts` writes it as the send log's `error` and passes `''` on a
     * success. So the description is the one surface where a person can learn what sending is
     * worth, and it is the panel's own fact (`add_text` = 亲密度+1, one round a day) restated
     * where a person reads it before switching the action on. Its behaviour is untouched.
     */
    description:
      '按固定间隔把文本库里的弹幕一条条发进直播间，发完一轮后从头循环；发弹幕这条链同时算粉丝牌任务，每天一次、为这个牌子加 1 点亲密度。',
    /** Sending is free; only Bilibili's rate limits notice it. */
    costly: false,
    needsTarget: true,
    needsLibrary: true,
    /**
     * Bilibili refuses danmaku longer than 20 characters for an ordinary account;
     * a 大航海 gets 30. Declaring the lower cap is the safe direction: a bullet that
     * is too long for the account tier is rejected outright (`10030`), while a
     * short one only costs the salt step room it can spare.
     */
    maxMessageLength: 20,
    /** Matches the create-task form's existing default. */
    defaultIntervalSeconds: 30,
    /**
     * Bilibili answers `10031` for danmaku that arrive too fast, and the scheduler
     * can only retry that — so refuse to schedule a cadence the server will not
     * honour rather than letting a task retry in a tight loop.
     */
    minIntervalSeconds: 10
  },
  {
    key: ActionKey.LikeDanmaku,
    action: TaskAction.Reconcile,
    label: '点赞',
    description: '给这个直播间点赞，为粉丝牌加亲密度；每天能点几轮由服务端按牌子下发、动手前先读，不用花任何东西。',
    /** A like spends nothing; the only thing it uses up is the day's own quota. */
    costly: false,
    /**
     * Per Room, and this is the descriptor's most consequential field: a like's cap, its
     * cooldown and its task all hang off one anchor's 粉丝牌, so the runner keeps one
     * reconcile task per (Platform, target) and five medals are five separate chore lists.
     */
    needsTarget: true,
    needsLibrary: false,
    maxMessageLength: 0,
    /**
     * The daily chores are idempotent and read first — an already-done action is a cheap read
     * that says so — so a tighter cadence buys nothing and only adds requests against a
     * Platform that rate-limits. Same reasoning as every Douyu check-in.
     */
    defaultIntervalSeconds: 300,
    /** The same floor the other daily chores use; the like's own pacing is the room's `cooldown`. */
    minIntervalSeconds: 60
  },
  {
    key: ActionKey.WatchLive,
    action: TaskAction.Reconcile,
    label: '观看直播',
    description:
      '保持一段观看会话，让这个直播间的「观看满15分钟」粉丝牌任务攒够时长；够没够只由服务端回读决定，不是本地计时。',
    /** Watching spends nothing. */
    costly: false,
    /** Per Room as well: the 观看 task is a row on one anchor's medal. */
    needsTarget: true,
    needsLibrary: false,
    maxMessageLength: 0,
    /**
     * The session itself paces on the server-issued heartbeat interval; this is only how
     * often a run may start one, and a fresh session is cheap.
     */
    defaultIntervalSeconds: 300,
    minIntervalSeconds: 60
  },
  {
    key: ActionKey.RelightMedal,
    action: TaskAction.Reconcile,
    label: '点亮粉丝牌',
    /**
     * The description is the only surface a person reads before switching this on, so it
     * carries three facts a switch here has to state: it finds its own rooms (**no target to
     * pick**), the like is invisible, and lighting pays **no** 亲密度 — the panel's own
     * `add_text` is empty for both of a dark medal's rows, so 「点亮」 succeeding says nothing
     * about the nightly 亲密度 total. A fourth fact is the one worth the words: the other
     * lighting route (发弹幕10条) sends **public messages**, and this action does not take it.
     * See `reconcileRelightMedal` for why, and for what it says instead.
     */
    description:
      '把账号里熄灭了的粉丝牌重新点亮：自己把整份粉丝牌列表读一遍，凡是主播正在开播的就点一次赞，不用选直播间、点赞也不会被别人看见；点亮本身不产生亲密度。这条动作不会发弹幕 —— 另一条点亮路线要在那个直播间发 10 条公开可见的弹幕，本动作不自动走那条路。',
    /** A like spends nothing; the only thing it uses up is the day's own quota. */
    costly: false,
    /**
     * **Account-scoped, and this is the descriptor's most consequential field here.** The
     * dark medals are 24 across 24 rooms, and the owner does not want 24 tasks: this action
     * reads the account's whole medal list and finds the rooms itself. So the task carries no
     * target (the create route's create-or-get is keyed by `(Platform, target, action)`, which
     * gives exactly one such task per account — `findReconcileTask` with an empty key and this
     * action's own key).
     */
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    /**
     * The same cadence the other two reconcile actions use, and for a reason specific to this
     * one: a run that finds nothing to light costs three page reads, and the thing it is
     * waiting for is an anchor going live — a window measured in hours, not minutes. The
     * `blocked` outcome is what keeps the sweep coming back, so a tighter cadence would only
     * multiply the reads.
     */
    defaultIntervalSeconds: 300,
    /** Same floor as its neighbours: a daily chore has nothing to gain from hurrying. */
    minIntervalSeconds: 60
  }
]

/**
 * Codes for failures Bilibili never numbers.
 *
 * Each one is a local state, not a response: the scheduler displays whatever is
 * here next to the failure, so it has to say something a person can act on.
 *
 * The reconcile entries are all states this build determined for itself. `missing_uid`, `no_buvid`
 * and `watch_area_missing` are all "a request cannot be formed at all" — the first because a like
 * carries the liker's own uid, the other two because the viewing handshake signs with a device
 * cookie the live domain has to hand out and echoes two area ids the room payload has to carry —
 * and failing closed with a name for the gap beats sending a request with a made-up value in it.
 * `like_unfinished` is the one that is not a gap: the server accepted the likes and did not count
 * them, which is a fact worth surfacing. `watch_in_progress` is the opposite kind of state: nothing
 * is wrong at all, the slice simply ended before the day's watching was credited, and its name is
 * what separates "still going" from "stuck" in the event feed.
 *
 * 点亮粉丝牌's four are the same idea for a different chore. `medal_room_offline` is the *normal*
 * state of that action — an anchor nobody is watching is exactly when the like cannot be sent —
 * and it is a `blocked`, not a skip, so the sweep comes back. `medal_already_lit` and
 * `medal_relight_unconfirmed` split the two ways a medal can end a run still lit or still dark,
 * and the second one exists because `code: 0` is not evidence: the like was accepted and the
 * re-read disagreed. `not_account_scoped` is the odd one and is not about the Platform at all:
 * it says this invocation is not the one that owns the work.
 */
const LocalCode = {
  BadTarget: 'bad_target',
  MissingUid: 'missing_uid',
  NoBuvid: 'no_buvid',
  NoCredential: 'no_credential',
  SessionUnknown: 'session_unknown',
  Transport: 'transport',
  LikeUnfinished: 'like_unfinished',
  WatchAreaMissing: 'watch_area_missing',
  WatchInProgress: 'watch_in_progress',
  WatchTaskDone: 'watch_task_done',
  WatchTaskMissing: 'watch_task_missing',
  MedalRoomOffline: 'medal_room_offline',
  MedalAlreadyLit: 'medal_already_lit',
  RelightUnconfirmed: 'medal_relight_unconfirmed',
  NoMedals: 'no_medals',
  NotAccountScoped: 'not_account_scoped',
  UnknownAction: 'unknown_action'
} as const

/**
 * One WBI key store for the whole process.
 *
 * The keys come from `/x/web-interface/nav` and are not account-specific — the same
 * pair signs every request — so a single cache is correct rather than merely
 * convenient, and the seam has nowhere to inject one anyway. `sendDanmaku`
 * invalidates it on a signature error, so a rotation recovers on the next attempt.
 */
const wbiKeys: WbiKeyStore = new WbiKeyStore()

/**
 * Turns pasted input into a target the rest of the system can act on.
 *
 * Throws when the input does not resolve, and **which throw it is says which of the three things went
 * wrong** (`platform/target.ts`): a shape this Platform does not read a room out of, a room that is not
 * there, or Bilibili not answering — all three of which used to arrive as one of the other two. The seam
 * gives this member no failure variant, and there is nothing here to retry: a form submission either names
 * a room or it does not.
 *
 * `account` is the account the person had picked when they pasted the link, and it changes exactly one
 * request: the Anchor-name read, which Bilibili refuses a cookie-less caller (the measurement is
 * `bilibili/credential.ts`'s `credentialToSessionCookies`). Everything else here answers anonymously and
 * keeps doing so.
 */
async function resolveTarget(input: string, account?: PlatformAccount): Promise<TargetInfo> {
  const paste = parseRoomPaste(input)
  // Two refusals, two sentences, and neither is the other: a person who pasted a shortcut is told the
  // shortcut is what this build does not read, and everyone else is told which shapes it does.
  if (paste.kind === 'short_link') {
    throw new TargetRefusal(TargetRefusalKind.UnreadableInput, SHORT_LINK_DETAIL)
  }
  if (paste.kind !== 'room') {
    throw new TargetRefusal(TargetRefusalKind.UnreadableInput, UNREADABLE_INPUT_DETAIL)
  }

  // A cookie-less client, and the deadline is stated rather than defaulted so that "an adapter call can
  // never hang" is visible here, and it is the transport's own name for that ceiling. Every read below
  // that answers anonymously goes out on this one — `room_init`, the 标题 fallback — because a request
  // carries what it needs and no more, and those two need nothing.
  const http = new BiliHttp({ timeoutMs: DEFAULT_TIMEOUT_MS })

  let room: RoomInit
  try {
    room = await resolveRoom(http, paste.id)
  } catch (error: unknown) {
    // **The one refusal this adapter can name** — Bilibili's own 直播间不存在 — and the reason the code
    // had to become a field on the error: a number that names no room is a fact about what the person
    // typed, and the sentence it produces names that number so they can check it.
    if (error instanceof RoomRefusedError) {
      throw error.code === RoomInitCode.RoomNotFound
        ? new TargetRefusal(TargetRefusalKind.MissingRoom, missingRoomDetail(paste.id))
        : new TargetRefusal(
            TargetRefusalKind.PlatformUnanswered,
            `B 站没有确认这个直播间（房间号 ${String(paste.id)}，平台返回 code ${String(error.code)}），请稍后再试一次。`
          )
    }
    // Everything else — the deadline, a 5xx, a payload that no longer parses — says nothing about the
    // number, so it keeps the transport answer the route gives it.
    throw error
  }

  // **The label, and the order this member reads it in.** `TargetInfo.title` is what a person reads
  // back: 「已解析：…」 beside the box they pasted into (`ActionSettingsPanel.vue`), and a task row's
  // `targetTitle`. Three sources, this order, and no fourth:
  //
  //   1. **The Anchor's name** (`fetchAnchorName`). A name is what that field is for, and neither of the
  //      two endpoints this member used to talk to carries one: `room_init` answers room id, uid and
  //      status, `get_info` answers uid, title and the areas.
  //   2. **The room's 标题** (`fetchRoomInfo`), when no name arrives. It is the broadcast's *subject
  //      line*, so it is the worse label — room 84074 answers 「铁人」 today and 「贴人」 in an earlier
  //      capture, while its Anchor is 「炫神_」. **That argument against it is real, and it loses to showing
  //      nothing**, which is what shipped: with the label empty, the page's own fallback answers
  //      「目标 14709735」, so a person sees *less* than the 标题 this field held before the name read
  //      existed — and cannot tell a name this build failed to read from a room that has none.
  //   3. **`''`**, only when both reads are unavailable. That is the state `ActionSettingsPanel.vue`'s
  //      echo renders as 「目标 <room id>」, and it stays reachable rather than being papered over.
  //
  // **Why step 1 fires only when an account is in hand.** `getInfoByRoom` refuses a cookie-less client
  // `code: -352` with no `data` at all, and it is the *session* cookies that lift that refusal — not the
  // device cookies, which were tried alone and refused (2026-10-09, room 14709735; the table is beside
  // `credentialToSessionCookies`). So the name read goes out on the account's session when there is one,
  // and on the anonymous client when there is not. It is still **made** in that second case rather than
  // skipped: a refusal is the Platform's answer and can change (the code is documented as temporary),
  // and a branch that pre-empted it would be this build asserting an endpoint's behaviour instead of
  // asking. What the caller is told in that case is `titleNote` below, not a quieter label.
  //
  // Cosmetic in the one sense that matters here — the room resolved, which is all the caller needs — so
  // neither failure may block creating the task. The order costs one extra request, and only on the path
  // where no name arrived: a name that arrives still short-circuits.
  const nameHttp = anchorNameClient(account, http)

  let name = ''
  try {
    name = await fetchAnchorName(nameHttp, room.room_id)
  } catch {
    // Ignored: a task this read could not name is still a task, and the 标题 below is what the label
    // falls back to.
  }

  let title = name
  if (title === '') {
    try {
      title = (await fetchRoomInfo(http, room.room_id)).title
    } catch {
      // Ignored: both reads unavailable, so the label stays `''` — the state the page already renders as
      // 「目标 <room id>」.
    }
  }

  // **Why the label is a 标题, when it is one — and this is the sentence the regression was missing.**
  // The label above is one field with three sources, so a reader cannot tell a name this build read from a
  // subject line it fell back to, and the owner asked for that to be said out loud rather than left to be
  // inferred (「如果没绑需要写明提示并回退」). Two causes, two sentences, because they send a person to two
  // different places: **no account travelled** is theirs to fix by picking one, while **an account travelled
  // and the name still did not arrive** is not — and printing the first sentence over the second case would
  // send them to fix the one thing that is already right. It is computed from which read answered rather
  // than from the text, so an empty `title` (both reads failed) keeps the cause it belongs to instead of
  // inventing one.
  let titleNote = ''
  if (name === '') titleNote = account === undefined ? NO_ACCOUNT_TITLE_NOTE : NAME_UNREAD_TITLE_NOTE

  return {
    // The real room id, not the number that was pasted: every write endpoint wants
    // the id `room_init` maps to.
    key: String(room.room_id),
    title,
    titleNote,
    anchorId: String(room.uid),
    // Empty, and for a different reason than this line used to give: this adapter *does* read the
    // Anchor's display name now, but it belongs in `title` — the field the echo and a task row draw —
    // and `anchorName` is the create form's second, smaller tag, which would then print one name
    // twice. (The comment it replaces said no room endpoint carries the name and that it would take a
    // separate profile call. The first half was true of the two endpoints this member talked to, and
    // false of the room page's own payload, which is where the name turned out to be.) `title` carries
    // the 标题 whenever that read does not answer, and that is a fallback for the same one field rather
    // than a second label — so it is no reason to fill this one either.
    anchorName: '',
    // The raw value, as `TargetInfo` documents. `probe` is where it is normalised.
    liveStatus: room.live_status
  }
}

/**
 * The client the Anchor-name read goes out on when the person had picked an account.
 *
 * Both halves of the fallback are stated rather than smuggled into a `??`: with no account it is the
 * caller's own anonymous client, and an account whose credential blob this build cannot read is the same
 * case — `parseCredential` answers `null` for that, which is a person's re-bind to make rather than a
 * request to fail, and this read is cosmetic either way.
 */
function anchorNameClient(account: PlatformAccount | undefined, anonymous: BiliHttp): BiliHttp {
  if (account === undefined) return anonymous
  const credential = parseCredential(account.credentials)
  return credential === null ? anonymous : sessionClientFor(credential)
}

/**
 * One liveness probe, and the failure grading the pre-seam code could not do.
 *
 * The session check comes first, and it is not optional. Bilibili's room endpoints
 * answer anonymously, so a room that resolves perfectly says nothing about whether
 * the account is still logged in — meaning a task whose stream is offline would
 * never notice a dead session until its first send. `/nav` is the call that answers
 * it, and it answers with two different facts: a non-zero envelope `code` means the
 * request was rejected (risk control, upstream fault), while `code: 0` with
 * `isLogin: false` means the session is gone. A message search cannot tell those
 * apart, which is what the old `detail.includes('-101')` was trying to do.
 *
 * One extra round trip per probe is the cost, and it buys noticing a dead account
 * within the poll interval instead of at the first send.
 */
async function probe(account: PlatformAccount, targetKey: string): Promise<ProbeResult> {
  const roomId = roomIdOf(targetKey.trim())
  if (roomId === null) {
    // A key that is not a room number cannot start working later; parking the
    // action beats retrying a typo forever.
    return probeFailure(LocalCode.BadTarget, '目标不是有效的直播间号', 'action_stop')
  }

  const credential = parseCredential(account.credentials)
  if (credential === null) {
    return probeFailure(LocalCode.NoCredential, '账号凭据缺失或无法解析，需要重新扫码绑定', 'account_stop')
  }

  const http = clientFor(credential)

  // The try wraps the request and nothing else. It used to enclose the four grading
  // branches below as well, which meant a mistake *in the grading* — a typo, a bad
  // property access — surfaced as `transportCodeOf(error)` and was reported as a
  // network blip graded `retry`. That is the worst possible disguise for a
  // programming error: the task retries it forever and the feed says the network is
  // flaky.
  let nav: Awaited<ReturnType<typeof fetchNav>>
  try {
    nav = await fetchNav(http)
  } catch (error: unknown) {
    return probeFailure(transportCodeOf(error), `会话检查失败：${errorText(error)}`, 'retry')
  }

  if (nav.code === SendDanmakuCode.NotLoggedIn) {
    // The endpoint's entire subject is the session, so `-101` here can only mean
    // there is no session. Bilibili answers some stale-cookie requests with this
    // instead of `code: 0, isLogin: false`, and both shapes mean the same thing —
    // grading only the second would leave a dead session retrying forever, which
    // is the failure this probe exists to end.
    return probeFailure(String(SendDanmakuCode.NotLoggedIn), 'B 站登录态已失效，需要重新扫码绑定账号', 'account_stop')
  }
  if (nav.code !== 0) {
    // The request itself was rejected. The account may be perfectly fine once the
    // rejection passes, so this must not fail the task.
    return probeFailure(`nav_${String(nav.code)}`, `会话检查被拒绝（code ${String(nav.code)}）`, 'retry')
  }
  if (nav.data?.isLogin === false) {
    // `-101` is Bilibili's 账号未登录, which is exactly what this state is.
    return probeFailure(String(SendDanmakuCode.NotLoggedIn), 'B 站登录态已失效，需要重新扫码绑定账号', 'account_stop')
  }
  if (nav.data?.isLogin !== true) {
    // A payload that publishes no session state is neither a dead session nor a
    // live one. Failing the task would be as wrong as declaring it healthy.
    return probeFailure(LocalCode.SessionUnknown, '会话状态无法判定（/nav 未返回 isLogin）', 'retry')
  }

  let room: RoomInit
  try {
    room = await resolveRoom(http, roomId)
  } catch (error: unknown) {
    // Deliberately ungraded, and **what changed here is the reason**. `resolveRoom` now tells a refusal
    // from a transport fault — it throws `RoomRefusedError` carrying Bilibili's own code — so this side
    // *could* single out `RoomInitCode.RoomNotFound` and park the action. It does not, and that is a
    // decision rather than a leftover: a probe runs on a room `resolveTarget` already resolved, so a
    // refusal here means the room stopped existing, and nothing in this repo establishes how permanent
    // that is — a risk-control rejection or a cached 404 wears the same shape. So the number is still
    // never read back out of the message (the habit this refactor removed), and an ungraded retry with the
    // cause kept in `detail` for a person stays the honest answer.
    return probeFailure(transportCodeOf(error), `查询直播间失败：${errorText(error)}`, 'retry')
  }

  return {
    ok: true,
    // `isLive` is the single place that decides `2` (轮播) is not live; folding the
    // raw value to the seam's two states here is what lets the scheduler compare once
    // for every Platform instead of knowing each one's encoding.
    liveStatus: isLive(room.live_status) ? LIVE_STATUS_LIVE : LIVE_STATUS_OFFLINE,
    // Empty rather than a third round trip. The title is cosmetic, the caller gets it
    // once from `resolveTarget`, and this probe runs on a timer for every task
    // against endpoints that answer 412 when they are pushed.
    title: '',
    code: String(SendDanmakuCode.Ok),
    detail: '',
    failure: 'none'
  }
}

/**
 * One danmaku.
 *
 * Every failure Bilibili numbers is graded on that number and nothing else. The
 * old scheduler matched `-101` against `error.message`, which fired only when
 * Bilibili happened to omit its own `message` field — so a dead session was
 * detected almost never, and `SendDanmakuCode` now decides instead.
 */
async function send(account: PlatformAccount, targetKey: string, text: string): Promise<SendOutcome> {
  const roomId = roomIdOf(targetKey.trim())
  if (roomId === null) return sendFailure(LocalCode.BadTarget, '目标不是有效的直播间号', 'action_stop')

  const credential = parseCredential(account.credentials)
  if (credential === null) {
    // Nothing a retry can do: the session has to be re-bound by a person.
    return sendFailure(LocalCode.NoCredential, '账号凭据缺失或无法解析，需要重新扫码绑定', 'account_stop')
  }

  // The one secret this request puts in its **body**: `live.ts` sends `csrf` and `csrf_token` as
  // multipart fields, so a transport failure's own text can carry it — `http.ts` puts the first 200
  // characters of a response body into the message it throws, and an echoed multipart rejection is
  // exactly that shape. `readGraded`'s `secret` argument exists for the one caller whose body holds a
  // credential — the heartbeat, whose `benchmark` field is the session's signing key, passed at its
  // own call site in `reconcileWatchLive` — and this is the other call site whose body does, holding
  // the value itself. Redacting at the refusal below is not a substitute: `result.error` is
  // Bilibili's own sentence about a request whose csrf sat in the body rather than in the query
  // string the like endpoints carry theirs in, so this call is not the omission it looks like.
  const http = clientFor(credential)
  const secret = http.cookies.csrfToken ?? ''

  let result: Awaited<ReturnType<typeof sendDanmaku>>
  try {
    result = await sendDanmaku(http, wbiKeys, { roomId, message: text })
  } catch (error: unknown) {
    // `sendDanmaku` returns API-level failures as data, so a throw is transport:
    // a network fault, a timeout, or a payload that no longer parses.
    return sendFailure(transportCodeOf(error), `发送失败：${redactSecrets(errorText(error), secret)}`, 'retry')
  }

  if (result.ok) return { ok: true, code: String(SendDanmakuCode.Ok), detail: '', failure: 'none' }

  // `result.error` is Bilibili's own message and is only ever shown to a person. A muted room
  // is the one refusal that has to *name the room*: the account is healthy, so which room is
  // refusing is the only part of this a person can act on, and `targetKey` is how they
  // recognise it.
  const detail =
    result.code === SendDanmakuCode.RoomMuted ? `房间 ${targetKey.trim()} 全员禁言：${result.error}` : result.error
  return sendFailure(String(result.code), detail, gradeSendCode(result.code))
}

/**
 * Grades `/msg/send`'s code.
 *
 * The constants come from `bilibili/types.ts`, where they were written down for the
 * endpoints they belong to — `-400` means 房间全员禁言 *here*, which is why the
 * probe does not reuse this mapping. (The same number on the like endpoints is a risk-control
 * refusal, graded `retry` in `reconcileLikeDanmaku`.) Numbers only: a code equal to any of
 * these is the only thing that matches.
 *
 * `-400`, `-403` and `-101` are deliberately three kinds, not one: only one of the three is
 * the session, and only one is about the room. 房间全员禁言 leaves the account able to send
 * anywhere else, so it parks this task; 账号被封禁 is account-level without being an expiry,
 * and re-binding the account is not what clears it.
 */
function gradeSendCode(code: number): FailureKind {
  switch (code) {
    case SendDanmakuCode.NotLoggedIn: // -101 未登录 / 登录态失效 — the session is gone
      return 'account_stop'

    case SendDanmakuCode.Banned: // -403 账号被封禁 — the account is refused; the session is fine
      return 'account_restricted'

    case SendDanmakuCode.RoomMuted: // -400 房间全员禁言 — this room is refusing, the account is not
      return 'action_stop'

    case SendDanmakuCode.ContentRejected: // 10030 内容被拒 — this bullet, not the account
    case SendDanmakuCode.RateLimited: // 10031 发送过快 — the next attempt may well pass
    case SendDanmakuCode.SignError: // -111 签名失败 — sendDanmaku already dropped the cached keys
      return 'retry'

    default:
      // An unknown code is not guessed at. Retrying keeps the loop alive, and the
      // code travels in `code`/`detail` so a new Bilibili code shows up in the UI
      // rather than silently disappearing into a substring match.
      return 'retry'
  }
}

/* ------------------------------------------------------------------ *
 * reconcile — the account's 粉丝牌 chores, one run at a time
 * ------------------------------------------------------------------ */

/**
 * One reconcile run: read what the Platform reports, finish what is outstanding, and say
 * what each action was about.
 *
 * `enabledActions` is the switchboard's answer and the only source of what may run; this
 * adapter adds, drops and reorders nothing. One `ActionOutcome` per key, in the order given,
 * so the action log reads the same way however many of them had work to do.
 *
 * Two of the three actions are **per Room** — a 亲密度 chore hangs off one anchor's 粉丝牌 — so
 * `targetKey` is the real room id `resolveTarget` stored, and the runner keeps one reconcile
 * task per (Platform, target), which is what lets five medals be five separate chore lists. The
 * third, 点亮粉丝牌, is about the account's medals rather than one anchor's: it discovers its own
 * rooms and is the one action here that a Room's task must **not** run (see `reconcileRelightMedal`).
 *
 * `dayKey` and `now` are deliberately not consulted. None of the three has an opening hour, and
 * everything that decides them — the like task's claimed count, the 观看 task's completion, a medal's
 * `is_lighted` — is read back from the Platform on every round, because deriving it locally is the
 * guess `medal.ts` exists to prevent. `LikeScheduleGuard`'s cross-day gate is not consulted either,
 * and that is a decision rather than an oversight: it would stop a like between 23:55 and
 * 00:05, `platform/time.ts` exposes hours rather than minutes, so honouring it here would mean
 * writing a second local-time conversion for a heuristic whose whole value the like task's own
 * claimed count already provides. Recorded rather than guessed.
 */
async function reconcile(context: ReconcileContext): Promise<ActionOutcome[]> {
  const credential = parseCredential(context.account.credentials)
  // One client for the whole run: the jar is a copy of the stored credential and the WBI key
  // store is process-wide, so a second client per action would only hold a second copy of the
  // same session.
  const http = credential === null ? null : clientFor(credential)

  const outcomes: ActionOutcome[] = []
  for (const key of context.enabledActions) {
    outcomes.push(await reconcileAction(key, context, http))
  }

  return outcomes
}

/** Dispatches one action key. An unrecognised key is reported, never thrown. */
async function reconcileAction(key: string, context: ReconcileContext, http: BiliHttp | null): Promise<ActionOutcome> {
  switch (key) {
    case ActionKey.LikeDanmaku:
      return await reconcileLikeDanmaku(context, http)
    case ActionKey.WatchLive:
      return await reconcileWatchLive(context, http)
    case ActionKey.RelightMedal:
      return await reconcileRelightMedal(context, http)
    default:
      // Unreachable through the scheduler, which filters `enabledActions` down to keys this
      // catalogue declares as reconcile actions. Answered rather than thrown because a throw
      // loses the whole run's outcomes, including the other action's work — and `blocked`
      // rather than `failed`, because nothing here failed; the gap is on this side.
      return blockedOutcome(
        key,
        context.targetKey,
        LocalCode.UnknownAction,
        `B 站不认识动作 ${key}，这个 key 不在本平台的目录里。`
      )
  }
}

/**
 * 点赞 (like_danmaku) — the day's like task, one whole batch at a time.
 *
 * The loop is the measured shape — **read → judge → act → re-read** — and it is a loop
 * because one request is not the day's job. Three things the 2026-10-08 live test settled,
 * and each one decides a line below:
 *
 *  - **The batch is the task's own number.** `title` is 「点赞30次」 and 30 is the batch;
 *    `medal.ts`'s `parseTaskCount` parses it and the gate hands it over. It is never a
 *    constant here, and a title that does not parse is a refusal rather than a guess.
 *  - **The daily cap is per medal and level-dependent.** `sub_title` is `<claimed>/<limit>`,
 *    and the two observed points are level 1 → 1 and level 30 → 10. **The mapping between a
 *    medal's level and its cap is not established**, so nothing here may hold either the cap
 *    or the number of rounds it implies: the first read's `remainingRounds` is the loop's
 *    budget, and the re-read is what says whether to spend another round.
 *  - **`is_done` is the only completion signal, and there is no partial progress.** A batch is
 *    either counted (the flag flips) or indistinguishable from a discarded one — one
 *    `click_time=1` told us nothing either way. So the only shapes are "send a whole batch"
 *    and "send nothing"; "top up the remainder" does not exist.
 *
 * A round is therefore: read the gate (the panel and the room's like switches, judged by the pure
 * `likeGate`), send exactly one whole batch, and read again. The loop ends when a read says the
 * task is done — reported `already` — when the gate refuses, reported by its own reason, or when
 * the budget is spent, reported as a **failure**, because a server that took the likes without
 * counting them is exactly the kind of fact an event should raise.
 *
 * The evidence behind each gate lives in `like.ts` and is not re-derived here; what this
 * function decides is only how each refusal is reported. `LikeRefusal` has five members and
 * `LIKE_REFUSAL_REPORT` has all five.
 *
 * Two preconditions the like has, both independently corroborated, and neither implemented
 * here:
 *
 *  - **The medal must be lit.** The panel is gated by `is_lighted` — an unlit one holds two
 *    rows whose `sub_title` is literally 「仅点亮」 — so `likeGate` refuses `medal_not_lit` and
 *    this function reports it `blocked`. `medal_not_lit` is measured, not inferred: the unlit
 *    panel is what the read actually returns.
 *  - **The room must be live.** The reference implementation says it outright —
 *    `if (action == "like" && room.Live_Status != 1) return sent;` — and that requirement is
 *    the task's own `requireOnline` switch rather than this adapter's judgement: whether to
 *    like into a room that is not streaming is a person's decision, and the seam does not hand
 *    `requireOnline` over in `ReconcileContext`, so there is nothing here that could enforce
 *    it. Named rather than re-implemented, and named because both preconditions must hold for
 *    a like to earn anything.
 */
async function reconcileLikeDanmaku(context: ReconcileContext, http: BiliHttp | null): Promise<ActionOutcome> {
  const key = ActionKey.LikeDanmaku
  const targetKey = context.targetKey
  if (http === null) return noCredentialOutcome(key, targetKey)

  const roomId = roomIdOf(targetKey.trim())
  if (roomId === null) {
    // A key that is not a room number cannot start working later; parking the action beats
    // retrying a typo forever.
    return roomOutcome(key, targetKey, 'failed', '目标不是有效的直播间号', LocalCode.BadTarget, 'action_stop')
  }

  const uid = likerUidOf(http)
  if (uid === null) {
    return roomOutcome(
      key,
      targetKey,
      'failed',
      '账号凭据里读不出当前账号的身份标识，点赞请求无法构造，需要重新扫码绑定。',
      LocalCode.MissingUid,
      'account_stop'
    )
  }

  const csrf = http.cookies.csrfToken
  if (csrf === undefined) {
    // The same local short-circuit every write path in this project makes: a write echoes the
    // CSRF cookie twice, so a jar without it could only produce a rejected request.
    context.log('点赞未动手：账号凭据里没有写请求所需的 CSRF cookie')
    return likeRefusalOutcome(key, targetKey, LikeRefusal.NotLoggedIn)
  }

  const roomRead = await readGraded('读取直播间信息', () => readRoom(http, roomId))
  if (!roomRead.ok) return roomOutcome(key, targetKey, 'failed', roomRead.detail, roomRead.code, 'retry')

  const room = roomRead.value
  const anchorId = room.uid
  const realRoomId = room.room_id

  const reading = await readLike(http, csrf, realRoomId, anchorId)
  if (reading.kind === 'unreadable') {
    return roomOutcome(key, targetKey, 'failed', reading.detail, reading.code, reading.failure)
  }
  if (reading.kind === 'refused') {
    logRefusal(context, reading.refusal, reading.detail)
    return likeRefusalOutcome(key, targetKey, reading.refusal)
  }

  // The budget is the server's own number from the first read — how many rounds this medal's
  // cap still owes — not a constant, and not a counter that survives to the next run.
  const budget = reading.gate.remainingRounds
  let gate = reading.gate
  let rounds = 0
  let clicks = 0

  while (true) {
    // Between rounds only: the first request follows a read, and this is the room's own
    // declared cooldown (measured 0.35 s) with a local floor under it.
    if (rounds > 0) await sleep(gate.minIntervalMs)

    // Through `readGraded` for the reason the seam gives and this call used to break: `like.ts` lets a
    // transport failure out on purpose — its own note says the caller grades it as a retry — and an
    // exception escaping here would leave `reconcile`, which has no `try`, and take the run's other
    // actions' outcomes with it, writing no log row for anyone to read.
    const likedRead = await readGraded(
      '点赞',
      () =>
        likeWithFallback(http, wbiKeys, {
          roomId: realRoomId,
          anchorId,
          uid,
          clickTime: gate.batchClicks
        }),
      csrf
    )
    if (!likedRead.ok) {
      return roomOutcome(key, targetKey, 'failed', likedRead.detail, likedRead.code, 'retry')
    }
    const liked = likedRead.value

    if (!liked.ok) {
      // A refusal from a like endpoint is data, so the code is what grades it — and an
      // unknown code is a retry rather than a guess, carrying Bilibili's own words to a person.
      return roomOutcome(
        key,
        targetKey,
        'failed',
        `${clickProgressOf(rounds, clicks)}这一轮点赞被拒绝：${redactSecrets(liked.error, csrf)}`,
        String(liked.code),
        liked.code === LikeCode.NotLoggedIn ? 'account_stop' : 'retry'
      )
    }

    rounds += 1
    clicks += gate.batchClicks
    context.log(`点赞：第 ${rounds} 轮已发出 ${gate.batchClicks} 次，回读任务状态`)

    const again = await readLike(http, csrf, realRoomId, anchorId)
    if (again.kind === 'ready') {
      if (rounds >= budget) {
        return roomOutcome(
          key,
          targetKey,
          'failed',
          `${clickProgressOf(rounds, clicks)}服务端接受了这些点赞，但任务仍未标记完成，这一轮到此为止。`,
          LocalCode.LikeUnfinished,
          'retry'
        )
      }
      gate = again.gate
      continue
    }

    if (again.kind === 'unreadable') {
      return roomOutcome(
        key,
        targetKey,
        'failed',
        `${clickProgressOf(rounds, clicks)}${again.detail}`,
        again.code,
        again.failure
      )
    }

    logRefusal(context, again.refusal, again.detail)
    if (again.refusal === LikeRefusal.TaskDone) {
      // The reward is the panel's own `add_text`, taken from the read that started this round
      // because a refusal deliberately carries no panel — the same field either read would give.
      // 「任务已完成（回读确认）」 rather than a sentence: the row is named after the action and
      // this is what it did, so 「今天的点赞任务已经完成」 named it twice to say one thing.
      return roomOutcome(
        key,
        targetKey,
        'done',
        `${clickProgressOf(rounds, clicks)}任务已完成（回读确认）${rewardClauseOf(reading.task.add_text)}`,
        String(SendDanmakuCode.Ok),
        'none'
      )
    }
    return likeRefusalOutcome(key, targetKey, again.refusal, clickProgressOf(rounds, clicks))
  }
}

/**
 * 观看直播 (watch_live) — **one short slice** of a viewing session per run.
 *
 * **The 900 s is the duration to accumulate, not a heartbeat period.** 「观看直播满15分钟」
 * states how much watching the task wants; the beat period is `heartbeat_interval`, which the
 * server issues on every response and `watch-live.ts` already refuses outside `(0, 300]`. So
 * the waiting is the server's number, and nothing here ever sleeps the task's own duration.
 *
 * **Whether enough has accumulated is decided only by `isTaskDone`.** Nothing here adds up
 * watched seconds. The reference implementation does (`while (duration < 25 * 60)` — it holds one
 * session for 25 minutes and watches its own clock run out), and that is precisely the local
 * accounting this project exists not to do: the panel is the only thing that knows, so it is
 * re-read after every beat, and between slices the day's progress is whatever the server says it is.
 *
 * **Why a slice and not the whole session, written down because undoing it is the next reader's
 * most likely move.** `runner.ts` sweeps tasks **serially** behind a `ticking` guard, so a call
 * that held one session would block every other task for its length — the 15 minutes this task
 * accumulates, or the reference's full 25-minute session when the server never credits it — and on
 * a bad day that same block would come round again every interval, because the handshake has no live
 * capture and the server may quietly ignore it. Trading an unverified chain for that price is the
 * wrong way round. One slice costs at most `WATCH_SLICE_BUDGET_SECONDS`, and repeated sweeps carry
 * the accumulation. **That ceiling is a promise the interval's floor keeps**: the budget accumulates
 * the *nominal* sleeps, so an interval the service could name below a second would otherwise buy it a
 * slice of tens of thousands of beats, each one a heartbeat and a read-back —
 * `WATCH_MIN_HEARTBEAT_MS` is what refuses that.
 *
 * A slice is `enterLiveRoom` → wait the server's interval → beat → re-read the panel → stop, and
 * it always takes at least one beat: sleeping less than the interval and then reporting it as
 * `time` in the signature would be claiming a gap that did not happen. That is also the one case
 * where a slice runs past the ceiling — a server issuing a 300 s interval is waited out once — and
 * the alternative, refusing to beat when the interval does not fit, would leave the action
 * reporting "in progress" forever without ever sending anything.
 *
 * **The other direction is the same rule and has its own shape, because `WATCH_MIN_HEARTBEAT_MS` can
 * make the sleep longer than the interval.** Below the floor the service may name 0.001 s while this
 * loop sleeps 1 s, so `time` has to carry the second, and it does: the loop hands `sendLiveHeartbeat`
 * the seconds it actually waited (`beatMs / 1000`) rather than `session.heartbeatInterval`, which is
 * what the field is documented to be and what its own note in `watch-live.ts` records. Both halves
 * of the sentence are therefore about the *gap that happened* — never the smaller number, never the
 * larger one — and the signature and the body carry the same value because both are built from it.
 *
 * The outcome when the panel has not finished is `blocked` with `watch_in_progress`. `blocked`
 * because it is one of the two outcomes `runner.ts` refuses to count as a settled day, which is
 * exactly what brings the action back for the next slice; `watch_in_progress` rather than a
 * failure-sounding code so that the record, the event and the debug panel read "still going"
 * instead of "broken".
 *
 * **The price of slicing is a noisy event, and it belongs to the seam, not here.** Every unfinished
 * slice reports `blocked`, and `runner.ts` raises 动作受阻 for a `blocked` outcome — suppressed per
 * task and per kind for 30 minutes (`emitOnce`), so a day of slicing shows a handful of 动作受阻
 * warnings for an action working exactly as designed. That is what the five-outcome vocabulary
 * costs: `done`/`already`/`skipped` would settle the day and be a lie, `failed` would claim
 * something broke, and there is no "in progress and not settled" member. If that noise ever
 * becomes a nuisance the fix is to add that state to the seam — **not** to make this action hold
 * the whole session again.
 *
 * **What is not verified, recorded so nobody reads more into this than there is.** The
 * heartbeat chain has no live capture: its request shape comes from two independent reference
 * implementations, and `watch-live.ts`'s module header says so, including that `enterLiveRoom`
 * has never been confirmed against the server. It is wired anyway, because the catalogue must
 * carry it and the switch is a person's; the consequence is named here rather than hidden — a
 * handshake the server silently ignores keeps every slice reporting `watch_in_progress`, and the
 * 动作受阻 event that comes with it is how a person finds out. Slicing is what keeps that state
 * cheap: it costs one short call per sweep instead of a blocked scheduler. The module header's
 * precondition stands unchanged: run `enterLiveRoom` once against a real account, confirm
 * `code: 0` with a `secret_key`, and only then switch this action on.
 *
 * The room's liveness precondition is the task's `requireOnline` here too — the reference's
 * watch path checks the same thing its like path does — and is deliberately not
 * re-implemented.
 */
async function reconcileWatchLive(context: ReconcileContext, http: BiliHttp | null): Promise<ActionOutcome> {
  const key = ActionKey.WatchLive
  const targetKey = context.targetKey
  if (http === null) return noCredentialOutcome(key, targetKey)

  const roomId = roomIdOf(targetKey.trim())
  if (roomId === null) {
    return roomOutcome(key, targetKey, 'failed', '目标不是有效的直播间号', LocalCode.BadTarget, 'action_stop')
  }

  const csrf = http.cookies.csrfToken
  if (csrf === undefined) {
    // The same local state the like gate names `not_logged_in`, borrowed from it rather than
    // spelled a second way: no CSRF cookie means no write request can be formed.
    context.log('观看直播未动手：账号凭据里没有写请求所需的 CSRF cookie')
    return likeRefusalOutcome(key, targetKey, LikeRefusal.NotLoggedIn)
  }

  const roomRead = await readGraded('读取直播间信息', () => readRoom(http, roomId))
  if (!roomRead.ok) return roomOutcome(key, targetKey, 'failed', roomRead.detail, roomRead.code, 'retry')
  const room = roomRead.value

  const anchorId = room.uid
  const panelRead = await readGraded('读取粉丝牌任务', () => fetchMedalTasks(http, csrf, anchorId))
  if (!panelRead.ok) return roomOutcome(key, targetKey, 'failed', panelRead.detail, panelRead.code, 'retry')
  const panel = panelRead.value

  if (!panel.ok) {
    // `-101` from the panel is a dead session, and grading it as an unreadable read would leave
    // it retrying forever instead of failing the task so a person can re-bind.
    if (panel.code === SendDanmakuCode.NotLoggedIn) {
      return roomOutcome(
        key,
        targetKey,
        'failed',
        'B 站登录态已失效，需要重新扫码绑定账号。',
        String(panel.code),
        'account_stop'
      )
    }
    return roomOutcome(
      key,
      targetKey,
      'failed',
      `读取粉丝牌任务失败：${redactSecrets(panel.error, csrf)}`,
      String(panel.code),
      'retry'
    )
  }

  if (!panel.data.is_lighted) {
    // Unlit medals do not carry this task at all; same state and same reason as the like's,
    // spelled for this action rather than shared, the way the two helpers below are.
    return roomOutcome(key, targetKey, 'blocked', '粉丝牌未点亮、观看不计亲密度', LikeRefusal.MedalNotLit, 'none')
  }

  const watchTask = findMedalTask(panel.data.task_info, MedalJumpType.WatchLive)
  if (watchTask === undefined) {
    // Never observed on a lit panel — five rows, this one among them — so it is treated
    // fail-closed rather than as "nothing to do".
    return roomOutcome(
      key,
      targetKey,
      'failed',
      '粉丝牌任务表里没有「观看直播」这一项，这一轮没有动手。',
      LocalCode.WatchTaskMissing,
      'retry'
    )
  }

  // The Platform's own verdict, through the predicate `medal.ts` exports for it.
  if (isTaskDone(panel.data.task_info, MedalJumpType.WatchLive)) {
    return roomOutcome(key, targetKey, 'already', '任务已完成', LocalCode.WatchTaskDone, 'action_stop')
  }

  // The handshake's `id` field is `[parent_area_id, area_id, seq, room_id]`, so both ids have to
  // exist before a session can be asked for — and this is the point in the run where that starts to
  // matter, which is why it is judged here and not before the panel was read: a day already done
  // needs no area at all. They are optional on the room payload for the reason `types.ts` gives
  // (two of its three consumers never read them), so the gap is judged here rather than at the
  // parse, and fail-closed rather than by handing the handshake an invented area.
  const parentAreaId = room.parent_area_id
  const areaId = room.area_id
  if (parentAreaId === undefined || areaId === undefined) {
    return roomOutcome(
      key,
      targetKey,
      'failed',
      '直播间响应里没有分区 id，观看会话无法建立，这一轮没有动手。',
      LocalCode.WatchAreaMissing,
      'retry'
    )
  }

  const buvidRead = await readGraded('读取直播间页面', () => liveBuvidOf(http, room.room_id))
  if (!buvidRead.ok) return roomOutcome(key, targetKey, 'failed', buvidRead.detail, buvidRead.code, 'retry')

  const buvid = buvidRead.value
  if (buvid === null) {
    // Fail closed: the handshake signs with this device id, so sending one anyway would be
    // inventing the value a signature is computed over.
    return roomOutcome(
      key,
      targetKey,
      'failed',
      '直播域名没有下发设备 cookie，心跳请求无法构造，这一轮没有动手。',
      LocalCode.NoBuvid,
      'retry'
    )
  }

  // Graded for the reason the like calls above are: `watch-live.ts`'s `enterLiveRoom` lets a transport
  // failure out, and this is a call inside `reconcile`, whose contract is that nothing a *transport*
  // does can escape it — a throw here would lose the run's outcomes and write no row at all.
  const enteredRead = await readGraded('进入观看会话', () =>
    enterLiveRoom(http, {
      roomId: room.room_id,
      ruid: anchorId,
      parentAreaId,
      areaId,
      buvid
    })
  )
  if (!enteredRead.ok) {
    return roomOutcome(key, targetKey, 'failed', enteredRead.detail, enteredRead.code, 'retry')
  }
  const entered = enteredRead.value
  if (!entered.ok) {
    return roomOutcome(
      key,
      targetKey,
      'failed',
      `进入观看会话被拒绝：${entered.error}`,
      String(entered.code),
      entered.code === SendDanmakuCode.NotLoggedIn ? 'account_stop' : 'retry'
    )
  }
  context.log(
    `观看直播：会话已建立，服务端下发的心跳间隔 ${String(entered.session.heartbeatInterval)} 秒（本地下限 ${String(WATCH_MIN_HEARTBEAT_MS / 1000)} 秒，低于它按它算）`
  )

  let session: WatchSession = entered.session
  // The slice's own budget, in milliseconds: how long this call may spend waiting before it hands
  // the session back to the next sweep. It is a bound on *this call's waiting*, never a measure of
  // the task's progress — `isTaskDone` below is the only thing that decides whether the day is done.
  //
  // **And a fresh session per slice is this project's choice rather than a shape a capture
  // establishes.** The reason is the sweep: `runner.ts` runs its tasks one at a time, so one session
  // held for the whole day would hold every other task behind it (the argument `medal.ts` gives for
  // `MAX_MEDAL_PANEL_PAGES`). **The heartbeat chain has no live capture at all** — `watch-live.ts`
  // records that, twice, and so does this file's note above `reconcileWatchLive` — so nothing here
  // claims the service re-issues the session's key, its timestamp and its interval per response. What
  // is established is that this build sends a fresh `enter` per slice and the service accepts it.
  const sliceBudgetMs = WATCH_SLICE_BUDGET_SECONDS * 1000
  let waitedMs = 0
  let beats = 0

  // At least one beat — see the note above on why a slice is never shorter than an honest interval —
  // and after that only while the next interval still fits inside the slice's ceiling. **The interval
  // is `beatMsOf`'s, not the service's raw number**: a floor on it is what keeps the beats this loop
  // sends inside the ceiling its own budget claims (see `WATCH_MIN_HEARTBEAT_MS`).
  while (beats === 0 || waitedMs + beatMsOf(session) <= sliceBudgetMs) {
    const beatMs = beatMsOf(session)
    await sleep(beatMs)
    waitedMs += beatMs

    // The seconds this call actually slept, not the interval the service named: `sendLiveHeartbeat`
    // puts that number in the signature **and** in the body's `time`, and the two have to be the same
    // value. Above `WATCH_MIN_HEARTBEAT_MS` the two are identical; below it the floor is this
    // project's own, and reporting the service's smaller number would be a gap in the request that
    // never happened — the mirror image of the case the note above calls dishonest.
    const beatRead = await readGraded(
      '心跳',
      () => sendLiveHeartbeat(http, session, Date.now(), beatMs / 1000),
      session.secretKey
    )
    if (!beatRead.ok) {
      return roomOutcome(key, targetKey, 'failed', `第 ${beats + 1} 拍${beatRead.detail}`, beatRead.code, 'retry')
    }

    const beatResult = beatRead.value
    if (!beatResult.ok) {
      // The session's own secret is redacted from anything reported, because this response is
      // the one place a server could echo a body that carries it (`benchmark`).
      return roomOutcome(
        key,
        targetKey,
        'failed',
        `第 ${beats + 1} 拍心跳被拒绝：${redactSecrets(beatResult.error, session.secretKey)}`,
        String(beatResult.code),
        beatResult.code === SendDanmakuCode.NotLoggedIn ? 'account_stop' : 'retry'
      )
    }
    session = beatResult.session
    beats += 1
    context.log(`观看直播：第 ${beats} 拍心跳已发出，回读任务状态`)

    const againRead = await readGraded(`第 ${beats} 拍心跳后的回读`, () => fetchMedalTasks(http, csrf, anchorId))
    if (!againRead.ok) {
      return roomOutcome(key, targetKey, 'failed', againRead.detail, againRead.code, 'retry')
    }

    const again = againRead.value
    if (!again.ok) {
      if (again.code === SendDanmakuCode.NotLoggedIn) {
        return roomOutcome(
          key,
          targetKey,
          'failed',
          'B 站登录态已失效，需要重新扫码绑定账号。',
          String(again.code),
          'account_stop'
        )
      }
      return roomOutcome(
        key,
        targetKey,
        'failed',
        `第 ${beats} 拍心跳后的回读失败：${redactSecrets(again.error, csrf)}`,
        String(again.code),
        'retry'
      )
    }

    if (isTaskDone(again.data.task_info, MedalJumpType.WatchLive)) {
      return roomOutcome(
        key,
        targetKey,
        'done',
        `任务已完成（服务端回读确认）${rewardClauseOf(watchTask.add_text)}`,
        String(SendDanmakuCode.Ok),
        'none'
      )
    }
  }

  // Not done yet: hand the day back to the next sweep. `blocked` is what keeps the action coming
  // back, and `watch_in_progress` is what keeps the fact about it from reading like a fault.
  return roomOutcome(
    key,
    targetKey,
    'blocked',
    `本轮保持 ${String(beats)} 拍、任务还没完成`,
    LocalCode.WatchInProgress,
    'none'
  )
}

/* ------------------------------------------------------------------ *
 * 点亮粉丝牌 — the account's dark medals, one anchor at a time
 * ------------------------------------------------------------------ */

/**
 * How long to wait before reading `is_lighted` back.
 *
 * **Not a measurement**, and it is written down as what it is: the reference implementation also
 * waits before re-reading, and an immediate re-read can see a write the server has accepted but not
 * yet applied — which would be reported as *unconfirmed* and cost a second batch of likes on the
 * next sweep. One second, once per run (never once per medal), is a floor on this run's patience
 * rather than a claim about the server. A run that had nothing to light does not wait at all.
 */
const RELIGHT_CONFIRM_DELAY_MS = 1_000

/**
 * 点亮粉丝牌 (relight_medal) — re-light every dark 粉丝牌 the account holds, waiting for anchors
 * to go live.
 *
 * **A new purpose, not a loosened gate.** `like_danmaku` refuses a dark medal with `medal_not_lit`,
 * and that refusal is right *about what it is about*: a like on a dark medal earns no 亲密度, because
 * both of that panel's rows have an empty `add_text` (measured). 点亮 is a **different purpose** —
 * dark is precisely the state in which a like does light the medal — so this action does not touch
 * that gate; it gets a path of its own, with its own reason. The two also differ in what proves them
 * done: `like_danmaku` finishes on the medal's own `is_done`, this one on `is_lighted`.
 *
 * One run, and every step of the shape corresponds to a measurement:
 *
 *  - **Read the account's whole medal list, page by page** (`fetchMedalPanel`) instead of being
 *    pointed at one room. The owner holds 24 dark medals across 24 rooms and does not want 24 tasks,
 *    so the task carries **no target**: `targetKey` is the empty string, and `findReconcileTask`'s key
 *    — `(Platform, target, action)`, with the action being this one — gives exactly one such task per
 *    account.
 *  - **That one read answers three questions**: which medals exist, which of them are dark
 *    (`medal.is_lighted`, a number here where the per-anchor panel sends a boolean), and which rooms
 *    are streaming (`room_info.living_status`, measured 24/24 against a per-room `getInfoByRoom`).
 *    So this action **never probes a room**: 24 probes per sweep would be thousands of requests a day
 *    for an answer the read already carries.
 *  - **Only a dark medal whose anchor is live gets a like** — one `likeReportV3` per room, invisible
 *    to viewers. **That precondition is the owner's rule from Bilibili's own app, and it is a policy
 *    rather than a measurement — this build's own forensics could not settle the question underneath
 *    it.** `notes/bili-fan-medal-relight-causal-test-2026-10-08.md` records the two sources that exist
 *    for "a like lights a dark medal" as **both being policy** (a reference implementation's dispatch
 *    rule, and this repo's own default) and lists 「向未开播房间点赞是否会被计入勋章」 as **未确定**; the two
 *    readings of "an offline room has no 粉丝牌 entry" that *could* be tested were both refuted by that
 *    same note's runs — 26 dark medals read fine while all 24 rooms were offline (`live_status = 0`),
 *    and every one of those dark medals' task tables carries a `like | 点赞30次 | 仅点亮` row. (What the
 *    claim is really about is the **app's** 粉丝牌 entry, which no capture here covers.) So this line
 *    implements the owner's rule and says so; what it costs when the rule is wrong is the like that
 *    would have lit a medal while its anchor was offline.
 *  - **And it is the one precondition this build's own probe could not have settled anyway**: the live
 *    2026-10-08 walk found all 24 rooms offline, so there was nothing to measure it against.
 *  - **The batch size is not decided here.** The list read carries no task row, so no `title` to
 *    parse; `like.ts`'s `DEFAULT_CLICK_TIME` is that module's own documented fallback for exactly
 *    this case, and it is the number measured to be accepted whole. **Nothing here reads, stores or
 *    invents a like cap**: the daily cap is per medal and level-dependent (level 1 → 1, level 30 →
 *    10) and lives in `sub_title`, which a dark medal's rows do not have (`仅点亮` has no `n/m` at
 *    all). So one batch per medal per run, and the re-read decides.
 *  - **`is_lighted` is read back before anything is called lit.** `code: 0` is not evidence: the
 *    reference implementation waits and re-reads too, and this project has been burned by treating an
 *    accepted request as a settled one.
 *  - **When no dark medal's anchor is live the run reports `blocked`**, never `skipped`. `blocked` is
 *    one of the two outcomes `runner.ts` refuses to count as a settled day, so the next sweep tries
 *    again and the window is caught whenever it opens; `skipped` would mark the day done and silently
 *    miss every window — the same trap that cost the Douyu account 546 鱼丸.
 *
 * **The danmaku route is deliberately not taken here, and that is a decision rather than an
 * omission.** A dark medal has two lighting routes: this like, and 发弹幕10条 — ten messages. Those
 * are **public**, and the owner has a standing rule against sending messages into rooms that are not
 * his. Three things follow from that, in order of weight: the ten messages are visible to everyone in
 * the room; 24 dark medals would be 240 of them; and at the cadence 发送弹幕's own floor allows (10 s
 * between messages) one medal takes 100 s, so a run that walked all of them would hold the serial
 * sweep for the better part of an hour. A fallback of that shape is its own design, not a rider on
 * this one. So this action sends **no danmaku at all** — it says in its description what that route
 * costs (so the cost is visible before anyone switches it on), and when a like fails to light a medal
 * it names that route on the console line and leaves it there. Nothing public is ever sent.
 *
 * **It runs only from the task that names it, and the reason for that guard has changed while the
 * guard stayed.** This action discovers its own rooms by account, so being invoked for a *target*
 * would walk the same 24 medals a second time and send a second batch of likes into any room that
 * happens to be live. It therefore answers `skipped` when the task it was handed carries a target,
 * and does its work only for the task that carries none. That is not the trap above: it skips a
 * **duplicate invocation**, never a walk that might have a window.
 *
 * **The sentence here used to justify the guard with a fan-out that no longer exists.** It read
 * 「`runner.ts` hands **every** enabled reconcile key for the Platform to **every** reconcile task,
 * not just the key its own row carries」 — true when it was written, and false after 「一条任务只跑它
 * 自己指名的那个动作」: `scheduler/runner.ts` now builds `const reconcilable = [selection.actionKey]`,
 * one key, the row's own. What keeps the guard live is a different fact, and it is worth naming
 * because it is the reason not to delete the branch as dead: **`needsTarget` decides whether a target
 * must be present, not whether one may be.** `routes/tasks.ts` refuses a *missing* target for an
 * action that needs one and passes any target it is given straight into the row, and the create-or-get
 * helper keys on `(Platform, target, action)` — so a client that posts this account-scoped action's key
 * together with a target gets a **second row** beside the no-target one, and both rows would walk the
 * account's medals. The guard is what makes the second row harmless.
 */
async function reconcileRelightMedal(context: ReconcileContext, http: BiliHttp | null): Promise<ActionOutcome> {
  const key = ActionKey.RelightMedal
  if (http === null) {
    return accountOutcome(key, 'failed', NO_CREDENTIAL_DETAIL, LocalCode.NoCredential, 'account_stop')
  }

  if (context.targetKey !== '') {
    // See the note above: the row this refuses is one a client can create (a target is optional for
    // an action that does not need one) and one create-or-get keeps *beside* the account-scoped row
    // rather than collapsing into it, which is why the two rows would do the same work twice.
    return accountOutcome(
      key,
      'skipped',
      '账号级动作、这一轮由带房间的任务发起，不重复点亮（它的任务不选目标）',
      LocalCode.NotAccountScoped,
      'action_stop'
    )
  }

  const panelRead = await readGraded('读取粉丝牌列表', () => fetchMedalPanel(http))
  if (!panelRead.ok) return accountOutcome(key, 'failed', panelRead.detail, panelRead.code, 'retry')

  const panel = panelRead.value
  if (!panel.ok) {
    // `-101` from the list is a dead session, and grading it as an unreadable read would leave it
    // retrying forever instead of failing the task so a person can re-bind.
    if (panel.code === SendDanmakuCode.NotLoggedIn) {
      return accountOutcome(
        key,
        'failed',
        'B 站登录态已失效，需要重新扫码绑定账号。',
        String(panel.code),
        'account_stop'
      )
    }
    return accountOutcome(key, 'failed', `读取粉丝牌列表失败：${panel.error}`, String(panel.code), 'retry')
  }

  if (panel.data.length === 0) {
    // A `code: 0` list with no rows at all is either an account holding no medals or a read whose
    // contract changed, and this side cannot tell them apart. `blocked` is the only answer that does
    // not settle the day on the second reading — the day stays open, and the console line names both
    // readings rather than picking one.
    return accountOutcome(
      key,
      'blocked',
      '未读到任何粉丝牌（要么账号没有粉丝牌，要么这个读的契约变了）',
      LocalCode.NoMedals,
      'none'
    )
  }

  const uid = likerUidOf(http)
  if (uid === null) {
    // Same gap as the like action's: a like request carries the liker's own uid, so without one no
    // request can be formed — and this one is not a retry, because the credential is what is wrong.
    return accountOutcome(
      key,
      'failed',
      '账号凭据里读不出当前账号的身份标识，点赞请求无法构造，需要重新扫码绑定。',
      LocalCode.MissingUid,
      'account_stop'
    )
  }

  const subjects: readonly MedalSubject[] = panel.data.map(item => ({
    // The row's own name, which is what a person recognises. Never the room id or the anchor's uid:
    // an item's label is UI text, and those two are identifiers.
    label: item.anchor_info.nick_name === '' ? UNNAMED_ROOM : item.anchor_info.nick_name,
    roomId: item.room_info.room_id,
    anchorId: item.medal.target_id,
    // A number on this endpoint (0/1) where `GetActivatedMedalInfo` sends a boolean; both encodings
    // are measured, so each read is spelled as the endpoint that sent it.
    lit: item.medal.is_lighted !== 0,
    // `isLive` is the single place that decides `2` (轮播) is not live — the same predicate `probe`
    // folds into the seam's two states.
    live: isLive(item.room_info.living_status)
  }))

  const toLight = subjects.filter(subject => !subject.lit && subject.live)
  const waiting = subjects.filter(subject => !subject.lit && !subject.live).length
  context.log(
    `点亮粉丝牌：读到 ${String(subjects.length)} 枚粉丝牌，其中未点亮且主播在播 ${String(toLight.length)} 枚、未点亮且未开播 ${String(waiting)} 枚`
  )

  if (toLight.length === 0) {
    // Nothing to act on, so the first read is the whole answer: no wait, no re-read, no write.
    return medalWalkOutcome(key, subjects, new Set(), new Map())
  }

  const csrf = http.cookies.csrfToken
  if (csrf === undefined) {
    // The write precondition, judged where it starts to matter rather than before the read: this
    // action's read is worth making on its own — it is how "nothing to do today" is learned — so a
    // jar that cannot write is only a problem once there is something to write about.
    context.log('点亮粉丝牌未动手：账号凭据里没有写请求所需的 CSRF cookie')
    return likeRefusalAccountOutcome(key, LikeRefusal.NotLoggedIn)
  }

  const failures = new Map<number, MedalFailure>()
  for (const subject of toLight) {
    // No `clickTime`: see the note above on why the batch size has one home, in `like.ts`. Graded
    // rather than allowed to throw, for the reason the like action's own call records: one anchor's
    // transport failure must cost that anchor and nothing else — least of all the run's outcome.
    const likedRead = await readGraded(
      '点赞',
      () =>
        likeWithFallback(http, wbiKeys, {
          roomId: subject.roomId,
          anchorId: subject.anchorId,
          uid
        }),
      csrf
    )

    if (!likedRead.ok) {
      failures.set(subject.anchorId, {
        label: subject.label,
        code: likedRead.code,
        detail: likedRead.detail,
        classification: 'retry'
      })
      context.log(`点亮粉丝牌「${subject.label}（房间 ${String(subject.roomId)}）」：${likedRead.detail}`)
      continue
    }

    const liked = likedRead.value

    if (!liked.ok) {
      failures.set(subject.anchorId, {
        label: subject.label,
        code: String(liked.code),
        detail: `点赞被拒绝：${redactSecrets(liked.error, csrf)}`,
        // The same grading the like action gives this same code: only a dead session is account-level.
        classification: liked.code === LikeCode.NotLoggedIn ? 'account_stop' : 'retry'
      })
      context.log(
        `点亮粉丝牌「${subject.label}（房间 ${String(subject.roomId)}）」：点赞被拒绝（code ${String(liked.code)}）`
      )
      continue
    }

    context.log(`点亮粉丝牌「${subject.label}（房间 ${String(subject.roomId)}）」：点赞已发出，回读确认`)
  }

  const confirmed = await confirmRelight(context, http, toLight, failures)
  return medalWalkOutcome(key, subjects, confirmed, failures)
}

/**
 * 回读一次 `is_lighted`，把「已发出」和「已点亮」分开。
 *
 * `code: 0` 不是证据，所以这次读是这条动作唯一的完成判据 —— 还熄着的记**失败**（判重试），因为
 * 一次点赞没能点亮它这件事值得再来一轮。
 *
 * 回读自己失败时，这一轮已经发出去的点赞就都确认不了，于是它们全部记为失败并带上回读的原因：
 * 半份答案不许当成功用，这条理由和「`code: 0` 不算数」是同一条。
 */
async function confirmRelight(
  context: ReconcileContext,
  http: BiliHttp,
  toLight: readonly MedalSubject[],
  failures: Map<number, MedalFailure>
): Promise<ReadonlySet<number>> {
  await sleep(RELIGHT_CONFIRM_DELAY_MS)

  const againRead = await readGraded('点亮后回读', () => fetchMedalPanel(http))
  if (!againRead.ok) {
    context.log(`点亮粉丝牌：回读失败（code ${againRead.code}），这一轮发出的点赞都没能确认`)
    markUnconfirmed(toLight, failures, againRead.code, `点赞已发出、${againRead.detail}`, 'retry')
    return new Set()
  }

  const again = againRead.value
  if (!again.ok) {
    // A dead session is graded here exactly as it is on the first read: a session that died between
    // the write and the confirmation has to fail the task for a re-bind, not retry forever.
    context.log(`点亮粉丝牌：回读被拒绝（code ${String(again.code)}），这一轮发出的点赞都没能确认`)
    markUnconfirmed(
      toLight,
      failures,
      String(again.code),
      `点赞已发出、回读失败：${again.error}`,
      again.code === SendDanmakuCode.NotLoggedIn ? 'account_stop' : 'retry'
    )
    return new Set()
  }

  const confirmed = new Set<number>()
  for (const item of again.data) {
    if (item.medal.is_lighted !== 0) confirmed.add(item.medal.target_id)
  }

  for (const subject of toLight) {
    if (confirmed.has(subject.anchorId) || failures.has(subject.anchorId)) continue
    failures.set(subject.anchorId, {
      label: subject.label,
      code: LocalCode.RelightUnconfirmed,
      detail: '点赞已发出、回读时粉丝牌仍是熄灭',
      classification: 'retry'
    })
  }

  // The one place the other lighting route is ever mentioned, and only to say it is not taken: ten
  // public messages into somebody else's room is a person's decision, not this action's fallback.
  // Said only here because this is the one branch that *knows* those medals are still dark — the two
  // reads that failed above know no such thing and say so instead. See the note on the action.
  const stillDark = toLight.filter(subject => !confirmed.has(subject.anchorId))
  if (stillDark.length > 0) {
    context.log(
      `点亮粉丝牌：这一轮有 ${String(stillDark.length)} 枚仍是熄灭；另一条点亮路线要往那些直播间各发 10 条公开弹幕，本动作不发`
    )
  }

  return confirmed
}

/** 回读失败时，这一轮发出的点赞全部记为「确认不了」，并带上回读的原因与它自己的分级。 */
function markUnconfirmed(
  toLight: readonly MedalSubject[],
  failures: Map<number, MedalFailure>,
  code: string,
  detail: string,
  classification: FailureKind
): void {
  for (const subject of toLight) {
    if (failures.has(subject.anchorId)) continue
    failures.set(subject.anchorId, { label: subject.label, code, detail, classification })
  }
}

/** One medal as this run sees it, before anything has been attempted on it. */
interface MedalSubject {
  /** The row's name in the UI: the anchor's nickname, or a description when there is none. Never an id. */
  readonly label: string
  readonly roomId: number
  readonly anchorId: number
  readonly lit: boolean
  readonly live: boolean
}

/**
 * One medal's refusal, with its name kept alongside.
 *
 * The name is here rather than looked up later for the reason `ActionItem` exists at all: the record's
 * closing clause has to say *which* one failed, and an item's outcome alone cannot.
 */
interface MedalFailure {
  readonly label: string
  readonly code: string
  readonly detail: string
  readonly classification: FailureKind
}

/**
 * One medal's item.
 *
 * `detail` is a **fact**, not a sentence: the row's own label sits beside it and the section above it
 * already says what day this is, so 「已点亮」, 「主播未开播、等开播再点亮」 and the like's own words
 * each say the one thing that happened. The three settled facts are kept short on purpose; a failure
 * keeps its wording, because a rejection is the one case where a person has to read the reason.
 *
 * **「不计亲密度」 is written into the lit one and is not decoration.** Both of a dark medal's rows
 * have an empty `add_text` (measured), so a run that lit twelve medals says nothing whatever about
 * tonight's 亲密度 — and a row reading only 「已点亮」 would let a reader assume it did.
 */
function medalItemOf(
  subject: MedalSubject,
  confirmed: ReadonlySet<number>,
  failure: MedalFailure | undefined
): ActionItem {
  if (failure !== undefined) {
    return { kind: 'room', label: subject.label, outcome: 'failed', detail: failure.detail, code: failure.code }
  }
  if (subject.lit) {
    // Already lit before this run touched anything: a result, not an absence of one.
    return {
      kind: 'room',
      label: subject.label,
      outcome: 'already',
      detail: '已点亮',
      code: LocalCode.MedalAlreadyLit
    }
  }
  if (confirmed.has(subject.anchorId)) {
    return {
      kind: 'room',
      label: subject.label,
      outcome: 'done',
      detail: '已点亮（回读确认）、不计亲密度',
      code: String(SendDanmakuCode.Ok)
    }
  }
  return {
    kind: 'room',
    label: subject.label,
    outcome: 'blocked',
    detail: '主播未开播、等开播再点亮',
    code: LocalCode.MedalRoomOffline
  }
}

/**
 * One whole walk, collapsed into the single record the action log keeps.
 *
 * The order below is the part that matters, and both of its choices are deliberate:
 *
 *  1. **A failure is reported as a failure** (the worst one), however many medals were lit: a refused
 *     like is something broken, and it deserves the event that `failed` raises.
 *  2. **Anything still waiting for an anchor outranks `done`.** `done` settles the day, and a day
 *     settled with 21 medals still dark is a day whose windows are thrown away. That is the other half
 *     of "never `skipped`".
 *  3. Only a walk that left nothing behind is `done`; a walk that found everything already lit is
 *     `already` and parks with `action_stop`, the same way its two neighbours do.
 *
 * The counts are taken **from the items themselves**, so the record's own line cannot disagree with the
 * rows underneath it. The items travel untouched, which is what makes "the record's verdict is one its
 * items recognise" true by construction rather than by assertion.
 */
function medalWalkOutcome(
  actionKey: string,
  subjects: readonly MedalSubject[],
  confirmed: ReadonlySet<number>,
  failures: ReadonlyMap<number, MedalFailure>
): ActionOutcome {
  const items = subjects.map(subject => medalItemOf(subject, confirmed, failures.get(subject.anchorId)))
  const countOf = (outcome: ActionOutcomeValue): number => items.filter(item => item.outcome === outcome).length

  // 「点亮不计亲密度」在这条记录自己的那一行里也说一次：这一行是很多人唯一会读的一行，而点亮这件事
  // 确实一点都不产亲密度（熄灭牌子的两条任务 `add_text` 都是空的），说了才不会被读成「加了」。
  const lit = countOf('done')
  const counts =
    `${lit === 0 ? '点亮 0' : `点亮 ${String(lit)}（不计亲密度）`}、等开播 ${String(countOf('blocked'))}、` +
    `原已点亮 ${String(countOf('already'))}（共 ${String(items.length)} 枚粉丝牌）`

  let worst: MedalFailure | null = null
  for (const failure of failures.values()) {
    if (worst === null || FAILURE_RANK[failure.classification] > FAILURE_RANK[worst.classification]) {
      worst = failure
    }
  }

  if (worst !== null) {
    return {
      actionKey,
      targetKey: TARGET_KEY_ACCOUNT_SCOPED,
      outcome: 'failed',
      code: worst.code,
      detail: `${counts}、失败 ${String(countOf('failed'))}；「${worst.label}」${worst.detail}`,
      failure: worst.classification,
      items
    }
  }
  if (countOf('blocked') > 0) {
    return {
      actionKey,
      targetKey: TARGET_KEY_ACCOUNT_SCOPED,
      outcome: 'blocked',
      code: LocalCode.MedalRoomOffline,
      detail: counts,
      failure: 'none',
      items
    }
  }
  if (countOf('done') > 0) {
    return {
      actionKey,
      targetKey: TARGET_KEY_ACCOUNT_SCOPED,
      outcome: 'done',
      code: String(SendDanmakuCode.Ok),
      detail: counts,
      failure: 'none',
      items
    }
  }
  return {
    actionKey,
    targetKey: TARGET_KEY_ACCOUNT_SCOPED,
    outcome: 'already',
    code: LocalCode.MedalAlreadyLit,
    detail: counts,
    failure: 'action_stop',
    items
  }
}

/* ------------------------------------------------------------------ *
 * The pieces the reconcile loops share
 * ------------------------------------------------------------------ */

/**
 * The room the two per-Room actions hang off, read once per run.
 *
 * `Room/get_info` rather than `room_init`, because it carries both things those two actions need
 * and `room_init` carries only the first: the anchor's uid (the medal panel's `target_id`) and
 * the two area ids the live-trace handshake echoes back inside its `id` field.
 *
 * 点亮粉丝牌 does not read it at all: the account's medal list already carries each room's id, its
 * anchor's uid and its liveness, so a per-room read there would be 24 requests for answers the list
 * already gave (see `reconcileRelightMedal`).
 *
 * `live_status` arrives with it and is deliberately **not** read — whether a live room is
 * required is `requireOnline` on the task, a person's switch rather than this adapter's
 * judgement, and the seam does not hand it over in `ReconcileContext`, so there is nothing here
 * that could enforce it. See each action's own note.
 *
 * A throw is transport, and every caller grades it `retry`: the deadline, a network fault, a
 * payload that no longer parses, or a room `code` that `fetchRoomInfo` flattened into a message.
 * That is the same grading `probe` gives this same endpoint, for the same reason — there is no
 * number left to grade on by the time the failure surfaces.
 */
function readRoom(http: BiliHttp, roomId: number): Promise<RoomInfo> {
  return fetchRoomInfo(http, roomId)
}

/** A read that either produced a value or produced the reason it could not. */
type GradedRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly detail: string }

/**
 * One read, with a transport failure folded into a reportable reason.
 *
 * `BiliHttp` throws for everything that is not a business refusal — a network fault, the deadline,
 * a non-2xx, a payload that no longer parses — and a reconcile run must not lose its whole result
 * to one of those. `probe` and `send` grade exactly this throw `retry`, and `like.ts` says its own
 * transport errors are its caller's to grade; letting one out of `reconcile` would instead lose the
 * run's outcomes — including the other action's work — and leave nothing behind for a person to
 * read. Everything the two actions read goes through here for that reason.
 *
 * Only the request is inside the `try`. A mistake in the grading around it has to surface as a
 * programming error rather than disguise itself as a network blip, which is the lesson `probe`
 * records where its own `try` was narrowed.
 *
 * `secret` is for the one caller whose request body carries a credential — the heartbeat's
 * `benchmark` field is the session key — so that a transport failure, which would otherwise
 * report the response body verbatim, cannot be the path a secret leaks through.
 */
async function readGraded<T>(what: string, work: () => Promise<T>, secret = ''): Promise<GradedRead<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error: unknown) {
    return {
      ok: false,
      code: transportCodeOf(error),
      detail: `${what}失败：${redactSecrets(errorText(error), secret)}`
    }
  }
}

/**
 * The liker's uid, out of the jar.
 *
 * The credential rather than the account row, which is Douyu's precedent spelled out where it
 * happens there: a claim must only ever be made for the session that authenticates it, and the
 * jar's own `DedeUserID` is the account that session belongs to. `roomIdOf` is the seam's rule
 * for "a decimal platform id", so the digits-and-range check has one home instead of a second
 * regex here — `parseInt` alone would read `987654abc` as uid 987654.
 */
function likerUidOf(http: BiliHttp): number | null {
  const raw = http.cookies.userId
  return raw === undefined ? null : roomIdOf(raw.trim())
}

/** The allowed branch of the gate — what the loop needs when the Platform says to act. */
type ReadyGate = Extract<LikeGate, { readonly allowed: true }>

/**
 * One read of the like gate's inputs, in the three shapes the loop cares about.
 *
 * The two reads are made here rather than through `like.ts`'s `preflightLike`, for two reasons
 * that both come from the loop. It needs the **panel itself**, not only a verdict: the reward
 * sentence comes from the task's own `add_text`, and `preflightLike` collapses the panel into a
 * gate that no longer carries it. And it needs the reads' own codes graded — `-101` from the
 * panel is a dead session, where `preflightLike` can only answer `unreadable`. Both reads go
 * through the same exported functions it uses, and the verdict is the same exported pure gate,
 * so nothing about the decision is re-derived here.
 */
type LikeReading =
  | { readonly kind: 'ready'; readonly gate: ReadyGate; readonly task: MedalTask }
  | { readonly kind: 'refused'; readonly refusal: LikeRefusal; readonly detail: string }
  | { readonly kind: 'unreadable'; readonly code: string; readonly detail: string; readonly failure: FailureKind }

async function readLike(http: BiliHttp, csrf: string, roomId: number, anchorId: number): Promise<LikeReading> {
  const panelRead = await readGraded('读取粉丝牌任务', () => fetchMedalTasks(http, csrf, anchorId))
  if (!panelRead.ok) return { kind: 'unreadable', code: panelRead.code, detail: panelRead.detail, failure: 'retry' }
  const panel = panelRead.value

  if (!panel.ok) {
    if (panel.code === SendDanmakuCode.NotLoggedIn) {
      return {
        kind: 'unreadable',
        code: String(panel.code),
        detail: 'B 站登录态已失效，需要重新扫码绑定账号。',
        failure: 'account_stop'
      }
    }
    return {
      kind: 'unreadable',
      code: String(panel.code),
      detail: `读取粉丝牌任务失败：${redactSecrets(panel.error, csrf)}`,
      failure: 'retry'
    }
  }

  const roomRead = await readGraded('读取房间点赞状态', () => fetchRoomLikeInfo(http, roomId))
  if (!roomRead.ok) return { kind: 'unreadable', code: roomRead.code, detail: roomRead.detail, failure: 'retry' }
  const room = roomRead.value

  if (!room.ok) {
    return {
      kind: 'unreadable',
      code: String(room.code),
      detail: `读取房间点赞状态失败：${room.error}`,
      failure: 'retry'
    }
  }

  const task = findMedalTask(panel.data.task_info, MedalJumpType.Like)
  if (task === undefined) {
    // Checked here as well as inside the gate, so that the caller holds a `MedalTask` for its
    // reward clause and nothing has to be invented. Every observation has this row — a lit panel
    // carries five and an unlit one two — so this is a fail-closed branch, not a normal one.
    return { kind: 'refused', refusal: LikeRefusal.Unreadable, detail: `任务表里没有 ${MedalJumpType.Like} 任务` }
  }

  const gate = likeGate({
    // Carried out for reporting only: it has never been observed `true` (see `like.ts`'s header),
    // and refusing on a field that has never appeared would silently disable the action.
    clickBlock: room.data.like_info_v3.click_block,
    lit: panel.data.is_lighted,
    cooldownSeconds: room.data.like_info_v3.cooldown,
    task
  })
  if (!gate.allowed) return { kind: 'refused', refusal: gate.reason, detail: gate.detail }

  return { kind: 'ready', gate, task }
}

/** The live domain's device cookie. Only the viewing handshake needs it. */
const LIVE_BUVID_COOKIE = 'LIVE_BUVID'

/** The room page's origin, used only to make the live domain issue that cookie. */
const LIVE_PAGE_ORIGIN = 'https://live.bilibili.com'

/**
 * The live domain's device cookie, which the heartbeat handshake signs with.
 *
 * It is **not** part of the login credential: `session.ts`'s canonical set is the login cookies
 * plus the two `buvid*` fingerprints, while this one belongs to the live domain and is issued
 * on demand. The reference implementation's login script catches it from a `Set-Cookie` on a
 * live request and appends it to the jar (`ref-bilibili-live-helper/src/scripts/cookies.ts`),
 * and BLTH does the same from a visit to the room page.
 *
 * So: the jar first — the transport absorbs `Set-Cookie` from every response, including the room
 * read this run already made — and one room-page visit only when it is still missing. The page's
 * body is an HTML document and is never parsed; the absorbed cookie is the whole point of the
 * request, and the deadline is the transport's own (`AbortSignal.timeout` on every
 * `BiliHttp.request`), so a page that never answers cannot hold the run.
 *
 * Null means the handshake cannot be formed, and the caller fails closed rather than signing
 * with a made-up value.
 */
async function liveBuvidOf(http: BiliHttp, roomId: number): Promise<string | null> {
  const held = http.cookies.get(LIVE_BUVID_COOKIE)
  if (held !== undefined && held !== '') return held

  await http.request(`${LIVE_PAGE_ORIGIN}/${String(roomId)}`)

  const issued = http.cookies.get(LIVE_BUVID_COOKIE)
  return issued === undefined || issued === '' ? null : issued
}

/**
 * The ceiling on one slice, in seconds.
 *
 * `60` is a decision rather than a measurement, and the reasoning is what matters: a slice should
 * be about **one beat** long, because the server issues `heartbeat_interval` and the whole point of
 * slicing is that the serial sweep keeps moving between slices. 60 s is the cadence this endpoint
 * is expected to issue (it is what both reference implementations and this project's fixtures are
 * written against), so a slice is normally exactly one beat — and since the server owns the number,
 * this is a ceiling rather than a fixed length: a shorter interval fits several beats in, and a
 * longer one is waited out once (see the doc above, where claiming a gap that did not happen is the
 * worse of the two).
 *
 * It bounds **this call's waiting**, and nothing else. How much watching the day has accumulated is
 * the Platform's answer, read from the panel; the day-level ceiling a reader might expect to find
 * here would have to be a counter kept between runs, and a local counter is precisely what
 * `medal.ts` exists to prevent.
 */
const WATCH_SLICE_BUDGET_SECONDS = 60

/**
 * The floor under one heartbeat interval, in milliseconds — and the reason a slice's budget is a bound at all.
 *
 * The slice's own accounting accumulates the **nominal** sleeps, so a service that named
 * `heartbeat_interval: 0.001` would pass every check otherwise in the way (`watch-live.ts` refuses `<= 0`
 * and anything above `MAX_HEARTBEAT_INTERVAL_SECONDS`, and a thousandth of a second is neither) and turn
 * a 60 s slice into 60 000 beats — each one a heartbeat plus a task read-back, roughly 120 000 requests —
 * while the doc above claims "one slice costs at most `WATCH_SLICE_BUDGET_SECONDS`". The sweep is serial,
 * so that is the whole scheduler stopped, not one slow task.
 *
 * One beat per second is a floor rather than a conversion: every interval ever measured here is ~60 s,
 * and nothing has been seen to ask for less. It is the same shape `like.ts` gives its own cadence
 * (`MinIntervalFloorMs`, 350 ms) and for the same reason — a cadence the service owns still needs a local
 * floor under it, or the service owns the request count too.
 */
const WATCH_MIN_HEARTBEAT_MS = 1_000

/** How long to wait before the next heartbeat: the service's own interval, with the floor above under it. */
function beatMsOf(session: WatchSession): number {
  return Math.max(session.heartbeatInterval * 1000, WATCH_MIN_HEARTBEAT_MS)
}

/** The action's label, from the catalogue. Never its key: an item's label is UI text. */
const UNKNOWN_ACTION_LABEL = '未知动作'

function actionLabelOf(actionKey: string): string {
  return ACTIONS.find(descriptor => descriptor.key === actionKey)?.label ?? UNKNOWN_ACTION_LABEL
}

/** 一枚读不到主播名的牌子，在 item 里怎么叫。**不是**房间号，那是标识符。 */
const UNNAMED_ROOM = '未命名直播间'

/** An account-scoped outcome's `targetKey`: empty, which is the seam's own word for "about the account". */
const TARGET_KEY_ACCOUNT_SCOPED = ''

/**
 * Worst-first, so a walk reports the failure that matters most.
 *
 * `none` is not a kind a `MedalFailure` carries; it is here so the table can name every member of
 * `FailureKind` and adding one to that union is a compile error here until it is ranked. Douyu's
 * adapter keeps its own copy of this ranking over its own `ErrorClassification`, for the reason the
 * two adapters keep separate outcome builders: the values are different vocabularies.
 */
const FAILURE_RANK: Readonly<Record<FailureKind, number>> = {
  none: 0,
  retry: 1,
  action_stop: 2,
  account_stop: 3,
  account_restricted: 3
}

/**
 * One room-scoped outcome, and the single item for it.
 *
 * `outcome`, `detail` and `code` are used for the record and for its item, so an item that
 * disagrees with the run it sits in is unrepresentable here rather than merely tested for —
 * `platform/types.ts` calls that disagreement worse than no item at all, and the web's
 * 今日动作 section renders the item, so the two must say the same thing.
 *
 * What it renders is a **fact**, not a sentence: the row carries the action's own name from the
 * catalogue and sits under a heading that already says the day is done, so `detail` reads
 * 「任务已完成（回读确认）」, 「粉丝牌未点亮、观看不计亲密度」 — every number and named thing kept,
 * no connective prose. Failures keep their wording, because a rejection is the one case where a
 * person has to read the reason.
 *
 * Douyu's `accountOutcome` and this file's `accountOutcome` build account-scoped outcomes the same
 * way, and all three are deliberately separate helpers in separate files: the item's `kind` is the
 * only thing that differs, and sharing one would couple two Platform adapters across the seam to
 * save five lines.
 *
 * The two per-Room actions here act on exactly one room each, so one item per outcome is one item
 * per thing acted on — `ActionItem` exists for the runs that touch several, which is what
 * `medalWalkOutcome` (点亮粉丝牌) is for.
 */
function roomOutcome(
  actionKey: string,
  targetKey: string,
  outcome: ActionOutcomeValue,
  detail: string,
  code: string,
  failure: FailureKind
): ActionOutcome {
  return {
    actionKey,
    targetKey,
    outcome,
    detail,
    code,
    failure,
    items: [{ kind: 'room', label: actionLabelOf(actionKey), outcome, detail, code }]
  }
}

/**
 * An outcome that is about the account itself, and the single item for it.
 *
 * The sibling of `roomOutcome` for the one action here that a Room does not identify — 点亮粉丝牌,
 * which finds its own rooms — and for the states a run can reach before it has read any medal at all:
 * an unusable credential, a list that would not parse, a list with nothing in it. Those have no room
 * to name, and an item whose `label` is the action's own name is the honest shape for them (the same
 * shape Douyu's check-ins use).
 *
 * `detail` is a fact rather than a sentence for the same reason it is in `roomOutcome`: the label
 * beside it already names the action. Failures keep their wording — a person has to read the reason.
 */
function accountOutcome(
  actionKey: string,
  outcome: ActionOutcomeValue,
  detail: string,
  code: string,
  failure: FailureKind
): ActionOutcome {
  return {
    actionKey,
    targetKey: TARGET_KEY_ACCOUNT_SCOPED,
    outcome,
    detail,
    code,
    failure,
    items: [{ kind: 'account', label: actionLabelOf(actionKey), outcome, detail, code }]
  }
}

/**
 * 「凭据不能用」这一句话只有一个家。
 *
 * Two shapes use it — a per-Room action's outcome and the account-scoped one's — and a credential
 * problem reads identically in both, so the sentence is written once and handed to whichever builder
 * fits the action. Everything else about those two outcomes differs.
 */
const NO_CREDENTIAL_DETAIL = '账号凭据缺失或无法解析，需要重新扫码绑定。'

/** The account has no usable credential — a state only a person can fix. */
function noCredentialOutcome(actionKey: string, targetKey: string): ActionOutcome {
  return roomOutcome(actionKey, targetKey, 'failed', NO_CREDENTIAL_DETAIL, LocalCode.NoCredential, 'account_stop')
}

/**
 * An action this build cannot run, which is a category of its own.
 *
 * `blocked` rather than `failed` because nothing went wrong — the account, the request and the
 * network are all fine, and the gap is on this side. `runner.ts` raises the 动作受阻 event for
 * this outcome alone, which is how a person finds out that a switch they turned on has nothing
 * behind it.
 *
 * **No item, and this is the only outcome in this file without one.** An item's `label` must
 * never be an identifier, and a key this build cannot name has no catalogue entry to be labelled
 * from — so the record's own sentence, which names the key, stays the whole truth about it.
 * Douyu's adapter answers an unknown key the same way.
 */
function blockedOutcome(actionKey: string, targetKey: string, code: string, detail: string): ActionOutcome {
  return { actionKey, targetKey, outcome: 'blocked', detail, code, failure: 'none', items: [] }
}

/**
 * Every gate refusal, as a person reads it.
 *
 * Keyed by `LikeRefusal`, so adding a member to that table is a compile error here until it has
 * an outcome, a grade and a sentence a person can act on. That property is the point: the
 * alternative is a new refusal falling through to "retry" with nothing said about it.
 *
 * The sentences carry no field names, and the three that report a settled or parked state are
 * facts rather than sentences at all — 「任务已完成」, 「今日点赞次数已用完（额度由服务端按粉丝牌
 * 下发）」, 「粉丝牌未点亮、点赞不计亲密度」. They are the row's own text in the UI, under a label
 * that already names the action and a heading that already says the day is done, so a sentence
 * could only repeat one of the two. The gate's own `detail` names `is_done` and `sub_title`
 * while explaining itself, and that one goes to the console line, where an operator debugging
 * the panel wants it; the refusal's name travels in `code`, which the UI renders only inside
 * its debug section.
 */
const LIKE_REFUSAL_REPORT: Readonly<
  Record<LikeRefusal, { readonly outcome: ActionOutcomeValue; readonly failure: FailureKind; readonly detail: string }>
> = {
  [LikeRefusal.NotLoggedIn]: {
    outcome: 'failed',
    failure: 'account_stop',
    detail: '账号登录态不可用（写请求所需的 CSRF cookie 不在凭据里），需要重新扫码绑定。'
  },
  [LikeRefusal.Unreadable]: {
    outcome: 'failed',
    failure: 'retry',
    detail: '点赞任务的状态读不出来，这一轮没有动手；等下一次运行再判。'
  },
  [LikeRefusal.MedalNotLit]: {
    outcome: 'blocked',
    failure: 'none',
    detail: '粉丝牌未点亮、点赞不计亲密度'
  },
  [LikeRefusal.TaskDone]: {
    outcome: 'already',
    failure: 'action_stop',
    detail: '任务已完成'
  },
  [LikeRefusal.LimitReached]: {
    outcome: 'already',
    failure: 'action_stop',
    detail: '今日点赞次数已用完（额度由服务端按粉丝牌下发）'
  }
}

/** One gate refusal as this run reports it. `work` is what already happened, or nothing. */
function likeRefusalOutcome(actionKey: string, targetKey: string, refusal: LikeRefusal, work = ''): ActionOutcome {
  const report = LIKE_REFUSAL_REPORT[refusal]
  return roomOutcome(actionKey, targetKey, report.outcome, `${work}${report.detail}`, refusal, report.failure)
}

/**
 * The same refusal, in the account-scoped shape.
 *
 * 点亮粉丝牌 writes as little as the like action does, so it asks the same question — is there a
 * CSRF cookie to sign with — and must say the same thing when there is not. Only the item's `kind`
 * differs, and the sentence is taken from the table above rather than restated, so the two cannot
 * drift into describing one state two ways.
 */
function likeRefusalAccountOutcome(actionKey: string, refusal: LikeRefusal): ActionOutcome {
  const report = LIKE_REFUSAL_REPORT[refusal]
  return accountOutcome(actionKey, report.outcome, report.detail, refusal, report.failure)
}

/**
 * The gate's own sentence, on the console.
 *
 * It names panel fields, which is what an operator wants and what a sentence the UI renders must
 * not carry; the record keeps the readable version, and both are written down for the same run.
 */
function logRefusal(context: ReconcileContext, refusal: LikeRefusal, detail: string): void {
  context.log(`点赞未动手（${refusal}）：${detail}`)
}

/**
 * How much was sent, as a lead-in a row can start with — empty when nothing was sent.
 *
 * The separator is part of the clause, and it is `、` rather than `，`: what follows it is a
 * fact (「任务已完成（回读确认）」, 「粉丝牌收益 亲密度+1」) and not the next clause of a sentence.
 * The empty case has to come back empty, so the join cannot move to the callers.
 */
function clickProgressOf(rounds: number, clicks: number): string {
  return rounds === 0 ? '' : `已发出 ${String(rounds)} 轮共 ${String(clicks)} 次点赞、`
}

/** What the panel says the task pays, or nothing at all when it named no reward. */
function rewardClauseOf(addText: string): string {
  return addText === '' ? '' : `、粉丝牌收益 ${addText}`
}

/**
 * Session renewal.
 *
 * Almost all of it is `bilibili/refresh.ts`, which knows to ask the server whether
 * anything is due before exchanging anything. This adapter adds the blob boundary —
 * a jar in, a blob out — and one judgement: because the caller persists whatever
 * comes back, "the server refreshed and nothing changed" is reported as
 * `not_required` rather than as a write.
 *
 * `refreshIfRequired` already converts its own network failures into `failed`, so
 * every path here returns a result; none of them throws.
 */
async function refresh(account: PlatformAccount): Promise<RefreshResult> {
  const credential = parseCredential(account.credentials)
  if (credential === null) {
    return { status: 'relogin_required', detail: '账号凭据缺失或无法解析，需要重新扫码绑定' }
  }

  const http = clientFor(credential)
  const csrf = http.cookies.csrfToken
  if (csrf === undefined) {
    // Renewal is a write, and every write echoes the CSRF cookie; without it the
    // attempt could only be rejected, so it is not attempted. The sentence is
    // deliberately not `MISSING_CSRF`: a jar can hold a live session that simply
    // cannot be renewed, and "not logged in" would misdescribe that.
    return { status: 'relogin_required', detail: '账号凭据缺少 bili_jct，无法续期，需要重新扫码绑定' }
  }

  const outcome = await refreshIfRequired(http, csrf, credential.refreshToken)

  switch (outcome.status) {
    case 'not_required':
      return { status: 'not_required', detail: '服务端未要求续期' }
    case 'relogin_required':
      return { status: 'relogin_required', detail: outcome.reason }
    case 'failed':
      return { status: 'failed', detail: outcome.reason }
    case 'refreshed': {
      // The transport absorbed the response's `Set-Cookie` headers, so the jar is
      // the new session.
      const renewed = http.cookies.toJSON()
      if (cookiesEqual(credential.cookies, renewed)) {
        return { status: 'not_required', detail: '服务端已处理续期，但凭据没有变化' }
      }
      return {
        status: 'refreshed',
        detail: '会话已续期',
        credentials: serializeCredential(renewed, outcome.credential.acTimeValue)
      }
    }
  }
}

/**
 * Every failing probe result is built here, so the fields cannot drift apart.
 *
 * `liveStatus` is the seam's offline value rather than the last known one: a failed
 * probe did not learn whether the stream is up, and `ok: false` is what tells the
 * caller not to read it. Reporting anything else would be the same invention as the
 * substring match.
 */
function probeFailure(code: string, detail: string, failure: FailureKind): ProbeResult {
  return { ok: false, liveStatus: LIVE_STATUS_OFFLINE, title: '', code, detail, failure }
}

function sendFailure(code: string, detail: string, failure: FailureKind): SendOutcome {
  return { ok: false, code, detail, failure }
}

/**
 * The code for a failure Bilibili never numbered.
 *
 * A `BiliHttpError` carries a status and that is structured data in its own right:
 * 412 is risk control, 0 is a network fault, a timeout, or an answer that could not be read as a room,
 * 5xx is upstream. None of them is worth giving up over, so they share one code path instead of pretending
 * to be Bilibili codes.
 */
function transportCodeOf(error: unknown): string {
  return error instanceof BiliHttpError && error.status > 0 ? `http_${String(error.status)}` : LocalCode.Transport
}

/** A failure's message, for a person. Never carries credentials — see `session.ts`. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Bilibili's live host, subdomains included. */
const LIVE_HOST = /(^|\.)live\.bilibili\.com$/i

/**
 * The short-link host, whose paths name nothing this build reads.
 *
 * Listed by name rather than allowed through only to fail later on the segment, because the two refusals
 * are different sentences: 「this is a shortcut」 and 「no room number is in this」.
 */
const SHORT_LINK_HOST = /(^|\.)b23\.tv$/i

/**
 * The one path prefix a live-room URL puts in front of a room number.
 *
 * `live.bilibili.com/blanc/<id>` is a **real, openable room URL** — checked against the live page, not
 * inferred — and it is the only prefixed shape this parser reads. That is the bound, and it has three
 * parts: the host must be the live one, the prefix must be this literal, and the path must end there —
 * `blanc`, one all-digits segment, nothing after it.
 *
 * **Why not a scan.** Reading any numeric segment after any prefix would turn `/p/22637261` or an activity
 * path's own number into a room nobody asked for, and a wrong link resolving to a *different* room than the
 * person meant is worse than refusing it — the task would then run against somebody else's room. A second
 * prefix belongs in this list the day its own link has been opened.
 */
const ROOM_PATH_PREFIX = 'blanc'

/**
 * What a pasted string is, as far as its shape can tell — the three answers `resolveTarget` needs before
 * it asks Bilibili anything.
 *
 * A bare `number | null` cannot carry these: the two refusals are different sentences (a shortcut versus
 * no room in the link at all), and the route above separates them because a person's next move differs.
 */
type RoomPaste =
  | { readonly kind: 'room'; readonly id: number }
  | { readonly kind: 'short_link' }
  | { readonly kind: 'other' }

/**
 * Reads what a person pasted: a room URL, a bare room number, a short link, or neither.
 *
 * Four shapes are accepted, because they are what a browser bar and the address the live page shows
 * produce: `https://live.bilibili.com/22637261?x=1`, `https://live.bilibili.com/blanc/22637261`, the
 * scheme-less `live.bilibili.com/22637261`, and a bare `22637261`. The host allowlist is what stops an
 * arbitrary link from being read as a room, and it is the reason `short_link` is its own answer rather
 * than `other`: **the b23.tv class is refused, and deliberately not resolved.** What a short link points
 * at is only knowable by opening it, and this build does not open links — and whether a live room even has
 * one is unproven, so the sentence for it may not claim that it does.
 */
function parseRoomPaste(input: string): RoomPaste {
  const trimmed = input.trim()
  if (trimmed === '') return { kind: 'other' }

  const bare = roomIdOf(trimmed)
  if (bare !== null) return { kind: 'room', id: bare }

  // Prefixing a scheme lets the scheme-less and the full form share one parse path;
  // the guard is here so input that already carries one is not mangled into
  // `https://https://…`.
  const candidate = /^[a-z0-9][a-z0-9.-]*\//i.test(trimmed) ? `https://${trimmed}` : trimmed

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { kind: 'other' }
  }

  if (SHORT_LINK_HOST.test(parsed.hostname)) return { kind: 'short_link' }
  if (!LIVE_HOST.test(parsed.hostname)) return { kind: 'other' }

  const segments = parsed.pathname.split('/').filter(part => part !== '')
  const [head, second] = segments
  if (head === undefined) return { kind: 'other' }

  // The root shape, untouched: the first segment names the room, and the same digits rule a bare id goes
  // through decides whether it does.
  if (head !== ROOM_PATH_PREFIX) {
    const id = roomIdOf(head)
    return id === null ? { kind: 'other' } : { kind: 'room', id }
  }

  // The one prefixed shape, and **only in the form that was verified**: `blanc`, then a room number, and
  // nothing after it. A third segment is not a room URL this build has seen, and reading the second one
  // anyway would resolve a link that is about something else into somebody's room — the price of reading
  // one segment too far, and the reason the widening stops here rather than scanning the path.
  if (segments.length !== 2) return { kind: 'other' }
  const id = roomIdOf(second ?? '')
  return id === null ? { kind: 'other' } : { kind: 'room', id }
}

/**
 * 「I understand that shape, and there is no such room」, with the number they typed left in it.
 *
 * The number is the one identifier this sentence may carry, because it is the one they typed: it is how
 * they check what they pasted. `RoomInitCode.RoomNotFound` is what established it.
 */
function missingRoomDetail(shortId: number): string {
  return `B 站没有房间号 ${String(shortId)} 对应的直播间，请核对一下房间号或链接里的数字。`
}

/**
 * 「That shape is not one this Platform reads a room out of」 — the sentence it has always been.
 *
 * Kept verbatim, and it is a *different* sentence from `missingRoomDetail` on purpose: one of them says
 * the paste is not a room reference at all, the other says the reference is fine and there is no such
 * room, and a person who is shown one of them for the other goes looking in the wrong place. Neither
 * names an internal call.
 */
const UNREADABLE_INPUT_DETAIL = '无法从该链接解析出直播间号'

/**
 * 「That is a short link」 — the other sentence, and the one that may not overclaim.
 *
 * It says what this build does not do (open the link) and what the person can do instead, and it does
 * **not** say that the shortcut points at a live room. The reference short-link documentation
 * (`bilibili-API-collect`'s `docs/misc/b23tv.md`) lists formats for 任意/av/BV links, and its 直播 row is
 * commented out there as 失效 — so whether a live room has a short link at all is unproven, while *that the
 * class is refused* is the fact this sentence is about. A person who pasted a video shortcut is told the
 * same true thing, and pasting the URL it opens gets them the answer about that URL.
 */
const SHORT_LINK_DETAIL =
  '这是 b23.tv 短链：它指向哪个直播间只有打开它才知道，本版不打开短链；请粘贴它跳转到的 live.bilibili.com 直播间链接，或直接填直播间号。'

/**
 * 「The label is a 标题 because no account travelled」 — the note `resolveTarget` attaches, and the one the
 * owner asked for by name (「如果没绑需要写明提示并回退」).
 *
 * It exists because the *read* needs an account and the *label* does not show it: `getInfoByRoom` answers a
 * cookie-less caller `code: -352` with no `data`, so without an account the only name-less read left is
 * `get_info`'s 标题 — measured 2026-10-09 for room 14709735, one cookie set per call, the table beside
 * `bilibili/credential.ts`'s `credentialToSessionCookies`. The sentence names the cause rather than the
 * current display, because what the page draws under it — the 标题, or 「目标 <room id>」 when that failed
 * too — is the page's own decision and a second sentence claiming it would be this one going stale.
 */
const NO_ACCOUNT_TITLE_NOTE = '未选择账号，读不到主播名：B 站只在请求带上账号的登录 cookie 时才给出这个字段'

/**
 * 「An account travelled and the name still did not arrive」 — the other cause, in as few words as it takes.
 *
 * A name is one call away from being unavailable for reasons that have nothing to do with the person
 * (a `19002000`, a risk-control refusal, a deadline), and none of them is a missing account — so this is
 * deliberately *not* a variant of the sentence above. What it must not do is say a room "has no name":
 * nothing here establishes that, and a room whose name this build could not read is a different fact from
 * a room reporting none.
 */
const NAME_UNREAD_TITLE_NOTE = '没读到主播名'

export const bilibiliPlatform: Platform = {
  /** The exact string the `accounts` and `tasks` rows carry; see `db/migrations.ts`. */
  key: 'bilibili',
  label: 'B 站',
  actions: ACTIONS,

  resolveTarget,
  probe,
  send,
  reconcile,
  refresh
}
