import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { fieldOf, shownReadOf } from '../actions/action-options.js'
import { allPlatforms, platformFor } from '../platform/registry.js'
import { getAccount } from '../repo/accounts.js'
import {
  type ActionSetting,
  listActionSettings,
  parseStoredOptions,
  setActionEnabled
} from '../repo/action-settings.js'
import { listCarrierTasksForAction, listFinishedCarrierTasksForAction } from '../repo/tasks.js'
import { actionStopFor } from '../scheduler/logic.js'
import { type AppContext, requireUser } from './context.js'

/**
 * The action switchboard.
 *
 * Two facts decide this file's shape:
 *
 *  - **The catalogue comes from the adapters, the decisions come from the
 *    database.** `action_settings` stores only what a person switched on, so the
 *    list endpoint has to walk every Platform's catalogue and merge the caller's
 *    rows over it. That is why an action with no row must still appear — with
 *    `enabled: false` — because absence means off and the UI has to draw the
 *    switch to let anybody turn it on. Reporting only stored rows would make the
 *    whole catalogue invisible until someone had already used it.
 *  - **A row with no descriptor is not reported.** The adapters are the source of
 *    truth about what exists, so a leftover row for an action this build no longer
 *    serves is not a setting; it is stale data the UI has no place to show.
 *
 * Writes are validated against the catalogue first: a switch for an action nobody
 * implements could never be read back (the list above would not show it), so
 * accepting it would only hide the client's mistake.
 */

/** A setting as the UI reads it: catalogue entry plus this user's decision. */
interface ActionSettingView {
  readonly platform: string
  readonly actionKey: string
  readonly enabled: boolean
  /**
   * Parsed JSON, so the client never has to `JSON.parse` a nested string — and the parse itself is
   * `repo/action-settings.ts`'s, not this file's.
   */
  readonly options: unknown
}

const putSchema = z.object({
  platform: z.string({ error: '请选择平台' }).min(1, '请选择平台'),
  actionKey: z.string({ error: '请选择动作' }).min(1, '请选择动作'),
  enabled: z.boolean({ error: '请提供开关状态' }),
  /**
   * Platform-shaped knobs. Left as `unknown` on purpose: the seam gives the route
   * no schema for them — `ActionDescriptor` does not describe its options, because
   * they belong to the adapter — so the route only stores what the client sent.
   * Omitted means "keep what is stored", which is how the UI sends a bare toggle.
   */
  options: z.unknown().optional()
})

/**
 * Which Task runs an action, and the offer to create the one that is missing.
 *
 * The whole reason either endpoint exists is a confusion the screen could not dispel: an Action switch
 * answers *may this action run at all*, a Task answers *when, against which Target, and which action*,
 * and a person who switches an action on without a Task naming it sees precisely nothing happen. So
 * this answers the second question in the first question's terms, and it is computed from the same
 * rule the scheduler uses rather than from a second opinion — `actionStopFor`, the executor-independent
 * half of the rule `runner.ts` applies before it dispatches, plus the storage query behind
 * `listCarrierTasksForAction`.
 *
 * **The switch and the Task stay two facts here.** Nothing in this shape merges them: `mustBeOn` is
 * what the switch decides, `carriers` is what the Tasks decide, and the screen shows both.
 */
