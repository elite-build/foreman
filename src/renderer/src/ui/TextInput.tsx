import type { ComponentPropsWithRef } from 'react'
import { joinClass, useNameCheck, useOwnRef } from './Field'

export type TextInputType = 'text' | 'number' | 'date' | 'time' | 'search' | 'password'

export type TextInputProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'size' | 'width'> & {
  type?: TextInputType
  // Monospace text (paths, commands, ids).
  mono?: boolean
  // No border, background, padding or focus ring of its own: for an input inside a bordered bar that draws them
  // (the terminal find bar). The bar has to show focus, since the input no longer does.
  bare?: boolean
  // A smaller box and 12px text, for a rename field inside a tab or a list row.
  compact?: boolean
  // A fixed width for the box (number = px). Prefer `className` for layout; this is for the common one-off.
  width?: number | string
}

// A single-line input. Native events, refs and controlled values pass straight through, and the text-editing
// keys stay with the input. It needs a name: use it inside <Field>, with a <label htmlFor>, or give it aria-label.
export function TextInput({ type = 'text', mono, bare, compact, width, className, style, ref, ...rest }: TextInputProps) {
  const [own, setRef] = useOwnRef<HTMLInputElement>(ref)
  useNameCheck(own, 'TextInput')
  return (
    <input
      {...rest}
      ref={setRef}
      type={type}
      className={joinClass('ui-control', 'ui-input', mono && 'ui-input--mono', bare && 'ui-input--bare', compact && 'ui-input--compact', className)}
      style={width === undefined ? style : { width, ...style }}
    />
  )
}
