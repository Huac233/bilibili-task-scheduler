import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { descriptorsWithDeclarations } from '../actions/action-options.js'
import { platformAccountOf } from '../platform/account.js'
import { allPlatforms, platformFor } from '../platform/registry.js'
import { TargetRefusal, TargetRefusalKind } from '../platform/target.js'
import type { PlatformAccount, TargetInfo } from '../platform/types.js'
import { getAccount } from '../repo/accounts.js'
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
 *
 * **`resolveTarget` also takes the account the person picked, and this route is what resolves that id to a
 * row.** The lookup is user-scoped — it takes the session's `user.id` — and that is a fact the adapters
 * never see, so it belongs above the seam; what crosses is the `PlatformAccount` that `probe` and `send`
 * already take. Optional, because a resolve from a settings row may have no account behind it; when it is
 * absent the adapter is told nothing rather than handed a placeholder, and the label it produces says why.
 *
 * **How a failed resolve is reported.** The answer a person reads is this route's `error` string, drawn
 * beside the box they typed into, so the shape of the failure is decided by the adapter's own
 * `TargetRefusal` (see `platform/target.ts`) and this route only turns its three kinds into statuses:
 * the two input kinds are 400 with the adapter's sentence, the Platform's silence is 502 with the
 * transport prefix. A Platform's transport error, which carries its own HTTP status, is recognised the
 * same way it always was.
 */

const resolveTargetSchema = z.object({
  platform: z.string({ error: '请选择平台' }).min(1, '请选择平台'),
  input: z.string({ error: '请输入直播间链接或房间号' }).min(1, '请输入直播间链接或房间号'),
  /**
   * The account the person had picked when they pasted the link — optional, because a resolve driven from a
   * settings row may have none.
   *
   * It is here because Bilibili refuses the read that names a Room's Anchor to a caller with no credential
   * (`bilibili/credential.ts`'s `credentialToSessionCookies` carries the measurement), and the create-task
   * form picks the account *before* the room — so the ordinary resolve is a credentialed one, and a route
   * that could not carry the account would leave every label on its 标题. The id is the row's own, as
   * `GET /api/accounts` reports it; nothing about the credential travels back out.
   */
  accountId: z
    .number({ error: '请选择账号' })
    .pipe(z.int({ error: '账号 ID 无效' }).positive('账号 ID 无效'))
    .optional()
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

      // The account, when the body names one, and the two ways it can be wrong are both refusals rather
      // than a quiet fallback to an anonymous resolve: the person asked for a credentialed read, and a 200
      // that silently answered without the credential is the same lie the label's own note exists to
      // prevent. Both sentences are `routes/tasks.ts`'s, and the statuses are too — a missing row is 404,
      // and an account on another Platform is 400 because the request cannot be honoured at all.
      let account: PlatformAccount | undefined
      if (request.body.accountId !== undefined) {
        const row = getAccount(ctx.db, user.id, request.body.accountId)
        if (row === null) return reply.code(404).send({ ok: false, error: '账号不存在' })

        if (row.platform !== platform.key) {
          return reply.code(400).send({ ok: false, error: `账号不属于平台「${platform.label}」` })
        }

        account = platformAccountOf(ctx.db, row)
      }

      let target: TargetInfo
      try {
        target = await platform.resolveTarget(request.body.input.trim(), account)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)

        // Three kinds of failure arrive here, and this reply is where a person reads them: the page
        // renders `error` **next to the box they typed into**. `TargetRefusal` is the seam's own word
        // for a refusal that is about their paste — `unreadable_input` (not a shape this Platform reads
        // a target out of) and `missing_room` (the shape is right and the thing is not there) are both
        // 400 with the adapter's own sentence, because both are fixed by typing differently, and they
        // are two kinds rather than one because those two sentences have to stay tellable apart.
        // `platform_unanswered` is the third and the only one that is the Platform's doing: 502, the
        // same answer a transport fault gets, because the same paste may well work in a minute.
        if (error instanceof TargetRefusal) {
          return error.kind === TargetRefusalKind.PlatformUnanswered
            ? reply.code(502).send({ ok: false, error: `${TARGET_LOOKUP_FAILED}${message}` })
            : reply.code(400).send({ ok: false, error: message })
        }

        // An adapter that does not use that vocabulary still gets its transport faults recognised.
        // The check is duck-typed on a numeric `status` rather than `instanceof BiliHttpError`: this
        // module sits above the seam, and naming one Platform's error class here is precisely the
        // coupling the seam exists to remove. Any adapter whose transport error carries its HTTP status
        // is recognised; one that throws a plain Error is treated as bad input, which is the direction
        // that cannot hide a real fault behind a 400.
        return httpStatusOf(error) === null
          ? reply.code(400).send({ ok: false, error: message })
          : reply.code(502).send({ ok: false, error: `${TARGET_LOOKUP_FAILED}${message}` })
      }

      return { ok: true, target }
    }
  )
}

/**
 * The one prefix a transport failure's sentence gets, written once.
 *
 * It belongs to *this* route rather than to either adapter, because it is the route that knows the
 * failure is the transport's: an adapter reports what its own call did, and this marks that as something
 * other than the person's typing. `TargetRefusal`'s input kinds never get it.
 */
const TARGET_LOOKUP_FAILED = '查询目标失败：'

/** The HTTP status an error carries, or null when it carries none. */
function httpStatusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null
  return typeof error.status === 'number' ? error.status : null
}
