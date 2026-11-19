import { weatherKind, type WeatherKind } from '../../lib/weatherCodes'

/**
 * 16×16 pixel-art weather icons, drawn as SVG so they stay sharp at any
 * size. "K" uses currentColor so outlines follow the theme's text colour.
 */
const PALETTE: Record<string, string> = {
  Y: '#ffd800',
  O: '#c86400',
  K: 'currentColor',
  W: '#ffffff',
  G: '#a0a0a0',
  D: '#606060',
  B: '#1060ff',
  C: '#40c0ff',
}

interface Layer {
  rows: string[]
  dx?: number
  dy?: number
}

const SUN = [
  '       OO       ',
  '       OO       ',
  '  O          O  ',
  '   O  YYYY  O   ',
  '     YYYYYY     ',
  '    YYYYYYYY    ',
  'OO  YYYYYYYY  OO',
  'OO  YYYYYYYY  OO',
  '    YYYYYYYY    ',
  '     YYYYYY     ',
  '   O  YYYY  O   ',
  '  O          O  ',
  '       OO       ',
  '       OO       ',
]

const MOON = [
  '',
  '',
  '     YYYYY      ',
  '   YYYY         ',
  '  YYY           ',
  '  YY            ',
  ' YYY            ',
  ' YYY            ',
  ' YYY            ',
  ' YYYY           ',
  '  YYYY        Y ',
  '   YYYYY    YY  ',
  '    YYYYYYYYY   ',
  '      YYYYY     ',
]

const CLOUD = [
  '',
  '',
  '',
  '',
  '',
  '      KKKK      ',
  '     KWWWWK     ',
  '  KKKWWWWWWKK   ',
  ' KWWWWWWWWWWWK  ',
  'KWWWWWWWWWWWWWK ',
  'KWWWWWWWWWWWWWWK',
  'KGGGGGGGGGGGGGGK',
  ' KKKKKKKKKKKKKK ',
]

const DARK_CLOUD = CLOUD.map((row) => row.replaceAll('G', 'D').replaceAll('W', 'G'))

const DROPS = ['   B    B    B  ', '  B    B    B   ', '', '     B    B     ', '    B    B      ']
const DRIZZLE = ['    B     B     ', '', '       B     B  ', '', '   B      B     ']
const FLAKES = ['   C      C     ', '  CCC    CCC    ', '   C      C     ', '       C        ', '      CCC       ']
const BOLT = ['        YY      ', '       YY       ', '      YYYYY     ', '        YY      ', '       YY       ', '      Y         ']
const FOG = ['', '', '', '', '  GGGGGGGGGGGG  ', '', '    GGGGGGGGGGGG', '', 'GGGGGGGGGGGG    ', '', '  GGGGGGGGGGGG  ', '', '    GGGGGGGGGG  ']

function layersFor(kind: WeatherKind, isDay: boolean): Layer[] {
  const sky = isDay ? SUN : MOON
  switch (kind) {
    case 'clear':
      return [{ rows: sky, dy: isDay ? 1 : 0 }]
    case 'partly':
      return [
        { rows: sky, dx: -3, dy: -3 },
        { rows: CLOUD, dx: 1, dy: 2 },
      ]
    case 'cloudy':
      return [{ rows: CLOUD, dy: 0 }]
    case 'fog':
      return [{ rows: FOG }]
    case 'drizzle':
      return [
        { rows: CLOUD, dy: -4 },
        { rows: DRIZZLE, dy: 10 },
      ]
    case 'rain':
      return [
        { rows: CLOUD, dy: -4 },
        { rows: DROPS, dy: 10 },
      ]
    case 'snow':
      return [
        { rows: CLOUD, dy: -4 },
        { rows: FLAKES, dy: 10 },
      ]
    case 'storm':
      return [
        { rows: DARK_CLOUD, dy: -5 },
        { rows: BOLT, dy: 9 },
      ]
    default:
      return [{ rows: CLOUD }]
  }
}

/** Merge horizontal runs of the same colour into one rect each. */
function toRects(layers: Layer[]) {
  const rects: { x: number; y: number; w: number; fill: string }[] = []
  for (const { rows, dx = 0, dy = 0 } of layers) {
    rows.forEach((row, y) => {
      let x = 0
      while (x < row.length) {
        const ch = row[x]
        if (ch === ' ' || !(ch in PALETTE)) {
          x++
          continue
        }
        let end = x + 1
        while (end < row.length && row[end] === ch) end++
        rects.push({ x: x + dx, y: y + dy, w: end - x, fill: PALETTE[ch] })
        x = end
      }
    })
  }
  return rects
}

interface PixelWeatherIconProps {
  code: number
  isDay?: boolean
  size?: number
  className?: string
}

export function PixelWeatherIcon({ code, isDay = true, size = 48, className = '' }: PixelWeatherIconProps) {
  const rects = toRects(layersFor(weatherKind(code), isDay))
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      className={className}
    >
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
      ))}
    </svg>
  )
}
