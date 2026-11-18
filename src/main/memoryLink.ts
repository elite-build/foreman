// An organization's memory repository linked to a remote (docs/ai-employees.md §4, "Pushing"): a private GitHub
// repository made for it, or a URL the person pastes. Linking sets the repository's `origin` and pushes its branch; from
// then on each commit the memory service makes is pushed, fast-forward only, one push at a time per organization. A push
// that fails is kept on the link with why, and the next commit (or Push now) tries again. Unlinking stops the pushes and
// leaves the remote repository as it is.
import { git } from './git'
import { checkedRemote, createPrivateGithubRepo } from './gitBackup'
import { credentialHelperEnv, githubEnvAsync, githubSlug } from './github'
import type { MemoryLinkInput, Organization } from '../shared/organizations'
import type { Repo } from '../shared/types'
import type { PersistedState } from './store'

export interface MemoryLinkHost {
  state(): PersistedState
  changed(): void
  // Tests: the remote's credentials and a GitHub repository made without gh.
  env?(remoteUrl: string, account?: string): Promise<Record<string, string>>
  createGithub?(name: string, account?: string): Promise<string>
  now?(): Date
}

const REMOTE = 'origin'

export class MemoryLinkService {
  // Per organization: the push running, and whether another commit landed while it ran.
  private running = new Map<string, Promise<void>>()
  private again = new Set<string>()

  constructor(private host: MemoryLinkHost) {}

  private organization(id: string): Organization {
    const org = this.host.state().organizations?.find((o) => o.id === id)
    if (!org) throw new Error('Organization not found')
    return org
  }

  private memory(org: Organization): Repo {
    const repo = org.memoryRepoId ? this.host.state().repos.find((r) => r.id === org.memoryRepoId) : undefined
    if (!repo) throw new Error(`${org.name} has no memory repository yet.`)
    return repo
  }

  private async env(remoteUrl: string, account?: string): Promise<Record<string, string>> {
    if (this.host.env) return this.host.env(remoteUrl, account)
    if (!githubSlug(remoteUrl)) return {}
    const env = await githubEnvAsync(account)
    return env.GH_TOKEN ? { ...env, ...credentialHelperEnv() } : env
  }

  private now(): string {
    return (this.host.now?.() ?? new Date()).toISOString()
  }

  /** Push the memory repository's branch to `remoteUrl`; throws git's reason, worded for a remote that has its own history. */
  private async pushTo(repo: Repo, remoteUrl: string, account?: string): Promise<void> {
    const branch = repo.defaultBranch || 'main'
    const out = await git(repo.rootPath, ['push', REMOTE, `refs/heads/${branch}:refs/heads/${branch}`], { env: await this.env(remoteUrl, account), timeoutMs: 120_000, allowFail: true })
    if (out.code === 0) return
    const reason = out.stderr.trim() || 'git push failed'
    if (/non-fast-forward|fetch first|rejected/i.test(reason)) throw new Error(`The remote repository has commits the memory repository doesn’t. Link an empty repository instead. (${reason})`)
    throw new Error(reason)
  }

  /** Link the organization's memory to a remote and push it there. Nothing is saved unless the first push lands. */
  async link(organizationId: string, input: MemoryLinkInput): Promise<Organization> {
    const org = this.organization(organizationId)
    const repo = this.memory(org)
    if (!input || (input.kind !== 'create' && input.kind !== 'existing')) throw new Error('Invalid link')
    const account = typeof input.account === 'string' && input.account ? input.account : undefined
    const remoteUrl =
      input.kind === 'create'
        ? await (this.host.createGithub ?? ((name: string, who?: string) => createPrivateGithubRepo(name, who, undefined, undefined, false)))(String(input.name ?? ''), account)
        : checkedRemote(String(input.remoteUrl ?? ''))
    // The remote it had, put back if the first push doesn't land.
    const before = await git(repo.rootPath, ['remote', 'get-url', REMOTE], { allowFail: true })
    const had = before.code === 0 ? before.stdout.trim() : null
    await git(repo.rootPath, had === null ? ['remote', 'add', REMOTE, remoteUrl] : ['remote', 'set-url', REMOTE, remoteUrl])
    try {
      await this.pushTo(repo, remoteUrl, account)
    } catch (err) {
      await git(repo.rootPath, had === null ? ['remote', 'remove', REMOTE] : ['remote', 'set-url', REMOTE, had], { allowFail: true })
      throw err
    }
    org.memoryLink = { remoteUrl, ...(account ? { account } : {}), pushedAt: this.now() }
    repo.remote = REMOTE
    repo.hasOrigin = true
    this.host.changed()
    return org
  }

  /** Stop pushing. The remote repository, and `origin` when it names something else now, are left alone. */
  async unlink(organizationId: string): Promise<Organization> {
    const org = this.organization(organizationId)
    const link = org.memoryLink
    if (!link) return org
    delete org.memoryLink
    const repo = org.memoryRepoId ? this.host.state().repos.find((r) => r.id === org.memoryRepoId) : undefined
    if (repo) {
      const current = await git(repo.rootPath, ['remote', 'get-url', REMOTE], { allowFail: true })
      if (current.code === 0 && current.stdout.trim() === link.remoteUrl) {
        await git(repo.rootPath, ['remote', 'remove', REMOTE], { allowFail: true })
        repo.hasOrigin = false
      }
    }
    this.host.changed()
    return org
  }

  /** Push now, and wait: the link keeps when it landed or why it didn't. Throws that reason. */
  async pushNow(organizationId: string): Promise<Organization> {
    const org = this.organization(organizationId)
    if (!org.memoryLink) throw new Error(`${org.name}’s memory isn’t linked to a remote.`)
    await this.queue(organizationId)
    const link = this.organization(organizationId).memoryLink
    if (link?.error) throw new Error(link.error)
    return this.organization(organizationId)
  }

  /** A memory commit landed: push it if the organization is linked. Never throws; a failure is kept on the link. */
  committed(organizationId: string): void {
    const org = this.host.state().organizations?.find((o) => o.id === organizationId)
    if (org?.memoryLink) void this.queue(organizationId)
  }

  /** One push at a time per organization; commits while one runs are pushed once after it. */
  private queue(organizationId: string): Promise<void> {
    const running = this.running.get(organizationId)
    if (running) {
      this.again.add(organizationId)
      return running
    }
    const run = (async () => {
      do {
        this.again.delete(organizationId)
        await this.pushOnce(organizationId)
      } while (this.again.has(organizationId))
    })().finally(() => this.running.delete(organizationId))
    this.running.set(organizationId, run)
    return run
  }

  private async pushOnce(organizationId: string): Promise<void> {
    const org = this.host.state().organizations?.find((o) => o.id === organizationId)
    const link = org?.memoryLink
    if (!org || !link) return
    let error: string | undefined
    try {
      await this.pushTo(this.memory(org), link.remoteUrl, link.account)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      console.error(`Memory push (${org.name}):`, error)
    }
    // Unlinked or linked elsewhere while it ran: this push says nothing about the link there is now.
    if (org.memoryLink !== link) return
    org.memoryLink = error ? { ...link, error } : { remoteUrl: link.remoteUrl, ...(link.account ? { account: link.account } : {}), pushedAt: this.now() }
    this.host.changed()
  }
}
