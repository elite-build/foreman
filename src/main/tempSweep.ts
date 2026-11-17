// Foreman's own folders in the system temp folder, deleted once they are old. Each is removed when its work ends; a
// crash, a killed process or a file Windows still held leaves it behind, and nothing else ever deletes it.
import { lstat, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const DAY_MS = 24 * 60 * 60_000

/** The prefixes main gives `mkdtemp` (six random characters follow). A folder still in use is younger than a day. */
const PREFIXES = ['switchyard-index-', 'foreman-bundle-', 'foreman-picked-', 'foreman-git-backup-', 'foreman-no-github-', 'foreman-memory-', 'foreman-memory-msg-', 'foreman-record-', 'foreman-screens-data-']
export const FOREMAN_TEMP = new RegExp(`^(?:${PREFIXES.join('|')})[A-Za-z0-9]{6}$`)

/** Pasted files waiting for a workspace still being made (the new-workspace dialog), one folder per file. */
export const STAGED_DIR = 'foreman-staged'

/** Deletes the entries of `dir` named by `match` that haven't changed for `olderThanMs`. Returns how many went. */
export async function sweepTemp(options: { dir: string; match: RegExp; olderThanMs: number; now?: number }): Promise<number> {
  const cutoff = (options.now ?? Date.now()) - options.olderThanMs
  const names = await readdir(options.dir).catch(() => [] as string[])
  let removed = 0
  for (const name of names) {
    if (!options.match.test(name)) continue
    const full = path.join(options.dir, name)
    try {
      if ((await lstat(full)).mtimeMs >= cutoff) continue
      await rm(full, { recursive: true, force: true, maxRetries: 2 })
      removed++
    } catch {
      // Still held, or gone already: the next sweep tries again.
    }
  }
  return removed
}

/** Foreman's leftovers in `tmp` (the system temp folder) older than a day. */
export async function sweepForemanTemp(tmp = os.tmpdir(), now = Date.now()): Promise<number> {
  const counts = await Promise.all([
    sweepTemp({ dir: tmp, match: FOREMAN_TEMP, olderThanMs: DAY_MS, now }),
    sweepTemp({ dir: path.join(tmp, STAGED_DIR), match: /^[0-9a-f]{8}$/, olderThanMs: DAY_MS, now })
  ])
  return counts[0] + counts[1]
}
