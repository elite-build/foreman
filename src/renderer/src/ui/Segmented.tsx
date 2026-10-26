import type { HTMLAttributes, KeyboardEvent, ReactNode, Ref } from 'react'
import { nextIndex, tabStop } from './keys'

export type SegmentOption<T extends string> = {
  value: T
  label: ReactNode
  title?: string
  // Shown but not pickable (say why in `title`); arrows skip it.
  disabled?: boolean
}

export type SegmentedProps<T extends string> = Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'aria-label' | 'onChange' | 'children'> & {
  // Undefined: nothing picked yet.
  value: T | undefined
  options: SegmentOption<T>[]
  onChange: (value: T) => void
  // The group's accessible name.
  label: string
  // The borderless look for pickers, panel headers and dialog mode switches.
  plain?: boolean
  small?: boolean
  ref?: Ref<HTMLDivElement>
}

// A radio group in one row: one Tab stop (the picked option, or the first enabled one when that is disabled),
// arrows and Home/End pick and move, and disabled options are stepped over.
export function Segmented<T extends string>({ value, options, onChange, label, plain, small, className, onKeyDown, ref, ...rest }: SegmentedProps<T>) {
  const selected = options.findIndex((o) => o.value === value)
  const disabled = (i: number) => Boolean(options[i]?.disabled)
  const stop = tabStop(selected, options.length, disabled)

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented) return
    const radios = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
    const focused = radios.indexOf(document.activeElement as HTMLButtonElement)
    const next = nextIndex(e.key, focused >= 0 ? focused : selected, options.length, { orientation: 'both', wrap: true, disabled })
    if (next === undefined || disabled(next)) return
    e.preventDefault()
    if (options[next].value !== value) onChange(options[next].value)
    radios[next]?.focus()
  }

  const cls = ['ui-segmented', plain && 'ui-segmented--plain', small && 'ui-segmented--small', className].filter(Boolean).join(' ')
  return (
    <div {...rest} ref={ref} className={cls} role="radiogroup" aria-label={label} onKeyDown={handleKeyDown}>
      {options.map((option, i) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={i === stop ? 0 : -1}
          className="ui-segmented__option"
          title={option.title}
          disabled={option.disabled}
          onClick={() => option.value !== value && onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
