// Persistence. foreman.db (SQLite, see db.ts) holds the operational records:
// workspaces, sessions, comments, chat items, check results. state.json keeps
// preferences, the model catalog, templates and the repository list. The
// in-memory `state` object stays the working copy; save() writes both.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync, writeFileSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_LOADOUTS, DEFAULT_MODEL } from '../shared/agents'
import { DEFAULT_PROMPT_TEMPLATES } from '../shared/promptTemplates'
import { dateInZone } from '../shared/schedule'
import { defaultOnboarding, migrateOnboarding } from '../shared/onboarding'
import { isScriptShellChoice, isShellChoice } from '../shared/shells'
import { parseSavedCommands } from '../shared/savedCommands'
import { parseHiddenModels } from '../shared/modelVisibility'
import { parseAgentPrefs, parseProviderKeyAgents } from '../shared/agentCatalog'
import { defaultFromEditorCommand, isOpenInChoice } from '../shared/openIn'
import type { PairedDevice, Transfer } from '../shared/transfer'
import type { MobileDevice } from '../shared/mobile'
import type { GitBackupStatus } from '../shared/gitBackup'
import { addStops, type StopRecord } from '../shared/stopSafely'
import type { HostedTurnRecord, ReconnectRecord } from '../shared/agentHost'
import type { IntegrationsState } from '../shared/integrations'
import type { ChatItem, CloudUsage, DiffComment, ModelCatalogState, Occurrence, Repo, Schedule, Session, Settings, Workspace } from '../shared/types'
import { migrateRepoFields } from './repoSettings'
import { ForemanDb } from './db'
import { ensureDatabase, type MigrationInfo } from './legacyImport'

export interface PersistedState {
  version: 1 | 2
  repos: Repo[]
  workspaces: Workspace[]
  sessions: Session[]
  comments: DiffComment[]
  settings: Settings
  // The agents' model lists from their last answer, so the picker is filled at startup.
  catalog: ModelCatalogState
  // Repository folders opened before, most recent first.
  recentRepoPaths: string[]
  // Repository id → hashes of check commands the user approved to run.
  checkApprovals?: Record<string, string[]>
  // O9: repository id → repo command name → the text last approved, so a changed command shows what changed.
  commandApprovedText?: Record<string, Record<string, string>>
  // Repository id → server name → fingerprints of the repo-proposed MCP server this Mac approved (see repoMcp.ts).
  mcpApprovals?: Record<string, Record<string, string[]>>
  // Repository id → fingerprints already put in front of the user, so the consent dialog opens once per change.
  mcpSeen?: Record<string, string[]>
  // Scheduled templates (R-5) and their runs. Written with a synchronous flush before a run launches.
  schedules?: Schedule[]
  occurrences?: Occurrence[]
  // Paired Macs (keys are in the vault) and hand-offs (P-4).
  devices?: { selfId?: string; paired: PairedDevice[] }
  transfers?: Transfer[]
  mobileDevices?: MobileDevice[]
  // One-time setting migrations already applied.
  migrations?: string[]
  // Destination and schedule stay on this machine; never included in Git backup files.
  gitBackup?: GitBackupStatus
  // #1: turns and check runs a quit or crash stopped, until each is retried or dismissed. Never replayed by itself.
  stopRecord?: StopRecord
  // O10: turns handed to the background agent host, adopted again after a restart.
  hostedTurns?: HostedTurnRecord[]
  // O10: set by a keep-running quit; when Foreman closed, for the chat's gap line.
  keepRunning?: { closedAt: string }
  // O10: Home's "Reconnected to …" line, until dismissed.
  reconnected?: ReconnectRecord
  // The release the update notice's "Skip this version" hid; a newer one is offered again.
  skippedUpdate?: string
  // Integrations: connections (secrets are in the vault), defaults, Slack rules and people.
  integrations?: IntegrationsState
  // Remote workspaces: this month's sandbox stop receipts added up, per provider (Settings → Remote workspaces).
  cloudUsageBy?: Partial<Record<import('../shared/cloud').CloudProviderId, CloudUsage>>
  // Before there were providers: Vercel's total. SandboxManager moves it into cloudUsageBy.vercel.
  cloudUsage?: CloudUsage
}

