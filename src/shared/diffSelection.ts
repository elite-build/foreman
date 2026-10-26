// #15 Diff selection actions: lines picked in a diff become a diff comment
// (Explain / Change this / Ask, or a plain one) quoting them, with the side,
// the range and which diff they came from. Before it goes to a tab the lines
// are compared with the file again; changed lines hold the comment.
import type { ChatItem, DiffComment, DiffLine, DiffScope, DiffSelection } from './types'

export type SelectionAction = DiffSelection['action']
export type Side = DiffSelection['side']

/** What each action starts the comment with. Explain is complete; the others are finished by the user. */
export const SELECTION_PREFIX: Record<Exclude<SelectionAction, 'comment'>, string> = {
  explain: 'Explain: what these lines do and why.',
  change: 'Change this: ',
  ask: 'Ask: '
}

const PREFIXES = ['Explain:', 'Change this:', 'Ask:']

/** The comment's text split at its prefix, so the prefix can be drawn bold. */
export function splitPrefix(body: string): { prefix: string; rest: string } {
  const prefix = PREFIXES.find((p) => body.startsWith(p))
  return prefix ? { prefix, rest: body.slice(prefix.length) } : { prefix: '', rest: body }
}

/** Selection actions only where comments are: All changes and Uncommitted (O5). */
export function canSelect(scope: DiffScope | undefined): scope is 'all' | 'uncommitted' {
  return scope === 'all' || scope === 'uncommitted'
}

const numberOn = (line: DiffLine, side: Side) => (side === 'new' ? line.newNo : line.oldNo)

/**
 * The lines from `anchor` to `focus` on one side, as shown. Lines of the other
 * side in between are left out (a selection is one side's whole lines); a
 * range running into lines that aren't shown stops at the anchor's last
 * unbroken line, so the quote is always contiguous.
 */
export function pickLines(shown: readonly DiffLine[], side: Side, anchor: number, focus: number): { start: number; end: number; lines: string[] } | null {
  const text = new Map<number, string>()
  for (const line of shown) {
    const no = numberOn(line, side)
    if (no !== undefined && !text.has(no)) text.set(no, line.text)
  }
  if (!text.has(anchor)) return null
  const lo = Math.min(anchor, focus)
  const hi = Math.max(anchor, focus)
  let start = anchor
  let end = anchor
  while (start - 1 >= lo && text.has(start - 1)) start--
  while (end + 1 <= hi && text.has(end + 1)) end++
  const lines: string[] = []
  for (let n = start; n <= end; n++) lines.push(text.get(n)!)
  return { start, end, lines }
}

/** The payload a selection action carries: the quoted text, its side and range, and the diff identity. */
export function buildSelection(input: {
  shown: readonly DiffLine[]
  side: Side
  anchor: number
  focus: number
  action: SelectionAction
  scope: 'all' | 'uncommitted'
  file: { path: string; oldPath?: string; blobId?: string }
  mergeBase?: string
  at: string
}): DiffSelection | null {
  const picked = pickLines(input.shown, input.side, input.anchor, input.focus)
  if (!picked) return null
  return {
    action: input.action,
    side: input.side,
    ...picked,
    scope: input.scope,
    oldPath: input.file.oldPath && input.file.oldPath !== input.file.path ? input.file.oldPath : undefined,
    // The blob is the new side's version; the old side is pinned by the base.
    blobId: input.side === 'new' ? input.file.blobId : undefined,
    mergeBase: input.mergeBase,
    at: input.at
  }
}

/** A file's text as lines; line endings don't count, and a final newline doesn't make another line. */
function fileLines(content: string): string[] {
  const all = content.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (all.length && all[all.length - 1] === '') all.pop()
  return all
}

/** Lines start..end (1-based) of a file's text, or null when it has fewer lines. */
export function linesAt(content: string, start: number, end: number): string[] | null {
  const all = fileLines(content)
  if (start < 1 || end > all.length || end < start) return null
  return all.slice(start - 1, end)
}

export type Freshness = { stale: false } | { stale: true; lines: string[] }

/**
 * Whether the selected lines read the same in `content` (the file on that side
 * now, or null when it is gone). Only those lines count: edits elsewhere in the
 * file don't make a selection stale, lines shifted under it do.
 */
export function checkSelection(selection: Pick<DiffSelection, 'start' | 'end' | 'lines'>, content: string | null): Freshness {
  // What the range holds now (cut short when the file got shorter).
  const now = content === null ? [] : fileLines(content).slice(selection.start - 1, selection.end)
  const same = now.length === selection.lines.length && now.every((l, i) => l === selection.lines[i])
  return same ? { stale: false } : { stale: true, lines: now }
}

