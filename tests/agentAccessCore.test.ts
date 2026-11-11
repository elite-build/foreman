// docs/agent-access.md §4: a new workspace's first message, held or not, carries its caller's cap; the capped Api passes it
// on; a message from the window or a phone carries none.
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import type { TurnCap } from '../src/shared/agentAccess'
import type { Session, Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

afterEach(() => vi.restoreAllMocks())

const cap = (ceiling: TurnCap['ceiling'], grantId = 'grant-1'): TurnCap => ({ ceiling, grantId, name: 'Claude Code' })

async function setup(state: Workspace['state']) {
  const dir = await tempDir('foreman-cap-core-')
  const store = new Store(dir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const core = new Core(store, secrets, {
    broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
  })
  const ws: Workspace = { id: 'ws', repoId: 'repo', name: 'ws', branch: 'b', baseBranch: 'main', path: await tempDir('foreman-cap-ws-'), portBase: 50040, state, createdAt: new Date().toISOString() }
  store.state.workspaces.push(ws)
  store.state.sessions.push({ id: 's1', workspaceId: 'ws', agent: 'claude', queue: [] } as unknown as Session)
  const send = vi.spyOn(core.sessions, 'send').mockResolvedValue('started')
  const internals = core as unknown as { startChat(...args: unknown[]): string; sendFirstMessages(): void; createFromOptions(...args: unknown[]): Promise<Workspace> }
  return { core, store, ws, send, internals }
}

describe('a new workspace’s first message from a capped turn', () => {
  it('goes with the cap once the workspace is ready', async () => {
    const { send, internals } = await setup('ready')
    internals.startChat('ws', 'Build the importer', undefined, undefined, undefined, { cap: cap('ask') })
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0][2]).toEqual({ cap: cap('ask') })
  })

  it('is held with the cap through a failed setup, and Start anyway sends it with that cap, lowered by a capped caller’s', async () => {
    const { core, ws, send, internals } = await setup('setup-failed')
    internals.startChat('ws', 'Build the importer', undefined, undefined, undefined, { cap: cap('auto') })
    expect(send).not.toHaveBeenCalled()
    expect(ws.heldMessage?.cap).toEqual(cap('auto'))
    await core.startHeldMessage('ws')
    expect(send.mock.calls[0][2]).toEqual({ cap: cap('auto') })
    // Held again, and started from a turn capped lower.
    internals.startChat('ws', 'Again', undefined, undefined, undefined, { cap: cap('auto') })
    await core.cappedApi(cap('ask', 'other')).startHeldMessage('ws')
    expect(send.mock.calls[1][2]).toEqual({ cap: cap('ask', 'other') })
    // A person's held message stays uncapped.
    internals.startChat('ws', 'Mine')
    expect(ws.heldMessage?.cap).toBeUndefined()
  })

  it('reaches the first message from createWorkspace’s options, through the CLI host and the capped Api', async () => {
    const { core, internals } = await setup('ready')
    const create = vi.spyOn(internals, 'createFromOptions').mockResolvedValue({} as Workspace)
    await core.createWorkspaceFor('repo', { prompt: 'x' }, { startedBy: { sessionId: 's1', via: 'cli' }, cap: cap('ask') })
    expect(create).toHaveBeenLastCalledWith('repo', { prompt: 'x' }, { startedBy: { sessionId: 's1', via: 'cli' }, cap: cap('ask') })
    await core.createWorkspaceFor('repo', { prompt: 'y' })
    expect(create).toHaveBeenLastCalledWith('repo', { prompt: 'y' }, undefined)
    await core.cappedApi(cap('auto')).createWorkspace('repo', { prompt: 'z' })
    expect(create).toHaveBeenLastCalledWith('repo', { prompt: 'z' }, { cap: cap('auto') })
  })
})

describe('the capped Api', () => {
  it('passes the cap to what starts or queues a turn', async () => {
    const { core } = await setup('ready')
    const note = vi.spyOn(core.sessions, 'sendNote').mockResolvedValue({ disposition: 'queued', turnId: 't' })
    const steer = vi.spyOn(core.sessions, 'steerQueued').mockResolvedValue()
    const resume = vi.spyOn(core.limitResume, 'resumeNow').mockResolvedValue()
    const retry = vi.spyOn(core.stopSafely, 'retry').mockResolvedValue()
    const api = core.cappedApi(cap('ask'))
    await api.sendNote('s1')
    await api.steerQueued('s1', 'q1')
    await api.resumeLimitNow('s1')
    await api.retryStopped('t1')
    expect(note).toHaveBeenCalledWith('s1', cap('ask'))
    expect(steer).toHaveBeenCalledWith('s1', 'q1', cap('ask'))
    expect(resume).toHaveBeenCalledWith('s1', cap('ask'))
    expect(retry).toHaveBeenCalledWith('t1', cap('ask'))
    // Git actions, Fix CI, a moved base and a cloud Continue reach the chat with it too.
    const git = vi.spyOn(core.git, 'run').mockResolvedValue({ disposition: 'queued', turnId: 't' })
    const cont = vi.spyOn(core.cloudTurns, 'continueSession').mockResolvedValue({ disposition: 'queued', turnId: 't' })
    await api.gitAction('ws', 'commit-and-push', 's1')
    await api.fixCi('ws', 's1')
    await api.resolveBaseMoved('ws', 's1')
    await api.cloudContinue('s1')
    expect(git.mock.calls).toEqual([['ws', 'commit-and-push', 's1', cap('ask')], ['ws', 'fix-errors', 's1', cap('ask')], ['ws', 'resolve-conflicts', 's1', cap('ask')]])
    expect(cont).toHaveBeenCalledWith('s1', cap('ask'))
    // The plain Api passes none.
    await core.api.sendNote('s1')
    expect(note).toHaveBeenLastCalledWith('s1')
    await core.api.gitAction('ws', 'commit-and-push', 's1')
    expect(git.mock.calls.at(-1)).toEqual(['ws', 'commit-and-push', 's1'])
  })
})

describe('a message from the window or a phone', () => {
  it('is the user’s, whatever cap it claims', async () => {
    const { core, send } = await setup('ready')
    await core.api.sendMessage('s1', 'hello', { cap: cap('ask'), mode: 'queue' })
    expect(send).toHaveBeenLastCalledWith('s1', 'hello', { mode: 'queue' })
  })
})
