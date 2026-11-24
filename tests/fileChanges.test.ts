// Agent-aware editor helpers: the base text of a file from its diff, line change blocks, reverting one block and
// the three-way merge of the user's unsaved edits with the agent's, including CRLF and the final newline.
import { describe, expect, it } from 'vitest'
import { baseText, changeBlocks, mergeEdits, revertBlock } from '../src/shared/fileChanges'
import type { DiffFile, DiffHunk } from '../src/shared/types'

function file(hunks: DiffHunk[], status: DiffFile['status'] = 'modified'): DiffFile {
  return { path: 'notes.txt', status, binary: false, additions: 0, deletions: 0, hunks }
}

// base 'one\ntwo\nthree\nfour\n' -> current 'one\nTWO\nthree\nfour\nfive\n'
const modifiedAndAdded: DiffHunk[] = [
  {
    header: '@@ -1,4 +1,5 @@',
    lines: [
      { type: 'ctx', text: 'one', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'two', oldNo: 2 },
      { type: 'add', text: 'TWO', newNo: 2 },
      { type: 'ctx', text: 'three', oldNo: 3, newNo: 3 },
      { type: 'ctx', text: 'four', oldNo: 4, newNo: 4 },
      { type: 'add', text: 'five', newNo: 5 },
    ],
  },
]
const current = 'one\nTWO\nthree\nfour\nfive\n'
const base = 'one\ntwo\nthree\nfour\n'

describe('baseText', () => {
  it('undoes modified and added lines in a hunk', () => {
    expect(baseText(current, file(modifiedAndAdded))).toBe(base)
  })

  it('undoes deleted lines in the middle of a hunk', () => {
    const hunks: DiffHunk[] = [
      {
        header: '@@ -1,4 +1,2 @@',
        lines: [
          { type: 'ctx', text: 'a', oldNo: 1, newNo: 1 },
          { type: 'del', text: 'b', oldNo: 2 },
          { type: 'del', text: 'c', oldNo: 3 },
          { type: 'ctx', text: 'd', oldNo: 4, newNo: 2 },
        ],
      },
    ]
    expect(baseText('a\nd\n', file(hunks))).toBe('a\nb\nc\nd\n')
  })

  it('restores a line deleted at the top, where the new-side header is +0,0', () => {
    const hunks: DiffHunk[] = [{ header: '@@ -1 +0,0 @@', lines: [{ type: 'del', text: 'x', oldNo: 1 }] }]
    expect(baseText('a\n', file(hunks))).toBe('x\na\n')
  })

  it('removes lines of an added file, whose base is empty', () => {
    expect(baseText('new\n', file([], 'added'))).toBe('')
  })

  it('returns null when the diff is stale for the current text', () => {
    expect(baseText('one\nOTHER\nthree\nfour\nfive\n', file(modifiedAndAdded))).toBeNull()
  })

  it('returns null for a binary file', () => {
    expect(baseText(current, { ...file(modifiedAndAdded), binary: true })).toBeNull()
  })
})

describe('changeBlocks', () => {
  it('finds a modified block and an added block with their line numbers', () => {
    expect(changeBlocks(base, current)).toEqual([
      {
        kind: 'modified',
        start: 2,
        end: 2,
        oldStart: 2,
        oldEnd: 2,
        oldLines: ['two'],
        newLines: ['TWO'],
      },
      {
        kind: 'added',
        start: 5,
        end: 5,
        oldStart: 5,
        oldEnd: 4,
        oldLines: [],
        newLines: ['five'],
      },
    ])
  })

  it('finds a removed block, placed after the current line it was removed after', () => {
    expect(changeBlocks('a\nb\nc\n', 'a\nc\n')).toEqual([
      { kind: 'removed', start: 1, end: 1, oldStart: 2, oldEnd: 2, oldLines: ['b'], newLines: [] },
    ])
  })

  it('reports a removed block at the top of the file as line 0', () => {
    expect(changeBlocks('x\na\n', 'a\n')).toEqual([
      { kind: 'removed', start: 0, end: 0, oldStart: 1, oldEnd: 1, oldLines: ['x'], newLines: [] },
    ])
  })

  it('gives no blocks for equal texts', () => {
    expect(changeBlocks('a\nb\n', 'a\nb\n')).toEqual([])
  })
})

