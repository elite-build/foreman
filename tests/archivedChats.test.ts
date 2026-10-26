// #13 Read archived chats: an archived workspace opens read-only through the history-only path,
// search routes archived results there, and Restore stays a separate, working step.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { archivedFacts, archivedFolder, archivedTabs, hitRoute, workspaceSurfaces } from '../src/renderer/src/archivedView'
import { chatsOnly, isHistoryOnly, sessionReadOnly } from '../src/shared/workspacePath'
import { createT } from '../src/shared/i18n'
import type { AppSnapshot, ChatHit, NoteHit, Session, Workspace } from '../src/shared/types'

const ws = (patch: Partial<Workspace> = {}): Workspace =>
  ({ id: 'w1', repoId: 'r1', name: 'dakar', branch: 'yatin/repo-mcp-consent', baseBranch: 'main', path: '/wt/dakar', portBase: 1, state: 'ready', createdAt: '2026-10-01T10:00:00Z', ...patch }) as Workspace

const session = (id: string, patch: Partial<Session> = {}): Session =>
  ({ id, workspaceId: 'w1', agent: 'claude', model: 'opus', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: '2026-10-01T10:00:00Z', ...patch }) as Session

const hit = (patch: Partial<ChatHit> = {}): ChatHit => ({
  sessionId: 's1',
  itemId: 'i1',
  workspaceId: 'w1',
  workspaceName: 'dakar',
  repoName: 'foreman',
  tabTitle: 'Repo MCP consent',
  agent: 'claude',
  model: 'opus',
  kind: 'assistant',
  snippet: 'fingerprint',
  at: '2026-10-12T16:00:00Z',
  archived: false,
  closed: false,
  cleared: false,
  ...patch
})

