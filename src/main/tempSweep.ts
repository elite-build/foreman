// Foreman's own folders in the system temp folder, deleted once they are old. Each is removed when its work ends; a
// crash, a killed process or a file Windows still held leaves it behind, and nothing else ever deletes it.
import { lstat, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const DAY_MS = 24 * 60 * 60_000

/** The prefixes main gives `mkdtemp` (six random characters follow). A folder still in use is younger than a day. */
const PREFIXES = ['switchyard-index-', 'foreman-bundle-', 'foreman-picked-', 'foreman-git-backup-', 'foreman-no-github-', 'foreman-memory-', 'foreman-memory-msg-', 'foreman-record-', 'foreman-screens-data-']
export const FOREMAN_TEMP = new RegExp(`^(?:${PREFIXES.join('|')})[A-Za-z0-9]{6}$`)

/**
 * The config folder the Agent SDK makes to resume a Claude session from Foreman's transcript store (claudeMirror.ts):
 * the transcript, settings and a copy of the person's `.credentials.json`. The SDK deletes it once Claude exits, so one
 * is left when Foreman quits or crashes first, or Windows still held a file. Each resume makes a new one.
 */
export const CLAUDE_RESUME_TEMP = /^claude-resume-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Pasted files waiting for a workspace still being made (the new-workspace dialog), one folder per file. */
export const STAGED_DIR = 'foreman-staged'

/** Memory files written out at a commit to open (a mock as a gate showed it), one folder per organization and commit. */
export const MEMORY_VIEWS_DIR = 'foreman-memory-views'

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
    sweepTemp({ dir: path.join(tmp, STAGED_DIR), match: /^[0-9a-f]{8}$/, olderThanMs: DAY_MS, now }),
    sweepTemp({ dir: path.join(tmp, MEMORY_VIEWS_DIR), match: /^[A-Za-z0-9_-]+$/, olderThanMs: DAY_MS, now }),
    // Claude Code rewrites `.claude.json` in it by renaming, so one still in use has changed within the day.
    sweepTemp({ dir: tmp, match: CLAUDE_RESUME_TEMP, olderThanMs: DAY_MS, now })
  ])
  return counts.reduce((sum, n) => sum + n, 0)
}
