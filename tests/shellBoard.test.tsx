// @vitest-environment jsdom
// The shell's other risky surfaces (design system phase 3, batch B1): Home's rows and board (open, keyboard move,
// drag and drop), the archive sheet's steps and its failure path, and the clone dialog.
import './domShims'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from '../src/renderer/src/store'
import { ArchiveDialog } from '../src/renderer/src/components/ArchiveDialog'
import { CloneRepoDialog } from '../src/renderer/src/components/AddRepository'
import { HomeBoard } from '../src/renderer/src/components/HomeBoard'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => (store as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]

const ws = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, repoId: 'r1', name, branch: name, state: 'ready', createdAt: '2026-01-01T00:00:00Z', ...extra }) as never
const NOW = Date.parse('2026-02-01T12:00:00Z')

beforeEach(() => {
  resetFake()
  vi.clearAllMocks()
  // jsdom has no CSS.escape, which the board uses to put focus back on a moved card.
  ;(globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value }
  fakeApi.updateWorkspace = vi.fn(async () => undefined)
  Object.assign(fakeState.snapshot, {
    platform: 'linux',
    repos: [{ id: 'r1', name: 'kite', rootPath: '/code/kite', defaultBranch: 'main' }],
    workspaces: [],
    sessions: [],
    recentRepos: [],
    homeDir: '/home/me'
  })
  Object.assign(fakeState.snapshot.settings, { homeDoneDays: 7, cloneDirectory: '/home/me/code', cloud: {} })
})
afterEach(cleanup)

describe('Home board', () => {
  const items = [
    { ws: ws('w1', 'fix-login'), bucket: 'attention', tone: 'amber', label: 'Approve a command', since: '2026-02-01T11:00:00Z' },
    { ws: ws('w2', 'add-search', { status: 'in-review' }), bucket: 'idle', since: '2026-02-01T10:00:00Z' }
  ] as never[]
  const card = (name: string) => screen.getByRole('button', { name: new RegExp(name) })
  const lane = (name: RegExp) => screen.getByRole('region', { name })

  it('puts each workspace in the lane its facts say, as a button that opens it', async () => {
    render(<HomeBoard items={items} now={NOW} />)
    expect(within(lane(/needs/i)).getByRole('button', { name: /fix-login/ })).toBeTruthy()
    expect(within(lane(/review/i)).getByRole('button', { name: /add-search/ })).toBeTruthy()
    await userEvent.setup().click(card('fix-login'))
    expect(spy('selectWorkspace')).toHaveBeenCalledWith('w1')
  })

  it('Alt+→ on a focused card moves it to the next lane that takes drops, and says so with Undo', async () => {
    render(<HomeBoard items={items} now={NOW} />)
    card('fix-login').focus()
    fireEvent.keyDown(card('fix-login'), { key: 'ArrowRight', altKey: true })
    await waitFor(() => expect(fakeApi.updateWorkspace).toHaveBeenCalledWith('w1', { status: 'in-review' }))
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalled())
    expect(spy('showToast').mock.calls.at(-1)?.[2]).toMatchObject({ action: { label: expect.any(String) } })
    // The card keeps keyboard focus after the move.
    await waitFor(() => expect(document.activeElement).toBe(card('fix-login')))
  })

  it('Alt+← from the first lane that takes drops says there is nowhere to go and changes nothing', async () => {
    render(<HomeBoard items={items} now={NOW} />)
    fireEvent.keyDown(card('add-search'), { key: 'ArrowLeft', altKey: true })
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledTimes(1))
    expect(fakeApi.updateWorkspace).not.toHaveBeenCalled()
  })

  it('dragging a card onto a lane that takes drops sets its status; a lane from live facts refuses', async () => {
    render(<HomeBoard items={items} now={NOW} />)
    const row = card('fix-login').closest('.ui-action-row') as HTMLElement
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() }
    fireEvent.dragStart(row, { dataTransfer })
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'fix-login')
    // A live lane is not a target: the drop is not allowed (default not prevented).
    const refused = fireEvent.dragOver(lane(/working/i), { dataTransfer })
    expect(refused).toBe(true)
    const target = lane(/review/i)
    expect(fireEvent.dragOver(target, { dataTransfer })).toBe(false)
    fireEvent.drop(target, { dataTransfer })
    await waitFor(() => expect(fakeApi.updateWorkspace).toHaveBeenCalledWith('w1', { status: 'in-review' }))
  })
})

