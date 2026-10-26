// Open in detected apps (#14): finding editors, terminals and the file manager, and starting
// them on a workspace folder or a file at a line. The machine comes in as a probe (file
// system, PATH, the registry and Spotlight) so tests can describe any Windows or macOS
// computer from any OS. Detection is cached; Refresh in Settings and opening the Open menu
// look again. The user's own path for an app (Settings) is applied on every read.
import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  OPEN_IN_APPS,
  editorArgs,
  iconSources,
  openInAppName,
  resolveDefault,
  type FoundWhere,
  type OpenInApp,
  type OpenInAppId,
  type OpenInAppInfo,
  type OpenInChoice,
  type OpenInDetection,
  type OpenInTarget
} from '../shared/openIn'
import { parseCommandLine } from '../shared/shells'

export interface OpenInProbe {
  platform: string
  env: Record<string, string | undefined>
  exists(file: string): boolean
  // Entry names in a folder; [] when it isn't there.
  readdir(dir: string): string[]
  // A program's standard output, or null when it failed.
  run(file: string, args: string[]): Promise<string | null>
}

/** This computer. App execution aliases (WindowsApps\wt.exe) fail existsSync but lstat fine. */
export const realOpenInProbe = (): OpenInProbe => ({
  platform: process.platform,
  env: process.env,
  exists: (file) => {
    if (existsSync(file)) return true
    try {
      lstatSync(file)
      return true
    } catch {
      return false
    }
  },
  readdir: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  run: (file, args) =>
    new Promise((resolve) => {
      execFile(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)))
    })
})

// ---- where each app lives ----

interface WindowsSpec {
  // Names on PATH, with their extension.
  path?: string[]
  // Toolbox's launcher script, %LOCALAPPDATA%\JetBrains\Toolbox\scripts\<name>.cmd.
  toolbox?: string
  // Keys under …\CurrentVersion\App Paths (HKCU and HKLM).
  appPaths?: string[]
  // Relative to %LOCALAPPDATA%\Programs, Program Files and Program Files (x86).
  folders?: string[]
  // Versioned install folders (JetBrains): a folder name pattern under JetBrains\ or Programs\, and the exe inside.
  versioned?: { dir: RegExp; exe: string }
  // The command-line tool beside a found exe, preferred for launching (code.cmd waits for nothing and reuses windows).
  cli?: string[]
  // %LOCALAPPDATA%\Microsoft\WindowsApps\<name> (Store apps' execution aliases).
  windowsApps?: string
}

interface MacSpec {
  bundleIds?: string[]
  // Names in /Applications and ~/Applications (Terminal: /System/Applications/Utilities).
  apps: string[]
  // The command-line tool inside the .app, relative to it.
  cli?: string[]
  path?: string[]
  toolbox?: string
}

