// Workspaces from a GitHub issue or PR link: what gh knows about it, and the
// remote that the PR's refs/pull/N/head must be fetched from. O2: GitLab merge
// requests and issues the same way, through the host's API and refs/merge-requests/N/head.
import { findGithubLink, remoteForSlug, type GithubLink, type GithubLinkInfo } from '../shared/githubLink'
import { remoteForGitlabProject } from '../shared/scm'
import { git, gitOut, type GitTarget } from './git'
import { gh } from './github'
import { fetchGitlabLink, type GitlabApi } from './gitlab'

type Gh = (cwd: string, args: string[]) => Promise<string>

interface RawComment {
  author?: { login?: string } | null
  body?: string
  createdAt?: string
}

const PR_FIELDS = 'number,title,body,url,state,comments,headRefName,headRepository,headRepositoryOwner,isCrossRepository,baseRefName'

/** The remote of `repoRoot` that points at `repo` (owner/name). Never assumed to be origin. */
export async function remoteForRepo(repoRoot: string, repo: string): Promise<string | null> {
  // Configured URLs first (`remote -v` shows them after insteadOf rewriting), then what git would actually use.
  const configured = (await gitOut(repoRoot, ['config', '--get-regexp', '^remote\\..+\\.url$'], { allowFail: true }))
    .split('\n')
    .map((line) => /^remote\.(.+)\.url\s+(.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => `${m[1]} ${m[2]}`)
    .join('\n')
  return remoteForSlug(configured, repo) ?? remoteForSlug(await gitOut(repoRoot, ['remote', '-v']), repo)
}

/** O2: the remote of `repoRoot` that points at a GitLab project on `host` (host[:port]). G2: `root`, the host's relative URL root. */
export async function remoteForGitlabRepo(repoRoot: string, host: string, project: string, root?: string): Promise<string | null> {
  const hostname = host.replace(/:\d+$/, '')
  const configured = (await gitOut(repoRoot, ['config', '--get-regexp', '^remote\\..+\\.url$'], { allowFail: true }))
    .split('\n')
    .map((line) => /^remote\.(.+)\.url\s+(.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => `${m[1]} ${m[2]}`)
    .join('\n')
  return remoteForGitlabProject(configured, hostname, project, root) ?? remoteForGitlabProject(await gitOut(repoRoot, ['remote', '-v']), hostname, project, root)
}

/** The remote a checked-out pull request (or GitLab merge request) is fetched from. G2: `gitlabRoot`, its host's relative URL root. */
export function remoteForPullRequest(repoRoot: string, pr: { repo: string; gitlabHost?: string }, gitlabRoot?: string): Promise<string | null> {
  return pr.gitlabHost ? remoteForGitlabRepo(repoRoot, pr.gitlabHost, pr.repo, gitlabRoot) : remoteForRepo(repoRoot, pr.repo)
}

/** Read an issue or PR through gh. Throws when gh can't (not installed, not signed in, no access). */
export async function fetchGithubLink(link: GithubLink, cwd: string, run: Gh = gh): Promise<GithubLinkInfo> {
  const args = link.kind === 'pr' ? ['pr', 'view', link.url, '--json', PR_FIELDS] : ['issue', 'view', link.url, '--json', 'number,title,body,url,state,comments']
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await run(cwd, args))
  } catch (err) {
    throw new Error(`Couldn’t read ${link.url}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const comments = ((raw.comments as RawComment[] | undefined) ?? []).map((c) => ({ author: c.author?.login ?? 'unknown', body: c.body ?? '', at: c.createdAt }))
  const info: GithubLinkInfo = { ...link, title: String(raw.title ?? ''), body: String(raw.body ?? ''), comments }
  if (link.kind === 'pr') {
    info.headRef = raw.headRefName as string | undefined
    info.headOwner = (raw.headRepositoryOwner as { login?: string } | null)?.login
    info.isFork = Boolean(raw.isCrossRepository)
    info.baseRef = raw.baseRefName as string | undefined
  }
  return info
}

/** Link plus what the repository at `repoRoot` can do with it. */
export async function resolveGithubLink(repoRoot: string, text: string, run?: Gh): Promise<GithubLinkInfo> {
  const link = findGithubLink(text)
  if (!link) throw new Error('That isn’t a GitHub issue or pull request link')
  const info = await fetchGithubLink(link, repoRoot, run)
  if (link.kind === 'pr' && !(await remoteForRepo(repoRoot, link.repo))) info.problem = `None of this repository’s remotes points at ${link.repo}, so its pull requests can’t be fetched.`
  return info
}

/** O2: a GitLab MR or issue link plus what the repository at `repoRoot` can do with it. */
export async function resolveGitlabLink(repoRoot: string, link: GithubLink, api: GitlabApi): Promise<GithubLinkInfo> {
  const info = await fetchGitlabLink(link, api)
  if (link.kind === 'pr' && link.gitlabHost && !(await remoteForGitlabRepo(repoRoot, link.gitlabHost, link.repo, api.host.root))) {
    info.problem = `None of this repository’s remotes points at ${link.gitlabHost}/${link.repo}, so its merge requests can’t be fetched.`
  }
  return info
}

/** Fetch refs/pull/N/head (refs/merge-requests/N/head on GitLab) from the base repository's remote into a new local branch. */
export async function fetchPullHead(repoRoot: GitTarget, remote: string, number: number, branch: string, env?: Record<string, string>, gitlab = false): Promise<{ command: string; output: string }> {
  const args = ['fetch', remote, `${gitlab ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`}:refs/heads/${branch}`]
  const out = await git(repoRoot, args, { timeoutMs: 120_000, env })
  return { command: `git ${args.join(' ')}`, output: out.stderr + out.stdout }
}
