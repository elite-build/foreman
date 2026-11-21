// What OpenCode's server says, in the chat's words: its tool calls in Claude Code's vocabulary (which the chat knows how
// to render), its questions as the question card's, and the card's answers back. Pure, so it is tested on its own.
import path from 'node:path'
import type { Question, SubagentRef } from '../../../shared/types'

type Input = Record<string, unknown>

export const MAX_TOOL_OUTPUT = 20_000

/** The tool names Foreman shows as a subagent's row (shared/subagents.ts SUBAGENT_TOOLS). */
export const TASK_TOOL = 'task'

function isRecord(value: unknown): value is Input {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function compact(input: Input): Input {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined))
}

/** A path as the chat shows it: absolute, resolved against the workspace. */
function file(raw: Input, cwd: string): string | undefined {
  const p = str(raw.filePath) ?? str(raw.file_path) ?? str(raw.path)
  return p ? path.resolve(cwd, p) : undefined
}

/** One OpenCode tool call (`tool` and its state's `input`) as the chat's tool row: a name it renders and that name's input. */
export function toolView(tool: string, rawInput: unknown, cwd: string): { name: string; input: Input } {
  const raw = isRecord(rawInput) ? rawInput : {}
  switch (tool) {
    case 'read':
      return { name: 'Read', input: compact({ file_path: file(raw, cwd), offset: raw.offset, limit: raw.limit }) }
    case 'write':
      return { name: 'Write', input: compact({ file_path: file(raw, cwd), content: str(raw.content) ?? '' }) }
    case 'edit':
      return { name: 'Edit', input: compact({ file_path: file(raw, cwd), old_string: str(raw.oldString) ?? '', new_string: str(raw.newString) ?? '', replace_all: raw.replaceAll === true ? true : undefined }) }
    case 'multiedit': {
      const edits = Array.isArray(raw.edits) ? raw.edits.filter(isRecord).map((e) => ({ old_string: str(e.oldString) ?? '', new_string: str(e.newString) ?? '' })) : []
      return { name: 'Edit', input: compact({ file_path: file(raw, cwd), edits }) }
    }
    case 'bash':
      return { name: 'Bash', input: compact({ command: str(raw.command) ?? '', description: str(raw.description) }) }
    case 'glob':
      return { name: 'Glob', input: compact({ pattern: str(raw.pattern) ?? '', path: str(raw.path) }) }
    case 'grep':
      return { name: 'Grep', input: compact({ pattern: str(raw.pattern) ?? '', path: str(raw.path), glob: str(raw.include) }) }
    case 'list':
      return { name: 'LS', input: compact({ path: file(raw, cwd) ?? path.resolve(cwd) }) }
    case 'webfetch':
      return { name: 'WebFetch', input: compact({ url: str(raw.url) ?? '' }) }
    case 'websearch':
    case 'codesearch':
      return { name: 'WebSearch', input: compact({ query: str(raw.query) ?? '' }) }
    case TASK_TOOL:
      return { name: 'Task', input: compact({ description: str(raw.description), prompt: str(raw.prompt), subagent_type: str(raw.subagent_type) }) }
    default:
      return { name: tool, input: raw }
  }
}

/** Tools whose rows the chat doesn't show: the todo list has its own card and a question is the question card. */
export function hiddenTool(tool: string): boolean {
  return tool === 'todowrite' || tool === 'todoread' || tool === 'question'
}

/** A tool's text for the row: its output, else its error, cut to what the chat keeps. */
export function toolOutput(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (truncated)` : text
}

/** The todo card's entries from OpenCode's `todo.updated` (content and status; its priority isn't shown). */
export function todoEntries(todos: unknown): { content: string; status: string }[] {
  if (!Array.isArray(todos)) return []
  return todos.filter(isRecord).map((t) => ({ content: String(t.content ?? ''), status: String(t.status ?? 'pending') === 'cancelled' ? 'completed' : String(t.status ?? 'pending') }))
}

export interface OpencodeQuestion {
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiple?: boolean
}

/** OpenCode's `question.asked` as the question card's questions. */
export function cardQuestions(questions: OpencodeQuestion[]): Question[] {
  return questions.map((q) => ({
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    ...(q.multiple ? { multiSelect: true } : {}),
    options: (q.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) }))
  }))
}

/**
 * The card's answers (by question text; a multi-select's choices and any typed answer joined with ", ") as OpenCode's
 * reply: one list of labels per question, in order. A multi-select's answer splits back only on its own option labels,
 * so a typed answer with a comma in it stays whole.
 */
export function questionAnswers(questions: OpencodeQuestion[], answers: Record<string, string> | undefined): string[][] {
  return questions.map((q) => {
    const answer = answers?.[q.question]?.trim()
    if (!answer) return []
    if (!q.multiple) return [answer]
    const labels = (q.options ?? []).map((o) => o.label)
    const picked: string[] = []
    let rest = answer
    for (;;) {
      const label = labels.find((l) => rest === l || rest.startsWith(`${l}, `))
      if (!label) break
      picked.push(label)
      rest = rest.slice(label.length).replace(/^, /, '')
      if (!rest) break
    }
    return rest ? [...picked, rest] : picked
  })
}

/** The subagent a child session is, as an approval or question names it: its session (what `stopChild` takes) and what it was asked to do. */
export function subagentRef(childSessionId: string, input: Input | undefined): SubagentRef {
  return { id: childSessionId, name: str(input?.description) ?? str(input?.subagent_type) ?? 'subagent' }
}

/** What an Always allow of an OpenCode permission request covers, as the card shows it: its `always` patterns. */
export function alwaysScope(permission: string, always: string[]): string | undefined {
  const patterns = always.filter((p) => p && p !== '*')
  if (!patterns.length) return always.includes('*') ? `every ${permission} request` : undefined
  return patterns.map((p) => `\`${p}\``).join(', ')
}
