import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import {
  countRules,
  createRule,
  deleteRule,
  getRule,
  listRules,
  MAX_RULES_PER_USER,
  setRuleEnabled
} from '../repo/replacements.js'
import { type AppContext, requireUser } from './context.js'
import { bodyOrEmpty, idParam, requireBody } from './validation.js'

/**
 * Replacement rule routes.
 *
 * A stored rule is validated the same way the import form validates one — the
 * regex is compiled once at creation time so a broken pattern is rejected while
 * the user is looking at the form, not silently skipped later during a send.
 */

/** Upper bound on either side of a rule, to keep a runaway regex from being stored. */
const MAX_PATTERN_LENGTH = 500
const MAX_REPLACEMENT_LENGTH = 500

/**
 * Compiles a regex to prove it is valid, returning the refusal it earns.
 *
 * Called while the rule is being stored rather than when it is applied: a bad
 * pattern stored now would be skipped silently by the segmenter, and the user
 * would have no way to tell whether their rule ran. The engine's own reason is
 * carried into the message, because it is the only thing that says which part of
 * the pattern is wrong.
 */
function patternRefusal(pattern: string): string | null {
  try {
    new RegExp(pattern)
    return null
  } catch (error: unknown) {
    return `正则表达式无效：${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * The rule a form submits.
 *
 * Whether a pattern is usable depends on `isRegex` — `([` is a perfectly good
 * literal and a broken regex — so that check is a `.superRefine` over the pair
 * rather than a rule on either field.
 */
const ruleSchema = z
  .object({
    pattern: z
      .string({ error: '匹配内容不能为空' })
      .min(1, '匹配内容不能为空')
      .max(MAX_PATTERN_LENGTH, `匹配内容不能超过 ${String(MAX_PATTERN_LENGTH)} 个字符`),
    replacement: z
      .string({ error: '替换内容无效' })
      .max(MAX_REPLACEMENT_LENGTH, `替换内容不能超过 ${String(MAX_REPLACEMENT_LENGTH)} 个字符`)
      .default(''),
    isRegex: z.boolean({ error: '匹配方式无效' }).default(false)
  })
  .superRefine((rule, ctx) => {
    if (!rule.isRegex) return
    const refusal = patternRefusal(rule.pattern)
    if (refusal !== null) ctx.addIssue({ code: 'custom', message: refusal })
  })

/** The one field a later PATCH flips. */
const enabledSchema = bodyOrEmpty(z.object({ enabled: z.boolean({ error: '请提供 enabled 布尔值' }) }))

export function registerReplacementRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/replacements', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request, reply, ctx)
    if (user === null) return undefined

    return {
      ok: true,
      rules: listRules(ctx.db, user.id),
      limit: MAX_RULES_PER_USER
    }
  })

  app.post<{ Body: z.infer<typeof ruleSchema> }>(
    '/api/replacements',
    { schema: { body: ruleSchema } },
    async (request: FastifyRequest<{ Body: z.infer<typeof ruleSchema> }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      if (countRules(ctx.db, user.id) >= MAX_RULES_PER_USER) {
        return reply.code(400).send({ ok: false, error: `替换规则已达上限（${String(MAX_RULES_PER_USER)} 条）` })
      }

      const rule = createRule(ctx.db, user.id, request.body)
      return { ok: true, rule }
    }
  )

  /**
   * Enables or disables a rule.
   *
   * The body is not in this route's schema, for the same reason
   * `PATCH /api/tasks/:id` keeps its own out: a declared schema runs before the
   * handler, so a wrong id would answer 400 about the body where the honest answer
   * is 404 about the rule.
   */
  app.patch<{ Params: { id: number } }>(
    '/api/replacements/:id',
    { schema: { params: z.object({ id: idParam('无效的规则 ID') }) } },
    async (request: FastifyRequest<{ Params: { id: number } }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const ruleId = request.params.id

      if (getRule(ctx.db, user.id, ruleId) === null) {
        return reply.code(404).send({ ok: false, error: '规则不存在' })
      }

      const body = requireBody(enabledSchema, request, reply)
      if (body === null) return undefined

      setRuleEnabled(ctx.db, ruleId, body.enabled)
      const updated = getRule(ctx.db, user.id, ruleId)
      return { ok: true, rule: updated }
    }
  )

  app.delete<{ Params: { id: number } }>(
    '/api/replacements/:id',
    { schema: { params: z.object({ id: idParam('无效的规则 ID') }) } },
    async (request: FastifyRequest<{ Params: { id: number } }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      if (!deleteRule(ctx.db, user.id, request.params.id)) {
        return reply.code(404).send({ ok: false, error: '规则不存在' })
      }
      return { ok: true }
    }
  )
}
