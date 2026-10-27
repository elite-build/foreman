// The chat-tab commands: tabs, tab new|set|close|reopen|fork, chat, queue,
// rewind, resume-now, mcp, slash and search. Each is the operation the window performs, called through the same Api.
// Tabs are counted from 1 among a workspace's open tabs, as `foreman send --tab` does.
import { AGENTS, defaultModel, modelInfo, modelsFor, type AgentKind, type EffortLevel } from '../../shared/agents'
import { chatItemsOut, afterTurn, findTurn, lastTurns, renderChat, type ChatParams, type ChatResult, type McpParams, type McpResult, type QueueParams, type QueueResult, type QueueRow, type QueueVerb, type ResumeNowResult, type RewindParams, type RewindResult, type SearchHitRow, type SearchParams, type SearchResult, type SlashResult, type TabChangeResult, type TabForkParams, type TabReopenParams, type TabRow, type TabsResult } from '../../shared/cli/tabs'
import { tabModelText } from '../../shared/tabs'
import type { Session, SessionPatch, Workspace } from '../../shared/types'
import { CliCodedError, type CliHost } from './host'
import { columns, flagParam, invalid, numberParam, paramsObject, textParam, type MethodDef } from './kit'
import type { CliContext } from './methods'
import { startRefusal } from './policy'
import { ambiguous, notFound, plural, refused } from './refs'
import { findTab, findWorkspace } from './resolve'

const cwdOf = (p: Record<string, unknown>): string => textParam(p, 'cwd', { optional: true }) ?? process.cwd()

/** The workspace the command names. */
function workspaceOf(host: CliHost, p: Record<string, unknown>): Workspace {
  return findWorkspace(host.state(), textParam(p, 'workspace'), cwdOf(p))
}

/** The one open tab the command names (`tab`, counting from 1; the only tab when there is just one). */
function tabOf(host: CliHost, p: Record<string, unknown>): { ws: Workspace; tab: number; session: Session } {
  const ws = workspaceOf(host, p)
  const { tab, session } = findTab(host.state().sessions, ws, numberParam(p, 'tab'))
  return { ws, tab, session }
}

const wsOut = (ws: Workspace) => ({ id: ws.id, name: ws.name })

/** A tab as one row of `foreman tabs`. */
export function tabRow(s: Session, tab?: number): TabRow {
  const last = s.lastTurn
  return {
    ...(tab ? { tab } : {}),
    id: s.id,
    title: s.title || 'New chat',
    agent: s.agent,
    model: s.model,
    modelText: tabModelText(s),
    ...(s.effort ? { effort: s.effort } : {}),
    fast: s.fastMode,
    plan: s.planMode,
    ...(s.autoAcceptEdits ? { autoAcceptEdits: true } : {}),
    status: s.status === 'running' ? 'running' : s.waitingForSlot ? 'queued' : 'idle',
    queued: s.queue.length,
    ...(last ? { lastTurn: { outcome: last.outcome, ...(last.turnId ? { turn: last.turnId } : {}), endedAt: last.endedAt } } : {}),
    ...(s.closedAt ? { closed: true } : {})
  }
}

/** The rows for a workspace's tabs: the open ones with their positions, or (closed) the ones it can reopen, newest first. */
export function tabRows(sessions: Session[], ws: Workspace, closed = false): TabRow[] {
  const mine = sessions.filter((s) => s.workspaceId === ws.id)
  if (closed) return mine.filter((s) => s.closedAt).sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '')).map((s) => tabRow(s))
  return mine.filter((s) => !s.closedAt).map((s, i) => tabRow(s, i + 1))
}

const OUTCOME_WORD = { completed: 'completed', error: 'failed', cancelled: 'stopped', interrupted: 'interrupted' } as const

