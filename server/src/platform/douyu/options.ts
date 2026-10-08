import type { ChoiceItem, ChoiceRead, ChoiceSource } from '../../actions/action-options.js'
import { getAccountCredentials } from '../../repo/accounts.js'
import { credentialValuesOf, redactCredentialParameters, redactSecrets } from '../../text/redact.js'
import type { DouyuResult } from './errors.js'
import { parseCredential, UNNAMED_ROOM } from './index.js'
import {
  type DouyuRequestOptions,
  type FanBadge,
  type FollowPage,
  readFanBadges,
  readFollowedRooms
} from './protocol.js'

/**
 * Douyu's two account-level reads, in the vocabulary a settings form speaks.
 *
 * **Why these live here and not beside the backpack read.** The other Douyu choice source is
 * `routes/douyu-backpack.ts`, a `routes/**` module that fetches its own endpoint; these two belong to
 * `platform/**` because they either already have a reader there (`readFanBadges`) or are a family's page
 * of an endpoint that module owns (`readFollowedRooms`, `protocol.ts`). Both answer in `ChoiceRead` —
 * a list, or a sentence about why there is no list — and neither throws: a form has to be able to draw
 * 「读不出来」 rather than a blank that reads as "you follow nobody".
 *
 * **The two keys, and why they are exactly these two.** `apps/web`'s action-settings panel resolves a
 * `choice` field through `GET /api/action-settings/options`, which reads `ActionDescriptor.optionFields[]`
 * and then looks the field's `source` up in `ChoiceSourceRegistry`; the keys are what that lookup is
 * keyed by, so they are an interface rather than a name:
 *
 *  - `douyu.followedRooms` — the rooms the account follows. It is the source of 清仓's 「默认倾泻直播间」:
 *    the one read that can answer "which rooms could I dump things into" is the account's own follow list.
 *  - `douyu.medalRooms` — the rooms where the account holds a fan medal, each with whether it has gained
 *    anything today. 清仓's other option does **not** use it (that is the backpack, `douyu.backpack`, the
 *    same source 亲密度任务's `giftAllowlist` uses and a *different* stored list); this one is the read the
 *    preferences page shows beside 清仓 without offering it as a knob (`ACTION_SHOWN_READS`). The number
 *    that page's help sentence calls 保留量 is **not** in this read: `reconcileClearout` sums each room's own
 *    daily 赠送礼物 remainder on top of these rows.
 *
 * Both are account-level, and that is not a coincidence: `ChoiceSource.read` is handed an account id and
 * nothing else, so a read of one *room* could not back a field today. Neither of these needs to know which
 * room anybody is looking at.
 *
 * **No credential is put into any message, URL or return value by anything here.** The composite token
 * and the jar travel as headers inside `protocol.ts`'s families; what this module adds is the scrubbing of
 * the sentences those calls *throw*, because a transport's own words are free to quote the request back
 * (`routes/douyu-backpack.ts` records the same reasoning for its own catch).
 */

/** The source 清仓's 「默认倾泻直播间」 field declares. */
export const FOLLOWED_ROOMS_SOURCE = 'douyu.followedRooms'

/** The source the preferences page reads for 「哪些牌子需要续」. */
export const MEDAL_ROOMS_SOURCE = 'douyu.medalRooms'

/**
 * How many pages of the follow list one read will walk.
 *
 * **This is this build's own ceiling, and the page size behind it is unknown**: no `follow/list` response
 * has ever been captured, so nothing here knows how many rooms a page carries. Twenty pages is far past
 * the accounts this repository has seen (the follow list it read carries two rooms) and far short of a
 * runaway loop if the service answered 200 forever.
 *
 * **Reaching it is reported rather than truncated.** A partial follow list is the one answer a person
 * cannot tell from the right one — they would read "this room is not in my list" — so the cap answers
 * `unavailable` with a sentence naming it. That is the design's §7 requirement (「读的时候要按 page 翻，
 * 并给一个上限而不是截断」) read strictly, and it is the same rule `ChoiceRead` states for the backpack:
 * an `items` list is always a complete fact about the account, or it is not answered at all.
 */
const FOLLOW_PAGES_MAX = 20

