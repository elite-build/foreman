// Show resource usage per workspace: which processes Foreman started for a workspace (processRoots), one system listing
// parsed per platform, each root's whole tree summed and grouped by executable name, and a sampler cheap enough to ask
// every few seconds (one listing at a time, never when nothing runs, Windows at most every 20 s).
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STDERR_GRACE_MS, trackedClaudeSpawn } from '../src/main/agents/claudeSpawn'
import { processRoots, trackChild, trackProcess, type ProcessRoot } from '../src/main/processRoots'
import {
  attribute,
  parsePs,
  parseWindows,
  processName,
  ProcessTable,
  ProcessUsageSampler,
  WINDOWS_REFRESH_MS,
  windowsCpu,
  type ProcessRow
} from '../src/main/processUsage'

const MB = 1024 * 1024
const row = (pid: number, ppid: number, name: string, mb: number, cpu = 0, created = 0): ProcessRow => ({ pid, ppid, name, memoryBytes: mb * MB, cpuPercent: cpu, created })

describe('parsing a process listing', () => {
  it('reads macOS ps, whose executable is a path that may hold spaces', () => {
    const text = [
      '    1     0  12000   0.0 /sbin/launchd',
      '  501     1 600000  12.5 /Users/me/.local/bin/claude',
      '  502   501  81920   0,5 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      'garbage line',
      ''
    ].join('\n')
    expect(parsePs(text)).toEqual([
      { pid: 1, ppid: 0, memoryBytes: 12000 * 1024, cpuPercent: 0, name: 'launchd', created: 0 },
      { pid: 501, ppid: 1, memoryBytes: 600000 * 1024, cpuPercent: 12.5, name: 'claude', created: 0 },
      { pid: 502, ppid: 501, memoryBytes: 81920 * 1024, cpuPercent: 0.5, name: 'Google Chrome', created: 0 }
    ])
  })

  it('reads Linux ps (short command names)', () => {
    expect(parsePs('  42  1  2048  3.0 node\n')).toEqual([{ pid: 42, ppid: 1, memoryBytes: 2048 * 1024, cpuPercent: 3, name: 'node', created: 0 }])
  })

  it('reads the Windows listing: tab-separated, CRLF, names without .exe', () => {
    const text = '0\t0\t8192\t100\t0\tSystem Idle Process\r\n6824\t48084\t326881280\t3662968750\t134375270201557370\tclaude.exe\r\n\r\nbad\tline\r\n'
    expect(parseWindows(text)).toEqual([
      { pid: 0, ppid: 0, memoryBytes: 8192, cpuTime: 100, created: 0, name: 'System Idle Process' },
      { pid: 6824, ppid: 48084, memoryBytes: 326881280, cpuTime: 3662968750, created: 134375270201557370, name: 'claude' }
    ])
  })

  it('names a process by its executable', () => {
    expect(processName('C:\\Program Files\\nodejs\\node.exe')).toBe('node')
    expect(processName('CLAUDE.EXE')).toBe('CLAUDE')
    expect(processName('/bin/bash')).toBe('bash')
  })

  it('works out Windows CPU from the change in CPU time, per pid and creation time', () => {
    const first = windowsCpu([{ pid: 7, ppid: 1, name: 'node', memoryBytes: 0, cpuTime: 1_000_000, created: 5 }], null, 10_000)
    expect(first.rows[0].cpuPercent).toBe(0)
    // 2 s later it used 1 s of CPU (10,000,000 × 100 ns): half a core.
    const second = windowsCpu([{ pid: 7, ppid: 1, name: 'node', memoryBytes: 0, cpuTime: 11_000_000, created: 5 }], { at: 10_000, times: first.times }, 12_000)
    expect(second.rows[0].cpuPercent).toBe(50)
    // The same pid on a new process starts again.
    const reused = windowsCpu([{ pid: 7, ppid: 1, name: 'node', memoryBytes: 0, cpuTime: 99_000_000, created: 6 }], { at: 12_000, times: second.times }, 14_000)
    expect(reused.rows[0].cpuPercent).toBe(0)
  })
})

