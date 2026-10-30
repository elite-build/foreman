import type { BrowserState } from '../../shared/browser'
import type { Attachment } from '../../shared/types'
// Renderer state: the main process pushes snapshots and events, components
// read slices through useStore.
import { useSyncExternalStore } from 'react'
import type { AdoptWorktreeOptions, AgentKind, AppSnapshot, ApprovalRequest, ArchiveProgressStep, Bridge, ChatHit, ChatItem, CheckConsentItem, NoteHit, CreateWorkspaceOptions, HandOffKind, MainEvent, PromptTemplate, Session, SessionPatch } from '../../shared/types'
import { AGENT_ORDER, setModelCatalog, type ModelCatalog } from '../../shared/agents'
import { pickerAgents } from '../../shared/agentPicker'
import type { AgentPrefs } from '../../shared/agentCatalog'
import { chatToMarkdown } from '../../shared/transcript'
import { chooseStartLoadout } from '../../shared/startModel'
import { hasNote } from '../../shared/note'
import { chooseSnippetTarget, makeSnippet, type SnippetSource, type TerminalSnippet } from '../../shared/terminalSnippet'
import { narratedNotice } from './agentStatus'
import { playCompletionSound } from './sound'
import { PtyEventRouter } from './ptyEvents'
import { archivedTabs, hitRoute } from './archivedView'
import type { SidebarFilter, SidebarView } from './triage'
import { DEFAULT_TILE_COUNT, tileCountOf, type TileCount } from './tiles'
import { editorViewOf, pickEditorView, type EditorView } from './editorLayout'
import type { AttentionEvent } from '../../shared/attention'
import { routeLink, workspaceLink, type LinkRoute } from '../../shared/deepLink'
import { createT, resolveLocale, type Locale } from '../../shared/i18n'
import { timeAgo as formatAgo, timeWaited as formatWaited } from '../../shared/i18n/time'
import type { PersonalSection, RepoSection } from '../../shared/settingsRegistry'
import { settingEntry, type AssistantState } from '../../shared/assistant'
import { tourSteps } from '../../shared/tour'
import type { OnboardingMilestone } from '../../shared/onboarding'
import { isNotGitRepoError, type GitIdentity } from '../../shared/types'
import { shareUnchanged } from '../../shared/reconcile'
import { appendToItems } from '../../shared/chatAppend'

export type Overlay = 'palette' | 'quick-open' | 'search' | 'shortcuts' | 'archived' | 'open-in' | 'ask'

export type { PersonalSection, RepoSection }

/**
 * Which settings page is open (null = settings closed). `scrollTo` names a
 * row id (see settings/registry.ts) to scroll to and highlight.
 */
export type AgentsSubpage = 'catalog' | 'signin' | 'keys'

/** The merged header's archive button: archive and keep the branch, or archive and delete it. */
export type ArchiveChoice = 'archive' | 'delete-branch'

/** An archive running in the background, for the sidebar row and the header: the step main last started, or stopped on a failure. */
export interface ArchiveRun {
  stopped: boolean
  step: ArchiveProgressStep | null
}

const archiveChoiceOf = (value: unknown): ArchiveChoice | null => (value === 'archive' || value === 'delete-branch' ? value : null)

export type SettingsPage = (
  | { section: PersonalSection }
  // #22: `agent` is a catalog id (any level), or one of the Agents pages: 'catalog', 'signin', 'keys'.
  | { section: 'agents'; agent?: AgentKind | AgentsSubpage | string }
  | { section: 'repo'; repoId: string; tab?: RepoSection }
) & { scrollTo?: string }

declare global {
  interface Window {
    foreman: Bridge
  }
}

export const bridge = window.foreman
export const api = bridge.invoke

interface State {
  browserTabs: Record<string, { url: string; request: number; active: boolean; split: boolean; state?: BrowserState }>
  browserAddressRequest: { workspaceId: string; nonce: number } | null
  snapshot: AppSnapshot | null
  chats: Record<string, ChatItem[]>
  approvals: ApprovalRequest[]
  setupLogs: Record<string, string>
  selectedWorkspaceId: string | null
  // The chat tab shown in each workspace.
  activeSession: Record<string, string>
  chatRequest: { workspaceId: string; nonce: number } | null
  // A message to scroll to once its chat is on screen (from search).
  chatJump: { sessionId: string; itemId: string; nonce: number } | null
  // Workspaces and chats whose agent finished while the user was looking elsewhere.
  unread: Record<string, true>
  unreadSessions: Record<string, true>
  // What the sidebar lists: one repository (null = all), a filter and a search.
  sidebarView: SidebarView
  leftPanelOpen: boolean
  rightPanelOpen: boolean
  // The Tiles layout: the workspaces on screen in tile order, how many tiles there are, and the one opened full size.
  tiles: string[]
  tileCount: TileCount
  tileZoom: string | null
  // The Editor layout: what the activity bar shows in the sidebar.
  editorView: EditorView
  // The Run / Setup / Terminal panel, wherever the layout puts it.
  bottomPanelOpen: boolean
  // The workspace whose terminal panel fills its area (O3), until Esc or ⌘⇧J.
  terminalFullscreen: string | null
  // OpenCode is only offered once it is installed.
  opencodeInstalled: boolean
  backgroundArchives: string[]
  // The archives in backgroundArchives, by workspace, as they go.
  archiveRuns: Record<string, ArchiveRun>
  archiveTarget: string | null
  // The archive dialog opens with "Delete branch" already chosen (the merged header's menu).
  archiveDeleteBranch: boolean
  // What the archive dialog last did where it offered the choice; the merged header's button runs it next time.
  // Null until the first such archive.
  archiveChoice: ArchiveChoice | null
  // The chat whose MCP status dialog is open.
  mcpStatusSession: string | null
  // The Second opinion / Continue dialog, open for this chat.
  // #2: `prefill` is what an agent asked to have checked (`foreman review`), from Home's row; `reportId` is that request.
  // #17 readOnly: Access → Read-only starts ticked (an auto review's "Review again…").
  handOffDialog: { sourceId: string; kind: HandOffKind; prefill?: string; reportId?: string; readOnly?: boolean } | null
  // Export… for one workspace, or Import….
  portDialog: { kind: 'export'; workspaceId: string } | { kind: 'import' } | null
  // "Run a new check command?": commands waiting for the user's approval.
  checksConsent: { workspaceId: string; items: CheckConsentItem[] } | null
  // "Fix in chat…" for this workspace's failing checks.
  fixChecksFor: string | null
  // "Fix CI in…" for this workspace's failing pull-request checks.
  fixCiFor: string | null
  resolveBaseFor: string | null
  // Compare models: "Also try with…" / "Compare…" for this workspace, and "Archive others" for a comparison.
  compareDialog: { workspaceId: string; sessionId?: string; prompt?: string } | null
  compareArchive: { compareId: string; keepWorkspaceId: string } | null
  // Template menu → Schedule…: a new schedule for a template, or Review… of an existing one.
  scheduleDialog: { templateId: string } | { scheduleId: string } | null
  // Hand off to another Mac: the dialog for a workspace (and the hand-off once started), and Reconcile for an unresolved one.
  handOffToDialog: { workspaceId: string; transferId?: string } | null
  reconcileDialog: string | null
  pairDialog: 'show' | 'enter' | null
  // "This repo proposes N MCP servers" for this workspace.
  mcpConsent: string | null
  // Show the Git panel's checks tab for this workspace.
  checksPanelRequest: { workspaceId: string; nonce: number } | null
  // The start-to-end diff of a sensitive-files alert.
  alertDiff: { workspaceId: string; alertId: string } | null
  // Text for a chat's composer to pick up ("Tell agent…"), or a terminal selection to add as a draft block.
  // `edited` (#16): the text is a message being edited and resent, from the chat titled `from`.
  composerFill: { sessionId: string; text: string; templateId?: string; attachments?: Attachment[]; snippet?: TerminalSnippet; edited?: EditedFrom; nonce: number } | null
  settingsPage: SettingsPage | null
  // The Automations page (templates and schedules), with the template ("t:<id>") or schedule ("s:<id>") it shows.
  automations: { selected: string | null; scrollTo?: 'commands' } | null
  // Phone pill → Network setup…: same-Wi-Fi address and private (Tailscale) access.
  phoneSetupOpen: boolean
  // Help → Report a problem… / ⌘K (O20).
  reportProblemOpen: boolean
  // G4 O20: the error toast it was opened from ("Report…"), which fills in What happened.
  reportProblemAbout: string | null
  overlay: Overlay | null
  // A request for a workspace to show a file (from quick open or search).
  fileRequest: { workspaceId: string; path: string; line?: number; nonce: number } | null
  toast: Toast | null
  // The New workspace dialog, open for this repository.
  newWorkspaceRepo: string | null
  // Text the New workspace dialog starts with ("Start workspace with this answer"), and the template it came from.
  newWorkspacePrompt: string | null
  newWorkspaceTemplate: string | null
  // Add repository dialogs: clone from GitHub / a URL, or start a new one.
  addRepoDialog: 'clone' | 'quick-start' | null
  // A folder that isn't a Git repository, with the offer to make it one (MakeRepoDialog).
  makeRepoDir: string | null
  // Workspace id → nonce, bumped when setup finished and the run script should start.
  autoRun: Record<string, number>
  // #3: Home → Recent's history, newest first, and when it was last marked seen.
  attentionHistory: { events: AttentionEvent[]; seenAt?: string }
  // The assistant view covers the workspace area like Settings and Automations.
  assistantOpen: boolean
  // The thread shown (null: a new conversation).
  assistantThreadId: string | null
  // Whether it can run, and its threads (null until first asked).
  assistant: AssistantState | null
  assistantItems: Record<string, ChatItem[]>
  // A reply finished while the view was closed.
  assistantUnread: boolean
  // The Ask Foreman overlay's own assistant thread: created by its first question, kept for the rest of the run.
  askThreadId: string | null
  // The welcome tour: this run's step ids (optional ones left out when absent) and the one showing.
  tour: { steps: string[]; index: number } | null
  // Settings was opened from the assistant: it shows "Back to Assistant".
  assistantReturn: boolean
  // The window isn't minimized or hidden (main's window-visibility). While it is, components don't re-render: see flushStore.
  windowVisible: boolean
}

