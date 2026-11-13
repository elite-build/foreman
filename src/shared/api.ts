// Foreman as a server (docs/server.md): the contract every client of the main process shares. A client holds a session
// with scopes; every method and signal names the scope it needs; a session's view bounds which events it is sent; and
// the frames are what a socket client says. Pure, so main, the renderer, the phone and the tests read the same rules.
import { hostForwards } from './remote'
import type { Api, MainEvent, Signals } from './types'

/** Bumped when the frames below change. */
export const API_PROTOCOL = 1

/** The largest frame a client may send; the server closes the socket past it, so a client checks before sending. */
export const MAX_CLIENT_FRAME_BYTES = 1024 * 1024

/**
 * read: look. operate: do work in workspaces and chats. admin: change how Foreman is set up, or move data out of it.
 * window: what only makes sense on the computer with the screen. admin includes operate, which includes read; window
 * stands alone, and only the desktop window holds it.
 */
export type Scope = 'read' | 'operate' | 'admin' | 'window'

/**
 * The scope each method needs. Exhaustive at compile time, so a new method fails `npm run typecheck` until it is
 * placed. Between operate and admin: "does this change how Foreman is set up or move data out of it?" is admin, "is this
 * doing work in a workspace?" is operate. The window entries are exactly what a paired computer could never call
 * (LOCAL_METHODS, UNAVAILABLE_REMOTELY and SECRET_METHODS in shared/remote.ts, and attachFiles); hostAccepts reads them.
 */
