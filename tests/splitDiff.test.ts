import { describe, expect, it } from 'vitest'
import { contextGaps, diffLayout, fileLines, hiddenBefore, parseHunkHeader, splitRows, SPLIT_MIN_WIDTH } from '../src/shared/splitDiff'
import type { DiffHunk, DiffLine } from '../src/shared/types'

const ctx = (oldNo: number, newNo: number, text = `c${newNo}`): DiffLine => ({ type: 'ctx', text, oldNo, newNo })
const del = (oldNo: number, text = `old${oldNo}`): DiffLine => ({ type: 'del', text, oldNo })
const add = (newNo: number, text = `new${newNo}`): DiffLine => ({ type: 'add', text, newNo })
// Each row as "old|new" line numbers, "_" for an empty side.
const shape = (lines: DiffLine[]) => splitRows(lines).map((r) => `${r.left?.oldNo ?? '_'}|${r.right?.newNo ?? '_'}`)

describe('splitRows', () => {
  it('puts context lines on both sides with their own numbers', () => {
    const rows = splitRows([ctx(10, 12), ctx(11, 13)])
    expect(rows).toHaveLength(2)
    expect(rows[0].left).toBe(rows[0].right)
    expect(shape([ctx(10, 12), ctx(11, 13)])).toEqual(['10|12', '11|13'])
  })

  it('pads pure additions and pure deletions with empty cells', () => {
    expect(shape([ctx(1, 1), add(2), add(3), ctx(2, 4)])).toEqual(['1|1', '_|2', '_|3', '2|4'])
    expect(shape([ctx(1, 1), del(2), del(3), ctx(4, 2)])).toEqual(['1|1', '2|_', '3|_', '4|2'])
  })

  it('pairs a modification line by line', () => {
    const rows = splitRows([del(5, 'a'), add(5, 'b')])
    expect(rows).toEqual([{ left: del(5, 'a'), right: add(5, 'b') }])
  })

  it('pairs uneven blocks in order and pads the shorter side', () => {
    // The mock's 3 deletions against 2 additions, then 1 against 3.
    expect(shape([ctx(34, 34), del(35), del(36), del(37), add(35), add(36), ctx(38, 37)])).toEqual(['34|34', '35|35', '36|36', '37|_', '38|37'])
    expect(shape([del(2), add(2), add(3), add(4)])).toEqual(['2|2', '_|3', '_|4'])
  })

  it('keeps separate change runs apart', () => {
    expect(shape([del(1), add(1), ctx(2, 2), del(3), del(4), add(3)])).toEqual(['1|1', '2|2', '3|3', '4|_'])
    // A deletion after additions starts a new run rather than pairing backwards.
    expect(shape([add(1), del(1), add(2)])).toEqual(['_|1', '1|2'])
  })

  it('handles an empty hunk', () => {
    expect(splitRows([])).toEqual([])
  })
})

describe('diffLayout', () => {
  it('shows split when there is room', () => {
    expect(diffLayout('split', SPLIT_MIN_WIDTH)).toEqual({ layout: 'split', narrow: false, forced: false })
    expect(diffLayout('split', 1400)).toEqual({ layout: 'split', narrow: false, forced: false })
  })

  it('falls back to unified below the minimum width and says so', () => {
    expect(SPLIT_MIN_WIDTH).toBe(900)
    expect(diffLayout('split', SPLIT_MIN_WIDTH - 1)).toEqual({ layout: 'unified', narrow: true, forced: false })
    expect(diffLayout('split', 400)).toEqual({ layout: 'unified', narrow: true, forced: false })
  })

  it('never reports narrow for unified, and keeps the choice before the width is known', () => {
    expect(diffLayout('unified', 300)).toEqual({ layout: 'unified', narrow: false, forced: false })
    expect(diffLayout('split', null)).toEqual({ layout: 'split', narrow: false, forced: false })
  })

  // G3: "Force split" below the width limit.
  it('keeps split at any width when forced, and says it is forced only below the limit', () => {
    expect(diffLayout('split', 400, true)).toEqual({ layout: 'split', narrow: false, forced: true })
    expect(diffLayout('split', SPLIT_MIN_WIDTH, true)).toEqual({ layout: 'split', narrow: false, forced: false })
    expect(diffLayout('unified', 400, true)).toEqual({ layout: 'unified', narrow: false, forced: false })
    expect(diffLayout('split', null, true)).toEqual({ layout: 'split', narrow: false, forced: false })
  })
})