// Small UI preferences survive restarts; storage can be unavailable.
function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`switchyard:${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`switchyard:${key}`, JSON.stringify(value))
  } catch {
    // Not persisted; fine.
  }
}

let state: State = {
  browserTabs: {},
  browserAddressRequest: null,
  snapshot: null,
  chats: {},
  approvals: [],
  setupLogs: {},
  selectedWorkspaceId: null,
  activeSession: loadPref('activeSession', {}),
  chatRequest: null,
  chatJump: null,
  unread: {},
  unreadSessions: {},
  sidebarView: { repo: loadPref('sidebarRepo', null), filter: loadPref('sidebarFilter', 'all'), query: '', showFinished: loadPref('showFinished', false) },
  leftPanelOpen: loadPref('leftPanelOpen', true),
  tiles: loadPref<string[]>('tiles', []),
  tileCount: tileCountOf(loadPref('tileCount', DEFAULT_TILE_COUNT)),
  tileZoom: null,
  editorView: editorViewOf(loadPref('editorView', 'workspaces')),
  rightPanelOpen: loadPref('rightPanelOpen', true),
  bottomPanelOpen: loadPref('bottomPanelOpen', true),
  terminalFullscreen: null,
  opencodeInstalled: false,
  backgroundArchives: [],
  archiveRuns: {},
  archiveTarget: null,
  archiveDeleteBranch: false,
  archiveChoice: archiveChoiceOf(loadPref<unknown>('archiveChoice', null)),
  mcpStatusSession: null,
  handOffDialog: null,
  portDialog: null,
  checksConsent: null,
  fixChecksFor: null,
  fixCiFor: null,
  resolveBaseFor: null,
  compareDialog: null,
  scheduleDialog: null,
  handOffToDialog: null,
  reconcileDialog: null,
  pairDialog: null,
  compareArchive: null,
  mcpConsent: null,
  checksPanelRequest: null,
  alertDiff: null,
  composerFill: null,
  settingsPage: null,
  automations: null,
  phoneSetupOpen: false,
  reportProblemOpen: false,
  reportProblemAbout: null,
  overlay: null,
  fileRequest: null,
  toast: null,
  newWorkspaceRepo: null,
  newWorkspacePrompt: null,
  newWorkspaceTemplate: null,
  addRepoDialog: null,
  makeRepoDir: null,
  autoRun: {},
  attentionHistory: { events: [] },
  assistantOpen: false,
  assistantThreadId: null,
  assistant: null,
  assistantItems: {},
  assistantUnread: false,
  askThreadId: null,
  assistantReturn: false,
  tour: null,
  windowVisible: true
}
const listeners = new Set<() => void>()
// Hear every change at once, whether or not components are told (a batch waiting for its frame, a hidden window).
const liveListeners = new Set<() => void>()

// What components render from: `state` as of the last notification. getState() reads `state` itself, which
// events from main update at once; components hear about those changes at most once a frame.
let published = state
// Above zero while an event from main is handled: its changes notify on the next frame, not straight away.
let batching = 0
let pendingFrame: number | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null
// A hidden window (or jsdom) may not run animation frames, so a timer flushes too.
const FLUSH_FALLBACK_MS = 100

function setState(patch: Partial<State>): void {
  const before = state
  state = { ...state, ...patch }
  if (before.unread !== state.unread || before.unreadSessions !== state.unreadSessions) updateDockBadge()
  for (const listener of liveListeners) listener()
  // Ten agents streaming send hundreds of events a second; anything the user did shows at once.
  if (batching > 0) scheduleFlush()
  else flushStore()
}

function scheduleFlush(): void {
  if (pendingTimer !== null || held()) return
  pendingTimer = setTimeout(flushStore, FLUSH_FALLBACK_MS)
  if (typeof requestAnimationFrame === 'function') pendingFrame = requestAnimationFrame(flushStore)
}

/**
 * A minimized or hidden window draws nothing anyone sees, so components hear nothing while it is: what changes (streaming
 * chats, every state) waits, and they catch up in one render when it is shown again. Nothing moves or is hidden meanwhile,
 * so focus, scroll positions and terminals stay as they were. Components hear that it went hidden, then nothing more.
 */
const held = () => !state.windowVisible && !published.windowVisible

/** Tell components about every change so far. Events from main wait for the next frame; tests can call this instead. */
export function flushStore(): void {
  if (pendingTimer !== null) clearTimeout(pendingTimer)
  if (pendingFrame !== null) cancelAnimationFrame(pendingFrame)
  pendingTimer = pendingFrame = null
  if (published === state || held()) return
  published = state
  for (const listener of listeners) listener()
}

/** Main's window-visibility (or the window gaining focus, which it can't while unseen). */
function setWindowVisible(visible: boolean): void {
  if (state.windowVisible === visible) return
  // Endless animations (spinners, the streaming cursor) pause on this: ui/css/spinner.css, styles/chat.css.
  document.documentElement.toggleAttribute('data-window-hidden', !visible)
  setState({ windowVisible: visible })
  flushStore()
}

/** Whether the window can be seen; components re-render when it changes (to pause their clocks, for instance). */
export function useWindowVisible(): boolean {
  return useStore((s) => s.windowVisible)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Called on every change to the state, straight away, even while components hear nothing (a minimized window): for what
 * must happen as things change rather than when they are drawn, such as the sound and voice for an agent that finished.
 * Read the state with getState(). Keep the listener cheap; streaming chats change the state hundreds of times a second.
 */
export function subscribeLive(listener: () => void): () => void {
  liveListeners.add(listener)
  return () => liveListeners.delete(listener)
}

/** Selectors must return existing references (state slices), not new objects. */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(published))
}

export const getState = () => state

function catalogModels(snapshot: AppSnapshot): ModelCatalog {
  // #22: Chat agents appear once they've been asked for their models.
  const agents = [...new Set([...AGENT_ORDER, ...(Object.keys(snapshot.catalog.agents) as AgentKind[])])]
  return Object.fromEntries(agents.map((a) => [a, snapshot.catalog.agents[a]?.models ?? []]))
}

/** #3: main counts what Home counts for the tray and the dock badge, so it hears what is unread here. */
function updateDockBadge(): void {
  bridge.send.setUnread(Object.keys(state.unread), Object.keys(state.unreadSessions))
}

// ---- terminal data goes straight to the terminal that owns it ----

const ptyEvents = new PtyEventRouter()
export const listenPty = ptyEvents.listen.bind(ptyEvents)

// ---- chat tabs ----

export function openSessions(snapshot: AppSnapshot, workspaceId: string): Session[] {
  return snapshot.sessions.filter((s) => s.workspaceId === workspaceId && !s.closedAt)
}

/** The chat tab to show for a workspace: the remembered one if still open, else the first. */
export function activeSessionId(s: State, workspaceId: string): string | undefined {
  if (!s.snapshot) return undefined
  const remembered = s.activeSession[workspaceId]
  // An archived workspace read-only (#13) can show a closed tab a search result pointed at, without reopening it.
  const archived = s.snapshot.workspaces.some((w) => w.id === workspaceId && w.state === 'archived')
  const open = archived ? archivedTabs(s.snapshot.sessions, workspaceId, remembered) : openSessions(s.snapshot, workspaceId)
  return open.find((x) => x.id === remembered)?.id ?? open[0]?.id
}

function isViewing(sessionId: string, workspaceId: string, browserTabs = state.browserTabs): boolean {
  return (
    document.hasFocus() &&
    state.selectedWorkspaceId === workspaceId &&
    activeSessionId(state, workspaceId) === sessionId &&
    !state.settingsPage &&
    (!browserTabs[workspaceId]?.active || browserTabs[workspaceId]?.split)
  )
}

export function selectSession(workspaceId: string, sessionId: string): void {
  selectBrowserTab(workspaceId, false)
  const activeSession = { ...state.activeSession, [workspaceId]: sessionId }
  const unreadSessions = { ...state.unreadSessions }
  delete unreadSessions[sessionId]
  savePref('activeSession', activeSession)
  setState({ activeSession, unreadSessions, chatRequest: { workspaceId, nonce: Date.now() } })
}

/** Fork a chat into a new tab (after one of its answers, or its latest) and switch to it. */
export async function forkChat(workspaceId: string, sessionId: string, turnId?: string): Promise<Session | undefined> {
  const fork = await attempt(() => api.forkSession(sessionId, turnId))
  if (fork) selectSession(workspaceId, fork.id)
  return fork
}

/** #16: where an edited message came from, for the composer's "Edited from your message in …" bar. */
export interface EditedFrom {
  // The source chat's title, if it has one.
  from?: string
  original: string
}

/**
 * #16 Edit and resend: fork from just before this message (the chat's first message opens a new chat)
 * and put its text in the new tab's composer. Nothing is sent, and the original chat stays as it is.
 */
export async function editAndResend(workspaceId: string, sessionId: string, message: { turnId: string; text: string }): Promise<Session | undefined> {
  const fork = await attempt(() => api.forkSession(sessionId, message.turnId, { before: true }))
  if (!fork) return undefined
  const from = state.snapshot?.sessions.find((s) => s.id === sessionId)?.title
  selectSession(workspaceId, fork.id)
  setState({ composerFill: { sessionId: fork.id, text: message.text, edited: { from, original: message.text }, nonce: ++composerFillCounter } })
  return fork
}

export async function newChat(workspaceId: string, patch?: SessionPatch): Promise<Session | undefined> {
  // A workspace with a note offers it to the new tab (the checkbox above the composer turns it off).
  const note = state.snapshot?.workspaces.find((w) => w.id === workspaceId)?.note
  const withNote = hasNote(note) ? { includeNote: true, ...patch } : patch
  const session = await attempt(() => api.createSession(workspaceId, withNote))
  if (session) selectSession(workspaceId, session.id)
  return session
}

export async function closeChat(workspaceId: string, sessionId: string): Promise<void> {
  const session = state.snapshot?.sessions.find((s) => s.id === sessionId)
  if (session?.status === 'running' && !window.confirm(tNow()('app.closeRunningChat'))) return
  const open = state.snapshot ? openSessions(state.snapshot, workspaceId) : []
  const index = open.findIndex((s) => s.id === sessionId)
  const neighbour = open[index + 1] ?? open[index - 1]
  await attempt(() => api.closeSession(sessionId))
  if (neighbour) selectSession(workspaceId, neighbour.id)
}

export async function reopenChat(workspaceId: string, sessionId?: string): Promise<void> {
  const session = await attempt(() => api.reopenSession(workspaceId, sessionId))
  if (session) selectSession(workspaceId, session.id)
}

let jumpCounter = 0

/**
 * Open the tab a search hit came from and scroll to the message. A closed tab in a live workspace is
 * reopened first; an archived workspace's chat opens read-only (#13), with nothing restored or reopened.
 */
export async function openChatHit(hit: ChatHit): Promise<void> {
  const route = hitRoute(hit)
  if (route === 'reopen') {
    if (!(await attempt(() => api.reopenSession(hit.workspaceId, hit.sessionId)))) return
  }
  setState({ chatJump: { sessionId: hit.sessionId, itemId: hit.itemId, nonce: ++jumpCounter } })
  if (route === 'read-only') return openArchivedChats(hit.workspaceId, hit.sessionId)
  setState({ overlay: null, settingsPage: null })
  selectWorkspace(hit.workspaceId)
  selectSession(hit.workspaceId, hit.sessionId)
}

/** Open the workspace a note result belongs to (read-only when archived, #13). */
export async function openNoteHit(hit: NoteHit): Promise<void> {
  if (hitRoute(hit) === 'read-only') return openArchivedChats(hit.workspaceId)
  setState({ overlay: null, settingsPage: null })
  selectWorkspace(hit.workspaceId)
}

// #13
/**
 * Read an archived workspace's chats without restoring it. Only the renderer changes: nothing is
 * asked of main, so no worktree, setup, agent, git, terminal or watcher work starts.
 */
export function openArchivedChats(workspaceId: string, sessionId?: string): void {
  setState({ overlay: null, settingsPage: null })
  selectWorkspace(workspaceId)
  if (sessionId) selectSession(workspaceId, sessionId)
}

/** Restore an archived workspace (the existing restore: worktree, setup) and show it, now live. False if it failed. */
export async function restoreArchived(workspaceId: string): Promise<boolean> {
  const ok = await attempt(async () => (await api.unarchiveWorkspace(workspaceId), true))
  if (!ok) return false
  setState({ overlay: null })
  selectWorkspace(workspaceId)
  return true
}

export function clearChatJump(nonce: number): void {
  if (state.chatJump?.nonce === nonce) setState({ chatJump: null })
}

// ---- events from the main process ----

function upsert(items: ChatItem[], item: ChatItem): ChatItem[] {
  // A streaming item is nearly always the last one, so look from the end.
  let index = items.length - 1
  while (index >= 0 && items[index].id !== item.id) index--
  if (index === -1) return [...items, item]
  const next = items.slice()
  next[index] = item
  return next
}

/** Mark chats (and their workspaces) whose agent just went idle while not on screen. */
function trackUnread(previous: AppSnapshot | null, next: AppSnapshot, browserTabs = state.browserTabs): Pick<State, 'unread' | 'unreadSessions'> {
  let { unread, unreadSessions } = state
  if (!previous) return { unread, unreadSessions }
  for (const session of next.sessions) {
    const before = previous.sessions.find((s) => s.id === session.id)
    if (before?.status !== 'running' || session.status !== 'idle') continue
    if (isViewing(session.id, session.workspaceId, browserTabs)) continue
    unreadSessions = { ...unreadSessions, [session.id]: true }
    if (state.selectedWorkspaceId !== session.workspaceId || !document.hasFocus()) {
      unread = { ...unread, [session.workspaceId]: true }
    }
  }
  return { unread, unreadSessions }
}

function notify(event: Extract<MainEvent, { type: 'notify' }>): void {
  const settings = state.snapshot?.settings
  if (!settings) return
  // O13b: main's text is in the user's language; `kind` says what it is.
  const finished = event.kind === 'finished'
  // With sound cues on, the status-event site plays the cue for a finished turn or a request, so this sound is not added to it.
  if (finished || !isViewing(event.sessionId, event.workspaceId)) playCompletionSound(settings, event)
  if (!settings.notifications || isViewing(event.sessionId, event.workspaceId)) return
  if (event.kind === 'stopped') return
  try {
    // E2: the narrator's sentence for a finished turn or a request that needs the user (the workspace's name as the title).
    const text = narratedNotice(tNow(), event, state.snapshot?.sessions ?? [], state.snapshot?.workspaces ?? [], state.approvals)
    const notification = new Notification(text.title, { body: text.body, silent: true })
    notification.onclick = () => {
      window.focus()
      // G4 O17: a keep-awake cutoff opens its setting.
      if (event.action === 'keep-awake') return openSettingsPage({ section: 'general', scrollTo: 'keep-awake' })
      openSettingsPage(null)
      selectWorkspace(event.workspaceId)
      if (event.sessionId) selectSession(event.workspaceId, event.sessionId)
      if (event.action === 'fix-ci') openFixCi(event.workspaceId)
    }
  } catch {
    // Notifications unavailable; the sidebar still shows the state.
  }
}

// `foreman run --open` workspace that arrived before the first snapshot.
let revealOnLoad: string | null = null
// #3: a foreman:// link or tray entry that arrived before the first snapshot.
let navigateOnLoad: Extract<MainEvent, { type: 'open-link' | 'navigate' }> | null = null

/** Outside React, in the language Settings picked (store.ts can't use i18n.ts, which reads the store). */
function localeNow(): Locale {
  const languages = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]
  return resolveLocale(state.snapshot?.settings.language, languages)
}
function tNow() {
  return createT(localeNow())
}

/**
 * #3: go where a foreman:// link's route says. Only the renderer moves: nothing is asked of main, so a link
 * never sends, approves, runs or restores anything. Archived opens read-only (#13); missing goes Home and says so.
 */
export function applyLinkRoute(route: LinkRoute): void {
  setState({ overlay: null, settingsPage: null, automations: null, assistantOpen: false })
  if (route.kind === 'home') selectWorkspace(null)
  else if (route.kind === 'archived') openArchivedChats(route.workspaceId, route.sessionId)
  else {
    selectWorkspace(route.workspaceId)
    if (route.sessionId) selectSession(route.workspaceId, route.sessionId)
  }
  if (route.notice) showToast(tNow()(`attention.link.notice.${route.notice}`))
}

/** #3: a foreman:// link, routed against what is here now. */
export function openLink(url: string): void {
  if (!state.snapshot) return
  applyLinkRoute(routeLink(url, state.snapshot))
}

/** #3: a tray entry: this workspace (and tab), or Home. */
function navigateTo(workspaceId?: string, sessionId?: string): void {
  const ws = workspaceId ? state.snapshot?.workspaces.find((w) => w.id === workspaceId) : undefined
  if (!ws) return applyLinkRoute({ kind: 'home' })
  applyLinkRoute(ws.state === 'archived' ? { kind: 'archived', workspaceId: ws.id, sessionId } : { kind: 'workspace', workspaceId: ws.id, sessionId })
}

/** #3 Copy link: foreman://workspace/<repo>/<workspace>?tab=N for a workspace and, when given, one of its tabs. */
export function copyWorkspaceLink(workspaceId: string, sessionId?: string): void {
  const snapshot = state.snapshot
  const ws = snapshot?.workspaces.find((w) => w.id === workspaceId)
  const repo = ws && snapshot?.repos.find((r) => r.id === ws.repoId)
  if (!snapshot || !ws || !repo) return
  const open = openSessions(snapshot, workspaceId)
  const tabId = sessionId ?? activeSessionId(state, workspaceId)
  const index = open.findIndex((s) => s.id === tabId)
  const url = workspaceLink(repo.name, ws.name, index >= 0 ? index + 1 : undefined)
  void navigator.clipboard.writeText(url).then(
    () => showToast(tNow()('attention.link.copied', { url })),
    (err: unknown) => showError(err)
  )
}

/** #3: Home → Recent's "Mark all seen". Nothing else changes: no reason clears. */
export async function markAttentionSeen(): Promise<void> {
  await attempt(() => api.markAttentionSeen())
}

/** Browser tabs of workspaces still live; the same object when none went away, so nothing re-renders for it. */
function liveBrowserTabs(snapshot: AppSnapshot): State['browserTabs'] {
  const live = Object.entries(state.browserTabs).filter(([id]) => snapshot.workspaces.some((w) => w.id === id && w.state !== 'archived' && w.state !== 'history'))
  return live.length === Object.keys(state.browserTabs).length ? state.browserTabs : Object.fromEntries(live)
}

/** An event from main: its changes apply now and reach components on the next frame, with the others that arrive by then. */
function receiveEvent(event: MainEvent): void {
  batching++
  try {
    handleEvent(event)
  } finally {
    batching--
  }
}

function handleEvent(event: MainEvent): void {
  switch (event.type) {
    case 'browser-open':
      openBrowserTab(event.workspaceId, event.url)
      return
    case 'browser-state': {
      const tab = state.browserTabs[event.workspaceId]
      if (tab) setState({ browserTabs: { ...state.browserTabs, [event.workspaceId]: { ...tab, state: event.state } } })
      return
    }
    case 'browser-shortcut':
      if (event.action === 'close') closeBrowserTab(event.workspaceId)
      else focusBrowserAddress(event.workspaceId)
      return
    case 'state': {
      // Unchanged workspaces, sessions, settings… keep their objects, so only what changed re-renders; an identical
      // snapshot changes nothing at all.
      const snapshot = shareUnchanged(state.snapshot, event.snapshot)
      if (snapshot === state.snapshot) return
      const browserTabs = liveBrowserTabs(snapshot)
      if (snapshot.catalog !== state.snapshot?.catalog) setModelCatalog(catalogModels(snapshot))
      setState({ browserTabs, snapshot, ...trackUnread(state.snapshot, snapshot, browserTabs) })
      return
    }
    case 'chat-item': {
      const items = state.chats[event.sessionId]
      if (items) setState({ chats: { ...state.chats, [event.sessionId]: upsert(items, event.item) } })
      return
    }
    case 'chat-append': {
      // More text for a streaming preview. One that doesn't continue what is held (missed while the chat loaded)
      // is skipped: the preview comes whole again within seconds, and the finished item replaces it.
      const items = state.chats[event.sessionId]
      const next = items && appendToItems(items, event)
      if (next) setState({ chats: { ...state.chats, [event.sessionId]: next } })
      return
    }
    case 'chat-reset':
      setState({ chats: { ...state.chats, [event.sessionId]: event.items } })
      return
    case 'approval':
      setState({ approvals: [...state.approvals.filter((a) => a.id !== event.request.id), event.request] })
      return
    case 'approval-resolved':
      setState({ approvals: state.approvals.filter((a) => a.id !== event.id) })
      return
    case 'setup-log': {
      const log = state.setupLogs[event.workspaceId]
      if (log !== undefined) setState({ setupLogs: { ...state.setupLogs, [event.workspaceId]: log + event.chunk } })
      return
    }
    case 'pty-data':
      ptyEvents.dispatch(event.ptyId, { data: event.data })
      return
    case 'pty-exit':
      ptyEvents.dispatch(event.ptyId, { code: event.code })
      return
    case 'pty-state':
      ptyEvents.dispatch(event.ptyId, { asleep: event.asleep, ...(event.reason ? { reason: event.reason } : {}) })
      return
    case 'notify':
      notify(event)
      return
    case 'clone-progress':
      cloneListeners.get(event.cloneId)?.(event.line)
      return
    case 'show-workspace':
      // A window opened for this asks before its first snapshot arrives; initStore picks it up.
      if (!state.snapshot) revealOnLoad = event.workspaceId
      else {
        openSettingsPage(null)
        selectWorkspace(event.workspaceId)
      }
      return
    case 'show-setting':
      if (state.snapshot) showSettingFromAssistant(event.id)
      return
    case 'report-problem':
      openReportProblem(true)
      return
    case 'tour':
      if (state.snapshot) startTour()
      return
    // #3
    case 'open-link':
    case 'navigate':
      if (!state.snapshot) navigateOnLoad = event
      else if (event.type === 'open-link') openLink(event.url)
      else navigateTo(event.workspaceId, event.sessionId)
      return
    case 'attention-history':
      setState({ attentionHistory: { events: event.events, ...(event.seenAt ? { seenAt: event.seenAt } : {}) } })
      return
    case 'auto-run':
      setState({ autoRun: { ...state.autoRun, [event.workspaceId]: (state.autoRun[event.workspaceId] ?? 0) + 1 } })
      return
    case 'assistant-item': {
      const items = state.assistantItems[event.threadId] ?? []
      const turnEnd = event.item.kind === 'turn-end'
      // The Ask overlay shows its own answers, so they never light the assistant's unread dot.
      const unread = turnEnd && event.threadId !== state.askThreadId && !(state.assistantOpen && state.assistantThreadId === event.threadId && document.hasFocus())
      // A finished turn frees its thread here too, whatever order the thread list arrives in.
      const assistant = turnEnd && state.assistant
        ? { ...state.assistant, threads: state.assistant.threads.map((th) => (th.id === event.threadId ? { ...th, running: false } : th)) }
        : state.assistant
      setState({ assistantItems: { ...state.assistantItems, [event.threadId]: upsert(items, event.item) }, assistant, ...(unread ? { assistantUnread: true } : {}) })
      return
    }
    case 'assistant-threads':
      assistantThreadsSeen++
      if (state.assistant) setState({ assistant: { ...state.assistant, threads: event.threads } })
      return
    // Cloud workspaces: a repository's base build streams its output to whoever shows its log.
    case 'cloud-build-log':
      for (const listener of buildLogListeners) listener(event.repoId, event.buildId, event.chunk)
      return
    case 'window-visibility':
      setWindowVisible(event.visible)
      return
    case 'archive-progress': {
      const run = state.archiveRuns[event.workspaceId]
      if (run && !run.stopped && event.progress.status === 'running')
        setState({ archiveRuns: { ...state.archiveRuns, [event.workspaceId]: { ...run, step: event.progress.step } } })
      return
    }
  }
}

const buildLogListeners = new Set<(repoId: string, buildId: string, chunk: string) => void>()

/** Cloud workspaces: chunks of a repository's cloud computer build as they arrive (the repository's own record keeps the tail). */
export function onCloudBuildLog(listener: (repoId: string, buildId: string, chunk: string) => void): () => void {
  buildLogListeners.add(listener)
  return () => buildLogListeners.delete(listener)
}

export async function initStore(): Promise<void> {
  bridge.onEvent(receiveEvent)
  // A window that has focus is on screen, whatever main last said.
  window.addEventListener('focus', () => setWindowVisible(true))
  const [snapshot, approvals] = await Promise.all([api.getSnapshot(), api.pendingApprovals()])
  setModelCatalog(catalogModels(snapshot))
  const lastSelected = loadPref<string | null>('selectedWorkspaceId', null)
  const active = snapshot.workspaces.filter((w) => w.state !== 'archived')
  const selected = active.find((w) => w.id === revealOnLoad) ?? active.find((w) => w.id === lastSelected) ?? active[0]
  revealOnLoad = null
  setState({ snapshot, approvals, selectedWorkspaceId: selected?.id ?? null })
  // #3: the history for Home → Recent, and a link or tray entry that came first.
  void api.attentionHistory().then((attentionHistory) => setState({ attentionHistory }), () => undefined)
  const pending = navigateOnLoad
  navigateOnLoad = null
  if (pending?.type === 'open-link') openLink(pending.url)
  else if (pending) navigateTo(pending.workspaceId, pending.sessionId)
  void refreshOpencode()
}

export async function refreshOpencode(): Promise<void> {
  const status = await api.agentStatus('opencode').catch(() => null)
  setState({ opencodeInstalled: Boolean(status?.installed) })
}

/** Agents offered in the picker: Claude and Codex always, others once set up. #22: only enabled ones (Settings → Agents). */
// Cached so components can select it without re-rendering forever.
let agentsCache: { cursor: boolean; opencode: boolean; prefs: AgentPrefs | undefined; value: Record<AgentKind, boolean> } | null = null
export function availableAgents(s: State): Record<AgentKind, boolean> {
  const cursor = s.snapshot?.agentKeys.CURSOR_API_KEY !== undefined
  const opencode = s.opencodeInstalled
  const prefs = s.snapshot?.settings.agentPrefs
  if (agentsCache?.cursor !== cursor || agentsCache.opencode !== opencode || agentsCache.prefs !== prefs) {
    agentsCache = { cursor, opencode, prefs, value: pickerAgents(prefs, { cursor, opencode }) }
  }
  return agentsCache.value
}

// ---- actions ----

let toastCounter = 0
export function showError(err: unknown): void {
  showToast(err instanceof Error ? err.message : String(err), 'error')
}

/** A button on a toast (#21 Undo). Running it dismisses the toast. */
export interface ToastAction {
  label: string
  run: () => void | Promise<void>
}

export interface ToastOptions {
  /** One button, e.g. Undo. */
  action?: ToastAction
  /** Several buttons, shown after `action`. */
  actions?: ToastAction[]
  /** How long it stays. Defaults to 6 s, or 10 s when it has a button. */
  durationMs?: number
  /** G4 O20: error toasts end with a "Report…" link unless this is false. */
  report?: boolean
  /** The announcer already said these words: show the toast, but outside the live regions so they are not read twice. */
  silent?: boolean
}

/**
 * G4 O20: an error toast gets a "Report…" link (after its own buttons) that opens Report a problem with the error
 * filled in. It keeps the plain toast's 6 s unless it has buttons of its own. Pure, for tests.
 */
export function withReportLink(text: string, kind: 'info' | 'error', options: ToastOptions | undefined, label: string, open: (about: string) => void): ToastOptions | undefined {
  if (kind !== 'error' || options?.report === false) return options
  const own = Boolean(options?.action || options?.actions?.length)
  return { ...options, actions: [...(options?.actions ?? []), { label, run: () => open(text) }], durationMs: options?.durationMs ?? (own ? undefined : 8000) }
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
  actions?: ToastAction[]
  // Already said by the announcer: ToastHost renders it outside the live regions.
  silent?: boolean
}

/** Build a toast. Pure, so the action handling can be tested without timers or a DOM. */
export function makeToast(id: number, text: string, kind: 'info' | 'error', options?: ToastOptions): { toast: Toast; durationMs: number } {
  const actions = [...(options?.action ? [options.action] : []), ...(options?.actions ?? [])]
  const toast: Toast = { id, text, kind, ...(actions.length > 0 && { actions }), ...(options?.silent && { silent: true }) }
  return { toast, durationMs: options?.durationMs ?? (actions.length ? 10_000 : 6000) }
}

/** A short message at the bottom of the window, optionally with buttons (`{ action: { label: 'Undo', run } }`). */
export function showToast(text: string, kind: 'info' | 'error' = 'info', options?: ToastOptions): void {
  const { toast, durationMs } = makeToast(++toastCounter, text, kind, withReportLink(text, kind, options, tNow()('report.toast.link'), (about) => openReportProblem(true, about)))
  setState({ toast })
  setTimeout(() => {
    if (state.toast?.id === toast.id) setState({ toast: null })
  }, durationMs)
}

/** Run one of the current toast's buttons, then dismiss it. A failing action shows as an error toast. */
export function runToastAction(id: number, index: number): void {
  const action = state.toast?.id === id ? state.toast.actions?.[index] : undefined
  if (!action) return
  setState({ toast: null })
  void attempt(async () => action.run())
}

export function dismissToast(): void {
  setState({ toast: null })
}

/** Run an action and surface failures as a toast. */
export async function attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action()
  } catch (err) {
    showError(err)
    return undefined
  }
}

export function selectWorkspace(id: string | null): void {
  const unread = { ...state.unread }
  const unreadSessions = { ...state.unreadSessions }
  if (id) {
    delete unread[id]
    const sessionId = activeSessionId(state, id)
    if (sessionId) delete unreadSessions[sessionId]
  }
  savePref('selectedWorkspaceId', id)
  // Tiles: opening another workspace (or Home) leaves the one opened full size.
  const tileZoom = id === state.tileZoom ? state.tileZoom : null
  setState({ selectedWorkspaceId: id, unread, unreadSessions, settingsPage: null, automations: null, assistantOpen: false, tileZoom })
}

function updateSidebarView(patch: Partial<SidebarView>): void {
  setState({ sidebarView: { ...state.sidebarView, ...patch } })
}

/** Scope the sidebar to one repository (null = all) and show its Home page. */
export function showRepoHome(repoId: string | null): void {
  savePref('sidebarRepo', repoId)
  updateSidebarView({ repo: repoId })
  selectWorkspace(null)
}

export function setSidebarFilter(filter: SidebarFilter): void {
  savePref('sidebarFilter', filter)
  updateSidebarView({ filter })
  if (filter === 'needs-you') recordMilestone('needsYou')
}

/**
 * Get started: remember that the person reached this (the first time stands). Fire and forget: it never blocks, and a
 * failure is not worth a toast (the checklist just doesn't tick). Milestones main records itself (a template sent,
 * a schedule, an assistant message, Tiles, MCP) don't come through here.
 */
export function recordMilestone(id: OnboardingMilestone): void {
  if (state.snapshot?.settings.onboarding?.milestones[id]) return
  void Promise.resolve(api.recordOnboardingMilestone(id)).catch(() => undefined)
}

/** "Hide checklist" and its undo (⌘K → Get started checklist). Milestones already reached stay. */
export async function setChecklistHidden(hidden: boolean): Promise<void> {
  const settings = state.snapshot?.settings
  if (!settings) return
  await attempt(() => api.updateSettings({ onboarding: { milestones: settings.onboarding?.milestones ?? {}, checklistHidden: hidden } }))
}

/** ⌘K → Get started checklist: shows the card again and goes Home, where it is. */
export function showGetStarted(): void {
  void setChecklistHidden(false)
  selectWorkspace(null)
  setState({ overlay: null })
}

export function setSidebarQuery(query: string): void {
  updateSidebarView({ query })
}

export function toggleShowFinished(): void {
  savePref('showFinished', !state.sidebarView.showFinished)
  updateSidebarView({ showFinished: !state.sidebarView.showFinished })
}

export function toggleRightPanel(): void {
  savePref('rightPanelOpen', !state.rightPanelOpen)
  setState({ rightPanelOpen: !state.rightPanelOpen })
}

export function toggleLeftPanel(): void {
  savePref('leftPanelOpen', !state.leftPanelOpen)
  setState({ leftPanelOpen: !state.leftPanelOpen })
}

/** Shows or hides the terminal panel. Inside a closed side panel, showing it opens the side panel too. */
export function toggleBottomPanel(): void {
  const open = !state.bottomPanelOpen || (!state.rightPanelOpen && terminalInSidePanel())
  showBottomPanel(open)
}

// The Editor layout keeps the terminal under the files, whatever Terminal placement says.
const terminalInSidePanel = () => state.snapshot?.settings.terminalPlacement !== 'below-chat' && state.snapshot?.settings.windowLayout !== 'editor'

export function showBottomPanel(open = true): void {
  const inSidePanel = terminalInSidePanel()
  savePref('bottomPanelOpen', open)
  // Hiding the panel also ends its fullscreen.
  const fullscreen = open ? state.terminalFullscreen : null
  if (open && inSidePanel && !state.rightPanelOpen) {
    savePref('rightPanelOpen', true)
    setState({ bottomPanelOpen: open, rightPanelOpen: true, terminalFullscreen: fullscreen })
  } else setState({ bottomPanelOpen: open, terminalFullscreen: fullscreen })
}

/** The workspace's terminal panel fills the workspace, or goes back to its place (O3). */
export function toggleTerminalFullscreen(workspaceId: string, on = state.terminalFullscreen !== workspaceId): void {
  setState({ terminalFullscreen: on ? workspaceId : state.terminalFullscreen === workspaceId ? null : state.terminalFullscreen })
}

/** Editor layout: the activity bar picked a view. The one already showing hides the sidebar; any other shows it. */
export function pickEditorSidebar(view: EditorView): void {
  const next = pickEditorView(state.editorView, state.leftPanelOpen, view)
  savePref('editorView', next.view)
  savePref('leftPanelOpen', next.open)
  setState({ editorView: next.view, leftPanelOpen: next.open })
}

/** Editor layout: show a view in the sidebar (a Checks request, ⌘⌥U), opening the sidebar if it was hidden. */
export function showEditorSidebar(view: EditorView): void {
  if (state.editorView === view && state.leftPanelOpen) return
  savePref('editorView', view)
  savePref('leftPanelOpen', true)
  setState({ editorView: view, leftPanelOpen: true })
}

/** Tiles: the workspaces on screen, in tile order. */
export function setTiles(tiles: string[]): void {
  savePref('tiles', tiles)
  setState({ tiles })
}

export function setTileCount(tileCount: TileCount): void {
  savePref('tileCount', tileCount)
  setState({ tileCount })
}

/** Tiles: open one workspace full size, with its side panel and terminals, or go back to the tiles (null). */
export function zoomTile(workspaceId: string | null): void {
  if (workspaceId) selectWorkspace(workspaceId)
  setState({ tileZoom: workspaceId })
}

/** Zen: hide both side panels, or show both if both are hidden. */
export function toggleZen(): void {
  const show = !state.leftPanelOpen && !state.rightPanelOpen
  savePref('leftPanelOpen', show)
  savePref('rightPanelOpen', show)
  setState({ leftPanelOpen: show, rightPanelOpen: show })
}

export function openOverlay(overlay: Overlay | null): void {
  setState({ overlay })
}

let fileRequestCounter = 0
export function requestOpenFile(workspaceId: string, path: string, line?: number): void {
  setState({ fileRequest: { workspaceId, path, line, nonce: ++fileRequestCounter }, overlay: null, settingsPage: null })
  if (state.selectedWorkspaceId !== workspaceId) selectWorkspace(workspaceId)
}

/** Keep archive controllers alive while their dialogs are dismissed. */
export function backgroundArchive(workspaceId: string): void {
  setState({ backgroundArchives: [...new Set([...state.backgroundArchives, workspaceId])], archiveRuns: { ...state.archiveRuns, [workspaceId]: { stopped: false, step: null } },
    archiveTarget: null })
}

/** The archive stopped on a step that needs you (Retry, Archive anyway or Keep workspace); its controller stays. */
export function stopBackgroundArchive(workspaceId: string): void {
  const run = state.archiveRuns[workspaceId]
  if (run) setState({ archiveRuns: { ...state.archiveRuns, [workspaceId]: { ...run, stopped: true } } })
}

export function finishBackgroundArchive(workspaceId: string): void {
  const { [workspaceId]: _, ...archiveRuns } = state.archiveRuns
  setState({ backgroundArchives: state.backgroundArchives.filter((id) => id !== workspaceId), archiveRuns,
    ...(state.archiveTarget === workspaceId ? { archiveTarget: null } : {}) })
}

export function openArchiveDialog(workspaceId: string | null, options: { deleteBranch?: boolean } = {}): void {
  setState({ archiveTarget: workspaceId, archiveDeleteBranch: Boolean(options.deleteBranch) })
}

/** Remembers whether an archive kept or deleted the branch, for the merged header's button. */
export function rememberArchiveChoice(deleteBranch: boolean): void {
  const archiveChoice: ArchiveChoice = deleteBranch ? 'delete-branch' : 'archive'
  if (archiveChoice === state.archiveChoice) return
  savePref('archiveChoice', archiveChoice)
  setState({ archiveChoice })
}

export function openMcpStatus(sessionId: string | null): void {
  setState({ mcpStatusSession: sessionId })
}

export function openCompareDialog(dialog: State['compareDialog']): void {
  setState({ compareDialog: dialog, overlay: null })
}

export function openScheduleDialog(dialog: State['scheduleDialog']): void {
  setState({ scheduleDialog: dialog })
}

export function openHandOffTo(dialog: State['handOffToDialog']): void {
  setState({ handOffToDialog: dialog, overlay: null })
}

export function openReconcile(transferId: string | null): void {
  setState({ reconcileDialog: transferId })
}

export function openPairDialog(kind: State['pairDialog']): void {
  setState({ pairDialog: kind })
}

export function openMcpConsent(workspaceId: string | null): void {
  setState({ mcpConsent: workspaceId })
}

export function openCompareArchive(target: State['compareArchive']): void {
  setState({ compareArchive: target })
}

export function openHandOffDialog(dialog: State['handOffDialog']): void {
  setState({ handOffDialog: dialog, overlay: null })
}

export function openExportDialog(workspaceId: string): void {
  setState({ portDialog: { kind: 'export', workspaceId }, overlay: null })
}

export function openImportDialog(): void {
  setState({ portDialog: { kind: 'import' }, overlay: null })
}

export function closePortDialog(): void {
  setState({ portDialog: null })
}

export function closeChecksConsent(): void {
  setState({ checksConsent: null })
}

export function openAlertDiff(dialog: State['alertDiff']): void {
  setState({ alertDiff: dialog })
}

let composerFillCounter = 0
/** Puts text in a chat's composer and switches to that chat. */
export function fillComposer(workspaceId: string, sessionId: string, text: string, templateId?: string, attachments?: Attachment[]): void {
  selectSession(workspaceId, sessionId)
  setState({ composerFill: { sessionId, text, templateId, attachments, nonce: ++composerFillCounter } })
}

/** The text (and template, or terminal snippet) waiting for this chat's composer, once. */
export function takeComposerFill(sessionId: string): { text: string; templateId?: string; attachments?: Attachment[]; snippet?: TerminalSnippet; edited?: EditedFrom } | null {
  if (state.composerFill?.sessionId !== sessionId) return null
  const { text, templateId, snippet, edited, attachments } = state.composerFill
  setState({ composerFill: null })
  return { text, templateId, snippet, edited, attachments }
}

/**
 * Terminal selection → chat: the selected output goes into the composer of the workspace's active chat
 * (a new chat when none is open) as a labelled draft block. Nothing is sent. False when the selection
 * held nothing but whitespace, so ⌘L can fall back to focusing the composer.
 */
// G4 #10: the chat picked last from a terminal menu's chat list, per workspace (remembered across launches).
const SNIPPET_TARGET_KEY = 'foreman:snippetTarget'

function snippetTargets(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(SNIPPET_TARGET_KEY) ?? '{}') as unknown
    return saved && typeof saved === 'object' ? (saved as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Where a terminal selection goes in this workspace now: the chat picked last, else the active one. */
export function snippetTargetId(workspaceId: string): string | undefined {
  const open = state.snapshot ? openSessions(state.snapshot, workspaceId).map((s) => s.id) : []
  return chooseSnippetTarget(open, snippetTargets()[workspaceId], activeSessionId(state, workspaceId))
}

export function sendSelectionToChat(workspaceId: string, raw: string, source: SnippetSource, toSession?: string): boolean {
  const ws = state.snapshot?.workspaces.find((w) => w.id === workspaceId)
  if (!ws) return false
  const snippet = makeSnippet(raw, source, ws.name, Date.now())
  if (!snippet) return false
  const deliver = (sessionId: string) => {
    selectSession(workspaceId, sessionId)
    setState({ composerFill: { sessionId, text: '', snippet, nonce: ++composerFillCounter } })
  }
  // A chat picked from the menu's list is remembered as this workspace's target for next time (⌘L too).
  if (toSession) {
    try {
      localStorage.setItem(SNIPPET_TARGET_KEY, JSON.stringify({ ...snippetTargets(), [workspaceId]: toSession }))
    } catch {
      // Not remembered; it still goes there this time.
    }
  }
  const sessionId = toSession ?? snippetTargetId(workspaceId)
  if (sessionId) deliver(sessionId)
  else void newChat(workspaceId).then((session) => session && deliver(session.id))
  return true
}

/** Copy a chat as Markdown. Tool output can hold secrets, and so can anything an agent printed, so the toast says so. */
export async function copyTranscript(sessionId: string, toolOutput: boolean): Promise<void> {
  await attempt(async () => {
    await navigator.clipboard.writeText(chatToMarkdown(await api.getChat(sessionId), { toolOutput }))
    showToast(tNow()('app.transcriptCopied'))
  })
}

/**
 * A new tab for a template: on the template's start model when it has one (nothing else
 * about the chat changes), with the template's text in the composer. Nothing is sent.
 */
export async function newChatWithTemplate(workspaceId: string, template: PromptTemplate): Promise<void> {
  const { loadout } = chooseStartLoadout(undefined, template)
  const session = await newChat(workspaceId, loadout ? { agent: loadout.agent, model: loadout.model, effort: loadout.effort, fastMode: loadout.fast } : undefined)
  if (session) fillComposer(workspaceId, session.id, template.body, template.id)
}

export function openFixChecks(workspaceId: string | null): void {
  setState({ fixChecksFor: workspaceId, overlay: null })
}

/** Ask the workspace view to show its Git panel (Checks tab). */
export function showChecksPanel(workspaceId: string): void {
  setState({ checksPanelRequest: { workspaceId, nonce: Date.now() }, rightPanelOpen: true })
}

/**
 * Home's "Send to chat" for new review comments: the unresolved threads holding a comment that is new since the user
 * last looked go to the active chat. When they are only review summaries there are no threads, so the panel opens instead.
 */
export async function sendUnseenReviews(workspaceId: string): Promise<void> {
  selectWorkspace(workspaceId)
  const ws = state.snapshot?.workspaces.find((w) => w.id === workspaceId)
  const unseen = new Set(ws?.prWatch?.reviews?.unseen.comments ?? [])
  const threads = await attempt(() => api.reviewThreads(workspaceId))
  const ids = (threads ?? []).filter((t) => !t.isResolved && t.comments.some((c) => unseen.has(c.id))).map((t) => t.id)
  if (!ids.length) {
    showChecksPanel(workspaceId)
    return
  }
  const sessionId = await attempt(() => api.sendReviewThreads(workspaceId, ids, activeSessionId(state, workspaceId)))
  if (!sessionId) return
  selectSession(workspaceId, sessionId)
  showToast(tNow()('app.reviewsSent'))
}

export function openResolveBase(workspaceId: string | null): void {
  setState({ resolveBaseFor: workspaceId, overlay: null })
}

export function openFixCi(workspaceId: string | null): void {
  setState({ fixCiFor: workspaceId, overlay: null })
}

/** Run the workspace's checks; commands not approved before ask first (the dialog calls this again with approve). */
export async function runChecks(workspaceId: string, approve = false): Promise<void> {
  const outcome = await attempt(() => api.runChecks(workspaceId, approve))
  if (outcome && !outcome.started) setState({ checksConsent: { workspaceId, items: outcome.consent }, overlay: null })
  else setState({ checksConsent: null })
}

export function openSettingsPage(page: SettingsPage | null): void {
  setState(page ? { settingsPage: page, automations: null, assistantOpen: false } : { settingsPage: null, assistantReturn: false })
}

/** The Automations page; `selected` is "t:<template id>" or "s:<schedule id>". `scrollTo` (G4 O9): Edit commands… lands on Commands. */
export function openAutomations(selected: string | null = null, scrollTo?: 'commands'): void {
  setState({ automations: scrollTo ? { selected: null, scrollTo } : { selected }, settingsPage: null, overlay: null, assistantOpen: false })
}

export function closeAutomations(): void {
  setState({ automations: null })
}

// ---- the assistant ----

// Thread lists pushed by main so far: a slower assistantState reply must not undo a newer one.
let assistantThreadsSeen = 0

/** Whether it can run and its threads; `refresh` checks the agents again. */
export async function loadAssistant(refresh = false): Promise<void> {
  const seen = assistantThreadsSeen
  const assistant = await attempt(() => api.assistantState(refresh))
  if (!assistant) return
  const threads = seen !== assistantThreadsSeen && state.assistant ? state.assistant.threads : assistant.threads
  setState({ assistant: { gate: assistant.gate, threads } })
}

export function openAssistant(): void {
  setState({ assistantOpen: true, assistantUnread: false, assistantReturn: false, settingsPage: null, automations: null, overlay: null })
  void loadAssistant()
  if (state.assistantThreadId) void loadAssistantThread(state.assistantThreadId)
}

/** The element a tour step points at: the first one marked `data-tour="<target>"` that's on screen. */
export function findTourTarget(target: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`)) {
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return el
  }
  return null
}

