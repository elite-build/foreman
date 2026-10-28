// Wires the services together and implements the renderer-facing API.
// Kept free of Electron imports (they are injected) so it can be tested.
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentKind, Loadout } from '../shared/agents'
import { ARCHIVE_CLEANUP_DAYS, mergedNow } from '../shared/autoArchive'
import { DONE_DAYS_OPTIONS, nextPrInfo } from '../shared/board'
import { isSlotSetting, MAX_BACKGROUND_WAIT_MINUTES, MAX_RUNNING_AGENTS } from '../shared/agentSlots'
import { ENV_NAME } from '../shared/envfile'
import { PROVIDER_KEYS } from '../shared/providers'
import { tailLines } from '../shared/setupLog'
import { type AgentKeyName, type Api, type AppSnapshot, type CreateWorkspaceOptions, type EnvScope, type GitlabConnection, type GitlabHostRow, type GitStatus, type HeldMessage, type IntakeFile, type MainEvent, type Occurrence, type PromptTemplate, type Schedule, type ScheduleFingerprint, type ScheduleFingerprintView, type Settings, type Signals, type Workspace } from '../shared/types'
import { driverFor } from './agents/registry'
import { catalogLoginCommand, executablePathFor, setAgentRuntimeDir } from './agents/catalogDrivers'
import { onAcpModes } from './agents/acp'
import { AgentCatalogService, LEGACY_AGENT_KEYS } from './agentCatalogService'
import { AssistantService } from './assistant'
import { TerminalAgents } from './terminalAgents'
import { catalogAgent, parseAgentPrefs, parseProviderKeyAgents } from '../shared/agentCatalog'
import { Environment } from './environment'
import { makeRepository } from './makeRepo'
import { cloneRepo, githubRepos, gitProtocol, quickStart } from './repoSources'
import { cliStatus, installCli, macAdmin } from './cliInstall'
import { baseStartPoint, git, gitOut, noteWorktreeChanged, repoEvidence } from './git'
import { accountToken, accountTokenAsync, branchPrefix, forgetAccountTokens, forgetIdentityLogins, ghActiveAccount, ghActiveAccountAsync, ghActiveAccountReady, ghAs, githubAccounts, githubEnv, githubEnvOrNone, githubLogin, githubSlug, githubStatus, refreshGhActiveAccount, setGithubIdentities, useGithubToken, warmGithub, type PrResult } from './github'
import { SandboxManager } from './cloud/sandboxes'
import { CloudPtyBackend, cloudTerminalFolder } from './cloud/terminal'
import { CloudTurnHost } from './cloud/turnHost'
import { githubHttpsUrl, patchCloudSettings } from '../shared/cloud'
import { CLAUDE_SETUP_TOKEN_KEY, CLAUDE_SETUP_TOKEN_SAVED_AT_KEY } from '../shared/cloud'
import { PrCache } from './prCache'
import { probePreview } from './previewProbe'
import { browserUrl } from '../shared/browser'
import { readRepoTemplates, revalidateRepoTemplates } from './repoTemplates'
import { approveCommand, commandLaunch, consentItem, repoCommands, runnableCommand } from './savedCommands'
import { commandInputWithStatus, findCommand, needsApproval, parseSavedCommands, statusShell, type SavedCommand } from '../shared/savedCommands'
import { parseHiddenModels } from '../shared/modelVisibility'
import { BaseWatcher } from './baseWatch'
import { PrWatcher } from './prWatch'
import { AutoFixService } from './autoFix'
import { AutoReviewService } from './autoReview'
import { canReview, checksFact, defaultReviewer } from '../shared/autoReview'
import { permissionNote } from '../shared/permissions'
import { fixErrorsInstructions } from '../shared/prompts'
import { resolveGithubLink, resolveGitlabLink } from './intake'
import { gitlabTokenKey, ScmRouter, type ScmProvider } from './scm'
import { GitlabApi, GlabLogins, gitlabAgentContext, glabInstalled, probeGitlab, readGlabToken, testConnection } from './gitlab'
import { findScmLink, gitlabHosts, looksLikeGitlab, normalizeGitlabHost, projectOnHost, scmForRemote } from '../shared/scm'
import { intakeFile } from '../shared/githubLink'
import { chooseStartLoadout } from '../shared/startModel'
import { randomUUID } from 'node:crypto'
import { pruneViewed, withMark } from '../shared/viewed'
import { branchPoint, changedFilesBetween, fileAtRef, refsDiff, revertFile, workspaceDiff, workspaceDiffPatch, workspaceDiffStat } from './diff'
import { sharedWorkingTree, VIEW_REUSE_MS } from './checkpoints'
import { turnAnswer } from '../shared/handOff'
import { DEFAULT_MODEL } from '../shared/agents'
import { branchCommitCount, branchCommits, sourceDiff, sourceInfo, type PrTarget } from './diffSources'
import { CommitAttribution } from './commitAttribution'
import { AutoArchive } from './autoArchive'
import { AutoChecks } from './autoChecks'
import { ChecksError, ChecksService } from './checks'
import { GitActions } from './gitActions'
import { HandOffService } from './handOffs'
import { PortabilityService } from './portability'
import { DataService } from './dataService'
import { GitBackupService } from './gitBackup'
import { searchChats, searchNotes } from './chatSearch'
import { ModelCatalogService } from './models'
import { UpdateCheck } from './updates'
import { Spotlight } from './spotlight'
import { attachFromData, attachFromPath, listWorkspaceFiles, readWorkspaceFile, searchWorkspace, stageAttachment, writeWorkspaceFile } from './files'
import { listWorkspaceDir, readImageAtCommit, readWorkspaceImage } from './fileBrowse'
import { agentBaseEnv, bundledClaudeExecutable, findOnPath, interactiveShell, isWindows, setScriptShell, shellQuote } from './platform'
import { detectShells, listWslDistros, realProbe } from './shells'
import { isScriptShellChoice, isShellChoice, resolveShell, type ShellLaunch } from '../shared/shells'
import { mainT } from './i18n'
import { PtyManager, typeWhenQuiet } from './pty'
import { existingFolder, TerminalRestore } from './terminalRestore'
import { collectDiagnostics } from './reportProblem'
import { classifyFolders } from './dropFolders'
import { KeepAwake, type PowerReading } from './keepAwake'
import { keepAwakeCutoffNotice } from '../shared/keepAwake'
import { StopSafely } from './stopSafely'
import { AgentHostService } from './agentHost/service'
import { AgentReportService, newTurnKey } from './agentReports'
import { hostDir } from './agentHost/protocol'
import type { SecretStore } from './secrets'
import { CompareService } from './compare'
import { RepoMcp, fingerprint as mcpFingerprint, scriptFiles } from './repoMcp'
import { Devices, plainAddress } from './devices'
import { DeviceNet } from './deviceNet'
import type { MobileService } from './mobile'
import { TransferService, type TransferLocal } from './transfers'
import { frozenReason, type DevicesInfo, type PairedDevice } from '../shared/transfer'
import { repoReasons } from '../shared/portable'
import { assertFingerprintShown, fingerprintOf, scheduleProblem, ScheduleService, type FingerprintInputs, type LaunchHandle, type ScheduleInput } from './schedules'
import { readSharedLayer, resolveRepoSettings, revalidateSharedLayers } from './repoSettings'
import { templatePlaceholders } from '../shared/promptTemplates'
import { SessionService } from './sessions'
import { defaultSettings, type Store } from './store'
import { WorkspaceService } from './workspaces'
import { reviewThreadsMarkdown } from './reviews'
import { ClaudeMirror } from './claudeMirror'
import { wsPath } from '../shared/workspacePath'
import { localOnly, workspaceTarget } from './runtime'
import { OpenInService } from './openIn'
import { isOpenInChoice } from '../shared/openIn'
import { defaultOnboarding, isOnboardingMilestone, migrateOnboarding, withMilestone, type OnboardingMilestone } from '../shared/onboarding'
import { DiffSelectionService } from './diffSelections'
import { LimitResumeService } from './limitResume'
import { AttentionService, approvalDraft, PrPoller } from './attention'
import type { TrayView } from '../shared/attention'
import { PreviewServer } from './previewProtocol'
import { Integrations } from './integrations'
import { IntegrationBridge } from './integrationBridge'
import { ForemanActions } from './foremanActions'
import { ForemanMcp } from './foremanMcp'
import { SlackRules } from './slackRules'
import { SpeechService } from './speech'
import type { HelperLaunch } from './speech/local'
import { linearIssue, linearMyIssues } from './linear'
import { slackChannels, slackManifest, slackManifestUrl, slackPeople, slackUserByEmail, type SlackPerson } from './slack'
import { findLinearLink, linearBranch, linearIntakeFile, type LinearIssue } from '../shared/linearLink'
import type { LinearLinkInfo } from '../shared/types'
import { processRoots } from './processRoots'
import { ProcessUsageSampler } from './processUsage'

export interface Host {
  broadcast(event: MainEvent): void
  applyTheme(theme: Settings['theme']): void
  // O13b: the Language setting changed; main's menu and tray are drawn again in it.
  applyLanguage?(): void
  pickDirectory(): Promise<string | null>
  pickFiles(): Promise<string[]>
  pickPath(options: { title: string; kind: 'file' | 'directory' | 'save'; defaultPath?: string }): Promise<string | null>
  openPath(path: string): Promise<void>
  // #14: show a file selected in File Explorer / Finder.
  revealPath?(path: string): void
  // G4 #14: a file's icon from the OS, as a data: URL (null when it has none).
  fileIcon?(path: string): Promise<string | null>
  openExternal(url: string): Promise<void>
  setBadge(count: number): void
  // #3: the tray or menu-bar extra's count and jump list, after every look at the state.
  showAttention?(view: TrayView): void
  setZoom(level: number): void
  // Hold off system sleep while agents work.
  keepAwake(on: boolean): void
  // On battery and thermal state from powerMonitor (O17); null where the OS can't say. Absent means unknown.
  power?(): PowerReading
  // CPU (%) and memory (MB) used by the app's own processes.
  metrics(): { cpuPercent: number; memoryMb: number }
  // The launcher `foreman` should run (see cliInstall.ts).
  cliShim(): string
  // Foreman's version, whether it's an installed build, and where its package.json is (Report a problem, O20).
  appInfo?(): { version: string; packaged: boolean; appPath: string }
  // #1: quit the app without asking again (the Quit sheet already did, or nothing is left running).
  quit?(): void
  // Updates (main/updateInstaller.ts): downloads and installs a newer Foreman. Absent (tests): the window links to the release page.
  updateInstaller?: import('./updates').UpdateInstaller
  // Quit without asking, then install the downloaded update and start Foreman again.
  restartToUpdate?(): void
  // O10: the background agent host's folder, and how to start it. Absent (tests): turns always run in-process.
  agentHost?: { dir: string; spawn(): void }
  // Integrations: how to start `foreman mcp-bridge` (an absolute executable and the CLI script), and the
  // socket it connects to. Absent: agents get no integration tools.
  bridgeLaunch?(): { command: string; args: string[]; env: Record<string, string> } | null
  cliSocket?(): string | null
  // Idle five minutes or more, or the screen is locked (Slack rules "only when I'm away").
  away?(): boolean
  // Phase 4: whether the OS reports a screen reader (Electron's accessibilitySupportEnabled).
  screenReader?(): boolean
  // Phase G2: ask the OS for microphone access before a dictation (macOS prompts once); false when it is refused. Absent: assume yes.
  microphone?(): Promise<boolean>
  // Phase G2: how to run the speech helper (Foreman's own binary in Node mode on out/main/sttHelper.js); null when it is not built.
  sttHelper?(): HelperLaunch | null
}

// Commands the renderer may open in a terminal (an allowlist, not arbitrary shell):
// sign-ins, and Claude Code's /mcp screen for authenticating MCP servers.
// 'claude-setup-token' prints a long-lived token for Claude in cloud workspaces (Settings → Cloud workspaces).
const LOGIN_COMMANDS = ['claude-login', 'claude-setup-token', 'codex-login', 'gh-login', 'claude-mcp'] as const

// Where repositories usually keep a favicon, best first.
const FAVICON_PATHS = [
  'public/favicon.svg', 'public/favicon.png', 'public/favicon.ico', 'public/apple-touch-icon.png', 'app/favicon.ico', 'app/icon.svg',
  'app/icon.png', 'src/app/favicon.ico', 'src/app/icon.svg', 'static/favicon.svg', 'static/favicon.png', 'static/favicon.ico',
  'favicon.svg', 'favicon.png', 'favicon.ico', 'apple-touch-icon.png'
]
const IMAGE_TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }

const SETTINGS_TEMPLATE = `# Shared Foreman settings for this repository. Commit this file so the
# whole team gets the same scripts. Settings made in the app on one computer
# override these for that computer only.

[scripts]
# setup = "npm install"
# archive = ""
# Run the checks after a completed turn, when nothing else is working in the workspace.
# checks_after_turn = true

# [scripts.run.dev]
# command = "npm run dev -- --port $FOREMAN_PORT"
# default = true
# preview_url = "http://localhost:$FOREMAN_PORT"  # the Run panel can check it answers

# Commands "Run checks" runs in each workspace; a command passes on exit code 0.
# [[checks]]
# name = "test"
# command = "npm test"

# Changes to files matching these globs are flagged for a closer look.
# sensitive_paths = ["**/migrations/**", "package-lock.json", ".env*"]

# file_include_globs = ".env*"
# preview_urls = [{ name = "App", url = "http://localhost:$FOREMAN_PORT" }]

# [environment_variables]
# FEATURE_FLAG = "on"
`

/** Substitute workspace port variables and offsets, including this app's earlier variable names. */
export function expandPorts(template: string, port: number): string {
  return template
    .replace(/\$\(\(\s*(?:FOREMAN|SWITCHYARD)_PORT\s*\+\s*(\d+)\s*\)\)/g, (_, n: string) => String(port + Number(n)))
    .replace(/\$\{?(?:FOREMAN|SWITCHYARD)_PORT\}?|%(?:FOREMAN|SWITCHYARD)_PORT%/g, String(port))
}

/** What only the app itself may ask for when it makes a workspace. */
interface InternalStart {
  scheduled?: { scheduleId: string; occurrenceId: string }
  onChat?: (workspaceId: string, sessionId: string) => void
}

/** A new chat's first message, waiting for its workspace to be ready. */
type FirstMessage = Omit<HeldMessage, 'at'>

// A language code for dictation: `en`, `pt-BR`.
const STT_LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/

// How old a state broadcast's reads of repository files (templates, settings.toml, recent folders) may be. Edits made
// outside Foreman show within this, at the next broadcast, or at once when a window gains focus.
const REPO_FILES_MAX_AGE_MS = 3_000

// A window gaining focus asks gh for its active account again unless its answer is younger than this.
const GH_ACTIVE_FOCUS_MIN_AGE_MS = 5_000

/** The parts of a snapshot read from repositories' folders. */
type RepoFiles = Pick<AppSnapshot, 'repoSettings' | 'repoTemplates' | 'repoCommands' | 'recentRepos'>

const repoFilesOf = (s: AppSnapshot): RepoFiles => ({ repoSettings: s.repoSettings, repoTemplates: s.repoTemplates, repoCommands: s.repoCommands, recentRepos: s.recentRepos })

/** A snapshot as text for comparing broadcasts; undefined when it can't be written (it is then always sent). */
function stateText(snapshot: AppSnapshot): string | undefined {
  try {
    return JSON.stringify(snapshot)
  } catch {
    return undefined
  }
}

export class Core {
  private mobile: MobileService | null = null
  bindMobile(service: MobileService): void { this.mobile = service }
  readonly workspaces: WorkspaceService
  readonly sessions: SessionService
  readonly ptys: PtyManager
  readonly terminals: TerminalRestore
  // #19: the file viewer's sandboxed HTML/PDF previews (foreman-preview://), answered from each worktree.
  readonly preview: PreviewServer
  readonly git: GitActions
  readonly prs: PrCache
  readonly prWatch: PrWatcher
  // #5: "Send CI failures to the agent automatically", per workspace, behind its consent.
  readonly autoFix: AutoFixService
  // #17: auto review, per repository behind its consent: a read-only reviewer after a worker's turn, never sent on its own.
  readonly autoReview: AutoReviewService
  // O2: which host (GitHub or GitLab) each repository's pull requests live on.
  readonly scm: ScmRouter
  // G2: whether glab is signed in per GitLab host, for the agent's system prompt.
  private glab = new GlabLogins()
  // G2 (O5): which tab made each commit, kept between loads of the Commits tab.
  private commitTabs = new CommitAttribution((sessionId) => this.store.readChat(sessionId))
  readonly baseWatch: BaseWatcher
  readonly checks: ChecksService
  readonly autoChecks: AutoChecks
  readonly handOffs: HandOffService
  readonly compare: CompareService
  readonly repoMcp: RepoMcp
  readonly schedules: ScheduleService
  readonly devices: Devices
  readonly net: DeviceNet
  readonly transfers: TransferService
  readonly claudeMirror: ClaudeMirror
  readonly portability: PortabilityService
  readonly data: DataService
  readonly gitBackup: GitBackupService
  readonly spotlight: Spotlight
  readonly models: ModelCatalogService
  // Is there a newer Foreman? Checked at launch (index.ts) and from Settings.
  readonly updates: UpdateCheck
  readonly environment: Environment
  readonly stopSafely: StopSafely
  // Archives a workspace once its scheduled run completed or its PR merged, and deletes auto-archived ones later.
  readonly autoArchive: AutoArchive
  readonly agentHost: AgentHostService
  // #2: turn identity, agent reports and "Teach agents Foreman".
  readonly agentReports: AgentReportService
  // #2: whether the `foreman` command is installed, as last checked (slow to ask on Windows, so cached).
  private cliInstalled = false
  // Show resource usage: each workspace's processes (its agents', terminals' and scripts', here and in the agent host).
  private processUsage = new ProcessUsageSampler(async () => [...processRoots(), ...(await this.agentHost.processRoots())])
  readonly openIn: OpenInService
  // #15: selection comments waiting for their tab, checked again when it's free.
  readonly diffSelections: DiffSelectionService
  // #11: resumes armed after a usage limit, one per tab, sent at the reset time while Foreman is open.
  readonly limitResume: LimitResumeService
  // #22: the agent catalog (detection, per-agent keys) and Terminal agents' tabs.
  readonly agentCatalog: AgentCatalogService
  readonly terminalAgents: TerminalAgents
  // #3: the attention history (Home → Recent), the tray's view and the 60-second look at open PRs.
  readonly attention: AttentionService
  readonly prPoll: PrPoller
  // The Foreman assistant (sidebar → Assistant).
  readonly assistant: AssistantService
  // Phase G2: speech to text (the local sherpa-onnx helper and the optional OpenAI upload).
  readonly speech: SpeechService
  // Integrations: GitHub, Linear and Slack connections, the bridge that gives agents their tools, and Slack rules.
  readonly integrations: Integrations
  readonly bridge: IntegrationBridge
  readonly foremanActions: ForemanActions
  readonly foremanMcp: ForemanMcp
  // Cloud workspaces' sandboxes on Vercel. Inert until a Vercel connection and a cloud workspace exist.
  readonly sandboxes: SandboxManager
  // Cloud workspaces, phase 2: their turns run in the agent host inside each sandbox (cloud/turnHost.ts).
  readonly cloudTurns: CloudTurnHost
  readonly slack: SlackRules
  private slackPeopleCache = new Map<string, { at: number; people: SlackPerson[] }>()
  private slackRepoBaselines = new Set<string>()
  private startedAt = Date.now()
  // State broadcasts are coalesced: changes in one tick share one snapshot, built in a microtask after the last.
  private statePending = false
  private stateChecks = false
  // What the window last heard, for the focus check (screenReaderChanged).
  private lastState: AppSnapshot | null = null
  // The last broadcast snapshot as text, so a broadcast that would change nothing isn't sent (flushState).
  private lastStateText: string | undefined
  // Whether each recent repository's folder exists, looked at again after REPO_FILES_MAX_AGE_MS.
  private recentChecks = new Map<string, { at: number; exists: boolean }>()

