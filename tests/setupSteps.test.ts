// O19: setup as ordered steps. Schema and layering, the step runner with real
// child processes, and a workspace's setup carrying on from the failed step.
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { Environment } from '../src/main/environment'
import { fromToml, patchLocal, resolveRepoSettings } from '../src/main/repoSettings'
import { SecretStore } from '../src/main/secrets'
import { runSetupSteps } from '../src/main/setupSteps'
import { defaultSettings, Store } from '../src/main/store'
import { WorkspaceService } from '../src/main/workspaces'
import { clock, cleanSteps, duration, parseTimeout, resumeIndex, runningStep, stepsPatch, stepsScript } from '../src/shared/setupSteps'
import { triageAll } from '../src/shared/triage'
import type { AppSnapshot, Repo, SetupStep, SetupStepResult, Workspace } from '../src/shared/types'
import { wsPath } from '../src/shared/workspacePath'
import { makeRepo, tempDir } from './helpers'

afterEach(() => vi.restoreAllMocks())

// Short node one-liners run the same under cmd.exe and sh.
const node = (js: string) => `node -e "${js}"`
const append = (file: string, text: string) => node(`require('fs').appendFileSync('${file}','${text}')`)
const fail = (code: number) => node(`process.exit(${code})`)
const sleep = (ms: number) => node(`setTimeout(function(){},${ms})`)
// Fails until `marker` exists, creating it on the way out: passes the second time it runs.
const flaky = (marker: string) => node(`const f=require('fs');if(!f.existsSync('${marker}')){f.writeFileSync('${marker}','');process.exit(4)}`)

