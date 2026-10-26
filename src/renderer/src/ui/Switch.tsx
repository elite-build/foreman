import type { ComponentPropsWithRef } from 'react'
import { joinClass, useNameCheck, useOwnRef } from './Field'

export type SwitchProps = Omit<ComponentPropsWithRef<'button'>, 'type' | 'role' | 'onChange' | 'children' | 'aria-checked'> & {
  checked: boolean
  onChange: (checked: boolean) => void
  // The accessible name when no <label htmlFor> or aria-labelledby provides one.
  label?: string
}

// An on/off setting that takes effect at once: role="switch" on a button, Space and Enter toggle. The 24px target
// is the button; the 30x18 track is drawn inside it.
export function Switch({ checked, onChange, label, className, onClick, ref, ...rest }: SwitchProps) {
  const [own, setRef] = useOwnRef<HTMLButtonElement>(ref)
  useNameCheck(own, 'Switch')
  return (
    <button
      aria-label={label}
      {...rest}
      ref={setRef}
      type="button"
      role="switch"
      aria-checked={checked}
      className={joinClass('ui-switch', className)}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) onChange(!checked)
      }}
    >
      <span className="ui-switch__track" aria-hidden="true">
        <span className="ui-switch__knob" />
      </span>
    </button>
  )
}
