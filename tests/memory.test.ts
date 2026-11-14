// The memory repository service (docs/ai-employees.md §4) against real git repositories: reading the tree, files and
// their history; a person's edit with compare-and-set; the path, size, secret and sensitive-path refusals; a run's staged
// changes becoming one commit with its trailers; intents and their settling after a crash; foreign commits and uncommitted
// changes and accepting them; the search index; recaps; the manifest after a rename; and the migrations behind it.
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryPathProblem, parseTrailers } from '../src/shared/memory'
import type { Organization } from '../src/shared/organizations'
import { secretLines } from '../src/shared/reportProblem'
import type { Repo } from '../src/shared/types'
import { ForemanDb, SCHEMA_VERSION } from '../src/main/db'
import { git, gitOut } from '../src/main/git'
import { MemoryRefused, MemoryService } from '../src/main/memory'
import { createMemoryRepository, OrganizationService } from '../src/main/organizations'
import { defaultSettings, type PersistedState } from '../src/main/store'
import { commit, tempDir } from './helpers'

// Built at run time, so no scanner mistakes the test for a leaked credential.
const FAKE_TOKEN = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('')

const opened: ForemanDb[] = []
afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close()
    } catch {
      // Already closed by the test.
    }
  }
})

async function rig() {
  const parent = await tempDir('foreman-memory-')
  const root = await createMemoryRepository(parent, 'acme-memory', 'Acme')
  const dbFile = path.join(await tempDir('foreman-memory-db-'), 'foreman.db')
  const open = () => {
    const db = new ForemanDb(dbFile)
    opened.push(db)
    return db
  }
  let db = open()
  const repo = { id: 'mem', name: 'acme-memory', rootPath: root, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: '2026-11-01T00:00:00.000Z', spaceId: 'o1' } as unknown as Repo
  const org: Organization = { id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: '2026-11-05T00:00:00.000Z' }
  const state = { repos: [repo], organizations: [org], settings: defaultSettings() } as unknown as PersistedState
  const rigState = { sensitive: [] as string[], changes: 0, fault: undefined as undefined | ((step: string) => void) }
  const make = () =>
    new MemoryService({
      state: () => state,
      db: () => db,
      sensitivePaths: () => rigState.sensitive,
      changed: () => void rigState.changes++,
      fault: (step) => rigState.fault?.(step)
    })
  const reopen = () => {
    db.close()
    db = open()
    return make()
  }
  return { root, state, org, repo, rig: rigState, memory: make(), make, reopen, db: () => db }
}

const head = (root: string) => gitOut(root, ['rev-parse', 'HEAD'])
const blobAt = (root: string, file: string) => gitOut(root, ['rev-parse', `HEAD:${file}`])
const message = (root: string, ref = 'HEAD') => gitOut(root, ['log', '-1', '--format=%B', ref])
const clean = async (root: string) => (await gitOut(root, ['status', '--porcelain'])) === ''

/** A commit made outside Foreman: a collaborator's, or an edit in another tool. */
async function foreignCommit(root: string, file: string, text: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
  await git(root, ['add', '-A'])
  await commit(root, `Outside: ${file}`)
}

describe('memory: the shared rules', () => {
  it('lets a write stay inside memory/, bots/ and repos/, away from git’s own files', () => {
    expect(memoryPathProblem('memory/org/PROJECT.md')).toBeNull()
    expect(memoryPathProblem('bots/e-7k2m.toml')).toBeNull()
    expect(memoryPathProblem('repos/site/settings.toml')).toBeNull()
    expect(memoryPathProblem('memory/bots/.gitkeep')).toBeNull()
    expect(memoryPathProblem('')).toBe('empty')
    expect(memoryPathProblem('/etc/passwd')).toBe('absolute')
    expect(memoryPathProblem('C:/Windows/x')).toBe('absolute')
    expect(memoryPathProblem('memory/../../x')).toBe('parent')
    expect(memoryPathProblem('memory/./x')).toBe('parent')
    expect(memoryPathProblem('memory/.git/config')).toBe('git')
    expect(memoryPathProblem('memory/org/.gitattributes')).toBe('git')
    expect(memoryPathProblem('.git/config')).toBe('git')
    expect(memoryPathProblem('memory\\org\\x.md')).toBe('invalid')
    expect(memoryPathProblem('memory//x.md')).toBe('invalid')
    expect(memoryPathProblem('memory/x.md.')).toBe('invalid')
    expect(memoryPathProblem('README.md')).toBe('outside')
    expect(memoryPathProblem('.foreman-memory.json')).toBe('outside')
    expect(memoryPathProblem('notes/x.md')).toBe('outside')
    expect(memoryPathProblem('memory')).toBe('outside')
  })

  it('finds secret-shaped values by line, but not commit ids', () => {
    expect(secretLines(`one\ntoken = ${FAKE_TOKEN}\n`)).toEqual([2])
    expect(secretLines('Fixed in 3f2a9c1d7e5b4a6f8c0d2e4f6a8b0c1d3e5f7a9b, see the log.')).toEqual([])
    expect(secretLines('Plain notes about the launch.')).toEqual([])
  })

  it('reads trailers', () => {
    expect(parseTrailers('Foreman-Run: r1\nForeman-Task: t 1\n')).toEqual([
      { key: 'Foreman-Run', value: 'r1' },
      { key: 'Foreman-Task', value: 't 1' }
    ])
  })
})

