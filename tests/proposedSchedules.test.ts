// docs/agent-access.md §7: a schedule an outside agent proposes. It is checked as saving one is, saved paused with nothing
// approved, and nothing runs, re-pauses or resumes it until the user approves it, which records the fingerprint.
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { SCHEDULES_METHODS } from '../src/main/cli/schedules'
import { fingerprintOf, ScheduleService, type FingerprintInputs, type ScheduleInput } from '../src/main/schedules'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import type { SchedulesApproveResult } from '../src/shared/cli/schedules'
import type { Occurrence, Repo, Schedule, ScheduleRequest } from '../src/shared/types'
import { tempDir } from './helpers'

const LA = 'America/Los_Angeles'
const iso = (s: string) => Date.parse(s)
const input: ScheduleInput = { templateId: 't1', templateName: 'Dependency audit', repoId: 'r1', baseBranch: 'main', recurrence: 'weekly', startDate: '2026-10-20', weekdays: [1], time: '09:00', timezone: LA, agent: 'claude', model: 'claude-sonnet-5-5', maxMinutes: 30 }
const inputs: FingerprintInputs = { templateBody: 'npm outdated', setupScript: 'npm ci', checks: [{ name: 'test', command: 'npm test' }], mcp: [] }
const MON_9 = iso('2026-10-26T16:00:00Z')
const BY = { grantId: 'g-1', name: 'Claude Code' }

function rig() {
  const store = { state: {} as { schedules?: Schedule[]; occurrences?: Occurrence[] }, flush: vi.fn() }
  const clock = { now: iso('2026-10-20T12:00:00Z') }
  let current: FingerprintInputs | { error: string } = inputs
  const read = vi.fn(() => current)
  const launch = vi.fn(async () => undefined)
  const service = new ScheduleService({ store, now: () => clock.now, inputs: read, launch, stop: async () => undefined, changed: () => undefined })
  return { service, store, clock, read, launch, setInputs: (next: FingerprintInputs | { error: string }) => (current = next) }
}

describe('a proposed schedule (the service)', () => {
  it('validates as saving does, and saves it paused and proposed, with nothing approved', () => {
    const r = rig()
    expect(() => r.service.propose({ ...input, agent: 'codex' }, BY)).toThrow(/Claude only/)
    expect(() => r.service.propose({ ...input, timezone: 'Mars/Base' }, BY)).toThrow(/time zone/)
    expect(() => r.service.propose({ ...input, maxMinutes: 1 }, BY)).toThrow(/maximum duration/)
    expect(r.store.flush).not.toHaveBeenCalled()
    const s = r.service.propose(input, BY)
    expect(s).toMatchObject({ state: 'paused', pausedKind: 'proposed', proposedBy: BY, templateId: 't1', model: 'claude-sonnet-5-5', consecutiveFailures: 0 })
    expect(s.pausedReason).toBe('Proposed by Claude Code (outside agent). It runs nothing until you review and approve it.')
    expect(s.approved).toBeUndefined()
    expect(s.approvedAt).toBeUndefined()
    expect(s.nextRunAt).toBeUndefined()
    expect(r.store.state.schedules).toEqual([s])
    expect(r.store.flush).toHaveBeenCalledTimes(1)
  })

  it('never runs, re-pauses or resumes: tick and the fingerprint check skip it', async () => {
    const r = rig()
    const s = r.service.propose(input, BY)
    r.setInputs({ ...inputs, templateBody: 'changed' })
    r.clock.now = MON_9 + 1000
    await r.service.tick()
    expect(r.launch).not.toHaveBeenCalled()
    expect(r.read).not.toHaveBeenCalled()
    expect(s).toMatchObject({ state: 'paused', pausedKind: 'proposed' })
    expect(s.pausedReason).toMatch(/^Proposed by Claude Code/)
    // Its fingerprint check, called directly, neither reads nor pauses it again.
    expect(r.service['checkFingerprint'](s)).toBe(true)
    expect(r.read).not.toHaveBeenCalled()
    // Resuming, or pausing it as yours (which resume would then start), needs an approval.
    expect(() => r.service.resume(s.id)).toThrow(/proposed by an outside agent and hasn’t been approved/)
    expect(() => r.service.pause(s.id)).toThrow(/proposed by an outside agent/)
    expect(s.pausedKind).toBe('proposed')
  })

  it('runs once approved: the fingerprint recorded, active, and no longer a proposal', async () => {
    const r = rig()
    const s = r.service.propose(input, BY)
    r.service.approve(s.id, inputs)
    expect(s).toMatchObject({ state: 'active', approved: fingerprintOf(inputs), nextRunAt: new Date(MON_9).toISOString() })
    expect(s.approvedAt).toBeDefined()
    for (const key of ['pausedKind', 'pausedReason', 'proposedBy'] as const) expect(s[key]).toBeUndefined()
    r.clock.now = MON_9 + 1000
    await r.service.tick()
    await vi.waitFor(() => expect(r.launch).toHaveBeenCalledTimes(1))
  })

  it('is removed as any schedule is', () => {
    const r = rig()
    const s = r.service.propose(input, BY)
    r.service.remove(s.id)
    expect(r.store.state.schedules).toEqual([])
  })
})

