// @vitest-environment jsdom
// The window's side of updates: the sidebar card through the download and install, "What's new" and the toast after an
// update, and Settings → General → Updates.
import './domShims'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdatePhase, UpdateView } from '../src/shared/appUpdate'
import { UpdateNotice } from '../src/renderer/src/components/UpdateNotice'
import { openWhatsNew, WhatsNew } from '../src/renderer/src/components/WhatsNew'
import { GeneralPage } from '../src/renderer/src/components/settings/GeneralPage'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const update = { version: '0.2.0', current: '0.1.0', url: 'https://github.com/elite-build/foreman/releases/tag/v0.2.0', notes: '## New\n- Compare runs' }

function offer(phase: UpdatePhase, extra: Partial<UpdateView> = {}): void {
  fakeState.snapshot.update = { checking: false, notice: { ...update, phase }, ...extra } satisfies UpdateView
}

function running(...names: string[]): void {
  fakeState.snapshot.workspaces = names.map((name, i) => ({ id: `w${i}`, name, state: 'ready' }))
  fakeState.snapshot.sessions = names.map((_, i) => ({ id: `s${i}`, workspaceId: `w${i}`, status: 'running', turnId: `t${i}` }))
}

beforeEach(() => {
  resetFake()
  fakeState.snapshot.update = undefined
  fakeState.snapshot.appVersion = '0.1.0'
  fakeState.snapshot.workspaces = []
  fakeState.snapshot.sessions = []
  Object.assign(fakeState.snapshot.settings, { checkForUpdates: true, updateInterval: 'every-4-hours', updateMode: 'download', updateChannel: 'stable' })
  fakeApi.fullDiskAccess = vi.fn(async () => true)
  fakeApi.downloadUpdate = vi.fn(async () => undefined)
  fakeApi.openExternal = vi.fn(async () => undefined)
  fakeApi.releaseNotes = vi.fn(async (version: string) => ({ version, url: update.url, notes: '## New\n- Compare runs', publishedAt: '2026-10-01T00:00:00Z' }))
})
afterEach(() => {
  act(() => openWhatsNew(''))
  cleanup()
})