/** The two credential halves every read here needs. Explicit rather than a blob, as the sibling source is. */
export interface DouyuFormCredential {
  /** The composite token, sent as a `token` header. */
  readonly token: string
  /**
   * The web session jar, sent as `cookie`.
   *
   * Never empty-checked *here*: `readFanBadges` and `readFollowedRooms` both omit the header when the jar
   * is empty (`routes/douyu-backpack.ts` records why), and which of the two halves a Douyu read keys on
   * was never isolated — so both travel when the account has both.
   */
  readonly webCookies: string
}

/** What one read may be tuned with. Only the page ceiling, for the boundary test and for tomorrow. */
export interface FollowedRoomsOptions {
  readonly pagesMax?: number
}

/** One page, as the loop below needs it: the rooms, plus what the page said about how many there are. */
interface FollowPageRead {
  readonly kind: 'ok'
  readonly rooms: readonly FollowedRoomChoice[]
  readonly total: number | null
  readonly pageCount: number | null
}

/** One room of one page, in the words a person reads. */
interface FollowedRoomChoice {
  readonly value: string
  readonly label: string
}

/**
 * The rooms this account follows, page by page.
 *
 * **One room per page is de-duplicated by room number before anything else**, which is what makes the walk
 * safe to keep asking: a service that ignores `page` returns the same page again, the second read adds no
 * new room, and the walk ends — the same guard `reconcileYubaSign` uses for the same reason.
 *
 * The three other ways it can stop are the payload's own: an empty page means there is no next one; a
 * declared `total` that the accumulated count has reached means there is nothing left; and a declared
 * `pageCount` that the page number has reached means the same. Only the first of the three is measured on
 * this endpoint (see `readFollowedRooms`); the other two are optional fields that are used when they
 * arrive.
 */
export async function readDouyuFollowedRooms(
  credential: DouyuFormCredential,
  options: FollowedRoomsOptions = {}
): Promise<ChoiceRead> {
  const pagesMax = options.pagesMax ?? FOLLOW_PAGES_MAX
  const rooms = new Map<string, ChoiceItem>()

  for (let page = 1; page <= pagesMax; page += 1) {
    const read = await oneFollowPage(credential, page)
    if (read.kind === 'unavailable') return read

    if (read.rooms.length === 0) return { kind: 'ok', items: [...rooms.values()] }

    const before = rooms.size
    for (const room of read.rooms) {
      if (rooms.has(room.value)) continue
      rooms.set(room.value, { value: room.value, label: room.label, count: null, costsSomething: null })
    }

    // Nothing new on this page: either the list has ended on a page shorter than the last one, or the
    // service ignored `page`. Both mean "stop", and neither is an error.
    if (rooms.size === before) return { kind: 'ok', items: [...rooms.values()] }
    if (read.pageCount !== null && page >= read.pageCount) return { kind: 'ok', items: [...rooms.values()] }
    if (read.total !== null && rooms.size >= read.total) return { kind: 'ok', items: [...rooms.values()] }
  }

  return {
    kind: 'unavailable',
    reason: `读取关注列表失败：这份列表比这一版一次能读的 ${String(pagesMax)} 页还长（每页多少条这一版并不知道），所以这一版不敢把它当成一份完整的清单给你勾。`
  }
}

/**
 * One page of the follow list, in the form's vocabulary.
 *
 * **Every failure is a sentence, because every failure has a person behind it** — the same contract the
 * backpack reader states. A refusal, a transport fault and a body this build cannot read all end as
 * `unavailable` with something to act on, and what none of them may do is answer with an empty list: on
 * this endpoint that reads as "you follow nobody", which would make the form unselectable and the reason
 * invisible.
 *
 * `error: -1` gets its own sentence because it is the one refusal this family's own probe recorded, and
 * the two readings it stands for need different words: the captured body is
 * `{"code":-1,"error":-1,"msg":"用户未登陆或token已过期"}` and it was answered to a request that carried
 * neither a login cookie nor a usable token — and the same body is what the catalogue's probe got with a
 * token that had expired. Both halves travel on this call, so the sentence names the half the account
 * actually has.
 */
async function oneFollowPage(
  credential: DouyuFormCredential,
  page: number
): Promise<FollowPageRead | { readonly kind: 'unavailable'; readonly reason: string }> {
  let reply: DouyuResult<FollowPage>
  try {
    reply = await readFollowedRooms(credential.token, credential.webCookies, page)
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { kind: 'unavailable', reason: `读取关注列表失败：${scrub(detail, credential)}（网络或超时）` }
  }

  if (!reply.ok) return { kind: 'unavailable', reason: followRefusal(reply.code, reply.message, credential) }

  return {
    kind: 'ok',
    rooms: reply.data.rooms.map(room => ({ value: room.roomId, label: roomLabel(room.nickname, room.roomName) })),
    total: reply.data.total,
    pageCount: reply.data.pageCount
  }
}

