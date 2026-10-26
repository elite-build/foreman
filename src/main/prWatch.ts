// Opt-in watches on a workspace's pull request: CI failures (A-1) and new review comments (A-2). Only
// workspaces that opted in are looked at, and always through the shared PR
// cache, so the Git panel and the watcher never ask gh twice. Nothing here
// starts an agent: it records state and sends a notification. #5 auto-fix, a
// separate consent, is told what each look saw (ciObserved) and decides itself.
import type { CiWatch, NotifyKind, PrWatch, PullRequestInfo, ReviewWatch, Workspace } from '../shared/types'
import type { TFunction } from '../shared/i18n'
import { emptyReviewWatch, prIdentity, stepCi, stepReviews, type CiObservation, type ReviewObservation, type ReviewSummary } from '../shared/prWatch'
import { classifyGhError, type PrResult } from './github'
import type { PrCache } from './prCache'
import { mainT } from './i18n'
import type { Store } from './store'

// O2: GitLab repos are told about in GitLab's words.
const isGitlab = (ws: Workspace, result?: PrResult) => (result?.kind === 'ok' && result.pr.provider === 'gitlab') || Boolean(ws.pullRequest?.gitlabHost)
const signInNotice = (gitlab: boolean, t: TFunction) => (gitlab ? t('prWatch.notify.signIn.gitlab') : t('prWatch.notify.signIn.github'))
const prRef = (pr: PullRequestInfo) => (pr.provider === 'gitlab' ? `MR !${pr.number}` : `PR #${pr.number}`)

export interface PrWatchDeps {
  store: Store
  prs: Pick<PrCache, 'get' | 'pause'>
  // The ids of everyone else's inline comments and review summaries on the PR.
  reviews: (ws: Workspace, pr: PullRequestInfo) => Promise<{ comments: string[]; reviews: ReviewSummary[] }>
  // The repository has a GitHub remote to ask about.
  hasRemote: (ws: Workspace) => boolean
  notify: (n: { workspaceId: string; title: string; body: string; action?: 'fix-ci'; kind?: NotifyKind }) => void
  changed: () => void
  // #5: every good look at a CI-watched PR, after the watch's own state is updated (GitHub and GitLab alike).
  ciObserved?: (ws: Workspace, obs: { pr: string; open: boolean; sha: string; failing: string[] }) => void
}

export class PrWatcher {
  private timer: NodeJS.Timeout | null = null
  private polling = false
  // Reading reviews hit an auth failure during the current look.
  private reviewAuthFailed = false

