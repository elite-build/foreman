// Which data folder `npm run dev` gives the development app (scripts/dev.mjs; docs/map.md, "Configuration and
// environment"). By default each worktree has its own, so a development run never opens the installed Foreman's
// repositories, chats and secrets: a folder in the OS's application data folder (as Electron's appData), named for
// the worktree and keyed by a hash of its path. Never inside the worktree itself: Foreman makes a workspace's worktree
// again without its ignored files, which would lose it. FOREMAN_DATA_DIR (or the older SWITCHYARD_DATA_DIR) still
// chooses the folder; `--real-data` uses the installed app's.
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const REAL_DATA_FLAG = '--real-data'

/** The per-user application data folder, where Electron's app.getPath('appData') is. */
export function appDataFolder(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return env.APPDATA || path.join(home, 'AppData', 'Roaming')
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support')
  return env.XDG_CONFIG_HOME || path.join(home, '.config')
}

/** The worktree's own development data folder: `<appData>/Foreman Dev/<worktree folder name>-<hash of its path>`. */
export function worktreeDataDir(worktree, appData, platform = process.platform) {
  const root = path.resolve(worktree)
  // Windows paths compare without case, so C:\Code\x and c:\code\x are one worktree.
  const hash = createHash('sha256').update(platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 10)
  const name = path.basename(root).replace(/[^\w.-]+/g, '-').slice(0, 40) || 'worktree'
  return path.join(appData, 'Foreman Dev', `${name}-${hash}`)
}

/**
 * The data folder for a development run, from its environment and arguments: `dir` to set as FOREMAN_DATA_DIR (absent:
 * leave the environment as it is), why (`env`, `real` or `worktree`), and the arguments without `--real-data`.
 */
export function devDataDir({ cwd = process.cwd(), env = process.env, args = [], platform = process.platform, home = os.homedir() } = {}) {
  const real = args.includes(REAL_DATA_FLAG)
  const rest = args.filter((a) => a !== REAL_DATA_FLAG)
  const own = env.FOREMAN_DATA_DIR || env.SWITCHYARD_DATA_DIR
  if (own) return { source: 'env', shown: own, args: rest }
  if (real) return { source: 'real', args: rest }
  const dir = worktreeDataDir(cwd, appDataFolder(platform, env, home), platform)
  return { source: 'worktree', dir, shown: dir, args: rest }
}
