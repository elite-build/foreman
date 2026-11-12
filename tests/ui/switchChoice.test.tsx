// @vitest-environment jsdom
// A blocked move in the agent picker (docs/agents.md 5.4): the choice is shown disabled and its reason sits on a line of
// its own under it (a disabled row dims its contents, so the reason can't live inside), tied to the row for assistive
// technology, before anything changes.
import '../domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPicker } from '../../src/renderer/src/components/composer/AgentPicker'
import { setModelCatalog } from '../../src/shared/agents'
import type { Session, Workspace } from '../../src/shared/types'
import { fakeApi, fakeState, resetFake } from '../rendererStore'

vi.mock('../../src/renderer/src/store', async () => (await import('../rendererStore')).storeModule)

const ws = (cloud = false): Workspace => ({ id: 'w1', repoId: 'r1', name: 'lisbon', branch: 'fix', baseBranch: 'main', portBase: 50000, state: 'ready', createdAt: '2026-11-05T10:00:00.000Z', ...(cloud ? { cloud: {} as never } : {}) })
const session = (over: Partial<Session> = {}): Session =>
  ({ id: 's1', workspaceId: 'w1', agent: 'claude', model: 'm1', agentSessionId: 'conv', fastMode: false, planMode: false, status: 'idle', queue: [], ...over }) as Session

const original = fakeState.snapshot
beforeEach(() => {
  resetFake()
  fakeApi.updateSession = vi.fn(async () => {})
  setModelCatalog({ claude: [{ id: 'm1', label: 'Model 1', agent: 'claude', efforts: [], supportsFast: false }], codex: [{ id: 'c1', label: 'Codex 1', agent: 'codex', efforts: [], supportsFast: false }] } as never)
  fakeState.snapshot.catalog = { agents: { claude: { fetchedAt: 'now' }, codex: { fetchedAt: 'now' } }, outputStyles: [] }
  fakeState.snapshot.settings.agentInstances = [{ id: 'ai-work0001', agent: 'claude', label: 'Work', auth: 'cli', home: '/accounts/work' }]
})
afterEach(() => {
  cleanup()
  setModelCatalog({})
  fakeState.snapshot = original
})

async function chooseWork(workspace: Workspace, rule?: 'as-text') {
  fakeState.snapshot.workspaces = [workspace]
  if (rule) fakeState.snapshot.settings.agentPrefs = { claude: { moveChats: rule } }
  const user = userEvent.setup()
  render(<AgentPicker session={session()} hasHistory open onOpenChange={() => undefined} />)
  await user.selectOptions(screen.getByLabelText('Account'), 'ai-work0001')
  return screen.getByRole('group', { name: 'Continue here or open a new chat' })
}

describe('the choice after picking an account', () => {
  it('under the default rule shows why on its own line, tied to the disabled row, and changes nothing', async () => {
    const group = await chooseWork(ws())
    const row = within(group).getByRole('button', { name: /Continue this chat on Work/ })
    expect((row as HTMLButtonElement).disabled).toBe(true)
    const reason = within(group).getByText('Settings → Agents → Claude Code keeps chats on their account')
    // A line of its own: a sibling of the dimmed row, not inside it.
    expect(row.closest('.ui-action-row')?.contains(reason)).toBe(false)
    expect(row.getAttribute('aria-describedby')).toBe(reason.closest('p')!.id)
    // The other way out stays open.
    expect((within(group).getByRole('button', { name: /Open a new chat instead/ }) as HTMLButtonElement).disabled).toBe(false)
    expect(fakeApi.updateSession).not.toHaveBeenCalled()
  })

  it('in a remote workspace says it takes only the default account', async () => {
    const group = await chooseWork(ws(true), 'as-text')
    const row = within(group).getByRole('button', { name: /Continue this chat on Work/ })
    expect((row as HTMLButtonElement).disabled).toBe(true)
    expect(within(group).getByText('A remote workspace runs on the default account only. Choose Default, or open a new chat.')).toBeTruthy()
  })

  it('has no reason line when the move is allowed, and continues', async () => {
    const group = await chooseWork(ws(), 'as-text')
    const row = within(group).getByRole('button', { name: /Continue this chat on Work/ })
    expect((row as HTMLButtonElement).disabled).toBe(false)
    expect(row.getAttribute('aria-describedby')).toBeNull()
    expect(group.querySelector('.switch-choice-why')).toBeNull()
  })
})
