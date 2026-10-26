// O2: one interface for the source-control host a repository lives on. GitHub
// wraps the gh code Foreman always had (same commands, same order); GitLab talks
// to the REST API with the host's token. The router picks one per repository from
// its remote's host: gitlab.com and the configured GitLab hosts are GitLab,
// everything else (github.com, GitHub Enterprise, unknown hosts) is GitHub as before.
import type { PrCheck, PullRequestInfo, Repo, ReviewThread, Workspace } from '../shared/types'
import type { ReviewSummary } from '../shared/prWatch'
import { newMergeRequestUrl, scmForRemote, type GitlabHost, type ScmTarget } from '../shared/scm'
import { wsPath } from '../shared/workspacePath'
import { gh, ghAs, ghAvailable, githubLogin, jobLog, mergeMethod, pullRequest, sandboxGh, type PrResult } from './github'
import {
  discussions,
  GitlabApi,
  gitlabPullRequest,
  gitlabSelf,
  jobTrace,
  mapDiscussions,
  markReady,
  mergeMergeRequest,
  projectWebUrl,
  retryPipeline,
  type Fetch
} from './gitlab'
import { fetchReviewSummaries, fetchReviewThreads } from './reviews'

export interface ScmProvider {
  readonly kind: 'github' | 'gitlab'
  // Who lookups run as: failures (auth, rate limits) pause only this identity.
  readonly identity: string
  // The GitLab host, for GitLab.
  readonly host?: GitlabHost
  // Whatever it reads through is there: gh installed, or a token saved for the host.
  available(): Promise<boolean>
  pullRequest(ws: Workspace): Promise<PrResult>
  reviewThreads(ws: Workspace, pr: PullRequestInfo): Promise<ReviewThread[]>
  // Everyone else's review comment ids and review summaries, for the review watch.
  reviewActivity(ws: Workspace, pr: PullRequestInfo): Promise<{ comments: string[]; reviews: ReviewSummary[] }>
  merge(ws: Workspace, pr: PullRequestInfo, head: string): Promise<void>
  autoMerge(ws: Workspace, pr: PullRequestInfo): Promise<void>
  markReady(ws: Workspace, pr: PullRequestInfo): Promise<void>
  rerunFailed(ws: Workspace, pr: PullRequestInfo): Promise<void>
  // A failed check's log, or a line saying where it is.
  failureLog(ws: Workspace, check: PrCheck): Promise<string>
  // The page that creates a pull request for the branch (after it's pushed).
  newPullRequestUrl(ws: Workspace): Promise<string>
}

/**
 * Today's gh code, as a provider. `account` is the repo's linked gh account (gh's active one when unset).
 * A cloud workspace's gh runs in its sandbox as the repository's connection (sandboxGh); its actions wake it.
 */
