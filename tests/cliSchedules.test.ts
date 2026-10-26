import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { CliCodedError } from '../src/main/cli/host'
import type { CliContext } from '../src/main/cli/methods'
import { SCHEDULES_METHODS, cadenceOf, parseWeekdays } from '../src/main/cli/schedules'
import { assertFingerprintShown, changedParts, SHOWN_CHANGED } from '../src/main/schedules'
import { SecretStore } from '../src/main/secrets'
import { defaultSettings, Store } from '../src/main/store'
import type { SchedulePreviewResult, SchedulesApproveResult, SchedulesChangeResult, SchedulesListResult, SchedulesRemoveResult, SchedulesRunsResult, SchedulesSaveResult } from '../src/shared/cli/schedules'
import type { ModelInfo } from '../src/shared/agents'
import type { Api, AppSnapshot, Occurrence, PromptTemplate, Repo, Schedule, ScheduleFingerprint, ScheduleFingerprintView, ScheduleRequest, Settings, Workspace } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'
import { tempDir } from './helpers'

afterEach(() => vi.restoreAllMocks())

const ctx = { request: { method: 'x' }, caller: undefined, signal: undefined, progress: () => undefined } as CliContext

const root = path.resolve('/tmp/foreman-cli-schedules/repo')
const repo = { id: 'r1', name: 'foreman', rootPath: root, defaultBranch: 'develop' } as Repo
const CLAUDE: ModelInfo[] = [
  { id: 'claude-opus-5-5[1m]', agent: 'claude', label: 'Opus 5.5', efforts: [], supportsFast: true, contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5-5[1m]', agent: 'claude', label: 'Sonnet 5.5', efforts: [], supportsFast: false, contextWindow: 1_000_000 }
]
const nightly: PromptTemplate = { id: 't-1', name: 'Nightly review', body: 'Review the last day of commits' }
const withValues: PromptTemplate = { id: 't-2', name: 'Fix an issue', body: 'Fix {{issue}} in {{file}}' }

const FP: ScheduleFingerprint = { template: 'a', setup: 'b', checks: 'c', mcp: 'd' }
const VIEW: ScheduleFingerprintView = {
  fingerprint: FP,
  summary: { templateName: 'Nightly review', templateSource: 'personal', repoName: 'foreman', baseBranch: 'develop', setupScript: 'npm ci\nnpm run build', checks: [{ name: 'test', command: 'npm test' }], mcpServers: ['docs'], integrations: ['linear: Work (read)'] }
}

const START = '2099-03-02'
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()

const existing = (over: Partial<Schedule> = {}): Schedule => ({
  id: '11111111-2222-3333-4444-555555555555', templateId: 't-1', templateName: 'Nightly review', repoId: 'r1', baseBranch: 'develop', recurrence: 'daily', startDate: START, weekdays: [weekday(START)], time: '09:00', timezone: 'Europe/London',
  model: 'claude-sonnet-5-5[1m]', maxMinutes: 30, state: 'active', consecutiveFailures: 0, approved: FP, approvedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', nextRunAt: '2099-03-02T09:00:00.000Z', ...over
})

function setup(over: { settings?: Partial<Settings>; snapshot?: Partial<AppSnapshot>; api?: Partial<Api> } = {}) {
  const settings = { ...defaultSettings(), promptTemplates: [nightly, withValues], ...over.settings }
  const snapshot = { repos: [repo], workspaces: [], sessions: [], settings, repoTemplates: {}, repoCommands: {}, schedules: [], occurrences: [], catalog: { agents: { claude: { models: CLAUDE } }, outputStyles: [] }, ...over.snapshot } as unknown as AppSnapshot
  const scheduleFingerprint = vi.fn(async (_request: ScheduleRequest) => VIEW)
  const saveSchedule = vi.fn(async (request: ScheduleRequest, id?: string, _shown?: ScheduleFingerprint) => existing({ ...request, id: id ?? 'new-id-0000', templateName: request.templateName }) as Schedule)
  const api = fakeApi({ scheduleFingerprint, saveSchedule, ...over.api })
  const host = stubHost({ state: () => ({ repos: snapshot.repos, workspaces: snapshot.workspaces, sessions: [], settings }), snapshot: () => snapshot, api })
  const call = <T>(method: string, params?: unknown) => SCHEDULES_METHODS[method].handle(host, params, ctx) as Promise<T>
  return { call, scheduleFingerprint, saveSchedule, snapshot, api }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(CliCodedError)
  return err as CliCodedError
}

const spec = { template: 'nightly-review', cwd: root, recurrence: 'daily', at: '9:05', tz: 'Europe/London', start: START }

describe('schedule words', () => {
  it('reads weekdays by name, number and group', () => {
    expect(parseWeekdays(['mon', 'Wednesday', '5'])).toEqual([1, 3, 5])
    expect(parseWeekdays(['weekdays'])).toEqual([1, 2, 3, 4, 5])
    expect(parseWeekdays(['sat,sun'])).toEqual([0, 6])
    expect(() => parseWeekdays(['funday'])).toThrow(/isn’t a weekday/)
  })

  it('says the cadence in words', () => {
    const s = { startDate: START, weekdays: [1, 3], time: '09:00' }
    expect(cadenceOf({ ...s, recurrence: 'daily' })).toBe('every day at 09:00')
    expect(cadenceOf({ ...s, recurrence: 'weekly' })).toBe('every Mon, Wed at 09:00')
    expect(cadenceOf({ ...s, recurrence: 'hourly', time: '09:15' })).toBe('every hour at :15')
    expect(cadenceOf({ ...s, recurrence: 'monthly', dayOfMonth: 22 })).toBe('on the 22nd of every month at 09:00')
    expect(cadenceOf({ ...s, recurrence: 'once' })).toBe(`once on ${START} at 09:00`)
  })
})

describe('the schedule methods', () => {
  it('puts list, preview and runs in the read tier and every change in admin', () => {
    expect(Object.fromEntries(Object.entries(SCHEDULES_METHODS).map(([k, m]) => [k, m.tier]))).toEqual({
      'schedules-list': 'read',
      'schedules-preview': 'read',
      'schedules-add': 'admin',
      'schedules-edit': 'admin',
      'schedules-approve': 'admin',
      'schedules-pause': 'admin',
      'schedules-resume': 'admin',
      'schedules-remove': 'admin',
      'schedules-runs': 'read',
      'schedules-stop-run': 'admin'
    })
  })

  describe('preview', () => {
    it('builds the request with the dialog’s defaults and prints what approving covers', async () => {
      const { call, scheduleFingerprint } = setup()
      const result = await call<SchedulePreviewResult>('schedules-preview', spec)
      expect(scheduleFingerprint).toHaveBeenCalledWith({
        templateId: 't-1',
        templateName: 'Nightly review',
        repoId: 'r1',
        baseBranch: 'develop',
        recurrence: 'daily',
        startDate: START,
        weekdays: [weekday(START)],
        dayOfMonth: 2,
        time: '09:05',
        timezone: 'Europe/London',
        agent: 'claude',
        model: 'claude-sonnet-5-5[1m]',
        maxMinutes: 30
      })
      expect(result.fingerprint).toEqual(FP)
      expect(result.cadence).toBe('every day at 09:05 (Europe/London)')
      expect(result.nextRuns[0]).toContain('2 Mar')
      for (const line of ['Schedule “Nightly review”', 'Repository: foreman, each run starts from develop', 'Runs on: Claude · claude-sonnet-5-5[1m], permission mode auto', 'Limit: 30 minutes per run', 'Setup script: npm ci …', 'Checks: test (npm test)', 'Repository MCP servers: docs', 'Integrations: linear: Work (read)', 'Runs only while Foreman is open']) expect(result.text).toContain(line)
    })

    it('refuses a template with placeholders and names them, calling nothing', async () => {
      const { call, scheduleFingerprint } = setup()
      const refused = await failure(call('schedules-preview', { ...spec, template: 'fix-an-issue' }))
      expect(refused.code).toBe('invalid')
      expect(refused.message).toContain('{{issue}}, {{file}}')
      expect(refused.message).toContain('can’t ask')
      expect(scheduleFingerprint).not.toHaveBeenCalled()
    })

    it('finds a repository’s own template, and says when the template is unknown', async () => {
      const release: PromptTemplate = { id: 'repo:r1:release', name: 'Release', body: 'Cut it', source: 'repo', repoId: 'r1', rev: 'abc1234def' }
      const { call, scheduleFingerprint } = setup({ snapshot: { repoTemplates: { r1: [release] } } })
      await call('schedules-preview', { ...spec, template: 'repo:release' })
      expect(scheduleFingerprint.mock.calls[0][0]).toMatchObject({ templateId: 'repo:r1:release', templateName: 'Release' })
      expect((await failure(call('schedules-preview', { ...spec, template: 'ghost' }))).code).toBe('not-found')
    })

    it('takes weekdays, a day of the month, a base branch, a model and a limit', async () => {
      const { call, scheduleFingerprint } = setup()
      await call('schedules-preview', { ...spec, recurrence: 'weekly', on: ['mon', 'wed'], base: 'main', model: 'claude-opus-5-5[1m]', maxMinutes: 60 })
      expect(scheduleFingerprint.mock.calls[0][0]).toMatchObject({ recurrence: 'weekly', weekdays: [1, 3], baseBranch: 'main', model: 'claude-opus-5-5[1m]', maxMinutes: 60 })
      await call('schedules-preview', { ...spec, recurrence: 'monthly', dayOfMonth: 15 })
      expect(scheduleFingerprint.mock.calls[1][0]).toMatchObject({ recurrence: 'monthly', dayOfMonth: 15 })
      await call('schedules-preview', { ...spec, recurrence: 'weekly' })
      expect(scheduleFingerprint.mock.calls[2][0].weekdays).toEqual([weekday(START)])
    })

    it('refuses a bad cadence, time, zone, model or limit before asking the service', async () => {
      const { call, scheduleFingerprint } = setup()
      const bad = async (changes: Record<string, unknown>) => (await failure(call('schedules-preview', { ...spec, ...changes }))).message
      expect(await bad({ recurrence: 'fortnightly' })).toMatch(/isn’t a cadence/)
      expect(await bad({ at: '25:00' })).toMatch(/isn’t a time/)
      expect(await bad({ tz: 'Mars/Base' })).toMatch(/time zone/)
      expect(await bad({ model: 'claude-nope' })).toMatch(/doesn’t list/)
      expect(await bad({ maxMinutes: 2 })).toMatch(/between 5 minutes and 8 hours/)
      expect(await bad({ recurrence: 'weekly', on: ['funday'] })).toMatch(/isn’t a weekday/)
      expect(await bad({ recurrence: 'once', start: '2020-01-01' })).toMatch(/future date/)
      expect(await bad({ dayOfMonth: 40 })).toMatch(/1 to 31/)
      expect(scheduleFingerprint).not.toHaveBeenCalled()
    })
  })

  describe('add and edit', () => {
    it('add without the fingerprint saves nothing and returns the preview', async () => {
      const { call, saveSchedule } = setup()
      const result = await call<SchedulesSaveResult>('schedules-add', spec)
      expect(result).toMatchObject({ saved: false, needsConfirmation: true })
      expect(result.preview?.fingerprint).toEqual(FP)
      expect(saveSchedule).not.toHaveBeenCalled()
    })

    it('add passes the fingerprint it was given to saveSchedule', async () => {
      const { call, saveSchedule } = setup()
      const result = await call<SchedulesSaveResult>('schedules-add', { ...spec, shown: FP })
      expect(saveSchedule).toHaveBeenCalledTimes(1)
      const [request, id, shown] = saveSchedule.mock.calls[0]
      expect(request).toMatchObject({ templateId: 't-1', repoId: 'r1', recurrence: 'daily', time: '09:05', agent: 'claude' })
      expect(id).toBeUndefined()
      expect(shown).toEqual(FP)
      expect(result.saved).toBe(true)
      expect(result.schedule).toMatchObject({ template: 'Nightly review', repo: 'foreman' })
      expect((await failure(call('schedules-add', { ...spec, shown: { template: 'x' } }))).message).toMatch(/fingerprint a preview returned/)
    })

    it('add reports the service’s refusal when what was shown has changed', async () => {
      const { call } = setup({ api: { saveSchedule: async () => { throw new Error(`${SHOWN_CHANGED}. Changed: the template.`) } } })
      await expect(call('schedules-add', { ...spec, shown: FP })).rejects.toThrow(SHOWN_CHANGED)
    })

    it('edit starts from the schedule as it is and sends the id and the fingerprint', async () => {
      const s = existing()
      const { call, saveSchedule } = setup({ snapshot: { schedules: [s] } })
      await call('schedules-edit', { id: '1111', cwd: '/', at: '10:30', shown: FP })
      const [request, id, shown] = saveSchedule.mock.calls[0]
      expect(id).toBe(s.id)
      expect(shown).toEqual(FP)
      expect(request).toEqual({ templateId: 't-1', templateName: 'Nightly review', repoId: 'r1', baseBranch: 'develop', recurrence: 'daily', startDate: START, weekdays: s.weekdays, dayOfMonth: 2, time: '10:30', timezone: 'Europe/London', agent: 'claude', model: 'claude-sonnet-5-5[1m]', maxMinutes: 30 })
    })

    it('edit finds a schedule by its template’s name and previews until the fingerprint comes back', async () => {
      const { call, saveSchedule, scheduleFingerprint } = setup({ snapshot: { schedules: [existing()] } })
      const result = await call<SchedulesSaveResult>('schedules-edit', { id: 'nightly review', cwd: '/', maxMinutes: 60 })
      expect(result.needsConfirmation).toBe(true)
      expect(scheduleFingerprint.mock.calls[0][0].maxMinutes).toBe(60)
      expect(saveSchedule).not.toHaveBeenCalled()
      expect((await failure(call('schedules-edit', { id: 'ghost', cwd: '/', maxMinutes: 60 }))).code).toBe('not-found')
    })
  })

  describe('approve', () => {
    it('without the fingerprint says what changed since it was approved and approves nothing', async () => {
      const approveSchedule = vi.fn(async () => undefined)
      const s = existing({ state: 'paused', pausedKind: 'changed', pausedReason: 'Paused: the template changed. Review and re-approve to resume.', approved: { ...FP, template: 'old', checks: 'older' } })
      const { call, scheduleFingerprint } = setup({ snapshot: { schedules: [s] }, api: { approveSchedule } })
      const result = await call<SchedulesApproveResult>('schedules-approve', { id: s.id })
      expect(scheduleFingerprint.mock.calls[0][0]).toMatchObject({ templateId: 't-1', repoId: 'r1', model: s.model })
      expect(changedParts(s.approved, FP)).toEqual(['the template', 'the repo’s checks'])
      expect(result).toMatchObject({ approved: false, needsConfirmation: true, changed: ['the template', 'the repo’s checks'] })
      expect(result.preview?.fingerprint).toEqual(FP)
      expect(result.text).toContain('the template and the repo’s checks changed')
      expect(approveSchedule).not.toHaveBeenCalled()
    })

    it('with the fingerprint approves through the service, which refuses a stale one', async () => {
      const approveSchedule = vi.fn(async () => undefined)
      const s = existing({ state: 'paused', pausedKind: 'changed' })
      const { call } = setup({ snapshot: { schedules: [s] }, api: { approveSchedule } })
      const result = await call<SchedulesApproveResult>('schedules-approve', { id: s.id, shown: FP })
      expect(approveSchedule).toHaveBeenCalledWith(s.id, FP)
      expect(result.approved).toBe(true)
    })
  })

  describe('pause, resume, remove, list, runs', () => {
    const running: Occurrence = { id: 'occ-running-1', scheduleId: existing().id, plannedAt: '2099-03-02T09:00:00.000Z', startedAt: '2099-03-02T09:00:05.000Z', state: 'running', workspaceId: 'w1' }
    const done: Occurrence = { id: 'occ-done-0001', scheduleId: existing().id, plannedAt: '2099-03-01T09:00:00.000Z', startedAt: '2099-03-01T09:00:05.000Z', endedAt: '2099-03-01T09:12:05.000Z', state: 'completed', workspaceId: 'w2' }
    const ws = (id: string, extra: Partial<Workspace> = {}) => ({ id, repoId: 'r1', name: `ws-${id}`, branch: id, state: 'ready', ...extra }) as Workspace

    it('pause and resume call the service and say what happened', async () => {
      const pauseSchedule = vi.fn(async () => undefined)
      const resumeSchedule = vi.fn(async () => undefined)
      const s = existing()
      const { call } = setup({ snapshot: { schedules: [s] }, api: { pauseSchedule, resumeSchedule } })
      expect((await call<SchedulesChangeResult>('schedules-pause', { id: s.id })).text).toBe('Paused “Nightly review”.')
      expect(pauseSchedule).toHaveBeenCalledWith(s.id)
      await call('schedules-resume', { id: 'nightly review' })
      expect(resumeSchedule).toHaveBeenCalledWith(s.id)
    })

    it('remove deletes a schedule, but not one with a run going', async () => {
      const deleteSchedule = vi.fn(async () => undefined)
      const s = existing()
      const { call } = setup({ snapshot: { schedules: [s], occurrences: [done] }, api: { deleteSchedule } })
      const removed = await call<SchedulesRemoveResult>('schedules-remove', { id: s.id })
      expect(deleteSchedule).toHaveBeenCalledWith(s.id)
      expect(removed.removed.template).toBe('Nightly review')

      deleteSchedule.mockClear()
      const busy = setup({ snapshot: { schedules: [s], occurrences: [running] }, api: { deleteSchedule } })
      const refused = await failure(busy.call('schedules-remove', { id: s.id }))
      expect(refused.code).toBe('refused')
      expect(refused.message).toContain('foreman schedules stop-run occ-runn')
      expect(deleteSchedule).not.toHaveBeenCalled()
    })

    it('lists schedules with their cadence, next run, paused reason and running runs', async () => {
      const a = existing()
      const b = existing({ id: 'bbbbbbbb-0000-0000-0000-000000000000', templateName: 'Weekly cleanup', recurrence: 'weekly', weekdays: [1], state: 'paused', pausedKind: 'changed', pausedReason: 'Paused: the template changed. Review and re-approve to resume.', nextRunAt: undefined })
      const { call } = setup({ snapshot: { schedules: [a, b], occurrences: [running, done] } })
      const result = await call<SchedulesListResult>('schedules-list')
      expect(result.schedules[0]).toMatchObject({ template: 'Nightly review', repo: 'foreman', cadence: 'every day at 09:00', running: ['occ-running-1'], last: { id: 'occ-done-0001', state: 'completed' } })
      expect(result.schedules[0].next).toContain('09:00')
      expect(result.schedules[1]).toMatchObject({ state: 'paused', pausedKind: 'changed', cadence: 'every Mon at 09:00' })
      expect(result.text).toContain('running now')
      expect(result.text).toContain('paused: Paused: the template changed')
    })

    it('lists runs newest first with workspace, outcome, duration and pull request', async () => {
      const { call } = setup({
        snapshot: { schedules: [existing()], occurrences: [done, running], workspaces: [ws('w1'), ws('w2', { prInfo: { number: 42, state: 'OPEN', url: 'https://github.com/o/r/pull/42' } })] }
      })
      const result = await call<SchedulesRunsResult>('schedules-runs', { id: 'nightly review' })
      expect(result.runs.map((r) => r.id)).toEqual(['occ-running-1', 'occ-done-0001'])
      expect(result.runs[1]).toMatchObject({ state: 'completed', durationMs: 12 * 60_000, workspace: { name: 'ws-w2' }, pr: { number: 42, url: 'https://github.com/o/r/pull/42' } })
      expect(result.text).toContain('12m')
      expect(result.text).toContain('#42')
      expect((await call<SchedulesRunsResult>('schedules-runs', { limit: 1 })).runs).toHaveLength(1)
    })

    it('stop-run stops a run that is going, and refuses one that is not', async () => {
      const stopScheduledRun = vi.fn(async () => undefined)
      const { call } = setup({ snapshot: { schedules: [existing()], occurrences: [running, done] }, api: { stopScheduledRun } })
      await call('schedules-stop-run', { occurrence: 'occ-runn' })
      expect(stopScheduledRun).toHaveBeenCalledWith('occ-running-1')
      const refused = await failure(call('schedules-stop-run', { occurrence: 'occ-done-0001' }))
      expect(refused.code).toBe('refused')
      expect(stopScheduledRun).toHaveBeenCalledTimes(1)
    })
  })
})

describe('what a schedule is approved on (the service)', () => {
  it('assertFingerprintShown passes without a fingerprint or with the current one, and names what changed otherwise', () => {
    expect(() => assertFingerprintShown(undefined, FP)).not.toThrow()
    expect(() => assertFingerprintShown(FP, FP)).not.toThrow()
    expect(() => assertFingerprintShown({ ...FP, template: 'x' }, FP)).toThrow(`${SHOWN_CHANGED}. Changed: the template.`)
    expect(() => assertFingerprintShown({ ...FP, setup: 'x', mcp: 'y' }, FP)).toThrow('the repo’s setup script and the repo’s MCP servers')
    expect(() => assertFingerprintShown('nonsense' as unknown as ScheduleFingerprint, FP)).toThrow(SHOWN_CHANGED)
  })

  async function coreWithRepo() {
    const dir = await tempDir('foreman-sched-core-')
    const folder = await tempDir('foreman-sched-repo-')
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
    const request: ScheduleRequest = { templateId: 't-1', templateName: 'Nightly review', repoId: 'r1', baseBranch: 'main', recurrence: 'daily', startDate: START, weekdays: [1], time: '09:00', timezone: 'Europe/London', agent: 'claude', model: 'claude-sonnet-5-5[1m]', maxMinutes: 30 }
    return { core, store, request }
  }

  it('scheduleFingerprint returns what saving would approve, and refuses what saving would refuse', async () => {
    const { core, request } = await coreWithRepo()
    const view = await core.api.scheduleFingerprint(request)
    expect(Object.keys(view.fingerprint).sort()).toEqual(['checks', 'mcp', 'setup', 'template'])
    expect(view.summary).toMatchObject({ templateName: 'Nightly review', templateSource: 'personal', repoName: 'foreman', baseBranch: 'main', checks: [], mcpServers: [] })
    await expect(core.api.scheduleFingerprint({ ...request, templateId: 't-2' })).rejects.toThrow(/placeholders/)
    await expect(core.api.scheduleFingerprint({ ...request, templateId: 'nope' })).rejects.toThrow(/no longer exists/)
    await expect(core.api.scheduleFingerprint({ ...request, recurrence: 'once' , startDate: '2020-01-01' })).rejects.toThrow(/future date/)
  })

  it('saveSchedule with the fingerprint that was shown saves; with a stale one it throws the plan’s message and saves nothing', async () => {
    const { core, store, request } = await coreWithRepo()
    const shown = (await core.api.scheduleFingerprint(request)).fingerprint
    // The template changed after the user looked.
    store.state.settings.promptTemplates[0] = { ...store.state.settings.promptTemplates[0], body: 'Review the last week of commits' }
    await expect(core.api.saveSchedule(request, undefined, shown)).rejects.toThrow(`${SHOWN_CHANGED}. Changed: the template.`)
    expect(store.state.schedules ?? []).toHaveLength(0)

    const fresh = (await core.api.scheduleFingerprint(request)).fingerprint
    const saved = await core.api.saveSchedule(request, undefined, fresh)
    expect(saved.approved).toEqual(fresh)
    expect(store.state.schedules).toHaveLength(1)
    // Without `shown` it behaves as it always did.
    const second = await core.api.saveSchedule({ ...request, time: '10:00' })
    expect(second.id).not.toBe(saved.id)
  })

  it('saveSchedule on an existing schedule checks the fingerprint too', async () => {
    const { core, store, request } = await coreWithRepo()
    const saved = await core.api.saveSchedule(request)
    store.state.settings.promptTemplates[0] = { ...store.state.settings.promptTemplates[0], body: 'Changed' }
    await expect(core.api.saveSchedule({ ...request, time: '11:00' }, saved.id, saved.approved)).rejects.toThrow(SHOWN_CHANGED)
    expect(store.state.schedules![0].time).toBe('09:00')
  })

  it('approveSchedule takes the fingerprint shown, and refuses a stale one', async () => {
    const { core, store, request } = await coreWithRepo()
    const saved = await core.api.saveSchedule(request)
    store.state.settings.promptTemplates[0] = { ...store.state.settings.promptTemplates[0], body: 'Changed text' }
    const staleView = saved.approved
    await expect(core.api.approveSchedule(saved.id, staleView)).rejects.toThrow(`${SHOWN_CHANGED}. Changed: the template.`)
    const now = (await core.api.scheduleFingerprint(request)).fingerprint
    expect(now.template).not.toBe(saved.approved.template)
    await core.api.pauseSchedule(saved.id)
    await core.api.approveSchedule(saved.id, now)
    expect(store.state.schedules![0]).toMatchObject({ state: 'active', approved: now })
    // And as before, with nothing shown.
    await core.api.approveSchedule(saved.id)
  })
})
