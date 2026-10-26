// The contract between the Electron main process and the renderer.
// Everything that crosses IPC is declared here so both sides stay in sync.
import type { PreviewProbe } from './previewProbe'
import type { AgentKind, EffortLevel, Loadout, ModelInfo } from './agents'
import type { DevicesInfo, PairedDevice, Transfer, WorkspaceTransfer } from './transfer'
import type { MobileInfo } from './mobile'
import type { GithubLinkInfo } from './githubLink'
import type { UsageReport } from './usageReport'
import type { ExportInfo, ExportOptions, ExportSummary, ImportChoice, StageResult } from './portable'
import type { GitBackupConfig, GitBackupPreview, GitBackupRestoreChoice, GitBackupRestoreResult, GitBackupRunResult, GitBackupStatus } from './gitBackup'
import type { LanguageSetting } from './i18n'
import type { HiddenModels } from './modelVisibility'
import type { AgentCatalogView, AgentPrefs, ProviderKeyAgents, TerminalAgentRun } from './agentCatalog'
import type { SavedTerminalTab, TerminalTabSave } from './terminalTabs'
import type { ScriptShellChoice, ShellChoice, ShellDetection } from './shells'
import type { ReportDiagnostics } from './reportProblem'
import type { KeepAwakeStatus } from './keepAwake'
import type { QuitPlan, StopRecord, StopReviewRow } from './stopSafely'
import type { DirListing } from './fileTree'
import type { ImagePreview } from './imageInfo'
import type { OpenInChoice, OpenInDetection, OpenInTarget } from './openIn'
import type { SavedCommand } from './savedCommands'
import type { DockerLeft, DockerListing, DockerPreview, DockerRemoval } from './docker'
import type { CloudProviderId, PlanLimits, ProviderCapabilities } from './cloud'

export type { AgentKind, EffortLevel, Loadout, ModelInfo } from './agents'

export interface CustomPrompts {
  general: string
  createPr: string
  codeReview: string
  fixErrors: string
  resolveConflicts: string
  renameBranch: string
}

/** A saved prompt the user can insert into the composer. */
export interface PromptTemplate {
  id: string
  name: string
  // May contain {{placeholders}}; the first is selected after inserting.
  body: string
  // Offered, never run, on the answer to a message that came from this template.
  followUp?: TemplateFollowUp
  // Used only when this template starts a new chat (foreman run, New workspace, a new tab).
  // Inserting the template into an existing chat never changes that chat's model.
  startModel?: TemplateStartModel
  // From the repo's .foreman/templates (read-only, R-1); personal templates leave these out.
  source?: 'repo'
  repoId?: string
  // The file's git blob SHA, so a send can say which revision of the template it used.
  rev?: string
  // Path inside the repo, e.g. .foreman/templates/release-checklist.md.
  file?: string
}

export interface TemplateStartModel {
  agent: AgentKind
  model: string
  effort?: EffortLevel
}

/** "Continue to {title}…" on the answer: opens Continue in another chat with this prompt (and model) filled in. */
export interface TemplateFollowUp {
  title: string
  model?: Loadout
  prompt: string
}

/** A named command for the terminal panel's Run button (e.g. a dev server). */
export interface RunScript {
  name: string
  command: string
  // Lucide icon name.
  icon: string
  default?: boolean
  hidden?: boolean
  // Where this script serves a preview ($FOREMAN_PORT substituted). The Run panel can check that it responds, on localhost only.
  previewUrl?: string
  // Where it is defined; filled in when settings are resolved.
  source?: 'local' | 'shared'
  // A local script that replaces a shared one of the same name.
  overrides?: boolean
}

// O19: setup as ordered steps.
/** One named setup step. `timeoutSec` unset means no limit. */
export interface SetupStep {
  name: string
  command: string
  timeoutSec?: number
  // G3 · O19: consecutive steps with `parallel` run at the same time; the next step waits for the whole group.
  parallel?: boolean
}

// 'stopped': Stop setup ended it; 'skipped': an earlier step didn't pass, so it never ran.
export type SetupStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'timed-out' | 'stopped' | 'skipped'

/** What one step did in a workspace's latest setup run. Its output is in a log file next to the setup log. */
export interface SetupStepResult {
  name: string
  command: string
  timeoutSec?: number
  // G3 · O19: ran alongside the other steps of its group.
  parallel?: boolean
  status: SetupStepStatus
  startedAt?: string
  durationMs?: number
  exitCode?: number
  // Times it ran in this run (2 after an automatic retry or Retry failed step).
  attempts?: number
}

/** A workspace's latest setup run. Retry failed step continues the same run; Run setup again starts a new one. */
export interface SetupRun {
  id: string
  startedAt: string
  finishedAt?: string
  steps: SetupStepResult[]
}

/** A named command whose exit code counts as a check result (tests, lint, typecheck). */
export interface CheckCommand {
  name: string
  command: string
  // Where it is defined; filled in when settings are resolved.
  source?: 'local' | 'shared'
  // A local check that replaces a shared one of the same name.
  overrides?: boolean
}

export type CheckStatus = 'running' | 'passed' | 'failed' | 'timeout' | 'cancelled' | 'interrupted' | 'error'

/** What a check result was recorded against; a result is stale when any part differs now. */
export interface CheckFingerprint {
  // Git tree of the whole working tree (gitignored files excluded).
  tree: string
  // Hash of the command text.
  command: string
  // The settings layer that supplied the command.
  source: 'local' | 'shared'
}

/** One check's recorded result in a workspace. */
export interface CheckResult {
  name: string
  command: string
  status: CheckStatus
  exitCode?: number
  durationMs?: number
  startedAt: string
  // The full output, kept on disk.
  logPath: string
  fingerprint: CheckFingerprint
}

/** The latest run of the repository's checks in a workspace. */
export interface WorkspaceChecks {
  running: boolean
  results: CheckResult[]
  // The working tree changed since the results were recorded (kept current when the tree is looked at).
  stale?: boolean
}

/** A check command waiting for approval before its first run. */
export interface CheckConsentItem {
  name: string
  command: string
  // The command last run under this name in this workspace, when it changed.
  previous?: string
  source: 'local' | 'shared'
}

export interface CheckRow {
  name: string
  command: string
  source: 'local' | 'shared'
  result?: CheckResult
  // Never run, or recorded against a different tree, command or settings layer.
  stale: boolean
}

/** Configured checks and their results as of now. */
export interface ChecksStatus {
  configured: boolean
  running: boolean
  rows: CheckRow[]
  // Recorded results for checks that are no longer configured are left out.
}

export type RunChecksOutcome = { started: true } | { started: false; consent: CheckConsentItem[] }

export interface PreviewUrl {
  name: string
  // $FOREMAN_PORT and $((FOREMAN_PORT + n)) are substituted.
  url: string
}

/**
 * Everything a repository can configure for itself. Each value comes from the
 * first layer that sets it: this Mac's repo settings, then the repo's committed
 * .foreman/settings.toml, then the user's settings, then the default.
 */
export interface RepoSettings {
  // A layer may still store one setup script (older state, `setup = "…"` in settings.toml); it is one step called Setup.
  // Resolved, this is the steps' commands, one per line: empty means there is no setup.
  setupScript: string
  // O19: setup as ordered steps, resolved from either form.
  setupSteps: SetupStep[]
  // Run a failed or timed-out step once more before setup stops. Off by default.
  setupRetryOnce: boolean
  // Resolved, the archive steps' commands, one per line (like setupScript): empty means there is no archive script.
  archiveScript: string
  // G3 · O19: the archive script as ordered steps (`[[scripts.archive.steps]]`), resolved from either form.
  archiveSteps: SetupStep[]
  runScripts: RunScript[]
  // Run by "Run checks"; empty means checks aren't configured.
  checks: CheckCommand[]
  // Globs; changed files matching one are flagged as sensitive. Gitignored files are never checked.
  sensitivePaths: string[]
  // Run the checks after a completed turn, once nothing else is working in the workspace. Off by default.
  checksAfterTurn: boolean
  // Warn on Home when the base branch has moved and now conflicts with committed work (needs git 2.38). Off by default.
  warnBaseMoved: boolean
  // Claude may offer up to three follow-up chips under a completed answer. On by default.
  suggestFollowups: boolean
  // 'exclusive' stops other workspaces' run scripts in this repo first.
  runMode: 'exclusive' | 'concurrent'
  autoRunAfterSetup: boolean
  // Gitignore-style patterns; matching gitignored files are copied into new workspaces.
  filesToCopy: string[]
  spotlightTesting: boolean
  previewUrls: PreviewUrl[]
  prompts: CustomPrompts
  deleteBranchOnArchive: boolean
  // O18: when archiving, `docker rm -f` the containers labelled foreman.workspace=<id>. Off by default.
  removeDockerContainers: boolean
  // G3 · O18: with it, also remove the containers' anonymous volumes (`rm -v`) and the networks they leave unused. Off by default.
  removeDockerExtras: boolean
  archiveOnMerge: boolean
  pushAutoSetupRemote: boolean
  // New workspaces default to working directly in the repository folder instead of a new worktree.
  workInRepoFolder: boolean
  envFiles: string[]
  // #2: add instructions about `foreman report` / `review` to new chats' system prompt. Off by default; this Mac's layer only.
  teachAgents: boolean
  // #2: agents may use `foreman run` and `foreman send` (calls carrying a turn token are refused otherwise). Cooperative, off by default; this Mac's layer only.
  agentsMayStart: boolean
}

export type RepoSettingKey = Exclude<keyof RepoSettings, 'prompts'> | `prompts.${keyof CustomPrompts}`
export type SettingSource = 'local' | 'shared' | 'user' | 'default'

/** Values saved on this Mac for one repository; missing keys inherit. */
export type RepoLocalSettings = Partial<Omit<RepoSettings, 'prompts'>> & { prompts?: Partial<CustomPrompts> }

/** A patch to the local layer; null removes the value so it inherits again. */
export type RepoSettingsPatch = { [K in Exclude<keyof RepoSettings, 'prompts'>]?: RepoSettings[K] | null } & {
  prompts?: { [K in keyof CustomPrompts]?: string | null }
}

export interface ResolvedRepoSettings {
  values: RepoSettings
  // Where each value came from; keys left at their default are omitted.
  sources: Partial<Record<RepoSettingKey, SettingSource>>
  // Where the value would come from without this Mac's override (for "Overriding …" labels).
  inherited: Partial<Record<RepoSettingKey, SettingSource>>
  // The committed settings file in use, if any (read-only in the app).
  sharedFile?: string
  sharedError?: string
}

export type RepoIcon = { kind: 'lucide'; name: string } | { kind: 'emoji'; value: string } | { kind: 'image'; dataUrl: string }

export interface Repo {
  id: string
  name: string
  rootPath: string
  // Evidence for matching this repository on another machine; never identity.
  remoteUrl?: string
  rootCommit?: string
  defaultBranch: string
  // The remote to push to, pull from and open pull requests against.
  remote: string
  hasOrigin: boolean
  // Before Integrations: the gh account (login) GitHub work in this repo ran as. Moved into
  // `integrations` once (Integrations.migrate) and never written again; still read from old backups.
  githubAccount?: string
  // githubAccount was picked by Foreman (only one signed-in account could push), not by the user.
  githubAccountDetected?: boolean
  // Which GitHub, Linear and Slack connections this repository uses (Repository settings → Integrations).
  // On this Mac only; never read from settings.toml, so a committed file can't choose accounts.
  integrations?: import('./integrations').RepoIntegrations
  icon?: RepoIcon
  // The "Set up this repo" hint was dismissed (or used) for this repo.
  setupHintDismissed?: boolean
  // #17: auto review, approved on this Mac through its consent dialog. Absent means off (the default); never read from settings.toml.
  autoReview?: AutoReviewConsent
  // Cloud workspaces on Vercel Sandbox: this repository's cloud settings and its base
  // build. On this Mac only, like integrations; never read from settings.toml. Absent means never set up (cloudDefaults()).
  cloud?: RepoCloud
  local: RepoLocalSettings
  createdAt: string
}

// ---- cloud workspaces ----

/** A cloud workspace's sandbox as Foreman last saw it. `capped`: the session hit the plan's time limit during a turn. */
export type CloudStatus = 'creating' | 'running' | 'sleeping' | 'waking' | 'capped' | 'unresponsive' | 'archived' | 'gone' | 'failed'

/** The sandbox a cloud workspace lives in. Provider-neutral names: the renderer never sees the SDK's. */
export interface WorkspaceCloud {
  provider: CloudProviderId
  // The connection it was made with, when the repository chose one; absent: the provider's default connection.
  connectionId?: string
  // The provider's session cap when Foreman last asked (the capped banner and quit sheet say it); absent without a cap.
  maxSessionMs?: number
  // The sandbox name, foreman-ws-<workspaceId>.
  id: string
  status: CloudStatus
  region: string
  vcpus: number
  // The worktree inside the sandbox (/vercel/sandbox/repo).
  cwd: string
  sessionExpiresAt?: string
  lastActivityAt?: string
  error?: string
  // The base build it was forked from.
  buildId?: string
  // Phase 2: the Foreman version whose agent host bundle is in the sandbox (re-uploaded on wake when it differs).
  hostVersion?: string
  // A turn still runs in the sandbox but Foreman lost its connection to it: the banner offers Reconnect (Api.cloudReattach).
  disconnected?: true
}

/** One build of a repository's base sandbox (its "cloud computer"): the clone plus the install script, snapshotted. */
export interface CloudBuild {
  id: string
  snapshotId?: string
  status: 'building' | 'active' | 'failed'
  startedAt: string
  finishedAt?: string
  // The tail of the build's output.
  log?: string
  // The commit the clone was at.
  commit?: string
  error?: string
  // Phase 2: the Foreman version whose agent host bundle was installed in /vercel/foreman.
  hostVersion?: string
  // The provider (and chosen connection) the base was built on. Absent: Vercel, from before there were others.
  provider?: CloudProviderId
  connectionId?: string
}

/**
 * Phase 2: whether a cloud workspace can be made for a repository right now, so the dialog can say why not before
 * trying. `running` lists the sandboxes holding the slots when the soft limit is reached.
 */
export type CloudPreflight = (
  | { ok: true }
  | { ok: false; reason: 'limit' | 'unavailable' | 'disabled' | 'no-build'; running?: { workspaceId: string; name: string }[]; message: string }
) & { provider?: CloudProviderView }

/**
 * A repository's sandbox provider as the window sees it: which one, through which connection, and its limits and
 * capabilities as the provider reports them (the static defaults in shared/cloud.ts CLOUD_PROVIDERS when it can't be made).
 */
export interface CloudProviderView {
  id: CloudProviderId
  connectionId?: string
  connectionName?: string
  // The connection can be used now (no network was asked).
  ready: boolean
  limits: PlanLimits
  capabilities: ProviderCapabilities
}

/** One provider's usage this month (Settings → Remote workspaces), with its limits for the running bar. */
export interface CloudUsageView {
  provider: CloudProviderId
  usage: CloudUsage
  limits: PlanLimits
  capabilities: ProviderCapabilities
  // The provider's default connection, when there is one.
  connectionId?: string
  connectionName?: string
  running: number
}

export interface RepoCloud {
  enabled: boolean
  // Where its remote workspaces run. Absent: shared/cloud.ts repoProvider() (the user's default sandbox connection, else Vercel).
  provider?: CloudProviderId
  // A specific connection of that provider's service; absent or '': the service's default connection.
  connectionId?: string
  // One of the provider's capabilities().vcpuOptions.
  vcpus: number
  // '' for providers without regions.
  region: string
  // Sleep a workspace's sandbox after this long with no turn, terminal or focus.
  idleMinutes: number
  // After a session cap ends a turn, wake and continue without asking (phase 2).
  autoContinue: boolean
  // "Install software": bash, run once per base build with `set -euo pipefail`.
  installScript: string
  build?: CloudBuild
  // Running cloud workspaces of this repository at once (a soft limit).
  maxRunning?: number
}

