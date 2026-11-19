import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // During development the FastAPI backend runs on :8000; the browser only talks to Vite.
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  build: {
    rollupOptions: {
      output: {
        // Recharts is the heaviest dependency; keep it in its own cacheable chunk.
        manualChunks: (id) => (id.includes('node_modules/recharts') || id.includes('node_modules/d3-') ? 'charts' : undefined),
      },
    },
  },
})
