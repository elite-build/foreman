import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Dialog and Sheet: the modal layers (from components/Dialogs.tsx `Modal` + `useDialogFocus`, plus the settings
// dialogs and the environment sheet). Both mount while they are open, as the old ones did.
//   - Focus moves in on open, Tab stays inside, and focus goes back to the opener on close (or to the opener of the
//     dialog it was opened from, if that one is gone too).
//   - The trap knows about portals the dialog owns (a menu or hover card rendered from inside it): React bubbles
//     their key events to the dialog, so Tab inside them is theirs, and if one closes and drops focus, focus comes
//     back to where it was in the dialog.
//   - Nested layers: one document-level Escape handler closes the topmost layer only, and skips an Escape that an
//     inner widget (combobox, popover, menu) already handled.
//   - Everything outside the layer is `inert` while it is open (sibling by sibling along the path to the layer, so a
//     layer rendered inside a container works too). Live regions such as the toast are left alone.
//   - A title is required: it is the dialog's accessible name.

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
// Siblings that keep working under an open layer: announcements.
const LIVE = '[data-ui-live], [aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]'

// ---- escape stack ----

// `seq` is taken in render, where a parent comes before its children, so a dialog nested in another is above it even
// when both mount in one commit (child effects run first).
type Layer = { seq: number; close: () => void }
const stack: Layer[] = []
let lastSeq = 0

function onEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
  const top = stack[stack.length - 1]
  if (!top) return
  // Handled here: whatever sits behind (settings, the stop-agent shortcut) must not also see it.
  e.preventDefault()
  e.stopPropagation()
  top.close()
}

function useEscapeLayer(seq: number, close: () => void, enabled: boolean): void {
  const latest = useRef(close)
  latest.current = close
  useEffect(() => {
    if (!enabled) return
    const layer: Layer = { seq, close: () => latest.current() }
    if (!stack.length) document.addEventListener('keydown', onEscape)
    stack.push(layer)
    stack.sort((a, b) => a.seq - b.seq)
    return () => {
      stack.splice(stack.indexOf(layer), 1)
      if (!stack.length) document.removeEventListener('keydown', onEscape)
    }
  }, [seq, enabled])
}

// ---- inert background ----

const seqOf = (el: Element) => Number(el.getAttribute('data-ui-seq') ?? 0)

/**
 * Marks everything outside `layer` inert, except layers above it and live regions; returns the undo. Elements added
 * later (owned portals, toasts) stay live.
 */
function inertOutside(layer: Element, seq: number): () => void {
  const marked: Element[] = []
  const higher = (el: Element) => seqOf(el) > seq
  const mark = (el: Element) => {
    if (el.hasAttribute('inert') || el.matches(LIVE) || el.tagName === 'SCRIPT' || higher(el)) return
    // A branch that holds a live region or a higher layer can't go inert whole: mark what is around them instead.
    if (el.querySelector(LIVE) || [...el.querySelectorAll('[data-ui-seq]')].some(higher)) return void [...el.children].forEach(mark)
    el.setAttribute('inert', '')
    marked.push(el)
  }
  for (let node: Element = layer; node.parentElement && node !== document.body; node = node.parentElement) {
    for (const sibling of node.parentElement.children) if (sibling !== node) mark(sibling)
  }
  return () => marked.forEach((el) => el.removeAttribute('inert'))
}

// ---- focus ----

// Each open layer's opener. A layer opened from inside another one (which may close at the same time) falls back to
// that layer's opener.
const openers = new WeakMap<Element, Element | null>()

function restoreTarget(el: Element | null): HTMLElement | null {
  for (let hops = 0; el && !el.isConnected && hops < 10; hops++) {
    // closest() still works inside the removed layer's detached tree.
    const owner = el.closest('[aria-modal="true"]')
    el = owner ? (openers.get(owner) ?? null) : null
  }
  return el instanceof HTMLElement && el.isConnected ? el : null
}

// jsdom has no layout, so nothing there is "visible"; in a browser the root always has boxes.
const hasLayout = () => document.documentElement.getClientRects().length > 0

