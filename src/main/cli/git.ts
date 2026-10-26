// `foreman git`, `diff`, `commits`, `comments`, `pr`, `base-moved` and `ack-ci`: the Git panel's buttons through the same Api calls. Everything that puts a message in a chat goes
// through the start policy (§13 item 1) before it does, whoever the caller is.
import { prFacts } from '../../shared/board'
import { AUTO_FIX_BUDGET } from '../../shared/autoFix'
import { pullRequestUrl } from '../../shared/status'
import { tabModelText } from '../../shared/tabs'
import {
  GIT_ACTIONS,
  SCOPE_HELP,
  SENDING_ACTIONS,
  actionText,
  commentRow,
  commentsText,
  commitsText,
  countsText,
  diffRows,
  diffStatText,
  diffText,
  gitStatusText,
  parseDiffScope,
  prText,
  threadRow,
  threadsText,
  type AckResult,
  type AutoFixParams,
  type AutoFixResult,
  type CommentVerb,
  type CommentsParams,
  type CommentsResult,
  type CommitsResult,
  type DiffFileRow,
  type DiffParams,
  type DiffResult,
  type GitActionParams,
  type GitActionResult,
  type GitMergeParams,
  type GitMergeResult,
  type GitRevertParams,
  type GitRevertResult,
  type GitStatusParams,
  type GitStatusResult,
  type GitWorkspaceRef,
  type PrRefreshResult,
  type PrResult,
  type PrTabParams,
  type PrTabResult,
  type PrWatchParams,
  type PrWatchResult,
  type ThreadsParams,
  type ThreadsResult
} from '../../shared/cli/git'
import type { DiffComment, GitActionKind, GitStatus, Session, Workspace } from '../../shared/types'
import type { CliHost } from './host'
import { flagParam, invalid, numberParam, paramsObject, textList, textParam, type MethodDef } from './kit'
import type { CliContext } from './methods'
import { startRefusal } from './policy'
import { findByRef, notFound, plural, refused } from './refs'
import { findTab, findWorkspace } from './resolve'
import { diffWords, turnDiffWords } from './words'

const cwdOf = (p: Record<string, unknown>): string => textParam(p, 'cwd', { optional: true }) ?? process.cwd()

function workspaceOf(host: CliHost, p: Record<string, unknown>): Workspace {
  return findWorkspace(host.state(), textParam(p, 'workspace'), cwdOf(p))
}

const wsOut = (ws: Workspace): GitWorkspaceRef => ({ id: ws.id, name: ws.name })

const fromAgent = (ctx: CliContext): boolean => Boolean(ctx.caller?.token)

/** Anything that puts a message in a chat needs the repository's opt-in when an agent turn asks. */
function refuseStart(host: CliHost, ctx: CliContext): void {
  const refusal = startRefusal(host, ctx.caller)
  if (refusal) throw refused(refusal)
}

const openTabs = (host: CliHost, ws: Workspace): Session[] => host.state().sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)

/**
 * The chat a command means. With `--tab` that one; without, the only open tab, and several is an error that lists
 * them (nothing is queued behind a tab nobody picked). No open tab at all is fine: the action opens one.
 */
function chatFor(host: CliHost, ws: Workspace, tab: number | undefined): { session?: Session; tab?: number } {
  if (tab === undefined && openTabs(host, ws).length === 0) return {}
  const found = findTab(host.state().sessions, ws, tab)
  return { session: found.session, tab: found.tab }
}

/** Where tab `n` of the workspace is now, counting from 1. */
const tabNumber = (host: CliHost, ws: Workspace, sessionId: string | undefined): number | undefined => {
  const at = openTabs(host, ws).findIndex((s) => s.id === sessionId)
  return at >= 0 ? at + 1 : undefined
}

/** The turn a tab is running or has queued last, when it has one (the receipt of a call that doesn't return one). */
const latestTurn = (session: Session | undefined): string | undefined => session?.queue.at(-1)?.turnId ?? session?.turnId

// ----- status -----

