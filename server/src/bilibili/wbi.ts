import { createHash } from 'node:crypto'

/**
 * WBI signing.
 *
 * Since 2023 Bilibili protects most write endpoints (including `/msg/send`)
 * with a per-request signature appended as `w_rid` + `wts`. Without a valid
 * signature the request is rejected with `code: -111`.
 *
 * The scheme:
 *   1. Fetch `img_key` and `sub_key` from `/x/web-interface/nav`.
 *   2. Concatenate them and permute with a fixed 64-entry table to get a
 *      32-character mixin key. The table below is copied from Bilibili's own
 *      frontend bundle (`laputa-home` vendor chunk) and is stable.
 *   3. Sort all request parameters by key, strip `!'()*`, URL-encode, join
 *      with `&`, append the mixin key, and take the MD5 hex digest.
 *   4. Send the original (unsorted) parameters plus `w_rid=<digest>&wts=<sec>`.
 *
 * Note the asymmetry in step 4: the signature is computed over the *sorted*
 * query but the request carries the *unsorted* one. Getting this backwards
 * yields a signature mismatch that looks like a login problem.
 */

export interface WbiKeys {
  readonly imgKey: string
  readonly subKey: string
}

/**
 * Permutation applied to `img_key + sub_key` to derive the mixin key.
 * Index order matters; do not reorder.
 */
const MIXIN_KEY_ENC_TAB: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52
]

/**
 * Characters Bilibili strips from parameter values before signing. They are
 * removed from the signature input as well, so the client and server agree.
 */
const CHARA_FILTER = /[!'()*]/g

export type WbiParamValue = string | number

function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

/**
 * Derives the 32-character mixin key. Uses `charAt` rather than indexing so
 * that an out-of-range table entry yields `''` instead of `undefined` — the
 * table is fixed, but this keeps the function total under
 * `noUncheckedIndexedAccess`.
 */
export function getMixinKey(orig: string): string {
  let out = ''
  for (const index of MIXIN_KEY_ENC_TAB) {
    out += orig.charAt(index)
    if (out.length === 32) break
  }
  return out.slice(0, 32)
}

function normalizeValue(value: WbiParamValue | undefined): string {
  return String(value ?? '').replace(CHARA_FILTER, '')
}

/** Renders `key=value` pairs sorted by key, URL-encoded — the signing input. */
function toSortedQuery(params: Readonly<Record<string, WbiParamValue>>): string {
  return Object.keys(params)
    .sort()
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(normalizeValue(params[key]))}`)
    .join('&')
}

/** Renders `key=value` pairs in insertion order — what actually gets sent. */
function toQuery(params: Readonly<Record<string, WbiParamValue>>): string {
  return Object.keys(params)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(normalizeValue(params[key]))}`)
    .join('&')
}

/**
 * Signs `params` and returns a ready-to-use query string that already carries
 * `w_rid` and `wts`.
 *
 * @param params Query parameters the endpoint expects (without `w_rid`/`wts`).
 * @param keys   WBI keys fetched from `/x/web-interface/nav`.
 * @param nowMs  Injectable clock for tests.
 */
export function encodeWbi(
  params: Readonly<Record<string, WbiParamValue>>,
  keys: WbiKeys,
  nowMs: number = Date.now()
): string {
  const mixinKey = getMixinKey(keys.imgKey + keys.subKey)
  // `floor`, not `round`: this is "seconds since epoch", and rounding pushes a
  // millisecond value in the upper half of any second one second into the
  // future. The signature stays self-consistent either way, which is why the
  // mistake is invisible until a server-side clock-skew check rejects it.
  const wts = Math.floor(nowMs / 1000)

  const signingInput = toSortedQuery({ ...params, wts })
  const wRid = md5Hex(signingInput + mixinKey)

  return `${toQuery(params)}&w_rid=${wRid}&wts=${wts}`
}

/**
 * Extracts the key pair from a `/x/web-interface/nav` payload. The API returns
 * full URLs (e.g. `https://i0.hdslb.com/bfs/wbi/<hex>.png`); only the filename
 * stem is used for signing.
 */
export function extractWbiKeys(nav: {
  readonly data?:
    | {
        readonly wbi_img?: { readonly img_url: string | undefined; readonly sub_url: string | undefined } | undefined
      }
    | undefined
}): WbiKeys | null {
  const imgUrl = nav.data?.wbi_img?.img_url
  const subUrl = nav.data?.wbi_img?.sub_url
  if (!imgUrl || !subUrl) return null

  const imgKey = stemOf(imgUrl)
  const subKey = stemOf(subUrl)
  if (!imgKey || !subKey) return null

  return { imgKey, subKey }
}

/** Pulls the filename stem out of a URL: `.../abc123.png` -> `abc123`. */
function stemOf(url: string): string {
  const lastSegment = url.split('/').pop() ?? ''
  return lastSegment.split('.')[0] ?? ''
}