describe('memory: reading', () => {
  it('lists the tree, reads a file with its blob and the head, and gives its history', async () => {
    const { root, memory } = await rig()
    const tree = await memory.tree('o1')
    expect(tree.head).toBe(await head(root))
    const paths = tree.entries.map((e) => e.path)
    expect(paths).toEqual(expect.arrayContaining(['memory/org/PROJECT.md', 'memory/org/decisions.md', 'memory/org/instructions.md', 'bots/.gitkeep', 'repos/.gitkeep']))
    // Only the three folders: the README and the manifest aren't memory.
    expect(paths).not.toContain('README.md')
    expect(paths).not.toContain('.foreman-memory.json')

    const file = await memory.read('o1', 'memory/org/PROJECT.md')
    expect(file).toMatchObject({ path: 'memory/org/PROJECT.md', head: tree.head, blob: await blobAt(root, 'memory/org/PROJECT.md'), binary: false, tooLarge: false })
    expect(file.text).toContain('# Acme')
    expect(await memory.read('o1', 'memory/org/missing.md')).toMatchObject({ blob: null, binary: false })

    const history = await memory.history('o1', 'memory/org/PROJECT.md')
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ commit: tree.head, author: 'Test', subject: 'Create the acme-memory memory repository', trailers: [] })
  })

  it('refuses for an organization without a memory repository', async () => {
    const on = await rig()
    delete on.org.memoryRepoId
    await expect(on.memory.status('o1')).rejects.toThrow('Acme has no memory repository')
    await expect(on.memory.search('o1', 'goals')).rejects.toThrow('Acme has no memory repository')
  })
})

describe('memory: a person’s edit', () => {
  it('commits at once as git’s user with Foreman-Edited-By, against the version opened; a changed file is a conflict with both versions', async () => {
    const { root, memory, db } = await rig()
    const before = await memory.read('o1', 'memory/org/PROJECT.md')
    const saved = await memory.writeAsPerson('o1', 'memory/org/PROJECT.md', '# Acme\n\nShip the launch.\n', before.blob)
    expect(saved).toMatchObject({ ok: true, commit: await head(root), blob: await blobAt(root, 'memory/org/PROJECT.md') })
    expect(await readFile(path.join(root, 'memory/org/PROJECT.md'), 'utf8')).toBe('# Acme\n\nShip the launch.\n')
    expect(await clean(root)).toBe(true)
    expect(await gitOut(root, ['log', '-1', '--format=%an|%cn|%s'])).toBe('Test|Test|Edit memory/org/PROJECT.md')
    expect(await message(root)).toContain('Foreman-Edited-By: person')
    expect(await memory.status('o1')).toEqual({ state: 'ok', head: await head(root) })

    // Still holding the first version: someone saved in between.
    const stale = await memory.writeAsPerson('o1', 'memory/org/PROJECT.md', '# Acme\n\nMine.\n', before.blob)
    expect(stale).toEqual({ ok: false, conflict: { blob: await blobAt(root, 'memory/org/PROJECT.md'), text: '# Acme\n\nShip the launch.\n' } })
    expect(await readFile(path.join(root, 'memory/org/PROJECT.md'), 'utf8')).toBe('# Acme\n\nShip the launch.\n')
    expect(db().memoryMutations('o1').map((r) => r.state)).toEqual(['committed', 'conflict'])

    // A new file: null means it must not exist yet.
    expect(await memory.writeAsPerson('o1', 'memory/org/docs/launch.md', 'Plan\n', null)).toMatchObject({ ok: true })
    expect(await memory.writeAsPerson('o1', 'memory/org/docs/launch.md', 'Again\n', null)).toMatchObject({ ok: false, conflict: { text: 'Plan\n' } })
  })

  it('refuses paths outside the folders, git’s files, secrets, sensitive paths and files over the cap, with a reason', async () => {
    const { memory, rig: r, root } = await rig()
    const start = await head(root)
    const refused = async (file: string, text: string) => {
      try {
        await memory.writeAsPerson('o1', file, text, null)
      } catch (err) {
        expect(err).toBeInstanceOf(MemoryRefused)
        return (err as MemoryRefused).reason
      }
      return 'written'
    }
    expect(await refused('../outside.md', 'x')).toBe('path')
    expect(await refused('README.md', 'x')).toBe('path')
    expect(await refused('memory/.git/hooks/pre-commit', 'x')).toBe('path')
    expect(await refused('notes/x.md', 'x')).toBe('path')
    expect(await refused('memory/org/keys.md', `The deploy key: ${FAKE_TOKEN}\n`)).toBe('secret')
    // A private key's armour, built here so no scanner takes the test for a leak.
    expect(await refused('memory/org/keys.md', `Notes\n${['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ')}\nb3Blbg==\n`)).toBe('secret')
    expect(await refused('memory/org/big.md', 'x'.repeat(256 * 1024 + 1))).toBe('size')
    r.sensitive = ['memory/private/']
    expect(await refused('memory/private/notes.md', 'x')).toBe('sensitive')
    expect(await head(root)).toBe(start)
  })
})

