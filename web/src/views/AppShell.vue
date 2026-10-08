<script setup lang="ts">
import type { MenuOption } from 'naive-ui'
import { NButton, NDrawer, NLayout, NLayoutContent, NLayoutSider, NMenu, NSpace, NText } from 'naive-ui'
import { computed, h, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import AppFooter from '../components/AppFooter.vue'
import { useAuthStore } from '../stores/auth.js'

/**
 * Authenticated shell.
 *
 * Two layouts rather than one responsive one: a 220px sidebar works on a
 * desktop and destroys a phone, where the content column would be a sliver.
 * Below 768px the nav moves into a drawer behind a hamburger, and the content
 * gets the full width.
 *
 * Nav targets are real `RouterLink`s so middle-click and "open in new tab"
 * work, which a click handler would break.
 *
 * Breakpoint detection uses `matchMedia`, not a resize listener: it fires only
 * when the condition flips rather than on every pixel of a window drag.
 */
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const NARROW_QUERY = '(max-width: 767px)'

const isNarrow = ref(false)
const drawerOpen = ref(false)

let media: MediaQueryList | null = null

function syncNarrow(event: MediaQueryList | MediaQueryListEvent): void {
  isNarrow.value = event.matches
}

onMounted(() => {
  media = window.matchMedia(NARROW_QUERY)
  syncNarrow(media)
  media.addEventListener('change', syncNarrow)
})

onUnmounted(() => {
  media?.removeEventListener('change', syncNarrow)
})

function navLink(to: string, label: string): () => ReturnType<typeof h> {
  return () => h(RouterLink, { to }, { default: () => label })
}

const NAV: { key: string; to: string; label: string }[] = [
  { key: 'dashboard', to: '/', label: '总览' },
  { key: 'accounts', to: '/accounts', label: '账号' },
  { key: 'actions', to: '/actions', label: '动作开关' },
  { key: 'libraries', to: '/libraries', label: '文本库' },
  { key: 'replacements', to: '/replacements', label: '替换规则' },
  { key: 'tasks', to: '/tasks', label: '任务' },
  { key: 'integrations', to: '/integrations', label: '外部集成' }
]

const menuOptions = computed<MenuOption[]>(() =>
  NAV.map(item => ({ key: item.key, label: navLink(item.to, item.label) }))
)

/** Maps the current route onto the menu key so the active item stays correct. */
const activeKey = computed<string>(() => {
  const name = route.name
  if (name === 'accounts') return 'accounts'
  if (name === 'action-settings') return 'actions'
  if (name === 'replacements') return 'replacements'
  if (name === 'integrations') return 'integrations'
  if (name === 'libraries' || name === 'library-import' || name === 'library-detail') return 'libraries'
  if (name === 'tasks' || name === 'task-detail' || name === 'task-create') return 'tasks'
  return 'dashboard'
})

/**
 * Title shown in the mobile header, so the current section is still visible.
 *
 * The fallback names no section on purpose, and it is unreachable today:
 * `activeKey` only ever returns a key `NAV` holds, so the lookup always hits. That
 * is not a reason to drop it — it is what the header shows on the day a route is
 * mapped in `activeKey` before its `NAV` entry is added, which is exactly when a
 * blank title would be least welcome. Deleting it would turn that mistake into a
 * header with nothing in it.
 */
const currentLabel = computed<string>(() => NAV.find(item => item.key === activeKey.value)?.label ?? '任务调度')

async function signOut(): Promise<void> {
  auth.logout()
  await router.replace({ name: 'login' })
}
</script>

<template>
  <!-- Wide: persistent sidebar -->
  <NLayout v-if="!isNarrow" has-sider position="absolute">
    <NLayoutSider bordered :width="220" :collapsed-width="64" collapse-mode="width" show-trigger>
      <div class="brand">
        <img class="logo" src="/favicon.png" alt="" />
        <NText strong>任务调度</NText>
      </div>
      <NMenu :options="menuOptions" :value="activeKey" />
    </NLayoutSider>

    <!--
      Half of the sticky footer; the other half is `.shell-main`. `content-style`
      lands on Naive UI's scroll container — the box this layout actually scrolls
      in — so that box is the flex column: `.shell-main` grows inside it, the
      footer sits at the bottom, and the content area still owns the whole box
      and still scrolls as before.
    -->
    <NLayoutContent content-style="padding: 24px; height: 100%; overflow: auto; display: flex; flex-direction: column;">
      <div class="topbar">
        <NSpace align="center" :size="12">
          <NText depth="3">{{ auth.user?.username ?? '—' }}</NText>
          <NButton size="small" quaternary @click="signOut">退出登录</NButton>
        </NSpace>
      </div>

      <div class="shell-main">
        <RouterView />
      </div>
      <AppFooter />
    </NLayoutContent>
  </NLayout>

  <!-- Narrow: header plus a drawer, full-width content -->
  <div v-else class="mobile">
    <header class="mobile-bar">
      <NButton quaternary circle aria-label="打开菜单" @click="drawerOpen = true">☰</NButton>
      <span class="mobile-title">{{ currentLabel }}</span>
      <NButton quaternary size="small" @click="signOut">退出</NButton>
    </header>

    <main class="mobile-content">
      <div class="shell-main">
        <RouterView />
      </div>
      <AppFooter />
    </main>

    <NDrawer v-model:show="drawerOpen" placement="left" :width="250">
      <div class="brand">
        <img class="logo" src="/favicon.png" alt="" />
        <NText strong>任务调度</NText>
      </div>
      <NMenu
        :options="menuOptions"
        :value="activeKey"
        @update:value="drawerOpen = false"
      />
      <div class="drawer-user">
        <NText depth="3">{{ auth.user?.username ?? '—' }}</NText>
      </div>
    </NDrawer>
  </div>
</template>

<style scoped>
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 20px 12px;
}

