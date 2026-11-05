// A path in the chat opens where it belongs (shared/fileOpen.ts), and main decides: only a page, picture, PDF, film or
// office file reaches the OS's own open (which runs a program or a script); text and code go to the editor from
// Settings → Open in apps; programs, archives and folders are only shown in their folder.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core, type Host } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { fileOpenKind, isAbsolutePath, opensInDefaultApp } from '../src/shared/fileOpen'
import { tempDir } from './helpers'

afterEach(() => vi.restoreAllMocks())

describe('fileOpenKind', () => {
  it('sends things to look at to the OS default app', () => {
    expect(fileOpenKind('C:\\site\\index.html')).toBe('browser')
    expect(fileOpenKind('/tmp/shots/v4-1.PNG')).toBe('image')
    expect(fileOpenKind('logo.svg')).toBe('image')
    expect(fileOpenKind('report.pdf')).toBe('pdf')
    expect(fileOpenKind('demo.mp4')).toBe('media')
    expect(fileOpenKind('plan.xlsx')).toBe('document')
    for (const kind of ['browser', 'image', 'pdf', 'media', 'document'] as const) expect(opensInDefaultApp(kind)).toBe(true)
  })

  it('sends text, code and scripts to the editor, which never runs them', () => {
    // On Windows the OS default for .ts is a video player, and for .js, .bat and .ps1 it runs them.
    for (const file of ['src/app.ts', 'notes.md', 'build.js', 'setup.bat', 'capture.ps1', 'run.sh', 'Makefile', '.env']) expect(fileOpenKind(file)).toBe('editor')
    expect(opensInDefaultApp('editor')).toBe(false)
  })

  it('only shows programs, installers, bundles, shortcuts and archives in their folder', () => {
    for (const file of ['setup.exe', 'tool.msi', 'Foreman.app', 'Foreman.dmg', 'link.lnk', 'out.zip', 'a.tar.gz', 'App.AppImage']) expect(fileOpenKind(file)).toBe('reveal')
    expect(opensInDefaultApp('reveal')).toBe(false)
  })

  it('reads the extension of the file, not of a folder on the way', () => {
    expect(fileOpenKind('C:\\site.html\\readme')).toBe('editor')
    expect(fileOpenKind('/srv/app.exe/notes.txt')).toBe('editor')
  })

  it('knows a full path on Windows and elsewhere', () => {
    expect(isAbsolutePath('C:\\Users\\me\\a.png')).toBe(true)
    expect(isAbsolutePath('c:/a.png')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\a.png')).toBe(true)
    expect(isAbsolutePath('/Users/me/a.png')).toBe(true)
    expect(isAbsolutePath('src/a.png')).toBe(false)
  })
})

async function setup(host: Partial<Host> = {}) {
  const dir = await tempDir('foreman-open-file-')
  const store = new Store(dir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() })
  const opened: string[] = []
  const core = new Core(store, secrets, {
    broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async (p) => void opened.push(`open ${p}`),
    revealPath: (p) => void opened.push(`reveal ${p}`),
    openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => '',
    ...host
  })
  core.attention.stop()
  // The editor is never launched in a test: what it would have been asked to open is recorded instead.
  vi.spyOn(core.openIn, 'open').mockImplementation(async (_app, target) => void opened.push(`editor ${target.file ?? target.folder}`))
  const files = path.join(dir, 'files')
  await mkdir(path.join(files, 'Foreman.app'), { recursive: true })
  for (const name of ['index.html', 'shot.png', 'app.ts', 'setup.bat', 'setup.exe', 'out.zip']) await writeFile(path.join(files, name), 'x')
  return { core, files, opened }
}

describe('openFile', () => {
  it('opens a page and a picture in the OS default app', async () => {
    const { core, files, opened } = await setup()
    await core.api.openFile(path.join(files, 'index.html'))
    await core.api.openFile(path.join(files, 'shot.png'), 'open')
    expect(opened).toEqual([`open ${path.join(files, 'index.html')}`, `open ${path.join(files, 'shot.png')}`])
    await core.shutdown()
  })

  it('opens code and scripts in the editor, never with the OS (which would run a script)', async () => {
    const { core, files, opened } = await setup()
    await core.api.openFile(path.join(files, 'app.ts'))
    await core.api.openFile(path.join(files, 'setup.bat'))
    expect(opened).toEqual([`editor ${path.join(files, 'app.ts')}`, `editor ${path.join(files, 'setup.bat')}`])
    await core.shutdown()
  })

  it('only shows a program, an archive or a bundle in its folder', async () => {
    const { core, files, opened } = await setup()
    await core.api.openFile(path.join(files, 'setup.exe'))
    await core.api.openFile(path.join(files, 'out.zip'))
    await core.api.openFile(path.join(files, 'Foreman.app'))
    expect(opened).toEqual([`reveal ${path.join(files, 'setup.exe')}`, `reveal ${path.join(files, 'out.zip')}`, `reveal ${path.join(files, 'Foreman.app')}`])
    await core.shutdown()
  })

  it('shows any file in its folder when asked, and opens the folder where the host cannot select a file', async () => {
    const { core, files, opened } = await setup()
    await core.api.openFile(path.join(files, 'index.html'), 'reveal')
    expect(opened).toEqual([`reveal ${path.join(files, 'index.html')}`])
    await core.shutdown()

    const bare = await setup({ revealPath: undefined })
    await bare.core.api.openFile(path.join(bare.files, 'setup.exe'))
    expect(bare.opened).toEqual([`open ${bare.files}`])
    await bare.core.shutdown()
  })

  it('says a file is gone, and refuses a path that is not a full one', async () => {
    const { core, files, opened } = await setup()
    await expect(core.api.openFile(path.join(files, 'v4-1.png'))).rejects.toThrow("v4-1.png isn't there any more")
    await expect(core.api.openFile('index.html')).rejects.toThrow('full path')
    expect(opened).toEqual([])
    await core.shutdown()
  })
})
