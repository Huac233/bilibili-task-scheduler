// The parameter-name rule the constructors below apply — and the one `protocol.ts` applies to a
// business refusal's sentence — is `text/redact.ts`'s. The copy this file used to keep listed
// `dy_token|jwt_token|token` and nothing else; the shared rule is the union across Platforms, and its
// extra names cost nothing in a Douyu sentence while a gateway echoing a Bilibili-shaped URL would
// carry them. Its leading `\b` is the trap this file's own note recorded: the alternative, an optional
// separator (`[?&]?`), redacts `csrfToken=` as well, which is a different parameter whose value is not
// a credential. Why the rule has one home is at the top of `platform/bilibili/index.ts`.
import { redactCredentialParameters } from '../../text/redact.js'

/**
 * Douyu error codes, and what each one means to a caller.
 *
 * Douyu answers HTTP 200 with the business code inside the body, so a refusal and
 * a success have the same shape on the wire and the code is the only thing that
 * separates them. Classifying it once, here, is what keeps a scheduler from
 * retrying an action that already succeeded or looping on a credential that is
 * gone — both of which the endpoint families invite, because they report "already
 * done today" as an error code.
 */

/**
 * What a caller must do about a code.
 *
 * `retry` is also the answer for codes this table has never seen, and that is
 * deliberate: an unknown code is more often a race or a transient fault than a
 * permanent state, and the alternative — stopping — silently drops the day's work.
 */
export type ErrorClassification = 'retry' | 'action_stop' | 'account_stop'

/**
 * Codes that mean the presented session is refused.
 *
 * `999999` belongs here even though it reads like a generic fault: the probes
 * showed it is what `h5nc/*` answers when a call carries a *web session* cookie
 * next to a perfectly valid token (§2.2). The session presented is the wrong one,
 * so retrying the same call unchanged repeats the same mistake.
 * `401000206` is the danmaku socket rejecting a bad `vk`.
 */
export const ACCOUNT_STOP_CODES: readonly number[] = [1002, 999999, 401000206]

/**
 * The three codes this project can name, and therefore the three the table below is
 * built from.
 *
 * They live here rather than beside the endpoints that answer them because a code is
 * one fact with two readers: `protocol.ts` compares a verdict against the name, and the
 * table decides what the caller does next. Two copies of `6305` could be changed
 * independently, and a code that stops being classified silently stops parking the
 * day's work — so the name and its classification are stated once, in one direction
 * (`protocol.ts` imports this module, never the other way round).
 */

/** `sendSign` answers this once today's sign-in is already in. A success, not an error. */
export const CLIENT_SIGN_ALREADY_SIGNED = 6305

/**
 * `doSign`'s "today is already signed", and a success for the same reason `6305` is.
 *
 * The name is right and the **provenance is still not a capture**. The activity page's own
 * error table reads `31015 = 今日已签到`, and that table is all this number has ever had: the
 * 2026-10-09 capture was searched for it across every text response in the file and answered
 * **zero**, because the account it belongs to signed exactly once that night — one `doSign`
 * cannot produce "already signed". So this number now has a measured absence as well as an
 * unmeasured presence.
 *
 * What rests on it is worth naming, because it is more than a comment: the code is in
 * `ACTION_STOP_CODES` through the name below, so `classifyError(31015)` parks the day's work
 * rather than retrying it, and `signActivity` accepts it as this endpoint's OK code. Both are
 * reads of a page-bundle enum entry nobody has seen on the wire. They are kept anyway, and the
 * direction is the reason: a number that never arrives costs nothing, while dropping it would
 * turn a real "already signed" into a refusal that the scheduler retries against a **write**.
 *
 * The one `doSign` body this repo does hold is `ACTIVITY_SIGN_SUCCESS`'s; see it for what a
 * first-time call actually answers.
 */
export const ACTIVITY_ALREADY_SIGNED = 31015

/**
 * `doSign`'s success code, and **the name is the correction**: the signature landed.
 *
 * It used to be `ACTIVITY_SIGN_NO_GIFT`, on the strength of the activity page's error table,
 * which reads `31200 = 签到成功无礼包`. That reading is neither what the service says nor what
 * the account got. The captured call (2026-10-09 03:20:35) answered
 * `{"error":31200,"msg":"签到成功!","data":{},"redirectUrl":""}` — the service's own sentence,
 * with no 「无礼包」 in it — and the ledger entry written in that same second is
 * `{"num":20,"extraMsg":"签到礼包"}`. So the enum entry is a label for the code, not a claim
 * about this activity's payout, and 「signed, handed nothing」 was a claim the evidence
 * contradicts rather than a caution the old name was erring on the safe side of.
 *
 * Two halves of the old reading do survive, and they are why this constant still carries a
 * caveat at all: the *body* carries no award (`data: {}` is measured, and `redirectUrl` is the
 * only other field), so nothing may report a figure read out of this response — what the
 * activity paid is in `redeemPoints/pointRecord`, a read this action does not make; and the
 * code is not a statement that the gift was granted *to this build's request shape* either, for
 * the same reason.
 *
 * Provenance, since that is the thing this file keeps getting wrong: **this one is a capture**,
 * not a page bundle. It is `tests/captured/douyu-activity-sign-31200.json`, byte for byte, and
 * `douyu-wire.test.ts` replies with those bytes through the real protocol.
 */
