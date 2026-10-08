import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'

import { http } from '../src/api/client.js'
import ImportView from '../src/views/ImportView.vue'

/**
 * The import form's length boxes, against the route that stores what they describe.
 *
 * Two things were wrong here and both are about a number the form was not entitled to.
 *
 *  - **The bound.** `:max="100"` on both boxes was neither a Platform's cap nor the route's; the route
 *    accepts 1–70 (its comment says the number is "the largest real cap rather than a round number"),
 *    so 71–100 was a value the form allowed and the route refused. The bound now comes from the
 *    catalogue's own Send caps, and this test types the value a person would and reads what the control
 *    does with it.
 *  - **The sentence.** 「由平台和账号等级共同决定」 named a rule no code reads — the number is a
 *    constant each adapter declares — and 「超过上限的内容会被服务端拒收，或者被静默截断到上限以内」
 *    described neither this server (which segments a long line into several bullets) nor the Platforms
 *    (one rejects, one truncates).
 *
 * The salting sentence is asserted here too because it is the same box's next sentence: the salt
 * characters include a space and a bullet with no room is left untouched, so 「每条随机插入 2 个标点」 was
 * wrong twice over.
 */

const PLATFORMS = [
  {
    key: 'bilibili',
    label: 'B站',
    actions: [
      {
        key: 'send_danmaku',
        action: 'send',
        label: '发送弹幕',
        description: '发弹幕。',
        costly: false,
        needsTarget: true,
        needsLibrary: true,
        maxMessageLength: 20,
        defaultIntervalSeconds: 30,
        minIntervalSeconds: 10
      }
    ]
  },
  {
    key: 'douyu',
    label: '斗鱼',
    actions: [
      {
        key: 'send_danmaku',
        action: 'send',
        label: '发送弹幕',
        description: '发弹幕。',
        costly: false,
        needsTarget: true,
        needsLibrary: true,
        maxMessageLength: 70,
        defaultIntervalSeconds: 30,
        minIntervalSeconds: 3
      }
    ]
  }
]

/**
 * The route's own ceiling on both length boxes, read out of its source rather than copied here.
 *
 * The two packages cannot share a value — `web` does not import `server` — so this is the only
 * machine-checked tie available between them: whatever `server/src/routes/libraries.ts` refuses values
 * above is exactly what this form has to clamp to. Read rather than written down a second time, so the
 * assertion cannot drift along with the form it is checking.
 *
 * The path is taken from the working directory rather than from `import.meta.url`, because under
 * `happy-dom` the module's URL has an `http://localhost/...` origin and is not a file path at all. Both
 * cwds the suite is run from are tried: `pnpm --filter @bts/web test` and a direct `vitest run` in
 * `web/` both make that directory the cwd, and either layout finds the file.
 */
function routeBulletCeiling(): number {
  const relative = 'server/src/routes/libraries.ts'
  for (const candidate of [resolve(process.cwd(), '..', relative), resolve(process.cwd(), relative)]) {
    if (!existsSync(candidate)) continue
    const declared = /const MAX_BULLET_LENGTH = (\d+)/.exec(readFileSync(candidate, 'utf8'))
    if (declared === null) throw new Error(`${relative} no longer declares MAX_BULLET_LENGTH = <number>`)
    return Number(declared[1])
  }
  throw new Error(`${relative} not found from ${process.cwd()}`)
}

/** The catalogue the fixture answers with, so a test can answer with a different one. */
let platforms: unknown = PLATFORMS

/** When set, `GET /api/platforms` is refused: the page then has no caps and no hint buttons. */
let catalogueRefused = false

function fixtureFor(url: string): unknown {
  if (url.endsWith('/api/platforms')) {
    if (catalogueRefused) throw new Error('这一次没读到平台目录')
    return { ok: true, platforms }
  }
  if (url.endsWith('/api/action-settings')) return { ok: true, settings: [] }
  if (url.endsWith('/api/libraries/preview')) {
    return {
      ok: true,
      truncated: false,
      sampleChars: 20,
      stats: { inputChars: 20, outputCount: 1, droppedTooShort: 0, droppedEmpty: 0, deduped: 0, unsafeRulesSkipped: 1 },
      summary: { count: 1, totalChars: 20, minChars: 20, maxChars: 20 },
      bullets: ['一条弹幕'],
      effectiveOptions: {}
    }
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

async function mountView(): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)

  // A router, because the view navigates after an import; the stack it pushes onto is not the subject.
  const router = createRouter({
    history: createWebHashHistory(),
    routes: [{ path: '/', component: { render: () => null } }]
  })
  await router.push('/')

  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(ImportView) }) })
  app.use(createPinia())
  app.use(router)
  app.mount(host)
  await settle()
}

