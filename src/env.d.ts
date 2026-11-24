/// <reference types="vite/client" />

// Build settings the app reads (see vite.config.ts and src/lib/site.ts).
interface ImportMetaEnv {
  readonly VITE_PUBLIC_SITE?: string
}