describe('memory: a run’s staged changes', () => {
  it('stages changes, shows them to the run, and commits them once with the run’s trailers', async () => {
    const { root, memory } = await rig()
    const start = await head(root)
    const a = await memory.stage('o1', 'r1', { kind: 'write', path: 'memory/bots/e-1/notes.md', text: 'First note\n', expectedBlob: null })
    expect(a.ok).toBe(true)
    await memory.stage('o1', 'r1', { kind: 'append', path: 'memory/org/decisions.md', text: '\n## 2026-11-13\n\nShip on Monday.\n' })
    // Nothing committed yet, but the run reads its own changes, with the version it can compare against.
    expect(await head(root)).toBe(start)
    expect(await memory.read('o1', 'memory/bots/e-1/notes.md')).toMatchObject({ blob: null })
    const seen = await memory.read('o1', 'memory/bots/e-1/notes.md', { runId: 'r1' })
    expect(seen).toMatchObject({ text: 'First note\n', blob: a.ok ? a.blob : 'x' })
    // A second write against what the run read.
    expect(await memory.stage('o1', 'r1', { kind: 'write', path: 'memory/bots/e-1/notes.md', text: 'Second note\n', expectedBlob: seen.blob })).toMatchObject({ ok: true })
    expect(await memory.stage('o1', 'r1', { kind: 'write', path: 'memory/bots/e-1/notes.md', text: 'Stale\n', expectedBlob: seen.blob })).toMatchObject({ ok: false, conflict: { text: 'Second note\n' } })
    expect(memory.stagedChanges('o1', 'r1')).toHaveLength(3)

    const done = await memory.commitRun('o1', 'r1', { author: { name: 'Max', email: 'e-1@employees.foreman' }, trailers: { employee: 'e-1', task: 't1' } })
    expect(done.commit).toBe(await head(root))
    expect(await gitOut(root, ['rev-list', '--count', `${start}..HEAD`])).toBe('1')
    expect(await gitOut(root, ['log', '-1', '--format=%an|%ae|%cn'])).toBe('Max|e-1@employees.foreman|Foreman')
    const body = await message(root)
    expect(body).toContain('Foreman-Employee: e-1')
    expect(body).toContain('Foreman-Run: r1')
    expect(body).toContain('Foreman-Task: t1')
    expect(await readFile(path.join(root, 'memory/bots/e-1/notes.md'), 'utf8')).toBe('Second note\n')
    expect(await readFile(path.join(root, 'memory/org/decisions.md'), 'utf8')).toContain('Ship on Monday.')
    expect(await clean(root)).toBe(true)
    expect(memory.stagedChanges('o1', 'r1')).toEqual([])
    // History names who learned it, for which run and task.
    const history = await memory.history('o1', 'memory/bots/e-1/notes.md')
    expect(history[0].trailers).toEqual([
      { key: 'Foreman-Employee', value: 'e-1' },
      { key: 'Foreman-Run', value: 'r1' },
      { key: 'Foreman-Task', value: 't1' }
    ])
    // Nothing staged: nothing to commit.
    expect(await memory.commitRun('o1', 'r2')).toEqual({ commit: null })
  })

  it('discards a run’s changes without committing, keeping them to read back', async () => {
    const { root, memory } = await rig()
    const start = await head(root)
    await memory.stage('o1', 'r1', { kind: 'write', path: 'memory/bots/e-1/idea.md', text: 'An idea\n' })
    const row = await memory.discardRun('o1', 'r1')
    expect(row).toMatchObject({ state: 'refused', detail: { reason: 'discarded', changes: [{ path: 'memory/bots/e-1/idea.md', text: 'An idea\n' }] } })
    expect(await memory.commitRun('o1', 'r1')).toEqual({ commit: null })
    expect(await head(root)).toBe(start)
    expect(memory.runMutations('o1', 'r1').map((r) => r.state)).toEqual(['refused'])
  })

  it('keeps a run’s changes on a conflict when the file moved on before the commit', async () => {
    const { root, memory, db } = await rig()
    const read = await memory.read('o1', 'memory/org/PROJECT.md', { runId: 'r1' })
    await memory.stage('o1', 'r1', { kind: 'write', path: 'memory/org/PROJECT.md', text: 'From the run\n', expectedBlob: read.blob })
    await memory.writeAsPerson('o1', 'memory/org/PROJECT.md', 'From the person\n', read.blob)
    const out = await memory.commitRun('o1', 'r1', { trailers: { employee: 'e-1' } })
    expect(out).toMatchObject({ commit: null, conflict: { path: 'memory/org/PROJECT.md', text: 'From the person\n' } })
    expect(await readFile(path.join(root, 'memory/org/PROJECT.md'), 'utf8')).toBe('From the person\n')
    const row = db().memoryMutations('o1').find((r) => r.runId === 'r1')!
    expect(row).toMatchObject({ state: 'conflict', detail: { conflictPath: 'memory/org/PROJECT.md', changes: [{ text: 'From the run\n' }] } })
  })

  it('writes a recap: RECAP.md replaced and an entry added to the journal, in the run’s commit', async () => {
    const { root, memory } = await rig()
    await memory.writeRecap('o1', 'e-1', 'r1', 'Drafted the launch post.', new Date('2026-11-13T09:30:00Z'))
    await memory.writeRecap('o1', 'e-1', 'r1', 'Then the changelog.', new Date('2026-11-13T10:00:00Z'))
    await memory.commitRun('o1', 'r1', { trailers: { employee: 'e-1', task: 't1' } })
    expect(await readFile(path.join(root, 'memory/bots/e-1/RECAP.md'), 'utf8')).toBe('Then the changelog.\n')
    expect(await readFile(path.join(root, 'memory/bots/e-1/journal.md'), 'utf8')).toBe(
      '# Journal\n\n## 2026-11-13 09:30 · r1\n\nDrafted the launch post.\n\n## 2026-11-13 10:00 · r1\n\nThen the changelog.\n'
    )
    await expect(memory.writeRecap('o1', '../x', 'r1', 'x')).rejects.toThrow('Invalid employee id')
  })

  it('leaves out the recap or the journal entry a run already wrote itself, and knows every path a run wrote across checkpoints', async () => {
    const { root, memory } = await rig()
    await memory.stage('o1', 'r1', { kind: 'write', path: 'memory/bots/e-1/RECAP.md', text: 'My own recap.\n' })
    await memory.commitRun('o1', 'r1', { trailers: { employee: 'e-1' } })
    await memory.stage('o1', 'r1', { kind: 'append', path: 'memory/bots/e-1/notes.md', text: 'n\n' })
    expect([...memory.runWrittenPaths('o1', 'r1')].sort()).toEqual(['memory/bots/e-1/RECAP.md', 'memory/bots/e-1/notes.md'])
    await memory.writeRecap('o1', 'e-1', 'r1', 'Foreman’s recap.', new Date('2026-11-13T09:30:00Z'), { recap: false })
    await memory.commitRun('o1', 'r1', { trailers: { employee: 'e-1' } })
    expect(await readFile(path.join(root, 'memory/bots/e-1/RECAP.md'), 'utf8')).toBe('My own recap.\n')
    expect(await readFile(path.join(root, 'memory/bots/e-1/journal.md'), 'utf8')).toContain('Foreman’s recap.')
  })
})

