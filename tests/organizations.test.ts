// Personal and organizations (docs/ai-employees.md §3 and §4): the shared rules (names, spaces, memory repository
// choices, what the sidebar shows), the service behind the API (each memory choice, the seeded memory repository and its
// one commit, moving, deleting, exclusivity, the switch), and state.json with and without organizations.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  currentSpace,
  defaultMemoryName,
  memoryChoices,
  moveRefusal,
  organizationNameProblem,
  parseOrganizations,
  reconcileSpaces,
  reposInSpace,
  snapshotInSpace,
  spaceOf,
  spacesOn,
  type Organization
} from '../src/shared/organizations'
import type { AppSnapshot, Repo, Workspace } from '../src/shared/types'
import { gitOut } from '../src/main/git'
import { memoryRepositoryFiles, OrganizationService } from '../src/main/organizations'
import { defaultSettings, Store, type PersistedState } from '../src/main/store'
import { tempDir } from './helpers'

const repo = (id: string, extra: Partial<Repo> = {}): Repo =>
  ({ id, name: id, rootPath: `/code/${id}`, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: '2026-11-01T00:00:00.000Z', ...extra }) as Repo
const org = (id: string, name: string, memoryRepoId?: string): Organization => ({ id, name, ...(memoryRepoId ? { memoryRepoId } : {}), createdAt: '2026-11-05T00:00:00.000Z' })

describe('organizations: the shared rules', () => {
  it('names the memory repository after the organization', () => {
    expect(defaultMemoryName('Foreman')).toBe('foreman-memory')
    expect(defaultMemoryName('  Acme Labs, Inc. ')).toBe('acme-labs-inc-memory')
    expect(defaultMemoryName('Café Crème')).toBe('cafe-creme-memory')
    // A name with no letters a folder can take still gets a usable one.
    expect(defaultMemoryName('中文')).toBe('organization-memory')
  })

  it('wants a name that is there, short enough and not taken (ignoring case), except by the organization itself', () => {
    const orgs = [org('o1', 'Foreman')]
    expect(organizationNameProblem('  ', orgs)).toBe('empty')
    expect(organizationNameProblem('x'.repeat(61), orgs)).toBe('long')
    expect(organizationNameProblem(' foreman ', orgs)).toBe('taken')
    expect(organizationNameProblem('FOREMAN', orgs, 'o1')).toBeNull()
    expect(organizationNameProblem('XYZ', orgs)).toBeNull()
  })

  it('splits repositories into spaces once an organization is made', () => {
    expect(spacesOn([])).toBe(false)
    expect(spacesOn(undefined)).toBe(false)
    expect(spacesOn([org('o1', 'A')])).toBe(true)
  })

  it('puts a repository with no space, or a space that is gone, in Personal', () => {
    const orgs = [org('o1', 'A')]
    expect(spaceOf(repo('a'), orgs)).toBeNull()
    expect(spaceOf(repo('b', { spaceId: 'o1' }), orgs)).toBe('o1')
    expect(spaceOf(repo('c', { spaceId: 'gone' }), orgs)).toBeNull()
    expect(reposInSpace([repo('a'), repo('b', { spaceId: 'o1' }), repo('c', { spaceId: 'gone' })], orgs, null).map((r) => r.id)).toEqual(['a', 'c'])
    expect(currentSpace(orgs, 'o1')).toBe('o1')
    expect(currentSpace(orgs, 'gone')).toBeNull()
    expect(currentSpace(orgs, null)).toBeNull()
  })

  it('shows one space in the sidebar, its memory repository first, and everything before any organization exists', () => {
    const repos = [repo('blog'), repo('site', { spaceId: 'o1' }), repo('foreman-memory', { spaceId: 'o1' }), repo('xyz', { spaceId: 'o2' })]
    const workspaces = [{ id: 'w1', repoId: 'blog' }, { id: 'w2', repoId: 'site' }, { id: 'w3', repoId: 'xyz' }] as Workspace[]
    const organizations = [org('o1', 'Foreman', 'foreman-memory'), org('o2', 'XYZ')]
    const snapshot = { repos, workspaces, organizations, settings: defaultSettings() } as unknown as AppSnapshot
    const personal = snapshotInSpace(snapshot, null)
    expect(personal.repos.map((r) => r.id)).toEqual(['blog'])
    expect(personal.workspaces.map((w) => w.id)).toEqual(['w1'])
    const foreman = snapshotInSpace(snapshot, 'o1')
    expect(foreman.repos.map((r) => r.id)).toEqual(['foreman-memory', 'site'])
    expect(foreman.workspaces.map((w) => w.id)).toEqual(['w2'])
    // An organization that is gone shows Personal.
    expect(snapshotInSpace(snapshot, 'gone').repos.map((r) => r.id)).toEqual(['blog'])
    // No organization yet: the sidebar as it always was, every repository.
    const none = { ...snapshot, organizations: [] } as AppSnapshot
    expect(snapshotInSpace(none, null)).toBe(none)
  })

  it('offers Personal and its own repositories as a memory repository, and says why not for the rest', () => {
    const repos = [repo('blog'), repo('xyz-memory', { spaceId: 'o2' }), repo('xyz-ui', { spaceId: 'o2' }), repo('acme-memory'), repo('site', { spaceId: 'o1' })]
    const organizations = [org('o1', 'Foreman'), org('o2', 'XYZ', 'xyz-memory')]
    const forNew = memoryChoices(repos, organizations)
    expect(forNew.map((c) => [c.repo.id, c.refusal ?? null])).toEqual([
      ['acme-memory', null],
      ['blog', null],
      ['xyz-memory', { kind: 'memory-of', organization: 'XYZ' }],
      ['xyz-ui', { kind: 'in-space', organization: 'XYZ' }],
      ['site', { kind: 'in-space', organization: 'Foreman' }]
    ])
    // Foreman's own repositories are offered to Foreman.
    expect(memoryChoices(repos, organizations, 'o1').find((c) => c.repo.id === 'site')?.refusal).toBeUndefined()
    // A memory repository stays in its organization.
    expect(moveRefusal('xyz-memory', null, organizations)).toEqual({ kind: 'memory-of', organization: 'XYZ' })
    expect(moveRefusal('xyz-memory', 'o2', organizations)).toBeNull()
    expect(moveRefusal('xyz-ui', 'o1', organizations)).toBeNull()
  })

  it('reads organizations entry by entry and brings spaces into agreement', () => {
    const parsed = parseOrganizations([org('o1', 'A', 'mem'), { id: 'o1', name: 'again', createdAt: 'x' }, { id: 'o2', name: '' }, null, 'x', org('o3', 'B', 'mem'), org('o4', 'C', 'missing')])
    expect(parsed.map((o) => o.id)).toEqual(['o1', 'o3', 'o4'])
    expect(parseOrganizations('nope')).toEqual([])
    const repos = [repo('mem'), repo('lost', { spaceId: 'gone' }), repo('kept', { spaceId: 'o3' })]
    reconcileSpaces(parsed, repos)
    // The memory repository is its organization's, in its space; the second claim and the missing repository are let go.
    expect(parsed.map((o) => o.memoryRepoId)).toEqual(['mem', undefined, undefined])
    expect(repos.map((r) => r.spaceId)).toEqual(['o1', undefined, 'o3'])
  })
})

