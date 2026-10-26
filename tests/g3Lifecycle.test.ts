// G3: lifecycle items. Archive steps and parallel groups (O19), archive progress and the Esc rule (#1),
// the diff kept at archive time and forking an archived chat (#13), Docker's leftovers and extras (O18),
// rows that finished while Foreman was closed and terminals that ended at quit (O10), drops on a terminal
// (O21), and terminal colours and folders kept for restore (O3).
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeContainers, type DockerResult, type DockerRunner } from '../src/main/docker'
import { Environment } from '../src/main/environment'
import { fromToml, patchLocal, resolveRepoSettings } from '../src/main/repoSettings'
import { SecretStore } from '../src/main/secrets'
import { runSetupSteps } from '../src/main/setupSteps'
import { StopSafely } from '../src/main/stopSafely'
import { existingFolder, TerminalRestore } from '../src/main/terminalRestore'
import { defaultSettings, Store } from '../src/main/store'
import { WorkspaceService } from '../src/main/workspaces'
import { finishedWhileClosed, reconnectRecord } from '../src/shared/agentHost'
import { dockerLeft, networkRemoveArgs, networksArgs, parseNetworks, removeArgs } from '../src/shared/docker'
import { imageDiffSides, swipePercent } from '../src/shared/imageDiff'
import { cleanSteps, sameSteps, scriptAsSteps, stepGroups, stepsPatch } from '../src/shared/setupSteps'
import { quitWaitEscape } from '../src/shared/stopSafely'
import {
  dimHistory,
  keepSgr,
  osc7Folder,
  osc99Folder,
  parseSavedTerminals,
  restoredLabel,
  styledFromSerialized,
  trimStyled
} from '../src/shared/terminalTabs'
import { createT } from '../src/shared/i18n'
import type { ArchiveProgress, Repo, SetupStep, SetupStepResult } from '../src/shared/types'
import { wsPath } from '../src/shared/workspacePath'
import { OWN_DROP_SELECTOR, terminalDropText } from '../src/renderer/src/components/dropPlan'
import { makeRepo, tempDir } from './helpers'

const node = (js: string) => `node -e "${js}"`
const slash = (p: string) => p.replace(/\\/g, '/')
const append = (file: string, text: string) => node(`require('fs').appendFileSync('${slash(file)}','${text}')`)
const fail = (code: number) => node(`process.exit(${code})`)

// ---- O19: steps in parallel groups, and the archive script as steps ----

