// A schedule that starts a flow instead of a template (docs/loops-and-graphs.md, "Running a flow"): the service keeps
// the flow and its inputs, its fingerprint covers the flow and its personas, its occurrence follows the flow run to its
// end and no duration limit applies; core refuses a flow that can't run unattended (or asks for a value nobody gave) and
// starts a due one through FlowService with the schedule's base branch, the approval it was saved on, and its origin.
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { revalidateRepoFlows } from '../src/main/flowFiles'
import type { FlowService } from '../src/main/flows'
import { revalidateRepoPersonas } from '../src/main/personaFiles'
import { changedParts, fingerprintOf, flowFingerprintFrom, ScheduleService, scheduleProblem, SHOWN_CHANGED, type FingerprintInputs, type LaunchHandle, type ScheduleDeps } from '../src/main/schedules'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { scheduleFingerprintOfFlow, type FlowFingerprint, type FlowRun } from '../src/shared/flows'
import { scheduleName } from '../src/shared/schedule'
import type { Occurrence, Schedule, ScheduleRequest } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'

afterEach(() => {
  vi.restoreAllMocks()
  revalidateRepoFlows()
  revalidateRepoPersonas()
})

const FLOW_FP: FlowFingerprint = { flow: 'f1', templates: 't1', setup: 's1', checks: 'c1', mcp: 'm1', personas: 'p1' }
const flowInputs = (fp: FlowFingerprint = FLOW_FP): FingerprintInputs => ({ templateBody: '', setupScript: '', checks: [], mcp: [], flow: fp })
const iso = (s: string) => Date.parse(s)

const request = (over: Partial<ScheduleRequest> = {}): ScheduleRequest => ({
  flow: { flowId: 'built-in:fix-until-green', flowSource: 'built-in', flowName: 'Fix until green', inputs: { task: 'Fix the flaky tests' } },
  repoId: 'r1', baseBranch: 'main', recurrence: 'daily', startDate: '2026-10-20', weekdays: [2], time: '13:00', timezone: 'UTC', agent: 'claude', model: '', maxMinutes: 30,
  ...over
})

function rig() {
  const store = { state: {} as { schedules?: Schedule[]; occurrences?: Occurrence[] }, flush: vi.fn() }
  const clock = { now: iso('2026-10-20T12:00:00Z') }
  let current: FingerprintInputs | { error: string } = flowInputs()
  const launches: { schedule: Schedule; occurrence: Occurrence; handle: LaunchHandle }[] = []
  const stopped: Occurrence[] = []
  const deps: ScheduleDeps = {
    store,
    now: () => clock.now,
    inputs: () => current,
    launch: async (schedule, occurrence, handle) => void launches.push({ schedule, occurrence, handle }),
    stop: async (o) => void stopped.push(o),
    turnStart: () => undefined,
    afterRun: vi.fn(),
    changed: vi.fn()
  }
  const service = new ScheduleService(deps)
  return { service, store, clock, launches, stopped, afterRun: deps.afterRun!, setInputs: (next: FingerprintInputs | { error: string }) => (current = next) }
}

