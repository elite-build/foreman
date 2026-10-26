// A workspace's local binding (shared/workspacePath.ts): history only, archived, and cloud
// workspaces, which have no folder here but are live.
import { describe, expect, it } from 'vitest'
import { chatsOnly, CLOUD_NO_FOLDER_REASON, HISTORY_ONLY_REASON, isCloud, isHistoryOnly, sessionReadOnly, wsPath } from '../src/shared/workspacePath'
import type { Workspace, WorkspaceCloud } from '../src/shared/types'

const cloud: WorkspaceCloud = { provider: 'vercel', id: 'foreman-ws-1', status: 'running', region: 'iad1', vcpus: 2, cwd: '/vercel/sandbox/repo' }
const ws = (patch: Partial<Workspace>): Pick<Workspace, 'path' | 'state' | 'cloud'> => ({ state: 'ready', ...patch })

describe('workspace bindings', () => {
  it('knows a cloud workspace', () => {
    expect(isCloud(ws({ cloud }))).toBe(true)
    expect(isCloud(ws({ path: '/w/a' }))).toBe(false)
  })

  it('treats a cloud workspace as live although it has no path', () => {
    expect(isHistoryOnly(ws({ cloud }))).toBe(false)
    expect(chatsOnly(ws({ cloud }))).toBe(false)
    expect(sessionReadOnly(ws({ cloud }), {})).toBe(false)
    expect(chatsOnly(ws({ cloud, state: 'archived' }))).toBe(true)
    expect(isHistoryOnly(ws({ cloud, state: 'history' }))).toBe(true)
  })

  it('keeps history-only and local workspaces as they were', () => {
    expect(isHistoryOnly(ws({}))).toBe(true)
    expect(isHistoryOnly(ws({ path: '/w/a' }))).toBe(false)
    expect(chatsOnly(ws({ path: '/w/a', state: 'archived' }))).toBe(true)
    expect(wsPath(ws({ path: '/w/a' }))).toBe('/w/a')
  })

  it('still has no folder for a cloud workspace: code not taught about the cloud fails closed', () => {
    expect(() => wsPath(ws({ cloud }))).toThrow(CLOUD_NO_FOLDER_REASON)
    expect(() => wsPath(ws({}))).toThrow(HISTORY_ONLY_REASON)
  })
})
