import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { Glyph } from './Glyph'
import type { GlyphName } from './Glyph'

export type CalloutTone = 'neutral' | 'info' | 'ok' | 'warn' | 'error'

const GLYPH_FOR: Partial<Record<CalloutTone, GlyphName>> = { info: 'info', ok: 'ok', warn: 'warn', error: 'error' }

export type CalloutProps = Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'role'> & {
  // Coloured tones show a glyph; the words must still say what is wrong, since the glyph is hidden from screen readers.
  tone?: CalloutTone
  // note: static information. status: announced politely when it appears. alert: announced at once (errors that block).
  role?: 'note' | 'status' | 'alert'
  // A full-width bar at the top of a pane (history, offline, reconnected) instead of a boxed notice.
  banner?: boolean
  title?: ReactNode
  // Buttons for the notice. Below the text in a box; at the end of the line in a banner.
  actions?: ReactNode
  ref?: Ref<HTMLDivElement>
}

// One notice: replaces the notices, cloud callouts, recovery cards and banners.
export function Callout({ tone = 'neutral', role = 'note', banner, title, actions, className, children, ref, ...rest }: CalloutProps) {
  const glyph = GLYPH_FOR[tone]
  const cls = ['ui-callout', `ui-callout--${tone}`, banner && 'ui-callout--banner', className].filter(Boolean).join(' ')
  return (
    <div {...rest} ref={ref} className={cls} role={role}>
      {glyph ? <Glyph name={glyph} className="ui-callout__glyph" /> : null}
      <div className="ui-callout__body">
        {title ? <div className="ui-callout__title">{title}</div> : null}
        {children ? <div className="ui-callout__text">{children}</div> : null}
        {actions && !banner ? <div className="ui-callout__actions">{actions}</div> : null}
      </div>
      {actions && banner ? <div className="ui-callout__actions">{actions}</div> : null}
    </div>
  )
}
