import { useEffect } from 'react'
import { getAlerts } from '../lib/api/weatherai'
import { notify, unseen, useAlertNotificationsEnabled } from '../lib/alertNotifications'
import type { Place } from '../types/weather'

const CHECK_MS = 10 * 60_000 // the server reads the official feed every 10 minutes

// While notifications are on, check the viewed place's official warnings every 10 minutes
// (whichever page is open) and notify about any not announced before.
export function useAlertNotifications(place: Place): void {
  const enabled = useAlertNotificationsEnabled()
  const { latitude, longitude, countryCode, name } = place

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const check = async () => {
      try {
        const result = await getAlerts(latitude, longitude, countryCode, controller.signal)
        const fresh = unseen(result.alerts)
        if (fresh.length > 0) await notify(fresh, name)
      } catch {
        // Server unreachable or offline: try again at the next check.
      }
    }
    void check()
    const timer = window.setInterval(check, CHECK_MS)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [enabled, latitude, longitude, countryCode, name])
}
