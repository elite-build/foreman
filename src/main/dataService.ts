// The Data & devices page: what foreman.db is, backups of it, and the legacy
// files kept after the migration.
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { BackupResult, DataInfo } from '../shared/types'
import { usageReport, type UsageReport } from '../shared/usageReport'
import { otherAgentTurns } from '../shared/switchAgent'
import { legacyDir, legacyFiles } from './legacyImport'
import type { ClaudeMirror } from './claudeMirror'
import type { Store } from './store'

const DAY_MS = 24 * 3600 * 1000
const KEEP_AUTOMATIC = 7

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

export class DataService {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<BackupResult> | null = null

  constructor(
    private store: Store,
    private now: () => Date = () => new Date(),
    private mirror?: ClaudeMirror
  ) {}

  folder(): string {
    return this.store.state.settings.backupFolder.trim() || path.join(this.store.dir, 'backups')
  }

  async info(): Promise<DataInfo> {
    const db = this.store.db
    const size = (file: string) => (existsSync(file) ? statSync(file).size : 0)
    const marker = this.store.migration
    const at = db.getMeta('lastBackupAt')
    const file = db.getMeta('lastBackupFile')
    return {
      path: this.store.dbPath,
      dataFolder: this.store.dir,
      sizeBytes: size(this.store.dbPath) + size(`${this.store.dbPath}-wal`),
      messages: db.messageCount(),
      migration: marker
        ? { status: marker.status, at: marker.at, counts: marker.counts, malformed: marker.malformed.length, malformedSample: marker.malformed.slice(0, 5), warnings: marker.warnings.slice(0, 5) }
        : undefined,
      legacy: await legacyFiles(this.store.dir),
      backupFolder: this.folder(),
      lastBackup: at && file ? { at, path: file } : undefined,
      claudeTranscripts: this.mirror ? await this.transcripts(this.mirror) : { sessions: 0, errors: 0 }
    }
  }

  /**
   * O1 (G1): chats with a Claude conversation that other agents answered part of. Claude's own transcript doesn't hold
   * those turns, so its mirror counts as incomplete for them (an export already leaves it out).
   */
  private async transcripts(mirror: ClaudeMirror): Promise<DataInfo['claudeTranscripts']> {
    const partial = await this.switchedClaudeChats()
    return partial ? { ...mirror.summary(), partial } : mirror.summary()
  }

  private async switchedClaudeChats(): Promise<number> {
    let count = 0
    for (const s of this.store.state.sessions) {
      const claude = (s.agent === 'claude' && s.agentSessionId) || s.parked?.claude
      if (!claude) continue
      if (otherAgentTurns(await this.store.readChat(s.id), 'claude') > 0) count++
    }
    return count
  }

  /** Cost, turns and agent time over the last `days` days (7, 30 or 90). */
  usage(days: number): UsageReport {
    const now = this.now()
    const { sessions, workspaces } = this.store.state
    return usageReport({
      rows: this.store.db.usageRows(new Date(now.getTime() - days * DAY_MS).toISOString()),
      sessions: sessions.map((s) => ({ id: s.id, workspaceId: s.workspaceId, agent: s.agent, model: s.model, createdAt: s.createdAt })),
      workspaces: workspaces.map((w) => ({ id: w.id, repoId: w.repoId, imported: Boolean(w.provenance), createdAt: w.createdAt })),
      days,
      now
    })
  }

  /** Copy the database (a consistent snapshot, while the app keeps writing) plus a manifest of the attachment files it refers to. */
  backupNow(automatic = false): Promise<BackupResult> {
    this.running ??= this.backup(automatic).finally(() => {
      this.running = null
    })
    return this.running
  }

  private async backup(automatic: boolean): Promise<BackupResult> {
    const folder = this.folder()
    await mkdir(folder, { recursive: true })
    this.store.flush()
    const now = this.now()
    const base = `foreman-${automatic ? 'auto-' : ''}${stamp(now)}`
    const file = path.join(folder, `${base}.db`)
    this.store.db.backupTo(file)
    const attachments: { path: string; session: string; size?: number; modified?: string; missing?: boolean }[] = []
    const seen = new Set<string>()
    for (const ref of this.store.db.attachmentRefs()) {
      if (seen.has(ref.path)) continue
      seen.add(ref.path)
      try {
        const s = await stat(ref.path)
        attachments.push({ path: ref.path, session: ref.sessionId, size: s.size, modified: s.mtime.toISOString() })
      } catch {
        attachments.push({ path: ref.path, session: ref.sessionId, missing: true })
      }
    }
    const manifest = path.join(folder, `${base}.manifest.json`)
    await writeFile(manifest, JSON.stringify({ createdAt: now.toISOString(), database: path.basename(file), messages: this.store.db.messageCount(), attachments }, null, 2))
    this.store.db.setMeta('lastBackupAt', now.toISOString())
    this.store.db.setMeta('lastBackupFile', file)
    if (automatic) await this.prune(folder)
    return { path: file, manifest, attachments: attachments.length, missingAttachments: attachments.filter((a) => a.missing).length, at: now.toISOString() }
  }

  private async prune(folder: string): Promise<void> {
    const old = (await readdir(folder)).filter((f) => /^foreman-auto-.*\.db$/.test(f)).sort().slice(0, -KEEP_AUTOMATIC)
    for (const f of old) await rm(path.join(folder, f), { force: true }).then(() => rm(path.join(folder, f.replace(/\.db$/, '.manifest.json')), { force: true }))
  }

  /** Back up if the daily backup is on and the last one is a day old. */
  async backupIfDue(): Promise<BackupResult | undefined> {
    if (!this.store.state.settings.dailyBackup) return undefined
    const last = this.store.db.getMeta('lastBackupAt')
    if (last && this.now().getTime() - new Date(last).getTime() < DAY_MS) return undefined
    return this.backupNow(true)
  }

  start(): void {
    const tick = () => void this.backupIfDue().catch(() => undefined)
    setTimeout(tick, 30_000).unref()
    this.timer = setInterval(tick, 30 * 60_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async deleteLegacy(): Promise<void> {
    await rm(legacyDir(this.store.dir), { recursive: true, force: true })
  }
}
