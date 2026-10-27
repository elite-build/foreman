// @vitest-environment jsdom
// Git, diff and files on the design system: the file tree (a Tree, its loading and error lines outside it), the diff
// source menu, the diff-selection bar and its tab picker, a changed file's context menu, the commits list and the Git
// header's split action.
import './domShims'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangesList } from '../src/renderer/src/components/Changes'
import { CommitsView } from '../src/renderer/src/components/CommitsView'
import { SelectionBar, SelectionDraftBox, TabPicker } from '../src/renderer/src/components/DiffSelection'
import { DiffSourceMenu } from '../src/renderer/src/components/DiffSourceMenu'
import { FilesTree } from '../src/renderer/src/components/FilesTree'
import { GitHeaderActions, MergedProgress, MergedStatus } from '../src/renderer/src/components/GitPanel'
import { en } from '../src/shared/i18n/en'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)



beforeEach(() => {
  resetFake()
  localStorage.clear()
  fakeState.snapshot.comments = []
  fakeState.snapshot.sessions = []
  fakeState.snapshot.settings.loadouts = []
})
afterEach(cleanup)

// ---- the file tree ----

const entry = (path: string, dir: boolean) => ({ name: path.slice(path.lastIndexOf('/') + 1), path, dir })
const emptyDiff = { baseRef: 'main', scope: 'all', files: [] } as never

function renderTree(onOpen = vi.fn(), selected: string | null = null) {
  render(<FilesTree workspaceId="w1" diff={emptyDiff} selected={selected} reloadKey={0} onOpen={onOpen} />)
  return onOpen
}

