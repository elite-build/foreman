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

/**
 * Each Task call's own items, in log order, by the call's id. Arrays are new on every call; the caller keeps what it can.
 * A resumed subagent's frames still name the call that first started it, so what it does after a SendMessage resumed it
 * goes under that SendMessage call (the latest call with its task id), not back under the first one.
 */
export function childItemsOf(items: readonly ChatItem[]): Map<string, ChildItem[]> {
  const by = new Map<string, ChildItem[]>()
  const taskOf = new Map<string, string>()
  const latest = new Map<string, string>()
  for (const item of items) {
    if (item.kind === 'tool' && item.childId !== undefined && SUBAGENT_TOOLS.includes(item.name)) {
      taskOf.set(item.id, item.childId)
      latest.set(item.childId, item.id)
    }
    if (!isChildItem(item)) continue
    const task = taskOf.get(item.parentToolUseId)
    const parent = (task !== undefined && latest.get(task)) || item.parentToolUseId
    const list = by.get(parent)
    if (list) list.push(item)
    else by.set(parent, [item])
  }
  return by
}

/**
 * The tool names that start a subagent in Claude Code, or start one again: SendMessage to a background agent that has
 * finished resumes it, and the SDK starts its task (the same task id) on that call. A SendMessage that only passes a
 * message on starts none, so it gets no `childId` and stays an ordinary call.
 */
export const SUBAGENT_TOOLS: readonly string[] = ['Task', 'Agent', 'SendMessage']

/** A Task call as a subagent: one the agent said started a task (so it can be named and stopped), or that has items of its own. */
export function isSubagentCall(item: ToolItem, hasItems = false): boolean {
  return SUBAGENT_TOOLS.includes(item.name) && (item.childId !== undefined || hasItems)
}

/**
 * What a subagent is called on its row and in the card that asks on its behalf: what it was asked to do, else its type;
 * for a SendMessage that resumed one, the line the agent wrote to sum up the message.
 */
export function subagentName(input: unknown, fallback = 'subagent'): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  for (const key of ['description', 'subagent_type', 'name', 'summary']) {
    const v = i[key]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80)
  }
  return fallback
}
