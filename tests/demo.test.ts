import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { claimDemoFolder, demoDataDir, seedDemo } from '../src/main/demo'
import { seedScreens } from '../src/main/screenshots'
import { Store } from '../src/main/store'
import { tempDir } from './helpers'

// screenshots.ts reads nativeTheme only while it captures; seeding needs none of Electron.
vi.mock('electron', () => ({ nativeTheme: {} }))

const marker = (root: string) => readFileSync(path.join(root, '.foreman-demo'), 'utf8').trim()

describe('demo folder', () => {
  it('claims a new folder, then keeps it once seeded', async () => {
    const root = path.join(await tempDir('foreman-demo-'), 'demo')
    expect(claimDemoFolder(root, false)).toBe('seed')
    expect(marker(root)).toBe('seeding')
    await seedDemo(root, async (_root, dataDir) => mkdirSync(dataDir, { recursive: true }))
    expect(marker(root)).toBe('ready')
    writeFileSync(path.join(demoDataDir(root), 'clicked.txt'), 'what the user did')
    expect(claimDemoFolder(root, false)).toBe('kept')
    expect(existsSync(path.join(demoDataDir(root), 'clicked.txt'))).toBe(true)
  })

  it('empties the folder on a reset, and after a seeding that never finished', async () => {
    const root = await tempDir('foreman-demo-')
    claimDemoFolder(root, false)
    await seedDemo(root, async (_root, dataDir) => mkdirSync(dataDir, { recursive: true }))
    writeFileSync(path.join(root, 'leftover.txt'), 'x')
    expect(claimDemoFolder(root, true)).toBe('seed')
    expect(existsSync(path.join(root, 'leftover.txt'))).toBe(false)
    // Still "seeding": the last launch stopped part way, so the folder starts again.
    writeFileSync(path.join(root, 'half.txt'), 'x')
    expect(claimDemoFolder(root, false)).toBe('seed')
    expect(existsSync(path.join(root, 'half.txt'))).toBe(false)
  })

  it('refuses a folder with files that is not a demo, and deletes nothing', async () => {
    const root = await tempDir('foreman-demo-')
    writeFileSync(path.join(root, 'notes.txt'), 'mine')
    expect(() => claimDemoFolder(root, true)).toThrow(/not a Foreman demo folder/)
    expect(readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe('mine')
  })

  it('seeds the screenshot fixture with the demo settings', async () => {
    const root = path.join(await tempDir('foreman-demo-'), 'demo')
    claimDemoFolder(root, false)
    await seedDemo(root, (r, dataDir) => seedScreens(r, dataDir, { flows: true, terminalShell: 'auto' }))
    const store = new Store(demoDataDir(root))
    await store.load()
    try {
      expect(store.state.settings.flows).toBe(true)
      expect(store.state.settings.terminalShell).toBe('auto')
      expect(store.state.repos.map((r) => r.name)).toEqual(['atlas', 'beacon'])
      expect(store.state.workspaces.map((w) => w.name)).toEqual(['lisbon', 'osaka', 'quito'])
      expect(store.state.flowRuns?.length).toBeGreaterThan(0)
      for (const w of store.state.workspaces) expect(w.path && existsSync(w.path)).toBe(true)
    } finally {
      store.close()
    }
  })
})
