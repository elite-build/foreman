// Every Mac/Windows difference lives in this file so the port to Windows is
// a matter of testing these functions, not hunting through the codebase.
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { scriptArgs, scriptShellPath, type ScriptShellChoice, type ShellLaunch } from '../shared/shells'
import { detectShells, realProbe } from './shells'

export const isWindows = process.platform === 'win32'

/** Full path of a program on the user's PATH (as their login shell sets it), or null. */
export function findOnPath(binary: string): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)
  // On Windows a bare name may be an .exe or a .cmd shim.
  const names = isWindows && !path.extname(binary) ? [`${binary}.exe`, `${binary}.cmd`, binary] : [binary]
  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Shell for interactive terminal tabs. */
export function interactiveShell(): { file: string; args: string[] } {
  if (isWindows) {
    const pwsh = findOnPath('pwsh.exe')
    if (pwsh) return { file: pwsh, args: ['-NoLogo'] }
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    return { file: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] }
  }
  return { file: process.env.SHELL || '/bin/zsh', args: ['-l'] }
}

// Settings → Advanced → Script shell (O4), Windows only. Core sets it at startup and when it changes.
let windowsScriptShell: ScriptShellChoice = 'cmd'

export function setScriptShell(choice: ScriptShellChoice): void {
  windowsScriptShell = choice
}

const SCRIPT_SHELL_NAMES: Record<ScriptShellChoice, string> = { cmd: 'Command Prompt', powershell: 'Windows PowerShell', gitbash: 'Git Bash' }

/**
 * The script shell when it isn't cmd.exe (Windows only), or null for cmd and other platforms, which
 * keep their usual command lines. Throws when the chosen shell isn't found rather than running the
 * script in a shell it wasn't written for.
 */
export function windowsScriptLaunch(script: string, login: boolean, choice = windowsScriptShell, probe = realProbe()): ShellLaunch | null {
  if (!isWindows || choice === 'cmd') return null
  const file = scriptShellPath(choice, detectShells(probe, ''))
  if (!file) throw new Error(`${SCRIPT_SHELL_NAMES[choice]} wasn't found, so the script didn't run. Install it or change Settings → Advanced → Script shell.`)
  return { file, ...scriptArgs(choice, script, login) }
}

/**
 * Command line that runs a user script inside a terminal (the Run tab).
 * Windows uses cmd.exe unless Settings → Advanced → Script shell says otherwise, so scripts
 * reference variables as %FOREMAN_PORT% (or $env:FOREMAN_PORT, $FOREMAN_PORT).
 */
export function scriptInTerminal(script: string): ShellLaunch {
  if (isWindows) return windowsScriptLaunch(script, true) ?? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', script] }
  return { file: process.env.SHELL || '/bin/zsh', args: ['-l', '-c', script] }
}

/** Markdown shell snippets use Bash, independently of the user's interactive shell. */
export function shellSnippet(script: string): { file: string; args: string[] } {
  const bash = isWindows ? findOnPath('bash') : '/bin/bash'
  if (!bash) throw new Error('Install Bash to run shell snippets (for example, Git for Windows)')
  return { file: bash, args: ['--noprofile', '--norc', '-c', script] }
}

/**
 * The `shell` option for child_process.spawn when running a user script
 * (setup scripts). Node runs `<shell> -c <script>` on POSIX and
 * `cmd.exe /d /s /c <script>` on Windows when given `true`.
 */
export function scriptShell(): string | true {
  return isWindows ? true : process.env.SHELL || '/bin/zsh'
}

/**
 * Spawn options that let killProcessTree reach every descendant: a new
 * process group on POSIX. On Windows a detached child would get its own
 * console window, and taskkill /T walks the tree anyway.
 */
export const treeSpawnOptions = { detached: !isWindows, windowsHide: true } as const

export function killProcessTree(pid: number): Promise<void> {
  if (isWindows) {
    return new Promise((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
    })
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
  return Promise.resolve()
}

const SKIPPED_ENV = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])

/**
 * Apps launched from Finder get launchd's minimal PATH, so tools like node,
 * pnpm or a Homebrew git are missing. Import the login shell's environment
 * once at startup. Windows GUI apps already inherit the user's environment.
 */
export function importLoginShellEnv(timeoutMs = 10_000): Promise<void> {
  if (isWindows) return Promise.resolve()
  const shell = process.env.SHELL || '/bin/zsh'
  const marker = '__FOREMAN_ENV_MARKER__'
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    // Its own process group, so a stuck shell can be killed with everything it started.
    const child = spawn(shell, ['-ilc', `printf '${marker}'; env -0; printf '${marker}'`], {
      detached: true,
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 16 * 1024 * 1024) stdout += chunk
    })
    child.on('error', finish)
    child.on('close', (code) => {
      if (code === 0 && !settled) {
        const body = stdout.split(marker)[1] ?? ''
        for (const entry of body.split('\0')) {
          const eq = entry.indexOf('=')
          if (eq <= 0) continue
          const key = entry.slice(0, eq)
          if (!SKIPPED_ENV.has(key)) process.env[key] = entry.slice(eq + 1)
        }
      }
      finish()
    })
    // A shell config that hangs (e.g. a stale lock) must not block startup: carry on
    // with the environment we already have. A child of the shell can hold the pipe
    // open after the shell dies, so don't wait for the exec callback either.
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig)
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => {
      // TERM first so tools like pyenv can clean up their lock files; KILL whatever is left.
      signal('SIGTERM')
      setTimeout(() => signal('SIGKILL'), 3000).unref()
      finish()
    }, timeoutMs)
  })
}

// User configuration that Claude Code reads from the environment. Everything
// else under CLAUDE_CODE_* is session state set by a parent Claude Code.
const CLAUDE_CODE_CONFIG_VARS = new Set([
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
])

/**
 * Environment for agent processes. Strips the markers a parent Claude Code
 * session sets (present when Foreman is launched from a Claude Code
 * terminal), which would otherwise leak into the nested agent.
 */
export function agentBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key.startsWith('CLAUDE_AGENT_SDK_')) continue
    // #2: a turn identity inherited from an agent's shell (Foreman started from one). Only agent turns get their own.
    if (key === 'FOREMAN_SESSION_ID' || key === 'FOREMAN_TURN_ID' || key === 'FOREMAN_TURN_TOKEN') continue
    if (key.startsWith('CLAUDE_CODE_') && !CLAUDE_CODE_CONFIG_VARS.has(key)) continue
    env[key] = value
  }
  return env
}

/** Quote one argument for the shell that runs terminal commands. */
export function shellQuote(arg: string): string {
  if (isWindows) return `"${arg.replace(/"/g, '""')}"`
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Directory name used for a workspace; safe on every filesystem. */
export function safeDirName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || 'workspace'
}

/**
 * The native Claude Code binary that ships with the Agent SDK as a
 * per-platform package (claude, or claude.exe on Windows). Packaged apps
 * cannot execute files inside app.asar, so point at the unpacked copy.
 */
export function bundledClaudeExecutable(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const manifest = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    const binary = path.join(path.dirname(manifest), isWindows ? 'claude.exe' : 'claude')
    const unpacked = binary.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    return existsSync(unpacked) ? unpacked : undefined
  } catch {
    // Let the SDK find its binary itself.
    return undefined
  }
}