describe('the archived view reuses the history-only path', () => {
  it('an archived workspace shows only its chats: no worktree, setup log, terminal or export', () => {
    expect(workspaceSurfaces(ws({ state: 'archived' }))).toEqual({ worktree: false, chats: true, archived: true, setupLog: false, terminal: false, exportable: false, local: false, cloud: false })
  })

  it('history-only and live workspaces keep what they had', () => {
    expect(workspaceSurfaces(ws({ state: 'history', path: undefined }))).toMatchObject({ worktree: false, chats: true, archived: false, setupLog: true, terminal: true })
    expect(workspaceSurfaces(ws())).toMatchObject({ worktree: true, chats: true, archived: false })
    expect(workspaceSurfaces(ws({ state: 'creating' }))).toMatchObject({ worktree: false, chats: false })
    expect(workspaceSurfaces(ws({ state: 'error' }))).toMatchObject({ worktree: false, chats: false })
  })

  it('archived tabs are read-only, like history-only ones, without changing what Restore treats as history only', () => {
    const archived = ws({ state: 'archived' })
    expect(chatsOnly(archived)).toBe(true)
    expect(sessionReadOnly(archived, {})).toBe(true)
    // unarchiveWorkspace relies on this staying false for an archived workspace that had a worktree.
    expect(isHistoryOnly(archived)).toBe(false)
    expect(sessionReadOnly(ws(), {})).toBe(false)
  })

  it('shows the open tabs plus a closed one being read, and nothing else', () => {
    const sessions = [session('s1'), session('s2', { closedAt: '2026-10-02T00:00:00Z' }), session('s3', { closedAt: '2026-10-02T00:00:00Z' }), session('x', { workspaceId: 'w2' })]
    expect(archivedTabs(sessions, 'w1').map((s) => s.id)).toEqual(['s1'])
    expect(archivedTabs(sessions, 'w1', 's2').map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('the side panel says what is known without a worktree, and unknown when it is not', () => {
    const archived = ws({ state: 'archived', archivedAt: '2026-10-12T16:40:00Z', prInfo: { number: 318, state: 'MERGED' } })
    const sessions = [
      session('s1', { lastTurn: { outcome: 'completed', endedAt: '2026-10-12T15:00:00Z' } }),
      session('s2', { lastTurn: { outcome: 'completed', endedAt: '2026-10-11T09:00:00Z' } }),
      session('s3', { closedAt: '2026-10-05T00:00:00Z' })
    ]
    expect(archivedFacts(archived, sessions)).toEqual({
      archivedAt: '2026-10-12T16:40:00Z',
      branch: 'yatin/repo-mcp-consent',
      pr: { number: 318, state: 'MERGED' },
      openTabs: 2,
      closedTabs: 1,
      lastActivity: '2026-10-12T15:00:00Z',
      folder: 'removed'
    })
    const bare = archivedFacts(ws({ state: 'archived' }), [session('s1')])
    expect(bare.pr).toBeUndefined()
    expect(bare.lastActivity).toBeUndefined()
  })

  it('says what happened to the folder the way restore will treat it', () => {
    expect(archivedFolder(ws())).toBe('removed')
    expect(archivedFolder(ws({ adopted: true }))).toBe('left')
    expect(archivedFolder(ws({ path: undefined }))).toBe('none')
  })

  it('has English and Spanish for every string', () => {
    const en = createT('en')
    const es = createT('es')
    expect(en('archivedView.banner.title')).toBe('Archived · read only · no worktree')
    expect(en('archivedView.restore')).toBe('Restore workspace…')
    expect(en('archivedView.search.tag')).toBe('opens read-only')
    expect(en('archivedView.panel.tabs', { count: 2 })).toBe('2 tabs')
    expect(es('archivedView.list.read')).toBe('Leer chats')
    expect(es('archivedView.panel.closedTabs', { count: 1 })).toBe('1 pestaña cerrada')
  })
})

describe('search routing', () => {
  it('archived results open read-only, whether or not their tab was closed; live closed tabs still reopen', () => {
    expect(hitRoute(hit({ archived: true }))).toBe('read-only')
    expect(hitRoute(hit({ archived: true, closed: true }))).toBe('read-only')
    expect(hitRoute(hit({ closed: true }))).toBe('reopen')
    expect(hitRoute(hit())).toBe('open')
    expect(hitRoute({ archived: true } as NoteHit)).toBe('read-only')
  })
})

// The renderer store against a bridge stub that records every call into main.
describe('opening, searching and restoring through the store', () => {
  const calls: { name: string; args: unknown[] }[] = []
  const confirm = vi.fn(() => true)
  let fail: string | null = null
  const snapshot = {
    repos: [{ id: 'r1', name: 'foreman', rootPath: '/repo' }],
    workspaces: [ws({ state: 'archived', archivedAt: '2026-10-12T16:40:00Z' }), ws({ id: 'w2', name: 'kigali' })],
    sessions: [session('s1'), session('s2', { closedAt: '2026-10-05T00:00:00Z' }), session('s9', { workspaceId: 'w2', closedAt: '2026-10-05T00:00:00Z' })],
    settings: {},
    catalog: { agents: {} },
    platform: 'win32'
  } as unknown as AppSnapshot
  const answers: Record<string, () => unknown> = {
    getSnapshot: () => snapshot,
    pendingApprovals: () => [],
    agentStatus: () => ({ installed: false }),
    getChat: () => [],
    unarchiveWorkspace: () => ({ ...snapshot.workspaces[0], state: 'ready' }),
    reopenSession: () => snapshot.sessions[2]
  }
  const invoke = new Proxy(
    {},
    {
      get: (_, name: string) =>
        async (...args: unknown[]) => {
          calls.push({ name, args })
          if (name === fail) throw new Error(`${name} failed`)
          return answers[name]?.()
        }
    }
  )
  let store: typeof import('../src/renderer/src/store')

  beforeAll(async () => {
    vi.stubGlobal('window', { foreman: { invoke, send: { setUnread() {} }, onEvent() {} }, confirm, addEventListener() {}, dispatchEvent() {} })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
    vi.stubGlobal('document', { hasFocus: () => true })
    store = await import('../src/renderer/src/store')
    await store.initStore()
  })

  beforeEach(() => {
    calls.length = 0
    confirm.mockClear()
    fail = null
  })

  it('Read chats opens an archived workspace without a single call into main (no worktree, setup, agent, git or terminal)', () => {
    store.openArchivedChats('w1')
    expect(calls).toEqual([])
    const state = store.getState()
    expect(state.selectedWorkspaceId).toBe('w1')
    expect(store.activeSessionId(state, 'w1')).toBe('s1')
    expect(state.overlay).toBeNull()
  })

  it('reading its chats only loads the saved transcript', async () => {
    await store.loadChat('s1')
    expect(calls.map((c) => c.name)).toEqual(['getChat'])
  })

  it('an archived search result opens read-only at the message: no restore confirm, no restore, no reopen', async () => {
    await store.openChatHit(hit({ sessionId: 's2', itemId: 'i9', archived: true, closed: true }))
    expect(confirm).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    const state = store.getState()
    expect(state.selectedWorkspaceId).toBe('w1')
    // The closed tab is shown for reading, not reopened.
    expect(store.activeSessionId(state, 'w1')).toBe('s2')
    expect(state.chatJump).toMatchObject({ sessionId: 's2', itemId: 'i9' })
    expect(state.snapshot!.sessions.find((s) => s.id === 's2')!.closedAt).toBeTruthy()
  })

  it('an archived note result opens read-only too', async () => {
    await store.openNoteHit({ workspaceId: 'w1', workspaceName: 'dakar', archived: true } as NoteHit)
    expect(confirm).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(store.getState().selectedWorkspaceId).toBe('w1')
  })

  it('a closed tab in a live workspace still reopens as before', async () => {
    await store.openChatHit(hit({ sessionId: 's9', workspaceId: 'w2', workspaceName: 'kigali', closed: true }))
    expect(calls.map((c) => [c.name, ...c.args])).toEqual([['reopenSession', 'w2', 's9']])
    expect(store.getState().selectedWorkspaceId).toBe('w2')
  })

  it('Restore workspace… from the banner runs the existing restore once and shows the workspace', async () => {
    store.openArchivedChats('w1')
    expect(await store.restoreArchived('w1')).toBe(true)
    expect(calls.map((c) => [c.name, ...c.args])).toEqual([['unarchiveWorkspace', 'w1']])
    expect(store.getState().selectedWorkspaceId).toBe('w1')
  })

  it('a failed restore says so and leaves the read-only view where it was', async () => {
    store.openArchivedChats('w1')
    fail = 'unarchiveWorkspace'
    expect(await store.restoreArchived('w1')).toBe(false)
    expect(store.getState().toast).toMatchObject({ kind: 'error' })
    expect(store.getState().selectedWorkspaceId).toBe('w1')
  })
})
