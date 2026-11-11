// @vitest-environment jsdom
// Settings → Data & devices → Agents on this computer (docs/agent-access.md §9): the switch and the port tied to their
// registry rows, the address and the setup commands, a waiting sign-in approved with the code typed and the level chosen,
// its errors in the code field, and Revoke.
import './domShims'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentAccessSection } from '../src/renderer/src/components/settings/AgentAccessSection'
import type { AgentAccessInfo } from '../src/shared/agentAccess'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const pending = { id: 'p-1', name: 'Claude Code', redirect: '127.0.0.1:53682', expiresAt: Date.now() + 240_000 }
const grant = { id: 'g-1', clientId: 'c-1', name: 'Codex', redirect: '127.0.0.1:1455', level: 'auto' as const, grantedAt: '2026-11-01T09:00:00.000Z', lastSeen: new Date(Date.now() - 5 * 60_000).toISOString() }

function info(patch: Partial<AgentAccessInfo> = {}): AgentAccessInfo {
  return { enabled: true, port: 47634, url: 'http://127.0.0.1:47634/mcp', pending: [], grants: [], ...patch }
}

let emit: ((next: AgentAccessInfo) => void) | null = null

beforeEach(() => {
  resetFake()
  emit = null
  fakeState.snapshot.settings.agentAccessEnabled = true
  fakeState.snapshot.settings.agentAccessPort = 47634
  storeModule.onAgentAccess = (listener: (next: AgentAccessInfo) => void) => {
    emit = listener
    return () => void (emit = null)
  }
  fakeApi.updateSettings = vi.fn(async () => ({}))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const show = async (start: AgentAccessInfo) => {
  fakeApi.agentAccessInfo = vi.fn(async () => start)
  const view = render(<AgentAccessSection />)
  await waitFor(() => expect(fakeApi.agentAccessInfo).toHaveBeenCalled())
  return view
}

describe('Agents on this computer', () => {
  it('ties the switch and the port to their registry rows, and the switch saves the setting', async () => {
    const user = userEvent.setup()
    const { container } = await show(info())
    const toggle = screen.getByRole('switch', { name: 'Let agents on this computer connect' })
    expect(container.querySelector('#setting-agent-access')?.contains(toggle)).toBe(true)
    const port = screen.getByRole('textbox', { name: 'Port for agents on this computer' }) as HTMLInputElement
    expect(container.querySelector('#setting-agent-access-port')?.contains(port)).toBe(true)
    expect(port.value).toBe('47634')
    await user.click(toggle)
    await waitFor(() => expect(fakeApi.updateSettings).toHaveBeenCalledWith({ agentAccessEnabled: false }))
    await user.clear(port)
    await user.type(port, '48000{Enter}')
    await waitFor(() => expect(fakeApi.updateSettings).toHaveBeenCalledWith({ agentAccessPort: 48000 }))
  })

  it('shows the address and both setup commands as read-only text, Claude Code’s for every project', async () => {
    await show(info())
    const address = (await screen.findByRole('textbox', { name: 'Address' })) as HTMLInputElement
    expect(address.value).toBe('http://127.0.0.1:47634/mcp')
    expect(address.readOnly).toBe(true)
    expect((screen.getByRole('textbox', { name: 'Claude Code' }) as HTMLInputElement).value).toBe('claude mcp add --scope user --transport http foreman http://127.0.0.1:47634/mcp')
    expect((screen.getByRole('textbox', { name: 'Codex' }) as HTMLInputElement).value).toBe('codex mcp add foreman --url http://127.0.0.1:47634/mcp')
    expect(screen.getByRole('button', { name: 'Copy Address' })).toBeTruthy()
    // The threat model, in one sentence beside them.
    expect(document.body.textContent).toContain('not what it can do with its own shell and files')
  })

  it('says why the listener is off, and offers no address then', async () => {
    await show(info({ enabled: false, error: 'Foreman couldn’t listen for agents on 127.0.0.1:47634 (another program is using it).' }))
    expect((await screen.findByRole('alert')).textContent).toContain('another program is using it')
    expect(screen.queryByRole('textbox', { name: 'Address' })).toBeNull()
  })

  it('shows a waiting sign-in with where it returns, a code field and the levels with Ask chosen', async () => {
    await show(info({ pending: [pending] }))
    const group = await screen.findByRole('group', { name: 'Claude Code asks to sign in' })
    expect(document.body.textContent).toContain('Returns to 127.0.0.1:53682')
    const code = within(group).getByRole('textbox', { name: 'Code from its sign-in page' }) as HTMLInputElement
    expect(code.value).toBe('')
    const levels = within(group).getByRole('group', { name: 'Access level' })
    const radios = within(levels).getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual([
      expect.stringContaining('Read only'),
      expect.stringContaining('Ask'),
      expect.stringContaining('Ask except edits'),
      expect.stringContaining('Auto'),
      expect.stringContaining('Never ask')
    ])
    expect((within(levels).getByRole('radio', { name: /^Ask\b(?! except)/ }) as HTMLInputElement).checked).toBe(true)
    // Nothing in the window shows the code.
    expect(document.body.textContent).not.toMatch(/\b\d{6}\b/)
  })

  it('approves with the code as typed and the level chosen', async () => {
    const user = userEvent.setup()
    fakeApi.agentAccessApprove = vi.fn(async () => info())
    await show(info({ pending: [pending] }))
    const group = await screen.findByRole('group', { name: 'Claude Code asks to sign in' })
    await user.type(within(group).getByRole('textbox', { name: 'Code from its sign-in page' }), '123 456')
    await user.click(within(group).getByRole('radio', { name: /^Read only/ }))
    await user.click(within(group).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(fakeApi.agentAccessApprove).toHaveBeenCalledWith('p-1', '123 456', 'read'))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Claude Code asks to sign in' })).toBeNull())
  })

  it('puts a wrong code’s error in the code field and keeps the sign-in', async () => {
    const user = userEvent.setup()
    fakeApi.agentAccessApprove = vi.fn(async () => {
      throw new Error('That code doesn’t match the one the sign-in page shows. 2 tries left.')
    })
    await show(info({ pending: [pending] }))
    const group = await screen.findByRole('group', { name: 'Claude Code asks to sign in' })
    const code = within(group).getByRole('textbox', { name: 'Code from its sign-in page' })
    // Approve with nothing typed asks for the code, without calling main.
    await user.click(within(group).getByRole('button', { name: 'Approve' }))
    expect((await within(group).findByRole('alert')).textContent).toContain('Type the code first.')
    expect(fakeApi.agentAccessApprove).not.toHaveBeenCalled()
    await user.type(code, '000000{Enter}')
    await waitFor(() => expect(within(group).getByRole('alert').textContent).toContain('2 tries left'))
    expect(code.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('group', { name: 'Claude Code asks to sign in' })).toBeTruthy()
  })

  it('denies a waiting sign-in', async () => {
    const user = userEvent.setup()
    fakeApi.agentAccessDeny = vi.fn(async () => info())
    await show(info({ pending: [pending] }))
    await user.click(within(await screen.findByRole('group', { name: 'Claude Code asks to sign in' })).getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(fakeApi.agentAccessDeny).toHaveBeenCalledWith('p-1'))
  })

  it('lists the signed-in agents with their level and dates, and revokes one after asking', async () => {
    const user = userEvent.setup()
    fakeApi.agentAccessRevoke = vi.fn(async () => info())
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await show(info({ grants: [grant] }))
    const list = await screen.findByRole('list', { name: 'Signed-in agents' })
    const item = within(list).getByRole('listitem')
    expect(item.textContent).toContain('Codex')
    expect(item.textContent).toContain('Auto · approved')
    expect(item.textContent).toContain('last used 5m ago')
    await user.click(within(item).getByRole('button', { name: 'Revoke Codex' }))
    expect(confirm).toHaveBeenCalled()
    await waitFor(() => expect(fakeApi.agentAccessRevoke).toHaveBeenCalledWith('g-1'))
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Signed-in agents' })).toBeNull())
    expect(screen.getByRole('note').textContent).toContain('No agent has signed in yet')
  })

  it('follows the agent-access event: a sign-in that starts waiting appears', async () => {
    await show(info())
    await waitFor(() => expect(emit).not.toBeNull())
    expect(screen.queryByRole('group', { name: 'Claude Code asks to sign in' })).toBeNull()
    act(() => emit!(info({ pending: [pending] })))
    expect(await screen.findByRole('group', { name: 'Claude Code asks to sign in' })).toBeTruthy()
  })
})
