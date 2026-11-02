import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core, expandPorts } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import type { Loadout, Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

afterEach(() => vi.restoreAllMocks())

async function setup() {
  const dir = await tempDir('foreman-workspace-model-')
  const store = new Store(dir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), {
    available: () => false,
    encrypt: () => Buffer.from(''),
    decrypt: () => ''
  })
  const broadcast = vi.fn()
  const openExternal = vi.fn(async () => {})
  const core = new Core(store, secrets, {
    broadcast,
    applyTheme() {},
    pickDirectory: async () => null,
    pickFiles: async () => [],
    pickPath: async () => null,
    openPath: async () => {},
    openExternal,
    setBadge() {},
    setZoom() {},
    keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }),
    cliShim: () => ''
  })
  const workspace: Workspace = {
    id: 'workspace', repoId: 'repo', name: 'test', branch: 'test', baseBranch: 'main',
    path: dir, portBase: 50040, state: 'ready', createdAt: new Date().toISOString()
  }
  store.state.workspaces.push(workspace)
  vi.spyOn(core.workspaces, 'createWorkspace').mockResolvedValue(workspace)
  vi.spyOn(core.workspaces, 'adoptWorktree').mockResolvedValue(workspace)
  const send = vi.spyOn(core.sessions, 'send').mockResolvedValue('started')
  return { core, store, send, broadcast, openExternal }
}

