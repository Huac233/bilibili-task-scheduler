import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { createLibrary, deleteLibrary, getLibrary, listBullets, listLibraries } from '../repo/libraries.js'
import { DEFAULT_SEGMENT_OPTIONS, type SegmentOptions, segmentText, summarize } from '../text/segment.js'
import { type AppContext, requireUser } from './context.js'
import { idParam, queryInt } from './validation.js'

/**
 * Library (text import) routes.
 *
 * Two entry points share one parameter schema:
 *
 *  - `POST /preview` segments a sample and returns statistics plus the first
 *    few bullets, writing nothing. This is what lets the UI expose every knob
 *    (delimiters, lengths, replacements) and show the result live before the
 *    user commits to importing a 6 MB novel.
 *
 *  - `POST /` segments the full text and persists it in one transaction.
 *
 * Preview is capped at a sample length: segmenting 2.3M characters takes ~80 ms,
 * which is fine, but echoing back a 148k-element bullet array over JSON is not.
 */

/** Characters fed to the segmenter during preview. */
const PREVIEW_CHAR_LIMIT = 200_000

/** Bullets returned in a preview response. */
const PREVIEW_BULLET_LIMIT = 50

/**
 * The longest bullet a library may store, in characters.
 *
 * This is a **storage** ceiling, not a send limit, and the previous comment here
 * claimed otherwise (it said Bilibili rejects anything longer, at 100 — Bilibili's
 * real cap is 20, and Douyu's is 70). Two different things were being conflated:
 *
 *  - The effective limit for a given task is its action's
 *    `ActionDescriptor.maxMessageLength` — Bilibili 20, Douyu 70. That is the number
 *    a send is actually measured against, and it lives with the Platform.
 *  - This constant only bounds what a person may configure here, so that an import
 *    cannot be asked for something **no** supported Platform would accept. It is
 *    therefore the largest real cap rather than a round number.
 *
 * A library is Platform-agnostic, so nothing at import time can know which cap will
 * apply; the segmenter's own default (20) is the safe one for Bilibili, which is
 * where most imports end up.
 */
const MAX_BULLET_LENGTH = 70

/**
 * A bullet-length knob.
 *
 * One factory for `minLength` and `maxLength` because they fail in exactly the
 * same two ways — a value that is not a whole number, and a value outside what any
 * supported Platform would accept — and the refusal names the field, so the two
 * sentences stay distinguishable without being written out twice.
 */
function lengthOption(field: string) {
  const message = `${field} 需为 1-${String(MAX_BULLET_LENGTH)} 的整数`
  return z.number({ error: message }).int(message).min(1, message).max(MAX_BULLET_LENGTH, message).optional()
}

/**
 * A list of delimiter characters.
 *
 * An empty entry is refused rather than dropped: an empty string is not a
 * punctuation mark, and a delimiter list is passed straight to the segmenter,
 * where an empty cut point is not something it can act on.
 */
function delimiterList(field: string) {
  return z.array(z.string({ error: `${field} 中的分隔符必须是文本` }).min(1, `${field} 中的分隔符不能为空`)).optional()
}

/**
 * The longest replacement pattern this surface accepts, in characters.
 *
 * The same number `routes/replacements.ts` caps a **stored** rule's pattern at, and it is that number
 * on purpose rather than a round one: the import form pulls the user's own saved rules in and posts
 * them here (`web/src/views/ImportView.vue`), so a lower bound would refuse an import built out of
 * rules the storing route had just accepted, and a higher one would admit a pattern no stored rule can
 * hold. It is drawn on the field rather than on `isRegex` for the same reason: the two surfaces state
 * one contract about one field.
 *
 * What it bounds is the **analysis** the segmenter does, which is what made an unbounded pattern a
 * hazard rather than a curiosity: `text/segment.ts` walks a regex rule before applying it, refuses to
 * analyse one past its own `MAX_ANALYSED_PATTERN` (4096), and that refusal is a *counted skip*
 * (`stats.unsafeRulesSkipped`) rather than an error — so a pattern past the ceiling is one the
 * segmenter accepts and never runs. 500 sits well below it, which is what keeps every pattern let
 * through here analysable. If that constant ever moves below this one, this one has to move with it.
 */