describe('a schedule that runs a flow (the service)', () => {
  it('runs a template or a flow, one of the two; a flow takes no model but every input as text', () => {
    expect(scheduleProblem(request(), iso('2026-10-20T12:00:00Z'))).toBeNull()
    expect(scheduleProblem(request({ templateId: 't1', templateName: 'T' }), iso('2026-10-20T12:00:00Z'))).toMatch(/template or a flow/)
    expect(scheduleProblem(request({ flow: undefined }), iso('2026-10-20T12:00:00Z'))).toMatch(/template or a flow/)
    expect(scheduleProblem(request({ flow: { ...request().flow!, inputs: { task: 3 as unknown as string } } }), iso('2026-10-20T12:00:00Z'))).toMatch(/each of its inputs/)
    // A template still needs its Claude model.
    expect(scheduleProblem(request({ flow: undefined, templateId: 't1', templateName: 'T' }), iso('2026-10-20T12:00:00Z'))).toMatch(/Claude only/)
  })

  it('keeps the flow and its inputs, approved on the flow’s whole run approval, and names a changed flow or persona', () => {
    const r = rig()
    const s = r.service.create(request(), flowInputs())
    expect(s).toMatchObject({ flow: { flowId: 'built-in:fix-until-green', flowName: 'Fix until green', inputs: { task: 'Fix the flaky tests' } }, approved: { template: 't1', setup: 's1', checks: 'c1', mcp: 'm1', flow: 'f1', personas: 'p1' } })
    expect(s.templateId).toBeUndefined()
    expect(scheduleName(s)).toBe('Fix until green')
    expect(flowFingerprintFrom(s.approved!)).toEqual(FLOW_FP)
    expect(changedParts(s.approved!, fingerprintOf(flowInputs({ ...FLOW_FP, flow: 'f2', personas: 'p2' })))).toEqual(['the flow', 'its personas'])
    // A template schedule's fingerprint has neither part, so nothing reads as changed.
    const tpl = fingerprintOf({ templateBody: 'x', setupScript: '', checks: [], mcp: [] })
    expect(changedParts(tpl, tpl)).toEqual([])
    // Editing it into a template schedule drops the flow.
    const edited = r.service.update(s.id, request({ flow: undefined, templateId: 't1', templateName: 'Nightly', model: 'claude-sonnet-5-5' }), { templateBody: 'x', setupScript: '', checks: [], mcp: [] })
    expect(edited).toMatchObject({ templateId: 't1', templateName: 'Nightly' })
    expect(edited.flow).toBeUndefined()
  })

  it('pauses when the flow changed since it was approved, naming it', async () => {
    const r = rig()
    const s = r.service.create(request(), flowInputs())
    r.setInputs(flowInputs({ ...FLOW_FP, flow: 'edited' }))
    r.clock.now = iso('2026-10-20T13:00:30Z')
    await r.service.tick()
    expect(s).toMatchObject({ state: 'paused', pausedKind: 'changed', pausedReason: 'Paused: the flow changed. Review and re-approve to resume.' })
    expect(r.launches).toHaveLength(0)
  })

  it('follows the flow run to its end: the run id, then its state, reason and workspace; no duration limit', async () => {
    const r = rig()
    r.service.create(request(), flowInputs())
    r.clock.now = iso('2026-10-20T13:00:30Z')
    await r.service.tick()
    expect(r.launches).toHaveLength(1)
    const { occurrence, handle } = r.launches[0]
    handle.flowRun?.('run-1')
    expect(occurrence).toMatchObject({ state: 'running', flowRunId: 'run-1' })
    // Hours later the run waits at a gate: still running, never timed out.
    r.clock.now = iso('2026-10-20T20:00:00Z')
    await r.service.tick()
    expect(occurrence.state).toBe('running')
    expect(r.stopped).toEqual([])
    r.service.flowRunEnded({ id: 'run-1', state: 'needs-you', reason: 'Stopped: it asked a question.', workspaceId: 'ws-1' })
    expect(occurrence).toMatchObject({ state: 'needs-you', reason: 'Stopped: it asked a question.', workspaceId: 'ws-1' })
    // Another run's end changes nothing.
    r.service.flowRunEnded({ id: 'other', state: 'completed' })
    expect(occurrence.state).toBe('needs-you')
  })

  it('has no after-run policy of its own: the flow’s [after] is the one, even on a record saved with one', async () => {
    const r = rig()
    const s = r.service.create(request({ afterRun: 'archive', afterRunDeleteBranch: true }), flowInputs())
    expect(s.afterRun).toBeUndefined()
    expect(s.afterRunDeleteBranch).toBeUndefined()
    // A schedule saved before this, with an after-run choice.
    s.afterRun = 'archive'
    r.clock.now = iso('2026-10-20T13:00:30Z')
    await r.service.tick()
    r.launches[0].handle.flowRun?.('run')
    r.service.flowRunEnded({ id: 'run', state: 'completed', workspaceId: 'ws-1' })
    expect(r.launches[0].occurrence).toMatchObject({ state: 'completed', workspaceId: 'ws-1' })
    expect(r.afterRun).not.toHaveBeenCalled()
  })

  it('maps a run’s end onto the occurrence: completed, failed, stopped as stopped by you', async () => {
    for (const [state, expected] of [['completed', 'completed'], ['failed', 'failed'], ['stopped', 'cancelled'], ['uncertain', 'uncertain']] as const) {
      const r = rig()
      r.service.create(request(), flowInputs())
      r.clock.now = iso('2026-10-20T13:00:30Z')
      await r.service.tick()
      r.launches[0].handle.flowRun?.('run')
      r.service.flowRunEnded({ id: 'run', state })
      expect(r.launches[0].occurrence.state).toBe(expected)
    }
  })
})

// ---- core: saving one, and its run ----

const RUNNABLE = `name = "Runnable"

[inputs]
task = "What to build"

[start]
step = "build"

[steps.build]
kind = "turn"
prompt = "Build {{task}}"

[steps.checks]
kind = "checks"

[edges]
build = "checks"
`

async function core() {
  const dir = await tempDir('foreman-flow-schedules-')
  const store = new Store(dir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() })
  const c = new Core(store, secrets, {
    broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
  })
  c.attention.stop()
  await c.api.updateSettings({ flows: true })
  const repo = await c.api.addRepo(await makeRepo())
  const saved = await c.api.savePersonalFlow({ toml: RUNNABLE })
  if (!('flow' in saved)) throw new Error('not saved')
  const req: ScheduleRequest = { ...request(), repoId: repo.id, startDate: '2099-03-02', flow: { flowId: saved.flow.id, flowSource: 'personal', flowName: 'old name', inputs: { task: 'the parser', extra: 'dropped' } } }
  return { core: c, store, repo, flowId: saved.flow.id, req }
}

