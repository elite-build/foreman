import { useEffect, useState } from 'react'
import { ArchiveDialog } from './components/ArchiveDialog'
import { StopSafely } from './components/StopSafely'
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
import { ReportProblemDialog } from './components/ReportProblemDialog'
import { DropFolder } from './components/DropFolder'
import { Sidebar } from './components/Sidebar'
import { Home } from './components/Home'
import { liveRepo, sidebarOrder } from './triage'
import { WorkspaceView } from './components/WorkspaceView'
import { TilesView } from './components/tiles/TilesView'
import './components/workspace.css'
import { CloneRepoDialog, MakeRepoDialog, QuickStartDialog } from './components/AddRepository'
import { Overlays } from './components/Overlays'
import { Announcer, ToastHost } from './components/Announcer'
import { Tour } from './components/Tour'
import { sendSetupSelectionToChat } from './components/SetupLog'
import { equipLoadout } from './components/composer/AgentPicker'
import { runGitAction } from './components/GitPanel'
import { dispatchShortcut, platformOf, type ShortcutActions } from './shortcuts'
import { t } from './i18n'
import { Button } from './ui'
import {
  activeSessionId,
  addRepository,
  api,
  attempt,
  closeChat,
  closeBrowserTab,
  focusBrowserAddress,
  forkChat,
  getState,
  modKey,
  newChat,
  openNewWorkspace,
  openArchiveDialog,
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
  toggleRightPanel,
  toggleTerminalFullscreen,
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
  toggleRightPanel,
  toggleBottomPanel,
  toggleZen,
  toggleSettings: () => openSettingsPage(getState().settingsPage ? null : { section: 'general' }),
  toggleAssistant,
  toggleTerminalFullscreen,
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
          order: () => sidebarOrder({ ...state, snapshot }, state.sidebarView),
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
  const phoneSetupOpen = useStore((s) => s.phoneSetupOpen)
  const reportProblemOpen = useStore((s) => s.reportProblemOpen)
  const leftPanelOpen = useStore((s) => s.leftPanelOpen)
  const rightPanelOpen = useStore((s) => s.rightPanelOpen)
  const newWorkspaceRepo = useStore((s) => s.newWorkspaceRepo)
  const newWorkspacePrompt = useStore((s) => s.newWorkspacePrompt)
  const newWorkspaceTemplate = useStore((s) => s.newWorkspaceTemplate)
  const addRepoDialog = useStore((s) => s.addRepoDialog)
  const makeRepoDir = useStore((s) => s.makeRepoDir)
  const sidebarSide = useStore((s) => s.snapshot?.settings.sidebarSide ?? 'left')
  const tiled = useStore((s) => s.snapshot?.settings.windowLayout === 'tiles')
  const tileZoom = useStore((s) => s.tileZoom)
  const windowWidth = useWindowWidth()
  // Leave the chat column 420px, plus the side panel's narrowest width when it's open.
  const sidebar = usePanelSize('sidebar', 312, 260, Math.min(480, windowWidth - 420 - (rightPanelOpen ? 280 : 0)))
  // Workspaces stay mounted once opened so terminals and scroll positions survive switching.
  const [opened, setOpened] = useState<string[]>([])
  if (selectedId && !opened.includes(selectedId)) setOpened([...opened, selectedId])
  useShortcuts()
  // A first launch opens the welcome tour once; finishing or skipping it sets tourSeen.
  const tourPending = snapshot?.settings.tourSeen === false
  useEffect(() => {
    if (tourPending) startTour()
  }, [tourPending])

  if (!snapshot) return null
  // An archived workspace is shown read-only (#13) only while it's the selected one.
  const liveOpened = opened.filter((id) => snapshot.workspaces.some((w) => w.id === id && (w.state !== 'archived' || id === selectedId)))
  const covered = Boolean(settingsPage) || automations || assistantOpen
  const selected = snapshot.workspaces.find((w) => w.id === selectedId)
  // Tiles: a workspace opened full size, or an archived one being read, takes the whole area as in Three panes.
  const fullView = tiled && selected && (selected.state === 'archived' || tileZoom === selected.id) ? selected.id : null
  const showHome = !covered && (tiled ? !selected : !selectedId || !liveOpened.includes(selectedId))
  const sidebarRight = sidebarSide === 'right'
  // The main area reaches the window's left edge (where macOS draws the traffic lights).
  const mainFirst = !leftPanelOpen || sidebarRight

  return (
    <div
      className={`app platform-${snapshot.platform} ${leftPanelOpen ? '' : 'no-sidebar'} ${sidebarRight ? 'sidebar-right' : ''} ${mainFirst ? 'main-first' : ''}`}
      style={leftPanelOpen ? { gridTemplateColumns: sidebarRight ? `1fr ${sidebar.size}px` : `${sidebar.size}px 1fr` } : undefined}
    >
      {leftPanelOpen && <Sidebar resize={sidebar} side={sidebarSide} />}
      <main className="main">
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
        {showHome && <Home />}
      </main>
      {backgroundArchives.length > 0 && (
        <div className="background-archives" role="group" aria-label={t('stop.archive.viewProgress')}>
          {backgroundArchives.filter((id) => id !== archiveTarget).map((id) => (
            <Button key={id} onClick={() => openArchiveDialog(id)}>
              {snapshot.workspaces.find((ws) => ws.id === id)?.name} · {t('stop.archive.viewProgress')}
            </Button>
          ))}
        </div>
      )}
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
      <Overlays />
      <Announcer />
      <Tour />
      <StopSafely />
      <DropFolder />
      <ToastHost />
    </div>
  )
}
