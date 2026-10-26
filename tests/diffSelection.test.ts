// #15 Diff selection actions: the selection payload, the prefixes and the message, staleness against the file,
// tab defaulting, and the main-process send path (checked, queued, held, re-quoted) in a real temp repo.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSelection,
  canSelect,
  checkSelection,
  defaultTab,
  linesAt,
  pickLines,
  quoteChanges,
  SELECTION_PREFIX,
  selectionMessage,
  splitPrefix
} from '../src/shared/diffSelection'
import { commentsBlock } from '../src/shared/prompts'
import { DiffSelectionService } from '../src/main/diffSelections'
import { git } from '../src/main/git'
import type { DiffComment, DiffLine, DiffSelection, Session, Workspace } from '../src/shared/types'
import { commit, makeRepo } from './helpers'

// A hunk like the mock's: lines 35–37 replaced by 35–36, then 40–46 added.
const hunk: DiffLine[] = [
  { type: 'ctx', text: 'const repos = useStore()', oldNo: 33, newNo: 33 },
  { type: 'del', text: 'const [repo, setRepo] = useState(null)', oldNo: 34 },
  { type: 'del', text: 'const [filter, setFilter] = useState("all")', oldNo: 35 },
  { type: 'add', text: 'const view = useStore((s) => s.view)', newNo: 34 },
  { type: 'ctx', text: 'const [query, setQuery] = useState("")', oldNo: 36, newNo: 35 },
  { type: 'add', text: '// fall back to All', newNo: 36 },
  { type: 'add', text: 'useEffect(() => {', newNo: 37 },
  { type: 'add', text: '}, [repo])', newNo: 38 }
]
const file = { path: 'src/Sidebar.tsx', blobId: 'b10b', oldPath: undefined as string | undefined }

describe('the selection payload', () => {
  it('quotes the selected lines with side, range and the diff identity', () => {
    const sel = buildSelection({ shown: hunk, side: 'new', anchor: 36, focus: 38, action: 'explain', scope: 'all', file, mergeBase: 'base1', at: '2026-10-22T14:06:00Z' })
    expect(sel).toEqual({
      action: 'explain',
      side: 'new',
      start: 36,
      end: 38,
      lines: ['// fall back to All', 'useEffect(() => {', '}, [repo])'],
      scope: 'all',
      oldPath: undefined,
      blobId: 'b10b',
      mergeBase: 'base1',
      at: '2026-10-22T14:06:00Z'
    })
  })

  it('a range is one side’s whole lines: the other side’s lines in between are left out', () => {
    // Dragged upwards from 36 to 33 on the new side: deletions 34–35 (old) are not in the quote.
    expect(pickLines(hunk, 'new', 36, 33)).toEqual({
      start: 33,
      end: 36,
      lines: ['const repos = useStore()', 'const view = useStore((s) => s.view)', 'const [query, setQuery] = useState("")', '// fall back to All']
    })
    // The old side: deletions and context, by old numbers.
    expect(pickLines(hunk, 'old', 34, 36)?.lines).toEqual(['const [repo, setRepo] = useState(null)', 'const [filter, setFilter] = useState("all")', 'const [query, setQuery] = useState("")'])
  })

  it('the old side carries no blob (the base pins it) and keeps a renamed file’s old path', () => {
    const sel = buildSelection({ shown: hunk, side: 'old', anchor: 35, focus: 34, action: 'change', scope: 'uncommitted', file: { ...file, oldPath: 'src/Old.tsx' }, mergeBase: 'head1', at: 'now' })
    expect(sel).toMatchObject({ side: 'old', start: 34, end: 35, blobId: undefined, oldPath: 'src/Old.tsx', mergeBase: 'head1', scope: 'uncommitted' })
  })

  it('stops at lines that are not shown, so the quote is contiguous', () => {
    const twoHunks: DiffLine[] = [...hunk, { type: 'ctx', text: 'far away', oldNo: 90, newNo: 92 }]
    expect(pickLines(twoHunks, 'new', 37, 92)).toMatchObject({ start: 37, end: 38 })
    expect(pickLines(twoHunks, 'new', 92, 37)).toMatchObject({ start: 92, end: 92 })
    // An anchor that isn't on that side picks nothing.
    expect(pickLines(hunk, 'old', 38, 38)).toBeNull()
  })

  it('only on sources where comments are', () => {
    expect(canSelect('all')).toBe(true)
    expect(canSelect('uncommitted')).toBe(true)
    for (const scope of ['staged', 'last-commit', 'last-3', 'picked', 'pr', 'commit'] as const) expect(canSelect(scope)).toBe(false)
    expect(canSelect(undefined)).toBe(false)
  })
})

