import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHECKS_EXIT, socketPath, type ChecksCliResult, type CliRequest, type CliResponse } from '../src/cli/protocol'
import { ChecksService } from '../src/main/checks'
import { resolveRepo, resolveWorkspace, startCliServer, type CliHost } from '../src/main/cliServer'
import { defaultSettings, type Store } from '../src/main/store'
import { git } from '../src/main/git'
import { fillTemplate, findTemplate, templatePlaceholders, templateSlug } from '../src/shared/promptTemplates'
import type { CheckCommand, CreateWorkspaceOptions, Repo, Session, Workspace } from '../src/shared/types'
import { stubHost } from './cliHost'
import { makeRepo, tempDir, nodeCommand } from './helpers'

const t = (name: string, body = '') => ({ id: `id-${name}`, name, body })

const repo = (name: string, rootPath: string) => ({ id: `repo-${name}`, name, rootPath }) as Repo
const workspace = (repoId: string, wsPath: string) => ({ id: `ws-${wsPath}`, repoId, path: wsPath, state: 'ready' }) as Workspace

describe('finding a template from the command line', () => {
  const list = [t('Fix a bug'), t('Fix a flaky test'), t('Write tests'), t('Review my changes')]

  it('matches id, name or slug exactly', () => {
    expect(templateSlug('Fix a bug')).toBe('fix-a-bug')
    expect(templateSlug('  Review: my changes! ')).toBe('review-my-changes')
    const name = (q: string) => {
      const found = findTemplate(list, q)
      return 'template' in found ? found.template.name : found.error
    }
    expect(name('id-Write tests')).toBe('Write tests')
    expect(name('fix a bug')).toBe('Fix a bug')
    expect(name('fix-a-bug')).toBe('Fix a bug')
    expect(name('review')).toBe('Review my changes')
    expect(name('flaky')).toBe('Fix a flaky test')
  })

  it('refuses ambiguous and unknown names', () => {
    expect(findTemplate(list, 'fix')).toEqual({ error: '“fix” matches several templates: fix-a-bug, fix-a-flaky-test' })
    expect(findTemplate(list, 'deploy')).toEqual({ error: 'No template named “deploy”' })
    expect(findTemplate(list, ' ')).toEqual({ error: 'Name a template' })
  })
})

describe('filling a template', () => {
  it('lists distinct placeholders in order', () => {
    expect(templatePlaceholders('Fix {{ bug }} in {{file}}, then close {{bug}}')).toEqual(['bug', 'file'])
  })

  it('fills placeholders in order and repeats shared ones', () => {
    expect(fillTemplate('Fix {{bug}} in {{file}}; close {{ bug }}', ['ENG-1', 'a.ts'])).toEqual({ text: 'Fix ENG-1 in a.ts; close ENG-1' })
  })

  it('joins extra values into the last placeholder', () => {
    expect(fillTemplate('Fix this bug: {{what}}', ['login', 'button', 'does', 'nothing'])).toEqual({ text: 'Fix this bug: login button does nothing' })
  })

  it('reports missing values and values with nowhere to go', () => {
    expect(fillTemplate('Refactor {{file}} to {{goal}}', ['a.ts'])).toEqual({ error: 'Missing a value for {{goal}}' })
    expect(fillTemplate('Review it', [])).toEqual({ text: 'Review it' })
    expect(fillTemplate('Review it', ['x'])).toEqual({ error: 'This template has no {{placeholders}} to fill' })
  })
})

