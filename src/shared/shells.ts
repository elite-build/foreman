// Windows shell choice (O4): which shell a terminal tab starts, and which shell runs
// scripts. Pure: the main process finds the executables (src/main/shells.ts) and the
// renderer shows what it found. macOS and Linux keep their login shell; none of this
// applies there.
import type { TFunction } from './i18n'

/** Shells Foreman looks for, in the order the Shell list shows them. */
export const KNOWN_SHELLS = ['pwsh', 'powershell', 'gitbash', 'cmd', 'wsl'] as const
export type KnownShell = (typeof KNOWN_SHELLS)[number]

/** Settings → General → Terminal → Shell. Automatic is pwsh if it's found, otherwise Windows PowerShell. */
export type ShellChoice = 'auto' | KnownShell | 'custom'
export const SHELL_CHOICES: readonly ShellChoice[] = ['auto', ...KNOWN_SHELLS, 'custom']

/** Settings → Advanced → Script shell: what runs Run scripts, setup, archive and checks on Windows. */
export const SCRIPT_SHELLS = ['cmd', 'powershell', 'gitbash'] as const
export type ScriptShellChoice = (typeof SCRIPT_SHELLS)[number]

export function isShellChoice(value: unknown): value is ShellChoice {
  return typeof value === 'string' && (SHELL_CHOICES as readonly string[]).includes(value)
}

export function isScriptShellChoice(value: unknown): value is ScriptShellChoice {
  return typeof value === 'string' && (SCRIPT_SHELLS as readonly string[]).includes(value)
}

/** What the main process found on this computer. */
export interface ShellDetection {
  // The executable for each shell, or null when it isn't there.
  paths: Record<KnownShell, string | null>
  // The default WSL distribution when wsl.exe was asked (the Shell list asks; starting a tab doesn't).
  wslDistro?: string
  // Custom…: the command line from Settings and the executable it names, or null (not set, or not found).
  custom: { command: string; path: string | null }
}

export interface ShellLaunch {
  file: string
  args: string[]
  // Extra environment for this shell.
  env?: Record<string, string>
}

/** Automatic's pick: pwsh if found, else Windows PowerShell, else null. It never falls back to anything else. */
export function autoShell(found: ShellDetection): 'pwsh' | 'powershell' | null {
  if (found.paths.pwsh) return 'pwsh'
  if (found.paths.powershell) return 'powershell'
  return null
}

/** Whether a choice can start: found, or Automatic (which always tries). */
export function shellAvailable(choice: ShellChoice, found: ShellDetection): boolean {
  if (choice === 'auto') return true
  if (choice === 'custom') return Boolean(found.custom.path)
  return Boolean(found.paths[choice])
}

/** The executable a choice runs, or null when it isn't found. */
export function shellPath(choice: ShellChoice, found: ShellDetection): string | null {
  if (choice === 'auto') {
    const pick = autoShell(found)
    return pick ? found.paths[pick] : null
  }
  if (choice === 'custom') return found.custom.path
  return found.paths[choice]
}

/**
 * Split a command line into its words: whitespace separates them, double quotes keep spaces
 * ("C:\Program Files\x\zsh.exe" -l). No other escapes, so Windows paths keep their backslashes.
 */
export function parseCommandLine(text: string): string[] {
  const words: string[] = []
  let word = ''
  let quoted = false
  let any = false
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted
      any = true
    } else if (!quoted && /\s/.test(ch)) {
      if (any) words.push(word)
      word = ''
      any = false
    } else {
      word += ch
      any = true
    }
  }
  if (any) words.push(word)
  return words
}

/**
 * How a found shell starts an interactive tab in `cwd`: PowerShell without its banner, Git Bash
 * as a login shell that stays in the folder (CHERE_INVOKING), cmd as is, and WSL in the worktree
 * through `--cd` (a Windows folder, reached through /mnt/c).
 */
