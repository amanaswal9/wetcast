import L from 'leaflet'

// The map's location pin: a classic pixel arrow pointer whose tip sits exactly on the
// forecast point being shown. Drawn here pixel by pixel (B = outline, W = fill), so it
// stays sharp at any zoom and in both themes.
const ARROW = [
  'B',
  'BB',
  'BWB',
  'BWWB',
  'BWWWB',
  'BWWWWB',
  'BWWWWWB',
  'BWWWWWWB',
  'BWWWWWWWB',
  'BWWWWWWWWB',
  'BWWWWWWWWWB',
  'BWWWWWWBBBBB',
  'BWWWBWWB',
  'BWWB.BWWB',
  'BWB..BWWB',
  'BB....BWWB',
  'B.....BWWB',
  '.......BWWB',
  '.......BBB',
]

const WIDTH = 12
const HEIGHT = ARROW.length
const SCALE = 2 // screen pixels per arrow pixel

function rects(char: string): string {
  let out = ''
  ARROW.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === char) out += `M${x} ${y}h1v1h-1z`
  })
  return out
}

const OUTLINE = rects('B')
const FILL = rects('W')

// The pointer pin; the high-contrast theme swaps outline and fill.
export function pointerIcon(theme: 'light' | 'dark'): L.DivIcon {
  const [outline, fill] = theme === 'dark' ? ['#ffffff', '#000000'] : ['#000000', '#ffffff']
  const w = WIDTH * SCALE
  const h = HEIGHT * SCALE
  // A one-pixel offset shadow, as cursors had, so the arrow stands out over coloured squares.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w + SCALE}" height="${h + SCALE}" viewBox="0 0 ${WIDTH + 1} ${HEIGHT + 1}" shape-rendering="crispEdges" aria-hidden="true">` +
    `<path transform="translate(1 1)" d="${OUTLINE}${FILL}" fill="rgba(0,0,0,0.35)"/>` +
    `<path d="${FILL}" fill="${fill}"/><path d="${OUTLINE}" fill="${outline}"/></svg>`
  return L.divIcon({
    html: svg,
    className: 'r-map-pointer',
    iconSize: [w + SCALE, h + SCALE],
    iconAnchor: [0, 0], // the arrow's tip is its top-left pixel
  })
}
