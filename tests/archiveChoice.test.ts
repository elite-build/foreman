import { afterEach, expect, it, vi } from 'vitest'

// The merged header's archive button runs whichever archive was used last, kept across restarts in localStorage.

async function loadStore(saved: Record<string, string>) {
  vi.resetModules()
  const storage = new Map(Object.entries(saved))
  vi.stubGlobal('window', { foreman: { invoke: {}, send: {}, onEvent() {} }, addEventListener() {}, dispatchEvent() {} })
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) })
  vi.stubGlobal('document', { hasFocus: () => true })
  return { store: await import('../src/renderer/src/store'), storage }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('starts with no choice, then remembers each archive’s and saves it', async () => {
  const { store, storage } = await loadStore({})
  expect(store.getState().archiveChoice).toBeNull()
  store.rememberArchiveChoice(true)
  expect(store.getState().archiveChoice).toBe('delete-branch')
  expect(storage.get('switchyard:archiveChoice')).toBe('"delete-branch"')
  store.rememberArchiveChoice(false)
  expect(store.getState().archiveChoice).toBe('archive')
  expect(storage.get('switchyard:archiveChoice')).toBe('"archive"')
})

it('reads the saved choice at start, and ignores anything it doesn’t know', async () => {
  expect((await loadStore({ 'switchyard:archiveChoice': '"delete-branch"' })).store.getState().archiveChoice).toBe('delete-branch')
  expect((await loadStore({ 'switchyard:archiveChoice': '"archive"' })).store.getState().archiveChoice).toBe('archive')
  expect((await loadStore({ 'switchyard:archiveChoice': '"nuke"' })).store.getState().archiveChoice).toBeNull()
})
