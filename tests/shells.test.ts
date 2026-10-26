// O4: Windows shell choice. Detection runs against a described machine (an injected file
// system and PATH), so these tests pass on any OS.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createT } from '../src/shared/i18n'
import {
  defaultShell,
  interactiveArgs,
  newTerminalShells,
  parseCommandLine,
  resolveShell,
  scriptArgs,
  shellName,
  type ShellDetection
} from '../src/shared/shells'
import { parseSavedTerminals, TERMINAL_RESTORE_VERSION } from '../src/shared/terminalTabs'
import { windowsScriptLaunch } from '../src/main/platform'
import { detectShells, lookPath, parseWslList, type ShellProbe } from '../src/main/shells'
import { defaultSettings, Store } from '../src/main/store'
import { tempDir } from './helpers'

const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'
const WSL = 'C:\\Windows\\System32\\wsl.exe'

const BASE_ENV = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', ComSpec: CMD, LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }

function machine(files: string[], env: Record<string, string> = {}): ShellProbe {
  const set = new Set(files.map((f) => f.toLowerCase()))
  return { env: { ...BASE_ENV, ...env }, exists: (file) => set.has(file.toLowerCase()) }
}

const found = (over: Partial<ShellDetection['paths']> = {}, custom: ShellDetection['custom'] = { command: '', path: null }): ShellDetection => ({
  paths: { pwsh: PWSH, powershell: POWERSHELL, gitbash: GIT_BASH, cmd: CMD, wsl: WSL, ...over },
  custom
})

const t = createT('en')

describe('shell detection', () => {
  it('finds every shell in its usual place', () => {
    const d = detectShells(machine([PWSH, POWERSHELL, GIT_BASH, CMD, WSL]), '', { distros: ['Ubuntu-24.04', 'docker-desktop'], default: 'Ubuntu-24.04' })
    expect(d.paths).toEqual({ pwsh: PWSH, powershell: POWERSHELL, gitbash: GIT_BASH, cmd: CMD, wsl: WSL })
    expect(d.wslDistro).toBe('Ubuntu-24.04')
  })

  it('says not found for shells that are not there, and WSL without a distribution counts as missing', () => {
    const d = detectShells(machine([POWERSHELL, CMD, WSL]), '', { distros: [] })
    expect(d.paths).toEqual({ pwsh: null, powershell: POWERSHELL, gitbash: null, cmd: CMD, wsl: null })
    expect(d.wslDistro).toBeUndefined()
  })

  it('when wsl.exe was not asked (starting a tab), wsl.exe being there is enough', () => {
    expect(detectShells(machine([WSL]), '').paths.wsl).toBe(WSL)
  })

  it('prefers pwsh on PATH, as Foreman always did', () => {
    const onPath = 'D:\\tools\\pwsh\\pwsh.exe'
    const d = detectShells(machine([onPath, PWSH], { PATH: 'C:\\Windows;D:\\tools\\pwsh' }), '')
    expect(d.paths.pwsh).toBe(onPath)
  })

  it('finds Git Bash next to a git.exe on PATH, but never WSL’s bash.exe in System32', () => {
    const root = 'D:\\PortableGit'
    const bash = path.win32.join(root, 'bin', 'bash.exe')
    expect(detectShells(machine([path.win32.join(root, 'cmd', 'git.exe'), bash], { PATH: `${root}\\cmd` }), '').paths.gitbash).toBe(bash)
    expect(detectShells(machine([path.win32.join(root, 'mingw64', 'bin', 'git.exe'), bash], { PATH: `${root}\\mingw64\\bin` }), '').paths.gitbash).toBe(bash)
    expect(detectShells(machine(['C:\\Windows\\System32\\bash.exe'], { PATH: 'C:\\Windows\\System32' }), '').paths.gitbash).toBeNull()
  })

  it('finds Git Bash in a per-user install', () => {
    const user = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
    expect(detectShells(machine([user]), '').paths.gitbash).toBe(user)
  })

  it('resolves Custom… from a full path or a name on PATH', () => {
    const zsh = 'C:\\msys64\\usr\\bin\\zsh.exe'
    expect(detectShells(machine([zsh]), `${zsh} -l`).custom).toEqual({ command: `${zsh} -l`, path: zsh })
    expect(detectShells(machine([zsh], { PATH: 'C:\\msys64\\usr\\bin' }), 'zsh -l').custom.path).toBe(zsh)
    expect(detectShells(machine([]), `${zsh} -l`).custom.path).toBeNull()
    expect(detectShells(machine([zsh]), '  ').custom).toEqual({ command: '', path: null })
  })

  it('looks on PATH (Windows `Path` too) and skips folders it is told to', () => {
    const probe = machine(['C:\\a\\x.exe', 'C:\\b\\x.exe'], { Path: 'C:\\a;C:\\b' })
    expect(lookPath('x.exe', probe)).toBe('C:\\a\\x.exe')
    expect(lookPath('x.exe', probe, (dir) => dir === 'C:\\a')).toBe('C:\\b\\x.exe')
  })

  it('reads wsl --list --verbose, in UTF-8 or with UTF-16 zero bytes left in', () => {
    const out = '  NAME              STATE           VERSION\r\n* Ubuntu-24.04      Stopped         2\r\n  docker-desktop    Stopped         2\r\n'
    expect(parseWslList(out, true)).toEqual({ distros: ['Ubuntu-24.04', 'docker-desktop'], default: 'Ubuntu-24.04' })
    expect(parseWslList(out.split('').join('\0'), true).default).toBe('Ubuntu-24.04')
    // No distributions: wsl.exe prints help and fails.
    expect(parseWslList('Windows Subsystem for Linux has no installed distributions.\r\nInstall one with wsl --install', false)).toEqual({ distros: [] })
  })
})