export function defaultSettings(): Settings {
  return {
    language: 'system',
    messageSendKey: 'enter',
    followUpMode: 'steer',
    notifications: true,
    assistantEnabled: true,
    tourSeen: false,
    onboardingSeen: false,
    onboarding: defaultOnboarding(),
    sound: 'chime',
    dockBadge: true,
    // #3: on by default (the mock's answer); Settings → General turns it off.
    trayIcon: true,
    autoConvertLongText: true,
    notAbsolutelyRight: false,
    alwaysShowContextUsage: false,
    keepAwake: false,
    // O17 cutoffs, as the approved mock shows them.
    keepAwakeBatteryCutoff: true,
    keepAwakeBatteryPercent: 20,
    keepAwakeThermalCutoff: true,
    keepAwakeOnlyOnPower: false,
    checkForUpdates: true,
    expandToolCalls: false,
    editorCommand: 'code',
    // #14: Automatic (the first editor found), and no paths of the user's own.
    openInDefault: '',
    openInPaths: {},
    promptTemplates: DEFAULT_PROMPT_TEMPLATES,
    githubAuth: 'cli',
    privacyMode: false,
    requireToolApprovals: false,
    // Codex's sandbox keeps git data read-only, so it can't commit or open PRs there.
    codexApprovals: 'always',
    theme: 'system',
    zoom: 1,
    coloredSidebarDiffs: false,
    colorVision: 'default',
    monoFont: 'Geist Mono',
    codeLigatures: true,
    terminalFont: '',
    terminalFontSize: 12,
    contentFontSize: 13,
    reduceMotion: 'auto',
    announce: 'my-chat',
    announceSummary: true,
    earcons: false,
    speechOutput: 'off',
    speechVoice: '',
    speechRate: 1,
    speechVolume: 1,
    sttProvider: 'local',
    sttLanguage: 'en',
    pushToTalk: 'hold',
    windowLayout: 'panes',
    sidebarSide: 'left',
    sidePanelSide: 'right',
    terminalPlacement: 'panel-bottom',
    // #21: Board view on Home is opt-in; List stays Home's layout until it's turned on.
    homeBoard: false,
    homeLayout: 'list',
    homeDoneDays: 7,
    loadouts: DEFAULT_LOADOUTS,
    reviewModel: { agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'high', fast: false },
    claudeOutputStyle: 'default',
    defaultPlanMode: false,
    workspacesRoot: path.join(os.homedir(), 'foreman', 'workspaces'),
    branchPrefixType: 'github',
    branchPrefix: '',
    autoRenameBranches: true,
    renameWorkspaceWithBranch: true,
    deleteBranchOnArchive: false,
    archiveOnMerge: false,
    automerge: false,
    optionalChecksBlock: false,
    pushAutoSetupRemote: true,
    openPrIn: 'github',
    stackedPrs: false,
    // O2: self-managed GitLab hosts the user added (gitlab.com needs no entry).
    gitlabHosts: [],
    claudeAuth: 'cli',
    codexAuth: 'cli',
    claudeExecutablePath: '',
    codexExecutablePath: '',
    opencodeExecutablePath: '',
    chromeMode: false,
    opencodeModels: [],
    // O8: nothing hidden; models an agent adds later start visible.
    hiddenModels: {},
    // #22
    agentPrefs: {},
    providerKeyAgents: {},
    envFiles: [],
    cloneDirectory: path.join(os.homedir(), 'foreman', 'repos'),
    autoPermissionMode: false,
    autoRunAfterSetup: false,
    forkToNewTab: true,
    showResourceUsage: false,
    terminalScrollbackMb: 10,
    terminalCopyOnSelect: false,
    terminalScreenReader: 'auto',
    restoreTerminals: true,
    // O10: off until the owner turns it on; the Quit sheet points here.
    keepAgentsRunning: false,
    // No limit and no cutoff: turns start at once and wait for their background work, as they always did.
    maxRunningAgents: 0,
    backgroundWaitMinutes: 0,
    // O4: Automatic is the shell Foreman always started (pwsh, then Windows PowerShell); scripts stay on cmd.exe.
    terminalShell: 'auto',
    terminalShellCustom: '',
    scriptShell: 'cmd',
    // O9: your saved commands (the repo's own come from its settings.toml).
    savedCommands: [],
    keepClearedHistory: false,
    dailyBackup: false,
    backupFolder: '',
    acceptHandOffs: false,
    devicePort: 47631,
    mobileEnabled: false,
    mobileUrl: '',
    mobileLanEnabled: false,
    mobileLanAddress: ''
  }
}

