import { readFileSync } from 'node:fs'

import { describe, expect } from 'vitest'

import type { BuiltServer } from '../src/index.js'
import { dayKeyOf, startOfPlatformDay } from '../src/platform/time.js'
import { upsertAccount } from '../src/repo/accounts.js'
import { appendActionLog } from '../src/repo/action-logs.js'
import { appendEvent, EventKind } from '../src/repo/events.js'
import { test as base, registerUser, type Session } from './fixtures.js'

/**
 * Task routes.
 *
 * Binding an account normally requires a QR scan or a pasted token, which a test
 * cannot do, so the `accounts` rows are seeded directly — one per Platform, each
 * with the credential blob its own adapter owns. Everything downstream of that row
 * — validation, the switchboard gate, catalogue lookups, progress arithmetic, state
 * transitions — is exercised through the real HTTP surface.
 *
 * **Both Platforms are used on purpose.** A route that only ever sees `bilibili`
 * could be hearing a hardcoded name rather than reading the catalogue, so the
 * Douyu cases below (its own action keys, its own cadence, an action that needs
 * neither target nor library) are what actually pin platform-neutrality. Douyu's
 * adapter registers itself in `platform/index.ts`; nothing here registers a stub.
 */

interface TaskRow {
  id: number
  platform: string
  action: string
  actionKey: string
  targetKey: string
  status: string
  cursor: number
  loopCount: number
  interval: number
  /** Present on reconcile tasks only: what `action_logs` says about them. */
  actionLogSummary?: {
    total: number
    done: number
    already: number
    skipped: number
    failed: number
    blocked: number
  }
  /** Present on reconcile tasks only: the actions settled on the Platform's day. */
  settledTodayKeys?: string[]
  /** Present on reconcile tasks only: the records for that same day, per-item detail included. */
  actionLogsToday?: {
    actionKey: string
    outcome: string
    detail: string
    code: string
    items: { kind: string; label: string; outcome: string; detail: string; code: string }[]
    at: number
  }[]
  /** Present on reconcile tasks only, and only where the payload asked for it. */
  actionLogDays?: { dayKey: string; startedAt: number; records: { actionKey: string }[] }[]
  progress: {
    cursor: number
    loopCount: number
    sentCount: number
    libraryTotal: number | null
    percentInLoop: number
    remainingInLoop: number | null
  }
}

/**
 * The state every case below starts from: one session, the two accounts the
 * Platforms need, the library a send task consumes, and the switchboard on.
 *
 * It lives here rather than in `fixtures.ts` because it is this file's own subject —
 * the rows a real binding would have produced, in the shapes each adapter owns, and
 * the three switches every create case needs. `fixtures.ts` knows about a server and
 * a user; it has no business knowing about `sign_in` or credential blobs.
 */
interface Desk {
  readonly server: BuiltServer
  readonly session: Session
  readonly accountId: number
  readonly douyuAccountId: number
  readonly libraryId: number
}

const HOUR = 60 * 60 * 1000

const it = base.extend<{ desk: Desk }>({
  desk: async ({ server, session }, use) => {
    // The Bilibili blob is the adapter's shape — a cookie jar inside a JSON string
    // plus the renewal token — and the Douyu one is its own. Neither shape means
    // anything to this route; the rows differ only in `platform`.
    const account = upsertAccount(server.ctx.db, session.userId, {
      platform: 'bilibili',
      externalId: '987654',
      displayName: '测试账号',
      avatar: '',
      credentials: JSON.stringify({
        cookies: JSON.stringify({ SESSDATA: 'secret-cookie', bili_jct: 'y', DedeUserID: '987654' }),
        refreshToken: ''
      })
    })

    const douyu = upsertAccount(server.ctx.db, session.userId, {
      platform: 'douyu',
      externalId: '456789',
      displayName: '斗鱼测试号',
      avatar: '',
      credentials: JSON.stringify({ token: '1_2_3_4_5', did: 'device-id' })
    })

    const imported = await server.app.inject({
      method: 'POST',
      url: '/api/libraries',
      payload: { text: '一。二。三。四。五。六。七。八。九。十。', name: '弹药库' },
      headers: session.auth()
    })

    // The switchboard. Three actions across two Platforms are enabled here because
    // every create case needs its action already on; `growth_pool` is deliberately
    // left off — it is the costly one, and costly actions ship dark.
    await setSwitch(server, session, 'bilibili', 'send_danmaku', true)
    await setSwitch(server, session, 'douyu', 'send_danmaku', true)
    await setSwitch(server, session, 'douyu', 'sign_in', true)

    await use({
      server,
      session,
      accountId: account.id,
      douyuAccountId: douyu.id,
      libraryId: imported.json<{ library: { id: number } }>().library.id
    })
  }
})

/** Flips one switch through the real route, so the gate is exercised as the UI uses it. */
async function setSwitch(
  server: BuiltServer,
  session: Session,
  platform: string,
  actionKey: string,
  enabled: boolean
): Promise<void> {
  const response = await server.app.inject({
    method: 'PUT',
    url: '/api/action-settings',
    payload: { platform, actionKey, enabled },
    headers: session.auth()
  })
  expect(response.statusCode).toBe(200)
}