describe('prefixes and the message', () => {
  it('uses the mock’s fixed Explain text and prefills the others', () => {
    expect(SELECTION_PREFIX.explain).toBe('Explain: what these lines do and why.')
    expect(SELECTION_PREFIX.change).toBe('Change this: ')
    expect(SELECTION_PREFIX.ask).toBe('Ask: ')
    expect(splitPrefix('Change this: move it')).toEqual({ prefix: 'Change this:', rest: ' move it' })
    expect(splitPrefix('plain words')).toEqual({ prefix: '', rest: 'plain words' })
  })

  const sel: DiffSelection = { action: 'explain', side: 'new', start: 40, end: 41, lines: ['a()', 'b()'], scope: 'all', at: 'now' }

  it('the message is the comment, where the lines are, and the lines', () => {
    expect(selectionMessage({ file: 'src/Sidebar.tsx', body: SELECTION_PREFIX.explain, selection: sel })).toBe(
      'Explain: what these lines do and why.\n\nsrc/Sidebar.tsx · lines 40–41 · new side\n```\na()\nb()\n```'
    )
    const old = selectionMessage({ file: 'src/a.ts', body: 'Ask: why?', selection: { ...sel, side: 'old', start: 7, end: 7, lines: ['x ``` y'], oldPath: 'src/b.ts' }, outdated: true })
    expect(old).toContain('src/a.ts · line 7 · old side (src/b.ts)')
    expect(old).toContain('Outdated: these lines have changed since they were selected')
    // A quote holding a fence gets a longer one.
    expect(old).toContain('````\nx ``` y\n````')
  })

  it('a plain comment on selected lines goes with the next message quoting them', () => {
    const plain = { file: 'src/a.ts', line: 41, body: 'nit', selection: { ...sel, action: 'comment' as const } } as DiffComment
    expect(commentsBlock([plain])).toContain('- src/a.ts:40-41 (new side) — nit\n    > a()\n    > b()')
    expect(commentsBlock([{ file: 'src/a.ts', line: 3, body: 'old style' } as DiffComment])).toContain('- src/a.ts:3 — old style')
  })
})

describe('staleness against the file', () => {
  const selected: Pick<DiffSelection, 'start' | 'end' | 'lines'> = { start: 2, end: 3, lines: ['two', 'three'] }

  it('the same lines at the same numbers are fresh, whatever changed elsewhere', () => {
    expect(checkSelection(selected, 'one\ntwo\nthree\nfour\n')).toEqual({ stale: false })
    expect(checkSelection(selected, 'one\ntwo\nthree\nFOUR CHANGED\nfive\n')).toEqual({ stale: false })
    expect(checkSelection(selected, 'one\r\ntwo\r\nthree\r\n')).toEqual({ stale: false })
  })

  it('edited or shifted lines are stale, with what is there now', () => {
    expect(checkSelection(selected, 'one\ntwo\nTHREE\n')).toEqual({ stale: true, lines: ['two', 'THREE'] })
    expect(checkSelection(selected, 'zero\none\ntwo\nthree\n')).toEqual({ stale: true, lines: ['one', 'two'] })
    expect(checkSelection(selected, 'one\ntwo\n')).toEqual({ stale: true, lines: ['two'] })
    expect(checkSelection(selected, null)).toEqual({ stale: true, lines: [] })
  })

  it('linesAt is 1-based and refuses ranges past the end', () => {
    expect(linesAt('a\nb\nc\n', 2, 3)).toEqual(['b', 'c'])
    expect(linesAt('a\nb\n', 2, 3)).toBeNull()
  })

  it('Review shows what changed line by line', () => {
    expect(quoteChanges(['a', 'b', 'c'], ['a', 'B', 'c', 'd'], 10)).toEqual([
      { kind: 'same', text: 'a', no: 10 },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B', no: 11 },
      { kind: 'same', text: 'c', no: 12 },
      { kind: 'add', text: 'd', no: 13 }
    ])
  })
})

