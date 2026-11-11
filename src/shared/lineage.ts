// A workspace's lineage (docs/loops-and-graphs.md, "Recovering graphs from what happened"): the four lenses of a flow,
// drawn for work done by hand from the records every workspace keeps. Run: each chat turn, check run and CI run, with
// the edges between them (forked from, handed off, findings sent, compare sibling, auto-fix, delegated by, a flow run's
// step, checks after a turn, a scheduled run). Context: what Foreman added to each turn and how full the window was.
// Memory: the note revisions seen, standing instructions, memory files read and written, reports and personas. Data:
// the base branch, each turn's start and end trees with "moved", the compare checkpoint and the pull request.
//
// Every edge says whether a record says so (`recorded`, naming the field) or it was inferred from a message's words or
// from timing (`reconstructed`, drawn dashed, with the record it `needs`). The graph has flowGraph's shape, so
// flowMermaid draws it; lineageOutline is its accessible list, and draftFlowFromLineage turns it into a flow file to
// edit. Pure: the caller reads the records (bounded: the workspace's chats and one hop of linked ones).
import { FLOW_DONE, type FlowRun } from './flows'
import { modelWords, stateText, type FlowGraph, type FlowGraphEdge, type FlowGraphNode, type FlowLens, type FlowNodeState } from './flowGraph'
import { CONTINUE_MESSAGE, REVIEW_MESSAGE, SECOND_OPINION_MESSAGE } from './handOff'
import { createT, type Locale, type PlainKey, type TFunction } from './i18n'
import { formatCompact } from './i18n/time'
import { memoryLabel } from './memoryPaths'
import type { ChatItem, ContextPart, HandOffKind, Session, TurnOutcome, Workspace } from './types'

const enT = createT('en')

export type LineageLens = FlowLens
export const LINEAGE_LENSES: readonly LineageLens[] = ['run', 'context', 'memory', 'data']

/**
 * The records the lenses read that older history lacks (docs/loops-and-graphs.md, "What isn't recorded yet"). A
 * graph lists the ones its workspace's history is missing; an outline entry says `needs: <gap>` where it is.
 */
export const LINEAGE_GAPS = ['Session.handedOffFrom', 'Workspace.startedBy', 'MessageOrigin', 'turn-end.usage', 'turn-end.memoryWrites', 'turn-end.tree', 'WorkspaceChecks.startedBy'] as const
export type LineageGap = (typeof LINEAGE_GAPS)[number]

/** What a node stands for, so the outline can open it: a chat's turn, the workspace's checks, or its pull request. */
export type LineageRef = { kind: 'turn'; workspaceId: string; sessionId: string; turnId: string } | { kind: 'checks'; workspaceId: string } | { kind: 'pr'; workspaceId: string; url?: string }

/** What "Make a flow from this…" needs to know of a node in the workspace itself. */
export interface LineageDraftInfo {
  role: 'turn' | 'review' | 'address' | 'ci-fix' | 'checks' | 'pr'
  at: string
  sessionId?: string
  // The template the message came from (its name, or the id when the name isn't known).
  template?: string
  // A review: who reviewed (agent and model), and for an address step, the review node whose findings it was sent.
  reviewer?: { agent: string; model: string }
  reviewNode?: string
  // An auto-fix turn: its count ("1 of 2").
  fix?: { n: number; of: number }
  // A turn that came from a second opinion or continue, drawn as a plain turn.
  handOff?: HandOffKind
}

export interface LineageNode extends FlowGraphNode {
  ref?: LineageRef
  // The records this node is drawn from, and the ones it would need to be drawn from records alone.
  recorded?: string[]
  needs?: LineageGap[]
  // When it happened (a turn's message, a check run's start), for the outline's order.
  at?: string
  draft?: LineageDraftInfo
}

export interface LineageEdge extends FlowGraphEdge {
  // The field a record says this with; absent when reconstructed.
  recorded?: string
  // The record that would make a reconstructed edge a recorded one.
  needs?: LineageGap
}

export interface LineageGraph extends FlowGraph {
  workspace: { id: string; name: string }
  nodes: LineageNode[]
  edges: LineageEdge[]
  // The records this workspace's history lacks, in LINEAGE_GAPS order.
  gaps: LineageGap[]
  // What drafting a flow leaves out, counted (filled for the run lens).
  leftOut: LineageLeftOut[]
}

export const LEFT_OUT_KINDS = ['fork', 'compareSibling', 'delegation', 'scheduled', 'otherChat', 'reviewFollowUp', 'limitResume', 'handOffAsTurn', 'templateUnknown'] as const
export type LeftOutKind = (typeof LEFT_OUT_KINDS)[number]
export interface LineageLeftOut {
  kind: LeftOutKind
  count: number
}

export interface LineageInput {
  workspace: Workspace
  // The workspace's chats and the ones they link to (forkedFrom, handedOffFrom, compare siblings, startedBy, origins).
  sessions: Session[]
  // Each chat's items (user, turn-end and result are enough), bounded by the caller.
  chats: Map<string, ChatItem[]>
  // Other workspaces it names: compare siblings and the coordinator's, for their names.
  workspaces?: Workspace[]
  flowRun?: FlowRun
  // Defaults: the workspace's own.
  checks?: Workspace['checks']
  prInfo?: Workspace['prInfo']
  // Template id → name, for the draft's `template =`.
  templateNames?: Record<string, string>
}

export interface LineageOptions {
  t?: TFunction
  locale?: Locale
}

/** One line of the outline: a node, what links it, and whether a record says so. */
export interface LineageOutlineEntry {
  id: string
  label: string
  sublabel?: string
  ref?: LineageRef
  at?: string
  recorded: string[]
  needs: LineageGap[]
  // "recorded: <field>" and "needs: <gap>", for a terminal.
  tags: string[]
  edges: { direction: 'from' | 'to'; other: string; label?: string; recorded?: string; reconstructed?: boolean }[]
}

export interface LineageFlowDraft {
  toml: string
  leftOut: LineageLeftOut[]
}

