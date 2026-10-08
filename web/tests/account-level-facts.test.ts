import { NDialogProvider, NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'

import { http } from '../src/api/client.js'
import ActionSettingsPanel from '../src/components/ActionSettingsPanel.vue'

/**
 * The account-level reads, as the preferences page shows them.
 *
 * The design's central decision is that **account-level facts belong to this page and a target's own
 * facts belong to the task page**, and that the discriminator is `ActionDescriptor.needsTarget` — the
 * same field the scheduler selects a Task's actions by, so no new concept. This file is the half of
 * that decision the page has to *show*: the two reads the owner named, which arrive through
 * **two different channels** — one is a `choice` field's `source`, so it is displayed here *and* fills
 * that field's list in the parameter form, and the other is declared in `shownReads`, so it is
 * displayed and is deliberately **not** tickable.
 *
 * The shape of the second channel is what 「shows the medal read without offering it as something to
 * set」 pins: a read that is only shown must not be a control, which is exactly why it is not a
 * `choice` field. It is the same mechanism as a field's source, not a second one — same route, same
 * registry, same failure vocabulary — so both channels are asserted through one page, one bound
 * account and one fixture.
 *
 * Two properties the fixtures exist to hold to, and both are the pairing the repository applies
 * everywhere else:
 *
 *  - **A read that failed and a read that answered nothing are different sentences.** The route's
 *    `ChoiceView` union exists for exactly this (`server/src/routes/action-settings.ts`), and a page
 *    that drew one blank for both would be telling a person their account follows no rooms when the
 *    truth is that the session expired.
 *  - **A read that landed is what lets the page assert anything.** `accountId: null` is two facts —
 *    nothing is bound, or the account list did not arrive — and only the first supports 「这个平台还
 *    没有绑定账号」.
 *
 * The two source keys below are the fixed interface with the agent building the action: one is the
 * `source` its `choice` field declares and the other the `source` its `shownReads` entry declares,
 * and the page passes both through without interpreting them. The action's own key, its labels and
 * its field names are fixtures here — only the two source keys are not.
 */

/** The read of the rooms the account follows. One key of the fixed interface, and a field's `source`. */
const FOLLOW_FIELD = {
  name: 'pourRoom',
  label: '默认倾泻直播间',
  help: '清仓的时候把快到期的免费道具送到这一间。',
  kind: 'choice',
  source: 'douyu.followedRooms'
}

/**
 * The read of the rooms the account holds a fan medal in. The other key of the fixed interface, and
 * a read the action **only shows** — `shownReads`, whose entries have no `kind`, so no control is
 * built for one. Carrying it as a second `choice` field is the shape the owner rejected: a
 * reservation computed from a read is 「算出来的，不是填的」, and a tickable 牌子清单 would make it
 * look like a decision.
 */
const MEDAL_READ = {
  name: 'keepRooms',
  label: '留量的直播间',
  help: '这些牌子今天还没送过，所以要给它们留够。',
  source: 'douyu.medalRooms'
}

/** The account-level action: `needsTarget: false`, which is what puts its facts on this page. */
const CLEAR_OUT = {
  key: 'clear_out',
  action: 'reconcile',
  label: '清仓',
  description: '把即将过期的免费道具送出去。',
  costly: false,
  needsTarget: false,
  needsLibrary: false,
  maxMessageLength: 0,
  defaultIntervalSeconds: 300,
  minIntervalSeconds: 60,
  optionFields: [FOLLOW_FIELD],
  shownReads: [MEDAL_READ]
}

/**
 * A target-level action that declares a choice field too.
 *
 * It exists so the discriminator is provably `needsTarget` and not "declares a list": this action
 * declares one, and the page still draws no account-level facts for it — its facts are about a Room
 * the preferences page does not know, which is why they are shown on the task page instead.
 */
const BACKPACK_FIELD = {
  name: 'giftAllowlist',
  label: '允许使用的礼物',
  help: '只勾选账号里真正不花钱的那种。',
  kind: 'choice',
  source: 'douyu.backpack'
}

const INTIMACY_TASKS = {
  key: 'intimacy_tasks',
  action: 'reconcile',
  label: '亲密度任务',
  description: '读这个直播间的每日亲密度任务。',
  costly: false,
  needsTarget: true,
  needsLibrary: false,
  maxMessageLength: 0,
  defaultIntervalSeconds: 300,
  minIntervalSeconds: 60,
  optionFields: [BACKPACK_FIELD]
}

const ALL_ACTIONS = [CLEAR_OUT, INTIMACY_TASKS]

const ACCOUNTS = [
  { id: 1, platform: 'douyu', displayName: '测试账号', avatar: '', externalId: '456918967', createdAt: 0 }
]

/** One room a read returned. The value is what a field stores — an id, so it is never rendered. */
const FOLLOWED_ITEM = { value: '88013571', label: '电棍的直播间', count: null, costsSomething: null }

/** One medal row, whose fact about today travels in the label — the only place the shape has for it. */
const MEDAL_ITEM = {
  value: '12293234',
  label: '小苏的直播间（今日亲密度 0，今天还没送过）',
  count: null,
  costsSomething: null
}

interface Scenario {
  /** The answer `GET /api/action-settings/options` gives for the followed-rooms read. */
  followedRooms: unknown
  /** …and for the medal read. Two answers, so one failing does not hide the other. */
  medalRooms: unknown
  /** Whether `GET /api/accounts` answers at all. */
  accountListFails?: boolean
  /** Whether it answers with no account on the Platform. */
  accountListEmpty?: boolean
}

interface RecordedRequest {
  readonly method: string
  readonly url: string
}

let scenario: Scenario = {
  followedRooms: { kind: 'ok', items: [FOLLOWED_ITEM] },
  medalRooms: { kind: 'ok', items: [MEDAL_ITEM] }
}
let requests: RecordedRequest[] = []

function query(url: string, name: string): string {
  return new URL(`http://fixture${url}`).searchParams.get(name) ?? ''
}

/** The route without its query, so a fixture compares against a path rather than a whole URL. */
function pathOf(url: string): string {
  return url.split('?')[0] ?? url
}

/**
 * The source one name resolves to, through both channels and in the route's own order.
 *
 * A `choice` field is looked up first and a `shownReads` entry second, which is the order
 * `GET /api/action-settings/options` applies so that a page reaching for a knob's list is never handed
 * the display-only answer for the same name. The two are disjoint by declaration; a name in neither
 * resolves to `''`, which is what the fixture answers with rather than borrowing either read's list.
 */
function sourceOf(name: string): string {
  const field = CLEAR_OUT.optionFields.find(candidate => candidate.name === name)
  return field?.source ?? CLEAR_OUT.shownReads.find(read => read.name === name)?.source ?? ''
}

function fixtureFor(method: string, url: string): unknown {
  const route = pathOf(url)
  if (route.endsWith('/api/platforms')) {
    return { ok: true, platforms: [{ key: 'douyu', label: '斗鱼', actions: ALL_ACTIONS }] }
  }
  if (route.endsWith('/api/action-settings')) {
    return {
      ok: true,
      settings: ALL_ACTIONS.map(action => ({ platform: 'douyu', actionKey: action.key, enabled: true, options: {} }))
    }
  }
  if (route.endsWith('/api/accounts')) {
    if (scenario.accountListFails === true) throw new Error('账号列表读取失败')
    if (scenario.accountListEmpty === true) return { ok: true, accounts: [] }
    return { ok: true, accounts: ACCOUNTS }
  }
  if (method === 'get' && route.endsWith('/api/tasks')) {
    return { ok: true, tasks: [] }
  }
  if (route.endsWith('/api/action-settings/options')) {
    // Per name, because the reads answer separately: one of them failing must not take the other's
    // list off the page, which is the whole reason the route answers per name. The two channels are
    // looked up in the order the route looks them up — a field's source first, then a shown read —
    // and 清仓 has one read in each, so this is the union the page asks for rather than a second path.
    const field = query(url, 'field')
    const source = sourceOf(field)
    return {
      ok: true,
      field,
      source,
      choice: source === 'douyu.followedRooms' ? scenario.followedRooms : scenario.medalRooms
    }
  }
  if (route.endsWith('/api/action-settings/workflow')) {
    const actionKey = query(url, 'actionKey')
    const descriptor = ALL_ACTIONS.find(action => action.key === actionKey)
    if (descriptor === undefined) throw new Error(`no fixture action ${actionKey}`)
    return {
      ok: true,
      workflow: {
        wants: {
          needsTarget: descriptor.needsTarget,
          shape: descriptor.needsTarget
            ? '这个动作是对着「目标」做的：任务里要指名这个动作，再选一个目标。'
            : '这个动作是围着「账号」做的：任务里指名这个动作就行，不用选目标。'
        },
        carriers: [],
        finishedCarriers: 0,
        create: {
          needsTarget: descriptor.needsTarget,
          needsLibrary: descriptor.needsLibrary,
          defaultIntervalSeconds: 300
        }
      }
    }
  }
  throw new Error(`no fixture for ${method} ${url}`)
}

http.defaults.adapter = async config => {
  const method = (config.method ?? 'get').toLowerCase()
  const search = new URLSearchParams(config.params as Record<string, string> | undefined).toString()
  const url = search === '' ? (config.url ?? '') : `${config.url ?? ''}?${search}`
  requests.push({ method, url })
  const data = fixtureFor(method, url)
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

/** localStorage, which the request interceptor reads. */
const tokens = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => tokens.get(key) ?? null,
    setItem: (key: string, value: string) => void tokens.set(key, value),
    removeItem: (key: string) => void tokens.delete(key)
  }
})

