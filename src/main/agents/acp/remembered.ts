// "Always allow" kept by Foreman for an ACP agent's session (docs/agents.md 8, `session-always`): an allow the person chose to
// remember is keyed on what was allowed (the tool's kind and the normalised command, path, pattern or address), so it covers the
// same request again and nothing broader. The card names the scope. Pure: the adapter (index.ts) asks and answers.
import { workspaceRelative } from '../../../shared/permissions'

export interface Rememberable {
  /** What a later request must match: `execute:npm test`, `read:src/app.ts`. */
  key: string
  /** What the card shows: the command, the path, the pattern or the address. */
  scope: string
  /** The path a request names, for the check that agent and git configuration always asks (agentAccess.isCeilingProtected). */
  path?: string
}

/** A command as one line with single spaces: `npm  test` and `npm test` are one request. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

/**
 * A command line as the words a shell would give a program: split on spaces, a pair of single or double quotes holding one word
 * together (`node -e "console.log(1 + 1)"` is `node`, `-e`, `console.log(1 + 1)`). Not a shell: nothing is expanded, and a line with
 * an unclosed quote or an operator that chains commands (`;`, `&&`, `|`, `` ` ``, `$(`) has no words, so it matches nothing by words.
 */
export function commandWords(line: string): string[] | undefined {
  if (/[;&|`<>\n]|\$\(/.test(line.replace(/"[^"]*"|'[^']*'/g, ''))) return undefined
  const words: string[] = []
  let word: string | undefined
  let quote: string | undefined
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined
      else word += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      word ??= ''
    } else if (/\s/.test(ch)) {
      if (word !== undefined) words.push(word)
      word = undefined
    } else word = (word ?? '') + ch
  }
  if (quote) return undefined
  if (word !== undefined) words.push(word)
  return words
}

/** One command the person approved (the agent's execute tool call): the normalised line, and the words it comes to when it is one plain command. */
export interface ApprovedRun {
  line: string
  words?: string[]
}

export function approvedRun(command: string): ApprovedRun {
  return { line: normalizeCommand(command), words: commandWords(command) }
}

/** Whether the terminal the agent asked for (`command` and `args`, or one whole line as `command`) is exactly what was approved. */
export function matchesApproval(approved: ApprovedRun, command: string, args: readonly string[]): boolean {
  const line = normalizeCommand([command, ...args].join(' '))
  if (approved.line === line) return true
  const asked = args.length ? [command, ...args] : commandWords(command)
  return Boolean(approved.words && asked && approved.words.length === asked.length && approved.words.every((w, i) => w === asked[i]))
}

const slashes = (p: string) => p.replace(/\\/g, '/')

/** A path inside the workspace relative to it, else as given; one spelling (slashes, and case where the platform ignores it). */
export function normalizePath(path: string, root: string): string {
  const relative = workspaceRelative(path, root) ?? slashes(path)
  return /^[a-z]:\//i.test(relative) || /^[a-z]:[\\/]/i.test(root) ? relative.toLowerCase() : relative
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

/**
 * What a tool request is remembered by, in Claude Code's vocabulary (the adapter's `toolView`): a command, a read, a search or a
 * fetch. Edits are not here (Foreman's "allow edits this session" is theirs), and a request that names none of these has no key, so no
 * Always allow is offered for it.
 */
export function rememberable(view: { name: string; input: Record<string, unknown> }, root: string): Rememberable | undefined {
  const { name, input } = view
  switch (name) {
    case 'Bash': {
      const command = text(input.command)
      return command ? { key: `execute:${normalizeCommand(command)}`, scope: normalizeCommand(command) } : undefined
    }
    case 'Read': {
      const file = text(input.file_path)
      if (!file) return undefined
      const rel = normalizePath(file, root)
      return { key: `read:${rel}`, scope: rel, path: file }
    }
    case 'Glob':
    case 'Grep': {
      const pattern = text(input.pattern)
      if (!pattern) return undefined
      const where = text(input.path)
      return { key: `search:${name}:${pattern}|${where ? normalizePath(where, root) : ''}`, scope: pattern, ...(where ? { path: where } : {}) }
    }
    case 'WebFetch': {
      const url = text(input.url)
      return url ? { key: `fetch:${url.trim()}`, scope: url.trim() } : undefined
    }
    default:
      return undefined
  }
}

/** The scope as the card shows it: one line, cut at 80 characters. */
export function shownScope(scope: string): string {
  return scope.length > 80 ? `${scope.slice(0, 79)}…` : scope
}
