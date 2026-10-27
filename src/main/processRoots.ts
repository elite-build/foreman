// The processes Foreman starts for a workspace (its agents' processes, terminal tabs, setup and check scripts), by pid,
// so Settings → Experimental → Show resource usage can count each one's whole tree (Claude Code with the MCP servers and
// hooks it starts, a shell with what runs in it) against its workspace (processUsage.ts). One list per process: the app's,
// and the background agent host's for the turns it runs (asked for over its socket).
import type { ProcessRootKind } from '../shared/types'

export interface ProcessRoot {
  pid: number
  workspaceId: string
  kind: ProcessRootKind
}

const roots = new Map<number, ProcessRoot>()

/** Remember a started process; call the result when it has gone. A missing pid (it never started) or workspace is a no-op. */
export function trackProcess(pid: number | undefined, workspaceId: string | undefined, kind: ProcessRootKind): () => void {
  if (!pid || !workspaceId) return () => {}
  const root: ProcessRoot = { pid, workspaceId, kind }
  roots.set(pid, root)
  // A later process that got the same pid keeps its own entry.
  return () => {
    if (roots.get(pid) === root) roots.delete(pid)
  }
}

/**
 * A child process started with a workspace's environment (FOREMAN_WORKSPACE_ID, from WorkspaceService.env), forgotten
 * when it exits or fails to start.
 */
export function trackChild(
  child: { pid?: number; once(event: 'exit' | 'error', listener: () => void): unknown },
  env: Record<string, string | undefined> | undefined,
  kind: ProcessRootKind
): void {
  const untrack = trackProcess(child.pid, env?.FOREMAN_WORKSPACE_ID, kind)
  child.once('exit', untrack)
  child.once('error', untrack)
}

export function processRoots(): ProcessRoot[] {
  return [...roots.values()]
}
