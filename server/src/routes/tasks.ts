import type { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { platformFor } from '../platform/registry.js'
import { startOfPlatformDay } from '../platform/time.js'
import type { ActionDescriptor } from '../platform/types.js'
import { getAccount } from '../repo/accounts.js'
import {
  listActionLogDays,
  listActionLogsSince,
  settledActionKeysSince,
  summarizeActionLogs
} from '../repo/action-logs.js'
import { getActionSetting } from '../repo/action-settings.js'
import { getLibrary } from '../repo/libraries.js'
import { listSendLogs, summarizeSendLogs } from '../repo/send-logs.js'
import {
  clearTaskClocks,
  createTask,
  deleteTask,
  findReconcileTask,
  getTask,
  listTasks,
  resetTaskProgress,
  type Task,
  TaskAction,
  TaskStatus,
  updateTaskStatus
} from '../repo/tasks.js'
import { type AppContext, requireUser } from './context.js'
import { bodyOrEmpty, idParam, queryInt, requireBody } from './validation.js'

/**
 * Task routes.
 *
 * A task binds a Platform account, an action from that Platform's catalogue, and
 * — only when the catalogue says so — a target and a text library. Nothing here
 * names a Platform: every fact about what an action needs arrives as the
 * `ActionDescriptor` the registry hands back, so a Douyu task is a row in a
 * catalogue rather than a branch in this file. That is the whole change: the
 * previous version hardcoded `taskType: 'live'` and demanded a room id from every
 * caller, which is exactly what made a second Platform impossible.
 *
 * Three properties this file is careful about:
 *
 *  - **Everything is scoped by `request.userId`.** An account, a library and a
 *    task are all looked up through the caller, so a guessed id 404s instead of
 *    resolving someone else's row.
 *  - **Unknown catalogue entries are refused up front** (400). An action key is
 *    data, so a typo cannot be caught by a type system — and a task pointing at
 *    an action no adapter knows would only ever fail inside the sweep.
 *  - **The switchboard gates creation, not just execution** (409). A task whose
 *    action is switched off can never run; refusing it while the user is looking
 *    at the form beats storing a row that quietly does nothing.
 *
 * The progress shape returned by the list/detail endpoints is the contract the UI
 * renders, so it is assembled server-side rather than making the client join task
 * rows with library counts.
 *
 * **There is no cap on how many tasks a person may hold.** There was one — ten active
 * tasks, described by its own comment as "a sanity limit against typos, not a policy" —
 * and a Task naming exactly one Action is what made it actively wrong: several Rooms
 * times several actions is more than ten, and the number was never anything but a guess.
 */

/**
 * Structural floor for an interval: a positive whole number of seconds.
 *
 * **Not** a cadence policy, and deliberately not the 10 this route used to carry.
 * What a Platform tolerates is a Platform fact, and the only carrier the descriptor
 * has for it is `defaultIntervalSeconds` (Bilibili 30, Douyu 3 — a measured value
 * that sits above a ~2 s server-side floor). A global floor here produced a
 * self-contradiction: Douyu's own recommended 3 was accepted when `interval` was
 * omitted and refused when the client sent it explicitly, so a form that pre-fills
 * the default — the usual thing for a form to do — could never create that task.
 *
 * So this is a **structural** floor only: positive whole seconds, nothing more.
 * Each Platform's real cadence floor is `ActionDescriptor.minIntervalSeconds`,
 * enforced below once the catalogue lookup has said which action was asked for.
 * A zod schema runs before that lookup and therefore cannot know the number, which
 * is why these two checks live in different places rather than being merged into
 * one convenient constant that would be wrong for every Platform but one.
 */
export const MIN_INTERVAL_SECONDS = 1

/**
 * Upper bound on a task's window.
 *
 * Long-running tasks are the normal case here — a "独轮车" is expected to sit on
 * a room indefinitely — so this is a sanity limit against typos, not a policy.
 * The original 12-hour cap made long-lived tasks impossible.
 */
export const MAX_DURATION_SECONDS = 365 * 24 * 60 * 60

/**
 * The create body.
 *
 * Zod rather than the field-by-field readers this route used to carry, because
 * the shape changed with the seam: `platform` and `actionKey` replaced
 * `taskType`, and `interval` became optional (the catalogue supplies a default).
 * The field-level messages are part of the UI contract, so each rule names itself
 * in Chinese. Relational rules — end after start, the duration cap — stay
 * hand-written below, because they are about two fields at once and no schema
 * expresses them better than the sentence does.
 *
 * Unknown keys are stripped rather than rejected: a client that has not caught up
 * with the seam sends `taskType`, and ignoring it is friendlier than a 400 that
 * says nothing about why.
 *
 * **`monitorOnline` is one of the stripped keys, and its absence is the change rather than an
 * oversight.** The column it filled came in with the upstream field set (`db/schema.ts`'s
 * `monitor_online`, whose only comment is 「wait for live_status = 1」) and **no code in this build ever
 * read it**: the switch a person is offered is 「等待开播」, which is `requireOnline`, and `decide` in
 * `logic.ts` is what reads that one. It was therefore a switch a request could set, that stored a value,
 * that changed nothing — the shape the owner's standing item names. Wiring it instead would have meant a
 * second switch meaning the same thing as a live one, which is one rule with two homes; so the accepting
 * end is gone. The column stays where it is (dropping it is a migration, and it is not this route's
 * business), which is also why the create below does not write it.
 */
const createTaskSchema = z.object({
  platform: z.string({ error: '请选择平台' }).min(1, '请选择平台'),
  accountId: z.number({ error: '请选择账号' }).pipe(z.int({ error: '账号 ID 无效' }).positive('账号 ID 无效')),
  actionKey: z.string({ error: '请选择动作' }).min(1, '请选择动作'),
  targetKey: z.string({ error: '无效的目标' }).optional(),
  targetTitle: z.string({ error: '无效的目标标题' }).optional(),
  libraryId: z
    .number({ error: '无效的文本库 ID' })
    .pipe(z.int({ error: '无效的文本库 ID' }).positive('无效的文本库 ID'))
    .nullable()
    .optional(),
  startTime: z.int({ error: '请提供有效的开始与结束时间' }),
  endTime: z.int({ error: '请提供有效的开始与结束时间' }),
  interval: z.int({ error: '发送间隔无效' }).min(MIN_INTERVAL_SECONDS, '发送间隔至少 1 秒').optional(),
  saltEnabled: z.boolean({ error: '加盐参数无效' }).optional(),
  requireOnline: z.boolean({ error: '等待开播参数无效' }).optional()
})

type CreateTaskBody = z.infer<typeof createTaskSchema>

/**
 * The edit body, and the one field a PATCH may carry besides the edits.
 *
 * Structural only: whether each field is present, and whether it is the kind of
 * value the column holds. The relational rules — end after start, the duration
 * cap — stay in `readEdits`, because they are about two fields at once and a
 * schema spells them no better than the sentence does. Every field is optional
 * because an edit sends only what changed, which also makes a PATCH with no body
 * at all a legal "tell me the current state" request: see `bodyOrEmpty`.
 *
 * The messages are this route's own, and they are not the create route's: a
 * client that was told「开始时间无效」by an edit keeps being told that.
 */
const updateTaskSchema = bodyOrEmpty(
  z.object({
    status: z.enum(TaskStatus, { error: '请提供有效的任务状态' }).optional(),
    startTime: z.int({ error: '开始时间无效' }).optional(),
    endTime: z.int({ error: '结束时间无效' }).optional(),
    interval: z.int({ error: '发送间隔无效' }).min(MIN_INTERVAL_SECONDS, '发送间隔至少 1 秒').optional(),
    requireOnline: z.boolean({ error: '等待开播参数无效' }).optional(),
    saltEnabled: z.boolean({ error: '加盐参数无效' }).optional()
  })
)

type UpdateTaskBody = z.infer<typeof updateTaskSchema>

/** Fields a user may change after creation, resolved and validated. */
export interface TaskEdits {
  startTime: number
  endTime: number
  interval: number
  requireOnline: boolean
  saltEnabled: boolean
}

/**
 * Reads the editable fields from a parsed PATCH body.
 *
 * Absent fields keep their current value rather than resetting, so the client
 * can send only what changed. Returns an error string instead of throwing —
 * these are user input, not programmer errors.
 */
export function readEdits(body: UpdateTaskBody, task: Task): { values: TaskEdits | null; error?: string } {
  const touched =
    body.startTime !== undefined ||
    body.endTime !== undefined ||
    body.interval !== undefined ||
    body.requireOnline !== undefined ||
    body.saltEnabled !== undefined

  if (!touched) return { values: null }

  const startTime = body.startTime ?? task.startTime
  const endTime = body.endTime ?? task.endTime
  const interval = body.interval ?? task.interval
  const requireOnline = body.requireOnline ?? task.requireOnline
  const saltEnabled = body.saltEnabled ?? task.saltEnabled

  if (endTime <= startTime) {
    return { values: null, error: '结束时间必须晚于开始时间' }
  }

  if ((endTime - startTime) / 1000 > MAX_DURATION_SECONDS) {
    return { values: null, error: `生效时长不能超过 ${String(Math.floor(MAX_DURATION_SECONDS / 86400))} 天` }
  }

  return { values: { startTime, endTime, interval, requireOnline, saltEnabled } }
}

interface Progress {
  cursor: number
  loopCount: number
  sentCount: number
  successCount: number
  failCount: number
  libraryTotal: number | null
  bulletIndex: number
  percentInLoop: number
  remainingInLoop: number | null
}

/**
 * Builds the progress payload.
 *
 * `percentInLoop` answers "how far through the current pass am I", which is the
 * question the UI actually asks. Reporting raw counts would leave the user to
 * divide by a library size they cannot see.
 */
function progressOf(task: Task, libraryTotal: number | null): Progress {
  const total = libraryTotal !== null && libraryTotal > 0 ? libraryTotal : null
  const cursor = task.cursor

  return {
    cursor,
    loopCount: task.loopCount,
    sentCount: task.sentCount,
    successCount: task.successCount,
    failCount: task.failCount,
    libraryTotal: total,
    bulletIndex: cursor,
    percentInLoop: total === null ? 0 : Math.min(100, Math.round((cursor / total) * 1000) / 10),
    remainingInLoop: total === null ? null : Math.max(0, total - cursor)
  }
}

/**
 * Decides whether a status change is allowed.
 *
 * `done` and `canceled` are terminal: a finished task is restarted through
 * `/reset` so the cursor and counters move together, never by flipping status.
 */
function isTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
  const terminal: readonly TaskStatus[] = [TaskStatus.Done, TaskStatus.Canceled, TaskStatus.Failed]
  if (from === to) return true
  if (terminal.includes(from)) return false
  return (
    to === TaskStatus.Running || to === TaskStatus.Paused || to === TaskStatus.Canceled || to === TaskStatus.Waiting
  )
}

