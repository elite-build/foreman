// An AI employee's own tools (docs/ai-employees.md §4, §6.2, §6.4), answered for its run's turn on Foreman's
// `foreman-app` server (main/foremanMcp.ts: in-process for Claude, the stdio bridge for other agents), with the turn's
// grant: the chat comes from the grant, the run from the chat's mark, and nothing in the arguments names either. Every
// memory read is framed as data. Writes go through the memory service, staged for the run (its own folder, and shared
// folders its definition grants) or filed as proposals for a person (the organization's files), never anywhere else.
import type { AgentKind } from '../shared/agents'
import { DATA_NOTE, dataBlock, memoryBlock, memoryWriteDecision, plainSnippet, rememberLine, ROSTER_NOTE, type EmployeeToolName, type MemoryWriteGrants } from '../shared/employeeTools'
import { newTriggerId, triggerKey } from '../shared/employeeTriggers'
import { closureFor, type EmployeeRun } from '../shared/employeeWork'
import {
  defaultEmployee,
  employeeFromObject,
  employeeNameProblem,
  employeePath,
  freeHatColour,
  MAX_RESPONSIBILITIES,
  newEmployeeId,
  parseEmployee,
  serializeEmployee,
  type EmployeeDefinition
} from '../shared/employees'
import type { MemoryChange } from '../shared/memory'
import type { EmployeeActionService } from './employeeActions'
import type { EmployeeService } from './employees'
import type { EmployeeBrief, EmployeeDelegateInput, EmployeeFinishInput, EmployeeWorkService } from './employeeWork'
import type { MemoryService } from './memory'

export interface EmployeeToolsHost {
  work: Pick<EmployeeWorkService, 'toolRun' | 'finishTask' | 'askPerson' | 'noUpdate' | 'commitMemory' | 'memoryChanged'> &
    Partial<Pick<EmployeeWorkService, 'roster' | 'delegate' | 'send' | 'cancelHandedOff' | 'wakeMe' | 'escalate'>>
  memory: Pick<MemoryService, 'search' | 'read' | 'stage' | 'propose'>
  employees: Pick<EmployeeService, 'current'> & Partial<Pick<EmployeeService, 'members'>>
  // Outward actions through Foreman's own routes (docs/ai-employees.md §9): request_push, request_pull_request.
  actions?: Pick<EmployeeActionService, 'requestPush' | 'requestPullRequest'>
  now?(): number
}

/** bot_propose's input, as checked by its schema. */
export interface EmployeeProposeInput {
  kind: 'trigger' | 'employee' | 'delegate'
  spec: Record<string, unknown>
  reason: string
}

export interface EmployeeToolResult {
  text: string
  isError?: boolean
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const short = (blob: string | null | undefined) => (blob ? blob.slice(0, 12) : 'none')

export class EmployeeTools {
  constructor(private host: EmployeeToolsHost) {}

  private now(): Date {
    return new Date(this.host.now?.() ?? Date.now())
  }

