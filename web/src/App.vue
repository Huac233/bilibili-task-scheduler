<script setup lang="ts">
import type { GlobalThemeOverrides } from 'naive-ui'
import { dateZhCN, NConfigProvider, NDialogProvider, NMessageProvider, zhCN } from 'naive-ui'

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
</script>

<template>
  <NConfigProvider :locale="zhCN" :date-locale="dateZhCN" :theme-overrides="themeOverrides">
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
