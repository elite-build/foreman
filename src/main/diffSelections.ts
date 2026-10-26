// #15 Diff selection actions. Explain / Change this / Ask on selected diff lines
// make an ordinary diff comment that quotes them, sent to the tab the user
// picked through the usual send path. Right before it goes, the lines are read
// again; if they changed the comment is held (never sent silently). While the
// tab is busy the comment waits here and is checked when its turn comes.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { checkSelection, editorsSince, selectionMessage } from '../shared/diffSelection'
import type { ChatItem, DiffComment, DiffSelection, SelectionSendResult, Session, Workspace } from '../shared/types'
import { branchPoint } from './diff'
import { git, revParse } from './git'
import { workspaceTarget } from './runtime'

export interface DiffSelectionDeps {
  comments(): DiffComment[]
  sessions(): Session[]
  workspace(id: string): Workspace
  // The usual send to a tab (it waits behind a running turn there).
  send(sessionId: string, text: string): Promise<unknown>
  createSession(workspaceId: string): Session
  changed(): void
  // The text of the selection's side as it is now: the working tree (new) or the base (old); null when it isn't there.
  current?(ws: Workspace, file: string, selection: DiffSelection): Promise<string | null>
  // G2: a tab's chat, to say which tab changed held lines ("Changed by Tab 2").
  readChat?(sessionId: string): Promise<ChatItem[]>
  now?(): Date
}

/**
 * The file on the selection's side now: the working tree for the new side, the base it is compared with for the old.
 * A cloud workspace's are read in its sandbox.
 */
export async function currentSide(ws: Workspace, file: string, selection: DiffSelection): Promise<string | null> {
  const dir = workspaceTarget(ws)
  if (selection.side === 'new') {
    if (typeof dir !== 'string') return dir.readFile(file).then((data) => data?.toString('utf8') ?? null, () => null)
    return readFile(path.join(dir, file), 'utf8').catch(() => null)
  }
  const base = selection.scope === 'uncommitted' ? ((await revParse(dir, 'HEAD')) ?? '') : (await branchPoint(ws, dir)).mergeBase
  if (!base) return null
  const shown = await git(dir, ['show', `${base}:${selection.oldPath ?? file}`], { allowFail: true })
  return shown.code === 0 ? shown.stdout : null
}

const idle = (s: Session) => s.status === 'idle' && !s.turnId && s.queue.length === 0