describe('picking the repository', () => {
  it('uses --repo by name, id or folder', async () => {
    const dir = await tempDir()
    const state = { repos: [repo('api', path.join(dir, 'api')), repo('web', path.join(dir, 'web'))], workspaces: [] }
    expect((await resolveRepo(state, dir, 'WEB')).name).toBe('web')
    expect((await resolveRepo(state, dir, 'repo-api')).name).toBe('api')
    expect((await resolveRepo(state, dir, './api')).name).toBe('api')
    await expect(resolveRepo(state, dir, 'nope')).rejects.toThrow('No repository named “nope”. Repositories: api, web')
  })

  it('uses the repository or workspace the command runs in', async () => {
    const dir = await tempDir()
    const api = path.join(dir, 'api')
    const web = path.join(dir, 'web')
    // A workspace kept inside the other repository's folder belongs to its own repository.
    const nested = path.join(api, '.worktrees', 'tokyo')
    await mkdir(path.join(nested, 'src'), { recursive: true })
    await mkdir(web, { recursive: true })
    const state = { repos: [repo('api', api), repo('web', web)], workspaces: [workspace('repo-web', nested)] }
    expect((await resolveRepo(state, path.join(api, '.worktrees'))).name).toBe('api')
    expect((await resolveRepo(state, path.join(nested, 'src'))).name).toBe('web')
    expect((await resolveRepo(state, web)).name).toBe('web')
  })

  it('recognises a worktree Foreman did not create', async () => {
    const main = await makeRepo()
    const other = path.join(await tempDir(), 'side')
    await git(main, ['worktree', 'add', '-q', '-b', 'side', other])
    const state = { repos: [repo('main', main), repo('elsewhere', await tempDir())], workspaces: [] }
    expect((await resolveRepo(state, other)).name).toBe('main')
  })

  it('falls back to the only repository, and asks otherwise', async () => {
    const outside = await tempDir()
    expect((await resolveRepo({ repos: [repo('solo', await tempDir())], workspaces: [] }, outside)).name).toBe('solo')
    const two = { repos: [repo('a', await tempDir()), repo('b', await tempDir())], workspaces: [] }
    await expect(resolveRepo(two, outside)).rejects.toThrow('pass --repo')
    await expect(resolveRepo({ repos: [], workspaces: [] }, outside)).rejects.toThrow('Add a repository')
  })
})

describe('the command-line socket', () => {
  let close: (() => void) | undefined
  afterEach(() => close?.())

  async function serve(outcome = { failed: false, held: false, logTail: '' }) {
    const dataDir = await tempDir()
    const repoDir = await tempDir()
    const created: { repoId: string; options: CreateWorkspaceOptions }[] = []
    const revealed: string[] = []
    const startedHeld: string[] = []
    const settings = { ...defaultSettings(), promptTemplates: [t('Fix linear bug', 'Fix {{bug id}} and open a PR for {{bug id}}.')] }
    const host: CliHost = stubHost({
      state: () => ({ repos: [repo('app', repoDir)], workspaces: [], sessions: [], settings }),
      createWorkspace: async (repoId, options) => {
        created.push({ repoId, options })
        return { id: 'ws-1', name: 'lisbon', branch: 'fix-eng-42', path: '/tmp/lisbon' } as Workspace
      },
      reveal: (id) => revealed.push(id),
      setupOutcome: async () => outcome,
      startHeldMessage: async (id) => void startedHeld.push(id),
      runChecks: async (id) => ({ workspace: { id, name: 'lisbon' }, outcome: 'passed', results: [] })
    })
    const socket = socketPath(dataDir)
    const server = await startCliServer(socket, host)
    close = () => server.close()
    const send = (req: CliRequest | string) =>
      new Promise<CliResponse>((resolve, reject) => {
        const conn = net.createConnection(socket, () => conn.write(`${typeof req === 'string' ? req : JSON.stringify(req)}\n`))
        let out = ''
        conn.setEncoding('utf8')
        conn.on('data', (chunk: string) => (out += chunk))
        conn.on('end', () => resolve(JSON.parse(out) as CliResponse))
        conn.on('error', reject)
      })
    return { send, created, revealed, repoDir, startedHeld }
  }

  it('starts a workspace with the filled-in template', async () => {
    const { send, created, revealed, repoDir } = await serve()
    const response = await send({ method: 'run', params: { template: 'fix-linear-bug', values: ['ENG-42'], cwd: repoDir, branch: 'fix/eng-42', open: true } })
    expect(response).toEqual({
      ok: true,
      result: {
        template: 'Fix linear bug',
        repo: 'app',
        prompt: 'Fix ENG-42 and open a PR for ENG-42.',
        workspace: { id: 'ws-1', name: 'lisbon', branch: 'fix-eng-42', path: '/tmp/lisbon' }
      }
    })
    expect(created).toEqual([
      { repoId: 'repo-app', options: { prompt: 'Fix ENG-42 and open a PR for ENG-42.', templateId: 'id-Fix linear bug', githubUrl: undefined, linearIssue: 'ENG-42', baseBranch: undefined, branch: { kind: 'new', name: 'fix/eng-42' }, loadout: undefined } }
    ])
    expect(revealed).toEqual(['ws-1'])
  })

  it('reports a held first message when setup fails, and can start anyway', async () => {
    const failed = { failed: true, held: true, logTail: 'npm ERR! boom' }
    const params = { template: 'fix-linear-bug', values: ['ENG-42'], cwd: '' }
    const first = await serve(failed)
    expect(await first.send({ method: 'run', params: { ...params, cwd: first.repoDir } })).toMatchObject({
      ok: true,
      result: { held: { logTail: 'npm ERR! boom' } }
    })
    expect(first.startedHeld).toEqual([])
    const second = await serve(failed)
    const response = await second.send({ method: 'run', params: { ...params, cwd: second.repoDir, startAnyway: true } })
    expect(response).toMatchObject({ ok: true, result: { startedAnyway: true } })
    expect(response).not.toMatchObject({ result: { held: expect.anything() } })
    expect(second.startedHeld).toEqual(['ws-1'])
  })

  it('picks a loadout slot', async () => {
    const { send, created, repoDir } = await serve()
    await send({ method: 'run', params: { template: 'fix', values: ['ENG-1'], cwd: repoDir, loadout: 2 } })
    expect(created[0].options.loadout).toEqual(defaultSettings().loadouts[1])
    const missing = await send({ method: 'run', params: { template: 'fix', values: ['ENG-1'], cwd: repoDir, loadout: 99 } })
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('no loadout 99') })
  })

  it('creates nothing on a dry run or a bad request', async () => {
    const { send, created, repoDir } = await serve()
    expect(await send({ method: 'run', params: { template: 'fix', values: ['ENG-7'], cwd: repoDir, dryRun: true } })).toEqual({
      ok: true,
      result: { template: 'Fix linear bug', repo: 'app', prompt: 'Fix ENG-7 and open a PR for ENG-7.' }
    })
    expect(await send({ method: 'run', params: { template: 'fix', values: [], cwd: repoDir } })).toEqual({
      ok: false,
      error: 'Fix linear bug: Missing a value for {{bug id}}'
    })
    expect(await send('not json')).toEqual({ ok: false, error: 'Malformed request' })
    expect(created).toEqual([])
  })

  it('lists templates and repositories', async () => {
    const { send, repoDir } = await serve()
    expect(await send({ method: 'templates' })).toEqual({ ok: true, result: [{ slug: 'fix-linear-bug', name: 'Fix linear bug', placeholders: ['bug id'] }] })
    expect(await send({ method: 'repos' })).toEqual({ ok: true, result: [{ name: 'app', path: repoDir }] })
  })
})

