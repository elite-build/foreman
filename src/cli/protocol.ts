// What the `foreman` command and the running app say to each other over a local
// socket: one JSON request line, one JSON response line. Node only (not the renderer).
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { ChecksState, StatusRow } from '../shared/status'
import type { TurnDelta, TurnOutcome, TurnStatus } from '../shared/types'
import type { ReportKind, TurnCaller } from '../shared/agentReports'

export interface RunParams {
  // Template id, name or slug.
  template: string
  // Values for the template's {{placeholders}}, in order.
  values: string[]
  // Where the command ran; picks the repository when `repo` is absent.
  cwd: string
  // Repository name, id or folder.
  repo?: string
  // Name for the new branch (default: generated, then renamed from the prompt).
  branch?: string
  // Branch to start from (default: the repository's base branch).
  base?: string
  // Loadout slot, from 1 (default: the first).
  loadout?: number
  // Bring the app forward and show the new workspace.
  open?: boolean
  // Only fill the template; create nothing.
  dryRun?: boolean
  // If setup fails, send the held first message anyway.
  startAnyway?: boolean
  // Return as soon as the workspace exists, without waiting for setup.
  noWait?: boolean
  // Integrations switched on or off in the new workspace, over the repository's defaults ("linear", "slack").
  with?: string[]
  without?: string[]
}

export interface RunResult {
  template: string
  repo: string
  prompt: string
  // Absent for a dry run.
  workspace?: { id: string; name: string; branch: string; path: string }
  // The pull request that was checked out, when the command was given a PR URL.
  pullRequest?: { repo: string; number: number }
  // Setup failed and the first message was held, not sent.
  held?: { logTail: string }
  // Setup failed and --start-anyway sent the message regardless.
  startedAnyway?: boolean
  // The chat and turn the first message started, for `foreman wait`. Absent for a dry run, --no-wait or a held message.
  session?: string
  turn?: string
}

// `foreman run` exits with this when setup failed and the message was held.
export const EXIT_SETUP_HELD = 3
// `foreman run --wait` / `foreman wait`: the connection to the app dropped before the outcome arrived.
export const EXIT_DISCONNECTED = 5

export interface WaitParams {
  // The turn to wait for (printed by `foreman run` and `foreman send`).
  turn: string
  // Give up waiting after this long; the turn carries on. Default: wait as long as it takes.
  timeoutSec?: number
}

export type WaitOutcome = TurnOutcome | 'timeout'

export interface WaitResult {
  workspace: { id: string; name: string }
  session: string
  turn: string
  outcome: WaitOutcome
  // Why it failed or was interrupted.
  error?: string
  durationMs?: number
  // What the turn changed, when measured.
  delta?: TurnDelta
  // The workspace's checks as they stand now.
  checks: ChecksState
  pr?: { number: number; state?: string; url?: string }
}

/** `foreman wait` / `run --wait` exit codes (3 is a held setup, 5 a lost connection; see below). */
export const WAIT_EXIT: Record<WaitOutcome, number> = { completed: 0, error: 1, cancelled: 1, interrupted: 1, timeout: 2 }

export interface SendParams {
  // A workspace's name, id or branch; "." means the one the command runs in.
  workspace: string
  // Open tab, counting from 1. Needed when the workspace has several.
  tab?: number
  // A template (name, id or slug) followed by its values, or the words of a message.
  args: string[]
  cwd: string
}

export interface SendResult {
  workspace: { id: string; name: string }
  tab: number
  // "Claude · Opus 5.5"
  model: string
  session: string
  // Also the receipt: `foreman wait <turn>` and `foreman cancel <turn>` take it.
  turn: string
  disposition: 'started' | 'queued' | 'steered'
  message: string
}

export interface CancelParams {
  turn: string
}

export interface CancelResult {
  workspace: { id: string; name: string }
  session: string
  turn: string
  // Where the turn was when asked to stop.
  was: TurnStatus['state']
  // Where it ended up.
  outcome: TurnOutcome
  message: string
}

// G4 #11: `foreman resume-at <turn>` arms (or with --cancel, disarms) the usage-limit resume the turn's card offers.
export interface ResumeAtParams {
  turn: string
  cancel?: boolean
}

