import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

import { setUnauthorizedHandler } from '../api/client.js'
import { useAuthStore } from '../stores/auth.js'

/**
 * Routing.
 *
 * Hash history is deliberate: the app is served as static files by the backend,
 * and hash routing means a deep link never needs a server-side rewrite rule.
 *
 * The guard does the real work — a stored token is not proof of a live session,
 * so the first navigation resolves the user against `/api/auth/me` and only then
 * decides. Without that, a stale token shows the dashboard for one render before
 * every request 401s.
 */

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: async () => import('../views/LoginView.vue'),
    meta: { public: true }
  },
  {
    path: '/',
    component: async () => import('../views/AppShell.vue'),
    children: [
      { path: '', name: 'dashboard', component: async () => import('../views/DashboardView.vue') },
      { path: 'accounts', name: 'accounts', component: async () => import('../views/AccountsView.vue') },
      {
        path: 'actions',
        name: 'action-settings',
        component: async () => import('../views/ActionSettingsView.vue')
      },
      {
        path: 'replacements',
        name: 'replacements',
        component: async () => import('../views/ReplacementsView.vue')
      },
      {
        path: 'integrations',
        name: 'integrations',
        component: async () => import('../views/IntegrationsView.vue')
      },
      { path: 'libraries', name: 'libraries', component: async () => import('../views/LibrariesView.vue') },
      {
        path: 'libraries/import',
        name: 'library-import',
        component: async () => import('../views/ImportView.vue')
      },
      {
        path: 'libraries/:id',
        name: 'library-detail',
        component: async () => import('../views/LibraryDetailView.vue')
      },
      { path: 'tasks', name: 'tasks', component: async () => import('../views/TasksView.vue') },
      { path: 'tasks/create', name: 'task-create', component: async () => import('../views/TaskCreateView.vue') },
      { path: 'tasks/:id', name: 'task-detail', component: async () => import('../views/TaskDetailView.vue') }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes
})

let resolvedSession = false

router.beforeEach(async to => {
  const auth = useAuthStore()

  if (to.meta['public'] === true) {
    return true
  }

  if (!auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  // Resolve the session once per page load; later navigations reuse the result.
  if (!resolvedSession) {
    resolvedSession = true
    const ok = await auth.fetchMe()
    if (!ok) return { name: 'login', query: { redirect: to.fullPath } }
  }

  return true
})

// Any 401 from any request drops the session and bounces to the login screen.
setUnauthorizedHandler(() => {
  resolvedSession = false
  const auth = useAuthStore()
  auth.logout()
  if (router.currentRoute.value.name !== 'login') {
    void router.replace({ name: 'login' })
  }
})
