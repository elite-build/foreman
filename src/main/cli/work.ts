// The work commands: start a workspace from a template, send, wait, cancel, resume, checks, status and report.
// Moved here from cliServer.ts as they were; the registry (methods.ts) maps requests onto them.
import { isIssuePlaceholder } from '../../shared/githubLink'
import { findLinearLink } from '../../shared/linearLink'
import { findScmLink } from '../../shared/scm'
import { fillTemplate, templatePlaceholders, templateSlug } from '../../shared/promptTemplates'
import { findLayeredTemplate } from '../../shared/repoTemplates'
import { readRepoTemplates } from '../repoTemplates'
import { sendReceiptText, tabModelText } from '../../shared/tabs'
import { checksState, pullRequestUrl, statusRows } from '../../shared/status'
import type { CreateWorkspaceOptions, Repo, TurnStatus } from '../../shared/types'
import { clockTime, dayOf } from '../../shared/usageLimit'
import type { CancelParams, CancelResult, ChecksCliResult, ChecksParams, ReportParams, ReportResult, ResumeAtParams, ResumeAtResult, RunParams, RunResult, SendParams, SendResult, StatusResult, WaitParams, WaitResult } from '../../cli/protocol'
import { HISTORY_ONLY_REASON, wsPath } from '../../shared/workspacePath'
import { isBlocker, isReportKind, type TurnCaller } from '../../shared/agentReports'
import type { CliHost } from './host'
import { chosenIntegrations } from './workspaceIntegrations'
import { findTab, findWorkspace, resolveRepo, resolveWorkspace } from './resolve'

/**
 * `foreman send`: queue a message into one explicit tab. With several tabs and no
 * --tab it refuses and lists them. It never steers a running turn, and a message
 * that waits is queued under the id of the turn it will start, so the receipt holds.
 */
export async function send(host: CliHost, params: SendParams, options: { literal?: boolean } = {}): Promise<SendResult> {
  const state = host.state()
  const ws = findWorkspace(state, params.workspace, params.cwd)
  if (ws.heldMessage) throw new Error(`${ws.name}: setup failed and its first message is held. Open the workspace and choose Start anyway first.`)
  if (ws.state === 'history') throw new Error(`${ws.name}: ${HISTORY_ONLY_REASON}`)
  if (ws.state !== 'ready') throw new Error(`${ws.name} isn’t ready yet (${ws.state}).`)
  const { tab, session } = findTab(state.sessions, ws, params.tab)

  // An exact template name, id or slug (not a fuzzy match) followed by values; anything else is the message itself.
  const [first, ...values] = params.args
  const exact = first && !options.literal ? state.settings.promptTemplates.find((t) => [t.id, t.name.toLowerCase(), templateSlug(t.name)].includes(first.trim().toLowerCase()) || t.id === first.trim()) : undefined
  let text: string
  let templateId: string | undefined
  if (exact) {
    const filled = fillTemplate(exact.body, values)
    if ('error' in filled) throw new Error(`${exact.name}: ${filled.error}`)
    text = filled.text
    templateId = exact.id
  } else text = params.args.join(' ').trim()
  if (!text) throw new Error('Say what to send: a template name with its values, or the message.')
  if (/^\/\S+$/.test(text)) throw new Error('Foreman’s /commands run in the app, not from the command line.')

  const receipt = await host.deliver(session.id, text, { mode: 'queue', templateId, via: 'cli' })
  if (!receipt.turnId || receipt.disposition === 'handled') throw new Error('Foreman handled that message itself; no turn was started.')
  return {
    workspace: { id: ws.id, name: ws.name },
    tab,
    model: tabModelText(session),
    session: session.id,
    turn: receipt.turnId,
    disposition: receipt.disposition,
    message: sendReceiptText(receipt.disposition, tab, session, receipt.turnId)
  }
}

/** `foreman cancel`: a queued turn is dropped, a starting or running one is stopped. */
export async function cancel(host: CliHost, params: CancelParams): Promise<CancelResult> {
  const before = await host.turnStatus(params.turn)
  if (!before) throw new Error(`No turn with the id “${params.turn}”. \`foreman run\` and \`foreman send\` print it.`)
  const after = before.state === 'ended' ? before : await host.cancelTurn(params.turn)
  const outcome = after?.outcome ?? 'cancelled'
  const name = host.state().workspaces.find((w) => w.id === before.workspaceId)?.name ?? before.workspaceId
  const message =
    before.state === 'ended'
      ? `Turn ${params.turn} had already ended (${outcome}); nothing to cancel.`
      : before.state === 'queued'
        ? `Cancelled turn ${params.turn} before it started (it was queued). Outcome: cancelled.`
        : `Stopped turn ${params.turn}. Outcome: ${outcome}.`
  return { workspace: { id: before.workspaceId, name }, session: before.sessionId, turn: params.turn, was: before.state, outcome, message }
}

