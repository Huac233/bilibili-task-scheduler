import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import type { BuiltServer } from '../src/index.js'
import { allPlatforms, registerPlatform } from '../src/platform/registry.js'
import { TargetRefusal, TargetRefusalKind } from '../src/platform/target.js'
import type { TargetInfo } from '../src/platform/types.js'
import { upsertAccount } from '../src/repo/accounts.js'
import { test as it, registerUser, type Session } from './fixtures.js'

/**
 * The Platform seam's HTTP surface: the catalogue, the switchboard, accounts, and
 * target resolution.
 *
 * These four routes are what makes the UI platform-neutral, so the assertions are
 * written against the *registry* rather than against a hardcoded list of
 * Platforms: `allPlatforms()` supplies the expected catalogue and the tests check
 * that every route agrees with it. That is the property worth pinning — a route
 * that answered from its own table would drift the moment an adapter changed.
 */

/** A transport failure as an adapter reports one: an error carrying its HTTP status. */
class StubTransportError extends Error {
  readonly status = 0
}

/**
 * The same shape with a `status` that is not a number, which is not a transport signal.
 *
 * `httpStatusOf` reads a *number* as the transport's own word for the failure, and the boundary
 * between that and "no status at all" is the one that decides 502 from 400. This fixture is the
 * negative side of it: a field that happens to be called `status` is not a status.
 */
class StubStringStatusError extends Error {
  readonly status = '404'
}

/** Registered here so `resolveTarget` can be driven without touching any network. */
const STUB_PLATFORM = 'resolve_stub'

const RESOLVED_TARGET: TargetInfo = { key: '42', title: '标题', anchorId: '7', anchorName: '主播', liveStatus: 1 }

/**
 * The stub's next answer, as a typed holder rather than a `let`.
 *
 * Two cases below replace it, so it cannot be a constant — but the module-level `let`
 * this used to be is exactly the hole the fixtures close: TypeScript counts a
 * module-scope `let` as assigned, so a reset that never ran would surface as some
 * later case failing for a reason that has nothing to do with it. A holder is always
 * a `TargetInfo` factory, and the describe that replaces it resets it.
 */
const stubReply: { current: () => Promise<TargetInfo> } = { current: async () => RESOLVED_TARGET }

registerPlatform({
  key: STUB_PLATFORM,
  label: '目标解析测试',
  // Deliberately empty: a Platform with no actions must still be listed, and its
  // empty catalogue must not disturb the switchboard's merge.
  actions: [],
  resolveTarget: async () => stubReply.current(),
  probe: async () => ({ ok: true, liveStatus: 0, title: '', code: '0', detail: '', failure: 'none' }),
  send: async () => ({ ok: true, code: '0', detail: '', failure: 'none' }),
  reconcile: async () => []
})

const SECRET_COOKIE = 'SESSDATA-must-not-leak'

describe('GET /api/platforms', () => {
  it('requires a session', async ({ server }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/platforms' })
    expect(response.statusCode).toBe(401)
  })

  it('reports every registered Platform with its action catalogue', async ({ server, session }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/platforms', headers: session.auth() })
    expect(response.statusCode).toBe(200)

    const body = response.json<{
      platforms: { key: string; label: string; actions: { key: string; action: string }[] }[]
    }>()

    const expected = allPlatforms()
    expect(body.platforms.map(platform => platform.key)).toEqual(expected.map(platform => platform.key))

    for (const platform of expected) {
      const reported = body.platforms.find(candidate => candidate.key === platform.key)
      expect(reported?.label).toBe(platform.label)
      // The descriptors travel verbatim: the UI renders labels, switches and
      // needs-* hints straight from the adapter's declaration.
      expect(reported?.actions.map(action => action.key)).toEqual(platform.actions.map(action => action.key))
    }
  })

  it('carries data only — the adapters’ functions stay behind the seam', async ({ server, session }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/platforms', headers: session.auth() })
    const platform = response.json<{ platforms: Record<string, unknown>[] }>().platforms[0] ?? {}

    expect(Object.keys(platform).sort()).toEqual(['actions', 'key', 'label'])
  })

  it('lists a Platform that declares no actions', async ({ server, session }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/platforms', headers: session.auth() })
    const stub = response
      .json<{ platforms: { key: string; actions: unknown[] }[] }>()
      .platforms.find(platform => platform.key === STUB_PLATFORM)

    expect(stub?.actions).toEqual([])
  })
})

