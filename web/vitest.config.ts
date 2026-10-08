import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

/**
 * The web form has no DOM in Node, so the loop that reproduces a form-state bug
 * needs one: `happy-dom` plus the real components, mounted exactly as the app
 * mounts them. Everything else follows `vite.config.ts`.
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts']
  }
})