export interface QuoteChange {
  kind: 'same' | 'add' | 'del'
  text: string
  // Its line number now (same and add).
  no?: number
}

/** What changed between the quoted lines and the lines now, line by line (longest common run), for Review. */
export function quoteChanges(before: readonly string[], after: readonly string[], start: number): QuoteChange[] {
  const n = before.length
  const m = after.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: QuoteChange[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      out.push({ kind: 'same', text: after[j], no: start + j })
      i++
      j++
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      out.push({ kind: 'del', text: before[i++] })
    } else {
      out.push({ kind: 'add', text: after[j], no: start + j++ })
    }
  }
  return out
}

/** "lines 40–46" or "line 40". */
export const rangeText = (s: Pick<DiffSelection, 'start' | 'end'>) => (s.start === s.end ? `line ${s.start}` : `lines ${s.start}–${s.end}`)

/**
 * The message a selection action sends: the comment, then where the lines are
 * and the lines themselves. It is what the tab shows as the user's message.
 */
export function selectionMessage(comment: Pick<DiffComment, 'file' | 'body' | 'selection' | 'outdated'>): string {
  const sel = comment.selection
  if (!sel) return comment.body
  const where = `${comment.file} · ${rangeText(sel)} · ${sel.side === 'new' ? 'new side' : `old side${sel.oldPath ? ` (${sel.oldPath})` : ''}`}`
  const note = comment.outdated ? '\n(Outdated: these lines have changed since they were selected; this is how they read then.)' : ''
  const fence = sel.lines.some((l) => l.includes('```')) ? '````' : '```'
  return `${comment.body.trim()}\n\n${where}${note}\n${fence}\n${sel.lines.join('\n')}\n${fence}`
}

/**
 * The tab a selection goes to unless another is picked: the one last used for
 * this in the workspace, else the tab on screen, else the first; 'new' when
 * none is open (a new chat is only made if that is what is sent to).
 */
export function defaultTab(open: readonly string[], lastUsed: string | undefined, active: string | undefined): string {
  if (lastUsed && open.includes(lastUsed)) return lastUsed
  if (active && open.includes(active)) return active
  return open[0] ?? 'new'
}

// ---- G2: which tab changed the lines ----

/** A tool input's file, when it names one (Edit, Write, MultiEdit, NotebookEdit, apply_patch-style paths). */
function toolPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const o = input as Record<string, unknown>
  const out: string[] = []
  for (const key of ['file_path', 'path', 'notebook_path', 'filePath']) if (typeof o[key] === 'string') out.push(o[key] as string)
  // Codex / ACP file changes list several.
  for (const key of ['changes', 'files', 'locations']) {
    const list = o[key]
    if (Array.isArray(list)) for (const x of list) if (x && typeof x === 'object' && typeof (x as { path?: unknown }).path === 'string') out.push((x as { path: string }).path)
  }
  return out
}

/** Whether a path a tool named is the workspace file `file` (relative, or absolute inside the worktree). */
export function sameFile(named: string, file: string): boolean {
  const a = named.replace(/\\/g, '/').replace(/^\.\//, '')
  const b = file.replace(/\\/g, '/')
  return a === b || a.endsWith(`/${b}`)
}

/**
 * G2 (#15): the tabs whose turns touched `file` since `since`, from what Foreman recorded: a turn's checkpoint
 * delta (files it changed) or a finished tool call naming the file. Turns that ended before the selection don't
 * count. Empty: no tab did, so the change came from somewhere Foreman can't see (the user, a script) and the
 * review says who is unknown rather than guessing.
 */
export function editorsSince(file: string, since: string, chats: { sessionId: string; items: ChatItem[] }[]): string[] {
  const from = Date.parse(since)
  const found: string[] = []
  for (const { sessionId, items } of chats) {
    const started = new Map<string, number>()
    const ended = new Map<string, number>()
    const touched = new Set<string>()
    for (const item of items) {
      if (item.kind === 'user') started.set(item.turnId, Date.parse(item.at))
      else if (item.kind === 'turn-end') {
        const start = started.get(item.turnId)
        if (start !== undefined) ended.set(item.turnId, start + (item.durationMs ?? 0))
        if (item.delta?.files.some((f) => sameFile(f.path, file))) touched.add(item.turnId)
      } else if (item.kind === 'tool' && item.status === 'done' && toolPaths(item.input).some((p) => sameFile(p, file))) touched.add(item.turnId)
    }
    // A turn still running (no end) counts; one that ended before the selection doesn't.
    const counts = [...touched].some((turnId) => (ended.get(turnId) ?? Infinity) >= from)
    if (counts) found.push(sessionId)
  }
  return found
}
