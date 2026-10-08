import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { descriptorsWithDeclarations } from '../actions/action-options.js'
import { allPlatforms, platformFor } from '../platform/registry.js'
import type { TargetInfo } from '../platform/types.js'
import { type AppContext, requireUser } from './context.js'

/**
 * The Platform catalogue, and the one route that turns pasted input into a target.
 *
 * `GET /api/platforms` is how the UI learns what exists. Without it every screen
 * would have to hardcode which Platforms and which actions this build serves, and
 * that list is exactly the thing the seam moved into the adapters — a Douyu
 * action must appear in the UI because the adapter declares it, not because
 * someone remembered to update a dropdown.
 *
 * `POST /api/targets/resolve` replaced `POST /api/rooms/resolve`. Resolving a room
 * link is Bilibili-shaped work (its host allowlist, its short-id mapping), so it
 * now lives in the adapter behind `Platform.resolveTarget` and the route only
 * decides which adapter to ask. Retiring the old route also retired
 * `extractRoomSlug`, which had the Bilibili host baked into this directory.
 *
 * Both routes require a session even though neither reads a user's rows. The whole
 * `/api` surface is session-scoped except `/api/health` and the auth endpoints,
 * and a catalogue that answers anonymously is a fingerprinting surface for no
 * benefit: the UI has a token before it draws anything.
 */

const resolveTargetSchema = z.object({
  platform: z.string({ error: '请选择平台' }).min(1, '请选择平台'),
  input: z.string({ error: '请输入直播间链接或房间号' }).min(1, '请输入直播间链接或房间号')
})

export function registerPlatformRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/platforms', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request, reply, ctx)
    if (user === null) return undefined

    // Mapped field by field rather than spread: a `Platform` carries functions
    // (`probe`, `send`, `reconcile`, `refresh`) and will grow more, and the
    // catalogue the UI reads should be exactly the catalogue — never "whatever the
    // adapter happens to expose this month". The descriptors themselves are data
    // and pass through unchanged, which is what `ActionDescriptor` is for.
    //
    // Two fields are merged in rather than passed through, and they are the exception the rule
    // above would otherwise forbid: an action's `optionFields` is the list of knobs its adapter
    // reads out of `action_settings.options`, and its `shownReads` is the list of account-level
    // reads the settings page shows beside them. Without the first, every option an action
    // understands can only be set by hand through the API; without the second, a read no option
    // field names has no way to reach the page at all. The merge is additive — a Platform that
    // declares neither passes through untouched a field at a time — and `actions/**` is where the
    // declarations live while their home in `platform/**` is being settled.
    const platforms = allPlatforms().map(platform => ({
      key: platform.key,
      label: platform.label,
      actions: descriptorsWithDeclarations(platform.key, platform.actions)
    }))

    return { ok: true, platforms }
  })

  app.post<{ Body: z.infer<typeof resolveTargetSchema> }>(
    '/api/targets/resolve',
    { schema: { body: resolveTargetSchema } },
    async (request: FastifyRequest<{ Body: z.infer<typeof resolveTargetSchema> }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const platform = platformFor(request.body.platform)
      if (platform === null) {
        return reply.code(400).send({ ok: false, error: `未知平台：${request.body.platform}` })
      }

      let target: TargetInfo
      try {
        target = await platform.resolveTarget(request.body.input.trim())
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)

        // Two kinds of failure arrive here and the status code has to tell them
        // apart: input the adapter could not make sense of (400, and its message
        // already says what was wrong), and the transport failing while asking the
        // Platform (502 — the same link may well work in a minute).
        //
        // The transport check is duck-typed on a numeric `status` rather than
        // `instanceof BiliHttpError`: this module sits above the seam, and naming one
        // Platform's error class here is precisely the coupling the seam exists to
        // remove. Any adapter whose transport error carries its HTTP status is
        // recognised; one that throws a plain Error is treated as bad input, which
        // is the direction that cannot hide a real fault behind a 400.
        return httpStatusOf(error) === null
          ? reply.code(400).send({ ok: false, error: message })
          : reply.code(502).send({ ok: false, error: `查询目标失败：${message}` })
      }

      return { ok: true, target }
    }
  )
}

/** The HTTP status an error carries, or null when it carries none. */
function httpStatusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null
  return typeof error.status === 'number' ? error.status : null
}