/** Naive UI measures its overlays; nothing here does, but the components assume both exist. */
class StubObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return []
  }
}
Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: StubObserver })
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: StubObserver })

/** Flushes microtasks and one macrotask, so the `onMounted` chain lands. */
async function settle(): Promise<void> {
  for (let i = 0; i < 16; i += 1) await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  for (let i = 0; i < 10; i += 1) await nextTick()
}

let hosts: HTMLElement[] = []

async function mountPanel(): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)

  const app = createApp({
    render: () =>
      h(NMessageProvider, null, {
        default: () => h(NDialogProvider, null, { default: () => h(ActionSettingsPanel) })
      })
  })
  app.use(createPinia())
  app.mount(host)
  await settle()
}

/** One action's own row element, so a click lands on that action rather than on whichever row is first. */
function rowElement(label: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('.action-row')].find(
    candidate => (candidate.querySelector('.action-label')?.textContent ?? '').trim() === label
  )
  if (row === undefined) throw new Error(`no row for ${label}`)
  return row
}

/** One action's row, flattened, so an assertion reads what a person reads. */
function rowOf(label: string): string {
  return (rowElement(label).textContent ?? '').replace(/\s+/g, ' ')
}

/** The account-level facts block inside one row, or null when the row drew none. */
function factsBlockOf(label: string): HTMLElement | null {
  return rowElement(label).querySelector<HTMLElement>('.account-facts')
}

