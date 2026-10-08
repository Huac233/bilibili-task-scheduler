import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import App from '../src/App.vue'

/**
 * The app-level palette, and the two ways it can be wired wrong in silence.
 *
 * `App.vue` publishes the row roles the panel and the parameter form read. Neither a missing role nor
 * a role read from the wrong theme is visible in any of the component suites, because a stylesheet
 * that reads an unset custom property simply draws the inherited colour — and two of the ways to get
 * there look exactly like the right thing:
 *
 *  - **A theme read outside the provider.** With no `NConfigProvider` above it, `useThemeVars()`
 *    answers with the library's own light defaults (`naive-ui/es/composables/use-theme-vars.mjs`),
 *    and `App.vue`'s setup runs *before* the provider its template renders. Six of the seven roles
 *    are the same either way, so the one that betrays the mistake is `--row-radius`: this app
 *    overrides `borderRadiusSmall` to `6px` and the library's default is `2px`. That is why the
 *    expectation below is a written literal rather than a second call to `useThemeVars()` — a value
 *    read the same way the implementation reads it could not disagree with it.
 *  - **A palette that stops at the root element.** The panel and the form read these names from their
 *    own stylesheets, so the second test resolves one through a page rendered under the provider:
 *    the names being *on* `<html>` is not the same fact as a page being able to *use* them, and only
 *    the second is what the hoist was for.
 *
 * Both are red before `App.vue` published anything: with no publisher, the root element carries no
 * `--row-*` at all and a page's `var()` resolves to nothing.
 */

/**
 * The palette's values, read out of the theme rather than out of the app: `naive-ui`'s light `common`
 * variables (`es/_styles/common/light.mjs`, the six colours) plus the one override `App.vue` sets
 * (`themeOverrides.common.borderRadiusSmall`). The accent this app brands Naive UI with is not one of
 * the seven, which is why none of them move when it changes.
 */
const PALETTE: Readonly<Record<string, string>> = {
  '--row-title': 'rgb(31, 34, 37)',
  '--row-body': 'rgb(51, 54, 57)',
  '--row-quiet': 'rgb(118, 124, 130)',
  '--row-line': 'rgb(224, 224, 230)',
  '--row-surface': 'rgb(250, 250, 252)',
  '--row-danger': '#d03050',
  '--row-radius': '6px'
}

/** The role the second test resolves from a page, and the value it must resolve to. */
const PROBED_ROLE = '--row-quiet'

/** The page the stub route renders: one element for a stylesheet to be pointed at. */
const PAGE_CLASS = 'theme-token-probe'

const PROBE_PAGE = {
  name: 'ThemeTokenProbe',
  render: () => h('div', { class: PAGE_CLASS })
}

/** The rule a page under the provider would carry in its own `<style scoped>` block. */
const PAGE_STYLE = `.${PAGE_CLASS} { color: var(${PROBED_ROLE}); }`

let hosts: HTMLElement[] = []
let apps: VueApp<Element>[] = []
let injected: HTMLStyleElement[] = []

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await nextTick()
}

/**
 * Mounts the real root component, the way `main.ts` does.
 *
 * The router is a two-line stub rather than the app's own: this file is about the palette, and the
 * real router's guard would answer a session read this fixture has no opinion about.
 */
async function mountApp(): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: PROBE_PAGE }]
  })
  await router.push('/')
  await router.isReady()

  const app = createApp(App)
  app.use(router)
  apps.push(app)
  app.mount(host)
  await settle()
}

/** Publishes a page's own stylesheet, so a `var()` in it is a real declaration and not a string. */
function injectPageStyle(): void {
  const style = document.createElement('style')
  style.textContent = PAGE_STYLE
  document.head.append(style)
  injected.push(style)
}

function pageElement(): HTMLElement {
  const page = document.querySelector<HTMLElement>(`.${PAGE_CLASS}`)
  if (page === null) throw new Error('the probe page was not rendered')
  return page
}

afterEach(() => {
  for (const app of apps) app.unmount()
  apps = []
  for (const host of hosts) host.remove()
  hosts = []
  for (const style of injected) style.remove()
  injected = []
})

describe('the row palette App publishes', () => {
  it('lands all seven roles on the root element, read through the theme this app configures', async () => {
    await mountApp()

    const root = document.documentElement.style
    for (const [name, value] of Object.entries(PALETTE)) {
      expect(root.getPropertyValue(name), name).toBe(value)
    }
  })

  it('is usable from a page below it, not merely present on the root element', async () => {
    injectPageStyle()
    await mountApp()

    // The page carries the rule; the value resolves from the palette above it. An unset role would
    // leave this empty rather than wrong-looking, which is exactly why it is asserted here.
    expect(getComputedStyle(pageElement()).color).toBe(PALETTE[PROBED_ROLE])
  })
})
