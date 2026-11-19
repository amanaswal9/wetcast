/**
 * Tiny logger: verbose in development, errors only in production builds.
 * Swap the sink here later (for example to a backend endpoint) without
 * touching call sites.
 */
const dev = import.meta.env.DEV

export const log = {
  debug: (...args: unknown[]) => {
    if (dev) console.debug('[weatherai]', ...args)
  },
  warn: (...args: unknown[]) => {
    if (dev) console.warn('[weatherai]', ...args)
  },
  error: (...args: unknown[]) => {
    console.error('[weatherai]', ...args)
  },
}