/** The table `foreman tabs` prints, and `ws show` includes. */
export function tabsText(rows: TabRow[]): string {
  if (!rows.length) return 'No tabs.'
  const head = rows.some((r) => r.closed) ? ['ID', 'TITLE', 'MODEL', 'EFFORT', 'FLAGS', 'STATUS', 'QUEUE', 'LAST TURN'] : ['TAB', 'TITLE', 'MODEL', 'EFFORT', 'FLAGS', 'STATUS', 'QUEUE', 'LAST TURN']
  const cells = rows.map((r) => [
    r.tab !== undefined ? String(r.tab) : r.id,
    r.title,
    r.modelText,
    r.effort ?? '',
    [r.fast ? 'fast' : '', r.plan ? 'plan' : '', r.autoAcceptEdits ? 'auto-accept' : ''].filter(Boolean).join(','),
    r.status,
    r.queued ? String(r.queued) : '',
    r.lastTurn ? OUTCOME_WORD[r.lastTurn.outcome] : ''
  ])
  return columns([head, ...cells]).join('\n')
}

/** Start refusals for the methods that send something to a chat: an agent turn needs the repository's opt-in. */
function refuseStart(host: CliHost, ctx: CliContext): void {
  const refusal = startRefusal(host, ctx.caller)
  if (refusal) throw refused(refusal)
}

const fromAgent = (ctx: CliContext): boolean => Boolean(ctx.caller?.token)

// ----- agents, models and efforts -----

function agentOf(text: string): AgentKind {
  const q = text.trim().toLowerCase()
  const kinds = Object.keys(AGENTS) as AgentKind[]
  const found = kinds.find((k) => k.toLowerCase() === q) ?? kinds.find((k) => AGENTS[k].label.toLowerCase() === q) ?? kinds.find((k) => AGENTS[k].label.split(/\s+/)[0].toLowerCase() === q)
  if (!found) throw invalid(`There is no agent “${text}”. Agents: ${kinds.join(', ')}`)
  return found
}

function modelOf(agent: AgentKind, text: string): string {
  const q = text.trim().toLowerCase()
  const models = modelsFor(agent)
  const found = models.find((m) => m.id.toLowerCase() === q || m.aliases?.some((a) => a.toLowerCase() === q) || m.label.toLowerCase() === q)
  if (!found) throw invalid(`${AGENTS[agent].label} has no model “${text}”. Models: ${models.map((m) => m.id).join(', ') || 'none listed yet'}`)
  return found.id
}

const EFFORTS: EffortLevel[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

function effortOf(agent: AgentKind, model: string, text: string): EffortLevel {
  const q = text.trim().toLowerCase() as EffortLevel
  if (!EFFORTS.includes(q)) throw invalid(`“${text}” isn’t an effort. Efforts: ${EFFORTS.join(', ')}`)
  const info = modelInfo(agent, model)
  if (!info.efforts.length) throw invalid(`${info.label} has no adjustable effort.`)
  if (!info.efforts.includes(q)) throw invalid(`${info.label} takes effort ${info.efforts.join(', ')}, not “${text}”.`)
  return q
}

/** The patch the window would send for these words; a model or effort is checked against the agent's own list. */
function sessionPatch(patchIn: Record<string, unknown>, current?: Session): SessionPatch {
  const out: SessionPatch = {}
  const str = (name: string): string | undefined => {
    const v = patchIn[name]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string') throw invalid(`${name} must be text.`)
    return v
  }
  const flag = (name: string): boolean | undefined => {
    const v = patchIn[name]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'boolean') throw invalid(`${name} must be true or false.`)
    return v
  }
  const title = str('title')
  if (title !== undefined) out.title = title
  const agentText = str('agent')
  const agent = agentText !== undefined ? agentOf(agentText) : current?.agent
  if (agentText !== undefined) out.agent = agent
  const modelText = str('model')
  // A different agent without a model takes that agent's default, as the window's picker does.
  const switched = agent !== undefined && current !== undefined && agent !== current.agent
  if (modelText !== undefined) out.model = modelOf(agent ?? 'claude', modelText)
  else if (agentText !== undefined && (!current || switched)) out.model = defaultModel(agent!)
  const effort = str('effort')
  if (effort !== undefined) out.effort = effortOf(agent ?? 'claude', out.model ?? current?.model ?? defaultModel(agent ?? 'claude'), effort)
  const fast = flag('fast')
  if (fast !== undefined) out.fastMode = fast
  const plan = flag('plan')
  if (plan !== undefined) out.planMode = plan
  const auto = flag('autoAcceptEdits')
  if (auto !== undefined) out.autoAcceptEdits = auto
  const note = flag('includeNote')
  if (note !== undefined) out.includeNote = note
  return out
}

