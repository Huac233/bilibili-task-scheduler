import { z } from 'zod'

import type { ChoiceItem, ChoiceRead } from '../actions/action-options.js'
import { credentialValuesOf, redactCredentialParameters, redactSecrets } from '../text/redact.js'

/**
 * Douyu's backpack, read and narrowed to the one fact a gift allowlist needs.
 *
 * **Read-only, and the only thing this module can do is look.** There is no donate call here, no
 * gift id sent anywhere, and nothing that writes: the endpoint is a `GET`, the parsed result is a
 * list of what the account already holds, and the caller is a form. That is deliberate rather than
 * incidental — the action this feeds is the one that would spend something, so the read that helps
 * a person declare what may be spent is kept a read.
 *
 * **The request shape is a capture that this build has now replayed live.** `GET
 * https://pcapi.douyucdn.cn/japi/prop/backpack/pc/v1?rid=<room>` was captured, on this repository's
 * own Douyu account, in a PC-client session; the saved flow carries the response parsed below, and
 * the same request against that same account answered `error: 0` with its current backpack. The
 * capture's flow carries **fifteen** header names; this build sends four of them — `referer`,
 * `accept-language`, `user-agent` and `token` — and adds two the capture did not carry: `accept`,
 * and `cookie` when the account has a session to send. `Host` comes from the runtime. Ten names are
 * therefore not sent, and the two that matter are stated rather than dropped quietly: `auth`, a
 * signature whose algorithm nothing in this repo documents (the capture shows one value and no way
 * to reproduce it), and `User-Device`, a value derived from the machine's MAC address that the token
 * beside it already identifies the account without. The other eight — `ver`, `sv`, `aid`, `time`,
 * `Jwt-Token`, `Content-Type`, `Connection`, `Accept-Encoding` — are the captured client's own
 * transport bookkeeping, and nothing here reads them. If Douyu refuses the call for want of `auth`,
 * the failure is a sentence on the form and not a silent empty list — see `ChoiceRead`.
 *
 * *The count is stated because it used to be wrong:* this said "two headers … are not sent here",
 * which understated the difference by eight names and made an incomplete header set look like a
 * deliberate, fully accounted one. `douyu-backpack.test.ts` pins the set that is actually sent, so
 * the two cannot drift apart again in silence.
 *
 * **This is not the family the account's own gift-send was captured on, and the difference is not
 * load-bearing.** That capture is `www.douyu.com/japi/prop/backpack/web/v5` with the session alone
 * (see `readGiftBackpack` in `platform/douyu/protocol.ts`, which is what the action itself reads
 * through); this endpoint is the PC client's twin, on a different host, with the composite token
 * *beside* the session. Both were asked for the same account and both answered the same two items —
 * the same `id`s, `name`s and `count`s — so the form does not depend on which of the two it reads.
 * They are not the same shape: the web family's `chatPic` is a list of sized variants where this
 * one's is a single path, and the reader parses neither.
 *
 * **`rid` is required by the endpoint and names no room of ours, and what it requires is now
 * measured rather than assumed.** See `BACKPACK_RID`: the `'0'` this file used to send was refused,
 * which is what made the form draw a sentence where the choices belong.
 *
 * **No credential appears in any message.** The composite token is the account credential and the
 * web session is a cookie jar; both travel in headers and neither is put into a string by anything
 * here. That is a property this module has to **keep** rather than one it can assume, because the
 * sentence a transport failure is reported in is built from words that came from below: the `catch`
 * in `readDouyuBackpack` scrubs them with the values this very call sent before they reach a reader.
 * (`./douyu/errors.js` does the same for the families that throw; this endpoint answers in sentences
 * instead of throwing, so it does it where the sentence is built. Nothing here builds a message out
 * of a body.)
 */

