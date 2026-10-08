import type { DatabaseSync } from 'node:sqlite'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ChoiceSourceRegistry } from '../actions/action-options.js'
import { TokenError, verifySessionToken } from '../auth/token.js'
import type { BiliHttp } from '../bilibili/http.js'
import { BiliHttp as BiliHttpClass, CookieJar } from '../bilibili/http.js'
import type { WbiKeyStore } from '../bilibili/live.js'
import { resolveApiToken } from '../repo/api-tokens.js'
import { getAccountCookiesById } from '../repo/bili-accounts.js'
import { findUserById, type User } from '../repo/users.js'
import type { TargetFactRegistry } from './action-settings.js'

/**
 * Shared request context.
 *
 * Passed explicitly into every route registrar rather than stashed on the
 * Fastify instance: a plain object makes the dependency surface obvious, and
 * avoids `decorate` + module augmentation just to read the database handle.
 */
export interface AppContext {
  readonly db: DatabaseSync
  readonly sessionSecret: string
  /**
   * The HTTP layer's clock, as a function rather than a `Date.now()` call.
   *
   * Read once per request that needs a timestamp, so a route can be asked "what does
   * this look like at that instant" without reaching for the global clock. The only
   * caller today is the task payload's Platform-day boundary — `settledTodayKeys`
   * depends on *which day it is*, and a value derived from a hidden global clock is a
   * fact a test cannot fix, only orbit. `buildServer` defaults this to `Date.now`, so
   * production is unchanged and a test can pass a clock that stands still.
   */
  readonly now: () => number
  readonly wbi: WbiKeyStore
  /**
   * Builds a cookie-bearing Bilibili client for a bound account, or null when
   * the account row is gone or its credential is unreadable.
   *
   * Instances are cached per account id so the cookie jar is shared between
   * requests instead of being rebuilt (and re-parsed) on every call.
   */
  readonly httpForAccount: (accountId: number) => BiliHttp | null
  /** Drops a cached client, forcing its cookies to be re-read from the database. */
  readonly forgetAccountClient: (accountId: number) => void
  /** Per-login-flow clients for the QR binding handshake, keyed by `qrcode_key`. */
  readonly loginSessions: LoginSessionStore
  /**
   * Where a choice-backed option field's choices come from.
   *
   * On the context rather than reached for directly, because the reads it holds talk to a Platform
   * and a suite must be able to answer without one: `GET /api/action-settings/options` asks this,
   * and a test hands `buildServer` a registry whose sources are fixtures. Nothing else in the app
   * reads it — an option's value reaches an action through `action_settings`, never through here.
   */
  readonly choiceSources: ChoiceSourceRegistry
  /**
   * What a Platform can read about one **Target**, for a page standing in front of one Task.
   *
   * The sibling of `choiceSources` and on the context for the same reason, but it answers a different
   * shape for a different reader: a choice is *stored* and must mean the same thing for every Task
   * naming its action, while a fact about a Room is read live for the Room in front of a person and is
   * stored nowhere — which is why this one is handed the Target and that one is not.
   */
  readonly targetFacts: TargetFactRegistry
}

/** A pending QR binding flow. */
export interface LoginSession {
  readonly http: BiliHttp
  readonly userId: number
  readonly createdAt: number
}

/**
 * Holds in-flight QR logins.
 *
 * Each flow needs its own cookie jar: the poll response sets cookies, and two
 * users scanning at the same time must not share them. Entries expire so an
 * abandoned scan does not pin memory forever.
 *
 * **Its `now` parameters are deliberately *not* `ctx.now`.** They are TTL bookkeeping
 * for a store — the same kind of clock as `repo/`'s `now` parameters and the
 * scheduler's `tick(now)`, both of which keep their own `Date.now()` defaults — not
 * "what instant is this request happening at", which is what `AppContext.now` is for.
 * The two look alike and are not the same thing, so please do not "unify" them: a test
 * that needs to control session expiry should inject a TTL or a clock *at construction*
 * here, and sharing one source between a store's expiry arithmetic and a request's
 * timestamp is how a change to one starts silently moving the other.
 */
export class LoginSessionStore {
  private readonly sessions = new Map<string, LoginSession>()

  constructor(private readonly ttlMs: number = 5 * 60 * 1000) {}

  create(key: string, userId: number, http: BiliHttp, now = Date.now()): void {
    this.sweep(now)
    this.sessions.set(key, { http, userId, createdAt: now })
  }

