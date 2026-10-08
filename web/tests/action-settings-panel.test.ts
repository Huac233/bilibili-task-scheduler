import { NDialogProvider, NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'

import { http } from '../src/api/client.js'
import ActionSettingsPanel from '../src/components/ActionSettingsPanel.vue'
import type { TaskStatus } from '../src/types/api.js'

/**
 * The action-switch screen, mounted — because the two defects it fixes are ones a data assertion
 * cannot see.
 *
 *  - **A switch with no Task naming the action did nothing, and the page did not say so.** The fix is a
 *    *screen*: each action says which Task runs it, and offers the one Task that is missing. So the
 *    assertions are on the rendered DOM of the real component, with the real store, over a fixture
 *    API — the same choice `task-detail-items.test.ts` records.
 *  - **An option a person could not set.** The gift allowlist had a reader in the adapter and no
 *    writer in the interface, so the form is driven entirely by `optionFields` from the catalogue. A
 *    test against a helper could not tell "the field rendered" from "the descriptor says the field
 *    exists".
 *
 * Three properties the fixtures exist to hold to. **No identifier in what a person reads**: the
 * carrier row prints the Target's title and never its key. **An unavailable choice source is a
 * sentence, not an empty list**: the fixture answers `unavailable` in one case and a real list in
 * another, and the two renderings must differ. And **the form is not the safety boundary**: the page
 * has to say so, because that is what stops its owner from believing a tick box guards a spend.
 */

/** The action with an option field: the one the owner could not configure. */
const GIFT_FIELD = {
  name: 'giftAllowlist',
  label: '允许使用的礼物',
  help: '只勾选账号里真正不花钱的那种。',
  kind: 'choice',
  source: 'douyu.backpack'
}

/** An action whose only option is a number: no list, so nothing for a note about a list to explain. */
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

/** The Send action. It needs a library, which is the half this panel has no control for. */
const SEND_DANMAKU = {
  key: 'send_danmaku',
  action: 'send',
  label: '发送弹幕',
  description: '按固定间隔把文本库里的弹幕一条条发进直播间。',
  costly: false,
  needsTarget: true,
  needsLibrary: true,
  maxMessageLength: 20,
  defaultIntervalSeconds: 30,
  minIntervalSeconds: 10
}

/** The per-Target action. A Task has to name it *and* carry a Target for it to run. */
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
  optionFields: [GIFT_FIELD]
}

/** The account-scoped action, so "a Task exists" and "a Task names *this*" are two facts. */
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

/**
 * A costly action, and the only fixture that is not in the default catalogue.
 *
 * `costly` is the one descriptor property the panel reads for itself rather than handing on: the switch it
 * draws for such a row is what has to ask before it writes. Adding it here by default would move every
 * other assertion in this file onto a five-row page, so it is opt-in.
 */
const GROWTH_POOL = {
  key: 'growth_pool_sign',
  action: 'reconcile',
  label: '打卡分鱼丸',
  description: '报名一次扣 200 鱼丸。',
  costly: true,
  needsTarget: false,
  needsLibrary: false,
  maxMessageLength: 0,
  defaultIntervalSeconds: 300,
  minIntervalSeconds: 60
}

const ALL_ACTIONS = [INTIMACY_TASKS, SIGN_IN, FISHING, SEND_DANMAKU]

/**
 * The catalogue this scenario renders — the four by default, and the costly one on request.
 *
 * The return type is inferred rather than annotated, which is deliberate: the fixture has to satisfy two
 * readers that want different halves of a descriptor (`GET /api/platforms` publishes the whole catalogue
 * and the workflow route is asked per action), and the inferred union carries every property either of
 * them touches.
 */
function actionsOf() {
  return scenario.costlyAction === true ? [...ALL_ACTIONS, GROWTH_POOL] : ALL_ACTIONS
}

const ACCOUNTS = [
  { id: 1, platform: 'douyu', displayName: '测试账号', avatar: '', externalId: '456918967', createdAt: 0 }
]

/** One Task, naming the per-Target action. Its title is a name; its key is an identifier. */
const CARRIER_TASK = {
  id: 7,
  userId: 1,
  platform: 'douyu',
  accountId: 1,
  libraryId: null,
  action: 'reconcile',
  actionKey: 'intimacy_tasks',
  targetKey: '88013571',
  targetTitle: '电棍',
  startTime: 0,
  endTime: 86_400_000,
  interval: 300,
  status: 'running',
  cursor: 0,
  loopCount: 0,
  sentCount: 0,
  successCount: 0,
  failCount: 0,
  saltEnabled: false,
  requireOnline: false,
  lastLiveStatus: null,
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
  }
}

/** The account-scoped Task, which exists in every scenario and names the other action only. */
const ACCOUNT_TASK = { ...CARRIER_TASK, id: 8, actionKey: 'sign_in', targetKey: '', targetTitle: '' }

/** One item a live backpack read returned, in the shape the route answers with. */
const GIFT_ITEM = { value: '268', label: '粉丝荧光棒', count: 60, costsSomething: false }

