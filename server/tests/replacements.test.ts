import { describe, expect } from 'vitest'

import type { BuiltServer } from '../src/index.js'
import { test as it, type Session } from './fixtures.js'

/**
 * Replacement rule routes.
 *
 * The behaviour worth pinning is the validation timing: a rule is compiled when
 * it is stored, so an invalid regex is rejected while the user is looking at the
 * form rather than being silently skipped during a send.
 */

interface RuleBody {
  ok: boolean
  rule?: { id: number; pattern: string; replacement: string; isRegex: boolean; enabled: boolean }
  rules?: { id: number; pattern: string; enabled: boolean }[]
  error?: string
}

async function post(
  server: BuiltServer,
  session: Session,
  payload: Record<string, unknown>
): Promise<{ statusCode: number; body: RuleBody }> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/replacements',
    payload,
    headers: session.auth()
  })
  return { statusCode: response.statusCode, body: response.json<RuleBody>() }
}

describe('POST /api/replacements', () => {
  it('requires authentication', async ({ server }) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/replacements',
      payload: { pattern: 'a', replacement: 'b' }
    })
    expect(response.statusCode).toBe(401)
  })

  it('creates a literal rule', async ({ server, session }) => {
    const { statusCode, body } = await post(server, session, {
      pattern: '敏感词',
      replacement: '敏感*',
      isRegex: false
    })
    expect(statusCode).toBe(200)
    expect(body.rule?.pattern).toBe('敏感词')
    expect(body.rule?.isRegex).toBe(false)
    expect(body.rule?.enabled).toBe(true)
  })

  it('creates a regex rule', async ({ server, session }) => {
    const { statusCode } = await post(server, session, { pattern: '\\d+', replacement: '#', isRegex: true })
    expect(statusCode).toBe(200)
  })

  it('rejects an invalid regex while the user is still in the form', async ({ server, session }) => {
    const { statusCode, body } = await post(server, session, { pattern: '([', replacement: 'x', isRegex: true })
    expect(statusCode).toBe(400)
    expect(body.error).toContain('正则')
  })

  it('accepts a pattern that only looks invalid as a literal', async ({ server, session }) => {
    const { statusCode } = await post(server, session, { pattern: '([', replacement: 'x', isRegex: false })
    expect(statusCode).toBe(200)
  })

  it('rejects an empty pattern', async ({ server, session }) => {
    const { statusCode } = await post(server, session, { pattern: '', replacement: 'x' })
    expect(statusCode).toBe(400)
  })

  it('rejects an over-long pattern', async ({ server, session }) => {
    const { statusCode } = await post(server, session, { pattern: 'a'.repeat(501), replacement: 'x' })
    expect(statusCode).toBe(400)
  })

  it('accepts a deletion rule (empty replacement)', async ({ server, session }) => {
    const { statusCode, body } = await post(server, session, { pattern: '删掉我', replacement: '' })
    expect(statusCode).toBe(200)
    expect(body.rule?.replacement).toBe('')
  })
})

describe('GET /api/replacements', () => {
  it('returns an empty list initially', async ({ server, session }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/replacements', headers: session.auth() })
    expect(response.json<RuleBody>().rules).toEqual([])
  })

  it('lists created rules in insertion order', async ({ server, session }) => {
    await post(server, session, { pattern: 'first', replacement: '1' })
    await post(server, session, { pattern: 'second', replacement: '2' })

    const response = await server.app.inject({ method: 'GET', url: '/api/replacements', headers: session.auth() })
    const rules = response.json<RuleBody>().rules ?? []
    expect(rules.map(rule => rule.pattern)).toEqual(['first', 'second'])
  })
})

describe('PATCH /api/replacements/:id', () => {
  it('disables and re-enables a rule', async ({ server, session }) => {
    const created = await post(server, session, { pattern: 'toggle', replacement: 'x' })
    const id = created.body.rule?.id ?? 0

    const disabled = await server.app.inject({
      method: 'PATCH',
      url: `/api/replacements/${String(id)}`,
      payload: { enabled: false },
      headers: session.auth()
    })
    expect(disabled.json<RuleBody>().rule?.enabled).toBe(false)

    const enabled = await server.app.inject({
      method: 'PATCH',
      url: `/api/replacements/${String(id)}`,
      payload: { enabled: true },
      headers: session.auth()
    })
    expect(enabled.json<RuleBody>().rule?.enabled).toBe(true)
  })

  it('rejects a non-boolean enabled value', async ({ server, session }) => {
    const created = await post(server, session, { pattern: 'x', replacement: 'y' })
    const id = created.body.rule?.id ?? 0

    const response = await server.app.inject({
      method: 'PATCH',
      url: `/api/replacements/${String(id)}`,
      payload: { enabled: 'yes' },
      headers: session.auth()
    })
    expect(response.statusCode).toBe(400)
  })

  it("returns 404 for another user's rule", async ({ server, session }) => {
    const created = await post(server, session, { pattern: 'mine', replacement: 'x' })
    const id = created.body.rule?.id ?? 0

    const other = await server.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'intruder2', password: 'password123' }
    })
    const otherToken = other.json<{ token: string }>().token

    const response = await server.app.inject({
      method: 'PATCH',
      url: `/api/replacements/${String(id)}`,
      payload: { enabled: false },
      headers: { authorization: `Bearer ${otherToken}` }
    })
    expect(response.statusCode).toBe(404)
  })

  it('answers 404 — not 400 — for a rule that does not exist, whatever the body says', async ({ server, session }) => {
    // Same ordering rule as `PATCH /api/tasks/:id`: the row is looked up before the
    // body is judged, so a missing rule is never reported as a bad request.
    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/replacements/424242',
      payload: { enabled: 'yes' },
      headers: session.auth()
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<RuleBody>().error).toBe('规则不存在')
  })
})

describe('DELETE /api/replacements/:id', () => {
  it('removes a rule', async ({ server, session }) => {
    const created = await post(server, session, { pattern: 'gone', replacement: '' })
    const id = created.body.rule?.id ?? 0

    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/api/replacements/${String(id)}`,
      headers: session.auth()
    })
    expect(removed.statusCode).toBe(200)

    const list = await server.app.inject({ method: 'GET', url: '/api/replacements', headers: session.auth() })
    expect(list.json<RuleBody>().rules).toEqual([])
  })
})
