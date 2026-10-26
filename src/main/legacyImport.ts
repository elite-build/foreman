// First launch on foreman.db: bring state.json and the per-session NDJSON logs
// into it. Nothing is written to the live files until the new database has been
// checked, and the originals move to legacy/ only after it is in place, so a
// crash at any point leaves something that can simply be run again.
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ChatItem, DiffComment, Session, Workspace } from '../shared/types'
import { ForemanDb, type DbCounts } from './db'

export interface MalformedRecord {
  file: string
  line?: number
  reason: string
}

export interface MigrationInfo {
  status: 'migrated' | 'fresh'
  at: string
  counts: DbCounts
  malformed: MalformedRecord[]
  warnings: string[]
}

interface LegacyState {
  repos?: { id: string }[]
  workspaces?: Workspace[]
  sessions?: Session[]
  comments?: DiffComment[]
}

export const dbPath = (dir: string) => path.join(dir, 'foreman.db')
export const markerPath = (dir: string) => path.join(dir, 'migration.json')
export const legacyDir = (dir: string) => path.join(dir, 'legacy')

async function removeDbFiles(file: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(file + suffix, { force: true })
}

/**
 * Replay one NDJSON log: a later line with the same id replaces the earlier one in
 * place, exactly as Store.readChat did. Lines that are not items are reported.
 */
export function parseChatLog(text: string, file: string, malformed: MalformedRecord[]): ChatItem[] {
  const byId = new Map<string, ChatItem>()
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return
    let item: unknown
    try {
      item = JSON.parse(line)
    } catch {
      malformed.push({ file, line: index + 1, reason: 'not valid JSON' })
      return
    }
    const o = item as Partial<ChatItem> | null
    if (!o || typeof o !== 'object' || typeof o.id !== 'string' || typeof o.kind !== 'string') {
      malformed.push({ file, line: index + 1, reason: 'not a chat item' })
      return
    }
    byId.set(o.id, o as ChatItem)
  })
  return [...byId.values()]
}

/** Whether there is anything from before foreman.db to bring over. */
export async function hasLegacyData(dir: string): Promise<boolean> {
  if (existsSync(path.join(dir, 'state.json'))) return true
  const sessions = path.join(dir, 'sessions')
  if (!existsSync(sessions)) return false
  return (await readdir(sessions)).some((f) => f.endsWith('.ndjson'))
}

async function readLegacyState(dir: string): Promise<LegacyState> {
  const file = path.join(dir, 'state.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(await readFile(file, 'utf8')) as LegacyState
  } catch (err) {
    throw new Error(`state.json could not be read (${err instanceof Error ? err.message : err}). Nothing was changed; fix or move the file and start Foreman again.`)
  }
}

function unique<T extends { id: string }>(rows: T[] | undefined, what: string, warnings: string[]): T[] {
  const byId = new Map<string, T>()
  for (const row of rows ?? []) {
    if (!row || typeof row.id !== 'string') {
      warnings.push(`A ${what} without an id was skipped`)
      continue
    }
    if (byId.has(row.id)) warnings.push(`Two ${what}s share the id ${row.id}; the later one was kept`)
    byId.set(row.id, row)
  }
  return [...byId.values()]
}

/** Build foreman.db.tmp from the legacy files and check it. Throws, leaving the originals untouched, when it does not add up. */
async function buildTemp(dir: string, tmp: string): Promise<MigrationInfo> {
  const state = await readLegacyState(dir)
  const malformed: MalformedRecord[] = []
  const warnings: string[] = []
  const workspaces = unique(state.workspaces, 'workspace', warnings)
  const sessions = unique(state.sessions, 'session', warnings)
  const comments = unique(state.comments, 'comment', warnings)

  const chats = new Map<string, ChatItem[]>()
  const sessionsDir = path.join(dir, 'sessions')
  const files = existsSync(sessionsDir) ? (await readdir(sessionsDir)).filter((f) => f.endsWith('.ndjson')) : []
  const known = new Set(sessions.map((s) => s.id))
  for (const file of files) {
    const id = file.slice(0, -'.ndjson'.length)
    if (!known.has(id)) {
      warnings.push(`Chat log ${file} belongs to no session and was not imported (it stays in legacy/)`)
      continue
    }
    chats.set(id, parseChatLog(await readFile(path.join(sessionsDir, file), 'utf8'), `sessions/${file}`, malformed))
  }

  const wsIds = new Set(workspaces.map((w) => w.id))
  const repoIds = new Set((state.repos ?? []).map((r) => r.id))
  for (const s of sessions) if (!wsIds.has(s.workspaceId)) warnings.push(`Session ${s.id} points at a missing workspace`)
  for (const c of comments) if (!wsIds.has(c.workspaceId)) warnings.push(`A comment points at the missing workspace ${c.workspaceId}`)
  for (const w of workspaces) if (w.repoId && !repoIds.has(w.repoId)) warnings.push(`Workspace ${w.id} points at a missing repository`)

  await removeDbFiles(tmp)
  const db = new ForemanDb(tmp)
  let counts: DbCounts
  try {
    db.importRows({ workspaces, sessions, comments }, chats)
    counts = db.counts()
    const expectedItems = [...chats.values()].reduce((n, items) => n + items.length, 0)
    const expectedChecks = workspaces.reduce((n, w) => n + (w.checks?.results.length ?? 0), 0)
    const expected: DbCounts = { workspaces: workspaces.length, sessions: sessions.length, comments: comments.length, items: expectedItems, checks: expectedChecks }
    for (const key of Object.keys(expected) as (keyof DbCounts)[]) {
      if (counts[key] !== expected[key]) throw new Error(`Migration check failed: expected ${expected[key]} ${key} but the new database has ${counts[key]}.`)
    }
    const integrity = db.integrityCheck()
    if (integrity !== 'ok') throw new Error(`Migration check failed: integrity_check said ${integrity}.`)
    db.checkpoint()
  } catch (err) {
    db.close()
    await removeDbFiles(tmp)
    throw err
  }
  db.close()
  for (const suffix of ['-wal', '-shm']) await rm(tmp + suffix, { force: true })
  return { status: 'migrated', at: new Date().toISOString(), counts, malformed, warnings }
}

