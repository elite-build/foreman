import { existsSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Environment } from '../src/main/environment'
import { compileRules, filesToCopy, matches } from '../src/main/filesToCopy'
import { git, gitOut } from '../src/main/git'
import { fromToml, patchLocal, readSharedLayer, resolveRepoSettings, SHARED_SETTINGS_FILES } from '../src/main/repoSettings'
import { SecretStore, type Encryptor } from '../src/main/secrets'
import { defaultSettings, Store } from '../src/main/store'
import { WorkspaceService } from '../src/main/workspaces'
import { parseDotenv } from '../src/shared/envfile'
import type { Repo, Workspace } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'
import { wsPath } from '../src/shared/workspacePath'

// Reversible "encryption" so the vault can be written in tests.
const plain: Encryptor = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }

async function setup() {
  const dataDir = await tempDir('switchyard-data-')
  const store = new Store(dataDir)
  await store.load()
  store.state.settings.workspacesRoot = await tempDir('switchyard-ws-')
  store.state.settings.branchPrefixType = 'custom'
  store.state.settings.branchPrefix = 'test/'
  const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), plain)
  const environment = new Environment(secrets, () => store.state.settings, (id) => service.repo(id))
  const service: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog() {} }, environment)
  return { store, service, secrets, environment }
}

async function ready(ws: Workspace): Promise<void> {
  for (let i = 0; i < 300 && !['ready', 'setup-failed', 'error'].includes(ws.state); i++) await new Promise((r) => setTimeout(r, 50))
  expect(ws.error).toBeUndefined()
  expect(ws.state).toBe('ready')
}

describe('dotenv parsing', () => {
  it('handles comments, export, quotes and escapes', () => {
    const { pairs, invalid } = parseDotenv(['# note', 'export A=1', 'B="two\\nlines"', "C='$literal'", 'D=x # trailing', '1BAD=no'].join('\n'))
    expect(pairs).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: 'two\nlines' },
      { key: 'C', value: '$literal' },
      { key: 'D', value: 'x' }
    ])
    expect(invalid).toEqual(['1BAD'])
  })

  it('joins quoted values across lines when pasting', () => {
    const { pairs } = parseDotenv('KEY="line one\nline two"\nNEXT=1', { multiline: true })
    expect(pairs).toEqual([
      { key: 'KEY', value: 'line one\nline two' },
      { key: 'NEXT', value: '1' }
    ])
  })
})

