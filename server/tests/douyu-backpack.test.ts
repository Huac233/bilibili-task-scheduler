import { describe, expect, it, vi } from 'vitest'

import { ChoiceSourceRegistry } from '../src/actions/action-options.js'
import { type BackpackFetch, readDouyuBackpack } from '../src/routes/douyu-backpack.js'
import { BACKPACK_SOURCE } from '../src/routes/douyu-options.js'

/**
 * Douyu's backpack read, at the wire — and the two things about it that are easy to get wrong.
 *
 * **What this file can prove and what it cannot.** The endpoint, its query, its header set and the
 * five item fields the reader keeps are read off a capture: `GET
 * https://pcapi.douyucdn.cn/japi/prop/backpack/pc/v1?rid=<room>` was recorded on this repository's
 * own Douyu account in a PC-client session, and one item came back — `id: 268`, `count: 60`,
 * `expiry: 4`, `isValuable: 0`, `priceType: 2`. **The capture's Chinese text was destroyed by an
 * encoding fault on the way to disk** (every non-ASCII run arrived as `U+FFFD`, and no codec change
 * recovers it), so the fixtures below use readable sample names and the assertion is on the values,
 * the shape and the headers — never on a captured string. What is *not* reproducible from the
 * capture is the `auth` header, whose algorithm nothing in this repository documents; the reader
 * deliberately does not send one, and a refusal for want of it surfaces as a sentence.
 *
 * **The query has since been replayed against the live service, and one fixture below is that
 * measurement rather than the capture.** `rid=0` answers `{"error":1000,"msg":"rid缺失或不合法！"}`,
 * while four room numbers — `1`, `12306`, `12293234` and `74960` — each answer `error: 0` with a
 * byte-identical body, so the parameter is checked for being a room number and looked up by nothing.
 * See `BACKPACK_RID`. The wire tests therefore assert the value this build sends, and the refusal
 * test asserts the sentence a `1000` now produces.
 *
 * Nothing here reaches the network: a recorded `fetch` records the request and answers with a
 * fixture. The reader itself is real, so what is exercised is the code that runs, from the URL up.
 */

/** One recorded call: what was asked, and what came back. */
interface RecordedCall {
  readonly url: string
  readonly init: RequestInit
}

/**
 * A `fetch` that answers one body and records the request.
 *
 * The recorded body is returned as a `Response`, so the reader's own `text()` path is exercised —
 * a stub returning a plain object would skip the half of the code that decides what to do with a
 * body it cannot parse.
 */
function recordingFetch(answer: string | Error, status = 200): { fetch: BackpackFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetch: BackpackFetch = async (url, init) => {
    calls.push({ url, init })
    if (answer instanceof Error) throw answer
    return new Response(answer, { status })
  }
  return { fetch, calls }
}

/** One backpack entry, in the shape the capture returned: a number-heavy record nobody reads raw. */
interface BackpackRow {
  readonly id: number
  readonly name: string
  readonly count: number
  readonly expiry: number
  readonly isValuable: number
}

/**
 * One entry, with the capture's own values.
 *
 * `id: 268`, `count: 60`, `expiry: 4` and `isValuable: 0` are verbatim from the capture; the name is
 * a sample, because the capture's own Chinese text was destroyed by an encoding fault on the way to
 * disk.
 */
/** The envelope the capture answered, with the fields the reader keeps. */
function envelope(rows: readonly BackpackRow[]): string {
  return JSON.stringify({
    error: 0,
    msg: 'ok',
    data: {
      list: rows.map(entry => ({
        ...entry,
        // The capture's unread fields, kept on the fixture so a regression that leaked them would
        // be caught: `priceType` is the name two different fields share, and `batchInfo` is a map of
        // five nested counters.
        batchInfo: { 10: { batchNum: 10, name: '荧光棒+10' } },
        price: 10,
        priceType: 2,
        propType: 2
      })),
      totalNum: 60,
      validNum: 60,
      unlockLevel: 10
    }
  })
}

/**
 * One entry, with the capture's own values.
 *
 * `id: 268`, `count: 60`, `expiry: 4` and `isValuable: 0` are verbatim from the capture; the name is
 * a sample, because the capture's own Chinese text was destroyed by an encoding fault on the way to
 * disk.
 */
function row(fields: Partial<BackpackRow> = {}): BackpackRow {
  return { id: 268, name: '礼物', count: 60, expiry: 4, isValuable: 0, ...fields }
}

/** The one call the reader makes. */
const TOKEN = '456918967_21_681808fee85afe0d_14_47039959'

/** Whether a recording fetch was handed a `cookie` header at all. */
function callsSentCookie(calls: readonly RecordedCall[]): boolean {
  return calls.some(call => 'cookie' in (call.init.headers as Record<string, string>))
}