/** What the Lineage tab shows for one lens (Api.workspaceLineage). */
export interface WorkspaceLineage {
  graph: LineageGraph
  outline: LineageOutlineEntry[]
  mermaid: string
  gaps: LineageGap[]
}

type UserItem = Extract<ChatItem, { kind: 'user' }>
type EndItem = Extract<ChatItem, { kind: 'turn-end' }>

interface Turn {
  id: string
  session: Session
  n: number
  user: UserItem
  end?: EndItem
  at: string
  endAt?: string
  // A chat's first turn that came from a hand-off (recorded, or told by its words).
  handOff?: HandOffKind
}

const OUTCOME_STATE: Record<TurnOutcome, FlowNodeState> = { completed: 'completed', error: 'failed', cancelled: 'stopped', interrupted: 'stopped' }
// A message Foreman's "Send to worker…" builds from an auto review's findings (shared/autoReview.ts findingsMessage).
const FINDINGS_PREFIX = 'An auto review ('
const short = (hash: string) => hash.slice(0, 7)
const time = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN)
const turnId = (sessionId: string, turn: string) => `turn:${sessionId}:${turn}`

/** A turn-end from before this slice kept the lenses' records: it has none of them. */
const oldEnd = (end: EndItem | undefined) => Boolean(end && end.usage === undefined && end.tree === undefined && end.memoryWrites === undefined)

const HANDOFF_WORD: Record<HandOffKind, PlainKey> = { 'second-opinion': 'lineage.handOff.secondOpinion', review: 'lineage.handOff.review', continue: 'lineage.handOff.continue' }
const CI_WORD = { passed: 'lineage.ci.passed', failing: 'lineage.ci.failing', pending: 'lineage.ci.pending' } as const
const SIZE_WORD = { chars: 'lineage.size.chars', bytes: 'lineage.size.bytes', servers: 'lineage.size.servers', accounts: 'lineage.size.accounts' } as const
const LEFT_OUT_WORD = {
  fork: 'lineage.leftOut.fork',
  compareSibling: 'lineage.leftOut.compareSibling',
  delegation: 'lineage.leftOut.delegation',
  scheduled: 'lineage.leftOut.scheduled',
  otherChat: 'lineage.leftOut.otherChat',
  reviewFollowUp: 'lineage.leftOut.reviewFollowUp',
  limitResume: 'lineage.leftOut.limitResume',
  handOffAsTurn: 'lineage.leftOut.handOffAsTurn',
  templateUnknown: 'lineage.leftOut.templateUnknown'
} as const satisfies Record<LeftOutKind, string>

/** A left-out kind in words, counted: the draft's comment (English) and the dialog's list (the app's language). */
export function leftOutText(item: LineageLeftOut, t: TFunction = enT): string {
  return t(LEFT_OUT_WORD[item.kind], { count: item.count })
}

