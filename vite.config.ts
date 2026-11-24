import tailwindcss from '@tailwindcss/vite'
import preact from '@preact/preset-vite'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// src/main.tsx asks for the weather first and then loads the rest of the app (src/start.tsx) with
// import(). Without help the browser would only find out about that code once main has run, so this
// lists it in index.html as well, and it downloads at the same time as main and the weather.
function preloadApp(): Plugin {
  let base = '/'
  return {
    name: 'wetcast-preload-app',
    apply: 'build',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle || !ctx.filename.endsWith('index.html') || ctx.filename.includes('mini')) return
        const chunks = Object.values(ctx.bundle).filter((c) => c.type === 'chunk')
        const start = chunks.find((c) => c.facadeModuleId?.endsWith('/src/start.tsx'))
        if (!start) throw new Error('preloadApp: src/start.tsx is not in the build')
        const files = new Set<string>()
        const add = (file: string) => {
          if (files.has(file)) return
          files.add(file)
          const chunk = chunks.find((c) => c.fileName === file)
          chunk?.imports.forEach(add)
        }
        add(start.fileName)
        return [...files]
          .filter((f) => !html.includes(`/${f}"`))
          .map((f) => ({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: base + f }, injectTo: 'head' as const }))
      },
    },
  }
}

// The open-source code and fonts the built site includes keep their copyright notices: their
// licences (MIT, ISC, BSD, OFL) ask for that wherever they are passed on, and minifying strips the
// comments that carried them. This writes third-party-licences.txt next to index.html, with every
// package's licence text; the About page links to it. A package without one stops the build.
function thirdPartyLicences(): Plugin {
  // Brought in through CSS @import (fonts, Tailwind's base styles) or written into the service
  // worker by vite-plugin-pwa (Workbox, the registration script), so the JavaScript module list
  // doesn't show them. Vite adds its own small loader to every page.
  const ALSO_SHIPPED = [
    '@fontsource/noto-sans',
    '@fontsource/noto-sans-mono',
    '@fontsource/pixelify-sans',
    '@fontsource/vt323',
    'tailwindcss',
    'workbox-cacheable-response',
    'workbox-core',
    'workbox-expiration',
    'workbox-precaching',
    'workbox-routing',
    'workbox-strategies',
    'vite-plugin-pwa',
    'vite',
  ]
  const root = resolve(import.meta.dirname, 'node_modules')

  // "node_modules/@radix-ui/react-tabs/dist/index.mjs" -> "@radix-ui/react-tabs"
  const packageOf = (id: string) => {
    const m = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id)
    return m ? m[1].replace(/\\/g, '/') : null
  }

  return {
    name: 'wetcast-third-party-licences',
    apply: 'build',
    generateBundle(_options, bundle) {
      const names = new Set(ALSO_SHIPPED)
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue
        for (const id of file.moduleIds) {
          const name = packageOf(id)
          if (name) names.add(name)
        }
      }
      const parts = [...names].sort().map((name) => {
        const dir = resolve(root, name)
        const meta = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { version: string; license?: string }
        const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f))
        if (!file) throw new Error(`thirdPartyLicences: ${name} has no licence file to pass on`)
        const text = readFileSync(resolve(dir, file), 'utf8').trim()
        return `${name} ${meta.version} (${meta.license ?? 'see below'})\n\n${text}`
      })
      const intro = [
        'Wetcast is free software under the GNU AGPL 3.0 or later. The built site also includes the open-source',
        'code and fonts listed below, each under its own licence, reproduced here as those licences ask.',
      ].join('\n')
      const rule = `\n\n${'-'.repeat(78)}\n\n`
      this.emitFile({ type: 'asset', fileName: 'third-party-licences.txt', source: intro + rule + parts.join(rule) + '\n' })
    },
  }
}

