// #14 Open in detected apps. Detection runs against a described machine (an injected file
// system, PATH, registry and Spotlight), so these tests pass on any OS.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyOverrides, buildLaunch, customLaunch, detectOpenInApps, OpenInService, parseAppPaths, type Launch, type OpenInProbe } from '../src/main/openIn'
import { defaultFromEditorCommand, editorArgs, foundApps, isOpenInKey, joinWorkspace, openInShortcut, resolveDefault, type OpenInApp, type OpenInDetection } from '../src/shared/openIn'
import { defaultSettings, Store } from '../src/main/store'
import { tempDir } from './helpers'

const LOCAL = 'C:\\Users\\me\\AppData\\Local'
const WIN_ENV = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: LOCAL }
const REG = 'C:\\Windows\\System32\\reg.exe'

interface Machine {
  platform: 'win32' | 'darwin'
  files: string[]
  env?: Record<string, string>
  // Program + first argument → output (reg query by hive, mdfind by bundle id).
  outputs?: Record<string, string>
}

function machine({ platform, files, env = {}, outputs = {} }: Machine): OpenInProbe & { runs: string[][] } {
  const norm = (f: string) => (platform === 'win32' ? f.toLowerCase() : f)
  const set = new Set(files.map(norm))
  const runs: string[][] = []
  const sep = platform === 'win32' ? '\\' : '/'
  return {
    platform,
    env: { ...(platform === 'win32' ? WIN_ENV : { HOME: '/Users/me' }), ...env },
    exists: (file) => set.has(norm(file)),
    readdir: (dir) => {
      const prefix = norm(dir) + sep
      const names = new Set<string>()
      for (const file of files) if (norm(file).startsWith(prefix)) names.add(file.slice(prefix.length).split(sep)[0])
      return [...names]
    },
    run: async (file, args) => {
      runs.push([file, ...args])
      const key = Object.keys(outputs).find((k) => `${file} ${args.join(' ')}`.includes(k))
      return key === undefined ? null : outputs[key]
    },
    runs
  }
}

const app = (detection: OpenInDetection, id: string) => detection.apps.find((a) => a.id === id)!

describe('detection on Windows', () => {
  const appPaths = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\sublime_text.exe',
    '    (Default)    REG_SZ    C:\\Program Files\\Sublime Text\\sublime_text.exe',
    ''
  ].join('\r\n')
  const probe = () =>
    machine({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\System32;C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin' },
      outputs: { 'HKLM\\SOFTWARE': appPaths },
      files: [
        `${LOCAL}\\Programs\\Microsoft VS Code\\bin\\code.cmd`,
        `${LOCAL}\\Programs\\cursor\\Cursor.exe`,
        `${LOCAL}\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd`,
        'C:\\Program Files\\Sublime Text\\sublime_text.exe',
        'C:\\Program Files\\Sublime Text\\subl.exe',
        `${LOCAL}\\JetBrains\\Toolbox\\scripts\\idea.cmd`,
        'C:\\Program Files\\JetBrains\\WebStorm 2025.3\\bin\\webstorm64.exe',
        'C:\\Program Files\\JetBrains\\WebStorm 2026.2\\bin\\webstorm64.exe',
        `${LOCAL}\\Microsoft\\WindowsApps\\wt.exe`
      ]
    })

  it('finds apps on PATH, in the App Paths registry, in install folders and in JetBrains Toolbox, and says where', async () => {
    const found = await detectOpenInApps(probe())
    expect(app(found, 'vscode')).toMatchObject({ path: `${LOCAL}\\Programs\\Microsoft VS Code\\bin\\code.cmd`, found: 'path', atLine: true })
    expect(app(found, 'cursor')).toMatchObject({ path: `${LOCAL}\\Programs\\cursor\\Cursor.exe`, found: 'folder', launcher: `${LOCAL}\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd` })
    expect(app(found, 'sublime')).toMatchObject({ path: 'C:\\Program Files\\Sublime Text\\sublime_text.exe', found: 'registry', launcher: 'C:\\Program Files\\Sublime Text\\subl.exe' })
    expect(app(found, 'intellij')).toMatchObject({ path: `${LOCAL}\\JetBrains\\Toolbox\\scripts\\idea.cmd`, found: 'toolbox', atLine: true })
    // The newest versioned folder.
    expect(app(found, 'webstorm')).toMatchObject({ path: 'C:\\Program Files\\JetBrains\\WebStorm 2026.2\\bin\\webstorm64.exe', found: 'folder' })
    expect(app(found, 'windows-terminal')).toMatchObject({ path: `${LOCAL}\\Microsoft\\WindowsApps\\wt.exe`, kind: 'terminal', atLine: false })
    expect(app(found, 'files')).toMatchObject({ name: 'File Explorer', path: 'C:\\Windows\\explorer.exe', found: 'builtin' })
  })

  it('lists missing apps as missing, and only this platform’s apps', async () => {
    const found = await detectOpenInApps(probe())
    expect(app(found, 'zed')).toMatchObject({ path: null, found: null, atLine: false })
    expect(found.apps.map((a) => a.id)).not.toContain('iterm')
    expect(found.apps.map((a) => a.id)).not.toContain('terminal')
    expect(foundApps(found).map((a) => a.id)).toEqual(['vscode', 'cursor', 'intellij', 'webstorm', 'sublime', 'windows-terminal', 'files'])
  })

  it('asks the registry once per hive', async () => {
    const p = probe()
    await detectOpenInApps(p)
    expect(p.runs).toEqual([
      [REG, 'query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', '/s', '/ve'],
      [REG, 'query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', '/s', '/ve']
    ])
  })

  it('PATH comes before the install folder', async () => {
    const p = machine({ platform: 'win32', env: { PATH: 'D:\\cursor\\resources\\app\\bin' }, files: ['D:\\cursor\\resources\\app\\bin\\cursor.cmd', `${LOCAL}\\Programs\\cursor\\Cursor.exe`] })
    expect(app(await detectOpenInApps(p), 'cursor')).toMatchObject({ path: 'D:\\cursor\\resources\\app\\bin\\cursor.cmd', found: 'path' })
  })
})

