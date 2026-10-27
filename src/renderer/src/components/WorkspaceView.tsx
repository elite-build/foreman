import { TransferBanner } from './HandOffDialogs'
import { Archive, Globe, Cloud, Code2, Copy, Folder, GitBranch, LayoutGrid, PanelBottom, PanelLeft, PanelRight, Plus, RefreshCw, RotateCcw, Users, X } from 'lucide-react'
import { compareBlockFor } from '../../../shared/compare'
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { compactModelLabel, modelTooltip } from '../../../shared/handOff'
import { forkTabTitle } from '../../../shared/fork'
import { usageLines } from '../../../shared/usage'
import type { PlainKey } from '../../../shared/i18n'
import type { DiffFile, DiffScope, Session, Workspace, WorkspaceDiff, WorkspaceUsage } from '../../../shared/types'
import {
  api,
  attempt,
  bridge,
  closeChat,
  closeBrowserTab,
  selectBrowserTab,
  loadSetupLog,
  newChat,
  openArchiveDialog,
  copyTranscript,
  copyWorkspaceLink,
  openExportDialog,
  forkChat,
  getState,
  openHandOffTo,
  openCompareDialog,
  openHandOffDialog,
  openMcpConsent,
  openSessions,
  reopenChat,
  selectSession,
  showError,
  showToast,
  modKey,
  toggleBottomPanel,
  toggleLeftPanel,
  toggleRightPanel,
  useStore,
  useWindowVisible,
  zoomTile
} from '../store'
import { useHeldStore } from '../heldStore'
import { useActiveSessionId, useStoreMemo } from '../storeMemo'
import { WorkspaceBrowser } from './WorkspaceBrowser'
import { BottomPanel } from './BottomPanel'
import { ChatView } from './ChatView'
import { ChangesList, FileDiffView } from './Changes'
import { CommitFileView, CommitsView, type CommitFile } from './CommitsView'
import { DiffSourceMenu } from './DiffSourceMenu'
import { useDiffSource } from './diffSourcePref'
import { toggleUncommitted } from '../../../shared/diffSource'
import { AgentIcon } from './composer/AgentPicker'
import { agentTabValue, showTerminalAgentTab, TerminalAgentBodies, TerminalAgentTabs, useAgentTabs } from './agents/TerminalAgents'
import { NoteBar } from './NoteBar'
import { AutoReviewBar, AutoReviewTabMark } from './AutoReview'
import { SetupHint } from './SetupHint'
import { formatDuration } from './turnResult'
import { ChecksView, GitHeaderActions, MergedProgress, MergedStatus, useGitStatus } from './GitPanel'
import { FileViewer } from './FileViewer'
import { FilesTree } from './FilesTree'
import { ResizeHandle, usePanelSize, useWindowHeight, useWindowWidth, type PanelSize } from './resize'
import { wsPath } from '../../../shared/workspacePath'
import { archivedTabs, workspaceSurfaces } from '../archivedView'
import { ArchivedPanel } from './ArchivedView'
import { useT, type RendererT } from '../i18n'
import { Button, Callout, ContextMenu, IconButton, MenuItem, MenuSeparator, SplitButton, Spinner, Status, Tab, TabList, TabPanel, Tabs, Tag, TextInput, type TagTone } from '../ui'
import { AppIcon, DefaultAppMenu, OpenInMenuItems, openDefault, useDefaultLabel } from './OpenIn'
import { refreshOpenInApps } from '../openIn'
import { runningStep } from '../../../shared/setupSteps'
import { CloudBanner, CloudPill, useCloudStatusPoll, useWakeOnOpen } from './cloud/CloudBits'

/** The fork shortcut as shown in menus. */
export function forkShortcut(platform: string | undefined): string {
  return platform === 'darwin' ? '⌘⌥↵' : 'Ctrl+Alt+Enter'
}

const STATE_LABEL: Partial<Record<Workspace['state'], PlainKey>> = {
  creating: 'workspaceView.state.creating',
  'setting-up': 'workspaceView.state.settingUp',
  'setup-failed': 'workspaceView.state.setupFailed',
  error: 'workspaceView.state.error',
  history: 'workspaceView.state.history'
}

/** How a workspace state reads as a tag: the shape says it as well as the colour. */
const STATE_TONE: Partial<Record<Workspace['state'], TagTone>> = {
  creating: 'info',
  'setting-up': 'info',
  'setup-failed': 'error',
  error: 'error'
}

/** O19: "Setup · Seed DB" while one of several setup steps runs. */
function setupPill(ws: Workspace, t: RendererT): string | undefined {
  const step = ws.state === 'setting-up' ? runningStep(ws.setupRun) : undefined
  return step && step.total > 1 ? t('setupTab.pill', { step: step.name }) : undefined
}

/** G2 (O5): how many commits the branch has since its merge base, for the Commits tab's badge. Null until read or when it can't be. */
function useCommitCount(workspaceId: string, enabled: boolean, reloadKey: string) {
  const [count, setCount] = useState<{ count: number; more: boolean } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    api.branchCommitCount(workspaceId).then(
      (c) => live && setCount(c),
      () => live && setCount(null)
    )
    return () => {
      live = false
    }
  }, [workspaceId, enabled, reloadKey])
  return count
}

/** After a tool that may have changed files finishes, the diff is read again this long after (once per burst of edits). */
export const DIFF_SETTLE_MS = 1000
/** While an agent works, the diff is also read this often, for changes no event tells of (a script, a terminal). */
export const DIFF_SAFETY_POLL_MS = 30_000
// Coming back to the window reads it again soon (an editor may have saved meanwhile).
const DIFF_FOCUS_MS = 250

// Tools that only read files: their results can't change the diff. Any other (Edit, Write, Bash, a subagent) may have.
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'ExitPlanMode', 'AskUserQuestion'])
const mayChangeFiles = (name: string) => !READ_ONLY_TOOLS.has(name) && !name.startsWith('mcp__foreman__')

