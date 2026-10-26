// The sandbox provider seam: everything Foreman needs
// from a remote sandbox, so nothing above src/main/cloud/ imports a provider's SDK. Vercel
// (vercelProvider.ts) was the first; Docker, E2B and Daytona implement the same contract
// (providers.ts registers them), and tests/providerConformance.ts checks any of them against it.
// fakeProvider.ts backs the tests.
import type { CloudProviderId, PlanLimits, ProviderCapabilities, ProviderStatus } from '../../shared/cloud'
import type { RuntimeExecOptions, RuntimeExecResult } from '../runtime/types'

export type { CloudProviderId, PlanLimits, ProviderCapabilities, ProviderStatus }

export interface GitSource {
  type: 'git'
  // https, without credentials.
  url: string
  // A private clone's credentials (x-access-token and a GitHub token); used for the clone only.
  username?: string
  password?: string
  depth?: number
  revision?: string
}

export interface CreateSandboxOptions {
  name: string
  source?: GitSource
  vcpus: number
  region: string
  timeoutMs: number
  tags: Record<string, string>
  // Progress worth showing while it is made (Docker building its image the first time); providers may ignore it.
  onOutput?: (chunk: string) => void
}

/** A new sandbox from another (fork) or from a repository's base (createFromBase). */
export interface ForkSandboxOptions {
  name: string
  vcpus?: number
  region?: string
  timeoutMs: number
  tags: Record<string, string>
  onOutput?: (chunk: string) => void
}

export interface SandboxInfo {
  name: string
  status: ProviderStatus
  tags?: Record<string, string>
  createdAt?: Date
  expiresAt?: Date
}

export interface RemoteLogLine {
  stream: 'stdout' | 'stderr'
  data: string
}

/** A command left running in the sandbox, with its stdin open. Phase 2's host attach rides on this. */
export interface SpawnedRemote {
  cmdId: string
  write(data: string | Uint8Array): Promise<void>
  closeStdin(): Promise<void>
  logs(): AsyncIterable<RemoteLogLine>
  wait(): Promise<{ code: number }>
  kill(): Promise<void>
}

/** A PTY's process, sent when it opens (research.md "PTY protocol": the `start` frame). */
export interface PtyStart {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

/** What a PTY reports. `exit(null)`: the connection ended without the process exiting (the sandbox stopped, the network). */
export interface PtyListener {
  data(data: string): void
  exit(code: number | null): void
}

/** An open PTY in a sandbox: a WebSocket on Vercel (vercelPty.ts), in-process in the fake. */
export interface PtyTransport {
  write(data: string): void
  resize(cols: number, rows: number): void
  // Ends the process with the connection (there is no separate kill); no exit is reported after it.
  close(): void
}

/** What stopping a session cost, from the provider's receipt. */
export interface StopReceipt {
  snapshotId?: string
  activeCpuMs?: number
  // The session's wall-clock length and size, for provisioned memory (vCPUs × 2 GB × hours).
  durationMs?: number
  vcpus?: number
}

// `wake`: a stopped sandbox is resumed first (a user's action, or a turn). Without it a stopped sandbox refuses.
export type SandboxExecOptions = Omit<RuntimeExecOptions, 'cwd'> & { cwd?: string; wake?: boolean }

/** One file of a writeFiles batch. */
export interface SandboxFile {
  path: string
  data: Buffer | string
  mode?: number
}

/** The session as the provider reports it in one fetch: its status, and its end and start while it runs. */
export interface SandboxSession {
  status: ProviderStatus
  expiresAt?: Date
  startedAt?: Date
}

/**
 * The sandbox isn't running and the call didn't ask to wake it. Only exec's `wake` resumes a stopped sandbox: a read
 * (a diff, a status, a poll) that resumed one would start a billed session nobody asked for.
 */
export class SandboxNotRunningError extends Error {
  readonly code = 'sandbox-not-running'
  constructor(name: string) {
    super(`The sandbox ${name} isn’t running`)
  }
}

/** Remote workspaces can't run: no connection for the provider, it needs attention, or the provider isn't implemented yet. */
export class CloudUnavailableError extends Error {
  readonly code = 'cloud-unavailable'
}

export interface SandboxHandle {
  readonly name: string
  // Fresh from the provider on every call.
  status(): Promise<ProviderStatus>
  // The status with the session's end and start, from one fetch.
  session(): Promise<SandboxSession>
  // Runs to the end. A stopped sandbox is resumed first only with `wake`; otherwise it throws SandboxNotRunningError.
  exec(cmd: string, args: string[], opts?: SandboxExecOptions): Promise<RuntimeExecResult>
  // These never resume a stopped sandbox (SandboxNotRunningError): wake it first.
  spawn(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin: true }): Promise<SpawnedRemote>
  attachCommand(cmdId: string): Promise<SpawnedRemote>
  readFile(path: string): Promise<Buffer | null>
  writeFile(path: string, data: Buffer | string, mode?: number): Promise<void>
  // Many files in one upload; their folders are made as needed.
  writeFiles(files: SandboxFile[]): Promise<void>
  mkdir(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  // A PTY running `start` (phase 4, cloud terminals).
  openPty(start: PtyStart, listener: PtyListener): Promise<PtyTransport>
  // Stop the session; a persistent sandbox snapshots its filesystem first. Stopping a stopped sandbox is a no-op ({}).
  stop(): Promise<StopReceipt>
  // capabilities().sessionCap only; SandboxManager never calls it otherwise. Refuses a stopped sandbox.
  extendTimeout(ms: number): Promise<void>
  // With snapshots, the sandbox's snapshots go too.
  delete(opts?: { snapshots?: boolean }): Promise<void>
}

/**
 * One sandbox service. Making one (the registry's factory) never touches the network: the manager makes providers
 * to read capabilities() and limits() for the window. Every call that does reach the service may throw.
 */
export interface SandboxProvider {
  readonly id: CloudProviderId
  // What it can do; SandboxManager branches on these, never on `id`. Constant for a provider's lifetime.
  capabilities(): ProviderCapabilities
  // The plan's caps (a session's length, the largest size, sandboxes at once), from the connection as last checked.
  limits(): PlanLimits
  // `source` is never passed by SandboxManager (it clones itself); a provider may refuse it.
  create(opts: CreateSandboxOptions): Promise<SandboxHandle>
  // capabilities().fork: a copy of a sandbox as it is (its filesystem, stopped or running).
  fork?(sourceName: string, opts: ForkSandboxOptions): Promise<SandboxHandle>
  /**
   * capabilities().base: a new sandbox starting from the base `baseName` as its last stop left it (the snapshot a
   * stop took, an image committed from it, a template built from it). The base is a stopped sandbox made by create().
   */
  createFromBase?(baseName: string, opts: ForkSandboxOptions): Promise<SandboxHandle>
  // null when there is no sandbox by that name.
  get(name: string): Promise<SandboxHandle | null>
  // Sandboxes carrying this one tag (providers filter on a single tag).
  list(tag: Record<string, string>): Promise<SandboxInfo[]>
}
