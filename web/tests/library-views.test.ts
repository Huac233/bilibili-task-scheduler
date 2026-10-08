import { AxiosError, type AxiosResponse } from 'axios'
import { NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type App, createApp, h, nextTick } from 'vue'
import { createRouter, createWebHashHistory, type Router } from 'vue-router'

import { http } from '../src/api/client.js'
import LibrariesView from '../src/views/LibrariesView.vue'
import LibraryDetailView from '../src/views/LibraryDetailView.vue'

/**
 * The two library screens, at the seams where they used to say something they could not know.
 *
 *  - **「还没有导入文本」 was also what a failed read looked like.** `LibrariesView` wrote `error` on
 *    every failure and rendered it nowhere, so a stopped server or a 500 left that sentence standing
 *    alone — the one claim a person acts on, with nothing beside it to say it was not known.
 *  - **A library page was bound to the address only once.** `Number(route.params['id'])` was read in
 *    `setup`, and vue-router reuses one instance across two addresses that match the same route
 *    record, so `#/libraries/1` followed by `#/libraries/2` kept drawing the first library.
 */

const DAY = 24 * 60 * 60 * 1000

const LIBRARIES = [
  { id: 1, userId: 1, name: '第一本', filename: 'a.txt', rawChars: 300, bulletCount: 2, createdAt: DAY },
  { id: 2, userId: 1, name: '第二本', filename: 'b.txt', rawChars: 900, bulletCount: 1, createdAt: DAY }
]

/** Which routes the fixture answers with a refusal, by path. */
let refused: string[] = []

/** A refusal shaped like the ones axios raises, so `describeError` reads it as the server's sentence. */
function refusal(message: string): AxiosError {
  return new AxiosError(message, 'ERR_BAD_RESPONSE', undefined, undefined, {
    data: { ok: false, error: message },
    status: 500,
    statusText: 'Internal Server Error',
    headers: {},
    config: { headers: {} }
  } as unknown as AxiosResponse)
}

function pathOf(url: string): string {
  return url.split('?')[0] ?? url
}

function fixtureFor(url: string): unknown {
  const route = pathOf(url)
  if (refused.includes(route)) throw refusal(`这一次没读到：${route}`)
  if (route.endsWith('/api/libraries')) return { ok: true, libraries: LIBRARIES }
  if (route.endsWith('/api/libraries/1')) return { ok: true, library: LIBRARIES[0] }
  if (route.endsWith('/api/libraries/2')) return { ok: true, library: LIBRARIES[1] }
  if (route.endsWith('/api/libraries/1/bullets')) {
    return {
      total: 2,
      bullets: [
        { seq: 0, content: '第一本的第一条' },
        { seq: 1, content: '第一本的第二条' }
      ]
    }
  }
  if (route.endsWith('/api/libraries/2/bullets')) {
    return { total: 1, bullets: [{ seq: 0, content: '第二本的第一条' }] }
  }
  throw new Error(`no fixture for ${url}`)
}

http.defaults.adapter = async config => {
  const data = fixtureFor(config.url ?? '')
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

async function mountView(view: Parameters<typeof h>[0], path: string): Promise<{ router: Router }> {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)

  const router = createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: '/libraries', name: 'libraries', component: { render: () => null } },
      { path: '/libraries/:id', name: 'library-detail', component: { render: () => null } },
      { path: '/libraries/import', name: 'library-import', component: { render: () => null } }
    ]
  })
  await router.push(path)

  const app: App = createApp({ render: () => h(NMessageProvider, null, { default: () => h(view) }) })
  app.use(createPinia())
  app.use(router)
  app.mount(host)
  await settle()
  return { router }
}

function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

beforeEach(() => {
  refused = []
  document.body.innerHTML = ''
})

afterEach(() => {
  for (const host of hosts) host.remove()
  hosts = []
})

describe('LibrariesView, an empty list against an unread one', () => {
  it('says the read failed, and does not also claim there is nothing there', async () => {
    refused = ['/api/libraries']
    await mountView(LibrariesView, '/libraries')

    // Both halves matter: the failure has to be visible at all (it was rendered nowhere), and the
    // sentence that reads as 「我这里什么都没有」 must not be what a failed read produces.
    expect(text()).toContain('这一次没读到：/api/libraries')
    expect(text()).not.toContain('还没有导入文本')
  })

  it('still says there is nothing there when the read succeeded and there is', async () => {
    await mountView(LibrariesView, '/libraries')

    expect(text()).toContain('第一本')
    expect(text()).not.toContain('还没有导入文本')
  })
})

describe('LibraryDetailView, the address as the identity of the page', () => {
  it('re-reads when the address names another library', async () => {
    const { router } = await mountView(LibraryDetailView, '/libraries/1')

    expect(text()).toContain('第一本')
    expect(text()).toContain('第一本的第一条')

    await router.push('/libraries/2')
    await settle()

    // The instance is reused — same route record, new params — so this is the case `onMounted` alone
    // cannot serve: without the watcher the page kept the first library's bullets under its own name,
    // and the address was the only thing that had changed.
    expect(text()).toContain('第二本')
    expect(text()).toContain('第二本的第一条')
    expect(text()).not.toContain('第一本的第一条')
  })
})