describe('the App Paths registry', () => {
  it('reads each key’s default value, whatever the label is called, and expands variables', () => {
    const out = [
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe',
      '    (Standard)    REG_SZ    "C:\\Program Files\\Microsoft VS Code\\Code.exe"',
      '',
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Vendor\\idea64.exe',
      '    (Default)    REG_EXPAND_SZ    %LOCALAPPDATA%\\Programs\\IDEA\\bin\\idea64.exe',
      '',
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\empty.exe',
      ''
    ].join('\r\n')
    const map = parseAppPaths(out, { LOCALAPPDATA: LOCAL })
    expect(map.get('code.exe')).toBe('C:\\Program Files\\Microsoft VS Code\\Code.exe')
    expect(map.get('idea64.exe')).toBe(`${LOCAL}\\Programs\\IDEA\\bin\\idea64.exe`)
    expect(map.has('empty.exe')).toBe(false)
  })
})

describe('detection on macOS', () => {
  const probe = () =>
    machine({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/opt/homebrew/bin' },
      outputs: {
        "'com.microsoft.VSCode'": '/Users/me/Downloads/Old.app/Contents/Visual Studio Code.app\n/Applications/Visual Studio Code.app\n',
        "'com.apple.Terminal'": '/System/Applications/Utilities/Terminal.app\n'
      },
      files: [
        '/Applications/Visual Studio Code.app',
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
        '/Applications/Zed.app',
        '/Applications/Zed.app/Contents/MacOS/cli',
        // An app without its command-line tool.
        '/Applications/Cursor.app',
        '/Users/me/Applications/Ghostty.app',
        '/System/Applications/Utilities/Terminal.app',
        '/Users/me/Library/Application Support/JetBrains/Toolbox/scripts/idea',
        '/opt/homebrew/bin/subl'
      ]
    })

  it('uses Spotlight by bundle id, then /Applications, Toolbox and PATH', async () => {
    const found = await detectOpenInApps(probe())
    expect(app(found, 'vscode')).toMatchObject({ path: '/Applications/Visual Studio Code.app', found: 'spotlight', launcher: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', atLine: true })
    expect(app(found, 'zed')).toMatchObject({ path: '/Applications/Zed.app', found: 'applications', launcher: '/Applications/Zed.app/Contents/MacOS/cli', atLine: true })
    expect(app(found, 'intellij')).toMatchObject({ path: '/Users/me/Library/Application Support/JetBrains/Toolbox/scripts/idea', found: 'toolbox', atLine: true })
    expect(app(found, 'sublime')).toMatchObject({ path: '/opt/homebrew/bin/subl', found: 'path', atLine: true })
    expect(app(found, 'ghostty')).toMatchObject({ path: '/Users/me/Applications/Ghostty.app', found: 'applications' })
    expect(app(found, 'terminal')).toMatchObject({ found: 'builtin' })
    expect(app(found, 'files')).toMatchObject({ name: 'Finder', found: 'builtin' })
    expect(app(found, 'iterm').path).toBeNull()
    expect(found.apps.map((a) => a.id)).not.toContain('windows-terminal')
  })

  it('an app found without its command-line tool opens files but not at a line', async () => {
    expect(app(await detectOpenInApps(probe()), 'cursor')).toMatchObject({ path: '/Applications/Cursor.app', atLine: false })
  })
})

const win = (over: Partial<OpenInApp> & Pick<OpenInApp, 'id' | 'path'>): OpenInApp => ({
  name: over.id,
  kind: 'editor',
  atLine: true,
  found: 'path',
  detected: over.path,
  detectedWhere: 'path',
  ...over
})

describe('opening at a line', () => {
  const file = '/w/src/checks.ts'
  const target = { folder: '/w', file, line: 267 }

  it('builds each app’s own line arguments', () => {
    expect(editorArgs('goto', target)).toEqual(['-g', '/w/src/checks.ts:267'])
    expect(editorArgs('colon', target)).toEqual(['/w/src/checks.ts:267'])
    expect(editorArgs('jetbrains', target)).toEqual(['--line', '267', '/w/src/checks.ts'])
    expect(editorArgs('none', target)).toEqual([file])
  })

  it('without a line the file opens; without a file the folder does', () => {
    expect(editorArgs('goto', { folder: '/w', file })).toEqual([file])
    expect(editorArgs('jetbrains', { folder: '/w' })).toEqual(['/w'])
    expect(editorArgs('colon', { folder: '/w', file, line: 0 })).toEqual([file])
  })

  const spawnOf = (l: Launch) => (l.kind === 'spawn' ? [l.file, ...l.args] : l)

  it.each([
    ['vscode', '/usr/local/bin/code', ['-g', `${file}:267`]],
    ['cursor', '/usr/local/bin/cursor', ['-g', `${file}:267`]],
    ['windsurf', '/usr/local/bin/windsurf', ['-g', `${file}:267`]],
    ['zed', '/usr/local/bin/zed', [`${file}:267`]],
    ['intellij', '/usr/local/bin/idea', ['--line', '267', file]],
    ['sublime', '/usr/local/bin/subl', [`${file}:267`]]
  ] as const)('%s', (id, exe, args) => {
    expect(spawnOf(buildLaunch(win({ id, path: exe }), target, 'darwin'))).toEqual([exe, ...args])
  })

  it('an app that can’t take a line gets the file', () => {
    expect(spawnOf(buildLaunch(win({ id: 'cursor', path: '/Applications/Cursor.app', atLine: false }), target, 'darwin'))).toEqual(['/usr/bin/open', '-a', '/Applications/Cursor.app', file])
  })

  it('runs the command-line tool inside a macOS app', () => {
    const vscode = win({ id: 'vscode', path: '/Applications/Visual Studio Code.app', launcher: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' })
    expect(spawnOf(buildLaunch(vscode, target, 'darwin'))).toEqual(['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '-g', `${file}:267`])
  })

  it('terminals and the file manager get the folder (the file manager shows the file selected)', () => {
    expect(spawnOf(buildLaunch(win({ id: 'iterm', kind: 'terminal', path: '/Applications/iTerm.app', atLine: false }), target, 'darwin'))).toEqual(['/usr/bin/open', '-a', '/Applications/iTerm.app', '/w'])
    expect(spawnOf(buildLaunch(win({ id: 'ghostty', kind: 'terminal', path: '/Applications/Ghostty.app', atLine: false }), target, 'darwin'))).toEqual([
      '/usr/bin/open',
      '-na',
      '/Applications/Ghostty.app',
      '--args',
      '--working-directory=/w'
    ])
    expect(spawnOf(buildLaunch(win({ id: 'windows-terminal', kind: 'terminal', path: 'C:\\x\\wt.exe', atLine: false }), { folder: 'C:\\My Work\\kigali', file: 'C:\\My Work\\kigali\\a.ts' }, 'win32'))).toEqual([
      'C:\\x\\wt.exe',
      '-d',
      'C:\\My Work\\kigali'
    ])
    const files = win({ id: 'files', kind: 'files', path: 'C:\\Windows\\explorer.exe', atLine: false })
    expect(buildLaunch(files, { folder: 'C:\\w', file: 'C:\\w\\a.ts' }, 'win32')).toEqual({ kind: 'reveal', path: 'C:\\w\\a.ts' })
    expect(buildLaunch(files, { folder: 'C:\\w' }, 'win32')).toEqual({ kind: 'open-path', path: 'C:\\w' })
  })
})

describe('paths with spaces on Windows', () => {
  const target = { folder: 'C:\\My Projects\\kigali', file: 'C:\\My Projects\\kigali\\src\\a b.ts', line: 12 }

  it('quotes a .cmd launcher and its arguments for cmd.exe', () => {
    const code = win({ id: 'vscode', path: 'C:\\Program Files\\Microsoft VS Code\\Code.exe', launcher: 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd' })
    expect(buildLaunch(code, target, 'win32')).toEqual({
      kind: 'spawn',
      file: '"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" -g "C:\\My Projects\\kigali\\src\\a b.ts:12"',
      args: [],
      shell: true
    })
  })

  it('passes arguments as they are to an .exe (no shell)', () => {
    const idea = win({ id: 'intellij', path: 'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2026.2\\bin\\idea64.exe' })
    expect(buildLaunch(idea, target, 'win32')).toEqual({
      kind: 'spawn',
      file: 'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2026.2\\bin\\idea64.exe',
      args: ['--line', '12', 'C:\\My Projects\\kigali\\src\\a b.ts'],
      shell: false
    })
  })

  it('the custom command gets the file, quoted, without a line', () => {
    expect(customLaunch('code-insiders --reuse-window', target, 'win32')).toEqual({
      kind: 'spawn',
      file: 'code-insiders --reuse-window "C:\\My Projects\\kigali\\src\\a b.ts"',
      args: [],
      shell: true
    })
    expect(customLaunch('"/Applications/My Editor.app/Contents/bin/ed" --wait', { folder: '/Users/me/My Work' }, 'darwin')).toEqual({
      kind: 'spawn',
      file: '/Applications/My Editor.app/Contents/bin/ed',
      args: ['--wait', '/Users/me/My Work'],
      shell: false
    })
  })
})

describe('the default app', () => {
  const detection = (apps: OpenInApp[]): OpenInDetection => ({ platform: 'win32', apps, checkedAt: '' })
  const cursor = win({ id: 'cursor', path: 'C:\\c\\Cursor.exe' })
  const zedMissing = win({ id: 'zed', path: null, found: null })
  const files = win({ id: 'files', kind: 'files', path: 'C:\\Windows\\explorer.exe' })

  it('Automatic is the first editor found, then the custom command, then the file manager', () => {
    expect(resolveDefault('', detection([zedMissing, cursor, files]), 'code')).toEqual({ kind: 'app', app: cursor })
    expect(resolveDefault('', detection([zedMissing, files]), 'my-editor')).toEqual({ kind: 'custom', command: 'my-editor' })
    expect(resolveDefault('', detection([zedMissing, files]), '  ')).toEqual({ kind: 'app', app: files })
  })

  it('a chosen app that isn’t found is reported, not swapped for another', () => {
    expect(resolveDefault('zed', detection([zedMissing, cursor]), 'code')).toEqual({ kind: 'missing', choice: 'zed' })
    expect(resolveDefault('custom', detection([cursor]), '')).toEqual({ kind: 'missing', choice: 'custom' })
  })

  it('the service refuses to open with a missing default and says why', async () => {
    const service = new OpenInService(() => ({ openInDefault: 'zed', openInPaths: {}, editorCommand: 'code' }), { openPath: async () => undefined }, () => machine({ platform: 'win32', files: [] }))
    await expect(service.open(null, { folder: 'C:\\w' })).rejects.toThrow(/Zed wasn't found/)
  })

  it('the file manager goes through the host', async () => {
    const opened: string[] = []
    const service = new OpenInService(
      () => ({ openInDefault: 'files', openInPaths: {}, editorCommand: 'code' }),
      { openPath: async (p) => void opened.push(`open ${p}`), revealPath: (p) => void opened.push(`reveal ${p}`) },
      () => machine({ platform: 'win32', files: [] })
    )
    await service.open(null, { folder: 'C:\\w' })
    await service.open('files', { folder: 'C:\\w', file: 'C:\\w\\a.ts' })
    expect(opened).toEqual(['open C:\\w', 'reveal C:\\w\\a.ts'])
  })

  it('detection is cached until refreshed', async () => {
    const p = machine({ platform: 'win32', files: [] })
    const service = new OpenInService(() => ({ openInDefault: '', openInPaths: {}, editorCommand: 'code' }), { openPath: async () => undefined }, () => p)
    await service.apps()
    await service.apps()
    // Two registry queries (HKCU, HKLM) per detection.
    expect(p.runs).toHaveLength(2)
    await service.apps(true)
    expect(p.runs).toHaveLength(4)
  })
})

describe('the user’s own path for an app', () => {
  const base = (): OpenInDetection => ({
    platform: 'win32',
    apps: [win({ id: 'zed', path: null, found: null, detected: null, detectedWhere: null }), win({ id: 'cursor', path: 'C:\\c\\Cursor.exe', found: 'folder' })],
    checkedAt: ''
  })

  it('replaces what was detected and is marked as set by you', () => {
    const own = applyOverrides(base(), { zed: 'D:\\tools\\scoop\\apps\\zed\\current\\zed.exe' }, { exists: (f) => f.startsWith('D:\\tools') })
    expect(own.apps[0]).toMatchObject({ path: 'D:\\tools\\scoop\\apps\\zed\\current\\zed.exe', found: 'user', userPath: 'D:\\tools\\scoop\\apps\\zed\\current\\zed.exe', atLine: true, detected: null })
  })

  it('a path that isn’t there makes the app missing instead of falling back silently', () => {
    const own = applyOverrides(base(), { cursor: 'E:\\gone\\Cursor.exe' }, { exists: () => false })
    expect(own.apps[1]).toMatchObject({ path: null, userPathMissing: true, detected: 'C:\\c\\Cursor.exe' })
  })
})

describe('moving from the old Editor command', () => {
  it('maps the command to a default app, keeping anything else as Custom command…', () => {
    expect(defaultFromEditorCommand('code')).toBe('')
    expect(defaultFromEditorCommand('')).toBe('')
    expect(defaultFromEditorCommand('cursor')).toBe('cursor')
    expect(defaultFromEditorCommand('zed')).toBe('zed')
    expect(defaultFromEditorCommand('subl')).toBe('sublime')
    expect(defaultFromEditorCommand('code-insiders --reuse-window')).toBe('custom')
    expect(defaultFromEditorCommand('"C:\\Program Files\\Notepad++\\notepad++.exe"')).toBe('custom')
  })

  it('new settings start on Automatic with no paths of their own', () => {
    expect(defaultSettings()).toMatchObject({ editorCommand: 'code', openInDefault: '', openInPaths: {} })
  })

  it('an upgrade keeps the editor command unchanged and picks the default once', async () => {
    const dir = await tempDir('foreman-openin-')
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 2, repos: [], settings: { ...defaultSettings(), editorCommand: 'code-insiders --reuse-window', openInDefault: undefined, openInPaths: undefined } }))
    const store = new Store(dir)
    await store.load()
    expect(store.state.settings).toMatchObject({ editorCommand: 'code-insiders --reuse-window', openInDefault: 'custom', openInPaths: {} })
    // A later choice sticks: the migration doesn't run again.
    store.state.settings.openInDefault = 'cursor'
    store.state.settings.openInPaths = { zed: 'D:\\zed.exe' }
    store.flush()
    store.close()
    const again = new Store(dir)
    await again.load()
    expect(again.state.settings).toMatchObject({ editorCommand: 'code-insiders --reuse-window', openInDefault: 'cursor', openInPaths: { zed: 'D:\\zed.exe' } })
    again.close()
  })

  it('an unknown default goes back to Automatic when loading', async () => {
    const dir = await tempDir('foreman-openin-')
    const store = new Store(dir)
    await store.load()
    ;(store.state.settings as unknown as Record<string, unknown>).openInDefault = 'notepad'
    store.flush()
    store.close()
    const again = new Store(dir)
    await again.load()
    expect(again.state.settings.openInDefault).toBe('')
    again.close()
  })
})

describe('the ⌘O shortcut and file paths', () => {
  const key = (over: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({ code: 'KeyO', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over })

  it('is ⌘O on macOS, where ⌃O still expands tool calls', () => {
    expect(openInShortcut('darwin')).toBe('⌘O')
    expect(isOpenInKey(key({ metaKey: true }), 'darwin')).toBe(true)
    expect(isOpenInKey(key({ ctrlKey: true }), 'darwin')).toBe(false)
  })

  it('is Ctrl+Shift+O on Windows, where Ctrl+O expands tool calls', () => {
    expect(openInShortcut('win32')).toBe('Ctrl+Shift+O')
    expect(isOpenInKey(key({ ctrlKey: true, shiftKey: true }), 'win32')).toBe(true)
    expect(isOpenInKey(key({ ctrlKey: true }), 'win32')).toBe(false)
    expect(isOpenInKey(key({ ctrlKey: true, shiftKey: true, altKey: true }), 'win32')).toBe(false)
  })

  it('joins a workspace-relative file with the platform’s separators', () => {
    expect(joinWorkspace('C:\\Users\\me\\My Work\\kigali', 'src/main/checks.ts')).toBe('C:\\Users\\me\\My Work\\kigali\\src\\main\\checks.ts')
    expect(joinWorkspace('/Users/me/My Work/kigali/', 'src/main/checks.ts')).toBe('/Users/me/My Work/kigali/src/main/checks.ts')
  })
})
