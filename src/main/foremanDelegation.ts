import { DELEGATION_TOOLS, delegationTool, type DelegationToolName } from '../shared/foremanDelegation'
import { frozenReason } from '../shared/transfer'
import type { Workspace } from '../shared/types'
import type { NewResult } from '../shared/cli/workspaces'
import type { CliHost } from './cli/host'
import type { CliContext } from './cli/methods'
import { WORKSPACE_METHODS } from './cli/workspaces'
import { cancel, send, waitForTurn } from './cli/work'

export interface DelegationScope {
  workspaceId?: string
  sessionId?: string
  readOnly: boolean
  // MCP refreshes the grant and live read-only state at each async boundary/poll.
  refresh?(): DelegationScope
  signal?: AbortSignal
}

const OPT_IN = 'Enable “Let agents start workspaces and queue messages” in Repository settings → Actions to coordinate other workspaces.'

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

  /** Validation also runs before an assistant proposal; execution rechecks everything. */
  async validate(name: string, args: unknown, scope: DelegationScope): Promise<Record<string, unknown>> {
    const definition = delegationTool(name)
    const parsed = definition.schema.parse(args) as Record<string, unknown>
    const current = this.current(scope, !definition.readOnly)
    if (name === 'start_task') {
      const repoId = parsed.repoId ?? (current.workspaceId ? this.workspace(current.workspaceId).repoId : undefined)
      if (typeof repoId !== 'string' || !this.host.state().repos.some((r) => r.id === repoId)) throw new Error('Choose a repository ID from list_delegation_options.')
      if (current.workspaceId && repoId !== this.workspace(current.workspaceId).repoId) throw new Error('Delegation is restricted to the coordinating repository.')
      if (!this.host.state().settings.loadouts[(parsed.loadout as number) - 1]) throw new Error('That loadout slot is not configured.')
    }
    if (typeof parsed.workspaceId === 'string') {
      this.target(parsed.workspaceId, scope, !definition.readOnly)
      if (name === 'send_task' && !this.host.state().sessions.some((s) => s.id === parsed.sessionId && s.workspaceId === parsed.workspaceId && !s.closedAt)) throw new Error('Choose an open chat in the target workspace.')
    }
    if (typeof parsed.turnId === 'string') await this.turn(parsed.turnId, scope, !definition.readOnly, name !== 'get_turn_result')
    return parsed
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
        return {
          delegationEnabled: enabled && !current.readOnly,
          permission: source && !enabled ? OPT_IN : undefined,
          loadouts: this.host.state().settings.loadouts.map((l, i) => ({ slot: i + 1, agent: l.agent, model: l.model, effort: l.effort })),
          repositories: this.host.state().repos.filter((r) => !source || r.id === source.repoId).map((r) => ({ id: r.id, name: r.name })),
          workspaces: this.host.state().workspaces.filter((w) => w.state !== 'archived' && (!source || (w.repoId === source.repoId && (enabled || w.id === source.id)))).map((w) => this.task(w.id, scope))
        }
      }
      case 'start_task': {
        const p = DELEGATION_TOOLS.start_task.schema.parse(args)
        const repoId = p.repoId ?? this.workspace(current.workspaceId!).repoId
        const repo = this.host.state().repos.find((r) => r.id === repoId)!
        // Do not expose arbitrary flags, paths, attachments, consent, or --start-anyway.
        const params = { prompt: p.prompt, loadout: p.loadout, repo: repo.id, cwd: repo.rootPath, branch: p.branch, base: p.baseBranch, noWait: true }
        const guardedHost: CliHost = { ...this.host, createWorkspace: (id, options) => {
          this.current(scope, true)
          if (id !== repo.id) throw new Error('Repository changed during delegation.')
          return this.host.createWorkspace(id, options)
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
        return send(this.host, { workspace: ws.id, tab, args: [p.prompt], cwd: ws.path ?? '' }, { literal: true })
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
        return waitForTurn(guardedHost, { turn: p.turnId, timeoutSec: p.timeoutSeconds ?? 10 }, { signal: scope.signal })
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
