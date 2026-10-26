// Parameters and results of the git, diff and pull-request methods, and the text the diffs, statuses and lists are printed as. Each result has a `text` the command prints
// unless --json is given.
import type { BranchCommits, DiffComment, DiffFile, DiffScope, GitActionKind, GitStatus, ReviewThread, SendDisposition, WorkspaceDiff } from '../types'
import type { PrFacts } from '../board'

export interface GitWorkspaceRef {
  id: string
  name: string
}

/** Which workspace a command means (a name, id, branch or "."), and where it ran. */
export interface GitRef {
  workspace: string
  cwd?: string
}

export interface GitStatusParams extends GitRef {
  fresh?: boolean
}

export interface GitStatusResult {
  workspace: GitWorkspaceRef
  status: GitStatus
  text: string
}

/** The actions `git-action` serves: the ones that need no confirmation. merge and automerge are `git-merge`. */
export const GIT_ACTIONS = ['commit-and-push', 'push', 'pull', 'review', 'fix-errors', 'resolve-conflicts', 'create-pr', 'create-draft-pr', 'create-pr-web', 'ready-for-review', 'open-pr'] as const satisfies readonly GitActionKind[]
export type GitCliAction = (typeof GIT_ACTIONS)[number]

/** The actions that put a message in a chat (a turn starts or queues), so an agent needs the repository's opt-in. */
export const SENDING_ACTIONS: readonly GitActionKind[] = ['commit-and-push', 'review', 'fix-errors', 'resolve-conflicts', 'create-pr', 'create-draft-pr']

export const ACTION_WORDS: Record<GitActionKind, string> = {
  'commit-and-push': 'commit and push',
  'create-pr': 'create a pull request',
  'create-draft-pr': 'create a draft pull request',
  'create-pr-web': 'create a pull request on the web',
  push: 'push',
  pull: 'pull',
  merge: 'merge',
  'fix-errors': 'fix errors',
  'rerun-checks': 'rerun checks',
  'resolve-conflicts': 'resolve conflicts',
  'ready-for-review': 'mark ready for review',
  review: 'review',
  'open-pr': 'open the pull request',
  automerge: 'merge when checks pass',
  archive: 'archive'
}

export interface GitActionParams extends GitRef {
  action: GitActionKind
  tab?: number
}

export interface GitActionResult {
  workspace: GitWorkspaceRef
  action: GitActionKind
  // When it put a message in a chat: where, and which turn carries it.
  tab?: number
  session?: string
  turn?: string
  disposition?: SendDisposition
  text: string
}

export interface GitMergeParams extends GitRef {
  auto?: boolean
  confirmed?: boolean
}

export interface GitMergeResult {
  workspace: GitWorkspaceRef
  auto: boolean
  needsConfirmation?: boolean
  merged?: boolean
  previewText?: string
  text: string
}

export interface GitRevertParams extends GitRef {
  files: string[]
  confirmed?: boolean
}

export interface GitRevertResult {
  workspace: GitWorkspaceRef
  files: string[]
  needsConfirmation?: boolean
  reverted?: boolean
  previewText?: string
  text: string
}

export interface DiffParams extends GitRef {
  // uncommitted | branch | staged | last-commit | last-3 | pr | commit:<sha> | picked:<sha>,<sha> | turn:<id>
  scope?: string
  stat?: boolean
  files?: boolean
}

export interface DiffFileRow {
  path: string
  oldPath?: string
  status: DiffFile['status']
  binary: boolean
  additions: number
  deletions: number
}

export interface DiffResult {
  workspace: GitWorkspaceRef
  scope: string
  baseRef?: string
  files: DiffFileRow[]
  additions: number
  deletions: number
  truncated: boolean
  // Why the source shows nothing (no pull request yet, nothing pushed, …).
  unavailable?: string
  // The unified diff, unless --stat or --files asked for less (a turn has counts only).
  patch?: string
  text: string
}