export interface ActionWorkflowView {
  /** What this action's own declaration asks a Task to be aimed at, in words. */
  readonly wants: {
    /** The `needsTarget` value. A Task whose own target disagrees with it cannot run this action. */
    readonly needsTarget: boolean
    /** One sentence naming what the action is aimed at, never a field name. */
    readonly shape: string
  }
  /**
   * The Tasks that **name** this action and are not terminal, whichever executor runs them.
   *
   * **"Name" rather than "run", and the word is load-bearing enough to be the field's first sentence.**
   * This list is a lookup on `action_key`, so what it establishes is naming — and naming is not running.
   * A `paused` Task is on it on purpose (see `listCarrierTasksForAction` in `repo/tasks.ts`: excluding it
   * would make the create path hand back a *second* row for one job) and it will not run until somebody
   * presses 恢复; a Task whose own target disagrees with the action's shape is dropped here by the run's own
   * rule rather than by the heading (see the route below). So "empty" reads as "no Task names this action",
   * and the panel labels the row with its own status — 「任务状态：已暂停」 — instead of promising a run.
   * The heading it draws above this list says 「指名这个动作的任务：」 for exactly that reason.
   */
  readonly carriers: readonly {
    readonly id: number
    /** The Target's own title, empty for an account-scoped Task or an unresolved title. */
    readonly targetTitle: string
    /** The Target the Platform was told, empty when the Task carries none. */
    readonly targetKey: string
  }[]
  /**
   * How many Tasks naming this action have **run their time window out** and will not run again.
   *
   * A count rather than a list, because there is nothing to do to one: a finished Task is history
   * that cannot be swept, edited or resumed, and the only move that restarts the action is the create
   * below. What the number is for is the sentence **beside** that create — a person who made a Task
   * for this action and sees 「现在没有任何任务运行它」 otherwise has to work out where their Task went,
   * and the answer "its window ended" is one they can act on by choosing a longer window this time.
   *
   * Zero is the ordinary case: nothing has finished, or nothing ever named the action.
   */
  readonly finishedCarriers: number
  /** The Task to create when none runs this action, or null when there is nothing to create. */
  readonly create: {
    readonly needsTarget: boolean
    /**
     * Whether an Action of this shape also needs a text library.
     *
     * Carried because a `send` Action cannot be created without one, and the create this offer stands
     * for has no place to put it: the offer names the action and nothing else, so the panel can only
     * use it to fill in a create it is going to send, and `POST /api/tasks` refuses that with 400
     * 「需要选择文本库」. A caller that reads this can say where such a Task really comes from — the
     * tasks screen, where the library is chosen — instead of drawing a button that cannot work.
     */
    readonly needsLibrary: boolean
    /** The action's own measured cadence, so the created Task is not the form's guess. */
    readonly defaultIntervalSeconds: number
  } | null
}

/**
 * One value a choice-backed field offers, as the client reads it.
 *
 * Narrower than anything a Platform returns, on purpose: `value` is what gets stored, `label` and
 * `count` are what a person chooses by, and `costsSomething` is the Platform's own marking reported
 * as a fact. What is **not** here is as deliberate — no credential, no cookie, no raw item blob, and
 * no Platform-side identifier beyond the value the field itself stores.
 */
interface ChoiceItemView {
  readonly value: string
  readonly label: string
  readonly count: number | null
  readonly costsSomething: boolean | null
}

/**
 * The choices for one field, or why there are none.
 *
 * A union rather than a list that can be empty, because the two readings must not collapse: an
 * account holding no gift at all and an account we could not ask about are different sentences, and
 * a form that drew an empty list for both would be telling a person their backpack is empty when the
 * truth is that their session expired.
 */
type ChoiceView =
  | { readonly kind: 'ok'; readonly items: readonly ChoiceItemView[] }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * One thing read live about one Target, as the page in front of a Task reads it.
 *
 * The sibling of `ChoiceItemView`, and narrower than anything a Platform returns for the same reason:
 * `name` is a stable key the page never renders, `label` says what the fact is about (「形象」,
 * 「在用鱼饵」), and `value` is the fact itself as a sentence a person reads. **No identifier travels
 * in `value`**: the Room's own id is on the page already, and what these facts carry is states and
 * quantities rather than ids.
 */
export interface TargetFactView {
  readonly name: string
  readonly label: string
  readonly value: string
}

/**
 * What one read of a Target's own facts produced, or why there is none.
 *
 * The union `ChoiceRead` is, for the union's own reason: an account we could not ask about and a Room
 * whose panel reports nothing are opposite facts, and a page that drew them alike would be telling a
 * person their 形象 is not set when the truth is that their session expired.
 */
