// @vitest-environment jsdom
// The diff for a screen reader and the keyboard (accessibility plan, phase C): a caption and column headers on every
// file's table, one tbody and one heading per hunk, the sign as a word, a row-by-row roving focus with Shift to select and
// Enter to comment, the status word in the file list, and the split toggle's note when a screen reader is on.
import '../domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangesList, FileDiffView } from '../../src/renderer/src/components/Changes'
import { setDiffPrefs } from '../../src/renderer/src/components/diffPrefs'
import type { DiffFile } from '../../src/shared/types'
import { fakeApi, fakeState, resetFake, storeModule } from '../rendererStore'

vi.mock('../../src/renderer/src/store', async () => (await import('../rendererStore')).storeModule)
const spoken = vi.hoisted(() => vi.fn())
vi.mock('../../src/renderer/src/announce', () => ({ announce: spoken }))

// jsdom has no layout: say the diff is wide enough for split.
const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get')

beforeEach(() => {
  resetFake()
  // The bar's tab picker reads the open chats.
  storeModule.openSessions = () => []
  spoken.mockClear()
  localStorage.clear()
  setDiffPrefs({ layout: 'unified', wrap: true, forceSplit: false })
  width.mockReturnValue(1200)
  fakeState.snapshot.comments = []
  fakeState.snapshot.sessions = []
  fakeState.snapshot.settings.loadouts = []
  fakeState.snapshot.screenReader = false
})
afterEach(cleanup)

const file: DiffFile = {
  path: 'src/foo.ts',
  status: 'modified',
  binary: false,
  blobId: 'b1',
  additions: 3,
  deletions: 1,
  hunks: [
    {
      header: '@@ -1,3 +1,4 @@ function top(',
      lines: [
        { type: 'ctx', text: 'one', oldNo: 1, newNo: 1 },
        { type: 'del', text: 'two', oldNo: 2 },
        { type: 'add', text: 'TWO', newNo: 2 },
        { type: 'add', text: 'three', newNo: 3 },
        { type: 'ctx', text: 'four', oldNo: 3, newNo: 4 }
      ]
    },
    {
      header: '@@ -20,2 +21,3 @@ handleLogin(',
      lines: [
        { type: 'ctx', text: 'twenty', oldNo: 20, newNo: 21 },
        { type: 'add', text: 'added later', newNo: 22 },
        { type: 'ctx', text: 'end', oldNo: 21, newNo: 23 }
      ]
    }
  ]
}

const deletionOnly: DiffFile = {
  ...file,
  path: 'src/gone.ts',
  additions: 0,
  deletions: 2,
  hunks: [
    {
      header: '@@ -10,3 +9,1 @@',
      lines: [
        { type: 'ctx', text: 'keep', oldNo: 10, newNo: 9 },
        { type: 'del', text: 'x', oldNo: 11 },
        { type: 'del', text: 'y', oldNo: 12 }
      ]
    },
    {
      header: '@@ -30,2 +0,0 @@',
      lines: [
        { type: 'del', text: 'p', oldNo: 30 },
        { type: 'del', text: 'q', oldNo: 31 }
      ]
    }
  ]
}

function renderDiff(f: DiffFile = file, props: Partial<Parameters<typeof FileDiffView>[0]> = {}) {
  render(<FileDiffView file={f} workspaceId="w1" scope="all" mergeBase="m" {...props} />)
  return document.querySelector('table.hunk') as HTMLTableElement
}
const rowOf = (table: HTMLElement, text: string) => within(table).getByText(text).closest('tr') as HTMLTableRowElement
const headings = (table: HTMLElement, level = 3) => within(table).getAllByRole('heading', { level })

