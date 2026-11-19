// One section of the sidebar under a heading that folds it: Team, Channels and every group of the workspace list share
// it, so each heading does the same thing. The heading (level 3, so heading navigation stops at each) is a quiet
// ui/Disclosure: its name, how many things are under it,
// and, while folded, ▲ and how many of them need the person. Click, Enter or Space folds or unfolds it; the caller keeps
// the fold (remembered in the store). Nothing on a heading opens a page: a page is a link under the list ("Team page",
// "All channels"). `foldable` false (a filter or a search narrows the list) shows the heading as plain text with
// everything under it open.
import type { ReactNode } from 'react'
import { useT } from '../i18n'
import { Card, Disclosure, Glyph } from '../ui'

export function SidebarSection({
  name,
  count,
  needs = 0,
  open,
  onToggle,
  foldable = true,
  className,
  title,
  actions,
  icon,
  card = false,
  children
}: {
  name: string
  count: number
  // How many things under the heading need the person: said on the heading while it is folded.
  needs?: number
  open: boolean
  onToggle: () => void
  foldable?: boolean
  className?: string
  // A tooltip for the whole section (a comparison's full prompt).
  title?: string
  // Buttons for the heading's subject (a repository's ⋯), at the heading's end, beside its fold button, not in it.
  actions?: ReactNode
  // The subject's mark before its name (a repository's icon, or its initials): for the eye; the name says it.
  icon?: ReactNode
  // A card (ui/Card) around the heading and what is under it, so where one group ends and the next starts shows at a
  // glance (Work's repositories).
  card?: boolean
  children: ReactNode
}) {
  const t = useT()
  // Seen: the name, the count and (folded) ▲ and how many need you. Heard: the same in words ("Channels · 6 · 1 needs you").
  const heading = (folded: boolean) => {
    const named = t('sidebar.tabCount', { label: name, count })
    const waits = folded && needs > 0
    return (
      <>
        {/* The icon column, empty when the section has no mark, so every name starts on the text column. */}
        <span className="sb-head-icon" aria-hidden>
          {icon}
        </span>
        <span className="sb-head-name" aria-hidden>
          {name}
        </span>
        <span className="sb-head-count" aria-hidden>
          {count}
        </span>
        {waits && (
          <span className="sb-head-need" aria-hidden>
            <Glyph name="warn" />
            {needs}
          </span>
        )}
        <span className="sr-only">{waits ? t('sidebar.rail.needYou', { label: named, count: needs }) : named}</span>
      </>
    )
  }
  const classes = ['sb-section', className, actions ? 'has-actions' : '', card ? 'sb-card' : ''].filter(Boolean).join(' ')
  const body = (
    <>
      {actions && <span className="sb-head-actions">{actions}</span>}
      {foldable ? (
        <Disclosure quiet headingLevel={3} className="sb-fold" label={heading(!open)} open={open} onOpenChange={onToggle}>
          {children}
        </Disclosure>
      ) : (
        <>
          <div className="sb-head" role="heading" aria-level={3}>
            {heading(false)}
          </div>
          {children}
        </>
      )}
    </>
  )
  return card ? (
    <Card as="section" className={classes} aria-label={name} title={title}>
      {body}
    </Card>
  ) : (
    <section className={classes} aria-label={name} title={title}>
      {body}
    </section>
  )
}