async function status(host: CliHost, params: unknown): Promise<GitStatusResult> {
  const p = paramsObject(params as GitStatusParams)
  const ws = workspaceOf(host, p)
  // `fresh` asks the host right now: the PR cache answers within a minute otherwise. gitStatus has no flag for it, so
  // a refresh goes first, which is what the hover card's Refresh does.
  if (flagParam(p, 'fresh')) await host.api.refreshPullRequest(ws.id).catch(() => undefined)
  const result = await host.api.gitStatus(ws.id)
  return { workspace: wsOut(ws), status: result, text: gitStatusText(ws.name, result) }
}

// ----- actions -----

/** Whether Pull would hand the merge to a chat instead of fast-forwarding (the same test gitActions makes). */
const pullAsks = (s: GitStatus): boolean => s.uncommitted > 0 || (s.ahead > 0 && s.behind > 0) || (s.aheadBase > 0 && s.behindBase > 0)

async function action(host: CliHost, params: unknown, ctx: CliContext): Promise<GitActionResult> {
  const p = paramsObject(params as GitActionParams)
  const kind = textParam(p, 'action') as GitActionKind
  if (kind === 'merge' || kind === 'automerge') throw invalid('Merging asks first: use `foreman pr merge`.')
  if (kind === 'archive') throw invalid('Archiving shows what it would do first: use `foreman workspace archive`.')
  if (!(GIT_ACTIONS as readonly string[]).includes(kind)) throw invalid(`“${kind}” isn’t a git action. Actions: ${GIT_ACTIONS.join(', ')}`)
  const ws = workspaceOf(host, p)
  const tab = numberParam(p, 'tab')
  if (SENDING_ACTIONS.includes(kind) && fromAgent(ctx)) refuseStart(host, ctx)
  // Pull only queues a message when there is something to merge by hand; an agent may pull when it doesn't.
  if (kind === 'pull' && fromAgent(ctx) && pullAsks(await host.api.gitStatus(ws.id))) refuseStart(host, ctx)
  const sends = SENDING_ACTIONS.includes(kind)
  const target = sends || tab !== undefined ? chatFor(host, ws, tab) : {}
  const before = openTabs(host, ws).map((s) => s.id)
  const receipt = await host.api.gitAction(ws.id, kind, target.session?.id)
  if (!receipt?.turnId) return { workspace: wsOut(ws), action: kind, text: actionText(kind) }
  // Review opens a chat of its own; the others used the chosen one, or the first open tab.
  const after = openTabs(host, ws)
  const session = kind === 'review' ? after.find((s) => !before.includes(s.id)) : (target.session ?? after.find((s) => before[0] === s.id) ?? after[0])
  const at = tabNumber(host, ws, session?.id)
  return {
    workspace: wsOut(ws),
    action: kind,
    ...(at ? { tab: at } : {}),
    ...(session ? { session: session.id } : {}),
    turn: receipt.turnId,
    disposition: receipt.disposition,
    text: actionText(kind, { disposition: receipt.disposition, turn: receipt.turnId, tab: at })
  }
}

async function merge(host: CliHost, params: unknown): Promise<GitMergeResult> {
  const p = paramsObject(params as GitMergeParams)
  const ws = workspaceOf(host, p)
  const auto = flagParam(p, 'auto')
  if (!flagParam(p, 'confirmed')) {
    const current = await host.api.gitStatus(ws.id)
    if (!current.pr) throw invalid(`${ws.name} has no pull request to merge.`)
    const pr = current.pr
    if (pr.state !== 'OPEN') throw invalid(`${pr.provider === 'gitlab' ? 'MR !' : 'PR #'}${pr.number} is already ${pr.state.toLowerCase()}.`)
    const facts = prFacts(pr, new Date().toISOString())
    const word = pr.provider === 'gitlab' ? `MR !${pr.number}` : `PR #${pr.number}`
    const lines = [`${auto ? 'Merge when checks pass:' : 'Merge'} ${word} “${pr.title}” into ${pr.baseRefName}.`]
    lines.push(`  checks  ${facts.checks === 'none' ? 'none' : `${facts.checks} (${facts.checksPassed} of ${facts.checksTotal}${facts.checksFailing ? `, ${facts.checksFailing} failing` : ''})`}`)
    lines.push(`  review  ${facts.review === 'changes-requested' ? 'changes requested' : facts.review === 'required' ? 'review required' : facts.review}`)
    lines.push(`  merge   ${facts.mergeable === 'yes' ? 'no conflicts' : facts.mergeable === 'conflicts' ? 'CONFLICTS with the base' : 'not known yet'}${pr.isDraft ? '; it is a draft' : ''}`)
    let archives = false
    try {
      archives = !auto && host.resolvedRepoSettings(ws.repoId).values.archiveOnMerge
    } catch {
      // Repository settings unavailable: say nothing about archiving.
    }
    if (archives) lines.push(`  after   ${ws.name} is archived (Repository settings → Actions → Archive on merge)`)
    const previewText = lines.join('\n')
    return { workspace: wsOut(ws), auto, needsConfirmation: true, previewText, text: `${previewText}\nNothing was merged. Run it again with --yes to ${auto ? 'turn on auto-merge' : 'merge'}.` }
  }
  await host.api.gitAction(ws.id, auto ? 'automerge' : 'merge')
  return { workspace: wsOut(ws), auto, merged: !auto, text: auto ? `Auto-merge is on for ${ws.name}: it merges once the checks pass.` : `Merged the pull request of ${ws.name}.` }
}