  /** Run one tool for the chat `sessionId` (from the turn's grant). Refusals come back as an error result the model reads. */
  async call(sessionId: string, name: EmployeeToolName, args: Record<string, unknown>): Promise<EmployeeToolResult> {
    try {
      switch (name) {
        case 'memory_search':
          return await this.search(sessionId, args as { query: string; limit?: number })
        case 'memory_read':
          return await this.read(sessionId, args as { path: string })
        case 'remember':
          return await this.remember(sessionId, args as { text: string; scope: 'me' | 'organization' })
        case 'memory_append':
          return await this.write(sessionId, args as { path: string; text: string }, 'append')
        case 'memory_write':
          return await this.write(sessionId, args as { path: string; text: string; expected: string | null }, 'write')
        case 'memory_checkpoint':
          return await this.checkpoint(sessionId)
        case 'finish_task':
          return await this.finish(sessionId, args as unknown as EmployeeFinishInput)
        case 'ask_person':
          await this.host.work.askPerson(sessionId, args as { question: string; options?: string[] })
          return { text: 'Asked. Your task now waits for the person’s answer, which starts your next run with your question and their answer first. End your turn now: nothing more you do in this run counts.' }
        case 'report_no_update':
          this.host.work.noUpdate(sessionId)
          return { text: 'Noted: nothing to report. Your task closed with no follow-on, and nobody is notified. End your turn now.' }
        case 'escalate': {
          const out = await this.work('escalate')(sessionId, (args as { reason: string }).reason)
          return {
            text:
              out.to === 'lead'
                ? `Escalated to ${out.name}, your organization’s lead: your task closed as escalated and ${out.name} owns it now (task ${out.task.id}). End your turn now.`
                : 'Escalated to the person: your task waits for their answer, which starts your next run with your reason and their answer first. End your turn now.'
          }
        }
        case 'bot_list':
          return await this.list(sessionId)
        case 'bot_delegate':
          return await this.delegate(sessionId, args as unknown as EmployeeDelegateInput)
        case 'bot_send': {
          const out = await this.work('send')(sessionId, args as { to: string; body: string })
          return {
            text:
              out.outcome === 'added'
                ? `Added to the message to ${out.name} they haven’t read yet (task ${out.task.id}). It expects no reply.`
                : `Sent to ${out.name} (task ${out.task.id}): it wakes them with your message. It expects no reply, and your task doesn’t wait for one.`
          }
        }
        case 'bot_cancel': {
          const task = await this.work('cancelHandedOff')(sessionId, (args as { task_id: string }).task_id)
          return { text: `Canceled “${task.title}” (task ${task.id}) and whatever it handed off. If its result comes later, it starts nothing.` }
        }
        case 'bot_wake_me': {
          const out = await this.work('wakeMe')(sessionId, args as { at?: string; in_minutes?: number; note: string })
          return { text: `Foreman wakes this task at ${out.at}, with your note first in its next run’s message. End your turn now.` }
        }
        case 'bot_propose':
          return await this.proposeChange(sessionId, args as unknown as EmployeeProposeInput)
        case 'request_push':
          if (!this.host.actions) throw new Error('Foreman can’t push from here.')
          return await this.host.actions.requestPush(sessionId, args as { commit_message?: string })
        case 'request_pull_request':
          if (!this.host.actions) throw new Error('Foreman can’t open pull requests from here.')
          return await this.host.actions.requestPullRequest(sessionId, args as { title: string; body: string; base?: string; commit_message?: string })
      }
    } catch (err) {
      return { text: message(err), isError: true }
    }
    return { text: 'Unknown tool.', isError: true }
  }

  /** One of the broker's tools (main/employeeWork.ts), bound to it. */
  private work<K extends 'roster' | 'delegate' | 'send' | 'cancelHandedOff' | 'wakeMe' | 'escalate'>(name: K): NonNullable<EmployeeWorkService[K]> {
    const fn = this.host.work[name]
    if (!fn) throw new Error('Working with other employees isn’t available here.')
    return (fn as (...args: unknown[]) => unknown).bind(this.host.work) as NonNullable<EmployeeWorkService[K]>
  }

  /** bot_list: the roster as data (§7, "rosters as data, not grants"). */
  private async list(sessionId: string): Promise<EmployeeToolResult> {
    const { organization, employees } = await this.work('roster')(sessionId)
    const lines = employees.map((e) =>
      JSON.stringify({
        id: e.id,
        name: e.name,
        role: e.role,
        ask_me_about: e.askMeAbout,
        state: e.state,
        tasks_open: e.queue,
        ...(e.lead ? { lead: true } : {}),
        ...(e.you ? { you: true } : { you_may_hand_tasks: e.mayDelegate })
      })
    )
    const lead = employees.find((e) => e.lead)
    return {
      text: `${organization}’s employees (${employees.length}), one per line:\n\n${dataBlock('employees', lines.join('\n'))}\n\n${lead ? `"lead" in bot_delegate and bot_send means ${lead.name}.` : `${organization} has no lead employee.`} You may hand tasks only to those marked you_may_hand_tasks.\n${ROSTER_NOTE}`
    }
  }

  private async delegate(sessionId: string, args: EmployeeDelegateInput): Promise<EmployeeToolResult> {
    const out = await this.work('delegate')(sessionId, args)
    if (out.outcome === 'already') {
      const t = out.task
      const where = t.state === 'closed' ? `It is closed (${t.closureReason}${t.resultSummary ? `): ${t.resultSummary.split('\n')[0]}` : ')'}.` : 'It isn’t finished yet; your task waits for its result.'
      return { text: `already: ${out.name} has this task already (task ${t.id}, “${t.title}”). Nothing new was made. ${where}` }
    }
    const held = out.task.state === 'open' && out.task.reason ? ` For now: ${out.task.reason}` : ''
    const waits = out.task.state === 'waiting' ? ' It starts once the tasks it depends on are done.' : ''
    const warning = out.warning
      ? ` Note: ${out.name} already got a task with the same title on ${out.warning.at} (task ${out.warning.taskId}, “${out.warning.title}”). If that is the same work, bot_cancel this one.`
      : ''
    return { text: `queued: handed to ${out.name} as task ${out.task.id}.${waits}${held}${warning} Your task now waits for its result; end your turn when you have handed off what you need. The result starts your next run.` }
  }

