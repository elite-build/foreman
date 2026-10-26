// O2: which source-control host a repository's remote is on, and GitLab's links.
// Pure; the GitLab API client is main/gitlab.ts and the providers main/scm.ts.
// github.com, GitHub Enterprise and any host Foreman doesn't know stay on GitHub
// (through gh, as before); gitlab.com and the self-managed GitLab hosts the user
// adds in Settings → Git → Accounts are GitLab.
import { findGithubLink, type GithubLink } from './githubLink'
import { createT, type TFunction } from './i18n'

const enT = createT('en')

export const GITLAB_COM = 'https://gitlab.com'

/** A GitLab host: its base URL (https, maybe with a path) and the key its token is saved under. */
export interface GitlabHost {
  // https://gitlab.acme.dev, or https://acme.dev/gitlab for one under a relative URL root
  url: string
  // host[:port] of the URL; the token is stored per host (so one host serves one GitLab).
  host: string
  // G2: GitLab's relative URL root ("/gitlab") when it lives under a sub-path. Absent at the host's root.
  root?: string
}

export type ScmTarget =
  | { kind: 'github' }
  // project: the path of the project on the host ("group/sub/name").
  | { kind: 'gitlab'; host: GitlabHost; project: string }

/** A remote URL taken apart: the host's name and the repository path, without .git. Null for local paths. */
export function parseRemote(remoteUrl: string): { hostname: string; path: string; https: boolean } | null {
  const url = remoteUrl.trim()
  // scp-style: git@host:group/name.git
  const scp = /^(?:[^@/\s]+@)?([\w.-]+):(?!\/\/)([^\s]+)$/.exec(url)
  if (scp && !/^[a-z]:$/i.test(`${scp[1]}:`) && !url.includes('://')) return { hostname: scp[1].toLowerCase(), path: tidyPath(scp[2]), https: false }
  try {
    const parsed = new URL(url)
    if (!/^(https?|ssh|git):$/.test(parsed.protocol) || !parsed.hostname) return null
    return { hostname: parsed.hostname.toLowerCase(), path: tidyPath(decodeURIComponent(parsed.pathname)), https: parsed.protocol.startsWith('http') }
  } catch {
    return null
  }
}

function tidyPath(p: string): string {
  return p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
}

/**
 * A GitLab host as the user typed it ("gitlab.acme.dev", "https://gitlab.acme.dev/")
 * made canonical. Throws with a reason when it can't be one. Only https: a token
 * is never sent over plain http.
 */
export function normalizeGitlabHost(input: string): GitlabHost {
  let text = input.trim()
  if (!text) throw new Error('Enter the address of the GitLab host')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(`“${input.trim()}” isn’t a web address`)
  }
  if (url.protocol !== 'https:') throw new Error('Use an https:// address. Foreman doesn’t send a token over plain http.')
  if (url.username || url.password) throw new Error('Leave the user name and password out of the address')
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') throw new Error(`“${url.hostname}” isn’t a full host name`)
  // G2: a path is GitLab's relative URL root (https://acme.dev/gitlab). A pasted API address keeps what is before
  // /api/v4, and a pasted project or MR link what is before /-/; saving then tries each shorter prefix
  // (rootCandidates), since a link can't say where the root ends and the project starts.
  const host = url.host.toLowerCase()
  const root = rootOf(url.pathname)
  return root ? { url: `https://${host}${root}`, host, root } : { url: `https://${host}`, host }
}

function rootOf(pathname: string): string {
  let p = pathname
  const dash = p.indexOf('/-/')
  if (dash >= 0) p = p.slice(0, dash)
  const apiAt = p.search(/\/api\/v4(\/|$)/i)
  if (apiAt >= 0) p = p.slice(0, apiAt)
  const parts = p.split('/').filter(Boolean)
  if (parts.some((part) => part === '.' || part === '..')) return ''
  return parts.length ? `/${parts.join('/')}` : ''
}

/** G2: the roots worth testing for an address: the one typed first, then each shorter prefix, then the host itself. */
export function rootCandidates(host: GitlabHost): GitlabHost[] {
  const parts = (host.root ?? '').split('/').filter(Boolean)
  const out: GitlabHost[] = []
  for (let n = parts.length; n >= 0; n--) {
    const root = n ? `/${parts.slice(0, n).join('/')}` : ''
    out.push(root ? { url: `https://${host.host}${root}`, host: host.host, root } : { url: `https://${host.host}`, host: host.host })
  }
  return out
}