describe('the file tree', () => {
  beforeEach(() => {
    fakeApi.listFiles = vi.fn(async () => ['src/a.ts', 'readme.md'])
    fakeApi.listDir = vi.fn(async (_id: string, dir: string) =>
      dir === 'src' ? { entries: [entry('src/a.ts', false)], truncated: false } : { entries: [entry('src', true), entry('readme.md', false)], truncated: false }
    )
  })

  it('is a labelled tree of treeitems with one tab stop, and the open file selected', async () => {
    renderTree(vi.fn(), 'readme.md')
    const tree = await screen.findByRole('tree', { name: 'Files in this worktree' })
    const items = within(tree).getAllByRole('treeitem')
    expect(items.map((i) => i.textContent)).toEqual(['src', 'readme.md'])
    expect(items.map((i) => i.getAttribute('tabindex'))).toEqual(['0', '-1'])
    expect(items[0].getAttribute('aria-expanded')).toBe('false')
    expect(items[1].getAttribute('aria-expanded')).toBeNull()
    expect(items[1].getAttribute('aria-selected')).toBe('true')
  })

  it('arrows move, → opens a folder (reading it), Enter opens a file', async () => {
    const user = userEvent.setup()
    const onOpen = renderTree()
    const tree = await screen.findByRole('tree')
    const [src, readme] = within(tree).getAllByRole('treeitem')
    src.focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(readme)
    await user.keyboard('{ArrowUp}{ArrowRight}')
    await waitFor(() => expect(fakeApi.listDir).toHaveBeenCalledWith('w1', 'src'))
    const open = await screen.findByRole('treeitem', { name: /src$/ })
    expect(open.getAttribute('aria-expanded')).toBe('true')
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement?.getAttribute('aria-level')).toBe('2')
    await user.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledWith('src/a.ts', undefined)
  })

  it('clicking a file opens it', async () => {
    const user = userEvent.setup()
    const onOpen = renderTree()
    await user.click(await screen.findByRole('treeitem', { name: 'readme.md' }))
    expect(onOpen).toHaveBeenCalledWith('readme.md', undefined)
  })

  it('a folder that fails to read says so under the tree, with a Retry, not as a row', async () => {
    const user = userEvent.setup()
    fakeApi.listDir = vi.fn(async (_id: string, dir: string) => {
      if (dir === 'src') throw new Error('Error invoking remote method \'listDir\': Error: denied')
      return { entries: [entry('src', true)], truncated: false }
    })
    renderTree()
    const tree = await screen.findByRole('tree')
    await user.click(within(tree).getByRole('treeitem', { name: 'src' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('src: Couldn’t list this folder: denied')
    expect(tree.contains(alert)).toBe(false)
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(1)
    fakeApi.listDir.mockClear()
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(fakeApi.listDir).toHaveBeenCalledWith('w1', 'src')
  })

  it('the loading line sits outside the tree', async () => {
    fakeApi.listDir = vi.fn(() => new Promise(() => undefined))
    renderTree()
    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('Loading…')
    expect(screen.queryByRole('tree')).toBeNull()
  })
})

// ---- the diff source menu ----

describe('the diff source menu', () => {
  const info = {
    counts: { all: 4, uncommitted: 2 },
    blocked: { pr: 'no-pr' },
    baseRef: 'main',
    branchCommits: 3,
    lastN: 3
  }
  beforeEach(() => {
    fakeApi.diffSources = vi.fn(async () => info)
  })

  it('opens a labelled menu of radio items with the current source checked, counts read on open', async () => {
    const user = userEvent.setup()
    render(<DiffSourceMenu workspaceId="w1" choice={{ scope: 'uncommitted', picked: [] }} onChange={vi.fn()} onPick={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: /Uncommitted/ })
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    await user.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Changes to show' })
    expect(fakeApi.diffSources).toHaveBeenCalled()
    const radios = within(menu).getAllByRole('menuitemradio')
    expect(radios).toHaveLength(7)
    expect(within(menu).getByRole('menuitemradio', { name: /Uncommitted/ }).getAttribute('aria-checked')).toBe('true')
    await waitFor(() => expect(within(menu).getByRole('menuitemradio', { name: /All changes/ }).textContent).toContain('4 files'))
  })

  it('a source that cannot be shown is disabled and says why', async () => {
    const user = userEvent.setup()
    render(<DiffSourceMenu workspaceId="w1" choice={{ scope: 'all', picked: [] }} onChange={vi.fn()} onPick={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /All changes/ }))
    const pr = await screen.findByRole('menuitemradio', { name: /PR changes/ })
    await waitFor(() => expect((pr as HTMLButtonElement).disabled).toBe(true))
    expect(pr.getAttribute('title')).toBe('No pull request for this branch')
  })

  it('choosing a source reports it and closes; Pick commits… asks to pick instead; Escape returns focus', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onPick = vi.fn()
    render(<DiffSourceMenu workspaceId="w1" choice={{ scope: 'all', picked: [] }} onChange={onChange} onPick={onPick} />)
    const trigger = screen.getByRole('button', { name: /All changes/ })
    await user.click(trigger)
    await user.click(await screen.findByRole('menuitemradio', { name: /Uncommitted/ }))
    expect(onChange).toHaveBeenCalledWith('uncommitted')
    expect(screen.queryByRole('menu')).toBeNull()
    await user.click(trigger)
    await user.click(await screen.findByRole('menuitemradio', { name: /Pick commits/ }))
    expect(onPick).toHaveBeenCalled()
    await user.click(trigger)
    await screen.findByRole('menu')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

// ---- diff selection ----

describe('the selection bar', () => {
  beforeEach(() => {
    fakeState.snapshot.sessions = [
      { id: 's1', workspaceId: 'w1', agent: 'claude', model: 'default', status: 'idle', queue: [], title: 'Fix the bug' },
      { id: 's2', workspaceId: 'w1', agent: 'claude', model: 'default', status: 'running', queue: [], title: '' }
    ]
  })

  it('is a named toolbar whose buttons report their action and stop while busy', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn()
    const { rerender } = render(<SelectionBar workspaceId="w1" count={3} target="s1" onTarget={vi.fn()} onAction={onAction} busy={false} />)
    const bar = screen.getByRole('toolbar', { name: 'Selected lines' })
    await user.click(within(bar).getByRole('button', { name: 'Explain' }))
    await user.click(within(bar).getByRole('button', { name: 'Change this' }))
    await user.click(within(bar).getByRole('button', { name: /^Ask/ }))
    await user.click(within(bar).getByRole('button', { name: 'Comment' }))
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['explain', 'change', 'ask', 'comment'])
    rerender(<SelectionBar workspaceId="w1" count={3} target="s1" onTarget={vi.fn()} onAction={onAction} busy />)
    expect((within(bar).getByRole('button', { name: 'Explain' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('the tab picker is a menu of radio items; choosing one reports it, Escape closes and refocuses', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TabPicker workspaceId="w1" value="s1" onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: /Send to:/ })
    await user.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Send to' })
    const radios = within(menu).getAllByRole('menuitemradio')
    expect(radios).toHaveLength(3)
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    await user.click(radios[1])
    expect(onChange).toHaveBeenCalledWith('s2')
    expect(screen.queryByRole('menu')).toBeNull()
    await user.click(trigger)
    await user.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /New chat/ }))
    expect(onChange).toHaveBeenLastCalledWith('new')
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('the selection comment box', () => {
  function renderBox(initial = 'Change this: ') {
    const onSend = vi.fn()
    const onCancel = vi.fn()
    render(<SelectionDraftBox initial={initial} sendLabel="Send to Tab 1" placeholder="What should change?" onSend={onSend} onCancel={onCancel} />)
    return { onSend, onCancel }
  }

  it('names its textarea and cannot send the prefix alone', async () => {
    const user = userEvent.setup()
    const { onSend } = renderBox()
    const box = screen.getByRole('textbox', { name: 'What should change?' }) as HTMLTextAreaElement
    expect(document.activeElement).toBe(box)
    const send = screen.getByRole('button', { name: 'Send to Tab 1' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(onSend).not.toHaveBeenCalled()
    await user.type(box, 'rename it')
    expect(send.disabled).toBe(false)
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(onSend).toHaveBeenCalledWith('Change this: rename it')
  })

  it('Escape and Cancel give it up', async () => {
    const user = userEvent.setup()
    const { onCancel } = renderBox()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})

// ---- a changed file's context menu ----

describe('the changes list', () => {
  const workspace = { id: 'w1', path: '/repo', viewed: [] } as never
  const file = (path: string, status = 'modified') => ({ path, status, additions: 1, deletions: 0, hunks: [], binary: false, blobId: 'b' })
  const diff = (scope: string) => ({ baseRef: 'main', scope, files: [file('src/a.ts'), file('src/b.ts', 'deleted')], mergeBase: 'm' }) as never

  it('right-click opens a labelled context menu at the pointer; Discard is there only for the working tree', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const { rerender } = render(<ChangesList workspace={workspace} diff={diff('all')} selected={null} onOpen={onOpen} />)
    const row = screen.getByRole('button', { name: /a\.ts/ })
    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 })
    const menu = screen.getByRole('menu', { name: 'File actions' })
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['View diff', 'Open in editor', 'Copy path', 'Copy relative path', 'Discard changes…'])
    await user.click(within(menu).getByRole('menuitem', { name: 'View diff' }))
    expect(onOpen).toHaveBeenCalledWith('src/a.ts')
    expect(screen.queryByRole('menu')).toBeNull()
    // A deleted file has nothing to open in the editor.
    fireEvent.contextMenu(screen.getByRole('button', { name: /b\.ts/ }))
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Open in editor' })).toBeNull()
    await user.keyboard('{Escape}')
    rerender(<ChangesList workspace={workspace} diff={diff('staged')} selected={null} onOpen={onOpen} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: /a\.ts/ }))
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: /Discard/ })).toBeNull()
  })

  it('Discard asks first and reverts only on yes', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<ChangesList workspace={workspace} diff={diff('all')} selected={null} onOpen={vi.fn()} />)
    for (let n = 0; n < 2; n++) {
      fireEvent.contextMenu(screen.getByRole('button', { name: /a\.ts/ }))
      await user.click(screen.getByRole('menuitem', { name: /Discard/ }))
    }
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(fakeApi.revertFile).toHaveBeenCalledTimes(1)
    expect(fakeApi.revertFile).toHaveBeenCalledWith('w1', 'src/a.ts')
    confirm.mockRestore()
  })

  it('the open file is marked current and each viewed checkbox names its file', () => {
    render(<ChangesList workspace={workspace} diff={diff('all')} selected="src/a.ts" onOpen={vi.fn()} />)
    expect(screen.getByRole('button', { name: /a\.ts/ }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: /b\.ts/ }).getAttribute('aria-current')).toBeNull()
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  })
})

