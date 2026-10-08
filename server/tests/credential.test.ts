import { describe, expect, it } from 'vitest'

import {
  buildCredential,
  credentialToCookies,
  describeCredential,
  extractCredentialFromUrl,
  isCredentialComplete,
  isCredentialRefreshable,
  isCrossDomainLoginUrl
} from '../src/bilibili/credential.js'

const fullCookies = {
  SESSDATA: 'sess-value',
  bili_jct: 'jct-value',
  buvid3: 'buvid3-value',
  buvid4: 'buvid4-value',
  DedeUserID: '12345'
}

describe('isCrossDomainLoginUrl', () => {
  it('detects the crossDomain hop', () => {
    const url = 'https://passport.biligame.com/crossDomain?ticket=abc123'
    expect(isCrossDomainLoginUrl(url)).toBe(true)
  })

  it('rejects an ordinary login redirect', () => {
    const url = 'https://passport.bilibili.com/login?SESSDATA=x'
    expect(isCrossDomainLoginUrl(url)).toBe(false)
  })

  it('rejects a crossDomain shape without a ticket', () => {
    expect(isCrossDomainLoginUrl('https://passport.biligame.com/crossDomain')).toBe(false)
  })

  it('rejects unrelated hosts', () => {
    expect(isCrossDomainLoginUrl('https://evil.example.com/crossDomain?ticket=x')).toBe(false)
  })

  it('returns false for malformed input instead of throwing', () => {
    expect(isCrossDomainLoginUrl('not a url')).toBe(false)
    expect(isCrossDomainLoginUrl('')).toBe(false)
  })
})

describe('extractCredentialFromUrl', () => {
  it('reads every field off the query string', () => {
    const url = 'https://passport.bilibili.com/login?' + 'SESSDATA=s1&bili_jct=j1&buvid3=b3&buvid4=b4&DedeUserID=42'

    const credential = extractCredentialFromUrl(url, 'refresh-token')

    expect(credential).toEqual({
      sessdata: 's1',
      biliJct: 'j1',
      buvid3: 'b3',
      buvid4: 'b4',
      dedeUserId: '42',
      acTimeValue: 'refresh-token'
    })
  })

  it('yields empty strings when parameters are absent', () => {
    const credential = extractCredentialFromUrl('https://example.com/')
    expect(credential.sessdata).toBe('')
    expect(credential.biliJct).toBe('')
    expect(credential.dedeUserId).toBe('')
  })

  it('does not throw on a malformed url', () => {
    expect(() => extractCredentialFromUrl('::::')).not.toThrow()
  })
})

describe('buildCredential', () => {
  it('maps cookie names case-sensitively as Bilibili sends them', () => {
    const credential = buildCredential(fullCookies, 'rt')
    expect(credential.sessdata).toBe('sess-value')
    expect(credential.biliJct).toBe('jct-value')
    expect(credential.buvid3).toBe('buvid3-value')
    expect(credential.dedeUserId).toBe('12345')
    expect(credential.acTimeValue).toBe('rt')
  })

  it('substitutes empty strings for missing cookies', () => {
    const credential = buildCredential({ SESSDATA: 'only' })
    expect(credential.biliJct).toBe('')
    expect(credential.buvid3).toBe('')
  })
})

describe('isCredentialComplete', () => {
  it('accepts a credential with the three required fields', () => {
    expect(isCredentialComplete(buildCredential(fullCookies))).toBe(true)
  })

  it('rejects one missing the CSRF token', () => {
    expect(isCredentialComplete(buildCredential({ SESSDATA: 'a', DedeUserID: '1' }))).toBe(false)
  })

  it('does not require the buvid fingerprint cookies', () => {
    const minimal = buildCredential({ SESSDATA: 'a', bili_jct: 'b', DedeUserID: '1' })
    expect(isCredentialComplete(minimal)).toBe(true)
  })
})

describe('isCredentialRefreshable', () => {
  it('requires a refresh token on top of the required fields', () => {
    expect(isCredentialRefreshable(buildCredential(fullCookies, 'rt'))).toBe(true)
    expect(isCredentialRefreshable(buildCredential(fullCookies, ''))).toBe(false)
  })
})

describe('credentialToCookies', () => {
  it('emits the required cookies', () => {
    const cookies = credentialToCookies(buildCredential(fullCookies, 'rt'))
    expect(cookies['SESSDATA']).toBe('sess-value')
    expect(cookies['bili_jct']).toBe('jct-value')
    expect(cookies['DedeUserID']).toBe('12345')
  })

  it('omits buvid entries when they are empty', () => {
    const cookies = credentialToCookies(buildCredential({ SESSDATA: 'a', bili_jct: 'b', DedeUserID: '1' }))
    expect('buvid3' in cookies).toBe(false)
    expect('buvid4' in cookies).toBe(false)
  })

  it('never sends the refresh token as a cookie', () => {
    const cookies = credentialToCookies(buildCredential(fullCookies, 'secret-refresh'))
    expect(Object.values(cookies)).not.toContain('secret-refresh')
    expect('ac_time_value' in cookies).toBe(false)
  })
})

describe('describeCredential', () => {
  it('never includes the actual secret values', () => {
    const summary = describeCredential(buildCredential(fullCookies, 'secret-refresh'))
    expect(summary).not.toContain('sess-value')
    expect(summary).not.toContain('jct-value')
    expect(summary).not.toContain('secret-refresh')
  })

  it('reports presence and uid for diagnostics', () => {
    const summary = describeCredential(buildCredential(fullCookies, 'rt'))
    expect(summary).toContain('uid=12345')
    expect(summary).toContain('refreshable=yes')
  })

  it('marks missing fields explicitly', () => {
    const summary = describeCredential(buildCredential({}))
    expect(summary).toContain('uid=<missing>')
    expect(summary).toContain('sessdata=missing')
    expect(summary).toContain('refreshable=no')
  })
})
