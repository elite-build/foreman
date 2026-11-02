/** Desktop-only browser contract. Never exposed to page content, agents or the CLI. */
import type { TFunction } from './i18n'
import { fenced } from './transcript'

export type BrowserBounds = { x: number; y: number; width: number; height: number }
export type BrowserState = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string }
export type BrowserCommand =
  | { type: 'open' | 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'stop' | 'close' | 'focus' | 'cancel-selection' }
  | { type: 'bounds'; bounds: BrowserBounds | null }
/** A picked element, as page content: untrusted, bounded draft context. `image` is a PNG of the element, base64. */
export type BrowserSelection = {
  url: string
  selector: string
  text: string
  html: string
  styles: [name: string, value: string][]
  size?: { width: number; height: number }
  /** Nearest framework components, outermost first (dev builds only). */
  components?: string[]
  /** Where the element is written, `file:line` (dev builds only). */
  source?: string
  image?: string
}
export interface BrowserBridge {
  command(workspaceId: string, command: BrowserCommand): Promise<BrowserState | null>
  selectElement(workspaceId: string): Promise<BrowserSelection | null>
  capture(workspaceId: string): Promise<{ base64: string; url: string }>
}

/** Only web pages. No file, app protocols, credentials or executable address-bar URLs. */
export function browserUrl(input: string): string {
  if (typeof input !== 'string' || input.length > 8192) throw new Error('Invalid browser URL')
  const value = input.trim()
  const url = new URL(/^https?:\/\//i.test(value) ? value : /^(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(value) ? `http://${value}` : `https://${value}`)
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || (!/^https?:\/\//i.test(value) && /^[a-z][a-z\d+.-]*:/i.test(value) && !/^(localhost|127\.0\.0\.1):\d/i.test(value))) throw new Error('Browser URLs must use HTTP or HTTPS without credentials')
  return url.href
}

export function isBrowserUrl(value: string): boolean {
  try { return /^https?:\/\//i.test(value) && browserUrl(value) === new URL(value).href } catch { return false }
}

/** DOM CSS pixels become native device-independent pixels at the renderer's zoom. */
export function browserBounds(bounds: BrowserBounds, zoom: number, size: readonly number[]): BrowserBounds | null {
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height, zoom].every(Number.isFinite) || zoom <= 0 || bounds.width <= 0 || bounds.height <= 0) return null
  const x = Math.max(0, Math.round(bounds.x * zoom))
  const y = Math.max(0, Math.round(bounds.y * zoom))
  const right = Math.min(size[0], Math.round((bounds.x + bounds.width) * zoom))
  const bottom = Math.min(size[1], Math.round((bounds.y + bounds.height) * zoom))
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

/** A picked element as a composer draft: where it is, what it says, its component and source, size, styles and HTML. */
export function browserSelectionText(t: TFunction, s: BrowserSelection): string {
  const lines = [t('browser.selectionContext', { selector: s.selector, url: s.url, text: s.text })]
  if (s.components?.length) lines.push(t('browser.selectionComponent', { names: s.components.join(' > ') }))
  if (s.source) lines.push(t('browser.selectionSource', { source: s.source }))
  if (s.size) lines.push(t('browser.selectionSize', { width: s.size.width, height: s.size.height }))
  if (s.styles.length) lines.push(t('browser.selectionStyles', { styles: s.styles.map(([name, value]) => `${name}: ${value}`).join('; ') }))
  if (s.html) lines.push(`${t('browser.selectionHtml')}\n${fenced(s.html, 'html')}`)
  return lines.join('\n')
}