/** Bring state written by older versions up to the current shape. */
function migrate(state: PersistedState, raw: Record<string, unknown>): Session[] {
  const interrupted: Session[] = []
  const hosted = new Set((state.hostedTurns ?? []).map((h) => h.turnId))
  state.comments ??= []
  state.catalog ??= { agents: {}, outputStyles: [] }
  state.recentRepoPaths ??= state.repos.map((r) => r.rootPath)
  state.migrations ??= []
  state.schedules ??= []
  state.occurrences ??= []
  // Older schedules selected weekdays only. Preserve their planned next run while adding the new cadence fields.
  for (const schedule of state.schedules) {
    schedule.recurrence ??= schedule.weekdays.length === 7 ? 'daily' : 'weekly'
    schedule.startDate ??= dateInZone(Date.parse(schedule.createdAt), schedule.timezone)
  }
  // O4: a shell this version doesn't know (edited by hand, or from a newer Foreman) goes back to the default.
  if (!isShellChoice(state.settings.terminalShell)) state.settings.terminalShell = 'auto'
  if (!isScriptShellChoice(state.settings.scriptShell)) state.settings.scriptShell = 'cmd'
  if (typeof state.settings.terminalShellCustom !== 'string') state.settings.terminalShellCustom = ''
  // O9: saved commands checked entry by entry; anything malformed is dropped.
  state.settings.savedCommands = parseSavedCommands(state.settings.savedCommands)
  // O8: hidden models checked the same way; anything malformed is dropped.
  state.settings.hiddenModels = parseHiddenModels(state.settings.hiddenModels)
  // #22: the agent catalog's choices, checked the same way.
  state.settings.agentPrefs = parseAgentPrefs(state.settings.agentPrefs)
  state.settings.providerKeyAgents = parseProviderKeyAgents(state.settings.providerKeyAgents)
  // #14: the old Editor command becomes Custom command… unchanged; once, the default app follows from it.
  if (typeof state.settings.editorCommand !== 'string') state.settings.editorCommand = 'code'
  if (!state.migrations.includes('open-in-apps')) {
    state.settings.openInDefault = defaultFromEditorCommand(state.settings.editorCommand)
    state.migrations.push('open-in-apps')
  }
  if (!isOpenInChoice(state.settings.openInDefault)) state.settings.openInDefault = ''
  const own = state.settings.openInPaths as unknown
  state.settings.openInPaths =
    own && typeof own === 'object' ? Object.fromEntries(Object.entries(own).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')) : {}
  state.devices ??= { paired: [] }
  state.transfers ??= []
  // "Sandboxed" was the default before Codex's sandbox turned out to block commits and PRs;
  // nobody chose it, so move to the new default once. Choosing it again later sticks.
  if (!state.migrations.includes('codex-full-access')) {
    if (state.settings.codexApprovals === 'sandboxed') state.settings.codexApprovals = 'always'
    state.migrations.push('codex-full-access')
  }
  // Template lists are saved whole, so a default added later reaches existing users only this way.
  if (!state.migrations.includes('issue-template')) {
    const issue = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === 'default-fix-issue')
    if (issue && !state.settings.promptTemplates.some((t) => t.id === issue.id)) state.settings.promptTemplates = [...state.settings.promptTemplates, issue]
    state.migrations.push('issue-template')
  }
  if (!state.migrations.includes('setup-repo-template')) {
    const setup = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === 'default-setup-repo')
    if (setup && !state.settings.promptTemplates.some((t) => t.id === setup.id)) state.settings.promptTemplates = [...state.settings.promptTemplates, setup]
    state.migrations.push('setup-repo-template')
  }
  // Low-contrast dark and the code themes were removed (one theme, light and dark); what was saved for them goes.
  const settings = state.settings as Settings & { lowContrastDark?: unknown; codeTheme?: unknown }
  delete settings.lowContrastDark
  delete settings.codeTheme
  // The welcome tour opens by itself only on a first launch. Someone who already had
  // repositories when it arrived has found their way around; Help → Welcome tour still shows it.
  if (typeof raw.tourSeen !== 'boolean') state.settings.tourSeen = state.repos.length > 0
  // The first run and the Get started checklist follow the same rule: someone who already had repositories or had
  // seen the tour never gets the first run, and the checklist never opens by itself for them (⌘K still has it).
  Object.assign(state.settings, migrateOnboarding({ onboardingSeen: raw.onboardingSeen, onboarding: raw.onboarding, established: state.repos.length > 0 || state.settings.tourSeen === true }))
  // A check that was running when the app closed didn't finish; it must never read as a pass.
  for (const ws of state.workspaces) {
    // Waiting for a quiet workspace isn't remembered across a restart.
    delete ws.autoChecks
    if (!ws.checks) continue
    ws.checks.running = false
    for (const r of ws.checks.results) {
      if (r.status === 'running') {
        r.status = 'interrupted'
        delete r.exitCode
      }
    }
  }
  for (const repo of state.repos) migrateRepoFields(repo as Repo & Record<string, unknown>)
  // Before prefix types, the prefix was always a custom string.
  if (raw.branchPrefixType === undefined && typeof raw.branchPrefix === 'string') {
    state.settings.branchPrefixType = raw.branchPrefix ? 'custom' : 'none'
  }
  // The Permissions page's "auto permission mode" moved to Experimental unchanged; sounds kept their names.
  for (const session of state.sessions as (Session & { claudeSessionId?: string; permissionMode?: string })[]) {
    session.agent ??= 'claude'
    if (session.claudeSessionId && !session.agentSessionId) session.agentSessionId = session.claudeSessionId
    delete session.claudeSessionId
    if (!session.model) session.model = DEFAULT_MODEL[session.agent]
    session.fastMode ??= false
    session.planMode ??= session.permissionMode === 'plan'
    delete session.permissionMode
    session.queue ??= []
    // A scheduled run is only unattended while it runs; after a restart the chat is the human's.
    delete session.unattended
    // Waiting for an agent slot isn't remembered across a restart: the message stays in the tab's queue, held.
    delete session.waitingForSlot
    // O10: a turn handed to the background host may still be running there; it is adopted (or ended) after load.
    if (session.turnId && hosted.has(session.turnId)) continue
    // Nothing can be running after a restart. A turn that was is recorded as interrupted (see Store.load).
    if (session.status === 'running') {
      interrupted.push({ ...session })
      session.lastTurn = { outcome: 'interrupted', turnId: session.turnId, endedAt: session.lastActivityAt ?? new Date().toISOString() }
    }
    session.status = 'idle'
    session.turnId = undefined
    session.turnStartedAt = undefined
  }
  return interrupted
}

