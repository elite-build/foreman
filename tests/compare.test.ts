import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CompareService } from '../src/main/compare'
import { git, gitOut } from '../src/main/git'
import { Environment } from '../src/main/environment'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { WorkspaceService } from '../src/main/workspaces'
import { compareBlock, compareGroups, compareSummary } from '../src/shared/compare'
import type { Loadout, Session, Workspace } from '../src/shared/types'
import { wsPath } from '../src/shared/workspacePath'
import { commit, makeRepo, tempDir, nodeCommand } from './helpers'

const OPUS: Loadout = { agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'high', fast: false }
const CODEX: Loadout = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: false }

async function rig(options: { setupScript?: string } = {}) {
  const dataDir = await tempDir('foreman-compare-data-')
  const store = new Store(dataDir)
  await store.load()
  store.state.settings.workspacesRoot = await tempDir('foreman-compare-ws-')
  store.state.settings.branchPrefixType = 'none'
  const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const environment = new Environment(secrets, () => store.state.settings, (id) => workspaces.repo(id))
  const workspaces: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog() {} }, environment)
  const repo = await workspaces.addRepo(await makeRepo({ 'README.md': 'hi\n' }))
  if (options.setupScript) workspaces.updateRepoSettings(repo.id, { setupScript: options.setupScript })
  const sent: { sessionId: string; text: string }[] = []
  const started: { workspaceId: string; prompt: string; loadout: Loadout }[] = []
  const compare = new CompareService({
    store,
    workspaces,
    isRunning: (id) => store.state.sessions.some((s) => s.workspaceId === id && s.status === 'running'),
    send: async (sessionId, text) => (sent.push({ sessionId, text }), 'started'),
    startChat: (workspaceId, prompt, loadout) => {
      const session = tab(workspaceId, { agent: loadout.agent, model: loadout.model })
      started.push({ workspaceId, prompt, loadout })
      return session.id
    },
    archive: async (id) => void (await workspaces.archiveWorkspace(id, false))
  })
  let n = 0
  const tab = (workspaceId: string, patch: Partial<Session> = {}): Session => {
    const s: Session = { id: `s${++n}`, workspaceId, agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: new Date().toISOString(), ...patch }
    store.state.sessions.push(s)
    return s
  }
  const source = await workspaces.createWorkspace(repo.id)
  await ready(source)
  return { store, workspaces, compare, source, tab, sent, started, repo }
}

async function ready(ws: Workspace): Promise<void> {
  for (let i = 0; i < 300 && !['ready', 'error', 'setup-failed'].includes(ws.state); i++) await new Promise((r) => setTimeout(r, 50))
  expect(ws.state).toBe('ready')
}