describe('foreman checks', () => {
  async function setupChecks(checks: CheckCommand[], timeoutMs?: number) {
    const dir = await makeRepo()
    const dataDir = await tempDir('foreman-data-')
    const ws = { id: 'ws1', repoId: 'r1', name: 'tokyo', path: dir, state: 'ready' } as Workspace
    const sessions: Session[] = []
    const store = { state: { sessions }, logPath: (name: string) => path.join(dataDir, 'logs', name), save: () => undefined } as unknown as Store
    const config = { checks }
    const service = new ChecksService({ store, workspace: () => ws, checks: () => config.checks, env: () => ({ PATH: process.env.PATH ?? '' }), changed: () => undefined, timeoutMs })
    return { dir, ws, sessions, config, service }
  }
  const sh = (name: string, command: string): CheckCommand => ({ name, command, source: 'shared' })
  // The consent dialog is where a command gets approved; `foreman checks` only runs approved ones.
  const approved = async (s: Awaited<ReturnType<typeof setupChecks>>) => {
    const start = await s.service.start('ws1', { approve: true })
    if (start.kind === 'started') await start.done
  }

  it('maps outcomes to exit codes', () => {
    expect(CHECKS_EXIT).toEqual({ passed: 0, failed: 1, error: 2, 'not-configured': 3, busy: 4 })
  })

  it('finds the workspace by the folder the command runs in', () => {
    const state = { workspaces: [workspace('r', '/w/a'), workspace('r', '/w/a/nested'), { ...workspace('r', '/w/b'), state: 'archived' } as Workspace] }
    expect(resolveWorkspace(state, '/w/a/src').path).toBe('/w/a')
    expect(resolveWorkspace(state, '/w/a/nested/x').path).toBe('/w/a/nested')
    expect(() => resolveWorkspace(state, '/w/b')).toThrow('inside one of Foreman’s workspaces')
    expect(() => resolveWorkspace(state, '/elsewhere')).toThrow()
  })

  it('exits 0 when everything passes and records the same results as the Git panel', async () => {
    const s = await setupChecks([sh('test', 'echo ok')])
    await approved(s)
    const result = await s.service.runForCli('ws1')
    expect(result).toMatchObject({ outcome: 'passed', workspace: { id: 'ws1' }, results: [{ name: 'test', status: 'passed', exitCode: 0 }] })
    expect(CHECKS_EXIT[result.outcome]).toBe(0)
    // The record on the workspace is the one the panel shows.
    expect(s.ws.checks!.results[0]).toMatchObject({ name: 'test', status: 'passed', logPath: result.results[0].logPath })
    expect((await s.service.status('ws1')).rows[0].stale).toBe(false)
  })

  it('exits 1 when a check fails, with its exit code', async () => {
    const s = await setupChecks([sh('test', 'exit 7'), sh('lint', nodeCommand('process.exit(0)'))])
    await approved(s)
    const result = await s.service.runForCli('ws1')
    expect(result.outcome).toBe('failed')
    expect(result.results.map((r) => [r.name, r.status, r.exitCode])).toEqual([['test', 'failed', 7], ['lint', 'passed', 0]])
    expect(CHECKS_EXIT[result.outcome]).toBe(1)
  })

  it('exits 2 when a command needs approval, and runs nothing', async () => {
    const s = await setupChecks([sh('touch', nodeCommand("require('node:fs').writeFileSync('ran', '')"))])
    const result = await s.service.runForCli('ws1')
    expect(result).toMatchObject({ outcome: 'error', results: [], message: expect.stringContaining('need approval') })
    expect(CHECKS_EXIT[result.outcome]).toBe(2)
    expect(s.ws.checks).toBeUndefined()
  })

  it('exits 2 on a timeout', async () => {
    const s = await setupChecks([sh('slow', nodeCommand('setTimeout(() => {}, 5000)'))], 200)
    await approved(s)
    const result = await s.service.runForCli('ws1')
    expect(result).toMatchObject({ outcome: 'error', results: [{ status: 'timeout' }] })
    expect(CHECKS_EXIT[result.outcome]).toBe(2)
  })

  it('exits 3 when no checks are configured', async () => {
    const s = await setupChecks([])
    const result = await s.service.runForCli('ws1')
    expect(result).toMatchObject({ outcome: 'not-configured', results: [] })
    expect(CHECKS_EXIT[result.outcome]).toBe(3)
  })

  it('exits 4 at once when an agent turn is active, without running anything (no deadlock)', async () => {
    const s = await setupChecks([sh('touch', nodeCommand("require('node:fs').writeFileSync('ran', '')"))])
    await approved(s)
    await rm(path.join(s.dir, 'ran'), { force: true })
    s.sessions.push({ id: 's1', workspaceId: 'ws1', status: 'running' } as Session)
    const started = Date.now()
    const result = await s.service.runForCli('ws1')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(result).toMatchObject({ outcome: 'busy', results: [] })
    expect(CHECKS_EXIT[result.outcome]).toBe(4)
    expect(existsSync(path.join(s.dir, 'ran'))).toBe(false)
    // Once the turn ends it runs.
    s.sessions[0].status = 'idle'
    expect((await s.service.runForCli('ws1')).outcome).toBe('passed')
    expect(existsSync(path.join(s.dir, 'ran'))).toBe(true)
  })

  it('serves the request over the socket', async () => {
    const dataDir = await tempDir()
    const repoDir = await tempDir()
    const seen: string[] = []
    const result: ChecksCliResult = { workspace: { id: 'ws-1', name: 'lisbon' }, outcome: 'failed', results: [] }
    const host = stubHost({
      state: () => ({ repos: [], workspaces: [workspace('repo-app', repoDir)], sessions: [], settings: defaultSettings() }),
      runChecks: async (id) => (seen.push(id), result)
    })
    const socket = socketPath(dataDir)
    const server = await startCliServer(socket, host)
    try {
      const response = await new Promise<CliResponse>((resolve, reject) => {
        const conn = net.createConnection(socket, () => conn.write(`${JSON.stringify({ method: 'checks', params: { cwd: repoDir } } satisfies CliRequest)}\n`))
        let out = ''
        conn.setEncoding('utf8')
        conn.on('data', (chunk: string) => (out += chunk))
        conn.on('end', () => resolve(JSON.parse(out) as CliResponse))
        conn.on('error', reject)
      })
      expect(response).toEqual({ ok: true, result })
      expect(seen).toEqual([`ws-${repoDir}`])
    } finally {
      server.close()
    }
  })
})

describe('socket path', () => {
  it('stays short enough for a Unix socket and uses a pipe on Windows', () => {
    expect(socketPath('/data', 'darwin')).toBe(path.join('/data', 'cli.sock'))
    const long = socketPath(`/${'x'.repeat(120)}`, 'linux')
    expect(long).toMatch(/foreman-[0-9a-f]{12}\.sock$/)
    expect(socketPath('C:\\Users\\me\\AppData\\Roaming\\Foreman', 'win32')).toMatch(/^\\\\\.\\pipe\\foreman-[0-9a-f]{12}$/)
  })
})