describe('attributing processes to workspaces', () => {
  // Foreman (100) runs Claude Code for w1 (200) with an MCP server chain and a hook; a terminal for w1 (300); a terminal
  // for w2 (400) with a dev server; and something unrelated (900).
  const table = [
    row(100, 1, 'Foreman', 300),
    row(200, 100, 'claude', 600, 10),
    row(210, 200, 'cmd', 5),
    row(211, 210, 'node', 120, 2),
    row(212, 211, 'node', 80),
    row(220, 200, 'bash', 4, 1),
    row(221, 220, 'node', 40),
    row(300, 100, 'pwsh', 90),
    row(400, 100, 'zsh', 10),
    row(401, 400, 'node', 200, 30),
    row(900, 1, 'node', 999)
  ]
  const roots: ProcessRoot[] = [
    { pid: 200, workspaceId: 'w1', kind: 'agent' },
    { pid: 300, workspaceId: 'w1', kind: 'terminal' },
    { pid: 400, workspaceId: 'w2', kind: 'script' },
    // Gone since: ignored.
    { pid: 555, workspaceId: 'w3', kind: 'agent' }
  ]

  it('sums each root’s whole tree, groups by executable name and by what started it, and leaves the rest out', () => {
    const usage = attribute(table, roots)
    expect(usage.map((u) => u.workspaceId)).toEqual(['w1', 'w2'])
    const [w1, w2] = usage
    expect(w1).toMatchObject({ processes: 7, memoryBytes: (600 + 5 + 120 + 80 + 4 + 40 + 90) * MB, cpuPercent: 13 })
    expect(w1.top).toEqual([
      { name: 'claude', count: 1, memoryBytes: 600 * MB },
      { name: 'node', count: 3, memoryBytes: 240 * MB },
      { name: 'pwsh', count: 1, memoryBytes: 90 * MB },
      { name: 'cmd', count: 1, memoryBytes: 5 * MB },
      { name: 'bash', count: 1, memoryBytes: 4 * MB }
    ])
    expect(w1.kinds).toEqual([
      { kind: 'agent', processes: 6, memoryBytes: 849 * MB },
      { kind: 'terminal', processes: 1, memoryBytes: 90 * MB }
    ])
    expect(w2).toMatchObject({ processes: 2, memoryBytes: 210 * MB, cpuPercent: 30, kinds: [{ kind: 'script', processes: 2, memoryBytes: 210 * MB }] })
  })

  it('counts a process once when a root sits inside another root’s tree', () => {
    const usage = attribute(table, [{ pid: 200, workspaceId: 'w1', kind: 'agent' }, { pid: 211, workspaceId: 'w2', kind: 'terminal' }])
    expect(usage).toHaveLength(1)
    expect(usage[0].processes).toBe(6)
  })

  it('doesn’t take a process whose parent pid was reused by a later process (Windows creation times)', () => {
    const rows = [row(200, 100, 'claude', 600, 0, 50), row(201, 200, 'node', 10, 0, 60), row(202, 200, 'old', 70, 0, 10)]
    const [usage] = attribute(rows, [{ pid: 200, workspaceId: 'w1', kind: 'agent' }])
    expect(usage.processes).toBe(2)
    expect(usage.top.map((g) => g.name)).toEqual(['claude', 'node'])
  })

  it('survives a parent loop and a process that is its own parent', () => {
    const [usage] = attribute([row(1, 2, 'a', 1), row(2, 1, 'b', 1), row(3, 3, 'c', 1)], [{ pid: 1, workspaceId: 'w1', kind: 'agent' }])
    expect(usage.processes).toBe(2)
  })

  it('groups names case-insensitively, keeping the first spelling', () => {
    const [usage] = attribute([row(1, 0, 'Node', 1), row(2, 1, 'node', 1)], [{ pid: 1, workspaceId: 'w1', kind: 'agent' }])
    expect(usage.top).toEqual([{ name: 'Node', count: 2, memoryBytes: 2 * MB }])
  })
})

describe('the list of started processes', () => {
  it('tracks by pid and workspace, forgets on untrack, and ignores a process that never started', () => {
    const untrack = trackProcess(4242, 'w1', 'terminal')
    trackProcess(undefined, 'w1', 'agent')
    trackProcess(4343, undefined, 'agent')
    expect(processRoots()).toContainEqual({ pid: 4242, workspaceId: 'w1', kind: 'terminal' })
    expect(processRoots().some((r) => r.pid === 4343)).toBe(false)
    // A later process with the same pid keeps its entry when the old one's untrack runs late.
    const again = trackProcess(4242, 'w2', 'script')
    untrack()
    expect(processRoots()).toContainEqual({ pid: 4242, workspaceId: 'w2', kind: 'script' })
    again()
    expect(processRoots().some((r) => r.pid === 4242)).toBe(false)
  })

  it('tracks a child started with a workspace’s environment until it exits', () => {
    const child = Object.assign(new EventEmitter(), { pid: 5151 })
    trackChild(child, { FOREMAN_WORKSPACE_ID: 'w9', PATH: '/bin' }, 'script')
    expect(processRoots()).toContainEqual({ pid: 5151, workspaceId: 'w9', kind: 'script' })
    child.emit('exit', 0)
    expect(processRoots().some((r) => r.pid === 5151)).toBe(false)
  })
})