const WHERE: Record<Exclude<OpenInAppId, 'files'>, { win?: WindowsSpec; mac?: MacSpec }> = {
  vscode: {
    win: { path: ['code.cmd'], appPaths: ['Code.exe'], folders: ['Microsoft VS Code\\Code.exe'], cli: ['bin\\code.cmd'] },
    mac: { bundleIds: ['com.microsoft.VSCode'], apps: ['Visual Studio Code.app'], cli: ['Contents/Resources/app/bin/code'], path: ['code'] }
  },
  'vscode-insiders': {
    win: { path: ['code-insiders.cmd'], appPaths: ['Code - Insiders.exe'], folders: ['Microsoft VS Code Insiders\\Code - Insiders.exe'], cli: ['bin\\code-insiders.cmd'] },
    mac: {
      bundleIds: ['com.microsoft.VSCodeInsiders'],
      apps: ['Visual Studio Code - Insiders.app'],
      cli: ['Contents/Resources/app/bin/code-insiders', 'Contents/Resources/app/bin/code'],
      path: ['code-insiders']
    }
  },
  cursor: {
    win: { path: ['cursor.cmd'], appPaths: ['Cursor.exe'], folders: ['cursor\\Cursor.exe', 'Cursor\\Cursor.exe'], cli: ['resources\\app\\bin\\cursor.cmd'] },
    mac: { bundleIds: ['com.todesktop.230313mzl4w4u92'], apps: ['Cursor.app'], cli: ['Contents/Resources/app/bin/cursor'], path: ['cursor'] }
  },
  windsurf: {
    win: { path: ['windsurf.cmd'], appPaths: ['Windsurf.exe'], folders: ['Windsurf\\Windsurf.exe'], cli: ['bin\\windsurf.cmd'] },
    mac: { bundleIds: ['com.exafunction.windsurf'], apps: ['Windsurf.app'], cli: ['Contents/Resources/app/bin/windsurf'], path: ['windsurf'] }
  },
  zed: {
    win: { path: ['zed.exe', 'zed.cmd'], appPaths: ['Zed.exe'], folders: ['Zed\\Zed.exe'], cli: ['bin\\zed.exe', 'bin\\zed.cmd'] },
    mac: { bundleIds: ['dev.zed.Zed'], apps: ['Zed.app'], cli: ['Contents/MacOS/cli'], path: ['zed'] }
  },
  intellij: {
    win: { path: ['idea64.exe', 'idea.cmd', 'idea.bat'], toolbox: 'idea', appPaths: ['idea64.exe'], versioned: { dir: /^IntelliJ IDEA/i, exe: 'bin\\idea64.exe' } },
    mac: {
      bundleIds: ['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'],
      apps: ['IntelliJ IDEA.app', 'IntelliJ IDEA Ultimate.app', 'IntelliJ IDEA CE.app', 'IntelliJ IDEA Community Edition.app'],
      cli: ['Contents/MacOS/idea'],
      path: ['idea'],
      toolbox: 'idea'
    }
  },
  webstorm: {
    win: { path: ['webstorm64.exe', 'webstorm.cmd', 'webstorm.bat'], toolbox: 'webstorm', appPaths: ['webstorm64.exe'], versioned: { dir: /^WebStorm/i, exe: 'bin\\webstorm64.exe' } },
    mac: { bundleIds: ['com.jetbrains.WebStorm'], apps: ['WebStorm.app'], cli: ['Contents/MacOS/webstorm'], path: ['webstorm'], toolbox: 'webstorm' }
  },
  pycharm: {
    win: { path: ['pycharm64.exe', 'pycharm.cmd', 'pycharm.bat'], toolbox: 'pycharm', appPaths: ['pycharm64.exe'], versioned: { dir: /^PyCharm/i, exe: 'bin\\pycharm64.exe' } },
    mac: {
      bundleIds: ['com.jetbrains.pycharm', 'com.jetbrains.pycharm.ce'],
      apps: ['PyCharm.app', 'PyCharm Professional Edition.app', 'PyCharm CE.app', 'PyCharm Community Edition.app'],
      cli: ['Contents/MacOS/pycharm'],
      path: ['pycharm'],
      toolbox: 'pycharm'
    }
  },
  sublime: {
    win: { path: ['subl.exe'], appPaths: ['sublime_text.exe'], folders: ['Sublime Text\\sublime_text.exe', 'Sublime Text 4\\sublime_text.exe', 'Sublime Text 3\\sublime_text.exe'], cli: ['subl.exe'] },
    mac: { bundleIds: ['com.sublimetext.4', 'com.sublimetext.3'], apps: ['Sublime Text.app'], cli: ['Contents/SharedSupport/bin/subl'], path: ['subl'] }
  },
  'windows-terminal': { win: { path: ['wt.exe'], appPaths: ['wt.exe'], windowsApps: 'wt.exe' } },
  terminal: { mac: { bundleIds: ['com.apple.Terminal'], apps: ['Terminal.app'] } },
  iterm: { mac: { bundleIds: ['com.googlecode.iterm2'], apps: ['iTerm.app'] } },
  ghostty: { mac: { bundleIds: ['com.mitchellh.ghostty'], apps: ['Ghostty.app'] } }
}

// ---- Windows ----

const win = path.win32
const mac = path.posix

function pathDirs(probe: OpenInProbe): string[] {
  const value = probe.env.PATH ?? probe.env.Path ?? ''
  return value.split(probe.platform === 'win32' ? ';' : ':').filter(Boolean)
}

function onPath(names: string[] | undefined, probe: OpenInProbe): string | null {
  const join = probe.platform === 'win32' ? win.join : mac.join
  for (const dir of pathDirs(probe)) for (const name of names ?? []) if (probe.exists(join(dir, name))) return join(dir, name)
  return null
}

