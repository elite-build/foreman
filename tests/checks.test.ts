import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChecksService, commandHash } from '../src/main/checks'
import { Store } from '../src/main/store'
import { isStale, summarizeChecks } from '../src/shared/checks'
import type { CheckCommand, CheckRow, Session, Workspace } from '../src/shared/types'
import { makeRepo, tempDir, nodeCommand } from './helpers'

async function setup(checks: CheckCommand[], opts: { timeoutMs?: number } = {}) {
  const dir = await makeRepo({ 'a.txt': 'one\n' })
  const dataDir = await tempDir('foreman-data-')
  const ws = { id: 'ws1', repoId: 'r1', name: 'tokyo', path: dir, state: 'ready' } as Workspace
  const sessions: Session[] = []
  const store = {
    state: { sessions, checkApprovals: undefined as Record<string, string[]> | undefined },
    logPath: (name: string) => path.join(dataDir, 'logs', name),
    save: () => undefined
  } as unknown as Store
  const config = { checks }
  const service = new ChecksService({
    store,
    workspace: () => ws,
    checks: () => config.checks,
    env: () => ({ PATH: process.env.PATH ?? '' }),
    changed: () => undefined,
    timeoutMs: opts.timeoutMs
  })
  return { dir, ws, sessions, store, config, service }
}

const check = (name: string, command: string, source: 'local' | 'shared' = 'shared'): CheckCommand => ({ name, command, source })

async function runApproved(service: ChecksService, options: { timeoutMs?: number } = {}) {
  const start = await service.start('ws1', { approve: true, ...options })
  if (start.kind !== 'started') throw new Error('expected a start')
  return start.done
}

describe('running checks', () => {
  it('records exit code, duration, start time, a full log and the fingerprint', async () => {
    const { service, ws, dir } = await setup([check('ok', 'echo fine'), check('bad', nodeCommand("console.error('broken'); process.exit(3)"))])
    const results = await runApproved(service)
    expect(results.map((r) => [r.name, r.status, r.exitCode])).toEqual([
      ['ok', 'passed', 0],
      ['bad', 'failed', 3]
    ])
    expect(await readFile(results[0].logPath, 'utf8')).toContain('fine')
    expect(await readFile(results[1].logPath, 'utf8')).toContain('broken')
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(new Date(results[0].startedAt).getTime()).toBeGreaterThan(0)
    expect(results[0].fingerprint).toMatchObject({ command: commandHash('echo fine'), source: 'shared' })
    expect(results[0].fingerprint.tree).toMatch(/^[0-9a-f]{40}$/)
    // Persisted on the workspace, no longer running.
    expect(ws.checks).toMatchObject({ running: false })
    expect(ws.checks!.results).toHaveLength(2)
    // The command ran in the workspace folder.
    await writeFile(path.join(dir, 'x'), '')
    const pwd = await setup([check('where', nodeCommand('console.log(process.cwd())'))])
    const [where] = await runApproved(pwd.service)
    expect((await readFile(where.logPath, 'utf8')).trim()).toContain(path.basename(pwd.dir))
  })

  it('stops a check that outlives its time limit', async () => {
    const { service } = await setup([check('slow', nodeCommand('setTimeout(() => {}, 5000)'))], { timeoutMs: 200 })
    const [slow] = await runApproved(service)
    expect(slow.status).toBe('timeout')
    expect(await readFile(slow.logPath, 'utf8')).toContain('time limit')
  })

  it('cancels a running check and runs nothing after it', async () => {
    const { service, ws } = await setup([check('slow', nodeCommand('setTimeout(() => {}, 5000)')), check('after', 'echo never')])
    const start = await service.start('ws1', { approve: true })
    if (start.kind !== 'started') throw new Error('expected a start')
    expect(ws.checks?.running).toBe(true)
    expect(service.isRunning('ws1')).toBe(true)
    await new Promise((r) => setTimeout(r, 150))
    await service.cancel('ws1')
    const results = await start.done
    expect(results.map((r) => [r.name, r.status])).toEqual([['slow', 'cancelled']])
    expect(service.isRunning('ws1')).toBe(false)
  })

  it('refuses a second run while one is going', async () => {
    const { service } = await setup([check('slow', nodeCommand('setTimeout(() => {}, 5000)'))])
    const start = await service.start('ws1', { approve: true })
    await expect(service.start('ws1', { approve: true })).rejects.toThrow('already running')
    await service.cancel('ws1')
    if (start.kind === 'started') await start.done
  })

  it('records a check interrupted by quit as interrupted, never as a pass', async () => {
    const { service, ws } = await setup([check('slow', nodeCommand('setTimeout(() => {}, 5000)'))])
    const start = await service.start('ws1', { approve: true })
    if (start.kind !== 'started') throw new Error('expected a start')
    await new Promise((r) => setTimeout(r, 150))
    await service.shutdown()
    await start.done
    expect(ws.checks!.results[0].status).toBe('interrupted')
    expect(ws.checks!.running).toBe(false)
  })

  it('turns a result left "running" by a crash into interrupted when state loads', async () => {
    const dataDir = await tempDir('foreman-data-')
    const result = { name: 'slow', command: nodeCommand('setTimeout(() => {}, 5000)'), status: 'running', startedAt: '', logPath: '', fingerprint: { tree: 't', command: 'c', source: 'shared' } }
    const ws = { id: 'w', repoId: 'r', name: 'n', state: 'ready', checks: { running: true, results: [result] } }
    await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 1, repos: [], workspaces: [ws], sessions: [], comments: [], settings: {} }))
    const store = new Store(dataDir)
    await store.load()
    expect(store.state.workspaces[0].checks).toMatchObject({ running: false, results: [{ status: 'interrupted' }] })
  })
})