/** Help → Welcome tour, the rail's ? button, ⌘K, Settings → General, and a first launch. */
export function startTour(): void {
  const steps = tourSteps((target) => findTourTarget(target) !== null).map((s) => s.id)
  setState({ tour: { steps, index: 0 }, overlay: null })
}

export function goToTourStep(index: number): void {
  if (!state.tour) return
  setState({ tour: { ...state.tour, index: Math.min(Math.max(index, 0), state.tour.steps.length - 1) } })
}

/** Finished or skipped: it doesn't open by itself again. */
export function endTour(): void {
  setState({ tour: null })
  if (state.snapshot && !state.snapshot.settings.tourSeen) void attempt(() => api.updateSettings({ tourSeen: true }))
}

export function closeAssistant(): void {
  setState({ assistantOpen: false })
}

export function toggleAssistant(): void {
  if (state.assistantOpen) closeAssistant()
  else openAssistant()
}

async function loadAssistantThread(threadId: string): Promise<void> {
  const items = await attempt(() => api.assistantItems(threadId))
  if (items) setState({ assistantItems: { ...state.assistantItems, [threadId]: items } })
}

/** Show a thread (null: start a new conversation). */
export function selectAssistantThread(threadId: string | null): void {
  setState({ assistantThreadId: threadId })
  if (threadId) void loadAssistantThread(threadId)
}