describe('GET /api/action-settings', () => {
  it('requires a session', async ({ server }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/action-settings' })
    expect(response.statusCode).toBe(401)
  })

  it('lists every catalogued action as off, because absence means off', async ({ server, session }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/action-settings', headers: session.auth() })
    expect(response.statusCode).toBe(200)

    const settings = response.json<{ settings: { platform: string; actionKey: string; enabled: boolean }[] }>().settings

    // The expected set is derived from the adapters, so an action added there shows
    // up here without this test being edited — and a route that only echoed stored
    // rows would fail immediately, because there are none.
    const catalogue = allPlatforms().flatMap(platform =>
      platform.actions.map(action => `${platform.key}/${action.key}`)
    )
    expect(settings.map(setting => `${setting.platform}/${setting.actionKey}`).sort()).toEqual(catalogue.sort())
    expect(settings.every(setting => !setting.enabled)).toBe(true)
  })

  it('does not report a stored row for an action no adapter declares', async ({ server, session }) => {
    const now = Date.now()
    server.ctx.db
      .prepare(
        `INSERT INTO action_settings (user_id, platform, action_key, enabled, options, created_at, updated_at)
         VALUES (?, 'ghost_platform', 'ghost_action', 1, '{}', ?, ?)`
      )
      .run(session.userId, now, now)

    const response = await server.app.inject({ method: 'GET', url: '/api/action-settings', headers: session.auth() })
    const settings = response.json<{ settings: { platform: string }[] }>().settings

    // The adapters are the source of truth about what exists; a leftover row has no
    // switch the UI could draw, so it is not a setting.
    expect(settings.some(setting => setting.platform === 'ghost_platform')).toBe(false)
  })
})