export interface ResumeAtResult {
  workspace: { id: string; name: string }
  session: string
  turn: string
  // When it sends (ISO), absent after --cancel.
  at?: string
  armed: boolean
  message: string
}

export interface ChecksParams {
  // Where the command ran; picks the workspace.
  cwd: string
}

export type ChecksOutcome = 'passed' | 'failed' | 'error' | 'not-configured' | 'busy'

export interface ChecksCliResult {
  workspace: { id: string; name: string }
  outcome: ChecksOutcome
  results: { name: string; command: string; status: string; exitCode?: number; durationMs?: number; logPath: string }[]
  message?: string
}

/** `foreman checks` exit codes: 0 passed, 1 failed, 2 error/timeout/cancelled, 3 not configured, 4 busy. */
export const CHECKS_EXIT: Record<ChecksOutcome, number> = { passed: 0, failed: 1, error: 2, 'not-configured': 3, busy: 4 }

export interface ExportParams {
  // A workspace's name, id or branch; "." means the one the command runs in.
  workspace: string
  cwd: string
  // Where to write the file (default: ./<workspace>.foreman).
  out?: string
  // Selected share: chats you pick, in the clear. Without it the export is an encrypted backup.
  share?: boolean
  passphrase?: string
  // Share: open tabs by number from 1, or chat ids (default: every open tab).
  chats?: string[]
  // Share: keep what tools printed.
  toolOutput?: boolean
  // Share: leave attached files out.
  noAttachments?: boolean
  // Move the branch and uncommitted work as a git bundle (Backup: on unless --no-bundle; Share: only with --bundle).
  bundle?: boolean
  noBundle?: boolean
}

export interface ExportCliResult {
  workspace: { id: string; name: string }
  path: string
  bytes: number
  mode: 'backup' | 'share'
  encrypted: boolean
  exportId: string
  chats: { id: string; title: string }[]
  attachments: number
  variables: number
  message: string
}

export interface ImportParams {
  // Absolute path of the .foreman file.
  file: string
  cwd: string
  passphrase?: string
  // The repository this belongs to: name, id or folder. Foreman suggests one but you confirm it.
  repo?: string
  // Same export or workspace already here: import it again as a copy with new ids.
  copy?: boolean
  // Accept the single suggested repository.
  yes?: boolean
}

export type ImportCliResult =
  | { status: 'needs-passphrase' }
  | {
      status: 'imported'
      workspace: { id: string; name: string; branch: string }
      repo: string
      tabs: number
      variablesToSet: string[]
      missingAttachments: string[]
      message: string
    }

export interface TemplateSummary {
  slug: string
  name: string
  placeholders: string[]
  // Where it comes from when not your own: the repository's .foreman/templates.
  source?: 'repo'
}

/** #2: `foreman report <kind> "<text>"` (and `foreman review "<what>"`, as kind review). */
export interface ReportParams {
  kind: ReportKind | 'review'
  text: string
  // An http(s) link to go with it.
  link?: string
  // Where the command ran; picks the workspace when the call carries no turn token.
  cwd: string
}

export interface ReportResult {
  workspace: { id: string; name: string }
  // The tab and turn it was attributed to (a valid turn token); absent when it counts for the workspace only.
  tab?: number
  session?: string
  turn?: string
  attribution: 'turn' | 'workspace'
  // Its turn had already ended: kept as history ("from an earlier turn").
  late?: boolean
  // The same words from the same turn were already reported; nothing changed.
  duplicate?: boolean
  message: string
}

export interface RepoSummary {
  name: string
  path: string
}

/**
 * One request. `caller` is the turn identity from FOREMAN_SESSION_ID, FOREMAN_TURN_ID and
 * FOREMAN_TURN_TOKEN when the command runs inside an agent turn (#2): attribution, and the
 * cooperative run/send policy. It is not a security boundary.
 */
export type CliRequest = (
  | { method: 'run'; params: RunParams }
  | { method: 'checks'; params: ChecksParams }
  | { method: 'status' }
  | { method: 'wait'; params: WaitParams }
  | { method: 'send'; params: SendParams }
  | { method: 'cancel'; params: CancelParams }
  | { method: 'resume-at'; params: ResumeAtParams }
  | { method: 'export'; params: ExportParams }
  | { method: 'import'; params: ImportParams }
  | { method: 'templates'; params?: { cwd?: string } }
  | { method: 'repos' }
  | { method: 'report'; params: ReportParams }
  // The integration bridge: the connection then carries MCP JSON-RPC lines both ways (see src/cli/bridge.ts).
  | { method: 'mcp-bridge'; params: { grant: string; service: string } }
) & { caller?: TurnCaller }

