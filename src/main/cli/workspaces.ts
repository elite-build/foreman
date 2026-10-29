// The workspace commands and `foreman new`: list, show, path, open, rename, pin,
// status, archive, unarchive, forget, activate, adopt, setup, note, usage, spotlight, docker, alerts and reports. Each
// is the operation the window performs, called through the same Api. A workspace is a name, id, branch or ".".
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { openReports } from '../../shared/agentReports'
import { durationText } from '../../shared/checks'
import { sendReceiptText } from '../../shared/tabs'
import type { ArchivedRow, NewParams, NewResult, SetupVerb, WorkspaceKind, WsAdoptParams, WsAdoptResult, WsAlertsResult, WsArchiveResult, WsChangeResult, WsDockerResult, WsForgetResult, WsIntegrationsParams, WsIntegrationsResult, WsListResult, WsNoteParams, WsNoteResult, WsOpenResult, WsPathResult, WsReportsResult, WsSetupResult, WsSetupSummary, WsShowResult, WsSpotlightResult, WsUnarchiveResult, WsUsageResult } from '../../shared/cli/workspaces'
import { checksState, pullRequestUrl, statusRows, statusTable } from '../../shared/status'
import type { DockerListing, DockerRemoval } from '../../shared/docker'
import type { ArchivePreview, CreateWorkspaceOptions, Repo, Session, Workspace, WorkspaceStatus } from '../../shared/types'
import type { RepoIntegrationService } from '../../shared/integrations'
import { wsPath } from '../../shared/workspacePath'
import { CliCodedError, type CliHost } from './host'
import { columns, flagParam, invalid, numberParam, paramsObject, textList, textParam, type MethodDef } from './kit'
import { chosenIntegrations, integrationRows, integrationsText, switchedIntegrations } from './workspaceIntegrations'
import type { CliContext } from './methods'
import { startRefusal } from './policy'
import { findByRef, notFound, plural, refused } from './refs'
import { findTab, findWorkspace, resolveRepo } from './resolve'
import { tabRows, tabsText } from './tabs'

const cwdOf = (p: Record<string, unknown>): string => textParam(p, 'cwd', { optional: true }) ?? process.cwd()
const wsOut = (ws: Workspace) => ({ id: ws.id, name: ws.name })

/** An agent's call needs the repository's opt-in before it may start or queue a turn; the person at the terminal never does. */
function refuseStart(host: CliHost, ctx: CliContext): void {
  const refusal = startRefusal(host, ctx.caller)
  if (refusal) throw refused(refusal)
}

const fromAgent = (ctx: CliContext): boolean => Boolean(ctx.caller?.token)

/** The live workspace the command names. */
function liveOf(host: CliHost, p: Record<string, unknown>): Workspace {
  return findWorkspace(host.state(), textParam(p, 'workspace'), cwdOf(p))
}

function archivedOf(host: CliHost, query: string): Workspace {
  const archived = host.state().workspaces.filter((w) => w.state === 'archived')
  return findByRef(archived, query, 'archived workspace', { id: (w) => w.id, names: (w) => [w.name, w.branch], describe: (w) => `${w.name} (id ${w.id})` })
}

/** A live workspace, else an archived one (docker leftovers and `show` are about both). */
function anyOf(host: CliHost, p: Record<string, unknown>): Workspace {
  const query = textParam(p, 'workspace')
  try {
    return findWorkspace(host.state(), query, cwdOf(p))
  } catch (err) {
    if (query === '.' || !(err instanceof Error) || !err.message.startsWith('No workspace named')) throw err
    try {
      return archivedOf(host, query)
    } catch {
      throw err
    }
  }
}

function repoName(host: CliHost, ws: Workspace): string {
  return host.state().repos.find((r) => r.id === ws.repoId)?.name ?? ws.repoId
}

function kindOf(ws: Workspace): WorkspaceKind {
  if (ws.cloud) return 'cloud'
  if (ws.direct) return 'direct'
  if (ws.state === 'history' || !ws.path) return 'history'
  return ws.adopted ? 'adopted' : 'worktree'
}

function setupSummary(ws: Workspace): WsSetupSummary | undefined {
  const run = ws.setupRun
  if (!run) return undefined
  return { id: run.id, startedAt: run.startedAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}), steps: run.steps.map((s) => ({ name: s.name, status: s.status })) }
}

function setupText(s: WsSetupSummary): string {
  const counts = new Map<string, number>()
  for (const step of s.steps) counts.set(step.status, (counts.get(step.status) ?? 0) + 1)
  const parts = [...counts].map(([status, n]) => `${n} ${status}`)
  return `${plural(s.steps.length, 'step')}${parts.length ? ` (${parts.join(', ')})` : ''}${s.finishedAt ? `, finished ${s.finishedAt.slice(0, 16).replace('T', ' ')}` : ', still running'}`
}

// ----- list, show, path, open -----

