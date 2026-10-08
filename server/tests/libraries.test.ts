import { describe, expect } from 'vitest'

import type { BuiltServer } from '../src/index.js'
import { canBacktrackExponentially } from '../src/text/segment.js'
import { test as it, registerUser, type Session } from './fixtures.js'

/**
 * Library import and segmentation routes.
 *
 * The point of these tests is the parameter surface: the UI exposes every
 * segmentation knob, so "the setting I changed actually changed the output" is
 * the property that matters — not merely that the endpoint returns 200.
 */

interface PreviewResponse {
  ok: boolean
  truncated: boolean
  stats: { inputChars: number; outputCount: number; droppedTooShort: number; deduped: number }
  summary: { count: number; totalChars: number; minChars: number; maxChars: number }
  bullets: string[]
  error?: string
}

interface ImportResponse {
  ok: boolean
  library?: { id: number; name: string; bulletCount: number; rawChars: number }
  error?: string
}

function post(
  server: BuiltServer,
  session: Session,
  url: string,
  payload: Record<string, unknown>
): Promise<{ statusCode: number; json: <T>() => T; body: string }> {
  return server.app.inject({ method: 'POST', url, payload, headers: session.auth() }).then(response => ({
    statusCode: response.statusCode,
    json: <T>() => response.json<T>(),
    body: response.body
  }))
}

const SAMPLE = '第一句话。第二句话！第三句话？这是第四句，稍微长一点点。'

