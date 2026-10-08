import { NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

import { http } from '../src/api/client.js'
import type { Account, ActionDescriptor, Platform } from '../src/types/api.js'
import AccountsView from '../src/views/AccountsView.vue'

/**
 * The QR image is not the subject, and drawing one needs a canvas this environment does not have.
 */
vi.mock('qrcode', () => ({
  default: { toDataURL: async (): Promise<string> => 'data:image/png;base64,QQ==' }
}))

/**
 * The two reported display defects, at the seam where a person sees them.
 *
 * Both are account-row defects and both are about a value the row is handed, so this is a
 * DOM test on the real view with the real components — the same choice
 * `task-create.test.ts` records, and for the same reason: the interesting failures here
 * are the ones a pure data assertion cannot see.
 *
 *  - **Bilibili, whose avatar is a GIF.** The stored URL is correct and the format is not
 *    the problem. Bilibili's image CDN answers **403** to a request that carries a
 *    Referer from any other site, and a browser sends the page's own origin as the Referer
 *    on an `<img>` by default. So the assertion is the one that decides whether the image
 *    is even asked for: `referrerpolicy="no-referrer"` on the rendered `<img>`. Asserting
 *    the URL alone would pass on the broken build too.
 *
 *  - **Douyu, with no name and no avatar.** A Platform that could not supply a nickname
 *    leaves `display_name` empty, and `externalId` is the honest fallback — but only on
 *    the line that says it is an id. On the name line it reads as a name, which is the
 *    defect: a bare number where a person expects to see who the account is.
 */

/** Never rendered, but `Platform` requires one. */
const NO_ACTIONS: ActionDescriptor[] = []

const BILI_AVATAR = 'https://i1.hdslb.com/bfs/face/94f187b638183792cd602da95853decd89726117.gif'

const BILI: Account = {
  id: 1,
  platform: 'bilibili',
  displayName: 'Seatbelts_',
  avatar: BILI_AVATAR,
  externalId: '14004964',
  createdAt: 0
}

/** No name and no image: what the Douyu adapter writes when the session carries neither. */
const DOUYU_NAMELESS: Account = {
  id: 2,
  platform: 'douyu',
  displayName: '',
  avatar: '',
  externalId: '456918967',
  createdAt: 0
}

const PLATFORMS: Platform[] = [
  { key: 'bilibili', label: 'B 站', actions: NO_ACTIONS },
  { key: 'douyu', label: '斗鱼', actions: NO_ACTIONS }
]

let accounts: Account[] = []

/** When set, the next scan poll is refused — the shape a restarted server or an expired session has. */
let refusedPoll = false

/** When set, the code itself cannot be requested: the handshake never gets as far as a scan. */
let refusedCode = false

function fixtureFor(url: string): unknown {
  if (url.endsWith('/api/platforms')) return { ok: true, platforms: PLATFORMS }
  if (url.endsWith('/api/action-settings')) return { ok: true, settings: [] }
  if (url.endsWith('/api/accounts')) return { ok: true, accounts }
  if (url.endsWith('/api/douyu/accounts/qrcode')) {
    if (refusedCode) throw new Error('这一次没要到二维码')
    return { ok: true, url: 'https://passport.douyu.com/scan?code=abc', key: 'key-1' }
  }
  if (url.includes('/api/douyu/accounts/qrcode/')) {
    // 404 in the real server, and any refusal reads the same way here: the handshake cannot continue.
    if (refusedPoll) throw new Error('这一次没读到扫码结果')
    return { ok: true, state: 'pending', message: '' }
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

async function mountView(settleWith: () => Promise<void> = settle): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)

  // `useMessage` needs its provider above the view, exactly as the app's tree has it.
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(AccountsView) }) })
  app.use(createPinia())
  app.mount(host)
  await settleWith()
}

/**
 * The same flush, under fake timers.
 *
 * The scan handshake is a 2-second `setInterval`, so the test drives the clock instead of waiting on
 * it — which means the macrotask in {@link settle} has to be advanced rather than awaited.
 */
async function flushWithFakeTimers(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await nextTick()
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < 6; i += 1) await nextTick()
}

