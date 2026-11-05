// @vitest-environment jsdom
// Running a flow in the window: a gate takes the composer's place with what it shows and Continue · Send back · Stop,
// and the workspace's Flow tab lists the run's steps in order, each opening what it stands for.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { FlowRun } from '../src/shared/flows'
import type { ApprovalRequest } from '../src/shared/types'
import { GatePanel, PickPanel } from '../src/renderer/src/components/ApprovalPanel'
import { FlowRunPanel } from '../src/renderer/src/components/FlowRunPanel'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const original = fakeState.snapshot

const GATE = {
  id: 'g1',
  sessionId: 's1',
  kind: 'gate',
  flowRunId: 'run',
  flowName: 'Green',
  step: 'ship',
  ask: 'Ship it?',
  show: [
    { kind: 'diff', summary: '1 file changed, +3 −1' },
    { kind: 'checks.results', summary: 'Tests passed' },
    { kind: 'step.answer', step: 'build', summary: 'Built the button.' }
  ]
} as Extract<ApprovalRequest, { kind: 'gate' }>

const RUN: FlowRun = {
  id: 'run',
  flow: { id: 'flow-1', name: 'Green', source: 'personal' },
  repoId: 'r1',
  baseBranch: 'main',
  inputs: { task: 'x' },
  fingerprint: { flow: '', templates: '', setup: '', checks: '', mcp: '', personas: '' },
  state: 'running',
  startedAt: '2026-11-05T10:00:00.000Z',
  workspaceId: 'ws-1',
  current: { step: 'fix', iteration: 2 },
  steps: [
    { name: 'build', kind: 'turn', iteration: 1, state: 'completed', startedAt: '2026-11-05T10:00:00.000Z', sessionId: 's1', turnId: 't1', delta: { files: 2, additions: 10, deletions: 1 }, detail: 'persona: developer (not applied yet)' },
    { name: 'checks', kind: 'checks', iteration: 1, loops: { green: 1 }, state: 'completed', startedAt: '2026-11-05T10:05:00.000Z', fact: 'failed', detail: 'Tests failed' },
    { name: 'fix', kind: 'turn', iteration: 1, loops: { green: 1 }, state: 'running', startedAt: '2026-11-05T10:06:00.000Z', sessionId: 's1', turnId: 't2', shown: ['build.answer', 'checks.results'] }
  ],
  loops: { green: { pass: 1, open: true, iterations: 2, startedAt: '2026-11-05T10:05:00.000Z', minutesUsed: 7.4, visited: ['checks', 'fix'] } },
  bounds: { green: { over: ['checks', 'fix'], iterations: 4, minutes: 45 } }
}

beforeEach(() => {
  resetFake()
  ;(storeModule.selectSession as Mock).mockClear()
  ;(storeModule.showChecksPanel as Mock).mockClear()
  ;(storeModule.selectWorkspace as Mock).mockClear()
  fakeState.snapshot = { ...original, settings: { ...original.settings, flows: true }, flowRuns: [RUN] }
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
})

describe('a flow’s gate', () => {
  it('shows the ask and what to look at, and answers Continue, Send back with the note, or Stop', async () => {
    const user = userEvent.setup()
    render(<GatePanel request={GATE} workspaceId="ws-1" />)
    const panel = screen.getByRole('group', { name: 'Green waits for you at ship' })
    expect(within(panel).getByText('Ship it?')).toBeTruthy()
    const rows = within(panel).getAllByRole('listitem').map((li) => li.textContent)
    expect(rows).toEqual(['Changes: 1 file changed, +3 −1', 'Checks: Tests passed Open checks', 'Answer from build: Built the button.'])
    await user.click(within(panel).getByRole('button', { name: 'Open checks' }))
    expect(storeModule.showChecksPanel).toHaveBeenCalledWith('ws-1')

    await user.type(within(panel).getByRole('textbox', { name: 'Send back with a note' }), 'Rename it')
    await user.click(within(panel).getByRole('button', { name: 'Send back' }))
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('g1', { kind: 'gate', answer: 'sent-back', note: 'Rename it' })
    await user.click(within(panel).getByRole('button', { name: 'Continue' }))
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('g1', { kind: 'gate', answer: 'continued' })
    await user.click(within(panel).getByRole('button', { name: 'Stop' }))
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('g1', { kind: 'gate', answer: 'stopped' })
  })
})

const PICK = {
  id: 'p1',
  sessionId: 's1',
  kind: 'pick',
  flowRunId: 'run',
  flowName: 'Siblings',
  step: 'choose',
  ask: 'Which result should the flow go on with after “choose”?',
  choices: [
    { step: 'try-a', workspaceId: 'ws-1', summary: '2 files changed, +10 −1 · last turn try-a: completed · checks: not run' },
    { step: 'try-b', workspaceId: 'ws-2', summary: '1 file changed, +3 −0 · last turn try-b: completed · checks: Tests passed' }
  ]
} as Extract<ApprovalRequest, { kind: 'pick' }>