export interface CommitsResult {
  workspace: GitWorkspaceRef
  commits: BranchCommits
  text: string
}

export type CommentVerb = 'list' | 'add' | 'edit' | 'resolve' | 'delete'

export interface CommentsParams extends GitRef {
  verb?: CommentVerb
  file?: string
  line?: number
  body?: string
  id?: string
}

export interface CommentRow {
  id: string
  file: string
  line: number
  author: DiffComment['author']
  state: DiffComment['state']
  body: string
}

export interface CommentsResult {
  workspace: GitWorkspaceRef
  verb: CommentVerb
  comments: CommentRow[]
  // The comment an add, edit or resolve touched, or a delete removed.
  comment?: CommentRow
  text: string
}

export interface PrResult {
  workspace: GitWorkspaceRef
  pullRequest: { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; url?: string; facts?: PrFacts } | null
  url?: string
  text: string
}

export interface PrRefreshResult {
  workspace: GitWorkspaceRef
  outcome: 'ok' | 'no-pr' | 'paused' | 'unavailable'
  text: string
}

export interface PrWatchParams extends GitRef {
  kind: 'ci' | 'reviews'
  on: boolean
}

export interface PrWatchResult {
  workspace: GitWorkspaceRef
  kind: 'ci' | 'reviews'
  on: boolean
  text: string
}

/** fix-ci and base-moved: a tab, or a new one. */
export interface PrTabParams extends GitRef {
  tab?: number
  new?: boolean
}

export interface PrTabResult {
  workspace: GitWorkspaceRef
  tab: number
  session: string
  // The turn it started or queued, when Foreman can say which.
  turn?: string
  text: string
}

export interface ThreadRow {
  id: string
  path: string
  line: number | null
  resolved: boolean
  outdated: boolean
  comments: number
  author: string
  preview: string
}

export interface ThreadsParams extends GitRef {
  verb?: 'list' | 'send'
  ids?: string[]
  tab?: number
}

export interface ThreadsResult {
  workspace: GitWorkspaceRef
  verb: 'list' | 'send'
  threads: ThreadRow[]
  tab?: number
  session?: string
  text: string
}

export interface AutoFixParams extends GitRef {
  tab?: number
  verb?: 'status' | 'on' | 'off'
  // What the preview showed (a second call with it turns auto-fix on).
  shown?: import('../types').AutoFixShown
}

export interface AutoFixResult {
  workspace: GitWorkspaceRef
  verb: 'status' | 'on' | 'off'
  enabled: boolean
  needsConfirmation?: boolean
  preview?: import('../types').AutoFixPreview
  previewText?: string
  text: string
}

export interface AckResult {
  workspace: GitWorkspaceRef
  text: string
}

// ----- diff scopes -----

export interface ParsedScope {
  scope: DiffScope | 'turn'
  commits?: string[]
  turn?: string
}

const PLAIN_SCOPES: Record<string, DiffScope> = {
  branch: 'all',
  all: 'all',
  uncommitted: 'uncommitted',
  staged: 'staged',
  'last-commit': 'last-commit',
  'last-3': 'last-3',
  pr: 'pr'
}

/** What `--scope` says: a name, `commit:<sha>`, `picked:a,b` (or `picked a,b`) or `turn:<id>`; null when it isn't one. */
export function parseDiffScope(text: string | undefined): ParsedScope | null {
  const word = (text ?? 'branch').trim()
  const plain = PLAIN_SCOPES[word.toLowerCase()]
  if (plain) return { scope: plain }
  const turn = /^turn[: ]\s*(\S+)$/i.exec(word)
  if (turn) return { scope: 'turn', turn: turn[1] }
  const commit = /^commit[: ]\s*([0-9a-f]{4,64})$/i.exec(word)
  if (commit) return { scope: 'commit', commits: [commit[1]] }
  const picked = /^picked[: ]\s*([0-9a-f,\s]+)$/i.exec(word)
  if (picked) {
    const commits = picked[1].split(/[,\s]+/).filter(Boolean)
    if (commits.length && commits.every((c) => /^[0-9a-f]{4,64}$/i.test(c))) return { scope: 'picked', commits }
  }
  return null
}