const expandEnv = (text: string, env: OpenInProbe['env']) => text.replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? env[name.toUpperCase()] ?? whole)

/**
 * `reg query "…\App Paths" /s /ve`: each key's line, then its default value. Returns exe name
 * (lower case) → path. The "(Default)" label is translated on some systems, so the value is
 * read after its REG_SZ type instead.
 */
export function parseAppPaths(output: string, env: OpenInProbe['env'] = {}): Map<string, string> {
  const found = new Map<string, string>()
  let key = ''
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      key = line.trim().split('\\').pop()?.toLowerCase() ?? ''
      continue
    }
    const value = /\sREG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line)?.[1]
    if (key && value && !found.has(key)) found.set(key, expandEnv(value.replace(/^"(.*)"$/, '$1'), env))
  }
  return found
}

async function readAppPaths(probe: OpenInProbe): Promise<Map<string, string>> {
  const reg = win.join(probe.env.SystemRoot ?? probe.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'reg.exe')
  const merged = new Map<string, string>()
  // The user's own registrations win over the machine's.
  for (const hive of ['HKCU', 'HKLM']) {
    const out = await probe.run(reg, ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths`, '/s', '/ve'])
    if (out) for (const [name, file] of parseAppPaths(out, probe.env)) if (!merged.has(name)) merged.set(name, file)
  }
  return merged
}

function installRoots(env: OpenInProbe['env']): string[] {
  return [env.LOCALAPPDATA && win.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter((dir, i, all): dir is string => Boolean(dir) && all.indexOf(dir) === i)
}

function findWindows(spec: WindowsSpec, probe: OpenInProbe, appPaths: Map<string, string>): { path: string; where: FoundWhere } | null {
  const { env } = probe
  const fromPath = onPath(spec.path, probe)
  if (fromPath) return { path: fromPath, where: 'path' }
  if (spec.toolbox && env.LOCALAPPDATA) {
    const script = win.join(env.LOCALAPPDATA, 'JetBrains', 'Toolbox', 'scripts', `${spec.toolbox}.cmd`)
    if (probe.exists(script)) return { path: script, where: 'toolbox' }
  }
  for (const name of spec.appPaths ?? []) {
    const file = appPaths.get(name.toLowerCase())
    if (file && probe.exists(file)) return { path: file, where: 'registry' }
  }
  const roots = installRoots(env)
  for (const root of roots) for (const rel of spec.folders ?? []) if (probe.exists(win.join(root, rel))) return { path: win.join(root, rel), where: 'folder' }
  if (spec.versioned) {
    const parents = [...roots.map((root) => win.join(root, 'JetBrains')), ...roots]
    for (const parent of parents) {
      // Newest version first: "IntelliJ IDEA 2026.2" sorts after "IntelliJ IDEA 2025.3".
      const dirs = probe.readdir(parent).filter((name) => spec.versioned!.dir.test(name)).sort().reverse()
      for (const dir of dirs) {
        const exe = win.join(parent, dir, spec.versioned.exe)
        if (probe.exists(exe)) return { path: exe, where: 'folder' }
      }
    }
  }
  if (spec.windowsApps && env.LOCALAPPDATA) {
    const alias = win.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', spec.windowsApps)
    if (probe.exists(alias)) return { path: alias, where: 'folder' }
  }
  return null
}

/** The command-line tool beside an exe (Code.exe → bin\code.cmd), when there is one. */
function windowsLauncher(spec: WindowsSpec | undefined, exe: string, exists: OpenInProbe['exists']): string | undefined {
  if (!/\.exe$/i.test(exe)) return undefined
  for (const rel of spec?.cli ?? []) {
    const cli = win.join(win.dirname(exe), rel)
    if (cli.toLowerCase() !== exe.toLowerCase() && exists(cli)) return cli
  }
  return undefined
}

// ---- macOS ----

async function spotlight(bundleIds: string[] | undefined, probe: OpenInProbe): Promise<string | null> {
  for (const id of bundleIds ?? []) {
    const out = await probe.run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${id}'`])
    const hit = (out ?? '')
      .split('\n')
      .map((line) => line.trim())
      // Not one bundled inside another app, and not in the Trash.
      .find((line) => line.endsWith('.app') && !line.slice(0, -4).includes('.app/') && !line.includes('/.Trash/') && probe.exists(line))
    if (hit) return hit
  }
  return null
}