/** Personal cloud settings (Settings → Cloud workspaces). Absent means the defaults (shared/cloud.ts cloudSettings). */
export interface CloudSettings {
  enabled: boolean
  claudeAuth: 'setup-token' | 'api-key'
  // Stop (never delete) sandboxes tagged app=foreman that no workspace here owns, at launch.
  stopOrphansOnLaunch: boolean
  deleteSnapshotsOnForget: boolean
  // Running cloud workspaces across the app (a soft limit below the plan's concurrency).
  maxRunning: number
  // Opening a sleeping cloud workspace wakes its sandbox (PLAN §5 "wake on open"); off, it stays asleep until Wake or a turn.
  wakeOnOpen: boolean
}

/** What `sandbox.stop()` receipts added up to this month. */
export interface CloudUsage {
  // YYYY-MM, local time.
  month: string
  activeCpuMs: number
  stops: number
  // Provisioned memory (vCPUs × 2 GB × session hours), from receipts that carry the session's length and size.
  memoryGbHours?: number
}

// ---- environment variables ----

export type EnvScope = { kind: 'user' } | { kind: 'repo'; repoId: string }

export interface EnvVarRow {
  key: string
  // saved: stored by Foreman in this scope; file: from an env file; shared: from the repo's settings.toml.
  origin: 'saved' | 'file' | 'shared'
  file?: string
  // In an inherited list: hidden by a value set for the repository.
  overridden?: boolean
}

export interface EnvFileInfo {
  // As entered (may be relative or start with ~).
  path: string
  resolved: string
  count: number
  error?: string
}

export interface EnvView {
  vars: EnvVarRow[]
  files: EnvFileInfo[]
  // Repository pages only: read-only layers underneath.
  shared?: EnvVarRow[]
  inherited?: EnvVarRow[]
}

// 'history': the chat is readable but there is no worktree on this machine (imported); Activate provisions one.
export type WorkspaceState = 'creating' | 'setting-up' | 'ready' | 'setup-failed' | 'error' | 'archived' | 'history'
export type WorkspaceStatus = 'backlog' | 'in-progress' | 'in-review' | 'done' | 'canceled'

export interface HeldMessage {
  sessionId: string
  text: string
  at: string
  // The template the message came from, kept so its follow-up survives the hold.
  templateId?: string
  // Text of a GitHub issue or PR, attached as a file when the message is sent.
  intake?: IntakeFile
  // Files chosen with the message (absolute paths), copied into the workspace when it is sent.
  files?: string[]
}

/** A Linear issue as New workspace shows it, read with the repository's Linear connection. */
export interface LinearLinkInfo {
  issue?: import('./linearLink').LinearIssueSummary & { description: string }
  // The connection it was read with.
  connection?: string
  // The new branch it would get.
  branch?: string
  // Why it can't be used: no Linear here, another workspace's issue, not found.
  problem?: string
}

/** Untrusted text from outside (an issue or PR), kept apart from the instructions and sent as an attachment. */
export interface IntakeFile {
  name: string
  content: string
}

/** Turns, agent time and cost for one chat tab; cost is absent when the agent doesn't report it. */
export interface TabUsage {
  turns: number
  agentMs: number
  costUsd?: number
  // Why there is no cost, e.g. "Cost: n/a for Codex".
  costNote?: string
}

/** Per-tab usage and the workspace total, counting each turn once. Partial: some tab with turns has no cost. */
export interface WorkspaceUsage {
  tabs: Record<string, TabUsage>
  total: TabUsage & { partial: boolean }
}

/** A turn's start-to-end change touched files matching the repo's sensitive paths (or couldn't be compared). */
export interface SensitiveAlert {
  id: string
  sessionId: string
  turnId: string
  // The checkpoint refs compared: the turn's start and end.
  startRef: string
  endRef: string
  files: string[]
  // A checkpoint was missing, so nothing is known about this turn (never "clean").
  unavailable?: boolean
  at: string
}

export interface Workspace {
  id: string
  repoId: string
  name: string
  branch: string
  // The generated branch name; auto-rename only replaces this one.
  placeholderBranch?: string
  // The original catalog name, retained when the workspace/branch is renamed for its task.
  namesake?: string
  baseBranch: string
  // A local binding, absent while the workspace is history only (imported, no worktree here) and for cloud workspaces.
  path?: string
  // A cloud workspace: its worktree and agent live in this sandbox instead of a folder here.
  cloud?: WorkspaceCloud
  portBase: number
  state: WorkspaceState
  status?: WorkspaceStatus
  // #21: when the status was last set, for the board's Done window. Absent for statuses set before #21.
  statusAt?: string
  pinned?: boolean
  diffStat?: DiffStat
  error?: string
  // The first message, held because setup failed. It was never sent; "Start
  // anyway" sends it.
  heldMessage?: HeldMessage
  // The pull request this workspace checked out (in the base repository, owner/name), so a fork PR is found by number, not by branch name.
  // O2: gitlabHost (host[:port]) marks a GitLab merge request; repo is then the project's path and number its !iid.
  pullRequest?: { repo: string; number: number; gitlabHost?: string }
  // The pull request last seen for this branch (any lookup), so Home rows can say "PR #42".
  // #21: facts carries checks, review and conflicts as last read, with when, for the board's Ready to merge.
  prInfo?: { number: number; state: PullRequestInfo['state']; url?: string; facts?: import('./board').PrFacts }
  // Opt-in notifications about the pull request (CI failures, review comments) and their dedup state.
  prWatch?: PrWatch
  // #5: "Send CI failures to the agent automatically": what the user consented to, the fixes sent and why it stopped.
  autoFix?: AutoFix
  // #17: auto reviews of this workspace (newest last): running, ready or stopped, each tied to the tree it read.
  autoReviews?: AutoReview[]
  // Opt-in (a repo setting): what the last look at the moved base found. Notify only, never rebases.
  baseWatch?: BaseWatch
  // Results of "Run checks": evidence of what was run, not approval.
  checks?: WorkspaceChecks
  // Checks after a turn (a repo setting), while one is waiting for the workspace to go quiet, running, or held for approval. Not kept across restarts.
  autoChecks?: { state: 'waiting' | 'running' | 'needs-approval' }
  // Sensitive files changed during a turn, until dismissed or rewound.
  alerts?: SensitiveAlert[]
  // #2: what agents reported with `foreman report` / `review`: open needs-input, stuck and review requests, plus recent history.
  agentReports?: import('./agentReports').AgentReport[]
  // O19: the latest setup run, step by step.
  setupRun?: SetupRun
  // Files in Changes marked viewed; each only holds for the version it was marked at.
  viewed?: ViewedMark[]
  archiveCommit?: string
  // An existing worktree added from disk: archiving leaves its folder and branch alone.
  adopted?: boolean
  // Works in the repository folder itself, straight on its branch (no worktree). Always adopted too.
  direct?: boolean
  // Set when this workspace came from an export file.
  provenance?: Provenance
  // Variable names an import said this workspace needs; shown until set (values never travel).
  variablesToSet?: string[]
  // An imported history workspace that carries its branch and uncommitted work (a git bundle) for Activate.
  carried?: { branch: string; head: string; checkpointRef: string; files: number; omitted: number }
  // Human-owned guidance shared by the workspace's tabs. Saving it sends nothing.
  note?: WorkspaceNote
  // Workspaces started together by Compare models share this id (the source workspace included).
  compareId?: string
  compare?: CompareMember
  // A hand-off to or from another Mac in progress or unresolved (P-4). While set to frozen, handed-off or staged, nothing is sent, checked or run here.
  transfer?: WorkspaceTransfer
  // Created by a schedule: which one, and the run's occurrence id.
  scheduled?: { scheduleId: string; occurrenceId: string }
  createdAt: string
  archivedAt?: string
  // G3 · #13: the diff kept at archive time (its files are in a log file; this is the summary).
  archiveDiff?: { at: string; files: number; additions: number; deletions: number; truncated?: boolean }
  // G3 · O18: Docker containers the archive couldn't remove (or couldn't check), for Home's line until removed or dismissed.
  dockerLeft?: DockerLeft
}

/** A template run later, on a cadence the user approved (R-5). Claude only, permission mode auto; never starts anything while Foreman is closed. */
export interface Schedule {
  id: string
  templateId: string
  // As it was when scheduled, for rows that outlive the template.
  templateName: string
  repoId: string
  baseBranch: string
  recurrence: 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly'
  // Earliest eligible local calendar date in `timezone` (YYYY-MM-DD).
  startDate: string
  // 0 = Sunday … 6 = Saturday, as the wall clock of `timezone` says them.
  weekdays: number[]
  // Nominal monthly day; shorter months use their last day without changing this value.
  dayOfMonth?: number
  // HH:MM, 24 hour, wall clock in `timezone` (so it holds across daylight saving).
  time: string
  timezone: string
  model: string
  maxMinutes: number
  state: 'active' | 'paused' | 'finished'
  // Why it is paused, in words; `pausedKind` says what clears it.
  pausedReason?: string
  pausedKind?: 'user' | 'failures' | 'changed'
  // The next planned run (ISO, UTC) while active.
  nextRunAt?: string
  consecutiveFailures: number
  // Hashes of what was approved: template text and revision, repo setup, checks, repo MCP config.
  approved: ScheduleFingerprint
  approvedAt: string
  createdAt: string
}

/** What the Schedule dialog sends. */
export interface ScheduleRequest {
  templateId: string
  templateName: string
  repoId: string
  baseBranch: string
  recurrence: Schedule['recurrence']
  startDate: string
  weekdays: number[]
  dayOfMonth?: number
  time: string
  timezone: string
  // Claude only: other agents can't pause for approvals. Anything else is refused.
  agent: AgentKind
  model: string
  maxMinutes: number
}

export interface ScheduleFingerprint {
  template: string
  setup: string
  checks: string
  mcp: string
}

/** What a schedule's fingerprint stands for, in words: what the approval covers besides the cadence. */
export interface ScheduleSummary {
  templateName: string
  // The template file's revision (a repo template's git blob SHA); personal templates have none.
  templateRev?: string
  templateSource: 'personal' | 'repo'
  repoName: string
  baseBranch: string
  // The repo's setup script as the run would use it ('' when there is none).
  setupScript: string
  checks: { name: string; command: string }[]
  // The repo's proposed MCP servers (names) and the accounts its integrations give a run (e.g. "linear: Work (read)").
  mcpServers: string[]
  integrations: string[]
}

export interface ScheduleFingerprintView {
  fingerprint: ScheduleFingerprint
  summary: ScheduleSummary
}

/**
 * One planned run. Written (and flushed) before anything launches, so a crash leaves a record.
 * needs-you: it asked for an approval or a question and was stopped for the human. uncertain: Foreman closed mid-run; never retried.
 */
export interface Occurrence {
  id: string
  scheduleId: string
  plannedAt: string
  startedAt?: string
  endedAt?: string
  state: 'starting' | 'running' | 'completed' | 'failed' | 'needs-you' | 'cancelled' | 'timed-out' | 'skipped' | 'uncertain'
  reason?: string
  workspaceId?: string
  sessionId?: string
}

export interface WorkspaceNote {
  text: string
  // r1, r2, ...: goes up by one on every save that changes the text.
  revision: number
  updatedAt: string
}

// Where an imported workspace or session came from.
export interface Provenance {
  exportId: string
  sourceMachine: string
  importedAt: string
  // Only from files made before shared exports went path-free; tool paths under it show relative to the workspace.
  sourceRoot?: string
}

export interface BranchInfo {
  name: string
  local: boolean
  // Exists on the repo's remote.
  remote: boolean
  isDefault: boolean
  // Path of the worktree that has it checked out, if any.
  checkedOutAt?: string
}

export interface WorktreeInfo {
  path: string
  branch?: string
  head: string
  // The repository's main checkout.
  isMain: boolean
  // Uncommitted changes (files).
  dirty: number
  // Already a Foreman workspace.
  workspaceId?: string
}

/** How a workspace took part in a Compare: the prompt it was given, the model's name and the tab that got it. */
export interface CompareMember {
  prompt: string
  label: string
  sessionId?: string
}

export interface CompareRequest {
  // The tab in the source workspace that also gets the prompt (it must be idle).
  sessionId: string
  prompt: string
  // One or two extra models or loadouts, one sibling workspace each.
  models: Loadout[]
}

export interface CompareResult {
  compareId: string
  workspaces: Workspace[]
}

export interface CreateWorkspaceOptions {
  // Branch to start from; defaults to the repo's base branch.
  baseBranch?: string
  // A new branch (auto-named unless `name` is given), an existing one to check out in a new
  // worktree, or one to work on directly in the repository folder.
  branch?: { kind: 'new'; name?: string } | { kind: 'existing'; name: string } | { kind: 'direct'; name: string }
  // Direct workspaces only: run the setup script in the repository folder.
  runSetup?: boolean
  // Sent to the first chat once the workspace is ready.
  prompt?: string
  // The prompt template the first message was written from.
  templateId?: string
  // Files for the first message (absolute paths), copied into the workspace when it is sent.
  attachments?: string[]
  // Agent and model for the first chat; defaults to loadout slot 1.
  loadout?: Loadout
  // Create the worktree but hold before setup until continueSetup (Compare restores a checkpoint first).
  deferSetup?: boolean
  // A GitHub issue or PR URL. Its text is attached to the first message as a file; a PR's head is checked out.
  githubUrl?: string
  // A Linear issue (URL or id like ENG-123), read with the repository's Linear connection. Its text is
  // attached like an issue's, and a new branch without a name takes Linear's branch name.
  linearIssue?: string
  // Set by the app from githubUrl: check out refs/pull/N/head of this repository (owner/name).
  // O2: with gitlabHost, refs/merge-requests/N/head of that GitLab project.
  pullRequest?: { repo: string; number: number; gitlabHost?: string }
  // Where the worktree lives: a folder here (the default) or a cloud sandbox.
  location?: 'local' | 'cloud'
}

export interface AdoptWorktreeOptions {
  runSetup: boolean
  prompt?: string
  templateId?: string
  attachments?: string[]
  loadout?: Loadout
}

export interface QueuedMessage {
  id: string
  // The id the turn will have once it starts, chosen when queued so a receipt (`foreman send`) can name it.
  turnId?: string
  text: string
  attachments: Attachment[]
  // The template this message came from, and its follow-up as it was when sent.
  templateId?: string
  followUp?: MessageFollowUp
  repoTemplate?: { name: string; rev: string }
  // Set when this message delivers the workspace note itself.
  noteRevision?: number
  // Leave pending review comments out of this message (they stay pending).
  skipComments?: boolean
  // The session's queue revision when this message was queued or last edited (see editQueued).
  revision?: number
  // Queued by `foreman send`, so a script may be waiting on its turn.
  via?: 'cli'
  // #5: queued by auto-fix CI; the receipt goes with the turn it starts.
  origin?: MessageOrigin
}

/** Which way a queued message moves: towards the front (sent sooner) or the back. */
export type QueueMove = 'up' | 'down'

/**
 * What became of an edit or move of a queued message. Refused when dispatch already took the
 * message ('started'), it was deleted ('removed'), or the queue changed since the caller looked ('stale').
 * `revision` is the queue revision after the call either way.
 */
export type QueueChangeResult = { ok: true; revision: number } | { ok: false; reason: 'started' | 'removed' | 'stale'; revision: number }

/** A template's follow-up, copied onto the message that used the template. */
export interface MessageFollowUp extends TemplateFollowUp {
  templateId: string
}

export interface ContextUsage {
  used: number
  limit: number
}

