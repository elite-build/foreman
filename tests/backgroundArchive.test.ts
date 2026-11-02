import { beforeAll, expect, it, vi } from 'vitest'

let store: typeof import('../src/renderer/src/store')
let emit: (event: unknown) => void
const snapshot = { platform: 'darwin', settings: { agentPrefs: {}, loadouts: [] }, repos: [], workspaces: [], sessions: [], catalog: { agents: {} }, agentKeys: {} }
beforeAll(async () => {
  const invoke = new Proxy({} as Record<string, unknown>, {
    get: (_, name: string) => async () => (name === 'getSnapshot' ? snapshot : name === 'pendingApprovals' ? [] : undefined)
  })
  const onEvent = (handler: (event: unknown) => void) => {
    emit = handler
    return () => undefined
  }
  vi.stubGlobal('window', { foreman: { invoke, send: {}, onEvent }, addEventListener() {}, dispatchEvent() {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
  vi.stubGlobal('document', { hasFocus: () => true })
  store = await import('../src/renderer/src/store')
  await store.initStore()
})

it('keeps background jobs when dismissing details and preserves another dialog on completion', () => {
  store.openArchiveDialog('first')
  store.backgroundArchive('first')
  expect(store.getState().archiveTarget).toBeNull()
  store.openArchiveDialog('first')
  store.openArchiveDialog(null)
  expect(store.getState().backgroundArchives).toEqual(['first'])

  store.backgroundArchive('second')
  store.openArchiveDialog('second')
  store.finishBackgroundArchive('first')
  expect(store.getState().archiveTarget).toBe('second')
  expect(store.getState().backgroundArchives).toEqual(['second'])
  store.finishBackgroundArchive('second')
  expect(store.getState().archiveTarget).toBeNull()
  expect(store.getState().backgroundArchives).toEqual([])
})

it('tracks each background archive for its sidebar row and header: the step it is on, stopped on a failure, gone when done', () => {
  const progress = (workspaceId: string, step: string, status: string) => emit({ type: 'archive-progress', workspaceId, progress: { step, status } })
  // Progress for a workspace with no archive in the background (or before it starts) is ignored.
  progress('w1', 'checkpoint', 'running')
  expect(store.getState().archiveRuns).toEqual({})

  store.backgroundArchive('w1')
  expect(store.getState().archiveRuns.w1).toEqual({ stopped: false, step: null })
  progress('w1', 'checkpoint', 'running')
  progress('w1', 'checkpoint', 'done')
  expect(store.getState().archiveRuns.w1.step).toBe('checkpoint')
  progress('w1', 'script', 'running')
  expect(store.getState().archiveRuns.w1.step).toBe('script')

  store.stopBackgroundArchive('w1')
  expect(store.getState().archiveRuns.w1).toEqual({ stopped: true, step: 'script' })
  // A stopped archive keeps the step it stopped on.
  progress('w1', 'remove', 'running')
  expect(store.getState().archiveRuns.w1.step).toBe('script')

  // Retry starts it again.
  store.backgroundArchive('w1')
  expect(store.getState().archiveRuns.w1).toEqual({ stopped: false, step: null })
  store.finishBackgroundArchive('w1')
  expect(store.getState().archiveRuns).toEqual({})
  expect(store.getState().backgroundArchives).toEqual([])
})
