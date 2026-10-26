// Puts the `foreman` command on the user's PATH (Settings → Advanced). The packaged
// app ships a launcher in resources/cli that runs the CLI with the app's own binary,
// so Node.js needn't be installed; from source it's bin/foreman.mjs.
import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliInstallStatus } from '../shared/types'

export interface CliInstallOptions {
  // The launcher to link to.
  shim: string
  platform?: NodeJS.Platform
  home?: string
  // Folders to try, in order (default: /usr/local/bin, then ~/.local/bin).
  linkDirs?: string[]
  // Run a shell command as administrator (macOS asks for the password); throws when refused.
  runAsAdmin?: (command: string) => Promise<void>
  // The user's PATH entries.
  pathDirs?: () => Promise<string[]>
}

const NAME = 'foreman'

export function shimPath(options: { packaged: boolean; resourcesPath: string; appPath: string; platform?: NodeJS.Platform }): string {
  const platform = options.platform ?? process.platform
  if (!options.packaged) return path.join(options.appPath, 'bin', 'foreman.mjs')
  return path.join(options.resourcesPath, 'cli', platform === 'win32' ? 'foreman.cmd' : NAME)
}

function realpath(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

function defaultLinkDirs(home: string): string[] {
  return ['/usr/local/bin', path.join(home, '.local', 'bin')]
}

function run(file: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: { ...process.env, ...env }, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout)
    })
  })
}

/** Ask for an administrator password through the standard macOS dialog. */
export function macAdmin(command: string): Promise<void> {
  const script = `do shell script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`
  return run('osascript', ['-e', script]).then(
    () => undefined,
    (err: Error) => {
      throw new Error(/-128|cancel/i.test(err.message) ? 'Installation was cancelled' : err.message)
    }
  )
}

function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

// The user-level PATH on Windows, as new terminals will see it.
const WIN_READ_PATH = `[Environment]::GetEnvironmentVariable('Path', 'User')`
const WIN_ADD_PATH = `$p = [Environment]::GetEnvironmentVariable('Path', 'User'); $parts = @($p -split ';' | Where-Object { $_ }); if ($parts -notcontains $env:FOREMAN_CLI_DIR) { [Environment]::SetEnvironmentVariable('Path', (($parts + $env:FOREMAN_CLI_DIR) -join ';'), 'User') }`

function windowsPathDirs(): Promise<string[]> {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_READ_PATH]).then((out) => out.trim().split(';').filter(Boolean))
}

/** Whether `foreman` already runs this app's launcher, and from where. */
export async function cliStatus(options: CliInstallOptions): Promise<CliInstallStatus> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    const dir = path.dirname(options.shim)
    const dirs = await (options.pathDirs ?? windowsPathDirs)().catch(() => [])
    const installed = dirs.some((d) => path.resolve(d).toLowerCase() === dir.toLowerCase())
    return { installed, path: installed ? path.join(dir, path.basename(options.shim)) : null }
  }
  const target = realpath(options.shim)
  const home = options.home ?? os.homedir()
  for (const dir of options.linkDirs ?? defaultLinkDirs(home)) {
    const link = path.join(dir, NAME)
    if (target && realpath(link) === target) return { installed: true, path: link }
  }
  return { installed: false, path: null }
}

/**
 * Link `foreman` into the first folder that takes it: /usr/local/bin (as
 * administrator on macOS when needed), else ~/.local/bin. On Windows the
 * launcher's folder goes on the user's PATH instead.
 */
export async function installCli(options: CliInstallOptions): Promise<CliInstallStatus> {
  const platform = options.platform ?? process.platform
  const home = options.home ?? os.homedir()
  if (platform === 'win32') {
    if (!options.shim.endsWith('.cmd')) throw new Error('From source on Windows, run `npm link` in the Foreman repository instead')
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_ADD_PATH], { FOREMAN_CLI_DIR: path.dirname(options.shim) })
    return { installed: true, path: options.shim, note: 'Open a new terminal to use it.' }
  }
  // An AppImage is mounted somewhere new each run, so a link to it would break.
  if (platform === 'linux' && process.env.APPIMAGE) {
    throw new Error('The AppImage moves each time it runs; install Foreman another way to use the command')
  }
  if (!realpath(options.shim)) throw new Error(`The launcher is missing: ${options.shim}`)
  const dirs = options.linkDirs ?? defaultLinkDirs(home)
  let lastError: unknown
  for (const [i, dir] of dirs.entries()) {
    const link = path.join(dir, NAME)
    try {
      replaceLink(link, options.shim)
    } catch (err) {
      lastError = err
      const code = (err as NodeJS.ErrnoException).code
      const denied = code === 'EACCES' || code === 'EPERM'
      // /usr/local/bin is root's on a fresh Mac; it's on everyone's PATH, so it's worth a password.
      if (denied && i === 0 && platform === 'darwin' && options.runAsAdmin !== undefined) {
        await options.runAsAdmin(`mkdir -p ${shQuote(dir)} && ln -sfn ${shQuote(options.shim)} ${shQuote(link)}`)
        return { installed: true, path: link }
      }
      if (denied || code === 'ENOENT') continue
      throw err
    }
    const onPath = await (options.pathDirs ?? (async () => (process.env.PATH ?? '').split(path.delimiter)))()
    const note = onPath.some((d) => path.resolve(d) === path.resolve(dir)) ? undefined : `${dir} isn't on your PATH; add it in your shell profile.`
    return { installed: true, path: link, note }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not install the command')
}

/** Point `link` at `target`, replacing an older link but never someone's real file. */
function replaceLink(link: string, target: string): void {
  mkdirSync(path.dirname(link), { recursive: true })
  let existing: ReturnType<typeof lstatSync> | null = null
  try {
    existing = lstatSync(link)
  } catch {
    // Nothing there yet.
  }
  if (existing && !existing.isSymbolicLink()) throw Object.assign(new Error(`${link} already exists and isn't Foreman's`), { code: 'EEXIST' })
  if (existing) {
    // Keep it when it already points here.
    if (path.resolve(path.dirname(link), readlinkSync(link)) === target) return
    rmSync(link)
  }
  symlinkSync(target, link)
}