export const SCOPE_HELP = 'uncommitted, branch, staged, last-commit, last-3, pr, commit:<sha>, picked:<sha>,<sha> or turn:<id>'

// ----- text -----

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** `+12 -3` */
export const countsText = (additions: number, deletions: number): string => `+${additions} -${deletions}`

export function diffRows(files: DiffFile[]): DiffFileRow[] {
  return files.map((f) => ({ path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, binary: f.binary, additions: f.additions, deletions: f.deletions }))
}

const STATUS_LETTER: Record<DiffFile['status'], string> = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R' }

/** One line per file: `M  src/a.ts  +12 -3`, then the total. */
export function diffStatText(rows: DiffFileRow[]): string {
  if (!rows.length) return 'No changes.'
  const width = Math.max(...rows.map((r) => (r.oldPath ? `${r.oldPath} → ${r.path}` : r.path).length))
  const lines = rows.map((r) => `${STATUS_LETTER[r.status]}  ${(r.oldPath ? `${r.oldPath} → ${r.path}` : r.path).padEnd(width)}  ${r.binary ? 'binary' : countsText(r.additions, r.deletions)}`)
  const additions = rows.reduce((n, r) => n + r.additions, 0)
  const deletions = rows.reduce((n, r) => n + r.deletions, 0)
  return [...lines, `${plural(rows.length, 'file')} changed, ${countsText(additions, deletions)}`].join('\n')
}

/** Just the names, one per line (for scripts: `foreman diff api --files | xargs …`). */
export const diffFilesText = (rows: DiffFileRow[]): string => (rows.length ? rows.map((r) => r.path).join('\n') : 'No changes.')

/** The diff as unified text, the way `git diff` prints it. */
export function diffPatchText(files: DiffFile[]): string {
  const out: string[] = []
  for (const f of files) {
    const from = f.oldPath ?? f.path
    out.push(`diff --git a/${from} b/${f.path}`)
    if (f.status === 'added') out.push('new file')
    else if (f.status === 'deleted') out.push('deleted file')
    else if (f.status === 'renamed') out.push(`rename from ${from}`, `rename to ${f.path}`)
    if (f.binary) {
      out.push(`Binary files a/${from} and b/${f.path} differ`)
      continue
    }
    out.push(f.status === 'added' ? '--- /dev/null' : `--- a/${from}`, f.status === 'deleted' ? '+++ /dev/null' : `+++ b/${f.path}`)
    for (const hunk of f.hunks) {
      out.push(hunk.header)
      for (const line of hunk.lines) out.push(`${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}${line.text}`)
    }
  }
  return out.join('\n')
}

/** The whole answer of `foreman diff` for a WorkspaceDiff. */
export function diffText(diff: Pick<WorkspaceDiff, 'files' | 'truncated' | 'unavailable'>, options: { stat?: boolean; files?: boolean } = {}): { text: string; patch?: string } {
  const rows = diffRows(diff.files)
  if (!rows.length) return { text: diff.unavailable ? `Nothing to show: ${UNAVAILABLE_TEXT[diff.unavailable] ?? diff.unavailable}.` : 'No changes.' }
  const note = diff.truncated ? '\n… the diff was cut at 4 MB; ask for one source or file at a time' : ''
  if (options.files) return { text: diffFilesText(rows) }
  if (options.stat) return { text: diffStatText(rows) + note }
  const patch = diffPatchText(diff.files)
  return { text: patch + note, patch }
}

