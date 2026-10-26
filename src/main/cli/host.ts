// What the app hands the command-line server: today's narrow hooks (the ones the window doesn't have) plus
// the whole `Api`, so a handler can call the same service the window does.
import type net from 'node:net'
import type { AgentReport, TurnCaller } from '../../shared/agentReports'
import type { ExportInfo, ExportOptions, ExportSummary, ImportChoice, StageResult } from '../../shared/portable'
import type { AppSnapshot, Api, ApprovalRequest, CheckConsentItem, CreateWorkspaceOptions, LimitResume, MainEvent, Repo, ResolvedRepoSettings, SendOptions, SendReceipt, Session, Settings, TurnStatus, Workspace } from '../../shared/types'
import type { ChecksCliResult, CliErrorCode } from '../../cli/protocol'
import type { CallerIdentity, RecordInput } from '../agentReports'

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
  // G4 #11: tick (or untick) the turn's "Resume at …" from the command line; the same rules as the card.
  armLimitResume?(sessionId: string, turnId: string): Promise<LimitResume>
  cancelLimitResume?(sessionId: string): void
  // The chat and turn a new workspace's first message started (undefined if none started).
  firstTurn(workspaceId: string): Promise<{ session: string; turn: string } | undefined>
  createWorkspace(repoId: string, options: CreateWorkspaceOptions): Promise<Workspace>
  // Bring the window forward on this workspace.
  reveal(workspaceId: string): void
  showSetting(id: string): void
  // The checks of this workspace that still need approval on this computer (new or changed commands).
  checkConsent?(workspaceId: string): CheckConsentItem[]
  // Waits for setup to settle after creation.
  setupOutcome(workspaceId: string): Promise<{ failed: boolean; held: boolean; logTail: string }>
  // Sends the first message that a failed setup held back.
  startHeldMessage(workspaceId: string): Promise<void>
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