.logo {
  width: 22px;
  height: 22px;
  border-radius: 5px;
}

.topbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 16px;
}

/*
 * Sticky footer — the same mechanism in both layouts, deliberately spelled twice.
 *
 * Each layout makes its own scroll container a flex column (Naive UI's content
 * column via `content-style` above, `.mobile-content` below) and lets this
 * element grow into the height left over. That is what 「置底」 means here: on a
 * page shorter than the screen the leftover height goes to this element and the
 * footer lands at the bottom of the box — the viewport less the container's own
 * padding (24px here, 12px plus the safe area on mobile), which is where the last
 * line of a page belongs anyway; on a longer page there is no leftover,
 * `flex-shrink: 0` keeps this element at its content height, and the footer
 * simply follows the content, one scroll away.
 *
 * Both halves are load-bearing: the column is what gives this element height to
 * grow into, and `flex-shrink: 0` is what holds it at its content height on a
 * long page, so the overflow goes to the scroll container instead of squashing
 * the content and stranding the footer mid-screen. It is deliberately not
 * `position: fixed` or `sticky` on the footer itself — a permanently floating
 * bar covers the content and reserves height on every page, which is the one
 * thing this must not do.
 */
.shell-main {
  flex: 1 0 auto;
}

/* --- narrow layout ------------------------------------------------- */

/*
 * `100dvh` instead of `100vh`: mobile browsers shrink the viewport when the
 * URL bar is showing, and `vh` makes the bottom of the page unreachable.
 */
.mobile {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  background: #f7f8fa;
}

.mobile-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: #fff;
  border-bottom: 1px solid #eef0f3;
  /* Keeps the header off the notch, and the content clear of the home bar. */
  padding-top: calc(8px + env(safe-area-inset-top));
}

.mobile-title {
  font-weight: 600;
  font-size: 15px;
}

.mobile-content {
  /*
   * The narrow half of the sticky footer — a flex column whose content grows,
   * exactly as in the wide layout, but on this element rather than on a Naive UI
   * scroll container. Two containers, one mechanism: see `.shell-main`.
   */
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 12px;
  padding-bottom: calc(12px + env(safe-area-inset-bottom));
}

.drawer-user {
  padding: 16px 20px;
  border-top: 1px solid #eef0f3;
  margin-top: 8px;
}
</style>