/** The graph a lens draws over a workspace's history. */
export function lineageGraph(input: LineageInput, lens: LineageLens, options: LineageOptions = {}): LineageGraph {
  const t = options.t ?? enT
  const locale = options.locale ?? 'en'
  const compact = (n: number) => formatCompact(n, locale)
  const ws = input.workspace
  const checks = input.checks ?? ws.checks
  const prInfo = input.prInfo ?? ws.prInfo
  const nodes: LineageNode[] = []
  const edges: LineageEdge[] = []
  const gaps = new Set<LineageGap>()
  const leftOut = new Map<LeftOutKind, number>()
  const omit = (kind: LeftOutKind) => leftOut.set(kind, (leftOut.get(kind) ?? 0) + 1)
  const node = (n: LineageNode): LineageNode => {
    const known = nodes.find((x) => x.id === n.id)
    if (known) return known
    nodes.push(n)
    return n
  }
  const edge = (e: LineageEdge) => {
    if (!nodes.some((n) => n.id === e.from) || !nodes.some((n) => n.id === e.to)) return
    if (edges.some((x) => x.from === e.from && x.to === e.to && x.kind === e.kind && x.label === e.label)) return
    if (e.reconstructed && e.needs) gaps.add(e.needs)
    edges.push(e)
  }
  const needs = (n: LineageNode, gap: LineageGap) => {
    gaps.add(gap)
    if (!n.needs?.includes(gap)) n.needs = [...(n.needs ?? []), gap]
  }
  const recorded = (n: LineageNode, field: string) => {
    if (!n.recorded?.includes(field)) n.recorded = [...(n.recorded ?? []), field]
  }
  const wsName = (id: string) => (id === ws.id ? ws.name : (input.workspaces?.find((w) => w.id === id)?.name ?? id.slice(0, 8)))
  const sessionOf = (id: string) => input.sessions.find((s) => s.id === id)

  // ---- the turns: every one of this workspace's chats, and only the linked turn of another workspace's ----
  const turns = new Map<string, Turn[]>()
  const turnsOf = (session: Session): Turn[] => {
    const known = turns.get(session.id)
    if (known) return known
    const items = input.chats.get(session.id) ?? []
    const ends = new Map<string, EndItem>()
    for (const i of items) if (i.kind === 'turn-end') ends.set(i.turnId, i)
    const list: Turn[] = []
    for (const i of items) {
      if (i.kind !== 'user' || i.steered || list.some((x) => x.user.turnId === i.turnId)) continue
      const end = ends.get(i.turnId)
      const endAt = end?.durationMs !== undefined && Number.isFinite(time(i.at)) ? new Date(time(i.at) + end.durationMs).toISOString() : undefined
      list.push({ id: turnId(session.id, i.turnId), session, n: list.length + 1, user: i, end, at: i.at, ...(endAt ? { endAt } : {}) })
    }
    turns.set(session.id, list)
    return list
  }
  const title = (session: Session) => {
    const name = session.title?.trim() || t('workspaceView.tab.newChat')
    return session.workspaceId === ws.id ? name : `${wsName(session.workspaceId)} / ${name}`
  }
  const turnNode = (turn: Turn): LineageNode => {
    const lines: string[] = []
    const model = turn.user.model ?? turn.session.model
    const state: FlowNodeState | undefined = turn.end ? OUTCOME_STATE[turn.end.outcome] : turn.session.turnId === turn.user.turnId ? 'running' : undefined
    const delta = turn.end?.delta
    lines.push([model ? `· ${modelWords(model)}` : undefined, state ? stateText(state, t) : undefined, delta ? t('flowRun.panel.delta', { count: delta.files.length, additions: delta.additions, deletions: delta.deletions }) : undefined].filter(Boolean).join(' · '))
    const usage = turn.end?.usage
    if (lens === 'context' && usage) lines.push(t('flowGraph.usage', { used: compact(usage.used), limit: compact(usage.limit) }))
    if (lens === 'data' && turn.end?.tree) lines.push(`${turn.end.tree.start ? short(turn.end.tree.start) : '?'} → ${turn.end.tree.end ? short(turn.end.tree.end) : '?'}`)
    const reviewer = Boolean(turn.session.autoReview || turn.session.handedOffFrom?.kind === 'review' || turn.session.readOnly)
    const n = node({
      id: turn.id,
      kind: 'step',
      stepKind: reviewer ? 'review' : 'turn',
      label: t('lineage.node.turn', { chat: title(turn.session), n: turn.n }),
      ...(lines.filter(Boolean).length ? { sublabel: lines.filter(Boolean).join('\n') } : {}),
      ...(state ? { state } : {}),
      ...(model ? { model } : {}),
      loops: [],
      ...(usage && usage.limit > 0 ? { usage: { used: usage.used, limit: usage.limit } } : {}),
      ref: { kind: 'turn', workspaceId: turn.session.workspaceId, sessionId: turn.session.id, turnId: turn.user.turnId },
      at: turn.at
    })
    recorded(n, 'ChatItem.turnId')
    return n
  }
  /** The turn of another chat an edge comes from: the one named, else its last one before `before`. */
  const linkedTurn = (sessionId: string, named?: string, before?: string): Turn | undefined => {
    const session = sessionOf(sessionId)
    if (!session) return undefined
    const list = turnsOf(session)
    if (named) return list.find((x) => x.user.turnId === named)
    const limit = time(before)
    const earlier = Number.isFinite(limit) ? list.filter((x) => time(x.endAt ?? x.at) <= limit) : list
    return earlier.at(-1)
  }
  /** A chat elsewhere that started or sent something, drawn from its turn when it was read, else as a placeholder. */
  const sourceNode = (sessionId: string, named: string | undefined, before: string | undefined, assistant = false): LineageNode => {
    const turn = assistant ? undefined : linkedTurn(sessionId, named, before)
    if (turn) return turnNode(turn)
    return node({ id: `chat:${sessionId}`, kind: 'source', label: assistant ? t('lineage.node.assistant') : t('lineage.node.chatElsewhere'), loops: [] })
  }
  /** An outside agent signed in to Foreman (docs/agent-access.md §7): one node per sign-in, named as it called itself. */
  const outsideNode = (grantId: string, name: string): LineageNode => node({ id: `outside:${grantId}`, kind: 'source', label: t('lineage.node.outside', { name }), loops: [] })

  const own = input.sessions.filter((s) => s.workspaceId === ws.id)
  const ownTurns = own.flatMap(turnsOf).sort((a, b) => time(a.at) - time(b.at))
  for (const turn of ownTurns) turnNode(turn)
  const firstTurn = ownTurns[0]

  // ---- per turn, per lens ----
  for (const session of own) {
    const list = turnsOf(session)
    list.forEach((turn, i) => {
      const n = turnNode(turn)
      const prev = list[i - 1]
      const origin = turn.user.origin
      if (lens === 'run' && prev) {
        // The next message in the same chat; a resume after a usage limit says so.
        const resumed = origin?.kind === 'limit-resume'
        edge({ from: prev.id, to: turn.id, kind: 'fact', ...(resumed ? { label: t('lineage.edge.limitResume') } : {}), recorded: resumed ? 'MessageOrigin' : 'ChatItem.turnId' })
      }
      if (lens === 'context') contextOf(turn, n)
      if (lens === 'memory') memoryOf(turn, n)
      if (lens === 'data' && oldEnd(turn.end)) needs(n, 'turn-end.tree')
      if (lens === 'context' && oldEnd(turn.end)) needs(n, 'turn-end.usage')
      if (lens === 'memory' && oldEnd(turn.end)) needs(n, 'turn-end.memoryWrites')
    })
  }

  if (lens === 'run') runEdges()
  else if (lens === 'context') handOffSections()
  else if (lens === 'memory') memoryNodes()
  else dataEdges()

  // The gaps a history from before this slice has, whatever the lens.
  if (ownTurns.some((x) => oldEnd(x.end))) for (const gap of ['turn-end.usage', 'turn-end.memoryWrites', 'turn-end.tree'] as const) gaps.add(gap)
  if (checks?.results.length && !checks.startedBy) gaps.add('WorkspaceChecks.startedBy')

  return {
    lens,
    title: t('lineage.title', { workspace: ws.name, lens: t(`flowGraph.lens.${lens}` as PlainKey) }),
    workspace: { id: ws.id, name: ws.name },
    nodes,
    edges,
    loops: [],
    gaps: LINEAGE_GAPS.filter((g) => gaps.has(g)),
    leftOut: LEFT_OUT_KINDS.filter((k) => leftOut.has(k)).map((kind) => ({ kind, count: leftOut.get(kind)! }))
  }

  // ---- run ----
  function runEdges(): void {
    // Forks and hand-offs, recorded on the new chat; a hand-off from before it was kept, from the first message's words.
    for (const session of own) {
      const first = turnsOf(session)[0]
      if (!first) continue
      const target = turnNode(first)
      if (session.forkedFrom) {
        const from = sourceNode(session.forkedFrom.sessionId, session.forkedFrom.turnId, first.at)
        edge({ from: from.id, to: target.id, kind: 'fact', label: t('lineage.edge.forkedFrom'), recorded: 'Session.forkedFrom' })
        omit('fork')
      }
      const handed = session.handedOffFrom
      if (handed) {
        const from = sourceNode(handed.sessionId, handed.turnId, first.at)
        edge({ from: from.id, to: target.id, kind: 'fact', label: t('lineage.edge.handedOff', { kind: t(HANDOFF_WORD[handed.kind]) }), recorded: 'Session.handedOffFrom' })
        first.handOff = handed.kind
      } else {
        const kind = guessedHandOff(session, first)
        if (kind) {
          const from = own
            .filter((s) => s.id !== session.id)
            .flatMap(turnsOf)
            .filter((x) => time(x.endAt ?? x.at) <= time(first.at))
            .sort((a, b) => time(a.endAt ?? a.at) - time(b.endAt ?? b.at))
            .at(-1)
          if (from) {
            edge({ from: turnNode(from).id, to: target.id, kind: 'fact', label: t('lineage.edge.handedOff', { kind: t(HANDOFF_WORD[kind]) }), reconstructed: true, needs: 'Session.handedOffFrom' })
            needs(target, 'Session.handedOffFrom')
          }
          first.handOff = kind
        }
      }
      // An auto review's reviewer tab: started by the worker's turn, as the review records.
      const review = session.autoReview ? ws.autoReviews?.find((r) => r.id === session.autoReview!.reviewId) : undefined
      if (review) {
        const from = linkedTurn(review.workerSessionId, review.workerTurnId)
        if (from) edge({ from: turnNode(from).id, to: target.id, kind: 'fact', label: t('lineage.edge.autoReview'), recorded: 'AutoReview.workerTurnId' })
      }
    }

    for (const turn of ownTurns) {
      const target = turnNode(turn)
      const origin = turn.user.origin
      // Findings an auto review found, sent back with "Send to worker…": told by the message's words.
      if (!origin && turn.user.text.startsWith(FINDINGS_PREFIX)) {
        const review = ws.autoReviews?.find((r) => r.reviewerSessionId && turn.user.text.includes(`at tree ${short(r.tree)}`)) ?? ws.autoReviews?.filter((r) => r.reviewerSessionId && time(r.startedAt) <= time(turn.at)).at(-1)
        const from = review?.reviewerSessionId ? linkedTurn(review.reviewerSessionId, review.turnId) ?? linkedTurn(review.reviewerSessionId, undefined, turn.at) : undefined
        if (from) {
          const reviewer = turnNode(from)
          edge({ from: reviewer.id, to: target.id, kind: 'fact', label: t('lineage.edge.findingsSent'), reconstructed: true, needs: 'MessageOrigin' })
          needs(target, 'MessageOrigin')
          target.draft = { role: 'address', at: turn.at, sessionId: turn.session.id, reviewNode: reviewer.id }
        }
      }
      if (origin?.kind === 'auto-fix') {
        const ci = node({ id: `ci:${origin.sha}:${origin.n}`, kind: 'step', stepKind: 'wait', label: t('lineage.node.ciFailed', { sha: short(origin.sha) }), sublabel: origin.checks.slice(0, 3).join(', ') + (origin.checks.length > 3 ? ` +${origin.checks.length - 3}` : ''), loops: [], at: turn.at })
        recorded(ci, 'MessageOrigin')
        edge({ from: ci.id, to: target.id, kind: 'fact', label: t('lineage.edge.autoFix', { n: origin.n, of: origin.of }), recorded: 'MessageOrigin' })
        if (prInfo) edge({ from: prNode().id, to: ci.id, kind: 'fact', label: t('lineage.edge.ci'), recorded: 'Workspace.prInfo' })
      }
      if (origin?.kind === 'delegation') {
        const from = sourceNode(origin.sessionId, origin.turnId, turn.at)
        edge({ from: from.id, to: target.id, kind: 'fact', label: t('lineage.edge.delegatedBy'), recorded: 'MessageOrigin' })
      }
      if (origin?.kind === 'outside') edge({ from: outsideNode(origin.grantId, origin.name).id, to: target.id, kind: 'fact', label: t('lineage.edge.sentBy'), recorded: 'MessageOrigin' })
      if (origin?.kind === 'flow') flowEdge(origin.runId, origin.step, origin.iteration, target, 'MessageOrigin')
      if (origin?.kind === 'schedule') scheduleEdge(target, 'MessageOrigin')
      if (origin?.kind === 'limit-resume') omit('limitResume')
    }

    // The flow run this workspace belongs to: its steps' tabs and turns, when a message didn't say.
    const run = input.flowRun
    if (run)
      for (const step of run.steps) {
        if (!step.sessionId || !step.turnId) continue
        const turn = sessionOf(step.sessionId) && turnsOf(sessionOf(step.sessionId)!).find((x) => x.user.turnId === step.turnId)
        if (turn && !turn.user.origin) flowEdge(run.id, step.name, step.iteration, turnNode(turn), 'FlowRun.steps')
      }

    // Who started the workspace: another chat (delegation, `foreman` from a turn), the assistant, or an outside agent.
    if (ws.startedBy?.via === 'outside' && firstTurn) {
      edge({ from: outsideNode(ws.startedBy.grantId, ws.startedBy.name).id, to: turnNode(firstTurn).id, kind: 'fact', label: t('lineage.edge.startedBy'), recorded: 'Workspace.startedBy' })
    } else if (ws.startedBy && ws.startedBy.via !== 'outside' && firstTurn) {
      const from = sourceNode(ws.startedBy.sessionId, ws.startedBy.turnId, firstTurn.at, ws.startedBy.via === 'assistant')
      edge({ from: from.id, to: turnNode(firstTurn).id, kind: 'fact', label: t('lineage.edge.delegatedBy'), recorded: 'Workspace.startedBy' })
      omit('delegation')
    }
    if (ws.scheduled && firstTurn && firstTurn.user.origin?.kind !== 'schedule') scheduleEdge(turnNode(firstTurn), 'Workspace.scheduled')
    if (ws.scheduled) omit('scheduled')

    // Compare siblings: the same message, sent to other models in their own workspaces.
    if (ws.compareId) {
      const compared = ws.compare?.sessionId ? sessionOf(ws.compare.sessionId) : undefined
      const prompt = ws.compare?.prompt.trim().slice(0, 40) ?? ''
      const from = (compared ? turnsOf(compared).find((x) => x.user.text.trim().startsWith(prompt)) : undefined) ?? firstTurn
      for (const sibling of input.workspaces ?? []) {
        if (sibling.id === ws.id || sibling.compareId !== ws.compareId || !sibling.compare?.sessionId) continue
        const theirs = sessionOf(sibling.compare.sessionId)
        const target = theirs ? turnsOf(theirs)[0] : undefined
        if (!from || !target) continue
        edge({ from: turnNode(from).id, to: turnNode(target).id, kind: 'fact', label: t('lineage.edge.compareSibling'), recorded: 'Workspace.compareId' })
        omit('compareSibling')
      }
    }

    checkRun()
    if (prInfo) prOpened()

    // What a draft can't carry, beyond the above.
    for (const session of input.sessions) if (session.workspaceId !== ws.id && turns.has(session.id)) omit('otherChat')
    for (const session of own) {
      const list = turnsOf(session)
      if (session.autoReview || session.handedOffFrom?.kind === 'review' || list[0]?.handOff === 'review') for (let i = 1; i < list.length; i++) omit('reviewFollowUp')
      if (list[0]?.handOff && list[0].handOff !== 'review') omit('handOffAsTurn')
    }
    draftRoles()
  }

  function flowEdge(runId: string, step: string, iteration: number, target: LineageNode, field: string): void {
    const name = input.flowRun?.id === runId ? input.flowRun.flow.name : runId.slice(0, 8)
    const flow = node({ id: `flow:${runId}`, kind: 'source', label: t('lineage.node.flowRun', { flow: name }), loops: [] })
    edge({ from: flow.id, to: target.id, kind: 'fact', label: iteration > 1 ? t('lineage.edge.flowStepPass', { step, n: iteration }) : t('lineage.edge.flowStep', { step }), recorded: field })
  }

  function scheduleEdge(target: LineageNode, field: string): void {
    const id = ws.scheduled?.scheduleId ?? 'schedule'
    const schedule = node({ id: `schedule:${id}`, kind: 'source', label: t('lineage.node.schedule'), loops: [] })
    edge({ from: schedule.id, to: target.id, kind: 'fact', label: t('lineage.edge.scheduled'), recorded: field })
  }

  /** The workspace's latest check run, and what started it: recorded, or (from before) the turn that ended before it. */
  function checkRun(): void {
    if (!checks?.results.length) return
    const at = checks.results.map((r) => r.startedAt).filter(Boolean).sort()[0]
    const passed = checks.results.filter((r) => r.status === 'passed').length
    const n = node({ id: 'checks', kind: 'step', stepKind: 'checks', label: t('lineage.node.checks', { passed, total: checks.results.length }), loops: [], ref: { kind: 'checks', workspaceId: ws.id }, ...(at ? { at } : {}), draft: { role: 'checks', at: at ?? '' } })
    const by = checks.startedBy
    if (by && typeof by === 'object') {
      flowEdge(by.flowRun, by.step, 1, n, 'WorkspaceChecks.startedBy')
      recorded(n, 'WorkspaceChecks.startedBy')
      return
    }
    const before = ownTurns.filter((x) => time(x.endAt ?? x.at) <= time(at)).at(-1)
    if (by) recorded(n, 'WorkspaceChecks.startedBy')
    else needs(n, 'WorkspaceChecks.startedBy')
    if (!before) return
    const label = by === 'user' ? t('lineage.edge.checksByYou') : by === 'cli' ? t('lineage.edge.checksByCli') : t('lineage.edge.checksAfter')
    edge({ from: turnNode(before).id, to: n.id, kind: 'fact', label, ...(by ? { recorded: 'WorkspaceChecks.startedBy' } : { reconstructed: true, needs: 'WorkspaceChecks.startedBy' as const }) })
  }

  function prNode(): LineageNode {
    const pr = prInfo!
    const facts = pr.facts
    const ci = facts ? (facts.checks === 'none' ? t('lineage.ci.none') : t(CI_WORD[facts.checks], { passed: facts.checksPassed, total: facts.checksTotal })) : undefined
    const n = node({ id: 'pr', kind: 'tree', label: t('lineage.node.pr', { number: pr.number, state: pr.state.toLowerCase() }), ...(ci ? { sublabel: ci } : {}), loops: [], ref: { kind: 'pr', workspaceId: ws.id, ...(pr.url ? { url: pr.url } : {}) }, ...(facts?.stateSince ? { at: facts.stateSince } : {}) })
    recorded(n, 'Workspace.prInfo')
    return n
  }

  /** The pull request, opened after the turn that ended last before Foreman first saw it (timing, so dashed). */
  function prOpened(): void {
    const pr = prNode()
    const since = prInfo?.facts?.stateSince
    const before = (since ? ownTurns.filter((x) => time(x.endAt ?? x.at) <= time(since)) : ownTurns).at(-1)
    // A workspace made from a pull request checked it out; nobody here opened it.
    if (!before || ws.pullRequest) return
    edge({ from: turnNode(before).id, to: pr.id, kind: 'fact', label: t('lineage.edge.openedPr'), reconstructed: true })
    if (!input.flowRun) pr.draft = { role: 'pr', at: since ?? before.endAt ?? before.at }
  }

  /** What each turn of this workspace is in a draft: a turn, a review, an address of findings, or a CI fix. */
  function draftRoles(): void {
    for (const session of own) {
      const list = turnsOf(session)
      const reviewer = Boolean(session.autoReview || session.handedOffFrom?.kind === 'review' || list[0]?.handOff === 'review')
      list.forEach((turn, i) => {
        const n = turnNode(turn)
        if (n.draft) return
        const origin = turn.user.origin
        if (reviewer && i > 0) return
        if (origin?.kind === 'auto-fix') n.draft = { role: 'ci-fix', at: turn.at, sessionId: session.id, fix: { n: origin.n, of: origin.of } }
        else if (reviewer) n.draft = { role: 'review', at: turn.at, sessionId: session.id, reviewer: { agent: turn.user.agent ?? session.agent, model: turn.user.model ?? session.model } }
        else {
          const id = turn.user.followUp?.templateId
          const template = turn.user.repoTemplate?.name ?? (id ? (input.templateNames?.[id] ?? id) : undefined)
          n.draft = { role: 'turn', at: turn.at, sessionId: session.id, ...(template ? { template } : {}), ...(turn.handOff ? { handOff: turn.handOff } : {}) }
        }
      })
    }
  }

  // ---- context ----
  function contextOf(turn: Turn, n: LineageNode): void {
    for (const part of turn.user.added ?? []) {
      const src = node({ id: `src:${part.kind}:${part.label}`, kind: 'source', label: part.label, loops: [] })
      edge({ from: src.id, to: n.id, kind: 'shown', label: sizeText(part), recorded: 'ChatItem.added' })
    }
  }

  function sizeText(part: ContextPart): string {
    return t(SIZE_WORD[part.unit], { size: compact(part.size) })
  }

  /** What a hand-off gave the new chat: its sections and their hashes as previewed. */
  function handOffSections(): void {
    for (const session of own) {
      const first = turnsOf(session)[0]
      const handed = session.handedOffFrom
      if (!first) continue
      if (!handed) {
        if (guessedHandOff(session, first)) needs(turnNode(first), 'Session.handedOffFrom')
        continue
      }
      const hashes = Object.entries(handed.hashes ?? {}).filter(([, h]) => h).map(([k, h]) => `${k} ${short(h!)}`)
      const src = node({ id: `handoff:${session.id}`, kind: 'source', label: t('lineage.node.handOff', { sections: handed.sections.join(' · ') || '—' }), ...(hashes.length ? { sublabel: hashes.join(' · ') } : {}), loops: [] })
      edge({ from: src.id, to: turnNode(first).id, kind: 'shown', label: t(HANDOFF_WORD[handed.kind]), recorded: 'Session.handedOffFrom' })
    }
  }

  // ---- memory ----
  function memoryOf(turn: Turn, n: LineageNode): void {
    if (turn.user.noteRevision !== undefined) {
      const note = node({ id: 'mem:note', kind: 'memory', label: t('flowGraph.memory.note'), loops: [] })
      edge({ from: note.id, to: n.id, kind: 'read', label: `r${turn.user.noteRevision}`, recorded: 'ChatItem.noteRevision' })
    }
    if (turn.user.added?.some((p) => p.kind === 'instructions')) {
      const standing = node({ id: 'mem:instructions', kind: 'memory', label: t('flowGraph.memory.instructions'), loops: [] })
      edge({ from: standing.id, to: n.id, kind: 'read', recorded: 'ChatItem.added' })
    }
    const persona = turn.user.added?.find((p) => p.kind === 'persona')
    if (persona) {
      const p = node({ id: `mem:persona:${persona.label}`, kind: 'memory', label: persona.label, loops: [] })
      edge({ from: p.id, to: n.id, kind: 'read', recorded: 'ChatItem.added' })
    }
    for (const file of turn.end?.usage?.breakdown?.memoryFiles ?? []) edge({ from: fileNode(file.path).id, to: n.id, kind: 'read', recorded: 'turn-end.usage' })
    for (const path of turn.end?.memoryWrites ?? []) edge({ from: n.id, to: fileNode(path).id, kind: 'write', label: t('flowGraph.edge.wrote', { who: t('lineage.node.turn', { chat: title(turn.session), n: turn.n }), file: memoryLabel(path) }), recorded: 'turn-end.memoryWrites' })
  }

  function fileNode(path: string): LineageNode {
    const p = path.replace(/\\/g, '/')
    const known = nodes.find((x) => x.id.startsWith('mem:file:') && (x.id.slice(9) === p || x.id.slice(9).endsWith(`/${p}`) || p.endsWith(`/${x.id.slice(9)}`)))
    return known ?? node({ id: `mem:file:${p}`, kind: 'memory', label: memoryLabel(p), sublabel: t('flowGraph.memory.file'), loops: [] })
  }

  /** The note's revisions, agent reports and a flow run's personas: what outlives a turn. */
  function memoryNodes(): void {
    const note = nodes.find((x) => x.id === 'mem:note')
    if (note) {
      const seen = [...new Set(ownTurns.filter((x) => x.user.noteRevision !== undefined).map((x) => `r${x.user.noteRevision}`))]
      note.sublabel = t('flowGraph.memory.revisions', { revisions: seen.join(', ') })
    }
    for (const report of ws.agentReports ?? []) {
      if (!report.sessionId || !report.turnId) continue
      const turn = linkedTurn(report.sessionId, report.turnId)
      if (!turn) continue
      const reports = node({ id: 'mem:reports', kind: 'memory', label: t('flowGraph.memory.reports'), loops: [] })
      edge({ from: turnNode(turn).id, to: reports.id, kind: 'write', label: report.kind, recorded: 'AgentReport.turnId' })
    }
    for (const step of input.flowRun?.steps ?? []) {
      if (!step.persona || !step.sessionId || !step.turnId) continue
      const turn = linkedTurn(step.sessionId, step.turnId)
      if (!turn) continue
      const p = node({ id: `mem:persona:${step.persona}`, kind: 'memory', label: t('flowGraph.memory.persona', { name: step.persona }), loops: [] })
      edge({ from: p.id, to: turnNode(turn).id, kind: 'read', recorded: 'FlowRun.steps' })
    }
  }

  // ---- data ----
  function dataEdges(): void {
    const base = node({ id: 'tree:base', kind: 'tree', label: t('flowGraph.data.base', { branch: ws.baseBranch }), loops: [] })
    if (firstTurn) edge({ from: base.id, to: turnNode(firstTurn).id, kind: 'tree', recorded: 'Workspace.baseBranch' })
    if (ws.compareId) {
      const checkpoint = node({ id: 'tree:compare', kind: 'tree', label: t('lineage.data.compare'), loops: [] })
      edge({ from: base.id, to: checkpoint.id, kind: 'tree', recorded: 'Workspace.compareId' })
      const session = ws.compare?.sessionId ? sessionOf(ws.compare.sessionId) : undefined
      const first = session ? turnsOf(session)[0] : undefined
      if (first) edge({ from: checkpoint.id, to: turnNode(first).id, kind: 'tree', label: t('flowGraph.edge.made'), recorded: 'Workspace.compareId' })
    }
    // Each turn's start and end trees; a start that isn't where the turn before it (in any chat here) ended moved.
    for (const turn of ownTurns) {
      const tree = turn.end?.tree
      if (!tree) continue
      const n = turnNode(turn)
      const before = ownTurns
        .filter((x) => x !== turn && x.end?.tree?.end && time(x.endAt ?? x.at) <= time(turn.at))
        .sort((a, b) => time(a.endAt ?? a.at) - time(b.endAt ?? b.at))
        .at(-1)
      const moved = Boolean(tree.start && before?.end?.tree?.end && before.end.tree.end !== tree.start)
      if (tree.start) {
        const start = node({ id: `tree:${tree.start}`, kind: 'tree', label: t('flowGraph.data.tree', { hash: short(tree.start) }), loops: [] })
        edge({ from: start.id, to: n.id, kind: 'tree', ...(moved ? { label: t('flowGraph.edge.moved'), moved: true } : {}), recorded: 'turn-end.tree' })
      }
      if (moved) n.moved = true
      if (tree.end) {
        const end = node({ id: `tree:${tree.end}`, kind: 'tree', label: t('flowGraph.data.tree', { hash: short(tree.end) }), loops: [] })
        edge({ from: n.id, to: end.id, kind: 'tree', recorded: 'turn-end.tree' })
      }
    }
    if (prInfo) {
      const pr = prNode()
      const last = ownTurns.filter((x) => x.end?.tree?.end).at(-1)
      if (last?.end?.tree?.end) edge({ from: `tree:${last.end.tree.end}`, to: pr.id, kind: 'tree', label: t('lineage.edge.pushed'), reconstructed: true })
    }
  }

  /** A chat that looks handed off (its title and first words are a hand-off's) but has no record of where from. */
  function guessedHandOff(session: Session, first: Turn): HandOffKind | undefined {
    if (session.handedOffFrom || session.forkedFrom || session.autoReview) return undefined
    const text = first.user.text.trim()
    const title = session.title ?? ''
    if (text.startsWith(REVIEW_MESSAGE) && title === 'Code review') return 'review'
    if (text.startsWith(SECOND_OPINION_MESSAGE) && title === 'Second opinion') return 'second-opinion'
    if ((title.endsWith(' (continued)') || title === 'Continued chat') && text.length > 0) return 'continue'
    if (text.startsWith(CONTINUE_MESSAGE)) return 'continue'
    return undefined
  }
}

