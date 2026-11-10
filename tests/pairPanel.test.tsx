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

  it('lists each paired device with its kind and access, a record without scopes as Operate', () => {
    render(<PairPanel info={info} onInfo={vi.fn()} />)
    const rows = within(screen.getByRole('list', { name: 'Paired phones' })).getAllByRole('listitem')
    expect(within(rows[0]).getByRole('img', { name: 'Phone' })).toBeTruthy()
    expect(rows[0].textContent).toContain('Operate')
    expect(within(rows[1]).getByRole('img', { name: 'Browser' })).toBeTruthy()
    expect(rows[1].textContent).toContain('Watch')
  })
})
