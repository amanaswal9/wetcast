import type { Theme } from '../hooks/useTheme'

/**
 * The SVG charts take colours as attributes (also used in legend swatches),
 * so chart colours are mirrored here per theme rather than read from CSS.
 *
 * Series encoding used across WeatherAI:
 *  - past hours (Open-Meteo model estimate): solid line
 *  - Open-Meteo forecast: dashed line
 *  - WeatherAI model prediction (later stage): navy/yellow with dithered band
 */
export interface ChartColors {
  text: string
  axis: string
  grid: string
  past: string
  forecast: string
  model: string
  barPast: string
  barForecast: string
}

export const CHART_COLORS: Record<Theme, ChartColors> = {
  light: {
    text: '#000000',
    axis: '#808080',
    grid: '#dcdcdc',
    past: '#000000',
    forecast: '#006400',
    model: '#000080',
    barPast: '#a0a0a0',
    barForecast: '#008080',
  },
  dark: {
    text: '#ffffff',
    axis: '#c0c0c0',
    grid: '#333333',
    past: '#ffffff',
    forecast: '#00ff00',
    model: '#ffff00',
    barPast: '#808080',
    barForecast: '#00ffff',
  },
}

/**
 * One colour and one dash pattern per compared city, so lines stay
 * distinguishable without relying on colour alone.
 */
export const CITY_COLORS: Record<Theme, string[]> = {
  light: ['#000080', '#800000', '#006400', '#800080'],
  dark: ['#00ffff', '#ffff00', '#00ff00', '#ff80ff'],
}

export const CITY_DASHES = ['', '7 4', '2 3', '10 3 2 3']

/** WeatherAI model colours: one per architecture, reused on every page. */
export const MODEL_COLORS: Record<Theme, Record<string, string>> = {
  light: { lstm: '#000080', gru: '#800080', cnn_lstm: '#800000', lightgbm: '#7a5200', transformer: '#007070', ensemble: '#006400', baseline: '#808080' },
  dark: { lstm: '#ffff00', gru: '#ff80ff', cnn_lstm: '#00ffff', lightgbm: '#ffb040', transformer: '#ff6b6b', ensemble: '#80ff80', baseline: '#c0c0c0' },
}

export const CHART_FONT = "Tahoma, 'MS Sans Serif', Verdana, sans-serif"