/** What one row is called in a list of choices: a name, and never a room number. */
function roomLabel(nickname: string, roomName: string): string {
  const name = nickname.trim()
  if (name !== '') return name
  const title = roomName.trim()
  return title === '' ? UNNAMED_ROOM : title
}

/**
 * The sentence a refusal produces, with the one measured code spelled out.
 *
 * `null` is `errors.ts`'s "the endpoint sent no verdict", which an HTTP family never does — but the type
 * carries it, so the sentence prints 未知 rather than the string `null`.
 */
function followRefusal(code: number | null, message: string, credential: DouyuFormCredential): string {
  const said = message.trim() === '' ? '' : `：${message.trim()}`
  const saidCode = code === null ? '未知' : String(code)
  if (code === FOLLOW_NOT_LOGGED_IN) {
    return credential.webCookies === ''
      ? `读取关注列表失败：斗鱼说这个账号没有登录，而这个账号没有存网页会话（粘贴绑定的账号本来就没有）——重新扫码绑定一次就能读到。${saidCode}${said}`
      : `读取关注列表失败：斗鱼说这个账号没有登录、或者 token 过期了——重新扫码绑定一次。${saidCode}${said}`
  }
  return `读取关注列表失败：斗鱼返回错误码 ${saidCode}${said}`
}

/**
 * `-1`, and it is named here rather than in `errors.ts` for the reason that module gives: it is a small
 * integer Douyu reuses, and this endpoint's own answer to "not identified" is the one place it means this.
 */
const FOLLOW_NOT_LOGGED_IN = -1

/**
 * The rooms where this account holds a fan medal, each with today's reading beside it.
 *
 * The read is `readFanBadges` — the same one 粉丝家园签到 and 钓鱼 use — and the new field is
 * `FanBadge.todayIntimacy`, the badge wall's fourth cell, parsed by position because that cell carries no
 * attribute of any kind.
 *
 * **An empty wall is answered as an empty list here, and that is a measurement rather than an oversight.**
 * `ChoiceRead` says an empty `items` is always a fact about the account, and for this family it is: a badge
 * wall read without a login **redirects** (`GET /member/cp/getFansBadgeList` answered `302` with an empty body
 * in this project's own probe run), and `readFanBadges` throws on a non-2xx — so a read that *returns* zero
 * rows is an account with no medals, and a dead session never reaches this line. 清仓 does not read it
 * that way (it stops rather than spending on a possibly-blind read), and the two are different questions:
 * this one is being asked what it read, that one is deciding whether to give something away.
 *
 * **「今天还没送过」 is carried in the label, and here is why it is not in another field.** `ChoiceItem`
 * has three slots and only one of them fits a fact about a room: `count` is documented as "what the account
 * holds of it" (a room is not held, and a medal is not a quantity of a gift), and `costsSomething` is the
 * Platform's *price* marking on an item. Writing today's reading into either would be bending a field's
 * meaning to fit a value, which is how one fact ends up with two. The label is the one slot a form shows
 * verbatim, so it carries the whole sentence a person needs — which is also why it does not stop at the
 * anchor's name.
 */
export async function readDouyuMedalRooms(
  credential: DouyuFormCredential,
  options: DouyuRequestOptions = {}
): Promise<ChoiceRead> {
  let badges: readonly FanBadge[]
  try {
    const list = await readFanBadges(credential.token, credential.webCookies, options)
    badges = list.badges
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { kind: 'unavailable', reason: `读取粉丝牌失败：${scrub(detail, credential)}（网络或超时）` }
  }

  return { kind: 'ok', items: badges.map(toMedalChoice) }
}

/**
 * One medal, as a choice.
 *
 * `count` and `costsSomething` are `null` on purpose, and the doc on `readDouyuMedalRooms` says why: this
 * source makes no claim about either. `null` rather than `false`/`0` is the difference between "this source
 * does not say" and "this source says none", and the form renders nothing for the first.
 */
