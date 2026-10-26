// The one line a tool call is known by (its command, file or pattern), as plain text. Pure, so the renderer's tool rows
// and approval panels, the narrator and the CLI describe a call the same way.
import type { TFunction } from './i18n'
import { relativeToRoots } from './portable'

export type ToolRoot = string | string[]

/** One-line description of what a tool call does (also used by approval cards and the narrator). */
export function toolSummary(name: string, input: unknown, root: ToolRoot, t: TFunction): string {
  const i = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'Bash':
      return String(i.command ?? '')
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return relativeToRoots(i.file_path ?? i.notebook_path, root)
    case 'Grep':
      return i.path ? t('toolRow.summary.grepIn', { pattern: String(i.pattern ?? ''), path: relativeToRoots(i.path, root) }) : String(i.pattern ?? '')
    case 'Glob':
      return String(i.pattern ?? '')
    case 'WebFetch':
      return String(i.url ?? '')
    case 'WebSearch':
      return String(i.query ?? '')
    case 'Task':
    case 'Agent':
      return String(i.description ?? '')
    default:
      return ''
  }
}