/**
 * This project's house ceiling for one HTTP call, in milliseconds.
 *
 * Restated rather than imported from `platform/douyu/protocol.ts`, which owns its own copy of the
 * same number: the value is a shared convention and not a shared constant, and that file says so
 * where it states it. The two are one fact with two homes on purpose — a Douyu endpoint that turns
 * out to be slow must be able to move this without moving that.
 */
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * The desktop-Chrome user agent this build sends.
 *
 * **It is not the capture's, and this comment used to say it was.** The captured request carried a
 * bare `Mozilla/5.0`; this string is the one `platform/douyu/protocol.ts` holds as `PC_USER_AGENT`,
 * described there as verified in that module's own live probes. Sending it is a choice this build
 * makes, so it is named as one. Byte-identical to that constant and deliberately not imported: the
 * value is private to a module that owns three header dialects, and reaching into it for a string
 * would put this endpoint inside that module's business.
 */
const PC_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * Where the backpack lives.
 *
 * The host is the PC client's API rather than `apiv2.douyucdn.cn`, and it is written out in full
 * here because nothing else in this build talks to it — `protocol.ts`'s families are all a
 * different host and a different verdict field, and folding one endpoint into that table would
 * make the table's own description of itself untrue.
 */
export const BACKPACK_URL = 'https://pcapi.douyucdn.cn/japi/prop/backpack/pc/v1'

/**
 * The room number this read sends, and **the measurements that decided it**.
 *
 * The endpoint requires `rid`, and it names no room of ours: the captured call passed a room id and
 * the answer was the account's own backpack rather than that room's. Five live reads on this
 * repository's own account settle what the parameter actually is —
 *
 *   `0`        → `{"error":1000,"msg":"rid缺失或不合法！"}`
 *   `1`        → `error: 0`
 *   `12306`    → `error: 0`, a room this account holds a 粉丝牌 in
 *   `12293234` → `error: 0`, its other 粉丝牌 room
 *   `74960`    → `error: 0`, a room id out of Douyu's own front-end bundle, no 粉丝牌 there
 *
 * — and the four that answered carried a **byte-identical body**, not merely the same item count.
 * So the service wants a room *number*, checks that it has one, and looks nothing up by it: the
 * backpack is the account's whatever is named, and no room of a person's own enters the request.
 *
 * `1` is sent because it satisfies the one rule measured and cannot be misread as naming a room this
 * build has a reason to care about. **`'0'` was the value here before this measurement**, recorded in
 * this file as an unverified substitution and refused in fact; `BACKPACK_BAD_RID` is the branch that
 * names it if the service ever stops accepting this one.
 */
const BACKPACK_RID = '1'

/**
 * The one item field this option needs that Douyu types as either a number or a string.
 *
 * The capture is the source: `count: 60` arrived as a JSON number, while `expiry: 4` and `exp`
 * arrived as numbers too — and the family's own convention (recorded in `protocol.ts`, where the
 * same union is called `counter`) is that Douyu switches between the two spellings per endpoint and
 * per mood. A union rather than a coercion for exactly that reason: `z.coerce.number()` accepts
 * `null`, `true` and `[]` as 0, and `0 of a gift` is a claim this form must not make by accident.
 */
const counter = z.union([z.number(), z.string()]).pipe(z.coerce.number())

/**
 * One backpack entry, narrowed to what a choice needs.
 *
 * **Five of the capture's thirty-six fields are modelled and the rest are dropped**, which is the
 * same discipline `roomDailyTaskSchema` records: a field nothing reads is a field somebody can
 * build a judgement on by accident. What is kept is `id` (the value the allowlist stores), `name`
 * (the label a person reads), `count` (how many the account holds), `expiry` (seconds, or whatever
 * the service means by it — nothing here reads it, and it is modelled only because the endpoint's
 * shape is what this schema documents) and `isValuable`.
 *
 * **`priceType` is deliberately absent, and that absence is the feature.** The Platform uses the
 * name `priceType` for two different fields — the gift list's own `2` on the captured item, whose
 * meaning nothing here has measured — and the capture is proof that a `2` is not "this costs
 * money": the item it arrived on is one a signed-in account holds sixty of. A field whose meaning
 * is unmeasured must not be modelled, because the next reader would key a "free" filter off it and
 * the allowlist would be wrong in the direction that spends. `isValuable` is modelled instead, and
 * even it is only reported as a fact beside the name rather than as a filter: see `costsOf`.
 */
export const backpackItemSchema = z.object({
  id: counter,
  name: z.string().default(''),
  count: counter.default(0),
  expiry: counter.default(0),
  isValuable: counter.default(0)
})