/**
 * G4 #11 `foreman resume-at <turn>`: arm the usage-limit resume the turn's recovery card offers, with the same
 * rules as ticking it (the chat's latest turn, a stated reset time still ahead, one per tab). --cancel disarms it.
 */
export async function resumeAt(host: CliHost, params: ResumeAtParams, now = Date.now()): Promise<ResumeAtResult> {
  const status = await host.turnStatus(params.turn)
  if (!status) throw new Error(`No turn with the id “${params.turn}”. \`foreman run\` and \`foreman send\` print it.`)
  if (!host.armLimitResume || !host.cancelLimitResume) throw new Error('This version of Foreman can’t arm a resume from the command line.')
  const state = host.state()
  const name = state.workspaces.find((w) => w.id === status.workspaceId)?.name ?? status.workspaceId
  const base = { workspace: { id: status.workspaceId, name }, session: status.sessionId, turn: params.turn }
  if (params.cancel) {
    const armed = state.sessions.find((s) => s.id === status.sessionId)?.limitResume
    host.cancelLimitResume(status.sessionId)
    return { ...base, armed: false, message: armed ? `Cancelled the resume in ${name}. Nothing will be sent.` : `No resume was armed in ${name}; nothing to cancel.` }
  }
  const resume = await host.armLimitResume(status.sessionId, params.turn)
  const at = Date.parse(resume.at)
  const day = dayOf(at, now)
  const when = `${day === 'today' ? 'today' : day === 'tomorrow' ? 'tomorrow' : day} at ${clockTime(at)}`
  const source = resume.from === 'event' ? `Claude’s rate-limit event (${resume.source})` : `Claude: “…${resume.source}”`
  return {
    ...base,
    at: resume.at,
    armed: true,
    message: `Armed: ${name} sends “${resume.text}” once, ${when} (the reset time from ${source}, plus a minute). Anything you do in that chat first cancels it; \`foreman resume-at ${params.turn} --cancel\` disarms it.`
  }
}

export async function checks(host: CliHost, params: ChecksParams): Promise<ChecksCliResult> {
  return host.runChecks(resolveWorkspace(host.state(), params.cwd).id)
}

/** Every live workspace the way Home triages it. "Ready for review" needs the window's read marks, so it isn't reported here. */
export function status(host: CliHost): StatusResult {
  const state = host.state()
  const names = Object.fromEntries(state.repos.map((r) => [r.id, r.name]))
  const snapshot = { workspaces: state.workspaces, sessions: state.sessions }
  return statusRows({ snapshot, approvals: host.approvals(), unread: {}, unreadSessions: {} }, names)
}