  /**
   * bot_propose (§7): a change a person keeps or retires, filed through the memory service's proposals (the same as a
   * proposed memory change, in Needs you). A trigger or a delegate change is a new version of the employee's own
   * definition, so keeping it changes the definition, which then needs approving again before it runs; a new employee is
   * a new definition at the safest settings, a draft until approved. Checked as its file would be, before it is filed.
   */
  private async proposeChange(sessionId: string, args: EmployeeProposeInput): Promise<EmployeeToolResult> {
    const { run, task, brief } = this.host.work.toolRun(sessionId)
    // As for any memory write: a definition changed since this run's approval, or a retired employee, files nothing.
    await this.grants(run, brief)
    const reason = args.reason.trim()
    const spec = args.spec && typeof args.spec === 'object' ? args.spec : {}
    const members = (await this.host.employees.members?.(run.orgId)) ?? []
    const checked = (d: unknown): EmployeeDefinition => {
      const parse = employeeFromObject(JSON.parse(JSON.stringify(d)) as unknown)
      if (!parse.definition) throw new Error(`Not proposed: it wouldn’t be a valid definition: ${parse.problems.join(' ')}`)
      return parse.definition
    }
    const file = async (path: string, text: string, expectedBlob: string | null, why: string) => {
      const out = await this.host.memory.propose(run.orgId, run.id, { kind: 'write', path, text, expectedBlob }, { employeeId: run.employeeId, taskId: task.id, why })
      if (!out.ok) throw new Error(`Not proposed: ${path} changed while it was being proposed. Try again.`)
      this.host.work.memoryChanged()
      return out.id
    }
    if (args.kind === 'employee') {
      const text = (k: string) => (typeof spec[k] === 'string' ? (spec[k] as string).trim() : '')
      const name = text('name')
      if (!name) throw new Error('Not proposed: give the new employee a name in spec.name.')
      const problem = employeeNameProblem(name, members.flatMap((m) => (m.definition ? [{ id: m.summary.id, name: m.definition.name }] : [])))
      if (problem) throw new Error(problem === 'taken' ? `Not proposed: ${name} is already an employee’s name.` : 'Not proposed: that name is too long.')
      const responsibilities = (Array.isArray(spec.responsibilities) ? spec.responsibilities : []).filter((r): r is string => typeof r === 'string' && Boolean(r.trim())).map((r) => r.trim()).slice(0, MAX_RESPONSIBILITIES)
      const me = (await this.host.employees.current(run.orgId, run.employeeId)).definition
      const worn = members.flatMap((m) => (m.definition && m.summary.state !== 'retired' ? [m.definition.look.colour] : []))
      // The safest settings whatever the spec says (§5.3): no repository, no shell, nothing outward, runs only when asked.
      const d = checked(
        defaultEmployee({
          id: newEmployeeId(members.map((m) => m.summary.id)),
          colour: freeHatColour(worn),
          repos: [],
          loadouts: me ? [{ agent: me.model.agent as AgentKind, model: me.model.model }] : [],
          text: { name, role: text('role'), description: text('description'), personality: text('personality'), responsibilities, ask_me_about: text('ask_me_about'), instructions: text('instructions') }
        })
      )
      const id = await file(employeePath(d.id), serializeEmployee(d), null, `A new employee, ${d.name}, at the safest settings: ${reason} Keeping it adds them as a draft, approved separately.`)
      return { text: `Proposed (not made): a new employee, ${d.name} (${employeePath(d.id)}), at the safest settings (proposal ${id}). A person keeps or retires it in Needs you; kept, it is a draft until a person approves it.` }
    }
    // A trigger or a delegate: a new version of its own definition, against the version it is now.
    const path = employeePath(run.employeeId)
    const now = await this.host.memory.read(run.orgId, path)
    if (now.blob === null || now.text === undefined) throw new Error('Not proposed: your definition file can’t be read.')
    const parse = parseEmployee(now.text)
    if (!parse.definition) throw new Error(`Not proposed: your definition has problems a person has to fix first: ${parse.problems.join(' ')}`)
    let next: EmployeeDefinition
    let what: string
    if (args.kind === 'delegate') {
      const list = (k: string) => (Array.isArray(spec[k]) ? (spec[k] as unknown[]).filter((x): x is string => typeof x === 'string').map((x) => x.trim()) : [])
      const add = list('add')
      const remove = list('remove')
      if (!add.length && !remove.length) throw new Error('Not proposed: give spec.add or spec.remove, each a list of employee ids (bot_list shows them).')
      const unknown = add.filter((id) => id === run.employeeId || !members.some((m) => m.summary.id === id))
      if (unknown.length) throw new Error(`Not proposed: ${unknown.join(', ')} isn’t another employee of your organization.`)
      const delegates = [...new Set([...parse.definition.access.delegate_to.filter((id) => !remove.includes(id)), ...add])]
      next = checked({ ...parse.definition, access: { ...parse.definition.access, delegate_to: delegates } })
      const names = (ids: string[]) => ids.map((id) => members.find((m) => m.summary.id === id)?.summary.name || id).join(', ')
      what = [add.length ? `hand tasks to ${names(add)}` : '', remove.length ? `stop handing tasks to ${names(remove)}` : ''].filter(Boolean).join(', and ')
    } else {
      const existing = parse.definition.triggers ?? []
      const trigger = { ...spec, id: typeof spec.id === 'string' && spec.id ? spec.id : newTriggerId(existing.map(triggerKey)) }
      next = checked({ ...parse.definition, triggers: [...existing, trigger] })
      what = 'a new trigger'
    }
    const id = await file(path, serializeEmployee(next), now.blob, `A change to its own definition (${what}): ${reason} Keeping it changes the definition, which needs approving again before it runs.`)
    return { text: `Proposed (not made): ${what}, as a new version of ${path} (proposal ${id}). A person keeps or retires it in Needs you; if kept, your definition has changed, and you run again only once a person approves it.` }
  }

