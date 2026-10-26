import { useRef, useState, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { giveFocusBack, Menu, usePlaced } from './Menu'

export type ContextMenuProps = {
  // Where the pointer was (client coordinates).
  x: number
  y: number
  // The menu's accessible name.
  label: string
  // Called after every close: Escape, activating an item, Tab, a click elsewhere, window blur or resize.
  onClose: () => void
  // Layout only (a minimum width).
  className?: string
  children: ReactNode
  ref?: Ref<HTMLDivElement>
}

// A menu at the pointer (right-click, or the menu key). Render it while it is open, like the old TerminalMenu. It is
// drawn in <body> so a clipping or isolating panel can't hide it, and kept on screen. Focus goes into the menu, and
// Escape or activating an item returns it to the element that had it when the menu opened; Tab lets focus move on.
export function ContextMenu({ x, y, label, onClose, className, children, ref }: ContextMenuProps) {
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null))
  const local = useRef<HTMLDivElement | null>(null)
  const at = usePlaced(local, () => ({ left: x, top: y }))
  return createPortal(
    <Menu
      ref={(node) => {
        local.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      label={label}
      className={className ? `ui-menu--fixed ui-menu--context ${className}` : 'ui-menu--fixed ui-menu--context'}
      style={{ left: at.left, top: at.top }}
      closeOnViewportChange
      onContextMenu={(e) => e.preventDefault()}
      onClose={(reason) => {
        giveFocusBack(reason, opener)
        onClose()
      }}
    >
      {children}
    </Menu>,
    document.body
  )
}