describe('parallel groups', () => {
  it('groups consecutive parallel steps; a lone parallel step runs on its own', () => {
    const s = (parallel?: boolean): Pick<SetupStep, 'parallel'> => (parallel ? { parallel } : {})
    expect(stepGroups([s(), s(true), s(true), s(), s(true)])).toEqual([[0], [1, 2], [3], [4]])
    expect(stepGroups([s(true), s(true), s(true)])).toEqual([[0, 1, 2]])
    expect(stepGroups([])).toEqual([])
  })

  it('keeps the parallel mark through cleaning, comparing and storing', () => {
    const steps: SetupStep[] = [
      { name: 'Up', command: 'docker compose up -d', parallel: true },
      { name: 'Seed', command: 'npm run seed', parallel: true }
    ]
    expect(cleanSteps(steps)).toEqual(steps)
    expect(sameSteps(steps, [{ ...steps[0], parallel: false }, steps[1]])).toBe(false)
    expect(stepsPatch(steps)).toEqual({ setupSteps: steps, setupScript: null })
  })

  it('runs a group at the same time and the next step after all of it', async () => {
    const dir = await tempDir('foreman-parallel-')
    const log = path.join(dir, 'log.txt')
    // Each parallel step marks its start, waits, then marks its end; both starts come before either end.
    const timed = (name: string) => node(`const f=require('fs');f.appendFileSync('${slash(log)}','${name}+');setTimeout(function(){f.appendFileSync('${slash(log)}','${name}-')},700)`)
    const steps: SetupStep[] = [
      { name: 'A', command: timed('A'), parallel: true },
      { name: 'B', command: timed('B'), parallel: true },
      { name: 'C', command: append(log, 'C') }
    ]
    const run = runSetupSteps({ steps, cwd: dir, env: process.env as Record<string, string>, onOutput: () => {}, onChange: () => {} })
    expect(await run.done).toBe('done')
    const text = await readFile(log, 'utf8')
    expect(text.indexOf('A+')).toBeLessThan(text.indexOf('B-'))
    expect(text.indexOf('B+')).toBeLessThan(text.indexOf('A-'))
    expect(text.endsWith('C')).toBe(true)
    expect(run.results.map((r) => r.parallel ?? false)).toEqual([true, true, false])
  }, 20_000)

  it('stops after a group with a failed step, lets its siblings finish, and carries on from that step alone', async () => {
    const dir = await tempDir('foreman-parallel-')
    const log = path.join(dir, 'log.txt')
    const steps: SetupStep[] = [
      { name: 'ok', command: append(log, 'ok;'), parallel: true },
      { name: 'bad', command: fail(3), parallel: true },
      { name: 'after', command: append(log, 'after;') }
    ]
    let results: SetupStepResult[] = []
    const first = runSetupSteps({ steps, cwd: dir, env: process.env as Record<string, string>, onOutput: () => {}, onChange: (r) => (results = r) })
    expect(await first.done).toBe('failed')
    expect(results.map((r) => r.status)).toEqual(['done', 'failed', 'skipped'])
    // Retry: only the failed step of the group runs again (now fixed), then the rest.
    const fixed = steps.map((s) => (s.name === 'bad' ? { ...s, command: append(log, 'fixed;') } : s))
    const again = runSetupSteps({ steps: fixed, from: 1, previous: results, cwd: dir, env: process.env as Record<string, string>, onOutput: () => {}, onChange: (r) => (results = r) })
    expect(await again.done).toBe('done')
    expect(await readFile(log, 'utf8')).toBe('ok;fixed;after;')
    expect(results.map((r) => r.status)).toEqual(['done', 'done', 'done'])
  }, 20_000)
})

describe('archive steps in settings', () => {
  const mkRepo = (root: string, local: Repo['local'] = {}): Repo => ({ id: 'r', name: 'r', rootPath: root, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local, createdAt: '' })

  it('reads [[scripts.archive.steps]] with parallel, and [archive] remove_docker_volumes_networks', () => {
    const layer = fromToml({
      scripts: { archive: { steps: [{ name: 'Down', command: 'docker compose down', timeout: '2m', parallel: true }, { name: 'Logs', command: 'tar czf logs.tgz logs', parallel: true }] } },
      archive: { remove_docker_volumes_networks: true }
    })
    expect(layer.values.archiveSteps).toEqual([
      { name: 'Down', command: 'docker compose down', timeoutSec: 120, parallel: true },
      { name: 'Logs', command: 'tar czf logs.tgz logs', parallel: true }
    ])
    expect(layer.values.archiveScript).toBeUndefined()
    expect(layer.values.removeDockerExtras).toBe(true)
    expect(fromToml({ scripts: { archive: 'make clean' } }).values.archiveScript).toBe('make clean')
  })

  it('resolves a single archive script as one step called Archive, steps over scripts, local over shared', async () => {
    const root = await tempDir('foreman-archive-settings-')
    expect(resolveRepoSettings(mkRepo(root), defaultSettings()).values.archiveSteps).toEqual([])
    expect(resolveRepoSettings(mkRepo(root), defaultSettings()).values.removeDockerExtras).toBe(false)
    const single = resolveRepoSettings(mkRepo(root, { archiveScript: 'make clean' }), defaultSettings())
    expect(single.values.archiveSteps).toEqual(scriptAsSteps('make clean', 'archive'))
    expect(single.values.archiveSteps[0].name).toBe('Archive')
    expect(single.values.archiveScript).toBe('make clean')
    expect(single.sources.archiveSteps).toBe('local')
    await mkdir(path.join(root, '.foreman'))
    await writeFile(path.join(root, '.foreman', 'settings.toml'), '[[scripts.archive.steps]]\nname = "Down"\ncommand = "docker compose down"\n')
    const shared = resolveRepoSettings(mkRepo(root), defaultSettings())
    expect(shared.values.archiveSteps).toEqual([{ name: 'Down', command: 'docker compose down' }])
    expect(shared.sources.archiveScript).toBe('shared')
    const local = resolveRepoSettings(mkRepo(root, patchLocal({}, stepsPatch([{ name: 'Mine', command: 'echo mine' }, { name: 'Two', command: 'echo two' }], 'archive'))), defaultSettings())
    expect(local.values.archiveSteps.map((s) => s.name)).toEqual(['Mine', 'Two'])
    expect(local.inherited.archiveSteps).toBe('shared')
    // One step called Archive is stored as the plain script older builds run.
    expect(stepsPatch([{ name: 'Archive', command: 'make clean' }], 'archive')).toEqual({ archiveScript: 'make clean', archiveSteps: null })
  })
})