/** Send from the assistant's composer. True when it went. */
export async function sendToAssistant(text: string, useAlternative = false): Promise<boolean> {
  const sent = await attempt(() => api.assistantSend(state.assistantThreadId, text, useAlternative))
  if (!sent) return false
  if (sent.threadId !== state.assistantThreadId) setState({ assistantThreadId: sent.threadId })
  return true
}

// ---- Ask Foreman (accessibility plan, phase F3) ----

/** Open the one-line Ask overlay over whatever is showing. */
export function openAsk(): void {
  setState({ overlay: 'ask' })
}

export function closeAsk(): void {
  if (state.overlay === 'ask') setState({ overlay: null })
}

/** What the model is told about where the user is asking from. */
export interface AskContext {
  workspaceId?: string
  sessionId?: string
}

/** Send a free-text question on the Ask thread (created by the first one). True when it went. */
export async function sendToAsk(text: string, context: AskContext): Promise<boolean> {
  const sent = await attempt(() => api.assistantSend(state.askThreadId, text, false, context))
  if (!sent) return false
  if (sent.threadId !== state.askThreadId) setState({ askThreadId: sent.threadId })
  return true
}

export async function deleteAssistantThread(threadId: string): Promise<void> {
  await attempt(() => api.assistantDeleteThread(threadId))
  const assistantItems = { ...state.assistantItems }
  delete assistantItems[threadId]
  // Deleting the Ask overlay's thread from the assistant view means its next question starts a new one.
  setState({ assistantItems, ...(state.assistantThreadId === threadId ? { assistantThreadId: null } : {}), ...(state.askThreadId === threadId ? { askThreadId: null } : {}) })
}