const UNAVAILABLE_TEXT: Record<string, string> = {
  'no-commits': 'the branch has no commits yet',
  'no-pr': 'there is no pull request',
  'not-pushed': 'nothing is pushed yet',
  'no-picks': 'no commits were picked',
  'not-applicable': 'that source doesn’t apply here',
  failed: 'git couldn’t read it'
}

const sentenceOf = (n: number, noun: string) => plural(n, noun)

/** The Git panel's header as lines. */
export function gitStatusText(name: string, s: GitStatus): string {
  const rows: string[][] = []
  rows.push(['branch', `${s.branch}${s.onBase ? '  (the base branch: changes go straight to it)' : `  from ${s.baseRef}`}`])
  if (s.upstream) rows.push(['upstream', `${s.upstream}  ${s.ahead ? `${s.ahead} ahead` : 'not ahead'}, ${s.behind ? `${s.behind} behind` : 'not behind'}`])
  else rows.push(['upstream', s.hasRemote ? 'none yet (a push sets it)' : 'no remote'])
  if (!s.onBase) rows.push(['base', `${s.aheadBase ? `${s.aheadBase} ahead` : 'not ahead'}, ${s.behindBase ? `${s.behindBase} behind` : 'not behind'} of ${s.baseRef}`])
  rows.push(['uncommitted', s.uncommitted ? sentenceOf(s.uncommitted, 'file') : 'none'])
  if (s.conflicted) rows.push(['conflicts', 'yes: the working tree has unresolved conflicts'])
  if (s.pr) {
    const word = s.pr.provider === 'gitlab' ? `MR !${s.pr.number}` : `PR #${s.pr.number}`
    const parts = [word, s.pr.state.toLowerCase() + (s.pr.isDraft ? ' (draft)' : ''), s.pr.title]
    rows.push(['pull request', parts.join('  ')])
    rows.push(['', s.pr.url])
  } else if (s.prProblem) rows.push(['pull request', `couldn’t read it: ${s.prProblem.message}`])
  else if (!s.onBase) rows.push(['pull request', 'none'])
  if (s.scm?.kind === 'unknown-gitlab') rows.push(['host', `${s.scm.host} looks like GitLab but isn’t set up`])
  if (!s.ghAvailable && !s.scm) rows.push(['gh', 'not available: pull request actions need the GitHub CLI'])
  if (s.asOf) rows.push(['as of', `${s.asOf} (the sandbox is asleep)`])
  rows.push(['next', s.primary.label || 'nothing to do'])
  const width = Math.max(...rows.map((r) => r[0].length))
  return [name, ...rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`.trimEnd())].join('\n')
}

const when = (iso: string): string => iso.slice(0, 16).replace('T', ' ')

export function commitsText(c: BranchCommits): string {
  const lines: string[] = []
  const u = c.uncommitted
  if (u.files) lines.push(`uncommitted  ${plural(u.files, 'file')}${u.staged ? `, ${u.staged} staged` : ''}  ${countsText(u.additions, u.deletions)}`)
  if (!c.commits.length) lines.push(`No commits since ${c.baseRef}.`)
  const rows = c.commits.map((k) => [k.sha.slice(0, 7), k.subject, k.author + (k.you ? ' (you)' : ''), when(k.at), countsText(k.additions, k.deletions), k.pushed === null ? '' : k.pushed ? 'pushed' : 'local'])
  const widths = [0, 1, 2, 3, 4].map((i) => Math.max(0, ...rows.map((r) => r[i].length)))
  for (const r of rows) lines.push(r.map((cell, i) => (i < 5 ? cell.padEnd(widths[i] + 2) : cell)).join('').trimEnd())
  if (c.more) lines.push('… more commits than listed')
  return lines.join('\n')
}

export function commentRow(c: DiffComment): CommentRow {
  return { id: c.id, file: c.file, line: c.line, author: c.author, state: c.state, body: c.body }
}

const oneLine = (text: string, max = 100): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function commentsText(rows: CommentRow[]): string {
  if (!rows.length) return 'No comments.'
  const cells = rows.map((r) => [r.id.slice(0, 8), `${r.file}:${r.line}`, r.author, r.state, oneLine(r.body)])
  const widths = [0, 1, 2, 3].map((i) => Math.max(0, ...cells.map((c) => c[i].length)))
  return cells.map((c) => c.map((cell, i) => (i < 4 ? cell.padEnd(widths[i] + 2) : cell)).join('').trimEnd()).join('\n')
}

export function threadRow(t: ReviewThread): ThreadRow {
  const first = t.comments[0]
  return { id: t.id, path: t.path, line: t.line, resolved: t.isResolved, outdated: t.isOutdated, comments: t.comments.length, author: first?.author ?? '', preview: oneLine(first?.body ?? '') }
}

export function threadsText(rows: ThreadRow[]): string {
  if (!rows.length) return 'No review threads.'
  const cells = rows.map((r) => [r.id, `${r.path}${r.line ? `:${r.line}` : ''}`, r.resolved ? 'resolved' : r.outdated ? 'outdated' : 'open', r.author, oneLine(r.preview, 80)])
  const widths = [0, 1, 2, 3].map((i) => Math.max(0, ...cells.map((c) => c[i].length)))
  return cells.map((c) => c.map((cell, i) => (i < 4 ? cell.padEnd(widths[i] + 2) : cell)).join('').trimEnd()).join('\n')
}

const FACT_REVIEW: Record<PrFacts['review'], string> = { approved: 'approved', 'changes-requested': 'changes requested', required: 'review required', unknown: 'no review decision' }

/** What the last pull request lookup said, as lines. */
export function prText(name: string, pr: { number: number; state: string; url?: string; facts?: PrFacts } | null, provider: 'github' | 'gitlab' = 'github'): string {
  if (!pr) return `${name} has no pull request yet.`
  const word = provider === 'gitlab' ? `MR !${pr.number}` : `PR #${pr.number}`
  const f = pr.facts
  const rows: string[][] = [['state', pr.state.toLowerCase() + (f?.draft ? ' (draft)' : '')]]
  if (f) {
    rows.push(['checks', f.checks === 'none' ? 'none' : `${f.checks}  ${f.checksPassed} of ${f.checksTotal} ${f.requiredOnly ? 'required ' : ''}passed${f.checksFailing ? `, ${f.checksFailing} failing` : ''}`])
    rows.push(['review', FACT_REVIEW[f.review] + (f.approvedBy?.length ? ` by ${f.approvedBy.join(', ')}` : '')])
    rows.push(['merge', f.mergeable === 'yes' ? 'no conflicts' : f.mergeable === 'conflicts' ? 'conflicts with the base' : 'not known yet'])
    rows.push(['read', `${when(f.readAt)}${f.unreadable ? '  (the latest lookup failed; this is from an earlier one)' : ''}`])
  }
  if (pr.url) rows.push(['url', pr.url])
  const width = Math.max(...rows.map((r) => r[0].length))
  return [`${name}: ${word}`, ...rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`)].join('\n')
}

/** "Started turn t1 in tab 2: commit and push" / "Queued …" / "Done: push". */
export function actionText(action: GitActionKind, receipt?: { disposition: SendDisposition; turn?: string; tab?: number }): string {
  const word = ACTION_WORDS[action]
  if (!receipt) return `Done: ${word}`
  const where = receipt.tab ? ` in tab ${receipt.tab}` : ''
  if (receipt.disposition === 'queued') return `Queued turn ${receipt.turn ?? ''}${where} behind the running one: ${word}`.replace('turn  ', 'turn ')
  if (receipt.disposition === 'steered') return `Steered turn ${receipt.turn ?? ''}${where}: ${word}`.replace('turn  ', 'turn ')
  return `Started turn ${receipt.turn ?? ''}${where}: ${word}`.replace('turn  ', 'turn ')
}

