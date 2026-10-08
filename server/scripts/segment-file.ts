/**
 * Manual harness: run the segmenter against a real file and print stats.
 *
 * Usage: pnpm exec tsx scripts/segment-file.ts <path> [maxLength]
 *
 * Kept as a script rather than a test because it depends on a file that is not
 * in the repository; the unit-level behaviour is covered by vitest.
 */
import { readFileSync } from 'node:fs'

import { DEFAULT_SEGMENT_OPTIONS, segmentText, summarize } from '../src/text/segment.js'

const path = process.argv[2] ?? 'D:/Downloads/龙族.txt'
const maxLength = Number.parseInt(process.argv[3] ?? String(DEFAULT_SEGMENT_OPTIONS.maxLength), 10)

const text = readFileSync(path, 'utf8')
console.log(`input : ${path}`)
console.log(`chars : ${text.length}`)

const started = performance.now()
const result = segmentText(text, { maxLength })
const elapsed = performance.now() - started

const summary = summarize(result.bullets)

console.log(`elapsed      : ${elapsed.toFixed(0)} ms`)
console.log(`bullets      : ${summary.count}`)
console.log(`total chars  : ${summary.totalChars}`)
console.log(`avg length   : ${(summary.totalChars / Math.max(1, summary.count)).toFixed(1)}`)
console.log(`min / max    : ${summary.minChars} / ${summary.maxChars}`)
console.log(`stats        : ${JSON.stringify(result.stats)}`)

console.log('\nfirst 10 bullets:')
for (const bullet of result.bullets.slice(0, 10)) console.log(`  [${bullet.length}] ${bullet}`)

console.log('\nlongest 5 bullets:')
const longest = [...result.bullets].sort((a, b) => b.length - a.length).slice(0, 5)
for (const bullet of longest) console.log(`  [${bullet.length}] ${bullet}`)
