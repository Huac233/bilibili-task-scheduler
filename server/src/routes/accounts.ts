import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { type Account, deleteAccount, listAccounts } from '../repo/accounts.js'
import { type AppContext, requireUser } from './context.js'
import { idParam } from './validation.js'

/**
 * Bound-account routes, across every Platform.
 *
 * These moved here from `/api/bili/*`, which now carries only the QR handshake
 * that is genuinely Bilibili-specific. Listing and unbinding are not: an account
 * row is (person, Platform, external id) plus an opaque credential blob, so one
 * endpoint serves every Platform and the UI needs no per-Platform branch.
 *
 * **Credentials never leave through here.** `repo/accounts.ts` already omits the
 * blob from its list/get shapes; `publicAccountOf` below re-states the response
 * field by field anyway, so "the response has no credentials" is a property of
 * this file rather than something a future store change could undo. `meta` is
 * dropped for the same reason — it is platform-shaped and may hold a device id.
 */

/** The account as the UI sees it: identifiers and a display name, nothing secret. */
interface PublicAccount {
  readonly id: number
  readonly platform: string
  readonly displayName: string
  readonly avatar: string
  readonly externalId: string
  readonly createdAt: number
}

function publicAccountOf(account: Account): PublicAccount {
  return {
    id: account.id,
    platform: account.platform,
    displayName: account.displayName,
    avatar: account.avatar,
    externalId: account.externalId,
    createdAt: account.createdAt
  }
}

export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Lists the caller's bound accounts. Never includes credentials. */
  app.get('/api/accounts', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request, reply, ctx)
    if (user === null) return undefined

    return { ok: true, accounts: listAccounts(ctx.db, user.id).map(publicAccountOf) }
  })

  /** Unbinds an account. Cascades to its tasks through the foreign key. */
  app.delete<{ Params: { id: number } }>(
    '/api/accounts/:id',
    { schema: { params: z.object({ id: idParam('无效的账号 ID') }) } },
    async (request: FastifyRequest<{ Params: { id: number } }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const accountId = request.params.id

      // Scoped by the caller, so another user's id 404s rather than unbinding.
      if (!deleteAccount(ctx.db, user.id, accountId)) {
        return reply.code(404).send({ ok: false, error: '账号不存在' })
      }

      // The client cache is keyed by account id and holds a live session for it,
      // so deleting the row without dropping the client would leave requests being
      // served from an in-memory credential that no longer exists on disk.
      ctx.forgetAccountClient(accountId)
      return { ok: true }
    }
  )
}