export function useWorkspaceDiff(workspaceId: string, running: boolean, enabled: boolean, scope: DiffScope, commits: string[] = []) {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [loading, setLoading] = useState(false)
  const busy = useRef(false)
  const again = useRef(false)
  // Minimized: nothing reads the diff; it reads again when the window comes back.
  const visible = useWindowVisible()
  const commitKey = commits.join(',')
  // What to read: the selection as it is now, so a read already under way reads the new one next, not its own again.
  const latest = useRef({ workspaceId, scope, commits, key: '' })
  latest.current = { workspaceId, scope, commits, key: `${workspaceId}\n${scope}\n${commitKey}` }

  const refresh = useCallback(async () => {
    // Asked again while reading: read once more after, so a change made meanwhile isn't missed.
    if (busy.current) {
      again.current = true
      return
    }
    busy.current = true
    setLoading(true)
    try {
      do {
        again.current = false
        const asked = latest.current
        try {
          const read = await api.getDiff(asked.workspaceId, asked.scope, asked.commits.length ? asked.commits : undefined)
          // The scope or commits changed while it was read: it is another selection's diff, so read the new one instead.
          if (asked.key !== latest.current.key) again.current = true
          else setDiff(read)
        } catch (err) {
          if (asked.key !== latest.current.key) again.current = true
          else throw err
        }
      } while (again.current)
    } catch (err) {
      showError(err)
    } finally {
      busy.current = false
      again.current = false
      setLoading(false)
    }
    // A new selection is a new refresh, so the effect below reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, scope, commitKey])

  // Read when shown and when the agent starts or finishes; while it works, shortly after each of its tools that may
  // have changed files (the working tree's scopes only), with a slow safety read; and on coming back to the window.
  useEffect(() => {
    if (!enabled || !visible) return
    void refresh()
    let soon: ReturnType<typeof setTimeout> | undefined
    // Not pushed back by later calls, so a stream of edits still shows every second or so.
    const readSoon = (ms: number) => {
      soon ??= setTimeout(() => {
        soon = undefined
        void refresh()
      }, ms)
    }
    const workingTree = scope === 'all' || scope === 'uncommitted'
    const off = bridge.onEvent((event) => {
      if (!workingTree || event.type !== 'chat-item' || event.item.kind !== 'tool' || event.item.status === 'running' || !mayChangeFiles(event.item.name)) return
      if (getState().snapshot?.sessions.find((s) => s.id === event.sessionId)?.workspaceId === workspaceId) readSoon(DIFF_SETTLE_MS)
    })
    const back = () => document.visibilityState === 'visible' && readSoon(DIFF_FOCUS_MS)
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)
    const poll = running ? setInterval(() => void refresh(), DIFF_SAFETY_POLL_MS) : undefined
    return () => {
      off()
      clearTimeout(soon)
      clearInterval(poll)
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
  }, [enabled, visible, running, refresh, scope, workspaceId])

  return { diff, loading, refresh }
}

function HistoryBanner({ ws }: { ws: Workspace }) {
  const t = useT()
  const title = <strong key="title">{t('workspaceView.history.title')}</strong>
  return (
    <Callout
      banner
      role="status"
      actions={
        <Button size="sm" title={ws.carried ? t('workspaceView.history.activateCarriedTitle') : t('workspaceView.history.activateTitle', { branch: ws.branch })} onClick={() => void attempt(() => api.activateWorkspace(ws.id))}>
          {t('workspaceView.history.activate')}
        </Button>
      }
    >
      {ws.provenance ? t.rich('workspaceView.history.leadImported', { title, machine: ws.provenance.sourceMachine }) : t.rich('workspaceView.history.lead', { title })}
      {ws.carried ? ` ${ws.carried.omitted ? t('workspaceView.history.carriedOmitted', { branch: ws.carried.branch, count: ws.carried.omitted }) : t('workspaceView.history.carried', { branch: ws.carried.branch })}` : ''}
      {ws.variablesToSet?.length ? ` ${t('workspaceView.history.variables', { count: ws.variablesToSet.length, names: ws.variablesToSet.join(', ') })}` : ''}
    </Callout>
  )
}

/** Looks for apps again each time the Open menu opens (it is mounted only while open), so one installed a moment ago shows up. */
function RefreshOpenInApps() {
  useEffect(() => void refreshOpenInApps(true), [])
  return null
}

function OpenMenu({ ws }: { ws: Workspace }) {
  // G4 #14: right-click on Open picks the default app.
  const [defaultMenu, setDefaultMenu] = useState<{ x: number; y: number } | null>(null)
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  // #14: the default app's icon and name; with none (or one that's gone) the button shows the menu.
  const fallback = useDefaultLabel()

  const run = (action: () => Promise<unknown>) => void attempt(action)

  return (
    <>
      <SplitButton
        menuOpen={menuOpen}
        onMenuOpenChange={setMenuOpen}
        size="sm"
        label={
          <>
            {fallback.id ? <AppIcon id={fallback.id} /> : <Code2 size={13} />} {t('openIn.button')}
          </>
        }
        menuLabel={t('openIn.moreOptions')}
        // With no default app to run, the button shows the menu instead.
        onClick={() => !openDefault({ folder: wsPath(ws) }) && setMenuOpen(true)}
        onContextMenu={(e) => {
          e.preventDefault()
          setDefaultMenu({ x: e.clientX, y: e.clientY })
        }}
        title={fallback.id ? `${t('openIn.buttonTitle', { app: fallback.name })} · ${t('openIn.setDefault.hint')}` : t('openIn.setDefault.hint')}
      >
        <RefreshOpenInApps />
        <OpenInMenuItems heading={t('openIn.menu.title', { name: ws.name })} target={{ folder: wsPath(ws) }} onDone={() => undefined} shortcut />
        <MenuItem icon={<Copy size={14} />} onSelect={() => run(() => navigator.clipboard.writeText(wsPath(ws)))}>
          {t('openIn.copyPath')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem variant="danger" icon={<Archive size={14} />} onSelect={() => openArchiveDialog(ws.id)}>
          {t('workspaceView.archive')}
        </MenuItem>
      </SplitButton>
      {defaultMenu && <DefaultAppMenu {...defaultMenu} dismiss={() => setDefaultMenu(null)} />}
    </>
  )
}

export function ChatTab({
  session,
  renaming,
  showModel,
  fixed,
  onRenameDone,
  onClose,
  onContextMenu
}: {
  session: Session
  // Several chats are open, so say which model each one is.
  showModel: boolean
  renaming: boolean
  // Archived and read-only (#13): no rename or close.
  fixed?: boolean
  onRenameDone: () => void
  onClose: () => void
  onContextMenu: (x: number, y: number) => void
}) {
  const t = useT()
  const unread = useStore((s) => Boolean(s.unreadSessions[session.id]))
  const waiting = useStore((s) => s.approvals.some((a) => a.sessionId === session.id))
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(session.title ?? '')
  const [usage, setUsage] = useState<WorkspaceUsage | null>(null)
  // Looked up when the pointer arrives, so the tooltip has figures by the time it shows.
  const loadUsage = () => void api.workspaceUsage(session.workspaceId).then(setUsage, () => undefined)
  const tip = [
    session.title || t('workspaceView.tab.newChat'),
    showModel && modelTooltip(session.agent, session.model, session.effort, session.fastMode, t),
    usage?.tabs[session.id]?.turns ? t('workspaceView.tab.usageChat', { usage: usageLines(usage.tabs[session.id], formatDuration, t) }) : null,
    usage?.total.turns ? t(usage.total.partial ? 'workspaceView.tab.usageWorkspacePartial' : 'workspaceView.tab.usageWorkspace', { usage: usageLines(usage.total, formatDuration, t) }) : null
  ]
    .filter(Boolean)
    .join('\n')

  useEffect(() => {
    if (!renaming) return
    setTitle(session.title ?? '')
    setEditing(true)
  }, [renaming, session.title])

  const save = () => {
    setEditing(false)
    onRenameDone()
    if (title.trim() !== (session.title ?? '')) void attempt(() => api.updateSession(session.id, { title }))
  }

  return (
    <Tab
      value={session.id}
      title={tip}
      onMouseEnter={loadUsage}
      onDoubleClick={() => {
        if (fixed) return
        setTitle(session.title ?? '')
        setEditing(true)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e.clientX, e.clientY)
      }}
      editor={
        editing ? (
          <TextInput
            autoFocus
            compact
            className="tab-rename"
            aria-label={t('common.rename')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') {
                setEditing(false)
                onRenameDone()
              }
            }}
          />
        ) : undefined
      }
      actions={
        !fixed && (
          <IconButton className="tab-close" label={t('workspaceView.tab.close')} onClick={onClose}>
            <X size={11} />
          </IconButton>
        )
      }
    >
      {session.status === 'running' ? (
        <span className="faint"><Spinner size={12} label={t('workspaceView.tab.running')} /></span>
      ) : waiting ? (
        <Status compact tone="warn" label={t('workspaceView.tab.waiting')} />
      ) : session.waitingForSlot ? (
        // Its turn waits for an agent slot (Settings → Advanced): a hollow mark and the word, not a colour.
        <Status compact tone="off" label={t('workspaceView.tab.queued')} />
      ) : unread ? (
        <Status compact tone="info" label={t('workspaceView.tab.unread')} />
      ) : (
        <AgentIcon agent={session.agent} size={12} />
      )}
      {/* #16: forks are marked with an icon, so the mark survives a long title cut at the tab's width. */}
      {session.forkedFrom && <GitBranch size={11} className="faint tab-fork" aria-label={t('workspaceView.tab.fork')} />}
      {/* #17: a read-only auto reviewer. */}
      <AutoReviewTabMark session={session} />
      <span className="chat-tab-title">{session.title ? (session.forkedFrom ? forkTabTitle(session.title) : session.title) : t('workspaceView.tab.newChat')}</span>
      {showModel && <span className="tab-model">{compactModelLabel(session.agent, session.model)}</span>}
    </Tab>
  )
}

