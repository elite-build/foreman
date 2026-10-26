import { describe, expect, it, vi } from 'vitest'
import { TransferService, type TransferLocal } from '../src/main/transfers'
import { frozenReason, pendingTransfers, sourceSteps, type PeerRequest, type PeerResponse, type Transfer, type WorkspaceTransfer } from '../src/shared/transfer'

interface Ws {
  id: string
  name: string
  branch: string
  state: string
  transfer?: WorkspaceTransfer
}

/** Two Macs and the wire between them, with faults we can switch on. */
class Wire {
  macs = new Map<string, Mac>()
  unreachable = new Set<string>()
  // The request is processed, then its answer is lost.
  dropAnswer = new Set<PeerRequest['type']>()
  log: string[] = []

  transport(from: string) {
    return {
      send: async (to: string, request: PeerRequest, file?: Buffer): Promise<PeerResponse> => {
        this.log.push(`${from}→${to} ${request.type}`)
        if (this.unreachable.has(to) || this.unreachable.has(from)) throw new Error('unreachable')
        const response = await this.macs.get(to)!.service.handle(from, request, file)
        if (this.dropAnswer.has(request.type)) throw new Error('timeout waiting for the answer')
        return response
      }
    }
  }
}

class Mac {
  workspaces = new Map<string, Ws>()
  files = new Map<string, Buffer>()
  store = { state: { transfers: [] as Transfer[] }, flush: vi.fn() }
  busy: string | null = null
  validation: string[] = []
  findRepoResult: string | undefined = 'repo'
  stageError: string | undefined
  activateError: string | undefined
  notices: string[] = []
  exports = 0
  service: TransferService

  constructor(
    readonly id: string,
    readonly name: string,
    wire: Wire,
    peers: Record<string, string>
  ) {
    const local: TransferLocal = {
      workspace: (id) => {
        const ws = this.workspaces.get(id)
        if (!ws) throw new Error('Workspace not found')
        return ws
      },
      setTransfer: (id, transfer) => {
        const ws = this.workspaces.get(id)!
        if (transfer) ws.transfer = transfer
        else delete ws.transfer
      },
      evidence: async () => ({ name: 'app', remoteUrl: 'git@github.com:acme/app.git' }),
      hasClaude: () => true,
      busy: () => this.busy,
      exportBackup: async (id, _pass, outPath) => {
        this.exports++
        this.files.set(outPath, Buffer.from(JSON.stringify({ id, name: this.workspaces.get(id)!.name })))
      },
      findRepo: async () => this.findRepoResult,
      validate: async () => this.validation,
      stage: async (file) => {
        if (this.stageError) throw new Error(this.stageError)
        const data = JSON.parse(this.files.get(file)!.toString()) as { id: string; name: string }
        this.workspaces.set(data.id, { id: data.id, name: data.name, branch: 'b', state: 'history' })
        return { workspaceId: data.id }
      },
      activate: async (id) => {
        if (this.activateError) throw new Error(this.activateError)
        this.workspaces.get(id)!.state = 'ready'
      },
      discard: async (id) => void this.workspaces.delete(id),
      notice: async (_id, text) => void this.notices.push(text)
    }
    this.service = new TransferService({
      store: this.store,
      transport: wire.transport(id),
      local,
      peerName: (p) => peers[p] ?? 'the other Mac',
      files: {
        temp: (name) => `/tmp/${name}`,
        read: async (p) => this.files.get(p)!,
        write: async (p, d) => void this.files.set(p, d),
        remove: async (p) => void this.files.delete(p)
      },
      changed: () => undefined
    })
    wire.macs.set(id, this)
  }
}

function pair() {
  const wire = new Wire()
  const peers = { air: 'Air', studio: 'Studio' }
  const air = new Mac('air', 'Air', wire, peers)
  const studio = new Mac('studio', 'Studio', wire, peers)
  air.workspaces.set('ws1', { id: 'ws1', name: 'lima', branch: 'lima', state: 'ready' })
  return { wire, air, studio }
}

/** Start a hand-off from Air to Studio and wait until Air has nothing more to do. */
async function handOff(air: Mac) {
  const id = await air.service.start('ws1', 'studio')
  await air.service.settled(id)
  return { id, source: air.service.find(id)! }
}