  constructor(
    private store: Store,
    private secrets: SecretStore,
    private host: Host
  ) {
    // #3: every state broadcast is a change the attention history and the tray look at (debounced).
    const outer = host
    const watched = Object.create(outer) as Host
    watched.broadcast = (event) => {
      outer.broadcast(event)
      if (event.type === 'state') {
        this.lastState = event.snapshot
        this.attention?.schedule()
      }
    }
    host = watched
    this.host = watched
    // Services' changes: the first messages, quit and keep-awake checks run once per coalesced broadcast (flushState).
    const changed = () => this.broadcastState(true)
    this.environment = new Environment(secrets, () => store.state.settings, (id) => this.workspaces.repo(id))
    // #22: agent keys are per agent; the old user variables move once, before any agent starts.
    this.agentCatalog = new AgentCatalogService({
      secrets,
      settings: () => store.state.settings,
      fullStatus: (agent) => this.api.agentStatus(agent),
      agentEnv: (agent) => this.environment.forCatalogAgent(agent),
      executablePath: (agent) => executablePathFor(store.state.settings, agent),
      shell: () => process.env,
      keysChanged: (agent) => {
        this.broadcastState()
        if (agent === 'claude' || agent === 'codex' || agent === 'cursor' || agent === 'opencode') void this.models.refresh(agent)
      }
    })
    this.agentCatalog.migrateKeys()
    this.assistant = new AssistantService({
      store,
      environment: this.environment,
      statuses: async (refresh) => (await this.agentCatalog.view(refresh)).statuses,
      platform: process.platform,
      dir: path.join(store.dir, 'assistant'),
      broadcast: (event) => host.broadcast(event)
    })
    this.speech = new SpeechService({
      dir: store.dir,
      settings: () => store.state.settings,
      providerKey: (name) => secrets.providerKeys()[name] || undefined,
      broadcast: (event) => host.broadcast(event),
      microphone: host.microphone ? () => host.microphone!() : undefined,
      helper: host.sttHelper ? () => host.sttHelper!() : undefined
    })
    this.openIn = new OpenInService(() => store.state.settings, host)
    this.workspaces = new WorkspaceService(
      store,
      {
        changed,
        setupLog: (workspaceId, chunk, step) => host.broadcast({ type: 'setup-log', workspaceId, chunk, ...(step ? { step: step.index, runId: step.runId } : {}) }),
        setupFinished: (workspaceId) => host.broadcast({ type: 'auto-run', workspaceId }),
        // G3 · #1: the archive dialog follows each step as it goes.
        archiveProgress: (workspaceId, progress) => host.broadcast({ type: 'archive-progress', workspaceId, progress })
      },
      this.environment
    )
    this.repoMcp = new RepoMcp(store, this.workspaces, this.environment)
    // Integrations, before anything runs GitHub work: the old token and linked accounts move into connections once.
    // gh answers in the background; agents' and terminals' environments then find its answers cached.
    const warmGithubAccounts = () => {
      const { accounts, active } = this.integrations.ghAccountsInUse()
      void warmGithub(accounts, active)
    }
    this.integrations = new Integrations({
      store,
      secrets,
      repo: (id) => this.workspaces.repo(id),
      repoGithubToken: (id) => this.environment.repoGithubToken(id),
      remoteUrl: (id) => this.workspaces.remoteUrl(id),
      githubAccounts: () => githubAccounts(),
      accountToken: (login) => accountTokenAsync(login),
      activeLogin: () => ghActiveAccountAsync(true),
      activeAccount: () => ghActiveAccount(),
      changed: () => {
        // Who GitHub work runs as may have changed: forget logins and lift a pause after an auth failure.
        forgetIdentityLogins()
        this.prs?.resume()
        warmGithubAccounts()
        changed()
      }
    })
    this.integrations.migrate()
    warmGithubAccounts()
    setGithubIdentities((key) => this.integrations.githubIdentity(key))
    const githubKey = (repoId: string) => this.integrations.githubKey(repoId)
    this.environment.githubKey = githubKey
    this.workspaces.githubKey = githubKey
    const githubKeyFresh = (repoId: string) => this.integrations.githubKeyFresh(repoId)
    this.environment.githubKeyFresh = githubKeyFresh
    this.workspaces.githubKeyFresh = githubKeyFresh
    this.workspaces.githubDetected = (repoId, login, explicit) => this.integrations.detectedGithubAccount(repoId, login, explicit)
    this.workspaces.repoAdded = (repoId) => this.integrations.repoAdded(repoId)
    this.sandboxes = new SandboxManager({
      store,
      secrets,
      connection: (service, connectionId) => this.integrations.sandboxConnection(service, connectionId),
      githubToken: (repoId) => this.cloudGithubToken(repoId),
      cloneUrl: async (repoId) => {
        const url = await this.workspaces.remoteUrl(repoId)
        return url ? githubHttpsUrl(url) : null
      },
      gitIdentity: async (repoId) => {
        const root = this.workspaces.repo(repoId).rootPath
        const [name, email] = await Promise.all(['user.name', 'user.email'].map((key) => git(root, ['config', key], { allowFail: true }).then((r) => r.stdout.trim() || undefined)))
        return { name, email }
      },
      settingsFor: (repoId) => this.workspaces.settingsFor(repoId),
      changed,
      buildLog: (repoId, buildId, chunk) => host.broadcast({ type: 'cloud-build-log', repoId, buildId, chunk }),
      // A turn in the sandbox's host (also between its result and its end), or a chat still marked running (recovery).
      turnRunning: (workspaceId) => Boolean(this.cloudTurns?.running(workspaceId)) || store.state.sessions.some((s) => s.workspaceId === workspaceId && (s.status === 'running' || Boolean(s.turnId))),
      // A cloud terminal tab connected and in use (a script running, or typed in or printed to lately; cloud/terminal.ts).
      terminalOpen: (workspaceId) => this.ptys?.keepsAwake(workspaceId) ?? false,
      // TODO(phase 3): the window reports the workspace it shows.
      focused: () => false
    })
    this.workspaces.cloud = this.sandboxes
    // ---- cloud workspaces, phase 2b: agents in the sandbox ----
    this.cloudTurns = new CloudTurnHost({
      store,
      sandboxes: this.sandboxes,
      secrets,
      vars: (repoId) => this.environment.vars(repoId),
      githubToken: (repoId) => this.cloudGithubToken(repoId),
      dir: path.join(store.dir, 'cloud-host'),
      changed
    })
    // ---- end cloud workspaces, phase 2b ----
    this.bridge = new IntegrationBridge({ integrations: this.integrations, launch: () => host.bridgeLaunch?.() ?? null, socket: () => host.cliSocket?.() ?? null })
    this.slack = new SlackRules({
      integrations: this.integrations,
      db: () => store.db,
      repo: (id) => store.state.repos.find((r) => r.id === id),
      githubLogin: (repoId) => githubLogin(this.workspaces.accountFor(repoId)),
      away: () => host.away?.() ?? false,
      notify: (n) => host.broadcast({ type: 'notify', sessionId: '', ...n, kind: 'attention' }),
      changed,
      validateReviewer: async (repoId, number, reviewer, url) => {
        const repo = this.workspaces.repo(repoId)
        const target = await this.scm.target(repoId)
        if (target.kind !== 'github') return false
        const slug = (url ? findScmLink(url)?.repo : undefined) ?? githubSlug(await this.workspaces.remoteUrl(repoId) ?? '')
        if (!slug) return false
        const provider = await this.scm.forRepo(repoId)
        const result = await provider.pullRequest({ id: '', repoId, path: repo.rootPath, branch: '', pullRequest: { repo: slug, number } } as Workspace)
        return result.kind === 'ok' && result.pr.state === 'OPEN' && Boolean(result.pr.reviewRequests?.some((r) => r.login?.toLowerCase() === reviewer))
      }
    })
    this.slack.recover()
    this.claudeMirror = new ClaudeMirror(() => store.db)
    this.agentHost = new AgentHostService({ store, dir: host.agentHost?.dir ?? hostDir(store.dir), spawn: host.agentHost?.spawn, changed })
    this.agentReports = new AgentReportService({
      state: () => store.state,
      emit: (sessionId, item) => {
        void store.appendChat(sessionId, item)
        host.broadcast({ type: 'chat-item', sessionId, item })
      },
      changed: () => {
        store.save()
        changed()
      },
      settingsFor: (repoId) => this.workspaces.settingsFor(repoId),
      // In the vault, so a kept turn's token still checks after a restart.
      key: () => {
        let key = secrets.appSecret('turnTokenKey')
        if (!key) {
          key = newTurnKey()
          secrets.setAppSecret('turnTokenKey', key)
        }
        return key
      },
      cliInstalled: () => this.cliInstalled,
      notify: (workspaceId, sessionId, title, body, kind) => host.broadcast({ type: 'notify', workspaceId, sessionId, title, body, kind })
    })
    this.sessions = new SessionService(store, this.environment, this.workspaces, {
      changed,
      item: (sessionId, item) => host.broadcast({ type: 'chat-item', sessionId, item }),
      append: (sessionId, append) => host.broadcast({ type: 'chat-append', sessionId, ...append }),
      reset: (sessionId, items) => host.broadcast({ type: 'chat-reset', sessionId, items }),
      approval: (request) => host.broadcast({ type: 'approval', request }),
      approvalResolved: (id) => host.broadcast({ type: 'approval-resolved', id }),
      notify: (workspaceId, sessionId, title, body, kind) => {
        host.broadcast({ type: 'notify', workspaceId, sessionId, title, body, kind })
        // Slack rules: an agent needs the user, or finished.
        if (kind === 'attention' || kind === 'finished') this.agentSlackEvent(kind, workspaceId, sessionId, body)
      },
      turnEnded: (sessionId, outcome, stoppedAt) => {
        const session = this.store.state.sessions.find((s) => s.id === sessionId)
        if (!session) return
        // The end checkpoint's snapshot, taken after the agent stopped, serves (one scan per turn end).
        void this.refreshDiffStat(session.workspaceId, stoppedAt)
        // Slack rules: agents open PRs in turns, so look for a new one when a workspace has none yet.
        const ended = this.store.state.workspaces.find((w) => w.id === session.workspaceId)
        if (ended && !ended.prInfo && this.slack.hasRules() && this.workspaces.repo(ended.repoId).hasOrigin) void this.prs.get(ended, { fresh: true })
        this.autoChecks.turnEnded(session.workspaceId, outcome)
        this.schedules.turnEnded(sessionId, outcome)
        this.diffSelections.wake(sessionId)
        if (session.lastTurn?.turnId) this.autoFix.turnEnded(session.lastTurn.turnId, outcome)
        // #17: a worker's completed turn may make a review owed (only where the repo opted in); a reviewer's settles its review.
        this.autoReview.turnEnded(sessionId, outcome)
      },
      unattendedStopped: (sessionId, what) => {
        this.schedules.needsHuman(sessionId, what)
        this.autoReview.needsHuman(sessionId, what)
      },
      activity: (sessionId) => this.limitResume.activity(sessionId),
      workStarting: (workspaceId) => {
        this.autoChecks.workStarting(workspaceId)
        this.autoArchive?.cancel(workspaceId)
        this.autoReview.activity(workspaceId)
      },
      settled: (workspaceId) => {
        this.autoChecks.settled(workspaceId)
        this.autoArchive?.settled(workspaceId)
        this.autoReview.activity(workspaceId)
        for (const s of this.store.state.sessions) if (s.workspaceId === workspaceId) this.diffSelections.wake(s.id)
      }
    }, this.repoMcp, this.claudeMirror, this.agentHost, this.agentReports)
    this.sessions.integrations = this.bridge
    this.foremanActions = new ForemanActions({ state: () => store.state, api: this.api })
    this.foremanMcp = new ForemanMcp({
      actions: this.foremanActions,
      session: (id) => store.state.sessions.find((s) => s.id === id),
      launch: () => host.bridgeLaunch?.() ?? null,
      socket: () => host.cliSocket?.() ?? null
    })
    this.sessions.foremanMcp = this.foremanMcp
    this.assistant.foremanActions = this.foremanActions
    // Cloud workspaces, phase 2b: a cloud workspace's turns go to its sandbox's host.
    this.sessions.cloudHost = this.cloudTurns
    this.cloudTurns.bind(this.sessions)
    this.agentHost.bind(this.sessions)
    this.diffSelections = new DiffSelectionService({
      comments: () => this.store.state.comments,
      sessions: () => this.store.state.sessions,
      workspace: (id) => this.workspaces.workspace(id),
      send: (sessionId, text) => this.sessions.send(sessionId, text, { mode: 'queue' }),
      createSession: (workspaceId) => this.sessions.createSession(workspaceId),
      readChat: (sessionId) => this.store.readChat(sessionId),
      changed: () => this.changed()
    })
    this.diffSelections.holdWaiting()
    this.limitResume = new LimitResumeService({
      sessions: () => this.store.state.sessions,
      readChat: (sessionId) => this.store.readChat(sessionId),
      send: (sessionId, text) => this.sessions.deliver(sessionId, text, { mode: 'queue' }),
      flush: () => store.flush(),
      changed,
      now: () => Date.now(),
      missed: (session) => {
        const ws = this.store.state.workspaces.find((w) => w.id === session.workspaceId)
        const t = mainT(this.store.state.settings)
        host.broadcast({ type: 'notify', workspaceId: session.workspaceId, sessionId: session.id, title: ws?.name ?? 'Foreman', body: t('usageLimit.notify.missed'), kind: 'info' })
      }
    })
    this.schedules = new ScheduleService({
      store,
      now: () => Date.now(),
      inputs: (schedule) => this.scheduleInputs(schedule),
      launch: (schedule, occurrence, handle) => this.launchScheduled(schedule, occurrence, handle),
      stop: async (occurrence) => {
        if (occurrence.sessionId) await this.sessions.cancel(occurrence.sessionId)
      },
      turnStart: (occurrence) => {
        const session = occurrence.sessionId ? this.store.state.sessions.find((s) => s.id === occurrence.sessionId) : undefined
        if (session?.waitingForSlot) return 'waiting'
        return session?.turnId ? session.turnStartedAt : undefined
      },
      workspaceFor: (occurrenceId) => {
        const ws = this.store.state.workspaces.find((w) => w.scheduled?.occurrenceId === occurrenceId)
        const session = ws && this.store.state.sessions.find((x) => x.workspaceId === ws.id)
        return ws ? { workspaceId: ws.id, sessionId: session?.id } : undefined
      },
      afterRun: (schedule, occurrence) =>
        this.autoArchive.request(occurrence.workspaceId!, {
          reason: { kind: 'run', scheduleId: schedule.id },
          deleteBranch: Boolean(schedule.afterRunDeleteBranch),
          deleteIfUnchanged: schedule.afterRun === 'delete-unchanged'
        }),
      paused: () => Boolean(this.stopSafely?.isDraining),
      ready: () => ghActiveAccountReady(),
      changed
    })
    this.data = new DataService(store, undefined, this.claudeMirror)
    this.gitBackup = new GitBackupService({
      store, secrets, workspaces: this.workspaces,
      updateSettings: (patch) => this.api.updateSettings(patch),
      startChat: (workspaceId) => { this.startChat(workspaceId) },
      changed
    })
    this.handOffs = new HandOffService(store, this.sessions, this.workspaces)
    this.compare = new CompareService({
      store,
      workspaces: this.workspaces,
      isRunning: (id) => this.sessions.isRunning(id),
      send: (sessionId, text) => this.sessions.send(sessionId, text),
      startChat: (workspaceId, prompt, loadout) => this.startChat(workspaceId, prompt, loadout),
      archive: (id) => this.archiveNow(id, false)
    })
    this.portability = new PortabilityService({
      store,
      workspaces: this.workspaces,
      // Names only: the vault's values never leave it.
      variableNames: (repoId) => [
        ...Object.keys(secrets.vars({ kind: 'user' })).map((name) => ({ scope: 'user' as const, name })),
        ...Object.keys(secrets.vars({ kind: 'repo', repoId })).map((name) => ({ scope: 'repo' as const, name }))
      ],
      changed,
      mirror: this.claudeMirror,
      busy: (id) => this.busyReason(id)
    })
    this.devices = new Devices({
      store,
      keys: { get: (id) => secrets.appSecret(`device-key:${id}`), set: (id, key) => secrets.setAppSecret(`device-key:${id}`, key) },
      changed
    })
    this.net = new DeviceNet({
      self: () => this.devices.self(this.store.state.settings.devicePort),
      keyFor: (id) => this.devices.keyFor(id),
      addressOf: (id) => this.devices.addressOf(id),
      seen: (id) => this.devices.seen(id),
      onRequest: (from, request, file) => this.transfers.handle(from, request, file),
      pairingHost: () => this.devices.pairingHost(),
      onPaired: (result, address) => {
        this.devices.add(result, plainAddress(address), result.peer.port)
        this.devices.cancelCode()
      }
    })
    this.transfers = new TransferService({
      store,
      transport: this.net,
      local: this.transferLocal(),
      peerName: (id) => this.devices.find(id)?.name ?? 'the other Mac',
      files: {
        temp: (name) => path.join(os.tmpdir(), `foreman-${randomUUID().slice(0, 8)}-${name}`),
        read: (file) => readFile(file),
        write: (file, data) => writeFile(file, data),
        remove: (file) => rm(file, { force: true })
      },
      changed
    })
    this.checks = new ChecksService({
      store,
      workspace: (id) => this.workspaces.workspace(id),
      checks: (repoId) => this.workspaces.settingsFor(repoId).checks,
      env: (ws) => this.terminalEnv(ws),
      changed
    })
    this.autoChecks = new AutoChecks({
      checks: this.checks,
      workspace: (id) => this.workspaces.workspace(id),
      enabled: (repoId) => this.workspaces.settingsFor(repoId).checksAfterTurn,
      // #1: no check run starts after a turn while Foreman quits once the running work ends.
      busy: (workspaceId) => this.sessions.isBusy(workspaceId) || Boolean(this.stopSafely?.isDraining),
      changed
    })
    // O2: GitHub repos as their linked gh account; GitLab repos with their host's token from the vault.
    this.scm = new ScmRouter({
      repo: (repoId) => this.workspaces.repo(repoId),
      remoteUrl: (repoId) => this.workspaces.remoteUrl(repoId),
      gitlabHosts: () => this.store.state.settings.gitlabHosts ?? [],
      gitlabToken: (h) => this.secrets.appSecret(gitlabTokenKey(h)),
      githubKey,
      githubIdentity: (repoId) => {
        const r = this.integrations.resolve(repoId, 'github')
        return r.state === 'ready' ? `${r.connection.id}:${r.connection.rev}:${this.integrations.githubKey(repoId) ?? ''}` : this.integrations.githubKey(repoId) ?? ''
      }
    })
    // G2: a GitLab repository's agents hear about the host, and about glab when it's signed in there.
    this.workspaces.hostContext = (ws) => {
      try {
        const target = this.scm.cachedTarget(ws.repoId)
        return target.kind === 'gitlab' ? gitlabAgentContext(target.host, this.glab.signedIn(target.host.host.replace(/:\d+$/, ''))) : []
      } catch {
        return []
      }
    }
    // PR lookups run as the repo's linked GitHub account (or the GitLab host's token).
    this.prs = new PrCache({
      fetch: (ws) => this.scm.forRepo(ws.repoId).then((provider) => provider.pullRequest(ws)),
      // A cloud workspace's lookups run in its sandbox with the repository's token: their failures pause only those.
      identity: (ws) => `${ws.cloud ? 'cloud:' : ''}${this.scm.identity(ws.repoId)}`,
      ready: () => ghActiveAccountReady(),
      onResult: (ws, result) => this.notePullRequest(ws.id, result)
    })
    this.autoArchive = new AutoArchive({
      workspaces: () => this.store.state.workspaces,
      // Quiet as auto-fix means it, plus checks after a turn still waiting to run and a cloud turn.
      quiet: (ws) =>
        !(
          this.sessions.isBusy(ws.id) ||
          this.cloudTurns?.running(ws.id) ||
          ws.checks?.running ||
          ws.autoChecks?.state === 'running' ||
          ws.autoChecks?.state === 'waiting' ||
          (ws.setupRun && !ws.setupRun.finishedAt)
        ),
      archive: async (id, deleteBranch, reason, stopTabs) => {
        const outcome = await this.stopSafely.archive(id, deleteBranch, { stopTabs }, reason)
        return outcome.ok ? { ok: true } : { ok: false, detail: outcome.detail }
      },
      unchanged: async (ws) => {
        const at = workspaceTarget(ws)
        const { baseRef } = await branchPoint(ws, at)
        const commits = await git(at, ['rev-list', '--count', `${baseRef}..HEAD`], { allowFail: true })
        return commits.code === 0 && Number(commits.stdout.trim()) === 0 && (await workspaceDiffStat(ws)).files === 0
      },
      work: (id) => this.workspaces.archivedWork(id),
      remove: (id) => this.workspaces.deleteArchived(id),
      cleanupDays: () => this.store.state.settings.archiveCleanupDays ?? 0,
      now: () => Date.now(),
      log: (message) => console.warn(message)
    })
    this.git = new GitActions(store, this.workspaces, this.sessions, (url) => host.openExternal(url), this.prs, (ws) => this.scmFor(ws.repoId), (id, number, deleteBranch) =>
      this.autoArchive.now(id, { reason: { kind: 'merged', number }, deleteBranch })
    )
    this.prWatch = new PrWatcher({
      store,
      prs: this.prs,
      hasRemote: (ws) => this.workspaces.repo(ws.repoId).hasOrigin,
      reviews: async (ws, pr) => (await this.scm.forRepo(ws.repoId)).reviewActivity(ws, pr),
      notify: (n) => host.broadcast({ type: 'notify', sessionId: '', ...n }),
      changed,
      ciObserved: (ws, obs) => this.autoFix.observed(ws, obs)
    })
    this.autoFix = new AutoFixService({
      store,
      // Idle: ready, no tab running or queued, no checks or setup running.
      busy: (ws) =>
        ws.state !== 'ready' || this.sessions.isBusy(ws.id) || Boolean(ws.checks?.running) || ws.autoChecks?.state === 'running' || Boolean(ws.setupRun && !ws.setupRun.finishedAt),
      draining: () => Boolean(this.stopSafely?.isDraining),
      current: (ws, sessionId) => {
        const session = this.store.state.sessions.find((s) => s.id === sessionId && s.workspaceId === ws.id && !s.closedAt)
        if (!session) return null
        return {
          sessionId,
          agent: session.agent,
          permissions: permissionNote(session.agent, this.store.state.settings),
          prompt: fixErrorsInstructions(this.workspaces.settingsFor(ws.repoId).prompts.fixErrors)
        }
      },
      prLabel: (ws) => {
        const number = ws.prInfo?.number ?? ws.pullRequest?.number
        if (number === undefined) return undefined
        return ws.pullRequest?.gitlabHost || this.scm.cachedTarget(ws.repoId).kind === 'gitlab' ? `MR !${number}` : `PR #${number}`
      },
      send: (ws, sessionId, failure, options) => this.git.sendCiFix(ws.id, sessionId, failure, options),
      cancelTurn: (turnId) => this.sessions.cancelTurn(turnId),
      turnStatus: (turnId) => this.sessions.turnStatus(turnId),
      localHead: (ws) => gitOut(workspaceTarget(ws), ['rev-parse', 'HEAD']).then((h) => h.trim() || null),
      refresh: (ws) => {
        this.prs.invalidate(ws.id)
        void this.prWatch.poll(ws.id)
      },
      newId: () => randomUUID(),
      changed
    })
    this.autoReview = new AutoReviewService({
      store,
      now: () => Date.now(),
      newId: () => randomUUID(),
      customPrompt: (repo) => this.workspaces.settingsFor(repo.id).prompts.codeReview,
      defaultReviewer: () => defaultReviewer(store.state.settings.reviewModel, { agent: 'claude', model: DEFAULT_MODEL.claude, fast: false }),
      // Idle as auto-fix means it: ready, no tab running or queued, no checks or setup running.
      busy: (ws) =>
        ws.state !== 'ready' || this.sessions.isBusy(ws.id) || Boolean(ws.checks?.running) || ws.autoChecks?.state === 'running' || Boolean(ws.setupRun && !ws.setupRun.finishedAt),
      draining: () => Boolean(this.stopSafely?.isDraining),
      tree: (ws) => sharedWorkingTree(workspaceTarget(ws)),
      checks: async (ws, tree) => {
        const status = await this.checks.status(ws.id)
        const pending = status.running || ws.autoChecks?.state === 'waiting' || ws.autoChecks?.state === 'running'
        return checksFact(status.configured ? status.rows : [], tree, pending)
      },
      changedFiles: (ws, from, to) => changedFilesBetween(ws, from, to),
      capture: (ws) => workspaceDiffPatch(ws),
      launch: async (ws, worker, review, message) => {
        if (!canReview(review.reviewer.agent)) throw new Error('This reviewer can’t be held to read-only')
        const attachments = await Promise.all(message.attachments.map((a) => attachFromData(workspaceTarget(ws, { wake: true }), a.name, Buffer.from(a.content).toString('base64'))))
        const session = await this.sessions.handOff(worker.id, {
          model: review.reviewer,
          text: message.text,
          attachments,
          title: 'Auto review',
          readOnly: true,
          turnId: review.turnId,
          // Before its first message goes: nobody can answer this turn, so its approvals and questions are denied.
          prepare: (target) => {
            target.unattended = { autoReviewId: review.id }
            target.autoReview = { reviewId: review.id }
          }
        })
        return { sessionId: session.id }
      },
      cancelTurn: (turnId) => this.sessions.cancelTurn(turnId),
      turnStatus: (turnId) => this.sessions.turnStatus(turnId),
      answer: async (sessionId, turnId) => turnAnswer(await this.store.readChat(sessionId), turnId),
      send: (sessionId, text) => this.sessions.send(sessionId, text, { mode: 'queue' }),
      changed
    })
    this.baseWatch = new BaseWatcher({
      store,
      enabled: (repoId) => this.workspaces.settingsFor(repoId).warnBaseMoved,
      repo: (repoId) => this.workspaces.repo(repoId),
      githubKey: (repoId) => this.workspaces.accountFor(repoId),
      notify: (n) => host.broadcast({ type: 'notify', sessionId: '', ...n }),
      changed
    })
    this.spotlight = new Spotlight({
      log: (workspaceId, line) => host.broadcast({ type: 'setup-log', workspaceId, chunk: `${line}\n` }),
      changed
    })
    this.models = new ModelCatalogService(store, (agent) => this.agentOptions(agent), changed)
    this.updates = new UpdateCheck({
      currentVersion: () => host.appInfo?.().version,
      enabled: () => store.state.settings.checkForUpdates,
      interval: () => store.state.settings.updateInterval,
      mode: () => store.state.settings.updateMode,
      channel: () => store.state.settings.updateChannel,
      skipped: () => store.state.skippedUpdate,
      setSkipped: (version) => {
        store.state.skippedUpdate = version
        store.save()
      },
      lastRun: () => store.state.lastRunVersion,
      setLastRun: (version) => {
        store.state.lastRunVersion = version
        store.save()
      },
      installer: host.updateInstaller,
      changed
    })
    // G1: an ACP agent's declared session modes (a plan mode lights its Plan chip); per-turn launch files go in Foreman's data folder.
    onAcpModes((agent, modes) => {
      if (this.models.declaredModes(agent, modes)) changed()
    })
    setAgentRuntimeDir(path.join(store.dir, 'agent-runtime'))
    this.ptys = new PtyManager({
      data: (ptyId, data) => {
        this.terminalAgents?.output(ptyId)
        host.broadcast({ type: 'pty-data', ptyId, data })
      },
      exit: (ptyId, code) => {
        this.terminalAgents?.exited(ptyId, code)
        host.broadcast({ type: 'pty-exit', ptyId, code })
      },
      state: (ptyId, asleep, reason) => host.broadcast({ type: 'pty-state', ptyId, asleep, ...(reason ? { reason } : {}) })
    }, new CloudPtyBackend({
      // Phase 4: cloud workspaces' terminal tabs, a PTY in the sandbox.
      sandboxes: this.sandboxes,
      workspace: (id) => store.state.workspaces.find((w) => w.id === id),
      t: () => mainT(store.state.settings),
      typeWhenQuiet
    }))
    this.terminalAgents = new TerminalAgents({
      spawn: (workspaceId, cwd, env, cols, rows, launch) => this.ptys.spawn(workspaceId, cwd, env, cols, rows, undefined, false, launch),
      worktree: (workspaceId) => {
        const ws = this.workspaces.workspace(workspaceId)
        const frozen = frozenReason(ws)
        if (frozen) throw new Error(frozen)
        if (ws.state !== 'ready' && ws.state !== 'setup-failed') throw new Error('The workspace is not ready to run an agent')
        return { path: wsPath(ws), repoId: ws.repoId }
      },
      env: (agent, repoId, workspaceId) => this.environment.forCatalogAgent(agent, repoId, this.workspaces.env(this.workspaces.workspace(workspaceId))),
      executablePath: (agent) => executablePathFor(store.state.settings, agent),
      path: () => process.env.PATH ?? process.env.Path ?? '',
      platform: process.platform,
      exists: existsSync
    })
    this.preview = new PreviewServer((workspaceId) => {
      const ws = store.state.workspaces.find((w) => w.id === workspaceId)
      return ws && ws.path && ws.state !== 'archived' && ws.state !== 'history' ? wsPath(ws) : undefined
    })
    this.terminals = new TerminalRestore(path.join(store.dir, 'terminals.json'), () => store.state.settings.restoreTerminals !== false)
    this.terminals.load()
    setScriptShell(store.state.settings.scriptShell)
    this.stopSafely = new StopSafely({
      store,
      sessions: this.sessions,
      workspaces: this.workspaces,
      terminals: () => this.ptys.list(),
      stopChecks: (id) => this.checks.cancel(id),
      killTerminals: (id) => this.ptys.killWorkspace(id),
      forgetTerminals: (id) => {
        this.terminals.forget(id)
        // G3 · #19: its previews' host stops answering.
        this.preview.forget(id)
      },
      // G3 · #1: the archive dialog follows each step as it goes.
      archiveProgress: (workspaceId, progress) => host.broadcast({ type: 'archive-progress', workspaceId, progress }),
      stopSpotlight: async (id) => {
        const repo = this.workspaces.repo(this.workspaces.workspace(id).repoId)
        if (this.spotlight.isActive(id)) await this.spotlight.stop(repo)
      },
      disposeSessions: (id, root) => this.sessions.disposeWorkspaceSessions(id, root),
      agentHost: this.agentHost,
      quit: () => host.quit?.(),
      // Checks held back while waiting to quit get their turn again.
      resumed: () => {
        for (const w of store.state.workspaces) this.autoChecks.settled(w.id)
      },
      changed
    })
    this.attention = new AttentionService({
      db: store.db,
      state: () => ({ repos: store.state.repos, workspaces: store.state.workspaces, sessions: store.state.sessions, stopRecord: this.stopSafely?.record() }),
      approvals: () => this.sessions.pendingApprovals(),
      now: () => Date.now(),
      newId: () => randomUUID(),
      show: (view) => {
        // The same count as Home's "need you" (Windows has no numeric dock badge; the tray says it there).
        host.setBadge(store.state.settings.dockBadge ? view.count : 0)
        host.showAttention?.(view)
      },
      // The badge and tray also follow settings (dock badge, tray icon, language), replaced as a whole on each change.
      showContext: () => store.state.settings,
      logChanged: () => host.broadcast({ type: 'attention-history', ...this.attention.history() })
    })
    this.prPoll = new PrPoller({
      afterPoll: () => this.pollSlackRepositories(),
      workspaces: () => store.state.workspaces,
      prs: this.prs,
      hasRemote: (ws) => {
        try {
          return this.workspaces.repo(ws.repoId).hasOrigin
        } catch {
          return false
        }
      }
    })
  }

