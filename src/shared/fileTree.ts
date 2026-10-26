// The Files tab (#19): the worktree as a tree in the side panel. Main lists one
// folder at a time; these pure helpers sort a listing, build the "Changed
// only" tree from the diff, add up counts for folders, and turn keys into
// moves, so the tree component itself stays thin.
import type { DiffFile } from './types'

export interface DirEntry {
  name: string
  // Relative to the worktree, with / separators.
  path: string
  dir: boolean
}

export interface DirListing {
  entries: DirEntry[]
  // More entries than the cap; the rest aren't listed.
  truncated: boolean
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** Folders first, then by name as people read it (file2 before file10, case ignored). */
export function sortEntries<T extends { name: string; dir: boolean }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1) : a.dir ? -1 : 1))
}

/** A changed file's numbers, as the Changes list shows them. */
export type ChangedFile = Pick<DiffFile, 'path' | 'status' | 'binary' | 'additions' | 'deletions'>

/** What a folder holds: changed files, lines added and removed, and how many of those files are binary. */
export interface ChangeStat {
  files: number
  additions: number
  deletions: number
  binary: number
}

/**
 * Counts for every folder that holds a change, keyed by its path ('' is the
 * top). Binary files count as files but add no lines, as in Changes.
 */
export function folderStats(files: ChangedFile[]): Map<string, ChangeStat> {
  const stats = new Map<string, ChangeStat>()
  for (const f of files) {
    const parts = f.path.split('/')
    for (let depth = 0; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/')
      const stat = stats.get(dir) ?? { files: 0, additions: 0, deletions: 0, binary: 0 }
      stat.files++
      stat.additions += f.additions
      stat.deletions += f.deletions
      if (f.binary) stat.binary++
      stats.set(dir, stat)
    }
  }
  return stats
}

export interface ChangedNode {
  // A folder chain with one child each is shown as one row: "
  name: string
  path: string
  dir: boolean
  children: ChangedNode[]
  // Folders: what's inside. Files: their own numbers.
  stat: ChangeStat
  file?: ChangedFile
}

/** The changed files and the folders that hold them, folders first, single-child folder chains joined into one row. */
export function changedTree(files: ChangedFile[]): ChangedNode[] {
  const stats = folderStats(files)
  const root: ChangedNode = { name: '', path: '', dir: true, children: [], stat: stats.get('') ?? { files: 0, additions: 0, deletions: 0, binary: 0 } }
  const folders = new Map<string, ChangedNode>([['', root]])
  const folder = (path: string): ChangedNode => {
    const known = folders.get(path)
    if (known) return known
    const slash = path.lastIndexOf('/')
    const node: ChangedNode = { name: path.slice(slash + 1), path, dir: true, children: [], stat: stats.get(path)! }
    folders.set(path, node)
    folder(slash === -1 ? '' : path.slice(0, slash)).children.push(node)
    return node
  }
  for (const f of files) {
    const slash = f.path.lastIndexOf('/')
    folder(slash === -1 ? '' : f.path.slice(0, slash)).children.push({
      name: f.path.slice(slash + 1),
      path: f.path,
      dir: false,
      children: [],
      stat: { files: 1, additions: f.additions, deletions: f.deletions, binary: f.binary ? 1 : 0 },
      file: f
    })
  }
  const finish = (node: ChangedNode): ChangedNode => {
    let shown = node
    while (shown.dir && shown.children.length === 1 && shown.children[0].dir) {
      const only = shown.children[0]
      shown = { ...only, name: `${shown.name}/${only.name}` }
    }
    return { ...shown, children: sortEntries(shown.children.map(finish)) }
  }
  return sortEntries(root.children.map(finish))
}

/** One visible row of the tree, as the keyboard sees it. */
export interface TreeRow {
  path: string
  dir: boolean
  depth: number
  expanded?: boolean
}

export type TreeMove = { focus: number } | { toggle: string } | { open: string } | null

/**
 * What a key does on row `index`: ↑↓ Home End move; → opens a closed folder or
 * steps into an open one; ← closes an open folder or steps out to its parent;
 * Enter opens a file or toggles a folder.
 */
export function treeKey(rows: TreeRow[], index: number, key: string): TreeMove {
  const row = rows[index]
  if (!row) return rows.length && (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') ? { focus: 0 } : null
  switch (key) {
    case 'ArrowDown':
      return { focus: Math.min(index + 1, rows.length - 1) }
    case 'ArrowUp':
      return { focus: Math.max(index - 1, 0) }
    case 'Home':
      return { focus: 0 }
    case 'End':
      return { focus: rows.length - 1 }
    case 'ArrowRight':
      if (!row.dir) return null
      if (!row.expanded) return { toggle: row.path }
      return rows[index + 1]?.depth > row.depth ? { focus: index + 1 } : null
    case 'ArrowLeft': {
      if (row.dir && row.expanded) return { toggle: row.path }
      for (let i = index - 1; i >= 0; i--) if (rows[i].depth < row.depth) return { focus: i }
      return null
    }
    case 'Enter':
      return row.dir ? { toggle: row.path } : { open: row.path }
    default:
      return null
  }
}
