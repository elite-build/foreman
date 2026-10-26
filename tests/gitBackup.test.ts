import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Environment } from '../src/main/environment'
import { git, gitOut } from '../src/main/git'
import { GitBackupService, createPrivateGithubRepo, makeGitBackupFiles, parseGitBackup } from '../src/main/gitBackup'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { WorkspaceService } from '../src/main/workspaces'
import type { Workspace } from '../src/shared/types'
import { commit, makeRepo, tempDir } from './helpers'

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  vi.unstubAllEnvs()
})

async function remote() {
  const source = await makeRepo()
  const bare = await tempDir('foreman-backup-remote-')
  await git(bare, ['init', '--bare', '-b', 'main'])
  await git(source, ['remote', 'add', 'origin', bare])
  await git(source, ['push', '-u', 'origin', 'main'])
  return { source, bare }
}

async function rig(options: { now?: () => Date; beforePush?: () => Promise<void> } = {}) {
  const dir = await tempDir('foreman-backup-data-')
  const store = new Store(dir)
  await store.load()
  stores.push(store)
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() })
  const environment = new Environment(secrets, () => store.state.settings, (id) => workspaces.repo(id))
  const workspaces: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog() {} }, environment)
  let chats = 0
  const service = new GitBackupService({
    store, secrets, workspaces,
    updateSettings: async (patch) => { store.state.settings = { ...store.state.settings, ...patch }; return store.state.settings },
    startChat: () => { chats++ },
    changed() {}, ...options
  })
  return { store, secrets, workspaces, service, get chats() { return chats } }
}

async function checkout(bare: string) {
  const dir = await tempDir('foreman-backup-inspect-')
  await git(dir, ['clone', '--quiet', bare, '.'])
  return dir
}

