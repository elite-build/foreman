// The approval commands: approvals, approve, deny and stopped. Answering an approval
// lets an agent act, so approve and deny are admin: refused with any turn token (§13 item 2). Retrying a stopped turn
// sends its message again, so it goes through the start policy like `foreman send`.
import { toolSummary } from '../../shared/cli/tabs'
import type { ApprovalAnswerResult, ApprovalRow, ApprovalsResult, ApproveParams, DenyParams, StoppedParams, StoppedResult, StoppedRow } from '../../shared/cli/approvals'
import type { ApprovalRequest, ApprovalResponse, Session, Workspace } from '../../shared/types'
import type { CliHost } from './host'
import { columns, flagParam, invalid, paramsObject, textParam, type MethodDef } from './kit'
import type { CliContext } from './methods'
import { startRefusal } from './policy'
import { ambiguous, notFound, refused } from './refs'

const clip = (text: string, n = 90): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

/** Lines of a plan that look like steps: numbered or bulleted. */
function planSteps(plan: string): number {
  return plan.split('\n').filter((l) => /^\s*(\d+[.)]|[-*•])\s+\S/.test(l)).length
}

/** What a request asks, in one line. */
export function askText(request: ApprovalRequest): string {
  if (request.kind === 'tool') {
    const summary = toolSummary(request.input)
    return clip(`${request.toolName}${summary ? `: ${summary}` : Object.keys(request.input).length ? `: ${JSON.stringify(request.input)}` : ''}`)
  }
  if (request.kind === 'plan') {
    const first = request.plan.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? 'Plan'
    const steps = planSteps(request.plan)
    return clip(`${first}${steps ? ` (${steps} ${steps === 1 ? 'step' : 'steps'})` : ''}`)
  }
  const first = request.questions[0]?.question ?? 'A question'
  return clip(`${first}${request.questions.length > 1 ? ` (+${request.questions.length - 1} more)` : ''}`)
}

function rowOf(request: ApprovalRequest, sessions: Session[], workspaces: Workspace[]): ApprovalRow {
  const session = sessions.find((s) => s.id === request.sessionId)
  const ws = session ? workspaces.find((w) => w.id === session.workspaceId) : undefined
  const open = session ? sessions.filter((s) => s.workspaceId === session.workspaceId && !s.closedAt) : []
  const tab = session && !session.closedAt ? open.findIndex((s) => s.id === session.id) + 1 : 0
  return {
    id: request.id,
    workspace: ws?.name ?? '(unknown)',
    ...(ws ? { workspaceId: ws.id } : {}),
    ...(tab ? { tab } : {}),
    ...(session && !tab ? { tabTitle: session.title || 'New chat' } : {}),
    kind: request.kind,
    ask: askText(request),
    ...(request.kind === 'tool' && request.alternate ? { alternate: request.alternate } : {})
  }
}

async function approvals(host: CliHost): Promise<ApprovalsResult> {
  const requests = await host.api.pendingApprovals()
  const { sessions, workspaces } = host.state()
  const rows = requests.map((r) => rowOf(r, sessions, workspaces))
  const text = rows.length ? columns([['ID', 'WORKSPACE', 'TAB', 'KIND', 'ASK'], ...rows.map((r) => [r.id.slice(0, 8), r.workspace, r.tab ? String(r.tab) : (r.tabTitle ?? ''), r.kind, r.ask])]).join('\n') : 'Nothing is waiting for an answer.'
  return { approvals: rows, text }
}

/** The request `query` names: its id or the start of it (four characters or more). */
async function requestOf(host: CliHost, query: string): Promise<ApprovalRequest> {
  const q = query.trim().toLowerCase()
  if (!q) throw invalid('Name a request: `foreman approvals` lists their ids.')
  const all = await host.api.pendingApprovals()
  const exact = all.find((r) => r.id.toLowerCase() === q)
  if (exact) return exact
  const starts = q.length >= 4 ? all.filter((r) => r.id.toLowerCase().startsWith(q)) : []
  if (starts.length > 1) throw ambiguous(`“${query}” matches several requests. Pass more of the id.`)
  if (starts.length === 1) return starts[0]
  throw notFound(`No request waiting with the id “${query}”.${all.length ? ' `foreman approvals` lists them.' : ' Nothing is waiting for an answer.'}`)
}