/** The library total a progress payload needs, or null when there is no library. */
function libraryTotalOf(ctx: AppContext, userId: number, libraryId: number | null): number | null {
  if (libraryId === null) return null
  return getLibrary(ctx.db, userId, libraryId)?.bulletCount ?? null
}

/**
 * How many earlier-day records a detail payload carries.
 *
 * The 历史 section is a per-day collapsible list, so it needs the records themselves
 * rather than counts. The cap exists because `/api/tasks` is polled every five
 * seconds — and the list is where it bites, so the list asks for **none** of this
 * (`historyLimit = 0` below) while the pages a person is looking at ask for all of
 * it. Today's records are carried by every payload instead: they are bounded by the
 * day, and the task list row shows today's actions by name.
 */
const HISTORY_LOG_LIMIT = 200

/**
 * A task exactly as every endpoint returns it.
 *
 * One builder rather than a spread per handler: the client renders one component for
 * a task, so the shape must not depend on which endpoint handed it over.
 *
 * Four reconcile-only fields ride along, and the difference between them is the point:
 *
 *  - `actionLogSummary` counts the task's records **inside the retained window** — the current Platform
 *    day in full, plus the newest `ACTION_LOG_RETENTION_PER_TASK` rows of everything before it
 *    (`repo/action-logs.ts`), which is exactly what `pruneActionLogs` leaves behind. It is *not* the
 *    task's whole history, and the
 *    difference is reachable rather than theoretical: a Task parked for one Platform day at a one-minute
 *    cadence writes about 1,440 rows, so a long-lived reconcile Task has certainly lost some. (The
 *    function is `summarizeActionLogs`, the sibling of `summarizeSendLogs` — its `failed` is a remainder,
 *    so it is reused rather than reimplemented.)
 *  - `settledTodayKeys` names the actions that reached a settled outcome on the
 *    Platform's **current day**. It comes from `settledActionKeysSince` with the very
 *    same range and day boundary the scheduler's `settledToday` uses, so the UI's
 *    "今日已完成 / 还有几个待办" and the scheduler's "do not ask the Platform again" read
 *    from one answer instead of two that can drift.
 *  - `actionLogsToday` is the records themselves for that same day, oldest first:
 *    which 鱼吧 was signed, what the check-in awarded. The counters above say how many,
 *    these say which — and it is per-record because one action can run more than once
 *    in a day, so a per-action projection would have to drop one of the runs.
 *  - `actionLogDays` is everything earlier, grouped into Platform days by the store
 *    (`listActionLogDays`). The grouping is not done here because a day boundary is a
 *    Platform fact and the client is not in that timezone; two homes for it would be
 *    two answers to "which day was that".
 *
 * Reading "done today" off the lifetime counter is the trap worth naming: a task that
 * ran yesterday and has not run yet today has a healthy `actionLogSummary` and would
 * be shown as finished all morning. Which actions were settled *today* is therefore
 * not re-derived here or left to the client — the day belongs to the Platform
 * (`startOfPlatformDay`), and it is asked for in one place.
 *
 * A send task carries none of them, because a different record answers its question: its history is
 * `send_logs`, which the detail endpoint already returns as `logSummary`. **Its `action_logs` is not empty,
 * though, and saying so would be a lie the next reader would act on**: `runSend` writes one standing report
 * there when the action's switch is off (`switch_off`, bounded to once per Platform day by the same rule
 * `runReconcile` uses), and the record's single consumer today is its own guard
 * (`hasActionLogWithCodeSince`). The four fields below are not that report's reader — they are answers about
 * a reconcile task's Platform day — which is why the branch itself is `Reconcile` and a send task's records
 * have no place in the payload yet.
 *
 * `now` is passed in rather than read from the global clock: `settledTodayKeys` *is*
 * a question about which Platform day it is, so a day a test cannot fix is a day a test
 * can only orbit — the assertions would pass or fail according to the hour the suite
 * happens to run at. `ctx.now` is the one clock the HTTP layer reads.
 *
 * `historyLimit` is how many earlier-day records the payload carries, and **`0` means
 * none is asked for** rather than "the smallest useful number": the list endpoint wants
 * an empty section, and the store's own floor of one row — which is right for "the
 * newest entry" — would otherwise answer that question with a day of history.
 */
