// @vitest-environment jsdom
// The workspace's Lineage tab: the lens switch reads the lineage through another lens, the outline opens the turn or the
// checks it stands for and says what each entry is recorded from or needs, the gaps are listed, and "Make a flow from
// this…" shows the draft read-only with what it leaves out, saves it as a personal flow or copies it.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { LineagePanel } from '../src/renderer/src/components/LineagePanel'
import { lineageGraph, lineageOutline, type WorkspaceLineage } from '../src/shared/lineage'
import { flowMermaid } from '../src/shared/flowGraph'
import { REVIEW_MESSAGE } from '../src/shared/handOff'
import type { Session, Workspace } from '../src/shared/types'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

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

const ws: Workspace = { id: 'w1', repoId: 'r1', name: 'lisbon', branch: 'fix', baseBranch: 'main', portBase: 50000, state: 'ready', createdAt: '2026-11-05T10:00:00.000Z', checks: { running: false, results: [{ name: 'test', command: 'npm test', status: 'passed', startedAt: '2026-11-05T10:10:00.000Z', logPath: '', fingerprint: { tree: '', command: '', source: 'local' } }] } }
const tab = (id: string, title: string): Session => ({ id, workspaceId: 'w1', agent: 'claude', model: 'claude-opus-5-5', fastMode: false, planMode: false, status: 'idle', queue: [], title, createdAt: '2026-11-05T10:00:00.000Z' }) as Session

/** What main answers for a lens: the real graph of a small history. */
function lineageFor(lens: 'run' | 'context' | 'memory' | 'data'): WorkspaceLineage {
  const graph = lineageGraph(
    {
      workspace: ws,
      sessions: [tab('s1', 'Login bug'), tab('s2', 'Code review')],
      chats: new Map([
        ['s1', [{ kind: 'user', id: 'user:t1', turnId: 't1', text: 'Fix it', at: '2026-11-05T10:00:00.000Z' }, { kind: 'turn-end', id: 'e1', turnId: 't1', outcome: 'completed', durationMs: 60_000 }]],
        ['s2', [{ kind: 'user', id: 'user:r1', turnId: 'r1', text: REVIEW_MESSAGE, at: '2026-11-05T10:05:00.000Z' }]]
      ])
    },
    lens
  )
  return { graph, outline: lineageOutline(graph), mermaid: flowMermaid(graph), gaps: graph.gaps }
}

const DRAFT = { toml: 'name = "From lisbon"\n\n[start]\nstep = "turn-1"\n\n[steps.turn-1]\nkind = "turn"\nprompt = "{{task}}"\n', leftOut: [{ kind: 'fork' as const, count: 2 }] }

const original = fakeState.snapshot
beforeEach(() => {
  resetFake()
  mermaid.sources = []
  for (const name of ['openTurn', 'showChecksPanel', 'showToast']) (storeModule[name] as Mock).mockClear()
  fakeState.snapshot = { ...original, settings: { ...original.settings, flows: true }, workspaces: [ws], sessions: [tab('s1', 'Login bug'), tab('s2', 'Code review')] }
  fakeApi.workspaceLineage = vi.fn(async (_id: string, lens: 'run' | 'context' | 'memory' | 'data') => lineageFor(lens))
  fakeApi.lineageFlowDraft = vi.fn(async () => DRAFT)
  fakeApi.savePersonalFlow = vi.fn(async () => ({ flow: { id: 'flow-9', name: 'From lisbon' } }))
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
})

describe('the Lineage tab', () => {
  it('draws the run lens, lists the outline with its tags, and opens what an entry stands for', async () => {
    const user = userEvent.setup()
    render(<LineagePanel workspaceId="w1" />)
    const outline = await screen.findByRole('list', { name: 'What happened, in order' })
    expect(fakeApi.workspaceLineage).toHaveBeenCalledWith('w1', 'run')
    // Selectable: a node opens what it stands for, as the outline's entries do.
    expect(await screen.findByRole('group', { name: 'lisbon · Run' })).toBeTruthy()
    const review = within(outline).getByRole('button', { name: /^Code review · T1/ })
    expect(review.textContent).toContain('handed off (review) from Login bug · T1 (inferred)')
    expect(review.textContent).toContain('needs: Session.handedOffFrom')
    await user.click(review)
    expect(storeModule.openTurn).toHaveBeenCalledWith('w1', 's2', 'r1')
    await user.click(within(outline).getByRole('button', { name: /^checks · 1 of 1 passed/ }))
    expect(storeModule.showChecksPanel).toHaveBeenCalledWith('w1')
    // The records this history lacks.
    expect(screen.getByText('Gaps')).toBeTruthy()
    expect(screen.getByText('where a handed-off chat came from (Session.handedOffFrom)')).toBeTruthy()
  })

  it('the lens switch reads the lineage through another lens', async () => {
    const user = userEvent.setup()
    render(<LineagePanel workspaceId="w1" />)
    await screen.findByRole('list', { name: 'What happened, in order' })
    await user.click(screen.getByRole('radio', { name: 'Data' }))
    await waitFor(() => expect(fakeApi.workspaceLineage).toHaveBeenLastCalledWith('w1', 'data'))
    expect(await screen.findByRole('group', { name: 'lisbon · Data' })).toBeTruthy()
  })

  it('Make a flow from this… opens the draft in the flow studio with what it leaves out, saving nothing', async () => {
    const user = userEvent.setup()
    render(<LineagePanel workspaceId="w1" />)
    await user.click(await screen.findByRole('button', { name: 'Make a flow from this…' }))
    await waitFor(() => expect(storeModule.openFlowDraft).toHaveBeenCalledWith({ toml: DRAFT.toml, notes: expect.arrayContaining(['2 forks of chats (a flow doesn’t fork a tab)']) }))
    expect(fakeApi.savePersonalFlow).not.toHaveBeenCalled()
  })
})
