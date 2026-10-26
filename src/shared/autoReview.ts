// #17 Auto review: the rules, pure, so they can be tested without a clock, git or
// an agent. Off by default: a repository opts in through a consent dialog that
// names the reviewer (Claude Code or Codex, held to read-only), the exclusions,
// the daily budget and the time limit. After a worker's turn completes and the
// workspace has been idle, with checks passed (or none configured), a read-only
// reviewer reads the captured diff once per tree. Its findings are an opinion,
// marked stale when the files move on, and only ever reach a worker by a click.
import { AGENTS, modelInfo, type AgentKind, type Loadout } from './agents'
import { readOnlyEnforcement } from './permissions'
import { createT, type TFunction } from './i18n'
import { sensitiveMatches } from './sensitive'
import type { AutoReview, AutoReviewConsent, AutoReviewFinding, AutoReviewSeverity, AutoReviewShown, CheckRow, Workspace } from './types'

const enT = createT('en')

/** The mock's defaults: 6 reviews per repository per day, 10 minutes each, after 2 idle minutes. */
export const AUTO_REVIEW_DEFAULTS = {
  perDay: 6,
  maxMinutes: 10,
  idleMinutes: 2,
  exclusions: ['*.md', 'docs/**', 'package-lock.json']
} as const

// Reviews kept per workspace; older ones are history nobody opens.
const KEEP_REVIEWS = 12
// More than this many findings in one answer is noise, not a review.
const MAX_FINDINGS = 50

/** Claude Code and Codex only: the agents Foreman can hold to read-only. */
export function canReview(agent: AgentKind): boolean {
  return (agent === 'claude' || agent === 'codex') && readOnlyEnforcement(agent) !== null
}

/** The reviewer the dialog starts with: Settings → Models → Review model when it can review, else Claude's default. */
export function defaultReviewer(reviewModel: Loadout | undefined, fallback: Loadout): Loadout {
  return reviewModel && canReview(reviewModel.agent) ? reviewModel : fallback
}

/** "*.md, docs/**" → globs, empty entries dropped. */
export function parseExclusions(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((g) => g.trim()).filter(Boolean))]
}

const custom = (text: string): string => {
  const trimmed = text.trim()
  return trimmed ? `\n\nThe user's review preferences for this repository (they take precedence):\n${trimmed}` : ''
}

/** The reviewer's first message, before the captured diff. The findings block is what Foreman reads back. */
export function autoReviewPrompt(customPrompt: string): string {
  return (
    'Review the changes in this workspace compared with its base branch, using the diff Foreman captured below. ' +
    'You can read files but not change them. Nobody can approve tools in an auto review: don’t run shell commands (asking stops the review); use Read, Grep and Glob. ' +
    'Only flag discrete, actionable problems these changes introduce: bugs, regressions, security issues, broken edge cases. Skip style and nitpicks. ' +
    'List concrete findings with file and line; say “no findings” if there are none.\n\n' +
    'End your answer with one fenced block tagged `foreman-findings` holding a JSON array, one object per finding: ' +
    '{"severity": "high" | "medium" | "low", "file": "path/from/repo/root", "line": 12, "title": "one line", "body": "what is wrong and why"}. ' +
    'Use [] when there are no findings.' +
    custom(customPrompt)
  )
}

/** Whether two consents cover the same thing (the reviewer, exclusions, budget, limits, read-only and the prompt). */
export function sameShown(a: AutoReviewShown, b: AutoReviewShown): boolean {
  return (
    a.reviewer.agent === b.reviewer.agent &&
    a.reviewer.model === b.reviewer.model &&
    (a.reviewer.effort ?? null) === (b.reviewer.effort ?? null) &&
    Boolean(a.reviewer.fast) === Boolean(b.reviewer.fast) &&
    a.exclusions.join('\n') === b.exclusions.join('\n') &&
    a.perDay === b.perDay &&
    a.maxMinutes === b.maxMinutes &&
    a.idleMinutes === b.idleMinutes &&
    a.readOnly === b.readOnly &&
    a.prompt === b.prompt
  )
}

/** What is wrong with a consent request, or null. */
export function shownProblem(shown: AutoReviewShown, t: TFunction = enT): string | null {
  if (!canReview(shown.reviewer.agent)) return t('autoReview.problem.agent', { agent: AGENTS[shown.reviewer.agent]?.label ?? shown.reviewer.agent })
  if (readOnlyEnforcement(shown.reviewer.agent) !== shown.readOnly) return t('autoReview.problem.readOnly')
  if (!shown.reviewer.model.trim()) return t('autoReview.problem.model')
  return null
}

const sameLocalDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** Reviews started today (local time) across the repository's workspaces: counted when a review starts, whatever came of it. */
export function usedToday(workspaces: Workspace[], repoId: string, now: number): number {
  const today = new Date(now)
  return workspaces
    .filter((w) => w.repoId === repoId)
    .reduce((n, w) => n + (w.autoReviews ?? []).filter((r) => sameLocalDay(new Date(r.startedAt), today)).length, 0)
}

/** True when every changed file matches an exclusion (an empty change is not "only excluded"). */
export function onlyExcluded(changed: string[], exclusions: string[]): boolean {
  return changed.length > 0 && sensitiveMatches(changed, exclusions).length === changed.length
}

/** What the checks say about exactly this tree. */
export type ChecksFact = 'passed' | 'none' | 'failed' | 'pending' | 'not-run'

/**
 * The configured checks against the tree about to be reviewed: 'none' when the repo has none, 'pending' while a run
 * (or checks after the turn) is still to come, 'passed' only when every check ran to a pass on this very tree.
 */
export function checksFact(rows: CheckRow[], tree: string, pending: boolean): ChecksFact {
  if (!rows.length) return 'none'
  if (pending) return 'pending'
  const onTree = (r: CheckRow) => Boolean(r.result && !r.stale && r.result.fingerprint.tree === tree)
  if (rows.some((r) => onTree(r) && ['failed', 'timeout', 'error'].includes(r.result!.status))) return 'failed'
  if (rows.every((r) => onTree(r) && r.result!.status === 'passed')) return 'passed'
  return 'not-run'
}

/** What Foreman knows right now, before looking at the tree. */
export interface ReviewGates {
  consent?: AutoReviewConsent
  // What consent covered is still what would run (prompt, read-only for the agent).
  consentValid: boolean
  // #1: "Quit when turns finish" is holding new turns back.
  draining: boolean
  // How long the workspace has been quiet (no send, turn or queue change), and how long it must be.
  idleMs: number
  // A tab running, starting or queued; setup or checks running; not ready.
  busy: boolean
  // An auto review is already running (one at a time across the app).
  running: boolean
  usedToday: number
  tabsFull: boolean
}

/** What the tree says, once it was read. */
export interface TreeFacts {
  tree: string
  // This workspace already has a review of this tree.
  reviewed: boolean
  // Files changed since the last reviewed tree (or since the base, for the first review).
  changed: string[]
  checks: ChecksFact
}

export type SkipReason = 'off' | 'paused' | 'budget' | 'tabs-full' | 'reviewed' | 'no-changes' | 'excluded' | 'checks-failed' | 'checks-not-run'
export type WaitReason = 'idle' | 'busy' | 'draining' | 'running' | 'checks-pending'

export type ReviewDecision =
  // Not now: the pending review stays and is looked at again.
  | { kind: 'wait'; why: WaitReason }
  // Not for this turn: the pending review is dropped (the next completed worker turn makes another).
  | { kind: 'skip'; why: SkipReason }
  | { kind: 'look' }
  | { kind: 'start' }

/** The gates that need no git: consent, the quit freeze, the idle debounce, the slot, the budget and the tab limit. */
export function decideNow(g: ReviewGates): ReviewDecision {
  if (!g.consent) return { kind: 'skip', why: 'off' }
  if (g.consent.paused || !g.consentValid) return { kind: 'skip', why: 'paused' }
  if (g.usedToday >= g.consent.perDay) return { kind: 'skip', why: 'budget' }
  if (g.draining) return { kind: 'wait', why: 'draining' }
  if (g.idleMs < g.consent.idleMinutes * 60_000) return { kind: 'wait', why: 'idle' }
  if (g.busy) return { kind: 'wait', why: 'busy' }
  if (g.running) return { kind: 'wait', why: 'running' }
  if (g.tabsFull) return { kind: 'skip', why: 'tabs-full' }
  return { kind: 'look' }
}

/** The gates on the tree itself: one review per tree, something worth reading, and checks passed (or none). */
export function decideTree(consent: AutoReviewConsent, facts: TreeFacts): ReviewDecision {
  if (facts.reviewed) return { kind: 'skip', why: 'reviewed' }
  if (!facts.changed.length) return { kind: 'skip', why: 'no-changes' }
  if (onlyExcluded(facts.changed, consent.exclusions)) return { kind: 'skip', why: 'excluded' }
  if (facts.checks === 'pending') return { kind: 'wait', why: 'checks-pending' }
  if (facts.checks === 'failed') return { kind: 'skip', why: 'checks-failed' }
  if (facts.checks === 'not-run') return { kind: 'skip', why: 'checks-not-run' }
  return { kind: 'start' }
}