export class DiffSelectionService {
  constructor(private deps: DiffSelectionDeps) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }

  private read(ws: Workspace, file: string, selection: DiffSelection): Promise<string | null> {
    return (this.deps.current ?? currentSide)(ws, file, selection)
  }

  /** A new selection comment for `sessionId` ('new' opens a tab), checked and sent, queued or held. */
  async send(workspaceId: string, draft: { file: string; body: string; selection: DiffSelection }, sessionId: string): Promise<SelectionSendResult> {
    if (!draft.body.trim()) throw new Error('Write something to send')
    this.deps.workspace(workspaceId)
    const comment: DiffComment = {
      id: randomUUID(),
      workspaceId,
      file: draft.file,
      line: draft.selection.end,
      body: draft.body.trim(),
      author: 'user',
      state: 'held',
      createdAt: this.now(),
      selection: draft.selection,
      sessionId: sessionId === 'new' ? undefined : sessionId
    }
    this.deps.comments().push(comment)
    this.deps.changed()
    return this.dispatch(comment, 'check', sessionId)
  }

  /** A held comment: check and send it, send it as selected (marked outdated), or quote the lines as they are now. */
  async resend(commentId: string, how: 'check' | 'selected' | 'current', sessionId?: string): Promise<SelectionSendResult> {
    const comment = this.deps.comments().find((c) => c.id === commentId)
    if (!comment?.selection) throw new Error('That comment is gone')
    if (comment.state !== 'held') throw new Error('That comment has already gone to its tab')
    if (how === 'current') {
      const ws = this.deps.workspace(comment.workspaceId)
      const content = await this.read(ws, comment.file, comment.selection)
      const fresh = checkSelection(comment.selection, content)
      if (fresh.stale) {
        if (!fresh.lines.length) throw new Error('Those lines aren’t in the file any more')
        comment.selection = { ...comment.selection, lines: fresh.lines, end: comment.selection.start + fresh.lines.length - 1, blobId: undefined, at: this.now() }
        comment.line = comment.selection.end
      }
      comment.stale = undefined
      comment.outdated = undefined
      this.deps.changed()
      return { status: 'held', commentId, sessionId: comment.sessionId }
    }
    return this.dispatch(comment, how, sessionId ?? comment.sessionId ?? 'new')
  }

  /** A tab may be free now: send the oldest comment waiting for it. */
  wake(sessionId: string): void {
    const session = this.deps.sessions().find((s) => s.id === sessionId)
    if (!session || session.closedAt || !idle(session)) return
    const next = this.deps.comments().find((c) => c.state === 'queued' && c.sessionId === sessionId)
    if (next) void this.dispatch(next, next.outdated ? 'selected' : 'check', sessionId).catch(() => undefined)
  }

  /** After a restart nothing sends on its own: comments that were waiting are held for the user to send again. */
  holdWaiting(): void {
    let any = false
    for (const c of this.deps.comments()) {
      if (c.state === 'queued') {
        c.state = 'held'
        any = true
      }
    }
    if (any) this.deps.changed()
  }

  /** G2: the tabs whose turns touched the comment's file since it was selected, when chats can be read. */
  private async changedBy(comment: DiffComment): Promise<{ changedBy?: string[] }> {
    const readChat = this.deps.readChat
    // The old side changes when the base moves, which no file edit explains; only the new side is attributed.
    if (!readChat || comment.selection?.side !== 'new') return {}
    const tabs = this.deps.sessions().filter((s) => s.workspaceId === comment.workspaceId)
    try {
      const chats = await Promise.all(tabs.map(async (s) => ({ sessionId: s.id, items: await readChat(s.id).catch(() => [] as ChatItem[]) })))
      return { changedBy: editorsSince(comment.file, comment.selection.at, chats) }
    } catch {
      return {}
    }
  }

  private async dispatch(comment: DiffComment, how: 'check' | 'selected', target: string): Promise<SelectionSendResult> {
    const result = (status: SelectionSendResult['status']): SelectionSendResult => ({ status, commentId: comment.id, sessionId: comment.sessionId })
    const hold = (stale?: DiffComment['stale']) => {
      comment.state = 'held'
      comment.stale = stale
      this.deps.changed()
      return result('held')
    }
    const ws = this.deps.workspace(comment.workspaceId)
    const selection = comment.selection!
    if (how === 'check') {
      const fresh = checkSelection(selection, await this.read(ws, comment.file, selection))
      if (fresh.stale) return hold({ lines: fresh.lines, checkedAt: this.now(), ...(await this.changedBy(comment)) })
      comment.outdated = undefined
    } else {
      comment.outdated = true
    }
    comment.stale = undefined

    const open = this.deps.sessions().filter((s) => s.workspaceId === comment.workspaceId && !s.closedAt)
    let session = target === 'new' ? undefined : open.find((s) => s.id === target)
    if (target !== 'new' && !session) {
      hold()
      throw new Error('The selected chat is no longer open')
    }
    session ??= this.deps.createSession(comment.workspaceId)
    comment.sessionId = session.id
    // Busy: wait here and be checked again when the tab is free.
    if (!idle(session)) {
      comment.state = 'queued'
      this.deps.changed()
      return result('queued')
    }
    comment.state = 'sent'
    comment.sentAt = this.now()
    this.deps.changed()
    try {
      await this.deps.send(session.id, selectionMessage(comment))
    } catch (err) {
      comment.sentAt = undefined
      hold()
      throw err
    }
    return result('sent')
  }
}
