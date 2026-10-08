import { describe, expect, it } from 'vitest'

import { applySalt, SALT_CHARS, stripSalt } from '../src/scheduler/salt.js'

/**
 * The caps are the Platforms' real ones, and they are deliberately different here.
 *
 * `applySalt` has no built-in default: the cap arrives from the action descriptor
 * because it is a Platform property, not a salting property. The test names the two
 * values explicitly so the reason for the parameter is visible, and so a future
 * "helpful" default cannot quietly reintroduce a single shared limit.
 */
const BILIBILI_CAP = 20
/** Douyu's real cap, measured: 70 characters, truncated silently rather than rejected. */
const DOUYU_CAP = 70

/** Deterministic generator cycling through fixed values. */
function sequence(values: number[]): () => number {
  let index = 0
  return () => {
    const value = values[index % values.length] ?? 0
    index += 1
    return value
  }
}

describe('applySalt', () => {
  it('adds the requested number of characters', () => {
    const result = applySalt('一段话', { count: 2, maxLength: BILIBILI_CAP, random: () => 0 })
    expect(result.salted).toBe(true)
    expect(result.text.length).toBe(5)
  })

  it('keeps the original content as a subsequence', () => {
    const result = applySalt('原始内容', {
      count: 2,
      maxLength: BILIBILI_CAP,
      random: sequence([0.4, 0.7, 0.2, 0.9])
    })
    const stripped = [...result.text].filter(char => !SALT_CHARS.includes(char)).join('')
    expect(stripped).toBe('原始内容')
  })

  it('refuses to salt when the result would exceed the cap', () => {
    const text = 'a'.repeat(BILIBILI_CAP)
    const result = applySalt(text, { count: 2, maxLength: BILIBILI_CAP })
    expect(result.salted).toBe(false)
    expect(result.text).toBe(text)
  })

  it('salts when there is exactly enough room', () => {
    const text = 'a'.repeat(BILIBILI_CAP - 2)
    const result = applySalt(text, { count: 2, maxLength: BILIBILI_CAP })
    expect(result.salted).toBe(true)
    expect(result.text.length).toBe(BILIBILI_CAP)
  })

  it('is a no-op for empty text', () => {
    const result = applySalt('', { count: 2, maxLength: BILIBILI_CAP })
    expect(result.salted).toBe(false)
    expect(result.text).toBe('')
  })

  it('is a no-op when count is zero', () => {
    const result = applySalt('内容', { count: 0, maxLength: BILIBILI_CAP })
    expect(result.salted).toBe(false)
    expect(result.text).toBe('内容')
  })

  it('produces different output for different random streams', () => {
    const a = applySalt('测试文本', { count: 2, maxLength: BILIBILI_CAP, random: sequence([0.1, 0.1, 0.2, 0.2]) })
    const b = applySalt('测试文本', { count: 2, maxLength: BILIBILI_CAP, random: sequence([0.8, 0.9, 0.3, 0.6]) })
    expect(a.text).not.toBe(b.text)
  })

  it('never exceeds the cap across many draws', () => {
    const text = '这是一个长度刚好可以加盐的句子'
    for (let index = 0; index < 200; index += 1) {
      const result = applySalt(text, { count: 2, maxLength: BILIBILI_CAP })
      expect(result.text.length).toBeLessThanOrEqual(BILIBILI_CAP)
    }
  })

  it('applies the cap it is given, so one Platform cannot silently use anothers', () => {
    // 24 characters: over Bilibili's cap, comfortably under Douyu's. Before the cap
    // was a parameter this test could not exist, and a Douyu task was salted against
    // Bilibili's 20.
    const text = '字'.repeat(24)
    expect(text.length).toBeGreaterThan(BILIBILI_CAP)
    expect(text.length).toBeLessThan(DOUYU_CAP)

    expect(applySalt(text, { count: 2, maxLength: BILIBILI_CAP }).salted).toBe(false)
    expect(applySalt(text, { count: 2, maxLength: DOUYU_CAP }).salted).toBe(true)
  })

  it('exposes a non-empty salt alphabet', () => {
    expect(SALT_CHARS.length).toBeGreaterThan(0)
  })
})

describe('stripSalt', () => {
  it('removes injected punctuation from a salted line', () => {
    expect(stripSalt('原-始!内?容')).toBe('原 始 内 容')
  })

  it('leaves clean text intact', () => {
    expect(stripSalt('干净文本')).toBe('干净文本')
  })
})
