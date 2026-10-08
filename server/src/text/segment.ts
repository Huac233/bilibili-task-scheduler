/**
 * Text segmentation: turns an imported document into a list of sendable
 * "bullets".
 *
 * A 6.5 MB novel is ~2.2M characters. Bilibili danmaku is capped at 20
 * characters for a normal account (30 with a 大航海), so the pipeline has to
 * both split on punctuation *and* break over-long sentences, then apply the
 * user's replacement rules ("反和谐") and de-duplicate.
 *
 * Order matters and is deliberate:
 *
 *   normalize -> replace -> split -> trim -> length-filter -> dedupe
 *
 * Replacement runs *before* splitting because a rule may itself introduce or
 * remove delimiter characters; doing it after would leave sentences that no
 * longer match the delimiters they were cut on. Length filtering runs *after*
 * replacement because a rule can change a sentence's length.
 */

/** A find/replace rule applied to every candidate bullet. */
export interface ReplacementRule {
  readonly pattern: string
  readonly replacement: string
  /** When true, `pattern` is treated as a JavaScript regex source. */
  readonly isRegex: boolean
}

export interface SegmentOptions {
  /** Sentence-ending punctuation. A bullet ends *after* one of these. */
  readonly delimiters: readonly string[]
  /** Secondary punctuation used when breaking an over-long sentence. */
  readonly softDelimiters: readonly string[]
  /** Treat newlines as hard separators as well. */
  readonly splitOnNewline: boolean
  /** Bullets shorter than this (in characters) are dropped. */
  readonly minLength: number
  /** Bullets longer than this are broken up. Bilibili's limit is 20 / 30. */
  readonly maxLength: number
  /** Applied to each bullet before length filtering. */
  readonly replacements: readonly ReplacementRule[]
  /** Drop duplicate bullets, keeping the first occurrence. */
  readonly dedupe: boolean
}

export const DEFAULT_DELIMITERS: readonly string[] = ['。', '！', '？', '；', '…', '!', '?', ';']

export const DEFAULT_SOFT_DELIMITERS: readonly string[] = ['，', '、', '：', ' ', '—', ',', ':']

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  delimiters: DEFAULT_DELIMITERS,
  softDelimiters: DEFAULT_SOFT_DELIMITERS,
  splitOnNewline: true,
  minLength: 2,
  // 20 is Bilibili's hard cap for an ordinary account. Longer bullets are
  // rejected by the server, so breaking them up front loses nothing.
  maxLength: 20,
  replacements: [],
  dedupe: true
}

export interface SegmentStats {
  readonly inputChars: number
  readonly outputCount: number
  readonly droppedTooShort: number
  readonly droppedEmpty: number
  readonly deduped: number
  /**
   * Regex rules that were refused because the *engine* would have had to do
   * exponential work on a failing input. Counted rather than swallowed: a rule that
   * silently stops applying is the one failure this pipeline cannot show anyone.
   */
  readonly unsafeRulesSkipped: number
}

export interface SegmentResult {
  readonly bullets: readonly string[]
  readonly stats: SegmentStats
}

/**
 * Segments `text` into bullets.
 *
 * Pure and synchronous: a 2.2M-character input completes in well under a
 * second, so callers can run it inline rather than needing a worker thread.
 */
export function segmentText(text: string, options: Partial<SegmentOptions> = {}): SegmentResult {
  const options_: SegmentOptions = { ...DEFAULT_SEGMENT_OPTIONS, ...options }

  const normalized = normalizeInput(text, options_.splitOnNewline)
  const replaced = applyReplacements(normalized, options_.replacements)

  const raw = splitIntoLines(replaced.text, options_)
  const candidates = raw.flatMap(line => breakLongLine(line, windowOf(options_.maxLength), options_.softDelimiters))

  let droppedEmpty = 0
  let droppedTooShort = 0
  const kept: string[] = []

  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (trimmed.length === 0) {
      droppedEmpty += 1
      continue
    }
    if (trimmed.length < options_.minLength) {
      droppedTooShort += 1
      continue
    }
    kept.push(trimmed)
  }

  let bullets = kept
  let deduped = 0
  if (options_.dedupe) {
    const seen = new Set<string>()
    const unique: string[] = []
    for (const bullet of kept) {
      if (seen.has(bullet)) {
        deduped += 1
        continue
      }
      seen.add(bullet)
      unique.push(bullet)
    }
    bullets = unique
  }

  return {
    bullets,
    stats: {
      inputChars: text.length,
      outputCount: bullets.length,
      droppedTooShort,
      droppedEmpty,
      deduped,
      unsafeRulesSkipped: replaced.unsafeRulesSkipped
    }
  }
}

