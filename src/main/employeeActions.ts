// An AI employee's outward actions (docs/ai-employees.md §9, "Outward actions"): the brokered routes. A run's bridged
// foreman-slack post or foreman-linear change (main/integrationBridge.ts hands an employee run's call here instead of
// acting) and its request_push and request_pull_request (main/employeeTools.ts) are each recorded first, with their exact
// payload and an idempotency key, then, as the employee's approved definition says for the class:
//  - allowed: sent at once through the same code a person's or a turn's call takes, the result recorded;
//  - held (the default): kept for a person, who sees the exact preview in Needs you and presses Send, Edit then send
//    (the words only, never the destination) or Skip, each recorded;
//  - never: refused, with a reason the model reads.
// Only the repository's selected connection is used, as recorded: one that is missing or changed refuses, never another
// account. Sending is idempotent: an action is marked approved before the service is asked, so a double Send finds it
// on its way, and one Foreman closed on is uncertain, waiting for a person to check, never sent again by itself. What
// became of it is logged on its task and, if the task waits, told on its next continuation (main/employeeWork.ts).
import { createHash, randomUUID } from 'node:crypto'
import {
  actionPolicy,
  actionSummary,
  applyEdits,
  canonicalPayload,
  heldText,
  linearIssue,
  neverText,
  type ActionCommit,
  type ActionDiffStat,
  type EmployeeAction,
  type EmployeeActionKind,
  type EmployeeActionPayload,
  type EmployeeActionResult,
  type EmployeeActionState
} from '../shared/employeeActions'
import { repoAccess } from '../shared/employeeWork'
import type { EmployeeDefinition } from '../shared/employees'
import type { Session } from '../shared/types'
import type { ForemanDb } from './db'
import type { EmployeeService } from './employees'
import type { EmployeeWorkService } from './employeeWork'
import type { PersistedState } from './store'

/** A bridged call an employee's run made (main/integrationBridge.ts), after the bridge's own checks passed. */
export interface BrokeredCall {
  sessionId: string
  repoId: string
  service: 'slack' | 'linear'
  // The repository's connection the turn's grant was for, as it is now (checked by the bridge), and its name.
  connectionId: string
  connectionName: string
  tool: string
  args: Record<string, unknown>
  // Slack: the allowed channel's name.
  channelName?: string
}

/**
 * How each class is sent, through the code Foreman already has. Each throws when it isn't sent: with `uncertain: true`
 * when the service may have acted before it failed (a timeout after sending). Each refuses when the repository's
 * connection isn't the one recorded (never another account).
 */
export interface ActionSenders {
  slack(input: { repoId: string; connectionId: string; channel: string; text: string }): Promise<EmployeeActionResult>
  linear(input: { repoId: string; connectionId: string; tool: string; args: Record<string, unknown> }): Promise<EmployeeActionResult>
  // `head` is the commit the person saw in the preview: exactly that goes out, never commits made since.
  push(input: { repoId: string; workspaceId: string; connectionId?: string; branch: string; head: string }): Promise<EmployeeActionResult>
  pullRequest(input: { repoId: string; workspaceId: string; connectionId?: string; branch: string; head: string; base: string; title: string; body: string }): Promise<EmployeeActionResult>
}

/** What the run's branch holds, for a push's or pull request's preview. */
export interface BranchPreview {
  branch: string
  base: string
  head: string
  ahead: number
  commits: ActionCommit[]
  diffStat?: ActionDiffStat
}

export interface ScmGate {
  // The repository's selected GitHub or GitLab connection now (its id, absent for gh's own account or the repository's
  // token, and a name to show), or why it can't be used. Never another account.
  connection(repoId: string): Promise<{ connectionId?: string; name: string } | { refused: string }>
  // The run's branch against `base` (the workspace's base when absent); what is uncommitted is committed first, as the employee.
  prepare(workspaceId: string, input: { base?: string; commit: { message: string; author: { name: string; email: string } } }): Promise<BranchPreview>
}