describe('PUT /api/action-settings', () => {
  it('requires a session', async ({ server }) => {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/action-settings',
      payload: { platform: 'bilibili', actionKey: 'send_danmaku', enabled: true }
    })
    expect(response.statusCode).toBe(401)
  })

  async function enable(
    server: BuiltServer,
    session: Session,
    platform: string,
    actionKey: string,
    enabled: boolean,
    options?: unknown
  ): Promise<number> {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/action-settings',
      headers: session.auth(),
      payload: { platform, actionKey, enabled, ...(options === undefined ? {} : { options }) }
    })
    return response.statusCode
  }

  it('flips one switch and returns the resulting setting', async ({ server, session }) => {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/action-settings',
      headers: session.auth(),
      payload: { platform: 'bilibili', actionKey: 'send_danmaku', enabled: true }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ setting: unknown }>().setting).toEqual({
      platform: 'bilibili',
      actionKey: 'send_danmaku',
      enabled: true,
      options: {}
    })
  })

  it('stores the options and keeps them when a later toggle omits them', async ({ server, session }) => {
    expect(await enable(server, session, 'bilibili', 'send_danmaku', true, { threshold: 5 })).toBe(200)
    expect(await enable(server, session, 'bilibili', 'send_danmaku', false)).toBe(200)

    const response = await server.app.inject({ method: 'GET', url: '/api/action-settings', headers: session.auth() })
    const setting = response
      .json<{ settings: { platform: string; actionKey: string; enabled: boolean; options: unknown }[] }>()
      .settings.find(candidate => candidate.platform === 'bilibili' && candidate.actionKey === 'send_danmaku')

    expect(setting?.enabled).toBe(false)
    expect(setting?.options).toEqual({ threshold: 5 })

    // And a value that is **not** an object comes back exactly as stored. This is the route's own policy
    // and deliberately not the one `repo/action-settings.ts`'s `actionOptions` applies: the parse they now
    // share is one function, but an adapter's options map is promised to be a map of objects while this
    // route's job is to show a person their own value. Pinned here because it is the one behaviour the
    // merge could have changed silently — the non-object path was reachable and untested before it.
    expect(await enable(server, session, 'bilibili', 'send_danmaku', true, null)).toBe(200)

    const reread = await server.app.inject({ method: 'GET', url: '/api/action-settings', headers: session.auth() })
    const storedNull = reread
      .json<{ settings: { platform: string; actionKey: string; options: unknown }[] }>()
      .settings.find(candidate => candidate.platform === 'bilibili' && candidate.actionKey === 'send_danmaku')

    expect(storedNull?.options).toBeNull()
  })

  it('rejects an unknown platform', async ({ server, session }) => {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/action-settings',
      headers: session.auth(),
      payload: { platform: 'myspace', actionKey: 'send_danmaku', enabled: true }
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toContain('未知平台')
  })

  it('rejects an action the Platform does not declare', async ({ server, session }) => {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/action-settings',
      headers: session.auth(),
      payload: { platform: 'bilibili', actionKey: 'write_poetry', enabled: true }
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toContain('write_poetry')
  })

  it('rejects a body with no switch state', async ({ server, session }) => {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/action-settings',
      headers: session.auth(),
      payload: { platform: 'bilibili', actionKey: 'send_danmaku' }
    })
    expect(response.statusCode).toBe(400)
  })

  it('keeps one user’s switches out of another user’s list', async ({ server, session }) => {
    expect(await enable(server, session, 'bilibili', 'send_danmaku', true)).toBe(200)

    const other = await registerUser(server, 'switch_snoop')
    const otherResponse = await server.app.inject({
      method: 'GET',
      url: '/api/action-settings',
      headers: other.auth()
    })

    const settings = otherResponse.json<{ settings: { platform: string; actionKey: string; enabled: boolean }[] }>()
      .settings
    expect(settings.every(setting => !setting.enabled)).toBe(true)
  })
})

describe('GET /api/accounts', () => {
  it('requires a session', async ({ server }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/accounts' })
    expect(response.statusCode).toBe(401)
  })

  it('lists an empty set for a fresh user', async ({ server, session }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/accounts', headers: session.auth() })
    expect(response.json<{ accounts: unknown[] }>().accounts).toEqual([])
  })

  it('returns the public fields and never the credential or meta blob', async ({ server, session }) => {
    const account = upsertAccount(server.ctx.db, session.userId, {
      platform: 'bilibili',
      externalId: '987654',
      displayName: '测试账号',
      avatar: 'https://example.com/a.png',
      credentials: JSON.stringify({ cookies: JSON.stringify({ SESSDATA: SECRET_COOKIE }) }),
      meta: JSON.stringify({ deviceId: 'device-must-not-leak' })
    })

    const response = await server.app.inject({ method: 'GET', url: '/api/accounts', headers: session.auth() })
    const [listed] = response.json<{ accounts: Record<string, unknown>[] }>().accounts

    expect(response.body).not.toContain(SECRET_COOKIE)
    expect(response.body).not.toContain('must-not-leak')
    expect(Object.keys(listed ?? {}).sort()).toEqual([
      'avatar',
      'createdAt',
      'displayName',
      'externalId',
      'id',
      'platform'
    ])
    expect(listed?.['id']).toBe(account.id)
  })
})