export function interactiveArgs(shell: KnownShell, cwd: string): Omit<ShellLaunch, 'file'> {
  switch (shell) {
    case 'pwsh':
    case 'powershell':
      return { args: ['-NoLogo'] }
    case 'gitbash':
      return { args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } }
    case 'cmd':
      return { args: [] }
    case 'wsl':
      return { args: ['--cd', cwd] }
  }
}

/** Why a tab didn't get the shell it asked for, for the line the terminal shows. */
export interface ShellFallback {
  wanted: ShellChoice
  // What started instead (Automatic's pick).
  used: 'pwsh' | 'powershell' | null
}

/**
 * The shell a new tab starts. A choice that isn't found falls back to Automatic, and says so.
 * With nothing found at all, Windows PowerShell's usual path is tried, as before O4.
 */
export function resolveShell(choice: ShellChoice, found: ShellDetection, cwd: string, systemRoot = 'C:\\Windows'): ShellLaunch & { fallback?: ShellFallback } {
  if (choice === 'custom' && found.custom.path) {
    const [, ...args] = parseCommandLine(found.custom.command)
    return { file: found.custom.path, args }
  }
  if (choice !== 'auto' && choice !== 'custom' && found.paths[choice]) return { file: found.paths[choice]!, ...interactiveArgs(choice, cwd) }
  const pick = autoShell(found)
  const launch: ShellLaunch = pick
    ? { file: found.paths[pick]!, ...interactiveArgs(pick, cwd) }
    : { file: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args: ['-NoLogo'] }
  return choice === 'auto' ? launch : { ...launch, fallback: { wanted: choice, used: pick } }
}

/**
 * The command line that runs `script` with the script shell. `login` is for the Run tab, which,
 * like macOS's `$SHELL -l -c`, loads the shell's profile; setup and checks don't.
 * Variables: cmd reads %FOREMAN_PORT%, PowerShell $env:FOREMAN_PORT, Git Bash $FOREMAN_PORT.
 */
export function scriptArgs(shell: ScriptShellChoice, script: string, login: boolean): Omit<ShellLaunch, 'file'> {
  switch (shell) {
    case 'cmd':
      return { args: ['/d', '/s', '/c', script] }
    case 'powershell':
      return { args: ['-NoLogo', ...(login ? [] : ['-NoProfile']), '-NonInteractive', '-Command', script] }
    case 'gitbash':
      return login ? { args: ['--login', '-c', script], env: { CHERE_INVOKING: '1' } } : { args: ['-c', script] }
  }
}

/** For the Script shell: Windows PowerShell's path stands in for "powershell". */
export function scriptShellPath(shell: ScriptShellChoice, found: ShellDetection): string | null {
  return shell === 'powershell' ? found.paths.powershell : found.paths[shell]
}

/** A shell's name in the UI: "Git Bash", or "WSL (Ubuntu)" once the default distribution is known. */
export function shellName(choice: ShellChoice, t: TFunction, found?: ShellDetection | null): string {
  if (choice === 'wsl' && found?.wslDistro) return t('settings.terminal.shell.wslName', { distro: found.wslDistro })
  return t(`terminal.shell.name.${choice}`)
}

/** What a new tab with no shell of its own starts: the setting when it's found, otherwise Automatic's pick. */
export function defaultShell(setting: ShellChoice, found: ShellDetection): KnownShell | 'custom' | null {
  return setting !== 'auto' && shellAvailable(setting, found) ? setting : autoShell(found)
}

/**
 * The panel's new-terminal menu: every shell that was found (missing ones aren't offered), Custom… when
 * its executable is there, and which one a plain + would start.
 */
export function newTerminalShells(setting: ShellChoice, found: ShellDetection): { shell: KnownShell | 'custom'; isDefault: boolean }[] {
  const fallback = defaultShell(setting, found)
  const shells: (KnownShell | 'custom')[] = [...KNOWN_SHELLS.filter((shell) => found.paths[shell]), ...(found.custom.path ? (['custom'] as const) : [])]
  return shells.map((shell) => ({ shell, isDefault: shell === fallback }))
}