function tabbables(node: HTMLElement): HTMLElement[] {
  const layout = hasLayout()
  return [...node.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((el) => !el.closest('[inert], [hidden]') && (!layout || el.getClientRects().length > 0))
    // Document order (jsdom answers a selector list grouped by selector).
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
}

// ---- the layer ----

type LayerProps = {
  kind: 'dialog' | 'sheet'
  title: string
  onClose: () => void
  description?: ReactNode
  footer?: ReactNode
  headerExtra?: ReactNode
  toolbar?: ReactNode
  // Adds a close button with this accessible name.
  closeLabel?: string
  // Keeps the title for assistive tech but doesn't draw it.
  hideTitle?: boolean
  // Mousedown on the backdrop closes (the old behaviour). Turn off where losing the form would hurt.
  closeOnBackdrop?: boolean
  // Gallery and screenshots only: drawn in place, not modal (no portal, trap, inert or Escape).
  preview?: boolean
  // Render into this element instead of <body>, filling it (a sheet over one view).
  container?: Element | null
  size?: 'md' | 'lg' | 'xl'
  className?: string
  layerClassName?: string
  children: ReactNode
}

function Layer({ kind, title, onClose, description, footer, headerExtra, toolbar, closeLabel, hideTitle, closeOnBackdrop = true, preview, container, size = 'md', className, layerClassName, children }: LayerProps) {
  if (!title.trim()) throw new Error(`${kind === 'sheet' ? 'Sheet' : 'Dialog'} needs a title: it is the accessible name`)
  const modal = !preview
  const titleId = useId()
  const descId = useId()
  const [seq] = useState(() => ++lastSeq)
  const layer = useRef<HTMLDivElement>(null)
  const node = useRef<HTMLDivElement>(null)
  // Read during render: autoFocus inside the layer runs before effects.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement))
  // Where focus last was inside the layer's own DOM, for recovery after an owned portal closes.
  const lastInside = useRef<HTMLElement | null>(null)

  useEscapeLayer(seq, onClose, modal)

  useEffect(() => {
    const el = node.current
    const backdrop = layer.current
    if (!modal || !el || !backdrop) return
    openers.set(el, opener)
    const undo = inertOutside(backdrop, seq)
    if (!el.contains(document.activeElement)) el.focus()
    return () => {
      undo()
      // Still in the page: StrictMode replaying effects, not a real close.
      if (el.isConnected) return
      // Unless whatever closed it already moved focus somewhere on purpose.
      const active = document.activeElement
      if (!active || active === document.body || el.contains(active)) restoreTarget(opener)?.focus()
    }
    // Once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal])

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (node.current?.contains(e.target)) lastInside.current = e.target
  }
  // An owned portal (a menu) closed and dropped focus: put it back where it was in the dialog.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const el = node.current
    if (!modal || !el || el.contains(e.target) || e.relatedTarget) return
    setTimeout(() => {
      const active = document.activeElement
      if (!el.isConnected || (active && active !== document.body)) return
      const back = lastInside.current
      ;(back?.isConnected ? back : el).focus()
    }, 0)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const el = node.current
    if (!modal || !el || e.key !== 'Tab' || e.defaultPrevented) return
    // Only Tab inside this layer's own DOM: a nested dialog traps for itself, an owned portal manages its own Tab.
    if (!(e.target instanceof Element) || e.target.closest('[aria-modal="true"]') !== el) return
    const items = tabbables(el)
    if (!items.length) return e.preventDefault()
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === el)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const close = closeLabel ? (
    <button type="button" className="ui-icon-btn" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
      <svg viewBox="0 0 12 12" width="14" height="14" focusable="false" aria-hidden="true">
        <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </button>
  ) : null
  const heading = (
    <h2 id={titleId} className="ui-dialog__title" data-hidden={hideTitle || undefined}>
      {title}
    </h2>
  )

  const body = (
    <div
      ref={layer}
      className={['ui-layer', `ui-layer--${kind}`, layerClassName].filter(Boolean).join(' ')}
      data-contained={container || preview ? '' : undefined}
      data-ui-seq={modal ? seq : undefined}
      onMouseDown={(e) => closeOnBackdrop && modal && e.target === e.currentTarget && onClose()}
    >
      <div
        ref={node}
        className={['ui-dialog', `ui-dialog--${kind}`, kind === 'dialog' && size !== 'md' && `ui-dialog--${size}`, className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal={modal ? 'true' : undefined}
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      >
        <div className="ui-dialog__head">
          {kind === 'sheet' ? (
            <div className="ui-dialog__titles">
              {heading}
              {description && (
                <p id={descId} className="ui-dialog__desc">
                  {description}
                </p>
              )}
            </div>
          ) : (
            heading
          )}
          {headerExtra}
          {close}
        </div>
        {kind === 'dialog' && description && (
          <div id={descId} className="ui-dialog__desc">
            {description}
          </div>
        )}
        {toolbar && <div className="ui-dialog__toolbar">{toolbar}</div>}
        <div className="ui-dialog__body">{children}</div>
        {footer && <div className="ui-dialog__foot">{footer}</div>}
      </div>
    </div>
  )
  return preview ? body : createPortal(body, container ?? document.body)
}

export type DialogProps = Omit<LayerProps, 'kind' | 'container'>
export type SheetProps = Omit<LayerProps, 'kind' | 'toolbar' | 'size'>

/** A centred modal dialog. Render it while it is open. */
export function Dialog(props: DialogProps) {
  return <Layer kind="dialog" {...props} />
}

/** A panel that slides in from the right over the page, or over `container`. */
export function Sheet(props: SheetProps) {
  return <Layer kind="sheet" {...props} />
}
