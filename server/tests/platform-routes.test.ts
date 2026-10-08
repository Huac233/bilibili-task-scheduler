import { beforeEach, describe, expect } from 'vitest'
import type { BuiltServer } from '../src/index.js'
import { allPlatforms, registerPlatform } from '../src/platform/registry.js'
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
