/// <reference types="vite/client" />

// Build settings the app reads (see vite.config.ts and src/lib/site.ts).
interface ImportMetaEnv {
  readonly VITE_PUBLIC_SITE?: string
  // "1" when the public copy carries the exported forecast files (scripts/export_public_data.py).
  readonly VITE_PUBLIC_DATA?: string
}