/** Which of a question request's questions a key means: its text, its header, or its position from 1. */
function questionKey(request: Extract<ApprovalRequest, { kind: 'question' }>, key: string): string {
  const q = key.trim().toLowerCase()
  const { questions } = request
  if (/^\d+$/.test(q) && questions[Number(q) - 1]) return questions[Number(q) - 1].question
  const hit =
    questions.find((x) => x.question.toLowerCase() === q) ??
    questions.find((x) => x.header?.toLowerCase() === q) ??
    (q.length >= 3 ? questions.filter((x) => x.question.toLowerCase().startsWith(q)) : []).find((_, __, all) => all.length === 1)
  if (!hit) throw invalid(`The question has no “${key}”. Its questions: ${questions.map((x, i) => `${i + 1}. ${x.question}`).join(' | ')}`)
  return hit.question
}

async function approve(host: CliHost, params: unknown): Promise<ApprovalAnswerResult> {
  const p = paramsObject(params as ApproveParams)
  const request = await requestOf(host, textParam(p, 'id'))
  const always = flagParam(p, 'always')
  const edits = flagParam(p, 'edits')
  const message = textParam(p, 'message', { optional: true })?.trim() || undefined
  const feedback = textParam(p, 'feedback', { optional: true })?.trim() || undefined
  const planFlag = flagParam(p, 'plan')
  let response: ApprovalResponse
  let answer: string
  if (request.kind === 'tool') {
    if (planFlag || feedback || p.answers) throw invalid('That is a tool request. Use --always, --edits or --message with it.')
    if (always && edits) throw invalid('Choose one of --always and --edits.')
    if (always && request.alternate !== 'always-allow') throw invalid(`${request.toolName} has no “always allow” answer${request.alternate === 'edits-for-session' ? '; use --edits to allow edits for the session' : ''}.`)
    if (edits && request.alternate !== 'edits-for-session') throw invalid(`${request.toolName} has no “allow edits for the session” answer${request.alternate === 'always-allow' ? '; use --always to allow it from now on' : ''}.`)
    response = { kind: 'tool', allow: true, ...(always || edits ? { alternate: true } : {}), ...(message ? { message } : {}) }
    answer = always ? 'allowed, and from now on' : edits ? 'allowed, and edits for the session' : 'allowed'
  } else if (request.kind === 'plan') {
    if (always || edits || message || p.answers) throw invalid('That is a plan. Use --plan with --feedback to approve it with a note.')
    response = { kind: 'plan', approve: true, ...(feedback ? { feedback } : {}) }
    answer = 'approved'
  } else {
    if (always || edits || message || feedback || planFlag) throw invalid('That is a question. Answer it with --answer "question=choice".')
    const raw = p.answers
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) {
      throw invalid(`That is a question. Answer it with --answer "question=choice". ${request.questions.map((q, i) => `${i + 1}. ${q.question} [${q.options.map((o) => o.label).join(' | ')}]`).join('  ')}`)
    }
    const answers: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'string') throw invalid('Each answer must be text.')
      const question = questionKey(request, key)
      const spec = request.questions.find((q) => q.question === question)
      // A choice by its label (any case); anything else is the person's own words, as the window's “Other” takes.
      const label = spec?.options.find((o) => o.label.toLowerCase() === value.trim().toLowerCase())?.label
      answers[question] = label ?? value.trim()
    }
    const missing = request.questions.filter((q) => !(q.question in answers))
    if (missing.length) throw invalid(`Answer every question; missing: ${missing.map((q) => q.question).join(' | ')}`)
    response = { kind: 'question', answers }
    answer = 'answered'
  }
  await host.api.respondApproval(request.id, response)
  const row = rowOf(request, host.state().sessions, host.state().workspaces)
  return { id: request.id, workspace: row.workspace, kind: request.kind, answer, text: `Approved ${request.kind} request ${request.id.slice(0, 8)} in ${row.workspace}: ${answer}.` }
}

async function deny(host: CliHost, params: unknown): Promise<ApprovalAnswerResult> {
  const p = paramsObject(params as DenyParams)
  const request = await requestOf(host, textParam(p, 'id'))
  const message = textParam(p, 'message', { optional: true })?.trim() || undefined
  let response: ApprovalResponse
  let answer: string
  if (request.kind === 'tool') {
    response = { kind: 'tool', allow: false, ...(message ? { message } : {}) }
    answer = 'denied'
  } else if (request.kind === 'plan') {
    response = { kind: 'plan', approve: false, ...(message ? { feedback: message } : {}) }
    answer = 'sent back'
  } else {
    response = { kind: 'question', skipped: true }
    answer = 'skipped'
  }
  await host.api.respondApproval(request.id, response)
  const row = rowOf(request, host.state().sessions, host.state().workspaces)
  return { id: request.id, workspace: row.workspace, kind: request.kind, answer, text: `${request.kind === 'question' ? 'Skipped' : request.kind === 'plan' ? 'Sent back' : 'Denied'} ${request.kind} request ${request.id.slice(0, 8)} in ${row.workspace}.` }
}