async function list(host: CliHost, params: unknown): Promise<WsListResult> {
  const p = paramsObject(params)
  const state = host.state()
  const repo = textParam(p, 'repo', { optional: true }) ? await resolveRepo(state, cwdOf(p), textParam(p, 'repo')) : undefined
  const inRepo = (w: Workspace) => !repo || w.repoId === repo.id
  const names = Object.fromEntries(state.repos.map((r) => [r.id, r.name]))
  if (flagParam(p, 'archived')) {
    const archived: ArchivedRow[] = state.workspaces
      .filter((w) => w.state === 'archived' && inRepo(w))
      .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))
      .map((w) => ({ workspace: w.name, id: w.id, repo: names[w.repoId] ?? w.repoId, branch: w.branch, ...(w.archivedAt ? { archivedAt: w.archivedAt } : {}), ...(w.archiveDiff ? { diff: { files: w.archiveDiff.files, additions: w.archiveDiff.additions, deletions: w.archiveDiff.deletions, ...(w.archiveDiff.truncated ? { truncated: true } : {}) } } : {}) }))
    const text = archived.length
      ? columns([['WORKSPACE', 'REPO', 'BRANCH', 'ARCHIVED', 'DIFF'], ...archived.map((a) => [a.workspace, a.repo, a.branch, a.archivedAt?.slice(0, 10) ?? '', a.diff ? `+${a.diff.additions} -${a.diff.deletions} in ${plural(a.diff.files, 'file')}${a.diff.truncated ? ' (cut off)' : ''}` : ''])]).join('\n')
      : 'No archived workspaces.'
    return { workspaces: [], archived, text }
  }
  const rows = statusRows({ snapshot: { workspaces: state.workspaces, sessions: state.sessions }, approvals: host.approvals(), unread: {}, unreadSessions: {} }, names).filter((r) => {
    const ws = state.workspaces.find((w) => w.id === r.id)
    return !repo || ws?.repoId === repo.id
  })
  return { workspaces: rows, text: rows.length ? statusTable(rows) : 'No workspaces.' }
}

async function show(host: CliHost, params: unknown): Promise<WsShowResult> {
  const p = paramsObject(params)
  const ws = anyOf(host, p)
  const state = host.state()
  const names = Object.fromEntries(state.repos.map((r) => [r.id, r.name]))
  const row = ws.state === 'archived' ? undefined : statusRows({ snapshot: { workspaces: state.workspaces, sessions: state.sessions }, approvals: host.approvals(), unread: {}, unreadSessions: {} }, names).find((r) => r.id === ws.id)
  const tabs = tabRows(state.sessions, ws)
  const kind = kindOf(ws)
  const open = openReports(ws.agentReports).map((r) => ({ id: r.id, kind: r.kind, text: r.text }))
  const number = ws.prInfo?.number ?? ws.pullRequest?.number
  const pr = number !== undefined ? { number, ...(ws.prInfo?.number === number && ws.prInfo.state ? { state: ws.prInfo.state } : {}), ...(pullRequestUrl(ws) ? { url: pullRequestUrl(ws) } : {}) } : undefined
  const setup = setupSummary(ws)
  const checks = checksState(ws.checks)
  const info: WsShowResult['workspace'] = {
    id: ws.id,
    name: ws.name,
    repo: repoName(host, ws),
    branch: ws.branch,
    base: ws.baseBranch,
    ...(ws.path ? { path: ws.path } : {}),
    kind,
    state: ws.state,
    ...(ws.status ? { status: ws.status } : {}),
    pinned: Boolean(ws.pinned),
    ...(row ? { bucket: row.bucket, ...(row.label ? { label: row.label } : {}) } : {}),
    createdAt: ws.createdAt,
    ...(ws.archivedAt ? { archivedAt: ws.archivedAt } : {}),
    ...(ws.cloud ? { cloud: { provider: ws.cloud.provider, status: ws.cloud.status, region: ws.cloud.region } } : {})
  }
  const lines: string[][] = [
    ['id', ws.id],
    ['state', [ws.state, ws.status, ws.pinned ? 'pinned' : '', row?.label ? `“${row.label}”` : ''].filter(Boolean).join(' · ')],
    ['kind', kind === 'direct' ? 'direct (works in the repository folder)' : kind === 'adopted' ? 'adopted (archiving leaves its folder and branch alone)' : kind],
    ['branch', `${ws.branch}  (base ${ws.baseBranch})`],
    ['path', ws.path ?? (ws.cloud ? `sandbox ${ws.cloud.id} (${ws.cloud.provider}, ${ws.cloud.status})` : 'none: history only')]
  ]
  if (pr) lines.push(['pr', `#${pr.number}${pr.state ? ` ${String(pr.state).toLowerCase()}` : ''}${pr.url ? `  ${pr.url}` : ''}`])
  lines.push(['checks', checks])
  if (open.length) lines.push(['reports', `${open.length} open: ${open.map((r) => r.kind).join(', ')}`])
  if (ws.alerts?.length) lines.push(['alerts', `${plural(ws.alerts.length, 'sensitive-path alert')}`])
  if (ws.note) lines.push(['note', `r${ws.note.revision}, ${plural(ws.note.text.length, 'character')}`])
  if (setup) lines.push(['setup', setupText(setup)])
  if (ws.archivedAt) lines.push(['archived', ws.archivedAt.slice(0, 16).replace('T', ' ')])
  const text = [`${ws.name}  (${info.repo})`, ...columns(lines).map((l) => `  ${l}`), ...(tabs.length ? ['  tabs', ...tabsText(tabs).split('\n').map((l) => `    ${l}`)] : [])].join('\n')
  return { workspace: info, tabs, ...(pr ? { pr } : {}), checks, openReports: open, ...(ws.note ? { note: { revision: ws.note.revision, chars: ws.note.text.length } } : {}), ...(setup ? { setup } : {}), text }
}

