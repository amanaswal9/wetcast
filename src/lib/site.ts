// Where this copy of Wetcast runs. The public copy on GitHub Pages is built with VITE_PUBLIC_SITE set
// to its address (see vite.config.ts). It has no Wetcast server behind it. Built with VITE_PUBLIC_DATA=1
// as well, it reads files a scheduled job writes every 3 hours (backend/scripts/export_public_data.py):
// the models' latest forecast for each of their cities, and their test scores. The rest says plainly
// that it runs on the full setup.

export const PUBLIC_SITE: string | undefined = import.meta.env.VITE_PUBLIC_SITE || undefined

// True when a Wetcast server (the FastAPI backend) is there to ask.
export const HAS_SERVER = !PUBLIC_SITE

// True on a public copy that carries the exported forecast files.
export const HAS_PUBLIC_DATA = !HAS_SERVER && import.meta.env.VITE_PUBLIC_DATA === '1'

export const NO_SERVER_MESSAGE = HAS_PUBLIC_DATA
  ? "This public copy shows Wetcast's own model forecasts for its 48 cities, updated every 3 hours. Official warnings, saved places, the live track record and Javed need the Wetcast server, so they run on the full setup described in the README."
  : "This public copy of Wetcast has no server, so Wetcast's own models, official warnings, saved places and Javed aren't here. They run on the full setup described in the README."

// A file from public/ or a page of the app, with the site's base path in front:
// sitePath('favicon.svg') is "/favicon.svg" locally and "/wetcast/favicon.svg" on the public copy.
export function sitePath(path: string): string {
  return import.meta.env.BASE_URL + path
}
