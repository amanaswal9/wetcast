// Writes dist/_headers for the public copy on Codeberg Pages, from the same security headers the
// self-hosted setup sends (deploy/security-headers.conf), so the two can't drift apart.
// Run after the build: node scripts/pages-headers.mjs https://wetcast.codeberg.page/wetcast/
import { readFileSync, writeFileSync } from 'node:fs'

// The headers Codeberg Pages lets a site set (docs.codeberg.org/codeberg-pages/advanced-usage/).
// The others in the nginx file are either sent by Codeberg itself or can't be set there.
const ALLOWED = ['Content-Security-Policy', 'Permissions-Policy', 'Referrer-Policy', 'X-Frame-Options']

const site = process.argv[2]
if (!site) {
  console.error('Give the site address, e.g. node scripts/pages-headers.mjs https://wetcast.codeberg.page/wetcast/')
  process.exit(1)
}
const path = new URL(site).pathname.replace(/\/?$/, '/')

const conf = readFileSync('deploy/security-headers.conf', 'utf8')
const headers = [...conf.matchAll(/^add_header\s+(\S+)\s+"([^"]*)"/gm)].map(([, name, value]) => [name, value])
const kept = headers.filter(([name]) => ALLOWED.includes(name))
const missing = ALLOWED.filter((name) => !kept.some(([n]) => n === name))
if (missing.length) {
  console.error(`deploy/security-headers.conf has no ${missing.join(', ')}; the public copy needs them.`)
  process.exit(1)
}

const lines = [`${path}*`, ...kept.map(([name, value]) => `  ${name}: ${value}`)]
writeFileSync('dist/_headers', lines.join('\n') + '\n')
console.log(`dist/_headers: ${kept.length} headers for ${path}*`)
