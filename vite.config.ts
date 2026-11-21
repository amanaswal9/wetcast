import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Installable app + instant repeat visits: the app's own files are cached by a service worker
    // (production builds only). Weather and model data are never served from this cache, so the app
    // can't show old data as if it were new; offline, it says it can't reach the weather service.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'WeatherAI',
        short_name: 'WeatherAI',
        description: 'Weather forecasts from WeatherAI’s own models, next to Open-Meteo, checked honestly.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#008080',
        theme_color: '#000080',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Long-press (or right-click) the installed app's icon to jump straight to a page.
        shortcuts: [
          { name: 'Forecast', short_name: 'Forecast', url: '/#/forecast', icons: [{ src: '/icons/shortcut-forecast.png', sizes: '96x96', type: 'image/png' }] },
          { name: 'Weather map', short_name: 'Map', url: '/#/map', icons: [{ src: '/icons/shortcut-map.png', sizes: '96x96', type: 'image/png' }] },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Fonts for alphabets the app doesn't show load on demand instead of being pre-cached.
        // The link-preview image is for other sites' crawlers, not the offline app.
        globIgnores: ['**/*-cyrillic-*', '**/*-vietnamese-*', '**/*-greek-*', 'og-image.png'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // The map's land outline (about 70 KB compressed) is kept once the map has been opened,
            // instead of being pre-cached for everyone.
            urlPattern: ({ url }) => url.pathname === '/map-outline.json',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'map-outline', expiration: { maxEntries: 2 } },
          },
          {
            // The base map doesn't change from day to day: keep a month of tiles (about 20 KB each, so
            // up to about 30 MB), so places looked at before open without waiting for the tile server.
            urlPattern: ({ url }) => url.hostname === 'tile.openstreetmap.org',
            handler: 'CacheFirst',
            options: {
              cacheName: 'osm-tiles',
              expiration: { maxEntries: 1500, maxAgeSeconds: 30 * 24 * 3600, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    // During development the FastAPI backend runs on :8000; the browser only talks to Vite.
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  build: {
    // Minimum browsers, matching Tailwind CSS v4's requirements. index.html shows a
    // plain "please update" message on anything older instead of a blank page.
    target: ['chrome111', 'edge111', 'firefox128', 'safari16.4', 'ios16.4'],
  },
})
