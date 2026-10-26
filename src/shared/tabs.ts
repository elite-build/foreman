// Naming a chat tab in words, for `foreman send` and its refusals.
import { AGENTS, modelInfo } from './agents'
import type { Session } from './types'

/** "Claude · Opus 5.5": the agent family and the model's name. */
export function tabModelText(session: Pick<Session, 'agent' | 'model'>): string {
  return `${AGENTS[session.agent].label.split(/\s+/)[0]} · ${modelInfo(session.agent, session.model).label}`
}

/** The open tabs of a workspace, one line each: index, title, model, status. */
export function tabListText(tabs: Pick<Session, 'title' | 'agent' | 'model' | 'status' | 'queue'>[]): string {
  const rows = tabs.map((t, i) => [String(i + 1), t.title || 'New chat', tabModelText(t), t.status === 'running' ? 'running' : 'idle', t.queue.length ? `${t.queue.length} queued` : ''])
  const widths = [0, 1, 2].map((c) => Math.max(...rows.map((r) => r[c].length)))
  return rows.map((r) => `  ${r[0].padStart(widths[0])}  ${r[1].padEnd(widths[1])}  ${r[2].padEnd(widths[2])}  ${[r[3], r[4]].filter(Boolean).join(', ')}`.trimEnd()).join('\n')
}

/** What was done with a message sent from outside the window. The turn id is the receipt. */
export function sendReceiptText(disposition: 'started' | 'queued' | 'steered', tab: number, session: Pick<Session, 'agent' | 'model'>, turnId: string): string {
  const verb = disposition === 'queued' ? 'Queued to' : disposition === 'steered' ? 'Steered into' : 'Sent to'
  return `${verb} tab ${tab} (${tabModelText(session)}) as turn ${turnId}`
}
