// Starting a new chat from another one: a second opinion from a different
// model, or a continuation. The dialog previews what would be sent; Start
// builds it again from the source as it is now and refuses if it differs.
import { createHash } from 'node:crypto'
import { modelInfo } from '../shared/agents'
import {
  assembleHandOff,
  byteLength,
  CONTINUE_MESSAGE,
  continueEligibility,
  continueFollowUp,
  defaultTask,
  lastAnswer,
  MAX_OPEN_TABS,
  REVIEW_MESSAGE,
  SECOND_OPINION_MESSAGE,
  userTasks,
  type ContextSection
} from '../shared/handOff'
import { reviewInstructions } from '../shared/prompts'
import type { Attachment, ChatItem, HandOffKind, HandOffPreview, HandOffRequest, HandOffResult, Loadout } from '../shared/types'
import { workspaceDiffPatch, workspaceDiffStat, workspaceDiffText } from './diff'
import { attachFromData } from './files'
import { workspaceTarget } from './runtime'
import type { SessionService } from './sessions'
import type { Store } from './store'
import type { WorkspaceService } from './workspaces'

const toBase64 = (text: string) => Buffer.from(text).toString('base64')
const hash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 16)

/** The source changed in a way that makes this start wrong; nothing was started. */
class StaleHandOff extends Error {}

const TITLES: Partial<Record<HandOffKind, string>> = { 'second-opinion': 'Second opinion', review: 'Code review' }

type Diff = NonNullable<HandOffPreview['diff']> & { text: string }

interface Gathered {
  items: ChatItem[]
  tasks: { turnId: string; text: string; hash: string }[]
  answer: { id: string; turnId: string; text: string; hash: string } | null
  diff: Diff | null
}

export class HandOffService {
  // Source chat and kind → the start in progress, so a double-click starts one chat.
  private starting = new Map<string, Promise<HandOffResult>>()

  constructor(
    private store: Store,
    private sessions: SessionService,
    private workspaces: WorkspaceService
  ) {}

  /** The source's task, answer and diff as they are right now. */
  private async gather(sourceId: string, kind: HandOffKind): Promise<Gathered> {
    const source = this.sessions.session(sourceId)
    const ws = this.workspaces.workspace(source.workspaceId)
    const items = await this.store.readChat(sourceId)
    const tasks = userTasks(items).map((t) => ({ ...t, hash: hash(t.text) }))
    const reply = lastAnswer(items)
    const answer = reply ? { ...reply, hash: hash(reply.text) } : null
    let diff: Diff | null = null
    if (kind === 'continue') {
      // Only the stat: the next chat can read the files itself.
      const text = await workspaceDiffText(ws, undefined, true)
      if (text !== 'No changes found.') {
        const stat = await workspaceDiffStat(ws)
        diff = { text, bytes: byteLength(text), hash: hash(text), ...stat, baseRef: ws.baseBranch, stat: true }
      }
    } else {
      const patch = await workspaceDiffPatch(ws)
      if (patch.text.trim()) {
        const text = patch.cut ? `${patch.text}\n[Diff truncated at the size limit.]` : patch.text
        diff = { text, bytes: byteLength(text), hash: hash(text), files: patch.files, additions: patch.additions, deletions: patch.deletions, baseRef: patch.baseRef, stat: false }
      }
    }
    return { items, tasks, answer, diff }
  }

  private defaultModel(sourceId: string, kind: HandOffKind): Loadout {
    const source = this.sessions.session(sourceId)
    if (kind === 'continue') return { agent: source.agent, model: source.model, effort: source.effort, fast: source.fastMode }
    return this.store.state.settings.reviewModel
  }

  async prepare(sourceId: string, kind: HandOffKind): Promise<HandOffPreview> {
    const { items, tasks, answer, diff } = await this.gather(sourceId, kind)
    const eligibility = kind === 'continue' ? continueEligibility(this.sessions.session(sourceId), items) : undefined
    const follow = eligibility?.ok ? continueFollowUp(items, eligibility.turnId) : null
    return {
      kind,
      sourceId,
      tasks: tasks.map((t) => ({ turnId: t.turnId, label: t.text.replace(/\s+/g, ' ').trim().slice(0, 90), bytes: byteLength(t.text), hash: t.hash })),
      defaultTaskTurnId: defaultTask(tasks, answer),
      answer: answer ? { bytes: byteLength(answer.text), hash: answer.hash, turnId: answer.turnId } : undefined,
      diff: diff ? { bytes: diff.bytes, hash: diff.hash, files: diff.files, additions: diff.additions, deletions: diff.deletions, baseRef: diff.baseRef, stat: diff.stat } : undefined,
      message: kind === 'review' ? REVIEW_MESSAGE : kind === 'continue' ? (follow?.prompt ?? CONTINUE_MESSAGE) : SECOND_OPINION_MESSAGE,
      model: follow?.model ?? this.defaultModel(sourceId, kind),
      followUp: follow ? { title: follow.title, prompt: follow.prompt, model: follow.model } : undefined,
      blocked: eligibility && !eligibility.ok ? eligibility.reason : undefined
    }
  }

