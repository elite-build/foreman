import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { Glyph } from './Glyph'

export type StatusTone = 'ok' | 'warn' | 'error' | 'info' | 'off'

export type StatusProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  tone: StatusTone
  // The state in words ("Connected", "Needs you"). Required: colour and shape alone don't say it.
  label: string
  // Shape only. The word moves to screen-reader text; put the same word in a tooltip that opens on the
  // parent's hover and focus. Use where space is tight (a sidebar row).
  compact?: boolean
  // Extra visible content after the word (a count).
  children?: ReactNode
  ref?: Ref<HTMLSpanElement>
}

// A state beside a name: a glyph (shape) and a word. Replaces the colour-only dots.
export function Status({ tone, label, compact, className, children, ref, ...rest }: StatusProps) {
  const cls = ['ui-status', `ui-status--${tone}`, compact && 'ui-status--compact', className].filter(Boolean).join(' ')
  return (
    <span {...rest} ref={ref} className={cls}>
      <Glyph name={tone} />
      <span className="ui-status__label">{label}</span>
      {children}
    </span>
  )
}