export class Store {
  state: PersistedState
  /** Open after load(). */
  db!: ForemanDb
  /** How foreman.db came to be: migrated from the JSON files, or created fresh. */
  migration?: MigrationInfo
  private saveTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(readonly dir: string) {
    this.state = { version: 2, repos: [], workspaces: [], sessions: [], comments: [], settings: defaultSettings(), catalog: { agents: {}, outputStyles: [] }, recentRepoPaths: [] }
  }

  private get statePath() {
    return path.join(this.dir, 'state.json')
  }

  get dbPath() {
    return path.join(this.dir, 'foreman.db')
  }

  logPath(name: string) {
    return path.join(this.dir, 'logs', name)
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await mkdir(path.join(this.dir, 'logs'), { recursive: true })
    const { info, moved } = await ensureDatabase(this.dir)
    this.migration = info
    this.db = new ForemanDb(this.dbPath)
    const rows = this.db.readRows()
    let raw: Record<string, unknown> = {}
    if (existsSync(this.statePath)) {
      const loaded = JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedState
      raw = loaded.settings as unknown as Record<string, unknown>
      // Whatever an older state.json says about workspaces, sessions and comments lives in the database now.
      this.state = { ...this.state, ...loaded, version: 2, workspaces: [], sessions: [], comments: [], settings: { ...defaultSettings(), ...loaded.settings } }
    }
    this.state.workspaces = rows.workspaces
    this.state.sessions = rows.sessions
    this.state.comments = rows.comments
    this.db.sweepOrphans()
    // #1: a check run still marked running means Foreman didn't quit cleanly (Quit records them itself).
    const crashedChecks = this.state.workspaces.filter((w) => w.checks?.running || w.checks?.results.some((r) => r.status === 'running')).map((w) => w.id)
    const scheduleMigrationNeeded = this.state.schedules?.some((s) => !s.recurrence || !s.startDate) ?? false
    const interrupted = migrate(this.state, raw as Settings & Record<string, unknown>)
    for (const session of interrupted) await this.markInterrupted(session)
    if (interrupted.length || crashedChecks.length) {
      // #1: what the crash stopped waits on Home for review; nothing is replayed.
      const now = new Date().toISOString()
      this.state.stopRecord = addStops(
        this.state.stopRecord,
        interrupted.flatMap((s) => (s.turnId ? [{ turnId: s.turnId, sessionId: s.id, workspaceId: s.workspaceId, cause: 'crash' as const, at: s.lastActivityAt ?? now, startedAt: s.turnStartedAt }] : [])),
        crashedChecks.map((workspaceId) => ({ workspaceId, cause: 'crash' as const, at: now }))
      )
      this.flush()
    }
    if (moved || scheduleMigrationNeeded) this.flush()
  }

