import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'

// Resolve the backend port the same way the backend does:
//   1. $OIR_BACKEND_PORT
//   2. the port the backend wrote to .backend-port (auto-selected free port)
//   3. 8765 (default)
function backendPort(): number {
  const env = process.env.OIR_BACKEND_PORT
  if (env) return Number(env)
  try {
    return Number(readFileSync(new URL('./.backend-port', import.meta.url), 'utf8').trim())
  } catch {
    return 8765
  }
}

const port = backendPort()

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${port}`,
    },
  },
})