describe('table semantics', () => {
  it('names each file with a caption: path, status and counts', () => {
    const table = renderDiff()
    expect(table.querySelector('caption')?.textContent).toBe('src/foo.ts, modified, 3 added, 1 removed')
    expect(table.firstElementChild?.tagName).toBe('CAPTION')
    expect(screen.getByRole('table', { name: 'src/foo.ts, modified, 3 added, 1 removed' })).toBe(table)
  })

  it('has column headers in the unified layout (3) and the split layout (4)', () => {
    const { unmount } = render(<FileDiffView file={file} workspaceId="w1" scope="all" mergeBase="m" />)
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Old line', 'New line', 'Code'])
    expect(screen.getAllByRole('columnheader').every((h) => h.getAttribute('scope') === 'col')).toBe(true)
    unmount()
    setDiffPrefs({ layout: 'split' })
    const table = renderDiff()
    expect(table.classList.contains('split')).toBe(true)
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Old line', 'Old code', 'New line', 'New code'])
  })

  it('puts each hunk in a tbody of its own, with its heading row first', () => {
    const table = renderDiff()
    expect(table.tBodies).toHaveLength(2)
    expect(Array.from(table.tBodies).map((b) => b.rows.length)).toEqual([6, 4])
    for (const body of Array.from(table.tBodies)) expect(body.rows[0].classList.contains('hunk-header')).toBe(true)
    expect(within(table.tBodies[1]).getByText('added later')).toBeTruthy()
  })

  it('the sign is a word for a reader: added and removed on changed lines, nothing on context', () => {
    const table = renderDiff()
    const word = (text: string) => rowOf(table, text).querySelector('.sign .sr-only')?.textContent?.trim()
    expect(word('TWO')).toBe('added')
    expect(word('two')).toBe('removed')
    expect(word('one')).toBeUndefined()
    // The visible +, - and space stay, hidden from the reader so the line isn't read twice.
    const signs = rowOf(table, 'TWO').querySelectorAll('.sign > [aria-hidden="true"]')
    expect(Array.from(signs).map((s) => s.textContent)).toEqual(['+'])
    expect(rowOf(table, 'two').querySelector('.sign > [aria-hidden="true"]')?.textContent).toBe('-')
  })

  it('leaves the number cell empty on the side a line does not have', () => {
    const table = renderDiff()
    const added = Array.from(rowOf(table, 'TWO').cells).map((c) => c.textContent?.replace(/added|\+|\s/g, ''))
    expect(added.slice(0, 2)).toEqual(['', '2'])
    const removed = Array.from(rowOf(table, 'two').cells).map((c) => c.textContent)
    expect(removed.slice(0, 2)).toEqual(['2', ''])
  })
})