export interface EmployeeActionsHost {
  state(): PersistedState
  db(): ForemanDb
  work: Pick<EmployeeWorkService, 'toolRun' | 'actionRecorded' | 'actionSettled'>
  employees: Pick<EmployeeService, 'current'>
  session(sessionId: string): Session | undefined
  send: ActionSenders
  scm?: ScmGate
  now?(): number
}

export interface ActionToolResult {
  text: string
  isError?: boolean
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/

/** Thrown back to the model: nothing was recorded or sent. */
class Refusal extends Error {}

export class EmployeeActionService {
  constructor(private host: EmployeeActionsHost) {}

  private get db(): ForemanDb {
    return this.host.db()
  }

  private iso(): string {
    return new Date(this.host.now?.() ?? Date.now()).toISOString()
  }

  // ---- what a run asks for ----

  /** Whether a chat's bridged calls are brokered: it is an AI employee's run (ended or not: an ended one is refused, never let through). */
  brokers(sessionId: string): boolean {
    const mark = this.host.session(sessionId)?.unattended
    return Boolean(mark && 'employeeRunId' in mark)
  }

  /** The going run, and its definition as approved here, or a refusal the model reads. */
  private async caller(sessionId: string): Promise<{ run: ReturnType<EmployeeWorkService['toolRun']>['run']; task: ReturnType<EmployeeWorkService['toolRun']>['task']; definition: EmployeeDefinition; name: string }> {
    const { run, task } = this.host.work.toolRun(sessionId)
    const current = await this.host.employees.current(run.orgId, run.employeeId).catch(() => undefined)
    const s = current?.summary
    if (!current?.definition || !s || s.problems.length || s.changed || s.state === 'retired' || s.state === 'draft')
      throw new Refusal('Your definition changed since this run was approved (or you were retired), so Foreman sends nothing from this run. Finish your task and say so.')
    return { run, task, definition: current.definition, name: s.name || run.employeeId }
  }

  /** A bridged Slack post or Linear change from an employee's run (§9): recorded, then sent, held or refused. */
  async bridgeCall(call: BrokeredCall): Promise<ActionToolResult> {
    try {
      const { run, task, definition } = await this.caller(call.sessionId)
      const kind: EmployeeActionKind = call.service === 'slack' ? 'slack-post' : 'linear'
      const payload: EmployeeActionPayload =
        call.service === 'slack'
          ? { kind: 'slack-post', connectionId: call.connectionId, connection: call.connectionName, channel: String(call.args.channel), ...(call.channelName ? { channelName: call.channelName } : {}), text: String(call.args.text) }
          : { kind: 'linear', connectionId: call.connectionId, connection: call.connectionName, tool: call.tool, args: call.args, ...(linearIssue(call.args) ? { issue: linearIssue(call.args) } : {}) }
      return await this.decide(this.record(run, task, call.repoId, kind, payload, actionPolicy(definition, kind)))
    } catch (err) {
      return { text: message(err), isError: true }
    }
  }

  /** request_push: the run's branch, its changes committed first, pushed as the repository's connection (§9). */
  async requestPush(sessionId: string, input: { commit_message?: string }): Promise<ActionToolResult> {
    return this.branchAction(sessionId, 'push', input)
  }

  /** request_pull_request: pushed and opened, from the run's branch into `base` (§9). */
  async requestPullRequest(sessionId: string, input: { title: string; body: string; base?: string; commit_message?: string }): Promise<ActionToolResult> {
    return this.branchAction(sessionId, 'pull-request', input)
  }

