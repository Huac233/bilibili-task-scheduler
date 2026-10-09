import { compileStyle, parse } from '@vue/compiler-sfc'
import { NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import LoginView from '../src/views/LoginView.vue'
import loginSource from '../src/views/LoginView.vue?raw'

/**
 * The login page: the footer the owner asked to see on it, and the middle it never had.
 *
 * **What this file can and cannot observe.** Happy DOM has no layout engine: every
 * `getBoundingClientRect()` in it is zero and `window.innerHeight` is a fixed 768, so the *effect* of
 * a viewport unit cannot be measured from inside this repository's suite. What the environment does
 * do is resolve a stylesheet through the same cascade a browser uses — `getComputedStyle()` answers
 * with the declared value of `min-height`, `flex-*` and `align-items` — so the declarations that
 * decide whether the card can be centred at all are observable here, and `100%` against `100dvh` is
 * not a matter of taste: one of them resolves to nothing against an auto-height parent.
 *
 * Vitest loads components with `css: false`, so a component's `<style scoped>` block never reaches
 * the document. That is why this file compiles LoginView's own style block with `@vue/compiler-sfc`
 * and publishes it against the scope attribute the rendered component actually carries — read off
 * the DOM rather than written here, because a hash typed by hand is a second opinion about which
 * stylesheet belongs to this component.
 *
 * The geometry itself was measured in Chrome, outside this suite; nothing below claims a pixel.
 */

/**
 * The three sentences the footer carries, quoted from `AppFooter.vue`'s template. Its fourth line is
 * the repository link, which the test below asserts as an element with a href rather than as text.
 */
const FOOTER_LINES = [
  '不知不覺間，我開始滿心期待這朵花蕾在春天綻放。',
  '因為我從未想過，它盛開的模樣竟會那般醜陋。',
  '——少年的深淵'
] as const

const REPO_URL = 'https://github.com/Huac233/bilibili-task-scheduler'

/**
 * The theme's `borderColor`, which `AppFooter` paints its top border with through a `:style`
 * binding. A written literal rather than a second call to `useThemeVars()`, for the reason
 * `theme-tokens.test.ts` gives: a value read the way the implementation reads it cannot disagree
 * with it. It is also the one difference between the footer component and a copy of its text.
 */
const FOOTER_BORDER = 'rgb(224, 224, 230)'

let hosts: HTMLElement[] = []
let apps: VueApp<Element>[] = []
let injected: HTMLStyleElement[] = []

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await nextTick()
}

/**
 * Mounts the real view under the provider it needs, with a stub router.
 *
 * `LoginView` calls `useMessage()` and reads the query string, so it needs a `NMessageProvider` and
 * a router above it; the routes are stubs because nothing here submits a form.
 */
async function mountLogin(): Promise<{ host: HTMLElement }> {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', name: 'login', component: { render: () => null } },
      { path: '/', name: 'dashboard', component: { render: () => null } }
    ]
  })
  await router.push('/login')

  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(LoginView) }) })
  app.use(createPinia())
  app.use(router)
  apps.push(app)
  app.mount(host)
  await settle()
  return { host }
}

/** The component's root element — its single root is the page container the stylesheet describes. */
function pageRoot(host: HTMLElement): HTMLElement {
  const root = host.firstElementChild
  if (!(root instanceof HTMLElement)) throw new Error('LoginView rendered no root element')
  return root
}

/** Compiles the component's own `<style scoped>` block and publishes it for the rendered DOM. */
function publishStyles(host: HTMLElement): void {
  const scope = pageRoot(host)
    .getAttributeNames()
    .find(name => name.startsWith('data-v-'))
  if (scope === undefined) throw new Error('LoginView rendered no scope attribute to hang its stylesheet on')

  const block = parse(loginSource).descriptor.styles[0]
  if (block === undefined) throw new Error('LoginView has no <style> block')

  const compiled = compileStyle({
    source: block.content,
    filename: 'LoginView.vue',
    id: scope,
    scoped: block.scoped === true
  })
  if (compiled.errors.length > 0) {
    throw new Error(`LoginView's stylesheet did not compile: ${compiled.errors.map(String).join('; ')}`)
  }

  const style = document.createElement('style')
  style.textContent = compiled.code
  document.head.append(style)
  injected.push(style)
}

