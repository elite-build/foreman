import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BaseWatcher } from '../src/main/baseWatch'
import { git } from '../src/main/git'
import { mergeTreeSupported, parseGitVersion, parseMergeTree, stepBase } from '../src/shared/baseWatch'
import { triageAll } from '../src/shared/triage'
import type { AppSnapshot, Workspace } from '../src/shared/types'
import { commit, makeRepo } from './helpers'

async function write(dir: string, file: string, text: string): Promise<void> {
  await writeFile(path.join(dir, file), text)
  await git(dir, ['add', '-A'])
}

/** main and feat both touch a.txt from a shared start; feat is checked out. */
async function rig(files: Record<string, string> = { 'a.txt': 'one\n', 'b.txt': 'one\n' }) {
  const dir = await makeRepo(files)
  await git(dir, ['checkout', '-q', '-b', 'feat'])
  const ws = { id: 'w1', repoId: 'r', name: 'tokyo', branch: 'feat', baseBranch: 'main', path: dir, state: 'ready' } as Workspace
  const store = { state: { workspaces: [ws] }, save: vi.fn() }
  const notify = vi.fn()
  let enabled = true
  let version: string | undefined = 'git version 2.40.0'
  const watcher = new BaseWatcher({
    store: store as never,
    enabled: () => enabled,
    repo: () => ({ remote: 'origin', hasOrigin: false }),
    version: async () => version,
    notify,
    changed: () => undefined
  })
  const onMain = async (fn: () => Promise<void>) => {
    await git(dir, ['checkout', '-q', 'main'])
    await fn()
    await git(dir, ['checkout', '-q', 'feat'])
  }
  return { dir, ws, store, notify, watcher, onMain, setEnabled: (v: boolean) => (enabled = v), setVersion: (v: string | undefined) => (version = v) }
}

describe('merge-tree helpers', () => {
  it('reads the git version and the 2.38 gate', () => {
    expect(parseGitVersion('git version 2.54.0 (Apple Git-157)')).toEqual([2, 54, 0])
    expect(mergeTreeSupported([2, 37, 9])).toBe(false)
    expect(mergeTreeSupported([2, 38, 0])).toBe(true)
    expect(mergeTreeSupported([3, 0, 0])).toBe(true)
    expect(mergeTreeSupported(null)).toBe(false)
  })

  it('takes the conflicted paths after the tree id', () => {
    expect(parseMergeTree('abc123\na.txt\nb.txt\n')).toEqual(['a.txt', 'b.txt'])
    expect(parseMergeTree('abc123\n')).toEqual([])
  })
})

describe('Base moved watch', () => {
  it('records both SHAs and notifies once for committed conflicts', async () => {
    const t = await rig()
    await write(t.dir, 'a.txt', 'feature\n')
    await commit(t.dir, 'feat change')
    await t.onMain(async () => {
      await write(t.dir, 'a.txt', 'mainline\n')
      await commit(t.dir, 'main change')
    })
    await t.watcher.poll()
    await t.watcher.poll()
    expect(t.ws.baseWatch?.conflicts).toEqual(['a.txt'])
    expect(t.ws.baseWatch?.base).toBe((await git(t.dir, ['rev-parse', 'main'])).stdout.trim())
    expect(t.ws.baseWatch?.head).toBe((await git(t.dir, ['rev-parse', 'feat'])).stdout.trim())
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', body: expect.stringContaining('Base moved · 1 conflict') }))
  })

  it('shows nothing for a clean merge', async () => {
    const t = await rig()
    await write(t.dir, 'a.txt', 'feature\n')
    await commit(t.dir, 'feat change')
    await t.onMain(async () => {
      await write(t.dir, 'b.txt', 'mainline\n')
      await commit(t.dir, 'main change')
    })
    await t.watcher.poll()
    expect(t.ws.baseWatch?.conflicts).toEqual([])
    expect(t.notify).not.toHaveBeenCalled()
    const snapshot = { workspaces: [t.ws], sessions: [], repos: [] } as unknown as AppSnapshot
    const [row] = triageAll({ snapshot, approvals: [], unread: {}, unreadSessions: {} }, null)
    expect(row.label ?? '').not.toMatch(/Base moved/)
  })

  it('does not test uncommitted changes and labels them untested', async () => {
    const t = await rig()
    await write(t.dir, 'a.txt', 'feature\n')
    await commit(t.dir, 'feat change')
    await t.onMain(async () => {
      await write(t.dir, 'a.txt', 'mainline\n')
      await commit(t.dir, 'main change')
    })
    // A dirty edit to a file the base did not touch.
    await write(t.dir, 'b.txt', 'dirty\n')
    await t.watcher.poll()
    expect(t.ws.baseWatch?.conflicts).toEqual(['a.txt'])
    expect(t.ws.baseWatch?.untested).toBe(true)
    const snapshot = { workspaces: [t.ws], sessions: [], repos: [] } as unknown as AppSnapshot
    const [row] = triageAll({ snapshot, approvals: [], unread: {}, unreadSessions: {} }, null)
    expect(row).toMatchObject({ label: 'Base moved · 1 conflict', action: { kind: 'resolve-base' } })
    expect(row.detail).toContain('uncommitted changes untested')
  })

  it('a new base tip re-arms the notification', async () => {
    const t = await rig()
    await write(t.dir, 'a.txt', 'feature\n')
    await commit(t.dir, 'feat change')
    await t.onMain(async () => {
      await write(t.dir, 'a.txt', 'mainline\n')
      await commit(t.dir, 'main change')
    })
    await t.watcher.poll()
    t.watcher.ack('w1')
    expect(t.ws.baseWatch?.acked).toBe(t.ws.baseWatch?.base)
    await t.watcher.poll()
    expect(t.notify).toHaveBeenCalledTimes(1)
    await t.onMain(async () => {
      await write(t.dir, 'a.txt', 'mainline again\n')
      await commit(t.dir, 'main moves on')
    })
    await t.watcher.poll()
    expect(t.notify).toHaveBeenCalledTimes(2)
    expect(t.ws.baseWatch?.acked).not.toBe(t.ws.baseWatch?.base)
  })

  it('does nothing before git 2.38 and when the repo has not opted in', async () => {
    const t = await rig()
    await write(t.dir, 'a.txt', 'feature\n')
    await commit(t.dir, 'feat change')
    await t.onMain(async () => {
      await write(t.dir, 'a.txt', 'mainline\n')
      await commit(t.dir, 'main change')
    })
    t.setVersion('git version 2.37.1')
    expect(await t.watcher.support()).toEqual({ ok: false, version: '2.37.1' })
    await t.watcher.poll()
    expect(t.ws.baseWatch).toBeUndefined()
    t.setVersion('git version 2.40.0')
    t.setEnabled(false)
    await t.watcher.poll()
    expect(t.ws.baseWatch).toBeUndefined()
    expect(t.notify).not.toHaveBeenCalled()
  })

  it('keeps what it knew when a look fails', () => {
    const prev = { base: 'a', head: 'b', conflicts: ['x'], notified: 'a' }
    expect(stepBase(prev, { kind: 'error' }).next).toBe(prev)
  })
})
