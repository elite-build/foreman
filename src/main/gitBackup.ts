// Readable, versioned configuration backups in a Git repository. The remote is
// cloned into a fresh temporary checkout for each operation, so no user worktree
// or index is touched. The encrypted vault and operational database stay local.
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GitBackupConfig, GitBackupFiles, GitBackupPreview, GitBackupRepo, GitBackupRestoreChoice, GitBackupRestoreResult, GitBackupRunResult, GitBackupStatus, GitBackupWorkspace } from '../shared/gitBackup'
import { GIT_BACKUP_FOLDER, GIT_BACKUP_VERSION } from '../shared/gitBackup'
import { normalizeRemoteUrl } from '../shared/portable'
import { parseHiddenModels } from '../shared/modelVisibility'
import type { PromptTemplate, Repo, Settings } from '../shared/types'
import { git, gitOut, hasRemote, isInsideWorkTree, repoEvidence, revParse, toplevel } from './git'
import { credentialHelperEnv, gh, githubAccounts, githubEnvAsync, githubSlug } from './github'
import { exportIntegrationChoices, importIntegrationChoices } from '../shared/integrations'
import { defaultSettings, type Store } from './store'
import { defaultRepoSettings } from './repoSettings'
import type { SecretStore } from './secrets'
import type { WorkspaceService } from './workspaces'

const FILES = ['settings', 'templates', 'repositories', 'workspaces', 'variable-names'] as const
const MAX_FILE_BYTES = 5 * 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
const PATH_SETTINGS = ['workspacesRoot', 'cloneDirectory', 'backupFolder', 'claudeExecutablePath', 'codexExecutablePath', 'opencodeExecutablePath'] as const

type Payload = GitBackupFiles
type Stage = { files: Payload; preview: GitBackupPreview }
type GitBackupDeps = {
  store: Store
  secrets: SecretStore
  workspaces: WorkspaceService
  updateSettings: (patch: Partial<Settings>) => Promise<Settings>
  startChat: (workspaceId: string) => void
  changed: () => void
  now?: () => Date
  beforePush?: () => Promise<void>
}

const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const samePath = (a: string, b: string): boolean => {
  const normalize = (value: string) => {
    let resolved: string
    try { resolved = realpathSync.native(value) }
    catch { resolved = path.resolve(value) }
    return process.platform === 'linux' ? resolved : resolved.toLowerCase()
  }
  return normalize(a) === normalize(b)
}
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'

function checkedRemote(url: string): string {
  const clean = url.trim()
  if (!clean || /[\r\n\x00]/.test(clean) || /^https?:\/\/[^/]*@/i.test(clean) || clean.startsWith('-'))
    throw new Error('Enter a Git remote URL without an embedded username or password.')
  return clean
}

export async function createPrivateGithubRepo(name: string, account?: string, run: typeof gh = gh, list: typeof githubAccounts = githubAccounts): Promise<string> {
  const clean = name.trim()
  if (!/^[\w.-]+$/.test(clean) || clean === '.' || clean === '..') throw new Error('Use a repository name with letters, numbers, dots, dashes or underscores.')
  const owner = account || (await list()).find((a) => a.active)?.login
  const slug = owner ? `${owner}/${clean}` : clean
  await run(process.cwd(), ['repo', 'create', slug, '--private', '--add-readme'], 60_000, account)
  return (await run(process.cwd(), ['repo', 'view', slug, '--json', 'url', '--jq', '.url'], 20_000, account)).trim()
}

function matches(a: { rootPath: string; remoteUrl?: string; rootCommit?: string }, b: { rootPath: string; remoteUrl?: string; rootCommit?: string }): boolean {
  if (samePath(a.rootPath, b.rootPath)) return true
  if (a.remoteUrl && b.remoteUrl && normalizeRemoteUrl(a.remoteUrl) === normalizeRemoteUrl(b.remoteUrl)) return true
  return Boolean(a.rootCommit && b.rootCommit && a.rootCommit === b.rootCommit)
}

function validTemplate(v: unknown): v is PromptTemplate {
  return object(v) && str(v.id) && v.id.length <= 200 && str(v.name) && v.name.length <= 300 && str(v.body) && v.body.length <= 200_000 &&
    (v.startModel === undefined || (object(v.startModel) && str(v.startModel.agent) && str(v.startModel.model))) &&
    (v.followUp === undefined || (object(v.followUp) && str(v.followUp.title) && str(v.followUp.prompt)))
}

