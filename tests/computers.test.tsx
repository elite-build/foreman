// @vitest-environment jsdom
// Other computers in the window (shared/remote.ts): the computer chip and its menu, the banner while another computer
// is shown, the chip the person at a controlled computer sees, and the Allow / Deny request.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComputerChip } from '../src/renderer/src/components/computers/ComputerChip'
import { ControlledChip } from '../src/renderer/src/components/computers/ControlledChip'
import { ControlRequestDialog } from '../src/renderer/src/components/computers/ControlRequestDialog'
import { RemoteBanner } from '../src/renderer/src/components/computers/RemoteBanner'
import type { ComputersView } from '../src/shared/remote'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>

function view(patch: Partial<ComputersView> = {}): ComputersView {
  return {
    self: { id: 'pc', name: 'Desk', platform: 'win32', summary: { running: 1, needsYou: 0 } },
    computers: [
      { id: 'mac', name: 'MacBook Pro', platform: 'darwin', status: 'online', summary: { running: 3, needsYou: 1 } },
      { id: 'mini', name: 'Studio Mac mini', platform: 'darwin', status: 'offline' }
    ],
    viewing: null,
    joining: null,
    controllers: [],
    requests: [],
    ...patch
  }
}

beforeEach(() => {
  resetFake()
  for (const name of ['viewComputer', 'openPairDialog', 'openSettingsPage']) spy(name).mockClear()
  fakeState.computers = view()
})
afterEach(cleanup)

describe('the computer chip', () => {
  it('stays away until a computer is paired', () => {
    fakeState.computers = view({ computers: [] })
    const { container } = render(<ComputerChip />)
    expect(container.innerHTML).toBe('')
  })

  it('says which computer the window shows and that another one needs you, in words', () => {
    render(<ComputerChip />)
    const chip = screen.getByRole('button', { name: /This computer/ })
    expect(chip.getAttribute('aria-haspopup')).toBe('menu')
    expect(within(chip).getByLabelText('1 on another computer needs you')).toBeTruthy()
  })

  it('lists the paired computers, switches to an online one, and can’t pick one that is out of reach', async () => {
    const user = userEvent.setup()
    render(<ComputerChip />)
    await user.click(screen.getByRole('button', { name: /This computer/ }))
    const menu = screen.getByRole('menu', { name: 'Computers' })
    const here = within(menu).getByRole('menuitemradio', { name: /Desk/ })
    expect(here.getAttribute('aria-checked')).toBe('true')
    expect(within(menu).getByRole('menuitemradio', { name: /MacBook Pro/ }).textContent).toContain('Online · 3 running · 1 needs you')
    expect((within(menu).getByRole('menuitemradio', { name: /Studio Mac mini/ }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(within(menu).getByRole('menuitemradio', { name: /MacBook Pro/ }))
    expect(spy('viewComputer')).toHaveBeenCalledWith('mac')
  })

  it('offers pairing and settings only for this computer, and the way back while another is shown', async () => {
    const user = userEvent.setup()
    fakeState.computers = view({ viewing: { id: 'mac', name: 'MacBook Pro', state: 'connected' }, self: { id: 'pc', name: 'Desk', platform: 'win32', summary: { running: 0, needsYou: 2 } } })
    render(<ComputerChip />)
    const chip = screen.getByRole('button', { name: /MacBook Pro/ })
    // This computer's own count shows while another is on screen.
    expect(within(chip).getByLabelText('2 on other computers need you')).toBeTruthy()
    await user.click(chip)
    expect(screen.queryByRole('menuitem', { name: /Pair a computer/ })).toBeNull()
    await user.click(screen.getByRole('menuitemradio', { name: /Desk/ }))
    expect(spy('viewComputer')).toHaveBeenCalledWith(null)
  })

  it('says it is waiting while the other computer asks its person', () => {
    fakeState.computers = view({ joining: { id: 'mac', name: 'MacBook Pro', waiting: true } })
    render(<ComputerChip />)
    expect(screen.getByRole('button', { name: /MacBook Pro/ }).getAttribute('title')).toBe('Waiting for someone at MacBook Pro to click Allow…')
  })
})

describe('the remote banner', () => {
  it('isn’t there while the window shows this computer', () => {
    const { container } = render(<RemoteBanner />)
    expect(container.innerHTML).toBe('')
  })

  it('says where the work runs and goes back', async () => {
    const user = userEvent.setup()
    fakeState.computers = view({ viewing: { id: 'mac', name: 'MacBook Pro', state: 'connected' } })
    render(<RemoteBanner />)
    expect(screen.getByRole('status').textContent).toContain('You’re controlling MacBook Pro.')
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Back to this computer' }))
    expect(spy('viewComputer')).toHaveBeenCalledWith(null)
  })

  it('warns when the link drops, and retries', async () => {
    const user = userEvent.setup()
    fakeState.computers = view({ viewing: { id: 'mac', name: 'MacBook Pro', state: 'lost' } })
    render(<RemoteBanner />)
    expect(screen.getByRole('alert').textContent).toContain('Lost the connection to MacBook Pro.')
    await user.click(screen.getByRole('button', { name: 'Retry now' }))
    expect(spy('viewComputer')).toHaveBeenCalledWith('mac')
  })
})

describe('being controlled', () => {
  it('shows who controls this computer and disconnects them', async () => {
    const user = userEvent.setup()
    fakeState.computers = view({ controllers: [{ id: 'pc', name: 'Desk', platform: 'win32', since: '2026-11-02T10:42:00Z' }] })
    render(<ControlledChip />)
    const chip = screen.getByRole('button', { name: /Desk/ })
    expect(chip.getAttribute('title')).toBe('Controlled from Desk')
    await user.click(chip)
    expect(screen.getByText('Desk is controlling this computer')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(fakeApi.disconnectController).toHaveBeenCalledWith('pc'))
  })

  it('asks before a computer takes control, and Escape is a no', async () => {
    const user = userEvent.setup()
    fakeState.computers = view({ requests: [{ id: 'r1', deviceId: 'pc', name: 'Desk', platform: 'win32' }] })
    render(<ControlRequestDialog />)
    const dialog = await screen.findByRole('dialog', { name: 'Desk wants to control this computer' })
    await user.click(within(dialog).getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(fakeApi.answerControlRequest).toHaveBeenCalledWith('r1', true))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(fakeApi.answerControlRequest).toHaveBeenCalledWith('r1', false))
  })
})
