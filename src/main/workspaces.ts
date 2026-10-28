// Repositories and workspaces. A workspace is a git worktree on its own
// branch, created from the repository's base branch, or (a direct workspace)
// the repository folder itself, working straight on one of its branches, or
// (a cloud workspace) a worktree in a cloud sandbox, through SandboxManager.
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { appendFile, cp, mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AccountDetection,
  ArchivedDiff,
  ArchivedWork,
  ArchiveReason,
  ArchiveProgress,
  SetupStep,
  SetupStepResult,
  PromptTemplate,
  BranchInfo,
  CreateWorkspaceOptions,
  Repo,
  RepoPatch,
  RepoSettings,
  RepoSettingsPatch,
  ResolvedRepoSettings,
  Workspace,
  WorkspacePatch,
  WorktreeInfo
} from '../shared/types'
import type { GitBackupWorkspace } from '../shared/gitBackup'
import { CHECKPOINT_REF_PREFIX, deleteCheckpoints, restoreCheckpoint, saveCheckpoint } from './checkpoints'
import type { Environment } from './environment'
import { excludeContextDir } from './files'
import { effectivePatterns, filesToCopy } from './filesToCopy'
import { baseStartPoint, busyOperation, detectDefaultBranch, git, hasRemote, isInsideWorkTree, repoEvidence, revParse, toplevel, type GitTarget } from './git'
import type { SandboxManager } from './cloud/sandboxes'
import { cleanRepoCloudPatch, cloudDefaults, repoCloud } from '../shared/cloud'
import { branchPrefix, detectAccount, githubAccounts, githubSlug, remoteGitEnv } from './github'
import { fetchPullHead, remoteForPullRequest } from './intake'
import { parseRepoTemplateId } from '../shared/repoTemplates'
import { readRepoTemplates } from './repoTemplates'
import { pickWorkspaceName } from './names'
import { findWorkspacePerson } from '../shared/workspacePeople'
import { agentBaseEnv, isWindows, safeDirName } from './platform'
import { allocatePortBlock, PORT_BLOCK_SIZE } from './ports'
import { patchLocal, resolveRepoSettings } from './repoSettings'
import { dockerCli, listContainers, removeContainers, type DockerRunner } from './docker'
import { dockerLeft, removalNeedsAttention, type DockerListing, type DockerRemoval } from '../shared/docker'
import { workspaceDiff } from './diff'
import { runSetupSteps, type SetupStepsRun } from './setupSteps'
import { clock, duration, failedStep, resumeIndex } from '../shared/setupSteps'
import type { Store } from './store'
import { NO_HOOKS } from './worktreeBundle'
import { isHistoryOnly, wsPath } from '../shared/workspacePath'
import { gitlabHostFor } from '../shared/scm'
import { parseLater } from '../shared/later'

/** #1: archiving stopped at a step that preserves work; nothing was deleted. */
export class ArchiveStepError extends Error {
  constructor(
    readonly step: 'checkpoint' | 'script',
    readonly detail: string
  ) {
    super(step === 'checkpoint' ? `Could not save the uncommitted changes (${detail}). Nothing was deleted.` : `The archive script failed (${detail}). Nothing was deleted.`)
  }
}

export interface WorkspaceEvents {
  changed(): void
  // O19: `step` when the chunk is a setup step's output.
  setupLog(workspaceId: string, chunk: string, step?: { index: number; runId: string }): void
  // Setup succeeded and the repo wants its run script started.
  setupFinished?(workspaceId: string): void
  // G3 · #1: an archive step started, finished or failed (the dialog shows them as they go).
  archiveProgress?(workspaceId: string, progress: ArchiveProgress): void
}

const ACTIVE: Workspace['state'][] = ['creating', 'setting-up', 'ready', 'setup-failed', 'error', 'history']

/** Compare paths the way the file system does: through symlinks, ignoring case where it's ignored. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let resolved = path.resolve(p)
    try {
      resolved = realpathSync.native(resolved)
    } catch {
      // Doesn't exist (yet); compare as written.
    }
    return process.platform === 'linux' ? resolved : resolved.toLowerCase()
  }
  return norm(a) === norm(b)
}

/** Between a worktree being ready and setup running, for a workspace created with deferSetup. */
interface SetupHold {
  prepared: Promise<void>
  go: Promise<string | undefined>
  reached: () => void
  fail: (err: Error) => void
  proceed: (abort?: string) => void
}

export class WorkspaceService {
  private setups = new Map<string, SetupStepsRun>()
  // G3 · O19: each workspace's last archive-steps run, so "Retry this step" carries on from the step that failed.
  private archiveRuns = new Map<string, SetupStepResult[]>()
  // O18: the docker CLI; tests swap in a stub.
  docker: DockerRunner = dockerCli
  // G2: lines about the repository's host for the agent's system prompt (glab on GitLab). Core sets it; it never waits.
  hostContext: (ws: Workspace) => string[] = () => []
  // Integrations (Core sets these): the GitHub identity key a repository runs as, a repository linked to a
  // gh account by detection (or a guess that no longer holds), and a repository added.
  githubKey: (repoId: string) => string | undefined = () => undefined
  // The same after asking gh afresh for its active account when the connection follows it (Integrations.githubKeyFresh).
  githubKeyFresh: (repoId: string) => Promise<string | undefined> = async (repoId) => this.githubKey(repoId)
  githubDetected: (repoId: string, login: string | null, explicit?: boolean) => void = () => undefined
  repoAdded: (repoId: string) => void = () => undefined
  // Cloud workspaces' sandboxes (Core sets it); without it, cloud workspaces can't be made or reached.
  cloud: SandboxManager | null = null

  constructor(
    private store: Store,
    private events: WorkspaceEvents,
    private environment: Environment
  ) {}

  private get state() {
    return this.store.state
  }

  /** G2: the relative URL root of a checked-out merge request's GitLab host, when it has one. */
  private gitlabRoot(pr: { gitlabHost?: string }): string | undefined {
    return pr.gitlabHost ? gitlabHostFor(pr.gitlabHost, this.state.settings.gitlabHosts ?? [])?.root : undefined
  }

  private changed() {
    this.store.save()
    this.events.changed()
  }

  repo(id: string): Repo {
    const repo = this.state.repos.find((r) => r.id === id)
    if (!repo) throw new Error('Repository not found')
    return repo
  }

  /** A template by id: one of the user's, or a repo's from .foreman/templates. */
  template(id: string | undefined): PromptTemplate | undefined {
    if (!id) return undefined
    const own = this.state.settings.promptTemplates.find((t) => t.id === id)
    if (own) return own
    const ref = parseRepoTemplateId(id)
    const repo = ref && this.state.repos.find((r) => r.id === ref.repoId)
    return repo ? readRepoTemplates(repo.id, repo.rootPath).find((t) => t.id === id) : undefined
  }

  workspace(id: string): Workspace {
    const ws = this.state.workspaces.find((w) => w.id === id)
    if (!ws) throw new Error('Workspace not found')
    return ws
  }

  // ---- repositories ----

  /** The repo's settings with every layer applied. */
  resolvedSettings(id: string): ResolvedRepoSettings {
    return resolveRepoSettings(this.repo(id), this.state.settings)
  }

  settingsFor(id: string): RepoSettings {
    return this.resolvedSettings(id).values
  }

  updateRepoSettings(id: string, patch: RepoSettingsPatch): void {
    const repo = this.repo(id)
    repo.local = patchLocal(repo.local, patch)
    this.changed()
  }

  /** With `account`, the new repo is linked to that gh account; otherwise Foreman tries to detect one. */
  async addRepo(dir: string, account?: string): Promise<Repo> {
    if (!(await isInsideWorkTree(dir))) throw new Error(`${dir} is not inside a git repository`)
    // git prints forward slashes on Windows; normalize for display and comparison.
    const root = path.normalize(await toplevel(dir))
    this.state.recentRepoPaths = [root, ...this.state.recentRepoPaths.filter((p) => !samePath(p, root))].slice(0, 20)
    const existing = this.state.repos.find((r) => samePath(r.rootPath, root))
    if (existing) {
      this.changed()
      return existing
    }
    const repo: Repo = {
      id: randomUUID(),
      name: path.basename(root),
      rootPath: root,
      defaultBranch: await detectDefaultBranch(root),
      remote: 'origin',
      hasOrigin: await hasRemote(root, 'origin'),
      ...(await repoEvidence(root, 'origin')),
      local: {},
      createdAt: new Date().toISOString()
    }
    this.state.repos.push(repo)
    // Cloned as a gh account: that account's connection, as the user's own choice.
    if (account) this.githubDetected(repo.id, account, true)
    this.repoAdded(repo.id)
    this.changed()
    if (!account) void this.detectRepoAccount(repo.id, true).catch(() => undefined)
    return repo
  }

  /**
   * Who GitHub work in this repository runs as (Integrations.githubKey): a gh login, an identity key
   * for a saved token, or undefined for gh's active account.
   */
  accountFor(repoId: string): string | undefined {
    if (!this.state.repos.some((r) => r.id === repoId)) return undefined
    return this.githubKey(repoId)
  }

  /** accountFor for callers that can wait, after gh is asked afresh who its active account is (git actions). */
  async accountForFresh(repoId: string): Promise<string | undefined> {
    if (!this.state.repos.some((r) => r.id === repoId)) return undefined
    return this.githubKeyFresh(repoId)
  }

