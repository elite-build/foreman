// One section of the sidebar under a heading that folds it: Team, Channels and every group of the workspace list share
// it, so each heading does the same thing. The heading (level 3, so heading navigation stops at each) is a quiet
// ui/Disclosure: its name, how many things are under it,
// and, while folded, ▲ and how many of them need the person. Click, Enter or Space folds or unfolds it; the caller keeps
// the fold (remembered in the store). Nothing on a heading opens a page: a page is a link under the list ("Team page",
// "All channels"). `foldable` false (a filter or a search narrows the list) shows the heading as plain text with
// everything under it open.
import type { ReactNode } from 'react'
import { useT } from '../i18n'
import { Disclosure, Glyph } from '../ui'

export function SidebarSection({
  name,
  count,
  needs = 0,
  open,
  onToggle,
  foldable = true,
  className,
  title,
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
  children: ReactNode
}) {
  const t = useT()
  // Seen: the name, the count and (folded) ▲ and how many need you. Heard: the same in words ("Channels · 6 · 1 needs you").
  const heading = (folded: boolean) => {
    const named = t('sidebar.tabCount', { label: name, count })
    const waits = folded && needs > 0
    return (
      <>
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
  return (
    <section className={['sb-section', className].filter(Boolean).join(' ')} aria-label={name} title={title}>
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
    </section>
  )
}
