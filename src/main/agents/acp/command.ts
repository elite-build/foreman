// Resolving a program the way the ACP adapter's children need it (MCP servers and agent terminals): an absolute path, found
// on the agent's own PATH, with a Windows shim run through cmd.exe.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { findBinary } from '../catalogDetect'

/** `command` as an absolute path: itself, a path resolved against `cwd`, or a bare name found on the PATH of `env`. */
export function absoluteCommand(command: string, cwd: string, env: Record<string, string>, platform: NodeJS.Platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  if (p.isAbsolute(command)) return command
  if (/[\\/]/.test(command)) return p.resolve(cwd, command)
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? ''
  const pathExt = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATHEXT')?.[1]
  return findBinary([command], { path: pathVar, platform, pathExt, exists: existsSync }) ?? command
}
