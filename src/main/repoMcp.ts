// MCP servers a repository proposes in .foreman/settings.toml. They run commands
// on this Mac, so none of them starts until this Mac approved it, and the
// approval only holds while the server is exactly what was approved: command,
// args, variable names, vault scopes and the content of any repo script it runs.
// #20: every agent that takes them gets the same servers (AGENTS[agent].supportsRepoMcp: Claude, Codex,
// OpenCode and the Chat agents); Cursor and Terminal agents never do. Approval is per server, for all of them at once.
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { RepoMcpProposal, RepoMcpServer, RepoMcpView, Workspace } from '../shared/types'
import { wsPath } from '../shared/workspacePath'
import type { McpLaunch } from './agents/types'
import type { Environment } from './environment'
import { readSharedLayer } from './repoSettings'
import type { Store } from './store'
import type { WorkspaceService } from './workspaces'

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const MAX_SCRIPT_BYTES = 5 * 1024 * 1024
// A repo seen for years shouldn't grow this without bound.
const KEEP_FINGERPRINTS = 12

/**
 * Repo files the command runs: any word of the command line that is a file inside `root`.
 * What a script itself runs or sources is not followed, so the fingerprint says what it covers and no more.
 */
export function scriptFiles(server: RepoMcpServer, root: string): { path: string; hash: string }[] {
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return []
  }
  const found = new Map<string, string>()
  for (const word of [server.command, ...server.args]) {
    if (!word || word.startsWith('-') || word.includes('\0')) continue
    const file = path.resolve(root, word)
    try {
      const real = realpathSync(file)
      const rel = path.relative(realRoot, real)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
      const info = statSync(real)
      if (!info.isFile()) continue
      // Too large to read is itself a reason to look again when it changes.
      const data = info.size > MAX_SCRIPT_BYTES ? Buffer.from(`size:${info.size}:mtime:${info.mtimeMs}`) : readFileSync(real)
      found.set(rel.split(path.sep).join('/'), sha(data))
    } catch {
      // Not a file here (npx, a package name, a flag value).
    }
  }
  return [...found].map(([p, hash]) => ({ path: p, hash })).sort((a, b) => a.path.localeCompare(b.path))
}

/** The identity an approval is tied to. Any change in any part gives a different value. */
export function fingerprint(server: RepoMcpServer, scripts: { path: string; hash: string }[]): string {
  return sha(
    JSON.stringify({
      v: 1,
      name: server.name,
      command: server.command,
      args: server.args,
      env: [...server.env].sort(),
      scopes: [...server.scopes].sort(),
      scripts: scripts.map((s) => [s.path, s.hash])
    })
  )
}

export const ORIGIN_APPROVED = 'from repo · approved on this Mac'
export const ORIGIN_UNAPPROVED = 'from repo · not approved on this Mac'

export class RepoMcp {
  constructor(
    private store: Store,
    private workspaces: WorkspaceService,
    private environment: Environment
  ) {}

  private approvals(repoId: string): Record<string, string[]> {
    return this.store.state.mcpApprovals?.[repoId] ?? {}
  }

  private seen(repoId: string): Set<string> {
    return new Set(this.store.state.mcpSeen?.[repoId] ?? [])
  }

  /** What the repo proposes, with the scripts as they are in this workspace (which is what would run). */
  view(workspaceId: string): RepoMcpView {
    const ws = this.workspaces.workspace(workspaceId)
    if (!ws.path) return { proposals: [], unseen: false }
    const repo = this.workspaces.repo(ws.repoId)
    const layer = readSharedLayer(repo.rootPath)
    const approved = this.approvals(repo.id)
    const seen = this.seen(repo.id)
    const proposals: RepoMcpProposal[] = (layer.mcp ?? []).map((server) => {
      const scripts = scriptFiles(server, wsPath(ws))
      const print = fingerprint(server, scripts)
      const before = approved[server.name] ?? []
      const state = before.includes(print) ? 'approved' : before.length ? 'changed' : 'new'
      const have = this.environment.scopedVars(repo.id, server.scopes)
      return { server, fingerprint: print, scripts, state, missingEnv: server.env.filter((n) => !(n in have)) }
    })
    return { proposals, unseen: proposals.some((p) => p.state !== 'approved' && !seen.has(p.fingerprint)), file: layer.file }
  }

  /**
   * The user's answer to "This repo proposes N MCP servers": exactly these names are approved as they are now,
   * every other proposal is left unapproved (and an older approval of it is withdrawn). All shown are marked seen.
   * `shown` (name → fingerprint) is what the user looked at: when a named server isn't a proposal any more, or its
   * fingerprint differs now, nothing is approved and the error says to look again.
   */
  approve(workspaceId: string, names: string[], shown?: Record<string, string>): void {
    const ws = this.workspaces.workspace(workspaceId)
    const { proposals } = this.view(workspaceId)
    if (shown) {
      for (const name of names) {
        const now = proposals.find((p) => p.server.name === name)?.fingerprint
        if (now === undefined || shown[name] !== now) throw new Error(`The MCP server “${name}” isn’t what you were shown (it changed or is no longer proposed). Nothing was approved; look at the proposals again.`)
      }
    }
    const state = this.store.state
    const approvals = { ...state.mcpApprovals }
    const forRepo = { ...(approvals[ws.repoId] ?? {}) }
    const seen = [...this.seen(ws.repoId)]
    for (const p of proposals) {
      const name = p.server.name
      if (names.includes(name)) forRepo[name] = [p.fingerprint, ...(forRepo[name] ?? []).filter((f) => f !== p.fingerprint)].slice(0, KEEP_FINGERPRINTS)
      else if (forRepo[name]) {
        // Unchecked now: whatever was approved before no longer counts.
        delete forRepo[name]
      }
      if (!seen.includes(p.fingerprint)) seen.push(p.fingerprint)
    }
    approvals[ws.repoId] = forRepo
    state.mcpApprovals = approvals
    state.mcpSeen = { ...state.mcpSeen, [ws.repoId]: seen.slice(-KEEP_FINGERPRINTS * 4) }
    this.store.save()
  }

  /** Servers a tab in this workspace may start: approved as they are now, with only their declared variables. */
  launchable(ws: Workspace): Record<string, McpLaunch> {
    if (!ws.path) return {}
    const out: Record<string, McpLaunch> = {}
    const { proposals } = this.view(ws.id)
    for (const p of proposals) {
      if (p.state !== 'approved') continue
      const have = this.environment.scopedVars(ws.repoId, p.server.scopes)
      const env: Record<string, string> = {}
      for (const name of p.server.env) if (name in have) env[name] = have[name]
      out[p.server.name] = { command: p.server.command, args: p.server.args, env }
    }
    return out
  }

  /** Names of proposed servers and where Foreman got them, for /mcp-status. */
  origins(ws: Workspace): { name: string; approved: boolean; command: string }[] {
    if (!ws.path) return []
    return this.view(ws.id).proposals.map((p) => ({ name: p.server.name, approved: p.state === 'approved', command: [p.server.command, ...p.server.args].join(' ') }))
  }
}
