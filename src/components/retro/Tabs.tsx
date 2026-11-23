import { Tabs as TabsRoot, TabsContent, TabsList, TabsTrigger } from '@radix-ui/react-tabs'
import type { ComponentProps } from 'react'

// Classic tab control. Radix supplies arrow-key navigation and the
// tablist/tab/tabpanel roles; the look is ours.
export const Tabs = TabsRoot

// The row of tabs.
export function TabList({ className = '', ...props }: ComponentProps<typeof TabsList>) {
  return <TabsList className={`r-tablist ${className}`} {...props} />
}

// One tab button.
export function Tab({ className = '', ...props }: ComponentProps<typeof TabsTrigger>) {
  return <TabsTrigger className={`r-tab ${className}`} {...props} />
}

// The content shown under the selected tab.
export function TabPanel({ className = '', ...props }: ComponentProps<typeof TabsContent>) {
  return <TabsContent className={`r-tabpanel ${className}`} {...props} />
}