describe('setup steps: settings.toml and layers', () => {
  it('reads [[scripts.setup.steps]] with names, commands and timeouts', () => {
    const { values } = fromToml({
      scripts: {
        setup: {
          retry_failed_step: true,
          steps: [
            { name: 'Install deps', command: 'npm ci', timeout: '10m' },
            { name: 'Seed DB', command: 'node scripts/seed.mjs', timeout: 120 },
            { name: 'Build types', command: 'npm run build:types' },
            { name: 'No command' },
            { command: 'echo unnamed', timeout: 'none' }
          ]
        }
      }
    })
    expect(values.setupSteps).toEqual([
      { name: 'Install deps', command: 'npm ci', timeoutSec: 600 },
      { name: 'Seed DB', command: 'node scripts/seed.mjs', timeoutSec: 120 },
      { name: 'Build types', command: 'npm run build:types' },
      { name: 'Step 4', command: 'echo unnamed' }
    ])
    expect(values.setupRetryOnce).toBe(true)
    expect(values.setupScript).toBeUndefined()
  })

  it('reads timeouts as seconds or with a unit, anything else as no limit', () => {
    expect(parseTimeout(90)).toBe(90)
    expect(parseTimeout('90s')).toBe(90)
    expect(parseTimeout('2 min')).toBe(120)
    expect(parseTimeout('1h')).toBe(3600)
    expect(parseTimeout('1.5m')).toBe(90)
    expect(parseTimeout('120')).toBe(120)
    for (const none of [0, -5, 'none', 'no limit', '', '5 parsecs', undefined, null, true]) expect(parseTimeout(none)).toBeUndefined()
  })

  it('a single setup script is one step called Setup, and the retry switch is off by default', async () => {
    const root = await makeRepo()
    await mkdir(path.join(root, '.foreman'))
    await writeFile(path.join(root, '.foreman', 'settings.toml'), '[scripts]\nsetup = "npm i"\n')
    const repo: Repo = { id: 'r', name: 'r', rootPath: root, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: '' }
    const resolved = resolveRepoSettings(repo, defaultSettings())
    expect(resolved.values.setupSteps).toEqual([{ name: 'Setup', command: 'npm i' }])
    expect(resolved.values.setupScript).toBe('npm i')
    expect(resolved.values.setupRetryOnce).toBe(false)
    expect(resolved.sources.setupSteps).toBe('shared')

    // Older state on this computer: a local single script still wins, as one step.
    repo.local = { setupScript: 'pnpm i' }
    expect(resolveRepoSettings(repo, defaultSettings()).values.setupSteps).toEqual([{ name: 'Setup', command: 'pnpm i' }])
  })

  it('local steps override the shared ones as a whole, with Overriding/Reset sources, and reset inherits again', async () => {
    const root = await makeRepo()
    await mkdir(path.join(root, '.foreman'))
    await writeFile(
      path.join(root, '.foreman', 'settings.toml'),
      '[[scripts.setup.steps]]\nname = "Install"\ncommand = "npm ci"\ntimeout = "10m"\n\n[[scripts.setup.steps]]\nname = "Build"\ncommand = "npm run build"\n'
    )
    const repo: Repo = { id: 'r', name: 'r', rootPath: root, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: '' }
    let resolved = resolveRepoSettings(repo, defaultSettings())
    expect(resolved.values.setupSteps.map((s) => s.name)).toEqual(['Install', 'Build'])
    expect(resolved.values.setupScript).toBe('npm ci\nnpm run build')
    expect(resolved.sources.setupSteps).toBe('shared')
    expect(resolved.sources.setupScript).toBe('shared')

    repo.local = patchLocal(repo.local, stepsPatch([{ name: 'Only', command: 'make', timeoutSec: 60 }]))
    resolved = resolveRepoSettings(repo, defaultSettings())
    expect(resolved.values.setupSteps).toEqual([{ name: 'Only', command: 'make', timeoutSec: 60 }])
    expect(resolved.sources.setupSteps).toBe('local')
    expect(resolved.inherited.setupSteps).toBe('shared')

    // A plain local script (older state) also overrides the shared steps.
    repo.local = patchLocal(repo.local, stepsPatch([{ name: 'Setup', command: 'make' }]))
    expect(repo.local).toEqual({ setupScript: 'make' })
    expect(resolveRepoSettings(repo, defaultSettings()).values.setupSteps).toEqual([{ name: 'Setup', command: 'make' }])

    repo.local = patchLocal(repo.local, { setupScript: null, setupSteps: null })
    resolved = resolveRepoSettings(repo, defaultSettings())
    expect(resolved.values.setupSteps.map((s) => s.name)).toEqual(['Install', 'Build'])
    expect(resolved.sources.setupSteps).toBe('shared')
  })

  it('stores one plain step as a single script, so older versions still run it, and anything else as steps', () => {
    expect(stepsPatch([{ name: 'Setup', command: 'npm i  ' }])).toEqual({ setupScript: 'npm i', setupSteps: null })
    expect(stepsPatch([{ name: 'Setup', command: 'npm i', timeoutSec: 60 }])).toEqual({ setupSteps: [{ name: 'Setup', command: 'npm i', timeoutSec: 60 }], setupScript: null })
    expect(stepsPatch([{ name: 'A', command: 'a' }, { name: '', command: ' ' }, { name: '', command: 'b' }])).toEqual({
      setupSteps: [{ name: 'A', command: 'a' }, { name: 'Step 2', command: 'b' }],
      setupScript: null
    })
    expect(stepsPatch([])).toEqual({ setupScript: '', setupSteps: null })
    expect(cleanSteps([{ name: ' x ', command: 'y', timeoutSec: 0 }])).toEqual([{ name: 'x', command: 'y' }])
    expect(stepsScript([{ name: 'a', command: 'one' }, { name: 'b', command: 'two' }])).toBe('one\ntwo')
  })

  it('formats times for the step panel', () => {
    expect(clock(31_000)).toBe('0:31')
    expect(clock(120_000)).toBe('2:00')
    expect(clock(3_723_000)).toBe('1:02:03')
    expect(duration(48_000)).toBe('48s')
    expect(duration(125_000)).toBe('2m 05s')
    expect(duration(3_720_000)).toBe('1h 02m')
  })
})