  private async branchAction(sessionId: string, kind: 'push' | 'pull-request', input: { title?: string; body?: string; base?: string; commit_message?: string }): Promise<ActionToolResult> {
    try {
      const { run, task, definition, name } = await this.caller(sessionId)
      const repo = this.host.state().repos.find((r) => r.id === run.repoId)
      // Only a run admitted with Write access, whose definition still gives it: Read runs push nothing.
      if (!repo || run.access !== 'write' || repoAccess(definition, repo.name) !== 'write')
        throw new Refusal(`This run has ${run.access === 'write' ? 'lost its' : 'no'} Write access to ${repo?.name ?? 'its repository'}, so Foreman ${kind === 'push' ? 'pushes' : 'opens pull requests'} only for a run with Write access. Say what you would have published in your result.`)
      if (!run.workspaceId) throw new Refusal('This run has no workspace yet, so there is no branch to push.')
      const base = input.base?.trim()
      if (base && !BRANCH.test(base)) throw new Refusal(`“${base}” isn’t a branch name Foreman can use as the base.`)
      const policy = actionPolicy(definition, kind)
      const scm = this.host.scm
      if (!scm) throw new Refusal('Foreman can’t push from here.')
      if (policy === 'never') {
        // Refused before anything is committed or read: the refusal is recorded, with what was asked.
        const refused: EmployeeActionPayload =
          kind === 'push'
            ? { kind, connection: '', workspaceId: run.workspaceId, branch: '', base: base ?? '', head: '', ahead: 0, commits: [] }
            : { kind, connection: '', workspaceId: run.workspaceId, branch: '', base: base ?? '', head: '', ahead: 0, commits: [], title: input.title ?? '', body: input.body ?? '' }
        return await this.decide(this.record(run, task, repo.id, kind, refused, policy))
      }
      // The repository's selected connection, or a refusal: never gh's other account or another token.
      const connection = await scm.connection(repo.id)
      if ('refused' in connection) throw new Refusal(`${connection.refused} Foreman didn’t ${kind === 'push' ? 'push' : 'open the pull request'} with any other account.`)
      const preview = await scm.prepare(run.workspaceId, {
        ...(base ? { base } : {}),
        commit: { message: input.commit_message?.trim() || input.title?.trim() || task.title, author: { name: `${name} (AI employee)`, email: `${run.employeeId}@employees.foreman.localhost` } }
      })
      if (!preview.ahead) throw new Refusal(`There is nothing to ${kind === 'push' ? 'push' : 'open a pull request for'}: ${preview.branch} has no commits ahead of ${preview.base}. Change files first.`)
      const common = { ...(connection.connectionId ? { connectionId: connection.connectionId } : {}), connection: connection.name, workspaceId: run.workspaceId, branch: preview.branch, base: preview.base, head: preview.head, ahead: preview.ahead, commits: preview.commits }
      const payload: EmployeeActionPayload =
        kind === 'push' ? { kind, ...common } : { kind, ...common, ...(preview.diffStat ? { diffStat: preview.diffStat } : {}), title: (input.title ?? '').trim(), body: input.body ?? '' }
      return await this.decide(this.record(run, task, repo.id, kind, payload, policy))
    } catch (err) {
      return { text: message(err), isError: true }
    }
  }

  /**
   * Record the action before anything is sent (§9): held, approved (allowed: about to be sent) or refused. The same
   * request twice in a run (same class and exact payload) finds the first instead of making a second.
   */
  private record(
    run: { id: string; orgId: string; employeeId: string },
    task: { id: string },
    repoId: string | null,
    kind: EmployeeActionKind,
    payload: EmployeeActionPayload,
    policy: EmployeeAction['policy']
  ): { action: EmployeeAction; existing: boolean } {
    const key = `${kind}:${run.id}:${createHash('sha256').update(canonicalPayload(payload)).digest('hex')}`
    const found = this.db.employeeActionByKey(key)
    if (found) return { action: found, existing: true }
    const at = this.iso()
    const state: EmployeeActionState = policy === 'never' ? 'refused' : policy === 'held' ? 'held' : 'approved'
    const action: EmployeeAction = {
      id: randomUUID(),
      orgId: run.orgId,
      employeeId: run.employeeId,
      taskId: task.id,
      runId: run.id,
      repoId,
      kind,
      payload,
      policy,
      state,
      key,
      ...(state === 'approved' ? { decidedBy: 'definition' as const } : {}),
      ...(state === 'refused' ? { reason: 'Its definition never allows this.', settledAt: at } : {}),
      createdAt: at,
      updatedAt: at
    }
    if (!this.db.addEmployeeAction(action)) return { action: this.db.employeeActionByKey(key)!, existing: true }
    this.host.work.actionRecorded(action)
    return { action, existing: false }
  }

