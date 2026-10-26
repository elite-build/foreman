// "Base moved" (W-1): what the watch does with each look at the base branch.
// Pure, so the dedup rules and the git version gate can be tested without git.
import { createT, type TFunction } from './i18n'
import type { BaseWatch } from './types'

const enT = createT('en')

/** `git merge-tree --write-tree` arrived in git 2.38. */
export const MERGE_TREE_MIN = [2, 38] as const

/** "git version 2.54.0 (Apple Git-157)" -> [2, 54, 0]; null when unreadable. */
export function parseGitVersion(output: string): number[] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

export function mergeTreeSupported(version: number[] | null): boolean {
  if (!version) return false
  const [major, minor] = version
  return major > MERGE_TREE_MIN[0] || (major === MERGE_TREE_MIN[0] && minor >= MERGE_TREE_MIN[1])
}

/** `merge-tree --write-tree --name-only --no-messages`: the tree id, then the conflicted paths. */
export function parseMergeTree(stdout: string): string[] {
  const [, ...rest] = stdout.split('\n')
  const files: string[] = []
  for (const line of rest) {
    if (!line) break
    files.push(line)
  }
  return [...new Set(files)]
}

export type BaseObservation =
  | { kind: 'ok'; base: string; head: string; conflicts: string[]; dirty: boolean; at: string }
  // Fetch or merge-tree failed: say nothing, keep what was known.
  | { kind: 'error' }

export interface BaseStep {
  next: BaseWatch
  // A new base tip that conflicts and has not been announced.
  notify?: { base: string; conflicts: string[] }
}

export const emptyBaseWatch = (): BaseWatch => ({ conflicts: [] })

export function stepBase(prev: BaseWatch, obs: BaseObservation): BaseStep {
  if (obs.kind === 'error') return { next: prev }
  const next: BaseWatch = {
    base: obs.base,
    head: obs.head,
    conflicts: obs.conflicts,
    untested: obs.dirty || undefined,
    notified: prev.notified,
    acked: prev.acked,
    checkedAt: obs.at
  }
  // Once per base SHA: a new tip that conflicts re-arms, the same tip never repeats.
  if (obs.conflicts.length && prev.notified !== obs.base) {
    next.notified = obs.base
    return { next, notify: { base: obs.base, conflicts: obs.conflicts } }
  }
  return { next }
}

/** The conflicts Home should show: committed ones on a base tip the user has not dealt with. */
export function openBaseConflicts(watch: BaseWatch | undefined): { base: string; conflicts: string[]; untested: boolean } | null {
  if (!watch?.base || !watch.conflicts.length || watch.acked === watch.base) return null
  return { base: watch.base, conflicts: watch.conflicts, untested: Boolean(watch.untested) }
}

export const baseMovedLabel = (n: number, t: TFunction = enT): string => t('triage.baseMoved', { count: n })