interface Scenario {
  /** Whether a Task naming 亲密度任务 exists right now. */
  carried: boolean
  /** How many Tasks naming it have already run their time window out. */
  finished: number
  /** The answer `GET /api/action-settings/options` gives. */
  choice: unknown
  /**
   * The status that Task is in, when there is one.
   *
   * `paused` is the status this fixture exists for: it is the one the carrier query keeps and the
   * schedulable set does not, so the row is a Task that *names* the action and will not run it.
   */
  carrierStatus?: TaskStatus
  /** Whether `GET /api/tasks` — the read the status words come from — answers at all. */
  taskListFails?: boolean
  /** Whether that read answers without the carrier the workflow route just named. */
  taskListOmitsCarrier?: boolean
  /**
   * Whether the costly action is in the catalogue this scenario renders.
   *
   * Opt-in because it is the fifth row: every other assertion in this file counts or walks rows, and the
   * four-row page is the page they were written against.
   */
  costlyAction?: boolean
  /** The action key the fixture answers as switched off, so a flip has something to do. */
  switchedOff?: string
  /**
   * Whether `GET /api/action-settings/workflow` answers at all.
   *
   * It is one request per catalogued action, so this is the read the banner's promise — 「下面每个动作都
   * 写了哪个任务指名它」 — depends on, and the failure it has to survive.
   */
  workflowFails?: boolean
  /** Whether `GET /api/accounts` answers at all. */
  accountListFails?: boolean
  /**
   * The status of the Task `POST /api/tasks` answers with.
   *
   * The route is create-or-get, so this is not always a row it just wrote: `findReconcileTask` hands
   * back an existing row untouched, and `paused` is one of the statuses it keeps.
   */
  createTaskStatus?: TaskStatus
  /**
   * Whether that read answers with no account on the Platform.
   *
   * The other half of `accountListFails`, and the reason both exist: an empty account list is what a
   * *successful* read of "nothing is bound" looks like and also what a failed read leaves behind, so a
   * sentence about the accounts is only supported by one of the two fixtures.
   */
  accountListEmpty?: boolean
}

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

let scenario: Scenario = { carried: false, finished: 0, choice: { kind: 'ok', items: [GIFT_ITEM] } }
let requests: RecordedRequest[] = []

function query(url: string, name: string): string {
  return new URL(`http://fixture${url}`).searchParams.get(name) ?? ''
}

/** The route without its query, so a fixture compares against a path rather than a whole URL. */
function pathOf(url: string): string {
  return url.split('?')[0] ?? url
}

/** The Task that names the per-Target action, as the Task list answers it, in the scenario's status. */
function carrierTask(): unknown {
  return { ...CARRIER_TASK, status: scenario.carrierStatus ?? 'running' }
}

function fixtureFor(method: string, url: string, body: unknown): unknown {
  const route = pathOf(url)
  if (route.endsWith('/api/platforms')) {
    return { ok: true, platforms: [{ key: 'douyu', label: '斗鱼', actions: actionsOf() }] }
  }
  if (route.endsWith('/api/action-settings')) {
    if (method === 'put') {
      // The route answers with the setting it stored, which is what the store caches. A fixture that
      // answered a bare `ok` would exercise the client-side fallback instead, and would let a save
      // that never reached the cache look green.
      const sent = body as { platform: string; actionKey: string; enabled: boolean; options?: unknown }
      return {
        ok: true,
        setting: {
          platform: sent.platform,
          actionKey: sent.actionKey,
          enabled: sent.enabled,
          options: sent.options ?? {}
        }
      }
    }
    return {
      ok: true,
      settings: actionsOf().map(action => ({
        platform: 'douyu',
        actionKey: action.key,
        enabled: action.key !== scenario.switchedOff,
        options: {}
      }))
    }
  }
  if (route.endsWith('/api/accounts')) {
    if (scenario.accountListFails === true) throw new Error('账号列表读取失败')
    if (scenario.accountListEmpty === true) return { ok: true, accounts: [] }
    return { ok: true, accounts: ACCOUNTS }
  }
  // The list whose status words a carrier row prints, and `get` alone: the create at the bottom
  // answers this same path with a single Task, so a fixture matching on the path alone hands the
  // create an array where the client reads `data.task`.
  if (method === 'get' && route.endsWith('/api/tasks')) {
    if (scenario.taskListFails === true) throw new Error('任务列表读取失败')
    if (scenario.taskListOmitsCarrier === true) return { ok: true, tasks: [ACCOUNT_TASK] }
    // The account-scoped Task exists in both scenarios: the point of the attribution line is that
    // another Task *can* exist and not name this action.
    return { ok: true, tasks: scenario.carried ? [carrierTask(), ACCOUNT_TASK] : [ACCOUNT_TASK] }
  }
  if (route.endsWith('/api/action-settings/options')) {
    return { ok: true, field: 'giftAllowlist', source: 'douyu.backpack', choice: scenario.choice }
  }
  if (route.endsWith('/api/action-settings/workflow')) {
    if (scenario.workflowFails === true) throw new Error('归属读取失败')
    // The route answers per action: only the action a Task's own row names comes back with a carrier,
    // and a Task carrying a Room is not evidence that the account-scoped action has one.
    const actionKey = query(url, 'actionKey')
    const descriptor = actionsOf().find(action => action.key === actionKey)
    if (descriptor === undefined) throw new Error(`no fixture action ${actionKey}`)

    const carried = scenario.carried && actionKey === 'intimacy_tasks'
    return {
      ok: true,
      workflow: {
        wants: {
          needsTarget: descriptor.needsTarget,
          shape: descriptor.needsTarget
            ? '这个动作是对着「目标」做的：任务里要指名这个动作，再选一个目标。'
            : '这个动作是围着「账号」做的：任务里指名这个动作就行，不用选目标。'
        },
        carriers: carried ? [{ id: 7, targetKey: '88013571', targetTitle: '电棍' }] : [],
        // Per action, like `carriers`: 客户端签到's finished Task says nothing about 亲密度任务.
        finishedCarriers: actionKey === 'intimacy_tasks' ? scenario.finished : 0,
        create: carried
          ? null
          : {
              needsTarget: descriptor.needsTarget,
              needsLibrary: descriptor.needsLibrary,
              defaultIntervalSeconds: 300
            }
      }
    }
  }
  if (route.endsWith('/api/targets/resolve')) {
    return {
      ok: true,
      target: { key: '88013571', title: '电棍', anchorId: '310260', anchorName: '电棍', liveStatus: 1 }
    }
  }
  if (method === 'post' && route.endsWith('/api/tasks')) {
    return { ok: true, task: { ...CARRIER_TASK, status: scenario.createTaskStatus ?? 'running' } }
  }
  throw new Error(`no fixture for ${method} ${url}`)
}

