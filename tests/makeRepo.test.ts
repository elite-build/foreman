import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitOut } from '../src/main/git'
import { makeRepository, refusalFor } from '../src/main/makeRepo'
import { isNotGitRepoError } from '../src/shared/types'
import { tempDir } from './helpers'

// Git's own configuration is replaced by a temporary file for the whole file, so the user's real
// name, email and settings are neither read nor changed.
const SAVED: Record<string, string | undefined> = {}
const KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']
let globalConfig = ''

beforeAll(async () => {
  for (const key of KEYS) SAVED[key] = process.env[key]
  for (const key of KEYS) delete process.env[key]
  const dir = await tempDir('makerepo-config-')
  globalConfig = path.join(dir, 'gitconfig')
  // useConfigOnly: never guess an author from the user and host names, so "no identity" is the same everywhere.
  await writeFile(globalConfig, '[user]\n\tuseConfigOnly = true\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

afterAll(() => {
  for (const key of KEYS) {
    if (SAVED[key] === undefined) delete process.env[key]
    else process.env[key] = SAVED[key]
  }
})

const IDENTITY = { name: 'Ada Lovelace', email: 'ada@example.com' }
// A home folder that is never the folder under test.
const elsewhere = () => path.join(os.tmpdir(), 'makerepo-home-elsewhere')

/** Give the temporary global configuration an author, as a configured machine has. */
async function configureGlobalIdentity(): Promise<void> {
  await git(os.tmpdir(), ['config', '--global', 'user.name', 'Global Person'])
  await git(os.tmpdir(), ['config', '--global', 'user.email', 'global@example.com'])
}

describe('makeRepository', () => {
  it('needs an author, answers needs-identity and leaves no commit', { timeout: 60_000 }, async () => {
    const dir = await tempDir('makerepo-plain-')
    await writeFile(path.join(dir, 'app.txt'), 'hello\n')
    expect(await makeRepository(dir, undefined, { homeDir: elsewhere() })).toEqual({ status: 'needs-identity' })
    expect((await git(dir, ['rev-parse', '--verify', 'HEAD'], { allowFail: true })).code).not.toBe(0)
  })

  it('finishes the same folder once given an identity, kept in the repository only', { timeout: 60_000 }, async () => {
    const dir = await tempDir('makerepo-retry-')
    await writeFile(path.join(dir, 'app.txt'), 'hello\n')
    await writeFile(path.join(dir, '.gitignore'), 'secret.txt\n')
    await writeFile(path.join(dir, 'secret.txt'), 'shh\n')
    expect((await makeRepository(dir, undefined, { homeDir: elsewhere() })).status).toBe('needs-identity')

    expect(await makeRepository(dir, IDENTITY, { homeDir: elsewhere() })).toEqual({ status: 'done', dir })
    expect(await gitOut(dir, ['rev-list', '--count', 'HEAD'])).toBe('1')
    expect((await gitOut(dir, ['ls-files'])).split('\n').sort()).toEqual(['.gitignore', 'app.txt'])
    expect(await gitOut(dir, ['log', '-1', '--format=%an <%ae>'])).toBe('Ada Lovelace <ada@example.com>')
    // Saved for this repository, not for every repository.
    expect(await gitOut(dir, ['config', '--local', 'user.name'])).toBe('Ada Lovelace')
    expect((await git(dir, ['config', '--global', 'user.name'], { allowFail: true })).code).not.toBe(0)
  })

  it('saves the identity globally only when asked', { timeout: 60_000 }, async () => {
    const dir = await tempDir('makerepo-global-')
    await writeFile(path.join(dir, 'app.txt'), 'hello\n')
    await makeRepository(dir, { ...IDENTITY, global: true }, { homeDir: elsewhere() })
    expect(await gitOut(dir, ['config', '--global', 'user.email'])).toBe('ada@example.com')
    expect(await readFile(globalConfig, 'utf8')).toContain('ada@example.com')
    await git(dir, ['config', '--global', '--unset', 'user.name'])
    await git(dir, ['config', '--global', '--unset', 'user.email'])
  })

  it('turns a folder of files into a repository with one commit', { timeout: 60_000 }, async () => {
    await configureGlobalIdentity()
    const dir = await tempDir('makerepo-files-')
    await mkdir(path.join(dir, 'src'))
    await writeFile(path.join(dir, 'src', 'index.ts'), 'export {}\n')
    await writeFile(path.join(dir, 'notes.md'), 'notes\n')
    expect(await makeRepository(dir, undefined, { homeDir: elsewhere() })).toEqual({ status: 'done', dir })
    expect(await gitOut(dir, ['rev-list', '--count', 'HEAD'])).toBe('1')
    expect(await gitOut(dir, ['branch', '--show-current'])).toBe('main')
    expect((await gitOut(dir, ['ls-files'])).split('\n').sort()).toEqual(['notes.md', 'src/index.ts'])
    expect(await gitOut(dir, ['status', '--porcelain'])).toBe('')
  })

  it('adds a README to an empty folder', { timeout: 60_000 }, async () => {
    const dir = await tempDir('makerepo-empty-')
    expect(await makeRepository(dir, undefined, { homeDir: elsewhere() })).toEqual({ status: 'done', dir })
    expect(await gitOut(dir, ['ls-files'])).toBe('README.md')
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe(`# ${path.basename(dir)}\n`)
    expect(await gitOut(dir, ['rev-list', '--count', 'HEAD'])).toBe('1')
  })

  it('leaves a folder that is already a repository with commits alone', { timeout: 60_000 }, async () => {
    const dir = await tempDir('makerepo-existing-')
    await makeRepository(dir, undefined, { homeDir: elsewhere() })
    const head = await gitOut(dir, ['rev-parse', 'HEAD'])
    await writeFile(path.join(dir, 'later.txt'), 'later\n')
    expect(await makeRepository(dir, undefined, { homeDir: elsewhere() })).toEqual({ status: 'done', dir })
    expect(await gitOut(dir, ['rev-parse', 'HEAD'])).toBe(head)
  })

  it('refuses a drive root, the home folder and a folder that holds it, without touching them', async () => {
    const root = path.parse(os.tmpdir()).root
    await expect(makeRepository(root, undefined, { homeDir: elsewhere() })).rejects.toThrow(/top of a drive/)

    const parent = await tempDir('makerepo-parent-')
    const home = path.join(parent, 'me')
    await mkdir(home)
    await expect(makeRepository(home, undefined, { homeDir: home })).rejects.toThrow(/home folder/)
    await expect(makeRepository(parent, undefined, { homeDir: home })).rejects.toThrow(/home folder/)
    await expect(git(home, ['rev-parse', '--git-dir'])).rejects.toThrow()
    expect(refusalFor(path.join(home, 'project'), home)).toBeNull()
  })

  it('names what is wrong with a missing path or a file', async () => {
    const dir = await tempDir('makerepo-bad-')
    await expect(makeRepository(path.join(dir, 'nope'), undefined, { homeDir: elsewhere() })).rejects.toThrow(/doesn't exist/)
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'x')
    await expect(makeRepository(file, undefined, { homeDir: elsewhere() })).rejects.toThrow(/not a folder/)
  })

  it('rejects an identity without a usable name or email', { timeout: 60_000 }, async () => {
    const dir = await tempDir('makerepo-invalid-')
    await expect(makeRepository(dir, { name: ' ', email: 'ada@example.com' }, { homeDir: elsewhere() })).rejects.toThrow(/name and an email/)
    await expect(makeRepository(dir, { name: 'Ada', email: 'not-an-email' }, { homeDir: elsewhere() })).rejects.toThrow(/name and an email/)
  })
})

describe('isNotGitRepoError', () => {
  it('recognises addRepo\'s error, also as an IPC error carries it', () => {
    expect(isNotGitRepoError(new Error('C:\\code\\site is not inside a git repository'))).toBe(true)
    expect(isNotGitRepoError(new Error("Error invoking remote method 'addRepo': Error: /tmp/x is not inside a git repository"))).toBe(true)
    expect(isNotGitRepoError(new Error('Something else'))).toBe(false)
  })
})