  private async search(sessionId: string, args: { query: string; limit?: number }): Promise<EmployeeToolResult> {
    const { run } = this.host.work.toolRun(sessionId)
    const hits = await this.host.memory.search(run.orgId, args.query, args.limit)
    if (!hits.length) return { text: `Nothing in memory matches “${args.query}”.` }
    const blocks = hits.map((h) => memoryBlock({ path: h.path, version: h.blob }, plainSnippet(h.snippet)))
    return { text: `${hits.length} ${hits.length === 1 ? 'file matches' : 'files match'} “${args.query}”, best first (matches «marked»). memory_read a path for the whole file.\n\n${blocks.join('\n\n')}\n\n${DATA_NOTE}` }
  }

  private async read(sessionId: string, args: { path: string }): Promise<EmployeeToolResult> {
    const { run } = this.host.work.toolRun(sessionId)
    const file = await this.host.memory.read(run.orgId, args.path, { runId: run.id })
    if (file.blob === null) return { text: `${file.path} doesn’t exist yet (version: null). To make it, memory_write it with expected: null.` }
    if (file.binary || file.tooLarge || file.text === undefined) return { text: `${file.path} is ${file.binary ? 'binary' : 'too large'}; Foreman reads and writes only text files in memory.`, isError: true }
    return { text: `${memoryBlock({ path: file.path, version: file.blob }, file.text)}\n\nversion: ${file.blob} (pass it as expected to memory_write)\n${DATA_NOTE}` }
  }

  /**
   * What the run may write now: its grants as admitted, narrowed by its definition as it is now. A definition changed
   * since its approval, or an employee retired, takes no writes (§9: a new revision reaches running work at its next call).
   */
  private async grants(run: EmployeeRun, brief: EmployeeBrief): Promise<MemoryWriteGrants> {
    const current = await this.host.employees.current(run.orgId, run.employeeId)
    const { summary, definition } = current
    if (!definition || summary.problems.length || summary.changed || summary.state === 'retired' || summary.state === 'draft')
      throw new Error('Your definition changed since this run was approved (or you were retired), so Foreman takes no memory writes from this run. Finish the task and say so.')
    return { scopes: brief.memoryWrites.scopes.filter((s) => definition.access.memory_write.includes(s)), readOnly: brief.memoryWrites.readOnly }
  }

  /** File a proposal for a person (Needs you, the Memory view). */
  private async propose(run: EmployeeRun, taskId: string, change: Extract<MemoryChange, { kind: 'write' | 'append' }>, why: string): Promise<EmployeeToolResult> {
    const out = await this.host.memory.propose(run.orgId, run.id, change, { employeeId: run.employeeId, taskId, why })
    if (!out.ok) return conflictResult(change.path, change.kind === 'write' ? change.expectedBlob : undefined, out.conflict, 'proposed')
    this.host.work.memoryChanged()
    return { text: `Proposed (not written): ${why} A person keeps or retires it in Needs you; until then nothing changes, and your next reads don’t show it.` }
  }

