import type { ComponentPropsWithRef } from 'react'
import { joinClass, useNameCheck, useOwnRef } from './Field'

export type RangeProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'size' | 'width'> & {
  // How a screen reader says the value ("14px", "40%"); without it, the bare number is read.
  valueText?: string
}

// A slider. Arrow keys, Home, End and Page keys are the browser's. Needs a name, like every input.
export function Range({ valueText, className, ref, ...rest }: RangeProps) {
  const [own, setRef] = useOwnRef<HTMLInputElement>(ref)
  useNameCheck(own, 'Range')
  return <input aria-valuetext={valueText} {...rest} ref={setRef} type="range" className={joinClass('ui-range', className)} />
}
