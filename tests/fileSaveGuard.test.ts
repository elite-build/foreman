// The file editor saves what it opened or last saved: with that text (`expected`), main refuses to overwrite a file the agent
// has changed since, and hands back what is on disk now so the editor can show it.
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import type { Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

afterEach(() => vi.restoreAllMocks())

async function setup() {
  const dir = await tempDir('foreman-save-core-')
  const store = new Store(dir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const core = new Core(store, secrets, {
    broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
  })
  const worktree = await tempDir('foreman-save-ws-')
  const ws: Workspace = { id: 'ws', repoId: 'repo', name: 'ws', branch: 'b', baseBranch: 'main', path: worktree, portBase: 50050, state: 'ready', createdAt: new Date().toISOString() }
  store.state.workspaces.push(ws)
  const file = path.join(worktree, 'notes.md')
  await writeFile(file, 'draft one\n')
  return { core, file }
}

describe('saving a file from the editor', () => {
  it('writes when the file still has the text the editor opened', async () => {
    const { core, file } = await setup()
    expect(await core.api.writeFile('ws', 'notes.md', 'draft two\n', 'draft one\n')).toBeNull()
    expect(await readFile(file, 'utf8')).toBe('draft two\n')
  })

  it('refuses to overwrite an edit the agent made after the file was opened, and returns what is there now', async () => {
    const { core, file } = await setup()
    await writeFile(file, 'draft one\nagent line\n')
    expect(await core.api.writeFile('ws', 'notes.md', 'draft one\nuser line\n', 'draft one\n')).toEqual({ current: 'draft one\nagent line\n' })
    expect(await readFile(file, 'utf8')).toBe('draft one\nagent line\n')
  })

  it('refuses when the file was deleted since, and returns an empty text', async () => {
    const { core, file } = await setup()
    await rm(file)
    expect(await core.api.writeFile('ws', 'notes.md', 'draft two\n', 'draft one\n')).toEqual({ current: '' })
    expect(existsSync(file)).toBe(false)
  })

  it('compares the text exactly, so a line-ending change counts as a change', async () => {
    const { core, file } = await setup()
    await writeFile(file, 'draft one\r\n')
    expect(await core.api.writeFile('ws', 'notes.md', 'draft two\n', 'draft one\n')).toEqual({ current: 'draft one\r\n' })
    expect(await readFile(file, 'utf8')).toBe('draft one\r\n')
  })

  it('writes without an expected text, as before, even when the file has changed', async () => {
    const { core, file } = await setup()
    await writeFile(file, 'agent line\n')
    expect(await core.api.writeFile('ws', 'notes.md', 'forced\n')).toBeNull()
    expect(await readFile(file, 'utf8')).toBe('forced\n')
  })
})