  private async remember(sessionId: string, args: { text: string; scope: 'me' | 'organization' }): Promise<EmployeeToolResult> {
    const { run, task, brief } = this.host.work.toolRun(sessionId)
    const line = rememberLine(args.text, this.now())
    if (args.scope === 'organization') {
      await this.grants(run, brief)
      return this.propose(run, task.id, { kind: 'append', path: 'memory/org/PROJECT.md', text: line }, 'A fact for the whole organization goes in memory/org/PROJECT.md, which a person keeps.')
    }
    const file = `memory/bots/${run.employeeId}/MEMORY.md`
    const decision = memoryWriteDecision(run.employeeId, file, await this.grants(run, brief))
    if (decision.kind === 'refuse') return { text: decision.why, isError: true }
    if (decision.kind === 'propose') return this.propose(run, task.id, { kind: 'append', path: file, text: line }, decision.why)
    const seen = await this.host.memory.read(run.orgId, file, { runId: run.id })
    const text = seen.blob === null ? `# Memory\n\n${line}` : line
    const out = await this.host.memory.stage(run.orgId, run.id, { kind: 'append', path: file, text })
    if (!out.ok) return conflictResult(file, undefined, out.conflict, 'written')
    return { text: `Remembered in ${file} (committed when this run ends, or now with memory_checkpoint): ${line.trim()}` }
  }

  private async write(sessionId: string, args: { path: string; text: string; expected?: string | null }, kind: 'append' | 'write'): Promise<EmployeeToolResult> {
    const { run, task, brief } = this.host.work.toolRun(sessionId)
    const file = args.path.trim()
    const decision = memoryWriteDecision(run.employeeId, file, await this.grants(run, brief))
    if (decision.kind === 'refuse') return { text: decision.why, isError: true }
    const change: Extract<MemoryChange, { kind: 'write' | 'append' }> =
      kind === 'append' ? { kind: 'append', path: file, text: args.text.endsWith('\n') ? args.text : `${args.text}\n` } : { kind: 'write', path: file, text: args.text, expectedBlob: args.expected ?? null }
    if (decision.kind === 'propose') return this.propose(run, task.id, change, decision.why)
    const out = await this.host.memory.stage(run.orgId, run.id, change)
    if (!out.ok) return conflictResult(file, kind === 'write' ? (args.expected ?? null) : undefined, out.conflict, 'written')
    return { text: `${kind === 'append' ? 'Added to' : 'Wrote'} ${file} (committed when this run ends, or now with memory_checkpoint). Its version as you see it now: ${out.blob}` }
  }

  private async checkpoint(sessionId: string): Promise<EmployeeToolResult> {
    const { run, task } = this.host.work.toolRun(sessionId)
    const out = await this.host.work.commitMemory(run, task)
    if (out.conflict) return { text: `Not committed: ${out.conflict.path} changed since you read it, so this run’s writes so far were set aside. Read it again and write again.`, isError: true }
    if (!out.commit) return { text: 'Nothing to commit: you haven’t written anything since the last commit.' }
    return { text: `Committed ${out.commit} with your name, this run and this task.` }
  }

  private async finish(sessionId: string, args: EmployeeFinishInput): Promise<EmployeeToolResult> {
    const { task, commit } = await this.host.work.finishTask(sessionId, args)
    const how = closureFor(args.status)
    const as = args.status === 'partial' ? 'blocked on what is left (partly done)' : how
    return { text: `Recorded: your task is closed as ${as}${commit ? `, and the memory you named went in commit ${commit} first` : ''}. ${task.title ? `(“${task.title}”) ` : ''}End your turn now.` }
  }
}

/** A compare-and-set that failed: nothing was written or proposed, with the file as it is now (as data). */
function conflictResult(file: string, expected: string | null | undefined, now: { blob: string | null; text: string | null }, verb: 'written' | 'proposed'): EmployeeToolResult {
  const current = now.blob === null ? `${file} doesn’t exist now (version: null).` : `${file} is now at version ${now.blob}:\n\n${memoryBlock({ path: file, version: now.blob }, now.text ?? '')}\n\n${DATA_NOTE}`
  return {
    text: `Not ${verb}: ${file} changed since you read it${expected !== undefined ? ` (you expected version ${short(expected)})` : ''}. ${current}\nMerge your change into it and try again with expected: ${now.blob === null ? 'null' : now.blob}.`,
    isError: true
  }
}
