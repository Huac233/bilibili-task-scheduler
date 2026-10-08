import { NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type App, createApp, h, nextTick } from 'vue'
import { createRouter, createWebHashHistory, type Router } from 'vue-router'

import { http } from '../src/api/client.js'
import TaskDetailView from '../src/views/TaskDetailView.vue'

/**
 * The task page's two linkages: to the Action its parameters belong to, and to the Target whose own
 * facts it is the only page able to show.
 *
 * The design's decision here is that **a parameter belongs to the Action, not to the Task**: the store
 * is `action_settings`, keyed by (person, platform, action), so two Tasks naming one action share one
 * set of values — and the page may offer them for editing in place **without copying them onto the
 * Task**, which would give one value two homes. Every assertion below is that split, made visible:
 *
 *  - a write from this page goes to `PUT /api/action-settings` and **never** to `/api/tasks/:id`;
 *  - the page says whose the values are, in the sentence the design wrote for it;
 *  - a way through to the preferences page exists, because that is where the same values live when a
 *    person is not looking at one Task;
 *  - an action that declares no field says so rather than drawing an empty form.
 *
 * And the other half of the same split, which is why the two are one file: **the target's facts are
 * this page's and not the preferences page's**, because only this page knows which Room its Task is
 * about. The preferences page reads for an account — the route behind a choice source is handed an
 * account id and no target — so a Room's 形象, the bait in use and the window the service reports can
 * only appear here, for the one Room in the address.
 *
 * The fixture platform is a stand-in: the page learns the Action's name and its fields from the
 * catalogue, so nothing here names a Platform and the assertions are about the linkage rather than
 * about an adapter.
 */

/** The action whose parameters this page may edit: one number field, so the control is a box. */
const FISHING = {
  key: 'fishing',
  action: 'reconcile',
  label: '粉丝家园钓鱼',
  description: '在这个直播间的粉丝家园钓鱼。',
  costly: false,
  needsTarget: true,
  needsLibrary: false,
  maxMessageLength: 0,
  defaultIntervalSeconds: 300,
  minIntervalSeconds: 60,
  optionFields: [{ name: 'casts', label: '钓几次', help: '一次运行钓这么多竿。', kind: 'number' }]
}

/** An action that declares no field at all, so there is nothing for a form to be built from. */
const SIGN_IN = {
  key: 'sign_in',
  action: 'reconcile',
  label: '客户端签到',
  description: '斗鱼客户端的每日签到。',
  costly: false,
  needsTarget: false,
  needsLibrary: false,
  maxMessageLength: 0,
  defaultIntervalSeconds: 300,
  minIntervalSeconds: 60
}

const ACTION_CATALOGUE = [FISHING, SIGN_IN]

/** What is stored for the fishing action today. The form opens on this, not on an empty box. */
const STORED_CASTS = 3

const ACCOUNT = { id: 1, platform: 'douyu', displayName: '测试账号', avatar: '', externalId: '456918967', createdAt: 0 }

/** The Task aimed at a Room, whose action is the one with a parameter. */
const FISHING_TASK = {
  id: 1,
  userId: 1,
  platform: 'douyu',
  accountId: 1,
  libraryId: null,
  action: 'reconcile',
  actionKey: 'fishing',
  targetKey: '88013571',
  targetTitle: '电棍',
  startTime: Date.parse('2026-03-09T08:00:00+08:00'),
  endTime: Date.parse('2026-03-20T08:00:00+08:00'),
  interval: 300,
  status: 'running',
  cursor: 0,
  loopCount: 0,
  sentCount: 0,
  successCount: 0,
  failCount: 0,
  saltEnabled: false,
  requireOnline: false,
  lastLiveStatus: 1,
  lastCheckedAt: null,
  lastError: '',
  createdAt: 0,
  updatedAt: 0,
  progress: {
    cursor: 0,
    loopCount: 0,
    sentCount: 0,
    successCount: 0,
    failCount: 0,
    libraryTotal: null,
    bulletIndex: 0,
    percentInLoop: 0,
    remainingInLoop: null
  },
  settledTodayKeys: [],
  actionLogsToday: [],
  actionLogDays: []
}

/** The account-scoped Task, whose action declares no parameter at all. */
const SIGN_IN_TASK = { ...FISHING_TASK, id: 2, actionKey: 'sign_in', targetKey: '', targetTitle: '' }

const TASKS: Record<number, unknown> = { 1: FISHING_TASK, 2: SIGN_IN_TASK }

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

let requests: RecordedRequest[] = []

/** The facts the target-facts route answers with. One Room's panel, as the route narrows it. */
const ROOM_FACTS = {
  kind: 'ok',
  items: [
    { name: 'character', label: '形象', value: '已经设置' },
    { name: 'bait', label: '在用鱼饵', value: '还剩 1150 枚' },
    { name: 'window', label: '服务端报的钓鱼窗口', value: '18:00–19:00' }
  ]
}

/** What that route answers, and whether it answers at all. */
let facts: unknown = ROOM_FACTS
let factsRefused = false

