// `foreman workspace lineage` and `foreman flow draft`: behind the Flows switch, the outline with recorded and inferred
// links and the gaps, the Mermaid source, and a draft printed or saved as a personal flow.
import { describe, expect, it } from 'vitest'
import { LINEAGE_METHODS, wsLineage } from '../src/main/cli/lineage'
import type { CliContext } from '../src/main/cli/methods'
import type { CliHost } from '../src/main/cliServer'
import { defaultSettings } from '../src/main/store'
import { findCommand } from '../src/shared/cliCommands'
import type { FlowDraftResult } from '../src/shared/cli/flows'
import type { WsLineageResult } from '../src/shared/cli/workspaces'
import { personalFlowListing } from '../src/main/flowFiles'
import { REVIEW_MESSAGE } from '../src/shared/handOff'
import type { Api, ChatItem, Repo, Session, Settings, Workspace } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'

const repo = { id: 'r1', name: 'app', rootPath: '/app' } as Repo
const ws: Workspace = { id: 'ws1', repoId: 'r1', name: 'lisbon', branch: 'fix-login', baseBranch: 'main', state: 'ready', path: '/x', portBase: 50000, createdAt: '2026-11-05T10:00:00.000Z' }
const tab = (id: string, patch: Partial<Session> = {}): Session => ({ id, workspaceId: 'ws1', agent: 'claude', model: 'claude-opus-5-5', status: 'idle', queue: [], fastMode: false, planMode: false, ...patch }) as Session
const chats: Record<string, ChatItem[]> = {
  s1: [
    { kind: 'user', id: 'user:t1', turnId: 't1', text: 'Fix the login bug', at: '2026-11-05T10:00:00.000Z' },
    { kind: 'turn-end', id: 'turn-end:t1', turnId: 't1', outcome: 'completed', durationMs: 60_000, tree: { start: 'a'.repeat(12), end: 'b'.repeat(12) } }
  ],
  s2: [{ kind: 'user', id: 'user:r1', turnId: 'r1', text: REVIEW_MESSAGE, at: '2026-11-05T10:05:00.000Z' }]
}
const ctx: CliContext = { request: { method: 'x' } as CliContext['request'], caller: undefined, signal: undefined, progress: () => undefined }

function rig(over: { settings?: Partial<Settings>; api?: Partial<Api> } = {}) {
  const saved: string[] = []
  const settings = { ...defaultSettings(), flows: true, ...over.settings }
  const host: CliHost = stubHost({
    state: () => ({ repos: [repo], workspaces: [ws], sessions: [tab('s1', { title: 'Login bug' }), tab('s2', { title: 'Code review' })], settings }),
    api: fakeApi({
      getChat: async (id) => chats[id] ?? [],
      listFlowRuns: async () => [],
      savePersonalFlow: async ({ toml }) => {
        saved.push(toml)
        const listing = personalFlowListing({ id: 'flow-new', toml, createdAt: '', updatedAt: '' })
        return listing.problems.length ? { problems: listing.problems } : { flow: listing }
      },
      ...over.api
    })
  })
  const methods: Record<string, typeof wsLineage> = { ...LINEAGE_METHODS, 'ws-lineage': wsLineage }
  const call = async <T>(method: string, params: Record<string, unknown>) => (await methods[method].handle(host, { cwd: '/', ...params }, ctx)) as T
  return { call, saved }
}

describe('foreman workspace lineage', () => {
  it('refuses while Flows are off, naming the setting', async () => {
    await expect(rig({ settings: { flows: false } }).call('ws-lineage', { workspace: 'lisbon' })).rejects.toThrow('Flows are off')
    await expect(rig({ settings: { flows: false } }).call('flow-draft', { workspace: 'lisbon' })).rejects.toThrow('Flows are off')
  })

  it('prints the outline: each turn with its links, recorded or inferred, and the gaps', async () => {
    const result = await rig().call<WsLineageResult>('ws-lineage', { workspace: 'lisbon' })
    expect(result.lens).toBe('run')
    expect(result.outline.map((e) => e.label)).toEqual(['Login bug · T1', 'Code review · T1'])
    expect(result.text).toContain('lisbon · Run')
    expect(result.text).toContain('← handed off (review) from Login bug · T1 (inferred)')
    expect(result.text).toContain('needs: Session.handedOffFrom')
    expect(result.text).toContain('Gaps: this history lacks these records')
    expect(result.gaps).toContain('Session.handedOffFrom')
  })

  it('prints a lens, or the Mermaid source, and refuses a lens that isn’t one', async () => {
    const data = await rig().call<WsLineageResult>('ws-lineage', { workspace: 'lisbon', lens: 'data' })
    expect(data.text).toContain('tree aaaaaaa')
    const mermaid = await rig().call<WsLineageResult>('ws-lineage', { workspace: 'lisbon', mermaid: true })
    expect(mermaid.text.startsWith('flowchart LR')).toBe(true)
    expect(mermaid.text).toContain('-.->')
    await expect(rig().call('ws-lineage', { workspace: 'lisbon', lens: 'nope' })).rejects.toThrow('--lens is run, context, memory, data')
  })

  it('is a read: workspace lineage parses with --lens and --mermaid', () => {
    expect(findCommand(['workspace', 'lineage', '.', '--lens', 'memory'])).toMatchObject({ spec: { path: ['workspace', 'lineage'], tier: 'read' } })
    expect(findCommand(['flow', 'draft', '.'])).toMatchObject({ spec: { path: ['flow', 'draft'], tier: 'act' } })
  })
})

describe('foreman flow draft', () => {
  it('prints the draft, and saves it as a personal flow under a name with --save', async () => {
    const r = rig()
    const printed = await r.call<FlowDraftResult>('flow-draft', { workspace: 'lisbon' })
    expect(printed.text).toContain('[steps.turn-1]')
    expect(printed.text).toContain('[steps.review]')
    expect(r.saved).toEqual([])
    const saved = await r.call<FlowDraftResult>('flow-draft', { workspace: 'lisbon', save: true, name: 'Fix and review' })
    expect(saved).toMatchObject({ saved: true, flow: { id: 'flow-new', name: 'Fix and review' } })
    expect(r.saved[0]).toContain('name = "Fix and review"')
    expect(saved.text).toContain('Saved the personal flow “Fix and review”')
  })

  it('says why it didn’t save, and wants --save with --name', async () => {
    const r = rig({ api: { savePersonalFlow: async () => ({ problems: ['A step is missing.'] }) } })
    const result = await r.call<FlowDraftResult>('flow-draft', { workspace: 'lisbon', save: true })
    expect(result).toMatchObject({ saved: false, problems: ['A step is missing.'] })
    await expect(rig().call('flow-draft', { workspace: 'lisbon', name: 'x' })).rejects.toThrow('add --save')
  })
})
