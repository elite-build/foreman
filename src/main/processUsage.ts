// Per-workspace resource usage (Settings → Experimental → Show resource usage): one look at every process on the system,
// then each workspace's process trees (processRoots.ts) summed and grouped by executable name. Most of what parallel
// agents cost runs outside Foreman's own processes: each Claude Code turn, the user's MCP servers it starts, and their
// hooks, a chain of shells and node per tool call.
//
// The look is one process listing per refresh, never a process per tree. macOS and Linux: `ps`, which is quick, so every
// poll. Windows has no cheap listing with parent pids (tasklist has none, wmic is gone, and Get-Process in Windows
// PowerShell 5.1 has no parent): one PowerShell Get-CimInstance query, about a second, at most every WINDOWS_REFRESH_MS.
// Either way it runs as an async child process, only while something asks (the sidebar polls only while it shows the
// usage and the window can be seen), and only when Foreman has a process to count.
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { ProcessGroupUsage, ProcessRootKind, WorkspaceResourceUsage } from '../shared/types'
import type { ProcessRoot } from './processRoots'

/** One process from the listing. `created` (Windows: FILETIME) tells a reused parent pid apart; 0 when unknown. */
export interface ProcessRow {
  pid: number
  ppid: number
  name: string
  memoryBytes: number
  cpuPercent: number
  created: number
}

/** A Windows row before CPU: total kernel and user time so far, in 100 ns units. */
export interface WindowsRow extends Omit<ProcessRow, 'cpuPercent'> {
  cpuTime: number
}

export const POSIX_REFRESH_MS = 2_500
export const WINDOWS_REFRESH_MS = 20_000
const TOP_GROUPS = 5

/** "claude.exe" and "/Users/me/.local/bin/claude" both read "claude". */
export function processName(raw: string): string {
  const base = raw.trim().split(/[\\/]/).pop() ?? ''
  return base.replace(/\.exe$/i, '') || raw.trim()
}

/** `ps -axo pid=,ppid=,rss=,%cpu=,comm=`: rss in KiB; comm last, as a macOS path may hold spaces. */
export function parsePs(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), memoryBytes: Number(m[3]) * 1024, cpuPercent: Number(m[4].replace(',', '.')) || 0, name: processName(m[5]), created: 0 })
  }
  return rows
}

/** WINDOWS_LIST's output: pid, parent pid, working set (bytes), CPU time (100 ns), creation (FILETIME), name; tab-separated. */
export function parseWindows(text: string): WindowsRow[] {
  const rows: WindowsRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split('\t')
    if (parts.length < 6) continue
    const [pid, ppid, memory, cpuTime, created] = parts.slice(0, 5).map(Number)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
    rows.push({ pid, ppid, memoryBytes: memory || 0, cpuTime: cpuTime || 0, created: created || 0, name: processName(parts.slice(5).join('\t')) })
  }
  return rows
}

/**
 * CPU for Windows rows from the change in each process's CPU time since the previous listing (`prev`, keyed by pid and
 * creation time, so a reused pid starts again), as a percentage of one core like Electron's app metrics and `ps`.
 * A process first seen in this listing reads 0.
 */
export function windowsCpu(rows: WindowsRow[], prev: { at: number; times: Map<string, number> } | null, now: number): { rows: ProcessRow[]; times: Map<string, number> } {
  const times = new Map<string, number>()
  const elapsed = prev ? (now - prev.at) * 10_000 : 0
  const out = rows.map(({ cpuTime, ...row }) => {
    const key = `${row.pid}:${row.created}`
    times.set(key, cpuTime)
    const before = prev?.times.get(key)
    const cpuPercent = before !== undefined && elapsed > 0 && cpuTime >= before ? ((cpuTime - before) / elapsed) * 100 : 0
    return { ...row, cpuPercent }
  })
  return { rows: out, times }
}

/**
 * Each workspace's processes: every root that is still running and all its descendants, counted once (a process under two
 * roots goes to the first). A child that started before its listed parent is not its child (the parent pid was reused).
 */