describe('DELETE /api/accounts/:id', () => {
  it('requires a session', async ({ server }) => {
    const response = await server.app.inject({ method: 'DELETE', url: '/api/accounts/1' })
    expect(response.statusCode).toBe(401)
  })

  it('rejects a non-numeric id', async ({ server, session }) => {
    const response = await server.app.inject({ method: 'DELETE', url: '/api/accounts/abc', headers: session.auth() })
    expect(response.statusCode).toBe(400)
  })

  it('returns 404 for an account that does not exist', async ({ server, session }) => {
    const response = await server.app.inject({ method: 'DELETE', url: '/api/accounts/999', headers: session.auth() })
    expect(response.statusCode).toBe(404)
  })

  it("returns 404 for another user's account, and leaves it bound", async ({ server, session }) => {
    const account = upsertAccount(server.ctx.db, session.userId, {
      platform: 'bilibili',
      externalId: '987654',
      displayName: '测试账号',
      avatar: '',
      credentials: '{}'
    })

    const other = await registerUser(server, 'account_snoop')
    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/accounts/${String(account.id)}`,
      headers: other.auth()
    })
    expect(response.statusCode).toBe(404)

    // The 404 is the whole point: the row is still there for its owner.
    const list = await server.app.inject({ method: 'GET', url: '/api/accounts', headers: session.auth() })
    expect(list.json<{ accounts: unknown[] }>().accounts).toHaveLength(1)
  })

  it('unbinds an account and cascades to its tasks', async ({ server, session }) => {
    const account = upsertAccount(server.ctx.db, session.userId, {
      platform: 'bilibili',
      externalId: '987654',
      displayName: '测试账号',
      avatar: '',
      credentials: '{}'
    })

    const now = Date.now()
    const library = server.ctx.db
      .prepare('INSERT INTO libraries (user_id, name, bullet_count, raw_chars, created_at) VALUES (?, ?, 0, 0, ?)')
      .run(session.userId, 'lib', now)
    const libraryId = Number(library.lastInsertRowid)

    const created = await server.app.inject({
      method: 'PUT',
      url: '/api/action-settings',
      headers: session.auth(),
      payload: { platform: 'bilibili', actionKey: 'send_danmaku', enabled: true }
    })
    expect(created.statusCode).toBe(200)

    const task = await server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: session.auth(),
      payload: {
        platform: 'bilibili',
        accountId: account.id,
        actionKey: 'send_danmaku',
        targetKey: '22637261',
        libraryId,
        startTime: now,
        endTime: now + 60_000,
        interval: 30
      }
    })
    expect(task.statusCode).toBe(200)

    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/api/accounts/${String(account.id)}`,
      headers: session.auth()
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json<{ ok: boolean }>().ok).toBe(true)

    const tasks = await server.app.inject({ method: 'GET', url: '/api/tasks', headers: session.auth() })
    expect(tasks.json<{ tasks: unknown[] }>().tasks).toEqual([])
  })
})

