// @vitest-environment jsdom
// Running a flow in the window: a gate takes the composer's place with what it shows and Continue · Send back · Stop,
// and the workspace's Flow tab lists the run's steps in order, each opening what it stands for.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { FlowRun } from '../src/shared/flows'
import type { ApprovalRequest } from '../src/shared/types'
import { GatePanel, PickPanel } from '../src/renderer/src/components/ApprovalPanel'
import { FlowRunPanel } from '../src/renderer/src/components/FlowRunPanel'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

// The diagram renders through a stand-in for Mermaid: it records the source and answers with an SVG naming it.
const mermaid = vi.hoisted(() => ({ sources: [] as string[] }))
vi.mock('../src/renderer/src/components/mermaidRender', () => ({
  readThemeTokens: () => ({ tokens: {}, dark: false }),
  cachedRender: () => undefined,
  renderMermaid: async (source: string) => {
    mermaid.sources.push(source)
    const title = /accTitle: (.*)/.exec(source)?.[1] ?? ''
    return { ok: true, svg: `<svg><title>${title}</title><g></g></svg>` }
  },
  svgElement: (svg: string) => {
    const template = document.createElement('template')
    template.innerHTML = svg
    return template.content.querySelector('svg')
  }
}))

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

describe('a file a gate shows', () => {
  it('shows its content read-only, labelled by its path', () => {
    render(<GatePanel request={{ ...GATE, show: [{ kind: 'file', path: 'docs/features/search/requirements.md', summary: '# Search\nFind things fast.' }] }} workspaceId="ws-1" />)
    const file = screen.getByRole('textbox', { name: 'File docs/features/search/requirements.md' }) as HTMLTextAreaElement
    expect(file.value).toBe('# Search\nFind things fast.')
    expect(file.readOnly).toBe(true)
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
    // The row of steps says where it is, so the head doesn't say it again, or when it started.
    expect(screen.queryByText('At fix · iteration 2')).toBeNull()
    expect(screen.queryByText(/^Started /)).toBeNull()
    expect(screen.getByText('green: iteration 2 of at most 4 · 7 of 45 min')).toBeTruthy()

    // The row of steps says where the run is at a glance: what ran, and the step it is at.
    const progress = screen.getByRole('list', { name: 'Where the run is in the flow' })
    const marks = within(progress).getAllByRole('listitem')
    expect(marks.map((li) => li.textContent)).toEqual(['build, done', 'checks, done', 'fix, Running'])
    expect(marks[2].getAttribute('aria-current')).toBe('step')

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

describe('the Flow tab’s diagram and its four lenses', () => {
  const LENSED: FlowRun = {
    ...RUN,
    steps: [
      { ...RUN.steps[0], endedAt: '2026-11-05T10:04:02.000Z', persona: 'developer', shown: ['task'], usage: { used: 61_000, limit: 1_000_000 }, memoryFiles: ['/repo/CLAUDE.md'], memoryWrites: ['CLAUDE.md'], noteRevision: 2, tree: { end: 'aaaaaaaaaaaa' } },
      { ...RUN.steps[1], tree: { start: 'aaaaaaaaaaaa' } },
      { ...RUN.steps[2], usage: { used: 84_000, limit: 1_000_000 }, tree: { start: 'bbbbbbbbbbbb', end: 'cccccccccccc' }, moved: true }
    ]
  }

  beforeEach(() => {
    mermaid.sources.length = 0
    fakeState.snapshot = { ...fakeState.snapshot, flowRuns: [LENSED] }
  })

  it('draws the run, and the lens switch changes the diagram and the rows under it while the steps stay', async () => {
    const user = userEvent.setup()
    render(<FlowRunPanel workspaceId="ws-1" />)
    // Run: the diagram of the run (drawn from its records: the flow isn't listed here), and nothing more than the steps.
    expect(await screen.findByRole('group', { name: 'Green · Run' })).toBeTruthy()
    // The side panel scrolls down, so the graph reads top to bottom rather than shrinking to a strip.
    const graphNode = (title: string) => [...document.querySelectorAll<HTMLElement>('.ui-graph__node')].find((n) => n.querySelector('.ui-graph__title')?.textContent === title)
    expect(Number.parseFloat(graphNode('fix')!.style.top)).toBeGreaterThan(Number.parseFloat(graphNode('build')!.style.top))
    expect(graphNode('build')!.dataset.tone).toBe('ok')
    const lenses = screen.getByRole('radiogroup', { name: 'Show the flow as' })
    expect(within(lenses).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Run', 'Context', 'Memory', 'Data'])
    const steps = () => within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem')
    expect(steps()).toHaveLength(3)

    // Context: what each turn was shown and how full its window was.
    await user.click(within(lenses).getByRole('radio', { name: 'Context' }))
    expect(await screen.findByRole('group', { name: 'Green · Context' })).toBeTruthy()
    expect(graphNode('fix')!.textContent).toContain('window 84K of 1M')
    const context = screen.getByRole('list', { name: 'What each turn was shown' })
    const rows = within(context).getAllByRole('listitem')
    expect(rows.map((r) => within(r).getByText(/^(build|fix)$/).textContent)).toEqual(['build', 'fix'])
    expect(within(rows[1]).getByText('checks.results')).toBeTruthy()
    const meter = within(rows[1]).getByRole('meter', { name: 'Context window at the end of fix' })
    expect(meter.getAttribute('aria-valuetext')).toBe('84K of 1M (8%)')
    expect(within(steps()[0]).getByText('61K of 1M (6%)')).toBeTruthy()
    expect(steps()).toHaveLength(3)

    // Memory: the ledger, what outlives a step with its reads and writes, and each card's memory writes.
    await user.click(within(lenses).getByRole('radio', { name: 'Memory' }))
    expect(await screen.findByRole('group', { name: 'Green · Memory' })).toBeTruthy()
    const ledger = screen.getByRole('table', { name: 'Run ledger' })
    expect(within(ledger).getAllByRole('row')).toHaveLength(4)
    expect(within(ledger).getByText('build.answer, checks.results')).toBeTruthy()
    const memory = screen.getByRole('list', { name: 'What outlives a step' })
    const file = within(memory).getByText('repo/CLAUDE.md').closest('li')!
    expect(within(file).getByText('read 1 · written 1')).toBeTruthy()
    expect(within(steps()[0]).getByText('Wrote CLAUDE.md')).toBeTruthy()

    // Data: each step's trees, with Moved in words where the tree moved.
    await user.click(within(lenses).getByRole('radio', { name: 'Data' }))
    expect(await screen.findByRole('group', { name: 'Green · Data' })).toBeTruthy()
    expect([...document.querySelectorAll('.ui-graph__label')].some((l) => l.textContent === 'moved')).toBe(true)
    const data = screen.getByRole('list', { name: 'Trees each step worked on' })
    const fix = within(data).getAllByRole('listitem')[2]
    expect(within(fix).getByText('bbbbbbb → ccccccc')).toBeTruthy()
    expect(within(fix).getByText('Moved')).toBeTruthy()
    expect(within(steps()[1]).getByText('aaaaaaa → aaaaaaa')).toBeTruthy()
    expect(within(steps()[2]).getByText('Moved')).toBeTruthy()
    expect(steps()).toHaveLength(3)
  })

  it('draws the flow file’s steps when it is still what the run started from, so a step not yet run shows', async () => {
    fakeApi.listFlows = vi.fn(async () => [
      {
        id: 'flow-1',
        source: 'personal',
        name: 'Green',
        problems: [],
        warnings: [],
        toml: 'name = "Green"\n\n[start]\nstep = "build"\n\n[steps.build]\nkind = "turn"\nprompt = "Build"\n\n[steps.checks]\nkind = "checks"\n\n[steps.fix]\nkind = "turn"\nprompt = "Fix"\n\n[steps.ship]\nkind = "gate"\n\n[edges]\nbuild = "checks"\nchecks = { passed = "ship", failed = "fix" }\nfix = "checks"\n\n[loops.green]\nover = ["checks", "fix"]\nat_most = { iterations = 4 }\n'
      }
    ])
    render(<FlowRunPanel workspaceId="ws-1" />)
    const graphNode = (title: string) => [...document.querySelectorAll<HTMLElement>('.ui-graph__node')].find((n) => n.querySelector('.ui-graph__title')?.textContent === title)
    // A step not yet run is drawn dim with its state; the exit the run didn't take is faint.
    await waitFor(() => expect(graphNode('ship')?.dataset.tone).toBe('off'))
    expect(graphNode('ship')!.dataset.dim).toBe('true')
    expect(fakeApi.listFlows).toHaveBeenCalledWith('r1')
    const passed = [...document.querySelectorAll<HTMLElement>('.ui-graph__label')].find((l) => l.textContent === 'passed')!
    expect(passed.dataset.weight).toBe('faint')
  })
})

describe('the Flow tab’s graph, gate and stop', () => {
  beforeEach(() => {
    fakeState.snapshot = { ...fakeState.snapshot, flowRuns: [RUN] }
    fakeState.approvals = []
  })
  afterEach(() => {
    fakeState.approvals = []
  })

  it('opens what a step stands for when it is selected on the graph', async () => {
    const user = userEvent.setup()
    render(<FlowRunPanel workspaceId="ws-1" />)
    const graph = await screen.findByRole('group', { name: 'Green · Run' })
    await user.click(within(graph).getByRole('button', { name: /^checks/ }))
    expect(storeModule.showChecksPanel).toHaveBeenCalledWith('ws-1')
    await user.click(within(graph).getByRole('button', { name: /^fix/ }))
    expect(storeModule.selectSession).toHaveBeenCalledWith('ws-1', 's1')
  })

  it('answers the gate the run waits at, and says why a run stopped with a way to the checks', async () => {
    const user = userEvent.setup()
    fakeApi.respondApproval = vi.fn(async () => undefined)
    fakeState.approvals = [{ id: 'g1', kind: 'gate', flowRunId: 'run', flowName: 'Green', step: 'ship', ask: 'Ship it?', show: [], sessionId: '', workspaceId: 'ws-1' }]
    const view = render(<FlowRunPanel workspaceId="ws-1" />)
    expect(await screen.findByText('Green waits for you at ship')).toBeTruthy()
    expect(screen.getByText('Ship it?')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('g1', { kind: 'gate', answer: 'continued' })

    fakeState.approvals = []
    fakeState.snapshot = { ...fakeState.snapshot, flowRuns: [{ ...RUN, state: 'stopped', reason: 'The loop “green” reached its 4 iterations.', steps: RUN.steps.slice(0, 2) }] }
    view.rerender(<FlowRunPanel workspaceId="ws-1" />)
    expect(await screen.findByText('Why it stopped')).toBeTruthy()
    expect(screen.getByText('The loop “green” reached its 4 iterations.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Open the checks' }))
    expect(storeModule.showChecksPanel).toHaveBeenCalledWith('ws-1')
  })

  it('says where a failed run ended, marks that step and what it never reached, and opens the step’s chat', async () => {
    const user = userEvent.setup()
    fakeApi.listFlows = vi.fn(async () => [
      {
        id: 'flow-1',
        source: 'personal',
        name: 'Green',
        problems: [],
        warnings: [],
        toml: 'name = "Green"\n\n[start]\nstep = "build"\n\n[steps.build]\nkind = "turn"\nprompt = "Build"\n\n[steps.checks]\nkind = "checks"\n\n[edges]\nbuild = "checks"\n'
      }
    ])
    const failed: FlowRun = { ...RUN, state: 'failed', current: undefined, endedAt: new Date().toISOString(), reason: 'The “build” turn ended with an error.', steps: [{ ...RUN.steps[0], state: 'failed' }] }
    fakeState.snapshot = { ...fakeState.snapshot, flowRuns: [failed] }
    render(<FlowRunPanel workspaceId="ws-1" />)
    // The row of steps marks where it ended, so the head doesn't say it again.
    expect(screen.queryByText(/^Ended at /)).toBeNull()
    expect(screen.queryByText(/^At /)).toBeNull()

    const progress = screen.getByRole('list', { name: 'Where the run is in the flow' })
    await waitFor(() => expect(within(progress).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['build, Failed', 'checks, not reached yet']))
    expect(within(progress).getAllByRole('listitem')[0].getAttribute('aria-current')).toBe('step')
    // The graph's end says how the run ended, not "done".
    expect([...document.querySelectorAll('.ui-graph__title')].map((n) => n.textContent)).toContain('failed')

    expect(screen.getByText('The “build” turn ended with an error.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Open its chat tab' }))
    expect(storeModule.selectSession).toHaveBeenCalledWith('ws-1', 's1')
  })
})
