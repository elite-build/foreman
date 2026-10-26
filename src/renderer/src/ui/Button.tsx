import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role'> & {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  // A leading icon. The label stays text; an icon-only action is an IconButton.
  icon?: ReactNode
  ref?: Ref<HTMLButtonElement>
}

export function Button({ variant = 'default', size = 'md', icon, className, children, ref, ...rest }: ButtonProps) {
  const cls = ['ui-btn', variant !== 'default' && `ui-btn--${variant}`, size === 'sm' && 'ui-btn--sm', className].filter(Boolean).join(' ')
  return (
    <button {...rest} role={undefined} ref={ref} type="button" className={cls}>
      {icon ? <span className="ui-btn__icon" aria-hidden="true">{icon}</span> : null}
      {children}
    </button>
  )
}
