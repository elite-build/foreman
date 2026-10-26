// O18 Docker cleanup on archive: the setting, the docker commands, Docker missing or
// stopped, and where the container step sits in #1's archive order. Docker itself is
// never needed: every test injects a stub runner.
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listContainers, removeContainers, type DockerResult, type DockerRunner } from '../src/main/docker'
import { Environment } from '../src/main/environment'
import { fromToml, patchLocal, resolveRepoSettings } from '../src/main/repoSettings'
import { SecretStore } from '../src/main/secrets'
import { StopSafely } from '../src/main/stopSafely'
import { defaultSettings, Store } from '../src/main/store'
import { WorkspaceService } from '../src/main/workspaces'
import { classifyFailure, composeSnippet, labelFilter, listArgs, parsePs, previewCount, removalNeedsAttention, removeArgs } from '../src/shared/docker'
import type { Repo } from '../src/shared/types'
import { wsPath } from '../src/shared/workspacePath'
import { makeRepo, tempDir } from './helpers'

const ps = (rows: { ID: string; Names: string; Image?: string; Status?: string; State?: string; Labels?: string }[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' })
const NOT_RUNNING_MAC = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
const NOT_RUNNING_WIN = 'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/containers/json": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'

/** A stub docker: answers `ps` with these containers and records every call. */
function stubDocker(containers: { id: string; name: string }[], wsId: () => string, rm: (id: string) => DockerResult = () => ok()) {
  const calls: string[][] = []
  const run: DockerRunner = async (args) => {
    calls.push(args)
    if (args[0] === 'ps') return ok(ps(containers.map((c) => ({ ID: c.id, Names: c.name, Image: 'postgres:16', Status: 'Up 26 hours', State: 'running', Labels: `com.docker.compose.project=ledger,foreman.workspace=${wsId()}` }))))
    if (args[0] === 'rm') return rm(args[args.length - 1])
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }
  return { run, calls }
}

describe('the setting', () => {
  const mkRepo = (root: string): Repo => ({ id: 'r', name: 'r', rootPath: root, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: '' })

  it('reads [archive] remove_docker_containers from settings.toml', () => {
    expect(fromToml({ archive: { remove_docker_containers: true } }).values.removeDockerContainers).toBe(true)
    expect(fromToml({ archive: { remove_docker_containers: false } }).values.removeDockerContainers).toBe(false)
    expect(fromToml({}).values.removeDockerContainers).toBeUndefined()
  })

  it('is off by default, layers shared under local, and resets to inherit', async () => {
    const root = await makeRepo()
    const repo = mkRepo(root)
    expect(resolveRepoSettings(repo, defaultSettings()).values.removeDockerContainers).toBe(false)

    await mkdir(path.join(root, '.foreman'))
    await writeFile(path.join(root, '.foreman', 'settings.toml'), '[archive]\nremove_docker_containers = true\n')
    let resolved = resolveRepoSettings(repo, defaultSettings())
    expect(resolved.values.removeDockerContainers).toBe(true)
    expect(resolved.sources.removeDockerContainers).toBe('shared')

    repo.local = patchLocal(repo.local, { removeDockerContainers: false })
    resolved = resolveRepoSettings(repo, defaultSettings())
    expect(resolved.values.removeDockerContainers).toBe(false)
    expect(resolved.sources.removeDockerContainers).toBe('local')
    expect(resolved.inherited.removeDockerContainers).toBe('shared')

    repo.local = patchLocal(repo.local, { removeDockerContainers: null })
    expect(resolveRepoSettings(repo, defaultSettings()).values.removeDockerContainers).toBe(true)
  })
})

describe('docker commands', () => {
  it('filters by the workspace label only, running and stopped', () => {
    expect(labelFilter('ws-1')).toBe('label=foreman.workspace=ws-1')
    expect(listArgs('ws-1')).toEqual(['ps', '--all', '--no-trunc', '--filter', 'label=foreman.workspace=ws-1', '--format', '{{json .}}'])
  })

  it('removes containers by id with rm -f, and never volumes', () => {
    expect(removeArgs(['abc'])).toEqual(['rm', '--force', 'abc'])
    expect(removeArgs(['abc'])).not.toContain('-v')
    expect(removeArgs(['abc'])).not.toContain('--volumes')
  })

  it('parses docker ps JSON lines and double-checks the label', () => {
    const out = ps([
      { ID: 'a1', Names: 'ledger-quito-db-1', Image: 'postgres:16', Status: 'Up 26 hours', State: 'running', Labels: 'foreman.workspace=ws-1' },
      { ID: 'b2', Names: 'someone-else', Labels: 'foreman.workspace=ws-2' },
      { ID: 'c3', Names: 'no-labels-field' }
    ])
    expect(parsePs(`WARNING: something\n${out}`, 'ws-1').map((c) => c.name)).toEqual(['ledger-quito-db-1', 'no-labels-field'])
    expect(parsePs(out, 'ws-1')[0]).toEqual({ id: 'a1', name: 'ledger-quito-db-1', image: 'postgres:16', status: 'Up 26 hours', state: 'running' })
  })

  it('offers a compose snippet that uses FOREMAN_WORKSPACE_ID', () => {
    expect(composeSnippet(['db'])).toBe('services:\n  db:\n    labels:\n      foreman.workspace: ${FOREMAN_WORKSPACE_ID}')
  })
})

describe('docker missing or not running', () => {
  it('tells missing, not running and other failures apart', () => {
    expect(classifyFailure({ spawnError: 'ENOENT' })).toBe('missing')
    expect(classifyFailure({ stderr: NOT_RUNNING_MAC })).toBe('not-running')
    expect(classifyFailure({ stderr: NOT_RUNNING_WIN })).toBe('not-running')
    expect(classifyFailure({ stderr: 'permission denied while trying to connect' })).toBe('error')
  })

  it('lists as a status, never throwing', async () => {
    expect(await listContainers('ws', async () => ({ code: -1, stdout: '', stderr: '', spawnError: 'ENOENT' }))).toEqual({ status: 'missing' })
    expect(await listContainers('ws', async () => ({ code: 1, stdout: '', stderr: NOT_RUNNING_MAC }))).toEqual({ status: 'not-running' })
    expect(await listContainers('ws', async () => ({ code: 1, stdout: '', stderr: 'boom\nmore' }))).toEqual({ status: 'error', detail: 'boom' })
    expect(await listContainers('ws', async () => Promise.reject(new Error('spawn failed')))).toEqual({ status: 'error', detail: 'spawn failed' })
  })

  it('removes nothing when Docker is down, and reports each container that would not go', async () => {
    expect(await removeContainers('ws', async () => ({ code: 1, stdout: '', stderr: NOT_RUNNING_WIN }))).toEqual({ status: 'not-running', removed: [], failed: [] })
    const docker = stubDocker([{ id: 'a1', name: 'db' }, { id: 'b2', name: 'redis' }], () => 'ws', (id) => (id === 'a1' ? { code: 1, stdout: '', stderr: 'Error: container is paused' } : ok()))
    const removal = await removeContainers('ws', docker.run)
    expect(removal).toEqual({ status: 'ok', removed: ['redis'], failed: [{ name: 'db', detail: 'Error: container is paused' }] })
    expect(docker.calls.filter((a) => a[0] === 'rm')).toEqual([['rm', '--force', 'a1'], ['rm', '--force', 'b2']])
    expect(removalNeedsAttention(removal)).toBe(true)
    expect(removalNeedsAttention({ status: 'ok', removed: ['db'], failed: [] })).toBe(false)
    expect(removalNeedsAttention({ status: 'missing', removed: [], failed: [] })).toBe(true)
  })

  it('counts the preview only when Docker answered', () => {
    expect(previewCount({ enabled: true, status: 'ok', containers: [] })).toBe(0)
    expect(previewCount({ enabled: true, status: 'not-running' })).toBeNull()
    expect(previewCount({ enabled: false })).toBeNull()
  })
})

describe('archive removes labelled containers as its own step', () => {
  async function setup() {
    const dataDir = await tempDir('foreman-docker-data-')
    const store = new Store(dataDir)
    await store.load()
    store.state.settings.workspacesRoot = await tempDir('foreman-docker-ws-')
    const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    const environment = new Environment(secrets, () => store.state.settings, (id) => service.repo(id))
    const service: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog() {} }, environment)
    const repo = await service.addRepo(await makeRepo({ 'a.txt': 'base\n' }))
    const ws = await service.createWorkspace(repo.id)
    for (let i = 0; i < 300 && ws.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50))
    expect(ws.state).toBe('ready')
    const stop = new StopSafely({
      store, sessions: { cancel: async () => {}, cancelTurn: async () => null } as never, workspaces: service,
      terminals: () => [], stopChecks: async () => {}, killTerminals: () => {}, forgetTerminals: () => {}, stopSpotlight: async () => {},
      disposeSessions: async () => {}, quit: () => {}, changed: () => {}
    })
    return { store, service, repo, ws, stop, dataDir }
  }

  it('sets FOREMAN_WORKSPACE_ID for scripts and terminals', async () => {
    const { service, ws } = await setup()
    expect(service.scriptEnv(ws).FOREMAN_WORKSPACE_ID).toBe(ws.id)
  })

  it('runs after the archive script and before the folder is removed, touching only labelled containers', async () => {
    const { service, repo, ws, stop, dataDir } = await setup()
    const marker = path.join(dataDir, 'script-ran')
    service.updateRepoSettings(repo.id, { archiveScript: `echo done > "${marker}"`, removeDockerContainers: true })
    const order: string[] = []
    const docker = stubDocker([{ id: 'a1', name: 'ledger-quito-db-1' }, { id: 'b2', name: 'ledger-quito-redis-1' }], () => ws.id)
    service.docker = async (args) => {
      order.push(`${args[0]} script:${existsSync(marker)} folder:${existsSync(wsPath(ws))}`)
      return docker.run(args)
    }

    const preview = await stop.archivePreview(ws.id)
    expect(preview.docker).toMatchObject({ enabled: true, status: 'ok', containers: [{ name: 'ledger-quito-db-1' }, { name: 'ledger-quito-redis-1' }] })
    order.length = 0

    const outcome = await stop.archive(ws.id, false, { stopTabs: true })
    expect(outcome).toEqual({ ok: true, docker: { status: 'ok', removed: ['ledger-quito-db-1', 'ledger-quito-redis-1'], failed: [] } })
    // The script had run and the folder was still there for every docker call.
    expect(order).toEqual(['ps script:true folder:true', 'rm script:true folder:true', 'rm script:true folder:true'])
    expect(docker.calls.find((a) => a[0] === 'ps')).toContain(`label=foreman.workspace=${ws.id}`)
    expect(existsSync(wsPath(ws))).toBe(false)
    expect(ws.state).toBe('archived')
  })

  it('archives anyway when Docker is down or a container won’t go, and says so', async () => {
    const down = await setup()
    down.service.updateRepoSettings(down.repo.id, { removeDockerContainers: true })
    down.service.docker = async () => ({ code: 1, stdout: '', stderr: NOT_RUNNING_MAC })
    expect((await down.stop.archivePreview(down.ws.id)).docker).toEqual({ enabled: true, status: 'not-running' })
    expect(await down.stop.archive(down.ws.id, false)).toEqual({ ok: true, docker: { status: 'not-running', removed: [], failed: [] } })
    expect(down.ws.state).toBe('archived')

    const stuck = await setup()
    stuck.service.updateRepoSettings(stuck.repo.id, { removeDockerContainers: true })
    stuck.service.docker = stubDocker([{ id: 'a1', name: 'db' }], () => stuck.ws.id, () => ({ code: 1, stdout: '', stderr: 'Error response from daemon: cannot remove' })).run
    const outcome = await stuck.stop.archive(stuck.ws.id, false)
    expect(outcome).toEqual({ ok: true, docker: { status: 'ok', removed: [], failed: [{ name: 'db', detail: 'Error response from daemon: cannot remove' }] } })
    expect(existsSync(wsPath(stuck.ws))).toBe(false)
    expect(stuck.ws.state).toBe('archived')
  })

  it('never calls docker when the setting is off', async () => {
    const { service, ws, stop } = await setup()
    const calls: string[][] = []
    service.docker = async (args) => (calls.push(args), ok())
    expect((await stop.archivePreview(ws.id)).docker).toEqual({ enabled: false })
    expect(await stop.archive(ws.id, false)).toEqual({ ok: true })
    expect(calls).toEqual([])
  })
})
