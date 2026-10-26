// Checkpoints snapshot a workspace (HEAD, index and the full working tree,
// untracked files included) into a private ref without touching any file,
// so a turn can be rolled back exactly.
//
// A checkpoint is a commit whose tree is the working tree. Its first parent
// is HEAD (when there is one) and its second parent is a commit of the index
// tree, which keeps every object reachable so `git gc` never prunes it.
//
// A cloud workspace's checkpoints are the same commits, made inside its sandbox: snapshot and save
// run as one bash script each (one round trip, the temporary index under /tmp), the rest as git.
import { copyFile, mkdtemp, realpath, rm, stat, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { busyOperation, git, gitOut, hasUnmergedPaths, revParse, type GitTarget } from './git'
import type { WorkspaceRuntime } from './runtime/types'

export const CHECKPOINT_REF_PREFIX = 'refs/switchyard-checkpoints/'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Switchyard',
  GIT_AUTHOR_EMAIL: 'switchyard@localhost',
  GIT_COMMITTER_NAME: 'Switchyard',
  GIT_COMMITTER_EMAIL: 'switchyard@localhost'
}

export type SaveResult = { ok: true; ref: string; tree?: string } | { ok: false; reason: string }

/**
 * Refuse to operate unless `dir` is itself the root of a working tree. If a
 * workspace directory lost its checkout, git would resolve an ancestor repo
 * and a restore would rewrite that repo instead.
 */
async function assertWorktreeRoot(dir: GitTarget): Promise<void> {
  const root = await gitOut(dir, ['rev-parse', '--show-toplevel'])
  if (typeof dir !== 'string') {
    if (path.posix.normalize(root) !== path.posix.normalize(dir.cwd)) throw new Error(`Refusing to touch ${root}: it is not the workspace root ${dir.cwd}`)
    return
  }
  const [a, b] = await Promise.all([realpath(root), realpath(dir)])
  // macOS and Windows filesystems are case-insensitive by default.
  const fold = (p: string) => (process.platform === 'linux' ? path.normalize(p) : path.normalize(p).toLowerCase())
  if (fold(a) !== fold(b)) {
    throw new Error(`Refusing to touch ${a}: it is not the workspace root ${b}`)
  }
}

/**
 * Copy an index file for a temporary snapshot. Git re-checks files changed in
 * the same instant the index was written by comparing them with the index
 * file's own timestamp, so the copy is backdated a second: a fresh timestamp
 * would make git trust stale cached stats and miss just-made edits.
 */
async function copyIndex(from: string, to: string): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(from)
    await copyFile(from, to)
    const before = Math.floor(mtimeMs / 1000) - 1
    await utimes(to, before, before)
    return true
  } catch {
    return false
  }
}

// The temporary index as above, in a shell function: a copy of the real one backdated a second, else HEAD's tree.
// GNU stat and touch first (the sandboxes' own), then BSD's, so the script runs the same in a macOS shell.
const SNAPSHOT_FN = `snapshot() (
  set -e
  mkdir -p /tmp
  tmp="$(mktemp -d /tmp/foreman-index.XXXXXX)"
  trap 'rm -rf "$tmp"' EXIT
  real="$(git rev-parse --git-path index)"
  export GIT_INDEX_FILE="$tmp/index"
  if [ -f "$real" ] && cp "$real" "$GIT_INDEX_FILE" 2>/dev/null; then
    before=$(( $(stat -c %Y "$real" 2>/dev/null || stat -f %m "$real") - 1 ))
    touch -d "@$before" "$GIT_INDEX_FILE" 2>/dev/null || touch -t "$(date -r "$before" +%Y%m%d%H%M.%S)" "$GIT_INDEX_FILE"
  elif git rev-parse -q --verify 'HEAD^{commit}' >/dev/null; then
    git read-tree HEAD
  fi
  git add -A -- .
  git write-tree
)`

const SCRIPT_HEAD = 'set -euo pipefail\nshopt -s inherit_errexit 2>/dev/null || true'