describe('memory: an employee’s proposals', () => {
  it('files a proposal without writing, lists it, and keeps it as the person’s commit with who proposed it', async () => {
    const { root, memory, db } = await rig()
    const before = await head(root)
    const out = await memory.propose('o1', 'r1', { kind: 'append', path: 'memory/org/PROJECT.md', text: '- We ship on Thursdays.\n' }, { employeeId: 'e-1', taskId: 't1', why: 'Organization files are proposals.' })
    expect(out).toMatchObject({ ok: true })
    const id = (out as { id: string }).id
    // Nothing written, nothing staged for the run, and the run's reads don't see it.
    expect(await head(root)).toBe(before)
    expect(memory.stagedChanges('o1', 'r1')).toEqual([])
    expect((await memory.read('o1', 'memory/org/PROJECT.md', { runId: 'r1' })).text ?? '').not.toContain('Thursdays')
    expect(memory.proposals('o1')).toEqual([{ id, orgId: 'o1', path: 'memory/org/PROJECT.md', kind: 'append', text: '- We ship on Thursdays.\n', employeeId: 'e-1', runId: 'r1', taskId: 't1', why: 'Organization files are proposals.', createdAt: expect.any(String) }])
    const kept = await memory.keepProposal('o1', id)
    expect(kept).toMatchObject({ ok: true, commit: await head(root) })
    expect(await readFile(path.join(root, 'memory/org/PROJECT.md'), 'utf8')).toContain('- We ship on Thursdays.\n')
    const trailers = parseTrailers(await gitOut(root, ['log', '-1', '--format=%(trailers:only,unfold)']))
    expect(trailers).toEqual([
      { key: 'Foreman-Proposed-By', value: 'e-1' },
      { key: 'Foreman-Run', value: 'r1' },
      { key: 'Foreman-Task', value: 't1' },
      { key: 'Foreman-Kept-By', value: 'person' }
    ])
    // A person's commit: git's configured user, not the employee.
    expect(await gitOut(root, ['log', '-1', '--format=%an'])).not.toContain('Foreman')
    expect(memory.proposals('o1')).toEqual([])
    expect(db().memoryMutation(id)!.state).toBe('committed')
    await expect(memory.keepProposal('o1', id)).rejects.toThrow('already kept')
    expect(await clean(root)).toBe(true)
  })

  it('retires a proposal without writing; a write proposal against a version keeps waiting when the file moved on', async () => {
    const { root, memory, db } = await rig()
    const a = await memory.propose('o1', 'r1', { kind: 'append', path: 'memory/org/decisions.md', text: '- Use bun.\n' }, { employeeId: 'e-1' })
    const id = (a as { id: string }).id
    const before = await head(root)
    await memory.retireProposal('o1', id)
    expect(await head(root)).toBe(before)
    expect(db().memoryMutation(id)).toMatchObject({ state: 'refused', detail: { reason: 'retired' } })
    await expect(memory.retireProposal('o1', id)).rejects.toThrow('already retired')
    // A write against the version it read: refused now if already stale, and kept waiting if it goes stale before Keep.
    await memory.writeAsPerson('o1', 'memory/org/docs/plan.md', 'v1\n', null)
    const v1 = await blobAt(root, 'memory/org/docs/plan.md')
    expect(await memory.propose('o1', 'r1', { kind: 'write', path: 'memory/org/docs/plan.md', text: 'x\n', expectedBlob: 'f'.repeat(40) }, { employeeId: 'e-1' })).toMatchObject({ ok: false, conflict: { blob: v1, text: 'v1\n' } })
    const w = await memory.propose('o1', 'r1', { kind: 'write', path: 'memory/org/docs/plan.md', text: 'v2 from e-1\n', expectedBlob: v1 }, { employeeId: 'e-1' })
    await memory.writeAsPerson('o1', 'memory/org/docs/plan.md', 'v1, edited\n', v1)
    const out = await memory.keepProposal('o1', (w as { id: string }).id)
    expect(out).toMatchObject({ ok: false, path: 'memory/org/docs/plan.md', conflict: { text: 'v1, edited\n' } })
    expect(memory.proposals('o1').map((p) => p.id)).toEqual([(w as { id: string }).id])
    expect(await readFile(path.join(root, 'memory/org/docs/plan.md'), 'utf8')).toBe('v1, edited\n')
    // Proposals are checked as any write is: a secret is refused, not filed.
    await expect(memory.propose('o1', 'r1', { kind: 'append', path: 'memory/org/PROJECT.md', text: `token ${FAKE_TOKEN}\n` }, { employeeId: 'e-1' })).rejects.toThrow(/looks like a key or token/)
  })

  it('puts a proposal Foreman closed in the middle of keeping back to waiting', async () => {
    const { root, reopen, db } = await rig()
    const now = new Date().toISOString()
    db().putMemoryMutation({ id: 'p1', orgId: 'o1', runId: 'r1', state: 'committing', expectedHead: await head(root), commitId: null, paths: ['memory/org/PROJECT.md'], detail: { changes: [{ kind: 'append', path: 'memory/org/PROJECT.md', text: 'x\n' }], proposal: { employeeId: 'e-1' } }, createdAt: now, updatedAt: now })
    const again = reopen()
    await again.status('o1')
    expect(db().memoryMutation('p1')).toMatchObject({ state: 'proposed', expectedHead: null })
    expect(again.proposals('o1').map((p) => p.id)).toEqual(['p1'])
    expect(again.stagedChanges('o1', 'r1')).toEqual([])
  })
})

