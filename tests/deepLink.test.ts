// #3 foreman:// links: parsing, routing (missing, closed, archived) and that opening one never acts.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { linksIn, parseLink, routeLink, workspaceLink } from '../src/shared/deepLink'
import type { AppSnapshot, Session, Workspace } from '../src/shared/types'

const ws = (id: string, patch: Partial<Workspace> = {}): Workspace =>
  ({ id, repoId: 'r1', name: 'lisbon', branch: 'b', baseBranch: 'main', path: '/x', portBase: 1, state: 'ready', createdAt: '', ...patch }) as Workspace
const session = (id: string, workspaceId: string, patch: Partial<Session> = {}): Session =>
  ({ id, workspaceId, agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: '', ...patch }) as Session

const snapshot = {
  repos: [
    { id: 'r1', name: 'ledger-api' },
    { id: 'r2', name: 'atlas web' }
  ],
  workspaces: [ws('w1'), ws('w2', { name: 'quito', repoId: 'r2' }), ws('old', { name: 'oslo', state: 'archived', archivedAt: '2026-10-01T00:00:00Z' })],
  sessions: [session('s1', 'w1'), session('s-closed', 'w1', { closedAt: '2026-10-20T00:00:00Z' }), session('s2', 'w1'), session('s3', 'old')]
} as unknown as AppSnapshot

describe('foreman:// links', () => {
  it('builds and parses workspace links, names encoded', () => {
    expect(workspaceLink('ledger-api', 'lisbon', 1)).toBe('foreman://workspace/ledger-api/lisbon?tab=1')
    expect(workspaceLink('atlas web', 'quito')).toBe('foreman://workspace/atlas%20web/quito')
    expect(parseLink(workspaceLink('atlas web', 'qu/ito', 3))).toEqual({ kind: 'workspace', repo: 'atlas web', workspace: 'qu/ito', tab: 3 })
    expect(parseLink('foreman://home')).toEqual({ kind: 'home' })
    expect(parseLink('FOREMAN://workspace/a/b')).toEqual({ kind: 'workspace', repo: 'a', workspace: 'b' })
  })

  it('rejects anything else', () => {
    for (const url of ['https://example.com', 'foreman://', 'foreman://workspace/a', 'foreman://workspace/a/b/c', 'foreman://send/a/b', 'foreman://workspace/%E0%A4%A/b']) expect(parseLink(url)).toBeNull()
    // A tab that isn't a small positive number is ignored, not guessed.
    expect(parseLink('foreman://workspace/a/b?tab=0')).toEqual({ kind: 'workspace', repo: 'a', workspace: 'b' })
    expect(parseLink('foreman://workspace/a/b?tab=two')).toEqual({ kind: 'workspace', repo: 'a', workspace: 'b' })
  })

  it('routes to the workspace and the Nth open tab (closed tabs are not counted)', () => {
    expect(routeLink('foreman://workspace/ledger-api/lisbon?tab=2', snapshot)).toEqual({ kind: 'workspace', workspaceId: 'w1', sessionId: 's2' })
    expect(routeLink('foreman://workspace/Ledger-API/Lisbon', snapshot)).toEqual({ kind: 'workspace', workspaceId: 'w1' })
    expect(routeLink('foreman://workspace/atlas%20web/quito', snapshot)).toEqual({ kind: 'workspace', workspaceId: 'w2' })
  })

  it('handles missing, closed and archived targets the same way every time', () => {
    expect(routeLink('foreman://workspace/nope/lisbon', snapshot)).toEqual({ kind: 'home', notice: 'missing-repo' })
    expect(routeLink('foreman://workspace/ledger-api/nope', snapshot)).toEqual({ kind: 'home', notice: 'missing-workspace' })
    // The repo of the name holds it, not another repo's workspace of the same name.
    expect(routeLink('foreman://workspace/atlas%20web/lisbon', snapshot)).toEqual({ kind: 'home', notice: 'missing-workspace' })
    expect(routeLink('foreman://workspace/ledger-api/lisbon?tab=9', snapshot)).toEqual({ kind: 'workspace', workspaceId: 'w1', notice: 'tab-missing' })
    expect(routeLink('https://evil.example', snapshot)).toEqual({ kind: 'home', notice: 'invalid' })
    // #13: archived opens read-only; nothing is restored.
    expect(routeLink('foreman://workspace/ledger-api/oslo?tab=1', snapshot)).toEqual({ kind: 'archived', workspaceId: 'old', sessionId: 's3' })
    // A live workspace wins over an archived one with the same name.
    const both = { ...snapshot, workspaces: [...snapshot.workspaces, ws('new-oslo', { name: 'oslo' })] }
    expect(routeLink('foreman://workspace/ledger-api/oslo', both)).toEqual({ kind: 'workspace', workspaceId: 'new-oslo' })
  })

  it('ignores anything a link might ask beyond where to go', () => {
    const plain = routeLink('foreman://workspace/ledger-api/lisbon?tab=1', snapshot)
    expect(routeLink('foreman://workspace/ledger-api/lisbon?tab=1&send=hello&approve=1&run=rm', snapshot)).toEqual(plain)
  })

  it('finds links on a command line (Windows second instance and cold start)', () => {
    expect(linksIn(['foreman.exe', '--flag', 'C:\\repo', 'foreman://workspace/a/b?tab=1'])).toEqual(['foreman://workspace/a/b?tab=1'])
  })
})

describe('opening a link in the window', () => {
  const calls: string[] = []
  const invoke = new Proxy(
    {},
    {
      get: (_, name: string) =>
        async () => {
          calls.push(name)
          if (name === 'getSnapshot') return { ...snapshot, catalog: { agents: {}, outputStyles: [] }, settings: { language: 'en' } }
          if (name === 'pendingApprovals') return []
          if (name === 'attentionHistory') return { events: [] }
          return undefined
        }
    }
  )
  let store: typeof import('../src/renderer/src/store')

  beforeAll(async () => {
    vi.stubGlobal('window', { foreman: { invoke, send: { setUnread() {} }, onEvent() {} }, confirm: () => true, addEventListener() {}, dispatchEvent() {} })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
    vi.stubGlobal('document', { hasFocus: () => true })
    store = await import('../src/renderer/src/store')
    await store.initStore()
  })
  afterEach(() => {
    calls.length = 0
  })

  it('only navigates: no call reaches main, whatever the link', async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    calls.length = 0
    store.openLink('foreman://workspace/ledger-api/lisbon?tab=2&send=hi')
    expect(store.getState()).toMatchObject({ selectedWorkspaceId: 'w1', activeSession: { w1: 's2' } })
    store.openLink('foreman://workspace/ledger-api/oslo')
    expect(store.getState().selectedWorkspaceId).toBe('old')
    store.openLink('foreman://workspace/ledger-api/gone')
    expect(store.getState().selectedWorkspaceId).toBeNull()
    expect(store.getState().toast?.text).toMatch(/workspace isn’t in Foreman/)
    expect(calls).toEqual([])
  })
})