async function pathOf(host: CliHost, params: unknown): Promise<WsPathResult> {
  const ws = liveOf(host, paramsObject(params))
  const folder = wsPath(ws)
  return { path: folder, text: folder }
}

async function open(host: CliHost, params: unknown): Promise<WsOpenResult> {
  const ws = liveOf(host, paramsObject(params))
  host.reveal(ws.id)
  return { workspace: wsOut(ws), text: `Brought Foreman forward on ${ws.name}.` }
}

// ----- the workspace's own fields -----

const BOARD_STATUSES: WorkspaceStatus[] = ['backlog', 'in-progress', 'in-review', 'done', 'canceled']

async function rename(host: CliHost, params: unknown): Promise<WsChangeResult> {
  const p = paramsObject(params)
  const ws = liveOf(host, p)
  const name = textParam(p, 'name').trim()
  if (!name) throw invalid('Give the workspace a name.')
  await host.api.updateWorkspace(ws.id, { name })
  return { workspace: { id: ws.id, name }, changed: { name }, text: `Renamed ${ws.name} to ${name}.` }
}

function pinner(pinned: boolean) {
  return async (host: CliHost, params: unknown): Promise<WsChangeResult> => {
    const ws = liveOf(host, paramsObject(params))
    await host.api.updateWorkspace(ws.id, { pinned })
    return { workspace: wsOut(ws), changed: { pinned }, text: `${pinned ? 'Pinned' : 'Unpinned'} ${ws.name}.` }
  }
}

async function setStatus(host: CliHost, params: unknown): Promise<WsChangeResult> {
  const p = paramsObject(params)
  const ws = liveOf(host, p)
  const word = textParam(p, 'status').trim().toLowerCase()
  if (word === 'none') {
    await host.api.updateWorkspace(ws.id, { status: null })
    return { workspace: wsOut(ws), changed: { status: null }, text: `Cleared the status of ${ws.name}.` }
  }
  const status = BOARD_STATUSES.find((s) => s === word)
  if (!status) throw invalid(`“${word}” isn’t a status. Use ${[...BOARD_STATUSES, 'none'].join(', ')}.`)
  await host.api.updateWorkspace(ws.id, { status })
  return { workspace: wsOut(ws), changed: { status }, text: `${ws.name} is now ${status}.` }
}

// ----- archive, unarchive, forget, activate, adopt -----

function dockerListingText(listing: DockerListing): string {
  switch (listing.status) {
    case 'missing':
      return 'Docker isn’t installed (the docker command isn’t on the PATH).'
    case 'not-running':
      return 'Docker isn’t running.'
    case 'error':
      return `Docker couldn’t be asked: ${listing.detail}`
    case 'ok':
      return listing.containers.length ? columns([['NAME', 'IMAGE', 'STATE'], ...listing.containers.map((c) => [c.name, c.image, c.status])]).join('\n') : 'No containers.'
  }
}

function dockerRemovalText(removal: DockerRemoval): string {
  if (removal.status !== 'ok') return dockerListingText(removal.status === 'error' ? { status: 'error', detail: removal.detail ?? '' } : { status: removal.status })
  const lines: string[] = []
  if (removal.removed.length) lines.push(`Removed ${plural(removal.removed.length, 'container')}: ${removal.removed.join(', ')}`)
  for (const f of removal.failed) lines.push(`Couldn’t remove ${f.name}: ${f.detail}`)
  if (removal.networks?.removed.length) lines.push(`Removed ${plural(removal.networks.removed.length, 'network')}: ${removal.networks.removed.join(', ')}`)
  return lines.length ? lines.join('\n') : 'No containers to remove.'
}