function macAppDirs(env: OpenInProbe['env']): string[] {
  return ['/Applications', ...(env.HOME ? [mac.join(env.HOME, 'Applications')] : []), '/System/Applications/Utilities', '/Applications/Utilities']
}

async function findMac(spec: MacSpec, probe: OpenInProbe): Promise<{ path: string; where: FoundWhere } | null> {
  const found = await spotlight(spec.bundleIds, probe)
  if (found) return { path: found, where: 'spotlight' }
  for (const dir of macAppDirs(probe.env)) for (const name of spec.apps) if (probe.exists(mac.join(dir, name))) return { path: mac.join(dir, name), where: 'applications' }
  if (spec.toolbox && probe.env.HOME) {
    const script = mac.join(probe.env.HOME, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'scripts', spec.toolbox)
    if (probe.exists(script)) return { path: script, where: 'toolbox' }
  }
  const fromPath = onPath(spec.path, probe)
  return fromPath ? { path: fromPath, where: 'path' } : null
}

/** The command-line tool inside an .app (Contents/Resources/app/bin/code), when there is one. */
function macLauncher(spec: MacSpec | undefined, app: string, exists: OpenInProbe['exists']): string | undefined {
  if (!app.endsWith('.app')) return undefined
  for (const rel of spec?.cli ?? []) if (exists(mac.join(app, rel))) return mac.join(app, rel)
  return undefined
}

// ---- detection ----

function launcherFor(platform: string, id: OpenInAppId, file: string, exists: OpenInProbe['exists']): string | undefined {
  if (id === 'files') return undefined
  const where = WHERE[id]
  return platform === 'win32' ? windowsLauncher(where.win, file, exists) : macLauncher(where.mac, file, exists)
}

function forPlatform(platform: string): OpenInAppInfo[] {
  return OPEN_IN_APPS.filter((app) => (app.platforms as readonly string[]).includes(platform))
}

/** Whether `app` at `file` (with `launcher`) can open a file at a line. */
function atLine(info: OpenInAppInfo, platform: string, file: string | null, launcher: string | undefined): boolean {
  if (!file || info.line === 'none') return false
  // On macOS an .app without its command-line tool can only be opened with `open -a`, which takes no line.
  if (platform === 'darwin') return Boolean(launcher) || !file.endsWith('.app')
  return true
}