function TabMenu({
  x,
  y,
  onRename,
  onFork,
  forkHint,
  onSecondOpinion,
  onCopyTranscript,
  onCopyLink,
  onClose,
  onCloseOthers,
  onReopen,
  readOnly,
  dismiss
}: {
  x: number
  y: number
  // Archived and read-only (#13): only copying the transcript.
  readOnly?: boolean
  onRename: () => void
  // Only for Claude Code chats with forking turned on.
  onFork?: () => void
  forkHint: string
  onSecondOpinion: () => void
  onCopyTranscript: (toolOutput: boolean) => void
  // #3: foreman://workspace/<repo>/<workspace>?tab=N for this tab.
  onCopyLink: () => void
  onClose: () => void
  onCloseOthers: () => void
  onReopen: () => void
  dismiss: () => void
}) {
  const t = useT()
  const item = (label: string, action: () => void, hint?: string) => (
    <MenuItem onSelect={action} hint={hint}>
      {label}
    </MenuItem>
  )
  return (
    <ContextMenu x={x} y={y} label={t('workspaceView.tabMenu.label')} onClose={dismiss}>
      {readOnly ? (
        <>
          {item(t('chat.answerMenu.copyMessages'), () => onCopyTranscript(false))}
          {item(t('chat.answerMenu.copyTools'), () => onCopyTranscript(true))}
        </>
      ) : (
        <>
          {item(t('common.rename'), onRename)}
          {onFork && item(t('workspaceView.menu.fork'), onFork, forkHint)}
          {item(t('chat.answerMenu.secondOpinion'), onSecondOpinion)}
          {item(t('chat.answerMenu.copyMessages'), () => onCopyTranscript(false))}
          {item(t('chat.answerMenu.copyTools'), () => onCopyTranscript(true))}
          {item(t('attention.link.copy'), onCopyLink)}
          {item(t('workspaceView.tab.close'), onClose)}
          {item(t('workspaceView.menu.closeOthers'), onCloseOthers)}
          <MenuSeparator />
          {item(t('workspaceView.menu.reopen'), onReopen)}
        </>
      )}
    </ContextMenu>
  )
}

