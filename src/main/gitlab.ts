// O2: GitLab merge requests, pipelines and threads through GitLab's REST API v4,
// over HTTPS with Node's fetch and a personal access token from the vault, so
// glab isn't needed. The token is only ever sent to its own host. The mapping
// functions turn GitLab's answers into Foreman's pull-request model, so the Git
// panel, the shared PR cache and the CI / review watches work unchanged.
import { execFile } from 'node:child_process'
import type { GitlabConnection, PrCheck, PullRequestInfo, ReviewThread } from '../shared/types'
import type { GithubLink, GithubLinkInfo } from '../shared/githubLink'
import { rootCandidates, stripDraftTitle, type GitlabHost, type MergeBlock } from '../shared/scm'
import type { PrResult } from './github'

export type Fetch = typeof fetch

/** Why a GitLab request failed. Messages are worded so classifyGhError sorts them the same way. */
export class GitlabError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate' | 'not-found' | 'other',
    readonly status?: number
  ) {
    super(message)
  }
}

interface Answer<T> {
  data: T
  nextPage?: string
}

/** One GitLab host, as one token. */
export class GitlabApi {
  constructor(
    readonly host: GitlabHost,
    private token: string | undefined,
    private fetchFn: Fetch = fetch,
    private timeoutMs = 20_000
  ) {}

  /** Host and token together, for caches; never shown. */
  get identity(): string {
    return `${this.host.host}|${this.token ?? ''}`
  }