/** The graph as a list a keyboard and a screen reader can follow: each node with its edges and where they come from. */
export function lineageOutline(graph: LineageGraph): LineageOutlineEntry[] {
  const labelOf = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id
  const ordered = [...graph.nodes].sort((a, b) => {
    const at = (n: LineageNode) => (n.at ? Date.parse(n.at) : NaN)
    const x = at(a)
    const y = at(b)
    if (Number.isFinite(x) && Number.isFinite(y)) return x - y
    if (Number.isFinite(x)) return -1
    if (Number.isFinite(y)) return 1
    return 0
  })
  return ordered.map((n) => {
    const into = graph.edges.filter((e) => e.to === n.id)
    const out = graph.edges.filter((e) => e.from === n.id)
    const recorded = [...new Set([...(n.recorded ?? []), ...into.map((e) => e.recorded).filter((r): r is string => Boolean(r))])]
    const needs = [...new Set([...(n.needs ?? []), ...into.map((e) => e.needs).filter((g): g is LineageGap => Boolean(g))])]
    return {
      id: n.id,
      label: n.label,
      ...(n.sublabel ? { sublabel: n.sublabel } : {}),
      ...(n.ref ? { ref: n.ref } : {}),
      ...(n.at ? { at: n.at } : {}),
      recorded,
      needs,
      tags: [...recorded.map((r) => `recorded: ${r}`), ...needs.map((g) => `needs: ${g}`)],
      edges: [
        ...into.map((e) => ({ direction: 'from' as const, other: labelOf(e.from), ...(e.label ? { label: e.label } : {}), ...(e.recorded ? { recorded: e.recorded } : {}), ...(e.reconstructed ? { reconstructed: true } : {}) })),
        ...out.map((e) => ({ direction: 'to' as const, other: labelOf(e.to), ...(e.label ? { label: e.label } : {}), ...(e.recorded ? { recorded: e.recorded } : {}), ...(e.reconstructed ? { reconstructed: true } : {}) }))
      ]
    }
  })
}

