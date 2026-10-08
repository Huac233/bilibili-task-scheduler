import type { ChoiceRead, ChoiceSource, ChoiceSourceRegistry } from '../actions/action-options.js'
import { fishingPanelFacts, parseCredential } from '../platform/douyu/index.js'
import { douyuFormSources } from '../platform/douyu/options.js'
import { type FishingPanel, readFishingPanel } from '../platform/douyu/protocol.js'
import { getAccountCredentials } from '../repo/accounts.js'
import { credentialValuesOf, redactCredentialParameters, redactSecrets } from '../text/redact.js'
import type { TargetFactRead, TargetFactRegistry, TargetFactView } from './action-settings.js'
import { type BackpackFetch, readDouyuBackpack } from './douyu-backpack.js'

/**
 * The one Platform whose actions declare option fields, wired to the reads their choices come from.
 *
 * This is the only file in this build that names a Platform while declaring what an option field's
 * choices are — and it is a file of `routes/**` rather than of `platform/**` for the reason
 * `actions/action-options.ts` records: the field declarations are `platform/**`'s business and are
 * waiting to move back there, while wiring them needs the storage handle and a transport, which
 * `platform/**` has no reason to know about.
 *
 * **The credential stays on this side of the seam.** `parseCredential` is the adapter's own reader
 * — imported rather than reimplemented, so the blob's shape has one reader — and the two halves the
 * backpack call needs are taken out of what it returns and handed straight to the reader. No part
 * of the blob is returned, logged, or put in a message by anything here.
 */

/** The source the 亲密度任务 field declares. Also the key the route is asked about. */
export const BACKPACK_SOURCE = 'douyu.backpack'

/**
 * The action whose Target has facts of its own, and the only one today.
 *
 * A Room's 钓鱼 panel answers the two preconditions a cast needs (an 形象, and a bait marked in use)
 * and the window the service says this Room's match is in. None of the three is a *parameter*: they
 * are states this action reads and reports, which is why 钓鱼 declares `casts` and nothing else — and
 * why the task page shows them for the Room its Task carries rather than the preferences page trying
 * to show them for the account.
 */
const FISHING_ACTION = 'fishing'

/**
 * Registers Douyu's choice sources. Called once, where the server is built.
 *
 * The transport is a parameter rather than `globalThis.fetch` read here, so the call a suite drives
 * and the call production makes are the same code path with one substitution — which is what makes
 * "nothing leaves this build's credential in a request log" an assertion instead of a claim.
 */
export function registerDouyuOptionSources(
  registry: ChoiceSourceRegistry,
  db: Parameters<typeof getAccountCredentials>[0],
  fetchImpl: BackpackFetch
): void {
  registry.register(backpackSource(db, fetchImpl))

  // 清仓's two reads, registered here for the same reason the backpack's is: this is the file that
  // names a Platform while wiring its option fields, and the registry is what the options route asks —
  // so a source nobody registered is a sentence on the form rather than a list, which is exactly the
  // reading the design's preferences page must not fall back to. The two answer the rooms the account
  // follows and the rooms it holds a fan medal in, and they read through their own module's transport
  // (`platform/douyu/options.ts`): the injected transport belongs to `douyu.backpack`, which says why
  // it is the one read that takes one.
  for (const source of douyuFormSources(db)) registry.register(source)
}

/**
 * Registers the facts Douyu can read about one Target. Called once, where the server is built.
 *
 * A separate registrar from the choice sources because the two answer different shapes and are read by
 * different routes: a choice is stored and must mean the same for every Task, while a target fact is
 * read live for the Room in front of a person and is stored nowhere.
 *
 * **No transport parameter here, and that is not an oversight.** The panel read goes through
 * `platform/douyu/protocol.ts`, whose own `fetch` is the global one — the same path every adapter
 * action takes — so the substitution a suite makes is `vi.stubGlobal('fetch', …)`, which is how
 * `douyu-fishing.test.ts` drives this very family. Taking a transport here would be a *second*
 * spelling of one call, and the panel's contract would then have two readers.
 */
export function registerDouyuTargetFacts(
  registry: TargetFactRegistry,
  db: Parameters<typeof getAccountCredentials>[0]
): void {
  registry.register(
    'douyu',
    FISHING_ACTION,
    async (accountId, targetKey) => await fishingFacts(db, accountId, targetKey)
  )
}

function backpackSource(db: Parameters<typeof getAccountCredentials>[0], fetchImpl: BackpackFetch): ChoiceSource {
  return {
    key: BACKPACK_SOURCE,
    read: async (accountId: number): Promise<ChoiceRead> => {
      const blob = getAccountCredentials(db, accountId)
      // Two separate states, because they need two different sentences: an account row that is gone
      // is a re-bind, while a blob this build cannot read is the paste path having stored
      // something unusable. Reporting both as "no credential" hides the second.
      if (blob === null) return { kind: 'unavailable', reason: '这个账号已经不在了，先重新绑定一次。' }

      const credential = parseCredential(blob)
      if (credential === null) {
        return { kind: 'unavailable', reason: '这个账号的凭据读不出来，重新扫码绑定一次就能读到背包。' }
      }

      return await readDouyuBackpack({ token: credential.token, webCookies: credential.webCookies }, fetchImpl)
    }
  }
}

