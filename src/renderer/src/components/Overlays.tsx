import { CaseSensitive, Eye, File, Regex, RotateCcw, Search, Trash2, WholeWord } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AGENTS } from '../../../shared/agents'
import type { GitActionKind, SearchMatch, Settings } from '../../../shared/types'
import { rankFiles, rankItems } from '../fuzzy'
import {
  activeSessionId,
  addRepository,
  api,
  attempt,
  getState,
  newChat,
  openAddRepoDialog,
  openArchiveDialog,
  openArchivedChats,
  openExportDialog,
  openHandOffDialog,
  openImportDialog,
  runChecks,
  openMcpStatus,
  openNewWorkspace,
  openOverlay,
  openAssistant,
  openAutomations,
  openPhoneSetup,
  openReportProblem,
  showGetStarted,
  startTour,
  openSettingsPage,
  requestOpenFile,
  reopenChat,
  restoreArchived,
  openSessions,
  selectSession,
  selectWorkspace,
  timeAgo,
  toggleBottomPanel,
  toggleLeftPanel,
  toggleRightPanel,
  toggleZen,
  useStore
} from '../store'
import { runGitAction } from './GitPanel'
import { resetPanelSizes } from './resize'
import { ActionRow, Button, Combobox, Dialog, IconButton, Kbd, Segmented, Tag } from '../ui'
import { CATEGORIES } from './settings/registry'
import { SearchChats } from './SearchChats'
import { OpenInSwitcher } from './OpenIn'
import { AskOverlay } from './assistant/AskOverlay'
import { formatChord, formatKeys, GROUP_LABELS, groupedShortcuts, gitShortcutId, shortcutHint } from '../shortcuts'
import { requestSavedCommand } from './SavedCommands'
import { commandsForRepo, needsApproval } from '../../../shared/savedCommands'
import { wsPath } from '../../../shared/workspacePath'
import { cloudSettings } from '../../../shared/cloud'
import { useT } from '../i18n'

/** The palette, quick open, search, shortcuts and archive list: a dialog the user can leave with Escape from anywhere in it. */
function Overlay({ title, hideTitle, children, wide }: { title: string; hideTitle?: boolean; children: ReactNode; wide?: boolean }) {
  // Escape closes the overlay wherever focus is, before Settings sees it. (A combobox that is always open would
  // otherwise keep the key for itself, to close its own list.)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      openOverlay(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return (
    <Dialog title={title} hideTitle={hideTitle} size={wide ? 'xl' : 'lg'} className="overlay" layerClassName="overlay-backdrop" onClose={() => openOverlay(null)}>
      {children}
    </Dialog>
  )
}

interface Command {
  id: string
  label: string
  detail?: string
  group: string
  hint?: string
  // A short label at the end of the row (O9: "from repo · asks first").
  tag?: string
  run: () => void
}

