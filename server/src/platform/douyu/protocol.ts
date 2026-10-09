import { type ZodType, z } from 'zod'

import { redactCredentialParameters } from '../../text/redact.js'
import {
  ACTIVITY_ALREADY_SIGNED,
  ACTIVITY_SIGN_SUCCESS,
  CLIENT_SIGN_ALREADY_SIGNED,
  classifyError,
  DouyuProtocolError,
  type DouyuResult,
  DouyuTransportError,
  readErrorCode
} from './errors.js'
import { decodeStt } from './socket.js'

/**
 * Douyu HTTP endpoints, as six families that speak three dialects, plus one
 * endpoint that answers **HTML** and no envelope at all.
 *
 *   `h5nc/*`       `apiv2.douyucdn.cn` — the app's H5 sign pages. Authenticates by
 *                  the composite token alone, which travels in the query string,
 *                  in a header and in the body at once. It must NOT be sent a web
 *                  cookie: that is what turns a valid token into `999999 系统错误`.
 *   `japi/inspire` `apiv2.douyucdn.cn` — the ad fish-ball pair.
 *   鱼吧            `yuba.douyu.com` and `mapi-yuba.douyu.com` — the token arrives
 *                  as `dy-token` (PC) or a bare `token` (android gateway), never
 *                  in the URL, and the verdict field is `status_code`.
 *   `carnivalApi`  `www.douyu.com` — the activity sign-in. This module calls it with a bare
 *                  `token` header; the page it drives does the same job with its own cookie
 *                  session and sends no `token` at all (the 2026-10-09 capture's `doSign` carried
 *                  `acf_auth`/`dy_auth` and 36 other cookies instead), which is why the two shapes
 *                  are compared field by field at `signActivity` rather than assumed equal.
 *   `userSignActivity` `apiv2.douyucdn.cn` — 打卡分鱼丸's one read and two writes. Same
 *                  host and the same `error` verdict as `h5nc/*`, but the token must be
 *                  paired with a `dy_cookie` value twice over — header cookie and body
 *                  `dy_token`, equal — because this family's CSRF is a double submit.
 *   `interactnc/web` `www.douyu.com` — 粉丝家园's per-room sign and a room's 粉丝牌任务清单, and
 *                  the only family here whose CSRF value this module does **not** mint: the sign's
 *                  body `ctn` must equal the `acf_ccn` cookie, which the badge wall re-issues on
 *                  every read and which therefore travels in as a parameter — and then out in
 *                  **both** places, the body and the request's own cookie header, because the check
 *                  is a double submit and half of one is refused. The task list needs no `ctn` at
 *                  all. Its badge wall is the one endpoint that answers HTML rather than a verdict.
 *   `revenuenc/web/actfans` `www.douyu.com` — 粉丝家园钓鱼, which is a **cycle** rather than a call:
 *                  a panel read, a cast that spends bait and answers the panel's own `baits`/`fishing`
 *                  back, a wait the panel itself times, and a `reelIn` that brings the fish in. It
 *                  borrows the family above's CSRF arrangement — `ctn` in the body, `acf_ccn` minted by
 *                  that same badge-wall read — and lends the account's whole web session, because the
 *                  two families authenticate the same way.
 *   `japi/prop`    `www.douyu.com` — the gift pair: the backpack this account holds, and the one call
 *                  in this module that **gives something away in public and cannot take it back**. The
 *                  web session is the whole of its identity — the captured pair carried no `token`
 *                  header — and both answers carry the same `data.list[]`, so one schema describes the
 *                  row for both and a donate's own receipt is where the new count comes from.
 *
 * Two rules hold everywhere in this module.
 *
 * The business code, not the HTTP status, is the outcome, so a refusal is returned
 * as `DouyuResult` data rather than thrown. Only a broken transport or a response
 * that cannot be read at all throws — a caller looping on a schedule treats those
 * as "the network is unwell", which is a different problem from "Douyu said no".
 * The badge wall is the one endpoint with no code to return, so it answers its parse
 * and throws for the same two things; every caller grades that throw the same way.
 *
 * Payload fields keep the names the service gives them. Renaming is not free here:
 * §2.2 records a case where a plausible rename (`sign_silver` read as "鱼丸 earned")
 * survived a whole session before an account that had just received 15 鱼丸
 * disproved it, because the field was 0. A caller reading `sign_silver` gets the
 * API's field and the doc comment's caveat; a caller reading `silverEarned` would
 * get a claim this module cannot support.
 */

/**
 * Applied when a caller supplies no deadline.
 *
 * 15 s is this project's house ceiling for one HTTP call, restated here rather than
 * imported because the Douyu and Bilibili stacks are separate transports: the value
 * is a shared convention, not a shared constant, and this side has to be free to
 * move on its own when a Douyu endpoint turns out to be slower.
 */
const DEFAULT_TIMEOUT_MS = 15_000

const API_ORIGIN = 'https://apiv2.douyucdn.cn'
const YUBA_ORIGIN = 'https://yuba.douyu.com'
const YUBA_MAPI_ORIGIN = 'https://mapi-yuba.douyu.com'
const WEB_ORIGIN = 'https://www.douyu.com'

export const CSRF_COOKIE_URL = `${API_ORIGIN}/h5nc/csrf/getCsrfCookie`
export const SIGN_STATUS_URL = `${API_ORIGIN}/h5nc/sign/getSign`
export const SIGN_SEND_URL = `${API_ORIGIN}/h5nc/sign/sendSign`
export const SIGN_REMEDY_URL = `${API_ORIGIN}/h5nc/Sign/getRemedySign`
export const FISH_BALL_BALANCE_URL = `${API_ORIGIN}/japi/inspire/api/ad/inspire/getFishBallNum`
export const FISH_BALL_CLAIM_URL = `${API_ORIGIN}/japi/inspire/api/ad/inspire/sendFishBall`
export const YUBA_FOLLOWED_GROUPS_URL = `${YUBA_ORIGIN}/wbapi/web/group/myFollow`
export const YUBA_FAST_SIGN_URL = `${YUBA_MAPI_ORIGIN}/wb/v3/fastSign`
export const YUBA_TOPIC_SIGN_URL = `${YUBA_ORIGIN}/ybapi/topic/sign`
export const ACTIVITY_SIGN_URL = `${WEB_ORIGIN}/japi/carnivalApi/sign/doSign`
export const ACTIVITY_SIGN_STATUS_URL = `${WEB_ORIGIN}/japi/carnivalApi/nc/sign/getStatus`
export const GROWTH_POOL_STATUS_URL = `${API_ORIGIN}/h5nc/userSignActivity/getSignInfo`
export const GROWTH_POOL_JOIN_URL = `${API_ORIGIN}/h5nc/userSignActivity/joinSignActivity`
export const GROWTH_POOL_CLOCK_URL = `${API_ORIGIN}/h5nc/userSignActivity/clockSignActivity`
export const FAN_BADGES_URL = `${WEB_ORIGIN}/member/cp/getFansBadgeList`
export const FANSHOME_SIGN_URL = `${WEB_ORIGIN}/japi/interactnc/web/fanshome/sign`
export const ROOM_TASK_LIST_URL = `${WEB_ORIGIN}/japi/interactnc/web/fans/userTaskList`
export const FISHING_HOME_URL = `${WEB_ORIGIN}/japi/revenuenc/web/actfans/fishing/homePage`
export const FISHING_CAST_URL = `${WEB_ORIGIN}/japi/revenuenc/web/actfans/fishing/fishing`
export const FISHING_REEL_IN_URL = `${WEB_ORIGIN}/japi/revenuenc/web/actfans/fishing/reelIn`
export const FISHING_CODEX_URL = `${WEB_ORIGIN}/japi/revenuenc/web/actfans/achieve/accList`
export const FISHING_LOTTERY_PANEL_URL = `${WEB_ORIGIN}/japi/revenuenc/web/actfans/userLottery/panelInfo`
export const PROP_BACKPACK_URL = `${WEB_ORIGIN}/japi/prop/backpack/web/v5`
export const PROP_DONATE_URL = `${WEB_ORIGIN}/japi/prop/donate/mainsite/v5`

/** The ad slot the fish-ball pair is bound to; it is a constant of the campaign, not of the account. */
export const AD_FISH_BALL_POS_CODE = '1064246'

/**
 * The activity's alias, and **a request parameter and nothing else**.
 *
 * `doSign` refuses with `1007 签到别名不能为空` unless it is in the body, and the
 * pre-flight read wants the same value in its query string. It is not a name: it is an
 * identifier nobody can read, so it never appears in a sentence — not in the catalogue's
 * description, not in a run's `detail`. When a person does need to see *which* activity
 * was signed, it travels in the item's `code`, which is the one field the debug section
 * renders.
 */
export const OPFOY_SIGN_ALIAS = '20250521OPFOY_qd2'

/**
 * 鱼吧's own "already signed" answer on the PC endpoint.
 *
 * Named here rather than in `errors.ts` because nothing else classifies it: the global
 * table covers the codes that are compared *and* graded, and this one is only the
 * endpoint's own answer, decided where the endpoint is called.
 */
export const YUBA_ALREADY_SIGNED = 1001

/** The H5 sign pages run inside the android app's webview. */
const H5_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 12; XT2125-4 Build/S1RN32.55-16-13; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/153.0.8010.5 Mobile Safari/537.36'

/**
 * 鱼吧 and the activity API were both verified with a desktop-Chrome UA.
 *
 * Byte-identical to `bilibili/http.ts`'s `BROWSER_USER_AGENT` and to `passport.ts`'s
 * `PASSPORT_USER_AGENT`, and deliberately not shared: the first is another Platform's
 * (see that file), and `passport.ts` is standalone by design — it talks to one origin
 * with its own jar, and importing this module for a header would put the action layer
 * inside the login flow. Unifying the Douyu pair means resolving that, not just moving
 * a string.
 */
const PC_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * `h5nc/*` answers only when the referer is the sign page.
 *
 * The live probe's referer also carried that session's `stn` serial; whether the
 * service validates it was never isolated, so it is left empty here. A caller that
 * has its own value passes the full referer through `DouyuRequestOptions.referer`
 * rather than inheriting this one.
 */
export const DEFAULT_H5_REFERER = `${API_ORIGIN}/H5/Sign/info?av=v8.2.3.0&client_sys=android&stn=&ic=0`

export interface DouyuRequestOptions {
  /** Per-call deadline. */
  readonly timeoutMs?: number
  /** Overrides the family's default referer. See `DEFAULT_H5_REFERER`. */
  readonly referer?: string
}

export interface YubaListOptions extends DouyuRequestOptions {
  readonly page?: number
  readonly limit?: number
}

export interface ActivitySignOptions extends DouyuRequestOptions {
  /** Which activity to sign. Defaults to the OPFOY alias the probes verified. */
  readonly alias?: string
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

interface CallSpec {
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly timeoutMs: number
}

interface Response {
  /**
   * The raw body, left unparsed.
   *
   * One endpoint here answers HTML (the 粉丝家园 badge wall), so parsing belongs to the
   * caller that expects an envelope rather than to the transport: a `JSON.parse` here
   * would turn a page that arrived intact into "the contract is broken".
   */
  readonly body: string
  /** Raw `Set-Cookie` headers, for the calls that issue a cookie. */
  readonly setCookie: readonly string[]
}

/** The verdict fields every Douyu envelope carries, under whatever names its family uses. */
interface Verdict {
  readonly code: unknown
  readonly message: string
  readonly data: unknown
}

/**
 * Performs one request and returns its body.
 *
 * Throws for everything that is not an HTTP answer: a network fault, the deadline, and
 * a non-2xx — a 404 on these hosts answers with an HTML page, and so does the 403 this
 * family's CSRF layer refuses with. That way a `throw` from this module always means
 * "the transport or the contract is broken", and a `DouyuResult` always means "Douyu
 * replied". The body is judged by `requestJson` or by the one caller that wants HTML.
 *
 * Neither the URL nor the body appears in a message: the URLs carry the composite
 * token, and a gateway's error page can echo the URL it was asked for.
 */
async function request(spec: CallSpec): Promise<Response> {
  let status = 0
  let body = ''
  let setCookie: readonly string[] = []
  try {
    const response = await fetch(spec.url, {
      method: spec.method,
      headers: { ...spec.headers },
      ...(spec.body === undefined ? {} : { body: spec.body }),
      // **Not followed, and the status is judged rather than pursued.** Every URL this module calls
      // carries the composite token — in the query string on the `apiv2` family, in the body on the
      // writes — and a `fetch` that follows a redirect clones the caller's own headers (the `token`
      // header included) onto the request it makes to the host the *response* named, which would hand
      // a credential to whoever named it. `passport.ts` and `bilibili/http.ts` reach the same
      // conclusion for their own transports and say so in as many words; this one carried no
      // `redirect` at all, and the default is `follow`. With `manual` a 3xx comes back as itself, and
      // the status test below is what turns it into a reported failure.
      //
      // **What one of these endpoints does with a 3xx is reasoned rather than measured, and that is
      // the state of it.** The captures were searched for the fact and do not contain it: across
      // `douyu-capture-2026-10-08/flows.jsonl` (938 × 200, 238 × 304, 8 × 206, 4 × 204, 1 × 302),
      // `notes/douyu-opfoy-evidence/flows.jsonl` (150 × 200, 5 × 304), the 339 responses in
      // `wire-*.txt` (200s, one 304 on a static config) and the `tl-*.txt` dumps, every 3xx belongs to
      // one of two groups, and neither is this family: a **conditional-request 304 on a static
      // resource** (`shark.douyucdn.cn`'s sdk js, `wconf.douyucdn.cn`'s config json, `www.douyu.com`
      // page GETs), or a **302 on something this module never calls** — `challenges.cloudflare.com`,
      // the CDN's own media URL (`huos1a.douyucdn2.cn/…flv`, a player stream),
      // `passport.douyu.com/wgapi/…/safeAuth` (the renewal hop, whose own code expects a 302 and says
      // so) and `apiv2.douyucdn.cn/H5nc/welcome/to` (the App-shape hop). So a 3xx **on the
      // `japi`/`wgapi`/`apiv2` endpoints this file talks to has never been observed** — which is not
      // the same as their never sending one, and the guard above does not rest on which it is: what it
      // refuses is a *followed* hop carrying `token`, and that consequence is a property of `fetch`
      // rather than of a status code.
      redirect: 'manual',
      // Armed for the whole exchange, body included — which is what keeps the read
      // below inside the deadline, since `fetch` resolves on headers. An
      // `AbortSignal.timeout` needs no handle to clear and reports `TimeoutError`
      // where the hand-rolled controller could only say `AbortError`.
      signal: AbortSignal.timeout(spec.timeoutMs)
    })
    status = response.status
    setCookie = response.headers.getSetCookie()
    body = await response.text()
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new DouyuTransportError(spec.url, 0, `request failed: ${reason}`)
  }

  // A 3xx is not a smaller success: it is the service pointing somewhere this module will not go, so
  // it is reported with its own status instead of being read as an empty answer — which is what the
  // contract above has always claimed happens to a non-2xx.
  if (status < 200 || status > 299) {
    throw new DouyuTransportError(spec.url, status, `HTTP ${String(status)}`)
  }

  return { body, setCookie }
}

/**
 * The same call, with the body read as JSON.
 *
 * A wrapper rather than the transport's own job, so that the one endpoint that answers
 * HTML never meets a `JSON.parse` it cannot survive — and so that `request`'s contract
 * stays "anything that comes back is a page or an envelope, and only a non-2xx or a dead
 * socket throws".
 */
async function requestJson(spec: CallSpec): Promise<Response & { readonly json: unknown }> {
  const response = await request(spec)
  try {
    return { json: JSON.parse(response.body), body: response.body, setCookie: response.setCookie }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new DouyuProtocolError(spec.url, `response was not JSON: ${reason}`)
  }
}

/**
 * A JSON object, as opposed to `null`, an array or a primitive.
 *
 * A predicate rather than an assertion at the call site: the envelope is then
 * *narrowed* by the guard rather than promised by a cast, so loosening the guard
 * later cannot leave a cast behind that still claims the shape.
 */
function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Lifts the verdict out of an envelope.
 *
 * Hand-narrowed rather than schema-validated because there is nothing to validate:
 * the envelopes carry a code, a message and an opaque `data`, and the schemas that
 * earn their keep are the per-endpoint ones for `data`. The one real subtlety is
 * that a refusal sometimes puts its text in `data` instead of the message field —
 * `999999` arrives as `{"error":999999,"data":"系统错误"}` — so a string `data` is
 * used as the message when no message field is present.
 */
function verdictOf(parsed: unknown, url: string, codeField: string): Verdict {
  if (!isJsonObject(parsed)) {
    throw new DouyuProtocolError(url, 'response was not a JSON object')
  }

  const envelope = parsed
  const text = envelope['message'] ?? envelope['msg'] ?? envelope['data']
  return {
    code: envelope[codeField],
    message: typeof text === 'string' ? text : '',
    data: envelope['data']
  }
}

/**
 * Turns one verdict into the endpoint's data or a classified refusal.
 *
 * `data` is validated only when the code says success. A refusal routinely omits
 * it or sends `null` (`{"error":-1,"msg":"当天已经领过鱼丸"}`), so demanding the
 * success shape up front would replace the code that explains the refusal with a
 * shape error that explains nothing.
 *
 * **The service's own sentence goes through the parameter-name rule before it is handed back**, and this
 * is the one place that can do it: a refusal's `msg`/`data` is free text the Platform composes, it is what
 * every caller puts in an `ActionItem.detail`, and those details are written to `action_logs` and
 * rendered. `errors.ts` redacts inside its constructors for the *thrown* paths; a business refusal is
 * returned rather than thrown, so it has its own single gate — here, where the verdict becomes a
 * result. Nothing is claimed about whether Douyu echoes a request back in this field: two places in
 * this repo record that a refusal *may* (the `errors.ts` doc block, and `bilibili/medal.ts`'s note on
 * the like endpoint's error text), and the cost of the replacement is one regex on a string that
 * almost never matches.
 */
function settle<T>(url: string, verdict: Verdict, dataSchema: ZodType<T>, okCodes: readonly number[]): DouyuResult<T> {
  const code = readErrorCode(verdict.code)
  if (code === null) {
    throw new DouyuProtocolError(url, 'response carried no numeric business code')
  }
  if (!okCodes.includes(code)) {
    return {
      ok: false,
      code,
      message: redactCredentialParameters(verdict.message),
      classification: classifyError(code)
    }
  }

  const parsed = dataSchema.safeParse(verdict.data)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.join('.') ?? '<root>'
    const detail = issue?.message ?? 'unknown validation error'
    throw new DouyuProtocolError(url, `unexpected data shape at ${where}: ${detail}`)
  }
  return { ok: true, code, data: parsed.data }
}