const MAX_PATTERN_LENGTH = 500

/**
 * A find/replace rule as the form sends it.
 *
 * `replacement` and `isRegex` default rather than refuse, which is the shape the
 * segmenter's own `ReplacementRule` already describes: a rule with no replacement
 * deletes what it matches, and one with no `isRegex` is a literal.
 */
const replacementRuleSchema = z.object({
  pattern: z
    .string({ error: '匹配内容不能为空' })
    .min(1, '匹配内容不能为空')
    .max(MAX_PATTERN_LENGTH, `匹配内容不能超过 ${String(MAX_PATTERN_LENGTH)} 个字符（与「替换规则」页的上限一致）`),
  replacement: z.string({ error: '替换内容无效' }).default(''),
  isRegex: z.boolean({ error: '匹配方式无效' }).default(false)
})

/**
 * Every segmentation knob, all optional.
 *
 * Nothing is defaulted *here* on purpose. An omitted knob keeps the segmenter's
 * own default — `DEFAULT_SEGMENT_OPTIONS` — and the preview response echoes the
 * merge of the two, so a second copy of those numbers in this file would be a
 * second thing to keep in step with the segmenter's.
 */
const SEGMENT_FIELDS = {
  delimiters: delimiterList('delimiters'),
  softDelimiters: delimiterList('softDelimiters'),
  splitOnNewline: z.boolean({ error: 'splitOnNewline 必须是布尔值' }).optional(),
  minLength: lengthOption('minLength'),
  maxLength: lengthOption('maxLength'),
  dedupe: z.boolean({ error: 'dedupe 必须是布尔值' }).optional(),
  replacements: z.array(replacementRuleSchema).optional()
}

const segmentParamsSchema = z.object(SEGMENT_FIELDS)

/**
 * `minLength` and `maxLength` are one rule in two fields, so the pair is checked
 * as a pair. It stays a predicate rather than a `.refine` on each body because
 * both routes ask the same question and both must answer it the same way.
 */
function lengthsInOrder(params: { minLength?: number | undefined; maxLength?: number | undefined }): boolean {
  if (params.minLength === undefined || params.maxLength === undefined) return true
  return params.minLength <= params.maxLength
}

/** The text to segment, refused in the words of the endpoint that asked for it. */
function importedText(message: string) {
  return z.string({ error: message }).refine(value => value.trim() !== '', message)
}

const previewSchema = z
  .object({ ...SEGMENT_FIELDS, text: importedText('请提供待分割的文本') })
  .refine(lengthsInOrder, 'minLength 不能大于 maxLength')

const importSchema = z
  .object({
    ...SEGMENT_FIELDS,
    name: z.string({ error: '库名称无效' }).optional(),
    filename: z.string({ error: '文件名无效' }).optional(),
    text: importedText('请提供待导入的文本')
  })
  .refine(lengthsInOrder, 'minLength 不能大于 maxLength')

/**
 * The knobs a client sent, in the shape the segmenter takes them.
 *
 * Not a narrowing — the schema has checked every field — but the one step that
 * drops `undefined`. Zod types an optional field as `T | undefined`, which
 * `exactOptionalPropertyTypes` will not pass to `Partial<SegmentOptions>`; and a key
 * the client omitted has to stay *absent* rather than become present-and-undefined,
 * because the segmenter applies its defaults by spreading, where an explicit
 * `undefined` would overwrite a default with nothing.
 */
function segmentOptionsOf(body: z.infer<typeof segmentParamsSchema>): Partial<SegmentOptions> {
  const { delimiters, softDelimiters, splitOnNewline, minLength, maxLength, dedupe, replacements } = body
  return {
    ...(delimiters === undefined ? {} : { delimiters }),
    ...(softDelimiters === undefined ? {} : { softDelimiters }),
    ...(splitOnNewline === undefined ? {} : { splitOnNewline }),
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(dedupe === undefined ? {} : { dedupe }),
    ...(replacements === undefined ? {} : { replacements })
  }
}