/** What archiving would stop, keep and delete, in the words the window's dialog uses. */
export function archivePreviewText(ws: Pick<Workspace, 'name' | 'branch'>, preview: ArchivePreview, options: { deleteBranch?: boolean; stop?: boolean } = {}): string {
  const rows: string[][] = []
  const folder = { worktree: 'removed', direct: 'stays: it is the repository folder', adopted: 'stays: it was added from disk', history: 'nothing on disk' }[preview.kind]
  rows.push(['folder', preview.kind === 'history' ? 'none (history only)' : `${preview.folder}  (${folder})`])
  rows.push(['branch', `${preview.branch}${options.deleteBranch ? '  (will be deleted)' : preview.kind === 'worktree' ? '  (kept)' : ''}`])
  if (preview.running.length) rows.push(['running', `${plural(preview.running.length, 'tab')}: ${preview.running.map((r) => r.title || 'New chat').join(', ')}${options.stop ? '  (will be stopped)' : '  (archiving refuses unless you add --stop)'}`])
  if (preview.checksRunning) rows.push(['checks', 'running now'])
  rows.push(['uncommitted', preview.uncommitted === null ? 'git couldn’t say' : preview.uncommitted === 0 ? 'none' : `${plural(preview.uncommitted, 'file')}  (saved as a checkpoint first)`])
  if (preview.unpushed) rows.push(['unpushed', preview.unpushed.count ? `${plural(preview.unpushed.count, 'commit')} not on ${preview.unpushed.against}` : `none (against ${preview.unpushed.against})`])
  if (preview.terminals) rows.push(['terminals', `${preview.terminals} open  (closed)`])
  if (preview.hasArchiveScript) rows.push(['script', preview.archiveSteps?.length ? `archive script: ${preview.archiveSteps.map((s) => s.name).join(', ')}` : 'archive script runs first'])
  const docker = preview.docker
  if (docker?.enabled) rows.push(['docker', docker.status === 'ok' ? (docker.containers.length ? `${plural(docker.containers.length, 'container')} removed: ${docker.containers.map((c) => c.name).join(', ')}` : 'no containers') : dockerListingText(docker)])
  return [`Archiving ${ws.name}:`, ...columns(rows).map((l) => `  ${l}`)].join('\n')
}

async function archive(host: CliHost, params: unknown, ctx: CliContext): Promise<WsArchiveResult> {
  const p = paramsObject(params)
  const ws = liveOf(host, p)
  const deleteBranch = flagParam(p, 'deleteBranch')
  const stop = flagParam(p, 'stop')
  if (!flagParam(p, 'confirmed')) {
    const preview = await host.api.archivePreview(ws.id)
    const previewText = archivePreviewText(ws, preview, { deleteBranch, stop })
    return { workspace: wsOut(ws), needsConfirmation: true, preview, previewText, text: `${previewText}\nNothing was archived. Run it again with --yes to archive.` }
  }
  // Each step the window's dialog shows arrives as an event; here they become progress lines.
  const off = host.onEvent((event) => {
    if (event.type !== 'archive-progress' || event.workspaceId !== ws.id) return
    const { step, status, detail } = event.progress
    ctx.progress(`${step}: ${status}${detail ? ` (${detail})` : ''}`)
  })
  let outcome
  try {
    outcome = await host.api.archiveWorkspace(ws.id, deleteBranch, { ...(stop ? { stopTabs: true } : {}), ...(flagParam(p, 'anyway') ? { anyway: true } : {}) })
  } finally {
    off()
  }
  if (!outcome.ok) {
    return {
      workspace: wsOut(ws),
      archived: false,
      failed: { step: outcome.step, detail: outcome.detail },
      text: `Archiving ${ws.name} stopped at the ${outcome.step} step: ${outcome.detail}\nNothing was deleted. Fix that and run it again, or add --anyway to carry on regardless.`
    }
  }
  const lines = [`Archived ${ws.name}.${deleteBranch ? ` Its branch ${ws.branch} was deleted.` : ''}`]
  if (outcome.docker && (outcome.docker.removed.length || outcome.docker.failed.length || outcome.docker.status !== 'ok')) lines.push(dockerRemovalText(outcome.docker))
  return { workspace: wsOut(ws), archived: true, ...(outcome.docker ? { docker: outcome.docker } : {}), text: lines.join('\n') }
}

async function unarchive(host: CliHost, params: unknown): Promise<WsUnarchiveResult> {
  const ws = archivedOf(host, textParam(paramsObject(params), 'workspace'))
  await host.api.unarchiveWorkspace(ws.id)
  const now = host.state().workspaces.find((w) => w.id === ws.id)
  return { workspace: wsOut(ws), state: now?.state ?? 'ready', text: `Unarchived ${ws.name}${now && now.state !== 'ready' ? ` (${now.state})` : ''}.` }
}

async function forget(host: CliHost, params: unknown): Promise<WsForgetResult> {
  const ws = archivedOf(host, textParam(paramsObject(params), 'workspace'))
  await host.api.forgetWorkspace(ws.id)
  return { workspace: wsOut(ws), text: `Forgot ${ws.name}: its chats and records are gone.` }
}

async function activate(host: CliHost, params: unknown): Promise<WsUnarchiveResult> {
  const ws = liveOf(host, paramsObject(params))
  if (ws.state !== 'history') throw invalid(`${ws.name} isn’t history only (it is ${ws.state}), so there is nothing to activate.`)
  await host.api.activateWorkspace(ws.id)
  const now = host.state().workspaces.find((w) => w.id === ws.id)
  return { workspace: wsOut(ws), state: now?.state ?? 'ready', text: `Activated ${ws.name}: it has a worktree here now.` }
}