// ----- tabs and tab verbs -----

async function tabs(host: CliHost, params: unknown): Promise<TabsResult> {
  const p = paramsObject(params)
  const ws = workspaceOf(host, p)
  const rows = tabRows(host.state().sessions, ws, flagParam(p, 'closed'))
  return { workspace: wsOut(ws), tabs: rows, text: tabsText(rows) }
}

async function tabNew(host: CliHost, params: unknown): Promise<TabChangeResult> {
  const p = paramsObject(params)
  const ws = workspaceOf(host, p)
  const patch = sessionPatch(p)
  const created = await host.api.createSession(ws.id, Object.keys(patch).length ? patch : undefined)
  const open = host.state().sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)
  const tab = open.findIndex((s) => s.id === created.id) + 1
  const row = tabRow(created, tab || undefined)
  return { workspace: wsOut(ws), tab: row, text: `Opened ${tab ? `tab ${tab}` : 'a new tab'} in ${ws.name} (${row.modelText}). It has no message yet; \`foreman send ${ws.name}${tab ? ` --tab ${tab}` : ''} "…"\` starts one.` }
}

/** The words of a `tab set` that widen what an agent may do without asking; they are the user's to change. */
const WIDENING = ['plan', 'autoAcceptEdits'] as const

async function tabSet(host: CliHost, params: unknown, ctx: CliContext): Promise<TabChangeResult> {
  const p = paramsObject(params)
  const raw = p.patch
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Say what to change: tab set needs a patch.')
  const patchIn = raw as Record<string, unknown>
  if (fromAgent(ctx)) {
    const widened = WIDENING.filter((k) => patchIn[k] !== undefined)
    if (widened.length) throw refused('Plan mode and auto-accept edits can’t be changed from inside an agent turn.')
  }
  const { ws, tab, session } = tabOf(host, p)
  const patch = sessionPatch(patchIn, session)
  if (!Object.keys(patch).length) throw invalid('Nothing to change. Give --title, --agent, --model, --effort, --fast, --plan, --auto-accept-edits or --include-note.')
  await host.api.updateSession(session.id, patch)
  const now = host.state().sessions.find((s) => s.id === session.id) ?? session
  const row = tabRow(now, tab)
  const changed = Object.keys(patchIn).filter((k) => patchIn[k] !== undefined)
  return { workspace: wsOut(ws), tab: row, text: `Changed tab ${tab} of ${ws.name} (${changed.join(', ')}): ${row.title}, ${row.modelText}${row.effort ? `, ${row.effort}` : ''}${row.fast ? ', fast' : ''}${row.plan ? ', plan mode' : ''}` }
}

async function tabClose(host: CliHost, params: unknown): Promise<TabChangeResult> {
  const { ws, tab, session } = tabOf(host, paramsObject(params))
  await host.api.closeSession(session.id)
  return { workspace: wsOut(ws), tab: tabRow({ ...session, closedAt: new Date().toISOString() }), text: `Closed tab ${tab} of ${ws.name} (${session.title || 'New chat'}). \`foreman tab reopen ${ws.name} --tab ${session.id}\` brings it back.` }
}