export function registerLibraryRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Segments a sample without persisting. Drives the live preview panel.
   */
  app.post<{ Body: z.infer<typeof previewSchema> }>(
    '/api/libraries/preview',
    { schema: { body: previewSchema } },
    async (request: FastifyRequest<{ Body: z.infer<typeof previewSchema> }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const { text, ...knobs } = request.body
      const options = segmentOptionsOf(knobs)

      const sample = text.length > PREVIEW_CHAR_LIMIT ? text.slice(0, PREVIEW_CHAR_LIMIT) : text
      const result = segmentText(sample, options)

      return {
        ok: true,
        truncated: sample.length < text.length,
        sampleChars: sample.length,
        stats: result.stats,
        summary: summarize(result.bullets),
        bullets: result.bullets.slice(0, PREVIEW_BULLET_LIMIT),
        effectiveOptions: {
          ...DEFAULT_SEGMENT_OPTIONS,
          ...options,
          replacements: options.replacements ?? DEFAULT_SEGMENT_OPTIONS.replacements
        }
      }
    }
  )

  /** Segments the whole text and stores it. */
  app.post<{ Body: z.infer<typeof importSchema> }>(
    '/api/libraries',
    { schema: { body: importSchema } },
    async (request: FastifyRequest<{ Body: z.infer<typeof importSchema> }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const { text, name: rawName, filename: rawFilename, ...knobs } = request.body
      const options = segmentOptionsOf(knobs)

      const result = segmentText(text, options)
      if (result.bullets.length === 0) {
        return reply
          .code(400)
          .send({ ok: false, error: '按当前参数没有分割出任何可用内容，请放宽长度限制或检查分隔符' })
      }

      const name =
        rawName !== undefined && rawName.trim() !== ''
          ? rawName.trim().slice(0, 120)
          : `导入 ${String(new Date().toISOString().slice(0, 19))}`
      const filename = rawFilename?.slice(0, 200) ?? ''

      const library = createLibrary(ctx.db, user.id, {
        name,
        filename,
        rawChars: text.length,
        bullets: result.bullets
      })

      return { ok: true, library, stats: result.stats }
    }
  )

  app.get('/api/libraries', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request, reply, ctx)
    if (user === null) return undefined
    return { ok: true, libraries: listLibraries(ctx.db, user.id) }
  })

  app.get<{ Params: { id: number } }>(
    '/api/libraries/:id',
    { schema: { params: z.object({ id: idParam('无效的文本库 ID') }) } },
    async (request: FastifyRequest<{ Params: { id: number } }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const library = getLibrary(ctx.db, user.id, request.params.id)
      if (library === null) return reply.code(404).send({ ok: false, error: '文本库不存在' })

      return { ok: true, library }
    }
  )

  /** Paginated view of a library's bullets. */
  app.get<{ Params: { id: number }; Querystring: { offset: number; limit: number } }>(
    '/api/libraries/:id/bullets',
    {
      schema: {
        params: z.object({ id: idParam('无效的文本库 ID') }),
        querystring: z.object({ offset: queryInt({ fallback: 0, min: 0 }), limit: queryInt({ fallback: 100 }) })
      }
    },
    async (
      request: FastifyRequest<{ Params: { id: number }; Querystring: { offset: number; limit: number } }>,
      reply: FastifyReply
    ) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const library = getLibrary(ctx.db, user.id, request.params.id)
      if (library === null) return reply.code(404).send({ ok: false, error: '文本库不存在' })

      const { offset, limit } = request.query

      return {
        ok: true,
        total: library.bulletCount,
        bullets: listBullets(ctx.db, library.id, offset, limit)
      }
    }
  )

  app.delete<{ Params: { id: number } }>(
    '/api/libraries/:id',
    { schema: { params: z.object({ id: idParam('无效的文本库 ID') }) } },
    async (request: FastifyRequest<{ Params: { id: number } }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      if (!deleteLibrary(ctx.db, user.id, request.params.id)) {
        return reply.code(404).send({ ok: false, error: '文本库不存在' })
      }
      return { ok: true }
    }
  )
}
