// #22: Terminal agents. The agent's own CLI runs in a terminal tab inside the
// worktree, started directly (no login shell, so a provider key exported in a
// shell profile doesn't come back) with the environment Foreman builds for that
// agent: its own key only in API-key mode, and only the provider keys ticked
// for it. Foreman sees the process and when it last printed something, and
// nothing else: no turns, approvals or cost, and never "needs you".
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { binariesFor, catalogAgent, excludeAdditions, terminalCommandText, type CatalogAgent, type TerminalAgentRun } from '../shared/agentCatalog'
import type { ShellLaunch } from '../shared/shells'
import { findBinary, launchFor } from './agents/catalogDetect'
import { gitOut } from './git'

export interface TerminalAgentDeps {
  // Opens a pseudo-terminal running `launch` in `cwd`; returns its id.
  spawn(workspaceId: string, cwd: string, env: Record<string, string>, cols: number, rows: number, launch: ShellLaunch & { notice?: string }): string
  // The worktree a workspace runs in, or throws when it can't run an agent (archived, frozen…).
  worktree(workspaceId: string): { path: string; repoId: string }
  // The agent's environment (see agents/env.ts).
  env(agent: string, repoId: string, workspaceId: string): Record<string, string>
  // A custom executable set in Settings → Agents, if any.
  executablePath(agent: string): string | undefined
  // The PATH the binary is looked up on.
  path: () => string
  platform: NodeJS.Platform
  exists(file: string): boolean
  // Keeps the agent's scratch files out of git. Defaults to the worktree's .git/info/exclude.
  exclude?(worktree: string, patterns: string[]): Promise<void>
  now?: () => number
}

/** Adds patterns to the repository's info/exclude (shared by its worktrees), never to a tracked file. */
export async function excludeInGit(worktree: string, patterns: string[]): Promise<void> {
  if (!patterns.length) return
  const common = await gitOut(worktree, ['rev-parse', '--git-common-dir'])
  const exclude = path.resolve(worktree, common, 'info', 'exclude')
  const current = existsSync(exclude) ? await readFile(exclude, 'utf8') : ''
  const add = excludeAdditions(current, patterns)
  if (!add.length) return
  await mkdir(path.dirname(exclude), { recursive: true })
  await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`)
}

export class TerminalAgents {
  private live = new Map<string, TerminalAgentRun>()

  constructor(private deps: TerminalAgentDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The command a Terminal agent starts with, resolved on PATH (or its configured path). */
  launch(agent: CatalogAgent): ShellLaunch & { notice: string } {
    const configured = this.deps.executablePath(agent.id)?.trim()
    const file =
      configured ||
      findBinary(binariesFor(agent, this.deps.platform), { path: this.deps.path(), platform: this.deps.platform, exists: this.deps.exists, pathExt: process.env.PATHEXT })
    if (!file) throw new Error(`${agent.name} isn’t installed (${binariesFor(agent, this.deps.platform).join(' or ')} isn’t on your PATH). See ${agent.docsUrl}.`)
    const args = agent.terminal?.args ?? []
    return { ...launchFor(file, args, this.deps.platform), notice: `$ ${terminalCommandText(agent, path.basename(file).replace(/\.(exe|cmd|bat)$/i, ''))}` }
  }

  /** Start a Terminal agent in a workspace's worktree. Returns the terminal's id. */
  async start(workspaceId: string, agentId: string, cols: number, rows: number): Promise<string> {
    const agent = catalogAgent(agentId)
    if (agent?.level !== 'terminal') throw new Error('Unknown terminal agent')
    const { path: cwd, repoId } = this.deps.worktree(workspaceId)
    const launch = this.launch(agent)
    if (agent.scratch?.length) await (this.deps.exclude ?? excludeInGit)(cwd, agent.scratch).catch(() => undefined)
    const ptyId = this.deps.spawn(workspaceId, cwd, this.deps.env(agent.id, repoId, workspaceId), cols, rows, launch)
    const at = this.now()
    this.live.set(ptyId, { ptyId, workspaceId, agent: agent.id, startedAt: at, lastOutputAt: at })
    return ptyId
  }

  /** Called for every chunk of terminal output; only Terminal agents' terminals are tracked. */
  output(ptyId: string): void {
    const run = this.live.get(ptyId)
    if (run && run.exitCode === undefined) run.lastOutputAt = this.now()
  }

  exited(ptyId: string, code: number): void {
    const run = this.live.get(ptyId)
    if (run) run.exitCode = code
  }

  /** The tab was closed: forget the run. */
  forget(ptyId: string): void {
    this.live.delete(ptyId)
  }

  forgetWorkspace(workspaceId: string): void {
    for (const [id, run] of this.live) if (run.workspaceId === workspaceId) this.live.delete(id)
  }

  runs(): TerminalAgentRun[] {
    return [...this.live.values()].map((r) => ({ ...r }))
  }
}
