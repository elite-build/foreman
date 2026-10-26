import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../src/shared/types'
import { workspaceDiff, parseUnifiedDiff } from '../src/main/diff'
import { snapshotWorkingTree } from '../src/main/checkpoints'
import { git, gitOut } from '../src/main/git'
import { isWindows } from '../src/main/platform'
import { Environment } from '../src/main/environment'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { WorkspaceService } from '../src/main/workspaces'
import { commit, makeRepo, tempDir } from './helpers'
import { wsPath } from '../src/shared/workspacePath'
import { workspacePerson } from '../src/shared/workspacePeople'

async function setup() {
  const dataDir = await tempDir('switchyard-data-')
  const store = new Store(dataDir)
  await store.load()
  store.state.settings.workspacesRoot = await tempDir('switchyard-ws-')
  store.state.settings.branchPrefixType = 'custom'
  store.state.settings.branchPrefix = 'test/'
  const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const environment = new Environment(secrets, () => store.state.settings, (id) => service.repo(id))
  const service: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog() {} }, environment)
  return { store, service }
}

async function waitForState(ws: Workspace, states: Workspace['state'][]): Promise<void> {
  for (let i = 0; i < 300 && !states.includes(ws.state); i++) await new Promise((r) => setTimeout(r, 50))
  expect(states).toContain(ws.state)
}

