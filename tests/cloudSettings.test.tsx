// @vitest-environment jsdom
// Settings → Remote workspaces: the Claude sign-in choices are radio cards with their own buttons beside the label.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudPage } from '../src/renderer/src/components/settings/CloudPage'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
// The login terminal draws with xterm, which needs a real canvas.
vi.mock('../src/renderer/src/components/settings/LoginTerminal', () => ({ LoginTerminal: () => <div>terminal</div> }))

beforeEach(() => {
  resetFake()
  fakeState.snapshot.settings.cloud = { claudeAuth: 'setup-token' }
  fakeState.snapshot.agentKeys = {}
  fakeApi.cloudClaudeToken = vi.fn(async () => ({ hint: 'abcd', savedAt: new Date().toISOString() }))
  fakeApi.cloudUsage = vi.fn(async () => [])
  fakeApi.updateSettings = vi.fn(async () => ({}))
  fakeApi.cloudSetClaudeToken = vi.fn(async () => undefined)
})
afterEach(cleanup)

const group = () => screen.getByRole('group', { name: 'Sign-in used inside sandboxes' })

describe('the Claude sign-in cards', () => {
  it('are two native radios in a fieldset, the chosen one checked, named by their titles', async () => {
    render(<CloudPage />)
    const radios = within(group()).getAllByRole('radio') as HTMLInputElement[]
    expect(radios).toHaveLength(2)
    expect(radios[0].checked).toBe(true)
    expect(radios[0].getAttribute('aria-labelledby')).toBeTruthy()
    expect(radios[0].name).toBe(radios[1].name)
    expect(screen.getByRole('radio', { name: /Setup token from/ })).toBe(radios[0])
    expect(screen.getByRole('radio', { name: 'API key' })).toBe(radios[1])
  })

  it('choosing the other card saves it', async () => {
    const user = userEvent.setup()
    render(<CloudPage />)
    await user.click(screen.getByRole('radio', { name: 'API key' }))
    await waitFor(() => expect(fakeApi.updateSettings).toHaveBeenCalledWith({ cloud: { claudeAuth: 'api-key' } }))
  })

  it('keep their buttons beside the label, so pressing one does not choose the card', async () => {
    fakeState.snapshot.settings.cloud = { claudeAuth: 'api-key' }
    const user = userEvent.setup()
    render(<CloudPage />)
    const tokenCard = screen.getByRole('radio', { name: /Setup token from/ })
    const paste = await screen.findByRole('button', { name: 'Paste a token' })
    expect(tokenCard.closest('label')?.contains(paste)).toBe(false)
    expect(group().contains(paste)).toBe(true)
    await user.click(paste)
    expect(paste.getAttribute('aria-expanded')).toBe('true')
    expect(fakeApi.updateSettings).not.toHaveBeenCalled()
    expect((tokenCard as HTMLInputElement).checked).toBe(false)
    // Each button is its own tab stop.
    const stops = within(group()).getAllByRole('button').map((b) => b.textContent)
    expect(stops).toEqual(expect.arrayContaining(['Run setup-token…', 'Paste a token', 'Remove']))
  })

  it('Remove clears the saved token', async () => {
    const user = userEvent.setup()
    render(<CloudPage />)
    await user.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(fakeApi.cloudSetClaudeToken).toHaveBeenCalledWith(null))
  })

  it('says what is missing on the API key card, with a button to fix it', async () => {
    const user = userEvent.setup()
    render(<CloudPage />)
    const key = screen.getByRole('radio', { name: 'API key' })
    expect(key.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(key.getAttribute('aria-describedby')!)?.textContent).toContain('No Anthropic key saved yet')
    await user.click(within(group()).getByRole('button', { name: 'Open Agents & models' }))
  })

  it('the Remote workspaces switch is named by its row', () => {
    render(<CloudPage />)
    const sw = screen.getByRole('switch', { name: 'Remote workspaces' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(sw.getAttribute('aria-describedby')).toBeTruthy()
  })
})