export const METHOD_SCOPES = {
  // The state, and reads about repositories, accounts and this computer.
  getSnapshot: 'read', githubRepos: 'read', githubAccounts: 'read', remoteUrl: 'read', listBranches: 'read', listRemotes: 'read',
  previewFilesToCopy: 'read', detectRepoIcon: 'read', listWorktrees: 'read', whichBinary: 'read', resourceUsage: 'read',
  githubStatus: 'read', gitlabHosts: 'read', usageReport: 'read', dataInfo: 'read', gitBackupStatus: 'read', devicesInfo: 'read',
  mobileInfo: 'read', pingDevice: 'read',
  // Agents on this computer: what it holds has no codes, so a watching phone may read it as it is.
  agentAccessInfo: 'read', baseWatchSupport: 'read', detectShells: 'read',

  // Settings reads: what is configured, never a secret's value.
  envView: 'read', opencodeProviders: 'read', agentStatus: 'read', agentCatalog: 'read', agentSignInStatus: 'read', refreshModels: 'read',
  cloudClaudeToken: 'read', cloudUsage: 'read', cloudPreflight: 'read',
  checkConnection: 'read', connectionRemovalImpact: 'read', repoIntegrations: 'read', integrationActivity: 'read', integrationToolCosts: 'read',
  ghAccountsForIntegrations: 'read', slackManifest: 'read', slackPeople: 'read', slackChannels: 'read', slackDeliveries: 'read',
  linearMyIssues: 'read', resolveLinearLink: 'read', resolveGithubLink: 'read',

  // Reads about workspaces, chats, files, diffs, checks, flows and history.
  archivePreview: 'read', archivedWork: 'read', archivedDiff: 'read', dockerContainers: 'read', exportInfo: 'read', stopReview: 'read',
  searchChats: 'read', searchNotes: 'read', getSetupLog: 'read', getSetupStepLogs: 'read', prepareHandOff: 'read',
  getChat: 'read', pendingApprovals: 'read', slashCommands: 'read', mcpStatus: 'read', repoMcp: 'read', attentionHistory: 'read',
  refreshPullRequest: 'read', scheduleFingerprint: 'read', listFlows: 'read', listPersonas: 'read', flowRunPreview: 'read',
  listFlowRuns: 'read', workspaceLineage: 'read', lineageFlowDraft: 'read',
  listFiles: 'read', readFile: 'read', listDir: 'read', readImage: 'read', readImageAt: 'read', searchFiles: 'read', alertFile: 'read',
  getDiff: 'read', diffSources: 'read', branchCommits: 'read', branchCommitCount: 'read', getAlertDiff: 'read', workspaceUsage: 'read',
  gitStatus: 'read', checksStatus: 'read', reviewThreads: 'read', probePreview: 'read', autoFixPreview: 'read', autoReviewPreview: 'read',
  savedTerminals: 'read', savedCommandConsent: 'read', terminalAgentRuns: 'read', cloudStatus: 'read',
  assistantState: 'read', assistantItems: 'read',

  // Workspaces: create, compare, archive and bring back, setup, notes, notices.
  createWorkspace: 'operate', startCompare: 'operate', archiveCompareOthers: 'operate', adoptWorktree: 'operate', updateWorkspace: 'operate',
  archiveWorkspace: 'operate', unarchiveWorkspace: 'operate', forgetWorkspace: 'operate', deleteArchived: 'operate', keepArchived: 'operate',
  activateWorkspace: 'operate', removeDockerContainers: 'operate', dismissDockerLeft: 'operate', dismissArchiveStopped: 'operate',
  forkArchivedChat: 'operate', saveNote: 'operate', sendNote: 'operate', rerunSetup: 'operate', retrySetup: 'operate', stopSetup: 'operate',
  startHeldMessage: 'operate', dismissReconnected: 'operate', retryStopped: 'operate', dismissStopped: 'operate', markAttentionSeen: 'operate',
  setWorkspaceIntegration: 'operate', recordOnboardingMilestone: 'operate',

  // Chats, approvals and the assistant.
  createSession: 'operate', forkSession: 'operate', startHandOff: 'operate', updateSession: 'operate', closeSession: 'operate',
  reopenSession: 'operate', sendMessage: 'operate', removeQueued: 'operate', steerQueued: 'operate', editQueued: 'operate',
  moveQueued: 'operate', cancel: 'operate', respondApproval: 'operate', restoreCheckpoint: 'operate', reconnectMcpServer: 'operate', stopChild: 'operate',
  approveRepoMcp: 'operate', armLimitResume: 'operate', cancelLimitResume: 'operate', resumeLimitNow: 'operate', refreshLimits: 'operate', continueOnAccount: 'operate',
  assistantSend: 'operate', assistantCancel: 'operate', assistantDeleteThread: 'operate', assistantClearHistory: 'operate',
  assistantCancelRun: 'operate', answerSlackAsk: 'operate', resendSlackDelivery: 'operate', cancelHandOff: 'operate',

  // Files, diffs, comments, git, pull requests and checks.
  attachData: 'operate', stageAttachment: 'operate', writeFile: 'operate', dismissAlert: 'operate', closeAgentReport: 'operate',
  setFileViewed: 'operate', revertFile: 'operate', setSpotlight: 'operate', runChecks: 'operate', cancelChecks: 'operate',
  fixChecks: 'operate', sendReviewThreads: 'operate', gitAction: 'operate', setPrWatch: 'operate', fixCi: 'operate',
  resolveBaseMoved: 'operate', ackCiFailure: 'operate', setAutoFix: 'operate', sendAutoReviewFindings: 'operate',
  dismissAutoReview: 'operate', addComment: 'operate', sendDiffSelection: 'operate', resendDiffSelection: 'operate',
  updateComment: 'operate', deleteComment: 'operate',

  // Terminals, schedules, flows and cloud sandboxes.
  // terminalOutput: what a terminal printed, as its live output is (sentToView), only to whoever can act on it.
  ptySpawn: 'operate', approveSavedCommand: 'operate', terminalOutput: 'operate',
  saveSchedule: 'operate', approveSchedule: 'operate', pauseSchedule: 'operate', resumeSchedule: 'operate', deleteSchedule: 'operate',
  stopScheduledRun: 'operate', savePersonalFlow: 'operate', deletePersonalFlow: 'operate', savePersonalPersona: 'operate',
  deletePersonalPersona: 'operate', startFlowRun: 'operate', stopFlowRun: 'operate',
  cloudBuildBase: 'operate', cloudWake: 'operate', cloudSleep: 'operate', cloudRestart: 'operate', cloudContinue: 'operate', cloudReattach: 'operate',

  // Repositories and their settings.
  addRepo: 'admin', cloneRepo: 'admin', quickStartRepo: 'admin', makeRepo: 'admin', forgetRecentRepo: 'admin', updateRepo: 'admin',
  removeRepo: 'admin', updateRepoSettings: 'admin', detectRepoAccount: 'admin', setAutoReview: 'admin',
  // Organizations (docs/ai-employees.md §3): which space a repository is in, and making a memory repository on disk.
  createOrganization: 'admin', renameOrganization: 'admin', deleteOrganization: 'admin', moveRepoToSpace: 'admin', setOrganizationMemory: 'admin',
  // Memory repositories (docs/ai-employees.md §4): reading them is a read; a person's edit and accepting foreign changes
  // change what every employee of the organization is told, so they are admin.
  memoryStatus: 'read', memoryTree: 'read', memoryReadFile: 'read', memoryFileHistory: 'read', memorySearch: 'read',
  memoryWriteFile: 'admin', memoryAcceptForeign: 'admin',
  // AI employees (docs/ai-employees.md §5): listing them is a read. Drafting sends the person's words to a model, and
  // creating, editing, approving, pausing, resuming and retiring change what may run, so they are admin (§9: never from a turn).
  listEmployees: 'read',
  generateEmployeeDraft: 'admin', refineEmployeeDraft: 'admin', createEmployee: 'admin', updateEmployee: 'admin', approveEmployee: 'admin',
  pauseEmployee: 'admin', resumeEmployee: 'admin', retireEmployee: 'admin',
  // Turning a trigger off here or on again changes what runs on its own, as pausing does.
  setEmployeeTriggerOff: 'admin',
  // An employee's work (docs/ai-employees.md §6): reading tasks and runs is a read; asking, Run now, Stop, Retry and
  // Cancel do work, as starting and stopping a flow run does (§9: `run` and `ask` act).
  listEmployeeTasks: 'read', listEmployeeRuns: 'read',
  askEmployee: 'operate', runEmployeeNow: 'operate', stopEmployeeRun: 'operate', retryEmployeeTask: 'operate', cancelEmployeeTask: 'operate',
  // Answering an employee's question starts its continuation, as asking does; keeping or retiring a memory proposal
  // changes what every employee of the organization reads, as a person's edit does, so it is admin (never from a turn).
  answerEmployeeQuestion: 'operate', keepMemoryProposal: 'admin', retireMemoryProposal: 'admin',
  // Working together (docs/ai-employees.md §7): reading a task's chain is a read. Raising a chain's runs lets employees
  // run more on their own, and the lead decides where escalations go, so both are admin (never from a turn: an employee
  // can't raise its own limit or make itself lead).
  employeeTaskChain: 'read', raiseEmployeeRootLimit: 'admin', setOrganizationLead: 'admin',
  // An employee's held outward action (docs/ai-employees.md §9): sending it is the person's approval of a Slack message,
  // a Linear change, a push or a pull request, so it is admin, never from a turn (no agent approves an employee's send).
  sendEmployeeAction: 'admin', skipEmployeeAction: 'admin', confirmEmployeeAction: 'admin',

  // Settings, keys and environment.
  updateSettings: 'admin', resetSettings: 'admin', setEnvVars: 'admin', setEnvFiles: 'admin',
  importKeyFromShell: 'admin', setProviderKey: 'admin', setAgentKey: 'admin', importAgentKey: 'admin', importProviderKey: 'admin',
  // #130: an agent's accounts are setup, like its keys.
  saveAgentInstance: 'admin', removeAgentInstance: 'admin',
  cloudSetClaudeToken: 'admin', setGithubToken: 'admin', testGitlabHost: 'admin', saveGitlabToken: 'admin', removeGitlabHost: 'admin',
  useGlabToken: 'admin',

  // Integrations.
  addConnection: 'admin', updateConnection: 'admin', removeConnection: 'admin', setIntegrationDefault: 'admin', setRepoIntegration: 'admin',
  setRepoIntegrationOptions: 'admin', applyConnectionToRepos: 'admin', acceptIntegrationSuggestion: 'admin', importRepoGithubToken: 'admin',
  saveSlackRule: 'admin', consentSlackRule: 'admin', deleteSlackRule: 'admin', linkPerson: 'admin', unlinkPerson: 'admin',

  // Backups and data.
  backupNow: 'admin', configureGitBackup: 'admin', createGitBackupGithubRepo: 'admin', gitBackupNow: 'admin', previewGitBackup: 'admin',
  restoreGitBackup: 'admin', deleteLegacyFiles: 'admin',

  // Devices, phones and paired computers, and moving a workspace to one. The assistant's Run can run any `foreman`
  // command, settings included, so it needs what the strongest of them needs.
  setAcceptHandOffs: 'admin', showPairingCode: 'admin', cancelPairingCode: 'admin', pairWith: 'admin', unpairDevice: 'admin',
  setRemoteControl: 'admin', startHandOffTo: 'admin', reconcileHandOff: 'admin',
  mobileConfigure: 'admin', mobileConfigureLan: 'admin', mobileStartPairing: 'admin', mobileApprovePairing: 'admin', mobileRevokeDevice: 'admin',
  // Who may sign in from an agent on this computer (docs/agent-access.md §9).
  agentAccessConfigure: 'admin', agentAccessApprove: 'admin', agentAccessDeny: 'admin', agentAccessRevoke: 'admin',
  assistantConfirmRun: 'admin',

  // The window: the app itself (quitting, updates, diagnostics, the command line), dictation, links, the computer chip.
  quitPlan: 'window', quitNow: 'window', quitWhenFinished: 'window', quitKeepRunning: 'window', cancelQuit: 'window',
  checkForUpdates: 'window', dismissUpdate: 'window', downloadUpdate: 'window', stopUpdateDownload: 'window', installUpdateOnQuit: 'window',
  restartToUpdate: 'window', cancelUpdateRestart: 'window', releaseNotes: 'window', dismissUpdated: 'window',
  saveDiagnostics: 'window', reportDiagnostics: 'window', fullDiskAccess: 'window', openFullDiskAccessSettings: 'window',
  cliStatus: 'window', installCli: 'window',
  sttStart: 'window', sttAudio: 'window', sttStop: 'window', sttCancel: 'window', sttModelStatus: 'window', sttDownloadModel: 'window',
  openExternal: 'window', takeLaunchFolders: 'window',
  computers: 'window', viewComputer: 'window', answerControlRequest: 'window', disconnectController: 'window',
  // This computer's screen and files: pickers, Open in…, previews, import and export files, and dropped paths.
  pickDirectory: 'window', pickFiles: 'window', pickPath: 'window', classifyFolders: 'window', attachFiles: 'window',
  openPath: 'window', openFile: 'window', openInEditor: 'window', openInApps: 'window', openInIcons: 'window', openIn: 'window',
  openRepoSettingsFile: 'window', previewUrl: 'window', openPreview: 'window',
  // Codex's browser sign-in: its callback and the browser belong to one computer.
  codexSignIn: 'window', codexSignInCancel: 'window',
  exportWorkspace: 'window', stageImport: 'window', importStaged: 'window', discardImport: 'window',
  // A saved secret's value: set from anywhere with admin, read back only on the computer it belongs to.
  revealEnvVar: 'window', revealAgentKey: 'window', revealProviderKey: 'window'
} as const satisfies Record<keyof Api, Scope>