  get(key: string, now = Date.now()): LoginSession | null {
    const session = this.sessions.get(key)
    if (session === undefined) return null
    if (now - session.createdAt > this.ttlMs) {
      this.sessions.delete(key)
      return null
    }
    return session
  }

  remove(key: string): void {
    this.sessions.delete(key)
  }

  private sweep(now: number): void {
    for (const [key, session] of this.sessions) {
      if (now - session.createdAt > this.ttlMs) this.sessions.delete(key)
    }
  }
}

/**
 * One poll at a time, per key.
 *
 * A QR poll is not a read: the poll that reports `success` spends the code, by landing the
 * redirect the service answered with and reading the credential off the jar that flow has been
 * carrying. The browser polls on a fixed interval with no in-flight marker, so any poll slower
 * than that interval — the successful one is the slow one, it makes two more calls — overlaps the
 * next, and the same code is driven twice from two different requests.
 *
 * The session store cannot prevent that on its own: `get` is a read, and the session is dropped
 * only after the awaits have returned. So the route claims the key for the duration of its poll
 * and answers a duplicate from the state the claim is in, rather than asking the Platform again.
 * It lives here rather than inside either session store because there are two of those (this
 * module's `LoginSessionStore`, and `platform/douyu/passport.ts`'s own) and the rule is the same
 * for both.
 */
export class PollSingleFlight {
  private readonly inFlight = new Set<string>()

  /** True when this caller now holds the key; false when another poll already does. */
  begin(key: string): boolean {
    if (this.inFlight.has(key)) return false
    this.inFlight.add(key)
    return true
  }

  /** Releases the claim. Belongs in a `finally`: a poll that throws must not lock the flow out. */
  end(key: string): void {
    this.inFlight.delete(key)
  }
}

/** Rebuilds a client from stored cookies. */
export function clientFromStoredCookies(cookiesJson: string): BiliHttp | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(cookiesJson)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const cookies: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') cookies[key] = value
  }

  return new BiliHttpClass({ cookies: CookieJar.fromJSON(cookies) })
}

/** Creates the account-client factory plus its cache. */
export function createAccountClientFactory(db: DatabaseSync): {
  httpForAccount: (accountId: number) => BiliHttp | null
  forgetAccountClient: (accountId: number) => void
} {
  const cache = new Map<number, BiliHttp>()

  return {
    httpForAccount: (accountId: number): BiliHttp | null => {
      const cached = cache.get(accountId)
      if (cached !== undefined) return cached

      const cookiesJson = getAccountCookiesById(db, accountId)
      if (cookiesJson === null) return null

      const client = clientFromStoredCookies(cookiesJson)
      if (client === null) return null

      cache.set(accountId, client)
      return client
    },
    forgetAccountClient: (accountId: number): void => {
      cache.delete(accountId)
    }
  }
}

/**
 * Resolves the authenticated user from the `Authorization: Bearer` header.
 *
 * Two credential kinds are accepted, tried in order:
 *
 *   1. **Session tokens** — signed, self-describing, and short-lived. Verifying
 *      one is pure computation.
 *   2. **API tokens** — opaque random strings, looked up by hash. These are what
 *      an unattended notification bridge uses, since it cannot re-login.
 *
 * Returns null for every failure mode — malformed header, bad signature,
 * expired session, unknown token, or a user row that no longer exists — because
 * the caller cannot act differently on them and distinguishing would leak
 * whether a user id exists.
 */
export function currentUser(request: FastifyRequest, ctx: AppContext): User | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null

  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const token = match?.[1]
  if (token === undefined || token === '') return null

  try {
    const payload = verifySessionToken(token, ctx.sessionSecret)
    return findUserById(ctx.db, payload.sub)
  } catch (error: unknown) {
    // A session-shaped failure just means "not a session token"; anything else
    // is a real error. `resolveApiToken` then gets its turn.
    if (!(error instanceof TokenError)) throw error
  }

  const apiToken = resolveApiToken(ctx.db, token)
  return apiToken === null ? null : findUserById(ctx.db, apiToken.userId)
}

/**
 * Gate for authenticated routes.
 *
 * Sends the 401 itself and returns null so the handler can `return` immediately;
 * this keeps every protected handler to a single line of boilerplate instead of
 * a try/catch around a middleware.
 */
export function requireUser(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): User | null {
  const user = currentUser(request, ctx)
  if (user === null) {
    void reply.code(401).send({ ok: false, error: '未登录或登录已失效' })
    return null
  }
  return user
}