export const ACTIVITY_SIGN_SUCCESS = 31200

/**
 * Codes that mean the day's goal is already met.
 *
 * Composed from the names above rather than from a second copy of the numbers: this
 * table is a statement about those three codes, not a record of them.
 */
export const ACTION_STOP_CODES: readonly number[] = [
  CLIENT_SIGN_ALREADY_SIGNED,
  ACTIVITY_ALREADY_SIGNED,
  ACTIVITY_SIGN_SUCCESS
]

/** Maps one business code to the caller's next move. */
export function classifyError(code: number): ErrorClassification {
  if (ACCOUNT_STOP_CODES.includes(code)) return 'account_stop'
  if (ACTION_STOP_CODES.includes(code)) return 'action_stop'
  return 'retry'
}

/**
 * Reads the business code out of a payload field Douyu types inconsistently: a
 * JSON number on `sendFishBall`, the numeric *string* `"0"` on `sendSign`, and
 * either one on `getFishBallNum` depending on the endpoint's mood.
 *
 * Returns `null` — never `0` — for anything that is not a number-like value. A
 * payload that carries no code is a contract change, and reading it as 0 would
 * turn that into a silent success, which is the one failure mode a caller cannot
 * detect afterwards.
 */
export function readErrorCode(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^-?\d+$/.test(trimmed)) return null
    return Number.parseInt(trimmed, 10)
  }
  return null
}

/** A Douyu verdict of "no": the service answered, and the answer is a refusal. */
export interface DouyuFailure {
  readonly ok: false
  /**
   * The service's code. `null` only on the socket path, where a session can go
   * quiet without ever voicing a verdict — HTTP failures always carry a code.
   */
  readonly code: number | null
  /** The service's own text, or `''` when it sent none. */
  readonly message: string
  readonly classification: ErrorClassification
}

/**
 * One outcome, success or refusal.
 *
 * `code` is carried on the success side too, because on Douyu the code *is* the
 * outcome: `31200` (today's signature landed) and `31015` (today was already signed)
 * both mean the activity signature is in place. **Neither means the activity paid out,
 * and neither says it did not**: the payout is a ledger entry elsewhere, and `31200`'s
 * captured body answers `data: {}`, so a reward read off either code would be invented.
 */
export type DouyuResult<T> = { readonly ok: true; readonly code: number; readonly data: T } | DouyuFailure

/**
 * Thrown when the transport itself fails: DNS, TLS, the deadline, a non-2xx.
 *
 * `url` is stored already redacted, because this class exists to be logged from a
 * catch block. `message` is redacted too, and for a reason the first half of that sentence used to get
 * wrong: a message from this layer is whatever the transport said — `request failed: …`, or a
 * `response was not JSON` detail that quotes the body — and a body is exactly where a URL carrying
 * `?token=` gets echoed back. Redacting here rather than at the call sites is the same choice the
 * note above records: no caller can forget what the constructor does.
 */
export class DouyuTransportError extends Error {
  readonly url: string
  readonly status: number

  constructor(url: string, status: number, message: string) {
    super(redactCredentialParameters(message))
    this.name = 'DouyuTransportError'
    this.url = redactCredentialParameters(url)
    this.status = status
  }
}

/**
 * Thrown when a response is not a shape this module can read: not JSON at all, or
 * a payload that does not validate against the endpoint's schema.
 *
 * A contract change is neither a business outcome nor a transient fault, so it
 * throws instead of returning a result — the same split `bilibili/http.ts` makes
 * for `unexpected response shape`, and the reason a scheduler sees a loud failure
 * rather than a silently mis-read field.
 *
 * `detail` is redacted for the same reason `message` is above: the one detail this module composes out
 * of a response is a `JSON.parse` failure whose text quotes the body's first characters, and a body can
 * echo the URL it was asked for.
 */
export class DouyuProtocolError extends Error {
  readonly url: string
  readonly detail: string

  constructor(url: string, detail: string) {
    super(redactCredentialParameters(detail))
    this.name = 'DouyuProtocolError'
    this.url = redactCredentialParameters(url)
    this.detail = redactCredentialParameters(detail)
  }
}
