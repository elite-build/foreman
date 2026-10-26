import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { tailLines } from '../src/shared/setupLog'
import type { Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

afterEach(() => vi.restoreAllMocks())

async function setup(state: Workspace['state']) {
  const dir = await tempDir('foreman-hold-')
  const store = new Store(dir)
  await store.load()
  const save = vi.spyOn(store, 'save').mockImplementation(() => {})
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const core = new Core(store, secrets, {
    broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
  })
  const ws: Workspace = {
    id: 'ws', repoId: 'repo', name: 'ws', branch: 'b', baseBranch: 'main', path: dir, portBase: 50040, state, createdAt: new Date().toISOString()
  }
  store.state.workspaces.push(ws)
  const send = vi.spyOn(core.sessions, 'send').mockResolvedValue('started')
  vi.spyOn(core.workspaces, 'setupLog').mockResolvedValue('$ npm i\nnpm ERR! boom\n')
  const hold = () => (core as unknown as { firstMessages: Map<string, unknown> }).firstMessages.set('ws', { sessionId: 's1', text: 'do it' })
  const flush = () => (core as unknown as { sendFirstMessages(): void }).sendFirstMessages()
  return { core, ws, send, hold, flush, save }
}

describe('preflight hold', () => {
  it('holds the first message when setup failed, and sends nothing', async () => {
    const { ws, send, hold, flush } = await setup('setup-failed')
    hold()
    flush()
    expect(send).not.toHaveBeenCalled()
    expect(ws.heldMessage).toMatchObject({ sessionId: 's1', text: 'do it' })
  })

  it('still sends right away when setup passed', async () => {
    const { ws, send, hold, flush } = await setup('ready')
    hold()
    flush()
    expect(send).toHaveBeenCalledWith('s1', 'do it')
    expect(ws.heldMessage).toBeUndefined()
  })

  it('keeps the template through the hold and Start anyway', async () => {
    const { core, ws, send, flush } = await setup('setup-failed')
    ;(core as unknown as { firstMessages: Map<string, unknown> }).firstMessages.set('ws', { sessionId: 's1', text: 'do it', templateId: 'tpl' })
    flush()
    expect(ws.heldMessage).toMatchObject({ templateId: 'tpl' })
    await core.startHeldMessage('ws')
    expect(send).toHaveBeenCalledWith('s1', 'do it', { templateId: 'tpl' })
  })

  it('waits while setup runs', async () => {
    const { ws, send, hold, flush } = await setup('setting-up')
    hold()
    flush()
    expect(send).not.toHaveBeenCalled()
    expect(ws.heldMessage).toBeUndefined()
    ws.state = 'setup-failed'
    flush()
    expect(ws.heldMessage?.text).toBe('do it')
  })

  it('Start anyway sends the held message once', async () => {
    const { core, ws, send, hold, flush } = await setup('setup-failed')
    hold()
    flush()
    await core.startHeldMessage('ws')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('s1', 'do it')
    expect(ws.heldMessage).toBeUndefined()
    await core.startHeldMessage('ws')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps the message held if starting anyway fails', async () => {
    const { core, ws, send, hold, flush } = await setup('setup-failed')
    hold()
    flush()
    send.mockRejectedValueOnce(new Error('nope'))
    await expect(core.startHeldMessage('ws')).rejects.toThrow('nope')
    expect(ws.heldMessage?.text).toBe('do it')
  })

  it('sends a held message when a setup re-run passes', async () => {
    const { ws, send, hold, flush } = await setup('setup-failed')
    hold()
    flush()
    ws.state = 'ready'
    flush()
    expect(send).toHaveBeenCalledWith('s1', 'do it')
    expect(ws.heldMessage).toBeUndefined()
  })

  it('reports the outcome with the log tail', async () => {
    const { core, hold, flush } = await setup('setup-failed')
    hold()
    flush()
    expect(await core.setupOutcome('ws')).toEqual({ failed: true, held: true, logTail: '$ npm i\nnpm ERR! boom' })
  })
})

describe('tailLines', () => {
  it('keeps the last lines and drops colour codes and blanks', () => {
    expect(tailLines('a\n\x1b[31mb\x1b[0m\n\nc\n', 2)).toBe('b\nc')
  })
})
