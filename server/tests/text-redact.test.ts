import { describe, expect, it } from 'vitest'

import { REDACTED, redactCredentialParameters, redactSecrets } from '../src/text/redact.js'

/**
 * The redaction rules, at their own seam.
 *
 * These two functions are the whole of "a credential does not survive into a sentence"
 * for this project — the value rule and the parameter-name rule. Both used to exist in
 * five copies, and the copies had already disagreed: `platform/douyu/errors.ts` redacted
 * the URL of an error while the sentence built from the same exchange carried the token
 * untouched.
 *
 * The assertions below pin the *narrower* halves as hard as the broader ones: a merge
 * that loses `csrfToken=` staying readable, or the empty-value guard, is worse than the
 * duplication was.
 */

const CSRF = 'jct-value'
const TOKEN = 'aBcD1234compositeToken'
/** The `dy_cookie` value of the recorded FANSHOME capture (`protocol.ts` quotes the same hex). */
const DY_COOKIE = 'c15c797cbe859a50731ffe6a3c041aa6'

describe('redactSecrets', () => {
  it('replaces every occurrence of each value', () => {
    const text = `token ${TOKEN} and again ${TOKEN}`
    expect(redactSecrets(text, TOKEN)).toBe(`token ${REDACTED} and again ${REDACTED}`)
  })

  it('accepts one value or a list of them', () => {
    expect(redactSecrets('sent one and two', ['one', 'two'])).toBe(`sent ${REDACTED} and ${REDACTED}`)
    expect(redactSecrets('sent one', 'one')).toBe(`sent ${REDACTED}`)
  })

  it('skips an empty value instead of splicing a marker between every character', () => {
    // `replaceAll('', …)` would turn "abc" into "<redacted>a<redacted>b…" — destroying
    // the diagnostic it was meant to protect.
    expect(redactSecrets('abc', '')).toBe('abc')
  })

  it('leaves a sentence that holds none of the values alone', () => {
    expect(redactSecrets('请求过于频繁', [CSRF, TOKEN])).toBe('请求过于频繁')
  })
})

describe('redactCredentialParameters', () => {
  it('removes the value of every credential-bearing parameter name', () => {
    const query = 'rid=1&token=abc&dy_token=def&jwt_token=ghi'
    expect(redactCredentialParameters(query)).toBe(`rid=1&token=${REDACTED}&dy_token=${REDACTED}&jwt_token=${REDACTED}`)
  })

  it('covers the Bilibili names as well as the Douyu ones', () => {
    const url = 'https://passport.bilibili.com/x?csrf=1&csrf_token=2&refresh_token=3&qrcode_key=4&ticket=5'
    expect(redactCredentialParameters(url)).toBe(
      `https://passport.bilibili.com/x?csrf=${REDACTED}&csrf_token=${REDACTED}&refresh_token=${REDACTED}&qrcode_key=${REDACTED}&ticket=${REDACTED}`
    )
  })

  it('redacts both cookie names when a jar is rendered as a header', () => {
    const header = `SESSDATA=sess-value; bili_jct=${CSRF}`
    expect(redactCredentialParameters(header)).toBe(`SESSDATA=${REDACTED}; bili_jct=${REDACTED}`)
  })

  it('keeps csrfToken= readable, which is why the leading word boundary is there', () => {
    // `csrfToken` is a different parameter that genuinely appears in a Douyu `doSign`
    // body, and its value is not a credential. Reading the marker as "author forgot"
    // and dropping the `\b` would redact it and turn a diagnostic into a puzzle.
    //
    // This is also why the two `acf_` cookies below are listed *by name* instead: their
    // prefix is a word character, so no `\b`-anchored alternative can start inside them, and
    // the boundary that would reach them is the same one that redacts this parameter.
    expect(redactCredentialParameters(`&csrfToken=${TOKEN}`)).toBe(`&csrfToken=${TOKEN}`)
  })

  it('removes the dy_cookie a refusal sentence can echo back', () => {
    // The gate that guards a *business refusal* — `protocol.ts`'s `settle` — applies this rule
    // and carries no values at all, so when a service echoes the request back into its own prose
    // the cookie header `apiV2Headers` sends (`cookie: dy_cookie=<value>`, byte for byte) has
    // nothing but its name to catch it. `dy_cookie` was absent from the list, and that is the
    // shape that leaked: every other call site happens to hold the token and the cookie as values.
    const echoed = `请求异常：cookie: dy_cookie=${DY_COOKIE}; token=${TOKEN}`
    const safe = redactCredentialParameters(echoed)

    expect(safe).not.toContain(DY_COOKIE)
    expect(safe).toBe(`请求异常：cookie: dy_cookie=${REDACTED}; token=${REDACTED}`)
  })

  it('covers the session cookies the leading word boundary cannot reach', () => {
    // `acf_auth` and `acf_jwt_token` are the two cookies the web session's account credential is
    // carried in, and neither can be matched from a `\b`: the prefix `acf_` ends in a word
    // character. They are named in the list rather than reached by loosening the anchor — the
    // boundary that would reach them is the one `csrfToken=` and `_token=` above are pinned against.
    expect(redactCredentialParameters('acf_auth=1_1_abcdef; acf_jwt_token=eyJhbGci.payload.signature')).toBe(
      `acf_auth=${REDACTED}; acf_jwt_token=${REDACTED}`
    )
  })

  it('does not match a shorter name inside a longer one', () => {
    expect(redactCredentialParameters('_token=abc')).toBe('_token=abc')
    expect(redactCredentialParameters('notatoken=abc')).toBe('notatoken=abc')
  })

  it('stops the value at the delimiters a URL, a body and a header use', () => {
    // Without the delimiters the rest of the line would be swallowed and the message
    // would become unreadable rather than redacted.
    expect(redactCredentialParameters('token=abc&next=1')).toBe(`token=${REDACTED}&next=1`)
    expect(redactCredentialParameters('token=abc next')).toBe(`token=${REDACTED} next`)
    expect(redactCredentialParameters('name=keep; token=abc')).toBe(`name=keep; token=${REDACTED}`)
  })

  it('covers only the name=value shape, as documented', () => {
    // A JSON body and a multipart body are the *value* rule's job, at the call site
    // that knows the value it sent. Pinned here so the limit is a decision on record
    // rather than something a reader has to discover.
    expect(redactCredentialParameters('{"token":"abc"}')).toBe('{"token":"abc"}')
    expect(redactCredentialParameters('name="csrf"')).toBe('name="csrf"')
  })

  it('leaves a sentence with no credential parameter alone', () => {
    expect(redactCredentialParameters('房间 12306 的弹幕发送失败')).toBe('房间 12306 的弹幕发送失败')
  })
})