/**
 * Collapses platform newlines to `\n` so the splitter only handles one form.
 * When newline splitting is off, newlines become spaces instead — otherwise an
 * intentional line break would silently glue two unrelated sentences together.
 */
function normalizeInput(text: string, splitOnNewline: boolean): string {
  const unified = text.replace(/\r\n?/g, '\n')
  return splitOnNewline ? unified : unified.replace(/\n/g, ' ')
}

/** What `applyReplacements` did, including the rules it refused. */
interface ReplacementOutcome {
  readonly text: string
  readonly unsafeRulesSkipped: number
}

/**
 * Applies replacement rules in order.
 *
 * Two ways a user rule is skipped rather than thrown: a pattern that does not
 * compile, and a pattern that compiles but would send this process into
 * exponential backtracking. Both are the same judgement — a bad rule should
 * degrade the import, not abort it — and the second kind is counted so the
 * degradation is at least visible in `stats`.
 */
function applyReplacements(text: string, rules: readonly ReplacementRule[]): ReplacementOutcome {
  let result = text
  let unsafeRulesSkipped = 0
  for (const rule of rules) {
    if (rule.pattern === '') continue
    if (rule.isRegex) {
      if (canBacktrackExponentially(rule.pattern)) {
        unsafeRulesSkipped += 1
        continue
      }
      try {
        result = result.replace(new RegExp(rule.pattern, 'g'), rule.replacement)
      } catch {
        // Invalid pattern — ignore this rule.
      }
    } else {
      result = result.split(rule.pattern).join(rule.replacement)
    }
  }
  return { text: result, unsafeRulesSkipped }
}

/** A repetition, as written in a pattern source. */
interface Quantifier {
  /** Characters the quantifier occupies, including a `?` or `*` search-order suffix. */
  readonly length: number
  readonly min: number
  /** `Number.POSITIVE_INFINITY` for `*`, `+` and `{n,}`. */
  readonly max: number
}

/** Reads a quantifier at `index`, or `null` when the character there is not one. */
function quantifierAt(pattern: string, index: number): Quantifier | null {
  const char = pattern.charAt(index)
  if (char === '*' || char === '+') {
    const quantifier = { length: 1, min: char === '*' ? 0 : 1, max: Number.POSITIVE_INFINITY }
    return withSearchOrderSuffix(pattern, index, quantifier)
  }
  if (char === '?') {
    return withSearchOrderSuffix(pattern, index, { length: 1, min: 0, max: 1 })
  }
  if (char !== '{') return null

  const written = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(index))
  if (written === null) return null

  const min = Number.parseInt(written[1] ?? '', 10)
  // `{n}` is one length, `{n,}` is unbounded, `{n,m}` is a range.
  const max =
    written[2] === undefined ? min : written[2] === '' ? Number.POSITIVE_INFINITY : Number.parseInt(written[2], 10)
  // `{3,1}` is not a quantifier the engine accepts; let the compile below reject it.
  if (min > max) return null
  return withSearchOrderSuffix(pattern, index, { length: written[0].length, min, max })
}

/**
 * Consumes a trailing `?` or `*` as part of the quantifier.
 *
 * `a+?` is the same repetition searched lazily, so it must not be read as a second
 * quantifier over `a+` — that is the shape this module refuses, and the engine
 * knows it is not one.
 */
function withSearchOrderSuffix(pattern: string, index: number, quantifier: Quantifier): Quantifier {
  const next = pattern.charAt(index + quantifier.length)
  return next === '?' || next === '*' ? { ...quantifier, length: quantifier.length + 1 } : quantifier
}