async function tabReopen(host: CliHost, params: unknown): Promise<TabChangeResult> {
  const p = paramsObject(params as TabReopenParams)
  const ws = workspaceOf(host, p)
  const closed = host.state().sessions.filter((s) => s.workspaceId === ws.id && s.closedAt)
  const query = textParam(p, 'id', { optional: true })
  let target: Session | undefined
  if (query) {
    const q = query.trim().toLowerCase()
    const matches = closed.filter((s) => s.id.toLowerCase() === q || (q.length >= 4 && s.id.toLowerCase().startsWith(q)))
    if (matches.length > 1) throw ambiguous(`“${query}” matches several closed tabs. Pass more of the id.`)
    target = matches[0]
    if (!target) throw notFound(`${ws.name} has no closed tab “${query}”.${closed.length ? ` Closed tabs: ${closed.map((s) => s.id).join(', ')}` : ' It has no closed tabs.'}`)
  } else if (!closed.length) throw notFound(`${ws.name} has no closed tabs.`)
  const reopened = await host.api.reopenSession(ws.id, target?.id)
  if (!reopened) throw new CliCodedError('failed', `Couldn’t reopen a tab in ${ws.name}.`)
  const open = host.state().sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)
  const tab = open.findIndex((s) => s.id === reopened.id) + 1
  return { workspace: wsOut(ws), tab: tabRow(reopened, tab || undefined), text: `Reopened ${reopened.title || 'New chat'} as tab ${tab || '?'} of ${ws.name}.` }
}

async function tabFork(host: CliHost, params: unknown): Promise<TabChangeResult> {
  const p = paramsObject(params as TabForkParams)
  const { ws, tab, session } = tabOf(host, p)
  const turnQuery = textParam(p, 'turn', { optional: true })
  let turn: string | undefined
  if (turnQuery) {
    turn = findTurn(await host.api.getChat(session.id), turnQuery)
    if (!turn) throw notFound(`Tab ${tab} of ${ws.name} has no turn “${turnQuery}”. \`foreman chat ${ws.name} --tab ${tab}\` shows the turn ids.`)
  }
  const before = flagParam(p, 'before')
  if (before && !turn) throw invalid('--before needs --turn: it forks from just before that turn’s message.')
  const forked = await host.api.forkSession(session.id, turn, before ? { before: true } : undefined)
  const open = host.state().sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)
  const newTab = open.findIndex((s) => s.id === forked.id) + 1
  const from = turn ? `${before ? 'just before' : 'after'} turn ${turn}` : 'after its latest answer'
  return { workspace: wsOut(ws), tab: tabRow(forked, newTab || undefined), text: `Forked tab ${tab} of ${ws.name} ${from} into tab ${newTab || '?'} (${forked.title || 'New chat'}). It has no new message yet.` }
}

// ----- chat -----

async function chat(host: CliHost, params: unknown): Promise<ChatResult> {
  const p = paramsObject(params as ChatParams)
  const { ws, tab, session } = tabOf(host, p)
  const toolOutput = flagParam(p, 'toolOutput')
  let items = await host.api.getChat(session.id)
  const since = textParam(p, 'since', { optional: true })
  if (since) {
    const turn = findTurn(items, since)
    if (!turn) throw notFound(`Tab ${tab} of ${ws.name} has no turn “${since}”.`)
    items = afterTurn(items, turn)
  }
  const tail = numberParam(p, 'tail')
  if (tail !== undefined) {
    if (!Number.isInteger(tail) || tail < 1) throw invalid('tail must be a whole number of turns, from 1.')
    items = lastTurns(items, tail)
  }
  const text = renderChat(items, { toolOutput, agent: AGENTS[session.agent].label.split(/\s+/)[0] })
  return { workspace: wsOut(ws), tab, session: session.id, items: chatItemsOut(items, toolOutput), text: text || `Nothing in tab ${tab} of ${ws.name}${since ? ' since that turn' : ''} yet.` }
}

// ----- queue -----

const QUEUE_VERBS: QueueVerb[] = ['list', 'remove', 'steer', 'move', 'edit']

