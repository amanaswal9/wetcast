import { useSyncExternalStore } from 'react'
import type { OfficialAlert } from './api/weatherai'

// Opt-in browser notifications for new official warnings at the place being viewed.
// They only work while Wetcast is open (a tab, even in the background, or the installed
// app): notifications for a closed app need a push server, i.e. hosting. Each warning is
// announced once; ids already announced are remembered in this browser.
const ENABLED_KEY = 'weatherai.alerts.notify'
const SEEN_KEY = 'weatherai.alerts.seen'
const MAX_SEEN = 300

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage blocked: the setting lasts until the page closes.
  }
}

// True when the browser can show system notifications at all.
export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

let enabled: boolean = notificationsSupported() && read<boolean>(ENABLED_KEY, false) && Notification.permission === 'granted'
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

// Whether warning notifications are on, kept in step across components.
export function useAlertNotificationsEnabled(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => enabled,
    () => false,
  )
}

export type EnableResult = 'on' | 'off' | 'unsupported' | 'blocked'

// Turn notifications on (asking the browser's permission if needed) or off. Call from a click.
// `current` fetches the warnings already in force; they are marked as known before checking
// starts, so switching on announces only warnings issued from then on.
export async function setAlertNotifications(on: boolean, current?: () => Promise<OfficialAlert[]>): Promise<EnableResult> {
  if (!on) {
    enabled = false
    write(ENABLED_KEY, false)
    emit()
    return 'off'
  }
  if (!notificationsSupported()) return 'unsupported'
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (permission !== 'granted') return 'blocked'
  try {
    if (current) markSeen(await current())
  } catch {
    // Couldn't reach the server: anything in force will be announced at the first check.
  }
  enabled = true
  write(ENABLED_KEY, true)
  emit()
  return 'on'
}

function alertKey(alert: OfficialAlert): string {
  return alert.id ?? `${alert.event}|${alert.onset}|${alert.area}`
}

// Mark these warnings as already known. Used when notifications are first switched on (the
// Dashboard already shows what is in force) and after each notification.
export function markSeen(alerts: OfficialAlert[]): void {
  const seen = read<string[]>(SEEN_KEY, [])
  const next = [...new Set([...seen, ...alerts.map(alertKey)])].slice(-MAX_SEEN)
  write(SEEN_KEY, next)
}

// Warnings not announced before.
export function unseen(alerts: OfficialAlert[]): OfficialAlert[] {
  const seen = new Set(read<string[]>(SEEN_KEY, []))
  return alerts.filter((a) => !seen.has(alertKey(a)))
}

// Show one notification per warning; through the service worker where there is one (Android needs it).
export async function notify(alerts: OfficialAlert[], placeName: string): Promise<void> {
  for (const alert of alerts) {
    const title = `${alert.event ?? 'Official warning'} for ${placeName}`
    const options: NotificationOptions = {
      body: [alert.headline, alert.sender && `Issued by ${alert.sender}`].filter(Boolean).join('\n'),
      tag: alertKey(alert),
      icon: '/icons/icon-192.png',
    }
    try {
      const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
      if (registration) await registration.showNotification(title, options)
      else new Notification(title, options)
    } catch {
      // The browser refused (e.g. permission withdrawn): the warning is still on the Dashboard.
    }
  }
  markSeen(alerts)
}
