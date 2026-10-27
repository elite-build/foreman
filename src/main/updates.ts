// Is there a newer Foreman (shared/appUpdate.ts)? Asked once at each start of an installed build, while Settings →
// General → "Check for updates when Foreman starts" is on, and whenever Settings' "Check now" asks. One unauthenticated
// request to GitHub's public API; nothing is downloaded or installed. The window's notice opens the release page.
import { LATEST_RELEASE_API, newerRelease, type AvailableUpdate, type UpdateCheckResult } from '../shared/appUpdate'

type Fetch = typeof fetch

// GitHub's API is quick; a slow network shouldn't keep a check hanging.
const TIMEOUT_MS = 10_000

export interface UpdateDeps {
  // The running version (app.getVersion()); absent in tests and builds without a host.
  currentVersion: () => string | undefined
  // Settings → General → checkForUpdates.
  enabled: () => boolean
  // The version "Skip this version" saved, if any.
  skipped: () => string | undefined
  setSkipped: (version: string) => void
  // The notice changed: broadcast the state again.
  changed: () => void
  fetch?: Fetch
}

export class UpdateCheck {
  private found: AvailableUpdate | null = null
  // "Later": hidden until Foreman starts again.
  private dismissed = false
  private running: Promise<UpdateCheckResult> | null = null

  constructor(private deps: UpdateDeps) {}

  /** The newer release the window offers, unless it was put off for this run or skipped. */
  notice(): AvailableUpdate | undefined {
    if (!this.found || this.dismissed || this.found.version === this.deps.skipped()) return undefined
    return this.found
  }

  /** At launch: a check while the setting is on. A failure is only logged; the next start asks again. */
  async atStartup(): Promise<void> {
    if (!this.deps.enabled()) return
    const result = await this.check()
    if (result.state === 'failed') console.warn('Could not check for a newer Foreman.')
  }

  /** Ask GitHub now. A check already under way is shared rather than repeated. */
  check(): Promise<UpdateCheckResult> {
    this.running ??= this.ask().finally(() => (this.running = null))
    return this.running
  }

  /** The notice's Later (until the next start) or Skip this version (until a newer one is out). */
  dismiss(skip: boolean): void {
    if (skip && this.found) this.deps.setSkipped(this.found.version)
    else this.dismissed = true
    this.deps.changed()
  }

  private async ask(): Promise<UpdateCheckResult> {
    const current = this.deps.currentVersion() ?? ''
    let update: AvailableUpdate | null
    try {
      const res = await (this.deps.fetch ?? fetch)(LATEST_RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Foreman/${current || 'unknown'}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      // No published release yet.
      if (res.status === 404) update = null
      else if (!res.ok) return { state: 'failed', current }
      else update = newerRelease(current, await res.json())
    } catch {
      // Offline, timed out, not JSON, or a running version that isn't semver.
      return { state: 'failed', current }
    }
    // A release seen before stays offered (and dismissed) as it was; a different one is news.
    if (update?.version !== this.found?.version) {
      this.found = update
      this.dismissed = false
      this.deps.changed()
    }
    return update ? { state: 'available', update } : { state: 'current', current }
  }
}