describe('UpdateNotice', () => {
  it('shows nothing without a newer release', () => {
    const { container } = render(<UpdateNotice />)
    expect(container.textContent).toBe('')
    fakeState.snapshot.update = { checking: false }
    expect(render(<UpdateNotice />).container.textContent).toBe('')
  })

  it('where Foreman can’t install updates, Download opens the release page', async () => {
    offer({ state: 'available' }, { installUnavailable: 'unsigned' })
    const user = userEvent.setup()
    render(<UpdateNotice />)
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('Foreman 0.2.0 is available')
    expect(notice.textContent).toContain('You’re on 0.1.0. Download the new version')
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(fakeApi.openExternal).toHaveBeenCalledWith(update.url)
    expect(fakeApi.downloadUpdate).not.toHaveBeenCalled()
  })

  it('where it can, Download fetches it in the background', async () => {
    offer({ state: 'available' })
    const user = userEvent.setup()
    render(<UpdateNotice />)
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(fakeApi.downloadUpdate).toHaveBeenCalled()
    expect(fakeApi.openExternal).not.toHaveBeenCalled()
  })

  it('Later puts it off for this run and Skip this version skips it', async () => {
    offer({ state: 'available' })
    const user = userEvent.setup()
    render(<UpdateNotice />)
    await user.click(screen.getByRole('button', { name: 'Later' }))
    expect(fakeApi.dismissUpdate).toHaveBeenLastCalledWith(false)
    await user.click(screen.getByRole('button', { name: 'Skip this version' }))
    expect(fakeApi.dismissUpdate).toHaveBeenLastCalledWith(true)
  })

  it('downloading: the size so far on a meter, and Stop', async () => {
    offer({ state: 'downloading', transferred: 32 * 1024 * 1024, total: 64 * 1024 * 1024 })
    const user = userEvent.setup()
    render(<UpdateNotice />)
    expect(screen.getByRole('status').textContent).toContain('Downloading Foreman 0.2.0')
    const meter = screen.getByRole('meter', { name: 'Download progress' })
    expect(meter.getAttribute('aria-valuenow')).toBe('50')
    expect(meter.getAttribute('aria-valuetext')).toBe('32 MB of 64 MB')
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(fakeApi.stopUpdateDownload).toHaveBeenCalled()
  })

  it('a failed download offers Try again and the release page', async () => {
    offer({ state: 'available', failed: true })
    const user = userEvent.setup()
    render(<UpdateNotice />)
    expect(screen.getByRole('status').textContent).toContain('Couldn’t download Foreman 0.2.0')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(fakeApi.downloadUpdate).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Release page' }))
    expect(fakeApi.openExternal).toHaveBeenCalledWith(update.url)
  })

  it('ready: Restart (which waits for running agents) and Install when I quit', async () => {
    offer({ state: 'ready', onQuit: false })
    const user = userEvent.setup()
    const { rerender } = render(<UpdateNotice />)
    expect(screen.getByRole('status').textContent).toContain('Foreman 0.2.0 is ready to install')
    await user.click(screen.getByRole('button', { name: 'Restart' }))
    expect(fakeApi.restartToUpdate).toHaveBeenLastCalledWith(true)
    await user.click(screen.getByRole('button', { name: 'Install when I quit' }))
    expect(fakeApi.installUpdateOnQuit).toHaveBeenCalledWith(true)
    running('lisbon')
    offer({ state: 'ready', onQuit: true })
    rerender(<UpdateNotice />)
    expect(screen.getByRole('button', { name: 'Restart when agents finish' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install when I quit' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('It installs when you quit Foreman')
  })

  it('waiting for agents: who is still working, Restart now and Cancel', async () => {
    running('lisbon', 'osaka')
    offer({ state: 'waiting' })
    const user = userEvent.setup()
    render(<UpdateNotice />)
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('Restarting after 2 agents finish')
    expect(notice.textContent).toContain('lisbon, osaka')
    await user.click(screen.getByRole('button', { name: 'Restart now' }))
    expect(fakeApi.restartToUpdate).toHaveBeenLastCalledWith(false)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(fakeApi.cancelUpdateRestart).toHaveBeenCalled()
  })
})

describe('What’s new', () => {
  it('opens from the card with the release notes, the agents a restart would stop, and the restart choices', async () => {
    running('lisbon')
    offer({ state: 'ready', onQuit: false })
    const user = userEvent.setup()
    render(
      <>
        <UpdateNotice />
        <WhatsNew />
      </>
    )
    await user.click(screen.getByRole('button', { name: 'What’s new' }))
    const dialog = await screen.findByRole('dialog', { name: 'Foreman 0.2.0' })
    expect(fakeApi.releaseNotes).toHaveBeenCalledWith('0.2.0')
    expect(await within(dialog).findByText('Compare runs')).toBeTruthy()
    expect(within(dialog).getByText(/Ready to install · you’re on 0.1.0/)).toBeTruthy()
    expect(within(dialog).getByText('lisbon')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Restart when agents finish' }))
    expect(fakeApi.restartToUpdate).toHaveBeenLastCalledWith(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says when the notes can’t be loaded, and still links to the release page', async () => {
    fakeApi.releaseNotes = vi.fn(async () => null)
    const user = userEvent.setup()
    render(<WhatsNew />)
    act(() => openWhatsNew('0.1.0'))
    const dialog = await screen.findByRole('dialog', { name: 'Foreman 0.1.0' })
    expect(await within(dialog).findByText(/Couldn’t load the release notes/)).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Open the release page on GitHub' }))
    expect(fakeApi.openExternal).toHaveBeenCalledWith('https://github.com/elite-build/foreman/releases/tag/v0.1.0')
  })

  it('after an update, a toast says so once, with What’s new', async () => {
    fakeState.snapshot.appVersion = '0.2.0'
    fakeState.snapshot.update = { checking: false, updatedFrom: '0.1.0' } satisfies UpdateView
    const showToast = storeModule.showToast as ReturnType<typeof vi.fn>
    showToast.mockClear()
    render(<WhatsNew />)
    expect(showToast).toHaveBeenCalledWith('Updated to Foreman 0.2.0', 'info', expect.objectContaining({ action: expect.objectContaining({ label: 'What’s new' }) }))
    expect(fakeApi.dismissUpdated).toHaveBeenCalled()
    act(() => (showToast.mock.calls[0][2] as { action: { run: () => void } }).action.run())
    expect(await screen.findByRole('dialog', { name: 'Foreman 0.2.0' })).toBeTruthy()
  })
})

describe('Settings → General → Updates', () => {
  it('the switch, the schedule, what to do with a release and the channel save their settings', async () => {
    fakeState.snapshot.update = { checking: false } satisfies UpdateView
    fakeApi.updateSettings = vi.fn(async () => ({}))
    const user = userEvent.setup()
    render(<GeneralPage />)
    await user.click(screen.getByRole('switch', { name: 'Check for updates automatically' }))
    expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ checkForUpdates: false })
    await user.click(screen.getByRole('radio', { name: 'Daily' }))
    expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ updateInterval: 'daily' })
    await user.click(screen.getByRole('radio', { name: /Tell me/ }))
    expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ updateMode: 'notify' })
    await user.click(screen.getByRole('radio', { name: 'Beta' }))
    expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ updateChannel: 'beta' })
  })

  it('where Foreman can’t install updates, the download choices say why and Tell me applies', () => {
    fakeState.snapshot.update = { checking: false, installUnavailable: 'unsigned' } satisfies UpdateView
    render(<GeneralPage />)
    const download = screen.getByRole('radio', { name: /Download it in the background/ }) as HTMLInputElement
    expect(download.disabled).toBe(true)
    expect((screen.getByRole('radio', { name: /Tell me/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getAllByText(/signed with an Apple Developer ID/).length).toBeGreaterThan(0)
  })

  it('Check now shows the running version and says when Foreman is up to date', async () => {
    fakeApi.checkForUpdates = vi.fn(async () => ({ state: 'current', current: '0.1.0' }))
    const user = userEvent.setup()
    render(<GeneralPage />)
    expect(screen.getByText('You have Foreman 0.1.0')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Foreman is up to date')).toBeTruthy()
  })

  it('Check now offers a newer release with its Download button', async () => {
    fakeState.snapshot.update = { checking: false, installUnavailable: 'unsupported' } satisfies UpdateView
    fakeApi.checkForUpdates = vi.fn(async () => ({ state: 'available', update }))
    const user = userEvent.setup()
    render(<GeneralPage />)
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Foreman 0.2.0 is available')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(fakeApi.openExternal).toHaveBeenCalledWith(update.url)
  })

  it('Check now says when GitHub could not be reached, also when the call itself fails', async () => {
    fakeApi.checkForUpdates = vi.fn(async () => Promise.reject(new Error('ipc')))
    const user = userEvent.setup()
    render(<GeneralPage />)
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Couldn’t reach GitHub. Try again later.')).toBeTruthy()
  })
})
