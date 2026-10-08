import { describe, expect, it } from 'vitest'

import { describeOutcome, isUnsettledOutcome } from '../src/types/api.js'

/**
 * The front end's copy of the server's settledness rule, and the boundary it used to get backwards.
 *
 * `server/src/repo/action-logs.ts` is the authority: `isSettledOutcome` answers over the **stored** value
 * — `done`, `already` and `skipped` are settled — and every other stored value goes through `toOutcome`,
 * which reads one this build does not recognise as `failed`. So the settled set is the three, and a
 * value outside them (a newer build's outcome, or a column that holds something else entirely) is
 * **not** settled, which is the side that stops the day being closed early.
 *
 * This module's rule was written the other way round — `failed` and `blocked` by name, with a comment
 * claiming a sixth outcome would land on the same side of the line in both places — and after the server
 * was repaired those two spellings disagreed on exactly that input: the server called it unsettled and
 * this called it settled. The table below is the boundary, in both directions and from both orders.
 */

/** The three the server settles, as the literals a payload can carry. */
const SETTLED: readonly string[] = ['done', 'already', 'skipped']

/** The two it marks unsettled by name, plus values it has never seen. */
const UNSETTLED: readonly unknown[] = [
  'failed',
  'blocked',
  'partial',
  'a-newer-build',
  '',
  0,
  null,
  undefined,
  { outcome: 'done' }
]

/** The rule's other spelling, written here so the two cannot pass by sharing one mistake. */
function isSettled(value: unknown): boolean {
  return typeof value === 'string' && SETTLED.includes(value)
}

describe('isUnsettledOutcome, against the server’s own settled set', () => {
  it('leaves the settled three unmarked', () => {
    for (const outcome of SETTLED) expect(isUnsettledOutcome(outcome)).toBe(false)
  })

  it('marks the two failures, and everything the three do not name', () => {
    for (const outcome of UNSETTLED) expect(isUnsettledOutcome(outcome)).toBe(true)
  })

  it('answers from the settled set rather than from its complement, which is the direction that drifted', () => {
    // The one input the old spelling got wrong: an outcome this build has never heard of. `toOutcome`
    // reads it as `failed` on the server, so it is not settled there — and the two-literal test here
    // called it settled, i.e. the mirror was inverted on precisely the value it exists to judge.
    expect(isUnsettledOutcome('partial')).toBe(true)
    for (const outcome of [...SETTLED, ...UNSETTLED]) {
      expect(isUnsettledOutcome(outcome)).toBe(!isSettled(outcome))
    }
  })
})

/**
 * The other half of the same boundary: the word a stored value is *displayed* with.
 *
 * The two must not disagree about the value they were both written for. `isUnsettledOutcome` marks any
 * value outside the settled three, and the tables behind the display are keyed by the five's own type —
 * so an unrecognised value was marked and then drawn with **no word at all**, while `toOutcome` reads the
 * same value as `failed` and the server's own screens print 「失败」. Red before the fix: the first
 * assertion below was `expect(undefined).not.toBe('')`.
 */
describe('describeOutcome, over the same value the settledness rule judges', () => {
  it('gives every stored value a word, including the ones this build cannot name', () => {
    for (const outcome of SETTLED) expect(describeOutcome(outcome).label).not.toBe('')
    for (const value of UNSETTLED) expect(describeOutcome(value).label).not.toBe('')
  })

  it('reads a value outside the five as `failed`, which is how the server reads it', () => {
    // `toOutcome` is the authority: an unrecognised value "degrades to `failed` rather than to a
    // success", and `summarizeActionLogs` derives its `failed` as the remainder so the counters count
    // it the same way the rows display it. A word invented here would be one fact with two spellings.
    expect(describeOutcome('a-newer-build')).toEqual({ label: '失败', tag: 'error' })
    // The non-string shapes a column and a JSON item can hold, read the same way.
    for (const value of [null, undefined, 0, '', { outcome: 'done' }]) {
      expect(describeOutcome(value).label).toBe('失败')
    }
  })

  it('leaves the five alone, word and mark', () => {
    expect(describeOutcome('done')).toEqual({ label: '完成', tag: 'success' })
    expect(describeOutcome('already')).toEqual({ label: '无需处理', tag: 'default' })
    // And the mark is the failure's own rather than the tables' `undefined`: the tag is drawn on the
    // unsettled rows alone, so a neutral-marked 「失败」 is the half-truth the word exists to remove.
    expect(describeOutcome('partial').tag).toBe('error')
  })
})