describe('readDouyuBackpack', () => {
  it('asks the captured endpoint once, with the token in a header and no credentials in the URL', async () => {
    const { fetch, calls } = recordingFetch(envelope([row()]))

    const read = await readDouyuBackpack({ token: TOKEN, webCookies: 'acf_auth=secret-cookie' }, fetch)

    expect(read.kind).toBe('ok')
    expect(calls).toHaveLength(1)

    const [call] = calls
    expect(call?.init.method).toBe('GET')
    // The URL carries no credential: a token in a query string is a token in every log between here
    // and Douyu, which is why `protocol.ts` redacts the ones its own families build. `rid` is the one
    // query field, and `1` is the value the live probe measured as accepted — `0` is refused.
    expect(call?.url).toBe('https://pcapi.douyucdn.cn/japi/prop/backpack/pc/v1?rid=1')
    expect(call?.url).not.toContain(TOKEN)
    expect(call?.url).not.toContain('acf_auth')

    const headers = call?.init.headers as Record<string, string>
    expect(headers['token']).toBe(TOKEN)
    expect(headers['cookie']).toBe('acf_auth=secret-cookie')
    // Never sent: an empty jar must not arrive as a header with nothing in it, because the capture
    // sent none at all.
    const withoutCookies = recordingFetch(envelope([]))
    await readDouyuBackpack({ token: TOKEN, webCookies: '' }, withoutCookies.fetch)
    const bare = withoutCookies.calls[0]?.init.headers as Record<string, string>
    expect('cookie' in bare).toBe(false)
  })

  it('narrows each item to the fact a choice is made by', async () => {
    const { fetch } = recordingFetch(envelope([row(), row({ id: 269, name: '另一个礼物' })]))

    const read = await readDouyuBackpack({ token: TOKEN, webCookies: '' }, fetch)

    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    expect(read.items).toEqual([
      { value: '268', label: '礼物', count: 60, costsSomething: false },
      { value: '269', label: '另一个礼物', count: 60, costsSomething: false }
    ])
    // The raw payload stays out of the answer: `priceType`, `batchInfo` and the id-as-a-number are
    // all things the source returns and nothing on a form may read.
    expect(JSON.stringify(read.items)).not.toContain('priceType')
    expect(JSON.stringify(read.items)).not.toContain('batchInfo')
  })

  it('reports the Platform’s own paid marking without claiming a zero means free', async () => {
    const { fetch } = recordingFetch(
      envelope([
        row({ id: 1, name: '甲', count: 1, expiry: 1, isValuable: 1 }),
        row({ id: 2, name: '乙', count: 2, expiry: 1, isValuable: 0 })
      ])
    )

    const read = await readDouyuBackpack({ token: TOKEN, webCookies: '' }, fetch)

    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    // `true` is the Platform saying "this one is paid for"; `false` is only "no such marking", which
    // is why the form prints nothing at all for it rather than 「免费」.
    expect(read.items.map(entry => entry.costsSomething)).toEqual([true, false])
  })

  it('answers a refusal as a sentence, never as an empty backpack', async () => {
    const withSession = recordingFetch(JSON.stringify({ error: 9, msg: '请登录' }))
    const withoutSession = recordingFetch(JSON.stringify({ error: 9, msg: '请登录' }))

    const sent = await readDouyuBackpack({ token: TOKEN, webCookies: 'acf_auth=secret-cookie' }, withSession.fetch)
    const absent = await readDouyuBackpack({ token: TOKEN, webCookies: '' }, withoutSession.fetch)

    // The one wrong answer a person cannot tell from the right one is `[]`, so a refusal never is one.
    expect(sent.kind).toBe('unavailable')
    expect(absent.kind).toBe('unavailable')
    if (sent.kind !== 'unavailable' || absent.kind !== 'unavailable') return

    expect(sent.reason).toContain('网页会话')
    expect(sent.reason).not.toContain(TOKEN)

    // **One verdict code, two requests, two sentences.** The captured request carried no `cookie`
    // header, and this reader omits it for an account with no jar — so for *that* account the old
    // sentence ("this account's web session has expired, scan again") named something the request
    // never sent, and recommended the one flow a paste-bound account never went through. A test used
    // to pin that sentence for this very case, which is how it survived.
    expect(absent.reason).not.toContain('已失效')
    expect(absent.reason).toContain('没有存网页会话')
    expect(callsSentCookie(withoutSession.calls)).toBe(false)
  })

  it('sends exactly the header names its own account of the capture claims', async () => {
    const { fetch, calls } = recordingFetch(envelope([row()]))

    await readDouyuBackpack({ token: TOKEN, webCookies: 'acf_auth=secret-cookie' }, fetch)

    // The capture's flow carries fifteen header names; this request sends four of them and adds
    // `accept` plus `cookie`. Pinned as the whole set, because the module's prose about what it
    // omits ("two headers … are not sent here") was wrong by eight names and nothing noticed: a
    // header set is only as deliberate as the list somebody can point at.
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(Object.keys(headers).sort()).toEqual([
      'accept',
      'accept-language',
      'cookie',
      'referer',
      'token',
      'user-agent'
    ])
    // And the user agent is this build's own Chrome string, not the bare `Mozilla/5.0` the captured
    // PC client sent — which is why it is not described as the capture's.
    expect(headers['user-agent']).toContain('Chrome/131')
  })

  it('names `rid` when the service refuses the value this build fills in', async () => {
    const { fetch } = recordingFetch(JSON.stringify({ data: {}, error: 1000, msg: 'rid缺失或不合法！' }))

    const read = await readDouyuBackpack({ token: TOKEN, webCookies: '' }, fetch)

    // The body is the live service's own answer to `rid=0`, kept verbatim: this is the failure that
    // made the form unselectable, and the sentence it produces has to point at the parameter this
    // build owns rather than at the account, because the account was never the problem.
    expect(read.kind).toBe('unavailable')
    if (read.kind !== 'unavailable') return
    expect(read.reason).toContain('rid')
    expect(read.reason).not.toContain('重新扫码')
  })

  it('tells a broken contract apart from an empty list', async () => {
    const renamed = recordingFetch(JSON.stringify({ error: 0, msg: 'ok', data: { items: [] } }))
    const notJson = recordingFetch('<html>bad gateway</html>')

    const first = await readDouyuBackpack({ token: TOKEN, webCookies: '' }, renamed.fetch)
    const second = await readDouyuBackpack({ token: TOKEN, webCookies: '' }, notJson.fetch)

    expect(first.kind).toBe('unavailable')
    expect(second.kind).toBe('unavailable')
    if (first.kind !== 'unavailable' || second.kind !== 'unavailable') return
    // Two different states, two different sentences: one is a shape change somebody has to look at,
    // the other is a body that is not an envelope at all.
    expect(first.reason).toContain('结构')
    expect(second.reason).toContain('JSON')
  })

  it('keeps every credential out of a transport failure’s message', async () => {
    // The error text is not this module's: it is whatever the layer below said. So the message is
    // built from words that can quote a request back, and the reader is holding both credentials it
    // just sent — the composite token and the jar. This case puts all of them in the error on
    // purpose, because the earlier version of it used a message that mentioned neither and then
    // asserted only the *cookie* was absent: it passed without proving anything, and the token rode
    // into the response body.
    const jar = 'acf_auth=secret-cookie; acf_uid=456918967'
    const { fetch } = recordingFetch(new Error(`request failed: connect ECONNREFUSED for ${TOKEN} ${jar}`))

    const read = await readDouyuBackpack({ token: TOKEN, webCookies: jar }, fetch)

    expect(read.kind).toBe('unavailable')
    if (read.kind !== 'unavailable') return
    expect(read.reason).not.toContain(TOKEN)
    expect(read.reason).not.toContain('secret-cookie')
    expect(read.reason).not.toContain(jar)
    // Still a sentence somebody can act on, and still naming the parameter-shaped holes: the
    // redaction removes values, not the reason the call failed.
    expect(read.reason).toContain('读取斗鱼背包失败')
    expect(read.reason).toContain('ECONNREFUSED')
  })

  it('answers a non-200 with the status and nothing else', async () => {
    const { fetch } = recordingFetch('{"error":-1}', 403)

    const read = await readDouyuBackpack({ token: TOKEN, webCookies: '' }, fetch)

    expect(read.kind).toBe('unavailable')
    if (read.kind !== 'unavailable') return
    expect(read.reason).toContain('403')
  })
})

