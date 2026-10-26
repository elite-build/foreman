// What still runs in a chat. The log keeps a tool call or background task as "running" if its turn ended without
// closing it (Foreman quit or crashed, or the background host was stopped), so only the turn running now counts.
import type { ChatItem } from './types'

/** The items as they should show: anything left running by a turn that isn't `liveTurnId` reads as stopped. */
export function settleItems(items: ChatItem[], liveTurnId: string | undefined): ChatItem[] {
  let changed = false
  const settled = items.map((item) => {
    if (item.kind !== 'tool' || item.turnId === liveTurnId) return item
    const call = item.status === 'running'
    const task = item.task?.status === 'running'
    if (!call && !task) return item
    changed = true
    return {
      ...item,
      ...(call ? { status: 'error' as const, output: item.output || 'Interrupted.' } : {}),
      ...(task ? { task: { ...item.task!, status: 'stopped' as const } } : {})
    }
  })
  return changed ? settled : items
}