describe('consent', () => {
  it('asks once for a new command, then not again, and asks again when it changes', async () => {
    const { service, config, ws } = await setup([check('test', 'echo one')])
    const first = await service.start('ws1')
    expect(first).toEqual({ kind: 'consent', items: [{ name: 'test', command: 'echo one', previous: undefined, source: 'shared' }] })
    expect(ws.checks).toBeUndefined()
    await runApproved(service)

    const again = await service.start('ws1')
    expect(again.kind).toBe('started')
    if (again.kind === 'started') await again.done

    config.checks = [check('test', 'echo two')]
    const changed = await service.start('ws1')
    expect(changed).toEqual({ kind: 'consent', items: [{ name: 'test', command: 'echo two', previous: 'echo one', source: 'shared' }] })
    // Only the changed command asks; an unchanged one doesn't.
    config.checks = [check('test', 'echo two'), check('lint', 'echo lint')]
    const items = service.consentNeeded('ws1').map((i) => i.name)
    expect(items).toEqual(['test', 'lint'])
  })

  it('stores approval per command hash, so reverting to an approved command runs without asking', async () => {
    const { service, config, store } = await setup([check('test', 'echo one')])
    await runApproved(service)
    config.checks = [check('test', 'echo two')]
    await runApproved(service)
    expect(store.state.checkApprovals!.r1).toEqual([commandHash('echo one'), commandHash('echo two')])
    config.checks = [check('test', 'echo one')]
    expect(service.consentNeeded('ws1')).toEqual([])
  })

  it('approves only the commands whose hashes it was given, and asks again for the rest', async () => {
    const { service, config, store, dir } = await setup([check('lint', 'echo lint'), check('slow', `touch ${path.join('.', 'slow-ran')}`)])
    // Approving one of two: the other comes back for consent, nothing runs, nothing but the shown hash is stored.
    const partial = await service.start('ws1', { approve: [commandHash('echo lint')] })
    expect(partial).toMatchObject({ kind: 'consent', items: [{ name: 'slow' }] })
    expect(store.state.checkApprovals).toBeUndefined()
    expect(existsSync(path.join(dir, 'slow-ran'))).toBe(false)
    // A hash of a command that has changed since it was shown approves nothing.
    config.checks = [check('lint', 'echo lint --fix'), check('slow', 'echo slow')]
    const stale = await service.start('ws1', { approve: [commandHash('echo lint'), commandHash('echo slow')] })
    expect(stale).toMatchObject({ kind: 'consent', items: [{ name: 'lint', command: 'echo lint --fix' }] })
    expect(store.state.checkApprovals).toBeUndefined()
    // Every unapproved command shown: they are approved (those hashes only) and the run starts.
    const hashes = [commandHash('echo lint --fix'), commandHash('echo slow')]
    const started = await service.start('ws1', { approve: hashes })
    expect(started.kind).toBe('started')
    if (started.kind === 'started') await started.done
    expect(store.state.checkApprovals!.r1.sort()).toEqual([...hashes].sort())
  })

  it('does not approve a command that was configured after the list was shown, even when others were', async () => {
    const { service, config, store } = await setup([check('a', 'echo a')])
    await runApproved(service)
    config.checks = [check('a', 'echo a'), check('b', 'echo b')]
    // `a` needs nothing; `b` was never shown.
    const result = await service.start('ws1', { approve: [commandHash('echo a')] })
    expect(result).toMatchObject({ kind: 'consent', items: [{ name: 'b' }] })
    expect(store.state.checkApprovals!.r1).toEqual([commandHash('echo a')])
  })

  it('does not run anything it was not allowed to', async () => {
    const { service, dir } = await setup([check('touch', `touch ${path.join('.', 'ran')}`)])
    await service.start('ws1')
    expect(existsSync(path.join(dir, 'ran'))).toBe(false)
  })
})

