import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnRequest } from '../src/main/agents/types'
import { run } from '../src/main/cliServer'
import { git } from '../src/main/git'
import { blobSha, readRepoTemplates, revalidateRepoTemplates } from '../src/main/repoTemplates'
import { defaultSettings } from '../src/main/store'
import { findLayeredTemplate, layeredTemplates, parseRepoTemplate, parseRepoTemplateId, qualifiedName, templateById } from '../src/shared/repoTemplates'
import type { Repo, Workspace } from '../src/shared/types'
import { stubHost } from './cliHost'
import { makeRepo } from './helpers'
import { fakeDriver, setupSessions } from './sessionHarness'

afterEach(() => registerDriver(claudeDriver))

const RELEASE = `---
name: Release checklist
startModel: claude/claude-opus-4-5 high
followUp:
  title: Draft release notes
  prompt: "Draft the release notes from the changelog."
---
Bump the version for {{version}}, update CHANGELOG and run e2e.
`

async function repoWithTemplates(files: Record<string, string>) {
  const dir = await makeRepo()
  await mkdir(path.join(dir, '.foreman', 'templates'), { recursive: true })
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, '.foreman', 'templates', name), content)
  return dir
}

describe('repo template files', () => {
  it('reads name, body, start model and follow-up from frontmatter', () => {
    const t = parseRepoTemplate('r1', '.foreman/templates/release-checklist.md', RELEASE, 'abc')!
    expect(t).toMatchObject({
      id: 'repo:r1:release-checklist',
      name: 'Release checklist',
      source: 'repo',
      rev: 'abc',
      startModel: { agent: 'claude', model: 'claude-opus-4-5', effort: 'high' },
      followUp: { title: 'Draft release notes', prompt: 'Draft the release notes from the changelog.' }
    })
    expect(t.body).toBe('Bump the version for {{version}}, update CHANGELOG and run e2e.')
    expect(parseRepoTemplateId(t.id)).toEqual({ repoId: 'r1', slug: 'release-checklist' })
  })

  it('names a file with no frontmatter after the file and skips empty ones', () => {
    expect(parseRepoTemplate('r', '.foreman/templates/dependency-audit.md', 'Run npm outdated.', 'x')).toMatchObject({ name: 'Dependency audit', body: 'Run npm outdated.' })
    expect(parseRepoTemplate('r', '.foreman/templates/empty.md', '---\nname: Empty\n---\n', 'x')).toBeNull()
  })

  it('grants no permissions: unknown and permission-like keys are dropped', () => {
    const t = parseRepoTemplate('r', 'a.md', '---\nname: Sneaky\npermissions: bypass\napprovalPolicy: never\nstartModel: nonsense/model\n---\nDo it.', 'x')!
    expect(Object.keys(t).sort()).toEqual(['body', 'file', 'id', 'name', 'repoId', 'rev', 'source'])
  })

  it('reads a repo folder, with the blob SHA git itself gives', async () => {
    const dir = await repoWithTemplates({ 'release-checklist.md': RELEASE, 'notes.txt': 'ignored', 'dependency-audit.md': 'Audit.' })
    const found = readRepoTemplates('r1', dir)
    expect(found.map((t) => t.name)).toEqual(['Dependency audit', 'Release checklist'])
    const expected = (await git(dir, ['hash-object', '.foreman/templates/release-checklist.md'])).stdout.trim()
    expect(found[1].rev).toBe(expected)
    expect(blobSha(Buffer.from(RELEASE))).toBe(expected)
    // A changed file changes the revision.
    await writeFile(path.join(dir, '.foreman/templates/release-checklist.md'), `${RELEASE}\nMore.`)
    expect(readRepoTemplates('r1', dir)[1].rev).not.toBe(expected)
    expect(readRepoTemplates('r2', path.join(dir, 'nowhere'))).toEqual([])
  })

  it('with maxAgeMs, reuses a recent listing without the disk, and looks again once it is older or revalidated', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-27T10:00:00Z'))
      const dir = await repoWithTemplates({ 'a.md': 'First.' })
      const file = path.join(dir, '.foreman/templates/b.md')
      expect(readRepoTemplates('cached', dir, { maxAgeMs: 3000 }).map((t) => t.body)).toEqual(['First.'])
      await writeFile(file, 'Second.')
      // Inside the window the last answer stands: the folder isn't listed again.
      vi.setSystemTime(new Date('2026-10-27T10:00:02Z'))
      expect(readRepoTemplates('cached', dir, { maxAgeMs: 3000 }).map((t) => t.body)).toEqual(['First.'])
      // A fresh read (anything that acts on a template) always looks.
      expect(readRepoTemplates('cached', dir).map((t) => t.body)).toEqual(['First.', 'Second.'])
      await writeFile(file, 'Third.')
      vi.setSystemTime(new Date('2026-10-27T10:00:04Z'))
      expect(readRepoTemplates('cached', dir, { maxAgeMs: 3000 }).map((t) => t.body)).toEqual(['First.', 'Second.'])
      // Past the window, the edit made outside Foreman shows.
      vi.setSystemTime(new Date('2026-10-27T10:00:08Z'))
      expect(readRepoTemplates('cached', dir, { maxAgeMs: 3000 }).map((t) => t.body)).toEqual(['First.', 'Third.'])
      await writeFile(file, 'Fourth.')
      revalidateRepoTemplates()
      expect(readRepoTemplates('cached', dir, { maxAgeMs: 3000 }).map((t) => t.body)).toEqual(['First.', 'Fourth.'])
      // A repo without the folder is remembered as empty too, and a moved root is looked at at once.
      expect(readRepoTemplates('none', path.join(dir, 'nowhere'), { maxAgeMs: 3000 })).toEqual([])
      expect(readRepoTemplates('none', dir, { maxAgeMs: 3000 })).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('layers', () => {
  const personal = [{ id: 'p1', name: 'Release checklist', body: 'mine' }, { id: 'p2', name: 'Fix a bug', body: 'x' }]
  const repo = [
    parseRepoTemplate('r1', '.foreman/templates/release-checklist.md', 'theirs', 'aaa')!,
    parseRepoTemplate('r1', '.foreman/templates/dependency-audit.md', 'audit', 'bbb')!
  ]

  it('personal wins a bare name; the repo one is qualified and reachable', () => {
    expect(findLayeredTemplate(personal, repo, 'release-checklist')).toMatchObject({ template: { id: 'p1' } })
    expect(findLayeredTemplate(personal, repo, 'repo:release-checklist')).toMatchObject({ template: { body: 'theirs' } })
    expect(findLayeredTemplate(personal, repo, 'dependency-audit')).toMatchObject({ template: { body: 'audit' } })
    expect(layeredTemplates(personal, repo).map((e) => e.label)).toEqual(['Release checklist', 'Fix a bug', 'repo:release-checklist', 'Dependency audit'])
    expect(qualifiedName(repo[1], personal)).toBe('Dependency audit')
  })

  it('a partial name that fits both layers is ambiguous and says how to qualify', () => {
    const result = findLayeredTemplate([{ id: 'p', name: 'Audit logs', body: 'x' }], repo, 'audit')
    expect(result).toEqual({ error: '“audit” matches several templates: audit-logs, repo:dependency-audit' })
    expect(findLayeredTemplate(personal, repo, 'repo:nothing')).toMatchObject({ error: expect.stringContaining('No repo template') })
  })

  it('finds a template by id in either layer', () => {
    expect(templateById(personal, { r1: repo }, 'repo:r1:dependency-audit')?.rev).toBe('bbb')
    expect(templateById(personal, { r1: repo }, 'p2')?.name).toBe('Fix a bug')
    expect(templateById(personal, {}, 'repo:r1:dependency-audit')).toBeUndefined()
  })
})

describe('foreman run with a repo template', () => {
  it('uses the repo template of the repo it runs in, and personal wins a clash', async () => {
    const dir = await repoWithTemplates({ 'release-checklist.md': RELEASE, 'dependency-audit.md': 'Audit {{what}}.' })
    const repo = { id: 'r1', name: 'app', rootPath: dir } as Repo
    const created: unknown[] = []
    const settings = defaultSettings()
    settings.promptTemplates = [{ id: 'mine', name: 'Release checklist', body: 'My {{version}} checklist' }]
    const host = stubHost({
      state: () => ({ repos: [repo], workspaces: [], sessions: [], settings }),
      createWorkspace: async (_id, options) => (created.push(options), { id: 'w', name: 'n', branch: 'b', path: '/tmp/x' } as Workspace),
      setupOutcome: async () => ({ failed: false, held: false, logTail: '' })
    })
    const base = { values: ['1.2'], cwd: dir, noWait: true }
    expect((await run(host, { ...base, template: 'release-checklist' })).prompt).toBe('My 1.2 checklist')
    expect(await run(host, { ...base, template: 'repo:release-checklist' })).toMatchObject({ template: 'Release checklist', prompt: 'Bump the version for 1.2, update CHANGELOG and run e2e.' })
    expect(await run(host, { ...base, template: 'dependency-audit', values: ['deps'] })).toMatchObject({ prompt: 'Audit deps.' })
    expect(created[1]).toMatchObject({ templateId: 'repo:r1:release-checklist' })
  })
})

describe('sends record the repo revision', () => {
  it('stamps the user message with the file revision and nothing else about permissions', async () => {
    const dir = await repoWithTemplates({ 'release-checklist.md': RELEASE })
    const [template] = readRepoTemplates('repo', dir)
    const prompts: TurnRequest[] = []
    registerDriver(fakeDriver(async (req, cb) => (prompts.push(req), cb.finished({ ok: true }))))
    const h = await setupSessions({ template: (id) => (id === template.id ? template : undefined) })
    await h.sessions.send(h.session.id, 'Bump for 2.0', { templateId: template.id })
    await vi.waitFor(async () => expect(h.session.status).toBe('idle'))
    const user = (await h.store.readChat(h.session.id)).find((i) => i.kind === 'user')
    expect(user).toMatchObject({ repoTemplate: { name: 'Release checklist', rev: template.rev }, followUp: { templateId: template.id, title: 'Draft release notes' } })
  })
})