describe('a proposed schedule (the core)', () => {
  async function coreWithRepo() {
    const dir = await tempDir('foreman-proposed-core-')
    const folder = await tempDir('foreman-proposed-repo-')
    const store = new Store(dir)
    await store.load()
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    const core = new Core(store, secrets, {
      broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
      openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
      metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
    })
    store.state.repos.push({ id: 'r1', name: 'foreman', rootPath: folder, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: new Date().toISOString() } as Repo)
    store.state.settings.promptTemplates = [{ id: 't-1', name: 'Nightly review', body: 'Review the last day of commits' }, { id: 't-2', name: 'Fix', body: 'Fix {{issue}}' }]
    const request: ScheduleRequest = { templateId: 't-1', templateName: 'Old name', repoId: 'r1', baseBranch: 'main', recurrence: 'daily', startDate: '2099-03-02', weekdays: [1], time: '09:00', timezone: 'Europe/London', agent: 'claude', model: 'claude-sonnet-5-5[1m]', maxMinutes: 30 }
    return { core, store, request, dir }
  }

  it('refuses what saving refuses, and saves the rest as a proposal that approveSchedule activates with its fingerprint', async () => {
    const { core, store, request } = await coreWithRepo()
    expect(() => core.proposeSchedule({ ...request, templateId: 't-2' }, BY)).toThrow(/placeholders/)
    expect(() => core.proposeSchedule({ ...request, templateId: 'nope' }, BY)).toThrow(/no longer exists/)
    expect(() => core.proposeSchedule({ ...request, flow: { flowId: 'x', flowSource: 'built-in', flowName: 'x', inputs: {} }, templateId: undefined }, BY)).toThrow(/Flows are off/)
    expect(store.state.schedules ?? []).toEqual([])
    const proposed = core.proposeSchedule(request, BY)
    // The template's name as it is now, as saving records it.
    expect(proposed).toMatchObject({ templateName: 'Nightly review', state: 'paused', pausedKind: 'proposed', proposedBy: BY })
    expect(proposed.approved).toBeUndefined()
    await expect(core.api.resumeSchedule(proposed.id)).rejects.toThrow(/hasn’t been approved/)
    const now = (await core.api.scheduleFingerprint(request)).fingerprint
    await core.api.approveSchedule(proposed.id, now)
    expect(store.state.schedules![0]).toMatchObject({ state: 'active', approved: now })
    expect(store.state.schedules![0].proposedBy).toBeUndefined()
  })

  it('keeps a proposal across a restart (state.json, no migration)', async () => {
    const { core, store, request, dir } = await coreWithRepo()
    const proposed = core.proposeSchedule(request, BY)
    store.flush()
    store.close()
    const again = new Store(dir)
    await again.load()
    expect(again.state.schedules).toEqual([expect.objectContaining({ id: proposed.id, state: 'paused', pausedKind: 'proposed', proposedBy: BY })])
    expect(again.state.schedules![0].approved).toBeUndefined()
    again.close()
  })

  it('`foreman schedules approve` previews a proposal without claiming it was approved before, then approves it', async () => {
    const { core, store, request } = await coreWithRepo()
    const proposed = core.proposeSchedule(request, BY)
    const host = { api: core.api, snapshot: () => core.snapshot(), state: () => store.state } as never
    const preview = await SCHEDULES_METHODS['schedules-approve'].handle(host, { id: proposed.id }, {} as never) as SchedulesApproveResult
    expect(preview).toMatchObject({ approved: false, needsConfirmation: true, changed: [] })
    expect(preview.text).toMatch(/^Proposed by Claude Code \(outside agent\)/)
    expect(preview.text).not.toMatch(/since you approved/)
    const done = await SCHEDULES_METHODS['schedules-approve'].handle(host, { id: proposed.id, shown: preview.preview!.fingerprint }, {} as never) as SchedulesApproveResult
    expect(done.approved).toBe(true)
    expect(store.state.schedules![0]).toMatchObject({ state: 'active' })
  })
})