describe('Git configuration backup', () => {
  it('creates GitHub destinations as private repositories for the selected account', async () => {
    const calls: string[][] = []
    const run = (async (_cwd: string, args: string[]) => { calls.push(args); return args[1] === 'view' ? 'https://github.com/alex/foreman-backup\n' : '' }) as typeof import('../src/main/github').gh
    const url = await createPrivateGithubRepo('foreman-backup', 'alex', run, async () => [])
    expect(url).toBe('https://github.com/alex/foreman-backup')
    expect(calls[0]).toEqual(['repo', 'create', 'alex/foreman-backup', '--private', '--add-readme'])
  })

  it('serializes configuration and variable names without vault values, chats or archived workspaces', async () => {
    const m = await rig()
    m.secrets.set({ kind: 'user' }, 'API_KEY', 'secret-value')
    m.store.state.settings.promptTemplates = [{ id: 'mine', name: 'Mine', body: 'Check {{issue}}' }]
    m.store.state.workspaces.push({ id: 'old', repoId: 'r', name: 'old', branch: 'old', baseBranch: 'main', path: '/tmp/old', portBase: 50000, state: 'archived', createdAt: '' })
    const files = makeGitBackupFiles(m.store, m.secrets, new Date('2026-01-01T00:00:00Z'))
    expect(files.variableNames.user).toEqual(['API_KEY'])
    expect(JSON.stringify(files)).not.toContain('secret-value')
    expect(files.templates).toEqual(m.store.state.settings.promptTemplates)
    expect(files.settings).not.toHaveProperty('promptTemplates')
    expect(files.workspaces).toEqual([])
    expect(JSON.stringify(files)).not.toContain('sessions')
    m.store.state.gitBackup = { config: { remoteUrl: 'https://example.com/private.git', daily: true } }
    expect(JSON.stringify(makeGitBackupFiles(m.store, m.secrets, new Date()))).not.toContain('https://example.com/private.git')
  })

  it('commits to the default branch only when contents change, and runs daily only when due', async () => {
    const { bare } = await remote()
    let now = new Date('2026-01-01T00:00:00Z')
    const m = await rig({ now: () => now })
    await m.service.configure({ remoteUrl: bare, daily: true })
    expect((await m.service.backupNow()).changed).toBe(true)
    const copy = await checkout(bare)
    expect(JSON.parse(await readFile(path.join(copy, 'foreman-backup', 'manifest.json'), 'utf8'))).toMatchObject({ format: 'foreman-git-backup', version: 1 })
    const head = await gitOut(copy, ['rev-parse', 'HEAD'])
    expect((await m.service.backupNow()).changed).toBe(false)
    await git(copy, ['pull', '--ff-only'])
    expect(await gitOut(copy, ['rev-parse', 'HEAD'])).toBe(head)
    expect(await m.service.backupIfDue()).toBeUndefined()
    now = new Date('2026-01-02T01:00:00Z')
    expect((await m.service.backupIfDue())?.changed).toBe(false)
    m.store.state.settings.theme = 'dark'
    now = new Date('2026-01-03T02:00:00Z')
    expect((await m.service.backupIfDue())?.changed).toBe(true)
    await git(copy, ['pull', '--ff-only'])
    expect(JSON.parse(await readFile(path.join(copy, 'foreman-backup', 'settings.json'), 'utf8')).theme).toBe('dark')
  })

  it('does not create an empty backup commit when Git checks JSON out with CRLF', async () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.autocrlf')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true')
    const { bare } = await remote()
    const m = await rig()
    await m.service.configure({ remoteUrl: bare, daily: false })
    expect((await m.service.backupNow()).changed).toBe(true)
    const copy = await checkout(bare)
    expect(await readFile(path.join(copy, 'foreman-backup', 'settings.json'), 'utf8')).toContain('\r\n')
    const head = await gitOut(copy, ['rev-parse', 'HEAD'])
    expect((await m.service.backupNow()).changed).toBe(false)
    await git(copy, ['pull', '--ff-only'])
    expect(await gitOut(copy, ['rev-parse', 'HEAD'])).toBe(head)
    m.store.state.settings.theme = 'dark'
    expect((await m.service.backupNow()).changed).toBe(true)
  })

  it('does not force-push over a concurrent remote commit and reports the failure', async () => {
    const { source, bare } = await remote()
    let race = false
    const m = await rig({ beforePush: async () => {
      if (!race) return
      await writeFile(path.join(source, 'README.md'), 'new remote work\n')
      await git(source, ['add', 'README.md'])
      await commit(source, 'concurrent change')
      await git(source, ['push', 'origin', 'main'])
    } })
    await m.service.configure({ remoteUrl: bare, daily: false })
    await m.service.backupNow()
    await git(source, ['pull', '--ff-only'])
    m.store.state.settings.theme = 'dark'
    race = true
    await expect(m.service.backupNow()).rejects.toThrow()
    expect(m.service.status().lastError).toMatch(/push|rejected|fetch first/i)
    expect((await gitOut(source, ['show', 'origin/main:foreman-backup/settings.json']))).toContain('"theme": "system"')
  })

  it('rejects malformed and newer backup formats', async () => {
    const m = await rig()
    const good = makeGitBackupFiles(m.store, m.secrets, new Date())
    const raw = { ...good, 'variable-names': good.variableNames }
    expect(() => parseGitBackup({ ...raw, manifest: { ...good.manifest, version: 2 } })).toThrow('supported')
    expect(() => parseGitBackup({ ...raw, repositories: [{ id: 'bad' }] })).toThrow('malformed')
  })

  it('previews and merges templates, repositories and existing worktrees without running setup', async () => {
    const { source, bare } = await remote()
    const tree = path.join(await tempDir('foreman-backup-tree-'), 'checkout')
    await git(source, ['worktree', 'add', '-b', 'feature', tree])
    const from = await rig()
    const repo = await from.workspaces.addRepo(source)
    repo.local.setupScript = `touch ${path.join(from.store.dir, 'setup-ran')}`
    repo.local.envFiles = ['/missing/source.env']
    from.store.state.integrations = { connections: [], defaults: { linear: 'work-linear' }, rules: [], people: [] }
    repo.integrations = { services: { github: 'off' } }
    from.store.state.settings.theme = 'dark'
    from.store.state.settings.envFiles = ['/missing/user.env']
    from.store.state.settings.promptTemplates = [{ id: 'shared', name: 'Backup template', body: 'from backup' }]
    const ws: Workspace = { id: 'saved-workspace', repoId: repo.id, name: 'stuttgart', branch: 'feature', baseBranch: 'main', path: tree, portBase: 50000, state: 'ready', createdAt: '' }
    from.store.state.workspaces.push(ws)
    await from.service.configure({ remoteUrl: bare, daily: false })
    await from.service.backupNow()

    const to = await rig()
    to.store.state.integrations = { connections: [], defaults: { linear: 'personal-linear' }, rules: [], people: [] }
    to.store.state.settings.promptTemplates = [{ id: 'shared', name: 'Old', body: 'old' }, { id: 'local', name: 'Local', body: 'keep' }]
    const preview = await to.service.preview(bare)
    expect(preview.repositories[0].suggestedPath).toBe(repo.rootPath)
    expect(preview.workspaces[0].suggestedPath).toBe(tree)
    expect(preview.machinePaths).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'envFiles', available: false }), expect.objectContaining({ key: `repo:${repo.id}:envFiles`, available: false })]))
    const choice = {
      stageId: preview.stageId,
      categories: { settings: true, templates: true, repositories: true, workspaces: true },
      repositoryPaths: { [repo.id]: repo.rootPath }, workspacePaths: { [ws.id]: tree }
    }
    const result = await to.service.restore(choice)
    expect(result).toMatchObject({ repositories: 1, workspaces: 1, templates: 1 })
    expect(to.store.state.settings.theme).toBe('dark')
    expect(to.store.state.settings.envFiles).toEqual([])
    expect(to.store.state.settings.promptTemplates.map((t) => t.id)).toEqual(['shared', 'local'])
    expect(to.store.state.settings.promptTemplates[0].body).toBe('from backup')
    expect(to.store.state.repos[0].local.setupScript).toContain('touch')
    expect(to.store.state.repos[0].local.envFiles).toBeUndefined()
    expect(to.store.state.repos[0].integrations?.services).toEqual({ github: 'off', linear: 'imported:work-linear', slack: 'off' })
    expect(to.store.state.workspaces[0]).toMatchObject({ name: 'stuttgart', branch: 'feature', adopted: true, state: 'ready' })
    expect(to.chats).toBe(1)
    expect(await readFile(path.join(from.store.dir, 'setup-ran'), 'utf8').catch(() => null)).toBeNull()
    const again = await to.service.preview(bare)
    const duplicate = await to.service.restore({ ...choice, stageId: again.stageId })
    expect(duplicate).toMatchObject({ repositories: 0, workspaces: 0 })
    expect(to.store.state.workspaces).toHaveLength(1)
    const blank = await to.service.preview(bare)
    const skipped = await to.service.restore({ ...choice, stageId: blank.stageId, repositoryPaths: { [repo.id]: '' }, workspacePaths: { [ws.id]: '' } })
    expect(skipped.workspaces).toBe(0)
  })

  it('skips unresolved repository and worktree folders', async () => {
    const { source, bare } = await remote()
    const from = await rig()
    const repo = await from.workspaces.addRepo(source)
    from.store.state.workspaces.push({ id: 'w', repoId: repo.id, name: 'missing', branch: 'topic', baseBranch: 'main', path: '/missing/worktree', portBase: 50000, state: 'ready', createdAt: '' })
    await from.service.configure({ remoteUrl: bare, daily: false })
    await from.service.backupNow()
    const to = await rig()
    const preview = await to.service.preview(bare)
    const result = await to.service.restore({ stageId: preview.stageId, categories: { settings: false, templates: false, repositories: true, workspaces: true }, repositoryPaths: { [repo.id]: '/missing/repo' }, workspacePaths: {} })
    expect(result.repositories).toBe(0)
    expect(result.workspaces).toBe(0)
    expect(result.skipped).toEqual(expect.arrayContaining([expect.stringContaining('folder is unavailable'), expect.stringContaining('not connected')]))
  })

  it('rejects a selected folder with a different Git identity', async () => {
    const { source, bare } = await remote()
    const from = await rig()
    const repo = await from.workspaces.addRepo(source)
    await from.service.configure({ remoteUrl: bare, daily: false })
    await from.service.backupNow()
    const other = await makeRepo({ 'README.md': 'different repository\n' })
    const to = await rig()
    const preview = await to.service.preview(bare)
    const result = await to.service.restore({ stageId: preview.stageId, categories: { settings: false, templates: false, repositories: true, workspaces: false }, repositoryPaths: { [repo.id]: other }, workspacePaths: {} })
    expect(result.repositories).toBe(0)
    expect(result.skipped).toContain(`Repository ${repo.name}: Git identity does not match`)
  })

  it('keeps a repository without Git identity tied to its saved path', async () => {
    const { source, bare } = await remote()
    const from = await rig()
    const repo = await from.workspaces.addRepo(source)
    repo.remoteUrl = undefined
    repo.rootCommit = undefined
    await from.service.configure({ remoteUrl: bare, daily: false })
    await from.service.backupNow()
    const other = await makeRepo({ 'README.md': 'different repository\n' })
    const to = await rig()
    const preview = await to.service.preview(bare)
    const result = await to.service.restore({ stageId: preview.stageId, categories: { settings: false, templates: false, repositories: true, workspaces: false }, repositoryPaths: { [repo.id]: other }, workspacePaths: {} })
    expect(result.repositories).toBe(0)
    expect(result.skipped).toContain(`Repository ${repo.name}: saved repository has no Git identity to verify this folder`)
  })

  it('reconnects a direct workspace without switching the repository branch', async () => {
    const { source, bare } = await remote()
    const from = await rig()
    const repo = await from.workspaces.addRepo(source)
    from.store.state.workspaces.push({ id: 'direct', repoId: repo.id, name: 'main checkout', branch: 'main', baseBranch: 'main', path: repo.rootPath, portBase: 50000, state: 'ready', direct: true, adopted: true, createdAt: '' })
    await from.service.configure({ remoteUrl: bare, daily: false })
    await from.service.backupNow()
    const to = await rig()
    const preview = await to.service.preview(bare)
    const result = await to.service.restore({ stageId: preview.stageId, categories: { settings: false, templates: false, repositories: true, workspaces: true }, repositoryPaths: { [repo.id]: repo.rootPath }, workspacePaths: { direct: repo.rootPath } })
    expect(result.workspaces).toBe(1)
    expect(to.store.state.workspaces[0]).toMatchObject({ direct: true, adopted: true, branch: 'main' })
    expect(await gitOut(source, ['branch', '--show-current'])).toBe('main')
  })
})