export async function run(host: CliHost, params: RunParams): Promise<RunResult> {
  const state = host.state()
  // The repo's own templates join the user's once we know which repo is meant.
  let repo: Repo | undefined
  let repoError: unknown
  try {
    repo = await resolveRepo(state, params.cwd, params.repo)
  } catch (err) {
    repoError = err
  }
  const found = findLayeredTemplate(state.settings.promptTemplates, repo ? readRepoTemplates(repo.id, repo.rootPath) : [], params.template)
  if ('error' in found) throw new Error(found.error)
  if (!repo) throw repoError
  // A GitHub issue or PR URL among the values: the workspace is made from it, and an issue fills {{issue id}}.
  const names = templatePlaceholders(found.template.body)
  const exactLink = (v: string) => {
    const l = findScmLink(v)
    return l && v.trim() === l.url ? l : null
  }
  const link = params.values.map(exactLink).find(Boolean) ?? undefined
  const linear = params.values.map((v) => findLinearLink(v, { bareIds: true })).find(Boolean)
  const values = params.values.map((v, i) => {
    const l = exactLink(v)
    const li = findLinearLink(v, { bareIds: true })
    if (names[i] && isIssuePlaceholder(names[i])) {
      if (l?.kind === 'issue') return `${l.repo}#${l.number}`
      if (li) return li.identifier
    }
    return v
  })
  const filled = fillTemplate(found.template.body, values)
  if ('error' in filled) throw new Error(`${found.template.name}: ${filled.error}`)
  const result: RunResult = { template: found.template.name, repo: repo.name, prompt: filled.text }
  // Checked before a dry run returns, so a mistake shows up there too.
  const integrations = chosenIntegrations(host, repo, params.with, params.without)
  if (params.dryRun) return result
  let loadout: CreateWorkspaceOptions['loadout']
  if (params.loadout !== undefined) {
    loadout = state.settings.loadouts[params.loadout - 1]
    if (!loadout) throw new Error(`There is no loadout ${params.loadout}; Settings has ${state.settings.loadouts.length}`)
  }
  const ws = await host.createWorkspace(repo.id, {
    prompt: filled.text,
    templateId: found.template.id,
    githubUrl: link?.url,
    ...(linear ? { linearIssue: linear.url ?? linear.identifier } : {}),
    baseBranch: params.base?.trim() || undefined,
    branch: { kind: 'new', name: params.branch?.trim() || undefined },
    loadout,
    ...(integrations ? { integrations } : {})
  })
  if (params.open) host.reveal(ws.id)
  result.workspace = { id: ws.id, name: ws.name, branch: ws.branch, path: wsPath(ws) }
  if (ws.pullRequest) result.pullRequest = ws.pullRequest
  if (params.noWait) return result
  const setup = await host.setupOutcome(ws.id)
  if (setup.held) {
    if (params.startAnyway) {
      await host.startHeldMessage(ws.id)
      result.startedAnyway = true
    } else result.held = { logTail: setup.logTail }
  }
  if (!result.held) {
    const first = await host.firstTurn(ws.id)
    if (first) Object.assign(result, first)
  }
  return result
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait for a turn's outcome. It reads the turn's persisted record, so a waiter
 * that attaches after the turn ended (or after the app restarted) gets the same
 * answer. Timing out only stops the waiting; the turn carries on.
 */
export async function waitForTurn(host: CliHost, params: WaitParams, options: { signal?: AbortSignal; pollMs?: number } = {}): Promise<WaitResult> {
  const deadline = params.timeoutSec !== undefined ? Date.now() + params.timeoutSec * 1000 : Infinity
  let seen: TurnStatus | undefined
  for (;;) {
    const status = await host.turnStatus(params.turn)
    if (!status && !seen) throw new Error(`No turn with the id “${params.turn}”. \`foreman run\` and \`foreman send\` print it.`)
    // A queued message that was removed before it started was cancelled.
    const now: TurnStatus = status ?? { ...seen!, state: 'ended', outcome: 'cancelled' }
    seen = now
    if (now.state === 'ended' || Date.now() >= deadline || options.signal?.aborted) {
      const ws = host.state().workspaces.find((w) => w.id === now.workspaceId)
      const result: WaitResult = {
        workspace: { id: now.workspaceId, name: ws?.name ?? now.workspaceId },
        session: now.sessionId,
        turn: now.turnId,
        outcome: now.state === 'ended' ? (now.outcome ?? 'error') : 'timeout',
        checks: checksState(ws?.checks)
      }
      if (now.error) result.error = now.error
      if (now.durationMs !== undefined) result.durationMs = now.durationMs
      if (now.delta) result.delta = now.delta
      const number = ws?.prInfo?.number ?? ws?.pullRequest?.number
      if (ws && number !== undefined) result.pr = { number, state: ws.prInfo?.number === number ? ws.prInfo.state : undefined, url: pullRequestUrl(ws) }
      return result
    }
    await sleep(options.pollMs ?? 200)
  }
}

/**
 * #2 `foreman report` / `foreman review`. With a valid turn token it is attributed to that
 * tab and turn (and to an earlier turn when that one has ended); without one, to the
 * workspace the command runs in, and the answer says so.
 */
export function report(host: CliHost, params: ReportParams, caller?: TurnCaller): ReportResult {
  if (params.kind !== 'review' && !isReportKind(params.kind)) throw new Error(`“${String(params.kind)}” isn’t a report. Use needs-input, stuck, checkpoint or done.`)
  const who = host.identifyCaller(caller)
  const state = host.state()
  const ws = who?.kind === 'turn' ? who.ws : resolveWorkspace(state, params.cwd)
  const base = { workspaceId: ws.id, kind: params.kind, text: params.text, link: params.link, via: 'cli' as const }
  const { report: saved, added } = host.recordReport(
    who?.kind === 'turn' ? { ...base, sessionId: who.session.id, turnId: who.turnId, late: !who.live } : { ...base, badToken: who?.kind === 'bad-token' }
  )
  const what = params.kind === 'review' ? 'a review request' : params.kind
  const result: Omit<ReportResult, 'message'> = { workspace: { id: ws.id, name: ws.name }, attribution: who?.kind === 'turn' ? 'turn' : 'workspace' }
  if (who?.kind === 'turn') {
    const tabs = state.sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)
    const tab = tabs.findIndex((s) => s.id === who.session.id) + 1
    Object.assign(result, { session: who.session.id, turn: who.turnId, ...(tab ? { tab } : {}), ...(who.live ? {} : { late: true }) })
  }
  if (!added) return { ...result, duplicate: true, message: 'Already reported; nothing changed.' }
  const where = who?.kind === 'turn' ? `${result.tab ? `tab ${result.tab} of ` : ''}${ws.name}` : `${ws.name} only`
  const lines = [`Reported ${what} for ${where}.`]
  if (who?.kind !== 'turn') lines.push(who?.kind === 'bad-token' ? 'The turn token wasn’t recognised, so it isn’t tied to a tab.' : 'There was no turn token, so it isn’t tied to a tab.')
  if (result.late) lines.push('That turn has ended, so it is kept as history ("from an earlier turn") and doesn’t change what Home shows.')
  else if (isBlocker(saved.kind)) lines.push('The user sees it on Home as “agent says” until they reply or dismiss it.')
  else if (saved.kind === 'review') lines.push('Foreman added a row on the user’s Home. Nothing starts until they open it.')
  return { ...result, message: lines.join(' ') }
}
