import { NDialogProvider, NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type App, createApp, h, nextTick } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'

import { http } from '../src/api/client.js'
import type { ActionDescriptor, Platform } from '../src/types/api.js'
import TaskCreateView from '../src/views/TaskCreateView.vue'
import { fieldsFor } from '../src/views/task-create-fields.js'

/**
 * The reported bug, at the seam where it actually happened.
 *
 * Reported from real use: after picking 「发送弹幕」 a switch to another action left a
 * form holding *several* 「执行间隔」 fields and 「加盐」 — an option the new action has no
 * business having. The cause was not the descriptor lookup and not stale state in a
 * `ref`: the descriptor was right and the state was right, while the DOM was wrong.
 * `NSpace` wraps every child in `<div key={1}>` (naive-ui `es/space/src/Space.mjs`),
 * so with the `v-if` branches as NSpace's own children the slot was a keyed fragment
 * with duplicate keys, and Vue's keyed diff reused the wrong nodes when the set
 * changed. This test mounts the real view with the real components and asserts what a
 * person sees: the labels, exactly once each.
 *
 * It is a DOM test on purpose. A pure test of the descriptor logic passes both before
 * and after the fix — it cannot see this bug — so the loop that goes red on it has to
 * render.
 */
const SEND: ActionDescriptor = {
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

/** Account-scoped, and with a *higher* floor than Send — the shape that forces a clamp. */
const SIGN_IN: ActionDescriptor = {
  key: 'sign_in',
  action: 'reconcile',
  label: '客户端签到',
  description: '每日签到。',
  costly: false,
  needsTarget: false,
  needsLibrary: false,
  maxMessageLength: 0,
  defaultIntervalSeconds: 300,
  minIntervalSeconds: 60
}

/** Needs a target but no library, so the two booleans cannot be confused for one. */
const LIKE: ActionDescriptor = {
  key: 'like',
  action: 'reconcile',
  label: '点赞',
  description: '给关注的视频点赞。',
  costly: false,
  needsTarget: true,
  needsLibrary: false,
  maxMessageLength: 0,
  defaultIntervalSeconds: 120,
  minIntervalSeconds: 5
}

/** A costly action, so 「开启这个动作」 can be asked about the spend before it writes. */
const GROWTH_POOL: ActionDescriptor = {
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

let catalogue: ActionDescriptor[] = [SEND, SIGN_IN, LIKE, GROWTH_POOL]

/** Catalogued actions the fixture answers as switched off, so 「开启这个动作」 has something to do. */
let switchedOff: string[] = []

/** The one bound account the fixture answers with, unless a test asks for a second one. */
const ACCOUNT_ONE = {
  id: 1,
  platform: 'bilibili',
  displayName: '测试账号',
  avatar: '',
  externalId: 'uid-1',
  createdAt: 0
}

/**
 * The second account on the same Platform, so 「the account changes」 is a move this form really offers.
 *
 * **It is what makes the state below reachable at all.** With exactly one account bound the page preselects
 * it (「there is no choice to make in that case」), so a person cannot resolve a Target before choosing one —
 * and that order is the state whose answer this file has to pin: a Target read as nobody, on a form that is
 * then told which account it runs as.
 */
const ACCOUNT_TWO = {
  id: 2,
  platform: 'bilibili',
  displayName: '第二个账号',
  avatar: '',
  externalId: 'uid-2',
  createdAt: 0
}

/** Whether both accounts are bound. Off by default: the four-action page is what most of this file reads. */
let secondAccount = false

/**
 * The two things one paste answers with, which is the whole of why `titleNote` exists.
 *
 * A Platform reads a Room's own name only when the request carries a session — Bilibili's 主播名 needs one, and
 * what it falls back to is the broadcast's own 标题 — so 「铁人」 arrives with a sentence saying the name could
 * not be read and 「电棍」 with nothing to add. **Neither is a refusal**: the Target resolved, and the route
 * answers a real refusal with a 4xx this form puts in its error bar instead. The fixture answers on whether
 * the ask carried an account.
 */
const ANCHOR_NAME = '电棍'
const BROADCAST_TITLE = '铁人'

/**
 * The adapter's own sentence for a read that had no credential, verbatim from where it is written
 * (`server/src/platform/bilibili/index.ts`).
 *
 * Used in negative assertions — 「the form no longer answers as nobody」 — so it is a whole sentence on
 * purpose: `AGENTS.md`'s rule is that a marker in a negative assertion must be too long for two adjacent
 * rendered values to spell it.
 */
const NO_ACCOUNT_NOTE = '未选择账号，读不到主播名：B 站只在请求带上账号的登录 cookie 时才给出这个字段'

/** The label a test forces the fixture to answer, or null to let it answer on the ask. */
let resolvedTitle: string | null = null

/** The sentence a test forces the fixture to answer, or null to let it answer on the ask. */
let resolveNote: string | null = null

/** The normalised liveness a test forces the fixture to answer, or null for the default live verdict. */
let resolvedLiveStatus: number | null = null

/** When set, the account list is refused: the page then cannot say whether anything is bound. */
let accountsRefused = false

/**
 * When set, the account read *succeeds* and holds nothing.
 *
 * The other half of `accountsRefused`, and the reason both exist: an empty list is what a successful
 * read of "nothing is bound" looks like and also what a failed read leaves behind, so a sentence about
 * the accounts is only supported by one of the two.
 */
let accountsEmpty = false

/** When set, the library list is refused: the picker then cannot say whether there is any. */
let librariesRefused = false

/** When set, the target resolution is refused: a failure that is not about either list. */
let targetResolveRefused = false

/**
 * The status of the Task `POST /api/tasks` answers with.
 *
 * The route is create-or-get for a reconcile action, so the row may be one it just wrote or one that
 * already existed — and `findReconcileTask` keeps a `paused` row, which nothing sweeps.
 */
let createdStatus: 'running' | 'paused' = 'running'

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

let requests: RecordedRequest[] = []

function fixtureFor(method: string, url: string, body: unknown): unknown {
  if (url.endsWith('/api/platforms')) {
    return { ok: true, platforms: [{ key: 'bilibili', label: 'B站', actions: catalogue }] }
  }
  if (url.endsWith('/api/action-settings')) {
    if (method === 'put') {
      // The route answers with what it stored, which is the shape the store caches.
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
      settings: catalogue.map(action => ({
        platform: 'bilibili',
        actionKey: action.key,
        enabled: !switchedOff.includes(action.key),
        options: {}
      }))
    }
  }
  if (url.endsWith('/api/accounts')) {
    if (accountsRefused) throw new Error('这一次没读到账号列表')
    if (accountsEmpty) return { ok: true, accounts: [] }
    return { ok: true, accounts: secondAccount ? [ACCOUNT_ONE, ACCOUNT_TWO] : [ACCOUNT_ONE] }
  }
  if (url.endsWith('/api/targets/resolve')) {
    if (targetResolveRefused) throw new Error('解析不了这个房间号')
    // Whether the ask carried an account is what the answer turns on, and that is the contract this route
    // grew. Read off the body rather than off the fixture's own flags, so a page that forgot to send the
    // account cannot pass here.
    const sent = body as { accountId?: number }
    const credentialed = sent.accountId !== undefined
    return {
      ok: true,
      target: {
        key: '8801',
        title: resolvedTitle ?? (credentialed ? ANCHOR_NAME : BROADCAST_TITLE),
        anchorId: credentialed ? '1' : '',
        anchorName: credentialed ? ANCHOR_NAME : '',
        liveStatus: resolvedLiveStatus ?? 1,
        titleNote: resolveNote ?? (credentialed ? '' : NO_ACCOUNT_NOTE)
      }
    }
  }
  if (url.endsWith('/api/libraries')) {
    if (librariesRefused) throw new Error('这一次没读到文本库列表')
    return {
      ok: true,
      libraries: [{ id: 7, userId: 1, name: '测试库', filename: 'a.txt', rawChars: 10, bulletCount: 3, createdAt: 0 }]
    }
  }
  if (method === 'post' && url.endsWith('/api/tasks')) {
    // The reply the create route gives, and the shape `taskApi.create` reads: one row, whose status is
    // all this page has to say what happened. Everything else is left out on purpose, so a page that
    // read a field the route does not promise fails here rather than passing on a richer fixture.
    return { ok: true, task: { id: 42, status: createdStatus } }
  }
  throw new Error(`no fixture for ${url}`)
}

http.defaults.adapter = async config => {
  const method = (config.method ?? 'get').toLowerCase()
  const url = config.url ?? ''
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

/** Naive UI measures its overlays; the form does not, but the components assume both exist. */
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

/**
 * The view's setup state, which `<script setup>` keeps private.
 *
 * Read through the mounted tree's internal instance rather than by loosening the
 * component: a test-only `defineExpose` would be production surface added for the
 * test's benefit, and closed-by-default is the point of `<script setup>`. Vue unwraps
 * the refs on `setupState`, so these are plain values.
 */
interface ViewState {
  platformKey: string | null
  accountId: number | null
  actionKey: string | null
  descriptor: ActionDescriptor | null
  interval: number
  libraryId: number | null
  saltEnabled: boolean
  requireOnline: boolean
  target: unknown
  intervalNotice: string
  canSubmit: boolean
  catalog: { platforms: Platform[] }
}

/**
 * Finds the view's setup state by its own shape rather than by Vue internals.
 *
 * `<script setup>` keeps the refs private, and a test-only `defineExpose` would be
 * production surface added for the test's benefit. So the vnode tree is walked —
 * through `component` links, `subTree`, and children — for the instance whose setup
 * state carries the refs this view owns: `actionKey`, `interval` and
 * `intervalNotice`, which no other component in the tree declares.
 */
function setupStateOf(app: App): Record<string, unknown> {
  function walk(node: unknown, depth: number): Record<string, unknown> | null {
    if (node === null || node === undefined || typeof node !== 'object' || depth > 60) return null

    const record = node as Record<string, unknown>
    const state = record['setupState']
    if (typeof state === 'object' && state !== null) {
      const fields = state as Record<string, unknown>
      if ('actionKey' in fields && 'interval' in fields && 'intervalNotice' in fields) return fields
    }

    const children = record['children']
    const next: unknown[] = [record['component'], record['subTree'], record['dynamicChildren']]
    if (Array.isArray(children)) next.push(...children)
    else next.push(children)

    for (const child of next) {
      const found = walk(child, depth + 1)
      if (found !== null) return found
    }
    return null
  }

  const found = walk(app._instance, 0)
  if (found === null) throw new Error('the mounted TaskCreateView setup state could not be found')
  return found
}

/** Flushes microtasks and one macrotask, so the `onMounted` chain lands. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  for (let i = 0; i < 6; i += 1) await nextTick()
}

async function mountView(): Promise<ViewState> {
  const host = document.createElement('div')
  document.body.append(host)

  const router = createRouter({
    history: createWebHashHistory(),
    // `submit` navigates to the Task it just asked for, so the app's own two routes have to exist here:
    // without this the push rejects and the rejection lands in the page's error slot, which is an error
    // about the test's router standing where a person would see none.
    routes: [
      { path: '/', component: { render: () => null } },
      { path: '/tasks/:id', name: 'task-detail', component: { render: () => null } }
    ]
  })
  await router.push('/')

  // `useMessage` and `useDialog` both need their provider above the view, exactly as the app's tree
  // has it: the action switch's costly question comes from the dialog provider.
  const app = createApp({
    render: () =>
      h(NMessageProvider, null, {
        default: () => h(NDialogProvider, null, { default: () => h(TaskCreateView) })
      })
  })
  app.use(createPinia())
  app.use(router)
  app.mount(host)
  await settle()

  return setupStateOf(app) as unknown as ViewState
}

/** The form fields on screen, in order — a field appearing twice appears twice here. */
function shownLabels(): string[] {
  return [...document.querySelectorAll('.n-form-item-label__text')].map(node => node.textContent?.trim() ?? '')
}

function cardText(): string {
  return (document.querySelector('.n-card')?.textContent ?? '').replace(/\s+/g, ' ')
}

/** Selecting an action is what the action picker does; this is the same assignment. */
async function choose(view: ViewState, actionKey: string): Promise<void> {
  view.actionKey = actionKey
  await settle()
}

/** Clicks a button the way a pointer does, then lets the request chain land. */
async function clickButton(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find(
    candidate => (candidate.textContent ?? '').replace(/\s+/g, ' ').trim() === label
  )
  if (button === undefined) throw new Error(`no button named ${label}`)
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
}

/** Writes to the switchboard, which is the only request a costly question is about. */
function settingsWrites(): RecordedRequest[] {
  return requests.filter(request => request.method === 'put' && request.url.endsWith('/api/action-settings'))
}

/** How many times a sentence appears in the rendered page — a duplicate is a duplicated notice. */
function occurrences(needle: string): number {
  return (document.body.textContent ?? '').split(needle).length - 1
}

/**
 * The toasts on screen, in naive-ui's own container.
 *
 * Read apart from the page: a toast is the only place some of this form's sentences appear, so an
 * assertion made against the page would not be about them at all.
 */
function messages(): string {
  return [...document.querySelectorAll('.n-message')]
    .map(node => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
    .join(' | ')
}

/** The page as a person reads it, whitespace flattened. */
function pageText(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

/**
 * The control under one form field's own label.
 *
 * Found through the label rather than by position, so a field added above it cannot move the assertion
 * onto another control — the arrangement `import-view.test.ts` records for its two number boxes.
 */
function controlUnder(label: string): HTMLInputElement {
  const item = [...document.querySelectorAll('.n-form-item')].find(
    candidate => (candidate.querySelector('.n-form-item-label')?.textContent ?? '').trim() === label
  )
  const control = item?.querySelector<HTMLInputElement>('input')
  if (control === undefined || control === null) throw new Error(`no control under ${label}`)
  return control
}

/**
 * The text a select draws when nothing is chosen, which is where a list's own claim lives.
 *
 * Read off naive-ui's own selection placeholder rather than an `<input placeholder>`: a `NSelect` is not
 * a text box and renders its empty state as an element, so an attribute lookup would find nothing and
 * the assertion would be about the test's lookup rather than about the sentence.
 */
function selectPlaceholderOf(label: string): string {
  const item = [...document.querySelectorAll('.n-form-item')].find(
    candidate => (candidate.querySelector('.n-form-item-label')?.textContent ?? '').trim() === label
  )
  return (item?.querySelector('.n-base-selection-placeholder')?.textContent ?? '').trim()
}

/** Types into a box the way a keystroke does, so the component's own handler runs. */
async function typeInto(label: string, value: string): Promise<void> {
  const box = controlUnder(label)
  box.value = value
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

beforeEach(() => {
  catalogue = [SEND, SIGN_IN, LIKE, GROWTH_POOL]
  switchedOff = []
  accountsRefused = false
  accountsEmpty = false
  secondAccount = false
  resolvedTitle = null
  resolveNote = null
  resolvedLiveStatus = null
  librariesRefused = false
  targetResolveRefused = false
  createdStatus = 'running'
  requests = []
  document.body.innerHTML = ''
})

describe('TaskCreateView, after switching action', () => {
  it('shows exactly the fields the chosen action asks for', async () => {
    const view = await mountView()
    expect(view.platformKey).toBe('bilibili')

    for (const action of [SEND, SIGN_IN, LIKE]) {
      await choose(view, action.key)
      expect(view.descriptor?.key).toBe(action.key)

      const wants = [
        action.needsTarget ? '目标' : null,
        action.needsLibrary ? '文本库' : null,
        action.needsTarget ? '等待开播' : null,
        action.action === 'send' ? '加盐' : null
      ].filter((label): label is string => label !== null)
      // The template's three conditions and `fieldsFor` must agree, not just happen
      // to agree today: both are asserted against the same descriptor here.
      expect(fieldsFor(view.descriptor)).toEqual(wants)
      for (const label of wants) expect(shownLabels()).toContain(label)
      for (const label of ['目标', '文本库', '等待开播', '加盐']) {
        if (!wants.includes(label)) expect(shownLabels()).not.toContain(label)
      }
    }
  })

  it('renders one 执行间隔, and no trace of the previous action, after a switch', async () => {
    const view = await mountView()

    await choose(view, SEND.key)
    expect(shownLabels().filter(label => label === '执行间隔')).toHaveLength(1)
    expect(shownLabels()).toContain('加盐')

    await choose(view, SIGN_IN.key)

    // Counted as form items, not as occurrences of the string: the clamp notice in
    // this very test names 「执行间隔」 too, and a duplicated *field* is the symptom.
    expect(shownLabels().filter(label => label === '执行间隔')).toHaveLength(1)
    expect(shownLabels()).not.toContain('加盐')
    expect(shownLabels()).not.toContain('目标')
    expect(shownLabels()).not.toContain('文本库')
    expect(document.querySelectorAll('.n-input-number').length).toBe(1)
  })

  it('leaves no stale state behind for a field the new action does not have', async () => {
    const view = await mountView()

    await choose(view, SEND.key)
    view.libraryId = 7
    view.requireOnline = false

    await choose(view, SIGN_IN.key)

    expect(view.libraryId).toBeNull()
    expect(view.requireOnline).toBe(true)
    expect(view.saltEnabled).toBe(true)
    expect(view.target).toBeNull()
  })

  it('keeps a legal interval the user typed when the action changes', async () => {
    const view = await mountView()

    await choose(view, SEND.key)
    // 45 is above Send's floor of 10 and above 点赞's floor of 5: still legal after
    // the switch, and the user's own number.
    view.interval = 45
    await settle()

    await choose(view, LIKE.key)

    expect(view.interval).toBe(45)
    expect(view.intervalNotice).toBe('')
  })

  it('clamps an interval that the new action forbids, and says so', async () => {
    const view = await mountView()

    await choose(view, SEND.key)
    view.interval = 5
    await settle()

    await choose(view, SIGN_IN.key)

    // Send's own floor is 10, so 5 was already below it; 签到's floor is 60.
    expect(view.interval).toBe(60)
    // The corrected value and where the number comes from, not the rule said a second way: the form
    // has one sentence for the rule and this is the other fact — that it moved the number.
    expect(view.intervalNotice).toContain('已把执行间隔改到 60 秒')
    expect(view.intervalNotice).toContain('「客户端签到」自己的下限')
    expect(cardText()).toContain('已把执行间隔改到 60 秒')
  })

  it('keys the slot, so Vue never reconciles one action’s notice into another’s form', async () => {
    switchedOff = [GROWTH_POOL.key]
    const warnings: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    })
    try {
      const view = await mountView()
      await choose(view, SEND.key)
      await choose(view, GROWTH_POOL.key)
    } finally {
      spy.mockRestore()
    }

    // `NSpace` keys every child it wraps with the literal `1` (naive-ui `es/space/src/Space.mjs`), so
    // a slot whose *child count* changes is a keyed fragment with duplicate keys — the trap
    // `nspace-fragment.test.ts` pins on this very form, where it multiplied 「执行间隔」 and left 「加盐」
    // on screen for an action that has no such concept. The fields live in keyed wrappers; the notices
    // are conditional children of the same slot, and switching to a costly switched-off action is
    // exactly when their count changes. Vue names the situation when it happens, so the assertion is
    // that it never does.
    expect(warnings.filter(message => message.includes('Duplicate keys'))).toEqual([])
  })

  it('leaves none of the previous action’s notices on screen', async () => {
    switchedOff = [GROWTH_POOL.key]
    const view = await mountView()

    await choose(view, SEND.key)
    // Send is not costly and is switched on in this fixture: neither notice belongs here.
    expect(document.body.textContent ?? '').not.toContain('这个动作会花掉账号里的东西')
    expect(document.body.textContent ?? '').not.toContain('开启这个动作')

    await choose(view, GROWTH_POOL.key)

    // Exactly the new action's notices, once each. `NSpace` keys every child it wraps with the
    // literal `1`, so a notice whose `v-if` is NSpace's own child changes the child count — the
    // duplicate-key fragment Vue reconciles wrongly, which is why the form's fields live in keyed
    // wrappers. The notices are conditional children too, and this is that arrangement asserted:
    // switching action must not leave one action's words beside another's form.
    expect(occurrences('这个动作会花掉账号里的东西')).toBe(1)
    expect(occurrences('开启这个动作')).toBe(1)
    expect(document.body.textContent ?? '').not.toContain('加盐')
  })

  it('states the cadence floor in its own words rather than copying the route’s sentence', async () => {
    const view = await mountView()

    await choose(view, SEND.key)
    view.interval = 3
    await settle()

    // The form refuses the value before the request, and says which rule it refused it by — the
    // action's own floor. It must not print the route's sentence for the same rule: the two packages
    // cannot share a string, so a copy is one rule with two homes and drifts on its own.
    expect(cardText()).toContain('「发送弹幕」最快 10 秒一次，执行间隔不能比它小')
    expect(document.body.textContent ?? '').not.toContain('发送间隔不能低于')
  })

  it('does not send somebody to bind an account when the list could not be read', async () => {
    accountsRefused = true
    await mountView()

    // `!loading && accounts.length === 0` cannot tell "there are none" from "we did not get an
    // answer", and the sentence it drew was an instruction: go and bind an account. A person who
    // already has one is sent on a round trip to fix a read that failed.
    expect(document.body.textContent ?? '').toContain('账号列表没读到')
    expect(document.body.textContent ?? '').not.toContain('还没有绑定任何账号')
  })

  it('asks before it turns a costly action on, which is what the switchboard promises', async () => {
    switchedOff = [GROWTH_POOL.key]
    const view = await mountView()
    await choose(view, GROWTH_POOL.key)

    // The button sits under the warning that this action spends what the account owns.
    expect(cardText()).toContain('这个动作会花掉账号里的东西')
    expect(cardText()).toContain('开启这个动作')

    await clickButton('开启这个动作')

    // Nothing has been written yet, and the question named the cost. This is the defect: this path
    // used to write the switch straight through while the switchboard asked, so the same click spent
    // silently on one screen and asked on the other.
    expect(settingsWrites()).toHaveLength(0)
    expect(document.body.textContent ?? '').toContain('确认要开吗')

    await clickButton('确认开启')

    expect(settingsWrites()).toHaveLength(1)
    expect(settingsWrites()[0]?.body).toMatchObject({ actionKey: GROWTH_POOL.key, enabled: true })
  })

  it('never leaves a submittable form whose interval the route would refuse', async () => {
    const view = await mountView()

    await choose(view, SEND.key)
    for (const interval of [3, 9, 10, 45, 120]) {
      view.interval = interval
      await settle()
      await choose(view, LIKE.key)
      // LIKE's floor is 5 — the only cadence rule at this point.
      expect(view.interval).toBeGreaterThanOrEqual(5)
      await choose(view, SEND.key)
      expect(view.interval).toBeGreaterThanOrEqual(10)
    }
    expect(view.canSubmit).toBe(false)
  })

  it('re-seeds the cadence when the Platform changes, where the old number means nothing', async () => {
    const view = await mountView()

    await choose(view, SEND.key)
    view.interval = 45
    await settle()

    // A second Platform whose only action is a Send one with Douyu-like numbers.
    const store = (view as unknown as { catalog: { platforms: Platform[] } }).catalog
    store.platforms[0] = {
      key: 'douyu',
      label: '斗鱼',
      actions: [
        {
          key: 'send_danmaku',
          action: 'send',
          label: '发送弹幕',
          description: '',
          costly: false,
          needsTarget: true,
          needsLibrary: true,
          maxMessageLength: 70,
          defaultIntervalSeconds: 3,
          minIntervalSeconds: 3
        }
      ]
    }
    view.platformKey = 'douyu'
    await settle()

    expect(view.interval).toBe(3)
    expect(view.intervalNotice).toBe('')
    expect(view.libraryId).toBeNull()
  })
})

/**
 * What this page may say about a create it did not necessarily do.
 *
 * `POST /api/tasks` is create-or-get for a reconcile action, and the row it hands back may be one that
 * already existed — `findReconcileTask` keeps a `paused` row on purpose, and `listSchedulableTasks`
 * takes only `waiting`/`offline`/`running`. 「任务已创建」 was therefore this page saying a row had been
 * made, and that something would run it, over a row neither is true of; the same sentence lived in the
 * settings panel's toast, which says the same thing in the same words now.
 */
describe('TaskCreateView, after it asks the route for the Task', () => {
  it('names the status of the row the route answered with, over a paused one', async () => {
    createdStatus = 'paused'
    const view = await mountView()
    await choose(view, SIGN_IN.key)
    expect(view.canSubmit).toBe(true)

    await clickButton('创建任务')

    // The status word is the server's own for the row it answered with, plus the fact that matters for
    // the one status nothing sweeps.
    expect(messages()).toContain('任务状态：已暂停')
    expect(messages()).toContain('要它跑，先在任务列表里按「恢复」')
    expect(messages()).not.toContain('任务已创建')
  })

  it('says a running row is running, without inventing which branch ran', async () => {
    const view = await mountView()
    await choose(view, SIGN_IN.key)

    await clickButton('创建任务')

    // Neither branch is separable from the payload — the route answers `{ok, task}` for the create and
    // for the existing row alike — so the sentence names what the row is and says nothing about which
    // of the two happened.
    expect(messages()).toContain('任务状态：运行中')
    expect(messages()).not.toContain('任务已创建')
    expect(messages()).not.toContain('已存在')
  })
})

/**
 * What this page may say about the two lists it reads.
 *
 * Both the account sentence and the library picker's placeholder are claims about *what exists*, and
 * only a read that landed supports one. This page writes a failure from four other places — the target
 * resolution, the switch write, the create, and the catalogue (which reports into the store) — so
 * 「哪一次失败」 and 「哪一个列表没读到」 are two different questions, and the page used to answer the
 * second with the first.
 */
describe('TaskCreateView, and the two lists it has to ask about', () => {
  it('still says no account is bound when the list arrived empty and something else failed', async () => {
    accountsEmpty = true
    targetResolveRefused = true
    const view = await mountView()
    await choose(view, SEND.key)

    await typeInto('目标', '8801')
    await clickButton('解析')

    // The account read landed and holds nothing, which is evidence, and 「还没有绑定任何账号」 is its
    // sentence. 「账号列表没读到」 is a claim about a read that answered, and the page made it anyway: the
    // flag behind it read the same `error` slot a failed room-number resolution writes.
    expect(pageText()).toContain('还没有绑定任何账号')
    expect(pageText()).not.toContain('账号列表没读到')
    // And the failure that really happened is reported as itself, in the server's own words.
    expect(pageText()).toContain('解析不了这个房间号')
  })

  it('keeps the account read’s own failure beside that sentence, whatever failed after it', async () => {
    accountsRefused = true
    targetResolveRefused = true
    const view = await mountView()
    await choose(view, SEND.key)

    await typeInto('目标', '8801')
    await clickButton('解析')

    const banner = [...document.querySelectorAll('.n-alert')].find(alert =>
      (alert.textContent ?? '').includes('账号列表没读到')
    )
    expect(banner).not.toBeUndefined()
    // The sentence quotes the account read rather than whichever call wrote the shared bar last, which is
    // why it stopped pointing at that bar: `resolveTarget` clears it before it runs, so the quote could
    // stand over another call's message, or over nothing at all.
    expect(banner?.textContent ?? '').toContain('这一次没读到账号列表')
    expect(banner?.textContent ?? '').not.toContain('解析不了这个房间号')
  })

  it('does not claim there is no library when the library list could not be read', async () => {
    librariesRefused = true
    const view = await mountView()
    await choose(view, SEND.key)

    // The picker's sentence is about the libraries that exist, so it may only be drawn from a list that
    // arrived: 「还没有文本库，先去「文本库」导入一份」 over an unread one sends a person to import a
    // second copy of a library they already have.
    expect(selectPlaceholderOf('文本库')).toContain('文本库列表这次没读到')
    expect(pageText()).not.toContain('还没有文本库')
  })
})

/** The asks the form made of the Target route, in the order they went out. */
function targetAsks(): RecordedRequest[] {
  return requests.filter(request => request.url.endsWith('/api/targets/resolve'))
}

/** The alert that announced the Target, found through the label it carries rather than by position. */
function alertCarrying(needle: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.n-alert')].find(node => (node.textContent ?? '').includes(needle))
}

/**
 * The Target read: what it takes with it, and what the page may do with the answer.
 *
 * **The read takes an account, and the answer depends on it.** A Platform reads a Room's own name only when
 * the request carries a session — Bilibili reads 主播名 that way, and what it falls back to is the broadcast's
 * own 标题 — so the same paste answers 「铁人」 plus a sentence saying the name could not be read, or 「电棍」 with
 * nothing to add. The form is where that account is *chosen*, which makes this the page where 「the account
 * changed after a Target was read」 is reachable — and the two halves of that are one question asked twice:
 * the read has to be made as the chosen account, and an answer read as another one may not go on standing on
 * the form.
 */
describe('TaskCreateView, and the Target it resolves', () => {
  /**
   * ⓐ The read is asked as the account the form runs as, and `accountId.value` is where that comes from — the
   * same ref `submit` sends as the Task's own account. Left out, the form would read the Room's name for
   * nobody and then create a Task for account 1 whose stored title was never the room's own.
   */
  it('asks the route as the account the form would run as, rather than as nobody', async () => {
    const view = await mountView()

    // The one account bound to the only Platform: the page preselects it, because there is no choice to make.
    expect(view.accountId).toBe(1)
    await choose(view, SEND.key)

    await typeInto('目标', '8801')
    await clickButton('解析')

    const asked = targetAsks()
    expect(asked).toHaveLength(1)
    expect(asked[0]?.body).toMatchObject({ platform: 'bilibili', input: '8801', accountId: 1 })
  })

  /**
   * The other half, and not a red-before claim: **no account travels as no field at all**.
   *
   * The route's schema takes a positive integer or nothing — `accountId: null` is a third thing it answers
   * 400 for — so a form with nothing bound has to omit the key rather than send a placeholder, which is the
   * same idiom `actionSettingApi.set` uses for a bare toggle. Guarded rather than invented: it was true
   * before this change and is the shape a wrong fix would break.
   */
  it('sends no account at all when the form has none, rather than a placeholder', async () => {
    accountsEmpty = true
    const view = await mountView()
    await choose(view, SEND.key)
    expect(view.accountId).toBeNull()

    await typeInto('目标', '8801')
    await clickButton('解析')

    expect(targetAsks()[0]?.body).not.toHaveProperty('accountId')
  })

  /**
   * What a label structurally cannot say: the adapter's own sentence about the name it could not read.
   *
   * 「铁人」 is a broadcast's subject line, and a person shown it has no way to know that this build failed to
   * read 「电棍」 — so the adapter says why and the page draws it beside the label. **As a hint, and never as an
   * error**: the Target resolved, and a real refusal is the route's 4xx, which this page puts in its `error`
   * bar above the card. The sentence is drawn once, inside the alert that announced the Target.
   */
  it('draws the adapter’s own sentence beside the Target it explains, as a hint rather than an error', async () => {
    accountsEmpty = true
    const view = await mountView()
    await choose(view, SEND.key)
    await typeInto('目标', '8801')
    await clickButton('解析')

    const announced = alertCarrying(BROADCAST_TITLE)
    expect(announced).not.toBeUndefined()
    // The sentence carries this page's own class for a sentence that explains rather than warns…
    expect(announced?.querySelector<HTMLElement>('.hint')?.textContent).toBe(NO_ACCOUNT_NOTE)
    // …and it is in the alert that announced the Target, so nothing else on the page is claiming it — the
    // failure bar is a different element drawn from `error`, which this read did not write.
    expect(alertCarrying(NO_ACCOUNT_NOTE)).toBe(announced)
  })

  /**
   * The picker shows the normalised verdict the scheduler acts on. A room that will not be acted on (a 轮播
   * reads offline) must not be drawn as 直播中, and the offline word says it covers 轮播.
   */
  it('shows a room the scheduler will not act on as offline, and never as 直播中', async () => {
    resolvedLiveStatus = 0
    const view = await mountView()
    await choose(view, SEND.key)
    await typeInto('目标', '8801')
    await clickButton('解析')

    expect(alertCarrying('未开播（含轮播）')).not.toBeUndefined()
    expect(alertCarrying('直播中')).toBeUndefined()
  })

  /**
   * The label's other reading, which the note must not take over.
   *
   * A Room the adapter could name nowhere — no anchor name and no 标题 — still falls back to
   * 「目标 <key>」, exactly as it did before there was a note to draw beside it.
   */
  it('keeps the 「目标 <key>」 label for an answer with no title, with the hint beside it', async () => {
    accountsEmpty = true
    resolvedTitle = ''
    const view = await mountView()
    await choose(view, SEND.key)
    await typeInto('目标', '8801')
    await clickButton('解析')

    const announced = alertCarrying('目标 8801')
    expect(announced).not.toBeUndefined()
    expect(announced?.querySelector<HTMLElement>('.hint')?.textContent).toBe(NO_ACCOUNT_NOTE)
  })

  /**
   * ⓑ The answer was read **as** an account, so it may not outlive the choice of one.
   *
   * With two accounts bound the page preselects neither (「anything else is left empty so the user does not
   * confirm a default they did not look at」), so a person really can resolve a Target before saying which
   * account the Task runs as — and the answer they get is the one read without a credential. Choosing an
   * account then makes that label a name read for somebody else: the same defect as the settings panel's
   * Target echo, one `ref` over, and the same fix in this form's own idiom — a Platform change drops the
   * Target the same way (`syncPlatformDefaults`), because the answer to 「which room is this」 is read per
   * account. Dropping rather than re-asking keeps one trigger per read, and `canSubmit` already refuses a
   * Target-bearing submit with no resolved Target.
   */
  it('drops a Target read without an account once the form runs as one, and asks again as that account', async () => {
    secondAccount = true
    const view = await mountView()
    await choose(view, SEND.key)
    expect(view.accountId).toBeNull()

    await typeInto('目标', '8801')
    await clickButton('解析')

    // Read as nobody: the label is the broadcast's own, with the adapter's sentence about it.
    expect(cardText()).toContain(BROADCAST_TITLE)
    expect(cardText()).toContain(NO_ACCOUNT_NOTE)

    view.accountId = 1
    await settle()

    // The label would be a name read for somebody else, so it goes rather than standing — and the form says
    // so by refusing to submit without one.
    expect(view.target).toBeNull()
    expect(cardText()).not.toContain(NO_ACCOUNT_NOTE)
    expect(view.canSubmit).toBe(false)

    // The typed link is still the person's own question, so asking it again answers as the account now chosen.
    await clickButton('解析')

    const asked = targetAsks()
    expect(asked).toHaveLength(2)
    expect(asked[1]?.body).toMatchObject({ platform: 'bilibili', input: '8801', accountId: 1 })
    expect(cardText()).toContain(ANCHOR_NAME)
    expect(cardText()).not.toContain(NO_ACCOUNT_NOTE)
  })
})
