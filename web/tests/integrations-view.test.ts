import { NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'

import { http } from '../src/api/client.js'
import { describeEventKind } from '../src/types/api.js'
import IntegrationsView from '../src/views/IntegrationsView.vue'

/**
 * The event feed's own filter, on 「外部集成」.
 *
 * **What this file is for.** The owner asked for a place to say which event kinds he wants to
 * receive, and the feed keeps 「最近 50 条」. A filter applied to those fifty would let a hidden kind
 * consume a place in the window, so the property that has to hold is not "the rows are hidden" but
 * "the request asks for the ticked kinds and nothing else" — which is why every case here reads the
 * query the view actually sent rather than the list it rendered.
 *
 * **The catalogue, spelled out.** `EVENT_KINDS` is `EventKind` as `server/src/repo/events.ts`
 * declares it, written here rather than read out of the app, because a mirror is what this asserts:
 * a kind added on the server fails this line, and that is the moment the checkbox list needs the
 * same edit. `other` is in it on purpose — the server labels a row from a newer build 「未知事件」,
 * so it is a kind the feed can carry and the owner can hide like any other.
 */
const EVENT_KINDS = [
  'task_started',
  'task_went_live',
  'task_finished',
  'task_failed',
  'task_sending_trouble',
  'action_failed',
  'action_blocked',
  'session_expired',
  'account_restricted',
  'session_refreshed',
  'other'
]

/** A base for parsing the relative URLs the client asks with. */
const PAGE_ORIGIN = 'http://page.test'

/** Every URL the view asked for, oldest first. */
let requested: string[] = []

/** The feed's own requests, which is what these cases read. */
function feedRequests(): string[] {
  return requested.filter(url => url.startsWith('/api/events/recent'))
}

function feedRequestAt(index: number): string {
  const url = feedRequests().at(index)
  if (url === undefined) throw new Error(`the feed has made no request at ${String(index)}`)
  return url
}

/** The `kinds` the request named, in its own order. */
function kindsIn(url: string): string[] {
  const value = new URL(url, PAGE_ORIGIN).searchParams.get('kinds')
  return value === null ? [] : value.split(',').filter(kind => kind !== '')
}

/** The raw `kinds` value, so "none ticked" can be told apart from "no parameter at all". */
function kindsParam(url: string): string | null {
  return new URL(url, PAGE_ORIGIN).searchParams.get('kinds')
}

function fixtureFor(url: string): unknown {
  if (url.startsWith('/api/tokens')) return { ok: true, tokens: [], limit: 20 }
  if (url.startsWith('/api/platforms')) return { ok: true, platforms: [] }
  if (url.startsWith('/api/action-settings')) return { ok: true, settings: [] }
  if (url.startsWith('/api/events/recent')) return { ok: true, events: [] }
  throw new Error(`no fixture for ${url}`)
}

http.defaults.adapter = async config => {
  const url = config.url ?? ''
  requested.push(url)
  return { data: fixtureFor(url), status: 200, statusText: 'OK', headers: {}, config }
}

/**
 * `window.localStorage`, where the view keeps the choice.
 *
 * Stubbed rather than taken from the environment so a case can say what *reload* means: the same
 * store across two mounts, and an empty one for the next case. The request interceptor reads a token
 * out of the same place, so this is also what keeps the page from looking logged out.
 */
const stored = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key)
  }
})

/** Naive UI's overlays measure themselves; nothing here does, but they assume it exists. */
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
let apps: VueApp<Element>[] = []

async function mountView(): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)

  // `useMessage` needs its provider above the view, exactly as the app's tree has it.
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(IntegrationsView) }) })
  app.use(createPinia())
  apps.push(app)
  app.mount(host)
  await settle()
}

/** Leaving the page: what a reload's first half has to survive. */
function unmountView(): void {
  for (const app of apps) app.unmount()
  apps = []
  for (const host of hosts) host.remove()
  hosts = []
}

/**
 * The rendered checkbox for one kind.
 *
 * Naive UI draws a checkbox as a `div` carrying `role="checkbox"` — there is no `input` to read — so
 * its state is `aria-checked` and its click handler sits on that div.
 */