  private async call<T>(path: string, init: { method?: string; body?: Record<string, unknown>; text?: boolean } = {}): Promise<Answer<T>> {
    if (!this.token) throw new GitlabError(`GitLab authentication needed: no token is saved for ${this.host.host}. Add one in Settings → Git → Accounts.`, 'auth')
    let res: Response
    try {
      res = await this.fetchFn(`${this.host.url}/api/v4${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: init.text ? 'text/plain' : 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        // A redirect could carry the token to another host.
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (err) {
      throw new GitlabError(`Couldn’t reach ${this.host.host}: ${err instanceof Error ? err.message : String(err)}`, 'other')
    }
    if (!res.ok) throw await failure(res, this.host.host)
    const nextPage = res.headers.get('x-next-page') || undefined
    if (init.text) return { data: (await res.text()) as T, nextPage }
    const text = await res.text()
    try {
      return { data: (text ? JSON.parse(text) : null) as T, nextPage }
    } catch {
      throw new GitlabError(`${this.host.host} didn’t answer as GitLab (not JSON)`, 'other', res.status)
    }
  }

  async get<T>(path: string): Promise<T> {
    return (await this.call<T>(path)).data
  }

  async text(path: string): Promise<string> {
    return (await this.call<string>(path, { text: true })).data
  }

  async send<T>(method: 'POST' | 'PUT', path: string, body?: Record<string, unknown>): Promise<T> {
    return (await this.call<T>(path, { method, body })).data
  }

  /** Every page of a list (100 a page, at most `maxPages`). */
  async all<T>(path: string, maxPages = 20): Promise<T[]> {
    const out: T[] = []
    let page: string | undefined = '1'
    for (let n = 0; page && n < maxPages; n++) {
      const sep = path.includes('?') ? '&' : '?'
      const answer: Answer<T[]> = await this.call<T[]>(`${path}${sep}per_page=100&page=${page}`)
      out.push(...(answer.data ?? []))
      page = answer.nextPage
    }
    return out
  }
}

async function failure(res: Response, host: string): Promise<GitlabError> {
  let detail = ''
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown; error_description?: unknown }
    const raw = body.message ?? body.error_description ?? body.error
    detail = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : ''
  } catch {
    // Not JSON; the status says enough.
  }
  const tail = detail ? `: ${detail}` : ''
  switch (res.status) {
    case 401:
      return new GitlabError(`GitLab rejected the token for ${host} (HTTP 401). Check it in Settings → Git → Accounts.`, 'auth', 401)
    case 403:
      return new GitlabError(`GitLab refused this (HTTP 403)${tail}. The token may lack the api scope.`, 'other', 403)
    case 404:
      return new GitlabError(`Not found on ${host} (HTTP 404)${tail}`, 'not-found', 404)
    case 429:
      return new GitlabError(`GitLab rate limit reached on ${host} (HTTP 429)`, 'rate', 429)
    default:
      return new GitlabError(`GitLab answered HTTP ${res.status}${tail}`, 'other', res.status)
  }
}

const project = (path: string) => `/projects/${encodeURIComponent(path)}`

// ---- raw shapes (only the fields Foreman reads) ----

export interface RawMergeRequest {
  iid: number
  title: string
  description?: string | null
  state: 'opened' | 'closed' | 'merged' | 'locked'
  draft?: boolean
  work_in_progress?: boolean
  web_url: string
  source_branch: string
  target_branch: string
  source_project_id?: number
  target_project_id?: number
  sha?: string
  merge_status?: string
  detailed_merge_status?: string
  has_conflicts?: boolean
  blocking_discussions_resolved?: boolean
  merge_when_pipeline_succeeds?: boolean
  head_pipeline?: { id: number; status: string; web_url?: string; sha?: string } | null
  diff_refs?: { head_sha?: string } | null
  merged_at?: string | null
}

export interface RawApprovals {
  approvals_required?: number
  approvals_left?: number
  approved_by?: { user?: { username?: string } | null }[]
}

export interface RawJob {
  id: number
  name: string
  stage?: string
  status: string
  web_url?: string
  allow_failure?: boolean
  duration?: number | null
}

// G2: a bridge (trigger) job, which starts a downstream or child pipeline instead of running a script.
export interface RawBridge {
  id: number
  name: string
  stage?: string
  status: string
  web_url?: string
  allow_failure?: boolean
  duration?: number | null
  downstream_pipeline?: { id: number; status?: string; web_url?: string } | null
}

export interface RawNote {
  id: number
  body?: string
  author?: { username?: string } | null
  created_at: string
  updated_at?: string
  system?: boolean
  resolvable?: boolean
  resolved?: boolean
  position?: { new_path?: string | null; old_path?: string | null; new_line?: number | null; old_line?: number | null; head_sha?: string | null } | null
}

export interface RawDiscussion {
  id: string
  notes: RawNote[]
}

// ---- mapping into Foreman's model ----

/** A GitLab job as a check row. A manual job nobody started isn't pending: it's left out of "running". */
export function mapJob(job: RawJob, pipelineId?: number): PrCheck {
  const state: PrCheck['state'] = (() => {
    switch (job.status) {
      case 'success':
        return 'success'
      case 'failed':
      case 'canceled':
      case 'canceling':
        return 'failure'
      case 'skipped':
      case 'manual':
        return 'skipped'
      case 'created':
      case 'pending':
      case 'running':
      case 'preparing':
      case 'waiting_for_resource':
      case 'waiting_for_callback':
      case 'scheduled':
        return 'pending'
      default:
        return 'neutral'
    }
  })()
  return {
    name: job.name,
    state,
    url: job.web_url,
    runId: pipelineId,
    jobId: job.id,
    // An allowed failure doesn't fail the pipeline: GitLab's optional check.
    ...(job.allow_failure ? { required: false } : {}),
    ...(job.stage ? { stage: job.stage } : {}),
    ...(job.status === 'manual' ? { manual: true } : {}),
    ...(typeof job.duration === 'number' ? { duration: Math.round(job.duration) } : {})
  }
}

/**
 * G2: a trigger job as a check row. Its state is the bridge's own (GitLab mirrors the downstream pipeline into it
 * with `strategy: depend`); it has no log, so it links to the downstream pipeline and carries no job id.
 */
export function mapBridge(bridge: RawBridge, pipelineId?: number): PrCheck {
  const downstream = bridge.downstream_pipeline ?? undefined
  const row = mapJob({ id: bridge.id, name: bridge.name, stage: bridge.stage, status: bridge.status, web_url: downstream?.web_url ?? bridge.web_url, allow_failure: bridge.allow_failure, duration: bridge.duration }, pipelineId)
  delete row.jobId
  return { ...row, trigger: true, ...(downstream ? { downstream: { id: downstream.id, ...(downstream.status ? { status: downstream.status } : {}) } } : {}) }
}

const STATE_ORDER: Record<PrCheck['state'], number> = { failure: 0, pending: 1, success: 2, neutral: 3, skipped: 4 }

/** Failed jobs first, then running ones, then the rest, each in pipeline order. G2: trigger jobs among them. */
export function mapJobs(jobs: RawJob[], pipelineId?: number, bridges: RawBridge[] = []): PrCheck[] {
  return [...jobs.map((job) => ({ id: job.id, row: mapJob(job, pipelineId) })), ...bridges.map((b) => ({ id: b.id, row: mapBridge(b, pipelineId) }))]
    .sort((a, b) => a.id - b.id)
    .map((x) => x.row)
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state])
}

export function mapApprovals(raw: RawApprovals | null | undefined): PullRequestInfo['approvals'] {
  if (!raw) return undefined
  const by = (raw.approved_by ?? []).map((a) => a.user?.username).filter((u): u is string => Boolean(u))
  const required = raw.approvals_required ?? 0
  return { given: by.length, required, by }
}

const PIPELINE_FAILED = new Set(['failed', 'canceled'])

/** Why GitLab won't merge now, from its detailed status plus the facts that certainly block. */
export function mergeBlocks(mr: RawMergeRequest, approvals: PullRequestInfo['approvals'], approvalsLeft?: number): MergeBlock[] {
  if (mr.state !== 'opened') return []
  const found = new Set<MergeBlock>()
  const pipelineFailed = PIPELINE_FAILED.has(mr.head_pipeline?.status ?? '')
  const detailed = mr.detailed_merge_status
  switch (detailed) {
    case undefined:
      // GitLab before 15.6 only has merge_status.
      if (mr.merge_status === 'cannot_be_merged') found.add('conflict')
      else if (mr.merge_status === 'checking' || mr.merge_status === 'unchecked') found.add('checking')
      break
    case 'mergeable':
    case 'not_open':
      break
    case 'ci_must_pass':
    case 'ci_still_running':
      found.add(pipelineFailed ? 'pipeline-failed' : 'pipeline-running')
      break
    case 'not_approved':
    case 'approvals_syncing':
    case 'requested_changes':
      found.add('approvals')
      break
    case 'discussions_not_resolved':
      found.add('threads')
      break
    case 'draft_status':
      found.add('draft')
      break
    case 'conflict':
      found.add('conflict')
      break
    case 'need_rebase':
      found.add('rebase')
      break
    case 'checking':
    case 'unchecked':
    case 'preparing':
      found.add('checking')
      break
    default:
      found.add('blocked')
  }
  if (mr.draft ?? mr.work_in_progress) found.add('draft')
  if (mr.has_conflicts) found.add('conflict')
  if ((approvalsLeft ?? (approvals ? approvals.required - approvals.given : 0)) > 0) found.add('approvals')
  if (mr.blocking_discussions_resolved === false) found.add('threads')
  const order: MergeBlock[] = ['pipeline-failed', 'pipeline-running', 'approvals', 'threads', 'draft', 'conflict', 'rebase', 'checking', 'blocked']
  return order.filter((b) => found.has(b))
}

const STATE: Record<RawMergeRequest['state'], PullRequestInfo['state']> = { opened: 'OPEN', merged: 'MERGED', closed: 'CLOSED', locked: 'CLOSED' }

/** A merge request, its approvals and its head pipeline's jobs, as Foreman's pull request. */
export function mapMergeRequest(mr: RawMergeRequest, rawApprovals: RawApprovals | null | undefined, jobs: RawJob[], bridges: RawBridge[] = []): PullRequestInfo {
  const approvals = mapApprovals(rawApprovals)
  const blocks = mergeBlocks(mr, approvals, rawApprovals?.approvals_left)
  const left = rawApprovals?.approvals_left ?? (approvals ? Math.max(0, approvals.required - approvals.given) : 0)
  const reviewDecision =
    mr.detailed_merge_status === 'requested_changes'
      ? 'CHANGES_REQUESTED'
      : approvals && left > 0
        ? 'REVIEW_REQUIRED'
        : approvals && approvals.required > 0
          ? 'APPROVED'
          : undefined
  const pipeline = mr.head_pipeline
  return {
    number: mr.iid,
    url: mr.web_url,
    title: mr.title,
    body: mr.description ?? undefined,
    state: STATE[mr.state] ?? 'CLOSED',
    isDraft: Boolean(mr.draft ?? mr.work_in_progress),
    mergeable: blocks.includes('conflict') ? 'CONFLICTING' : blocks.includes('checking') ? 'UNKNOWN' : 'MERGEABLE',
    mergeStateStatus: mr.state !== 'opened' ? undefined : blocks.length ? 'BLOCKED' : 'CLEAN',
    reviewDecision,
    baseRefName: mr.target_branch,
    checks: mapJobs(jobs, pipeline?.id, bridges),
    autoMerge: Boolean(mr.merge_when_pipeline_succeeds),
    provider: 'gitlab',
    ...(mr.merged_at ? { mergedAt: mr.merged_at } : {}),
    ...(approvals ? { approvals } : {}),
    ...(pipeline ? { pipeline: { id: pipeline.id, status: pipeline.status, url: pipeline.web_url, sha: pipeline.sha } } : {}),
    ...(blocks.length ? { mergeBlocked: blocks } : {})
  }
}

/** Resolvable discussions as review threads. Plain comments aren't threads; system notes aren't comments. */
export function mapDiscussions(discussions: RawDiscussion[], mrUrl: string, headSha?: string): ReviewThread[] {
  const threads: ReviewThread[] = []
  for (const d of discussions) {
    const notes = (d.notes ?? []).filter((n) => !n.system)
    const first = notes[0]
    if (!first?.resolvable) continue
    const pos = first.position ?? undefined
    const resolvable = notes.filter((n) => n.resolvable)
    threads.push({
      id: d.id,
      path: pos?.new_path ?? pos?.old_path ?? '',
      line: pos ? (pos.new_line ?? pos.old_line ?? null) : null,
      side: pos && pos.new_line == null && pos.old_line != null ? 'LEFT' : 'RIGHT',
      isResolved: resolvable.length > 0 && resolvable.every((n) => n.resolved),
      // Written against an older head of the branch; the line may have moved since.
      isOutdated: Boolean(pos?.head_sha && headSha && pos.head_sha !== headSha),
      comments: notes.map((n) => ({
        id: String(n.id),
        author: n.author?.username ?? 'Deleted user',
        body: n.body ?? '',
        url: `${mrUrl}#note_${n.id}`,
        createdAt: n.created_at,
        updatedAt: n.updated_at ?? n.created_at,
        // GitLab's REST API doesn't return the diff context of a note.
        diffHunk: ''
      }))
    })
  }
  return threads
}

