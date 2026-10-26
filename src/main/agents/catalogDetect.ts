// #22: finding the catalog's agents on this computer. Foreman looks for each
// binary on PATH and runs its version flag; it never installs anything. Both
// steps take their PATH, file check and runner as arguments so tests can
// inject them.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { AgentDetection, CatalogAgent } from '../../shared/agentCatalog'

export interface DetectDeps {
  // The PATH to search, as the user's login shell sets it.
  path: string
  platform: NodeJS.Platform
  // Windows PATHEXT (".COM;.EXE;.BAT;.CMD"); ignored elsewhere.
  pathExt?: string
  exists(file: string): boolean
  // Runs a program and resolves with its output; rejects with the output on failure.
  run(file: string, args: string[], env: Record<string, string>): Promise<string>
  env: Record<string, string>
}

const VERSION_TIMEOUT_MS = 5000

/** Runs `file args` the way the detector and the version check need: no shell on POSIX, .cmd shims through cmd.exe on Windows. */
export function runProgram(file: string, args: string[], env: Record<string, string>, platform: NodeJS.Platform = process.platform): Promise<string> {
  const launch = launchFor(file, args, platform)
  return new Promise((resolve, reject) => {
    execFile(launch.file, launch.args, { env, timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
      if (err) reject(new Error(output || err.message))
      else resolve(output)
    })
  })
}

export function realDetectDeps(env: Record<string, string> = process.env as Record<string, string>): DetectDeps {
  return {
    path: env.PATH ?? env.Path ?? '',
    platform: process.platform,
    pathExt: env.PATHEXT,
    exists: existsSync,
    run: (file, args, runEnv) => runProgram(file, args, runEnv),
    env
  }
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

/** Full path of the first of `names` found on PATH, or null. On Windows a bare name may be an .exe or a .cmd/.bat shim. */
export function findBinary(names: string[], deps: Pick<DetectDeps, 'path' | 'platform' | 'pathExt' | 'exists'>): string | null {
  const p = pathApi(deps.platform)
  const delimiter = deps.platform === 'win32' ? ';' : ':'
  const dirs = deps.path.split(delimiter).filter(Boolean)
  const exts = deps.platform === 'win32' ? (deps.pathExt || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : []
  for (const name of names) {
    const candidates = deps.platform === 'win32' && !p.extname(name) ? [...exts.map((e) => name + e), name] : [name]
    for (const dir of dirs) {
      for (const candidate of candidates) {
        const full = p.join(dir, candidate)
        if (deps.exists(full)) return full
      }
    }
  }
  return null
}

// ACP program discovery portions: Copyright 2026 Untrivial, Apache-2.0.
// Adapted for Foreman's executable settings; see NOTICE and docs/licenses/acp-integration.txt.
/**
 * G1: an agent whose ACP mode is a separate program (Pi's pi-acp, Antigravity's agy_acp_server), found
 * beside the agent's own CLI first (a fresh PATH search could pick another
 * installation), then on PATH. `cli` is the agent's binary when known (the configured path or the one on PATH).
 */
export function findAcpProgram(agent: CatalogAgent, cli: string | null | undefined, deps: Pick<DetectDeps, 'path' | 'platform' | 'pathExt' | 'exists'>): string | null {
  const names = acpProgramNames(agent, deps.platform)
  if (!names.length) return null
  const p = pathApi(deps.platform)
  const own = cli ?? findBinary(binariesForPlatform(agent, deps.platform), deps)
  if (own && p.isAbsolute(own)) {
    const beside = findBinary(names, { ...deps, path: p.dirname(own) })
    if (beside) return beside
  }
  return findBinary(names, deps)
}

/** The separate ACP program's names on this platform; [] when ACP is a mode of the agent's own CLI. */
export function acpProgramNames(agent: CatalogAgent, platform: NodeJS.Platform): string[] {
  if (!agent.acp?.binaries) return []
  return platform === 'win32' && agent.acp.winBinaries ? agent.acp.winBinaries : agent.acp.binaries
}

function binariesForPlatform(agent: CatalogAgent, platform: NodeJS.Platform): string[] {
  return platform === 'win32' && agent.winBinaries ? agent.winBinaries : agent.binaries
}

/**
 * How to start a program. Node can't spawn a Windows .cmd or .bat shim (npm's
 * global installs) without a shell, so those go through cmd.exe; everything
 * else starts directly. No /s: cmd then keeps the quotes Node puts around a
 * shim path with spaces (the agents' own arguments have none).
 */
export function launchFor(file: string, args: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args }
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', file, ...args] }
}

/** The version number in a program's --version output, else its last word. */
export function parseVersion(output: string): string | undefined {
  const text = output.trim()
  if (!text) return undefined
  return /\d+(\.\d+)+[\w.+-]*/.exec(text)?.[0] ?? (text.split(/\s+/).pop() || undefined)
}

/**
 * Whether an agent is installed and what version it says it is. `configured`
 * is a path the user set in Settings; found but failing its version check is
 * reported with the command and its output, not as "not installed".
 */
export async function detectAgent(agent: CatalogAgent, deps: DetectDeps, configured?: string): Promise<AgentDetection> {
  const checkedAt = new Date().toISOString()
  const found = configured?.trim() ? (deps.exists(configured.trim()) ? configured.trim() : null) : findBinary(agent.binaries, deps)
  // G1: a separate ACP program is reported on its own, so "installed" doesn't hide a missing pi-acp.
  const names = acpProgramNames(agent, deps.platform)
  const acpProgram = names.length ? { name: names[0], path: findAcpProgram(agent, found, deps) ?? undefined, install: agent.acp?.install } : undefined
  if (!found) return { id: agent.id, installed: false, checkedAt, ...(acpProgram ? { acpProgram } : {}) }
  const command = [found, ...agent.versionArgs].join(' ')
  try {
    const output = await deps.run(found, agent.versionArgs, deps.env)
    return { id: agent.id, installed: true, path: found, version: parseVersion(output), checkedAt, ...(acpProgram ? { acpProgram } : {}) }
  } catch (err) {
    return { id: agent.id, installed: true, path: found, checkedAt, error: { command, output: err instanceof Error ? err.message : String(err) }, ...(acpProgram ? { acpProgram } : {}) }
  }
}
