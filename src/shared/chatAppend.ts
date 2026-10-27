// Streaming previews as appends: an agent's text grows by a few words every 50 ms, so after the first
// preview of a block only the new text goes out. Sending the whole block each time costs bytes (and
// structured clones in main, preload and the renderer) that grow with the square of the message's length.
// A listener applies an append only when it holds the text it continues; otherwise it waits, and a
// whole preview (sent again every RESYNC_MS, also when the text stops growing: resync) or the finished
// item puts it right. Pure: main and renderer.
import type { ChatItem } from './types'

/** A streaming preview's text from offset `from` on is now `text` (the item had exactly `from` characters). */
export interface ChatAppend {
  itemId: string
  from: number
  text: string
}

type StreamingText = Extract<ChatItem, { kind: 'assistant' | 'thinking' }>

/** How long a growing preview goes out as appends before it is sent whole again (for a listener that missed one). */
export const RESYNC_MS = 2000

function streamingText(item: ChatItem): item is StreamingText {
  return (item.kind === 'assistant' || item.kind === 'thinking') && item.streaming === true
}

/** The item with the append applied, or null when the append doesn't continue it (missed, or not a streaming preview). */
export function appendText(item: ChatItem, append: ChatAppend): ChatItem | null {
  if (item.id !== append.itemId || !streamingText(item) || item.text.length !== append.from) return null
  return { ...item, text: item.text + append.text }
}

/** A chat's items with the append applied to its item (looked for from the end, where streaming happens), or null when it doesn't apply. */
export function appendToItems(items: readonly ChatItem[], append: ChatAppend): ChatItem[] | null {
  let index = items.length - 1
  while (index >= 0 && items[index].id !== append.itemId) index--
  if (index === -1) return null
  const item = appendText(items[index], append)
  if (!item) return null
  const next = items.slice()
  next[index] = item
  return next
}

export type Encoded = { item: ChatItem } | { append: ChatAppend }

/**
 * Turns one listener's stream of chat items into whole items and appends. Saved (not transient) items always go
 * whole and end their preview; a preview goes whole the first time, when it isn't a continuation of what was sent,
 * and every RESYNC_MS. Null: nothing changed since the last send.
 */
export class PreviewEncoder {
  // `appended`: appends went out since the preview last went whole.
  private sent = new Map<string, { item: StreamingText; fullAt: number; appended?: boolean }>()

  constructor(
    private now: () => number = Date.now,
    private resyncMs = RESYNC_MS
  ) {}

  encode(item: ChatItem, transient: boolean): Encoded | null {
    if (!transient || !streamingText(item)) {
      this.sent.delete(item.id)
      return { item }
    }
    const prev = this.sent.get(item.id)
    const now = this.now()
    if (prev && prev.item.kind === item.kind && prev.item.turnId === item.turnId && now - prev.fullAt < this.resyncMs && item.text.startsWith(prev.item.text)) {
      const from = prev.item.text.length
      if (item.text.length === from) return null
      this.sent.set(item.id, { item, fullAt: prev.fullAt, appended: true })
      return { append: { itemId: item.id, from, text: item.text.slice(from) } }
    }
    this.sent.set(item.id, { item, fullAt: now })
    return { item }
  }

  /**
   * Previews that went out as appends and last went whole RESYNC_MS ago or more, marked as sent whole now: for a timer
   * to send whole, so a listener that missed an append is put right even while the text stops growing (an agent pausing).
   */
  resync(): ChatItem[] {
    const now = this.now()
    const out: ChatItem[] = []
    for (const [id, sent] of this.sent) {
      if (!sent.appended || now - sent.fullAt < this.resyncMs) continue
      this.sent.set(id, { item: sent.item, fullAt: now })
      out.push(sent.item)
    }
    return out
  }

  /** Whether any preview went out as appends since it last went whole (a resync may be owed). */
  appending(): boolean {
    for (const sent of this.sent.values()) if (sent.appended) return true
    return false
  }

  /** The listener starts over (it reconnected, or the chat was replaced): the next preview of each item goes whole. */
  clear(): void {
    this.sent.clear()
  }
}

/** The receiving side of a PreviewEncoder for a listener that needs whole items: it keeps each preview's text. */
export class PreviewDecoder {
  private previews = new Map<string, ChatItem>()

  /** A whole item: remembered while it is a streaming preview, forgotten once saved. */
  item(item: ChatItem, transient: boolean): void {
    if (transient && streamingText(item)) this.previews.set(item.id, item)
    else this.previews.delete(item.id)
  }

  /** The whole preview after this append, or null when it doesn't continue the one held (a resync will follow). */
  append(append: ChatAppend): ChatItem | null {
    const prev = this.previews.get(append.itemId)
    const next = prev ? appendText(prev, append) : null
    if (next) this.previews.set(append.itemId, next)
    return next
  }

  clear(): void {
    this.previews.clear()
  }
}
