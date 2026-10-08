import { describe, expect } from 'vitest'

import type { Db } from '../src/db/index.js'
import {
  deleteAccount,
  getAccount,
  getAccountCookies,
  getAccountCookiesById,
  getAccountCredentialById,
  listAccounts,
  listRefreshableAccountIds,
  updateAccountCredential,
  upsertAccount
} from '../src/repo/bili-accounts.js'
import { test as it } from './fixtures.js'

/**
 * The Bilibili account shim.
 *
 * `bili_accounts` is gone; every caller written against it — the binding routes,
 * the account-client factory, the session-refresh sweep — still names these
 * functions. What has to hold is that the translation is complete and one-way:
 * callers speak `uid` / `uname` / `face` / `cookies`, and the platform-neutral
 * `accounts` row speaks `external_id` / `display_name` / `avatar` / a credentials
 * JSON blob.
 *
 * The other half is isolation. A Douyu account must not resolve through a
 * Bilibili-shaped reader, and it must not appear to the refresh sweep: the
 * failure that would cause — a Bilibili cookie jar parsed out of a Douyu
 * credential — is not one that announces itself.
 */

const COOKIE_JAR = '[{"name":"SESSDATA","value":"x"}]'
const OTHER_JAR = '[{"name":"SESSDATA","value":"y"}]'

// The user row every case below binds an account to. A hook rather than a line in a
// `beforeEach` beside a `let db`: asking for `db` is what opens the database, so the
// fixture the cases declare is the same one this runs against.
it.beforeEach(({ db }) => {
  seedUser(db)
})

function seedUser(db: Db): void {
  db.prepare("INSERT INTO users (username, password_hash, created_at, updated_at) VALUES ('tester', 'x', 0, 0)").run()
}

function bind(db: Db, overrides: { refreshToken?: string } = {}): number {
  return upsertAccount(db, 1, {
    uid: '987654',
    uname: '测试账号',
    face: 'https://i0.hdslb.com/face.jpg',
    cookies: COOKIE_JAR,
    ...overrides
  }).id
}

/** A bound account of another Platform, with a token of its own. */
function bindDouyu(db: Db): number {
  const info = db
    .prepare(
      `INSERT INTO accounts (user_id, platform, external_id, display_name, avatar, credentials, meta, created_at, updated_at)
       VALUES (1, 'douyu', '456918967', '斗鱼主号', '', '{"token":"456918967_1_stk_0_1","did":"abc"}', '{}', 0, 0)`
    )
    .run()
  return Number(info.lastInsertRowid)
}

describe('upsertAccount', () => {
  it('writes the platform-neutral columns and packs the credentials into the blob', ({ db }) => {
    const id = bind(db, { refreshToken: 'ac-time-value' })

    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)
    expect(row?.['platform']).toBe('bilibili')
    expect(row?.['external_id']).toBe('987654')
    expect(row?.['display_name']).toBe('测试账号')
    expect(row?.['avatar']).toBe('https://i0.hdslb.com/face.jpg')
    expect(JSON.parse(String(row?.['credentials']))).toEqual({ cookies: COOKIE_JAR, refreshToken: 'ac-time-value' })

    // The caller sees the Bilibili shape, never the blob.
    const account = listAccounts(db, 1)[0]
    expect(account?.uid).toBe('987654')
    expect(account?.uname).toBe('测试账号')
    expect(account?.face).toBe('https://i0.hdslb.com/face.jpg')
  })

  it('re-binds in place, keeping the row id the tasks point at', ({ db }) => {
    const first = bind(db, { refreshToken: 'old' })
    const second = bind(db, { refreshToken: 'new' })

    expect(second).toBe(first)
    expect(listAccounts(db, 1)).toHaveLength(1)
    expect(getAccountCredentialById(db, first)?.refreshToken).toBe('new')
  })

  it('does not clobber a meta field another writer owns', ({ db }) => {
    const id = bind(db)
    db.prepare('UPDATE accounts SET meta = \'{"refreshable":true}\' WHERE id = ?').run(id)

    bind(db, { refreshToken: 'new' })

    const row = db.prepare('SELECT meta FROM accounts WHERE id = ?').get(id)
    expect(JSON.parse(String(row?.['meta']))).toEqual({ refreshable: true })
  })

  it('defaults the refresh token to empty rather than writing null', ({ db }) => {
    const id = bind(db)

    const row = db.prepare('SELECT credentials FROM accounts WHERE id = ?').get(id)
    expect(JSON.parse(String(row?.['credentials']))).toEqual({ cookies: COOKIE_JAR, refreshToken: '' })
  })
})

