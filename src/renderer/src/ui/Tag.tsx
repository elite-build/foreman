import type { HTMLAttributes, Ref } from 'react'
import { Glyph } from './Glyph'
import type { GlyphName } from './Glyph'

export type TagTone = 'neutral' | 'accent' | 'outline' | 'ok' | 'warn' | 'error' | 'info'

const GLYPH_FOR: Partial<Record<TagTone, GlyphName>> = { ok: 'ok', warn: 'warn', error: 'error', info: 'info' }

export type TagProps = HTMLAttributes<HTMLSpanElement> & {
  // neutral, accent: labels. outline: for rows that already sit on a raised surface.
  // ok, warn, error, info: a state; these carry a glyph, so the state shows in shape as well as colour.
  tone?: TagTone
  // The code font (an environment variable, a file name, an id).
  mono?: boolean
  ref?: Ref<HTMLSpanElement>
}

// A short inline label: a revision ("r3"), a kind ("tool"), a state ("Signed in"). Not interactive.
export function Tag({ tone = 'neutral', mono, className, children, ref, ...rest }: TagProps) {
  const glyph = GLYPH_FOR[tone]
  const cls = ['ui-tag', tone !== 'neutral' && `ui-tag--${tone}`, mono && 'ui-tag--mono', className].filter(Boolean).join(' ')
  return (
    <span {...rest} ref={ref} className={cls}>
      {glyph ? <Glyph name={glyph} /> : null}
      {children}
    </span>
  )
}
