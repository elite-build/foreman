import type { ButtonHTMLAttributes, Ref } from 'react'

export type ChipTone = 'neutral' | 'warn'

export type ChipButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role' | 'aria-pressed'> & {
  // neutral: muted text (a mode that is on is `pressed`, never coral). warn: amber text on an amber tint (waiting on the user).
  // Independent of `pill`.
  tone?: ChipTone
  // A toggle (Plan mode): sets aria-pressed and the highlighted look.
  pressed?: boolean
  // The chip opens something (a menu, a picker, a dialog): sets aria-haspopup, and aria-expanded (false until `expanded`).
  // A Popover's trigger props (aria-haspopup, aria-expanded) spread onto the chip work too; these two win when both are given.
  haspopup?: 'menu' | 'listbox' | 'dialog' | 'true'
  expanded?: boolean
  // Fully rounded, for status pills in headers (the phone and cloud pills). Any tone can be a pill.
  pill?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function ChipButton({ tone = 'neutral', pressed, haspopup, expanded, pill, className, ref, 'aria-haspopup': ariaHaspopup, 'aria-expanded': ariaExpanded, ...rest }: ChipButtonProps) {
  const cls = ['ui-chip-btn', tone !== 'neutral' && `ui-chip-btn--${tone}`, pill && 'ui-chip-btn--pill', className].filter(Boolean).join(' ')
  return (
    <button
      {...rest}
      role={undefined}
      ref={ref}
      type="button"
      className={cls}
      aria-pressed={pressed}
      aria-haspopup={haspopup ?? ariaHaspopup}
      aria-expanded={expanded ?? ariaExpanded ?? (haspopup ? false : undefined)}
    />
  )
}