// ---- commits ----

describe('the commits tab', () => {
  const commit = (sha: string, subject: string) => ({ sha, subject, author: 'Ada', you: true, at: new Date().toISOString(), files: 1, additions: 2, deletions: 1, pushed: true })
  const list = { baseRef: 'main', mergeBase: 'abcdef123', commits: [commit('1111111aaa', 'First'), commit('2222222bbb', 'Second')], more: false, uncommitted: { files: 0, staged: 0, additions: 0, deletions: 0 } }
  beforeEach(() => {
    fakeApi.branchCommits = vi.fn(async () => list)
    fakeApi.getDiff = vi.fn(async () => ({ baseRef: 'main', scope: 'commit', files: [{ path: 'src/x.ts', status: 'modified', additions: 1, deletions: 0, hunks: [], binary: false }] }))
  })
  const props = { workspaceId: 'w1', reloadKey: '', selected: null, picking: false, picked: [] as string[], onOpen: vi.fn(), onShowUncommitted: vi.fn(), onPick: vi.fn(), onShowPicked: vi.fn() }

  it('a commit row expands to its files (aria-expanded) and a file opens it read-only', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<CommitsView {...props} onOpen={onOpen} />)
    const row = await screen.findByRole('button', { name: /First/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    // From the keyboard: a native button, so Enter works.
    row.focus()
    await user.keyboard('{Enter}')
    expect(row.getAttribute('aria-expanded')).toBe('true')
    await waitFor(() => expect(fakeApi.getDiff).toHaveBeenCalledWith('w1', 'commit', ['1111111aaa']))
    await user.click(await screen.findByRole('button', { name: /x\.ts/ }))
    expect(onOpen.mock.calls[0][0].path).toBe('src/x.ts')
    await user.keyboard('{Enter}')
  })

  it('"nothing uncommitted" is disabled', async () => {
    render(<CommitsView {...props} />)
    expect(((await screen.findByRole('button', { name: /Nothing uncommitted/ })) as HTMLButtonElement).disabled).toBe(true)
  })

  it('picking shows a named checkbox per commit and offers Show together once one is ticked', async () => {
    const user = userEvent.setup()
    const onShowPicked = vi.fn()
    render(<CommitsView {...props} picking onShowPicked={onShowPicked} />)
    const first = await screen.findByRole('checkbox', { name: 'First' })
    expect(screen.getByRole('checkbox', { name: 'Second' })).toBeTruthy()
    const show = screen.getByRole('button', { name: 'Show together' }) as HTMLButtonElement
    expect(show.disabled).toBe(true)
    await user.click(first)
    expect(show.disabled).toBe(false)
    await user.click(show)
    expect(onShowPicked).toHaveBeenCalledWith(['1111111aaa'])
  })

  it('without picking, one link starts it', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<CommitsView {...props} onPick={onPick} />)
    await user.click(await screen.findByRole('button', { name: /Pick commits to view together/ }))
    expect(onPick).toHaveBeenCalledWith(true)
  })
})

