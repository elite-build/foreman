import { beforeAll, expect, it, vi } from 'vitest'

let store: typeof import('../src/renderer/src/store')
beforeAll(async () => {
  vi.stubGlobal('window', { foreman: { invoke: {}, send: {}, onEvent() {} }, addEventListener() {}, dispatchEvent() {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
  vi.stubGlobal('document', { hasFocus: () => true })
  store = await import('../src/renderer/src/store')
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