describe('a flow schedule in core', () => {
  it('previews and saves what a run of the flow approves, keeping only the inputs it asks for', async () => {
    const { core: c, store, req } = await core()
    const view = await c.api.scheduleFingerprint(req)
    expect(Object.keys(view.fingerprint).sort()).toEqual(['checks', 'flow', 'mcp', 'personas', 'setup', 'template'])
    expect(view.summary.flow).toMatchObject({ flowName: 'Runnable', flowSource: 'personal', steps: 2, notClaude: [], problems: [] })
    const saved = await c.api.saveSchedule(req, undefined, view.fingerprint)
    expect(saved).toMatchObject({ flow: { flowName: 'Runnable', flowSource: 'personal', inputs: { task: 'the parser' } }, model: '' })
    expect(saved.flow?.inputs).not.toHaveProperty('extra')
    expect(store.state.schedules).toHaveLength(1)
    await c.shutdown()
  })

  it('refuses to save on a run approval that changed since the dialog previewed it, naming the flow', async () => {
    const { core: c, store, repo, flowId, req } = await core()
    // What the Schedule dialog shows and sends back: the flow run's preview, as a schedule fingerprint.
    const preview = await c.api.flowRunPreview({ flowId, repoId: repo.id, baseBranch: 'main' })
    const edited = await c.api.savePersonalFlow({ id: flowId, toml: RUNNABLE.replace('Build {{task}}', 'Build {{task}} carefully') })
    if (!('flow' in edited)) throw new Error('not saved')
    await expect(c.api.saveSchedule(req, undefined, scheduleFingerprintOfFlow(preview.fingerprint))).rejects.toThrow(`${SHOWN_CHANGED}. Changed: the flow.`)
    expect(store.state.schedules ?? []).toHaveLength(0)
    // Shown as it stands, it saves.
    const again = await c.api.flowRunPreview({ flowId, repoId: repo.id, baseBranch: 'main' })
    await expect(c.api.saveSchedule(req, undefined, scheduleFingerprintOfFlow(again.fingerprint))).resolves.toMatchObject({ flow: { flowId } })
    await c.shutdown()
  })

  it('refuses a flow whose turns aren’t on Claude, in the design’s words, and one missing a value, saving nothing', async () => {
    const { core: c, store, req } = await core()
    await expect(c.api.saveSchedule({ ...req, flow: { ...req.flow!, inputs: {} } })).rejects.toThrow('A scheduled run can’t ask for values, so fill in “task” first.')
    store.state.settings.loadouts = [{ agent: 'codex', model: 'gpt-5.5', fast: false }]
    await expect(c.api.saveSchedule(req)).rejects.toThrow(/Unattended turns are Claude only, as scheduled runs are: nobody can answer another agent’s approvals yet \(review and decide steps may run on Codex\)\. Not Claude: build \(Codex\)/)
    expect(store.state.schedules ?? []).toHaveLength(0)
    await c.api.updateSettings({ flows: false })
    await expect(c.api.saveSchedule(req)).rejects.toThrow('Flows are off')
    await c.shutdown()
  })

  it('starts a due run through the flow service from the schedule’s base branch, on what it was approved on, saying where it came from', async () => {
    const { core: c, req } = await core()
    const schedule = await c.api.saveSchedule({ ...req, baseBranch: 'develop' })
    const flows = (c as unknown as { flows: FlowService }).flows
    const begun = { id: 'run-9', state: 'running' } as FlowRun
    const begin = vi.spyOn(flows, 'begin').mockReturnValue(begun)
    const occurrence: Occurrence = { id: 'occ-1', scheduleId: schedule.id, plannedAt: new Date().toISOString(), state: 'starting' }
    const handle = { created: vi.fn(), flowRun: vi.fn() }
    await (c as unknown as { launchScheduled(s: Schedule, o: Occurrence, h: LaunchHandle): Promise<void> }).launchScheduled(schedule, occurrence, handle)
    expect(begin).toHaveBeenCalledWith({
      flowId: schedule.flow!.flowId, repoId: schedule.repoId, baseBranch: 'develop', inputs: { task: 'the parser' },
      shown: flowFingerprintFrom(schedule.approved!), origin: { kind: 'schedule', scheduleId: schedule.id, occurrenceId: 'occ-1' }
    })
    expect(handle.flowRun).toHaveBeenCalledWith('run-9')
    expect(handle.created).not.toHaveBeenCalled()
    await c.shutdown()
  })
})
