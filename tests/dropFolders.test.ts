import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Core, type Host } from '../src/main/core'
import { classifyFolders, displayRemote, launchPaths } from '../src/main/dropFolders'
import { git, toplevel } from '../src/main/git'
import { safeDirName } from '../src/main/platform'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { dropPlan, mightBeFolder } from '../src/renderer/src/components/dropPlan'
import type { DroppedFolder, MainEvent } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'

// What addRepo would store as the repo's root (git's answer, which spells out Windows short names).
async function rootOf(dir: string): Promise<string> {
  return path.normalize(await toplevel(dir))
}

describe('classifyFolders (O21)', () => {
  it('finds a git repo with its branch, origin and where workspaces go', async () => {
    const repo = await makeRepo()
    await git(repo, ['remote', 'add', 'origin', 'https://user:secret@github.com/acme/ledger-api.git'])
    const root = await rootOf(repo)
    const [found] = await classifyFolders([repo], [], path.join('W:', 'ws'))
    expect(found).toMatchObject({ kind: 'repo', path: path.resolve(repo), name: path.basename(repo), root, branch: 'main', origin: 'github.com/acme/ledger-api' })
    expect(found.workspacesDir).toBe(path.join('W:', 'ws', safeDirName(path.basename(root))))
  })

  it('says null for a repo without origin, and adds the top folder for a folder inside a repo', async () => {
    const repo = await makeRepo()
    const inner = path.join(repo, 'src', 'lib')
    await mkdir(inner, { recursive: true })
    const [found] = await classifyFolders([inner], [], 'W:')
    expect(found).toMatchObject({ kind: 'repo', path: inner, name: 'lib', root: await rootOf(repo), origin: null })
  })

  it('tells a plain folder, a file and a missing path apart', async () => {
    const dir = await tempDir('foreman-drop-')
    const plain = path.join(dir, 'notes')
    await mkdir(plain)
    const file = path.join(dir, 'todo.txt')
    await writeFile(file, 'x')
    const missing = path.join(dir, 'gone')
    const found = await classifyFolders([plain, file, missing], [], 'W:')
    expect(found.map((f) => [f.kind, f.name])).toEqual([['not-git', 'notes'], ['file', 'todo.txt'], ['missing', 'gone']])
    expect(found[0].root).toBeUndefined()
  })

  it('marks a repo that is already in Foreman, and leaves out the same folder dropped twice', async () => {
    const repo = await makeRepo()
    const root = await rootOf(repo)
    const repos = [{ id: 'r1', rootPath: root }]
    const found = await classifyFolders([repo, repo, path.join(repo, '.')], repos, 'W:')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: 'added', repoId: 'r1', root })
    expect(found[0].workspacesDir).toBeUndefined()
  })

  it('skips empty strings', async () => {
    expect(await classifyFolders(['', ''], [], 'W:')).toEqual([])
  })
})

describe('displayRemote', () => {
  it('shows host/path without scheme, credentials or .git', () => {
    expect(displayRemote('https://github.com/acme/app.git')).toBe('github.com/acme/app')
    expect(displayRemote('https://user:token@github.com/acme/app.git')).toBe('github.com/acme/app')
    expect(displayRemote('git@github.com:acme/app.git')).toBe('github.com/acme/app')
    expect(displayRemote('ssh://git@example.com:2222/acme/app.git')).toBe('example.com:2222/acme/app')
    expect(displayRemote('https://gitlab.com/group/sub/app/')).toBe('gitlab.com/group/sub/app')
    expect(displayRemote('  git@github.com:acme/App.GIT\n')).toBe('github.com/acme/App')
  })

  it('keeps a remote on disk as a path', () => {
    expect(displayRemote('C:\\repos\\app')).toBe('C:\\repos\\app')
    expect(displayRemote('/srv/git/app.git')).toBe('/srv/git/app.git')
    expect(displayRemote('../app')).toBe('../app')
  })
})