describe('hunk headings', () => {
  it('are one level below the file heading and say where the hunk is', () => {
    const table = renderDiff()
    expect(screen.getByRole('heading', { level: 2, name: 'src/foo.ts' })).toBeTruthy()
    expect(headings(table).map((h) => h.querySelector('.sr-only')?.textContent)).toEqual(['Hunk 1 of 2, lines 1 to 4, near: function top(', 'Hunk 2 of 2, lines 21 to 23, near: handleLogin('])
    expect(headings(table).map((h) => h.getAttribute('aria-level'))).toEqual(['3', '3'])
  })

  it('follow the level they are given', () => {
    const table = renderDiff(file, { headingLevel: 3 })
    expect(screen.getByRole('heading', { level: 3, name: 'src/foo.ts' })).toBeTruthy()
    expect(headings(table, 4)).toHaveLength(2)
  })

  it('keep the raw @@ header on screen and out of the reader', () => {
    renderDiff()
    const raw = screen.getByText('@@ -1,3 +1,4 @@ function top(')
    expect(raw.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Hunk 1 of 2, lines 1 to 4, near: function top(' })).toBeTruthy()
  })

  it('say which lines went when a hunk only removes', () => {
    const table = renderDiff(deletionOnly)
    expect(headings(table).map((h) => h.querySelector('.sr-only')?.textContent)).toEqual(['Hunk 1 of 2, line 9', 'Hunk 2 of 2, removed lines 30 to 31'])
  })

  it('make the first heading of a file its tab stop and the others reachable by arrows', () => {
    const table = renderDiff()
    expect(headings(table).map((h) => h.getAttribute('tabindex'))).toEqual(['0', '-1'])
    expect(Array.from(table.querySelectorAll('tr[data-row]')).every((r) => r.getAttribute('tabindex') === '-1')).toBe(true)
  })

  it('stay with their hunk when a comment sits between the lines', () => {
    fakeState.snapshot.comments = [{ id: 'c1', workspaceId: 'w1', file: 'src/foo.ts', line: 2, author: 'user', state: 'pending', body: 'why this?', createdAt: '2026-01-01T00:00:00Z' }]
    const table = renderDiff()
    expect(within(table.tBodies[0]).getByText('why this?')).toBeTruthy()
    expect(within(table.tBodies[1]).queryByText('why this?')).toBeNull()
    // The comment row is not a stop: Down from the added line goes to the next line.
    expect(table.tBodies[0].querySelectorAll('tr[data-row]')).toHaveLength(5)
  })
})

describe('keyboard line selection', () => {
  it('Down from a heading reaches the first row; Up and Down walk the rows; Up from the first row returns to the heading', async () => {
    const user = userEvent.setup()
    const table = renderDiff()
    const [first] = headings(table)
    first.focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rowOf(table, 'one'))
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rowOf(table, 'two'))
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(rowOf(table, 'one'))
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(first)
  })

  it('crossing a hunk lands on the next hunk heading, so the reader says where it is', async () => {
    const user = userEvent.setup()
    const table = renderDiff()
    rowOf(table, 'four').focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(headings(table)[1])
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rowOf(table, 'twenty'))
  })

  it('arrows typed in a comment box are left alone', async () => {
    const user = userEvent.setup()
    const table = renderDiff()
    rowOf(table, 'TWO').focus()
    await user.keyboard('{Enter}')
    const box = await screen.findByRole('textbox')
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(box)
  })

  it('Shift+Down extends the selection on the new side and says how far it reaches', async () => {
    const user = userEvent.setup()
    const table = renderDiff()
    rowOf(table, 'TWO').focus()
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    expect(document.activeElement).toBe(rowOf(table, 'three'))
    expect(spoken).toHaveBeenLastCalledWith('Selected 2 lines, new 2 to 3', 'diff:selection')
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    expect(spoken).toHaveBeenLastCalledWith('Selected 3 lines, new 2 to 4', 'diff:selection')
    expect(rowOf(table, 'TWO').querySelector('td.sel')).toBeTruthy()
    expect(rowOf(table, 'four').querySelector('td.sel')).toBeTruthy()
    expect(rowOf(table, 'one').querySelector('td.sel')).toBeNull()
    await user.keyboard('{Shift>}{ArrowUp}{/Shift}')
    expect(spoken).toHaveBeenLastCalledWith('Selected 2 lines, new 2 to 3', 'diff:selection')
  })

  it('a removed line selects on the old side', async () => {
    const user = userEvent.setup()
    const table = renderDiff()
    rowOf(table, 'two').focus()
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    expect(spoken).toHaveBeenLastCalledWith('Selected 2 lines, old 2 to 3', 'diff:selection')
  })

  it('does not extend across a break in the line numbers', async () => {
    const user = userEvent.setup()
    const table = renderDiff()
    rowOf(table, 'four').focus()
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    expect(document.activeElement).toBe(rowOf(table, 'four'))
    expect(spoken).not.toHaveBeenCalled()
  })

  it('a plain arrow drops the selection', async () => {
    const user = userEvent.setup()
    const table = renderDiff()
    rowOf(table, 'TWO').focus()
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}{ArrowDown}')
    expect(table.querySelector('td.sel')).toBeNull()
  })

  it('Enter opens the comment box on the selected range; saving puts focus back on the anchored row', async () => {
    const user = userEvent.setup()
    fakeApi.addComment = vi.fn(async () => undefined)
    const table = renderDiff()
    rowOf(table, 'TWO').focus()
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}{Enter}')
    const box = await screen.findByRole('textbox', { name: /comment/i })
    expect(document.activeElement).toBe(box)
    await user.keyboard('rename this{Control>}{Enter}{/Control}')
    expect(fakeApi.addComment).toHaveBeenCalledTimes(1)
    const [id, path, line, body, selection] = fakeApi.addComment.mock.calls[0]
    expect([id, path, line, body]).toEqual(['w1', 'src/foo.ts', 3, 'rename this'])
    expect(selection).toMatchObject({ side: 'new', start: 2, end: 3, lines: ['TWO', 'three'] })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.activeElement).toBe(rowOf(table, 'TWO'))
  })

  it('Enter on a row with no selection comments on that one line, and cancelling returns to it', async () => {
    const user = userEvent.setup()
    const table = renderDiff()
    rowOf(table, 'three').focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('textbox')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.activeElement).toBe(rowOf(table, 'three'))
  })

  it('Escape clears the selection and keeps focus where it is', async () => {
    const user = userEvent.setup()
    const table = renderDiff()
    rowOf(table, 'TWO').focus()
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    expect(table.querySelector('td.sel')).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(table.querySelector('td.sel')).toBeNull()
    expect(document.activeElement).toBe(rowOf(table, 'three'))
  })

  it('moves but does not select in a read-only diff', async () => {
    const user = userEvent.setup()
    const table = renderDiff(file, { readonly: true, commentsHidden: true })
    rowOf(table, 'TWO').focus()
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    expect(table.querySelector('td.sel')).toBeNull()
    expect(document.activeElement).toBe(rowOf(table, 'three'))
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('in split, Left and Right pick the half, and Shift selects on it', async () => {
    const user = userEvent.setup()
    setDiffPrefs({ layout: 'split' })
    const table = renderDiff()
    expect(table.classList.contains('split')).toBe(true)
    const row = rowOf(table, 'two')
    row.focus()
    await user.keyboard('{ArrowLeft}')
    expect(spoken).toHaveBeenLastCalledWith('old side', 'diff:half')
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    expect(spoken).toHaveBeenLastCalledWith('Selected 2 lines, old 2 to 3', 'diff:selection')
    await user.keyboard('{ArrowRight}')
    expect(spoken).toHaveBeenLastCalledWith('new side', 'diff:half')
    expect(table.querySelector('td.sel')).toBeNull()
  })
})

