import { useEffect, type ComponentPropsWithRef, type ReactNode } from 'react'
import { joinClass, useNameCheck, useOwnRef } from './Field'

export type CheckboxProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'size' | 'width' | 'children'> & {
  // The visible label. Clicking it toggles the box.
  children?: ReactNode
  // The mixed state of a "select all". Not an attribute: the browser only takes it as a property.
  indeterminate?: boolean
}

// A native checkbox with its label. `className` goes on the label row (layout); the input gets everything else.
// Without children, name it with aria-label or a Field.
export function Checkbox({ children, indeterminate, className, ref, ...rest }: CheckboxProps) {
  const [own, setRef] = useOwnRef<HTMLInputElement>(ref)
  useNameCheck(own, 'Checkbox')
  useEffect(() => {
    if (own.current) own.current.indeterminate = Boolean(indeterminate)
  }, [indeterminate, own])
  return (
    <label className={joinClass('ui-check', className)} data-disabled={rest.disabled ? '' : undefined}>
      <input {...rest} ref={setRef} type="checkbox" className="ui-check__input" />
      {children != null && <span className="ui-check__label">{children}</span>}
    </label>
  )
}
