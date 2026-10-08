import { setTimeout as sleep } from 'node:timers/promises'

import { z } from 'zod'

import { ActionKey, TaskAction } from '../../repo/tasks.js'
// One home for "take this credential out of the sentence", imported rather than copied: the local
// `withoutSecrets` here and the one in `passport.ts` were two of the five copies of this rule, and
// the copies drifted (`douyu/errors.ts` records the exchange where the URL was scrubbed and the
// sentence built from it was not). The reasoning, and the review-unit judgement it overrides, is at
// the top of `platform/bilibili/index.ts`.
import { redactSecrets } from '../../text/redact.js'
import { roomIdOf } from '../room.js'
import { DAY_TIME_ZONE, withinLocalWindow } from '../time.js'
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
import {
  ACCOUNT_STOP_CODES,
  ACTIVITY_ALREADY_SIGNED,
  CLIENT_SIGN_ALREADY_SIGNED,
  classifyError,
  type DouyuFailure,
  DouyuProtocolError,
  type DouyuResult,
  DouyuTransportError,
  type ErrorClassification
} from './errors.js'
// The renewal, and the only import this module takes from the flow it shares a directory with.
// There is a cycle here — `passport.ts` reads this module's parser and this module's session-cookie
// name — and it is deliberate: both sides use each other's exports *inside functions*, never at
// module scope, so neither is ever evaluated against a half-initialised other. The alternative is a
// third module owning the blob contract, which is a bigger move than the one exchange below needs.
import { NO_SESSION_TO_RENEW, renewFamily } from './passport.js'
import {
  ACTIVITY_NOT_LOGGED_IN,
  castFishingLine,
  claimFishBall,
  clockGrowthPool,
  donateGift,
  FANSHOME_ALREADY_SIGNED,
  FANSHOME_CSRF_COOKIE,
  FANSHOME_CSRF_REFUSED_STATUS,
  type FanBadgeList,
  FISH_BALL_ALREADY_CLAIMED,
  FISHING_BAIT_EXHAUSTED,
  FISHING_BAIT_PER_CAST,
  FISHING_FISH_ON_THE_LINE,
  FISHING_STAT_CAST,
  FISHING_STAT_IDLE,
  FISHING_STAT_READY,
  type FishingBait,
  type FishingCast,
  type FishingCodexEntry,
  type FishingMatchInfo,
  type FishingPanel,
  type FishingReelIn,
  type FishingState,
  fetchCsrfCookie,
  type GiftCharge,
  GROWTH_POOL_CSRF_REJECTED,
  GROWTH_POOL_NOT_ENOUGH_FISH_BALLS,
  GROWTH_POOL_TOKEN_REJECTED,
  type GrowthPoolJoin,
  joinGrowthPool,
  listFollowedGroups,
  OPFOY_SIGN_ALIAS,
  type PropItem,
  ROOM_TASK_ANY_GIFT,
  ROOM_TASK_DANMAKU,
  ROOM_TASK_NAMED_GIFT,
  type RoomDailyTask,
  readActivitySignStatus,
  readFanBadges,
  readFishBallBalance,
  readFishingChips,
  readFishingCodex,
  readFishingPanel,
  readGiftBackpack,
  readGrowthPoolStatus,
  readRoomDailyTasks,
  reelInFishingLine,
  sendClientSign,
  signActivity,
  signFansHome,
  signGroupAndroid,
  YUBA_ALREADY_SIGNED,
  type YubaGroup
} from './protocol.js'
import { DANMAKU_CONTENT_RULE, DANMAKU_RATE_LIMITED, type DanmakuSession, sendDanmaku } from './socket.js'

/**
 * Douyu, behind the Platform seam.
 *
 * The protocol is already written, and this adapter re-derives none of it.
 * `protocol.ts` owns the six HTTP families and their three verdict dialects — plus the one
 * endpoint that answers HTML — `socket.ts` owns the STT frame codec and the one danmaku
 * connection, and `errors.ts` owns the global code table. What sits *here* is only what the
 * seam needs and nothing else previously knew:
 *
 *  - the credential blob's shape, and how it becomes a `DanmakuSession`,
 *  - Douyu's own liveness encoding, normalised to 1/0,
 *  - the one read the protocol layer does not cover — room metadata — which is
 *    what both `resolveTarget` and `probe` are made of,
 *  - and the reason the seam exists at all: which code means stop the account,
 *    which means park until tomorrow, and which means try again.
 *
 * Three rules hold everywhere in this file.
 *
 * **A code is graded on its number, never on a substring of a message.** Douyu
 * reuses small integers across families that mean different things by them —
 * `-1` is "already claimed today" on `sendFishBall` and nothing of the sort
 * anywhere else — so the number *together with the endpoint that produced it* is
 * the only thing that decides, and `detail` is prose for a person that nothing
 * here ever reads back.
 *
 * **No message, frame or URL built here is logged.** The composite token is the
 * account credential, it travels in `apiv2` query strings, and `loginreq` carries
 * it beside the device id. `errors.ts` redacts the two error classes; nothing else
 * may put one in a string.
 *
 * **A call that never reached Douyu is graded here, not thrown past the seam.**
 * `protocol.ts` throws for everything that is not a Douyu verdict — a network fault,
 * the deadline, a non-2xx, a body that is not JSON — and that is the right split for a
 * module that can only speak HTTP. This layer is the one that knows what to do about it,
 * and `types.ts` requires it: a throw out of `reconcile` discards the whole run's
 * outcomes, including the action that had already finished, and leaves no row for a
 * person to read. So every call an action makes goes through `callGraded` at the foot of
 * this file, which turns that throw into **that action's own** `failed`/`retry` outcome
 * while the other enabled actions carry on — the same grading `probe` and `send` already
 * give a transport failure, and the same one the seam names.
 */

/* ------------------------------------------------------------------ *
 * The action catalogue
 * ------------------------------------------------------------------ */

/**
 * The catalogue, and the two measurements that shaped it.
 *
 * `maxMessageLength: 70` is the **character** cap, not a byte cap, and exceeding
 * it is a **silent truncation rather than a rejection**: 80 Chinese characters
 * (240 bytes) and 80 Latin characters (80 bytes) both answered `res=0` and both
 * arrived at the room as 70 characters — a threefold byte difference cutting at
 * the same place, so the unit is characters. The server says nothing is wrong, so
 * a longer bullet is not an error a caller can see; it is 70 characters of the
 * text the sender thought it sent. **§2.7.**
 *
 * `defaultIntervalSeconds: 3` sits above a floor of roughly 2 s that was measured,
 * not derived: 1664 ms and 1561 ms gaps were refused with `res=290`, while 2061 ms
 * and 3063 ms passed, and the boundary between them was not bisected. Three
 * seconds is the safe side of a boundary that is only known to two significant
 * figures. **§2.7.**
 */
const ACTIONS: readonly ActionDescriptor[] = [
  {
    key: ActionKey.SendDanmaku,
    action: TaskAction.Send,
    label: '发送弹幕',
    description: '按间隔把文本库里的弹幕一条条发进直播间，发完一轮后从头循环；超过 70 个字符的部分会被服务端静默截断。',
    /** Free; only Douyu's own cadence limit notices it. */
    costly: false,
    needsTarget: true,
    needsLibrary: true,
    /** Characters, and a truncation rather than a refusal. See the note above. */
    maxMessageLength: 70,
    /** Comfortably above the measured ~2 s floor. See the note above. */
    defaultIntervalSeconds: 3,
    /**
     * The measured floor is ~2 s and was not bisected: 1664 ms and 1561 ms were
     * refused with `res=290`, while 2061 ms and 3063 ms passed. So the floor is the
     * slowest *verified* gap rather than the midpoint of the unverified one — 2 s
     * might work, but only 3 s is known to.
     */
    minIntervalSeconds: 3
  },
  {
    key: ActionKey.SignIn,
    action: TaskAction.Reconcile,
    label: '客户端签到',
    description: '斗鱼客户端的每日签到，服务端返回连续签到天数与本次经验。',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300,
    /**
     * The reconcile chores are daily and idempotent — an already-done action is a
     * cheap read that reports as much — so a tighter cadence buys nothing and only
     * adds requests against a Platform that rate-limits.
     */
    minIntervalSeconds: 60
  },
  {
    key: ActionKey.Fishball,
    action: TaskAction.Reconcile,
    label: '看广告鱼丸',
    description: '看广告领鱼丸，每天一次；领取前先读一次余额。',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300,
    /**
     * The reconcile chores are daily and idempotent — an already-done action is a
     * cheap read that reports as much — so a tighter cadence buys nothing and only
     * adds requests against a Platform that rate-limits.
     */
    minIntervalSeconds: 60
  },
  {
    key: ActionKey.YubaSign,
    action: TaskAction.Reconcile,
    label: '鱼吧签到',
    description: '给已关注的每个鱼吧签到，逐个进行；「今天已经签到过」按成功处理。',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300,
    /**
     * The reconcile chores are daily and idempotent — an already-done action is a
     * cheap read that reports as much — so a tighter cadence buys nothing and only
     * adds requests against a Platform that rate-limits.
     */
    minIntervalSeconds: 60
  },
  {
    key: ActionKey.ActivitySign,
    action: TaskAction.Reconcile,
    label: '任务中心签到',
    /**
     * Names the activity as a person meets it, and says what it pays.
     *
     * The label is the activity's own name for itself — the 斗鱼 **任务中心** page it runs
     * on — because a switch is read by someone who has seen that page and not this
     * project's vocabulary. 「活动签到」 was this project's word for a category, and it is
     * a category other activities would join, so it said less while sounding broader.
     *
     * **The figures are the activity's own config** (第 1–6 天 20、第 7 天 20+30), kept
     * because this sentence is what a person reads *before* deciding whether to switch
     * the action on, and a rule without its numbers answers nothing. That is exactly
     * what separates it from a run's `detail`: the sign response carries no award — the
     * captured `31200` body answers `data: {}` — and the 20 积分 that does land is a
     * ledger entry in `redeemPoints/pointRecord`, a read this action does not make. So a
     * detail naming a figure would be inventing one, while a description repeating the
     * activity's published rule is reporting it.
     *
     * Nothing here reads that config, so a change on Douyu's side leaves this text
     * quietly stale. That is the price of telling a person what they are switching on.
     *
     * The `signAlias` is deliberately not in it: an identifier nobody can read does not
     * belong in the one sentence read before deciding. It travels in the item's `code`.
     */
    description:
      '斗鱼任务中心的每日签到，每天一次、记 20 活动积分（连签第 7 天另加 30），积分可在任务中心兑现金或京东卡，不发鱼丸、不发礼物。',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300,
    /**
     * The reconcile chores are daily and idempotent — an already-done action is a
     * cheap read that reports as much — so a tighter cadence buys nothing and only
     * adds requests against a Platform that rate-limits.
     */
    minIntervalSeconds: 60
  },
  {
    key: ActionKey.GrowthPool,
    action: TaskAction.Reconcile,
    label: '打卡分鱼丸',
    description:
      '打卡分鱼丸：报名立即扣 200 鱼丸，次日 19:00–21:00 打卡后与所有打了卡的人瓜分奖池；不打卡就算弃权，那 200 鱼丸不退——所以报名和打卡两半都要做。',
    /**
     * The only costly action in the catalogue: entering the pool **spends 200
     * 鱼丸**, and 鱼丸 is an account balance rather than a generated token, so a
     * wrong run is not recoverable. `types.ts` documents what `costly` is for —
     * the action defaults to off and the UI says why — and `repo/action-settings.ts`
     * implements the other half: absence of a row means off, so a costly action
     * ships dark and can only ever run because a person turned it on.
     */
    costly: true,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300,
    /** Same reasoning as the other reconcile chores: daily, idempotent, no benefit to hurrying. */
    minIntervalSeconds: 60
  },
  {
    key: ActionKey.FanshomeSign,
    action: TaskAction.Reconcile,
    label: '粉丝家园签到',
    /**
     * Says what it does, what "already" means, and the one thing a person has to supply.
     *
     * The web session is in the sentence on purpose: it is the only action here that needs
     * one, it is invisible in the task form, and the state without it is `blocked` — so
     * whoever switches this on should already know that a re-bind is what a blocked day
     * would be asking for. Nothing is said about what a sign pays: for this endpoint there
     * is no evidence either way, and a number invented here would be the one thing a person
     * reads *before* deciding.
     */
    description:
      '粉丝家园的每日签到：给每个持有粉丝牌的房间各签一次，一次一个请求；「今日已签到」算成功，次日继续。它要用账号的网页会话（只有走网页流程的扫码绑定会存下这一份），没有会话时不会发出任何请求、只报「受阻」。',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300,
    /** Same reasoning as the other reconcile chores: daily, idempotent, no benefit to hurrying. */
    minIntervalSeconds: 60
  },
  {
    key: ActionKey.IntimacyTasks,
    action: TaskAction.Reconcile,
    label: '亲密度任务',
    /**
     * The one sentence a person reads *before* switching this on, and it has to carry four facts they
     * cannot get from anywhere else: this action does **not** send the danmaku (发弹幕 belongs to
     * 发送弹幕), one of the three daily tasks asks for a **paid** gift and is never done here, the
     * gifting half sends **only** what a person ticked on 「允许使用的礼物」, and it stops at the number
     * the server's own counter still wants.
     *
     * It says what a run reports rather than promising an effect, which is the whole difference
     * between this description and a switch that looks like it works.
     */
    description:
      '读这个直播间的每日亲密度任务，按服务端报的进度结算：「发送1条弹幕」那条由「发送弹幕」完成，这里只记录、不另发一条；「送出“全力守护”礼物」是付费礼物，这条动作永不代做；「赠送礼物」只送「允许使用的礼物」清单里勾选、且账号里真有的礼物，一次送一件，送满服务端还差的件数就停手，每送一件都按服务端的回包报出送了什么、送给了谁、有没有扣费；没有勾选任何礼物时一件都不送。',
    /**
     * **Costly, and this field's own expiry has arrived.**
     *
     * It read `false` while the gifting half was unwritten — a run read one room's task list and sent
     * nothing — and it said then that the day the gifting half landed, this is the field to revisit.
     * That day is this one: a run can now hand a gift to an anchor in public, where it cannot be taken
     * back, so the action spends and has to sit behind the switch that keeps a spender dark
     * (`repo/action-settings.ts`: absence of a row means off).
     *
     * **The allowlist is deliberately not an exemption from that.** It is the owner's own declaration
     * of *which* items may be spent — an account's backpack holds items the Platform charges for, and no
     * first-party flag separates them — while `costly` is the switch that decides whether anything is
     * spent at all. A list that carried the flag with it would turn a person's checklist into consent to
     * run unattended.
     */
    costly: true,
    /** Per Room: these tasks hang off one anchor's 粉丝牌, and `userTaskList` is read with a `rid`. */
    needsTarget: true,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300,
    /** Same reasoning as the other reconcile chores: daily, idempotent, no benefit to hurrying. */
    minIntervalSeconds: 60
  },
  {
    key: ActionKey.Fishing,
    action: TaskAction.Reconcile,
    label: '粉丝家园钓鱼',
    /**
     * The one sentence read *before* switching this on, and it has to carry five facts: what a round
     * is, what it spends, what the service's window does and does not decide, what a person must have
     * set up first, and **where the value actually is**.
     *
     * **That last one is the owner's own account rather than a capture**, and it is the reason the
     * sentence is not "钓到鱼": his experience is that 陪伴印章 is worth what a 荧光棒's intimacy is
     * worth, that it comes out of the codex and out of the lottery, and therefore that a cast which
     * pays nothing is still not a wasted cast. The capture agrees with the half of that it can — the
     * one observed `reelIn` answered `awards: []`, so nothing per cast is promised — and says nothing
     * either way about the codex or the lottery. What is measurable is in the description; what is
     * his is stated as a claim about the activity rather than as a reading.
     *
     * **The two preconditions are in it because they are the states that end the run**, and both are
     * set in 粉丝家园's own interface rather than here: an 形象, and a bait marked in use. Neither is
     * a field of this task — there is no endpoint in this repo that sets either — so the sentence a
     * person reads before flipping the switch is the only place they can learn it.
     *
     * **「钓几次」 is a per-day count, and that is a consequence worth stating.** A round that reels a
     * fish in ends `done`, and `runner.ts` reads `done` as the day's obligation being met for this
     * action, so the field is "how many casts today" rather than "how many per sweep". That is also
     * what keeps a costly action from grinding an account's whole stock in one afternoon.
     */
    description:
      '粉丝家园钓鱼：一轮是「抛竿 → 等服务端报的收竿时刻 → 收竿」，按「钓几次」重复。一竿消耗 20 枚在用的鱼饵（抓包实测），没有鱼饵就停手；能不能钓由服务端自己说了算——服务端逐场下发的那个窗口（抓包见过 12:00–24:00、18:00–19:00 与 19:00–19:30 三种）只用来告诉你什么时候回来收敛，实测那一竿在 18:00 那场开窗前 614 秒抛出，服务端回 error:0、鱼饵照扣、收竿后亲密度 +1。开始前要先在粉丝家园里设置好形象、并选中一枚鱼饵，缺哪样就只报「受阻」。它值钱的地方不在鱼身上：单竿可能什么都不给（抓包那一次收竿的 awards 是空的），而图鉴每收录一个新鱼种就是往前走了一步；陪伴印章要另外用抽奖积分去换，那是另一个动作的事，这个动作只把积分读出来、不替你花。跑完一轮就算当天做完，所以「钓几次」填的是今天钓几竿。',
    /**
     * **Costly, and it is the second action here that is.** A cast spends 20 bait out of a stock an
     * account holds a few hundred of, so a run that is right about everything still spends something
     * that cannot be earned back — and the flag is what keeps the action dark until a person turns it
     * on (`repo/action-settings.ts`: absence of a row means off).
     */
    costly: true,
    /** Per Room: `homePage` is read with a `rid`, and `myCh.rid` is that same room. */
    needsTarget: true,
    needsLibrary: false,
    maxMessageLength: 0,
    /**
     * 300 s rather than 60: one full round is a cast, a wait of about `timePerRod` (60 s, measured)
     * and a reel-in, so a tighter cadence would only schedule runs whose predecessor cannot have
     * finished.
     */
    defaultIntervalSeconds: 300,
    minIntervalSeconds: 60
  },
  {
    key: ActionKey.Clearout,
    action: TaskAction.Reconcile,
    label: '送出即将过期的免费道具',
    /**
     * The one sentence read *before* switching this on, and it has to carry five facts a person cannot
     * get from anywhere else: this spends free 道具 by **sending them to one room as gifts** (public and
     * not un-sendable), **which** items may go is a list he writes himself, **where** they go is a room
     * he picks from the ones he follows, it only ever fires in the last 24 hours before an item expires,
     * and **it holds back what 亲密度任务's gifting half still needs** — the last one because the coupling
     * is invisible from the outside and the next reader would otherwise delete it as redundant.
     *
     * It also says what it does *not* do about the two things a person is most likely to assume: 唯一
     * 收件房间 is one room and not every room, and it never touches 付费 gift ids (it cannot: it sends
     * through `prop/donate`, where an item must come from the backpack).
     *
     * **The window is stated as a fact and not offered as a field**, and that is the design's own
     * wording: a window a person can fill in wrong is not a good parameter, and one that is wrong in
     * either direction loses items.
     */
    description:
      '把账号里即将过期的免费道具（背包里的道具，例如粉丝荧光棒）送进一个你指定的直播间，一天里临近到期才动手：只送「允许使用的道具」清单里勾选、账号里真有的那些，只送「到期时刻在 24 小时内」的那些，最快的先送，一件一个请求，每送一件都按服务端的回包报出送了什么、送给了谁、有没有扣费。它是账号级动作：收件房间来自偏好设置里的「默认倾泻直播间」，不来自任务的目标。它每次动手前都会先读一遍持有粉丝牌的每个直播间今天还差几件礼物，把那么多件留给你「亲密度任务」的送礼那一半（续牌要用），只倒多出来的部分——所以它倒的会比背包里的总数少，这是有意的，不是漏了。清单里的道具没勾选时它一件都不送；清单里的道具一件都没有时它只报一句，不挑一件代替。',
    /**
     * **Costly, and for the same reason 亲密度任务 is.** Every item this action sends is a gift in a
     * public room that cannot be taken back, and the only thing between a wrong run and an unearned
     * donation is the switch a person has to turn on (`repo/action-settings.ts`: absence of a row means
     * off). `costly` is that switch; the allowlist is *which* items may be spent, which is a different
     * question and deliberately not an exemption from this one.
     */
    costly: true,
    /**
     * Account-scoped: the room the items go to is `默认倾泻直播间` in the action's own options, not the
     * Task's target — which is also what makes the app's known `ChoiceSource` gap (a source is handed an
     * account id and nothing else) harmless here, because both reads behind this action's fields are
     * account-level: the rooms an account follows, and the medals it holds.
     */
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    /** Same reasoning as the other reconcile chores: daily, idempotent, no benefit to hurrying. */
    defaultIntervalSeconds: 300,
    minIntervalSeconds: 60
  }
]

/**
 * Codes for states Douyu never numbers.
 *
 * Each one is a state this build determined for itself rather than a response: the
 * scheduler displays whatever is here next to the outcome, so it has to say something a
 * person can act on. `unknown_action` exists so that "we do not recognise this" cannot be
 * mistaken for either a Douyu refusal or a transport fault, and `window_not_open` so that
 * 打卡分鱼丸's wait — a window that is **this project's own clock**, not a response — is not read as a
 * verdict from the Platform. 钓鱼 used to share that name and no longer does: its window is reported
 * rather than gated on, so the only thing that stops a cast there is a refusal the service itself
 * sent. See `fishingWindowClause`.
 *
 * `transport` and `protocol` split the two ways a call can fail to produce a verdict, and
 * they are kept apart for the reason the rest of this file keeps categories apart: a
 * network fault is waited out, while a response that arrived and could not be read is a
 * contract change that will reproduce on every sweep until someone looks at it. Both are
 * graded `retry` — nothing is gained by parking a day over an HTML error page — so the
 * code is what tells a person which of the two they are looking at.
 *
 * `no_web_session`, `no_badges`, `csrf_unavailable` and `csrf_rejected` are 粉丝家园签到's four,
 * because it is the one action here that needs a web session beside its token. Each is a state this
 * adapter had to name for itself: the service answers nothing that could be quoted, and the four
 * call for different things — a re-bind, a look at the account, a value this run could not obtain
 * at all (in which case nothing is sent), and the platform refusing a value that *was* sent.
 * The split between the last two is the point of having both: 「拿不到 CSRF 值」 and 「这个值不被
 * 接受」 are different states with different remedies, and a message that reports one as the other
 * sends a person after the wrong thing. Neither of them names a re-bind: the session is not what
 * either one is about.
 *
 * 亲密度任务's states are the same idea for a per-Room read whose answer is a list rather than a
 * verdict. `tasks_done` and `paid_tasks_left` are its two *settled* states and both end the day:
 * every daily task the server lists reads done, or the only row left is the one this action never
 * does. `danmaku_owed` is its 弹幕 half waiting for the action that performs the act.
 * `no_gift_allowlist` and `no_gift_held` are the gifting half's two *nothing to send* states, and they
 * are two because a person's next move differs: a list nobody has written, versus a list whose items
 * this account does not hold today. `gifts_sent` and `gift_short` are the same half having sent
 * something — the task's row finished, or the run stopping while the row is still short (nothing left
 * in the backpack, or this adapter's own per-run ceiling hit). `unknown_task_type` and
 * `unknown_gift_row` are shapes this build has never seen — a fourth `taskType`, and a second
 * 赠送礼物 row — which are contract changes and must be visible rather than settled on a guess.
 * `no_day_tasks` is an empty daily list, which is two readings this side cannot tell apart.
 *
 * **`no_gift_endpoint` used to be in this table and is deliberately gone.** It said this repository had
 * never captured a gift request — true when it was written, and the date on it has passed: the request
 * is `tests/captured/douyu-donate-request-12306.txt`. A name nothing can report is how the next reader
 * concludes the feature is still unimplemented.
 *
 * 粉丝家园钓鱼's four are the same idea for an action whose whole subject is one room's own state.
 * `no_character` and `no_bait` are the two things a person has to have set up in 粉丝家园's own
 * interface before a cast can go out — an 形象, and a bait marked as in use — and both are states
 * this build reports rather than states it can fix: there is no endpoint here that sets either.
 * `bait_low` is the bound this adapter enforces for itself out of the panel's own `cnt`, and it is
 * kept apart from the service's `1005003` because one is a reading and the other is a verdict.
 * `unknown_fishing_stat` is a `fishing.stat` outside the three values the capture established, which
 * is a contract change and has to be visible rather than waited through.
 *
 * 清仓's are the same idea again, for an action whose two facts come from four different reads. `no_dump_room`
 * and `no_prop_allowlist` are its two person-fixable settings states, and they are two because the next
 * move differs: name a room, or write a list. `no_badges` is shared with 粉丝家园签到 — the badge wall
 * listing nothing is one fact, and 清仓 reads it fail-closed rather than as "nothing to renew", because a wall
 * this build failed to read a single row out of *is* an empty wall, and with no medal known there is no
 * reservation to keep anything back for. `no_gift_held` is shared with
 * 亲密度任务 for the same reason: the list is the owner's and is right, the backpack holds none of it today.
 * `nothing_expiring`, `expiry_unknown` and `all_reserved` are the three states in which 清仓 deliberately
 * sends nothing — respectively "nothing is inside the last 24 hours", "an item is held but its `met` could
 * not be read, so this build will not guess that it is due", and "the reservation ate everything the
 * allowlist holds". Only the middle one is a contract change a person has to look at; the other two are
 * states the next sweep or the next day clears on its own.
 */
const LocalCode = {
  AllReserved: 'all_reserved',
  BadTarget: 'bad_target',
  BaitLow: 'bait_low',
  CsrfRejected: 'csrf_rejected',
  CsrfUnavailable: 'csrf_unavailable',
  DanmakuOwed: 'danmaku_owed',
  ExpiryUnknown: 'expiry_unknown',
  GiftsSent: 'gifts_sent',
  GiftShort: 'gift_short',
  NoBadges: 'no_badges',
  NoBait: 'no_bait',
  NoCharacter: 'no_character',
  NoCredential: 'no_credential',
  NoDayTasks: 'no_day_tasks',
  NoDumpRoom: 'no_dump_room',
  NoGiftAllowlist: 'no_gift_allowlist',
  NoGiftHeld: 'no_gift_held',
  NoPropAllowlist: 'no_prop_allowlist',
  NoVerdict: 'no_verdict',
  NoWebSession: 'no_web_session',
  NothingExpiring: 'nothing_expiring',
  PaidTasksLeft: 'paid_tasks_left',
  Protocol: 'protocol',
  TasksDone: 'tasks_done',
  Transport: 'transport',
  UnknownAction: 'unknown_action',
  UnknownFishingStat: 'unknown_fishing_stat',
  UnknownGiftRow: 'unknown_gift_row',
  UnknownTaskType: 'unknown_task_type',
  WindowNotOpen: 'window_not_open'
} as const

/*
 * A note where two constants used to be: Douyu's `chatres` `res` values are **not named in this file
 * any more**, deliberately. They are `socket.ts`'s vocabulary and that module is where they are
 * classified (`classifySocketError`); naming them in both places is how one code ended up graded two
 * ways — this file judged `356` a content refusal and stopped the action while the socket answered
 * `retry` for the same number. One name, one home, one grade. `gradeDanmaku` imports both.
 *
 * `errors.ts` stays out of it for the reason that module records itself: it is a global table, and
 * these numbers mean nothing outside this socket.
 */

/** `ActionOutcome.targetKey` for an action that is scoped to the account. See `types.ts`. */
const TARGET_KEY_ACCOUNT_SCOPED = ''

/* ------------------------------------------------------------------ *
 * The credential blob
 * ------------------------------------------------------------------ */

