// Is there a newer Foreman? Main asks GitHub for the repository's releases at start-up, when the computer wakes and on
// Settings → General → Updates' schedule. On the Stable channel only the latest published release counts (drafts and
// prereleases never do); Beta also offers prereleases. Where the build can install updates itself (main/updateInstaller.ts)
// it downloads the new version and installs it on a restart or at quit; elsewhere the window offers the release page.
// Pure and shared: no I/O here (main/updates.ts does the asking).

/** Where releases are published (package.json's `repository`). */
export const RELEASES_REPO = 'elite-build/foreman'

/** GitHub's latest published release: neither a draft nor a prerelease. Answers 404 while there is none. */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`

/** The newest releases, prereleases included (Beta channel). Drafts appear only to people with write access. */
export const RELEASES_API = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=20`

/** One release, by its tag: the notes "What's new" shows after an update. */
export const releaseApi = (version: string): string => `https://api.github.com/repos/${RELEASES_REPO}/releases/tags/v${version}`

/** Release notes longer than this are cut (the release page has the rest). */
export const MAX_NOTES = 20_000

/** Settings → General → Updates. */
export type UpdateChannel = 'stable' | 'beta'
// Tell me (nothing downloaded) · download, then ask to restart · download and install whenever Foreman quits.
export type UpdateMode = 'notify' | 'download' | 'quit'
export type UpdateInterval = 'hourly' | 'every-4-hours' | 'daily'

export const UPDATE_INTERVAL_HOURS: Record<UpdateInterval, number> = { hourly: 1, 'every-4-hours': 4, daily: 24 }

/** A newer release the window offers. */
export interface AvailableUpdate {
  version: string
  // The running version.
  current: string
  // The release's page on GitHub: notes, installers and source.
  url: string
  // The release's notes (Markdown, as written on GitHub), cut to MAX_NOTES.
  notes?: string
  publishedAt?: string
  prerelease?: boolean
}

/** A release's notes, for "What's new". */
export interface ReleaseNotes {
  version: string
  url: string
  notes: string
  publishedAt?: string
}

/** A check asked for in Settings. `failed`: GitHub couldn't be reached or answered something unexpected. */
export type UpdateCheckResult = { state: 'available'; update: AvailableUpdate } | { state: 'current'; current: string } | { state: 'failed'; current: string }

/** Why this copy of Foreman can't download and install an update by itself: the window links to the release page instead. */
export type InstallUnavailable =
  // Run from source or an unpacked build.
  | 'development'
  // macOS installs only into an app signed with a Developer ID; ad-hoc signed builds can't update themselves.
  | 'unsigned'
  // Linux, or a build without the update feed (app-update.yml).
  | 'unsupported'

/** Where the offered update is. */
export type UpdatePhase =
  // Found; nothing downloading (Tell me, a build that can't install, or a download that was stopped or failed).
  | { state: 'available'; failed?: boolean }
  | { state: 'downloading'; transferred: number; total: number }
  // Downloaded. onQuit: it installs when Foreman quits.
  | { state: 'ready'; onQuit: boolean }
  // "Restart when agents finish": Foreman restarts once the running turns end.
  | { state: 'waiting' }

/** What the window shows about updates. */
export interface UpdateView {
  // The sidebar card: absent with nothing newer, or once put off (Later, this run) or skipped.
  notice?: AvailableUpdate & { phase: UpdatePhase }
  checking: boolean
  // The last check that finished, and what it found ('available' even when the notice is put off).
  lastChecked?: string
  lastResult?: 'available' | 'current' | 'failed'
  // The newest release the last check found, whether or not it's put off.
  latest?: AvailableUpdate
  // The next scheduled check (absent while automatic checks are off).
  nextCheck?: string
  // Absent when Foreman can install updates itself.
  installUnavailable?: InstallUnavailable
  // Foreman was updated since it last ran: the version it was on, until the window has said so.
  updatedFrom?: string
}