/** A service over plain state: addRepo registers the folder the way WorkspaceService does (in Personal). */
function rig(options: { repos?: Repo[]; organizations?: Organization[] } = {}) {
  const state = { repos: options.repos ?? [], organizations: options.organizations ?? [], settings: defaultSettings() } as unknown as PersistedState
  let changes = 0
  const service = new OrganizationService({
    state: () => state,
    addRepo: async (dir) => {
      const added = repo(`r-${path.basename(dir)}`, { name: path.basename(dir), rootPath: dir })
      state.repos.push(added)
      return added
    },
    changed: () => void changes++
  })
  return { state, service, changes: () => changes }
}

describe('organizations: the service', () => {
  it('creates one with a new memory repository, seeded and committed once, and brings repositories from Personal', async () => {
    const parent = await tempDir('foreman-org-')
    const { state, service, changes } = rig({ repos: [repo('foreman'), repo('website'), repo('blog')] })
    const created = await service.create({ name: ' Foreman ', memory: { kind: 'create', name: 'foreman-memory', parentDir: parent }, repoIds: ['foreman', 'website'] })
    expect(created.name).toBe('Foreman')
    expect(state.organizations).toEqual([created])
    const dir = path.join(parent, 'foreman-memory')
    const memory = state.repos.find((r) => r.rootPath === dir)!
    expect(created.memoryRepoId).toBe(memory.id)
    expect(state.repos.map((r) => [r.name, r.spaceId ?? null])).toEqual([
      ['foreman', created.id],
      ['website', created.id],
      ['blog', null],
      ['foreman-memory', created.id]
    ])
    expect(changes()).toBeGreaterThan(0)

    // The layout of docs/ai-employees.md §4, in one commit.
    for (const file of Object.keys(memoryRepositoryFiles('Foreman'))) expect(existsSync(path.join(dir, ...file.split('/'))), file).toBe(true)
    for (const file of ['README.md', 'memory/org/PROJECT.md', 'memory/org/decisions.md', 'memory/org/instructions.md', 'memory/bots/.gitkeep', 'bots/.gitkeep', 'repos/.gitkeep', '.foreman-memory.json']) {
      expect(existsSync(path.join(dir, ...file.split('/'))), file).toBe(true)
    }
    expect(JSON.parse(await readFile(path.join(dir, '.foreman-memory.json'), 'utf8'))).toEqual({ schema: 1, organization: 'Foreman' })
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toContain('memory repository of the Foreman organization')
    expect(await gitOut(dir, ['log', '--format=%s'])).toBe('Create the foreman-memory memory repository')
    expect((await gitOut(dir, ['status', '--porcelain'])).trim()).toBe('')
    expect((await gitOut(dir, ['ls-files'])).split('\n').sort()).toEqual(Object.keys(memoryRepositoryFiles('Foreman')).sort())
  })

  it('creates one with an existing repository from Personal as its memory, moving it in', async () => {
    const { state, service } = rig({ repos: [repo('notes'), repo('app')] })
    const created = await service.create({ name: 'Acme', memory: { kind: 'existing', repoId: 'notes' }, repoIds: [] })
    expect(created.memoryRepoId).toBe('notes')
    expect(state.repos.map((r) => r.spaceId ?? null)).toEqual([created.id, null])
  })

  it('creates one that decides later: it only groups repositories', async () => {
    const { state, service } = rig({ repos: [repo('app')] })
    const created = await service.create({ name: 'Later Inc', memory: { kind: 'later' }, repoIds: ['app'] })
    expect(created.memoryRepoId).toBeUndefined()
    expect(state.repos[0].spaceId).toBe(created.id)
  })

  it('refuses a second organization of the same name, before making anything on disk', async () => {
    const parent = await tempDir('foreman-org-')
    const { state, service } = rig({ organizations: [org('o1', 'Foreman')] })
    await expect(service.create({ name: 'foreman', memory: { kind: 'create', name: 'foreman-memory', parentDir: parent }, repoIds: [] })).rejects.toThrow(/already an organization named foreman/)
    await expect(service.create({ name: '   ', memory: { kind: 'later' }, repoIds: [] })).rejects.toThrow(/name/)
    expect(existsSync(path.join(parent, 'foreman-memory'))).toBe(false)
    expect(state.organizations).toHaveLength(1)
  })

  it('never lets one memory repository serve two organizations', async () => {
    const { state, service } = rig({ repos: [repo('xyz-memory', { spaceId: 'o2' }), repo('xyz-ui', { spaceId: 'o2' })], organizations: [org('o2', 'XYZ', 'xyz-memory')] })
    await expect(service.create({ name: 'Foreman', memory: { kind: 'existing', repoId: 'xyz-memory' }, repoIds: [] })).rejects.toThrow(/XYZ’s memory repository/)
    // Nor a repository another organization holds, as memory or brought along.
    await expect(service.create({ name: 'Foreman', memory: { kind: 'existing', repoId: 'xyz-ui' }, repoIds: [] })).rejects.toThrow(/is in XYZ/)
    await expect(service.create({ name: 'Foreman', memory: { kind: 'later' }, repoIds: ['xyz-ui'] })).rejects.toThrow(/is in XYZ, not Personal/)
    expect(state.organizations).toHaveLength(1)
    // A repository that is already a memory repository can't be given to another organization later either.
    const later = await service.create({ name: 'Foreman', memory: { kind: 'later' }, repoIds: [] })
    await expect(service.setMemory(later.id, { kind: 'existing', repoId: 'xyz-memory' })).rejects.toThrow(/XYZ’s memory repository/)
  })

  it('refuses a memory repository name Quick start would refuse, or no folder', async () => {
    const { service } = rig()
    await expect(service.create({ name: 'A', memory: { kind: 'create', name: 'bad name!', parentDir: await tempDir() }, repoIds: [] })).rejects.toThrow(/letters, numbers/)
    await expect(service.create({ name: 'A', memory: { kind: 'create', name: 'a-memory', parentDir: '' }, repoIds: [] })).rejects.toThrow(/folder/)
    await expect(service.create({ name: 'A', memory: { kind: 'nonsense' } as never, repoIds: [] })).rejects.toThrow(/Invalid organization/)
  })

  it('moves a repository between spaces, but keeps a memory repository in its organization', async () => {
    const { state, service } = rig({ repos: [repo('mem', { spaceId: 'o1' }), repo('app')], organizations: [org('o1', 'Foreman', 'mem'), org('o2', 'XYZ')] })
    service.moveRepo('app', 'o2')
    expect(state.repos[1].spaceId).toBe('o2')
    service.moveRepo('app', null)
    expect(state.repos[1].spaceId).toBeUndefined()
    expect(() => service.moveRepo('mem', null)).toThrow(/stays in Foreman/)
    expect(() => service.moveRepo('mem', 'o2')).toThrow(/stays in Foreman/)
    expect(() => service.moveRepo('app', 'gone')).toThrow(/Organization not found/)
    expect(() => service.moveRepo('nope', null)).toThrow(/Repository not found/)
  })

  it('renames, with the same rules as creating', () => {
    const { service } = rig({ organizations: [org('o1', 'Foreman'), org('o2', 'XYZ')] })
    expect(service.rename('o1', '  Foreman Labs ').name).toBe('Foreman Labs')
    expect(() => service.rename('o1', 'xyz')).toThrow(/already an organization/)
    expect(() => service.rename('o1', '')).toThrow(/name/)
  })

  it('deletes an organization: its repositories, the memory repository too, go back to Personal and stay registered', async () => {
    const parent = await tempDir('foreman-org-')
    const { state, service } = rig({ repos: [repo('app')] })
    const created = await service.create({ name: 'Foreman', memory: { kind: 'create', name: 'foreman-memory', parentDir: parent }, repoIds: ['app'] })
    service.delete(created.id)
    expect(state.organizations).toEqual([])
    expect(state.repos.map((r) => [r.name, r.spaceId ?? null])).toEqual([
      ['app', null],
      ['foreman-memory', null]
    ])
    expect(existsSync(path.join(parent, 'foreman-memory', 'README.md'))).toBe(true)
  })

  it('gives an organization that decided later a memory repository, once', async () => {
    const parent = await tempDir('foreman-org-')
    const { state, service } = rig({ repos: [repo('app')] })
    const created = await service.create({ name: 'Acme', memory: { kind: 'later' }, repoIds: [] })
    const updated = await service.setMemory(created.id, { kind: 'create', name: 'acme-memory', parentDir: parent })
    const memory = state.repos.find((r) => r.name === 'acme-memory')!
    expect(updated.memoryRepoId).toBe(memory.id)
    expect(memory.spaceId).toBe(created.id)
    await expect(service.setMemory(created.id, { kind: 'existing', repoId: 'app' })).rejects.toThrow(/already has a memory repository/)
  })

  it('lets go of a memory repository removed from Foreman', () => {
    const { state, service, changes } = rig({ repos: [repo('mem', { spaceId: 'o1' })], organizations: [org('o1', 'Foreman', 'mem')] })
    service.repoRemoved('other')
    expect(changes()).toBe(0)
    service.repoRemoved('mem')
    expect(state.organizations![0].memoryRepoId).toBeUndefined()
    expect(changes()).toBe(1)
  })
})

