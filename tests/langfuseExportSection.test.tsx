// @vitest-environment jsdom
// Settings → Data → Langfuse (docs/telemetry.md, "Langfuse"): off without a connection, choosing one turns sending on,
// earlier turns go when asked, and a failure is said in words.
import './domShims'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LangfuseExportSection } from '../src/renderer/src/components/settings/LangfuseExportSection'
import type { LangfuseExportStatus } from '../src/shared/langfuseExport'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const off: LangfuseExportStatus = { connectionId: null, content: false, device: { id: 'd1', name: 'desk' }, sentTurns: 0, sentEvents: 0 }
const mine = { id: 'c1', service: 'langfuse', name: 'Mine', identity: { user: 'acme', org: 'foreman-app', checkedAt: '2026-11-22T00:00:00Z' } }

beforeEach(() => {
  resetFake()
  fakeState.snapshot.integrations = { connections: [] }
})
afterEach(cleanup)

describe('Settings → Data → Langfuse', () => {
  it('stays off and says what to add first when there is no Langfuse connection', async () => {
    fakeApi.langfuseExportStatus = vi.fn(async () => off)
    render(<LangfuseExportSection />)
    expect(await screen.findByText(/Add a Langfuse connection in Settings → Integrations first/)).toBeTruthy()
    expect((screen.getByRole('combobox', { name: 'Send to Langfuse' }) as HTMLSelectElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })

  it('turns sending on for the connection chosen, without content until asked', async () => {
    fakeState.snapshot.integrations = { connections: [mine, { ...mine, id: 'g1', service: 'github', name: 'GitHub' }] }
    fakeApi.langfuseExportStatus = vi.fn(async () => off)
    fakeApi.setLangfuseExport = vi.fn(async () => ({ ...off, connectionId: 'c1' }))
    render(<LangfuseExportSection />)
    const select = (await screen.findByRole('combobox', { name: 'Send to Langfuse' })) as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(['Off', 'Mine · foreman-app'])
    await userEvent.selectOptions(select, 'c1')
    expect(fakeApi.setLangfuseExport).toHaveBeenCalledWith({ connectionId: 'c1', content: false })
    expect(await screen.findByRole('button', { name: 'Send' })).toBeTruthy()
  })

  it('says in words that Langfuse isn’t answering, and when it was last checked, instead of main’s error', async () => {
    fakeState.snapshot.integrations = { connections: [mine] }
    fakeApi.langfuseExportStatus = vi.fn(async () => ({
      ...off,
      connectionId: 'c1',
      lastError: 'Couldn’t reach Langfuse at http://localhost:3000: fetch failed',
      reach: { state: 'unreachable', host: 'http://localhost:3000', at: '2026-11-23T09:00:00.000Z' }
    }))
    render(<LangfuseExportSection />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/^Langfuse at http:\/\/localhost:3000 isn’t answering, so nothing reaches it\./)
    expect(alert.textContent).toMatch(/Last checked /)
    expect(alert.textContent).not.toMatch(/fetch failed/)
  })

  it('sends earlier turns for the days chosen, and says why sending failed', async () => {
    fakeState.snapshot.integrations = { connections: [mine] }
    const on = { ...off, connectionId: 'c1', lastError: 'Langfuse refused this key pair.' }
    // Main's status, which says it is sending once asked to (the section reads it again as soon as sending starts).
    let current: LangfuseExportStatus = on
    fakeApi.langfuseExportStatus = vi.fn(async () => current)
    fakeApi.sendEarlierToLangfuse = vi.fn(async () => (current = { ...on, backfill: { days: 90, done: 0, total: 12 } }))
    render(<LangfuseExportSection />)
    expect((await screen.findByRole('alert')).textContent).toBe('Langfuse refused this key pair.')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'How far back' }), '90')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(fakeApi.sendEarlierToLangfuse).toHaveBeenCalledWith(90)
    expect(await screen.findByText('Sending 0 of 12…')).toBeTruthy()
  })
})
