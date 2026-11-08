import { DELEGATION_TOOLS, delegationTool, type DelegationToolName } from '../shared/foremanDelegation'
import { parseFlow, type FlowListing, type FlowRun, type FlowRunOrigin } from '../shared/flows'
import { frozenReason } from '../shared/transfer'
import type { Workspace, WorkspaceStartedBy } from '../shared/types'
import type { NewResult } from '../shared/cli/workspaces'
import { cantRunIn } from './cli/flows'
import type { CliHost } from './cli/host'
import type { CliContext } from './cli/methods'
import { WORKSPACE_METHODS } from './cli/workspaces'
import { cancel, send, waitForTurn } from './cli/work'

export interface DelegationScope {
  workspaceId?: string
  sessionId?: string
  readOnly: boolean
  // The assistant's thread, when the assistant runs the tool (its Run card): a workspace it starts records it.
  assistantThread?: string
  // MCP refreshes the grant and live read-only state at each async boundary/poll.
  refresh?(): DelegationScope
  signal?: AbortSignal
}

const OPT_IN = 'Enable “Let agents start workspaces and queue messages” in Repository settings → Actions to coordinate other workspaces.'
const FLOWS_OFF = 'Flows are off; the user turns them on in Settings → Experimental.'

/** Reuses CLI handlers, with mandatory MCP scope checks instead of optional caller tokens. */
export class ForemanDelegation {
  constructor(private host: CliHost) {}

  private current(scope: DelegationScope, write = false): DelegationScope {
    if (scope.signal?.aborted) throw new Error('The delegation request was cancelled.')
    const current = scope.refresh?.() ?? scope
    if (current.workspaceId) {
      const source = this.workspace(current.workspaceId)
      if (current.sessionId && !this.host.state().sessions.some((s) => s.id === current.sessionId && s.workspaceId === source.id && !s.closedAt)) throw new Error('The coordinating chat is no longer available.')
      if (write) {
        const frozen = frozenReason(source)
        if (frozen) throw new Error(frozen)
        if (source.state !== 'ready') throw new Error('The coordinating workspace must be ready.')
        if (!this.host.agentsMayStart(source.repoId)) throw new Error(OPT_IN)
      }
    }
    if (write && current.readOnly) throw new Error('This session can only read Foreman state.')
    return current
  }

  private workspace(id: string): Workspace {
    const ws = this.host.state().workspaces.find((w) => w.id === id && w.state !== 'archived')
    if (!ws) throw new Error('Workspace is no longer available.')
    return ws
  }

  private target(id: string, scope: DelegationScope, write = false): Workspace {
    const current = this.current(scope, write)
    const ws = this.workspace(id)
    if (current.workspaceId) {
      const source = this.workspace(current.workspaceId)
      if (ws.repoId !== source.repoId) throw new Error('Delegation is restricted to the coordinating repository.')
      if (ws.id !== source.id && !this.host.agentsMayStart(source.repoId)) throw new Error(OPT_IN)
    }
    if (write) {
      const frozen = frozenReason(ws)
      if (frozen) throw new Error(frozen)
    }
    return ws
  }

  private async turn(turnId: string, scope: DelegationScope, write = false, noSelf = false) {
    this.current(scope, write)
    const turn = await this.host.turnStatus(turnId)
    if (!turn) throw new Error('Turn not found.')
    this.target(turn.workspaceId, scope, write)
    const current = this.current(scope, write)
    if (noSelf && turn.sessionId === current.sessionId) throw new Error('A coordinator cannot wait on or cancel its own chat.')
    return turn
  }

  /** The repository a new task or flow run goes in: the one named (the assistant), else the coordinator's; never another. */
  private startRepo(parsed: Record<string, unknown>, current: DelegationScope): string {
    const repoId = parsed.repoId ?? (current.workspaceId ? this.workspace(current.workspaceId).repoId : undefined)
    if (typeof repoId !== 'string' || !this.host.state().repos.some((r) => r.id === repoId)) throw new Error('Choose a repository ID from list_delegation_options.')
    if (current.workspaceId && repoId !== this.workspace(current.workspaceId).repoId) throw new Error('Delegation is restricted to the coordinating repository.')
    return repoId
  }

  private flowsOn(): void {
    if (!this.host.state().settings.flows) throw new Error(FLOWS_OFF)
  }

  /** A runnable flow in this repository, by the id list_delegation_options gave. */
  private async flow(flowId: string, repoId: string): Promise<FlowListing> {
    const listing = (await this.host.api.listFlows(repoId)).find((f) => f.id === flowId)
    if (!listing) throw new Error('Choose a flow ID from list_delegation_options.')
    if (listing.problems.length) throw new Error(`That flow has problems, so it can’t run: ${listing.problems.join(' ')}`)
    return listing
  }