function pathOf(url: string): string {
  return url.split('?')[0] ?? url
}

function fixtureFor(method: string, url: string): unknown {
  const route = pathOf(url)
  if (route.endsWith('/api/platforms')) {
    return { ok: true, platforms: [{ key: 'douyu', label: '斗鱼', actions: ACTION_CATALOGUE }] }
  }
  if (route.endsWith('/api/action-settings/target-facts')) {
    if (factsRefused) throw new Error('服务端说这次读不到')
    return { ok: true, facts }
  }
  if (route.endsWith('/api/action-settings')) {
    return {
      ok: true,
      settings: ACTION_CATALOGUE.map(action => ({
        platform: 'douyu',
        actionKey: action.key,
        enabled: true,
        options: action.key === 'fishing' ? { casts: STORED_CASTS } : {}
      }))
    }
  }
  if (method === 'get' && route.endsWith('/api/tasks')) {
    return { ok: true, tasks: Object.values(TASKS) }
  }
  for (const [id, task] of Object.entries(TASKS)) {
    if (route.endsWith(`/api/tasks/${id}/logs`)) {
      return { ok: true, summary: { total: 0, ok: 0, failed: 0 }, logs: [] }
    }
    if (route.endsWith(`/api/tasks/${id}`)) {
      return { ok: true, task, library: null, account: ACCOUNT, logSummary: { total: 0, ok: 0, failed: 0 } }
    }
  }
  throw new Error(`no fixture for ${method} ${url}`)
}

http.defaults.adapter = async config => {
  const method = (config.method ?? 'get').toLowerCase()
  const search = new URLSearchParams(config.params as Record<string, string> | undefined).toString()
  const url = search === '' ? (config.url ?? '') : `${config.url ?? ''}?${search}`
  const body = config.data === undefined ? undefined : JSON.parse(String(config.data))
  requests.push({ method, url, body })
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

/** Naive UI measures its overlays; this view does not, but the components assume both exist. */
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
  for (let i = 0; i < 12; i += 1) await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  for (let i = 0; i < 6; i += 1) await nextTick()
}

let hosts: HTMLElement[] = []

async function mountView(path: string): Promise<{ app: App; router: Router }> {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)

  const router = createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: '/tasks', name: 'tasks', component: { render: () => null } },
      { path: '/tasks/:id', name: 'task-detail', component: { render: () => null } },
      { path: '/action-settings', name: 'action-settings', component: { render: () => null } }
    ]
  })
  await router.push(path)

  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(TaskDetailView) }) })
  app.use(createPinia())
  app.use(router)
  app.mount(host)
  await settle()
  return { app, router }
}

function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

/** Every card on the page, so an assertion can be about the block rather than about the whole page. */
function cards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.n-card')]
}

/** The card whose header is `title`, or null when the page drew no such card. */
function cardTitled(title: string): HTMLElement | null {
  return cards().find(card => (card.querySelector('.n-card-header__main')?.textContent ?? '').trim() === title) ?? null
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    button => (button.textContent ?? '').replace(/\s+/g, ' ').trim() === label
  )
  if (found === undefined) throw new Error(`no button named ${label}`)
  return found
}

async function click(label: string): Promise<void> {
  buttonNamed(label).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
}

/** Types into a box the way a keystroke does, so the component's own handler runs. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
}

beforeEach(() => {
  document.body.innerHTML = ''
  requests = []
  facts = ROOM_FACTS
  factsRefused = false
})

afterEach(() => {
  for (const host of hosts) host.remove()
  hosts = []
})

describe('a task page and the action its parameters belong to', () => {
  it('shows the action’s own parameters, opened on what is stored for the action', async () => {
    await mountView('/tasks/1')

    const card = cardTitled('这个动作的参数')
    expect(card).not.toBeNull()

    // The field is the descriptor's own, and the value is the action's stored one — not the Task's.
    const shown = (card?.textContent ?? '').replace(/\s+/g, ' ')
    expect(shown).toContain(FISHING.optionFields[0]?.label)
    expect(card?.querySelector<HTMLInputElement>('input')?.value).toBe(String(STORED_CASTS))
  })

  /**
   * The write goes to the action, and the Task is not touched.
   *
   * This is the assertion the whole block exists for: `action_settings` is keyed by (person, platform,
   * action), so a save here changes what every other Task naming this action runs with — and a page
   * that wrote the value onto the Task instead would give one value two homes, which is the defect
   * this design round is clearing out.
   */
  it('writes the value to the action, and never onto the Task', async () => {
    await mountView('/tasks/1')

    const card = cardTitled('这个动作的参数')
    const input = card?.querySelector<HTMLInputElement>('input')
    expect(input).not.toBeNull()
    if (input === null || input === undefined) throw new Error('no parameter box')

    await type(input, '5')
    await click('保存参数')

    const write = requests.find(request => request.method === 'put')
    expect(write?.url).toContain('/api/action-settings')
    expect(write?.body).toEqual({
      platform: 'douyu',
      actionKey: 'fishing',
      enabled: true,
      options: { casts: 5 }
    })
    // And the Task itself was left alone: its own fields are edited in the edit dialog, which is a
    // different store and a different question.
    expect(requests.some(request => request.method === 'patch' && request.url.includes('/api/tasks/'))).toBe(false)
  })

  it('says whose the parameters are, and gives a way through to the preferences page', async () => {
    const { router } = await mountView('/tasks/1')

    // The sentence is the design's own, and it is the whole of what makes an in-place write honest.
    expect(text()).toContain('这个参数属于动作，不只属于这条任务——改它，你其他几条同动作的任务也跟着变。')

    await click('去偏好设置')
    expect(router.currentRoute.value.name).toBe('action-settings')
  })

  it('says an action has no parameters rather than drawing an empty form', async () => {
    await mountView('/tasks/2')

    const card = cardTitled('这个动作的参数')
    expect(card).not.toBeNull()
    expect((card?.textContent ?? '').replace(/\s+/g, ' ')).toContain('这个动作没有可设置的参数')
    // Nothing to edit, so there is no form and no save button on this page for this Task.
    expect(document.querySelectorAll('.param-form')).toHaveLength(0)
    expect(
      [...document.querySelectorAll('button')].some(button => (button.textContent ?? '').includes('保存参数'))
    ).toBe(false)
  })
})

