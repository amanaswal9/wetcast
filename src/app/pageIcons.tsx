import { CalendarDays, ChartLine, Cpu, Info, LayoutDashboard, Map, MapPin, MessageSquare, type LucideIcon } from 'lucide-react'
import type { PageId } from './pages'

/** One icon per page, used by the Start menu and the phone taskbar's quick-launch buttons. */
export const PAGE_ICONS: Record<PageId, LucideIcon> = {
  dashboard: LayoutDashboard,
  forecast: CalendarDays,
  map: Map,
  assistant: MessageSquare,
  analytics: ChartLine,
  models: Cpu,
  locations: MapPin,
  about: Info,
}

/** Pages on the phone taskbar, one tap away (everything else is in the Start menu). */
export const QUICK_LAUNCH: PageId[] = ['dashboard', 'forecast', 'map']
