// Line-level changes of a file against its base (the merge base of the branch): the gutter markers, revert of one
// change, and merging the user's unsaved edits with the agent's edits. Pure: the caller supplies both texts.
import type { DiffFile } from './types'

/**
 * A run of changed lines. Line numbers are 1-based and inclusive.
 * - `start..end` are lines of the current text. For 'removed' nothing is in the current text, so start = end = the
 *   current line after which the lines were removed (0 at the top of the file).
 * - `oldStart..oldEnd` are lines of the base text. For 'added' nothing is in the base text, so oldEnd = oldStart - 1
 *   and oldStart is the base line before which the lines were inserted (oldEnd is the base line after which they go).
 * oldLines are the base lines the block replaces; newLines are the current lines it stands for.
 */
export interface ChangeBlock {
  kind: 'added' | 'modified' | 'removed'
  start: number
  end: number
  oldStart: number
  oldEnd: number
  oldLines: string[]
  newLines: string[]
}

type Eol = '\r\n' | '\n'

// Above this many cells the LCS table is skipped and the whole middle of the file is one block.
const MAX_LCS_CELLS = 4_000_000

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

/** A text's lines as the editor counts them: no trailing '\r', and a final newline doesn't add an empty line. */
function linesOf(text: string): string[] {
  const all = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  if (all.length && all[all.length - 1] === '') all.pop()
  return all
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** The EOL a text uses: '\r\n' when it contains one, else '\n'. */
function eolOf(text: string): Eol {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** Lines joined with an EOL; a final newline is kept only when the source had one. No lines means an empty text. */
function textOf(lines: string[], eol: Eol, finalNewline: boolean): string {
  if (lines.length === 0) return ''
  return lines.join(eol) + (finalNewline ? eol : '')
}

/**
 * The file as it was at the base, by undoing `file`'s hunks on `current`. Returns null when the diff no longer
 * matches `current` (a stale diff), or when the file is binary. An added file's base is ''.
 */
export function baseText(current: string, file: DiffFile): string | null {
  if (file.binary) return null
  if (file.status === 'added') return ''
  const lines = linesOf(current)
  const out: string[] = []
  let cursor = 0 // 0-based index of the next current line that has not been copied yet
  for (const hunk of file.hunks) {
    const match = HUNK_HEADER.exec(hunk.header)
    if (!match) return null
    const newStart = Number(match[1])
    const newCount = match[2] === undefined ? 1 : Number(match[2])
    // "+c,0" means the hunk sits after line c; otherwise its first new-side line is line c.
    const first = newCount === 0 ? newStart : newStart - 1
    if (first < cursor || first > lines.length) return null
    for (; cursor < first; cursor++) out.push(lines[cursor])
    for (const line of hunk.lines) {
      const text = stripCr(line.text)
      if (line.type === 'del') {
        out.push(text)
        continue
      }
      // ctx and add lines are on the current side: they must be the current line at their newNo.
      if (line.newNo !== cursor + 1 || lines[cursor] !== text) return null
      if (line.type === 'ctx') out.push(text)
      cursor++
    }
  }
  for (; cursor < lines.length; cursor++) out.push(lines[cursor])
  return textOf(out, eolOf(current), current.endsWith('\n'))
}

type Op = 'eq' | 'del' | 'add'

/** The line edit script from a to b. Above MAX_LCS_CELLS it is all deletions then all additions. */
function editScript(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  const ops: Op[] = []
  if (n * m > MAX_LCS_CELLS) {
    for (let i = 0; i < n; i++) ops.push('del')
    for (let j = 0; j < m; j++) ops.push('add')
    return ops
  }
  // lcs[i * width + j] is the LCS length of a[i..] and b[j..].
  const width = m + 1
  const lcs = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('eq')
      i++
      j++
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      ops.push('del')
      i++
    } else {
      ops.push('add')
      j++
    }
  }
  while (i < n) {
    ops.push('del')
    i++
  }
  while (j < m) {
    ops.push('add')
    j++
  }
  return ops
}

/** The changed blocks from `base` to `current`, in order. Equal texts give no blocks. */
export function changeBlocks(base: string, current: string): ChangeBlock[] {
  const a = linesOf(base)
  const b = linesOf(current)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }
  const ops = editScript(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix))

  const blocks: ChangeBlock[] = []
  let run: { aStart: number; bStart: number; dels: string[]; adds: string[] } | null = null
  const flush = () => {
    if (!run) return
    const kind: ChangeBlock['kind'] =
      run.dels.length && run.adds.length ? 'modified' : run.adds.length ? 'added' : 'removed'
    blocks.push({
      kind,
      start: kind === 'removed' ? run.bStart : run.bStart + 1,
      end: kind === 'removed' ? run.bStart : run.bStart + run.adds.length,
      oldStart: run.aStart + 1,
      oldEnd: run.aStart + run.dels.length,
      oldLines: run.dels,
      newLines: run.adds,
    })
    run = null
  }
  let ia = prefix
  let ib = prefix
  for (const op of ops) {
    if (op === 'eq') {
      flush()
      ia++
      ib++
      continue
    }
    if (!run) run = { aStart: ia, bStart: ib, dels: [], adds: [] }
    if (op === 'del') {
      run.dels.push(a[ia])
      ia++
    } else {
      run.adds.push(b[ib])
      ib++
    }
  }
  flush()
  return blocks
}

/** `current` with one block undone: its current lines replaced by its base lines. */
export function revertBlock(current: string, block: ChangeBlock): string {
  const lines = linesOf(current)
  const from = block.kind === 'removed' ? block.start : block.start - 1
  const count = block.kind === 'removed' ? 0 : block.end - block.start + 1
  const next = lines.slice(0, from).concat(block.oldLines, lines.slice(from + count))
  return textOf(next, eolOf(current), current.endsWith('\n'))
}

/** Lines a block covers in base coordinates, as a closed interval; an insertion is the point it goes in at. */
function baseSpan(block: ChangeBlock): { lo: number; hi: number } {
  return { lo: block.oldStart - 1, hi: block.oldEnd }
}

function sameEdit(x: ChangeBlock, y: ChangeBlock): boolean {
  return (
    x.oldStart === y.oldStart &&
    x.oldEnd === y.oldEnd &&
    x.newLines.length === y.newLines.length &&
    x.newLines.every((line, i) => line === y.newLines[i])
  )
}

/**
 * Three-way merge: `mine` (the user's unsaved text) and `theirs` (the agent's) both edited from `base`. Returns the
 * merged text, or null when a block of one overlaps or touches a different block of the other. Identical blocks
 * count once. The result uses mine's EOL and final newline.
 */
export function mergeEdits(base: string, mine: string, theirs: string): string | null {
  const mineBlocks = changeBlocks(base, mine)
  const theirBlocks = changeBlocks(base, theirs)
  const applied: ChangeBlock[] = [...mineBlocks]
  for (const t of theirBlocks) {
    let identical = false
    for (const m of mineBlocks) {
      if (sameEdit(m, t)) {
        identical = true
        continue
      }
      const sm = baseSpan(m)
      const st = baseSpan(t)
      if (sm.lo <= st.hi && st.lo <= sm.hi) return null
    }
    if (!identical) applied.push(t)
  }
  let result = linesOf(base)
  // Blocks from one side never touch, so applying from the bottom up keeps earlier positions valid.
  applied.sort((x, y) => y.oldStart - x.oldStart)
  for (const block of applied) {
    const { lo, hi } = baseSpan(block)
    result = result.slice(0, lo).concat(block.newLines, result.slice(hi))
  }
  return textOf(result, eolOf(mine), mine.endsWith('\n'))
}
