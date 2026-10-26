// Stand-ins for ui/ components that take class names, for the guard's rule 6 tests (what feature code passes to them).
import type { ReactNode } from 'react'

export function Pressable(props: { className?: string; children?: ReactNode }) {
  return <button type="button" className={props.className}>{props.children}</button>
}

export function ActionRow(props: { className?: string; primaryProps?: { className?: string }; children?: ReactNode }) {
  return <div className={props.className}>{props.children}</div>
}

export function Menu(props: { triggerClassName?: string; panelClassName?: string; children?: ReactNode }) {
  return <div className={props.panelClassName}>{props.children}</div>
}
