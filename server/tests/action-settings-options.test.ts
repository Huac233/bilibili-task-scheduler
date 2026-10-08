import { describe, expect } from 'vitest'

import { fieldOf, fieldsOf } from '../src/actions/action-options.js'
import type { Db } from '../src/db/index.js'
import type { BuiltServer } from '../src/index.js'
import { allPlatforms, platformFor } from '../src/platform/registry.js'
import { upsertAccount } from '../src/repo/accounts.js'
import {
  listCarrierTasksForAction,
  listFinishedCarrierTasksForAction,
  TaskAction,
  TaskStatus
} from '../src/repo/tasks.js'
import { BACKPACK_SOURCE } from '../src/routes/douyu-options.js'
import { reconcileSelectionFor } from '../src/scheduler/logic.js'
import { test as it, registerUser, type Session } from './fixtures.js'

/**
 * The two answers an action-settings screen needs beyond the switch, at the HTTP surface.
 *
 *  - **`GET /api/action-settings/options`** — where a choice-backed field's choices come from. The
 *    assertions are about the *credential* as much as about the list: a live read is the only thing
 *    in this build that touches a Platform on a person's behalf from a page they are looking at, so
 *    "no token, no cookie" is a property to pin rather than a habit to keep.
 *  - **`GET /api/action-settings/workflow`** — which Task would actually run an action. Every
 *    expectation below is derived from a Task the real create route wrote, so the test cannot agree
 *    with a wrong rule: a Task names one action, and the action it does not name must report no
 *    carrier however similar the two look. Naming the action is necessary and not sufficient, though —
 *    a row whose own Target contradicts the action's shape is answered `failed` by the run and never
 *    dispatched, so it must not be a carrier either, and the list here is filtered by the very
 *    function the run uses. Nor is a row that has run its window out: the sweep will not take it
 *    again, so it is counted by `finishedCarriers` rather than named as a carrier, and the create
 *    offer that comes back with the count is the way that action runs again at all.
 *
 * The one source is driven through the real reader — the `optionFetch` fixture in `./fixtures.ts` is
 * the single substitution — so the endpoint, the headers, the envelope parse and every failure
 * sentence are the shipping code's.
 */

/** A pasted blob shaped exactly as `platform/douyu/index.ts` parses one, with a placeholder token. */
const PASTE_TOKEN = '456918967_21_681808fee85afe0d_14_47039959'
const SECRET_COOKIE = 'acf_auth-must-not-leak'

/** Binds an account on one Platform, with the credential above. */
function bind(server: BuiltServer, session: Session, platform: string, externalId: string): number {
  return upsertAccount(server.ctx.db, session.userId, {
    platform,
    externalId,
    displayName: '测试账号',
    avatar: '',
    credentials: JSON.stringify({
      token: PASTE_TOKEN,
      did: 'AA:BB:CC:DD:EE:FF',
      webCookies: `acf_auth=${SECRET_COOKIE}`
    })
  }).id
}

/**
 * The captured envelope, with one readable item.
 *
 * `id: 268`, `count: 60`, `expiry: 4`, `isValuable: 0` and `priceType: 2` are the capture's own
 * values; the Chinese name is a sample, because the capture's own text was destroyed by an encoding
 * fault on the way to disk. See `douyu-backpack.test.ts` for what the capture does and does not
 * prove.
 */
function backpackBody(): string {
  return JSON.stringify({
    error: 0,
    msg: 'ok',
    data: {
      list: [{ id: 268, name: '礼物', count: 60, expiry: 4, isValuable: 0, priceType: 2 }],
      totalNum: 60,
      validNum: 60,
      unlockLevel: 10
    }
  })
}

interface RowSpec {
  readonly platform?: string
  readonly action: string
  readonly actionKey: string
  readonly targetKey: string
  readonly status: string
  readonly startTime: number
  readonly endTime: number
}

/**
 * Inserts one Task the routes cannot produce.
 *
 * A `done` row is the state the sweep reaches when a window closes, and no route writes it — so a
 * case about what a finished row does to the settings screen states the one fact it is about rather
 * than reproducing a procedure whose other steps belong to `scheduler-live.test.ts`. `reconcile-task.
 * test.ts` has its counterpart for the same reason.
 */