/**
 * `accounts.credentials` is opaque to everything above the seam, so its shape is
 * this adapter's business alone:
 *
 *     { "token": "<composite uid_biz_stk_ct_ltkid>",
 *       "did": "<device id>",
 *       "webCookies": "<optional cookie header string>",
 *       "expiresAt": <optional ms since epoch>,
 *       "tokenExpiresAt": <optional ms since epoch> }
 *
 * `token` is the composite token this Platform's login produces, in the order §2.1
 * gives it: `<uid>_<biz>_<stk>_<ct>_<ltkid>`. Those five components are the web
 * session's own `acf_*` cookies, dropped by the service on the scan's landing hop and
 * assembled by `passport.ts` — **not** the PC route's `short_token`, a bundle this
 * adapter never receives (the route that answers it is not called here, and the web
 * route's success payload carries none, §7), and not the same thing as the `long_token`
 * in the PC response either. **`passport.ts`'s `renewFamily` reassembles this field from a
 * fresh family** when it rebuilds one, so a credential's token names the components it is
 * actually holding at that moment: leaving an old token beside a new family is how the
 * `h5nc` actions would be handed a string describing credentials that were just replaced.
 *
 * `did` is the device id, which the token does not carry and which the danmaku
 * login cannot do without: it goes into `loginreq` as `devid`, into the `vk` the
 * service recomputes, and into every `chatmessage` as `dy`. One account with two
 * device ids is two different sessions. It is also a cookie the renewal sends
 * (`dy_did`/`acf_did`), and it comes from this field and never from the jar: the jar's
 * `acf_devid` looks like the same value and is a different cookie.
 *
 * `webCookies` is the web session's cookie header, stored because §4 makes saving
 * it a requirement for the `www.douyu.com/japi/*` family and losing it on a
 * re-bind would be careless. Exactly one action here reads it — 粉丝家园签到, whose family
 * wants the session and whose CSRF value is the `acf_ccn` cookie inside it — and it is
 * still **never attached to an `h5nc/*` call**: that is what turns a valid token into
 * `999999 系统错误` (§2.2), and `protocol.ts` structurally cannot send one. Every other
 * action ignores it, so an empty `webCookies` costs them nothing. The renewal reads two
 * things out of it and sends neither: the `LTP0` pair it cannot rebuild anything without,
 * and `dy_accounts_main` when it is there. Holding no `LTP0` is the one state that makes a
 * renewal impossible, and it is why `refresh` answers `relogin_required` for such a blob.
 *
 * `expiresAt` is the **session cookie's own declared death**, recorded by whatever
 * performed the scan bind out of the `Set-Cookie` that delivered it: the long login is
 * carried by `LTP0` at 182.5 days, while the token family beside it is declared for
 * 6.125 days (`Max-Age=529200`, and note that `529200 = 604800 × 0.875` — the token's
 * own `expire_in` distance, less 21 hours; it is not seven days, §2.3). It is optional:
 * a hand-pasted blob arrives as a `Cookie:` header, which states no attributes at all,
 * and a jar without the session cookie has no lifetime to record — an absent stamp is
 * read as "unknown" rather than as "expired". **Nothing reads this stamp for a verdict**:
 * it travels with the credential for a person to look at rather than for this adapter to
 * decide on, and nothing follows it into `refresh`.
 *
 * `tokenExpiresAt` is the **token family's own declared death**, out of the same
 * `Set-Cookie` list that minted the five `acf_*` components, or — when a response declared
 * no `Max-Age` for any of them — the measured life counted from the moment the family
 * landed (`passport.ts`'s `familyStampOf`). It has exactly one reader and one decision:
 * `refresh` compares it against the renewal window to answer "is it time to rebuild this
 * family yet". **That is storage for a schedule, not a verdict** — a family past its stamp
 * is rebuilt, never declared dead, and a token that is in fact dead still arrives as Douyu's
 * own `-101` on the action paths, where it is graded `account_stop`. Optional for the same
 * reason `expiresAt` is; a blob with no family clock is rebuilt once, which is what writes
 * one.
 */
const storedCredentialSchema = z.object({
  token: z.string().min(1),
  did: z.string().min(1),
  webCookies: z.string().optional(),
  expiresAt: z.number().int().positive().optional(),
  tokenExpiresAt: z.number().int().positive().optional()
})

/** The credential as this adapter uses it: the raw token, its five parts, and the device id. */
export interface ParsedCredential {
  readonly token: string
  readonly did: string
  readonly uid: string
  readonly biz: string
  readonly stk: string
  readonly ct: string
  readonly ltkid: string
  readonly webCookies: string
  readonly expiresAt: number | null
  readonly tokenExpiresAt: number | null
}

/**
 * The cookie the web session lives in, and the one cookie *name* this module still exports —
 * the name a renewal is keyed off, kept because `passport.ts` records it in a bind and because
 * the durations below are about it.
 *
 * `LTP0` is where the browser's long login lives. Everything known about it is measured:
 * it is issued by `GET passport.douyu.com/japi/scan/auth` — the endpoint `passport.ts`
 * itself polls — declared `Max-Age=15768000` (182.5 days) and `Secure; HttpOnly`, so the
 * page's own JavaScript cannot read it (§2.1/§3); the token family landed by the same
 * handshake is declared for `Max-Age=529200` (6.125 days) instead, which is `604800 ×
 * 0.875` and not the seven days this repo used to assert; in the one captured browser jar
 * the single request carrying `LTP0` is the single `safeAuth` that answered `302`, while
 * the two without it answered `error:16 未登录,请重新登录` (§5.2); a probe of 2026-10-08 then
 * turned that last observation into the thing this adapter now does — with `LTP0` alone, and
 * with no signature anywhere, those two hops hand back a **whole new family**, while without
 * it the first hop refuses and sets no cookie at all; and a third-party client stores it on its
 * own as a "renewal key" (§2.3 — third-party code, unverified here).
 *
 * **The name is the key a renewal presents, and that is the only thing read out of it.** It
 * answers *identity* — "does this credential still hold the long-lived session?" — while what
 * every `h5nc/*` action actually uses is the token family beside it, and the two are
 * independent: a member that read this name as a verdict *on the token* told a working account
 * to re-bind four times a day, and that is still not what this is. The two readings the renewal
 * makes are narrower and both are measured: with a pair in the jar, the family can be rebuilt
 * without a person; with none, nothing on this side can ever rebuild it, so the one honest
 * answer is that a scan is needed (`refresh`'s `relogin_required` — which says the session
 * cannot be renewed, never that the token is dead). A `h5nc/*` action on the same account keeps
 * working while that answer stands. No duration is ever taken from the name either: every
 * duration in this module comes from the `Set-Cookie` that delivered the value (`passport.ts`'s
 * `absorb`), because one name can carry two lives (`acf_auth` at 529200 as an opaque ciphertext
 * against 3600 as a JWT; `acf_ccn` at 7200 against 604800, §3/§6). The opposite rule —
 * "whichever cookie was declared the longest wins" — stays rejected, because it would hang a
 * verdict on a number whose meaning per cookie is unmeasured (`acf_isNewUser`'s 30 days are not
 * a session either), and the token's own life is already stated by the response that minted it.
 */
export const SESSION_COOKIE = 'LTP0'

/** `<uid>_<biz>_<stk>_<ct>_<ltkid>` — five components, and no fewer is a token. */
const TOKEN_PARTS = 5

/**
 * Reads a stored credential, or null when the blob is unusable.
 *
 * Null rather than a throw: an unreadable credential is a state a person has to
 * fix by re-binding, which the adapters report as `account_stop` — it is not a
 * programming error. A token that does not carry five components is treated the
 * same way, because there is nothing a socket could do with it.
 *
 * The split runs from **both ends**: `uid` and `biz` are the first two fields,
 * `ltkid` and `ct` the last two, and whatever is left in the middle joins back
 * into `stk`. A single underscore inside `stk` would otherwise shift every field
 * after it — a failure that surfaces as `401000206` on the socket, which reads
 * exactly like a wrong key.
 *
 * **The ambiguity this leaves is accepted, and here is the evidence for judging it
 * later.** Two independently obtained real tokens both put 16 lowercase hex
 * characters in `stk` (`25ea78f729fed716`, `9edbf550803a17f4`), and hex cannot
 * contain an underscore — so in practice `parts.length` is always exactly 5, and
 * anything longer is a misaligned paste that this function will parse anyway.
 * Tightening it to `!== TOKEN_PARTS` would therefore reject exactly those
 * misalignments, but it would also reject a valid token should Douyu ever issue an
 * `stk` that is not hex, and the two mistakes cost the same thing: a person
 * re-pastes a credential that looks fine. Rejecting a valid token is the worse of
 * the two, so the lenient split stays until the alphabet is actually measured.
 * (`docs/adr/` is the place for that decision if it is ever revisited.)
 *
 * The scan-login route is immune either way: it checks each of the five `acf_*`
 * cookies by name before assembling the string, so a missing field cannot reach
 * here. Only the paste path is exposed.
 */
export function parseCredential(blob: string): ParsedCredential | null {
  let json: unknown
  try {
    json = JSON.parse(blob)
  } catch {
    return null
  }

  const parsed = storedCredentialSchema.safeParse(json)
  if (!parsed.success) return null

  const parts = parsed.data.token.split('_')
  if (parts.length < TOKEN_PARTS) return null

  const uid = parts[0]
  const biz = parts[1]
  const ltkid = parts[parts.length - 1]
  const ct = parts[parts.length - 2]
  const stk = parts.slice(2, parts.length - 2).join('_')
  if (uid === undefined || biz === undefined || ltkid === undefined || ct === undefined) return null
  if (uid === '' || biz === '' || stk === '' || ct === '' || ltkid === '') return null

  return {
    token: parsed.data.token,
    did: parsed.data.did,
    uid,
    biz,
    stk,
    ct,
    ltkid,
    webCookies: parsed.data.webCookies ?? '',
    expiresAt: parsed.data.expiresAt ?? null,
    tokenExpiresAt: parsed.data.tokenExpiresAt ?? null
  }
}

/**
 * Everything `loginreq` needs, out of the blob.
 *
 * The room id comes from the task rather than from the credential: the same
 * account sends to many rooms, and the socket frame's `roomid` is the target.
 */
function danmakuSessionFor(credential: ParsedCredential, roomId: string): DanmakuSession {
  return {
    roomId,
    uid: credential.uid,
    stk: credential.stk,
    biz: credential.biz,
    ct: credential.ct,
    ltkid: credential.ltkid,
    deviceId: credential.did
  }
}

/* ------------------------------------------------------------------ *
 * Room metadata — the one read the protocol layer does not cover
 * ------------------------------------------------------------------ */

/**
 * `GET https://www.douyu.com/betard/<rid>` — room title, anchor and liveness.
 *
 * This is the only endpoint this adapter owns, and it is here rather than in
 * `protocol.ts` because that module's four families are all *account actions*,
 * while this one is the read both `resolveTarget` and `probe` are built on. It is
 * also the shape the probe needs and `room_init` is for Bilibili: one call answers
 * "is this a room", "what is it called", "who is the anchor" and "is it live".
 *
 * The call is **anonymous and header-free**, which was measured rather than
 * assumed: a request with no `User-Agent` at all answers the same 200 JSON as one
 * with a Chrome UA. That matters twice — `resolveTarget` runs while a task is being
 * created, before an account is necessarily chosen, and `probe` therefore cannot
 * be the thing that discovers an expired session (see `probe`).
 */
const ROOM_ORIGIN = 'https://www.douyu.com'

/**
 * The deadline for one room read.
 *
 * Named for the call it bounds rather than for "the transport": this is the one
 * endpoint this adapter owns, and 15 s is the house ceiling every single-request path
 * in this project uses.
 */
const ROOM_READ_TIMEOUT_MS = 15_000

/**
 * Douyu types the same number as a JSON number or a numeric string; this payload
 * mixes both inside the same room object.
 *
 * The union is the gate and `z.coerce.number()` retypes: a bare `Number()` transform
 * parsed `'abc'` as a *successful* `NaN`, and a bare `z.coerce.number()` would accept
 * `null` as `0` — which on `show_status` is not a missing value but the verdict
 * "offline", the one thing a probe must never invent.
 */
const numeric = z.union([z.number(), z.string()]).pipe(z.coerce.number())

/**
 * The room payload, narrowed to the five fields anything here needs.
 *
 * Unknown keys are dropped — `betard` answers ~77 KB of config alongside the room
 * and none of it is modelled. `owner_name` is defaulted because the title is worth
 * returning even when the anchor's name is missing.
 */
const roomMetaSchema = z.object({
  room: z.object({
    room_id: numeric,
    room_name: z.string(),
    owner_name: z.string().default(''),
    owner_uid: numeric,
    show_status: numeric
  })
})

interface RoomMeta {
  readonly roomId: number
  readonly roomName: string
  readonly ownerName: string
  readonly ownerUid: number
  readonly showStatus: number
}

/**
 * Thrown when a room read does not produce a room.
 *
 * It carries the HTTP status so a caller can grade the failure the way Bilibili's
 * `BiliHttpError` grades its own: 5xx and 4xx are upstream, `0` is the network or
 * a contract change. A *business* refusal never reaches this class, because this
 * endpoint has no business codes — `betard/<unknown>` answers a 404 HTML page.
 */
class RoomReadError extends Error {
  readonly status: number

  constructor(status: number, detail: string) {
    super(detail)
    this.name = 'RoomReadError'
    this.status = status
  }
}

/**
 * One room read, in the same shape as `protocol.ts`'s transport — which is not
 * exported, so the pattern is repeated rather than reached into.
 *
 * Everything that is not a room throws: a network fault, the deadline, a non-2xx, a
 * body that is not JSON (a 404 here is an HTML page), and a body that does not match
 * the schema. The deadline covers the body as well, because `fetch` resolves on
 * headers and an `AbortSignal.timeout` stays armed for the rest of the exchange.
 */
async function fetchRoomMeta(roomId: number): Promise<RoomMeta> {
  let status = 0
  let body = ''
  try {
    const response = await fetch(`${ROOM_ORIGIN}/betard/${String(roomId)}`, {
      signal: AbortSignal.timeout(ROOM_READ_TIMEOUT_MS)
    })
    status = response.status
    body = await response.text()
  } catch (error: unknown) {
    throw new RoomReadError(0, `request failed: ${errorText(error)}`)
  }

  if (status >= 400) throw new RoomReadError(status, `HTTP ${String(status)}`)

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch (error: unknown) {
    throw new RoomReadError(0, `response was not JSON: ${errorText(error)}`)
  }

  const parsed = roomMetaSchema.safeParse(payload)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.join('.') ?? '<root>'
    const detail = issue?.message ?? 'unknown validation error'
    throw new RoomReadError(0, `unexpected room payload at ${where}: ${detail}`)
  }

  return {
    roomId: parsed.data.room.room_id,
    roomName: parsed.data.room.room_name,
    ownerName: parsed.data.room.owner_name,
    ownerUid: parsed.data.room.owner_uid,
    showStatus: parsed.data.room.show_status
  }
}

/**
 * Douyu's own live value on `show_status`, raw.
 *
 * Not to be confused with the seam's normalised `LIVE_STATUS_LIVE`: this is one
 * Platform's encoding, and `2` — an anchor who is not streaming — is the value it has
 * to be told apart from. `probe` is where that fold happens.
 */
const SHOW_STATUS_LIVE = 1

/**
 * A host that serves room pages, and only those.
 *
 * The allowlist is what stops an arbitrary link from being read as a room, and it
 * names the two room hosts plus the apex. `yuba.douyu.com` and `passport.douyu.com`
 * are deliberately outside it: their first path segment is a section name
 * (`/group/…`), not a room, and accepting them would turn a 鱼吧 link into a
 * confusing lookup against the wrong service.
 */
const ROOM_HOST = /^(www\.|m\.)?douyu\.com$/i

/** A vanity room path, before it is interpolated into a URL. */
const ROOM_SLUG = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Resolves a vanity path to its room number by following the room page's redirect.
 *
 * `douyu.com/yyf` is a real room URL and `betard/yyf` is a 404, so the number is
 * not derivable from the slug: it has to be asked for. The room page answers `302`
 * with the numeric path (`location: /45977`), which is the whole mechanism — one
 * hop, read from the header, with nothing fetched and nothing parsed. A path that
 * does not redirect, or that redirects somewhere that is not a room, returns null
 * rather than being guessed at.
 *
 * **It carries the house deadline like every other single request here.** It used not to, and the
 * comment on `ROOM_READ_TIMEOUT_MS` — "15 s is the house ceiling every single-request path in this
 * project uses" — was therefore false about this one path: `resolveRoomId` is reached from
 * `POST /api/targets/resolve`, so a room page that accepted a connection and then said nothing left that
 * request hanging on undici's own headers timeout, an order of magnitude higher, with no local bound at
 * all. Both outcomes a caller can see are unchanged — `null` still means "not resolvable".
 */
