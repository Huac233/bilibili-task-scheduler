import { describe, expect, it } from 'vitest'

import { resolveSessionSecret } from '../src/auth/token.js'
import { sessionSecretWarning } from '../src/index.js'

/**
 * The failure these cover is a quiet one, and it was observed rather than
 * imagined: with `SESSION_SECRET` unset the server signs a random key per boot,
 * so every restart signs every browser session out. Nothing breaks loudly — a
 * person just logs in again and again and eventually suspects the login itself.
 *
 * `server/src/env.ts` is what puts the variable in the environment, and it is a
 * side-effect module, so it is verified by running the server rather than here:
 * a unit test of an import's side effect tests the import, not the load.
 */
describe('resolving the session signing secret', () => {
  it('uses a configured secret, and says it is not ephemeral', () => {
    const resolved = resolveSessionSecret({ SESSION_SECRET: 'a'.repeat(16) })

    expect(resolved.ephemeral).toBe(false)
    expect(resolved.secret).toBe('a'.repeat(16))
  })

  it('generates one per call when nothing is configured, and marks it ephemeral', () => {
    const first = resolveSessionSecret({})
    const second = resolveSessionSecret({})

    expect(first.ephemeral).toBe(true)
    expect(second.ephemeral).toBe(true)
    // Two boots, two different keys — which is exactly what invalidates every
    // session on restart. Pinned so that "generate once per process" cannot be
    // mistaken for a fix: it would still lose the sessions.
    expect(first.secret).not.toBe(second.secret)
  })

  it('generates a long secret of its own rather than reusing a short one', () => {
    const resolved = resolveSessionSecret({ SESSION_SECRET: 'short' })

    expect(resolved.ephemeral).toBe(true)
    expect(resolved.secret.length).toBeGreaterThanOrEqual(16)
    expect(resolved.secret).not.toBe('short')
  })

  it.for([
    ['', 'empty'],
    ['               ', 'spaces'],
    ['x'.repeat(15), 'one short of the bound']
  ] as const)('treats an unusable configured value as unset: %s', ([value], { expect }) => {
    const resolved = resolveSessionSecret({ SESSION_SECRET: value })

    expect(resolved.ephemeral).toBe(true)
    expect(resolved.secret).not.toBe(value)
  })

  it('reads the process environment by default, so a shell export is enough', () => {
    const previous = process.env['SESSION_SECRET']
    process.env['SESSION_SECRET'] = 'a-secret-from-the-environment'
    try {
      expect(resolveSessionSecret()).toEqual({ secret: 'a-secret-from-the-environment', ephemeral: false })
    } finally {
      if (previous === undefined) delete process.env['SESSION_SECRET']
      else process.env['SESSION_SECRET'] = previous
    }
  })
})

/**
 * The sentence beside that behaviour.
 *
 * The two halves of "the configured key is not the one being used" were described as one thing, and
 * it was the wrong one: a deployment that set a 15-character `SESSION_SECRET` was told the variable
 * "is not set", which sends whoever reads the log to look at an environment variable that is right
 * there. The behaviour above is deliberate and stays; what is pinned here is that the sentence names
 * the case it is actually in.
 */
describe('the warning an ephemeral session key produces', () => {
  it('never describes a value that exists as one that does not', () => {
    // The branch the resolver takes is what "ephemeral" means, so the assertion starts there rather
    // than from a hand-written expectation: a value the resolver refuses is exactly the case that
    // must not be reported as unset.
    expect(resolveSessionSecret({ SESSION_SECRET: 'x'.repeat(15) }).ephemeral).toBe(true)
    expect(sessionSecretWarning('x'.repeat(15))).not.toContain('not set')
    expect(sessionSecretWarning('x'.repeat(15))).toContain('too short')

    // And the genuinely absent case still says so, so the fix cannot be "stop mentioning it".
    expect(sessionSecretWarning(undefined)).toContain('not set')
  })
})