export function attribute(rows: ProcessRow[], roots: ProcessRoot[]): WorkspaceResourceUsage[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    if (row.ppid === row.pid) continue
    const parent = byPid.get(row.ppid)
    if (!parent || (parent.created && row.created && row.created < parent.created)) continue
    const list = children.get(row.ppid)
    if (list) list.push(row)
    else children.set(row.ppid, [row])
  }
  const claimed = new Set<number>()
  const usage = new Map<string, { processes: number; memoryBytes: number; cpuPercent: number; groups: Map<string, ProcessGroupUsage>; kinds: Map<ProcessRootKind, { processes: number; memoryBytes: number }> }>()
  for (const root of roots) {
    const top = byPid.get(root.pid)
    if (!top || claimed.has(top.pid)) continue
    let ws = usage.get(root.workspaceId)
    if (!ws) usage.set(root.workspaceId, (ws = { processes: 0, memoryBytes: 0, cpuPercent: 0, groups: new Map(), kinds: new Map() }))
    const kind = ws.kinds.get(root.kind) ?? { processes: 0, memoryBytes: 0 }
    ws.kinds.set(root.kind, kind)
    const stack = [top]
    claimed.add(top.pid)
    while (stack.length) {
      const row = stack.pop()!
      ws.processes++
      ws.memoryBytes += row.memoryBytes
      ws.cpuPercent += row.cpuPercent
      kind.processes++
      kind.memoryBytes += row.memoryBytes
      const key = row.name.toLowerCase()
      const group = ws.groups.get(key) ?? { name: row.name, count: 0, memoryBytes: 0 }
      group.count++
      group.memoryBytes += row.memoryBytes
      ws.groups.set(key, group)
      for (const child of children.get(row.pid) ?? []) {
        if (claimed.has(child.pid)) continue
        claimed.add(child.pid)
        stack.push(child)
      }
    }
  }
  const heaviest = <T extends { memoryBytes: number }>(a: T, b: T) => b.memoryBytes - a.memoryBytes
  return [...usage].map(([workspaceId, ws]) => ({
    workspaceId,
    processes: ws.processes,
    memoryBytes: ws.memoryBytes,
    cpuPercent: Math.round(ws.cpuPercent * 10) / 10,
    top: [...ws.groups.values()].sort(heaviest).slice(0, TOP_GROUPS),
    kinds: [...ws.kinds].map(([kind, k]) => ({ kind, ...k })).sort(heaviest)
  }))
}

// One CIM query for every process, written as tab-separated lines (parseWindows). UTF-8 out, no progress records on stderr.
const WINDOWS_LIST = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$ProgressPreference='SilentlyContinue'",
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$b=New-Object Text.StringBuilder',
  'foreach($p in Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate){',
  '$c=0;if($p.CreationDate){$c=$p.CreationDate.ToFileTimeUtc()}',
  '[void]$b.Append("$($p.ProcessId)`t$($p.ParentProcessId)`t$($p.WorkingSetSize)`t$($p.KernelModeTime+$p.UserModeTime)`t$c`t$($p.Name)`n")}',
  '[Console]::Out.Write($b.ToString())'
].join('\n')

export type RunCommand = (file: string, args: string[]) => Promise<string>

const runCommand: RunCommand = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  )

/** Lists the system's processes (one command), with CPU worked out on Windows from the previous listing. */
export class ProcessTable {
  private prevTimes: { at: number; times: Map<string, number> } | null = null

  constructor(
    private platform: NodeJS.Platform = process.platform,
    private run: RunCommand = runCommand,
    private now: () => number = Date.now
  ) {}

  get refreshMs(): number {
    return this.platform === 'win32' ? WINDOWS_REFRESH_MS : POSIX_REFRESH_MS
  }

  async list(): Promise<ProcessRow[]> {
    if (this.platform !== 'win32') return parsePs(await this.run('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm=']))
    const shell = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const encoded = Buffer.from(WINDOWS_LIST, 'utf16le').toString('base64')
    const text = await this.run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded])
    const at = this.now()
    const { rows, times } = windowsCpu(parseWindows(text), this.prevTimes, at)
    this.prevTimes = { at, times }
    return rows
  }
}

/**
 * The latest per-workspace usage, without waiting: `usage()` answers from the last listing at once and starts a new one
 * when that is older than the platform's refresh (one at a time). With no roots it lists nothing and answers empty.
 */
export class ProcessUsageSampler {
  private rows: ProcessRow[] = []
  private at = -Infinity
  private pending: Promise<void> | null = null

  constructor(
    private roots: () => ProcessRoot[] | Promise<ProcessRoot[]>,
    private table: Pick<ProcessTable, 'list' | 'refreshMs'> = new ProcessTable(),
    private now: () => number = Date.now
  ) {}

  async usage(): Promise<WorkspaceResourceUsage[]> {
    const roots = await this.roots()
    if (!roots.length) {
      this.rows = []
      this.at = -Infinity
      return []
    }
    if (!this.pending && this.now() - this.at >= this.table.refreshMs) this.pending = this.refresh()
    return attribute(this.rows, roots)
  }

  /** Waits for a listing in progress (tests). */
  settled(): Promise<void> {
    return this.pending ?? Promise.resolve()
  }

  private async refresh(): Promise<void> {
    try {
      this.rows = await this.table.list()
    } catch {
      // Keep the last listing; the next poll tries again after the refresh interval.
    } finally {
      this.at = this.now()
      this.pending = null
    }
  }
}