/** G2: a project path as an https remote or a web link has it, without the host's relative URL root. */
export function projectOnHost(path: string, host: Pick<GitlabHost, 'root'>): string {
  const root = (host.root ?? '').replace(/^\/+/, '')
  if (root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return path.slice(root.length + 1)
  return path
}

/** G2: the configured GitLab host for a host[:port] (as a link or a checked-out MR names it), with its root. */
export function gitlabHostFor(host: string, configured: readonly string[]): GitlabHost | undefined {
  return gitlabHosts(configured).find((h) => h.host === host.toLowerCase())
}

/** The configured hosts plus gitlab.com, which is always GitLab. Duplicates and unusable entries are dropped. */
export function gitlabHosts(configured: readonly string[]): GitlabHost[] {
  const out: GitlabHost[] = [normalizeGitlabHost(GITLAB_COM)]
  for (const entry of configured) {
    try {
      const host = normalizeGitlabHost(entry)
      if (!out.some((h) => h.host === host.host)) out.push(host)
    } catch {
      // A hand-edited entry that isn't a host; ignore it.
    }
  }
  return out
}

/** Which provider a repository's remote belongs to. */
export function scmForRemote(remoteUrl: string | null | undefined, configured: readonly string[]): ScmTarget {
  const remote = remoteUrl ? parseRemote(remoteUrl) : null
  if (!remote || !remote.path.includes('/')) return { kind: 'github' }
  // SSH often runs on its own name or port, so only the host's name is compared.
  const host = gitlabHosts(configured).find((h) => hostnameOf(h) === remote.hostname)
  if (!host) return { kind: 'github' }
  // Over https the relative URL root is part of the path; GitLab's ssh paths never carry it.
  return { kind: 'gitlab', host, project: remote.https ? projectOnHost(remote.path, host) : remote.path }
}

/** G2: whether a workspace is on GitLab, from what Foreman already knows: the MR it checked out, the last read, or its repo's remote. */
export function isGitlabWorkspace(
  ws: { pullRequest?: { gitlabHost?: string }; prInfo?: { facts?: { provider?: string } } },
  repo?: { remote?: string; remoteUrl?: string } | null,
  configured: readonly string[] = []
): boolean {
  if (ws.pullRequest?.gitlabHost || ws.prInfo?.facts?.provider === 'gitlab') return true
  if (ws.prInfo?.facts?.provider === 'github') return false
  return isGitlabRepo(repo, configured)
}

/** G2: whether a repository's remote is on a GitLab host (the URL recorded for origin; other remotes aren't known without git). */
export function isGitlabRepo(repo: { remote?: string; remoteUrl?: string } | null | undefined, configured: readonly string[] = []): boolean {
  return Boolean(repo && (repo.remote ?? 'origin') === 'origin' && scmForRemote(repo.remoteUrl, configured).kind === 'gitlab')
}

/** G2: "MR !87" on GitLab, "PR #87" elsewhere. */
export function prRefText(number: number, gitlab: boolean, t: TFunction = enT): string {
  return gitlab ? t('scm.ref.mr', { number }) : t('scm.ref.pr', { number })
}

function hostnameOf(host: GitlabHost): string {
  return host.host.replace(/:\d+$/, '')
}

/** A remote on a host whose name says GitLab but that isn't set up: worth a hint, never a guess. */
export function looksLikeGitlab(remoteUrl: string | null | undefined, configured: readonly string[]): string | null {
  const remote = remoteUrl ? parseRemote(remoteUrl) : null
  if (!remote || !/(^|\.)gitlab\./.test(remote.hostname)) return null
  return scmForRemote(remoteUrl, configured).kind === 'gitlab' ? null : remote.hostname
}

/**
 * The name of the first remote pointing at `project` on `hostname`. `remotes` is `git remote -v` style ("name url").
 * G2: `root` is the host's relative URL root, which https remotes carry in their path.
 */
export function remoteForGitlabProject(remotes: string, hostname: string, project: string, root?: string): string | null {
  const want = project.toLowerCase()
  for (const line of remotes.split('\n')) {
    const [name, url] = line.split(/\s+/)
    const remote = name && url ? parseRemote(url) : null
    if (!remote || remote.hostname !== hostname.toLowerCase()) continue
    const path = remote.https ? projectOnHost(remote.path, { root }) : remote.path
    if (path.toLowerCase() === want) return name
  }
  return null
}

// https://host/group/sub/project/-/merge_requests/87 or …/-/issues/12 (and work items, GitLab's newer issues).
const GITLAB_LINK = /https:\/\/([\w.-]+(?::\d+)?)\/((?:[\w.-]+\/)+[\w.-]+)\/-\/(merge_requests|issues|work_items)\/(\d+)(?![\w])/i

/** The first GitLab merge request or issue URL in a piece of text. Any host: the `/-/` path is GitLab's own. */
export function findGitlabLink(text: string): GithubLink | null {
  const m = GITLAB_LINK.exec(text)
  if (!m) return null
  const host = m[1].toLowerCase()
  const kind = m[3].toLowerCase() === 'merge_requests' ? 'pr' : 'issue'
  return { kind, repo: m[2], number: Number(m[4]), url: `https://${host}/${m[2]}/-/${kind === 'pr' ? 'merge_requests' : 'issues'}/${m[4]}`, gitlabHost: host }
}

/** The first GitHub PR/issue or GitLab MR/issue link in text, whichever comes first. */
export function findScmLink(text: string): GithubLink | null {
  const github = findGithubLink(text)
  const gitlab = findGitlabLink(text)
  if (!github || !gitlab) return github ?? gitlab
  return text.search(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/\d/i) <= text.search(GITLAB_LINK) ? github : gitlab
}

// ---- GitLab's merge-request facts, in Foreman's words ----

/** Why GitLab won't merge right now, as codes the panel words (several can hold at once). */
export type MergeBlock = 'pipeline-failed' | 'pipeline-running' | 'approvals' | 'threads' | 'draft' | 'conflict' | 'rebase' | 'checking' | 'blocked'

/** GitLab's draft prefixes, which "Mark as ready" takes off the title. */
export function stripDraftTitle(title: string): string {
  let next = title
  for (;;) {
    const stripped = next.replace(/^\s*(\[draft\]|\(draft\)|draft:|draft\s+-\s+|draft\s+)\s*/i, '')
    if (stripped === next) return next.trim()
    next = stripped
  }
}

/** GitLab's new-merge-request page for a branch, the "create manually" route. */
export function newMergeRequestUrl(projectWebUrl: string, source: string, target: string): string {
  const q = new URLSearchParams({ 'merge_request[source_branch]': source, 'merge_request[target_branch]': target })
  return `${projectWebUrl.replace(/\/+$/, '')}/-/merge_requests/new?${q.toString()}`
}

/** Instructions for the agent creating a merge request: GitLab's push options, so neither glab nor a token is needed. */
export function createMrInstructions(options: { base: string; draft: boolean; customPrompt: string; hasDiffTool: boolean; remote: string }): string {
  const { base, draft, remote } = options
  const custom = options.customPrompt.trim() ? `\n\n## Additional instructions\n\n${options.customPrompt.trim()}` : ''
  return `# Create a merge request

This repository is hosted on GitLab, so this is a merge request (GitLab's name for a pull request).

1. If there are uncommitted changes, commit them with a clear message that follows this repository's conventions (look at \`git log\`).
2. Review everything on this branch, not just the latest change: ${
    options.hasDiffTool ? 'use the GetWorkspaceDiff tool (start with stat: true), or ' : ''
  }\`git diff ${remote}/${base}...HEAD\`.
3. Push the branch and create the merge request in one step with GitLab's push options:
   \`git push -u ${remote} HEAD -o merge_request.create -o merge_request.target=${base} -o merge_request.title="<title>" -o merge_request.description="<description>"${draft ? ' -o merge_request.draft' : ''}\`
   - If the GitLab CLI (\`glab\`) is installed and signed in, \`glab mr create --target-branch ${base} --title "<title>" --description "<description>"${draft ? ' --draft' : ''} --yes\` after a plain push works too.
   - Title: under 80 characters, describing what the change does.
   - Description: if the repository has a merge request template (\`.gitlab/merge_request_templates/\`), fill it in. Otherwise write at most five sentences covering all the changes on the branch.
4. Reply with the merge request URL (GitLab prints it after the push).${custom}`
}

/** A job's run time as GitLab shows it: "48s", "6m 12s", "1h 03m". */
export function jobDuration(seconds: number | undefined, t: TFunction = enT): string {
  if (seconds === undefined || seconds < 0) return ''
  if (seconds < 60) return t('checks.duration.seconds', { s: seconds })
  if (seconds < 3600) return t('checks.duration.minutes', { m: Math.floor(seconds / 60), s: String(seconds % 60).padStart(2, '0') })
  return t('checks.duration.hours', { h: Math.floor(seconds / 3600), m: String(Math.floor((seconds % 3600) / 60)).padStart(2, '0') })
}
