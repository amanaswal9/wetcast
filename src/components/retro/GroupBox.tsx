import { useId, type ReactNode } from 'react'

interface GroupBoxProps {
  title: ReactNode
  className?: string
  children: ReactNode
}

// Etched frame with its caption on the top edge. Renders a labelled section.
export function GroupBox({ title, className = '', children }: GroupBoxProps) {
  const id = useId()
  return (
    <section className={`r-group ${className}`} aria-labelledby={id}>
      <h2 id={id} className="r-group-title">
        {title}
      </h2>
      {children}
    </section>
  )
}