export type TargetFactRead =
  | { readonly kind: 'ok'; readonly items: readonly TargetFactView[] }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * One read of one Target's facts, as a Platform supplies it.
 *
 * Handed the account id and the Target the Task carries, and nothing else: the credential is read out
 * of the account inside the reader, so no part of it passes through here — the rule `ChoiceSource.read`
 * keeps as well.
 *
 * **The Target parameter is what this mechanism has and a choice source does not**, and the reason is
 * the design's own split rather than a second concept: a choice is *stored* in a cell keyed by
 * (person, platform, action), so it has to mean the same thing for every Task naming that action,
 * while a fact about a Room is read for the Room in front of a person and is never stored at all.
 */
export type TargetFactReader = (accountId: number, targetKey: string) => Promise<TargetFactRead>

/**
 * The key one registered read is filed under.
 *
 * `\u0000` for the reason `settingKey` below uses it: it cannot occur in a Platform key or an action
 * key, so the composite cannot alias — `('a\0b', 'c')` and `('a', 'b\0c')` are different keys here,
 * which a `/`-joined key would not guarantee.
 */
function targetFactKey(platformKey: string, actionKey: string): string {
  return `${platformKey}\u0000${actionKey}`
}

/**
 * The registered target-fact reads, keyed by (Platform, action).
 *
 * Keyed that way because that is what a page standing in front of one Task knows: the action its Task
 * names. **Not keyed by the Target, and that is not an omission** — the Target is the *argument* of a
 * read rather than part of its name, so one registration serves every Room an action is aimed at.
 *
 * A registry rather than a switch, and read out of `AppContext` rather than reached for, for the
 * reasons `ChoiceSourceRegistry` is: a suite has to be able to answer without a Platform, and the
 * properties this build promises about a live read are then assertions rather than hopes.
 *
 * **`read` answers `null` when this build serves no read for that action**, which is a different answer
 * from a read that failed: the page draws nothing for the first and a sentence for the second, because
 * an action nobody wrote a read for is not an action whose read went wrong.
 *
 * Nothing here throws. A reader's own contract is to answer, so reaching the catch means a bug in one —
 * which a person still has to be told about in the page's terms rather than as a stack trace.
 */
export class TargetFactRegistry {
  private readonly readers = new Map<string, TargetFactReader>()

  register(platformKey: string, actionKey: string, reader: TargetFactReader): void {
    this.readers.set(targetFactKey(platformKey, actionKey), reader)
  }

  async read(
    platformKey: string,
    actionKey: string,
    accountId: number,
    targetKey: string
  ): Promise<TargetFactRead | null> {
    const reader = this.readers.get(targetFactKey(platformKey, actionKey))
    if (reader === undefined) return null

    try {
      return await reader(accountId, targetKey)
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return { kind: 'unavailable', reason: `读取这个目标的实情失败：${detail}` }
    }
  }
}

/**
 * The facts one read answers with, or the answer that this build serves no such read.
 *
 * `none` is a member of the wire shape rather than a null the client has to interpret beside it: what
 * the page needs to distinguish is three things — facts, a failed read, and an action nobody wrote a
 * read for — and a union of three says so where `null` would say it in a comment on the other side.
 */
type TargetFactsView = TargetFactRead | { readonly kind: 'none' }

const optionsQuerySchema = z.object({
  platform: z.string({ error: '请选择平台' }).min(1, '请选择平台'),
  actionKey: z.string({ error: '请选择动作' }).min(1, '请选择动作'),
  accountId: z.coerce.number({ error: '请选择账号' }).pipe(z.int({ error: '账号 ID 无效' }).positive('账号 ID 无效')),
  /** The option's own key, as `ActionDescriptor.optionFields[].name` declares it. */
  field: z.string({ error: '请提供选项名' }).min(1, '请提供选项名')
})

const workflowQuerySchema = z.object({
  platform: z.string({ error: '请选择平台' }).min(1, '请选择平台'),
  actionKey: z.string({ error: '请选择动作' }).min(1, '请选择动作')
})

