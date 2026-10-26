// Parameters and results of the workspace methods. Each result has a
// `text` the command prints unless --json is given. A workspace is named by `workspace` (name, id, branch or ".").
import type { ChecksState, StatusRow } from '../status'
import type { DockerListing, DockerRemoval } from '../docker'
import type { ArchivePreview, SetupStepStatus, WorkspaceStatus, WorkspaceUsage } from '../types'
import type { TabRow } from './tabs'

export type WorkspaceKind = 'worktree' | 'direct' | 'adopted' | 'history' | 'cloud'

/** Where a command ran, and which workspace it names. */
export interface WorkspaceRef {
  workspace: string
  cwd?: string
}

export interface WsListParams {
  repo?: string
  archived?: boolean
  cwd?: string
}

export interface ArchivedRow {
  workspace: string
  id: string
  repo: string
  branch: string
  archivedAt?: string
  // The diff kept at archive time.
  diff?: { files: number; additions: number; deletions: number; truncated?: boolean }
}

export interface WsListResult {
  // Live workspaces in the sidebar's order (empty with --archived).
  workspaces: StatusRow[]
  // Present with --archived.
  archived?: ArchivedRow[]
  text: string
}

export interface WsSetupSummary {
  id: string
  startedAt: string
  finishedAt?: string
  steps: { name: string; status: SetupStepStatus }[]
}

export interface WsShowResult {
  workspace: {
    id: string
    name: string
    repo: string
    branch: string
    base: string
    path?: string
    kind: WorkspaceKind
    state: string
    // The board status; absent when none was set.
    status?: WorkspaceStatus
    pinned: boolean
    // The sidebar's group and what the row says it needs.
    bucket?: string
    label?: string
    createdAt: string
    archivedAt?: string
    cloud?: { provider: string; status: string; region: string }
  }
  tabs: TabRow[]
  pr?: { number: number; state?: string; url?: string }
  checks: ChecksState
  // Agent reports (needs-input, stuck, review) nobody has answered.
  openReports: { id: string; kind: string; text: string }[]
  note?: { revision: number; chars: number }
  setup?: WsSetupSummary
  text: string
}

export interface WsPathResult {
  path: string
  text: string
}

export interface WsOpenResult {
  workspace: { id: string; name: string }
  text: string
}

/** What a change to one workspace's own fields came to (rename, pin, unpin, status). */
export interface WsChangeResult {
  workspace: { id: string; name: string }
  // The field and its new value.
  changed: { name?: string; pinned?: boolean; status?: WorkspaceStatus | null }
  text: string
}

export interface WsRenameParams extends WorkspaceRef {
  name: string
}

export interface WsStatusParams extends WorkspaceRef {
  // A board status, or 'none' to clear it.
  status: string
}

export interface WsArchiveParams extends WorkspaceRef {
  deleteBranch?: boolean
  // Stop running tabs first instead of refusing.
  stop?: boolean
  // Carry on past a failed checkpoint or archive script.
  anyway?: boolean
  // Set by the command once the person has seen the preview and agreed. Without it nothing is archived.
  confirmed?: boolean
}

export interface WsArchiveResult {
  workspace: { id: string; name: string }
  // True when nothing was done: the preview came back and the person has to agree (send `confirmed`).
  needsConfirmation?: boolean
  preview?: ArchivePreview
  // After a confirmed archive.
  archived?: boolean
  // A failed step that stopped the archive before anything was deleted.
  failed?: { step: 'checkpoint' | 'script'; detail: string }
  docker?: DockerRemoval
  // The preview alone, for the command to show before it asks.
  previewText?: string
  text: string
}

export interface WsUnarchiveResult {
  workspace: { id: string; name: string }
  state: string
  text: string
}

export interface WsForgetResult {
  workspace: { id: string; name: string }
  text: string
}

