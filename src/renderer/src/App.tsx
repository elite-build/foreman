import { useEffect, useState } from 'react'
import { ArchiveDialog } from './components/ArchiveDialog'
import { StopSafely } from './components/StopSafely'
import { WhatsNew } from './components/WhatsNew'
import { McpStatusDialog } from './components/McpStatusDialog'
import { AlertDiffDialog } from './components/SensitiveAlert'
import { ChecksConsentDialog, FixChecksDialog, FixCiDialog, ResolveBaseDialog } from './components/ChecksDialogs'
import { ExportDialog, ImportDialog } from './components/PortDialogs'
import { McpConsentDialog } from './components/McpConsent'
import { CompareArchiveDialog, CompareDialog } from './components/CompareDialogs'
import { ScheduleDialog } from './components/ScheduleDialogs'
import { HandOffToDialog, PairDialog, ReconcileDialog } from './components/HandOffDialogs'
import { SecondOpinionDialog } from './components/SecondOpinionDialog'
import { NewWorkspaceDialog } from './components/NewWorkspaceDialog'
import { usePanelSize, useWindowWidth } from './components/resize'
import { SettingsView } from './components/settings/SettingsView'
import { AutomationsView } from './components/automations/AutomationsView'
import { AssistantView } from './components/assistant/AssistantView'
import { PhoneSetupDialog } from './components/phone/PhoneSetupDialog'
import { RemoteBanner } from './components/computers/RemoteBanner'
import { BrowserBanner } from './components/computers/BrowserBanner'
import { ControlRequestDialog } from './components/computers/ControlRequestDialog'
import { ReportProblemDialog } from './components/ReportProblemDialog'
import { DropFolder } from './components/DropFolder'
import { Sidebar } from './components/Sidebar'
import { Home } from './components/Home'
import { liveRepo, sidebarOrder } from './triage'
import { WorkspaceView } from './components/WorkspaceView'
import { TilesView } from './components/tiles/TilesView'
import { EditorViews } from './components/editor/EditorViews'
import { StatusBar } from './components/editor/StatusBar'
import { editorViewsFor, RAIL_NAMES_WIDTH, RAIL_WIDTH, shownEditorView } from './editorLayout'
import { workspaceSurfaces } from './archivedView'
import './components/workspace.css'
import { CloneRepoDialog, MakeRepoDialog, QuickStartDialog } from './components/AddRepository'
import { CreateOrganizationDialog } from './components/spaces/CreateOrganizationDialog'
import { MemoryView } from './components/spaces/MemoryView'
import { EmployeesView } from './components/employees/EmployeesView'
import { snapshotInSpace } from '../../shared/organizations'
import { Overlays } from './components/Overlays'
import { Announcer, ToastHost } from './components/Announcer'
import { Tour } from './components/Tour'
import { tourStartsOnLaunch } from '../../shared/tour'
import { sendSetupSelectionToChat } from './components/SetupLog'
import { equipLoadout } from './components/composer/AgentPicker'
import { runGitAction } from './components/GitPanel'
import { dispatchShortcut, platformOf, type ShortcutActions } from './shortcuts'
import { t } from './i18n'
import {
  activeSessionId,
  addRepository,
  api,
  openReportProblem,
  attempt,
  clientKind,
  closeChat,
  closeBrowserTab,
  focusBrowserAddress,
  forkChat,
  getState,
  modKey,
  newChat,
  openNewWorkspace,
  openOverlay,
  openSettingsPage,
  recordMilestone,
  reopenChat,
  startTour,
  selectSession,
  selectWorkspace,
  sendUiCommand,
  showToast,
  toggleBottomPanel,
  toggleLeftPanel,
  toggleRailNames,
  toggleRightPanel,
  toggleTerminalFullscreen,
  toggleWorkspaceFocus,
  toggleAssistant,
  toggleZen,
  useStore
} from './store'