// ---- the archive itself: steps, progress, the kept diff, Docker ----

const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' })

async function setupArchive() {
  const dataDir = await tempDir('foreman-g3-data-')
  const store = new Store(dataDir)
  await store.load()
  store.state.settings.workspacesRoot = await tempDir('foreman-g3-ws-')
  const secrets = new SecretStore(path.join(dataDir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const environment = new Environment(secrets, () => store.state.settings, (id) => service.repo(id))
  const progress: ArchiveProgress[] = []
  const service: WorkspaceService = new WorkspaceService(store, { changed() {}, setupLog() {}, archiveProgress: (_id, p) => void progress.push(p) }, environment)
  const repo = await service.addRepo(await makeRepo({ 'a.txt': 'base\n' }))
  const ws = await service.createWorkspace(repo.id)
  for (let i = 0; i < 300 && ws.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50))
  expect(ws.state).toBe('ready')
  const stop = new StopSafely({
    store, sessions: { cancel: async () => {}, cancelTurn: async () => null } as never, workspaces: service,
    terminals: () => [], stopChecks: async () => {}, killTerminals: () => {}, forgetTerminals: () => {}, stopSpotlight: async () => {},
    disposeSessions: async () => {}, quit: () => {}, changed: () => {}, archiveProgress: (_id, p) => void progress.push(p)
  })
  return { store, service, repo, ws, stop, dataDir, progress }
}

describe('archive with steps (O19) and progress (#1)', () => {
  it('streams each step in order, the archive steps included', async () => {
    const { service, repo, ws, stop, dataDir, progress } = await setupArchive()
    const log = path.join(dataDir, 'archive.log')
    service.updateRepoSettings(repo.id, { archiveSteps: [{ name: 'One', command: append(log, '1') }, { name: 'Two', command: append(log, '2') }], archiveScript: null })
    const preview = await stop.archivePreview(ws.id)
    expect(preview.archiveSteps).toEqual([{ name: 'One' }, { name: 'Two' }])
    expect(await stop.archive(ws.id, false, { stopTabs: true })).toEqual({ ok: true })
    expect(await readFile(log, 'utf8')).toBe('12')
    const order = progress.filter((p) => !p.scriptSteps).map((p) => `${p.step}:${p.status}`)
    expect(order).toEqual(['stop:running', 'stop:done', 'checkpoint:running', 'checkpoint:done', 'diff:running', 'diff:done', 'script:running', 'script:done', 'remove:running', 'remove:done'])
    const last = progress.filter((p) => p.scriptSteps).at(-1)!
    expect(last.scriptSteps!.map((s) => s.status)).toEqual(['done', 'done'])
  }, 30_000)

  it('stops at a failed step before deleting anything, names it, and Retry carries on from it', async () => {
    const { service, repo, ws, stop, dataDir, progress } = await setupArchive()
    const log = path.join(dataDir, 'archive.log')
    const marker = slash(path.join(dataDir, 'fixed'))
    const flaky = node(`const f=require('fs');if(!f.existsSync('${marker}'))process.exit(5);f.appendFileSync('${slash(log)}','2')`)
    service.updateRepoSettings(repo.id, { archiveSteps: [{ name: 'One', command: append(log, '1') }, { name: 'Two', command: flaky }], archiveScript: null })
    expect(await stop.archive(ws.id, false, { stopTabs: true })).toEqual({ ok: false, step: 'script', detail: 'Two: exit code 5' })
    expect(existsSync(wsPath(ws))).toBe(true)
    expect(progress.some((p) => p.step === 'script' && p.status === 'failed' && p.detail === 'Two: exit code 5')).toBe(true)
    await writeFile(marker, '')
    expect(await stop.archive(ws.id, false, { from: 'script' })).toEqual({ ok: true })
    // Step One passed the first time and wasn't run again.
    expect(await readFile(log, 'utf8')).toBe('12')
    expect(ws.state).toBe('archived')
  }, 30_000)

  it('keeps a single archive script’s old wording', async () => {
    const { service, repo, ws, stop } = await setupArchive()
    service.updateRepoSettings(repo.id, { archiveScript: fail(3) })
    expect(await stop.archive(ws.id, true, { stopTabs: true })).toEqual({ ok: false, step: 'script', detail: 'exit code 3' })
  }, 30_000)
})

describe('the diff kept at archive time (#13)', () => {
  it('is saved before the folder goes, read back for the archived view, and dropped on restore', async () => {
    const { service, ws, stop } = await setupArchive()
    await writeFile(path.join(wsPath(ws), 'a.txt'), 'base\nchanged\n')
    await writeFile(path.join(wsPath(ws), 'new.txt'), 'new\n')
    expect(await stop.archive(ws.id, false, { stopTabs: true })).toEqual({ ok: true })
    expect(ws.archiveDiff).toMatchObject({ files: 2, additions: 2, deletions: 0 })
    const diff = await service.archivedDiff(ws.id)
    expect(diff?.files.map((f) => f.path).sort()).toEqual(['a.txt', 'new.txt'])
    expect(diff?.files.find((f) => f.path === 'a.txt')?.hunks[0].lines.some((l) => l.type === 'add' && l.text === 'changed')).toBe(true)
    await service.unarchiveWorkspace(ws.id)
    expect(ws.archiveDiff).toBeUndefined()
    expect(await service.archivedDiff(ws.id)).toBeNull()
  }, 30_000)
})

describe('Docker leftovers and extras (O18)', () => {
  const ps = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n')

  it('builds its commands and reads networks, leaving out Docker’s own', () => {
    expect(removeArgs(['a1'])).toEqual(['rm', '--force', 'a1'])
    expect(removeArgs(['a1'], true)).toEqual(['rm', '--force', '--volumes', 'a1'])
    expect(networksArgs('a1')).toEqual(['inspect', '--format', '{{json .NetworkSettings.Networks}}', 'a1'])
    expect(networkRemoveArgs('ledger_default')).toEqual(['network', 'rm', 'ledger_default'])
    expect(parseNetworks('{"ledger_default":{},"bridge":{},"host":{}}\n')).toEqual(['ledger_default'])
    expect(parseNetworks('not json')).toEqual([])
  })

  it('with extras, removes anonymous volumes and the networks nothing else uses', async () => {
    const calls: string[][] = []
    const run: DockerRunner = async (args) => {
      calls.push(args)
      if (args[0] === 'ps') return ok(ps([{ ID: 'a1', Names: 'db', Labels: 'foreman.workspace=w1' }, { ID: 'b2', Names: 'web', Labels: 'foreman.workspace=w1' }]))
      if (args[0] === 'inspect') return ok(args[3] === 'a1' ? '{"ledger_default":{}}' : '{"ledger_default":{},"shared_net":{}}')
      if (args[0] === 'network') return args[2] === 'shared_net' ? { code: 1, stdout: '', stderr: 'error: network shared_net has active endpoints' } : ok()
      return ok()
    }
    const removal = await removeContainers('w1', run, true)
    expect(removal).toEqual({
      status: 'ok', removed: ['db', 'web'], failed: [], volumes: true,
      networks: { removed: ['ledger_default'], kept: [{ name: 'shared_net', detail: 'error: network shared_net has active endpoints' }] }
    })
    expect(calls.filter((a) => a[0] === 'rm').every((a) => a.includes('--volumes'))).toBe(true)
    // Without extras: no inspect, no -v, no networks, as before.
    calls.length = 0
    expect(await removeContainers('w1', run)).toEqual({ status: 'ok', removed: ['db', 'web'], failed: [] })
    expect(calls.map((a) => a[0])).toEqual(['ps', 'rm', 'rm'])
  })

  it('remembers what was left for Home until it is removed or dismissed', async () => {
    expect(dockerLeft({ status: 'ok', removed: ['a'], failed: [] }, 't')).toBeUndefined()
    expect(dockerLeft({ status: 'not-running', removed: [], failed: [] }, 't')).toEqual({ at: 't', status: 'not-running', containers: [] })
    const { service, repo, ws, stop } = await setupArchive()
    service.updateRepoSettings(repo.id, { removeDockerContainers: true })
    let stuck = true
    service.docker = async (args) => {
      if (args[0] === 'ps') return ok(ps([{ ID: 'a1', Names: 'ledger-db-1', Labels: `foreman.workspace=${ws.id}` }]))
      return stuck ? { code: 1, stdout: '', stderr: 'Error response from daemon: cannot remove' } : ok()
    }
    await stop.archive(ws.id, false, { stopTabs: true })
    expect(ws.state).toBe('archived')
    expect(ws.dockerLeft).toMatchObject({ status: 'ok', containers: ['ledger-db-1'] })
    service.dismissDockerLeft(ws.id)
    expect(ws.dockerLeft).toBeUndefined()
    await service.removeDockerContainers(ws.id)
    expect(ws.dockerLeft?.containers).toEqual(['ledger-db-1'])
    stuck = false
    await service.removeDockerContainers(ws.id)
    expect(ws.dockerLeft).toBeUndefined()
  }, 30_000)
})

// ---- #1: Esc while waiting to quit ----

describe('Esc cancels the wait to quit', () => {
  it('from the composer when it didn’t use the key, and from anywhere that isn’t another field or a dialog', () => {
    const base = { defaultPrevented: false, inComposer: false, inOtherField: false, dialogOpen: false }
    expect(quitWaitEscape(base)).toBe(true)
    // In the composer with no turn running (it doesn't handle Esc then): cancels, though it's a text field.
    expect(quitWaitEscape({ ...base, inComposer: true, inOtherField: true })).toBe(true)
    // The composer stopped its running turn (or closed its menu) with this Esc.
    expect(quitWaitEscape({ ...base, inComposer: true, inOtherField: true, defaultPrevented: true })).toBe(false)
    expect(quitWaitEscape({ ...base, inOtherField: true })).toBe(false)
    expect(quitWaitEscape({ ...base, dialogOpen: true })).toBe(false)
  })
})

// ---- O10: rows that finished while closed, terminals that ended at quit ----

describe('while Foreman was closed', () => {
  it('records which chats finished, and a row says when', () => {
    const record = reconnectRecord('2026-10-22T12:52:00.000Z', '2026-10-22T12:10:00.000Z', [
      { ended: true, sessionId: 's1' },
      { ended: false, sessionId: 's2' }
    ])!
    expect(record).toEqual({ at: '2026-10-22T12:52:00.000Z', closedAt: '2026-10-22T12:10:00.000Z', running: 1, finished: 1, sessions: ['s1'] })
    const sessions = [
      { id: 's1', workspaceId: 'kigali', lastTurn: { endedAt: '2026-10-22T12:14:00.000Z' } },
      { id: 's2', workspaceId: 'nairobi', lastTurn: { endedAt: '2026-10-22T11:00:00.000Z' } },
      { id: 's3', workspaceId: 'kigali', lastTurn: { endedAt: '2026-10-22T12:20:00.000Z' } }
    ]
    expect(finishedWhileClosed(record, sessions, 'kigali')).toBe('2026-10-22T12:14:00.000Z')
    expect(finishedWhileClosed(record, sessions, 'nairobi')).toBeUndefined()
    expect(finishedWhileClosed(undefined, sessions, 'kigali')).toBeUndefined()
    // An end outside the closed window (a later turn) isn't claimed.
    expect(finishedWhileClosed({ ...record, sessions: ['s3'], at: '2026-10-22T12:15:00.000Z' }, sessions, 'kigali')).toBeUndefined()
    expect(reconnectRecord('t', undefined, [{ ended: false }])).toEqual({ at: 't', closedAt: undefined, running: 1, finished: 0 })
  })

  it('a terminal says it ended when Foreman quit, only on the launch after a clean quit', async () => {
    const dir = await tempDir('foreman-g3-terms-')
    const file = path.join(dir, 'terminals.json')
    const tab = { n: 1, savedAt: Date.now() - 1000, scrollback: 'npm run dev' }
    const first = new TerminalRestore(file, () => true)
    first.load()
    first.put('w1', [{ ...tab, cwd: dir }])
    first.flush(true)
    expect(JSON.parse(await readFile(file, 'utf8')).quitAt).toEqual(expect.any(Number))
    const second = new TerminalRestore(file, () => true)
    second.load()
    const [restored] = second.get('w1')!
    expect(restored.quitAt).toEqual(expect.any(Number))
    // Written again without it, so a crash before the next quit doesn't read as a quit.
    second.flush()
    expect(JSON.parse(await readFile(file, 'utf8')).quitAt).toBeUndefined()
    const third = new TerminalRestore(file, () => true)
    third.load()
    expect(third.get('w1')![0].quitAt).toBeUndefined()
    // A restored tab nobody started is saved back with its quit time, so a later quit doesn't move it.
    third.put('w1', [{ ...tab, cwd: dir, quitAt: 1234 }])
    third.flush(true)
    const fourth = new TerminalRestore(file, () => true)
    fourth.load()
    expect(fourth.get('w1')![0].quitAt).toBe(1234)
    const t = createT('en')
    expect(restoredLabel(tab.savedAt, Date.parse('2026-10-22T15:00:00'), t, 'en', Date.parse('2026-10-22T12:10:00'))).toBe('Ended when Foreman quit at 12:10 · terminals aren’t kept in the background')
    expect(restoredLabel(Date.parse('2026-10-22T14:02:00'), Date.parse('2026-10-22T15:00:00'), t, 'en')).toBe('Restored from 14:02 · the process was not kept')
  })
})

// ---- O21: drops on a terminal ----

describe('a drop on a terminal', () => {
  it('belongs to the terminal (typed in as paths), never the add-repo overlay', () => {
    expect(OWN_DROP_SELECTOR.split(', ')).toEqual(expect.arrayContaining(['.composer-box', '.terminal']))
    expect(terminalDropText(['/repo/src', 'C:\\Users\\me\\My Docs'])).toBe('/repo/src "C:\\Users\\me\\My Docs"')
    expect(terminalDropText(['/a b/"q"'])).toBe('"/a b/\\"q\\""')
  })
})

// ---- O3: colours and the shell's folder ----

describe('terminal colours kept for restore', () => {
  const E = '\u001b'

  it('keeps SGR and drops every other escape and control character', () => {
    expect(keepSgr(`${E}[1;31mred${E}[0m plain`)).toBe(`${E}[1;31mred${E}[0m plain`)
    // Truecolour with colons and semicolons survives.
    expect(keepSgr(`${E}[38;2;255;0;0mx${E}[38:5:208my`)).toBe(`${E}[38;2;255;0;0mx${E}[38:5:208my`)
    // Queries that would make the terminal answer, cursor moves, titles, hyperlinks, clipboard writes, DCS: gone.
    expect(keepSgr(`a${E}[6nb${E}[2Jc${E}[?1049hd${E}]0;title\u0007e${E}]8;;https://x\u001b\\link${E}]8;;\u001b\\f${E}]52;c;aGk=\u0007g${E}Pq#0\u001b\\h${E}7i${E}cj`)).toBe('abcdelinkfghij')
    expect(keepSgr('bell\u0007 back\u0008 nul\u0000 tab\tok\nnext')).toBe('bell back nul tab\tok\nnext')
    // An SGR with a private marker or an absurd length isn't one.
    expect(keepSgr(`${E}[?25m${E}[${'1;'.repeat(40)}mz`)).toBe('z')
  })

  it('undoes the serializer’s cursor tricks', () => {
    expect(styledFromSerialized(`${E}[32mok${E}[0m${E}[3Cend\r\nnext`)).toBe(`${E}[32mok${E}[0m   end\nnext`)
    // A wrapped row ending in empty cells, and the final cursor placement.
    expect(styledFromSerialized(`abc--${E}[1D${E}[1Xdef${E}[A${E}[3C${E}[2X${E}[3D${E}[Bghi${E}[2;5H`)).toBe('abcdefghi')
  })

  it('reads the real serialize addon’s output from a real xterm buffer', async () => {
    const { Terminal } = await import('@xterm/xterm')
    const { SerializeAddon } = await import('@xterm/addon-serialize')
    const term = new Terminal({ cols: 10, rows: 4, allowProposedApi: true })
    const serializer = new SerializeAddon()
    term.loadAddon(serializer as never)
    // A gap made by a cursor move, a coloured background, a wide character wrapping, and the cursor left elsewhere.
    await new Promise<void>((resolve) => term.write(`ab${E}[5Ccd\r\n${E}[44m   ${E}[0m end\r\n123456789中中XY\r\n${E}[1;31mlast${E}[0m${E}[1;1H`, resolve))
    const raw = serializer.serialize({ scrollback: 100, excludeModes: true, excludeAltBuffer: true })
    expect(styledFromSerialized(raw)).toBe(`ab     cd\n${E}[44m   ${E}[0m end\n123456789中中XY\n${E}[31;1mlast${E}[0m`)
    term.dispose()
  })

  it('trims to the newest lines, cutting at a line so no colour code is split', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `${E}[3${i % 8}mline ${i}${E}[0m   `)
    const out = trimStyled(lines.join('\r\n'), 200)
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.endsWith(`line 49${E}[0m`)).toBe(true)
    expect(out.startsWith(E)).toBe(true)
    expect(trimStyled(`${E}[31mabc${E}[0m\n\n\n`)).toBe(`${E}[31mabc${E}[0m`)
  })

  it('writes styled history back dimmed, re-dimming after every colour change', () => {
    expect(dimHistory(`${E}[31mred${E}[0m x\nplain`, true)).toBe(`${E}[2m${E}[31m${E}[2mred${E}[0m${E}[2m x${E}[0m\r\n${E}[2mplain${E}[0m\r\n${E}[?25l`)
    // Plain history is as before.
    expect(dimHistory('a\nb')).toBe(`${E}[2ma${E}[22m\r\n${E}[2mb${E}[22m\r\n${E}[?25l`)
  })

  it('re-checks styled output read from the file', () => {
    const data = parseSavedTerminals({ version: 2, workspaces: { w1: [{ n: 1, cwd: '/x', savedAt: 1, styled: true, scrollback: `${E}[31mred${E}[6n${E}]0;t\u0007` }, { n: 2, cwd: '/x', savedAt: 1, scrollback: `${E}[31mplain` }] }, quitAt: 5 })
    expect(data.workspaces.w1[0]).toMatchObject({ styled: true, scrollback: `${E}[31mred` })
    expect(data.workspaces.w1[1].scrollback).toBe('plain')
    expect(data.workspaces.w1[1].styled).toBeUndefined()
    expect(data.quitAt).toBe(5)
  })
})

