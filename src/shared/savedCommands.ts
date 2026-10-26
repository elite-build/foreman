// Cues (O9): saved shell commands such as "Reset test DB" → npm run db:reset. One click
// opens a new terminal tab named after the command in the current workspace, with the
// workspace's environment and the user's shell, and types the command there. Nothing goes
// to an agent. Personal commands are saved with the settings; a repository can share more
// in .foreman/settings.toml ([[commands]] name/command), which are read-only here and need
// approval on this computer before their first run and again whenever their text changes
// (the same approvals checks use). Pure: the main process reads files and runs things.
import type { TFunction } from './i18n'

/** Where a personal command is offered: in one repository's workspaces, or in all of them. */
export type CommandScope = 'repo' | 'all'

export interface SavedCommand {
  id: string
  name: string
  // The command line, typed into the tab's shell as written.
  command: string
  scope: CommandScope
  // Scope 'repo': the repository whose workspaces offer it.
  repoId?: string
  // A folder inside the workspace to start in (e.g. packages/api); unset: the workspace folder.
  cwd?: string
  // Set on commands from the repo's .foreman/settings.toml (read-only in the app).
  source?: 'repo'
  // Repo commands: this computer approved the current text (by its hash, shared with checks).
  approved?: boolean
}

/** One `[[commands]]` entry as the repo's settings.toml writes it. */
export interface RepoCommandDef {
  name: string
  command: string
  cwd?: string
}

export const COMMAND_NAME_MAX = 60
export const COMMAND_TEXT_MAX = 4000
export const MAX_SAVED_COMMANDS = 100
export const MAX_REPO_COMMANDS = 50

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function newCommandId(): string {
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** A command's name: whitespace collapsed, capped. Empty is not a name. */
export function normalizeCommandName(input: string): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, COMMAND_NAME_MAX).trim()
}

/**
 * The start folder as typed: relative to the workspace, with / separators. '' or '.' means the
 * workspace folder (undefined). An absolute path or one that climbs out with .. is refused (null).
 */
export function normalizeCommandCwd(input: string | undefined): string | undefined | null {
  const text = (input ?? '').trim().replace(/\\/g, '/')
  if (!text || text === '.' || text === './') return undefined
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text) || text.startsWith('~')) return null
  const parts: string[] = []
  for (const part of text.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  return parts.length ? parts.join('/') : undefined
}

/** The personal list as saved with the settings: malformed entries dropped, never marked as from the repo. */
export function parseSavedCommands(raw: unknown): SavedCommand[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: SavedCommand[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const name = typeof item.name === 'string' ? normalizeCommandName(item.name) : ''
    const command = typeof item.command === 'string' ? item.command.slice(0, COMMAND_TEXT_MAX) : ''
    if (!id || !name || seen.has(id) || id.startsWith('repo:')) continue
    const repoId = typeof item.repoId === 'string' && item.repoId ? item.repoId : undefined
    // "This repo" without a repository can't be offered anywhere; it becomes all repos.
    const scope: CommandScope = item.scope === 'repo' && repoId ? 'repo' : 'all'
    const cwd = typeof item.cwd === 'string' ? normalizeCommandCwd(item.cwd) : undefined
    seen.add(id)
    out.push({ id, name, command, scope, ...(scope === 'repo' ? { repoId } : {}), ...(cwd ? { cwd } : {}) })
    if (out.length === MAX_SAVED_COMMANDS) break
  }
  return out
}

/**
 * `[[commands]]` tables with a name and command (and an optional cwd); a `[commands]` table keyed by
 * name works too, as for checks. The first of a repeated name wins; entries without both are skipped.
 */
export function commandsFromToml(v: unknown): RepoCommandDef[] {
  const entries: [unknown, unknown][] = Array.isArray(v) ? v.map((entry) => [isObject(entry) ? entry.name : undefined, entry]) : isObject(v) ? Object.entries(v) : []
  const out: RepoCommandDef[] = []
  for (const [rawName, entry] of entries) {
    const name = typeof rawName === 'string' ? normalizeCommandName(rawName) : ''
    const command = typeof entry === 'string' ? entry : isObject(entry) && typeof entry.command === 'string' ? entry.command : ''
    if (!name || !command.trim() || command.length > COMMAND_TEXT_MAX || out.some((c) => c.name === name)) continue
    const cwd = isObject(entry) && typeof entry.cwd === 'string' ? normalizeCommandCwd(entry.cwd) : undefined
    // A start folder outside the workspace isn't followed; the entry is left out rather than run elsewhere.
    if (cwd === null) continue
    out.push({ name, command, ...(cwd ? { cwd } : {}) })
    if (out.length === MAX_REPO_COMMANDS) break
  }
  return out
}

/** "Tail API logs" → "tail-api-logs", for a repo command's id. */
export const commandSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'command'

export const repoCommandId = (repoId: string, name: string): string => `repo:${repoId}:${commandSlug(name)}`

/** A repository's shared commands as the app lists them, each marked approved or not on this computer. */
export function repoCommandList(repoId: string, defs: RepoCommandDef[], approved: (command: string) => boolean): SavedCommand[] {
  const used = new Set<string>()
  return defs.map((def) => {
    // Two names with the same slug ("Logs!" and "logs") still get distinct ids.
    let id = repoCommandId(repoId, def.name)
    for (let n = 2; used.has(id); n++) id = `${repoCommandId(repoId, def.name)}-${n}`
    used.add(id)
    return { id, name: def.name, command: def.command, scope: 'repo', repoId, source: 'repo', approved: approved(def.command), ...(def.cwd ? { cwd: def.cwd } : {}) }
  })
}