  /**
   * Windows (O4): the shell a terminal tab starts, from Settings → Shell or the tab's own pick.
   * One that isn't found falls back to Automatic, and the tab's first line says why.
   */
  private terminalShell(cwd: string, requested?: string): (ShellLaunch & { notice?: string }) | undefined {
    if (!isWindows) return undefined
    const { settings } = this.store.state
    const choice = isShellChoice(requested) ? requested : settings.terminalShell
    const launch = resolveShell(choice, detectShells(realProbe(), settings.terminalShellCustom), cwd, process.env.SystemRoot)
    if (!launch.fallback) return launch
    const t = mainT(settings)
    const wanted = t(`terminal.shell.name.${launch.fallback.wanted}`)
    const used = launch.fallback.used ? t(`terminal.shell.name.${launch.fallback.used}`) : t('terminal.shell.name.powershell')
    return { ...launch, notice: t('terminal.shell.fellBack', { wanted, used }) }
  }

  /** O9: the commands a workspace's repository offers, approval checked again now (the repo's file may have changed). */
  private savedCommand(ws: Workspace, id: string): SavedCommand {
    const repo = this.workspaces.repo(ws.repoId)
    const command = findCommand(this.store.state.settings.savedCommands ?? [], repoCommands(this.store.state, repo), repo.id, id)
    if (!command) throw new Error('That command isn’t saved for this repository any more')
    return command
  }

  /**
   * O9: a saved command's tab: the user's shell (Settings → Shell on Windows, the login shell elsewhere) in the
   * workspace with its script environment, the banner above it, and the command typed in once it's up.
   */
  private savedCommandShell(ws: Workspace, id: string): { cwd: string; shell: ShellLaunch & { notice?: string; input?: string } } {
    const repo = this.workspaces.repo(ws.repoId)
    const command = runnableCommand(this.store.state.settings.savedCommands ?? [], repoCommands(this.store.state, repo), repo.id, id)
    const t = mainT(this.store.state.settings)
    const launch = commandLaunch(command, { name: ws.name, path: wsPath(ws) }, t)
    const shell = this.terminalShell(launch.cwd) ?? interactiveShell()
    // A shell that fell back (O4) says so first, then the command's banner.
    const notice = 'notice' in shell && shell.notice ? `${shell.notice}\r\n${launch.notice}` : launch.notice
    // G4: with the shell's status marker on the last line, so the tab can show ✓/✗.
    return { cwd: launch.cwd, shell: { ...shell, notice, input: commandInputWithStatus(command.command, statusShell(shell.file)) } }
  }

  /** A workspace whose terminals can be saved or restored: known and not archived. */
  private terminalWorkspace(workspaceId: string): Workspace | undefined {
    return this.store.state.workspaces.find((w) => w.id === workspaceId && w.state !== 'archived')
  }

  /** O2: a repository's provider, and what the Git panel says about its host (GitLab, or a GitLab-looking host not set up). */
  private async scmFor(repoId: string): Promise<{ provider: ScmProvider; info?: GitStatus['scm'] }> {
    const provider = await this.scm.forRepo(repoId)
    if (provider.kind === 'gitlab' && provider.host) {
      return { provider, info: { kind: 'gitlab', host: provider.host.host, tokenSaved: Boolean(this.secrets.appSecret(gitlabTokenKey(provider.host.host))) } }
    }
    const hint = looksLikeGitlab(await this.workspaces.remoteUrl(repoId).catch(() => null), this.store.state.settings.gitlabHosts ?? [])
    return { provider, info: hint ? { kind: 'unknown-gitlab', host: hint } : undefined }
  }

  /** O2: the API for a GitLab host Foreman knows (gitlab.com or one added in Settings), with its saved token. */
  private gitlabApi(hostOrUrl: string, token?: string): GitlabApi {
    const want = normalizeGitlabHost(hostOrUrl)
    const known = gitlabHosts(this.store.state.settings.gitlabHosts ?? []).find((h) => h.host === want.host)
    if (!known && token === undefined) throw new Error(`${want.host} isn’t set up in Foreman. Add it in Settings → Git → Accounts.`)
    return new GitlabApi(known ?? want, token ?? this.secrets.appSecret(gitlabTokenKey(want.host)))
  }

  /** O2: an issue, PR or MR link, read through the right host. */
  private resolveLink(repoId: string, url: string) {
    const link = findScmLink(url)
    if (link?.gitlabHost) {
      const api = this.gitlabApi(link.gitlabHost)
      // G2: a link into a GitLab under a relative URL root carries the root in its path.
      return resolveGitlabLink(this.workspaces.repo(repoId).rootPath, { ...link, repo: projectOnHost(link.repo, api.host) }, api)
    }
    return resolveGithubLink(this.workspaces.repo(repoId).rootPath, url, ghAs(this.workspaces.accountFor(repoId)))
  }

  /** O2: Settings → Git → Accounts' rows: gitlab.com, then each added host, and the repositories on each. */
  private async gitlabHostRows(): Promise<GitlabHostRow[]> {
    const configured = this.store.state.settings.gitlabHosts ?? []
    const urls = await Promise.all(this.store.state.repos.map(async (r) => ({ name: r.name, url: await this.workspaces.remoteUrl(r.id).catch(() => null) })))
    return gitlabHosts(configured).map((h, i) => ({
      host: h.host,
      url: h.url,
      selfManaged: i > 0,
      tokenSaved: Boolean(this.secrets.appSecret(gitlabTokenKey(h.host))),
      repos: urls.filter((r) => { const t = scmForRemote(r.url, configured); return t.kind === 'gitlab' && t.host.host === h.host }).map((r) => r.name)
    }))
  }

  /** O2: test a token against its host, and only then save it (adding a self-managed host to Settings). */
  private async saveGitlabToken(url: string, token: string): Promise<GitlabConnection> {
    const { host, result } = await probeGitlab(normalizeGitlabHost(url), token.trim())
    if (!result.ok) return result
    this.secrets.setAppSecret(gitlabTokenKey(host.host), token.trim())
    const configured = this.store.state.settings.gitlabHosts ?? []
    const known = gitlabHosts(configured).find((h) => h.host === host.host)
    // G2: a host saved again under another relative URL root replaces its entry (one GitLab per host).
    if (!known || (known.url !== host.url && host.host !== 'gitlab.com')) {
      const others = configured.filter((entry) => { try { return normalizeGitlabHost(entry).host !== host.host } catch { return true } })
      this.store.state.settings.gitlabHosts = [...others, host.url]
      this.store.save()
      this.broadcastState()
    }
    this.scm.forget()
    this.prs.resume()
    return result
  }

  /** Remember the PR a lookup found (or that there is none) so Home rows can say "PR #42". */
  private notePullRequest(workspaceId: string, result: PrResult): void {
    const ws = this.store.state.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    // Slack rules see every answered lookup (they keep their own baselines).
    if (this.slack.hasRules() && (result.kind === 'ok' || result.kind === 'no-pr')) {
      void this.slack.prObserved(ws, result.kind === 'ok' ? result.pr : null, result.kind === 'ok' ? result.headRefOid : undefined, !ws.prInfo && !ws.pullRequest && Date.parse(ws.createdAt) >= this.startedAt).catch(() => undefined)
    }
    // #21: also the checks, review and conflicts the board's Ready to merge reads, with when; a failed read marks them unknown.
    const next = nextPrInfo(ws.prInfo, result, Date.now())
    if (next === ws.prInfo) return
    const merged = mergedNow(ws.prInfo?.state, next?.state)
    if (next) ws.prInfo = next
    else delete ws.prInfo
    this.store.save()
    this.broadcastState()
    // Archive on merge: merged here, on GitHub or on GitLab, it's archived once nothing runs in it.
    const settings = this.workspaces.settingsFor(ws.repoId)
    if (merged && next && ws.state === 'ready' && settings.archiveOnMerge) {
      this.autoArchive.request(ws.id, { reason: { kind: 'merged', number: next.number }, deleteBranch: settings.deleteBranchOnArchive })
    }
  }

  /** Rules watch a repository's PRs even when no workspace or CI/review watch is open. */
  private async pollSlackRepositories(): Promise<void> {
    if (!this.slack.hasRules()) return
    for (const repo of this.store.state.repos) {
      const slack = this.integrations.resolve(repo.id, 'slack')
      if (slack.state !== 'ready' || repo.integrations?.rules === 'off') continue
      if (!this.integrations.state().rules.some((r) => r.enabled && r.connectionId === slack.connection.id && (r.repos === 'all' || r.repos.includes(repo.id)) && !r.event.startsWith('agent-'))) continue
      try {
        const target = await this.scm.target(repo.id)
        if (target.kind !== 'github') continue
        const slug = githubSlug(await this.workspaces.remoteUrl(repo.id) ?? '')
        if (!slug) continue
        const account = this.workspaces.accountFor(repo.id)
        const login = await githubLogin(account)
        if (!login) continue
        const identity = this.scm.identity(repo.id)
        const raw = await ghAs(account)(repo.rootPath, ['pr', 'list', '--repo', slug, '--author', login, '--state', 'open', '--limit', '50', '--json', 'number'])
        const listed = JSON.parse(raw) as { number: number }[]
        const numbers = new Set([...listed.map((p) => p.number), ...this.slack.trackedPrs(repo.id)])
        const initialized = this.slackRepoBaselines.has(repo.id)
        const provider = await this.scm.forRepo(repo.id)
        for (const number of numbers) {
          const ws = { id: '', repoId: repo.id, name: repo.name, path: repo.rootPath, branch: '', pullRequest: { repo: slug, number } } as Workspace
          const result = await provider.pullRequest(ws)
          if (this.scm.identity(repo.id) !== identity) break
          if (result.kind === 'ok') await this.slack.prObserved(ws, result.pr, result.headRefOid, initialized)
        }
        this.slackRepoBaselines.add(repo.id)
      } catch {
        // Offline or signed out: leave the baseline unchanged and try on the next poll.
      }
    }
  }

  /** Environment and binary for talking to an agent outside a chat. */
  private agentOptions(agent: AgentKind) {
    return { cwd: os.homedir(), env: this.environment.forAgent(agent), executablePath: executablePathFor(this.store.state.settings, agent) }
  }