function toMedalChoice(badge: FanBadge): ChoiceItem {
  const name = badge.anchorName.trim() === '' ? UNNAMED_ROOM : badge.anchorName
  return {
    value: badge.roomId,
    label: `${name}（${medalStateIn(badge.todayIntimacy)}）`,
    count: null,
    costsSomething: null
  }
}

/**
 * 今日亲密度, as the one sentence a person reads — and the measurement behind each branch.
 *
 * The number is **how much intimacy this room gained today**, and it was measured moving without any prop
 * leaving the backpack (room 12306 read `2` at 02:05 and `12` at 15:5x while the prop count stayed at 60),
 * so it is a *result* and not a gift counter. `0` therefore means "nothing at all was gained here today",
 * from which 「今天还没送过」 follows because a gift is one of the things that gains intimacy. That is an
 * inference, it is the one a person acts on, and it is written here rather than left for the reader to
 * make.
 *
 * `null` is the third branch and never `0`: a cell this build could not read is not a room that gained
 * nothing.
 */
function medalStateIn(todayIntimacy: number | null): string {
  if (todayIntimacy === null) return '今日亲密度读不出来'
  if (todayIntimacy === 0) return '今日亲密度 0，今天还没送过'
  return `今日亲密度 ${String(todayIntimacy)}，今天已经涨过了`
}

/**
 * One sentence, with the values this call sent taken back out of it.
 *
 * Two rules, for the reason `text/redact.ts` gives: the values (which only the caller has) and the
 * parameter names (which catch what the values alone would not). The value list is
 * `credentialValuesOf`'s now — the token plus every value the jar carries, with the one-character
 * ones already dropped, per `redactSecrets`'s own contract. That function is the one home for the
 * split and for the contract; this module used to keep a private copy of both.
 */
function scrub(text: string, credential: DouyuFormCredential): string {
  return redactCredentialParameters(redactSecrets(text, credentialValuesOf(credential.token, credential.webCookies)))
}

/** The storage handle these sources resolve their account from. */
type Database = Parameters<typeof getAccountCredentials>[0]

/**
 * The account's credential, or the sentence saying why there is none.
 *
 * Two states, two sentences, because their next moves differ: an account row that is gone is a re-bind,
 * while a blob this build cannot parse is the paste path having stored something unusable. Both use
 * `parseCredential` — the adapter's own reader, imported rather than reimplemented — and neither returns
 * any part of the blob; only the two halves a read sends leave this function.
 */
function credentialOf(
  db: Database,
  accountId: number
): { readonly read: ChoiceRead } | { readonly credential: DouyuFormCredential } {
  const blob = getAccountCredentials(db, accountId)
  if (blob === null) return { read: { kind: 'unavailable', reason: '这个账号已经不在了，先重新绑定一次。' } }

  const parsed = parseCredential(blob)
  if (parsed === null) {
    return { read: { kind: 'unavailable', reason: '这个账号的凭据读不出来，重新扫码绑定一次就能读到它。' } }
  }

  return { credential: { token: parsed.token, webCookies: parsed.webCookies } }
}

/** `douyu.followedRooms` — the rooms the account follows, as a source the form can ask for. */
export function followedRoomsSource(db: Database): ChoiceSource {
  return {
    key: FOLLOWED_ROOMS_SOURCE,
    read: async (accountId: number): Promise<ChoiceRead> => {
      const resolved = credentialOf(db, accountId)
      if ('read' in resolved) return resolved.read
      return await readDouyuFollowedRooms(resolved.credential)
    }
  }
}

/** `douyu.medalRooms` — the medals the account holds, as a source the form can ask for. */
export function medalRoomsSource(db: Database): ChoiceSource {
  return {
    key: MEDAL_ROOMS_SOURCE,
    read: async (accountId: number): Promise<ChoiceRead> => {
      const resolved = credentialOf(db, accountId)
      if ('read' in resolved) return resolved.read
      return await readDouyuMedalRooms(resolved.credential)
    }
  }
}

/**
 * Both sources, for one registration call.
 *
 * The backpack source (`douyu.backpack`) is deliberately **not** here: it belongs to
 * `routes/douyu-options.ts`, which registers it beside the module that reads it. This function exists so
 * that adding the other two is one line there rather than a second table somewhere.
 */
export function douyuFormSources(db: Database): readonly ChoiceSource[] {
  return [followedRoomsSource(db), medalRoomsSource(db)]
}
