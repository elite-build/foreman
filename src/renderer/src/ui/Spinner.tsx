import type { HTMLAttributes, Ref } from 'react'

export type SpinnerProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'role' | 'aria-label' | 'aria-hidden'> & {
  // Pixel size of the icon.
  size?: number
  // Say what is loading ("Cloning…") when the spinner is the only sign of progress. Without it the spinner
  // is decorative and hidden from assistive tech, so words beside it must carry the meaning.
  label?: string
  ref?: Ref<HTMLSpanElement>
}

export function Spinner({ size = 14, label, className, ref, ...rest }: SpinnerProps) {
  const cls = className ? `ui-spinner ${className}` : 'ui-spinner'
  return (
    <span {...rest} ref={ref} className={cls} role={label ? 'status' : undefined} aria-hidden={label ? undefined : true}>
      <svg className="ui-spinner__icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      {label ? <span className="ui-spinner__label">{label}</span> : null}
    </span>
  )
}
