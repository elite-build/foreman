import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { Glyph } from './Glyph'
import { Spinner } from './Spinner'

export type StatusTone = 'ok' | 'warn' | 'error' | 'info' | 'off'

export type StatusProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  tone: StatusTone
  // The state in words ("Connected", "Needs you"). Required: colour and shape alone don't say it.
  label: string
  // Shape only. The word moves to screen-reader text; put the same word in a tooltip that opens on the
  // parent's hover and focus. Use where space is tight (a sidebar row).
  compact?: boolean
  // Work going on now ("Ravi working"): a turning ring in place of the glyph, so motion, not colour, says it. Under Reduce
  // Motion it is a still open ring, unlike any glyph, and the word says it either way.
  busy?: boolean
  // Extra visible content after the word (a count).
  children?: ReactNode
  ref?: Ref<HTMLSpanElement>
}

// A state beside a name: a glyph (shape) and a word. Replaces the colour-only dots.
export function Status({ tone, label, compact, busy, className, children, ref, ...rest }: StatusProps) {
  const cls = ['ui-status', `ui-status--${tone}`, compact && 'ui-status--compact', busy && 'ui-status--busy', className].filter(Boolean).join(' ')
  return (
    <span {...rest} ref={ref} className={cls}>
      {busy ? <Spinner size={12} /> : <Glyph name={tone} />}
      <span className="ui-status__label">{label}</span>
      {children}
    </span>
  )
}