// ---- Make a flow from this… ----

const tomlString = (text: string) => JSON.stringify(text)
const FIX_PROMPT = 'CI failed on the pull request. Read the failing checks and fix them.'
const ADDRESS_PROMPT = 'Address the review’s findings.'

interface DraftStep {
  name: string
  lines: string[]
  // Where the run goes next, given the step after it in order: a table edge names its facts.
  edge?: (next: string) => string
  // Inside a loop, it goes back along its own edge: the steps before it skip it to find their next.
  loopsBack?: boolean
}

/**
 * A draft flow from a run-lens lineage: each turn a `turn` step (the template it used, else `prompt = "{{task}}"`),
 * the check run a `checks` step, a review a read-only `review` step on the reviewer's model, findings sent back an
 * `address` step in a loop `review-until-clean` of at most two, a pull request opened by hand a `pr-check` gate and a
 * `pr` step (a draft, no agent), and auto-fix a `wait` on CI with a `fix` in a loop. Edges follow the order
 * things happened; what it can't carry is listed in a comment at the top. A draft to edit, never something that runs.
 */
export function draftFlowFromLineage(graph: LineageGraph): LineageFlowDraft {
  const items = graph.nodes.filter((n) => n.draft).sort((a, b) => Date.parse(a.draft!.at) - Date.parse(b.draft!.at))
  const steps: DraftStep[] = []
  const loops: string[] = []
  const leftOut = new Map(graph.leftOut.map((l) => [l.kind, l.count]))
  const omit = (kind: LeftOutKind) => leftOut.set(kind, (leftOut.get(kind) ?? 0) + 1)
  const taken = new Set<string>()
  const nameFor = (base: string) => {
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
    taken.add(name)
    return name
  }
  // A chat's first turn step, so later turns in the same chat continue its tab.
  const tabStep = new Map<string, string>()
  // A review node → its review step (and the address step its findings went to).
  const reviewStep = new Map<string, { name: string; address?: string }>()
  let fixStep: { wait: string; fix: string; of: number } | undefined
  let turns = 0
  let usedTask = false

  for (const n of items) {
    const d = n.draft!
    if (d.role === 'turn') {
      const name = nameFor(`turn-${++turns}`)
      const lines = ['kind = "turn"']
      const same = d.sessionId ? tabStep.get(d.sessionId) : undefined
      if (d.template) lines.push(`template = ${tomlString(d.template)}`)
      else {
        lines.push(`prompt = "{{task}}"`)
        usedTask = true
        if (turns > 1) omit('templateUnknown')
      }
      if (same) lines.push(`same_tab = ${tomlString(same)}`)
      else if (d.sessionId) tabStep.set(d.sessionId, name)
      steps.push({ name, lines })
    } else if (d.role === 'review') {
      const name = nameFor('review')
      const lines = ['kind = "review"', 'read_only = true']
      if (d.reviewer) lines.push(`agent = ${tomlString(d.reviewer.agent)}`, `model = ${tomlString(d.reviewer.model)}`)
      lines.push('context = ["diff"]')
      const entry = { name }
      reviewStep.set(n.id, entry)
      steps.push({ name, lines, edge: (next) => (reviewStep.get(n.id)?.address ? `{ clean = ${tomlString(next)}, findings = ${tomlString(reviewStep.get(n.id)!.address!)} }` : tomlString(next)) })
    } else if (d.role === 'address') {
      const review = d.reviewNode ? reviewStep.get(d.reviewNode) : undefined
      if (!review) continue
      if (review.address) continue
      const name = nameFor('address')
      review.address = name
      const lines = ['kind = "turn"', `prompt = ${tomlString(ADDRESS_PROMPT)}`, `context = [${tomlString(`${review.name}.findings`)}]`]
      const same = d.sessionId ? tabStep.get(d.sessionId) : undefined
      if (same) lines.push(`same_tab = ${tomlString(same)}`)
      steps.push({ name, lines, edge: () => tomlString(review.name), loopsBack: true })
      loops.push(`[loops.review-until-clean]\nover = [${tomlString(review.name)}, ${tomlString(name)}]\nat_most = { iterations = 2 }`)
    } else if (d.role === 'ci-fix') {
      if (fixStep) {
        fixStep.of = Math.max(fixStep.of, d.fix?.of ?? 1)
        continue
      }
      const wait = nameFor('wait-ci')
      const fix = nameFor('fix')
      fixStep = { wait, fix, of: d.fix?.of ?? 1 }
      const same = d.sessionId ? tabStep.get(d.sessionId) : undefined
      steps.push({ name: wait, lines: ['kind = "wait"', 'on = "ci"'], edge: (next) => `{ failed = ${tomlString(fix)}, green = ${tomlString(next)}, none = ${tomlString(next)} }` })
      steps.push({ name: fix, lines: ['kind = "turn"', `prompt = ${tomlString(FIX_PROMPT)}`, ...(same ? [`same_tab = ${tomlString(same)}`] : [])], edge: () => tomlString(wait), loopsBack: true })
    } else if (d.role === 'checks') {
      steps.push({ name: nameFor('checks'), lines: ['kind = "checks"'] })
    } else if (d.role === 'pr') {
      const gate = nameFor('pr-check')
      const open = nameFor('open-pr')
      steps.push({ name: gate, lines: ['kind = "gate"', 'show = ["diff"]', `ask = ${tomlString('Open a pull request for this?')}`], edge: () => `{ continued = ${tomlString(open)}, stopped = "done" }` })
      steps.push({ name: open, lines: ['kind = "pr"'] })
    }
  }
  if (fixStep) loops.push(`[loops.fix-ci]\nover = [${tomlString(fixStep.wait)}, ${tomlString(fixStep.fix)}]\nat_most = { iterations = ${Math.max(1, fixStep.of)} }`)

  // The order things happened: each step to the next one in order that isn't a loop's way back (a loop's head goes on
  // from there when it ends). A plain step with nothing after it has no edge: the run is done.
  const edges: string[] = []
  steps.forEach((step, i) => {
    const next = steps.slice(i + 1).find((s) => !s.loopsBack)?.name ?? FLOW_DONE
    const value = step.edge ? step.edge(next) : next === FLOW_DONE ? undefined : tomlString(next)
    if (value !== undefined) edges.push(`${step.name} = ${value}`)
  })

  const leftOutList = LEFT_OUT_KINDS.filter((k) => leftOut.has(k)).map((kind) => ({ kind, count: leftOut.get(kind)! }))
  const lines: string[] = []
  lines.push(`# ${enT('lineage.draft.header', { workspace: graph.workspace.name })}`)
  lines.push(`# ${enT('lineage.draft.edit')}`)
  if (leftOutList.length) {
    lines.push(`# ${enT('lineage.draft.leftOut')}`)
    for (const l of leftOutList) lines.push(`#   - ${leftOutText(l)}`)
  }
  lines.push('')
  lines.push(`name = ${tomlString(`From ${graph.workspace.name}`)}`)
  lines.push(`made_from = ${tomlString(`workspace ${graph.workspace.name}`)}`)
  if (usedTask) lines.push('', '[inputs]', 'task = "What to work on"')
  if (steps.length) lines.push('', '[start]', `step = ${tomlString(steps[0].name)}`)
  for (const step of steps) lines.push('', `[steps.${step.name}]`, ...step.lines)
  if (edges.length) lines.push('', '[edges]', ...edges)
  for (const loop of loops) lines.push('', loop)
  lines.push('', '[after]', 'workspace = "keep"', '')
  return { toml: lines.join('\n'), leftOut: leftOutList }
}