/** Terminal input is work in a workspace; the unread badge and the battery are about this computer's window. */
export const SIGNAL_SCOPES = {
  ptyWrite: 'operate',
  composerTyping: 'operate',
  ptyResize: 'operate',
  ptyKill: 'operate',
  saveTerminals: 'operate',
  setUnread: 'window',
  setBattery: 'window'
} as const satisfies Record<keyof Signals, Scope>

/** Whether a session holding `scopes` may do what needs `needed`. */
export function holds(scopes: readonly Scope[], needed: Scope): boolean {
  if (needed === 'window') return scopes.includes('window')
  if (scopes.includes('admin')) return true
  if (needed === 'admin') return false
  if (scopes.includes('operate')) return true
  return needed === 'read' && scopes.includes('read')
}

// ---- sessions ----

export type ApiSessionKind = 'window' | 'computer' | 'phone' | 'browser'

/** What a client holds once it is in: who it is and what it may do. */
export interface ApiSession {
  id: string
  kind: ApiSessionKind
  name: string
  scopes: readonly Scope[]
}

/** The desktop window: an implicit local session with every scope. */
export const WINDOW_SESSION: ApiSession = Object.freeze({ id: 'window', kind: 'window', name: 'This computer', scopes: Object.freeze(['read', 'operate', 'admin', 'window'] as const) })

