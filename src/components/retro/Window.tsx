import type { ReactNode } from 'react'

interface WindowProps {
  title: string
  icon?: ReactNode
  /** Title-bar buttons (minimise, maximise, close), rendered on the right. */
  controls?: ReactNode
  inactive?: boolean
  headingLevel?: 1 | 2
  className?: string
  children: ReactNode
}

export function Window({ title, icon, controls, inactive, headingLevel = 2, className = '', children }: WindowProps) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2'
  return (
    <section className={`r-window flex min-w-0 flex-col ${className}`}>
      <div className="r-title" data-inactive={inactive ? 'true' : undefined}>
        {icon && (
          <span aria-hidden="true" className="flex shrink-0">
            {icon}
          </span>
        )}
        <Heading className="m-0 min-w-0 flex-1 truncate text-[inherit] font-bold">{title}</Heading>
        {controls && <div className="flex shrink-0 gap-0.5">{controls}</div>}
      </div>
      {children}
    </section>
  )
}

type Glyph = 'minimize' | 'maximize' | 'restore' | 'close'

const GLYPHS: Record<Glyph, ReactNode> = {
  minimize: <rect x="2" y="7" width="6" height="2" />,
  maximize: (
    <>
      <rect x="1" y="0" width="9" height="2" />
      <rect x="1" y="2" width="1" height="7" />
      <rect x="9" y="2" width="1" height="7" />
      <rect x="1" y="8" width="9" height="1" />
    </>
  ),
  restore: (
    <>
      <rect x="3" y="0" width="6" height="2" />
      <rect x="8" y="2" width="1" height="4" />
      <rect x="1" y="3" width="6" height="2" />
      <rect x="1" y="5" width="1" height="4" />
      <rect x="6" y="5" width="1" height="4" />
      <rect x="1" y="8" width="6" height="1" />
    </>
  ),
  close: (
    <path d="M1 1h2v1h1v1h2V2h1V1h2v1H8v1H7v1H6v1h1v1h1v1h1v1H7V7H6V6H4v1H3v1H1V7h1V6h1V5h1V4H3V3H2V2H1z" />
  ),
}

interface TitleButtonProps {
  glyph: Glyph
  label: string
  onClick: () => void
  className?: string
}

export function TitleButton({ glyph, label, onClick, className = '' }: TitleButtonProps) {
  return (
    <button type="button" className={`r-btn r-title-btn ${className}`} aria-label={label} title={label} onClick={onClick}>
      <svg width="10" height="9" viewBox="0 0 10 9" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
        {GLYPHS[glyph]}
      </svg>
    </button>
  )
}