/** One chat tab. Each tab has its own agent conversation. */
export interface Session {
  id: string
  workspaceId: string
  title?: string
  titleSetByUser?: boolean
  agent: AgentKind
  model: string
  effort?: EffortLevel
  fastMode: boolean
  planMode: boolean
  // Claude only, when tool approvals are required.
  autoAcceptEdits?: boolean
  // The agent's own id for the conversation (Claude session, Codex thread).
  agentSessionId?: string
  // Uuid of the last top-level assistant message, used to rewind the conversation.
  lastAssistantUuid?: string
  // Set after a rewind: the next turn forks the conversation at this message.
  resumeAt?: string
  status: 'idle' | 'running'
  // The turn in flight (while running) and when it began. After a restart a
  // session that still has a turnId was cut off mid-turn.
  turnId?: string
  turnStartedAt?: string
  // How the last turn ended, for the Home rows. Cleared when the next turn starts.
  lastTurn?: { outcome: TurnOutcome; turnId?: string; endedAt: string; additions?: number; deletions?: number }
  queue: QueuedMessage[]
  // Goes up with every change to the queue (queued, edited, moved, sent, removed); edits and moves are checked against it.
  queueRevision?: number
  contextUsage?: ContextUsage
  // Claude Code output style, fixed when the chat starts.
  outputStyle?: string
  // A scheduled run: nobody is there to answer, so tools run in auto mode and any approval or question stops it.
  // #17: an auto review's reviewer turn is unattended the same way (its approvals are denied and the review stops).
  unattended?: { occurrenceId: string } | { autoReviewId: string }
  // #17: this tab is an auto review's read-only reviewer; its turns never start another review.
  autoReview?: { reviewId: string }
  // Closed tabs stay restorable until the workspace is archived.
  closedAt?: string
  // Set when this session came from an export file.
  provenance?: Provenance
  // 'foreign': the agent's own session came from another machine, so it never resumes natively here.
  nativeLineage?: 'foreign'
  // How an import left this tab: read-only history, or a fresh continuation (a new agent conversation seeded by nothing but the visible history).
  importedMode?: 'history' | 'fresh' | 'native'
  // Native import made as a copy: the next turn continues as a new Claude session (a fork) instead of the same id.
  forkOnResume?: boolean
  // This session was forked from an imported one: its mirror begins at the fork, so turns resume from the local file.
  nativeFork?: boolean
  // Forked from another tab (after one of its turns, or its latest; `before`: from just before that turn's message, #16 Edit and resend).
  forkedFrom?: { sessionId: string; turnId?: string; before?: boolean }
  // A fork with no agent conversation to branch: its next message carries the visible history. Cleared once the agent started.
  // O1 'switch': the tab was switched to an agent with no conversation of its own here.
  seedHistory?: boolean | 'switch'
  // O1: the own conversations of agents this tab was switched away from, resumed on switching back.
  parked?: Partial<Record<AgentKind, import('./switchAgent').ParkedSession>>
  // O1: switched back to a parked conversation; the next message carries a note of what was said since this turn (its last). Cleared once the agent started.
  catchUpSince?: string
  // #16: Foreman holds this chat to read-only (Claude: plan mode it can't leave; Codex: the read-only sandbox). Fixed for the tab.
  readOnly?: boolean
  // The newest note revision this tab was given (with a message or on its own).
  noteRevision?: number
  // #2: whether this chat was started with "Teach agents Foreman" on. Fixed at its first message, so later turns keep what it started with.
  foremanTaught?: boolean
  // Include the note with this tab's next message (the new-chat checkbox); cleared once it went.
  includeNote?: boolean
  // #11: a resume armed after a usage limit; any activity in the tab removes it.
  limitResume?: LimitResume
  // #20: the repo MCP servers (names) this tab's last turn got, and when that set was first passed. The receipt names them when it changes.
  repoMcp?: { servers: string[]; at: string }
  // Integrations: the accounts this tab's last turn used per service, and the user's own MCP servers it switched off.
  // The receipt names a change.
  integrations?: { snapshot: import('./integrations').IntegrationSnapshot[]; ownOff: string[] }
  createdAt: string
  lastActivityAt?: string
}

export interface DiffStat {
  files: number
  additions: number
  deletions: number
}

// #22: 'agent' runs a Terminal agent's own CLI in the worktree (`command` is its catalog id).
export type PtyKind = 'shell' | 'run' | 'command' | 'snippet' | 'saved' | 'agent'

export type ThemeSetting = 'system' | 'light' | 'dark'
// The window's layout: one workspace with its side panel (panes), or several workspaces' chats side by side (tiles).
export type WindowLayout = 'panes' | 'tiles'
// Which window edge a pane sits against.
export type PaneSide = 'left' | 'right'
// Where the Run / Setup / Terminal panel goes: inside the side panel (below or above the changes) or under the chat.
export type TerminalPlacement = 'panel-bottom' | 'panel-top' | 'below-chat'
// #21: Home as today's list, or as the board.
export type HomeLayout = 'list' | 'board'

export type AgentAuthMode = 'cli' | 'apiKey'

export type SoundSetting = 'chime' | 'bell' | 'pop' | 'marimba' | 'none'
export type ColorVision = 'default' | 'protanopia-deuteranopia' | 'tritanopia'
export type BranchPrefixType = 'github' | 'custom' | 'none'

export interface Settings {
  // General
  // Foreman's UI language (O13): 'system' follows the OS. Never applied to user content.
  language: LanguageSetting
  messageSendKey: 'enter' | 'mod-enter'
  followUpMode: 'queue' | 'steer'
  notifications: boolean
  sound: SoundSetting
  dockBadge: boolean
  // #3: the menu-bar extra (macOS) or tray icon (Windows) with the attention count and a jump list.
  trayIcon: boolean
  // Pastes longer than 5000 characters become a text attachment.
  autoConvertLongText: boolean
  // Remove "You're absolutely right!" from replies.
  notAbsolutelyRight: boolean
  // The Foreman assistant (sidebar → Assistant): off hides it everywhere.
  assistantEnabled: boolean
  // The welcome tour was finished or skipped, so it doesn't open by itself again (Help → Welcome tour replays it).
  tourSeen: boolean
  // The first run (the pages shown in place of the empty Home) was finished or skipped. Existing users start as true.
  onboardingSeen: boolean
  // The Get started checklist on Home: when each milestone was first reached, and whether it was hidden.
  onboarding: import('./onboarding').OnboardingState
  // Show the context wheel always, not only above 70%.
  alwaysShowContextUsage: boolean
  // Keep the computer awake while an agent is working.
  keepAwake: boolean
  // O17 cutoffs (see shared/keepAwake.ts): let it sleep on battery below a percent,
  // when macOS reports thermal pressure, or whenever it's off power.
  keepAwakeBatteryCutoff: boolean
  keepAwakeBatteryPercent: number
  keepAwakeThermalCutoff: boolean
  keepAwakeOnlyOnPower: boolean
  // Tool calls start expanded (⌃O toggles).
  expandToolCalls: boolean
  // The custom command (#14: "Custom command…" in the Open menu); before #14 this was the only editor.
  editorCommand: string
  // #14: what the Open button, ⌘O and the file viewer use ('' is Automatic), and the user's own path per app.
  openInDefault: OpenInChoice
  openInPaths: Record<string, string>
  // Prompt templates
  promptTemplates: PromptTemplate[]
  // Account
  githubAuth: 'cli' | 'token'
  // Turns off features that send data to an AI provider outside a chat (generated titles and branch names).
  privacyMode: boolean
  requireToolApprovals: boolean
  codexApprovals: 'sandboxed' | 'always'
  // Appearance
  theme: ThemeSetting
  zoom: number
  coloredSidebarDiffs: boolean
  colorVision: ColorVision
  monoFont: string
  codeLigatures: boolean
  terminalFont: string
  // 10-20 px, or 'content' to follow contentFontSize.
  terminalFontSize: number | 'content'
  // Accessibility: the size of chat Markdown, diff code and the file viewer in px (12-24); the interface keeps its own scale.
  contentFontSize: number
  // 'auto' follows the OS's reduce-motion preference; the renderer resolves it into html[data-reduce-motion].
  reduceMotion: 'auto' | 'on' | 'off'
  // Accessibility: what the window's live region says about agents. 'needs-me': only what waits on you, in any chat;
  // 'my-chat': that plus started and finished for the open chat; 'all': started and finished for every chat too.
  announce: 'needs-me' | 'my-chat' | 'all'
  // The end-of-turn sentence ("Claude finished in api-fix: this turn 3 files, +120 -14") instead of the bare "finished".
  announceSummary: boolean
  // Four short cues (started, needs me, finished, failed) in place of the completion sound.
  earcons: boolean
  // Accessibility: Foreman's own voice (phase G1). 'on' speaks announcements through the OS's local voices instead of the
  // live region (one voice); 'off' leaves them to the screen reader. speechVoice is a voice URI ('' = the UI language's
  // default local voice); speechRate is 0.5-2 and speechVolume 0-1.
  speechOutput: 'off' | 'on'
  speechVoice: string
  speechRate: number
  speechVolume: number
  // Accessibility: speech input (phase G2). sttProvider 'local' runs the bundled sherpa-onnx model on this computer;
  // 'openai' sends the audio to OpenAI with the user's own key (refused under Privacy mode). sttLanguage is a language
  // code ('en'); pushToTalk 'hold' records while the keys are down, 'toggle' starts on one press and stops on the next.
  sttProvider: 'local' | 'openai'
  sttLanguage: string
  pushToTalk: 'hold' | 'toggle'
  // Layout
  windowLayout: WindowLayout
  sidebarSide: PaneSide
  sidePanelSide: PaneSide
  terminalPlacement: TerminalPlacement
  // #21 Board view on Home: off by default; the layout Home opens in once it's on; how many days Done keeps finished work.
  homeBoard: boolean
  homeLayout: HomeLayout
  homeDoneDays: number
  // Default models
  loadouts: Loadout[]
  reviewModel: Loadout
  claudeOutputStyle: string
  defaultPlanMode: boolean
  // Git
  workspacesRoot: string
  branchPrefixType: BranchPrefixType
  // The custom prefix, used when branchPrefixType is 'custom'.
  branchPrefix: string
  autoRenameBranches: boolean
  renameWorkspaceWithBranch: boolean
  deleteBranchOnArchive: boolean
  archiveOnMerge: boolean
  automerge: boolean
  optionalChecksBlock: boolean
  pushAutoSetupRemote: boolean
  openPrIn: 'github' | 'graphite'
  stackedPrs: boolean
  // O2: self-managed GitLab hosts (https base URLs); gitlab.com is always GitLab. Tokens live in the vault.
  gitlabHosts: string[]
  // Agents
  claudeAuth: AgentAuthMode
  codexAuth: AgentAuthMode
  claudeExecutablePath: string
  codexExecutablePath: string
  opencodeExecutablePath: string
  // Lets Claude Code drive Chrome through its extension (claude --chrome).
  chromeMode: boolean
  // OpenCode models shown in the picker (OpenCode can list hundreds).
  opencodeModels: string[]
  // O8: model ids each agent hides from the model picker (see shared/modelVisibility.ts).
  hiddenModels: HiddenModels
  // #22: per agent in the catalog (shared/agentCatalog.ts): enabled, Login or API key, executable path. Absent: the catalog's defaults.
  agentPrefs: AgentPrefs
  // #22: provider key (env var) → the agents ticked to get it. OpenCode always gets every key.
  providerKeyAgents: ProviderKeyAgents
  // Environment
  envFiles: string[]
  // Where Open GitHub project clones to (the last folder used).
  cloneDirectory: string
  // Experimental
  autoPermissionMode: boolean
  autoRunAfterSetup: boolean
  forkToNewTab: boolean
  showResourceUsage: boolean
  // Advanced
  terminalScrollbackMb: number
  // Selecting text in a terminal copies it (O3).
  terminalCopyOnSelect: boolean
  // Phase 4: xterm's screen reader mode (a hidden, readable copy of the output). 'auto' follows the OS: on while it reports a screen reader.
  terminalScreenReader: 'auto' | 'on' | 'off'
  // Terminal tabs come back after a restart with their names and last output, dimmed (O3). The processes never do.
  restoreTerminals: boolean
  // O10: Claude Code and Codex turns run in a background host, so Quit can leave them running (off until turned on).
  keepAgentsRunning: boolean
  // O4, Windows only: the shell new terminal tabs start (Custom… uses terminalShellCustom, a path and
  // arguments), and the shell that runs Run scripts, setup, archive and checks.
  terminalShell: ShellChoice
  terminalShellCustom: string
  scriptShell: ScriptShellChoice
  // O9: your saved shell commands (Automations → Commands). The repo's own are in the snapshot's repoCommands.
  savedCommands: SavedCommand[]
  // Data & devices: /clear and rewind keep only content-free receipts unless this is on.
  keepClearedHistory: boolean
  // One database backup a day, into backupFolder (empty: a backups folder in Foreman's data folder).
  dailyBackup: boolean
  backupFolder: string
  // Hand off to another Mac (P-4): listen on the local network for paired Macs (off by default), and on which port.
  acceptHandOffs: boolean
  devicePort: number
  mobileEnabled: boolean
  mobileUrl: string
  mobileLanEnabled: boolean
  mobileLanAddress: string
  // Cloud workspaces; absent until changed (see shared/cloud.ts cloudSettings for the defaults).
  cloud?: CloudSettings
}

