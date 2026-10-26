// Terminal tabs saved for after a restart (O3): terminals.json in Foreman's data
// folder, never in a repository. The renderer sends each workspace's tabs (names,
// zoom and the end of their output) as they change; this keeps them in memory,
// writes them a moment later and once more at quit. Turning "Restore terminals"
// off deletes the file. Processes are never saved: only what they printed.
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { capSavedTerminals, emptySavedTerminals, parseSavedTerminals, parseTabs, type SavedTerminals, type SavedTerminalTab } from '../shared/terminalTabs'

const WRITE_DELAY_MS = 1000

/** G3 · O3: an absolute folder that exists, or undefined (a folder a shell reported may be gone, or not a path here). */
export function existingFolder(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) return undefined
  try {
    return statSync(value).isDirectory() ? value : undefined
  } catch {
    return undefined
  }
}

export class TerminalRestore {
  private data: SavedTerminals = emptySavedTerminals()
  private timer: NodeJS.Timeout | null = null
  private dirty = false
  // G3 · O10: when the last run quit cleanly (the file's quitAt), for this run's restored bands.
  private quitAt: number | undefined

  constructor(
    private readonly file: string,
    private readonly enabled: () => boolean
  ) {}

  /** Read the file once at startup. With restore off, whatever an earlier run left is deleted. */
  load(): void {
    if (!this.enabled()) {
      this.clear()
      return
    }
    try {
      if (existsSync(this.file)) this.data = parseSavedTerminals(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      // Unreadable: start empty; the next save replaces it.
      this.data = emptySavedTerminals()
    }
    // G3 · O10: a clean quit left its time. It holds for this run only, so the file is written again without it
    // (a crash before the next quit must not read as "ended when Foreman quit").
    if (this.data.quitAt) {
      this.quitAt = this.data.quitAt
      const { quitAt: _gone, ...rest } = this.data
      this.data = rest
      this.schedule()
    }
  }

  /** A workspace's saved tabs, or null when nothing was saved for it (it gets its usual first terminal). */
  get(workspaceId: string): SavedTerminalTab[] | null {
    if (!this.enabled()) return null
    const tabs = this.data.workspaces[workspaceId]
    if (!tabs) return null
    const quitAt = this.quitAt
    // A tab saved before the quit ended with it; one saved since (this run) didn't.
    return quitAt ? tabs.map((tab) => (!tab.quitAt && tab.savedAt <= quitAt ? { ...tab, quitAt } : tab)) : tabs
  }

  /** Replace a workspace's tabs (an empty list: every terminal was closed). Ignored while restore is off. */
  put(workspaceId: string, tabs: unknown): void {
    if (!this.enabled()) return
    this.data = capSavedTerminals({ ...this.data, workspaces: { ...this.data.workspaces, [workspaceId]: parseTabs(tabs) } })
    this.schedule()
  }

  /** Archived or removed: its saved output goes too. */
  forget(workspaceId: string): void {
    if (!(workspaceId in this.data.workspaces)) return
    const { [workspaceId]: _gone, ...rest } = this.data.workspaces
    this.data = { ...this.data, workspaces: rest }
    this.schedule()
  }

  /** Restore turned off: drop everything and delete the file. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dirty = false
    this.data = emptySavedTerminals()
    rmSync(this.file, { force: true })
  }

  /** Write now (app quit). G3 · O10: `quitting` stamps the quit's time, so the next launch can say the shells ended with it. */
  flush(quitting = false): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.enabled() || (!this.dirty && !quitting)) return
    if (quitting && !Object.values(this.data.workspaces).some((tabs) => tabs.length)) {
      if (!this.dirty) return
      quitting = false
    }
    this.dirty = false
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(quitting ? { ...this.data, quitAt: Date.now() } : this.data), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.write()
    }, WRITE_DELAY_MS)
    this.timer.unref?.()
  }

  private async write(): Promise<void> {
    if (!this.dirty || !this.enabled()) return
    this.dirty = false
    const tmp = `${this.file}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 })
      await rename(tmp, this.file)
      // Restore was turned off while this was being written.
      if (!this.enabled()) rmSync(this.file, { force: true })
    } catch (err) {
      // Try again with the next change or at quit.
      this.dirty = true
      console.error('Could not save terminal tabs:', err)
    }
  }
}