describe('hand off: happy path', () => {
  it('validates, freezes, exports, stages, relinquishes, then activates, in that order', async () => {
    const { wire, air, studio } = pair()
    const flushedStates: string[] = []
    air.store.flush.mockImplementation(() => flushedStates.push(air.store.state.transfers.map((t) => t.state).join()))

    const { id, source } = await handOff(air)
    expect(wire.log).toEqual(['air→studio validate', 'air→studio offer', 'air→studio activate'])
    // The source persisted each step before the next one.
    expect(flushedStates).toEqual(expect.arrayContaining(['validating', 'frozen', 'exporting', 'sending', 'relinquished', 'completed']))
    expect(flushedStates.indexOf('frozen')).toBeLessThan(flushedStates.indexOf('exporting'))
    expect(flushedStates.indexOf('relinquished')).toBeLessThan(flushedStates.indexOf('completed'))

    expect(source.state).toBe('completed')
    // The source gave it up: frozen for good, with a reason.
    expect(air.workspaces.get('ws1')!.transfer).toMatchObject({ state: 'handed-off', peerName: 'Studio' })
    expect(frozenReason(air.workspaces.get('ws1')!)).toMatch(/handed off to Studio/)
    // The destination kept the same id, and activated.
    const there = studio.workspaces.get('ws1')!
    expect(there.state).toBe('ready')
    expect(there.transfer).toBeUndefined()
    expect(studio.service.find(id)).toMatchObject({ role: 'destination', state: 'completed' })
    // Nothing is left to reconcile, and the temp files are gone.
    expect(pendingTransfers(air.service.view())).toEqual([])
    expect(air.files.size).toBe(0)
    expect(studio.files.size).toBe(0)
    expect(sourceSteps(source).every((s) => s.status === 'done')).toBe(true)
  })

  it('stages the work inactive before the source gives it up', async () => {
    const { air, studio } = pair()
    studio.activateError = 'worktree failed'
    const { id, source } = await handOff(air)
    // The work arrived and is safe there, staged; the source already gave it up.
    expect(source.state).toBe('relinquished')
    expect(source.error).toMatch(/hasn’t activated yet/)
    expect(studio.workspaces.get('ws1')!.transfer?.state).toBe('staged')
    expect(studio.service.find(id)!.state).toBe('staged')
    // It can be activated from the destination once the problem is gone.
    studio.activateError = undefined
    await studio.service.reconcile(id, 'keep-here')
    expect(studio.workspaces.get('ws1')!.state).toBe('ready')
    expect(studio.service.find(id)!.state).toBe('completed')
  })
})

describe('hand off: refusals leave the source as it was', () => {
  it('a destination that fails validation never freezes the source', async () => {
    const { air, studio } = pair()
    studio.findRepoResult = undefined
    studio.validation = ['Claude isn’t signed in on this Mac, and this workspace has Claude chats.']
    const { source } = await handOff(air)
    expect(source.state).toBe('cancelled')
    expect(source.error).toMatch(/isn’t added on this Mac/)
    expect(source.error).toMatch(/Claude isn’t signed in/)
    expect(air.workspaces.get('ws1')!.transfer).toBeUndefined()
    expect(air.exports).toBe(0)
    expect(studio.workspaces.size).toBe(0)
  })

  it('an unreachable destination changes nothing', async () => {
    const { air, wire } = pair()
    wire.unreachable.add('studio')
    const { source } = await handOff(air)
    expect(source.state).toBe('cancelled')
    expect(source.error).toMatch(/isn’t reachable/)
    expect(air.workspaces.get('ws1')!.transfer).toBeUndefined()
  })

  it('a destination that cannot stage it says no, and the source is unfrozen', async () => {
    const { air, studio } = pair()
    studio.stageError = 'This is already here as “lima”.'
    const { source } = await handOff(air)
    expect(source.state).toBe('cancelled')
    expect(source.error).toMatch(/already here/)
    expect(air.workspaces.get('ws1')!.transfer).toBeUndefined()
    expect(studio.workspaces.size).toBe(0)
    expect(sourceSteps(source).find((s) => s.status === 'failed')?.detail).toMatch(/already here/)
  })

  it('a busy workspace is not frozen', async () => {
    const { air } = pair()
    air.busy = 'a tab is working'
    const { source } = await handOff(air)
    expect(source.state).toBe('cancelled')
    expect(source.error).toMatch(/a tab is working/)
    expect(air.exports).toBe(0)
  })

  it('refuses a second hand-off of the same workspace', async () => {
    const { air } = pair()
    await handOff(air)
    await expect(air.service.start('ws1', 'studio')).rejects.toThrow(/handed off to Studio/)
  })
})