async function adopt(host: CliHost, params: unknown, ctx: CliContext): Promise<WsAdoptResult> {
  const p = paramsObject(params as WsAdoptParams)
  const cwd = cwdOf(p)
  const prompt = textParam(p, 'prompt', { optional: true })?.trim()
  // A first message starts a turn, so an agent needs the repository's opt-in.
  if (prompt) refuseStart(host, ctx)
  const repo = await resolveRepo(host.state(), cwd, textParam(p, 'repo', { optional: true }))
  const folder = path.resolve(cwd, textParam(p, 'path'))
  const ws = await host.api.adoptWorktree(repo.id, folder, { runSetup: flagParam(p, 'setup'), ...(prompt ? { prompt } : {}) })
  return { workspace: { id: ws.id, name: ws.name, branch: ws.branch, path: ws.path ?? folder }, repo: repo.name, text: `Added ${ws.name} in ${repo.name}\n  branch  ${ws.branch}\n  path    ${ws.path ?? folder}${prompt ? '\n  The first message was sent.' : ''}` }
}

// ----- setup, note, usage, spotlight, docker, alerts, reports -----

const SETUP_VERBS: SetupVerb[] = ['log', 'rerun', 'retry', 'stop', 'steps']

async function setup(host: CliHost, params: unknown): Promise<WsSetupResult> {
  const p = paramsObject(params)
  const verb = (textParam(p, 'verb', { optional: true }) ?? 'log') as SetupVerb
  if (!SETUP_VERBS.includes(verb)) throw invalid(`“${verb}” isn’t a setup command. Use ${SETUP_VERBS.join(', ')}.`)
  const ws = liveOf(host, p)
  const base = { workspace: wsOut(ws), verb }
  const current = () => host.state().workspaces.find((w) => w.id === ws.id) ?? ws
  if (verb === 'log') {
    let log = await host.api.getSetupLog(ws.id)
    const tail = numberParam(p, 'tail')
    if (tail !== undefined) {
      if (!Number.isInteger(tail) || tail < 1) throw invalid('tail must be a whole number of lines, from 1.')
      log = log.replace(/\n$/, '').split('\n').slice(-tail).join('\n')
    }
    const setupRun = setupSummary(current())
    return { ...base, ...(setupRun ? { setup: setupRun } : {}), log, text: log.replace(/\n$/, '') || 'The setup log is empty.' }
  }
  if (verb === 'steps') {
    const got = await host.api.getSetupStepLogs(ws.id)
    const run = current().setupRun
    if (!got) return { ...base, steps: [], text: `${ws.name} has no setup steps logged.` }
    const steps = got.logs.map((log, i) => ({ name: run?.steps[i]?.name ?? `step ${i + 1}`, ...(run?.steps[i] ? { status: run.steps[i].status } : {}), log }))
    const text = steps.map((s) => `== ${s.name}${s.status ? ` (${s.status})` : ''}\n${s.log.replace(/\n$/, '')}`).join('\n\n')
    return { ...base, steps, text: text || `${ws.name}’s setup has no steps.` }
  }
  if (verb === 'rerun') await host.api.rerunSetup(ws.id)
  else if (verb === 'retry') await host.api.retrySetup(ws.id)
  else await host.api.stopSetup(ws.id)
  const summary = setupSummary(current())
  const text = { rerun: `Started setup again in ${ws.name}.`, retry: `Retrying ${ws.name}’s setup from the step that failed.`, stop: `Stopped ${ws.name}’s running setup step.` }[verb]
  return { ...base, ...(summary ? { setup: summary } : {}), text }
}

async function note(host: CliHost, params: unknown, ctx: CliContext): Promise<WsNoteResult> {
  const p = paramsObject(params as WsNoteParams)
  const verb = (textParam(p, 'verb', { optional: true }) ?? 'get') as WsNoteParams['verb']
  if (verb !== 'get' && verb !== 'set' && verb !== 'send') throw invalid(`“${verb}” isn’t a note command. Use get, set or send.`)
  const ws = liveOf(host, p)
  const base = { workspace: wsOut(ws), verb }
  const revisionOf = (n: Workspace['note']) => (n ? { text: n.text, revision: n.revision, updatedAt: n.updatedAt } : undefined)
  if (verb === 'get') {
    const n = revisionOf(ws.note)
    return { ...base, ...(n ? { note: n } : {}), text: ws.note?.text.trim() ? ws.note.text.replace(/\n$/, '') : `${ws.name} has no note.` }
  }
  if (verb === 'set') {
    // The note is the user's guidance to every tab; an agent doesn’t write it.
    if (fromAgent(ctx)) throw refused('The workspace note is the user’s guidance to the agents; it can’t be changed from inside an agent turn.')
    const text = textParam(p, 'text')
    await host.api.saveNote(ws.id, text)
    const now = host.state().workspaces.find((w) => w.id === ws.id)?.note
    const n = revisionOf(now)
    return { ...base, ...(n ? { note: n } : {}), text: text.trim() ? `Saved the note of ${ws.name}${now ? ` (revision ${now.revision})` : ''}. Nothing was sent to any chat.` : `Cleared the note of ${ws.name}.` }
  }
  // send: the note goes to one explicit tab as a normal queued message.
  refuseStart(host, ctx)
  if (!ws.note?.text.trim()) throw invalid(`${ws.name} has no note to send.`)
  const { tab, session } = findTab(host.state().sessions, ws, numberParam(p, 'tab'))
  const receipt = await host.api.sendNote(session.id)
  if (!receipt.turnId || receipt.disposition === 'handled') throw new CliCodedError('failed', 'Foreman handled that itself; no turn was started.')
  const disposition = receipt.disposition
  return { ...base, note: revisionOf(ws.note), sent: { tab, session: session.id, turn: receipt.turnId, disposition }, text: sendReceiptText(disposition, tab, session, receipt.turnId) }
}

