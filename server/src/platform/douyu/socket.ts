import { createHash } from 'node:crypto'

import { classifyError, type DouyuResult, type ErrorClassification, readErrorCode } from './errors.js'

/**
 * Douyu danmaku: the STT frame codec, and the one connection this project makes
 * with it.
 *
 * On the wire a frame is `[u32 len][u32 len][i16 type][i8 0][i8 0][STT][NUL]`,
 * little-endian, with `len = payload + 9`. Three services speak it — `wsproxy`
 * (the PC/web path), `danmuproxy:8501` (a read path) and the app's raw TCP
 * `:8601` — and the codec below is shared by all of them. One WebSocket message
 * can carry several packets back to back, which is why decoding walks by the
 * length field instead of assuming one packet per message.
 *
 * Sending goes to `wss://wsproxy.douyu.com:6671`, the path verified end to end
 * (§2.7): `loginres`, then `chatres res=0`, then the message seen on a second
 * connection watching the room. The app's route was abandoned on purpose — on
 * `danmuproxy:8601` the service answers a `vq` frame with a 64-byte challenge that
 * nothing outside the app's native library can compute, and every write there is
 * silently dropped, which reads exactly like a protocol bug in the frame format.
 *
 * The one invariant worth stating out loud: a `loginreq` carries the composite
 * session token and the device id, so no frame and no message built here may be
 * logged.
 */

/** Frame type a client sends. */
export const TYPE_CLIENT = 689
/** Frame type the service sends. */
export const TYPE_SERVER = 690

/** Verified working; `:6672` serves the same role. */
export const DEFAULT_DANMAKU_ENDPOINT = 'wss://wsproxy.douyu.com:6671'

/**
 * `chatres`' `res` values, which are not business codes.
 *
 * `chatres` arrives on this socket and not over HTTP, so these two numbers are this module's own
 * vocabulary — which is why they are named here rather than in `errors.ts`, a table that must not claim
 * they mean anything anywhere else. They are **exported**, and the reason is the classification right
 * below: the adapter that reads a verdict names the same two numbers when it reports one, and a code
 * with two homes is a code that can drift into two grades.
 */
/** `res=290` — sent too fast. The measured floor is ~2 s (§2.7). */
export const DANMAKU_RATE_LIMITED = 290
/** `res=356` — the content rule rejects a long consecutive alphanumeric run (§2.7). */
export const DANMAKU_CONTENT_RULE = 356

/**
 * The classification for a code read off this socket: the shared table, plus the one socket-only verdict.
 *
 * **`356` is the reason this exists.** `classifyError` has never seen it and answers `retry`, while the
 * measurement says it is a deterministic *content* refusal: the same 40-character payload came back
 * `res=356` twice — 40 digits, then 40 Latin letters — where 30 of either was answered `res=0`, so
 * retrying it unchanged repeats it forever. `290` needs no entry: the cadence refusal is a `retry`, and
 * that is what the shared table already answers for it.
 */
function classifySocketError(code: number): ErrorClassification {
  return code === DANMAKU_CONTENT_RULE ? 'action_stop' : classifyError(code)
}

/**
 * The whole-exchange budget, not one request's deadline.
 *
 * It covers connect, `loginreq`, `joingroup`, the send and the `chatres` that
 * acknowledges it, and it is stated here rather than borrowed from the HTTP side
 * because a socket session and an HTTP call are not the same shape of wait. See the
 * stage names below: the message it produces says which of them ran out.
 */
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Pause between `joingroup` and `chatmessage`.
 *
 * The join is applied asynchronously, and the proven recipe waited ~2.5 s. Sending
 * earlier is the one part of this flow that was never isolated, so the wait is kept
 * explicit and adjustable rather than tuned down to nothing.
 */
const DEFAULT_JOIN_SETTLE_MS = 2_500

/**
 * `@` and `/` are STT's delimiters, so any occurrence inside a key or a value has
 * to be escaped before the payload is joined. This is `@A`/`@S` in both directions.
 */
function escapeStt(value: string): string {
  return value.replaceAll('@', '@A').replaceAll('/', '@S')
}