function fileManager(info: OpenInAppInfo, probe: OpenInProbe): OpenInApp {
  const file = probe.platform === 'darwin' ? '/System/Library/CoreServices/Finder.app' : win.join(probe.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe')
  return { id: info.id, name: openInAppName(info.id, probe.platform), kind: info.kind, atLine: false, path: file, found: 'builtin', detected: file, detectedWhere: 'builtin' }
}

/** Every catalogue app for the probe's platform, found or not. Overrides aren't applied here. */
export async function detectOpenInApps(probe: OpenInProbe, now = new Date()): Promise<OpenInDetection> {
  const apps = forPlatform(probe.platform)
  const appPaths = probe.platform === 'win32' ? await readAppPaths(probe) : new Map<string, string>()
  const results = await Promise.all(
    apps.map(async (info): Promise<OpenInApp> => {
      if (info.kind === 'files') return fileManager(info, probe)
      const where = WHERE[info.id as Exclude<OpenInAppId, 'files'>]
      const hit = probe.platform === 'win32' ? (where.win ? findWindows(where.win, probe, appPaths) : null) : where.mac ? await findMac(where.mac, probe) : null
      const launcher = hit ? launcherFor(probe.platform, info.id, hit.path, probe.exists) : undefined
      // Terminal ships with macOS: say so rather than "found by Spotlight".
      const found = hit && info.id === 'terminal' ? 'builtin' : (hit?.where ?? null)
      return {
        id: info.id,
        name: info.name,
        kind: info.kind,
        atLine: atLine(info, probe.platform, hit?.path ?? null, launcher),
        path: hit?.path ?? null,
        found,
        detected: hit?.path ?? null,
        detectedWhere: found,
        ...(launcher ? { launcher } : {})
      }
    })
  )
  return { platform: probe.platform, apps: results, checkedAt: now.toISOString() }
}

/**
 * Settings → Open in apps → Change…: the user's path replaces what was detected. A path that
 * isn't there makes the app missing (and says so) rather than quietly using the detected one.
 */
export function applyOverrides(detection: OpenInDetection, overrides: Record<string, string>, probe: Pick<OpenInProbe, 'exists'>): OpenInDetection {
  const apps = detection.apps.map((app): OpenInApp => {
    const own = overrides[app.id]?.trim()
    if (!own || app.kind === 'files') return app
    const info = forPlatform(detection.platform).find((i) => i.id === app.id)!
    const { launcher: _detected, ...rest } = app
    if (!probe.exists(own)) return { ...rest, path: null, found: null, atLine: false, userPath: own, userPathMissing: true }
    const launcher = launcherFor(detection.platform, app.id, own, probe.exists)
    return { ...rest, path: own, found: 'user', userPath: own, atLine: atLine(info, detection.platform, own, launcher), ...(launcher ? { launcher } : {}) }
  })
  return { ...detection, apps }
}

// ---- launching ----

export type Launch =
  // `shell`: `file` is a whole cmd.exe command line (for .cmd and .bat launchers), already quoted.
  | { kind: 'spawn'; file: string; args: string[]; shell: boolean }
  // The file manager: show the file selected in its folder, or open the folder.
  | { kind: 'reveal'; path: string }
  | { kind: 'open-path'; path: string }

/** One argument for cmd.exe. Windows paths can't contain quotes, so wrapping is enough for spaces, & and ^. */
export function cmdQuote(arg: string): string {
  return /^[\w\-.:\\/=]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`
}

function spawnOf(platform: string, file: string, args: string[]): Launch {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) return { kind: 'spawn', file: [`"${file}"`, ...args.map(cmdQuote)].join(' '), args: [], shell: true }
  return { kind: 'spawn', file, args, shell: false }
}

/** How to start a found app on a target. */
export function buildLaunch(app: OpenInApp, target: OpenInTarget, platform: string): Launch {
  if (!app.path) throw new Error(`${app.name} wasn't found on this computer.`)
  const info = OPEN_IN_APPS.find((i) => i.id === app.id)!
  if (app.kind === 'files') return target.file ? { kind: 'reveal', path: target.file } : { kind: 'open-path', path: target.folder }
  if (app.kind === 'terminal') {
    // Terminals always get the workspace folder.
    if (platform === 'win32') return spawnOf(platform, app.launcher ?? app.path, ['-d', target.folder])
    if (app.id === 'ghostty' && app.path.endsWith('.app')) return { kind: 'spawn', file: '/usr/bin/open', args: ['-na', app.path, '--args', `--working-directory=${target.folder}`], shell: false }
    return { kind: 'spawn', file: '/usr/bin/open', args: ['-a', app.path, target.folder], shell: false }
  }
  const exe = app.launcher ?? app.path
  // macOS .app without its command-line tool: `open -a` takes the file but no line.
  if (platform === 'darwin' && exe.endsWith('.app')) return { kind: 'spawn', file: '/usr/bin/open', args: ['-a', exe, target.file ?? target.folder], shell: false }
  return spawnOf(platform, exe, editorArgs(app.atLine ? info.line : 'none', target))
}

/**
 * Custom command…: the user's command line as typed, with the file (or folder) as its last
 * argument and no line. On Windows it runs through cmd.exe as the old Editor command did,
 * so .cmd launchers and arguments keep working; the path is quoted so spaces survive.
 */
export function customLaunch(command: string, target: OpenInTarget, platform: string): Launch {
  const subject = target.file ?? target.folder
  if (platform === 'win32') return { kind: 'spawn', file: `${command.trim()} ${cmdQuote(subject)}`, args: [], shell: true }
  const [file, ...args] = parseCommandLine(command)
  if (!file) throw new Error('Set a custom command in Settings → General → Open in apps.')
  return { kind: 'spawn', file, args: [...args, subject], shell: false }
}

/** Start it and don't wait. A cmd.exe launch that fails at once (command not found) is reported. */
function start(launch: Extract<Launch, { kind: 'spawn' }>, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.file, launch.args, { detached: true, stdio: 'ignore', shell: launch.shell, windowsHide: launch.shell })
    let done = false
    const finish = (err?: Error) => {
      if (done) return
      done = true
      child.unref()
      if (err) reject(err)
      else resolve()
    }
    child.once('error', () => finish(new Error(`Could not start ${label}.`)))
    if (!launch.shell) {
      child.once('spawn', () => finish())
      return
    }
    // cmd.exe always starts; whether the command did shows in its exit code, usually within moments.
    child.once('exit', (code) => finish(code ? new Error(`Could not run ${label} (exit code ${code}).`) : undefined))
    setTimeout(() => finish(), 1500)
  })
}