describe('the registry the route reads through', () => {
  it('answers a source it has never been given rather than throwing', async () => {
    const registry = new ChoiceSourceRegistry()

    const read = await registry.read('nobody.registered.this', 1)

    // A field whose source this build never wired is a sentence on the form, not a 500 — and the
    // message names the key, which is the only thing that helps whoever has to wire it.
    expect(read.kind).toBe('unavailable')
    if (read.kind !== 'unavailable') return
    expect(read.reason).toContain('nobody.registered.this')
  })

  it('turns a throwing source into a sentence too', async () => {
    const registry = new ChoiceSourceRegistry()
    registry.register({
      key: 'boom',
      read: async () => {
        throw new Error('source blew up')
      }
    })

    const read = await registry.read('boom', 1)

    expect(read.kind).toBe('unavailable')
    if (read.kind !== 'unavailable') return
    expect(read.reason).toContain('source blew up')
  })

  it('serves the source the 亲密度任务 field names', async () => {
    const registry = new ChoiceSourceRegistry()
    const read = vi.fn(async () => ({ kind: 'ok' as const, items: [] }))
    registry.register({ key: BACKPACK_SOURCE, read })

    await registry.read(BACKPACK_SOURCE, 7)

    expect(read).toHaveBeenCalledWith(7)
  })
})
