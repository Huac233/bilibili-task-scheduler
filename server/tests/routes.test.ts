import { describe, expect } from 'vitest'

import type { BuiltServer } from '../src/index.js'
import { test as it } from './fixtures.js'

/**
 * Integration tests over the real Fastify instance via `app.inject()`.
 *
 * These exercise the whole request path — body parsing, validation, password
 * hashing, token issuance, auth gating — rather than calling handlers directly,
 * because the wiring is exactly where mistakes hide.
 *
 * Each test gets a fresh in-memory database, which is the `server` fixture's job:
 * `openDatabase` is a process-wide singleton, so closing it between cases is what
 * makes that possible.
 */

interface AuthResponse {
  ok: boolean
  token?: string
  user?: { id: number; username: string }
  error?: string
}

async function register(server: BuiltServer, username: string, password = 'password123'): Promise<AuthResponse> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password }
  })
  return response.json<AuthResponse>()
}

async function login(server: BuiltServer, username: string, password: string): Promise<AuthResponse> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password }
  })
  return response.json<AuthResponse>()
}

describe('GET /api/health', () => {
  it('reports readiness without authentication', async ({ server }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ ok: boolean }>().ok).toBe(true)
  })

  it('reports whether the sweep loop is armed, rather than a literal that is always true', async ({ server }) => {
    // `schedulerReady` was the constant `true`: an interface field asserting a fact nothing in the build
    // checked, so it stayed `true` on a process whose sweep loop had been stopped — and the container's
    // healthcheck deliberately leans on this endpoint for exactly that fact (`Dockerfile`: the scheduler
    // runs in-process, so "the HTTP server answers" is taken as "it is scheduling"). A test-built server
    // is the natural case to read it on: `scheduler.start()` is called by the entry point and never by
    // `buildServer`, so a fixture genuinely has no armed loop and the answer has to say so.
    const status = async (): Promise<boolean> => {
      const response = await server.app.inject({ method: 'GET', url: '/api/health' })
      return response.json<{ schedulerReady: boolean }>().schedulerReady
    }

    expect(await status()).toBe(false)

    server.scheduler.start()
    try {
      // Armed, so the field has something to be true *about*.
      expect(await status()).toBe(true)
    } finally {
      await server.scheduler.stop()
    }

    // And it follows the loop back down, which a literal cannot.
    expect(await status()).toBe(false)
  })
})

describe('POST /api/auth/register', () => {
  it('creates an account and returns a session token', async ({ server }) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'password123' }
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<AuthResponse>()
    expect(body.ok).toBe(true)
    expect(body.token).toBeTypeOf('string')
    expect(body.user?.username).toBe('alice')
  })

  it('never echoes the password back', async ({ server }) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'bob', password: 'password123' }
    })
    expect(response.body).not.toContain('password123')
    expect(response.body).not.toContain('passwordHash')
  })

  it('rejects a duplicate username with 409', async ({ server }) => {
    await register(server, 'carol')
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'carol', password: 'otherpassword' }
    })
    expect(response.statusCode).toBe(409)
  })

  it('answers a concurrent duplicate registration with 409, not 500', async ({ server }) => {
    // Registration checks the name, hashes the password, then inserts — and hashing is an `await`
    // (scrypt runs off the main thread), so two requests in flight at once both saw the name free.
    // Whichever lost the race used to leave the answer to SQLite's UNIQUE constraint, which is a 500
    // through the default error handler: the same condition the sequential path answers 409 for, and
    // a form double-click is the ordinary way in. The assertion is on both answers together, because
    // "no 500" alone would also pass if both requests had been refused.
    const responses = await Promise.all([
      server.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'racer', password: 'password123' }
      }),
      server.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'racer', password: 'password123' }
      })
    ])

    expect(responses.map(response => response.statusCode).sort((a, b) => a - b)).toEqual([200, 409])
    const refused = responses.find(response => response.statusCode === 409)
    // The refusal is this API's envelope, not Fastify's `{statusCode, error, message}` one.
    expect(refused?.json<AuthResponse>()).toMatchObject({ ok: false, error: '该用户名已被注册' })
  })

  it('rejects a password below the minimum length', async ({ server }) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'dave', password: 'short' }
    })
    expect(response.statusCode).toBe(400)
  })

  it('rejects an invalid username', async ({ server }) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'a', password: 'password123' }
    })
    expect(response.statusCode).toBe(400)
  })

  it('rejects a missing body', async ({ server }) => {
    const response = await server.app.inject({ method: 'POST', url: '/api/auth/register' })
    expect(response.statusCode).toBe(400)
  })

  it('accepts a Chinese username', async ({ server }) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: '测试用户', password: 'password123' }
    })
    expect(response.statusCode).toBe(200)
  })
})

