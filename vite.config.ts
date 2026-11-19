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
    // Minimum browsers, matching Tailwind CSS v4's requirements. index.html shows a
    // plain "please update" message on anything older instead of a blank page.
    target: ['chrome111', 'edge111', 'firefox128', 'safari16.4', 'ios16.4'],
    rollupOptions: {
      output: {
        // Recharts is the heaviest dependency; keep it in its own cacheable chunk.
        manualChunks: (id) => (id.includes('node_modules/recharts') || id.includes('node_modules/d3-') ? 'charts' : undefined),
      },
    },
  },
})
