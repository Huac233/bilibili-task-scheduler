/**
 * `platform/douyu/socket.ts` itself, driven by a socket the test owns.
 *
 * Every other case in this suite *mocks* `sendDanmaku` (`douyu-adapter.test.ts`,
 * `douyu-intimacy-tasks.test.ts`), which is right for what those files are about and means the frame
 * handling below had no test at all. What is here is the four shapes whose failures are public and
 * irreversible — the message going out twice, a success being thrown away by the bytes after it, a
 * content refusal graded as a fault, and the verdict that genuinely never arrived — so each of them is
 * asserted against the frames the module really writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DANMAKU_CONTENT_RULE,
  type DanmakuSession,
  decodeFrame,
  decodeStt,
  encodePacket,
  encodeStt,
  sendDanmaku,
  TYPE_SERVER
} from '../src/platform/douyu/socket.js'

/** The room and account every capture in this repo was taken from. */
const SESSION: DanmakuSession = {
  roomId: '12306',
  uid: '456918967',
  stk: 'stk',
  biz: 'biz',
  ct: '1',
  ltkid: 'ltkid',
  deviceId: '79b76cf1a2b3c4d5e6f708192a3b4c5d'
}

const ENDPOINT = 'ws://test'

/** One server frame, wrapped the way `encodePacket` wraps a client one. */
function frame(fields: Record<string, string>): Uint8Array {
  return encodePacket(encodeStt(fields), TYPE_SERVER)
}

/**
 * A `WebSocket` the test drives by hand.
 *
 * The module reaches the global by name (it has no declaration in this project's TypeScript lib), so
 * stubbing the global is the only way in — and it is also the only way to make the service say
 * something irreproducible, like `loginres` twice in one message.
 */
class FakeSocket {
  static readonly instances: FakeSocket[] = []

  binaryType = 'blob'
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  readonly sent: Uint8Array[] = []
  closed = false

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: Uint8Array): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  /** Everything the module has written, decoded back into field maps. */
  written(): Record<string, string>[] {
    return this.sent.flatMap(bytes => decodeFrame(bytes).packets.map(packet => decodeStt(packet.payload)))
  }

  writtenOfType(type: string): Record<string, string>[] {
    return this.written().filter(fields => fields['type'] === type)
  }

  /** One message from the service: whole frames, and any trailing bytes the caller wants to add. */
  deliver(...parts: readonly Uint8Array[]): void {
    const joined = Buffer.concat(parts.map(part => Buffer.from(part)))
    this.onmessage?.({ data: joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength) })
  }
}

/** The socket the module just built, already past `onopen`. */
function connected(): FakeSocket {
  const socket = FakeSocket.instances.at(-1)
  if (socket === undefined) throw new Error('the module built no socket')
  socket.onopen?.()
  return socket
}

async function wait(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

beforeEach(() => {
  FakeSocket.instances.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function send(text = '你好'): Promise<Awaited<ReturnType<typeof sendDanmaku>>> {
  return sendDanmaku(SESSION, text, { endpoint: ENDPOINT, joinSettleMs: 5, timeoutMs: 400 })
}

describe('sendDanmaku', () => {
  it('sends the message exactly once when the service repeats loginres', async () => {
    const pending = send()
    const socket = connected()

    // One message carrying two `loginres` frames. Each one used to arm its own timer, and the timer is
    // what writes the `chatmessage` — so this shape posted the same sentence to the room twice, which
    // is a public write nobody can undo.
    socket.deliver(frame({ type: 'loginres' }), frame({ type: 'loginres' }))

    await wait(60)

    expect(socket.writtenOfType('chatmessage')).toHaveLength(1)
    // The join is not repeated either: the second `loginres` is the service repeating itself, and a
    // second `joingroup` would be a frame with nothing behind it.
    expect(socket.writtenOfType('joingroup')).toHaveLength(1)

    socket.deliver(frame({ type: 'chatres', res: '0', len: '50' }))
    await pending
    expect(socket.closed).toBe(true)
  })

  it('keeps a chatres that arrived in a message with a trailing half-frame', async () => {
    const pending = send()
    const socket = connected()
    socket.deliver(frame({ type: 'loginres' }))
    await wait(30)

    // A complete verdict plus three bytes that cannot be a frame. `decodeFrame` reports the complete
    // packet and counts the tail as `remainder`; the tail used to be checked *first*, so this message's
    // `res=0` was discarded and the caller was told the whole exchange had timed out — and a message
    // whose acknowledgement was thrown away is a message that gets written to the room again.
    socket.deliver(frame({ type: 'chatres', res: '0', len: '50' }), new Uint8Array([1, 2, 3]))

    const result = await pending
    expect(result).toMatchObject({ ok: true, code: 0 })
  })

  it('grades the measured content refusal as a stop rather than a retry', async () => {
    const pending = send()
    const socket = connected()
    socket.deliver(frame({ type: 'loginres' }))
    await wait(30)

    // `res=356` fired on two different 40-character payloads in the capture while 30 of either was
    // answered `res=0`: a content rule, and retrying it unchanged repeats it forever. The shared table
    // has never seen the code and answers `retry`, which is why the socket names it itself.
    socket.deliver(frame({ type: 'chatres', res: String(DANMAKU_CONTENT_RULE) }))

    const result = await pending
    expect(result).toMatchObject({ ok: false, code: DANMAKU_CONTENT_RULE, classification: 'action_stop' })
  })

  it('leaves a quiet session as a retry, because there is nothing to classify', async () => {
    const pending = send()
    const socket = connected()
    socket.deliver(frame({ type: 'loginres' }))
    await wait(30)

    // The other half of the pair: a message that produced no verdict at all keeps `retry`, and the
    // sentence says which case it was rather than claiming no verdict arrived.
    socket.deliver(frame({ type: 'chatres', len: '50' }))

    const result = await pending
    expect(result).toMatchObject({ ok: false, code: null, classification: 'retry' })
    expect(result.ok ? '' : result.message).toContain('no res code')
  })
})