describe('the Claude Code process', () => {
  afterEach(() => vi.useRealTimers())

  function fakeChild(pid = 6161) {
    const child = Object.assign(new EventEmitter(), {
      pid,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true)
    })
    return child
  }

  it('is started as the SDK starts it, tracked against its workspace, with stderr passed on as text', async () => {
    const child = fakeChild()
    const start = vi.fn(() => child)
    const stderr: string[] = []
    const proc = trackedClaudeSpawn((t) => stderr.push(t), start as never)({ command: 'claude', args: ['--x'], cwd: '/w', env: { FOREMAN_WORKSPACE_ID: 'w1' }, signal: new AbortController().signal })
    expect(start).toHaveBeenCalledWith('claude', ['--x'], expect.objectContaining({ cwd: '/w', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }))
    expect(processRoots()).toContainEqual({ pid: 6161, workspaceId: 'w1', kind: 'agent' })
    expect(proc.stdin).toBe(child.stdin)
    // A character split across chunks comes out whole.
    const bytes = Buffer.from('limit ∙ resets')
    child.stderr.write(bytes.subarray(0, 7))
    child.stderr.write(bytes.subarray(7))
    await new Promise((r) => setImmediate(r))
    expect(stderr.join('')).toBe('limit ∙ resets')

    // Exit reaches the SDK only once stderr has closed, and the process is forgotten.
    const exits: unknown[][] = []
    proc.on('exit', (...args: unknown[]) => exits.push(args))
    child.exitCode = 1
    child.emit('exit', 1, null)
    expect(exits).toEqual([])
    child.stderr.end()
    child.stderr.emit('close')
    expect(exits).toEqual([[1, null]])
    expect(processRoots().some((r) => r.pid === 6161)).toBe(false)
  })

  it('reports exit after a short grace when stderr never closes', () => {
    vi.useFakeTimers()
    const child = fakeChild(6262)
    const proc = trackedClaudeSpawn(() => {}, (() => child) as never)({ command: 'claude', args: [], env: {}, signal: new AbortController().signal })
    const exit = vi.fn()
    proc.once('exit', exit)
    child.emit('exit', 0, null)
    vi.advanceTimersByTime(STDERR_GRACE_MS)
    expect(exit).toHaveBeenCalledTimes(1)
  })
})

describe('the sampler', () => {
  const roots: ProcessRoot[] = [{ pid: 200, workspaceId: 'w1', kind: 'agent' }]

  it('lists nothing when Foreman runs nothing', async () => {
    const list = vi.fn(async () => [])
    const sampler = new ProcessUsageSampler(() => [], { list, refreshMs: 0 })
    expect(await sampler.usage()).toEqual([])
    expect(list).not.toHaveBeenCalled()
  })

  it('answers from the last listing at once, one listing at a time, refreshed after the interval', async () => {
    let now = 0
    let rows = [row(200, 1, 'claude', 600)]
    let release = () => {}
    const list = vi.fn(() => new Promise<ProcessRow[]>((resolve) => (release = () => resolve(rows))))
    const sampler = new ProcessUsageSampler(() => roots, { list, refreshMs: WINDOWS_REFRESH_MS }, () => now)
    // The first answer comes before the first listing has finished.
    expect(await sampler.usage()).toEqual([])
    expect(await sampler.usage()).toEqual([])
    expect(list).toHaveBeenCalledTimes(1)
    release()
    await sampler.settled()
    expect((await sampler.usage())[0].memoryBytes).toBe(600 * MB)
    expect(list).toHaveBeenCalledTimes(1)
    // Within the interval: the same listing, new roots or not.
    now = WINDOWS_REFRESH_MS - 1
    await sampler.usage()
    expect(list).toHaveBeenCalledTimes(1)
    now = WINDOWS_REFRESH_MS
    rows = [row(200, 1, 'claude', 700)]
    await sampler.usage()
    expect(list).toHaveBeenCalledTimes(2)
    release()
    await sampler.settled()
    expect((await sampler.usage())[0].memoryBytes).toBe(700 * MB)
  })

  it('keeps the last listing when one fails', async () => {
    let now = 0
    const list = vi.fn().mockResolvedValueOnce([row(200, 1, 'claude', 600)]).mockRejectedValueOnce(new Error('timed out'))
    const sampler = new ProcessUsageSampler(() => roots, { list, refreshMs: 10 }, () => now)
    await sampler.usage()
    await sampler.settled()
    now = 10
    await sampler.usage()
    await sampler.settled()
    expect((await sampler.usage())[0].memoryBytes).toBe(600 * MB)
  })

  it('runs one ps on macOS and Linux, and one PowerShell CIM query on Windows, never a shell string', async () => {
    const run = vi.fn(async () => '  200  1  1024  1.0 claude\n')
    await new ProcessTable('darwin', run).list()
    expect(run).toHaveBeenLastCalledWith('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='])
    expect(new ProcessTable('linux', run).refreshMs).toBeLessThan(3000)

    let now = 1_000
    const win = vi.fn(async () => '200\t1\t1048576\t0\t9\tclaude.exe\n')
    const table = new ProcessTable('win32', win, () => now)
    expect(table.refreshMs).toBe(WINDOWS_REFRESH_MS)
    expect(await table.list()).toEqual([{ pid: 200, ppid: 1, memoryBytes: MB, cpuPercent: 0, created: 9, name: 'claude' }])
    const [file, args] = win.mock.calls[0] as unknown as [string, string[]]
    expect(file).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i)
    expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    expect(Buffer.from(args[5], 'base64').toString('utf16le')).toContain('Get-CimInstance -ClassName Win32_Process')
    // The next listing has CPU from the change since this one.
    now = 3_000
    win.mockResolvedValueOnce('200\t1\t1048576\t10000000\t9\tclaude.exe\n')
    expect((await table.list())[0].cpuPercent).toBe(50)
  })
})
