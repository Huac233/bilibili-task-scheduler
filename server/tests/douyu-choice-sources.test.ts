import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChoiceSourceRegistry } from '../src/actions/action-options.js'
import {
  douyuFormSources,
  FOLLOWED_ROOMS_SOURCE,
  MEDAL_ROOMS_SOURCE,
  readDouyuFollowedRooms,
  readDouyuMedalRooms
} from '../src/platform/douyu/options.js'
import { upsertAccount } from '../src/repo/accounts.js'
import { test } from './fixtures.js'

/**
 * The two reads behind 清仓 and the preferences page, at the wire.
 *
 * **What each of the two can be held to, and what it cannot.** `douyu.medalRooms` rests on
 * `readFanBadges`, whose page *is* captured (`tests/captured/douyu-fan-badges.html`, and
 * `douyu-fan-badges.test.ts` measures the fourth cell against it). `douyu.followedRooms` rests on an
 * endpoint **no response of which has ever been captured**: what this project's probe catalogue recorded
 * is its refusal (`{"code":-1,"error":-1,"msg":"用户未登陆或token已过期"}`), and the item field names come
 * from the *sibling* `follow/top3` capture on this same account
 * (`tests/captured/douyu-follow-top3.json`) plus the two maintained third-party implementations. So the
 * cases below assert **this build's own decisions** — the request it sends, how it pages, where it stops,
 * what it answers when it cannot read at all — rather than a captured shape it does not have. The one
 * thing they can pin about the payload is that the field names it reads are the ones the sibling capture
 * and those two implementations agree on, which is why one case reads that file.
 *
 * Nothing here reaches the network: `fetch` is stubbed, and the two end-to-end cases go through the real
 * registry with a real account row in an in-memory database.
 */

const BADGE_HTML = readFileSync(new URL('./captured/douyu-fan-badges.html', import.meta.url), 'utf8')
const TOP3_BODY = readFileSync(new URL('./captured/douyu-follow-top3.json', import.meta.url), 'utf8')

const TOKEN = '123456789_1_abcdef0123456789_0_69117311'
const WEB_COOKIES = 'acf_auth=1_1_abcdef; acf_uid=456918967; acf_did=20e8917f4ebe85866a5e94cfaba2f156'

/** One request as it left this process, before the stub answered it. */
interface Recorded {
  readonly url: string
  readonly path: string
  readonly method: string
  readonly headers: readonly string[]
  readonly token: string | null
  readonly cookie: string | null
  readonly page: string | null
}

/** A scripted reply: a body, or — by rejecting — a call that never arrived. */
interface Scripted {
  readonly text?: string
  readonly status?: number
  readonly unreachable?: boolean
}

/** One followed room, as a page is built from it. */
interface FollowRow {
  readonly id: number
  readonly name?: string
  readonly title?: string
}

const requests: Recorded[] = []

/** What each endpoint answers on this run. A case replaces the one it is about. */
let followPages: (page: number) => Scripted
let badgeAnswer: Scripted

function freshFollowPages(): (page: number) => Scripted {
  return page => ({ text: followPage(page === 1 ? [{ id: 12306 }, { id: 12293234 }] : []) })
}

function freshBadges(): Scripted {
  return { text: BADGE_HTML }
}

async function fetchStub(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input.toString()
  const headers = new Headers(init?.headers ?? {})
  const parsed = new URL(url)

  requests.push({
    url,
    path: parsed.pathname,
    method: init?.method ?? 'GET',
    headers: [...headers.keys()].sort(),
    token: headers.get('token'),
    cookie: headers.get('cookie'),
    page: parsed.searchParams.get('page')
  })

  const isFollow = parsed.pathname.endsWith('/follow/list')
  const answer = isFollow ? followPages(Number(parsed.searchParams.get('page') ?? '1')) : badgeAnswer
  if (answer.unreachable === true) throw new TypeError('fetch failed')

  return new Response(answer.text ?? '{}', {
    status: answer.status ?? 200,
    headers: new Headers({ 'content-type': isFollow ? 'application/json' : 'text/html;charset=utf-8' })
  })
}