describe('tab defaulting', () => {
  it('the tab last used here, else the one on screen, else the first, else a new chat', () => {
    expect(defaultTab(['t1', 't2'], 't2', 't1')).toBe('t2')
    expect(defaultTab(['t1', 't2'], 'closed', 't1')).toBe('t1')
    expect(defaultTab(['t1', 't2'], undefined, 'gone')).toBe('t1')
    expect(defaultTab([], 't1', 't1')).toBe('new')
  })
})

describe('sending a selection (main process, real repo)', () => {
  const fileText = (edit: Record<number, string> = {}) => Array.from({ length: 8 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'
  let dir: string
  let ws: Workspace
  let comments: DiffComment[]
  let sessions: Session[]
  let send: ReturnType<typeof vi.fn<(sessionId: string, text: string) => Promise<unknown>>>
  let service: DiffSelectionService
  const tab = (id: string, patch: Partial<Session> = {}) => ({ id, workspaceId: 'w1', agent: 'claude', model: 'm', status: 'idle', queue: [], ...patch }) as unknown as Session
  const newSide = (start: number, end: number, lines: string[]): DiffSelection => ({ action: 'change', side: 'new', start, end, lines, scope: 'all', at: '2026-10-22T14:06:00Z' })

  beforeEach(async () => {
    dir = await makeRepo({ 'a.txt': fileText() })
    await git(dir, ['checkout', '-q', '-b', 'feature'])
    await writeFile(path.join(dir, 'a.txt'), fileText({ 3: 'NEW three', 4: 'NEW four' }))
    ws = { id: 'w1', path: dir, baseBranch: 'main', branch: 'feature' } as Workspace
    comments = []
    sessions = [tab('t1'), tab('t2')]
    send = vi.fn(async () => 'started')
    service = new DiffSelectionService({
      comments: () => comments,
      sessions: () => sessions,
      workspace: () => ws,
      send,
      createSession: () => {
        const s = tab('fresh')
        sessions.push(s)
        return s
      },
      changed: () => undefined,
      now: () => new Date('2026-10-22T14:09:00Z')
    })
  })

  it('unchanged lines go to the picked tab as one message, and the comment says it was sent', async () => {
    const result = await service.send('w1', { file: 'a.txt', body: 'Change this: shorter', selection: newSide(3, 4, ['NEW three', 'NEW four']) }, 't2')
    expect(result).toMatchObject({ status: 'sent', sessionId: 't2' })
    expect(send).toHaveBeenCalledWith('t2', 'Change this: shorter\n\na.txt · lines 3–4 · new side\n```\nNEW three\nNEW four\n```')
    expect(comments[0]).toMatchObject({ state: 'sent', line: 4, sessionId: 't2', sentAt: '2026-10-22T14:09:00.000Z', author: 'user' })
  })

  it('changed lines hold the comment with what they are now, and nothing is sent', async () => {
    await writeFile(path.join(dir, 'a.txt'), fileText({ 3: 'NEW three', 4: 'EDITED four' }))
    const result = await service.send('w1', { file: 'a.txt', body: 'Ask: why?', selection: newSide(3, 4, ['NEW three', 'NEW four']) }, 't1')
    expect(result.status).toBe('held')
    expect(send).not.toHaveBeenCalled()
    expect(comments[0]).toMatchObject({ state: 'held', body: 'Ask: why?', stale: { lines: ['NEW three', 'EDITED four'], checkedAt: '2026-10-22T14:09:00.000Z' } })

    // Quote current lines refreshes the quote; it stays a draft until sent.
    await service.resend(comments[0].id, 'current')
    expect(comments[0]).toMatchObject({ state: 'held', stale: undefined, selection: { lines: ['NEW three', 'EDITED four'], end: 4 } })
    expect(send).not.toHaveBeenCalled()
    await service.resend(comments[0].id, 'check')
    expect(send).toHaveBeenCalledOnce()
    expect(comments[0].state).toBe('sent')
  })

  it('Send as selected sends the old lines marked outdated', async () => {
    await writeFile(path.join(dir, 'a.txt'), fileText())
    await service.send('w1', { file: 'a.txt', body: 'Explain: what these lines do and why.', selection: newSide(3, 3, ['NEW three']) }, 't1')
    expect(comments[0].state).toBe('held')
    const result = await service.resend(comments[0].id, 'selected')
    expect(result.status).toBe('sent')
    expect(comments[0].outdated).toBe(true)
    expect(send.mock.calls[0][1]).toContain('Outdated:')
    expect(send.mock.calls[0][1]).toContain('NEW three')
  })

  it('a busy tab queues it; it is checked again when the tab is free', async () => {
    sessions[0] = tab('t1', { status: 'running', turnId: 'turn1' })
    const result = await service.send('w1', { file: 'a.txt', body: 'Change this: x', selection: newSide(3, 3, ['NEW three']) }, 't1')
    expect(result.status).toBe('queued')
    expect(send).not.toHaveBeenCalled()

    // The tab edits the line meanwhile; when its turn ends the comment is held, not sent.
    await writeFile(path.join(dir, 'a.txt'), fileText({ 3: 'TAB EDITED three' }))
    sessions[0] = tab('t1')
    service.wake('t1')
    await vi.waitFor(() => expect(comments[0].state).toBe('held'))
    expect(send).not.toHaveBeenCalled()
    expect(comments[0].stale?.lines).toEqual(['TAB EDITED three'])
  })

  it('a queued one with unchanged lines goes when the tab is free; a restart holds waiting ones', async () => {
    sessions[0] = tab('t1', { status: 'idle', queue: [{ id: 'q' } as never] })
    await service.send('w1', { file: 'a.txt', body: 'Change this: x', selection: newSide(4, 4, ['NEW four']) }, 't1')
    await service.send('w1', { file: 'a.txt', body: 'Ask: y', selection: newSide(3, 3, ['NEW three']) }, 't1')
    expect(comments.map((c) => c.state)).toEqual(['queued', 'queued'])
    sessions[0] = tab('t1')
    service.wake('t1')
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(comments.map((c) => c.state)).toEqual(['sent', 'queued'])

    service.holdWaiting()
    expect(comments[1].state).toBe('held')
  })

  it('“New chat” makes a tab only when sending; a closed tab keeps the comment held', async () => {
    const result = await service.send('w1', { file: 'a.txt', body: 'Ask: y', selection: newSide(3, 3, ['NEW three']) }, 'new')
    expect(result).toMatchObject({ status: 'sent', sessionId: 'fresh' })
    await expect(service.send('w1', { file: 'a.txt', body: 'Ask: z', selection: newSide(3, 3, ['NEW three']) }, 'gone')).rejects.toThrow(/no longer open/)
    expect(comments[1].state).toBe('held')
  })

  it('the old side is checked against the base it was compared with', async () => {
    const old: DiffSelection = { action: 'explain', side: 'old', start: 3, end: 4, lines: ['line 3', 'line 4'], scope: 'all', at: 'now' }
    expect((await service.send('w1', { file: 'a.txt', body: 'Explain: what these lines do and why.', selection: old }, 't1')).status).toBe('sent')
    // The base moves on (main gets a commit that changes line 3, and the branch is rebased onto it).
    await git(dir, ['checkout', '-q', '--', 'a.txt'])
    await git(dir, ['checkout', '-q', 'main'])
    await writeFile(path.join(dir, 'a.txt'), fileText({ 3: 'MAIN three' }))
    await git(dir, ['add', '-A'])
    await commit(dir, 'main edits 3')
    await git(dir, ['checkout', '-q', '-B', 'feature', 'main'])
    const again = await service.send('w1', { file: 'a.txt', body: 'Explain: what these lines do and why.', selection: old }, 't1')
    expect(again.status).toBe('held')
    expect(comments[1].stale?.lines).toEqual(['MAIN three', 'line 4'])
  })
})