/**
 * The number box under one field label.
 *
 * Found through the form item's own label rather than by position, so a field added above these two
 * cannot silently move the assertion onto another control.
 */
function numberBox(label: string): HTMLInputElement {
  const item = [...document.querySelectorAll('.n-form-item')].find(
    candidate => (candidate.querySelector('.n-form-item-label')?.textContent ?? '').trim() === label
  )
  const box = item?.querySelector<HTMLInputElement>('input')
  if (box === undefined || box === null) throw new Error(`no number box for ${label}`)
  return box
}

/** Types a value and leaves the field, which is when a number control settles on its bounds. */
async function typeAndLeave(box: HTMLInputElement, value: string): Promise<void> {
  box.value = value
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  box.dispatchEvent(new Event('blur', { bubbles: true }))
  await settle()
}

function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

/** A button by its own label, so an assertion can be about whether it would send anything. */
function buttonNamed(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    button => (button.textContent ?? '').replace(/\s+/g, ' ').trim() === label
  )
  if (found === undefined) throw new Error(`no button named ${label}`)
  return found
}

beforeEach(() => {
  document.body.innerHTML = ''
  platforms = PLATFORMS
  catalogueRefused = false
})

afterEach(() => {
  for (const host of hosts) host.remove()
  hosts = []
})

describe('ImportView, the length boxes and the route that stores them', () => {
  it('refuses a length the route would refuse, instead of offering it', async () => {
    await mountView()

    // 70 is the largest cap any Send action declares — Douyu's — and it is the number the route's
    // storage ceiling is built from. The box used to take anything up to 100, so a person could set a
    // value that could only come back as the route's 400.
    const longest = numberBox('单条弹幕最长长度')
    await typeAndLeave(longest, '100')
    expect(longest.value).toBe('70')

    const shortest = numberBox('最短长度')
    await typeAndLeave(shortest, '100')
    expect(shortest.value).toBe('70')
  })

  it('names where the cap comes from, which is the action’s own declaration', async () => {
    await mountView()

    expect(text()).toContain('来自各个平台发送动作自己的声明')
    expect(text()).toContain('B站 20 字')
    expect(text()).toContain('斗鱼 70 字')
    // No code reads an account tier: the number is a constant on the descriptor, and the sentence that
    // claimed otherwise was the one thing on this screen a reader could not trace to a line.
    expect(text()).not.toContain('账号等级')
  })

  it('says what happens to a bullet over the cap, which is neither rejection nor truncation', async () => {
    await mountView()

    // The segmenter breaks a long line into several bullets (`breakLongLine`), and a tail shorter than
    // 「最短长度」 is dropped. Neither is 「被服务端拒收」 — this server never refuses for length — nor is
    // it 「被静默截断」, which is a Platform's behaviour and not this app's.
    expect(text()).toContain('比上限长的一条会被切成多条')
    expect(text()).not.toContain('服务端拒收')
  })

  it('does not promise salt on every bullet, or punctuation', async () => {
    await mountView()

    // `SALT_CHARS` contains a space, and `applySalt` returns the text untouched when the bullet has no
    // room for its two characters — which the default 20-character B站 cap produces constantly.
    expect(text()).toContain('装得下的那几条还会随机插入 2 个字符')
    expect(text()).not.toContain('每条还会随机插入 2 个标点')
  })

  it('names the rules the safety guard skipped, and says why they were skipped', async () => {
    await mountView()

    // A rule the guard refused is a change that did not take effect, and the only other sign of it is
    // that the person's own rule is missing from the result. The guard over-refuses on purpose
    // (a pattern the engine could survive is refused too), so this is a message people will meet.
    const warnings: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    })
    try {
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea')
      expect(textarea).not.toBeNull()
      if (textarea === null) return
      textarea.value = '一段要被分割的文本'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()

      const preview = [...document.querySelectorAll('button')].find(
        button => (button.textContent ?? '').trim() === '预览分割结果'
      )
      preview?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await settle()
    } finally {
      spy.mockRestore()
    }

    expect(text()).toContain('规则被跳过')
    expect(text()).toContain('这次有 1 条正则规则没生效')
    expect(text()).toContain('安全守卫把它们跳过了')
    // The fact with no number is not enough, and the number with no reason leaves them guessing.
    expect(text()).toContain('嵌套量词')

    // And the preview arriving must not be the child-set change `NSpace` reconciles wrongly: this
    // slot's second child appears exactly then, so it lives in a key of its own — the arrangement
    // `task-create.test.ts` asserts for the other form.
    expect(warnings.filter(message => message.includes('Duplicate keys'))).toEqual([])
  })
})