/** Move the originals aside. Safe to repeat: whatever is already moved stays moved. */
async function moveOriginals(dir: string): Promise<void> {
  const legacy = legacyDir(dir)
  await mkdir(legacy, { recursive: true })
  const state = path.join(dir, 'state.json')
  // state.json is rewritten with preferences only, so the full copy goes first.
  if (existsSync(state) && !existsSync(path.join(legacy, 'state.json'))) await copyFile(state, path.join(legacy, 'state.json'))
  const sessions = path.join(dir, 'sessions')
  if (existsSync(sessions)) {
    await mkdir(path.join(legacy, 'sessions'), { recursive: true })
    for (const file of await readdir(sessions)) await rename(path.join(sessions, file), path.join(legacy, 'sessions', file))
    await rm(sessions, { recursive: true, force: true })
  }
}

async function writeMarker(dir: string, info: MigrationInfo): Promise<void> {
  const tmp = `${markerPath(dir)}.tmp`
  await writeFile(tmp, JSON.stringify(info, null, 2))
  await rename(tmp, markerPath(dir))
}

export async function readMarker(dir: string): Promise<MigrationInfo | undefined> {
  try {
    return JSON.parse(await readFile(markerPath(dir), 'utf8')) as MigrationInfo
  } catch {
    return undefined
  }
}

export interface MigrationOutcome {
  info: MigrationInfo
  // The legacy files were moved just now, so state.json must be rewritten without them.
  moved: boolean
}

/**
 * Make sure foreman.db exists and is complete. Nothing else may write to the data
 * folder while this runs (it happens before the store is used).
 */
export async function ensureDatabase(dir: string): Promise<MigrationOutcome> {
  const file = dbPath(dir)
  const existing = await readMarker(dir)
  if (existing && existsSync(file)) return { info: existing, moved: false }

  const tmp = `${file}.tmp`
  let info: MigrationInfo
  if (existsSync(file)) {
    // Renamed into place but the run stopped before the marker. The database was validated before the rename and nothing has written to it since.
    const db = new ForemanDb(file)
    try {
      if (db.integrityCheck() !== 'ok') throw new Error('foreman.db failed its integrity check.')
      info = { status: 'migrated', at: new Date().toISOString(), counts: db.counts(), malformed: [], warnings: ['The first migration was interrupted after the database was created; it was finished on the next start.'] }
    } finally {
      db.close()
    }
  } else if (await hasLegacyData(dir)) {
    info = await buildTemp(dir, tmp)
    await rename(tmp, file)
  } else {
    await removeDbFiles(tmp)
    const db = new ForemanDb(tmp)
    db.checkpoint()
    db.close()
    for (const suffix of ['-wal', '-shm']) await rm(tmp + suffix, { force: true })
    await rename(tmp, file)
    const db2 = new ForemanDb(file)
    const counts = db2.counts()
    db2.close()
    info = { status: 'fresh', at: new Date().toISOString(), counts, malformed: [], warnings: [] }
  }
  const moved = info.status === 'migrated'
  if (moved) await moveOriginals(dir)
  await writeMarker(dir, info)
  return { info, moved }
}

/** Size of everything kept in legacy/, for the Data page. */
export async function legacyFiles(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const walk = async (d: string): Promise<void> => {
    if (!existsSync(d)) return
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) await walk(p)
      else {
        files++
        bytes += (await stat(p)).size
      }
    }
  }
  await walk(legacyDir(dir))
  return { files, bytes }
}