/** A paired computer that took control: everything but this computer's window. */
export function computerSession(deviceId: string, name: string): ApiSession {
  return { id: `computer:${deviceId}`, kind: 'computer', name, scopes: ['read', 'operate', 'admin'] }
}

// ---- the stream ----

/** What a client shows: one chat or one workspace's terminals (a phone), or everything (the window, a browser). */
export type View = { all: true } | { sessionId?: string; workspaceId?: string }

// always: every session. chat: the event's chat is in the view. terminal: operate, and the whole view or (#127, a terminal's
// own events) the view of its workspace; terminal output and logs are only of use to whoever can act on them.
// window: never (hostForwards decides; the test keeps the two in step).
type Reach = 'always' | 'chat' | 'terminal' | 'window'

const EVENT_REACH = {
  state: 'always', approval: 'always', 'approval-resolved': 'always', notify: 'always', 'attention-history': 'always',
  'archive-progress': 'always', 'assistant-threads': 'always',
  // Agents on this computer: the same as agentAccessInfo (read), which holds no codes.
  'agent-access': 'always',
  // The assistant's items carry a thread, not a chat session, so a view can't name them: every session gets them,
  // as it gets the thread list. (The phone shows no assistant; a browser views all anyway.)
  'assistant-item': 'always',
  'chat-item': 'chat', 'chat-append': 'chat', 'chat-reset': 'chat',
  'pty-data': 'terminal', 'pty-exit': 'terminal', 'pty-state': 'terminal', 'setup-log': 'terminal', 'cloud-build-log': 'terminal',
  'clone-progress': 'terminal', 'auto-run': 'terminal',
  'browser-open': 'window', 'browser-state': 'window', 'browser-shortcut': 'window', 'show-workspace': 'window', 'show-setting': 'window',
  'report-problem': 'window', tour: 'window', 'launch-folders': 'window', 'quit-requested': 'window', 'open-link': 'window',
  navigate: 'window', 'stt-partial': 'window', 'stt-error': 'window', 'stt-model': 'window', 'window-visibility': 'window',
  computers: 'window', 'computer-notify': 'window', 'computer-left': 'window'
} as const satisfies Record<MainEvent['type'], Reach>