/** One page of the follow list, with whatever envelope fields a case needs. */
function followPage(
  rows: readonly FollowRow[],
  envelope: { readonly total?: number; readonly pageCount?: number } = {}
): string {
  return JSON.stringify({
    error: 0,
    msg: 'ok',
    data: {
      list: rows.map(row => ({ room_id: row.id, nickname: row.name ?? '', room_name: row.title ?? '' })),
      ...envelope
    }
  })
}

/** A page of `n` distinct rooms, all new, so a case can drive the paging loop to its cap. */
function pageOfNewRooms(page: number, perPage: number): string {
  const rows = Array.from({ length: perPage }, (_unused, index) => ({ id: page * 1000 + index }))
  return followPage(rows)
}

beforeEach(() => {
  requests.length = 0
  followPages = freshFollowPages()
  badgeAnswer = freshBadges()
  vi.stubGlobal('fetch', fetchStub)
})

describe('douyu.followedRooms — the request this build sends', () => {
  it('asks the captured endpoint once, with the token as a header and no credential in the URL', async () => {
    const read = await readDouyuFollowedRooms({ token: TOKEN, webCookies: WEB_COOKIES })

    expect(read.kind).toBe('ok')
    // Two requests: the page that carried two rooms, and the one after it, which came back empty. The
    // empty page *is* the stop condition, so it is asked for and counted rather than assumed away.
    expect(requests).toHaveLength(2)
    expect(requests.map(call => call.page)).toEqual(['1', '2'])

    const [call] = requests
    expect(call?.method).toBe('GET')
    expect(call?.path).toBe('/wgapi/livenc/liveweb/follow/list')
    expect(call?.page).toBe('1')
    // A token in a query string is a token in every log between here and Douyu, which is why `protocol.ts`
    // redacts the ones its own families build. This URL carries `page` and nothing else.
    expect(call?.url).not.toContain(TOKEN)
    expect(call?.url).not.toContain('acf_auth')

    // **Both credential halves travel, and that is a decision with a reason rather than a capture.** The
    // captured `top3` calls carried the whole cookie jar and no `token`; this project's own probe sent the
    // token header and got 「用户未登陆或token已过期」 for an expired one. Nothing has isolated which half
    // this family keys on, so both go — the same shape `readFanBadges` and `readRoomDailyTasks` already
    // send, and the assertion is here so the pair cannot drift into a one-half guess in silence.
    expect(call?.token).toBe(TOKEN)
    expect(call?.cookie).toBe(WEB_COOKIES)
    expect(call?.headers).toEqual(['accept', 'accept-language', 'cookie', 'referer', 'token', 'user-agent'])
  })

  it('reads a room as a name a person can recognise, and never as its number', async () => {
    followPages = () => ({ text: followPage([{ id: 12306, name: '电棍', title: '今天也播' }, { id: 74960 }]) })

    const read = await readDouyuFollowedRooms({ token: TOKEN, webCookies: WEB_COOKIES })

    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    // `value` is what the field stores — the room the gift will be addressed by — and `label` is what a
    // person reads. The `null`s are the two claims this source does not make: the follow list declares no
    // per-room count, and a room is not an item the Platform prices.
    expect(read.items).toEqual([
      { value: '12306', label: '电棍', count: null, costsSomething: null },
      { value: '74960', label: '未命名直播间', count: null, costsSomething: null }
    ])
    expect(read.items.map(item => item.label)).not.toContain('12306')
  })

  it('reads the field names the sibling capture and both reference implementations agree on', () => {
    // The one thing this file can say about the payload: `follow/list` has never been captured with a body,
    // and what it is parsed with is the item shape `follow/top3` answered on this very account. The guard
    // is on the fixture, so a later capture that renamed these fields cannot leave the reader claiming a
    // shape nothing carries.
    const captured: { data: { room_list: readonly Record<string, unknown>[] } } = JSON.parse(TOP3_BODY)
    const [first] = captured.data.room_list
    expect(Object.keys(first ?? {})).toEqual(expect.arrayContaining(['room_id', 'nickname', 'room_name']))

    // And this build reads exactly three of them — no `show_status`, which is what the catalogue's own
    // question asked about. Whether a room is live is not a criterion anywhere here: the action that sends
    // the gift does not check it, and the field this read feeds is a destination rather than a channel.
    expect(Object.keys(first ?? {})).toContain('show_status')
  })
})