function taskPayloadOf(
  db: DatabaseSync,
  task: Task,
  libraryTotal: number | null,
  now: number,
  historyLimit = HISTORY_LOG_LIMIT
) {
  const dayStart = startOfPlatformDay(now)

  return {
    ...task,
    progress: progressOf(task, libraryTotal),
    ...(task.action === TaskAction.Reconcile
      ? {
          actionLogSummary: summarizeActionLogs(db, task.id),
          settledTodayKeys: settledActionKeysSince(db, task.id, dayStart),
          actionLogsToday: listActionLogsSince(db, task.id, dayStart),
          actionLogDays: historyLimit === 0 ? [] : listActionLogDays(db, task.id, dayStart, historyLimit)
        }
      : {})
  }
}

/**
 * The one sentence that explains a cadence floor.
 *
 * One function for both paths — the create above and the edit below — because the
 * same constraint described in two different ways reads like two different
 * constraints, and a person who hits it twice would reasonably conclude they had
 * broken two rules.
 */
function intervalFloorMessage(label: string, minIntervalSeconds: number): string {
  return `动作「${label}」的发送间隔不能低于 ${String(minIntervalSeconds)} 秒`
}

/**
 * The descriptor of the action a task runs, or null when this build cannot name it.
 *
 * Null has two causes and they are the same kind of fact: `platformFor` answers null
 * for a Platform key written by a newer build, and `find` answers undefined for an
 * action key this build's adapter no longer declares. Both mean "this process does
 * not know that action's cadence", and the caller's choice of what to do with that
 * is written down at the call site rather than hidden here.
 */
