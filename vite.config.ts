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
    // Pages are lazy-loaded (src/app/lazyPages.tsx), so the chart library ends up in a
    // shared chunk that only loads with the first page that draws a chart.
  },
})
