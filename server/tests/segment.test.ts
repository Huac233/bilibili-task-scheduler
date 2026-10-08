import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { canBacktrackExponentially, DEFAULT_SEGMENT_OPTIONS, segmentText, summarize } from '../src/text/segment.js'

describe('segmentText', () => {
  it('splits on sentence-ending punctuation and keeps the mark attached', () => {
    const result = segmentText('你好。世界！', { dedupe: false })
    expect(result.bullets).toEqual(['你好。', '世界！'])
  })

  it('splits on newlines when enabled', () => {
    const result = segmentText('第一行\n第二行', { dedupe: false })
    expect(result.bullets).toEqual(['第一行', '第二行'])
  })

  it('normalises CRLF before splitting', () => {
    // minLength 1 because these single-character lines would otherwise be
    // dropped by the default minimum of 2.
    const result = segmentText('甲\r\n乙\r丙', { dedupe: false, minLength: 1 })
    expect(result.bullets).toEqual(['甲', '乙', '丙'])
  })

  it('treats newlines as spaces when newline splitting is off', () => {
    const result = segmentText('前半\n后半', { splitOnNewline: false, dedupe: false })
    expect(result.bullets).toEqual(['前半 后半'])
  })

  it('breaks sentences longer than maxLength into pieces that all fit', () => {
    const result = segmentText('啊'.repeat(50), { maxLength: 20, dedupe: false })
    expect(result.bullets.length).toBeGreaterThan(1)
    for (const bullet of result.bullets) {
      expect(bullet.length).toBeLessThanOrEqual(20)
    }
  })

  it('prefers a soft delimiter when breaking a long sentence', () => {
    // 24 chars with a comma at position 12 — the cut should land after it.
    const text = '一二三四五六七八九十十一，十二三四五六七八九十十一二'
    const result = segmentText(text, { maxLength: 20, dedupe: false })
    expect(result.bullets[0]).toBe('一二三四五六七八九十十一，')
  })

  it('drops bullets shorter than minLength and counts them', () => {
    const result = segmentText('好。这是一个完整的句子。', { minLength: 3, dedupe: false })
    expect(result.bullets).toEqual(['这是一个完整的句子。'])
    expect(result.stats.droppedTooShort).toBe(1) // only "好。" is too short
  })

  it('de-duplicates when enabled, keeping the first occurrence', () => {
    const result = segmentText('重复的话。重复的话。别的。', { dedupe: true })
    expect(result.bullets).toEqual(['重复的话。', '别的。'])
    expect(result.stats.deduped).toBe(1)
  })

  it('keeps duplicates when de-duplication is off', () => {
    const result = segmentText('重复的话。重复的话。', { dedupe: false })
    expect(result.bullets).toEqual(['重复的话。', '重复的话。'])
  })

  it('applies literal replacement rules', () => {
    const result = segmentText('这是敏感词测试。', {
      dedupe: false,
      replacements: [{ pattern: '敏感词', replacement: '敏感*', isRegex: false }]
    })
    expect(result.bullets).toEqual(['这是敏感*测试。'])
  })

  it('applies regex replacement rules', () => {
    const result = segmentText('abc123def456。', {
      dedupe: false,
      replacements: [{ pattern: '\\d+', replacement: '#', isRegex: true }]
    })
    expect(result.bullets).toEqual(['abc#def#。'])
  })

  it('ignores an invalid regex rule instead of throwing', () => {
    const result = segmentText('内容。', {
      dedupe: false,
      replacements: [{ pattern: '([', replacement: 'x', isRegex: true }]
    })
    expect(result.bullets).toEqual(['内容。'])
    // A pattern that does not compile is skipped for a different reason; the count
    // of refused rules is about the ones that would have compiled and then hung.
    expect(result.stats.unsafeRulesSkipped).toBe(0)
  })

  it('applies replacements before splitting so introduced delimiters are honoured', () => {
    const result = segmentText('甲|乙', {
      dedupe: false,
      delimiters: ['|'],
      replacements: [{ pattern: '|', replacement: '。', isRegex: false }]
    })
    // The rule runs first, so the text becomes 甲。乙 and the splitter sees 。
    expect(result.bullets).toEqual(['甲。乙'])
  })

  it('returns an empty result for empty input', () => {
    const result = segmentText('')
    expect(result.bullets).toEqual([])
    expect(result.stats.outputCount).toBe(0)
  })

  it('exposes the input length in stats', () => {
    const text = '一二三。'
    expect(segmentText(text).stats.inputChars).toBe(text.length)
  })

  it('uses a 20-char default cap, matching the danmaku limit', () => {
    expect(DEFAULT_SEGMENT_OPTIONS.maxLength).toBe(20)
  })
})

