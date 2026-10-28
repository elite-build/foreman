import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AutoArchive, type AutoArchiveDeps } from '../src/main/autoArchive'
import { CHECKPOINT_REF_PREFIX } from '../src/main/checkpoints'
import { Environment } from '../src/main/environment'
import { git, gitOut, revParse } from '../src/main/git'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { WorkspaceService } from '../src/main/workspaces'
import { archiveReason, cleanupAt, cleanupDue, matchesArchivedFilter, mergedNow } from '../src/shared/autoArchive'
import type { ArchivedWork, Workspace } from '../src/shared/types'
import { wsPath } from '../src/shared/workspacePath'
import { commit, makeRepo, tempDir } from './helpers'

const DAY = 24 * 60 * 60_000
const NOW = Date.parse('2026-10-28T12:00:00Z')

function workspace(over: Partial<Workspace> = {}): Workspace {
  return { id: 'w1', repoId: 'r1', name: 'lisbon', branch: 'fix-login', baseBranch: 'main', portBase: 50000, state: 'ready', createdAt: '2026-10-01T00:00:00Z', ...over }
}

const archived = (daysAgo: number, over: Partial<Workspace> = {}) =>
  workspace({ state: 'archived', archivedAt: new Date(NOW - daysAgo * DAY).toISOString(), archiveReason: { kind: 'run', scheduleId: 's1' }, ...over })

describe('auto-archive rules', () => {
  it('counts a workspace archived before reasons were kept as archived by hand', () => {
    expect(archiveReason(workspace())).toEqual({ kind: 'manual' })
    expect(matchesArchivedFilter(workspace(), 'manual')).toBe(true)
    expect(matchesArchivedFilter(workspace(), 'auto')).toBe(false)
    const merged = workspace({ archiveReason: { kind: 'merged', number: 42 } })
    expect(matchesArchivedFilter(merged, 'auto')).toBe(true)
    expect(matchesArchivedFilter(merged, 'merged')).toBe(true)
    expect(matchesArchivedFilter(merged, 'run')).toBe(false)
    expect(matchesArchivedFilter(merged, 'all')).toBe(true)
  })

  it('only the open → merged change counts as merged now', () => {
    expect(mergedNow('OPEN', 'MERGED')).toBe(true)
    expect(mergedNow('MERGED', 'MERGED')).toBe(false)
    expect(mergedNow(undefined, 'MERGED')).toBe(false)
    expect(mergedNow('OPEN', 'CLOSED')).toBe(false)
  })

  it('cleans up only auto-archived, unkept, local workspaces past the window, and never with the cleanup off', () => {
    expect(cleanupDue(archived(31), 30, NOW)).toBe(true)
    expect(cleanupDue(archived(29), 30, NOW)).toBe(false)
    expect(cleanupDue(archived(31), 0, NOW)).toBe(false)
    expect(cleanupDue(archived(31, { archiveReason: { kind: 'manual' } }), 30, NOW)).toBe(false)
    expect(cleanupDue(archived(31, { archiveReason: undefined }), 30, NOW)).toBe(false)
    expect(cleanupDue(archived(31, { keepArchived: true }), 30, NOW)).toBe(false)
    expect(cleanupDue(archived(31, { cloud: { provider: 'vercel' } as Workspace['cloud'] }), 30, NOW)).toBe(false)
    expect(cleanupAt(archived(5), 7)).toBe(NOW + 2 * DAY)
  })
})

function rig(over: Partial<AutoArchiveDeps> = {}, list: Workspace[] = [workspace()]) {
  const quiet = { value: true }
  const archive = vi.fn(async (id: string) => {
    const ws = list.find((w) => w.id === id)!
    ws.state = 'archived'
    return { ok: true as const }
  })
  const remove = vi.fn(async (id: string) => void list.splice(list.findIndex((w) => w.id === id), 1))
  const safe = (id: string): ArchivedWork => ({ id, branch: 'b', deletesBranch: true, unpushed: 0, uncommitted: false })
  const deps: AutoArchiveDeps = {
    workspaces: () => list,
    quiet: () => quiet.value,
    archive,
    unchanged: async () => false,
    work: async (id) => safe(id),
    remove,
    cleanupDays: () => 30,
    now: () => NOW,
    log: vi.fn(),
    retryMs: 60_000,
    ...over
  }
  return { service: new AutoArchive(deps), list, quiet, archive, remove, deps }
}

