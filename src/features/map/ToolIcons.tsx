import type { MapLayer } from '../../lib/mapScales'

// 16 x 16 pixel tool icons for the map's layer palette, drawn here in the spirit of a classic
// paint program's toolbox. B = outline (follows the text colour, so it works in high
// contrast), W = white, R = red, N = navy, C = light blue.
const ICONS: Record<MapLayer, string[]> = {
  temperature: [
    '......BBB.......',
    '.....BWWWB......',
    '.....BWWWB.BB...',
    '.....BWWWB......',
    '.....BWRWB.BB...',
    '.....BWRWB......',
    '.....BWRWB.BB...',
    '.....BWRWB......',
    '.....BWRWB.BB...',
    '....BWRRRWB.....',
    '...BWRRRRRWB....',
    '...BRRRRRRRB....',
    '...BRRWRRRRB....',
    '...BRRRRRRRB....',
    '....BRRRRRB.....',
    '.....BBBBB......',
  ],
  rain: [
    '................',
    '......BB........',
    '.....BNNB.......',
    '.....BNNB.......',
    '....BNCNNB......',
    '....BNCNNB......',
    '...BNCNNNNB.....',
    '...BNCNNNNB.....',
    '...BNNNNNNB.....',
    '...BNNNNNNB.....',
    '....BNNNNB......',
    '.....BBBB.......',
    '..........BB....',
    '.........BNNB...',
    '.........BCNB...',
    '..........BB....',
  ],
  wind: [
    '................',
    '..........BBB...',
    '.........B...B..',
    '.............B..',
    'BBBBBBBBBBBBBB..',
    '................',
    '........BBB.....',
    '.......B...B....',
    '...........B....',
    'BBBBBBBBBBB.....',
    '................',
    'BBBBBBBBBB......',
    '..........B.....',
    '......B...B.....',
    '.......BBB......',
    '................',
  ],
}

const COLORS: Record<string, string> = { B: 'currentColor', W: '#ffffff', R: '#ff0000', N: '#000080', C: '#4aa3ff' }

// Draws one toolbox icon from its character grid, one SVG path per colour.
export function ToolIcon({ layer, size = 32 }: { layer: MapLayer; size?: number }) {
  const paths: Record<string, string> = {}
  ICONS[layer].forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x]
      if (c !== '.') paths[c] = (paths[c] ?? '') + `M${x} ${y}h1v1h-1z`
    }
  })
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
      {Object.entries(paths).map(([c, d]) => (
        <path key={c} d={d} fill={COLORS[c]} />
      ))}
    </svg>
  )
}