// ---- the Git header ----

describe('the Git header actions', () => {
  const status = (action: string, label = 'Do it') => ({ primary: { action, label }, scm: undefined }) as never
  const render_ = (action: string, running = false) => render(<GitHeaderActions workspaceId="w1" status={status(action)} refresh={vi.fn()} running={running} />)

  it('Create PR is a split: the main button runs it, the arrow opens a menu of the other ways', async () => {
    const user = userEvent.setup()
    render_('create-pr')
    await user.click(screen.getByRole('button', { name: /Create PR/ }))
    expect(fakeApi.gitAction).toHaveBeenCalledWith('w1', 'create-pr', undefined)
    const arrow = screen.getByRole('button', { name: 'More pull request options' })
    await user.click(arrow)
    const menu = screen.getByRole('menu', { name: 'More pull request options' })
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(3)
    await user.click(within(menu).getByRole('menuitem', { name: 'Create draft PR' }))
    expect(fakeApi.gitAction).toHaveBeenLastCalledWith('w1', 'create-draft-pr', undefined)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(arrow)
  })

  it('the Create PR arrow stays usable while an agent is running and the main button waits', async () => {
    const user = userEvent.setup()
    render_('create-pr', true)
    expect((screen.getByRole('button', { name: /Create PR/ }) as HTMLButtonElement).disabled).toBe(true)
    const arrow = screen.getByRole('button', { name: 'More pull request options' }) as HTMLButtonElement
    expect(arrow.disabled).toBe(false)
    await user.click(arrow)
    expect(within(screen.getByRole('menu', { name: 'More pull request options' })).getAllByRole('menuitem')).toHaveLength(3)
  })

  it('other actions are a single button, not a split', () => {
    render_('push')
    expect(screen.getByRole('button', { name: /Push/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'More pull request options' })).toBeNull()
  })

  it('the primary action waits while an agent is running, except Archive; Review stays', () => {
    const { unmount } = render_('push', true)
    expect((screen.getByRole('button', { name: /Push/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Review/ }) as HTMLButtonElement).disabled).toBe(false)
    unmount()
    render_('archive', true)
    expect((screen.getByRole('button', { name: /Archive/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  describe('once the pull request merged', () => {
    const pr = { number: 41, url: 'https://github.com/o/r/pull/41', title: 'T', state: 'MERGED', baseRefName: 'main', mergedAt: '2026-10-25T05:00:00Z', checks: [] }
    const merged = () => ({ primary: { action: 'archive', label: 'Merged', tone: 'purple' }, pr, scm: undefined }) as never
    const archiveDialog = storeModule.openArchiveDialog as ReturnType<typeof vi.fn>
    beforeEach(() => {
      archiveDialog.mockClear()
      fakeState.snapshot.workspaces = [{ id: 'w1' }]
    })
    afterEach(() => {
      fakeState.snapshot.workspaces = []
      delete fakeState.archiveChoice
    })

    it('drops Review; Archive is the primary action and its menu archives, archives with the branch, or opens the PR', async () => {
      const user = userEvent.setup()
      render(<GitHeaderActions workspaceId="w1" status={merged()} refresh={vi.fn()} running={false} />)
      expect(screen.queryByRole('button', { name: /Review/ })).toBeNull()
      const archive = screen.getByRole('button', { name: /Archive/ })
      expect(archive.className).toContain('ui-btn--primary')
      await user.click(archive)
      expect(archiveDialog).toHaveBeenLastCalledWith('w1')

      await user.click(screen.getByRole('button', { name: 'More options after merging' }))
      const menu = screen.getByRole('menu', { name: 'More options after merging' })
      expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Archive', 'Archive and delete branch', 'Open #41 on GitHub'])
      await user.click(within(menu).getByRole('menuitem', { name: 'Archive and delete branch' }))
      expect(archiveDialog).toHaveBeenLastCalledWith('w1', { deleteBranch: true })

      await user.click(screen.getByRole('button', { name: 'More options after merging' }))
      await user.click(screen.getByRole('menuitem', { name: 'Open #41 on GitHub' }))
      expect(fakeApi.openExternal).toHaveBeenCalledWith(pr.url)
    })

    it('after an archive that deleted the branch, the button does that next, and the menu marks it as last used', async () => {
      fakeState.archiveChoice = 'delete-branch'
      const user = userEvent.setup()
      render(<GitHeaderActions workspaceId="w1" status={merged()} refresh={vi.fn()} running={false} />)
      const primary = screen.getByRole('button', { name: 'Archive and delete branch' })
      expect(primary.className).toContain('ui-btn--primary')
      await user.click(primary)
      expect(archiveDialog).toHaveBeenLastCalledWith('w1', { deleteBranch: true })
      await user.click(screen.getByRole('button', { name: 'More options after merging' }))
      expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Archive', 'Archive and delete branchLast used', 'Open #41 on GitHub'])
      await user.click(screen.getByRole('menuitem', { name: /^Archive$/ }))
      expect(archiveDialog).toHaveBeenLastCalledWith('w1')
    })

    it('after an archive that kept the branch, the button archives and the menu marks Archive as last used', async () => {
      fakeState.archiveChoice = 'archive'
      const user = userEvent.setup()
      render(<GitHeaderActions workspaceId="w1" status={merged()} refresh={vi.fn()} running={false} />)
      await user.click(screen.getByRole('button', { name: /^Archive$/ }))
      expect(archiveDialog).toHaveBeenLastCalledWith('w1')
      await user.click(screen.getByRole('button', { name: 'More options after merging' }))
      expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['ArchiveLast used', 'Archive and delete branch', 'Open #41 on GitHub'])
    })

    it('an adopted checkout archives even when the last archive deleted a branch', async () => {
      fakeState.archiveChoice = 'delete-branch'
      fakeState.snapshot.workspaces = [{ id: 'w1', adopted: true }]
      const user = userEvent.setup()
      render(<GitHeaderActions workspaceId="w1" status={merged()} refresh={vi.fn()} running={false} />)
      await user.click(screen.getByRole('button', { name: /^Archive$/ }))
      expect(archiveDialog).toHaveBeenLastCalledWith('w1')
    })

    it('an adopted checkout is not offered to delete its branch', async () => {
      fakeState.snapshot.workspaces = [{ id: 'w1', adopted: true }]
      const user = userEvent.setup()
      render(<GitHeaderActions workspaceId="w1" status={merged()} refresh={vi.fn()} running={false} />)
      await user.click(screen.getByRole('button', { name: 'More options after merging' }))
      expect(screen.queryByRole('menuitem', { name: 'Archive and delete branch' })).toBeNull()
    })

    it('the progress strip shows every step behind it, with Merged as where the work is now', () => {
      const checks = [{ name: 'a', state: 'success' }, { name: 'b', state: 'success' }]
      render(<MergedProgress pr={{ ...pr, checks } as never} />)
      const list = screen.getByRole('list', { name: 'Pull request progress' })
      const items = within(list).getAllByRole('listitem')
      expect(items.map((li) => li.textContent)).toEqual(['Committed, done', 'PR #41, done', 'Checks 2/2, done', 'Merged'])
      expect(items[3].getAttribute('aria-current')).toBe('step')
      expect(items.map((li) => li.dataset.tone)).toEqual(['ok', 'ok', 'ok', 'info'])
    })

    it('the strip marks failed checks, leaves out checks when there were none, and uses GitLab’s words', () => {
      const { unmount } = render(<MergedProgress pr={{ ...pr, checks: [{ name: 'a', state: 'success' }, { name: 'b', state: 'failure' }] } as never} />)
      const checksStep = screen.getAllByRole('listitem')[2]
      expect(checksStep.textContent).toBe('Checks 1/2, done')
      expect(checksStep.dataset.tone).toBe('error')
      unmount()
      render(<MergedProgress pr={{ ...pr, provider: 'gitlab' } as never} />)
      const list = screen.getByRole('list', { name: 'Merge request progress' })
      expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Committed, done', 'MR !41, done', 'Merged'])
    })

    it('the status says which PR merged into what and when, and the number opens it', async () => {
      ;(storeModule.timeAgo as ReturnType<typeof vi.fn>).mockReturnValue('2h ago')
      const user = userEvent.setup()
      const { container } = render(<MergedStatus pr={pr as never} />)
      expect(container.textContent).toBe('Merged#41 into main · 2h ago')
      await user.click(screen.getByRole('button', { name: '#41' }))
      expect(fakeApi.openExternal).toHaveBeenCalledWith(pr.url)
    })
  })
})