  constructor(private deps: PrWatchDeps) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.poll(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private workspace(id: string): Workspace | undefined {
    return this.deps.store.state.workspaces.find((w) => w.id === id)
  }

  /** Notification text in the user's language, looked up when it's made. */
  private t(): TFunction {
    return mainT(this.deps.store.state.settings)
  }

  private save(): void {
    this.deps.store.save()
    this.deps.changed()
  }

  setWatch(workspaceId: string, kind: 'ci' | 'reviews', on: boolean): void {
    const ws = this.workspace(workspaceId)
    if (!ws) throw new Error('Workspace not found')
    const watch: PrWatch = ws.prWatch ?? {}
    if (on) {
      if (kind === 'ci') watch.ci ??= {}
      else watch.reviews ??= emptyReviewWatch()
      delete watch.authNotified
    } else {
      delete watch[kind]
      // #5: auto-fix works from the CI watch; without it there is nothing to act on.
      if (kind === 'ci') delete ws.autoFix
    }
    if (watch.ci || watch.reviews) ws.prWatch = watch
    else delete ws.prWatch
    this.save()
    // Opting in to reviews takes the baseline right away.
    if (on) void this.poll(workspaceId)
  }

  /** The user opened the review threads or sent them: what was new has been seen. */
  ackReviews(workspaceId: string): void {
    const reviews = this.workspace(workspaceId)?.prWatch?.reviews
    if (!reviews || (!reviews.unseen.comments.length && !reviews.unseen.reviews.length)) return
    reviews.unseen = { comments: [], reviews: [] }
    this.save()
  }

  /** The user dealt with the current CI failure (Fix CI, or just looked and dismissed it). */
  ackCi(workspaceId: string): void {
    const ci = this.workspace(workspaceId)?.prWatch?.ci
    if (!ci?.failure || ci.acked === ci.failure.sha) return
    ci.acked = ci.failure.sha
    this.save()
  }

  /** Look at every opted-in workspace (or just one), once. Calls overlap safely. */
  async poll(onlyId?: string): Promise<void> {
    if (this.polling && !onlyId) return
    if (!onlyId) this.polling = true
    try {
      for (const ws of [...this.deps.store.state.workspaces]) {
        if (onlyId && ws.id !== onlyId) continue
        if (!ws.prWatch || !ws.path) continue
        // Saved before the next workspace is looked at, so a notification and its dedup state never part.
        if (await this.pollOne(ws)) this.save()
      }
    } finally {
      if (!onlyId) this.polling = false
    }
  }

  /** Returns whether anything persisted changed. */
  private async pollOne(ws: Workspace): Promise<boolean> {
    const watch = ws.prWatch
    if (!watch) return false
    // Archived workspaces stop being watched: their reasons go with them.
    if (ws.state === 'archived') {
      delete ws.prWatch
      delete ws.autoFix
      return true
    }
    if (ws.state !== 'ready' || !this.deps.hasRemote(ws) || ws.branch === ws.baseBranch) return false
    const result = await this.deps.prs.get(ws)
    // A look can outlast an opt-out or an archive.
    if (ws.prWatch !== watch) return false
    let dirty = false
    if (result.kind === 'auth-error') {
      if (!watch.authNotified) {
        watch.authNotified = true
        dirty = true
        this.deps.notify({
          workspaceId: ws.id,
          title: ws.name,
          body: signInNotice(isGitlab(ws, result) || /gitlab/i.test(result.message), this.t()),
          kind: 'attention'
        })
      }
    }
    if (watch.ci) dirty = this.stepCi(ws, watch.ci, result) || dirty
    this.reviewAuthFailed = false
    if (watch.reviews) dirty = (await this.stepReviews(ws, watch, watch.reviews, result)) || dirty
    // Signing in again re-arms the notice: a good lookup, and no auth failure reading reviews either.
    if (result.kind === 'ok' && watch.authNotified && !this.reviewAuthFailed) {
      delete watch.authNotified
      dirty = true
    }
    return dirty
  }

  private stepCi(ws: Workspace, ci: CiWatch, result: PrResult): boolean {
    const before = JSON.stringify(ci)
    const obs: CiObservation =
      result.kind === 'ok'
        ? {
            kind: 'ok',
            identity: prIdentity(result.repo, result.pr.number),
            state: result.pr.state,
            sha: result.headRefOid,
            failing: result.pr.checks.filter((c) => c.state === 'failure').map((c) => c.name)
          }
        : result.kind === 'no-pr'
          ? { kind: 'no-pr' }
          : { kind: 'error' }
    const step = stepCi(ci, obs)
    const { notify } = step
    const next = { ...step.next }
    for (const key of Object.keys(ci)) delete ci[key as keyof CiWatch]
    Object.assign(ci, next)
    if (notify && result.kind === 'ok') {
      const names = notify.checks.length > 2 ? `${notify.checks.slice(0, 2).join(', ')} +${notify.checks.length - 2}` : notify.checks.join(', ')
      const t = this.t()
      this.deps.notify({
        workspaceId: ws.id,
        title: ws.name,
        body: t(result.pr.provider === 'gitlab' ? 'prWatch.notify.pipelineFailed' : 'prWatch.notify.ciFailed', { pr: prRef(result.pr), checks: names }),
        action: 'fix-ci',
        kind: 'attention'
      })
    }
    const dirty = JSON.stringify(ci) !== before
    // Saved first, so auto-fix acts on the state the watch keeps.
    if (result.kind === 'ok' && obs.kind === 'ok') {
      if (dirty) this.save()
      this.deps.ciObserved?.(ws, { pr: obs.identity, open: obs.state === 'OPEN', sha: obs.sha, failing: obs.failing })
    }
    return dirty
  }

  private async stepReviews(ws: Workspace, watch: PrWatch, reviews: ReviewWatch, result: PrResult): Promise<boolean> {
    const before = JSON.stringify(reviews)
    let obs: ReviewObservation = { kind: 'error' }
    if (result.kind === 'no-pr') obs = { kind: 'no-pr' }
    else if (result.kind === 'ok') {
      const identity = prIdentity(result.repo, result.pr.number)
      // Nothing to read on a PR that is no longer open.
      if (result.pr.state !== 'OPEN') obs = { kind: 'ok', identity, state: result.pr.state, comments: [], reviews: [] }
      else {
        try {
          const found = await this.deps.reviews(ws, result.pr)
          obs = { kind: 'ok', identity, state: result.pr.state, ...found }
        } catch (err) {
          this.reviewsFailed(ws, watch, err)
        }
      }
    }
    if (ws.prWatch !== watch || watch.reviews !== reviews) return false
    const step = stepReviews(reviews, obs)
    const next = { ...step.next }
    for (const key of Object.keys(reviews)) delete reviews[key as keyof ReviewWatch]
    Object.assign(reviews, next)
    if (step.notify) {
      const { comments, reviews: summaries } = step.notify
      const t = this.t()
      const pr = prRef((result as Extract<PrResult, { kind: 'ok' }>).pr)
      const body =
        comments && summaries
          ? t('prWatch.notify.commentsAndReviews', { comments: t('prWatch.notify.commentCount', { count: comments }), reviews: t('prWatch.notify.reviewCount', { count: summaries }), pr })
          : comments
            ? t('prWatch.notify.comments', { count: comments, pr })
            : t('prWatch.notify.reviews', { count: summaries, pr })
      this.deps.notify({ workspaceId: ws.id, title: ws.name, body, kind: 'attention' })
    }
    return JSON.stringify(reviews) !== before
  }

  /** A failed read: pause everyone on rate limits, say so once on auth problems. */
  private reviewsFailed(ws: Workspace, watch: PrWatch, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    const kind = classifyGhError(message)
    if (kind === 'rate-limit' || kind === 'auth-error') this.deps.prs.pause(kind, message, ws)
    if (kind === 'auth-error') this.reviewAuthFailed = true
    if (kind === 'auth-error' && !watch.authNotified) {
      watch.authNotified = true
      this.deps.notify({ workspaceId: ws.id, title: ws.name, body: signInNotice(isGitlab(ws) || /gitlab/i.test(message), this.t()), kind: 'attention' })
    }
  }
}