/** The assistant's "Show in Settings": opens the page at the row, with a way back. */
export function showSettingFromAssistant(id: string): void {
  const entry = settingEntry(id)
  if (!entry || entry.page.section === 'repo') return
  openSettingsPage({ ...entry.page, scrollTo: id } as SettingsPage)
  setState({ assistantReturn: true })
}

export function selectAutomation(selected: string | null): void {
  if (state.automations) setState({ automations: { selected } })
}

export function openReportProblem(open: boolean, about?: string): void {
  setState(open ? { reportProblemOpen: true, reportProblemAbout: about ?? null, overlay: null } : { reportProblemOpen: false, reportProblemAbout: null })
}

export function openPhoneSetup(open: boolean): void {
  setState({ phoneSetupOpen: open })
}

export function openRepoDialog(repoId: string | null): void {
  openSettingsPage(repoId ? { section: 'repo', repoId } : null)
}

export function openAddRepoDialog(dialog: State['addRepoDialog']): void {
  setState({ addRepoDialog: dialog })
}

// Clone id → listener for that clone's `git clone` output.
const cloneListeners = new Map<string, (line: string) => void>()

export function onCloneProgress(cloneId: string, listener: (line: string) => void): () => void {
  cloneListeners.set(cloneId, listener)
  return () => cloneListeners.delete(cloneId)
}