export interface OpenInHost {
  openPath(path: string): Promise<void>
  revealPath?(path: string): void
  // G4 #14: a file's icon from the OS (app.getFileIcon) as a data: URL, or null.
  fileIcon?(path: string): Promise<string | null>
}

export interface OpenInSettings {
  openInDefault: OpenInChoice
  openInPaths: Record<string, string>
  editorCommand: string
}

export class OpenInService {
  private cached: Promise<OpenInDetection> | null = null
  // G4 #14: icons by file, kept for the session (null: the OS had none).
  private iconCache = new Map<string, Promise<string | null>>()

  constructor(
    private readonly settings: () => OpenInSettings,
    private readonly host: OpenInHost,
    private readonly probe: () => OpenInProbe = realOpenInProbe
  ) {}

  /** What's installed, with the user's paths applied. `refresh` looks again. */
  async apps(refresh = false): Promise<OpenInDetection> {
    if (refresh || !this.cached) {
      const next = detectOpenInApps(this.probe())
      this.cached = next
      next.catch(() => {
        if (this.cached === next) this.cached = null
      })
    }
    return applyOverrides(await this.cached, this.settings().openInPaths ?? {}, this.probe())
  }

  /**
   * G4 #14: the found apps' own icons (data: URLs) by app id. Apps without one are left out,
   * and the menus fall back to their monogram or glyph.
   */
  async icons(): Promise<Partial<Record<OpenInAppId, string>>> {
    const fileIcon = this.host.fileIcon
    if (!fileIcon) return {}
    const detection = await this.apps()
    const probe = this.probe()
    const out: Partial<Record<OpenInAppId, string>> = {}
    await Promise.all(
      detection.apps
        .filter((app) => app.path)
        .map(async (app) => {
          for (const file of iconSources(app, detection.platform)) {
            if (!probe.exists(file)) continue
            let icon = this.iconCache.get(file)
            if (!icon) {
              icon = fileIcon(file).catch(() => null)
              this.iconCache.set(file, icon)
            }
            const url = await icon
            if (url) {
              out[app.id] = url
              return
            }
          }
        })
    )
    return out
  }

  /** Open the target in an app, the custom command, or (null) the default from Settings. */
  async open(choice: OpenInChoice | null, target: OpenInTarget): Promise<void> {
    const settings = this.settings()
    const detection = await this.apps()
    const pick = choice === null ? settings.openInDefault : choice
    const resolved = resolveDefault(pick, detection, settings.editorCommand)
    if (resolved.kind === 'missing') {
      const name = resolved.choice === 'custom' ? 'The custom command' : openInAppName(resolved.choice, detection.platform)
      throw new Error(
        resolved.choice === 'custom'
          ? 'No custom command is set. Add one in Settings → General → Open in apps.'
          : `${name} wasn't found on this computer. Pick another app, or set its path in Settings → General → Open in apps.`
      )
    }
    if (resolved.kind === 'none') throw new Error('No app to open with. Pick one in Settings → General → Open in apps.')
    const launch = resolved.kind === 'custom' ? customLaunch(resolved.command, target, detection.platform) : buildLaunch(resolved.app, target, detection.platform)
    const label = resolved.kind === 'custom' ? `“${resolved.command}”` : resolved.app.name
    if (launch.kind === 'open-path') return this.host.openPath(launch.path)
    if (launch.kind === 'reveal') {
      if (this.host.revealPath) return this.host.revealPath(launch.path)
      return this.host.openPath(path.dirname(launch.path))
    }
    return start(launch, label)
  }
}
