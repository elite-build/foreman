// The window tells its page when it is minimized or hidden and shown again (backgroundThrottling is off, so the page can't
// tell by itself), and the tray and menu read the settings without building a whole snapshot.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { VISIBILITY_EVENTS, WindowVisibility, windowVisible } from '../src/main/windowVisibility'
import { tempDir } from './helpers'

function fakeWindow() {
  const win = { visible: true, minimized: false, destroyed: false, isVisible: () => win.visible, isMinimized: () => win.minimized, isDestroyed: () => win.destroyed }
  return win
}

describe('window visibility', () => {
  it('sends a change once, counts a minimized window (still "visible" on Windows) as hidden, and tells a page that loaded', () => {
    const win = fakeWindow()
    const sent: boolean[] = []
    const visibility = new WindowVisibility(win, (visible) => sent.push(visible))
    visibility.loaded()
    expect(sent).toEqual([true])
    // Focus and other events with nothing changed send nothing.
    visibility.update()
    expect(sent).toEqual([true])
    win.minimized = true
    visibility.update()
    visibility.update()
    expect(sent).toEqual([true, false])
    win.minimized = false
    visibility.update()
    win.visible = false
    visibility.update()
    expect(sent).toEqual([true, false, true, false])
    // A reload while hidden: the new page hears it is hidden.
    visibility.loaded()
    expect(sent).toEqual([true, false, true, false, false])
    // A closed window says nothing.
    win.destroyed = true
    win.visible = true
    visibility.update()
    expect(sent).toHaveLength(5)
  })

  it('listens for restoring a maximized window (maximize, not restore) and for focus', () => {
    expect(VISIBILITY_EVENTS).toEqual(expect.arrayContaining(['show', 'hide', 'minimize', 'restore', 'maximize', 'focus']))
    expect(windowVisible({ isVisible: () => true, isMinimized: () => true, isDestroyed: () => false })).toBe(false)
  })
})

describe('the tray and menu', () => {
  afterEach(() => vi.restoreAllMocks())

  it('read the settings from the store, never from a snapshot', async () => {
    const dir = await tempDir('foreman-tray-settings-')
    const store = new Store(dir)
    await store.load()
    vi.spyOn(store, 'save').mockImplementation(() => {})
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    const core = new Core(store, secrets, {
      broadcast: () => undefined, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
      openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
      metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
    })
    core.attention.stop()
    const snapshot = vi.spyOn(core, 'snapshot')
    await core.api.updateSettings({ mobileEnabled: true })
    snapshot.mockClear()
    expect(core.settings().mobileEnabled).toBe(true)
    expect(core.settings()).toBe(store.state.settings)
    expect(snapshot).not.toHaveBeenCalled()

    // index.ts can't be loaded outside Electron: its tray and menu functions are read instead.
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    for (const name of ['phoneTray', 'drawTray', 'installMenu']) {
      const start = source.indexOf(`function ${name}(`)
      expect(start).toBeGreaterThan(-1)
      const rest = source.slice(start)
      const body = rest.slice(0, rest.search(/\r?\n\}\r?\n/))
      expect(body, name).not.toMatch(/snapshot\(/)
      expect(body, name).toMatch(/core\??\.settings\(\)/)
    }
  })
})