describe('memory: intents and starting again', () => {
  it('records the intent before git, and settles a commit Foreman closed in the middle of on the next start', async () => {
    const { root, memory, rig: r, reopen, db } = await rig()
    const start = await head(root)
    await memory.stage('o1', 'r1', { kind: 'write', path: 'memory/bots/e-1/notes.md', text: 'Learned\n' })
    expect(db().memoryMutations('o1')).toMatchObject([{ runId: 'r1', state: 'staged', paths: ['memory/bots/e-1/notes.md'] }])
    // Foreman closes after the branch moved and before the folder and the row caught up.
    r.fault = (step) => {
      if (step === 'after-ref') throw new Error('closed')
    }
    await expect(memory.commitRun('o1', 'r1', { trailers: { employee: 'e-1' } })).rejects.toThrow('closed')
    r.fault = undefined
    const [open] = db().memoryMutations('o1')
    expect(open).toMatchObject({ state: 'committing', expectedHead: start })
    expect(open.commitId).toBe(await head(root))
    expect(existsSync(path.join(root, 'memory/bots/e-1/notes.md'))).toBe(false)

    const again = reopen()
    expect(await again.status('o1')).toEqual({ state: 'ok', head: open.commitId })
    expect(db().memoryMutations('o1')).toMatchObject([{ state: 'committed', commitId: open.commitId }])
    expect(db().memoryBaseline('o1')).toBe(open.commitId)
    expect(await readFile(path.join(root, 'memory/bots/e-1/notes.md'), 'utf8')).toBe('Learned\n')
    expect(await clean(root)).toBe(true)
  })

  it('settles such a commit on the same process’s next operation too, never treating it as not made', async () => {
    const { root, memory, rig: r, db } = await rig()
    r.fault = () => {
      throw new Error('folder step failed')
    }
    await expect(memory.writeAsPerson('o1', 'memory/org/docs/a.md', 'A\n', null)).rejects.toThrow('folder step failed')
    r.fault = undefined
    const landed = await head(root)
    expect(db().memoryMutations('o1')).toMatchObject([{ state: 'committing', commitId: landed }])
    expect(await memory.status('o1')).toEqual({ state: 'ok', head: landed })
    expect(db().memoryMutations('o1')).toMatchObject([{ state: 'committed', commitId: landed }])
    expect(await readFile(path.join(root, 'memory/org/docs/a.md'), 'utf8')).toBe('A\n')
  })

  it('puts a run’s changes back to staged, and refuses a person’s edit, when the commit never landed', async () => {
    const { root, reopen, db } = await rig()
    const now = new Date().toISOString()
    const base = { orgId: 'o1', expectedHead: await head(root), commitId: null, createdAt: now, updatedAt: now }
    db().putMemoryMutation({ ...base, id: 'm1', runId: 'r1', state: 'committing', paths: ['memory/x.md'], detail: { changes: [{ kind: 'write', path: 'memory/x.md', text: 'x' }] } })
    db().putMemoryMutation({ ...base, id: 'm2', runId: null, state: 'committing', paths: ['memory/y.md'], detail: { changes: [{ kind: 'write', path: 'memory/y.md', text: 'y' }] } })
    const again = reopen()
    await again.status('o1')
    expect(db().memoryMutation('m1')).toMatchObject({ state: 'staged', expectedHead: null })
    expect(db().memoryMutation('m2')).toMatchObject({ state: 'refused', detail: { reason: 'interrupted' } })
    expect(again.stagedChanges('o1', 'r1')).toEqual([{ kind: 'write', path: 'memory/x.md', text: 'x' }])
  })
})

