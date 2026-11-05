// Before-and-after screenshots for a pull request that changes the UI (.claude/skills/create-pr/ui-changes.md).
//
//   npm run pr:screens -- capture --only <screen,…> [--base <ref>] [--out <dir>]
//     Takes the named fixture screens (SCREENS in src/main/screenshots.ts) twice with `npm run screens`: "before" from a
//     temporary worktree at <ref> (default: the merge base with origin/main) that borrows this checkout's node_modules,
//     and "after" from this working tree. Then it compares them into <out>/diff. The worktree is removed either way.
//   npm run pr:screens -- publish <png>… [--folder <name>]
//     Pushes the PNGs to the pr-screenshots branch on origin, under <folder>/ (default: the current branch), and prints
//     Markdown image links pinned to that commit, for the PR body. A shot from a capture's before/, after/ or diff/ folder
//     is published as before-<name>.png and so on. It never touches the working tree, the index or
//     another branch. The repository is public: publish only screenshots of the fixture, never of real data.
//
// Only Node built-ins and git, like scripts/release.mjs.

import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SCREENSHOT_BRANCH = 'pr-screenshots'
const MAX_BYTES = 5 * 1024 * 1024
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** "owner/repo" for a GitHub remote URL (https, ssh or scp form), or null for anything else. */
export function githubRepo(url) {
  const m = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/** A folder name for the screenshot branch: the branch name with anything but letters, digits, `.`, `_` and `-` as `-`. */
export function folderName(name) {
  const folder = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '')
  if (!folder) throw new Error(`No usable folder name in "${name}"`)
  return folder
}

/** The name a file is published under: a shot from a capture's before/, after/ or diff/ folder gets that as a prefix. */
export function publishedName(file) {
  const run = path.basename(path.dirname(file))
  return ['before', 'after', 'diff'].includes(run) ? `${run}-${path.basename(file)}` : path.basename(file)
}

/** Why a file can't be published (empty: it can). */
export function fileProblems(file) {
  let stat
  try {
    stat = statSync(file)
  } catch {
    return [`${file}: not found`]
  }
  if (!stat.isFile()) return [`${file}: not a file`]
  const size = stat.size
  const problems = []
  if (!/\.png$/i.test(file)) problems.push(`${file}: only .png files`)
  if (size > MAX_BYTES) problems.push(`${file}: ${(size / 1024 / 1024).toFixed(1)} MB, over 5 MB`)
  const head = Buffer.alloc(8)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, head, 0, 8, 0)
  } finally {
    closeSync(fd)
  }
  if (!head.equals(PNG)) problems.push(`${file}: not a PNG image`)
  return problems
}

// A push that lost the race to another one; anything else (no access, no network) is not worth retrying.
const LOST_RACE = /\[rejected\]|non-fast-forward|fetch first|cannot lock ref|failed to update ref/

/**
 * Commit `files` under `folder/` on top of the remote's screenshot branch (a branch of its own, no shared history) and
 * push it, retrying when another push got there first. A temporary index keeps the checkout untouched.
 */