describe('listing and reading', () => {
  it('lists one user\u2019s Bilibili accounts only', ({ db }) => {
    bind(db)
    bindDouyu(db)

    expect(listAccounts(db, 1)).toHaveLength(1)
    expect(listAccounts(db, 1)[0]?.uid).toBe('987654')
  })

  it('returns the raw cookie jar, not the blob', ({ db }) => {
    const id = bind(db, { refreshToken: 'ac-time-value' })

    expect(getAccountCookies(db, 1, id)).toBe(COOKIE_JAR)
    expect(getAccountCookiesById(db, id)).toBe(COOKIE_JAR)
    // The blob itself must never leak through either reader.
    expect(String(getAccountCookiesById(db, id))).not.toContain('refreshToken')
  })

  it('scopes the cookie read to its owner', ({ db }) => {
    const id = bind(db)
    db.prepare("INSERT INTO users (username, password_hash, created_at, updated_at) VALUES ('nosy', 'x', 0, 0)").run()

    expect(getAccountCookies(db, 2, id)).toBeNull()
    expect(getAccount(db, 2, id)).toBeNull()
    expect(getAccount(db, 1, id)?.uid).toBe('987654')
  })

  it('returns both credential fields, and null when there is nothing to read', ({ db }) => {
    const id = bind(db, { refreshToken: 'ac-time-value' })

    expect(getAccountCredentialById(db, id)).toEqual({ cookies: COOKIE_JAR, refreshToken: 'ac-time-value' })
    expect(getAccountCredentialById(db, 999_999)).toBeNull()
  })

  it('refuses to read a Douyu account through a Bilibili-shaped reader', ({ db }) => {
    const douyu = bindDouyu(db)

    // Its credentials carry no `cookies` key; the honest answer is "no session",
    // not a jar parsed out of another Platform's blob.
    expect(getAccountCredentialById(db, douyu)).toBeNull()
    expect(getAccountCookiesById(db, douyu)).toBeNull()
    expect(getAccount(db, 1, douyu)).toBeNull()
  })
})

describe('updateAccountCredential', () => {
  it('renews the two fields it owns and leaves the rest of the blob alone', ({ db }) => {
    const id = bind(db, { refreshToken: 'old' })
    db.prepare(
      'UPDATE accounts SET credentials = \'{"cookies":"[]","refreshToken":"old","did":"abc"}\' WHERE id = ?'
    ).run(id)

    updateAccountCredential(db, id, OTHER_JAR, 'new', 4242)

    const stored = getAccountCredentialById(db, id)
    expect(stored).toEqual({ cookies: OTHER_JAR, refreshToken: 'new' })

    const row = db.prepare('SELECT credentials, updated_at FROM accounts WHERE id = ?').get(id)
    expect(JSON.parse(String(row?.['credentials']))).toEqual({ cookies: OTHER_JAR, refreshToken: 'new', did: 'abc' })
    expect(row?.['updated_at']).toBe(4242)
  })

  it('does nothing for an account that is not a Bilibili one', ({ db }) => {
    const douyu = bindDouyu(db)

    updateAccountCredential(db, douyu, COOKIE_JAR, 'new', 4242)

    const row = db.prepare('SELECT credentials, updated_at FROM accounts WHERE id = ?').get(douyu)
    expect(row?.['updated_at']).toBe(0)
    expect(String(row?.['credentials'])).not.toContain('SESSDATA')
  })
})

describe('listRefreshableAccountIds', () => {
  it('finds the accounts that carry a refresh token, and only those', ({ db }) => {
    const refreshable = bind(db, { refreshToken: 'ac-time-value' })

    // Same user, same Platform, no refresh token: nothing for the sweep to do.
    upsertAccount(db, 1, { uid: '111', uname: '无 token', face: '', cookies: OTHER_JAR })

    // Another Platform with a token in its own blob shape must not be picked up.
    bindDouyu(db)

    expect(listRefreshableAccountIds(db)).toEqual([{ id: refreshable, userId: 1 }])
  })

  it('stops finding an account once its token has been cleared', ({ db }) => {
    const id = bind(db, { refreshToken: 'ac-time-value' })
    expect(listRefreshableAccountIds(db)).toHaveLength(1)

    updateAccountCredential(db, id, COOKIE_JAR, '')

    expect(listRefreshableAccountIds(db)).toEqual([])
  })
})

describe('deleteAccount', () => {
  it('unbinds a Bilibili account and reports it', ({ db }) => {
    const id = bind(db)

    expect(deleteAccount(db, 1, id)).toBe(true)
    expect(listAccounts(db, 1)).toEqual([])
    expect(deleteAccount(db, 1, id)).toBe(false)
  })

  it('refuses to unbind an account of another Platform', ({ db }) => {
    const douyu = bindDouyu(db)

    expect(deleteAccount(db, 1, douyu)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()?.['n']).toBe(1)
  })
})
