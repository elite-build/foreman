import type { ComponentPropsWithRef } from 'react'
import { joinClass, useNameCheck, useOwnRef } from './Field'

export type TextAreaProps = Omit<ComponentPropsWithRef<'textarea'>, 'width'> & {
  // Monospace text (scripts, prompts, config).
  mono?: boolean
  // No border, background, padding or focus ring of its own: for a textarea inside a box that draws them (the composer).
  // The box has to show focus, since the textarea no longer does.
  bare?: boolean
}

// A multi-line input, vertically resizable. Same pass-through and naming rules as TextInput.
export function TextArea({ mono, bare, className, ref, rows = 3, ...rest }: TextAreaProps) {
  const [own, setRef] = useOwnRef<HTMLTextAreaElement>(ref)
  useNameCheck(own, 'TextArea')
  return <textarea {...rest} ref={setRef} rows={rows} className={joinClass('ui-control', 'ui-textarea', mono && 'ui-textarea--mono', bare && 'ui-textarea--bare', className)} />
}