export function CommandPalette() {
  const snapshot = useStore((s) => s.snapshot!)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const [query, setQuery] = useState('')
  const platform = snapshot.platform
  const t = useT()
  const ws = snapshot.workspaces.find((w) => w.id === selectedId && w.state !== 'archived')

  const commands = useMemo(() => {
    const list: Command[] = []
    const close = (fn: () => void) => () => {
      openOverlay(null)
      fn()
    }
    for (const w of snapshot.workspaces.filter((x) => x.state !== 'archived')) {
      const repo = snapshot.repos.find((r) => r.id === w.repoId)
      list.push({ id: `ws-${w.id}`, label: w.name, detail: `${repo?.name ?? ''} · ${w.branch}`, group: t('palette.group.workspaces'), run: close(() => selectWorkspace(w.id)) })
    }
    if (ws) {
      for (const session of snapshot.sessions.filter((s) => s.workspaceId === ws.id)) {
        list.push({
          id: `chat-${session.id}`, label: session.title || t('palette.chat.untitled'),
          detail: session.closedAt ? t('palette.chat.closed', { agent: session.agent }) : session.agent, group: t('palette.group.chats'),
          run: close(() => {
            if (session.closedAt) void reopenChat(ws.id, session.id)
            else selectSession(ws.id, session.id)
          })
        })
      }
      if (ws.state === 'history') {
        // History only: no worktree, so no git, editor or preview commands.
        list.push({ id: 'export', label: t('palette.exportWorkspace'), group: t('palette.group.workspace'), run: close(() => openExportDialog(ws.id)) })
        list.push({ id: 'archive', label: t('palette.archiveWorkspace'), group: t('palette.group.workspace'), run: close(() => openArchiveDialog(ws.id)) })
      } else {
        const git = (label: string, action: GitActionKind) =>
          list.push({ id: `git-${action}`, label, group: t('palette.group.workspace'), hint: shortcutHint(gitShortcutId(action), platform), run: close(() => void runGitAction(ws.id, action)) })
        list.push({ id: 'new-chat', label: t('palette.newChat'), group: t('palette.group.workspace'), hint: shortcutHint('chat.new', platform), run: close(() => void newChat(ws.id)) })
        const chat = snapshot.sessions.find((s) => s.id === activeSessionId(getState(), ws.id))
        if (chat && AGENTS[chat.agent].builtinCommands.some((c) => c.name === 'mcp-status')) list.push({ id: 'mcp-status', label: t('palette.mcpStatus'), detail: '/mcp-status', group: t('palette.group.workspace'), run: close(() => openMcpStatus(chat.id)) })
        list.push({ id: 'quick-open', label: t('palette.openFile'), group: t('palette.group.workspace'), hint: shortcutHint('file.quickOpen', platform), run: () => openOverlay('quick-open') })
        list.push({ id: 'search', label: t('palette.searchInFiles'), group: t('palette.group.workspace'), hint: shortcutHint('search.open', platform), run: () => openOverlay('search') })
        git(t('palette.git.createPr'), 'create-pr')
        git(t('palette.git.createDraftPr'), 'create-draft-pr')
        git(t('palette.git.commitAndPush'), 'commit-and-push')
        git(t('palette.git.pull'), 'pull')
        git(t('palette.git.merge'), 'merge')
        const configuredChecks = snapshot.repoSettings[ws.repoId]?.values.checks.length ?? 0
        if (configuredChecks && ws.checks?.running) list.push({ id: 'cancel-checks', label: t('palette.cancelChecks'), group: t('palette.group.workspace'), run: close(() => void attempt(() => api.cancelChecks(ws.id))) })
        else if (configuredChecks) list.push({ id: 'run-checks', label: t('palette.runChecks'), detail: t('palette.runChecksDetail'), group: t('palette.group.workspace'), run: close(() => void runChecks(ws.id)) })
        git(t('palette.git.fixCi'), 'fix-errors')
        git(t('palette.git.rerunChecks'), 'rerun-checks')
        git(t('palette.git.resolveConflicts'), 'resolve-conflicts')
        git(t('palette.git.review'), 'review')
        if (chat) list.push({ id: 'second-opinion', label: t('palette.secondOpinion'), detail: t('palette.secondOpinionDetail'), group: t('palette.group.workspace'), run: close(() => openHandOffDialog({ sourceId: chat.id, kind: 'second-opinion' })) })
        git(t('palette.git.openPr'), 'open-pr')
        // A cloud workspace has no folder here: no editor, Open in, reveal, preview or export.
        if (!ws.cloud) {
          list.push({ id: 'open-editor', label: t('palette.openEditor'), group: t('palette.group.workspace'), run: close(() => void attempt(() => api.openInEditor(wsPath(ws)))) })
          // #14: the ⌘O switcher.
          list.push({ id: 'open-in', label: t('openIn.command'), detail: t('openIn.commandDetail'), group: t('palette.group.workspace'), hint: shortcutHint('openIn.toggle', platform), run: () => openOverlay('open-in') })
          list.push({ id: 'reveal', label: snapshot.platform === 'darwin' ? t('palette.revealFinder') : t('palette.openFolder'), group: t('palette.group.workspace'), run: close(() => void attempt(() => api.openPath(wsPath(ws)))) })
          list.push({ id: 'preview', label: t('palette.openPreview'), group: t('palette.group.workspace'), hint: shortcutHint('workspace.preview', platform), run: close(() => void attempt(() => api.openPreview(ws.id))) })
          list.push({ id: 'export', label: t('palette.exportWorkspace'), group: t('palette.group.workspace'), run: close(() => openExportDialog(ws.id)) })
        }
        list.push({ id: 'archive', label: t('palette.archiveWorkspace'), group: t('palette.group.workspace'), run: close(() => openArchiveDialog(ws.id)) })
        // O9: saved commands, only inside a workspace that can run them; each opens a new terminal tab there.
        if (ws.state === 'ready' || ws.state === 'setup-failed') {
          const saved = commandsForRepo(snapshot.settings.savedCommands ?? [], snapshot.repoCommands?.[ws.repoId] ?? [], ws.repoId)
          for (const c of [...saved.repo, ...saved.all]) {
            list.push({
              id: `saved-${c.id}`,
              label: t('commands.palette.run', { name: c.name }),
              detail: c.command.split(/\r?\n/)[0],
              group: t('commands.palette.group'),
              tag: c.source === 'repo' ? (needsApproval(c) ? t('commands.palette.fromRepoAsks') : t('commands.fromRepoTag')) : undefined,
              run: close(() => requestSavedCommand(ws.id, c.id))
            })
          }
          list.push({ id: 'saved-edit', label: t('commands.palette.edit'), detail: t('commands.palette.editDetail'), group: t('commands.palette.group'), run: close(() => openAutomations(null, 'commands')) })
        }
      }
    }
    const repoId = ws?.repoId ?? snapshot.repos[0]?.id
    if (repoId) list.push({ id: 'new-ws', label: t('palette.newWorkspace'), group: t('palette.group.general'), hint: shortcutHint('workspace.new', platform), run: close(() => openNewWorkspace(repoId)) })
    if (snapshot.repos.length) list.push({ id: 'import-ws', label: t('palette.importWorkspace'), group: t('palette.group.general'), detail: t('palette.importWorkspaceDetail'), run: close(() => openImportDialog()) })
    list.push({ id: 'add-repo', label: t('palette.openProject'), group: t('palette.group.general'), run: close(() => void addRepository()) })
    list.push({ id: 'clone-repo', label: t('palette.openGithubProject'), group: t('palette.group.general'), run: close(() => openAddRepoDialog('clone')) })
    list.push({ id: 'quick-start', label: t('palette.quickStart'), group: t('palette.group.general'), run: close(() => openAddRepoDialog('quick-start')) })
    list.push({ id: 'archived', label: t('palette.viewArchived'), group: t('palette.group.general'), run: () => openOverlay('archived') })
    list.push({
      id: 'theme',
      label: t('palette.toggleTheme'),
      group: t('palette.group.general'),
      hint: shortcutHint('theme.toggle', platform),
      run: close(() => {
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
        void attempt(() => api.updateSettings({ theme: dark ? 'light' : 'dark' }))
      })
    })
    list.push({ id: 'left', label: t('palette.toggleSidebar'), group: t('palette.group.general'), hint: shortcutHint('panel.left', platform), run: close(toggleLeftPanel) })
    list.push({ id: 'right', label: t('palette.toggleSidePanel'), group: t('palette.group.general'), hint: shortcutHint('panel.right', platform), run: close(toggleRightPanel) })
    list.push({ id: 'zen', label: t('palette.zen'), group: t('palette.group.general'), hint: shortcutHint('zen.toggle', platform), run: close(toggleZen) })
    list.push({ id: 'bottom', label: t('palette.toggleTerminal'), group: t('palette.group.general'), hint: shortcutHint('panel.bottom', platform), run: close(toggleBottomPanel) })
    const { windowLayout, sidebarSide, sidePanelSide, terminalPlacement } = snapshot.settings
    const layout = (id: string, label: string, patch: Partial<Settings>) =>
      list.push({ id, label, group: t('palette.group.layout'), run: close(() => void attempt(() => api.updateSettings(patch))) })
    layout('layout-window', windowLayout === 'tiles' ? t('palette.layout.panes') : t('palette.layout.tiles'), { windowLayout: windowLayout === 'tiles' ? 'panes' : 'tiles' })
    layout('layout-sidebar', sidebarSide === 'right' ? t('palette.layout.sidebarLeft') : t('palette.layout.sidebarRight'), { sidebarSide: sidebarSide === 'right' ? 'left' : 'right' })
    layout('layout-panel', sidePanelSide === 'left' ? t('palette.layout.panelRight') : t('palette.layout.panelLeft'), { sidePanelSide: sidePanelSide === 'left' ? 'right' : 'left' })
    if (terminalPlacement !== 'below-chat') layout('layout-terminal-chat', t('palette.layout.terminalChat'), { terminalPlacement: 'below-chat' })
    if (terminalPlacement !== 'panel-bottom') layout('layout-terminal-bottom', t('palette.layout.terminalBottom'), { terminalPlacement: 'panel-bottom' })
    if (terminalPlacement !== 'panel-top') layout('layout-terminal-top', t('palette.layout.terminalTop'), { terminalPlacement: 'panel-top' })
    list.push({ id: 'layout-sizes', label: t('palette.layout.resetSizes'), group: t('palette.group.layout'), run: close(resetPanelSizes) })
    list.push({ id: 'layout-settings', label: t('palette.layout.settings'), group: t('palette.group.layout'), run: close(() => openSettingsPage({ section: 'appearance', scrollTo: 'sidebar-side' })) })
    list.push({ id: 'keys', label: t('palette.shortcuts'), group: t('palette.group.general'), hint: shortcutHint('shortcuts.help', platform), run: () => openOverlay('shortcuts') })
    list.push({ id: 'automations', label: t('palette.automations'), group: t('palette.group.general'), detail: t('palette.automationsDetail'), run: close(() => openAutomations()) })
    if (snapshot.settings.assistantEnabled) list.push({ id: 'ask', label: t('ask.title'), group: t('palette.group.general'), detail: t('ask.paletteDetail'), hint: shortcutHint('assistant.ask', platform), run: () => openOverlay('ask') })
    if (snapshot.settings.assistantEnabled) list.push({ id: 'assistant', label: t('assistant.title'), group: t('palette.group.general'), detail: t('assistant.entry.title'), hint: shortcutHint('assistant.toggle', platform), run: close(() => openAssistant()) })
    list.push({ id: 'phone', label: t('palette.phone'), group: t('palette.group.general'), detail: t('palette.phoneDetail'), run: close(() => openPhoneSetup(true)) })
    list.push({ id: 'get-started', label: t('palette.getStarted'), group: t('palette.group.general'), detail: t('palette.getStartedDetail'), run: showGetStarted })
    list.push({ id: 'tour', label: t('tour.label'), group: t('palette.group.general'), detail: t('tour.paletteDetail'), run: startTour })
    list.push({ id: 'report-problem', label: t('report.command'), group: t('palette.group.general'), detail: t('report.commandDetail'), run: () => openReportProblem(true) })
    for (const c of CATEGORIES)
      list.push({ id: `settings-${c.id}`, label: t('palette.settingsPage', { page: t(c.label) }), group: t('palette.group.settings'), run: close(() => openSettingsPage({ section: c.pages[0] } as Parameters<typeof openSettingsPage>[0])) })
    return list
  }, [snapshot, ws, platform, t])

  const shown = rankItems(commands, query, (c) => (c.detail ? `${c.label} ${c.detail}` : c.label))

  return (
    <Overlay title={t('overlays.palette.title')} hideTitle>
      <Combobox
        className="overlay-combo"
        label={t('overlays.palette.title')}
        placeholder={t('palette.placeholder')}
        autoFocus
        inline
        open
        leading={<Search size={15} aria-hidden />}
        query={query}
        onQueryChange={setQuery}
        empty={t('overlays.noMatches')}
        options={shown.map((c) => ({
          value: c.id,
          label: c.label,
          // Groups head the full list only; a search shows the matches alone.
          group: query ? undefined : c.group,
          description: c.detail,
          trailing: (c.tag || c.hint) && (
            <>
              {c.tag && <Tag>{c.tag}</Tag>}
              {c.hint && <Kbd>{c.hint}</Kbd>}
            </>
          )
        }))}
        onChange={(id) => shown.find((c) => c.id === id)?.run()}
      />
    </Overlay>
  )
}

