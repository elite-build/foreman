import { useId, type ComponentPropsWithRef, type CSSProperties, type ReactNode } from 'react'
import { joinClass } from './Field'

export type RadioCardOption<T extends string> = {
  value: T
  // The card's title; with the radio, the only part of the card that names it.
  label: ReactNode
  description?: ReactNode
  // A decorative icon before the text.
  icon?: ReactNode
  disabled?: boolean
  // Why the card can't be picked. Visible on the card, and read out as its description.
  reason?: string
  // The chosen card has a problem to fix (a missing key): red border. Say what in `description`; colour alone isn't enough.
  invalid?: boolean
  // Buttons and links under the text. They sit beside the label, not in it, so they stay their own controls.
  actions?: ReactNode
}

export type RadioCardsProps<T extends string> = Omit<ComponentPropsWithRef<'fieldset'>, 'onChange' | 'children' | 'defaultValue'> & {
  legend: ReactNode
  hideLegend?: boolean
  // Undefined: nothing chosen yet.
  value: T | undefined
  options: RadioCardOption<T>[]
  onChange: (value: T) => void
  // `grid`: roomy cards in columns. `stack`: compact rows, one per line.
  layout?: 'grid' | 'stack'
  // Columns in a grid layout (default 2). Below 560px of width the cards stack whatever this says.
  columns?: number
  name?: string
}

const TICK = <path d="M2.5 6.2 5 8.6l4.6-5.1" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />

// Choices that deserve a card: native radios, so one Tab stop and arrow keys as in RadioList, with a check mark for the
// chosen one. The whole card is clickable. A disabled card says why on its face.
export function RadioCards<T extends string>({ legend, hideLegend, value, options, onChange, layout = 'grid', columns, name, className, ref, ...rest }: RadioCardsProps<T>) {
  const uid = useId()
  const group = name ?? `${uid}-group`
  return (
    // The wrapper is the size container: the grid below it collapses by its width, wherever the cards are placed.
    <div className={joinClass('ui-radio-cards', layout === 'stack' && 'ui-radio-cards--stack', className)}>
      <fieldset {...rest} ref={ref} className="ui-radio-cards__set">
        <legend className="ui-radio-cards__legend" data-hidden={hideLegend ? '' : undefined}>
          {legend}
        </legend>
        <div className="ui-radio-cards__grid" style={columns ? ({ '--ui-radio-cards-columns': columns } as CSSProperties) : undefined}>
          {options.map((option, i) => {
            const base = `${uid}-${i}`
            const titleId = `${base}-label`
            const describedBy = [option.description && `${base}-description`, option.reason && `${base}-reason`].filter(Boolean).join(' ')
            const selected = option.value === value
            return (
              <div
                key={option.value}
                className="ui-radio-card"
                data-selected={selected ? '' : undefined}
                data-disabled={option.disabled ? '' : undefined}
                data-invalid={option.invalid ? '' : undefined}
              >
                <label className="ui-radio-card__label">
                  <input
                    className="ui-radio-card__input"
                    type="radio"
                    name={group}
                    value={option.value}
                    checked={selected}
                    disabled={option.disabled}
                    aria-labelledby={titleId}
                    aria-describedby={describedBy || undefined}
                    onChange={() => onChange(option.value)}
                  />
                  {option.icon && (
                    <span className="ui-radio-card__icon" aria-hidden="true">
                      {option.icon}
                    </span>
                  )}
                  <span className="ui-radio-card__text">
                    <span id={titleId} className="ui-radio-card__title">
                      {option.label}
                    </span>
                    {option.description && (
                      <small id={`${base}-description`} className="ui-radio-card__description">
                        {option.description}
                      </small>
                    )}
                    {option.reason && (
                      <small id={`${base}-reason`} className="ui-radio-card__reason">
                        {option.reason}
                      </small>
                    )}
                  </span>
                  <span className="ui-radio-card__check" aria-hidden="true">
                    <svg viewBox="0 0 12 12" focusable="false">
                      {TICK}
                    </svg>
                  </span>
                </label>
                {option.actions && <div className="ui-radio-card__actions">{option.actions}</div>}
              </div>
            )
          })}
        </div>
      </fieldset>
    </div>
  )
}