  /** What the model is told, and an allowed action sent first. */
  private async decide({ action, existing }: { action: EmployeeAction; existing: boolean }): Promise<ActionToolResult> {
    if (existing) return { text: `Already recorded as action ${action.id} in this run: ${this.stateWords(action)} Nothing new was made.`, ...(action.state === 'refused' || action.state === 'failed' ? { isError: true } : {}) }
    if (action.state === 'refused') return { text: neverText(action.kind), isError: true }
    if (action.state === 'held') return { text: heldText(action) }
    const sent = await this.deliver(action)
    if (sent.state === 'sent') return { text: `Sent: ${actionSummary(sent.payload)}${sent.result?.link ? ` (${sent.result.link})` : ''}${sent.result?.detail ? `. ${sent.result.detail}` : ''}. Recorded as action ${sent.id}.` }
    if (sent.state === 'uncertain') return { text: `It may have been sent: the service stopped answering after Foreman asked (${sent.result?.error ?? 'no answer'}). A person checks before anything is sent again; don’t try again yourself. Action ${sent.id}.`, isError: true }
    return { text: `Not sent: ${sent.result?.error ?? 'it failed'}. Recorded as action ${sent.id}; a person can send it again.`, isError: true }
  }

  private stateWords(a: EmployeeAction): string {
    switch (a.state) {
      case 'held':
        return 'it is held for the person’s approval.'
      case 'approved':
        return 'it is being sent.'
      case 'sent':
        return `it was sent${a.result?.link ? ` (${a.result.link})` : ''}.`
      case 'skipped':
        return 'the person skipped it, so it wasn’t sent.'
      case 'failed':
        return `it failed (${a.result?.error ?? 'no reason given'}).`
      case 'refused':
        return 'it was refused.'
      case 'uncertain':
        return 'it may have been sent; a person checks first.'
    }
  }

  /** Send an approved action through its route, and record what came of it. Never called twice for one action. */
  private async deliver(action: EmployeeAction): Promise<EmployeeAction> {
    try {
      const result = await this.dispatch(action)
      return this.settle(action, 'sent', { result, sentAt: this.iso() })
    } catch (err) {
      const uncertain = Boolean((err as { uncertain?: unknown }).uncertain)
      return this.settle(action, uncertain ? 'uncertain' : 'failed', { result: { error: message(err) } })
    }
  }

  private dispatch(a: EmployeeAction): Promise<EmployeeActionResult> {
    const p = a.payload
    const repoId = a.repoId ?? ''
    switch (p.kind) {
      case 'slack-post':
        return this.host.send.slack({ repoId, connectionId: p.connectionId ?? '', channel: p.channel, text: p.text })
      case 'linear':
        return this.host.send.linear({ repoId, connectionId: p.connectionId ?? '', tool: p.tool, args: p.args })
      case 'push':
        return this.host.send.push({ repoId, workspaceId: p.workspaceId, ...(p.connectionId ? { connectionId: p.connectionId } : {}), branch: p.branch, head: p.head })
      case 'pull-request':
        return this.host.send.pullRequest({ repoId, workspaceId: p.workspaceId, ...(p.connectionId ? { connectionId: p.connectionId } : {}), branch: p.branch, head: p.head, base: p.base, title: p.title, body: p.body })
    }
  }