/** True when a repetition can match more than one number of characters. */
function isVariable(quantifier: Quantifier): boolean {
  return quantifier.min !== quantifier.max
}

/**
 * True when a repetition runs a group often enough for an ambiguity inside the
 * group to compound.
 *
 * A repeat that can happen only once cannot compound anything, so `?`, `{0,1}` and
 * `{1}` are left alone. From two upwards it already can: `^(a+){2}$` measures 15 ms
 * on 4 001 characters and 246 ms on 16 001 — quadratic, on a body that may be 32 MB.
 */
function repeatsEnoughToCompound(quantifier: Quantifier): boolean {
  return quantifier.max === Number.POSITIVE_INFINITY || quantifier.max >= 2
}

/** Ends at the `]` that closes the character class starting at `index`. */
function charClassEnd(pattern: string, index: number): number {
  let cursor = index + 1
  if (pattern.charAt(cursor) === '^') cursor += 1
  // `[]` and `[^]` are legal and empty, so a `]` in the first position closes the class.
  if (pattern.charAt(cursor) === ']') return cursor + 1
  while (cursor < pattern.length) {
    const char = pattern.charAt(cursor)
    if (char === '\\') cursor += 2
    else if (char === ']') return cursor + 1
    else cursor += 1
  }
  return pattern.length
}

/** Length of a group's leading `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` or `(?<name>`. */
function groupPrefixLength(pattern: string, index: number): number {
  if (pattern.charAt(index + 1) !== '?') return 0
  const third = pattern.charAt(index + 2)
  if (third === ':' || third === '=' || third === '!') return 2
  if (third === '<') {
    const fourth = pattern.charAt(index + 3)
    if (fourth === '=' || fourth === '!') return 3
    const closing = pattern.indexOf('>', index + 3)
    return closing === -1 ? 3 : closing - index
  }
  return 2
}

/** One open group: what its body looks like, as far as the refusal rule cares. */
interface GroupBody {
  /** Atoms of each top-level alternative, quantifiers stripped. */
  readonly alternatives: string[][]
  /**
   * True when the body holds a repetition that can match a variable number of
   * characters — the thing that lets one input be split among the repetitions in
   * more than one way.
   */
  variable: boolean
}

/**
 * The longest pattern this check will analyse.
 *
 * A replacement rule's pattern has a floor of one character at the HTTP boundary and a ceiling of
 * **500** — `routes/libraries.ts`'s `MAX_PATTERN_LENGTH`, the same number `routes/replacements.ts`
 * caps a stored rule at — so the analysis has to bound itself against the callers that are not that
 * route: the CLI (`scripts/segment-file.ts` hands it whatever a file contains) and any caller built
 * later. That matters because this walks the whole source and keeps a frame per open group, and a 32
 * MB body of `(` would otherwise be a denial of service this guard introduced rather than one it
 * prevented. A rule a person wrote is far shorter — the stored-rule route caps a pattern at 500
 * characters — so a pattern past this is refused along with the ones the analysis can name.
 *
 * **The sentence here used to read "and no ceiling", which the route beside it had already
 * contradicted.** Saying a bound is the route's job while refusing to name the number left the next
 * reader to work out whether 4 096 was below a real limit or above one; it is below.
 */
const MAX_ANALYSED_PATTERN = 4_096