/**
 * The bound while the catalogue is not there, and the pair of boxes as one rule.
 *
 * The previous round moved both boxes' bound from a hardcoded `100` to "the largest cap the catalogue
 * declares" — the right direction — and left the one state where the catalogue has not landed falling
 * back to `Infinity`. That is *wider* than the `100` it replaced, and the route rejects anything over
 * `MAX_BULLET_LENGTH` with a 400, so the fix had made it possible to type a value the server refuses.
 * Neither test here existed: the file's fixture always answers the catalogue, so the window was
 * untested, and nothing asserted the form's ceiling against the route's number at all.
 */
describe('ImportView, the bound itself', () => {
  it('keeps its bound when the catalogue has not landed, instead of going unbounded', async () => {
    catalogueRefused = true
    await mountView()

    // No caps are known in this state, and the page says nothing about a cap it does not have (`:300`).
    // What it must not do is take a length the route would refuse.
    const longest = numberBox('单条弹幕最长长度')
    await typeAndLeave(longest, String(routeBulletCeiling() + 30))
    expect(longest.value).toBe(String(routeBulletCeiling()))

    const shortest = numberBox('最短长度')
    await typeAndLeave(shortest, '1000')
    expect(shortest.value).toBe(String(routeBulletCeiling()))
  })

  it('clamps to the route’s own ceiling, so a catalogue cannot out-declare what the route stores', async () => {
    const over = routeBulletCeiling() + 30
    platforms = [
      {
        key: 'bilibili',
        label: 'B站',
        actions: [
          {
            key: 'send_danmaku',
            action: 'send',
            label: '发送弹幕',
            description: '发弹幕。',
            costly: false,
            needsTarget: true,
            needsLibrary: true,
            maxMessageLength: over,
            defaultIntervalSeconds: 30,
            minIntervalSeconds: 10
          }
        ]
      }
    ]
    await mountView()

    // The catalogue is the form's only witness for a cap, and it can declare more than the route stores.
    // The bound is then the smaller of the two: offering `over` would be offering the route's 400 again.
    const longest = numberBox('单条弹幕最长长度')
    await typeAndLeave(longest, String(over))
    expect(longest.value).toBe(String(routeBulletCeiling()))
  })

  it('refuses a pair the route refuses, and allows the pair that is legal', async () => {
    await mountView()

    const shortest = numberBox('最短长度')
    const longest = numberBox('单条弹幕最长长度')

    await typeAndLeave(shortest, '50')
    await typeAndLeave(longest, '20')

    // `server/src/routes/libraries.ts` answers 400 「minLength 不能大于 maxLength」 for this pair, so the
    // two moves that would send it are unavailable and the page says which rule refuses.
    expect(text()).toContain('不能大于')
    expect(buttonNamed('预览分割结果').disabled).toBe(true)
    expect(buttonNamed('导入').disabled).toBe(true)

    // Equal is the boundary the route accepts, and the form has to as well — a guard that refused it
    // would be its own defect, in the other direction.
    await typeAndLeave(longest, '50')
    expect(text()).not.toContain('不能大于')
    expect(buttonNamed('预览分割结果').disabled).toBe(false)
    expect(buttonNamed('导入').disabled).toBe(false)
  })

  it('refuses a blank box, which is the same rule one field up', async () => {
    await mountView()

    const longest = numberBox('单条弹幕最长长度')
    await typeAndLeave(longest, '')

    // A cleared number box is `null`, and the route's own `lengthOption` requires an integer — so this is
    // the same window as 71–100 was: a form state the server answers with a 400. The refs are annotated
    // `number`, which is why the guard reads them as `unknown`.
    expect(text()).toContain('两个长度都要填上')
    expect(buttonNamed('预览分割结果').disabled).toBe(true)
    expect(buttonNamed('导入').disabled).toBe(true)

    // And the box the plain comparison would miss. `null` coerces to `0`, so a blank 最短长度 reads as
    // 「0, which is below the maximum」 to a `min <= max` test that trusted the refs' `number` annotation —
    // and the route refuses the blank that reached it.
    await typeAndLeave(longest, '20')
    await typeAndLeave(numberBox('最短长度'), '')
    expect(buttonNamed('导入').disabled).toBe(true)
  })
})