export interface WsAdoptParams {
  path: string
  repo?: string
  cwd: string
  // Run the repository's setup script on the added worktree.
  setup?: boolean
  // A first message for the new workspace's chat. Starts a turn, so it goes through the start policy.
  prompt?: string
}

export interface WsAdoptResult {
  workspace: { id: string; name: string; branch: string; path: string }
  repo: string
  text: string
}

export type SetupVerb = 'log' | 'rerun' | 'retry' | 'stop' | 'steps'

export interface WsSetupParams extends WorkspaceRef {
  verb: SetupVerb
  // log: only the last n lines.
  tail?: number
}

export interface WsSetupResult {
  workspace: { id: string; name: string }
  verb: SetupVerb
  setup?: WsSetupSummary
  // log: the log; steps: each step's own log, in order.
  log?: string
  steps?: { name: string; status?: SetupStepStatus; log: string }[]
  text: string
}

export type NoteVerb = 'get' | 'set' | 'send'

export interface WsNoteParams extends WorkspaceRef {
  verb: NoteVerb
  // set: the new text (an empty string clears it).
  text?: string
  // send: the open tab, counting from 1.
  tab?: number
}

export interface WsNoteResult {
  workspace: { id: string; name: string }
  verb: NoteVerb
  note?: { text: string; revision: number; updatedAt?: string }
  // send: where it went.
  sent?: { tab: number; session: string; turn: string; disposition: 'started' | 'queued' | 'steered' }
  text: string
}

export interface WsUsageResult {
  workspace: { id: string; name: string }
  usage: WorkspaceUsage
  text: string
}

export interface WsSpotlightParams extends WorkspaceRef {
  on: boolean
}

export interface WsSpotlightResult {
  workspace: { id: string; name: string }
  on: boolean
  text: string
}

export type DockerVerb = 'list' | 'remove' | 'dismiss'

export interface WsDockerParams extends WorkspaceRef {
  verb: DockerVerb
}

export interface WsDockerResult {
  workspace: { id: string; name: string }
  verb: DockerVerb
  listing?: DockerListing
  removal?: DockerRemoval
  text: string
}

export type AlertVerb = 'list' | 'dismiss'

export interface WsAlertsParams extends WorkspaceRef {
  verb: AlertVerb
  // dismiss: the alert's id, or the start of it.
  id?: string
}

export interface WsAlertsResult {
  workspace: { id: string; name: string }
  verb: AlertVerb
  alerts: { id: string; tab?: number; turn: string; files: string[] }[]
  text: string
}

export type ReportVerb = 'list' | 'close'

export interface WsReportsParams extends WorkspaceRef {
  verb: ReportVerb
  id?: string
}

export interface WsReportsResult {
  workspace: { id: string; name: string }
  verb: ReportVerb
  reports: { id: string; kind: string; text: string; at: string; link?: string; tab?: number; closed?: string }[]
  text: string
}

/** `foreman new "<prompt>"`: a workspace from free text, with no template. */
export interface NewParams {
  prompt: string
  repo?: string
  cwd: string
  // A new branch with this name (otherwise one is named from the prompt).
  branch?: string
  // Check out this existing branch in a new worktree.
  existing?: string
  // Work in the repository folder itself, on this branch.
  direct?: string
  base?: string
  // Loadout slot, from 1.
  loadout?: number
  // Files for the first message; relative paths are taken from cwd.
  attach?: string[]
  // A cloud sandbox instead of a folder here.
  cloud?: boolean
  open?: boolean
  noWait?: boolean
  startAnyway?: boolean
}

export interface NewResult {
  repo: string
  prompt: string
  workspace: { id: string; name: string; branch: string; path?: string }
  cloud?: boolean
  pullRequest?: { repo: string; number: number }
  // Setup failed and the first message was held, not sent.
  held?: { logTail: string }
  startedAnyway?: boolean
  // The chat and turn the first message started, for `foreman wait`.
  session?: string
  turn?: string
  text: string
}
