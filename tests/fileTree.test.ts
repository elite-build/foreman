import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listWorkspaceDir, MAX_DIR_ENTRIES, unquoteGitPath } from '../src/main/fileBrowse'
import { changedTree, folderStats, sortEntries, treeKey, type ChangedFile, type ChangedNode, type TreeRow } from '../src/shared/fileTree'
import { git } from '../src/main/git'
import { commit, makeRepo, tempDir } from './helpers'

const names = (listing: { entries: { name: string; dir: boolean }[] }) => listing.entries.map((e) => (e.dir ? `${e.name}/` : e.name))

describe('listWorkspaceDir', () => {
  it('lists folders first, then files, by name as people read it', async () => {
    const repo = await makeRepo({ 'b.txt': 'b', 'A.md': 'a', 'file10.ts': '', 'file2.ts': '' })
    await mkdir(path.join(repo, 'src'))
    await writeFile(path.join(repo, 'src', 'index.ts'), '')
    await mkdir(path.join(repo, 'Docs'))
    await writeFile(path.join(repo, 'Docs', 'x.md'), '')
    expect(names(await listWorkspaceDir(repo, ''))).toEqual(['Docs/', 'src/', 'A.md', 'b.txt', 'file2.ts', 'file10.ts'])
  })

  it('lists one folder at a time with worktree-relative paths', async () => {
    const repo = await makeRepo({ 'README.md': '' })
    await mkdir(path.join(repo, 'src', 'deep'), { recursive: true })
    await writeFile(path.join(repo, 'src', 'a.ts'), '')
    const listing = await listWorkspaceDir(repo, 'src')
    expect(listing.entries).toEqual([
      { name: 'deep', path: 'src/deep', dir: true },
      { name: 'a.ts', path: 'src/a.ts', dir: false }
    ])
    expect(listing.truncated).toBe(false)
  })

  it('hides what git ignores, but not tracked files that match an ignore rule', async () => {
    const repo = await makeRepo({ '.gitignore': 'node_modules/\nout\n*.log\n' })
    await writeFile(path.join(repo, 'kept.log'), 'tracked despite the rule')
    await git(repo, ['add', '-f', 'kept.log'])
    await commit(repo, 'force-add a log')
    await mkdir(path.join(repo, 'node_modules', 'x'), { recursive: true })
    await mkdir(path.join(repo, 'out'))
    await writeFile(path.join(repo, 'debug.log'), '')
    await writeFile(path.join(repo, 'new.ts'), '')
    expect(names(await listWorkspaceDir(repo, ''))).toEqual(['.gitignore', 'kept.log', 'new.ts'])
  })

  it('never lists .git, and refuses to list inside it', async () => {
    const repo = await makeRepo()
    expect(names(await listWorkspaceDir(repo, ''))).not.toContain('.git/')
    await expect(listWorkspaceDir(repo, '.git')).rejects.toThrow(/\.git/)
    await expect(listWorkspaceDir(repo, '.git/refs')).rejects.toThrow(/\.git/)
  })

  it('refuses folders outside the worktree', async () => {
    const repo = await makeRepo()
    await expect(listWorkspaceDir(repo, '..')).rejects.toThrow(/outside the workspace/)
    await expect(listWorkspaceDir(repo, '../../etc')).rejects.toThrow(/outside the workspace/)
    await expect(listWorkspaceDir(repo, path.resolve(repo, '..'))).rejects.toThrow(/outside the workspace/)
  })

  it('refuses a link that leads out of the worktree, and lists links as files', async () => {
    const repo = await makeRepo()
    const outside = await tempDir()
    try {
      await symlink(outside, path.join(repo, 'escape'), 'junction')
    } catch {
      return // Links need extra rights on some machines.
    }
    expect((await listWorkspaceDir(repo, '')).entries.find((e) => e.name === 'escape')?.dir).toBe(false)
    await expect(listWorkspaceDir(repo, 'escape')).rejects.toThrow(/outside the workspace/)
  })

  it('still lists a folder that is not a git repository', async () => {
    const dir = await tempDir()
    await writeFile(path.join(dir, 'a.txt'), '')
    expect(names(await listWorkspaceDir(dir, ''))).toEqual(['a.txt'])
  })

  it('caps a huge folder and says so', async () => {
    const repo = await makeRepo()
    await mkdir(path.join(repo, 'many'))
    await Promise.all(Array.from({ length: MAX_DIR_ENTRIES + 5 }, (_, i) => writeFile(path.join(repo, 'many', `f${i}.txt`), '')))
    const listing = await listWorkspaceDir(repo, 'many')
    expect(listing.entries).toHaveLength(MAX_DIR_ENTRIES)
    expect(listing.truncated).toBe(true)
  }, 60_000)
})

describe('unquoteGitPath', () => {
  it('reads git’s quoting of unusual names back', () => {
    expect(unquoteGitPath('plain name.txt')).toBe('plain name.txt')
    expect(unquoteGitPath(String.raw`"a\tb\"c\\d\303\251.log"`)).toBe('a\tb"c\\dé.log')
  })
})

