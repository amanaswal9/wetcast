import type { ReactNode } from 'react'

type Kind = 'error' | 'info' | 'warning'

const ICONS: Record<Kind, ReactNode> = {
  error: (
    <>
      <circle cx="16" cy="16" r="14" fill="#ff0000" stroke="#800000" strokeWidth="2" />
      <path d="M10 10l12 12M22 10L10 22" stroke="#ffffff" strokeWidth="3.5" />
    </>
  ),
  info: (
    <>
      <circle cx="16" cy="16" r="14" fill="#ffffff" stroke="#000080" strokeWidth="2" />
      <rect x="14" y="7" width="4" height="4" fill="#000080" />
      <rect x="14" y="13" width="4" height="12" fill="#000080" />
    </>
  ),
  warning: (
    <>
      <path d="M16 2L31 29H1z" fill="#ffff00" stroke="#000000" strokeWidth="2" />
      <rect x="14" y="11" width="4" height="10" fill="#000000" />
      <rect x="14" y="23" width="4" height="3" fill="#000000" />
    </>
  ),
}

interface MessageBoxProps {
  kind: Kind
  title: string
  children: ReactNode
  actions?: ReactNode
  /** Use "alert" for errors that appear after an action. */
  role?: 'alert' | 'status'
}

/** Inline version of the classic message box: icon, text, buttons. */
export function MessageBox({ kind, title, children, actions, role }: MessageBoxProps) {
  return (
    <div role={role} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-start">
      <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
        {ICONS[kind]}
      </svg>
      <div className="min-w-0 flex-1">
        <p className="m-0 mb-1 font-bold">{title}</p>
        <div className="max-w-[60ch]">{children}</div>
        {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  )
}