  private settle(action: EmployeeAction, state: EmployeeActionState, patch: Partial<EmployeeAction> = {}): EmployeeAction {
    const at = this.iso()
    const next: EmployeeAction = { ...action, ...patch, state, updatedAt: at, ...(state === 'approved' || state === 'held' || state === 'uncertain' ? {} : { settledAt: at }) }
    this.db.putEmployeeAction(next)
    this.host.work.actionSettled(next)
    return next
  }

  // ---- a person's answer (Needs you) ----


  private action(id: string): EmployeeAction {
    const a = typeof id === 'string' ? this.db.employeeAction(id) : undefined
    if (!a) throw new Error('That action is no longer here.')
    return a
  }

  /**
   * Send (or Edit then send) a held action, or a failed one again; an uncertain one only once the person says they
   * checked it didn't arrive. Marked approved before the service is asked, so a second Send while it goes (a double
   * click) finds it on its way and sends nothing. One sent already is returned as it is.
   */
  async send(id: string, options: { edits?: Record<string, string>; checked?: boolean } = {}): Promise<EmployeeAction> {
    const a = this.action(id)
    if (a.state === 'approved' || a.state === 'sent') return a
    if (a.state === 'skipped' || a.state === 'refused') throw new Error(a.state === 'skipped' ? 'It was skipped, so it can’t be sent now.' : 'Its employee’s definition never allows it, so it can’t be sent.')
    if (a.state === 'uncertain' && !options.checked) throw new Error('It may have arrived already. Check first, then say it arrived, or send it again.')
    const payload = options.edits && Object.keys(options.edits).length ? applyEdits(a.payload, options.edits) : a.payload
    const edited = payload !== a.payload
    // Recorded on its way first, in one step: nothing else can send it now.
    const going: EmployeeAction = { ...a, payload, state: 'approved', decidedBy: 'person', ...(edited || a.edited ? { edited: true as const } : {}), updatedAt: this.iso() }
    delete going.result
    this.db.putEmployeeAction(going)
    this.host.work.actionSettled(going)
    const sent = await this.deliver(going)
    if (sent.state !== 'sent') throw new Error(sent.state === 'uncertain' ? `It may have been sent: ${sent.result?.error ?? 'the service stopped answering'}. Check before sending again.` : `Not sent: ${sent.result?.error ?? 'it failed'}`)
    return sent
  }

  /** Skip: nothing is sent, and the employee is told. */
  skip(id: string): EmployeeAction {
    const a = this.action(id)
    if (a.state === 'skipped') return a
    if (a.state !== 'held' && a.state !== 'failed' && a.state !== 'uncertain') throw new Error(a.state === 'sent' || a.state === 'approved' ? 'It was already sent.' : 'It was refused, so there is nothing to skip.')
    return this.settle(a, 'skipped', { reason: 'Skipped by you.' })
  }

  /** An uncertain action the person checked did arrive: recorded as sent, nothing sent again. */
  confirmArrived(id: string): EmployeeAction {
    const a = this.action(id)
    if (a.state !== 'uncertain') throw new Error('Only an action Foreman isn’t sure about can be marked as arrived.')
    return this.settle(a, 'sent', { result: { ...a.result, detail: 'A person checked that it arrived.' }, sentAt: a.sentAt ?? this.iso() })
  }

  // ---- recovery ----

  /** At launch: an action Foreman was sending when it closed may have gone, so it waits for a person, never resent (§6.6). */
  recover(): void {
    for (const a of this.db.employeeActions({ states: ['approved'] })) {
      const next: EmployeeAction = { ...a, state: 'uncertain', reason: 'Foreman closed while sending this, so it may or may not have arrived. Check before sending it again.', updatedAt: this.iso() }
      this.db.putEmployeeAction(next)
      this.host.work.actionSettled(next)
    }
  }
}
