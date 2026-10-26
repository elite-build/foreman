// The welcome tour: dims the window and points at one real control at a time, with a card
// that says what it's for. Steps and placement are in shared/tour.ts; controls opt in with
// `data-tour="<target>"`. A control that isn't on screen (sidebar hidden) gets a centered card
// that says what to open and what to look for. Each step has at most one button that does the
// thing the step is about, and each step is announced to screen readers as it arrives.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { MessageKey, ParamValue, PlainKey } from '../../../shared/i18n'
import { placeCard, TOUR_STEPS, type Rect, type TourAction } from '../../../shared/tour'
import { announce } from '../announce'
import { useT } from '../i18n'
import { shortcutHint } from '../shortcuts'
import { api, attempt, endTour, findTourTarget, goToTourStep, openAssistant, openAutomations, openSettingsPage, setSidebarFilter, useStore } from '../store'
import { Button, Kbd } from '../ui'
import { useDialogFocus } from './Dialogs'
import './tour.css'

// Bodies take shortcut placeholders, drawn as keycaps. `where` says what to look for when the control is hidden.
const COPY: Record<string, { title: PlainKey; body: MessageKey; where?: PlainKey }> = {
  welcome: { title: 'tour.step.welcome.title', body: 'tour.step.welcome.body' },
  addRepo: { title: 'tour.step.addRepo.title', body: 'tour.step.addRepo.body', where: 'tour.step.addRepo.where' },
  newWorkspace: { title: 'tour.step.newWorkspace.title', body: 'tour.step.newWorkspace.body', where: 'tour.step.newWorkspace.where' },
  needsYou: { title: 'tour.step.needsYou.title', body: 'tour.step.needsYou.body', where: 'tour.step.needsYou.where' },
  layout: { title: 'tour.step.layout.title', body: 'tour.step.layout.body' },
  automations: { title: 'tour.step.automations.title', body: 'tour.step.automations.body', where: 'tour.step.automations.where' },
  assistant: { title: 'tour.step.assistant.title', body: 'tour.step.assistant.body', where: 'tour.step.assistant.where' },
  settings: { title: 'tour.step.settings.title', body: 'tour.step.settings.body', where: 'tour.step.settings.where' },
  help: { title: 'tour.step.help.title', body: 'tour.step.help.body', where: 'tour.step.help.where' }
}

// The shortcut each placeholder in a body stands for (registry ids, so keycaps follow the platform: ⌘⇧A or Ctrl+Shift+A).
const SHORTCUT_IDS: Record<string, Record<string, string>> = {
  newWorkspace: { key: 'workspace.new' },
  needsYou: { next: 'workspace.nextAttention', jump: 'chat.needsMe' },
  layout: { palette: 'palette.toggle' },
  assistant: { key: 'assistant.toggle' },
  help: { palette: 'palette.toggle', shortcuts: 'shortcuts.help' }
}

// The layout step's button flips between the two layouts, so its label is chosen from the setting.
const ACTION_LABEL: Record<Exclude<TourAction, 'switchLayout'>, PlainKey> = {
  filterNeedsYou: 'tour.action.filterNeedsYou',
  openAutomations: 'tour.action.automations',
  openAssistant: 'tour.action.assistant',
  openAccessibility: 'tour.action.accessibility'
}

// Room around the control inside the spotlight.
const PAD = 4
// Before the card is measured.
const CARD_GUESS = { width: 320, height: 190 }

const sameRect = (a: Rect | null, b: Rect | null) => a === b || (a !== null && b !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height)

