// What a chat item contributes to the search index and to the "message" count.
// Message text (user and assistant) and tool text are kept apart: tool output is
// large and noisy, so it is searched only when asked for.
import type { ChatItem } from './types'

export interface ItemText {
  text: string | null
  toolText: string | null
}

const TOOL_TEXT_LIMIT = 100_000

export function itemText(item: ChatItem): ItemText {
  if (item.kind === 'user' || item.kind === 'assistant') return { text: item.text || null, toolText: null }
  if (item.kind === 'tool') {
    let input = ''
    try {
      input = typeof item.input === 'string' ? item.input : JSON.stringify(item.input) ?? ''
    } catch {
      input = ''
    }
    const text = [item.name, input, item.output ?? ''].filter(Boolean).join('\n')
    return { text: null, toolText: text ? text.slice(0, TOOL_TEXT_LIMIT) : null }
  }
  return { text: null, toolText: null }
}

/** What stays of an item once its content is gone: enough to count turns, time and cost, nothing that was said. */
export function receiptOf(item: ChatItem): ChatItem {
  if (item.kind === 'result') return item
  if (item.kind === 'turn-end') return { kind: 'turn-end', id: item.id, turnId: item.turnId, outcome: item.outcome, durationMs: item.durationMs }
  if (item.kind === 'user') return { kind: 'user', id: item.id, turnId: item.turnId, text: '', at: item.at }
  // Not renderable as a real item; readers never see receipts.
  return { kind: 'notice', id: item.id, turnId: 'turnId' in item ? item.turnId : undefined, level: 'info', text: '' }
}