/** One call against an `apiv2`/`www` endpoint, whose verdict field is `error`. */
async function callApi<T>(
  spec: CallSpec,
  dataSchema: ZodType<T>,
  okCodes: readonly number[] = [0]
): Promise<DouyuResult<T>> {
  const response = await requestJson(spec)
  return settle(spec.url, verdictOf(response.json, spec.url, 'error'), dataSchema, okCodes)
}

/** One call against 鱼吧, whose verdict field is `status_code` and whose OK is `200`. */
async function callYuba<T>(
  spec: CallSpec,
  dataSchema: ZodType<T>,
  okCodes: readonly number[] = [200]
): Promise<DouyuResult<T>> {
  const response = await requestJson(spec)
  return settle(spec.url, verdictOf(response.json, spec.url, 'status_code'), dataSchema, okCodes)
}

/**
 * The header set every `apiv2.douyucdn.cn` call needs.
 *
 * `cookie` carries `dy_cookie` and nothing else, and only when the caller supplied
 * one. Attaching the web session's `acf_*`/`PHPSESSID` cookies is what makes
 * `h5nc/*` answer `999999 系统错误` with a valid token — the single most expensive
 * mistake on this side of the protocol, and the reason this module takes a CSRF
 * value instead of a cookie jar.
 */
function apiV2Headers(token: string, dyCookie: string, referer: string): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    origin: API_ORIGIN,
    referer,
    'user-agent': H5_USER_AGENT,
    'x-requested-with': 'XMLHttpRequest',
    token,
    ...(dyCookie === '' ? {} : { cookie: `dy_cookie=${dyCookie}` })
  }
}

