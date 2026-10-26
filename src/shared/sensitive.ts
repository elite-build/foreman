// Sensitive paths: which changed files match the repository's globs, and which
// alerts survive a rewind. Pure, so the rules are testable without git.
import type { SensitiveAlert } from './types'

/**
 * One gitignore-style glob as a regex over a repo-relative path. `*` stays
 * within a folder, `**` crosses folders, `?` is one character, a trailing `/`
 * means everything inside. A pattern with no slash matches at any depth.
 */
export function globToRegExp(pattern: string): RegExp {
  let glob = pattern.trim().replace(/^\.\//, '')
  const anywhere = !glob.includes('/') || /^[^/]*\/$/.test(glob)
  if (glob.startsWith('/')) glob = glob.slice(1)
  if (glob.endsWith('/')) glob += '**'
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        // "**/" matches zero or more folders.
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else out += '.*'
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${anywhere && !glob.startsWith('**') ? '(?:.*/)?' : ''}${out}$`)
}

/** The paths that match any glob, in their original order. */
export function sensitiveMatches(paths: string[], globs: string[]): string[] {
  const patterns = globs.map((g) => g.trim()).filter((g) => g && !g.startsWith('#')).map(globToRegExp)
  if (!patterns.length) return []
  return paths.filter((p) => patterns.some((re) => re.test(p)))
}

/**
 * Alerts left after a rewind. Those raised after the restored point go: this
 * chat's alerts for turns that are no longer in it, and any alert raised once
 * the restored message was sent (the files it described were rolled back).
 */
export function alertsAfterRewind(
  alerts: SensitiveAlert[],
  point: { sessionId: string; keptTurnIds: Set<string>; at: string }
): SensitiveAlert[] {
  return alerts.filter((a) => (a.sessionId === point.sessionId ? point.keptTurnIds.has(a.turnId) : a.at < point.at) && a.at < point.at)
}
