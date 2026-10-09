import type { DatabaseSync } from 'node:sqlite'

import { describe, expect } from 'vitest'

import { deleteAccount, upsertAccount } from '../src/repo/accounts.js'
import { appendEvent, EventKind, EventSeverity, hasRecentEvent, listRecentEvents } from '../src/repo/events.js'
import { createTask, TaskAction } from '../src/repo/tasks.js'
import { test as it } from './fixtures.js'

/**
 * Event feed and API tokens — the surface an external notification bridge uses.
 *
 * Two properties matter most here:
 *
 *   - **Cursor delivery is exactly-once per event.** A consumer stores
 *     `nextCursor` and must never miss a transition or receive one twice.
 *   - **An API token authenticates like a session, and revocation is
 *     immediate.** A bridge runs unattended, so a leaked token must be
 *     killable without touching the account.
 */

interface EventsBody {
  ok: boolean
  events: {
    id: number
    kind: string
    severity: string
    title: string
    detail: string
    platform: string
  }[]
  nextCursor: number
  latestId: number
  hasMore: boolean
}

interface RecentBody {
  ok: boolean
  events: { id: number; kind: string; title: string }[]
}

interface TokenBody {
  ok: boolean
  token?: string
  record?: { id: number; name: string; lastUsedAt: number | null }
  tokens?: { id: number; name: string }[]
  error?: string
}

describe('GET /api/events', () => {
  it('requires authentication', async ({ server }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/events' })
    expect(response.statusCode).toBe(401)
  })

  it('returns an empty feed with a zero cursor initially', async ({ server, session }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/events', headers: session.auth() })
    const body = response.json<EventsBody>()

    expect(body.events).toEqual([])
    expect(body.nextCursor).toBe(0)
    expect(body.latestId).toBe(0)
  })

  it('delivers events recorded after a cursor, oldest first', async ({ server, session }) => {
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskStarted, title: 'first' })
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskFinished, title: 'second' })

    const response = await server.app.inject({ method: 'GET', url: '/api/events?since=0', headers: session.auth() })
    const body = response.json<EventsBody>()

    expect(body.events).toHaveLength(2)
    expect(body.events[0]?.title).toBe('first')
    expect(body.events[1]?.title).toBe('second')
  })

  it('advances nextCursor so a consumer can page without gaps', async ({ server, session }) => {
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskStarted, title: 'a' })
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskStarted, title: 'b' })
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskStarted, title: 'c' })

    const first = await server.app.inject({
      method: 'GET',
      url: '/api/events?since=0&limit=2',
      headers: session.auth()
    })
    const firstBody = first.json<EventsBody>()
    expect(firstBody.events).toHaveLength(2)
    expect(firstBody.hasMore).toBe(true)

    const second = await server.app.inject({
      method: 'GET',
      url: `/api/events?since=${String(firstBody.nextCursor)}&limit=2`,
      headers: session.auth()
    })
    const secondBody = second.json<EventsBody>()

    expect(secondBody.events).toHaveLength(1)
    expect(secondBody.events[0]?.title).toBe('c')
    expect(secondBody.hasMore).toBe(false)
  })

  it('returns nothing when the cursor is already at the tip', async ({ server, session }) => {
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskStarted, title: 'only' })

    const first = await server.app.inject({ method: 'GET', url: '/api/events', headers: session.auth() })
    const cursor = first.json<EventsBody>().nextCursor

    const second = await server.app.inject({
      method: 'GET',
      url: `/api/events?since=${String(cursor)}`,
      headers: session.auth()
    })
    expect(second.json<EventsBody>().events).toEqual([])
  })

  it("does not leak another user's events", async ({ server, session }) => {
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskFailed, title: 'secret' })

    const other = await server.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'nosy', password: 'password123' }
    })
    const otherToken = other.json<{ token: string }>().token

    const response = await server.app.inject({ method: 'GET', url: '/api/events', headers: session.auth(otherToken) })
    expect(response.json<EventsBody>().events).toEqual([])
  })

  it('tolerates a malformed cursor instead of erroring', async ({ server, session }) => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/events?since=not-a-number',
      headers: session.auth()
    })
    expect(response.statusCode).toBe(200)
  })

  it('tolerates an unreadable page size the same way: the default, not a refusal', async ({ server, session }) => {
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskStarted, title: 'only' })

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/events?limit=nonsense',
      headers: session.auth()
    })
    expect(response.statusCode).toBe(200)
    // The default page size is what answered, so the single event is in the page.
    expect(response.json<EventsBody>().hasMore).toBe(false)
    expect(response.json<EventsBody>().events).toHaveLength(1)
  })

  it('carries severity and detail for a notification to render', async ({ server, session }) => {
    appendEvent(server.ctx.db, {
      userId: session.userId,
      kind: EventKind.SessionExpired,
      severity: EventSeverity.Error,
      title: '登录已失效',
      detail: '需要重新扫码绑定账号'
    })

    const response = await server.app.inject({ method: 'GET', url: '/api/events', headers: session.auth() })
    const event = response.json<EventsBody>().events[0]

    expect(event?.kind).toBe('session_expired')
    expect(event?.severity).toBe('error')
    expect(event?.detail).toContain('重新扫码')
  })
})

