import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import {
  completeBind,
  DouyuBindSessionStore,
  generateCode,
  PassportHttp,
  pollScan,
  qrCodeDataOf,
  qrLifetimeMs,
  refusalText,
  SCAN_DONE,
  scanStateOf,
  storePastedCredential
} from '../platform/douyu/passport.js'
import { type AppContext, PollSingleFlight, requireUser } from './context.js'

/**
 * Douyu account binding: the scan handshake, plus the paste path the accounts view
 * already ships.
 *
 * The QR half mirrors `/api/bili/accounts/qrcode*` call for call — start returns a
 * URL to render, the poll returns a state and, on success, the stored account — so
 * the frontend needs no second vocabulary for the same gesture. One difference is
 * deliberate and is the reason this file exists at all: the Douyu flow's poll lands
 * a **web session** as well as a token, which is what `HANDOFF.md` §4 measured the
 * `www.douyu.com/japi/*` family (钓鱼 / 粉丝家园 / 等级任务) requiring, and
 * `completeBind` is what keeps it.
 *
 * The paste half is one route for a credential a person already holds. It is not a
 * second-class citizen of the module — both paths write through the same serializer
 * and the same parser — but it is the fallback, and the scan is the flow the product
 * asks for: a password never passes through this service, and the paste form takes a
 * token, not a password.
 *
 * A bind session needs one continuous cookie jar, and two people scanning at once
 * must not share one, so sessions are held in memory keyed by the QR `code` and are
 * checked against the caller before anything is polled — the same reasoning (and the
 * same 404 on a key that is not yours) as the Bilibili routes. `context.ts`'s
 * `LoginSessionStore` cannot be borrowed for it: it is typed to `BiliHttp`.
 *
 * **Nothing here returns or logs a credential.** No handler touches the composite
 * token, the device id or the cookie jar: they are assembled inside
 * `platform/douyu/passport.ts` and go straight into the account row. The success
 * shapes carry an `Account`, which `repo/accounts.ts` already defines without its
 * credential blob — the property is inherited rather than re-asserted, which is why
 * this module can promise it.
 */

/**
 * The pasted credential, field for field the blob the adapter parses.
 *
 * `token` and `did` are required because the adapter cannot read a blob without
 * them — there is no device id to be had from a token, and the socket refuses to
 * work without one. `webCookies` is optional: the accounts view sends it only when
 * a person typed one, and the two spellings of "no jar" (absent, or empty) collapse
 * to the same blob, because the adapter reads an absent jar as `''` anyway.
 */
const pastedCredentialSchema = z.object({
  token: z.string({ error: '请填写 composite token' }).min(1, '请填写 composite token'),
  did: z.string({ error: '请填写设备号（did）' }).min(1, '请填写设备号（did）'),
  webCookies: z.string({ error: 'web cookie 无效' }).optional()
})

export function registerDouyuRoutes(app: FastifyInstance, ctx: AppContext): void {
  const sessions = new DouyuBindSessionStore()
  /** One poll at a time per key: see `PollSingleFlight` for why the store cannot do this itself. */
  const polls = new PollSingleFlight()

  /** Starts a binding: returns the QR content to render, and the key the poll uses. */
  app.post('/api/douyu/accounts/qrcode', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request, reply, ctx)
    if (user === null) return undefined

    const http = new PassportHttp()
    const result = await generateCode(http)
    const data = qrCodeDataOf(result)

    if (data === null) {
      return reply.code(502).send({
        ok: false,
        error: result.error === SCAN_DONE ? '斗鱼返回了二维码，但响应形状与预期不符，请重试' : refusalText(result)
      })
    }

    // The deadline comes from the code's own `expire`, so the session and the
    // service agree about when this attempt is over instead of polling a code the
    // service has already forgotten. The store keeps its own `Date.now()`, per the
    // split `routes/context.ts` documents: a session's TTL is bookkeeping, while the
    // `ctx.now()` below is "when this request happened".
    sessions.create(data.code, user.id, http, qrLifetimeMs(data.expire))

    return { ok: true, url: data.url, key: data.code }
  })

  /**
   * Polls a binding once. On success the scan is completed and the account is
   * written; the session is then dropped, because a code is single-use.
   *
   * A missing or foreign session is a 404 rather than a 403: the answer must not
   * tell a caller whether a guessed key exists.
   *
   * **"Single-use" has to hold against two polls, not just two scans.** The code is spent by the
   * landing hop below, and that hop is the slowest step in the flow, so a second poll that arrives
   * while it is out — the client asks every two seconds with no in-flight marker — would land it a
   * second time. `sessions.get` cannot stop that (it is a read, and the session is dropped only
   * after the awaits), so the key is claimed for the duration of this handler and a duplicate is
   * answered from where the first one still is rather than by asking the Platform again.
   */
  app.get<{ Params: { key: string } }>(
    '/api/douyu/accounts/qrcode/:key',
    async (request: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const key = request.params.key
      const session = sessions.get(key)

      if (session === null || session.userId !== user.id) {
        return reply.code(404).send({ ok: false, error: '二维码已失效，请重新生成' })
      }

      // `pending` rather than an error: the flow is still exactly where the first request left it,
      // and an error status would end the dialog's polling over a collision nobody can avoid.
      if (!polls.begin(key)) return { ok: true, state: 'pending', message: '' }

      try {
        const poll = await pollScan(session.http, key)
        const state = scanStateOf(poll)

        // `pending | scanned | expired` all keep the session: only `success` consumes
        // the code, and an expired one is still the frontend's answer to render until
        // the session's own deadline removes it.
        if (state !== 'success') {
          return { ok: true, state, message: poll.msg ?? '' }
        }

        const outcome = await completeBind(ctx.db, user.id, session.http, poll, ctx.now())
        if (!outcome.ok) {
          // The code is spent either way — the scan was confirmed, so polling again
          // would only be told the same thing. Dropping the session is what makes the
          // UI offer a fresh code instead of looping on a dead one.
          sessions.remove(key)
          return reply.code(502).send({ ok: false, error: outcome.error })
        }

        sessions.remove(key)
        // Drop any cached client so the next request reads the fresh credential. The
        // cache is keyed by account id, and a re-bind updates a row in place.
        ctx.forgetAccountClient(outcome.account.id)

        return { ok: true, state: 'success', account: outcome.account }
      } finally {
        polls.end(key)
      }
    }
  )

  /**
   * Binds a credential a person pasted.
   *
   * A credential the adapter cannot parse is a 400 and not a 502: the request is
   * what is wrong, and nothing upstream was asked. Re-binding an account already
   * bound updates it in place, which keeps a task's `account_id` meaningful across
   * a re-auth.
   */
  app.post<{ Body: z.infer<typeof pastedCredentialSchema> }>(
    '/api/douyu/accounts',
    { schema: { body: pastedCredentialSchema } },
    async (request: FastifyRequest<{ Body: z.infer<typeof pastedCredentialSchema> }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const outcome = storePastedCredential(ctx.db, user.id, request.body, ctx.now())
      if (!outcome.ok) {
        return reply.code(400).send({ ok: false, error: outcome.error })
      }

      ctx.forgetAccountClient(outcome.account.id)
      return { ok: true, account: outcome.account }
    }
  )
}
