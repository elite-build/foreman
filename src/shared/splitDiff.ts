// The split (side-by-side) diff and its context: pairing a hunk's lines into
// old | new rows, when the panel is too narrow for two columns, and the
// unchanged lines between hunks, rebuilt from the file as it is now.
import type { DiffHunk, DiffLine } from './types'

export type DiffLayout = 'unified' | 'split'

/** Below this diff width each side of a split would wrap nearly every line, so it shows unified. */
export const SPLIT_MIN_WIDTH = 900

/**
 * What to draw for the chosen layout at this width. A too-narrow split shows
 * unified and says so (`narrow`), but the choice itself stays split. An
 * unmeasured width (null) keeps the choice. G3: `force` ("Force split") keeps
 * split at any width; `forced` says it is showing split below the limit.
 */
export function diffLayout(choice: DiffLayout, width: number | null, force = false): { layout: DiffLayout; narrow: boolean; forced: boolean } {
  const below = choice === 'split' && width !== null && width < SPLIT_MIN_WIDTH
  const narrow = below && !force
  return { layout: narrow ? 'unified' : choice, narrow, forced: below && force }
}

/** One row of a split diff. Null is a side with no line here (drawn hatched). */
export interface SplitRow {
  left: DiffLine | null
  right: DiffLine | null
}

/**
 * Pairs a hunk's lines into old | new rows. Context lines sit on both sides;
 * each run of changes puts its deletions on the left and its additions on the
 * right, paired in order, and the shorter side is padded with empty cells.
 */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null })
    dels = []
    adds = []
  }
  for (const line of lines) {
    if (line.type === 'del') {
      // A deletion after additions starts a new run (git doesn't emit this, but keep the order honest).
      if (adds.length) flush()
      dels.push(line)
    } else if (line.type === 'add') adds.push(line)
    else {
      flush()
      rows.push({ left: line, right: line })
    }
  }
  flush()
  return rows
}

interface HunkRange {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

/** `@@ -a,b +c,d @@`; a missing count is 1. Null when the header isn't one. */
export function parseHunkHeader(header: string): HunkRange | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)
  if (!m) return null
  return { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]) }
}

// The first line a range covers; an empty range (count 0) names the line before it.
const first = (start: number, count: number) => (count === 0 ? start + 1 : start)

/** Unchanged lines hidden before each hunk (from the headers alone). Null if a header doesn't parse. */
export function hiddenBefore(hunks: readonly DiffHunk[]): number[] | null {
  const counts: number[] = []
  let next = 1
  for (const hunk of hunks) {
    const r = parseHunkHeader(hunk.header)
    if (!r) return null
    const start = first(r.newStart, r.newCount)
    counts.push(Math.max(0, start - next))
    next = start + r.newCount
  }
  return counts
}

/** A file's text as lines, without a final empty one after the last newline, and without CRs. */
export function fileLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * The unchanged lines around the hunks, as context lines with both numbers:
 * one list before each hunk, plus one after the last (so hunks.length + 1).
 * `content` is the new side of the file. Null when it doesn't match the diff
 * (the file changed since, or a header is malformed), so nothing is guessed.
 */
export function contextGaps(hunks: readonly DiffHunk[], content: string): DiffLine[][] | null {
  const lines = fileLines(content)
  const gaps: DiffLine[][] = []
  let nextOld = 1
  let nextNew = 1
  const take = (oldNo: number, from: number, to: number): DiffLine[] => {
    const gap: DiffLine[] = []
    for (let n = from; n < to; n++) gap.push({ type: 'ctx', text: lines[n - 1], oldNo: oldNo + (n - from), newNo: n })
    return gap
  }
  for (const hunk of hunks) {
    const r = parseHunkHeader(hunk.header)
    if (!r) return null
    const oldFirst = first(r.oldStart, r.oldCount)
    const newFirst = first(r.newStart, r.newCount)
    // Between hunks both sides are the same lines, so they skip the same amount.
    if (newFirst - nextNew !== oldFirst - nextOld || newFirst - 1 > lines.length) return null
    for (const line of hunk.lines) {
      if (line.newNo !== undefined && lines[line.newNo - 1] !== line.text) return null
    }
    gaps.push(take(nextOld, nextNew, newFirst))
    nextOld = oldFirst + r.oldCount
    nextNew = newFirst + r.newCount
  }
  if (nextNew - 1 > lines.length) return null
  gaps.push(take(nextOld, nextNew, lines.length + 1))
  return gaps
}
