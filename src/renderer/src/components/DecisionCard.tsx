// One decision, wherever it waits for a person (an agent's command, question or plan in a chat; an employee's question,
// held push or memory change on the Team page, its own page and its run): the same card everywhere, or, in a list, a
// one-line row that opens into it. A feature composition of ui/ parts (Card, Status, Tag, Button, Kbd, ActionRow), not a
// design-system component.
//
// The card: a header (▲ Needs you · who · what kind · how long ago), the thing being decided, its details, then a line
// saying what the main button will do, just above the buttons. The buttons are named for what they do and always come in
// one order, the main one last (as in every Foreman dialog): decline · alternate · main. Keys inside the card: Esc
// declines, Ctrl+Enter takes the alternate (the main act when there is none), Enter the main act. Anything that leaves
// this computer has no key at all: Tab to it, then Enter or Space on the button itself.
//
// The row: ▲ kind · who · what · age · one button · open. The button does the main act only when that act stays on this
// computer; otherwise it opens the card ("Answer…", "Review…"), so what leaves and where is read before it can go.
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { useT } from '../i18n'
import { formatChord } from '../shortcuts'
import { useStore } from '../store'
import { ActionRow, Button, Card, Kbd, Status, Tag } from '../ui'
import './decisionCard.css'

export interface DecisionAct {
  label: ReactNode
  onAct: () => void
  disabled?: boolean
  // It sends something off this computer (a push, a message, a pull request, a command that pushes): no keyboard shortcut.
  outward?: boolean
  title?: string
}

export interface DecisionCardProps {
  // Who asks: an agent's name, an employee's hat and name.
  who?: ReactNode
  // What kind of decision ("Push", "Question", "Command").
  kind: string
  // How long it has waited ("42m ago").
  age?: string
  // At the header's end (the key that reaches a docked card).
  headEnd?: ReactNode
  // The thing being decided, in one line: the card's name.
  subject: ReactNode
  children?: ReactNode
  // What the main act does, said just above the buttons.
  consequence?: ReactNode
  // The main act sends something off this computer: the consequence line starts with ▲ Leaves this computer.
  leaves?: boolean
  decline?: DecisionAct
  alternate?: DecisionAct
  main?: DecisionAct
  // Before the buttons, on the left (More, Copy, how many are answered).
  footStart?: ReactNode
  // Inside an opened row: the row already shows the header and the subject.
  inRow?: boolean
  // Inside an opened row: the element that names it (the row's subject).
  labelledBy?: string
  // Docked above a chat's message box: the body scrolls past half the column, and keys wait `guardMs` after it appears.
  docked?: boolean
  guardMs?: number
  // Runs first; a key it handles (preventDefault) is left alone.
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void
  className?: string
  ref?: Ref<HTMLElement>
}

/** The card. A named group (by its subject) that a key can reach (`tabIndex` -1, `data-decision`). */
export function DecisionCard({ who, kind, age, headEnd, subject, children, consequence, leaves, decline, alternate, main, footStart, inRow, labelledBy, docked, guardMs = 0, onKeyDown, className, ref }: DecisionCardProps) {
  const t = useT()
  const platform = useStore((s) => s.snapshot?.platform)
  const subjectId = useId()
  const shown = useRef(Date.now())
  const mod = platform === 'darwin' ? 'metaKey' : 'ctrlKey'

  const run = (act: DecisionAct | undefined, e: KeyboardEvent<HTMLElement>) => {
    if (!act || act.disabled || act.outward) return false
    e.preventDefault()
    act.onAct()
    return true
  }
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented || e.nativeEvent.isComposing) return
    const target = e.target as Element
    // A menu, a list box or a dialog opened from the card keeps its own keys.
    if (target.closest('[role="menu"], [role="listbox"], [role="dialog"]')) return
    if (e.key === 'Escape') {
      // Esc belongs to the card: it never closes the view around it (and a typed answer with it).
      e.preventDefault()
      e.stopPropagation()
      if (Date.now() - shown.current >= guardMs && decline && !decline.disabled) decline.onAct()
      return
    }
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || Date.now() - shown.current < guardMs) return
    if (e[mod]) {
      if (!run(alternate ?? main, e) && (alternate ?? main)) e.preventDefault()
      return
    }
    if (e.ctrlKey || e.metaKey) return
    // A focused button or link does what it says; Enter in a text box is a new line.
    if (target.closest('button, a, [role="button"], [role="tab"], summary') || target instanceof HTMLTextAreaElement) return
    run(main, e)
  }

  // The key, after a space; none for an act that leaves this computer.
  const key = (act: DecisionAct, chord: string) =>
    act.outward ? null : (
      <>
        {' '}
        <Kbd>{formatChord(chord, platform)}</Kbd>
      </>
    )
  const body = (
    <>
      {children !== undefined && children !== null && children !== false && <div className="decision-body">{children}</div>}
      {consequence && (
        <div className="decision-consequence">
          {leaves && <Tag tone="warn">{t('decision.leaves')}</Tag>}
          <div className="decision-consequence-text">{consequence}</div>
        </div>
      )}
      {(decline || alternate || main || footStart) && (
        <div className="decision-foot">
          {footStart && <span className="decision-foot-start">{footStart}</span>}
          <span className="decision-foot-acts">
            {decline && (
              <Button size="sm" disabled={decline.disabled} title={decline.title} onClick={decline.onAct}>
                {decline.label}{key(decline, 'Escape')}
              </Button>
            )}
            {alternate && (
              <Button size="sm" disabled={alternate.disabled} title={alternate.title} onClick={alternate.onAct}>
                {alternate.label}{key(alternate, 'mod+Enter')}
              </Button>
            )}
            {main && (
              <Button size="sm" variant="primary" disabled={main.disabled} title={main.title} onClick={main.onAct}>
                {main.label}{key(main, 'Enter')}
              </Button>
            )}
          </span>
        </div>
      )}
    </>
  )
  if (inRow)
    return (
      <div ref={ref as Ref<HTMLDivElement>} className={['decision-card', 'decision-card--in-row', className].filter(Boolean).join(' ')} role="group" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : typeof subject === 'string' ? subject : kind} tabIndex={-1} data-decision="" onKeyDown={onKey}>
        {body}
      </div>
    )
  return (
    <Card
      as="section"
      ref={ref as Ref<HTMLDivElement>}
      stripe="warn"
      className={['decision-card', docked && 'decision-card--docked', className].filter(Boolean).join(' ')}
      role="group"
      aria-labelledby={subjectId}
      tabIndex={-1}
      data-decision=""
      onKeyDown={onKey}
    >
      <div className="decision-head">
        <Status tone="warn" label={t('decision.needsYou')} />
        {who && (
          <>
            <span aria-hidden="true" className="decision-sep">
              ·
            </span>
            <span className="decision-who">{who}</span>
          </>
        )}
        <span aria-hidden="true" className="decision-sep">
          ·
        </span>
        <span className="decision-kind">{kind}</span>
        {(age || headEnd) && (
          <span className="decision-head-end">
            {age && <span className="decision-age">{age}</span>}
            {headEnd}
          </span>
        )}
      </div>
      <div className="decision-subject" id={subjectId}>
        {subject}
      </div>
      {body}
    </Card>
  )
}