const targetFactsQuerySchema = z.object({
  platform: z.string({ error: '请选择平台' }).min(1, '请选择平台'),
  actionKey: z.string({ error: '请选择动作' }).min(1, '请选择动作'),
  accountId: z.coerce.number({ error: '请选择账号' }).pipe(z.int({ error: '账号 ID 无效' }).positive('账号 ID 无效')),
  /**
   * The Target whose facts are wanted, as the Task carries it.
   *
   * Required, and the emptiness is refused here rather than passed on: the read behind this asks a
   * Platform about one Room, and a request with no Room in it is one this build has no answer for —
   * answering it would mean asking the service about nothing.
   */
  targetKey: z.string({ error: '请提供目标' }).min(1, '请提供目标')
})

/**
 * The key of one switch.
 *
 * `\u0000` cannot occur in a Platform key or an action key — both are written by
 * hand in an adapter — so the composite cannot alias: `('a\0b', 'c')` and
 * `('a', 'b\0c')` are different keys here, which a `/`-joined key would not
 * guarantee.
 */
function settingKey(platform: string, actionKey: string): string {
  return `${platform}\u0000${actionKey}`
}

/**
 * One switch as the client reads it.
 *
 * `options` is whatever was stored, rendered back **unaltered** — and that is the one deliberate
 * difference from the other reader of the same column. `repo/action-settings.ts` owns the parse (this
 * file imports it, so the two cannot drift about what "unreadable" means), but the object-ness an
 * *action* needs is that module's `actionOptions` policy: a person may store `null`, an array or a
 * number through this very route, and this route's job is to show them their own value rather than to
 * correct it into `{}`.
 */
function viewOf(platform: string, actionKey: string, row: ActionSetting | undefined): ActionSettingView {
  return {
    platform,
    actionKey,
    enabled: row?.enabled ?? false,
    options: parseStoredOptions(row?.options)
  }
}