/** Run a checkpoint script in the runtime's worktree; its last line of output is the answer. */
async function runScript(rt: WorkspaceRuntime, script: string, args: string[], what: string): Promise<string> {
  const r = await rt.exec('bash', ['-c', `${SCRIPT_HEAD}\n${SNAPSHOT_FN}\n${script}`, 'checkpoint', ...args])
  if (r.code !== 0) throw new Error(`${what}: ${r.stderr.trim() || `exit code ${r.code}`}`)
  return r.stdout.trim().split('\n').pop() ?? ''
}

/** Tree object for the whole working tree, honoring .gitignore. Touches nothing. */
export async function snapshotWorkingTree(dir: GitTarget): Promise<string> {
  if (typeof dir !== 'string') return runScript(dir, 'snapshot', [], 'Couldn’t snapshot the working tree')
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'switchyard-index-'))
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') }
  try {
    // Start from a copy of the real index: its cached file stats let `git add`
    // skip unchanged files (seeding from HEAD re-hashed every file, which took
    // seconds per message in large repos). Tracked files that match .gitignore
    // stay included either way.
    const realIndex = path.resolve(dir, await gitOut(dir, ['rev-parse', '--git-path', 'index']))
    const copied = await copyIndex(realIndex, env.GIT_INDEX_FILE)
    if (!copied && (await revParse(dir, 'HEAD'))) await git(dir, ['read-tree', 'HEAD'], { env })
    await git(dir, ['add', '-A', '--', '.'], { env })
    return await gitOut(dir, ['write-tree'], { env })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

// saveCheckpoint below as one script: the same checks, commits and ref. Prints "ok <tree>" or "fail <reason>".
const SAVE_SCRIPT = `id="$1"
top="$(git rev-parse --show-toplevel)"
here="$(pwd -P)"
if [ "$(cd "$top" && pwd -P)" != "$here" ]; then echo "Refusing to touch $top: it is not the workspace root $here" >&2; exit 2; fi
busy() { [ -e "$(git rev-parse --git-path "$1")" ]; }
if busy rebase-merge || busy rebase-apply; then echo "fail rebase in progress"; exit 0; fi
if busy MERGE_HEAD; then echo "fail merge in progress"; exit 0; fi
if busy CHERRY_PICK_HEAD; then echo "fail cherry-pick in progress"; exit 0; fi
if busy REVERT_HEAD; then echo "fail revert in progress"; exit 0; fi
if [ -n "$(git ls-files -u)" ]; then echo "fail unresolved merge conflicts"; exit 0; fi
head="$(git rev-parse -q --verify 'HEAD^{commit}' || true)"
index_tree="$(git write-tree)"
tree="$(snapshot)"
export GIT_AUTHOR_NAME=Switchyard GIT_AUTHOR_EMAIL=switchyard@localhost GIT_COMMITTER_NAME=Switchyard GIT_COMMITTER_EMAIL=switchyard@localhost
index_commit="$(git commit-tree "$index_tree" -m "switchyard index $id")"
if [ -n "$head" ]; then parents=(-p "$head" -p "$index_commit"); else parents=(-p "$index_commit"); fi
commit="$(git commit-tree "$tree" "\${parents[@]}" -m "switchyard checkpoint $id

Switchyard-Head: \${head:-none}
Switchyard-Index: $index_tree
")"
git update-ref "${CHECKPOINT_REF_PREFIX}$id" "$commit"
echo "ok $tree"`

export async function saveCheckpoint(dir: GitTarget, id: string): Promise<SaveResult> {
  if (typeof dir !== 'string') {
    const line = await runScript(dir, SAVE_SCRIPT, [id], 'Couldn’t save a checkpoint')
    if (line.startsWith('fail ')) return { ok: false, reason: line.slice(5) }
    if (!line.startsWith('ok ')) throw new Error(`Couldn’t save a checkpoint: ${line || 'no answer'}`)
    return { ok: true, ref: CHECKPOINT_REF_PREFIX + id, tree: line.slice(3) }
  }
  await assertWorktreeRoot(dir)
  const busy = await busyOperation(dir)
  if (busy) return { ok: false, reason: `${busy} in progress` }
  if (await hasUnmergedPaths(dir)) return { ok: false, reason: 'unresolved merge conflicts' }

  const head = await revParse(dir, 'HEAD')
  const indexTree = await gitOut(dir, ['write-tree'])
  const worktreeTree = await snapshotWorkingTree(dir)

  const indexCommit = await gitOut(dir, ['commit-tree', indexTree, '-m', `switchyard index ${id}`], { env: IDENTITY })
  const parents = head ? ['-p', head, '-p', indexCommit] : ['-p', indexCommit]
  const message = `switchyard checkpoint ${id}\n\nSwitchyard-Head: ${head ?? 'none'}\nSwitchyard-Index: ${indexTree}\n`
  const commit = await gitOut(dir, ['commit-tree', worktreeTree, ...parents, '-m', message], { env: IDENTITY })

  const ref = CHECKPOINT_REF_PREFIX + id
  await git(dir, ['update-ref', ref, commit])
  // The tree is the snapshot of the working tree the checkpoint was taken from, so callers that also
  // want that state (like archive's kept diff) don't have to scan every file again.
  return { ok: true, ref, tree: worktreeTree }
}

async function readMeta(dir: GitTarget, commit: string): Promise<{ head: string | null; indexTree: string }> {
  const body = await gitOut(dir, ['cat-file', 'commit', commit])
  const head = /^Switchyard-Head: (\S+)$/m.exec(body)?.[1]
  const indexTree = /^Switchyard-Index: (\S+)$/m.exec(body)?.[1]
  if (!head || !indexTree) throw new Error('Not a Switchyard checkpoint')
  return { head: head === 'none' ? null : head, indexTree }
}

/**
 * Make HEAD, the index and the working tree match the checkpoint. Only files
 * that differ are rewritten, so file watchers in the workspace see the
 * minimum of changes. Ignored files are left alone.
 */
export async function restoreCheckpoint(dir: GitTarget, id: string): Promise<void> {
  await assertWorktreeRoot(dir)
  const commit = await revParse(dir, CHECKPOINT_REF_PREFIX + id)
  if (!commit) throw new Error(`Unknown checkpoint ${id}`)
  const { head, indexTree } = await readMeta(dir, commit)
  if (!head) throw new Error('Cannot restore a checkpoint taken before the first commit')
  if ((await busyOperation(dir)) === 'rebase') throw new Error('Finish or abort the rebase before restoring')
  const worktreeTree = await gitOut(dir, ['rev-parse', `${commit}^{tree}`])

  // Move HEAD back (and drop any merge/cherry-pick state) without touching files.
  const currentHead = await revParse(dir, 'HEAD')
  if (currentHead !== head || (await hasUnmergedPaths(dir)) || (await busyOperation(dir))) {
    await git(dir, ['reset', '-q', '--mixed', head])
  }

  // Stage the current working tree so read-tree knows which files exist, then
  // switch the index to the snapshot with -u to update only changed files.
  await git(dir, ['read-tree', '--reset', head])
  await git(dir, ['add', '-A', '--', '.'])
  await git(dir, ['read-tree', '--reset', '-u', worktreeTree])
  await git(dir, ['clean', '-fdq'])

  // Finally restore the staged state and refresh stat info.
  await git(dir, ['read-tree', '--reset', indexTree])
  await git(dir, ['update-index', '-q', '--refresh'], { allowFail: true })
}

/** Delete every checkpoint whose id starts with `prefix`. */
export async function deleteCheckpoints(dir: GitTarget, prefix: string): Promise<void> {
  const refs = await gitOut(dir, ['for-each-ref', '--format=%(refname)', `${CHECKPOINT_REF_PREFIX}${prefix}*`])
  for (const ref of refs.split('\n').filter(Boolean)) {
    await git(dir, ['update-ref', '-d', ref], { allowFail: true })
  }
}