/** `foreman workspace integrations`: what a workspace's agents get, and switching one for its next turns. */
async function integrations(host: CliHost, params: unknown, ctx: CliContext): Promise<WsIntegrationsResult> {
  const p = paramsObject(params as WsIntegrationsParams)
  const ws = liveOf(host, p)
  const repo = host.state().repos.find((r) => r.id === ws.repoId)
  if (!repo) throw invalid(`${ws.name}’s repository is gone.`)
  const on = textList(p, 'on', { optional: true }) ?? []
  const off = textList(p, 'off', { optional: true }) ?? []
  let changed: WsIntegrationsResult['changed']
  if (on.length || off.length) {
    // Switching one on gives the agent more tools: from inside a turn, only with the repository's opt-in.
    if (on.length) refuseStart(host, ctx)
    if (ws.cloud) throw invalid('Integration tools don’t reach a cloud sandbox yet, so there’s nothing to switch in a cloud workspace.')
    changed = switchedIntegrations(host, repo, on, off)
    for (const [service, value] of Object.entries(changed)) await host.api.setWorkspaceIntegration(ws.id, service as RepoIntegrationService, Boolean(value))
  }
  const now = host.state().workspaces.find((w) => w.id === ws.id) ?? ws
  const rows = await integrationRows(host, repo, now)
  return { workspace: wsOut(now), integrations: rows, ...(changed ? { changed } : {}), text: integrationsText(now, rows, changed) }
}

async function usage(host: CliHost, params: unknown): Promise<WsUsageResult> {
  const ws = liveOf(host, paramsObject(params))
  const u = await host.api.workspaceUsage(ws.id)
  const sessions = host.state().sessions
  const cost = (t: { costUsd?: number; costNote?: string }) => (t.costUsd !== undefined ? `$${t.costUsd.toFixed(2)}` : (t.costNote ?? ''))
  const rows: string[][] = [['TAB', 'TURNS', 'AGENT TIME', 'COST']]
  for (const [id, t] of Object.entries(u.tabs)) {
    const s: Session | undefined = sessions.find((x) => x.id === id)
    rows.push([s?.title || (s ? 'New chat' : id.slice(0, 8)), String(t.turns), durationText(t.agentMs), cost(t)])
  }
  rows.push(['total', String(u.total.turns), durationText(u.total.agentMs), `${cost(u.total)}${u.total.partial ? ' (partial: some chats report no cost)' : ''}`])
  return { workspace: wsOut(ws), usage: u, text: Object.keys(u.tabs).length ? columns(rows).join('\n') : `${ws.name} has no turns yet.` }
}

async function spotlight(host: CliHost, params: unknown): Promise<WsSpotlightResult> {
  const p = paramsObject(params)
  const ws = liveOf(host, p)
  const on = flagParam(p, 'on')
  await host.api.setSpotlight(ws.id, on)
  return { workspace: wsOut(ws), on, text: on ? `Spotlight is on for ${ws.name}: its changes are mirrored into the repository folder.` : `Spotlight is off for ${ws.name}.` }
}

async function docker(host: CliHost, params: unknown): Promise<WsDockerResult> {
  const p = paramsObject(params)
  const verb = (textParam(p, 'verb', { optional: true }) ?? 'list') as WsDockerResult['verb']
  if (verb !== 'list' && verb !== 'remove' && verb !== 'dismiss') throw invalid(`“${verb}” isn’t a docker command. Use list, remove or dismiss.`)
  const ws = anyOf(host, p)
  const base = { workspace: wsOut(ws), verb }
  if (verb === 'list') {
    const listing = await host.api.dockerContainers(ws.id)
    return { ...base, listing, text: dockerListingText(listing) }
  }
  if (verb === 'remove') {
    const removal = await host.api.removeDockerContainers(ws.id)
    return { ...base, removal, text: dockerRemovalText(removal) }
  }
  await host.api.dismissDockerLeft(ws.id)
  return { ...base, text: `Dismissed the “still running after archive” line for ${ws.name}. Nothing was removed.` }
}

function findById<T extends { id: string }>(items: T[], query: string | undefined, what: string, where: string): T {
  if (!query?.trim()) throw invalid(`Name the ${what}: its id from the list.`)
  const q = query.trim().toLowerCase()
  const exact = items.find((i) => i.id.toLowerCase() === q)
  if (exact) return exact
  const starts = q.length >= 4 ? items.filter((i) => i.id.toLowerCase().startsWith(q)) : []
  if (starts.length === 1) return starts[0]
  if (starts.length > 1) throw new CliCodedError('ambiguous', `“${query}” matches several ${what}s in ${where}. Pass more of the id.`)
  throw notFound(`${where} has no ${what} “${query}”.`)
}