function queueRows(session: Session): QueueRow[] {
  return session.queue.map((m, i) => ({ position: i + 1, id: m.id, ...(m.turnId ? { turn: m.turnId } : {}), text: m.text, attachments: m.attachments.length }))
}

function queueText(rows: QueueRow[], empty: string): string {
  if (!rows.length) return empty
  return columns(rows.map((r) => [String(r.position), r.id.slice(0, 8), r.text.replace(/\s+/g, ' ').slice(0, 70) + (r.text.length > 70 ? '…' : '') + (r.attachments ? ` (+${plural(r.attachments, 'file')})` : '')])).join('\n')
}

function queued(session: Session, query: string | undefined, where: string) {
  if (!query?.trim()) throw invalid('Name a queued message: its position from 1, or its id from `foreman queue <ws> list`.')
  const q = query.trim()
  const queue = session.queue
  if (/^\d+$/.test(q) && !queue.some((m) => m.id === q || m.turnId === q)) {
    const m = queue[Number(q) - 1]
    if (!m) throw notFound(`${where} has no queued message ${q}.${queue.length ? ` It has ${plural(queue.length, 'queued message')}.` : ' Its queue is empty.'}`)
    return m
  }
  const lower = q.toLowerCase()
  const exact = queue.find((m) => m.id === q || m.turnId === q)
  if (exact) return exact
  const starts = lower.length >= 4 ? queue.filter((m) => m.id.toLowerCase().startsWith(lower) || m.turnId?.toLowerCase().startsWith(lower)) : []
  if (starts.length > 1) throw ambiguous(`“${q}” matches several queued messages in ${where}. Pass more of the id or its position.`)
  if (!starts.length) throw notFound(`${where} has no queued message “${q}”.`)
  return starts[0]
}

async function queue(host: CliHost, params: unknown, ctx: CliContext): Promise<QueueResult> {
  const p = paramsObject(params as QueueParams)
  const verb = (textParam(p, 'verb', { optional: true }) ?? 'list') as QueueVerb
  if (!QUEUE_VERBS.includes(verb)) throw invalid(`“${verb}” isn’t a queue command. Use ${QUEUE_VERBS.join(', ')}.`)
  const { ws, tab, session } = tabOf(host, p)
  const where = `tab ${tab} of ${ws.name}`
  const base = { workspace: wsOut(ws), tab, verb }
  const current = () => host.state().sessions.find((s) => s.id === session.id) ?? session
  if (verb === 'list') {
    const rows = queueRows(session)
    return { ...base, queue: rows, text: queueText(rows, `Nothing is queued in ${where}.`) }
  }
  const message = queued(session, textParam(p, 'message', { optional: true }), where)
  const label = message.text.replace(/\s+/g, ' ').slice(0, 40)
  let text: string
  if (verb === 'remove') {
    await host.api.removeQueued(session.id, message.id)
    text = `Removed “${label}” from the queue of ${where}.`
  } else if (verb === 'steer') {
    // Steering delivers the message into the running turn: it sends something to a chat.
    refuseStart(host, ctx)
    await host.api.steerQueued(session.id, message.id)
    text = `Steered “${label}” into the running turn of ${where}.`
  } else {
    // An edit or move is checked against the queue as the caller saw it; the one the server sees now is the best a one-shot command has.
    const revision = session.queueRevision ?? 0
    let result
    if (verb === 'move') {
      const direction = textParam(p, 'direction', { optional: true })
      if (direction !== 'up' && direction !== 'down') throw invalid('Say which way: up (sent sooner) or down.')
      result = await host.api.moveQueued(session.id, message.id, direction, revision)
      text = `Moved “${label}” ${direction} in the queue of ${where}.`
    } else {
      const newText = textParam(p, 'text')
      if (!newText.trim()) throw invalid('Say what the message should read now.')
      result = await host.api.editQueued(session.id, message.id, newText, revision)
      text = `Edited the queued message in ${where}.`
    }
    if (!result.ok) {
      if (result.reason === 'stale') throw new CliCodedError('busy', `The queue of ${where} changed just now. Look again with \`foreman queue ${ws.name} --tab ${tab} list\`.`)
      if (result.reason === 'started') throw new CliCodedError('failed', `That message already started, so it can’t be changed.`)
      throw notFound('That message is no longer in the queue.')
    }
  }
  const rows = queueRows(current())
  return { ...base, queue: rows, text }
}