/**
 * One workspace. Once opened it stays mounted while another is shown (App), so its terminals keep running and its chats
 * keep their place. While hidden it holds what it read from the snapshot, which every `state` event replaces, so a hidden
 * workspace doesn't re-render on each one: memo skips App's renders, and its chats hold their logs (ChatView). The terminal
 * panel is the exception: it reads the workspace live (LiveBottomPanel), so its terminals and scripts follow it while hidden.
 */
export const WorkspaceView = memo(function WorkspaceView({ workspaceId, hidden }: { workspaceId: string; hidden: boolean }) {
  // The workspace name heads its view; several views stay mounted, so the id is per instance.
  const headingId = useId()
  const ws = useHeldStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId), hidden)
  const allSessions = useHeldStore((s) => s.snapshot!.sessions, hidden)
  const activeId = useActiveSessionId(workspaceId)
  // #22: a Terminal agent tab shown instead of the chat.
  const agentTab = useAgentTabs(workspaceId).active
  const browser = useStore(s => s.browserTabs[workspaceId])
  const browserActive = Boolean(browser?.active)
  const rightPanelOpen = useStore((s) => s.rightPanelOpen)
  const leftPanelOpen = useStore((s) => s.leftPanelOpen)
  const bottomPanelOpen = useStore((s) => s.bottomPanelOpen)
  const terminalFullscreen = useStore((s) => s.terminalFullscreen === workspaceId)
  const sidebarSide = useStore((s) => s.snapshot!.settings.sidebarSide ?? 'left')
  const panelSide = useStore((s) => s.snapshot!.settings.sidePanelSide ?? 'right')
  const placement = useStore((s) => s.snapshot!.settings.terminalPlacement ?? 'panel-bottom')
  // Tiles: this workspace was opened full size from its tile.
  const zoomed = useStore((s) => s.snapshot!.settings.windowLayout === 'tiles' && s.tileZoom === workspaceId)
  const snapshot = useHeldStore((s) => s.snapshot!, hidden)
  const forkToNewTab = useStore((s) => s.snapshot!.settings.forkToNewTab)
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [viewFile, setViewFile] = useState<{ path: string; line?: number } | null>(null)
  const fileRequest = useStore((s) => (s.fileRequest?.workspaceId === workspaceId ? s.fileRequest : null))
  const chatRequest = useStore((s) => s.chatRequest?.workspaceId === workspaceId ? s.chatRequest : null)
  // O5: the Changes panel's source, kept per workspace; the Commits tab, its pick mode and a commit's file in the center.
  const [source, setSource] = useDiffSource(workspaceId)
  const scope = source.scope
  const workingTree = scope === 'all' || scope === 'uncommitted'
  const [picking, setPicking] = useState(false)
  const [commitFile, setCommitFile] = useState<CommitFile | null>(null)
  const [commitsReload, setCommitsReload] = useState(0)
  const [panelTab, setPanelTab] = useState<'changes' | 'commits' | 'files' | 'checks'>('changes')
  // #19: the Files tab mounts the first time it's opened; Refresh there re-reads its folders.
  const [filesSeen, setFilesSeen] = useState(false)
  const [filesReload, setFilesReload] = useState(0)
  if (panelTab === 'files' && !filesSeen) setFilesSeen(true)
  const checksRequest = useStore((s) => (s.checksPanelRequest?.workspaceId === workspaceId ? s.checksPanelRequest : null))
  useEffect(() => {
    if (checksRequest) setPanelTab('checks')
  }, [checksRequest])
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  // Chats stay mounted once shown so scroll position and drafts survive tab switches.
  const [mounted, setMounted] = useState<string[]>([])
  const t = useT()
  // History only and archived (#13) have no worktree, but their chats can still be read; archived calls nothing else.
  const surfaces = workspaceSurfaces(ws ?? { state: 'creating' })
  const shownTab = useStore((s) => s.activeSession[workspaceId])
  const sessions = surfaces.archived ? archivedTabs(allSessions, workspaceId, shownTab) : openSessions(snapshot, workspaceId)
  const running = allSessions.some((s) => s.workspaceId === workspaceId && s.status === 'running')
  const hasWorktree = surfaces.worktree
  const hasChat = surfaces.chats
  const { diff, loading, refresh } = useWorkspaceDiff(workspaceId, running, hasWorktree && !hidden, scope, scope === 'picked' ? source.picked : undefined)
  // O5: the Files tab is the working tree, so it marks All changes whatever the Changes panel's source.
  const treeDiff = useWorkspaceDiff(workspaceId, running, hasWorktree && !hidden && filesSeen && !workingTree, 'all')
  const git = useGitStatus(workspaceId, hasWorktree && !hidden, running)
  // Cloud workspaces: the sandbox's status is asked for again while this one is on screen.
  useCloudStatusPoll(ws, !hidden)
  useWakeOnOpen(ws, !hidden)
  // G2 (O5): the Commits tab's count, read again when a turn ends, on Refresh, or when git's own counts move.
  const commitCount = useCommitCount(workspaceId, hasWorktree && !hidden, `${running}:${commitsReload}:${git.status?.aheadBase ?? ''}:${git.status?.ahead ?? ''}`)

  // A repo that proposes MCP servers this Mac hasn't seen asks once, when its workspace is on screen. Nothing runs from asking.
  const wsState = ws?.state
  const inCloud = Boolean(ws?.cloud)
  useEffect(() => {
    // Repository MCP servers run on this computer, so a cloud workspace's agents don't get them yet (PLAN §10).
    if (hidden || wsState !== 'ready' || inCloud) return
    let live = true
    void api
      .repoMcp(workspaceId)
      .then((view) => live && view.unseen && openMcpConsent(workspaceId))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [hidden, wsState, workspaceId, inCloud])

  // ⌘⌥U toggles uncommitted-only changes; git shortcuts are handled in App.
  useEffect(() => {
    if (hidden) return
    const onKey = (e: KeyboardEvent) => {
      const mod = navigator.userAgent.includes('Mac') ? e.metaKey : e.ctrlKey
      if (mod && e.altKey && e.code === 'KeyU') {
        e.preventDefault()
        setPanelTab('changes')
        setSource((s) => ({ ...s, scope: toggleUncommitted(s.scope) }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hidden, setSource])

  if (activeId && !openFile && !viewFile && !mounted.includes(activeId)) setMounted([...mounted, activeId])

  // Palette and review actions can return to a chat while a file is open.
  useEffect(() => {
    if (!chatRequest) return
    setOpenFile(null)
    setViewFile(null)
    setCommitFile(null)
  }, [chatRequest])

  useEffect(() => {
    if (!browserActive) return
    setOpenFile(null)
    setViewFile(null)
    setCommitFile(null)
    showTerminalAgentTab(workspaceId, null)
  }, [browserActive, browser?.request, workspaceId])

  // Quick open and search ask the workspace to show a file.
  useEffect(() => {
    // A cloud workspace has no folder here for the file viewer to read.
    if (!fileRequest || surfaces.archived || surfaces.cloud) return
    setOpenFile(null)
    setCommitFile(null)
    setViewFile({ path: fileRequest.path, line: fileRequest.line })
    selectBrowserTab(workspaceId, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileRequest])

  const setupLog = surfaces.setupLog
  useEffect(() => {
    if (setupLog) void loadSetupLog(workspaceId)
  }, [workspaceId, setupLog])

  // The side panel's width is shared by all workspaces; the chat column keeps at least 420px.
  const windowWidth = useWindowWidth()
  const container = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const hasView = Boolean(ws)
  useEffect(() => {
    const el = container.current
    if (!el) return
    // Hidden workspaces measure 0; keep the last real width.
    const observer = new ResizeObserver(() => el.offsetWidth > 0 && setContainerWidth(el.offsetWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasView])
  const panel = usePanelSize('side-panel', 380, 280, Math.min(760, windowWidth * 0.6, (containerWidth || windowWidth) - 420))
  // Terminal heights: in the side panel the changes list keeps room for a few rows; under the chat the chat keeps 300px.
  const windowHeight = useWindowHeight()
  const panelTerminal = usePanelSize('terminal-height', Math.round(windowHeight * 0.5), 120, windowHeight - 240)
  const chatTerminal = usePanelSize('bottom-height', Math.round(windowHeight * 0.35), 120, windowHeight - 320)

  // The terminal panel renders once into a node of its own, which moves to wherever the layout puts it,
  // so changing the layout never restarts its terminals.
  const [terminalHost] = useState(() => {
    const el = document.createElement('div')
    el.className = 'bottom-host'
    return el
  })
  const placeTerminal = useCallback((slot: HTMLDivElement | null) => {
    if (slot && terminalHost.parentElement !== slot) slot.appendChild(terminalHost)
  }, [terminalHost])

  if (!ws) return null
  const file: DiffFile | undefined = diff?.files.find((f) => f.path === openFile)
  const liveMounted = mounted.filter((id) => sessions.some((s) => s.id === id))

  let panelTitle = t('workspaceView.panel.noChanges')
  if (!diff && hasWorktree) panelTitle = t('workspaceView.panel.loading')
  if (diff?.files.length) panelTitle = t('workspaceView.panel.filesChanged', { count: diff.files.length })

  const panelLeft = panelSide === 'left'
  // The selected tab of the strip: a file or commit shown in the centre, a Terminal agent tab, or the chat.
  const browserShown = browserActive && !openFile && !viewFile && !commitFile && !agentTab
  const tabValue = browserShown ? 'browser' : openFile ? 'file:diff' : viewFile ? 'file:view' : commitFile ? 'file:commit' : agentTab ? agentTabValue(agentTab) : (activeId ?? '')
  const belowChat = placement === 'below-chat'
  const terminalShown = terminalFullscreen || (bottomPanelOpen && (belowChat || rightPanelOpen))
  // Fullscreen (O3) moves the panel into a slot over the whole workspace; the usual slots step aside.
  const terminalDocked = surfaces.terminal && bottomPanelOpen && !terminalFullscreen
  const mod = modKey(snapshot.platform)
  const terminalSlot = (size: PanelSize, edge: 'top' | 'bottom', where: string) => (
    <div className={`bottom-slot ${where}`} ref={placeTerminal} style={size.isDefault ? undefined : { flex: `0 0 ${size.size}px` }}>
      <ResizeHandle panel={size} edge={edge} label={t('workspaceView.resize.terminal')} />
    </div>
  )
  const sidebarToggle = !leftPanelOpen && (
    <IconButton label={t('workspaceView.showSidebar', { key: `${mod}B` })} onClick={toggleLeftPanel}>
      {sidebarSide === 'right' ? <PanelRight size={15} /> : <PanelLeft size={15} />}
    </IconButton>
  )
  const panelToggle = (
    <IconButton label={t('workspaceView.toggleSidePanel', { key: `${mod}⌥B` })} pressed={rightPanelOpen} onClick={toggleRightPanel}>
      {panelLeft ? <PanelLeft size={15} /> : <PanelRight size={15} />}
    </IconButton>
  )

  const showSession = (id: string) => {
    setOpenFile(null)
    setViewFile(null)
    setCommitFile(null)
    selectSession(workspaceId, id)
  }

  return (
    <div
      ref={container}
      className={`workspace ${rightPanelOpen ? 'with-panel' : ''} ${panelLeft ? 'panel-left' : ''} ${terminalFullscreen ? 'terminal-full' : ''}`}
      style={{
        display: hidden ? 'none' : undefined,
        gridTemplateColumns: rightPanelOpen ? (panelLeft ? `${panel.size}px minmax(420px, 1fr)` : `minmax(420px, 1fr) ${panel.size}px`) : undefined
      }}
    >
      <section className="center" aria-labelledby={headingId}>
        <header className="titlebar drag center-header">
          <div className="header-title">
            {sidebarSide === 'left' && sidebarToggle}
            {panelLeft && panelToggle}
            {surfaces.cloud ? <Cloud size={14} className="faint" aria-label={t('cloud.glyph')} /> : <Folder size={14} className="faint" />}
            <span className="header-name" id={headingId} role="heading" aria-level={1}>
              {ws.name}
            </span>
            <code className="header-branch" title={t('workspaceView.createdFrom', { base: ws.baseBranch })}>
              {ws.branch}
            </code>
            {running && <span className="faint"><Spinner size={13} /></span>}
            {STATE_LABEL[ws.state] && <Tag tone={STATE_TONE[ws.state] ?? 'neutral'}>{setupPill(ws, t) ?? t(STATE_LABEL[ws.state]!)}</Tag>}
            {surfaces.cloud && <CloudPill ws={ws} />}
            {surfaces.archived && (
              <Tag>
                <Archive size={11} /> {t('archivedView.pill')}
              </Tag>
            )}
          </div>
          <div className="header-actions">
            {zoomed && (
              <IconButton label={t('tiles.back')} onClick={() => zoomTile(null)}>
                <LayoutGrid size={15} />
              </IconButton>
            )}
            {/* Compare, hand-off and Open in need a folder on this computer; a cloud workspace has none. */}
            {surfaces.local && <CompareButton ws={ws} sessionId={activeId} />}
            {surfaces.exportable && (
              <Button size="sm" onClick={() => openExportDialog(ws.id)} title={t('workspaceView.export.title')}>
                {t('workspaceView.export.label')}
              </Button>
            )}
            {surfaces.local && !ws.transfer && (
              <Button size="sm" onClick={() => openHandOffTo({ workspaceId: ws.id })} title={t('workspaceView.handOff.title')}>
                {t('workspaceView.handOff.label')}
              </Button>
            )}
            {surfaces.local && <OpenMenu ws={ws} />}
            {surfaces.terminal && (
              <IconButton label={t('workspaceView.toggleTerminal', { key: `${mod}⌥J` })} pressed={terminalShown} onClick={toggleBottomPanel}>
                <PanelBottom size={15} />
              </IconButton>
            )}
            {!panelLeft && panelToggle}
            {sidebarSide === 'right' && sidebarToggle}
          </div>
        </header>

        {ws.transfer && <TransferBanner workspaceId={ws.id} />}
        {surfaces.cloud && <CloudBanner ws={ws} />}
        {ws.state === 'history' && !ws.transfer && <HistoryBanner ws={ws} />}
        {hasChat && (
          <Tabs
            className="chat-tabs"
            variant="chat"
            value={tabValue}
            onChange={(id) => {
              if (id === 'browser') {
                setOpenFile(null)
                setViewFile(null)
                setCommitFile(null)
                showTerminalAgentTab(workspaceId, null)
                if (browser) selectBrowserTab(workspaceId, true)
                else void attempt(() => api.openPreview(workspaceId))
                return
              }
              selectBrowserTab(workspaceId, false)
              if (id.startsWith('agent:')) {
                setOpenFile(null)
                setViewFile(null)
                setCommitFile(null)
                showTerminalAgentTab(workspaceId, id.slice('agent:'.length))
                return
              }
              // Terminal agent tabs select themselves; only a chat is ours to show.
              if (!sessions.some((s) => s.id === id)) return
              showTerminalAgentTab(workspaceId, null)
              showSession(id)
            }}
          >
            <TabList label={t('workspaceView.tabs.label')}>
              {sessions.map((s) => (
                <ChatTab
                  key={s.id}
                  session={s}
                  renaming={renaming === s.id}
                  showModel={sessions.length > 1}
                  fixed={surfaces.archived}
                  onRenameDone={() => setRenaming(null)}
                  onClose={() => void closeChat(workspaceId, s.id)}
                  onContextMenu={(x, y) => setMenu({ sessionId: s.id, x, y })}
                />
              ))}
              {hasWorktree && browser && (
                <Tab value="browser" actions={browser && <IconButton className="tab-close" label={t('browser.close')} onClick={() => closeBrowserTab(workspaceId)}><X size={11} /></IconButton>}>
                  <Globe size={12} /><span className="chat-tab-title">{t('browser.tab')}</span>
                </Tab>
              )}
              {/* #22 */}
              <TerminalAgentTabs workspaceId={workspaceId} covered={Boolean(openFile || viewFile || commitFile)} />
              {viewFile && !openFile && (
                <Tab
                  value="file:view"
                  actions={
                    <IconButton className="tab-close" label={t('workspaceView.closeFile')} onClick={() => setViewFile(null)}>
                      <X size={11} />
                    </IconButton>
                  }
                >
                  <span className="mono chat-tab-title">{viewFile.path.split('/').pop()}</span>
                </Tab>
              )}
              {commitFile && !openFile && !viewFile && (
                <Tab
                  value="file:commit"
                  actions={
                    <IconButton className="tab-close" label={t('workspaceView.closeFile')} onClick={() => setCommitFile(null)}>
                      <X size={11} />
                    </IconButton>
                  }
                >
                  <span className="mono chat-tab-title">{commitFile.path.split('/').pop()}</span>
                  <span className="mono faint">{commitFile.commit.sha.slice(0, 7)}</span>
                </Tab>
              )}
              {openFile && (
                <Tab
                  value="file:diff"
                  actions={
                    <IconButton className="tab-close" label={t('workspaceView.closeFile')} onClick={() => setOpenFile(null)}>
                      <X size={11} />
                    </IconButton>
                  }
                >
                  <span className="mono chat-tab-title">{openFile.split('/').pop()}</span>
                </Tab>
              )}
              {hasWorktree && !browser && <IconButton label={t('browser.open')} onClick={() => void attempt(() => api.openPreview(workspaceId))}><Globe size={14} /></IconButton>}
              {hasWorktree && (
                <IconButton className="new-tab" label={t('workspaceView.newChatTitle', { key: '⌘T' })} onClick={() => void newChat(workspaceId)}>
                  <Plus size={14} />
                </IconButton>
              )}
              {!surfaces.archived && allSessions.some((s) => s.workspaceId === workspaceId && s.closedAt) && (
                <IconButton label={t('workspaceView.reopenTitle', { key: '⌘⇧T' })} onClick={() => void reopenChat(workspaceId)}>
                  <RotateCcw size={13} />
                </IconButton>
              )}
            </TabList>
          </Tabs>
        )}
        {hasChat && !browserShown && ws.state !== 'history' && <NoteBar workspace={ws} session={sessions.find((s) => s.id === activeId)} readOnly={surfaces.archived} />}
        {hasChat && !browserShown && !surfaces.archived && <SetupHint workspace={ws} session={sessions.find((s) => s.id === activeId)} />}
        {/* #17: the reviewer tab's running, stopped or stale bar. */}
        {hasChat && !browserShown && <AutoReviewBar workspace={ws} session={sessions.find((s) => s.id === activeId)} />}

        <div className={`center-body${browserShown && browser?.split ? ' browser-split' : ''}`}>
          {hasChat ? (
            liveMounted.map((id) => {
              const session = sessions.find((s) => s.id === id)!
              const visible = (!browserShown || Boolean(browser?.split)) && !openFile && !viewFile && !commitFile && !agentTab && id === activeId
              return (
                <div key={id} className="fill" style={{ display: visible ? undefined : 'none' }}>
                  <ChatView session={session} workspace={ws} active={visible && !hidden} hidden={!visible || hidden} />
                </div>
              )
            })
          ) : (
            <div className="fill">
              <div className="center-empty">
                {ws.state === 'error' ? (
                  <p className="error-text">{ws.error}</p>
                ) : (
                  <p className="muted">
                    <Spinner size={14} /> {t('workspaceView.creating', { name: ws.name })}
                  </p>
                )}
              </div>
            </div>
          )}
          {/* #22 */}
          {hasChat && <TerminalAgentBodies workspaceId={workspaceId} covered={Boolean(browserShown || openFile || viewFile || commitFile)} hidden={hidden} />}
          {browser && hasWorktree && <WorkspaceBrowser workspaceId={workspaceId} visible={browserShown && !hidden && !terminalFullscreen} sessions={sessions} activeId={activeId} />}
          {viewFile && !openFile && surfaces.local && (
            <div className="fill">
              <FileViewer workspaceId={workspaceId} workspacePath={wsPath(ws)} path={viewFile.path} line={viewFile.line} />
            </div>
          )}
          {openFile && (
            <div className="fill">
              {file ? (
                <FileDiffView file={file} workspaceId={workspaceId} expandable={workingTree} readonly={!workingTree} commentsHidden={!workingTree} scope={diff?.scope} mergeBase={diff?.mergeBase} />
              ) : (
                <div className="center-empty muted">{t('workspaceView.fileUnchanged')}</div>
              )}
            </div>
          )}
          {commitFile && !openFile && !viewFile && (
            <div className="fill">
              <CommitFileView
                file={commitFile}
                workspaceId={workspaceId}
                branchFile={scope === 'all' ? (diff?.files.find((f) => f.path === commitFile.path) ?? null) : undefined}
                onOpenInAll={() => {
                  setSource((s) => ({ ...s, scope: 'all' }))
                  setPanelTab('changes')
                  setCommitFile(null)
                  setOpenFile(commitFile.path)
                }}
              />
            </div>
          )}
        </div>
        {belowChat && terminalDocked && terminalSlot(chatTerminal, 'top', 'below-chat')}
      </section>

      {/* Hidden rather than unmounted so its terminals keep running. */}
      <aside className={`side-panel ${panel.size < 380 ? 'compact' : ''}`} aria-label={t('workspaceView.panel.label')} style={{ display: rightPanelOpen ? undefined : 'none' }}>
        <ResizeHandle panel={panel} edge={panelLeft ? 'right' : 'left'} label={t('workspaceView.resize.side')} />
        {surfaces.archived ? (
          <ArchivedPanel workspace={ws} />
        ) : (
          <>
            <header className="titlebar drag panel-header">
              {!running && git.status?.primary.action === 'archive' && git.status.pr ? (
                <MergedStatus pr={git.status.pr} />
              ) : (
                <span className={`panel-status ${git.status?.primary.tone ?? ''}`}>
                  {running ? t('workspaceView.panel.working') : git.status && git.status.primary.label !== 'No changes' ? git.status.primary.label : panelTitle}
                </span>
              )}
              <div className="header-actions">
                {hasWorktree && <GitHeaderActions workspaceId={workspaceId} status={git.status} refresh={() => void git.refresh()} running={running} />}
              </div>
            </header>
            {!running && git.status?.primary.action === 'archive' && git.status.pr?.state === 'MERGED' && <MergedProgress pr={git.status.pr} />}
            {placement === 'panel-top' && terminalDocked && terminalSlot(panelTerminal, 'bottom', 'panel-top')}
            <Tabs className="panel-tabs-root" variant="underline" value={panelTab} onChange={(v) => setPanelTab(v as typeof panelTab)}>
              <TabList label={t('workspaceView.panel.tabs')}>
                <Tab value="changes">
                  {t('workspaceView.panel.changes')} {diff?.files.length ? <span className="faint">{diff.files.length}</span> : null}
                </Tab>
                {hasWorktree && (
                  <Tab value="commits">
                    {t('commits.tab')} {commitCount?.count ? <span className="faint">{commitCount.count}{commitCount.more ? '+' : ''}</span> : null}
                  </Tab>
                )}
                {surfaces.local && <Tab value="files">{t('files.tab')}</Tab>}
                <Tab value="checks">
                  {t('workspaceView.panel.checks')}
                  {git.status?.pr?.checks.some((c) => c.state === 'failure') && <Status compact tone="error" label={t('workspaceView.panel.checksFailing')} />}
                  {git.status?.pr?.checks.some((c) => c.state === 'pending') && <Status compact tone="warn" label={t('workspaceView.panel.checksPending')} />}
                </Tab>
                <span className="spacer" />
                {panelTab === 'changes' && hasWorktree && (
                  <DiffSourceMenu
                    workspaceId={workspaceId}
                    choice={source}
                    onChange={(next) => setSource((s) => ({ ...s, scope: next }))}
                    onPick={() => {
                      setPanelTab('commits')
                      setPicking(true)
                    }}
                  />
                )}
                <IconButton
                  label={t('common.refresh')}
                  onClick={() => {
                    void refresh()
                    void git.refresh()
                    if (panelTab === 'files') setFilesReload((n) => n + 1)
                    if (panelTab === 'files' && !workingTree) void treeDiff.refresh()
                    if (panelTab === 'commits') setCommitsReload((n) => n + 1)
                  }}
                  disabled={loading || !hasWorktree}
                >
                  {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
                </IconButton>
              </TabList>
              <div className="panel-changes">
                <TabPanel value="changes">
                  {diff && (
                    <ChangesList
                      workspace={ws}
                      diff={diff}
                      selected={openFile}
                      onOpen={(path) => {
                        selectBrowserTab(workspaceId, false)
                        setViewFile(null)
                        setCommitFile(null)
                        setOpenFile(path)
                      }}
                      onBackToAll={() => setSource((s) => ({ ...s, scope: 'all' }))}
                    />
                  )}
                </TabPanel>
                <TabPanel value="commits">
                  {hasWorktree && (
                    <CommitsView
                      workspaceId={workspaceId}
                      reloadKey={`${running}:${commitsReload}`}
                      selected={commitFile}
                      picking={picking}
                      picked={source.picked}
                      onOpen={(next) => {
                        selectBrowserTab(workspaceId, false)
                        setOpenFile(null)
                        setViewFile(null)
                        setCommitFile(next)
                      }}
                      onShowUncommitted={() => {
                        setSource((s) => ({ ...s, scope: 'uncommitted' }))
                        setPanelTab('changes')
                      }}
                      onPick={setPicking}
                      onShowPicked={(shas) => {
                        setSource({ scope: 'picked', picked: shas })
                        setPicking(false)
                        setPanelTab('changes')
                      }}
                    />
                  )}
                </TabPanel>
                {/* #19: kept mounted once opened, so open folders survive switching tabs. */}
                <TabPanel value="files" keepMounted>
                  {surfaces.local && filesSeen && (
                    <FilesTree
                      workspaceId={workspaceId}
                      diff={workingTree ? diff : treeDiff.diff}
                      selected={viewFile?.path ?? openFile}
                      reloadKey={filesReload}
                      onOpen={(path, changed) => {
                        selectBrowserTab(workspaceId, false)
                        // A deleted file isn't on disk any more; its diff is what there is to see.
                        setCommitFile(null)
                        if (changed?.status === 'deleted') {
                          setViewFile(null)
                          setOpenFile(path)
                        } else {
                          setOpenFile(null)
                          setViewFile({ path })
                        }
                      }}
                    />
                  )}
                </TabPanel>
                <TabPanel value="checks">
                  <ChecksView workspaceId={workspaceId} status={git.status} refresh={() => void git.refresh()} />
                </TabPanel>
              </div>
            </Tabs>
            {placement === 'panel-bottom' && terminalDocked && terminalSlot(panelTerminal, 'top', 'panel-bottom')}
          </>
        )}
      </aside>
      {terminalFullscreen && surfaces.terminal && <div className="bottom-slot terminal-fullscreen" ref={placeTerminal} />}
      {createPortal(<LiveBottomPanel workspaceId={workspaceId} visible={!hidden && terminalShown} />, terminalHost)}

      {menu && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          dismiss={() => setMenu(null)}
          onRename={() => setRenaming(menu.sessionId)}
          onFork={
            forkToNewTab
              ? () => void forkChat(workspaceId, menu.sessionId).then((fork) => fork && showSession(fork.id))
              : undefined
          }
          forkHint={forkShortcut(snapshot.platform)}
          onSecondOpinion={() => openHandOffDialog({ sourceId: menu.sessionId, kind: 'second-opinion' })}
          onCopyTranscript={(toolOutput) => void copyTranscript(menu.sessionId, toolOutput)}
          onCopyLink={() => copyWorkspaceLink(workspaceId, menu.sessionId)}
          onClose={() => void closeChat(workspaceId, menu.sessionId)}
          onCloseOthers={() => {
            for (const s of sessions) if (s.id !== menu.sessionId && s.status !== 'running') void attempt(() => api.closeSession(s.id))
            selectSession(workspaceId, menu.sessionId)
          }}
          onReopen={() => void reopenChat(workspaceId)}
          readOnly={surfaces.archived}
        />
      )}
    </div>
  )
})

/**
 * The terminal panel, reading its workspace from the store itself rather than from the (possibly hidden, so held) view:
 * terminals, run scripts and the Setup tab react to the workspace's state whether or not it is on screen.
 */
function LiveBottomPanel({ workspaceId, visible }: { workspaceId: string; visible: boolean }) {
  const ws = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId))
  if (!ws || !workspaceSurfaces(ws).terminal) return null
  return <BottomPanel workspace={ws} visible={visible} />
}

/** "Compare…" in the header: the same prompt with other models, in sibling workspaces. */
function CompareButton({ ws, sessionId }: { ws: Workspace; sessionId?: string }) {
  // A string, not the filtered tabs: a selector that builds a new array every read never settles.
  const t = useT()
  const reason = useStoreMemo((s) => [ws, s.snapshot!.sessions, t], ([w, sessions, tr]) => compareBlockFor(w, sessions, tr))
  return (
    <Button size="sm" icon={<Users size={12} />} disabled={Boolean(reason) || !sessionId} title={reason ?? t('workspaceView.compare.title')} onClick={() => openCompareDialog({ workspaceId: ws.id, sessionId })}>
      {t('workspaceView.compare.label')}
    </Button>
  )
}
