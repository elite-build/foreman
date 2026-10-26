import type { HTMLAttributes, Ref } from 'react'

export type MeterTone = 'ok' | 'warn' | 'error'

export type MeterProps = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'role' | 'aria-label' | 'aria-valuenow' | 'aria-valuemin' | 'aria-valuemax' | 'aria-valuetext'> & {
  value: number
  min?: number
  max?: number
  // The accessible name ("Usage this month"). Required.
  label: string
  // The value in words ("62% of 20 hours"), read instead of the bare number.
  valueText?: string
  // Fill colour: ok green, warn amber, error red. The caller picks it from its own thresholds.
  tone?: MeterTone
  ref?: Ref<HTMLDivElement>
}

// A bar showing an amount within a known range (usage, quota). For progress of a task use a Spinner or text.
export function Meter({ value, min = 0, max = 100, label, valueText, tone = 'ok', className, ref, ...rest }: MeterProps) {
  if (!(max > min)) throw new Error(`Meter needs max > min (got min ${min}, max ${max})`)
  const clamped = Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
  const percent = ((clamped - min) / (max - min)) * 100
  const cls = ['ui-meter', tone !== 'ok' && `ui-meter--${tone}`, className].filter(Boolean).join(' ')
  return (
    <div
      {...rest}
      ref={ref}
      className={cls}
      role="meter"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={clamped}
      aria-valuetext={valueText}
    >
      <span className="ui-meter__fill" style={{ width: `${percent}%` }} />
    </div>
  )
}
