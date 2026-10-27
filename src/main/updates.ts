// Is there a newer Foreman (shared/appUpdate.ts)? While Settings → General → Updates checks automatically, an installed
// build asks soon after start, on Settings' schedule (hourly, every 4 hours or daily) and when the computer wakes; Check now
// asks whenever it's pressed. One unauthenticated request to GitHub's public API each time. When this build can install
// updates (main/updateInstaller.ts) and Settings say so, the new version downloads in the background; it installs when the
// user restarts from the sidebar's card or, if chosen, whenever Foreman quits. Otherwise the card opens the release page.
import {
  LATEST_RELEASE_API,
  newerRelease,
  newestRelease,
  RELEASES_API,
  releaseApi,
  releaseNotes,
  UPDATE_INTERVAL_HOURS,
  wasUpdated,
  type AvailableUpdate,
  type InstallUnavailable,
  type ReleaseNotes,
  type UpdateChannel,
  type UpdateCheckResult,
  type UpdateInterval,
  type UpdateMode,
  type UpdatePhase,
  type UpdateView
} from '../shared/appUpdate'

type Fetch = typeof fetch

// GitHub's API is quick; a slow network shouldn't keep a check hanging.
const TIMEOUT_MS = 10_000
// Waking checks only when the last check is older than this, so a laptop opened and closed doesn't ask each time.
const WAKE_GAP_MS = 15 * 60_000
// Download progress redraws the window at most this often.
const PROGRESS_MS = 1_000

/** Downloads and installs an update (main/updateInstaller.ts); a stand-in in tests. */
export interface UpdateInstaller {
  /** Why this build can't install updates itself, or null when it can. */
  unavailable(): Promise<InstallUnavailable | null>
  /** Download `version` from the update feed. Rejects when the feed doesn't offer it, on failure, or when cancelled. */
  download(version: string, prerelease: boolean, progress: (transferred: number, total: number) => void): Promise<void>
  cancel(): void
  /** Whether the downloaded update installs when Foreman quits. */
  installOnQuit(on: boolean): void
}

export interface UpdateDeps {
  // The running version (app.getVersion()); absent in tests and builds without a host.
  currentVersion: () => string | undefined
  // Settings → General → Updates: checkForUpdates, updateInterval, updateMode, updateChannel.
  enabled: () => boolean
  interval?: () => UpdateInterval
  mode?: () => UpdateMode
  channel?: () => UpdateChannel
  // The version "Skip this version" saved, if any.
  skipped: () => string | undefined
  setSkipped: (version: string) => void
  // The version Foreman last ran as, for "Updated to …" after an update.
  lastRun?: () => string | undefined
  setLastRun?: (version: string) => void
  // The notice changed: broadcast the state again.
  changed: () => void
  installer?: UpdateInstaller
  fetch?: Fetch
  now?: () => number
}

export class UpdateCheck {
  private found: AvailableUpdate | null = null
  // "Later": hidden until Foreman starts again.
  private dismissed = false
  private running: Promise<UpdateCheckResult> | null = null
  private phase: UpdatePhase = { state: 'available' }
  private lastChecked?: number
  private lastResult?: UpdateView['lastResult']
  // Scheduled checks run only after start() (an installed build); tests and development builds check when asked.
  private started = false
  private timer?: ReturnType<typeof setTimeout>
  private nextAt?: number
  // undefined until the installer has answered.
  private reason?: InstallUnavailable | null
  private downloading: Promise<void> | null = null
  private cancelled = false
  private progressAt = 0
  // "Install when I quit" on the card (the mode can also say so).
  private onQuitChosen = false
  private updatedFrom?: string