describe('memory: foreign changes', () => {
  it('stops writing on a commit it didn’t make, lists it, and writes again once accepted', async () => {
    const { root, memory } = await rig()
    expect((await memory.status('o1')).state).toBe('ok')
    await foreignCommit(root, 'memory/org/docs/outside.md', 'Written elsewhere\n')
    const status = await memory.status('o1')
    expect(status).toMatchObject({ state: 'foreign', head: await head(root), dirty: [], moreCommits: 0, commits: [{ commit: await head(root), author: 'Test', subject: 'Outside: memory/org/docs/outside.md' }] })
    expect(memory.statuses()).toEqual({ o1: status })

    await expect(memory.writeAsPerson('o1', 'memory/org/x.md', 'x\n', null)).rejects.toMatchObject({ reason: 'foreign' })
    await memory.stage('o1', 'r1', { kind: 'write', path: 'memory/bots/e-1/a.md', text: 'a\n' })
    await expect(memory.commitRun('o1', 'r1')).rejects.toMatchObject({ reason: 'foreign' })
    expect(memory.stagedChanges('o1', 'r1')).toHaveLength(1)

    const outsideHead = await head(root)
    expect(await memory.acceptForeign('o1')).toEqual({ state: 'ok', head: outsideHead })
    // Accepting a commit makes none of its own; nothing was reset.
    expect(await head(root)).toBe(outsideHead)
    expect((await memory.commitRun('o1', 'r1')).commit).toBe(await head(root))
  })

  it('stops writing while the folder has uncommitted changes; accepting commits them as the person’s', async () => {
    const { root, memory } = await rig()
    await writeFile(path.join(root, 'memory/org/PROJECT.md'), '# Acme\n\nEdited in another editor.\n')
    await writeFile(path.join(root, 'memory/org/new.md'), 'New\n')
    const status = await memory.status('o1')
    expect(status).toMatchObject({ state: 'foreign', commits: [] })
    expect(status.state === 'foreign' && [...status.dirty].sort()).toEqual(['memory/org/PROJECT.md', 'memory/org/new.md'])
    await expect(memory.writeAsPerson('o1', 'memory/org/x.md', 'x\n', null)).rejects.toMatchObject({ reason: 'foreign' })
    // Nothing of theirs was touched.
    expect(await readFile(path.join(root, 'memory/org/new.md'), 'utf8')).toBe('New\n')

    const before = await head(root)
    expect(await memory.acceptForeign('o1')).toEqual({ state: 'ok', head: await head(root) })
    expect(await head(root)).not.toBe(before)
    expect(await gitOut(root, ['log', '-1', '--format=%an|%s'])).toBe('Test|Accept changes made outside Foreman')
    expect(await message(root)).toContain('Foreman-Accepted-By: person')
    expect(await clean(root)).toBe(true)
    expect(await memory.writeAsPerson('o1', 'memory/org/x.md', 'x\n', null)).toMatchObject({ ok: true })
  })

  it('is unavailable on another branch, and accepting says why', async () => {
    const { root, memory } = await rig()
    await git(root, ['checkout', '-q', '-b', 'elsewhere'])
    expect(await memory.status('o1')).toEqual({ state: 'unavailable', reason: 'branch', branch: 'main' })
    await expect(memory.acceptForeign('o1')).rejects.toMatchObject({ reason: 'unavailable' })
  })
})

