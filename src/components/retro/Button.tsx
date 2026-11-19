import type { ComponentProps, ReactNode } from 'react'

type ButtonProps = ComponentProps<'button'> & {
  icon?: ReactNode
}

/** Bevelled push button. Pressed state comes from :active or aria-pressed. */
export function Button({ className = '', icon, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={`r-btn ${className}`} {...rest}>
      {icon && (
        <span aria-hidden="true" className="flex">
          {icon}
        </span>
      )}
      {children !== undefined && <span>{children}</span>}
    </button>
  )
}