describe('organizations in state.json', () => {
  async function load(contents: Record<string, unknown>) {
    const dir = await tempDir('foreman-orgs-')
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 2, settings: {}, ...contents }))
    const store = new Store(dir)
    await store.load()
    return { store, dir }
  }

  it('starts with none, and every repository in Personal', async () => {
    const { store } = await load({ repos: [repo('app')] })
    expect(store.state.organizations).toEqual([])
    expect(store.state.repos[0].spaceId).toBeUndefined()
    store.close()
  })

  it('reads organizations and spaces back as they were saved, and saves them again', async () => {
    const organizations = [org('o1', 'Foreman', 'mem')]
    const { store, dir } = await load({ organizations, repos: [repo('mem', { spaceId: 'o1' }), repo('app', { spaceId: 'o1' }), repo('blog')] })
    expect(store.state.organizations).toEqual(organizations)
    expect(store.state.repos.map((r) => r.spaceId ?? null)).toEqual(['o1', 'o1', null])
    store.state.organizations!.push(org('o2', 'XYZ'))
    store.close()
    const saved = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) as PersistedState
    expect(saved.organizations?.map((o) => o.id)).toEqual(['o1', 'o2'])
    expect(saved.repos.map((r) => r.spaceId ?? null)).toEqual(['o1', 'o1', null])
  })

  it('lets go of the old Experimental switch (organizations made while it was on or off are kept), and drops what points nowhere', async () => {
    const { store } = await load({ settings: { aiEmployees: false }, organizations: [org('o1', 'Foreman', 'missing'), { name: 'no id' }], repos: [repo('app', { spaceId: 'o1' }), repo('old', { spaceId: 'gone' })] })
    expect(store.state.settings).not.toHaveProperty('aiEmployees')
    expect(store.state.organizations).toEqual([org('o1', 'Foreman')])
    expect(store.state.repos.map((r) => r.spaceId ?? null)).toEqual(['o1', null])
    store.close()
  })
})