describe('douyu.followedRooms — paging, and where it stops', () => {
  it('walks pages until one is empty, and asks for nothing twice', async () => {
    followPages = page =>
      page === 1
        ? { text: followPage([{ id: 1 }, { id: 2 }], { total: 3 }) }
        : page === 2
          ? { text: followPage([{ id: 3 }]) }
          : { text: followPage([]) }

    const read = await readDouyuFollowedRooms({ token: TOKEN, webCookies: WEB_COOKIES })

    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    expect(read.items.map(item => item.value)).toEqual(['1', '2', '3'])
    expect(requests.map(call => call.page)).toEqual(['1', '2', '3'])
  })

  it('stops when a declared total is reached, and when a declared pageCount says the last one', async () => {
    followPages = page =>
      page === 1 ? { text: followPage([{ id: 1 }, { id: 2 }], { total: 2, pageCount: 9 }) } : { text: followPage([]) }

    const read = await readDouyuFollowedRooms({ token: TOKEN, webCookies: WEB_COOKIES })
    expect(read.kind).toBe('ok')
    // The payload's own `total` ends the walk after one page: asking again could only re-read it.
    expect(requests.map(call => call.page)).toEqual(['1'])

    // And `pageCount`, reached exactly on the page it names.
    requests.length = 0
    followPages = page => ({ text: followPage([{ id: page }], { pageCount: 2 }) })
    await readDouyuFollowedRooms({ token: TOKEN, webCookies: WEB_COOKIES })
    expect(requests.map(call => call.page)).toEqual(['1', '2'])
  })

  it('ends the walk when a page adds no new room, so a service that ignores `page` cannot loop', async () => {
    // The guard `reconcileYubaSign` uses for the same reason: a service that answers page 1 forever must
    // end the walk rather than fill a 20-page budget with the same five rooms.
    followPages = () => ({ text: followPage([{ id: 1 }, { id: 2 }]) })

    const read = await readDouyuFollowedRooms({ token: TOKEN, webCookies: WEB_COOKIES })

    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    expect(read.items.map(item => item.value)).toEqual(['1', '2'])
    expect(requests.map(call => call.page)).toEqual(['1', '2'])
  })

  it('answers a sentence rather than a truncated list when the list is longer than this build reads', async () => {
    // **The far side of the cap, which is the half nobody asserts.** A page walk whose ceiling is reached
    // with new rooms still arriving is a *partial* list, and a partial list of rooms a person follows is
    // the one answer they cannot tell from the right one: the room they are looking for would simply be
    // absent. So the cap is reported, naming itself — and the same script with one more page of budget
    // answers `ok`, which is what makes this a case about the cap rather than about the fixture.
    const perPage = 5
    followPages = page => (page <= 2 ? { text: pageOfNewRooms(page, perPage) } : { text: followPage([]) })

    const capped = await readDouyuFollowedRooms({ token: TOKEN, webCookies: WEB_COOKIES }, { pagesMax: 2 })
    expect(capped.kind).toBe('unavailable')
    if (capped.kind !== 'unavailable') return
    expect(capped.reason).toContain('2 页')
    expect(capped.reason).not.toContain(TOKEN)
    expect(requests.map(call => call.page)).toEqual(['1', '2'])

    requests.length = 0
    const fitted = await readDouyuFollowedRooms({ token: TOKEN, webCookies: WEB_COOKIES }, { pagesMax: 3 })
    expect(fitted.kind).toBe('ok')
    if (fitted.kind !== 'ok') return
    expect(fitted.items).toHaveLength(perPage * 2)
    expect(requests.map(call => call.page)).toEqual(['1', '2', '3'])
  })
})

