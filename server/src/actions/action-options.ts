import type { ActionDescriptor, ActionOptionField } from '../platform/types.js'

/**
 * The option fields this build knows how to render, and the live reads that fill their choices.
 *
 * **Why this is not in `platform/**`, and what would move it there.** `ActionDescriptor` is
 * the Platform's declaration of its own surface, so an option's field list belongs on it, and
 * `ACTION_OPTION_FIELDS` below is that declaration kept one module away. It is here because the
 * two halves it sits between cannot see each other: the declaration is a *build* fact — it can be
 * written down once and read forever — while a choice's source is a *runtime* read that needs the
 * storage handle and a transport, and a table that pulled a transport in would drag the HTTP layer
 * into every consumer of `platform/types.ts`. When a second writer of descriptor fields appears,
 * `ACTION_OPTION_FIELDS` belongs in the adapter next to the action it describes and the route keeps
 * only `fieldOf` below.
 *
 * **The mechanism is Platform-neutral; only the wiring names a Platform.** Everything in this
 * module is keyed by strings it never interprets, so `routes/**` can carry it without learning a
 * Platform key — `./routes/douyu-options.js` is where the one Platform this build declares fields
 * for is named, and where its reads are registered.
 */

/**
 * One where-the-choices-come-from handle, as a field declares it.
 *
 * A source is two facts and one of them is the failure path. **The failure path is the reason this
 * is not just a function**: a choice-backed field's source can be unavailable — no account, no
 * session, the Platform refusing the read — and the form has to say which of those it is rather
 * than draw an empty list that reads as "you hold no free gifts". So a read answers `unavailable`
 * with the reason, and the route passes it through instead of inventing an empty `items`.
 */
export interface ChoiceSource {
  /** One value per source, stable, and never shown to a person. */
  readonly key: string
  /** Reads the source for one account. The credential blob is the account's, not the caller's. */
  readonly read: (accountId: number) => Promise<ChoiceRead>
}

/**
 * What one read of a source produced.
 *
 * `unavailable` rather than an empty list, and the distinction is the whole point: the only source
 * this build serves answers with the gift ids an account actually holds, and an account holding
 * none is a real answer while an account we could not ask about is not. An empty `items` is
 * therefore always a fact about the account, never about the request.
 */
export type ChoiceRead =
  | { readonly kind: 'ok'; readonly items: readonly ChoiceItem[] }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * One item a source offers, in the words a person reads.
 *
 * Deliberately narrower than anything a Platform returns. Two fields earn their place and the rest
 * do not: `value` is what gets stored, and `label` plus `fact` are the two things a person needs to
 * choose — how many of it the account holds, and whether it is one the Platform charges for. The
 * source's own identifiers beyond `value` stay inside the reader, because a route that shipped them
 * would be shipping a screen's worth of raw data for nothing to read it.
 */
export interface ChoiceItem {
  /** What the field stores when this item is chosen. Frequently an id, so never rendered. */
  readonly value: string
  /** The name a person reads. */
  readonly label: string
  /** What the account holds of it, or `null` when the source declares no count. */
  readonly count: number | null
  /**
   * Whether the Platform marks this item as one that costs something, as `true`/`false`, or `null`
   * when the source makes no such claim.
   *
   * Three-valued on purpose. The whole reason Douyu's gift list must be chosen by a person is that
   * the Platform's own flag does **not** mean "free" — see the reader — so a form that printed
   * 「免费」 for `false` would be repeating the mistake this field exists to avoid.
   */
  readonly costsSomething: boolean | null
}

/**
 * The declared fields, keyed by Platform and then by action.
 *
 * A flat lookup rather than an array of `(platform, action, fields)`: the only question ever asked
 * of it is `fieldOf`, and a reader of this table should see the keys it is keyed by.
 */
