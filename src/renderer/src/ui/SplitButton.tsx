import { ChevronDown } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { MenuButton, type MenuPlacement } from './Menu'

export type SplitButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role' | 'children'> & {
  // The primary action's content.
  label: ReactNode
  // Names the menu and the arrow button ("More ways to open"). Required: the arrow has no text.
  menuLabel: string
  // The menu's items (MenuItem and friends).
  children: ReactNode
  variant?: 'default' | 'primary' | 'ghost'
  size?: 'sm' | 'md'
  placement?: MenuPlacement
  portal?: boolean
  // Disables the arrow. Unset, it follows the primary button's `disabled`; set, it wins either way, so
  // `menuDisabled={false}` keeps the menu usable while the primary action is off.
  menuDisabled?: boolean
  // Controlled menu, for code that opens it (the primary action with no default to run).
  menuOpen?: boolean
  onMenuOpenChange?: (open: boolean) => void
  // Layout classes for the pair.
  className?: string
  // The primary button.
  ref?: Ref<HTMLButtonElement>
}

// A primary action joined to a menu of related ones. Two real buttons side by side, so each has its own Tab stop,
// name and target; props other than the ones above go to the primary button. Uses the Button look
// (ui-btn classes), so its CSS comes from there.
export function SplitButton({ label, menuLabel, children, variant = 'default', size = 'md', placement, portal, menuDisabled, menuOpen, onMenuOpenChange, className, ref, ...rest }: SplitButtonProps) {
  const look = variant === 'default' ? 'button' : variant
  const cls = ['ui-btn', variant !== 'default' && `ui-btn--${variant}`, size === 'sm' && 'ui-btn--sm'].filter(Boolean).join(' ')
  return (
    <span className={className ? `ui-split ${className}` : 'ui-split'} data-variant={variant}>
      <button {...rest} ref={ref} type="button" className={cls}>
        {label}
      </button>
      <MenuButton className="ui-split__menu" look={look} small={size === 'sm'} iconOnly label={menuLabel} placement={placement} portal={portal} disabled={menuDisabled ?? rest.disabled} open={menuOpen} onOpenChange={onMenuOpenChange} trigger={<ChevronDown size={12} aria-hidden="true" />}>
        {children}
      </MenuButton>
    </span>
  )
}