describe('hand off: a lost acknowledgement', () => {
  async function lost() {
    const rig = pair()
    rig.wire.dropAnswer.add('offer')
    const { id, source } = await handOff(rig.air)
    rig.wire.dropAnswer.clear()
    return { ...rig, id, source }
  }

  it('leaves both sides locked, with a Reconcile row on each', async () => {
    const { air, studio, id, source } = await lost()
    expect(source.state).toBe('awaiting-ack')
    expect(frozenReason(air.workspaces.get('ws1')!)).toMatch(/frozen for a hand-off to Studio/)
    // Studio did stage it, but it stays inactive and locked.
    expect(studio.workspaces.get('ws1')).toMatchObject({ state: 'history', transfer: { state: 'staged' } })
    expect(frozenReason(studio.workspaces.get('ws1')!)).toMatch(/waiting to be activated/)
    expect(pendingTransfers(air.service.view()).map((t) => t.id)).toEqual([id])
    expect(pendingTransfers(studio.service.view()).map((t) => t.id)).toEqual([id])
    // Neither Mac activates or relinquishes by itself.
    expect(studio.service.find(id)!.state).toBe('staged')
  })

  it('source keeps it: Studio drops its staged copy and the source is unfrozen, cleanly', async () => {
    const { air, studio, id } = await lost()
    await air.service.reconcile(id, 'keep-here')
    expect(air.service.find(id)!.state).toBe('cancelled')
    expect(air.workspaces.get('ws1')!.transfer).toBeUndefined()
    expect(studio.workspaces.size).toBe(0)
    expect(studio.service.find(id)!.state).toBe('cancelled')
    expect(air.notices).toEqual([])
  })

  it('destination keeps it: the source is told, gives it up, and Studio activates, cleanly', async () => {
    const { air, studio, id } = await lost()
    await studio.service.reconcile(id, 'keep-here')
    expect(air.service.find(id)!.state).toBe('relinquished')
    expect(air.workspaces.get('ws1')!.transfer?.state).toBe('handed-off')
    expect(studio.workspaces.get('ws1')!.state).toBe('ready')
    expect(studio.service.find(id)!.state).toBe('completed')
    expect(studio.notices).toEqual([])
  })

  it('source lets Studio keep it: only when Studio says it has the work', async () => {
    const { air, studio, id, wire } = await lost()
    wire.unreachable.add('studio')
    await expect(air.service.reconcile(id, 'other-keeps')).rejects.toThrow(/isn’t reachable/)
    expect(air.service.find(id)!.state).toBe('awaiting-ack')
    wire.unreachable.clear()
    await air.service.reconcile(id, 'other-keeps')
    expect(air.workspaces.get('ws1')!.transfer?.state).toBe('handed-off')
    expect(studio.workspaces.get('ws1')!.state).toBe('ready')
    expect(air.service.find(id)!.state).toBe('completed')
  })

  it('destination lets the source keep it: the staged copy is discarded and the source is unfrozen', async () => {
    const { air, studio, id } = await lost()
    await studio.service.reconcile(id, 'other-keeps')
    expect(studio.workspaces.size).toBe(0)
    expect(studio.service.find(id)!.state).toBe('cancelled')
    expect(air.service.find(id)!.state).toBe('cancelled')
    expect(air.workspaces.get('ws1')!.transfer).toBeUndefined()
  })

  it('a forced take-back, with Studio unreachable, makes an explicitly divergent copy', async () => {
    const { air, studio, id, wire } = await lost()
    wire.unreachable.add('studio')
    await air.service.reconcile(id, 'keep-here')
    const t = air.service.find(id)!
    expect(t.state).toBe('diverged')
    expect(t.error).toMatch(/couldn’t be reached/)
    // Unfrozen (it is the source's to work on again), but marked.
    expect(air.workspaces.get('ws1')!.transfer).toMatchObject({ state: 'diverged' })
    expect(frozenReason(air.workspaces.get('ws1')!)).toBeNull()
    expect(air.notices[0]).toMatch(/diverged/)
    // Studio still holds its staged copy until its own user reconciles.
    expect(studio.workspaces.get('ws1')!.transfer?.state).toBe('staged')
  })

  it('a forced local activation, with the source unreachable, is divergent too', async () => {
    const { studio, id, wire } = await lost()
    wire.unreachable.add('air')
    await studio.service.reconcile(id, 'keep-here')
    expect(studio.service.find(id)!.state).toBe('diverged')
    expect(studio.workspaces.get('ws1')).toMatchObject({ state: 'ready', transfer: { state: 'diverged' } })
    expect(studio.notices[0]).toMatch(/diverged/)
  })

  it('cannot be reconciled twice', async () => {
    const { air, id } = await lost()
    await air.service.reconcile(id, 'keep-here')
    await expect(air.service.reconcile(id, 'keep-here')).rejects.toThrow(/already settled/)
  })

  it('a repeated offer gets the same answer instead of staging twice', async () => {
    const { studio, id, wire } = await lost()
    const again = await wire.transport('air').send('studio', { type: 'offer', transferId: id, passphrase: 'x', bytes: 1, sha256: 'x' }, Buffer.from('x'))
    expect(again).toMatchObject({ ok: true, stagedWorkspaceId: 'ws1' })
    expect(studio.workspaces.size).toBe(1)
  })
})