// ---- reads ----

/** "18.4.1-ee" → "18.4". */
export function shortVersion(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version)
  return m ? `${m[1]}.${m[2]}` : version
}

/** Ask the host for its GitLab version and who the token is. Nothing is saved here. */
export async function testConnection(api: GitlabApi): Promise<GitlabConnection> {
  try {
    const version = await api.get<{ version?: unknown }>('/version')
    if (!version || typeof version.version !== 'string') return { ok: false, error: `${api.host.host} didn’t answer as GitLab` }
    const user = await api.get<{ username?: unknown }>('/user')
    if (!user || typeof user.username !== 'string') return { ok: false, error: `${api.host.host} didn’t say who the token belongs to` }
    return { ok: true, version: shortVersion(version.version), user: user.username }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Something that isn't GitLab usually 404s /api/v4/version.
    return { ok: false, error: err instanceof GitlabError && err.kind === 'not-found' ? `${api.host.host} didn’t answer as GitLab (no /api/v4)` : message }
  }
}

/**
 * G2: test an address, and when it doesn't answer, each shorter path of it (a pasted project link under a relative
 * URL root): the first that answers as GitLab is the host. The token only goes to this one host. Nothing is saved.
 */
export async function probeGitlab(host: GitlabHost, token: string, fetchFn?: Fetch): Promise<{ host: GitlabHost; result: GitlabConnection }> {
  let first: GitlabConnection | undefined
  for (const candidate of rootCandidates(host)) {
    const result = await testConnection(new GitlabApi(candidate, token, fetchFn))
    if (result.ok) return { host: candidate, result }
    first ??= result
  }
  return { host, result: first ?? { ok: false, error: `${host.host} didn’t answer as GitLab` } }
}