function insertRow(db: Db, userId: number, accountId: number, spec: RowSpec): number {
  const info = db
    .prepare(
      `INSERT INTO tasks (
         user_id, platform, account_id, library_id, action, action_key, target_key, target_title,
         start_time, end_time, interval, status, salt_enabled, require_online,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      spec.platform ?? 'douyu',
      accountId,
      null,
      TaskAction.Reconcile,
      spec.actionKey,
      spec.targetKey,
      '',
      spec.startTime,
      spec.endTime,
      300,
      spec.status,
      1,
      0,
      spec.startTime,
      spec.startTime
    )
  return Number(info.lastInsertRowid)
}

describe('ActionDescriptor.optionFields, as the catalogue publishes it', () => {
  it('is declared for 亲密度任务, and names a source rather than a list', async ({ server, session }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/platforms', headers: session.auth() })
    const platforms = response.json<{
      platforms: {
        key: string
        actions: { key: string; optionFields?: { name: string; kind: string; source?: string; label: string }[] }[]
      }[]
    }>().platforms

    const douyu = platforms.find(platform => platform.key === 'douyu')
    const action = douyu?.actions.find(candidate => candidate.key === 'intimacy_tasks')
    const [field] = action?.optionFields ?? []

    expect(field?.name).toBe('giftAllowlist')
    expect(field?.kind).toBe('choice')
    expect(field?.source).toBe(BACKPACK_SOURCE)
    // A label a person reads, instead of the option's key — the reason the field list carries one.
    expect(field?.label).toBe('允许使用的礼物')
  })

  it('publishes exactly the declared table, and nothing on an action that declares none', async ({
    server,
    session
  }) => {
    const response = await server.app.inject({ method: 'GET', url: '/api/platforms', headers: session.auth() })
    const platforms = response.json<{
      platforms: { key: string; actions: { key: string; optionFields?: unknown[] }[] }[]
    }>().platforms

    // Derived from the registry rather than listed here, so a new action is covered without an edit:
    // the merge is additive and must not appear on an action that has no fields.
    for (const platform of allPlatforms()) {
      for (const action of platform.actions) {
        const published = platforms
          .find(candidate => candidate.key === platform.key)
          ?.actions.find(candidate => candidate.key === action.key)
        expect(published?.optionFields ?? []).toEqual(fieldsOf(platform.key, action.key))
      }
    }
  })

  it('asks for no fields at all for an action no table entry names', () => {
    expect(fieldOf('bilibili', 'send_danmaku', 'anything')).toBeNull()
    expect(fieldsOf('douyu', 'no_such_action')).toEqual([])
  })

  it('does not touch a Platform whose actions declare none', () => {
    expect(platformFor('bilibili')?.actions.every(action => action.optionFields === undefined)).toBe(true)
  })
})

describe('GET /api/action-settings/options', () => {
  async function ask(
    server: BuiltServer,
    headers: Record<string, string>,
    query: Record<string, string | number>
  ): Promise<{ status: number; body: string }> {
    const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString()
    const response = await server.app.inject({
      method: 'GET',
      url: `/api/action-settings/options?${search}`,
      headers
    })
    return { status: response.statusCode, body: response.body }
  }

  it('requires a session', async ({ server }) => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/action-settings/options?platform=douyu&actionKey=intimacy_tasks&accountId=1&field=giftAllowlist'
    })
    expect(response.statusCode).toBe(401)
  })

  it('answers with one choice per item the source returned', async ({ server, session, optionFetch }) => {
    const accountId = bind(server, session, 'douyu', '456918967')
    const calls: { url: string; init: RequestInit }[] = []
    optionFetch.current = async (url, init) => {
      calls.push({ url, init })
      return new Response(backpackBody(), { status: 200 })
    }

    const answer = await ask(server, session.auth(), {
      platform: 'douyu',
      actionKey: 'intimacy_tasks',
      accountId,
      field: 'giftAllowlist'
    })

    expect(answer.status).toBe(200)
    const body = JSON.parse(answer.body) as {
      field: string
      source: string
      choice: { kind: string; items: { value: string; label: string; count: number; costsSomething: boolean }[] }
    }

    expect(body.field).toBe('giftAllowlist')
    expect(body.source).toBe(BACKPACK_SOURCE)
    expect(body.choice.kind).toBe('ok')
    expect(body.choice.items).toEqual([{ value: '268', label: '礼物', count: 60, costsSomething: false }])

    // The read went through the real reader: the captured endpoint, and the credential in a header.
    // `rid` is that reader's own constant — see `BACKPACK_RID` for the measurement behind it.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://pcapi.douyucdn.cn/japi/prop/backpack/pc/v1?rid=1')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['token']).toBe(PASTE_TOKEN)
    expect(headers['cookie']).toBe(`acf_auth=${SECRET_COOKIE}`)
  })

  it('never puts a token or a cookie in the body, on success or on failure', async ({
    server,
    session,
    optionFetch
  }) => {
    const accountId = bind(server, session, 'douyu', '456918967')
    optionFetch.current = async () => new Response(backpackBody(), { status: 200 })

    const ok = await ask(server, session.auth(), {
      platform: 'douyu',
      actionKey: 'intimacy_tasks',
      accountId,
      field: 'giftAllowlist'
    })
    expect(ok.body).not.toContain(PASTE_TOKEN)
    expect(ok.body).not.toContain(SECRET_COOKIE)

    // A transport error's own message can carry the request it failed on, and the token and the jar
    // travel in that request's headers — so the reader must not hand an error's text through
    // unexamined. **Both** halves are asserted here: this case used to assert only the cookie, while
    // the error it injected mentioned the token, which therefore reached the response body.
    optionFetch.current = async () => {
      throw new Error(`request failed for ${PASTE_TOKEN} with acf_auth=${SECRET_COOKIE}`)
    }

    const failed = await ask(server, session.auth(), {
      platform: 'douyu',
      actionKey: 'intimacy_tasks',
      accountId,
      field: 'giftAllowlist'
    })
    const body = JSON.parse(failed.body) as { choice: { kind: string; reason: string } }

    expect(body.choice.kind).toBe('unavailable')
    expect(failed.body).not.toContain(PASTE_TOKEN)
    expect(failed.body).not.toContain(SECRET_COOKIE)
  })

  it('answers a refusal as a sentence rather than as an empty list', async ({ server, session, optionFetch }) => {
    const accountId = bind(server, session, 'douyu', '456918967')
    optionFetch.current = async () => new Response(JSON.stringify({ error: 9, msg: '请登录' }), { status: 200 })

    const answer = await ask(server, session.auth(), {
      platform: 'douyu',
      actionKey: 'intimacy_tasks',
      accountId,
      field: 'giftAllowlist'
    })
    const body = JSON.parse(answer.body) as { choice: { kind: string; reason: string } }

    // `items: []` here would read as "this account holds no gifts", which is the one wrong answer a
    // person cannot tell from the right one.
    expect(body.choice.kind).toBe('unavailable')
    expect(body.choice.reason).toContain('网页会话')
  })

  it('refuses a field the action does not read', async ({ server, session }) => {
    const accountId = bind(server, session, 'douyu', '456918967')

    const answer = await ask(server, session.auth(), {
      platform: 'douyu',
      actionKey: 'intimacy_tasks',
      accountId,
      field: 'noSuchOption'
    })

    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body).error).toContain('noSuchOption')
  })

  it('refuses an option on an action that declares no fields', async ({ server, session }) => {
    bind(server, session, 'bilibili', '14004964')

    const answer = await ask(server, session.auth(), {
      platform: 'bilibili',
      actionKey: 'send_danmaku',
      accountId: 1,
      field: 'giftAllowlist'
    })

    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body).error).toContain('giftAllowlist')
  })

  it('scopes the account to the caller', async ({ server, session }) => {
    const mine = bind(server, session, 'douyu', '456918967')
    const other = await registerUser(server, 'option_snoop')

    const theirs = await ask(server, other.auth(), {
      platform: 'douyu',
      actionKey: 'intimacy_tasks',
      accountId: mine,
      field: 'giftAllowlist'
    })
    const nobody = await ask(server, session.auth(), {
      platform: 'douyu',
      actionKey: 'intimacy_tasks',
      accountId: 999_999,
      field: 'giftAllowlist'
    })

    expect(theirs.status).toBe(404)
    expect(nobody.status).toBe(404)
  })

  it('rejects an account that belongs to another Platform', async ({ server, session }) => {
    const bili = bind(server, session, 'bilibili', '14004964')

    const answer = await ask(server, session.auth(), {
      platform: 'douyu',
      actionKey: 'intimacy_tasks',
      accountId: bili,
      field: 'giftAllowlist'
    })

    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body).error).toContain('不属于')
  })

  it('is a read: nothing is written to the switchboard', async ({ server, session, optionFetch }) => {
    const accountId = bind(server, session, 'douyu', '456918967')
    optionFetch.current = async () => new Response(backpackBody(), { status: 200 })

    await ask(server, session.auth(), {
      platform: 'douyu',
      actionKey: 'intimacy_tasks',
      accountId,
      field: 'giftAllowlist'
    })

    const listed = await server.app.inject({ method: 'GET', url: '/api/action-settings', headers: session.auth() })
    const settings = listed.json<{ settings: { enabled: boolean }[] }>().settings
    expect(settings.every(setting => !setting.enabled)).toBe(true)
  })
})

describe('GET /api/action-settings/workflow', () => {
  interface WorkflowBody {
    wants: { needsTarget: boolean; shape: string }
    carriers: { id: number; targetKey: string; targetTitle: string }[]
    finishedCarriers: number
    create: { needsTarget: boolean; needsLibrary: boolean; defaultIntervalSeconds: number } | null
  }

  async function workflowOf(
    server: BuiltServer,
    headers: Record<string, string>,
    platform: string,
    actionKey: string
  ): Promise<{ status: number; body: string; workflow: WorkflowBody | null }> {
    const response = await server.app.inject({
      method: 'GET',
      url: `/api/action-settings/workflow?platform=${platform}&actionKey=${actionKey}`,
      headers
    })
    let workflow: WorkflowBody | null = null
    try {
      workflow = (JSON.parse(response.body) as { workflow?: WorkflowBody }).workflow ?? null
    } catch {
      workflow = null
    }
    return { status: response.statusCode, body: response.body, workflow }
  }

  async function enable(server: BuiltServer, session: Session, platform: string, actionKey: string): Promise<void> {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/action-settings',
      headers: session.auth(),
      payload: { platform, actionKey, enabled: true }
    })
    expect(response.statusCode).toBe(200)
  }

  async function create(
    server: BuiltServer,
    session: Session,
    body: { platform: string; accountId: number; actionKey: string; targetKey?: string; targetTitle?: string }
  ): Promise<void> {
    const now = Date.now()
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: session.auth(),
      payload: { ...body, startTime: now, endTime: now + 60_000, interval: 300 }
    })
    expect(response.statusCode).toBe(200)
  }

  it('requires a session', async ({ server }) => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/action-settings/workflow?platform=douyu&actionKey=intimacy_tasks'
    })
    expect(response.statusCode).toBe(401)
  })

  it('rejects an action the Platform does not declare', async ({ server, session }) => {
    const answer = await workflowOf(server, session.auth(), 'douyu', 'write_poetry')
    expect(answer.status).toBe(400)
    expect(answer.body).toContain('write_poetry')
  })

  it('says there is nowhere to run, and offers the Task that is missing', async ({ server, session }) => {
    // The owner's own situation, exactly: the action switched on, and no Task naming it anywhere.
    await enable(server, session, 'douyu', 'intimacy_tasks')

    const answer = await workflowOf(server, session.auth(), 'douyu', 'intimacy_tasks')

    expect(answer.status).toBe(200)
    expect(answer.workflow?.wants.needsTarget).toBe(true)
    expect(answer.workflow?.carriers).toEqual([])
    // `needsLibrary` rides along because a `send` Action cannot be created without one, and the
    // offer is what a panel reads to decide whether it may draw that create at all.
    expect(answer.workflow?.create).toEqual({ needsTarget: true, needsLibrary: false, defaultIntervalSeconds: 300 })
    // The aim is described in a person's words, never as the field name behind it.
    expect(answer.workflow?.wants.shape).not.toContain('needsTarget')
  })

  it('names the Task that runs it, once one names it', async ({ server, session }) => {
    const accountId = bind(server, session, 'douyu', '456918967')
    await enable(server, session, 'douyu', 'intimacy_tasks')
    await create(server, session, {
      platform: 'douyu',
      accountId,
      actionKey: 'intimacy_tasks',
      targetKey: '12306',
      targetTitle: '电棍'
    })

    const carried = await workflowOf(server, session.auth(), 'douyu', 'intimacy_tasks')

    expect(carried.workflow?.carriers).toEqual([{ id: expect.any(Number), targetKey: '12306', targetTitle: '电棍' }])
    // Nothing left to create: the gap is closed, and an offer to fill it would be a second Task doing
    // the same work under a second id.
    expect(carried.workflow?.create).toBeNull()
  })

  it('shows the Tasks that run it, and never the row the run itself refuses', async ({ server, session }) => {
    const accountId = bind(server, session, 'douyu', '456918967')
    await enable(server, session, 'douyu', 'sign_in')
    await enable(server, session, 'douyu', 'intimacy_tasks')

    // One Task this action can run: `sign_in` is account-scoped, and this row carries no Target…
    await create(server, session, { platform: 'douyu', accountId, actionKey: 'sign_in' })

    // …and one it cannot. The create route refuses a `needsTarget` action with no target and says
    // nothing about the other direction, so an account-scoped action on a row that carries a Room is a
    // row it writes happily — and the run answers that row `failed`/`unexpected_target` **without
    // dispatching the action at all** (`scheduler-live.test.ts` pins that end of it).
    await create(server, session, {
      platform: 'douyu',
      accountId,
      actionKey: 'sign_in',
      targetKey: '12306',
      targetTitle: '电棍'
    })

    const accountScoped = await workflowOf(server, session.auth(), 'douyu', 'sign_in')

    // So the carrier list holds the row that runs it and not the refused one, and the refused row's
    // room appears nowhere on this action's row. That is the whole claim: the page may only name a Task
    // the code would actually run — and what excludes the refused row is the run's own rule rather than
    // the list's heading: 「指名这个动作的任务：」 claims the naming, which that row satisfies too.
    expect(accountScoped.workflow?.carriers).toHaveLength(1)
    expect(accountScoped.workflow?.carriers[0]?.targetKey).toBe('')
    expect(accountScoped.workflow?.create).toBeNull()
    expect(accountScoped.body).not.toContain('电棍')

    // The two answers agree by construction rather than by coincidence: storage still returns **both**
    // rows — it is asked for one action by name and knows nothing about shape — while the run's own
    // function is what refuses exactly one of them, which is the difference the screen applies.
    const rows = listCarrierTasksForAction(server.ctx.db, session.userId, 'douyu', 'sign_in')
    expect(rows).toHaveLength(2)

    const douyu = platformFor('douyu')
    expect(douyu).not.toBeNull()
    if (douyu === null) return
    const wouldRun = rows.filter(task => reconcileSelectionFor(douyu.actions, task, true).kind === 'run')
    expect(wouldRun.map(task => task.targetKey)).toEqual([''])

    // And the per-Room action, which neither row names, has no carrier of its own: a Task carrying a
    // Room is not evidence that the action *about* rooms is running under it.
    const perRoom = await workflowOf(server, session.auth(), 'douyu', 'intimacy_tasks')
    expect(perRoom.workflow?.carriers).toEqual([])
    expect(perRoom.workflow?.create).not.toBeNull()
  })

  it('carries a send Task, not only a reconcile one', async ({ server, session }) => {
    // The screen's own sentence was 「现在没有任何任务运行它，所以这个动作开着也不会动。」 over a *running* send
    // loop: the carrier query asked storage for `action = 'reconcile'`, so a send Task could not
    // appear however plainly it named the action, and the create offer beside it claimed the key had
    // no Task at all. A Task names one Action and runs it, whichever executor that action declares.
    // The first half below also pins the offer's `needsLibrary`: a `send` Action cannot be created
    // without one, so a panel that draws the create for it draws a button the route refuses.
    const accountId = bind(server, session, 'douyu', '456918967')
    await enable(server, session, 'douyu', 'send_danmaku')

    const before = await workflowOf(server, session.auth(), 'douyu', 'send_danmaku')
    expect(before.workflow?.carriers).toEqual([])
    expect(before.workflow?.create).toMatchObject({ needsTarget: true, needsLibrary: true })

    const library = await server.app.inject({
      method: 'POST',
      url: '/api/libraries',
      headers: session.auth(),
      payload: { text: '一。二。三。', name: '弹药库' }
    })
    const libraryId = library.json<{ library: { id: number } }>().library.id

    const now = Date.now()
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: session.auth(),
      payload: {
        platform: 'douyu',
        accountId,
        actionKey: 'send_danmaku',
        targetKey: '12306',
        targetTitle: '电棍',
        libraryId,
        startTime: now,
        endTime: now + 60_000,
        interval: 3
      }
    })
    expect(created.statusCode).toBe(200)
    const task = created.json<{ task: { id: number; action: string } }>().task
    // The row really is the other executor's — asserted, so this case cannot pass by having created
    // a reconcile Task under a send action's key.
    expect(task.action).toBe('send')

    const after = await workflowOf(server, session.auth(), 'douyu', 'send_danmaku')

    expect(after.workflow?.carriers.map(carrier => carrier.id)).toEqual([task.id])
    expect(after.workflow?.carriers[0]?.targetTitle).toBe('电棍')
    // No create beside a carrier: the offer is for a key nothing runs, and this one is run.
    expect(after.workflow?.create).toBeNull()

    // And the row is attributed to the action it names and no other, so the reconcile action whose
    // Tasks live on the same Room does not inherit it.
    const other = await workflowOf(server, session.auth(), 'douyu', 'intimacy_tasks')
    expect(other.workflow?.carriers).toEqual([])
  })

  it('keeps one Task per action on the same room, each attributed to its own action', async ({ server, session }) => {
    // The owner's own pair: 亲密度任务 and 粉丝家园钓鱼, both per-Room on the same 直播间. Two rows, and
    // each action attributed to the row that names it — which is the fact the create-or-get on
    // (Platform, target, action) exists for. Under the old key the second create was handed the first
    // row, so 「钓鱼」 had no Task at all and this screen had no way to say so.
    const accountId = bind(server, session, 'douyu', '456918967')
    await enable(server, session, 'douyu', 'intimacy_tasks')
    await enable(server, session, 'douyu', 'fishing')

    await create(server, session, {
      platform: 'douyu',
      accountId,
      actionKey: 'intimacy_tasks',
      targetKey: '12306',
      targetTitle: '电棍'
    })
    await create(server, session, {
      platform: 'douyu',
      accountId,
      actionKey: 'fishing',
      targetKey: '12306',
      targetTitle: '电棍'
    })

    const intimacy = await workflowOf(server, session.auth(), 'douyu', 'intimacy_tasks')
    const fishing = await workflowOf(server, session.auth(), 'douyu', 'fishing')

    expect(intimacy.workflow?.carriers).toHaveLength(1)
    expect(fishing.workflow?.carriers).toHaveLength(1)
    expect(intimacy.workflow?.carriers[0]?.id).not.toBe(fishing.workflow?.carriers[0]?.id)
    expect(intimacy.workflow?.create).toBeNull()
    expect(fishing.workflow?.create).toBeNull()
  })

  it('does not count a Task the scheduler has given up on', async ({ server, session }) => {
    const accountId = bind(server, session, 'douyu', '456918967')
    await enable(server, session, 'douyu', 'intimacy_tasks')
    await create(server, session, {
      platform: 'douyu',
      accountId,
      actionKey: 'intimacy_tasks',
      targetKey: '12306',
      targetTitle: '电棍'
    })

    server.ctx.db.prepare("UPDATE tasks SET status = 'failed' WHERE platform = 'douyu'").run()

    const answer = await workflowOf(server, session.auth(), 'douyu', 'intimacy_tasks')

    // A failed Task will not run, so counting it as a carrier would report coverage that is not
    // there — which is the defect this screen exists to remove, in the other direction.
    expect(answer.workflow?.carriers).toEqual([])
    expect(answer.workflow?.create).not.toBeNull()
  })

  /**
   * The owner's regression, stated as he would state it: **a Task whose window has run out cannot be
   * held against the action for ever.**
   *
   * Every step below is the real one. The Task is created through the real route, swept by the real
   * `Scheduler.tick`, and turned `done` by `runner.ts`'s own `finishTask` when `decide` answers
   * `finish` — the state a person actually reaches, rather than a status written by hand. The second
   * tick is `scheduler-live.test.ts`'s technique for stepping a clock the sweep reads as an argument.
   *
   * What is asserted is the pair the defect joined: the create is offered again, and the row it makes
   * is one the sweep takes. The old behaviour failed both halves — the page said
   * 「会运行它的任务：电棍」 about a row that would never run and withheld the create beside it, and the
   * create route, when a person found another way to ask, resolved that same dead row and returned it.
   * (「会运行它的任务：」 is the heading as it read then; it is 「指名这个动作的任务：」 now, and that is also
   * true of the dead row — the row does name the action — so what keeps it out is this query's status
   * filter and not the words above the list.)
   */
  it('offers the create again once a Task has run its window out, and refuses only the dead row', async ({
    server,
    session
  }) => {
    const accountId = bind(server, session, 'bilibili', '14004964')
    await enable(server, session, 'bilibili', 'like_danmaku')

    const now = Date.now()
    const ended = await server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: session.auth(),
      payload: {
        platform: 'bilibili',
        accountId,
        actionKey: 'like_danmaku',
        targetKey: '12306',
        targetTitle: '电棍',
        startTime: now - 60_000,
        endTime: now - 1_000,
        interval: 300
      }
    })
    expect(ended.statusCode).toBe(200)
    const deadId = ended.json<{ task: { id: number } }>().task.id

    // The window has closed, so the next sweep is where this row becomes `done`. That is the sweep
    // and nothing else — no status is written from here.
    await server.scheduler.tick(now + 1_000)
    expect(server.ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(deadId)?.['status']).toBe(TaskStatus.Done)

    const answer = await workflowOf(server, session.auth(), 'bilibili', 'like_danmaku')

    // The page may not call that row a Task that runs the action…
    expect(answer.workflow?.carriers).toEqual([])
    // …it says how many Tasks ran their window out instead of pretending they never existed…
    expect(answer.workflow?.finishedCarriers).toBe(1)
    // …and the create is back, which is the half that was unreachable before.
    expect(answer.workflow?.create).not.toBeNull()

    const made = await server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: session.auth(),
      payload: {
        platform: 'bilibili',
        accountId,
        actionKey: 'like_danmaku',
        targetKey: '12306',
        targetTitle: '电棍',
        startTime: now,
        endTime: now + 60_000,
        interval: 300
      }
    })
    expect(made.statusCode).toBe(200)
    const freshId = made.json<{ task: { id: number } }>().task.id

    // A fresh row rather than the dead one — that is the create path's half of the fix.
    expect(freshId).not.toBe(deadId)

    // And the sweep takes it. The Task is deliberately left with an unbound room, so the run fails
    // trying to resolve it — `failed` is the positive evidence that the sweep went after this row,
    // and the assertion is `not done` rather than `running` because what this case is about is
    // whether the row is swept at all, not how the Platform answered. `scanned` of one is the other
    // direction's evidence: the finished row beside it is not re-swept, so this count is this row and
    // not both.
    const swept = await server.scheduler.tick(now + 2_000)
    expect(swept.scanned).toBe(1)
    expect(server.ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(freshId)?.['status']).not.toBe(
      TaskStatus.Done
    )
    expect(server.ctx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(deadId)?.['status']).toBe(TaskStatus.Done)
  })

  /**
   * The page's two lists and the run's own answer agree, by construction rather than by coincidence.
   *
   * This is `shows the Tasks that run it, and never the row the run itself refuses`'s technique — ask
   * storage what it holds, ask `reconcileSelectionFor` what the run would do with each row, and
   * compare — extended to the state this change is about. The relation is a partition: **every row
   * naming the action is either a carrier the page names, a finished Task the page counts, or a row
   * the run itself refuses.** So a row can move between the first two only when its status moves, and
   * can never vanish from all three — which is what would make the screen understate or overstate what
   * is running.
   */
  it('accounts for every row it holds: carrier, finished count, or the run’s own refusal', async ({
    server,
    session
  }) => {
    const accountId = bind(server, session, 'douyu', '456918967')
    await enable(server, session, 'douyu', 'sign_in')
    const now = Date.now()

    // One row that runs it — the account-scoped Task, whose empty target is the key a chore list
    // resolves on.
    await create(server, session, { platform: 'douyu', accountId, actionKey: 'sign_in' })
    const live = server.ctx.db.prepare("SELECT id FROM tasks WHERE target_key = ''").get()?.['id']

    // One the run says cannot run it at all, because an account-scoped action sits on a row carrying
    // a Room. The create route allows this direction; only the run refuses it.
    await create(server, session, {
      platform: 'douyu',
      accountId,
      actionKey: 'sign_in',
      targetKey: '12306',
      targetTitle: '电棍'
    })

    // And one that has run its window out. It is inserted directly, with the same (Platform, target,
    // action) key as the live row and a key of its own, because that is the state the sweep reaches
    // and the create route cannot: re-asking that route for the same key while the live row exists
    // resolves to the live row — which is the create-or-get rule working, not a failure to reach it.
    // The sweep's own `done` has a case of its own above; this case is the ledger.
    await insertRow(server.ctx.db, session.userId, accountId, {
      action: TaskAction.Reconcile,
      actionKey: 'sign_in',
      status: 'done',
      targetKey: '',
      startTime: now - 120_000,
      endTime: now - 60_000
    })

    // Which is why the key is worth proving both ways here: a live row and a finished row on one key
    // coexist, and a create for that key is answered with the live one.
    const resolved = await server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: session.auth(),
      payload: {
        platform: 'douyu',
        accountId,
        actionKey: 'sign_in',
        targetKey: '',
        targetTitle: '',
        startTime: now,
        endTime: now + 86_400_000,
        interval: 300
      }
    })
    expect(resolved.json<{ task: { id: number } }>().task.id).toBe(live)

    const answer = await workflowOf(server, session.auth(), 'douyu', 'sign_in')
    const douyu = platformFor('douyu')
    expect(douyu).not.toBeNull()
    if (douyu === null) return

    // The two answers the screen is built from, each asked separately — which is the design being
    // pinned as much as the arithmetic: storage cannot put a status in a shape rule, so it does not
    // try, and the screen reads the two side by side.
    const candidates = listCarrierTasksForAction(server.ctx.db, session.userId, 'douyu', 'sign_in')
    const finished = listFinishedCarrierTasksForAction(server.ctx.db, session.userId, 'douyu', 'sign_in')
    const held = [...candidates, ...finished]

    const runs = (task: (typeof held)[number]): boolean =>
      reconcileSelectionFor(douyu.actions, task, true).kind === 'run'
    const named = held.filter(task => answer.workflow?.carriers.some(carrier => carrier.id === task.id))
    const refused = held.filter(task => !runs(task))
    const counted = finished.filter(runs)

    // Three rows, each handed over by exactly one of the two queries, and the partition covers every
    // one of them.
    expect(held).toHaveLength(3)
    expect(named.length + counted.length + refused.length).toBe(held.length)
    expect(named.map(task => task.id)).toEqual(answer.workflow?.carriers.map(carrier => carrier.id))
    expect(counted.length).toBe(answer.workflow?.finishedCarriers)

    // And the specific answers, so a relation that happened to hold on an empty set cannot pass: the
    // live row is the carrier, the finished row is counted and not carried, and the row the run
    // refuses appears in neither — see `shows the Tasks that run it` for that half's own case.
    expect(answer.workflow?.carriers.map(carrier => carrier.id)).toEqual([live])
    expect(answer.workflow?.finishedCarriers).toBe(1)
    expect(answer.workflow?.create).toBeNull()
  })

  it('keeps one user’s Tasks out of another user’s attribution', async ({ server, session }) => {
    const accountId = bind(server, session, 'douyu', '456918967')
    await enable(server, session, 'douyu', 'intimacy_tasks')
    await create(server, session, {
      platform: 'douyu',
      accountId,
      actionKey: 'intimacy_tasks',
      targetKey: '12306',
      targetTitle: '电棍'
    })

    const other = await registerUser(server, 'workflow_snoop')
    const answer = await workflowOf(server, other.auth(), 'douyu', 'intimacy_tasks')

    expect(answer.workflow?.carriers).toEqual([])
  })
})