describe('a flow’s pick', () => {
  it('shows each result with how it stands; nothing goes until one is chosen; Stop chooses none', async () => {
    const user = userEvent.setup()
    render(<PickPanel request={PICK} />)
    const panel = screen.getByRole('group', { name: 'Siblings asks you to pick at choose' })
    const results = within(panel).getByRole('list', { name: 'Results' })
    expect(within(results).getAllByRole('listitem')).toHaveLength(2)
    const goOn = within(panel).getByRole('button', { name: 'Pick a result first' }) as HTMLButtonElement
    expect(goOn.disabled).toBe(true)
    const b = within(panel).getByRole('button', { name: /^try-b/ })
    expect(b.textContent).toContain('checks: Tests passed')
    expect(b.getAttribute('aria-pressed')).toBe('false')
    await user.click(b)
    expect(b.getAttribute('aria-pressed')).toBe('true')
    // A result's workspace opens to look at it first.
    await user.click(within(panel).getByRole('button', { name: 'Open the workspace of try-b' }))
    expect(storeModule.selectWorkspace).toHaveBeenCalledWith('ws-2')
    expect(fakeApi.respondApproval?.mock.calls ?? []).toEqual([])
    await user.click(within(panel).getByRole('button', { name: 'Go on with try-b' }))
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('p1', { kind: 'pick', chosen: 'try-b' })
    await user.click(within(panel).getByRole('button', { name: 'Stop' }))
    expect(fakeApi.respondApproval).toHaveBeenLastCalledWith('p1', { kind: 'pick', chosen: null })
  })
})

describe('the Flow tab', () => {
  it('says where the run is and its loop bounds, and lists the steps in run order, each opening what it stands for', async () => {
    const user = userEvent.setup()
    render(<FlowRunPanel workspaceId="ws-1" />)
    expect(screen.getByText('Green')).toBeTruthy()
    expect(screen.getByText('At fix · iteration 2')).toBeTruthy()
    expect(screen.getByText('green: iteration 2 of at most 4 · 7 of 45 min')).toBeTruthy()

    const list = screen.getByRole('list', { name: 'Steps' })
    const items = within(list).getAllByRole('listitem')
    expect(items.map((li) => li.querySelector('strong')?.textContent)).toEqual(['build', 'checks', 'fix'])
    expect(within(items[0]).getByText('Done')).toBeTruthy()
    expect(within(items[0]).getByText('Turn · run 1')).toBeTruthy()
    expect(within(items[0]).getByText('2 files · +10 −1')).toBeTruthy()
    expect(within(items[1]).getByText('Tests failed')).toBeTruthy()
    expect(within(items[1]).getByText('Went on by: failed')).toBeTruthy()
    expect(within(items[1]).getByText('In green (iteration 1)')).toBeTruthy()
    expect(within(items[2]).getByText('Running')).toBeTruthy()
    expect(within(items[2]).getByText('Shown: build.answer, checks.results')).toBeTruthy()

    await user.click(within(items[0]).getByRole('button'))
    expect(storeModule.selectSession).toHaveBeenCalledWith('ws-1', 's1')
    await user.click(within(items[1]).getByRole('button'))
    expect(storeModule.showChecksPanel).toHaveBeenCalledWith('ws-1')

    await user.click(screen.getByRole('button', { name: 'Stop run' }))
    expect(fakeApi.stopFlowRun).toHaveBeenCalledWith('run')
  })

  it('names every kind of step with its facts, and a step in another workspace says where and opens there', async () => {
    const user = userEvent.setup()
    fakeState.snapshot = {
      ...fakeState.snapshot,
      workspaces: [...(fakeState.snapshot.workspaces ?? []), { id: 'ws-2', name: 'porto', state: 'ready' }],
      flowRuns: [
        {
          ...RUN,
          workspaces: ['ws-1', 'ws-2'],
          steps: [
            { name: 'review', kind: 'review', iteration: 1, state: 'completed', startedAt: '2026-11-05T10:00:00.000Z', sessionId: 's2', turnId: 't3', fact: 'findings', detail: '2 findings', tree: 'abc1234', readOnly: true, costUsd: 0.42 },
            { name: 'lint', kind: 'script', iteration: 1, state: 'completed', startedAt: '2026-11-05T10:01:00.000Z', fact: 'ok', detail: 'lint: exit 0' },
            { name: 'size', kind: 'decide', iteration: 1, state: 'completed', startedAt: '2026-11-05T10:02:00.000Z', fact: 'large' },
            { name: 'ci', kind: 'wait', iteration: 1, state: 'completed', startedAt: '2026-11-05T10:03:00.000Z', fact: 'green', detail: 'CI passed after 4 min' },
            { name: 'second', kind: 'workspace', iteration: 1, state: 'completed', startedAt: '2026-11-05T10:04:00.000Z', fact: 'ready', workspaceId: 'ws-2', sessionId: 's9' },
            { name: 'choose', kind: 'pick', iteration: 1, state: 'completed', startedAt: '2026-11-05T10:05:00.000Z', fact: 'try-a', workspaceId: 'ws-1' }
          ]
        }
      ]
    }
    render(<FlowRunPanel workspaceId="ws-1" />)
    const items = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem')
    expect(items.map((li) => within(li).getByText(/· run 1$/).textContent)).toEqual(['Review · run 1', 'Script · run 1', 'Decide · run 1', 'Wait · run 1', 'Workspace · run 1', 'Pick · run 1'])
    expect(within(items[0]).getByText('Went on by: findings')).toBeTruthy()
    expect(within(items[0]).getByText('Cost $0.42')).toBeTruthy()
    expect(within(items[3]).getByText('CI passed after 4 min')).toBeTruthy()
    expect(within(items[4]).getByText('In porto')).toBeTruthy()
    await user.click(within(items[4]).getByRole('button'))
    expect(storeModule.selectWorkspace).toHaveBeenCalledWith('ws-2')
  })

  it('shows nothing while Flows are off, or for a workspace no run made', () => {
    const { container, rerender } = render(<FlowRunPanel workspaceId="other" />)
    expect(container.textContent).toBe('')
    fakeState.snapshot = { ...fakeState.snapshot, settings: { ...fakeState.snapshot.settings, flows: false } }
    rerender(<FlowRunPanel workspaceId="ws-1" />)
    expect(container.textContent).toBe('')
  })
})