describe('hunk context', () => {
  // A 12-line file where line 4 changed and line 9 was inserted (old had 11 lines).
  const now = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`)
  const hunks: DiffHunk[] = [
    { header: '@@ -3,3 +3,3 @@', lines: [ctx(3, 3, 'line 3'), del(4, 'old 4'), add(4, 'line 4'), ctx(5, 5, 'line 5')] },
    { header: '@@ -8,2 +8,3 @@ function f() {', lines: [ctx(8, 8, 'line 8'), add(9, 'line 9'), ctx(9, 10, 'line 10')] }
  ]

  it('parses hunk headers, with a missing count as 1', () => {
    expect(parseHunkHeader('@@ -33,11 +33,19 @@ export function Sidebar() {')).toEqual({ oldStart: 33, oldCount: 11, newStart: 33, newCount: 19 })
    expect(parseHunkHeader('@@ -1 +1,0 @@')).toEqual({ oldStart: 1, oldCount: 1, newStart: 1, newCount: 0 })
    expect(parseHunkHeader('not a header')).toBeNull()
  })

  it('counts the hidden lines before each hunk from the headers', () => {
    expect(hiddenBefore(hunks)).toEqual([2, 2])
    expect(hiddenBefore([{ header: '@@ -1,6 +1,6 @@', lines: [] }])).toEqual([0])
    expect(hiddenBefore([{ header: 'garbage', lines: [] }])).toBeNull()
  })

  it('rebuilds the unchanged lines with both line numbers', () => {
    const gaps = contextGaps(hunks, now.join('\n') + '\n')!
    expect(gaps).toHaveLength(3)
    expect(gaps[0]).toEqual([ctx(1, 1, 'line 1'), ctx(2, 2, 'line 2')])
    expect(gaps[1]).toEqual([ctx(6, 6, 'line 6'), ctx(7, 7, 'line 7')])
    // After the insertion the old numbers run one behind.
    expect(gaps[2]).toEqual([ctx(10, 11, 'line 11'), ctx(11, 12, 'line 12')])
    expect(gaps.slice(0, 2).map((g) => g.length)).toEqual(hiddenBefore(hunks))
  })

  it('handles a pure deletion hunk with an empty new range', () => {
    const lines = ['a', 'b', 'c', 'd']
    const gaps = contextGaps([{ header: '@@ -3,2 +2,0 @@', lines: [del(3, 'x'), del(4, 'y')] }], lines.join('\n'))!
    expect(gaps[0]).toEqual([ctx(1, 1, 'a'), ctx(2, 2, 'b')])
    expect(gaps[1]).toEqual([ctx(5, 3, 'c'), ctx(6, 4, 'd')])
  })

  it('refuses a file that no longer matches the diff', () => {
    const edited = [...now]
    edited[3] = 'someone changed line 4 again'
    expect(contextGaps(hunks, edited.join('\n'))).toBeNull()
    // Shorter than the hunks say.
    expect(contextGaps(hunks, now.slice(0, 6).join('\n'))).toBeNull()
  })

  it('ignores CRLF endings and the final newline', () => {
    expect(fileLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(fileLines('')).toEqual([])
    expect(contextGaps(hunks, now.join('\r\n'))).not.toBeNull()
  })
})

// G3 · O6: the sensitive-alert diff's context comes from the turn's end checkpoint, not the working tree.
describe('context from a checkpoint (sensitive alert)', () => {
  it('reads the file as the ref has it, and the gaps rebuild from it', async () => {
    const { fileAtRef } = await import('../src/main/diff')
    const { git } = await import('../src/main/git')
    const { commit, makeRepo } = await import('./helpers')
    const { writeFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const repo = await makeRepo({ 'conf.txt': `${lines.join('\n')}\n` })
    const start = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()
    lines[14] = 'line 15 changed'
    await writeFile(path.join(repo, 'conf.txt'), `${lines.join('\n')}\n`)
    await git(repo, ['add', '-A'])
    await commit(repo, 'turn end')
    const end = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()
    // The working tree moves on after the turn; the checkpoint doesn't.
    await writeFile(path.join(repo, 'conf.txt'), 'rewritten since\n')
    const content = await fileAtRef(repo, end, 'conf.txt')
    expect(content).toEqual({ content: `${lines.join('\n')}\n`, binary: false, tooLarge: false })
    const { refsDiff } = await import('../src/main/diff')
    const diff = await refsDiff(repo, start, end, ['conf.txt'])
    const gaps = contextGaps(diff.files[0].hunks, content.content)
    expect(gaps?.[0].length).toBe(11)
    expect(gaps?.[0][0]).toMatchObject({ newNo: 1, oldNo: 1, text: 'line 1' })
    await expect(fileAtRef(repo, end, 'missing.txt')).rejects.toThrow(/isn’t in that checkpoint/)
    await expect(fileAtRef(repo, '--output=x', 'conf.txt')).rejects.toThrow()
  })
})
