// Terminal selection → chat (#10): output selected in a terminal, Run or Setup
// tab becomes a labelled block in a composer ("From Terminal 1 · kigali · 14:06
// · 18 lines"). It is part of the draft and never sent on its own. On send it
// reaches the agent as a fenced block under a plain label line; over the cap it
// becomes a text attachment instead, like a long paste.
import type { TFunction } from './i18n'

/** Longer selections go in as a text attachment (the same 5,000 as long pastes). */
export const TERMINAL_SNIPPET_MAX_CHARS = 5000

/** Where the text came from: a numbered terminal tab (with its name once renamed, O3), the Run tab or the Setup log. */
// G4: `view` is another terminal view (a shell snippet's output, MCP sign-in), named by the caller.
export type SnippetSource = { kind: 'terminal'; n: number; name?: string } | { kind: 'run' } | { kind: 'setup' } | { kind: 'view'; name: string }

export interface TerminalSnippet {
  id: string
  source: SnippetSource
  // The workspace's name, as the sidebar shows it.
  workspace: string
  // When it was captured (ms since the epoch).
  at: number
  // Cleaned: no colour or cursor codes, no trailing whitespace.
  text: string
  lines: number
}

// CSI (colours, cursor moves), OSC (titles, links; ended by BEL or ST), DCS/SOS/PM/APC strings,
// other escapes (charset, keypad mode, save/restore cursor), and 8-bit CSI.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?\x1b\\|\x1b[ -/]*[0-~]|\x9b[0-?]*[ -/]*[@-~]/g
// Other control characters, keeping tab and newline (and \r, handled per line).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** Text with colour, cursor and other escape codes removed. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(CONTROL, '')
}

/**
 * Selected terminal text, ready to quote: escape codes gone, line endings as \n, a carriage return
 * keeping only what was drawn last on its line (progress bars), trailing whitespace trimmed from every
 * line, and blank lines at either end dropped. Indentation is kept.
 */
export function cleanTerminalText(raw: string): string {
  const lines = stripAnsi(raw)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const parts = line.split('\r').filter((part) => part !== '')
      return (parts[parts.length - 1] ?? '').trimEnd()
    })
  let start = 0
  let end = lines.length
  while (start < end && !lines[start]) start++
  while (end > start && !lines[end - 1]) end--
  return lines.slice(start, end).join('\n')
}

export function countLines(text: string): number {
  return text ? text.split('\n').length : 0
}

/** 24-hour "14:06" in local time, as the label shows it. */
export function snippetClock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The source's name in English, for what the agent receives ("Terminal 1", "Run", "Setup"). */
export function sourceName(source: SnippetSource): string {
  if (source.kind === 'terminal') return source.name || `Terminal ${source.n}`
  if (source.kind === 'view') return source.name
  return source.kind === 'run' ? 'Run' : 'Setup'
}

let snippetCounter = 0

/** A snippet from a raw selection, or null when nothing but whitespace was selected. */
export function makeSnippet(raw: string, source: SnippetSource, workspace: string, at: number): TerminalSnippet | null {
  const text = cleanTerminalText(raw)
  if (!text) return null
  return { id: `snippet-${at}-${++snippetCounter}`, source, workspace, at, text, lines: countLines(text) }
}

/** Over the cap, a snippet goes in as a text attachment rather than a block. */
export function snippetIsTooLong(snippet: Pick<TerminalSnippet, 'text'>): boolean {
  return snippet.text.length > TERMINAL_SNIPPET_MAX_CHARS
}

/** A backtick fence longer than any run of backticks in the text, so it can't close early. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** The label line the agent sees: "From Terminal 1 (kigali), 14:06:". */
export function snippetHeading(snippet: Pick<TerminalSnippet, 'source' | 'workspace' | 'at'>): string {
  return `From ${sourceName(snippet.source)} (${snippet.workspace}), ${snippetClock(snippet.at)}:`
}

/** One snippet as the agent receives it: the label line, then the text in a fenced block. */
export function formatSnippetBlock(snippet: TerminalSnippet): string {
  const fence = fenceFor(snippet.text)
  return `${snippetHeading(snippet)}\n${fence}text\n${snippet.text}\n${fence}`
}