describe('setup steps: resuming', () => {
  const steps: SetupStep[] = [
    { name: 'A', command: 'a' },
    { name: 'B', command: 'b' },
    { name: 'C', command: 'c' }
  ]
  const run = (statuses: SetupStepResult['status'][]) => ({
    id: 'r',
    startedAt: '',
    steps: statuses.map((status, i) => ({ name: steps[i].name, command: steps[i].command, status }))
  })

  it('carries on from the first step that did not pass', () => {
    expect(resumeIndex(run(['done', 'failed', 'skipped']), steps)).toBe(1)
    expect(resumeIndex(run(['done', 'done', 'timed-out']), steps)).toBe(2)
    expect(resumeIndex(run(['failed', 'skipped', 'skipped']), steps)).toBe(0)
    expect(resumeIndex(run(['done', 'stopped', 'skipped']), steps)).toBe(1)
  })

  it('runs from the top when there is nothing to carry on from or the steps changed', () => {
    expect(resumeIndex(undefined, steps)).toBe(-1)
    expect(resumeIndex(run(['done', 'done', 'done']), steps)).toBe(-1)
    const changed = [{ name: 'A', command: 'a2' }, ...steps.slice(1)]
    expect(resumeIndex(run(['done', 'failed', 'skipped']), changed)).toBe(-1)
  })

  it('names the running step for the sidebar', () => {
    expect(runningStep(run(['done', 'running', 'pending']))).toEqual({ name: 'B', index: 1, total: 3 })
    expect(runningStep(run(['done', 'failed', 'skipped']))).toBeUndefined()
    const row = (setupRun: Workspace['setupRun']) => {
      const ws = { id: 'w', repoId: 'r', name: 'lima', branch: 'b', baseBranch: 'main', portBase: 1, state: 'setting-up', createdAt: '', setupRun } as Workspace
      return triageAll({ snapshot: { workspaces: [ws], sessions: [] } as unknown as AppSnapshot, approvals: [], unread: {}, unreadSessions: {} }, null)[0]
    }
    expect(row(run(['done', 'running', 'pending']))).toMatchObject({ label: 'Running setup…', detail: 'B, step 2 of 3' })
    // One step (a single setup script) reads as before.
    expect(row({ id: 'r', startedAt: '', steps: [{ name: 'Setup', command: 'x', status: 'running' }] }).detail).toBeUndefined()
  })
})

describe('setup steps: the runner', () => {
  async function go(steps: SetupStep[], options: { retryOnce?: boolean; from?: number; previous?: SetupStepResult[] } = {}) {
    const cwd = await tempDir('foreman-steps-')
    const output: string[][] = steps.map(() => [])
    const changes: SetupStepResult[][] = []
    const run = runSetupSteps({
      steps,
      cwd,
      env: process.env as Record<string, string>,
      onOutput: (i, chunk) => output[i].push(chunk),
      onChange: (results) => changes.push(results),
      graceMs: 500,
      ...options
    })
    return { run, cwd, output, changes, order: async () => (existsSync(path.join(cwd, 'order.txt')) ? readFile(path.join(cwd, 'order.txt'), 'utf8') : '') }
  }

  it('runs the steps in order and records each one', async () => {
    const { run, order, output, changes } = await go([
      { name: 'One', command: `${append('order.txt', '1')} && ${node("console.log('hello from one')")}` },
      { name: 'Two', command: append('order.txt', '2') },
      { name: 'Three', command: append('order.txt', '3') }
    ])
    expect(await run.done).toBe('done')
    expect(await order()).toBe('123')
    expect(run.results.map((r) => r.status)).toEqual(['done', 'done', 'done'])
    expect(run.results.every((r) => r.exitCode === 0 && typeof r.durationMs === 'number' && r.startedAt && r.attempts === 1)).toBe(true)
    expect(output[0].join('')).toContain('hello from one')
    // Live updates show a step running before it's done.
    expect(changes.some((c) => c[1].status === 'running' && c[0].status === 'done' && c[2].status === 'pending')).toBe(true)
  }, 30_000)

  it('stops at the first failure and skips the rest', async () => {
    const { run, order } = await go([
      { name: 'One', command: append('order.txt', '1') },
      { name: 'Two', command: fail(3) },
      { name: 'Three', command: append('order.txt', '3') }
    ])
    expect(await run.done).toBe('failed')
    expect(await order()).toBe('1')
    expect(run.results.map((r) => r.status)).toEqual(['done', 'failed', 'skipped'])
    expect(run.results[1].exitCode).toBe(3)
  }, 30_000)

  it('stops a step that runs past its timeout and counts it as failed', async () => {
    const started = Date.now()
    const { run, order } = await go([
      { name: 'Slow', command: sleep(30_000), timeoutSec: 1 },
      { name: 'After', command: append('order.txt', 'x') }
    ])
    expect(await run.done).toBe('timed-out')
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(run.results.map((r) => r.status)).toEqual(['timed-out', 'skipped'])
    expect(await order()).toBe('')
  }, 30_000)

  it('retries a failed step once when asked, and only once', async () => {
    const flakyRun = await go([{ name: 'Flaky', command: flaky('seen') }, { name: 'Then', command: append('order.txt', 't') }], { retryOnce: true })
    expect(await flakyRun.run.done).toBe('done')
    expect(flakyRun.run.results[0]).toMatchObject({ status: 'done', attempts: 2 })
    expect(await flakyRun.order()).toBe('t')

    const broken = await go([{ name: 'Broken', command: `${append('order.txt', 'b')} && ${fail(2)}` }], { retryOnce: true })
    expect(await broken.run.done).toBe('failed')
    expect(await broken.order()).toBe('bb')
    expect(broken.run.results[0]).toMatchObject({ status: 'failed', attempts: 2 })

    const off = await go([{ name: 'Flaky', command: flaky('seen') }])
    expect(await off.run.done).toBe('failed')
  }, 30_000)

  it('carries on from a given step, keeping the earlier results', async () => {
    const previous: SetupStepResult[] = [
      { name: 'One', command: 'x', status: 'done', durationMs: 5, exitCode: 0, attempts: 1 },
      { name: 'Two', command: 'y', status: 'failed', exitCode: 1, attempts: 1 }
    ]
    const { run, order } = await go(
      [
        { name: 'One', command: append('order.txt', '1') },
        { name: 'Two', command: append('order.txt', '2') }
      ],
      { from: 1, previous }
    )
    expect(await run.done).toBe('done')
    expect(await order()).toBe('2')
    expect(run.results[0]).toEqual(previous[0])
    expect(run.results[1]).toMatchObject({ status: 'done', attempts: 2 })
  }, 30_000)

  it('Stop setup cancels the running step and skips the rest', async () => {
    const { run, order, changes } = await go([
      { name: 'Slow', command: sleep(30_000) },
      { name: 'After', command: append('order.txt', 'x') }
    ])
    for (let i = 0; i < 100 && !changes.some((c) => c[0].status === 'running'); i++) await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setTimeout(r, 300))
    const started = Date.now()
    await run.kill()
    expect(await run.done).toBe('stopped')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(run.results.map((r) => r.status)).toEqual(['stopped', 'skipped'])
    expect(await order()).toBe('')
  }, 30_000)
})

