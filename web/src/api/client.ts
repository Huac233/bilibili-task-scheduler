import axios, { AxiosError, type AxiosInstance } from 'axios'

/**
 * HTTP client.
 *
 * The token lives in `localStorage` rather than a cookie: the backend issues a
 * signed bearer token, and keeping it out of cookies sidesteps CSRF entirely.
 * Requests go to the same origin (`/api/...`), which the Vite dev proxy and the
 * production static server both handle.
 */

const TOKEN_KEY = 'bts.token'

export function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    // Storage can throw in private-browsing modes; treat as logged out.
    return null
  }
}

export function writeToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Ignored: the session simply will not survive a reload.
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Ignored.
  }
}

/** Extracts a server-supplied error message, falling back to something useful. */
export function describeError(error: unknown): string {
  if (error instanceof AxiosError) {
    const body = error.response?.data
    if (typeof body === 'object' && body !== null) {
      const message = (body as { error?: unknown }).error
      if (typeof message === 'string' && message !== '') return message
    }
    if (error.code === 'ECONNABORTED') return '请求超时，请检查网络或稍后重试'
    if (error.response === undefined) return '无法连接到服务器'
    return `请求失败（HTTP ${String(error.response.status)}）`
  }
  if (error instanceof Error) return error.message
  return '发生未知错误'
}

/**
 * The HTTP status an error carries, or null when it carries none.
 *
 * Exposed so a view can tell "the server does not serve that route yet" (404,
 * 405) from a real refusal without importing axios — the rule this module exists
 * to keep. `null` means the request never got an answer, which is a third case
 * and must not be read as either.
 */
export function httpStatusOf(error: unknown): number | null {
  if (error instanceof AxiosError) return error.response?.status ?? null
  return null
}

/** Raised on a 401 so callers can distinguish "log in again" from other failures. */
export class UnauthorizedError extends Error {
  constructor() {
    super('登录已失效，请重新登录')
    this.name = 'UnauthorizedError'
  }
}

type UnauthorizedHandler = () => void

let onUnauthorized: UnauthorizedHandler | null = null

/** Registers the callback invoked when the server rejects the token. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler
}

export const http: AxiosInstance = axios.create({
  baseURL: '',
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' }
})

http.interceptors.request.use(config => {
  const token = readToken()
  if (token !== null) config.headers.Authorization = `Bearer ${token}`
  return config
})

http.interceptors.response.use(
  response => response,
  (error: unknown) => {
    if (error instanceof AxiosError && error.response?.status === 401) {
      clearToken()
      onUnauthorized?.()
      return Promise.reject(new UnauthorizedError())
    }
    return Promise.reject(error)
  }
)
