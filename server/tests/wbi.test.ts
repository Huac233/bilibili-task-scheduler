import { describe, expect, it } from 'vitest'

import { encodeWbi, extractWbiKeys, getMixinKey } from '../src/bilibili/wbi.js'

/**
 * WBI contract tests.
 *
 * These are the project's own pinned contract, not a mirror of someone's docs.
 * That matters now: `SocialSisterYi/bilibili-API-collect` — for years the de
 * facto Bilibili API reference — was emptied and archived in January 2026 after
 * a legal notice, and `Nemo2011/bilibili-api` followed in July 2026. The
 * successor documentation project carries almost no live-stream coverage. So
 * there is no maintained upstream to point at, and the way to notice a change
 * is to have the expected values in our own repo and let CI compare them.
 *
 * The vectors below come from the frozen pre-purge tree (recovered at
 * `cfc5fdd`, checked out locally as `recovered/pre-purge`) and are corroborated
 * by the successor project's still-current WBI page. Two independent sources
 * agreeing is what makes them worth pinning.
 */

const IMG_KEY = '7cd084941338484aae1ad9425b84077c'
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45'
const EXPECTED_MIXIN_KEY = 'ea1db124af3c7062474693fa704f4ff8'
const EXPECTED_WRID = '8f6f2b5b3d485fe1886cec6a0be8c5d4'
const WTS = 1_702_204_169

const keys = { imgKey: IMG_KEY, subKey: SUB_KEY }

describe('getMixinKey', () => {
  it('reproduces the published mixin key', () => {
    expect(getMixinKey(IMG_KEY + SUB_KEY)).toBe(EXPECTED_MIXIN_KEY)
  })

  it('yields exactly 32 characters for a well-formed key pair', () => {
    // The only caller passes `img_key + sub_key`, i.e. 64 hex characters, and
    // the function does not pad: a short input yields a short key. Asserting
    // the real invariant rather than a stronger claim that does not hold.
    expect(getMixinKey(IMG_KEY + SUB_KEY)).toHaveLength(32)
  })
})

describe('encodeWbi', () => {
  it('reproduces the published w_rid', () => {
    const query = encodeWbi({ foo: 114, bar: 514, zab: 1919810 }, keys, WTS * 1000)

    expect(query).toContain(`w_rid=${EXPECTED_WRID}`)
    expect(query).toContain(`wts=${WTS}`)
  })

  /**
   * The single most likely way to silently break signing: using form encoding
   * (`+` for space) or lowercase hex. Both produce a well-formed-looking query
   * that the server rejects, and the rejection looks like an auth failure.
   */
  it('encodes with URI semantics, not form semantics', () => {
    const query = encodeWbi({ msg: 'a b' }, keys, WTS * 1000)

    expect(query).toContain('msg=a%20b')
    expect(query).not.toContain('msg=a+b')
  })

  it('strips the characters Bilibili strips before signing', () => {
    const query = encodeWbi({ x: "a!b'c(d)e*f" }, keys, WTS * 1000)

    expect(query).toContain('x=abcdef')
  })

  /**
   * The signature covers the *sorted* parameter list, but the request carries
   * the *unsorted* one. Swapping these yields a mismatch that reads as a login
   * problem rather than a signing one.
   */
  it('signs over sorted parameters but sends them in insertion order', () => {
    const ordered = encodeWbi({ zebra: 1, alpha: 2 }, keys, WTS * 1000)
    const reversed = encodeWbi({ alpha: 2, zebra: 1 }, keys, WTS * 1000)

    expect(ordered.startsWith('zebra=1&alpha=2')).toBe(true)
    // Same parameters, different insertion order: the signature must be equal.
    const wridOf = (q: string): string => /w_rid=([0-9a-f]+)/.exec(q)?.[1] ?? ''
    expect(wridOf(ordered)).toBe(wridOf(reversed))
  })

  it('truncates the clock to whole seconds rather than rounding', () => {
    // A millisecond value in the upper half of a second must NOT round up: that
    // would stamp the signature up to a second in the future.
    expect(encodeWbi({ a: 1 }, keys, 1_700_000_000_999)).toContain('wts=1700000000')
    expect(encodeWbi({ a: 1 }, keys, 1_700_000_000_001)).toContain('wts=1700000000')
  })

  it('produces a different signature for different parameters', () => {
    const first = encodeWbi({ room_id: 1 }, keys, WTS * 1000)
    const second = encodeWbi({ room_id: 2 }, keys, WTS * 1000)
    expect(first).not.toBe(second)
  })
})

describe('extractWbiKeys', () => {
  it('reads the filename stem out of each nav URL', () => {
    const extracted = extractWbiKeys({
      data: {
        wbi_img: {
          img_url: `https://i0.hdslb.com/bfs/wbi/${IMG_KEY}.png`,
          sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB_KEY}.png`
        }
      }
    })

    expect(extracted).toEqual({ imgKey: IMG_KEY, subKey: SUB_KEY })
  })

  it('returns null when the WBI block is absent', () => {
    expect(extractWbiKeys({ data: {} })).toBeNull()
    expect(extractWbiKeys({})).toBeNull()
  })
})