function createPayload(desk: Desk, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now()
  return {
    platform: 'bilibili',
    accountId: desk.accountId,
    actionKey: 'send_danmaku',
    targetKey: '22637261',
    targetTitle: '某直播间',
    libraryId: desk.libraryId,
    startTime: now - 1000,
    endTime: now + 2 * HOUR,
    interval: 30,
    ...overrides
  }
}

async function createTask(
  desk: Desk,
  overrides: Record<string, unknown> = {}
): Promise<{
  statusCode: number
  body: { ok: boolean; task?: TaskRow; error?: string }
}> {
  const response = await desk.server.app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: createPayload(desk, overrides),
    headers: desk.session.auth()
  })
  return { statusCode: response.statusCode, body: response.json() }
}

/** A Douyu reconcile task: account-scoped, so neither a target nor a library. */
async function createDouyuReconcileTask(desk: Desk): Promise<{
  statusCode: number
  body: { ok: boolean; task?: TaskRow; error?: string }
}> {
  return createTask(desk, {
    platform: 'douyu',
    accountId: desk.douyuAccountId,
    actionKey: 'sign_in',
    targetKey: undefined,
    targetTitle: undefined,
    libraryId: null,
    // Omitted on purpose: Douyu's reconcile actions carry a 60-second floor, and a
    // created-by-hand number would only be a second place to keep in step with it.
    interval: undefined
  })
}

/** How many feed rows point at one Task — the dangling reference `deleteTask` has to remove. */
function eventRowsFor(desk: Desk, taskId: number): number {
  const row = desk.server.ctx.db.prepare('SELECT COUNT(*) AS n FROM events WHERE task_id = ?').get(taskId)
  return Number(row?.['n'])
}

