/** Desktop-only browser contract. Never exposed to page content, agents or the CLI. */
export type BrowserBounds = { x: number; y: number; width: number; height: number }
export type BrowserState = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string }
export type BrowserCommand =
  | { type: 'open' | 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'stop' | 'close' | 'focus' | 'cancel-selection' }
  | { type: 'bounds'; bounds: BrowserBounds | null }
export interface BrowserBridge {
  command(workspaceId: string, command: BrowserCommand): Promise<BrowserState | null>
  selectElement(workspaceId: string): Promise<{ url: string; selector: string; text: string } | null>
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
