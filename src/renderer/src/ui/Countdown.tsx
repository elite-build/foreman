import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react'

export type CountdownProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'role' | 'aria-hidden'> & {
  // How long the ring takes to empty, in milliseconds.
  durationMs: number
  // Holds the ring where it is (the caller pauses its own timer at the same moment: pointer over, focus inside).
  paused?: boolean
  // The control the ring goes around, usually the IconButton that ends early what the ring counts down to (Dismiss).
  children: ReactNode
  ref?: Ref<HTMLSpanElement>
}

// A ring that empties around a small control, for something that goes away on its own (a toast). Decorative: the ring
// is hidden from assistive tech, and the control inside keeps its own name. Give it a new `key` to start it again.
export function Countdown({ durationMs, paused = false, children, className, style, ref, ...rest }: CountdownProps) {
  const cls = ['ui-countdown', paused && 'ui-countdown--paused', className].filter(Boolean).join(' ')
  const timing = {
    '--ui-countdown-duration': `${Math.max(0, durationMs)}ms`,
    // Reduce Motion: the ring steps down once a second instead of sweeping.
    '--ui-countdown-steps': Math.max(1, Math.ceil(durationMs / 1000))
  } as CSSProperties
  return (
    <span {...rest} ref={ref} className={cls} style={{ ...timing, ...style }}>
      <svg className="ui-countdown__ring" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle className="ui-countdown__track" cx="12" cy="12" r="11" pathLength="100" />
        <circle className="ui-countdown__left" cx="12" cy="12" r="11" pathLength="100" />
      </svg>
      {children}
    </span>
  )
}