describe('staleness', () => {
  it('is fresh for the same tree, command and layer', async () => {
    const { service } = await setup([check('test', nodeCommand('process.exit(0)'))])
    await runApproved(service)
    const status = await service.status('ws1')
    expect(status.rows.map((r) => r.stale)).toEqual([false])
  })

  it('is stale when the command changed but the tree did not', async () => {
    const { service, config } = await setup([check('test', nodeCommand('process.exit(0)'))])
    await runApproved(service)
    config.checks = [check('test', nodeCommand('process.exitCode = 0'))]
    const status = await service.status('ws1')
    expect(status.rows[0].stale).toBe(true)
    expect(status.rows[0].result?.status).toBe('passed')
  })

  it('is stale when the settings layer changed, or the working tree did', async () => {
    const { service, config, dir, ws } = await setup([check('test', nodeCommand('process.exit(0)'))])
    await runApproved(service)
    config.checks = [check('test', nodeCommand('process.exit(0)'), 'local')]
    expect((await service.status('ws1')).rows[0].stale).toBe(true)
    config.checks = [check('test', nodeCommand('process.exit(0)'))]
    expect((await service.status('ws1')).rows[0].stale).toBe(false)
    await writeFile(path.join(dir, 'a.txt'), 'two\n')
    expect((await service.status('ws1')).rows[0].stale).toBe(true)
    // The flag the Needs-you list reads follows.
    expect(ws.checks!.stale).toBe(true)
  })

  it('treats a configured check with no result as stale, and hides results of removed checks', async () => {
    const { service, config } = await setup([check('a', nodeCommand('process.exit(0)'))])
    await runApproved(service)
    config.checks = [check('a', nodeCommand('process.exit(0)')), check('b', nodeCommand('process.exit(0)'))]
    const status = await service.status('ws1')
    expect(status.rows.map((r) => [r.name, r.stale])).toEqual([['a', false], ['b', true]])
    config.checks = [check('b', nodeCommand('process.exit(0)'))]
    expect((await service.status('ws1')).rows.map((r) => r.name)).toEqual(['b'])
  })

  it('compares fingerprints part by part', () => {
    const fp = { tree: 't', command: 'c', source: 'shared' as const }
    expect(isStale(fp, { ...fp })).toBe(false)
    expect(isStale(fp, { ...fp, tree: 'u' })).toBe(true)
    expect(isStale(fp, { ...fp, command: 'd' })).toBe(true)
    expect(isStale(fp, { ...fp, source: 'local' })).toBe(true)
  })
})

describe('the evidence row text', () => {
  const row = (name: string, status: CheckRow['result'] extends infer R ? (R extends { status: infer S } ? S : never) : never, stale = false): CheckRow => ({
    name,
    command: name,
    source: 'shared',
    stale,
    result: { name, command: name, status, startedAt: '', logPath: '', fingerprint: { tree: 't', command: 'c', source: 'shared' } }
  })
  const text = (rows: CheckRow[], extra: { running?: boolean; comments?: number | null } = {}) => summarizeChecks(rows, { running: false, ...extra }).text

  it('says what ran and never "verified"', () => {
    expect(text([row('test', 'passed'), row('lint', 'passed')])).toBe('Configured checks passed')
    expect(text([row('test', 'failed'), row('lint', 'passed'), row('types', 'passed')])).toBe('1 of 3 checks failed · test')
    expect(text([row('test', 'passed', true)])).toBe('Checks stale')
    expect(text([row('test', 'failed', true)])).toBe('Checks stale · 1 failed')
    expect(text([row('test', 'interrupted')])).toBe('Checks interrupted')
    expect(text([row('test', 'timeout'), row('lint', 'error')])).toBe('2 of 2 checks failed · test, lint')
    expect(text([{ ...row('test', 'passed'), result: undefined, stale: true }])).toBe('Checks not run')
    expect(summarizeChecks([row('test', 'passed')], { running: true }).text).toBe('Running checks…')
    for (const rows of [[row('a', 'passed')], [row('a', 'failed')], [row('a', 'passed', true)]]) expect(text(rows)).not.toMatch(/verif/i)
  })

  it('appends open comments only when the count is known', () => {
    expect(text([row('test', 'passed')], { comments: 2 })).toBe('Configured checks passed · 2 comments open')
    expect(text([row('test', 'passed')], { comments: 1 })).toBe('Configured checks passed · 1 comment open')
    expect(text([row('test', 'passed')], { comments: 0 })).toBe('Configured checks passed · 0 comments open')
    expect(text([row('test', 'passed')], { comments: null })).toBe('Configured checks passed')
    expect(text([row('test', 'passed')])).toBe('Configured checks passed')
  })
})