/**
 * Refuses a pattern whose repetitions can be *nested*, which is the shape that
 * makes the regex engine do exponential work on an input that fails to match.
 *
 * Measured on Node 25.9.0 by running `String.replace` with the global regex over an
 * input built to fail — a failing input is the only kind that backtracks, and it is
 * what a 反和谐 rule meets on every line it does not match:
 *
 *   pattern           19 chars   23 chars    27 chars
 *   `^(a+)+$`            2 ms       18 ms      297 ms
 *   `^(a*)*$`            2 ms       38 ms      617 ms
 *   `^([^\n]+)+$`        1 ms       19 ms      301 ms
 *
 *   pattern           31 chars   35 chars    39 chars
 *   `^(a|aa)+$`         10 ms       75 ms      532 ms
 *
 *   pattern           37 chars   45 chars    53 chars
 *   `^((ab)+)+$`         1 ms       28 ms      451 ms
 *
 *   pattern         4 001 chars  8 001   16 001 chars
 *   `^(a+){2}$`         15 ms       59 ms      246 ms
 *
 * Every row multiplies its work by four or more per four characters — and one import
 * body may be 32 MB. The two shapes the rows share: a group repeated more than once
 * whose body (a) holds a repetition that can match a variable number of characters,
 * or (b) is an alternation with two branches that overlap, one being a prefix of the
 * other as `a` and `aa` are. Both are read off the pattern source before anything
 * runs, because a synchronous `replace` cannot be given a budget.
 *
 * **Over-inclusive on purpose, and incomplete on purpose.** `(a?)+` is refused
 * although the engine happens to survive it (0 ms on 2 001 characters), because the
 * alternative is deciding per pattern that a shape is fine, and the cost of being
 * wrong that way is one rule that stops applying rather than one request that never
 * returns. Rules measured to still apply, at 2 ms on 40 000 characters: `^([a-z]|\d)+$`,
 * `^(ab|cd)+$`, `^(?:ab)+$`, `^(a|b)+$`, `^\d{1,3}(,\d{3})*$`, `^(https?)?://x$`.
 * What is *not* covered, and needs a review rather than this function: alternations
 * that overlap without one branch being a prefix of the other (`(a|.b)+`),
 * backreferences, and a bound written as a large fixed count such as `(a+){50}`.
 *
 * Exported so the refusal can be asserted per pattern. A test that proved it through
 * `segmentText` would have to run the very input this function exists to refuse, so a
 * guard that regressed would hang the suite instead of failing it.
 */
export function canBacktrackExponentially(pattern: string): boolean {
  if (pattern.length > MAX_ANALYSED_PATTERN) return true

  const open: {
    readonly body: GroupBody
    readonly atom: string[]
    readonly variable: boolean
    readonly start: number
  }[] = []

  let alternative: string[] = []
  // Annotated rather than inferred: `variable` is reassigned from a value computed out
  // of itself at the end of a group, and TypeScript cannot close that loop alone.
  let variable: boolean = false
  let index = 0

  while (index < pattern.length) {
    const char = pattern.charAt(index)

    if (char === '\\') {
      alternative.push(pattern.slice(index, index + 2))
      index += 2
      continue
    }

    if (char === '[') {
      const end = charClassEnd(pattern, index)
      alternative.push(pattern.slice(index, end))
      index = end
      continue
    }

    if (char === '(') {
      const prefix = groupPrefixLength(pattern, index)
      open.push({ body: { alternatives: [], variable: false }, atom: alternative, variable, start: index })
      alternative = []
      variable = false
      index += 1 + prefix
      continue
    }

    if (char === ')') {
      const frame = open.pop()
      if (frame === undefined) {
        // An unmatched `)` — the compile below will reject it.
        index += 1
        continue
      }

      const alternatives = [...frame.body.alternatives, alternative]
      const bodyIsAmbiguous: boolean = variable || frame.body.variable

      index += 1
      const quantifier = quantifierAt(pattern, index)
      let repeated = false
      if (quantifier !== null) {
        if (repeatsEnoughToCompound(quantifier)) {
          if (bodyIsAmbiguous || overlaps(alternatives)) return true
        }
        repeated = isVariable(quantifier)
        index += quantifier.length
      }

      // The group is now one atom of the enclosing body, carrying its own ambiguity.
      alternative = frame.atom
      alternative.push(pattern.slice(frame.start, index))
      variable = frame.variable || bodyIsAmbiguous || repeated
      continue
    }

    if (char === '|') {
      open[open.length - 1]?.body.alternatives.push(alternative)
      alternative = []
      index += 1
      continue
    }

    const quantifier = quantifierAt(pattern, index)
    if (quantifier !== null) {
      if (isVariable(quantifier)) variable = true
      index += quantifier.length
      continue
    }

    alternative.push(char)
    index += 1
  }

  return false
}