describe('the shell’s folder (OSC 7 and OSC 9;9)', () => {
  it('reads file:// reports, decoding them, Windows drive paths included', () => {
    expect(osc7Folder('file://mac.local/Users/me/my%20repo')).toBe('/Users/me/my repo')
    expect(osc7Folder('file:///home/me/src/')).toBe('/home/me/src')
    expect(osc7Folder('file:///')).toBe('/')
    expect(osc7Folder('file://host/C:/Users/me/src')).toBe('C:\\Users\\me\\src')
    expect(osc7Folder('file:///D:')).toBe('D:\\')
    expect(osc7Folder('https://example.com/x')).toBeNull()
    expect(osc7Folder('not a url')).toBeNull()
    expect(osc7Folder('file:///a%00b')).toBeNull()
  })

  it('reads ConEmu / Windows Terminal reports, and ignores OSC 9 notifications', () => {
    expect(osc99Folder('9;"C:\\Users\\me\\src"')).toBe('C:\\Users\\me\\src')
    expect(osc99Folder('9;C:/work')).toBe('C:/work')
    expect(osc99Folder('Build finished')).toBeNull()
    expect(osc99Folder('4;1;50')).toBeNull()
  })

  it('uses a reported folder only when it exists', async () => {
    const dir = await tempDir('foreman-g3-cwd-')
    expect(existingFolder(dir)).toBe(dir)
    expect(existingFolder(path.join(dir, 'gone'))).toBeUndefined()
    expect(existingFolder('relative/path')).toBeUndefined()
    expect(existingFolder(42)).toBeUndefined()
    await writeFile(path.join(dir, 'file.txt'), '')
    expect(existingFolder(path.join(dir, 'file.txt'))).toBeUndefined()
  })
})

