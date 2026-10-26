// Dev-only: the page's side of the keyboard walk (main/keyboardWalk.ts). Main presses the real keys through the DevTools
// protocol; after each one it asks this module what has focus and what the live region says. Installed with the screens
// hook (screens.ts), so it exists only in a screenshot run.
import { announcer } from './announce'

export interface WalkFocus {
  role: string
  name: string
  tag: string
  level?: number
}

export interface WalkReading {
  activeElement: WalkFocus
  announced: string
  nonce: number
  present: Record<string, boolean>
}

const IMPLICIT_ROLES: Record<string, string> = {
  button: 'button',
  summary: 'button',
  a: 'link',
  textarea: 'textbox',
  select: 'combobox',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
  li: 'listitem',
  ul: 'list',
  ol: 'list',
  nav: 'navigation',
  main: 'main',
  img: 'img',
  dialog: 'dialog'
}

const INPUT_ROLES: Record<string, string> = { checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button', search: 'searchbox' }

/** The ARIA role: the role attribute, else what the tag implies. Empty for a generic element. */
export function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0]
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
  if (/^h[1-6]$/.test(tag)) return 'heading'
  if (tag === 'input') return INPUT_ROLES[(el as HTMLInputElement).type] ?? 'textbox'
  if (tag === 'a' && !el.hasAttribute('href')) return ''
  return IMPLICIT_ROLES[tag] ?? ''
}

export function levelOf(el: Element): number | undefined {
  const level = Number(el.getAttribute('aria-level'))
  if (level > 0) return level
  const heading = /^h([1-6])$/i.exec(el.tagName)
  return heading ? Number(heading[1]) : undefined
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The text a reader would speak for an element's content: what is in the accessibility tree (no aria-hidden, no hidden), sr-only text included. */
function textOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return ''
  if (node.hidden || node.getAttribute('aria-hidden') === 'true') return ''
  const label = node.getAttribute('aria-label')
  if (label) return ` ${label} `
  return [...node.childNodes].map(textOf).join('')
}

/** A simplified accessible name: aria-labelledby, aria-label, a form label, the content (for roles named from content), then title or placeholder. */
export function nameOf(el: Element): string {
  const by = el.getAttribute('aria-labelledby')
  if (by) {
    const named = by
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((n): n is HTMLElement => Boolean(n))
      .map(textOf)
      .join(' ')
    if (squash(named)) return squash(named)
  }
  const label = el.getAttribute('aria-label')
  if (label?.trim()) return squash(label)
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const labelled = [...(el.labels ?? [])].map(textOf).join(' ')
    if (squash(labelled)) return squash(labelled)
  }
  const role = roleOf(el)
  // Roles a name comes from content for: buttons, links, headings, rows, cells, tabs, menu items, checkboxes.
  if (['button', 'link', 'heading', 'row', 'cell', 'columnheader', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'treeitem', 'listitem'].includes(role)) {
    const content = squash([...el.childNodes].map(textOf).join(''))
    if (content) return content
  }
  const fallback = el.getAttribute('title') ?? el.getAttribute('placeholder') ?? ''
  return squash(fallback)
}

export function describeFocus(el: Element | null = document.activeElement): WalkFocus {
  if (!el) return { role: '', name: '', tag: '' }
  const level = roleOf(el) === 'heading' ? levelOf(el) : undefined
  return { role: roleOf(el), name: nameOf(el).slice(0, 200), tag: el.tagName.toLowerCase(), ...(level ? { level } : {}) }
}

/** What main asks after each key: the focused element, the live region's text and nonce, and whether each selector matches. */
export function readWalk(watch: readonly string[] = []): WalkReading {
  const spoken = announcer.current()
  const present: Record<string, boolean> = {}
  for (const selector of watch) {
    try {
      present[selector] = document.querySelector(selector) !== null
    } catch {
      present[selector] = false
    }
  }
  return { activeElement: describeFocus(), announced: spoken.text, nonce: spoken.nonce, present }
}
