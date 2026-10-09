import type { ActionDescriptor, ActionOptionField, ActionShownRead } from '../platform/types.js'

/**
 * The option fields this build knows how to render, the reads it shows beside them, and the live
 * reads that fill both.
 *
 * Two declaration tables, one per channel — `ACTION_OPTION_FIELDS` for the knobs a person sets and
 * `ACTION_SHOWN_READS` for the facts an action only shows — and both are merged onto the adapters'
 * descriptors by `descriptorsWithDeclarations`. The two are separate tables rather than one with a
 * discriminator because they answer two different questions, and a read that a source-backed field
 * (either kind) already names as its `source` belongs in the first table only.
 *
 * **Why this is not in `platform/**`, and what would move it there.** `ActionDescriptor` is
 * the Platform's declaration of its own surface, so an option's field list belongs on it, and
 * `ACTION_OPTION_FIELDS` below is that declaration kept one module away. It is here because the
 * two halves it sits between cannot see each other: the declaration is a *build* fact — it can be
 * written down once and read forever — while a choice's source is a *runtime* read that needs the
 * storage handle and a transport, and a table that pulled a transport in would drag the HTTP layer
 * into every consumer of `platform/types.ts`. When a second writer of descriptor fields appears,
 * these tables belong in the adapter next to the action they describe and the route keeps only
 * `fieldOf` and `shownReadOf` below.
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
    ],
    /**
     * 清仓's two knobs — one a **pick-one** field and one a **ticked set**, and the difference between them
     * is what the choice's *meaning* is, not a second mechanism.
     *
     * 「默认倾泻直播间」 是一份**他关注了哪些直播间**的列表（`douyu.followedRooms`）。它必须是一个读了
     * 才知道的东西：这个动作把道具送进一个房间，房间号写错了就是把免费货送给一个陌生主播，而「我关注了
     * 哪些」正好是这一侧能替他读出来的那一份候选清单。**它存在偏好设置里而不是任务上，是因为参数属于
     * 动作**（`action_settings` 的键是 (人, 平台, 动作)），而这个动作是账号级的：`needsTarget: false`，
     * 收件房间来自这一格，不来自任务的目标。
     *
     * **它是 `pick_one`，而且这个字段就是加这个类型的原因。** 这个动作只往一个房间倒，所以这一格存的是
     * **一个值**；它先前声明成 `choice`，表单就按 `choice` 画了勾选组、写了勾选组会写的那种值（一份列表），
     * 于是读一个值的读法从 `["12306"]` 里只读出 `null`，人挑好了房间却收到「还没有选好」。加一个类型比让每个
     * 读法都学会拆数组好在哪：**表单写的形状从此由声明决定**，所以下一个「挑一个」的字段照抄这一行就对了，
     * 而不是照抄一个需要读法兜底的形状。见 `ActionOptionKind`。
     *
     * 「允许使用的道具」 是**背包读**（`douyu.backpack`，与 亲密度任务 的 `giftAllowlist` 同一个来源、
     * **不是同一份清单**）：花什么是每个动作自己的事，而这两个动作的清单是两个单元格。同一个来源在这里
     * 是安全的，因为来源只回答「这个账号现在持有什么」，权限是字段自己的。它是一个**集合**（`choice`）：
     * 勾几件就倒几件，一件不勾就是一件都不倒。
     *
     * **到期前多久倒不是一个字段**，而且这是有意的：它是算出来的常量（24 小时，见 `CLEAROUT_WINDOW_MS`），
     * 因为一个可以填错的窗口不是一个好参数——填短了道具会先过期，填长了等于没有窗口。
     */
    clearout_props: [
      {
        name: 'dumpRoomId',
        label: '默认倾泻直播间',
        help: '即将过期的免费道具送进这个直播间。列表是你关注过的直播间；挑一个你自己会去看、也愿意把亲密度记在那里的。',
        kind: 'pick_one',
        source: 'douyu.followedRooms'
      },
      {
        name: 'propAllowlist',
        label: '允许使用的道具',
        help: '只勾选账号里真正不花钱的那种（背包里的道具）。勾上的才会被倒出去；没有勾选时它一件都不送。这一份是清仓自己的，与「亲密度任务」的礼物清单互不影响。',
        kind: 'choice',
        source: 'douyu.backpack'
      }
    ]
  }
}

/** The fields one action reads, or none when it declares none. */
export function fieldsOf(platform: string, actionKey: string): readonly ActionOptionField[] {
  return ACTION_OPTION_FIELDS[platform]?.[actionKey] ?? []
}

/**
 * The declared reads an action only shows, keyed exactly as `ACTION_OPTION_FIELDS` is.
 *
 * A table of its own rather than a fourth `ActionOptionKind`, because the two channels answer two
 * different questions — what a person may set, and what this build read about the account — and a
 * reader of either table should see which question it is keyed by. The entries live here, beside the
 * fields, because both are the *form's* vocabulary and both are merged onto the adapters'
 * descriptors by the one function below.
 */