/**
 * Dedup key and Platform attribution.
 *
 * Two defects from `HANDOFF.md` §7 are pinned here, because both were invisible
 * to code that only ever had one Platform and one task.
 *
 * The dedup key was user + kind with no task, so a Bilibili `session_expired`
 * silently swallowed a Douyu one raised inside the same thirty minutes: the
 * second account stayed dead and nothing said so. And an event carried no
 * Platform, which is the same failure from the consumer's side — "登录已失效"
 * alone cannot be acted on when a user has bound both.
 */
describe('hasRecentEvent', () => {
  const WINDOW = 30 * 60 * 1000

  it('lets a second task raise the same kind inside the window', ({ server, session }) => {
    const bilibili = 1
    const douyu = 2

    // The original symptom, run through the shape the scheduler uses: ask, then
    // append. Both tasks are on the same user, both raise `session_expired`, and
    // both must reach the feed.
    for (const [taskId, platform] of [
      [bilibili, 'bilibili'],
      [douyu, 'douyu']
    ] as const) {
      if (hasRecentEvent(server.ctx.db, session.userId, EventKind.SessionExpired, taskId, WINDOW)) continue
      appendEvent(server.ctx.db, {
        userId: session.userId,
        kind: EventKind.SessionExpired,
        severity: EventSeverity.Error,
        title: '登录已失效',
        platform,
        taskId
      })
    }

    const feed = listRecentEvents(server.ctx.db, session.userId, 10)
    expect(feed.map(event => event.platform)).toEqual(['douyu', 'bilibili'])

    expect(hasRecentEvent(server.ctx.db, session.userId, EventKind.SessionExpired, bilibili, WINDOW)).toBe(true)
    expect(hasRecentEvent(server.ctx.db, session.userId, EventKind.SessionExpired, douyu, WINDOW)).toBe(true)
    // A third task of the same user is still un-suppressed.
    expect(hasRecentEvent(server.ctx.db, session.userId, EventKind.SessionExpired, 3, WINDOW)).toBe(false)
  })

  it('treats a null task id as user-wide, which is what the refresh job asks', ({ server, session }) => {
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.SessionExpired, title: 'B 站掉线', taskId: 1 })

    // The session-refresh path has no task in hand; its question is "did this
    // user already hear about a dead session", and the answer must stay yes.
    expect(hasRecentEvent(server.ctx.db, session.userId, EventKind.SessionExpired, null, WINDOW)).toBe(true)
    // A user with nothing on the feed is not suppressed.
    expect(hasRecentEvent(server.ctx.db, session.userId, EventKind.AccountRestricted, null, WINDOW)).toBe(false)
  })

  it('ignores an event older than the window', ({ server, session }) => {
    const now = Date.now()
    appendEvent(
      server.ctx.db,
      { userId: session.userId, kind: EventKind.TaskFailed, title: '任务失败', taskId: 1 },
      now
    )

    expect(hasRecentEvent(server.ctx.db, session.userId, EventKind.TaskFailed, 1, WINDOW, now + 1)).toBe(true)
    expect(hasRecentEvent(server.ctx.db, session.userId, EventKind.TaskFailed, 1, 1000, now + 5000)).toBe(false)
  })

  it('does not let one kind suppress another', ({ server, session }) => {
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.ActionFailed, title: '动作失败', taskId: 1 })

    expect(hasRecentEvent(server.ctx.db, session.userId, EventKind.ActionBlocked, 1, WINDOW)).toBe(false)
  })
})

