// @vitest-environment jsdom
// The pairing panel's approval chooses what the phone or browser may do (docs/server.md, "Sessions"), Operate unless
// the person at the desktop picks otherwise, and the paired list says each device's kind and access.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PairPanel } from '../src/renderer/src/components/phone/PairPanel'
import type { MobileInfo } from '../src/shared/mobile'
import { fakeApi, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const info: MobileInfo = {
  enabled: true,
  url: 'https://desk.example.ts.net',
  port: 47632,
  lan: { enabled: false, address: '', port: 47633, candidates: [] },
  devices: [
    { id: 'd1', name: 'Old iPhone', pairedAt: '2026-01-01T00:00:00Z', transport: 'private' },
    { id: 'd2', name: 'Chrome', kind: 'browser', scopes: ['read'], pairedAt: '2026-01-01T00:00:00Z', transport: 'lan' }
  ],
  pending: { id: 'p1', name: 'New phone', kind: 'phone', code: '123456', mode: 'private', expiresAt: Date.now() + 60_000 }
}

beforeEach(() => {
  resetFake()
  fakeApi.mobileApprovePairing = vi.fn(async () => ({ ...info, pending: undefined }))
})
afterEach(cleanup)

describe('PairPanel', () => {
  it('approves with Operate unless another access is chosen', async () => {
    const user = userEvent.setup()
    const onInfo = vi.fn()
    render(<PairPanel info={info} onInfo={onInfo} />)
    const group = screen.getByRole('group', { name: 'What it may do' })
    expect((within(group).getByRole('radio', { name: 'Operate' }) as HTMLInputElement).checked).toBe(true)
    expect(within(group).getByRole('radio', { name: 'Watch', description: 'See workspaces, chats, diffs and checks. Change nothing.' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Pair phone' }))
    expect(fakeApi.mobileApprovePairing).toHaveBeenLastCalledWith('p1', true, 'operate')
    expect(onInfo).toHaveBeenCalled()

    cleanup()
    render(<PairPanel info={info} onInfo={onInfo} />)
    await user.click(screen.getByRole('radio', { name: 'Watch' }))
    await user.click(screen.getByRole('button', { name: 'Pair phone' }))
    expect(fakeApi.mobileApprovePairing).toHaveBeenLastCalledWith('p1', true, 'read')
  })

  it('says the browser is signed in, not paired, when a browser asks', async () => {
    const user = userEvent.setup()
    render(<PairPanel info={{ ...info, pending: { ...info.pending!, name: 'Chrome on Mac', kind: 'browser' } }} onInfo={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Pair phone' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Sign in browser' }))
    expect(fakeApi.mobileApprovePairing).toHaveBeenLastCalledWith('p1', true, 'operate')
  })

  it('gives a browser the link to open at /app, to copy, beside the QR code a phone scans', async () => {
    const user = userEvent.setup()
    const pairing = { mode: 'private' as const, url: 'https://desk.example.ts.net/?pair=SECRET', qr: 'data:image/png;base64,', expiresAt: Date.now() + 60_000 }
    fakeApi.mobileStartPairing = vi.fn(async () => ({ ...info, pending: undefined, pairing }))
    const onInfo = vi.fn()
    render(<PairPanel info={{ ...info, pending: undefined }} onInfo={onInfo} />)
    const what = screen.getByRole('radiogroup', { name: 'What is signing in' })
    expect(within(what).getByRole('radio', { name: 'Phone' }).getAttribute('aria-checked')).toBe('true')
    await user.click(within(what).getByRole('radio', { name: 'Browser' }))
    await user.click(screen.getByRole('button', { name: 'Show sign-in link' }))
    expect(fakeApi.mobileStartPairing).toHaveBeenCalledWith('private')
    expect(onInfo).toHaveBeenCalled()

    cleanup()
    render(<PairPanel info={{ ...info, pending: undefined, pairing }} onInfo={vi.fn()} />)
    // A phone scans the code; nothing to copy.
    expect(screen.getByText('Scan with your phone’s camera')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Sign-in link for a browser' })).toBeNull()
    await user.click(screen.getByRole('radio', { name: 'Browser' }))
    const link = screen.getByRole('textbox', { name: 'Sign-in link for a browser' }) as HTMLInputElement
    expect(link.value).toBe('https://desk.example.ts.net/app?pair=SECRET')
    expect(link.readOnly).toBe(true)
    expect(screen.getByText(/must reach this computer at this address/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(await navigator.clipboard.readText()).toBe('https://desk.example.ts.net/app?pair=SECRET')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('lists each paired device with its kind and access, a record without scopes as Operate', () => {
    render(<PairPanel info={info} onInfo={vi.fn()} />)
    const rows = within(screen.getByRole('list', { name: 'Paired phones' })).getAllByRole('listitem')
    expect(within(rows[0]).getByRole('img', { name: 'Phone' })).toBeTruthy()
    expect(rows[0].textContent).toContain('Operate')
    expect(within(rows[1]).getByRole('img', { name: 'Browser' })).toBeTruthy()
    expect(rows[1].textContent).toContain('Watch')
  })
})