describe('revertBlock', () => {
  it('puts back the base lines of a modified block', () => {
    const [modified] = changeBlocks(base, current)
    expect(revertBlock(current, modified)).toBe('one\ntwo\nthree\nfour\nfive\n')
  })

  it('removes the lines of an added block', () => {
    const [, added] = changeBlocks(base, current)
    expect(revertBlock(current, added)).toBe('one\nTWO\nthree\nfour\n')
  })

  it('inserts the base lines of a removed block after its line', () => {
    const [removed] = changeBlocks('a\nb\nc\n', 'a\nc\n')
    expect(revertBlock('a\nc\n', removed)).toBe('a\nb\nc\n')
  })
})

describe('mergeEdits', () => {
  const origin = 'a\nb\nc\nd\ne\n'

  it('applies edits made far apart on each side', () => {
    expect(mergeEdits(origin, 'a\nB\nc\nd\ne\n', 'a\nb\nc\nD\ne\n')).toBe('a\nB\nc\nD\ne\n')
  })

  it('counts an identical edit on both sides once', () => {
    expect(mergeEdits(origin, 'a\nB\nc\nd\ne\n', 'a\nB\nc\nd\ne\n')).toBe('a\nB\nc\nd\ne\n')
  })

  it('returns null when both sides change the same line differently', () => {
    expect(mergeEdits(origin, 'a\nB1\nc\nd\ne\n', 'a\nB2\nc\nd\ne\n')).toBeNull()
  })

  it('returns null when the blocks only touch', () => {
    expect(mergeEdits(origin, 'a\nB\nc\nd\ne\n', 'a\nb\nC\nd\ne\n')).toBeNull()
  })

  it('returns null when an insertion lands next to a change on the other side', () => {
    expect(mergeEdits(origin, 'a\nb\nX\nc\nd\ne\n', 'a\nb\nC\nd\ne\n')).toBeNull()
  })

  it('keeps an insertion and a change that do not touch', () => {
    expect(mergeEdits(origin, 'a\nb\nX\nc\nd\ne\n', 'a\nb\nc\nD\ne\n')).toBe('a\nb\nX\nc\nD\ne\n')
  })

  it('keeps CRLF line endings and the final newline of the user text', () => {
    expect(mergeEdits('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n', 'a\r\nb\r\nC\r\n')).toBe('a\r\nB\r\nC\r\n')
    expect(mergeEdits('a\nb\nc', 'a\nB\nc', 'a\nb\nc')).toBe('a\nB\nc')
  })
})

describe('line endings and the final newline', () => {
  it('keeps CRLF in baseText', () => {
    const hunks: DiffHunk[] = [
      {
        header: '@@ -1,2 +1,2 @@',
        lines: [
          { type: 'ctx', text: 'one', oldNo: 1, newNo: 1 },
          { type: 'del', text: 'two', oldNo: 2 },
          { type: 'add', text: 'TWO', newNo: 2 },
        ],
      },
    ]
    expect(baseText('one\r\nTWO\r\n', file(hunks))).toBe('one\r\ntwo\r\n')
  })

  it('keeps CRLF in revertBlock', () => {
    const [block] = changeBlocks('a\r\nb\r\n', 'a\r\nB\r\n')
    expect(revertBlock('a\r\nB\r\n', block)).toBe('a\r\nb\r\n')
  })

  it('keeps a missing final newline in revertBlock, and a present one', () => {
    const [block] = changeBlocks('a\nb', 'a\nB')
    expect(revertBlock('a\nB', block)).toBe('a\nb')
    const [withNewline] = changeBlocks('a\nb\n', 'a\nB\n')
    expect(revertBlock('a\nB\n', withNewline)).toBe('a\nb\n')
  })
})
