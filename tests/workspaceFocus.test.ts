import { afterEach, expect, it, vi } from 'vitest'

// O3: a workspace's terminal or Flow run in its middle, the chat beside it. Kept per workspace, across restarts too
// (localStorage), until put back; one of the two at a time.

async function loadStore(saved: Record<string, string>) {
  vi.resetModules()
  const storage = new Map(Object.entries(saved))
  // Selecting a workspace tells main its unread count; any signal is a no-op here.
  vi.stubGlobal('window', { foreman: { invoke: {}, send: new Proxy({}, { get: () => () => undefined }), onEvent() {} }, addEventListener() {}, dispatchEvent() {} })
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) })
  vi.stubGlobal('document', { hasFocus: () => true })
  return { store: await import('../src/renderer/src/store'), storage }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('keeps each workspace’s choice and saves it, one of the two at a time', async () => {
  const { store, storage } = await loadStore({})
  expect(store.getState().workspaceFocus).toEqual({})
  store.toggleWorkspaceFocus('w1', 'flow')
  store.toggleTerminalFullscreen('w2')
  expect(store.getState().workspaceFocus).toEqual({ w1: 'flow', w2: 'terminal' })
  // The terminal in the middle sends the Flow back.
  store.toggleTerminalFullscreen('w1')
  expect(store.getState().workspaceFocus).toEqual({ w1: 'terminal', w2: 'terminal' })
  // Toggling the Flow off while the terminal is there leaves the terminal.
  store.toggleWorkspaceFocus('w1', 'flow', false)
  expect(store.getState().workspaceFocus.w1).toBe('terminal')
  store.toggleTerminalFullscreen('w1')
  expect(store.getState().workspaceFocus).toEqual({ w2: 'terminal' })
  expect(JSON.parse(storage.get('switchyard:workspaceFocus')!)).toEqual({ w2: 'terminal' })
})

it('reads the saved choices at start, and ignores anything it doesn’t know', async () => {
  const { store } = await loadStore({ 'switchyard:workspaceFocus': JSON.stringify({ w1: 'flow', w2: 'terminal', w3: 'browser', w4: 7 }) })
  expect(store.getState().workspaceFocus).toEqual({ w1: 'flow', w2: 'terminal' })
  expect((await loadStore({ 'switchyard:workspaceFocus': '"flow"' })).store.getState().workspaceFocus).toEqual({})
})

it('hiding the terminal panel puts the shown workspace’s terminal back, and only that', async () => {
  const { store } = await loadStore({ 'switchyard:workspaceFocus': JSON.stringify({ w1: 'terminal', w2: 'terminal', w3: 'flow' }) })
  store.selectWorkspace('w1')
  store.showBottomPanel(false)
  expect(store.getState().workspaceFocus).toEqual({ w2: 'terminal', w3: 'flow' })
  store.selectWorkspace('w3')
  store.showBottomPanel(false)
  expect(store.getState().workspaceFocus).toEqual({ w2: 'terminal', w3: 'flow' })
})