describe('compare models', () => {
  it('restores the snapshot into each sibling before setup, and groups them by compareId', async () => {
    // Setup records what it saw: it can only see the work-in-progress file if the restore came first.
    const { compare, source, tab, sent, started, store } = await rig({ setupScript: nodeCommand("const fs = require('node:fs'); fs.writeFileSync('seen.txt', fs.existsSync('wip.txt') ? fs.readFileSync('wip.txt') : 'missing')") })
    const dir = wsPath(source)
    await writeFile(path.join(dir, 'a.txt'), 'committed\n')
    await git(dir, ['add', '-A'])
    await commit(dir, 'ahead')
    await writeFile(path.join(dir, 'wip.txt'), 'uncommitted\n')
    const t = tab(source.id)

    const result = await compare.start(source.id, { sessionId: t.id, prompt: 'Debounce search input', models: [OPUS, CODEX] })
    expect(result.workspaces).toHaveLength(3)
    const siblings = result.workspaces.slice(1)
    for (const sibling of siblings) await ready(sibling)

    for (const sibling of siblings) {
      expect(await readFile(path.join(wsPath(sibling), 'seen.txt'), 'utf8')).toBe('uncommitted\n')
      expect(await readFile(path.join(wsPath(sibling), 'a.txt'), 'utf8')).toBe('committed\n')
      expect(await gitOut(wsPath(sibling), ['rev-parse', 'HEAD'])).toBe(await gitOut(dir, ['rev-parse', 'HEAD']))
      expect(sibling.compareId).toBe(result.compareId)
    }
    expect(source.compareId).toBe(result.compareId)
    // The same prompt everywhere: siblings' first chats with their models, and the source's own tab.
    expect(started.map((s) => [s.prompt, s.loadout.model])).toEqual([['Debounce search input', OPUS.model], ['Debounce search input', CODEX.model]])
    expect(sent).toEqual([{ sessionId: t.id, text: 'Debounce search input' }])
    // The snapshot ref is tidied away.
    expect(await gitOut(dir, ['for-each-ref', 'refs/switchyard-checkpoints/compare-*'])).toBe('')

    const groups = compareGroups(store.state.workspaces, store.state.sessions)
    expect(groups).toHaveLength(1)
    expect(groups[0].members.map((m) => m.ws.id).sort()).toEqual(result.workspaces.map((w) => w.id).sort())
    expect(groups[0].prompt).toBe('Debounce search input')
  })

  it('needs every tab idle, naming the busy one', async () => {
    const { compare, source, tab, store, workspaces } = await rig()
    const a = tab(source.id, { title: 'Fix login' })
    const b = tab(source.id, { title: 'Tests', status: 'running' })
    expect(compare.block(source.id)).toContain('Tests is still working')
    await expect(compare.start(source.id, { sessionId: a.id, prompt: 'go', models: [OPUS] })).rejects.toThrow(/Tests is still working/)
    expect(store.state.workspaces).toHaveLength(1)
    b.status = 'idle'
    b.queue = [{ id: 'q', text: 'later', at: '', disposition: 'queue' } as never]
    expect(compareBlock(source, store.state.sessions)).toContain('still working')
    b.queue = []
    b.closedAt = 'x'
    expect(compare.block(source.id)).toBeNull()
    expect(compareBlock({ state: 'history' }, [])).toContain('history only')
    expect(workspaces.workspace(source.id)).toBe(source)
  })

  it('is single-flight per source and never creates more than two siblings', async () => {
    const { compare, source, tab, store } = await rig()
    const t = tab(source.id)
    await expect(compare.start(source.id, { sessionId: t.id, prompt: 'go', models: [OPUS, CODEX, OPUS] })).rejects.toThrow(/one or two/)
    const first = compare.start(source.id, { sessionId: t.id, prompt: 'go', models: [OPUS] })
    await expect(compare.start(source.id, { sessionId: t.id, prompt: 'go', models: [OPUS] })).rejects.toThrow(/already starting/)
    await first
    expect(store.state.workspaces).toHaveLength(2)
  })

  it('archives the others without a winner or a merge', async () => {
    const { compare, source, tab, store } = await rig()
    const t = tab(source.id)
    const result = await compare.start(source.id, { sessionId: t.id, prompt: 'go', models: [OPUS, CODEX] })
    for (const w of result.workspaces.slice(1)) await ready(w)
    const keep = result.workspaces[1]
    await compare.archiveOthers(result.compareId, keep.id)
    expect(store.state.workspaces.map((w) => [w.id === keep.id, w.state === 'archived'])).toEqual([[false, true], [true, false], [false, true]])
    expect(existsSync(wsPath(keep))).toBe(true)
    expect(keep.compareId).toBeUndefined()
    await expect(compare.archiveOthers(result.compareId, 'nope')).rejects.toThrow()
  })

  it('summarises outcomes and deltas as the Home row says', async () => {
    const { compare, source, tab, store } = await rig()
    const t = tab(source.id)
    const result = await compare.start(source.id, { sessionId: t.id, prompt: 'go', models: [OPUS, CODEX] })
    const [, a, b] = result.workspaces
    expect(compareSummary(compareGroups(store.state.workspaces, store.state.sessions)[0])).toBe('Compare · 0 of 3 finished · … / … / …')
    t.lastTurn = { outcome: 'completed', endedAt: 'x', additions: 120, deletions: 8 }
    store.state.sessions.find((s) => s.id === a.compare!.sessionId)!.lastTurn = { outcome: 'completed', endedAt: 'x', additions: 95, deletions: 3 }
    store.state.sessions.find((s) => s.id === b.compare!.sessionId)!.lastTurn = { outcome: 'error', endedAt: 'x' }
    expect(compareSummary(compareGroups(store.state.workspaces, store.state.sessions)[0])).toBe('Compare · 3 of 3 finished · +120 −8 / +95 −3 / error')
  })
})
