// What the app hands the command-line server: today's narrow hooks (the ones the window doesn't have) plus
// the whole `Api`, so a handler can call the same service the window does.
import type net from 'node:net'
import type { AgentReport, TurnCaller } from '../../shared/agentReports'
import type { ExportInfo, ExportOptions, ExportSummary, ImportChoice, StageResult } from '../../shared/portable'
import type { AppSnapshot, Api, ApprovalRequest, CheckConsentItem, CreateWorkspaceOptions, LimitResume, MainEvent, Repo, ResolvedRepoSettings, SendOptions, SendReceipt, Session, Settings, TurnStatus, Workspace, WorkspaceStartedBy } from '../../shared/types'
import type { ChecksCliResult, CliErrorCode } from '../../cli/protocol'
import type { PerfReport } from '../../shared/perf'
import type { DiagnosticsBundle } from '../../shared/diagnostics'
import type { CallerIdentity, RecordInput } from '../agentReports'
import type { FlowRun, FlowRunOrigin, FlowRunStart } from '../../shared/flows'
import type { TurnCap } from '../../shared/agentAccess'
import type { ServiceState } from '../service'

export interface CliHost {
  state(): { repos: Repo[]; workspaces: Workspace[]; sessions: Session[]; settings: Settings }
  // The same object ipcMain dispatches to. A handler calls only the methods it names; there is no passthrough.
  api: Api
  snapshot(): AppSnapshot
  resolvedRepoSettings(repoId: string): ResolvedRepoSettings
  platform: NodeJS.Platform
  // The events the window receives (cloud build logs, archive progress, …). Returns the unsubscribe.
  onEvent(listener: (event: MainEvent) => void): () => void
  appInfo(): { version: string; packaged: boolean; dataDir: string }
  // The token a launcher must present (version 2 requests) before an admin method is served.
  cliToken(): string
  // Requests waiting for the user, for `foreman status`.
  approvals(): ApprovalRequest[]
  // Where a turn is, read from the chat's persisted record once it has ended. Null when unknown.
  turnStatus(turnId: string): Promise<TurnStatus | null>
  // Sends a message to one chat, saying which turn carries it.
  deliver(sessionId: string, text: string, options: SendOptions): Promise<SendReceipt>
  // Cancels a queued, starting or running turn by id. Resolves with where it ended up (null if unknown).
  cancelTurn(turnId: string): Promise<TurnStatus | null>
  // A chat's running turn waits on another turn: its agent slot is lent until the returned function is called (Sessions.lendSlot).
  lendSlot?(sessionId: string): () => void
  // G4 #11: tick (or untick) the turn's "Resume at …" from the command line; the same rules as the card. `cap`: from a capped turn.
  armLimitResume?(sessionId: string, turnId: string, cap?: TurnCap): Promise<LimitResume>
  cancelLimitResume?(sessionId: string): void
  // The chat and turn a new workspace's first message started (undefined if none started).
  firstTurn(workspaceId: string): Promise<{ session: string; turn: string } | undefined>
  // `startedBy`: the chat (or assistant thread) that started it, when the call came from one. `cap`: that turn's cap, which
  // the first message carries (docs/agent-access.md §4).
  createWorkspace(repoId: string, options: CreateWorkspaceOptions, extra?: { startedBy?: WorkspaceStartedBy; cap?: TurnCap }): Promise<Workspace>
  // Delegation's start_flow: a flow run as the Run a flow page starts one, recording who started it (the run's origin). Absent:
  // the tool says starting a flow is unavailable.
  startFlowRun?(input: FlowRunStart, origin?: FlowRunOrigin): Promise<FlowRun>
  // Bring the window forward on this workspace.
  reveal(workspaceId: string): void
  showSetting(id: string): void
  // The checks of this workspace that still need approval on this computer (new or changed commands).
  checkConsent?(workspaceId: string): CheckConsentItem[]
  // Waits for setup to settle after creation.
  setupOutcome(workspaceId: string): Promise<{ failed: boolean; held: boolean; logTail: string }>
  // Sends the first message that a failed setup held back. `cap`: asked for from a capped turn, which lowers the message's own.
  startHeldMessage(workspaceId: string, cap?: TurnCap): Promise<void>
  // docs/agent-access.md §4: the Api as a command from a capped turn calls it, every call that starts or queues a turn
  // carrying the cap. Absent (tests, an older host): a capped turn's command that would start one is refused.
  capped?(cap: TurnCap): Api
  // Runs the workspace's checks (same definitions and records as the Git panel). Answers "busy" at once when an agent turn is active there.
  runChecks(workspaceId: string): Promise<ChecksCliResult>
  // Export and import (the same service the Workspace menu uses).
  exportInfo(workspaceId: string): Promise<ExportInfo>
  exportWorkspace(workspaceId: string, options: ExportOptions): Promise<ExportSummary>
  stageImport(file: string, passphrase?: string): Promise<StageResult>
  importStaged(stageId: string, choice: ImportChoice): Promise<Workspace>
  discardImport(stageId: string): Promise<void>
  // #2: check a call's turn token (null: it carried none), record a report, and the repo's run/send opt-in.
  identifyCaller(caller: TurnCaller | undefined): CallerIdentity | null
  recordReport(input: RecordInput): { report: AgentReport; added: boolean }
  agentsMayStart(repoId: string): boolean
  // Integrations: an agent's `foreman mcp-bridge` connection. It stays open and carries MCP JSON-RPC lines;
  // `rest` is whatever arrived after the first line.
  bridge?(conn: net.Socket, params: { grant: string; service: string }, rest: string): void
  // The performance meter's report (docs/telemetry.md), for `foreman app perf`; `reset` starts its counters again
  // after the report. Absent (tests, the assistant's in-process host): the command says the app keeps none.
  perf?(options?: { reset?: boolean }): PerfReport
  // Diagnostics (docs/telemetry.md, "Evidence"): the bundle `foreman app diagnostics` writes, and on-demand CPU
  // profiles and heap snapshots into the data folder's logs. Absent: the commands say the app keeps none.
  diagnostics?(): Promise<DiagnosticsBundle>
  profile?(options: { target: 'main' | 'renderer'; seconds: number }): Promise<{ file: string; ms: number }>
  heapSnapshot?(options: { target: 'main' | 'renderer' }): Promise<{ file: string }>
  // The background service (src/main/service.ts), for `foreman service`. Absent (tests, the demo): the commands say
  // this Foreman can't install one.
  service?: ServiceHost
}

export interface ServiceHost {
  status(): Promise<ServiceState>
  install(): Promise<ServiceState>
  uninstall(): Promise<ServiceState>
  // This Foreman was started by the service.
  startedByService: boolean
  // This copy can download and install an update by itself (main/updateInstaller.ts).
  canUpdate(): boolean
  // What install changes for this copy, said after installing: a development build, Linux's display. Empty when nothing.
  notes(): string[]
}

/**
 * A failure that says which code it is. Version 1 clients only see the message, which is why the
 * existing texts stay as they were; version 2 clients also get `code` and the optional `hint`.
 */
export class CliCodedError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
    readonly hint?: string
  ) {
    super(message)
  }
}