describe('POST /api/targets/resolve', () => {
  // Scoped to this describe rather than the whole file, because these are the only
  // cases that replace the stub's answer — and one that replaces it must not hand the
  // replacement to the case after it.
  beforeEach(() => {
    stubReply.current = async () => RESOLVED_TARGET
  })

  it('requires a session', async ({ server }) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      payload: { platform: STUB_PLATFORM, input: 'x' }
    })
    expect(response.statusCode).toBe(401)
  })

  it('rejects a body with no platform or input', async ({ server, session }) => {
    const missing = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      payload: { input: 'x' },
      headers: session.auth()
    })
    expect(missing.statusCode).toBe(400)

    const empty = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      payload: { platform: STUB_PLATFORM, input: '' },
      headers: session.auth()
    })
    expect(empty.statusCode).toBe(400)
  })

  it('rejects an unknown platform', async ({ server, session }) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      payload: { platform: 'myspace', input: '22637261' },
      headers: session.auth()
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toContain('未知平台')
  })

  it('returns the adapter’s target unchanged', async ({ server, session }) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      payload: { platform: STUB_PLATFORM, input: 'whatever' },
      headers: session.auth()
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ target: TargetInfo }>().target).toEqual({
      key: '42',
      title: '标题',
      anchorId: '7',
      anchorName: '主播',
      liveStatus: 1
    })
  })

  it('answers 400 when the adapter cannot make sense of the input', async ({ server, session }) => {
    stubReply.current = async () => {
      throw new Error('无法解析该目标')
    }

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      payload: { platform: STUB_PLATFORM, input: 'nonsense' },
      headers: session.auth()
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('无法解析该目标')
  })

  it('answers 502 when the failure is the transport, not the input', async ({ server, session }) => {
    stubReply.current = async () => {
      throw new StubTransportError('connect ECONNREFUSED')
    }

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      payload: { platform: STUB_PLATFORM, input: '22637261' },
      headers: session.auth()
    })

    expect(response.statusCode).toBe(502)
    expect(response.json<{ error: string }>().error).toContain('查询目标失败')
  })

  it('rejects a Bilibili link that is not a room, before any request is made', async ({ server, session }) => {
    // The real adapter's own rejection, reached without touching the network: the
    // host allowlist fails first. The positive cases need a live Bilibili and are
    // covered by the probe scripts, not here.
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      payload: { platform: 'bilibili', input: 'https://example.com/22637261' },
      headers: session.auth()
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toContain('无法从该链接解析出直播间号')
  })
})

/**
 * Why a paste did not become a target, told apart by what is actually wrong with it.
 *
 * The page renders this route's `error` string **next to the box the person typed into**, so the three
 * states have to read as three different things: a shape this Platform does not read a room out of, a
 * room that is not there (both of them the person's to fix by typing differently), and the Platform not
 * answering at all (not the person's to fix). Before this, the second one was reported as the third on
 * Douyu (a gateway status, 502) and as an internal call name on Bilibili
 * (`room_init failed for <id>: <msg>`).
 *
 * **These cases drive the real adapters**, with the transport stubbed and no `resolveTarget` mock in
 * sight: the classification is the adapter's own — a missing room is a fact about one Platform's
 * endpoint, which nothing above the seam can know — so a mock of that member would assert this file's
 * fixture instead of the code. The two Platforms read their rooms through the global `fetch`, which is
 * where the answers below are supplied.
 */
