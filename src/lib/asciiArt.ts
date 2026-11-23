import type { WeatherKind } from './weatherCodes'

// Hand-drawn ASCII scenes for the desktop behind the Wetcast window: one sky per kind of
// weather (a moon instead of the sun at night) above a small city skyline. Stars are drawn
// with "+" and "." so the art never uses asterisks.

const SUN = String.raw`
              \     |     /
          '.   \    |    /   .'
               .-'''''''-.
      ------  (           )  ------
               '-.._____.-'
          .'   /    |    \   '.
              /     |     \
`

const MOON = String.raw`
     +              _.._            .
           .      .'  .-'     +
     .           /   /
          +     |   |        .     +
                 \   \
        .         '.  '-.      .
                    '-..-'
`

const PARTLY_DAY = String.raw`
            \   |   /
         '.  .---.  .'
        --- (   .-~~~-.
         .'  '-(       )~~-.
              (              )
               '~-.______.-~'
`

const PARTLY_NIGHT = String.raw`
        +     _.._         .
            .'  .-'  .-~~~-.
     .     /   /  -(       )~~-.
           |   | (              )
        +   \   '-'~-.______.-~'
`

const CLOUDY = String.raw`
               .-~~~-.
         .-~~~(       )~~-.
        (                  )~-.
       (                       )
        '~-.________________.-~'
`

const RAIN = String.raw`
               .-~~~-.
         .-~~~(       )~~-.
        (                    )
         '~-.______________.-~'
          /   /   /   /   /
         /   /   /   /   /
        /   /   /   /   /
`

const DRIZZLE = String.raw`
               .-~~~-.
         .-~~~(       )~~-.
        (                    )
         '~-.______________.-~'
           '     '     '     '
              '     '     '
           '     '     '     '
`

const SNOW = String.raw`
               .-~~~-.
         .-~~~(       )~~-.
        (                    )
         '~-.______________.-~'
          +    .    +    .    +
             .    +    .    +
          +    .    +    .    +
`

const STORM = String.raw`
               .-~~~-.
         .-~~~(       )~~-.
        (                    )
         '~-.______  ______.-~'
          /   /   / /   /
               _/ /__
              /__  _/
                / /
               /,'
`

const FOG = String.raw`
        ~  ~  ~  ~  ~  ~  ~  ~  ~
      -  _  -  _  -  _  -  _  -  _
        ~  ~  ~  ~  ~  ~  ~  ~  ~
      -  _  -  _  -  _  -  _  -  _
        ~  ~  ~  ~  ~  ~  ~  ~  ~
`

// The city along the bottom of every scene.
export const SKYLINE = String.raw`
                 ___                          ____
      _____     |   |        ___     _____   |    |     ___
     |     |    | o |   ___ |   |   |     |  | o  |    |   |
  ___| o o |____|   |__|   ||   |___| o o |__|    |____| o |___
 |   |     |  o |   |  | o || o | o |     |  | o  |  o |   | o |
 |_o_|_o_o_|____|_o_|__|___||___|___|_o_o_|__|____|____|___|___|
==================================================================
`

function lines(art: string): string[] {
  // Drop the blank first and last lines that the template literals carry.
  return art.split('\n').slice(1, -1)
}

// The sky for a kind of weather, as lines of text.
export function skyFor(kind: WeatherKind, isDay: boolean): string[] {
  switch (kind) {
    case 'clear':
      return lines(isDay ? SUN : MOON)
    case 'partly':
      return lines(isDay ? PARTLY_DAY : PARTLY_NIGHT)
    case 'cloudy':
      return lines(CLOUDY)
    case 'fog':
      return lines(FOG)
    case 'drizzle':
      return lines(DRIZZLE)
    case 'rain':
      return lines(RAIN)
    case 'snow':
      return lines(SNOW)
    case 'storm':
      return lines(STORM)
    default:
      return lines(CLOUDY)
  }
}

export function skylineLines(): string[] {
  return lines(SKYLINE)
}

// Centre each line within a given width (the widest part of the scene).
// The drawings carry their own indentation, which is removed first.
export function centre(rows: string[], width: number): string[] {
  const filled = rows.filter((r) => r.trim())
  const indent = Math.min(...filled.map((r) => r.length - r.trimStart().length))
  const trimmed = rows.map((r) => r.slice(indent).trimEnd())
  const own = Math.max(...trimmed.map((r) => r.length))
  const pad = ' '.repeat(Math.max(0, Math.floor((width - own) / 2)))
  return trimmed.map((r) => (r ? pad + r : r))
}

// A box drawn with plain characters around some lines of text, padded to the widest line.
export function textBox(rows: string[]): string[] {
  const width = Math.max(...rows.map((r) => r.length)) + 4
  const edge = '-'.repeat(width)
  return [`.${edge}.`, ...rows.map((r) => `|  ${r.padEnd(width - 2)}|`), `'${edge}'`]
}
