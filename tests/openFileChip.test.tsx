// @vitest-environment jsdom
// A tool call's path opens the file: a click opens it where it belongs, Ctrl-click shows it in its folder, right-click
// offers the other places, and the rest of the row still expands the call. A path stays text while the call runs and in
// a cloud workspace, whose files are in the sandbox.
import './domShims'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolRow } from '../src/renderer/src/components/ToolRow'
import type { FileAccess } from '../src/renderer/src/components/OpenFileChip'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const root = 'C:\\w\\camus'
const local: FileAccess = { workspaceId: 'w1', root, preview: true }
const write = (file_path: string, status = 'done') => ({ kind: 'tool', id: 't1', turnId: 'u1', name: 'Write', input: { file_path, content: 'a\nb\n' }, status, output: '' }) as never
const read = (file_path: string) => ({ kind: 'tool', id: 't2', turnId: 'u1', name: 'Read', input: { file_path }, status: 'done', output: 'one line' }) as never

function row(item: never, files: FileAccess | null = local) {
  return render(<ToolRow item={item} workspacePath={files?.root ?? root} files={files} expandByDefault={false} />)
}

beforeEach(() => {
  resetFake()
  fakeState.snapshot.platform = 'win32'
  fakeState.snapshot.settings.openInDefault = ''
  fakeState.snapshot.settings.editorCommand = ''
  // No editor found: code says "Open in editor".
  fakeApi.openInApps = vi.fn(async () => ({ platform: 'win32', apps: [] }))
})
afterEach(cleanup)

describe('a path in a tool call', () => {
  it('opens a page in the browser on click, and shows it in its folder on Ctrl-click', async () => {
    const user = userEvent.setup()
    row(write('C:\\Users\\yatin\\mocks\\index.html'))
    const chip = screen.getByRole('button', { name: 'C:\\Users\\yatin\\mocks\\index.html' })
    expect(chip.getAttribute('title')).toBe('Open in your browser · Right-click for more')
    await user.click(chip)
    expect(fakeApi.openFile).toHaveBeenLastCalledWith('C:\\Users\\yatin\\mocks\\index.html', 'open')
    await user.keyboard('{Control>}')
    await user.click(chip)
    await user.keyboard('{/Control}')
    expect(fakeApi.openFile).toHaveBeenLastCalledWith('C:\\Users\\yatin\\mocks\\index.html', 'reveal')
  })

  it('opens from the keyboard, and leaves the row to expand the call', async () => {
    const user = userEvent.setup()
    row(read('C:\\Temp\\shots\\v4-1.png'))
    const chip = screen.getByRole('button', { name: 'C:\\Temp\\shots\\v4-1.png' })
    expect(chip.getAttribute('title')).toMatch(/^Open in your image viewer/)
    chip.focus()
    await user.keyboard('{Enter}')
    expect(fakeApi.openFile).toHaveBeenCalledWith('C:\\Temp\\shots\\v4-1.png', 'open')
    // The label half of the row is the toggle; the chip didn't toggle it.
    const toggle = screen.getByRole('button', { name: /Read 1 line/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(fakeApi.openFile).toHaveBeenCalledTimes(1)
  })

  it('opens a path given relative to the worktree from the worktree, and shows it relative', async () => {
    const user = userEvent.setup()
    row(write('docs/mock.html'))
    await user.click(screen.getByRole('button', { name: 'docs/mock.html' }))
    expect(fakeApi.openFile).toHaveBeenCalledWith('C:\\w\\camus\\docs\\mock.html', 'open')
  })

  it('right-click offers the browser, Foreman, the editor, the folder and both copies for a page in the worktree', async () => {
    const user = userEvent.setup()
    row(write('C:\\w\\camus\\docs\\mock.html'))
    fireEvent.contextMenu(screen.getByRole('button', { name: 'docs/mock.html' }), { clientX: 20, clientY: 30 })
    const menu = screen.getByRole('menu', { name: 'File actions' })
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Open in your browser',
      'Preview in Foreman',
      'Open in editor',
      'Show in File Explorer',
      'Copy path',
      'Copy relative path'
    ])
    await user.click(within(menu).getByRole('menuitem', { name: 'Preview in Foreman' }))
    expect(storeModule.requestOpenFile).toHaveBeenCalledWith('w1', 'docs/mock.html')
    fireEvent.contextMenu(screen.getByRole('button', { name: 'docs/mock.html' }), { clientX: 20, clientY: 30 })
    await user.click(screen.getByRole('menuitem', { name: 'Open in editor' }))
    expect(fakeApi.openInEditor).toHaveBeenCalledWith('C:\\w\\camus\\docs\\mock.html')
  })

  it('leaves Preview and Copy relative path out for a file outside the worktree, and Preview out without a local worktree', () => {
    row(read('C:\\Temp\\shots\\v4-1.png'))
    fireEvent.contextMenu(screen.getByRole('button', { name: 'C:\\Temp\\shots\\v4-1.png' }), { clientX: 1, clientY: 1 })
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Open in your image viewer', 'Show in File Explorer', 'Copy path'])
    cleanup()
    row(read('C:\\w\\camus\\shot.png'), { workspaceId: 'w1', root, preview: false })
    fireEvent.contextMenu(screen.getByRole('button', { name: 'shot.png' }), { clientX: 1, clientY: 1 })
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Preview in Foreman' })).toBeNull()
  })

  it('says a program is only shown in its folder, and offers nothing that would open it', () => {
    row(write('C:\\w\\camus\\build\\setup.exe'))
    const chip = screen.getByRole('button', { name: 'build/setup.exe' })
    expect(chip.getAttribute('title')).toBe("Show in File Explorer. Foreman doesn't run programs or open archives from the chat")
    fireEvent.contextMenu(chip, { clientX: 1, clientY: 1 })
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Show in File Explorer', 'Copy path', 'Copy relative path'])
  })

  it('names the Mac file manager on a Mac', () => {
    fakeState.snapshot.platform = 'darwin'
    row(write('/Users/yatin/app/Foreman.dmg'), { workspaceId: 'w1', root: '/Users/yatin/app', preview: true })
    expect(screen.getByRole('button', { name: 'Foreman.dmg' }).getAttribute('title')).toMatch(/^Reveal in Finder/)
  })

  it('opens from Shift+F10 under the chip, where there is no pointer', () => {
    row(write('C:\\w\\camus\\notes.md'))
    fireEvent.contextMenu(screen.getByRole('button', { name: 'notes.md' }))
    const menu = screen.getByRole('menu', { name: 'File actions' })
    expect(within(menu).getAllByRole('menuitem')[0]?.textContent).toBe('Open in editor')
  })

  it('is text while the call still runs, and in a cloud workspace', () => {
    row(write('C:\\w\\camus\\index.html', 'running'))
    expect(screen.queryByRole('button', { name: 'index.html' })).toBeNull()
    expect(screen.getByText('index.html')).toBeTruthy()
    cleanup()
    row(write('/vercel/sandbox/out/report.html'), null)
    expect(screen.queryByRole('button', { name: '/vercel/sandbox/out/report.html' })).toBeNull()
    expect(screen.getByRole('button', { name: /Write/ }).textContent).toContain('/vercel/sandbox/out/report.html')
  })
})