/** How many atoms of each alternative two branches are compared over. */
const OVERLAP_ATOM_LIMIT = 8

/** Separates atoms inside a comparison key: a length prefix, so `['ab']` ≠ `['a','b']`. */
function atomKey(atoms: readonly string[]): string {
  return atoms.map(atom => `${String(atom.length)}:${atom}`).join(' ')
}

/**
 * True when one alternative of a group can match what another one can, which is what
 * makes repeating the group ambiguous.
 *
 * Quantifiers are stripped before the comparison: `a` and `a?` both reduce to `a`, and
 * that pair is ambiguous for the same reason `a` and `aa` are. Comparing atoms rather
 * than whole strings is what keeps `(a|b)+` and `(ab|cd)+` — both unambiguous — allowed.
 *
 * An alternative that reduces to nothing counts as a prefix of every other: a group
 * that can match the empty string can be repeated without consuming anything.
 *
 * Linear in the number of branches, deliberately. The shapes that matter differ within
 * their first two atoms, so only a bounded head of each branch is compared, and a
 * pair-by-pair scan of a pattern with a million alternatives would have been a denial
 * of service introduced by the guard against one.
 */
function overlaps(alternatives: readonly (readonly string[])[]): boolean {
  if (alternatives.length < 2) return false

  const heads = alternatives.map(alternative => alternative.slice(0, OVERLAP_ATOM_LIMIT))
  if (heads.some(head => head.length === 0)) return true

  const seen = new Set<string>()
  for (const head of heads) {
    const whole = atomKey(head)
    // Two branches that are the same sequence.
    if (seen.has(whole)) return true
    seen.add(whole)
  }
  for (const head of heads) {
    for (let cut = 1; cut < head.length; cut += 1) {
      if (seen.has(atomKey(head.slice(0, cut)))) return true
    }
  }
  return false
}

/**
 * Splits into lines on the configured delimiters and (optionally) newlines.
 *
 * Implemented with a single compiled regex rather than a per-character loop:
 * on multi-megabyte input the regex engine is an order of magnitude faster,
 * and the character class is built once per call.
 */
function splitIntoLines(text: string, options: SegmentOptions): string[] {
  const separatorChars = [...options.delimiters]
  if (options.splitOnNewline) separatorChars.push('\n')

  if (separatorChars.length === 0) {
    return options.splitOnNewline ? text.split('\n') : [text]
  }

  const charClass = separatorChars.map(escapeForCharClass).join('')
  // `[^sep]+` then an optional trailing separator keeps the punctuation
  // attached to the sentence it ends.
  const pattern = new RegExp(`[^${charClass}]+[${charClass}]?`, 'g')
  const matches = text.match(pattern)
  return matches ?? []
}

/** Escapes a character for inclusion inside a regex character class. */
function escapeForCharClass(char: string): string {
  return char.replace(/[\\\]^-]/g, '\\$&')
}

/**
 * The window a break may use: a whole number of characters, at least one.
 *
 * `breakLongLine`'s loop only terminates because of the lower bound here, and every value below one
 * is reachable from outside this module:
 *
 *   - **A window of `0` or a negative number never returns.** The loop cuts at `windowEnd` =
 *     `min(maxLength, rest.length)` and re-slices `rest` by that much, and its condition is
 *     `rest.length > maxLength` — true for both — so it enters with nothing to take: at `0` the cut
 *     is zero-length, and at `-5` the line is ground down until only five characters are left and
 *     then re-sliced to itself. Either way `rest` stops shrinking and the loop runs forever, and it
 *     is **synchronous**, so no timer can fire and the event loop never gets a turn to notice.
 *     Measured on this module's own CLI (`scripts/segment-file.ts` passes
 *     `Number.parseInt(process.argv[3])` straight through): `… segment-file.ts <file> 0` prints
 *     `input`/`chars` and is still spinning at the eight-second mark, with no summary and no way to
 *     stop it from inside the process. `-5` is the same.
 *   - **`NaN` does not hang, and its symptom is quieter and worse than a hang would be.** The loop's
 *     condition is false against `NaN`, so the loop never runs and the over-long line is returned
 *     **whole**: 50 characters under a 20-character window come back as one 50-character bullet, and
 *     nothing downstream breaks it up again — the platform is the thing that refuses it. That is what
 *     `Number.parseInt('abc')` produces, which is a typo rather than a request, so it falls back to
 *     this module's own default (`DEFAULT_SEGMENT_OPTIONS.maxLength`) rather than being clamped to
 *     the smallest legal window: honouring "1" would shred every sentence into single characters,
 *     which the length filter then drops, so the text would vanish instead of coming out long.
 *
 * **Who can ask for any of them: the CLI, and not the HTTP surface.** `routes/libraries.ts` bounds
 * both length knobs to `1..70` before the segmenter sees them, so a caller with a typo and a caller
 * with a zero both arrive through the script. The clamp is on this side rather than in the script
 * because the loop is what hangs, so a second CLI caller would otherwise have to know the same rule.
 * A finite window below one is clamped to `1` instead of replaced: `routes/libraries.ts` allows one,
 * so the smallest legal window is an answer the caller asked for rather than a substitute for one —
 * and a window of `0` therefore means one-character pieces that the length filter drops, which is
 * visible in the CLI's own summary of what it produced.
 */
