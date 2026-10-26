import { describe, expect, it } from 'vitest'
import { resolveWorkspace } from '../src/main/cliServer'
import { git } from '../src/main/git'
import { repoEvidence } from '../src/main/git'
import { triageAll } from '../src/renderer/src/triage'
import type { AppSnapshot, Workspace } from '../src/shared/types'
import { HISTORY_ONLY_REASON, isHistoryOnly, wsPath } from '../src/shared/workspacePath'
import { makeRepo } from './helpers'
import { setupSessions } from './sessionHarness'

const history = (patch: Partial<Workspace> = {}): Workspace => ({
  id: 'h1', repoId: 'r', name: 'oslo', branch: 'feat/x', baseBranch: 'main', portBase: 1, state: 'history', createdAt: '2026-01-01T00:00:00Z',
  provenance: { exportId: 'e1', sourceMachine: 'MacBook Air', importedAt: '2026-01-02T00:00:00Z' }, ...patch
})

describe('portable identity', () => {
  it('a workspace without a path is history only and never yields a folder', () => {
    const ws = history()
    expect(isHistoryOnly(ws)).toBe(true)
    expect(() => wsPath(ws)).toThrow(HISTORY_ONLY_REASON)
    expect(isHistoryOnly({ path: '/x', state: 'ready' })).toBe(false)
  })

  it('adopted and direct workspaces can be history only too', () => {
    expect(isHistoryOnly(history({ adopted: true, direct: true, state: 'history' }))).toBe(true)
  })

  it('the CLI resolver skips workspaces that have no folder', () => {
    expect(() => resolveWorkspace({ workspaces: [history()] }, '/anywhere')).toThrow(/inside one of Foreman/)
  })

  it('triage shows a history-only row, not an error', () => {
    const snapshot = { workspaces: [history()], sessions: [] } as unknown as AppSnapshot
    const [t] = triageAll({ snapshot, approvals: [], unread: {}, unreadSessions: {} }, null)
    expect(t).toMatchObject({ bucket: 'idle', label: 'History only', detail: 'Imported from MacBook Air' })
  })

  it('refuses to send into a history-only workspace and says why', async () => {
    const t = await setupSessions()
    t.ws.state = 'history'
    delete t.ws.path
    await expect(t.sessions.deliver(t.session.id, 'hello')).rejects.toThrow(HISTORY_ONLY_REASON)
  })

  it('records the remote URL (without credentials) and the root commit as evidence', async () => {
    const dir = await makeRepo()
    await git(dir, ['remote', 'add', 'origin', 'https://user:token@example.com/acme/app.git'])
    const evidence = await repoEvidence(dir, 'origin')
    expect(evidence.remoteUrl).toBe('https://example.com/acme/app.git')
    expect(evidence.rootCommit).toMatch(/^[0-9a-f]{40}$/)
  })
})