/**
 * The envelope, narrowed to the list.
 *
 * `data.list` is required, so a response that renamed it fails this parse and surfaces as a
 * contract change instead of as "this account holds no gifts" — which is the one reading a form
 * must never invent. `data.totalNum` and the rest of the envelope are not modelled: they count the
 * whole backpack including the sections a 粉丝牌 chore never sends from.
 */
const backpackSchema = z.object({ data: z.object({ list: z.array(backpackItemSchema) }) })

/** One item, as the parse narrowed it. */
export type BackpackItem = z.infer<typeof backpackItemSchema>

/**
 * The verdict field, and the "not signed in" answer inside it.
 *
 * Douyu answers HTTP 200 with the business code in the body, so `error` is the only thing that
 * separates a list from a refusal. `9` is measured: an unauthenticated call to this same family
 * answered `{"error":9,"msg":"请登录"}`. The code is named here rather than in `errors.ts` because
 * nothing classifies it — it is this endpoint's own answer, decided where the endpoint is called.
 */
const BACKPACK_NOT_LOGGED_IN = 9

/**
 * The verdict the endpoint answers a `rid` it will not take, named where it was seen.
 *
 * `1000` with `rid缺失或不合法！` is measured — it is what `rid=0` answers — and it is named here
 * rather than in `errors.ts` for the reason above: it is this endpoint's own answer, and the code is
 * a small integer Douyu reuses elsewhere. It earns a branch of its own because `rid` is **this
 * build's to fill**: if the constant above stops being accepted, the sentence has to name the
 * parameter at fault instead of printing a number nobody can act on.
 */
const BACKPACK_BAD_RID = 1000

const backpackEnvelopeSchema = z.object({
  error: counter,
  msg: z.string().default('')
})

/** What a reader is handed: the credential halves this call needs, and nothing else. */
export interface BackpackRequest {
  /** The composite token, sent as the `token` header. */
  readonly token: string
  /**
   * The web session jar, sent as `cookie` when it is non-empty.
   *
   * The capture of this endpoint sent no `cookie` header at all, so this is sent only when the
   * account has one and is otherwise omitted: a header the capture never carried is the more
   * likely of the two to be refused.
   */
  readonly webCookies: string
}

/**
 * Performs one call. Injected, so a test never reaches the network and production passes `fetch`.
 *
 * The signature is the platform's own, deliberately: a wrapper type here would be a second
 * vocabulary for a request, and the only thing this module actually needs from it is `ok`, `status`
 * and `text`.
 */
export type BackpackFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * Reads the backpack, answering in `ChoiceRead` rather than throwing.
 *
 * **Every failure is a sentence, because every failure has a person behind it.** A refusal, a
 * transport fault and a body this build cannot read all end up as `unavailable` with a reason a
 * person can act on — the account needs re-binding, the service is unwell, or the contract changed
 * and someone has to look. What none of them may do is answer with an empty list, which on this
 * endpoint would read as "this account holds no free gifts" and would be the one wrong answer a
 * person cannot tell from the right one.
 */