  /** Append the closing item for a turn the app was quit during (the log is append-only). */
  private async markInterrupted(session: Session): Promise<void> {
    if (!session.turnId) return
    const id = `turn-end:${session.turnId}`
    if ((await this.readChat(session.id)).some((item) => item.id === id)) return
    await this.appendChat(session.id, {
      kind: 'turn-end',
      id,
      turnId: session.turnId,
      outcome: 'interrupted',
      error: 'Foreman closed while this turn was running.'
    })
  }

  /** Debounced save; call after every mutation. */
  save(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.writeState()
    }, 100)
  }

  /** What state.json holds: preferences and the lists around them, not the records in foreman.db. */
  private preferences(): string {
    const { workspaces: _w, sessions: _s, comments: _c, ...rest } = this.state
    return JSON.stringify(rest, null, 2)
  }

  private async writeState(): Promise<void> {
    if (this.closed) return
    this.db.syncRows(this.state)
    const tmp = `${this.statePath}.tmp`
    await writeFile(tmp, this.preferences())
    await rename(tmp, this.statePath)
  }

  /** Synchronous flush for app shutdown. */
  flush(): void {
    if (this.closed) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.db.syncRows(this.state)
    const tmp = `${this.statePath}.tmp`
    writeFileSync(tmp, this.preferences())
    renameSync(tmp, this.statePath)
  }

  /** Flush and let go of foreman.db (app quit, or a test finishing). */
  close(): void {
    this.flush()
    this.closed = true
    this.db.checkpoint()
    this.db.close()
  }

  /** Append (or update, by id) one chat item. */
  appendChat(sessionId: string, item: ChatItem): Promise<void> {
    try {
      this.db.putItem(sessionId, item)
      return Promise.resolve()
    } catch (err) {
      return Promise.reject(err)
    }
  }

  /** Make this the chat. Dropped items are kept as receipts, or whole with "Keep cleared history". */
  replaceChat(sessionId: string, items: ChatItem[]): Promise<void> {
    try {
      this.db.replaceItems(sessionId, items, this.state.settings.keepClearedHistory)
      return Promise.resolve()
    } catch (err) {
      return Promise.reject(err)
    }
  }

  /** The chat in order; an item written again keeps its first place and its last content. */
  async readChat(sessionId: string): Promise<ChatItem[]> {
    return this.db.readItems(sessionId)
  }

  /** Remove a chat that never ran. */
  deleteChat(sessionId: string): void {
    this.db.deleteItems(sessionId)
  }

  /** The "Keep cleared history" switch changed: turning it off drops what was kept. */
  keepClearedChanged(): void {
    if (!this.state.settings.keepClearedHistory) this.db.scrubCleared()
  }
}