// ----- rewind, resume now -----

async function rewind(host: CliHost, params: unknown): Promise<RewindResult> {
  const p = paramsObject(params as RewindParams)
  const { ws, tab, session } = tabOf(host, p)
  const query = textParam(p, 'turn')
  const items = await host.api.getChat(session.id)
  const turn = findTurn(items, query)
  if (!turn) throw notFound(`Tab ${tab} of ${ws.name} has no turn “${query}”. \`foreman chat ${ws.name} --tab ${tab}\` shows the turn ids.`)
  const user = items.find((i) => i.kind === 'user' && i.turnId === turn)
  if (!user || user.kind !== 'user' || !user.checkpoint) throw invalid(`Turn ${turn} has no restore point, so there is nothing to rewind to.`)
  await host.api.restoreCheckpoint(session.id, turn)
  return { workspace: wsOut(ws), tab, turn, text: `Rewound tab ${tab} of ${ws.name} to before turn ${turn}: the files and the conversation are as they were then.` }
}

async function resumeNow(host: CliHost, params: unknown, ctx: CliContext): Promise<ResumeNowResult> {
  const { ws, tab, session } = tabOf(host, paramsObject(params))
  // Resume now sends the chat's message again: it starts a turn, so an agent needs the repository's opt-in.
  refuseStart(host, ctx)
  await host.api.resumeLimitNow(session.id)
  return { workspace: wsOut(ws), tab, session: session.id, text: `Resumed tab ${tab} of ${ws.name} now.` }
}

// ----- mcp, slash commands -----

async function mcp(host: CliHost, params: unknown): Promise<McpResult> {
  const p = paramsObject(params as McpParams)
  const verb = (textParam(p, 'verb', { optional: true }) ?? 'status') as McpParams['verb']
  if (verb !== 'status' && verb !== 'restart' && verb !== 'reconnect') throw invalid(`“${verb}” isn’t an mcp command. Use status, restart or reconnect.`)
  const { ws, tab, session } = tabOf(host, p)
  const where = `tab ${tab} of ${ws.name}`
  const base = { workspace: wsOut(ws), tab, verb }
  if (verb === 'reconnect') {
    const name = textParam(p, 'name', { optional: true })
    if (!name?.trim()) throw invalid('Name the server: `foreman mcp <ws> reconnect <name>`.')
    await host.api.reconnectMcpServer(session.id, name.trim())
    const after = await host.api.mcpStatus(session.id)
    return { ...base, supported: after.supported, servers: after.servers, text: `Asked ${where} to reconnect ${name.trim()}.\n${mcpText(after)}` }
  }
  const status = await host.api.mcpStatus(session.id, verb === 'restart')
  return { ...base, supported: status.supported, servers: status.servers, text: `${verb === 'restart' ? `Re-read the configuration of ${where}.\n` : ''}${mcpText(status)}` }
}

function mcpText(status: { supported: boolean; servers: { name: string; status: string; scope?: string; error?: string }[]; live: boolean; repoOnly?: { agent: string } }): string {
  if (!status.supported) return 'This tab’s agent can’t report MCP status.'
  if (!status.servers.length) return 'No MCP servers.'
  const lines = columns(status.servers.map((s) => [s.name, s.status, s.scope ?? '', s.error ?? '']))
  const note = status.repoOnly ? `\n${status.repoOnly.agent} reports no MCP status: these are the repository’s servers and what Foreman passed it.` : status.live ? '' : '\nNot from the running agent: a separate check.'
  return lines.join('\n') + note
}