describe('files to copy patterns', () => {
  it('follows gitignore rules: names at any depth, anchors, folders and negation', () => {
    const rules = compileRules(['.env*', '!.env.example', '/config/local.json', 'secrets/'])
    expect(matches(rules, '.env')).toBe(true)
    expect(matches(rules, 'apps/web/.env.local')).toBe(true)
    expect(matches(rules, '.env.example')).toBe(false)
    expect(matches(rules, 'config/local.json')).toBe(true)
    expect(matches(rules, 'apps/config/local.json')).toBe(false)
    expect(matches(rules, 'secrets/')).toBe(true)
    expect(matches(rules, 'secrets/key.pem')).toBe(true)
    expect(matches(rules, 'secrets')).toBe(false)
  })

  it('only selects files git ignores', async () => {
    const repo = await makeRepo({ '.gitignore': '.env*\nnode_modules/\n', 'README.md': 'hi\n' })
    await writeFile(path.join(repo, '.env'), 'A=1\n')
    await writeFile(path.join(repo, '.env.local'), 'B=1\n')
    await mkdir(path.join(repo, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(path.join(repo, 'node_modules', 'pkg', 'index.js'), '')
    expect(await filesToCopy(repo, ['.env*'])).toEqual(['.env', '.env.local'])
    expect(await filesToCopy(repo, ['node_modules/'])).toEqual(['node_modules/'])
    expect(await filesToCopy(repo, ['README.md'])).toEqual([])
  })
})

describe('layered repo settings', () => {
  it('reads only this app\'s current and earlier shared settings locations, preferring the current one', async () => {
    expect(SHARED_SETTINGS_FILES).toEqual([path.join('.foreman', 'settings.toml'), path.join('.switchyard', 'settings.toml')])
    const root = await tempDir('foreman-shared-settings-')
    await mkdir(path.join(root, '.switchyard'))
    await writeFile(path.join(root, '.switchyard', 'settings.toml'), '[scripts]\nsetup = "earlier setup"\n')
    expect(readSharedLayer(root).values.setupScript).toBe('earlier setup')
    await mkdir(path.join(root, '.foreman'))
    await writeFile(path.join(root, '.foreman', 'settings.toml'), '[scripts]\nsetup = "current setup"\n')
    expect(readSharedLayer(root).values.setupScript).toBe('current setup')
  })

  it('maps shared settings.toml keys', () => {
    const { values, env } = fromToml({
      scripts: { setup: 'npm i', run_mode: 'concurrent', run: { dev: { command: 'npm run dev', default: true }, test: 'npm test' } },
      git: { archive_on_merge: true },
      prompts: { create_pr: 'Be brief' },
      preview_urls: [{ name: 'App', url: 'http://localhost:$FOREMAN_PORT' }],
      environment_variables: { A: '1', B: '<none>' }
    })
    expect(values.setupScript).toBe('npm i')
    expect(values.runMode).toBe('concurrent')
    expect(values.runScripts?.map((s) => s.name)).toEqual(['dev', 'test'])
    expect(values.archiveOnMerge).toBe(true)
    expect(values.prompts).toEqual({ createPr: 'Be brief' })
    expect(values.previewUrls).toEqual([{ name: 'App', url: 'http://localhost:$FOREMAN_PORT' }])
    expect(env).toEqual({ A: '1', B: null })
  })

  it('takes local over shared over user over default, and resets to inherit', async () => {
    const root = await makeRepo()
    await mkdir(path.join(root, '.foreman'))
    await writeFile(path.join(root, '.foreman', 'settings.toml'), '[scripts]\nsetup = "shared setup"\n[scripts.run.dev]\ncommand = "dev"\n')
    const user = { ...defaultSettings(), archiveOnMerge: true }
    const repo: Repo = { id: 'r', name: 'r', rootPath: root, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: '' }

    let resolved = resolveRepoSettings(repo, user)
    expect(resolved.values.setupScript).toBe('shared setup')
    expect(resolved.sources.setupScript).toBe('shared')
    expect(resolved.values.archiveOnMerge).toBe(true)
    expect(resolved.sources.archiveOnMerge).toBe('user')
    expect(resolved.values.filesToCopy).toEqual(['.env*'])
    expect(resolved.sources.filesToCopy).toBeUndefined()

    repo.local = patchLocal(repo.local, { setupScript: 'local setup', runScripts: [{ name: 'dev', command: 'local dev', icon: 'play' }] })
    resolved = resolveRepoSettings(repo, user)
    expect(resolved.values.setupScript).toBe('local setup')
    expect(resolved.sources.setupScript).toBe('local')
    expect(resolved.values.runScripts).toEqual([{ name: 'dev', command: 'local dev', icon: 'play', source: 'local', overrides: true, default: true }])

    repo.local = patchLocal(repo.local, { setupScript: null })
    expect(resolveRepoSettings(repo, user).values.setupScript).toBe('shared setup')
  })
})

describe('checks and sensitive paths settings', () => {
  const mkRepo = (root: string): Repo => ({ id: 'r', name: 'r', rootPath: root, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: '' })

  it('start empty, so nothing is configured', async () => {
    const resolved = resolveRepoSettings(mkRepo(await makeRepo()), defaultSettings())
    expect(resolved.values.checks).toEqual([])
    expect(resolved.values.sensitivePaths).toEqual([])
    // Automatic checks are opt-in.
    expect(resolved.values.checksAfterTurn).toBe(false)
    expect(resolved.sources.checks).toBeUndefined()
    expect(resolved.sources.sensitivePaths).toBeUndefined()
  })

  it('layers checksAfterTurn: shared file, then this computer', async () => {
    expect(fromToml({ scripts: { checks_after_turn: true } }).values.checksAfterTurn).toBe(true)
    const repo = mkRepo(await makeRepo())
    repo.local = patchLocal(repo.local, { checksAfterTurn: true })
    const resolved = resolveRepoSettings(repo, defaultSettings())
    expect(resolved.values.checksAfterTurn).toBe(true)
    expect(resolved.sources.checksAfterTurn).toBe('local')
    repo.local = patchLocal(repo.local, { checksAfterTurn: null })
    expect(resolveRepoSettings(repo, defaultSettings()).values.checksAfterTurn).toBe(false)
  })

  it('reads [[checks]] and sensitive_paths from settings.toml', () => {
    const { values } = fromToml({
      checks: [{ name: 'test', command: 'npm test' }, { name: 'lint', command: 'npm run lint' }, { name: 'bad' }, { name: 'test', command: 'dup' }],
      sensitive_paths: ['**/migrations/**', ' .env* ', '']
    })
    expect(values.checks).toEqual([
      { name: 'test', command: 'npm test' },
      { name: 'lint', command: 'npm run lint' }
    ])
    expect(values.sensitivePaths).toEqual(['**/migrations/**', '.env*'])
  })

  it('layers local over shared by name, with provenance, and resets to the shared entry', async () => {
    const root = await makeRepo()
    await mkdir(path.join(root, '.foreman'))
    await writeFile(
      path.join(root, '.foreman', 'settings.toml'),
      'sensitive_paths = ["package-lock.json"]\n[[checks]]\nname = "test"\ncommand = "npm test"\n[[checks]]\nname = "lint"\ncommand = "npm run lint"\n'
    )
    const repo = mkRepo(root)
    const user = defaultSettings()
    let resolved = resolveRepoSettings(repo, user)
    expect(resolved.values.checks).toEqual([
      { name: 'test', command: 'npm test', source: 'shared' },
      { name: 'lint', command: 'npm run lint', source: 'shared' }
    ])
    expect(resolved.sources.checks).toBe('shared')
    expect(resolved.sources.sensitivePaths).toBe('shared')

    repo.local = patchLocal(repo.local, {
      checks: [
        { name: 'test', command: 'npm test -- --bail' },
        { name: 'types', command: 'tsc' }
      ],
      sensitivePaths: ['.env*']
    })
    resolved = resolveRepoSettings(repo, user)
    expect(resolved.values.checks).toEqual([
      { name: 'test', command: 'npm test -- --bail', source: 'local', overrides: true },
      { name: 'lint', command: 'npm run lint', source: 'shared' },
      { name: 'types', command: 'tsc', source: 'local' }
    ])
    expect(resolved.sources.checks).toBe('local')
    expect(resolved.inherited.checks).toBe('shared')
    expect(resolved.values.sensitivePaths).toEqual(['.env*'])
    expect(resolved.sources.sensitivePaths).toBe('local')
    expect(resolved.inherited.sensitivePaths).toBe('shared')

    repo.local = patchLocal(repo.local, { checks: null, sensitivePaths: null })
    resolved = resolveRepoSettings(repo, user)
    expect(resolved.values.checks.map((c) => c.command)).toEqual(['npm test', 'npm run lint'])
    expect(resolved.values.sensitivePaths).toEqual(['package-lock.json'])
  })
})

describe('environment variables', () => {
  it('layers user files, user vars, the shared file and repo vars', async () => {
    const { store, service, secrets, environment } = await setup()
    const root = await makeRepo({ '.gitignore': '.env\n' })
    await writeFile(path.join(root, '.env'), 'FROM_REPO_FILE=1\nSHARED=file\n')
    await mkdir(path.join(root, '.foreman'))
    await writeFile(path.join(root, '.foreman', 'settings.toml'), '[environment_variables]\nSHARED = "toml"\nGONE = "<none>"\n')
    const userFile = path.join(await tempDir(), 'user.env')
    await writeFile(userFile, 'FROM_USER_FILE=1\nGONE=user\n')
    store.state.settings.envFiles = [userFile]
    const repo = await service.addRepo(root)
    service.updateRepoSettings(repo.id, { envFiles: ['.env'] })
    secrets.set({ kind: 'user' }, 'TOKEN', 'user')
    secrets.set({ kind: 'repo', repoId: repo.id }, 'TOKEN', 'repo')

    const vars = environment.vars(repo.id)
    expect(vars.FROM_USER_FILE).toBe('1')
    expect(vars.FROM_REPO_FILE).toBe('1')
    // The repo's own env file is applied after the shared settings.toml.
    expect(vars.SHARED).toBe('file')
    expect(vars.GONE).toBeUndefined()
    expect(vars.TOKEN).toBe('repo')
    expect(environment.vars().TOKEN).toBe('user')

    const view = environment.view({ kind: 'repo', repoId: repo.id })
    expect(view.inherited?.find((r) => r.key === 'TOKEN')?.overridden).toBe(true)
    expect(environment.reveal({ kind: 'repo', repoId: repo.id }, 'TOKEN', 'inherited')).toBe('user')
  })

  it('migrates the old four-key secret file', async () => {
    const file = path.join(await tempDir(), 'secrets.bin')
    await writeFile(file, JSON.stringify({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', OPENROUTER_API_KEY: 'r' }))
    const secrets = new SecretStore(file, plain)
    secrets.load()
    expect(secrets.vars({ kind: 'user' })).toEqual({ ANTHROPIC_API_KEY: 'a', CODEX_API_KEY: 'o' })
    expect(secrets.providerKeys()).toEqual({ OPENROUTER_API_KEY: 'r' })
  })
})

describe('workspace variables', () => {
  it('sets only FOREMAN_* and the older SWITCHYARD_* workspace variables', async () => {
    const { service } = await setup()
    const repo = await service.addRepo(await makeRepo())
    const ws = await service.createWorkspace(repo.id)
    await ready(ws)
    const env = service.env(ws)
    const names = ['WORKSPACE_ID', 'WORKSPACE_NAME', 'WORKSPACE_PATH', 'ROOT_PATH', 'DEFAULT_BRANCH', 'PORT']
    expect(Object.keys(env).sort()).toEqual(['FOREMAN', 'SWITCHYARD'].flatMap((prefix) => names.map((name) => `${prefix}_${name}`)).sort())
    for (const prefix of ['FOREMAN', 'SWITCHYARD']) {
      expect(env[`${prefix}_PORT`]).toBe(String(ws.portBase))
      expect(env[`${prefix}_WORKSPACE_PATH`]).toBe(ws.path)
    }
    const cloud = service.env({ ...ws, cloud: { provider: 'docker', cwd: '/sandbox/repo' } } as Workspace)
    const cloudNames = names.filter((name) => name !== 'PORT').concat('IS_CLOUD')
    expect(Object.keys(cloud).sort()).toEqual(['FOREMAN', 'SWITCHYARD'].flatMap((prefix) => cloudNames.map((name) => `${prefix}_${name}`)).sort())
    expect(cloud.FOREMAN_WORKSPACE_PATH).toBe('/sandbox/repo')
    expect(cloud.SWITCHYARD_IS_CLOUD).toBe('1')
  })
})

describe('new workspace options', () => {
  it('starts from a chosen branch with a chosen name', async () => {
    const { service } = await setup()
    const root = await makeRepo()
    await git(root, ['branch', 'release'])
    const repo = await service.addRepo(root)
    const ws = await service.createWorkspace(repo.id, { baseBranch: 'release', branch: { kind: 'new', name: 'feature/login' } })
    await ready(ws)
    expect(ws.branch).toBe('feature/login')
    expect(ws.placeholderBranch).toBeUndefined()
    expect(ws.baseBranch).toBe('release')
    expect(await gitOut(wsPath(ws), ['branch', '--show-current'])).toBe('feature/login')
  })

  it('checks out an existing branch, refusing one in use', async () => {
    const { service } = await setup()
    const root = await makeRepo()
    await git(root, ['branch', 'hotfix'])
    const repo = await service.addRepo(root)
    const ws = await service.createWorkspace(repo.id, { branch: { kind: 'existing', name: 'hotfix' } })
    await ready(ws)
    expect(ws.name).toBe('hotfix')
    expect(await gitOut(wsPath(ws), ['branch', '--show-current'])).toBe('hotfix')
    await expect(service.createWorkspace(repo.id, { branch: { kind: 'existing', name: 'hotfix' } })).rejects.toThrow(/already checked out/)
    const branches = await service.listBranches(repo.id)
    expect(branches[0]).toMatchObject({ name: 'main', isDefault: true })
    // native: git reports a long name where the temporary folder may have a Windows short (8.3) one.
    expect(realpathSync.native(branches.find((b) => b.name === 'hotfix')!.checkedOutAt!)).toBe(realpathSync.native(wsPath(ws)))
  })

  it('adopts an existing worktree and leaves it on disk when archived', async () => {
    const { service } = await setup()
    const root = await makeRepo()
    const outside = path.join(await tempDir(), 'spike')
    await git(root, ['worktree', 'add', '-b', 'spike', outside])
    const repo = await service.addRepo(root)

    const trees = await service.listWorktrees(repo.id)
    expect(trees.map((t) => t.isMain)).toEqual([true, false])
    await expect(service.adoptWorktree(repo.id, root, { runSetup: false })).rejects.toThrow(/main checkout/)

    const ws = await service.adoptWorktree(repo.id, outside, { runSetup: false })
    expect(ws).toMatchObject({ adopted: true, branch: 'spike', state: 'ready' })
    expect((await service.listWorktrees(repo.id))[1].workspaceId).toBe(ws.id)

    await service.archiveWorkspace(ws.id, true)
    expect(existsSync(outside)).toBe(true)
    expect(await gitOut(root, ['branch', '--list', 'spike'])).toContain('spike')
    await service.unarchiveWorkspace(ws.id)
    expect(ws.state).toBe('ready')
  })
})