function unescapeStt(value: string): string {
  return value.replaceAll('@S', '/').replaceAll('@A', '@')
}

/** Serialises fields to `key@=value/key@=value/`, in insertion order. */
export function encodeStt(fields: Readonly<Record<string, string | number>>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${escapeStt(key)}@=${escapeStt(String(value))}`)
  }
  return `${parts.join('/')}/`
}

/**
 * Parses an STT payload into a flat record.
 *
 * Douyu nests sub-objects by making a value empty, so a key whose value is empty
 * is a container rather than a field. The fields this module needs — `type`, the
 * heartbeat's `tick`, `chatres`' `res`/`len` and `error`'s `code` — are all
 * top-level, so nesting is not modelled; a container's raw remainder is left
 * unparsed rather than invented into structure.
 */
export function decodeStt(payload: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const chunk of payload.split('/')) {
    if (chunk === '') continue
    const separator = chunk.indexOf('@=')
    if (separator <= 0) continue
    fields[unescapeStt(chunk.slice(0, separator))] = unescapeStt(chunk.slice(separator + 2))
  }
  return fields
}

export interface Packet {
  readonly type: number
  readonly payload: string
}

export interface DecodedFrame {
  readonly packets: readonly Packet[]
  /** Bytes at the end that were not a complete packet, for a caller that buffers across messages. */
  readonly remainder: number
}

/** Wraps an STT payload in a client packet. */
export function encodePacket(payload: string, type: number = TYPE_CLIENT): Uint8Array {
  const body = Buffer.from(`${payload}\0`, 'utf8')
  const total = body.length + 12
  const buffer = Buffer.alloc(total)

  buffer.writeUInt32LE(total - 4, 0)
  buffer.writeUInt32LE(total - 4, 4)
  buffer.writeInt16LE(type, 8)
  buffer.writeInt8(0, 10)
  buffer.writeInt8(0, 11)
  body.copy(buffer, 12)

  return new Uint8Array(buffer)
}

/**
 * Walks one WebSocket message and returns every packet inside it.
 *
 * A message that ends mid-packet yields the complete packets plus a byte count for
 * the tail, so a caller can carry it into the next message instead of losing it.
 */
export function decodeFrame(data: Uint8Array): DecodedFrame {
  const buffer = Buffer.from(data)
  const packets: Packet[] = []
  let offset = 0

  while (offset + 12 <= buffer.length) {
    const declared = buffer.readUInt32LE(offset)
    const packetLength = declared + 4

    if (packetLength < 12 || offset + packetLength > buffer.length) break

    packets.push({
      type: buffer.readInt16LE(offset + 8),
      // The trailing byte is the NUL the payload was terminated with.
      payload: buffer.subarray(offset + 12, offset + packetLength - 1).toString('utf8')
    })
    offset += packetLength
  }

  return { packets, remainder: buffer.length - offset }
}

/**
 * The `vk` secret, character for character from §2.7.
 *
 * `;`, not `,`. One character cost a whole investigation round: with a comma, every
 * `vk` was wrong and every login answered `401000206`, which reads like a signature
 * *algorithm* problem, so the algorithm got reverse-engineered instead of the
 * constant being diffed. The captured triple proves the formula —
 * `rt=1791411776`, `devid=f71d67e4fe1f83a5310a3e6a00011701`,
 * `vk=53a4774b7b7ee73b5d59046dc4161f49` — and the same string is in
 * `douyu-probe/src/probe-send.ts`. Keep the three in sync.
 */
export const VK_SECRET = "r5*^5;}2#${XF[h+;'./.Q'1;,-]f'p["

/**
 * `vk = md5(rt + VK_SECRET + devid)`.
 *
 * `rt` is in **seconds**, and it must be the same second that the `loginreq` frame
 * carries: the service recomputes the hash from the `rt` it was given.
 */
export function computeVk(rt: number, deviceId: string): string {
  return createHash('md5')
    .update(`${String(rt)}${VK_SECRET}${deviceId}`, 'utf8')
    .digest('hex')
}

/**
 * Everything `loginreq` needs.
 *
 * The first five values are the composite token's own components —
 * `<uid>_<biz>_<stk>_<ct>_<ltkid>`, in that order — and they are the **web session's own
 * `acf_*` cookies**, dropped by the service on the scan's landing hop and assembled by
 * `passport.ts`. They are not the scan login's `short_token`: the web route this repo walks
 * carries no such bundle at all, and the PC route that answers one is not called (§7). The
 * sixth value is the device id, which the token does not carry and which must be the same one
 * that goes into `vk`. None of these values belongs in a log line: the token *is* the
 * account credential.
 */
export interface DanmakuSession {
  readonly roomId: string
  readonly uid: string
  readonly stk: string
  readonly biz: string
  readonly ct: string
  readonly ltkid: string
  readonly deviceId: string
}

/**
 * The `loginreq` frame, in the order the web client sends it.
 *
 * Order and completeness both matter: fields go on the wire in insertion order,
 * and the empty ones (`apd`, `jwt`, `dfl`) are part of the frame the client sends
 * rather than omissions. This field set is the one that produced a working
 * session, after a 2019-era set that omitted several of them had produced
 * `401000206` on every attempt.
 */
export function buildLoginFields(session: DanmakuSession, rt: number): Record<string, string> {
  return {
    type: 'loginreq',
    roomid: session.roomId,
    username: session.uid,
    password: '',
    ltkid: session.ltkid,
    biz: session.biz,
    stk: session.stk,
    devid: session.deviceId,
    ct: session.ct,
    pt: '2',
    cvr: '0',
    tvr: '7',
    apd: '',
    jwt: '',
    rt: String(rt),
    vk: computeVk(rt, session.deviceId),
    ver: '20190610',
    aver: '218101901',
    dmbt: 'chrome',
    dmbv: '154',
    er: '1',
    dfl: ''
  }
}

/** `joingroup`. Sending without it reaches the socket and never reaches the room. */
export function buildJoinGroupFields(roomId: string): Record<string, string> {
  return { type: 'joingroup', rid: roomId, gid: '1' }
}

/**
 * The `chatmessage` frame: unsigned, and the same field set the browser sends.
 *
 * `cst` is milliseconds; `dy` and `sender` are the device id and the uid, which is
 * why this frame is as sensitive as `loginreq` is.
 */
export function buildChatMessageFields(session: DanmakuSession, text: string, cst: number): Record<string, string> {
  return {
    pe: '0',
    content: text,
    col: '0',
    type: 'chatmessage',
    dy: session.deviceId,
    sender: session.uid,
    ifs: '0',
    nc: '0',
    dat: '0',
    rev: '0',
    tts: '0',
    admzq: '0',
    cst: String(cst)
  }
}

/**
 * The slice of Node's global `WebSocket` this module touches.
 *
 * Declared here because the project compiles with `lib: ["ES2023"]` and
 * `@types/node` ships no `WebSocket` declaration, so the global is untyped in this
 * repository. Six members are the whole surface, and reaching the global by name is
 * the only cast in the file — what comes back is then narrowed by
 * `isSocketConstructor` rather than promised by a second one.
 */
interface SocketLike {
  binaryType: string
  onopen: (() => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(data: Uint8Array): void
  close(): void
}

/**
 * True for anything the global `WebSocket` slot can hold, which the type system
 * cannot see.
 *
 * `typeof value === 'function'` is the whole test on purpose: the runtime either has
 * the class or it does not, and a function that is not a socket at all would fail on
 * the first frame instead of quietly looking like a session that never answers.
 */
function isSocketConstructor(value: unknown): value is new (url: string) => SocketLike {
  return typeof value === 'function'
}

/** Where the connection got to, for a timeout message that says something useful. */
type Stage = 'connecting' | 'login' | 'joined' | 'sent'

export interface SendDanmakuOptions {
  /** Defaults to `DEFAULT_DANMAKU_ENDPOINT`. */
  readonly endpoint?: string
  /** Budget for the whole exchange: connect, login, join, send, `chatres`. */
  readonly timeoutMs?: number
  /** Delay between `joingroup` and `chatmessage`. */
  readonly joinSettleMs?: number
}

export interface DanmakuAck {
  readonly elapsedMs: number
  /**
   * `chatres`' `len` field, 50 in every capture. The unit is untested, so it is
   * reported verbatim and nothing here enforces it.
   */
  readonly len: number | null
}

/** Node hands binary frames over as `ArrayBuffer`; anything else is not a frame we can read. */
function toBytes(data: unknown): Uint8Array | null {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : null
}

/**
 * Opens a socket, logs in, joins the room, sends one message, waits for `chatres`
 * and closes.
 *
 * A refusal is a result, not an exception: the service answers in-band on this
 * socket, and a scheduler that had to catch for `401000206` would also have to
 * catch for a quiet session and a closed socket, which is three cases it can only
 * tell apart if they come back as data. `code` is the service's verdict — `0` on a
 * success, the `error` frame's code on a refusal — and `null` when there is **no usable
 * verdict**: either nothing arrived (the deadline, `onerror`, `onclose`, an `error`
 * frame with no numeric code) or something arrived that this module could not read (a
 * `chatres` with no `res`). Every one of those keeps `retry`, and that is a choice
 * worth naming rather than a gap: a danmaku is at-least-once here, so a message whose
 * acknowledgement went unread is sent again rather than dropped, because the
 * alternative parks a day over one garbled frame. What a person can act on is the
 * *message*, which says which of those cases it was.
 *
 * What it does *not* do is prove delivery. `chatres res=0` is the service
 * accepting the frame; seeing the message in a room needs a second connection, and
 * two connections to the same service are refused, so that check lives elsewhere
 * (`douyu-final-confirm.mjs` in the probe).
 */
export async function sendDanmaku(
  session: DanmakuSession,
  text: string,
  options: SendDanmakuOptions = {}
): Promise<DouyuResult<DanmakuAck>> {
  const endpoint = options.endpoint ?? DEFAULT_DANMAKU_ENDPOINT
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const joinSettleMs = options.joinSettleMs ?? DEFAULT_JOIN_SETTLE_MS

  // A malformed endpoint is a caller mistake, not an outcome to report.
  if (!endpoint.startsWith('wss://') && !endpoint.startsWith('ws://')) {
    throw new Error(`danmaku endpoint must be a WebSocket URL, received "${endpoint}"`)
  }

  return await new Promise<DouyuResult<DanmakuAck>>(resolve => {
    const startedAt = Date.now()
    let stage: Stage = 'connecting'
    let settled = false
    let socket: SocketLike | null = null
    let deadline: ReturnType<typeof setTimeout> | null = null
    let joinTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (result: DouyuResult<DanmakuAck>): void => {
      if (settled) return
      settled = true
      if (deadline !== null) clearTimeout(deadline)
      if (joinTimer !== null) clearTimeout(joinTimer)
      // Best effort: the socket is often already gone, and closing twice is not an error.
      try {
        socket?.close()
      } catch {
        // Already closing.
      }
      resolve(result)
    }

    const fail = (code: number | null, message: string): void => {
      finish({ ok: false, code, message, classification: code === null ? 'retry' : classifySocketError(code) })
    }

    const write = (fields: Readonly<Record<string, string>>): void => {
      if (socket === null) return
      try {
        socket.send(encodePacket(encodeStt(fields)))
      } catch {
        // A socket that cannot take the write surfaces through onerror/onclose.
      }
    }

    // The runtime check comes **before** the deadline is armed. Throwing from a
    // Promise executor rejects the promise, but nothing after the throw runs — so a
    // deadline armed first would never be cleared, and the handle would hold the
    // process open for its full duration after the caller had already seen the
    // rejection. Order matters here in a way it does not elsewhere.
    const ctor: unknown = (globalThis as { WebSocket?: unknown }).WebSocket
    if (!isSocketConstructor(ctor)) {
      throw new Error('this runtime has no global WebSocket; Node 22 or newer is required')
    }

    deadline = setTimeout(() => {
      const where =
        stage === 'connecting'
          ? 'the connection never opened'
          : stage === 'login'
            ? 'the login was never answered (no loginres)'
            : stage === 'joined'
              ? 'the message was never sent'
              : 'no chatres came back'
      fail(null, `timed out after ${String(timeoutMs)} ms: ${where}`)
    }, timeoutMs)

    socket = new ctor(endpoint)
    socket.binaryType = 'arraybuffer'

    socket.onopen = () => {
      stage = 'login'
      write(buildLoginFields(session, Math.floor(Date.now() / 1000)))
    }

    socket.onmessage = event => {
      const bytes = toBytes(event.data)
      if (bytes === null) return

      const frame = decodeFrame(bytes)

      // A WebSocket message is framed — one `onmessage` is one whole message — so a
      // frame can never be split across them, and `remainder` must be zero. It is
      // checked rather than assumed because the failure it guards is silent: drop a
      // half-frame and the login or the `chatres` it carried simply never arrives,
      // which looks exactly like a server that stopped answering.
      //
      // This is not hypothetical: a raw-TCP transport was explored for this protocol
      // before the WebSocket endpoint was found, and on that transport frames *do*
      // arrive split. Anyone reintroducing one has to buffer across reads, and this
      // is the line that will tell them so.
      //
      // **The check comes after the packets, and that order is the point.** `decodeFrame`
      // only ever reports packets it decoded in full, so everything in `frame.packets` is a real
      // verdict — while a message carrying both a complete `chatres res=0` and a trailing half-frame
      // used to have that success discarded by this line, which then had the caller post the same
      // sentence to the room a second time. A verdict that arrived is not made less true by junk that
      // arrived after it; only a message that produced no verdict at all is a truncated one.

      for (const packet of frame.packets) {
        const fields = decodeStt(packet.payload)

        switch (fields['type']) {
          case 'pingreq': {
            // Answering this is not optional: a session that stops replying is
            // treated as gone by the service, and a `chatmessage` sent on a stale
            // session is acknowledged by nobody and delivered nowhere.
            write({ type: 'pingres', tick: fields['tick'] ?? String(Date.now()) })
            write({ type: 'mrkl' })
            break
          }

          case 'error': {
            const code = readErrorCode(fields['code'])
            fail(
              code,
              code === null
                ? 'the danmaku service answered an error frame with no numeric code'
                : `the danmaku service refused the session with code ${String(code)}`
            )
            break
          }

          case 'chatres': {
            const res = readErrorCode(fields['res'])
            if (res === 0) {
              finish({
                ok: true,
                code: 0,
                data: { elapsedMs: Date.now() - startedAt, len: readErrorCode(fields['len']) }
              })
              break
            }
            fail(
              res,
              res === null ? 'chatres arrived with no res code' : `the message was refused with res ${String(res)}`
            )
            break
          }

          case 'loginres': {
            // **Once per session, and that is a guard rather than a state machine.** A second
            // `loginres` must not arm a second timer: the timer is what sends the `chatmessage`, so two
            // of them are the same sentence appearing twice in the room — a public write with no undo.
            // The capture has one `loginres` per session. `joinTimer !== null` is the test for "one has
            // already been handled", and it covers the fired case too: the handle is only ever cleared
            // in `finish`, which settles the promise.
            if (joinTimer !== null) break
            stage = 'joined'
            write(buildJoinGroupFields(session.roomId))
            joinTimer = setTimeout(() => {
              stage = 'sent'
              write(buildChatMessageFields(session, text, Date.now()))
            }, joinSettleMs)
            break
          }

          default:
            break
        }
      }

      if (!settled && frame.remainder !== 0) {
        fail(null, `truncated frame: ${String(frame.remainder)} trailing bytes could not be decoded`)
      }
    }

    socket.onerror = () => {
      fail(null, 'the danmaku socket reported an error before a verdict arrived')
    }

    socket.onclose = () => {
      fail(
        null,
        stage === 'connecting'
          ? 'the danmaku socket was closed before it opened'
          : 'the danmaku socket was closed before chatres arrived'
      )
    }
  })
}
