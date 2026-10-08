import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * Dev server proxies `/api` to the backend so the browser sees a single origin.
 * That keeps cookies and CORS out of the picture entirely in development, and
 * matches production where the backend serves the built assets itself.
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['VITE_PROXY_TARGET'] ?? 'http://127.0.0.1:8787',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Source maps make a deployed build debuggable without shipping much:
    // the app is small and the operator is also the developer here.
    sourcemap: false
  }
})