describe('launchPaths', () => {
  const cwd = path.resolve('/launch/here')
  const app = path.resolve('/apps/foreman')

  it('takes the folders after the executable, skipping switches and the app itself', () => {
    const code = path.resolve('/code/ledger-api')
    const argv = ['Foreman.exe', '--allow-file-access-from-files', '-psn_0_12345', '.', code, '--inspect=9229']
    expect(launchPaths(argv, { cwd: app, skip: [app] })).toEqual([code])
  })

  it('resolves relative paths against the launch folder and drops repeats', () => {
    const argv = ['foreman', 'ledger-api', path.join(cwd, 'ledger-api'), '../other']
    expect(launchPaths(argv, { cwd })).toEqual([path.join(cwd, 'ledger-api'), path.resolve(cwd, '../other')])
  })

  it('turns file:// URIs (Linux %U) into paths and ignores other URLs', () => {
    const dir = path.resolve('/code/my app')
    const argv = ['foreman', pathToFileURL(dir).href, 'https://example.com/x', 'foreman://open']
    expect(launchPaths(argv, { cwd })).toEqual([dir])
  })

  it('compares without case except on Linux', () => {
    const argv = ['foreman', path.resolve('/Code/App'), path.resolve('/code/app')]
    expect(launchPaths(argv, { cwd, platform: 'win32' })).toHaveLength(1)
    expect(launchPaths(['foreman', app.toUpperCase()], { cwd, skip: [app], platform: 'darwin' })).toEqual([])
    if (process.platform === 'linux') expect(launchPaths(argv, { cwd, platform: 'linux' })).toHaveLength(2)
  })

  it('is empty for a plain launch', () => {
    expect(launchPaths(['Foreman.exe'], { cwd })).toEqual([])
    expect(launchPaths([], { cwd })).toEqual([])
  })
})

describe('drop overlay and confirmation helpers', () => {
  it('shows the overlay for type-less files (a folder, or a file main will turn down), not for typed files or text', () => {
    expect(mightBeFolder([{ kind: 'file', type: '' }])).toBe(true)
    expect(mightBeFolder([{ kind: 'file', type: 'image/png' }, { kind: 'file', type: '' }])).toBe(true)
    expect(mightBeFolder([{ kind: 'file', type: 'image/png' }])).toBe(false)
    expect(mightBeFolder([{ kind: 'string', type: '' }])).toBe(false)
    expect(mightBeFolder(null)).toBe(false)
  })

  it('lists folders, adds only new repos, folds two folders of one repo together and counts non-folders', () => {
    const found: DroppedFolder[] = [
      { path: '/c/a', name: 'a', kind: 'repo', root: '/c/a' },
      { path: '/c/a/src', name: 'src', kind: 'repo', root: '/c/a' },
      { path: '/c/b', name: 'b', kind: 'added', root: '/c/b', repoId: 'r' },
      { path: '/c/n', name: 'n', kind: 'not-git' },
      { path: '/c/f.txt', name: 'f.txt', kind: 'file' },
      { path: '/c/gone', name: 'gone', kind: 'missing' }
    ]
    const plan = dropPlan(found)
    expect(plan.shown.map((f) => f.name)).toEqual(['a', 'b', 'n'])
    expect(plan.addable).toEqual(['/c/a'])
    expect(plan.skipped).toBe(2)
    expect(dropPlan([{ path: '/f', name: 'f', kind: 'file' }])).toEqual({ shown: [], addable: [], skipped: 1 })
  })
})

describe('Core: folders from the command line', () => {
  async function core() {
    const dir = await tempDir('foreman-drop-core-')
    const store = new Store(dir)
    await store.load()
    const events: MainEvent[] = []
    const host: Host = {
      broadcast: (event) => events.push(event),
      applyTheme() {},
      setBadge() {},
      setZoom() {},
      keepAwake() {},
      pickDirectory: async () => null,
      pickFiles: async () => [],
      pickPath: async () => null,
      openPath: async () => {},
      openExternal: async () => {},
      metrics: () => ({ cpuPercent: 0, memoryMb: 0 }),
      cliShim: () => ''
    }
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() })
    return { core: new Core(store, secrets, host), store, events }
  }

  it('holds them for the window, tells it once per new folder, and hands them over once', async () => {
    const { core: c, events } = await core()
    const launched = () => events.filter((e) => e.type === 'launch-folders').length
    c.addLaunchFolders([])
    expect(launched()).toBe(0)
    c.addLaunchFolders(['/code/a', '/code/b'])
    c.addLaunchFolders(['/code/a'])
    expect(launched()).toBe(1)
    expect(await c.api.takeLaunchFolders()).toEqual(['/code/a', '/code/b'])
    expect(await c.api.takeLaunchFolders()).toEqual([])
  })

  it('classifies against the repos in Foreman and adds nothing', async () => {
    const { core: c, store } = await core()
    const repo = await makeRepo()
    const [found] = await c.api.classifyFolders([repo])
    expect(found.kind).toBe('repo')
    expect(found.workspacesDir?.startsWith(store.state.settings.workspacesRoot)).toBe(true)
    expect(store.state.repos).toEqual([])
    const added = await c.api.addRepo(repo)
    expect((await c.api.classifyFolders([repo]))[0]).toMatchObject({ kind: 'added', repoId: added.id })
  })
})