/** Clicks one row's own button, then lets the request chain it starts land. */
async function clickInRow(rowLabel: string, buttonLabel: string): Promise<void> {
  const button = [...rowElement(rowLabel).querySelectorAll('button')].find(
    candidate => (candidate.textContent ?? '').replace(/\s+/g, ' ').trim() === buttonLabel
  )
  if (button === undefined) throw new Error(`no button named ${buttonLabel} in ${rowLabel}`)
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
}

/** The read names this page asked for, in the order it asked — a field's and a shown read's alike. */
function askedFields(): string[] {
  return requests
    .filter(request => request.url.includes('/api/action-settings/options'))
    .map(request => query(request.url, 'field'))
}

beforeEach(() => {
  document.body.innerHTML = ''
  scenario = {
    followedRooms: { kind: 'ok', items: [FOLLOWED_ITEM] },
    medalRooms: { kind: 'ok', items: [MEDAL_ITEM] }
  }
  requests = []
})

afterEach(() => {
  for (const host of hosts) host.remove()
  hosts = []
})

describe('the account-level facts a preferences page shows', () => {
  it('shows both reads of an account-level action, with the account the choices are read for', async () => {
    await mountPanel()

    const facts = factsBlockOf('清仓')
    expect(facts).not.toBeNull()

    // The two reads the owner named, each under its own heading: what the account follows — a
    // `choice` field's `source`, so it is displayed *and* fills the form's list — and which rooms it
    // holds a medal in, declared in `shownReads`, so it is displayed and set by nobody. Both are
    // asked for by name, through one route and one registry, which is why the page's order is the
    // fields' reads first and the shown ones after.
    expect(askedFields()).toEqual([FOLLOW_FIELD.name, MEDAL_READ.name])
    expect(requests.some(request => request.url.includes('accountId=1'))).toBe(true)

    const shown = (facts?.textContent ?? '').replace(/\s+/g, ' ')
    expect(shown).toContain(FOLLOW_FIELD.label)
    expect(shown).toContain(FOLLOW_FIELD.help)
    expect(shown).toContain('电棍的直播间')
    expect(shown).toContain(MEDAL_READ.label)
    expect(shown).toContain('小苏的直播间（今日亲密度 0，今天还没送过）')

    // The stored values are identifiers, and an identifier is not something a person reads.
    expect(shown).not.toContain('88013571')
    expect(shown).not.toContain('12293234')
  })

  /**
   * A read that is only shown must not be a control.
   *
   * The medal read arrives through `descriptor.shownReads` — the channel that exists because the
   * reservation it answers is 「算出来的，不是填的」. Carried as a second `choice` field it would be a
   * tickable list, and a cleared tick would read as a decision about it, which is the shape the owner
   * rejected. So the page draws the fact and offers no way to set it: the parameter form is built from
   * `optionFields` alone, and the read's own rows stay above it as sentences.
   *
   * Red before the change: while the fixture declared the medal read as a `choice` field, the form
   * drew a second checkbox and 「小苏的直播间…」 was inside `.param-form`.
   */
  it('shows the medal read without offering it as something to set', async () => {
    await mountPanel()

    const facts = (factsBlockOf('清仓')?.textContent ?? '').replace(/\s+/g, ' ')
    expect(facts).toContain(MEDAL_READ.label)
    expect(facts).toContain('小苏的直播间')

    await clickInRow('清仓', '设置参数')

    const form = document.querySelector<HTMLElement>('.param-form')
    expect(form).not.toBeNull()
    const inForm = (form?.textContent ?? '').replace(/\s+/g, ' ')
    // The field's own list is what the form draws, so the followed room's row is in there…
    expect(inForm).toContain('电棍的直播间')
    // …and the shown read is nowhere near it. Scoped to the form on purpose: the same room name is on
    // the page legitimately, one block above, so a page-wide absence would assert nothing.
    expect(inForm).not.toContain('小苏的直播间')
    // One control, for the one field this action declares — a read has none to draw.
    expect(document.querySelectorAll('.param-form [role="checkbox"]')).toHaveLength(1)

    // And the form asks for its own fields and nothing else: the panel's two asks come first, and the
    // second ask for the followed-rooms list is the form's own, made when it opened. A shown read is
    // never asked for a second time, because there is no field to seed a control from.
    expect(askedFields()).toEqual([FOLLOW_FIELD.name, MEDAL_READ.name, FOLLOW_FIELD.name])
  })

  /**
   * The sentence that says why these facts are on this page at all.
   *
   * The design's discriminator is `ActionDescriptor.needsTarget`, so the block may claim the shape
   * and the page — and, read the other way round, may not claim it for an action aimed at a Room.
   */
  it('says these are the account-level facts, and draws none for an action aimed at a target', async () => {
    await mountPanel()

    expect(factsBlockOf('清仓')).not.toBeNull()
    // The target-level action declares a list of its own, and still gets no block: the difference
    // between the two rows is `needsTarget` and nothing else.
    expect(factsBlockOf('亲密度任务')).toBeNull()
    expect(askedFields()).not.toContain(BACKPACK_FIELD.name)
    expect(rowOf('亲密度任务')).not.toContain(FOLLOW_FIELD.help)
  })

  it('says one read failed, and leaves the other read’s answer on the page', async () => {
    scenario = {
      followedRooms: { kind: 'unavailable', reason: '这个账号的网页会话已失效，重新扫码绑定一次就能读到。' },
      medalRooms: { kind: 'ok', items: [MEDAL_ITEM] }
    }
    await mountPanel()

    const shown = (factsBlockOf('清仓')?.textContent ?? '').replace(/\s+/g, ' ')
    // A failed read is a sentence, and the source's own words are the sentence.
    expect(shown).toContain('这个账号的网页会话已失效')
    expect(shown).not.toContain('电棍的直播间')
    // And the read that did answer is still drawn: the reads are read one per name, so one source
    // refusing does not take another source's list off the page.
    expect(shown).toContain('小苏的直播间')
  })

  it('says an empty answer is an answer, which is not the same as a failed read', async () => {
    scenario = {
      followedRooms: { kind: 'ok', items: [] },
      medalRooms: { kind: 'ok', items: [MEDAL_ITEM] }
    }
    await mountPanel()

    const shown = (factsBlockOf('清仓')?.textContent ?? '').replace(/\s+/g, ' ')
    // A successful read of a source that holds nothing is the account's own answer, and it is not
    // the failure's sentence — the two readings the route's `ChoiceView` union exists to keep apart.
    expect(shown).toContain('一个可选项都没有')
    expect(shown).not.toContain('网页会话已失效')
  })

  /**
   * A read that landed is what lets the page assert anything about the account.
   *
   * An empty account list is also what a failed read leaves behind, so the sentence about absence may
   * only be made once the list arrived — the pairing `TaskCreateView.vue` words as 「账号列表没读到，
   * 所以这里既不能说你有账号、也不能说你没有」, and the same one the parameter form applies one level
   * down.
   */
  it('says the account list could not be read, instead of claiming no account is bound', async () => {
    scenario = {
      followedRooms: { kind: 'ok', items: [FOLLOWED_ITEM] },
      medalRooms: { kind: 'ok', items: [MEDAL_ITEM] },
      accountListFails: true
    }
    await mountPanel()

    const shown = (factsBlockOf('清仓')?.textContent ?? '').replace(/\s+/g, ' ')
    expect(shown).toContain('账号列表这次没读到')
    expect(shown).not.toContain('还没有绑定账号')
    // Nothing was asked of a source: there is no account id to ask with.
    expect(askedFields()).toEqual([])
  })

  it('still says no account is bound when the account list arrived empty', async () => {
    scenario = {
      followedRooms: { kind: 'ok', items: [FOLLOWED_ITEM] },
      medalRooms: { kind: 'ok', items: [MEDAL_ITEM] },
      accountListEmpty: true
    }
    await mountPanel()

    const shown = (factsBlockOf('清仓')?.textContent ?? '').replace(/\s+/g, ' ')
    expect(shown).toContain('这个平台还没有绑定账号')
    expect(shown).not.toContain('账号列表这次没读到')
    expect(askedFields()).toEqual([])
  })
})
