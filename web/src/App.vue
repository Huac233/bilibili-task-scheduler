<script setup lang="ts">
import type { GlobalThemeOverrides } from 'naive-ui'
import { dateZhCN, NConfigProvider, NDialogProvider, NMessageProvider, useThemeVars, zhCN } from 'naive-ui'
import { defineComponent, watchEffect } from 'vue'

/**
 * Root component.
 *
 * The providers live here rather than per-view so `useMessage()` and
 * `useDialog()` work anywhere below — including the login view, which sits
 * outside the authenticated shell.
 */

/**
 * Naive UI defaults are legible but read as a form builder. These are the same
 * components with the accent colour this project already shipped, slightly
 * rounder corners, and a denser rhythm — no new dependency, no component
 * rewrites. The accent is a colour, not a fact about any Platform: nothing here
 * changes when the catalogue does.
 */
const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#00a1d6',
    primaryColorHover: '#00b5e5',
    primaryColorPressed: '#0088b8',
    primaryColorSuppl: '#00a1d6',
    borderRadius: '8px',
    borderRadiusSmall: '6px'
  },
  Card: {
    borderRadius: '10px'
  },
  Button: {
    borderRadiusMedium: '8px',
    borderRadiusSmall: '6px'
  },
  Tag: {
    borderRadius: '5px'
  }
}

/**
 * The row palette: the one place its seven names are declared.
 *
 * **Why it is declared here and not where the colours are drawn.** `ActionSettingsPanel.vue`'s
 * stylesheet and `ActionOptionForm.vue`'s both read these names, and the form is mounted from two
 * places — the panel, which had a `.panel` element to hang them on, and `TaskDetailView.vue`, which
 * has none. A declaration inside either component is a palette with two homes, and the day one is
 * reworded the same row is two greys. Declared once at the root, every page and every component below
 * inherits them, which is what the hoist was for.
 *
 * **Why a component rather than this file's own setup.** `useThemeVars()` reads the nearest
 * `NConfigProvider` by injection and answers with the library's own light defaults when there is none
 * above it — and this component's setup runs *before* the provider its template renders. Six of the
 * seven roles come out the same either way, so the mistake is silent; `--row-radius` is the one that
 * betrays it, because this app overrides `borderRadiusSmall` to 6px against a 2px default
 * (`web/tests/theme-tokens.test.ts` pins that difference). The reader below is a descendant of the
 * provider, so it publishes the theme this app configures.
 *
 * **Why the root element rather than a wrapper.** Custom properties are inherited, so `<html>` reaches
 * every element without a second node between `#app` and the shell — whose sticky footer is a flex
 * column, and where the height in that chain sits is load-bearing (see `AppShell.vue`).
 *
 * `AppFooter.vue` reads the theme directly, for one quote and its link. It declares no names at all,
 * so it is not a second home for these and is left as it is.
 */
const ThemeTokens = defineComponent({
  name: 'ThemeTokens',
  setup() {
    const vars = useThemeVars()

    watchEffect(() => {
      const root = document.documentElement.style
      root.setProperty('--row-title', vars.value.textColor1)
      root.setProperty('--row-body', vars.value.textColor2)
      root.setProperty('--row-quiet', vars.value.textColor3)
      root.setProperty('--row-line', vars.value.borderColor)
      root.setProperty('--row-surface', vars.value.actionColor)
      root.setProperty('--row-danger', vars.value.errorColor)
      root.setProperty('--row-radius', vars.value.borderRadiusSmall)
    })

    return () => null
  }
})
</script>

<template>
  <NConfigProvider :locale="zhCN" :date-locale="dateZhCN" :theme-overrides="themeOverrides">
    <ThemeTokens />
    <NMessageProvider>
      <NDialogProvider>
        <RouterView />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
}

body {
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  background: #f7f8fa;
  /* Prevents iOS from enlarging text when a phone is turned sideways. */
  -webkit-text-size-adjust: 100%;
}

/*
 * Narrow screens.
 *
 * Naive UI's default spacing is tuned for a desktop, where generous padding
 * reads as calm. On a phone the same padding leaves too little room for the
 * content itself, so it is tightened once here rather than page by page.
 *
 * The workspace rule matters most: Naive UI's `NSpace` never wraps, so rows of
 * statistics or buttons simply overflow off-screen instead of flowing onto a
 * second line.
 */
@media (max-width: 767px) {
  .n-card > .n-card-header {
    padding: 14px 14px 0;
  }

  .n-card > .n-card__content {
    padding: 14px;
  }

  .n-card > .n-card__footer {
    padding: 0 14px 14px;
  }

  .n-space.n-space--horizontal {
    flex-wrap: wrap;
  }

  /* Long identifiers must not push the page wider than the viewport. */
  .n-card,
  .n-descriptions-item__content {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /*
   * Several inputs carry inline pixel widths suited to a desktop form (a 420px
   * date range picker is the worst). On a phone those push the page wider than
   * the screen. An inline style outranks a stylesheet rule, so this is the one
   * place `!important` is warranted.
   */
  .n-input,
  .n-input-number,
  .n-date-picker,
  .n-select {
    max-width: 100% !important;
  }
}
</style>
