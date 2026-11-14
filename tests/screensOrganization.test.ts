// The screenshot fixture's organization (main/screensOrganization.ts), which the demo seeds too, read back through the
// app's own services: the employees are approved and unchanged, the work is where the fixture left it, and Foreman
// starting on it (recovery, the memory service) moves nothing.
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { gitOut } from '../src/main/git'
import { seedScreens } from '../src/main/screenshots'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { tempDir } from './helpers'

vi.mock('electron', () => ({ nativeTheme: {} }))

const cores: Core[] = []
afterEach(() => {
  for (const core of cores.splice(0)) core.employeeWork.stopTimer()
})

async function seeded() {
  const root = await tempDir('foreman-screens-org-')
  const dataDir = path.join(root, 'data')
  const fixture = await seedScreens(root, dataDir)
  const store = new Store(dataDir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), { available: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() })
  const core = new Core(store, secrets, {
    broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
  })
  core.attention.stop()
  cores.push(core)
  return { fixture, store, core }
}

describe('the fixture’s organization', () => {
  it('reads back through the app: Acme with its memory repository and the site, two approved employees and a draft', async () => {
    const { fixture, store, core } = await seeded()
    const org = fixture.organization
    expect(store.state.organizations?.map((o) => o.name)).toEqual(['Acme'])
    // atlas and beacon stay in Personal, so every other screen looks as it did.
    expect(store.state.repos.map((r) => [r.name, r.spaceId ?? null])).toEqual([['atlas', null], ['beacon', null], ['acme-memory', org.orgId], ['site', org.orgId]])
    await core.memory.start()
    await core.employees.refreshAll()
    expect(core.snapshot().memory?.[org.orgId]).toMatchObject({ state: 'ok' })
    const employees = core.snapshot().employees?.[org.orgId]?.employees ?? []
    expect(employees.map((e) => [e.name, e.role, e.colour, e.state, e.changed, e.problems])).toEqual([
      ['Ada', 'Researcher', 'pink', 'active', false, []],
      ['Lin', 'Triage', 'teal', 'draft', false, []],
      ['Max', 'Writer', 'orange', 'active', false, []]
    ])
    expect(employees.find((e) => e.name === 'Max')?.triggers).toHaveLength(1)
  }, 120_000)

  it('has its work where the fixture left it, and starting Foreman on it moves nothing', async () => {
    const { fixture, core } = await seeded()
    const org = fixture.organization
    core.employeeActions.recover()
    core.employeeWork.recover()
    const view = core.employeeWork.views()[org.orgId]
    // Not over: Ada's question; each employee's last result; Max's push held for a person; Ada's proposal.
    expect(view.tasks.map((t) => [t.title, t.state, t.question?.question])).toEqual([['Which day does 2.4 launch?', 'waiting', 'Which day does Atlas 2.4 launch?']])
    expect(view.runs).toEqual([])
    expect(view.last[fixture.organization.employeeId]).toMatchObject({ title: 'Write the Atlas 2.4 launch post', closureReason: 'done' })
    expect((view.actions ?? []).map((a) => [a.kind, a.state, a.payload.kind === 'push' ? a.payload.branch : ''])).toEqual([['push', 'held', 'max/launch-2.4']])
    expect(view.proposals.map((p) => p.path)).toEqual(['memory/org/PROJECT.md'])
    // The hand-off: Max's task and the one he handed Ada are one chain.
    const tasks = await core.api.listEmployeeTasks(org.orgId)
    expect(tasks.find((t) => t.title === 'List what changed in Atlas since 2.3')).toMatchObject({ rootId: 'task-launch', requestedBy: { name: 'Max' }, closureReason: 'done' })
    // The push's preview is the run's workspace's real head.
    const ws = core.snapshot().workspaces.find((w) => w.id === org.employeeWorkspaceId)!
    expect(view.actions?.[0]?.payload).toMatchObject({ head: (await gitOut(ws.path!, ['rev-parse', 'HEAD'])).trim(), workspaceId: org.employeeWorkspaceId })
    expect(ws.startedBy).toMatchObject({ via: 'employee', employeeId: org.employeeId })
  }, 120_000)

  it('commits each run’s memory as its employee, with the run and the task', async () => {
    const { fixture, core } = await seeded()
    const history = await core.memory.history(fixture.organization.orgId, 'memory/bots/e-max1/RECAP.md')
    expect(history[0]).toMatchObject({ author: 'Max', subject: 'Recap: Write the Atlas 2.4 launch post' })
    expect(history[0].trailers).toEqual(expect.arrayContaining([{ key: 'Foreman-Employee', value: 'e-max1' }, { key: 'Foreman-Run', value: 'run-max-2' }, { key: 'Foreman-Task', value: 'task-launch' }]))
  }, 120_000)
})