export interface DecisionRowProps {
  kind: string
  who?: ReactNode
  subject: ReactNode
  age?: string
  // The row's one button: the main act when that stays on this computer, else the opener ("Answer…", "Review…").
  act?: { label: ReactNode; onAct: () => void; disabled?: boolean }
  open: boolean
  onToggle: () => void
  // The card's body, footer and keys (a DecisionCard with `inRow`), shown while the row is open.
  children: ReactNode
  // An id for the subject, which names the opened card.
  subjectId?: string
}

/** One decision in a list: a row with its kind, who, what and age, and one button; open, it is the card. */
export function DecisionRow({ kind, who, subject, age, act, open, onToggle, children, subjectId }: DecisionRowProps) {
  const id = useId()
  return (
    <li className="decision-row" data-open={open ? '' : undefined}>
      <ActionRow
        divided
        onPress={onToggle}
        primaryProps={{ 'aria-expanded': open, 'aria-controls': open ? id : undefined, className: 'decision-row-main' }}
        actions={
          act ? (
            <Button size="sm" disabled={act.disabled} onClick={act.onAct}>
              {act.label}
            </Button>
          ) : undefined
        }
      >
        <Status tone="warn" label={kind} className="decision-row-kind" />
        {who && <span className="decision-row-who">{who}</span>}
        <span className="decision-row-subject" id={subjectId}>
          {subject}
        </span>
        {age && <span className="decision-row-age">{age}</span>}
        {open ? <ChevronUp size={14} aria-hidden className="decision-row-chevron" /> : <ChevronDown size={14} aria-hidden className="decision-row-chevron" />}
      </ActionRow>
      {open && (
        <div className="decision-row-open" id={id}>
          {children}
        </div>
      )}
    </li>
  )
}

/**
 * Decisions as one striped list of rows, one open at a time (the oldest, unless `openFirst` is false). `render` draws
 * each as a DecisionRow, given whether it is open and how to toggle it.
 */
export function DecisionList<T extends { id: string }>({ items, label, render, openFirst = false, className }: { items: readonly T[]; label: string; render: (item: T, open: boolean, toggle: () => void) => ReactNode; openFirst?: boolean; className?: string }) {
  const [open, setOpen] = useState<string | null>(openFirst ? (items[0]?.id ?? null) : null)
  // An open item that was decided (and left the list) closes.
  useEffect(() => {
    if (open && !items.some((i) => i.id === open)) setOpen(null)
  }, [items, open])
  if (!items.length) return null
  return (
    <Card stripe="warn" size="sm" className={['decision-list', className].filter(Boolean).join(' ')}>
      <ul className="decision-list-rows" aria-label={label}>
        {items.map((item) => render(item, open === item.id, () => setOpen(open === item.id ? null : item.id)))}
      </ul>
    </Card>
  )
}

/** Where a decision is drawn: a card (docked in a chat, or on a page), or a row in a list that opens into the card. */
export interface DecisionPlace {
  form: 'card' | 'row'
  open?: boolean
  onToggle?: () => void
  docked?: boolean
  headEnd?: ReactNode
}

export type DecisionParts = Omit<DecisionCardProps, 'inRow' | 'docked' | 'headEnd' | 'guardMs' | 'ref'> & {
  // The row's one button (DecisionRow's `act`).
  rowAct?: DecisionRowProps['act']
}

/** One decision drawn where `place` says: the same parts as a card, or as a row whose open body is the card. */
export function PlacedDecision({ place, parts }: { place: DecisionPlace; parts: DecisionParts }) {
  const { rowAct, ...card } = parts
  const subjectId = useId()
  if (place.form === 'row')
    return (
      <DecisionRow kind={card.kind} who={card.who} subject={card.subject} age={card.age} act={rowAct} open={Boolean(place.open)} onToggle={place.onToggle ?? (() => undefined)} subjectId={subjectId}>
        <DecisionCard {...card} inRow labelledBy={subjectId} />
      </DecisionRow>
    )
  return <DecisionCard {...card} docked={place.docked} headEnd={place.headEnd} guardMs={place.docked ? 600 : 0} />
}
