// GitHub Pages can't send custom response headers, so this puts what a page can carry itself into the
// built pages' <head>: the Content-Security-Policy and the Referrer-Policy, taken from the same file the
// self-hosted setup sends them from (deploy/security-headers.conf), so the two can't drift apart.
// Browsers ignore frame-ancestors in a <meta> policy, and X-Frame-Options, Permissions-Policy and
// Cross-Origin-Opener-Policy only work as real headers, so those can't be set on GitHub Pages.
// Run after the build: node scripts/pages-meta.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const conf = readFileSync('deploy/security-headers.conf', 'utf8')
const header = (name) => {
  const m = new RegExp(`^add_header\\s+${name}\\s+"([^"]*)"`, 'm').exec(conf)
  if (!m) {
    console.error(`deploy/security-headers.conf has no ${name}; the public copy needs it.`)
    process.exit(1)
  }
  return m[1]
}

const csp = header('Content-Security-Policy')
  .split(';')
  .map((d) => d.trim())
  .filter((d) => d && !d.startsWith('frame-ancestors'))
  .join('; ')
const referrer = header('Referrer-Policy')
const tags = `<meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <meta name="referrer" content="${referrer}" />`

// Every built page: index.html at the top and one folder down (Wetcast Mini).
const pages = ['dist/index.html', ...readdirSync('dist', { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join('dist', e.name, 'index.html'))
  .filter((f) => { try { readFileSync(f); return true } catch { return false } })]

for (const page of pages) {
  const html = readFileSync(page, 'utf8')
  // Straight after the charset (which must stay first), before any script or style loads.
  const charset = /<meta charset="[^"]*"\s*\/?>/i.exec(html)
  if (!charset) {
    console.error(`${page} has no <meta charset>`)
    process.exit(1)
  }
  writeFileSync(page, html.replace(charset[0], `${charset[0]}\n    ${tags}`))
}
console.log(`security <meta> tags added to ${pages.join(', ')}`)