http.defaults.adapter = async config => {
  // Lower-cased, because axios spells a method `get` on the config and `GET` on the wire.
  const method = (config.method ?? 'get').toLowerCase()
  // `config.url` is the route and the query lives in `config.params`, because that is how axios
  // takes them; a fixture that read `url` alone would answer every request as if it had no query at
  // all, which is exactly the kind of silent mismatch this suite exists to catch.
  const search = new URLSearchParams(config.params as Record<string, string> | undefined).toString()
  const url = search === '' ? (config.url ?? '') : `${config.url ?? ''}?${search}`
  const body = config.data === undefined ? undefined : JSON.parse(String(config.data))
  requests.push({ method, url, body })
  const data = fixtureFor(method, url, body)
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

  // The two providers the component asks for, in the order `App.vue` nests them: `useMessage` and
  // `useDialog` both throw without one above them, and the panel uses both — a costly action's
  // confirmation comes from `useDialog`.
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

/** The page as a person reads it. */
function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

/**
 * The general note at the top of the panel: the one that says why every action ships off.
 *
 * Read as its own element rather than out of `text()`, because the assertion about it is what it must
 * **not** contain — and the action it would have named, with its price, is on the page below it in the
 * fixture. A page-wide search could not tell the two apart.
 */
function generalNote(): string {
  const note = [...document.querySelectorAll('.n-alert')].find(alert =>
    (alert.textContent ?? '').includes('每个动作默认都是关闭的')
  )
  if (note === undefined) throw new Error('the general note was not rendered')
  return (note.textContent ?? '').replace(/\s+/g, ' ')
}

/**
 * The toasts on screen, in naive-ui's own container.
 *
 * Read separately from `text()`, because a toast is transient and the sentence it carries is the
 * subject of two tests below: asserting them against the whole document would also accept the same
 * words arriving from a static row.
 */
function messages(): string {
  return [...document.querySelectorAll('.n-message')]
    .map(node => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
    .join(' | ')
}

/** One action's own row, so an assertion is about that action rather than about the page. */
function rowElement(label: string): HTMLElement {
  const rows = [...document.querySelectorAll<HTMLElement>('.action-row')]
  const row = rows.find(candidate => (candidate.querySelector('.action-label')?.textContent ?? '').trim() === label)
  if (row === undefined) throw new Error(`no row for ${label}`)
  return row
}

function rowOf(label: string): string {
  return (rowElement(label).textContent ?? '').replace(/\s+/g, ' ')
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    button => (button.textContent ?? '').replace(/\s+/g, ' ').trim() === label
  )
  if (found === undefined) throw new Error(`no button named ${label}`)
  return found as HTMLButtonElement
}

/** Clicks a button the way a pointer does, then lets the request chain land. */
async function click(label: string): Promise<void> {
  buttonNamed(label).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
}

/**
 * Clicks one row's own button.
 *
 * Needed as soon as more than one action on the page offers the same control: 「设置参数」 and 「建一个
 * 任务指名它」 are drawn per row, so a page-wide lookup would act on whichever row came first and the
 * test would be about the fixture's order rather than about the row it names.
 */
async function clickInRow(rowLabel: string, buttonLabel: string): Promise<void> {
  const found = [...rowElement(rowLabel).querySelectorAll('button')].find(
    button => (button.textContent ?? '').replace(/\s+/g, ' ').trim() === buttonLabel
  )
  if (found === undefined) throw new Error(`no button named ${buttonLabel} in ${rowLabel}`)
  found.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
}

/** The box inside one row, so a second row's input cannot be typed into by mistake. */
function inputInRow(rowLabel: string): HTMLInputElement {
  const found = rowElement(rowLabel).querySelector<HTMLInputElement>('input')
  if (found === null) throw new Error(`no input in ${rowLabel}`)
  return found
}

/** Types into a box the way a keystroke does, so the component's own handler runs. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

beforeEach(() => {
  document.body.innerHTML = ''
  scenario = { carried: false, finished: 0, choice: { kind: 'ok', items: [GIFT_ITEM] } }
  requests = []
})

afterEach(() => {
  for (const host of hosts) host.remove()
  hosts = []
})

describe('which Task runs an action', () => {
  it('says no Task names it, and that the switch therefore does nothing', async () => {
    await mountPanel()

    // The owner's own state: the action on, and nothing naming it.
    expect(text()).toContain('现在没有任何任务运行它')
    expect(text()).toContain('开关只是允许它跑')
    expect(text()).toContain('指名了这个动作的任务')
    // And the sentence that stops the old reading — that one Task runs a set of actions.
    expect(text()).toContain('一个任务只跑它自己指名的那个动作')
    // What the action is aimed at is stated in a person's words rather than as the field behind it.
    expect(rowOf('亲密度任务')).toContain('任务里要指名这个动作，再选一个目标')
    expect(text()).not.toContain('needsTarget')
  })

  it('refuses an empty Target before it asks the server for anything', async () => {
    await mountPanel()

    await clickInRow('亲密度任务', '建一个任务指名它')

    // The box is what is missing, and the page says which one rather than sending a request that
    // could only come back as a 400.
    expect(text()).toContain('先填上要针对哪个目标')
    expect(requests.some(request => request.method === 'post')).toBe(false)
  })

  /**
   * The create guard may not turn a failed read into 「还没有绑定账号」.
   *
   * The create offer is drawn from the attribution read, which can land while the account read does
   * not — so an empty account list is not evidence that nothing is bound, and this is the same blank as
   * a carrier row with no status word: the panel asserting from a read that never answered. The pairing
   * is `TaskCreateView.vue`'s (「账号列表没读到，所以这里既不能说你有账号、也不能说你没有」).
   */
  it('says the account list could not be read, instead of claiming no account is bound', async () => {
    scenario = { carried: false, finished: 0, accountListFails: true, choice: { kind: 'ok', items: [GIFT_ITEM] } }
    await mountPanel()

    await type(inputInRow('亲密度任务'), '88013571')
    await clickInRow('亲密度任务', '建一个任务指名它')

    expect(text()).toContain('账号列表这次没读到')
    expect(text()).not.toContain('还没有绑定账号')
    // And nothing was posted against an account id this panel does not have.
    expect(requests.some(request => request.method === 'post')).toBe(false)
  })

  it('creates the Task for the Target a person names, and re-reads the attribution', async () => {
    await mountPanel()

    await type(inputInRow('亲密度任务'), '88013571')

    await clickInRow('亲密度任务', '建一个任务指名它')

    const posted = requests.find(request => request.method === 'post' && request.url.includes('/api/tasks'))
    expect(posted).toBeDefined()
    expect(posted?.body).toMatchObject({
      platform: 'douyu',
      accountId: 1,
      actionKey: 'intimacy_tasks',
      targetKey: '88013571',
      targetTitle: '电棍',
      interval: 300
    })

    // And the row is answered again rather than left stale: the workflow was re-read after the
    // create, which is what makes the gap close on screen without a refresh.
    expect(requests.filter(request => request.url.includes('/api/action-settings/workflow')).length).toBeGreaterThan(2)
  })

  /**
   * What the create actually left behind, over the row that makes the old sentence false.
   *
   * `POST /api/tasks` is create-or-get on (Platform, target, action): `findReconcileTask` hands back an
   * existing row untouched, and `paused` is one of the statuses it keeps — while `listSchedulableTasks`
   * takes only `waiting`/`offline`/`running`, so nothing sweeps that row. 「已有一个任务**会运行**「X」」
   * was therefore the panel asserting a run the code does not do, which is the same sentence the heading
   * above it was narrowed to stop claiming (it reads 「指名这个动作的任务：」) — this was the copy that stayed.
   */
  it('names the status of the row the create answered with, over a paused one', async () => {
    scenario = { carried: false, finished: 0, createTaskStatus: 'paused', choice: { kind: 'ok', items: [GIFT_ITEM] } }
    await mountPanel()

    await type(inputInRow('亲密度任务'), '88013571')
    await clickInRow('亲密度任务', '建一个任务指名它')

    // The status word is the server's own for the row it answered with, and the paused half is the fact
    // a person needs: nothing runs it as it stands.
    expect(messages()).toContain('任务状态：已暂停')
    expect(messages()).toContain('要它跑，先在任务列表里按「恢复」')
    // The sentence this replaces, and the reason it is asserted by absence: it is what the panel said
    // over exactly this row.
    expect(messages()).not.toContain('会运行')
  })

  /**
   * The other end of the same claim: a row the create really did write.
   *
   * The route answers `{ok, task}` on both of its branches with nothing that separates them, so the
   * sentence may name neither branch — 「已创建」 and 「已存在」 are both guesses the payload does not
   * support. What it can say is what the row is and what state it is in, which is what it says.
   */
  it('says the Task it answered with is running, without inventing which branch ran', async () => {
    scenario = { carried: false, finished: 0, createTaskStatus: 'running', choice: { kind: 'ok', items: [GIFT_ITEM] } }
    await mountPanel()

    await type(inputInRow('亲密度任务'), '88013571')
    await clickInRow('亲密度任务', '建一个任务指名它')

    expect(messages()).toContain('任务状态：运行中')
    expect(messages()).not.toContain('任务已创建')
    expect(messages()).not.toContain('恢复')
  })

  it('names the Task that carries it, by title rather than by key', async () => {
    scenario = { carried: true, finished: 0, choice: { kind: 'ok', items: [GIFT_ITEM] } }
    await mountPanel()

    const carried = rowOf('亲密度任务')
    expect(carried).toContain('指名这个动作的任务')
    expect(carried).toContain('电棍')
    // The Target key is an identifier, and it stays out of the sentence.
    expect(carried).not.toContain('88013571')
    expect(carried).not.toContain('现在没有任何任务运行它')
  })

  /**
   * The heading has to be true of every row it can hold, and the paused carrier is the row that proves
   * it was not.
   *
   * `listCarrierTasksForAction` keeps a `paused` row deliberately — `server/src/repo/tasks.ts` says
   * why: excluding it would make the create path hand back a *second* row for the same (Platform,
   * target, action) key, and two rows would run one chore twice. `listSchedulableTasks` is the set that
   * actually runs, and it takes only `waiting`/`offline`/`running` — `server/tests/scheduler-live.test.ts`
   * pins that with 「leaves a paused task entirely alone」. So this row names the action and will not run
   * it until somebody presses 恢复, and the heading had to stop claiming the running: 「会运行它的任务：」
   * over that row was the interface saying something the code does not do, which is the one thing the
   * owner's standing rule forbids. It reads 「指名这个动作的任务：」 now — true of every row it can hold, a
   * paused one included — so this test asserts that live string and the row's own status word. The
   * absence of the retired wording is deliberately *not* asserted here: no line of code writes it any
   * more, so the assertion would pass for any reason at all. The absence that does mean something is the
   * live string's, over the row state that draws no carrier list at all, in the finished-Task test below.
   */
  it('heads the list with what every row on it is, over a row that will not run it', async () => {
    scenario = { carried: true, finished: 0, carrierStatus: 'paused', choice: { kind: 'ok', items: [GIFT_ITEM] } }
    await mountPanel()

    const row = rowOf('亲密度任务')

    // The heading claims only what the query answers: the Tasks that name this action.
    expect(row).toContain('指名这个动作的任务')
    // And the row's own word for what it is, which was already there: parked by a person, so the fix is
    // a true heading rather than a lie of omission about the row.
    expect(row).toContain('任务状态：已暂停')
  })

  /**
   * A carrier row's status comes from a different read than the row itself, so that read can fail — and
   * the row used to answer a failure with a bare name.
   *
   * The rows come from the workflow route, which answers *which* Tasks name the action; the status word
   * under each one comes from the Task list. When the list does not arrive there is no status to print,
   * and a row of one name reads as a Task whose health is known and unremarkable. The pairing for this
   * is applied in five other views and is the one this panel already uses for the catalogue
   * (「平台目录没读到…」): a read that landed is what lets a view assert anything, and a read that did not
   * says so.
   */
  it('says the Task status could not be read, instead of drawing a bare name', async () => {
    scenario = { carried: true, finished: 0, taskListFails: true, choice: { kind: 'ok', items: [GIFT_ITEM] } }
    await mountPanel()

    const row = rowOf('亲密度任务')

    // The attribution is a read of its own, so a failed Task list does not take the row away…
    expect(document.querySelectorAll('.carrier-list')).toHaveLength(1)
    expect(row).toContain('电棍')
    // …and the row says which of the two facts it does not have.
    expect(row).toContain('任务状态这次没读到')
    // The server's own words are on the page, which is the other half of the pairing.
    expect(text()).toContain('任务列表读取失败')
  })

  /**
   * The same blank from the other way round: the list landed and does not hold the row.
   *
   * The two reads are a moment apart, so a Task deleted in between is a carrier to the workflow route
   * and absent from the list — and the row cannot print a status either. 「not in what I read」 is a
   * different fact from 「the read failed」, which is why it is a second sentence rather than a longer
   * one.
   */
  it('says a row is not in the Task list it read, when the two reads disagree', async () => {
    scenario = { carried: true, finished: 0, taskListOmitsCarrier: true, choice: { kind: 'ok', items: [GIFT_ITEM] } }
    await mountPanel()

    expect(rowOf('亲密度任务')).toContain('这次读到的任务列表里没有这一行')
  })

  it('does not borrow a neighbouring Task that runs another action', async () => {
    scenario = { carried: true, finished: 0, choice: { kind: 'ok', items: [GIFT_ITEM] } }
    await mountPanel()

    // 亲密度任务 has a Task naming it — the case above — and 客户端签到 does not: the Task that exists
    // carries a Room and names another action, so it runs this one never. Saying otherwise is the
    // defect this screen exists to remove, in the other direction.
    expect(rowOf('客户端签到')).toContain('现在没有任何任务运行它')
    expect(rowOf('客户端签到')).not.toContain('电棍')
  })

  /**
   * The reported dead end: a Task whose window ran out cannot be held against the action for ever.
   *
   * The page's job here is the pair — the offer that was unreachable before, **and** a truthful
   * sentence about the Task its owner remembers making. The count the server sends is what makes the
   * second possible: without it 「现在没有任何任务运行它」 is the true half of the state with no account
   * of the other half, and a person who created a Task for this action last month is left to work out
   * where it went.
   *
   * What the page is not allowed to do is what it used to: list the finished row under the carrier
   * heading — 「会运行它的任务：」 when this was written, and 「指名这个动作的任务：」 now that the heading has
   * to be true of a paused row too. That is asserted by its absence as well as by the carrier list being
   * empty, because the string is what a reader saw.
   */
  it('offers the create again, and says what became of a Task that ran its window out', async () => {
    // The action on, one Task finished, nothing carrying it: exactly the state the sweep leaves.
    scenario = { carried: false, finished: 1, choice: { kind: 'ok', items: [GIFT_ITEM] } }
    await mountPanel()

    const finishedRow = rowOf('亲密度任务')

    // What happened, in the window's terms — the Task ran its time window out and will not run again…
    expect(finishedRow).toContain('1 个任务已经把时间窗跑完了，不会再跑。')
    // …and what to do about it. Not "delete it": the create path no longer resolves the dead row, so
    // a new Task is the move and this is where it is offered.
    expect(finishedRow).toContain('要接着跑就重新建一个，建的时候把结束时间往后放。')
    // And the offer itself is the thing that used to be withheld.
    expect(finishedRow).toContain('建一个任务指名它')

    // The claim the row may no longer make. Both halves matter: the heading must not be there for a
    // row that carries nothing, and the row must not be named as one of the Tasks running it. The
    // heading was 「会运行它的任务：」 when this test was written and is 「指名这个动作的任务：」 now, so the
    // assertion names the string the component actually draws — an absence asserted against a string no
    // line of code writes is an assertion about nothing.
    expect(finishedRow).not.toContain('指名这个动作的任务')
    expect(finishedRow).not.toContain('电棍')
    // It is still true that nothing runs it, which is why that sentence stays.
    expect(finishedRow).toContain('现在没有任何任务运行它')

    // The page and the route agree about the row, which is the shape the server test pins for real:
    // what the page draws and what the route counts come from one answer, so a carrier list of zero
    // with a finished count of one is the only rendering this state can have. One line, on the one
    // action that has a finished Task — the other action's count is zero and draws nothing.
    expect(document.querySelectorAll('.carrier-list')).toHaveLength(0)
    expect(document.querySelectorAll('.finished-line')).toHaveLength(1)
  })

  it('says nothing about finished Tasks when none has finished', async () => {
    await mountPanel()

    // The ordinary state, and the reason the sentence is conditional rather than always drawn:
    // 「0 个任务已经把时间窗跑完了」 would be a line about nothing.
    expect(text()).toContain('现在没有任何任务运行它')
    expect(text()).not.toContain('个任务已经把时间窗跑完')
  })

  /**
   * The attribution is one request per catalogued action, so one of them can fail on its own.
   *
   * The banner above promises that every action says which Task names it, and this is the state where the
   * panel drew nothing under that promise at all: `loadWorkflows` answers a refusal with `null`, the row
   * falls through both branches, and 「下面每个动作都写了哪个任务指名它」 stood over a blank. A read that did
   * not land is a fact this panel has a sentence for everywhere else (「平台目录没读到…」, 「任务状态这次没
   * 读到」), and here it is also what keeps the banner's own promise true.
   */
  it('says the attribution could not be read, instead of drawing nothing under that promise', async () => {
    scenario = { carried: false, finished: 0, workflowFails: true, choice: { kind: 'ok', items: [GIFT_ITEM] } }
    await mountPanel()

    expect(text()).toContain('归属这次没读到')
    // Every row says which of the two it is — the list, or why there is none — so the banner's promise is
    // about the rows as they are drawn.
    expect(document.querySelectorAll('.where')).toHaveLength(4)
    expect(document.querySelectorAll('.carrier-list')).toHaveLength(0)
  })
})