function footerOnPage(): HTMLElement {
  const footer = document.querySelector<HTMLElement>('footer.app-footer')
  if (footer === null) throw new Error('the login page rendered no footer')
  return footer
}

afterEach(() => {
  for (const app of apps) app.unmount()
  apps = []
  for (const host of hosts) host.remove()
  hosts = []
  for (const style of injected) style.remove()
  injected = []
})

describe('LoginView, the footer the owner asked to see on it', () => {
  it('mounts the application footer rather than reproducing its four lines', async () => {
    const { host } = await mountLogin()
    publishStyles(host)

    // One footer, and it is the shell's own element: `AppShell` mounts the same component, so the
    // two cannot drift into two footers that say slightly different things.
    expect(document.querySelectorAll('footer.app-footer').length).toBe(1)
    const footer = footerOnPage()

    for (const line of FOOTER_LINES) {
      expect(footer.textContent).toContain(line)
    }

    const link = footer.querySelector('a')
    expect(link?.getAttribute('href')).toBe(REPO_URL)
    expect(link?.textContent?.trim()).toBe('bilibili-task-scheduler')

    // `AppFooter`'s own setup colours it from the live Naive theme through a `:style` binding, and a
    // copy of its markup renders without these two properties — that is the one difference between
    // the component and its text which the DOM can show at all.
    const inline = footer.getAttribute('style') ?? ''
    expect(inline).toContain('border-top-color')
    expect(inline).toContain(FOOTER_BORDER)
  })
})

describe('LoginView, a container with a height for the card to be centred in', () => {
  it('floors the page at the viewport unit which follows a phone address bar', async () => {
    const { host } = await mountLogin()
    publishStyles(host)

    const page = pageRoot(host)

    // `min-height: 100%` was inert here, and that inertness was the owner's complaint: measured in
    // Chrome, `.page` came out 406.8px tall inside an 865px viewport — a percentage against Naive
    // UI's auto-height `.n-config-provider`, which resolves to nothing — and the card sat at the top
    // with 458px of empty viewport below it.
    expect(getComputedStyle(page).minHeight).toBe('100dvh')
    // A floor, not a box: a height of its own is what lets a centred card start above the scroll
    // origin, where no amount of scrolling reaches it.
    expect(getComputedStyle(page).height).not.toContain('dvh')
  })

  it('counts the page padding inside that floor, so the footer is not pushed under the fold', async () => {
    const { host } = await mountLogin()
    publishStyles(host)

    const page = pageRoot(host)

    // Measured in Chrome with the floor in place but the padding outside it: `min-height` floors the
    // *content* box, so `.page` came out 913px tall in an 865px viewport, the document scrolled by
    // 48px, and the footer's last line — the repository link — sat below the bottom edge at rest.
    expect(getComputedStyle(page).boxSizing).toBe('border-box')
  })

  it('grows the space around the card, and puts the footer after it', async () => {
    const { host } = await mountLogin()
    publishStyles(host)

    const page = pageRoot(host)
    const card = page.querySelector('.n-card')
    if (card === null) throw new Error('the login card was not rendered')
    const holder = card.parentElement
    if (holder === null) throw new Error('the login card has no parent element')

    // The card sits in its own growing element rather than directly in the page: the page is a
    // column with a footer at its end, and the element between them is what absorbs the height the
    // card does not use — the shell's own recipe for its footer.
    expect(holder).not.toBe(page)
    expect(getComputedStyle(page).flexDirection).toBe('column')
    expect(getComputedStyle(holder).flexGrow).toBe('1')
    expect(getComputedStyle(holder).alignItems).toBe('center')

    // What makes a card taller than the viewport grow the page instead of being squeezed inside it,
    // which is the short-screen and on-screen-keyboard case.
    expect(getComputedStyle(holder).flexShrink).toBe('0')

    // Nothing on this path clips: a clipped box is what would put the card's top out of reach.
    expect(getComputedStyle(page).overflow).not.toBe('hidden')
    expect(getComputedStyle(holder).overflow).not.toBe('hidden')

    // Top and bottom anchors: the card in the middle, the footer last, one scroll container.
    expect(page.lastElementChild).toBe(footerOnPage())
    expect(holder.contains(footerOnPage())).toBe(false)
  })
})
