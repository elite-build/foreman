// Whether the window can be seen. It keeps running in the background (backgroundThrottling is off, so agents' events,
// autosave and polling go on), which also means Chromium's Page Visibility API never says hidden. This tells the page
// instead, so it can stop drawing what nobody sees (renderer store: window-visibility).
//
// Minimized or hidden (macOS Hide, the tray) counts as not visible. Covered by other windows (occlusion) doesn't: Electron
// reports it reliably on neither Windows nor macOS.

/** The window events after which visibility may have changed. Restoring a maximized window says `maximize`, not `restore`. */
export const VISIBILITY_EVENTS = ['show', 'hide', 'minimize', 'restore', 'maximize', 'unmaximize', 'focus'] as const

export interface VisibilityTarget {
  isVisible(): boolean
  isMinimized(): boolean
  isDestroyed(): boolean
}

/** On Windows a minimized window is still "visible" to Electron, so both are asked. */
export function windowVisible(win: VisibilityTarget): boolean {
  return win.isVisible() && !win.isMinimized()
}

/** Sends the window's visibility when it changes (call `update` on VISIBILITY_EVENTS), and again to a page that (re)loaded. */
export class WindowVisibility {
  private sent: boolean | null = null

  constructor(
    private win: VisibilityTarget,
    private send: (visible: boolean) => void
  ) {}

  update(): void {
    if (this.win.isDestroyed()) return
    const visible = windowVisible(this.win)
    if (visible === this.sent) return
    this.sent = visible
    this.send(visible)
  }

  /** A page that just loaded knows nothing yet. */
  loaded(): void {
    this.sent = null
    this.update()
  }
}