describe('event platform', () => {
  it('records the platform, and leaves it empty when there is none', async ({ server, session }) => {
    appendEvent(server.ctx.db, {
      userId: session.userId,
      kind: EventKind.TaskWentLive,
      title: '开播了',
      platform: 'douyu'
    })
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskFinished, title: '结束了' })

    const recent = listRecentEvents(server.ctx.db, session.userId, 2)
    expect(recent[0]?.platform).toBe('')
    expect(recent[1]?.platform).toBe('douyu')

    // And it survives the endpoint an external consumer actually reads.
    const response = await server.app.inject({ method: 'GET', url: '/api/events?since=0', headers: session.auth() })
    const events = response.json<EventsBody>().events
    expect(events.find(event => event.kind === 'task_went_live')?.platform).toBe('douyu')
  })

  it('has kinds for a reconcile action that failed or is parked', async ({ server, session }) => {
    appendEvent(server.ctx.db, {
      userId: session.userId,
      kind: EventKind.ActionFailed,
      severity: EventSeverity.Warning,
      title: '动作失败',
      detail: '签到被拒',
      platform: 'douyu'
    })
    appendEvent(server.ctx.db, {
      userId: session.userId,
      kind: EventKind.ActionBlocked,
      severity: EventSeverity.Warning,
      title: '动作受阻',
      detail: '鱼丸不足',
      platform: 'douyu'
    })

    const response = await server.app.inject({ method: 'GET', url: '/api/events?since=0', headers: session.auth() })
    const events = response.json<EventsBody>().events

    expect(events.map(event => event.kind)).toEqual(['action_failed', 'action_blocked'])
    expect(events[0]?.severity).toBe('warning')
  })
})

describe('API tokens', () => {
  it('requires a session to manage tokens', async ({ server }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/tokens' })
    expect(response.statusCode).toBe(401)
  })

  it('issues a token and returns the plaintext exactly once', async ({ server, session }) => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'astrbot' },
      headers: session.auth()
    })
    const body = created.json<TokenBody>()

    expect(body.ok).toBe(true)
    expect(body.token?.startsWith('bts_')).toBe(true)
    expect(body.record?.name).toBe('astrbot')

    // The list must never echo it back.
    const list = await server.app.inject({ method: 'GET', url: '/api/tokens', headers: session.auth() })
    expect(list.body).not.toContain(String(body.token))
  })

  it('names a token 未命名令牌 when the request carries no name at all', async ({ server, session }) => {
    // A body is optional here: a caller that just wants a token should not have to
    // send `{}` to get one, and Fastify hands a missing body through as `null`.
    const created = await server.app.inject({ method: 'POST', url: '/api/tokens', headers: session.auth() })
    const body = created.json<TokenBody>()

    expect(created.statusCode).toBe(200)
    expect(body.record?.name).toBe('未命名令牌')
  })

  it('authenticates requests made with the API token', async ({ server, session }) => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'bridge' },
      headers: session.auth()
    })
    const apiToken = created.json<TokenBody>().token ?? ''

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: session.auth(apiToken)
    })

    expect(response.statusCode).toBe(200)
    // Compared against the fixture's own name rather than a literal: what is being
    // pinned is that the token authenticates as the user it was issued for.
    expect(response.json<{ user: { username: string } }>().user.username).toBe(session.username)
  })

  it('lets an API token read the event feed', async ({ server, session }) => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'bridge' },
      headers: session.auth()
    })
    const apiToken = created.json<TokenBody>().token ?? ''

    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskWentLive, title: '开播了' })

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/events',
      headers: session.auth(apiToken)
    })
    expect(response.json<EventsBody>().events[0]?.title).toBe('开播了')
  })

  it('records lastUsedAt once a token is used', async ({ server, session }) => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'bridge' },
      headers: session.auth()
    })
    const apiToken = created.json<TokenBody>().token ?? ''

    await server.app.inject({ method: 'GET', url: '/api/auth/me', headers: session.auth(apiToken) })

    const list = await server.app.inject({ method: 'GET', url: '/api/tokens', headers: session.auth() })
    const record = list.json<{ tokens: { lastUsedAt: number | null }[] }>().tokens[0]
    expect(record?.lastUsedAt).not.toBeNull()
  })

  it('rejects a revoked token immediately', async ({ server, session }) => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'burner' },
      headers: session.auth()
    })
    const body = created.json<TokenBody>()
    const apiToken = body.token ?? ''
    const tokenId = body.record?.id ?? 0

    // Works before revocation.
    const before = await server.app.inject({ method: 'GET', url: '/api/auth/me', headers: session.auth(apiToken) })
    expect(before.statusCode).toBe(200)

    const revoked = await server.app.inject({
      method: 'DELETE',
      url: `/api/tokens/${String(tokenId)}`,
      headers: session.auth()
    })
    expect(revoked.statusCode).toBe(200)

    const after = await server.app.inject({ method: 'GET', url: '/api/auth/me', headers: session.auth(apiToken) })
    expect(after.statusCode).toBe(401)
  })

  it('rejects a token that was never issued', async ({ server, session }) => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: session.auth('bts_deadbeefdeadbeef')
    })
    expect(response.statusCode).toBe(401)
  })

  it("does not let one user revoke another user's token", async ({ server, session }) => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'mine' },
      headers: session.auth()
    })
    const tokenId = created.json<TokenBody>().record?.id ?? 0

    const other = await server.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'thief', password: 'password123' }
    })
    const otherToken = other.json<{ token: string }>().token

    const response = await server.app.inject({
      method: 'DELETE',
      url: `/api/tokens/${String(tokenId)}`,
      headers: session.auth(otherToken)
    })
    expect(response.statusCode).toBe(404)

    // Still usable by its owner.
    const mine = await server.app.inject({ method: 'GET', url: '/api/tokens', headers: session.auth() })
    expect(mine.json<TokenBody>().tokens).toHaveLength(1)
  })
})