export const ACTION_OPTION_FIELDS: Readonly<Record<string, Readonly<Record<string, readonly ActionOptionField[]>>>> = {
  douyu: {
    /**
     * 亲密度任务's one knob, and the reason the field list exists at all.
     *
     * The action reads `giftAllowlist` out of its options and refuses anything not on it, so this
     * is the form for a list the owner has to write himself — his own words, 「签到等途径会送便宜的
     * 付费道具」: the backpack holds items the Platform charges for, and the Platform exposes no
     * first-party "free" flag to filter them with. `GET /api/action-settings/options` resolves the
     * source against a live read of that backpack.
     */
    intimacy_tasks: [
      {
        name: 'giftAllowlist',
        label: '允许使用的礼物',
        help: '只勾选账号里真正不花钱的那种。勾上的礼物才会被这个动作当做可送出的清单；没有勾选时它一件都不送。',
        kind: 'choice',
        source: 'douyu.backpack'
      }
    ],
    /**
     * 钓鱼's one knob — and **the two fields a person would expect beside it are deliberately absent.**
     *
     * `形象` and `在用鱼饵` are *reads*, not parameters. The panel already carries both — `myCh` for the
     * character, and `baits[].inUse` for the bait a cast must send — so the action reads them and
     * reports the two preconditions it cannot fix; a choice-backed field would say the person picked
     * something the service decides, and this action would then have to check the pick against the
     * panel anyway.
     *
     * **A per-Room value would also be stored in a per-action cell.** `action_settings` is keyed by
     * (user, platform, action) and not by target, while `ChoiceSource.read` is handed an account id
     * and nothing else — so a live read of one *room's* panel cannot back a field today, and a value
     * naming a room would be wrong for every Task but the one it was read for. The day this action may
     * choose its own bait (`changeBait` exists and spends nothing, so it is a plausible next step),
     * the field needs the target handed to the read, and the criterion for that is
     * `ActionDescriptor.needsTarget` — the same field the scheduler already selects a Task's actions
     * by, so it needs no new concept.
     *
     * `casts` is intent and nothing on the wire carries it: how many casts a person wants, bounded by
     * the adapter against both its own ceiling and the panel's own bait stock. It is the only field
     * here that is not a reading of what the Platform already knows.
     */
    fishing: [
      {
        name: 'casts',
        label: '钓几次',
        help: '今天钓几竿。一竿消耗 20 枚在用的鱼饵（抓包实测），跑完这一轮当天就不再钓，所以要按自己的鱼饵存量填；留空按 1 竿算，最多 10 竿。',
        kind: 'number'
      }
    ]
  }
}

/** The fields one action reads, or none when it declares none. */
export function fieldsOf(platform: string, actionKey: string): readonly ActionOptionField[] {
  return ACTION_OPTION_FIELDS[platform]?.[actionKey] ?? []
}

/**
 * One declared field, or null when this action reads nothing by that name.
 *
 * The route's gate as well as its lookup: a request naming a field the descriptor does not declare
 * is a request this build has no control for, and answering it would be answering about an option
 * nothing reads.
 */
export function fieldOf(platform: string, actionKey: string, name: string): ActionOptionField | null {
  return fieldsOf(platform, actionKey).find(field => field.name === name) ?? null
}

/**
 * The declarations merged onto the adapters' descriptors.
 *
 * Merged rather than authored beside them, because the adapters stay the source of truth about
 * what exists: this only adds a field list to an action a Platform already declares, and an action
 * it does not declare is not given one. A Platform with no entry passes through untouched, which is
 * every Platform but one today.
 */
export function descriptorsWithOptionFields(
  platformKey: string,
  actions: readonly ActionDescriptor[]
): ActionDescriptor[] {
  const declared = ACTION_OPTION_FIELDS[platformKey]
  if (declared === undefined) return [...actions]

  return actions.map(action => {
    const fields = declared[action.key]
    return fields === undefined ? action : { ...action, optionFields: fields }
  })
}

/**
 * The registered sources, filled once at wiring time.
 *
 * **A class rather than a module-level map, and the difference is testability**: a route reads
 * sources out of `AppContext`, so a suite can hand the server a registry whose reads are fixtures
 * and never reach the network — the properties this build actually promises about a live read
 * (nothing leaks, an unavailable source is a sentence) are then assertions rather than hopes. The
 * same shape `LoginSessionStore` has in `routes/context.ts`, and for the same reason.
 *
 * A registry rather than a switch, and the difference is the failure mode: a source key with no
 * registration behind it answers `unavailable` with a name instead of throwing, so a field whose
 * read this build never wired is a sentence on the form rather than a 500 nobody can act on.
 */
export class ChoiceSourceRegistry {
  private readonly sources = new Map<string, ChoiceSource>()

  register(source: ChoiceSource): void {
    this.sources.set(source.key, source)
  }

  /**
   * One source's read, or the reason there is none.
   *
   * **Never throws, and never falls back to an empty list.** A read that failed and an account that
   * holds nothing are the two readings this whole interface exists to keep apart, and collapsing
   * them here is exactly how a person concludes their backpack is empty.
   */
  async read(key: string, accountId: number): Promise<ChoiceRead> {
    const source = this.sources.get(key)
    if (source === undefined) {
      return { kind: 'unavailable', reason: `这一版没有接上「${key}」这个来源，页面暂时取不到可选项。` }
    }

    try {
      return await source.read(accountId)
    } catch (cause: unknown) {
      // A source's own contract is to answer rather than throw, so reaching here means a bug in a
      // source — which a person still has to be told about, in terms of the form rather than a stack.
      const detail = cause instanceof Error ? cause.message : String(cause)
      return { kind: 'unavailable', reason: `读取可选项失败：${detail}` }
    }
  }
}