export function publishScreens({ cwd = process.cwd(), files, folder, remote = 'origin', branch = SCREENSHOT_BRANCH, attempts = 3 }) {
  if (!files.length) throw new Error('Name at least one PNG to publish')
  const problems = files.flatMap(fileProblems)
  if (problems.length) throw new Error(problems.join('\n'))
  const names = files.map(publishedName)
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  if (dupes.length) throw new Error(`Two files share a name: ${[...new Set(dupes)].join(', ')}`)
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'foreman-pr-screens-index-'))
  // GIT_TERMINAL_PROMPT=0: without a credential helper, fail instead of waiting at a password prompt nobody sees.
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index'), GIT_TERMINAL_PROMPT: '0' }
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    for (let attempt = 1; ; attempt++) {
      const tip = git('ls-remote', remote, `refs/heads/${branch}`).split(/\s/)[0] ?? ''
      if (tip) git('fetch', '--quiet', '--no-tags', remote, `refs/heads/${branch}`)
      git('read-tree', ...(tip ? [tip] : ['--empty']))
      const paths = files.map((file, i) => {
        const blob = git('hash-object', '-w', '--', file)
        git('update-index', '--add', '--cacheinfo', `100644,${blob},${folder}/${names[i]}`)
        return `${folder}/${names[i]}`
      })
      const tree = git('write-tree')
      const commit = git('commit-tree', tree, ...(tip ? ['-p', tip] : []), '-m', `Screenshots for ${folder}`)
      try {
        git('push', '--quiet', remote, `${commit}:refs/heads/${branch}`)
        return { commit, paths }
      } catch (error) {
        if (attempt >= attempts || !LOST_RACE.test(String(error?.stderr ?? ''))) throw error
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Run `npm run screens` (scripts/screenshots.mjs) in `cwd`; its exit status. */
function screens(cwd, args) {
  return spawnSync(process.execPath, [path.join(cwd, 'scripts', 'screenshots.mjs'), ...args], { cwd, stdio: 'inherit' }).status ?? 1
}

/**
 * Run `fn` with a temporary detached worktree of `root` at `ref` whose node_modules links to `root`'s, then remove the
 * worktree whatever happens. Cleanup problems are reported, not thrown, so they never hide `fn`'s own error.
 */
/**
 * Remove the link at `link` and nothing it points to. On Windows it is a junction: `rmSync` won't take it without
 * `recursive`, which would empty the folder it points to, so it goes with `rmdirSync` (a junction is removed as an
 * empty directory); elsewhere a symbolic link goes with `unlinkSync`. Throws when `link` is there but isn't a link.
 * Nothing there is fine.
 */
export function removeLink(link) {
  let stats
  try {
    stats = lstatSync(link)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (!stats.isSymbolicLink()) throw new Error(`${link} is not a link, so it was left alone`)
  if (process.platform !== 'win32') return unlinkSync(link)
  try {
    rmdirSync(link)
  } catch {
    // A file symbolic link rather than a junction.
    unlinkSync(link)
  }
}

const present = (file) => {
  try {
    lstatSync(file)
    return true
  } catch {
    return false
  }
}

export function withBaseWorktree(root, ref, fn) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const parent = mkdtempSync(path.join(os.tmpdir(), 'foreman-pr-base-'))
  const worktree = path.join(parent, 'base')
  const modules = path.join(root, 'node_modules')
  const link = path.join(worktree, 'node_modules')
  try {
    git('worktree', 'add', '--quiet', '--detach', worktree, ref)
    if (existsSync(modules)) symlinkSync(modules, link, process.platform === 'win32' ? 'junction' : 'dir')
    return fn(worktree)
  } finally {
    const problems = []
    // The link itself, before the worktree goes: never what it points to.
    try {
      removeLink(link)
    } catch (error) {
      problems.push(`could not remove the node_modules link: ${error instanceof Error ? error.message : error}`)
    }
    // Only once the link is gone: removing the worktree (git, or rmSync) would follow it into the checkout's node_modules.
    if (present(link)) problems.push(`left ${parent} in place: its node_modules link to ${modules} is still there`)
    else {
      try {
        if (existsSync(worktree)) git('worktree', 'remove', '--force', worktree)
      } catch (error) {
        problems.push(`could not remove the worktree ${worktree}: ${error instanceof Error ? error.message : error}`)
      }
      try {
        git('worktree', 'prune')
        rmSync(parent, { recursive: true, force: true })
      } catch (error) {
        problems.push(`could not clean up ${parent}: ${error instanceof Error ? error.message : error}`)
      }
    }
    if (existsSync(modules) && !existsSync(path.join(modules, '.package-lock.json'))) problems.push(`${modules} looks emptied: run npm ci`)
    for (const p of problems) console.error(`pr-screens: ${p}`)
  }
}

function capture({ only, base, out }) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
  if (!only) throw new Error('Name the screens with --only <screen,…> (SCREENS in src/main/screenshots.ts)')
  const ref = base ?? git('merge-base', 'origin/main', 'HEAD')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const dir = path.resolve(out ?? path.join(os.tmpdir(), 'foreman-pr-screens', `${folderName(git('rev-parse', '--abbrev-ref', 'HEAD'))}-${stamp}`))
  // Shots left from an earlier run would be compared as if they were this one's.
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty: choose another --out`)
  const [before, after, diff] = ['before', 'after', 'diff'].map((d) => path.join(dir, d))
  mkdirSync(dir, { recursive: true })
  withBaseWorktree(root, ref, (worktree) => {
    console.log(`Before: ${ref.slice(0, 12)}`)
    if (screens(worktree, ['--only', only, '--out', before, '--build'])) throw new Error('The "before" capture failed (output above)')
  })
  console.log('After: this working tree')
  if (screens(root, ['--only', only, '--out', after])) throw new Error('The "after" capture failed (output above)')
  // Exits 1 when anything differs, which is the point here.
  screens(root, ['--compare', before, after, '--diff', diff])
  console.log(`
Before: ${before}
After:  ${after}
Diff:   ${diff}
A screen can differ without a code change (the host's agent sign-in state, the pointer's hover): check the diff image.
Before publishing, look at each shot for anything from this machine (a user name in a path, a real repository).
Next: npm run pr:screens -- publish <png>…`)
}

function publish(files, folder) {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim()
  const repo = githubRepo(url)
  if (!repo) throw new Error(`origin is not a GitHub repository: ${url}`)
  const name = folder ?? folderName(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim())
  const { commit, paths } = publishScreens({ cwd: root, files: files.map((f) => path.resolve(f)), folder: folderName(name) })
  console.log(`Pushed to ${SCREENSHOT_BRANCH} at ${commit.slice(0, 12)}:\n`)
  for (const p of paths) console.log(`![${path.basename(p, '.png')}](https://github.com/${repo}/raw/${commit}/${p.split('/').map(encodeURIComponent).join('/')})`)
}

/** The command, its `--name value` options and its other arguments. */
export function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) positional.push(rest[i])
    else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) options[rest[i].slice(2)] = rest[++i]
    else throw new Error(`${rest[i]} needs a value`)
  }
  return { command, options, positional }
}

// import.meta.url is the real path; argv[1] may reach it through a symlink, junction or subst drive.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const { command, options, positional } = parseArgs(process.argv.slice(2))
    if (command === 'capture' && !positional.length) capture(options)
    else if (command === 'publish') publish(positional, options.folder)
    else throw new Error('Usage: npm run pr:screens -- capture --only <screen,…> [--base <ref>] [--out <dir>]\n       npm run pr:screens -- publish <png>… [--folder <name>]')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
