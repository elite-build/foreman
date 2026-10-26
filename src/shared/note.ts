// The workspace note: guidance the person wrote once for a workspace, shared by its tabs. Saving only
// records a new revision; it reaches a chat when someone chooses to send it.
import type { Session, WorkspaceNote } from './types'

export const NOTE_MAX_CHARS = 20_000

/** The note after saving `text`: unchanged text keeps its revision, anything else is the next one. */
export function savedNote(prev: WorkspaceNote | undefined, text: string, now: string): WorkspaceNote | undefined {
  const clean = text.slice(0, NOTE_MAX_CHARS)
  if (!prev && !clean.trim()) return undefined
  if (prev && prev.text === clean) return prev
  return { text: clean, revision: (prev?.revision ?? 0) + 1, updatedAt: now }
}

/** True when there is something to deliver (an emptied note has nothing). */
export const hasNote = (note: WorkspaceNote | undefined): note is WorkspaceNote => Boolean(note?.text.trim())

/**
 * Where a tab stands with the note: no note; it will go with the tab's first message (Include note);
 * the tab has the current revision; or it has an older one (or none).
 */
export type NoteStanding = 'none' | 'pending' | 'current' | 'stale'
export function noteStanding(note: WorkspaceNote | undefined, session: Pick<Session, 'noteRevision' | 'includeNote'>): NoteStanding {
  if (!hasNote(note)) return 'none'
  if (session.includeNote) return 'pending'
  if (session.noteRevision !== undefined && session.noteRevision >= note.revision) return 'current'
  return 'stale'
}

/** The text of a message that delivers the note on its own ("Send updated note to this tab"). */
export function noteMessage(note: WorkspaceNote): string {
  return `Workspace note (r${note.revision}), guidance for this workspace. It replaces any earlier revision:\n\n${note.text.trim()}`
}

/** The note as Foreman appends it to a message when Include note is on. */
export function noteBlock(note: WorkspaceNote): string {
  return `\n\nThe user's workspace note (r${note.revision}), guidance for this workspace:\n${note.text.trim()}`
}