/** A path as git wants it: from the workspace root, forward slashes. */
const cleanPath = (file: string): string => file.replace(/\\/g, '/').replace(/^\.\//, '')

async function revert(host: CliHost, params: unknown): Promise<GitRevertResult> {
  const p = paramsObject(params as GitRevertParams)
  const ws = workspaceOf(host, p)
  const files = [...new Set(textList(p, 'files').map(cleanPath).filter(Boolean))]
  if (!files.length) throw invalid('Name the files to put back: foreman git revert <workspace> <file>...')
  if (!flagParam(p, 'confirmed')) {
    const diff = await host.api.getDiff(ws.id, 'all')
    const changed = new Map(diff.files.map((f) => [f.path, f]))
    const unchanged = diff.truncated ? [] : files.filter((f) => !changed.has(f))
    if (unchanged.length) throw invalid(`${plural(unchanged.length, 'file')} ${unchanged.length === 1 ? 'has' : 'have'} no changes since ${ws.name} branched from ${diff.baseRef}: ${unchanged.join(', ')}. Paths are from the workspace’s root.`)
    const rows = files.map((f) => {
      const c = changed.get(f)
      return `  ${f}${c ? `  ${c.status === 'added' ? 'new file, deleted' : countsText(c.additions, c.deletions)}` : ''}`
    })
    const previewText = [`Put ${plural(files.length, 'file')} of ${ws.name} back as ${files.length === 1 ? 'it was' : 'they were'} where the branch started (${diff.baseRef}). Uncommitted and committed changes to ${files.length === 1 ? 'it' : 'them'} are discarded; a new file is deleted:`, ...rows].join('\n')
    return { workspace: wsOut(ws), files, needsConfirmation: true, previewText, text: `${previewText}\nNothing was reverted. Run it again with --yes to revert.` }
  }
  for (const file of files) await host.api.revertFile(ws.id, file)
  return { workspace: wsOut(ws), files, reverted: true, text: `Put ${plural(files.length, 'file')} of ${ws.name} back as ${files.length === 1 ? 'it was' : 'they were'} where the branch started.` }
}

// ----- diff, commits, comments -----

async function diff(host: CliHost, params: unknown): Promise<DiffResult> {
  const p = paramsObject(params as DiffParams)
  const ws = workspaceOf(host, p)
  const stat = flagParam(p, 'stat')
  const filesOnly = flagParam(p, 'files')
  if (stat && filesOnly) throw invalid('--stat and --files can’t be used together.')
  // --words: the narrator's sentences instead of the patch (the command only asks when it prints text).
  const words = flagParam(p, 'words')
  if (words && (stat || filesOnly)) throw invalid('--words can’t be used with --stat or --files.')
  const scopeText = textParam(p, 'scope', { optional: true }) ?? 'branch'
  const parsed = parseDiffScope(scopeText)
  if (!parsed) throw invalid(`“${scopeText}” isn’t a diff source. Use ${SCOPE_HELP}.`)
  if (parsed.scope === 'turn') {
    // A turn is kept as what it changed per file (its start and end checkpoints are compared once), not as a patch.
    const turn = await host.turnStatus(parsed.turn!)
    if (!turn || turn.workspaceId !== ws.id) throw notFound(`No turn named “${parsed.turn}” in ${ws.name}. \`foreman chat ${ws.name}\` shows the turn ids.`)
    const rows: DiffFileRow[] = (turn.delta?.files ?? []).map((f) => ({ path: f.path, status: 'modified', binary: false, additions: f.additions, deletions: f.deletions }))
    const text = !turn.delta ? `Foreman has no record of what turn ${parsed.turn} changed${turn.state === 'ended' ? '' : ' (it hasn’t ended)'}.` : words ? turnDiffWords(rows) : filesOnly ? rows.map((r) => r.path).join('\n') || 'No changes.' : `${diffStatText(rows)}\n(Counts only: Foreman keeps what a turn changed per file, not the patch.)`
    return { workspace: wsOut(ws), scope: scopeText, files: rows, additions: turn.delta?.additions ?? 0, deletions: turn.delta?.deletions ?? 0, truncated: false, text }
  }
  const result = await host.api.getDiff(ws.id, parsed.scope, parsed.commits)
  const plain = diffText(result, { stat, files: filesOnly })
  const patch = words ? undefined : plain.patch
  const text = words ? diffWords(result.files, { truncated: result.truncated, fallback: plain.text }) : plain.text
  const rows = diffRows(result.files)
  return {
    workspace: wsOut(ws),
    scope: scopeText,
    baseRef: result.baseRef,
    files: rows,
    additions: rows.reduce((n, r) => n + r.additions, 0),
    deletions: rows.reduce((n, r) => n + r.deletions, 0),
    truncated: result.truncated,
    ...(result.unavailable ? { unavailable: result.unavailable } : {}),
    ...(patch !== undefined && !stat && !filesOnly ? { patch } : {}),
    text
  }
}

async function commits(host: CliHost, params: unknown): Promise<CommitsResult> {
  const ws = workspaceOf(host, paramsObject(params))
  const list = await host.api.branchCommits(ws.id)
  return { workspace: wsOut(ws), commits: list, text: commitsText(list) }
}

const COMMENT_VERBS: CommentVerb[] = ['list', 'add', 'edit', 'resolve', 'delete']

async function comments(host: CliHost, params: unknown): Promise<CommentsResult> {
  const p = paramsObject(params as CommentsParams)
  const ws = workspaceOf(host, p)
  const verb = (textParam(p, 'verb', { optional: true }) ?? 'list') as CommentVerb
  if (!COMMENT_VERBS.includes(verb)) throw invalid(`“${verb}” isn’t a comments command. Use ${COMMENT_VERBS.join(', ')}.`)
  const mine = (): DiffComment[] => host.snapshot().comments.filter((c) => c.workspaceId === ws.id)
  const base = { workspace: wsOut(ws), verb }
  if (verb === 'list') {
    const rows = mine().map(commentRow)
    return { ...base, comments: rows, text: commentsText(rows) }
  }
  if (verb === 'add') {
    const file = cleanPath(textParam(p, 'file').trim())
    const line = numberParam(p, 'line')
    const body = textParam(p, 'body').trim()
    if (!file) throw invalid('Name the file: foreman comments <workspace> add <file> <line> "<text>"')
    if (line === undefined || !Number.isInteger(line) || line < 1) throw invalid('The line is a number from 1.')
    if (!body) throw invalid('Say what the comment is.')
    const changes = await host.api.getDiff(ws.id, 'all')
    if (!changes.truncated && !changes.files.some((f) => f.path === file)) throw invalid(`${file} has no changes in ${ws.name}, so there is nothing in the diff to comment on. Paths are from the workspace’s root.`)
    const known = new Set(mine().map((c) => c.id))
    await host.api.addComment(ws.id, file, line, body)
    const added = mine().find((c) => !known.has(c.id))
    const rows = mine().map(commentRow)
    return { ...base, comments: rows, ...(added ? { comment: commentRow(added) } : {}), text: `Added a comment on ${file}:${line}. It goes with the next message sent in any of ${ws.name}’s chats.` }
  }
  const query = textParam(p, 'id')
  const found = findByRef(mine(), query, 'comment', { id: (c) => c.id, names: () => [], describe: (c) => `${c.file}:${c.line} (id ${c.id.slice(0, 8)})` })
  if (verb === 'edit') {
    const body = textParam(p, 'body').trim()
    if (!body) throw invalid('Say what the comment should read now.')
    if (found.author !== 'user' || (found.state !== 'pending' && found.state !== 'held')) throw invalid(`Only a comment of yours that hasn’t been sent can be edited; this one is ${found.author === 'user' ? found.state : 'an agent’s'}.`)
    await host.api.updateComment(found.id, { body })
    const now = mine().find((c) => c.id === found.id) ?? { ...found, body }
    return { ...base, comments: mine().map(commentRow), comment: commentRow(now), text: `Edited the comment on ${found.file}:${found.line}.` }
  }
  if (verb === 'resolve') {
    if (found.state === 'resolved') throw invalid('That comment is already resolved.')
    await host.api.updateComment(found.id, { state: 'resolved' })
    return { ...base, comments: mine().map(commentRow), comment: commentRow({ ...found, state: 'resolved' }), text: `Resolved the comment on ${found.file}:${found.line}.` }
  }
  await host.api.deleteComment(found.id)
  return { ...base, comments: mine().map(commentRow), comment: commentRow(found), text: `Deleted the comment on ${found.file}:${found.line}.` }
}

// ----- pull requests -----

async function pr(host: CliHost, params: unknown): Promise<PrResult> {
  const ws = workspaceOf(host, paramsObject(params))
  const info = ws.prInfo ?? null
  const url = pullRequestUrl(ws)
  const found = info ? { number: info.number, state: info.state, ...(url ? { url } : {}), ...(info.facts ? { facts: info.facts } : {}) } : null
  const text = info ? prText(ws.name, found, info.facts?.provider) : url && ws.pullRequest ? `${ws.name}: PR #${ws.pullRequest.number}\n  url  ${url}\n  (Foreman hasn’t read it yet: \`foreman pr refresh ${ws.name}\`)` : prText(ws.name, null)
  return { workspace: wsOut(ws), pullRequest: found, ...(url ? { url } : {}), text }
}

const REFRESH_TEXT: Record<PrRefreshResult['outcome'], (name: string) => string> = {
  ok: (name) => `Refreshed the pull request of ${name}.`,
  'no-pr': (name) => `${name} has no pull request.`,
  paused: (name) => `Foreman is backing off from the host after errors; ${name}’s pull request wasn’t read. Try again in a minute.`,
  unavailable: (name) => `Couldn’t read ${name}’s pull request: the host didn’t answer or isn’t signed in. \`foreman git status ${name}\` says why.`
}

async function prRefresh(host: CliHost, params: unknown): Promise<PrRefreshResult> {
  const ws = workspaceOf(host, paramsObject(params))
  const outcome = await host.api.refreshPullRequest(ws.id)
  return { workspace: wsOut(ws), outcome, text: REFRESH_TEXT[outcome](ws.name) }
}

async function prWatch(host: CliHost, params: unknown): Promise<PrWatchResult> {
  const p = paramsObject(params as PrWatchParams)
  const ws = workspaceOf(host, p)
  const kind = textParam(p, 'kind')
  if (kind !== 'ci' && kind !== 'reviews') throw invalid(`“${kind}” isn’t something to watch. Use ci or reviews.`)
  const on = p.on
  if (typeof on !== 'boolean') throw invalid('Say on or off.')
  await host.api.setPrWatch(ws.id, kind, on)
  return { workspace: wsOut(ws), kind, on, text: `${on ? 'Watching' : 'Stopped watching'} ${kind === 'ci' ? 'CI' : 'review comments'} on ${ws.name}’s pull request.` }
}

/** fix-ci and base-moved: send to the picked tab, or a new one. */
async function toTab(host: CliHost, params: unknown, ctx: CliContext, call: (id: string, session: string | 'new' | undefined) => Promise<string>, what: string): Promise<PrTabResult> {
  const p = paramsObject(params as PrTabParams)
  const ws = workspaceOf(host, p)
  const fresh = flagParam(p, 'new')
  const tab = numberParam(p, 'tab')
  if (fresh && tab !== undefined) throw invalid('--tab and --new can’t be used together.')
  refuseStart(host, ctx)
  const target = fresh ? undefined : chatFor(host, ws, tab)
  const session = await call(ws.id, fresh ? 'new' : target?.session?.id)
  const at = tabNumber(host, ws, session)
  const turn = latestTurn(host.state().sessions.find((s) => s.id === session))
  return { workspace: wsOut(ws), tab: at ?? 0, session, ...(turn ? { turn } : {}), text: `${what} ${at ? `tab ${at}` : 'a new tab'} of ${ws.name}${turn ? ` (turn ${turn})` : ''}.` }
}

const fixCi = (host: CliHost, params: unknown, ctx: CliContext) => toTab(host, params, ctx, (id, session) => host.api.fixCi(id, session), 'Sent the failing CI logs to')
const baseMoved = (host: CliHost, params: unknown, ctx: CliContext) => toTab(host, params, ctx, (id, session) => host.api.resolveBaseMoved(id, session), 'Asked the agent to resolve the moved base in')

async function threads(host: CliHost, params: unknown, ctx: CliContext): Promise<ThreadsResult> {
  const p = paramsObject(params as ThreadsParams)
  const ws = workspaceOf(host, p)
  const verb = (textParam(p, 'verb', { optional: true }) ?? 'list') as 'list' | 'send'
  if (verb !== 'list' && verb !== 'send') throw invalid(`“${verb}” isn’t a threads command. Use list or send.`)
  if (verb === 'send') refuseStart(host, ctx)
  const all = await host.api.reviewThreads(ws.id)
  const rows = all.map(threadRow)
  if (verb === 'list') return { workspace: wsOut(ws), verb, threads: rows, text: threadsText(rows) }
  const wanted = textList(p, 'ids')
  if (!wanted.length) throw invalid('Name the threads: foreman pr threads <workspace> send <id>... (`list` shows the ids).')
  const picked = [...new Set(wanted.map((q) => findByRef(all, q, 'review thread', { id: (t) => t.id, names: () => [], describe: (t) => `${t.path}${t.line ? `:${t.line}` : ''} (id ${t.id})` }).id))]
  const target = chatFor(host, ws, numberParam(p, 'tab'))
  const session = await host.api.sendReviewThreads(ws.id, picked, target.session?.id)
  const at = tabNumber(host, ws, session)
  return { workspace: wsOut(ws), verb, threads: rows.filter((r) => picked.includes(r.id)), ...(at ? { tab: at } : {}), session, text: `Sent ${plural(picked.length, 'review thread')} to ${at ? `tab ${at}` : 'a tab'} of ${ws.name}.` }
}

// ----- auto-fix -----

function previewLines(ws: Workspace, preview: NonNullable<AutoFixResult['preview']>, tab: number): string {
  const rows: string[] = [`Turn on auto-fix CI for ${preview.pr ?? 'this pull request'} of ${ws.name}, in tab ${tab} (${preview.agent}):`]
  rows.push(`  When a check fails on the pull request, Foreman sends the Fix errors message to that tab with the failure logs, with no one asking first.`)
  rows.push(`  Budget  ${preview.perHead} tries per commit, ${preview.perPr} per pull request, ${preview.maxMinutes} minutes per try. It stops for good after a failed or stopped fix.`)
  rows.push(`  The tab may, without asking:  ${preview.permissions}`)
  rows.push('  The instructions it sends:')
  for (const line of preview.prompt.split(/\r?\n/)) rows.push(`    ${line}`)
  return rows.join('\n')
}

async function autoFix(host: CliHost, params: unknown): Promise<AutoFixResult> {
  const p = paramsObject(params as AutoFixParams)
  const ws = workspaceOf(host, p)
  const verb = (textParam(p, 'verb', { optional: true }) ?? 'status') as 'status' | 'on' | 'off'
  if (verb !== 'status' && verb !== 'on' && verb !== 'off') throw invalid(`“${verb}” isn’t an auto-fix command. Use status, on or off.`)
  const base = { workspace: wsOut(ws), verb }
  if (verb === 'status') {
    const current = host.state().workspaces.find((w) => w.id === ws.id)?.autoFix
    if (!current) return { ...base, enabled: false, text: `Auto-fix CI is off for ${ws.name}.` }
    const at = tabNumber(host, ws, current.consent.sessionId)
    const lines = [`Auto-fix CI is on for ${ws.name}, in ${at ? `tab ${at}` : 'a tab that is closed now'} (${current.consent.agent}).`, `  budget  ${current.consent.perHead} tries per commit, ${current.consent.perPr} per pull request`, `  tries   ${plural(current.attempts.length, 'attempt')} on ${current.pr ?? 'the pull request'}`]
    if (current.stopped) lines.push(`  stopped ${current.stopped.reason}${current.stopped.detail ? `: ${current.stopped.detail}` : ''}. Turn it off and on again to start over.`)
    return { ...base, enabled: true, text: lines.join('\n') }
  }
  if (verb === 'off') {
    await host.api.setAutoFix(ws.id, null)
    return { ...base, enabled: false, text: `Auto-fix CI is off for ${ws.name}.` }
  }
  const { session, tab } = findTab(host.state().sessions, ws, numberParam(p, 'tab'))
  const shown = p.shown as AutoFixParams['shown']
  if (!shown) {
    // The dialog's text first; turning it on needs the person to have seen exactly this.
    const preview = await host.api.autoFixPreview(ws.id, session.id)
    const previewText = previewLines(ws, preview, tab)
    return { ...base, enabled: false, needsConfirmation: true, preview, previewText, text: `${previewText}\nNothing was changed. Run it again with --yes to turn it on.` }
  }
  await host.api.setAutoFix(ws.id, shown)
  return { ...base, enabled: true, text: `Auto-fix CI is on for ${ws.name}, in tab ${tab} (${tabModelText(session)}): up to ${AUTO_FIX_BUDGET.perHead} tries per commit.` }
}

async function ackCi(host: CliHost, params: unknown): Promise<AckResult> {
  const ws = workspaceOf(host, paramsObject(params))
  await host.api.ackCiFailure(ws.id)
  return { workspace: wsOut(ws), text: `Marked the CI failure of ${ws.name} as seen.` }
}

export const GIT_METHODS: Record<string, MethodDef> = {
  'git-status': { tier: 'read', handle: async (host, params) => status(host, params) },
  // Every action that sends to a chat applies the start policy inside; merge and revert have their own admin methods.
  'git-action': { tier: 'act', handle: async (host, params, ctx) => action(host, params, ctx) },
  'git-merge': { tier: 'admin', handle: async (host, params) => merge(host, params) },
  'git-revert': { tier: 'admin', handle: async (host, params) => revert(host, params) },
  diff: { tier: 'read', handle: async (host, params) => diff(host, params) },
  commits: { tier: 'read', handle: async (host, params) => commits(host, params) },
  // Comments wait for the next message, as the panel's do; none of it starts a turn.
  comments: { tier: 'act', handle: async (host, params) => comments(host, params) },
  pr: { tier: 'read', handle: async (host, params) => pr(host, params) },
  'pr-refresh': { tier: 'act', handle: async (host, params) => prRefresh(host, params) },
  'pr-watch': { tier: 'act', handle: async (host, params) => prWatch(host, params) },
  'pr-fix-ci': { tier: 'act', handle: async (host, params, ctx) => fixCi(host, params, ctx) },
  'pr-threads': { tier: 'act', handle: async (host, params, ctx) => threads(host, params, ctx) },
  // Auto-fix is a consent (it lets Foreman send turns by itself): admin for every verb, `status` included.
  'pr-auto-fix': { tier: 'admin', handle: async (host, params) => autoFix(host, params) },
  'base-moved': { tier: 'act', handle: async (host, params, ctx) => baseMoved(host, params, ctx) },
  'ack-ci': { tier: 'act', handle: async (host, params) => ackCi(host, params) }
}
