// A repository added while an organization is shown joins it (the Add menus say "Add a repository to <space>"); one that
// was already registered, opened again from Recents, keeps its space. The real store, with the bridge's calls recorded.
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'

let store: typeof import('../src/renderer/src/store')
const calls: [string, unknown[]][] = []
let addResult: { id: string } = { id: 'r-new' }
// Dropped folders, by path: several added at once.
const byPath: Record<string, { id: string }> = { '/code/a': { id: 'r-a' }, '/code/b': { id: 'r-b' }, '/code/old': { id: 'r-old' } }
const snapshot = {
  platform: 'darwin',
  settings: { agentPrefs: {}, loadouts: [] },
  repos: [{ id: 'r-old', name: 'old', rootPath: '/code/old', defaultBranch: 'main' }, { id: 'r-acme', name: 'acme', rootPath: '/code/acme', defaultBranch: 'main', spaceId: 'o1' }],
  workspaces: [],
  sessions: [],
  catalog: { agents: {} },
  agentKeys: {},
  organizations: [{ id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: '2026-11-05T00:00:00.000Z' }],
  recentRepos: [],
  homeDir: '/home/me'
}

beforeAll(async () => {
  const invoke = new Proxy({} as Record<string, unknown>, {
    get: (_, name: string) => async (...args: unknown[]) => {
      calls.push([name, args])
      if (name === 'getSnapshot') return snapshot
      if (name === 'pendingApprovals') return []
      if (name === 'addRepo') return byPath[args[0] as string] ?? addResult
      return undefined
    }
  })
  const onEvent = () => () => undefined
  const send = new Proxy({} as Record<string, unknown>, { get: () => () => undefined })
  vi.stubGlobal('window', { foreman: { invoke, send, onEvent }, addEventListener() {}, dispatchEvent() {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
  vi.stubGlobal('document', { hasFocus: () => true })
  store = await import('../src/renderer/src/store')
  await store.initStore()
})

beforeEach(() => {
  calls.length = 0
  store.setSpace(null, { home: false })
})

const moves = () => calls.filter(([name]) => name === 'moveRepoToSpace')

it('a new repository added while an organization is shown joins it', async () => {
  store.setSpace('o1', { home: false })
  addResult = { id: 'r-new' }
  await store.openRecentRepo('/code/fresh')
  expect(moves()).toEqual([['moveRepoToSpace', ['r-new', 'o1']]])
})

it('a repository already registered, opened again, keeps its space', async () => {
  store.setSpace('o1', { home: false })
  addResult = { id: 'r-old' }
  await store.openRecentRepo('/code/old')
  expect(moves()).toEqual([])
})

it('a repository already in the organization is not moved again', async () => {
  store.setSpace('o1', { home: false })
  addResult = { id: 'r-acme' }
  await store.openRecentRepo('/code/acme')
  expect(moves()).toEqual([])
})

it('in Personal, a new repository stays in Personal', async () => {
  store.setSpace(null, { home: false })
  addResult = { id: 'r-personal' }
  await store.openRecentRepo('/code/personal')
  expect(moves()).toEqual([])
})

it('several folders dropped while an organization is shown all join it, except one already registered', async () => {
  store.setSpace('o1', { home: false })
  await store.addDroppedRepositories(['/code/a', '/code/b', '/code/old'])
  expect(moves()).toEqual([
    ['moveRepoToSpace', ['r-a', 'o1']],
    ['moveRepoToSpace', ['r-b', 'o1']]
  ])
})

it('one folder dropped while an organization is shown joins it once', async () => {
  store.setSpace('o1', { home: false })
  await store.addDroppedRepositories(['/code/a'])
  expect(moves()).toEqual([['moveRepoToSpace', ['r-a', 'o1']]])
})
