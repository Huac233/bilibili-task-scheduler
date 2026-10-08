import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { clearToken, readToken, writeToken } from '../api/client.js'
import { authApi } from '../api/endpoints.js'
import type { User } from '../types/api.js'

/**
 * Session state.
 *
 * The token is the source of truth for "am I logged in"; the user object is
 * fetched lazily and cleared on logout. `isAuthenticated` is derived rather than
 * stored so the two can never disagree.
 */
export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(readToken())
  const user = ref<User | null>(null)
  const loading = ref(false)

  const isAuthenticated = computed(() => token.value !== null)

  function applySession(nextToken: string, nextUser: User): void {
    token.value = nextToken
    user.value = nextUser
    writeToken(nextToken)
  }

  async function login(username: string, password: string): Promise<void> {
    loading.value = true
    try {
      const result = await authApi.login(username, password)
      applySession(result.token, result.user)
    } finally {
      loading.value = false
    }
  }

  async function register(username: string, password: string): Promise<void> {
    loading.value = true
    try {
      const result = await authApi.register(username, password)
      applySession(result.token, result.user)
    } finally {
      loading.value = false
    }
  }

  /**
   * Refreshes the cached user from the server.
   *
   * Called by the router guard on a cold load: a stored token may have expired
   * while the tab was closed, and only the server can say.
   */
  async function fetchMe(): Promise<boolean> {
    if (token.value === null) return false
    try {
      user.value = await authApi.me()
      return true
    } catch {
      logout()
      return false
    }
  }

  function logout(): void {
    token.value = null
    user.value = null
    clearToken()
  }

  return { token, user, loading, isAuthenticated, login, register, fetchMe, logout }
})
