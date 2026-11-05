import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileProblems, folderName, githubRepo, parseArgs, publishedName, publishScreens, removeLink, withBaseWorktree } from '../scripts/pr-screens.mjs'
import { makeRepo, tempDir } from './helpers'

// The PR screenshot script (scripts/pr-screens.mjs): where its images go and what it refuses.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A bare "origin" with main, and a clone of it with an identity for commit-tree. */
async function cloneOfOrigin(origin?: string) {
  if (!origin) {
    const seed = await makeRepo()
    origin = path.join(await tempDir(), 'origin.git')
    run(seed, 'clone', '-q', '--bare', seed, origin)
  }
  const clone = path.join(await tempDir(), 'clone')
  run(path.dirname(clone), 'clone', '-q', origin, clone)
  run(clone, 'config', 'user.name', 'Test')
  run(clone, 'config', 'user.email', 'test@example.com')
  return { origin, clone }
}

async function png(name: string, body = PNG) {
  const file = path.join(await tempDir(), name)
  writeFileSync(file, body)
  return file
}

describe('pr-screens', () => {
  it('reads owner/repo from GitHub remotes only', () => {
    for (const url of ['https://github.com/elite-build/foreman.git', 'https://github.com/elite-build/foreman', 'git@github.com:elite-build/foreman.git', 'ssh://git@github.com/elite-build/foreman.git']) {
      expect(githubRepo(url), url).toBe('elite-build/foreman')
    }
    for (const url of ['https://gitlab.com/a/b.git', '/tmp/origin.git', 'https://github.com/a']) expect(githubRepo(url), url).toBeNull()
  })

  it('turns a branch into a folder name', () => {
    expect(folderName('yatin/fabry')).toBe('yatin-fabry')
    expect(folderName('fix: the dialog!')).toBe('fix-the-dialog')
    expect(() => folderName('///')).toThrow('No usable folder name')
  })

  it('prefixes a capture\'s shots with the run they come from', () => {
    expect(publishedName(path.join('tmp', 'run', 'before', 'home-light.png'))).toBe('before-home-light.png')
    expect(publishedName(path.join('tmp', 'run', 'diff', 'home-light.png'))).toBe('diff-home-light.png')
    expect(publishedName(path.join('tmp', 'elsewhere', 'home-light.png'))).toBe('home-light.png')
  })

  it('refuses anything but a PNG', async () => {
    expect(fileProblems(await png('shot.png'))).toEqual([])
    expect(fileProblems(await png('shot.jpg'))[0]).toContain('only .png files')
    expect(fileProblems(await png('fake.png', Buffer.from('not an image')))[0]).toContain('not a PNG image')
    expect(fileProblems('/nowhere/shot.png')[0]).toContain('not found')
  })

  it('pushes to a branch of its own and leaves the checkout alone', async () => {
    const { origin, clone } = await cloneOfOrigin()
    const head = run(clone, 'rev-parse', 'HEAD')
    const { commit, paths } = publishScreens({ cwd: clone, files: [await png('home-light.png')], folder: 'yatin-fabry' })
    expect(paths).toEqual(['yatin-fabry/home-light.png'])
    expect(run(origin, 'rev-parse', 'refs/heads/pr-screenshots')).toBe(commit)
    expect(run(origin, 'rev-list', '--count', commit)).toBe('1')
    expect(run(origin, 'ls-tree', '-r', '--name-only', commit)).toBe('yatin-fabry/home-light.png')
    expect(run(origin, 'rev-parse', 'refs/heads/main')).toBe(head)
    expect(run(clone, 'rev-parse', 'HEAD')).toBe(head)
    expect(run(clone, 'status', '--porcelain')).toBe('')
  })

  it('publishes the same screen from before and after side by side', async () => {
    const { clone } = await cloneOfOrigin()
    const dir = await tempDir()
    const files = ['before', 'after'].map((run) => {
      mkdirSync(path.join(dir, run))
      const file = path.join(dir, run, 'home-light.png')
      writeFileSync(file, PNG)
      return file
    })
    expect(publishScreens({ cwd: clone, files, folder: 'x' }).paths).toEqual(['x/before-home-light.png', 'x/after-home-light.png'])
    expect(() => publishScreens({ cwd: clone, files: [files[0], files[0]], folder: 'x' })).toThrow('Two files share a name')
  })

  it('adds to what another checkout pushed, keeping its files', async () => {
    const first = await cloneOfOrigin()
    const second = await cloneOfOrigin(first.origin)
    const a = publishScreens({ cwd: first.clone, files: [await png('before.png')], folder: 'one' })
    const b = publishScreens({ cwd: second.clone, files: [await png('after.png')], folder: 'two' })
    expect(run(first.origin, 'rev-parse', `${b.commit}^`)).toBe(a.commit)
    expect(run(first.origin, 'ls-tree', '-r', '--name-only', b.commit).split('\n')).toEqual(['one/before.png', 'two/after.png'])
  })

  it('pushes nothing when a file is refused', async () => {
    const { origin, clone } = await cloneOfOrigin()
    const files = [await png('ok.png'), await png('notes.txt')]
    expect(() => publishScreens({ cwd: clone, files, folder: 'x' })).toThrow('only .png files')
    expect(run(origin, 'branch', '--list', 'pr-screenshots')).toBe('')
  })

  it('retries a push that lost the race, and nothing else', async () => {
    const { origin, clone } = await cloneOfOrigin()
    const count = path.join(origin, 'attempts')
    const hook = (reason: string, passOnSecond: boolean) => {
      writeFileSync(count, '')
      const file = path.join(origin, 'hooks', 'pre-receive')
      writeFileSync(file, `#!/bin/sh\necho x >> "${count.replaceAll('\\', '/')}"\n${passOnSecond ? `[ "$(wc -l < "${count.replaceAll('\\', '/')}")" -ge 2 ] && exit 0\n` : ''}echo "${reason}" >&2\nexit 1\n`)
      chmodSync(file, 0o755)
    }
    const attempts = () => readFileSync(count, 'utf8').split('\n').filter(Boolean).length
    hook('! [rejected] non-fast-forward', true)
    publishScreens({ cwd: clone, files: [await png('a.png')], folder: 'x' })
    expect(attempts()).toBe(2)
    hook('denied by policy', false)
    const files = [await png('b.png')]
    expect(() => publishScreens({ cwd: clone, files, folder: 'x' })).toThrow()
    expect(attempts()).toBe(1)
  })

  it('parses a command, its options and its files', () => {
    expect(parseArgs(['publish', 'a.png', '--folder', 'f', 'b.png'])).toEqual({ command: 'publish', options: { folder: 'f' }, positional: ['a.png', 'b.png'] })
    expect(parseArgs(['capture', '--only', 'home,tiles'])).toEqual({ command: 'capture', options: { only: 'home,tiles' }, positional: [] })
    expect(() => parseArgs(['capture', '--only'])).toThrow('--only needs a value')
    expect(() => parseArgs(['capture', '--only', '--out', 'x'])).toThrow('--only needs a value')
  })

  it('removes the base worktree even when the capture fails, and leaves node_modules alone', async () => {
    const root = realpathSync(await makeRepo({ 'README.md': 'v1\n', '.gitignore': 'node_modules/\n' }))
    mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), '{}')
    writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'kept')
    let seen = ''
    expect(() =>
      withBaseWorktree(root, 'HEAD', (worktree) => {
        seen = worktree
        expect(readFileSync(path.join(worktree, 'README.md'), 'utf8')).toBe('v1\n')
        expect(readFileSync(path.join(worktree, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('kept')
        throw new Error('capture failed')
      })
    ).toThrow('capture failed')
    expect(existsSync(path.dirname(seen))).toBe(false)
    expect(run(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    expect(readFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('kept')
  })

  it('removes a link and never what it points to (a junction on Windows, a symbolic link elsewhere), and leaves a real folder alone', async () => {
    const dir = await tempDir('foreman-pr-link-')
    const target = path.join(dir, 'modules')
    mkdirSync(path.join(target, 'pkg'), { recursive: true })
    writeFileSync(path.join(target, 'pkg', 'index.js'), 'kept')
    const link = path.join(dir, 'link')
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    removeLink(link)
    expect(existsSync(link)).toBe(false)
    expect(readFileSync(path.join(target, 'pkg', 'index.js'), 'utf8')).toBe('kept')
    // Nothing there is fine; a folder that isn't a link is refused, with its contents untouched.
    expect(() => removeLink(link)).not.toThrow()
    expect(() => removeLink(target)).toThrow('is not a link')
    expect(readFileSync(path.join(target, 'pkg', 'index.js'), 'utf8')).toBe('kept')
  })

  it('reports a ref that does not exist without leaving anything behind', async () => {
    const root = await makeRepo()
    expect(() => withBaseWorktree(root, 'no-such-ref', () => 'unreached')).toThrow()
    expect(run(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })
})
