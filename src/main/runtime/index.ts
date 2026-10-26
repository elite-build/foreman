// Where a workspace's git, scripts and files go: its folder here as a plain
// path (git and scripts run it as they always have), or its cloud sandbox as a runtime.
import type { Workspace } from '../../shared/types'
import { wsPath } from '../../shared/workspacePath'
import type { SandboxHandle } from '../cloud/provider'
import type { GitTarget } from '../git'
import { cloudRuntime } from './cloud'
import type { WorkspaceRuntime } from './types'

export type { RuntimeExecOptions, RuntimeExecResult, WorkspaceRuntime } from './types'
export { cloudRuntime }

export interface RuntimeDeps {
  // The workspace's sandbox (woken by its first command). Only asked for cloud workspaces.
  sandbox(ws: Workspace): Promise<SandboxHandle>
}

/** A cloud workspace's sandbox worktree. A local workspace has no runtime: its folder is the target (workspaceTarget). */
export function runtimeFor(ws: Workspace, deps: RuntimeDeps): WorkspaceRuntime {
  if (!ws.cloud) throw new Error(`${ws.name ?? ws.id} isn’t a cloud workspace`)
  return cloudRuntime(() => deps.sandbox(ws), ws.cloud.cwd)
}

/** What code holding only a Workspace needs to reach its sandbox. The app's SandboxManager is it. */
export interface CloudSandboxes extends RuntimeDeps {
  // Before a command that isn't a turn: resolves when the sandbox is running. A sleeping one is woken only with
  // `wake` (the user did something); a read (diff, status, a poll) never wakes it, and rejects saying why.
  ready(ws: Workspace, wake: boolean): Promise<void>
  // gh in the workspace's sandbox, as its repository's GitHub connection (GH_TOKEN for that one command).
  gh(ws: Workspace, args: string[], timeoutMs?: number, options?: { wake?: boolean }): Promise<string>
  // GH_TOKEN for one git command in the sandbox (push, fetch), when the repository has a token.
  githubEnv(ws: Workspace): Record<string, string>
}

let sandboxes: CloudSandboxes | null = null

/** The SandboxManager registers itself on construction (there is one per app; tests make their own). */
export function useCloudSandboxes(value: CloudSandboxes | null): void {
  sandboxes = value
}

export function cloudSandboxes(): CloudSandboxes {
  if (!sandboxes) throw new Error('Cloud workspaces aren’t available')
  return sandboxes
}

/**
 * Where git, scripts and files go for a workspace: its folder as a plain path (so local code paths
 * run exactly as before), or its sandbox's runtime. Throws like wsPath for a history-only workspace.
 * A cloud runtime's commands wait for a running sandbox; only with `wake` do they wake a sleeping one.
 */
export function workspaceTarget(ws: Workspace, options: { wake?: boolean } = {}): GitTarget {
  if (!ws.cloud) return wsPath(ws)
  const s = cloudSandboxes()
  return runtimeFor(ws, {
    sandbox: async (w) => {
      await s.ready(w, Boolean(options.wake))
      return s.sandbox(w)
    }
  })
}

/** The folder of a workspace, for features that only work on this computer: a cloud workspace gets a clear refusal. */
export function localOnly(ws: Workspace, what: string): string {
  if (ws.cloud) throw new Error(`${what} isn’t available in cloud workspaces yet.`)
  return wsPath(ws)
}