  /** The URL the repo pushes to, or null without a remote. */
  async remoteUrl(repoId: string): Promise<string | null> {
    const repo = this.repo(repoId)
    const r = await git(repo.rootPath, ['remote', 'get-url', '--push', repo.remote], { allowFail: true })
    return r.code === 0 ? r.stdout.trim() || null : null
  }

  /**
   * Which signed-in gh account can push to the repo's GitHub remote. With save,
   * links the repo to it when there's exactly one.
   */
  async detectRepoAccount(repoId: string, save = false): Promise<AccountDetection> {
    const url = await this.remoteUrl(repoId)
    const slug = url ? githubSlug(url) : null
    if (!slug) return { slug: null, account: null, pushers: [] }
    const accounts = (await githubAccounts().catch(() => [])).map((a) => a.login)
    const result = { slug, ...(await detectAccount(slug, accounts)) }
    const repo = this.state.repos.find((r) => r.id === repoId)
    // With one account there's nothing to choose between: gh's active account already is it.
    // A guess that no longer holds is dropped; a pick the user made stays (Integrations decides).
    if (save && repo && accounts.length > 1) this.githubDetected(repoId, result.account)
    return result
  }

  updateRepo(id: string, patch: RepoPatch): Repo {
    const repo = this.repo(id)
    if (patch.name !== undefined && patch.name.trim()) repo.name = patch.name.trim()
    if (patch.defaultBranch !== undefined) repo.defaultBranch = patch.defaultBranch.trim() || repo.defaultBranch
    if (patch.remote !== undefined) {
      repo.remote = patch.remote.trim() || 'origin'
      void hasRemote(repo.rootPath, repo.remote).then((has) => {
        repo.hasOrigin = has
        this.changed()
      })
    }
    if (patch.setupHintDismissed !== undefined) repo.setupHintDismissed = patch.setupHintDismissed || undefined
    if (patch.cloud !== undefined) {
      const wasEnabled = repoCloud(repo).enabled
      const build = repo.cloud?.build
      // null puts the settings back to their defaults; the build is Foreman's record and stays.
      const next = patch.cloud === null ? (build ? { ...cloudDefaults(), build } : undefined) : { ...repoCloud(repo), ...cleanRepoCloudPatch(patch.cloud), ...(build ? { build } : {}) }
      const turningOff = wasEnabled && !repoCloud({ cloud: next }).enabled
      // Another provider or connection: the base lives on the old one, so it goes (workspaces keep their own sandboxes).
      const moving = Boolean(build && next && patch.cloud && (patch.cloud.provider !== undefined || patch.cloud.connectionId !== undefined) && ((build.provider ?? 'vercel') !== next.provider || (build.connectionId ?? '') !== (next.connectionId ?? '')))
      // Turning off or moving deletes the base sandbox, which a running build is still making: refuse rather than pull it out from under it.
      if ((turningOff || moving) && this.cloud?.building(repo.id)) throw new Error(`${repo.name}’s base is being built. Wait for the build to finish, then change its remote settings.`)
      if (moving && next) delete next.build
      repo.cloud = next
      // Turning the cloud off for a repository deletes its base sandbox (its workspaces keep their own).
      if (turningOff && build && !moving) void this.cloud?.deleteBase(repo).catch(() => undefined)
      if (moving && build) void this.cloud?.deleteBase(repo, build).catch(() => undefined)
    }
    // The GitHub account is a connection now (Repository settings → Integrations); the old field is ignored.
    if (patch.icon !== undefined) {
      if (patch.icon === null) delete repo.icon
      else repo.icon = patch.icon
    }
    this.changed()
    return repo
  }

  /**
   * Remove a repository from Foreman: its workspaces' worktrees are deleted
   * (branches are kept) and its chats forgotten. The repository folder itself
   * is not touched.
   */
  async removeRepo(id: string): Promise<void> {
    const repo = this.repo(id)
    // Its base sandbox goes with it, which a running build is still making.
    if (this.cloud?.building(id)) throw new Error(`${repo.name}’s base is being built. Wait for the build to finish, then remove the repository.`)
    // Cloud workspaces' sandboxes (archived ones too) and the repository's base sandbox go with it.
    for (const ws of this.state.workspaces.filter((w) => w.repoId === id && w.cloud)) await this.cloud?.forget(ws).catch(() => undefined)
    if (repo.cloud?.build) await this.cloud?.deleteBase(repo).catch(() => undefined)
    for (const ws of this.state.workspaces.filter((w) => w.repoId === id && w.state !== 'archived')) {
      await this.setups.get(ws.id)?.kill()
      if (ws.path && !ws.adopted && existsSync(ws.path)) await git(repo.rootPath, ['worktree', 'remove', '--force', ws.path], { allowFail: true })
    }
    await git(repo.rootPath, ['worktree', 'prune'], { allowFail: true })
    const ids = new Set(this.state.workspaces.filter((w) => w.repoId === id).map((w) => w.id))
    this.state.workspaces = this.state.workspaces.filter((w) => !ids.has(w.id))
    this.state.sessions = this.state.sessions.filter((s) => !ids.has(s.workspaceId))
    this.state.comments = this.state.comments.filter((c) => !ids.has(c.workspaceId))
    this.state.repos = this.state.repos.filter((r) => r.id !== id)
    this.changed()
  }

  /** What "Files to copy" would copy into a new workspace right now. */
  async previewFilesToCopy(id: string, patterns?: string[]): Promise<{ files: string[]; fromWorktreeInclude: boolean; patterns: string[] }> {
    const repo = this.repo(id)
    const effective = await effectivePatterns(repo.rootPath, patterns ?? this.settingsFor(id).filesToCopy)
    const files = await filesToCopy(repo.rootPath, effective.patterns)
    return { files, fromWorktreeInclude: effective.fromWorktreeInclude, patterns: effective.patterns.filter((p) => p.trim()) }
  }

  // ---- workspaces ----

  env(ws: Workspace): Record<string, string> {
    const repo = this.repo(ws.repoId)
    // In the cloud the paths are the sandbox's, and there are no ports here (a sandbox's ports are public URLs).
    const vars: Record<string, string> = ws.cloud
      ? {
          FOREMAN_WORKSPACE_ID: ws.id,
          FOREMAN_WORKSPACE_NAME: ws.name,
          FOREMAN_WORKSPACE_PATH: ws.cloud.cwd,
          FOREMAN_ROOT_PATH: ws.cloud.cwd,
          FOREMAN_DEFAULT_BRANCH: ws.baseBranch,
          FOREMAN_IS_CLOUD: '1'
        }
      : {
          FOREMAN_WORKSPACE_ID: ws.id,
          FOREMAN_WORKSPACE_NAME: ws.name,
          FOREMAN_WORKSPACE_PATH: wsPath(ws),
          FOREMAN_ROOT_PATH: repo.rootPath,
          FOREMAN_DEFAULT_BRANCH: ws.baseBranch,
          FOREMAN_PORT: String(ws.portBase)
        }
    // Preserve variable names from this app's earlier name for existing scripts.
    for (const [key, value] of Object.entries(vars)) {
      vars[key.replace('FOREMAN_', 'SWITCHYARD_')] = value
    }
    return vars
  }

  /** Environment for setup, run and archive scripts and terminals: the user's shell, Settings → Environment, then workspace variables. */
  scriptEnv(ws: Workspace): Record<string, string> {
    // This computer's shell environment (PATH, HOME, …) means nothing in a sandbox, which has its own. A Vercel token
    // set in Settings → Environment stays here too: it could make and delete sandboxes (agents' turns drop it as well).
    if (ws.cloud) {
      const { VERCEL_TOKEN: _vercel, ...vars } = this.environment.vars(ws.repoId)
      return { ...vars, ...this.env(ws) }
    }
    return { ...agentBaseEnv(), ...this.environment.vars(ws.repoId), ...this.env(ws) }
  }

  /** Where git and scripts run for a workspace: its folder here, or its cloud sandbox. */
  gitTarget(ws: Workspace): GitTarget {
    if (!ws.cloud) return wsPath(ws)
    if (!this.cloud) throw new Error('Remote workspaces aren’t available')
    return this.cloud.runtime(ws)
  }

  /** Appended to the agent's system prompt. */
  agentContext(ws: Workspace): string {
    const where = ws.cloud
      ? [
          'You are running inside Foreman, an app that runs several coding agents in parallel, each in its own git worktree. This one is in a cloud sandbox.',
          `Your workspace is ${ws.cloud.cwd}, on branch ${ws.branch}, created from ${ws.baseBranch}. Keep your work inside it.`
        ]
      : ws.direct
      ? [
          'You are running inside Foreman, an app that runs coding agents in git worktrees or, like here, directly in a repository folder.',
          `Your workspace is the repository folder ${ws.path} itself, on branch ${ws.branch}. There is no separate worktree or branch: your changes go straight onto ${ws.branch}. Keep your work inside it.`
        ]
      : [
          'You are running inside Foreman, an app that runs several coding agents in parallel, each in its own git worktree.',
          `Your workspace is ${ws.path}, on branch ${ws.branch}, created from ${ws.baseBranch}. Keep your work inside it.`
        ]
    return [
      ...where,
      ...(ws.cloud ? [] : [`Ports ${ws.portBase}-${ws.portBase + PORT_BLOCK_SIZE - 1} are reserved for this workspace; the first one is in $FOREMAN_PORT. Use them for dev servers.`]),
      'Do not commit, push, or open pull requests unless the user asks you to.',
      ws.direct ? 'Do not switch or rename the branch unless the user asks.' : 'Do not rename the branch unless the user asks; Foreman names it from the task.',
      ...(this.state.settings.stackedPrs ? ['You can stack pull requests with `gh stack` when a change is better split into several PRs.'] : []),
      ...this.hostContext(ws)
    ].join('\n')
  }