/**
 * Nested repetitions, and the input that makes them fatal.
 *
 * Every pattern below was measured on Node 25.9.0 by running the raw regex with
 * `String.replace` over an input built to fail — a failing input is the only kind
 * that backtracks. The numbers are in `canBacktrackExponentially`'s own comment; the
 * point of asserting the classification here is that a rule which reaches the engine
 * is unrecoverable, and a rule which is refused is not.
 *
 * The end-to-end case uses a 1 001-character input. Before the refusal existed the
 * same shape did not return in 3 s at **31** characters, so if the guard regresses
 * this test times out rather than merely running slowly — which is the only form of
 * failure that can be asserted from here without hanging the suite by construction.
 */
describe('regex rules that would send the engine into exponential backtracking', () => {
  const REFUSED = [
    '^(a+)+$',
    '^(a*)*$',
    '^([^\\n]+)+$',
    '^((ab)+)+$',
    '^((a|b)+)+$',
    '^(a|aa)+$',
    '^(a{2,3})+$',
    '^(a+){2}$',
    '^(a+){50}$',
    '(a+)*b',
    '(\\d{1,3}\\.)+\\d{1,3}',
    // Refused although the engine happens to survive it: the rule errs towards a
    // rule that stops applying, never towards a request that never returns.
    '^(a?)+$'
  ]

  /** Measured to still apply at 2 ms on 40 000 characters. */
  const ALLOWED = [
    '^(https?)?://x$',
    '^([a-z]|\\d)+$',
    '^(ab|cd)+$',
    '^(a+)?$',
    '^\\d{1,3}(,\\d{3})*$',
    '(?:\\d{4})-\\d{2}$',
    '(\\w+)@(\\w+)$',
    '^(a|b)+$',
    '([，。])\\1$',
    '^(?:ab)+$',
    '(敏感|词)+$',
    '^.{0,10}$',
    '\\b(\\d+)\\b'
  ]

  it.each(REFUSED)('refuses %s', pattern => {
    expect(canBacktrackExponentially(pattern)).toBe(true)
  })

  it.each(ALLOWED)('leaves %s alone', pattern => {
    expect(canBacktrackExponentially(pattern)).toBe(false)
  })

  it('returns on an input that a refused rule would never finish', () => {
    const result = segmentText(`${'a'.repeat(1000)}!`, {
      dedupe: false,
      minLength: 1,
      replacements: [{ pattern: '^(a+)+$', replacement: 'x', isRegex: true }]
    })

    expect(result.stats.unsafeRulesSkipped).toBe(1)
    // Refused, not applied: the bullet is the input, untouched.
    expect(result.bullets.join('')).toContain('a'.repeat(1000))
  })

  it('counts a refused rule without disturbing the ones around it', () => {
    const result = segmentText('敏感词。', {
      dedupe: false,
      replacements: [
        { pattern: '^(a+)+$', replacement: 'x', isRegex: true },
        { pattern: '敏感', replacement: '温和', isRegex: false }
      ]
    })

    expect(result.stats.unsafeRulesSkipped).toBe(1)
    expect(result.bullets).toEqual(['温和词。'])
  })

  it('still applies an alternation, which the refusal must not mistake for one', () => {
    const result = segmentText('哈哈哈。', {
      dedupe: false,
      replacements: [{ pattern: '(哈|蛤)+', replacement: '笑', isRegex: true }]
    })

    expect(result.stats.unsafeRulesSkipped).toBe(0)
    expect(result.bullets).toEqual(['笑。'])
  })

  it('does not flag many distinct branches, and does not cost a pair per branch', () => {
    // A branch count is not evidence of anything: `(b000|b001|…)` is unambiguous. The
    // check is written to stay linear in the branch count because a pattern's ceiling is a
    // route's number rather than this function's — `routes/libraries.ts` allows 500 characters,
    // and 500 branches is a pattern a person can legitimately write — so a pair-by-pair scan
    // would be a cost the guard against one introduced.
    const branches = Array.from({ length: 300 }, (_, index) => `b${String(index).padStart(3, '0')}`)

    expect(canBacktrackExponentially(`(${branches.join('|')})+`)).toBe(false)
  })

  it('refuses a pattern too long to analyse, rather than walking it', () => {
    // The guard keeps a frame per open group, so an unbalanced megabyte of `(` would be
    // the same class of fault it exists to prevent. A rule a person wrote is orders of
    // magnitude shorter; the stored-rule route caps one at 500 characters.
    expect(canBacktrackExponentially('('.repeat(20_000))).toBe(true)
    expect(canBacktrackExponentially('a'.repeat(20_000))).toBe(true)
  })
})

