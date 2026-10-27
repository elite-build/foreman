/** How often a turn's streaming previews (shown, not saved) go out at most. */
export const PREVIEW_MS = 50

/**
 * Coalesces a turn's previews to one send per item per PREVIEW_MS window: an item's first preview in a window goes
 * at once, later ones wait for the window to end and go once. `send` builds the item from the turn's state when it
 * goes (and sends nothing when it is no longer a preview), so a preview never lands after the saved version of its item.
 */
export class PreviewThrottle {
  private sent = new Set<string>()
  private dirty = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private send: (id: string) => void,
    private ms = PREVIEW_MS
  ) {}

  mark(id: string): void {
    if (this.sent.has(id)) {
      this.dirty.add(id)
      return
    }
    this.sent.add(id)
    this.send(id)
    this.timer ??= setTimeout(() => this.flush(), this.ms)
  }

  private flush(): void {
    this.timer = null
    this.sent.clear()
    if (!this.dirty.size) return
    const ids = [...this.dirty]
    this.dirty.clear()
    for (const id of ids) this.mark(id)
  }

  /** The turn is over: nothing more goes out. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.sent.clear()
    this.dirty.clear()
  }
}