describe('POST /api/libraries/preview', () => {
  it('segments without persisting anything', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries/preview', { text: SAMPLE })
    expect(response.statusCode).toBe(200)

    const body = response.json<PreviewResponse>()
    expect(body.ok).toBe(true)
    expect(body.bullets.length).toBeGreaterThan(0)

    // Nothing should have been stored.
    const list = await server.app.inject({
      method: 'GET',
      url: '/api/libraries',
      headers: session.auth()
    })
    expect(list.json<{ libraries: unknown[] }>().libraries).toEqual([])
  })

  it('requires authentication', async ({ server }) => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/libraries/preview',
      payload: { text: SAMPLE }
    })
    expect(response.statusCode).toBe(401)
  })

  it('rejects an empty text', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries/preview', { text: '   ' })
    expect(response.statusCode).toBe(400)
  })

  it('honours a custom maxLength', async ({ server, session }) => {
    const long = `${'甲'.repeat(80)}。`
    const response = await post(server, session, '/api/libraries/preview', { text: long, maxLength: 10 })
    const body = response.json<PreviewResponse>()

    expect(body.summary.maxChars).toBeLessThanOrEqual(10)
    for (const bullet of body.bullets) expect(bullet.length).toBeLessThanOrEqual(10)
  })

  it('honours custom delimiters', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries/preview', {
      text: 'alpha|beta|gamma',
      delimiters: ['|'],
      splitOnNewline: false,
      minLength: 1
    })
    const body = response.json<PreviewResponse>()

    expect(body.bullets).toEqual(['alpha|', 'beta|', 'gamma'])
  })

  it('applies replacement rules', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries/preview', {
      text: '这是敏感词。',
      replacements: [{ pattern: '敏感词', replacement: '敏感*', isRegex: false }]
    })
    expect(response.json<PreviewResponse>().bullets).toEqual(['这是敏感*。'])
  })

  it('applies regex replacement rules', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries/preview', {
      text: 'abc123。',
      replacements: [{ pattern: '\\d+', replacement: '#', isRegex: true }]
    })
    expect(response.json<PreviewResponse>().bullets[0]).toBe('abc#。')
  })

  it('can disable de-duplication', async ({ server, session }) => {
    const text = '重复。重复。'
    const withDedupe = await post(server, session, '/api/libraries/preview', { text, dedupe: true })
    const withoutDedupe = await post(server, session, '/api/libraries/preview', { text, dedupe: false })

    expect(withDedupe.json<PreviewResponse>().summary.count).toBe(1)
    expect(withoutDedupe.json<PreviewResponse>().summary.count).toBe(2)
  })

  it('can disable newline splitting', async ({ server, session }) => {
    const text = '前半\n后半'
    const split = await post(server, session, '/api/libraries/preview', { text, splitOnNewline: true })
    const joined = await post(server, session, '/api/libraries/preview', { text, splitOnNewline: false })

    expect(split.json<PreviewResponse>().summary.count).toBe(2)
    expect(joined.json<PreviewResponse>().summary.count).toBe(1)
  })

  it('rejects an out-of-range maxLength instead of silently ignoring it', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries/preview', { text: SAMPLE, maxLength: 9999 })
    expect(response.statusCode).toBe(400)
    expect(response.json<PreviewResponse>().error).toContain('maxLength')
  })

  it('rejects minLength greater than maxLength', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries/preview', {
      text: SAMPLE,
      minLength: 20,
      maxLength: 5
    })
    expect(response.statusCode).toBe(400)
  })

  it('rejects a non-boolean splitOnNewline', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries/preview', { text: SAMPLE, splitOnNewline: 'yes' })
    expect(response.statusCode).toBe(400)
  })

  it('segments by length alone when the delimiter list is empty', async ({ server, session }) => {
    // No punctuation in the input and no delimiters configured: the length
    // limit must become the only cut point. This combination used to be
    // rejected with a 400, which made "split purely by character count"
    // impossible to express.
    const original = 'abcdefghijklmnopqrstuvwxyz'

    const response = await post(server, session, '/api/libraries/preview', {
      text: original,
      delimiters: [],
      splitOnNewline: false,
      maxLength: 10,
      minLength: 1
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<PreviewResponse>()
    expect(body.summary.count).toBeGreaterThan(1)
    expect(body.summary.maxChars).toBeLessThanOrEqual(10)
    // Nothing may be lost in the process.
    expect(body.bullets.join('')).toBe(original)
  })

  it('still segments by length when delimiters are empty and newline splitting is on', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries/preview', {
      text: '一二三四五六七八九十'.repeat(5),
      delimiters: [],
      splitOnNewline: true,
      maxLength: 6,
      minLength: 1
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<PreviewResponse>()
    expect(body.summary.count).toBeGreaterThan(1)
    expect(body.summary.maxChars).toBeLessThanOrEqual(6)
  })

  it('reports the effective options so the UI can echo them back', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries/preview', { text: SAMPLE, maxLength: 15 })
    const body = response.json<PreviewResponse & { effectiveOptions: { maxLength: number } }>()
    expect(body.effectiveOptions.maxLength).toBe(15)
  })

  it('refuses an empty delimiter instead of dropping it', async ({ server, session }) => {
    // An empty string is not punctuation, and the list is handed to the segmenter
    // as it arrives. This used to be filtered out silently, so a form that sent one
    // imported with a delimiter it had just asked for missing.
    const response = await post(server, session, '/api/libraries/preview', { text: SAMPLE, delimiters: ['', '。'] })
    expect(response.statusCode).toBe(400)
    expect(response.json<PreviewResponse>().error).toContain('delimiters')
  })

  it('refuses a replacement rule with no pattern instead of dropping the rule', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries/preview', {
      text: SAMPLE,
      replacements: [{ replacement: 'x' }]
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<PreviewResponse>().error).toContain('匹配内容')
  })

  it('refuses a pattern past the stored-rule page’s own bound, saying which bound that is', async ({
    server,
    session
  }) => {
    // The import form pulls the user's saved rules in and posts them here, so this surface accepts at
    // most what the storing route can hold. Without the bound, a 32 MB body (the server's own
    // `bodyLimit`) reaches the segmenter as one pattern — which is why that module bounds what it
    // will analyse at all.
    const response = await post(server, session, '/api/libraries/preview', {
      text: SAMPLE,
      replacements: [{ pattern: 'a'.repeat(501), isRegex: true }]
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<PreviewResponse>().error).toContain('匹配内容')
    expect(response.json<PreviewResponse>().error).toContain('500')
  })

  it('accepts a pattern at that bound, and the segmenter can still analyse it', async ({ server, session }) => {
    // The two numbers are tied: `text/segment.ts` refuses to analyse a pattern past its
    // `MAX_ANALYSED_PATTERN`, and a rule that is refused there is not an error — it is counted in
    // `stats.unsafeRulesSkipped` and never applied. Asserted through that module's own exported
    // predicate, so lowering its constant below this route's bound turns this red instead of quietly
    // making a pattern a person was allowed to submit stop working.
    const pattern = '敏感'.repeat(250)
    expect(pattern).toHaveLength(500)
    expect(canBacktrackExponentially(pattern)).toBe(false)

    const response = await post(server, session, '/api/libraries/preview', {
      text: `${pattern}尾。`,
      minLength: 1,
      splitOnNewline: false,
      replacements: [{ pattern, replacement: '', isRegex: false }]
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<PreviewResponse>().bullets).toEqual(['尾。'])
  })
})