describe('shell arguments', () => {
  it('starts each shell the way the mock says', () => {
    expect(interactiveArgs('pwsh', 'C:\\w')).toEqual({ args: ['-NoLogo'] })
    expect(interactiveArgs('powershell', 'C:\\w')).toEqual({ args: ['-NoLogo'] })
    expect(interactiveArgs('gitbash', 'C:\\w')).toEqual({ args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } })
    expect(interactiveArgs('cmd', 'C:\\w')).toEqual({ args: [] })
    expect(interactiveArgs('wsl', 'C:\\ws\\kigali')).toEqual({ args: ['--cd', 'C:\\ws\\kigali'] })
  })

  it('Automatic is pwsh, then Windows PowerShell, then PowerShell’s usual path', () => {
    expect(resolveShell('auto', found(), 'C:\\w')).toEqual({ file: PWSH, args: ['-NoLogo'] })
    expect(resolveShell('auto', found({ pwsh: null }), 'C:\\w')).toEqual({ file: POWERSHELL, args: ['-NoLogo'] })
    expect(resolveShell('auto', found({ pwsh: null, powershell: null }), 'C:\\w', 'C:\\Win')).toEqual({ file: 'C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'] })
  })

  it('starts the chosen shell, and falls back to Automatic (saying so) when it is missing', () => {
    expect(resolveShell('gitbash', found(), 'C:\\w')).toEqual({ file: GIT_BASH, args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } })
    expect(resolveShell('wsl', found({ wsl: null }), 'C:\\w')).toEqual({ file: PWSH, args: ['-NoLogo'], fallback: { wanted: 'wsl', used: 'pwsh' } })
    expect(resolveShell('custom', found(), 'C:\\w').fallback).toEqual({ wanted: 'custom', used: 'pwsh' })
  })

  it('runs Custom… with its own arguments, quoted paths kept whole', () => {
    const zsh = 'C:\\Program Files\\msys\\zsh.exe'
    expect(resolveShell('custom', found({}, { command: `"${zsh}" -l -i`, path: zsh }), 'C:\\w')).toEqual({ file: zsh, args: ['-l', '-i'] })
    expect(parseCommandLine('"C:\\a b\\x.exe" --x "y z" ""')).toEqual(['C:\\a b\\x.exe', '--x', 'y z', ''])
    expect(parseCommandLine('   ')).toEqual([])
  })
})

describe('script shell', () => {
  it('builds each script shell’s command line', () => {
    expect(scriptArgs('cmd', 'echo %FOREMAN_PORT%', true)).toEqual({ args: ['/d', '/s', '/c', 'echo %FOREMAN_PORT%'] })
    expect(scriptArgs('powershell', 'echo $env:FOREMAN_PORT', true)).toEqual({ args: ['-NoLogo', '-NonInteractive', '-Command', 'echo $env:FOREMAN_PORT'] })
    expect(scriptArgs('powershell', 'x', false)).toEqual({ args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'x'] })
    expect(scriptArgs('gitbash', 'echo $FOREMAN_PORT', true)).toEqual({ args: ['--login', '-c', 'echo $FOREMAN_PORT'], env: { CHERE_INVOKING: '1' } })
    expect(scriptArgs('gitbash', 'x', false)).toEqual({ args: ['-c', 'x'] })
  })

  it.runIf(process.platform === 'win32')('keeps cmd.exe on the existing path, and refuses a script shell that is missing', () => {
    expect(windowsScriptLaunch('x', true, 'cmd')).toBeNull()
    expect(windowsScriptLaunch('x', false, 'gitbash', machine([GIT_BASH]))).toEqual({ file: GIT_BASH, args: ['-c', 'x'] })
    expect(windowsScriptLaunch('x', false, 'powershell', machine([POWERSHELL]))).toEqual({ file: POWERSHELL, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'x'] })
    expect(() => windowsScriptLaunch('x', false, 'gitbash', machine([]))).toThrow(/Git Bash wasn't found/)
  })

  it.runIf(process.platform !== 'win32')('changes nothing on macOS and Linux', () => {
    expect(windowsScriptLaunch('x', true, 'gitbash')).toBeNull()
  })
})