function windowOf(maxLength: number): number {
  if (!Number.isFinite(maxLength)) return DEFAULT_SEGMENT_OPTIONS.maxLength
  return Math.max(1, Math.floor(maxLength))
}

/**
 * Breaks a single over-long sentence into <= `maxLength` pieces.
 *
 * Splits at the last soft delimiter inside the first window when one exists
 * (so breaks land on commas rather than mid-word), and falls back to a hard
 * cut otherwise. The hard cut is unavoidable: some sentences simply contain no
 * punctuation for hundreds of characters.
 *
 * `maxLength` is `windowOf`'s output, and this function's loop only terminates because of it: it
 * cuts at least one character every round. The assertion at the bottom of the loop is what keeps
 * that a stated invariant instead of a property of the current arithmetic — a `cut` of zero is
 * exactly the fault that made this loop hang.
 */
function breakLongLine(line: string, maxLength: number, softDelimiters: readonly string[]): string[] {
  if (line.length <= maxLength) return [line]

  const pieces: string[] = []
  let rest = line

  while (rest.length > maxLength) {
    // Look for a soft delimiter in the back half of the window: cutting at
    // position 2 would produce fragments, which is worse than not cutting.
    const windowEnd = Math.min(maxLength, rest.length)
    const searchFrom = Math.max(1, Math.floor(maxLength * 0.5))

    let cut = -1
    for (let index = windowEnd - 1; index >= searchFrom; index -= 1) {
      const char = rest.charAt(index)
      if (softDelimiters.includes(char)) {
        cut = index + 1
        break
      }
    }
    if (cut <= 0) cut = windowEnd
    if (cut <= 0) {
      // Unreachable while `windowOf` clamps the window to one or more, and thrown rather than
      // looped if a later change lets a zero through: a synchronous infinite loop is a hang with
      // no diagnostic, and this is the diagnostic.
      throw new Error(`segment: no progress possible with maxLength ${String(maxLength)}`)
    }

    const piece = rest.slice(0, cut)
    if (piece.trim().length > 0) pieces.push(piece)
    rest = rest.slice(cut)
  }

  if (rest.trim().length > 0) pieces.push(rest)
  return pieces
}

/**
 * Counts how many bullets a library needs. Used to size the insert before
 * running it, so progress reporting has a denominator.
 */
export function summarize(bullets: readonly string[]): {
  readonly count: number
  readonly totalChars: number
  readonly maxChars: number
  readonly minChars: number
} {
  let totalChars = 0
  let maxChars = 0
  let minChars = Number.POSITIVE_INFINITY

  for (const bullet of bullets) {
    totalChars += bullet.length
    if (bullet.length > maxChars) maxChars = bullet.length
    if (bullet.length < minChars) minChars = bullet.length
  }

  return {
    count: bullets.length,
    totalChars,
    maxChars,
    minChars: Number.isFinite(minChars) ? minChars : 0
  }
}