async function slash(host: CliHost, params: unknown): Promise<SlashResult> {
  const { ws, tab, session } = tabOf(host, paramsObject(params))
  const commands = await host.api.slashCommands(session.id)
  const text = commands.length ? columns(commands.map((c) => [`/${c.name}`, c.kind ?? 'built-in', c.description])).join('\n') : 'No /commands.'
  return { workspace: wsOut(ws), tab, commands, text }
}

// ----- search -----

/** Snippets mark matches with control characters; a terminal gets brackets. */
const bracket = (snippet: string): string => snippet.replace(/\u0001/g, '[').replace(/\u0002/g, ']').replace(/\s+/g, ' ').trim()

async function search(host: CliHost, params: unknown): Promise<SearchResult> {
  const p = paramsObject(params as SearchParams)
  const query = textParam(p, 'query')
  if (!query.trim()) throw invalid('Say what to search for: foreman search "<words>".')
  const limit = numberParam(p, 'limit')
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw invalid('limit must be a whole number, from 1.')
  const hits: SearchHitRow[] = []
  const chats = await host.api.searchChats(query, { includeToolOutput: flagParam(p, 'toolOutput'), ...(limit !== undefined ? { limit } : {}) })
  for (const h of chats) {
    hits.push({ kind: 'chat', workspace: h.workspaceName, workspaceId: h.workspaceId, repo: h.repoName, tab: h.tabTitle, session: h.sessionId, item: h.itemId, itemKind: h.kind, at: h.at, archived: h.archived, snippet: bracket(h.snippet) })
  }
  if (flagParam(p, 'notes')) {
    const notes = await host.api.searchNotes(query)
    for (const n of notes.slice(0, limit ?? notes.length)) hits.push({ kind: 'note', workspace: n.workspaceName, workspaceId: n.workspaceId, repo: n.repoName, revision: n.revision, archived: n.archived, snippet: bracket(n.snippet) })
  }
  const text = hits.length
    ? hits
        .map((h) => {
          const where = h.kind === 'note' ? `${h.workspace} · note r${h.revision}` : `${h.workspace} · ${h.tab || 'New chat'} · ${h.itemKind}`
          return `${where} (${h.repo}${h.archived ? ', archived' : ''}${h.at ? `, ${h.at.slice(0, 10)}` : ''})\n  ${h.snippet}`
        })
        .join('\n')
    : `Nothing found for “${query}”.`
  return { query, hits, text }
}

export const TAB_METHODS: Record<string, MethodDef> = {
  tabs: { tier: 'read', handle: async (host, params) => tabs(host, params) },
  'tab-new': { tier: 'act', handle: async (host, params) => tabNew(host, params) },
  // Plan mode and auto-accept edits widen what an agent does without asking: the handler refuses them from an agent turn (PLAN.md §13 item 2).
  'tab-set': { tier: 'act', handle: async (host, params, ctx) => tabSet(host, params, ctx) },
  'tab-close': { tier: 'act', handle: async (host, params) => tabClose(host, params) },
  'tab-reopen': { tier: 'act', handle: async (host, params) => tabReopen(host, params) },
  'tab-fork': { tier: 'act', handle: async (host, params) => tabFork(host, params) },
  chat: { tier: 'read', handle: async (host, params) => chat(host, params) },
  queue: { tier: 'act', handle: async (host, params, ctx) => queue(host, params, ctx) },
  rewind: { tier: 'admin', handle: async (host, params) => rewind(host, params) },
  'resume-now': { tier: 'act', handle: async (host, params, ctx) => resumeNow(host, params, ctx) },
  mcp: { tier: 'act', handle: async (host, params) => mcp(host, params) },
  slash: { tier: 'read', handle: async (host, params) => slash(host, params) },
  search: { tier: 'read', handle: async (host, params) => search(host, params) }
}