export function registerActionSettingRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Every action of every registered Platform, with this caller's switch on it. */
  app.get('/api/action-settings', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request, reply, ctx)
    if (user === null) return undefined

    const stored = new Map(
      listActionSettings(ctx.db, user.id).map(row => [settingKey(row.platform, row.actionKey), row])
    )

    const settings: ActionSettingView[] = []
    for (const platform of allPlatforms()) {
      for (const descriptor of platform.actions) {
        settings.push(viewOf(platform.key, descriptor.key, stored.get(settingKey(platform.key, descriptor.key))))
      }
    }

    return { ok: true, settings }
  })

  /** Flips one switch, or stores its options, and returns the resulting setting. */
  app.put<{ Body: z.infer<typeof putSchema> }>(
    '/api/action-settings',
    { schema: { body: putSchema } },
    async (request: FastifyRequest<{ Body: z.infer<typeof putSchema> }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const body = request.body

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

      // `undefined` is passed through as "leave the stored options alone": the store
      // treats a missing value as a no-op, which is what a bare toggle means.
      const options = body.options === undefined ? undefined : JSON.stringify(body.options)

      const setting = setActionEnabled(ctx.db, user.id, platform.key, descriptor.key, body.enabled, options)
      return { ok: true, setting: viewOf(setting.platform, setting.actionKey, setting) }
    }
  )

  /**
   * The choices for one choice-backed option field — or for one read the action only shows.
   *
   * **Read-only, and the only route here that talks to a Platform.** It asks the source the
   * descriptor declares — `ChoiceSourceRegistry` in `actions/action-options.ts` is the registry it
   * goes through — and it answers in the source's terms: a list, or a sentence about why there is
   * no list. It never invents an empty list, because on the one source this build serves an empty
   * list means "this account holds nothing", which is a claim only the account's own answer can
   * make.
   *
   * **One route for both channels, and that is the mechanism rather than a shortcut.** A read a field
   * names as its `source` — under either of the two source-backed kinds — is displayed and used as the
   * field's own list; a read no
   * field names is displayed alone, and `ActionDescriptor.shownReads` is where it is declared. Both
   * are asked for here, by name, and answered identically — so a page has one fetch path, one
   * success shape and one set of failure sentences for the reads it shows.
   *
   * Three refusals and no fourth: an unknown name (neither a field nor a shown read), a field **no source
   * backs** (`choice` and `pick_one` are the two kinds read from one, and a typed field has no list to
   * answer with), and an account that is not the caller's. Each is a request this build has
   * no answer for, and answering anyway — with `[]`, or with the caller's own stored options —
   * would be the form showing a person something no read produced. **The second channel adds names
   * to the first lookup and does not loosen it**: a name this action does not declare is still a
   * 400.
   */
  app.get<{ Querystring: z.infer<typeof optionsQuerySchema> }>(
    '/api/action-settings/options',
    { schema: { querystring: optionsQuerySchema } },
    async (request: FastifyRequest<{ Querystring: z.infer<typeof optionsQuerySchema> }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const query = request.query
      const platform = platformFor(query.platform)
      if (platform === null) return reply.code(400).send({ ok: false, error: `未知平台：${query.platform}` })

      const field = fieldOf(platform.key, query.actionKey, query.field)
      if (field !== null && field.source === undefined) {
        return reply.code(400).send({ ok: false, error: `选项「${field.label}」是自己填写的，没有可选项列表` })
      }

      // The second declaration channel: a read the action *shows*, which no source-backed field names
      // as its `source`. It is asked for by its own `name` and answered in exactly the terms a field's
      // list is — one route, one registry, one vocabulary — because the page that displays it is the
      // same page that displays a field's read, and a second fetch path would be a second set of
      // failure sentences. Looked up only when no field matched, since the two channels are disjoint
      // by declaration (see `ActionDescriptor.shownReads`).
      const shown = field === null ? shownReadOf(platform.key, query.actionKey, query.field) : null
      const source = field?.source ?? shown?.source
      if (source === undefined) {
        return reply.code(400).send({
          ok: false,
          error: `平台「${platform.label}」的动作「${query.actionKey}」没有可选项「${query.field}」`
        })
      }

      // Scoped through the caller: a guessed account id 404s instead of reading someone else's
      // backpack. The same rule `routes/tasks.ts` applies to every id it is handed.
      const account = getAccount(ctx.db, user.id, query.accountId)
      if (account === null) return reply.code(404).send({ ok: false, error: '账号不存在' })
      if (account.platform !== platform.key) {
        return reply.code(400).send({ ok: false, error: `账号不属于平台「${platform.label}」` })
      }

      const read = await ctx.choiceSources.read(source, account.id)
      const choice: ChoiceView =
        read.kind === 'ok'
          ? {
              kind: 'ok',
              items: read.items.map(item => ({
                value: item.value,
                label: item.label,
                count: item.count,
                costsSomething: item.costsSomething
              }))
            }
          : { kind: 'unavailable', reason: read.reason }

      // `field` restates what was asked for: both lookups match on exactly this string, so naming
      // the declaration here would say the same thing twice.
      return { ok: true, field: query.field, source, choice }
    }
  )

  /**
   * What one Target's own panel says about it, for the action aimed at that Target.
   *
   * **The half the preferences page structurally cannot show.** The design splits facts by
   * `needsTarget`: an account-level action's facts belong to the preferences page, and a target-level
   * action's belong to the task page — because only the task page knows *which* Room it is about. The
   * route behind a choice source is handed an account id and no target, so this is a second read
   * rather than a wider first one, and it keeps the first one's shape so a page has one way to read a
   * live thing.
   *
   * Three answers and no fourth, and the third is what lets the page stay silent honestly:
   *
   *  - **`ok`** with the facts a Platform read for that Room — a 钓鱼 panel's 形象, the bait marked in
   *    use, and the window the service reports for that Room's match.
   *  - **`unavailable`** with a sentence: the account is gone, its credential does not parse, the
   *    service refused, or the transport failed. Never an empty list, which would read as "this Room
   *    has none of these" — a claim only the Platform's own answer may make.
   *  - **`none`** when this build serves no such read for that action at all. A failure sentence here
   *    would be blaming a read nobody wired, so the page draws nothing instead.
   *
   * The account is scoped through the caller, like every id this build is handed, and the action is
   * looked up in the catalogue first: a request naming an action nobody declares is one this build has
   * no answer for, and the catalogue is what says which actions exist.
   */
  app.get<{ Querystring: z.infer<typeof targetFactsQuerySchema> }>(
    '/api/action-settings/target-facts',
    { schema: { querystring: targetFactsQuerySchema } },
    async (request: FastifyRequest<{ Querystring: z.infer<typeof targetFactsQuerySchema> }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const query = request.query
      const platform = platformFor(query.platform)
      if (platform === null) return reply.code(400).send({ ok: false, error: `未知平台：${query.platform}` })

      const descriptor = platform.actions.find(action => action.key === query.actionKey)
      if (descriptor === undefined) {
        return reply.code(400).send({ ok: false, error: `平台「${platform.label}」没有动作「${query.actionKey}」` })
      }

      const account = getAccount(ctx.db, user.id, query.accountId)
      if (account === null) return reply.code(404).send({ ok: false, error: '账号不存在' })
      if (account.platform !== platform.key) {
        return reply.code(400).send({ ok: false, error: `账号不属于平台「${platform.label}」` })
      }

      const read = await ctx.targetFacts.read(platform.key, descriptor.key, account.id, query.targetKey)
      const facts: TargetFactsView = read ?? { kind: 'none' }

      return { ok: true, facts }
    }
  )

  /**
   * Where one action would actually run.
   *
   * **A Task names exactly one Action, and that is the action it runs** — `runner.ts` hands the
   * adapter the key the Task's own row carries and nothing else, whichever executor the action
   * declares. So the Tasks that run an action are exactly the Tasks that name it, and the answer here
   * is a lookup on `action_key` plus the offer to create one when the list comes back empty. **Both
   * executors carry**, which is the half that used to be missing: a `send` Task names its action and
   * `sendOne` looks that action up by key, so a running send loop is as much a carrier as a
   * `reconcile` row — and the screen said 「现在没有任何任务运行它」 over one.
   *
   * **What the shape still decides is whether such a Task can run the action at all.** A
   * `needsTarget` action with no Target, or an account-scoped one carrying a Target, is a row the
   * run refuses rather than one it quietly reinterprets — so `wants` states what the action is aimed
   * at, which is the one thing a person creating the Task has to get right beside the action's name.
   *
   * **That validation is applied to `carriers` itself rather than only stated beside it.** Naming an
   * action is necessary and not sufficient: a row that names the action and whose own Target
   * disagrees with its `needsTarget` is answered `failed` (`missing_target`, `unexpected_target`) by
   * the run and never dispatched, so listing it as one of this action's Tasks would be the screen
   * crediting the action with work the run refuses every tick — and, because `create` is offered only
   * where `carriers` is empty, it would withhold the one move that gets the action running again.
   * **The heading is not what excludes such a row, and it may not be read as excluding it**:
   * 「指名这个动作的任务：」 claims the naming, and this row really does name the action, so the exclusion
   * belongs to the run's own answer and not to the words above the list. That answer is
   * `actionStopFor` — the executor-independent half of
   * the rule the run applies: `reconcileSelectionFor` is that function plus the executor check, and
   * the send executor refuses on the same switch sentence (`switchOffReport`) and the same untargeted
   * row, so the page and the run cannot drift — and it is asked with
   * `enabled: true`, because the switch is the fact this screen draws **beside** the carrier list:
   * an action whose switch is merely off still has the Tasks that would run it, and reporting that
   * as "nothing runs it" would be a true sentence about permission standing in for a false one about
   * the Tasks.
   *
   * **It is deliberately not `reconcileSelectionFor`.** That one answers what a *reconcile run* does,
   * so it answers `unknown` for every Action that is not a Reconcile one: asking it here would drop
   * each `send` row again, which is the defect rather than the fix.
   *
   * **A row that has run its time window out is not a carrier either, and the two halves of that
   * judgement are deliberately in different places.** `actionStopFor` answers a question
   * about the row's *action and target* — is this the action, and is the Task aimed the way the
   * action needs — and a finished Task is the right shape and always will be. Whether it can still
   * run is a question about *when*, which is the status, so `listCarrierTasksForAction` answers it
   * in SQL and this route reads `carriers` and `finishedCarriers` off the two answers. `done` is
   * written by both executors (`finishTask`, once the window closes), so both halves are asked of
   * both.
   *
   * The defect this replaced was the two questions collapsing into one: a `done` row was listed as a
   * Task that runs the action, which withheld the create below — and since the create path resolved
   * the same (Platform, target, action) key back to that very row, the action could not be restarted
   * at all without somebody guessing that deleting the row was the way out. The screen now says how
   * many Tasks ran their window out and offers the create, which is the honest reading of a key whose
   * only Tasks have finished.
   */
  app.get<{ Querystring: z.infer<typeof workflowQuerySchema> }>(
    '/api/action-settings/workflow',
    { schema: { querystring: workflowQuerySchema } },
    async (request: FastifyRequest<{ Querystring: z.infer<typeof workflowQuerySchema> }>, reply: FastifyReply) => {
      const user = requireUser(request, reply, ctx)
      if (user === null) return undefined

      const query = request.query
      const platform = platformFor(query.platform)
      if (platform === null) return reply.code(400).send({ ok: false, error: `未知平台：${query.platform}` })

      const descriptor = platform.actions.find(action => action.key === query.actionKey)
      if (descriptor === undefined) {
        return reply.code(400).send({ ok: false, error: `平台「${platform.label}」没有动作「${query.actionKey}」` })
      }

      // The storage question first — every Task that can still run this action — and then the
      // run's own answer to it: a row that names the action and cannot run it (the shape mismatch
      // above) is not a Task this action will ever run under, and this screen is not allowed to claim
      // that it is. The finished list gets the same filter, and for the same reason read the other way
      // round: a row that could not run this action did not run it out, so counting it would be this
      // screen explaining a Task that was never this action's work.
      const candidates = listCarrierTasksForAction(ctx.db, user.id, platform.key, descriptor.key).filter(
        task => actionStopFor(descriptor, task, true) === null
      )
      const finished = listFinishedCarrierTasksForAction(ctx.db, user.id, platform.key, descriptor.key).filter(
        task => actionStopFor(descriptor, task, true) === null
      )

      const workflow: ActionWorkflowView = {
        wants: {
          needsTarget: descriptor.needsTarget,
          // What the action is aimed at, in a person's words. Which noun it is belongs to the
          // action's own declaration — an action aimed at a room and one aimed at the account are
          // the two this build has — and neither sentence is ever replaced by the field name
          // behind it.
          shape: descriptor.needsTarget
            ? '这个动作是对着「目标」做的：任务里要指名这个动作，再选一个目标。'
            : '这个动作是围着「账号」做的：任务里指名这个动作就行，不用选目标。'
        },
        carriers: candidates.map(task => ({
          id: task.id,
          targetTitle: task.targetTitle,
          targetKey: task.targetKey
        })),
        finishedCarriers: finished.length,
        create:
          candidates.length > 0
            ? null
            : {
                needsTarget: descriptor.needsTarget,
                // A `send` Action cannot be created without one, and the create this offer stands for
                // has nowhere to put it — see the field's own note. The panel needs it to say where
                // such a Task really comes from instead of offering a button that is refused.
                needsLibrary: descriptor.needsLibrary,
                defaultIntervalSeconds: descriptor.defaultIntervalSeconds
              }
      }

      return { ok: true, workflow }
    }
  )
}