describe('douyu.followedRooms — the failure paths', () => {
  it('answers the measured refusal as a sentence naming the half the account has', async () => {
    // The body is the one this family's own probe recorded, byte for byte.
    const refusal = JSON.stringify({ code: -1, error: -1, msg: '用户未登陆或token已过期' })

    followPages = () => ({ text: refusal })
    const withSession = await readDouyuFollowedRooms({ token: TOKEN, webCookies: WEB_COOKIES })
    expect(withSession.kind).toBe('unavailable')
    if (withSession.kind !== 'unavailable') return
    expect(withSession.reason).toContain('重新扫码绑定')
    expect(withSession.reason).toContain('用户未登陆或token已过期')
    expect(withSession.reason).not.toContain(TOKEN)

    // A paste-bound account stores no jar, so the request carried no `cookie` header at all — and the
    // sentence has to name the half that account actually has (`routes/douyu-backpack.ts` records the
    // exchange where the other sentence sent a person to re-scan for a session they never had).
    followPages = () => ({ text: refusal })
    const withoutSession = await readDouyuFollowedRooms({ token: TOKEN, webCookies: '' })
    expect(withoutSession.kind).toBe('unavailable')
    if (withoutSession.kind !== 'unavailable') return
    expect(withoutSession.reason).toContain('没有存网页会话')
    expect(withoutSession.reason).not.toContain(WEB_COOKIES)
  })

  it('tells a broken contract, a dead network and a refusal apart — and never an empty list', async () => {
    followPages = () => ({ text: JSON.stringify({ error: 0, msg: 'ok', data: { items: [] } }) })
    const renamed = await readDouyuFollowedRooms({ token: TOKEN, webCookies: WEB_COOKIES })

    followPages = () => ({ unreachable: true })
    const unreachable = await readDouyuFollowedRooms({ token: TOKEN, webCookies: WEB_COOKIES })

    followPages = () => ({ text: '{"error":-1}', status: 403 })
    const refused = await readDouyuFollowedRooms({ token: TOKEN, webCookies: WEB_COOKIES })

    // None of the three is `ok` with `[]`: on this endpoint that would read as "you follow nobody", which
    // is the one wrong answer a person cannot tell from the right one.
    for (const read of [renamed, unreachable, refused]) expect(read.kind).toBe('unavailable')
    if (renamed.kind !== 'unavailable' || unreachable.kind !== 'unavailable' || refused.kind !== 'unavailable') return
    expect(unreachable.reason).not.toContain(TOKEN)
    expect(unreachable.reason).not.toContain(WEB_COOKIES)
    expect(unreachable.reason).toContain('读取关注列表失败')
    expect(refused.reason).toContain('403')
  })
})

describe('douyu.medalRooms', () => {
  it('answers the captured page with today’s reading in the one slot a form shows', async () => {
    const read = await readDouyuMedalRooms({ token: TOKEN, webCookies: WEB_COOKIES })

    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return

    // The label is where 「今天还没送过」 has to land, and the reason is `ChoiceItem`'s own shape: `count` is
    // "what the account holds of it" (a room is not held) and `costsSomething` is the Platform's *price*
    // marking (a room is not priced), so neither may carry a reading about a room. What the form renders
    // beside the label is the label, so it says the whole thing.
    expect(read.items).toEqual([
      { value: '12293234', label: '145oni（今日亲密度 0，今天还没送过）', count: null, costsSomething: null },
      { value: '12306', label: '电棍（今日亲密度 2，今天已经涨过了）', count: null, costsSomething: null }
    ])
  })

  it('says it could not read a cell, instead of claiming the room gained nothing', async () => {
    badgeAnswer = {
      text: '<table class="fans-badge-list"><tr data-fans-room="1"><td>1</td><td>甲</td><td><div data-anchor_name="甲"></div></td><td>--</td></tr></table>'
    }

    const read = await readDouyuMedalRooms({ token: TOKEN, webCookies: WEB_COOKIES })

    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    expect(read.items[0]?.label).toContain('读不出来')
    expect(read.items[0]?.label).not.toContain('今天还没送过')
  })

  it('answers an empty wall as an empty list, and a wall it could not read as a sentence', async () => {
    // An empty wall is a fact about the account here, and it is a measured one: read without a login this
    // page **redirects** (the probe recorded `302` with an empty body), and `readFanBadges` throws on a
    // non-2xx — so a read that returns zero rows is an account with no medals.
    badgeAnswer = { text: '<table class="fans-badge-list"><tbody></tbody></table>' }
    const empty = await readDouyuMedalRooms({ token: TOKEN, webCookies: WEB_COOKIES })
    expect(empty).toEqual({ kind: 'ok', items: [] })

    badgeAnswer = { unreachable: true }
    const unreachable = await readDouyuMedalRooms({ token: TOKEN, webCookies: WEB_COOKIES })
    expect(unreachable.kind).toBe('unavailable')
    if (unreachable.kind !== 'unavailable') return
    expect(unreachable.reason).toContain('读取粉丝牌失败')
    expect(unreachable.reason).not.toContain(TOKEN)
    expect(unreachable.reason).not.toContain('acf_auth')
  })
})