/** Clicks a button the way a pointer does. */
async function clickNamed(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find(
    candidate => (candidate.textContent ?? '').replace(/\s+/g, ' ').trim() === label
  )
  if (button === undefined) throw new Error(`no button named ${label}`)
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/**
 * Clicks one Platform's card's own button.
 *
 * Both Platforms offer 「扫码绑定」, so a page-wide lookup acts on whichever comes first — and this
 * test is about one Platform's handshake, not about the fixture's order.
 */
async function clickInCard(cardLabel: string, buttonLabel: string): Promise<void> {
  const card = [...document.querySelectorAll('.n-card')].find(candidate =>
    (candidate.querySelector('.n-card-header')?.textContent ?? '').includes(cardLabel)
  )
  const button = [...(card?.querySelectorAll('button') ?? [])].find(
    candidate => (candidate.textContent ?? '').replace(/\s+/g, ' ').trim() === buttonLabel
  )
  if (button === undefined) throw new Error(`no button named ${buttonLabel} in ${cardLabel}`)
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/** The page as a person reads it, overlays included: the bind dialog is the whole screen. */
function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

/** The accounts as text, one row per line, with the id-mentioned lines dropped. */
function nameLines(): string[] {
  return [...document.querySelectorAll('.name')].map(node => (node.textContent ?? '').trim())
}

function uidLines(): string[] {
  return [...document.querySelectorAll('.uid')].map(node => (node.textContent ?? '').trim())
}

/** The `<img>` inside the avatar slot, or null when there is none. */
function avatarImg(): HTMLImageElement | null {
  return document.querySelector<HTMLImageElement>('[class^="n-avatar"] img')
}

function itemInitials(): string[] {
  return [...document.querySelectorAll('.n-avatar__text')].map(node => (node.textContent ?? '').trim())
}

beforeEach(() => {
  // The whole body, not only the hosts: `NModal` teleports to `document.body`, so a dialog left open by
  // one test outlives its host — and its card, titled 「斗鱼 扫码绑定」, would be the first one this file's
  // `clickInCard` finds.
  document.body.innerHTML = ''
  accounts = [BILI, DOUYU_NAMELESS]
  refusedPoll = false
  refusedCode = false
})

afterEach(() => {
  for (const host of hosts) host.remove()
  hosts = []
})

describe('AccountsView, the avatar a Platform stores', () => {
  it('asks for the image with no referrer, which is what Bilibili\u2019s CDN requires', async () => {
    await mountView()

    const img = avatarImg()
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe(BILI_AVATAR)
    // The defect: without this the request carries `Referer: <page origin>` and the CDN
    // answers 403, so nothing renders however right the stored URL is.
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('keeps a row that has no image on its initials rather than an empty box', async () => {
    await mountView()

    // One image on the page — the account that has one — and one text avatar for the
    // account that does not.
    expect(document.querySelectorAll('[class^="n-avatar"] img')).toHaveLength(1)
    expect(itemInitials()).toEqual(['#'])
  })

  it('falls back to the initials when the image fails to load', async () => {
    accounts = [BILI]
    await mountView()

    expect(avatarImg()).not.toBeNull()
    avatarImg()?.dispatchEvent(new Event('error'))
    await settle()

    // The broken-image icon is replaced by the same initials row a Platform with no
    // image gets, so a dead avatar URL still says which account the row is.
    expect(avatarImg()).toBeNull()
    expect(itemInitials()).toEqual([BILI.displayName.slice(0, 1)])
  })
})

describe('AccountsView, an account the Platform gave no name', () => {
  it('shows the id only on the line that says it is an id', async () => {
    await mountView()

    // The reported symptom, read back: `456918967` must not appear on the name line,
    // where it reads as a name.
    expect(nameLines()).toEqual(['Seatbelts_', '账号 ID（该平台没有提供昵称）'])
    expect(uidLines()).toEqual(['ID 14004964', 'ID 456918967'])
  })

  it('does not fall back to the id on the name line even when that is all there is', async () => {
    accounts = [{ ...DOUYU_NAMELESS, displayName: '' }]
    await mountView()

    expect(nameLines()).toEqual(['账号 ID（该平台没有提供昵称）'])
    expect(nameLines()[0]).not.toContain(DOUYU_NAMELESS.externalId)
  })
})

describe('AccountsView, the scan handshake when a poll is refused', () => {
  it('stops claiming the handshake is live, and offers the way out where it stopped', async () => {
    vi.useFakeTimers()
    try {
      refusedPoll = false
      await mountView(flushWithFakeTimers)

      await clickInCard('斗鱼', '扫码绑定')
      await flushWithFakeTimers()

      expect(text()).toContain('请用 斗鱼 客户端扫码')
      expect(text()).not.toContain('重新生成')

      // The shape a restarted server or an expired session has: the poll answers 404, the timer stops,
      // and the dialog went on saying 「请用 斗鱼 客户端扫码」 over a QR nothing was asking about. The
      // only way out was to close the modal and start again, which the dialog never said.
      refusedPoll = true
      await vi.advanceTimersByTimeAsync(2100)
      await flushWithFakeTimers()

      expect(text()).toContain('这次握手已经停下')
      expect(text()).toContain('这一次没读到扫码结果')
      expect(text()).not.toContain('请用 斗鱼 客户端扫码')
      expect(text()).toContain('重新生成')

      // And the offer works, because the dialog is the whole screen while it is open.
      refusedPoll = false
      await clickNamed('重新生成')
      await flushWithFakeTimers()
      expect(text()).toContain('请用 斗鱼 客户端扫码')
      expect(text()).not.toContain('这次握手已经停下')
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * The other way the handshake stops, which used to borrow the sentence above.
   *
   * `startBind` has two catches and they are two facts: its own runs when the **code** could not be
   * requested — nothing was scanned, and there is no scan result to read — while the poll's runs after a
   * code was rendered and a person may well have scanned it. Both set the same state, so the dialog
   * answered the first with 「扫码结果没读到」, a sentence about a scan that had not happened.
   */
  it('says the code could not be fetched, instead of blaming a scan that never happened', async () => {
    refusedCode = true
    await mountView()

    await clickInCard('斗鱼', '扫码绑定')
    await settle()

    expect(text()).toContain('这一次没要到二维码')
    expect(text()).toContain('二维码没取到')
    expect(text()).not.toContain('扫码结果没读到')
    // Nothing is loading in this state, so the dialog draws no spinner either: a spinner over a
    // handshake that never started is the same claim in another medium.
    expect(document.querySelectorAll('.qr .n-spin')).toHaveLength(0)
    // And the way out is offered here too, which is where a person is standing.
    expect(text()).toContain('重新生成')
  })
})