function h5Spec(
  url: string,
  method: 'GET' | 'POST',
  token: string,
  dyCookie: string,
  options: DouyuRequestOptions,
  body?: string
): CallSpec {
  return {
    url,
    method,
    headers: apiV2Headers(token, dyCookie, options.referer ?? DEFAULT_H5_REFERER),
    ...(body === undefined ? {} : { body }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }
}

/** `application/x-www-form-urlencoded`, which is what every write endpoint here takes. */
function formBody(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString()
}

/** Reads one cookie value out of a response's `Set-Cookie` headers. */
function readCookie(setCookie: readonly string[], name: string): string | null {
  for (const header of setCookie) {
    const pair = header.split(';')[0]
    if (pair === undefined) continue
    const separator = pair.indexOf('=')
    if (separator <= 0) continue
    if (pair.slice(0, separator).trim() !== name) continue
    const value = pair.slice(separator + 1).trim()
    if (value !== '' && value !== 'deleted') return value
  }
  return null
}

/**
 * Douyu types the same counter as a JSON number on one endpoint and a numeric
 * string on the next. The two shapes this file has a sample of are both **reads**:
 * `getFishBallNum` answers `{"num":20}`, and `getSign` answers `"sign_cnt":"1"`.
 *
 * **The write twins have no captured body at all**, so what they echo is unmeasured
 * rather than different: the only saved `sendFishBall` answer is its refusal
 * (`-1 当天已经领过鱼丸`, `data: null`) and the only saved `sendSign` answer is `6305`.
 * Both go through this schema anyway, which is the point — one reading of "a number"
 * for a family that has been seen to write it two ways.
 *
 * The union is the gate; `z.coerce.number()` does the retyping. A bare `Number()`
 * transform accepted whatever it was handed — `'abc'` parsed *successfully* as `NaN`,
 * so a mistyped field reached callers as a number nothing downstream questioned —
 * while a bare `z.coerce.number()` would go the other way and accept `null`, `true`
 * and `[]` as `0`, and `fastSign` would then read a body that never carried a score as
 * a score of `0`. Coercion rejects `NaN`; the union keeps the accepted input exactly as
 * narrow as it was.
 */
const counter = z.union([z.number(), z.string()]).pipe(z.coerce.number())

/* ------------------------------------------------------------------ *
 * h5nc — client (TV/H5) sign-in
 * ------------------------------------------------------------------ */

/**
 * `GET /h5nc/csrf/getCsrfCookie` — issues the `dy_cookie` the sign calls echo back
 * as `dy_token`.
 *
 * The value is returned rather than kept in a jar: it is a CSRF token with no life
 * outside this family, and the caller decides how long to hold it. A 200 without
 * the cookie is a contract change, not a business outcome, so it throws.
 */
export async function fetchCsrfCookie(token: string, options: DouyuRequestOptions = {}): Promise<DouyuResult<string>> {
  const url = `${CSRF_COOKIE_URL}?token=${encodeURIComponent(token)}`
  const spec = h5Spec(url, 'GET', token, '', options)
  const response = await requestJson(spec)
  const result = settle(spec.url, verdictOf(response.json, spec.url, 'error'), z.unknown(), [0])
  if (!result.ok) return result

  const cookie = readCookie(response.setCookie, 'dy_cookie')
  if (cookie === null) {
    throw new DouyuProtocolError(spec.url, 'CSRF bootstrap answered success without setting dy_cookie')
  }
  return { ok: true, code: result.code, data: cookie }
}

/**
 * The sign-in payload of `getSign` and `sendSign`.
 *
 * Optional fields are the ones whose presence depends on which call this is: the
 * read response is documented to carry the three `sign_silver*` fields and not the
 * two `c`-prefixed ones, and the write response the other way round (§2.2). None of
 * their meanings is verified — only `sign_rd` (连续签到天数), `sign_cexp` (本次经验)
 * and `sign_exps` (累计经验) are — so requiring them would turn an upstream rename
 * into a hard failure for a number this module cannot interpret anyway.
 */
export const clientSignDataSchema = z.object({
  sign_today: z.string(),
  sign_cnt: counter,
  sign_sum: counter,
  sign_rd: counter,
  sign_md: counter,
  sign_exp: counter,
  sign_exps: counter,
  sign_silver: counter.optional(),
  sign_siln: counter.optional(),
  sign_silb: counter.optional(),
  sign_cexp: counter.optional(),
  sign_pl: z.array(z.unknown()).optional()
})
export type ClientSignStatus = z.infer<typeof clientSignDataSchema>

/** `POST /h5nc/sign/getSign` — the read half: the streak the app displays. */
export async function readSignStatus(
  token: string,
  dyCookie: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<ClientSignStatus>> {
  return await callApi(
    h5Spec(SIGN_STATUS_URL, 'POST', token, dyCookie, options, formBody({ token, dy_token: dyCookie })),
    clientSignDataSchema
  )
}

export interface ClientSignOutcome {
  /** True when the service answered "today is already signed" — the day's goal is met. */
  readonly alreadySignedToday: boolean
  /** The sign-in state the write response reported, or `null` when it reported none. */
  readonly status: ClientSignStatus | null
}

/**
 * `POST /h5nc/sign/sendSign` — performs the daily sign-in.
 *
 * `6305` means it had already happened. That is the day's goal reached, so it is
 * unwrapped into `alreadySignedToday` rather than handed to the caller as a
 * failure it would be tempted to retry.
 */
export async function sendClientSign(
  token: string,
  dyCookie: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<ClientSignOutcome>> {
  const body = formBody({ token, dy_token: dyCookie })
  const result = await callApi(h5Spec(SIGN_SEND_URL, 'POST', token, dyCookie, options, body), clientSignDataSchema)

  if (result.ok) return { ok: true, code: result.code, data: { alreadySignedToday: false, status: result.data } }
  if (result.code === CLIENT_SIGN_ALREADY_SIGNED) {
    return { ok: true, code: result.code, data: { alreadySignedToday: true, status: null } }
  }
  return result
}

/**
 * `POST /h5nc/Sign/getRemedySign` — the make-up-sign window.
 *
 * `sign_schedule_list`'s entries keep `ds`/`sf` unmodelled: they appear in §2.2 as
 * the only record of this endpoint, with no meaning attached to either name, and
 * guessing one here is exactly how a field's meaning gets invented.
 */
export const clientRemedyDataSchema = z.object({
  sign_remedy_cnt: counter,
  sign_running_days: counter,
  sign_omit_days: counter,
  sign_schedule_list: z.array(z.object({ ds: z.unknown(), sf: z.unknown() })).optional()
})
export type ClientRemedySign = z.infer<typeof clientRemedyDataSchema>

export async function readRemedySign(
  token: string,
  dyCookie: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<ClientRemedySign>> {
  const body = formBody({ token, dy_token: dyCookie })
  return await callApi(h5Spec(SIGN_REMEDY_URL, 'POST', token, dyCookie, options, body), clientRemedyDataSchema)
}

/* ------------------------------------------------------------------ *
 * Ad fish balls
 * ------------------------------------------------------------------ */

/** `num` is what the claim is worth right now (20 in every capture); `time` is unlabelled. */
export const fishBallBalanceSchema = z.object({ num: counter, time: counter })
export type FishBallBalance = z.infer<typeof fishBallBalanceSchema>

/**
 * `GET /japi/inspire/api/ad/inspire/getFishBallNum` — the only way to see the
 * ad-sign balance without the app, and the check to make before claiming.
 */
export async function readFishBallBalance(
  token: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<FishBallBalance>> {
  const url = `${FISH_BALL_BALANCE_URL}?posId=${AD_FISH_BALL_POS_CODE}&ct=1&token=${encodeURIComponent(token)}`
  return await callApi(h5Spec(url, 'GET', token, '', options), fishBallBalanceSchema)
}

/**
 * `sendFishBall`'s "already claimed today" code. It is deliberately *not* in
 * `ACTION_STOP_CODES`: the classification table covers the sign-in families, and
 * `-1` is also what unrelated endpoints answer for "already done". A caller that
 * needs idempotency keys off its own record of today's successful claim.
 */
export const FISH_BALL_ALREADY_CLAIMED = -1

/**
 * `GET /japi/inspire/api/ad/inspire/sendFishBall` — claims the slot's fish balls.
 *
 * `data` is `null` in both the captured success and the captured refusal, so the
 * verdict really is the code and nothing else: success is `error: 0` and the
 * repeat is `error: -1, msg: 当天已经领过鱼丸`. The credit itself is observable
 * only through the balance, so this returns the verdict and no invented reward.
 */
export async function claimFishBall(
  token: string,
  uid: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<null>> {
  const params = new URLSearchParams({ uid, posCode: AD_FISH_BALL_POS_CODE, ct: '1', token })
  const url = `${FISH_BALL_CLAIM_URL}?${params.toString()}`
  return await callApi(h5Spec(url, 'GET', token, '', options), z.null())
}

/* ------------------------------------------------------------------ *
 * 鱼吧
 * ------------------------------------------------------------------ */

/**
 * One followed 鱼吧.
 *
 * `group_id` is a number on the wire and a string here, because it is an opaque
 * identifier that goes straight into a form body and nothing else. Its coercion sits
 * behind the same union `counter` uses and for the same reason: a bare
 * `z.coerce.string()` answers `'null'` for a `null` id, and a group that cannot exist
 * would then be signed as though it did. `is_signed` is the service's claim and is
 * **not** a gate: §2.4 measured groups reported as `is_signed: 0` that answered
 * "今天已经签到过了" when signed. Sign first; "already signed" is then read from the sign's
 * own answer (see `signGroupAndroid` and `signGroupPc`), never from this flag.
 */
export const yubaGroupSchema = z.object({
  group_id: z.union([z.number(), z.string()]).pipe(z.coerce.string()),
  group_name: z.string().default(''),
  is_signed: counter.transform(value => value !== 0).optional()
})
export type YubaGroup = z.infer<typeof yubaGroupSchema>

/**
 * The envelope of `myFollow`: the groups live under `data.list`, and `count_page`
 * is the only pagination field the payload carries.
 */
const yubaFollowDataSchema = z.object({
  list: z.array(yubaGroupSchema),
  count_page: counter.optional()
})

/**
 * `GET /wbapi/web/group/myFollow` — the 鱼吧 groups this account follows.
 *
 * The PC site authenticates with `dy-token`; the android gateway with a bare
 * `token`. Each rejects the other's name, so the two call sites below do not share
 * a header builder.
 */
function yubaWebHeaders(token: string, referer: string): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    origin: YUBA_ORIGIN,
    referer,
    'user-agent': PC_USER_AGENT,
    'dy-client': 'pc',
    'dy-token': token
  }
}

export async function listFollowedGroups(
  token: string,
  options: YubaListOptions = {}
): Promise<DouyuResult<readonly YubaGroup[]>> {
  const page = options.page ?? 1
  const limit = options.limit ?? 30
  const url = `${YUBA_FOLLOWED_GROUPS_URL}?page=${String(page)}&limit=${String(limit)}`
  const spec: CallSpec = {
    url,
    method: 'GET',
    headers: yubaWebHeaders(token, options.referer ?? YUBA_ORIGIN),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  const result = await callYuba(spec, yubaFollowDataSchema)
  if (!result.ok) return result
  return { ok: true, code: result.code, data: result.data.list }
}

export interface YubaSignOutcome {
  /** 本次获得的鱼吧等级分 — not 鱼丸. The two twins answer it inside different envelopes. */
  readonly levelScore: number
  /**
   * Whether the PC twin answered its already-signed verdict, `status_code: 1001`, and nothing else.
   *
   * `true` only for that verdict. A `200` is always `false`: the PC twin's success envelope is read
   * as a sign that was performed, with `addLevelScore` (or `0` when it is absent). No PC body has been
   * captured for this file, so whether a `200` can ever mean "already" is unmeasured, and this file
   * does not claim it can not.
   */
  readonly alreadySigned: boolean
}

/**
 * `POST mapi-yuba/wb/v3/fastSign` — the level score the envelope carries, and nothing more.
 *
 * `data` is `levelScore`, and **`0` is not a verdict.** Measured 2026-10-10 on the owner's
 * account: `fastSign` answered `{"data":0,"message":"","status_code":200}` for group 7366311
 * (twice, the second call a repeat) and for group 6672975 (once). Nothing measured here tells
 * that `0` apart from "already signed" versus "nothing was signed". Only the new-sign side has
 * an answer on record: the 2026-10-09 run in `action_logs` (id 34, a bot row, not a capture here)
 * recorded group 历史 at `data` 24 with `status_code` 200, and that positive score is the one
 * reading this file treats as a sign that happened.
 *
 * So the walk does not settle a day on a `0` from here. It asks the PC twin before it says
 * "already" (see `signGroupPc`). This stays the first call for two reasons: it needs no `Referer`,
 * and the walk has always made it first, so a positive score from it is a known sign.
 */
export async function signGroupAndroid(
  token: string,
  groupId: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<number>> {
  const spec: CallSpec = {
    url: YUBA_FAST_SIGN_URL,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      origin: YUBA_ORIGIN,
      'user-agent': PC_USER_AGENT,
      client: 'android',
      token
    },
    body: formBody({ group_id: groupId }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  return await callYuba(spec, counter)
}

/** The PC twin answers the level score inside an object, so the success shape is not the same as fastSign's. */
const yubaTopicSignDataSchema = z.object({ addLevelScore: counter.optional() })

/**
 * `POST ybapi/topic/sign` — the PC twin of the fast sign, and the call that settles a
 * `fastSign` `0`.
 *
 * Needs `Referer: https://yuba.douyu.com/group/<id>` and reports "already signed" as
 * `status_code: 1001` with no `data` at all, which is why it is implemented against its own
 * schema. Evidence for `1001` as the already verdict: the constant's existing use in this file,
 * and the one third-party client seen for this endpoint (`bighammer-link/Common-scripts`,
 * `yuba_check.py`), which reads `200` as signed and `1001` as 「今天已经签到了」. Neither is a
 * capture from this account, and no PC body has been captured here.
 *
 * Its `200` is read as a sign performed (see `YubaSignOutcome`). There is no read-back here:
 * no endpoint that reports today's sign state was found, and the group page's `isSigned`
 * was `0` on all four of the owner's boards on 2026-10-10 even though he reports signing one
 * of them by hand, so it is not used as one either.
 */
export async function signGroupPc(
  token: string,
  groupId: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<YubaSignOutcome>> {
  const spec: CallSpec = {
    url: YUBA_TOPIC_SIGN_URL,
    method: 'POST',
    headers: yubaWebHeaders(token, options.referer ?? `${YUBA_ORIGIN}/group/${groupId}`),
    body: formBody({ group_id: groupId }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  const result = await callYuba(spec, yubaTopicSignDataSchema)
  if (result.ok) {
    const levelScore = result.data.addLevelScore ?? 0
    return { ok: true, code: result.code, data: { levelScore, alreadySigned: false } }
  }
  if (result.code === YUBA_ALREADY_SIGNED) {
    return { ok: true, code: result.code, data: { levelScore: 0, alreadySigned: true } }
  }
  return result
}

/* ------------------------------------------------------------------ *
 * Activity sign-in
 * ------------------------------------------------------------------ */

/**
 * What the carnival API answers when the token is missing or is not a session.
 *
 * `300 请登录`, not the `1002 用户未登录` the rest of Douyu uses, and the difference is
 * why the number is named here rather than left to `classifyError`: that table has never
 * seen `300` and would grade it `retry`, while a caller that read it as "not signed
 * today" would call `doSign` against a session that cannot sign at all, every run, for
 * ever. Attached to this endpoint family rather than added to the global table for the
 * reason `FISH_BALL_ALREADY_CLAIMED` gives: a small integer is evidence only where it
 * was actually seen.
 */
export const ACTIVITY_NOT_LOGGED_IN = 300

/**
 * `getStatus`'s payload, narrowed to the one field the gate reads.
 *
 * `todaySigned` is **required**, and that is the whole safety property: `0` and `1` are
 * the measured values, so a payload without the field is a contract change, and a schema
 * that defaulted it would answer "not signed today" to a shape nobody verified. The gate
 * is fail-closed, so the one reading it must never invent is "nothing to do".
 *
 * `status[].signed` — the other date-shaped field in this payload — is deliberately
 * **not** modelled. It has been observed as `0/1/2/3`, with future dates already
 * carrying `2`, so it is not a boolean about today and nothing here may read it as one.
 * The 2026-10-09 capture makes that mapping a measurement rather than an inference, and
 * still not a gate: it shows `1` on an already-signed day (10月08日) and `0` on today
 * before the write, `2` on both future days, `3` on the three missed days, and — between
 * one `remedy` call and the next read — `3 → 1` on the day that was made up. So `3` is
 * "missed and still fillable", and it is `remedy[0].num` that says whether it can be.
 */
export const activityStatusSchema = z.object({ todaySigned: counter })
export type ActivitySignStatus = z.infer<typeof activityStatusSchema>

/**
 * `GET /japi/carnivalApi/nc/sign/getStatus` — the pre-flight read, and the gate.
 *
 * Measured: the request carries the composite token and **nothing else that identifies
 * anyone** — no cookie, no origin, no referer, no csrf — and answers `data.todaySigned`
 * (`0` not signed today, `1` signed), while a token that is missing or not a session
 * answers `300`. The header set below stays that narrow on purpose: this is the same
 * family whose `h5nc/*` calls answer `999999 系统错误` the moment an extra credential is
 * attached (§2.2), and a read that acquires a habit of sending more is a read that
 * starts failing for a reason nobody will connect to it.
 */
export async function readActivitySignStatus(
  token: string,
  options: ActivitySignOptions = {}
): Promise<DouyuResult<ActivitySignStatus>> {
  const query = new URLSearchParams({ signAlias: options.alias ?? OPFOY_SIGN_ALIAS })
  const spec: CallSpec = {
    url: `${ACTIVITY_SIGN_STATUS_URL}?${query.toString()}`,
    method: 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': PC_USER_AGENT,
      token
    },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  return await callApi(spec, activityStatusSchema)
}

export interface ActivitySignOutcome {
  /**
   * True when the activity answered `31015`: the signature was already in place.
   *
   * A number this repo has never seen on the wire — see `errors.ts` for its provenance and for why
   * the branch is kept anyway. `31200`'s branch, by contrast, is now backed by the captured body.
   */
  readonly alreadySigned: boolean
}

/**
 * `POST /japi/carnivalApi/sign/doSign` — the OPFOY activity signature.
 *
 * **`31200` is this endpoint's success answer, and it is a capture at last**: the call of
 * 2026-10-09 answered `{"error":31200,"msg":"签到成功!","data":{},"redirectUrl":""}`, kept verbatim
 * in `tests/captured/douyu-activity-sign-31200.json`. The code therefore means today's signature
 * landed — the activity page's enum entry calls the same number 「签到成功无礼包」 and the ledger
 * entry written in that same second is 「签到礼包 +20」, which is why `errors.ts` names it
 * `ACTIVITY_SIGN_SUCCESS` and why `data` is still read as opaque: this response carries no award,
 * and the payout it cannot see lives in `redeemPoints/pointRecord`.
 *
 * `31015` is the other OK code — the answer to a *second* sign-in — and it is still the page's
 * enum entry with nothing under it: this capture was scanned for it and found none, because the
 * account signed once. It is accepted anyway (a cheap "no" beats a retry against a write), but
 * nothing here may read that acceptance as though the number had been measured.
 *
 * **The CSRF shape below is deliberately not the page's, and the capture is what turns that from a
 * guess into a decision.** Immediately before signing, the page mints a token — an empty-body
 * `POST /japi/carnival/nc/common/generateCsrf` answers `{"error":0,"msg":"操作成功","data":{}}`
 * and `Set-Cookie: cvl_csrf_token=…; Max-Age=300` — and then sends that value **twice**, as its
 * `Cookie:` header and as this form's `csrfToken` field, 63 ms later. This build sends
 * `csrfToken` **empty** and no cookie at all, which is the shape that the 2026-10-08
 * `签到礼包 +20` ledger entry belongs to (§2.5).
 *
 * The probe's earlier `9001 请求校验不通过` is explained by the pairing rather than by emptiness:
 * that request carried a non-empty token *without* the cookie it was minted into, which is the
 * same half-a-handshake `interactnc/web` answers `403 csrf auth failed` to. Nothing measured
 * covers the converse — whether an empty value passes *because* it is empty — so this may not be
 * read as "the family does not check CSRF". The one measured fact is that the shape below signs.
 *
 * `useJiYan` differs too — `true` in the capture, `false` here — and nothing in this repo measures
 * whether the service reads it; the page asks for 极验 because it has a slide to solve, and this
 * build has none.
 *
 * The caller reads `readActivitySignStatus` first and skips this call when today is already signed.
 * That ordering cannot live here: the skip is a decision about the day, and this function knows only
 * what one POST answered.
 */
export async function signActivity(
  token: string,
  options: ActivitySignOptions = {}
): Promise<DouyuResult<ActivitySignOutcome>> {
  const spec: CallSpec = {
    url: ACTIVITY_SIGN_URL,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      origin: WEB_ORIGIN,
      referer: options.referer ?? `${WEB_ORIGIN}/`,
      'user-agent': PC_USER_AGENT,
      'x-requested-with': 'XMLHttpRequest',
      token
    },
    body: formBody({ csrfToken: '', signAlias: options.alias ?? OPFOY_SIGN_ALIAS, useJiYan: 'false' }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  // No field of `data` is named: the captured body's `data` is `{}`, and naming a field would be a
  // claim about a payout that this response has never carried.
  const result = await callApi(spec, z.unknown(), [ACTIVITY_SIGN_SUCCESS, ACTIVITY_ALREADY_SIGNED])
  if (!result.ok) return result
  return { ok: true, code: result.code, data: { alreadySigned: result.code === ACTIVITY_ALREADY_SIGNED } }
}

/**
 * **`POST /japi/carnivalApi/sign/remedy` — the activity's make-up sign — is not implemented, and
 * this block is the finding that says what implementing it would cost to get wrong.** It shares the
 * host, the `application/x-www-form-urlencoded` body and the `csrfToken` + `signAlias` + `useJiYan`
 * fields with `signActivity`, and differs by exactly one field: **`offset`**, the day's index
 * counted from the same payload's `todayOffset` (`offset` 2 against `todayOffset: 4` is 10月07日,
 * which `status[2].dateDes` names; `doSign` sends no `offset` at all, which is why the two are not
 * interchangeable).
 *
 * Why it is recorded instead of written: **its outcome cannot be a boolean on its code.** The
 * captured call answered `{"error":31202,"msg":"当前签到内容没有配置礼包奖励~","data":{}}` — a
 * refusal, and by the bundle's own table `31202 = 无礼包奖励` — while the same second moved three
 * independent state bits in the account's favour: `signDays` 2 → 3, `status[2].signed` 3 → 1,
 * `remedy[0].num` 9 → 8 (one make-up chance spent), and the ledger took a `+20` entry at 03:20:44.
 * The two `takeBag` calls that bracket it both answered `31000`, so that `+20` cannot be theirs.
 * A caller reading `31202` as failure would report a refusal for a day it had just repaired, and
 * would leave a *spent* chance to be spent again on the next run.
 *
 * What an implementation needs first, none of which this capture supplies: this endpoint's own
 * success code (never observed — there is exactly one `remedy` sample in the file), a decision about
 * what `31202` means when a day *is* filled, and a `remedy[0].num` read on both sides of the write
 * to see the chance move. `31202` must not be added to `errors.ts`'s global table on the way in:
 * like `FISH_BALL_ALREADY_CLAIMED`, it means this only where the endpoint answering it is known.
 *
 * The neighbouring claim paths are in the same state and for the same reason: this capture holds
 * **no** `takeGift`, `deliver`, `receive` or `claim` call at all (0 hits across 135 unique
 * method+path), and its four `gametask/viewStatus` reads answered `status: 1` for all five watch
 * tasks — never the `status: 2` a claim would be triggered by. So the reference implementation's
 * claim path stays a reference, and nothing here may be built on it.
 */

/* ------------------------------------------------------------------ *
 * 打卡分鱼丸 — the two-day pool activity
 * ------------------------------------------------------------------ */

/**
 * This family's verdicts, each named where it was actually seen.
 *
 * All five are numbers Douyu reuses elsewhere for other things, so none of them belongs
 * in `errors.ts`'s global table: the classification is attached by the caller that knows
 * which endpoint produced the number, exactly as `FISH_BALL_ALREADY_CLAIMED` is.
 *
 * **`10001` is a measured response to a body with no `token`** — a session this family
 * will not accept, whatever the reason the token did not arrive. **`152101` is the CSRF
 * double-submit layer** (`dy_token` in the body versus `dy_cookie` in the header, missing
 * or unequal), and it is transient: a live run saw 25 consecutive `152101` between two
 * windows of `0`, on requests of a shape that had just succeeded. **`57002` is the only
 * one of the four that is not a capture** — it comes from the activity page's own
 * bundle, which shows 「你的鱼丸不足200 无法参与打卡挑战」 for it, and it is named here
 * because a balance this adapter cannot read is exactly the refusal a caller has to
 * describe rather than retry.
 *
 * **`57005` is the check-in window not being open, and its evidence is a contrast rather than a
 * body.** The same `clockSignActivity` call answered `57005` at 18:45 and `0` at 19:00:20 on
 * 2026-10-09, one account and one night (the record is on `growthPoolStatusSchema`), so the number
 * is the endpoint's "the window is shut right now" and not a verdict about the account or the round.
 * It is the one of the four whose meaning needs *this* side's clock: `growthPoolCheckIn` calls it
 * only after `withinLocalWindow` has already said the window is open, so a `57005` arriving there
 * says the two clocks disagree rather than that the day is over — which is why the adapter grades it
 * `retry` and never `action_stop` (see `growthPoolRefusal` in the adapter).
 *
 * **`57004` is 今天已经打过卡, and it is the same shape of evidence: a contrast, plus the state that
 * explains it.** On that same evening `clockSignActivity` answered `0` at 19:00:20 and `57004` to the
 * two runs at 19:45 and 19:50 — both of which were inside 19:00–21:00 by this project's clock, and
 * both of which first read a latch of `1`
 * (`{"signStatus":1,"ywTotal":596400,"joinTotal":2982}`, i.e. 已报名 for a round). So the call was
 * reached on a day whose check-in had already landed, and what the number describes is the check-in
 * being in place — not the window, not the round, not the session. `msg` was empty at both of those
 * reads, and there is no capture here carrying a `57004` body at all.
 *
 * **What that does not establish, and the name does not claim:** one account, one evening. Nothing
 * measured says whether the number is about *the day* being spent or only about *this attempt* at
 * it, and nothing says what it answers outside 19:00–21:00 — a window no run can ask from, because
 * `growthPoolCheckIn`'s own gate sits above the call. The reading that is safe under both of the
 * open possibilities is the adapter's: today's card is in place, so the run writes nothing and the
 * day is settled (see `growthPoolCheckIn`).
 */
export const GROWTH_POOL_TOKEN_REJECTED = 10001
export const GROWTH_POOL_CSRF_REJECTED = 152101
export const GROWTH_POOL_NOT_ENOUGH_FISH_BALLS = 57002
export const GROWTH_POOL_ALREADY_CLOCKED = 57004
export const GROWTH_POOL_WINDOW_NOT_OPEN = 57005

/**
 * The body every call in this family takes: the token, and the CSRF value the header
 * carries under a different name.
 *
 * One builder rather than three copies, because the equality *is* the protocol: the
 * service compares the body's `dy_token` against the header's `dy_cookie`, so a call
 * site that spelled one of them differently would not be sending a slightly wrong
 * value — it would be sending a request this family refuses with `152101`.
 */
function growthPoolBody(token: string, dyCookie: string): string {
  return formBody({ token, dy_token: dyCookie })
}

/**
 * What `getSignInfo` answers, narrowed to the latch and the pool.
 *
 * `signStatus` is **required**, for the reason the activity gate's `todaySigned` is: it
 * is what says whether this account is already in this round, and a schema that read a
 * missing latch as "not joined" would spend 200 鱼丸 on a shape nobody verified. The
 * values this build knows come from the activity page's own button logic — `0` is
 * 未报名 (the button offers 报名) and `1` is 已报名 — and the caller reports anything
 * else as a state it does not know rather than guessing at it.
 *
 * **The latch does return to `0` after the check-in, and that is a measurement rather than the
 * page's own constant.** This block used to say the opposite — that the value coming back was
 * *not* captured, because the page hard-codes `0` on its own clock branch — and that sentence was
 * load-bearing: the whole two-run design (`0` ⇒ 报名, `1` ⇒ 打卡) rests on the latch clearing, and
 * a value that never returned would have left this adapter clocking a round it could no longer
 * enter. The service's own read is what answered it:
 *
 *     2026-10-09 +08:00 — one account (已报名, `signStatus: 1`), one night, no room (this family
 *     is per account), and the three endpoints called directly rather than through a run:
 *
 *       18:45    clockSignActivity → 57005                      窗口未开 (`GROWTH_POOL_WINDOW_NOT_OPEN`)
 *       19:00:20 clockSignActivity → 0, {"ywTotal":78400,"joinTotal":392}
 *       19:00:20 getSignInfo       → 0, {"signStatus":0,"ywTotal":78400,"joinTotal":392}
 *       19:00:20 joinSignActivity  → 0, {"ywTotal":78800,"joinTotal":394}
 *
 *     and the read taken minutes before, while the previous round was still live:
 *       getSignInfo → {"signStatus":1,"ywTotal":884800,"joinTotal":4424}
 *
 * `ywTotal` / `joinTotal` are the **pool's** figures and not this account's balance, and those four
 * reads are what say so. The pool is the entries of everyone who joined, at 200 鱼丸 each — the
 * activity's published rules read 「支付 200 鱼丸可报名参加活动，获得次日打卡机会」 and 「奖池由
 * 前一天参加活动用户的报名鱼丸组成」 — and `joinTotal × 200 === ywTotal` holds at all three
 * observation points (4424/884800, 392:78400, 394:78800). The numbers also swap wholesale across
 * the check-in because the read afterwards describes the **next** round (392 people have already
 * paid into it) rather than a loss this account took, and the same pair moved by one entry between
 * the read and the join reply. One account, one night, three points: the relation is an observation
 * to record, **not a rule to assert anywhere** — and this repository already holds a reading that
 * does not fit it (`HANDOFF.md` §3.1: 901600 ÷ 3693 ≈ 244, a different round), so the ratio is
 * Douyu's to change and a test built on it would go red on a fact this repository does not own.
 *
 * They stay optional because they only ever become a sentence about the pool; nothing is decided
 * from them. The one sentence that renders them is `poolClauseOf` in the adapter, which names them
 * 本场奖池 / 人已报名 — checked when this record was written, and the status read's own two copies
 * are read by nothing at all. That check is worth repeating rather than assuming: a pool figure read
 * as a balance is the one misreading this pair invites, and `884800 → 78400` across a check-in
 * would look exactly like a very bad night if anything rendered it that way.
 *
 * `clockLeftTime` is deliberately **not** modelled. It counts down to the window
 * *opening* and says nothing about it closing — a live read gave `107999` s for the next
 * day's 19:00 — so it cannot be the gate, and the window has to come from this project's
 * own platform-day clock (`platform/time.ts`). A field nothing reads is a field the next
 * reader will decide to gate on.
 */
export const growthPoolStatusSchema = z.object({
  signStatus: counter,
  ywTotal: counter.optional(),
  joinTotal: counter.optional()
})
export type GrowthPoolStatus = z.infer<typeof growthPoolStatusSchema>

/**
 * `POST /h5nc/userSignActivity/getSignInfo` — the latch, and it must be this endpoint.
 *
 * The twin at `/h5/SignActivity/getSignInfo` is the **anonymous** read and answers
 * `error: 0` with `signStatus: 0` to anybody at all: used as a latch it would report "not
 * joined" for an account that had already paid its 200 鱼丸, and pay again on every run.
 * Nothing in this module calls it, and the latch never comes from anywhere but here.
 */
export async function readGrowthPoolStatus(
  token: string,
  dyCookie: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<GrowthPoolStatus>> {
  const spec = h5Spec(GROWTH_POOL_STATUS_URL, 'POST', token, dyCookie, options, growthPoolBody(token, dyCookie))
  return await callApi(spec, growthPoolStatusSchema)
}

/**
 * What `joinSignActivity` answers — and what it does **not** answer.
 *
 * The measured success is
 * `{"error":0,"data":{"ywTotal":38400,"joinTotal":192,"clockLeftTime":107999},"msg":""}`,
 * and it carries no `signStatus`: the activity page sets that to `1` itself after a
 * successful join, as a client-side constant. A caller that read the latch out of this
 * reply would read `undefined`, which is why the only thing that reads a latch anywhere
 * is `readGrowthPoolStatus`. A second sample — 2026-10-09 19:00:20, the same evening the
 * check-in was measured, `{"error":0,"data":{"ywTotal":78800,"joinTotal":394},"msg":""}` —
 * answers the same two counters and no latch again. Both counters are optional so that an
 * upstream rename costs one sentence rather than the action.
 */
export const growthPoolJoinSchema = z.object({
  ywTotal: counter.optional(),
  joinTotal: counter.optional()
})
export type GrowthPoolJoin = z.infer<typeof growthPoolJoinSchema>

/**
 * `POST /h5nc/userSignActivity/joinSignActivity` — the half that **spends 200 鱼丸**.
 *
 * `0` is the success code here, measured on 2026-10-08 together with the counters above.
 * Whether to call it at all is the caller's decision, taken from the latch: this function
 * cannot know whether the account can afford it, and a spend must never rest on a guess
 * made here.
 *
 * What those 200 鱼丸 buy is the activity's own published rule rather than anything this
 * module reads: 「支付 200 鱼丸可报名参加活动，获得次日打卡机会」, and 「未在打卡时间内打卡，
 * 报名鱼丸不退回」 — so the entry fee is certain and the return is not: 「随机（有概率低于
 * 200 鱼丸）瓜分奖池内全部鱼丸」. The person-facing sentence for that asymmetry lives on the
 * action's `description` in the adapter, where whoever decides about the switch reads it;
 * nothing here reports a payout, because this reply carries the pool and no award.
 */
export async function joinGrowthPool(
  token: string,
  dyCookie: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<GrowthPoolJoin>> {
  const spec = h5Spec(GROWTH_POOL_JOIN_URL, 'POST', token, dyCookie, options, growthPoolBody(token, dyCookie))
  return await callApi(spec, growthPoolJoinSchema)
}

/**
 * `POST /h5nc/userSignActivity/clockSignActivity` — the check-in.
 *
 * **It has now been reached with a correctly-formed request, and the reply was `0`.**
 * The only attempt on record before that answered `152101 请求异常` — the CSRF double submit,
 * a missing or unequal `dy_token`/`dy_cookie` pair — and the live run that verified the join
 * half left this one alone on purpose, because the check-in it opens belongs to the next day's
 * 19:00. On 2026-10-09 19:00:20 the call went out with that pair minted in the same run and
 * answered `{"error":0,"data":{"ywTotal":78400,"joinTotal":392}}` — one account, one night, the
 * record is on `growthPoolStatusSchema`. So `0` is measured *here* now rather than inferred from
 * the join half and the page's own handler, and what the reply did was put the new round's pool
 * on the wire: the same two counters `growthPoolStatusSchema` reads, for the round that has just
 * opened.
 *
 * `data` still stays opaque and no field of it is named, and the measurement is what makes that
 * deliberate rather than timid. Nothing reads the pair from here — the caller acts on the verdict
 * alone — and the award is not in this reply at all: the activity's rule is 「每日瓜分鱼丸数额于
 * 当日 21:00 后开始结算，22:00 前自动发放至个人账户」， so the instant of the check-in is *before*
 * the settlement that decides what it paid. A field named here would be the next reader's excuse
 * to report a figure this response cannot carry.
 *
 * `57005` is this endpoint's window-closed answer and `57004` its "today's card is already in
 * place"; see `GROWTH_POOL_WINDOW_NOT_OPEN` and `GROWTH_POOL_ALREADY_CLOCKED`.
 */
export async function clockGrowthPool(
  token: string,
  dyCookie: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<unknown>> {
  const spec = h5Spec(GROWTH_POOL_CLOCK_URL, 'POST', token, dyCookie, options, growthPoolBody(token, dyCookie))
  return await callApi(spec, z.unknown())
}

/* ------------------------------------------------------------------ *
 * 粉丝家园 — the per-room sign
 * ------------------------------------------------------------------ */

/**
 * The cookie `ctn` must equal. **Not** the cookie `fetchCsrfCookie` bootstraps.
 *
 * That call issues `dy_cookie` for the `h5nc/*` family, and this family compares against
 * nothing of the sort: the name is what the pairing is called — 斗鱼's own 「我的头衔」 page
 * defines `$SYS['tvk'] = 'ccn'` beside `$SYS['tn'] = 'ctn'` and `$SYS['cookie_pre'] = 'acf_'`,
 * and a captured PC-client call of the same family sends
 * `ctn=c15c797cbe859a50731ffe6a3c041aa6` in its body while its own `cookie:` header carries
 * `acf_ccn=c15c797cbe859a50731ffe6a3c041aa6`, character for character. The `cvl_csrf_token`
 * is **the activity page's** cookie, and both halves of that sentence are measurements rather
 * than assertions: it is minted by the page itself, an empty-body
 * `POST /japi/carnival/nc/common/generateCsrf` — a path whose segment is `carnival`, one
 * segment short of the way this build's own activity calls spell it (`carnivalApi`) — and it
 * lives 300 seconds. The 2026-10-09 capture holds that mint
 * (`Set-Cookie: cvl_csrf_token=…; Max-Age=300`, from that same path **which this build does
 * not call**; `signActivity` records the shape it sends instead) and the `doSign` 63 ms later,
 * which carried the value in its `Cookie:` header *and* in its form field `csrfToken`. A reader
 * who reaches for either of those has the wrong cookie, not a missing one.
 */
export const FANSHOME_CSRF_COOKIE = 'acf_ccn'

/**
 * `-1` on `fanshome/sign`: today's signature for that room is already in.
 *
 * Named here rather than in `errors.ts` for the reason `FISH_BALL_ALREADY_CLAIMED` is — `-1`
 * is what several families answer for "already done", so it means this only where the
 * endpoint producing it is known. The captured body pairs it with 「今日已签到，请明天再来」,
 * the service's own words for its daily reset, which is a success held until tomorrow rather
 * than a refusal to retry until midnight; `signFansHome` therefore unwraps it into
 * `alreadySigned`.
 */
export const FANSHOME_ALREADY_SIGNED = -1

/**
 * The **status** the CSRF layer refuses this family with, and the body says so itself:
 *
 *     {"timestamp":1791390321714,"status":403,"error":"Forbidden",
 *      "message":"csrf auth failed","path":"/japi/interactnc/web/fanshome/sign"}
 *
 * A non-2xx is transport as far as this module is concerned (see `request`), so this refusal
 * reaches the adapter as `http_403` and not as a business code; the name is what lets the
 * adapter grade that one status as the local precondition it is instead of a network blip.
 *
 * **What this build's own live refusal was caused by is now established, and it was not the
 * session.** The captured run kept the response and not the request, so *that* 403's cause is
 * still unknown — but the one this action produced on its first live run is accounted for: the
 * value the read minted went into the body and **not** into the request's `Cookie:` header, so
 * the layer was handed a `ctn` with no `acf_ccn` to compare it against. A missing value is
 * excluded in that run for a different reason: the adapter refuses to send an empty `ctn` at all
 * (see the guard in `signFansHome`), and the run did send a request. What survives this build's
 * fix is therefore the case this constant's other half names — a value that *was* sent twice, in
 * both places, and refused anyway — and replaying the identical request answers the same 403,
 * which is what makes `retry` wrong.
 */
export const FANSHOME_CSRF_REFUSED_STATUS = 403

/**
 * What `fanshome/sign` answers when a signature actually lands.
 *
 * **`0` is inferred, not captured.** The two saved responses from this endpoint are
 * 「今日已签到」 (`-1`) and the CSRF layer's 403; no success body has ever been seen, so this
 * number comes from the reference implementation's own test of the field (`error !== 0`),
 * the same grade of evidence `clockGrowthPool` records for its success. **This constant is
 * the one place to correct it**: nothing else here or in the adapter names the number, and
 * the adapter reports the code verbatim, so a first real success that answers something else
 * is a one-line change plus this comment.
 */
const FANSHOME_SIGN_OK_CODES: readonly number[] = [0]

/** One 粉丝牌, as the badge wall's own row describes it. */
export interface FanBadge {
  /** The room the medal belongs to — the row's `data-fans-room`, digits as a string. */
  readonly roomId: string
  /** The anchor's display name, from the same row's `data-anchor_name`. `''` when absent. */
  readonly anchorName: string
  /**
   * 今日亲密度 — how much intimacy this room gained today — or **`null` when the cell could not be read**.
   *
   * Positional, and there is no alternative: the cell carries no `data-*`, no id and no semantic class
   * — `<td><span class="">0</span></td>` is the whole of it — so the only thing that identifies it is
   * that it is the **fourth** cell of the row, the one the table's own header calls 今日亲密度. The
   * measurement behind that index is `tests/captured/douyu-fan-badges.html`: its `<thead>` reads
   * 徽章 / 主播 / 亲密值 / 今日亲密度 / 排名 / 操作, and `douyu-fan-badges.test.ts` reads that header out
   * of the fixture and asserts this index is the cell it names, so the two cannot drift silently.
   *
   * **`null` and `0` are different facts and this field is the only place the difference survives.**
   * `0` is a reading — nothing has been gained in that room today; `null` is this side not knowing,
   * which is a state a caller reporting 「今天还没送过」 on a `0` would be inventing.
   *
   * **What `0` is evidence of, and what it is not.** 今日亲密度 is the *result* — the day's intimacy
   * gained in that room — and it was measured moving without any prop leaving the backpack
   * (`D:\Documents\deepseek-harness\default-workspace\douyu-gift-expiry\REPORT.md` §2.2: room 12306 read
   * `2` at 02:05 and `12` at 15:5x while the 荧光棒 count stayed at 60). So `0` means "nothing at all was
   * gained here today", from which "no gift was sent here today" follows only because a gift is one of
   * the things that gains intimacy — it is an inference from the reading, not the field's definition.
   */
  readonly todayIntimacy: number | null
}

/**
 * 今日亲密度 is the row's fourth cell, and the index is a measurement rather than a preference.
 *
 * Zero-based, so `3` is the fourth `<td>`; see `FanBadge.todayIntimacy` for the capture the header in
 * it was read from and for the test that re-reads it.
 */
const TODAY_INTIMACY_CELL = 3

/**
 * `<td` or `<td …>` — the cell delimiter, the same shape `BADGE_ROW_START` has for rows.
 *
 * Only the *starts* are needed: a cell runs to the next start, and the last one runs to the end of the
 * row, which is exactly how `badgesIn` slices rows out of the page.
 */
const BADGE_CELL_START = /<td[\s>]/g

/**
 * 今日亲密度 out of one row, or `null` when the cell is not there or is not a number.
 *
 * Tags are stripped rather than parsed: the cell's own content is a `<span>` with an empty class and a
 * decimal integer, and this module has no HTML parser and does not add one for that (see `attributeIn`).
 * A cell whose text is not digits is `null` and not `0` — the shape this module has never seen must not
 * arrive as the one value that means "nothing was gained today".
 */
function todayIntimacyIn(row: string): number | null {
  const starts = [...row.matchAll(BADGE_CELL_START)].map(match => match.index ?? 0)
  const start = starts[TODAY_INTIMACY_CELL]
  if (start === undefined) return null

  const cell = row.slice(start, starts[TODAY_INTIMACY_CELL + 1] ?? row.length)
  const text = cell.replace(/<[^>]*>/g, '').trim()
  return /^\d+$/.test(text) ? Number(text) : null
}

/**
 * What the badge wall answered: the medals, and the CSRF value the same response minted.
 *
 * **Both, and that is why this is an object.** The `acf_ccn` arrives in the headers of this
 * very response — `Set-Cookie: acf_ccn=…; Max-Age=7200`, reproduced in two runs an hour
 * apart and re-issued even to a caller that already carried one — so a read that returned
 * only the rooms would throw away the thing the next request needs, and its caller would go
 * looking for a `dy_cookie` instead.
 */
export interface FanBadgeList {
  readonly badges: readonly FanBadge[]
  /**
   * The `acf_ccn` this same response minted, or `null` when it minted none.
   *
   * The value `ctn` must equal; see `FANSHOME_CSRF_COOKIE` for why it is not what
   * `fetchCsrfCookie` returns.
   */
  readonly csrf: string | null
}

/** `<tr` or `<tr …>` — the only row delimiter the badge wall's markup uses. */
const BADGE_ROW_START = /<tr[\s>]/g

/**
 * One attribute out of an HTML fragment, or `''`.
 *
 * A string scan rather than a DOM parse, deliberately: this project has no HTML parser and
 * does not add one for two attributes off a page whose rows are siblings. The required
 * leading separator is what keeps a shorter name from matching the tail of a longer one.
 */
function attributeIn(html: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(html)
  return match?.[1] ?? ''
}

/**
 * The rooms the badge wall lists.
 *
 * The rows are the `<tr>`s carrying `data-fans-room`; the header row is skipped by that test
 * rather than by its position, so nothing depends on the table being first. Three fields are
 * read and no more. The same rows also carry `data-fans-level`, `data-fans-intimacy` and
 * `data-dfans`, and **`data-dfans` is deliberately not modelled** even though it looks like
 * the 钻石粉丝 flag: whether it gates anything has never been measured, and a field nothing
 * reads is a field the next reader decides to gate on.
 */
function badgesIn(html: string): FanBadge[] {
  const starts = [...html.matchAll(BADGE_ROW_START)].map(match => match.index ?? 0)
  const badges: FanBadge[] = []

  for (const [index, start] of starts.entries()) {
    const row = html.slice(start, starts[index + 1] ?? html.length)
    const roomId = attributeIn(row, 'data-fans-room')
    if (roomId === '') continue
    badges.push({
      roomId,
      anchorName: attributeIn(row, 'data-anchor_name'),
      todayIntimacy: todayIntimacyIn(row)
    })
  }

  return badges
}

/**
 * `GET /member/cp/getFansBadgeList` — the 粉丝牌 this account holds, and the `acf_ccn` the
 * same response minted.
 *
 * The response is a 64 KB **HTML page**, one row per 粉丝牌, which is why this is the one
 * function here that calls `request` rather than `requestJson` and reads its answer out of
 * markup. It belongs in this module rather than in the adapter for the reason every other
 * family here does: it is one endpoint with its own headers and its own contract, while the
 * read the adapter owns is the room one (`betard/<rid>`).
 *
 * The web session and the composite token both arrive as parameters. This module has no
 * cookie jar and must not acquire one: its most valuable property is that a web cookie
 * **structurally cannot** reach the `h5nc/*` family (`apiV2Headers`), and a jar here would
 * demote that to a rule somebody has to remember.
 *
 * The header set is the captured one — the probe's generic browser headers plus this
 * endpoint's own `token` — with no `origin` and no `referer`, because the captured call
 * carried neither and the reference implementation leans on a browser for both. **Which of
 * these the service requires was never isolated**: no experiment has separated the cookie
 * from the `token` header on this family, so the pair travels rather than a guess about which
 * half carries the identity.
 */
export async function readFanBadges(
  token: string,
  webCookies: string,
  options: DouyuRequestOptions = {}
): Promise<FanBadgeList> {
  const spec: CallSpec = {
    url: FAN_BADGES_URL,
    method: 'GET',
    headers: {
      // Asked for JSON, as the captured call did — and the service answers a 64 KB HTML page
      // either way. Kept because a request that reproduces the one that worked is worth more
      // than a tidier accept line nobody has tested.
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'user-agent': PC_USER_AGENT,
      token,
      ...(webCookies === '' ? {} : { cookie: webCookies })
    },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  const response = await request(spec)
  return { badges: badgesIn(response.body), csrf: readCookie(response.setCookie, FANSHOME_CSRF_COOKIE) }
}

/**
 * `GET /wgapi/livenc/liveweb/follow/list?page=<N>` — the rooms this account follows.
 *
 * **What is measured and what is not, stated before the fields.** This endpoint is in this project's own
 * probe catalogue (`douyu-probe/src/catalogue.ts`, `read-follow-list`), and what those runs recorded is
 * the **refusal**: with no usable login cookie and no `token` header it answers HTTP 200 with
 * `{"code":-1,"error":-1,"msg":"用户未登陆或token已过期"}`. **No body of `follow/list` itself has ever been
 * captured**, so the item field names below are not read off a `list` response. They are read off the
 * **sibling endpoint's** response on this very account — `follow/top3`, captured in
 * `D:\mitmproxy\all-2026-10-08_18-22-04.mitm` and saved as `tests/captured/douyu-follow-top3.json` —
 * whose items carry `room_id`, `nickname`, `room_name`, `show_status`, `online`, `videoLoop`,
 * `avatar_small` and `show_time`, plus a `data.total`; and they agree field for field with what the two
 * maintained third-party implementations read out of `list`'s items (`Sign_Room.js:30-34` uses
 * `list[i].room_id` and `list[i].show_status`, `FollowList.js:42-46` uses `nickname`, `room_name`,
 * `online`, `avatar_small`, `show_time`, `videoLoop`), and with the envelope `data.list` / `data.total`.
 *
 * **`show_status` is deliberately not modelled**, unlike in both of those. Whether a room is live is not a
 * criterion anywhere in this build: the one action that sends a gift does not read it (see `walkGifts`),
 * and the field this read feeds is 「默认倾泻直播间」, a destination rather than a live channel. A field
 * nothing reads is a field the next reader decides to gate on.
 *
 * **`pageCount` is modelled, and it is the one third-party claim this reads.** `Sign_Room.js:20` reads it
 * to know how many pages to walk, and no captured response has ever carried it — including `top3`'s, which
 * answered `nowtime`/`room_list`/`nolive`/`total` and nothing else. So it is **optional**, and the caller
 * treats its absence as "this page did not say" rather than as one page.
 *
 * The header set is the captured family's: `www.douyu.com` reads carry the whole cookie jar and no
 * `token` — but the catalogue's own probe sent `{dyToken}` and got a refusal for an expired one, and
 * `readFanBadges` beside this function sends both rather than guessing which half the service keys on. The
 * two halves therefore travel together here for the same reason.
 */
export const FOLLOW_LIST_URL = `${WEB_ORIGIN}/wgapi/livenc/liveweb/follow/list`

/** One followed room, as that list describes it. Names only: `show_status` is not read. See above. */
export interface FollowedRoom {
  /** The room's number, digits as a string — the value a choice stores and a gift POST is addressed by. */
  readonly roomId: string
  /** The anchor's display name. `''` when the service sent none. */
  readonly nickname: string
  /** The room's own title, which changes with the stream. `''` when the service sent none. */
  readonly roomName: string
}

/**
 * One page of the follow list.
 *
 * `total` and `pageCount` are `null` when the page did not declare them, which is a third reading and not
 * a zero: "this page did not say how many there are" is what a paging loop has to be able to tell apart
 * from "there are none".
 */
export interface FollowPage {
  readonly rooms: readonly FollowedRoom[]
  readonly total: number | null
  readonly pageCount: number | null
}

const followedRoomSchema = z.object({
  room_id: counter,
  nickname: z.string().default(''),
  room_name: z.string().default('')
})

const followPageSchema = z.object({
  list: z.array(followedRoomSchema),
  /** Both optional: neither has been seen on `list`, and a page that omits one must not fail this parse. */
  total: counter.optional(),
  pageCount: counter.optional()
})

export async function readFollowedRooms(
  token: string,
  webCookies: string,
  page: number,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<FollowPage>> {
  const spec: CallSpec = {
    url: `${FOLLOW_LIST_URL}?${new URLSearchParams({ page: String(page) }).toString()}`,
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      // The site's own home page, which is where the header's follow panel lives. The captured `top3`
      // calls carried the page the person was on (`.../${rid}`) and a `?dyshid=` serial; neither is read
      // here, and a referer that is the current page is what a browser would send from anywhere on the
      // site — this build has no current page.
      referer: `${WEB_ORIGIN}/`,
      'user-agent': PC_USER_AGENT,
      token,
      ...(webCookies === '' ? {} : { cookie: webCookies })
    },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  const result = await callApi(spec, followPageSchema)
  if (!result.ok) return result

  return {
    ok: true,
    code: result.code,
    data: {
      rooms: result.data.list.map(row => ({
        roomId: String(row.room_id),
        nickname: row.nickname,
        roomName: row.room_name
      })),
      total: result.data.total ?? null,
      pageCount: result.data.pageCount ?? null
    }
  }
}

export interface FanHomeSignOutcome {
  /** True when the service answered `-1`: this room's signature for today is already in. */
  readonly alreadySigned: boolean
}

/**
 * The `Cookie:` header one request carries: the jar's pairs, with `name` present exactly once.
 *
 * **A `Cookie:` header is not a bag of values to append to.** The value added here is the one the
 * body is about to repeat, and it is added by *replacing* the jar's own pair rather than by
 * appending beside it, because a header carrying two `acf_ccn`s hands the double submit two
 * candidates for the one field it compares, and which one the layer reads is not something this
 * project has measured. Replacing is also the honest reading of the value's lifetime: `acf_ccn` is
 * declared for 7200 seconds, so a copy sitting in a stored session is the likeliest thing in a
 * `Cookie:` header to be stale — the request should say the value the read just minted, once.
 */
function withCookie(header: string, name: string, value: string): string {
  const kept = header
    .split(';')
    .map(part => part.trim())
    .filter(part => {
      const separator = part.indexOf('=')
      return part !== '' && (separator <= 0 || part.slice(0, separator).trim() !== name)
    })

  return [...kept, `${name}=${value}`].join('; ')
}

/**
 * `POST /japi/interactnc/web/fanshome/sign` — one room's 粉丝家园 signature.
 *
 * **The value travels in two places, and that is the layer's contract rather than a redundancy.**
 * `ctn` is not checked on its own: this family is a **double submit**, and the captured PC-client
 * call of the same family is the proof — it sends `ctn=c15c797cbe859a50731ffe6a3c041aa6` in its
 * body while its own `cookie:` header carries `acf_ccn=c15c797cbe859a50731ffe6a3c041aa6`, byte for
 * byte. So the jar this function is handed is **not** enough on its own: whatever value the body
 * carries has to be in the request's own `Cookie:` header as well, which is why `ctn` is a
 * parameter — the caller decides which value is live, since it is the layer holding both the jar
 * and the cookie the read just minted — and why this function writes that value into the header
 * (`withCookie`) instead of forwarding the jar as it stands. A request carrying only the body's
 * half is the shape this action's one live failure took, and that request is the one this layer
 * refused with `403 csrf auth failed`.
 *
 * An empty `ctn` never reaches the wire: see the guard below.
 *
 * The body is `ctn` and `rid` and nothing else, which is what both the capture and the
 * reference implementation send. The response's `data` is **not modelled**: no success body
 * has been captured, so a field name would be a claim about one nobody has seen, and what
 * this endpoint pays has no evidence at all — nothing built on this function reports a
 * reward.
 */
export async function signFansHome(
  token: string,
  webCookies: string,
  ctn: string,
  rid: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<FanHomeSignOutcome>> {
  if (ctn === '') {
    // A request with an empty `ctn` is one this layer is never observed to let past — the only
    // captured refusal saved its response and not its request, so it is *not* that capture that
    // establishes this, but no call of this family has ever got through without the value. The
    // guard is here rather than only at the caller so that the invariant is structural: a caller
    // that has nothing to send cannot spend a room's attempt on a request known to be refused. The
    // *state* a run reports for a missing value belongs to the adapter (值拿不到 → `blocked`);
    // this is the last gate before the wire, and it is not a verdict about anything.
    throw new DouyuProtocolError(FANSHOME_SIGN_URL, 'ctn is empty, and this family refuses an empty one')
  }

  const spec: CallSpec = {
    url: FANSHOME_SIGN_URL,
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': PC_USER_AGENT,
      token,
      // The whole session plus the value under the name the layer compares. `ctn` is non-empty by
      // the guard above, so this header is never empty and is always sent.
      cookie: withCookie(webCookies, FANSHOME_CSRF_COOKIE, ctn)
    },
    body: formBody({ ctn, rid }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  const result = await callApi(spec, z.unknown(), FANSHOME_SIGN_OK_CODES)
  if (result.ok) return { ok: true, code: result.code, data: { alreadySigned: false } }
  if (result.code === FANSHOME_ALREADY_SIGNED) {
    return { ok: true, code: result.code, data: { alreadySigned: true } }
  }
  return result
}

/* ------------------------------------------------------------------ *
 * 粉丝牌任务 — one room's daily 亲密度 task list
 * ------------------------------------------------------------------ */

/**
 * The three `taskType` values the captured body declares, and each one means a different thing:
 * 1 is 「发送1条弹幕」, 2 is 「送出“全力守护”礼物」 (a gift the row names, and a paid one) and 3 is
 * 「赠送礼物」, whose `taskTotal` is how many gifts the day wants.
 *
 * Named here rather than in the adapter for the reason every endpoint constant here is: the numbers
 * belong to this payload, and a row carrying a fourth value is a contract change the adapter has to
 * report rather than guess at — which it can only do if the three it knows come from one place.
 */
export const ROOM_TASK_DANMAKU = 1
export const ROOM_TASK_NAMED_GIFT = 2
export const ROOM_TASK_ANY_GIFT = 3

/**
 * One daily task, narrowed to the fields anything here reads.
 *
 * **`taskStatus` is deliberately not modelled, and that is what this schema exists to decide.** It is
 * the field the page's own criterion uses (`completed = taskStatus === 1 || taskStatus === 2`) and
 * that criterion is unsound: room 12306's captured weekly read is `taskNum: 1 / taskTotal: 2 /
 * taskStatus: 2`, which it calls completed while the progress is one day of two. A caller that
 * judges by the counter cannot fall into it, and a field nothing parses is a field nobody can key on
 * by accident — so the trap is closed structurally rather than by a rule the next reader has to
 * remember.
 *
 * Three more fields are left out, each for its own reason: `taskId` and the two image hosts are
 * identifiers and URLs that nothing here reports (an item's label may never be one); the same name
 * `taskWhiteGiftId` is **24478** on the 指定礼物 row and **24468** on the 赠送礼物 row, so one field
 * carries two different things and no judgement here is built on it; and `extraIntimacyNum` is 0 in
 * every captured row with no meaning established anywhere, so it gets neither a field nor a
 * sentence.
 *
 * `intimacyNum` and `intimacyBuff` are the service's own declaration of what the task pays, and they
 * are **not the same unit**: the 弹幕 row declares `10`, the 指定礼物 row `25`, and the 赠送礼物 row
 * `0` here with `50` in the buff field — the five-gift bonus the page renders as a ladder. Both are
 * optional so that an upstream rename costs a clause rather than the action, and neither is ever
 * zero-filled: a task that declares no reward reports none, because an invented number is the one
 * failure this project has had to correct twice already.
 */
export const roomDailyTaskSchema = z.object({
  taskType: counter,
  /** The service's own name for the row. `''` when it sends none, which is the item label's fallback. */
  taskName: z.string().default(''),
  /** The pair that decides whether a task is outstanding: done means `taskNum >= taskTotal`. */
  taskNum: counter,
  taskTotal: counter,
  intimacyNum: counter.optional(),
  intimacyBuff: counter.optional()
})
export type RoomDailyTask = z.infer<typeof roomDailyTaskSchema>

/**
 * The payload, narrowed to its daily list.
 *
 * `dayTasks` is required, so a response that renamed it fails the schema and surfaces as a contract
 * change rather than as "this room has nothing to do". `weekTasks` sits in the same body and is
 * **deliberately not modelled**: a weekly row's progress moves by days of activity — room 12306 read
 * 「累计发送弹幕2天」 as 1 of 2 — so nothing a run does today could settle one, and modelling it would
 * invite exactly the judgement on the very field above that reads 「1/2 天」 as done.
 */
const roomTaskListSchema = z.object({ dayTasks: z.array(roomDailyTaskSchema) })

/**
 * `GET /japi/interactnc/web/fans/userTaskList?rid=<R>` — this room's daily 粉丝牌任务清单.
 *
 * **No CSRF, and that is measured rather than assumed.** All four captured calls to this endpoint
 * answered `error: 0`; the stored credential carries no `acf_ccn` at all (19 cookie names, none of
 * them that one); no response set one; and the page's own request layer defaults `csrf` to `isPost`,
 * so a GET carries no `ctn`. Nothing here mints one — `fetchCsrfCookie` boots the `h5nc/*` family
 * and would be a request spent on nothing.
 *
 * **`uid` is not sent.** `?rid=12306` alone answered byte-identically to `?rid=12306&uid=…` (1939
 * bytes both), and a cookie-only call answered the same again. That pair establishes that omitting it
 * is safe; it does **not** distinguish "the service ignores `uid`" from "it must equal the session",
 * which is why nothing here reads it back either.
 *
 * **The web session carries the identity, and the token travels beside it.** The captured calls sent
 * the composite token as a header *and* the whole 19-cookie session, and the token-less variant
 * answered byte-identically — so this sends both, as `readFanBadges` does, rather than guessing which
 * half the service keys on.
 *
 * The referer is the 粉丝转职 page this endpoint belongs to, built with this call's own `rid` even
 * though the captured `rid=12293234` call sent a referer naming `12306` and was accepted: the page is
 * what the service sees, and the room inside the referer is not what it keys on.
 */
export async function readRoomDailyTasks(
  token: string,
  webCookies: string,
  rid: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<readonly RoomDailyTask[]>> {
  const spec: CallSpec = {
    url: `${ROOM_TASK_LIST_URL}?${new URLSearchParams({ rid }).toString()}`,
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: `${WEB_ORIGIN}/pages/vibe-lab-fansbadgejobchange?isAnchorSide=0&rid=${encodeURIComponent(rid)}&source=1&sourcekey=FansClubPanel`,
      'user-agent': PC_USER_AGENT,
      token,
      ...(webCookies === '' ? {} : { cookie: webCookies })
    },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  const result = await callApi(spec, roomTaskListSchema)
  if (!result.ok) return result
  return { ok: true, code: result.code, data: result.data.dayTasks }
}

/* ------------------------------------------------------------------ *
 * 粉丝家园钓鱼 — one room's cycle, over `revenuenc/web/actfans/fishing/*`
 * ------------------------------------------------------------------ */

/**
 * What one cast spends, and **how that number was obtained.**
 *
 * 20, by subtraction and by nothing else: the `homePage` read nearest the cast (its
 * `baits[0].cnt` read 1150) minus the cast's own response (1130), 4.6 s apart with the cast
 * as the only write in between — and the five readings after it all stayed at 1130 across a
 * `reelIn` and two `changeBait`s, which is how reeling and bait-changing are known to be free.
 *
 * **It is not `fishing.castBait`, and that misreading cost this project once already.**
 * `castBait` is 0 before the cast and 1 after it, and then sits at 1 across the reel-in, the
 * two bait changes and the rod change **while 20 bait disappear** — so the field is a state of
 * the rod, not a price. It is also **not the stock**: 1130 and 1150 are two samples of one
 * counter five seconds apart, and subtracting those gives 0 and the conclusion that casting is
 * free.
 *
 * **Measured for `baitId 1` and not for `baitId 2`.** The one observed cast went out with
 * 入门鱼饵, so this is what a cast costs *with that one in use*; the second bait has no sample.
 * The adapter reads it as a floor before every cast, which is conservative only if the other
 * bait is not dearer — nothing here claims it is not, and the panel's own `cnt` is what
 * actually stops a loop.
 */
export const FISHING_BAIT_PER_CAST = 20

/**
 * `fishing.stat`'s three values, as captured.
 *
 * `0` nothing on the line, `1` a cast is out with `fishEtMs` saying when it lands, `2` the fish
 * is in and `reelIn` is the next move. The middle one is waited *to the instant the service
 * named* rather than through a sleep of this module's own: the capture's cast answered
 * `fishEtMs` 60 s after it went out, matching the `timePerRod: 60` beside it, and the read 62 s
 * later answered `stat: 2`.
 */
export const FISHING_STAT_IDLE = 0
export const FISHING_STAT_CAST = 1
export const FISHING_STAT_READY = 2

/**
 * `1005003` — 鱼饵不足, the cast's own refusal when the bait in use cannot pay for it.
 *
 * Named here rather than in `errors.ts` for the reason `FISH_BALL_ALREADY_CLAIMED` is: that
 * table states a code *and its grade*, and this number's grade is the adapter's judgement about
 * a day — it stops casting and says so — not a fact about Douyu. Provenance is the reference
 * implementation's branch (`error === 1005003` ⇒ stop for the day) and **not** a capture: no
 * refusal of this endpoint has ever been seen.
 */
export const FISHING_BAIT_EXHAUSTED = 1005003

/**
 * `1001007` — 「操作失败」, and what this project makes of it is the reference's branch again: a
 * cast answers it while a fish is already on the line, so the next move is `reelIn` and *then*
 * cast. It stays out of `errors.ts` for the same reason: `1001007` is a generic failure code on
 * this Platform, and the meaning attaches only where the endpoint producing it is known.
 */
export const FISHING_FISH_ON_THE_LINE = 1001007

/**
 * `opt=0`, the panel the captured reads asked for.
 *
 * Six of the seven captured `homePage` calls carried it — the seventh sent `opt=1` and answered
 * one field more (`latestAutoRec`), which nothing in this build reads. A request that reproduces
 * the shape that worked is worth more than a tidier one nobody has tested.
 */
const FISHING_HOME_OPT = '0'

/** The cast's own `ver`, verbatim from the capture (`ver=1.1`). */
const FISHING_CAST_VER = '1.1'

/**
 * `type=1&period=1`, the pair the reference implementation and the capture both send.
 *
 * What they select is **not established**: the one captured call answered a full 35-row list, so the
 * pair may mean "every species, all time" — or it may mean something narrower that happened to answer
 * the same list. They go out as captured rather than interpreted, and nothing here reads a field back
 * to check them.
 */
const FISHING_CODEX_TYPE = '1'
const FISHING_CODEX_PERIOD = '1'

/**
 * One 鱼饵 row: its id, its stock, and whether it is the one a cast goes out with.
 *
 * `inUse` is where the cast's `baitId` comes from, and that is measured: the panel read 4.6 s
 * before the cast carried `{id:1,cnt:1150,inUse:1}`, and the cast's own body was `baitId=1`.
 */
const fishingBaitSchema = z.object({ id: counter, cnt: counter, inUse: counter })
export type FishingBait = z.infer<typeof fishingBaitSchema>

/**
 * The `fishing` block: which half of the cycle the room is in, and when the wait is over.
 *
 * **`castBait` sits in this payload and is deliberately not modelled** — see
 * `FISHING_BAIT_PER_CAST` for the misreading it caused. A field nothing parses is a field no
 * later reader can key a decision on by accident, and the note above is where the trap is
 * recorded instead. `fishStMs` is left out for the same reason: nothing here needs the start
 * of a cast when the service hands out the end of it.
 *
 * `timePerRod` **is not modelled**, and its absence is the one thing to know about this block: it is
 * the payload's declaration of one rod's duration (60 s, and the cast's `fishEtMs` is that same 60 s
 * after `fishStMs`), so it looks exactly like the obvious fallback when a panel reports `stat: 1` with
 * no `fishEtMs`. It is not used as one: see `fishingWaitMs` in the adapter, where a missing instant is
 * a contract change that costs a read rather than a minute of waiting.
 */
const fishingStateSchema = z.object({
  stat: counter,
  fishEtMs: counter
})
export type FishingState = z.infer<typeof fishingStateSchema>

/**
 * The window this room's match is in, **as the service hands it out per match** — so nothing may
 * hardcode one, and nothing may read one as a permission either.
 *
 * **It is not a gate, and that is a measurement.** On 2026-10-08 this panel reported `st`
 * 1791453600 (18:00) / `et` 1791457200 (19:00) while a cast went out at 17:49:45.958 — **614.042 s
 * before `st`** — and the service answered `error: 0`, took the 20 bait (1150 → 1130) and credited the
 * intimacy counter when that fish was reeled in (`myCh.exp` 1731 → 1732, `ownRank` +1). A cast
 * outside the window is not merely accepted, it pays; so the only thing that may refuse a cast is
 * the cast itself, and this window's job is to say when the room's match is — which is what tells a
 * **person** when to come back and settle. A person, and not the sweep: nothing in this project
 * compares `st`/`et` to decide anything, the sentence `fishingWindowClause` renders is their only
 * consumer, and the adapter's own note on that function is where the earlier "(and the next sweep)"
 * is corrected. `notes/douyu-three-actions-spec.md` says the same thing from
 * the other side: the reference implementation consults `isInFishingTime()` only in the tournament
 * mode and returns true in its default mode.
 *
 * **614 and not 615, and the difference is a truncation this file used to carry.** The cast's own
 * instant is `t=1791452985.958` in the capture (`wire-cast.txt`, and the response beside it), so
 * `st - t` is 614.042 s; the same minute's `matchInfo` read 0.567 s after the cast answered
 * `left: 614` (`wire-matchInfo.txt`, 17:49:46.525), which is the service's own number for the same
 * gap. 615 s is what a *whole-second* instant of 17:49:45 gives — and that is exactly what the
 * fixture kept, so the number here and the fixture's own instant have to move together. The wrong
 * one stood in five places in `server/src` (this schema, the adapter's description, and its three
 * long notes) and in three places in `tests/douyu-fishing.test.ts` (the fixture's own comment, the
 * case name, and the comment under it) — every one of them inherited from the same truncated instant.
 *
 * **Three captures, three windows**: 2026-10-07 read 12:00–24:00 (43200 s apart), the 2026-10-08
 * reading above is 18:00–19:00 (3600 s), and the match that opened at 19:00 that same evening read
 * 19:00–19:30 (1800 s). `st` and `et` are epoch **seconds**, while everything on this side of the
 * seam is milliseconds.
 *
 * **`stat` is read and reported, never compared** — same measurement: the panel that let the
 * 17:49:45 cast through said `stat: 1`, and the one that let a cast through at 19:02:55 said
 * `stat: 0`. Two different values, both with a cast the service accepted, so no value of this field
 * can be turned into a permission; whatever else it means is not established, and the adapter prints
 * it verbatim rather than interpreting it. `hour`, `left` and `lhour` are left unmodelled for that
 * reason and one more: nothing reads them, and a field modelled and never read is the field the next
 * reader decides to gate on (see the note on `latestAutoRec`).
 */
const fishingMatchInfoSchema = z.object({ stat: counter, st: counter, et: counter })
export type FishingMatchInfo = z.infer<typeof fishingMatchInfoSchema>

/**
 * What a **cast** answers: the panel's own `baits` and `fishing`, and nothing else.
 *
 * **This is not the `homePage` shape, and the capture is what says so.** The cast's 422-byte response
 * carries `baits`/`seats`/`rods`/`fishing` and **no `matchInfo` and no `myCh`** — so it is enough for
 * everything a cast changes (the new stock, the new `stat`, and the `fishEtMs` the wait is for) and
 * for nothing more. The window and the 形象 still come from a panel read, which is why the cycle
 * reads one at the top of every round instead of trusting the reply to its own write for those two.
 */
export const fishingCastSchema = z.object({
  baits: z.array(fishingBaitSchema),
  fishing: fishingStateSchema
})
export type FishingCast = z.infer<typeof fishingCastSchema>

/**
 * The `homePage` panel: what a cast answers, plus the two things only a read carries.
 *
 * `myCh` is parsed as an opaque value on purpose. All the evidence establishes is that a non-empty
 * `myCh` means an 形象 is set — the reference gives up when it is falsy — and that is a question
 * about presence, not about fields: `uid`, `wear`, `clv` and `exp` travel inside it and none of their
 * meanings is established, so none is modelled and none is read.
 *
 * `baits` is required and `rods` is not modelled at all: nothing here changes the rod, and a required
 * field this build never reads would fail the parse for a room whose rod list is empty.
 */
export const fishingPanelSchema = fishingCastSchema.extend({
  matchInfo: fishingMatchInfoSchema,
  myCh: z.unknown().optional()
})
export type FishingPanel = z.infer<typeof fishingPanelSchema>

/**
 * One award row, **and no award row has ever been captured.**
 *
 * The one observed cycle answered `awards: []`, so the two field names here are the reference
 * implementation's expectation (`data.awards[].awardName/awardNum`) rather than a measurement.
 * Both are read leniently — a field that is missing, or of a shape a different deployment sends,
 * degrades to 「没读出名字」 instead of failing the parse — because a reel-in that has already
 * happened must still be reportable: the fish is in the account whether or not this side can name
 * what came with it.
 */
const fishingAwardSchema = z
  .object({ awardName: z.string().catch(''), awardNum: counter.catch(0) })
  .catch({ awardName: '', awardNum: 0 })

/**
 * `reelIn`'s answer: the fish, and whatever the service says came with it.
 *
 * `fish` is optional and the timestamps inside it are not modelled: what the capture shows is
 * `{id, wei, t}`, and the two facts a person reads are the weight and (in the console) which fish
 * it was. An answer without a `fish` is a state this build has not seen; it is reported as such
 * rather than failing the parse and losing the reel-in that just succeeded.
 */
export const fishingReelInSchema = z.object({
  fish: z.object({ id: counter, wei: counter }).optional(),
  awards: z.array(fishingAwardSchema)
})
export type FishingReelIn = z.infer<typeof fishingReelInSchema>

/**
 * The header set one `actfans/fishing` call carries.
 *
 * **Both credentials travel**, as they do for the sibling `interactnc/web` family and for the same
 * reason: no experiment has separated them here. The capture this family was reconstructed from
 * saved bodies and redacted every credential header, so *which* of the `token` header and the web
 * session the service keys on is unmeasured, and the pair goes out rather than a guess about half.
 *
 * `ctn` is written into the request's own `Cookie:` header as well as the body (`withCookie`) — the
 * shape the adjacent family's double submit needs, and the half this build's one live 403 was
 * missing. Whether this family checks both places is **not** established; sending both is the
 * choice that cannot turn out to be the missing half.
 *
 * The referer is the page the activity runs on, with no query: the captured call's own headers were
 * not kept, so which of these the service requires was never isolated, and a referer that names the
 * host page is the one nobody would have to correct.
 */
function fishingHeaders(token: string, webCookies: string, ctn: string | null): Record<string, string> {
  const jar = ctn === null ? webCookies : withCookie(webCookies, FANSHOME_CSRF_COOKIE, ctn)
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    referer: `${WEB_ORIGIN}/pages/fish-act/mine`,
    'user-agent': PC_USER_AGENT,
    token,
    ...(jar === '' ? {} : { cookie: jar })
  }
}

/**
 * One **write** of this family, with `ctn` in the body and in the cookie.
 *
 * The guard is `signFansHome`'s, restated here rather than shared: two families with two payloads
 * have two reasons to refuse an empty CSRF value, and the sentence is the same on purpose so a
 * person reading either log line sees the same failure named the same way. What is *shared* is the
 * value's provenance (`csrfValueFor`) and the header rewrite (`withCookie`), which are the two
 * places this arrangement can actually go wrong.
 *
 * Field order is the captured order — `ctn`, `rid`, then the endpoint's own fields — because a body
 * that reproduces the one that worked is worth more than one that merely parses.
 */
function fishingWriteSpec(
  url: string,
  token: string,
  webCookies: string,
  ctn: string,
  rid: string,
  fields: Readonly<Record<string, string>>,
  options: DouyuRequestOptions
): CallSpec {
  if (ctn === '') throw new DouyuProtocolError(url, 'ctn is empty, and this family refuses an empty one')

  return {
    url,
    method: 'POST',
    headers: { ...fishingHeaders(token, webCookies, ctn), 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ ctn, rid, ...fields }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }
}

/**
 * `GET /japi/revenuenc/web/actfans/fishing/homePage?rid=<R>&opt=0` — one room's panel.
 *
 * The read half of the cycle, and the only thing that can answer four questions at once: whether a
 * cast is out (`fishing.stat`), what the wait is (`fishing.fishEtMs`), what a cast may spend
 * (`baits[]`, with `inUse` naming the one) and what window the service says this room's match is in
 * (`matchInfo` — reported, never gated on; see `fishingMatchInfoSchema`). It is read once per cast
 * cycle, and the cast's own response covers the second reading that would otherwise follow it.
 *
 * A panel with no `ctn` and no write attached: this endpoint answered every captured call with the
 * session alone, and nothing here mints a value to read with.
 */
export async function readFishingPanel(
  token: string,
  webCookies: string,
  rid: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<FishingPanel>> {
  const spec: CallSpec = {
    url: `${FISHING_HOME_URL}?${new URLSearchParams({ rid, opt: FISHING_HOME_OPT }).toString()}`,
    method: 'GET',
    headers: fishingHeaders(token, webCookies, null),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  return await callApi(spec, fishingPanelSchema)
}

/**
 * `POST /japi/revenuenc/web/actfans/fishing/fishing` — 抛竿, which **spends bait**.
 *
 * The body is the capture's, character for character: `ctn=<acf_ccn>&rid=<R>&baitId=<id>&ver=1.1`.
 * The response carries the post-cast `baits` and `fishing` — so the new stock and the instant the
 * wait is for come out of this one reply, and a second `homePage` after a cast would be a request
 * bought with nothing. What it does **not** carry is `matchInfo` or `myCh`: see `fishingCastSchema`.
 */
export async function castFishingLine(
  token: string,
  webCookies: string,
  ctn: string,
  rid: string,
  baitId: number,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<FishingCast>> {
  const spec = fishingWriteSpec(
    FISHING_CAST_URL,
    token,
    webCookies,
    ctn,
    rid,
    { baitId: String(baitId), ver: FISHING_CAST_VER },
    options
  )

  return await callApi(spec, fishingCastSchema)
}

/**
 * `POST /japi/revenuenc/web/actfans/fishing/reelIn` — 收竿, and it carries **only** `ctn` and `rid`.
 *
 * No `baitId`: the bait is spent by the cast, and the capture reproduces that — a reel-in after
 * which `baits[0].cnt` was unchanged at 1130 across five readings. The response is not a panel;
 * what it carries is the fish (`data.fish.id`/`wei`) and `data.awards`, which was **empty** on the
 * one cycle this project has ever observed. Nothing built on this function promises a reward.
 */
export async function reelInFishingLine(
  token: string,
  webCookies: string,
  ctn: string,
  rid: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<FishingReelIn>> {
  const spec = fishingWriteSpec(FISHING_REEL_IN_URL, token, webCookies, ctn, rid, {}, options)

  return await callApi(spec, fishingReelInSchema)
}

/**
 * One species, as the 图鉴 lists it.
 *
 * **`firstLight` is read as "this species has been caught, and this is when"**, and that reading is
 * hedged in exactly one place: the field's own name says first-light, and in the one captured read it
 * is non-zero on **exactly one** entry — the only one whose `status` is 3, while all thirty-four
 * others answer `status: 0/lightNum: 0/firstLight: 0`. Two fields moving together once is a
 * correlation, not a definition, so what a run reports is built on this field alone and never on
 * `status` or `lightNum`, and neither of those is modelled.
 *
 * `name` is the only thing about a fish a person can read, which is why it is modelled: it is what a
 * row says instead of a `fishId`.
 */
const fishingCodexEntrySchema = z.object({
  fishId: counter,
  name: z.string().default(''),
  firstLight: counter
})
export type FishingCodexEntry = z.infer<typeof fishingCodexEntrySchema>

/**
 * The 图鉴 payload, narrowed to its list.
 *
 * `accList` is required, so a rename fails the parse and surfaces as a contract change rather than as
 * "this account has caught nothing". `total` sits beside it and is **not modelled**: it equalled the
 * list's length (35) in the one capture, so the list is not paginated, and a second copy of the same
 * number is a second thing that can disagree about it. `light` is left out for the reason `ycchip`'s
 * counter is left out of the adapter — nobody has established what it counts.
 */
const fishingCodexSchema = z.object({ accList: z.array(fishingCodexEntrySchema) })

/**
 * `GET /japi/revenuenc/web/actfans/achieve/accList?rid=<R>&type=1&period=1` — this room's 图鉴.
 *
 * The durable half of 钓鱼's output: a cast may pay nothing at all (the one observed `reelIn`
 * answered `awards: []`), while a **species** the account has never caught moves this list, and that
 * is the thing worth doing the chore for.
 *
 * The query is the one the reference implementation sends and the one captured verbatim
 * (`rid=12306&type=1&period=1`). What `type` and `period` select is not established — the capture has
 * one sample and shows a full 35-row list — so both are sent as captured rather than interpreted.
 */
export async function readFishingCodex(
  token: string,
  webCookies: string,
  rid: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<readonly FishingCodexEntry[]>> {
  const spec: CallSpec = {
    url: `${FISHING_CODEX_URL}?${new URLSearchParams({ rid, type: FISHING_CODEX_TYPE, period: FISHING_CODEX_PERIOD }).toString()}`,
    method: 'GET',
    headers: fishingHeaders(token, webCookies, null),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  const result = await callApi(spec, fishingCodexSchema)
  if (!result.ok) return result
  return { ok: true, code: result.code, data: result.data.accList }
}

/**
 * `userLottery/panelInfo`'s one useful number: the counter `userLottery/lottery` spends.
 *
 * Read as a **transform to a number** rather than as a payload, because that is the whole of what
 * this build does with it: the panel carries three other groups (`disp`, `batch100Lock`,
 * `lotterySettingScore`) and none of them is needed to answer "is there anything to spend". The
 * reading is measured, not assumed — the captured pair is `88` at 17:49:30 and `81` after a
 * `batch=10` lottery at 17:49:34, so the number goes **down** when the lottery runs.
 *
 * **Nothing here spends it.** Buying draws is a decision about an account's筹码 and not a step of a
 * fishing cycle; see the adapter, which reads this and says so.
 */
const fishingLotteryPanelSchema = z
  .object({ lotteryInfo: z.object({ score: counter }) })
  .transform(panel => panel.lotteryInfo.score)

/**
 * `GET /japi/revenuenc/web/actfans/userLottery/panelInfo?rid=<R>` — the chips a draw would spend.
 *
 * A read, and only a read: this build has no lottery action, and whether one is worth having is a
 * question about the owner's筹码 rather than about fishing.
 */
export async function readFishingChips(
  token: string,
  webCookies: string,
  rid: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<number>> {
  const spec: CallSpec = {
    url: `${FISHING_LOTTERY_PANEL_URL}?${new URLSearchParams({ rid }).toString()}`,
    method: 'GET',
    headers: fishingHeaders(token, webCookies, null),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  return await callApi(spec, fishingLotteryPanelSchema)
}

/* ------------------------------------------------------------------ *
 * 亲密度任务礼物 — the backpack, and the one write that gives an item away
 * ------------------------------------------------------------------ */

/**
 * One row of `data.list[]`, the shape **both** `japi/prop` endpoints answer with.
 *
 * `id` and `count` are required and `name` defaults, which is the split `roomDailyTaskSchema` records:
 * the fields this module decides on are the ones a rename has to break loudly, and the one a person
 * reads may arrive absent. `count` is required rather than defaulted to `0` because the two readings are
 * not the same fact — 「服务端说这个号没有这件东西」 and 「这一版读不出数量」 — and only the first of them
 * is a reason to stop looking for something to send.
 *
 * **The other three dozen fields are not modelled, and `priceType`'s absence is the point.** The
 * Platform uses that name for two different fields, and the captured row carries `priceType: 2` on an
 * item a signed-in account holds sixty of — so a `priceType` here would be the next reader's excuse to
 * filter 「免费」 by it, which is the mistake the allowlist exists to avoid. `price`, `isValuable`,
 * `expiry`, `intimate` and the image hosts are left out for the reason every unread field in this module
 * is: a field nothing parses is a field nobody can key a decision on by accident.
 *
 * **`met` is the one field added since, and it is added as optional on purpose.** It is the item's
 * absolute expiry instant — measured, not inferred: `met = 1791734399` is 2026-10-11 23:59:59 (+08) and
 * the official front end's own `getRestTime(expiry) - 1s` lands on that same second, which is also what
 * makes `expiry: 4` "four days left including today" rather than an instant (the third-party script that
 * renders it draws `expiry - 1`). 清仓 keys its whole judgement on this one number, so it is parsed;
 * `expiry` and `exp` stay out, because they are the same fact in another unit (`exp = 1` has **never**
 * been seen as anything but 1, and its meaning is 未证) and two homes for one date is how they drift.
 *
 * Optional rather than required, and the direction matters: a payload without `met` must not fail this
 * parse, because the field is not this module's — it belongs to the one action that reads it. A required
 * `met` would take the gift-sending half of 亲密度任务 down with a change only 清仓 cares about. An item
 * with no `met` is therefore an item whose expiry the *caller* cannot read, and `sendRowGifts`/清仓 each
 * decide what that means for them.
 */
export const propItemSchema = z.object({
  id: counter,
  name: z.string().default(''),
  count: counter,
  /** The absolute expiry instant in **seconds** since the epoch, or absent when the service sent none. */
  met: counter.optional()
})
export type PropItem = z.infer<typeof propItemSchema>

/**
 * The read's envelope, narrowed to its list — and **required**, unlike the write's copy below.
 *
 * A backpack read that renamed `list` is a contract change this build has to see: it is the read a
 * gifting decision is made from, and answering 「没有这件礼物」 to a shape nobody verified is how a run
 * stops doing something that would have worked.
 */
const propListSchema = z.object({ list: z.array(propItemSchema) })

/**
 * The header set one `japi/prop` call carries.
 *
 * **No `token`, and that is the capture rather than an omission.** The captured pair — this family's
 * backpack read and its donate — sent the account's whole web session as `cookie` and **no** `token`
 * header, and both answered `error: 0`; on this family the session is the identity. The composite token
 * is what the sibling `interactnc/web` family sends *beside* the same session, so a reader arriving from
 * there will look for it here: if this pair ever starts refusing, the token is the first thing to add,
 * and this comment is where that reading belongs.
 *
 * The referer is the room page and nothing else. The capture's own referer carried a `dyshid` serial
 * beside the room, and whether the service validates it was never isolated — the same unmeasured
 * parameter `DEFAULT_H5_REFERER` records for `stn` — so the room goes out and the serial does not.
 */
function propHeaders(webCookies: string, rid: string): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    referer: `${WEB_ORIGIN}/${encodeURIComponent(rid)}`,
    'user-agent': PC_USER_AGENT,
    'x-requested-with': 'XMLHttpRequest',
    ...(webCookies === '' ? {} : { cookie: webCookies })
  }
}

/**
 * `GET /japi/prop/backpack/web/v5?rid=<R>` — what this account holds, by gift id.
 *
 * **A read, and the only thing it can do is look.** It is what the scheduled action asks *before* it
 * spends anything, and it is its own call because of the order: "is any of the items the owner allowed
 * actually in this account today" has to be answerable **before** a gift goes out, while a donate's own
 * receipt can only answer it after one has.
 *
 * **It is not the endpoint `routes/douyu-backpack.ts` reads, and the two are deliberately separate.**
 * That one is `pcapi.douyucdn.cn/japi/prop/backpack/pc/v1` and feeds the settings *form*, which draws a
 * choice list for a person; this one is the web page's own backpack, on the origin this family's write
 * goes to. They answer the same item shape — which is the whole of `propItemSchema` — and nothing else
 * about them is shared.
 *
 * `rid` is what the endpoint asks for and it names no room of ours: the captured call passed `12306` and
 * the answer was the account's own backpack rather than that room's, which is why the caller sends the
 * room it is working on instead of a constant of its own.
 */
export async function readGiftBackpack(
  webCookies: string,
  rid: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<readonly PropItem[]>> {
  const spec: CallSpec = {
    url: `${PROP_BACKPACK_URL}?${new URLSearchParams({ rid }).toString()}`,
    method: 'GET',
    headers: propHeaders(webCookies, rid),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  const result = await callApi(spec, propListSchema)
  if (!result.ok) return result
  return { ok: true, code: result.code, data: result.data.list }
}

/**
 * `propCount` — one, always, and it is a decision rather than a default.
 *
 * The reference implementation sends a batch when the page has one selected and Douyu accepts it; the
 * capture sent exactly one (`propId=268&propCount=1&roomId=12306`). One POST per gift is what this build
 * imitates, and the reason is that a gift cannot be un-sent: each answer carries the whole backpack, so
 * N single sends buy N receipts, and a refusal costs one gift rather than a batch of them.
 */
const DONATE_PROP_COUNT = '1'

/**
 * `bizExt`, character for character from the capture: `{"yzxq":{}}`.
 *
 * What the key selects is not established anywhere in this repo, so it travels as captured rather than
 * interpreted — the same reading `FISHING_CODEX_TYPE` records for its own two query fields.
 */
const DONATE_BIZ_EXT = '{"yzxq":{}}'

/** `0` is this endpoint's success: measured once, and the only code seen. */
const DONATE_OK_CODES: readonly number[] = [0]

/**
 * What a successful donate says it took off the account — three readings, not a number.
 *
 * `balance: 0` with `includePrice: 0` is the captured success, and it is the closest thing this build
 * has to a guarantee that a free item went out as a free one: no other field of the response is about
 * price at all. A non-zero pair is read as **"this send did not declare itself free"**, which is the
 * only direction a misreading here may take — a `charged` reading costs one sentence, while a `none`
 * invented over a non-zero field would be a claim that the owner was not billed.
 *
 * `unknown` is a receipt that could not be read, and it exists because silence is not allowed here: a
 * send whose price this side cannot see is reported as unread rather than as free.
 */
export type GiftCharge =
  | { readonly kind: 'none' }
  | { readonly kind: 'charged'; readonly balance: number; readonly includePrice: number }
  | { readonly kind: 'unknown' }

/**
 * What a donate answers, validated **leniently and after the fact** — and that is why it is not passed
 * to `callApi`.
 *
 * `settle` refuses a `data` its schema cannot read, and by the time this parse runs the gift is already
 * public: a shape this build cannot read must therefore cost the *report* and never the *fact*. So the
 * receipt is read here, through `safeParse`, and an unreadable one becomes 「读不出来」 in the outcome
 * rather than a thrown contract error that a caller would report as "the send failed".
 *
 * `retryable` sits in this same `data` and is **not** a field of this schema: nothing reads it on a
 * success — the count that continues a batch comes from `list` — and `retryableIn` reads it from the raw
 * envelope, which is the only place it exists on the refusal path. A field modelled and never read is
 * the field the next reader decides to gate on.
 */
const giftReceiptSchema = z.object({
  /** The whole backpack as this send left it. See `propItemSchema`. */
  list: z.array(propItemSchema),
  /** The public broadcast frame, one string per gift. Its dialect is the danmaku socket's; see `anchorNameIn`. */
  messages: z.array(z.string()),
  /** What the endpoint says it sent, and the two fields it says it charged. */
  usedProp: z.object({
    propName: z.string().default(''),
    balance: counter,
    includePrice: counter
  })
})

/**
 * What one accepted gift is known to be.
 *
 * Four facts and no promise: the gift's own name, the anchor the broadcast named, what the receipt says
 * about the price, and the backpack the receipt handed back. Nothing here reports a reward —
 * `intimacyBuff` is the task's own declaration and lives on the task list, not on this answer.
 */
export interface GiftDonation {
  /** The gift's own name from `usedProp.propName`, or `''` when the receipt named none. */
  readonly propName: string
  /** The anchor the broadcast frame names as the receiver, or `''` when no frame arrived or none was readable. */
  readonly anchorName: string
  readonly charge: GiftCharge
  /**
   * The backpack as this receipt left it, or `null` when the receipt could not be read.
   *
   * The two are different facts and a caller has to tell them apart: `[]` is the endpoint saying the
   * account now holds nothing to send — a reading a person can act on — while `null` is this side not
   * knowing. That difference is 「背包空了」 versus 「这一版的回包读不出来」, and it is why the two
   * sentences a run writes for them are not the same one.
   */
  readonly backpack: readonly PropItem[] | null
}

/**
 * The receiver's own name out of a broadcast frame, or `''`.
 *
 * The frame is the danmaku socket's dialect — `type@=dgb/rid=…/receive_nn@=<anchor>/gfn@=<gift>/…` — so
 * it is read with `socket.ts`'s `decodeStt` rather than with a splitter of this module's own: one
 * dialect, one parser, and the same function that decodes the socket's frames off the wire. `nn` beside
 * it is the *sender*, and `gfn` is the gift's name, which is read from `usedProp` instead — a frame is a
 * broadcast this side happened to receive, while the receipt is the endpoint's own account of the gift.
 */
function anchorNameIn(messages: readonly string[]): string {
  for (const frame of messages) {
    const receiver = decodeStt(frame)['receive_nn']
    if (receiver !== undefined && receiver !== '') return receiver
  }
  return ''
}

/**
 * The endpoint's own view of whether another attempt is worth making, or `null` when it did not say.
 *
 * Measured on a **success**, where it sits inside `data` (`"retryable":false`). No refusal body of this
 * endpoint has ever been captured, and the one refusal shape this Platform has been seen to use for a
 * family like this puts its text in `data` as a bare string — so the field is looked for in `data` alone
 * and anything that is not a boolean reads as "not said". Nothing here guesses a second position for it:
 * a `true` invented out of a misplaced read is a retry aimed at a spend.
 */
function retryableIn(data: unknown): boolean | null {
  if (!isJsonObject(data)) return null
  const value = data['retryable']
  return typeof value === 'boolean' ? value : null
}

/** The two price fields, as `GiftCharge`. See that type for what a non-zero pair means here. */
function chargeOf(usedProp: { readonly balance: number; readonly includePrice: number }): GiftCharge {
  return usedProp.balance === 0 && usedProp.includePrice === 0
    ? { kind: 'none' }
    : { kind: 'charged', balance: usedProp.balance, includePrice: usedProp.includePrice }
}

/**
 * `POST /japi/prop/donate/mainsite/v5` — gives one gift away, in public.
 *
 * **`v5`, and the version is the trap this family arrived with.** Three maintained third-party
 * implementations all write `mainsite/v1`; the captured call — the live web frontend, one 荧光棒 in one
 * room — is `mainsite/v5`, and the captured one is what this sends. There is no `v1` here to fall back
 * to: a build that kept both would be free to send the untested one.
 *
 * **The body is the capture's, field for field**: `propId`, `propCount` (see `DONATE_PROP_COUNT`),
 * `roomId` and `bizExt`. `URLSearchParams` does the escaping, which is what makes the captured
 * `bizExt=%7B%22yzxq%22%3A%7B%7D%7D` come out byte for byte.
 *
 * **What it does not decide is whether to send.** Whether this account may spend this item, how many the
 * day still wants and how many the account holds are three questions about a person's own list and a
 * task's own counter, and all three live in the adapter. This function sends exactly the one gift it is
 * handed.
 */
export async function donateGift(
  webCookies: string,
  rid: string,
  propId: string,
  options: DouyuRequestOptions = {}
): Promise<DouyuResult<GiftDonation>> {
  const spec: CallSpec = {
    url: PROP_DONATE_URL,
    method: 'POST',
    headers: {
      ...propHeaders(webCookies, rid),
      'content-type': 'application/x-www-form-urlencoded',
      origin: WEB_ORIGIN
    },
    body: formBody({ propId, propCount: DONATE_PROP_COUNT, roomId: rid, bizExt: DONATE_BIZ_EXT }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  // Read by hand rather than through `callApi`, for one field: the envelope's own `data` is needed on
  // the refusal path, and `settle` (rightly) throws the payload away once the code says no.
  const response = await requestJson(spec)
  const verdict = verdictOf(response.json, spec.url, 'error')
  const retryable = retryableIn(verdict.data)
  const result = settle(spec.url, verdict, z.unknown(), DONATE_OK_CODES)

  if (!result.ok) {
    // The server's own answer to "is another attempt worth making" is the one thing here that outranks a
    // code this table has never seen: `classifyError` grades an unknown code `retry`, and a refusal that
    // carries `retryable: false` is that same code with the server saying so, so the day is parked instead
    // of hammered. **Only `retry` may be moved**: a session verdict (`1002`, `999999`) is a fact about the
    // credential and is never softened by a field whose position on a refusal nobody has measured — so this
    // can park an action and can never un-park a dead session. The message travels untouched.
    return retryable === false && result.classification === 'retry'
      ? { ok: false, code: result.code, message: result.message, classification: 'action_stop' }
      : result
  }

  const receipt = giftReceiptSchema.safeParse(result.data)
  if (!receipt.success) {
    // The gift is out and the receipt is not a shape this build knows: reported as three unknowns rather
    // than thrown, because a throw from here becomes 「赠送失败」 for a send that happened.
    return {
      ok: true,
      code: result.code,
      data: { propName: '', anchorName: '', charge: { kind: 'unknown' }, backpack: null }
    }
  }

  return {
    ok: true,
    code: result.code,
    data: {
      propName: receipt.data.usedProp.propName,
      anchorName: anchorNameIn(receipt.data.messages),
      charge: chargeOf(receipt.data.usedProp),
      backpack: receipt.data.list
    }
  }
}