describe('POST /api/tasks', () => {
  it('requires authentication', async ({ desk }) => {
    const response = await desk.server.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: createPayload(desk)
    })
    expect(response.statusCode).toBe(401)
  })

  it('creates a task in the waiting state', async ({ desk }) => {
    const { statusCode, body } = await createTask(desk)
    expect(statusCode).toBe(200)
    expect(body.task?.status).toBe('waiting')
    expect(body.task?.cursor).toBe(0)
    expect(body.task?.loopCount).toBe(0)
  })

  it('records the Platform, the executor and the action key on the task', async ({ desk }) => {
    const { body } = await createTask(desk)
    expect(body.task?.platform).toBe('bilibili')
    // The executor comes from the descriptor, not from the request: the client
    // never says "send", it says which action.
    expect(body.task?.action).toBe('send')
    expect(body.task?.actionKey).toBe('send_danmaku')
  })

  it('cannot be told to store a monitorOnline switch, because nothing reads it and there is no column', async ({
    desk
  }) => {
    // `monitor_online` came in with the upstream field set, and **no code in this build read or wrote
    // it**: the switch a person is actually offered is 「等待开播」, which is `requireOnline` and which
    // `logic.ts` `decide` reads. Wiring a second switch that means the same thing would be a second home
    // for one rule — so the request no longer sets it, and the schema no longer has anywhere to put it
    // (`db/migrations.ts` v3 drops the column; `db/schema.ts` no longer declares it). That is the owner's
    // standing item exactly ("a switch that can be set and has no effect"), taken to its end: there is
    // nothing left that could be set.
    const { statusCode, body } = await createTask(desk, { monitorOnline: false })
    expect(statusCode).toBe(200)

    // The payload is the interface's whole vocabulary, so this is the half that keeps the interface
    // telling the truth: nothing in it can reach a decision.
    expect(body.task).not.toHaveProperty('monitorOnline')

    // And the row the create route produced has nowhere to have written it.
    const columns = desk.server.ctx.db
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .map(row => String(row['name']))
    expect(columns).not.toContain('monitor_online')
    expect(columns).toContain('require_online')
  })

  it('reports the library size in the progress payload', async ({ desk }) => {
    const { body } = await createTask(desk)
    expect(body.task?.progress.libraryTotal).toBe(10)
    expect(body.task?.progress.remainingInLoop).toBe(10)
    expect(body.task?.progress.percentInLoop).toBe(0)
  })

  it('rejects an end time before the start time', async ({ desk }) => {
    const now = Date.now()
    const { statusCode, body } = await createTask(desk, { startTime: now, endTime: now - 1000 })
    expect(statusCode).toBe(400)
    expect(body.error).toContain('结束时间')
  })

  it('accepts a long-running task that the old 12-hour cap would have rejected', async ({ desk }) => {
    const now = Date.now()
    const { statusCode, body } = await createTask(desk, { startTime: now, endTime: now + 30 * 24 * HOUR })
    expect(statusCode).toBe(200)
    expect(body.task?.status).toBe('waiting')
  })

  it('accepts a year-long task', async ({ desk }) => {
    const now = Date.now()
    const { statusCode } = await createTask(desk, { startTime: now, endTime: now + 300 * 24 * HOUR })
    expect(statusCode).toBe(200)
  })

  it('still rejects a duration past the sanity cap', async ({ desk }) => {
    const now = Date.now()
    const { statusCode } = await createTask(desk, { startTime: now, endTime: now + 400 * 24 * HOUR })
    expect(statusCode).toBe(400)
  })

  it('rejects an interval that is not a positive number of seconds', async ({ desk }) => {
    // Structure only: the Platform's cadence is the descriptor's business, but zero
    // or negative seconds is a client bug whatever the Platform says.
    const { statusCode, body } = await createTask(desk, { interval: 0 })
    expect(statusCode).toBe(400)
    expect(body.error).toContain('间隔')
  })

  it('gives the same interval whether the cadence is omitted or sent explicitly', async ({ desk }) => {
    // Douyu's adapter declares 3 seconds for `send_danmaku`, measured against its
    // own server-side floor (~2 s). A global floor in this route used to accept that
    // 3 when omitted and refuse it when sent — so a form that pre-fills the default
    // could never create the task, and the refusal blamed a cadence the Platform
    // itself recommends. Both paths must land on the same number.
    const omitted = await createTask(desk, {
      platform: 'douyu',
      accountId: desk.douyuAccountId,
      actionKey: 'send_danmaku',
      interval: undefined
    })
    expect(omitted.statusCode).toBe(200)
    expect(omitted.body.task?.interval).toBe(3)

    const explicit = await createTask(desk, {
      platform: 'douyu',
      accountId: desk.douyuAccountId,
      actionKey: 'send_danmaku',
      interval: 3
    })
    expect(explicit.statusCode).toBe(200)
    expect(explicit.body.task?.interval).toBe(omitted.body.task?.interval)
  })

  it('rejects an account the user does not own', async ({ desk }) => {
    const { statusCode } = await createTask(desk, { accountId: 999_999 })
    expect(statusCode).toBe(404)
  })

  it('rejects a library the user does not own', async ({ desk }) => {
    const { statusCode } = await createTask(desk, { libraryId: 999_999 })
    expect(statusCode).toBe(404)
  })

  it('rejects an unknown platform', async ({ desk }) => {
    const { statusCode, body } = await createTask(desk, { platform: 'myspace' })
    expect(statusCode).toBe(400)
    expect(body.error).toContain('未知平台')
  })

  it('rejects an action key the Platform does not declare', async ({ desk }) => {
    const { statusCode, body } = await createTask(desk, { actionKey: 'write_poetry' })
    expect(statusCode).toBe(400)
    expect(body.error).toContain('write_poetry')
  })

  it('rejects an account bound to a different Platform', async ({ desk }) => {
    // A task runs as the account it names, so a Bilibili account cannot carry a
    // Douyu action: the mistake is knowable now and would only fail later.
    const { statusCode, body } = await createTask(desk, {
      platform: 'douyu',
      accountId: desk.accountId,
      actionKey: 'sign_in'
    })
    expect(statusCode).toBe(400)
    expect(body.error).toContain('账号不属于平台')
  })

  it('rejects a missing target when the descriptor needs one', async ({ desk }) => {
    const { statusCode, body } = await createTask(desk, { targetKey: undefined })
    expect(statusCode).toBe(400)
    expect(body.error).toContain('目标')
  })

  it('accepts a target key it cannot interpret itself', async ({ desk }) => {
    // Only presence is checked here. What a target *is* belongs to the adapter and
    // is settled by `POST /api/targets/resolve` while the user fills the form; a
    // second, hand-rolled room-number pattern in this route is exactly what the
    // seam removed — and it is why a Platform whose targets are not numeric works.
    const { statusCode, body } = await createTask(desk, { targetKey: 'douyu-room-alpha' })
    expect(statusCode).toBe(200)
    expect(body.task?.targetKey).toBe('douyu-room-alpha')
  })

  it('rejects a send action with no library to send from', async ({ desk }) => {
    const { statusCode, body } = await createTask(desk, { libraryId: null })
    expect(statusCode).toBe(400)
    expect(body.error).toContain('文本库')
  })

  it('creates a Douyu task with neither a target nor a library', async ({ desk }) => {
    // The whole point of the descriptor: `sign_in` is account-scoped, so the two
    // fields a Bilibili room task cannot do without are simply absent here.
    const { statusCode, body } = await createTask(desk, {
      platform: 'douyu',
      accountId: desk.douyuAccountId,
      actionKey: 'sign_in',
      targetKey: undefined,
      targetTitle: undefined,
      libraryId: null,
      // The helper's default is 30, which suits a send action; `sign_in` is a daily
      // chore and its descriptor floor is 60. Naming it here keeps this test about
      // the missing target and library, which is its actual subject.
      interval: 60
    })

    expect(statusCode).toBe(200)
    expect(body.task?.platform).toBe('douyu')
    expect(body.task?.action).toBe('reconcile')
    expect(body.task?.actionKey).toBe('sign_in')
    expect(body.task?.targetKey).toBe('')
    expect(body.task?.progress.libraryTotal).toBeNull()
    expect(body.task?.progress.percentInLoop).toBe(0)
  })

  it('uses the reconcile cadence for a Douyu daily action', async ({ desk }) => {
    const { body } = await createTask(desk, {
      platform: 'douyu',
      accountId: desk.douyuAccountId,
      actionKey: 'sign_in',
      targetKey: undefined,
      libraryId: null,
      interval: undefined
    })
    expect(body.task?.interval).toBe(300)
  })

  it('gives each action its own reconcile task, and one Task per (target, action)', async ({ desk }) => {
    const first = await createDouyuReconcileTask(desk)
    expect(first.body.task?.actionKey).toBe('sign_in')

    // 看广告鱼丸 is a second daily chore on the same account, created through the same form…
    await setSwitch(desk.server, desk.session, 'douyu', 'fishball', true)
    const second = await createTask(desk, {
      platform: 'douyu',
      accountId: desk.douyuAccountId,
      actionKey: 'fishball',
      targetKey: undefined,
      targetTitle: undefined,
      libraryId: null,
      interval: undefined
    })

    // …and it gets a Task of its own, naming it. A reconcile Task runs exactly the action its row
    // names, so handing back the first row would leave 看广告鱼丸 with no Task naming it at all — it
    // would never run — while a second row under the same key would run the same chore list twice.
    // That is the half of the old rule which made a second action impossible to ask for.
    expect(second.statusCode).toBe(200)
    expect(second.body.task?.id).not.toBe(first.body.task?.id)
    expect(second.body.task?.actionKey).toBe('fishball')

    const listed = await desk.server.app.inject({ method: 'GET', url: '/api/tasks', headers: desk.session.auth() })
    expect(listed.json<{ tasks: TaskRow[] }>().tasks).toHaveLength(2)

    // And asking again for the same (Platform, target, action) is still the same row: the
    // create-or-get is what stops a form that was submitted twice from running the work twice.
    const again = await createDouyuReconcileTask(desk)
    expect(again.body.task?.id).toBe(first.body.task?.id)
    const after = await desk.server.app.inject({ method: 'GET', url: '/api/tasks', headers: desk.session.auth() })
    expect(after.json<{ tasks: TaskRow[] }>().tasks).toHaveLength(2)
  })

  it('refuses to create a task for an action whose switch is off', async ({ desk }) => {
    // `growth_pool` spends 200 鱼丸 to enter, so it ships dark. A task nobody can
    // run is worse than a refusal that says which action to turn on.
    const { statusCode, body } = await createTask(desk, {
      platform: 'douyu',
      accountId: desk.douyuAccountId,
      actionKey: 'growth_pool',
      targetKey: undefined,
      libraryId: null
    })
    expect(statusCode).toBe(409)
    expect(body.error).toContain('未开启')
    expect(body.error).toContain('打卡分鱼丸')
  })

  it('refuses to create a send Task for an action whose switch is off', async ({ desk }) => {
    // The same refusal, for the other executor. `growth_pool` above is a reconcile action, and the
    // send one is the case that matters more: a send Task is the row a person creates and then
    // watches for output, and the switch is what decides whether anything happens to it.
    await setSwitch(desk.server, desk.session, 'douyu', 'send_danmaku', false)

    const { statusCode, body } = await createTask(desk, {
      platform: 'douyu',
      accountId: desk.douyuAccountId,
      actionKey: 'send_danmaku',
      targetKey: '99999',
      interval: 3
    })

    expect(statusCode).toBe(409)
    expect(body.error).toContain('未开启')
    expect(body.error).toContain('发送弹幕')
  })

  it('holds no per-user cap: twelve tasks are twelve tasks', async ({ desk }) => {
    // There was a cap of ten active tasks, with a comment calling itself "a sanity limit against
    // typos, not a policy" — and one Task per Action makes it actively wrong, because several Rooms
    // times several actions is more than ten. Pinned by behaviour, since a removed constant leaves
    // nothing behind to assert on: the eleventh create would have been a 400 saying 「上限」.
    for (let index = 0; index < 12; index += 1) {
      const { statusCode, body } = await createTask(desk, { targetKey: String(1000 + index) })
      expect(statusCode, body.error ?? '').toBe(200)
    }

    const listed = await desk.server.app.inject({ method: 'GET', url: '/api/tasks', headers: desk.session.auth() })
    const body = listed.json<{ tasks: TaskRow[]; limit?: number }>()
    expect(body.tasks).toHaveLength(12)
    // The payload carried the cap as `limit`; nothing reads it now, and a number here would be a
    // promise the route no longer keeps.
    expect(body.limit).toBeUndefined()
  })
})

