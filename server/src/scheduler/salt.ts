/**
 * Bullet salting.
 *
 * Sending the exact same string on a fixed interval is the clearest possible
 * signature of an automated sender, and both Platforms' anti-spam act on it. The
 * original backend's countermeasure was to inject a couple of random punctuation
 * characters at random positions, which is cheap, invisible to a human reader, and
 * enough to make no two sends byte-identical.
 *
 * The important constraint is the length budget, and **the cap is a property of the
 * Platform, so it is passed in and has no default here.** It used to carry its own
 * `DANMAKU_MAX_LENGTH = 20`, which was the same fact as Bilibili's
 * `ActionDescriptor.maxMessageLength` living in a second place — two copies of one
 * platform rule, which is exactly how a Douyu task ends up salted to a Bilibili
 * limit. `scheduler/runner.ts` reads it from the action descriptor.
 *
 * The two caps behave differently, which is worth knowing when reading a send log:
 * Bilibili *rejects* an over-long danmaku, while Douyu **truncates it silently** —
 * it answers success and then broadcasts only the first 70 characters.
 */

/** Characters injected by salting. All are visually innocuous in Chinese text. */
export const SALT_CHARS: readonly string[] = [' ', '-', '!', '?', '.', '~']

/** How many characters to inject by default. Matches the original backend. */
export const DEFAULT_SALT_COUNT = 2

export interface SaltOptions {
  /**
   * Hard length cap for this Platform, from the action descriptor. Required, and
   * deliberately not defaulted: a wrong cap is worse than an unusable "Off" —
   * salt that pushes a bullet over the limit turns a working task into a silently
   * truncated one.
   */
  readonly maxLength: number
  /** Number of characters to inject. */
  readonly count?: number
  /** Injectable randomness, so tests can make salting deterministic. */
  readonly random?: () => number
  /** Candidate characters. */
  readonly chars?: readonly string[]
}

export interface SaltResult {
  readonly text: string
  /** False when the bullet was left untouched because it had no room. */
  readonly salted: boolean
}

/**
 * Injects `count` random characters at random positions.
 *
 * Returns the original text unchanged when salting would overflow `maxLength`.
 * The check is done up front (rather than per-character) so a bullet either
 * gets its full salt or none — a half-salted bullet is still deterministic in
 * shape.
 */
export function applySalt(text: string, options: SaltOptions): SaltResult {
  const count = options.count ?? DEFAULT_SALT_COUNT
  const maxLength = options.maxLength
  const chars = options.chars ?? SALT_CHARS
  const random = options.random ?? Math.random

  if (count <= 0 || chars.length === 0) return { text, salted: false }
  if (text.length + count > maxLength) return { text, salted: false }
  // Refuse to salt an empty string: it would produce whitespace-only danmaku.
  if (text.length === 0) return { text, salted: false }

  let result = text
  for (let index = 0; index < count; index += 1) {
    const charIndex = Math.floor(random() * chars.length)
    const char = chars[charIndex] ?? chars[0] ?? ' '
    // Position is chosen against the *current* length so insertions spread out
    // instead of clustering at the same offset.
    const position = Math.floor(random() * (result.length + 1))
    result = result.slice(0, position) + char + result.slice(position)
  }

  return { text: result, salted: true }
}

/**
 * Strips salt characters that sit immediately next to CJK characters, which
 * produces a "cleaned" reading of a bullet. Only used for display/search —
 * never for what gets sent.
 */
export function stripSalt(text: string): string {
  return text
    .replace(/\s*[-!?.~]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
