// Is there a newer Foreman? At each start main asks GitHub for the repository's latest published release (drafts and
// prereleases are never "latest") and, when it comes after the running version, the window offers the release page.
// Nothing is downloaded or installed by Foreman itself. Pure and shared: no I/O here (main/updates.ts does the asking).

/** Where releases are published (package.json's `repository`). */
export const RELEASES_REPO = 'elite-build/foreman'

/** GitHub's latest published release: neither a draft nor a prerelease. Answers 404 while there is none. */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`

/** A newer release the window offers. */
export interface AvailableUpdate {
  version: string
  // The running version.
  current: string
  // The release's page on GitHub: notes, installers and source.
  url: string
}

/** A check asked for in Settings. `failed`: GitHub couldn't be reached or answered something unexpected. */
export type UpdateCheckResult = { state: 'available'; update: AvailableUpdate } | { state: 'current'; current: string } | { state: 'failed'; current: string }

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
 * version, a draft or prerelease, or a tag that isn't `v<semver>`. Throws when `current` isn't a version.
 */
export function newerRelease(current: string, release: unknown): AvailableUpdate | null {
  if (!isVersion(current)) throw new Error(`Not a version: ${current}`)
  if (!release || typeof release !== 'object') return null
  const { tag_name: tag, draft, prerelease } = release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
  if (draft === true || prerelease === true || typeof tag !== 'string') return null
  const version = tag.replace(/^v/, '')
  if (!isVersion(version) || compareVersions(version, current) <= 0) return null
  return { version, current, url: releaseUrl(version) }
}