  private keepAwake = new KeepAwake(
    (on) => this.host.keepAwake(on),
    () => this.host.power?.() ?? { onBattery: null, thermal: null }
  )
  // Re-checks power every minute while keep-awake is on (O17).
  private powerTimer: ReturnType<typeof setInterval> | null = null
  // Workspace id → the first message to send once it's ready.
  private firstMessages = new Map<string, FirstMessage>()
  // Pasted files waiting for a workspace that is still being made (the new-workspace dialog).
  private stagingDir = path.join(os.tmpdir(), 'foreman-staged')
  // O21: folders named on a launch's command line that the window hasn't asked for yet.
  private launchFolders: string[] = []

  /** Folders from a launch's command line (dropped on the app's icon): held for the window, which is told. Adds nothing. */
  addLaunchFolders(paths: string[]): void {
    const fresh = paths.filter((p) => !this.launchFolders.includes(p))
    if (!fresh.length) return
    this.launchFolders.push(...fresh)
    this.host.broadcast({ type: 'launch-folders' })
  }

  /**
   * Send a first message, telling the chat which template it came from (so the answer can offer its follow-up).
   * Imported issue/PR text goes as a file next to the message, never into its instructions.
   */
  private sendTemplated(message: FirstMessage) {
    const { sessionId, text, templateId, intake, files } = message
    if (!intake && !files?.length) return templateId ? this.sessions.send(sessionId, text, { templateId }) : this.sessions.send(sessionId, text)
    return this.attachFirst(sessionId, intake, files).then(async (attachments) => {
      const sent = await this.sessions.send(sessionId, text, { ...(templateId ? { templateId } : {}), attachments })
      this.dropStaged(files)
      return sent
    })
  }

  private async attachFirst(sessionId: string, intake?: IntakeFile, files: string[] = []) {
    const session = this.store.state.sessions.find((s) => s.id === sessionId)
    const ws = session && this.store.state.workspaces.find((w) => w.id === session.workspaceId)
    if (!ws) return []
    // A cloud workspace's go into its sandbox (the message wakes it anyway).
    const at = workspaceTarget(ws, { wake: true })
    const attachments = intake ? [await attachFromData(at, intake.name, Buffer.from(intake.content, 'utf8').toString('base64'))] : []
    for (const file of files) {
      // A file moved or deleted since it was chosen is left out rather than holding up the message.
      const added = await attachFromPath(at, file).catch(() => null)
      if (added) attachments.push(added)
    }
    return attachments
  }

  /** Staged copies are removed once they are in the workspace; files chosen from disk are the user's and stay. */
  private dropStaged(files: string[] = []): void {
    for (const file of files) {
      const dir = path.dirname(file)
      if (path.dirname(dir) === this.stagingDir) void rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private sendFirstMessages(): void {
    // #1: a new workspace's first message waits while Foreman quits once the running turns finish.
    if (this.stopSafely?.isDraining) return
    for (const [workspaceId, message] of this.firstMessages) {
      const ws = this.store.state.workspaces.find((w) => w.id === workspaceId)
      if (!ws || ws.state === 'error' || ws.state === 'archived') this.firstMessages.delete(workspaceId)
      else if (ws.state === 'ready') {
        this.firstMessages.delete(workspaceId)
        void this.sendTemplated(message).catch(() => undefined)
      } else if (ws.state === 'setup-failed') {
        // Setup failed: keep the message, unsent, until the user says to start anyway.
        this.firstMessages.delete(workspaceId)
        ws.heldMessage = { ...message, at: new Date().toISOString() }
        this.store.save()
      }
    }
    for (const ws of this.store.state.workspaces) {
      if (!ws.heldMessage) continue
      if (ws.state === 'ready') {
        // Setup passed on a re-run: the held message goes out as first intended.
        const held = ws.heldMessage
        delete ws.heldMessage
        this.store.save()
        void this.sendTemplated(held).catch(() => undefined)
      } else if (ws.state === 'error' || ws.state === 'archived') {
        delete ws.heldMessage
        this.store.save()
      }
    }
  }

  /** "Start anyway": send the message held back by a failed setup. */
  async startHeldMessage(workspaceId: string): Promise<void> {
    const ws = this.workspaces.workspace(workspaceId)
    const held = ws.heldMessage
    if (!held) return
    delete ws.heldMessage
    this.changed()
    try {
      await this.sendTemplated(held)
    } catch (err) {
      ws.heldMessage = held
      this.changed()
      throw err
    }
  }

  /** Why a workspace can't be bundled or frozen right now, or null. */
  private busyReason(id: string): string | null {
    if (this.sessions.isRunning(id) || this.store.state.sessions.some((s) => s.workspaceId === id && (s.status !== 'idle' || s.queue.length))) return 'a tab is working'
    if (this.checks.isRunning(id)) return 'checks are running'
    if (this.ptys.hasScripts(id)) return 'a run script is running'
    return null
  }

  // ---- hand off to another Mac (P-4) ----

  private transferLocal(): TransferLocal {
    const { store } = this
    return {
      workspace: (id) => this.workspaces.workspace(id),
      setTransfer: (id, transfer) => {
        const ws = this.workspaces.workspace(id)
        if (transfer) ws.transfer = transfer
        else delete ws.transfer
        store.save()
      },
      evidence: async (id) => {
        const repo = this.workspaces.repo(this.workspaces.workspace(id).repoId)
        return { name: repo.name, defaultBranch: repo.defaultBranch, ...(await repoEvidence(repo.rootPath, repo.remote || 'origin')) }
      },
      hasClaude: (id) => store.state.sessions.some((s) => s.workspaceId === id && s.agent === 'claude'),
      busy: (id) => this.busyReason(id),
      exportBackup: async (id, passphrase, outPath) => {
        await this.portability.exportWorkspace(id, { mode: 'backup', passphrase, includeWorktree: true, outPath })
      },
      findRepo: async (evidence) => store.state.repos.find((r) => repoReasons(evidence, r).length > 0)?.id,
      validate: async (hasClaude) => {
        const problems: string[] = []
        const version = /(\d+)\.(\d+)/.exec((await git(os.homedir(), ['--version'], { allowFail: true }).catch(() => ({ stdout: '' }))).stdout)
        if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 30)) problems.push('git 2.30 or newer is needed on this Mac.')
        if (hasClaude) {
          const status = await driverFor('claude').status(this.environment.forAgent('claude'), store.state.settings.claudeExecutablePath || undefined).catch(() => null)
          if (!status?.ready) problems.push('Claude isn’t signed in on this Mac, and this workspace has Claude chats.')
        }
        return problems
      },
      stage: async (file, passphrase) => {
        const staged = await this.portability.stage(file, passphrase)
        if (staged.kind !== 'staged') throw new Error('The file could not be opened.')
        const { preview } = staged
        const repo = preview.suggested[0]
        try {
          if (!repo) throw new Error(`No repository here matches “${preview.repo.name}”.`)
          // Claude chats resume natively where the file carries the whole transcript; the rest continue fresh.
          const tabs = Object.fromEntries(preview.tabs.map((t) => [t.sessionId, t.nativeResume ? ('native' as const) : ('fresh' as const)]))
          const ws = await this.portability.importStaged(preview.stageId, { repoId: repo.repoId, tabs })
          return { workspaceId: ws.id }
        } catch (err) {
          await this.portability.discard(preview.stageId).catch(() => undefined)
          throw err
        }
      },
      activate: async (id) => {
        await this.portability.activate(id)
        await this.portability.restored(id)
      },
      discard: async (id) => {
        const ws = this.workspaces.workspace(id)
        // Only ever a copy that arrived by hand-off and was never activated.
        if (ws.transfer?.state !== 'staged' || ws.state !== 'history') throw new Error('Only a staged hand-off can be discarded.')
        for (const s of store.state.sessions.filter((x) => x.workspaceId === id)) store.deleteChat(s.id)
        store.state.workspaces = store.state.workspaces.filter((w) => w.id !== id)
        store.state.sessions = store.state.sessions.filter((s) => s.workspaceId !== id)
        store.state.comments = store.state.comments.filter((c) => c.workspaceId !== id)
        await rm(this.portability.importedDir(id), { recursive: true, force: true })
        this.changed()
      },
      notice: async (id, text) => {
        for (const s of store.state.sessions.filter((x) => x.workspaceId === id && !x.closedAt)) {
          const item = { kind: 'notice' as const, id: `handoff:${randomUUID()}`, level: 'info' as const, text }
          await store.appendChat(s.id, item)
          this.host.broadcast({ type: 'chat-item', sessionId: s.id, item })
        }
      }
    }
  }

