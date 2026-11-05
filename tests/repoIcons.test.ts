import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { icons } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { git, gitBlob } from '../src/main/git'
import { GitlabApi } from '../src/main/gitlab'
import { githubOrgAvatar, gitlabProjectAvatar, iconCandidates, parseIconAnswer, parseTree, RepoIcons, type IconImage, type RepoIconDeps, type TreeEntry } from '../src/main/repoIcons'
import { SUGGESTED_REPO_ICONS } from '../src/shared/repoIcons'
import { normalizeGitlabHost } from '../src/shared/scm'
import type { Repo } from '../src/shared/types'
import { commit, tempDir } from './helpers'

/** A PNG's signature and IHDR, enough for its type and size to be read. */
function png(width: number, height: number, padTo = 33): Buffer {
  const b = Buffer.alloc(Math.max(33, padTo))
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

const entry = (p: string, oid = p.padEnd(40, '0'), size = 2000): TreeEntry => ({ path: p, oid, size })

async function repoWith(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await writeFile(path.join(dir, name), content)
  }
  await git(dir, ['add', '-A'])
  await commit(dir, 'initial')
  return dir
}

function repoAt(rootPath: string, name = 'foreman'): Repo {
  return { id: 'r1', name, rootPath, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: '' }
}

function finder(repo: Repo, overrides: Partial<RepoIconDeps> = {}) {
  const changed = vi.fn()
  const ask = vi.fn<RepoIconDeps['ask']>(async () => null)
  const deps: RepoIconDeps = {
    repo: (id) => (id === repo.id ? repo : undefined),
    changed,
    listTree: async (root, ref) => {
      const r = await git(root, ['ls-tree', '-r', '-l', '-z', ref], { allowFail: true })
      return r.code === 0 ? r.stdout : null
    },
    blob: (root, oid) => gitBlob(root, oid),
    ask,
    remoteAvatar: async () => null,
    ...overrides
  }
  return { icons: new RepoIcons(deps), changed, ask: (overrides.ask as typeof ask | undefined) ?? ask }
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>'

describe('iconCandidates', () => {
  it('puts the app icon first and keeps variants, deep files and other projects out of the strong ones', () => {
    const list = iconCandidates(
      [
        entry('README.md'),
        entry('build/icon-dev.png'),
        entry('resources/mobile/icon.svg'),
        entry('build/icon.ico'),
        entry('build/icon.png'),
        entry('node_modules/pkg/logo.png'),
        entry('tests/fixtures/favicon.ico'),
        entry('docs/screens/home.png')
      ],
      'foreman'
    )
    expect(list.map((c) => c.path)).toEqual(['build/icon.png', 'build/icon.ico', 'resources/mobile/icon.svg', 'build/icon-dev.png'])
    expect(list.filter((c) => c.strong).map((c) => c.path)).toEqual(['build/icon.png', 'build/icon.ico'])
  })

  it("passes over a starter template's default favicon and files too large to be an icon", () => {
    const list = iconCandidates(
      [entry('app/favicon.ico', 'af98450595e8b8efd9e505cddc5ed705b665a4d8'), entry('public/logo.png', undefined, 5_000_000), entry('public/favicon.svg')],
      'web'
    )
    expect(list.map((c) => c.path)).toEqual(['public/favicon.svg'])
  })

  it("finds a monorepo package's favicon", () => {
    const list = iconCandidates([entry('frontend/public/icons/datasets/filter-icon.svg'), entry('frontend/public/favicon/favicon.ico'), entry('frontend/public/logo/logo_single.svg')], 'future-agi')
    expect(list.filter((c) => c.strong).map((c) => c.path)).toEqual(['frontend/public/favicon/favicon.ico', 'frontend/public/logo/logo_single.svg'])
  })

  it('counts a file named after the project as a logo', () => {
    expect(iconCandidates([entry('docs/archify.svg'), entry('docs/other.svg')], 'Archify').map((c) => [c.path, c.strong])).toEqual([['docs/archify.svg', true]])
  })

  it('reads git ls-tree -l -z output', () => {
    const listing = '100644 blob aaaa    120\tbuild/icon.png\0' + '040000 tree bbbb       -\tbuild\0' + '100644 blob cccc     12\tname with spaces.svg\0'
    expect(parseTree(listing)).toEqual([
      { path: 'build/icon.png', oid: 'aaaa', size: 120 },
      { path: 'name with spaces.svg', oid: 'cccc', size: 12 }
    ])
  })
})

describe('parseIconAnswer', () => {
  const candidates = iconCandidates([entry('build/icon.png'), entry('public/favicon.svg')], 'x')

  it('takes the numbered file and a listed icon', () => {
    expect(parseIconAnswer('2 Rocket', candidates)).toEqual({ file: candidates[1], lucide: 'Rocket' })
    expect(parseIconAnswer('"1 brain"', candidates)).toEqual({ file: candidates[0], lucide: 'Brain' })
  })

  it('holds the answer to what was offered', () => {
    expect(parseIconAnswer('0 Briefcase', candidates)).toEqual({ lucide: 'Briefcase' })
    expect(parseIconAnswer('7 NotAnIcon', candidates)).toEqual({})
    // The digit in an icon's name isn't a file number.
    expect(parseIconAnswer('Gamepad2', candidates)).toEqual({ lucide: 'Gamepad2' })
    expect(parseIconAnswer('I cannot tell', candidates)).toEqual({})
  })

  it('only suggests icons Lucide has', () => {
    const all = icons as unknown as Record<string, unknown>
    expect(SUGGESTED_REPO_ICONS.filter((name) => !all[name])).toEqual([])
  })
})

describe('RepoIcons', () => {
  it("uses the file Claude picks, from the default branch, and marks the repository looked at", async () => {
    const dir = await repoWith({ 'build/icon.png': png(512, 512), 'resources/mobile/icon.svg': SVG, 'README.md': '# Foreman\nRun agents in parallel.\n' })
    // Whatever is checked out doesn't matter.
    await git(dir, ['checkout', '-q', '-b', 'feature'])
    await rm(path.join(dir, 'build'), { recursive: true })
    await git(dir, ['add', '-A'])
    await commit(dir, 'drop the icon')
    const repo = repoAt(dir)
    const { icons: f, changed, ask } = finder(repo, { ask: vi.fn(async () => '1 Terminal') })
    await f.pick(repo.id)
    const prompt = ask.mock.calls[0][0]
    expect(prompt).toContain('1. build/icon.png')
    expect(prompt).toContain('Run agents in parallel.')
    expect(repo.icon).toEqual({ kind: 'image', dataUrl: `data:image/png;base64,${png(512, 512).toString('base64')}` })
    expect(repo.iconChecked).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('takes the strongest file by name and place when Claude is unavailable', async () => {
    const dir = await repoWith({ 'public/favicon.svg': SVG, 'docs/logo-dark.png': png(64, 64) })
    const repo = repoAt(dir)
    await finder(repo).icons.pick(repo.id)
    expect(repo.icon).toEqual({ kind: 'image', dataUrl: `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}` })
  })

  it("prefers an organisation's avatar to a suggested icon, and suggests one when there's nothing else", async () => {
    const dir = await repoWith({ 'README.md': '# career\nMy job search notes.\n' })
    const avatar: IconImage = { bytes: png(64, 64), type: 'image/png' }
    const withAvatar = repoAt(dir)
    await finder(withAvatar, { ask: vi.fn(async () => '0 Briefcase'), remoteAvatar: async () => avatar }).icons.pick(withAvatar.id)
    expect(withAvatar.icon).toEqual({ kind: 'image', dataUrl: `data:image/png;base64,${avatar.bytes.toString('base64')}` })

    const plain = repoAt(dir)
    const { icons: f, ask } = finder(plain, { ask: vi.fn(async () => '0 Briefcase') })
    await f.pick(plain.id)
    expect(ask.mock.calls[0][0]).toContain('no image files named like an icon')
    expect(plain.icon).toEqual({ kind: 'lucide', name: 'Briefcase' })
  })

  it("doesn't ask Claude when an avatar answers for a repository with no icon files", async () => {
    const dir = await repoWith({ 'README.md': 'x\n' })
    const repo = repoAt(dir)
    const { icons: f, ask } = finder(repo, { ask: vi.fn(async () => '0 Rocket'), remoteAvatar: async () => ({ bytes: png(64, 64), type: 'image/png' }) })
    await f.pick(repo.id)
    expect(ask).not.toHaveBeenCalled()
    expect(repo.icon?.kind).toBe('image')
  })

  it('falls back to the letters, and remembers it looked', async () => {
    const dir = await repoWith({ 'README.md': 'x\n' })
    const repo = repoAt(dir)
    const { icons: f, changed } = finder(repo)
    await f.pick(repo.id)
    expect(repo.icon).toBeUndefined()
    expect(repo.iconChecked).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it("never replaces an icon you chose or removed, even one chosen while it looked", async () => {
    const dir = await repoWith({ 'public/favicon.svg': SVG })
    const chosen = { ...repoAt(dir), icon: { kind: 'emoji' as const, value: '🚀' } }
    await finder(chosen).icons.pick(chosen.id)
    expect(chosen.icon).toEqual({ kind: 'emoji', value: '🚀' })

    const removed = { ...repoAt(dir), iconChecked: true }
    const r = finder(removed)
    await r.icons.pick(removed.id)
    expect(removed.icon).toBeUndefined()
    expect(r.changed).not.toHaveBeenCalled()

    const racing = repoAt(dir)
    const ask = vi.fn(async () => {
      racing.icon = { kind: 'lucide', name: 'Rocket' }
      return '1 Code'
    })
    await finder(racing, { ask }).icons.pick(racing.id)
    expect(racing.icon).toEqual({ kind: 'lucide', name: 'Rocket' })
    expect(racing.iconChecked).toBeUndefined()
  })

  it('scales a large picture down, and passes over one it cannot store', async () => {
    const big = png(1024, 1024, 100_000)
    const dir = await repoWith({ 'build/icon.png': big })
    const scaled = repoAt(dir)
    const shrink = vi.fn(async () => 'data:image/png;base64,c21hbGw=')
    await finder(scaled, { shrink }).icons.pick(scaled.id)
    expect(shrink).toHaveBeenCalledWith({ bytes: big, type: 'image/png' }, 64)
    expect(scaled.icon).toEqual({ kind: 'image', dataUrl: 'data:image/png;base64,c21hbGw=' })

    const unscaled = repoAt(dir)
    await finder(unscaled).icons.pick(unscaled.id)
    expect(unscaled.icon).toBeUndefined()
  })

  it("gives the picker the likeliest file at full size", async () => {
    const dir = await repoWith({ 'build/icon.png': png(512, 512), 'README.md': 'x\n' })
    expect(await finder(repoAt(dir)).icons.detectFile(repoAt(dir))).toBe(`data:image/png;base64,${png(512, 512).toString('base64')}`)
    const none = await repoWith({ 'README.md': 'x\n' })
    expect(await finder(repoAt(none)).icons.detectFile(repoAt(none))).toBeNull()
  })
})

describe('githubOrgAvatar', () => {
  const answer = (bytes: Buffer) => vi.fn(async () => new Response(new Uint8Array(bytes)))
  const repoJson = (type: string) => async () => JSON.stringify({ owner: { type, avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' } })

  it("takes an organisation's uploaded avatar at icon size", async () => {
    const fetchFn = answer(png(64, 64))
    const got = await githubOrgAvatar('acme/app', repoJson('Organization'), fetchFn as unknown as typeof fetch)
    expect(got?.type).toBe('image/png')
    expect(fetchFn).toHaveBeenCalledWith('https://avatars.githubusercontent.com/u/1?v=4&s=64', expect.anything())
  })

  it("skips GitHub's generated default and a person's own avatar", async () => {
    expect(await githubOrgAvatar('acme/app', repoJson('Organization'), answer(png(420, 420)) as unknown as typeof fetch)).toBeNull()
    const fetchFn = answer(png(64, 64))
    expect(await githubOrgAvatar('me/app', repoJson('User'), fetchFn as unknown as typeof fetch)).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('gitlabProjectAvatar', () => {
  it("takes the project's avatar with the token, and none when the project has none", async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array(png(64, 64)), { headers: { 'content-type': 'image/png' } }))
    const got = await gitlabProjectAvatar(new GitlabApi(normalizeGitlabHost('gitlab.com'), 'glpat-x', fetchFn as unknown as typeof fetch), 'acme/app')
    expect(got?.type).toBe('image/png')
    expect(fetchFn).toHaveBeenCalledWith('https://gitlab.com/api/v4/projects/acme%2Fapp/avatar', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer glpat-x' }) }))

    const missing = vi.fn(async () => new Response('{"message":"404 Avatar Not Found"}', { status: 404 }))
    expect(await gitlabProjectAvatar(new GitlabApi(normalizeGitlabHost('gitlab.com'), 'glpat-x', missing as unknown as typeof fetch), 'acme/app')).toBeNull()
  })
})