/** The target's box, kept current while the window, the target or the layout changes size. */
function useTargetRect(target: string | undefined): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null)
  useLayoutEffect(() => {
    if (!target) return setRect(null)
    let observed: HTMLElement | null = null
    const measure = () => {
      const el = findTourTarget(target)
      if (el !== observed) {
        if (observed) resize.unobserve(observed)
        if (el) resize.observe(el)
        observed = el
      }
      const box = el?.getBoundingClientRect()
      const next = box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null
      setRect((prev) => (sameRect(prev, next) ? prev : next))
    }
    const resize = new ResizeObserver(measure)
    // The body's size changes with the window; panes opening and closing move the target without resizing it.
    resize.observe(document.body)
    const mutations = new MutationObserver(measure)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    window.addEventListener('resize', measure)
    measure()
    return () => {
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [target])
  return rect
}

/** The spotlight: the control plus a little room, kept inside the window so its ring shows at the edges too. */
function spotStyle(rect: Rect, view: { width: number; height: number }) {
  const left = Math.max(rect.left - PAD, 2)
  const top = Math.max(rect.top - PAD, 2)
  const right = Math.min(rect.left + rect.width + PAD, view.width - 2)
  const bottom = Math.min(rect.top + rect.height + PAD, view.height - 2)
  return { left, top, width: right - left, height: bottom - top }
}

export function Tour() {
  const tour = useStore((s) => s.tour)
  if (!tour) return null
  return <TourCard steps={tour.steps} index={tour.index} />
}

function TourCard({ steps, index }: { steps: string[]; index: number }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot?.platform)
  const layout = useStore((s) => s.snapshot?.settings.windowLayout)
  const id = steps[index]
  const step = TOUR_STEPS.find((s) => s.id === id)!
  const copy = COPY[id]
  const rect = useTargetRect(step.target)
  const card = useRef<HTMLDivElement>(null)
  const next = useRef<HTMLButtonElement>(null)
  const [size, setSize] = useState(CARD_GUESS)
  const [view, setView] = useState({ width: window.innerWidth, height: window.innerHeight })
  useDialogFocus(card)

  useLayoutEffect(() => {
    const el = card.current
    if (!el) return
    const measured = { width: el.offsetWidth, height: el.offsetHeight }
    if (measured.width !== size.width || measured.height !== size.height) setSize(measured)
  })
  useEffect(() => {
    const onResize = () => setView({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // Each step starts on its main button, so Enter keeps going.
  useEffect(() => next.current?.focus(), [index])

  const first = index === 0
  const last = index === steps.length - 1
  const missing = Boolean(step.target) && !rect
  const place = placeCard(missing ? null : rect, size, view)
  const kbd = (keys: string): ReactNode => <Kbd>{keys}</Kbd>
  // The shortcuts in the step's text for this platform: strings (what a screen reader is told) and keycaps (what is drawn).
  const chords: Record<string, string> = Object.fromEntries(Object.entries(SHORTCUT_IDS[id] ?? {}).map(([name, shortcut]) => [name, shortcutHint(shortcut, platform) ?? '']))
  const keys: Record<string, ReactNode> = Object.fromEntries(Object.entries(chords).map(([name, chord]) => [name, kbd(chord)]))
  const sidebarKey = shortcutHint('panel.left', platform) ?? ''
  // What to open and look for, when the control is hidden.
  const where = missing && step.area === 'sidebar' && copy.where ? t(copy.where) : ''
  const actionLabel = step.action === 'switchLayout' ? t(layout === 'tiles' ? 'tour.action.panes' : 'tour.action.tiles') : step.action ? t(ACTION_LABEL[step.action]) : ''

  // Each step is spoken as it arrives: where we are, what it is, and, when it's hidden, how to find it.
  useEffect(() => {
    const plain = (key: MessageKey, params: Record<string, ParamValue>) => (t as unknown as (key: MessageKey, params: Record<string, ParamValue>) => string)(key, params)
    const away = where ? ` ${plain('tour.away.sidebar', { key: sidebarKey, where })}` : ''
    announce(`${t('tour.announce', { step: index + 1, total: steps.length, title: t(copy.title) })} ${plain(copy.body, chords)}${away}`, 'tour:step')
  }, [index])

  // The step's button does its thing and closes the tour, so the thing it opened is what's on screen.
  const act = () => {
    const action = step.action
    endTour()
    if (action === 'filterNeedsYou') setSidebarFilter('needs-you')
    else if (action === 'switchLayout') void attempt(() => api.updateSettings({ windowLayout: layout === 'tiles' ? 'panes' : 'tiles' }))
    else if (action === 'openAutomations') openAutomations()
    else if (action === 'openAssistant') openAssistant()
    else if (action === 'openAccessibility') openSettingsPage({ section: 'accessibility' })
  }

  return (
    <div className="tour-layer">
      {!missing && rect ? (
        <div className="tour-spot" style={spotStyle(rect, view)} />
      ) : (
        <div className="tour-dim" />
      )}
      {/* DS-TODO(B1): ui/Dialog can't take a position (a fixed left/top from the measured target) or drop its own backdrop (the spotlight is the dim), so the card stays a hand-built dialog. */}
      <div
        ref={card}
        className={`tour-card side-${place.side}`}
        style={{ left: place.left, top: place.top, ['--tour-arrow' as string]: `${place.arrow}px` }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            endTour()
          } else if (e.key === 'ArrowRight' && !last) {
            e.preventDefault()
            goToTourStep(index + 1)
          } else if (e.key === 'ArrowLeft' && !first) {
            e.preventDefault()
            goToTourStep(index - 1)
          }
        }}
      >
        {first && <div className="tour-eyebrow">{t('tour.label')}</div>}
        <h2 id="tour-title">{t(copy.title)}</h2>
        <p id="tour-body">{t.rich(copy.body, keys)}</p>
        {where && <p className="tour-away">{t.rich('tour.away.sidebar', { key: kbd(sidebarKey), where })}</p>}
        {step.action && (
          <div className="tour-action">
            <Button size="sm" onClick={act}>
              {actionLabel}
            </Button>
          </div>
        )}
        <div className="tour-foot">
          {!first && <span className="tour-count">{t('tour.count', { step: index + 1, total: steps.length })}</span>}
          <span className="spacer" />
          {!last && (
            <Button variant="ghost" size="sm" onClick={endTour}>
              {t('tour.skip')}
            </Button>
          )}
          {!first && (
            <Button size="sm" onClick={() => goToTourStep(index - 1)}>
              {t('tour.back')}
            </Button>
          )}
          <Button ref={next} variant="primary" size="sm" onClick={() => (last ? endTour() : goToTourStep(index + 1))}>
            {first ? t('tour.start') : last ? t('tour.done') : t('tour.next')}
          </Button>
        </div>
      </div>
    </div>
  )
}
