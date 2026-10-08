import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Session tokens.
 *
 * Deliberately not a JWT library: the requirement is "a tamper-evident token
 * carrying a user id and an expiry", and a JWT adds base64'd JSON plus a header
 * nobody reads. This is the same construction with fewer moving parts.
 *
 * Format: `<base64url(json payload)>.<base64url(hmac-sha256)>`
 *
 * The payload is signed, not encrypted — do not put secrets in it.
 */

export interface SessionPayload {
  /** Subject: the user id. */
  readonly sub: number
  /** Expiry, seconds since epoch. */
  readonly exp: number
}

/** How long a session stays valid. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

export class TokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenError'
  }
}

function toBase64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

/** Issues a token for `userId`, expiring `ttlSeconds` from `now`. */
export function createSessionToken(
  userId: number,
  secret: string,
  nowMs: number = Date.now(),
  ttlSeconds: number = SESSION_TTL_SECONDS
): string {
  const payload: SessionPayload = {
    sub: userId,
    exp: Math.floor(nowMs / 1000) + ttlSeconds
  }
  const body = toBase64Url(JSON.stringify(payload))
  return `${body}.${sign(body, secret)}`
}

/**
 * Verifies a token and returns its payload.
 *
 * Throws `TokenError` with a specific reason so routes can distinguish "expired,
 * please log in again" from "malformed, this looks like tampering".
 */
export function verifySessionToken(token: string, secret: string, nowMs: number = Date.now()): SessionPayload {
  const parts = token.split('.')
  if (parts.length !== 2) throw new TokenError('malformed token')

  const body = parts[0]
  const signature = parts[1]
  if (body === undefined || signature === undefined || body === '' || signature === '') {
    throw new TokenError('malformed token')
  }

  const expected = sign(body, secret)
  const actualBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)

  // timingSafeEqual throws on length mismatch, so compare lengths first. The
  // length itself is not secret (it is fixed per algorithm).
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new TokenError('bad signature')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw new TokenError('payload is not JSON')
  }

  if (typeof parsed !== 'object' || parsed === null) throw new TokenError('payload is not an object')
  const candidate = parsed as { sub?: unknown; exp?: unknown }
  if (typeof candidate.sub !== 'number' || !Number.isSafeInteger(candidate.sub)) {
    throw new TokenError('payload.sub is not an integer')
  }
  if (typeof candidate.exp !== 'number' || !Number.isFinite(candidate.exp)) {
    throw new TokenError('payload.exp is not a number')
  }

  if (candidate.exp * 1000 <= nowMs) throw new TokenError('token expired')

  return { sub: candidate.sub, exp: candidate.exp }
}

/**
 * Resolves the signing secret.
 *
 * A random per-boot secret is used when `SESSION_SECRET` is unset: sessions
 * then end when the process restarts, which is the safe failure mode. Deployments
 * that want sessions to survive a restart must set the variable.
 */
export function resolveSessionSecret(env: NodeJS.ProcessEnv = process.env): { secret: string; ephemeral: boolean } {
  const configured = env['SESSION_SECRET']
  if (typeof configured === 'string' && configured.length >= 16) {
    return { secret: configured, ephemeral: false }
  }
  return { secret: randomBytes(32).toString('hex'), ephemeral: true }
}