describe('auto-archive queue', () => {
  it('archives a quiet workspace at once, with why', async () => {
    const r = rig()
    r.service.request('w1', { reason: { kind: 'merged', number: 42 }, deleteBranch: true })
    await vi.waitFor(() => expect(r.archive).toHaveBeenCalledWith('w1', true, { kind: 'merged', number: 42 }, false))
    expect(r.remove).not.toHaveBeenCalled()
  })

  it('waits while something runs in it, then archives when it settles', async () => {
    const r = rig()
    r.quiet.value = false
    r.service.request('w1', { reason: { kind: 'run', scheduleId: 's1' }, deleteBranch: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(r.archive).not.toHaveBeenCalled()
    expect(r.service.waiting('w1')).toBe(true)
    r.quiet.value = true
    r.service.settled('w1')
    await vi.waitFor(() => expect(r.archive).toHaveBeenCalledTimes(1))
    expect(r.service.waiting('w1')).toBe(false)
    r.service.stop()
  })

  it('calls off a waiting archive when new work starts in the workspace', async () => {
    const r = rig()
    r.quiet.value = false
    r.service.request('w1', { reason: { kind: 'merged', number: 3 }, deleteBranch: false })
    r.service.cancel('w1')
    r.quiet.value = true
    r.service.settled('w1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(r.archive).not.toHaveBeenCalled()
    r.service.stop()
  })

  it('deletes a run that changed nothing, and archives one that did', async () => {
    const unchanged = rig({ unchanged: async () => true })
    unchanged.service.request('w1', { reason: { kind: 'run', scheduleId: 's1' }, deleteBranch: false, deleteIfUnchanged: true })
    await vi.waitFor(() => expect(unchanged.remove).toHaveBeenCalledWith('w1'))
    // The branch goes with it: there was nothing on it.
    expect(unchanged.archive).toHaveBeenCalledWith('w1', true, { kind: 'run', scheduleId: 's1' }, false)

    const changed = rig({ unchanged: async () => false })
    changed.service.request('w1', { reason: { kind: 'run', scheduleId: 's1' }, deleteBranch: false, deleteIfUnchanged: true })
    await vi.waitFor(() => expect(changed.archive).toHaveBeenCalledWith('w1', false, { kind: 'run', scheduleId: 's1' }, false))
    expect(changed.remove).not.toHaveBeenCalled()
  })

  it('drops a request for a workspace that is no longer ready', async () => {
    const r = rig({}, [workspace({ state: 'archived' })])
    r.service.request('w1', { reason: { kind: 'merged', number: 1 }, deleteBranch: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(r.archive).not.toHaveBeenCalled()
    expect(r.service.waiting('w1')).toBe(false)
  })

  it('never archives the same workspace twice when a merge in Foreman and the lookup after it both ask', async () => {
    let finish: () => void = () => undefined
    const list = [workspace()]
    const archive = vi.fn(
      (id: string, _deleteBranch: boolean, _reason: unknown, _stopTabs: boolean) =>
        new Promise<{ ok: true }>((resolve) => {
          finish = () => {
            list.find((w) => w.id === id)!.state = 'archived'
            resolve({ ok: true })
          }
        })
    )
    const r = rig({ archive }, list)
    const merging = r.service.now('w1', { reason: { kind: 'merged', number: 7 }, deleteBranch: false })
    r.service.request('w1', { reason: { kind: 'merged', number: 7 }, deleteBranch: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    finish()
    await merging
    r.service.settled('w1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(archive).toHaveBeenCalledTimes(1)
    // The merge in Foreman stops the tabs; the request after it would have waited.
    expect(archive.mock.calls[0][3]).toBe(true)
    r.service.stop()
  })

  it('says why when a checkpoint or archive script stopped an archive after a merge in Foreman', async () => {
    const r = rig({ archive: async () => ({ ok: false, detail: 'exit code 3' }) })
    await expect(r.service.now('w1', { reason: { kind: 'merged', number: 7 }, deleteBranch: false })).rejects.toThrow('exit code 3')
  })

  it('cleans up what is due, but never work that is not anywhere else', async () => {
    const list = [
      archived(40, { id: 'due' }),
      archived(40, { id: 'unpushed' }),
      archived(40, { id: 'saved' }),
      archived(40, { id: 'unknown' }),
      archived(40, { id: 'kept', keepArchived: true }),
      archived(40, { id: 'mine', archiveReason: { kind: 'manual' } }),
      archived(3, { id: 'young' })
    ]
    const work = async (id: string): Promise<ArchivedWork> => ({
      id,
      branch: id,
      deletesBranch: true,
      unpushed: id === 'unpushed' ? 2 : id === 'unknown' ? null : 0,
      uncommitted: id === 'saved'
    })
    const r = rig({ work }, list)
    expect(await r.service.cleanup()).toEqual(['due'])
    expect(list.map((w) => w.id)).toEqual(['unpushed', 'saved', 'unknown', 'kept', 'mine', 'young'])
  })
})

async function setup() {
  const dataDir = await tempDir('foreman-data-')
  const store = new Store(dataDir)
  await store.load()
  store.state.settings.workspacesRoot = await tempDir('foreman-ws-')
  store.state.settings.branchPrefixType = 'custom'
  store.state.settings.branchPrefix = 'test/'
  const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const environment = new Environment(secrets, () => store.state.settings, (id) => service.repo(id))
  const service: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog() {} }, environment)
  return { store, service }
}

async function ready(ws: Workspace): Promise<void> {
  for (let i = 0; i < 300 && ws.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50))
  expect(ws.state).toBe('ready')
}

describe('archived workspaces', () => {
  it('keeps why it was archived until it is restored, and Keep goes with it', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    const ws = await service.createWorkspace(repo.id)
    await ready(ws)
    await service.archiveWorkspace(ws.id, false, { reason: { kind: 'merged', number: 42 } })
    expect(ws.archiveReason).toEqual({ kind: 'merged', number: 42 })
    service.keepArchived(ws.id, true)
    expect(ws.keepArchived).toBe(true)
    await service.unarchiveWorkspace(ws.id)
    expect(ws.archiveReason).toBeUndefined()
    expect(ws.keepArchived).toBeUndefined()
    expect(() => service.keepArchived(ws.id, true)).toThrow(/archived/)
    // Archived by hand when nothing says otherwise.
    await service.archiveWorkspace(ws.id, false)
    expect(ws.archiveReason).toEqual({ kind: 'manual' })
  })

  it('says what deleting would lose, then deletes the chats, branch and saved changes for good', async () => {
    const { store, service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    const ws = await service.createWorkspace(repo.id)
    await ready(ws)
    await writeFile(path.join(wsPath(ws), 'done.txt'), 'shipped\n')
    await git(wsPath(ws), ['add', '-A'])
    await commit(wsPath(ws), 'work')
    await writeFile(path.join(wsPath(ws), 'draft.txt'), 'not committed\n')
    store.state.sessions.push({ id: 's1', workspaceId: ws.id } as (typeof store.state.sessions)[number])
    await service.archiveWorkspace(ws.id, false, { reason: { kind: 'run', scheduleId: 'sch' } })

    expect(await service.archivedWork(ws.id)).toEqual({ id: ws.id, branch: ws.branch, deletesBranch: true, unpushed: 1, against: 'main', uncommitted: true })

    await service.deleteArchived(ws.id)
    expect(await gitOut(repo.rootPath, ['branch', '--list', ws.branch])).toBe('')
    expect(await revParse(repo.rootPath, `${CHECKPOINT_REF_PREFIX}archive-${ws.id}`)).toBeNull()
    expect(store.state.workspaces.find((w) => w.id === ws.id)).toBeUndefined()
    expect(store.state.sessions.find((s) => s.workspaceId === ws.id)).toBeUndefined()
  })

  it('never deletes the default branch or one another workspace still uses', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    const ws = await service.createWorkspace(repo.id)
    await ready(ws)
    await service.archiveWorkspace(ws.id, false)
    ws.branch = repo.defaultBranch!
    expect((await service.archivedWork(ws.id)).deletesBranch).toBe(false)
    await service.deleteArchived(ws.id)
    expect(await gitOut(repo.rootPath, ['branch', '--list', repo.defaultBranch!])).not.toBe('')
  })

  it('refuses to delete a workspace that is not archived', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    const ws = await service.createWorkspace(repo.id)
    await ready(ws)
    await expect(service.deleteArchived(ws.id)).rejects.toThrow(/Archive the workspace first/)
  })
})
