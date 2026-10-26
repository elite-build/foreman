import { FOREMAN_TOOLS, foremanToolArgs, foremanToolName, type ForemanToolName } from '../shared/foremanTools'
import type { Api, Session, Workspace } from '../shared/types'
import { frozenReason } from '../shared/transfer'

export interface ForemanActionDeps {
  state(): { workspaces: Workspace[]; sessions: Session[] }
  api: Pick<Api, 'checksStatus' | 'runChecks' | 'openPreview'>
}

export interface ForemanScope { workspaceId?: string; readOnly: boolean }

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
    return { name: tool, workspace }
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
