// The SDK's SessionStore, backed by foreman.db. Claude Code writes its transcript
// locally and mirrors every batch here, so Foreman can move a conversation to another
// machine (native resume). Mirror failures are counted, never hidden: a session is
// "complete" only when nothing failed and every subagent transcript is present.
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { expectedSubpaths, mirrorComplete, mirrorGap, projectKeyFor, type MirrorFacts, type MirrorSummary, type TranscriptFile } from '../shared/claudeMirror'
import type { ForemanDb } from './db'

export class ClaudeMirror implements SessionStore {
  // The database is opened by the store's load(); looked up when needed.
  constructor(private getDb: () => ForemanDb) {}

  private get db(): ForemanDb {
    return this.getDb()
  }

  // ---- SessionStore ----

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.db.mirrorAppend(key, entries)
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return this.db.mirrorLoad(key) as SessionStoreEntry[] | null
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    return this.db.mirrorSessions(projectKey)
  }

  async delete(key: SessionKey): Promise<void> {
    this.db.mirrorDelete(key)
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return this.db.mirrorSubpaths(key.sessionId)
  }

  // ---- what Foreman does with it ----

  recordError(sessionId: string, subpath: string | undefined, error: string): void {
    this.db.mirrorAddError(sessionId, subpath, error)
  }

  summary(): MirrorSummary {
    return { sessions: this.db.mirrorSessionCount(), errors: this.db.mirrorErrorCount() }
  }

  facts(sessionId: string): MirrorFacts {
    const main = this.db.mirrorLoad({ projectKey: '', sessionId })
    return { hasMain: this.db.mirrorHasMain(sessionId), subpaths: this.db.mirrorSubpaths(sessionId), expected: main ? expectedSubpaths(main) : [], errors: this.db.mirrorErrorCount(sessionId) }
  }

  isComplete(sessionId: string): boolean {
    return mirrorComplete(this.facts(sessionId))
  }

  gap(sessionId: string): string | null {
    return mirrorGap(this.facts(sessionId))
  }

  /** The stored transcript of a session, main and subagents, for an export. */
  read(sessionId: string): TranscriptFile | null {
    const main = this.db.mirrorLoad({ projectKey: '', sessionId })
    if (!main) return null
    const parts: TranscriptFile['parts'] = [{ entries: main }]
    for (const subpath of this.db.mirrorSubpaths(sessionId)) {
      const entries = this.db.mirrorLoad({ projectKey: '', sessionId, subpath })
      if (entries) parts.push({ subpath, entries })
    }
    return { sessionId, parts }
  }

  /** Store an imported transcript under a key that no folder owns yet (see `adopt`). */
  write(file: TranscriptFile, projectKey: string): void {
    for (const part of file.parts) this.db.mirrorAppend({ projectKey, sessionId: file.sessionId, subpath: part.subpath }, part.entries)
  }

  /** An imported session's transcript now belongs to the folder it will run in. */
  adopt(pendingKey: string, cwd: string, sessionIds: string[]): void {
    this.db.mirrorRekey(pendingKey, projectKeyFor(cwd), sessionIds)
  }

  forget(sessionId: string): void {
    this.db.mirrorForget(sessionId)
  }
}

export const pendingKey = (workspaceId: string) => `pending:${workspaceId}`
