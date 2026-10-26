// O5: pure pieces of the Changes panel's diff sources and the Commits tab:
// which commits a range covers, and which tab Foreman saw make a commit.
import type { ChatItem, DiffScope } from './types'

/** Every source the menu offers, in menu order (`commit` is the Commits tab's own view). */
export const DIFF_SOURCES = ['all', 'uncommitted', 'staged', 'last-commit', 'last-3', 'picked', 'pr'] as const satisfies readonly DiffScope[]

/** How many commits "Last commit" and "Last 3 commits" cover. */
export function lastCount(scope: DiffScope): number {
  return scope === 'last-3' ? 3 : 1
}

/**
 * "The last n commits" on a first-parent list (newest first): the commits, and
 * the commit before the nth to diff from (undefined when the branch has n or
 * fewer: then it's the oldest one's parent). Null with no commits.
 */
export function lastNRange(firstParents: string[], n: number): { from?: string; commits: string[] } | null {
  if (!firstParents.length) return null
  return { from: firstParents[n], commits: firstParents.slice(0, n) }
}

/**
 * Picked commits in branch order (oldest first), keeping only ones on the branch,
 * and whether they're one unbroken run (so a plain range shows exactly them).
 */
export function orderPicked(firstParents: string[], picked: string[]): { oldestFirst: string[]; contiguous: boolean } {
  const index = new Map(firstParents.map((sha, i) => [sha, i]))
  const at = [...new Set(picked)]
    .map((p) => firstParents.find((sha) => sha === p || (p.length >= 7 && sha.startsWith(p))))
    .filter((sha): sha is string => sha !== undefined)
    .map((sha) => index.get(sha)!)
    .sort((a, b) => b - a)
  const unique = [...new Set(at)]
  const contiguous = unique.every((i, k) => k === 0 || unique[k - 1] - i === 1)
  return { oldestFirst: unique.map((i) => firstParents[i]), contiguous }
}

// git commit, cherry-pick and revert print "[branch abc1234] subject" (or "[main (root-commit) abc1234] subject").
const COMMIT_LINE = /^\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,64})\] /gm

/** Short commit ids a tool's output says it just made. */
export function commitsInOutput(output: string): string[] {
  return [...output.matchAll(COMMIT_LINE)].map((m) => m[1])
}

export interface CommitSighting {
  short: string
  sessionId: string
}

/** Commits a chat's tool calls made, as Foreman saw them: a finished call that ran git and printed the commit line. */
export function sightingsInChat(sessionId: string, items: ChatItem[]): CommitSighting[] {
  const found: CommitSighting[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || item.status !== 'done' || !item.output) continue
    if (!JSON.stringify(item.input ?? '').includes('git')) continue
    for (const short of commitsInOutput(item.output)) found.push({ short, sessionId })
  }
  return found
}

/** The one tab that made this commit, or undefined when none did or more than one claims it (unknown, not a guess). */
export function tabForCommit(sha: string, sightings: CommitSighting[]): string | undefined {
  const tabs = new Set(sightings.filter((s) => sha.startsWith(s.short)).map((s) => s.sessionId))
  return tabs.size === 1 ? [...tabs][0] : undefined
}

/** ⌘⌥U: to Uncommitted, or back to All changes from it. */
export function toggleUncommitted(scope: DiffScope): DiffScope {
  return scope === 'uncommitted' ? 'all' : 'uncommitted'
}