/** `foreman status`: one row per live workspace. */
export type StatusResult = StatusRow[]

export type CliResponse<T = unknown> = { ok: true; result: T } | { ok: false; error: string }

/** The app's data folder, as Electron's userData resolves it for Foreman. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.FOREMAN_DATA_DIR || env.SWITCHYARD_DATA_DIR
  if (override) return override
  const home = os.homedir()
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Foreman')
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Foreman')
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Foreman')
}

/**
 * Where the app listens. A named pipe on Windows; otherwise a socket in the data
 * folder, or in the temp folder when that path is too long for a Unix socket.
 */
export function socketPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  const id = createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 12)
  if (platform === 'win32') return `\\\\.\\pipe\\foreman-${id}`
  const inData = path.join(dataDir, 'cli.sock')
  // sun_path holds 104 bytes on macOS, 108 on Linux.
  return Buffer.byteLength(inData) < 100 ? inData : path.join(os.tmpdir(), `foreman-${id}.sock`)
}

/** The protocol this build speaks. A request with no `v` is version 1: one JSON reply line, no codes, no progress. */
export const CLI_PROTOCOL_VERSION = 2

/** Why a version 2 request failed, so a script can tell "no such workspace" from "Foreman isn't running". */
export type CliErrorCode =
  | 'not-running'
  | 'unknown-method'
  | 'invalid'
  | 'not-found'
  | 'ambiguous'
  | 'refused'
  | 'busy'
  | 'needs-confirmation'
  | 'needs-consent'
  | 'not-supported'
  | 'failed'

/**
 * Version 2 request. `token` is the contents of `<dataDir>/cli.token`; the app wants it before it serves
 * anything in the admin tier. `caller` is the turn identity, as in version 1.
 */
export interface CliRequestV2 {
  v: 2
  method: string
  params?: unknown
  caller?: TurnCaller
  token?: string
}

/** Version 2 reply. `code` is only ever on a failed reply; an `ok: true` result keeps its own shape (a wait that timed out, checks that were busy). */
export type CliReplyV2<T = unknown> = { ok: true; result: T } | { ok: false; error: string; code: CliErrorCode; hint?: string }

/** A line a handler may write before its reply, to a version 2 request only (never to version 1, which parses one line). */
export interface CliProgressFrame {
  progress: { text: string; percent?: number }
}

/** `app-info`: what the running app is, so the command can warn about a mismatch and `doctor` can explain itself. */
export interface AppInfoResult {
  version: string
  protocol: number
  packaged: boolean
  dataDir: string
  socket: string
  // Whether the `foreman` command is installed on PATH, when the app knows.
  cliInstalled?: boolean
  cliPath?: string | null
}

/** One exit code table for every command: the existing per-command codes keep their numbers (see the plan, section 9). */
export const ERROR_EXIT: Record<CliErrorCode, number> = {
  invalid: 2,
  busy: 4,
  'not-running': 5,
  'needs-confirmation': 6,
  'needs-consent': 6,
  refused: 7,
  'not-found': 8,
  ambiguous: 8,
  'unknown-method': 1,
  'not-supported': 1,
  failed: 1
}

/** The file the app writes its launch token to, for the `foreman` command to read back. */
export function tokenPath(dataDir: string): string {
  return path.join(dataDir, 'cli.token')
}

/** One line of `foreman doctor`. A "problem" makes the command exit 1; a "note" is worth knowing and nothing more. */
export interface DoctorItem {
  name: string
  status: 'ok' | 'problem' | 'note'
  detail: string
  // What to do about it, for a problem.
  fix?: string
}

/** `doctor`: what the app can check from its side. The command adds its own line for itself. */
export interface DoctorResult {
  items: DoctorItem[]
}

/** `doctor` takes the command's own version so the app can say whether the two match. */
export interface DoctorParams {
  cliVersion?: string
}
