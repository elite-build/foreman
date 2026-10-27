import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import type { WaitThen } from '../src/main/stopSafely'
import { Store } from '../src/main/store'
import type { UpdateInstaller } from '../src/main/updates'
import type { MainEvent } from '../src/shared/types'
import { tempDir } from './helpers'

// The core's side of updates: Settings → Updates are checked as they're saved, the snapshot carries the view, and the
// card's Restart installs at once or waits for the running turns (holding new ones) before it does.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function setup() {
  const dir = await tempDir('foreman-update-core-')
  const store = new Store(dir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  store.state.settings.updateMode = 'download'
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v0.2.0', draft: false, prerelease: false, body: 'Notes' }), { status: 200 })))
  const installer = {
    unavailable: vi.fn(async () => null),
    download: vi.fn(async () => {}),
    cancel: vi.fn(),
    installOnQuit: vi.fn()
  } satisfies UpdateInstaller
  const restartToUpdate = vi.fn()
  const events: MainEvent[] = []
  const core = new Core(store, secrets, {
    broadcast: (event: MainEvent) => events.push(event), applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => '',
    appInfo: () => ({ version: '0.1.0', packaged: true, appPath: dir }),
    updateInstaller: installer,
    restartToUpdate
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { core, store, installer, restartToUpdate }
}

describe('updates in the core', () => {
  it('a found release downloads in the background and shows in the snapshot', async () => {
    const { core, installer } = await setup()
    await core.api.checkForUpdates()
    await vi.waitFor(() => expect(core.snapshot().update?.notice?.phase).toEqual({ state: 'ready', onQuit: false }))
    expect(installer.download).toHaveBeenCalledWith('0.2.0', false, expect.any(Function))
    expect(await core.api.releaseNotes('0.2.0')).toMatchObject({ notes: 'Notes' })
  })

  it('Restart with nothing running installs at once; before the download it refuses', async () => {
    const { core, installer, restartToUpdate } = await setup()
    await expect(core.api.restartToUpdate(true)).rejects.toThrow('The update hasn’t finished downloading.')
    installer.download.mockImplementation(async () => {})
    await core.api.checkForUpdates()
    await vi.waitFor(() => expect(core.snapshot().update?.notice?.phase.state).toBe('ready'))
    await core.api.restartToUpdate(true)
    expect(restartToUpdate).toHaveBeenCalledTimes(1)
  })

  it('Restart when agents finish waits through Stop safely, restarts once they end, and Cancel goes back to ready', async () => {
    const { core, restartToUpdate } = await setup()
    await core.api.checkForUpdates()
    await vi.waitFor(() => expect(core.snapshot().update?.notice?.phase.state).toBe('ready'))
    vi.spyOn(core.stopSafely, 'needsAsking').mockReturnValue(true)
    let waited: WaitThen | undefined
    const wait = vi.spyOn(core.stopSafely, 'quitWhenFinished').mockImplementation((instead) => void (waited = instead))
    const cancel = vi.spyOn(core.stopSafely, 'cancelQuit').mockImplementation(() => waited?.cancelled?.())

    await core.api.restartToUpdate(true)
    expect(wait).toHaveBeenCalledTimes(1)
    expect(waited?.reason).toMatch(/restarts to install an update/)
    expect(core.snapshot().update?.notice?.phase).toEqual({ state: 'waiting' })
    expect(restartToUpdate).not.toHaveBeenCalled()

    await core.api.cancelUpdateRestart()
    expect(cancel).toHaveBeenCalled()
    expect(core.snapshot().update?.notice?.phase).toEqual({ state: 'ready', onQuit: false })

    await core.api.restartToUpdate(true)
    expect(waited!.then()).toBe(true)
    expect(restartToUpdate).toHaveBeenCalledTimes(1)

    // Restart now doesn't wait.
    await core.api.restartToUpdate(false)
    expect(restartToUpdate).toHaveBeenCalledTimes(2)
  })

  it('checks the update settings as they are saved', async () => {
    const { core } = await setup()
    await expect(core.api.updateSettings({ updateMode: 'always' as never })).rejects.toThrow('Unknown update setting')
    await expect(core.api.updateSettings({ updateInterval: 'weekly' as never })).rejects.toThrow('Unknown update schedule')
    await expect(core.api.updateSettings({ updateChannel: 'nightly' as never })).rejects.toThrow('Unknown release channel')
    expect((await core.api.updateSettings({ updateMode: 'quit', updateInterval: 'daily', updateChannel: 'beta' })).updateChannel).toBe('beta')
  })
})
