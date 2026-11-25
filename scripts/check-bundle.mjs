// Bundle-size budget: run after `npm run build` (`npm run size`). Gzips every built file the
// way a server would send it and fails when the code needed before the Dashboard works, or
// all the code together, grows past its budget. Raising a budget is a deliberate decision:
// edit BUDGETS below in the same change that needs it, and say why.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

// Set on 2026-11-20 about 10% above what was measured then (98.9, 12.1, 181.4 and 48.6 KB).
const BUDGETS_KB = {
  // index.html's own scripts (entry + preloaded shared code) and styles: what the first screen waits for.
  firstLoadJs: 110,
  firstLoadCss: 14,
  // Every script, including pages loaded later.
  allJs: 200,
  // The largest single lazily loaded page (the Map, with Leaflet).
  largestLazyJs: 54,
}

const dist = 'dist'
const assets = join(dist, 'assets')
// Gzipped size of a file in kB.
const gz = (path) => gzipSync(readFileSync(path), { level: 9 }).length / 1024
const html = readFileSync(join(dist, 'index.html'), 'utf8')
const linked = new Set([...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map((m) => m[1]))

const files = readdirSync(assets).filter((f) => /\.(js|css)$/.test(f))
const rows = files.map((f) => ({ file: f, kb: gz(join(assets, f)), first: linked.has(f) }))
// Total kB of a list of rows.
const sum = (list) => list.reduce((s, r) => s + r.kb, 0)

const js = rows.filter((r) => r.file.endsWith('.js'))
const measured = {
  firstLoadJs: sum(js.filter((r) => r.first)),
  firstLoadCss: sum(rows.filter((r) => r.first && r.file.endsWith('.css'))),
  allJs: sum(js),
  largestLazyJs: Math.max(0, ...js.filter((r) => !r.first).map((r) => r.kb)),
}

let failed = false
console.log('Bundle size (gzip)        used / budget')
for (const [name, budget] of Object.entries(BUDGETS_KB)) {
  const used = measured[name]
  const over = used > budget
  failed ||= over
  console.log(`${over ? 'OVER' : ' ok '} ${name.padEnd(16)} ${used.toFixed(1).padStart(6)} / ${budget} KB`)
}
if (process.argv.includes('--verbose')) {
  for (const r of rows.sort((a, b) => b.kb - a.kb)) console.log(`     ${r.kb.toFixed(1).padStart(6)} KB ${r.first ? '(first load) ' : ''}${r.file}`)
}
if (failed) {
  console.error('\nA bundle budget was exceeded. Make the code smaller, or raise the budget in scripts/check-bundle.mjs and explain why.')
  process.exit(1)
}