describe('workspaces', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a worktree, copies ignored files and runs the setup script', async () => {
    const repoDir = await makeRepo({ 'README.md': 'hi\n', '.gitignore': '.env\n' })
    await writeFile(path.join(repoDir, '.env'), 'SECRET=1\n')
    const { service } = await setup()
    const repo = await service.addRepo(repoDir)
    expect(repo.defaultBranch).toBe('main')
    expect(repo.hasOrigin).toBe(false)

    service.updateRepoSettings(repo.id, {
      setupScript: isWindows ? 'echo %FOREMAN_PORT%> port.txt' : 'echo "$FOREMAN_PORT" > port.txt'
    })
    const ws = await service.createWorkspace(repo.id)
    await waitForState(ws, ['ready', 'setup-failed', 'error'])
    expect(ws.state).toBe('ready')

    expect(await gitOut(wsPath(ws), ['branch', '--show-current'])).toBe(ws.branch)
    expect(ws.branch).toBe(`test/${ws.name}`)
    expect(ws.namesake).toBe(ws.name)
    expect(await readFile(path.join(wsPath(ws), '.env'), 'utf8')).toBe('SECRET=1\n')
    expect((await readFile(path.join(wsPath(ws), 'port.txt'), 'utf8')).trim()).toBe(String(ws.portBase))
    expect(await service.setupLog(ws.id)).toContain('worktree add')
  })

  it('keeps a manually named branch introduction in Foreman without adding files to its repository', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    const ws = await service.createWorkspace(repo.id, { branch: { kind: 'new', name: 'tesla' } })
    await waitForState(ws, ['ready'])
    expect(ws.namesake).toBe('tesla')
    expect(workspacePerson(ws)?.fullName).toBe('Nikola Tesla')
    expect(await gitOut(wsPath(ws), ['status', '--porcelain'])).toBe('')
  })

  it('branches from origin without tracking it', async () => {
    const upstream = await makeRepo({ 'a.txt': 'v1\n' })
    const clone = await tempDir()
    await git(path.dirname(clone), ['clone', '-q', upstream, clone])
    // Upstream moves ahead; the local main in the clone stays behind.
    await writeFile(path.join(upstream, 'a.txt'), 'v2\n')
    await git(upstream, ['add', '-A'])
    await commit(upstream, 'v2')

    const { service } = await setup()
    const repo = await service.addRepo(clone)
    expect(repo.hasOrigin).toBe(true)
    const ws = await service.createWorkspace(repo.id)
    await waitForState(ws, ['ready', 'error'])
    expect(ws.error).toBeUndefined()
    expect(await readFile(path.join(wsPath(ws), 'a.txt'), 'utf8')).toBe('v2\n')
    const upstreamRef = await git(wsPath(ws), ['rev-parse', '--abbrev-ref', '@{upstream}'], { allowFail: true })
    expect(upstreamRef.code).not.toBe(0)
  })

  it('archives a workspace and optionally deletes its branch', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    const ws = await service.createWorkspace(repo.id)
    await waitForState(ws, ['ready'])
    await service.archiveWorkspace(ws.id, true)
    expect(existsSync(wsPath(ws))).toBe(false)
    expect(ws.state).toBe('archived')
    expect(await gitOut(repo.rootPath, ['branch', '--list', ws.branch])).toBe('')
  })

  it('gives parallel workspaces distinct names, branches and ports', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    // Both would pick the same scientist if only one could be told apart from the other.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const a = await service.createWorkspace(repo.id)
    const b = await service.createWorkspace(repo.id)
    await Promise.all([waitForState(a, ['ready']), waitForState(b, ['ready'])])
    expect(a.name).not.toBe(b.name)
    expect(a.branch).not.toBe(b.branch)
    expect(a.portBase).not.toBe(b.portBase)
  })

  it('never reuses a folder once the workspace living there is renamed', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const a = await service.createWorkspace(repo.id)
    await waitForState(a, ['ready'])
    // As after the first message renames it.
    service.updateWorkspace(a.id, { name: 'fix-login' })
    expect(a.namesake).toBe(path.basename(wsPath(a)))
    const b = await service.createWorkspace(repo.id)
    await waitForState(b, ['ready', 'error'])
    expect(b.error).toBeUndefined()
    expect(wsPath(b)).not.toBe(wsPath(a))
  })

  it('never reuses the folder of an archived workspace, so it can come back', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const a = await service.createWorkspace(repo.id)
    await waitForState(a, ['ready'])
    service.updateWorkspace(a.id, { name: 'fix-login' })
    await service.archiveWorkspace(a.id, false)
    const b = await service.createWorkspace(repo.id)
    await waitForState(b, ['ready'])
    expect(wsPath(b)).not.toBe(wsPath(a))
    await service.unarchiveWorkspace(a.id)
    expect(existsSync(wsPath(a))).toBe(true)
  })

  it('skips folders already on disk, from another repository with the same name or anything else', async () => {
    const { store, service } = await setup()
    const one = await service.addRepo(await makeRepo())
    const two = await service.addRepo(await makeRepo())
    service.updateRepo(one.id, { name: 'app' })
    service.updateRepo(two.id, { name: 'app' })
    await mkdir(path.join(store.state.settings.workspacesRoot, 'app', 'aberdeen'), { recursive: true })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const a = await service.createWorkspace(one.id)
    const b = await service.createWorkspace(two.id)
    await Promise.all([waitForState(a, ['ready', 'error']), waitForState(b, ['ready', 'error'])])
    expect([a.error, b.error]).toEqual([undefined, undefined])
    expect(path.basename(wsPath(a))).not.toBe('aberdeen')
    expect(wsPath(a)).not.toBe(wsPath(b))
  })

  it('archiving a workspace that points at another one’s folder leaves that folder alone', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    service.updateRepoSettings(repo.id, { archiveScript: 'touch archived-here' })
    const live = await service.createWorkspace(repo.id)
    const stale = await service.createWorkspace(repo.id)
    await Promise.all([waitForState(live, ['ready']), waitForState(stale, ['ready'])])
    await writeFile(path.join(wsPath(live), 'work.txt'), 'keep\n')
    // A record left by the old naming: creation hit the live workspace's folder and failed.
    await rm(wsPath(stale), { recursive: true, force: true })
    await git(repo.rootPath, ['worktree', 'prune'])
    stale.path = live.path
    stale.state = 'error'
    await service.archiveWorkspace(stale.id, false)
    expect(stale.state).toBe('archived')
    expect(await readFile(path.join(wsPath(live), 'work.txt'), 'utf8')).toBe('keep\n')
    expect(existsSync(path.join(wsPath(live), 'archived-here'))).toBe(false)
    expect((await service.listWorktrees(repo.id)).map((t) => t.workspaceId)).toContain(live.id)
  })

  it('still removes the folder of the workspace that lives there when a failed record shares its path', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    const live = await service.createWorkspace(repo.id)
    const stale = await service.createWorkspace(repo.id)
    await Promise.all([waitForState(live, ['ready']), waitForState(stale, ['ready'])])
    await rm(wsPath(stale), { recursive: true, force: true })
    await git(repo.rootPath, ['worktree', 'prune'])
    stale.path = live.path
    stale.state = 'error'
    await service.archiveWorkspace(live.id, false)
    expect(live.state).toBe('archived')
    expect(existsSync(wsPath(live))).toBe(false)
  })

  it('works directly in the repository folder on its checked-out branch', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    const ws = await service.createWorkspace(repo.id, { branch: { kind: 'direct', name: 'main' } })
    expect(ws.state).toBe('ready')
    expect(ws.direct).toBe(true)
    expect(ws.path).toBe(repo.rootPath)
    expect(ws.branch).toBe('main')
    expect(ws.baseBranch).toBe('main')
    expect(service.agentContext(ws)).toContain('straight onto main')
    // No worktree was added.
    expect((await service.listWorktrees(repo.id)).map((t) => t.workspaceId)).toEqual([ws.id])

    // Only one workspace can use the folder at a time.
    await expect(service.createWorkspace(repo.id, { branch: { kind: 'direct', name: 'main' } })).rejects.toThrow(/already works in the repository folder/)

    // Archiving leaves the folder and branch alone.
    await writeFile(path.join(repo.rootPath, 'work.txt'), 'keep\n')
    await service.archiveWorkspace(ws.id, true)
    expect(ws.state).toBe('archived')
    expect(await readFile(path.join(repo.rootPath, 'work.txt'), 'utf8')).toBe('keep\n')
    expect(await gitOut(repo.rootPath, ['branch', '--show-current'])).toBe('main')
  })

  it('checks out another branch in the repository folder for a direct workspace', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    await git(repo.rootPath, ['branch', 'feature'])
    const ws = await service.createWorkspace(repo.id, { branch: { kind: 'direct', name: 'feature' } })
    expect(ws.branch).toBe('feature')
    expect(await gitOut(repo.rootPath, ['branch', '--show-current'])).toBe('feature')
    expect(await service.setupLog(ws.id)).toContain('git checkout feature')
  })

  it('refuses a direct workspace on a branch checked out in another worktree', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    const other = await service.createWorkspace(repo.id)
    await waitForState(other, ['ready'])
    await expect(service.createWorkspace(repo.id, { branch: { kind: 'direct', name: other.branch } })).rejects.toThrow(/checked out in/)
    expect(service.directWorkspace(repo.id)).toBeUndefined()
  })
})