describe('an action’s parameters', () => {
  it('draws one control per declared field, and no form at all for an action that declares none', async () => {
    await mountPanel()

    expect(text()).not.toContain('允许使用的礼物')

    await clickInRow('亲密度任务', '设置参数')

    expect(text()).toContain('允许使用的礼物')
    expect(text()).toContain(GIFT_FIELD.help)
    // Exactly one form, and it belongs to the action that declares a field: 客户端签到 declares none,
    // so it has no way in at all — rather than an empty form, which would read as "there is
    // something here you cannot see".
    expect(document.querySelectorAll('.param-form')).toHaveLength(1)
    // One row per catalogued action, and the catalogue is the fixture's four.
    expect(document.querySelectorAll('.action-row')).toHaveLength(4)
  })

  it('fills a choice field from the live source, and saves the ticked values', async () => {
    await mountPanel()
    await clickInRow('亲密度任务', '设置参数')

    const read = requests.find(request => request.url.includes('/api/action-settings/options'))
    expect(read?.method).toBe('get')
    expect(read?.url).toContain('accountId=1')
    expect(read?.url).toContain('field=giftAllowlist')

    // The item renders with its count, which is the fact a person chooses by.
    expect(text()).toContain('粉丝荧光棒')
    expect(text()).toContain('持有 60')

    // naive-ui draws a checkbox as a `div[role="checkbox"]` rather than an `<input>`, so this is the
    // element a pointer would hit.
    const checkbox = document.querySelector<HTMLElement>('[role="checkbox"]')
    expect(checkbox).not.toBeNull()
    checkbox?.click()
    await settle()

    await click('保存参数')

    const write = requests.find(request => request.method === 'put')
    expect(write).toBeDefined()
    // The item's own `value` is what is stored — an id, which is exactly why it is never rendered.
    expect(write?.body).toEqual({
      platform: 'douyu',
      actionKey: 'intimacy_tasks',
      enabled: true,
      options: { giftAllowlist: ['268'] }
    })
  })

  it('says the source is unavailable instead of drawing an empty list', async () => {
    scenario = {
      carried: false,
      finished: 0,
      choice: { kind: 'unavailable', reason: '这个账号的网页会话已失效，重新扫码绑定一次就能读到背包。' }
    }
    await mountPanel()
    await clickInRow('亲密度任务', '设置参数')

    // The sentence, not a bare empty control: an expired session and an empty backpack look the
    // same on screen, and 「这个账号没有免费礼物」 is the wrong reading of the first.
    expect(text()).toContain('这个账号的网页会话已失效')
    expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(0)
  })

  it('says an empty list is empty, which is a different fact from an unavailable source', async () => {
    scenario = { carried: false, finished: 0, choice: { kind: 'ok', items: [] } }
    await mountPanel()
    await clickInRow('亲密度任务', '设置参数')

    expect(text()).not.toContain('网页会话已失效')
    expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(0)
    // An empty answer is an answer: `ok` with no items is the source saying it holds nothing, and
    // 「正在读取可选项…」 left a person waiting for a list that had already arrived. It is also not the
    // failure's red sentence — 「读到了但是空的」 and 「读不到」 are different readings of one blank space.
    expect(text()).toContain('一个可选项都没有')
    expect(text()).not.toContain('正在读取可选项')
  })

  /**
   * The choice field may not turn a failed account read into 「还没有绑定账号」.
   *
   * The panel hands `accountId: null` in two different worlds — the account list landed and this
   * Platform has no account bound, or the list did not land at all — and only the first supports a
   * sentence about absence. The second is the blank this whole block is about, one level down: the form
   * asserting from a read that never answered, over a person who *does* have an account bound. The
   * pairing is the panel's own create guard, which asks its flag before it makes the claim (「账号列表
   * 这次没读到，所以不知道这个平台有没有绑定账号」), and `TaskCreateView.vue`'s.
   */
  it('says the account list could not be read, instead of claiming no account is bound', async () => {
    scenario = { carried: false, finished: 0, accountListFails: true, choice: { kind: 'ok', items: [GIFT_ITEM] } }
    await mountPanel()
    await clickInRow('亲密度任务', '设置参数')

    expect(text()).toContain('账号列表这次没读到')
    expect(text()).not.toContain('还没有绑定账号')
    // And no choice read was asked for: there is no account id to ask with, which is the other half of
    // why the field answers with a sentence rather than a list.
    expect(requests.some(request => request.url.includes('/api/action-settings/options'))).toBe(false)
  })

  /**
   * The other half of the pairing, and the half a fix must not swallow.
   *
   * A read that landed and holds no account for this Platform *is* evidence that nothing is bound, so
   * the form still says so: answering every missing account with 「读不到」 would be the same defect with
   * the two facts swapped.
   */
  it('still says no account is bound when the account list arrived empty', async () => {
    scenario = { carried: false, finished: 0, accountListEmpty: true, choice: { kind: 'ok', items: [GIFT_ITEM] } }
    await mountPanel()
    await clickInRow('亲密度任务', '设置参数')

    expect(text()).toContain('这个平台还没有绑定账号')
    expect(text()).not.toContain('账号列表这次没读到')
    expect(requests.some(request => request.url.includes('/api/action-settings/options'))).toBe(false)
  })

  it('says what a list decides and what the switch decides, and nothing more', async () => {
    await mountPanel()
    await clickInRow('亲密度任务', '设置参数')

    // What the field is: the ticked values are what the action **may** act on. What decides whether it
    // acts is the switch, which is the other control on this row — and the third clause is the promise
    // the whole off-by-default decision rests on: the list is not a way to spend while the switch is
    // shut (`runner.ts` reads the switch before it dispatches either executor, and answers a shut
    // switch with `switchOffReport`).
    //
    // **The words used to be the gift allowlist's** — 「清单决定哪些可以送」「不会让任何一件东西出去」 — which
    // was one action's private fact standing on a form that fills in every action's fields: the moment
    // an action declared a list of *rooms* to pour into, 「送」 described the wrong thing. The note says
    // what is true of every list, and the concrete meaning of these values lives in the field's own
    // `help`, which the action that reads them writes.
    expect(text()).toContain('这份清单决定这个动作可以动哪些')
    expect(text()).toContain('动作开关决定它到底动不动')
    expect(text()).toContain('开关关着的时候，这个动作什么都不会做')
  })

  /**
   * The panel is one of the two places a switch can be flipped, and the only one that asks about a spend.
   *
   * `ActionSettingsPanel.vue` says of itself that a costly action asks first, and that promise is kept by
   * the call this panel makes — `toggleActionSwitch` — rather than by its own copy of the question. The
   * other entry point is the create form's 「开启这个动作」 button, which `task-create.test.ts` pins; without a
   * costly fixture here, editing the panel's call back to a straight write would have failed nothing.
   */
  it('asks before it turns a costly action on, and writes only after the answer', async () => {
    scenario = {
      carried: false,
      finished: 0,
      costlyAction: true,
      switchedOff: GROWTH_POOL.key,
      choice: { kind: 'ok', items: [GIFT_ITEM] }
    }
    await mountPanel()

    const row = rowElement(GROWTH_POOL.label)
    // The spend is named before anything is written, which is the half a person has to see.
    expect(rowOf(GROWTH_POOL.label)).toContain('会消耗账号资产')
    expect(rowOf(GROWTH_POOL.label)).toContain('已关闭')

    const toggle = row.querySelector('.n-switch')
    expect(toggle).not.toBeNull()
    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()

    // Nothing has been written yet, and the question names the cost.
    expect(requests.filter(request => request.method === 'put')).toHaveLength(0)
    expect(text()).toContain('确认要开吗')

    await click('确认开启')

    const writes = requests.filter(request => request.method === 'put')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.body).toMatchObject({ actionKey: GROWTH_POOL.key, enabled: true })
  })

  it('never says the repository has no gift request, because it has one', async () => {
    await mountPanel()
    await clickInRow('亲密度任务', '设置参数')

    // The three claims this note used to make, each contradicted inside this repository: the donate
    // request is captured at `server/tests/captured/douyu-donate-request-12306.txt`, the adapter
    // posts it (`sendRowGifts` → `donateGift`), and the action declares itself costly. Asserted by
    // absence as well as the replacement sentence is asserted above, because the strings are what a
    // reader acted on.
    expect(text()).not.toContain('从来没有抓到过')
    expect(text()).not.toContain('不会真的送出礼物')
    expect(text()).not.toContain('一件事都不会发生')
    expect(text()).not.toContain('还没有允许使用的礼物清单')
  })

  it('draws the note about a list only where a list is', async () => {
    await mountPanel()

    // 粉丝家园钓鱼's one option is a number. The note is about what a list does, so drawing it there
    // told a person about a list their action does not have — which is how a Platform's private fact
    // ended up on another action's form. Asserted as 「no sentence about a list at all」, which is the
    // property: the old note said 清单 twice on this very form.
    await clickInRow('粉丝家园钓鱼', '设置参数')
    expect(text()).toContain('钓几次')
    expect(text()).not.toContain('清单')

    await clickInRow('粉丝家园钓鱼', '收起参数')
    await clickInRow('亲密度任务', '设置参数')
    expect(text()).toContain('这份清单决定这个动作可以动哪些')
  })

  it('reopens on the value just saved, because the write goes through the store', async () => {
    await mountPanel()
    await clickInRow('亲密度任务', '设置参数')

    const checkbox = document.querySelector<HTMLElement>('[role="checkbox"]')
    expect(checkbox).not.toBeNull()
    checkbox?.click()
    await settle()

    await click('保存参数')

    await clickInRow('亲密度任务', '收起参数')
    await clickInRow('亲密度任务', '设置参数')

    // The form is destroyed when it is closed and seeded again from the store's copy of the server's
    // answer, so a save that went straight at the API left the server holding `['268']` and the
    // reopened form showing nothing ticked — a person's own answer, contradicted by the next screen.
    const reopened = document.querySelector<HTMLElement>('[role="checkbox"]')
    expect(reopened?.getAttribute('aria-checked')).toBe('true')
  })

  it('says that the form is not the safety boundary', async () => {
    await mountPanel()
    await clickInRow('亲密度任务', '设置参数')

    expect(text()).toContain('管住这个动作的是它自己')
    expect(text()).toContain('拒绝它不认的东西')
  })
})