export const ACTION_SHOWN_READS: Readonly<Record<string, Readonly<Record<string, readonly ActionShownRead[]>>>> = {
  douyu: {
    /**
     * 清仓's second read — the one no option field could carry.
     *
     * **It returns every badge on the wall, and the label says that rather than a state.** The reader is
     * `readDouyuMedalRooms`, which is `badges.map(toMedalChoice)`: one row per room the account holds a
     * fan medal in, with today's reading carried in that row's own label by `medalStateIn`. The heading
     * here used to read 「今天还没送过的牌子」, which names a set no line produces — a medal whose intimacy
     * already rose today is in this list, and its own row says 「今日亲密度 2，今天已经涨过了」 beneath that
     * heading. **The heading names the set; the row states the fact.** A filter is not the repair:
     * `reconcileClearout` sums each room's outstanding 赠送礼物 remainder (`reserved +=
     * demand.reply.data.owed`, `giftDemandIn`) over exactly this list, so a filtered read would make the
     * set a person reads disagree with the set the action acts on.
     *
     * **And it is not a parameter, which is a fact about the arithmetic rather than a preference.** The
     * design says the reservation is 「算出来的，不是填的」: the sum is recomputed from today's reads on every
     * run and no cell stores it, so there is nothing here for a person to tick. Without this channel the
     * read was registered and unreachable — `douyu.medalRooms` names it, no field names it as a source,
     * so the page could not display it and no route could be asked for it.
     *
     * **The `help` names the level for the reason the heading does, and it has to: the panel draws this
     * sentence unconditionally.** The block comes from `shownReadsOf` — a declaration, not an answer — so
     * in the state where `accountId === null` (nothing bound, or the account list did not arrive)
     * `ActionSettingsPanel.vue`'s `loadAccountReads` asks no source at all and writes its own sentence
     * into the answer, which each row then shows. A `help` claiming a read would have to follow that read
     * state, and a declaration that follows a read is one fact in two homes. 「账号这一级的读」 is the
     * declaration this table makes, and it holds whether or not the read happened; the second half — the
     * reservation is summed per room and filled in nowhere — is the arithmetic and is untouched.
     *
     * Only this one is declared. 「我关注了哪些直播间」 (`douyu.followedRooms`) is already displayed,
     * because it is 「默认倾泻直播间」's own `source`: one read, two uses, which is the mechanism this
     * channel had to reach rather than a second fetch path.
     */
    clearout_props: [
      {
        name: 'medalRooms',
        label: '有牌的直播间',
        help: '账号持有粉丝牌的每个直播间都在这张清单里，今天涨没涨亲密度由每一行自己写着。这一条是账号这一级的读，不是能改的参数——保留量是这些直播间今天还差的礼物件数加起来，不是在这里填的。',
        source: 'douyu.medalRooms'
      }
    ]
  }
}

/** The reads one action shows without offering them as knobs, or none when it declares none. */
export function shownReadsOf(platform: string, actionKey: string): readonly ActionShownRead[] {
  return ACTION_SHOWN_READS[platform]?.[actionKey] ?? []
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
 * One shown read, or null when this action declares none by that name.
 *
 * The route's other half of the same gate: the options route answers the reads an action declares,
 * so a name that is neither a field nor a shown read is a name this build has no control for. The
 * two lookups are asked in that order — a field first — because the two channels are disjoint by
 * declaration (`ActionDescriptor.shownReads` says why repeating one is a mistake), and a page
 * reaching for a knob's list should never be handed the display-only answer for the same name.
 */
export function shownReadOf(platform: string, actionKey: string, name: string): ActionShownRead | null {
  return shownReadsOf(platform, actionKey).find(read => read.name === name) ?? null
}

/**
 * The declarations merged onto the adapters' descriptors.
 *
 * **Both channels, and one function rather than two.** `optionFields` and `shownReads` answer two
 * questions but they arrive the same way and are read off the descriptor together, so a second
 * merge beside this one would be the same map written twice — and the day one of them forgot an
 * action, the page would silently lose that action's list.
 *
 * Merged rather than authored beside them, because the adapters stay the source of truth about
 * what exists: this only adds a field list to an action a Platform already declares, and an action
 * it does not declare is not given one. A Platform with no entry passes through untouched, which is
 * every Platform but one today.
 */
export function descriptorsWithDeclarations(
  platformKey: string,
  actions: readonly ActionDescriptor[]
): ActionDescriptor[] {
  const fields = ACTION_OPTION_FIELDS[platformKey]
  const reads = ACTION_SHOWN_READS[platformKey]
  if (fields === undefined && reads === undefined) return [...actions]

  return actions.map(action => {
    const declared = fields?.[action.key]
    const shown = reads?.[action.key]
    // Neither table names this action: it passes through as itself, which is what the platforms with
    // no entry at all get one level up.
    if (declared === undefined && shown === undefined) return action
    return {
      ...action,
      ...(declared === undefined ? {} : { optionFields: declared }),
      ...(shown === undefined ? {} : { shownReads: shown })
    }
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
