import './index.css'
import { getForecast } from './lib/api/openMeteo'
import { log } from './lib/log'
import { readPlace } from './lib/openingPlace'

// This first file is kept small (no React) so it runs quickly and asks for the opening place's
// forecast straight away, while the rest of the app is still downloading. The app's own request
// joins this one when it starts, so the forecast is fetched once and arrives sooner.
const place = readPlace()
getForecast(place).catch((e: unknown) => log.debug('early forecast failed', e))

// The first date or number formatter loads the browser's locale data, a noticeable pause on a phone.
// Do that now, while the page is waiting on the network, not when the weather arrives.
setTimeout(() => {
  new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(0)
  new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(0)
  new Intl.NumberFormat().format(0)
}, 0)

import('./start').catch((e: unknown) => log.error('Wetcast could not start', e))