/**
 * Unbinding an account takes the feed's references to it with it.
 *
 * `tasks` cascades in SQL, and neither `events.task_id` nor `events.account_id` carries a foreign key —
 * so one unbind used to leave an external consumer holding events about an account *and* about Tasks
 * that no longer existed. Rebinding is the ordinary way out of a dead session, so this is a person's
 * everyday action rather than an edge case, and it is the same defect as deleting a single Task
 * (`repo/tasks.ts`'s `deleteTask`), applied to the other two columns.
 */
describe('unbinding an account', () => {
  it('removes the events raised about it, and about the Tasks that went with it', async ({ server, session }) => {
    const now = Date.now()
    const account = upsertAccount(server.ctx.db, session.userId, {
      platform: 'douyu',
      externalId: '456918967',
      displayName: '主号',
      avatar: '',
      credentials: '{}'
    })
    const task = createTask(
      server.ctx.db,
      session.userId,
      {
        platform: 'douyu',
        accountId: account.id,
        libraryId: null,
        action: TaskAction.Reconcile,
        actionKey: 'sign_in',
        targetKey: '',
        targetTitle: '',
        startTime: now,
        endTime: now + 60 * 60 * 1000,
        interval: 300,
        saltEnabled: false,
        requireOnline: false
      },
      now
    )

    appendEvent(server.ctx.db, {
      userId: session.userId,
      kind: EventKind.SessionExpired,
      title: '登录已失效',
      accountId: account.id
    })
    appendEvent(server.ctx.db, {
      userId: session.userId,
      kind: EventKind.TaskStarted,
      title: '任务开始',
      taskId: task.id,
      accountId: account.id
    })

    expect(deleteAccount(server.ctx.db, session.userId, account.id)).toBe(true)

    const eventsLeft = server.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE account_id = ? OR task_id = ?')
      .get(account.id, task.id)
    expect(Number(eventsLeft?.['n'])).toBe(0)

    // The rows those events were about are gone too, which is the cascade they used to outlive.
    const tasksLeft = server.ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE account_id = ?').get(account.id)
    expect(Number(tasksLeft?.['n'])).toBe(0)
  })
})

/**
 * A kind no build here has a name for, spelled the way a future one would be.
 *
 * Long and unmistakable on purpose: it travels through an assertion as a marker, and a short one
 * could be assembled by two adjacent rendered values.
 */
const UNKNOWN_KIND = 'task_teleported_into_a_later_build'

/**
 * Writes an event row whose kind this build has never heard of.
 *
 * `appendEvent` types the kind as `EventKind`, so it cannot produce one — but the column is `TEXT`
 * and a row written by a *newer* build is exactly this shape. It is the only way to reach the bucket
 * `toKind` reads any unrecognised value as, which is the one case a kind filter cannot express as a
 * plain list of words.
 */
function appendUnknownKind(db: DatabaseSync, userId: number): void {
  db.prepare(
    `INSERT INTO events (user_id, kind, severity, title, detail, platform, task_id, account_id, created_at)
     VALUES (?, ?, 'info', ?, '', '', NULL, NULL, ?)`
  ).run(userId, UNKNOWN_KIND, `未知 ${UNKNOWN_KIND}`, Date.now())
}

/**
 * The kind filter `IntegrationsView` sends, on the endpoint that page reads.
 *
 * **The boundary below is the design point.** That page keeps the newest fifty rows, so a filter
 * applied in the browser would let a hidden kind consume a place in the window: a person who hides
 * the noisy kinds would look at a short — or empty — feed while the rows he wants sat just behind
 * them. So the filter is a query argument, and the first case pins that the window is filled with
 * the kinds that were asked for rather than with the ones that were not.
 *
 * **`GET /api/events` is deliberately not that endpoint.** The AstrBot plugin polls it with a
 * cursor, and a filter there would not merely change what it receives: the cursor would walk past
 * the kinds it was not shown and `pruneEvents` would then free those rows, i.e. the notification
 * would be gone for good. The last case pins that it still answers with every kind.
 */