/** The merge request for a branch: an open one first, else the most recently updated. */
export async function findMergeRequestIid(api: GitlabApi, projectPath: string, branch: string): Promise<number | null> {
  const q = (extra: string) => `${project(projectPath)}/merge_requests?source_branch=${encodeURIComponent(branch)}&per_page=5${extra}`
  const open = await api.get<RawMergeRequest[]>(q('&state=opened'))
  if (open?.length) return open[0].iid
  const any = await api.get<RawMergeRequest[]>(q('&order_by=updated_at&sort=desc'))
  return any?.length ? any[0].iid : null
}

/** Everything the Git panel shows about one merge request. Approvals and jobs are best effort. */
export async function mergeRequestInfo(api: GitlabApi, projectPath: string, iid: number): Promise<{ pr: PullRequestInfo; sha: string }> {
  const mr = await api.get<RawMergeRequest>(`${project(projectPath)}/merge_requests/${iid}`)
  const pipeline = mr.head_pipeline
  const [approvals, jobs, bridges] = await Promise.all([
    api.get<RawApprovals>(`${project(projectPath)}/merge_requests/${iid}/approvals`).catch(() => null),
    pipeline ? api.all<RawJob>(`${project(projectPath)}/pipelines/${pipeline.id}/jobs`, 5).catch(() => []) : Promise.resolve([]),
    // G2: trigger jobs aren't in /jobs; they have their own list.
    pipeline ? api.all<RawBridge>(`${project(projectPath)}/pipelines/${pipeline.id}/bridges`, 2).catch(() => []) : Promise.resolve([])
  ])
  return { pr: mapMergeRequest(mr, approvals, jobs, bridges), sha: mr.sha ?? mr.diff_refs?.head_sha ?? '' }
}