/** The newest review of a workspace, if any. */
export function latestReview(ws: Workspace | undefined): AutoReview | undefined {
  return ws?.autoReviews?.at(-1)
}

/** The review a reviewer tab belongs to. */
export function reviewOf(ws: Workspace | undefined, reviewId: string | undefined): AutoReview | undefined {
  return reviewId ? ws?.autoReviews?.find((r) => r.id === reviewId) : undefined
}

/** `reviews` with this one added, the oldest finished ones dropped past the cap. */
export function withReview(reviews: AutoReview[] | undefined, review: AutoReview): AutoReview[] {
  const all = [...(reviews ?? []), review]
  return all.length > KEEP_REVIEWS ? all.slice(all.length - KEEP_REVIEWS) : all
}

// ---- findings ----

const BLOCK = /```foreman-findings[^\n]*\n([\s\S]*?)```/g

function severityOf(value: unknown): AutoReviewSeverity | undefined {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (v === 'high' || v === 'critical') return 'high'
  if (v === 'medium' || v === 'med') return 'medium'
  if (v === 'low') return 'low'
  return undefined
}

/** The last findings block in an answer and where it sits, or null when there is none or it isn't a JSON array. */
function findBlock(text: string): { start: number; end: number; items: unknown[] } | null {
  let found: { start: number; end: number; items: unknown[] } | null = null
  for (const m of text.matchAll(BLOCK)) {
    try {
      const parsed: unknown = JSON.parse(m[1])
      if (Array.isArray(parsed)) found = { start: m.index!, end: m.index! + m[0].length, items: parsed }
    } catch {
      // Not the block Foreman asked for.
    }
  }
  return found
}

/**
 * The findings the reviewer listed in its `foreman-findings` block. Null when there is no readable block: Foreman
 * doesn't guess findings from prose. An empty array is the reviewer saying "no findings".
 */
export function parseFindings(text: string): Omit<AutoReviewFinding, 'id'>[] | null {
  const block = findBlock(text)
  if (!block) return null
  const out: Omit<AutoReviewFinding, 'id'>[] = []
  for (const raw of block.items.slice(0, MAX_FINDINGS)) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const body = typeof item.body === 'string' ? item.body.trim() : ''
    const title = (typeof item.title === 'string' ? item.title.trim() : '') || body.split('\n')[0].slice(0, 120)
    if (!title) continue
    const file = typeof item.file === 'string' && item.file.trim() ? item.file.trim().replace(/^\.?\//, '') : undefined
    const line = typeof item.line === 'number' && Number.isInteger(item.line) && item.line > 0 ? item.line : undefined
    const severity = severityOf(item.severity)
    out.push({ ...(severity ? { severity } : {}), ...(file ? { file } : {}), ...(file && line ? { line } : {}), title, body: body === title ? '' : body })
  }
  return out
}

/** The answer without its findings block (the tab shows the findings as cards instead). Unchanged when there is no readable block. */
export function withoutFindingsBlock(text: string): string {
  const block = findBlock(text)
  if (!block) return text
  return (text.slice(0, block.start) + text.slice(block.end)).replace(/\n{3,}/g, '\n\n').trim()
}

/** "src/a.ts:18", "src/a.ts", or "" for a finding about the change as a whole. */
export function findingPlace(f: Pick<AutoReviewFinding, 'file' | 'line'>): string {
  return f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : ''
}

const SEVERITY_WORD: Record<AutoReviewSeverity, string> = { high: 'High', medium: 'Medium', low: 'Low' }

/**
 * The message "Send to worker…" sends, shown in full before it goes. It says where the findings came from and that
 * they are an opinion; a stale review says the files changed since.
 */
export function findingsMessage(review: AutoReview, findings: AutoReviewFinding[]): string {
  const reviewer = modelInfo(review.reviewer.agent, review.reviewer.model).label
  const head =
    `An auto review (${reviewer}, read-only) of this workspace's diff at tree ${review.tree.slice(0, 7)} found ${findings.length === 1 ? 'this' : 'these'}. ` +
    'It is an opinion, not verification: check each one before changing anything.' +
    (review.stale ? ' The files have changed since that review, so some of this may no longer apply.' : '')
  const lines = findings.map((f, n) => {
    const tag = [f.severity ? `[${SEVERITY_WORD[f.severity]}]` : '', findingPlace(f)].filter(Boolean).join(' ')
    const body = f.body ? `\n   ${f.body.replace(/\n/g, '\n   ')}` : ''
    return `${n + 1}. ${tag ? `${tag}: ` : ''}${f.title}${body}`
  })
  return `${head}\n\n${lines.join('\n')}`
}