export function githubProvider(account: string | undefined): ScmProvider {
  const request = ghAs(account)
  const as = (ws: Workspace, args: string[], timeoutMs?: number) => (ws.cloud ? sandboxGh(ws, { wake: true })('', args, timeoutMs) : gh(wsPath(ws), args, timeoutMs, account))
  // Where gh runs for a workspace: its folder here (with `run`), or its sandbox. Only actions wake a sleeping sandbox.
  const place = (ws: Workspace, run: typeof gh, wake = false): { cwd: string; run: typeof gh } =>
    ws.cloud ? { cwd: ws.cloud.cwd, run: sandboxGh(ws, { wake }) } : { cwd: wsPath(ws), run }
  // A checked-out PR lives in its base repository, which may not be the repo gh infers from the remote (fork PRs).
  const repoArgs = (ws: Workspace) => (ws.pullRequest ? ['--repo', ws.pullRequest.repo] : [])
  return {
    kind: 'github',
    identity: account ?? '',
    available: ghAvailable,
    pullRequest: (ws) => pullRequest(ws, request),
    reviewThreads: (ws, pr) => {
      const p = place(ws, request)
      return fetchReviewThreads(p.cwd, pr, p.run)
    },
    reviewActivity: async (ws, pr) => {
      const p = place(ws, request)
      const [threads, summaries, self] = await Promise.all([fetchReviewThreads(p.cwd, pr, p.run), fetchReviewSummaries(p.cwd, pr, p.run), githubLogin(account)])
      const theirs = (author: string) => author !== self
      return {
        comments: threads.flatMap((t) => t.comments).filter((c) => theirs(c.author)).map((c) => c.id),
        reviews: summaries.filter((r) => theirs(r.author)).map(({ id, state, body }) => ({ id, state, body }))
      }
    },
    merge: async (ws, pr, head) => {
      const p = place(ws, gh, true)
      const method = await mergeMethod(p.cwd, ws.pullRequest?.repo, account, p.run)
      await as(ws, ['pr', 'merge', String(pr.number), ...repoArgs(ws), `--${method}`, '--match-head-commit', head], 120_000)
    },
    autoMerge: async (ws, pr) => {
      const p = place(ws, gh, true)
      const method = await mergeMethod(p.cwd, ws.pullRequest?.repo, account, p.run)
      await as(ws, ['pr', 'merge', String(pr.number), ...repoArgs(ws), '--auto', `--${method}`], 60_000)
    },
    markReady: async (ws, pr) => {
      await as(ws, ['pr', 'ready', String(pr.number), ...repoArgs(ws)])
    },
    rerunFailed: async (ws, pr) => {
      const runs = new Set(pr.checks.filter((c) => c.state === 'failure' && c.runId).map((c) => c.runId!))
      if (!runs.size) throw new Error('No failed GitHub Actions runs to rerun')
      for (const run of runs) await as(ws, ['run', 'rerun', String(run), ...repoArgs(ws), '--failed'])
    },
    failureLog: async (ws, check) => {
      const log = `${check.name} failed.${check.url ? ` Details: ${check.url}` : ''}`
      const p = place(ws, gh)
      return check.jobId ? jobLog(p.cwd, check.jobId, undefined, ws.pullRequest?.repo, account, p.run).catch(() => log) : log
    },
    newPullRequestUrl: async (ws) => {
      const url = JSON.parse(await as(ws, ['repo', 'view', '--json', 'url'])).url as string
      return `${url}/compare/${encodeURIComponent(ws.baseBranch)}...${encodeURIComponent(ws.branch)}?expand=1`
    }
  }
}

/** A GitLab project through the REST API. A checked-out MR is read by its !iid in its own project. */
export function gitlabProvider(host: GitlabHost, projectPath: string, token: string | undefined, fetchFn?: Fetch): ScmProvider {
  const api = new GitlabApi(host, token, fetchFn)
  // The MR's project: the one a checked-out MR came from, else the repo's remote.
  const projectOf = (ws: Workspace) => (ws.pullRequest?.gitlabHost ? ws.pullRequest.repo : projectPath)
  return {
    kind: 'gitlab',
    identity: `gitlab:${host.host}`,
    host,
    available: async () => Boolean(token),
    pullRequest: (ws) => gitlabPullRequest(api, projectOf(ws), ws.branch, ws.pullRequest?.gitlabHost ? ws.pullRequest.number : undefined),
    reviewThreads: async (ws, pr) => mapDiscussions(await discussions(api, projectOf(ws), pr.number), pr.url, pr.pipeline?.sha),
    reviewActivity: async (ws, pr) => {
      const [all, self] = await Promise.all([discussions(api, projectOf(ws), pr.number), gitlabSelf(api)])
      const theirs = (author: string | undefined) => author !== self
      return {
        comments: all.flatMap((d) => d.notes ?? []).filter((n) => !n.system && theirs(n.author?.username)).map((n) => String(n.id)),
        // GitLab has no review summaries in its REST API; an approval is the closest thing.
        reviews: (pr.approvals?.by ?? []).filter((u) => theirs(u)).map((u) => ({ id: `approval:${u}`, state: 'APPROVED', body: '' }))
      }
    },
    merge: (ws, pr, head) => mergeMergeRequest(api, projectOf(ws), pr.number, { sha: head }),
    autoMerge: (ws, pr) => mergeMergeRequest(api, projectOf(ws), pr.number, { auto: true }),
    markReady: (ws, pr) => markReady(api, projectOf(ws), pr.number, pr.title),
    rerunFailed: async (ws, pr) => {
      const pipelines = new Set(pr.checks.filter((c) => c.state === 'failure' && c.runId).map((c) => c.runId!))
      if (!pipelines.size) throw new Error('No failed GitLab jobs to retry')
      for (const id of pipelines) await retryPipeline(api, projectOf(ws), id)
    },
    failureLog: async (ws, check) => {
      const log = `${check.name} failed.${check.url ? ` Details: ${check.url}` : ''}`
      return check.jobId ? jobTrace(api, projectOf(ws), check.jobId).catch(() => log) : log
    },
    newPullRequestUrl: async (ws) => newMergeRequestUrl(await projectWebUrl(api, projectPath), ws.branch, ws.baseBranch)
  }
}