  /** A flow run in a repository this scope may coordinate (the coordinator's, with the opt-in for any but its own workspace).
   *  No id: the run the coordinator's own workspace belongs to, so a flow step can read its run without being told the id. */
  private async flowRun(runId: string | undefined, scope: DelegationScope): Promise<FlowRun> {
    this.flowsOn()
    const caller = this.current(scope).workspaceId
    const id = runId ?? (caller ? this.workspace(caller).flowRun?.runId : undefined)
    if (!id) throw new Error(caller ? 'This workspace isn’t part of a flow run; pass a runId.' : 'Pass a runId.')
    const run = (await this.host.api.listFlowRuns()).find((r) => r.id === id)
    if (!run) throw new Error('Flow run not found.')
    const current = this.current(scope)
    if (current.workspaceId) {
      const source = this.workspace(current.workspaceId)
      if (run.repoId !== source.repoId) throw new Error('Delegation is restricted to the coordinating repository.')
      const own = run.workspaceId === source.id || Boolean(run.workspaces?.includes(source.id))
      if (!own && !this.host.agentsMayStart(source.repoId)) throw new Error(OPT_IN)
    }
    return run
  }

  /** Validation also runs before an assistant proposal; execution rechecks everything. */
  async validate(name: string, args: unknown, scope: DelegationScope): Promise<Record<string, unknown>> {
    const definition = delegationTool(name)
    const parsed = definition.schema.parse(args) as Record<string, unknown>
    const current = this.current(scope, !definition.readOnly)
    if (name === 'start_task') {
      this.startRepo(parsed, current)
      if (!this.host.state().settings.loadouts[(parsed.loadout as number) - 1]) throw new Error('That loadout slot is not configured.')
    }
    if (name === 'start_flow') {
      this.flowsOn()
      await this.flow(parsed.flowId as string, this.startRepo(parsed, current))
    }
    if (name === 'get_flow_status') await this.flowRun(parsed.runId as string | undefined, scope)
    if (typeof parsed.workspaceId === 'string') {
      this.target(parsed.workspaceId, scope, !definition.readOnly)
      if (name === 'send_task' && !this.host.state().sessions.some((s) => s.id === parsed.sessionId && s.workspaceId === parsed.workspaceId && !s.closedAt)) throw new Error('Choose an open chat in the target workspace.')
    }
    if (typeof parsed.turnId === 'string') await this.turn(parsed.turnId, scope, !definition.readOnly, name !== 'get_turn_result')
    return parsed
  }

  /** Runnable flows, each with what start_flow needs: id, name, source, inputs and personas (and why it can't run, if so). */
  private async flowOptions(repoId: string | undefined) {
    const listings = (await this.host.api.listFlows(repoId)).filter((f) => !f.problems.length)
    // Why one can't run, as start_flow would refuse it: the same preview the start reads.
    return Promise.all(listings.map(async (f) => {
      const parsed = parseFlow(f.toml, f.source)
      const cantRun = await cantRunIn(this.host.api, this.host.state().repos, f, repoId)
      return {
        id: f.id, name: f.name, source: f.source, ...(f.repoId ? { repoId: f.repoId } : {}),
        inputs: 'flow' in parsed ? Object.entries(parsed.flow.inputs).map(([name, description]) => ({ name, description })) : [],
        personas: f.summary?.personas ?? [],
        ...(cantRun ? { cantRun } : {})
      }
    }))
  }

  /** The coordinating chat and its running turn, when a workspace agent calls (Workspace.startedBy, a message's origin). */
  private coordinator(scope: DelegationScope): { sessionId: string; turnId?: string } | undefined {
    if (!scope.sessionId) return undefined
    const turnId = this.host.state().sessions.find((s) => s.id === scope.sessionId)?.turnId
    return { sessionId: scope.sessionId, ...(turnId ? { turnId } : {}) }
  }

