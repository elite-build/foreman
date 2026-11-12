// Subagents as first-class (docs/agents.md 6). A subagent is a Task call whose own tool calls and messages are kept in the
// chat as items carrying `parentToolUseId`, the id of that call. Those items are detail of the child's row: everything that
// reads the chat as the parent agent's (its last answer, a hand-off, the search index, an export, the phone) leaves them out
// with `withoutChildren`, and the window draws them under the Task row with `childItemsOf`.
import type { ChatItem } from './types'

/** A call or message a subagent made (a nested Task call is one too). */
export type ChildItem = Extract<ChatItem, { kind: 'assistant' | 'thinking' | 'tool' }> & { parentToolUseId: string }
type ToolItem = Extract<ChatItem, { kind: 'tool' }>

export function isChildItem(item: ChatItem): item is ChildItem {
  return (item.kind === 'assistant' || item.kind === 'thinking' || item.kind === 'tool') && item.parentToolUseId !== undefined
}

/** The items the parent agent produced. The same array when no subagent did (so callers' memos stay equal). */
export function withoutChildren<T extends ChatItem>(items: readonly T[]): T[] {
  return (items.some(isChildItem) ? items.filter((i) => !isChildItem(i)) : items) as T[]
}

/** Each Task call's own items, in log order, by the call's id. Arrays are new on every call; the caller keeps what it can. */
export function childItemsOf(items: readonly ChatItem[]): Map<string, ChildItem[]> {
  const by = new Map<string, ChildItem[]>()
  for (const item of items) {
    if (!isChildItem(item)) continue
    const list = by.get(item.parentToolUseId)
    if (list) list.push(item)
    else by.set(item.parentToolUseId, [item])
  }
  return by
}

/** The tool names that start a subagent in Claude Code. */
export const SUBAGENT_TOOLS: readonly string[] = ['Task', 'Agent']

/** A Task call as a subagent: one the agent said started a task (so it can be named and stopped), or that has items of its own. */
export function isSubagentCall(item: ToolItem, hasItems = false): boolean {
  return SUBAGENT_TOOLS.includes(item.name) && (item.childId !== undefined || hasItems)
}

/** What a subagent is called on its row and in the card that asks on its behalf: what it was asked to do, else its type. */
export function subagentName(input: unknown, fallback = 'subagent'): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  for (const key of ['description', 'subagent_type', 'name']) {
    const v = i[key]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80)
  }
  return fallback
}
