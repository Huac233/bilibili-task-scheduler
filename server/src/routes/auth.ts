import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { hashPassword, MIN_PASSWORD_LENGTH, USERNAME_PATTERN, verifyPassword } from '../auth/password.js'
import { createSessionToken } from '../auth/token.js'
import { createUser, findUserByUsername } from '../repo/users.js'
import { type AppContext, currentUser } from './context.js'

/**
 * Account routes for *this* system.
 *
 * Bilibili's own QR login lives under `/api/bili/accounts` — keeping the two
 * apart matters because they authenticate different things: these routes issue
 * the session that protects the API, the other ones bind a Bilibili identity
 * to an already-authenticated user.
 */

/**
 * The credential pair, checked by the schema the routes declare.
 *
 * The two constraints are the same ones `auth/password.ts` documents, quoted
 * through `USERNAME_PATTERN` and `MIN_PASSWORD_LENGTH` rather than restated, so
 * the rule a password must satisfy cannot drift between the hash it produces and
 * the message the form shows. A body that is not an object at all — absent, or a
 * bare array — is caught by the object's own message, which is what this route
 * has always answered for an empty request.
 */
const credentialsSchema = z.object(
  {
    username: z
      .string({ error: '用户名需为 3-24 位中文、字母、数字或下划线' })
      .regex(USERNAME_PATTERN, '用户名需为 3-24 位中文、字母、数字或下划线'),
    password: z
      .string({ error: `密码至少需要 ${String(MIN_PASSWORD_LENGTH)} 位` })
      .min(MIN_PASSWORD_LENGTH, `密码至少需要 ${String(MIN_PASSWORD_LENGTH)} 位`)
  },
  { error: '请求体为空' }
)

type CredentialsBody = z.infer<typeof credentialsSchema>

function publicUser(user: { id: number; username: string; createdAt: number }): {
  id: number
  username: string
  createdAt: number
} {
  return { id: user.id, username: user.username, createdAt: user.createdAt }
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Creates an account and immediately returns a usable session. */
  app.post<{ Body: CredentialsBody }>(
    '/api/auth/register',
    // Registration is the cheaper abuse target, so it gets a tighter budget
    // than the global default while still allowing a shared connection.
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, schema: { body: credentialsSchema } },
    async (request: FastifyRequest<{ Body: CredentialsBody }>, reply: FastifyReply) => {
      const { username, password } = request.body

      /** This route's answer for a name that is already taken, so both checks say the same thing. */
      const usernameTaken = (): FastifyReply => reply.code(409).send({ ok: false, error: '该用户名已被注册' })

      // **The name is checked twice, and the second check is the one that decides.**
      //
      // `hashPassword` below is an `await` — scrypt runs off the main thread — so two registrations
      // racing on the same name both pass this first check and both arrive at the insert. Only one
      // of them can win, and the loser used to leave the answer to SQLite's UNIQUE constraint, which
      // arrives as a 500 from the default error handler rather than as this route's 409. Asking the
      // same question again *after* the await closes that: from that check to `createUser` there is
      // no `await` and no other route in between, so the answer cannot go stale — the row is either
      // created here or reported as taken.
      //
      // The first check stays because it is not only a race guard: it is what keeps a name somebody
      // already holds from costing a scrypt. Two checks of one fact are worth that, and they are
      // answered by one function in one sentence.
      if (findUserByUsername(ctx.db, username) !== null) return usernameTaken()

      const passwordHash = await hashPassword(password)

      if (findUserByUsername(ctx.db, username) !== null) return usernameTaken()
      const user = createUser(ctx.db, username, passwordHash)
      const token = createSessionToken(user.id, ctx.sessionSecret)

      return { ok: true, token, user: publicUser(user) }
    }
  )

  app.post<{ Body: CredentialsBody }>(
    '/api/auth/login',
    // Password guessing is the threat: a handful of attempts per minute is far
    // more than a person needs and far less than an attacker wants.
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { body: credentialsSchema } },
    async (request: FastifyRequest<{ Body: CredentialsBody }>, reply: FastifyReply) => {
      const { username, password } = request.body
      const record = findUserByUsername(ctx.db, username)

      // Deliberately identical response for "no such user" and "wrong password":
      // distinguishing them turns the endpoint into a username oracle.
      const ok = record !== null && (await verifyPassword(password, record.passwordHash))
      if (!ok) return reply.code(401).send({ ok: false, error: '用户名或密码错误' })

      const token = createSessionToken(record.id, ctx.sessionSecret)
      return { ok: true, token, user: publicUser(record) }
    }
  )

  app.get('/api/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = currentUser(request, ctx)
    if (user === null) return reply.code(401).send({ ok: false, error: '未登录或登录已失效' })
    return { ok: true, user: publicUser(user) }
  })

  /**
   * Stateless logout: the token is a signed value with no server-side session
   * table, so the client discards it. Kept as an endpoint so the frontend has
   * one call to make and can be swapped to server-side revocation later without
   * touching the client.
   */
  app.post('/api/auth/logout', async () => ({ ok: true }))
}
