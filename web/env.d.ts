/// <reference types="vite/client" />

/**
 * Ambient declarations for the web package.
 *
 * The `*.vue` shim lets TypeScript resolve single-file components from `.ts`
 * files before `vue-tsc` has a chance to describe them properly. Without it,
 * importing a component from a router module is an error.
 */

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

/** Vite env vars this app reads. Keep in sync with `.env.example`. */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
