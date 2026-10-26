import type { HTMLAttributes, Ref } from 'react'

export type KbdProps = HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement> }

// A key or shortcut in running text ("Esc", "Ctrl+K").
export function Kbd({ className, ref, ...rest }: KbdProps) {
  return <kbd {...rest} ref={ref} className={className ? `ui-kbd ${className}` : 'ui-kbd'} />
}
