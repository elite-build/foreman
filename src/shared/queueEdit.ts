// Queue editing (#12): the pure pieces the main process and the composer share.
// A queued message is edited and moved where it sits, by its stable id, so it
// keeps its turn id and a `foreman wait` on that turn still answers. Each change
// to a tab's queue makes its next revision; an edit or move made against an
// older revision is refused rather than overwriting a change made elsewhere.
import type { QueueMove } from './types'

/** The queue with one message moved a place, or null when it isn't there or is already at that end. */
export function moveQueuedMessage<T extends { id: string }>(queue: readonly T[], id: string, direction: QueueMove): T[] | null {
  const from = queue.findIndex((m) => m.id === id)
  const to = direction === 'up' ? from - 1 : from + 1
  if (from < 0 || to < 0 || to >= queue.length) return null
  const next = [...queue]
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

/**
 * An edit is stale when its message was changed after the queue revision the editor opened at.
 * Other changes to the queue (a message sent, queued or moved) leave the edit valid.
 */
export function editIsStale(messageRevision: number | undefined, openedAt: number): boolean {
  return (messageRevision ?? 0) > openedAt
}

/** Text Foreman would act on itself instead of sending (see SessionService.handleCommand); it can't wait in the queue. */
export function isAppCommand(text: string): boolean {
  return /^\/(clear|plan|fast)$/.test(text.trim())
}

/** "3f9c2a1e…": a turn id short enough for a hint and still recognisable next to `foreman send`'s receipt. */
export function shortTurnId(turnId: string): string {
  return turnId.length > 8 ? `${turnId.slice(0, 8)}…` : turnId
}

/** ⌥↑ / ⌥↓ (Alt on Windows and Linux) on a focused queue row; anything else is not a move. */
export function queueMoveKey(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): QueueMove | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null
  return e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : null
}