/** The PR-cache lookup for a GitLab branch (or a checked-out MR by its !iid). */
export async function gitlabPullRequest(api: GitlabApi, projectPath: string, branch: string, iid?: number): Promise<PrResult> {
  try {
    const number = iid ?? (await findMergeRequestIid(api, projectPath, branch))
    if (number === null) return { kind: 'no-pr' }
    const { pr, sha } = await mergeRequestInfo(api, projectPath, number)
    return { kind: 'ok', pr, headRefOid: sha, repo: `${api.host.host}/${projectPath}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof GitlabError && err.kind === 'auth') return { kind: 'auth-error', message }
    if (err instanceof GitlabError && err.kind === 'rate') return { kind: 'unavailable', message, rateLimited: true }
    return { kind: 'unavailable', message }
  }
}

export async function discussions(api: GitlabApi, projectPath: string, iid: number): Promise<RawDiscussion[]> {
  return api.all<RawDiscussion>(`${project(projectPath)}/merge_requests/${iid}/discussions`)
}

/** The user the token signs in as, cached per host and token (a failed look isn't kept). */
const selves = new Map<string, Promise<string | undefined>>()
export function gitlabSelf(api: GitlabApi): Promise<string | undefined> {
  let hit = selves.get(api.identity)
  if (!hit) {
    hit = api.get<{ username?: string }>('/user').then(
      (u) => u?.username,
      () => {
        selves.delete(api.identity)
        return undefined
      }
    )
    selves.set(api.identity, hit)
  }
  return hit
}

// ---- actions ----

/** Merge at the head Foreman saw, or (auto) once the pipeline succeeds. GitLab decides squash from the MR's own setting. */
export async function mergeMergeRequest(api: GitlabApi, projectPath: string, iid: number, options: { sha?: string; auto?: boolean }): Promise<void> {
  await api.send('PUT', `${project(projectPath)}/merge_requests/${iid}/merge`, {
    ...(options.sha ? { sha: options.sha } : {}),
    ...(options.auto ? { merge_when_pipeline_succeeds: true } : {})
  })
}

/** "Mark as ready": GitLab drafts are a title prefix. */
export async function markReady(api: GitlabApi, projectPath: string, iid: number, title: string): Promise<void> {
  const next = stripDraftTitle(title)
  if (next === title.trim()) return
  await api.send('PUT', `${project(projectPath)}/merge_requests/${iid}`, { title: next })
}

/** Retry a pipeline: GitLab reruns only its failed and canceled jobs. */
export async function retryPipeline(api: GitlabApi, projectPath: string, pipelineId: number): Promise<void> {
  await api.send('POST', `${project(projectPath)}/pipelines/${pipelineId}/retry`)
}

/** The last lines of a job's log. */
export async function jobTrace(api: GitlabApi, projectPath: string, jobId: number, maxLines = 1000): Promise<string> {
  const log = await api.text(`${project(projectPath)}/jobs/${jobId}/trace`)
  return log.split('\n').slice(-maxLines).join('\n')
}

export async function projectWebUrl(api: GitlabApi, projectPath: string): Promise<string> {
  const p = await api.get<{ web_url?: string }>(project(projectPath))
  return p?.web_url ?? `${api.host.url}/${projectPath}`
}

// ---- intake: a workspace from an MR or issue URL ----

/** Read a merge request or issue (and its human comments). Throws with the reason when it can't. */
export async function fetchGitlabLink(link: GithubLink, api: GitlabApi): Promise<GithubLinkInfo> {
  const kind = link.kind === 'pr' ? 'merge_requests' : 'issues'
  const base = `${project(link.repo)}/${kind}/${link.number}`
  let raw: RawMergeRequest & { description?: string | null }
  let notes: RawNote[]
  try {
    ;[raw, notes] = await Promise.all([api.get<RawMergeRequest>(base), api.all<RawNote>(`${base}/notes?sort=asc&order_by=created_at`, 5)])
  } catch (err) {
    throw new Error(`Couldn’t read ${link.url}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const comments = notes.filter((n) => !n.system).map((n) => ({ author: n.author?.username ?? 'unknown', body: n.body ?? '', at: n.created_at }))
  const info: GithubLinkInfo = { ...link, title: String(raw.title ?? ''), body: String(raw.description ?? ''), comments }
  if (link.kind === 'pr') {
    info.headRef = raw.source_branch
    info.isFork = raw.source_project_id !== undefined && raw.source_project_id !== raw.target_project_id
    info.baseRef = raw.target_branch
  }
  return info
}

// ---- glab ----

type Run = (args: string[]) => Promise<{ stdout: string; stderr: string }>

const runGlab: Run = (args) =>
  new Promise((resolve, reject) =>
    execFile('glab', args, { timeout: 10_000, windowsHide: true, env: { ...process.env, NO_COLOR: '1', GLAB_NO_PROMPT: '1' } }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve({ stdout, stderr })
    )
  )

/** G2: whether glab is installed and signed in to a host (`glab auth status` exits non-zero otherwise). */
export async function glabSignedIn(hostname: string, run: Run = runGlab): Promise<boolean> {
  return run(['auth', 'status', '--hostname', hostname]).then(
    () => true,
    () => false
  )
}

/**
 * G2: what glab says per host, remembered for ten minutes so the agent's system prompt (built synchronously) can
 * mention glab without waiting. Unknown until the first look finishes: the prompt then leaves glab out.
 */
export class GlabLogins {
  private known = new Map<string, { ok: boolean; at: number }>()
  private looking = new Map<string, Promise<boolean>>()

  constructor(
    private check: (hostname: string) => Promise<boolean> = (h) => glabSignedIn(h),
    private now: () => number = Date.now,
    private ttlMs = 10 * 60_000
  ) {}

  /** The last answer for a host (undefined before the first), starting a fresh look when it is missing or old. */
  signedIn(hostname: string): boolean | undefined {
    const hit = this.known.get(hostname)
    if (!hit || this.now() - hit.at > this.ttlMs) void this.refresh(hostname)
    return hit?.ok
  }

  refresh(hostname: string): Promise<boolean> {
    let look = this.looking.get(hostname)
    if (!look) {
      look = this.check(hostname)
        .catch(() => false)
        .then((ok) => {
          this.known.set(hostname, { ok, at: this.now() })
          this.looking.delete(hostname)
          return ok
        })
      this.looking.set(hostname, look)
    }
    return look
  }
}

/** G2: what the agent's system prompt says about a GitLab repository: its host, and glab when it is signed in there. */
export function gitlabAgentContext(host: GitlabHost, glab: boolean | undefined): string[] {
  const lines = [`This repository is hosted on GitLab (${host.url}), where pull requests are merge requests (!N). \`gh\` doesn't work with it.`]
  if (glab) lines.push('The GitLab CLI `glab` is installed and signed in to this host, so you can use it for merge requests, pipelines and issues (for example `glab mr view`, `glab ci status`).')
  return lines
}

export async function glabInstalled(run: Run = runGlab): Promise<boolean> {
  return run(['--version']).then(
    () => true,
    () => false
  )
}

/** The token glab is signed in with for a host, read only when the user asks ("Use glab's login"). */
export async function readGlabToken(hostname: string, run: Run = runGlab): Promise<string> {
  const fromConfig = await run(['config', 'get', 'token', '--host', hostname]).then(
    (out) => out.stdout.trim(),
    () => ''
  )
  if (fromConfig) return fromConfig
  // A keyring login isn't in glab's config; auth status can show it (on stderr in most versions).
  const status = await run(['auth', 'status', '--hostname', hostname, '--show-token']).catch((err: Error) => ({ stdout: '', stderr: err.message }))
  const token = /Token:\s*([\w.-]{8,})/.exec(`${status.stdout}\n${status.stderr}`)?.[1]
  if (!token) throw new Error(`glab isn’t signed in to ${hostname}. Run glab auth login --hostname ${hostname} in a terminal first.`)
  return token
}