// Everything a registry entry can do (src/renderer/src/shortcuts.ts), over the store.
const shortcutActions: ShortcutActions = {
  openOverlay,
  recordMilestone,
  toggleToolCalls() {
    const snapshot = getState().snapshot
    if (!snapshot) return
    const expand = !snapshot.settings.expandToolCalls
    void attempt(() => api.updateSettings({ expandToolCalls: expand })).then((saved) => saved && showToast(expand ? t('app.toolCalls.expanded') : t('app.toolCalls.collapsed')))
  },
  toggleTheme() {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    void attempt(() => api.updateSettings({ theme: dark ? 'light' : 'dark' }))
  },
  toggleLeftPanel,
  toggleRailNames,
  toggleRightPanel,
  toggleBottomPanel,
  toggleZen,
  toggleSettings: () => openSettingsPage(getState().settingsPage ? null : { section: 'general' }),
  reportProblem: () => openReportProblem(true),
  toggleAssistant,
  toggleTerminalFullscreen,
  toggleFlowFullscreen: (workspaceId) => toggleWorkspaceFocus(workspaceId, 'flow'),
  selectWorkspace,
  selectSession,
  newWorkspace(ws) {
    const state = getState()
    const { snapshot } = state
    if (!snapshot) return
    const repoId = ws?.repoId ?? liveRepo(snapshot, state.sidebarView.repo) ?? snapshot.repos[0]?.id
    if (repoId) openNewWorkspace(repoId)
  },
  newChat: (workspaceId) => void newChat(workspaceId),
  reopenChat: (workspaceId) => void reopenChat(workspaceId),
  closeChat: (workspaceId, sessionId) => void closeChat(workspaceId, sessionId),
  closeBrowserTab,
  forkChat: (workspaceId, sessionId) => void forkChat(workspaceId, sessionId),
  runGit: (workspaceId, action) => void runGitAction(workspaceId, action),
  openPreview: (workspaceId) => void attempt(() => api.openPreview(workspaceId)),
  equipLoadout: (session, hasHistory, index) => void equipLoadout(session, hasHistory, index),
  // Text selected in a Setup log goes to chat (#10); terminals handle their own ⌘L. Otherwise: focus the composer.
  focusComposer(workspaceId) {
    if (!sendSetupSelectionToChat()) sendUiCommand('focus-composer', workspaceId)
  },
  command: sendUiCommand
}

// Dispatches window keydowns from the registry. Two listeners, because the fork chord (⌘⌥↵) is a
// capture-phase entry: it has to run before the composer, which would otherwise send on ⌘↵.
function useShortcuts() {
  useEffect(() => {
    const listener = (capture: boolean) => (e: KeyboardEvent) => {
      // Every dispatched chord includes Ctrl or Cmd; bare keys belong to the control that has focus.
      if (!e.ctrlKey && !e.metaKey) return
      const state = getState()
      const { snapshot } = state
      if (!snapshot) return
      // The New workspace dialog handles its own keys, and the tour its own.
      if (state.newWorkspaceRepo || state.tour) return
      const ws = snapshot.workspaces.find((w) => w.id === state.selectedWorkspaceId && w.state !== 'archived')
      const sessionId = ws ? activeSessionId(state, ws.id) : undefined
      dispatchShortcut(
        e,
        {
          event: e,
          state,
          snapshot,
          platform: platformOf(snapshot.platform),
          ws,
          session: snapshot.sessions.find((s) => s.id === sessionId),
          // The sidebar's own order: the space it shows (docs/ai-employees.md §3), as it lists it.
          order: () => sidebarOrder({ ...state, snapshot: snapshotInSpace(snapshot, state.space) }, state.sidebarView),
          actions: shortcutActions
        },
        capture
      )
    }
    const onKey = listener(false)
    const onCapture = listener(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onCapture, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', onCapture, true)
    }
  }, [])
}

