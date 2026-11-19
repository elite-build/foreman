// docs/ai-employees.md §15: what a project waits on reaches the person away from its channel: the tray and dock count it,
// and each new one is a notification (the phone's push follows every notify) that opens the channel, and Slack's "needs me".
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import type { TrayView } from '../src/shared/attention'
import type { Project } from '../src/shared/projects'
import type { MainEvent } from '../src/shared/types'
import { tempDir } from './helpers'

afterEach(() => vi.restoreAllMocks())

const at = '2026-11-19T10:00:00.000Z'

function project(waits: Project['waits']): Project {
  return { id: 'p1', orgId: 'acme', slug: 'new-sidebar', title: 'New sidebar', requirement: 'A new sidebar', repoId: 'site', pmId: 'pri', phase: 'planning', plans: [], parts: {}, replans: 0, steps: [], artifacts: {}, waits, decisions: [], notes: [], createdAt: at, updatedAt: at }
}

async function setup() {
  const dir = await tempDir('foreman-project-alerts-')
  const store = new Store(dir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const events: MainEvent[] = []
  const badges: number[] = []
  const core = new Core(store, secrets, {
    broadcast: (event) => events.push(event), applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async () => {}, openExternal: async () => {}, setBadge: (n) => badges.push(n), setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
  })
  core.attention.stop()
  store.state.settings.dockBadge = true
  store.state.organizations = [{ id: 'acme', name: 'Acme', createdAt: at }]
  const notices = () => events.filter((e): e is Extract<MainEvent, { type: 'notify' }> => e.type === 'notify')
  return { core, store, notices, badges }
}

describe('a project’s waits away from its channel', () => {
  it('are counted with the tray and badge, and each new one is a notification that opens the channel', async () => {
    const { core, store, notices, badges } = await setup()
    store.db.putProject(project([{ id: 'w1', kind: 'questions', since: at }]))
    // Launch: what already waits is counted, not told again.
    core.attention.observe()
    expect(notices()).toEqual([])
    expect(badges.at(-1)).toBe(1)
    const view: TrayView = core.attention.view()
    expect(view.attention).toEqual([expect.objectContaining({ name: '#new-sidebar', label: 'Priya has questions for you', channel: { orgId: 'acme', projectId: 'p1' } })])
    // The plan comes in: told once, as needing the person, naming the channel.
    store.db.putProject(project([{ id: 'w2', kind: 'plan', since: at }]))
    core.attention.observe()
    core.attention.observe()
    expect(notices()).toEqual([{ type: 'notify', workspaceId: '', sessionId: '', title: '#new-sidebar', body: 'Priya’s plan waits for your approval', kind: 'attention', project: { orgId: 'acme', id: 'p1' } }])
  })

  it('are told in the person’s language', async () => {
    const { core, store, notices } = await setup()
    store.state.settings.language = 'fr'
    core.attention.observe()
    store.db.putProject(project([{ id: 'w1', kind: 'questions', since: at }]))
    core.attention.observe()
    expect(notices().map((n) => n.body)).toEqual(['Priya a des questions pour vous'])
  })
})
