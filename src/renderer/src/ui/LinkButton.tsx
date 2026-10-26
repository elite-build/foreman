import type { ButtonHTMLAttributes, Ref } from 'react'

export type LinkButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role'> & {
  // Error-coloured, for a destructive text action.
  danger?: boolean
  // Text size: inherits the surrounding text unless 'sm'.
  size?: 'inherit' | 'sm'
  // The code font (a path, a file name, a pattern).
  mono?: boolean
  // An inline link inside a sentence: blue (the link colour) with an underline that is always there (not only on hover), so it
  // reads as a link without relying on colour.
  underline?: boolean
  ref?: Ref<HTMLButtonElement>
}

// A button that looks like a link: for actions in running text and small "Refresh" style actions.
// A real link (navigation) is an <a href>, not this.
export function LinkButton({ danger, size = 'inherit', underline, mono, className, ref, ...rest }: LinkButtonProps) {
  const cls = ['ui-link-btn', danger && 'ui-link-btn--danger', size === 'sm' && 'ui-link-btn--sm', underline && 'ui-link-btn--underline', mono && 'ui-link-btn--mono', className].filter(Boolean).join(' ')
  return <button {...rest} role={undefined} ref={ref} type="button" className={cls} />
}