describe('the target’s own facts, which only this page can show', () => {
  it('shows the Room’s 形象, the bait in use and the window, asked for the Room in the address', async () => {
    await mountView('/tasks/1')

    const card = cardTitled('这个目标的实情')
    expect(card).not.toBeNull()

    const shown = (card?.textContent ?? '').replace(/\s+/g, ' ')
    expect(shown).toContain('形象')
    expect(shown).toContain('已经设置')
    expect(shown).toContain('在用鱼饵')
    expect(shown).toContain('还剩 1150 枚')
    expect(shown).toContain('服务端报的钓鱼窗口')
    expect(shown).toContain('18:00–19:00')

    // The read is asked about **that Room**, through the Task's own account — the two things the
    // preferences page does not have when it is not standing in front of a Task.
    const asked = requests.find(request => request.url.includes('/api/action-settings/target-facts'))
    expect(asked?.url).toContain('targetKey=88013571')
    expect(asked?.url).toContain('actionKey=fishing')
    expect(asked?.url).toContain('accountId=1')
  })

  /**
   * The other half of the split, asserted as absence: the facts are shown for a Task aimed at a Room
   * and never for one that is about the account itself — there is no Room to read.
   */
  it('shows no target facts for a Task that carries no Target, and asks for none', async () => {
    await mountView('/tasks/2')

    expect(cardTitled('这个目标的实情')).toBeNull()
    expect(requests.some(request => request.url.includes('/api/action-settings/target-facts'))).toBe(false)
  })

  it('draws nothing at all for an action this build has no fact read for', async () => {
    facts = { kind: 'none' }
    await mountView('/tasks/1')

    // Not a failure sentence and not an empty card: the action has no such read, and a blank a person
    // could read as "nothing is set on this Room" is exactly what `none` exists to prevent.
    expect(cardTitled('这个目标的实情')).toBeNull()
    expect(text()).not.toContain('没有标记')
  })

  it('says a refused read, and never draws the facts as empty', async () => {
    facts = { kind: 'unavailable', reason: '这个账号的网页会话已失效，重新扫码绑定一次就能读到。' }
    await mountView('/tasks/1')

    const card = cardTitled('这个目标的实情')
    expect(card).not.toBeNull()
    const shown = (card?.textContent ?? '').replace(/\s+/g, ' ')
    expect(shown).toContain('这个账号的网页会话已失效')
    expect(shown).not.toContain('已经设置')
  })

  it('says the read did not land, rather than drawing nothing over it', async () => {
    factsRefused = true
    await mountView('/tasks/1')

    const card = cardTitled('这个目标的实情')
    expect(card).not.toBeNull()
    const shown = (card?.textContent ?? '').replace(/\s+/g, ' ')
    expect(shown).toContain('这次没读到')
    // The server's own words beside it, which is the other half of the pairing this repository applies
    // in every view: a read that failed says so, and says what it said.
    expect(shown).toContain('服务端说这次读不到')
  })

  /**
   * The third reading of one blank, and the one a list can carry without a sentence: a read that
   * **landed** and holds no fact.
   *
   * The pairing everywhere else in this repository is three sentences rather than two — in flight,
   * refused, arrived-and-empty — and the last one is the one a card is most likely to skip, because
   * drawing nothing at all looks like nothing happened. Nothing forces a Platform to report facts
   * about a Room, so the page says which of the three this is.
   */
  it('says an empty answer is an answer, which is not the same as a failed read', async () => {
    facts = { kind: 'ok', items: [] }
    await mountView('/tasks/1')

    const shown = (cardTitled('这个目标的实情')?.textContent ?? '').replace(/\s+/g, ' ')
    expect(shown).toContain('没有可显示的实情')
    expect(shown).not.toContain('这次没读到')
  })
})