/** A repository that was just added: offer its first workspace. */
function repoAdded(repoId: string): void {
  setState({ addRepoDialog: null, makeRepoDir: null })
  openSettingsPage(null)
  openNewWorkspace(repoId)
}

/** Offer to make a folder that isn't a Git repository into one (git init and a first commit). */
export function openMakeRepo(dir: string | null): void {
  setState({ makeRepoDir: dir })
}

/** Make `dir` a Git repository and add it. 'needs-identity' means Git has no name and email: ask, then call again with them. Throws on failure. */
export async function makeRepository(dir: string, identity?: GitIdentity): Promise<'added' | 'needs-identity'> {
  const result = await api.makeRepo(dir, identity)
  if (!result.ok) return result.reason
  repoAdded(result.repo.id)
  return 'added'
}

/** addRepo, except that a folder outside Git opens the offer to make it a repository instead of an error. */
async function addRepoOrOffer(dir: string): Promise<{ id: string } | undefined> {
  try {
    return await api.addRepo(dir)
  } catch (err) {
    if (isNotGitRepoError(err)) openMakeRepo(dir)
    else showError(err)
    return undefined
  }
}

/** Add a folder that was opened before (from Recents). */
export async function openRecentRepo(path: string): Promise<void> {
  const repo = await addRepoOrOffer(path)
  if (repo) repoAdded(repo.id)
}