describe('shell names and the new-terminal menu', () => {
  it('names shells, WSL with its distribution once known', () => {
    expect(shellName('gitbash', t)).toBe('Git Bash')
    expect(shellName('wsl', t)).toBe('WSL')
    expect(shellName('wsl', t, { ...found(), wslDistro: 'Ubuntu' })).toBe('WSL (Ubuntu)')
    expect(shellName('pwsh', createT('es'))).toBe('PowerShell 7')
    expect(shellName('cmd', createT('es'))).toBe('Símbolo del sistema')
  })

  it('offers only shells that were found, with the default marked', () => {
    const d = found({ wsl: null })
    expect(newTerminalShells('auto', d)).toEqual([
      { shell: 'pwsh', isDefault: true },
      { shell: 'powershell', isDefault: false },
      { shell: 'gitbash', isDefault: false },
      { shell: 'cmd', isDefault: false }
    ])
    expect(newTerminalShells('gitbash', d).find((s) => s.isDefault)?.shell).toBe('gitbash')
    // A missing setting: + starts Automatic's pick.
    expect(defaultShell('wsl', d)).toBe('pwsh')
    expect(newTerminalShells('auto', found({}, { command: 'zsh', path: 'C:\\zsh.exe' })).at(-1)).toEqual({ shell: 'custom', isDefault: false })
  })
})

describe('saved terminal tabs keep their shell', () => {
  const tab = { n: 1, cwd: 'C:\\w', savedAt: 5, scrollback: '' }

  it('reads version 1 files (no shells) and version 2 files with them', () => {
    expect(TERMINAL_RESTORE_VERSION).toBe(2)
    expect(parseSavedTerminals({ version: 1, workspaces: { ws: [tab] } }).workspaces.ws).toEqual([tab])
    expect(parseSavedTerminals({ version: 2, workspaces: { ws: [{ ...tab, shell: 'gitbash' }] } }).workspaces.ws).toEqual([{ ...tab, shell: 'gitbash' }])
  })

  it('drops a shell it does not know, and Automatic (which is the same as none)', () => {
    expect(parseSavedTerminals({ version: 2, workspaces: { ws: [{ ...tab, shell: 'fish' }, { ...tab, n: 2, shell: 'auto' }] } }).workspaces.ws).toEqual([tab, { ...tab, n: 2 }])
  })
})

describe('shell settings persistence', () => {
  it('defaults to Automatic and cmd.exe, and survives a restart', async () => {
    expect(defaultSettings()).toMatchObject({ terminalShell: 'auto', terminalShellCustom: '', scriptShell: 'cmd' })
    const dir = await tempDir('foreman-shells-')
    const store = new Store(dir)
    await store.load()
    store.state.settings.terminalShell = 'custom'
    store.state.settings.terminalShellCustom = 'C:\\msys64\\usr\\bin\\zsh.exe -l'
    store.state.settings.scriptShell = 'gitbash'
    store.flush()
    const again = new Store(dir)
    await again.load()
    expect(again.state.settings).toMatchObject({ terminalShell: 'custom', terminalShellCustom: 'C:\\msys64\\usr\\bin\\zsh.exe -l', scriptShell: 'gitbash' })
    again.close()
    store.close()
  })

  it('puts an unknown shell back to the default when loading', async () => {
    const dir = await tempDir('foreman-shells-')
    const store = new Store(dir)
    await store.load()
    ;(store.state.settings as unknown as Record<string, unknown>).terminalShell = 'fish'
    ;(store.state.settings as unknown as Record<string, unknown>).scriptShell = 'nu'
    store.flush()
    const again = new Store(dir)
    await again.load()
    expect(again.state.settings.terminalShell).toBe('auto')
    expect(again.state.settings.scriptShell).toBe('cmd')
    again.close()
    store.close()
  })
})