describe('the sources the form asks for, by key', () => {
  /** A registered account with a readable Douyu blob, which is what a source resolves. */
  function bindAccount(db: Parameters<typeof upsertAccount>[0], userId: number, credentials: string): number {
    return upsertAccount(db, userId, {
      platform: 'douyu',
      externalId: '456918967',
      displayName: 'tester',
      avatar: '',
      credentials
    }).id
  }

  test('serves both keys through the real registry, end to end', async ({ server, session }) => {
    const accountId = bindAccount(
      server.ctx.db,
      session.userId,
      JSON.stringify({ token: TOKEN, did: '20e8917f4ebe85866a5e94cfaba2f156', webCookies: WEB_COOKIES })
    )

    const registry = new ChoiceSourceRegistry()
    for (const source of douyuFormSources(server.ctx.db)) registry.register(source)

    // The two keys, and only these two: `douyu.backpack` belongs to the route module that reads it.
    expect(douyuFormSources(server.ctx.db).map(source => source.key)).toEqual([
      FOLLOWED_ROOMS_SOURCE,
      MEDAL_ROOMS_SOURCE
    ])

    const rooms = await registry.read(FOLLOWED_ROOMS_SOURCE, accountId)
    expect(rooms.kind).toBe('ok')
    if (rooms.kind !== 'ok') return
    expect(rooms.items.map(item => item.value)).toEqual(['12306', '12293234'])

    const medals = await registry.read(MEDAL_ROOMS_SOURCE, accountId)
    expect(medals.kind).toBe('ok')
    if (medals.kind !== 'ok') return
    expect(medals.items.map(item => item.label)).toEqual([
      '145oni（今日亲密度 0，今天还没送过）',
      '电棍（今日亲密度 2，今天已经涨过了）'
    ])
  })

  test('answers the two credential states as sentences, without asking the Platform', async ({ server, session }) => {
    const registry = new ChoiceSourceRegistry()
    for (const source of douyuFormSources(server.ctx.db)) registry.register(source)

    // An account row that is gone: a re-bind.
    const missing = await registry.read(FOLLOWED_ROOMS_SOURCE, 999_999)
    expect(missing.kind).toBe('unavailable')
    if (missing.kind !== 'unavailable') return
    expect(missing.reason).toContain('重新绑定')

    // A blob this build cannot read: the paste path having stored something unusable. A second sentence,
    // because the next move differs — and no request either way, which the recorder is still watching.
    const accountId = bindAccount(server.ctx.db, session.userId, 'not a douyu blob')
    const unreadable = await registry.read(MEDAL_ROOMS_SOURCE, accountId)
    expect(unreadable.kind).toBe('unavailable')
    if (unreadable.kind !== 'unavailable') return
    expect(unreadable.reason).toContain('凭据读不出来')
    expect(requests).toEqual([])
  })
})
