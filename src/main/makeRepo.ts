// "Make it a Git repository": a folder that isn't one yet gets `git init`, its current files staged
// (.gitignore respected) and a first commit, the way Quick start makes a new project. When Git doesn't
// know who the user is, nothing is committed and the caller gets 'needs-identity', so it can ask for a
// name and email and call again with them.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GitIdentity } from '../shared/types'
import { git, isInsideWorkTree, revParse, toplevel } from './git'

export type MakeRepoOutcome = { status: 'done'; dir: string } | { status: 'needs-identity' }

export interface MakeRepoOptions {
  // Defaults to the user's home folder; a folder that is it, or holds it, is refused.
  homeDir?: string
}

/** What `git commit` says when it doesn't know who the author is. */
const IDENTITY_ERROR = /Author identity unknown|Please tell me who you are|unable to auto-detect email address|empty ident name|user\.(name|email)/i

function real(p: string): string {
  const resolved = path.resolve(p)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

/** True when `inner` is `outer` or inside it. */
function within(outer: string, inner: string): boolean {
  const rel = path.relative(real(outer), real(inner))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Why this folder must not become a repository, or null. */
export function refusalFor(dir: string, homeDir: string = os.homedir()): string | null {
  const resolved = path.resolve(dir)
  if (path.parse(resolved).root === resolved) return `${resolved} is the top of a drive. Choose a project folder inside it instead.`
  if (homeDir && within(resolved, homeDir)) return `${resolved} is your home folder, or holds it. Choose a project folder inside it instead.`
  return null
}

/** Whether the folder has nothing in it but, possibly, an unfinished .git. */
function holdsNothing(dir: string): boolean {
  return readdirSync(dir).every((name) => name === '.git')
}

/** Makes the first commit; true when Git has no author to give it. */
async function commitFirst(dir: string, identity: GitIdentity | undefined): Promise<boolean> {
  const first = await git(dir, ['commit', '-q', '--allow-empty', '-m', 'Initial commit'], { allowFail: true })
  if (first.code === 0) return false
  if (IDENTITY_ERROR.test(first.stderr) && !identity) return true
  if (IDENTITY_ERROR.test(first.stderr)) throw new Error('Git still has no name and email to commit with. Check them and try again.')
  throw new Error(first.stderr.trim() || 'git commit failed')
}

/**
 * Initialise `dir` as a repository with one commit of what it holds now (a README when it is empty).
 * With `identity`, sets the author in the repository first (and globally if asked). A folder that is a
 * repository without any commit, left by an earlier attempt, is finished rather than started again.
 */
export async function makeRepository(dir: string, identity?: GitIdentity, opts: MakeRepoOptions = {}): Promise<MakeRepoOutcome> {
  let stat
  try {
    stat = statSync(dir)
  } catch {
    throw new Error(`${dir} doesn't exist`)
  }
  if (!stat.isDirectory()) throw new Error(`${dir} is not a folder`)
  const refused = refusalFor(dir, opts.homeDir)
  if (refused) throw new Error(refused)

  if (await isInsideWorkTree(dir)) {
    // Already a repository (or inside one): only a top folder without a first commit still needs one.
    const top = await toplevel(dir)
    if (real(top) !== real(dir) || (await revParse(dir, 'HEAD'))) return { status: 'done', dir }
  } else {
    await git(dir, ['init', '-q', '-b', 'main'])
  }

  if (identity) {
    const name = identity.name.trim()
    const email = identity.email.trim()
    if (!name || !/^\S+@\S+$/.test(email)) throw new Error('Enter your name and an email address like you@example.com')
    await git(dir, ['config', 'user.name', name])
    await git(dir, ['config', 'user.email', email])
    if (identity.global) {
      await git(dir, ['config', '--global', 'user.name', name])
      await git(dir, ['config', '--global', 'user.email', email])
    }
  }
  if (holdsNothing(dir) && !existsSync(path.join(dir, 'README.md'))) {
    await writeFile(path.join(dir, 'README.md'), `# ${path.basename(path.resolve(dir))}\n`)
  }
  await git(dir, ['add', '-A'])
  if (await commitFirst(dir, identity)) return { status: 'needs-identity' }
  return { status: 'done', dir }
}