  constructor(private deps: UpdateDeps) {
    const current = deps.currentVersion()
    const last = deps.lastRun?.()
    if (wasUpdated(last, current)) this.updatedFrom = last
    if (current && current !== last) deps.setLastRun?.(current)
    if (deps.installer) {
      void deps.installer.unavailable().then(
        (reason) => {
          this.reason = reason
          deps.changed()
        },
        () => (this.reason = 'unsupported')
      )
    } else this.reason = 'unsupported'
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private mode(): UpdateMode {
    return this.deps.mode?.() ?? 'notify'
  }

  private canInstall(): boolean {
    return Boolean(this.deps.installer) && this.reason === null
  }

  private onQuit(): boolean {
    return this.mode() === 'quit' || this.onQuitChosen
  }

  /** What the window shows: the sidebar's card and Settings' status line. */
  view(): UpdateView {
    const offered = this.found && !this.dismissed && this.found.version !== this.deps.skipped()
    return {
      ...(offered && this.found ? { notice: { ...this.found, phase: this.phase } } : {}),
      checking: Boolean(this.running),
      ...(this.lastChecked !== undefined ? { lastChecked: new Date(this.lastChecked).toISOString() } : {}),
      ...(this.lastResult ? { lastResult: this.lastResult } : {}),
      ...(this.found ? { latest: this.found } : {}),
      ...(this.nextAt !== undefined ? { nextCheck: new Date(this.nextAt).toISOString() } : {}),
      ...(this.canInstall() ? {} : { installUnavailable: this.reason ?? 'unsupported' }),
      ...(this.updatedFrom ? { updatedFrom: this.updatedFrom } : {})
    }
  }

  /** An installed build at launch: a check while automatic checks are on, then the schedule. */
  async start(): Promise<void> {
    this.started = true
    if (!this.deps.enabled()) return this.schedule()
    const result = await this.check()
    if (result.state === 'failed') console.warn('Could not check for a newer Foreman.')
  }

  /** The computer woke: check when one is due soon or overdue (timers don't run while it sleeps). */
  woke(): void {
    if (!this.started || !this.deps.enabled()) return
    if (this.lastChecked === undefined || this.now() - this.lastChecked >= WAKE_GAP_MS) void this.check()
  }

  /** Settings → General → Updates changed: the schedule, the channel or what to do with a release. */
  settingsChanged(changed: { channel?: boolean } = {}): void {
    // A different channel offers different releases; checks turned on for the first time ask at once.
    if (this.started && this.deps.enabled() && (changed.channel || this.lastChecked === undefined)) {
      void this.check()
      return
    }
    this.schedule()
    if (this.phase.state === 'ready') this.deps.installer?.installOnQuit(this.onQuit())
    if (this.phase.state === 'ready' && this.phase.onQuit !== this.onQuit()) {
      this.phase = { state: 'ready', onQuit: this.onQuit() }
      this.deps.changed()
    }
    this.autoDownload()
  }

  /** Ask GitHub now. A check already under way is shared rather than repeated. */
  check(): Promise<UpdateCheckResult> {
    if (!this.running) {
      this.running = this.ask().finally(() => {
        this.running = null
        this.schedule()
        this.deps.changed()
      })
      this.deps.changed()
    }
    return this.running
  }

  /** The notice's Later (until the next start) or Skip this version (until a newer one is out). */
  dismiss(skip: boolean): void {
    if (skip && this.found) {
      this.deps.setSkipped(this.found.version)
      this.stopDownload()
      if (this.phase.state === 'ready') this.deps.installer?.installOnQuit(false)
    } else this.dismissed = true
    this.deps.changed()
  }

  /** The card's Download where this build can install: fetch the offered release in the background. */
  download(): Promise<void> {
    const update = this.found
    if (!update || !this.deps.installer || !this.canInstall()) return Promise.reject(new Error('This copy of Foreman can’t install updates itself.'))
    if (this.downloading) return this.downloading
    if (this.phase.state !== 'available') return Promise.resolve()
    const installer = this.deps.installer
    const mine = () => this.found?.version === update.version
    this.cancelled = false
    this.progressAt = this.now()
    this.phase = { state: 'downloading', transferred: 0, total: 0 }
    this.deps.changed()
    this.downloading = installer
      .download(update.version, this.deps.channel?.() === 'beta', (transferred, total) => {
        if (!mine() || this.phase.state !== 'downloading') return
        this.phase = { state: 'downloading', transferred, total }
        if (this.now() - this.progressAt < PROGRESS_MS) return
        this.progressAt = this.now()
        this.deps.changed()
      })
      .then(() => {
        if (!mine()) return
        installer.installOnQuit(this.onQuit())
        this.phase = { state: 'ready', onQuit: this.onQuit() }
      })
      .catch((err: unknown) => {
        if (!mine()) return
        if (!this.cancelled) console.warn('Could not download the Foreman update:', err instanceof Error ? err.message : err)
        this.phase = this.cancelled ? { state: 'available' } : { state: 'available', failed: true }
      })
      .finally(() => {
        this.downloading = null
        this.cancelled = false
        this.deps.changed()
      })
    return this.downloading
  }

  /** The card's Stop: the download ends and the card offers Download again. */
  stopDownload(): void {
    if (!this.downloading) return
    this.cancelled = true
    this.deps.installer?.cancel()
  }

  /** The card's "Install when I quit" (or not). */
  installOnQuit(on: boolean): void {
    this.onQuitChosen = on
    if (this.phase.state !== 'ready') return
    this.deps.installer?.installOnQuit(this.onQuit())
    this.phase = { state: 'ready', onQuit: this.onQuit() }
    this.deps.changed()
  }

  /** Whether a downloaded update is waiting for a restart. */
  ready(): boolean {
    return this.phase.state === 'ready' || this.phase.state === 'waiting'
  }

  /** "Restart when agents finish" started (true) or was cancelled (false). */
  setWaiting(on: boolean): void {
    if (!this.ready()) return
    this.phase = on ? { state: 'waiting' } : { state: 'ready', onQuit: this.onQuit() }
    this.deps.changed()
  }

  /** The window has said "Updated to …". */
  dismissUpdated(): void {
    if (!this.updatedFrom) return
    this.updatedFrom = undefined
    this.deps.changed()
  }

  /** A release's notes for "What's new": the offered one's from the last check, any other's from GitHub. Null when unknown. */
  async notes(version: string): Promise<ReleaseNotes | null> {
    const found = this.found
    if (found?.version === version) return { version, url: found.url, notes: found.notes ?? '', ...(found.publishedAt ? { publishedAt: found.publishedAt } : {}) }
    try {
      const res = await this.get(releaseApi(version))
      return res.ok ? releaseNotes(version, await res.json()) : null
    } catch {
      return null
    }
  }

  /** Stop the schedule and any download (Foreman is quitting). */
  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.stopDownload()
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.started || !this.deps.enabled()) {
      this.nextAt = undefined
      return
    }
    const every = UPDATE_INTERVAL_HOURS[this.deps.interval?.() ?? 'every-4-hours'] * 60 * 60_000
    this.nextAt = (this.lastChecked ?? this.now()) + every
    this.timer = setTimeout(() => void this.check(), Math.max(0, this.nextAt - this.now()))
    this.timer.unref?.()
  }

  /** In the download modes, fetch the offered release as soon as it's found. */
  private autoDownload(): void {
    if (this.mode() === 'notify' || !this.found || this.found.version === this.deps.skipped()) return
    if (this.phase.state !== 'available' || this.phase.failed || !this.canInstall()) return
    void this.download().catch(() => undefined)
  }

  private get(url: string): Promise<Response> {
    const current = this.deps.currentVersion() ?? ''
    return (this.deps.fetch ?? fetch)(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Foreman/${current || 'unknown'}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  }

  private async ask(): Promise<UpdateCheckResult> {
    const current = this.deps.currentVersion() ?? ''
    const beta = this.deps.channel?.() === 'beta'
    let update: AvailableUpdate | null
    try {
      const res = await this.get(beta ? RELEASES_API : LATEST_RELEASE_API)
      // No published release yet.
      if (res.status === 404) update = null
      else if (!res.ok) return this.finish({ state: 'failed', current })
      else update = beta ? newestRelease(current, await res.json(), true) : newerRelease(current, await res.json())
    } catch {
      // Offline, timed out, not JSON, or a running version that isn't semver.
      return this.finish({ state: 'failed', current })
    }
    // A release seen before stays offered (and dismissed, downloaded) as it was; a different one is news.
    if (update?.version !== this.found?.version) {
      this.stopDownload()
      if (this.phase.state === 'ready' || this.phase.state === 'waiting') this.deps.installer?.installOnQuit(false)
      this.found = update
      this.dismissed = false
      this.onQuitChosen = false
      this.phase = { state: 'available' }
    } else if (update && this.found) this.found = { ...this.found, ...update }
    const result: UpdateCheckResult = update ? { state: 'available', update } : { state: 'current', current }
    this.finish(result)
    this.autoDownload()
    return result
  }

  private finish(result: UpdateCheckResult): UpdateCheckResult {
    this.lastChecked = this.now()
    this.lastResult = result.state
    return result
  }
}
