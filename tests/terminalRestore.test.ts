import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Core, type Host } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { TerminalRestore } from '../src/main/terminalRestore'
import { TERMINAL_RESTORE_VERSION, type SavedTerminalTab } from '../src/shared/terminalTabs'
import { tempDir } from './helpers'

const tab = (over: Partial<SavedTerminalTab> = {}): SavedTerminalTab => ({ n: 1, cwd: '/w/kigali', savedAt: 1_700_000_000_000, scrollback: 'npm run dev', ...over })

async function setup(enabled = { on: true }) {
  const file = path.join(await tempDir('foreman-terms-'), 'terminals.json')
  return { file, enabled, make: () => new TerminalRestore(file, () => enabled.on) }
}

describe('TerminalRestore', () => {
  it('saves tabs and reads them back after a restart', async () => {
    const { file, make } = await setup()
    const first = make()
    first.load()
    expect(first.get('ws1')).toBeNull()
    first.put('ws1', [tab(), tab({ n: 2, name: 'dev server', zoom: 1.2 })])
    first.flush()
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(TERMINAL_RESTORE_VERSION)
    const second = make()
    second.load()
    expect(second.get('ws1')).toEqual([tab(), tab({ n: 2, name: 'dev server', zoom: 1.2 })])
  })

  it('keeps an empty list when every terminal was closed', async () => {
    const { make } = await setup()
    const store = make()
    store.put('ws1', [tab()])
    store.put('ws1', [])
    store.flush()
    const again = make()
    again.load()
    expect(again.get('ws1')).toEqual([])
  })

  it('forgets an archived workspace', async () => {
    const { make } = await setup()
    const store = make()
    store.put('ws1', [tab()])
    store.put('ws2', [tab()])
    store.forget('ws1')
    store.flush()
    const again = make()
    again.load()
    expect(again.get('ws1')).toBeNull()
    expect(again.get('ws2')).toHaveLength(1)
  })

  it('cleans what the renderer sends', async () => {
    const { make } = await setup()
    const store = make()
    store.put('ws1', [tab({ scrollback: '\x1b[31mred\x1b[0m\n\n' }), { n: 'bad' }, 'junk'])
    expect(store.get('ws1')).toEqual([tab({ scrollback: 'red' })])
    store.put('ws2', 'not a list')
    expect(store.get('ws2')).toEqual([])
  })

  it('ignores a file from another version and an unreadable one', async () => {
    const { file, make } = await setup()
    writeFileSync(file, JSON.stringify({ version: 99, workspaces: { ws1: [tab()] } }))
    const future = make()
    future.load()
    expect(future.get('ws1')).toBeNull()
    writeFileSync(file, '{ not json')
    const broken = make()
    broken.load()
    expect(broken.get('ws1')).toBeNull()
  })

  it('with restore off: saves nothing, restores nothing, and deletes the file', async () => {
    const { file, enabled, make } = await setup()
    const store = make()
    store.put('ws1', [tab()])
    store.flush()
    expect(existsSync(file)).toBe(true)
    enabled.on = false
    store.clear()
    expect(existsSync(file)).toBe(false)
    store.put('ws1', [tab()])
    store.flush()
    expect(existsSync(file)).toBe(false)
    expect(store.get('ws1')).toBeNull()
    // An earlier run's file is deleted at startup while the preference is off.
    enabled.on = true
    const old = make()
    old.put('ws1', [tab()])
    old.flush()
    enabled.on = false
    make().load()
    expect(existsSync(file)).toBe(false)
  })
})

async function core() {
  const dir = await tempDir('foreman-terms-core-')
  const store = new Store(dir)
  await store.load()
  store.state.repos.push({ id: 'repo', name: 'app', rootPath: dir, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: '' })
  store.state.workspaces.push({ id: 'ws', repoId: 'repo', name: 'kigali', branch: 'feature', baseBranch: 'main', path: dir, portBase: 50030, state: 'ready', createdAt: '' })
  store.state.workspaces.push({ id: 'old', repoId: 'repo', name: 'lisbon', branch: 'old', baseBranch: 'main', path: dir, portBase: 50040, state: 'archived', createdAt: '' })
  const host: Host = {
    broadcast() {},
    applyTheme() {},
    setBadge() {},
    setZoom() {},
    keepAwake() {},
    pickDirectory: async () => null,
    pickFiles: async () => [],
    pickPath: async () => null,
    openPath: async () => {},
    openExternal: async () => {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }),
    cliShim: () => ''
  }
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() })
  return { core: new Core(store, secrets, host), dir, file: path.join(dir, 'terminals.json') }
}

describe('Core: terminal restore', () => {
  it('saves a workspace’s tabs with its folder, and gives them back', async () => {
    const { core: c, dir } = await core()
    expect(await c.api.savedTerminals('ws')).toBeNull()
    c.signals.saveTerminals('ws', [{ n: 1, name: 'dev server', savedAt: 5, scrollback: 'hi' }])
    expect(await c.api.savedTerminals('ws')).toEqual([{ n: 1, name: 'dev server', cwd: dir, savedAt: 5, scrollback: 'hi' }])
  })

  it('ignores archived and unknown workspaces', async () => {
    const { core: c } = await core()
    c.signals.saveTerminals('old', [{ n: 1, savedAt: 5, scrollback: 'hi' }])
    c.signals.saveTerminals('nope', [{ n: 1, savedAt: 5, scrollback: 'hi' }])
    expect(await c.api.savedTerminals('old')).toBeNull()
    expect(await c.api.savedTerminals('nope')).toBeNull()
  })

  it('is on by default; turning it off deletes the saved output', async () => {
    const { core: c, file } = await core()
    expect(c.snapshot().settings.restoreTerminals).toBe(true)
    expect(c.snapshot().settings.terminalCopyOnSelect).toBe(false)
    c.signals.saveTerminals('ws', [{ n: 1, savedAt: 5, scrollback: 'secret=1' }])
    c.terminals.flush()
    expect(readFileSync(file, 'utf8')).toContain('secret=1')
    await c.api.updateSettings({ restoreTerminals: false })
    expect(existsSync(file)).toBe(false)
    expect(await c.api.savedTerminals('ws')).toBeNull()
  })
})
