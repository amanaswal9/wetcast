import type { ReactNode } from 'react'
import { MessageBox } from './MessageBox'

interface ErrorStackProps {
  /** Title-bar text of every window in the stack. */
  caption: string
  kind?: 'error' | 'warning' | 'info'
  title: string
  children: ReactNode
  actions?: ReactNode
  /** Windows behind the front one (decoration only). */
  depth?: number
}

/**
 * The classic "it happened again, and again" cascade: a pile of identical message windows,
 * each a step down and to the right, with the real one in front. Used for failures and
 * not-found states. The windows behind are decoration, hidden from screen readers; they
 * pop in one after another unless reduced motion is on.
 */
// Each window steps down by more than a title bar's height, so every caption stays readable.
const STEP_X = 22
const STEP_Y = 26

export function ErrorStack({ caption, kind = 'error', title, children, actions, depth = 5 }: ErrorStackProps) {
  return (
    <div
      className="r-error-stack"
      style={{ paddingTop: depth * STEP_Y, paddingLeft: depth * STEP_X, ['--stack-inset' as string]: `${depth * STEP_X}px` }}
    >
      {Array.from({ length: depth }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="r-window r-error-stack-ghost"
          style={{ top: i * STEP_Y, left: i * STEP_X, animationDelay: `${i * 70}ms` }}
        >
          <div className="r-title">
            <span className="min-w-0 flex-1 truncate">{caption}</span>
            <span className="r-btn r-title-btn">
              <svg width="10" height="9" viewBox="0 0 10 9" fill="currentColor" shapeRendering="crispEdges">
                <path d="M1 0h2v1h1v1h2V1h1V0h2v1H8v1H7v1H6v1h1v1h1v1h1v1H7V7H6V6H4v1H3v1H1V7h1V6h1V5h1V4H3V3H2V2H1z" />
              </svg>
            </span>
          </div>
        </div>
      ))}
      <section
        role="alert"
        aria-label={caption}
        className="r-window r-error-stack-front"
        style={{ animationDelay: `${depth * 70}ms` }}
      >
        <div className="r-title">
          <span className="min-w-0 flex-1 truncate">{caption}</span>
        </div>
        <MessageBox kind={kind} title={title} actions={actions}>
          {children}
        </MessageBox>
      </section>
    </div>
  )
}