  /** Listen for hand-offs, or not, as the setting says; always while a pairing code is showing. */
  async applyDeviceListening(): Promise<void> {
    const { acceptHandOffs, devicePort } = this.store.state.settings
    if (acceptHandOffs || this.devices.pairingHost()) {
      try {
        await this.net.listen(devicePort)
      } catch (err) {
        if (acceptHandOffs) throw new Error(`Couldn’t listen on port ${devicePort}: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
    } else await this.net.close()
  }

  private devicesInfo(): DevicesInfo {
    const { settings } = this.store.state
    return this.devices.info(settings.acceptHandOffs, settings.devicePort)
  }

  // ---- scheduled templates (R-5) ----

  /** What a schedule's fingerprint covers, as it stands now. */
  private scheduleInputs(schedule: { templateId: string; templateName: string; repoId: string }): FingerprintInputs | { error: string } {
    const repo = this.store.state.repos.find((r) => r.id === schedule.repoId)
    if (!repo) return { error: 'the repository was removed' }
    const template = this.workspaces.template(schedule.templateId)
    if (!template) return { error: `the template “${schedule.templateName}” no longer exists` }
    const settings = this.workspaces.settingsFor(repo.id)
    const layer = readSharedLayer(repo.rootPath)
    return {
      templateBody: template.body,
      templateRev: template.rev,
      setupScript: settings.setupScript,
      checks: settings.checks.map((c) => ({ name: c.name, command: c.command })),
      mcp: [
        ...(layer.mcp ?? []).map((server) => mcpFingerprint(server, scriptFiles(server, repo.rootPath))),
        // Integrations: the Linear account and access a run's agent would get. Changing either pauses the schedule.
        ...this.integrationFingerprint(repo.id)
      ]
    }
  }

  /** What agents in a repository get from Integrations, for schedule fingerprints ([] when nothing, so older schedules stay approved). */
  private integrationFingerprint(repoId: string): string[] {
    return this.integrations.fingerprints(repoId)
  }

  private inputsOrThrow(scheduleId: string): FingerprintInputs {
    const schedule = this.schedules.schedule(scheduleId)
    const inputs = this.scheduleInputs(schedule)
    if ('error' in inputs) throw new Error(`Can't approve: ${inputs.error}.`)
    return inputs
  }

  /** The template and the fingerprint inputs a schedule request would be approved on, or the error saving it gives. */
  private checkedScheduleInputs(input: ScheduleInput): { template: PromptTemplate; inputs: FingerprintInputs } {
    const template = this.workspaces.template(input.templateId)
    if (!template) throw new Error('That template no longer exists.')
    if (templatePlaceholders(template.body).length) throw new Error('This template has {{placeholders}} to fill in each time. A scheduled run can’t ask, so write them out first.')
    if (!template.body.trim()) throw new Error('This template is empty.')
    this.workspaces.repo(input.repoId)
    const inputs = this.scheduleInputs({ ...input })
    if ('error' in inputs) throw new Error(inputs.error)
    return { template, inputs }
  }

  /** Schedule… → Approve schedule. Saving is the approval of the template and repo as they are now (and, with `shown`, of exactly what the caller showed). */
  private saveSchedule(input: ScheduleInput, id?: string, shown?: ScheduleFingerprint): Schedule {
    const { template, inputs } = this.checkedScheduleInputs(input)
    assertFingerprintShown(shown, fingerprintOf(inputs))
    if (id) return this.schedules.update(id, input, inputs)
    const created = this.schedules.create({ ...input, templateName: template.name }, inputs)
    // Get started: a schedule created.
    this.recordMilestone('automation')
    return created
  }

  /** What saving `input` would approve now: the fingerprint, and what it stands for in words (the Schedule dialog and `foreman schedules preview`). */
  private scheduleFingerprintView(input: ScheduleInput): ScheduleFingerprintView {
    const problem = scheduleProblem(input)
    if (problem) throw new Error(problem)
    const { template, inputs } = this.checkedScheduleInputs(input)
    const repo = this.workspaces.repo(input.repoId)
    const own = this.integrations.repoChoices(repo.id)?.allowOwnMcp
    return {
      fingerprint: fingerprintOf(inputs),
      summary: {
        templateName: template.name,
        ...(template.rev ? { templateRev: template.rev } : {}),
        templateSource: template.source === 'repo' ? 'repo' : 'personal',
        repoName: repo.name,
        baseBranch: input.baseBranch.trim(),
        setupScript: inputs.setupScript,
        checks: inputs.checks,
        mcpServers: (readSharedLayer(repo.rootPath).mcp ?? []).map((server) => server.name),
        integrations: [
          ...(['github', 'linear', 'slack'] as const).flatMap((service) => {
            const r = this.integrations.resolve(repo.id, service)
            if (r.state === 'broken') return [`${service}: unavailable`]
            if (r.state !== 'ready') return []
            return [`${service}: ${r.connection.name}${service === 'linear' ? ` (${r.connection.agentAccess})` : ''}`]
          }),
          ...(own?.length ? [`your own ${[...own].sort().join(', ')} servers stay on`] : [])
        ]
      }
    }
  }

  /**
   * One scheduled run: a fresh workspace made the way `foreman run` makes one, its first chat unattended.
   * Resolves once the first turn has started; its end comes back through the session events.
   */
  private async launchScheduled(schedule: Schedule, occurrence: Occurrence, handle: LaunchHandle): Promise<void> {
    const template = this.workspaces.template(schedule.templateId)
    if (!template) throw new Error(`The template “${schedule.templateName}” no longer exists.`)
    const ws = await this.createFromOptions(
      schedule.repoId,
      {
        prompt: template.body.trim(),
        templateId: template.id,
        baseBranch: schedule.baseBranch,
        branch: { kind: 'new' },
        loadout: { agent: 'claude', model: schedule.model, fast: false }
      },
      { scheduled: { scheduleId: schedule.id, occurrenceId: occurrence.id }, onChat: (workspaceId, sessionId) => handle.created(workspaceId, sessionId) }
    )
    const setup = await this.setupOutcome(ws.id, schedule.maxMinutes * 60_000)
    if (setup.failed || setup.held) throw new Error(`Setup failed, so the prompt was held back and nothing ran.${setup.logTail ? `\n${setup.logTail}` : ''}`)
    if (!(await this.firstTurn(ws.id))) throw new Error('The first turn did not start.')
  }

  /** Wait for a new workspace's setup to settle. `held` is set when setup failed with a message held back. */
  async setupOutcome(workspaceId: string, timeoutMs = 30 * 60_000): Promise<{ failed: boolean; held: boolean; logTail: string }> {
    const deadline = Date.now() + timeoutMs
    const find = () => this.store.state.workspaces.find((w) => w.id === workspaceId)
    while (['creating', 'setting-up'].includes(find()?.state ?? '') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
    // The held message is recorded just after the state changes.
    await new Promise((r) => setTimeout(r, 0))
    const ws = find()
    const failed = ws?.state === 'setup-failed'
    const log = failed ? await this.workspaces.setupLog(workspaceId).catch(() => '') : ''
    return { failed, held: Boolean(ws?.heldMessage), logTail: tailLines(log, 20) }
  }

  /** The chat and turn that a new workspace's first message started, once it has (give up after `timeoutMs`). */
  async firstTurn(workspaceId: string, timeoutMs = 15_000): Promise<{ session: string; turn: string } | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const first = this.store.state.sessions.find((s) => s.workspaceId === workspaceId)
      // A turn waiting for an agent slot counts: its id is known, and `foreman wait` (or a scheduled run) follows it.
      const turn = first?.turnId ?? first?.lastTurn?.turnId ?? (first?.waitingForSlot ? first.queue[0]?.turnId : undefined)
      if (first && turn) return { session: first.id, turn }
      if (Date.now() >= deadline) return undefined
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  /**
   * G3 · #13: "Fork into a new workspace" from an archived chat. A new workspace in the same repository, from the
   * same base branch, whose first tab shows the chat's history and carries it as text with its first message (like
   * a fork of an agent that can't branch natively). The archived workspace's files aren't brought back: it starts
   * from the base branch, and the notice says so. Nothing is sent.
   */
  private async forkArchivedChat(sessionId: string): Promise<Workspace> {
    const source = this.store.state.sessions.find((s) => s.id === sessionId)
    const from = source && this.store.state.workspaces.find((w) => w.id === source.workspaceId)
    if (!source || !from) throw new Error('Chat not found')
    if (from.state !== 'archived') throw new Error('Only a chat in an archived workspace forks into a new workspace')
    const items = await this.store.readChat(sessionId)
    if (!items.some((i) => i.kind === 'user')) throw new Error('This chat has no messages to carry')
    const ws = await this.createFromOptions(from.repoId, {
      baseBranch: from.baseBranch,
      loadout: { agent: source.agent, model: source.model, effort: source.effort, fast: Boolean(source.fastMode) }
    })
    const chat = this.store.state.sessions.find((s) => s.workspaceId === ws.id)
    if (chat) await this.sessions.seedFromArchive(chat.id, source, from.name, items)
    return ws
  }

  /** Compare's "Archive others": stops running tabs, and fails (deleting nothing) if the work can't be saved (#1). */
  private async archiveNow(id: string, deleteBranch: boolean): Promise<void> {
    const outcome = await this.stopSafely.archive(id, deleteBranch, { stopTabs: true })
    if (!outcome.ok) throw new Error(`${this.workspaces.workspace(id).name}: ${outcome.step === 'checkpoint' ? 'could not save the uncommitted changes' : 'the archive script failed'} (${outcome.detail}). Nothing was deleted.`)
  }

  /**
   * Remembers that a Get started milestone was reached (the first time stands) and tells the window.
   * Never throws: a milestone must not hold up the action that caused it.
   */
  private recordMilestone(id: OnboardingMilestone): void {
    try {
      const settings = this.store.state.settings
      const before = settings.onboarding ?? defaultOnboarding()
      const onboarding = withMilestone(before, id, new Date().toISOString())
      if (onboarding === before) return
      this.store.state.settings = { ...settings, onboarding }
      this.store.save()
      this.broadcastState()
    } catch {
      // Not worth a failure: the checklist just doesn't tick.
    }
  }

  private startChat(workspaceId: string, prompt?: string, loadout?: Loadout, templateId?: string, intake?: IntakeFile, internal?: InternalStart, files?: string[]): string {
    // An explicit model wins; otherwise the template's start model, which only ever applies to a chat started here.
    const template = this.workspaces.template(templateId)
    // Get started: a workspace started from a template (a scheduled run is not the person trying one).
    if (template && !internal?.scheduled) this.recordMilestone('template')
    const chosen = chooseStartLoadout(loadout, template).loadout
    const session = this.sessions.createSession(workspaceId, {
      ...(chosen ? { agent: chosen.agent, model: chosen.model, effort: chosen.effort, fastMode: chosen.fast } : {}),
      // A scheduled run never starts in plan mode: nobody is there to review a plan.
      ...(internal?.scheduled ? { planMode: false } : {})
    })
    // Marked before the first message can go, so the run is unattended from its first tool call.
    if (internal?.scheduled) session.unattended = { occurrenceId: internal.scheduled.occurrenceId }
    internal?.onChat?.(workspaceId, session.id)
    if (prompt?.trim() || files?.length) {
      this.firstMessages.set(workspaceId, { sessionId: session.id, text: prompt?.trim() ?? '', templateId, intake, ...(files?.length ? { files } : {}) })
      this.sendFirstMessages()
    }
    return session.id
  }

  /** The one way a workspace and its first chat are made: the app, `foreman run` and schedules all come here. */
  private async createFromOptions(repoId: string, options?: CreateWorkspaceOptions, internal?: InternalStart): Promise<Workspace> {
    if (options?.prompt && !options.githubUrl && !options.linearIssue) {
      const ref = findLinearLink(options.prompt, { bareIds: this.integrations.resolve(repoId, 'linear').state === 'ready' })
      if (ref) options = { ...options, linearIssue: ref.url ?? ref.identifier }
    }
    if (options?.branch?.kind === 'direct' && this.spotlight.workspaceFor(repoId)) throw new Error('Turn off spotlight testing before working in the repository folder')
    let create = options
    let intake: IntakeFile | undefined
    if (options?.githubUrl) {
      const info = await this.resolveLink(repoId, options.githubUrl)
      intake = intakeFile(info)
      // Only a new branch can be the PR's head; other modes just get its text.
      if (info.kind === 'pr' && (!options.branch || options.branch.kind === 'new')) {
        if (info.problem) throw new Error(info.problem)
        create = {
          ...options,
          branch: options.branch ?? { kind: 'new' },
          baseBranch: options.baseBranch?.trim() || info.baseRef,
          pullRequest: { repo: info.repo, number: info.number, ...(info.gitlabHost ? { gitlabHost: info.gitlabHost } : {}) }
        }
      }
    }
    if (options?.linearIssue) {
      const found = await this.fetchLinearIssue(repoId, options.linearIssue)
      if ('problem' in found) throw new Error(found.problem)
      const file = linearIntakeFile(found.issue)
      intake = { name: file.name, content: file.text }
      // A new branch without a name takes Linear's, so Linear's GitHub integration links the PR.
      if (!create?.branch || (create.branch.kind === 'new' && !create.branch.name)) create = { ...create, branch: { kind: 'new', name: found.branch } }
    }
    const ws = await this.workspaces.createWorkspace(repoId, create)
    if (internal?.scheduled) {
      ws.scheduled = internal.scheduled
      this.store.save()
    }
    this.startChat(ws.id, options?.prompt, options?.loadout, options?.templateId, intake, internal, options?.attachments)
    return ws
  }

  /**
   * "Keep the computer awake while agents run": on while any chat is working,
   * unless a battery, heat or on-power cutoff applies (O17). True when the status changed.
   */
  private updateKeepAwake(): boolean {
    const { settings, sessions } = this.store.state
    const agents = sessions.filter((s) => s.status === 'running').length
    const changed = this.keepAwake.update(agents, settings)
    // G4 O17: say so once when a cutoff starts letting the computer sleep while agents run.
    const cutoff = this.keepAwake.takeCutoffNotice()
    if (cutoff) {
      const t = mainT(settings)
      const { title, body } = keepAwakeCutoffNotice(cutoff, agents, settings, t)
      this.host.broadcast({ type: 'notify', workspaceId: '', sessionId: '', title, body, action: 'keep-awake', kind: 'info' })
    }
    // Power can change with nothing else happening, so look again every minute while the setting is on.
    if (settings.keepAwake && !this.powerTimer) {
      this.powerTimer = setInterval(() => this.powerChanged(), 60_000)
      this.powerTimer.unref?.()
    } else if (!settings.keepAwake && this.powerTimer) {
      clearInterval(this.powerTimer)
      this.powerTimer = null
    }
    return changed
  }

  /** Power source, battery level or thermal state moved: decide again, and tell the window if that changed anything. */
  powerChanged(): void {
    if (this.updateKeepAwake()) this.broadcastState()
  }

  /**
   * The OS started or stopped reporting a screen reader, or a window gained focus (the flag can be stale then): tell
   * the window when the flag differs from what it last heard, so terminals set to Automatic follow. Coming back to the
   * window is also when repository files edited outside Foreman should show, so those are looked at again now, and
   * when a gh auth switch run elsewhere should: gh is asked again in the background when a connection follows it.
   */
  screenReaderChanged(): void {
    this.revalidateRepoFiles()
    if (this.integrations.ghAccountsInUse().active) refreshGhActiveAccount(GH_ACTIVE_FOCUS_MIN_AGE_MS)
    const last = this.lastState
    if (!last || this.statePending) return this.broadcastState()
    const screenReader = this.host.screenReader?.() ?? false
    if (screenReader !== last.screenReader || JSON.stringify(this.repoFiles(REPO_FILES_MAX_AGE_MS)) !== JSON.stringify(repoFilesOf(last))) this.broadcastState()
  }

  /** Tell the window the state changed. `checks`: a service's change, which runs flushState's checks first. */
  private broadcastState(checks = false): void {
    if (checks) this.stateChecks = true
    if (this.statePending) return
    this.statePending = true
    queueMicrotask(() => this.flushState())
  }

  /** Send a coalesced state broadcast now, if one is waiting (it otherwise goes at the end of the current tick). */
  flushState(): void {
    if (!this.statePending) return
    this.statePending = false
    const checks = this.stateChecks
    this.stateChecks = false
    try {
      if (checks) {
        this.sendFirstMessages()
        // #1: "Quit when turns finish" quits once the last turn or check run has ended.
        this.stopSafely?.check()
        // Before the broadcast, so the snapshot carries the fresh keep-awake status.
        this.updateKeepAwake()
      }
      const snapshot = this.snapshot({ maxAgeMs: REPO_FILES_MAX_AGE_MS })
      // The store's records change in place, so only a copy shows what the window last heard: the snapshot as text
      // (it is JSON-shaped, and copied whole for the window anyway). The same text again sends nothing.
      const text = stateText(snapshot)
      if (text !== undefined && text === this.lastStateText) {
        this.attention?.schedule()
        return
      }
      this.host.broadcast({ type: 'state', snapshot })
      this.lastStateText = text
    } catch (err) {
      // In a microtask there's no caller to throw to; the next change sends the state again.
      console.error('Could not send the state to the window:', err)
    }
  }

  /** Foreman wrote a repository file, or the window came back: the snapshot's next disk reads go to the disk. */
  private revalidateRepoFiles(): void {
    revalidateRepoTemplates()
    revalidateSharedLayers()
    this.recentChecks.clear()
  }

  /** Recent repository folders not added now, up to five, that still exist (an answer reused while under `maxAgeMs` old). */
  private recentRepos(maxAgeMs: number): string[] {
    const { repos, recentRepoPaths } = this.store.state
    const added = new Set(repos.map((r) => path.resolve(r.rootPath)))
    const now = Date.now()
    const out: string[] = []
    for (const p of recentRepoPaths) {
      if (out.length >= 5) break
      if (added.has(path.resolve(p))) continue
      let check = this.recentChecks.get(p)
      if (!check || now - check.at < 0 || now - check.at >= maxAgeMs) {
        check = { at: now, exists: existsSync(p) }
        this.recentChecks.set(p, check)
      }
      if (check.exists) out.push(p)
    }
    return out
  }

  /** What the snapshot reads from repositories' folders, reusing answers under `maxAgeMs` old (0: all fresh). */
  private repoFiles(maxAgeMs: number): RepoFiles {
    const { repos, settings } = this.store.state
    const options = { maxAgeMs }
    return {
      repoSettings: Object.fromEntries(repos.map((r) => [r.id, resolveRepoSettings(r, settings, options)])),
      repoTemplates: Object.fromEntries(repos.map((r) => [r.id, readRepoTemplates(r.id, r.rootPath, options)])),
      repoCommands: Object.fromEntries(repos.map((r) => [r.id, repoCommands(this.store.state, r, options)])),
      recentRepos: this.recentRepos(maxAgeMs)
    }
  }

  /** Apply settings that live outside the renderer (at startup and on change). */
  applySettings(): void {
    const { settings } = this.store.state
    // A new token ends any pause after an auth failure.
    if (useGithubToken(settings.githubAuth === 'token' ? this.secrets.appSecret('GH_TOKEN') : undefined)) this.prs.resume()
    this.host.setZoom(settings.zoom)
    this.powerChanged()
  }

  private scopeOf(scope: EnvScope): EnvScope {
    if (scope.kind === 'repo') this.workspaces.repo(scope.repoId)
    return scope
  }

  /**
   * Terminal and run-script environment for a workspace: the same GitHub identity agents get. A chosen
   * connection that can't be used (or a signed-out gh account) gives none, never gh's active account.
   */
  private terminalEnv(ws: Workspace): Record<string, string> {
    const key = this.workspaces.accountFor(ws.repoId)
    const github = githubEnvOrNone(key)
    if (key?.startsWith('env:')) delete github.GH_TOKEN
    return { ...this.workspaces.scriptEnv(ws), ...github }
  }

  /**
   * Phase 4: a cloud workspace's terminal tab, run script, snippet or saved command, as a PTY in its sandbox. The
   * environment is the sandbox's own plus the workspace's script variables and the GitHub token a local terminal
   * would have (as this PTY's env only, so `git push` works); never this computer's, never the Vercel token.
   */
  private spawnCloudTerminal(ws: Workspace, cols: number, rows: number, kind: string, command: string | undefined, options: { cwd?: string } | undefined): string {
    const cloud = ws.cloud!
    // The same token the workspace's turns and git actions use in the sandbox.
    const token = this.cloudGithubToken(ws.repoId)
    const env = { ...this.workspaces.scriptEnv(ws), ...(token ? { GH_TOKEN: token } : {}) }
    const runnable = ws.state === 'ready' || ws.state === 'setup-failed'
    if (kind === 'snippet') {
      if (!runnable) throw new Error('The workspace is not ready to run commands')
      if (!command?.trim()) throw new Error('The shell snippet is empty')
      return this.ptys.spawnCloud(ws, cols, rows, { cwd: cloud.cwd, env, script: command, snippet: true })
    }
    if (kind === 'run') {
      const settings = this.workspaces.settingsFor(ws.repoId)
      const chosen = command ? settings.runScripts.find((s) => s.name === command) : settings.runScripts.find((s) => s.default)
      const script = chosen?.command.trim()
      if (!script) throw new Error('Add a run script in the repository settings first')
      // Exclusive run mode stops the repository's other run scripts, local or cloud.
      if (settings.runMode === 'exclusive') this.ptys.killScripts(this.store.state.workspaces.filter((w) => w.repoId === ws.repoId && w.id !== ws.id).map((w) => w.id))
      return this.ptys.spawnCloud(ws, cols, rows, { cwd: cloud.cwd, env, script })
    }
    if (kind === 'saved') {
      if (!runnable) throw new Error('The workspace is not ready to run commands')
      const repo = this.workspaces.repo(ws.repoId)
      const saved = runnableCommand(this.store.state.settings.savedCommands ?? [], repoCommands(this.store.state, repo), repo.id, command ?? '')
      // The folder is checked to stay in the worktree here, then joined the sandbox's (POSIX) way.
      const launch = commandLaunch(saved, { name: ws.name, path: cloud.cwd }, mainT(this.store.state.settings), () => true)
      const cwd = saved.cwd ? path.posix.join(cloud.cwd, saved.cwd) : cloud.cwd
      return this.ptys.spawnCloud(ws, cols, rows, { cwd, env, notice: launch.notice, input: commandInputWithStatus(saved.command, 'posix') })
    }
    if (kind !== 'shell') throw new Error('Unknown terminal')
    // G3 · O3: a restored tab's shell starts where the old one last was, when that is inside the sandbox's worktree.
    return this.ptys.spawnCloud(ws, cols, rows, { cwd: cloudTerminalFolder(options?.cwd, cloud.cwd) ?? cloud.cwd, env })
  }

  /** Env file paths are stored relative to the repo, or with ~ for home, when possible. */
  private tidyEnvFile(scope: EnvScope, file: string): string {
    const trimmed = file.trim()
    if (!path.isAbsolute(trimmed)) return trimmed
    if (scope.kind === 'repo') {
      const root = this.workspaces.repo(scope.repoId).rootPath
      const rel = path.relative(root, trimmed)
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel
    }
    const home = os.homedir()
    const fromHome = path.relative(home, trimmed)
    if (!fromHome.startsWith('..') && !path.isAbsolute(fromHome)) return `~/${fromHome.split(path.sep).join('/')}`
    return trimmed
  }

  private changed(): void {
    this.store.save()
    this.broadcastState()
  }

  /** Recompute a workspace's line totals for the sidebar. Failures leave the old value. */
  /** O5: the workspace's pull request as reviewers see it (its base, the branch as pushed), or null without one. */
  private async prTarget(ws: Workspace): Promise<PrTarget | null> {
    const status = await this.git.status(ws.id).catch(() => null)
    if (!status?.pr) return null
    const remote = this.workspaces.repo(ws.repoId).remote
    return {
      number: status.pr.number,
      ...(status.pr.provider ? { provider: status.pr.provider } : {}),
      baseRef: await baseStartPoint(workspaceTarget(ws), status.pr.baseRefName, remote),
      headRef: status.upstream ?? `${remote}/${ws.branch}`
    }
  }

  /** #2: look again whether `foreman` is installed, for which commands "Teach agents Foreman" may mention. */
  async refreshCliInstalled(): Promise<void> {
    this.cliInstalled = await cliStatus({ shim: this.host.cliShim() }).then(
      (s) => s.installed,
      () => false
    )
  }

  /** `since`: a snapshot of the working tree started then or later still holds (see sharedWorkingTree). */
  async refreshDiffStat(workspaceId: string, since?: number): Promise<void> {
    const ws = this.store.state.workspaces.find((w) => w.id === workspaceId)
    if (!ws || !['ready', 'setting-up', 'setup-failed'].includes(ws.state)) return
    try {
      // One snapshot of the working tree serves all three (after a turn, the one its end checkpoint just took).
      const tree = await sharedWorkingTree(workspaceTarget(ws), since)
      const stat = await workspaceDiffStat(ws, tree)
      // Only a change is saved and sent: the same totals again would redraw every window for nothing.
      if (JSON.stringify(stat) !== JSON.stringify(ws.diffStat)) {
        ws.diffStat = stat
        this.store.save()
        this.broadcastState()
      }
      // The tree may have changed under recorded check results.
      await this.checks.refreshStale(workspaceId, tree)
      // #17: and under an auto review's findings.
      await this.autoReview.refreshStale(workspaceId, tree)
    } catch {
      // The worktree may be mid-operation; try again next time.
    }
  }

  /** Bring every workspace's stats up to date after a restart, one at a time. */
  async refreshAllDiffStats(): Promise<void> {
    for (const ws of this.store.state.workspaces) await this.refreshDiffStat(ws.id)
  }

  /** Older workspaces from before chat tabs need at least one open chat. */
  ensureChats(): void {
    for (const ws of this.store.state.workspaces) {
      if (ws.state === 'archived' || ws.state === 'history') continue
      const open = this.store.state.sessions.some((s) => s.workspaceId === ws.id && !s.closedAt)
      if (!open) this.sessions.createSession(ws.id)
    }
  }

  /** The settings as they are now, for the menu and tray, which need nothing else (snapshot() builds far more). */
  settings(): Settings {
    return this.store.state.settings
  }

  /**
   * The state the window shows. Repository files are read fresh unless `maxAgeMs` accepts answers that old (the
   * coalesced broadcasts, which come often while agents work, use REPO_FILES_MAX_AGE_MS).
   */
  snapshot(options: { maxAgeMs?: number } = {}): AppSnapshot {
    const { repos, workspaces, sessions, comments, settings } = this.store.state
    const spotlight = Object.fromEntries(
      repos.map((r) => [r.id, this.spotlight.workspaceFor(r.id)]).filter((e): e is [string, string] => Boolean(e[1]))
    )
    // #22: the Claude, Codex and Cursor keys are each agent's own now.
    const agentKeys = this.agentCatalog?.legacyKeyHints() ?? {}
    return {
      repos,
      workspaces,
      sessions,
      comments,
      settings,
      ...this.repoFiles(options.maxAgeMs ?? 0),
      agentKeys,
      agentKeyHints: this.agentCatalog?.keyHints() ?? {},
      spotlight,
      catalog: this.models.state(),
      transfers: this.transfers.view(),
      pairedDevices: this.devices.list(),
      schedules: this.schedules.schedules,
      occurrences: this.schedules.occurrences,
      platform: process.platform,
      homeDir: os.homedir(),
      screenReader: this.host.screenReader?.() ?? false,
      keepAwake: this.keepAwake.status,
      stopRecord: this.stopSafely?.record(),
      reconnected: this.store.state.reconnected,
      integrations: this.integrations.view(),
      slackAsks: this.slack.asks(),
      appVersion: this.host.appInfo?.().version,
      update: this.updates.view()
    }
  }

  /** Slack rules for an agent's "needs you" and "finished" notifications. */
  private agentSlackEvent(kind: 'attention' | 'finished', workspaceId: string, sessionId: string, body: string): void {
    if (!this.slack.hasRules()) return
    const ws = this.store.state.workspaces.find((w) => w.id === workspaceId)
    const session = this.store.state.sessions.find((x) => x.id === sessionId)
    if (!ws || !session) return
    const turnId = session.turnId ?? session.lastTurn?.turnId ?? `${sessionId}:${Date.now()}`
    const agent = catalogAgent(session.agent)?.name ?? session.agent
    const requestId = kind === 'attention' ? this.sessions.pendingApprovals().filter((r) => r.sessionId === sessionId).at(-1)?.id : undefined
    void this.slack.agentEvent(kind === 'attention' ? 'agent-needs-me' : 'agent-finished', ws, { turnId, agent, reason: body, requestId }).catch(() => undefined)
  }

  /** A Linear issue for a repository, read with its Linear connection (never another account). */
  private async fetchLinearIssue(repoId: string, ref: string): Promise<{ issue: LinearIssue; connection: string; branch: string } | { problem: string }> {
    const link = findLinearLink(ref, { bareIds: true })
    if (!link) return { problem: 'That isn’t a Linear issue link or id (like ENG-123).' }
    const r = this.integrations.resolve(repoId, 'linear')
    if (r.state === 'broken') return { problem: this.integrations.brokenText(repoId, 'linear') }
    if (r.state !== 'ready') return { problem: 'This repository has no Linear connection. Add one in Settings → Integrations.' }
    const c = r.connection
    // A link names its workspace: one from another Linear is read with nothing.
    if (link.orgKey && c.identity?.orgKey && link.orgKey !== c.identity.orgKey) {
      const other = this.integrations.state().connections.find((x) => x.service === 'linear' && x.identity?.orgKey === link.orgKey)
      return { problem: `${link.identifier} is in ${other ? other.name : `the ${link.orgKey} Linear workspace`}, but this repository uses ${c.name}. Foreman won’t read it with another account.` }
    }
    const token = this.integrations.secret(c.id)
    if (!token) return { problem: `${c.name}’s key is missing. Replace it in Settings → Integrations.` }
    let issue: LinearIssue | null
    try {
      issue = await linearIssue(token, link.identifier)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/refused/i.test(message)) this.integrations.markProblem(c.id, message)
      return { problem: message }
    }
    if (!issue) return { problem: `${link.identifier} isn’t in ${c.name}.` }
    const { settings } = this.store.state
    const prefix = await branchPrefix(settings.branchPrefixType, settings.branchPrefix, this.workspaces.accountFor(repoId)).catch(() => '')
    return { issue, connection: c.name, branch: linearBranch(prefix, issue) }
  }

  private slackToken(connectionId: string): string {
    const c = this.integrations.connection(connectionId)
    if (!c || c.service !== 'slack') throw new Error('That Slack connection no longer exists')
    const token = this.integrations.secret(connectionId)
    if (!token) throw new Error('This Slack connection has no token. Replace it in Settings → Integrations.')
    return token
  }

  private loginCommand(name: string): string {
    const { settings } = this.store.state
    if (name === 'claude-login' || name === 'claude-mcp' || name === 'claude-setup-token') {
      const claude = settings.claudeExecutablePath || bundledClaudeExecutable() || 'claude'
      if (name === 'claude-setup-token') return `${shellQuote(claude)} setup-token`
      return name === 'claude-mcp' ? `${shellQuote(claude)} /mcp` : `${shellQuote(claude)} auth login`
    }
    if (name === 'gh-login') return 'gh auth login'
    const codex = settings.codexExecutablePath || 'codex'
    return `${shellQuote(codex)} login`
  }

  readonly api: Api = {
    getSnapshot: async () => this.snapshot(),
    pickDirectory: () => this.host.pickDirectory(),
    pickFiles: () => this.host.pickFiles(),
    pickPath: (options) => this.host.pickPath(options),
    addRepo: (path) => this.workspaces.addRepo(path),
    cloneRepo: async (url, parentDir, cloneId, account) => {
      const dir = await cloneRepo(url, parentDir, (line) => this.host.broadcast({ type: 'clone-progress', cloneId, line }), account)
      this.store.state.settings.cloneDirectory = parentDir
      return this.workspaces.addRepo(dir, account)
    },
    githubRepos: async (account) => {
      const protocol = await gitProtocol()
      try {
        return { repos: await githubRepos(account), protocol }
      } catch (err) {
        return { repos: [], protocol, error: err instanceof Error ? err.message : String(err) }
      }
    },
    quickStartRepo: async (parentDir, name) => {
      const dir = await quickStart(parentDir, name)
      this.store.state.settings.cloneDirectory = parentDir
      return this.workspaces.addRepo(dir)
    },
    makeRepo: async (dir, identity) => {
      const made = await makeRepository(dir, identity)
      if (made.status === 'needs-identity') return { ok: false, reason: 'needs-identity' }
      return { ok: true, repo: await this.workspaces.addRepo(made.dir) }
    },
    forgetRecentRepo: async (repoPath) => {
      this.store.state.recentRepoPaths = this.store.state.recentRepoPaths.filter((p) => p !== repoPath)
      this.changed()
    },
    classifyFolders: (paths) => classifyFolders(paths, this.store.state.repos, this.store.state.settings.workspacesRoot),
    takeLaunchFolders: async () => this.launchFolders.splice(0),
    updateRepo: async (id, patch) => this.workspaces.updateRepo(id, patch),
    removeRepo: async (id) => {
      if (this.store.state.workspaces.some((w) => w.repoId === id && this.sessions.isRunning(w.id))) {
        throw new Error('Stop the agents in this repository first')
      }
      for (const ws of this.store.state.workspaces.filter((w) => w.repoId === id)) {
        this.ptys.killWorkspace(ws.id)
        this.terminals.forget(ws.id)
        if (this.spotlight.isActive(ws.id)) await this.spotlight.stop(this.workspaces.repo(id))
      }
      await this.workspaces.removeRepo(id)
      this.secrets.forgetRepo(id)
    },
    updateRepoSettings: async (repoId, patch) => {
      const result = await this.workspaces.updateRepoSettings(repoId, patch)
      // Opting in takes the first look right away.
      if (patch.warnBaseMoved) void this.baseWatch.poll(repoId)
      // Get started: agents allowed to start workspaces and queue messages (the MCP delegation opt-in).
      if (patch.agentsMayStart === true) this.recordMilestone('mcp')
      return result
    },
    listBranches: (repoId, options) => this.workspaces.listBranches(repoId, options),
    listRemotes: async (repoId) => {
      const out = await git(this.workspaces.repo(repoId).rootPath, ['remote'], { allowFail: true })
      return out.stdout.split('\n').map((r) => r.trim()).filter(Boolean)
    },
    previewFilesToCopy: (repoId, patterns) => this.workspaces.previewFilesToCopy(repoId, patterns),
    detectRepoIcon: async (repoId) => {
      const root = this.workspaces.repo(repoId).rootPath
      for (const rel of FAVICON_PATHS) {
        const file = path.join(root, rel)
        try {
          if (statSync(file).size > 1_000_000) continue
          const type = IMAGE_TYPES[path.extname(file).toLowerCase()]
          return `data:${type};base64,${readFileSync(file).toString('base64')}`
        } catch {
          // Not there; try the next spot.
        }
      }
      return null
    },
    openRepoSettingsFile: async (repoId) => {
      const repo = this.workspaces.repo(repoId)
      const inUse = this.workspaces.resolvedSettings(repoId).sharedFile
      const file = inUse ?? path.join(repo.rootPath, '.foreman', 'settings.toml')
      if (!existsSync(file)) {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, SETTINGS_TEMPLATE)
        this.revalidateRepoFiles()
        this.broadcastState()
      }
      await this.openInEditor(file)
    },

    envView: async (scope) => this.environment.view(this.scopeOf(scope)),
    setEnvVars: async (scope, changes) => {
      const target = this.scopeOf(scope)
      const writes: [string, string | null][] = []
      for (const change of changes) {
        if (!ENV_NAME.test(change.key)) throw new Error(`Invalid variable name: ${change.key}`)
        if (change.previousKey && change.previousKey !== change.key) writes.push([change.previousKey, null])
        writes.push([change.key, change.value])
      }
      this.secrets.setMany(target, writes)
      this.broadcastState()
      const keys = new Set(writes.map(([key]) => key))
      const stale = new Set<AgentKind>()
      if (keys.has('ANTHROPIC_API_KEY') || keys.has('ANTHROPIC_AUTH_TOKEN')) stale.add('claude')
      if (keys.has('CODEX_API_KEY') || keys.has('OPENAI_BASE_URL')) stale.add('codex')
      if (keys.has('CURSOR_API_KEY')) stale.add('cursor')
      if (stale.size && target.kind === 'user') void this.models.refreshAll([...stale])
    },
    revealEnvVar: async (scope, key, layer) => this.environment.reveal(this.scopeOf(scope), key, layer) ?? null,
    setEnvFiles: async (scope, files) => {
      const target = this.scopeOf(scope)
      const tidy = [...new Set(files.map((f) => this.tidyEnvFile(target, f)).filter(Boolean))]
      if (target.kind === 'user') {
        this.store.state.settings.envFiles = tidy
        this.changed()
      } else {
        this.workspaces.updateRepoSettings(target.repoId, { envFiles: tidy.length ? tidy : null })
      }
    },
    // #22: into the agent's own key now, still never replacing a saved one.
    importKeyFromShell: async (name: AgentKeyName) => this.agentCatalog.importKey(LEGACY_AGENT_KEYS.find((k) => k.envVar === name)?.agent ?? ''),
    opencodeProviders: async () => {
      const saved = this.secrets.providerKeys()
      return PROVIDER_KEYS.map((p) => ({ envVar: p.envVar, saved: Boolean(saved[p.envVar]), detected: Boolean(process.env[p.envVar]) }))
    },
    setProviderKey: async (envVar, value) => {
      if (!ENV_NAME.test(envVar)) throw new Error(`Invalid variable name: ${envVar}`)
      this.secrets.setProviderKey(envVar, value)
      void this.models.refresh('opencode')
    },

    githubAccounts: async () => {
      // Fresh tokens too: the user may have just signed in or out.
      forgetAccountTokens()
      return githubAccounts()
    },
    detectRepoAccount: (repoId, save) => this.workspaces.detectRepoAccount(repoId, save),
    remoteUrl: (repoId) => this.workspaces.remoteUrl(repoId),
    githubStatus: () => githubStatus(this.store.state.settings.githubAuth, Boolean(this.secrets.appSecret('GH_TOKEN'))),

    // ---- Integrations ----
    addConnection: (input) => this.integrations.addConnection(input),
    updateConnection: (id, patch) => this.integrations.updateConnection(id, patch),
    checkConnection: (id) => this.integrations.checkConnection(id),
    connectionRemovalImpact: async (id) => this.integrations.removalImpact(id),
    removeConnection: async (id) => {
      this.slackPeopleCache.delete(id)
      this.integrations.removeConnection(id)
    },
    setIntegrationDefault: async (service, id) => this.integrations.setDefault(service, id),
    repoIntegrations: (repoId) => this.integrations.repoView(repoId),
    setRepoIntegration: async (repoId, service, choice) => this.integrations.setRepoChoice(repoId, service, choice),
    setRepoIntegrationOptions: async (repoId, options) => this.integrations.setRepoOptions(repoId, options),
    applyConnectionToRepos: async (connectionId, repoIds) => this.integrations.applyToRepos(connectionId, repoIds),
    acceptIntegrationSuggestion: async (repoId) => this.integrations.acceptSuggestion(repoId),
    importRepoGithubToken: async (repoId) => {
      const env = this.environment.repoGithubToken(repoId)
      if (!env) return { ok: false, error: 'This repository has no GH_TOKEN of its own.' }
      const added = await this.integrations.addConnection({ service: 'github', auth: { kind: 'token' }, token: env.value, name: `GitHub token from ${path.basename(env.from)}`, allowDuplicate: true })
      if (added.ok) this.integrations.setRepoChoice(repoId, 'github', added.connection.id)
      return added
    },
    integrationActivity: async (repoId) => this.bridge.activity(repoId),
    ghAccountsForIntegrations: async () => {
      forgetAccountTokens()
      const accounts = await githubAccounts().catch(() => [])
      const connections = this.integrations.state().connections
      return accounts.map((a) => ({ login: a.login, active: a.active, connected: connections.some((c) => c.auth.kind === 'gh-account' && c.auth.login === a.login) }))
    },
    slackManifest: async () => ({ url: slackManifestUrl(), json: JSON.stringify(slackManifest(), null, 2) }),
    slackPeople: async (connectionId, query) => {
      const token = this.slackToken(connectionId)
      const q = query.trim().toLowerCase()
      if (q.includes('@') && /^[^\s@]+@[^\s@]+$/.test(q)) {
        const one = await slackUserByEmail(token, q)
        return one ? [one] : []
      }
      let hit = this.slackPeopleCache.get(connectionId)
      if (!hit || Date.now() - hit.at > 10 * 60_000) {
        hit = { at: Date.now(), people: await slackPeople(token) }
        this.slackPeopleCache.set(connectionId, hit)
      }
      return hit.people.filter((p) => !q || p.name.toLowerCase().includes(q) || p.handle.toLowerCase().includes(q) || (p.email ?? '').toLowerCase().includes(q)).slice(0, 20)
    },
    slackChannels: async (connectionId) => slackChannels(this.slackToken(connectionId)),
    saveSlackRule: async (rule) => this.integrations.saveRule(rule),
    consentSlackRule: async (id) => this.integrations.consentRule(id),
    deleteSlackRule: async (id) => this.integrations.deleteRule(id),
    linkPerson: async (link) => this.integrations.linkPerson(link),
    unlinkPerson: async (githubLogin, slackTeamId) => this.integrations.unlinkPerson(githubLogin, slackTeamId),
    slackDeliveries: async (connectionId) => this.slack.list(connectionId),
    answerSlackAsk: (id, action, text) => this.slack.answer(id, action, text),
    resendSlackDelivery: (id) => this.slack.resend(id),
    linearMyIssues: async (repoId) => {
      const r = this.integrations.resolve(repoId, 'linear')
      if (r.state === 'broken') return { error: this.integrations.brokenText(repoId, 'linear') }
      if (r.state !== 'ready') return { error: 'This repository has no Linear connection.' }
      const token = this.integrations.secret(r.connection.id)
      if (!token) return { error: `${r.connection.name}’s key is missing.` }
      try {
        return { issues: await linearMyIssues(token), connection: r.connection.name }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    resolveLinearLink: async (repoId, ref): Promise<LinearLinkInfo> => {
      const found = await this.fetchLinearIssue(repoId, ref)
      if ('problem' in found) return { problem: found.problem }
      const { comments: _comments, ...issue } = found.issue
      return { issue, connection: found.connection, branch: found.branch }
    },
    gitlabHosts: async () => ({ hosts: await this.gitlabHostRows(), glab: await glabInstalled() }),
    testGitlabHost: async (url, token) => {
      try {
        return token?.trim() ? (await probeGitlab(normalizeGitlabHost(url), token.trim())).result : await testConnection(this.gitlabApi(url))
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    saveGitlabToken: async (url, token) => {
      if (token === null) {
        this.secrets.setAppSecret(gitlabTokenKey(normalizeGitlabHost(url).host), null)
        this.scm.forget()
        return null
      }
      if (!token.trim()) throw new Error('Paste a token first')
      return this.saveGitlabToken(url, token)
    },
    removeGitlabHost: async (hostName) => {
      const host = normalizeGitlabHost(hostName)
      this.secrets.setAppSecret(gitlabTokenKey(host.host), null)
      const configured = this.store.state.settings.gitlabHosts ?? []
      const next = configured.filter((entry) => { try { return normalizeGitlabHost(entry).host !== host.host } catch { return false } })
      if (next.length !== configured.length) {
        this.store.state.settings.gitlabHosts = next
        this.store.save()
        this.broadcastState()
      }
      this.scm.forget()
    },
    useGlabToken: async (url) => {
      const host = normalizeGitlabHost(url)
      return this.saveGitlabToken(host.url, await readGlabToken(host.host.replace(/:\d+$/, '')))
    },
    setGithubToken: async (token) => {
      this.secrets.setAppSecret('GH_TOKEN', token)
      this.applySettings()
    },
    whichBinary: async (name) => findOnPath(name),
    fullDiskAccess: async () => {
      if (process.platform !== 'darwin') return null
      try {
        // Readable only by apps with Full Disk Access.
        accessSync(path.join(os.homedir(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'), constants.R_OK)
        return true
      } catch {
        return false
      }
    },
    openFullDiskAccessSettings: async () => {
      if (process.platform !== 'darwin') return
      await this.host.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
    },
    resourceUsage: async () => ({ ...this.host.metrics(), workspaces: await this.processUsage.usage() }),
    cliStatus: async () => {
      const status = await cliStatus({ shim: this.host.cliShim() })
      this.cliInstalled = status.installed
      return status
    },
    installCli: async () => {
      const status = await installCli({ shim: this.host.cliShim(), runAsAdmin: macAdmin })
      this.cliInstalled = status.installed
      return status
    },

    createWorkspace: (repoId, options) => this.createFromOptions(repoId, options),
    mobileInfo: async () => this.requireMobile().info(),
    mobileConfigure: (enabled, url) => this.requireMobile().configure(enabled, url),
    mobileConfigureLan: (enabled, address) => this.requireMobile().configureLan(enabled, address),
    mobileStartPairing: (mode) => this.requireMobile().startPairing(mode),
    mobileApprovePairing: async (id, allow) => this.requireMobile().approve(id, allow),
    mobileRevokeDevice: async (id) => this.requireMobile().revoke(id),
    devicesInfo: async () => this.devicesInfo(),
    setAcceptHandOffs: async (on, port) => {
      const settings = this.store.state.settings
      settings.acceptHandOffs = on
      if (port !== undefined) {
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Pick a port between 1024 and 65535.')
        if (port !== settings.devicePort) await this.net.close()
        settings.devicePort = port
      }
      await this.applyDeviceListening()
      this.changed()
      return this.devicesInfo()
    },
    showPairingCode: async () => {
      this.devices.showCode(this.store.state.settings.devicePort)
      try {
        await this.applyDeviceListening()
      } catch (err) {
        this.devices.cancelCode()
        throw err
      }
      return this.devicesInfo()
    },
    cancelPairingCode: async () => {
      this.devices.cancelCode()
      await this.applyDeviceListening()
    },
    pairWith: async (host, port, code) => {
      if (!/^\d{6}$/.test(code.trim())) throw new Error('The code is 6 digits.')
      const result = await this.net.pairWith(host.trim(), port, code.trim())
      return this.devices.add(result, host.trim(), result.peer.port ?? port)
    },
    unpairDevice: async (id) => this.devices.forget(id),
    pingDevice: async (id) => {
      const state = await this.net.send(id, { type: 'status', transferId: 'ping' }, undefined, { timeoutMs: 4000 }).then(() => true, () => false)
      this.changed()
      return state
    },
    startHandOffTo: (workspaceId, deviceId) => this.transfers.start(workspaceId, deviceId),
    cancelHandOff: async (id) => this.transfers.cancelHandOff(id),
    reconcileHandOff: (id, choice) => this.transfers.reconcile(id, choice),
    saveSchedule: async (input, id, shown) => this.saveSchedule(input, id, shown),
    approveSchedule: async (id, shown) => {
      const inputs = this.inputsOrThrow(id)
      assertFingerprintShown(shown, fingerprintOf(inputs))
      this.schedules.approve(id, inputs)
    },
    scheduleFingerprint: async (input) => this.scheduleFingerprintView(input),
    pauseSchedule: async (id) => this.schedules.pause(id),
    resumeSchedule: async (id) => this.schedules.resume(id),
    deleteSchedule: async (id) => this.schedules.remove(id),
    stopScheduledRun: (occurrenceId) => this.schedules.stopRun(occurrenceId),
    armLimitResume: async (sessionId, turnId) => {
      await this.limitResume.arm(sessionId, turnId)
    },
    cancelLimitResume: async (sessionId) => this.limitResume.cancel(sessionId),
    resumeLimitNow: (sessionId) => this.limitResume.resumeNow(sessionId),
    resolveGithubLink: (repoId, url) => this.resolveLink(repoId, url),
    adoptWorktree: async (repoId, worktreePath, options) => {
      const ws = await this.workspaces.adoptWorktree(repoId, worktreePath, options)
      this.startChat(ws.id, options.prompt, options.loadout, options.templateId, undefined, undefined, options.attachments)
      return ws
    },
    listWorktrees: (repoId) => this.workspaces.listWorktrees(repoId),
    updateWorkspace: async (id, patch) => this.workspaces.updateWorkspace(id, patch),
    archivedWork: async (ids) => Promise.all(ids.map((id) => this.workspaces.archivedWork(id))),
    deleteArchived: async (ids) => {
      for (const id of ids) await this.workspaces.deleteArchived(id)
    },
    keepArchived: async (id, keep) => this.workspaces.keepArchived(id, keep),
    startCompare: (workspaceId, request) => this.compare.start(workspaceId, request),
    archiveCompareOthers: (compareId, keepWorkspaceId) => this.compare.archiveOthers(compareId, keepWorkspaceId),
    archiveWorkspace: (id, deleteBranch, options) => this.stopSafely.archive(id, deleteBranch, options),
    // #1 Stop safely.
    archivePreview: (id) => this.stopSafely.archivePreview(id),
    // O18 Docker cleanup on archive.
    dockerContainers: (workspaceId) => this.workspaces.dockerContainers(workspaceId),
    removeDockerContainers: (workspaceId) => this.workspaces.removeDockerContainers(workspaceId),
    dismissDockerLeft: async (workspaceId) => this.workspaces.dismissDockerLeft(workspaceId),
    // G3 · #13: an archived workspace's kept diff, and a new workspace from one of its chats.
    archivedDiff: (workspaceId) => this.workspaces.archivedDiff(workspaceId),
    forkArchivedChat: (sessionId) => this.forkArchivedChat(sessionId),
    quitPlan: async () => this.stopSafely.plan(),
    quitNow: async () => this.stopSafely.quitNow(),
    quitWhenFinished: async () => this.stopSafely.quitWhenFinished(),
    cancelQuit: async () => this.stopSafely.cancelQuit(),
    quitKeepRunning: () => this.stopSafely.quitKeepRunning(),
    dismissReconnected: async () => this.agentHost.dismissReconnected(),
    checkForUpdates: () => this.updates.check(),
    dismissUpdate: async (skip) => this.updates.dismiss(Boolean(skip)),
    downloadUpdate: () => this.updates.download(),
    stopUpdateDownload: async () => this.updates.stopDownload(),
    installUpdateOnQuit: async (on) => this.updates.installOnQuit(Boolean(on)),
    restartToUpdate: async (whenIdle) => this.restartToUpdate(Boolean(whenIdle)),
    cancelUpdateRestart: async () => {
      if (this.updates.view().notice?.phase.state === 'waiting') this.stopSafely.cancelQuit()
    },
    releaseNotes: (version) => this.updates.notes(String(version)),
    dismissUpdated: async () => this.updates.dismissUpdated(),
    stopReview: () => this.stopSafely.review(),
    retryStopped: (turnId) => this.stopSafely.retry(turnId),
    dismissStopped: async (key) => this.stopSafely.dismiss(key),
    unarchiveWorkspace: async (id) => {
      await this.workspaces.unarchiveWorkspace(id)
      this.ensureChats()
    },
    forgetWorkspace: async (id) => this.workspaces.forgetWorkspace(id),
    activateWorkspace: async (id) => {
      const ws = this.workspaces.workspace(id)
      if (ws.transfer?.state === 'staged') throw new Error('This workspace arrived by hand-off. Use Reconcile on Home to choose which Mac keeps it.')
      await this.portability.activate(id)
    },
    exportInfo: (workspaceId) => this.portability.exportInfo(workspaceId),
    searchChats: async (query, options) => searchChats(this.store, query, options),
    searchNotes: async (query) => searchNotes(this.store, query),
    saveNote: async (workspaceId, text) => this.sessions.setNote(workspaceId, text),
    sendNote: (sessionId) => this.sessions.sendNote(sessionId),
    usageReport: async (days) => this.data.usage(days),
    dataInfo: () => this.data.info(),
    backupNow: () => this.data.backupNow(),
    gitBackupStatus: async () => this.gitBackup.status(),
    configureGitBackup: async (config) => this.gitBackup.configure(config),
    createGitBackupGithubRepo: (name, account) => this.gitBackup.createGithub(name, account),
    gitBackupNow: () => this.gitBackup.backupNow(),
    previewGitBackup: (remoteUrl, account) => this.gitBackup.preview(remoteUrl, account),
    restoreGitBackup: (choice) => this.gitBackup.restore(choice),
    deleteLegacyFiles: () => this.data.deleteLegacy(),
    exportWorkspace: (workspaceId, options) => this.portability.exportWorkspace(workspaceId, options),
    stageImport: (file, passphrase) => this.portability.stage(file, passphrase),
    importStaged: (stageId, choice) => this.portability.importStaged(stageId, choice),
    discardImport: (stageId) => this.portability.discard(stageId),
    getSetupLog: (workspaceId) => this.workspaces.setupLog(workspaceId),
    rerunSetup: (workspaceId) => this.workspaces.rerunSetup(workspaceId),
    retrySetup: (workspaceId) => this.workspaces.retrySetup(workspaceId),
    stopSetup: (workspaceId) => this.workspaces.stopSetup(workspaceId),
    getSetupStepLogs: (workspaceId) => this.workspaces.setupStepLogs(workspaceId),
    startHeldMessage: (workspaceId) => this.startHeldMessage(workspaceId),

    createSession: async (workspaceId, patch) => this.sessions.createSession(workspaceId, patch),
    forkSession: (sessionId, turnId, options) => this.sessions.forkSession(sessionId, turnId, options),
    prepareHandOff: (sourceId, kind) => this.handOffs.prepare(sourceId, kind),
    startHandOff: (sourceId, request) => this.handOffs.start(sourceId, request),
    updateSession: (sessionId, patch) => this.sessions.updateSession(sessionId, patch),
    closeSession: (sessionId) => this.sessions.closeSession(sessionId),
    reopenSession: async (workspaceId, sessionId) => this.sessions.reopenSession(workspaceId, sessionId),
    getChat: (sessionId, live) => this.sessions.getChat(sessionId, live === true),
    sendMessage: (sessionId, text, options) => {
      const sent = this.sessions.send(sessionId, text, options)
      // Get started: a message that carries a template (recorded when it is sent, not when the template is inserted).
      if (options?.templateId) sent.then(() => this.recordMilestone('template'), () => undefined)
      return sent
    },
    removeQueued: async (sessionId, messageId) => this.sessions.removeQueued(sessionId, messageId),
    steerQueued: (sessionId, messageId) => this.sessions.steerQueued(sessionId, messageId),
    editQueued: async (sessionId, messageId, text, revision, attachments) => this.sessions.editQueued(sessionId, messageId, text, revision, attachments),
    moveQueued: async (sessionId, messageId, direction, revision) => this.sessions.moveQueued(sessionId, messageId, direction, revision),
    cancel: (sessionId) => this.sessions.cancel(sessionId),
    pendingApprovals: async () => this.sessions.pendingApprovals(),
    respondApproval: (id, response, via) => {
      // #3: an answer from the window or the phone goes into the history (a cancelled request never comes this way).
      const request = this.sessions.pendingApprovals().find((a) => a.id === id)
      const workspaceId = request && this.store.state.sessions.find((s) => s.id === request.sessionId)?.workspaceId
      if (request && workspaceId) this.attention.record(approvalDraft(request, response, workspaceId, via === 'phone' ? 'phone' : 'window'))
      return this.sessions.respondApproval(id, response)
    },
    attentionHistory: async () => this.attention.history(),
    markAttentionSeen: async () => this.attention.markSeen(),
    refreshPullRequest: (workspaceId) => this.prPoll.refresh(workspaceId),
    restoreCheckpoint: (sessionId, turnId) => this.sessions.restore(sessionId, turnId),
    slashCommands: (sessionId) => this.sessions.slashCommands(sessionId),
    mcpStatus: (sessionId, restart) => this.sessions.mcpStatus(sessionId, restart),
    repoMcp: async (workspaceId) => this.repoMcp.view(workspaceId),
    approveRepoMcp: async (workspaceId, names, shown) => {
      this.repoMcp.approve(workspaceId, names, shown)
      // Get started: a repository MCP server approved.
      if (names.length) this.recordMilestone('mcp')
    },
    reconnectMcpServer: (sessionId, name) => this.sessions.reconnectMcpServer(sessionId, name),

    attachFiles: async (workspaceId, paths) => {
      const ws = this.workspaces.workspace(workspaceId)
      // A cloud workspace's are copied into its sandbox (waking it: a message follows).
      const at = workspaceTarget(ws, { wake: true })
      return Promise.all(paths.slice(0, 10).map((p) => attachFromPath(at, p)))
    },
    attachData: (workspaceId, name, base64) => attachFromData(workspaceTarget(this.workspaces.workspace(workspaceId), { wake: true }), name, base64),
    stageAttachment: (name, base64) => stageAttachment(this.stagingDir, name, base64),
    // Cloud workspaces: @-mentions, search and a diff's surrounding lines read the sandbox; the file browser and editor are local only.
    listFiles: (workspaceId) => listWorkspaceFiles(workspaceTarget(this.workspaces.workspace(workspaceId))),
    readFile: (workspaceId, path) => readWorkspaceFile(workspaceTarget(this.workspaces.workspace(workspaceId)), path),
    listDir: (workspaceId, dir) => listWorkspaceDir(localOnly(this.workspaces.workspace(workspaceId), 'Browsing files'), dir),
    readImage: (workspaceId, path) => readWorkspaceImage(localOnly(this.workspaces.workspace(workspaceId), 'Image previews'), path),
    // #19: a sandboxed HTML/PDF preview's address, and an image as it was at a commit (the diff's before side).
    previewUrl: (workspaceId, path) => this.preview.urlFor(workspaceId, path),
    readImageAt: (workspaceId, path, commit) => readImageAtCommit(localOnly(this.workspaces.workspace(workspaceId), 'Image previews'), path, commit),
    writeFile: async (workspaceId, path, content) => {
      const dir = localOnly(this.workspaces.workspace(workspaceId), 'Editing files')
      await writeWorkspaceFile(dir, path, content)
      noteWorktreeChanged(dir)
      // The file may be a repository's settings.toml or template (a workspace in the repo's own folder).
      this.revalidateRepoFiles()
      void this.refreshDiffStat(workspaceId)
    },
    searchFiles: (workspaceId, query, options) => searchWorkspace(workspaceTarget(this.workspaces.workspace(workspaceId)), query, options),
    getDiff: async (workspaceId, scope, commits) => {
      const ws = this.workspaces.workspace(workspaceId)
      // O5: staged, commits and the PR come from their own ranges, without viewed marks.
      if (scope !== 'all' && scope !== 'uncommitted') return sourceDiff(ws, scope, commits, scope === 'pr' ? await this.prTarget(ws) : null)
      const diff = await workspaceDiff(ws, scope)
      // Marks hold for one version of a file and one branch point; the rest are dropped.
      if (scope === 'all' && !diff.truncated && ws.viewed?.length && diff.mergeBase) {
        const kept = pruneViewed(ws.viewed, diff.files, diff.mergeBase)
        if (kept.length !== ws.viewed.length) {
          ws.viewed = kept.length ? kept : undefined
          this.store.save()
          this.broadcastState()
        }
      }
      if (scope === 'all' && !diff.truncated) {
        const stat = {
          files: diff.files.length,
          additions: diff.files.reduce((n, f) => n + f.additions, 0),
          deletions: diff.files.reduce((n, f) => n + f.deletions, 0)
        }
        if (JSON.stringify(stat) !== JSON.stringify(ws.diffStat)) {
          ws.diffStat = stat
          this.store.save()
          this.broadcastState()
        }
      }
      return diff
    },

    diffSources: async (workspaceId, picked) => {
      const ws = this.workspaces.workspace(workspaceId)
      return sourceInfo(ws, picked, await this.prTarget(ws))
    },
    branchCommits: async (workspaceId) => {
      const ws = this.workspaces.workspace(workspaceId)
      const status = await this.git.status(workspaceId).catch(() => null)
      const list = await branchCommits(ws, status?.upstream ?? `${this.workspaces.repo(ws.repoId).remote}/${ws.branch}`)
      // A tab's name only when Foreman saw that tab's tool call print the commit; otherwise the git author.
      const tabs = this.store.state.sessions.filter((s) => s.workspaceId === ws.id)
      const made = await this.commitTabs.attribute(ws.id, tabs, list.commits.map((c) => c.sha))
      for (const commit of list.commits) {
        const tab = tabs.find((s) => s.id === made.get(commit.sha))
        if (tab) commit.tab = { sessionId: tab.id, title: tab.title ?? '' }
      }
      return list
    },
    branchCommitCount: async (workspaceId) => branchCommitCount(this.workspaces.workspace(workspaceId)),

    getAlertDiff: async (workspaceId, alertId) => {
      const ws = this.workspaces.workspace(workspaceId)
      const alert = ws.alerts?.find((a) => a.id === alertId)
      if (!alert || alert.unavailable) throw new Error('Comparison unavailable for this turn')
      return refsDiff(workspaceTarget(ws), alert.startRef, alert.endRef, alert.files)
    },
    // O6: a file as the alert's end checkpoint has it, for the unchanged lines between its hunks.
    alertFile: async (workspaceId, alertId, file) => {
      const ws = this.workspaces.workspace(workspaceId)
      const alert = ws.alerts?.find((a) => a.id === alertId)
      if (!alert || alert.unavailable || !alert.files.includes(file)) throw new Error('Comparison unavailable for this turn')
      return fileAtRef(workspaceTarget(ws), alert.endRef, file)
    },
    workspaceUsage: (workspaceId) => this.sessions.workspaceUsage(workspaceId),
    setFileViewed: async (workspaceId, mark, viewed) => {
      const ws = this.workspaces.workspace(workspaceId)
      const marks = withMark(ws.viewed, mark, viewed)
      ws.viewed = marks.length ? marks : undefined
      this.store.save()
      this.broadcastState()
    },
    dismissAlert: async (workspaceId, alertId) => {
      const ws = this.workspaces.workspace(workspaceId)
      ws.alerts = ws.alerts?.filter((a) => a.id !== alertId)
      if (!ws.alerts?.length) delete ws.alerts
      this.store.save()
      this.broadcastState()
    },
    closeAgentReport: async (workspaceId, reportId, how) => this.agentReports.close(workspaceId, reportId, how),

    revertFile: async (workspaceId, path) => {
      const ws = this.workspaces.workspace(workspaceId)
      await revertFile(ws, path)
      void this.refreshDiffStat(workspaceId)
    },

    setSpotlight: async (workspaceId, on) => {
      const ws = this.workspaces.workspace(workspaceId)
      const repo = this.workspaces.repo(ws.repoId)
      const direct = on && this.workspaces.directWorkspace(repo.id)
      if (direct) {
        throw new Error(direct.id === ws.id ? 'This workspace already runs in the repository folder' : `${direct.name} works in the repository folder; archive it to use spotlight testing`)
      }
      if (on) await this.spotlight.start(repo, ws)
      else if (this.spotlight.workspaceFor(repo.id) === ws.id) await this.spotlight.stop(repo)
    },
    openPreview: async (workspaceId, index = 0) => {
      const ws = this.workspaces.workspace(workspaceId)
      const urls = this.workspaces.settingsFor(ws.repoId).previewUrls
      const url = expandPorts(urls[index]?.url || urls[0]?.url || 'http://localhost:$FOREMAN_PORT', ws.portBase)
      if (!/^https?:\/\//i.test(url)) throw new Error(`Preview URLs must start with http:// or https:// (got ${url})`)
      if (ws.cloud && !urls[index]?.url && !urls[0]?.url) throw new Error('Configure a sandbox preview URL first')
      this.host.broadcast({ type: 'browser-open', workspaceId, url: browserUrl(url) })
    },

    probePreview: async (workspaceId, scriptName) => {
      const ws = this.workspaces.workspace(workspaceId)
      const script = this.workspaces.settingsFor(ws.repoId).runScripts.find((r) => r.name === scriptName)
      if (!script?.previewUrl?.trim()) throw new Error(`Run script “${scriptName}” has no preview URL`)
      return probePreview(expandPorts(script.previewUrl.trim(), ws.portBase))
    },

    gitStatus: (workspaceId) => this.git.status(workspaceId),
    // The Git panel asks right after the diff it shows changed the totals: that diff's snapshot serves.
    checksStatus: (workspaceId) => this.checks.status(workspaceId, { since: Date.now() - VIEW_REUSE_MS }),
    runChecks: async (workspaceId, approve) => {
      const start = await this.checks.start(workspaceId, { approve })
      if (start.kind === 'consent') return { started: false, consent: start.items }
      // Progress and the result arrive through state events.
      void start.done.catch(() => undefined)
      return { started: true }
    },
    cancelChecks: (workspaceId) => this.checks.cancel(workspaceId),
    fixChecks: (workspaceId, sessionId) => this.git.fixChecks(workspaceId, this.checks.failing(workspaceId), sessionId),
    reviewThreads: async (workspaceId) => {
      const ws = this.workspaces.workspace(workspaceId)
      const pr = (await this.git.status(workspaceId)).pr
      if (!pr) throw new Error('No pull request found for this workspace')
      const threads = await (await this.scm.forRepo(ws.repoId)).reviewThreads(ws, pr)
      // Opening the list is looking at what's new.
      this.prWatch.ackReviews(workspaceId)
      return threads
    },
    sendReviewThreads: async (workspaceId, ids, sessionId) => {
      if (!ids.length) throw new Error('Select at least one review thread')
      const ws = this.workspaces.workspace(workspaceId)
      const pr = (await this.git.status(workspaceId)).pr
      if (!pr) throw new Error('No pull request found for this workspace')
      const threads = (await (await this.scm.forRepo(ws.repoId)).reviewThreads(ws, pr)).filter((t) => ids.includes(t.id) && !t.isResolved)
      if (threads.length !== new Set(ids).size) throw new Error('Some threads have changed or been resolved. Refresh the reviews and select them again.')
      const open = this.store.state.sessions.filter((s) => s.workspaceId === workspaceId && !s.closedAt)
      const session = sessionId ? open.find((s) => s.id === sessionId) : open[0] ?? this.sessions.createSession(workspaceId)
      if (!session) throw new Error('The selected chat is no longer open')
      const gitlab = pr.provider === 'gitlab'
      const content = reviewThreadsMarkdown(pr, threads)
      const attachment = await attachFromData(workspaceTarget(ws, { wake: true }), `${gitlab ? 'MR' : 'PR'} ${pr.number} review threads.md`, Buffer.from(content).toString('base64'))
      await this.sessions.send(session.id, `Address the selected ${gitlab ? 'GitLab' : 'GitHub'} review threads in the attached file. Check each suggestion against the current code and explain any you disagree with.`, { mode: 'queue', attachments: [attachment] })
      this.prWatch.ackReviews(workspaceId)
      return session.id
    },
    setPrWatch: async (workspaceId, kind, on) => {
      this.prWatch.setWatch(workspaceId, kind, on)
    },
    fixCi: async (workspaceId, sessionId) => {
      const open = this.store.state.sessions.filter((s) => s.workspaceId === workspaceId && !s.closedAt)
      const fresh = sessionId === 'new' || !open.length
      const target = fresh ? this.sessions.createSession(workspaceId) : (open.find((s) => s.id === sessionId) ?? open[0])
      try {
        await this.git.run(workspaceId, 'fix-errors', target.id)
      } catch (err) {
        // Don't leave an empty tab behind when there was nothing to send.
        if (fresh) await this.sessions.closeSession(target.id).catch(() => undefined)
        throw err
      }
      this.prWatch.ackCi(workspaceId)
      return target.id
    },
    resolveBaseMoved: async (workspaceId, sessionId) => {
      const open = this.store.state.sessions.filter((s) => s.workspaceId === workspaceId && !s.closedAt)
      const fresh = sessionId === 'new' || !open.length
      const target = fresh ? this.sessions.createSession(workspaceId) : (open.find((s) => s.id === sessionId) ?? open[0])
      try {
        await this.git.run(workspaceId, 'resolve-conflicts', target.id)
      } catch (err) {
        if (fresh) await this.sessions.closeSession(target.id).catch(() => undefined)
        throw err
      }
      this.baseWatch.ack(workspaceId)
      return target.id
    },
    baseWatchSupport: async () => this.baseWatch.support(),
    ackCiFailure: async (workspaceId) => this.prWatch.ackCi(workspaceId),
    autoFixPreview: async (workspaceId, sessionId) => this.autoFix.preview(workspaceId, sessionId),
    setAutoFix: async (workspaceId, consent) => {
      if (!consent) return this.autoFix.disable(workspaceId)
      this.autoFix.enable(workspaceId, consent)
      // Auto-fix acts on the CI watch, so approving it turns that on for this PR too.
      if (!this.workspaces.workspace(workspaceId).prWatch?.ci) this.prWatch.setWatch(workspaceId, 'ci', true)
      else void this.prWatch.poll(workspaceId)
    },
    autoReviewPreview: async (repoId, choice) => this.autoReview.preview(repoId, choice),
    setAutoReview: async (repoId, shown) => (shown ? this.autoReview.enable(repoId, shown) : this.autoReview.disable(repoId)),
    sendAutoReviewFindings: (workspaceId, reviewId, findingIds, sessionId) => this.autoReview.sendFindings(workspaceId, reviewId, findingIds, sessionId),
    dismissAutoReview: async (workspaceId, reviewId) => this.autoReview.dismiss(workspaceId, reviewId),
    gitAction: async (workspaceId, action, sessionId) => {
      const receipt = await this.git.run(workspaceId, action, sessionId)
      if (action === 'fix-errors') this.prWatch.ackCi(workspaceId)
      void this.refreshDiffStat(workspaceId)
      return receipt
    },
    addComment: async (workspaceId, file, line, body, selection) => {
      if (!body.trim()) return
      this.store.state.comments.push({
        id: randomUUID(),
        workspaceId,
        file,
        line,
        body: body.trim(),
        author: 'user',
        state: 'pending',
        createdAt: new Date().toISOString(),
        // #15: a plain comment on selected lines quotes them (it still goes with the next message).
        ...(selection ? { selection } : {})
      })
      this.changed()
    },
    sendDiffSelection: (workspaceId, draft, sessionId) => this.diffSelections.send(workspaceId, draft, sessionId),
    resendDiffSelection: (commentId, how, sessionId) => this.diffSelections.resend(commentId, how, sessionId),
    updateComment: async (id, patch) => {
      const comment = this.store.state.comments.find((c) => c.id === id)
      if (!comment) return
      if (patch.body !== undefined) comment.body = patch.body
      if (patch.state !== undefined) comment.state = patch.state
      this.changed()
    },
    deleteComment: async (id) => {
      this.store.state.comments = this.store.state.comments.filter((c) => c.id !== id)
      this.changed()
    },

    ptySpawn: async (workspaceId, cols, rows, kind, command, options) => {
      // Sign-in commands can run outside any workspace (from Settings).
      // Sign-in commands run in the user's own shell environment.
      // #22: a Terminal agent in its worktree, or a catalog agent's own sign-in.
      if (kind === 'agent') {
        // Phase 4 brings shells, scripts and snippets to the sandbox; a Terminal agent still needs a folder here.
        if (this.store.state.workspaces.find((w) => w.id === workspaceId)?.cloud) throw new Error(mainT(this.store.state.settings)('cloud.terminal.agentNotInCloud'))
        return this.terminalAgents.start(workspaceId, command ?? '', cols, rows)
      }
      if (kind === 'command' && command?.startsWith('login:')) {
        const agent = command.slice('login:'.length)
        return this.ptys.spawn('', os.homedir(), this.environment.forCatalogAgent(agent), cols, rows, catalogLoginCommand(agent, executablePathFor(this.store.state.settings, agent)))
      }
      if (kind === 'command') {
        if (!command || !(LOGIN_COMMANDS as readonly string[]).includes(command)) throw new Error('Unknown command')
        const cwd = (workspaceId ? this.workspaces.workspace(workspaceId).path : undefined) ?? os.homedir()
        return this.ptys.spawn(workspaceId, cwd, agentBaseEnv(), cols, rows, this.loginCommand(command))
      }
      const ws = this.workspaces.workspace(workspaceId)
      // A frozen workspace runs no scripts or snippets (a plain shell stays the user's own).
      if (kind === 'snippet' || kind === 'run' || kind === 'saved') {
        const frozen = frozenReason(ws)
        if (frozen) throw new Error(frozen)
      }
      // Phase 4: a cloud workspace's shells, run scripts, snippets and saved commands run in its sandbox.
      if (ws.cloud) return this.spawnCloudTerminal(ws, cols, rows, kind, command, options)
      // Terminals get the user's own environment plus Settings → Environment.
      const env = this.terminalEnv(ws)
      if (kind === 'snippet') {
        if (ws.state !== 'ready' && ws.state !== 'setup-failed') throw new Error('The workspace is not ready to run commands')
        if (!command?.trim()) throw new Error('The shell snippet is empty')
        return this.ptys.spawn(workspaceId, wsPath(ws), env, cols, rows, command, true)
      }
      if (kind === 'run') {
        const repo = this.workspaces.repo(ws.repoId)
        const settings = this.workspaces.settingsFor(repo.id)
        const chosen = command ? settings.runScripts.find((s) => s.name === command) : settings.runScripts.find((s) => s.default)
        const script = chosen?.command.trim()
        if (!script) throw new Error('Add a run script in the repository settings first')
        if (settings.runMode === 'exclusive') {
          const others = this.store.state.workspaces.filter((w) => w.repoId === repo.id && w.id !== ws.id).map((w) => w.id)
          this.ptys.killScripts(others)
        }
        // With spotlight on, the run script runs from the repository's main folder.
        const cwd = this.spotlight.workspaceFor(repo.id) === ws.id ? repo.rootPath : wsPath(ws)
        return this.ptys.spawn(workspaceId, cwd, env, cols, rows, script)
      }
      if (kind === 'saved') {
        // O9: like a snippet, it runs something, so a frozen or unready workspace doesn't start it.
        if (ws.state !== 'ready' && ws.state !== 'setup-failed') throw new Error('The workspace is not ready to run commands')
        const saved = this.savedCommandShell(ws, command ?? '')
        return this.ptys.spawn(workspaceId, saved.cwd, env, cols, rows, undefined, false, saved.shell)
      }
      // G3 · O3: a restored tab's new shell starts where the old one last was, if that folder still exists.
      const cwd = (kind === 'shell' ? existingFolder(options?.cwd) : undefined) ?? wsPath(ws)
      return this.ptys.spawn(workspaceId, cwd, env, cols, rows, undefined, false, this.terminalShell(cwd, command))
    },
    savedCommandConsent: async (workspaceId, id) => {
      const command = this.savedCommand(this.workspaces.workspace(workspaceId), id)
      return needsApproval(command) ? consentItem(this.store.state, command) : null
    },
    approveSavedCommand: async (workspaceId, id, text) => {
      const command = this.savedCommand(this.workspaces.workspace(workspaceId), id)
      if (command.source !== 'repo') return
      // The repo's file changed while the dialog was open: approve only what was shown.
      if (command.command !== text) throw new Error(`“${command.name}” changed in the repo’s settings while you were looking. Run it again to see the new text.`)
      approveCommand(this.store.state, command)
      this.store.save()
      this.changed()
    },
    detectShells: async () => {
      const probe = realProbe()
      const custom = this.store.state.settings.terminalShellCustom
      const wslExe = detectShells(probe, custom).paths.wsl
      return detectShells(probe, custom, wslExe ? await listWslDistros(wslExe) : { distros: [] })
    },
    savedTerminals: async (workspaceId) => (this.terminalWorkspace(workspaceId) ? this.terminals.get(workspaceId) : null),

    agentStatus: async (agent) => {
      return driverFor(agent).status(this.environment.forAgent(agent), executablePathFor(this.store.state.settings, agent))
    },
    // #22
    agentCatalog: (refresh) => this.agentCatalog.view(Boolean(refresh)),
    setAgentKey: async (agent, value) => this.agentCatalog.setKey(agent, value),
    revealAgentKey: async (agent) => this.agentCatalog.revealKey(agent),
    importAgentKey: async (agent) => this.agentCatalog.importKey(agent),
    agentSignInStatus: (agent) => this.agentCatalog.signInStatus(agent),
    importProviderKey: async (envVar) => this.agentCatalog.importProviderKey(envVar),
    revealProviderKey: async (envVar) => this.agentCatalog.revealProviderKey(envVar),
    terminalAgentRuns: async () => this.terminalAgents.runs(),
    reportDiagnostics: () => {
      const app = this.host.appInfo?.() ?? { version: process.env.npm_package_version ?? 'unknown', packaged: false, appPath: process.cwd() }
      return collectDiagnostics({ ...app, agentStatus: (agent) => this.api.agentStatus(agent) })
    },
    refreshModels: async (agent) => {
      await (agent ? this.models.refresh(agent) : this.models.refreshAll())
    },
    openPath: (path) => this.host.openPath(path),
    openInEditor: (path) => this.openInEditor(path),
    openInApps: (refresh) => this.openIn.apps(Boolean(refresh)),
    openInIcons: () => this.openIn.icons(),
    openIn: async (app, target) => {
      if (app !== null && !isOpenInChoice(app)) throw new Error('Unknown app')
      if (!target || !path.isAbsolute(target.folder) || (target.file !== undefined && !path.isAbsolute(target.file))) throw new Error('Open needs a full path')
      const line = Number.isInteger(target.line) && target.line! > 0 ? target.line : undefined
      await this.openIn.open(app, { folder: target.folder, ...(target.file ? { file: target.file } : {}), ...(line ? { line } : {}) })
    },
    openExternal: async (url) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened')
      await this.host.openExternal(url)
    },

    assistantState: (refresh) => this.assistant.state(Boolean(refresh)),
    assistantItems: async (threadId) => this.assistant.items(threadId),
    assistantSend: (threadId, text, useAlternative, context) => {
      const sent = this.assistant.send(threadId, text, Boolean(useAlternative), context ? { context } : {})
      // Get started: an assistant message sent.
      sent.then(() => this.recordMilestone('assistant'), () => undefined)
      return sent
    },
    assistantCancel: (threadId) => this.assistant.cancel(threadId),
    assistantDeleteThread: (threadId) => this.assistant.deleteThread(threadId),
    assistantClearHistory: () => this.assistant.clearHistory(),
    assistantConfirmRun: (threadId, runId) => this.assistant.confirmRun(threadId, runId),
    assistantCancelRun: (threadId, runId) => this.assistant.cancelRun(threadId, runId),

    // Phase G2: speech to text. Audio is 16 kHz mono signed 16-bit little-endian PCM; nothing is stored.
    sttStart: async (options) => {
      const language = options?.language
      if (language !== undefined && !(typeof language === 'string' && STT_LANGUAGE.test(language))) throw new Error('Dictation language must be a language code such as en')
      return this.speech.start({ ...(language !== undefined ? { language } : {}) })
    },
    sttAudio: async (sessionId, pcm) => {
      if (typeof sessionId !== 'string') throw new Error('Unknown dictation')
      this.speech.audio(sessionId, pcm)
    },
    sttStop: async (sessionId) => {
      if (typeof sessionId !== 'string') throw new Error('Unknown dictation')
      return this.speech.stop(sessionId)
    },
    sttCancel: async (sessionId) => {
      if (typeof sessionId !== 'string') throw new Error('Unknown dictation')
      this.speech.cancel(sessionId)
    },
    sttModelStatus: async () => this.speech.modelStatus(),
    sttDownloadModel: () => this.speech.downloadModel(),

    // Cloud workspaces.
    cloudBuildBase: async (repoId) => {
      const { build, done } = this.sandboxes.startBuild(repoId)
      // The outcome is on the repository (and in cloud-build-log events), not in this answer.
      void done.catch(() => undefined)
      return build
    },
    cloudWake: (workspaceId) => this.sandboxes.wake(this.workspaces.workspace(workspaceId)),
    cloudSleep: (workspaceId) => this.sandboxes.sleep(this.workspaces.workspace(workspaceId)),
    cloudRestart: (workspaceId) => this.sandboxes.restart(this.workspaces.workspace(workspaceId)),
    cloudStatus: (workspaceId) => this.sandboxes.refreshStatus(this.workspaces.workspace(workspaceId)),
    cloudUsage: async () => this.sandboxes.usageViews(),

    // ---- cloud workspaces, phase 1b: Claude's setup token for sandboxes, in the agent vault (never in the snapshot) ----
    cloudSetClaudeToken: async (token) => {
      const value = token?.trim() || null
      if (value && (value.length < 20 || /\s/.test(value))) throw new Error('That doesn’t look like a token from claude setup-token')
      this.secrets.setAgentKey('claude', CLAUDE_SETUP_TOKEN_KEY, value)
      this.secrets.setAgentKey('claude', CLAUDE_SETUP_TOKEN_SAVED_AT_KEY, value ? new Date().toISOString() : null)
    },
    cloudClaudeToken: async () => {
      const value = this.secrets.agentKey('claude', CLAUDE_SETUP_TOKEN_KEY)
      if (!value) return null
      return { hint: value.length >= 12 ? value.slice(-4) : '', savedAt: this.secrets.agentKey('claude', CLAUDE_SETUP_TOKEN_SAVED_AT_KEY) }
    },

    // ---- cloud workspaces, phase 2b: Continue after a session cap, and whether a cloud workspace can be made now ----
    cloudContinue: (sessionId) => this.cloudTurns.continueSession(sessionId),
    cloudReattach: (workspaceId) => this.cloudTurns.reattach(this.workspaces.workspace(workspaceId).id),
    cloudPreflight: async (repoId) => this.sandboxes.preflightResult(this.workspaces.repo(repoId)),

    recordOnboardingMilestone: async (id) => {
      if (!isOnboardingMilestone(id)) throw new Error('Unknown milestone')
      this.recordMilestone(id)
    },

    resetSettings: async (keys) => {
      const defaults = defaultSettings()
      const patch = Object.fromEntries(keys.map((key) => [key, defaults[key]])) as Partial<Settings>
      return this.api.updateSettings(patch)
    },
    updateSettings: async (patch) => {
      // The checklist: milestones already reached stay (the first time stands); the patch can only add them and hide or show the card.
      if ('onboarding' in patch) {
        const current = this.store.state.settings.onboarding ?? defaultOnboarding()
        const asked = migrateOnboarding({ onboarding: patch.onboarding, established: false }).onboarding
        patch = { ...patch, onboarding: { milestones: { ...asked.milestones, ...current.milestones }, checklistHidden: asked.checklistHidden } }
      }
      // Get started: the window layout switched to Tiles.
      if (patch.windowLayout === 'tiles') {
        const base = patch.onboarding ?? this.store.state.settings.onboarding ?? defaultOnboarding()
        patch = { ...patch, onboarding: withMilestone(base, 'tiles', new Date().toISOString()) }
      }
      // Cloud workspaces: a partial patch of the personal cloud settings, each field checked.
      if (patch.cloud !== undefined) patch = { ...patch, cloud: patchCloudSettings(this.store.state.settings, patch.cloud) }
      if ('terminalScreenReader' in patch && !['auto', 'on', 'off'].includes(patch.terminalScreenReader as string)) throw new Error('Unknown screen reader setting')
      if ('announce' in patch && !['needs-me', 'my-chat', 'all'].includes(patch.announce as string)) throw new Error('Unknown announcement setting')
      for (const key of ['announceSummary', 'earcons'] as const) if (key in patch && typeof patch[key] !== 'boolean') throw new Error(`${key} must be on or off`)
      if ('speechOutput' in patch && !['off', 'on'].includes(patch.speechOutput as string)) throw new Error('Unknown speech output setting')
      if ('speechVoice' in patch && (typeof patch.speechVoice !== 'string' || patch.speechVoice.length > 500)) throw new Error('Voice must be a voice identifier, or empty for automatic')
      if ('speechRate' in patch && !(typeof patch.speechRate === 'number' && patch.speechRate >= 0.5 && patch.speechRate <= 2)) throw new Error('Speech rate must be a number from 0.5 to 2')
      if ('speechVolume' in patch && !(typeof patch.speechVolume === 'number' && patch.speechVolume >= 0 && patch.speechVolume <= 1)) throw new Error('Speech volume must be a number from 0 to 1')
      if ('sttProvider' in patch && !['local', 'openai'].includes(patch.sttProvider as string)) throw new Error('Unknown speech to text engine')
      if ('sttLanguage' in patch && !(typeof patch.sttLanguage === 'string' && STT_LANGUAGE.test(patch.sttLanguage))) throw new Error('Dictation language must be a language code such as en')
      if ('pushToTalk' in patch && !['hold', 'toggle'].includes(patch.pushToTalk as string)) throw new Error('Unknown push to talk setting')
      if ('reduceMotion' in patch && !['auto', 'on', 'off'].includes(patch.reduceMotion as string)) throw new Error('Unknown reduce motion setting')
      if ('contentFontSize' in patch && !(Number.isInteger(patch.contentFontSize) && patch.contentFontSize! >= 12 && patch.contentFontSize! <= 24)) throw new Error('Content text size must be a whole number from 12 to 24')
      if ('terminalFontSize' in patch && patch.terminalFontSize !== 'content' && !(Number.isInteger(patch.terminalFontSize) && patch.terminalFontSize! >= 10 && patch.terminalFontSize! <= 20)) throw new Error("Terminal text size must be a whole number from 10 to 20, or 'content'")
      // O4: only shells this version knows.
      if ('terminalShell' in patch && !isShellChoice(patch.terminalShell)) throw new Error('Unknown shell')
      if ('scriptShell' in patch && !isScriptShellChoice(patch.scriptShell)) throw new Error('Unknown script shell')
      // O9: saved commands are checked entry by entry, as when they're loaded.
      if ('savedCommands' in patch) patch = { ...patch, savedCommands: parseSavedCommands(patch.savedCommands) }
      // O8
      if ('hiddenModels' in patch) patch = { ...patch, hiddenModels: parseHiddenModels(patch.hiddenModels) }
      // #22
      if ('agentPrefs' in patch) patch = { ...patch, agentPrefs: parseAgentPrefs(patch.agentPrefs) }
      if ('providerKeyAgents' in patch) patch = { ...patch, providerKeyAgents: parseProviderKeyAgents(patch.providerKeyAgents) }
      // #14
      if ('openInDefault' in patch && !isOpenInChoice(patch.openInDefault)) throw new Error('Unknown app')
      if ('openInPaths' in patch && (typeof patch.openInPaths !== 'object' || patch.openInPaths === null || Object.values(patch.openInPaths).some((v) => typeof v !== 'string'))) throw new Error('Invalid app paths')
      // #21
      if ('homeLayout' in patch && patch.homeLayout !== 'list' && patch.homeLayout !== 'board') throw new Error('Unknown Home layout')
      if ('homeDoneDays' in patch && !(DONE_DAYS_OPTIONS as readonly number[]).includes(patch.homeDoneDays as number)) throw new Error('Unknown Done window')
      if ('archiveCleanupDays' in patch && !(ARCHIVE_CLEANUP_DAYS as readonly number[]).includes(patch.archiveCleanupDays as number)) throw new Error('Unknown cleanup window')
      if ('maxRunningAgents' in patch && !isSlotSetting(patch.maxRunningAgents, MAX_RUNNING_AGENTS)) throw new Error(`Maximum agents running at once must be a whole number from 0 (no limit) to ${MAX_RUNNING_AGENTS}`)
      if ('backgroundWaitMinutes' in patch && !isSlotSetting(patch.backgroundWaitMinutes, MAX_BACKGROUND_WAIT_MINUTES)) throw new Error(`Background task wait must be a whole number of minutes from 0 (never stop) to ${MAX_BACKGROUND_WAIT_MINUTES}`)
      if ('updateInterval' in patch && !['hourly', 'every-4-hours', 'daily'].includes(patch.updateInterval as string)) throw new Error('Unknown update schedule')
      if ('updateMode' in patch && !['notify', 'download', 'quit'].includes(patch.updateMode as string)) throw new Error('Unknown update setting')
      if ('updateChannel' in patch && !['stable', 'beta'].includes(patch.updateChannel as string)) throw new Error('Unknown release channel')
      const settings: Settings = { ...this.store.state.settings, ...patch }
      this.store.state.settings = settings
      // A higher limit (or none) starts the turns queued for an agent slot.
      if ('maxRunningAgents' in patch) this.sessions.admitWaiting()
      if ('keepClearedHistory' in patch) this.store.keepClearedChanged()
      // Turning terminal restore off deletes the output saved so far.
      if (patch.restoreTerminals === false) this.terminals.clear()
      // Turning the assistant off (or privacy mode on) stops what it is answering.
      if (patch.assistantEnabled === false || patch.privacyMode === true) void this.assistant.stopAll()
      if (patch.scriptShell) setScriptShell(patch.scriptShell)
      this.store.save()
      if (patch.theme) this.host.applyTheme(settings.theme)
      if ('language' in patch) this.host.applyLanguage?.()
      this.broadcastState()
      // A different sign-in or binary can offer different models.
      const affects: [keyof Settings, AgentKind][] = [
        ['claudeAuth', 'claude'],
        ['claudeExecutablePath', 'claude'],
        ['codexAuth', 'codex'],
        ['codexExecutablePath', 'codex'],
        ['opencodeExecutablePath', 'opencode']
      ]
      const stale = affects.filter(([key]) => key in patch).map(([, agent]) => agent)
      if (stale.length) void this.models.refreshAll([...new Set(stale)])
      // keepAwake and its O17 cutoffs (keepAwakeBatteryCutoff, …).
      // O2: a GitLab host added or removed changes which repos are GitLab.
      if ('gitlabHosts' in patch) {
        this.scm.forget()
        this.prs.resume()
      }
      if ('githubAuth' in patch || 'zoom' in patch || Object.keys(patch).some((key) => key.startsWith('keepAwake'))) this.applySettings()
      if (['checkForUpdates', 'updateInterval', 'updateMode', 'updateChannel'].some((key) => key in patch)) this.updates.settingsChanged({ channel: 'updateChannel' in patch })
      return settings
    }
  }

  readonly signals: Signals = {
    ptyWrite: (id, data) => this.ptys.write(id, data),
    ptyResize: (id, cols, rows) => this.ptys.resize(id, cols, rows),
    ptyKill: (id) => {
      this.ptys.kill(id)
      this.terminalAgents.forget(id)
    },
    setUnread: (workspaceIds, sessionIds) => this.attention.setUnread(workspaceIds, sessionIds),
    setBattery: (percent) => {
      this.keepAwake.setBattery(percent)
      this.powerChanged()
    },
    saveTerminals: (workspaceId, tabs) => {
      const ws = this.terminalWorkspace(workspaceId)
      if (ws?.cloud && Array.isArray(tabs)) {
        // A cloud tab's folder is in its sandbox: kept when inside the worktree there, never looked for on this disk,
        // so a restored cloud tab starts a cloud shell (ptySpawn), not a local one.
        const root = ws.cloud.cwd
        this.terminals.put(workspaceId, tabs.map((tab) => ({ ...tab, cwd: cloudTerminalFolder(tab?.cwd, root) ?? root })))
        return
      }
      const cwd = ws && wsPath(ws)
      if (!cwd || !Array.isArray(tabs)) return
      // G3 · O3: the folder the shell said it was in (OSC 7), when that folder exists; otherwise the workspace's.
      this.terminals.put(workspaceId, tabs.map((tab) => ({ ...tab, cwd: existingFolder(tab?.cwd) ?? cwd })))
    }
  }

  private requireMobile(): MobileService {
    if (!this.mobile) throw new Error('Mobile access is starting. Try again.')
    return this.mobile
  }

  /** #14: the default app from Settings; a file opens in it (terminals get the file's folder). */
  private async openInEditor(target: string): Promise<void> {
    const isDir = await stat(target).then((s) => s.isDirectory(), () => false)
    await this.openIn.open(null, isDir ? { folder: target } : { folder: path.dirname(target), file: target })
  }

  /** The token GitHub work in a repository runs as, for a cloud workspace's clone and its commands. Never stored. */
  private cloudGithubToken(repoId: string): string | undefined {
    try {
      const env = githubEnv(this.workspaces.accountFor(repoId))
      if (env.GH_TOKEN) return env.GH_TOKEN
      const active = ghActiveAccount()
      return active ? accountToken(active) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The update card's Restart: install the downloaded update now (running turns stop, as with Quit now, and are listed for
   * review after the restart), or once the running turns end, holding new ones back meanwhile.
   */
  private restartToUpdate(whenIdle: boolean): void {
    if (!this.updates.ready()) throw new Error(mainT(this.store.state.settings)('update.error.notReady'))
    const restart = (): boolean => {
      if (!this.updates.ready() || !this.host.restartToUpdate) return false
      this.host.restartToUpdate()
      return true
    }
    if (!whenIdle || !this.stopSafely.needsAsking()) return void restart()
    this.updates.setWaiting(true)
    this.stopSafely.quitWhenFinished({
      reason: mainT(this.store.state.settings)('update.frozen'),
      then: () => restart() || (this.updates.setWaiting(false), false),
      cancelled: () => this.updates.setWaiting(false)
    })
  }

  async shutdown(): Promise<void> {
    this.updates.stop()
    this.sandboxes.stopIdleTicker()
    this.prWatch.stop()
    this.prPoll.stop()
    this.attention.stop()
    this.autoFix.dispose()
    this.autoReview.dispose()
    this.baseWatch.stop()
    this.schedules.stopTimer()
    this.autoArchive.stop()
    this.limitResume.stopTimer()
    if (this.powerTimer) clearInterval(this.powerTimer)
    await this.net.close()
    this.data.stop()
    this.gitBackup.stop()
    this.ptys.killAll()
    this.terminals.flush(true)
    await this.checks.shutdown()
    await this.spotlight.stopAll(this.store.state.repos)
    await this.assistant.stopAll()
    this.speech.dispose()
    // O10: after a keep-running quit, turns in the background host go on; otherwise they stop like any other.
    const keepHosted = this.stopSafely.keeping
    await Promise.all([this.sessions.shutdown({ keepHosted }), this.workspaces.shutdown()])
    if (!keepHosted) this.agentHost.close()
    // Cloud workspaces' turns go on in their sandboxes; the app only lets go.
    this.foremanMcp.close()
    this.cloudTurns.close()
    this.store.close()
  }
}
