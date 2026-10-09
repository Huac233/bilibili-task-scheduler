import { z } from 'zod'

import { buildCredential, credentialToCookies, credentialToSessionCookies } from '../../bilibili/credential.js'
import { BiliHttp, CookieJar, DEFAULT_TIMEOUT_MS } from '../../bilibili/http.js'

/**
 * The Bilibili credential blob, and how it becomes a client.
 *
 * `accounts.credentials` is opaque to everything above the seam, so its shape is
 * this adapter's business alone:
 *
 *     { "cookies": "<JSON string of a cookie map>", "refreshToken": "<string>" }
 *
 * `cookies` is a string *inside* the JSON rather than a nested object because two
 * existing writers already produce exactly that: the migration off the legacy
 * `bili_accounts` table and the QR binding route. A second shape would mean the
 * same account read differently depending on who wrote it, so this module reads
 * that one and writes it back unchanged.
 *
 * Nothing here logs, throws, or puts a cookie in a message. A jar is a bearer
 * credential: `SESSDATA` alone is enough to act as the account.
 */

/** The credential as this adapter uses it: a cookie map plus the renewal token. */
export interface ParsedCredential {
  readonly cookies: Record<string, string>
  readonly refreshToken: string
}

const storedCredentialSchema = z.object({
  cookies: z.string(),
  /** Absent in blobs written before renewal existed; that is "not refreshable", not "unreadable". */
  refreshToken: z.string().optional()
})

const cookieMapSchema = z.record(z.string(), z.unknown())

/**
 * Reads a stored credential, or null when the blob is unusable.
 *
 * Null rather than a throw: an unreadable credential is a state a person has to
 * fix by re-binding, which the adapters report as `account_stop` — it is not a
 * programming error.
 */
export function parseCredential(blob: string): ParsedCredential | null {
  const stored = parseStored(storedCredentialSchema, blob)
  if (stored === null) return null

  const cookies = readCookieMap(stored.cookies)
  // A blob holding no cookies is not a credential either: the client it produced
  // could only ever be rejected, and saying so now saves a round trip.
  if (cookies === null || Object.keys(cookies).length === 0) return null

  return { cookies, refreshToken: stored.refreshToken ?? '' }
}

/**
 * Builds a client that replays the credential's cookies on every call.
 *
 * The ceiling is passed explicitly so that "an adapter call can never hang" is
 * stated here, and it is the transport's own exported name for it rather than this
 * module's copy of the number: `index.ts`'s anonymous clients take the same name, so
 * there is one 15 s per stack rather than two that can drift.
 */
export function clientFor(credential: ParsedCredential): BiliHttp {
  return new BiliHttp({
    cookies: CookieJar.fromJSON(credential.cookies),
    timeoutMs: DEFAULT_TIMEOUT_MS
  })
}

/**
 * A client for the reads that are not the account's own business, but that Bilibili answers only to a
 * logged-in caller — the Anchor's name today.
 *
 * **Deliberately a second builder beside `clientFor` rather than a widening of it, and the reason is the
 * one a later reader is most likely to erase.** `clientFor` replays the whole stored jar, device cookies
 * included, and that is *right* for the account's own operations: a send, a like or a medal read is the
 * account acting, Bilibili risk-controls those, and its risk control reads the device fingerprint. This one
 * is for a read of somebody else's public data — the same Anchor name whoever asks — where the measurement
 * says the three session cookies suffice and `buvid3` adds nothing (the table is
 * `bilibili/credential.ts`'s `credentialToSessionCookies`, which is also where the set is defined). They
 * look like the same builder with a narrower jar; they are two contracts, and neither is the other's
 * special case.
 *
 * The ceiling is passed for the same reason `clientFor` passes it: one 15 s per stack, from the
 * transport's own name for it.
 */
export function sessionClientFor(credential: ParsedCredential): BiliHttp {
  const session = credentialToSessionCookies(buildCredential(credential.cookies, credential.refreshToken))
  return new BiliHttp({ cookies: CookieJar.fromJSON(session), timeoutMs: DEFAULT_TIMEOUT_MS })
}

/**
 * True when two cookie maps carry the same credential.
 *
 * Compared after narrowing, because the caller's question is "did the credential
 * change" and not "did the jar change": a jar also picks up incidental cookies
 * (Bilibili sets a few per page), and a renewal that only added one of those has
 * changed nothing a caller should persist.
 */
export function cookiesEqual(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>
): boolean {
  const a = canonicalCookies(before)
  const b = canonicalCookies(after)
  const names = Object.keys(a)
  if (names.length !== Object.keys(b).length) return false
  return names.every(name => a[name] === b[name])
}

/** Renders a jar as the blob shape above, so a renewal is stored like a binding. */
export function serializeCredential(cookies: Readonly<Record<string, string>>, refreshToken: string): string {
  return JSON.stringify({ cookies: JSON.stringify(canonicalCookies(cookies)), refreshToken })
}

/**
 * Narrows a jar to the cookies that make up a credential.
 *
 * Both the comparison and the write go through here, so "changed" and "saved"
 * cannot disagree about which cookies count. The set is the login path's: the two
 * device fingerprint cookies included, because Bilibili's risk control reads them
 * and a session that has lost them starts failing in ways that look like rate
 * limiting.
 */
function canonicalCookies(cookies: Readonly<Record<string, string>>): Record<string, string> {
  return credentialToCookies(buildCredential(cookies))
}

/**
 * Keeps only the string-valued entries of a cookie map.
 *
 * `buvid3` and friends arrive as strings; anything else in there is not a cookie
 * and is dropped rather than stringified into one.
 */
function readCookieMap(json: string): Record<string, string> | null {
  const parsed = parseStored(cookieMapSchema, json)
  if (parsed === null) return null

  const cookies: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string') cookies[name] = value
  }
  return cookies
}

/** Parses JSON against a schema, returning null instead of throwing: this is stored state, not a request. */
function parseStored<T>(schema: z.ZodType<T>, json: string): T | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }

  const result = schema.safeParse(parsed)
  return result.success ? result.data : null
}
