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
 * that decision the page has to *show*: the two reads the owner named, which are one read used twice
 * — displayed to the person here **and** the source of the parameter's choices in the form below.
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
 * The two source keys below are the fixed interface with the agent building the action: they are the
 * strings its two `choice` fields declare, and the page passes them through without interpreting
 * them. The action's own key, its labels and its field names are fixtures here — only the two source
 * keys are not.
 */

/** The read of the rooms the account follows. One key of the fixed interface. */
const FOLLOW_FIELD = {
  name: 'pourRoom',
  label: '默认倾泻直播间',
  help: '清仓的时候把快到期的免费道具送到这一间。',
  kind: 'choice',
  source: 'douyu.followedRooms'
}

/** The read of the rooms the account holds a fan medal in. The other key of the fixed interface. */
const MEDAL_FIELD = {
  name: 'keepRooms',
  label: '留量的直播间',
  help: '这些牌子今天还没送过，所以要给它们留够。',
  kind: 'choice',
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
  optionFields: [FOLLOW_FIELD, MEDAL_FIELD]
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
    // Per field, because the two reads answer separately: one of them failing must not take the
    // other's list off the page, which is the whole reason the route answers per field.
    const field = query(url, 'field')
    const source = [...CLEAR_OUT.optionFields].find(candidate => candidate.name === field)?.source ?? ''
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

/** One action's own row, so an assertion is about that action rather than about the page. */
function rowOf(label: string): string {
  const rows = [...document.querySelectorAll<HTMLElement>('.action-row')]
  const row = rows.find(candidate => (candidate.querySelector('.action-label')?.textContent ?? '').trim() === label)
  if (row === undefined) throw new Error(`no row for ${label}`)
  return (row.textContent ?? '').replace(/\s+/g, ' ')
}

/** The account-level facts block inside one row, or null when the row drew none. */
function factsBlockOf(label: string): HTMLElement | null {
  const rows = [...document.querySelectorAll<HTMLElement>('.action-row')]
  const row = rows.find(candidate => (candidate.querySelector('.action-label')?.textContent ?? '').trim() === label)
  return row?.querySelector<HTMLElement>('.account-facts') ?? null
}

/** The fields this page asked a read for, in the order it asked. */
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

    // The two reads the owner named, each under the field that reads it: what the account follows,
    // and which rooms it holds a medal in. Both are the same read the parameter form's list comes
    // from — one `ChoiceSource`, two purposes — which is why the page asks for them by field.
    expect(askedFields()).toEqual([FOLLOW_FIELD.name, MEDAL_FIELD.name])
    expect(requests.some(request => request.url.includes('accountId=1'))).toBe(true)

    const shown = (facts?.textContent ?? '').replace(/\s+/g, ' ')
    expect(shown).toContain(FOLLOW_FIELD.label)
    expect(shown).toContain(FOLLOW_FIELD.help)
    expect(shown).toContain('电棍的直播间')
    expect(shown).toContain(MEDAL_FIELD.label)
    expect(shown).toContain('小苏的直播间（今日亲密度 0，今天还没送过）')

    // The stored values are identifiers, and an identifier is not something a person reads.
    expect(shown).not.toContain('88013571')
    expect(shown).not.toContain('12293234')
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
    // And the read that did answer is still drawn: the rows are read one per field.
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