function descriptorOfTask(task: Task): ActionDescriptor | null {
  return platformFor(task.platform)?.actions.find(action => action.key === task.actionKey) ?? null
}

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Lifecycle list with progress. */
  app.get('/api/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request, reply, ctx)
    if (user === null) return undefined

    const tasks = listTasks(ctx.db, user.id)

    // Library totals are looked up once per distinct library, not per task.
    // `null` is cached too: a missing or empty library is just as expensive to
    // rediscover as a populated one.
    const totals = new Map<number, number | null>()
    const rows = tasks.map(task => {
      let total: number | null = null
      if (task.libraryId !== null) {
        const cached = totals.get(task.libraryId)
        if (cached !== undefined) {
          total = cached
        } else {
          total = libraryTotalOf(ctx, user.id, task.libraryId)
          totals.set(task.libraryId, total)
        }
      }
      // No earlier-day records on a list row: this endpoint is polled every five
      // seconds and the row shows today, so shipping up to `HISTORY_LOG_LIMIT`
      // records per task would buy nothing and be paid for on every poll.
      return taskPayloadOf(ctx.db, task, total, ctx.now(), 0)
    })

    return { ok: true, tasks: rows }
  })

  app.post<{ Body: CreateTaskBody }>(
    '/api/tasks',
    { schema: { body: createTaskSchema } },
    async (request: FastifyRequest<{ Body: CreateTaskBody }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const body = request.body

      // The catalogue is the only source of truth about what exists. An unknown
      // pair is a 400 rather than a 404: the request names something that is not
      // installed, and the UI learns what is from `GET /api/platforms`.
      const platform = platformFor(body.platform)
      if (platform === null) {
        return reply.code(400).send({ ok: false, error: `未知平台：${body.platform}` })
      }

      const descriptor = platform.actions.find(action => action.key === body.actionKey)
      if (descriptor === undefined) {
        return reply.code(400).send({
          ok: false,
          error: `平台「${platform.label}」没有动作「${body.actionKey}」`
        })
      }

      const account = getAccount(ctx.db, user.id, body.accountId)
      if (account === null) return reply.code(404).send({ ok: false, error: '账号不存在' })

      // A task runs through the account it names, so a Platform mismatch is not a
      // scheduling problem to discover later — it is a request that cannot be
      // honoured at all, and saying so now beats a task that fails every sweep.
      if (account.platform !== platform.key) {
        return reply.code(400).send({ ok: false, error: `账号不属于平台「${platform.label}」` })
      }

      // **The switchboard gate: the switch is what lets an action run, not only what lets a Task be
      // created for it.** The scheduler reads this same row — through this same `getActionSetting`
      // — before it dispatches a task, for a send action and a reconcile action alike, so a task
      // created for a switched-off action would be a row that does nothing while looking healthy in
      // the list. Refusing it here, while the person is still looking at the form, is the courtesy
      // that beats storing it.
      //
      // It is a courtesy and not the enforcement: this check can only see the moment of creation,
      // and a switch can be turned off afterwards — which is the case the run's own read exists for.
      // Whoever touches the send executor has to keep that read, or this refusal would quietly
      // become the whole rule.
      const setting = getActionSetting(ctx.db, user.id, platform.key, descriptor.key)
      if (setting === null || !setting.enabled) {
        return reply.code(409).send({
          ok: false,
          error: `动作「${descriptor.label}」未开启，请先在动作开关中启用`
        })
      }

      // The target is normalised here rather than at the insert, because the create-or-get
      // below is a question about it. `needsTarget` is what replaced the hardcoded room
      // requirement: an account-scoped action such as a check-in has no target at all, and
      // a Platform whose targets are not numeric must not be forced through the Bilibili
      // room-id pattern this route used to apply.
      const targetKey = (body.targetKey ?? '').trim()

      // **A reconcile task is create-or-get, keyed by (Platform, target, action).**
      //
      // `task.actionKey` is what the run carries: `runner.ts` hands the adapter the action this row
      // names and nothing else. So the action belongs to the row's identity along with the target.
      // The same action on the same Target is the same row — a second one would do that work twice,
      // under a second task id, with nothing in the UI to explain it — while a *different* action on
      // the same Room is a different row, because the work is different. That second half is what a
      // person could not get before: the lookup ignored the action, so asking for a second one handed
      // back the row that already existed and the action ran only because the switchboard ran
      // everything of that shape.
      //
      // A row created under that older rule keeps the action it was created with and now runs only
      // that one. The other actions which used to ride on it each need a Task naming them, and the
      // action switches screen says which action has one and offers to create it where none does.
      //
      // The existing task is returned untouched, including its window: a create that
      // silently re-scheduled an existing task's hours would be a worse surprise than
      // ignoring the hours it was handed.
      if (descriptor.action === TaskAction.Reconcile) {
        const existing = findReconcileTask(ctx.db, user.id, platform.key, targetKey, descriptor.key)
        if (existing !== null) {
          return {
            ok: true,
            task: taskPayloadOf(ctx.db, existing, libraryTotalOf(ctx, user.id, existing.libraryId), ctx.now())
          }
        }
      }

      if (body.endTime <= body.startTime) {
        return reply.code(400).send({ ok: false, error: '结束时间需晚于开始时间' })
      }
      if ((body.endTime - body.startTime) / 1000 > MAX_DURATION_SECONDS) {
        return reply.code(400).send({ ok: false, error: `任务最长持续 ${String(MAX_DURATION_SECONDS / 3600)} 小时` })
      }

      // Omitted means "the Platform's sensible cadence", and it is taken as given:
      // `defaultIntervalSeconds` is a measured value per action — Bilibili allows 30
      // seconds for a send loop, Douyu's adapter records 3 as the safe side of a ~2 s
      // server-side floor it probed — so replacing it with anything this route
      // believes is better would be swapping a measurement for a guess. Sending the
      // same number explicitly has to mean the same thing, which is why the schema
      // only insists that an interval is a positive whole number: see
      // `MIN_INTERVAL_SECONDS`.
      const interval = body.interval ?? descriptor.defaultIntervalSeconds

      // The Platform's own cadence floor. Checked here and not in the schema because
      // the schema runs before the catalogue lookup, so only this point in the request
      // knows which action was asked for. Omitting `interval` takes the descriptor's
      // measured default and passing the same number explicitly has to mean the same
      // thing — that equivalence is the whole reason this is a comparison against the
      // descriptor rather than a second global constant. The edit path asks the same
      // question of the same number through `intervalFloorMessage`, so the constraint
      // has exactly one sentence and one home.
      if (interval < descriptor.minIntervalSeconds) {
        return reply
          .code(400)
          .send({ ok: false, error: intervalFloorMessage(descriptor.label, descriptor.minIntervalSeconds) })
      }

      // `needsTarget` is already what decided whether a target had to be present — see the
      // create-or-get above, where the value was normalised.
      if (descriptor.needsTarget && targetKey === '') {
        return reply.code(400).send({ ok: false, error: `动作「${descriptor.label}」需要选择目标` })
      }

      let libraryId: number | null = null
      if (body.libraryId !== undefined && body.libraryId !== null) {
        // Ownership is checked whenever a library is named, not only when the
        // descriptor wants one: the row is storage either way.
        if (getLibrary(ctx.db, user.id, body.libraryId) === null) {
          return reply.code(404).send({ ok: false, error: '文本库不存在' })
        }
        libraryId = body.libraryId
      } else if (descriptor.needsLibrary) {
        // A `send` action without ammunition has nothing to do; the scheduler would
        // fail it on the first sweep with「任务未关联文本库」.
        return reply.code(400).send({ ok: false, error: `动作「${descriptor.label}」需要选择文本库` })
      }

      const task = createTask(ctx.db, user.id, {
        platform: platform.key,
        accountId: account.id,
        libraryId,
        // The executor and the concrete action both come from the descriptor, so
        // this route never decides what an action is.
        action: descriptor.action,
        actionKey: descriptor.key,
        targetKey,
        targetTitle: (body.targetTitle ?? '').slice(0, 200),
        startTime: body.startTime,
        endTime: body.endTime,
        interval,
        saltEnabled: body.saltEnabled ?? true,
        requireOnline: body.requireOnline ?? true
      })

      return { ok: true, task: taskPayloadOf(ctx.db, task, libraryTotalOf(ctx, user.id, libraryId), ctx.now()) }
    }
  )

  app.get<{ Params: { id: number } }>(
    '/api/tasks/:id',
    { schema: { params: z.object({ id: idParam('无效的任务 ID') }) } },
    async (request: FastifyRequest<{ Params: { id: number } }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const taskId = request.params.id

      const task = getTask(ctx.db, user.id, taskId)
      if (task === null) return reply.code(404).send({ ok: false, error: '任务不存在' })

      const library = task.libraryId === null ? null : getLibrary(ctx.db, user.id, task.libraryId)
      // Scoped, and credential-free by construction: `Account` has no credential
      // field, so a leak here is not something a future edit can introduce by
      // forgetting to delete a key.
      const account = getAccount(ctx.db, user.id, task.accountId)

      return {
        ok: true,
        task: taskPayloadOf(ctx.db, task, library?.bulletCount ?? null, ctx.now()),
        library,
        account,
        logSummary: summarizeSendLogs(ctx.db, taskId)
      }
    }
  )

  /**
   * Pause, resume, or cancel — and, for a paused task, edit its window.
   *
   * The body is **not** in this route's schema, and the order is the reason: Fastify
   * validates a declared schema before the handler runs, so a PATCH naming an id that
   * does not exist would answer 400 about the body instead of 404 about the row. A
   * missing task is not a bad request, and the not-found answer has to win.
   */
  app.patch<{ Params: { id: number } }>(
    '/api/tasks/:id',
    { schema: { params: z.object({ id: idParam('无效的任务 ID') }) } },
    async (request: FastifyRequest<{ Params: { id: number } }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const taskId = request.params.id

      const task = getTask(ctx.db, user.id, taskId)
      if (task === null) return reply.code(404).send({ ok: false, error: '任务不存在' })

      const body = requireBody(updateTaskSchema, request, reply)
      if (body === null) return undefined

      // ---- edits (paused tasks only) --------------------------------
      //
      // Editing is restricted to paused tasks on purpose: the scheduler sweeps
      // every few seconds, so changing the interval or window of a running task
      // would race against a send that is already in flight. Pausing first makes
      // the change deliberate.
      //
      // Edits never touch progress. The cursor and loop count stay where they
      // are, so the change affects what gets sent next, not what was sent before.
      const edits = readEdits(body, task)
      if (edits.error !== undefined) {
        return reply.code(400).send({ ok: false, error: edits.error })
      }

      if (edits.values !== null) {
        if (task.status !== TaskStatus.Paused) {
          return reply.code(400).send({ ok: false, error: '只有暂停中的任务可以编辑，请先暂停' })
        }

        // The cadence floor binds an edit exactly as it binds a create — otherwise the
        // only way to schedule a Douyu send loop faster than that Platform allows would
        // be to create it at 3 s and then edit it down to 2.
        //
        // Only a value the request actually sets is judged. An edit that touches the
        // window or the switches leaves `interval` at what the task already carries, and
        // a task stored below a floor raised since would otherwise become uneditable: a
        // housekeeping change refused for a rule it never broke.
        //
        // A Platform or action key this build cannot name is not judged at all. The
        // floor belongs to an adapter, and inventing one here would enforce a cadence
        // for an action no adapter declares — while refusing would block a legitimate
        // edit on a task that a newer build may be perfectly able to run. The unsafe
        // direction is the other one: letting the number through only means the
        // Platform answers for itself, which is what the sweep already reports.
        if (body.interval !== undefined) {
          const descriptor = descriptorOfTask(task)
          if (descriptor !== null && edits.values.interval < descriptor.minIntervalSeconds) {
            return reply
              .code(400)
              .send({ ok: false, error: intervalFloorMessage(descriptor.label, descriptor.minIntervalSeconds) })
          }
        }
      }

      // ---- status: decided before the first write --------------------
      //
      // **One PATCH can carry an edit and a status change, and the two are written by two
      // statements, so the refusal has to come before both.** This check used to sit between
      // them: a request it refused answered 400 「无法从…切换到…」 while the window it brought
      // along was already stored — the answer said the request did not happen beside a row that
      // half happened, and `readEdits` cannot catch it because it never looks at the status.
      // Everything above this line is a read, so refusing here leaves the row as it was. It is
      // also why the whole decision sits here rather than inside the edit branch: the branch
      // below writes, and there is no second chance to change our mind after that.
      //
      // `db/tx.ts` is the other way to get this, and it is deliberately not used: a savepoint
      // would write and then undo, where the answer is already available before the write.
      const next = body.status
      if (next !== undefined && !isTransitionAllowed(task.status, next)) {
        return reply.code(400).send({ ok: false, error: `无法从「${task.status}」切换到「${next}」，请先重置进度` })
      }

      if (edits.values !== null) {
        ctx.db
          .prepare(
            `UPDATE tasks
             SET start_time = ?, end_time = ?, interval = ?, require_online = ?, salt_enabled = ?
             WHERE id = ? AND user_id = ?`
          )
          .run(
            edits.values.startTime,
            edits.values.endTime,
            edits.values.interval,
            edits.values.requireOnline ? 1 : 0,
            edits.values.saltEnabled ? 1 : 0,
            taskId,
            user.id
          )
      }

      // Edit-only request: report the new state without changing status.
      if (next === undefined) {
        const current = getTask(ctx.db, user.id, taskId)
        if (current === null) return reply.code(404).send({ ok: false, error: '任务不存在' })
        return {
          ok: true,
          task: taskPayloadOf(ctx.db, current, libraryTotalOf(ctx, user.id, current.libraryId), ctx.now())
        }
      }

      // Every refusal this request can earn has been made above — the transition among them,
      // before the edit was written — so from here on the request is a write.

      // Resuming clears two clocks, not one:
      //
      //   last_sent_at    — otherwise the first send is judged against an
      //                     interval that partly elapsed while paused
      //   last_checked_at — otherwise the live-status probe waits out a timer
      //                     that has already run, and a task resumed into a room
      //                     that is live right now sits idle until it expires
      //
      // Clearing the probe timestamp makes the sweep re-check the room on its
      // next tick — a few seconds — rather than up to a full poll interval later.
      //
      // Both live in `clearTaskClocks`, because 重置进度 below retires the same two for the same reason
      // and a second spelling of "the clocks" is how one of the two routes ends up clearing only one.
      updateTaskStatus(ctx.db, taskId, next)
      if (next === TaskStatus.Running) {
        clearTaskClocks(ctx.db, taskId)
      }

      const updated = getTask(ctx.db, user.id, taskId)
      if (updated === null) return reply.code(404).send({ ok: false, error: '任务不存在' })

      return {
        ok: true,
        task: taskPayloadOf(ctx.db, updated, libraryTotalOf(ctx, user.id, updated.libraryId), ctx.now())
      }
    }
  )

  /**
   * Clears progress so a finished task can run again from the top.
   *
   * "From the top" includes the clocks, and that is what the reset used to leave behind: it zeroed the
   * counters and left `last_sent_at` pointing at the last send of the run somebody had just discarded,
   * so the first bullet of the new run waited out a cadence belonging to the old one. `resetTaskProgress`
   * clears them now, in the same place as the counters it retires them with (see `clearTaskClocks`) —
   * which is also why this handler no longer has a clock of its own to remember.
   */
  app.post<{ Params: { id: number } }>(
    '/api/tasks/:id/reset',
    { schema: { params: z.object({ id: idParam('无效的任务 ID') }) } },
    async (request: FastifyRequest<{ Params: { id: number } }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const taskId = request.params.id

      const task = getTask(ctx.db, user.id, taskId)
      if (task === null) return reply.code(404).send({ ok: false, error: '任务不存在' })

      resetTaskProgress(ctx.db, taskId)
      updateTaskStatus(ctx.db, taskId, TaskStatus.Waiting)

      const updated = getTask(ctx.db, user.id, taskId)
      if (updated === null) return reply.code(404).send({ ok: false, error: '任务不存在' })

      return {
        ok: true,
        task: taskPayloadOf(ctx.db, updated, libraryTotalOf(ctx, user.id, updated.libraryId), ctx.now())
      }
    }
  )

  /** Recent send attempts, newest first. */
  app.get<{ Params: { id: number }; Querystring: { limit: number } }>(
    '/api/tasks/:id/logs',
    {
      schema: {
        params: z.object({ id: idParam('无效的任务 ID') }),
        querystring: z.object({ limit: queryInt({ fallback: 100 }) })
      }
    },
    async (
      request: FastifyRequest<{ Params: { id: number }; Querystring: { limit: number } }>,
      reply: FastifyReply
    ) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const taskId = request.params.id

      if (getTask(ctx.db, user.id, taskId) === null) {
        return reply.code(404).send({ ok: false, error: '任务不存在' })
      }

      return {
        ok: true,
        summary: summarizeSendLogs(ctx.db, taskId),
        logs: listSendLogs(ctx.db, taskId, request.query.limit)
      }
    }
  )

  app.delete<{ Params: { id: number } }>(
    '/api/tasks/:id',
    { schema: { params: z.object({ id: idParam('无效的任务 ID') }) } },
    async (request: FastifyRequest<{ Params: { id: number } }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const taskId = request.params.id

      if (!deleteTask(ctx.db, user.id, taskId)) {
        return reply.code(404).send({ ok: false, error: '任务不存在' })
      }
      return { ok: true }
    }
  )
}
