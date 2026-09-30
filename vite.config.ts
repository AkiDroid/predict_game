import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))
const apiPort = process.env.API_PORT ?? '3001'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(root, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'backend/**/*.test.ts'],
  },
})