// Semver 2.0.0, as scripts/release.mjs reads versions when it bumps and tags them (tests/appUpdate.test.ts keeps the two in step).
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

interface Version {
  core: [number, number, number]
  pre: string[]
}

function parse(text: string): Version | null {
  const m = SEMVER.exec(text)
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null
}

/** Whether `text` is a semver version (no leading `v`, no build metadata). */
export function isVersion(text: string): boolean {
  return parse(text) !== null
}

/** Semver precedence: negative when a comes first, 0 when equal, positive when a comes later. Throws on a non-version. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) throw new Error(`Not a version: ${x ? b : a}`)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
  // A prerelease comes before its release; identifiers compare numerically when both are numbers, otherwise as text.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]]
    if (p === q) continue
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)]
    if (pn && qn) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return x.pre.length - y.pre.length
}

/** A release's page. Built from the checked version, never from a URL in GitHub's answer. */
export function releaseUrl(version: string): string {
  return `https://github.com/${RELEASES_REPO}/releases/tag/v${version}`
}

/**
 * The update GitHub's latest-release answer offers over `current`, or null when it offers none: the same or an older
 * version, a draft, a prerelease (unless `prerelease`), or a tag that isn't `v<semver>`. Throws when `current` isn't a version.
 */
export function newerRelease(current: string, release: unknown, prerelease = false): AvailableUpdate | null {
  if (!isVersion(current)) throw new Error(`Not a version: ${current}`)
  if (!release || typeof release !== 'object') return null
  const r = release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; body?: unknown; published_at?: unknown }
  if (r.draft === true || (r.prerelease === true && !prerelease) || typeof r.tag_name !== 'string') return null
  const version = r.tag_name.replace(/^v/, '')
  if (!isVersion(version) || compareVersions(version, current) <= 0) return null
  return {
    version,
    current,
    url: releaseUrl(version),
    ...(typeof r.body === 'string' && r.body.trim() ? { notes: cutNotes(r.body) } : {}),
    ...(typeof r.published_at === 'string' ? { publishedAt: r.published_at } : {}),
    ...(r.prerelease === true ? { prerelease: true } : {})
  }
}

/** The newest release in GitHub's list that comes after `current` (Beta: prereleases count), or null. */
export function newestRelease(current: string, releases: unknown, prerelease: boolean): AvailableUpdate | null {
  if (!isVersion(current)) throw new Error(`Not a version: ${current}`)
  if (!Array.isArray(releases)) return null
  let best: AvailableUpdate | null = null
  for (const release of releases) {
    const found = newerRelease(current, release, prerelease)
    if (found && (!best || compareVersions(found.version, best.version) > 0)) best = found
  }
  return best
}

/** One release's notes from GitHub's answer for its tag, or null when it isn't that published release. */
export function releaseNotes(version: string, release: unknown): ReleaseNotes | null {
  if (!isVersion(version) || !release || typeof release !== 'object') return null
  const r = release as { tag_name?: unknown; draft?: unknown; body?: unknown; published_at?: unknown }
  if (r.draft === true || r.tag_name !== `v${version}`) return null
  return {
    version,
    url: releaseUrl(version),
    notes: typeof r.body === 'string' ? cutNotes(r.body) : '',
    ...(typeof r.published_at === 'string' ? { publishedAt: r.published_at } : {})
  }
}

/** Whether `version` comes after `previous`: Foreman was updated between two runs. False when either isn't a version. */
export function wasUpdated(previous: string | undefined, version: string | undefined): boolean {
  return Boolean(previous && version && isVersion(previous) && isVersion(version) && compareVersions(version, previous) > 0)
}

function cutNotes(body: string): string {
  const text = body.replace(/\r\n/g, '\n').trim()
  return text.length > MAX_NOTES ? `${text.slice(0, MAX_NOTES).trimEnd()}…` : text
}