describe('GET /api/tasks', () => {
  it('returns an empty list initially', async ({ desk }) => {
    const response = await desk.server.app.inject({ method: 'GET', url: '/api/tasks', headers: desk.session.auth() })
    expect(response.json<{ tasks: unknown[] }>().tasks).toEqual([])
  })

  it('lists created tasks with progress', async ({ desk }) => {
    await createTask(desk)
    const response = await desk.server.app.inject({ method: 'GET', url: '/api/tasks', headers: desk.session.auth() })
    const body = response.json<{ tasks: TaskRow[] }>()

    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0]?.progress.libraryTotal).toBe(10)
    // Every task payload carries the Platform seam's three fields, which is what
    // lets the UI render a Douyu task and a Bilibili one from the same component.
    expect(body.tasks[0]?.platform).toBe('bilibili')
    expect(body.tasks[0]?.action).toBe('send')
    expect(body.tasks[0]?.actionKey).toBe('send_danmaku')
  })

  it("does not leak another user's tasks", async ({ desk }) => {
    await createTask(desk)

    const other = await registerUser(desk.server, 'other_user')

    const response = await desk.server.app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: other.auth()
    })
    expect(response.json<{ tasks: unknown[] }>().tasks).toEqual([])
  })
})

describe('GET /api/tasks/:id', () => {
  it('returns the task with its account and never that account’s credential', async ({ desk }) => {
    const created = await createTask(desk)
    const id = created.body.task?.id

    const response = await desk.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${String(id)}`,
      headers: desk.session.auth()
    })

    expect(response.statusCode).toBe(200)
    // `Account` has no credential field at all, so this is a property of the type
    // rather than of a deleted key — but the secret is worth pinning literally.
    expect(response.body).not.toContain('secret-cookie')
    expect(response.json<{ account: { platform: string } }>().account.platform).toBe('bilibili')
  })

  it('refuses an id that is not a whole number, rather than reading a prefix of it', async ({ desk }) => {
    // `Number.parseInt` read `/api/tasks/12abc` as task 12, so a mistyped link
    // addressed a different row and said nothing about it. A path is identity, not
    // input to be salvaged.
    for (const id of ['12abc', '12.5', '0']) {
      const response = await desk.server.app.inject({
        method: 'GET',
        url: `/api/tasks/${id}`,
        headers: desk.session.auth()
      })
      expect(response.statusCode).toBe(400)
      expect(response.json<{ error: string }>().error).toBe('无效的任务 ID')
    }
  })
})

describe('PATCH /api/tasks/:id', () => {
  it('pauses and resumes a task', async ({ desk }) => {
    const created = await createTask(desk)
    const id = created.body.task?.id

    const paused = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(id)}`,
      payload: { status: 'paused' },
      headers: desk.session.auth()
    })
    expect(paused.json<{ task: TaskRow }>().task.status).toBe('paused')

    const resumed = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(id)}`,
      payload: { status: 'running' },
      headers: desk.session.auth()
    })
    expect(resumed.json<{ task: TaskRow }>().task.status).toBe('running')
  })

  it('cancels a task', async ({ desk }) => {
    const created = await createTask(desk)
    const id = created.body.task?.id

    const canceled = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(id)}`,
      payload: { status: 'canceled' },
      headers: desk.session.auth()
    })
    expect(canceled.json<{ task: TaskRow }>().task.status).toBe('canceled')
  })

  it('refuses to move a canceled task back to running', async ({ desk }) => {
    const created = await createTask(desk)
    const id = created.body.task?.id

    await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(id)}`,
      payload: { status: 'canceled' },
      headers: desk.session.auth()
    })

    const response = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(id)}`,
      payload: { status: 'running' },
      headers: desk.session.auth()
    })
    expect(response.statusCode).toBe(400)
  })

  it('refuses a status change without storing the window the same request carried', async ({ desk }) => {
    // A PATCH may carry an edit and a status change together, and each half is written by its own
    // statement. The transition was judged *after* the edit, so this request answered 400
    // 「无法从…切换到…」 and left the new window and interval stored: a refusal that had already
    // done half of what it refused, and `readEdits` cannot catch it because it never looks at the
    // status. The row is what this asserts on — the status code alone was already correct.
    const created = await createTask(desk)
    const id = created.body.task?.id ?? 0

    await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(id)}`,
      payload: { status: 'paused' },
      headers: desk.session.auth()
    })

    const before = await desk.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${String(id)}`,
      headers: desk.session.auth()
    })
    const original = before.json<{ task: { startTime: number; endTime: number; interval: number; status: string } }>()
      .task
    expect(original.status).toBe('paused')

    const refused = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(id)}`,
      payload: {
        // A legal edit on its own: the window still runs forward and stays inside the cap.
        endTime: original.startTime + 30 * 60 * 1000,
        interval: original.interval + 15,
        // The half `isTransitionAllowed` refuses: a terminal status is not left by a PATCH.
        status: 'done'
      },
      headers: desk.session.auth()
    })
    expect(refused.statusCode).toBe(400)

    const after = await desk.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${String(id)}`,
      headers: desk.session.auth()
    })
    const stored = after.json<{ task: { endTime: number; interval: number; status: string } }>().task
    expect(stored.endTime).toBe(original.endTime)
    expect(stored.interval).toBe(original.interval)
    expect(stored.status).toBe('paused')
  })

  it('rejects an unknown status value', async ({ desk }) => {
    const created = await createTask(desk)
    const id = created.body.task?.id

    const response = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(id)}`,
      payload: { status: 'exploded' },
      headers: desk.session.auth()
    })
    expect(response.statusCode).toBe(400)
  })

  it("returns 404 for another user's task", async ({ desk }) => {
    const created = await createTask(desk)
    const id = created.body.task?.id

    const other = await registerUser(desk.server, 'snooper')

    const response = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(id)}`,
      payload: { status: 'paused' },
      headers: other.auth()
    })
    expect(response.statusCode).toBe(404)
  })

  it('answers 404 — not 400 — for a task that does not exist, whatever the body says', async ({ desk }) => {
    // The body is validated in the handler, after the lookup, precisely so this
    // stays true: a declared schema would be checked before the handler runs and
    // this request would be told its body is wrong when the honest answer is that
    // there is no such task.
    const response = await desk.server.app.inject({
      method: 'PATCH',
      url: '/api/tasks/424242',
      payload: { interval: 'not-a-number' },
      headers: desk.session.auth()
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<{ error: string }>().error).toBe('任务不存在')
  })

  it('enforces an action’s cadence floor on an edit, with the sentence creation uses', async ({ desk }) => {
    // The floor is the descriptor's, so it has to bind both paths: otherwise the only
    // way to schedule Douyu's send loop faster than Douyu allows would be to create it
    // at 3 seconds and then edit it down to 2.
    const rejectedCreate = await createTask(desk, {
      platform: 'douyu',
      accountId: desk.douyuAccountId,
      actionKey: 'send_danmaku',
      interval: 2
    })
    expect(rejectedCreate.statusCode).toBe(400)

    const created = await createTask(desk, {
      platform: 'douyu',
      accountId: desk.douyuAccountId,
      actionKey: 'send_danmaku',
      interval: 3
    })
    const id = created.body.task?.id

    // Edits apply to paused tasks only.
    await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(id)}`,
      payload: { status: 'paused' },
      headers: desk.session.auth()
    })

    const tooFast = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(id)}`,
      payload: { interval: 2 },
      headers: desk.session.auth()
    })
    expect(tooFast.statusCode).toBe(400)
    // One constraint, one sentence: somebody who hits this on create and again on edit
    // must not conclude they broke two different rules.
    expect(tooFast.json<{ error: string }>().error).toBe(rejectedCreate.body.error)

    const atFloor = await desk.server.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${String(id)}`,
      payload: { interval: 3 },
      headers: desk.session.auth()
    })
    expect(atFloor.statusCode).toBe(200)
    expect(atFloor.json<{ task: TaskRow }>().task.interval).toBe(3)
  })
})

describe('action logs on the task payload', () => {
  it('reports the action log counts for a reconcile task, from both endpoints', async ({ desk }) => {
    const created = await createDouyuReconcileTask(desk)
    expect(created.statusCode).toBe(200)
    const id = created.body.task?.id ?? 0

    // One run's worth of rows: settled, already settled, and parked by the Platform.
    const at = Date.now()
    appendActionLog(desk.server.ctx.db, { taskId: id, actionKey: 'sign_in', outcome: 'done', code: '0' }, at)
    appendActionLog(desk.server.ctx.db, { taskId: id, actionKey: 'fishball', outcome: 'already', code: '0' }, at)
    appendActionLog(desk.server.ctx.db, { taskId: id, actionKey: 'growth_pool', outcome: 'blocked', code: 'stub' }, at)

    const list = await desk.server.app.inject({ method: 'GET', url: '/api/tasks', headers: desk.session.auth() })
    const detail = await desk.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${String(id)}`,
      headers: desk.session.auth()
    })

    const expected = { total: 3, done: 1, already: 1, skipped: 0, failed: 0, blocked: 1 }
    expect(list.json<{ tasks: TaskRow[] }>().tasks[0]?.actionLogSummary).toEqual(expected)
    expect(detail.json<{ task: TaskRow }>().task.actionLogSummary).toEqual(expected)
  })

  it('decides which actions are settled today from the Platform’s midnight', async ({ desk, clock }) => {
    const created = await createDouyuReconcileTask(desk)
    expect(created.statusCode).toBe(200)
    const id = created.body.task?.id ?? 0

    // 2026-03-10 00:00:00 CST, exactly — a fixed instant rather than one derived from
    // the wall clock, because the boundary is the subject of this test.
    const midnight = Date.parse('2026-03-09T16:00:00Z')
    expect(startOfPlatformDay(midnight)).toBe(midnight)
    expect(startOfPlatformDay(midnight - 1)).toBe(midnight - 24 * HOUR)

    // Five rows, and where each sits relative to that boundary is the whole input:
    // a settled one from the previous day, one settled a second before midnight, one a
    // second after, and two from the new day that are not settled (a refusal and a
    // Platform-parked action) because those are the ones worth retrying.
    appendActionLog(desk.server.ctx.db, { taskId: id, actionKey: 'growth_pool', outcome: 'done' }, midnight - 25 * HOUR)
    appendActionLog(desk.server.ctx.db, { taskId: id, actionKey: 'sign_in', outcome: 'done' }, midnight - 1000)
    appendActionLog(desk.server.ctx.db, { taskId: id, actionKey: 'yuba_sign', outcome: 'already' }, midnight + 1000)
    appendActionLog(desk.server.ctx.db, { taskId: id, actionKey: 'fishball', outcome: 'failed' }, midnight + 2000)
    appendActionLog(desk.server.ctx.db, { taskId: id, actionKey: 'activity_sign', outcome: 'blocked' }, midnight + 3000)

    const settledKeysFromList = async (): Promise<string[] | undefined> => {
      const response = await desk.server.app.inject({ method: 'GET', url: '/api/tasks', headers: desk.session.auth() })
      return response.json<{ tasks: TaskRow[] }>().tasks[0]?.settledTodayKeys
    }

    // One second before midnight: the 03-09 list, settled for two of the five keys.
    clock.pinnedAt = midnight - 1
    expect(await settledKeysFromList()).toEqual(['sign_in', 'yuba_sign'])

    // One second after: same rows, same task, and the answer has moved — `sign_in` is
    // yesterday now, `yuba_sign` is today's. This is what the injectable clock bought:
    // the pair is asserted a second apart, not orbited by whichever hour the suite runs.
    clock.pinnedAt = midnight + 1
    expect(await settledKeysFromList()).toEqual(['yuba_sign'])

    // The detail endpoint answers from the same query.
    const detail = await desk.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${String(id)}`,
      headers: desk.session.auth()
    })
    expect(detail.json<{ task: TaskRow }>().task.settledTodayKeys).toEqual(['yuba_sign'])
  })

  it('carries today’s records with their items, and earlier days grouped by day', async ({ desk }) => {
    const created = await createDouyuReconcileTask(desk)
    const id = created.body.task?.id ?? 0

    // The pinned clock is the point of these two instants: one record inside the
    // Platform day the payload is asked about, one outside it.
    const today = desk.server.ctx.now()
    const yesterday = startOfPlatformDay(today) - 12 * HOUR

    appendActionLog(
      desk.server.ctx.db,
      {
        taskId: id,
        actionKey: 'yuba_sign',
        outcome: 'done',
        detail: '鱼吧签到：2 个版块，新签 1、已签 1。',
        items: [
          { kind: 'group', label: '主版块', outcome: 'done', detail: '签到成功，等级分 +3。', code: '200' },
          { kind: 'group', label: '安卓版块', outcome: 'already', detail: '今天已经签到过了。', code: '1001' }
        ]
      },
      today
    )
    appendActionLog(
      desk.server.ctx.db,
      {
        taskId: id,
        actionKey: 'sign_in',
        outcome: 'done',
        detail: '签到成功：连续签到 7 天',
        code: '0',
        items: [{ kind: 'account', label: '客户端签到', outcome: 'done', detail: '签到成功：连续签到 7 天', code: '0' }]
      },
      yesterday
    )

    const detail = await desk.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${String(id)}`,
      headers: desk.session.auth()
    })
    const task = detail.json<{ task: TaskRow }>().task

    // Today: the records themselves, oldest first, each with the per-item detail the
    // console line used to be the only home of — which 版块 was signed and what it gave.
    expect(task.actionLogsToday?.map(record => record.actionKey)).toEqual(['yuba_sign'])
    expect(task.actionLogsToday?.[0]?.items).toEqual([
      { kind: 'group', label: '主版块', outcome: 'done', detail: '签到成功，等级分 +3。', code: '200' },
      { kind: 'group', label: '安卓版块', outcome: 'already', detail: '今天已经签到过了。', code: '1001' }
    ])

    // Earlier: grouped by the store into the Platform day it happened on, so the
    // client is never the thing that decides where a day starts.
    expect(task.actionLogDays?.map(day => day.dayKey)).toEqual([dayKeyOf(yesterday)])
    expect(task.actionLogDays?.[0]?.records.map(record => record.actionKey)).toEqual(['sign_in'])

    // The list endpoint carries today (its row shows today's actions by name) and no
    // history at all: it is polled every five seconds and the row does not show it.
    const list = await desk.server.app.inject({ method: 'GET', url: '/api/tasks', headers: desk.session.auth() })
    const row = list.json<{ tasks: TaskRow[] }>().tasks[0]
    expect(row?.actionLogsToday?.map(record => record.actionKey)).toEqual(['yuba_sign'])
    expect(row?.actionLogDays).toEqual([])
  })

  it('leaves a send task with neither, because its history is send_logs', async ({ desk }) => {
    const { body } = await createTask(desk)
    const id = body.task?.id ?? 0

    // **A send task's `action_logs` is not empty, and this row is why the sentence had to change.**
    // `runSend` writes a standing report there when the action's switch is off (`switch_off`, once per
    // Platform day) — that write is pinned in `scheduler-live.test.ts`, which has a Platform stub to drive
    // a sweep with. Here the row goes in through the same store the runner writes with, so what follows is
    // about the *payload*: the record exists, and none of the four fields below is its reader. Saying
    // "always empty" would have made this case look like it covered a fact it never touched.
    appendActionLog(
      desk.server.ctx.db,
      { taskId: id, actionKey: 'send_danmaku', outcome: 'blocked', detail: '动作开关没打开。', code: 'switch_off' },
      Date.now()
    )

    const list = await desk.server.app.inject({ method: 'GET', url: '/api/tasks', headers: desk.session.auth() })

    // Reconcile-only fields: each one answers a question about a reconcile task's Platform day, and an
    // all-zero object beside the detail endpoint's `logSummary` (which comes from `send_logs`) would be
    // noise rather than information. The `switch_off` row above is outside all four by construction.
    const task = list.json<{ tasks: TaskRow[] }>().tasks[0]
    expect(task).not.toHaveProperty('actionLogSummary')
    expect(task).not.toHaveProperty('settledTodayKeys')
    expect(task).not.toHaveProperty('actionLogsToday')
    expect(task).not.toHaveProperty('actionLogDays')

    // And the detail endpoint reads the send log rather than those records, which is the other half of
    // "its history is `send_logs`".
    const detail = await desk.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${String(id)}`,
      headers: desk.session.auth()
    })
    expect(detail.json<{ task: TaskRow }>().task).not.toHaveProperty('actionLogsToday')
  })
})

describe('POST /api/tasks/:id/reset', () => {
  it('clears progress and returns the task to waiting', async ({ desk }) => {
    const created = await createTask(desk)
    const id = created.body.task?.id ?? 0

    // Simulate progress having been made.
    desk.server.ctx.db
      .prepare(
        'UPDATE tasks SET cursor = 7, loop_count = 2, sent_count = 27, success_count = 25, fail_count = 2 WHERE id = ?'
      )
      .run(id)

    const response = await desk.server.app.inject({
      method: 'POST',
      url: `/api/tasks/${String(id)}/reset`,
      headers: desk.session.auth()
    })

    const task = response.json<{ task: TaskRow }>().task
    expect(task.status).toBe('waiting')
    expect(task.cursor).toBe(0)
    expect(task.loopCount).toBe(0)
    expect(task.progress.percentInLoop).toBe(0)
  })
})

describe('GET /api/tasks/:id/logs', () => {
  it('returns an empty log for a fresh task', async ({ desk }) => {
    const created = await createTask(desk)
    const id = created.body.task?.id

    const response = await desk.server.app.inject({
      method: 'GET',
      url: `/api/tasks/${String(id)}/logs`,
      headers: desk.session.auth()
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ logs: unknown[]; summary: { total: number } }>().summary.total).toBe(0)
  })

  it('returns 404 for an unknown task', async ({ desk }) => {
    const response = await desk.server.app.inject({
      method: 'GET',
      url: '/api/tasks/424242/logs',
      headers: desk.session.auth()
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('DELETE /api/tasks/:id', () => {
  it('removes a task', async ({ desk }) => {
    const created = await createTask(desk)
    const id = created.body.task?.id

    const removed = await desk.server.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${String(id)}`,
      headers: desk.session.auth()
    })
    expect(removed.statusCode).toBe(200)

    const list = await desk.server.app.inject({ method: 'GET', url: '/api/tasks', headers: desk.session.auth() })
    expect(list.json<{ tasks: unknown[] }>().tasks).toEqual([])
  })

  /**
   * The events go with the Task, because nothing else takes them.
   *
   * `send_logs` and `action_logs` reference the task `ON DELETE CASCADE`; `events.task_id` has no
   * foreign key, and `DELETE /api/tasks/:id` called a bare `DELETE FROM tasks` — so `/api/events`
   * went on serving an external consumer rows pointing at a Task that no longer existed, while the
   * same DDL cascades for the other two children. `deleteEventsForTask`'s own sentence is the claim
   * this case holds to.
   */
  it('removes the events it raised, so the feed has no row pointing at a task that is gone', async ({ desk }) => {
    const created = await createTask(desk)
    const id = created.body.task?.id ?? 0

    appendEvent(desk.server.ctx.db, {
      userId: desk.session.userId,
      kind: EventKind.TaskStarted,
      title: '任务开始',
      taskId: id
    })
    expect(eventRowsFor(desk, id)).toBe(1)

    const removed = await desk.server.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${String(id)}`,
      headers: desk.session.auth()
    })
    expect(removed.statusCode).toBe(200)

    expect(eventRowsFor(desk, id)).toBe(0)
  })

  it('returns 404 when deleting twice', async ({ desk }) => {
    const created = await createTask(desk)
    const id = created.body.task?.id

    await desk.server.app.inject({ method: 'DELETE', url: `/api/tasks/${String(id)}`, headers: desk.session.auth() })
    const again = await desk.server.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${String(id)}`,
      headers: desk.session.auth()
    })
    expect(again.statusCode).toBe(404)
  })
})

