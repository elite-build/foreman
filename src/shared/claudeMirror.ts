// Claude transcripts mirrored into foreman.db through the SDK's SessionStore.
// The pure rules: which key a working folder maps to, which subagent transcripts
// a session should have, and when a mirror counts as complete.
import { createT, type TFunction } from './i18n'

const enT = createT('en')

export interface MirrorKey {
  projectKey: string
  sessionId: string
  subpath?: string
}

export interface MirrorSummary {
  // Sessions with a mirrored main transcript.
  sessions: number
  // Mirror failures reported by the SDK (batches that could not be stored).
  errors: number
  // O1 (G1): chats whose Claude session misses turns other agents answered there (switched chats), so their mirror isn't the whole chat.
  partial?: number
}

/** What the SDK calls the project key of a folder: its path with every non-alphanumeric character as "-", hashed when long. */
export function projectKeyFor(cwd: string): string {
  const key = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (key.length <= 200) return key
  let hash = 5381
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) + hash + cwd.charCodeAt(i)) | 0
  return `${key.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

/** Subagent transcript paths the main transcript refers to (one per agent id found in its tool results). */
export function expectedSubpaths(entries: { [k: string]: unknown }[]): string[] {
  const found = new Set<string>()
  for (const entry of entries) {
    const text = JSON.stringify(entry)
    for (const m of text.matchAll(/"agentId":"([A-Za-z0-9_-]+)"/g)) found.add(`subagents/agent-${m[1]}`)
  }
  return [...found].sort()
}

export interface MirrorFacts {
  // The main transcript is stored.
  hasMain: boolean
  // Subagent paths stored for this session.
  subpaths: string[]
  // Subagent paths the main transcript refers to.
  expected: string[]
  errors: number
}

/** Complete only when nothing failed to mirror and every subagent transcript is stored. */
export function mirrorComplete(f: MirrorFacts): boolean {
  return f.hasMain && f.errors === 0 && f.expected.every((p) => f.subpaths.includes(p))
}

/** Why a mirror is not complete, for a sentence in the UI; null when it is. */
export function mirrorGap(f: MirrorFacts, t: TFunction = enT): string | null {
  if (!f.hasMain) return t('claudeMirror.gap.none')
  if (f.errors) return t('claudeMirror.errors', { count: f.errors })
  const missing = f.expected.filter((p) => !f.subpaths.includes(p))
  return missing.length ? t('claudeMirror.gap.missing', { count: missing.length }) : null
}

/** "3 sessions · 0 mirror errors", as Settings → Data shows it. */
export const mirrorSummary = (s: MirrorSummary, t: TFunction = enT) =>
  [t('claudeMirror.sessions', { count: s.sessions }), t('claudeMirror.errors', { count: s.errors }), s.partial ? t('claudeMirror.partial', { count: s.partial }) : ''].filter(Boolean).join(' · ')

export const mirrorLine = (s: MirrorSummary, t: TFunction = enT) => t('claudeMirror.line', { summary: mirrorSummary(s, t) })

/** The transcript parts of one session as they travel in an export. */
export interface TranscriptFile {
  // Claude's own session id.
  sessionId: string
  parts: { subpath?: string; entries: { [k: string]: unknown }[] }[]
}
