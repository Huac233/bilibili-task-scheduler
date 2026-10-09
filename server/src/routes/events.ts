import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { countTokens, createApiToken, listApiTokens, MAX_TOKENS_PER_USER, revokeApiToken } from '../repo/api-tokens.js'
import { EventKind, latestEventId, listEventsSince, listRecentEvents } from '../repo/events.js'
import { type AppContext, requireUser } from './context.js'
import { bodyOrEmpty, idParam, queryInt } from './validation.js'

/**
 * External integration surface.
 *
 * A notification bridge (the AstrBot plugin) needs two things: a durable
 * credential, and a way to ask "what happened since I last asked". Both live
 * here.
 *
 * The event endpoint is cursor-based on purpose. Handing a consumer a snapshot
 * of current state would push the diffing — and the "did I miss a transition
 * between two polls" problem — onto every consumer. A monotonic id makes
 * at-least-once delivery trivial to implement on their side.
 */

const DEFAULT_EVENT_LIMIT = 100
const MAX_EVENT_LIMIT = 500

/**
 * The token name, the only field this route takes.
 *
 * Every field is optional, so an absent body is a legitimate request — a caller
 * that just wants a token — which is the one fact `bodyOrEmpty` states, for this
 * route and every other shaped like it. The name is normalized in the handler
 * rather than here, because being longer than the cap is a caller asking for a
 * *label*, not for a refusal.
 */
const createTokenSchema = bodyOrEmpty(z.object({ name: z.string({ error: '令牌名称无效' }).optional() }))

const listEventsQuery = z.object({
  since: queryInt({ fallback: 0, min: 0 }),
  // Bounded here rather than left to the store, unlike every other paging knob in
  // this file: `hasMore` is computed against the limit this route is holding, so a
  // limit the store quietly shrank would make the last page claim there is more.
  limit: queryInt({ fallback: DEFAULT_EVENT_LIMIT, min: 1, max: MAX_EVENT_LIMIT })
})

/**
 * The kinds a caller wants, as the page's filter sends them: one comma separated value.
 *
 * Two spellings arrive here and only one is ours — `IntegrationsView` joins its ticked kinds with
 * commas, and Fastify hands *repeated* `kinds=` parameters through as an array, which is what
 * somebody probing by hand writes. Both become the same list.
 *
 * **Absent is "no filter" and present-but-empty is "none of them"**, and they must stay different
 * requests. Absent is what a caller with no opinion sends, and must keep seeing the whole feed;
 * `?kinds=` is an owner who unticked every box, and answering that with everything would show him
 * the noise he just hid. `queryInt` reads an empty value as absent for the opposite reason — a
 * number's zero and its absence are the same wire value, and here they are not.
 *
 * An unknown name is refused rather than dropped: a dropped one answers with a feed that quietly
 * excludes what was asked for, which reads as "nothing happened" rather than as a bad request.
 */
function splitKinds(value: unknown): unknown {
  if (value === undefined) return undefined
  return (Array.isArray(value) ? value : [value])
    .filter((part): part is string => typeof part === 'string')
    .flatMap(part => part.split(','))
    .map(part => part.trim())
    .filter(part => part !== '')
}

const kindsQuery = z.preprocess(splitKinds, z.array(z.enum(EventKind, { error: '事件类型无效' }))).optional()

const recentEventsQuery = z.object({ limit: queryInt({ fallback: 50 }), kinds: kindsQuery })

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Events after a cursor, oldest first.
   *
   * `nextCursor` is returned so a consumer never has to reason about which id
   * to remember; it can store whatever this says and pass it back verbatim.
   */
  app.get<{ Querystring: z.infer<typeof listEventsQuery> }>(
    '/api/events',
    { schema: { querystring: listEventsQuery } },
    async (request: FastifyRequest<{ Querystring: z.infer<typeof listEventsQuery> }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const { since, limit } = request.query

      const events = listEventsSince(ctx.db, user.id, since, limit)
      const last = events.at(-1)

      return {
        ok: true,
        events,
        nextCursor: last?.id ?? since,
        latestId: latestEventId(ctx.db, user.id),
        hasMore: events.length === limit
      }
    }
  )

  /**
   * Newest-first view for the in-app activity panel, and the only route the page's own kind filter
   * touches.
   *
   * **The filter is not on `GET /api/events`, and that is a decision rather than an omission.** The
   * AstrBot plugin polls that route with a cursor, so narrowing it would not merely change what the
   * plugin receives: the cursor would walk past the kinds it was not shown, and the retention window
   * would then delete them — a lost notification, for a filter that was meant to tidy a page. The
   * choice therefore belongs to the caller that made it, and travels as `kinds` on this request.
   */
  app.get<{ Querystring: z.infer<typeof recentEventsQuery> }>(
    '/api/events/recent',
    { schema: { querystring: recentEventsQuery } },
    async (request: FastifyRequest<{ Querystring: z.infer<typeof recentEventsQuery> }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const { limit, kinds } = request.query

      return { ok: true, events: listRecentEvents(ctx.db, user.id, limit, kinds) }
    }
  )

  /** Lists API tokens. Never includes the tokens themselves. */
  app.get('/api/tokens', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request, reply, ctx)
    if (user === null) return undefined

    return { ok: true, tokens: listApiTokens(ctx.db, user.id), limit: MAX_TOKENS_PER_USER }
  })

  /**
   * Issues a token. The plaintext appears exactly once, here.
   */
  app.post<{ Body: z.infer<typeof createTokenSchema> }>(
    '/api/tokens',
    { schema: { body: createTokenSchema } },
    async (request: FastifyRequest<{ Body: z.infer<typeof createTokenSchema> }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      if (countTokens(ctx.db, user.id) >= MAX_TOKENS_PER_USER) {
        return reply.code(400).send({ ok: false, error: `API 令牌已达上限（${String(MAX_TOKENS_PER_USER)} 个）` })
      }

      const rawName = request.body.name
      const name = rawName === undefined || rawName.trim() === '' ? '未命名令牌' : rawName.trim().slice(0, 60)

      const issued = createApiToken(ctx.db, user.id, name)
      return {
        ok: true,
        // Shown once; the client must store it now.
        token: issued.token,
        record: issued.record
      }
    }
  )

  app.delete<{ Params: { id: number } }>(
    '/api/tokens/:id',
    { schema: { params: z.object({ id: idParam('无效的令牌 ID') }) } },
    async (request: FastifyRequest<{ Params: { id: number } }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const tokenId = request.params.id

      if (!revokeApiToken(ctx.db, user.id, tokenId)) {
        return reply.code(404).send({ ok: false, error: '令牌不存在' })
      }
      return { ok: true }
    }
  )
}