// API keys shown on the Agents page; they live in Settings → Environment.
export const AGENT_KEYS = ['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'CURSOR_API_KEY'] as const
export type AgentKeyName = (typeof AGENT_KEYS)[number]

export interface DataInfo {
  path: string
  dataFolder: string
  sizeBytes: number
  // User and assistant messages in live chats.
  messages: number
  migration?: {
    status: 'migrated' | 'fresh'
    at: string
    counts: { workspaces: number; sessions: number; comments: number; items: number; checks: number }
    malformed: number
    malformedSample: { file: string; line?: number; reason: string }[]
    warnings: string[]
  }
  legacy: { files: number; bytes: number }
  backupFolder: string
  lastBackup?: { at: string; path: string }
  // Claude's own transcripts mirrored in foreman.db, and how many batches failed to mirror.
  claudeTranscripts: { sessions: number; errors: number; partial?: number }
}

export interface ChatSearchOptions {
  // Tool names, inputs and output are searched only when asked for.
  includeToolOutput?: boolean
  limit?: number
}

/** One message (or tool call) found in any chat. The snippet marks matches with \u0001 and \u0002. */
export interface ChatHit {
  sessionId: string
  itemId: string
  workspaceId: string
  workspaceName: string
  repoName: string
  tabTitle: string
  agent: AgentKind
  model: string
  kind: ChatItem['kind']
  snippet: string
  at: string
  archived: boolean
  closed: boolean
  // Found in history that /clear or a rewind removed from the chat (only with Keep cleared history).
  cleared: boolean
}

/** A workspace note that matched a search. Markers as in ChatHit. */
export interface NoteHit {
  workspaceId: string
  workspaceName: string
  repoName: string
  revision: number
  snippet: string
  archived: boolean
}

export interface BackupResult {
  path: string
  manifest: string
  attachments: number
  missingAttachments: number
  at: string
}

export interface Attachment {
  name: string
  // Absolute path inside the workspace's .context/attachments folder.
  path: string
  kind: 'image' | 'pdf' | 'text' | 'file'
}

/** One thing Foreman added to a message or the agent's instructions, with its size and where it came from. */
export interface ContextPart {
  // O1 'catch-up': what was said while another agent had the chat, for an agent resuming its own conversation.
  // #20 'mcp': the repo MCP servers this turn got, shown only when the set changed since the tab's last turn.
  // 'integrations': which GitHub, Linear or Slack account this turn uses, when that changed since the tab's last turn,
  // and the user's own same-service MCP servers switched off here.
  kind: 'instructions' | 'note' | 'comments' | 'attachments' | 'history' | 'foreman' | 'catch-up' | 'mcp' | 'integrations'
  // The short form for the receipt line: "note r3", "2 review comments".
  label: string
  // Characters added (bytes for attachments; the number of servers for 'mcp'; of accounts and servers for 'integrations').
  size: number
  unit: 'chars' | 'bytes' | 'servers' | 'accounts'
  // Where it came from, for the expanded list.
  source: string
  // What it is made of: the comment locations, the attachment names.
  detail?: string
  // The note revision.
  revision?: number
}

export type ChatItem =
  | {
      kind: 'user'
      id: string
      turnId: string
      text: string
      at: string
      attachments?: Attachment[]
      // Delivered into a running turn rather than starting one.
      steered?: boolean
      // Checkpoint id saved just before this turn ran.
      checkpoint?: string
      // Where the conversation stood before this turn, for rewinding to it.
      resumeFrom?: { sessionId: string; messageUuid: string }
      // The follow-up of the template this message was written from, as it was when sent.
      followUp?: MessageFollowUp
      // The workspace note went with this message (or is the message), at this revision.
      noteRevision?: number
      // The assistant: Foreman sent this on the user's behalf, with the result of a command they ran.
      system?: true
      // The repo template this message was written from, by name and file revision (blob SHA).
      repoTemplate?: { name: string; rev: string }
      // What Foreman added to this message when it was sent, recorded as assembled (not the agent's full context).
      added?: ContextPart[]
      // #5: Foreman sent this message itself (auto-fix CI), and why.
      origin?: MessageOrigin
      // #16: this turn ran read-only, and how Foreman enforced it.
      readOnly?: ReadOnlyEnforcement
      // O1: the agent and model this turn was sent to (a tab can switch agents).
      agent?: AgentKind
      model?: string
      // G4 #12: the user edited this message in the queue after it had started, so it ran as it was before the edit.
      editRaced?: true
    }
  | { kind: 'assistant'; id: string; turnId: string; text: string; streaming?: boolean }
  | { kind: 'thinking'; id: string; turnId: string; text: string; streaming?: boolean }
  | {
      kind: 'tool'
      id: string
      turnId: string
      name: string
      input: unknown
      status: 'running' | 'done' | 'error'
      output?: string
      // A subagent or shell this call started, which may outlive the call itself.
      task?: TaskProgress
    }
  // O10: `gap` marks where Foreman was closed while the turn kept running in the background host.
  // #2: `report` marks a line the agent reported ("agent says: checkpoint — …"); needs-input shows as a card while open.
  | { kind: 'notice'; id: string; turnId?: string; level: 'info' | 'error'; text: string; action?: 'sign-in' | 'open-settings'; gap?: import('./agentHost').ClosedGap; report?: import('./agentReports').ReportMarker; switched?: import('./switchAgent').AgentSwitch; divider?: import('./switchAgent').ChatDivider }
  | { kind: 'result'; id: string; turnId: string; ok: boolean; costUsd?: number; durationMs?: number; turns?: number }
  // Internal: how a turn ended, appended once when it does. The only item that says "completed".
  | {
      kind: 'turn-end'
      id: string
      turnId: string
      outcome: TurnOutcome
      // The cause, for error and interrupted.
      error?: string
      durationMs?: number
      // What this turn changed, when both its checkpoints exist.
      delta?: TurnDelta
      // Claude only: up to three chips the agent offered after a completed turn. They fill the composer; they are never a status.
      suggestions?: string[]
      // #11: the error was a usage or plan limit (and, when its words said so, when the limit resets).
      limit?: UsageLimit
      // Cloud workspaces: with outcome `interrupted`, what cut the turn off (see TurnInterruption).
      interrupted?: TurnInterruption
    }

/** #11: what a failed turn's error said about a usage limit. No `resetAt`: the reset time is unknown. */
export interface UsageLimit {
  // When the limit resets, read from the result error's own words.
  resetAt?: string
  // Those words ("resets 2:30pm (Europe/London)"), quoted on the card.
  source?: string
  // The zone the words named; absent when they named none (read as this computer's zone).
  timeZone?: string
  // G4: the time came from the SDK's structured rate_limit_event (the error's words named none); `source` is then the limit's type.
  from?: 'event'
}

/** #11: one resume armed after a usage limit, at most one per tab. It sends `text` through the tab's queue once. */
export interface LimitResume {
  // The turn that hit the limit.
  turnId: string
  resetAt: string
  // When it sends: the reset time plus a small buffer.
  at: string
  source: string
  // G4: `source` is the rate-limit event's limit type, not words quoted from the error.
  from?: 'event'
  text: string
  armedAt: string
  // Foreman was closed or the computer asleep at `at` (or the send failed): it asks instead of sending late.
  missed?: true
  // Why the send at `at` didn't go, when it was tried.
  failed?: string
}

/** completed: the agent reported success. cancelled: the user stopped it ("Stopped"). interrupted: the app quit mid-turn. */
export type TurnOutcome = 'completed' | 'error' | 'cancelled' | 'interrupted'

/**
 * Cloud workspaces (phase 2): why an `interrupted` turn stopped, on its turn-end item and in the agent's TurnResult.
 * `session-cap`: the sandbox's session reached the plan's time limit (45 minutes on Hobby) mid-turn; the files are
 * kept. With the repository's autoContinue on and Foreman open, a continuation turn is queued at once; otherwise
 * the chat offers Continue (Api.cloudContinue). `connection-lost`: Foreman couldn't reach the sandbox for a while,
 * which is still running, so the agent may still be working there; its hosted record is kept and Reconnect
 * (Api.cloudReattach, or the next wake or status read) picks the turn up again.
 */
export type TurnInterruption = 'session-cap' | 'connection-lost'

/** What one turn changed: the diff between its start and end checkpoints. */
export interface TurnDelta {
  files: { path: string; additions: number; deletions: number }[]
  additions: number
  deletions: number
}

export interface TaskProgress {
  status: 'running' | 'completed' | 'failed' | 'stopped'
  // Runs in the background: the tool call returned while the task carries on.
  background?: boolean
  startedAt?: string
  toolUses?: number
  tokens?: number
  durationMs?: number
  lastTool?: string
  // What it is doing now, or how it ended.
  summary?: string
}

export interface Question {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

export type ApprovalRequest = {
  id: string
  sessionId: string
} & (
  | {
      kind: 'tool'
      toolName: string
      input: Record<string, unknown>
      reason?: string
      // What the "alternate" (⌘↵) answer means for this tool, if anything.
      alternate?: 'edits-for-session' | 'always-allow'
    }
  | { kind: 'plan'; plan: string }
  | { kind: 'question'; questions: Question[] }
)

export type ApprovalResponse =
  | { kind: 'tool'; allow: boolean; alternate?: boolean; message?: string }
  | { kind: 'plan'; approve: boolean; feedback?: string; handOff?: boolean }
  | { kind: 'question'; answers?: Record<string, string>; skipped?: boolean }

export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  // The blob this file has now (from git diff --raw); absent for diffs between checkpoints.
  blobId?: string
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  binary: boolean
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

// O5: where the Changes panel's diff comes from. `picked` and `commit` take commit ids; `commit` is the Commits tab's read-only view.
export type DiffScope = 'all' | 'uncommitted' | 'staged' | 'last-commit' | 'last-3' | 'picked' | 'pr' | 'commit'

// O5: why a source has nothing to show (shown disabled in the source menu, or as the empty state).
export type DiffSourceBlock = 'no-commits' | 'no-pr' | 'not-pushed' | 'no-picks' | 'not-applicable' | 'failed'

/** O5: file counts for the source menu, read from git when it opens. */
export interface DiffSourceInfo {
  counts: Partial<Record<DiffScope, number>>
  blocked: Partial<Record<DiffScope, DiffSourceBlock>>
  baseRef: string
  // Commits on the branch since the merge base (first-parent).
  branchCommits: number
  // How many commits "Last 3 commits" covers (fewer when the branch has fewer).
  lastN: number
  lastCommit?: { sha: string; subject: string }
  pr?: { number: number; provider?: 'gitlab' }
}

/** O5: one commit on the branch for the Commits tab. */
export interface BranchCommit {
  sha: string
  subject: string
  author: string
  // The git author is this repo's user.email.
  you: boolean
  at: string
  files: number
  additions: number
  deletions: number
  // Reachable from the remote branch; null when the branch has no remote copy.
  pushed: boolean | null
  // Only when Foreman saw this tab's tool call make the commit (its output named this commit). Otherwise unknown.
  tab?: { sessionId: string; title: string }
}

export interface BranchCommits {
  baseRef: string
  mergeBase: string
  commits: BranchCommit[]
  // More commits than listed.
  more: boolean
  uncommitted: { files: number; staged: number; additions: number; deletions: number }
  // The remote branch's head, when there is one.
  pushedTo?: string
}

export interface WorkspaceDiff {
  baseRef: string
  scope: DiffScope
  files: DiffFile[]
  truncated: boolean
  // O5: why this source shows nothing (no PR, nothing pushed, picked commits that don't apply alone).
  unavailable?: DiffSourceBlock
  // O5: the commits this diff covers, newest first (last N, picked, a single commit).
  commits?: string[]
  // Where the branch started (or HEAD for uncommitted); viewed marks are keyed by it.
  mergeBase?: string
}

/** A file marked viewed, as of one version of it and one branch point. */
export interface ViewedMark {
  path: string
  blobId: string
  mergeBase: string
}

export interface PrCheck {
  name: string
  state: 'pending' | 'success' | 'failure' | 'skipped' | 'neutral'
  url?: string
  runId?: number
  jobId?: number
  // Whether branch protection requires it; unknown when absent.
  required?: boolean
  // O2 (GitLab jobs): the pipeline stage, a manual job nobody started, and how long it ran (seconds).
  stage?: string
  manual?: boolean
  duration?: number
  // G2 (GitLab): a trigger (bridge) job, and the downstream pipeline it started.
  trigger?: boolean
  downstream?: { id: number; status?: string }
}

/** "Notify me when CI fails on this PR". Present while opted in. */
export interface CiWatch {
  // repo#number the state below belongs to; a different PR starts over.
  pr?: string
  // The head SHA a notification was sent for: at most one per SHA.
  notified?: string
  // CI is failing on this head right now (cleared on recovery, a new head, close or merge).
  failure?: { sha: string; checks: string[] }
  // The head SHA whose failure the user has dealt with (Fix CI, or dismissed).
  acked?: string
}

/** "Notify me about new review comments". Present while opted in. */
export interface ReviewWatch {
  // repo#number the ids below belong to; a replacement PR is baselined again without notifying.
  pr?: string
  // Inline comment ids and review-summary ids (with their state) already known.
  seenComments: string[]
  seenReviews: Record<string, string>
  // New since the user last looked; cleared when they open the thread list or send.
  unseen: { comments: string[]; reviews: string[] }
}

/** What "Base moved" last saw: both tips it compared, the committed conflicts, and the dedup state. */
export interface BaseWatch {
  // The base tip and branch head the result belongs to.
  base?: string
  head?: string
  // Paths that conflict between the committed branch and the base tip.
  conflicts: string[]
  // The worktree had uncommitted changes, which this result does not cover.
  untested?: boolean
  // The base tip already announced, and the one the user dealt with.
  notified?: string
  acked?: string
  checkedAt?: string
}

/** #5 Auto-fix CI: what the user approved for one workspace. A different tab, agent, permissions or prompt asks again. */
export interface AutoFixConsent {
  // The tab fixes are sent to, and its agent when approved.
  sessionId: string
  agent: AgentKind
  // What the tab may do without asking (permissionNote), as approved.
  permissions: string
  // The Fix errors instructions, word for word, as approved.
  prompt: string
  perHead: number
  perPr: number
  maxMinutes: number
  at: string
}

/** Why auto-fix stopped for the PR. Only the user turns it back on. */
export type AutoFixStop = 'failed' | 'stopped' | 'timeout' | 'no-commit' | 'budget' | 'consent' | 'send-failed'

/** One fix Foreman sent. Recorded (and its failure spent) before it is sent, so a restart can't send it twice. */
export interface AutoFixAttempt {
  // The failure it answers: the head commit and its failing checks.
  sha: string
  checks: string[]
  at: string
  sessionId: string
  turnId: string
  // running: the fix turn is going; waiting: it finished and Foreman is looking for a new head commit; done.
  state: 'running' | 'waiting' | 'done'
  endedAt?: string
}

export interface AutoFix {
  consent: AutoFixConsent
  // repo#number the attempts belong to; a different PR starts its budget over.
  pr?: string
  attempts: AutoFixAttempt[]
  // Failures already spent: PR + head SHA + sorted failing check names. Never sent again.
  consumed: string[]
  stopped?: { reason: AutoFixStop; at: string; detail?: string }
}

/** #5: what the consent dialog shows, and what approving it binds. */
export interface AutoFixShown {
  sessionId: string
  agent: AgentKind
  permissions: string
  prompt: string
}

export interface AutoFixPreview extends AutoFixShown {
  perHead: number
  perPr: number
  maxMinutes: number
  // The PR's own word: "PR #42" or "MR !87", when known.
  pr?: string
}

// ---- #17 Auto review ----

/** #17: what the consent dialog shows for a repository, and what turning auto review on binds. */
export interface AutoReviewShown {
  // Claude Code or Codex only: the agents Foreman can hold to read-only.
  reviewer: Loadout
  // Globs ("skip when only these change").
  exclusions: string[]
  perDay: number
  maxMinutes: number
  idleMinutes: number
  // How read-only is enforced for the reviewer's agent.
  readOnly: ReadOnlyEnforcement
  // The reviewer's first message as it would be sent (the repo's Code review preferences included), before the diff.
  prompt: string
}

export interface AutoReviewConsent extends AutoReviewShown {
  at: string
  // What consent covered changed since (the review preferences, or read-only for the agent): nothing runs until it's approved again.
  paused?: { reason: string; at: string }
}

export type AutoReviewSeverity = 'high' | 'medium' | 'low'

/** #17: one finding, as read from the reviewer's answer. */
export interface AutoReviewFinding {
  id: string
  // As the reviewer rated it; absent when it didn't say.
  severity?: AutoReviewSeverity
  file?: string
  line?: number
  title: string
  body: string
  // Sent to a worker tab by the user (Send to worker…), never by Foreman on its own.
  sent?: { sessionId: string; at: string }
}

export type AutoReviewState = 'running' | 'ready' | 'stopped' | 'timed-out' | 'needs-you' | 'failed'

/** #17: one auto review: what started it, the tree and diff it read, and what came of it. */
export interface AutoReview {
  id: string
  workspaceId: string
  repoId: string
  // The worker tab and turn whose completion started it.
  workerSessionId: string
  workerTurnId: string
  // The read-only tab the reviewer runs in, once it exists.
  reviewerSessionId?: string
  turnId: string
  // The working tree the diff was captured from (a git tree hash).
  tree: string
  diff: { baseRef: string; files: number; additions: number; deletions: number; cut: boolean }
  reviewer: Loadout
  readOnly: ReadOnlyEnforcement
  // The checks for that tree when it started: all passed, or none configured.
  checks: 'passed' | 'none'
  // Its place in the repository's budget for the day ("4 of 6 today").
  n: number
  of: number
  maxMinutes: number
  startedAt: string
  endedAt?: string
  state: AutoReviewState
  reason?: string
  // Read from the reviewer's answer; absent when Foreman couldn't read them (the answer is still in the tab).
  findings?: AutoReviewFinding[]
  // The worktree no longer matches the reviewed tree. The findings stay readable.
  stale?: { at: string }
  dismissed?: boolean
}

/** #5: a message Foreman sent itself, and why (shown as a receipt under it). */
export interface MessageOrigin {
  kind: 'auto-fix'
  sha: string
  checks: string[]
  // This fix's count on the head commit: "1 of 2".
  n: number
  of: number
}

export interface PrWatch {
  ci?: CiWatch
  reviews?: ReviewWatch
  // The sign-in problem was already shown; cleared by the next good lookup.
  authNotified?: boolean
}

export interface PullRequestInfo {
  number: number
  url: string
  title: string
  body?: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus?: string
  reviewDecision?: string
  baseRefName: string
  checks: PrCheck[]
  // GitHub will merge it once checks pass.
  autoMerge?: boolean
  // O2: a GitLab merge request (number is its !iid); absent for a GitHub pull request.
  provider?: 'gitlab'
  // G2 (#21, GitHub): who approved, from each reviewer's latest review. Absent when nobody has.
  approvedBy?: string[]
  // O2 (GitLab): approvals given and required, and who approved. Absent when GitLab didn't say.
  approvals?: { given: number; required: number; by: string[] }
  // O2 (GitLab): the head pipeline; its jobs are `checks`.
  pipeline?: { id: number; status: string; url?: string; sha?: string }
  // O2 (GitLab): why GitLab won't merge it now. Absent when it can, or when that isn't known.
  mergeBlocked?: import('./scm').MergeBlock[]
  // GitHub (Integrations' Slack rules): who opened it, who is asked to review it now (people by login, teams by
  // slug), and each reviewer's latest approving or change-requesting review.
  author?: string
  createdAt?: string
  // When it merged (ISO); absent unless merged.
  mergedAt?: string
  reviewRequests?: { login?: string; team?: string }[]
  reviews?: { id: string; author: string; state: 'APPROVED' | 'CHANGES_REQUESTED' }[]
}

export interface ReviewComment {
  id: string
  author: string
  body: string
  url: string
  createdAt: string
  updatedAt: string
  diffHunk: string
}

export interface ReviewThread {
  id: string
  path: string
  line: number | null
  side: 'LEFT' | 'RIGHT'
  isResolved: boolean
  isOutdated: boolean
  comments: ReviewComment[]
}

export type GitActionKind =
  | 'commit-and-push'
  | 'create-pr'
  | 'create-draft-pr'
  | 'create-pr-web'
  | 'push'
  | 'pull'
  | 'merge'
  | 'fix-errors'
  | 'rerun-checks'
  | 'resolve-conflicts'
  | 'ready-for-review'
  | 'review'
  | 'open-pr'
  | 'automerge'
  | 'archive'

export interface GitStatus {
  branch: string
  baseRef: string
  upstream?: string
  hasRemote: boolean
  // Relative to the branch's upstream.
  ahead: number
  behind: number
  // Relative to the base branch the workspace came from.
  aheadBase: number
  behindBase: number
  uncommitted: number
  conflicted: boolean
  // The workspace's branch is its base branch (a direct workspace): changes go straight to it, no pull request.
  onBase: boolean
  ghAvailable: boolean
  pr?: PullRequestInfo
  // Why the pull request could not be read, when the lookup failed rather than found nothing.
  prProblem?: { kind: 'auth-error' | 'unavailable'; message: string }
  // O2: the repository is on a GitLab host (read with that host's token), or on a host that looks like GitLab but isn't set up.
  scm?: { kind: 'gitlab'; host: string; tokenSaved: boolean } | { kind: 'unknown-gitlab'; host: string }
  primary: { action: GitActionKind | null; label: string; tone?: 'green' | 'red' | 'amber' | 'purple' }
  // A cloud workspace whose sandbox is asleep: the last status read while it ran, and when (ISO).
  asOf?: string
}

export interface DiffComment {
  id: string
  workspaceId: string
  file: string
  line: number
  body: string
  author: 'user' | 'agent'
  // For agent comments: which agent/model wrote it.
  authorLabel?: string
  // user: pending until sent with the next message. agent: open until resolved.
  // #15: a selection action waits as `queued` while its tab is busy, and is `held` when its lines changed (or it isn't sent yet).
  state: 'pending' | 'sent' | 'open' | 'resolved' | 'queued' | 'held'
  createdAt: string
  // #15: the lines it quotes, and for Explain / Change this / Ask the tab it goes to.
  selection?: DiffSelection
  sessionId?: string
  sentAt?: string
  // Sent with "Send as selected" after its lines changed.
  outdated?: boolean
  // Held because the lines are different now: what they are and when that was found.
  // G2: changedBy, the tabs whose turns touched the file since the selection (empty: none Foreman saw; absent: not looked).
  stale?: { lines: string[]; checkedAt: string; changedBy?: string[] }
}

/** #15: lines picked in a diff, as they were seen. `line` on the comment is `end`. */
export interface DiffSelection {
  action: 'explain' | 'change' | 'ask' | 'comment'
  side: 'old' | 'new'
  start: number
  end: number
  // The text of lines start..end on that side.
  lines: string[]
  // Which diff they came from: the file's blob then (new side), its old path, and the base it was compared with.
  scope: 'all' | 'uncommitted'
  oldPath?: string
  blobId?: string
  mergeBase?: string
  at: string
}

/** #15: what became of a selection action. */
export interface SelectionSendResult {
  status: 'sent' | 'queued' | 'held'
  commentId: string
  sessionId?: string
}

export interface AgentStatus {
  agent: AgentKind
  installed: boolean
  ready: boolean
  version?: string
  // e.g. "Claude Max account", "API key", "ChatGPT login".
  method?: string
  account?: string
  detail?: string
}

export interface SearchMatch {
  file: string
  line: number
  text: string
}

export interface FileContent {
  content: string
  binary: boolean
  tooLarge: boolean
}

export interface SlashCommandInfo {
  name: string
  description: string
  // Found on disk (Claude): a .claude/commands file or a .claude/skills folder, in the repo or the home folder.
  kind?: 'command' | 'skill'
  source?: 'repo' | 'home'
}

// G1 'passed': handed to an agent that can't report whether it connected (Codex, OpenCode, Chat agents, Cursor).
export type McpConnectionStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'passed'

/** One MCP server as the agent reports it. */
export interface McpServerInfo {
  name: string
  status: McpConnectionStatus
  // Why it failed.
  error?: string
  // Where it is configured: user, project, local, plugin, claudeai, managed…
  scope?: string
  // stdio, http, sse or claudeai-proxy, with its URL or command.
  transport?: string
  target?: string
  // Tool names, once connected.
  tools?: string[]
  // Where Foreman got it, when it did: "from repo · approved on this Mac".
  origin?: string
}

/** Vault scopes a repo's MCP server may read its environment variables from. */
export type McpScope = 'user' | 'repo'

/** A server a repository proposes in `[mcp.servers.<name>]` of .foreman/settings.toml. Env holds names only; values come from the vault. */
export interface RepoMcpServer {
  name: string
  command: string
  args: string[]
  env: string[]
  scopes: McpScope[]
}

/** One proposed server as this Mac sees it for a workspace. */
export interface RepoMcpProposal {
  server: RepoMcpServer
  // What approval is tied to: command, args, env names, scopes and the content of any repo script it runs.
  fingerprint: string
  // Repo files the command runs, with the hash of what is in the workspace now.
  scripts: { path: string; hash: string }[]
  // 'changed': this name was approved before, but something in it is different now.
  state: 'approved' | 'new' | 'changed'
  // Declared variables with no value in the allowed scopes.
  missingEnv: string[]
}

export interface RepoMcpView {
  proposals: RepoMcpProposal[]
  // Some proposal has never been put in front of the user on this Mac (new, or changed).
  unseen: boolean
  // The settings file they came from.
  file?: string
}

export interface McpStatusResult {
  // False when the chat's agent can't report MCP status.
  supported: boolean
  servers: McpServerInfo[]
  // True when read from the chat's running agent rather than a separate check.
  live: boolean
  // G1: the agent reports no MCP status, so this is only the repo's servers and what Foreman passed it.
  repoOnly?: { agent: string; passedAt?: string }
}

/** One agent's model list as it last reported it. */
export interface ModelCatalogEntry {
  models: ModelInfo[]
  // G1: an ACP agent's session modes as it last declared them (listing its models, or starting a turn); a plan mode turns its Plan chip on.
  modes?: import('./agentCatalog').AcpMode[]
  fetchedAt?: string
  // Why the last fetch failed; the previous list stays in use.
  error?: string
  loading?: boolean
}

export interface ModelCatalogState {
  agents: Partial<Record<AgentKind, ModelCatalogEntry>>
  // Claude Code's output styles, e.g. default, Concise, Explanatory.
  outputStyles: string[]
}

export interface AppSnapshot {
  repos: Repo[]
  workspaces: Workspace[]
  sessions: Session[]
  comments: DiffComment[]
  settings: Settings
  repoSettings: Record<string, ResolvedRepoSettings>
  // Repository id → templates found in its .foreman/templates (read-only).
  repoTemplates: Record<string, PromptTemplate[]>
  // O9: repository id → commands its .foreman/settings.toml shares (read-only), each marked approved or not here.
  repoCommands: Record<string, SavedCommand[]>
  // Saved agent API keys: the last four characters ('' when too short to show), or absent.
  agentKeys: Partial<Record<AgentKeyName, string>>
  // #22: agent id → last four characters of its own saved API key ('' when too short), for every agent with one.
  agentKeyHints: Record<string, string>
  // Repository id → workspace currently mirrored into the repo root.
  spotlight: Record<string, string>
  catalog: ModelCatalogState
  // Repository folders opened before that aren't in Foreman now, most recent first.
  recentRepos: string[]
  // Scheduled templates and their recent runs (R-5).
  schedules: Schedule[]
  occurrences: Occurrence[]
  // Hand-offs to and from other Macs, including ones left unresolved (P-4).
  transfers: Transfer[]
  pairedDevices: PairedDevice[]
  platform: string
  homeDir: string
  // Whether the OS reports a screen reader (Electron's accessibilitySupportEnabled); what 'auto' in terminalScreenReader follows.
  screenReader?: boolean
  // Whether Foreman is holding the computer awake, and why not (O17).
  keepAwake: KeepAwakeStatus
  // Turns and check runs a quit or crash stopped, until each is retried or dismissed (#1).
  stopRecord?: StopRecord
  // O10: what Foreman reattached to after a keep-running quit, until dismissed.
  reconnected?: import('./agentHost').ReconnectRecord
  // Integrations: connections (no secrets), Slack rules, people and suggestions.
  integrations: import('./integrations').IntegrationsView
  // Slack messages waiting for the user's Send or Skip (Ask first), for Home.
  slackAsks: import('./integrations').SlackDelivery[]
}

// O21: a folder dropped on the window or named on the command line, as the Add repository confirmation shows it.
/** Who commits for "Make it a Git repository" when Git has no name and email. `global` also saves them for every repository. */
export interface GitIdentity {
  name: string
  email: string
  global?: boolean
}

/** 'needs-identity': nothing was committed; ask for a GitIdentity and call again. */
export type MakeRepoResult = { ok: true; repo: Repo } | { ok: false; reason: 'needs-identity' }

/** addRepo's error for a folder outside any repository, which the UI offers to fix. */
export function isNotGitRepoError(err: unknown): boolean {
  return /is not inside a git repository/i.test(err instanceof Error ? err.message : String(err))
}

export interface DroppedFolder {
  // Absolute, as dropped.
  path: string
  name: string
  // repo: a git repo not in Foreman yet. added: its repo is in Foreman already. not-git: a folder outside any git repo.
  // file and missing: not a folder; the confirmation leaves these out.
  kind: 'repo' | 'added' | 'not-git' | 'file' | 'missing'
  // The repo's top folder, which is what gets added (differs from path for a folder inside a repo).
  root?: string
  // The checked-out branch, or null when detached.
  branch?: string | null
  // origin as host/path (no scheme or credentials), or null without one.
  origin?: string | null
  // Where its workspaces would go.
  workspacesDir?: string
  // For added: the repo in Foreman.
  repoId?: string
}

/** What a notification is about, whatever language its text is in (see MainEvent's notify). */
export type NotifyKind = 'finished' | 'stopped' | 'attention' | 'info'

export type MainEvent =
  | { type: 'browser-open'; workspaceId: string; url: string }
  | { type: 'browser-state'; workspaceId: string; state: import('./browser').BrowserState }
  | { type: 'browser-shortcut'; workspaceId: string; action: 'address' | 'close' }
  | { type: 'state'; snapshot: AppSnapshot }
  | { type: 'chat-item'; sessionId: string; item: ChatItem }
  | { type: 'chat-reset'; sessionId: string; items: ChatItem[] }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved'; id: string }
  // O19: `step` and `runId` when the chunk is a setup step's output (the step's own log gets it too).
  | { type: 'setup-log'; workspaceId: string; chunk: string; step?: number; runId?: string }
  // A repository's cloud base build: a chunk of its output (setup-log is per workspace; a build is per repository).
  | { type: 'cloud-build-log'; repoId: string; buildId: string; chunk: string }
  | { type: 'pty-data'; ptyId: string; data: string }
  | { type: 'pty-exit'; ptyId: string; code: number }
  // A cloud terminal went read-only (its sandbox is asleep or unreachable; `reason` says which) or live again.
  | { type: 'pty-state'; ptyId: string; asleep: boolean; reason?: string }
  // sessionId is empty for notices about the workspace as a whole; `action` is what clicking it opens.
  // `kind` (O13b) says what it is, since title and body are in the user's language: a turn that finished or was
  // stopped, something that needs the user (phone pushes go out for these), or anything else.
  | { type: 'notify'; workspaceId: string; sessionId: string; title: string; body: string; action?: 'fix-ci' | 'keep-awake'; kind?: NotifyKind }
  // Setup finished and the repo has "Auto-run after setup" on.
  | { type: 'auto-run'; workspaceId: string }
  // A line of `git clone` output for the clone dialog.
  | { type: 'clone-progress'; cloneId: string; line: string }
  // `foreman run --open` started this workspace; switch to it.
  | { type: 'show-workspace'; workspaceId: string }
  // `foreman settings path <key> --open`: open Settings at this registry row.
  | { type: 'show-setting'; id: string }
  // Help → Report a problem… (O20): open the dialog.
  | { type: 'report-problem' }
  // Help → Welcome tour: start the tour.
  | { type: 'tour' }
  // O21: a second launch named folders (dropped on the app's icon); fetch them with takeLaunchFolders.
  | { type: 'launch-folders' }
  // #1: Quit was asked for while something runs; show the Quit sheet.
  | { type: 'quit-requested' }
  // #3: a foreman:// link arrived (navigation only; the window decides where it goes).
  | { type: 'open-link'; url: string }
  // #3: a tray entry: show this workspace (and tab), or Home when none.
  | { type: 'navigate'; workspaceId?: string; sessionId?: string }
  // #3: Home → Recent's history changed.
  | { type: 'attention-history'; events: import('./attention').AttentionEvent[]; seenAt?: string }
  // G3 · #1: an archive step started, finished or failed.
  | { type: 'archive-progress'; workspaceId: string; progress: ArchiveProgress }
  // The assistant: an item of a thread (streaming ones are not saved), and the thread list when it changes.
  | { type: 'assistant-item'; threadId: string; item: ChatItem }
  | { type: 'assistant-threads'; threads: import('./assistant').AssistantThreadSummary[] }
  // Phase G2: speech to text. The words so far (each replaces the last), a failure (sessionId absent for the model download),
  // and the model's download state ('downloading' carries bytes of total).
  | { type: 'stt-partial'; sessionId: string; text: string }
  | { type: 'stt-error'; sessionId?: string; message: string }
  | { type: 'stt-model'; state: 'missing' | 'downloading' | 'ready'; bytes?: number; total?: number }

// `cloud` patches the repository's cloud settings (null puts them back to the defaults); the build is Foreman's own.
export type RepoPatch = Partial<Pick<Repo, 'name' | 'defaultBranch' | 'remote' | 'setupHintDismissed'>> & { icon?: RepoIcon | null; cloud?: Partial<Omit<RepoCloud, 'build'>> | null }

// G2: `status: null` clears the status (the board's Undo, back to a workspace that had none).
export type WorkspacePatch = Partial<Pick<Workspace, 'name' | 'pinned'>> & { status?: WorkspaceStatus | null }

export type SessionPatch = Partial<
  Pick<Session, 'title' | 'agent' | 'model' | 'effort' | 'fastMode' | 'planMode' | 'autoAcceptEdits' | 'includeNote'>
>

// What became of a sent message: it began a turn, went into the running one,
// waited in the queue, or was an app command (or empty) and went nowhere.
export type SendDisposition = 'started' | 'steered' | 'queued' | 'handled'

// #1 Archive, in order: stop running tabs, save uncommitted changes as a checkpoint, run the archive script, remove the folder.
export type ArchiveStep = 'stop' | 'checkpoint' | 'script' | 'remove'

export interface ArchiveOptions {
  // Stop running tabs first instead of refusing.
  stopTabs?: boolean
  // Retry from this step (the earlier ones already went through).
  from?: 'checkpoint' | 'script'
  // "Archive anyway": a failed checkpoint or script is logged and archiving goes on.
  anyway?: boolean
}

// A failed checkpoint or archive script stops the archive before anything is deleted.
// O18: `docker` is the container step's result when it ran; its failures never block the archive.
export type ArchiveOutcome = { ok: true; docker?: DockerRemoval } | { ok: false; step: 'checkpoint' | 'script'; detail: string }

/** G3 · #1: one archive step as it goes, streamed to the dialog (`archive-progress`). */
// `sandbox`: a cloud workspace's sandbox stops (it has no checkpoint or folder steps).
export type ArchiveProgressStep = 'stop' | 'checkpoint' | 'diff' | 'script' | 'docker' | 'remove' | 'sandbox'
export interface ArchiveProgress {
  step: ArchiveProgressStep
  status: 'running' | 'done' | 'failed' | 'skipped'
  // O19: the archive steps' own results while the script step runs.
  scriptSteps?: SetupStepResult[]
  detail?: string
}

/** G3 · #13: the workspace's diff as it was when it was archived, shown read-only in the archived view. */
export interface ArchivedDiff {
  at: string
  baseRef: string
  files: DiffFile[]
  truncated: boolean
}

/** What archiving a workspace stops, keeps and deletes (#1). */
export interface ArchivePreview {
  // worktree: Foreman's own folder, removed. direct/adopted: the folder stays. history: nothing on disk.
  kind: 'worktree' | 'direct' | 'adopted' | 'history'
  running: { sessionId: string; title?: string; model: string; startedAt?: string; lastStep?: { name: string; input: unknown } }[]
  checksRunning: boolean
  folder: string
  branch: string
  // Files with uncommitted changes; null when git couldn't say.
  uncommitted: number | null
  // Commits on the branch that aren't on the remote (or base) branch named in `against`.
  unpushed: { count: number; against: string } | null
  terminals: number
  hasArchiveScript: boolean
  // G3 · O19: the archive script's steps, named, when it has more than one.
  archiveSteps?: { name: string; parallel?: boolean }[]
  // O18: the labelled containers archiving would remove; undefined when the repo doesn't remove them.
  docker?: DockerPreview
}

export interface SendOptions {
  attachments?: Attachment[]
  // Override the follow-up setting for this message while a turn is running.
  mode?: 'queue' | 'steer'
  // The prompt template the message was written from.
  templateId?: string
  // The id for the turn this message starts (or the one it was queued under).
  turnId?: string
  // This message delivers the workspace note at this revision (set by sendNote).
  noteRevision?: number
  // Leave pending review comments out of this message only; they stay pending.
  skipComments?: boolean
  // Sent by `foreman send` (shown on the queued row).
  via?: 'cli'
  // #5: Foreman sends this itself (auto-fix CI); shown as a receipt on the message.
  origin?: MessageOrigin
}

/** What became of a message sent to a chat: its disposition and the turn it belongs to. */
export interface SendReceipt {
  disposition: SendDisposition
  // The turn that carries it: a new one, the running one it steered, or the one a queued message will start.
  turnId?: string
}

/** Where a turn is, looked up by its id. Ended turns come from the persisted turn-end. */
export interface TurnStatus {
  workspaceId: string
  sessionId: string
  turnId: string
  state: 'queued' | 'starting' | 'running' | 'ended'
  outcome?: TurnOutcome
  error?: string
  durationMs?: number
  delta?: TurnDelta
}

/** Why a new chat is being started from another one. */
export type HandOffKind = 'second-opinion' | 'review' | 'continue'

/** What a new chat would be given, as the source chat and the files stood when the dialog opened. */
export interface HandOffPreview {
  kind: HandOffKind
  sourceId: string
  // The source chat's user messages (not steered ones), oldest first. `hash` binds the preview to the text.
  tasks: { turnId: string; label: string; bytes: number; hash: string }[]
  // The message the last answer replied to.
  defaultTaskTurnId?: string
  answer?: { bytes: number; hash: string; turnId: string }
  // Full diff against the base, or only its stat for Continue.
  diff?: { bytes: number; hash: string; files: number; additions: number; deletions: number; baseRef: string; stat: boolean }
  // The first message to start with.
  message: string
  // The model the dialog starts on.
  model: Loadout
  // The follow-up the latest answer's template suggests, for Continue.
  followUp?: { title: string; prompt: string; model?: Loadout }
  // Set when the action isn't available (e.g. the source is still working).
  blocked?: string
}

export interface HandOffRequest {
  kind: HandOffKind
  model: Loadout
  message: string
  // Which sections to send, and the hashes seen in the preview; any difference now makes the start stale.
  taskTurnId?: string
  answer: boolean
  diff: boolean
  expect: { task?: string; answer?: string; diff?: string }
  // #16: hold the new chat to read-only. Refused for an agent that can't enforce it.
  readOnly?: boolean
}

/** #16: how a read-only chat is held to it: Claude's plan mode with leaving it refused, or Codex's read-only sandbox. */
export type ReadOnlyEnforcement = 'plan' | 'sandbox'

/** `stale`: the source changed since the preview, nothing was started; the dialog should refresh. */
export type HandOffResult = { session: Session } | { stale: string }

export interface GithubRepo {
  fullName: string
  httpsUrl: string
  sshUrl: string
  description?: string
  pushedAt?: string
  private: boolean
}

/** An account signed in to gh for github.com. */
export interface GithubAccount {
  login: string
  // gh's active account (what `gh auth switch` last picked).
  active: boolean
}

/** Which signed-in accounts can push to a repository's GitHub remote. */
export interface AccountDetection {
  // owner/name of the remote, or null when it isn't on github.com.
  slug: string | null
  // The account to use: the only one that can push, else null.
  account: string | null
  pushers: string[]
}

/** O2: a GitLab host in Settings → Git → Accounts. The token itself never leaves the main process. */
export interface GitlabHostRow {
  host: string
  url: string
  // gitlab.com is built in; the others were added by the user.
  selfManaged: boolean
  tokenSaved: boolean
  // Repositories in Foreman whose remote is on this host.
  repos: string[]
}

/** O2: what "Test connection" found: GitLab's version and who the token signs in as. */
export type GitlabConnection = { ok: true; version: string; user: string } | { ok: false; error: string }

export interface GithubStatus {
  installed: boolean
  loggedIn: boolean
  user?: string
  method: 'cli' | 'token'
  // A personal access token is saved (whichever method is selected).
  tokenSaved: boolean
  detail?: string
}

export interface OpencodeProvider {
  envVar: string
  saved: boolean
  // Found in the user's shell environment.
  detected: boolean
}

export interface EnvChange {
  key: string
  // null removes the variable.
  value: string | null
  // When renaming: the old name, which is removed.
  previousKey?: string
}

// Request/response methods, invoked from the renderer.
/** Whether the `foreman` command is on the user's PATH (Settings → Advanced). */
export interface CliInstallStatus {
  installed: boolean
  // Where it runs from when installed.
  path: string | null
  // Something the user still has to do, e.g. open a new terminal.
  note?: string
}

export interface Api {
  getSnapshot(): Promise<AppSnapshot>
  pickDirectory(): Promise<string | null>
  pickFiles(): Promise<string[]>
  // A native open dialog for one file or folder. Returns null when cancelled.
  pickPath(options: { title: string; kind: 'file' | 'directory' | 'save'; defaultPath?: string }): Promise<string | null>
  addRepo(path: string): Promise<Repo>
  // Clone into parentDir/<name> and add it. Progress arrives as clone-progress events with this cloneId.
  // With an account, clones as that gh account and links the new repo to it.
  cloneRepo(url: string, parentDir: string, cloneId: string, account?: string): Promise<Repo>
  // The user's GitHub repos (most recently pushed first) and gh's preferred clone protocol; as `account` when given.
  githubRepos(account?: string): Promise<{ repos: GithubRepo[]; protocol: 'https' | 'ssh'; error?: string }>
  // Every github.com account signed in to gh.
  githubAccounts(): Promise<GithubAccount[]>
  // Which signed-in account can push to the repo's remote. With save, links the repo to it (or clears a detected one).
  detectRepoAccount(repoId: string, save?: boolean): Promise<AccountDetection>
  // Push the repo's remote URL (for the SSH note), or null without one.
  remoteUrl(repoId: string): Promise<string | null>
  // A new empty repository in parentDir/<name>, added to Foreman.
  quickStartRepo(parentDir: string, name: string): Promise<Repo>
  // A folder outside git becomes a repository (git init, its current files, a first commit) and is added. Without a Git name and email it commits nothing and answers needs-identity; call again with `identity`.
  makeRepo(dir: string, identity?: GitIdentity): Promise<MakeRepoResult>
  forgetRecentRepo(path: string): Promise<void>
  // O21: what each dropped path is (a git repo to add, one already added, a folder outside git, or not a folder). Reads only.
  classifyFolders(paths: string[]): Promise<DroppedFolder[]>
  // O21: folders named on the command line (first launch or a later one) not shown yet; empties the list.
  takeLaunchFolders(): Promise<string[]>
  updateRepo(id: string, patch: RepoPatch): Promise<Repo>
  // Deletes the repo's workspaces (worktrees) and chats; the repository folder is untouched.
  removeRepo(id: string): Promise<void>
  updateRepoSettings(repoId: string, patch: RepoSettingsPatch): Promise<void>
  // With fetch, updates from the remote first.
  listBranches(repoId: string, options?: { fetch?: boolean }): Promise<BranchInfo[]>
  listRemotes(repoId: string): Promise<string[]>
  // `patterns` are the ones applied: .worktreeinclude's when the repo has one.
  previewFilesToCopy(repoId: string, patterns?: string[]): Promise<{ files: string[]; fromWorktreeInclude: boolean; patterns: string[] }>
  // A favicon found in the repo (public/favicon.svg and similar), as a data URL.
  detectRepoIcon(repoId: string): Promise<string | null>
  // Opens .foreman/settings.toml (created if missing) in the editor.
  openRepoSettingsFile(repoId: string): Promise<void>
  // Environment variables (Settings → Environment)
  envView(scope: EnvScope): Promise<EnvView>
  setEnvVars(scope: EnvScope, changes: EnvChange[]): Promise<void>
  revealEnvVar(scope: EnvScope, key: string, layer?: 'own' | 'shared' | 'inherited'): Promise<string | null>
  setEnvFiles(scope: EnvScope, files: string[]): Promise<void>
  // Copy an agent key from the user's shell into Settings → Environment.
  importKeyFromShell(name: AgentKeyName): Promise<boolean>
  opencodeProviders(): Promise<OpencodeProvider[]>
  setProviderKey(envVar: string, value: string | null): Promise<void>
  // Integrations (Settings → Integrations; Repository settings → Integrations)
  addConnection(input: import('./integrations').NewConnection): Promise<import('./integrations').AddConnectionResult>
  updateConnection(id: string, patch: import('./integrations').ConnectionPatch): Promise<import('./integrations').AddConnectionResult>
  checkConnection(id: string): Promise<import('./integrations').ConnectionView>
  connectionRemovalImpact(id: string): Promise<{ repos: string[]; isDefault: boolean; rules: number }>
  removeConnection(id: string): Promise<void>
  setIntegrationDefault(service: import('./integrations').IntegrationService, id: string | null): Promise<void>
  repoIntegrations(repoId: string): Promise<import('./integrations').RepoServiceView[]>
  setRepoIntegration(repoId: string, service: import('./integrations').IntegrationService, choice: string): Promise<void>
  setRepoIntegrationOptions(repoId: string, options: { rules?: 'mine' | 'off'; allowOwnMcp?: import('./integrations').IntegrationService[]; dismissSuggestion?: boolean }): Promise<void>
  applyConnectionToRepos(connectionId: string, repoIds: string[]): Promise<void>
  acceptIntegrationSuggestion(repoId: string): Promise<void>
  // "Make it a connection": the repository's own GH_TOKEN becomes a connection it uses; the variable stays where it is.
  importRepoGithubToken(repoId: string): Promise<import('./integrations').AddConnectionResult>
  integrationActivity(repoId?: string): Promise<import('./integrations').BridgeActivity[]>
  ghAccountsForIntegrations(): Promise<{ login: string; active: boolean; connected: boolean }[]>
  // Slack
  slackManifest(): Promise<{ url: string; json: string }>
  slackPeople(connectionId: string, query: string): Promise<import('./integrations').SlackPersonView[]>
  slackChannels(connectionId: string): Promise<import('./integrations').SlackChannelView[]>
  saveSlackRule(rule: import('./integrations').SlackRule): Promise<import('./integrations').SlackRule>
  consentSlackRule(id: string): Promise<import('./integrations').SlackRule>
  deleteSlackRule(id: string): Promise<void>
  linkPerson(link: import('./integrations').PersonLink): Promise<void>
  unlinkPerson(githubLogin: string, slackTeamId: string): Promise<void>
  slackDeliveries(connectionId?: string): Promise<import('./integrations').SlackDelivery[]>
  answerSlackAsk(id: string, action: 'send' | 'skip', text?: string): Promise<void>
  resendSlackDelivery(id: string): Promise<void>
  // Linear
  linearMyIssues(repoId: string): Promise<{ issues: import('./linearLink').LinearIssueSummary[]; connection: string } | { error: string }>
  resolveLinearLink(repoId: string, ref: string): Promise<LinearLinkInfo>
  // GitHub
  githubStatus(): Promise<GithubStatus>
  setGithubToken(token: string | null): Promise<void>
  // O2: GitLab hosts. Saving a token tests it first and saves nothing unless the host answers as GitLab.
  gitlabHosts(): Promise<{ hosts: GitlabHostRow[]; glab: boolean }>
  testGitlabHost(url: string, token?: string): Promise<GitlabConnection>
  saveGitlabToken(url: string, token: string | null): Promise<GitlabConnection | null>
  removeGitlabHost(host: string): Promise<void>
  // Copies the token glab holds for the host into Foreman's vault, after testing it. Only on the user's click.
  useGlabToken(url: string): Promise<GitlabConnection>
  // System
  whichBinary(name: 'claude' | 'codex' | 'opencode' | 'gh'): Promise<string | null>
  // null when the platform has no such permission (not macOS).
  fullDiskAccess(): Promise<boolean | null>
  openFullDiskAccessSettings(): Promise<void>
  resourceUsage(): Promise<{ cpuPercent: number; memoryMb: number }>
  // The `foreman` command: whether it's on the PATH, and putting it there.
  cliStatus(): Promise<CliInstallStatus>
  installCli(): Promise<CliInstallStatus>
  createWorkspace(repoId: string, options?: CreateWorkspaceOptions): Promise<Workspace>
  // Compare models: sibling workspaces from a fresh checkpoint, the same prompt in each. No winner, no merge.
  startCompare(workspaceId: string, request: CompareRequest): Promise<CompareResult>
  // Archive every workspace of a comparison except the one to keep (refused while any is running).
  archiveCompareOthers(compareId: string, keepWorkspaceId: string): Promise<void>
  // Add a worktree that already exists on disk as a workspace.
  adoptWorktree(repoId: string, path: string, options: AdoptWorktreeOptions): Promise<Workspace>
  listWorktrees(repoId: string): Promise<WorktreeInfo[]>
  updateWorkspace(id: string, patch: WorkspacePatch): Promise<void>
  // #1: without stopTabs, refuses while an agent runs. A failed checkpoint or archive script stops before anything is deleted.
  archiveWorkspace(id: string, deleteBranch: boolean, options?: ArchiveOptions): Promise<ArchiveOutcome>
  archivePreview(id: string): Promise<ArchivePreview>
  // O18: a workspace's labelled Docker containers, for the settings row; or remove them again after an archive.
  dockerContainers(workspaceId: string): Promise<DockerListing>
  removeDockerContainers(workspaceId: string): Promise<DockerRemoval>
  // G3 · O18: hide Home's "still running after archive" line without removing anything.
  dismissDockerLeft(workspaceId: string): Promise<void>
  // G3 · #13: the diff kept when the workspace was archived (null when none was kept), and a new workspace from an
  // archived chat, carrying that chat's history as text (the new workspace starts from the base branch).
  archivedDiff(workspaceId: string): Promise<ArchivedDiff | null>
  forkArchivedChat(sessionId: string): Promise<Workspace>
  // #1 Stop safely: the Quit sheet and the review of turns a quit or crash stopped.
  quitPlan(): Promise<QuitPlan>
  quitNow(): Promise<void>
  quitWhenFinished(): Promise<void>
  // O10: quit and leave the kept turns running in the background host.
  quitKeepRunning(): Promise<void>
  dismissReconnected(): Promise<void>
  cancelQuit(): Promise<void>
  stopReview(): Promise<StopReviewRow[]>
  // Sends the stopped turn's message again in its tab; only ever called by that row's Retry.
  retryStopped(turnId: string): Promise<void>
  // One entry (a turn id or `checks:<workspace id>`), or all of them.
  dismissStopped(key?: string): Promise<void>
  unarchiveWorkspace(id: string): Promise<void>
  forgetWorkspace(id: string): Promise<void>
  // Give a history-only workspace a worktree. Refused (with the reason) unless its branch exists here.
  activateWorkspace(id: string): Promise<void>
  // Export (Workspace menu → Export…): the chats to review, then the file.
  exportInfo(workspaceId: string): Promise<ExportInfo>
  searchChats(query: string, options?: ChatSearchOptions): Promise<ChatHit[]>
  searchNotes(query: string): Promise<NoteHit[]>
  // Save the workspace note. A change makes the next revision; nothing is sent to any chat.
  saveNote(workspaceId: string, text: string): Promise<void>
  // Queue the current note as a normal message in this tab.
  sendNote(sessionId: string): Promise<SendReceipt>
  usageReport(days: number): Promise<UsageReport>
  dataInfo(): Promise<DataInfo>
  backupNow(): Promise<BackupResult>
  gitBackupStatus(): Promise<GitBackupStatus>
  configureGitBackup(config: GitBackupConfig): Promise<GitBackupStatus>
  createGitBackupGithubRepo(name: string, account?: string): Promise<GitBackupStatus>
  gitBackupNow(): Promise<GitBackupRunResult>
  previewGitBackup(remoteUrl: string, account?: string): Promise<GitBackupPreview>
  restoreGitBackup(choice: GitBackupRestoreChoice): Promise<GitBackupRestoreResult>
  deleteLegacyFiles(): Promise<void>
  exportWorkspace(workspaceId: string, options: ExportOptions): Promise<ExportSummary>
  // Import: stage a file in quarantine and preview it, then create the workspace (or drop the stage).
  stageImport(file: string, passphrase?: string): Promise<StageResult>
  importStaged(stageId: string, choice: ImportChoice): Promise<Workspace>
  discardImport(stageId: string): Promise<void>
  getSetupLog(workspaceId: string): Promise<string>
  startHeldMessage(workspaceId: string): Promise<void>
  // What gh says about an issue or PR URL, and whether this repository can check it out.
  resolveGithubLink(repoId: string, url: string): Promise<GithubLinkInfo>
  rerunSetup(workspaceId: string): Promise<void>
  // O19: carry on from the step that failed, keeping the steps that passed; stop the running step; each step's own log.
  retrySetup(workspaceId: string): Promise<void>
  stopSetup(workspaceId: string): Promise<void>
  getSetupStepLogs(workspaceId: string): Promise<{ runId: string; logs: string[] } | null>
  // Chat tabs
  createSession(workspaceId: string, patch?: SessionPatch): Promise<Session>
  // A new tab that continues this chat's conversation from its latest message.
  // Without a turn, fork after the latest answer. `before` (#16 Edit and resend): from just before that turn's
  // message instead; for the chat's first message, a plain new chat.
  forkSession(sessionId: string, turnId?: string, options?: { before?: boolean }): Promise<Session>
  // Second opinion / Continue in another chat: what a new chat would be given, then start it.
  prepareHandOff(sourceId: string, kind: HandOffKind): Promise<HandOffPreview>
  startHandOff(sourceId: string, request: HandOffRequest): Promise<HandOffResult>
  updateSession(sessionId: string, patch: SessionPatch): Promise<void>
  closeSession(sessionId: string): Promise<void>
  reopenSession(workspaceId: string, sessionId?: string): Promise<Session | null>
  getChat(sessionId: string): Promise<ChatItem[]>
  sendMessage(sessionId: string, text: string, options?: SendOptions): Promise<SendDisposition>
  removeQueued(sessionId: string, messageId: string): Promise<void>
  steerQueued(sessionId: string, messageId: string): Promise<void>
  // Edit a queued message's text where it sits (keeps its turn id), or move it one place; both checked against the queue revision.
  // G4 #12: `attachments`, when given, replaces the message's attachments (added or removed in the editor).
  editQueued(sessionId: string, messageId: string, text: string, revision: number, attachments?: Attachment[]): Promise<QueueChangeResult>
  moveQueued(sessionId: string, messageId: string, direction: QueueMove, revision: number): Promise<QueueChangeResult>
  cancel(sessionId: string): Promise<void>
  pendingApprovals(): Promise<ApprovalRequest[]>
  // G2: `via` says where it was answered, for Home → Recent (the phone server passes 'phone'; the window leaves it out).
  respondApproval(id: string, response: ApprovalResponse, via?: 'window' | 'phone'): Promise<void>
  // #3: Home → Recent's history, newest first, and when it was last marked seen.
  attentionHistory(): Promise<{ events: import('./attention').AttentionEvent[]; seenAt?: string }>
  // #3: "Mark all seen". Only the history's marker moves; no reason is resolved.
  markAttentionSeen(): Promise<void>
  // #3: the PR hover card's Refresh, through the shared PR cache (its back-off still holds).
  refreshPullRequest(workspaceId: string): Promise<'ok' | 'no-pr' | 'paused' | 'unavailable'>
  restoreCheckpoint(sessionId: string, turnId: string): Promise<void>
  slashCommands(sessionId: string): Promise<SlashCommandInfo[]>
  // MCP servers for this chat. `restart` re-reads the configuration and connects again.
  mcpStatus(sessionId: string, restart?: boolean): Promise<McpStatusResult>
  // The MCP servers this repo proposes, and whether this Mac approved them. Nothing runs from here.
  repoMcp(workspaceId: string): Promise<RepoMcpView>
  // Approve exactly these servers (by name) as they are now; every other proposed server stays unapproved.
  // `shown` (name → fingerprint, as repoMcp listed them): refused when a named server is no longer what was shown.
  approveRepoMcp(workspaceId: string, names: string[], shown?: Record<string, string>): Promise<void>
  // Scheduled templates (R-5). Saving a schedule approves the template and repo as they are now.
  // `shown`: the fingerprint the caller showed the user (scheduleFingerprint's). When what would be approved now differs, nothing is saved and the error names the parts.
  saveSchedule(input: ScheduleRequest, id?: string, shown?: ScheduleFingerprint): Promise<Schedule>
  approveSchedule(id: string, shown?: ScheduleFingerprint): Promise<void>
  // What saving this request would approve, as it stands now: the fingerprint to send back as `shown`, and the parts in words. Reads only; refuses what saveSchedule would refuse.
  scheduleFingerprint(input: ScheduleRequest): Promise<ScheduleFingerprintView>
  pauseSchedule(id: string): Promise<void>
  resumeSchedule(id: string): Promise<void>
  deleteSchedule(id: string): Promise<void>
  stopScheduledRun(occurrenceId: string): Promise<void>
  // #11: tick "Resume at …" on the latest turn's limit card; untick / Cancel / Dismiss; "Resume now" on a missed one.
  armLimitResume(sessionId: string, turnId: string): Promise<void>
  cancelLimitResume(sessionId: string): Promise<void>
  resumeLimitNow(sessionId: string): Promise<void>
  // Pairing and hand-off to another Mac (P-4).
  devicesInfo(): Promise<DevicesInfo>
  mobileInfo(): Promise<MobileInfo>
  mobileConfigure(enabled: boolean, url: string): Promise<MobileInfo>
  mobileConfigureLan(enabled: boolean, address: string): Promise<MobileInfo>
  mobileStartPairing(mode?: 'private' | 'lan'): Promise<MobileInfo>
  mobileApprovePairing(id: string, allow: boolean): Promise<MobileInfo>
  mobileRevokeDevice(id: string): Promise<MobileInfo>
  // Listen for hand-offs on this Mac (and on which port), or stop.
  setAcceptHandOffs(on: boolean, port?: number): Promise<DevicesInfo>
  // Show a 6-digit code (valid for two minutes, one attempt).
  showPairingCode(): Promise<DevicesInfo>
  cancelPairingCode(): Promise<void>
  // Enter the code another Mac shows, with the address it shows.
  pairWith(host: string, port: number, code: string): Promise<PairedDevice>
  unpairDevice(id: string): Promise<void>
  pingDevice(id: string): Promise<boolean>
  startHandOffTo(workspaceId: string, deviceId: string): Promise<string>
  cancelHandOff(transferId: string): Promise<void>
  reconcileHandOff(transferId: string, choice: 'keep-here' | 'other-keeps'): Promise<void>
  reconnectMcpServer(sessionId: string, name: string): Promise<void>
  // Files
  attachFiles(workspaceId: string, paths: string[]): Promise<Attachment[]>
  attachData(workspaceId: string, name: string, base64: string): Promise<Attachment>
  // Pasted data for a workspace that doesn't exist yet: saved to a staging folder; returns its path for CreateWorkspaceOptions.attachments.
  stageAttachment(name: string, base64: string): Promise<string>
  listFiles(workspaceId: string): Promise<string[]>
  readFile(workspaceId: string, path: string): Promise<FileContent>
  // The Files tab (#19): one folder of the worktree ('' is the top), folders first, without .git or anything git ignores.
  listDir(workspaceId: string, dir: string): Promise<DirListing>
  // An image for the file viewer's preview (#19) as a data URL, with its type and pixel size; over the cap, only its size.
  readImage(workspaceId: string, path: string): Promise<ImagePreview>
  // G3 · #19: the foreman-preview:// address of an HTML page or PDF in the worktree, for the viewer's sandboxed frame.
  previewUrl(workspaceId: string, path: string): Promise<string>
  // G3 · #19: an image as it was at a commit (an id, the diff's branch point), for the diff's before side.
  readImageAt(workspaceId: string, path: string, commit: string): Promise<ImagePreview>
  writeFile(workspaceId: string, path: string, content: string): Promise<void>
  searchFiles(workspaceId: string, query: string, options: { caseSensitive?: boolean; regex?: boolean; wholeWord?: boolean }): Promise<SearchMatch[]>
  // O5: `commits` for `picked` (any order) and `commit` (one id).
  getDiff(workspaceId: string, scope: DiffScope, commits?: string[]): Promise<WorkspaceDiff>
  // O5: file counts per diff source for the source menu, and the branch's commits for the Commits tab.
  diffSources(workspaceId: string, picked?: string[]): Promise<DiffSourceInfo>
  branchCommits(workspaceId: string): Promise<BranchCommits>
  // G2 (O5): the Commits tab's count badge, without reading the commits.
  branchCommitCount(workspaceId: string): Promise<{ count: number; more: boolean }>
  // The sensitive files of an alert, start to end of its turn.
  getAlertDiff(workspaceId: string, alertId: string): Promise<WorkspaceDiff>
  // G3 · O6: one of the alert's files as its end checkpoint has it (for the unchanged lines between hunks).
  alertFile(workspaceId: string, alertId: string, path: string): Promise<FileContent>
  dismissAlert(workspaceId: string, alertId: string): Promise<void>
  // #2: dismiss an agent's needs-input, stuck or review request ('opened': a review was started from it). It goes to history.
  closeAgentReport(workspaceId: string, reportId: string, how: 'dismissed' | 'opened'): Promise<void>
  workspaceUsage(workspaceId: string): Promise<WorkspaceUsage>
  setFileViewed(workspaceId: string, mark: ViewedMark, viewed: boolean): Promise<void>
  revertFile(workspaceId: string, path: string): Promise<void>
  setSpotlight(workspaceId: string, on: boolean): Promise<void>
  // index picks one of the repo's preview URLs (default: the first).
  openPreview(workspaceId: string, index?: number): Promise<void>
  // Git and pull requests
  gitStatus(workspaceId: string): Promise<GitStatus>
  checksStatus(workspaceId: string): Promise<ChecksStatus>
  // Starts the checks and returns; progress arrives as state events. Without `approve`, commands not run before come back for consent.
  // `approve`: true approves every configured command as it is now; a list of command hashes approves only those (what the user was shown).
  runChecks(workspaceId: string, approve?: boolean | string[]): Promise<RunChecksOutcome>
  cancelChecks(workspaceId: string): Promise<void>
  // Attaches the failing checks' logs to a chat after the user confirmed.
  fixChecks(workspaceId: string, sessionId?: string): Promise<void>
  reviewThreads(workspaceId: string): Promise<ReviewThread[]>
  sendReviewThreads(workspaceId: string, threadIds: string[], sessionId?: string): Promise<string>
  // The receipt of the message the action sent to a chat (its turn id), or null when it sent none (push, merge, open, …).
  gitAction(workspaceId: string, action: GitActionKind, sessionId?: string): Promise<SendReceipt | null>
  // Opt in or out of CI-failure or review-comment notifications for this workspace's PR.
  setPrWatch(workspaceId: string, kind: 'ci' | 'reviews', on: boolean): Promise<void>
  // "Fix CI in…": send the failing CI logs to a tab ('new' opens one) and acknowledge the failure. Returns the tab used.
  fixCi(workspaceId: string, sessionId: string | 'new' | undefined): Promise<string>
  // "Resolve in chat…" for a moved base: send the merge request to a tab ('new' opens one) and acknowledge. Returns the tab used.
  resolveBaseMoved(workspaceId: string, sessionId: string | 'new' | undefined): Promise<string>
  // Is the run script's preview URL answering? One short request, localhost only.
  probePreview(workspaceId: string, scriptName: string): Promise<PreviewProbe>
  // Whether this Mac's git can run the "Base moved" check (git 2.38 or later).
  baseWatchSupport(): Promise<{ ok: boolean; version?: string }>
  // The user has seen or dealt with the CI failure.
  ackCiFailure(workspaceId: string): Promise<void>
  // #5: what turning on auto-fix CI would approve for this tab, as things stand now.
  autoFixPreview(workspaceId: string, sessionId: string): Promise<AutoFixPreview>
  // #5: approve auto-fix with what the dialog showed (refused if any of it changed since), or turn it off with null.
  setAutoFix(workspaceId: string, consent: AutoFixShown | null): Promise<void>
  // #17: what turning on auto review for this repository would approve, for this reviewer and these exclusions (the defaults when omitted).
  autoReviewPreview(repoId: string, choice?: { reviewer?: Loadout; exclusions?: string[] }): Promise<AutoReviewShown>
  // #17: turn auto review on with what the dialog showed (refused if any of it changed since), or off with null.
  setAutoReview(repoId: string, shown: AutoReviewShown | null): Promise<void>
  // #17: "Send to worker…": the picked findings to a tab, as the message the dialog showed. Only ever called by that click.
  sendAutoReviewFindings(workspaceId: string, reviewId: string, findingIds: string[], sessionId: string): Promise<SendDisposition>
  // #17: Dismiss on Home's "Review opinion ready".
  dismissAutoReview(workspaceId: string, reviewId: string): Promise<void>
  addComment(workspaceId: string, file: string, line: number, body: string, selection?: DiffSelection): Promise<void>
  // #15: Explain / Change this / Ask on selected lines: a diff comment sent to a tab (`'new'` makes one), checked against the file first.
  sendDiffSelection(workspaceId: string, draft: { file: string; body: string; selection: DiffSelection }, sessionId: string): Promise<SelectionSendResult>
  // #15: a held one: `check` sends it if its lines still match, `selected` sends it marked outdated, `current` quotes the lines as they are now.
  resendDiffSelection(commentId: string, how: 'check' | 'selected' | 'current', sessionId?: string): Promise<SelectionSendResult>
  updateComment(id: string, patch: { body?: string; state?: DiffComment['state'] }): Promise<void>
  deleteComment(id: string): Promise<void>
  // Terminals
  // `command` (kind 'command') is 'claude-login' | 'claude-setup-token' | 'codex-login' | 'gh-login' | 'claude-mcp'; workspaceId may be '' for the logins.
  // With kind 'run', `command` names the run script (default: the repo's default one).
  // With kind 'snippet', `command` is the Bash source explicitly selected with Run.
  // With kind 'shell', `command` is a shell for this tab only (O4, Windows); omitted: Settings → Shell.
  // With kind 'saved' (O9), `command` is a saved command's id: the user's shell starts and the command is typed in.
  // G3 · O3: `options.cwd` starts a shell tab in that folder (a restored tab's last one) when it exists.
  ptySpawn(workspaceId: string, cols: number, rows: number, kind: PtyKind, command?: string, options?: { cwd?: string }): Promise<string>
  // Windows shells found on this computer, looked up again on every call (O4).
  detectShells(): Promise<ShellDetection>
  // A workspace's terminal tabs saved before the last restart (O3); null when none were saved or restore is off.
  savedTerminals(workspaceId: string): Promise<SavedTerminalTab[] | null>
  // O9: a saved command `id` offered in this workspace. null: it may run now (ptySpawn kind 'saved'); otherwise the
  // approval a repo command needs first (new, or its text changed).
  savedCommandConsent(workspaceId: string, id: string): Promise<CheckConsentItem | null>
  // Approve a repo command's text (shared with checks). Refused if the text changed since `command` was shown.
  approveSavedCommand(workspaceId: string, id: string, command: string): Promise<void>
  // Agents
  agentStatus(agent: AgentKind): Promise<AgentStatus>
  // #22: the agent catalog: what's installed (PATH and --version, checked once and again on `refresh`; nothing is installed),
  // what Chat agents declared over ACP, and which key variables the shell has (names only).
  agentCatalog(refresh?: boolean): Promise<AgentCatalogView>
  // #22: an agent's own API key, stored encrypted and passed only to that agent in API-key mode. null removes it.
  setAgentKey(agent: string, value: string | null): Promise<void>
  revealAgentKey(agent: string): Promise<string | null>
  // #22: copy an agent's key from the shell into its own store. Never replaces a saved key; false when nothing was copied.
  importAgentKey(agent: string): Promise<boolean>
  // #22: the agent's own sign-in check, for CLIs that have one; null when it has none or the answer wasn't clear.
  // G1: `source` is set when a credentials probe answered (the file or command it read), not the agent's own status command.
  agentSignInStatus(agent: string): Promise<{ signedIn: boolean; account?: string; output: string; source?: string } | null>
  // #22: copy a provider key from the shell into the shared store (ticked for no agent). Never replaces a saved one.
  importProviderKey(envVar: string): Promise<boolean>
  // G1: a saved provider key's value, for Reveal and Copy on Settings → Provider keys.
  revealProviderKey(envVar: string): Promise<string | null>
  // #22: Terminal agents running (or exited, until their tab closes), for the sidebar and the tab.
  terminalAgentRuns(): Promise<TerminalAgentRun[]>
  // Report a problem (O20): versions, agent status and recent errors for the dialog to fill in. Sends nothing.
  reportDiagnostics(): Promise<ReportDiagnostics>
  // Models offered by agents whose list depends on the account (Cursor, OpenCode).
  /** Ask an agent (or all of them) for its current model list; results arrive in the snapshot. */
  refreshModels(agent?: AgentKind): Promise<void>
  // Misc
  openPath(path: string): Promise<void>
  // Opens in the default app (#14); a file opens in the editor, terminals get its folder.
  openInEditor(path: string): Promise<void>
  // #14: the editors, terminals and file manager found on this computer; `refresh` looks again.
  openInApps(refresh?: boolean): Promise<OpenInDetection>
  // G4 #14: the found apps' own icons (data: URLs) by app id; apps without one are left out.
  openInIcons(): Promise<Partial<Record<string, string>>>
  // #14: open a folder, or a file at a line, in an app (null: the default app from Settings).
  openIn(app: OpenInChoice | null, target: OpenInTarget): Promise<void>
  openExternal(url: string): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  // Remember that a Get started milestone was reached. Idempotent: the first time stands. Nothing is returned; the snapshot carries it.
  recordOnboardingMilestone(id: import('./onboarding').OnboardingMilestone): Promise<void>
  // Put settings back to their defaults.
  resetSettings(keys: (keyof Settings)[]): Promise<Settings>
  // The assistant: whether it can run (`refresh` checks the agents again) and its threads.
  assistantState(refresh?: boolean): Promise<import('./assistant').AssistantState>
  assistantItems(threadId: string): Promise<ChatItem[]>
  // A message into a thread, or a new one (null). `useAlternative`: run on the alternative agent the gate offered, for this thread.
  // `context` is what the window shows (the workspace and chat the user is in); tools default to it. Optional, and only for this turn.
  assistantSend(threadId: string | null, text: string, useAlternative?: boolean, context?: { workspaceId?: string; sessionId?: string }): Promise<{ threadId: string }>
  assistantCancel(threadId: string): Promise<void>
  assistantDeleteThread(threadId: string): Promise<void>
  assistantClearHistory(): Promise<void>
  // The user clicked Run or Cancel on a `foreman` command the assistant proposed (the thread's `foreman` tool item). Run runs it once, in the app.
  assistantConfirmRun(threadId: string, runId: string): Promise<void>
  assistantCancelRun(threadId: string, runId: string): Promise<void>
  // Phase G2: speech to text. sttStart rejects (nothing recorded) when the engine cannot run: model missing, no OpenAI key,
  // Privacy mode, microphone refused. Frames are 16 kHz mono signed 16-bit little-endian PCM, up to about 100 ms each.
  // After the start, failures arrive as stt-error events and sttStop still answers (with the text so far). One dictation at a time.
  sttStart(options: { language?: string }): Promise<{ sessionId: string; provider: 'local' | 'openai' }>
  sttAudio(sessionId: string, pcm: Uint8Array): Promise<void>
  sttStop(sessionId: string): Promise<{ text: string }>
  sttCancel(sessionId: string): Promise<void>
  sttModelStatus(): Promise<{ state: 'missing' | 'downloading' | 'ready'; bytes?: number; total?: number; name: string; sizeMb: number; source: string }>
  // Resolves when the model is on disk and checked; on failure rejects, and also sends stt-error (no sessionId) and stt-model 'missing'.
  sttDownloadModel(): Promise<void>
  // Cloud workspaces: build the repository's base sandbox (output arrives as cloud-build-log events; returns as it starts).
  cloudBuildBase(repoId: string): Promise<CloudBuild>
  cloudWake(workspaceId: string): Promise<WorkspaceCloud>
  cloudSleep(workspaceId: string): Promise<WorkspaceCloud>
  // Force-stop and wake again.
  cloudRestart(workspaceId: string): Promise<WorkspaceCloud>
  // Ask the provider again and return what it says now.
  cloudStatus(workspaceId: string): Promise<WorkspaceCloud>
  // This month's usage per provider: every provider with a connection or with stops recorded this month.
  cloudUsage(): Promise<CloudUsageView[]>
  // ---- cloud workspaces, phase 1b (renderer): Claude's sign-in inside sandboxes ----
  // The `claude setup-token` token, kept in the agent vault (shared/cloud.ts CLAUDE_SETUP_TOKEN_KEY); null removes it.
  cloudSetClaudeToken(token: string | null): Promise<void>
  // Whether one is saved: its last four characters ('' when too short) and when it was saved. Never the token.
  cloudClaudeToken(): Promise<{ hint: string; savedAt?: string } | null>
  // ---- cloud workspaces, phase 2b (main): agents in the sandbox ----
  // Continue a chat whose last turn the session limit cut off (turn-end `interrupted: 'session-cap'`): wakes the
  // sandbox and sends CLOUD_CONTINUE_PROMPT (shared/cloud.ts) through the chat's usual send path, resuming the agent's conversation.
  cloudContinue(sessionId: string): Promise<SendReceipt>
  // Pick up again the turns Foreman lost its connection to while the sandbox kept them running (WorkspaceCloud.disconnected).
  cloudReattach(workspaceId: string): Promise<void>
  // Whether a cloud workspace can be made for this repository now, and why not (with the running sandboxes at the limit).
  cloudPreflight(repoId: string): Promise<CloudPreflight>
}

// Fire-and-forget messages (high frequency, no reply needed).
export interface Signals {
  ptyWrite(ptyId: string, data: string): void
  ptyResize(ptyId: string, cols: number, rows: number): void
  ptyKill(ptyId: string): void
  // #3: the window's unread workspaces and chats, so the tray and dock badge count what Home counts.
  setUnread(workspaceIds: string[], sessionIds: string[]): void
  // The workspace's terminal tabs as they are now, for restoring after a restart (O3).
  saveTerminals(workspaceId: string, tabs: TerminalTabSave[]): void
  // The battery level (0–100) from Chromium's battery API, or null without one (O17).
  setBattery(percent: number | null): void
}

export interface Bridge {
  browser: import('./browser').BrowserBridge
  invoke: Api
  send: Signals
  onEvent(listener: (event: MainEvent) => void): () => void
  // Absolute path of a dropped File (Electron webUtils).
  pathForFile(file: File): string
}

// Method names the preload script exposes. The type checks below fail the
// build if a method is added to Api or Signals but not listed here.
export const API_METHODS = [
  'getSnapshot', 'pickDirectory', 'pickFiles', 'pickPath', 'addRepo', 'cloneRepo', 'githubRepos', 'quickStartRepo', 'makeRepo', 'forgetRecentRepo', 'classifyFolders', 'takeLaunchFolders', 'updateRepo', 'removeRepo',
  'updateRepoSettings', 'listBranches', 'listRemotes', 'previewFilesToCopy', 'detectRepoIcon', 'openRepoSettingsFile',
  'envView', 'setEnvVars', 'revealEnvVar', 'setEnvFiles', 'importKeyFromShell', 'opencodeProviders', 'setProviderKey',
  'githubStatus', 'setGithubToken', 'gitlabHosts', 'testGitlabHost', 'saveGitlabToken', 'removeGitlabHost', 'useGlabToken', 'githubAccounts', 'detectRepoAccount', 'remoteUrl', 'whichBinary', 'fullDiskAccess', 'openFullDiskAccessSettings', 'resourceUsage', 'cliStatus', 'installCli', 'forkSession', 'prepareHandOff', 'startHandOff',
  'createWorkspace', 'startCompare', 'archiveCompareOthers', 'adoptWorktree', 'listWorktrees', 'updateWorkspace', 'archiveWorkspace', 'unarchiveWorkspace', 'forgetWorkspace', 'activateWorkspace', 'exportInfo', 'searchChats', 'searchNotes', 'saveNote', 'sendNote', 'usageReport', 'dataInfo', 'backupNow', 'gitBackupStatus', 'configureGitBackup', 'createGitBackupGithubRepo', 'gitBackupNow', 'previewGitBackup', 'restoreGitBackup', 'deleteLegacyFiles', 'exportWorkspace', 'stageImport', 'importStaged', 'discardImport', 'getSetupLog', 'rerunSetup', 'retrySetup', 'stopSetup', 'getSetupStepLogs', 'startHeldMessage', 'resolveGithubLink',
  'readFile', 'writeFile', 'searchFiles', 'listDir', 'readImage', 'previewUrl', 'readImageAt', 'alertFile',
  'archivePreview', 'dockerContainers', 'removeDockerContainers', 'dismissDockerLeft', 'archivedDiff', 'forkArchivedChat', 'quitPlan', 'quitNow', 'quitWhenFinished', 'quitKeepRunning', 'dismissReconnected', 'cancelQuit', 'stopReview', 'retryStopped', 'dismissStopped',
  'createSession', 'updateSession', 'closeSession', 'reopenSession',
  'getChat', 'sendMessage', 'removeQueued', 'steerQueued', 'editQueued', 'moveQueued', 'cancel',
  'pendingApprovals', 'respondApproval', 'restoreCheckpoint', 'slashCommands', 'mcpStatus', 'reconnectMcpServer', 'repoMcp', 'approveRepoMcp', 'saveSchedule', 'approveSchedule', 'scheduleFingerprint', 'pauseSchedule', 'resumeSchedule', 'deleteSchedule', 'stopScheduledRun', 'armLimitResume', 'cancelLimitResume', 'resumeLimitNow', 'devicesInfo', 'setAcceptHandOffs', 'showPairingCode', 'cancelPairingCode', 'pairWith', 'unpairDevice', 'pingDevice', 'startHandOffTo', 'cancelHandOff', 'reconcileHandOff',
  'mobileInfo', 'mobileConfigure', 'mobileConfigureLan', 'mobileStartPairing', 'mobileApprovePairing', 'mobileRevokeDevice',
  'attachFiles', 'attachData', 'stageAttachment', 'listFiles', 'getDiff', 'diffSources', 'branchCommitCount', 'branchCommits', 'getAlertDiff', 'dismissAlert', 'closeAgentReport', 'workspaceUsage', 'setFileViewed', 'revertFile', 'setSpotlight', 'openPreview',
  'gitStatus', 'checksStatus', 'runChecks', 'cancelChecks', 'fixChecks', 'reviewThreads', 'sendReviewThreads', 'gitAction', 'setPrWatch', 'fixCi', 'resolveBaseMoved', 'baseWatchSupport', 'probePreview', 'ackCiFailure', 'autoFixPreview', 'setAutoFix', 'autoReviewPreview', 'setAutoReview', 'sendAutoReviewFindings', 'dismissAutoReview', 'addComment', 'sendDiffSelection', 'resendDiffSelection', 'updateComment', 'deleteComment',
  'ptySpawn', 'savedTerminals', 'savedCommandConsent', 'approveSavedCommand', 'detectShells', 'agentStatus', 'reportDiagnostics', 'refreshModels',
  'agentCatalog', 'setAgentKey', 'revealAgentKey', 'importAgentKey', 'agentSignInStatus', 'importProviderKey', 'revealProviderKey', 'terminalAgentRuns',
  'openPath', 'openInEditor', 'openInApps', 'openInIcons', 'openIn', 'openExternal', 'updateSettings', 'resetSettings', 'recordOnboardingMilestone',
  'attentionHistory', 'markAttentionSeen', 'refreshPullRequest',
  'assistantState', 'assistantItems', 'assistantSend', 'assistantCancel', 'assistantDeleteThread', 'assistantClearHistory', 'assistantConfirmRun', 'assistantCancelRun',
  'sttStart', 'sttAudio', 'sttStop', 'sttCancel', 'sttModelStatus', 'sttDownloadModel',
  'cloudBuildBase', 'cloudWake', 'cloudSleep', 'cloudRestart', 'cloudStatus', 'cloudUsage',
  'cloudSetClaudeToken', 'cloudClaudeToken',
  'cloudContinue', 'cloudPreflight', 'cloudReattach',
  'addConnection', 'updateConnection', 'checkConnection', 'connectionRemovalImpact', 'removeConnection', 'setIntegrationDefault', 'repoIntegrations', 'setRepoIntegration', 'setRepoIntegrationOptions',
  'applyConnectionToRepos', 'acceptIntegrationSuggestion', 'importRepoGithubToken', 'integrationActivity', 'ghAccountsForIntegrations', 'slackManifest', 'slackPeople', 'slackChannels', 'saveSlackRule', 'consentSlackRule',
  'deleteSlackRule', 'linkPerson', 'unlinkPerson', 'slackDeliveries', 'answerSlackAsk', 'resendSlackDelivery', 'linearMyIssues', 'resolveLinearLink'
] as const satisfies readonly (keyof Api)[]

export const SIGNAL_METHODS = ['ptyWrite', 'ptyResize', 'ptyKill', 'setUnread', 'saveTerminals', 'setBattery'] as const satisfies readonly (keyof Signals)[]

type AssertNever<T extends never> = T
export type _AllApiMethodsListed = AssertNever<Exclude<keyof Api, (typeof API_METHODS)[number]>>
export type _AllSignalMethodsListed = AssertNever<Exclude<keyof Signals, (typeof SIGNAL_METHODS)[number]>>
