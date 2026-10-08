import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The 斗鱼 CSRF mint, its path segment, and what is a function of *this* build.
 *
 * **Why a prose defect is pinned by a test.** A comment that writes an endpoint's *last path segment*
 * as though it were a function of this build is not a typo: it is a claim about the call graph, and
 * this file's whole subject is a sentence that made one — `cvl_csrf_token`'s home was described with
 * a name (`generateCsrf`) that appears nowhere in this tree as an identifier, so a reader would go
 * looking for a function that does not exist, and the minted value's provenance would be attributed
 * to this build instead of to the page that really does it. Two agents' rounds have now been spent
 * on it (`text/redact.ts` records the first), and nothing goes red on its own when the prose drifts:
 * a wrong comment is not a failing test. So the two properties that *are* checkable are checked here.
 *
 * Three assertions, each naming the wrong shape it catches:
 *
 *  1. **`generateCsrf` is never written as a name of this build.** The mint's path ends in that
 *     segment, and inside the path it is preceded by `/` — so a `generateCsrf` that is *not* preceded
 *     by a path separator is the identifier spelling, which this tree does not have and must not
 *     appear to have.
 *  2. **The mint's path never wears the family's spelling.** The family's own calls are
 *     `/japi/carnivalApi/…`; the mint is `/japi/carnival/nc/common/generateCsrf` — one segment
 *     `carnival` where the family spells `carnivalApi`. Writing the mint with the family's segment
 *     would be the same conflation in the other direction.
 *  3. **Wherever the mint is named, the family it is not part of is named too.** This is the one that
 *     keeps the *distinction* rather than either of its halves: a file that names the mint and never
 *     spells `carnivalApi` is a file whose reader cannot tell the two apart, and that is precisely the
 *     state `platform/douyu/index.ts` was in.
 *
 * Both homes the finding named are required to carry the mint at all, so deleting the sentence that
 * says what the page does — rather than correcting it — reddens this file as well.
 */

/** The mint: an empty-body `POST` whose path segment is `carnival`, not the family's `carnivalApi`. */
const MINT_PATH = '/japi/carnival/nc/common/generateCsrf'

/** The segment this build's own activity calls spell — `/japi/carnivalApi/sign/doSign` and siblings. */
const FAMILY_SEGMENT = 'carnivalApi'

/** The two homes the finding named, by path rather than by line: a line number moves, an identifier does not. */
const DOUYU_DIR = new URL('../src/platform/douyu/', import.meta.url)
const PROTOCOL = readFileSync(new URL('protocol.ts', DOUYU_DIR), 'utf8')
const ADAPTER = readFileSync(new URL('index.ts', DOUYU_DIR), 'utf8')

const SRC_DIR = new URL('../src/', import.meta.url)

/** Every TypeScript file under `src/`, as paths relative to it — the scope a prose claim lives in. */
function sourceFiles(): readonly string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .map(entry => entry.replaceAll('\\', '/'))
    .filter(entry => entry.endsWith('.ts'))
}

function sourceOf(entry: string): string {
  return readFileSync(new URL(entry, SRC_DIR), 'utf8')
}

/** A `generateCsrf` that is not the last segment of a path — i.e. written as a name of its own. */
const AS_AN_IDENTIFIER = /(?<![A-Za-z0-9_/])generateCsrf\b/

describe('the carnival mint, in the prose that describes it', () => {
  it('is never written as an identifier of this build', () => {
    for (const entry of sourceFiles()) {
      // The offending lines are the assertion's value, so a failure names the sentence to fix rather
      // than only that one exists.
      const lines = sourceOf(entry)
        .split('\n')
        .filter(line => AS_AN_IDENTIFIER.test(line))
      expect(lines, entry).toEqual([])
    }
  })

  it('is never given the family’s path segment', () => {
    for (const entry of sourceFiles()) {
      expect(sourceOf(entry), entry).not.toContain(`${FAMILY_SEGMENT}/nc/common`)
    }
  })

  it('is named with the family it is not part of, in every file that names it', () => {
    const naming = sourceFiles().filter(entry => sourceOf(entry).includes(MINT_PATH))

    // Non-empty, so walking nothing cannot pass for agreement.
    expect(naming.length).toBeGreaterThan(0)
    for (const entry of naming) {
      expect(sourceOf(entry), entry).toContain(FAMILY_SEGMENT)
    }
  })

  it('is kept in both of the homes that describe it', () => {
    // The 粉丝家园 CSRF cookie's doc, which is where a reader learns that this cookie is not its own
    // family's: `FANSHOME_CSRF_COOKIE` in `platform/douyu/protocol.ts`.
    expect(PROTOCOL).toContain(MINT_PATH)
    // …and the activity-sign action's own doc (`reconcileActivitySign` in `platform/douyu/index.ts`),
    // which is where a reader learns what the page does that this build deliberately does not.
    expect(ADAPTER).toContain(MINT_PATH)
  })
})