// ----- stopped turns -----

const CAUSE = { quit: 'Foreman quit', crash: 'Foreman crashed' } as const

function stoppedText(rows: StoppedRow[]): string {
  if (!rows.length) return 'No stopped turns to review.'
  return columns([['KEY', 'WORKSPACE', 'KIND', 'WHY', 'WHAT'], ...rows.map((r) => [r.key, r.workspace, r.kind, CAUSE[r.cause], r.kind === 'turn' ? `${r.title ? `${r.title}: ` : ''}${clip(r.message ?? '', 50)}${r.closed ? ' (tab closed)' : ''}` : 'checks'])]).join('\n')
}

async function stoppedRows(host: CliHost): Promise<StoppedRow[]> {
  const rows = await host.api.stopReview()
  return rows.map((r) => ({ key: r.key, kind: r.kind, workspace: r.workspace, cause: r.cause, at: r.at, ...(r.kind === 'turn' ? { ...(r.title ? { title: r.title } : {}), ...(r.message ? { message: r.message } : {}), ...(r.closed ? { closed: true } : {}) } : {}) }))
}

function stoppedKey(rows: StoppedRow[], query: string | undefined): StoppedRow {
  if (!query?.trim()) throw invalid('Name a stopped turn: its key from `foreman stopped list` (a turn id, or checks:<workspace id>).')
  const q = query.trim().toLowerCase()
  const exact = rows.find((r) => r.key.toLowerCase() === q)
  if (exact) return exact
  const starts = q.length >= 4 ? rows.filter((r) => r.key.toLowerCase().startsWith(q)) : []
  if (starts.length > 1) throw ambiguous(`“${query}” matches several stopped turns. Pass more of the key.`)
  if (!starts.length) throw notFound(`No stopped turn “${query}”. \`foreman stopped list\` shows them.`)
  return starts[0]
}

async function stopped(host: CliHost, params: unknown, ctx: CliContext): Promise<StoppedResult> {
  const p = paramsObject(params as StoppedParams)
  const verb = (textParam(p, 'verb', { optional: true }) ?? 'list') as StoppedParams['verb']
  if (verb !== 'list' && verb !== 'retry' && verb !== 'dismiss') throw invalid(`“${verb}” isn’t a stopped command. Use list, retry or dismiss.`)
  const rows = await stoppedRows(host)
  if (verb === 'list') return { verb, rows, text: stoppedText(rows) }
  if (verb === 'retry') {
    // Retry sends the turn's message again in its tab: it starts a turn.
    const refusal = startRefusal(host, ctx.caller)
    if (refusal) throw refused(refusal)
    const row = stoppedKey(rows, textParam(p, 'key', { optional: true }))
    if (row.kind !== 'turn') throw invalid('Only a stopped turn can be retried; dismiss a stopped check run, or run the checks again.')
    await host.api.retryStopped(row.key)
    return { verb, rows: rows.filter((r) => r.key !== row.key), text: `Sent “${clip(row.message ?? '', 50)}” again in ${row.workspace}${row.title ? ` (${row.title})` : ''}.` }
  }
  if (flagParam(p, 'all')) {
    await host.api.dismissStopped()
    return { verb, rows: [], text: `Dismissed ${rows.length === 1 ? '1 stopped entry' : `${rows.length} stopped entries`}. Nothing was retried.` }
  }
  const row = stoppedKey(rows, textParam(p, 'key', { optional: true }))
  await host.api.dismissStopped(row.key)
  return { verb, rows: rows.filter((r) => r.key !== row.key), text: `Dismissed the stopped ${row.kind} in ${row.workspace}. Nothing was retried.` }
}

export const APPROVAL_METHODS: Record<string, MethodDef> = {
  approvals: { tier: 'read', handle: async (host) => approvals(host) },
  approve: { tier: 'admin', handle: async (host, params) => approve(host, params) },
  deny: { tier: 'admin', handle: async (host, params) => deny(host, params) },
  stopped: { tier: 'act', handle: async (host, params, ctx) => stopped(host, params, ctx) }
}