  /** Every worktree of the repository, main checkout first. */
  async listWorktrees(repoId: string): Promise<WorktreeInfo[]> {
    const repo = this.repo(repoId)
    const out = await git(repo.rootPath, ['worktree', 'list', '--porcelain'], { allowFail: true })
    const trees: WorktreeInfo[] = []
    for (const block of out.stdout.split(/\n\n+/)) {
      const fields = Object.fromEntries(
        block
          .split('\n')
          .filter(Boolean)
          .map((line) => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)])
      )
      if (!fields.worktree || 'bare' in fields || 'prunable' in fields) continue
      const wtPath = path.normalize(fields.worktree)
      const branch = fields.branch?.replace(/^refs\/heads\//, '')
      const ws = this.state.workspaces.find((w) => w.state !== 'archived' && w.path !== undefined && samePath(w.path, wtPath))
      trees.push({ path: wtPath, branch, head: fields.HEAD ?? '', isMain: trees.length === 0, dirty: 0, workspaceId: ws?.id })
    }
    await Promise.all(
      trees.map(async (t) => {
        if (!existsSync(t.path)) return
        const status = await git(t.path, ['status', '--porcelain'], { allowFail: true })
        t.dirty = status.stdout.split('\n').filter(Boolean).length
      })
    )
    return trees
  }

  /** Local and remote branches, the base branch first, with where each is checked out. */
  async listBranches(repoId: string, options: { fetch?: boolean } = {}): Promise<BranchInfo[]> {
    const repo = this.repo(repoId)
    const remote = repo.remote || 'origin'
    if (options.fetch && repo.hasOrigin) await git(repo.rootPath, ['fetch', remote, '--prune'], { allowFail: true, timeoutMs: 60_000, env: await remoteGitEnv(this.accountFor(repo.id)) })
    const refs = await git(repo.rootPath, ['for-each-ref', '--format=%(refname)', 'refs/heads', `refs/remotes/${remote}`], { allowFail: true })
    const branches = new Map<string, BranchInfo>()
    for (const ref of refs.stdout.split('\n').map((r) => r.trim()).filter(Boolean)) {
      const local = ref.startsWith('refs/heads/')
      const name = local ? ref.slice('refs/heads/'.length) : ref.slice(`refs/remotes/${remote}/`.length)
      if (!name || name === 'HEAD') continue
      const info = branches.get(name) ?? { name, local: false, remote: false, isDefault: name === repo.defaultBranch }
      if (local) info.local = true
      else info.remote = true
      branches.set(name, info)
    }
    for (const tree of await this.listWorktrees(repoId)) {
      const info = tree.branch ? branches.get(tree.branch) : undefined
      if (info) info.checkedOutAt = tree.path
    }
    return [...branches.values()].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(b.local) - Number(a.local) || a.name.localeCompare(b.name))
  }

  private async newPorts(): Promise<number> {
    return allocatePortBlock(this.state.workspaces.filter((w) => ACTIVE.includes(w.state)).map((w) => w.portBase))
  }

  /** Tell the app a workspace's own fields changed. */
  touch(): void {
    this.changed()
  }

  /** The active workspace working directly in the repository folder, if any. */
  directWorkspace(repoId: string): Workspace | undefined {
    return this.state.workspaces.find((w) => w.repoId === repoId && w.direct && w.state !== 'archived')
  }

  async createWorkspace(repoId: string, options: CreateWorkspaceOptions = {}): Promise<Workspace> {
    const repo = this.repo(repoId)
    const { settings } = this.state
    const choice = options.branch ?? { kind: 'new' }
    const pr = options.pullRequest
    if (pr && choice.kind !== 'new') throw new Error('A pull request gets its own new branch')
    if (options.location === 'cloud') return this.createCloudWorkspace(repo, options)
    if (choice.kind === 'direct') return this.createDirectWorkspace(repo, choice.name, Boolean(options.runSetup))
    let branch: string | undefined
    let placeholderBranch: string | undefined
    if (pr) {
      if (!(await remoteForPullRequest(repo.rootPath, pr, this.gitlabRoot(pr)))) throw new Error(`None of ${repo.name}’s remotes points at ${pr.repo}, so its ${pr.gitlabHost ? 'merge' : 'pull'} requests can’t be fetched`)
      branch = choice.name?.trim() || `pr-${pr.number}`
      const valid = await git(repo.rootPath, ['check-ref-format', '--branch', branch], { allowFail: true })
      if (valid.code !== 0) throw new Error(`“${branch}” isn't a valid branch name`)
      const taken = Boolean(await revParse(repo.rootPath, `refs/heads/${branch}`))
      if (taken && choice.name?.trim()) throw new Error(`A branch named ${branch} already exists`)
      // Checking the same PR out again gets a fresh branch.
      if (taken) branch = `${branch}-${randomUUID().slice(0, 6)}`
    } else if (choice.kind === 'existing') {
      branch = choice.name.trim()
      if (!branch) throw new Error('Choose a branch to check out')
      const elsewhere = (await this.listWorktrees(repoId)).find((t) => t.branch === branch)
      if (elsewhere) throw new Error(`${branch} is already checked out in ${elsewhere.path}`)
    } else if (choice.name?.trim()) {
      branch = choice.name.trim()
      const valid = await git(repo.rootPath, ['check-ref-format', '--branch', branch], { allowFail: true })
      if (valid.code !== 0) throw new Error(`“${branch}” isn't a valid branch name`)
      if (await revParse(repo.rootPath, `refs/heads/${branch}`)) throw new Error(`A branch named ${branch} already exists`)
    }
    // Generated branch names are replaced by one based on the first message.
    const prefix = branch === undefined ? await branchPrefix(settings.branchPrefixType, settings.branchPrefix, this.accountFor(repo.id)) : ''
    const portBase = await this.newPorts()
    // Last, so a refused request leaves no folder behind.
    const siblings = this.state.workspaces.filter((w) => w.repoId === repoId).flatMap((w) => w.namesake ? [w.name, w.namesake] : [w.name])
    const { name: generatedName, dir } = await this.claimFolder(path.join(settings.workspacesRoot, safeDirName(repo.name)), (taken) => pickWorkspaceName([...taken, ...siblings]))
    if (branch === undefined) {
      branch = `${prefix}${generatedName}`
      placeholderBranch = branch
    }
    const ws: Workspace = {
      id: randomUUID(),
      repoId,
      // A checked-out branch names the workspace; otherwise use the generated name.
      name: choice.kind === 'existing' ? branch.split('/').pop() || generatedName : generatedName,
      branch,
      placeholderBranch,
      namesake: choice.kind === 'existing' ? undefined : findWorkspacePerson(choice.name)?.name ?? generatedName,
      pullRequest: pr ? { repo: pr.repo, number: pr.number, ...(pr.gitlabHost ? { gitlabHost: pr.gitlabHost } : {}) } : undefined,
      baseBranch: options.baseBranch?.trim() || repo.defaultBranch,
      path: dir,
      portBase,
      state: 'creating',
      createdAt: new Date().toISOString()
    }
    this.state.workspaces.push(ws)
    this.changed()
    void this.provision(ws, repo, choice.kind === 'existing', options.deferSetup ? this.holdSetup(ws.id) : undefined)
    return ws
  }

  /**
   * A workspace whose worktree is in a cloud sandbox: recorded with no
   * folder here, then its sandbox is forked from the repository's base and set up there.
   */
  private async createCloudWorkspace(repo: Repo, options: CreateWorkspaceOptions): Promise<Workspace> {
    const cloud = this.cloud
    if (!cloud) throw new Error('Remote workspaces aren’t available')
    const choice = options.branch ?? { kind: 'new' }
    if (choice.kind === 'direct') throw new Error('A remote workspace has its own copy of the repository, so it can’t work in the repository folder')
    // Compare (deferSetup) restores a local checkpoint into each sibling: local workspaces only.
    if (options.deferSetup) throw new Error('Cloud workspaces can’t be compared yet')
    const pr = options.pullRequest
    if (pr) {
      // The sandbox clones the repository's remote, so the pull request must be on that repository (refs/pull/N/head).
      if (pr.gitlabHost) throw new Error('GitLab merge requests can’t be checked out in a remote workspace')
      const slug = githubSlug((await this.remoteUrl(repo.id)) ?? '')
      if (!slug || slug.toLowerCase() !== pr.repo.toLowerCase()) throw new Error(`A remote workspace clones ${repo.name}’s ${repo.remote || 'origin'} remote, which isn’t ${pr.repo}, so this pull request can’t be fetched there`)
    }
    cloud.preflight(repo)
    const { settings } = this.state
    let branch = choice.name?.trim() || (pr ? `pr-${pr.number}` : undefined)
    if (choice.kind === 'existing' && !branch) throw new Error('Choose a branch to check out')
    if (branch) {
      const valid = await git(repo.rootPath, ['check-ref-format', '--branch', branch], { allowFail: true })
      if (valid.code !== 0) throw new Error(`“${branch}” isn't a valid branch name`)
    }
    const generatedName = pickWorkspaceName(this.state.workspaces.filter((w) => w.repoId === repo.id).flatMap((w) => w.namesake ? [w.name, w.namesake] : [w.name]))
    let placeholderBranch: string | undefined
    if (!branch) {
      branch = `${await branchPrefix(settings.branchPrefixType, settings.branchPrefix, this.accountFor(repo.id))}${generatedName}`
      placeholderBranch = branch
    }
    const id = randomUUID()
    const ws: Workspace = {
      id,
      repoId: repo.id,
      name: choice.kind === 'existing' ? branch.split('/').pop() || generatedName : generatedName,
      branch,
      placeholderBranch,
      namesake: choice.kind === 'existing' ? undefined : findWorkspacePerson(choice.name)?.name ?? generatedName,
      pullRequest: pr ? { repo: pr.repo, number: pr.number } : undefined,
      baseBranch: options.baseBranch?.trim() || repo.defaultBranch,
      // No folder and no ports here.
      portBase: 0,
      state: 'creating',
      cloud: cloud.newBinding(id, repo),
      createdAt: new Date().toISOString()
    }
    this.state.workspaces.push(ws)
    this.changed()
    void this.provisionCloud(ws, repo, choice.kind === 'existing')
    return ws
  }

  private async provisionCloud(ws: Workspace, repo: Repo, existingBranch: boolean): Promise<void> {
    await writeFile(this.setupLogPath(ws), '')
    try {
      await this.cloud!.createWorkspaceSandbox(ws, repo, { existingBranch, pullRequest: ws.pullRequest?.number, log: (chunk) => this.log(ws, chunk) })
      if (ws.state === 'archived') return
      if (this.settingsFor(repo.id).setupScript.trim()) {
        ws.state = 'setting-up'
        this.changed()
        await this.runSetup(ws, repo)
      } else {
        ws.state = 'ready'
        this.changed()
      }
    } catch (err) {
      ws.state = 'error'
      ws.error = err instanceof Error ? err.message : String(err)
      if (ws.cloud?.status === 'creating') Object.assign(ws.cloud, { status: 'failed', error: ws.error })
      this.log(ws, `\n${ws.error}\n`)
      this.changed()
    }
  }

  /**
   * Choose a folder name under `parent` with `pick` and create the folder, so nothing else can take it:
   * another workspace being created at the same moment, or another Foreman sharing the workspaces folder.
   * `pick` gets the names already in use: on disk, and by every workspace record in `parent`, archived
   * ones included, since unarchiving restores to the same path.
   */
  private async claimFolder(parent: string, pick: (taken: Set<string>) => string): Promise<{ name: string; dir: string }> {
    await mkdir(parent, { recursive: true })
    const taken = new Set(await readdir(parent))
    for (const w of this.state.workspaces) if (w.path && samePath(path.dirname(w.path), parent)) taken.add(path.basename(w.path))
    for (let attempt = 0; attempt < 20; attempt++) {
      const name = pick(taken)
      const dir = path.join(parent, name)
      try {
        await mkdir(dir)
        return { name, dir }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        taken.add(name)
      }
    }
    throw new Error(`Couldn’t find a free folder in ${parent}`)
  }

  // deferSetup workspaces: waiting for the caller between "worktree ready" and "run setup".
  private holds = new Map<string, SetupHold>()

  private holdSetup(id: string): SetupHold {
    let reached!: () => void
    let fail!: (err: Error) => void
    let proceed!: (abort?: string) => void
    const prepared = new Promise<void>((resolve, reject) => {
      reached = resolve
      fail = reject
    })
    const go = new Promise<string | undefined>((resolve) => (proceed = resolve))
    // The caller may never ask (a failed provision rejects it first); that is not an unhandled rejection.
    prepared.catch(() => undefined)
    const hold: SetupHold = { prepared, go, reached, fail, proceed }
    this.holds.set(id, hold)
    return hold
  }

  /** A deferSetup workspace has its worktree (and copied files) and is waiting; rejects if it failed first. */
  worktreePrepared(id: string): Promise<void> {
    const hold = this.holds.get(id)
    if (!hold) throw new Error('This workspace is not waiting for setup')
    return hold.prepared
  }

  /** Let a deferSetup workspace run its setup. `abort` stops it instead, leaving the workspace in error with that reason. */
  continueSetup(id: string, abort?: string): void {
    const hold = this.holds.get(id)
    if (!hold) return
    this.holds.delete(id)
    hold.proceed(abort)
  }

  /**
   * Work in the repository folder itself on `branchName`, checking it out
   * there first if the folder is on another branch. Nothing is created or
   * copied, and archiving leaves the folder and branch alone.
   */
  private async createDirectWorkspace(repo: Repo, branchName: string, runSetup: boolean): Promise<Workspace> {
    const branch = branchName.trim()
    if (!branch) throw new Error('Choose a branch to work on')
    const taken = this.directWorkspace(repo.id)
    if (taken) throw new Error(`${taken.name} already works in the repository folder. Archive it first.`)
    const trees = await this.listWorktrees(repo.id)
    const main = trees.find((t) => t.isMain)
    if (!main) throw new Error(`Couldn’t find the main checkout of ${repo.name}`)
    const elsewhere = trees.find((t) => !t.isMain && t.branch === branch)
    if (elsewhere) throw new Error(`${branch} is checked out in ${elsewhere.path}. Use that worktree instead.`)
    let log = `Working directly in ${main.path}.\n`
    if (main.branch !== branch) {
      if (await busyOperation(main.path)) throw new Error('Finish the merge or rebase in the repository folder first')
      const remote = repo.remote || 'origin'
      let args: string[]
      if (await revParse(main.path, `refs/heads/${branch}`)) args = ['checkout', branch]
      else {
        // Only on the remote: make a local branch that tracks it.
        if (repo.hasOrigin) await git(main.path, ['fetch', remote, branch], { allowFail: true, timeoutMs: 120_000, env: await remoteGitEnv(this.accountFor(repo.id)) })
        args = ['checkout', '--track', '-b', branch, `${remote}/${branch}`]
      }
      const out = await git(main.path, args, { allowFail: true })
      if (out.code !== 0) throw new Error(`Couldn’t check out ${branch} in the repository folder: ${out.stderr.trim()}`)
      log += `$ git ${args.join(' ')}\n${out.stderr}${out.stdout}`
    }
    const ws: Workspace = {
      id: randomUUID(),
      repoId: repo.id,
      name: branch.split('/').pop() || branch,
      branch,
      // Its own base: the diff and git status compare against the branch's remote copy.
      baseBranch: branch,
      path: main.path,
      portBase: await this.newPorts(),
      state: runSetup && this.settingsFor(repo.id).setupScript.trim() ? 'setting-up' : 'ready',
      adopted: true,
      direct: true,
      createdAt: new Date().toISOString()
    }
    this.state.workspaces.push(ws)
    await writeFile(this.setupLogPath(ws), log)
    await excludeContextDir(wsPath(ws)).catch(() => undefined)
    this.changed()
    if (ws.state === 'setting-up') void this.runSetup(ws, repo)
    return ws
  }

  /** Add a worktree that already exists on disk. Nothing is copied; setup runs only if asked. */
  async adoptWorktree(repoId: string, wtPath: string, options: { runSetup: boolean }): Promise<Workspace> {
    const repo = this.repo(repoId)
    const tree = (await this.listWorktrees(repoId)).find((t) => samePath(t.path, wtPath))
    if (!tree) throw new Error(`${wtPath} isn't a worktree of ${repo.name}`)
    if (tree.isMain) throw new Error('To work in the main checkout, choose “Repository folder” instead.')
    if (tree.workspaceId) throw new Error('That worktree is already a workspace')
    if (!tree.branch) throw new Error('That worktree has no branch checked out. Check one out first.')
    const ws: Workspace = {
      id: randomUUID(),
      repoId,
      name: path.basename(tree.path),
      branch: tree.branch,
      baseBranch: repo.defaultBranch,
      path: tree.path,
      portBase: await this.newPorts(),
      state: options.runSetup && this.settingsFor(repoId).setupScript.trim() ? 'setting-up' : 'ready',
      adopted: true,
      createdAt: new Date().toISOString()
    }
    this.state.workspaces.push(ws)
    await writeFile(this.setupLogPath(ws), `Added the existing worktree at ${ws.path}.\n`)
    await excludeContextDir(wsPath(ws)).catch(() => undefined)
    this.changed()
    if (ws.state === 'setting-up') void this.runSetup(ws, repo)
    return ws
  }

  /** Reconnect an existing checkout from a configuration backup. Never switches branches or runs setup. */
  async reconnectWorkspace(repoId: string, entry: GitBackupWorkspace, wtPath: string): Promise<Workspace> {
    const repo = this.repo(repoId)
    const tree = (await this.listWorktrees(repoId)).find((t) => samePath(t.path, wtPath))
    if (!tree || tree.branch !== entry.branch) throw new Error(`${wtPath} is not the ${entry.branch} checkout of ${repo.name}`)
    if (Boolean(entry.direct) !== tree.isMain) throw new Error(`${wtPath} is the wrong kind of checkout for ${entry.name}`)
    if (tree.workspaceId || (tree.isMain && this.directWorkspace(repoId))) throw new Error(`${wtPath} is already a workspace`)
    const ws: Workspace = {
      id: randomUUID(), repoId, name: entry.name, branch: entry.branch, baseBranch: entry.baseBranch,
      path: tree.path, portBase: await this.newPorts(), state: 'ready', adopted: true,
      ...(tree.isMain ? { direct: true } : {}),
      ...(entry.pinned ? { pinned: true } : {}),
      ...(entry.status ? { status: entry.status } : {}),
      createdAt: new Date().toISOString()
    }
    this.state.workspaces.push(ws)
    this.changed()
    return ws
  }

  /** Add a workspace that came from an export: history only, no folder, ports reserved for when it is activated. */
  async addImported(ws: Workspace): Promise<void> {
    ws.portBase = await this.newPorts()
    this.state.workspaces.push(ws)
    this.changed()
  }

  /**
   * Give a history-only workspace its worktree, on its own branch. Only when that branch
   * exists in this repository: Foreman won't invent code the export didn't carry.
   */
  async activateWorkspace(id: string, options: { branch?: string; deferSetup?: boolean; noHooks?: boolean } = {}): Promise<Workspace> {
    const ws = this.workspace(id)
    if (ws.state !== 'history') throw new Error(`${ws.name} already has a worktree`)
    const repo = this.repo(ws.repoId)
    // A carried branch was just fetched under a name nothing else uses.
    if (!options.branch && !(await revParse(repo.rootPath, `refs/heads/${ws.branch}`))) {
      throw new Error(`The branch “${ws.branch}” isn’t in ${repo.name} on this machine, so ${ws.name} stays history only. Fetch or create the branch, then activate it.`)
    }
    const elsewhere = (await this.listWorktrees(repo.id)).find((t) => t.branch === (options.branch ?? ws.branch))
    if (elsewhere) throw new Error(`${options.branch ?? ws.branch} is already checked out in ${elsewhere.path}, so ${ws.name} stays history only.`)
    if (options.branch) ws.branch = options.branch
    const base = safeDirName(ws.name)
    ws.path = (await this.claimFolder(path.join(this.state.settings.workspacesRoot, safeDirName(repo.name)), (taken) => {
      let name = base
      for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
      return name
    })).dir
    ws.state = 'creating'
    this.changed()
    void this.provision(ws, repo, true, options.deferSetup ? this.holdSetup(ws.id) : undefined, options.noHooks)
    return ws
  }

  private async provision(ws: Workspace, repo: Repo, existingBranch = false, hold?: SetupHold, noHooks = false): Promise<void> {
    await writeFile(this.setupLogPath(ws), '')
    let worktreeAdded = false
    try {
      // A pull request's base lives on the remote that points at its repository, which may not be origin.
      const prRemote = ws.pullRequest ? await remoteForPullRequest(repo.rootPath, ws.pullRequest, this.gitlabRoot(ws.pullRequest)) : null
      if (ws.pullRequest && !prRemote) throw new Error(`None of ${repo.name}’s remotes points at ${ws.pullRequest.repo}`)
      const remote = prRemote ?? (repo.remote || 'origin')
      if (repo.hasOrigin || prRemote) {
        this.log(ws, `$ git fetch ${remote} ${ws.baseBranch}\n`)
        const fetched = await git(repo.rootPath, ['fetch', remote, ws.baseBranch], { allowFail: true, timeoutMs: 120_000, env: await remoteGitEnv(this.accountFor(repo.id)) })
        if (fetched.code !== 0) this.log(ws, `${fetched.stderr.trim()}\nContinuing with the local copy of ${ws.baseBranch}.\n`)
      }
      const startPoint = await baseStartPoint(repo.rootPath, ws.baseBranch, remote)
      if (ws.pullRequest && prRemote) {
        const fetched = await fetchPullHead(repo.rootPath, prRemote, ws.pullRequest.number, ws.branch, ws.pullRequest.gitlabHost ? {} : await remoteGitEnv(this.accountFor(repo.id)), Boolean(ws.pullRequest.gitlabHost))
        this.log(ws, `$ ${fetched.command}\n${fetched.output}`)
        existingBranch = true
      }
      if (!existingBranch && ws.placeholderBranch && (await revParse(repo.rootPath, `refs/heads/${ws.branch}`))) {
        ws.branch = `${ws.branch}-${ws.id.slice(0, 6)}`
        ws.placeholderBranch = ws.branch
      }
      // The folder was claimed empty; anything in it now belongs to someone else.
      if ((await readdir(wsPath(ws)).catch(() => [])).length > 0) throw new Error(`${wsPath(ws)} already exists`)
      await mkdir(path.dirname(wsPath(ws)), { recursive: true })

      const config = [...(isWindows ? ['-c', 'core.longpaths=true'] : []), ...(noHooks ? NO_HOOKS : [])]
      let args: string[]
      if (!existingBranch) {
        // --no-track: the branch must not push to the base branch by accident.
        args = [...config, 'worktree', 'add', '--no-track', '-b', ws.branch, wsPath(ws), startPoint]
      } else if (await revParse(repo.rootPath, `refs/heads/${ws.branch}`)) {
        args = [...config, 'worktree', 'add', wsPath(ws), ws.branch]
      } else {
        // Only on the remote: make a local branch that tracks it.
        if (repo.hasOrigin) await git(repo.rootPath, ['fetch', remote, ws.branch], { allowFail: true, timeoutMs: 120_000, env: await remoteGitEnv(this.accountFor(repo.id)) })
        args = [...config, 'worktree', 'add', '--track', '-b', ws.branch, wsPath(ws), `${remote}/${ws.branch}`]
      }
      this.log(ws, `$ git ${args.join(' ')}\n`)
      const added = await git(repo.rootPath, args)
      worktreeAdded = true
      this.log(ws, added.stderr + added.stdout)
      await this.configurePush(repo, ws)
      await excludeContextDir(wsPath(ws)).catch(() => undefined)
      await this.copyIgnoredFiles(repo, ws)

      if (hold) {
        // The caller works on the fresh worktree (Compare restores a checkpoint) before setup sees it.
        hold.reached()
        const abort = await hold.go
        if (abort) throw new Error(abort)
        if (ws.state === 'archived') return
      }
      if (this.settingsFor(repo.id).setupScript.trim()) {
        ws.state = 'setting-up'
        this.changed()
        await this.runSetup(ws, repo)
      } else {
        ws.state = 'ready'
        this.changed()
      }
    } catch (err) {
      // Give back the empty folder we claimed, so archiving this workspace has nothing to remove.
      if (!worktreeAdded) await rmdir(wsPath(ws)).catch(() => undefined)
      ws.state = 'error'
      ws.error = err instanceof Error ? err.message : String(err)
      this.log(ws, `\n${ws.error}\n`)
      this.holds.delete(ws.id)
      hold?.fail(err instanceof Error ? err : new Error(ws.error))
      this.changed()
    }
  }

  /**
   * With "Set upstream on plain git push" on, a plain `git push` from the
   * workspace sets its upstream, so agents' pushes just work. It goes in the
   * worktree's own config so the main checkout is untouched.
   */
  private async configurePush(repo: Repo, ws: Workspace): Promise<void> {
    if (!this.settingsFor(repo.id).pushAutoSetupRemote) return
    await git(repo.rootPath, ['config', 'extensions.worktreeConfig', 'true'], { allowFail: true })
    await git(wsPath(ws), ['config', '--worktree', 'push.autoSetupRemote', 'true'], { allowFail: true })
  }

  private async copyIgnoredFiles(repo: Repo, ws: Workspace): Promise<void> {
    const { files } = await this.previewFilesToCopy(repo.id)
    for (const rel of files) {
      const from = path.join(repo.rootPath, rel)
      const to = path.join(wsPath(ws), rel)
      if (!existsSync(from) || existsSync(to)) continue
      await mkdir(path.dirname(to.replace(/[/\\]$/, '')), { recursive: true })
      await cp(from, to, { recursive: true })
      this.log(ws, `Copied ${rel}\n`)
    }
  }

  /**
   * Run the repo's setup steps in order (O19). With `resume`, carry on from the step
   * the last run stopped at, keeping the ones that passed (Retry failed step).
   */
  private async runSetup(ws: Workspace, repo: Repo, resume = false): Promise<void> {
    const settings = this.settingsFor(repo.id)
    const steps = settings.setupSteps
    const at = resume ? resumeIndex(ws.setupRun, steps) : -1
    const from = Math.max(0, at)
    const previous = at >= 0 ? ws.setupRun : undefined
    const runId = previous?.id ?? randomUUID()
    const single = steps.length === 1
    if (!previous) await Promise.all(steps.map((_, i) => this.writeStepLog(ws, i, '', true)))
    if (resume && !previous && failedStep(ws.setupRun) >= 0) this.log(ws, '\nThe setup steps changed since the last run, so setup runs from the top.\n')
    else if (previous && from > 0) this.log(ws, `\nCarrying on from ${steps[from].name} (step ${from + 1} of ${steps.length}); the steps before it passed.\n`)
    const run = runSetupSteps({
      steps,
      from,
      previous: previous?.steps,
      retryOnce: settings.setupRetryOnce,
      cwd: this.gitTarget(ws),
      env: this.scriptEnv(ws),
      onStepStart: (i, attempt) => {
        const step = steps[i]
        if (!single && attempt === 1) this.log(ws, `\n[${i + 1}/${steps.length}] ${step.name}\n`)
        // One step logs exactly as the single setup script always did.
        const head = attempt > 1 ? `\nRetrying ${single ? 'setup' : step.name} (run ${attempt}).\n` : single ? '\n' : ''
        this.log(ws, `${head}$ ${step.command}\n`, { index: i, runId })
      },
      onOutput: (i, chunk) => this.log(ws, chunk, { index: i, runId }),
      onChange: (results) => {
        if (ws.setupRun?.id !== runId) return
        ws.setupRun.steps = results
        this.changed()
      }
    })
    ws.setupRun = { id: runId, startedAt: previous?.startedAt ?? new Date().toISOString(), steps: run.results.map((r) => ({ ...r })) }
    this.setups.set(ws.id, run)
    const outcome = await run.done
    this.setups.delete(ws.id)
    if (ws.state === 'archived') return
    ws.setupRun.finishedAt = new Date().toISOString()
    this.log(ws, `\n${this.setupSummary(ws, outcome)}\n`)
    ws.state = outcome === 'done' ? 'ready' : 'setup-failed'
    this.changed()
    if (outcome === 'done' && this.settingsFor(repo.id).autoRunAfterSetup) this.events.setupFinished?.(ws.id)
  }

  /** The setup log's last line: finished, or which step stopped it and how. */
  private setupSummary(ws: Workspace, outcome: Awaited<SetupStepsRun['done']>): string {
    if (outcome === 'done') return 'Setup finished.'
    const steps = ws.setupRun?.steps ?? []
    const at = failedStep(ws.setupRun)
    const step = steps[at]
    if (!step) return outcome === 'stopped' ? 'Setup stopped.' : 'Setup failed.'
    const which = steps.length === 1 ? '' : ` at ${step.name} (step ${at + 1} of ${steps.length})`
    if (outcome === 'stopped') return `Setup stopped${which}.`
    if (outcome === 'timed-out') return `Setup timed out${which}: it ran past its ${clock((step.timeoutSec ?? 0) * 1000)} limit after ${duration(step.durationMs ?? 0)}.`
    return `Setup failed${which} with exit code ${step.exitCode}.`
  }

  /** Run setup again from the first step. */
  async rerunSetup(id: string): Promise<void> {
    await this.startSetup(id, false)
  }

  /** Retry failed step: carry on from where the last run stopped, without re-running the steps that passed. */
  async retrySetup(id: string): Promise<void> {
    await this.startSetup(id, true)
  }

  private async startSetup(id: string, resume: boolean): Promise<void> {
    const ws = this.workspace(id)
    const repo = this.repo(ws.repoId)
    if (this.setups.has(id)) throw new Error('Setup is already running')
    if (!this.settingsFor(repo.id).setupSteps.length) throw new Error('This repository has no setup script')
    ws.state = 'setting-up'
    this.changed()
    await this.runSetup(ws, repo, resume)
  }

  /** Stop setup: end the running step and skip the rest. The workspace is left as setup failed. */
  async stopSetup(id: string): Promise<void> {
    await this.setups.get(id)?.kill()
  }

  private stepLogPath(ws: Workspace, index: number): string {
    return this.store.logPath(`${ws.id}-setup-step-${index}.log`)
  }

  // Appends to each step's log go one after another, in order.
  private stepWrites = new Map<string, Promise<void>>()

  private writeStepLog(ws: Workspace, index: number, chunk: string, truncate = false): Promise<void> {
    const file = this.stepLogPath(ws, index)
    const next = (this.stepWrites.get(file) ?? Promise.resolve())
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true })
        await (truncate ? writeFile(file, chunk) : appendFile(file, chunk))
      })
      .catch(() => undefined)
    this.stepWrites.set(file, next)
    return next
  }

  /** Each step's own log for the latest setup run, in order. */
  async setupStepLogs(id: string): Promise<{ runId: string; logs: string[] } | null> {
    const ws = this.workspace(id)
    if (!ws.setupRun) return null
    const logs = await Promise.all(
      ws.setupRun.steps.map(async (_, i) => {
        const file = this.stepLogPath(ws, i)
        await this.stepWrites.get(file)
        return existsSync(file) ? readFile(file, 'utf8') : ''
      })
    )
    return { runId: ws.setupRun.id, logs }
  }

  setupLogPath(ws: Workspace): string {
    return this.store.logPath(`${ws.id}-setup.log`)
  }

  async setupLog(id: string): Promise<string> {
    const file = this.setupLogPath(this.workspace(id))
    await this.setupWrites.get(file)
    return existsSync(file) ? readFile(file, 'utf8') : ''
  }

  private setupWrites = new Map<string, Promise<void>>()

  /** Append to the setup log; a setup step's output goes to that step's own log too. */
  private log(ws: Workspace, chunk: string, step?: { index: number; runId: string }): void {
    if (!chunk) return
    const file = this.setupLogPath(ws)
    const write = (this.setupWrites.get(file) ?? Promise.resolve()).then(() => appendFile(file, chunk)).catch(() => undefined)
    this.setupWrites.set(file, write)
    if (step) void this.writeStepLog(ws, step.index, chunk)
    this.events.setupLog(ws.id, chunk, step)
  }

  updateWorkspace(id: string, patch: WorkspacePatch): void {
    const ws = this.workspace(id)
    if (patch.name !== undefined && patch.name.trim()) ws.name = patch.name.trim()
    if (patch.status !== undefined) {
      const next = patch.status ?? undefined
      // #21: the board's Done window counts from when the status was set.
      if (ws.status !== next) ws.statusAt = new Date().toISOString()
      if (next) ws.status = next
      else delete ws.status
    }
    if (patch.pinned !== undefined) ws.pinned = patch.pinned
    if (patch.later !== undefined) {
      const later = parseLater(patch.later)
      if (later) ws.later = { at: new Date().toISOString(), ...later }
      else delete ws.later
    }
    this.changed()
  }

  /** Rename the workspace's branch, adding -v2, -v3… if the name is taken. */
  async renameBranch(ws: Workspace, wanted: string): Promise<string> {
    const at = this.gitTarget(ws)
    const valid = await git(at, ['check-ref-format', '--branch', wanted], { allowFail: true })
    if (valid.code !== 0) throw new Error(`Invalid branch name: ${wanted}`)
    let name = wanted
    for (let n = 2; n < 12; n++) {
      const local = await revParse(at, `refs/heads/${name}`)
      const remote = await revParse(at, `refs/remotes/origin/${name}`)
      if (!local && !remote) break
      name = `${wanted}-v${n}`
    }
    await git(at, ['branch', '-m', ws.branch, name])
    ws.branch = name
    this.changed()
    return name
  }

  /**
   * Save the uncommitted work as a checkpoint, run the archive script, then remove the folder (#1).
   * A failed checkpoint or script throws ArchiveStepError before anything is deleted, unless `anyway`.
   * `from` retries from that step when the earlier ones already went through.
   */
  async archiveWorkspace(
    id: string,
    deleteBranch: boolean,
    options: { from?: 'checkpoint' | 'script'; anyway?: boolean; onDocker?: (result: DockerRemoval) => void; reason?: ArchiveReason } = {}
  ): Promise<Workspace> {
    const ws = this.workspace(id)
    const repo = this.repo(ws.repoId)
    await this.setups.get(id)?.kill()
    // A cloud workspace's sandbox stops and stays, keeping its work, until the workspace is forgotten.
    if (ws.cloud) {
      await this.archiveInSandbox(ws, repo, options)
      this.events.archiveProgress?.(ws.id, { step: 'sandbox', status: 'running' })
      let stopped = Boolean(this.cloud)
      if (this.cloud)
        await this.cloud.archive(ws).then(
          // A provider whose stopped sandboxes don't keep their files: archived anyway, with a warning in the log.
          ({ warning }) => void (warning && this.log(ws, `${warning}\n`)),
          (err: unknown) => {
            stopped = false
            this.log(ws, `Couldn’t stop the sandbox: ${err instanceof Error ? err.message : String(err)}\n`)
          }
        )
      // Not stopping it doesn't hold the archive up: the session ends at its own timeout.
      this.events.archiveProgress?.(ws.id, { step: 'sandbox', status: stopped ? 'done' : 'skipped' })
      if (ws.cloud.status !== 'gone') ws.cloud.status = 'archived'
      this.markArchived(ws, options.reason)
      return ws
    }
    // A worktree added from disk stays where the user made it.
    if (ws.adopted || isHistoryOnly(ws)) {
      this.markArchived(ws, options.reason)
      return ws
    }
    const progress = (step: ArchiveProgress['step'], status: ArchiveProgress['status'], extra: Omit<ArchiveProgress, 'step' | 'status'> = {}) =>
      this.events.archiveProgress?.(ws.id, { step, status, ...extra })
    const owned = existsSync(wsPath(ws)) && (await this.ownsFolder(ws))
    if (existsSync(wsPath(ws)) && !owned) this.log(ws, `Left ${wsPath(ws)} alone: it isn’t this workspace’s worktree.\n`)
    if (owned) {
      const fail = (step: 'checkpoint' | 'script', detail: string) => {
        this.log(ws, `${step === 'checkpoint' ? 'Could not save a checkpoint' : 'Archive script failed'}: ${detail}.\n`)
        progress(step, 'failed', { detail })
        if (!options.anyway) {
          this.log(ws, 'Nothing was deleted.\n')
          throw new ArchiveStepError(step, detail)
        }
      }
      if (options.from !== 'script') {
        progress('checkpoint', 'running')
        // Keep a restorable snapshot, uncommitted work included.
        const head = await revParse(wsPath(ws), 'HEAD')
        if (head) ws.archiveCommit = head
        const saved = await saveCheckpoint(wsPath(ws), `archive-${ws.id}`).catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }))
        if (!saved.ok) fail('checkpoint', saved.reason)
        else progress('checkpoint', 'done')
        // G3 · #13: keep the diff as it is now, to read in the archived view. Best effort; never blocks.
        progress('diff', 'running')
        // The checkpoint just saved already snapshots the whole working tree; reuse it for the diff so
        // we don't scan every file a second time, and the kept diff matches exactly what was checkpointed.
        progress('diff', (await this.saveArchiveDiff(ws, saved.ok ? saved.tree : undefined)) ? 'done' : 'skipped')
      }
      // G3 · O19: the archive script as ordered steps (one step for a single script), parallel groups included.
      const steps = this.settingsFor(repo.id).archiveSteps
      if (steps.length) {
        progress('script', 'running')
        const failed = await this.runArchiveSteps(ws, steps, options.from === 'script', (results) => progress('script', 'running', { scriptSteps: results }))
        if (failed) fail('script', failed)
        else progress('script', 'done')
      }
    }
    // O18: after the script, before the folder goes. A failure here is logged and reported, never blocking.
    if (!ws.direct && this.settingsFor(repo.id).removeDockerContainers) {
      progress('docker', 'running')
      const result = await this.removeDockerContainers(id)
      progress('docker', removalNeedsAttention(result) ? 'failed' : 'done')
      options.onDocker?.(result)
    }
    if (owned && existsSync(wsPath(ws))) {
      progress('remove', 'running')
      const removed = await git(repo.rootPath, ['worktree', 'remove', '--force', wsPath(ws)], { allowFail: true })
      if (removed.code !== 0) {
        progress('remove', 'failed', { detail: removed.stderr.trim() })
        throw new Error(`Could not remove the worktree: ${removed.stderr.trim()}`)
      }
    }
    await git(repo.rootPath, ['worktree', 'prune'], { allowFail: true })
    if (deleteBranch && ws.branch !== repo.defaultBranch) await git(repo.rootPath, ['branch', '-D', ws.branch], { allowFail: true })
    progress('remove', 'done')
    this.archiveRuns.delete(ws.id)
    this.markArchived(ws, options.reason)
    return ws
  }

  /** Archived now, and why: by hand unless Foreman archived it on its own. */
  private markArchived(ws: Workspace, reason: ArchiveReason = { kind: 'manual' }): void {
    ws.state = 'archived'
    ws.archivedAt = new Date().toISOString()
    ws.archiveReason = reason
    delete ws.keepArchived
    this.changed()
  }

  /** Restored: why it was archived, and Keep, belong to the archived state. */
  private clearArchived(ws: Workspace): void {
    delete ws.archivedAt
    delete ws.archiveReason
    delete ws.keepArchived
  }

  /**
   * A cloud workspace's archive before its sandbox stops: the diff kept for the archived view (#13) and the archive
   * steps, both in the sandbox. Steps need it, so they wake it; the diff is only read from a sandbox awake by then.
   * No checkpoint: the stopped sandbox keeps the work. A failed step throws ArchiveStepError (the sandbox is left
   * running) unless `anyway`.
   */
  private async archiveInSandbox(ws: Workspace, repo: Repo, options: { from?: 'checkpoint' | 'script'; anyway?: boolean }): Promise<void> {
    const cloud = ws.cloud!
    const progress = (step: ArchiveProgress['step'], status: ArchiveProgress['status'], extra: Omit<ArchiveProgress, 'step' | 'status'> = {}) =>
      this.events.archiveProgress?.(ws.id, { step, status, ...extra })
    const steps = this.settingsFor(repo.id).archiveSteps
    const reachable = Boolean(this.cloud?.available(cloud)) && cloud.status !== 'gone'
    if (reachable && steps.length) {
      await this.cloud!.wake(ws).catch((err: unknown) => this.log(ws, `Couldn’t wake the sandbox: ${err instanceof Error ? err.message : String(err)}\n`))
    }
    const awake = () => reachable && cloud.status === 'running'
    if (options.from !== 'script') {
      progress('diff', 'running')
      progress('diff', awake() && (await this.saveArchiveDiff(ws)) ? 'done' : 'skipped')
    }
    if (!steps.length) return
    progress('script', 'running')
    const failed = awake() ? await this.runArchiveSteps(ws, steps, options.from === 'script', (results) => progress('script', 'running', { scriptSteps: results })) : 'the sandbox couldn’t be reached'
    if (!failed) return progress('script', 'done')
    this.log(ws, `Archive script failed: ${failed}.\n`)
    progress('script', 'failed', { detail: failed })
    if (options.anyway) return
    this.log(ws, 'Nothing was stopped or deleted.\n')
    throw new ArchiveStepError('script', failed)
  }

  /**
   * The folder at the workspace's path is a worktree of its repository, and not another live workspace's.
   * A workspace whose creation hit someone else's folder must never checkpoint, script or remove it.
   * Only a failed creation ('error') yields, so the workspace that really lives there still archives cleanly.
   */
  private async ownsFolder(ws: Workspace): Promise<boolean> {
    const shared = ws.state === 'error' && this.state.workspaces.some((w) => w.id !== ws.id && w.state !== 'archived' && w.path && samePath(w.path, wsPath(ws)))
    return !shared && (await this.listWorktrees(ws.repoId)).some((t) => samePath(t.path, wsPath(ws)))
  }

  /**
   * G3 · O19: run the archive steps like setup's (in order, each with its timeout, parallel groups together),
   * logging to the Setup tab. `resume` carries on from the step the last attempt stopped at. Returns why it
   * failed ("exit code 3" for a single script, as before; "Seed DB: exit code 3" for a step), or null.
   */
  private async runArchiveSteps(ws: Workspace, steps: SetupStep[], resume: boolean, onChange: (results: SetupStepResult[]) => void): Promise<string | null> {
    const single = steps.length === 1
    const previous = resume ? this.archiveRuns.get(ws.id) : undefined
    const at = previous ? resumeIndex({ id: '', startedAt: '', steps: previous }, steps) : -1
    if (at > 0) this.log(ws, `\nCarrying on from ${steps[at].name} (archive step ${at + 1} of ${steps.length}); the steps before it passed.\n`)
    const run = runSetupSteps({
      steps,
      from: Math.max(0, at),
      previous: at >= 0 ? previous : undefined,
      cwd: this.gitTarget(ws),
      env: this.scriptEnv(ws),
      onStepStart: (i) => this.log(ws, single ? `\n$ ${steps[i].command}\n` : `\n[archive ${i + 1}/${steps.length}] ${steps[i].name}\n$ ${steps[i].command}\n`),
      onOutput: (_i, chunk) => this.log(ws, chunk),
      onChange: (results) => {
        this.archiveRuns.set(ws.id, results)
        onChange(results)
      }
    })
    this.archiveRuns.set(ws.id, run.results.map((r) => ({ ...r })))
    const outcome = await run.done
    if (outcome === 'done') return null
    const results = this.archiveRuns.get(ws.id) ?? run.results
    const step = results[failedStep({ id: '', startedAt: '', steps: results })]
    const why = !step ? outcome : step.status === 'timed-out' ? `timed out after ${duration(step.durationMs ?? 0)}` : `exit code ${step.exitCode}`
    return single || !step ? why : `${step.name}: ${why}`
  }

  private archiveDiffPath(ws: Workspace): string {
    return this.store.logPath(`${ws.id}-archive-diff.json`)
  }

  /** G3 · #13: the workspace's diff (everything since its branch point, uncommitted included) saved for the archived view. */
  private async saveArchiveDiff(ws: Workspace, tree?: string): Promise<boolean> {
    try {
      const diff = await workspaceDiff(ws, 'all', tree)
      const saved: ArchivedDiff = { at: new Date().toISOString(), baseRef: diff.baseRef, files: diff.files, truncated: diff.truncated }
      await mkdir(path.dirname(this.archiveDiffPath(ws)), { recursive: true })
      await writeFile(this.archiveDiffPath(ws), JSON.stringify(saved))
      ws.archiveDiff = {
        at: saved.at,
        files: diff.files.length,
        additions: diff.files.reduce((n, f) => n + f.additions, 0),
        deletions: diff.files.reduce((n, f) => n + f.deletions, 0),
        ...(diff.truncated ? { truncated: true } : {})
      }
      return true
    } catch (err) {
      this.log(ws, `Couldn’t keep the diff for the archived view: ${err instanceof Error ? err.message : String(err)}\n`)
      return false
    }
  }

  /** G3 · #13: the diff kept when an archived workspace was archived, or null when none was. */
  async archivedDiff(id: string): Promise<ArchivedDiff | null> {
    const ws = this.workspace(id)
    if (ws.state !== 'archived' || !ws.archiveDiff) return null
    try {
      return JSON.parse(await readFile(this.archiveDiffPath(ws), 'utf8')) as ArchivedDiff
    } catch {
      return null
    }
  }

  /** The kept diff goes when the workspace is restored (it has its worktree again) or forgotten. */
  private async dropArchiveDiff(ws: Workspace): Promise<void> {
    delete ws.archiveDiff
    await rm(this.archiveDiffPath(ws), { force: true }).catch(() => undefined)
  }

  /** O18: the workspace's labelled containers, running or stopped. Docker missing or stopped is a status. */
  dockerContainers(id: string): Promise<DockerListing> {
    return listContainers(this.workspace(id).id, this.docker)
  }

  /** O18: `docker rm -f` the workspace's labelled containers (containers only), logging each one. */
  async removeDockerContainers(id: string): Promise<DockerRemoval> {
    const ws = this.workspace(id)
    const extras = this.settingsFor(ws.repoId).removeDockerExtras
    this.log(ws, `\nRemoving Docker containers labelled foreman.workspace=${ws.id}${extras ? ', with their anonymous volumes and networks' : ''}\n`)
    const result = await removeContainers(ws.id, this.docker, extras)
    if (result.status === 'missing') this.log(ws, 'Docker isn’t installed; no containers were removed.\n')
    else if (result.status === 'not-running') this.log(ws, 'Docker isn’t running; no containers were removed.\n')
    else if (result.status === 'error') this.log(ws, `Couldn’t list containers: ${result.detail ?? ''}\n`)
    else {
      for (const name of result.removed) this.log(ws, `Removed ${name}\n`)
      for (const f of result.failed) this.log(ws, `Couldn’t remove ${f.name}: ${f.detail}\n`)
      if (!result.removed.length && !result.failed.length) this.log(ws, 'No labelled containers found.\n')
      for (const name of result.networks?.removed ?? []) this.log(ws, `Removed network ${name}\n`)
      for (const n of result.networks?.kept ?? []) this.log(ws, `Kept network ${n.name}: ${n.detail}\n`)
    }
    // G3 · O18: what's left stays on the workspace for Home's line, until removed again or dismissed.
    const left = dockerLeft(result, new Date().toISOString())
    if (left) ws.dockerLeft = left
    else delete ws.dockerLeft
    this.changed()
    return result
  }

  /** G3 · O18: Home's "still running after archive" line dismissed; nothing is removed. */
  dismissDockerLeft(id: string): void {
    delete this.workspace(id).dockerLeft
    this.changed()
  }

  /**
   * Bring an archived workspace back: recreate its worktree on the same
   * branch (or a new one from the archived commit if the branch is gone or
   * in use), restore its uncommitted work, and run setup again.
   */
  async unarchiveWorkspace(id: string): Promise<Workspace> {
    const ws = this.workspace(id)
    if (ws.state !== 'archived') return ws
    const repo = this.repo(ws.repoId)
    // A cloud workspace comes back asleep; opening it wakes the sandbox.
    if (ws.cloud) {
      if (!this.cloud) throw new Error('Remote workspaces aren’t available')
      await this.cloud.unarchive(ws)
      this.clearArchived(ws)
      // The archive-time diff belongs to the archived state.
      await this.dropArchiveDiff(ws)
      ws.state = 'ready'
      this.changed()
      return ws
    }
    if (isHistoryOnly(ws) || (ws.adopted && !ws.path)) {
      ws.state = 'history'
      this.clearArchived(ws)
      this.changed()
      return ws
    }
    if (ws.adopted) {
      if (!existsSync(wsPath(ws))) throw new Error(`${wsPath(ws)} no longer exists`)
      const taken = ws.direct && this.directWorkspace(ws.repoId)
      if (taken) throw new Error(`${taken.name} already works in the repository folder. Archive it first.`)
      this.clearArchived(ws)
      ws.state = 'ready'
      this.changed()
      return ws
    }
    if (existsSync(wsPath(ws))) throw new Error(`${wsPath(ws)} already exists`)
    await mkdir(path.dirname(wsPath(ws)), { recursive: true })
    const config = isWindows ? ['-c', 'core.longpaths=true'] : []
    const branchExists = Boolean(await revParse(repo.rootPath, `refs/heads/${ws.branch}`))
    const sameCommit = branchExists && ws.archiveCommit && (await revParse(repo.rootPath, ws.branch)) === ws.archiveCommit
    const attempt = branchExists
      ? await git(repo.rootPath, [...config, 'worktree', 'add', wsPath(ws), ws.branch], { allowFail: true })
      : { code: 1, stderr: '', stdout: '' }
    if (attempt.code !== 0) {
      if (!ws.archiveCommit) throw new Error(`Could not restore the branch: ${attempt.stderr.trim()}`)
      const restored = `${ws.branch}-restored-${ws.id.slice(0, 4)}`
      await git(repo.rootPath, [...config, 'worktree', 'add', '-b', restored, wsPath(ws), ws.archiveCommit])
      ws.branch = restored
    }
    // Uncommitted work saved at archive time comes back when HEAD still matches.
    if (sameCommit || attempt.code !== 0) await restoreCheckpoint(wsPath(ws), `archive-${ws.id}`).catch(() => undefined)
    await this.configurePush(repo, ws)
    await excludeContextDir(wsPath(ws)).catch(() => undefined)
    this.clearArchived(ws)
    // G3: the archive-time diff and Docker line belong to the archived state.
    delete ws.dockerLeft
    await this.dropArchiveDiff(ws)
    const hasSetup = Boolean(this.settingsFor(repo.id).setupScript.trim())
    ws.state = hasSetup ? 'setting-up' : 'ready'
    this.changed()
    if (hasSetup) void this.runSetup(ws, repo)
    return ws
  }

  /** Drop an archived workspace from the list (its branch is kept). A cloud workspace's sandbox is deleted. */
  async forgetWorkspace(id: string): Promise<void> {
    const ws = this.workspace(id)
    if (ws.state !== 'archived') throw new Error('Archive the workspace first')
    if (ws.cloud && this.cloud) await this.cloud.forget(ws)
    void this.dropArchiveDiff(ws)
    this.state.workspaces = this.state.workspaces.filter((w) => w.id !== id)
    this.state.sessions = this.state.sessions.filter((s) => s.workspaceId !== id)
    this.state.comments = this.state.comments.filter((c) => c.workspaceId !== id)
    this.changed()
  }

  /** "Keep" in Archived: the cleanup of auto-archived workspaces never deletes a kept one. */
  keepArchived(id: string, keep: boolean): void {
    const ws = this.workspace(id)
    if (ws.state !== 'archived') throw new Error('Only an archived workspace can be kept')
    if (keep) ws.keepArchived = true
    else delete ws.keepArchived
    this.changed()
  }

  /**
   * What deleting an archived workspace would lose that isn't anywhere else: commits on its local branch that aren't
   * on the pushed branch (else the base), and uncommitted work saved only in the archive checkpoint. Null counts
   * when git can't say. Nothing to check for a remote workspace (its sandbox goes) or one added from disk (its branch stays).
   */
  async archivedWork(id: string): Promise<ArchivedWork> {
    const ws = this.workspace(id)
    const repo = this.state.repos.find((r) => r.id === ws.repoId)
    const none: ArchivedWork = { id, branch: ws.branch, deletesBranch: false, unpushed: 0, uncommitted: false }
    if (!repo || ws.cloud || ws.adopted || !existsSync(repo.rootPath)) return none
    const deletesBranch = this.deletesBranch(ws, repo)
    const remote = repo.hasOrigin ? repo.remote || 'origin' : null
    const work: ArchivedWork = { ...none, deletesBranch }
    if (deletesBranch && (await revParse(repo.rootPath, `refs/heads/${ws.branch}`))) {
      work.unpushed = null
      for (const against of remote ? [`${remote}/${ws.branch}`, `${remote}/${ws.baseBranch}`, ws.baseBranch] : [ws.baseBranch]) {
        const out = await git(repo.rootPath, ['rev-list', '--count', `${against}..refs/heads/${ws.branch}`], { allowFail: true })
        if (out.code !== 0) continue
        work.unpushed = Number(out.stdout.trim()) || 0
        work.against = against
        break
      }
    }
    // The archive checkpoint's tree against the commit it was taken on: different means uncommitted work saved there.
    const ref = `${CHECKPOINT_REF_PREFIX}archive-${ws.id}`
    const tree = async (rev: string) => {
      const out = await git(repo.rootPath, ['rev-parse', '-q', '--verify', `${rev}^{tree}`], { allowFail: true })
      return out.code === 0 ? out.stdout.trim() : null
    }
    const saved = await tree(ref)
    const head = saved ? await tree(`${ref}^1`) : null
    work.uncommitted = Boolean(saved && head && saved !== head)
    return work
  }

  /** Delete removes the local branch unless it's the default branch, another workspace's, or one added from disk. */
  private deletesBranch(ws: Workspace, repo: Repo): boolean {
    if (ws.adopted || ws.cloud || ws.branch === repo.defaultBranch) return false
    return !this.state.workspaces.some((w) => w.id !== ws.id && w.repoId === ws.repoId && w.branch === ws.branch)
  }

  /**
   * Delete an archived workspace for good: its chats and records, the checkpoint kept at archive time, its logs and
   * its local branch. The remote branch and the pull request stay. A remote workspace's sandbox is deleted.
   */
  async deleteArchived(id: string): Promise<void> {
    const ws = this.workspace(id)
    if (ws.state !== 'archived') throw new Error('Archive the workspace first')
    const repo = this.state.repos.find((r) => r.id === ws.repoId)
    if (repo && !ws.cloud && existsSync(repo.rootPath)) {
      if (this.deletesBranch(ws, repo)) await git(repo.rootPath, ['branch', '-D', ws.branch], { allowFail: true })
      await deleteCheckpoints(repo.rootPath, `archive-${ws.id}`).catch(() => undefined)
    }
    const logs = path.dirname(this.store.logPath('x'))
    const mine = await readdir(logs).catch(() => [] as string[])
    await Promise.all(mine.filter((name) => name.startsWith(`${ws.id}-`)).map((name) => rm(path.join(logs, name), { recursive: true, force: true }).catch(() => undefined)))
    await this.forgetWorkspace(id)
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.setups.values()].map((s) => s.kill()))
  }
}