describe('summarize', () => {
  it('reports count, totals and extremes', () => {
    const summary = summarize(['abc', 'de', 'fghij'])
    expect(summary.count).toBe(3)
    expect(summary.totalChars).toBe(10)
    expect(summary.minChars).toBe(2)
    expect(summary.maxChars).toBe(5)
  })

  it('handles an empty list without producing Infinity for minChars', () => {
    const summary = summarize([])
    expect(summary.count).toBe(0)
    expect(summary.minChars).toBe(0)
    expect(summary.maxChars).toBe(0)
  })
})

/*
 * The two windows that hang, at the only seam that can ask for them.
 *
 * `maxLength` of `0` or a negative number leaves `breakLongLine`'s loop unable to shrink `rest`, and
 * the loop is **synchronous** — so the fault is a spin no timeout can interrupt from inside the
 * process, which means an in-process case cannot pin it: it would not fail, it would hang the whole
 * suite. These cases therefore run the product as a process, which is also the only place the fault
 * was reachable from: `routes/libraries.ts` refuses both values (its length knobs are `1..70`), while
 * `scripts/segment-file.ts` passes `Number.parseInt(process.argv[3])` straight through. Measured
 * before the clamp: both arguments produced a process that never returned.
 */

const SEGMENT_SCRIPT = fileURLToPath(new URL('../scripts/segment-file.ts', import.meta.url))
const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url))
const INPUT_DIR = mkdtempSync(join(tmpdir(), 'segment-cli-'))
const INPUT_FILE = join(INPUT_DIR, 'input.txt')

writeFileSync(INPUT_FILE, '第一句。第二句，还是很长的一句话。\n'.repeat(3), 'utf8')

afterAll(() => {
  rmSync(INPUT_DIR, { recursive: true, force: true })
})

interface CliRun {
  /** The exit code, or null when the deadline killed it. */
  readonly code: number | null
  /** True when the process had to be killed — the shape a non-terminating run takes. */
  readonly killed: boolean
}

/**
 * One real run of the script: `node --import tsx scripts/segment-file.ts <file> <maxLength>`.
 *
 * `stdio: 'ignore'` because the assertions are about *termination and exit status*, and a pipe would
 * only be a second way for this case to fail. The deadline is this side's own (`spawn` has no
 * `timeout` option) and it kills with `SIGKILL`, because the fault being pinned is a loop that cannot
 * run any handler a polite signal would ask for — the child is not given the chance to clean up, and
 * `killed: true` is what a run that never returns looks like from here.
 */
function runSegmentCli(maxLengthArgument: string, deadlineMs: number): Promise<CliRun> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', SEGMENT_SCRIPT, INPUT_FILE, maxLengthArgument], {
      cwd: SERVER_ROOT,
      stdio: 'ignore'
    })

    const deadline = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: null, killed: true })
    }, deadlineMs)

    child.on('error', () => {
      clearTimeout(deadline)
      resolve({ code: null, killed: false })
    })
    child.on('exit', code => {
      clearTimeout(deadline)
      resolve({ code, killed: false })
    })
  })
}

describe('the window a caller can ask for', () => {
  it('terminates on a window of zero, which no HTTP body can send', async () => {
    const run = await runSegmentCli('0', 20_000)

    expect(run.killed).toBe(false)
    expect(run.code).toBe(0)
  }, 60_000)

  it('terminates on a negative window, which grinds a line down and then spins', async () => {
    const run = await runSegmentCli('-5', 20_000)

    expect(run.killed).toBe(false)
    expect(run.code).toBe(0)
  }, 60_000)

  it('falls back to the default window when the window is not a number at all', () => {
    // The quiet half of this fault, and the one an in-process case *can* reach: `NaN` makes the break
    // loop's condition false, so the loop is skipped and an over-long line comes back **whole** — 50
    // characters under a 20-character window as a single bullet, with nothing downstream to break it
    // up and the platform left to refuse it. `Number.parseInt('abc')` is the shape this arrives in,
    // and a typo is not a request for a window, so the module's own default is what it gets.
    const result = segmentText('啊'.repeat(50), { maxLength: Number.NaN, dedupe: false })

    expect(result.bullets.length).toBeGreaterThan(1)
    for (const bullet of result.bullets) {
      expect(bullet.length).toBeLessThanOrEqual(DEFAULT_SEGMENT_OPTIONS.maxLength)
    }
  })

  it('floors a fractional window rather than cutting at a fraction of a character', () => {
    // `1.5` cannot be honoured as written, and the arithmetic below already behaves as if it were
    // floored — `slice(0, 1.5)` takes one character — so the clamp states the fact rather than
    // leaving it to `String.prototype.slice`'s own conversion.
    const result = segmentText('一二三四五', { maxLength: 1.5, minLength: 1, dedupe: false })

    expect(result.bullets).toEqual(['一', '二', '三', '四', '五'])
  })
})
