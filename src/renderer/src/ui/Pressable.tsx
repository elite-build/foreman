import { useCallback, useEffect, useRef } from 'react'
import type { ButtonHTMLAttributes, Ref } from 'react'

export type PressableProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role'> & {
  ref?: Ref<HTMLButtonElement>
}

// Anything focusable or clickable in its own right; none of it may sit inside a button.
const INTERACTIVE =
  'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"],' +
  ' [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"],' +
  ' [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="combobox"], [role="textbox"], [role="slider"]'

// The first interactive descendant of `root`, if any. Exported for the test.
export function findInteractiveDescendant(root: Element): Element | null {
  return root.querySelector(INTERACTIVE)
}

// An unstyled button for a surface with one action: a card, a row's main area, a list entry. It brings the
// focus ring and nothing else; its look belongs to the caller's layout classes and the content inside.
// Content must be non-interactive: a control nested in a button is invalid HTML and can't be reached
// by a screen reader. For a row with extra actions use ActionRow, which keeps them as siblings.
export function Pressable({ className, ref, ...rest }: PressableProps) {
  const own = useRef<HTMLButtonElement | null>(null)
  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      own.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    },
    [ref]
  )
  useEffect(() => {
    if (!import.meta.env.DEV || !own.current) return
    const bad = findInteractiveDescendant(own.current)
    if (bad) throw new Error(`Pressable must not contain interactive content (found <${bad.tagName.toLowerCase()}>). Use ActionRow to put actions beside a primary action.`)
  })
  return <button {...rest} role={undefined} ref={setRef} type="button" className={className ? `ui-pressable ${className}` : 'ui-pressable'} />
}