export function QuickOpen() {
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const [files, setFiles] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const t = useT()

  useEffect(() => {
    if (selectedId) void api.listFiles(selectedId).then(setFiles).catch(() => undefined)
  }, [selectedId])

  const shown = rankFiles(files, query)
  if (!selectedId) return null

  return (
    <Overlay title={t('overlays.quickOpen.title')} hideTitle>
      <Combobox
        className="overlay-combo"
        label={t('overlays.quickOpen.title')}
        placeholder={t('quickOpen.placeholder')}
        autoFocus
        mono
        inline
        open
        leading={<File size={15} aria-hidden />}
        query={query}
        onQueryChange={setQuery}
        options={shown.map((file) => {
          const slash = file.lastIndexOf('/')
          const dir = file.slice(0, slash + 1)
          // `mono` sets the file names; the folder is a description, so it asks for the code font itself.
          return { value: file, label: file.slice(slash + 1), description: dir ? <span className="mono">{dir}</span> : undefined, title: file }
        })}
        onChange={(file) => requestOpenFile(selectedId, file)}
      />
    </Overlay>
  )
}

/** ⌘⇧F: search in the workspace's files, or in every chat. */
export function SearchOverlay() {
  // An archived workspace read-only (#13) has no files to search.
  const hasFiles = useStore((s) => s.snapshot!.workspaces.some((w) => w.id === s.selectedWorkspaceId && w.state !== 'archived'))
  const [scope, setScope] = useState<'files' | 'chats'>(hasFiles ? 'files' : 'chats')
  const t = useT()
  const switcher = (
    <Segmented
      plain
      small
      label={t('search.scope.label')}
      value={scope}
      options={[...(hasFiles ? [{ value: 'files' as const, label: t('search.scope.files') }] : []), { value: 'chats' as const, label: t('search.scope.chats') }]}
      onChange={setScope}
    />
  )
  return (
    <Overlay wide title={t('overlays.search.title')} hideTitle>
      {scope === 'chats' ? <SearchChats scopeSwitch={switcher} /> : <SearchFiles scopeSwitch={switcher} />}
    </Overlay>
  )
}