describe('a screen reader is running', () => {
  it('keeps unified as the layout and describes the toggle', () => {
    fakeState.snapshot.screenReader = true
    const table = renderDiff()
    expect(table.classList.contains('split')).toBe(false)
    const toggle = screen.getByRole('radiogroup', { name: 'Diff layout' })
    const note = document.getElementById(toggle.getAttribute('aria-describedby')!)
    expect(note?.textContent).toMatch(/Unified is recommended with a screen reader/)
  })

  it('leaves a chosen split alone', () => {
    fakeState.snapshot.screenReader = true
    setDiffPrefs({ layout: 'split' })
    expect(renderDiff().classList.contains('split')).toBe(true)
  })

  it('says nothing extra when none is', () => {
    renderDiff()
    expect(screen.getByRole('radiogroup', { name: 'Diff layout' }).getAttribute('aria-describedby')).toBeNull()
  })
})

describe('the file list', () => {
  const workspace = { id: 'w1', path: 'C:/work', viewed: [] } as never
  const entry = (path: string, status: DiffFile['status'], oldPath?: string): DiffFile => ({ path, status, oldPath, additions: 2, deletions: 1, hunks: [], binary: false, blobId: 'b' })

  it('puts the status word in each row’s name, beside the icon', () => {
    const diff = { baseRef: 'main', scope: 'all', mergeBase: 'm', files: [entry('src/a.ts', 'modified'), entry('src/b.ts', 'added'), entry('src/c.ts', 'deleted'), entry('src/d.ts', 'renamed', 'src/old.ts')] } as never
    render(<ChangesList workspace={workspace} diff={diff} selected={null} onOpen={vi.fn()} />)
    for (const [name, word] of [['a.ts', 'modified'], ['b.ts', 'added'], ['c.ts', 'deleted'], ['d.ts', 'renamed']]) {
      expect(screen.getByRole('button', { name: new RegExp(`^${word},\\s*${name.replace('.', '\\.')}`) })).toBeTruthy()
    }
  })
})
