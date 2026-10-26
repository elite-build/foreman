import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitOut } from '../src/main/git'
import { cloneRepo, looksLikeCloneUrl, quickStart, repoNameFromUrl } from '../src/main/repoSources'
import { makeRepo, tempDir } from './helpers'

describe('clone URLs', () => {
  it('names the folder after the repository', () => {
    expect(repoNameFromUrl('https://github.com/acme/web.git')).toBe('web')
    expect(repoNameFromUrl('git@github.com:acme/api-server.git')).toBe('api-server')
    expect(repoNameFromUrl('https://github.com/acme/site/')).toBe('site')
    expect(repoNameFromUrl('https://github.com/acme/..')).toBeNull()
  })

  it('recognises the forms git accepts', () => {
    expect(looksLikeCloneUrl('https://github.com/a/b')).toBe(true)
    expect(looksLikeCloneUrl('git@github.com:a/b.git')).toBe(true)
    expect(looksLikeCloneUrl('ssh://git@host/a/b.git')).toBe(true)
    expect(looksLikeCloneUrl('just words')).toBe(false)
  })
})

describe('cloning and quick start', () => {
  it('clones into parent/<name> and reports progress', async () => {
    const source = await makeRepo({ 'a.txt': 'hello\n' })
    const parent = await tempDir()
    const lines: string[] = []
    const dest = await cloneRepo(source, parent, (line) => lines.push(line))
    expect(dest).toBe(path.join(parent, path.basename(source)))
    expect(await readFile(path.join(dest, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(lines.some((l) => /Cloning into/.test(l))).toBe(true)
    await expect(cloneRepo(source, parent, () => {})).rejects.toThrow(/already exists/)
  })

  it('starts a new repository with a first commit', async () => {
    const parent = await tempDir()
    const dir = await quickStart(parent, 'my-project')
    expect(existsSync(path.join(dir, 'README.md'))).toBe(true)
    expect(await gitOut(dir, ['log', '--format=%s'])).toBe('Initial commit')
    await expect(quickStart(parent, 'bad name!')).rejects.toThrow(/letters, numbers/)
  })
})
