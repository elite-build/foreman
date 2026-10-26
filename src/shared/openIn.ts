// Open in detected apps (#14): the editors, terminals and file manager the Open button,
// ⌘O and the file viewer offer. Pure: the main process looks for them (src/main/openIn.ts)
// and launches them; the renderer lists what it found. The old Editor command stays as
// "Custom command…", the fallback for anything not listed.

export const OPEN_IN_APP_IDS = [
  'vscode',
  'vscode-insiders',
  'cursor',
  'windsurf',
  'zed',
  'intellij',
  'webstorm',
  'pycharm',
  'sublime',
  'windows-terminal',
  'terminal',
  'iterm',
  'ghostty',
  'files'
] as const
export type OpenInAppId = (typeof OPEN_IN_APP_IDS)[number]

export type OpenInKind = 'editor' | 'terminal' | 'files'

/**
 * How an app is told the line: `code -g file:line` (goto), `zed file:line` (colon),
 * `idea --line N file` (jetbrains), or not at all (the file, or the folder, opens).
 */
export type LineStyle = 'goto' | 'colon' | 'jetbrains' | 'none'

export interface OpenInAppInfo {
  id: OpenInAppId
  name: string
  kind: OpenInKind
  line: LineStyle
  // One or two letters for the small icon.
  monogram: string
  platforms: readonly ('win32' | 'darwin')[]
}

const BOTH = ['win32', 'darwin'] as const

/** The catalogue, in the order menus list it: editors, then terminals, then the file manager. */
export const OPEN_IN_APPS: readonly OpenInAppInfo[] = [
  { id: 'vscode', name: 'VS Code', kind: 'editor', line: 'goto', monogram: 'VS', platforms: BOTH },
  { id: 'vscode-insiders', name: 'VS Code Insiders', kind: 'editor', line: 'goto', monogram: 'VI', platforms: BOTH },
  { id: 'cursor', name: 'Cursor', kind: 'editor', line: 'goto', monogram: 'Cu', platforms: BOTH },
  { id: 'windsurf', name: 'Windsurf', kind: 'editor', line: 'goto', monogram: 'Ws', platforms: BOTH },
  { id: 'zed', name: 'Zed', kind: 'editor', line: 'colon', monogram: 'Z', platforms: BOTH },
  { id: 'intellij', name: 'IntelliJ IDEA', kind: 'editor', line: 'jetbrains', monogram: 'IJ', platforms: BOTH },
  { id: 'webstorm', name: 'WebStorm', kind: 'editor', line: 'jetbrains', monogram: 'WS', platforms: BOTH },
  { id: 'pycharm', name: 'PyCharm', kind: 'editor', line: 'jetbrains', monogram: 'PC', platforms: BOTH },
  { id: 'sublime', name: 'Sublime Text', kind: 'editor', line: 'colon', monogram: 'S', platforms: BOTH },
  { id: 'windows-terminal', name: 'Windows Terminal', kind: 'terminal', line: 'none', monogram: '>_', platforms: ['win32'] },
  { id: 'terminal', name: 'Terminal', kind: 'terminal', line: 'none', monogram: '>_', platforms: ['darwin'] },
  { id: 'iterm', name: 'iTerm', kind: 'terminal', line: 'none', monogram: 'iT', platforms: ['darwin'] },
  { id: 'ghostty', name: 'Ghostty', kind: 'terminal', line: 'none', monogram: 'Gh', platforms: ['darwin'] },
  { id: 'files', name: 'File Explorer', kind: 'files', line: 'none', monogram: '', platforms: BOTH }
]

export function openInAppInfo(id: OpenInAppId): OpenInAppInfo {
  return OPEN_IN_APPS.find((app) => app.id === id)!
}

/** File Explorer on Windows, Finder on macOS. */
export function openInAppName(id: OpenInAppId, platform: string): string {
  if (id === 'files') return platform === 'darwin' ? 'Finder' : 'File Explorer'
  return openInAppInfo(id).name
}

export function isOpenInAppId(value: unknown): value is OpenInAppId {
  return typeof value === 'string' && (OPEN_IN_APP_IDS as readonly string[]).includes(value)
}

/** Where Foreman found an app. "user" is a path set in Settings. */
export type FoundWhere = 'path' | 'registry' | 'folder' | 'toolbox' | 'spotlight' | 'applications' | 'builtin' | 'user'

/** One catalogue app on this computer: found (path set) or missing (path null). */
export interface OpenInApp {
  id: OpenInAppId
  name: string
  kind: OpenInKind
  // Opens a file at a line on this computer (an app found without its command-line tool can't).
  atLine: boolean
  // What Foreman launches, as shown in Settings (an .exe, a command-line tool or a macOS .app); null when not found.
  path: string | null
  found: FoundWhere | null
  // What detection found, before the user's own path.
  detected: string | null
  detectedWhere: FoundWhere | null
  // The executable actually run when it isn't `path`: the command-line tool inside an app (code.cmd, Contents/…/bin/code).
  launcher?: string
  // Settings → Open in apps → Change…: the user's own path, and whether it's missing.
  userPath?: string
  userPathMissing?: boolean
}

export interface OpenInDetection {
  platform: string
  // Every catalogue app for this platform, found or not, in catalogue order.
  apps: OpenInApp[]
  checkedAt: string
}

/** Settings' default app: '' is Automatic, 'custom' the custom command. */
export type OpenInChoice = '' | 'custom' | OpenInAppId

export function isOpenInChoice(value: unknown): value is OpenInChoice {
  return value === '' || value === 'custom' || isOpenInAppId(value)
}

/** What Foreman opens: always a folder (the workspace root), and a file and line when one is shown. */
export interface OpenInTarget {
  folder: string
  file?: string
  line?: number
}

