import * as RadixTabs from '@radix-ui/react-tabs'
import type { ComponentProps } from 'react'

/**
 * Classic tab control. Radix supplies arrow-key navigation and the
 * tablist/tab/tabpanel roles; the look is ours.
 */
export const Tabs = RadixTabs.Root

export function TabList({ className = '', ...props }: ComponentProps<typeof RadixTabs.List>) {
  return <RadixTabs.List className={`r-tablist ${className}`} {...props} />
}

export function Tab({ className = '', ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  return <RadixTabs.Trigger className={`r-tab ${className}`} {...props} />
}

export function TabPanel({ className = '', ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={`r-tabpanel ${className}`} {...props} />
}
