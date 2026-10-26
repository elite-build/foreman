import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role' | 'aria-label' | 'aria-pressed' | 'title' | 'children'> & {
  // The accessible name, also the tooltip. Required: an icon says nothing to a screen reader.
  label: string
  // The icon (decorative; the name comes from `label`).
  children: ReactNode
  // For a toggle (find options, wrap lines): sets aria-pressed and the highlighted look.
  pressed?: boolean
  // primary: a round filled button for the one action of a bar (send). framed: a bordered square that shows the current
  // value and opens its picker (the repository icon). dashed: a dashed placeholder tile that adds something (solid
  // while its menu is open). badge: a small round button with its own edge and
  // a cut-out ring, for a control that sits over the corner of another surface (remove a card). Everything else is the
  // default bare icon.
  variant?: 'default' | 'primary' | 'framed' | 'dashed' | 'badge'
  // danger: a destructive action (delete): it goes red on hover and keyboard focus.
  tone?: 'default' | 'danger'
  ref?: Ref<HTMLButtonElement>
}

export function IconButton({ label, pressed, variant = 'default', tone = 'default', className, children, ref, ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      role={undefined}
      ref={ref}
      type="button"
      className={['ui-icon-btn', variant === 'primary' && 'ui-icon-btn--primary', variant === 'framed' && 'ui-icon-btn--framed', variant === 'dashed' && 'ui-icon-btn--dashed', variant === 'badge' && 'ui-icon-btn--badge', tone === 'danger' && 'ui-icon-btn--danger', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
    >
      <span className="ui-icon-btn__icon" aria-hidden="true">{children}</span>
    </button>
  )
}