describe('the switch and the Task, kept apart', () => {
  it('offers one switch per action and no second control pretending to create a Task', async () => {
    await mountPanel()

    // One switch per catalogued action, and the attribution is text plus one button rather than a
    // merged control — merging them would hide the property the switch exists for.
    expect(document.querySelectorAll('.n-switch')).toHaveLength(4)
    expect(text()).toContain('开关和任务是两回事')
  })

  it('offers the create only where this panel can carry it out', async () => {
    await mountPanel()

    // A Send action's Task also needs a library, and this panel has no library picker: its create
    // call could only ever come back as the route's own 「需要选择文本库」. The row says where such a
    // Task can be made instead of drawing a button that cannot work.
    const send = rowOf('发送弹幕')
    expect(send).toContain('现在没有任何任务运行它')
    expect(send).not.toContain('建一个任务指名它')
    expect(send).toContain('创建任务')

    // An action that needs no library keeps the offer, unchanged.
    expect(rowOf('亲密度任务')).toContain('建一个任务指名它')
  })
})

/**
 * The general note is drawn once, above every Platform's card, so it may not name one of them.
 *
 * It carried the example 「比如「打卡分鱼丸」报名一次扣 200 鱼丸」 — one Platform's action and the price
 * that lives in that action's own descriptor, written into a component that serves every Platform and
 * that never reads the amount (the web takes `costly` and nothing else). A fact with two homes is wrong
 * the day either moves, and this second home was the sentence a person reads *before* deciding.
 *
 * Red before the change: all four assertions below were false — the label and the price were in the note,
 * and the pointer at the row's own description was not.
 */
describe('what the general note may say about a costly action', () => {
  it('names no action and no price, and points at the row that carries both', async () => {
    // The costly action really is in the catalogue here, so the facts the note must not borrow are on the
    // page beside it rather than absent from the fixture.
    scenario = {
      carried: false,
      finished: 0,
      costlyAction: true,
      switchedOff: GROWTH_POOL.key,
      choice: { kind: 'ok', items: [GIFT_ITEM] }
    }
    await mountPanel()

    const note = generalNote()
    expect(note).not.toContain(GROWTH_POOL.label)
    expect(note).not.toContain('200')
    // What it says instead points at the two halves the row already draws: the marker this panel puts on a
    // costly action, and that action's own `description` — which is where the sentence naming what is spent
    // lives, and the only place it can be rendered without being copied into this component.
    expect(note).toContain('会消耗账号资产')
    expect(rowOf(GROWTH_POOL.label)).toContain('会消耗账号资产')
    expect(rowOf(GROWTH_POOL.label)).toContain(GROWTH_POOL.description)
  })
})
