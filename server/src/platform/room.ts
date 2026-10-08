/**
 * What a Room's key looks like, once a person has pasted one.
 *
 * Both adapters accept a pasted room reference and both then have to answer the same
 * question about it: is this a room number at all? The rule — decimal, at most 15
 * digits, positive — is a property of the seam rather than of either Platform, so it
 * lives here and each adapter keeps only the part that differs: which hosts it will
 * read a link from, and whether a non-numeric path might be a vanity slug.
 */

/** Room numbers are decimal and fit in 15 digits; anything else is a typo, not an id. */
const ROOM_ID_PATTERN = /^\d{1,15}$/

/**
 * Reads a room number, or null.
 *
 * The pattern is checked before `parseInt` on purpose: `parseInt` stops at the first
 * character it cannot read, so `Number.parseInt('605abc', 10)` would quietly become
 * room 605 — a valid-looking id that belongs to somebody else.
 */
export function roomIdOf(value: string): number | null {
  if (!ROOM_ID_PATTERN.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}