async function alerts(host: CliHost, params: unknown): Promise<WsAlertsResult> {
  const p = paramsObject(params)
  const verb = (textParam(p, 'verb', { optional: true }) ?? 'list') as WsAlertsResult['verb']
  if (verb !== 'list' && verb !== 'dismiss') throw invalid(`“${verb}” isn’t an alerts command. Use list or dismiss.`)
  const ws = liveOf(host, p)
  const open = host.state().sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)
  const rowsOf = (w: Workspace) => (w.alerts ?? []).map((a) => ({ id: a.id, ...(open.findIndex((s) => s.id === a.sessionId) >= 0 ? { tab: open.findIndex((s) => s.id === a.sessionId) + 1 } : {}), turn: a.turnId, files: a.files }))
  const textOf = (rows: ReturnType<typeof rowsOf>) => (rows.length ? columns(rows.map((r) => [r.id.slice(0, 8), r.tab ? `tab ${r.tab}` : '', `turn ${r.turn}`, r.files.join(', ')])).join('\n') : `${ws.name} has no sensitive-path alerts.`)
  if (verb === 'list') {
    const rows = rowsOf(ws)
    return { workspace: wsOut(ws), verb, alerts: rows, text: textOf(rows) }
  }
  const alert = findById(ws.alerts ?? [], textParam(p, 'id', { optional: true }), 'alert', ws.name)
  await host.api.dismissAlert(ws.id, alert.id)
  const after = host.state().workspaces.find((w) => w.id === ws.id) ?? ws
  return { workspace: wsOut(ws), verb, alerts: rowsOf(after), text: `Dismissed the alert on ${alert.files.join(', ') || 'a sensitive path'}.` }
}

async function reports(host: CliHost, params: unknown): Promise<WsReportsResult> {
  const p = paramsObject(params)
  const verb = (textParam(p, 'verb', { optional: true }) ?? 'list') as WsReportsResult['verb']
  if (verb !== 'list' && verb !== 'close') throw invalid(`“${verb}” isn’t a reports command. Use list or close.`)
  const ws = liveOf(host, p)
  const open = host.state().sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)
  const rowsOf = (w: Workspace) =>
    [...(w.agentReports ?? [])]
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((r) => {
        const tab = r.sessionId ? open.findIndex((s) => s.id === r.sessionId) + 1 : 0
        return { id: r.id, kind: r.kind, text: r.text, at: r.at, ...(r.link ? { link: r.link } : {}), ...(tab ? { tab } : {}), ...(r.closed ? { closed: r.closed.how } : {}) }
      })
  if (verb === 'list') {
    const rows = rowsOf(ws)
    const text = rows.length ? columns(rows.map((r) => [r.id.slice(0, 8), r.kind, r.closed ? `closed (${r.closed})` : 'open', r.tab ? `tab ${r.tab}` : '', r.text])).join('\n') : `${ws.name} has no agent reports.`
    return { workspace: wsOut(ws), verb, reports: rows, text }
  }
  const report = findById(openReports(ws.agentReports), textParam(p, 'id', { optional: true }), 'open report', ws.name)
  await host.api.closeAgentReport(ws.id, report.id, 'dismissed')
  const after = host.state().workspaces.find((w) => w.id === ws.id) ?? ws
  return { workspace: wsOut(ws), verb, reports: rowsOf(after), text: `Dismissed the ${report.kind} report: ${report.text}` }
}

// ----- new -----

function newText(result: NewResult): string {
  const lines = [`Started ${result.workspace.name} in ${result.repo}`, `  workspace  ${result.workspace.id}`, `  branch     ${result.workspace.branch}`, `  path       ${result.workspace.path ?? (result.cloud ? 'in a cloud sandbox' : '')}`]
  if (result.session) lines.push(`  session    ${result.session}`)
  if (result.turn) lines.push(`  turn       ${result.turn}`)
  if (result.startedAnyway) lines.push('  setup failed; sent the first message anyway')
  if (result.pullRequest) lines.push(`  checked out  ${result.pullRequest.repo}#${result.pullRequest.number}`)
  return lines.join('\n')
}

