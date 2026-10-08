import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { checkLogin, completeLogin, generateQrCode, pollQrCode, scanStateOf } from '../bilibili/auth.js'
import { credentialToCookies, isCredentialComplete } from '../bilibili/credential.js'
import { BiliHttp, CookieJar } from '../bilibili/http.js'
import { upsertAccount } from '../repo/bili-accounts.js'
import { type AppContext, PollSingleFlight, requireUser } from './context.js'

/**
 * Bilibili account binding: the QR handshake, and nothing else.
 *
 * Account listing and unbinding moved to `/api/accounts`, which is
 * platform-neutral — a bound Douyu account is the same shape of row, so it had no
 * business on a Bilibili-only path. What stays here is what is genuinely
 * Bilibili's: the two-step scan, whose second response carries the session
 * cookies.
 *
 * The QR handshake needs three calls against one continuous cookie jar (the
 * poll response carries the session cookies), and a jar is per-flow — two users
 * scanning simultaneously must not share one. `ctx.loginSessions` holds those
 * jars keyed by `qrcode_key`, and each poll verifies the session belongs to the
 * caller so one user cannot complete another's login.
 */

export function registerBiliRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** One poll at a time per `qrcode_key`: see `PollSingleFlight` for why that matters here. */
  const polls = new PollSingleFlight()

  /** Starts a binding: returns a URL to render as a QR code. */
  app.post('/api/bili/accounts/qrcode', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request, reply, ctx)
    if (user === null) return undefined

    const http = new BiliHttp({ cookies: new CookieJar() })
    const result = await generateQrCode(http)

    if (result.code !== 0) {
      return reply.code(502).send({
        ok: false,
        error: result.message ?? result.msg ?? `生成二维码失败（code ${String(result.code)}）`
      })
    }

    const key = result.data.qrcode_key
    ctx.loginSessions.create(key, user.id, http)

    return { ok: true, url: result.data.url, key }
  })

  /**
   * Polls a binding attempt. On success, extracts the credential, reads the
   * profile from `/nav`, and upserts the account row.
   */
  app.get<{ Params: { key: string } }>(
    '/api/bili/accounts/qrcode/:key',
    async (request: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const key = request.params.key
      const session = ctx.loginSessions.get(key)

      // A missing session means the flow expired or was never started. The
      // ownership check stops a guessed key from completing someone else's bind.
      if (session === null || session.userId !== user.id) {
        return reply.code(404).send({ ok: false, error: '二维码已失效，请重新生成' })
      }

      // **A poll already in flight owns this key, and the second request must not ask the
      // Platform again.** The client asks on a fixed interval, so an overlapping poll is ordinary
      // rather than exotic — and the poll that answers `success` spends the code, which is why two
      // of them must not both reach it. The duplicate is answered with `pending`: the flow *is*
      // still in the state the first request set out to resolve, and the answer a person sees is
      // the one they were already looking at. Refusing it as an error would stop the dialog's
      // polling (`AccountsView.vue` treats a thrown poll as the end of the flow) over a collision
      // it can neither cause nor avoid.
      if (!polls.begin(key)) return { ok: true, state: 'pending', message: '' }

      try {
        const poll = await pollQrCode(session.http, key)
        const state = scanStateOf(poll.data)

        if (state !== 'success') {
          return { ok: true, state, message: poll.data.message }
        }

        const credential = await completeLogin(session.http, poll.data, poll.data.refresh_token)
        if (!isCredentialComplete(credential)) {
          return reply.code(502).send({
            ok: false,
            error: '扫码已确认，但未能取得完整凭据，请重试'
          })
        }

        // Best-effort profile lookup: a failure here should not lose the binding.
        let uname = ''
        let face = ''
        try {
          const status = await checkLogin(session.http)
          uname = status.uname ?? ''
          face = status.face ?? ''
        } catch {
          // Ignored: the account is still usable without a display name.
        }

        const account = upsertAccount(ctx.db, user.id, {
          uid: credential.dedeUserId,
          uname,
          face,
          cookies: JSON.stringify(credentialToCookies(credential)),
          // Stored so the session can be extended later without another scan.
          refreshToken: credential.acTimeValue
        })

        ctx.loginSessions.remove(key)
        // Drop any cached client so the next request reads the fresh cookies.
        ctx.forgetAccountClient(account.id)

        return { ok: true, state: 'success', account }
      } finally {
        polls.end(key)
      }
    }
  )
}
