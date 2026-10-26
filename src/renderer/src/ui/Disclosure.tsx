import { ChevronRight } from 'lucide-react'
import { useId, useState, type HTMLAttributes, type ReactNode, type Ref } from 'react'

export type DisclosureProps = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onToggle'> & {
  // The button's content: what the section is called.
  label: ReactNode
  // The revealed content.
  children: ReactNode
  // Controlled; omit both for an uncontrolled one.
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  // A lighter, link-like button for a note ("How variables are loaded").
  quiet?: boolean
  ref?: Ref<HTMLDivElement>
}

// A button that shows or hides a panel: aria-expanded and aria-controls on the button, a chevron that turns
// (not when Reduce Motion is on). The panel stays mounted while closed, hidden, so aria-controls always points at it.
export function Disclosure({ label, children, open: openProp, defaultOpen = false, onOpenChange, quiet, className, ref, ...rest }: DisclosureProps) {
  const [inner, setInner] = useState(defaultOpen)
  const open = openProp ?? inner
  const panelId = useId()
  const toggle = () => {
    if (openProp === undefined) setInner(!open)
    onOpenChange?.(!open)
  }
  return (
    <div {...rest} ref={ref} className={className ? `ui-disclosure ${className}` : 'ui-disclosure'}>
      <button type="button" className={quiet ? 'ui-disclosure__button ui-disclosure__button--quiet' : 'ui-disclosure__button'} aria-expanded={open} aria-controls={panelId} onClick={toggle}>
        <ChevronRight className="ui-disclosure__chevron" size={14} aria-hidden="true" />
        {label}
      </button>
      <div className="ui-disclosure__panel" id={panelId} hidden={!open}>
        {children}
      </div>
    </div>
  )
}
