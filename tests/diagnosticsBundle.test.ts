// The diagnostics bundle (docs/telemetry.md, "Evidence"): what Save diagnostics and `foreman app diagnostics` write,
// and that every string in it has been through the report's redaction.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDiagnostics, diagnosticsFileName, listCrashDumps, redactDeep, writeDiagnostics } from '../src/main/diagnostics'
import { DiagnosticsLog } from '../src/main/diagnosticsLog'
import { PerfMeter } from '../src/main/perf'
import { ErrorLog } from '../src/main/reportProblem'
import { defaultSettings } from '../src/main/store'
import type { Session, Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

const HOME = '/home/zelda-tester'
const USER = 'zelda-tester'
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz012345'

async function setup() {
  const logsDir = path.join(await tempDir('foreman-bundle-'), 'logs')
  await mkdir(logsDir, { recursive: true })
  await writeFile(path.join(logsDir, 'foreman.log'), Array.from({ length: 500 }, (_, i) => JSON.stringify({ at: 'x', kind: 'old', i, path: `${HOME}/repo-${i}` })).join('\n') + '\n')
  await writeFile(path.join(logsDir, 'perf.jsonl'), Array.from({ length: 200 }, (_, i) => JSON.stringify({ at: 'y', i })).join('\n') + '\n')
  const dumps = path.join(await tempDir('foreman-dumps-'), 'Crashpad')
  await mkdir(path.join(dumps, 'reports'), { recursive: true })
  await writeFile(path.join(dumps, 'reports', 'aaaa-bbbb.dmp'), 'MDMP')
  await writeFile(path.join(dumps, 'reports', 'notes.txt'), 'not a dump')
  const perf = new PerfMeter(() => 10_000)
  perf.count('state.flush', 3)
  perf.time('git.status', 12)
  const events = new DiagnosticsLog(() => 10_000)
  events.log('error', { line: `12:00:00 ENOENT ${HOME}/project/state.json` })
  events.log('turn.end', { outcome: 'error', error: `token=${TOKEN} rejected` })
  const errors = new ErrorLog()
  errors.record(`12:00:00 something broke for ${USER}`)
  const settings = { ...defaultSettings(), diagnostics: true, mobileLanAddress: '192.168.1.20' }
  const workspaces = [
    { id: 'a', repoId: 'r', state: 'ready' },
    { id: 'b', repoId: 'r', state: 'ready' },
    { id: 'c', repoId: 'r', state: 'archived' }
  ] as Workspace[]
  const sessions = [{ id: 's1', workspaceId: 'a', status: 'running' }] as Session[]
  return { logsDir, dumps, perf, events, errors, settings, workspaces, sessions }
}

describe('diagnostics bundle', () => {
  it('gathers the app, settings, perf report, events, log tails, errors, usage and crash dumps, all redacted', async () => {
    const s = await setup()
    const bundle = await buildDiagnostics({
      app: { version: '1.0.4', packaged: true, platform: 'linux', arch: 'x64', os: 'Linux 6.1', node: '24.0.0' },
      settings: s.settings,
      workspaces: s.workspaces,
      sessions: s.sessions,
      perf: s.perf,
      events: s.events,
      errors: s.errors,
      logsDir: s.logsDir,
      crashDumpsDir: s.dumps,
      resourceUsage: async () => ({ cpuPercent: 3, memoryMb: 400, workspaces: [] }),
      redact: { home: HOME, user: USER },
      startedAt: 4_000,
      now: () => 10_000
    })
    expect(bundle.kind).toBe('foreman-diagnostics')
    expect(bundle.app).toMatchObject({ version: '1.0.4', uptimeMs: 6_000, diagnosticsOn: true })
    expect(bundle.workspaces).toEqual({ total: 3, ready: 2, running: 1, archived: 1 })
    // The settings the assistant may read, and none of the ones it may not (addresses, accounts).
    expect(bundle.settings.diagnostics).toBe(true)
    expect(bundle.settings).not.toHaveProperty('mobileLanAddress')
    expect(bundle.perf.counters).toEqual({ 'state.flush': 3 })
    expect(bundle.events).toHaveLength(2)
    expect(bundle.logTail).toHaveLength(400)
    expect(bundle.perfTail).toHaveLength(120)
    expect(bundle.errors).toHaveLength(1)
    expect(bundle.resourceUsage).toEqual({ cpuPercent: 3, memoryMb: 400, workspaces: [] })
    expect(bundle.crashDumps).toEqual([{ name: 'aaaa-bbbb.dmp', bytes: 4, modifiedAt: expect.any(String) }])

    // Nothing private survives anywhere in the file.
    const text = JSON.stringify(bundle)
    expect(text).not.toContain(HOME)
    expect(text).not.toContain(USER)
    expect(text).not.toContain(TOKEN)
    expect(bundle.events[0].line).toContain('~/project/state.json')
    expect(bundle.errors[0]).toContain('<user>')
    expect(JSON.parse(bundle.logTail[0]).path).toBe('~/repo-100')
  })

  it('does without what is missing: no log files, no dumps folder, no usage reader', async () => {
    const bundle = await buildDiagnostics({
      app: { version: '0', packaged: false, platform: 'win32', arch: 'x64', os: 'Windows', node: '24' },
      settings: { ...defaultSettings(), diagnostics: false },
      workspaces: [],
      sessions: [],
      perf: new PerfMeter(() => 0),
      events: new DiagnosticsLog(() => 0),
      errors: new ErrorLog(),
      logsDir: path.join(await tempDir('foreman-empty-'), 'logs'),
      redact: {},
      startedAt: 0
    })
    expect(bundle.app.diagnosticsOn).toBe(false)
    expect(bundle.logTail).toEqual([])
    expect(bundle.perfTail).toEqual([])
    expect(bundle.crashDumps).toEqual([])
    expect(bundle.resourceUsage).toBeNull()
  })

  it('redacts every string at any depth and leaves the shape alone', async () => {
    const out = redactDeep({ a: [`${HOME}/x`, 1, null], b: { c: `Bearer ${TOKEN}`, d: true } }, { home: HOME, user: USER })
    expect(out).toEqual({ a: ['~/x', 1, null], b: { c: 'Bearer <token>', d: true } })
    await expect(listCrashDumps(undefined)).resolves.toEqual([])
  })

  it('writes readable JSON and names the file by the minute', async () => {
    const file = path.join(await tempDir('foreman-bundle-'), diagnosticsFileName(new Date(2026, 10, 2, 9, 5)))
    expect(path.basename(file)).toBe('foreman-diagnostics-2026-11-02-0905.json')
    await writeDiagnostics(file, { kind: 'foreman-diagnostics' } as never)
    expect(JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(file, 'utf8')))).toEqual({ kind: 'foreman-diagnostics' })
  })
})