/** Clone and add; throws on failure so the dialog can show the error. */
export async function cloneRepository(url: string, parentDir: string, cloneId: string, account?: string): Promise<void> {
  const repo = await api.cloneRepo(url, parentDir, cloneId, account)
  repoAdded(repo.id)
}

export async function quickStartRepository(parentDir: string, name: string): Promise<void> {
  const repo = await api.quickStartRepo(parentDir, name)
  repoAdded(repo.id)
}

export function openNewWorkspace(repoId: string | null, prompt?: string, templateId?: string): void {
  setState({ newWorkspaceRepo: repoId, newWorkspacePrompt: repoId ? prompt ?? null : null, newWorkspaceTemplate: repoId && prompt ? templateId ?? null : null })
}

export function openSettings(open: boolean): void {
  openSettingsPage(open ? { section: 'general' } : null)
}

export function markWorkspaceUnread(workspaceId: string, unreadNow: boolean): void {
  const unread = { ...state.unread }
  if (unreadNow) unread[workspaceId] = true
  else delete unread[workspaceId]
  setState({ unread })
}

export function markAllRead(): void {
  setState({ unread: {}, unreadSessions: {} })
}

export async function loadChat(sessionId: string): Promise<void> {
  if (state.chats[sessionId]) return
  // Start collecting live events now so none are lost while the file loads.
  setState({ chats: { ...state.chats, [sessionId]: [] } })
  // With the previews still streaming, so the appends that follow continue them.
  const saved = await api.getChat(sessionId, true)
  const buffered: ChatItem[] = getState().chats[sessionId] ?? []
  // A preview that came while loading is older than the one read with the chat.
  const isPreview = (i: ChatItem) => (i.kind === 'assistant' || i.kind === 'thinking') && i.streaming === true
  const merged = buffered.reduce((items, item) => (isPreview(item) && saved.some((s) => s.id === item.id && isPreview(s)) ? items : upsert(items, item)), saved)
  setState({ chats: { ...state.chats, [sessionId]: merged } })
}

