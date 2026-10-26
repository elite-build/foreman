// OpenCode through the Agent Client Protocol (`opencode acp`).
import { existsSync } from 'node:fs'
import path from 'node:path'
import { isWindows } from '../platform'
import { createAcpDriver, listAcpModels, type AcpAgentConfig, type AcpModel } from './acp'
import type { OneShotOptions } from './types'

const INSTALL_HINT = 'Install it with `npm i -g opencode-ai` or the script at https://opencode.ai/install, or set its path in Settings.'

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * npm installs OpenCode on Windows as an `opencode.cmd` shim, which Node can
 * only start through a shell. The real opencode.exe sits in the package's
 * per-platform dependency next to the shim, so run that instead.
 */
function exeBehindShim(shim: string): string | undefined {
  const modules = path.join(path.dirname(shim), 'node_modules')
  const variants = process.arch === 'arm64' ? ['arm64'] : ['x64', 'x64-baseline']
  return variants
    .flatMap((v) => [
      path.join(modules, 'opencode-ai', 'node_modules', `opencode-windows-${v}`, 'bin', 'opencode.exe'),
      path.join(modules, `opencode-windows-${v}`, 'bin', 'opencode.exe')
    ])
    .find((candidate) => existsSync(candidate))
}

/** The OpenCode binary to run: the configured path, else the one on PATH. */
export function opencodeBinary(executablePath?: string): string {
  const configured = executablePath?.trim()
  if (!isWindows) return configured || 'opencode'
  if (configured && !/\.(cmd|bat|ps1)$/i.test(configured)) return configured
  if (!configured) {
    const exe = onPath('opencode.exe')
    if (exe) return exe
  }
  const shim = configured || onPath('opencode.cmd')
  // Unresolvable shims fail as "not installed", which points at Settings.
  return (shim && exeBehindShim(shim)) || 'opencode.exe'
}

const config: AcpAgentConfig = {
  kind: 'opencode',
  label: 'OpenCode',
  command: (exe) => ({ file: opencodeBinary(exe), args: ['acp'] }),
  installHint: INSTALL_HINT
}

export const opencodeDriver = createAcpDriver(config)

/** Models OpenCode can use with the user's configured providers. */
export function listOpencodeModels(options: OneShotOptions): Promise<AcpModel[]> {
  return listAcpModels(config, options)
}
