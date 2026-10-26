// "Files to copy": gitignored files (like .env) that new workspaces need but
// git won't bring along. Patterns are gitignore-style, and a repository's own
// .worktreeinclude file takes precedence over the patterns in Settings.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { git } from './git'

export const WORKTREE_INCLUDE = '.worktreeinclude'

interface Rule {
  negate: boolean
  dirOnly: boolean
  regex: RegExp
}

function toRegex(glob: string, anchored: boolean): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      // "**/" matches any number of folders, a trailing "**" anything below.
      out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  // Unanchored patterns match a name at any depth.
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${out}$`)
}

export function compileRules(patterns: string[]): Rule[] {
  const rules: Rule[] = []
  for (const raw of patterns) {
    let p = raw.trim()
    if (!p || p.startsWith('#')) continue
    const negate = p.startsWith('!')
    if (negate) p = p.slice(1)
    const dirOnly = p.endsWith('/')
    if (dirOnly) p = p.slice(0, -1)
    // A slash at the start or in the middle anchors the pattern to the repo root.
    const anchored = p.startsWith('/') || p.includes('/')
    if (p.startsWith('/')) p = p.slice(1)
    if (p) rules.push({ negate, dirOnly, regex: toRegex(p, anchored) })
  }
  return rules
}

/**
 * Whether a path is selected. As in .gitignore the last matching rule wins,
 * and a rule that matches a folder covers everything inside it. Paths use
 * forward slashes; folders end in "/".
 */
export function matches(rules: Rule[], file: string): boolean {
  const isDir = file.endsWith('/')
  const parts = (isDir ? file.slice(0, -1) : file).split('/')
  // The path itself, then each folder above it.
  const candidates = parts.map((_, i) => ({ path: parts.slice(0, parts.length - i).join('/'), isDir: i > 0 || isDir }))
  let hit = false
  for (const rule of rules) {
    if (candidates.some((c) => (!rule.dirOnly || c.isDir) && rule.regex.test(c.path))) hit = !rule.negate
  }
  return hit
}

/** The patterns in effect: .worktreeinclude when the repo has one, else Settings. */
export async function effectivePatterns(root: string, configured: string[]): Promise<{ patterns: string[]; fromWorktreeInclude: boolean }> {
  const include = path.join(root, WORKTREE_INCLUDE)
  if (existsSync(include)) {
    const text = await readFile(include, 'utf8').catch(() => '')
    return { patterns: text.split(/\r?\n/), fromWorktreeInclude: true }
  }
  return { patterns: configured, fromWorktreeInclude: false }
}

/** Gitignored paths in the repo root that the patterns select (folders end in "/"). */
export async function filesToCopy(root: string, patterns: string[]): Promise<string[]> {
  const rules = compileRules(patterns)
  if (!rules.length) return []
  // --directory reports an ignored folder once instead of every file inside it.
  const listed = await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { allowFail: true })
  if (listed.code !== 0) return []
  return listed.stdout
    .split('\0')
    .filter(Boolean)
    .filter((file) => !file.startsWith('.git/') && !file.startsWith('.context/'))
    .filter((file) => matches(rules, file))
    .sort()
}
