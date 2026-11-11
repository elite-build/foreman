import { runsCodeRefusal, type TurnCap } from '../shared/agentAccess'
import { decisionProblem } from '../shared/agentReports'
import { FOREMAN_TOOLS, foremanToolArgs, foremanToolName, type ForemanToolName } from '../shared/foremanTools'
import type { Api, Session, Workspace } from '../shared/types'
import { frozenReason } from '../shared/transfer'
import type { RecordInput } from './agentReports'

export interface ForemanActionDeps {
  state(): { workspaces: Workspace[]; sessions: Session[] }
  api: Pick<Api, 'checksStatus' | 'runChecks' | 'openPreview'>
  // Keep what an agent decided in a flow's decide step, as a report on its tab and turn (agentReports.ts).
  record?(input: RecordInput): { added: boolean }
}

// `cap`: an outside agent's, or a capped turn's (docs/agent-access.md §4); below Never ask it may not run checks.
export interface ForemanScope { workspaceId?: string; readOnly: boolean; cap?: TurnCap }

/** Shared domain entry point. Callers cannot supply consent or expand their own scope. */
export class ForemanActions {
  constructor(private deps: ForemanActionDeps) {}

  validate(name: string, args: unknown, scope: ForemanScope): { name: ForemanToolName; workspace: Workspace } {
    const tool = foremanToolName.parse(name)
    const { workspaceId } = foremanToolArgs.parse(args)
    if (scope.workspaceId && scope.workspaceId !== workspaceId) throw new Error('This turn can only access its own workspace.')
    const workspace = this.deps.state().workspaces.find((w) => w.id === workspaceId && w.state !== 'archived')
    if (!workspace) throw new Error('Workspace is no longer available.')
    if (!FOREMAN_TOOLS[tool].readOnly) {
      if (scope.readOnly) throw new Error('This session can only read Foreman state.')
      const frozen = frozenReason(workspace)
      if (frozen) throw new Error(frozen)
      if (workspace.state !== 'ready') throw new Error('The workspace must be ready before running this action.')
    }
    if (tool === 'run_checks') {
      const refusal = runsCodeRefusal(scope.cap)
      if (refusal) throw new Error(refusal)
    }
    return { name: tool, workspace }
  }

  /**
   * A flow's decide step: the turn in `sessionId` decided on `option`. Refused outside that step's turn, and for an
   * option the step doesn't name; recorded as a `decide` report the flow reads when the turn ends.
   */
  decide(sessionId: string, option: string): { decided: string; message: string } {
    const session = this.deps.state().sessions.find((s) => s.id === sessionId)
    if (!session) throw new Error('Foreman couldn’t find this chat any more; nothing was recorded.')
    const problem = decisionProblem(session.unattended, option)
    if (problem) throw new Error(problem)
    if (!session.turnId || !this.deps.record) throw new Error('This turn has ended, so nothing was recorded.')
    const decided = option.trim()
    const { added } = this.deps.record({ workspaceId: session.workspaceId, sessionId, turnId: session.turnId, kind: 'decide', text: decided, via: 'mcp' })
    return { decided, message: added ? `Noted: you decided “${decided}”. End your turn now.` : 'Already noted; nothing changed.' }
  }

  async call(name: string, args: unknown, scope: ForemanScope): Promise<unknown> {
    const { name: tool, workspace: ws } = this.validate(name, args, scope)
    switch (tool) {
      case 'get_workspace_status':
        return {
          id: ws.id, name: ws.name, branch: ws.branch, state: ws.state, status: ws.status,
          setup: ws.setupRun ? {
            id: ws.setupRun.id, startedAt: ws.setupRun.startedAt, finishedAt: ws.setupRun.finishedAt,
            steps: ws.setupRun.steps.map(({ name, status, exitCode, durationMs, attempts }) => ({ name, status, exitCode, durationMs, attempts }))
          } : undefined,
          heldMessage: Boolean(ws.heldMessage),
          sessions: this.deps.state().sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)
            .map((s) => ({ id: s.id, agent: s.agent, status: s.status }))
        }
      case 'get_check_results': {
        const status = await this.deps.api.checksStatus(ws.id)
        return { configured: status.configured, running: status.running, rows: status.rows.map(({ name, stale, result }) => ({
          name, stale, result: result ? { status: result.status, exitCode: result.exitCode, durationMs: result.durationMs, startedAt: result.startedAt } : undefined
        })) }
      }
      case 'open_preview':
        await this.deps.api.openPreview(ws.id)
        return { opened: true, workspaceId: ws.id }
      case 'run_checks': {
        // Deliberately no `approve`: repository command fingerprints remain authoritative.
        const outcome = await this.deps.api.runChecks(ws.id)
        return outcome.started ? { workspaceId: ws.id, started: true } : {
          workspaceId: ws.id, started: false, needsConsent: outcome.consent.map((c) => c.name),
          message: 'The user must approve these commands in the Git panel before they can run.'
        }
      }
    }
  }
}