describe('memory: the search index', () => {
  it('finds text at the head after commits and after the head moves outside Foreman, and survives being emptied', async () => {
    const { root, memory, db } = await rig()
    const hits = await memory.search('o1', 'goals')
    expect(hits.map((h) => h.path)).toEqual(['memory/org/PROJECT.md'])
    expect(hits[0].blob).toBe(await blobAt(root, 'memory/org/PROJECT.md'))
    expect(hits[0].snippet).toContain('\u0001goals\u0002')
    expect(typeof hits[0].rank).toBe('number')

    await memory.writeAsPerson('o1', 'memory/org/docs/animals.md', 'The zebra crossing plan.\n', null)
    expect((await memory.search('o1', 'zebra')).map((h) => h.path)).toEqual(['memory/org/docs/animals.md'])
    // Only what is at the head: an earlier version's words are gone.
    await memory.writeAsPerson('o1', 'memory/org/docs/animals.md', 'Now about giraffes.\n', await blobAt(root, 'memory/org/docs/animals.md'))
    expect(await memory.search('o1', 'zebra')).toEqual([])

    await foreignCommit(root, 'memory/org/docs/outside.md', 'An okapi appeared.\n')
    expect((await memory.search('o1', 'okapi')).map((h) => h.path)).toEqual(['memory/org/docs/outside.md'])

    db().clearMemoryIndex()
    expect((await memory.search('o1', 'giraff')).map((h) => h.path)).toEqual(['memory/org/docs/animals.md'])
    expect(await memory.search('o1', '  ')).toEqual([])
  })

  it('finds nothing a run’s read would refuse: files outside the memory folders, or under sensitive paths', async () => {
    const { root, memory, rig: r } = await rig()
    await foreignCommit(root, 'NOTES.md', 'A secret quokka.\n')
    await foreignCommit(root, 'memory/private/plan.md', 'Another quokka.\n')
    await memory.acceptForeign('o1')
    r.sensitive = ['memory/private/']
    expect(await memory.search('o1', 'quokka')).toEqual([])
    await expect(memory.read('o1', 'memory/private/plan.md', { runId: 'r1' })).rejects.toMatchObject({ reason: 'sensitive' })
    // A person reading it in the Memory view still can.
    expect((await memory.read('o1', 'memory/private/plan.md')).text).toBe('Another quokka.\n')
  })

  it('returns at most ten results', async () => {
    const { memory } = await rig()
    for (let i = 0; i < 12; i++) await memory.stage('o1', 'r1', { kind: 'write', path: `memory/org/docs/n${i}.md`, text: `common word ${i}\n` })
    await memory.commitRun('o1', 'r1')
    expect(await memory.search('o1', 'common')).toHaveLength(10)
  })
})