async function resolveSlug(slug: string): Promise<number | null> {
  if (!ROOM_SLUG.test(slug)) return null

  let response: Response
  try {
    response = await fetch(`${ROOM_ORIGIN}/${slug}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(ROOM_READ_TIMEOUT_MS)
    })
  } catch {
    return null
  }

  if (response.status < 300 || response.status >= 400) return null
  const location = response.headers.get('location')
  if (location === null) return null

  let target: URL
  try {
    target = new URL(location, `${ROOM_ORIGIN}/`)
  } catch {
    return null
  }

  return roomIdOf(target.pathname.split('/').find(part => part !== '') ?? '')
}

/**
 * Pulls a room id out of what a person pasted.
 *
 * Four shapes are accepted, because they are what a browser bar and the Douyu app
 * produce: `https://www.douyu.com/12306?x=1`, the scheme-less
 * `www.douyu.com/12306`, `https://m.douyu.com/12306`, and a bare `12306`. A
 * non-numeric first segment is a vanity path and goes through `resolveSlug`.
 */
async function resolveRoomId(input: string): Promise<number | null> {
  const trimmed = input.trim()
  if (trimmed === '') return null

  const bare = roomIdOf(trimmed)
  if (bare !== null) return bare

  // Prefixing a scheme lets the scheme-less and the full form share one parse path;
  // the guard is here so input that already carries one is not mangled into
  // `https://https://…`.
  const candidate = /^[a-z0-9][a-z0-9.-]*\//i.test(trimmed) ? `https://${trimmed}` : trimmed

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }

  if (!ROOM_HOST.test(parsed.hostname)) return null

  const segment = parsed.pathname.split('/').find(part => part !== '')
  if (segment === undefined) return null

  const numericId = roomIdOf(segment)
  return numericId === null ? await resolveSlug(segment) : numericId
}

/* ------------------------------------------------------------------ *
 * The seam members
 * ------------------------------------------------------------------ */

/**
 * Turns pasted input into a target the rest of the system can act on.
 *
 * Throws when the input does not resolve. The seam gives this member no failure
 * variant, and there is nothing here to retry: a form submission either names a
 * room or it does not, and the route turns the throw into a 400 or a 502. One call
 * answers everything the target needs, so unlike the Bilibili adapter there is no
 * second, cosmetic round trip for the title — and the anchor name comes with it,
 * where Bilibili's room endpoints do not carry one at all.
 */
async function resolveTarget(input: string): Promise<TargetInfo> {
  const roomId = await resolveRoomId(input)
  if (roomId === null) throw new Error('无法从该链接解析出斗鱼房间号')

  const meta = await fetchRoomMeta(roomId)

  return {
    // The room's own id, as the service reports it, rather than the number that was
    // pasted: the socket frame's `roomid` and the fish-ball call both want this one.
    key: String(meta.roomId),
    title: meta.roomName,
    anchorId: String(meta.ownerUid),
    anchorName: meta.ownerName,
    // The raw value, as `TargetInfo` documents. `probe` is where it is normalised.
    liveStatus: meta.showStatus
  }
}

/**
 * One liveness probe.
 *
 * Douyu's `show_status` is normalised to the seam's `LIVE_STATUS_LIVE`/`_OFFLINE`,
 * because the scheduler's liveness test must be one comparison for every Platform.
 * `SHOW_STATUS_LIVE` is the live value; `2` is what an anchor who is not streaming
 * reports, which is the only other value the captures contain. **Nothing here folds
 * `videoLoop` (轮播) in** —
 * one reference implementation gates liveness on `show_status == 1 && videoLoop == 0`,
 * but that interaction was never measured on this side, and inventing a third state
 * from one unverified source is how a probe starts lying.
 *
 * **A Douyu room accepts danmaku while offline.** That was verified at delivery
 * level — with `show_status` at `2` throughout, `loginres`/`joingroup` behaved as
 * they do live and a second, independent connection received every accepted message
 * (§2.7). So `requireOnline` on a Douyu task is a **user preference, not a server
 * requirement**: turning it off is not a risk, and tuning it on is a choice about
 * whether to speak into a quiet room rather than a workaround.
 *
 * Unlike the Bilibili adapter this probe makes **no session check**, and that is
 * deliberate rather than an omission. The room read is anonymous, so it could not
 * answer the question anyway; the account's own verdict arrives on every send, where
 * `loginres`/`error` grade themselves (§2.7); and buying an earlier answer would cost
 * a second account endpoint on every poll of every task. An unusable credential is
 * graded where it is used — in `send`, as `account_stop`.
 *
 * `_account` is unused because the room read is anonymous: the parameter is part of
 * the seam's signature, not something this Platform's probe has a use for.
 */
async function probe(_account: PlatformAccount, targetKey: string): Promise<ProbeResult> {
  const roomId = roomIdOf(targetKey.trim())
  if (roomId === null) {
    // A key that is not a room number cannot start working later; parking the
    // action beats retrying a typo forever.
    return probeFailure(LocalCode.BadTarget, '目标不是有效的斗鱼房间号', 'action_stop')
  }

  let meta: RoomMeta
  try {
    meta = await fetchRoomMeta(roomId)
  } catch (error: unknown) {
    // The room could not be read at all, so nothing was learned about it. `liveStatus`
    // is 0 and `ok: false` is what tells the caller not to read it.
    return probeFailure(transportCodeOf(error), `读取直播间信息失败：${errorText(error)}`, 'retry')
  }

  return {
    ok: true,
    liveStatus: meta.showStatus === SHOW_STATUS_LIVE ? LIVE_STATUS_LIVE : LIVE_STATUS_OFFLINE,
    // Free here, unlike Bilibili's: the call this probe already made carries it.
    title: meta.roomName,
    code: String(meta.showStatus),
    detail: '',
    failure: 'none'
  }
}

/**
 * One danmaku, through the socket the protocol layer already built.
 *
 * The credential is parsed into a `DanmakuSession` and handed over; nothing about
 * frames, `vk`, heartbeats or `joingroup` is decided here. A refusal comes back as
 * data rather than as an exception, so a `throw` is transport: the runtime has no
 * WebSocket, the endpoint would not parse, or the promise rejected before any
 * verdict arrived.
 */
async function send(account: PlatformAccount, targetKey: string, text: string): Promise<SendOutcome> {
  const roomId = roomIdOf(targetKey.trim())
  if (roomId === null) return sendFailure(LocalCode.BadTarget, '目标不是有效的斗鱼房间号', 'action_stop')

  const credential = parseCredential(account.credentials)
  if (credential === null) {
    // Nothing a retry can do: the session has to be re-bound by a person.
    return sendFailure(LocalCode.NoCredential, '账号凭据缺失或无法解析，需要重新扫码绑定', 'account_stop')
  }

  let result: Awaited<ReturnType<typeof sendDanmaku>>
  try {
    result = await sendDanmaku(danmakuSessionFor(credential, String(roomId)), text)
  } catch (error: unknown) {
    return sendFailure(LocalCode.Transport, `发送失败：${errorText(error)}`, 'retry')
  }

  if (result.ok) {
    // `detail` is only ever read on a failure — `runner.ts` writes it as the send
    // log's `error` — so a success has nothing to put here. The ack's `len` is
    // deliberately not reported: §2.7 measured it as a constant 50 on both a
    // 10-character and an 80-character message, so it is decoration.
    return { ok: true, code: String(result.code), detail: '', failure: 'none' }
  }

  return gradeDanmaku(result.code, result.message)
}

/**
 * Grades a `chatres` verdict.
 *
 * The code and nothing else. `res=290` is a cadence refusal — the measured floor is
 * about two seconds, so it says "the interval is wrong", not "the session is wrong",
 * and the next attempt at a proper cadence may well pass. `res=356` is a **content**
 * refusal and is parked for the day rather than retried: it fires on a long
 * consecutive alphanumeric run (35 and 40 Latin letters, 40 digits, while 30 digits
 * passed and the same 40 letters every 5 characters passed), so retrying it unchanged
 * repeats it forever — and a novel imported with URLs, hashes, ids or base64 in it
 * will hit it.
 *
 * `code === null` is the socket's "no verdict at all": the session went quiet, timed
 * out, or answered an `error` frame with no numeric code. `socket.ts` already
 * refused to classify it, and grading it as anything but `retry` would be the old
 * substring match wearing a new name.
 */
function gradeDanmaku(code: number | null, message: string): SendOutcome {
  if (code === null) return sendFailure(LocalCode.NoVerdict, message, 'retry')

  if (ACCOUNT_STOP_CODES.includes(code)) {
    // 1002 用户未登录, 999999 系统错误 (a web cookie beside a valid token),
    // 401000206 the socket refusing the session. Same table the HTTP families use,
    // because these codes mean the same thing wherever they appear.
    return sendFailure(String(code), message, 'account_stop')
  }

  switch (code) {
    case DANMAKU_RATE_LIMITED:
      return sendFailure(
        String(code),
        `发送过快（res=290）：实测最小间隔约 2 秒，这是节奏问题而不是会话问题；${message}`,
        'retry'
      )
    case DANMAKU_CONTENT_RULE:
      return sendFailure(
        String(code),
        `内容被拒（res=356）：命中「连续字母数字串过长」的内容规则，与长度无关——含 URL、hash、长 ID 或 base64 的文本会撞上它，先插分隔符再发；${message}`,
        'action_stop'
      )
    default:
      // An unknown code is not guessed at. Retrying keeps the loop alive, and the
      // code travels in `code`/`detail` so a new Douyu code shows up in the UI
      // rather than silently disappearing into a substring match.
      return sendFailure(String(code), message, 'retry')
  }
}

/**
 * One reconcile run.
 *
 * `enabledActions` is the switchboard's answer and the only source of what may run;
 * this adapter does not add, drop or reorder a key. One `ActionOutcome` per key, in
 * the order given, so the action log reads the same way regardless of how many of
 * them did something.
 *
 * Every outcome carries **items**: the thing each action was about, one entry per
 * account-scoped action, one per 鱼吧 or 粉丝牌 for the two walks, and one per daily task for
 * 亲密度任务. The record alone can only say 「新签 1、已签 2（共 3 个版块）」; the items say which three
 * and how each went, which is the question a person actually asks about yesterday. They are built from the
 * same `outcome`, `detail` and `code` the record gets, so an item cannot contradict
 * the run it belongs to — see `accountOutcome`.
 *
 * `dayKey` is deliberately not consulted: every action here is idempotent at the service,
 * "already done today" comes back as a code, and deriving the day locally is the guess
 * those codes exist to prevent. `now` **is** consulted, by exactly one action — 打卡分鱼丸,
 * whose check-in window is a clock fact and not a response, so no payload can be asked for
 * it (§3.1: the countdown the service sends points at the window opening and says nothing
 * about it closing). No other action here has an opening hour.
 */
async function reconcile(context: ReconcileContext): Promise<ActionOutcome[]> {
  const credential = parseCredential(context.account.credentials)
  const outcomes: ActionOutcome[] = []

  for (const key of context.enabledActions) {
    outcomes.push(await reconcileAction(key, context, credential))
  }

  return outcomes
}

/** Dispatches one action key. An unrecognised key is reported, never thrown. */
async function reconcileAction(
  key: string,
  context: ReconcileContext,
  credential: ParsedCredential | null
): Promise<ActionOutcome> {
  switch (key) {
    case ActionKey.SignIn:
      return await reconcileClientSign(credential)
    case ActionKey.Fishball:
      return await reconcileFishBall(credential)
    case ActionKey.YubaSign:
      return await reconcileYubaSign(credential, context.log)
    case ActionKey.FanshomeSign:
      // The other walk, and the only action here that needs the web session beside the token.
      return await reconcileFanshomeSign(credential, context.log)
    case ActionKey.ActivitySign:
      return await reconcileActivitySign(credential)
    case ActionKey.GrowthPool:
      // The only action that reads the clock: its check-in window is a fact about the day,
      // not a response, and the outcome before the window is `blocked` on purpose.
      return await reconcileGrowthPool(credential, context.now)
    case ActionKey.IntimacyTasks:
      // The only per-Room action here, and the only one that takes `context` twice over: the room it
      // reads is the task's target and the options it honours are keyed by this action's own key.
      return await reconcileIntimacyTasks(context, credential)
    case ActionKey.Clearout:
      // Account-scoped, and the one action whose target comes from its *options* rather than from the
      // Task: `默认倾泻直播间` is an account-level setting (see `reconcileClearout`), which is what makes
      // it a row with an empty target key.
      return await reconcileClearout(context, credential)
    case ActionKey.Fishing:
      // The other per-Room action, and the only one here that is a *cycle*: it casts, waits for an
      // instant the Platform names, and reels in — within one `reconcile`, because the wait is part
      // of the chore rather than something a later sweep would find done.
      return await reconcileFishing(context, credential)
    default:
      // Unreachable through the scheduler, which filters `enabledActions` down to
      // keys this catalogue declares. Answered rather than thrown because a throw
      // would lose the whole run's outcomes, including the other actions' work —
      // and `blocked` rather than `failed`, because nothing here failed.
      return blockedOutcome(
        key,
        LocalCode.UnknownAction,
        `斗鱼不认识动作 ${key}，本平台的 reconcile 只处理签到类动作。`
      )
  }
}

/**
 * 客户端签到 (`h5nc/*`).
 *
 * Two calls, in order. The CSRF bootstrap issues the `dy_cookie` that `sendSign`
 * echoes back as `dy_token`, and neither call may carry a web cookie: that is what
 * turns a valid token into `999999 系统错误` (§2.2).
 *
 * **`6305` is a success.** It means today's sign-in is already in, which is the
 * day's goal rather than a refusal, so it is reported as `already` and parked with
 * `action_stop` — retrying it would run the same call every five minutes until
 * midnight to be told the same true thing.
 *
 * The success detail reads only the three fields §2.2 verified — `sign_rd` (连续签到
 * 天数), `sign_cexp` (本次经验) and `sign_exps` (累计经验) — and reports them as facts
 * joined by 、rather than as a sentence: the row is named 「客户端签到」 and the section
 * above it has already said the day is done, so prose would only repeat one of the two.
 * `sign_silver`, `sign_siln`
 * and `sign_silb` are **not** read and are not reported: they were read as a 鱼丸
 * channel once, and an account that had just received 15 鱼丸 disproved it. A field
 * this module cannot interpret does not get a sentence in the UI.
 */
async function reconcileClientSign(credential: ParsedCredential | null): Promise<ActionOutcome> {
  const key = ActionKey.SignIn
  if (credential === null) return noCredentialOutcome(key)

  const csrf = await callGraded('获取登录凭据', () => fetchCsrfCookie(credential.token), credential.token)
  if (!csrf.ok) return transportFailure(key, csrf)
  const issued = csrf.reply
  if (!issued.ok) return actionFailure(key, codeText(issued.code), issued.message, issued.classification)

  const dyCookie = issued.data
  const result = await callGraded(
    '客户端签到',
    () => sendClientSign(credential.token, dyCookie),
    credential.token,
    dyCookie
  )
  if (!result.ok) return transportFailure(key, result)
  const signed = result.reply
  if (!signed.ok) return actionFailure(key, codeText(signed.code), signed.message, signed.classification)

  if (signed.data.alreadySignedToday) {
    return accountOutcome(key, 'already', '已签', String(CLIENT_SIGN_ALREADY_SIGNED), 'action_stop')
  }

  const status = signed.data.status
  const facts: string[] = []
  if (status !== null) {
    facts.push(`连签 ${String(status.sign_rd)} 天`)
    if (status.sign_cexp !== undefined) facts.push(`本次经验 +${String(status.sign_cexp)}`)
    if (status.sign_exps !== undefined) facts.push(`累计经验 ${String(status.sign_exps)}`)
  }

  return accountOutcome(
    key,
    'done',
    facts.length > 0 ? facts.join('、') : '已签、状态未返回',
    String(signed.code),
    'none'
  )
}

/**
 * 看广告鱼丸.
 *
 * The balance is read first, and it is the only number reported: the claim's own
 * response is `data: null` in both the captured success and the captured refusal, so
 * the verdict really is the code and the credit is observable only through the
 * balance (§2.3). Since the balance read happens before the claim, what the detail
 * reports is what the slot was worth — not a reward this adapter claims to have
 * verified, which would need a second read and is not this action's business. The
 * wording keeps that qualifier (「已领（领取前可领 20）」) rather than shortening to a bare
 * 「已领 20」: the number is the reading, and the reading is of the slot.
 *
 * **`-1` means "already claimed today", and it is mapped here.** It is *not* put in
 * `errors.ts` and must not be: that table is global, `-1` is also what unrelated
 * endpoints answer for "already done", and a global claim that `-1` means one thing
 * would be wrong the first time another family uses it. `protocol.ts` exports
 * `FISH_BALL_ALREADY_CLAIMED` and pointedly leaves it out of the classification
 * table; the meaning is attached only where the endpoint that produces it is known.
 */
async function reconcileFishBall(credential: ParsedCredential | null): Promise<ActionOutcome> {
  const key = ActionKey.Fishball
  if (credential === null) return noCredentialOutcome(key)

  const read = await callGraded('读取鱼丸余额', () => readFishBallBalance(credential.token), credential.token)
  if (!read.ok) return transportFailure(key, read)
  const balance = read.reply
  if (!balance.ok) {
    return actionFailure(key, codeText(balance.code), `读取鱼丸余额失败：${balance.message}`, balance.classification)
  }
  const worth = String(balance.data.num)

  // The uid is taken from the token rather than from the account row so the claim
  // can only ever be made for the session that authenticates it.
  const claim = await callGraded('领取鱼丸', () => claimFishBall(credential.token, credential.uid), credential.token)
  if (!claim.ok) return transportFailure(key, claim)
  const claimed = claim.reply
  if (!claimed.ok) {
    if (claimed.code === FISH_BALL_ALREADY_CLAIMED) {
      return accountOutcome(
        key,
        'already',
        `已领（当前可领 ${worth}）`,
        String(FISH_BALL_ALREADY_CLAIMED),
        'action_stop'
      )
    }
    return actionFailure(key, codeText(claimed.code), `领取失败：${claimed.message}`, claimed.classification)
  }

  return accountOutcome(key, 'done', `已领（领取前可领 ${worth}）`, String(claimed.code), 'none')
}

/** How many followed 鱼吧 one page of `myFollow` was asked for. */
const GROUPS_PER_PAGE = 30

/**
 * Ceiling on the follow-list walk.
 *
 * The payload's only pagination field is `count_page`, which `protocol.ts` parses
 * and does not surface, so the walk cannot know how many pages exist in advance and
 * is bounded instead. Five pages is 150 followed groups: far past a normal account,
 * and far short of a runaway loop if the service ignores `page`.
 */
const MAX_GROUP_PAGES = 5

/**
 * 鱼吧签到, one group at a time.
 *
 * Three measured facts shape this.
 *
 * **`is_signed` from `myFollow` is not a gate.** §2.4 measured groups reported as
 * `is_signed: 0` that answered 「今天已经签到过了」 when signed. So every group is
 * attempted and "already" is a success — the flag would only ever have caused a
 * group that needed signing to be skipped.
 *
 * **"Already signed" arrives two ways.** The preferred primitive (`fastSign`, which
 * needs no `Referer`) says it with a `200` and a level score of `0`, while the PC
 * twin says it with `status_code: 1001`. Both are handled, so the outcome does not
 * depend on which twin answered.
 *
 * **The list can span pages.** Each page is de-duplicated by `group_id` before
 * anything is attempted, which is what makes the walk safe to keep asking: a service
 * that ignores `page` simply returns the same groups again and the walk ends.
 *
 * **A call that never reached Douyu ends the walk.** The group it happened on is reported as
 * a failed item carrying the transport code, and the groups the walk never reached stay
 * uncounted — each remaining attempt would wait out the same failing transport for no new
 * information, and a page that cannot be read leaves the walk in exactly the same shape.
 *
 * One `ActionOutcome` covers the whole key — the action log holds one row per action
 * — and every group gets its own `context.log` line, so a truncated or half-failed
 * run is visible in the sweep's log rather than collapsed into a count.
 *
 * **Every group also gets its own item**, carrying what the console line said: which
 * 版块, whether it signed or was already in, and what it earned. That is the detail a
 * person asks for, and until now it lived only in the console — the row in the
 * database carried the count and nothing else. When the walk never reached a group,
 * the item is the action itself (`accountOutcome`), because a group the run did not
 * touch has no name to show.
 */
async function reconcileYubaSign(
  credential: ParsedCredential | null,
  log: (line: string) => void
): Promise<ActionOutcome> {
  const key = ActionKey.YubaSign
  if (credential === null) return noCredentialOutcome(key)

  const seen = new Set<string>()
  const groups: YubaGroup[] = []
  for (let page = 1; page <= MAX_GROUP_PAGES; page += 1) {
    const listed = await callGraded(
      '读取鱼吧关注列表',
      () => listFollowedGroups(credential.token, { page, limit: GROUPS_PER_PAGE }),
      credential.token
    )
    if (!listed.ok) {
      // A page that never arrived mid-walk. Nothing has been signed yet, so the action is the
      // failure — graded `retry`, because a list nobody could read says nothing about the
      // groups that are on it. Otherwise the groups already collected stand and the walk stops.
      if (groups.length === 0) return transportFailure(key, listed)
      log(`鱼吧列表第 ${String(page)} 页未能取回（code ${listed.code}），已处理 ${String(groups.length)} 个版块后中止`)
      break
    }

    const followed = listed.reply
    if (!followed.ok) {
      // A page that fails mid-walk: nothing has been signed yet, so the action is
      // the failure; otherwise the groups already handled stand and the walk stops.
      if (groups.length === 0) {
        return actionFailure(
          key,
          codeText(followed.code),
          `读取鱼吧关注列表失败：${followed.message}`,
          followed.classification
        )
      }
      log(
        `鱼吧列表第 ${String(page)} 页读取失败（code ${codeText(followed.code)}），已处理 ${String(groups.length)} 个版块后中止`
      )
      break
    }

    let added = 0
    for (const group of followed.data) {
      if (seen.has(group.group_id)) continue
      seen.add(group.group_id)
      groups.push(group)
      added += 1
    }

    // A short page is the last page; no new groups means the walk is not progressing.
    if (followed.data.length < GROUPS_PER_PAGE || added === 0) break
  }

  if (groups.length === 0) {
    return accountOutcome(key, 'skipped', '未关注任何版块', '', 'none')
  }

  const failures: ItemFailure[] = []
  const items: ActionItem[] = []
  let done = 0
  let already = 0

  for (const group of groups) {
    const name = group.group_name === '' ? group.group_id : group.group_name
    // The item's label is the one thing rendered in the main UI, so an unnamed group
    // is described rather than shown as its id — while the console line above keeps
    // the id, which is what a person debugging the walk actually wants.
    // The item's `detail` is the second thing rendered there, and it is a fact — 「已签」,
    // 「等级分 +3」 — because the group's name already sits beside it; the console lines below
    // stay sentences, since a log is read top to bottom and a row is read across.
    const label = group.group_name === '' ? UNNAMED_GROUP : group.group_name

    const signed = await callGraded(
      '鱼吧签到',
      () => signGroupAndroid(credential.token, group.group_id),
      credential.token
    )
    if (!signed.ok) {
      // The call never reached Douyu, so what became of *this* group is unknown — the request
      // may even have landed. That is a reason to report it and stop, never to invent a verdict
      // for it: the ladder below grades Douyu's answers, and there is no answer here.
      failures.push({ name, code: signed.code, message: signed.detail, classification: 'retry' })
      log(`鱼吧「${name}」：${signed.detail}（code ${signed.code}），其余版块本次不再尝试`)
      items.push({ kind: 'group', label, outcome: 'failed', detail: signed.detail, code: signed.code })
      break
    }

    const result = signed.reply
    if (result.ok) {
      if (result.data.alreadySigned) {
        already += 1
        log(`鱼吧「${name}」：今天已经签到过了`)
        items.push({
          kind: 'group',
          label,
          outcome: 'already',
          detail: '已签',
          code: String(result.code)
        })
      } else {
        done += 1
        log(`鱼吧「${name}」：签到成功，等级分 +${String(result.data.levelScore)}`)
        items.push({
          kind: 'group',
          label,
          outcome: 'done',
          detail: `等级分 +${String(result.data.levelScore)}`,
          code: String(result.code)
        })
      }
      continue
    }

    if (result.code === YUBA_ALREADY_SIGNED) {
      already += 1
      log(`鱼吧「${name}」：今天已经签到过了（status_code ${String(YUBA_ALREADY_SIGNED)}）`)
      items.push({
        kind: 'group',
        label,
        outcome: 'already',
        detail: '已签',
        code: codeText(result.code)
      })
      continue
    }

    failures.push({
      name,
      code: codeText(result.code),
      message: result.message,
      classification: result.classification
    })
    log(`鱼吧「${name}」：签到失败（code ${codeText(result.code)}）`)
    items.push({ kind: 'group', label, outcome: 'failed', detail: result.message, code: codeText(result.code) })
  }

  return aggregateWalkOutcome({
    actionKey: key,
    unit: '版块',
    alreadyCode: YUBA_ALREADY_SIGNED,
    total: groups.length,
    done,
    already,
    failures,
    items
  })
}

/** One item's refusal, kept so the aggregate can rank them instead of taking the first. */
interface ItemFailure {
  /** The item's own name — a 版块's, or a room's anchor — for the record's closing sentence. */
  readonly name: string
  /**
   * Already formatted for display: a Douyu number, or a `transport`/`protocol`/`http_<status>`
   * code for a call that never reached Douyu. A string because the two kinds of failure are
   * reported in the same field and the second kind has no number — see `callGraded`.
   */
  readonly code: string
  readonly message: string
  readonly classification: ErrorClassification
}

/** Worst-first, so the aggregate reports the failure that matters most. */
const FAILURE_RANK: Readonly<Record<ErrorClassification, number>> = {
  retry: 0,
  action_stop: 1,
  account_stop: 2
}

/**
 * One finished walk, as the aggregate needs it.
 *
 * A named list rather than eight positional arguments: four of them are counts of the same
 * type, and the one mistake worth designing out is `done` and `already` swapping places.
 */
interface WalkResult {
  readonly actionKey: string
  /** What the count line calls one entry: 「版块」 for 鱼吧, 「直播间」 for 粉丝家园. */
  readonly unit: string
  /** The code an all-already walk reports — each family's own "already" number. */
  readonly alreadyCode: number
  readonly total: number
  readonly done: number
  readonly already: number
  readonly failures: readonly ItemFailure[]
  readonly items: readonly ActionItem[]
}

/**
 * Collapses one walk's per-item results into the one outcome the action log keeps.
 *
 * **One function for both walks** — 鱼吧's followed groups and 粉丝家园's fan-badged rooms —
 * because the ordering below is the part that must not differ between them, and `unit` and
 * `alreadyCode` are the only genuinely per-family facts in it. Twice written, this rule would
 * be one fact with two homes, and the day they disagreed the same shaped run would be graded
 * two ways.
 *
 * The order is the point. An `account_stop` anywhere outranks everything: nothing that failed
 * that way will work again until a person re-binds, so a run that also signed two items must
 * not be reported as a success. Otherwise any fresh sign is a `done`, an all-already run is
 * `already` and parks until tomorrow, and a run that accomplished nothing reports the worst
 * refusal it met.
 *
 * The `items` are passed through untouched, so the aggregate and its detail agree by
 * construction: whichever branch below decides the run's outcome, the item that caused it is
 * one of them and says the same thing.
 *
 * Its own `detail` is a line of facts — 「新签 0、已签 4（共 4 个版块）」 — and not a sentence
 * naming the action and closing with 「本日已完成」. The rows a person reads are the items below
 * it, so this line is the record's audit text: the same numbers, without the two repetitions
 * that made it say what the row's own label and heading already said.
 */
function aggregateWalkOutcome(walk: WalkResult): ActionOutcome {
  const counts = `新签 ${String(walk.done)}、已签 ${String(walk.already)}（共 ${String(walk.total)} 个${walk.unit}）`
  const failing = walk.failures.length === 0 ? '' : `、失败 ${String(walk.failures.length)}`

  let worst: ItemFailure | null = null
  for (const failure of walk.failures) {
    if (worst === null || FAILURE_RANK[failure.classification] > FAILURE_RANK[worst.classification]) worst = failure
  }

  if (worst !== null && worst.classification === 'account_stop') {
    return {
      actionKey: walk.actionKey,
      targetKey: TARGET_KEY_ACCOUNT_SCOPED,
      outcome: 'failed',
      code: worst.code,
      detail: `${counts}${failing}；「${worst.name}」${worst.message}`,
      failure: 'account_stop',
      items: walk.items
    }
  }
  if (walk.done > 0) {
    return {
      actionKey: walk.actionKey,
      targetKey: TARGET_KEY_ACCOUNT_SCOPED,
      outcome: 'done',
      code: '',
      detail: `${counts}${failing}`,
      failure: 'none',
      items: walk.items
    }
  }
  if (worst === null) {
    return {
      actionKey: walk.actionKey,
      targetKey: TARGET_KEY_ACCOUNT_SCOPED,
      outcome: 'already',
      code: String(walk.alreadyCode),
      detail: counts,
      failure: 'action_stop',
      items: walk.items
    }
  }
  return {
    actionKey: walk.actionKey,
    targetKey: TARGET_KEY_ACCOUNT_SCOPED,
    outcome: 'failed',
    code: worst.code,
    detail: `${counts}${failing}；「${worst.name}」${worst.message}`,
    failure: worst.classification,
    items: walk.items
  }
}

/**
 * The `ctn` one run will send: the value its own badge read minted, or the one the header it
 * was given already carried.
 *
 * The minted value comes first for the reason a cookie does — the badge wall re-issues
 * `acf_ccn` on **every** call, including to a caller that already had one (the captured run's
 * own cookie dump lists `acf_ccn` before the read and the response sets it again), so the
 * response is the newest thing the service has said about this session, and a browser that had
 * just loaded that page would send exactly it. The header's value is the fallback for a read
 * that issued none, which is the only case where it can be the fresher of the two.
 *
 * **Neither ordering is measured.** The two calls this project got a business verdict from were
 * signed with a value that came from a cookie header, and both of those runs happened before any
 * badge read in the same process, so all that is established is that *a* service-issued `acf_ccn`
 * was accepted — not that the minted one is required, nor that the two ever differ.
 *
 * **The value is used for one run and dropped.** It is *not* written back into the stored
 * `webCookies`, and the second of the two reasons decides it: the read that mints this value runs
 * on every execution of this action, so a stored copy would never be the value a run sends — while
 * a copy written back would be up to 7200 seconds old by the next run and would then be **preferred
 * over nothing at all** in the branch below that reports 「拿不到」. That is this action's own
 * failure shape in reverse: a value past its life sent as though it were live, answered with the
 * very 403 this build just stopped producing.
 */
function csrfValueFor(list: FanBadgeList, webCookies: string): string {
  return list.csrf ?? cookieValueIn(webCookies, FANSHOME_CSRF_COOKIE)
}

/**
 * One cookie's value out of a `Cookie:` header string, or `''`.
 *
 * `passport.ts` has a function of this shape — it reads the avatar and nickname off the header
 * a person pasted — and the two are deliberately separate: that one is the bind flow taking a
 * display name out of storage, this one is the action layer reading the credential it is about
 * to send, and six lines are not worth a dependency between the two modules.
 */
function cookieValueIn(header: string, name: string): string {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return ''
}

/**
 * The one console line that says where this run's CSRF value came from.
 *
 * It exists because of what a diagnosis could *not* get out of the disk: when this action's first
 * live run was refused, the request body had never been saved, so 「值没铸出来」 and 「值铸出来了但
 * 只送了半个双提交」 had to be told apart by reading the code instead of the evidence. Three facts
 * settle that on the spot, and this line states all three — whether the read's response carried the
 * `Set-Cookie` at all, whether a value is in hand, and its **length** as a fingerprint a person can
 * compare across two runs. It never states the value: this is a credential for the next two hours,
 * and this project does not put one in a log line.
 *
 * `who` names the action writing the line, because **two** actions now read this same badge wall for
 * this same value — 粉丝家园签到 signs with it and 钓鱼 casts with it — and a line naming one of them
 * on the other's task would send its reader to the wrong action's report. Everything after the
 * prefix is shared on purpose: it is one fact about one read, and two copies of it would be free to
 * disagree about where the value came from.
 */
function csrfNote(who: string, minted: string | null, ctn: string): string {
  const origin = minted === null ? '读粉丝牌这次没有下发 acf_ccn' : '读粉丝牌这次下发了 acf_ccn'
  if (ctn === '') return `${who}：${origin}，网页会话里也没有，本次拿不到 CSRF 值`

  const from = minted === null ? '网页会话' : '它'
  return `${who}：${origin}，本次请求带的 CSRF 值取自${from}，长度 ${String(ctn.length)}`
}

/**
 * 粉丝家园签到 — one POST per 粉丝牌, over the list the badge wall gave.
 *
 * **The web session is the one input a person has to supply**, and this is the only action here
 * that needs anything beyond the composite token. It is not a new field: `webCookies` has been
 * in the credential blob since the binder started writing it (§4), and for this account it is
 * empty because the bind that stored the token did not walk the web flow. The state is
 * therefore reported rather than worked around — `blocked`, with a re-bind named as what fixes
 * it, and **no request sent at all**: a request without a usable session answers this family's
 * identity refusal (`1002 用户未登录` — recorded in §10, whose body was never saved), and a
 * person reading that would go looking at the token, which is not what is wrong.
 *
 * **The badge wall is read first, and it is what makes the second request possible.** It names
 * the rooms — one row per 粉丝牌, so nothing has to be configured per room — and its response
 * headers mint the `acf_ccn` the body's `ctn` must equal. It is *not* `fetchCsrfCookie`: that
 * boots the `h5nc/*` family's `dy_cookie`, and the two are not interchangeable here.
 *
 * **That value then goes out twice, and that is this family's contract.** The sign is a double
 * submit: the body's `ctn` and the request's own `acf_ccn` cookie are compared, so a run that
 * mints a value and sends it in the body alone is refused. `signFansHome` assembles the header
 * for exactly that reason, and all this walk has to hand it is the session plus the value.
 *
 * **A room that fails does not end the walk.** Each row is its own request and its own item, so
 * one refusal — a room whose medal was withdrawn between the read and the sign, or a call that
 * never reached Douyu — leaves the others to be signed, and the record's counts say how many
 * were reached. The aggregate still reports the worst of them; what it must not do is drop a
 * room's outcome on the floor because a later one succeeded.
 *
 * **A refused CSRF value is the one failure that does end it.** That refusal is about the value
 * every room's body carries rather than about the room, so each remaining call would send the
 * same `ctn` and be refused identically; it is reported as `csrf_rejected` and graded
 * `action_stop` because a 403 of this shape reproduces on replay. What it must not do is point at
 * the session: the observed refusal — this action's first live run — carried the session fine and
 * the value in the body only, which is a request this build no longer makes, and a person sent to
 * re-bind for it would be sent after the one thing that was not wrong.
 *
 * **What a sign pays is not reported.** This endpoint has no captured success body and no
 * observed reward, so the item says the room was signed and stops there — see `signFansHome`.
 * The daily reset is why `-1` is an outcome rather than an error: 「今日已签到」 is the service's
 * own words for a day already done, which is a success that comes back tomorrow.
 */
async function reconcileFanshomeSign(
  credential: ParsedCredential | null,
  log: (line: string) => void
): Promise<ActionOutcome> {
  const key = ActionKey.FanshomeSign
  if (credential === null) return noCredentialOutcome(key)

  if (credential.webCookies.trim() === '') {
    // `blocked` and not `failed`: nothing failed, and nothing on this side can change the
    // answer — a scan is what puts a web session in the blob. `blocked` is also the outcome
    // `runner.ts` leaves unsettled on purpose, so the sweep keeps asking and the action can
    // start working the moment someone re-binds; `action_stop` is what raises 「动作受阻」 for it,
    // so the person finds out without having to open the action log.
    return accountOutcome(
      key,
      'blocked',
      '未签到、账号没有网页会话（重新扫码绑定一次，这个动作会自己继续）',
      LocalCode.NoWebSession,
      'action_stop'
    )
  }

  const listed = await callGraded(
    '读取粉丝牌列表',
    () => readFanBadges(credential.token, credential.webCookies),
    credential.token,
    credential.webCookies
  )
  if (!listed.ok) return transportFailure(key, listed)

  const badges = listed.reply.badges
  if (badges.length === 0) {
    // Two readings, and this side cannot tell them apart: an account holding no 粉丝牌 at all,
    // or a web session the page no longer treats as one. The captured markup cannot settle it
    // either — a logged-in page contains the login dialog as well, so its presence is no test.
    // `skipped` would settle the day on the second reading, which is exactly how a dead session
    // becomes a task that looks healthy, so the day is left unsettled and the person is told
    // both readings. `failure: 'none'` because nothing has gone wrong yet.
    return accountOutcome(
      key,
      'blocked',
      '未签到、粉丝牌列表是空的（要么这个账号没有粉丝牌，要么网页会话已不被认，重新扫码绑定最直接）',
      LocalCode.NoBadges,
      'none'
    )
  }

  const ctn = csrfValueFor(listed.reply, credential.webCookies)
  log(csrfNote('粉丝家园', listed.reply.csrf, ctn))
  if (ctn === '') {
    // Nothing to send, so nothing is sent. `ctn` is the field this layer checks, and **no request
    // of this project's has ever got past it with an empty value** — the one 403 that was captured
    // kept the response and not the request, so *why* it refused is unknown, and a body carrying an
    // empty `ctn` is not a shape worth spending a request to find out about. `blocked` rather than
    // `failed` because this is a value that a read mints: another run may well have one, and the
    // sweep leaves the day unsettled until one does. The remedy is that re-read — not a re-bind,
    // which is why the message names what is *not* wrong: the session answered the read above.
    return accountOutcome(
      key,
      'blocked',
      '未签到、这次读没有下发 acf_ccn 而网页会话里也没有，请求要用的 CSRF 值（ctn）拿不到，一个请求都没有发（会话是好的：这次读刚拿到粉丝牌列表）；这个值由一次读下发，下一轮会重新读一次',
      LocalCode.CsrfUnavailable,
      'action_stop'
    )
  }

  const failures: ItemFailure[] = []
  const items: ActionItem[] = []
  let done = 0
  let already = 0

  for (const [index, badge] of badges.entries()) {
    // Two audiences, two words for the same room, which is the split 鱼吧's walk makes for the
    // same reason: an item's label is rendered in the main UI and may never be an identifier,
    // while the console line is exactly where the id belongs — it is what the request is really
    // addressed by, and the only thing that tells two same-named anchors apart.
    const label = badge.anchorName === '' ? UNNAMED_ROOM : badge.anchorName
    const logged = badge.anchorName === '' ? badge.roomId : `${badge.anchorName}（房间 ${badge.roomId}）`

    const signed = await callGraded(
      '粉丝家园签到',
      () => signFansHome(credential.token, credential.webCookies, ctn, badge.roomId),
      credential.token,
      credential.webCookies,
      ctn
    )

    if (!signed.ok) {
      const rest = badges.length - index - 1
      if (signed.code === httpCode(FANSHOME_CSRF_REFUSED_STATUS)) {
        // The CSRF layer refused the request, and what it refused is the value every room's body
        // carries — not this room. So the walk stops here rather than repeating a request whose
        // one variable is identical, and the record keeps the platform's own words for it.
        //
        // **The remedy this message may not name is a re-bind.** The value went out in both places
        // by the time this branch can run (`withCookie`), so a refusal here is the platform
        // declining a value this build did send — a state of its own, separate from the missing
        // value reported above, and one the session has nothing to do with: the badge read that
        // minted this value had just answered with this account's room list. Pointing at the
        // session would send a person to re-bind for a problem that is not there — the errand this
        // action's first live failure produced. What is true is the re-read: the value is minted
        // per run, so the next attempt carries a new one.
        const detail = `服务端拒绝了这次请求：CSRF 校验没通过（csrf auth failed）；这与房间无关，剩余 ${String(rest)} 个房间本次不再尝试。本次请求的 body 与 cookie 带的是同一个 CSRF 值，所以不是缺值、也不是网页会话的问题——这个值要一次读才会重新下发，下一轮会重新读一次`
        failures.push({ name: label, code: LocalCode.CsrfRejected, message: detail, classification: 'action_stop' })
        items.push({ kind: 'room', label, outcome: 'failed', detail, code: LocalCode.CsrfRejected })
        log(`粉丝家园「${logged}」：${detail}`)
        break
      }

      // A call that never reached Douyu: what became of *this* room is unknown — the request may
      // even have landed — so it is reported and the walk goes on. Continuing is deliberate and
      // is where this walk differs from 鱼吧's, whose page read is one request for a hundred
      // groups: here a room is a request of its own, and one that did not come back says nothing
      // about the next one.
      failures.push({ name: label, code: signed.code, message: signed.detail, classification: 'retry' })
      items.push({ kind: 'room', label, outcome: 'failed', detail: signed.detail, code: signed.code })
      log(`粉丝家园「${logged}」：${signed.detail}（code ${signed.code}），继续下一个房间`)
      continue
    }

    const result = signed.reply
    if (result.ok) {
      if (result.data.alreadySigned) {
        already += 1
        log(`粉丝家园「${logged}」：今天已经签到过了`)
        items.push({ kind: 'room', label, outcome: 'already', detail: '已签', code: String(result.code) })
      } else {
        done += 1
        log(`粉丝家园「${logged}」：签到成功`)
        // 「已签」 and nothing else: what this endpoint pays has no evidence behind it at all, so
        // the row reports the one thing that happened. A reward field read out of an uncaptured
        // body would be this project's third invented number.
        items.push({ kind: 'room', label, outcome: 'done', detail: '已签', code: String(result.code) })
      }
      continue
    }

    failures.push({
      name: label,
      code: codeText(result.code),
      message: result.message,
      classification: result.classification
    })
    log(`粉丝家园「${logged}」：签到失败（code ${codeText(result.code)}）`)
    items.push({ kind: 'room', label, outcome: 'failed', detail: result.message, code: codeText(result.code) })
  }

  return aggregateWalkOutcome({
    actionKey: key,
    unit: '直播间',
    alreadyCode: FANSHOME_ALREADY_SIGNED,
    total: badges.length,
    done,
    already,
    failures,
    items
  })
}

/* ------------------------------------------------------------------ *
 * 亲密度任务 — one room's daily 粉丝牌 list
 * ------------------------------------------------------------------ */

/**
 * What each `taskType` means to this action.
 *
 * A table rather than a chain of `if`s, because there are exactly three things this build can say
 * about a task row and each of them is a fact about the row's type: the short name an item's `detail`
 * leads with, and what a run may do about the row while it is outstanding.
 *
 * `'gift'` is the entry whose work this action performs itself, and the only one of the three that
 * reaches the network on the row's behalf — see `sendRowGifts` for the two inputs it needs first.
 */
interface DailyTaskRule {
  readonly short: string
  readonly work: 'danmaku' | 'never' | 'gift'
}

const DAILY_TASK_RULES: Readonly<Record<number, DailyTaskRule>> = {
  [ROOM_TASK_DANMAKU]: { short: '弹幕', work: 'danmaku' },
  [ROOM_TASK_NAMED_GIFT]: { short: '全力守护', work: 'never' },
  [ROOM_TASK_ANY_GIFT]: { short: '赠送', work: 'gift' }
}

/**
 * How one daily task ended this run, in the nine states this build can produce.
 *
 * The nine, and not the outcome vocabulary, because the record's verdict has to be one its items agree
 * with while the items' own verdicts differ from each other: a room's three rows can be 已结、不做 and
 * 已送 at once, and something has to decide which of them the row above them reports.
 *
 *  - `settled` — the server's own counter says the task is done (`taskNum >= taskTotal`). That counter
 *    and never `taskStatus`; see `roomDailyTaskSchema` for the read that decides it.
 *  - `paid` — the row names a gift and the gift is paid (「送出“全力守护”礼物」, `taskWhiteGiftId`
 *    `24478`). A run must be **incapable** of this one: it would spend the owner's money on a public
 *    donation that cannot be un-sent, which is the one class of act this action must never reach.
 *  - `sent` — the 赠送礼物 row, and the run sent every gift the day still wanted. The one verdict here
 *    that is `done`, because it is the one an act of this run produced rather than a state it found.
 *  - `waiting` — the 弹幕 row, outstanding, left to the action that performs the act.
 *  - `short` — the 赠送礼物 row, and the run sent some but not all of them: the backpack ran out, or
 *    this adapter's own per-run ceiling was reached. `blocked` and not `done`, because the day's task is
 *    **not** finished and the next sweep is expected to pick it up — the row's counter is what will say
 *    so, and this side does not get to declare it.
 *  - `gated` — the 赠送礼物 row, outstanding, with no allowlist to send from.
 *  - `unheld` — the same row with a list this account holds none of today. A separate sentence from
 *    `gated` because it is a separate thing to do about it: the list is the owner's and is right, the
 *    backpack is the account's and is empty of it.
 *  - `unknown` — a `taskType` this build has never seen, or a second 赠送礼物 row. Fail-closed: nothing
 *    here knows whether such a row spends, so it is reported as unsettled and the action says so.
 *  - `failed` — a gift was refused, or a call this half needed never reached Douyu. Its grade is that
 *    call's own and travels on the item rather than through a table; see `JudgedTask.failure`.
 */
type DailyTaskVerdict = 'settled' | 'paid' | 'sent' | 'waiting' | 'short' | 'gated' | 'unheld' | 'unknown' | 'failed'

/**
 * Worst-last, so the record reports the item that matters most.
 *
 * Three of these orderings are decisions rather than the order the cases happened to be written in:
 *
 *  - **`sent` outranks `settled`.** A run that spent something reports `done`; reported as `already`,
 *    the row would read 无需处理 beside an item saying five gifts went out.
 *  - **`waiting` outranks `sent`.** A room whose 弹幕 task is still owed is not a finished day: another
 *    action is expected to land the danmaku, and this one has to keep watching the room for it.
 *  - **`failed` outranks everything, `unknown` outranks every blocked state, and `gated`/`unheld`
 *    outrank `waiting`/`short`.** A send this action attempted and could not finish is the loudest true
 *    thing about a run; a shape this build has never seen may never be settled on a guess; and a fix
 *    only a person can apply outranks a state the next sweep may well clear on its own.
 *
 * **`failed` at the top of this table is what makes `account_stop` govern**, and that is deliberate rather
 * than incidental: the one grade a verdict table cannot express is the credential's, and a session the
 * service has refused must never be hidden behind another item's verdict. It cannot be, because the only
 * way an item gets that grade is through `GiftRun.failure`, whose verdict is `failed` — so a run that also
 * sent two gifts is reported as `account_stop`, and the session event `runner.ts` raises fires.
 *
 * A total table over the union, so a tenth verdict is a compile error here until it is ranked — the
 * shape `FAILURE_RANK` has in `bilibili/index.ts`.
 */
const VERDICT_RANK: Readonly<Record<DailyTaskVerdict, number>> = {
  settled: 0,
  paid: 1,
  sent: 2,
  waiting: 3,
  short: 4,
  gated: 5,
  unheld: 6,
  unknown: 7,
  failed: 8
}

/** The word the console line states about one task, per verdict. */
const VERDICT_WORD: Readonly<Record<DailyTaskVerdict, string>> = {
  settled: '已结',
  paid: '不做',
  sent: '已送',
  waiting: '等发送弹幕',
  short: '没送完',
  gated: '未发',
  unheld: '缺货',
  unknown: '不认识',
  failed: '发失败'
}

/**
 * What the record adds about the item that governs it.
 *
 * A clause rather than a sentence: the record's own line is an audit line and its facts are the
 * governing item's, so this carries the one thing that item's `detail` has no room for — what is
 * missing, on which side, and what happens next. The gifting half has one per state rather than one for
 * all of them because they close in different places: the account's settings, the account's backpack
 * today, a request that failed, and the next sweep.
 *
 * `notes` is the one clause that does not exist as a constant: a run that sent something says *how many*
 * it sent, and a number read off the run cannot live in a `const`.
 */
const DANMAKU_OWED_CLAUSE = '弹幕任务那一半留给「发送弹幕」完成'
const NO_ALLOWLIST_CLAUSE = '赠送礼物那一半没有动手：账号里还没有「允许使用的礼物」清单，这一版不会自己挑一件送'
const NO_GIFT_HELD_CLAUSE = '赠送礼物那一半没有动手：清单里的礼物今天一件都没有，下一轮再读一次背包'
const GIFT_SHORT_CLAUSE = '赠送礼物那一半没送完：能送的都送出去了，下一轮接着送剩下的'
const GIFT_READ_CLAUSE = '赠送礼物那一半没能开始：背包没读出来，一件礼物都没有发'
const GIFT_REFUSED_CLAUSE = '赠送礼物那一半停了：服务端拒绝了送礼，剩下的下一轮再试'
const GIFT_UNREACHED_CLAUSE = '赠送礼物那一半停了：有一次送礼请求没有回音——那一件可能已经送出去了，剩下的下一轮再看'
const UNKNOWN_GIFT_ROW_CLAUSE = '有第二条「赠送礼物」任务，这一版一次只结算一条，没敢动它'
const UNKNOWN_TASK_CLAUSE = '有一类任务这一版不认识，先看它一眼'

/**
 * 清仓的四个「这一轮什么都没倒」状态，各一句。
 *
 * 四条而不是一条，因为它们的下一步各不相同：清单里一件都没有（去弄一件）、还没到期（等）、到期时刻读不出来
 * （有人得看一眼这一版是不是读错了字段）、以及被保留量吃光（等续牌那一半先送）。前两条和后一条都会自己过去，
 * 中间那条不会。
 */
const NO_PROP_HELD_CLAUSE = '清仓没有动手：清单里的道具今天一件也没有，下一轮会再读一次背包'
const NOTHING_EXPIRING_CLAUSE = '清仓没有动手：清单里还没有进入到期前 24 小时的道具，下一轮再看'
const UNKNOWN_EXPIRY_CLAUSE =
  '清仓没有动手：清单里有道具的到期时刻读不出来，这一版不会替它猜一个到期时刻——猜早了的代价是把不该倒的倒出去，而那件事不能撤销'
const ALL_RESERVED_CLAUSE =
  '清仓没有动手：这个账号现在的存货都被「亲密度任务」续牌要用的那一份占着，等它把今天那一半送出去，清仓会自己接着倒'

/** One daily task, judged: the item a person reads, and what the record does when this item governs. */
interface JudgedTask {
  readonly item: ActionItem
  readonly verdict: DailyTaskVerdict
  /**
   * The outcome and the grade this item carries, decided **with** the item rather than from its verdict
   * alone — because one verdict's grade is not static: a gift send that failed is graded by *what*
   * failed (`retry` for a request that never came back, `account_stop` for a session the service
   * refused, `action_stop` for a refusal the service called final), and a table from verdict to grade
   * could not say so. `gradeOfVerdict` still decides every other verdict.
   */
  readonly outcome: ActionOutcomeValue
  readonly failure: FailureKind
  /** The record's `code` when this item governs it — a state this adapter named, never a Douyu number. */
  readonly recordCode: string
  /** What the record's line adds when this item governs it, or `''` when nothing needs adding. */
  readonly clause: string
  /** `short counter word`, for the sweep's console line. */
  readonly line: string
}

/** The outcome value and the failure grade one verdict carries, for its item and for the record. */
function gradeOfVerdict(verdict: DailyTaskVerdict): {
  readonly outcome: ActionOutcomeValue
  readonly failure: FailureKind
} {
  switch (verdict) {
    case 'settled':
      // `already` and not `done`: nothing this run did put the task there. `action_stop` parks the
      // action for the day, the grading every settled chore here gets.
      return { outcome: 'already', failure: 'action_stop' }
    case 'paid':
      return { outcome: 'skipped', failure: 'action_stop' }
    case 'sent':
      // `done`, and `failure: 'none'`: something was accomplished and nothing is broken. `done` is also
      // what settles the day for this action, which is right — the row's own task is what was wanted.
      return { outcome: 'done', failure: 'none' }
    case 'waiting':
    case 'short':
      // `blocked` with `failure: 'none'`: nothing is broken and nothing needs a person. `waiting` clears
      // itself when 发送弹幕 lands a danmaku; `short` clears itself when the backpack fills up or the
      // row's counter moves, and both are expected back on a later sweep. A 动作受阻 event for either
      // would be the false alarm `runner.ts` describes — a row left blocked and silent is still in the
      // action log, which is where a person reads it.
      return { outcome: 'blocked', failure: 'none' }
    case 'gated':
    case 'unheld':
    case 'unknown':
      // All three need somebody to look: the account's settings, the account's backpack today, or a
      // shape this build cannot read.
      return { outcome: 'blocked', failure: 'action_stop' }
    case 'failed':
      // The fallback for a failure nothing classified — a fresh attempt next sweep, which is what an
      // unread transport fault wants. Every caller that produces this verdict supplies the grade the
      // failed call actually carried; see `JudgedTask.failure`.
      return { outcome: 'failed', failure: 'retry' }
  }
}

/**
 * The facts an item's `detail` leads with.
 *
 * 「弹幕 +10」, 「赠送 0/5、加成 +50」 — the short name binds to the first fact with a space, because it is
 * a name and the rest are values, and the values are joined by 、 the way every other detail in this file
 * joins facts. The counter is dropped when the task is a single one (`1/1` adds nothing the outcome has
 * not already said) and kept for a type this side cannot name, where it is the only number there is.
 */
function dailyTaskFacts(task: RoomDailyTask): string {
  const rule = DAILY_TASK_RULES[task.taskType]
  const values: string[] = []
  if (rule === undefined || task.taskTotal > 1) {
    values.push(`${String(task.taskNum)}/${String(task.taskTotal)}`)
  }
  const reward = rewardClauseOf(task)
  if (reward !== '') values.push(reward)

  if (rule === undefined) return values.join('、')
  return values.length === 0 ? rule.short : `${rule.short} ${values.join('、')}`
}

/**
 * What the service declares this task pays, or nothing at all.
 *
 * Absent rather than zero-filled, the way 打卡分鱼丸's pool counters are: a `0` would be a claim about a
 * reward nobody declared, and the detail reads properly without the clause — which is why both fields
 * are optional in the schema. The two are **not the same unit** and are never merged into one number:
 * `intimacyNum` is 亲密度, `intimacyBuff` is a bonus the page renders as a ladder, and the 赠送礼物 row
 * declares the second with a `0` in the first.
 */
function rewardClauseOf(task: RoomDailyTask): string {
  const facts: string[] = []
  if ((task.intimacyNum ?? 0) > 0) facts.push(`+${String(task.intimacyNum)}`)
  if ((task.intimacyBuff ?? 0) > 0) facts.push(`加成 +${String(task.intimacyBuff)}`)
  return facts.join('、')
}

/**
 * Judges one row: the counter first, the type second.
 *
 * **The counter decides settled-or-not and `taskStatus` plays no part in it** — `roomDailyTaskSchema`
 * records the weekly `1/2 天` read that a `taskStatus`-based judgement calls done. On the daily list
 * that is also the pair the report captured apart: at one instant room 12306's 弹幕 task reads `1/1`
 * and settled while room 12293234's same task reads `0/1` and outstanding, in the same account.
 *
 * The allowlist and the gifting walk arrive as parameters so that this stays the whole decision over one
 * row: the row the walk was about is judged from what the walk did, and every other row is decided by
 * its own counter and its own type. `gift` is `null` for a 赠送礼物 row the walk did **not** cover — a
 * second one, or a room whose allowlist is empty — and the two are told apart below.
 */
function judgeDailyTask(task: RoomDailyTask, allowlist: readonly string[], gift: GiftRun | null): JudgedTask {
  const rule = DAILY_TASK_RULES[task.taskType]
  const label = task.taskName === '' ? UNNAMED_TASK : task.taskName
  const counter = `${String(task.taskNum)}/${String(task.taskTotal)}`
  const facts = dailyTaskFacts(task)

  const judged = (
    verdict: DailyTaskVerdict,
    detail: string,
    recordCode: string,
    clause: string,
    overrides: { readonly word?: string; readonly failure?: FailureKind } = {}
  ): JudgedTask => {
    const grade = gradeOfVerdict(verdict)
    return {
      item: { kind: 'room', label, outcome: grade.outcome, detail, code: counter },
      verdict,
      outcome: grade.outcome,
      failure: overrides.failure ?? grade.failure,
      recordCode,
      clause,
      line: `${rule?.short ?? counter} ${counter} ${overrides.word ?? VERDICT_WORD[verdict]}`
    }
  }

  if (task.taskNum >= task.taskTotal) return judged('settled', facts, LocalCode.TasksDone, '')
  if (rule === undefined) {
    return judged('unknown', `${facts}、这一版不认识这类任务`, LocalCode.UnknownTaskType, UNKNOWN_TASK_CLAUSE)
  }
  if (rule.work === 'never') {
    // The paid row, stated as the fact it is and in the row's own words: 付费礼物, which this action
    // does not do on anyone's behalf — the one branch here that no configuration can turn on.
    return judged('paid', `${facts}、付费礼物不代做`, LocalCode.PaidTasksLeft, '')
  }
  if (rule.work === 'danmaku') {
    return judged('waiting', `${facts}、未做（留给发送弹幕这条动作）`, LocalCode.DanmakuOwed, DANMAKU_OWED_CLAUSE)
  }

  // `work: 'gift'`, and three readings that are three sentences because a person's next move differs in
  // each: a list nobody has written, a list whose items this account does not hold today (the walk's own
  // verdict), and a second 赠送礼物 row no walk covered.
  if (allowlist.length === 0) {
    return judged(
      'gated',
      `${facts}、未发（还没有「允许使用的礼物」清单，这一版不会自己挑一件送）`,
      LocalCode.NoGiftAllowlist,
      NO_ALLOWLIST_CLAUSE
    )
  }
  if (gift === null) {
    return judged(
      'unknown',
      `${facts}、未发（这一版一次只结算一条赠送任务）`,
      LocalCode.UnknownGiftRow,
      UNKNOWN_GIFT_ROW_CLAUSE
    )
  }

  // **The act leads when there is one and the row's own numbers trail it** — the shape `fishingOutcome`
  // uses for 「收竿 2 竿…（共 2 竿）」 — because a row that spent something leads with what it spent, and
  // not with the server's pre-run counter, which would read `0/5` beside 「已送 5 件」. With nothing sent
  // there is no act to lead with, so the row keeps `dailyTaskFacts`' order and the reason closes it.
  const detail = gift.sent === 0 ? `${facts}、${gift.act}` : `${gift.act}（${facts}）`

  return judged(gift.verdict, detail, gift.recordCode, gift.clause, {
    word: gift.sent === 0 ? VERDICT_WORD[gift.verdict] : `已送 ${String(gift.sent)} 件`,
    failure: gift.failure
  })
}

/**
 * One room's daily list, as the one outcome the action log keeps.
 *
 * The record's outcome, `code`, `failure` and trailing clause are all the **worst** item's (see
 * `VERDICT_RANK`), which is what makes "the aggregate has to be one its items recognise" true by
 * construction rather than by a test — and the outcome and the grade now travel *on* that item rather
 * than being looked up from its verdict, because a failed gift's grade is the platform's own.
 *
 * **There is no `account_stop` branch here, and the ranking is why.** `aggregateWalkOutcome` has one
 * because its counts line (`done > 0` ⇒ `done`) would otherwise outrank a gone credential; this table's
 * `failed` sits above every other verdict and is the only carrier of that grade, so the ranking already
 * says it. A tenth verdict ranked above `failed` would be the moment to add the branch.
 *
 * Its `detail` is a line of facts — 「已结 1、未结 2（共 3 个每日任务）」 — plus the governing item's
 * clause. Not a sentence, and not a repeat of the rows under it: those are what a person reads, and this
 * is the audit line the debug section renders. The counts stay the **server's own** counters: a row this
 * run sent gifts for is still 「未结」 here until the service's next read says otherwise.
 *
 * The parameter is a **non-empty** tuple, so the worst item is not a null check. The caller has already
 * answered the empty list with its own reading (`no_day_tasks`), and encoding "at least one" here rather
 * than testing for it keeps that branch in one place.
 */
function roomDailyTasksOutcome(
  actionKey: string,
  targetKey: string,
  judged: readonly [JudgedTask, ...JudgedTask[]]
): ActionOutcome {
  let worst = judged[0]
  for (const task of judged) {
    if (VERDICT_RANK[task.verdict] > VERDICT_RANK[worst.verdict]) worst = task
  }

  const settled = judged.filter(task => task.verdict === 'settled').length
  const counts = `已结 ${String(settled)}、未结 ${String(judged.length - settled)}（共 ${String(judged.length)} 个每日任务）`

  return {
    actionKey,
    targetKey,
    outcome: worst.outcome,
    code: worst.recordCode,
    detail: worst.clause === '' ? counts : `${counts}；${worst.clause}`,
    failure: worst.failure,
    items: judged.map(task => task.item)
  }
}

/**
 * One of this adapter's option lists, read as gift/prop ids — **the one place that rule is written**.
 *
 * Two actions now store a list of ids under their own key (`giftAllowlist`, `propAllowlist`), and what
 * makes the rule worth having once is the last paragraph of `giftAllowlistIn` below: an unreadable list
 * must read as an *empty* one, because that can only ever make an action send less. A second copy of
 * this loop would be a second chance to get that direction wrong.
 *
 * A JSON number is read as the same id as its digits, because the UI has no reason to know which of the
 * two the seam wants.
 */
function idListIn(options: unknown, name: string): readonly string[] {
  if (typeof options !== 'object' || options === null) return []
  const declared: unknown = (options as Record<string, unknown>)[name]
  if (!Array.isArray(declared)) return []

  const ids: string[] = []
  for (const entry of declared as readonly unknown[]) {
    const id = typeof entry === 'number' ? String(entry) : entry
    if (typeof id === 'string' && /^\d+$/.test(id)) ids.push(id)
  }
  return ids
}

/**
 * The gift ids this account's owner has allowed this action to spend, out of the action's own options.
 *
 * **The option's shape is this adapter's business** — `routes/action-settings.ts` stores whatever the
 * client sent precisely because `ActionDescriptor` describes no options — so the key and its contract
 * are stated here, once: `giftAllowlist` is an array of gift ids, each a string of digits.
 *
 * **An unreadable or empty list means no allowlist, and that is the safety property rather than a
 * convenience.** The owner's own reason is on record — 「签到等途径会送便宜的付费道具」 — so the backpack
 * holds paid items, and the Platform offers **no first-party "free" flag** (`priceType` is two different
 * fields under one name, and the numeric `2` appears on paid items too). A list that failed to parse can
 * therefore only make this action send *less*, never more.
 *
 * This is the gate `walkGifts` is handed, and it is a **gate** rather than a preference: a list is
 * read as an empty one unless it parses, so the state it produces is a report naming what is missing
 * rather than a send made on a guess.
 */
function giftAllowlistIn(options: unknown): readonly string[] {
  return idListIn(options, 'giftAllowlist')
}

/**
 * The room 「默认倾泻直播间」 names, or `null` when nothing usable is stored under it.
 *
 * A room *number*, checked by the same `roomIdOf` every other Douyu target goes through — the field's
 * choices come from the follow list, whose ids are room numbers, so anything else in this cell is either
 * a stale value or a hand-written one and neither may become a `roomId` of a gift POST.
 */
function dumpRoomIn(options: unknown): number | null {
  if (typeof options !== 'object' || options === null) return null
  const declared: unknown = (options as Record<string, unknown>)['dumpRoomId']
  const text = typeof declared === 'number' ? String(declared) : typeof declared === 'string' ? declared.trim() : ''
  return text === '' ? null : roomIdOf(text)
}

/* ------------------------------------------------------------------ *
 * 每日任务清单的那一次读 —— 两个动作共用
 * ------------------------------------------------------------------ */

/**
 * One Room's daily list, plus the one number two different actions need out of it.
 *
 * **This type exists because the same fact has two readers, and two readers is the defect.** 亲密度任务
 * sends gifts for the 赠送礼物 row and 清仓 must hold items back so that sending still can — and both of
 * those are "how many gifts does this room still want today", which is `taskTotal - taskNum` on that row
 * of `userTaskList`. If each action read the room and subtracted for itself, the two could disagree about
 * the same room in the same sweep, and the action whose whole job is *not* to eat the other one's stock
 * would be the one that got it wrong. So the read and the subtraction live here, once, and both actions
 * call this.
 *
 * The list travels beside the number rather than being thrown away: 亲密度任务 judges and reports **every**
 * daily row, and the 赠送礼物 row alone cannot say whether a fourth `taskType` appeared.
 */
interface RoomGiftDemand {
  /** The whole daily list this read returned, in the service's own order. */
  readonly tasks: readonly RoomDailyTask[]
  /**
   * The first outstanding 赠送礼物 row, or `null` when there is none.
   *
   * `find` rather than a filter: two rows of this type has never been seen, and a caller that had to
   * choose between them would be choosing without evidence. 亲密度任务 judges a second one `unknown`
   * from the list it already has, and 清仓 reserves for the one this names.
   */
  readonly row: RoomDailyTask | null
  /** `row.taskTotal - row.taskNum`, or `0` when the room wants no gift today. */
  readonly owed: number
}

/**
 * The derivation, as a pure function over one room's list — **the only place this file subtracts**.
 *
 * Outstanding is the service's own counter (`taskNum < taskTotal`), never `taskStatus`; see
 * `roomDailyTaskSchema` for the weekly read a `taskStatus` judgement calls done. A room with no 赠送礼物
 * row today owes nothing, and that is a reading rather than a fallback: the list is what the service says
 * the day wants.
 */
function giftDemandIn(tasks: readonly RoomDailyTask[]): RoomGiftDemand {
  const row = tasks.find(task => task.taskType === ROOM_TASK_ANY_GIFT && task.taskNum < task.taskTotal) ?? null
  return { tasks, row, owed: row === null ? 0 : row.taskTotal - row.taskNum }
}

/**
 * `userTaskList` for one room, with the gift remainder derived — the single reader, called by both actions.
 *
 * The nesting is `callGraded`'s and deliberately unchanged: a call that never reached Douyu (`!listed.ok`)
 * and a verdict Douyu sent (`!listed.reply.ok`) stay two different states with two different grades, which
 * is what the two callers already distinguish. Nothing here decides what a refusal means — that is the
 * caller's, because 亲密度任务 reports it against a room it is working on and 清仓 reports it against a
 * reservation it therefore cannot compute.
 */
async function readRoomGiftDemand(
  credential: ParsedCredential,
  roomId: number
): Promise<GradedCall<DouyuResult<RoomGiftDemand>>> {
  const listed = await callGraded(
    '读取亲密度任务',
    () => readRoomDailyTasks(credential.token, credential.webCookies, String(roomId)),
    credential.token,
    credential.webCookies
  )
  if (!listed.ok) return listed
  if (!listed.reply.ok) {
    return {
      ok: true,
      reply: {
        ok: false,
        code: listed.reply.code,
        message: listed.reply.message,
        classification: listed.reply.classification
      }
    }
  }

  return {
    ok: true,
    reply: { ok: true, code: listed.reply.code, data: giftDemandIn(listed.reply.data) }
  }
}

/**
 * The four verdicts a gifting walk can reach.
 *
 * Spelled out rather than typed as `DailyTaskVerdict`, because a walk cannot produce `settled`, `paid`,
 * `waiting`, `gated` or `unknown` — those are decided from a row's own counter and type with no request at
 * all, and a walk that returned one would be claiming a reading it never took.
 *
 * Two actions reach these now, so they are states of a *walk* rather than of a daily row: `sent` (everything
 * the walk wanted went out), `short` (it stopped with something still wanted — the stock ran out or this
 * run's ceiling was reached), `unheld` (nothing was sendable at all, and the caller said why: 亲密度任务
 * with a list the account holds none of, 清仓 with nothing inside the expiry window), and `failed` (a call
 * did not work, or the service refused one).
 */
type GiftVerdict = Extract<DailyTaskVerdict, 'sent' | 'short' | 'unheld' | 'failed'>

/**
 * How many gifts one run will send, whatever the row's own counter says.
 *
 * A runaway guard rather than a cadence, and the same shape `FISHING_MAX_CASTS_PER_RUN` has: the number
 * this action sends comes from the server (`taskTotal - taskNum`), and a row declaring a four-digit total
 * would otherwise spend an afternoon of public, un-undoable gifts in one sweep. The captured row wants
 * five, so this ceiling never binds on the shape that was measured — and a run that does reach it says so
 * instead of reporting the task as finished.
 */
const GIFTS_MAX_PER_RUN = 10

/**
 * What the gifting half did, for the one row it was about.
 *
 * A verdict and the facts behind it, and **not the item**: an item's `detail` is assembled by
 * `judgeDailyTask`, which is the only place that knows the row's own counter and its declared reward.
 */
interface GiftRun {
  readonly verdict: GiftVerdict
  /** How many gifts went out. Decides the `detail`'s reading order and the console line's word. */
  readonly sent: number
  /**
   * The run's own fact, in the two shapes `judgeDailyTask` places it in: 「已送 2 件…」 when something went
   * out, and 「未发（…）」/「未送成（…）」 when nothing did.
   */
  readonly act: string
  readonly recordCode: string
  readonly clause: string
  /** The grade of the call that stopped this walk, or `none` for a walk that reached its own bound. */
  readonly failure: FailureKind
}

/** One gift that went out, as its receipt described it. */
interface SentGift {
  /** The gift's own name, or `''` when the receipt named none. */
  readonly name: string
  /** The anchor the broadcast frame named, or `''` when no frame arrived or none was readable. */
  readonly anchorName: string
  readonly charge: GiftCharge
}

/**
 * The words one gifting walk needs, supplied by the action that is walking.
 *
 * **Why the sender takes prose as a parameter, and why a sender at all.** Two actions now hand a gift
 * to an anchor — 亲密度任务's 赠送礼物 half and 清仓 — and the one thing they must not each own is the
 * loop that does it: the order (look, decide, then one POST at a time), the rule that a refusal stops
 * the walk, the rule that a receipt with no readable backpack stops it too, and the fact that the
 * endpoint's own `usedProp.balance`/`includePrice` are what say whether anything was charged. Those are
 * the safety properties, and a second sender would be a second place for them to drift. What differs
 * between the two callers is **what a run says about itself**, and that is what this carries.
 */
interface GiftWalkWords {
  /** Closes the item's sentence when the backpack could not be read. */
  readonly read: string
  /** The same for a refusal from the send endpoint. */
  readonly refused: string
  /** The same for a send request that never came back. */
  readonly unreached: string
  /** The reason a walk gives, inside the item's own sentence, when it stops with nothing left to send. */
  readonly exhausted: string
  /** The record's trailing clause for that same stop — the two are one state and two audiences. */
  readonly shortClause: string
  /** What the record says when everything this walk wanted went out. The count is the run's own. */
  readonly done: (sent: number) => string
}

/**
 * What one walk wants, decided **from the stock the walk itself just read**.
 *
 * `want` is how many gifts this walk is trying to send and `pick` is which item goes next, given the
 * stock a receipt left. Both are the caller's arithmetic — the sender has no opinion about which item a
 * person allowed, or how many the day still wants — and both are answered *after* the read and *before*
 * the first POST, which is what keeps "look, then decide, then send" unrepresentable any other way.
 */
interface GiftWalkPlan {
  readonly want: number
  readonly pick: (stock: readonly PropItem[]) => PropItem | null
}

/**
 * The caller's answer to the stock it was shown: walk it, or send nothing and report `stop`.
 *
 * The second arm exists because two states a caller can be in are not states of the walk — 亲密度任务
 * with nothing the account holds from the list, and 清仓 with nothing that is close enough to expiry to
 * be worth sending. Both are decided before a single POST, and both need their own sentence, so they
 * are the caller's to hand back rather than the sender's to guess at.
 */
type GiftWalkStart = { readonly walk: GiftWalkPlan } | { readonly stop: GiftRun }

/**
 * The gift to send next: the first item **on the owner's list** that the backpack actually holds.
 *
 * The list's order decides, and it is the only order this build has a reason to follow: that is the order
 * a person ticked the items in, and any other rule — the cheapest, the most numerous — would be this side
 * preferring one of his choices to another. A row whose `count` reads `0` is skipped for the reason
 * `propItemSchema` gives, and `null` means there is nothing left on the list to send.
 */
function firstHeld(stock: readonly PropItem[], allowlist: readonly string[]): PropItem | null {
  for (const id of allowlist) {
    const held = stock.find(item => String(item.id) === id)
    if (held !== undefined && held.count > 0) return held
  }
  return null
}

/**
 * What the endpoint said about the price, over every gift this run sent, as one clause.
 *
 * All-zero is the captured success and reads 「本次没有扣费」. A non-zero pair names the two fields and
 * their numbers rather than a currency or an amount, because no non-zero pair has ever been captured —
 * and it is deliberately not softened into 「可能有扣费」: the endpoint either sent the two zeros or it did
 * not. A receipt that could not be read at all says exactly that, because silence about a price is not one
 * of the readings this action may report.
 */
function chargeClauseOf(sent: readonly SentGift[]): string {
  for (const gift of sent) {
    // The first send that did not read as free governs: one charge among free ones is the fact a person
    // has to see, and a run that stops on it has usually stopped after a single gift anyway.
    switch (gift.charge.kind) {
      case 'charged':
        return `这次没有说「没有扣费」（usedProp.balance=${String(gift.charge.balance)}、usedProp.includePrice=${String(gift.charge.includePrice)}）`
      case 'unknown':
        return '扣费情况读不出来'
      case 'none':
        break
    }
  }
  return '本次没有扣费'
}

/**
 * What the gifting half did, as the one clause a gift row's `detail` leads with — or, when nothing was
 * sent, closes with.
 *
 * Every fact in it comes from a receipt: how many gifts went out, what they were called, who received
 * them, and what the endpoint declared about the price. The anchor's name is the frame's own `receive_nn`,
 * which is a display name — the anchor's id and the room's id belong to the console line, and no
 * identifier may reach an item.
 *
 * `sent` is never empty at a call site (a walk that sent nothing is `unheld` or `failed`), and the guard
 * is written out rather than asserted the way this file writes out every unreachable branch: a sentence
 * instead of 「已送 0 件」.
 */
function giftActClause(sent: readonly SentGift[], reason: string): string {
  if (sent.length === 0) return `未发（${reason === '' ? '没有可送的东西' : reason}）`

  const names = [...new Set(sent.map(gift => gift.name).filter(name => name !== ''))]
  const giftText = names.length === 0 ? '礼物' : names.length === 1 ? `「${names[0]}」` : `礼物（${names.join('、')}）`
  const anchor = sent.find(gift => gift.anchorName !== '')?.anchorName ?? ''
  const to = anchor === '' ? '、响应里没有带出接收主播的名字' : `给${anchor}`
  const why = reason === '' ? '' : `、${reason}`

  return `已送 ${String(sent.length)} 件${giftText}${to}、${chargeClauseOf(sent)}${why}`
}

/** 亲密度任务送礼那一半自己那几句话。见 `GiftWalkWords`。 */
const INTIMACY_GIFT_WORDS: GiftWalkWords = {
  read: GIFT_READ_CLAUSE,
  refused: GIFT_REFUSED_CLAUSE,
  unreached: GIFT_UNREACHED_CLAUSE,
  exhausted: '背包里没有能送的东西了',
  shortClause: GIFT_SHORT_CLAUSE,
  done: sent => `赠送礼物那一半送了 ${String(sent)} 件，这条任务本轮做完`
}

/**
 * 赠送礼物 — 亲密度任务送礼那一半，也就是 `walkGifts` 的一个调用方。
 *
 * **要送几件是服务端自己的数：`taskTotal - taskNum`，从这次运行已经读过的那份任务清单上取。** 它由
 * `giftDemandIn` 算出来（那个差额在这份文件里只有那一个家），这里只把它交给走法。这里不数本系统以前送过
 * 几件，也不信任何本地计数：那个数就是这一天欠的，下一轮再读一次任务清单才是结算它的人 — 所以这一轮把它
 * 送完了，记录里的计数仍然写着这一行「未结」。
 *
 * **清单上一件都没有时是那句话，不是一次失败的发送**：清单是业主的、是对的，而账号今天一件都没有 —
 * `action_stop`，因为下一步是人的：去弄一件来，或者把已有的一件加进清单。
 */
async function sendRowGifts(
  credential: ParsedCredential,
  roomId: number,
  owed: number,
  allowlist: readonly string[],
  log: (line: string) => void
): Promise<GiftRun> {
  return await walkGifts(
    credential,
    roomId,
    INTIMACY_GIFT_WORDS,
    stock => {
      if (firstHeld(stock, allowlist) === null) {
        return {
          stop: {
            verdict: 'unheld',
            sent: 0,
            act: '未发（清单里的礼物今天一件也没有）',
            recordCode: LocalCode.NoGiftHeld,
            clause: NO_GIFT_HELD_CLAUSE,
            failure: 'action_stop'
          }
        }
      }
      return { walk: { want: owed, pick: current => firstHeld(current, allowlist) } }
    },
    log
  )
}

/**
 * One gifting walk, and **the only place in this file that hands an item to a room.**
 *
 * Two actions spend through it — 亲密度任务's 赠送礼物 half and 清仓 — and what they share is the part that
 * must never be written twice.
 *
 * **The order is the safety property: look, decide, then send one at a time.**
 *
 *  1. `GET japi/prop/backpack/web/v5?rid=<R>` — what this account holds *now*. It is read before anything
 *     is sent because every state that ends a walk without sending is decided from it: a list this
 *     account holds none of, and 清仓's nothing-close-enough-to-expiry, are sentences rather than failed
 *     sends, and what *is* held is the bound under what the walk wants.
 *  2. `decide` is asked, **with the stock this read just returned and not with anything cached**, for how
 *     many gifts this walk will try and which item goes next. That is the one seam in this function: an
 *     action's own arithmetic (a task's remainder, a reservation) lives in its own `decide`, and the
 *     sender has no opinion about either.
 *  3. `POST japi/prop/donate/mainsite/v5` — one gift, `propCount=1`, and **its own receipt carries the
 *     whole updated backpack**, so the next round's item needs no second read.
 *  4. Repeat until `want` is reached, the held stock runs out, this run's ceiling is hit, or a call fails.
 *
 * **One at a time, and the receipts are why.** The reference implementation sends a whole batch in one
 * POST when the page has one selected; this sends `propCount=1` per call, as the capture did. Each answer
 * carries the backpack, so a run can stop at exactly the right instant — the moment a receipt says the
 * account holds nothing from the list, and not one gift later — and a refusal costs one gift rather than a
 * batch of them.
 *
 * **A refusal stops the walk, and so does a call that never arrived** — for the same reason: a gift cannot
 * be un-sent, and a request with no answer may well have landed. What the walk knows afterwards is what
 * the receipts it *did* receive said, and it reports that much; the next read of the state that decided
 * `want` is what settles what actually reached the room.
 *
 * **Nothing here reports a reward.** What a task pays is `intimacyBuff` on the task list; what this walk
 * has is what the receipts said — how many gifts went out, what they were called, who received them, and
 * whether the endpoint declared them free.
 */
async function walkGifts(
  credential: ParsedCredential,
  roomId: number,
  words: GiftWalkWords,
  decide: (stock: readonly PropItem[]) => GiftWalkStart,
  log: (line: string) => void
): Promise<GiftRun> {
  const rid = String(roomId)
  const sent: SentGift[] = []

  /** The walk's one failure shape: what did go out, and what stopped it — with the failed call's grade. */
  const failed = (reason: string, recordCode: string, failure: FailureKind, clause: string): GiftRun => ({
    verdict: 'failed',
    sent: sent.length,
    act: sent.length === 0 ? `未送成（${reason}）` : `${giftActClause(sent, '')}；之后一次没能送出：${reason}`,
    recordCode,
    failure,
    clause
  })

  const listed = await callGraded(
    '读取礼物背包',
    () => readGiftBackpack(credential.webCookies, rid),
    credential.webCookies
  )
  if (!listed.ok) return failed(listed.detail, listed.code, 'retry', words.read)
  if (!listed.reply.ok) {
    return failed(
      `读取礼物背包失败：${listed.reply.message}`,
      codeText(listed.reply.code),
      listed.reply.classification,
      words.read
    )
  }

  const start = decide(listed.reply.data)
  if ('stop' in start) return start.stop

  // `GIFTS_MAX_PER_RUN` bounds both callers, and it lives here rather than in either of them: it is "how
  // many gifts one sweep may send", which is a fact about this loop and not about a task list or a
  // backpack. A caller's `want` is its own obligation; this is the runaway guard over it.
  const bound = Math.min(start.walk.want, GIFTS_MAX_PER_RUN)
  let stock: readonly PropItem[] = listed.reply.data
  let pick = start.walk.pick(stock)

  while (pick !== null && sent.length < bound) {
    const propId = String(pick.id)
    const donated = await callGraded(
      '赠送礼物',
      () => donateGift(credential.webCookies, rid, propId),
      credential.webCookies
    )

    if (!donated.ok) return failed(donated.detail, donated.code, 'retry', words.unreached)
    if (!donated.reply.ok) {
      return failed(
        `赠送礼物失败：${donated.reply.message}`,
        codeText(donated.reply.code),
        donated.reply.classification,
        words.refused
      )
    }

    const receipt = donated.reply.data
    const gift: SentGift = { name: receipt.propName, anchorName: receipt.anchorName, charge: receipt.charge }
    sent.push(gift)
    // The console line names the room, which is exactly where an id belongs: the item a person reads says
    // the anchor's name and never the number, and the two audiences are the split 鱼吧's walk makes. It is
    // the same line whichever caller walked, deliberately: since one Task names one action
    // (`reconcileSelectionFor`), the sweep's own prefix already says which action sent it.
    log(
      `赠送礼物「${gift.name === '' ? '未读出名字' : gift.name}」给${gift.anchorName === '' ? UNNAMED_ROOM : gift.anchorName}（房间 ${rid}）：${chargeClauseOf([gift])}`
    )

    if (receipt.backpack === null) {
      // The gift is out and this receipt carried no readable backpack, so the walk cannot know what is
      // left: it stops rather than sending the next one blind. The sentence is the receipt's own, and not
      // `giftActClause`'s: this receipt is where a name, an anchor and a price would have come from, and
      // the run may not report any of the three as read.
      return {
        verdict: 'short',
        sent: sent.length,
        act: `已送 ${String(sent.length)} 件礼物、扣费情况读不出来（这次响应读不出背包：礼物名和接收主播也读不出来），本次不再往下送`,
        recordCode: LocalCode.GiftShort,
        clause: words.shortClause,
        failure: 'none'
      }
    }

    stock = receipt.backpack
    pick = start.walk.pick(stock)
  }

  if (sent.length >= start.walk.want) {
    return {
      verdict: 'sent',
      sent: sent.length,
      act: giftActClause(sent, ''),
      recordCode: LocalCode.GiftsSent,
      clause: words.done(sent.length),
      failure: 'none'
    }
  }

  // Short, and the two reasons stay two facts: one is the stock the last receipt described, the other is
  // this loop's own ceiling. Both leave the obligation unsettled on purpose — nothing here declares a
  // state finished, because a later read of whatever decided `want` is what says how much is left.
  const short = sent.length >= GIFTS_MAX_PER_RUN ? `本次最多送 ${String(GIFTS_MAX_PER_RUN)} 件` : words.exhausted
  return {
    verdict: 'short',
    sent: sent.length,
    act: giftActClause(sent, short),
    recordCode: LocalCode.GiftShort,
    clause: words.shortClause,
    failure: 'none'
  }
}

/**
 * 亲密度任务 — one room's own daily list, read, settled where this action can settle it, and reported.
 * The only per-Room action here.
 *
 * **Two of the three daily rows are never performed here, and each for its own reason.**
 *
 * 1. **The paid row is never attempted.** A daily row's `taskType` decides what may be done about it, and
 *    `taskType === 2` — 「送出“全力守护”礼物」, whose `taskWhiteGiftId` is `24478` — is a **paid** gift.
 *    Success would spend the owner's money on a public donation that cannot be un-sent, so a branch for it
 *    does not exist: not gated, not enabled by a setting, absent. Nothing here even reads `taskWhiteGiftId`
 *    to find it, because the same field carries `24468` on the free row: one name, two different things.
 * 2. **The 弹幕 row is reported, not performed.** `send_danmaku` already sends a danmaku and the server
 *    credits this task from it, so a second message from here would be a second *public* bullet for the
 *    same 10 亲密度 — and someone who switched this action on without 发送弹幕 would get public messages
 *    from an action named 亲密度任务. That is the division of labour the glossary's **Free action** entry
 *    describes: an act this system performs for another purpose is also the Platform's task, so an
 *    action's *reason* and a task's *reward* are two facts and a result states both. The consequence is
 *    named rather than hidden: with 发送弹幕 off, today's danmaku task stays outstanding and this action
 *    reports it so, `blocked` with `failure: 'none'` — no 动作受阻 alarm, because nothing is broken, and
 *    the day is not settled, so the sweep keeps watching the room.
 *
 * **The 赠送礼物 row is the one this action performs**, and it is bounded four ways over: by the list a
 * person wrote (`giftAllowlistIn`), by what the account actually holds (the backpack read), by the number
 * the server still wants (`taskTotal - taskNum`) and by this adapter's own per-run ceiling. A gift is
 * public and cannot be un-sent, which is why the list is a person's decision rather than a filter invented
 * here — see `sendRowGifts` for the walk and `giftAllowlistIn` for why no first-party flag can replace it.
 *
 * **Outstanding is the server's own counter** (`taskNum < taskTotal`), never a local count and never
 * `taskStatus` — see `roomDailyTaskSchema` for the weekly read a `taskStatus` judgement calls done.
 *
 * **The scope is the daily list.** `data.dayTasks` is what resets daily and what an act of this system
 * can settle; the `weekTasks` in the same body move by days of activity, and a weekly row treated as an
 * outstanding task would make `done` unreachable for every room — the action would never settle a day
 * again, for a reason that has nothing to do with anything outstanding. See `roomTaskListSchema`.
 *
 * One `userTaskList` call per run, at most one backpack read, one gift POST per gift the row still wants,
 * and one item per daily task. The row a person reads is that room's own task, named by the service's own
 * `taskName`, carrying the service's own numbers for progress and reward. There is no global "today is
 * done" field — rooms 12306 and 12293234 read differently at the same instant — so what this settles is
 * **that room's** list, which is the only claim the Platform makes.
 *
 * Nothing here needs CSRF and nothing mints one; see `readRoomDailyTasks`. The transport contract is
 * `callGraded`'s, like every other action in this file: a call that never arrived is graded `retry` and
 * never escapes `reconcile` — including a gift that may have landed, whose row is reported from the
 * receipts that did arrive.
 */
async function reconcileIntimacyTasks(
  context: ReconcileContext,
  credential: ParsedCredential | null
): Promise<ActionOutcome> {
  const key = ActionKey.IntimacyTasks
  const targetKey = context.targetKey.trim()
  const roomId = roomIdOf(targetKey)
  if (roomId === null) {
    // A key that is not a room number cannot start working later: parking the action beats retrying a
    // typo forever, the same grading `probe` gives it.
    return roomOutcome(key, targetKey, 'failed', '目标不是有效的斗鱼房间号', LocalCode.BadTarget, 'action_stop')
  }

  if (credential === null) {
    return roomOutcome(key, targetKey, 'failed', NO_CREDENTIAL_DETAIL, LocalCode.NoCredential, 'account_stop')
  }

  if (credential.webCookies.trim() === '') {
    // The same precondition 粉丝家园签到 reports and the same sentence shape: this family authenticates
    // by web session, so a request without one would answer an identity refusal that a person would go
    // looking at the token for. Nothing is sent, and `action_stop` raises 动作受阻 for it, which is how
    // the re-bind this needs becomes visible without opening a log.
    return roomOutcome(
      key,
      targetKey,
      'blocked',
      '未结算、账号没有网页会话（重新扫码绑定一次，这个动作会自己继续）',
      LocalCode.NoWebSession,
      'action_stop'
    )
  }

  const demand = await readRoomGiftDemand(credential, roomId)
  if (!demand.ok) return roomOutcome(key, targetKey, 'failed', demand.detail, demand.code, 'retry')

  const reply = demand.reply
  if (!reply.ok) {
    return roomOutcome(
      key,
      targetKey,
      'failed',
      `读取亲密度任务失败：${reply.message}`,
      codeText(reply.code),
      reply.classification
    )
  }

  const allowlist = giftAllowlistIn(context.options[key])

  // **The walk runs before the rows are judged**, because the row it is about is judged from what it did:
  // `judgeDailyTask` is a pure function over one row, and this is the one step here that buys a request —
  // or spends a gift. It runs only when there is something to send, which is an outstanding 赠送礼物 row
  // **and** a non-empty allowlist, so a run with nothing to do reads no backpack and sends nothing.
  //
  // The row and the number both come from `readRoomGiftDemand`, which is also what 清仓 reserves against.
  // A second 赠送礼物 row is judged `unknown` by `judgeDailyTask` rather than reported against a walk that
  // never ran for it: two rows of this type has never been seen, and a sent-count claimed for one of them
  // would be a claim about a shape nobody captured.
  const giftRow = reply.data.row
  const gift =
    giftRow === null || allowlist.length === 0
      ? null
      : await sendRowGifts(credential, roomId, reply.data.owed, allowlist, context.log)

  const judged = reply.data.tasks.map(task => judgeDailyTask(task, allowlist, task === giftRow ? gift : null))
  const [first, ...rest] = judged
  if (first === undefined) {
    // An empty daily list is a response this build has never seen — both captured rooms listed three —
    // so it is read fail-closed: either the account holds no 粉丝牌 in this room, or the service
    // answered from a session it no longer treats as one. `blocked` rather than `skipped`, because the
    // second reading settled as "nothing to do" is how a dead session becomes a task that looks healthy.
    return roomOutcome(
      key,
      targetKey,
      'blocked',
      '未结算、这个直播间没有下发每日任务（要么账号在这里没有粉丝牌，要么清单是空的）',
      LocalCode.NoDayTasks,
      'none'
    )
  }

  context.log(`亲密度任务：${judged.map(task => task.line).join('、')}`)
  return roomDailyTasksOutcome(key, targetKey, [first, ...rest])
}

/* ------------------------------------------------------------------ *
 * 清仓 —— 送出即将过期的免费道具
 * ------------------------------------------------------------------ */

/**
 * 到期前多久开始倒：**24 小时**。
 *
 * **一个常量而不是一个参数，这是设计里明写的一条**：一个可以填错的窗口不是一个好参数。填短了的代价是
 * 道具在窗口打开之前就过期了——那正是这个动作存在的理由没了；填长了的代价是把还有几天寿命的道具提前倒
 * 出去，而送礼是公开且收不回来的。24 小时是唯一一个「明天就没了」的读数，它落在两个坏值中间。
 */
const CLEAROUT_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * 背包行的 `met` 是**秒**，不是毫秒。
 *
 * 实测：`met: 1791734399` 是 2026-10-11 23:59:59（+08），而 `Date.now()` 那一侧的同一时刻是
 * `1791516489`（2026-10-09 03:28 UTC）——两个数同一个量级，差的是两天而不是十万倍。同一份抓包的
 * `nowtime`（`1791454940`）与徽章页的 `data-fans-gbdgts`（`1762106984`）也都是秒，所以这不是一行特例，
 * 是这一族自己的单位。
 */
const CLEAROUT_MET_UNIT_MS = 1000

/**
 * 清仓自己的四句话。见 `GiftWalkWords`。
 *
 * 它和 亲密度任务 说的是同一次 POST，但两个动作的 `detail` 是两行给同一个人看的字，所以措辞各自一份：
 * 一行说「赠送礼物那一半」，一行说「清仓」。
 */
const CLEAROUT_WORDS: GiftWalkWords = {
  read: '清仓没能开始：背包没读出来，一件道具都没有送',
  refused: '清仓停了：服务端拒绝了送礼，剩下的下一轮再试',
  unreached: '清仓停了：有一次送礼请求没有回音——那一件可能已经送出去了，剩下的下一轮再看',
  exhausted: '能倒的都倒出去了',
  shortClause: '清仓没倒完：能倒的都倒出去了，剩下的下一轮接着倒',
  done: sent => `清仓把 ${String(sent)} 件即将过期的免费道具送进了那个直播间`
}

/** 清单里这时能倒的一件道具，连同它的到期时刻。 */
interface DueProp {
  /** 道具 id，字符串形式——它同时是清单里的那个值。 */
  readonly id: string
  /** 账号现在持有几件。 */
  readonly count: number
  /** 到期时刻，毫秒。 */
  readonly expiresAt: number
}

/**
 * 清仓看存货的那一眼：能倒哪些，以及两件**不能当成可倒**的事各有多少。
 *
 * `due` 是能倒的，另外两个计数是**读不出**和**已经过去**的道具**种数**——它们都不倒，但它们是两个不同的
 * 事实，一条记录里要能分清：「这个字段我们读不出来」是这一版的合同变了，「这件东西已经过期了」是服务的
 * 事实。
 */
interface DuePlan {
  readonly due: readonly DueProp[]
  /** 清单里持有、但 `met` 缺失或不是正数的道具种数。 */
  readonly unknownExpiry: number
  /** 清单里持有、但到期时刻已经过去的道具种数。 */
  readonly alreadyPast: number
  /** 清单里持有、还没到期的最早那一刻（毫秒），没有就是 `null`。 */
  readonly soonestFuture: number | null
  /** 清单里持有几件（只数持有量大于 0 的行）。为 0 就是「清单里的道具今天一件都没有」。 */
  readonly held: number
}

/**
 * 存货里哪些能在这一轮倒掉，按到期时刻从早到晚。
 *
 * **判据是 `met`：道具的绝对到期时刻。** 这是实测而不是推断——`met = 1791734399` 与官方前端自己的
 * `getRestTime(expiry) - 1s` 秒级吻合（`expiry: 4` 的那条算出来正好落在同一秒），而 `met` 在同一天的
 * 三次读里取值完全不变、停在 3 天之后，所以它不是「领取时刻」也不是一个倒数的计数器。
 *
 * **`expiry` 与 `exp` 不参与判断，而且这是有意的。** `expiry` 是同一个事实的另一种单位（天），`exp` 只
 * 见过 1、含义未证；把两个来源都读进来判一次，就是把一个日期放在两个家里，而这一整轮在消的正是这件事。
 * 判据只有 `met`，它读不出来时这一版**不倒**：倒早了的代价是公开且收不回来，倒晚了的代价是那几件免费货
 * 没了——两侧不对称，所以取保守的一侧，并且说出来。
 */
function duePlanIn(stock: readonly PropItem[], allowlist: readonly string[], now: number): DuePlan {
  const allowed = new Set(allowlist)
  const due: DueProp[] = []
  let unknownExpiry = 0
  let alreadyPast = 0
  let soonestFuture: number | null = null
  let held = 0

  for (const item of stock) {
    const id = String(item.id)
    if (!allowed.has(id)) continue
    if (item.count <= 0) continue
    held += item.count

    const met = item.met
    if (met === undefined || met <= 0) {
      unknownExpiry += 1
      continue
    }

    const expiresAt = met * CLEAROUT_MET_UNIT_MS
    if (expiresAt <= now) {
      alreadyPast += 1
      continue
    }
    if (soonestFuture === null || expiresAt < soonestFuture) soonestFuture = expiresAt
    if (expiresAt - now <= CLEAROUT_WINDOW_MS) due.push({ id, count: item.count, expiresAt })
  }

  // 到期时刻最近的先倒，这是设计里那句话（「最快的先送」）；同刻的两件按清单自己的顺序排，因为清单的顺序
  // 是业主人勾选的顺序，这一侧没有理由替他改。
  due.sort((left, right) => left.expiresAt - right.expiresAt)
  return { due, unknownExpiry, alreadyPast, soonestFuture, held }
}

/**
 * 这一轮倒多少、下一件倒什么 —— **保留量就落在这里**。
 *
 * 保留量的算法：每一件可倒的道具**各自**留下 `reserved` 件，只倒超出它的那部分。
 *
 * **为什么不是「一共留 `reserved` 件」。** 留够件数在账号里，不等于把这 `reserved` 件留给续牌：续牌的
 * 清单是另一个动作的另一份（两个动作两份清单），它只从**它**的清单里取货，而这一侧看不见那份清单——
 * `ReconcileContext.options` 只装这次运行那个动作的选项（`runOptions` 在 `scheduler/runner.ts` 里就是
 * 这么建的）。一个算得出来的例子：清单是 {268: 60 件, 3410: 3 件}、保留量是 5，按「一共留 5 件」算这一轮
 * 可以倒 58 件，而 268 会被倒到只剩 2 件——续牌那天它要 5 件，只有 2 件。按「每件各留 5 件」算，268 只
 * 会倒到剩 5 件。两个算法的差别是 3 件白倒出去的道具；**留多的代价就这么多，留少的代价是续牌那天没货**，
 * 所以取保守的一侧，而保守的那一侧就是每件各留。
 *
 * 保留量本身不落盘、每次从读数重算：它是服务端今天还差几件，明天就不一样了。
 */
function clearoutWalkIn(due: readonly DueProp[], reserved: number): GiftWalkPlan {
  const slack = new Map(due.map(prop => [prop.id, Math.max(0, prop.count - reserved)]))
  let want = 0
  for (const left of slack.values()) want += left

  return {
    want,
    // `due` 已经按到期时刻排好，这里只是跳过没有额度的那些。额度在这一步扣减而不是等发出去之后再扣，因为
    // 这个走法一旦出手就只有两种结局：这一件发成功，或者整轮停在这里——没有「选了但没发」的第三态。
    pick: stock => {
      for (const prop of due) {
        if ((slack.get(prop.id) ?? 0) <= 0) continue
        const inStock = stock.find(item => String(item.id) === prop.id)
        if (inStock === undefined || inStock.count <= 0) continue
        slack.set(prop.id, (slack.get(prop.id) ?? 0) - 1)
        return inStock
      }
      return null
    }
  }
}

/** 一个牌子房间在这次运行里的事实：它是谁（一个显示名），以及它为保留量出了几件。 */
interface ClearoutRoom {
  readonly label: string
  readonly owed: number
}

/** 一次走法的一个「什么都没倒」结局，形状与走法自己的结局完全一样。 */
function clearoutStop(recordCode: string, failure: FailureKind, act: string, clause: string): GiftWalkStart {
  return { stop: { verdict: 'unheld', sent: 0, act, recordCode, clause, failure } }
}

/** 「清单里没有快到期的东西」那句话里的事实，能算出来的才写。 */
function nothingDueAct(plan: DuePlan, now: number): string {
  const facts: string[] = []
  if (plan.soonestFuture !== null) {
    const hours = Math.ceil((plan.soonestFuture - now) / 3_600_000)
    facts.push(`最近的一件还有 ${String(hours)} 小时才到期`)
  }
  if (plan.alreadyPast > 0) facts.push(`另有 ${String(plan.alreadyPast)} 种已经过了到期时刻`)
  const detail = facts.length === 0 ? '' : `；${facts.join('、')}`
  return `未倒（清单里没有进入到期前 24 小时的道具${detail}）`
}

/**
 * 这一次走法的开头：看着刚读到的那份存货，回答「倒什么」，或者「这一轮什么都不倒，这是那句话」。
 *
 * 判断的**顺序**是有意的，而且每一步都比后一步更保守：一件都没有（清单的问题）→ 到期时刻读不出来（这一版
 * 的问题）→ 都还没到期（时间的问题）→ 被保留量吃光（另一个动作的问题）→ 才轮到倒。任何一步成立，这一轮
 * 都不出手，而且这一轮花的唯一一次 HTTP 就是刚读完的背包。
 */
function clearoutStart(
  stock: readonly PropItem[],
  allowlist: readonly string[],
  reserved: number,
  now: number
): GiftWalkStart {
  const plan = duePlanIn(stock, allowlist, now)

  if (plan.held === 0) {
    return clearoutStop(LocalCode.NoGiftHeld, 'action_stop', '未倒（清单里的道具今天一件也没有）', NO_PROP_HELD_CLAUSE)
  }
  if (plan.due.length === 0) {
    if (plan.unknownExpiry > 0) {
      return clearoutStop(
        LocalCode.ExpiryUnknown,
        'action_stop',
        `未倒（清单里有 ${String(plan.unknownExpiry)} 种道具的到期时刻读不出来，这一版不送它们）`,
        UNKNOWN_EXPIRY_CLAUSE
      )
    }
    return clearoutStop(LocalCode.NothingExpiring, 'none', nothingDueAct(plan, now), NOTHING_EXPIRING_CLAUSE)
  }

  const walk = clearoutWalkIn(plan.due, reserved)
  if (walk.want === 0) {
    return clearoutStop(
      LocalCode.AllReserved,
      'none',
      `未倒（能倒的都被续牌的保留量占着：这一轮为牌子房间留了 ${String(reserved)} 件）`,
      ALL_RESERVED_CLAUSE
    )
  }

  return { walk }
}

/**
 * 清仓 —— 送出即将过期的免费道具。账号级，而且是这里最不能出错的一条。
 *
 * **它是一次「留够再倒」，而留多少是算出来的，不是填的。** 一次运行四步：
 *
 *  1. 读**偏好设置**里的两个参数：`默认倾泻直播间`（一个房间号）与 `允许使用的道具`（一份 id 清单）。
 *     两个都缺一不可，而且都只由人提供——这个动作自己不挑一件道具去倒。
 *  2. 读徽章墙（`getFansBadgeList`）拿**牌子房间**，再对每个房间读一次 `userTaskList`，问出它今天还差几件
 *     「赠送礼物」。那些差额加起来就是**保留量**：续牌（`intimacy_tasks` 送礼那一半）今天要用的份数。
 *  3. 读背包（`japi/prop/backpack/web/v5`），挑出清单里、账号真有、`met` 落在 24 小时内的那些，按到期
 *     时刻从早到晚。
 *  4. 一件一个 POST 送去收件房间，走法与 亲密度任务 送礼那一半是**同一个**（`walkGifts`）：一件一个请求、
 *     回包里带着新存货、拒了就停、回包读不出背包也停、每件都报有没有扣费。
 *
 * **为什么保留量是每件道具各留，而不是从总数里留。** 见 `clearoutWalkIn`：续牌的清单是另一个动作的另一份，
 * 这一侧看不见它，所以「每件各留」是唯一一个不可能留少的算法。留多的代价是少倒几件（无害），留少的代价是
 * 续牌那天没货（真损失）。
 *
 * **读不出保留量时它一件都不倒。** 只有两种情形：某个牌子房间的任务清单没读出来（`failed` + `retry`，下一
 * 轮再试），或者徽章墙空了（`blocked` + `no_badges`）。第二种是保守一侧的选择，而且理由要说清：**一个没有
 * 牌子的账号本来就不需要留什么**，所以真正要防的不是这个读法，而是「徽章墙明明有牌子、这一版却一行都没认出来」
 * ——那种读法同样是空清单，而它会把整个背包倒进那个房间。实测过的一条只否掉了第三种可能：没有登录时这个页面
 * **302 跳转、响应体是空的**（本仓自己的探针跑过），而 `readFanBadges` 对非 2xx 是抛错，所以「会话死了」表现
 * 为 `failed`，不表现为空清单。（读不到就一条都不倒的另一半理由在 `readDouyuMedalRooms` 的注释里：同一份读数，
 * 表单要的是「读到了什么」，花钱要的是「能不能现在动手」，两个问题不一样。）
 *
 * **它的目标键是空的**（`needsTarget: false`）：收件房间来自偏好，不来自任务的目标，所以这是账号级的记录
 * ——`types.ts` 把空键留给「关于账号本身」的动作。
 *
 * 每次运行的请求数：1 次徽章墙 + N 次任务清单（N 是牌子数）+ 1 次背包 + 每件道具 1 次 POST。前三步都是读。
 */
async function reconcileClearout(
  context: ReconcileContext,
  credential: ParsedCredential | null
): Promise<ActionOutcome> {
  const key = ActionKey.Clearout
  if (credential === null) return noCredentialOutcome(key)

  if (credential.webCookies.trim() === '') {
    // The same precondition 亲密度任务 reports, and for the same reason: the send this action makes is on
    // the `japi/prop` family, whose captured identity is the web session alone. `action_stop` is what turns
    // it into 动作受阻 without the person having to open a debug panel.
    return accountOutcome(
      key,
      'blocked',
      '未倒：账号没有网页会话（重新扫码绑定一次，这个动作会自己继续）',
      LocalCode.NoWebSession,
      'action_stop'
    )
  }

  const options = context.options[key]
  const dumpRoom = dumpRoomIn(options)
  if (dumpRoom === null) {
    // Two readings of one empty cell — nothing stored, and something stored that is not a room number — and
    // both end the same way: this action has nowhere to send to, so it sends nothing.
    return accountOutcome(
      key,
      'blocked',
      '未倒：还没有选好「默认倾泻直播间」（在偏好设置里从自己关注的直播间里挑一个）',
      LocalCode.NoDumpRoom,
      'action_stop'
    )
  }

  const allowlist = idListIn(options, 'propAllowlist')
  if (allowlist.length === 0) {
    return accountOutcome(
      key,
      'blocked',
      '未倒：账号里还没有「允许使用的道具」清单，这一版不会自己挑一件倒（在偏好设置里勾）',
      LocalCode.NoPropAllowlist,
      'action_stop'
    )
  }

  const badges = await callGraded(
    '读取粉丝牌',
    () => readFanBadges(credential.token, credential.webCookies),
    credential.token,
    credential.webCookies
  )
  if (!badges.ok) return transportFailure(key, badges)

  const medals = badges.reply.badges
  if (medals.length === 0) {
    return accountOutcome(
      key,
      'blocked',
      '未倒：粉丝牌清单是空的（要么账号一枚牌子都没有，要么这一版一行都没认出徽章墙上的行）——保留量算不出来，这一版不拿整个背包去赌一句空清单',
      LocalCode.NoBadges,
      'action_stop'
    )
  }

  // **The reservation, room by room, through the one reader both actions call.** A room whose list cannot be
  // read leaves the reservation unknown, and an unknown reservation sends nothing: over-reserving costs a
  // few unsent items, under-reserving costs the medal day.
  const rooms: ClearoutRoom[] = []
  let reserved = 0
  for (const medal of medals) {
    const roomId = roomIdOf(medal.roomId)
    if (roomId === null) {
      return actionFailure(key, LocalCode.Protocol, '未倒：粉丝牌清单里有一条的房间号读不出来，保留量算不出来', 'retry')
    }

    const demand = await readRoomGiftDemand(credential, roomId)
    const label = medal.anchorName === '' ? UNNAMED_ROOM : medal.anchorName
    if (!demand.ok) {
      return actionFailure(
        key,
        demand.code,
        `未倒：「${label}」今天还差几件礼物读不出来，保留量算不出来，这一轮一件都不倒。${demand.detail}`,
        'retry'
      )
    }
    if (!demand.reply.ok) {
      return actionFailure(
        key,
        codeText(demand.reply.code),
        `未倒：「${label}」今天还差几件礼物读不出来，保留量算不出来，这一轮一件都不倒。读取亲密度任务失败：${demand.reply.message}`,
        demand.reply.classification
      )
    }

    reserved += demand.reply.data.owed
    rooms.push({ label, owed: demand.reply.data.owed })
  }

  const run = await walkGifts(
    credential,
    dumpRoom,
    CLEAROUT_WORDS,
    stock => clearoutStart(stock, allowlist, reserved, context.now),
    context.log
  )

  // 走法的四个判定落成记录：送满了是做完，没送满或什么都没得送是受阻，一次请求失败才是失败。
  const outcome: ActionOutcomeValue = run.verdict === 'failed' ? 'failed' : run.verdict === 'sent' ? 'done' : 'blocked'

  const counts = `牌子 ${String(rooms.length)} 个、保留 ${String(reserved)} 件、本次送出 ${String(run.sent)} 件`
  context.log(`清仓：${counts}（房间 ${String(dumpRoom)}）`)

  return {
    actionKey: key,
    targetKey: TARGET_KEY_ACCOUNT_SCOPED,
    outcome,
    code: run.recordCode,
    detail: run.clause === '' ? counts : `${counts}；${run.clause}`,
    failure: run.failure,
    items: [
      // 这一次的行为本身，先列出来：它的 `outcome` 就是记录的 `outcome`，所以「记录说 done、底下的条目说
      // 另一件事」在这个动作里不可表达——`types.ts` 要的那条不变量由构造保证，而不是靠一个测试。
      { kind: 'account', label: actionLabelOf(key), outcome, detail: run.act, code: run.recordCode },
      // 然后是保留量的逐房间账：这一轮为每个牌子房间留了几件、因为什么。这是这个动作唯一一处「跨动作耦合」
      // 落到人眼前的地方，缺了它，下一个人会以为倒出去的件数对不上是漏了。
      ...rooms.map(room => ({
        kind: 'room' as const,
        label: room.label,
        outcome: (room.owed > 0 ? 'blocked' : 'already') as ActionOutcomeValue,
        detail:
          room.owed > 0
            ? `今天还差 ${String(room.owed)} 件礼物（这一轮为它留了 ${String(room.owed)} 件）`
            : '今天不需要礼物',
        code: String(room.owed)
      }))
    ]
  }
}

/* ------------------------------------------------------------------ *
 * 粉丝家园钓鱼 — 一轮：抛竿 → 等到服务端报的时刻 → 收竿
 * ------------------------------------------------------------------ */

/** 「钓几次」 read as nothing at all. One cast — 20 bait — is the conservative end of the option. */
const FISHING_DEFAULT_CASTS = 1

/**
 * The ceiling on one run's casts, whatever 「钓几次」 says.
 *
 * A runaway guard rather than a cadence: the option is a number a person types, and a stray digit —
 * 100 where 1 was meant — would otherwise spend 2000 bait in one sweep. Ten casts is 200 bait at the
 * measured price, and the panel's own `cnt` is the bound under that.
 */
const FISHING_MAX_CASTS_PER_RUN = 10

/**
 * The longest one wait may sleep, in ms.
 *
 * The wait itself is the instant the service named (`fishing.fishEtMs`), so this is not the cadence
 * of anything: it is what keeps a `fishEtMs` in the wrong unit — the capture's own value read as
 * seconds lands in 1970 — from parking a sweep for hours. Past it the panel is read again and the
 * wait resumes, so a long legitimate wait costs reads and never a verdict.
 */
const FISHING_WAIT_CEILING_MS = 90_000

/**
 * How many times a run looks again after a wait before it gives up on `stat: 1 → 2`.
 *
 * One is the normal case: the wait ends at the instant the service itself named. The extra rounds
 * are for a service that is a beat late, and they are bounded because a panel that never says `2` is
 * a state this build does not understand and has to report rather than wait out.
 */
const FISHING_LOOK_AGAIN = 3

/** The one sentence for a panel that marks no bait as in use, in the two places that can see it. */
const NO_BAIT_IN_USE = '未抛竿：面板里没有标记「在用」的鱼饵（在粉丝家园里选中一枚，这个动作不会替你换饵）'

/**
 * The two instants a window prints as, on the Platform's own clock — 「18:00–19:00」.
 *
 * `time.ts` owns the day boundary and this is not one: it is the rendering of two epoch seconds the
 * panel sent, in the zone the same clock says Douyu runs on. **An `et` that lands on midnight prints
 * `00:00`**, which is the Platform's own 0–23 clock and not a duration — its panel reports `hour` the
 * same way — so the 12:00–24:00 window of the 2026-10-07 capture reads `12:00–00:00` here.
 */
const fishingClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: DAY_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

/** One instant from the panel in the Platform's own clock, or `''` when the panel carries none. */
function fishingClockText(seconds: number): string {
  return seconds > 0 ? fishingClock.format(new Date(seconds * 1000)) : ''
}

/**
 * The window one panel reported, as the two clock readings a person compares — 「18:00–19:00」 — or
 * `null` when it reported no usable pair.
 *
 * **`null` rather than `''`, and the difference is a sentence either way**: both readers of this
 * value have to tell "no window" from a window (the page prints 「服务端这次没有报窗口」, a run's record
 * prints 「服务端本次没有报钓鱼窗口」), and an empty string is one `if` away from being printed as a
 * window of nothing. The rendering itself is `fishingClock`'s, which is why an `et` landing on
 * midnight reads `00:00` — see that constant.
 */
function windowTextOf(match: FishingMatchInfo): string | null {
  const from = fishingClockText(match.st)
  const to = fishingClockText(match.et)
  return from === '' || to === '' ? null : `${from}–${to}`
}

/**
 * The window a panel reported, as **the record** states it — and the one job that window still has.
 *
 * It used to be a gate: `st`/`et` were compared against the local clock before every cast, and a
 * cast outside them was refused with `window_not_open`. The measurement says that is wrong — see
 * `fishingMatchInfoSchema` in `protocol.ts` for the 614 s-early cast the service accepted and paid
 * for — so the window is now reported instead: it is what tells a **person** when this room's match
 * is, which is the whole of "when to come back and settle".
 *
 * **A person, and not the sweep under it — the earlier wording claimed both and only one is real.**
 * It read "(and the next sweep)", which would mean something in this project re-reads these two
 * instants to decide when to come back; nothing does. `st`/`et` are read by `fishingWindowClause`
 * alone, their only consumer is the sentence it builds, and the cadence that decides when the next
 * attempt happens is the task's own interval (`defaultIntervalSeconds` 300, above) — a number that
 * is not derived from either instant. If a later change makes the sweep wait on the window, this
 * paragraph is what has to be rewritten first.
 *
 * `stat` is printed verbatim and never interpreted, and that is the same measurement again: the
 * panel behind that early accepted cast said `stat: 1`, and the panel behind a cast accepted inside
 * its window said `stat: 0`. Two values, both with a cast the service took, so no value of it can be
 * read as a permission. What is *not* printed is `hour`/`left`/`lhour`: unmodelled, unread, and a
 * field nothing reads is the field the next reader decides to gate on.
 */
function fishingWindowClause(match: FishingMatchInfo): string {
  const windowText = windowTextOf(match)
  if (windowText === null) return '服务端本次没有报钓鱼窗口'
  return `服务端报的钓鱼窗口 ${windowText}（matchInfo.stat ${String(match.stat)}）`
}

/**
 * The three things a 钓鱼 panel says about one Room, in the one shape both of its readers need.
 *
 * **Why this is one exported function rather than three private helpers.** A task page shows the
 * two preconditions a cast needs and the window the service reports for that Room, and it once
 * mirrored `fishingHasCharacter`, `inUseBait` and this module's clock privately — one reading with
 * two homes, which is the state every round here spends its time deleting. The route
 * (`routes/douyu-options.ts`) calls this now, and the readings have one author.
 *
 * **What is shared is the reading; the sentences stay separate, and that is deliberate.** This
 * module's sentences are a *run's report* — 「未抛竿：…」 for a refusal, `fishingWindowClause` for a
 * record's line — and the route's are *page wording*: 「还没有设置（在粉丝家园里设一次，这个动作不会替你做）」
 * tells a person standing in front of a Room what is the case and where to change it, while the log's
 * sentence tells whoever reads it why the action stopped. Merging them would make a refusal read like
 * a page and a page read like a log line, so each survives where its reader is. What may not be
 * written twice is the *reading* — a present `myCh`, the row marked `inUse: 1`, and the two instants —
 * and that is exactly what this returns.
 */
export interface FishingPanelFacts {
  /** Whether the panel reports an 形象. See `fishingHasCharacter` for the measurement behind it. */
  readonly hasCharacter: boolean
  /** The bait a cast goes out with, or null when the panel marks none in use. */
  readonly bait: FishingBait | null
  /**
   * The window the panel reports for this Room's match, or null when it reported none.
   *
   * Printed and never compared: the cast the service accepted and paid for went out 614 s before the
   * window it was read beside (`fishingWindowClause` has the measurement), so this is a fact to show
   * a person rather than a gate.
   */
  readonly windowText: string | null
}

/** The one read of one Room's 钓鱼 panel, for every reader of it. */
export function fishingPanelFacts(panel: FishingPanel): FishingPanelFacts {
  return {
    hasCharacter: fishingHasCharacter(panel),
    bait: inUseBait(panel),
    windowText: windowTextOf(panel.matchInfo)
  }
}

/**
 * Whether the panel reports an 形象.
 *
 * `myCh` is the field, and all the evidence says about it is that a **non-empty** one means an 形象
 * is set — the reference implementation gives up on a falsy one. What "empty" is for the service is
 * not established, so this reads presence the way the reference does, and nothing inside `myCh` is
 * read at all: `uid`, `wear`, `clv` and `exp` travel in there and none of their meanings is.
 */
function fishingHasCharacter(panel: FishingPanel): boolean {
  const character = panel.myCh
  return typeof character === 'object' && character !== null && !Array.isArray(character)
}

/** The bait a cast goes out with: the row the panel marks `inUse: 1`, or null when it marks none. */
function inUseBait(panel: FishingPanel): FishingBait | null {
  return panel.baits.find(row => row.inUse === 1) ?? null
}

/**
 * How long to sleep before looking at the panel again, in ms.
 *
 * The instant is the service's own `fishEtMs` — captured: the cast answered `fishEtMs` 60 s after it
 * went out, matching the `timePerRod` beside it — and this function only clamps it: to `0` for an
 * instant that has already passed, and to `FISHING_WAIT_CEILING_MS` for one absurdly far off. It takes
 * the `fishing` block rather than a panel because both shapes carry one: a `homePage` panel and a
 * cast's own answer.
 *
 * **A block with no `fishEtMs` sleeps for no time at all**, and that is the deliberate half. The
 * captured `stat: 1` panels all carry the instant, so an absent one is a contract change — and a
 * duration invented here (`timePerRod`, say) would turn it into a minute of waiting per round, three
 * rounds deep, ending in a report that says the same thing the first look would have. Sleeping zero
 * and looking again costs one read; the caller's rounds are bounded, so it can never spin.
 *
 * The clock is `Date.now()` and not `context.now`: `now` is the instant the sweep started, while a
 * wait is measured against the clock that advances during it.
 */
function fishingWaitMs(fishing: FishingState): number {
  if (fishing.fishEtMs <= 0) return 0
  return Math.min(Math.max(fishing.fishEtMs - Date.now(), 0), FISHING_WAIT_CEILING_MS)
}

/**
 * What one cast spent, as the difference between the two readings that bracket it — or `0` when the
 * two cannot be compared.
 *
 * **The pair is the whole reason this is a function.** `before` has to be the panel read *nearest*
 * the cast and `after` has to be the cast's own response, with nothing in between: an earlier
 * reading gives `0`, and `0` is the number this project carried for a while under the heading
 * "casting is free". Reeling spends nothing and was measured to change no `cnt`, so the reading
 * taken before a cast is still the reading nearest it even when a reel-in sits between the two.
 *
 * A difference that is not positive is reported as no cost rather than as a negative price: a
 * lottery payout landing between the readings (`userLottery` hands out bait) would make the
 * subtraction measure the payout instead of the cast, and this build claims nothing about a cast it
 * could not measure.
 */
function fishingSpent(before: FishingBait, after: FishingCast): number {
  const row = after.baits.find(candidate => candidate.id === before.id)
  if (row === undefined) return 0
  return row.cnt < before.cnt ? before.cnt - row.cnt : 0
}

/**
 * What `reelIn` said came with the fish, as a clause, or `''`.
 *
 * **The one observed cycle answered `awards: []`**, so this reports what the Platform sent and never
 * invents a reward: an empty array is a line with no award clause rather than a zero dressed up as
 * one. The names are the reference implementation's expectation and not a capture, which is why a
 * row whose fields do not read as that shape degrades to a count instead of losing the fish.
 */
function fishingAwardClause(awards: FishingReelIn['awards']): string {
  if (awards.length === 0) return ''
  const named = awards
    .filter(award => award.awardName !== '')
    .map(award => `${award.awardName}×${String(award.awardNum)}`)
  if (named.length > 0) return `奖 ${named.join('、')}`
  return `另附 ${String(awards.length)} 项奖励（名字没读出来）`
}

/**
 * One 图鉴 read, as the two numbers a run reports and the one lookup an item needs.
 *
 * A map keyed by the service's own `fishId` rather than the rows themselves: every question asked of
 * a codex here is "does it list *this* fish, and is it registered", and a caller walking an array for
 * that would spell the same walk three times.
 */
interface FishingCodexFacts {
  /** How many species the list holds. Not the payload's own `total`; see `fishingCodexSchema`. */
  readonly species: number
  readonly entries: ReadonlyMap<number, FishingCodexSpecies>
}

/** One species as a read found it. */
interface FishingCodexSpecies {
  /** The service's own name, or `''` when it sent none. */
  readonly name: string
  /** Whether it was already caught when *this* read was taken. See `fishingCodexEntrySchema`. */
  readonly registered: boolean
}

/** One read's rows, as the facts above. */
function codexFactsOf(entries: readonly FishingCodexEntry[]): FishingCodexFacts {
  const byFish = new Map<number, FishingCodexSpecies>()
  for (const entry of entries) {
    byFish.set(entry.fishId, { name: entry.name, registered: entry.firstLight > 0 })
  }
  return { species: entries.length, entries: byFish }
}

/** How many species one read found already caught. */
function fishingRegisteredIn(facts: FishingCodexFacts): number {
  let count = 0
  for (const species of facts.entries.values()) if (species.registered) count += 1
  return count
}

/**
 * One reel's species, as the 图鉴 read **before this run's first cast** described it.
 *
 * Two facts and no promise: the service's own name for the fish, and whether the codex already listed
 * it as caught. Whether *this* cast is what registered it is a question only the read after the run
 * can answer, and the record states that answer — so an item never claims a new species on the
 * strength of a reading that predates the catch.
 *
 * `''` when the codex was not read or does not list the fish: a clause invented for a fish nobody has
 * a name for would be the one thing an item's `detail` may not be.
 */
function fishingSpeciesClause(before: FishingCodexFacts | null, fishId: number): string {
  const species = before?.entries.get(fishId)
  if (species === undefined) return ''
  const named = species.name === '' ? '这一种' : species.name
  return species.registered ? `${named}（图鉴已有）` : `${named}（图鉴未收录）`
}

/**
 * The 图鉴 as the run leaves it, and what moved — as a clause, or `''` when it was not read.
 *
 * **The delta is a measurement between two reads**, taken before the first cast and after the last
 * one, which is the same shape the bait cost has and for the same reason: one read cannot say whether
 * this run changed anything. A single read is reported as a count and says so — 「这次没读到上一条，
 * 看不出本次新增」 — rather than comparing against nothing.
 *
 * The value this line reports is **the owner's own account of what 钓鱼 is worth** rather than a
 * capture: the codex is the durable output, and no captured cycle showed a codex entry moving. The
 * numbers in it are readings; the claim that they matter is his.
 */
function fishingCodexLine(before: FishingCodexFacts | null, after: FishingCodexFacts | null): string {
  if (after === null) return ''
  const base = `图鉴 ${String(after.species)} 种、已收录 ${String(fishingRegisteredIn(after))} 种`
  if (before === null) return `${base}（这次没读到上一条，看不出本次新增）`

  const gained: string[] = []
  for (const [fishId, species] of after.entries) {
    if (species.registered && before.entries.get(fishId)?.registered !== true) {
      gained.push(species.name === '' ? '一种没读出名的新鱼' : species.name)
    }
  }
  return gained.length === 0 ? base : `${base}（本次新增 ${gained.join('、')}）`
}

/**
 * 抽奖's own counter, and the pointer to the action that spends it.
 *
 * **This action only reads it.** Buying draws spends an account's筹码, which is a decision rather
 * than a step of a fishing cycle — so the line says what is there and names 抽奖 as a separate
 * chore. The owner's own account is that 陪伴印章 comes out of that lottery and out of a codex
 * species; if the chips themselves are earned by fishing, the activity is a loop
 * (钓鱼 → 筹码 → 抽奖 → 印章) and the other half of a loop is not a step inside it.
 */
function fishingChipsLine(chips: number | null): string {
  return chips === null ? '' : `抽奖积分 ${String(chips)}、抽奖是另一个动作（这一版只读不花）`
}

/**
 * 「钓几次」, out of this action's own options.
 *
 * The option's shape is this adapter's business — `routes/action-settings.ts` stores whatever the
 * client sent, because `ActionDescriptor` describes no options — so the key and its contract are
 * stated here, once: `casts` is a positive integer, and anything else (absent, a string that is not
 * digits, zero, a negative, a fraction) reads as `FISHING_DEFAULT_CASTS`. Fail-closed in the one
 * direction that spends: an option nobody could read buys one cast, not many.
 */
function fishingCastsIn(options: unknown): number {
  if (typeof options !== 'object' || options === null) return FISHING_DEFAULT_CASTS
  if (!('casts' in options)) return FISHING_DEFAULT_CASTS

  const declared = options.casts
  const value =
    typeof declared === 'number'
      ? declared
      : typeof declared === 'string' && /^\d+$/.test(declared.trim())
        ? Number.parseInt(declared.trim(), 10)
        : Number.NaN
  if (!Number.isSafeInteger(value) || value < 1) return FISHING_DEFAULT_CASTS

  return Math.min(value, FISHING_MAX_CASTS_PER_RUN)
}

/**
 * One refusal a run met, as the record needs it.
 *
 * `ItemFailure` minus its name: 钓鱼 is a single-room action and the record already carries that room
 * as its `targetKey`, so repeating the anchor inside the record's own line would be the one thing
 * that line said twice.
 */
interface FishingFailure {
  readonly code: string
  readonly message: string
  readonly classification: ErrorClassification
}

/** Where a run stopped before it had used up the casts it was asked for. */
interface FishingHalt {
  /** A state this adapter named, or the service's own number when the service refused. */
  readonly code: string
  /** The sentence the item carries: what did not happen, and the fact that stopped it. */
  readonly detail: string
  readonly failure: FailureKind
}

/** One finished run, as the record below needs it. */
interface FishingRun {
  readonly targetKey: string
  /** One per cast, and one for the state that stopped the run. Never empty. */
  readonly items: readonly ActionItem[]
  readonly failures: readonly FishingFailure[]
  /** Cast-and-reel pairs this run finished. */
  readonly reeled: number
  /** Bait this run's own readings say it spent, summed over the casts that could be measured. */
  readonly spent: number
  /** How many casts `fishingCastsIn` read out of the option, after its own ceiling. */
  readonly casts: number
  readonly halt: FishingHalt | null
  /**
   * What the run learned about its own durable output — the 图鉴 line and the chips line.
   *
   * Passed in already rendered, because both are statements about readings taken *around* the casts
   * rather than about any one item, and the record is the only place they belong.
   */
  readonly clauses: readonly string[]
}

/**
 * The two things a cast needs that only the account's owner can change, checked against the panel.
 *
 * **The window is deliberately not one of them, and that is a measurement rather than a preference.**
 * It is still read from the panel and still reported (`fishingWindowClause`), but it is no longer
 * what decides whether a cast may go out: on 2026-10-08 the panel reported `st` 18:00 / `et` 19:00
 * while a cast went out at 17:49:45.958 — 614 s early — and the service answered `error: 0`, spent the
 * 20 bait and credited the intimacy counter for the fish it produced. A run that refused that cast
 * would be turning down work the Platform pays for, on the strength of a field that is a *report of
 * when the match is*. So the only thing that may stop a cast is the cast itself: a refusal from the
 * service, which the cast's own branch below records. See `fishingMatchInfoSchema` in `protocol.ts`.
 *
 * The other two are states only the account's owner can change, and neither is a field of this task
 * — no endpoint in this repo sets either — so each is reported as the precondition it is, parked with
 * `action_stop` so 动作受阻 tells whoever is looking. **A bait's own presence is checked here and its
 * stock in the loop**: presence is a property of the room, stock moves with every cast.
 */
function fishingBlockedBy(panel: FishingPanel): FishingHalt | null {
  if (!fishingHasCharacter(panel)) {
    return {
      code: LocalCode.NoCharacter,
      detail: '未抛竿：这个直播间还没有设置形象（在粉丝家园里设置一次，这个动作不会替你做）',
      failure: 'action_stop'
    }
  }

  if (inUseBait(panel) === null) {
    return { code: LocalCode.NoBait, detail: NO_BAIT_IN_USE, failure: 'action_stop' }
  }

  return null
}

/**
 * The one outcome a 钓鱼 run keeps.
 *
 * Built the way the two walks' aggregates are — the record's verdict and grade are the worst item's —
 * so "the aggregate is one its items recognise" holds by construction rather than by a test.
 *
 * **Two things outrank a finished round, and both are things the run could not work around.** A
 * `retry` failure first: `done` settles this action for the day (`runner.ts` counts `done`, `already`
 * and `skipped` as settled), so reporting it over a failed cast would throw away the casts the run had
 * left. Then the **halt**: a run that stopped early has not finished the day, and every halt this action
 * raises is one a person or a clock clears — restock the bait, set an 形象, come back when the service
 * says the match is on — so `blocked` is what keeps the sweep coming back to do it.
 *
 * **A fish reeled in before that halt changes nothing about the ordering, and this is the one place
 * where the obvious order was wrong rather than inelegant.** `bait_low`'s own sentence tells the person
 * that the action continues once the bait is restocked (the lottery hands bait out the same day), while
 * `done` had already settled the day: the "continuation" was the next *platform* day, and the 动作受阻
 * that same sentence says is how they find out was never raised either, because the aggregate was
 * `done`. The counts and the halt both stay on the line, so a day with a fish in it still reads as
 * exactly that.
 */
function fishingOutcome(run: FishingRun): ActionOutcome {
  const counts = `收竿 ${String(run.reeled)} 竿、消耗鱼饵 ${String(run.spent)} 枚（共 ${String(run.casts)} 竿）`
  /** The counts, whatever stopped the run, and what it learned about its own durable output. */
  const line = (...clauses: readonly (string | null)[]): string =>
    [counts, ...clauses.filter(clause => clause !== null && clause !== ''), ...run.clauses].join('；')

  let worst: FishingFailure | null = null
  for (const failure of run.failures) {
    if (worst === null || FAILURE_RANK[failure.classification] > FAILURE_RANK[worst.classification]) worst = failure
  }

  if (worst !== null) {
    return {
      actionKey: ActionKey.Fishing,
      targetKey: run.targetKey,
      outcome: 'failed',
      code: worst.code,
      detail: line(worst.message),
      failure: worst.classification,
      items: run.items
    }
  }

  if (run.halt !== null) {
    return {
      actionKey: ActionKey.Fishing,
      targetKey: run.targetKey,
      outcome: 'blocked',
      code: run.halt.code,
      detail: line(run.halt.detail),
      failure: run.halt.failure,
      items: run.items
    }
  }

  if (run.reeled > 0) {
    return {
      actionKey: ActionKey.Fishing,
      targetKey: run.targetKey,
      outcome: 'done',
      code: '',
      detail: line(null),
      failure: 'none',
      items: run.items
    }
  }

  // Unreachable, and written out rather than asserted: `casts` is at least one, and every way out of
  // the loop either reels a fish in, records a failure or halts. A `!` here would be a promise about
  // a path a later edit can open.
  return {
    actionKey: ActionKey.Fishing,
    targetKey: run.targetKey,
    outcome: 'blocked',
    code: LocalCode.UnknownFishingStat,
    detail: line('这一轮一竿都没有抛出去'),
    failure: 'none',
    items: run.items
  }
}

/**
 * 粉丝家园钓鱼 — one room, and a cycle rather than a call.
 *
 * **The cycle, in order, and every step's authority is the Platform:**
 *
 *  1. `homePage?rid=<R>&opt=0` — the panel. It answers the four questions a cast depends on: is a
 *     cast out (`fishing.stat`), when does the wait end (`fishing.fishEtMs`), what may be spent
 *     (`baits[]`, `inUse` naming the one), and what window the service says this room's match is in
 *     (`matchInfo` — read and reported, never gated on).
 *  2. `POST fishing` — 抛竿, which spends bait, and whose **own response carries the new stock and the
 *     new `stat`**: `baits` and `fishing` come back from that one reply, so a second `homePage` after
 *     a cast would be a request bought with nothing. It does *not* carry `matchInfo` or `myCh` — the
 *     window and the 形象 are read-only facts and come from step 1's panel.
 *  3. wait to `fishing.fishEtMs`, then read the panel until `stat` reads `2` — the wait is the
 *     service's own instant, not a sleep of this module's choosing.
 *  4. `POST reelIn` — 收竿, which is what turns the cast into a fish, and whose body carries only
 *     `ctn` and `rid` because the bait was spent by the cast.
 *
 * **What it refuses to do, and why each refusal is the state it names.**
 *
 *  - **It does not refuse a cast over the clock.** `matchInfo` is read and reported, never
 *    hardcoded and never compared: three captures of this same account and room read 12:00–24:00,
 *    18:00–19:00 and 19:00–19:30, and the cast one of them bracketed went out 614 s **before** its
 *    own window and was answered `error: 0`. So a cast whose window has not opened yet is sent, and
 *    `blocked` is what the *service's* refusal produces — not what a local clock comparison does.
 *  - **It never casts with no 形象 or no bait in use.** Both are set in 粉丝家园's own interface and
 *    this repo has no endpoint that sets either, so they are reported rather than worked around — the
 *    same two states the reference implementation gives up on.
 *  - **It never casts while a fish is on the line.** `stat: 2` is a fish waiting for `reelIn`, and a
 *    cast sent anyway answers `1001007`, whose branch is the reference's: reel first, then cast.
 *  - **It never spends more bait than it was asked for or than there is.** The run is bounded by
 *    「钓几次」 (and by this adapter's ceiling on it) *and* by the panel's own `cnt` before every cast;
 *    `1005003` is the service's version of the same shortfall and stops the run when it arrives.
 *  - **It never promises a reward.** The one observed `reelIn` answered `awards: []`, so what a run
 *    reports is what the Platform sent and nothing else — and the two summary reads below (the 图鉴
 *    around the casts, and the chips counter) exist precisely because a cast that pays nothing is the
 *    ordinary case: what a run leaves behind is a codex that may have moved, and that is reported as a
 *    difference between two readings rather than as a hope.
 *  - **It never spends the chips.** They are read so a person can see when there is something to spend
 *    them on; buying draws is its own decision, and if fishing is what earns them, then the activity is
 *    a loop (钓鱼 → 积分 → 抽奖 → 印章) whose other half does not belong inside this step of it.
 *
 * **The cost is measured, not assumed**, and the measurement is the one this project got wrong four
 * times: the panel read immediately before the cast minus the cast's own response. See
 * `FISHING_BAIT_PER_CAST` for the trap and `fishingSpent` for the pair.
 *
 * **A finished round ends `done`, and that settles the day.** `runner.ts` counts `done`/`already`/
 * `skipped` as settled, so 「钓几次」 means *today*: the field is how many casts this action does
 * before it stops for the day, which is also what keeps an action that spends bait from grinding a
 * whole stock in one afternoon. A run that stops early (no 形象, no bait, or a cast the service
 * refused) is `blocked` instead, and the sweep comes back.
 */
async function reconcileFishing(
  context: ReconcileContext,
  credential: ParsedCredential | null
): Promise<ActionOutcome> {
  const key = ActionKey.Fishing
  const targetKey = context.targetKey.trim()
  const roomId = roomIdOf(targetKey)
  if (roomId === null) {
    // A key that is not a room number cannot start working later, so parking beats retrying a typo.
    return roomOutcome(key, targetKey, 'failed', '目标不是有效的斗鱼房间号', LocalCode.BadTarget, 'action_stop')
  }
  if (credential === null) {
    return roomOutcome(key, targetKey, 'failed', NO_CREDENTIAL_DETAIL, LocalCode.NoCredential, 'account_stop')
  }
  if (credential.webCookies.trim() === '') {
    // The same precondition 粉丝家园签到 and 亲密度任务 report, in the same words: this family's writes
    // carry `ctn`, `ctn` is the session's own cookie, and a request without a session would answer an
    // identity refusal a person would go looking at the token for.
    return roomOutcome(
      key,
      targetKey,
      'blocked',
      '未钓鱼、账号没有网页会话（重新扫码绑定一次，这个动作会自己继续）',
      LocalCode.NoWebSession,
      'action_stop'
    )
  }

  // One read does two jobs, and the second is why it is here rather than in `protocol.ts`.
  //
  // **It mints `ctn`.** This family's writes carry the value in the body and in their own `Cookie:`
  // header (`castFishingLine`), and it is minted by a read: the badge wall re-issues `acf_ccn` on
  // every call. `csrfValueFor` prefers what this response set and falls back to the jar.
  //
  // **It names the room for a person.** Nothing in the fishing payload carries the anchor's name, and
  // an item's label may never be the room's id — so the wall is what turns `12306` into 「电棍」 on the
  // row somebody reads. A room the wall does not list is still fishable (the medal is not a gate on
  // this action) and it is labelled 「未命名直播间」, with the id kept to the console line, where the
  // thing the request is addressed by belongs.
  const listed = await callGraded(
    '读取粉丝牌列表',
    () => readFanBadges(credential.token, credential.webCookies),
    credential.token,
    credential.webCookies
  )
  if (!listed.ok) return roomOutcome(key, targetKey, 'failed', listed.detail, listed.code, 'retry')

  const anchor = listed.reply.badges.find(badge => badge.roomId === targetKey)?.anchorName ?? ''
  const label = anchor === '' ? UNNAMED_ROOM : anchor
  const logged = anchor === '' ? targetKey : `${anchor}（房间 ${targetKey}）`

  const ctn = csrfValueFor(listed.reply, credential.webCookies)
  context.log(csrfNote('钓鱼', listed.reply.csrf, ctn))
  if (ctn === '') {
    // Nothing to send, so nothing is sent — the same reading 粉丝家园签到 makes of the same value,
    // and the same reason it is `blocked` rather than `failed`: a read mints this, so another run may
    // well have one, and the sweep leaves the day unsettled until one does.
    return roomOutcome(
      key,
      targetKey,
      'blocked',
      '未钓鱼、这次读没有下发 acf_ccn 而网页会话里也没有，抛竿与收竿要用的 CSRF 值（ctn）拿不到，一个请求都没有发（会话是好的：这次读刚拿到粉丝牌列表）；这个值由一次读下发，下一轮会重新读一次',
      LocalCode.CsrfUnavailable,
      'action_stop'
    )
  }

  const casts = fishingCastsIn(context.options[key])
  const items: ActionItem[] = []
  const failures: FishingFailure[] = []
  let reeled = 0
  let spent = 0

  // The 图鉴 read before the first cast and the one after the last, plus the chips counter: the three
  // readings this run takes for its own sake. A delta needs both ends, and `codexBefore` is also what
  // an item's species clause is built from — see `fishingSpeciesClause`.
  let codexBefore: FishingCodexFacts | null = null
  let codexAfter: FishingCodexFacts | null = null
  let chips: number | null = null
  let worked = false
  let summarised = false
  /**
   * The last window a panel reported, as the record states it.
   *
   * Kept as a rendered clause rather than as a `st`/`et` pair, because it is not compared against
   * anything: it exists so the record says when this room's match is. See `fishingWindowClause`.
   */
  let windowClause = ''

  /**
   * One 图鉴 read, or a console line saying why this run has none.
   *
   * `null` rather than a failure item, on purpose: a codex nobody could read costs the run a sentence
   * and never its verdict. See `finish` for the whole argument.
   */
  const readCodex = async (): Promise<FishingCodexFacts | null> => {
    const read = await callGraded(
      '读取钓鱼图鉴',
      () => readFishingCodex(credential.token, credential.webCookies, targetKey),
      credential.token,
      credential.webCookies
    )
    if (read.ok && read.reply.ok) return codexFactsOf(read.reply.data)

    context.log(`钓鱼「${logged}」：图鉴这次没读到，这一轮钓到的鱼照报`)
    return null
  }

  /** The chips a draw would spend, or `null`. This action reports the counter and never spends it. */
  const readChips = async (): Promise<number | null> => {
    const read = await callGraded(
      '读取抽奖积分',
      () => readFishingChips(credential.token, credential.webCookies, targetKey),
      credential.token,
      credential.webCookies
    )
    return read.ok && read.reply.ok ? read.reply.data : null
  }

  /** The record, as it stands: every exit below goes through `finish`. */
  const report = (halt: FishingHalt | null): ActionOutcome =>
    fishingOutcome({
      targetKey,
      items,
      failures,
      reeled,
      spent,
      casts,
      halt,
      clauses: [windowClause, fishingCodexLine(codexBefore, codexAfter), fishingChipsLine(chips)].filter(
        clause => clause !== ''
      )
    })

  /**
   * The way out of every path, and the only place the three summary reads happen.
   *
   * **A read that did not arrive is a sentence, not a verdict.** The 图鉴 and the chips counter say
   * what a run's output was worth; they do not cast, hold a fish or spend anything — so a failed read
   * is reported in the record's own line and never as the run's failure. Grading it `retry` would
   * leave the day unsettled, and the next sweep would spend another 20 bait to learn what this one
   * already knew. They are also skipped on a run that never touched the line: a parked day buys
   * nothing with two extra requests either, and `worked` is what says whether this one did — a cast
   * **or** a reel-in, because a fish reeled in by an earlier run's line is exactly the fish whose
   * species may have just registered.
   */
  const finish = async (halt: FishingHalt | null): Promise<ActionOutcome> => {
    if (worked && !summarised) {
      summarised = true
      codexAfter = await readCodex()
      chips = await readChips()
    }
    return report(halt)
  }

  /** One panel read, or the failure this run records when that read does not arrive. */
  const readPanel = async (): Promise<FishingPanel | null> => {
    const read = await callGraded(
      '读取钓鱼面板',
      () => readFishingPanel(credential.token, credential.webCookies, targetKey),
      credential.token,
      credential.webCookies
    )
    if (!read.ok) {
      failures.push({ code: read.code, message: read.detail, classification: 'retry' })
      items.push({ kind: 'room', label, outcome: 'failed', detail: read.detail, code: read.code })
      return null
    }
    if (!read.reply.ok) {
      const code = codeText(read.reply.code)
      failures.push({ code, message: read.reply.message, classification: read.reply.classification })
      items.push({ kind: 'room', label, outcome: 'failed', detail: `读取钓鱼面板失败：${read.reply.message}`, code })
      return null
    }
    // Every panel read refreshes the window the record states: a run long enough to straddle two
    // matches should quote the one it last saw, which is the one it was working against.
    windowClause = fishingWindowClause(read.reply.data.matchInfo)
    return read.reply.data
  }

  /**
   * 收竿, and the one item it produces: a fish, a weight, and whatever the service said came with it.
   *
   * The response is not a panel, so the caller keeps the panel it already had. That is enough because
   * of what a reel-in changes: the line's state is read again before the next cast, and `baits[]`
   * cannot have moved — reeling was measured not to spend anything (five readings across one reel-in
   * and two bait changes, all the same `cnt`).
   *
   * The console line carries the fish's id and the item does not: an item's `detail` is rendered in
   * the main UI and leads with the fact, while the id is what tells two fish apart in a log.
   */
  const reelNow = async (): Promise<boolean> => {
    const called = await callGraded(
      '收竿',
      () => reelInFishingLine(credential.token, credential.webCookies, ctn, targetKey),
      credential.token,
      credential.webCookies,
      ctn
    )
    if (!called.ok) {
      failures.push({ code: called.code, message: called.detail, classification: 'retry' })
      items.push({ kind: 'room', label, outcome: 'failed', detail: called.detail, code: called.code })
      return false
    }

    const reply = called.reply
    if (!reply.ok) {
      const code = codeText(reply.code)
      failures.push({ code, message: reply.message, classification: reply.classification })
      items.push({ kind: 'room', label, outcome: 'failed', detail: `收竿失败：${reply.message}`, code })
      return false
    }

    reeled += 1
    // A reel-in is a thing a 图鉴 entry can move for, so it counts as work even when no cast of this
    // run's went out — which is the `1001007` path, where the fish was somebody's earlier cast.
    worked = true
    const fish = reply.data.fish
    const award = fishingAwardClause(reply.data.awards)
    const species = fish === undefined ? '' : fishingSpeciesClause(codexBefore, fish.id)
    const stated = [fish === undefined ? '' : `重 ${String(fish.wei)} 斤`, species, award].filter(fact => fact !== '')
    const alsoLogged = fish === undefined ? [] : [`鱼 ${String(fish.id)}`]
    context.log(
      `钓鱼「${logged}」：收竿${[...alsoLogged, ...stated].length === 0 ? '' : `，${[...alsoLogged, ...stated].join('、')}`}`
    )
    items.push({
      kind: 'room',
      label,
      outcome: 'done',
      detail: stated.length === 0 ? '收竿（服务端没报鱼）' : `收竿、${stated.join('、')}`,
      code: String(reply.code)
    })
    return true
  }

  /**
   * One `POST fishing`, with a call that never arrived recorded as this run's own failure.
   *
   * Split out of the loop because the cycle throws a line **twice** at most: the second attempt is
   * the reference implementation's answer to `1001007`, and it has to go through exactly the same
   * request as the first.
   */
  const throwLine = async (baitId: number): Promise<DouyuResult<FishingCast> | null> => {
    const called = await callGraded(
      '抛竿',
      () => castFishingLine(credential.token, credential.webCookies, ctn, targetKey, baitId),
      credential.token,
      credential.webCookies,
      ctn
    )
    if (called.ok) return called.reply

    failures.push({ code: called.code, message: called.detail, classification: 'retry' })
    items.push({ kind: 'room', label, outcome: 'failed', detail: called.detail, code: called.code })
    return null
  }

  let panel = await readPanel()
  if (panel === null) return await finish(null)

  // The preconditions are read once per run and not once per cast: nothing a cast does can set an
  // 形象 or put a bait in use — the two states a person owns are changed in 粉丝家园, not here. The
  // window is deliberately not among them: it is a report of when the match is, not a permission to
  // cast, and every cast below is allowed to go out until the service itself refuses one.
  const blocked = fishingBlockedBy(panel)
  if (blocked !== null) {
    items.push({ kind: 'room', label, outcome: 'blocked', detail: blocked.detail, code: blocked.code })
    return await finish(blocked)
  }

  // The 图鉴 as it stands before this run's first cast: the baseline an item's species clause and the
  // record's 「本次新增」 are both read against. Taken here rather than at the top because a run that
  // never gets as far as casting — no 形象, no bait, no web session — has nothing to compare, and the
  // gate above is what keeps it from paying for a read it cannot use.
  codexBefore = await readCodex()

  for (let index = 0; index < casts; index += 1) {
    /* ---- 1. 线上还有鱼就先收掉 -------------------------------------------------- */

    if (panel.fishing.stat === FISHING_STAT_CAST) {
      // A cast is out — from an earlier run, or from this one's previous round. The wait is the
      // instant the service named, and the panel is read again afterwards to see the transition
      // rather than to trust the sleep.
      for (let round = 0; panel.fishing.stat === FISHING_STAT_CAST && round < FISHING_LOOK_AGAIN; round += 1) {
        await sleep(fishingWaitMs(panel.fishing))
        const again = await readPanel()
        if (again === null) return await finish(null)
        panel = again
      }
    }

    if (panel.fishing.stat === FISHING_STAT_CAST) {
      // Waited past the instant the panel itself named, and it still says 「钓中」. That is a shape
      // this build has no answer for, so it is reported rather than cast through: the next round's
      // first move is to look at it again, and a fish that lands a second later is still reeled in.
      const detail = '未抛竿：等过服务端报的收竿时刻之后面板仍报「钓中」，本次不再继续；下一轮会重新读一次'
      items.push({ kind: 'room', label, outcome: 'blocked', detail, code: LocalCode.UnknownFishingStat })
      return await finish({ code: LocalCode.UnknownFishingStat, detail, failure: 'none' })
    }

    if (panel.fishing.stat === FISHING_STAT_READY) {
      if (!(await reelNow())) return await finish(null)
      const after = await readPanel()
      if (after === null) return await finish(null)
      panel = after
    } else if (panel.fishing.stat !== FISHING_STAT_IDLE) {
      const detail = `未抛竿：面板报的钓鱼状态是 ${String(panel.fishing.stat)}，这一版只认识 0/1/2`
      items.push({ kind: 'room', label, outcome: 'blocked', detail, code: LocalCode.UnknownFishingStat })
      return await finish({ code: LocalCode.UnknownFishingStat, detail, failure: 'none' })
    }

    /* ---- 2. 这一竿用哪枚鱼饵、还够不够 ------------------------------------------ */

    // `inUse: 1` is the bait the cast must send, and it is re-read every round because the stock only
    // moves when a cast goes out. The panel is the authority here; nothing is remembered between
    // rounds except this run's own totals.
    const bait = inUseBait(panel)
    if (bait === null) {
      items.push({ kind: 'room', label, outcome: 'blocked', detail: NO_BAIT_IN_USE, code: LocalCode.NoBait })
      return await finish({ code: LocalCode.NoBait, detail: NO_BAIT_IN_USE, failure: 'action_stop' })
    }

    if (bait.cnt < FISHING_BAIT_PER_CAST) {
      // This adapter's own bound, and the reason it is not left to the service: the panel has already
      // said there is not enough, so sending the cast would be a request bought to be refused.
      const detail = `未抛竿：在用的那枚鱼饵只剩 ${String(bait.cnt)} 枚，不够一竿的 ${String(FISHING_BAIT_PER_CAST)} 枚`
      items.push({ kind: 'room', label, outcome: 'blocked', detail, code: LocalCode.BaitLow })
      return await finish({ code: LocalCode.BaitLow, detail, failure: 'action_stop' })
    }

    /* ---- 3. 抛竿 --------------------------------------------------------------- */

    let reply = await throwLine(bait.id)
    if (reply === null) return await finish(null)

    if (!reply.ok && reply.code === FISHING_FISH_ON_THE_LINE) {
      // 「操作失败」 is what a cast answers while a fish is on the line, and the reference
      // implementation's branch is the only reading of it that acts: reel that fish in, then cast
      // again. A refused cast is not a cast that went out, so nothing was spent and nothing is
      // measured here.
      context.log(`钓鱼「${logged}」：抛竿被拒（${codeText(reply.code)} 操作失败），先收竿再抛一次`)
      if (!(await reelNow())) return await finish(null)
      reply = await throwLine(bait.id)
      if (reply === null) return await finish(null)
    }

    if (!reply.ok) {
      const code = codeText(reply.code)
      if (reply.code === FISHING_BAIT_EXHAUSTED) {
        // The service's own version of the shortfall above, and the day's work stops here. `blocked`
        // with `action_stop` rather than a settled outcome: the bait can be re-stocked the same day
        // (the lottery hands it out), and 动作受阻 is how the person finds out that it ran out.
        const said = reply.message === '' ? '鱼饵不足' : reply.message
        const detail = `未抛竿：${said}（服务端 ${code}）；在用的那枚鱼饵不够一竿，补上鱼饵之后这个动作会自己继续`
        items.push({ kind: 'room', label, outcome: 'blocked', detail, code })
        return await finish({ code, detail, failure: 'action_stop' })
      }

      failures.push({ code, message: reply.message, classification: reply.classification })
      items.push({ kind: 'room', label, outcome: 'failed', detail: `抛竿失败：${reply.message}`, code })
      return await finish(null)
    }

    /* ---- 4. 这一竿花了多少 ------------------------------------------------------ */

    spent += fishingSpent(bait, reply.data)
    // This run has cast, which is what makes the two reads on the way out worth making.
    worked = true
    context.log(`钓鱼「${logged}」：抛竿（在用鱼饵 ${String(bait.id)}，抛前 ${String(bait.cnt)} 枚）`)

    /* ---- 5. 等到服务端报的时刻，再读一次确认它到了「可收竿」 ---------------------- */

    let landed = reply.data
    for (let round = 0; landed.fishing.stat !== FISHING_STAT_READY && round < FISHING_LOOK_AGAIN; round += 1) {
      await sleep(fishingWaitMs(landed.fishing))
      const again = await readPanel()
      if (again === null) return await finish(null)
      landed = again
    }

    if (landed.fishing.stat !== FISHING_STAT_READY) {
      // The cast went out and its own response said when the fish would be ready; a panel that still
      // disagrees after the wait is a contract change this build reports instead of guessing at. The
      // bait is spent, and the fish may still be on the line — the next round starts by looking.
      const detail = `未收竿：抛竿之后面板报的状态是 ${String(landed.fishing.stat)}，等过 ${String(FISHING_LOOK_AGAIN)} 轮也没到「可收竿」；这一竿先放下，下一轮会重新读它`
      items.push({ kind: 'room', label, outcome: 'blocked', detail, code: LocalCode.UnknownFishingStat })
      return await finish({ code: LocalCode.UnknownFishingStat, detail, failure: 'none' })
    }

    /* ---- 6. 收竿 ---------------------------------------------------------------- */

    if (!(await reelNow())) return await finish(null)

    // A reel-in's response is not a panel, so the next round reads one. That is not just bookkeeping:
    // it is what keeps the Platform the only thing that says what state this room is in, instead of
    // this side carrying a state it derived.
    const next = await readPanel()
    if (next === null) return await finish(null)
    panel = next
  }

  return await finish(null)
}

/**
 * OPFOY 活动签到, now gated by a read.
 *
 * `31200` is **today's signature landing** — the captured body answers 「签到成功!」 and the ledger
 * entry written in that same second is 「签到礼包 +20」, so the older reading of this number as
 * "signed, handed nothing" is not what the account got (`errors.ts` records the move).
 * `31015` is "已经签过啦"; both mean the signature is in place, which is why `signActivity`
 * accepts both as success and reports which one it was. `31015` is therefore `already` and parks
 * for the day — on a number nobody has ever seen: this capture was scanned for it and answered
 * zero hits — while `31200` is today's `done`.
 *
 * `getStatus` runs first, and `todaySigned: 1` ends the run without a write. §2.5 measured
 * both halves of that gate — the read wants the token and nothing else, and a token that is
 * not a session answers `300` — and the `300` is why the gate is worth having rather than
 * being a saving of one request: an unreadable session has to arrive as `account_stop`, not
 * as a quiet "nothing to do".
 *
 * No csrf token is sent, and the capture says what that costs and what it does not: **the page**
 * mints one first, at `POST /japi/carnival/nc/common/generateCsrf` → `Set-Cookie: cvl_csrf_token`,
 * `Max-Age=300` — a path whose segment is `carnival`, one segment short of the way this build's
 * own activity calls spell it (`carnivalApi`, `protocol.ts`'s family list), and an endpoint **this
 * build does not call**; `signActivity` records the shape it sends instead — and then sends the
 * value as the cookie **and** as the body field, while this adapter sends the field empty and no
 * cookie at all — the shape §2.5's `签到礼包` ledger entry belongs to. So the omission is not "this
 * endpoint needs nothing"; it is a measured-working shape, and a parity change that minted the pair
 * would have to be re-measured rather than assumed better.
 *
 * The details below leave both the `signAlias` and the activity's name out: the alias
 * travels in the item's `code`, which only the debug section renders, and the activity is
 * already named by the row's own label (「任务中心签到」, from the catalogue). What is left is
 * the fact — 「已签」 — where the old wording spent a sentence saying the same thing twice
 * (`活动「20250521OPFOY_qd2」签到成功。` said nothing to anyone but us, §2.5).
 *
 * **Neither detail states a reward**, though the capture shows one landing. The sign response
 * carries no award — the captured `31200` answers `data: {}` — and the `+20` the ledger took in
 * that same second is a fact from an endpoint this action never calls
 * (`redeemPoints/pointRecord`); the activity's own rule varies by day (第 1–6 天 20、第 7 天
 * 20+30). A number this adapter has not read back is a number it must not report.
 */
async function reconcileActivitySign(credential: ParsedCredential | null): Promise<ActionOutcome> {
  const key = ActionKey.ActivitySign
  if (credential === null) return noCredentialOutcome(key)

  // The pre-flight read, and it is a **gate** rather than a diagnostic. `doSign` answers
  // the same code whether today's signature has just landed or was already in place, so
  // the only way to know which of the two a run is looking at is to ask first — and a run
  // that skips the write is a run that cannot fail the write.
  //
  // `300` is graded here, not by the global table, and graded `account_stop`: this family
  // answers it for a token that is missing or is not a session. That mapping is the whole
  // point of the gate, because the one reading it must never produce is "nothing to do" —
  // a dead session reported as a quiet skip is a task that looks healthy while the account
  // silently stops earning anything.
  const status = await callGraded(
    '读取任务中心签到状态',
    () => readActivitySignStatus(credential.token),
    credential.token
  )
  if (!status.ok) return transportFailure(key, status)
  const gate = status.reply
  if (!gate.ok) {
    return actionFailure(
      key,
      codeText(gate.code),
      `读取任务中心签到状态失败：${gate.message}`,
      gate.code === ACTIVITY_NOT_LOGGED_IN ? 'account_stop' : gate.classification
    )
  }

  if (gate.data.todaySigned === 1) {
    // Today's obligation is met. The code reported is the *read's* `0` rather than
    // `31015`: that number is what this endpoint answers, and nothing here has received
    // it, so naming it would be reporting a response this run never saw.
    return accountOutcome(key, 'already', '已签', String(gate.code), 'action_stop', OPFOY_SIGN_ALIAS)
  }

  // Neither `0` nor `1`. The gate is fail-closed, so this is not read as "not signed" —
  // that reading would sign on a state nobody has ever seen — and the value rides in
  // `code` where the debug section prints it.
  if (gate.data.todaySigned !== 0) {
    return accountOutcome(
      key,
      'blocked',
      '今日签到状态未知、未发送',
      String(gate.data.todaySigned),
      'none',
      OPFOY_SIGN_ALIAS
    )
  }

  const result = await callGraded('活动签到', () => signActivity(credential.token), credential.token)
  if (!result.ok) return transportFailure(key, result)
  const signed = result.reply
  if (!signed.ok) {
    return actionFailure(key, codeText(signed.code), `活动签到失败：${signed.message}`, signed.classification)
  }

  if (signed.data.alreadySigned) {
    return accountOutcome(key, 'already', '已签', String(ACTIVITY_ALREADY_SIGNED), 'action_stop', OPFOY_SIGN_ALIAS)
  }

  return accountOutcome(key, 'done', '已签', String(signed.code), 'none', OPFOY_SIGN_ALIAS)
}

/** The 打卡分鱼丸 check-in window, in the Platform's own local hours. See below. */
const GROWTH_POOL_CLOCK_FROM_HOUR = 19
const GROWTH_POOL_CLOCK_TO_HOUR = 21

/** `signStatus`'s two known values: `0` is 未报名 (报名 is what the page offers) and `1` is 已报名. */
const GROWTH_POOL_NOT_JOINED = 0
const GROWTH_POOL_JOINED = 1

/**
 * 打卡分鱼丸 — a **two-day cycle**, implemented as a state machine over one read.
 *
 * It is not a once-a-day action, and treating it as one is what cost this account money.
 * 报名 today, 打卡 tomorrow between 19:00 and 21:00, and a window missed is a forfeited
 * 200 鱼丸: this account's own history is 27 sign-ups costing 5400 and returning 4854
 * (net −546), with the whole loss being seven missed windows — it loses because it
 * forgets, which is the thing this project exists to fix. So **both halves ship together**
 * and `costly: true` keeps the pair dark until a person turns it on: automating the
 * sign-up alone would automate the half that always loses.
 *
 * Every run reads `getSignInfo` first, because the latch is the only thing that says which
 * half is outstanding — `0` = not in this round (报名, which spends), `1` = in this round
 * (打卡). A state this build cannot name is reported and never written through.
 *
 * **Two traps, and both of them lose silently rather than failing loudly.**
 *
 * 1. Outside the check-in window this reports `blocked`, **never `skipped`**. `runner.ts`'s
 *    `settledToday` counts `skipped` as settled and stops asking for the rest of the day,
 *    so a `skipped` here would discard the only 19:00–21:00 window there is — precisely the
 *    failure this action exists to fix. `blocked` is one of the two outcomes that are
 *    deliberately not settled, which is what makes the sweep come back every interval until
 *    the window opens.
 * 2. **The window is this project's clock, not the service's.** `clockLeftTime` counts down
 *    to the opening and says nothing about the closing — a live read gave `107999` s for the
 *    next day's 19:00 — so both ends come from `withinLocalWindow` on the Platform's own
 *    Asia/Shanghai hour, which is the same clock the day boundary uses.
 *
 * **A retry here is a re-pairing, not a resend.** This family's CSRF is a double submit —
 * the body's `dy_token` must equal the header's `dy_cookie` — and the service re-issues
 * `dy_cookie` on its own schedule; a request whose two halves have stopped matching is
 * answered `152101`, which a live run reproduced 25 times in a row inside one minute. What
 * keeps every attempt internally equal is minting the value at the top of each run and
 * never adopting the one a response hands back; caching it across attempts is the mistake
 * that makes it drift.
 *
 * **Nothing here writes on a latch it did not read.** 报名 is the only thing in this adapter that
 * spends, and it is reachable *solely* through the latch read above — so a read that never
 * arrived returns before the branch that writes, and the run spends nothing. That same latch is
 * what makes retrying a **write** whose transport failed safe: a join the service accepted but
 * the network never confirmed is read back as 已报名 on the next run, so a retry risks a repeated
 * attempt and never a second 200 鱼丸.
 *
 * The check-in's success shape has never been captured — no correctly-formed request has
 * ever reached that endpoint — so nothing here reads a field of it and no award is
 * reported; see `clockGrowthPool`.
 */
async function reconcileGrowthPool(credential: ParsedCredential | null, now: number): Promise<ActionOutcome> {
  const key = ActionKey.GrowthPool
  if (credential === null) return noCredentialOutcome(key)

  const csrf = await callGraded('获取打卡凭据', () => fetchCsrfCookie(credential.token), credential.token)
  if (!csrf.ok) return transportFailure(key, csrf)
  const issued = csrf.reply
  if (!issued.ok) return growthPoolRefusal(key, '获取打卡凭据失败', issued)
  const dyCookie = issued.data

  const status = await callGraded(
    '读取打卡分鱼丸状态',
    () => readGrowthPoolStatus(credential.token, dyCookie),
    credential.token,
    dyCookie
  )
  // This early return is what keeps the 200 鱼丸 safe. 报名 — the only half that spends — is
  // reachable *solely* through a parsed `signStatus` below, so a latch that never arrived ends
  // the run here instead of falling through to a write. A write sent on a guess about a state
  // nobody read is the one mistake this action cannot recover from.
  if (!status.ok) return transportFailure(key, status)
  const latch = status.reply
  if (!latch.ok) return growthPoolRefusal(key, '读取打卡分鱼丸状态失败', latch)

  if (latch.data.signStatus === GROWTH_POOL_NOT_JOINED) {
    return await growthPoolSignUp(key, credential.token, dyCookie)
  }
  if (latch.data.signStatus === GROWTH_POOL_JOINED) {
    return await growthPoolCheckIn(key, credential.token, dyCookie, now)
  }

  return accountOutcome(key, 'blocked', '报名状态未知、未写入', String(latch.data.signStatus), 'none')
}

/**
 * The half that spends 200 鱼丸 — 报名.
 *
 * Only reachable on a `0` latch, which is what keeps it from spending twice for one round:
 * the join moves the latch because the account really did join, and the next run reads that
 * back rather than inferring it. A success is the day's `done` — the check-in cannot happen
 * today whatever happens, because the window a join opens is tomorrow's (the measured reply
 * counted 107999 s down at 13:00, i.e. to the next day's 19:00) — and a shortage of 鱼丸
 * parks the day instead.
 */
async function growthPoolSignUp(key: string, token: string, dyCookie: string): Promise<ActionOutcome> {
  const joined = await callGraded('报名', () => joinGrowthPool(token, dyCookie), token, dyCookie)
  if (!joined.ok) return transportFailure(key, joined)
  const receipt = joined.reply
  if (!receipt.ok) return growthPoolRefusal(key, '报名失败', receipt)

  return accountOutcome(
    key,
    'done',
    `已报名、扣 200 鱼丸${poolClauseOf(receipt.data)}、次日 19:00–21:00 打卡`,
    String(receipt.code),
    'none'
  )
}

/**
 * The pool's numbers as a clause, or nothing at all.
 *
 * Absent rather than zero-filled: a `0` would be a claim about a pool nobody counted, and
 * the line reads properly without the clause — which is why both counters are optional
 * in the schema. An upstream rename costs a clause, not the action.
 */
function poolClauseOf(join: GrowthPoolJoin): string {
  if (join.ywTotal === undefined || join.joinTotal === undefined) return ''
  return `（本场奖池 ${String(join.ywTotal)} 鱼丸、${String(join.joinTotal)} 人已报名）`
}

/**
 * The half with the only deadline that matters — 打卡.
 *
 * `now` decides which of two things this run does, and the gate read has already confirmed
 * the account is in this round, so the window is the only question left. Inside it the
 * check-in is attempted; outside it the run reports `blocked` and writes nothing, which is
 * trap 1 in the doc above.
 */
async function growthPoolCheckIn(key: string, token: string, dyCookie: string, now: number): Promise<ActionOutcome> {
  if (!withinLocalWindow(now, GROWTH_POOL_CLOCK_FROM_HOUR, GROWTH_POOL_CLOCK_TO_HOUR)) {
    return accountOutcome(
      key,
      'blocked',
      '已报名、打卡窗口未开（19:00–21:00，未打卡即弃权）',
      LocalCode.WindowNotOpen,
      'none'
    )
  }

  const clocked = await callGraded('打卡', () => clockGrowthPool(token, dyCookie), token, dyCookie)
  if (!clocked.ok) return transportFailure(key, clocked)
  const receipt = clocked.reply
  if (!receipt.ok) return growthPoolRefusal(key, '打卡失败', receipt)

  return accountOutcome(key, 'done', '已打卡、鱼丸 21:00 后结算', String(receipt.code), 'none')
}

/**
 * Grades one refusal from the 打卡分鱼丸 family.
 *
 * Three of its codes do not mean what a global table would say, so the mapping lives here,
 * beside the endpoints that produce them — the same reasoning `FISH_BALL_ALREADY_CLAIMED`
 * is built on:
 *
 *  - `10001` is **account-level**. The service answers it for a body carrying no `token`,
 *    and this adapter always sends one, so receiving it means the session presented was not
 *    accepted: nothing a retry can fix, and `runner.ts` fails the task so a person re-binds.
 *  - `57002` is the Platform parking the day — the balance is short of the 200 鱼丸 entry
 *    fee. `action_stop`, because no number of attempts mints 鱼丸, and `blocked` rather than
 *    `failed`, which is the vocabulary's own word for a balance the Platform refused on.
 *    (Its source is the activity page's bundle rather than a capture: this account has
 *    always had enough.)
 *  - `152101` and everything else stay `retry`. `152101` is the CSRF double submit, and it
 *    is transient beyond doubt — 25 in a row between two windows of `0`, the same request
 *    shape succeeding again afterwards. What makes retrying it safe is the next run minting
 *    a fresh pair instead of reusing this one, which `reconcileGrowthPool` does by
 *    construction. A code nobody has classified is a retry for the reason `errors.ts`
 *    gives, and it travels in `code` so a new verdict shows up in the UI rather than
 *    disappearing into a substring match.
 */
function growthPoolRefusal(key: string, what: string, refusal: DouyuFailure): ActionOutcome {
  const code = refusal.code
  const said = refusal.message === '' ? '' : `（${refusal.message}）`

  if (code === GROWTH_POOL_TOKEN_REJECTED) {
    return actionFailure(key, codeText(code), `${what}：账号会话未被接受，需要重新绑定${said}`, 'account_stop')
  }
  if (code === GROWTH_POOL_NOT_ENOUGH_FISH_BALLS) {
    // `blocked`, and phrased as the fact it is: the two `actionFailure` branches around it
    // keep their sentences, because a failure is the one case where a person needs the reason.
    return accountOutcome(key, 'blocked', `${what}、鱼丸不足 200${said}`, codeText(code), 'action_stop')
  }
  if (code === GROWTH_POOL_CSRF_REJECTED) {
    return actionFailure(
      key,
      codeText(code),
      `${what}：服务端拒绝了这次请求，与账号会话无关，下一次运行会重新配对后再试${said}`,
      'retry'
    )
  }

  // `null` is the socket's "no verdict", which cannot occur on HTTP — if it ever does, an
  // unclassified outcome is a retry and never a silent success.
  return actionFailure(key, codeText(code), `${what}${said}`, code === null ? 'retry' : classifyError(code))
}

/**
 * The window in which a family is close enough to lapsing to be worth rebuilding, in milliseconds.
 *
 * **One day, against a family that lives 529200 s (6.125 days, read out of the response that minted
 * it by `passport.ts`).** Two facts fix the number:
 *
 *  - **The runner asks every six hours.** `scheduler/runner.ts`'s `REFRESH_CHECK_INTERVAL_MS` is six
 *    hours and is deliberately not imported here: a Platform adapter that reached into the scheduler
 *    would invert the dependency the seam exists to keep. A window narrower than one interval could
 *    be stepped over — one check finds the family fresh, the next finds it dead — while a day's
 *    window leaves **four** checks in which to act.
 *  - **The margin is for failures, not for comfort.** A hop that times out, a 5xx, a `Location` that
 *    turns out not to be Douyu's — each of those is a check spent, and the old family is still good
 *    while it happens. A window of one interval would spend the family's whole remaining life on a
 *    single failure.
 *
 * So the first check inside the window rebuilds and an account renews roughly once every five days,
 * never on a check that finds a fresh family. The cost of a wide window is one family minted up to a
 * day before it had to be; the cost of a narrow one is an account that lapses because one exchange
 * failed.
 */
const FAMILY_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000

/** The answer when the family's own clock says there is nothing to do yet. */
const FAMILY_FRESH_DETAIL = 'acf_* 家族尚未接近到期，本次不续期'

/** The answer when a family was rebuilt, naming the one thing that has to have survived it. */
const FAMILY_RENEWED_DETAIL = 'acf_* 家族已重建，网页会话（LTP0）原样保留'

/** The same rebuild, for a credential that could not say when its family lapses. See `refresh`. */
const FAMILY_STAMPLESS_DETAIL = '凭据里没有记录 acf_* 家族的到期时刻，本次重建一次并记下新的到期时刻'

/**
 * The answer for a credential with neither a key nor a clock: nothing to rebuild with, and no
 * statement about urgency to make. See `refresh` for why that is silence rather than an alarm.
 */
const FAMILY_UNKNOWN_NO_SESSION_DETAIL =
  '凭据里没有网页会话（LTP0），也没有记录 acf_* 家族的到期时刻：既没有可出示的钥匙，也说不出它是否快到期，所以本次既不续期也不提示重新绑定；token 是否还能用由平台在动作上回答'

/**
 * Session upkeep — renewal, and the one place both its cadence and its alarm are decided.
 *
 * **The web route can rebuild the token family, and `passport.ts` owns that exchange.** What is
 * decided *here* is when to ask for one and when to ask a person, which is policy and belongs to the
 * member the seam calls; the mechanism, the two hops and the reassembly are the credential's home.
 *
 * **Two questions, in this order, and the order is the whole design.**
 *
 * 1. **Is a renewal known to be needed?** Only the family's own stored clock can say so
 *    (`tokenExpiresAt`, inside `FAMILY_RENEWAL_WINDOW_MS`) — or, when no clock was ever recorded,
 *    the fact that the credential cannot be scheduled at all, which is itself a reason to rebuild
 *    once.
 * 2. **Is there a key to present?** `LTP0` in the jar, the only thing the exchange authenticates
 *    with.
 *
 * Only the **intersection** — a renewal known to be needed *and* no key to present — is worth a
 * person's attention, and for a credential this adapter can read at all it is the only path to
 * `relogin_required`:
 *
 *  - **A known clock, still far off → `not_required`, and no request.** Nothing needs doing, so a
 *    missing key is not reported: an alarm about a credential that has nothing to do yet is an alarm
 *    about nothing. (This is the case that made 「登录已失效」 fire every six hours on an account whose
 *    `h5nc/*` actions all worked.)
 *  - **A known clock inside the window, and no key → `relogin_required`.** This is the one case where
 *    the answer is both certain and actionable: a renewal is due, nothing on this side can perform
 *    it, and a scan is the only remedy.
 *  - **No clock, and no key → `not_required`, and no request.** Neither do we know that a renewal is
 *    needed. **We cannot say "it is about to lapse" about a credential nobody dated**, and an alarm
 *    this member cannot justify is worse than no alarm at all: it teaches the person reading it to
 *    ignore 登录已失效. The token's own health is reported where it is used — Douyu's `-101` on the
 *    action paths is already graded `account_stop`, 粉丝家园签到 reports its own `no_web_session`, and
 *    看广告鱼丸 and friends answer `1002` when the session is refused. **Whoever needs it, reports it.**
 *  - **A blob that does not parse → `relogin_required`.** Not an exception to the rule above but the
 *    other state in which the answer is certain rather than guessed: there is no clock to consult
 *    *and* nothing usable at all. `types.ts` names exactly this input as a `relogin_required` case for
 *    the seam, Bilibili's member answers the same way, and every action on it already fails with
 *    `no_credential`. There is no uncertainty here about whether a person is needed, which is why no
 *    unknown is being dressed up as urgency.
 *
 * The other two answers:
 *
 *  - **`refreshed`** — a family was rebuilt, and it travels back in `credentials` for the caller to
 *    persist. The new blob's token is the new family's five components in the token's own order
 *    (`renewFamily` applies `TOKEN_COOKIES` once, on the way in), its jar is the old jar with the new
 *    declarations merged over it, and `LTP0` — which this exchange does not rotate — is carried
 *    through byte for byte, session stamp included.
 *  - **`failed`** — a renewal was attempted and produced no usable family: a hop that never arrived, a
 *    first hop that answered something other than `302`, a second hop that landed no family, a family
 *    that turned out to belong to somebody else. **Nothing is handed back**, so the stored credential
 *    is left exactly as it was — the caller persists only what `refreshed` carries — and the next
 *    check retries while the old family is still good. Deliberately not `relogin_required`: that
 *    status asks a person to scan, and one exchange going wrong is not evidence that a scan will help.
 *    **It is also silent** — `scheduler/runner.ts` logs a `refreshed` outcome and raises an event for
 *    `relogin_required`, and has no branch for `failed` — so a failing renewal is retried by the next
 *    check six hours later and says nothing until it either succeeds or stops being renewable. That
 *    gap is the scheduler's, and this member does not invent an exit of its own to cover it.
 *
 * **Nothing here judges the token, and that is a rule this member paid for.** Whether a token is alive
 * is the server's answer, never this machine's arithmetic: the seven days this member once judged by
 * came from `expire_in` on the **PC** route's `short_token` — a route this adapter never calls, whose
 * payload the web route does not carry at all (§7) — read as a *session* lifetime when it is a *token*
 * lifetime. That branch is gone. The blob's `expiresAt` (the session cookie's declared death) is
 * recorded and still never read for anything; `tokenExpiresAt` is read, and only to decide whether to
 * make one exchange — a family past its stamp is rebuilt, never declared dead. A token that is in fact
 * dead arrives as **Douyu's own `-101`** on the action paths, where it is already graded
 * `account_stop`; an unusable session arrives there as `1002`, or as 粉丝家园签到's own
 * `no_web_session`.
 *
 * In the seam `relogin_required` means the credential has to be re-bound by a person **because the
 * renewal cannot happen** — the Platform refusing the exchange, or the adapter holding nothing it
 * could present for one (`types.ts`). Until this exchange was measured Douyu could do neither and
 * answered `not_required` for every account; now the second half of that sentence is a measurement
 * rather than a gap, and the status is answered exactly where it can be justified.
 */
async function refresh(account: PlatformAccount): Promise<RefreshResult> {
  const credential = parseCredential(account.credentials)
  // Nothing readable: no clock to consult and no action that can run — the one state a person is
  // certainly needed for, which is why it is answered before any question about timing is asked.
  if (credential === null) return { status: 'relogin_required', detail: NO_CREDENTIAL_DETAIL }

  const now = Date.now()
  const stamp = credential.tokenExpiresAt
  const hasSession = cookieValueIn(credential.webCookies, SESSION_COOKIE) !== ''

  if (stamp === null && !hasSession) {
    // Neither a clock nor a key: this member cannot rebuild anything and cannot say that anything is
    // due, so it says nothing rather than raising an alarm it cannot justify. See the doc above.
    return { status: 'not_required', detail: FAMILY_UNKNOWN_NO_SESSION_DETAIL }
  }

  if (stamp !== null && stamp - now > FAMILY_RENEWAL_WINDOW_MS) {
    // A dated family that is not close to lapsing: nothing to do, whatever the jar holds, and no
    // request is made. A missing key is deliberately not reported through this branch.
    return { status: 'not_required', detail: FAMILY_FRESH_DETAIL }
  }

  // Reached only when a renewal is known to be needed: the clock is inside the window (or has
  // passed), or there is no clock but there is a key, which the rebuild below turns into one.
  if (!hasSession) return { status: 'relogin_required', detail: NO_SESSION_TO_RENEW }

  const renewal = await renewFamily({
    did: credential.did,
    uid: credential.uid,
    webCookies: credential.webCookies,
    expiresAt: credential.expiresAt,
    now
  })

  if (!renewal.ok) {
    // `no_session` cannot arrive through this path — the key was checked above, and the check in
    // `renewFamily` is its own precondition rather than this member's decision — but the mapping
    // stays complete so that a later reordering of these two steps cannot silently reclassify "a
    // person has to scan" as "an attempt failed".
    return renewal.kind === 'no_session'
      ? { status: 'relogin_required', detail: renewal.reason }
      : { status: 'failed', detail: renewal.reason }
  }

  return {
    status: 'refreshed',
    // A credential with no family clock is rebuilt once, and the rebuild is what writes one; the
    // sentence says so, because that exchange is otherwise unexplained.
    detail: stamp === null ? FAMILY_STAMPLESS_DETAIL : FAMILY_RENEWED_DETAIL,
    credentials: renewal.credentials
  }
}

/* ------------------------------------------------------------------ *
 * Small shared pieces
 * ------------------------------------------------------------------ */

/**
 * 「凭据不能用」这一句话只有一个家。
 *
 * Two shapes use it — an account-scoped outcome and a per-Room one — and a credential problem reads
 * identically in both, so the sentence is written once and handed to whichever builder fits the
 * action. Bilibili's adapter keeps its own copy for the reason its outcome builders are separate
 * files: two Platforms' prose is free to differ, and one string shared across the seam would only
 * couple them.
 */
const NO_CREDENTIAL_DETAIL = '账号凭据缺失或无法解析，需要重新扫码绑定。'

/** The account has no usable credential — a state only a person can fix. */
function noCredentialOutcome(actionKey: string): ActionOutcome {
  return actionFailure(actionKey, LocalCode.NoCredential, NO_CREDENTIAL_DETAIL, 'account_stop')
}

/**
 * One room-scoped outcome in which a run never reached that room's task list.
 *
 * The twin of `accountOutcome` for the one action here that a Room identifies, and two things differ
 * from it on purpose: the `targetKey` is the room rather than `''` (`types.ts` reserves the empty
 * string for actions that are about the account, so a per-Room failure reported as account-scoped
 * would name the wrong thing), and the single item is the action's own catalogue name — the run never
 * read a task, so there is nothing else honest to label it with.
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

/** An item's label for a group the service did not name. Never the group's id. */
const UNNAMED_GROUP = '未命名版块'

/**
 * The same idea for a room, which the badge wall lists by anchor name. Never the room's id.
 *
 * Exported because `platform/douyu/options.ts` labels the same rooms on the settings form: the two are
 * the same words for the same fact, and a second copy of the string is how one of them drifts.
 */
export const UNNAMED_ROOM = '未命名直播间'

/** The same idea for a task the service sent no name for: `taskType` is a number, and never a label. */
const UNNAMED_TASK = '未命名任务'

/** The same idea for an action, which only a key this catalogue cannot name reaches. */
const UNKNOWN_ACTION_LABEL = '未知动作'

/**
 * The item's label for an action, taken from the catalogue.
 *
 * Looked up rather than restated: the label a person reads beside a switch is the
 * one that belongs beside the result, and a second copy of it here would be free to
 * disagree with the switchboard. The fallback is unreachable for every key this
 * adapter returns an item for — it is here so that a key this catalogue no longer
 * declares cannot put a raw `action_key` into the one field the main UI renders.
 */
function actionLabelOf(actionKey: string): string {
  return ACTIONS.find(descriptor => descriptor.key === actionKey)?.label ?? UNKNOWN_ACTION_LABEL
}

/**
 * An action that is about the account itself: one result, and one item for it.
 *
 * `outcome`, `detail` and `code` are used for both, so the item restates the run
 * rather than paraphrasing it. That is deliberate: an item that says `done` inside a
 * record that says `failed` is worse than no item at all, and building the two from
 * one value makes that disagreement unrepresentable instead of merely tested for.
 *
 * **`detail` is a fact, not a sentence.** It is the row's own text in the UI now — its label
 * and the heading above it already name the action and say the day is done — so the settled
 * and parked outcomes read as 「已签」, 「连签 7 天」 or 「已报名、打卡窗口未开（19:00–21:00）」
 * rather than restating either. Failure details keep their wording: a rejection is the one
 * thing a person has to read the reason for.
 *
 * `itemCode` is the single field an item may carry a different value in, and only for the
 * one action where the record's `code` is not the interesting number: 活动签到 answers
 * `31200`/`31015`, which is the record's, while the alias identifying *which* activity it
 * was is the item's. Everywhere else the item's code is the record's, which is what the
 * default is for.
 */
function accountOutcome(
  actionKey: string,
  outcome: ActionOutcomeValue,
  detail: string,
  code: string,
  failure: FailureKind,
  itemCode = code
): ActionOutcome {
  return {
    actionKey,
    targetKey: TARGET_KEY_ACCOUNT_SCOPED,
    outcome,
    detail,
    code,
    failure,
    items: [{ kind: 'account', label: actionLabelOf(actionKey), outcome, detail, code: itemCode }]
  }
}

function actionFailure(actionKey: string, code: string, detail: string, failure: FailureKind): ActionOutcome {
  return accountOutcome(actionKey, 'failed', detail, code, failure)
}

/**
 * An action this build cannot run, which is a category of its own.
 *
 * `blocked` (not `failed`) because nothing went wrong — the account, the request and
 * the network are all fine, and the gap is on this side. `runner.ts` raises the
 * 动作受阻 event for this outcome alone, which is how a person finds out that a
 * switch they turned on has nothing behind it.
 *
 * **No item, and this is the only outcome here without one.** An item's `label` must
 * never be an identifier, and a key this build cannot name has no catalogue entry to
 * be labelled from — so the record's own sentence, which names the key in a debug
 * line, stays the whole truth about it.
 */
function blockedOutcome(actionKey: string, code: string, detail: string): ActionOutcome {
  return {
    actionKey,
    targetKey: TARGET_KEY_ACCOUNT_SCOPED,
    outcome: 'blocked',
    detail,
    code,
    failure: 'none',
    items: []
  }
}

/**
 * Every failing probe result is built here, so the fields cannot drift apart.
 *
 * `liveStatus` is `LIVE_STATUS_OFFLINE` rather than the last known value: a failed
 * probe did not learn whether the stream is up, and `ok: false` is what tells the
 * caller not to read it.
 */
function probeFailure(code: string, detail: string, failure: FailureKind): ProbeResult {
  return { ok: false, liveStatus: LIVE_STATUS_OFFLINE, title: '', code, detail, failure }
}

function sendFailure(code: string, detail: string, failure: FailureKind): SendOutcome {
  return { ok: false, code, detail, failure }
}

/**
 * The code for a failure Douyu never numbered.
 *
 * A `RoomReadError` or a `DouyuTransportError` carries a status, and that is structured data in
 * its own right: 5xx is upstream, 4xx is a room that does not exist, `0` is the network or the
 * deadline. None of them is worth giving up over, so they share one `retry` path instead of
 * pretending to be Douyu codes.
 *
 * A `DouyuProtocolError` is the third case and the one worth naming: the response arrived and
 * could not be read — not JSON, a shape the endpoint's schema refuses, a success with no code —
 * which is a contract change rather than a bad network, and the distinction is the difference
 * between "wait for the next sweep" and "look at this".
 */
function transportCodeOf(error: unknown): string {
  if (error instanceof DouyuProtocolError) return LocalCode.Protocol
  if ((error instanceof RoomReadError || error instanceof DouyuTransportError) && error.status > 0) {
    return httpCode(error.status)
  }
  return LocalCode.Transport
}

/**
 * One `http_<status>` code, spelled once.
 *
 * `transportCodeOf` writes it and 粉丝家园签到 has to recognise one of them — the 403 its CSRF
 * layer refuses with is a non-2xx, so the status is the only thing that reaches this layer —
 * and a second copy of the format is a second thing to keep in step with this one.
 */
function httpCode(status: number): string {
  return `http_${String(status)}`
}

/** A failure's message, for a person. Never carries credentials — see `parseCredential`. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The failing half of a `GradedCall`: the reason one call never reached Douyu, ready to report. */
interface UnreachedCall {
  readonly ok: false
  /** `transport`, `protocol`, or `http_<status>` — never a Douyu business code. See `transportCodeOf`. */
  readonly code: string
  readonly detail: string
}

/**
 * A call that either produced what it was asked for or produced the reason nothing arrived.
 *
 * `T` is what the call *yields*, which is a `DouyuResult` for every endpoint that answers a
 * verdict and the parsed page for the one that answers HTML. Spelling this as
 * `{ ok: true; value: T }` over its own shape would be a second way of saying the same thing
 * and a second thing for the grading below to keep in step with.
 */
type GradedCall<T> = { readonly ok: true; readonly reply: T } | UnreachedCall

/**
 * One call to Douyu, with a transport failure folded into this action's own reason.
 *
 * Every read and write an action makes goes through here, and it exists because of what
 * `protocol.ts` throws. That module's `throw` is the right call *there* — it cannot know what a
 * scheduled run should do about a timeout — but the seam forbids it *here*: a throw out of
 * `reconcile` takes the whole run's outcomes with it, including the actions that had already
 * finished, and leaves nothing behind for anyone to read. So the throw becomes a reason this
 * action reports (`transportFailure` grades it `retry`, the answer `probe` and `send` already
 * give the same class of failure) and the run goes on to the other enabled actions.
 *
 * Only the call is inside the `try`. A mistake in the grading around it has to surface as a
 * programming error rather than disguise itself as a bad network, which is why this wraps call
 * sites instead of the whole action — the same reason the seam's own bilibili precedent is a
 * helper rather than one `try` around `reconcile`.
 *
 * The sentence is the one the refusal path writes for the same call (`${what}失败：…`), so
 * "this call did not work" reads the same either way and only the code says which kind of
 * failure it was — a Douyu number, or the absence of one. `secrets` are the credential values
 * this call itself carries, and they are removed before the sentence travels: a run's `detail`
 * is rendered in the UI and written to a row, and no rule that reads the text can know a value
 * this call sent without being told it (`redactSecrets` in `text/redact.ts`).
 */
async function callGraded<T>(what: string, work: () => Promise<T>, ...secrets: string[]): Promise<GradedCall<T>> {
  try {
    return { ok: true, reply: await work() }
  } catch (error: unknown) {
    return {
      ok: false,
      code: transportCodeOf(error),
      detail: `${what}失败：${redactSecrets(errorText(error), secrets)}`
    }
  }
}

/**
 * The one grading a call that never reached Douyu gets.
 *
 * `retry`, and deliberately not one of the business codes: `errors.ts`'s table is a statement
 * about what *Douyu* answered, so folding a timeout into `1002` or `57002` would invent a
 * verdict nobody sent — and folding it into `no_verdict` would be worse, because that code is
 * the socket's "the service went quiet", a different fact with a different fix. The next sweep
 * is a fresh attempt, which is exactly what a network fault wants, and the text carries what
 * failed so a person reading the action log is not told "something went wrong".
 */
function transportFailure(actionKey: string, call: UnreachedCall): ActionOutcome {
  return actionFailure(actionKey, call.code, call.detail, 'retry')
}

/**
 * A refusal's code as a string.
 *
 * `DouyuFailure.code` is `number | null`, and `null` is documented as the socket's
 * "no verdict" — an HTTP family always carries a code, so this only ever answers
 * `no_verdict` for a shape that cannot occur here. Formatting a null with `String()`
 * would have turned it into the literal text `null`, which is exactly the kind of
 * plausible-looking nonsense a UI would happily render.
 */
function codeText(code: number | null): string {
  return code === null ? LocalCode.NoVerdict : String(code)
}

export const douyuPlatform: Platform = {
  /** The exact string the `accounts` and `tasks` rows carry; see `db/migrations.ts`. */
  key: 'douyu',
  label: '斗鱼',
  actions: ACTIONS,

  resolveTarget,
  probe,
  send,
  reconcile,
  refresh
}