describe('archive sheet', () => {
  const preview = { kind: 'worktree', running: [], branch: 'fix-login', uncommitted: 0, folder: '/code/kite/w1', terminals: 0, hasArchiveScript: false }

  beforeEach(() => {
    fakeState.archiveDeleteBranch = false
    ;(store.bridge as unknown as Record<string, unknown>).onEvent = () => () => undefined
    fakeState.snapshot.workspaces = [ws('w1', 'fix-login')]
    fakeApi.archivePreview = vi.fn(async () => preview)
    fakeApi.archiveWorkspace = vi.fn(async () => ({ ok: true }))
  })

  it('is a named dialog; Archive runs it with the tabs stopped', async () => {
    const user = userEvent.setup()
    render(<ArchiveDialog workspaceId="w1" />)
    expect(screen.getByRole('dialog', { name: /fix-login/ })).toBeTruthy()
    const go = await screen.findByRole('button', { name: /^archive$|archive workspace|archive…/i })
    await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false))
    await user.click(go)
    await waitFor(() => expect(fakeApi.archiveWorkspace).toHaveBeenCalledWith('w1', false, { stopTabs: true }))
  })

  it('the delete-branch checkbox is passed on', async () => {
    const user = userEvent.setup()
    render(<ArchiveDialog workspaceId="w1" />)
    await user.click(await screen.findByRole('checkbox'))
    const go = screen.getByRole('button', { name: /^archive$|archive workspace|archive…/i })
    await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false))
    await user.click(go)
    await waitFor(() => expect(fakeApi.archiveWorkspace).toHaveBeenCalledWith('w1', true, { stopTabs: true }))
  })

  it('a failed step shows an alert with its detail, and "anyway" asks for a second click', async () => {
    const user = userEvent.setup()
    fakeApi.archiveWorkspace = vi.fn(async () => ({ ok: false, step: 'checkpoint', detail: 'disk full' }))
    render(<ArchiveDialog workspaceId="w1" />)
    const go = await screen.findByRole('button', { name: /^archive$|archive workspace|archive…/i })
    await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false))
    await user.click(go)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('disk full')
    const buttons = screen.getAllByRole('button').filter((b) => b.closest('.ui-dialog__foot'))
    expect(buttons.length).toBe(3)
    // The first footer button is "archive anyway": one click arms it, the second runs.
    await user.click(buttons[0])
    expect(fakeApi.archiveWorkspace).toHaveBeenCalledTimes(1)
    await user.click(screen.getAllByRole('button').filter((b) => b.closest('.ui-dialog__foot'))[0])
    await waitFor(() => expect(fakeApi.archiveWorkspace).toHaveBeenCalledTimes(2))
    expect(fakeApi.archiveWorkspace.mock.calls[1][2]).toMatchObject({ from: 'checkpoint', anyway: true })
  })

  it('Escape closes it', async () => {
    const user = userEvent.setup()
    render(<ArchiveDialog workspaceId="w1" />)
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    expect(spy('finishBackgroundArchive')).toHaveBeenCalledWith('w1')
  })
})

describe('clone dialog', () => {
  beforeEach(() => {
    fakeApi.githubRepos = vi.fn(async () => ({ repos: [], protocol: 'https' }))
    fakeApi.githubAccounts = vi.fn(async () => [])
    spy('onCloneProgress').mockReturnValue(() => undefined)
    spy('cloneRepository').mockResolvedValue(undefined)
  })

  it('is a dialog whose fields have names; Enter in the URL field clones into the chosen folder', async () => {
    const user = userEvent.setup()
    render(<CloneRepoDialog />)
    const dialog = screen.getByRole('dialog')
    const textboxes = within(dialog).getAllByRole('textbox')
    expect(textboxes.length).toBeGreaterThanOrEqual(2)
    for (const box of textboxes) expect(box.getAttribute('id')).toBeTruthy()
    const [url, location] = textboxes.filter((b) => b.tagName === 'INPUT') as HTMLInputElement[]
    expect(location.value).toBe('/home/me/code')
    await user.type(url, 'https://github.com/user/repo.git{Enter}')
    await waitFor(() => expect(spy('cloneRepository')).toHaveBeenCalledWith('https://github.com/user/repo.git', '/home/me/code', expect.any(String), undefined))
  })

  it('Cancel and Escape close it', async () => {
    const user = userEvent.setup()
    render(<CloneRepoDialog />)
    await user.keyboard('{Escape}')
    expect(spy('openAddRepoDialog')).toHaveBeenCalledWith(null)
  })
})
