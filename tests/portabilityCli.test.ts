import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleRequest, type CliHost } from '../src/main/cliServer'
import type { CliRequest } from '../src/cli/protocol'
import { tempDir } from './helpers'
import { stubHost } from './cliHost'
import { machine, seed, type Machine } from './portabilityRig'

function host(m: Machine): CliHost {
  return stubHost({
    state: () => m.store.state,
    exportInfo: (id) => m.portability.exportInfo(id),
    exportWorkspace: (id, options) => m.portability.exportWorkspace(id, options),
    stageImport: (file, passphrase) => m.portability.stage(file, passphrase),
    importStaged: (stageId, choice) => m.portability.importStaged(stageId, choice),
    discardImport: (stageId) => m.portability.discard(stageId)
  })
}

const call = async (m: Machine, request: CliRequest) => handleRequest(host(m), request)

describe('foreman export / import', () => {
  it('a backup needs a passphrase; a share lists the chats it holds', async () => {
    const m = await machine()
    await seed(m)
    const cwd = await tempDir()
    expect(await call(m, { method: 'export', params: { workspace: 'dakar', cwd } })).toMatchObject({ ok: false, error: expect.stringContaining('passphrase') })

    const shared = await call(m, { method: 'export', params: { workspace: 'dakar', cwd, share: true, chats: ['2'] } })
    expect(shared).toMatchObject({ ok: true, result: { mode: 'share', encrypted: false, chats: [{ id: 'sess-2', title: 'Tests' }], path: path.join(cwd, 'dakar.foreman') } })
    const text = (shared as { result: { message: string } }).result.message
    expect(text).toContain('reviewed by you')
    expect(text).toContain('Tool output is left out.')
    expect(text).not.toContain('sanitized')
    expect(await call(m, { method: 'export', params: { workspace: 'dakar', cwd, share: true, chats: ['9'] } })).toMatchObject({ ok: false, error: expect.stringContaining('no chat') })
  })

  it('imports as history only once the repository is confirmed', async () => {
    const src = await machine()
    await seed(src)
    const cwd = await tempDir()
    await call(src, { method: 'export', params: { workspace: 'dakar', cwd, passphrase: 'pw', out: 'b.foreman' } })

    const dst = await machine()
    const base = { file: 'b.foreman', cwd }
    expect(await call(dst, { method: 'import', params: base })).toEqual({ ok: true, result: { status: 'needs-passphrase' } })
    expect(await call(dst, { method: 'import', params: { ...base, passphrase: 'nope' } })).toMatchObject({ ok: false, error: expect.stringContaining('Wrong passphrase') })
    // A suggestion is not a decision.
    expect(await call(dst, { method: 'import', params: { ...base, passphrase: 'pw' } })).toMatchObject({ ok: false, error: expect.stringContaining('Which repository') })
    expect(dst.store.state.workspaces).toHaveLength(0)

    const done = await call(dst, { method: 'import', params: { ...base, passphrase: 'pw', yes: true } })
    expect(done).toMatchObject({ ok: true, result: { status: 'imported', workspace: { name: 'dakar' }, tabs: 2 } })
    expect(dst.store.state.workspaces).toMatchObject([{ state: 'history' }])
    expect((done as { result: { message: string } }).result.message).toContain('history only')

    const again = await call(dst, { method: 'import', params: { ...base, passphrase: 'pw', yes: true } })
    expect(again).toMatchObject({ ok: false, error: expect.stringContaining('--copy') })
    const copy = await call(dst, { method: 'import', params: { ...base, passphrase: 'pw', repo: dst.repo.name, copy: true } })
    expect(copy).toMatchObject({ ok: true })
    expect(dst.store.state.workspaces).toHaveLength(2)
  })
})
