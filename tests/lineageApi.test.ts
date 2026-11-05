// The Lineage API behind Settings → Experimental → Flows (workspaceLineage, lineageFlowDraft), and the records core
// writes for it: who started a workspace from the command line or delegation, and a schedule's or a flow run's first
// message's origin.
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { lineageInput, MAX_ITEMS } from '../src/main/lineage'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { parseFlow } from '../src/shared/flows'
import type { ChatItem, Session, Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

afterEach(() => vi.restoreAllMocks())

const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: 'ws', repoId: 'repo', name: 'lisbon', branch: 'b', baseBranch: 'main', portBase: 50040, state: 'ready', createdAt: '2026-11-05T10:00:00.000Z', ...patch })
const tab = (id: string, patch: Partial<Session> = {}): Session => ({ id, workspaceId: 'ws', agent: 'claude', model: 'claude-opus-5-5', fastMode: false, planMode: false, status: 'idle', queue: [], ...patch }) as Session

async function setup() {
  const dir = await tempDir('foreman-lineage-api-')
  const store = new Store(dir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const core = new Core(store, secrets, {
    broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
  })
  core.attention.stop()
  store.state.workspaces.push(ws({ path: await tempDir('foreman-lineage-ws-') }))
  store.state.sessions.push(tab('s1', { title: 'Login bug' }), tab('s2', { title: 'Login bug (fork)', forkedFrom: { sessionId: 's1', turnId: 't1' } }))
  await store.appendChat('s1', { kind: 'user', id: 'user:t1', turnId: 't1', text: 'Fix the login bug', at: '2026-11-05T10:00:00.000Z' })
  await store.appendChat('s1', { kind: 'assistant', id: 'a1', turnId: 't1', text: 'Done.' })
  await store.appendChat('s1', { kind: 'turn-end', id: 'turn-end:t1', turnId: 't1', outcome: 'completed', durationMs: 60_000, tree: { start: 'a'.repeat(12), end: 'b'.repeat(12) } })
  await store.appendChat('s2', { kind: 'user', id: 'user:f1', turnId: 'f1', text: 'Another way', at: '2026-11-05T10:05:00.000Z' })
  return { core, store }
}

describe('the lineage API', () => {
  it('refuses while Flows are off', async () => {
    const { core } = await setup()
    await expect(core.api.workspaceLineage('ws', 'run')).rejects.toThrow('Flows are off')
    await expect(core.api.lineageFlowDraft('ws')).rejects.toThrow('Flows are off')
    await core.shutdown()
  })

  it('draws a workspace through a lens, with its outline, Mermaid source and gaps, and drafts a flow from it', async () => {
    const { core } = await setup()
    await core.api.updateSettings({ flows: true })
    const run = await core.api.workspaceLineage('ws', 'run')
    expect(run.graph.edges).toContainEqual(expect.objectContaining({ from: 'turn:s1:t1', to: 'turn:s2:f1', label: 'forked from', recorded: 'Session.forkedFrom' }))
    expect(run.outline.map((e) => e.id)).toEqual(['turn:s1:t1', 'turn:s2:f1'])
    // The Lineage tab sits in the side panel, so it reads top to bottom; the command line's --mermaid stays left to right.
    expect(run.mermaid).toContain('flowchart TB')
    expect(run.gaps).toEqual([])
    const data = await core.api.workspaceLineage('ws', 'data')
    expect(data.graph.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['tree:base', `tree:${'a'.repeat(12)}`]))
    await expect(core.api.workspaceLineage('ws', 'nope' as never)).rejects.toThrow('A lens')
    await expect(core.api.workspaceLineage('gone', 'run')).rejects.toThrow('isn’t there')
    const draft = await core.api.lineageFlowDraft('ws')
    expect('flow' in parseFlow(draft.toml, 'personal')).toBe(true)
    expect(draft.leftOut).toEqual([{ kind: 'fork', count: 1 }, { kind: 'templateUnknown', count: 1 }])
    await core.shutdown()
  })

  it('reads at most the newest items of each chat, and a linked chat one hop away', async () => {
    const items: ChatItem[] = Array.from({ length: MAX_ITEMS + 50 }, (_, i) => ({ kind: 'user', id: `u${i}`, turnId: `t${i}`, text: 'x', at: '2026-11-05T10:00:00.000Z' }))
    const reads: string[] = []
    const input = await lineageInput(
      {
        workspaces: [ws({ startedBy: { sessionId: 'c1', turnId: 'ct', via: 'delegation' } }), ws({ id: 'ws0', name: 'coordinator' })],
        sessions: [tab('s1'), tab('c1', { workspaceId: 'ws0' }), tab('c2', { workspaceId: 'ws0' })],
        readChat: async (id) => (reads.push(id), id === 's1' ? [...items, { kind: 'assistant', id: 'a', turnId: 't0', text: 'kept out' }] : [])
      },
      'ws'
    )
    expect(input.chats.get('s1')).toHaveLength(MAX_ITEMS)
    expect(input.chats.get('s1')!.some((i) => i.kind === 'assistant')).toBe(false)
    expect(reads.sort()).toEqual(['c1', 's1'])
    expect(input.workspaces!.map((w) => w.id)).toEqual(['ws', 'ws0'])
  })
})

describe('what core records for the lineage', () => {
  it('a workspace started from a turn or by delegation records who started it', async () => {
    const { core, store } = await setup()
    const made = ws({ id: 'ws9' })
    store.state.workspaces.push(made)
    const internals = core as unknown as { workspaces: { createWorkspace(): Promise<Workspace> } }
    vi.spyOn(internals.workspaces, 'createWorkspace').mockResolvedValue(made)
    await core.createWorkspaceFor('repo', {}, { startedBy: { sessionId: 's1', turnId: 't1', via: 'cli' } })
    expect(made.startedBy).toEqual({ sessionId: 's1', turnId: 't1', via: 'cli' })
    await core.shutdown()
  })

  it('a schedule’s first message and a flow run’s first step say why Foreman sent them', async () => {
    const { core } = await setup()
    const send = vi.spyOn(core.sessions, 'send').mockResolvedValue('started')
    const internals = core as unknown as { startChat(workspaceId: string, prompt?: string, loadout?: undefined, templateId?: undefined, intake?: undefined, internal?: object): string; sendFirstMessages(): void }
    const scheduled = internals.startChat('ws', 'Nightly tidy', undefined, undefined, undefined, { scheduled: { scheduleId: 'sch', occurrenceId: 'occ' } })
    internals.sendFirstMessages()
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(scheduled, 'Nightly tidy', { origin: { kind: 'schedule', scheduleId: 'sch', occurrenceId: 'occ' } }))
    const flow = internals.startChat('ws', 'Build it', undefined, undefined, undefined, { flowRun: { runId: 'run-1', step: 'build' } })
    internals.sendFirstMessages()
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(flow, 'Build it', { origin: { kind: 'flow', runId: 'run-1', step: 'build', iteration: 1 } }))
    await core.shutdown()
  })
})