function SearchFiles({ scopeSwitch }: { scopeSwitch: ReactNode }) {
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState({ caseSensitive: false, wholeWord: false, regex: false })
  const [results, setResults] = useState<SearchMatch[]>([])
  const [searching, setSearching] = useState(false)
  const latest = useRef(0)
  const t = useT()

  useEffect(() => {
    if (!selectedId || !query.trim()) {
      setResults([])
      return
    }
    const id = ++latest.current
    const timer = setTimeout(async () => {
      setSearching(true)
      const found = await attempt(() => api.searchFiles(selectedId, query, options))
      if (id === latest.current) {
        setResults(found ?? [])
        setSearching(false)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [selectedId, query, options])

  if (!selectedId) return null
  const toggle = (key: keyof typeof options, icon: ReactNode, title: string) => (
    <IconButton label={title} pressed={options[key]} onClick={() => setOptions({ ...options, [key]: !options[key] })}>
      {icon}
    </IconButton>
  )

  return (
    <Combobox
      className="overlay-combo"
      label={t('overlays.search.title')}
      placeholder={t('searchFiles.placeholder')}
      autoFocus
      inline
      open
      leading={<Search size={15} aria-hidden />}
      trailing={
        <>
          {scopeSwitch}
          {toggle('caseSensitive', <CaseSensitive size={15} />, t('terminal.find.matchCase'))}
          {toggle('wholeWord', <WholeWord size={15} />, t('searchFiles.wholeWord'))}
          {toggle('regex', <Regex size={15} />, t('searchFiles.regex'))}
        </>
      }
      query={query}
      onQueryChange={setQuery}
      empty={searching ? t('overlays.searching') : query ? t('overlays.noMatches') : undefined}
      options={results.map((m, n) => ({ value: n, label: m.text.trim(), group: m.file, leading: <span className="line-no">{m.line}</span>, title: `${m.file}:${m.line}` }))}
      footer={results.length >= 500 ? t('searchFiles.capped') : undefined}
      onChange={(n) => {
        const m = results[n]
        if (m) requestOpenFile(selectedId, m.file, m.line)
      }}
    />
  )
}

export function ShortcutsHelp() {
  const platform = useStore((s) => s.snapshot!.platform)
  const t = useT()
  return (
    <Overlay wide title={t('palette.shortcuts')}>
      <div className="shortcut-grid">
        {/* Every row comes from the shortcut registry (shortcuts.ts); nothing is listed by hand here. */}
        {groupedShortcuts().map(({ group, entries }) => (
          <section key={group}>
            <h3>{t(GROUP_LABELS[group])}</h3>
            {entries.map((entry) => (
              <div key={entry.id} className="shortcut-row">
                <span>{t(entry.labelKey)}</span>
                <Kbd>{entry.display ? t(entry.display) : formatKeys(entry, platform)}</Kbd>
              </div>
            ))}
          </section>
        ))}
      </div>
      <p className="faint small">{t('shortcuts.workspaceKeysMoved', { from: `${formatChord('mod+alt+ArrowUp', platform)} / ${formatChord('mod+alt+ArrowDown', platform)}`, to: shortcutHint('workspace.prevNext', platform) ?? '' })}</p>
    </Overlay>
  )
}

export function ArchivedList() {
  const snapshot = useStore((s) => s.snapshot!)
  const archived = snapshot.workspaces.filter((w) => w.state === 'archived').sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))
  const t = useT()
  const [busy, setBusy] = useState<string | null>(null)
  const restore = async (id: string) => {
    setBusy(id)
    await restoreArchived(id)
    setBusy(null)
  }
  return (
    <Overlay wide title={t('archivedList.title')}>
      {archived.length > 0 && <p className="faint small archived-hint">{t('archivedView.list.hint')}</p>}
      {archived.length === 0 && <p className="faint">{t('archivedList.empty')}</p>}
      <div role="list">
        {archived.map((w) => {
          const repo = snapshot.repos.find((r) => r.id === w.repoId)
          return (
            <ActionRow
              key={w.id}
              role="listitem"
              divided
              actions={
                <>
                  {/* #13: read without restoring; nothing is called in main. */}
                  <Button size="sm" icon={<Eye size={12} />} title={t('archivedView.list.readTitle')} onClick={() => openArchivedChats(w.id)} disabled={busy !== null}>
                    {t('archivedView.list.read')}
                  </Button>
                  <Button size="sm" icon={<RotateCcw size={12} />} onClick={() => void restore(w.id)} disabled={busy !== null}>
                    {busy === w.id ? t('archivedView.restoring') : t('archivedList.restore')}
                  </Button>
                  <IconButton
                    label={t('archivedList.forgetTitle')}
                    onClick={() => {
                      // A remote workspace's sandbox is deleted with its provider, its snapshots too unless Settings → Remote workspaces keeps them.
                      const question = w.cloud
                        ? t(cloudSettings(snapshot.settings).deleteSnapshotsOnForget ? 'cloud.archive.forgetConfirm' : 'cloud.archive.forgetConfirmKeep', { name: w.name })
                        : t('archivedList.forgetConfirm', { name: w.name })
                      if (window.confirm(question)) void attempt(() => api.forgetWorkspace(w.id))
                    }}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </>
              }
            >
              <div className="archived-name">{w.name}</div>
              <div className="faint small mono">
                {repo?.name} · {w.branch} · {t('archivedList.archivedAgo', { time: timeAgo(w.archivedAt) })} · {t('archivedView.list.chats', { count: openSessions(snapshot, w.id).length })}
              </div>
            </ActionRow>
          )
        })}
      </div>
    </Overlay>
  )
}

export function Overlays() {
  const overlay = useStore((s) => s.overlay)
  if (overlay === 'palette') return <CommandPalette />
  if (overlay === 'quick-open') return <QuickOpen />
  if (overlay === 'search') return <SearchOverlay />
  if (overlay === 'shortcuts') return <ShortcutsHelp />
  if (overlay === 'archived') return <ArchivedList />
  if (overlay === 'open-in') return <OpenInSwitcher />
  if (overlay === 'ask') return <AskOverlay />
  return null
}

/** Exported for the palette's "current chat" context. */
export function activeChat(): string | undefined {
  const s = getState()
  return s.selectedWorkspaceId ? activeSessionId(s, s.selectedWorkspaceId) : undefined
}
