// Finding Windows shells (O4): PATH, the usual install folders, and wsl.exe with an
// installed distribution. The file system and environment come in as a probe so tests
// can describe any machine. Windows paths throughout (path.win32), whatever runs this.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { KNOWN_SHELLS, parseCommandLine, type KnownShell, type ShellDetection } from '../shared/shells'

const win = path.win32

export interface ShellProbe {
  env: Record<string, string | undefined>
  exists(file: string): boolean
}

export const realProbe = (): ShellProbe => ({ env: process.env, exists: (file) => existsSync(file) })

function pathDirs(env: ShellProbe['env']): string[] {
  return (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)
}

/** The first `name` (e.g. pwsh.exe) on PATH, skipping folders `skip` rejects. */
export function lookPath(name: string, probe: ShellProbe, skip?: (dir: string) => boolean): string | null {
  for (const dir of pathDirs(probe.env)) {
    if (skip?.(dir)) continue
    const candidate = win.join(dir, name)
    if (probe.exists(candidate)) return candidate
  }
  return null
}

function first(probe: ShellProbe, candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) if (c && probe.exists(c)) return c
  return null
}

// System32 and WindowsApps hold WSL's bash.exe, which isn't Git Bash.
const notGitBash = (dir: string) => /\\(system32|sysnative|windowsapps)\\?$/i.test(dir)

/** Git Bash from a git.exe on PATH: <root>\cmd\git.exe, <root>\bin\git.exe or <root>\mingw64\bin\git.exe. */
function bashBesideGit(probe: ShellProbe): string | null {
  const git = lookPath('git.exe', probe)
  if (!git) return null
  let dir = win.dirname(git)
  if (/\\mingw(32|64)\\bin$/i.test(dir)) dir = win.dirname(win.dirname(dir))
  else if (/\\(cmd|bin)$/i.test(dir)) dir = win.dirname(dir)
  else return null
  return first(probe, [win.join(dir, 'bin', 'bash.exe')])
}

function find(shell: KnownShell, probe: ShellProbe): string | null {
  const { env } = probe
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const programFiles = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter((dir): dir is string => Boolean(dir))
  switch (shell) {
    case 'pwsh':
      return lookPath('pwsh.exe', probe) ?? first(probe, programFiles.map((dir) => win.join(dir, 'PowerShell', '7', 'pwsh.exe')))
    case 'powershell':
      return first(probe, [win.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]) ?? lookPath('powershell.exe', probe)
    case 'gitbash':
      return (
        first(probe, [
          ...programFiles.map((dir) => win.join(dir, 'Git', 'bin', 'bash.exe')),
          env.LOCALAPPDATA && win.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
          env.USERPROFILE && win.join(env.USERPROFILE, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe')
        ]) ??
        bashBesideGit(probe) ??
        lookPath('bash.exe', probe, notGitBash)
      )
    case 'cmd':
      return first(probe, [env.ComSpec ?? env.COMSPEC, win.join(systemRoot, 'System32', 'cmd.exe')]) ?? lookPath('cmd.exe', probe)
    case 'wsl':
      return first(probe, [win.join(systemRoot, 'System32', 'wsl.exe')]) ?? lookPath('wsl.exe', probe)
  }
}

/** Custom…'s executable: a full path that exists, or a bare name found on PATH. */
function findCustom(command: string, probe: ShellProbe): string | null {
  const [file] = parseCommandLine(command)
  if (!file) return null
  if (win.isAbsolute(file)) return probe.exists(file) ? file : null
  return lookPath(win.extname(file) ? file : `${file}.exe`, probe)
}

/**
 * Every shell's executable. `wsl` is what `wsl.exe --list` said: undefined when it wasn't
 * asked (starting a tab), and with no distribution WSL counts as not found.
 */
export function detectShells(probe: ShellProbe, custom: string, wsl?: { distros: string[]; default?: string }): ShellDetection {
  const paths = Object.fromEntries(KNOWN_SHELLS.map((shell) => [shell, find(shell, probe)])) as Record<KnownShell, string | null>
  if (wsl && !wsl.distros.length) paths.wsl = null
  return {
    paths,
    ...(wsl && wsl.distros.length ? { wslDistro: wsl.default ?? wsl.distros[0] } : {}),
    custom: { command: custom.trim(), path: findCustom(custom.trim(), probe) }
  }
}

/**
 * `wsl.exe --list --verbose`: a header line, then one line per distribution, the default marked
 * with *. A failed run (no distributions, WSL not enabled) prints help instead and lists none.
 */
export function parseWslList(output: string, ok: boolean): { distros: string[]; default?: string } {
  if (!ok) return { distros: [] }
  const lines = output
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(1)
  const distros: string[] = []
  let marked: string | undefined
  for (const line of lines) {
    const name = line.replace(/^\*\s*/, '').split(/\s+/)[0]
    if (!name) continue
    distros.push(name)
    if (line.startsWith('*')) marked = name
  }
  return { distros, ...(marked ? { default: marked } : {}) }
}

/** Ask wsl.exe which distributions are installed. Its output is UTF-16 unless WSL_UTF8 is set; both are handled. */
export function listWslDistros(wslExe: string, timeoutMs = 5000): Promise<{ distros: string[]; default?: string }> {
  return new Promise((resolve) => {
    execFile(wslExe, ['--list', '--verbose'], { encoding: 'buffer', timeout: timeoutMs, windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } }, (err, stdout) => {
      const buffer = stdout as Buffer
      // UTF-16LE: every other byte is zero for ASCII names.
      const utf16 = buffer.length > 1 && buffer[1] === 0
      resolve(parseWslList(buffer.toString(utf16 ? 'utf16le' : 'utf8'), !err))
    })
  })
}