describe('memory: the manifest', () => {
  it('names the organization again after a rename, as Foreman’s own commit', async () => {
    const { root, state, memory } = await rig()
    let pending: Promise<unknown> = Promise.resolve()
    const organizations = new OrganizationService({
      state: () => state,
      addRepo: async () => {
        throw new Error('not used')
      },
      changed: () => undefined,
      organizationChanged: (id) => {
        pending = memory.syncManifest(id)
      }
    })
    organizations.rename('o1', 'Acme Labs')
    await pending
    const manifest = JSON.parse(await gitOut(root, ['show', 'HEAD:.foreman-memory.json'])) as Record<string, unknown>
    expect(manifest).toEqual({ schema: 1, organization: 'Acme Labs' })
    expect(await gitOut(root, ['log', '-1', '--format=%an|%cn'])).toBe('Foreman|Foreman')
    expect(await clean(root)).toBe(true)
    // Current already: nothing more.
    expect(await memory.syncManifest('o1')).toBeNull()
    expect((await memory.status('o1')).state).toBe('ok')
  })
})

describe('memory: foreman.db', () => {
  it('creates the memory tables on a new database and on one from before them', async () => {
    const file = path.join(await tempDir('foreman-memory-db-'), 'foreman.db')
    const tables = (db: ForemanDb) => (db.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'memory_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
    const want = ['memory_docs', 'memory_fts', 'memory_heads', 'memory_mutations']
    const fresh = new ForemanDb(file)
    expect(tables(fresh).filter((n) => want.includes(n))).toEqual(want)
    expect((fresh.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    // A database from the version before: the two memory migrations not yet applied (nor the four employee work ones after them).
    fresh.db.exec('DROP TABLE memory_fts; DROP TABLE memory_docs; DROP TABLE memory_mutations; DROP TABLE memory_heads;')
    fresh.db.exec('DROP TABLE employee_actions; DROP TABLE employee_roots; DROP TABLE employee_questions; DROP TABLE employee_runs; DROP TABLE employee_task_transitions; DROP TABLE employee_tasks;')
    fresh.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 6}`)
    fresh.close()
    const upgraded = new ForemanDb(file)
    opened.push(upgraded)
    expect(tables(upgraded).filter((n) => want.includes(n))).toEqual(want)
    upgraded.putMemoryDoc('o1', 'memory/a.md', 'b1', 'hello world')
    expect(upgraded.searchMemory('o1', '"hello"', 10)).toMatchObject([{ path: 'memory/a.md', blob: 'b1' }])
    upgraded.putMemoryDoc('o1', 'memory/a.md', 'b2', 'goodbye')
    expect(upgraded.searchMemory('o1', '"hello"', 10)).toEqual([])
    upgraded.deleteMemoryDoc('o1', 'memory/a.md')
    expect(upgraded.searchMemory('o1', '"goodbye"', 10)).toEqual([])
  })
})