function validRepo(v: unknown): v is GitBackupRepo {
  return object(v) && str(v.id) && str(v.name) && str(v.rootPath) && str(v.defaultBranch) && str(v.remote) && object(v.local) &&
    (v.remoteUrl === undefined || str(v.remoteUrl)) && (v.rootCommit === undefined || str(v.rootCommit)) &&
    (v.githubAccount === undefined || str(v.githubAccount)) && validRepoLocal(v.local)
}

function validRepoLocal(local: Record<string, unknown>): boolean {
  const defaults = defaultRepoSettings() as unknown as Record<string, unknown>
  return Object.entries(local).every(([key, value]) => {
    if (!(key in defaults)) return false
    if (key === 'prompts') return object(value) && Object.values(value).every(str)
    const expected = defaults[key]
    if (Array.isArray(expected)) {
      if (!Array.isArray(value)) return false
      if (['sensitivePaths', 'filesToCopy', 'envFiles'].includes(key)) return value.every(str)
      if (key === 'runScripts') return value.every((x) => object(x) && str(x.name) && str(x.command))
      if (key === 'checks') return value.every((x) => object(x) && str(x.name) && str(x.command))
      if (key === 'previewUrls') return value.every((x) => object(x) && str(x.name) && str(x.url))
      return true
    }
    return typeof value === typeof expected
  })
}

function validWorkspace(v: unknown): v is GitBackupWorkspace {
  return object(v) && str(v.id) && str(v.repoId) && str(v.name) && str(v.branch) && str(v.baseBranch) && str(v.path) &&
    (v.direct === undefined || typeof v.direct === 'boolean') && (v.pinned === undefined || typeof v.pinned === 'boolean') &&
    (v.status === undefined || ['backlog', 'in-progress', 'in-review', 'done', 'canceled'].includes(String(v.status)))
}

/** Fixed file names and a narrow version check keep remote data out of arbitrary app state. */
export function parseGitBackup(raw: Record<string, unknown>): Payload {
  const manifest = raw.manifest
  if (!object(manifest) || manifest.format !== 'foreman-git-backup' || manifest.version !== GIT_BACKUP_VERSION || !str(manifest.createdAt))
    throw new Error('This is not a supported Foreman Git backup.')
  const settings = raw.settings
  const templates = raw.templates
  const repositories = raw.repositories
  const workspaces = raw.workspaces
  const variableNames = raw['variable-names']
  if (!object(settings) || !Array.isArray(templates) || !templates.every(validTemplate) || !Array.isArray(repositories) || !repositories.every(validRepo) ||
      !Array.isArray(workspaces) || !workspaces.every(validWorkspace) || !object(variableNames) || !Array.isArray(variableNames.user) ||
      !variableNames.user.every(str) || !object(variableNames.repos) || !Object.values(variableNames.repos).every((v) => Array.isArray(v) && v.every(str)))
    throw new Error('The Foreman Git backup contains malformed configuration.')
  const defaults = defaultSettings() as unknown as Record<string, unknown>
  const cleanSettings: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'promptTemplates' || !(key in defaults)) continue
    const expected = defaults[key]
    if (Array.isArray(expected) ? !Array.isArray(value) : object(expected) ? !object(value) : typeof value !== typeof expected)
      throw new Error(`The backup has an invalid ${key} setting.`)
    if (['envFiles', 'opencodeModels'].includes(key) && !(value as unknown[]).every(str)) throw new Error(`The backup has an invalid ${key} setting.`)
    if (key === 'loadouts' && !(value as unknown[]).every((x) => object(x) && str(x.agent) && str(x.model) && typeof x.fast === 'boolean'))
      throw new Error('The backup has invalid model loadouts.')
    if (key === 'reviewModel' && (!object(value) || !str(value.agent) || !str(value.model) || typeof value.fast !== 'boolean'))
      throw new Error('The backup has an invalid review model.')
    // O8: hidden models are checked id by id, as when they're loaded.
    cleanSettings[key] = key === 'hiddenModels' ? parseHiddenModels(value) : value
  }
  if (new Set(repositories.map((r) => r.id)).size !== repositories.length || new Set(workspaces.map((w) => w.id)).size !== workspaces.length ||
      new Set(templates.map((t) => t.id)).size !== templates.length) throw new Error('The backup contains duplicate IDs.')
  return { manifest: manifest as unknown as Payload['manifest'], settings: cleanSettings as unknown as Payload['settings'], templates, repositories, workspaces,
    variableNames: variableNames as unknown as Payload['variableNames'] }
}