describe('POST /api/auth/login', () => {
  it('issues a token for correct credentials', async ({ server }) => {
    await register(server, 'erin')
    const body = await login(server, 'erin', 'password123')
    expect(body.ok).toBe(true)
    expect(body.token).toBeTypeOf('string')
  })

  it('rejects a wrong password with 401', async ({ server }) => {
    await register(server, 'frank')
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'frank', password: 'wrongpassword' }
    })
    expect(response.statusCode).toBe(401)
  })

  it('gives the same error for an unknown user, so it is not a username oracle', async ({ server }) => {
    await register(server, 'grace')
    const unknown = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: 'password123' }
    })
    const wrongPassword = await server.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'grace', password: 'wrongpassword' }
    })

    expect(unknown.statusCode).toBe(401)
    expect(wrongPassword.statusCode).toBe(401)
    expect(unknown.json<AuthResponse>().error).toBe(wrongPassword.json<AuthResponse>().error)
  })
})

describe('GET /api/auth/me', () => {
  it('returns the user for a valid token', async ({ server }) => {
    const { token } = await register(server, 'heidi')
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${String(token)}` }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<AuthResponse>().user?.username).toBe('heidi')
  })

  it('rejects a missing header', async ({ server }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(response.statusCode).toBe(401)
  })

  it('rejects a tampered token', async ({ server }) => {
    const { token } = await register(server, 'ivan')
    const tampered = `${String(token).slice(0, -3)}xyz`
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${tampered}` }
    })
    expect(response.statusCode).toBe(401)
  })

  it('rejects a non-Bearer scheme', async ({ server }) => {
    const { token } = await register(server, 'judy')
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Basic ${String(token)}` }
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('account routes', () => {
  it('rejects listing without a token', async ({ server }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/accounts' })
    expect(response.statusCode).toBe(401)
  })

  it('lists an empty set for a fresh user', async ({ server }) => {
    const { token } = await register(server, 'karl')
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { authorization: `Bearer ${String(token)}` }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ accounts: unknown[] }>().accounts).toEqual([])
  })

  it('rejects deleting an account the user does not own', async ({ server }) => {
    const { token } = await register(server, 'laura')
    const response = await server.app.inject({
      method: 'DELETE',
      url: '/api/accounts/999',
      headers: { authorization: `Bearer ${String(token)}` }
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('Bilibili binding routes', () => {
  it('rejects an unknown QR key instead of creating a binding', async ({ server }) => {
    const { token } = await register(server, 'mallory')
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/bili/accounts/qrcode/not-a-real-key',
      headers: { authorization: `Bearer ${String(token)}` }
    })
    expect(response.statusCode).toBe(404)
  })

  it('no longer serves the Bilibili-only account list — that moved to /api/accounts', async ({ server }) => {
    const { token } = await register(server, 'nolan')
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/bili/accounts',
      headers: { authorization: `Bearer ${String(token)}` }
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('rate limiting', () => {
  it('holds the auth routes to their own budget, which only exists if the limiter loads first', async ({ server }) => {
    // The budget is declared on the route itself, and Fastify fixes a route's hook
    // chain when the route is registered — so this doubles as the test that the
    // rate limiter is loaded *before* the routes are. It was not, once: every route
    // in this service had been registered in the same synchronous block as the
    // plugin, which left 600/min and these budgets alike decorative.
    const codes: number[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nobody', password: 'password123' }
      })
      codes.push(response.statusCode)
    }

    expect(codes).toEqual([401, 401, 401, 401, 401, 429])
  })

  it('does not charge the healthcheck, which the container calls every 30s', async ({ server }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
  })
})

describe('account isolation', () => {
  it("keeps two users' sessions independent", async ({ server }) => {
    const alice = await register(server, 'user_a')
    const bob = await register(server, 'user_b')

    const aliceMe = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${String(alice.token)}` }
    })
    const bobMe = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${String(bob.token)}` }
    })

    expect(aliceMe.json<AuthResponse>().user?.username).toBe('user_a')
    expect(bobMe.json<AuthResponse>().user?.username).toBe('user_b')
  })
})