describe('progress arithmetic', () => {
  it('reports a percentage consistent with the cursor', async ({ desk }) => {
    const created = await createTask(desk)
    const id = created.body.task?.id ?? 0

    desk.server.ctx.db.prepare('UPDATE tasks SET cursor = 3 WHERE id = ?').run(id)

    const response = await desk.server.app.inject({ method: 'GET', url: '/api/tasks', headers: desk.session.auth() })
    const progress = response.json<{ tasks: TaskRow[] }>().tasks[0]?.progress

    expect(progress?.cursor).toBe(3)
    expect(progress?.percentInLoop).toBe(30)
    expect(progress?.remainingInLoop).toBe(7)
  })
})

describe('the README’s sentence about the cap this route dropped', () => {
  it('is a sentence the code can back, which is what the last commit claimed and did not do', () => {
    // The commit that removed the ten-task cap *said* it had fixed this line, and it had not: the diff for
    // `README.md` between `0037d37` and `9c219e9` is empty. So the README went on describing a limit the
    // code no longer had, and a README's reader has no test to consult — which is why the sentence now
    // needs one. The behavioural half ("there is no cap") is the case above; this half is the claim.
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
    const sentence = readme.split('\n').find(line => line.includes('bakapiano')) ?? ''

    expect(sentence).not.toBe('')
    expect(sentence).toContain('10 个任务」的上限没有沿用')
  })
})

describe('userId scoping', () => {
  it('seeds the accounts through the same store the routes read', ({ desk }) => {
    // Guards the setup itself: a test whose fixture landed in the wrong table
    // would fail everywhere below for a reason that has nothing to do with routes.
    const rows = desk.server.ctx.db
      .prepare('SELECT platform FROM accounts WHERE user_id = ? ORDER BY platform')
      .all(desk.session.userId)
    expect(rows.map(row => row['platform'])).toEqual(['bilibili', 'douyu'])
  })
})