export function App() {
  const snapshot = useStore((s) => s.snapshot)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const archiveTarget = useStore((s) => s.archiveTarget)
  const backgroundArchives = useStore((s) => s.backgroundArchives)
  const mcpStatusSession = useStore((s) => s.mcpStatusSession)
  const handOffDialog = useStore((s) => s.handOffDialog)
  const compareDialog = useStore((s) => s.compareDialog)
  const compareArchive = useStore((s) => s.compareArchive)
  const scheduleDialog = useStore((s) => s.scheduleDialog)
  const handOffToDialog = useStore((s) => s.handOffToDialog)
  const reconcileDialog = useStore((s) => s.reconcileDialog)
  const pairDialog = useStore((s) => s.pairDialog)
  const mcpConsent = useStore((s) => s.mcpConsent)
  const portDialog = useStore((s) => s.portDialog)
  const checksConsent = useStore((s) => s.checksConsent)
  const fixChecksFor = useStore((s) => s.fixChecksFor)
  const fixCiFor = useStore((s) => s.fixCiFor)
  const resolveBaseFor = useStore((s) => s.resolveBaseFor)
  const alertDiff = useStore((s) => s.alertDiff)
  const settingsPage = useStore((s) => s.settingsPage)
  const automations = useStore((s) => Boolean(s.automations))
  const assistantOpen = useStore((s) => s.assistantOpen && Boolean(s.snapshot?.settings.assistantEnabled))
  // An organization's Memory view, only while AI employees are on and the organization is there.
  const memoryView = useStore((s) => (s.memoryView && s.snapshot?.organizations?.some((o) => o.id === s.memoryView) ? s.memoryView : null))
  // An organization's employees views (docs/ai-employees.md §10), on the same terms.
  const employeesView = useStore((s) => (s.employeesView && s.snapshot?.organizations?.some((o) => o.id === s.employeesView!.orgId) ? s.employeesView : null))
  const phoneSetupOpen = useStore((s) => s.phoneSetupOpen)
  const reportProblemOpen = useStore((s) => s.reportProblemOpen)
  const leftPanelOpen = useStore((s) => s.leftPanelOpen)
  const rightPanelOpen = useStore((s) => s.rightPanelOpen)
  const newWorkspaceRepo = useStore((s) => s.newWorkspaceRepo)
  const newWorkspacePrompt = useStore((s) => s.newWorkspacePrompt)
  const newWorkspaceTemplate = useStore((s) => s.newWorkspaceTemplate)
  const addRepoDialog = useStore((s) => s.addRepoDialog)
  // AI employees off: the dialog never opens (nothing offers it).
  const createOrganizationOpen = useStore((s) => s.createOrganizationOpen)
  const makeRepoDir = useStore((s) => s.makeRepoDir)
  const sidebarSide = useStore((s) => s.snapshot?.settings.sidebarSide ?? 'left')
  const tiled = useStore((s) => s.snapshot?.settings.windowLayout === 'tiles')
  const editor = useStore((s) => s.snapshot?.settings.windowLayout === 'editor')
  const editorView = useStore((s) => s.editorView)
  const tileZoom = useStore((s) => s.tileZoom)
  const windowWidth = useWindowWidth()
  // The rail with its names shown is wider; the list beside it keeps its width, so the sidebar grows by the difference.
  const railNames = useStore((s) => s.railNames)
  const railExtra = railNames ? RAIL_NAMES_WIDTH - RAIL_WIDTH : 0
  // Leave the chat column 420px, plus the side panel's narrowest width when it's open. The size includes the rail's tiles.
  const sidebar = usePanelSize('sidebar', 312, 260, Math.min(480, windowWidth - 420 - railExtra - (rightPanelOpen ? 280 : 0)))
  // Workspaces stay mounted once opened so terminals and scroll positions survive switching. A hidden one holds what it
  // read and skips these renders, so it costs nothing per store event (WorkspaceView); its terminals still run.
  const [opened, setOpened] = useState<string[]>([])
  if (selectedId && !opened.includes(selectedId)) setOpened([...opened, selectedId])
  useShortcuts()
  // A first launch opens the welcome tour once (in the window, not a browser); finishing or skipping it sets tourSeen.
  const tourPending = snapshot ? tourStartsOnLaunch(snapshot.settings, clientKind) : false
  useEffect(() => {
    if (tourPending) startTour()
  }, [tourPending])

  if (!snapshot) return null
  // An archived workspace is shown read-only (#13) only while it's the selected one.
  const liveOpened = opened.filter((id) => snapshot.workspaces.some((w) => w.id === id && (w.state !== 'archived' || id === selectedId)))
  const covered = Boolean(settingsPage) || automations || assistantOpen || Boolean(memoryView) || Boolean(employeesView)
  const selected = snapshot.workspaces.find((w) => w.id === selectedId)
  // Tiles: a workspace opened full size, or an archived one being read, takes the whole area as in Three panes.
  const fullView = tiled && selected && (selected.state === 'archived' || tileZoom === selected.id) ? selected.id : null
  const showHome = !covered && (tiled ? !selected : !selectedId || !liveOpened.includes(selectedId))
  const sidebarRight = sidebarSide === 'right'
  // Editor: the rail stays as the activity bar; the list shows while Workspaces is the view, or there's no workspace whose
  // side panel could take its place (Home, Settings in front).
  const onScreen = editor && !covered && selected && liveOpened.includes(selected.id) ? selected : undefined
  const editorViews = editorViewsFor(onScreen ? workspaceSurfaces(onScreen) : null)
  const shownView = shownEditorView(editorView, editorViews)
  const listShown = leftPanelOpen && (!editor || shownView === 'workspaces')
  const sidebarWidth = (listShown ? sidebar.size : RAIL_WIDTH) + railExtra
  // The main area reaches the window's left edge (where macOS draws the traffic lights).
  const mainFirst = editor ? sidebarRight : !leftPanelOpen || sidebarRight

  return (
    <div
      className={`app platform-${snapshot.platform} ${leftPanelOpen || editor ? '' : 'no-sidebar'} ${sidebarRight ? 'sidebar-right' : ''} ${mainFirst ? 'main-first' : ''} ${editor ? 'editor-layout' : ''} ${editor && !listShown ? 'editor-rail' : ''}`}
      style={leftPanelOpen || editor ? { gridTemplateColumns: sidebarRight ? `1fr ${sidebarWidth}px` : `${sidebarWidth}px 1fr` } : undefined}
    >
      {editor ? (
        <Sidebar resize={sidebar} side={sidebarSide} list={listShown} views={<EditorViews shown={leftPanelOpen ? shownView : null} available={editorViews} />} />
      ) : (
        leftPanelOpen && <Sidebar resize={sidebar} side={sidebarSide} />
      )}
      <main className="main">
        <RemoteBanner />
        <BrowserBanner />
        {tiled ? (
          <>
            <TilesView hidden={covered || showHome || Boolean(fullView)} />
            {fullView && <WorkspaceView key={fullView} workspaceId={fullView} hidden={covered} />}
          </>
        ) : (
          liveOpened.map((id) => <WorkspaceView key={id} workspaceId={id} hidden={covered || id !== selectedId} />)
        )}
        {settingsPage && <SettingsView page={settingsPage} />}
        {automations && !settingsPage && <AutomationsView />}
        {assistantOpen && !settingsPage && !automations && <AssistantView />}
        {memoryView && !settingsPage && !automations && !assistantOpen && <MemoryView key={memoryView} organizationId={memoryView} />}
        {employeesView && !settingsPage && !automations && !assistantOpen && !memoryView && <EmployeesView key={`${employeesView.orgId}:${employeesView.page}`} route={employeesView} />}
        {showHome && <Home />}
      </main>
      {editor && <StatusBar workspaceId={onScreen?.id ?? null} />}
      {[...new Set([...backgroundArchives, ...(archiveTarget ? [archiveTarget] : [])])].map((id) => (
        <ArchiveDialog key={id} workspaceId={id} hidden={archiveTarget !== id} />
      ))}
      {mcpStatusSession && <McpStatusDialog key={mcpStatusSession} sessionId={mcpStatusSession} />}
      {handOffDialog && <SecondOpinionDialog key={`${handOffDialog.sourceId}:${handOffDialog.kind}`} {...handOffDialog} />}
      {mcpConsent && <McpConsentDialog key={mcpConsent} workspaceId={mcpConsent} />}
      {compareDialog && <CompareDialog key={compareDialog.workspaceId} {...compareDialog} />}
      {scheduleDialog && <ScheduleDialog key={'templateId' in scheduleDialog ? scheduleDialog.templateId : scheduleDialog.scheduleId} {...scheduleDialog} />}
      {handOffToDialog && <HandOffToDialog key={handOffToDialog.workspaceId} {...handOffToDialog} />}
      {reconcileDialog && <ReconcileDialog key={reconcileDialog} transferId={reconcileDialog} />}
      {pairDialog && <PairDialog key={pairDialog} kind={pairDialog} />}
      {phoneSetupOpen && <PhoneSetupDialog />}
      <ControlRequestDialog />
      {reportProblemOpen && <ReportProblemDialog />}
      {compareArchive && <CompareArchiveDialog key={compareArchive.compareId} {...compareArchive} />}
      {portDialog?.kind === 'export' && <ExportDialog key={portDialog.workspaceId} workspaceId={portDialog.workspaceId} />}
      {portDialog?.kind === 'import' && <ImportDialog />}
      {checksConsent && <ChecksConsentDialog {...checksConsent} />}
      {fixChecksFor && <FixChecksDialog key={fixChecksFor} workspaceId={fixChecksFor} />}
      {fixCiFor && <FixCiDialog key={fixCiFor} workspaceId={fixCiFor} />}
      {resolveBaseFor && <ResolveBaseDialog key={resolveBaseFor} workspaceId={resolveBaseFor} />}
      {alertDiff && <AlertDiffDialog key={alertDiff.alertId} {...alertDiff} />}
      {newWorkspaceRepo && <NewWorkspaceDialog key={newWorkspaceRepo} repoId={newWorkspaceRepo} initialPrompt={newWorkspacePrompt ?? undefined} initialTemplateId={newWorkspaceTemplate ?? undefined} />}
      {addRepoDialog === 'clone' && <CloneRepoDialog />}
      {addRepoDialog === 'quick-start' && <QuickStartDialog />}
      {makeRepoDir && <MakeRepoDialog key={makeRepoDir} dir={makeRepoDir} />}
      {createOrganizationOpen && <CreateOrganizationDialog />}
      <Overlays />
      <Announcer />
      <Tour />
      <StopSafely />
      <WhatsNew />
      <DropFolder />
      <ToastHost />
    </div>
  )
}
