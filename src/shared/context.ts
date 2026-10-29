// What Foreman added to a message, described from the strings that were really assembled for the agent.
// This is a receipt for Foreman's additions only. It says nothing about the agent's own context.
import { createT, type Locale, type TFunction } from './i18n'
import { formatNumber } from './i18n/time'
import type { IntegrationService } from './integrations'
import type { ContextPart, DiffComment } from './types'

const enT = createT('en')

export const RECEIPT_DISCLAIMER = "This is what Foreman added, not the agent's full context."

export interface AssembledAdditions {
  // The text appended to the agent's system prompt, and whether it holds the repository's standing instructions.
  instructions: string
  hasStanding: boolean
  // The note text appended to the message, and its revision.
  noteText: string
  noteRevision?: number
  // The comments block appended to the message, and the comments it was made from.
  commentsText: string
  comments: Pick<DiffComment, 'file' | 'line'>[]
  // The attachment note appended to the message, and the files it names (sizes when known).
  attachmentText: string
  attachments: { name: string; bytes?: number }[]
  // A fork's carried history, put before the message.
  historyText?: string
  // O1: where that history came from, when not a fork (a switch of agent), and that its oldest part was left out.
  historySource?: string
  historyCut?: boolean
  // O1: the note an agent resuming its own conversation got of what was said meanwhile, and where it came from.
  catchUpText?: string
  catchUpSource?: string
  // #2: what "Teach agents Foreman" appended to the system prompt, and the commands it lists.
  foremanText?: string
  foremanCommands?: string[]
  // #20: the repo MCP servers this turn got, only when that set differs from the tab's last turn ([] = it now gets none).
  repoMcp?: string[]
  // Integrations: services whose account changed since the tab's last turn, and the user's own servers newly switched off.
  integrations?: { changed: { service: IntegrationService; was?: string; now?: string }[]; ownOff: string[] }
}

const SERVICE_LABEL: Record<IntegrationService, string> = { github: 'GitHub', linear: 'Linear', slack: 'Slack', langfuse: 'Langfuse', vercel: 'Vercel', docker: 'Docker', e2b: 'E2B', daytona: 'Daytona' }

// The labels and sources are in `t`'s language; main records them in English.
export function contextParts(a: AssembledAdditions, t: TFunction = enT): ContextPart[] {
  const parts: ContextPart[] = []
  if (a.instructions.trim()) {
    parts.push({
      kind: 'instructions',
      label: t('context.instructions.label'),
      size: a.instructions.length,
      unit: 'chars',
      source: a.hasStanding ? t('context.instructions.sourceStanding') : t('context.instructions.source')
    })
  }
  if (a.foremanText?.trim()) {
    parts.push({
      kind: 'foreman',
      label: t('context.foreman.label'),
      size: new TextEncoder().encode(a.foremanText).length,
      unit: 'bytes',
      source: t('context.foreman.source'),
      detail: a.foremanCommands?.length ? a.foremanCommands.join(', ') : undefined
    })
  }
  if (a.noteText && a.noteRevision !== undefined) {
    parts.push({ kind: 'note', label: t('chat.noteTag', { revision: a.noteRevision }), size: a.noteText.length, unit: 'chars', source: t('context.note.source'), revision: a.noteRevision })
  }
  if (a.commentsText && a.comments.length) {
    parts.push({
      kind: 'comments',
      label: t('context.comments.label', { count: a.comments.length }),
      size: a.commentsText.length,
      unit: 'chars',
      source: t('context.comments.source'),
      detail: a.comments.map((c) => `${c.file}:${c.line}`).join(', ')
    })
  }
  if (a.attachmentText && a.attachments.length) {
    const known = a.attachments.every((f) => f.bytes !== undefined)
    parts.push({
      kind: 'attachments',
      label: t('context.attachments.label', { count: a.attachments.length }),
      size: known ? a.attachments.reduce((sum, f) => sum + (f.bytes ?? 0), 0) : a.attachmentText.length,
      unit: known ? 'bytes' : 'chars',
      source: t('context.attachments.source'),
      detail: a.attachments.map((f) => f.name).join(', ')
    })
  }
  if (a.historyText) {
    parts.push({
      kind: 'history',
      label: t('context.history.label'),
      size: a.historyText.length,
      unit: 'chars',
      source: a.historySource ?? t('context.history.source'),
      detail: a.historyCut ? t('context.history.cut') : undefined
    })
  }
  if (a.catchUpText) {
    parts.push({ kind: 'catch-up', label: t('context.catchUp.label'), size: a.catchUpText.length, unit: 'chars', source: a.catchUpSource ?? t('context.catchUp.source') })
  }
  if (a.repoMcp) {
    parts.push({
      kind: 'mcp',
      label: a.repoMcp.length ? t('context.mcp.label', { names: a.repoMcp.join(', ') }) : t('context.mcp.none'),
      size: a.repoMcp.length,
      unit: 'servers',
      source: a.repoMcp.length ? t('context.mcp.source') : t('context.mcp.noneSource')
    })
  }
  if (a.integrations && (a.integrations.changed.length || a.integrations.ownOff.length)) {
    const labels = a.integrations.changed.map((c) => {
      const service = SERVICE_LABEL[c.service]
      if (!c.now) return t('context.integrations.none', { service })
      return c.was ? t('context.integrations.changed', { service, now: c.now, was: c.was }) : t('context.integrations.now', { service, now: c.now })
    })
    if (a.integrations.ownOff.length) labels.push(t('context.integrations.ownOff', { names: a.integrations.ownOff.join(', ') }))
    parts.push({
      kind: 'integrations',
      label: labels.join(' · '),
      size: a.integrations.changed.length + a.integrations.ownOff.length,
      unit: 'accounts',
      source: t('context.integrations.source')
    })
  }
  return parts
}

/** "Foreman added: standing instructions · note r3 · 2 review comments", or null when nothing was added. */
export function receiptLine(parts: ContextPart[] | undefined, t: TFunction = enT): string | null {
  return parts?.length ? t('context.receipt', { parts: parts.map((p) => p.label).join(' · ') }) : null
}

/** "1,234 chars", "2 KB", "3 servers"; `locale` groups the digits. */
export function partSize(part: ContextPart, t: TFunction = enT, locale: Locale = 'en'): string {
  if (part.unit === 'servers') return t('context.size.servers', { count: part.size })
  if (part.unit === 'accounts') return t('context.size.accounts', { count: part.size })
  if (part.unit === 'chars') return t('context.size.chars', { n: formatNumber(part.size, locale) })
  if (part.size < 1024) return t('context.size.bytes', { n: part.size })
  return part.size < 1024 * 1024 ? t('context.size.kb', { n: Math.round(part.size / 1024) }) : t('context.size.mb', { n: (part.size / 1024 / 1024).toFixed(1) })
}

/** Pending comments of this workspace that the next message will carry. */
export function pendingComments(comments: DiffComment[], workspaceId: string): DiffComment[] {
  return comments.filter((c) => c.workspaceId === workspaceId && c.author === 'user' && c.state === 'pending')
}