/** `foreman new "<prompt>"`: the same path as `foreman run`, with the words typed instead of a template. */
async function startNew(host: CliHost, params: unknown, ctx: CliContext): Promise<NewResult> {
  const p = paramsObject(params as NewParams)
  const prompt = textParam(p, 'prompt').trim()
  if (!prompt) throw invalid('Say what to work on: foreman new "<prompt>".')
  // A new workspace sends its first message: an agent needs the opt-in of the repository it runs in.
  refuseStart(host, ctx)
  const cwd = cwdOf(p)
  const state = host.state()
  const repo: Repo = await resolveRepo(state, cwd, textParam(p, 'repo', { optional: true }))
  const branchName = textParam(p, 'branch', { optional: true })?.trim()
  const existing = textParam(p, 'existing', { optional: true })?.trim()
  const direct = textParam(p, 'direct', { optional: true })?.trim()
  const cloud = flagParam(p, 'cloud')
  if ([branchName, existing, direct].filter(Boolean).length > 1) throw invalid('Use one of --branch (a new branch), --existing (check out a branch) or --direct (work in the repository folder).')
  if (direct && cloud) throw invalid('A cloud workspace can’t work in the repository folder: drop --direct or --cloud.')
  const slot = numberParam(p, 'loadout')
  let loadout: CreateWorkspaceOptions['loadout']
  if (slot !== undefined) {
    loadout = state.settings.loadouts[slot - 1]
    if (!loadout) throw invalid(`There is no loadout ${slot}; Settings has ${state.settings.loadouts.length}`)
  }
  const attach = p.attach === undefined || p.attach === null ? [] : Array.isArray(p.attach) && p.attach.every((a) => typeof a === 'string') ? (p.attach as string[]) : undefined
  if (!attach) throw invalid('attach must be a list of file paths.')
  const withList = textList(p, 'with', { optional: true }) ?? []
  // Linear and Slack tools don't reach a cloud sandbox, so there's nothing to switch there.
  if (cloud && withList.length) throw invalid('Integration tools don’t reach a cloud sandbox yet: drop --with or --cloud.')
  const integrations = cloud ? undefined : chosenIntegrations(host, repo, withList, textList(p, 'without', { optional: true }) ?? [])
  const attachments = attach.map((file) => {
    const full = path.resolve(cwd, file)
    if (!existsSync(full) || !statSync(full).isFile()) throw invalid(`${file} isn’t a file${full === file ? '' : ` (looked for ${full})`}.`)
    return full
  })
  const ws = await host.createWorkspace(repo.id, {
    prompt,
    baseBranch: textParam(p, 'base', { optional: true })?.trim() || undefined,
    branch: existing ? { kind: 'existing', name: existing } : direct ? { kind: 'direct', name: direct } : { kind: 'new', name: branchName || undefined },
    ...(loadout ? { loadout } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(cloud ? { location: 'cloud' as const } : {}),
    ...(integrations ? { integrations } : {})
  })
  if (flagParam(p, 'open')) host.reveal(ws.id)
  const result: NewResult = { repo: repo.name, prompt, workspace: { id: ws.id, name: ws.name, branch: ws.branch, ...(ws.path ? { path: ws.path } : {}) }, ...(ws.cloud ? { cloud: true } : {}), text: '' }
  if (ws.pullRequest) result.pullRequest = ws.pullRequest
  if (!flagParam(p, 'noWait')) {
    const settled = await host.setupOutcome(ws.id)
    if (settled.held) {
      if (flagParam(p, 'startAnyway')) {
        await host.startHeldMessage(ws.id)
        result.startedAnyway = true
      } else result.held = { logTail: settled.logTail }
    }
    if (!result.held) {
      const first = await host.firstTurn(ws.id)
      if (first) Object.assign(result, first)
    }
  }
  result.text = newText(result)
  return result
}

export const WORKSPACE_METHODS: Record<string, MethodDef> = {
  'ws-list': { tier: 'read', handle: async (host, params) => list(host, params) },
  'ws-show': { tier: 'read', handle: async (host, params) => show(host, params) },
  'ws-path': { tier: 'read', handle: async (host, params) => pathOf(host, params) },
  'ws-open': { tier: 'act', handle: async (host, params) => open(host, params) },
  'ws-rename': { tier: 'act', handle: async (host, params) => rename(host, params) },
  'ws-pin': { tier: 'act', handle: async (host, params) => pinner(true)(host, params) },
  'ws-unpin': { tier: 'act', handle: async (host, params) => pinner(false)(host, params) },
  'ws-status': { tier: 'act', handle: async (host, params) => setStatus(host, params) },
  // Archiving deletes a folder and forgetting deletes the chats: admin, so never from an agent turn.
  'ws-archive': { tier: 'admin', handle: async (host, params, ctx) => archive(host, params, ctx) },
  'ws-unarchive': { tier: 'act', handle: async (host, params) => unarchive(host, params) },
  'ws-forget': { tier: 'admin', handle: async (host, params) => forget(host, params) },
  'ws-activate': { tier: 'act', handle: async (host, params) => activate(host, params) },
  // With a prompt, adopting starts a turn; the handler applies the start policy.
  'ws-adopt': { tier: 'act', handle: async (host, params, ctx) => adopt(host, params, ctx) },
  'ws-setup': { tier: 'act', handle: async (host, params) => setup(host, params) },
  'ws-note': { tier: 'act', handle: async (host, params, ctx) => note(host, params, ctx) },
  'ws-usage': { tier: 'read', handle: async (host, params) => usage(host, params) },
  // Switching one on from an agent turn needs the repository's opt-in, like starting a turn.
  'ws-integrations': { tier: 'act', handle: async (host, params, ctx) => integrations(host, params, ctx) },
  'ws-spotlight': { tier: 'act', handle: async (host, params) => spotlight(host, params) },
  'ws-docker': { tier: 'act', handle: async (host, params) => docker(host, params) },
  'ws-alerts': { tier: 'act', handle: async (host, params) => alerts(host, params) },
  'ws-reports': { tier: 'act', handle: async (host, params) => reports(host, params) },
  // `new` sends the first message of a workspace: it starts a turn, so an agent call needs the repository's opt-in.
  new: { tier: 'act', handle: async (host, params, ctx) => startNew(host, params, ctx) }
}