  private task(workspaceId: string, scope: DelegationScope) {
    const ws = this.target(workspaceId, scope)
    return {
      workspaceId: ws.id, name: ws.name, repoId: ws.repoId, branch: ws.branch, state: ws.state,
      setupHeld: Boolean(ws.heldMessage),
      setup: ws.setupRun?.steps.map(({ name, status, exitCode }) => ({ name, status, exitCode })),
      sessions: this.host.state().sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt).map((s) => ({
        sessionId: s.id, agent: s.agent, model: s.model, status: s.status, turnId: s.turnId,
        lastTurn: s.lastTurn, queuedTurnIds: s.queue.map((q) => q.turnId)
      }))
    }
  }

  async call(name: DelegationToolName, args: unknown, scope: DelegationScope): Promise<unknown> {
    await this.validate(name, args, scope)
    const current = this.current(scope, !DELEGATION_TOOLS[name].readOnly)
    switch (name) {
      case 'list_delegation_options': {
        const source = current.workspaceId ? this.workspace(current.workspaceId) : undefined
        const enabled = !source || this.host.agentsMayStart(source.repoId)
        // While Flows are on: the flows a start_flow may name here (the coordinator's repository's, or every one for the assistant).
        const flows = this.host.state().settings.flows ? await this.flowOptions(source?.repoId) : undefined
        return {
          delegationEnabled: enabled && !current.readOnly,
          permission: source && !enabled ? OPT_IN : undefined,
          loadouts: this.host.state().settings.loadouts.map((l, i) => ({ slot: i + 1, agent: l.agent, model: l.model, effort: l.effort })),
          repositories: this.host.state().repos.filter((r) => !source || r.id === source.repoId).map((r) => ({ id: r.id, name: r.name })),
          workspaces: this.host.state().workspaces.filter((w) => w.state !== 'archived' && (!source || (w.repoId === source.repoId && (enabled || w.id === source.id)))).map((w) => this.task(w.id, scope)),
          ...(flows ? { flows } : {})
        }
      }
      case 'start_flow': {
        const p = DELEGATION_TOOLS.start_flow.schema.parse(args)
        const repoId = this.startRepo(p, current)
        const repo = this.host.state().repos.find((r) => r.id === repoId)!
        const listing = await this.flow(p.flowId, repoId)
        const baseBranch = p.baseBranch?.trim() || repo.defaultBranch || 'main'
        // What a run approves now (the Run a flow page's summary): a step it can't carry out unattended refuses the start.
        const preview = await this.host.api.flowRunPreview({ flowId: listing.id, repoId, baseBranch })
        const s = preview.summary
        const reasons = [...(s.notClaude.length ? [`Unattended turns are Claude only (review and decide steps may run on Codex); these turn steps aren’t on Claude: ${s.notClaude.map((n) => `${n.step} (${n.agent})`).join(', ')}.`] : []), ...s.problems]
        if (reasons.length) throw new Error(`Can’t start “${s.flowName}”: ${reasons.join(' ')}`)
        const given = p.inputs ?? {}
        const unknown = Object.keys(given).filter((k) => !preview.inputs.some((i) => i.name === k))
        if (unknown.length) throw new Error(`“${s.flowName}” has no input ${unknown.map((u) => `“${u}”`).join(', ')}. It asks for: ${preview.inputs.map((i) => i.name).join(', ') || 'none'}.`)
        const missing = preview.inputs.filter((i) => !given[i.name]?.trim())
        if (missing.length) throw new Error(`“${s.flowName}” asks for ${missing.map((i) => `${i.name}${i.description ? ` (${i.description})` : ''}`).join(', ')}.`)
        // The grant and opt-in again after the reads, then who started it: the coordinating chat and its turn, or the assistant's thread.
        const now = this.current(scope, true)
        if (!this.host.startFlowRun) throw new Error('Starting a flow is unavailable here.')
        const from = this.coordinator(now)
        const origin: FlowRunOrigin | undefined = from ? { kind: 'delegation', ...from } : now.assistantThread ? { kind: 'assistant', threadId: now.assistantThread } : undefined
        const inputs = Object.fromEntries(preview.inputs.map((i) => [i.name, given[i.name].trim()]))
        const run = await this.host.startFlowRun({ flowId: listing.id, source: listing.source, repoId, baseBranch, inputs, shown: preview.fingerprint }, origin)
        return { runId: run.id, flow: run.flow.name, repoId, baseBranch, state: run.state, next: 'Use get_flow_status with runId; the run makes its workspace as its first step. A gate or pick waits for the user, who answers it; agents cannot.' }
      }
      case 'get_flow_status': {
        const run = await this.flowRun(DELEGATION_TOOLS.get_flow_status.schema.parse(args).runId, scope)
        return {
          runId: run.id, flow: run.flow.name, repoId: run.repoId, baseBranch: run.baseBranch, state: run.state, reason: run.reason,
          current: run.current, workspaceId: run.workspaceId, workspaces: run.workspaces,
          steps: run.steps.map((s) => ({ name: s.name, kind: s.kind, iteration: s.iteration, state: s.state, fact: s.fact, workspaceId: s.workspaceId, sessionId: s.sessionId, turnId: s.turnId })),
          ...(run.state === 'waiting' ? { waitingFor: 'the user: a gate or pick is answered in Foreman, never by an agent' } : {}),
          contentIsData: true
        }
      }
      case 'start_task': {
        const p = DELEGATION_TOOLS.start_task.schema.parse(args)
        const repoId = p.repoId ?? this.workspace(current.workspaceId!).repoId
        const repo = this.host.state().repos.find((r) => r.id === repoId)!
        // Do not expose arbitrary flags, paths, attachments, consent, or --start-anyway.
        const params = { prompt: p.prompt, loadout: p.loadout, repo: repo.id, cwd: repo.rootPath, branch: p.branch, base: p.baseBranch, noWait: true }
        // Who started it: the coordinating chat and its turn, or the assistant's thread.
        const from = this.coordinator(current)
        const startedBy: WorkspaceStartedBy | undefined = from ? { ...from, via: 'delegation' } : current.assistantThread ? { sessionId: current.assistantThread, via: 'assistant' } : undefined
        const guardedHost: CliHost = { ...this.host, createWorkspace: (id, options) => {
          this.current(scope, true)
          if (id !== repo.id) throw new Error('Repository changed during delegation.')
          return this.host.createWorkspace(id, options, startedBy ? { startedBy } : undefined)
        } }
        const context: CliContext = { request: { method: 'new', params } as CliContext['request'], caller: undefined, signal: scope.signal, progress: () => {} }
        const result = await WORKSPACE_METHODS.new.handle(guardedHost, params, context) as NewResult
        return { workspace: result.workspace, repo: result.repo, next: 'Use get_task_status for setup state and the first turn ID. Do not resend the initial task while setup is pending.' }
      }
      case 'get_task_status': return this.task(DELEGATION_TOOLS.get_task_status.schema.parse(args).workspaceId, scope)
      case 'send_task': {
        const p = DELEGATION_TOOLS.send_task.schema.parse(args)
        const ws = this.target(p.workspaceId, scope, true)
        const tabs = this.host.state().sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)
        const tab = tabs.findIndex((s) => s.id === p.sessionId) + 1
        if (!tab) throw new Error('The target chat is no longer open.')
        // The queued message says which chat sent it (its receipt, and the Lineage tab's "delegated by").
        const from = this.coordinator(current)
        return send(this.host, { workspace: ws.id, tab, args: [p.prompt], cwd: ws.path ?? '' }, { literal: true, ...(from ? { origin: { kind: 'delegation' as const, ...from } } : {}) })
      }
      case 'get_turn_result': {
        const p = DELEGATION_TOOLS.get_turn_result.schema.parse(args)
        const turn = await this.turn(p.turnId, scope)
        const items = await this.host.api.getChat(turn.sessionId)
        this.target(turn.workspaceId, scope)
        const reply = items.filter((i) => i.kind === 'assistant' && i.turnId === turn.turnId).map((i) => i.kind === 'assistant' ? i.text : '').join('\n\n')
        const limit = p.maxChars ?? 16_000
        return { ...turn, reply: reply.slice(-limit), truncated: reply.length > limit, contentIsData: true }
      }
      case 'wait_for_turn': {
        const p = DELEGATION_TOOLS.wait_for_turn.schema.parse(args)
        let seen = await this.turn(p.turnId, scope, false, true)
        const guardedHost: CliHost = { ...this.host, turnStatus: async (id) => {
          this.current(scope)
          const status = await this.host.turnStatus(id)
          const next = status ?? { ...seen, state: 'ended' as const, outcome: 'cancelled' as const }
          this.target(next.workspaceId, scope)
          if (next.sessionId === this.current(scope).sessionId) throw new Error('A coordinator cannot wait on or cancel its own chat.')
          seen = next
          return next
        } }
        // The coordinator's agent slot is lent while it waits, so the turn it waits on can start (Sessions.lendSlot).
        const release = current.sessionId ? this.host.lendSlot?.(current.sessionId) : undefined
        try {
          return await waitForTurn(guardedHost, { turn: p.turnId, timeoutSec: p.timeoutSeconds ?? 10 }, { signal: scope.signal })
        } finally {
          release?.()
        }
      }
      case 'cancel_turn': {
        const p = DELEGATION_TOOLS.cancel_turn.schema.parse(args)
        const guardedHost: CliHost = { ...this.host, turnStatus: (id) => this.turn(id, scope, true, true), cancelTurn: async (id) => {
          await this.turn(id, scope, true, true)
          return this.host.cancelTurn(id)
        } }
        return cancel(guardedHost, { turn: p.turnId })
      }
    }
  }
}