  /** Start the chat. Concurrent starts of the same hand-off share one result. */
  start(sourceId: string, request: HandOffRequest): Promise<HandOffResult> {
    const key = `${sourceId}:${request.kind}`
    const running = this.starting.get(key)
    if (running) return running
    const promise = this.run(sourceId, request).finally(() => this.starting.delete(key))
    this.starting.set(key, promise)
    return promise
  }

  private async run(sourceId: string, request: HandOffRequest): Promise<HandOffResult> {
    const source = this.sessions.session(sourceId)
    const ws = this.workspaces.workspace(source.workspaceId)
    const open = this.store.state.sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt).length
    if (open >= MAX_OPEN_TABS) throw new Error(`Maximum of ${MAX_OPEN_TABS} chats per workspace. Close one first.`)
    if (!request.message.trim()) throw new Error('Write a first message')

    // What was previewed has to be what is sent.
    const now = await this.gather(sourceId, request.kind)
    if (request.kind === 'continue') {
      const eligibility = continueEligibility(source, now.items)
      if (!eligibility.ok) return { stale: `${eligibility.reason} Continue is no longer available here.` }
    }
    const sections: ContextSection[] = []
    if (request.taskTurnId) {
      const task = now.tasks.find((t) => t.turnId === request.taskTurnId)
      if (!task || task.hash !== request.expect.task) return { stale: 'The chat changed since this preview (a message was rewound or edited).' }
      sections.push({ kind: 'task', label: 'Task', text: task.text })
    }
    if (request.answer) {
      if (!now.answer || now.answer.hash !== request.expect.answer) return { stale: 'The chat’s last answer changed since this preview.' }
      const label = modelInfo(source.agent, source.model).label
      sections.push({ kind: 'answer', label: `Last answer from ${label}`, text: now.answer.text })
    }
    if (request.diff) {
      if (!now.diff || now.diff.hash !== request.expect.diff) return { stale: 'The files changed since this preview.' }
      sections.push({ kind: 'diff', label: now.diff.stat ? `Diff stat against ${now.diff.baseRef}` : `Diff against ${now.diff.baseRef}`, text: now.diff.text })
    }

    const assembled = assembleHandOff(request.message, sections)
    const attachments: Attachment[] = []
    if (request.kind === 'review') {
      const prompts = this.workspaces.settingsFor(ws.repoId).prompts
      const instructions = reviewInstructions({ base: ws.baseBranch, customPrompt: prompts.codeReview, hasDiffTool: request.model.agent === 'claude' })
      attachments.push(await attachFromData(workspaceTarget(ws, { wake: true }), 'Review request.md', toBase64(instructions)))
    }
    // A cloud workspace's go into its sandbox.
    for (const file of assembled.attachments) attachments.push(await attachFromData(workspaceTarget(ws, { wake: true }), file.name, toBase64(file.content)))

    try {
      const session = await this.sessions.handOff(sourceId, {
        model: request.model,
        text: assembled.text,
        attachments,
        title: request.kind === 'continue' ? (source.title ? `${source.title} (continued)` : 'Continued chat') : TITLES[request.kind],
        // #16: enforced by the session (refused for an agent that can't enforce it).
        readOnly: request.readOnly || undefined,
        // The last look, right before the tab is created: the attachments above took a moment.
        guard: async () => {
          if (request.kind !== 'continue') return
          const eligibility = continueEligibility(source, await this.store.readChat(sourceId))
          if (!eligibility.ok) throw new StaleHandOff(`${eligibility.reason} Continue is no longer available here.`)
        }
      })
      return { session }
    } catch (err) {
      if (err instanceof StaleHandOff) return { stale: err.message }
      throw err
    }
  }
}