/**
 * One Room's 钓鱼 panel, read and narrowed to the three facts a person checks before a run.
 *
 * **A read, and the only thing it can do is look.** The panel is a `GET`; no cast is sent, no bait is
 * chosen, and nothing is written — the two states a cast needs are set in 粉丝家园's own interface, and
 * this action deliberately does not set them for you. That is the same discipline `./douyu-backpack.js`
 * records for its own read: the page that helps a person see a precondition is kept a read.
 *
 * **Every failure is a sentence rather than an empty list**, for the reason `ChoiceRead` exists: an
 * account that is gone, a credential this build cannot read, a refusal from the service and a broken
 * transport are four different facts, and the one answer none of them may give is 「这个直播间什么都没有设置」.
 *
 * **The three facts come from `fishingPanelFacts` in the adapter** — the one home of the reading
 * (a present `myCh` means an 形象; `inUse: 1` names the bait the cast sends; the two instants are
 * rendered on `platform/time.ts`'s clock). They used to be mirrored here privately, and the mirror is
 * deleted rather than kept: a reading written twice is a reading that can disagree with itself, and
 * the two copies differed in exactly the way that hides it — this one rendered an absent window as a
 * *sentence* while the adapter's rendered it as `''`, so neither could be compared with the other.
 * What remains here is the page's own wording, which is not the adapter's; `FishingPanelFacts`
 * records which survives where and why.
 */
async function fishingFacts(
  db: Parameters<typeof getAccountCredentials>[0],
  accountId: number,
  targetKey: string
): Promise<TargetFactRead> {
  const blob = getAccountCredentials(db, accountId)
  if (blob === null) return { kind: 'unavailable', reason: '这个账号已经不在了，先重新绑定一次。' }

  const credential = parseCredential(blob)
  if (credential === null) {
    return { kind: 'unavailable', reason: '这个账号的凭据读不出来，重新扫码绑定一次就能读到这个直播间。' }
  }

  try {
    const panel = await readFishingPanel(credential.token, credential.webCookies, targetKey)
    if (!panel.ok) {
      const said = panel.message === '' ? '服务端没有说原因' : panel.message
      return {
        kind: 'unavailable',
        reason: `读取这个直播间的钓鱼面板失败：${said}（错误码 ${panel.code === null ? '未知' : String(panel.code)}）`
      }
    }

    return { kind: 'ok', items: fishingFactsOf(panel.data) }
  } catch (cause: unknown) {
    // This family throws where the backpack family answers, and a throw from it means the transport
    // or the contract is broken (`protocol.ts` says so where it declares its own error). Its message
    // carries neither the URL nor the body — that is that module's stated property — but the words
    // come from below, so the two values this call sent are scrubbed before they reach a reader.
    // `credentialValuesOf` is the one home of both halves and of the one-character contract.
    const detail = cause instanceof Error ? cause.message : String(cause)
    const sent = credentialValuesOf(credential.token, credential.webCookies)
    return {
      kind: 'unavailable',
      reason: `读取这个直播间的钓鱼面板失败：${redactCredentialParameters(redactSecrets(detail, sent))}（网络或超时）`
    }
  }
}

/**
 * The three facts one panel answers, in the order a run meets them.
 *
 * `形象` first because it is the one a person has to set in 粉丝家园, the bait second because a cast
 * spends it, and the window last because it tells a person when to come back rather than gating
 * anything: three captures of this account read three different windows, and one cast the service
 * accepted and paid for went out 614 s **before** the window it was read beside — so the value is
 * printed and never compared.
 *
 * **The readings come from `fishingPanelFacts` in the adapter and only the wording is this file's.**
 * The three of them used to be mirrored here privately — a present `myCh`, the row marked `inUse: 1`,
 * and a second copy of the clock — so the one reading had two homes and could have disagreed with
 * itself in silence. What stays here is what belongs to a page: the labels, and the sentences a
 * person reads, including the remedy the two preconditions share (they are set in the Platform's own
 * interface, and a person reading 「还没有设置」 on a page that offers no way to set it has to be told
 * where it lives). The adapter's own sentences for the same states are a *run's report* and stay
 * there — `FishingPanelFacts` records why the two wordings are separate.
 *
 * A fact says what is the case, not what to do about it; the one instruction worth carrying is where
 * the two preconditions are changed.
 */
function fishingFactsOf(panel: FishingPanel): readonly TargetFactView[] {
  const facts = fishingPanelFacts(panel)

  return [
    {
      name: 'character',
      label: '形象',
      value: facts.hasCharacter ? '已经设置' : '还没有设置（在粉丝家园里设一次，这个动作不会替你做）'
    },
    {
      name: 'bait',
      label: '在用鱼饵',
      // Not 「还剩 0 枚」 for the absent case: no bait marked in use and a bait that ran out are
      // different facts, and the action refuses to cast on either — but only one of them is a count.
      value:
        facts.bait === null
          ? '面板里没有标记「在用」的鱼饵（在粉丝家园里选中一枚）'
          : `还剩 ${String(facts.bait.cnt)} 枚`
    },
    { name: 'window', label: '服务端报的钓鱼窗口', value: facts.windowText ?? '服务端这次没有报窗口' }
  ]
}
