// A chat as Markdown, for copying. Built from the chat's latest-version items
// (what store.readChat returns). Attachment contents are never included, only
// their names; thinking and internal items are left out.
import type { ChatItem } from './types'

export interface TranscriptOptions {
  /** Include each tool call with its input summary and output. */
  toolOutput: boolean
}

const SUMMARY_KEYS = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description']

function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of SUMMARY_KEYS) if (typeof record[key] === 'string' && record[key]) return record[key] as string
  return ''
}

/** A code fence longer than any backtick run inside the text. */
function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}\n${text.replace(/\n$/, '')}\n${fence}`
}

export function chatToMarkdown(items: ChatItem[], options: TranscriptOptions): string {
  const blocks: string[] = []
  let lastRole = ''
  const push = (role: string, heading: string | null, body: string) => {
    if (heading && role !== lastRole) blocks.push(heading)
    blocks.push(body)
    lastRole = role
  }
  for (const item of items) {
    if (item.kind === 'user') {
      const names = (item.attachments ?? []).map((a) => a.name)
      const body = [item.text.trim(), names.length ? `_Attachments: ${names.join(', ')}_` : ''].filter(Boolean).join('\n\n')
      lastRole = ''
      push('user', item.steered ? '## You (sent while the agent worked)' : '## You', body)
      lastRole = ''
    } else if (item.kind === 'notice' && item.switched) {
      // O1: where the chat switched agents, so the answers after it read as the other agent's.
      push('switch', null, `_${item.text}_`)
    } else if (item.kind === 'assistant') {
      if (item.text.trim()) push('assistant', '## Assistant', item.text.trim())
    } else if (item.kind === 'tool' && options.toolOutput) {
      const summary = toolSummary(item.input)
      const head = `**Tool: ${item.name}**${summary ? ` \`${summary.replace(/`/g, "'").split('\n')[0]}\`` : ''}${item.status === 'error' ? ' (error)' : ''}`
      push('tool', null, item.output?.trim() ? `${head}\n\n${fenced(item.output)}` : head)
    }
  }
  return blocks.join('\n\n') + (blocks.length ? '\n' : '')
}