export async function loadSetupLog(workspaceId: string): Promise<void> {
  const log = await api.getSetupLog(workspaceId)
  setState({ setupLogs: { ...state.setupLogs, [workspaceId]: log } })
}

/** Create a workspace and switch to it. Returns false if it failed (an error toast is shown). */
export async function createWorkspace(repoId: string, options?: CreateWorkspaceOptions): Promise<boolean> {
  const ws = await attempt(() => api.createWorkspace(repoId, options))
  if (!ws) return false
  setState({ setupLogs: { ...state.setupLogs, [ws.id]: '' } })
  selectWorkspace(ws.id)
  return true
}

/** Add a worktree that already exists on disk and switch to it. */
export async function adoptWorktree(repoId: string, path: string, options: AdoptWorktreeOptions): Promise<boolean> {
  const ws = await attempt(() => api.adoptWorktree(repoId, path, options))
  if (!ws) return false
  setState({ setupLogs: { ...state.setupLogs, [ws.id]: '' } })
  selectWorkspace(ws.id)
  return true
}

export async function addRepository(): Promise<void> {
  const dir = await attempt(() => api.pickDirectory())
  if (!dir) return
  const repo = await addRepoOrOffer(dir)
  if (repo) repoAdded(repo.id)
}

/** O21: add the folders confirmed after a drop and select the first in the rail; one alone also offers its first workspace. Returns how many were added. */
export async function addDroppedRepositories(paths: string[]): Promise<number> {
  const added: string[] = []
  for (const dir of paths) {
    const repo = await attempt(() => api.addRepo(dir))
    if (repo) added.push(repo.id)
  }
  if (!added.length) return 0
  showRepoHome(added[0])
  if (added.length === 1) repoAdded(added[0])
  return added.length
}

// ---- helpers ----

/** "just now", "12m ago", "3h ago", "2d ago", in the UI language (shared/i18n/time.ts). */
export function timeAgo(iso: string | undefined): string {
  return formatAgo(iso, localeNow())
}

/** How long since `iso` without "ago": "12h", "4m", or "a moment", in the UI language. */
export function timeWaited(iso: string | undefined): string {
  return formatWaited(iso, localeNow())
}

/** The UI language now, for Intl formatting outside React (components use useT().locale). */
export function uiLocale(): Locale {
  return localeNow()
}

/** Keyboard modifier label for shortcut hints. */
export function modKey(platform: string | undefined): string {
  return platform === 'darwin' ? '⌘' : 'Ctrl+'
}

// Cross-component commands for keyboard shortcuts.
export type UiCommand =
  | 'focus-composer'
  | 'clear-composer'
  | 'run'
  | 'toggle-picker'
  | 'toggle-templates'
  | 'cycle-effort'
  | 'toggle-fast'
  | 'toggle-plan'
  | 'attach'
  | 'cancel'
  | 'show-setup-log'
  // Accessibility (phase A): the jump keys. The chat on screen moves focus to a heading, or to the panel that needs the user.
  | 'chat-latest-reply'
  | 'chat-previous-turn'
  | 'chat-needs-me'
  | 'chat-needs-none'
export function sendUiCommand(command: UiCommand, workspaceId: string): void {
  window.dispatchEvent(new CustomEvent('foreman:command', { detail: { command, workspaceId } }))
}
export function onUiCommand(handler: (command: UiCommand, workspaceId: string) => void): () => void {
  const listener = (event: Event) => {
    const { command, workspaceId } = (event as CustomEvent<{ command: UiCommand; workspaceId: string }>).detail
    handler(command, workspaceId)
  }
  window.addEventListener('foreman:command', listener)
  return () => window.removeEventListener('foreman:command', listener)
}

// Browser tabs are transient UI state; native pages are owned by the desktop window.
let browserRequest = 0
export function openBrowserTab(workspaceId: string, url: string): void {
  const old = state.browserTabs[workspaceId]
  selectWorkspace(workspaceId)
  setState({ browserTabs: { ...state.browserTabs, [workspaceId]: { ...old, url, active: true, split: old?.split ?? false, request: ++browserRequest } } })
}
export function selectBrowserTab(workspaceId: string, active: boolean): void {
  const tab = state.browserTabs[workspaceId]
  if (tab && tab.active !== active) setState({ browserTabs: { ...state.browserTabs, [workspaceId]: { ...tab, active } } })
}
export function splitBrowserTab(workspaceId: string, split: boolean): void {
  const tab = state.browserTabs[workspaceId]
  if (tab) setState({ browserTabs: { ...state.browserTabs, [workspaceId]: { ...tab, split } } })
}
export function closeBrowserTab(workspaceId: string): void {
  const browserTabs = { ...state.browserTabs }
  delete browserTabs[workspaceId]
  setState({ browserTabs })
  void attempt(() => bridge.browser.command(workspaceId, { type: 'close' }))
}

export function focusBrowserAddress(workspaceId: string): void {
  setState({ browserAddressRequest: { workspaceId, nonce: ++browserRequest } })
}
