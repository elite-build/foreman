// What the CI watch does with each look at the pull request. Pure, so the
// dedup rules can be tested without a clock, gh or a notification.
import type { CiWatch, PullRequestInfo, ReviewWatch } from './types'

/** repo-qualified identity of a PR: a replacement PR has a different number. */
export const prIdentity = (repo: string, number: number): string => `${repo}#${number}`

export type CiObservation =
  | { kind: 'ok'; identity: string; state: PullRequestInfo['state']; sha: string; failing: string[] }
  | { kind: 'no-pr' }
  // Auth failures and other errors say nothing about CI, so state is kept as is.
  | { kind: 'error' }

export interface CiStep {
  next: CiWatch
  // A new failure on this head that has not been announced.
  notify?: { sha: string; checks: string[] }
}

export function stepCi(prev: CiWatch, obs: CiObservation): CiStep {
  if (obs.kind === 'error') return { next: prev }
  if (obs.kind === 'no-pr') return { next: {} }
  // A different PR (the branch was reused for a new one) starts over.
  const base: CiWatch = prev.pr === obs.identity ? prev : { pr: obs.identity }
  // A closed or merged PR has nothing left to watch.
  if (obs.state !== 'OPEN') return { next: { pr: obs.identity, notified: base.notified, acked: base.acked } }
  if (!obs.failing.length || !obs.sha) return { next: { pr: obs.identity, notified: base.notified, acked: base.acked } }
  const failure = { sha: obs.sha, checks: obs.failing }
  const announce = base.notified !== obs.sha
  return {
    next: { pr: obs.identity, notified: obs.sha, acked: base.acked, failure },
    notify: announce ? failure : undefined
  }
}

/** The failure the Home row should show: one that is current and has not been dealt with. */
export function openCiFailure(watch: CiWatch | undefined): NonNullable<CiWatch['failure']> | null {
  const failure = watch?.failure
  return failure && watch.acked !== failure.sha ? failure : null
}

/** A review summary as the watch sees it. */
export interface ReviewSummary {
  id: string
  state: string
  body: string
}

export type ReviewObservation =
  | { kind: 'ok'; identity: string; state: PullRequestInfo['state']; comments: string[]; reviews: ReviewSummary[] }
  | { kind: 'no-pr' }
  | { kind: 'error' }

export interface ReviewStep {
  next: ReviewWatch
  // How many new inline comments and review summaries to announce.
  notify?: { comments: number; reviews: number }
}

export const emptyReviewWatch = (): ReviewWatch => ({ seenComments: [], seenReviews: {}, unseen: { comments: [], reviews: [] } })

// A verdict is news even without text; a plain "commented" review is only the wrapper of its inline comments.
const VERDICTS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'])

export function stepReviews(prev: ReviewWatch, obs: ReviewObservation): ReviewStep {
  if (obs.kind === 'error') return { next: prev }
  if (obs.kind === 'no-pr') return { next: emptyReviewWatch() }
  const known = (): Pick<ReviewWatch, 'seenComments' | 'seenReviews'> => ({
    seenComments: obs.comments,
    seenReviews: Object.fromEntries(obs.reviews.map((r) => [r.id, r.state]))
  })
  // Nothing left to review on a closed or merged PR. A PR first seen closed is not baselined (its lists weren't read).
  if (obs.state !== 'OPEN') return { next: prev.pr === obs.identity ? { ...prev, unseen: { comments: [], reviews: [] } } : emptyReviewWatch() }
  // First look at this PR (opt-in, or the branch got a new PR): what is there is the baseline, never a flood.
  if (prev.pr !== obs.identity) return { next: { pr: obs.identity, ...known(), unseen: { comments: [], reviews: [] } } }
  const seenComments = new Set(prev.seenComments)
  const newComments = obs.comments.filter((id) => !seenComments.has(id))
  const newReviews = obs.reviews
    .filter((r) => {
      const was = prev.seenReviews[r.id]
      return was === undefined ? Boolean(r.body.trim()) || VERDICTS.has(r.state) : was !== r.state
    })
    .map((r) => r.id)
  // Unseen ids that no longer exist (deleted comments) fall away.
  const currentReviews = new Set(obs.reviews.map((r) => r.id))
  const currentComments = new Set(obs.comments)
  const unseen = {
    comments: [...new Set([...prev.unseen.comments.filter((id) => currentComments.has(id)), ...newComments])],
    reviews: [...new Set([...prev.unseen.reviews.filter((id) => currentReviews.has(id)), ...newReviews])]
  }
  return {
    next: { pr: obs.identity, ...known(), unseen },
    notify: newComments.length + newReviews.length ? { comments: newComments.length, reviews: newReviews.length } : undefined
  }
}

/** How many unseen review items the Home row counts. */
export function unseenReviewCount(watch: ReviewWatch | undefined): number {
  return watch ? watch.unseen.comments.length + watch.unseen.reviews.length : 0
}