/** The message sent: each snippet's block, in the order inserted, then what the user typed. */
export function composeMessage(snippets: readonly TerminalSnippet[], text: string): string {
  return [...snippets.map(formatSnippetBlock), text.trim()].filter(Boolean).join('\n\n')
}

/** The text attachment's contents when a snippet is over the cap: the label line, then the text. */
export function snippetAttachmentText(snippet: TerminalSnippet): string {
  return `${snippetHeading(snippet)}\n\n${snippet.text}\n`
}

/** "Terminal 1 output.txt", then "Terminal 1 output 2.txt", … skipping names already used. */
export function snippetAttachmentName(source: SnippetSource, taken: ReadonlySet<string>): string {
  const stem = `${sourceName(source)} output`
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}.txt` : `${stem} ${n}.txt`
    if (!taken.has(name)) return name
  }
}

/** The first non-blank line, for the collapsed block's preview. */
export function snippetPreview(snippet: Pick<TerminalSnippet, 'text'>): string {
  return snippet.text.split('\n').find((line) => line.trim()) ?? ''
}

/** The source as the UI names it, in the user's language. */
export function snippetSourceLabel(source: SnippetSource, t: TFunction): string {
  if (source.kind === 'terminal') return source.name || t('terminalChat.source.terminal', { n: source.n })
  if (source.kind === 'view') return source.name
  return t(source.kind === 'run' ? 'terminalChat.source.run' : 'terminalChat.source.setup')
}

/** The collapsed block's label: "From Terminal 1 · kigali · 14:06 · 18 lines". */
export function snippetLabel(snippet: Pick<TerminalSnippet, 'source' | 'workspace' | 'at' | 'lines'>, t: TFunction): string {
  return t('terminalChat.label', { source: snippetSourceLabel(snippet.source, t), workspace: snippet.workspace, time: snippetClock(snippet.at), count: snippet.lines })
}

/**
 * ⌘L on macOS, Ctrl+L elsewhere, with no other modifier. In a terminal with a selection it sends the
 * selection to chat; otherwise it keeps its old meaning (focus the composer; ^L in a Windows shell).
 */
export function isSendShortcut(e: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, platform: string | undefined): boolean {
  if (e.code !== 'KeyL' || e.altKey || e.shiftKey) return false
  return platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

// ---- G4 #10: trimming a waiting block, and the sent message's blocks ----

/** A waiting block after the user trimmed (edited) its text: line endings normalised, the line count redone. */
export function editSnippet<T extends Pick<TerminalSnippet, 'text' | 'lines'>>(snippet: T, text: string): T {
  const clean = text.replace(/\r\n?/g, '\n')
  return { ...snippet, text: clean, lines: countLines(clean) }
}

/** A terminal block as found at the start of a sent message: its label parts and its text. */
export interface SentSnippet {
  source: string
  workspace: string
  time: string
  text: string
  lines: number
}

/**
 * A sent message split into the terminal blocks composeMessage put first and the text typed after them,
 * so the chat can draw the blocks styled rather than as raw fences. A message that doesn't start with
 * one comes back whole as text; so does anything that only looks like a block halfway.
 */
export function splitSentMessage(message: string): { snippets: SentSnippet[]; text: string } {
  const snippets: SentSnippet[] = []
  let rest = message
  const block = /^From (.+?) \(([^()\n]*)\), (\d{2}:\d{2}):\n(`{3,})text\n([\s\S]*?)\n\4(?:\n\n|\n?$)/
  for (let m = block.exec(rest); m; m = block.exec(rest)) {
    snippets.push({ source: m[1], workspace: m[2], time: m[3], text: m[5], lines: countLines(m[5]) })
    rest = rest.slice(m[0].length)
  }
  return { snippets, text: rest }
}

/**
 * Which chat a terminal selection goes to: the one picked last from the menu's chat list when it's still
 * open, else the active chat, else the first open one. Undefined with none open (a new chat is made).
 */
export function chooseSnippetTarget(open: readonly string[], remembered: string | undefined, active: string | undefined): string | undefined {
  if (remembered && open.includes(remembered)) return remembered
  if (active && open.includes(active)) return active
  return open[0]
}