// ---- #19: image before/after ----

describe('image before and after in the diff', () => {
  it('shows the sides a change has', () => {
    expect(imageDiffSides({ path: 'logo.png', status: 'modified' }, 'abc1234')).toEqual({ before: 'logo.png', after: 'logo.png' })
    expect(imageDiffSides({ path: 'logo.png', status: 'added' }, 'abc1234')).toEqual({ after: 'logo.png' })
    expect(imageDiffSides({ path: 'logo.png', status: 'deleted' }, 'abc1234')).toEqual({ before: 'logo.png' })
    expect(imageDiffSides({ path: 'new.png', oldPath: 'old.png', status: 'renamed' }, 'abc1234')).toEqual({ before: 'old.png', after: 'new.png' })
    // No branch point to read from: only the worktree's side.
    expect(imageDiffSides({ path: 'logo.png', status: 'modified' }, undefined)).toEqual({ after: 'logo.png' })
    expect(imageDiffSides({ path: 'data.bin', status: 'modified' }, 'abc1234')).toBeNull()
    expect(imageDiffSides({ path: 'logo.txt', oldPath: 'logo.png', status: 'renamed' }, 'abc1234')).toEqual({ before: 'logo.png' })
  })

  it('keeps the swipe between the edges', () => {
    expect(swipePercent(42.4)).toBe(42)
    expect(swipePercent(-5)).toBe(0)
    expect(swipePercent(120)).toBe(100)
    expect(swipePercent(Number.NaN)).toBe(50)
  })
})