/** The gh account a repository explicitly uses (Integrations), which a backup records by login. Tokens and other services stay out. */
function githubLoginOf(store: Store, repo: Store['state']['repos'][number]): string | undefined {
  const id = repo.integrations?.services?.github
  const c = id ? store.state.integrations?.connections.find((x) => x.id === id) : undefined
  return c?.auth.kind === 'gh-account' ? c.auth.login : repo.githubAccount
}

export function makeGitBackupFiles(store: Store, secrets: SecretStore, at: Date): Payload {
  const { promptTemplates, ...settings } = store.state.settings
  const repositories: GitBackupRepo[] = store.state.repos.map((repo) => ({
    id: repo.id, name: repo.name, rootPath: repo.rootPath, ...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl } : {}),
    ...(repo.rootCommit ? { rootCommit: repo.rootCommit } : {}), defaultBranch: repo.defaultBranch, remote: repo.remote,
    local: repo.local, ...(repo.icon ? { icon: repo.icon } : {}), ...(githubLoginOf(store, repo) ? { githubAccount: githubLoginOf(store, repo) } : {}),
    ...(exportIntegrationChoices(store.state.integrations, repo) ? { integrations: exportIntegrationChoices(store.state.integrations, repo) } : {})
  })).sort((a, b) => a.id.localeCompare(b.id))
  const workspaces: GitBackupWorkspace[] = store.state.workspaces
    .filter((ws) => ws.state !== 'archived' && ws.state !== 'history' && Boolean(ws.path))
    .map((ws) => ({ id: ws.id, repoId: ws.repoId, name: ws.name, branch: ws.branch, baseBranch: ws.baseBranch, path: ws.path!,
      ...(ws.direct ? { direct: true } : {}), ...(ws.pinned ? { pinned: true } : {}), ...(ws.status ? { status: ws.status } : {}) }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const repos: Record<string, string[]> = {}
  for (const repo of repositories) repos[repo.id] = Object.keys(secrets.vars({ kind: 'repo', repoId: repo.id })).sort()
  return {
    manifest: { format: 'foreman-git-backup', version: GIT_BACKUP_VERSION, createdAt: at.toISOString() },
    settings, templates: promptTemplates, repositories, workspaces,
    variableNames: { user: Object.keys(secrets.vars({ kind: 'user' })).sort(), repos }
  }
}

export class GitBackupService {
  private running: Promise<GitBackupRunResult> | null = null
  private stages = new Map<string, Stage>()
  private timer: NodeJS.Timeout | null = null
  private initialTimer: NodeJS.Timeout | null = null

  constructor(private deps: GitBackupDeps) {}

  status(): GitBackupStatus { return { ...this.deps.store.state.gitBackup } }

  async configure(config: GitBackupConfig): Promise<GitBackupStatus> {
    const remoteUrl = checkedRemote(config.remoteUrl)
    const previous = this.status()
    if (previous.config?.remoteUrl !== remoteUrl || previous.config?.account !== config.account) {
      const out = await git(process.cwd(), ['ls-remote', '--symref', '--', remoteUrl, 'HEAD'], { env: await this.env(remoteUrl, config.account), timeoutMs: 30_000 })
      if (!out.stdout.includes('HEAD')) throw new Error('The destination has no default branch. Initialize it with a README first.')
    }
    this.deps.store.state.gitBackup = {
      ...previous, config: { remoteUrl, ...(config.account ? { account: config.account } : {}), daily: Boolean(config.daily) },
      lastError: undefined,
      ...(previous.config?.remoteUrl !== remoteUrl || previous.config?.account !== config.account ? { lastSuccessAt: undefined, lastAttemptAt: undefined } : {})
    }
    this.deps.changed()
    return this.status()
  }

  async createGithub(name: string, account?: string): Promise<GitBackupStatus> {
    const remoteUrl = await createPrivateGithubRepo(name, account)
    return this.configure({ remoteUrl, account, daily: false })
  }

  private async env(remoteUrl: string, account?: string): Promise<Record<string, string>> {
    if (!githubSlug(remoteUrl)) return {}
    const env = await githubEnvAsync(account)
    return env.GH_TOKEN ? { ...env, ...credentialHelperEnv() } : env
  }

  private async checkout<T>(remoteUrl: string, account: string | undefined, work: (dir: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'foreman-git-backup-'))
    const dir = path.join(root, 'repo')
    try {
      await git(root, ['clone', '--quiet', '--single-branch', '--depth=1', '--', checkedRemote(remoteUrl), dir], { env: await this.env(remoteUrl, account), timeoutMs: 120_000 })
      return await work(dir)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  backupNow(): Promise<GitBackupRunResult> {
    this.running ??= this.backup().finally(() => { this.running = null })
    return this.running
  }

  private async backup(): Promise<GitBackupRunResult> {
    const config = this.status().config
    if (!config) throw new Error('Choose a Git backup destination first.')
    const at = (this.deps.now ?? (() => new Date()))()
    this.deps.store.state.gitBackup = { ...this.status(), lastAttemptAt: at.toISOString(), lastError: undefined }
    this.deps.changed()
    try {
      const files = makeGitBackupFiles(this.deps.store, this.deps.secrets, at)
      const changed = await this.checkout(config.remoteUrl, config.account, async (dir) => {
        const folder = path.join(dir, GIT_BACKUP_FOLDER)
        if (existsSync(folder) && existsSync(path.join(folder, 'manifest.json'))) await this.readFiles(dir)
        let different = !existsSync(path.join(folder, 'manifest.json'))
        for (const key of FILES) {
          const name = key === 'variable-names' ? 'variable-names.json' : `${key}.json`
          const current = await readFile(path.join(folder, name), 'utf8').catch(() => '')
          // Git may check JSON out with CRLF on Windows; that is not a configuration change.
          if (current.replace(/\r\n/g, '\n') !== json(key === 'variable-names' ? files.variableNames : files[key])) different = true
        }
        if (!different) return false
        await mkdir(folder, { recursive: true })
        await writeFile(path.join(folder, 'manifest.json'), json(files.manifest))
        for (const key of FILES) await writeFile(path.join(folder, `${key}.json`), json(key === 'variable-names' ? files.variableNames : files[key]))
        await git(dir, ['add', '--', GIT_BACKUP_FOLDER])
        await git(dir, ['-c', 'user.name=Foreman Backup', '-c', 'user.email=backup@foreman.local', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Back up Foreman configuration'])
        const branch = await gitOut(dir, ['symbolic-ref', '--short', 'HEAD'])
        await this.deps.beforePush?.()
        await git(dir, ['push', 'origin', `HEAD:refs/heads/${branch}`], { env: await this.env(config.remoteUrl, config.account), timeoutMs: 120_000 })
        return true
      })
      this.deps.store.state.gitBackup = { ...this.status(), lastSuccessAt: at.toISOString(), lastError: undefined }
      this.deps.changed()
      return { changed, at: at.toISOString(), remoteUrl: config.remoteUrl }
    } catch (err) {
      this.deps.store.state.gitBackup = { ...this.status(), lastError: err instanceof Error ? err.message : String(err) }
      this.deps.changed()
      throw err
    }
  }

  async backupIfDue(): Promise<GitBackupRunResult | undefined> {
    const status = this.status()
    if (!status.config?.daily) return undefined
    if (status.lastSuccessAt && (this.deps.now ?? (() => new Date()))().getTime() - new Date(status.lastSuccessAt).getTime() < DAY_MS) return undefined
    return this.backupNow()
  }

  start(): void {
    const tick = () => void this.backupIfDue().catch(() => undefined)
    this.initialTimer = setTimeout(tick, 30_000)
    this.initialTimer.unref()
    this.timer = setInterval(tick, 30 * 60_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer)
    if (this.timer) clearInterval(this.timer)
    this.initialTimer = null
    this.timer = null
  }

  private async readFiles(dir: string): Promise<Payload> {
    const raw: Record<string, unknown> = {}
    for (const key of ['manifest', ...FILES]) {
      const file = path.join(dir, GIT_BACKUP_FOLDER, `${key}.json`)
      const info = await stat(file).catch(() => null)
      if (!info?.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`The backup has no valid ${key}.json file.`)
      try { raw[key] = JSON.parse(await readFile(file, 'utf8')) }
      catch { throw new Error(`The backup has an invalid ${key}.json file.`) }
    }
    return parseGitBackup(raw)
  }

  async preview(remoteUrl: string, account?: string): Promise<GitBackupPreview> {
    const files = await this.checkout(remoteUrl, account, (dir) => this.readFiles(dir))
    const current = this.deps.store.state
    const accounts = new Set((await githubAccounts().catch(() => [])).map((a) => a.login))
    const stageId = randomUUID()
    const machinePaths: GitBackupPreview['machinePaths'] = PATH_SETTINGS.flatMap((key) => {
      const value = files.settings[key]
      return typeof value === 'string' && value ? [{ key, saved: value, available: existsSync(value) }] : []
    })
    for (const file of files.settings.envFiles ?? []) machinePaths.push({ key: 'envFiles', saved: file, available: existsSync(file) })
    for (const repo of files.repositories) for (const file of repo.local.envFiles ?? [])
      machinePaths.push({ key: `repo:${repo.id}:envFiles`, saved: file, available: existsSync(file) })
    const localRepo = (id: string) => {
      const source = files.repositories.find((r) => r.id === id)
      if (!source) return undefined
      const found = current.repos.filter((candidate) => matches(source, candidate))
      return found.length === 1 ? found[0] : undefined
    }
    const preview: GitBackupPreview = {
      stageId, createdAt: files.manifest.createdAt,
      settingsChanged: Object.entries(files.settings).filter(([key, value]) => JSON.stringify(current.settings[key as keyof Settings]) !== JSON.stringify(value)).map(([key]) => key),
      machinePaths,
      templates: files.templates.map((t) => {
        const here = current.settings.promptTemplates.find((x) => x.id === t.id)
        return { id: t.id, name: t.name, action: here ? (JSON.stringify(here) === JSON.stringify(t) ? 'same' : 'update') : 'add' }
      }),
      repositories: files.repositories.map((r) => {
        const found = current.repos.filter((candidate) => matches(r, candidate))
        const matched = found.length === 1 ? found[0] : undefined
        return { ...r, ...(matched ? { suggestedPath: matched.rootPath, matchedRepoId: matched.id } : existsSync(r.rootPath) ? { suggestedPath: r.rootPath } : {}) }
      }),
      workspaces: files.workspaces.map((w) => ({ ...w,
        ...(existsSync(w.path) ? { suggestedPath: w.path } : {}),
        alreadyAdded: current.workspaces.some((here) => here.state !== 'archived' && Boolean(here.path) && samePath(here.path!, w.path))
      })),
      variableNames: files.variableNames,
      variableChecklist: [
        ...files.variableNames.user.map((name) => ({ scope: 'User', name, present: this.deps.secrets.get({ kind: 'user' }, name) !== undefined })),
        ...Object.entries(files.variableNames.repos).flatMap(([id, names]) => names.map((name) => {
          const local = localRepo(id)
          return { scope: files.repositories.find((r) => r.id === id)?.name ?? 'Repository', name,
            present: Boolean(local && this.deps.secrets.get({ kind: 'repo', repoId: local.id }, name) !== undefined) }
        }))
      ],
      unavailableAccounts: [...new Set(files.repositories.map((r) => r.githubAccount).filter((a): a is string => Boolean(a && !accounts.has(a))))]
    }
    this.stages.clear()
    this.stages.set(stageId, { files, preview })
    return preview
  }

  async restore(choice: GitBackupRestoreChoice): Promise<GitBackupRestoreResult> {
    const stage = this.stages.get(choice.stageId)
    if (!stage) throw new Error('Preview the Git backup again before restoring.')
    const { files, preview } = stage
    const result: GitBackupRestoreResult = { settings: 0, templates: 0, repositories: 0, workspaces: 0, skipped: [] }
    const { store, workspaces } = this.deps
    if (choice.categories.settings) {
      const patch: Record<string, unknown> = { ...files.settings }
      for (const { key, available } of preview.machinePaths) if (!available && !key.startsWith('repo:')) {
        delete patch[key]
        result.skipped.push(`Setting ${key}: saved path is unavailable`)
      }
      await this.deps.updateSettings(patch as Partial<Settings>)
      result.settings = Object.keys(patch).length
    }
    if (choice.categories.templates) {
      const byId = new Map(store.state.settings.promptTemplates.map((t) => [t.id, t]))
      for (const template of files.templates) byId.set(template.id, template)
      await this.deps.updateSettings({ promptTemplates: [...byId.values()] })
      result.templates = files.templates.length
    }
    const repoMap = new Map<string, Repo>()
    for (const entry of files.repositories) {
      const shown = preview.repositories.find((r) => r.id === entry.id)!
      const requested = Object.hasOwn(choice.repositoryPaths, entry.id) ? choice.repositoryPaths[entry.id].trim() : shown.suggestedPath
      if (requested === '') { result.skipped.push(`Repository ${entry.name}: skipped`); continue }
      const existing = requested
        ? store.state.repos.find((r) => samePath(r.rootPath, requested))
        : shown.matchedRepoId ? store.state.repos.find((r) => r.id === shown.matchedRepoId) : undefined
      if (!choice.categories.repositories && !choice.categories.workspaces) break
      if (!requested && !existing) { result.skipped.push(`Repository ${entry.name}: choose a local folder`); continue }
      const dir = requested ?? existing!.rootPath
      if (!existsSync(dir)) { result.skipped.push(`Repository ${entry.name}: folder is unavailable`); continue }
      let actual: { remoteUrl?: string; rootCommit?: string }
      try {
        if (!(await isInsideWorkTree(dir)) || !samePath(await toplevel(dir), dir)) throw new Error('not a repository root')
        actual = await repoEvidence(dir, entry.remote || 'origin')
      }
      catch { result.skipped.push(`Repository ${entry.name}: folder is not a Git repository`); continue }
      const remoteMatch = Boolean(entry.remoteUrl && actual.remoteUrl && normalizeRemoteUrl(entry.remoteUrl) === normalizeRemoteUrl(actual.remoteUrl))
      const rootMatch = Boolean(entry.rootCommit && actual.rootCommit && entry.rootCommit === actual.rootCommit)
      if ((entry.remoteUrl || entry.rootCommit) && !remoteMatch && !rootMatch) {
        result.skipped.push(`Repository ${entry.name}: Git identity does not match`); continue
      }
      if (!entry.remoteUrl && !entry.rootCommit && !samePath(dir, entry.rootPath)) {
        result.skipped.push(`Repository ${entry.name}: saved repository has no Git identity to verify this folder`); continue
      }
      let repo = existing
      if (!repo && choice.categories.repositories) {
        const availableAccount = entry.githubAccount && !preview.unavailableAccounts.includes(entry.githubAccount) ? entry.githubAccount : undefined
        try { repo = await workspaces.addRepo(dir, availableAccount) }
        catch { result.skipped.push(`Repository ${entry.name}: folder is not a Git repository`); continue }
        result.repositories++
      }
      if (!repo) continue
      repoMap.set(entry.id, repo)
      if (choice.categories.repositories) {
        repo.name = entry.name
        const local = { ...entry.local }
        if (preview.machinePaths.some((p) => p.key === `repo:${entry.id}:envFiles` && !p.available)) {
          local.envFiles = repo.local.envFiles
          result.skipped.push(`Repository ${entry.name}: saved environment file path is unavailable`)
        }
        repo.local = local
        repo.remoteUrl = actual.remoteUrl
        repo.rootCommit = actual.rootCommit
        if (entry.icon) repo.icon = entry.icon
        const importedChoices = importIntegrationChoices(entry.integrations)
        if (importedChoices) repo.integrations = importedChoices
        else if (entry.githubAccount && !preview.unavailableAccounts.includes(entry.githubAccount)) workspaces.githubDetected(repo.id, entry.githubAccount, true)
        if (await hasRemote(repo.rootPath, entry.remote)) {
          repo.remote = entry.remote
          repo.hasOrigin = true
        } else result.skipped.push(`Repository ${entry.name}: saved remote ${entry.remote} is unavailable`)
        if (await revParse(repo.rootPath, `refs/heads/${entry.defaultBranch}`) || await revParse(repo.rootPath, `refs/remotes/${repo.remote}/${entry.defaultBranch}`))
          repo.defaultBranch = entry.defaultBranch
        else result.skipped.push(`Repository ${entry.name}: saved base branch ${entry.defaultBranch} is unavailable`)
        this.deps.changed()
      }
    }
    if (choice.categories.workspaces) for (const entry of files.workspaces) {
      const repo = repoMap.get(entry.repoId)
      if (!repo) { result.skipped.push(`Workspace ${entry.name}: repository is not connected`); continue }
      const requested = Object.hasOwn(choice.workspacePaths, entry.id) ? choice.workspacePaths[entry.id].trim() : preview.workspaces.find((w) => w.id === entry.id)?.suggestedPath
      if (requested === '') { result.skipped.push(`Workspace ${entry.name}: skipped`); continue }
      if (!requested) { result.skipped.push(`Workspace ${entry.name}: choose an existing worktree`); continue }
      if (store.state.workspaces.some((w) => w.state !== 'archived' && w.path && samePath(w.path, requested))) continue
      try {
        const ws = await workspaces.reconnectWorkspace(repo.id, entry, requested)
        this.deps.startChat(ws.id)
        result.workspaces++
      } catch (err) { result.skipped.push(`Workspace ${entry.name}: ${err instanceof Error ? err.message : String(err)}`) }
    }
    this.stages.delete(choice.stageId)
    this.deps.changed()
    return result
  }
}