async function service() {
  const dataDir = await tempDir('foreman-steps-data-')
  const store = new Store(dataDir)
  await store.load()
  store.state.settings.workspacesRoot = await tempDir('foreman-steps-ws-')
  store.state.settings.branchPrefixType = 'custom'
  store.state.settings.branchPrefix = 'test/'
  const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const events: { step?: number; chunk: string }[] = []
  const environment = new Environment(secrets, () => store.state.settings, (id) => svc.repo(id))
  const svc: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog: (_id, chunk, step) => events.push({ chunk, step: step?.index }) }, environment)
  return { store, svc, events }
}

async function waitFor(ws: Workspace, states: Workspace['state'][]): Promise<void> {
  for (let i = 0; i < 400 && !states.includes(ws.state); i++) await new Promise((r) => setTimeout(r, 50))
  expect(states).toContain(ws.state)
}

describe('setup steps: a workspace', () => {
  it('Retry failed step carries on from the failed step without re-running the ones that passed', async () => {
    const repoDir = await makeRepo()
    const { svc } = await service()
    const repo = await svc.addRepo(repoDir)
    svc.updateRepoSettings(repo.id, {
      setupSteps: [
        { name: 'First', command: append('order.txt', '1') },
        { name: 'Gate', command: node(`if(!require('fs').existsSync('ok'))process.exit(5)`) },
        { name: 'Last', command: append('order.txt', '3') }
      ]
    })
    const ws = await svc.createWorkspace(repo.id)
    await waitFor(ws, ['ready', 'setup-failed', 'error'])
    expect(ws.state).toBe('setup-failed')
    expect(ws.setupRun?.steps.map((s) => s.status)).toEqual(['done', 'failed', 'skipped'])
    expect(ws.setupRun?.steps[1].exitCode).toBe(5)
    expect(await svc.setupLog(ws.id)).toContain('Setup failed at Gate (step 2 of 3) with exit code 5.')
    const runId = ws.setupRun!.id

    await writeFile(path.join(wsPath(ws), 'ok'), '')
    await svc.retrySetup(ws.id)
    expect(ws.state).toBe('ready')
    expect(ws.setupRun?.id).toBe(runId)
    expect(ws.setupRun?.steps.map((s) => s.status)).toEqual(['done', 'done', 'done'])
    expect(ws.setupRun?.steps[1].attempts).toBe(2)
    expect(await readFile(path.join(wsPath(ws), 'order.txt'), 'utf8')).toBe('13')
    const logs = await svc.setupStepLogs(ws.id)
    expect(logs?.runId).toBe(runId)
    expect(logs?.logs[1]).toContain('Retrying Gate (run 2).')
    expect(logs?.logs[0]).toContain('order.txt')

    // Run setup again starts a new run from the top.
    await svc.rerunSetup(ws.id)
    expect(ws.setupRun?.id).not.toBe(runId)
    expect(await readFile(path.join(wsPath(ws), 'order.txt'), 'utf8')).toBe('1313')
  }, 60_000)

  it('a single setup script runs as one step, logged as before', async () => {
    const repoDir = await makeRepo()
    const { svc } = await service()
    const repo = await svc.addRepo(repoDir)
    svc.updateRepoSettings(repo.id, { setupScript: append('done.txt', 'y') })
    const ws = await svc.createWorkspace(repo.id)
    await waitFor(ws, ['ready', 'setup-failed', 'error'])
    expect(ws.state).toBe('ready')
    expect(ws.setupRun?.steps).toMatchObject([{ name: 'Setup', status: 'done', exitCode: 0 }])
    const log = await svc.setupLog(ws.id)
    expect(log).toContain(`\n$ ${append('done.txt', 'y')}\n`)
    expect(log).toContain('\nSetup finished.\n')
  }, 60_000)

  it('Stop setup leaves the workspace as setup failed, and Retry failed step runs the stopped step again', async () => {
    const repoDir = await makeRepo()
    const { svc } = await service()
    const repo = await svc.addRepo(repoDir)
    svc.updateRepoSettings(repo.id, {
      setupSteps: [
        { name: 'Wait', command: node(`if(!require('fs').existsSync('go'))setTimeout(function(){},30000)`) },
        { name: 'After', command: append('order.txt', 'a') }
      ]
    })
    const ws = await svc.createWorkspace(repo.id)
    for (let i = 0; i < 400 && ws.setupRun?.steps[0].status !== 'running'; i++) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 300))
    await svc.stopSetup(ws.id)
    await waitFor(ws, ['setup-failed', 'ready', 'error'])
    expect(ws.state).toBe('setup-failed')
    expect(ws.setupRun?.steps.map((s) => s.status)).toEqual(['stopped', 'skipped'])
    expect(await svc.setupLog(ws.id)).toContain('Setup stopped at Wait (step 1 of 2).')

    await writeFile(path.join(wsPath(ws), 'go'), '')
    await svc.retrySetup(ws.id)
    expect(ws.state).toBe('ready')
    expect(ws.setupRun?.steps.map((s) => s.status)).toEqual(['done', 'done'])
  }, 60_000)
})