/** For tests: where each event type goes. */
export function eventReach(type: MainEvent['type']): Reach {
  return EVENT_REACH[type]
}

/** Whether a session with this view and these scopes is sent this event. */
export function sentToView(event: MainEvent, view: View, scopes: readonly Scope[]): boolean {
  if (!hostForwards(event)) return false
  const all = 'all' in view && view.all === true
  switch (EVENT_REACH[event.type]) {
    case 'always':
      return true
    case 'chat':
      return all || ('sessionId' in event && 'sessionId' in view && view.sessionId === event.sessionId)
    case 'terminal':
      if (!holds(scopes, 'operate')) return false
      return all || ((event.type === 'pty-data' || event.type === 'pty-exit' || event.type === 'pty-state') &&
        event.workspaceId !== undefined && 'workspaceId' in view && view.workspaceId === event.workspaceId)
    default:
      return false
  }
}

// ---- the frames (docs/server.md, "The wire") ----

export type ApiErrorCode = 'refused' | 'unavailable' | 'failed'

/** Why a hello was turned away. */
export type ApiRefusal = 'protocol' | 'version' | 'credential' | 'scope'

export type ApiByeReason = 'revoked' | 'slow' | 'shutdown' | 'off'

export type ApiClientFrame =
  | { t: 'hello'; protocol: number; version: string; client: { kind: 'phone' | 'browser'; name: string }; view?: View }
  | { t: 'call'; id: number; method: string; args: unknown[] }
  | { t: 'signal'; method: string; args: unknown[] }
  | { t: 'view'; view: View }
  | { t: 'ping' }

export type ApiWelcome =
  | { t: 'welcome'; ok: true; session: ApiSession; version: string; platform: string; name: string; seq: number }
  | { t: 'welcome'; ok: false; refused: ApiRefusal }

export type ApiServerFrame =
  | ApiWelcome
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: string; code?: ApiErrorCode }
  | { t: 'event'; seq: number; event: MainEvent }
  | { t: 'bye'; reason: ApiByeReason }
  | { t: 'pong' }

// ---- refusals ----

const WHO: Record<ApiSessionKind, string> = { window: 'This window', computer: 'This computer', phone: 'This phone', browser: 'This browser' }
const CAN: Record<Exclude<Scope, 'window'>, string> = { read: 'watch', operate: 'operate', admin: 'change how Foreman is set up' }

/** A call the session may not make. The message names what it can do and what it lacks, never a silent downgrade. */
export class ApiRefused extends Error {
  readonly code: ApiErrorCode

  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'ApiRefused'
    this.code = code
  }

  /** The refusal for a session that lacks `needed`. */
  static lacking(session: Pick<ApiSession, 'kind' | 'scopes'>, needed: Scope): ApiRefused {
    if (needed === 'window') return new ApiRefused('unavailable', 'That needs the computer’s own window.')
    const best = (['admin', 'operate', 'read'] as const).find((s) => session.scopes.includes(s))
    const who = WHO[session.kind]
    const message = best ? `${who} can ${CAN[best]} but not ${CAN[needed]}.` : `${who} can’t ${CAN[needed]}.`
    return new ApiRefused('refused', `${message} Approve it again with more access.`)
  }
}