describe('hand off: damage and restarts', () => {
  it('stages nothing from a file that arrived damaged', async () => {
    const { studio, wire } = pair()
    const res = await wire.transport('air').send('studio', { type: 'offer', transferId: 't', passphrase: 'x', bytes: 5, sha256: 'wrong' }, Buffer.from('hello'))
    expect(res.ok).toBe(false)
    expect(studio.workspaces.size).toBe(0)
    expect(studio.service.transfers).toHaveLength(0)
  })

  it('after a restart, a hand-off that was in flight waits for a person, and an unfrozen one is dropped', () => {
    const { air } = pair()
    const base = { role: 'source' as const, workspaceId: 'ws1', workspaceName: 'lima', peerId: 'studio', peerName: 'Studio', startedAt: 'x', updatedAt: 'x' }
    air.store.state.transfers = [
      { ...base, id: 'a', state: 'validating' },
      { ...base, id: 'b', state: 'sending' },
      { ...base, id: 'c', state: 'exporting' },
      { ...base, id: 'd', state: 'completed' }
    ]
    air.service.recover()
    expect(air.service.transfers.map((t) => `${t.id}:${t.state}`)).toEqual(['b:awaiting-ack', 'c:awaiting-ack', 'd:completed'])
    expect(pendingTransfers(air.service.view()).map((t) => t.id)).toEqual(['b', 'c'])
  })

  it('does not let one Mac settle another Mac\'s hand-off', async () => {
    const { air, studio, wire } = pair()
    wire.dropAnswer.add('offer')
    const { id } = await handOff(air)
    const res = await studio.service.handle('mallory', { type: 'activate', transferId: id })
    expect(res.ok).toBe(false)
    expect(studio.service.find(id)!.state).toBe('staged')
    expect(air.service.find(id)!.state).toBe('awaiting-ack')
  })
})

describe('a frozen workspace', () => {
  it('refuses to send a message while a hand-off holds it', async () => {
    const { setupSessions } = await import('./sessionHarness')
    const { sessions, session, ws } = await setupSessions()
    ws.transfer = { id: 't', state: 'frozen', peerName: 'Studio' }
    await expect(sessions.send(session.id, 'hello')).rejects.toThrow(/frozen for a hand-off to Studio/)
    ws.transfer = { id: 't', state: 'handed-off', peerName: 'Studio' }
    await expect(sessions.send(session.id, 'hello')).rejects.toThrow(/handed off to Studio/)
    delete ws.transfer
  })
})