// ---- #13: fork an archived chat into a new workspace ----

describe('Fork into a new workspace', () => {
  it('makes a new workspace from the base branch whose first tab carries the archived chat, sending nothing', async () => {
    const { Core } = await import('../src/main/core')
    const dir = await tempDir('foreman-g3-fork-')
    const store = new Store(dir)
    await store.load()
    store.state.settings.workspacesRoot = await tempDir('foreman-g3-fork-ws-')
    const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    const core = new Core(store, secrets, {
      broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
      openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
      metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
    })
    const send = (await import('vitest')).vi.spyOn(core.sessions, 'send').mockResolvedValue('started')
    const repo = await core.workspaces.addRepo(await makeRepo())
    const ws = await core.workspaces.createWorkspace(repo.id)
    for (let i = 0; i < 300 && ws.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50))
    const source = core.sessions.createSession(ws.id, { agent: 'codex', model: 'gpt-6.1-sol', title: 'Billing toggle' })
    await store.replaceChat(source.id, [
      { kind: 'user', id: 'u1', turnId: 't1', text: 'Add an annual billing toggle', at: new Date().toISOString() } as never,
      { kind: 'assistant', id: 'a1', turnId: 't1', text: 'Done: the toggle is in Settings.' } as never
    ])
    await expect(core.api.forkArchivedChat(source.id)).rejects.toThrow(/archived/)
    expect(await core.api.archiveWorkspace(ws.id, false, { stopTabs: true })).toMatchObject({ ok: true })

    const fresh = await core.api.forkArchivedChat(source.id)
    expect(fresh.id).not.toBe(ws.id)
    expect(fresh.repoId).toBe(repo.id)
    expect(fresh.baseBranch).toBe(ws.baseBranch)
    const tab = store.state.sessions.find((s) => s.workspaceId === fresh.id)!
    expect(tab).toMatchObject({ agent: 'codex', model: 'gpt-6.1-sol', title: 'Billing toggle (fork)', seedHistory: true, forkedFrom: { sessionId: source.id } })
    const items = await store.readChat(tab.id)
    expect(items.slice(0, 2).map((i) => i.id)).toEqual(['u1', 'a1'])
    const notice = items.at(-1) as { kind: string; text: string }
    expect(notice.kind).toBe('notice')
    expect(notice.text).toContain(`in the archived workspace ${ws.name}`)
    expect(notice.text).toContain('starts from the base branch')
    expect(send).not.toHaveBeenCalled()
    // The archived workspace and its chat are untouched.
    expect(ws.state).toBe('archived')
    expect((await store.readChat(source.id)).length).toBe(2)
    for (let i = 0; i < 300 && fresh.state !== 'ready' && fresh.state !== 'error'; i++) await new Promise((r) => setTimeout(r, 50))
  }, 60_000)
})