describe('POST /api/targets/resolve — why a paste did not become a target', () => {
  /** Every URL the stubbed transport was asked for, so "asked nothing" is assertable. */
  const asked: string[] = []

  /** One answer per request. A fresh `Response` each time: a body can only be read once. */
  function stubFetch(answer: (url: string) => Response): void {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input)
      asked.push(url)
      return answer(url)
    })
  }

  /** A Bilibili envelope, which is JSON at HTTP 200 whatever its `code` says. */
  function biliEnvelope(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  beforeEach(() => {
    asked.length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('answers 400 with a sentence about the number when Bilibili has no such room', async ({ server, session }) => {
    // `60004` is 直播间不存在: the code space `room_init` documents is `0` for success and that number
    // for a room that is not there. This is the answer a person used to be shown as
    // `room_init failed for 22637261: …`, where an internal call name sat in a sentence.
    stubFetch(() => biliEnvelope({ code: 60004, message: '直播间不存在', ttl: 1 }))

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      headers: session.auth(),
      payload: { platform: 'bilibili', input: '22637261' }
    })

    expect(response.statusCode).toBe(400)
    const error = response.json<{ error: string }>().error
    expect(error).toContain('没有房间号 22637261')
    expect(error).not.toContain('查询目标失败')
    expect(error).not.toContain('room_init')
  })

  it('answers 502 when Bilibili refuses with a code this build cannot name', async ({ server, session }) => {
    // The other side of the 60004 boundary, and the room payload **is** present here: what decides the
    // answer is the code, not whether a payload came with it. An unnamed refusal is not a verdict about
    // the number the person typed, so it keeps the transport answer and the sentence says so.
    stubFetch(() =>
      biliEnvelope({
        code: -412,
        message: '请求被拦截',
        data: { room_id: 22637261, short_id: 0, uid: 12345, live_status: 0, live_time: 0 }
      })
    )

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      headers: session.auth(),
      payload: { platform: 'bilibili', input: '22637261' }
    })

    expect(response.statusCode).toBe(502)
    const error = response.json<{ error: string }>().error
    expect(error).toContain('查询目标失败')
    expect(error).toContain('平台返回 code -412')
    expect(error).not.toContain('room_init')
  })

  it('answers 400 when Douyu has no such room, and never the gateway status', async ({ server, session }) => {
    // `betard/<unknown>` answers a 404 HTML page — the endpoint's own contract for a room it does not
    // have — and that number is about the paste, not about the connection. It used to come back as
    // 「查询目标失败：HTTP 404」, which is a transport sentence with a status nobody typed.
    stubFetch(() => new Response('<html>not found</html>', { status: 404 }))

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      headers: session.auth(),
      payload: { platform: 'douyu', input: '99999999' }
    })

    expect(response.statusCode).toBe(400)
    const error = response.json<{ error: string }>().error
    expect(error).toContain('没有房间号 99999999')
    expect(error).not.toContain('查询目标失败')
    expect(error).not.toContain('HTTP 404')
  })

  it('answers 502 when Douyu could not be asked at all', async ({ server, session }) => {
    // The other side of that boundary: an upstream fault is not a verdict about the room, and the same
    // paste may well work in a minute.
    stubFetch(() => new Response('upstream is down', { status: 500 }))

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      headers: session.auth(),
      payload: { platform: 'douyu', input: '99999999' }
    })

    expect(response.statusCode).toBe(502)
    expect(response.json<{ error: string }>().error).toContain('查询目标失败')
  })

  it('refuses a b23.tv short link without opening it', async ({ server, session }) => {
    // The class is refused, and the sentence says which class it is rather than the generic
    // 「无法从该链接解析出直播间号」: a person who pasted a shortcut deserves to be told that the
    // shortcut is what this build does not read. Nothing is fetched — what a short link points at is
    // only knowable by opening it, and this build does not.
    stubFetch(() => biliEnvelope({ code: 0 }))

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      headers: session.auth(),
      payload: { platform: 'bilibili', input: 'https://b23.tv/av80433022' }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toContain('b23.tv')
    expect(asked).toEqual([])
  })

  it('answers 400 with the adapter’s own sentence for an input refusal', async ({ server, session }) => {
    // Verbatim, and unprefixed: the seam's input refusal is already a sentence for a person, and the one
    // thing the route must not add is the transport's 「查询目标失败：」.
    stubReply.current = async () => {
      throw new TargetRefusal(TargetRefusalKind.MissingRoom, '没有这个直播间')
    }

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      headers: session.auth(),
      payload: { platform: STUB_PLATFORM, input: 'x' }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('没有这个直播间')
  })

  it('answers 502, prefixed, when the adapter says the Platform did not answer', async ({ server, session }) => {
    stubReply.current = async () => {
      throw new TargetRefusal(TargetRefusalKind.PlatformUnanswered, '平台没有回答')
    }

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      headers: session.auth(),
      payload: { platform: STUB_PLATFORM, input: 'x' }
    })

    expect(response.statusCode).toBe(502)
    expect(response.json<{ error: string }>().error).toBe('查询目标失败：平台没有回答')
  })

  it('does not read a status that is not a number as a transport fault', async ({ server, session }) => {
    // The duck-typed fallback's own boundary: `httpStatusOf` asks for a *number*, so this error carries
    // no transport signal and its message is shown as the input problem it says it is.
    stubReply.current = async () => {
      throw new StubStringStatusError('无法解析该目标')
    }

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/targets/resolve',
      headers: session.auth(),
      payload: { platform: STUB_PLATFORM, input: 'x' }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('无法解析该目标')
  })
})