export interface ScmRouterDeps {
  repo: (repoId: string) => Repo
  // The URL the repository pushes to, or null without a remote.
  remoteUrl: (repoId: string) => Promise<string | null>
  // Settings → Git → Accounts' self-managed hosts.
  gitlabHosts: () => readonly string[]
  // The vault's token for a GitLab host (host[:port]).
  gitlabToken: (host: string) => string | undefined
  // Integrations: who GitHub work in the repository runs as (a gh login or an identity key; see github.ts).
  // Without it, the repository's old linked account.
  githubKey?: (repoId: string) => string | undefined
  githubIdentity?: (repoId: string) => string
  fetch?: Fetch
  now?: () => number
  ttlMs?: number
}

/** Picks each repository's provider from its remote, remembering remote URLs for a minute. */
export class ScmRouter {
  private urls = new Map<string, { remote: string; url: string | null; at: number }>()

  constructor(private deps: ScmRouterDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Where the repository's remote is, from the last answer (or the URL recorded when it was added). Never waits. */
  cachedTarget(repoId: string): ScmTarget {
    const repo = this.deps.repo(repoId)
    const hit = this.urls.get(repoId)
    const url = hit && hit.remote === repo.remote ? hit.url : repo.remote === 'origin' ? (repo.remoteUrl ?? null) : null
    return scmForRemote(url, this.deps.gitlabHosts())
  }

  async target(repoId: string): Promise<ScmTarget> {
    const repo = this.deps.repo(repoId)
    const hit = this.urls.get(repoId)
    if (!hit || hit.remote !== repo.remote || this.now() - hit.at > (this.deps.ttlMs ?? 60_000)) {
      const url = await this.deps.remoteUrl(repoId).catch(() => null)
      this.urls.set(repoId, { remote: repo.remote, url, at: this.now() })
    }
    return this.cachedTarget(repoId)
  }

  async forRepo(repoId: string): Promise<ScmProvider> {
    return this.providerFor(repoId, await this.target(repoId))
  }

  /** Never waits: for callers that must answer at once (the PR cache's identity). */
  identity(repoId: string): string {
    const target = this.cachedTarget(repoId)
    return target.kind === 'gitlab' ? `gitlab:${target.host.host}` : (this.deps.githubIdentity?.(repoId) ?? this.githubKey(repoId) ?? '')
  }

  private providerFor(repoId: string, target: ScmTarget): ScmProvider {
    if (target.kind === 'gitlab') return gitlabProvider(target.host, target.project, this.deps.gitlabToken(target.host.host), this.deps.fetch)
    return githubProvider(this.githubKey(repoId))
  }

  private githubKey(repoId: string): string | undefined {
    return this.deps.githubKey ? this.deps.githubKey(repoId) : this.deps.repo(repoId).githubAccount
  }

  /** Hosts or remotes changed: look again. */
  forget(): void {
    this.urls.clear()
  }
}

/** Where a GitLab token lives in the vault's app secrets. */
export function gitlabTokenKey(host: string): string {
  return `gitlab-token:${host.toLowerCase()}`
}
