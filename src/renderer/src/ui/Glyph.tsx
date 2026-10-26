import type { ReactElement, SVGProps } from 'react'

export type GlyphName = 'ok' | 'warn' | 'error' | 'info' | 'off'

// One shape per state, so a state never rests on colour alone: ● ok, ▲ warn, ◆ error, ■ info, ○ off.
// Paths are on a 12×12 grid, filled or stroked with currentColor.
const SHAPES: Record<GlyphName, ReactElement> = {
  ok: <circle cx="6" cy="6" r="5" fill="currentColor" />,
  warn: <path d="M6 .9 11.3 10.6H.7z" fill="currentColor" />,
  error: <path d="M6 .6 11.4 6 6 11.4.6 6z" fill="currentColor" />,
  info: <rect x="1.4" y="1.4" width="9.2" height="9.2" rx="1.2" fill="currentColor" />,
  off: <circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.5" />
}

export type GlyphProps = Omit<SVGProps<SVGSVGElement>, 'name' | 'children' | 'aria-hidden' | 'focusable' | 'role'> & { name: GlyphName }

// Decorative: always hidden from assistive tech. The state's word goes next to it (Status, Tag, Callout).
export function Glyph({ name, className, ...rest }: GlyphProps) {
  return (
    <svg
      {...rest}
      className={className ? `ui-glyph ${className}` : 'ui-glyph'}
      data-glyph={name}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[name]}
    </svg>
  )
}
