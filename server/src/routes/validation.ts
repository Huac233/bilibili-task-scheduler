import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchemaCompiler } from 'fastify'
import { ZodError, ZodType, z } from 'zod'

/**
 * Request validation, wired into Fastify's own compiler.
 *
 * Every route in this directory used to parse its own request. Six bodies narrowed
 * `unknown` field by field; three more already declared a zod schema and wrapped it
 * in a hand-written `safeParse` guard; and the "first issue becomes a sentence"
 * helper was copied into four of those files and written inline in a fifth. What
 * replaces all of it is the compiler below, one error handler, and a `schema` in
 * each route's own options, so a request shape is declared where the route is.
 *
 * Three properties of Fastify 5 shape this file, and they are the reason it is a
 * compiler rather than a `safeParse` in each handler:
 *
 *  - **A synchronous compiler's `{ value }` replaces the request part.** With an
 *    async compiler the result is judged pass/fail and the parsed object is
 *    discarded, so the returned validator must be synchronous — which `safeParse`
 *    is. Fastify replaces `body`, `params`, `querystring` and `headers` alike.
 *  - **A validator that throws becomes a 500, not a 400.** `parse()` here would
 *    turn every malformed body into a server fault; the validator therefore
 *    returns `{ value }` or `{ error }` and never throws.
 *  - **`schema.body` is not read as JSON Schema**, so a zod instance can be
 *    passed directly and no dependency is needed to bridge the two.
 */

/**
 * The compiler itself.
 *
 * A non-zod schema is refused at *route registration*, where the stack trace
 * still names the route: silently accepting one would mean a request part that is
 * declared and never validated, which is the one failure a validator must not
 * have.
 */
export const zodCompiler: FastifySchemaCompiler<unknown> = ({ schema }) => {
  if (!(schema instanceof ZodType)) {
    throw new Error('route schemas must be zod schemas — the zod compiler does not validate anything else')
  }

  return value => {
    const result = schema.safeParse(value)
    return result.success ? { value: result.data } : { error: result.error }
  }
}

/**
 * The first schema complaint, in the language the rest of the API speaks.
 *
 * One function for the whole HTTP layer: it existed four times over when each
 * file carried its own copy of the 400 vocabulary, plus a fifth copy inline.
 */
function issueMessage(error: ZodError): string {
  return error.issues[0]?.message ?? '请求参数无效'
}

/** A refusal, in the envelope this API answers with. The one place one is built. */
function refuse(reply: FastifyReply, error: ZodError): void {
  void reply.code(400).send({ ok: false, error: issueMessage(error) })
}

/**
 * Reads a body that the route deliberately validates *after* its resource lookup,
 * or sends the 400 itself and answers null — the same shape as `requireUser`,
 * which sends the 401 and answers null.
 *
 * Only the two PATCH routes use it, and both for the same reason: Fastify checks a
 * declared schema before the handler runs, so a `PATCH /api/tasks/:id` naming a
 * task that does not exist would be told its *body* is wrong where the honest
 * answer is 404. Leaving the body out of the route's schema — rather than declaring
 * it with `attachValidation` — makes that ordering a property of the route table
 * instead of a flag somebody has to remember to set.
 */
export function requireBody<T>(schema: ZodType<T>, request: FastifyRequest, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(request.body)
  if (parsed.success) return parsed.data
  refuse(reply, parsed.error)
  return null
}

/**
 * A positive integer route parameter, refused in the route's own words.
 *
 * Replaces `intParam`'s `Number.parseInt`, which read `/api/tasks/12abc` as task
 * 12: `Number` is stricter, and a path that is not a number is now a 400 rather
 * than a request for a row nobody asked for.
 *
 * Coercion and the integer check are composed with `.pipe` because `z.int()` is a
 * schema of its own in zod 4 — the `.int()`/`.safe()` methods on `z.number()` are
 * marked *legacy* and *deprecated* respectively, as two spellings of the same
 * check, which is what this pipeline replaces.
 */
export function idParam(message: string): ZodType<number> {
  return z.coerce.number({ error: message }).pipe(z.int({ error: message }).positive(message))
}

/**
 * An integer read from the query string.
 *
 * Lenient, and deliberately so: this API promises that a malformed cursor is
 * tolerated rather than refused, and a client asking for more rows than the
 * service returns is given the ceiling. That used to be a `Number.parseInt` and
 * two `Number.isSafeInteger` guards per call site; here it is one declaration
 * that says which of those two facts applies where.
 *
 * An empty value counts as absent, because the wire has no other way to say
 * "nothing": `Number('')` is a perfectly good zero, which would otherwise turn
 * `?limit=` into "one row" at any call site whose own floor is 1.
 */
export function queryInt(options: { fallback: number; min?: number; max?: number }): ZodType<number> {
  const floor = options.min ?? Number.NEGATIVE_INFINITY
  const ceiling = options.max ?? Number.POSITIVE_INFINITY

  return z
    .preprocess(value => (value === '' ? undefined : value), z.coerce.number().pipe(z.int()))
    .transform(value => Math.min(Math.max(value, floor), ceiling))
    .catch(options.fallback)
}

/**
 * A body schema that also accepts a request carrying no body at all.
 *
 * Fastify hands an absent body through as `null`, which no object schema accepts,
 * so every route whose fields are all optional had to say "no body means an empty
 * body" for itself — once as a `z.preprocess`, twice as a `request.body ?? {}`.
 * This is that one decision, named.
 *
 * Deliberately not applied where a body has required fields: there an absent body
 * is a refusal with its own sentence, not an empty object (see `routes/auth.ts`).
 */
export function bodyOrEmpty<T extends ZodType>(schema: T) {
  return z.preprocess(value => value ?? {}, schema)
}

/**
 * Installs the compiler, and the one 400 that goes with it.
 *
 * A failed validation leaves Fastify holding the `ZodError`, and its default
 * handler renders that as `{ statusCode, code, error, message }` with the whole
 * issue list JSON-encoded into `message`. The handler below turns exactly that
 * case into this project's `{ ok: false, error }` envelope and carries the
 * schema's own Chinese sentence, which is what the frontend reads. Every other
 * error is handed back to Fastify's default handler — that is where the 500s, the
 * rate limiter's 429 and the static-plugin 404s already come from, and a
 * replacement here would have to reproduce all of them.
 *
 * Must run before the first route is registered: Fastify captures the compiler
 * per route at registration time, not per request.
 */
export function installZodValidation(app: FastifyInstance): void {
  app.setValidatorCompiler(zodCompiler)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      refuse(reply, error)
      return reply
    }
    return reply.send(error)
  })
}
