// The cloud runtime: a workspace's worktree inside a sandbox, reached through the provider seam.
// The handle is looked up on first use, so making a runtime costs nothing. Relative paths are
// relative to the sandbox worktree; output and exit codes come back as they would locally.
import path from 'node:path'
import type { SandboxHandle } from '../cloud/provider'
import type { WorkspaceRuntime } from './types'

export function cloudRuntime(handle: () => Promise<SandboxHandle>, cwd: string): WorkspaceRuntime {
  const at = (p: string) => path.posix.resolve(cwd, p)
  return {
    kind: 'cloud',
    cwd,
    exec: async (cmd, args, opts = {}) => (await handle()).exec(cmd, args, { ...opts, cwd: opts.cwd ? at(opts.cwd) : cwd }),
    readFile: async (p) => (await handle()).readFile(at(p)),
    writeFile: async (p, data, mode) => (await handle()).writeFile(at(p), data, mode),
    exists: async (p) => (await handle()).exists(at(p)),
    mkdir: async (p) => (await handle()).mkdir(at(p))
  }
}