describe('sortEntries', () => {
  it('puts folders first and compares numbers by value', () => {
    const sorted = sortEntries([
      { name: 'z', dir: false },
      { name: 'b', dir: true },
      { name: 'v10', dir: false },
      { name: 'v9', dir: false },
      { name: 'A', dir: true }
    ])
    expect(sorted.map((e) => e.name)).toEqual(['A', 'b', 'v9', 'v10', 'z'])
  })
})

const change = (path: string, additions: number, deletions: number, binary = false): ChangedFile => ({ path, additions, deletions, binary, status: 'modified' })

const MOCK: ChangedFile[] = [
  change('build/icon-dev.png', 0, 0, true),
  change('design/icons/foreman-dev.svg', 5, 4),
  change('design/icons/foreman-dev-small.svg', 3, 3),
  change('scripts/render-icons.mjs', 14, 2)
]

const outline = (nodes: ChangedNode[], depth = 0): string[] =>
  nodes.flatMap((n) => [`${'  '.repeat(depth)}${n.name}${n.dir ? '/' : ''} ${n.stat.files} +${n.stat.additions} -${n.stat.deletions}${n.stat.binary ? ' bin' : ''}`, ...outline(n.children, depth + 1)])

describe('changedTree', () => {
  it('shows only changed files and their folders, with counts added up', () => {
    expect(outline(changedTree(MOCK))).toEqual([
      'build/ 1 +0 -0 bin',
      '  icon-dev.png 1 +0 -0 bin',
      'design/icons/ 2 +8 -7',
      '  foreman-dev-small.svg 1 +3 -3',
      '  foreman-dev.svg 1 +5 -4',
      'scripts/ 1 +14 -2',
      '  render-icons.mjs 1 +14 -2'
    ])
  })

  it('joins only chains of single folders, and keeps the deepest path for opening and closing', () => {
    const tree = changedTree([change('a/b/c/x.ts', 1, 0), change('a/b/y.ts', 2, 0), change('top.ts', 0, 1)])
    expect(outline(tree)).toEqual(['a/b/ 2 +3 -0', '  c/ 1 +1 -0', '    x.ts 1 +1 -0', '  y.ts 1 +2 -0', 'top.ts 1 +0 -1'])
    expect(tree[0].path).toBe('a/b')
    expect(tree[0].children[0].path).toBe('a/b/c')
    expect(tree[0].children[0].children[0].file?.path).toBe('a/b/c/x.ts')
  })

  it('is empty without changes', () => {
    expect(changedTree([])).toEqual([])
  })
})

describe('folderStats', () => {
  it('counts every folder up to the top, binary files without lines', () => {
    const stats = folderStats(MOCK)
    expect(stats.get('')).toEqual({ files: 4, additions: 22, deletions: 9, binary: 1 })
    expect(stats.get('design')).toEqual({ files: 2, additions: 8, deletions: 7, binary: 0 })
    expect(stats.get('design/icons')).toEqual(stats.get('design'))
    expect(stats.get('build')).toEqual({ files: 1, additions: 0, deletions: 0, binary: 1 })
    expect(stats.has('src')).toBe(false)
  })
})

describe('treeKey', () => {
  const rows: TreeRow[] = [
    { path: 'design', dir: true, depth: 0, expanded: true },
    { path: 'design/icons', dir: true, depth: 1, expanded: false },
    { path: 'design/a.svg', dir: false, depth: 1 },
    { path: 'src', dir: true, depth: 0, expanded: false },
    { path: 'README.md', dir: false, depth: 0 }
  ]

  it('moves up and down, stopping at the ends', () => {
    expect(treeKey(rows, 0, 'ArrowDown')).toEqual({ focus: 1 })
    expect(treeKey(rows, 4, 'ArrowDown')).toEqual({ focus: 4 })
    expect(treeKey(rows, 0, 'ArrowUp')).toEqual({ focus: 0 })
    expect(treeKey(rows, 3, 'Home')).toEqual({ focus: 0 })
    expect(treeKey(rows, 0, 'End')).toEqual({ focus: 4 })
  })

  it('→ opens a closed folder, then steps into it; does nothing on a file', () => {
    expect(treeKey(rows, 1, 'ArrowRight')).toEqual({ toggle: 'design/icons' })
    expect(treeKey(rows, 0, 'ArrowRight')).toEqual({ focus: 1 })
    expect(treeKey(rows, 2, 'ArrowRight')).toBeNull()
  })

  it('← closes an open folder, otherwise steps out to the parent', () => {
    expect(treeKey(rows, 0, 'ArrowLeft')).toEqual({ toggle: 'design' })
    expect(treeKey(rows, 2, 'ArrowLeft')).toEqual({ focus: 0 })
    expect(treeKey(rows, 1, 'ArrowLeft')).toEqual({ focus: 0 })
    expect(treeKey(rows, 4, 'ArrowLeft')).toBeNull()
  })

  it('Enter opens a file and toggles a folder', () => {
    expect(treeKey(rows, 2, 'Enter')).toEqual({ open: 'design/a.svg' })
    expect(treeKey(rows, 3, 'Enter')).toEqual({ toggle: 'src' })
  })

  it('with nothing focused, a move lands on the first row', () => {
    expect(treeKey(rows, -1, 'ArrowDown')).toEqual({ focus: 0 })
    expect(treeKey([], -1, 'ArrowDown')).toBeNull()
    expect(treeKey(rows, -1, 'Enter')).toBeNull()
  })
})