describe('diff', () => {
  it('includes committed, uncommitted, untracked and deleted changes', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo({ 'keep.txt': 'a\nb\nc\n', 'gone.txt': 'bye\n' }))
    const ws = await service.createWorkspace(repo.id)
    await waitForState(ws, ['ready'])

    await writeFile(path.join(wsPath(ws), 'committed.txt'), 'x\n')
    await git(wsPath(ws), ['add', '-A'])
    await commit(wsPath(ws), 'agent work')
    await writeFile(path.join(wsPath(ws), 'keep.txt'), 'a\nB\nc\n')
    await writeFile(path.join(wsPath(ws), 'new file.txt'), 'untracked\n')
    await rm(path.join(wsPath(ws), 'gone.txt'))

    const diff = await workspaceDiff(ws)
    expect(diff.baseRef).toBe('main')
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]))
    expect(Object.keys(byPath).sort()).toEqual(['committed.txt', 'gone.txt', 'keep.txt', 'new file.txt'])
    expect(byPath['committed.txt'].status).toBe('added')
    expect(byPath['gone.txt'].status).toBe('deleted')
    expect(byPath['keep.txt']).toMatchObject({ status: 'modified', additions: 1, deletions: 1 })
    expect(byPath['new file.txt'].status).toBe('added')
  })

  it('accepts a precomputed working-tree snapshot instead of scanning again', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo({ 'keep.txt': 'base\n' }))
    const ws = await service.createWorkspace(repo.id)
    await waitForState(ws, ['ready'])
    await writeFile(path.join(wsPath(ws), 'keep.txt'), 'base\nchanged\n')
    await writeFile(path.join(wsPath(ws), 'new.txt'), 'untracked\n')
    // The snapshot a checkpoint would have taken, passed in as the diff's tree.
    const tree = await snapshotWorkingTree(wsPath(ws))
    const direct = await workspaceDiff(ws)
    const reused = await workspaceDiff(ws, 'all', tree)
    expect(reused.mergeBase).toBe(direct.mergeBase)
    expect(reused.files.map((f) => f.path).sort()).toEqual(direct.files.map((f) => f.path).sort())
    expect(reused.files.find((f) => f.path === 'keep.txt')?.additions).toBe(direct.files.find((f) => f.path === 'keep.txt')?.additions)
  })

  it('parses renames and line numbers', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/old.ts b/new.ts',
        'similarity index 90%',
        'rename from old.ts',
        'rename to new.ts',
        '--- a/old.ts',
        '+++ b/new.ts',
        '@@ -10,2 +10,2 @@ function f()',
        ' same',
        '-before',
        '+after',
        ''
      ].join('\n')
    )
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'new.ts', oldPath: 'old.ts', status: 'renamed', additions: 1, deletions: 1 })
    expect(files[0].hunks[0].lines).toEqual([
      { type: 'ctx', text: 'same', oldNo: 10, newNo: 10 },
      { type: 'del', text: 'before', oldNo: 11 },
      { type: 'add', text: 'after', newNo: 11 }
    ])
  })
})
