// @vitest-environment jsdom
// The window's side of the update check: the sidebar notice, and Settings → General's "Check now".
import './domShims'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateNotice } from '../src/renderer/src/components/UpdateNotice'
import { GeneralPage } from '../src/renderer/src/components/settings/GeneralPage'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const update = { version: '0.2.0', current: '0.1.0', url: 'https://github.com/elite-build/foreman/releases/tag/v0.2.0' }

beforeEach(() => {
  resetFake()
  fakeState.snapshot.update = undefined
  fakeState.snapshot.appVersion = '0.1.0'
  fakeState.snapshot.settings.checkForUpdates = true
  fakeApi.fullDiskAccess = vi.fn(async () => true)
})
afterEach(cleanup)

describe('UpdateNotice', () => {
  it('shows nothing without a newer release', () => {
    const { container } = render(<UpdateNotice />)
    expect(container.textContent).toBe('')
  })

  it('names the new and running versions, and Download opens the release page', async () => {
    fakeState.snapshot.update = update
    const user = userEvent.setup()
    render(<UpdateNotice />)
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('Foreman 0.2.0 is available')
    expect(notice.textContent).toContain('You’re on 0.1.0')
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(fakeApi.openExternal).toHaveBeenCalledWith(update.url)
  })

  it('Later puts it off for this run and Skip this version skips it', async () => {
    fakeState.snapshot.update = update
    const user = userEvent.setup()
    render(<UpdateNotice />)
    await user.click(screen.getByRole('button', { name: 'Later' }))
    expect(fakeApi.dismissUpdate).toHaveBeenLastCalledWith(false)
    await user.click(screen.getByRole('button', { name: 'Skip this version' }))
    expect(fakeApi.dismissUpdate).toHaveBeenLastCalledWith(true)
  })
})

describe('Settings → General → Check for updates', () => {
  it('the switch saves the setting', async () => {
    fakeApi.updateSettings = vi.fn(async () => ({}))
    const user = userEvent.setup()
    render(<GeneralPage />)
    await user.click(screen.getByRole('switch', { name: 'Check for updates when Foreman starts' }))
    expect(fakeApi.updateSettings).toHaveBeenCalledWith({ checkForUpdates: false })
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