export async function readDouyuBackpack(
  request: BackpackRequest,
  fetchImpl: BackpackFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ChoiceRead> {
  const url = `${BACKPACK_URL}?${new URLSearchParams({ rid: BACKPACK_RID }).toString()}`
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    referer: 'https://pcapi.douyucdn.cn',
    'user-agent': PC_USER_AGENT,
    token: request.token,
    ...(request.webCookies === '' ? {} : { cookie: request.webCookies })
  }

  let status = 0
  let body = ''
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      // Armed for the whole exchange, body included, because `fetch` resolves on headers: without
      // it a service that answers and then stalls would hold this request open indefinitely.
      signal: AbortSignal.timeout(timeoutMs)
    })
    status = response.status
    body = await response.text()
  } catch (cause: unknown) {
    // **The transport's own words are scrubbed before they are put into a sentence, because the
    // credential this call sent is in a header and a sentence about a failed request is exactly
    // where a header gets quoted back.** What this comment used to say — "no URL and no body in the
    // message: the URL is the only place a token could hide" — is true of the *string this module
    // builds* and false as a property of the endpoint: the URL here is a constant carrying `rid`
    // only, and the composite token and the jar travel as `token`/`cookie` headers, so a message
    // from below has somewhere to carry them even though this module never puts them there. The
    // module claims "no credential appears in any message"; that claim is enforced here rather than
    // assumed, with the same two rules `BiliHttp.redact` uses (`text/redact.ts`): the values this
    // call sent, and the parameter names that identify one the values alone would not catch.
    const detail = cause instanceof Error ? cause.message : String(cause)
    // The two halves this call sent, with the one-character values already dropped by
    // `credentialValuesOf` — see it for why that contract lives there rather than here.
    const sent = credentialValuesOf(request.token, request.webCookies)
    return {
      kind: 'unavailable',
      reason: `读取斗鱼背包失败：${redactCredentialParameters(redactSecrets(detail, sent))}（网络或超时）`
    }
  }

  if (status !== 200) {
    return { kind: 'unavailable', reason: `读取斗鱼背包失败：斗鱼返回 HTTP ${String(status)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { kind: 'unavailable', reason: '读取斗鱼背包失败：返回的不是 JSON（可能要求重新登录）' }
  }

  const envelope = backpackEnvelopeSchema.safeParse(parsed)
  if (!envelope.success || envelope.data.error !== 0) {
    const code = envelope.success ? envelope.data.error : null
    if (code === BACKPACK_NOT_LOGGED_IN) {
      // **The sentence has to match what this request carried.** It used to say the account's web
      // session had expired and to send the reader off to scan again — while a paste-bound account
      // stores no jar, so `webCookies` is `''` and the request carried no `cookie` header at all.
      // Naming a session that was never sent points a person at the half of the credential their
      // account does not have, and the remedy it recommends is the one that account never went
      // through. Both cases are refusals of the same code and they need different sentences.
      return request.webCookies === ''
        ? {
            kind: 'unavailable',
            reason:
              '斗鱼说这个账号没有登录，而这个账号没有存网页会话（粘贴绑定的账号本来就没有）。重新扫码绑定一次，请求就会把网页会话带上。'
          }
        : { kind: 'unavailable', reason: '这个账号的网页会话已失效，重新扫码绑定一次就能读到背包。' }
    }
    if (code === BACKPACK_BAD_RID) {
      return {
        kind: 'unavailable',
        reason: '读取斗鱼背包失败：斗鱼说 rid 缺失或不合法，而这个值由这一版自己填，要改的是这一版。'
      }
    }
    return { kind: 'unavailable', reason: `读取斗鱼背包失败：斗鱼返回错误码 ${code === null ? '未知' : String(code)}` }
  }

  const list = backpackSchema.safeParse(parsed)
  if (!list.success) {
    // A contract change, not an empty backpack: the envelope arrived with `error: 0` and carried no
    // readable list, which is a shape nobody here can explain and somebody has to look at.
    return { kind: 'unavailable', reason: '读取斗鱼背包失败：返回结构变了，这一版读不懂。' }
  }

  return { kind: 'ok', items: list.data.data.list.map(toChoiceItem) }
}

/**
 * One parsed item, as the form reads it.
 *
 * The `label` is the Platform's own `name` where it has one, and the expiry is dropped rather than
 * given a place: the capture's `expiry` is a bare `4` with no unit stated anywhere in this repo, so
 * a form printing 「4 天后过期」 would be claiming a unit nobody measured. `count` is the measured
 * fact and the only one offered as a number.
 *
 * `isValuable` becomes `costsSomething` in one direction only — a nonzero value is reported as
 * "the Platform marks this as 付费道具", and a zero is `false`, which the form must **not** read as
 * "free". See `backpackItemSchema`: the Platform's own flags on this payload do not separate free
 * from paid, which is the whole reason a person has to tick the list himself.
 */
function toChoiceItem(item: BackpackItem): ChoiceItem {
  const name = item.name.trim()
  return {
    value: String(item.id),
    label: name === '' ? `编号 ${String(item.id)}` : name,
    count: item.count,
    costsSomething: item.isValuable !== 0
  }
}
