import { useId, type ComponentPropsWithRef, type ReactNode } from 'react'
import { joinClass } from './Field'

export type RadioOption<T extends string> = {
  value: T
  label: ReactNode
  // A second line under the label.
  description?: ReactNode
  disabled?: boolean
  // Why the option can't be picked. Visible, and read out as the option's description.
  reason?: string
  // Content under the option, outside its label (a text field for "Custom…"). Show it only when it applies.
  extra?: ReactNode
}

export type RadioListProps<T extends string> = Omit<ComponentPropsWithRef<'fieldset'>, 'onChange' | 'children' | 'defaultValue'> & {
  // The group's name. Visible unless `hideLegend`; either way a screen reader announces it on entering the group.
  legend: ReactNode
  hideLegend?: boolean
  // Undefined: nothing chosen yet.
  value: T | undefined
  options: RadioOption<T>[]
  onChange: (value: T) => void
  // Lay the options out in a row that wraps, for short labels.
  inline?: boolean
  // The radios' shared `name`; generated when omitted.
  name?: string
}

// A group of native radio buttons: one Tab stop, arrow keys choose, all by the browser. A fieldset with a legend names
// the group. Use RadioCards instead when each choice needs a description or buttons of its own.
export function RadioList<T extends string>({ legend, hideLegend, value, options, onChange, inline, name, className, ref, ...rest }: RadioListProps<T>) {
  const uid = useId()
  const group = name ?? `${uid}-group`
  return (
    <fieldset {...rest} ref={ref} className={joinClass('ui-radio-list', inline && 'ui-radio-list--inline', className)}>
      <legend className="ui-radio-list__legend" data-hidden={hideLegend ? '' : undefined}>
        {legend}
      </legend>
      {options.map((option, i) => {
        const base = `${uid}-${i}`
        const titleId = `${base}-label`
        const describedBy = [option.description && `${base}-description`, option.reason && `${base}-reason`].filter(Boolean).join(' ')
        return (
          <div key={option.value} className="ui-radio-list__item">
            <label className="ui-radio-list__option" data-disabled={option.disabled ? '' : undefined}>
              <input
                className="ui-radio-list__input"
                type="radio"
                name={group}
                value={option.value}
                checked={option.value === value}
                disabled={option.disabled}
                aria-labelledby={titleId}
                aria-describedby={describedBy || undefined}
                onChange={() => onChange(option.value)}
              />
              <span className="ui-radio-list__text">
                <span id={titleId}>{option.label}</span>
                {option.description && (
                  <small id={`${base}-description`} className="ui-radio-list__description">
                    {option.description}
                  </small>
                )}
                {option.reason && (
                  <small id={`${base}-reason`} className="ui-radio-list__reason">
                    {option.reason}
                  </small>
                )}
              </span>
            </label>
            {option.extra && <div className="ui-radio-list__extra">{option.extra}</div>}
          </div>
        )
      })}
    </fieldset>
  )
}
