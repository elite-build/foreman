// The flow API behind Settings → Experimental → Flows: off, every method refuses and nothing is read; on, the list
// combines built-in, repository and personal flows, and a personal flow is saved only when it parses.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { revalidateRepoFlows } from '../src/main/flowFiles'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import { makeRepo, tempDir } from './helpers'

afterEach(() => {
  vi.restoreAllMocks()
  revalidateRepoFlows()
})

async function setup() {
  const dir = await tempDir('foreman-flows-api-')
  const store = new Store(dir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() })
  const core = new Core(store, secrets, {
    broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
  })
  core.attention.stop()
  return { core, store }
}

const GOOD = FLOW_STARTERS[0].toml

describe('the flow API', () => {
  it('is off by default, and every method refuses while it is off', async () => {
    const { core, store } = await setup()
    expect(store.state.settings.flows).toBe(false)
    await expect(core.api.listFlows()).rejects.toThrow('Flows are off; turn them on in Settings → Experimental.')
    await expect(core.api.savePersonalFlow({ toml: GOOD })).rejects.toThrow('Flows are off')
    await expect(core.api.deletePersonalFlow('x')).rejects.toThrow('Flows are off')
    expect(store.state.personalFlows).toEqual([])
    await core.shutdown()
  })

  it('lists built-in, repository and personal flows once it is on', async () => {
    const { core, store } = await setup()
    await core.api.updateSettings({ flows: true })
    const root = await makeRepo()
    await mkdir(path.join(root, '.foreman/flows'), { recursive: true })
    await writeFile(path.join(root, '.foreman/flows/team.toml'), GOOD.replace('Fix until green', 'Team flow'))
    const repo = await core.api.addRepo(root)
    const saved = await core.api.savePersonalFlow({ toml: GOOD.replace('Fix until green', 'Mine') })
    expect('flow' in saved && saved.flow).toMatchObject({ source: 'personal', name: 'Mine', summary: { steps: 6, loops: 2, gates: 1 } })
    const list = await core.api.listFlows()
    expect(list.map((f) => `${f.source}:${f.name}`)).toEqual(['built-in:Fix until green', 'built-in:Research then implement', 'repo:Team flow', 'personal:Mine'])
    expect(list[2]).toMatchObject({ repoId: repo.id, file: '.foreman/flows/team.toml' })
    expect((await core.api.listFlows(repo.id)).filter((f) => f.source === 'repo')).toHaveLength(1)
    await expect(core.api.listFlows('no-such-repo')).rejects.toThrow()
    expect(store.state.personalFlows).toHaveLength(1)
    await core.shutdown()
  })

  it('saves, updates and deletes a personal flow, and returns problems without saving a broken one', async () => {
    const { core, store } = await setup()
    await core.api.updateSettings({ flows: true })
    const refused = await core.api.savePersonalFlow({ toml: GOOD.replace('implement = "checks"', 'implement = "nowhere"') })
    expect(refused).toEqual({ problems: ['The edge from “implement” goes to “nowhere”, which is neither a step nor done.'] })
    expect(store.state.personalFlows).toEqual([])

    const first = await core.api.savePersonalFlow({ toml: GOOD })
    if (!('flow' in first)) throw new Error('not saved')
    const updated = await core.api.savePersonalFlow({ id: first.flow.id, toml: GOOD.replace('Fix until green', 'Renamed') })
    expect('flow' in updated && updated.flow).toMatchObject({ id: first.flow.id, name: 'Renamed' })
    expect(store.state.personalFlows).toHaveLength(1)
    await expect(core.api.savePersonalFlow({ id: 'gone', toml: GOOD })).rejects.toThrow('That flow isn’t saved any more.')

    await core.api.deletePersonalFlow(first.flow.id)
    expect(store.state.personalFlows).toEqual([])
    expect((await core.api.listFlows()).filter((f) => f.source === 'personal')).toEqual([])
    await core.shutdown()
  })
})