describe('setup steps: the preflight hold', () => {
  it('holds the first message while a step fails, and sends it once Retry failed step passes', async () => {
    const dir = await tempDir('foreman-steps-hold-')
    const store = new Store(dir)
    await store.load()
    store.state.settings.workspacesRoot = await tempDir('foreman-steps-hold-ws-')
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    const core = new Core(store, secrets, {
      broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
      openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
      metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
    })
    const send = vi.spyOn(core.sessions, 'send').mockResolvedValue('started')
    const repo = await core.workspaces.addRepo(await makeRepo())
    core.workspaces.updateRepoSettings(repo.id, {
      setupSteps: [
        { name: 'Install', command: append('order.txt', 'i') },
        { name: 'Gate', command: node(`if(!require('fs').existsSync('ok'))process.exit(7)`) }
      ]
    })
    const ws = await core.workspaces.createWorkspace(repo.id)
    const hold = () => (core as unknown as { firstMessages: Map<string, unknown> }).firstMessages.set(ws.id, { sessionId: 's1', text: 'do it' })
    const flush = () => (core as unknown as { sendFirstMessages(): void }).sendFirstMessages()
    hold()
    // `foreman run` waits for setup the same way.
    const outcome = await core.setupOutcome(ws.id, 60_000)
    expect(outcome.failed).toBe(true)
    flush()
    expect(send).not.toHaveBeenCalled()
    expect(ws.heldMessage).toMatchObject({ sessionId: 's1', text: 'do it' })

    await writeFile(path.join(wsPath(ws), 'ok'), '')
    await core.workspaces.retrySetup(ws.id)
    expect(ws.state).toBe('ready')
    flush()
    expect(send).toHaveBeenCalledWith('s1', 'do it')
    expect(ws.heldMessage).toBeUndefined()
    expect(await readFile(path.join(wsPath(ws), 'order.txt'), 'utf8')).toBe('i')
  }, 60_000)
})