function checkboxFor(label: string): HTMLElement {
  const box = [...document.querySelectorAll<HTMLElement>('.n-checkbox')].find(
    node => node.querySelector('.n-checkbox__label')?.textContent?.trim() === label
  )
  if (box === undefined) throw new Error(`the feed rendered no checkbox labelled ${label}`)
  return box
}

/** Ticks or unticks one kind, and lets the feed reload that follows land. */
async function tick(label: string, checked: boolean): Promise<void> {
  const box = checkboxFor(label)
  if (box.getAttribute('aria-checked') === String(checked)) return
  box.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
}

/** The sentence above the feed, which the page's own numbers have to agree with. */
function feedSentence(): string {
  const alert = [...document.querySelectorAll('.n-alert')].find(node => node.textContent?.includes('拉取增量事件'))
  if (alert === undefined) throw new Error('the event feed rendered no explanation')
  return alert.textContent ?? ''
}

/** The number of seconds that sentence promises between refreshes. */
function sentenceSeconds(): number {
  const match = /每 (\d+) 秒/.exec(feedSentence())
  if (match?.[1] === undefined) throw new Error('the feed no longer says how often it refreshes')
  return Number(match[1])
}

beforeEach(() => {
  stored.clear()
  requested = []
})

afterEach(() => {
  unmountView()
  vi.restoreAllMocks()
})

describe('the event feed filter on 外部集成', () => {
  it('asks for every kind before the owner has hidden one', async () => {
    await mountView()

    const asked = kindsIn(feedRequestAt(0))
    expect(asked).toHaveLength(EVENT_KINDS.length)
    expect(asked).toEqual(expect.arrayContaining(EVENT_KINDS))
    // A page that has never been filtered stores nothing, so this is also the feed a brand-new
    // account sees: exactly the rows it saw before the filter shipped.
    expect(stored.size).toBe(0)
  })

  it('asks the server for the kinds that are left, rather than hiding rows it already fetched', async () => {
    await mountView()
    const before = feedRequests().length

    await tick('发送异常', false)

    // Reloaded on the click rather than at the next tick, so the choice reads as itself at once.
    expect(feedRequests().length).toBeGreaterThan(before)
    const asked = kindsIn(feedRequestAt(-1))
    expect(asked).not.toContain('task_sending_trouble')
    expect(asked).toHaveLength(EVENT_KINDS.length - 1)
    expect(checkboxFor('发送异常').getAttribute('aria-checked')).toBe('false')
    // And an empty feed says the filter is why it is empty, instead of reading as an idle service.
    expect(document.body.textContent).toContain('没有符合筛选条件的事件')
  })

  it('keeps the choice for the next visit', async () => {
    await mountView()
    await tick('发送异常', false)
    unmountView()
    requested = []

    await mountView()

    expect(kindsIn(feedRequestAt(0))).not.toContain('task_sending_trouble')
    expect(kindsIn(feedRequestAt(0))).toHaveLength(EVENT_KINDS.length - 1)
    expect(checkboxFor('发送异常').getAttribute('aria-checked')).toBe('false')
  })

  it('empties its own feed, rather than showing the noise, when nothing is ticked', async () => {
    await mountView()

    for (const kind of EVENT_KINDS) await tick(describeEventKind(kind), false)

    // The parameter is present and empty: a request for none of them, which the server reads as
    // such — an absent one would mean "no filter" and would hand back the whole feed.
    expect(kindsParam(feedRequestAt(-1))).toBe('')
    expect(document.body.textContent).toContain('没有勾选任何事件类型')
  })

  it('shows a sentence its own code reads: how many rows, and how often', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    await mountView()

    const limit = new URL(feedRequestAt(0), PAGE_ORIGIN).searchParams.get('limit')
    expect(feedSentence()).toContain(`最近 ${String(limit)} 条`)

    // The other number in that sentence, against the timer the page actually registered.
    const delays = interval.mock.calls.map(call => call[1]).filter(delay => typeof delay === 'number')
    expect(delays).toContain(sentenceSeconds() * 1000)
  })
})