// The public copy on Codeberg Pages is built with its address in VITE_PUBLIC_SITE, for example
// https://amanaswal9.codeberg.page/wetcast/ (see .forgejo/workflows/ci.yml). Its path becomes the base
// for every file, and its full address goes into the link preview. Left unset, the app is built to
// live at the root of its own server, as before.
const publicSite = process.env.VITE_PUBLIC_SITE ? new URL(process.env.VITE_PUBLIC_SITE) : null
const base = publicSite ? publicSite.pathname.replace(/\/?$/, '/') : '/'

// Link previews need the image's full address, which only the public copy knows.
function previewImage(): Plugin {
  return {
    name: 'wetcast-preview-image',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!publicSite) return html
        const image = new URL('og-image.png', publicSite).href
        return html.replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${image}$2`)
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    // Preact runs the app: the same components and hooks as React through preact/compat, in a
    // fraction of the download (about 10 KB instead of about 68 KB before the first screen).
    // Imports of react and react-dom, ours and the libraries', are pointed at it.
    preact({ prerender: { enabled: false } }),
    preloadApp(),
    previewImage(),
    thirdPartyLicences(),
    tailwindcss(),
    // Installable app + instant repeat visits: the app's own files are cached by a service worker
    // (production builds only). Weather and model data are never served from this cache, so the app
    // can't show old data as if it were new; offline, it says it can't reach the weather service.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Wetcast',
        short_name: 'Wetcast',
        description: 'Weather forecasts from Wetcast’s own models, next to Open-Meteo, checked honestly.',
        lang: 'en',
        // Relative to the manifest, so they work wherever the site lives.
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#008080',
        theme_color: '#000080',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Long-press (or right-click) the installed app's icon to jump straight to a page.
        shortcuts: [
          { name: 'Forecast', short_name: 'Forecast', url: './#/forecast', icons: [{ src: 'icons/shortcut-forecast.png', sizes: '96x96', type: 'image/png' }] },
          { name: 'Weather map', short_name: 'Map', url: './#/map', icons: [{ src: 'icons/shortcut-map.png', sizes: '96x96', type: 'image/png' }] },
        ],
      },
      workbox: {
        // Pre-cache the app shell. The build output is flat apart from these three folders, so each
        // folder is listed by name. A new folder under public/ needs adding here too.
        globPatterns: [
          '*.{js,css,html,svg,png,woff2}',
          'assets/*.{js,css,html,svg,png,woff2}',
          'art/*.{js,css,html,svg,png,woff2}',
          'icons/*.{js,css,html,svg,png,woff2}',
        ],
        // Only the latin font files are pre-cached (Noto Sans 400 and 700, Noto Sans Mono, Pixelify Sans,
        // VT323). Other subsets, such as accented letters beyond latin, load on demand when a page needs them.
        // The link-preview image is for other sites' crawlers, not the offline app.
        globIgnores: ['assets/*-latin-ext-*', 'assets/*-cyrillic-*', 'assets/*-vietnamese-*', 'assets/*-greek-*', 'og-image.png'],
        navigateFallback: `${base}index.html`,
        // Wetcast Mini has its own page, and text files (the third-party licences) are opened as they
        // are, so neither address may fall back to the main app.
        navigateFallbackDenylist: [/\/api\//, /\/mini\//, /\.txt$/],
        runtimeCaching: [
          {
            // Wetcast Mini's page: fresh when online, the last copy when offline. These checks are copied
            // into the service worker as they are, so they match the end of the path, whatever the base.
            urlPattern: ({ url }) => url.pathname.endsWith('/mini/') || url.pathname.endsWith('/mini/index.html'),
            handler: 'NetworkFirst',
            options: { cacheName: 'mini-page', expiration: { maxEntries: 2 } },
          },
          {
            // The map's land outline (about 70 KB compressed) is kept once the map has been opened,
            // instead of being pre-cached for everyone.
            urlPattern: ({ url }) => url.pathname.endsWith('/map-outline.json'),
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
    // Two pages: the app itself and Wetcast Mini, the small widget-style window.
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        mini: resolve(import.meta.dirname, 'mini/index.html'),
      },
    },
  },
})