describe('workspace model selection', () => {
  it.each(['new', 'direct', 'adopt'] as const)('uses the selected model before sending the first message (%s)', async (mode) => {
    const { core, store, send } = await setup()
    const loadout: Loadout = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', fast: true }
    const options = { loadout, prompt: '  Fix the bug  ' }
    const defaults = structuredClone(store.state.settings.loadouts)

    if (mode === 'adopt') await core.api.adoptWorktree('repo', '/worktree', { ...options, runSetup: false })
    else await core.api.createWorkspace('repo', { ...options, branch: mode === 'direct' ? { kind: 'direct', name: 'main' } : { kind: 'new' } })

    expect(store.state.sessions).toHaveLength(1)
    const session = store.state.sessions[0]
    expect(session).toMatchObject({ workspaceId: 'workspace', agent: loadout.agent, model: loadout.model, effort: loadout.effort, fastMode: loadout.fast })
    expect(send).toHaveBeenCalledExactlyOnceWith(session.id, 'Fix the bug')
    expect(store.state.settings.loadouts).toEqual(defaults)
  })

  it('keeps the selected model when no first message is provided', async () => {
    const { core, store, send } = await setup()
    await core.api.createWorkspace('repo', { loadout: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low', fast: false } })
    expect(store.state.sessions[0]).toMatchObject({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'low', fastMode: false })
    expect(send).not.toHaveBeenCalled()
  })

  it('uses the default loadout when no model is selected', async () => {
    const { core, store } = await setup()
    store.state.settings.loadouts = [{ agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: true }]
    await core.api.createWorkspace('repo')
    expect(store.state.sessions[0]).toMatchObject({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', fastMode: true })
  })

  describe('template start model', () => {
    const start = { agent: 'codex' as const, model: 'gpt-6.1-sol', effort: 'low' as const }

    async function withTemplate(startModel?: typeof start) {
      const ctx = await setup()
      ctx.store.state.settings.promptTemplates = [{ id: 'review', name: 'Review a PR', body: 'Review {{pr}}', startModel }]
      ctx.store.state.settings.loadouts = [{ agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'high', fast: true }]
      return ctx
    }

    it('starts the new chat on the template’s model, without fast mode', async () => {
      const { core, store } = await withTemplate(start)
      await core.api.createWorkspace('repo', { prompt: 'Review #3', templateId: 'review' })
      expect(store.state.sessions[0]).toMatchObject({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'low', fastMode: false })
    })

    it('lets an explicit model win', async () => {
      const { core, store } = await withTemplate(start)
      await core.api.createWorkspace('repo', { prompt: 'Review #3', templateId: 'review', loadout: { agent: 'claude', model: 'claude-fable-5-1', effort: 'high', fast: false } })
      expect(store.state.sessions[0]).toMatchObject({ agent: 'claude', model: 'claude-fable-5-1' })
    })

    it('does nothing for a template without one, and keeps permissions as they were', async () => {
      const { core, store } = await withTemplate(undefined)
      await core.api.createWorkspace('repo', { prompt: 'Review #3', templateId: 'review' })
      expect(store.state.sessions[0]).toMatchObject({ agent: 'claude', fastMode: true })
      const { core: other, store: otherStore } = await withTemplate(start)
      await other.api.createWorkspace('repo', { prompt: 'x', templateId: 'review' })
      expect(Object.keys(otherStore.state.sessions[0]).filter((k) => /approv|permission|autoAccept/i.test(k))).toEqual([])
    })

    it('ignores a template id that no longer exists', async () => {
      const { core, store } = await withTemplate(start)
      await core.api.createWorkspace('repo', { prompt: 'x', templateId: 'gone' })
      expect(store.state.sessions[0].agent).toBe('claude')
    })
  })
})


describe('workspace browser preview routing', () => {
  it.each(['FOREMAN', 'SWITCHYARD'])('expands %s port placeholders in all supported forms', (prefix) => {
    expect(expandPorts(`http://localhost:$${prefix}_PORT`, 50040)).toBe('http://localhost:50040')
    expect(expandPorts(`http://localhost:\${${prefix}_PORT}`, 50040)).toBe('http://localhost:50040')
    expect(expandPorts(`http://localhost:%${prefix}_PORT%`, 50040)).toBe('http://localhost:50040')
    expect(expandPorts(`http://localhost:$(( ${prefix}_PORT + 3 ))`, 50040)).toBe('http://localhost:50043')
  })

  it('leaves other environment placeholders untouched', () => {
    const template = 'http://localhost:$APP_PORT/${CUSTOM_PORT}/%CUSTOM_PORT%/$(( APP_PORT + 3 ))'
    expect(expandPorts(template, 50040)).toBe(template)
  })

  it('expands the workspace port and opens an internal browser rather than an external window', async () => {
    const { core, broadcast, openExternal } = await setup()
    vi.spyOn(core.workspaces, 'settingsFor').mockReturnValue({ previewUrls: [{ name: 'App', url: 'http://localhost:$FOREMAN_PORT/pricing' }] } as never)
    await core.api.openPreview('workspace')
    expect(broadcast).toHaveBeenCalledWith({ type: 'browser-open', workspaceId: 'workspace', url: 'http://localhost:50040/pricing' })
    expect(openExternal).not.toHaveBeenCalled()
  })
  it('rejects non-web previews before requesting a browser', async () => {
    const { core, broadcast } = await setup()
    vi.spyOn(core.workspaces, 'settingsFor').mockReturnValue({ previewUrls: [{ name: 'Bad', url: 'file:///etc/passwd' }] } as never)
    await expect(core.api.openPreview('workspace')).rejects.toThrow('http:// or https://')
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'browser-open' }))
  })
})

describe('the integrations a new workspace starts with', () => {
  async function withConnections() {
    const rigged = await setup()
    rigged.store.state.repos.push({ id: 'repo', name: 'web', rootPath: '/web', defaultBranch: 'main', remote: 'origin', hasOrigin: true, local: {}, createdAt: 'x' } as never)
    rigged.store.state.integrations = {
      connections: [
        { id: 'lin', service: 'linear', name: 'Acme Linear', rev: 1, auth: { kind: 'token' }, agentAccess: 'read', createdAt: 'x' },
        { id: 'sl', service: 'slack', name: 'Acme Slack', rev: 1, auth: { kind: 'token' }, agentAccess: 'write', startsOff: true, createdAt: 'x' },
        { id: 'gh', service: 'github', name: 'Work', rev: 1, auth: { kind: 'gh-active' }, agentAccess: 'write', createdAt: 'x' }
      ],
      defaults: { linear: 'lin', slack: 'sl', github: 'gh' },
      rules: [],
      people: []
    }
    // The keys are in the vault in real use.
    vi.spyOn(rigged.core.integrations, 'secret').mockReturnValue('key')
    return rigged
  }

  it('records every switchable one, from the caller’s choice over the repository’s defaults', async () => {
    const { core, store } = await withConnections()
    await core.api.createWorkspace('repo', { integrations: { slack: true } })
    expect(store.state.workspaces[0].integrations).toEqual({ linear: true, slack: true })
    // The CLI and the phone pass nothing: the defaults are recorded, so a later change to one doesn't flip this workspace.
    await core.api.createWorkspace('repo')
    expect(store.state.workspaces[0].integrations).toEqual({ linear: true, slack: false })
    await core.api.adoptWorktree('repo', '/worktree', { runSetup: false, integrations: { linear: false } })
    expect(store.state.workspaces[0].integrations).toEqual({ linear: false, slack: false })
  })

  it('records nothing when no integration gives agents tools', async () => {
    const { core, store } = await setup()
    await core.api.createWorkspace('repo', { integrations: { linear: true } })
    expect(store.state.workspaces[0].integrations).toBeUndefined()
  })
})