/** What a workspace in `repoId` offers: this repo's (yours, then the repo's own), and yours for all repos. */
export function commandsForRepo(personal: SavedCommand[], fromRepo: SavedCommand[], repoId: string): { repo: SavedCommand[]; all: SavedCommand[] } {
  return {
    repo: [...personal.filter((c) => c.scope === 'repo' && c.repoId === repoId), ...fromRepo.filter((c) => c.repoId === repoId)].filter((c) => c.command.trim()),
    all: personal.filter((c) => c.scope === 'all' && c.command.trim())
  }
}

/** One command a workspace in `repoId` offers, by id; undefined when it isn't offered there. */
export function findCommand(personal: SavedCommand[], fromRepo: SavedCommand[], repoId: string, id: string): SavedCommand | undefined {
  const { repo, all } = commandsForRepo(personal, fromRepo, repoId)
  return [...repo, ...all].find((c) => c.id === id)
}

/** A repo command this computer hasn't approved (new, or its text changed). Your own commands never ask. */
export const needsApproval = (c: SavedCommand): boolean => c.source === 'repo' && !c.approved

/** The text typed into the tab's shell: each line ends with Enter, so it runs as if typed. */
export function commandInput(command: string): string {
  const lines = command.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  return `${lines.replace(/\n/g, '\r')}\r`
}

/** The dimmed lines at the top of the tab: what ran and where ("▶ Reset test DB", the command, "in lisbon · its environment"). */
export function commandBanner(c: Pick<SavedCommand, 'name' | 'command' | 'cwd'>, workspace: string, t: TFunction): string {
  const first = c.command.trim().split(/\r?\n/)[0]
  const more = c.command.trim().includes('\n') ? ' …' : ''
  const where = c.cwd ? t('commands.tab.whereIn', { workspace, folder: c.cwd }) : t('commands.tab.where', { workspace })
  return [`▶ ${c.name}`, `  ${first}${more}`, `  ${where}`].join('\r\n')
}

// ---- G4 O9: the command's exit status ----

/** How a shell can be asked to report the last command's status: POSIX `$?`, PowerShell `$?`/`$LASTEXITCODE`, or cmd's ERRORLEVEL. */
export type StatusShell = 'posix' | 'powershell' | 'cmd'

/**
 * Which status marker a shell takes, from the program the tab starts. Unknown shells (fish, nu, a custom one)
 * get none: Foreman then relies on the shell's own integration (OSC 133), if it has one. WSL is assumed to
 * start a POSIX shell (bash or zsh, the usual defaults).
 */
export function statusShell(file: string): StatusShell | null {
  const name = file.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '')
  if (name === 'pwsh' || name === 'powershell') return 'powershell'
  if (name === 'cmd') return 'cmd'
  if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'wsl'].includes(name)) return 'posix'
  return null
}

/** cmd can't type an escape character (Esc clears its line), so it prints this plain marker instead of OSC 133. */
export const CMD_STATUS_MARKER = '[foreman:exit='

const STATUS_SUFFIX: Record<StatusShell, string> = {
  // The OSC 133 "command finished" sequence (FinalTerm / iTerm2 / VS Code shell integration) with the status.
  posix: `printf '\\033]133;D;%s\\007' "$?"`,
  // $? first, before anything else resets it; a native program's code is in $LASTEXITCODE.
  powershell: '$__fo=$?; $__fc=$(if ($__fo) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }); [Console]::Write("$([char]27)]133;D;$__fc$([char]7)")',
  // `call` expands %ERRORLEVEL% after the command ran (the ^ keeps the first pass from expanding it).
  cmd: `call echo ${CMD_STATUS_MARKER}%^ERRORLEVEL%]`
}

/**
 * The text typed into a saved command's shell (O9), with the status marker on its last line so the tab can
 * show ✓/✗. On the same line (not a line of its own) so a command that reads input never reads the marker.
 * A last line ending in a single `&` (run in the background) gets no marker: there's no status to report yet.
 */
export function commandInputWithStatus(command: string, shell: StatusShell | null): string {
  const lines = command.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  const last = lines.at(-1)!.trimEnd()
  if (shell && last.trim() && !/(^|[^&])&$/.test(last)) lines[lines.length - 1] = `${last}${shell === 'cmd' ? ' & ' : '; '}${STATUS_SUFFIX[shell]}`
  return `${lines.join('\r')}\r`
}

/**
 * Finds command statuses in a terminal's output: OSC 133;D;<code> (from the marker above, or the shell's own
 * integration) and cmd's plain marker. A marker split across chunks is still found: the unmatched end of each
 * chunk is kept for the next. A "finished" with no code says nothing about success, so it's skipped.
 */
export class CommandStatusScanner {
  private tail = ''

  feed(data: string): number[] {
    const text = this.tail + data
    const codes: number[] = []
    const re = /\x1b\]133;D(?:;(-?\d+))?[^\x07\x1b]*(?:\x07|\x1b\\)|\[foreman:exit=(-?\d+)\]/g
    let end = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      end = re.lastIndex
      const code = m[1] ?? m[2]
      if (code !== undefined) codes.push(Number(code))
    }
    this.tail = text.slice(end).slice(-64)
    return codes
  }
}
