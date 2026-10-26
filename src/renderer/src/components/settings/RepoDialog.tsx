// Overlays shared by the repository and environment settings pages: a
// centered dialog (the design system's Dialog), plus Escape and click-outside handling for popovers.
import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useT } from '../../i18n'
import { Dialog as UiDialog, Kbd } from '../../ui'
import './repo.css'

type Handler = { current: () => void }
const escapeStack: Handler[] = []

function onEscapeKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.isComposing) return
  const top = escapeStack[escapeStack.length - 1]
  if (!top) return
  // Settings closes on Escape too; only the topmost layer should react.
  e.preventDefault()
  e.stopPropagation()
  top.current()
}

/** Escape closes the most recently opened dialog, sheet or popover, and nothing else. */
export function useEscape(onEscape: () => void, enabled = true): void {
  const handler = useRef(onEscape)
  handler.current = onEscape
  useEffect(() => {
    if (!enabled) return
    if (!escapeStack.length) window.addEventListener('keydown', onEscapeKey, true)
    const entry: Handler = { current: () => handler.current() }
    escapeStack.push(entry)
    return () => {
      escapeStack.splice(escapeStack.indexOf(entry), 1)
      if (!escapeStack.length) window.removeEventListener('keydown', onEscapeKey, true)
    }
  }, [enabled])
}

export function useClickOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, enabled = true): void {
  const handler = useRef(onOutside)
  handler.current = onOutside
  useEffect(() => {
    if (!enabled) return
    const listener = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) handler.current()
    }
    window.addEventListener('mousedown', listener)
    return () => window.removeEventListener('mousedown', listener)
  }, [enabled, ref])
}

/** ⌘↵ (Ctrl+Enter elsewhere) while a dialog or sheet is open, wherever focus is. */
export function useModEnter(action: (() => void) | undefined): void {
  const handler = useRef(action)
  handler.current = action
  const enabled = Boolean(action)
  useEffect(() => {
    if (!enabled) return
    const listener = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.defaultPrevented || e.isComposing) return
      e.preventDefault()
      handler.current?.()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [enabled])
}

interface DialogProps {
  title: string
  description?: ReactNode
  onClose: () => void
  // ⌘↵ anywhere in the dialog.
  onSubmit?: () => void
  footer?: ReactNode
  width?: number
  children?: ReactNode
}

/** A centered dialog rendered into <body>. `width` picks the nearest of the design system's sizes (520, 640, 820). */
export function Dialog({ title, description, onClose, onSubmit, footer, width = 480, children }: DialogProps) {
  const t = useT()
  useModEnter(onSubmit)
  return (
    <UiDialog
      title={title}
      description={description}
      onClose={onClose}
      closeLabel={t('common.close')}
      footer={footer}
      size={width <= 520 ? 'md' : width <= 640 ? 'lg' : 'xl'}
      className="repo-dialog"
    >
      {children}
    </UiDialog>
  )
}

/** "⌘↵" or "Ctrl+↵" after a button label. */
export function SubmitHint({ platform }: { platform: string }) {
  return <Kbd className="repo-kbd">{platform === 'darwin' ? '⌘↵' : 'Ctrl+↵'}</Kbd>
}
