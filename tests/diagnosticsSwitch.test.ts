// Settings → Experimental → Keep diagnostics reaches the host (docs/telemetry.md), at start and on every change, and
// Save diagnostics writes the host's bundle where the user chose.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core, type Host } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import type { DiagnosticsBundle } from '../src/shared/diagnostics'
import { tempDir } from './helpers'

afterEach(() => vi.restoreAllMocks())

async function setup(host: Partial<Host> = {}) {
  const dir = await tempDir('foreman-diag-switch-')
  const store = new Store(dir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() })
  const core = new Core(store, secrets, {
    broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => '',
    ...host
  })
  core.attention.stop()
  return { core, store, dir }
}

describe('Keep diagnostics', () => {
  it('is on by default and tells the host at start and whenever it changes', async () => {
    const applied: boolean[] = []
    const { core } = await setup({ applyDiagnostics: (on) => applied.push(on) })
    core.applySettings()
    expect(applied).toEqual([true])
    await core.api.updateSettings({ diagnostics: false })
    expect(applied).toEqual([true, false])
    // Another setting changing does not re-apply it.
    await core.api.updateSettings({ forkToNewTab: false })
    expect(applied).toEqual([true, false])
    await core.api.updateSettings({ diagnostics: true })
    expect(applied).toEqual([true, false, true])
    await core.shutdown()
  })

  it('works without a host that keeps diagnostics (tests, the agent host)', async () => {
    const { core } = await setup()
    expect(() => core.applySettings()).not.toThrow()
    await expect(core.api.saveDiagnostics()).rejects.toThrow('not available')
    await core.shutdown()
  })
})

describe('Save diagnostics', () => {
  const bundle = { kind: 'foreman-diagnostics', format: 1, events: [], crashDumps: [] } as unknown as DiagnosticsBundle

  it('asks where to save, with a dated default name, and writes the bundle there', async () => {
    const dir = await tempDir('foreman-diag-save-')
    const asked: { title: string; kind: string; defaultPath?: string }[] = []
    const { core } = await setup({
      diagnosticsBundle: async () => bundle,
      pickPath: async (options) => {
        asked.push(options)
        return path.join(dir, 'out.json')
      }
    })
    expect(await core.api.saveDiagnostics()).toBe(path.join(dir, 'out.json'))
    expect(asked).toHaveLength(1)
    expect(asked[0].kind).toBe('save')
    expect(asked[0].title).toBe('Save diagnostics')
    expect(asked[0].defaultPath).toMatch(/^foreman-diagnostics-\d{4}-\d{2}-\d{2}-\d{4}\.json$/)
    expect(JSON.parse(await readFile(path.join(dir, 'out.json'), 'utf8'))).toEqual(bundle)
    await core.shutdown()
  })

  it('writes nothing when the user cancels', async () => {
    let built = 0
    const { core } = await setup({
      diagnosticsBundle: async () => (built++, bundle),
      pickPath: async () => null
    })
    expect(await core.api.saveDiagnostics()).toBeNull()
    expect(built).toBe(0)
    await core.shutdown()
  })
})