describe('POST /api/libraries', () => {
  it('imports and stores the segmented text', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries', { text: SAMPLE, name: '测试库' })
    expect(response.statusCode).toBe(200)

    const body = response.json<ImportResponse>()
    expect(body.ok).toBe(true)
    expect(body.library?.name).toBe('测试库')
    expect(body.library?.bulletCount).toBeGreaterThan(0)
  })

  it('applies the same parameters as preview', async ({ server, session }) => {
    // Distinct characters and de-duplication off: a repeated character would
    // segment into identical fragments, and de-duplication would collapse them
    // to two rows, hiding whether the split actually happened.
    const text = Array.from({ length: 100 }, (_, index) => String.fromCharCode(0x4e00 + index)).join('')

    const response = await post(server, session, '/api/libraries', {
      text,
      name: '限长',
      maxLength: 8,
      minLength: 1,
      dedupe: false
    })
    const body = response.json<ImportResponse>()
    expect(body.library?.bulletCount).toBeGreaterThan(10)
  })

  it('rejects an import that segments to nothing', async ({ server, session }) => {
    // minLength above every possible fragment length.
    const response = await post(server, session, '/api/libraries', {
      text: '短。',
      name: 'x',
      minLength: 50,
      maxLength: 100
    })
    expect(response.statusCode).toBe(400)
  })

  it('defaults the name when none is given', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries', { text: SAMPLE })
    const body = response.json<ImportResponse>()
    expect(body.library?.name.startsWith('导入')).toBe(true)
  })

  it('records the raw character count', async ({ server, session }) => {
    const response = await post(server, session, '/api/libraries', { text: SAMPLE })
    expect(response.json<ImportResponse>().library?.rawChars).toBe(SAMPLE.length)
  })
})

describe('library reads and deletion', () => {
  it('lists an imported library', async ({ server, session }) => {
    await post(server, session, '/api/libraries', { text: SAMPLE, name: '待列出' })
    const list = await server.app.inject({
      method: 'GET',
      url: '/api/libraries',
      headers: session.auth()
    })
    const libraries = list.json<{ libraries: { name: string }[] }>().libraries
    expect(libraries).toHaveLength(1)
    expect(libraries[0]?.name).toBe('待列出')
  })

  it('returns bullets in order with pagination', async ({ server, session }) => {
    const imported = await post(server, session, '/api/libraries', { text: '一。二。三。四。五。', name: '分页' })
    const id = imported.json<ImportResponse>().library?.id

    const page = await server.app.inject({
      method: 'GET',
      url: `/api/libraries/${String(id)}/bullets?offset=1&limit=2`,
      headers: session.auth()
    })

    const body = page.json<{ total: number; bullets: { seq: number; content: string }[] }>()
    expect(body.total).toBe(5)
    expect(body.bullets).toHaveLength(2)
    expect(body.bullets[0]?.seq).toBe(1)
  })

  it('returns 404 for a library belonging to another user', async ({ server, session }) => {
    const imported = await post(server, session, '/api/libraries', { text: SAMPLE, name: '私密' })
    const id = imported.json<ImportResponse>().library?.id

    const other = await registerUser(server, 'intruder')

    const response = await server.app.inject({
      method: 'GET',
      url: `/api/libraries/${String(id)}`,
      headers: other.auth()
    })
    expect(response.statusCode).toBe(404)
  })

  it('deletes a library and its bullets', async ({ server, session }) => {
    const imported = await post(server, session, '/api/libraries', { text: SAMPLE, name: '待删除' })
    const id = imported.json<ImportResponse>().library?.id

    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/api/libraries/${String(id)}`,
      headers: session.auth()
    })
    expect(removed.statusCode).toBe(200)

    const list = await server.app.inject({
      method: 'GET',
      url: '/api/libraries',
      headers: session.auth()
    })
    expect(list.json<{ libraries: unknown[] }>().libraries).toEqual([])
  })
})
