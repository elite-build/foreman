import type { ComponentPropsWithRef } from 'react'
import { joinClass, useNameCheck, useOwnRef } from './Field'

export type SelectOption<T extends string> = {
  value: T
  label: string
  // Options that share a group are put in an <optgroup>.
  group?: string
  disabled?: boolean
}

export type SelectProps<T extends string> = Omit<ComponentPropsWithRef<'select'>, 'value' | 'defaultValue' | 'onChange' | 'children' | 'multiple' | 'size'> & {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  // The accessible name when no Field or <label> provides one.
  label?: string
  // A fixed width (number = px).
  width?: number
}

// A native select: the browser draws the list, so it is keyboard- and screen-reader-complete. The same props as
// the settings Select it replaces.
export function Select<T extends string>({ value, options, onChange, label, width, className, style, ref, ...rest }: SelectProps<T>) {
  const [own, setRef] = useOwnRef<HTMLSelectElement>(ref)
  useNameCheck(own, 'Select')
  const groups: (string | undefined)[] = [...new Set(options.map((o) => o.group))]
  const render = (list: SelectOption<T>[]) =>
    list.map((o) => (
      <option key={o.value} value={o.value} disabled={o.disabled}>
        {o.label}
      </option>
    ))
  return (
    <select
      aria-label={label}
      {...rest}
      ref={setRef}
      value={value}
      className={joinClass('ui-control', 'ui-select', className)}
      style={width ? { width, ...style } : style}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {groups.map((group) =>
        group ? (
          <optgroup key={group} label={group}>
            {render(options.filter((o) => o.group === group))}
          </optgroup>
        ) : (
          render(options.filter((o) => !o.group))
        )
      )}
    </select>
  )
}