describe('the kind filter on GET /api/events/recent', () => {
  it('fills the page with the kinds it asked for instead of letting hidden ones eat the window', async ({
    server,
    session
  }) => {
    // 25 rows he kept, then 30 newer rows of a kind he hid: a filter applied to the page's own 50
    // would see those 30 newer rows and only 20 kept ones, while the same filter asked at the query
    // finds all 25 of them.
    for (let i = 0; i < 25; i += 1) {
      appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskFinished, title: `保留 ${String(i)}` })
    }
    for (let i = 0; i < 30; i += 1) {
      appendEvent(server.ctx.db, {
        userId: session.userId,
        kind: EventKind.TaskSendingTrouble,
        title: `隐藏 ${String(i)}`
      })
    }

    const unfiltered = await server.app.inject({
      method: 'GET',
      url: '/api/events/recent?limit=50',
      headers: session.auth()
    })
    const keptOnTheUnfilteredPage = unfiltered.json<RecentBody>().events.filter(event => event.kind === 'task_finished')
    expect(keptOnTheUnfilteredPage).toHaveLength(20)

    const filtered = await server.app.inject({
      method: 'GET',
      url: '/api/events/recent?limit=50&kinds=task_finished',
      headers: session.auth()
    })
    const events = filtered.json<RecentBody>().events

    expect(events).toHaveLength(25)
    expect(events.length).toBeGreaterThan(keptOnTheUnfilteredPage.length)
    expect(events.every(event => event.kind === 'task_finished')).toBe(true)
  })

  it('shows every kind when the request names none', async ({ server, session }) => {
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskStarted, title: '任务开始' })
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.SessionExpired, title: '登录已失效' })

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/events/recent?limit=50',
      headers: session.auth()
    })

    expect(response.json<RecentBody>().events.map(event => event.kind)).toEqual(['session_expired', 'task_started'])
  })

  it('puts a kind this build cannot name in the bucket the page can hide', async ({ server, session }) => {
    appendUnknownKind(server.ctx.db, session.userId)
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskFinished, title: '保留' })

    const keptOnly = await server.app.inject({
      method: 'GET',
      url: '/api/events/recent?limit=50&kinds=task_finished',
      headers: session.auth()
    })
    expect(keptOnly.json<RecentBody>().events.map(event => event.title)).toEqual(['保留'])

    // `other` is a bucket rather than a word — the page labels it 「未知事件」 — so a filter naming it
    // has to match a row this build has no name for, not only one that stored the word `other`.
    const bucket = await server.app.inject({
      method: 'GET',
      url: '/api/events/recent?limit=50&kinds=other',
      headers: session.auth()
    })
    const events = bucket.json<RecentBody>().events
    expect(events.map(event => event.kind)).toEqual(['other'])
    expect(events.map(event => event.title)).toEqual([`未知 ${UNKNOWN_KIND}`])
  })

  it('reads an empty kind list as a request for nothing', async ({ server, session }) => {
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskStarted, title: '有事件' })

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/events/recent?limit=50&kinds=',
      headers: session.auth()
    })

    // 200 rather than a refusal: "none of them" is a legitimate selection — every box unticked — and
    // it is a different request from naming no parameter at all, which is the case above.
    expect(response.statusCode).toBe(200)
    expect(response.json<RecentBody>().events).toEqual([])
  })

  it('refuses a kind it does not know rather than answering a feed that excludes it', async ({ server, session }) => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/events/recent?limit=50&kinds=task_finishd',
      headers: session.auth()
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('事件类型无效')
  })

  it('leaves the cursor endpoint the AstrBot plugin polls unfiltered', async ({ server, session }) => {
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.TaskStarted, title: '任务开始' })
    appendEvent(server.ctx.db, { userId: session.userId, kind: EventKind.SessionExpired, title: '登录已失效' })

    // The page's own parameter, sent to the plugin's endpoint: it is not part of that route's
    // schema, and the answer must stay the whole feed. A filter honoured here would walk the cursor
    // past every hidden kind, and the retention window would then delete them.
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/events?since=0&kinds=task_started',
      headers: session.auth()
    })

    expect(response.json<EventsBody>().events.map(event => event.kind)).toEqual(['task_started', 'session_expired'])
  })
})
