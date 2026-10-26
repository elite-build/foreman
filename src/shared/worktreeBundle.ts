// Moving a workspace's branch and uncommitted work between machines (P-2 worktree mode).
// The pure rules live here; the git work is in main/worktreeBundle.ts.
import { createT, type TFunction } from './i18n'

const enT = createT('en')

/** What the file says about the worktree it carries. */
export interface WorktreeInfo {
  branch: string
  // The branch tip when it was captured.
  head: string
  // The checkpoint commit (HEAD, index and working tree incl. untracked files) the bundle carries.
  checkpointId: string
  checkpointRef: string
  // Ignored files and folders that stayed behind (capped), and how many more there were.
  omitted: string[]
  omittedMore: number
  // Ignored files the user chose to bring from the repo's "files to copy" list: path → entry in the file.
  files: { path: string; entry: string }[]
  // Things that did not travel or may not behave the same.
  notes: WorktreeNote[]
}

export type WorktreeNoteKind = 'submodule' | 'lfs' | 'filenames' | 'ignored' | 'detached' | 'files'

export interface WorktreeNote {
  kind: WorktreeNoteKind
  text: string
}

/** Why the worktree could not be captured; the rest of the export carries on without it. */
export type WorktreeSkip = 'unborn' | 'merge' | 'no-folder' | 'not-requested'

export interface WorktreeResult {
  status: 'included' | 'skipped'
  reason?: WorktreeSkip
  // A sentence the user can read.
  message: string
  notes: WorktreeNote[]
}

export const OMITTED_LIMIT = 200

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Paths that git can hold but another file system (Windows, case-insensitive macOS) can't, or can't tell apart. */
export function incompatibleNames(paths: string[]): string[] {
  const bad = new Set<string>()
  const seen = new Map<string, string>()
  for (const p of paths) {
    const parts = p.replace(/\/$/, '').split('/')
    if (p.length > 240) bad.add(`${p.slice(0, 60)}… (path too long)`)
    for (const part of parts) {
      if (/[<>:"|?*\\\x00-\x1f]/.test(part) || /[. ]$/.test(part) || RESERVED.test(part)) {
        bad.add(p)
        break
      }
    }
    const folded = p.toLowerCase()
    const other = seen.get(folded)
    if (other !== undefined && other !== p) {
      bad.add(p)
      bad.add(other)
    }
    seen.set(folded, p)
  }
  return [...bad].sort()
}

/** Submodule paths with local changes, from `git status --porcelain=v2` (field 3 is `S<c><m><u>` for a submodule). */
export function dirtySubmodules(porcelainV2: string): string[] {
  const out: string[] = []
  for (const line of porcelainV2.split('\n')) {
    if (!line.startsWith('1 ') && !line.startsWith('2 ')) continue
    const fields = line.split(' ')
    const sub = fields[2]
    if (!sub || sub[0] !== 'S') continue
    if (sub.slice(1).includes('C') || sub.slice(1).includes('M') || sub.slice(1).includes('U')) out.push(fields.slice(line.startsWith('2 ') ? 9 : 8).join(' ').split('\t')[0])
  }
  return out
}

/** Entries of `git lfs ls-files`: `oid - path` means only the pointer is here, `oid * path` the real file. */
export function lfsMissing(lsFiles: string): string[] {
  return lsFiles
    .split('\n')
    .map((l) => /^[0-9a-f]+ - (.*)$/.exec(l.trim())?.[1])
    .filter((p): p is string => Boolean(p))
}

/** `name`, or `name-imported`, `name-imported-2`… for the first one that is free. */
export function freeBranchName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${name}-imported` : `${name}-imported-${n}`
    if (!taken(candidate)) return candidate
  }
}

/** What a bundle carries. `files` is the chosen ignored files, or just their count (the import preview's form). */
export function bundleSummary(info: Pick<WorktreeInfo, 'branch' | 'omitted' | 'omittedMore'> & { files: unknown[] | number }, t: TFunction = enT): string {
  const left = info.omitted.length + info.omittedMore
  const files = typeof info.files === 'number' ? info.files : info.files.length
  const parts = [t('worktreeBundle.summary.branch', { branch: info.branch })]
  if (files) parts.push(t('worktreeBundle.summary.files', { count: files }))
  if (left) parts.push(t('worktreeBundle.summary.left', { count: left }))
  return parts.join(', ')
}
