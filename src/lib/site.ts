// Where this copy of Wetcast runs. The public copy on Codeberg Pages is built with VITE_PUBLIC_SITE set
// to its address (see vite.config.ts). It has no Wetcast server behind it, so it shows the live weather
// from Open-Meteo, and says plainly that the rest runs on the full setup.

export const PUBLIC_SITE: string | undefined = import.meta.env.VITE_PUBLIC_SITE || undefined

// True when a Wetcast server (the FastAPI backend) is there to ask.
export const HAS_SERVER = !PUBLIC_SITE

export const NO_SERVER_MESSAGE =
  "This public copy of Wetcast has no server, so Wetcast's own models, official warnings, saved places and Javed aren't here. They run on the full setup described in the README."

// A file from public/ or a page of the app, with the site's base path in front:
// sitePath('favicon.svg') is "/favicon.svg" locally and "/wetcast/favicon.svg" on the public copy.
export function sitePath(path: string): string {
  return import.meta.env.BASE_URL + path
}