// The command each app installs; an old Editor command naming exactly one of these becomes that app.
const COMMANDS: Record<string, OpenInAppId> = {
  'code-insiders': 'vscode-insiders',
  cursor: 'cursor',
  windsurf: 'windsurf',
  zed: 'zed',
  idea: 'intellij',
  webstorm: 'webstorm',
  pycharm: 'pycharm',
  subl: 'sublime'
}

/**
 * The default app for someone upgrading from the single Editor command. The command itself is
 * never changed: it stays as Custom command…. Empty or `code` (the old default) is Automatic;
 * a bare command we know becomes that app; anything else (arguments, another program) keeps
 * running exactly as before, as Custom command….
 */
export function defaultFromEditorCommand(command: string): OpenInChoice {
  const trimmed = command.trim()
  if (!trimmed || trimmed === 'code') return ''
  return COMMANDS[trimmed.toLowerCase()] ?? 'custom'
}

/** Apps the menus list: found ones only, in catalogue order. */
export function foundApps(detection: OpenInDetection | null): OpenInApp[] {
  return (detection?.apps ?? []).filter((app) => app.path !== null)
}

export type ResolvedDefault =
  | { kind: 'app'; app: OpenInApp }
  | { kind: 'custom'; command: string }
  // The chosen default isn't on this computer (any more): the Open button shows the menu and says why.
  | { kind: 'missing'; choice: Exclude<OpenInChoice, ''> }
  | { kind: 'none' }

/**
 * What the Open button and Enter in ⌘O run. Automatic is the first editor found, else the
 * custom command, else the file manager. A chosen app that isn't found is reported as
 * missing rather than silently swapped for another.
 */
export function resolveDefault(choice: OpenInChoice, detection: OpenInDetection | null, customCommand: string): ResolvedDefault {
  const custom = customCommand.trim()
  if (choice === 'custom') return custom ? { kind: 'custom', command: custom } : { kind: 'missing', choice }
  if (choice) {
    if (!detection) return { kind: 'none' }
    const app = detection.apps.find((a) => a.id === choice)
    return app?.path ? { kind: 'app', app } : { kind: 'missing', choice }
  }
  const found = foundApps(detection)
  const editor = found.find((app) => app.kind === 'editor')
  if (editor) return { kind: 'app', app: editor }
  if (custom) return { kind: 'custom', command: custom }
  const files = found.find((app) => app.kind === 'files')
  return files ? { kind: 'app', app: files } : { kind: 'none' }
}

/**
 * The arguments for an editor: the file at the line where the app can do that, else the file,
 * else the folder. Terminals and the file manager aren't editors and get the folder elsewhere.
 */
export function editorArgs(line: LineStyle, target: OpenInTarget): string[] {
  const subject = target.file ?? target.folder
  if (!target.file || !target.line || target.line < 1) return [subject]
  switch (line) {
    case 'goto':
      return ['-g', `${target.file}:${target.line}`]
    case 'colon':
      return [`${target.file}:${target.line}`]
    case 'jetbrains':
      return ['--line', String(target.line), target.file]
    case 'none':
      return [subject]
  }
}

/** An absolute path for a file inside the workspace, with the platform's separators. */
export function joinWorkspace(root: string, rel: string): string {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(root)
  const joined = `${root.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`
  return windows ? joined.replace(/\//g, '\\') : joined
}

/** The ⌘O shortcut: ⌘O on macOS; elsewhere Ctrl+O already expands tool calls, so Ctrl+Shift+O. */
export function openInShortcut(platform: string | undefined): string {
  return platform === 'darwin' ? '⌘O' : 'Ctrl+Shift+O'
}

// ---- G4 #14: real app icons ----

// The program beside a `bin\<tool>.cmd` launcher (Windows), by app. Its icon is the app's own.
const WINDOWS_EXE: Partial<Record<OpenInAppId, string>> = {
  vscode: 'Code.exe',
  'vscode-insiders': 'Code - Insiders.exe',
  cursor: 'Cursor.exe',
  windsurf: 'Windsurf.exe',
  zed: 'Zed.exe',
  sublime: 'sublime_text.exe'
}

/**
 * Files whose icon is the app's icon, best first: the macOS .app bundle around a command-line tool,
 * the Windows program beside a `bin\code.cmd` launcher, or the app's path itself when it's a program.
 * Pure; main checks which exist and asks the OS for the icon (`app.getFileIcon`).
 */
export function iconSources(app: Pick<OpenInApp, 'id' | 'path' | 'launcher'>, platform: string): string[] {
  const out: string[] = []
  const add = (file: string | null | undefined) => {
    if (file && !out.includes(file)) out.push(file)
  }
  for (const file of [app.path, app.launcher]) {
    if (!file) continue
    if (platform === 'darwin') {
      const bundle = /^(.*?\.app)(?:\/|$)/i.exec(file)
      add(bundle ? bundle[1] : file)
      continue
    }
    if (platform === 'win32') {
      const launcher = /^(.*)[\\/]bin[\\/][^\\/]+\.(?:cmd|bat)$/i.exec(file)
      const exe = WINDOWS_EXE[app.id as OpenInAppId]
      if (launcher && exe) add(`${launcher[1]}\\${exe}`)
      if (/\.(?:exe|lnk)$/i.test(file)) add(file)
      continue
    }
    add(file)
  }
  return out
}

/** Whether a keydown is the ⌘O shortcut. */
export function isOpenInKey(e: { code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, platform: string | undefined): boolean {
  if (e.code !== 'KeyO' || e.altKey) return false
  return platform === 'darwin' ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey
}
