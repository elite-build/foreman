import {
  Archive,
  CircleHelp,
  Cloud,
  FileDown,
  FolderInput,
  FolderRoot,
  GitBranch,
  Keyboard,
  PanelLeftClose,
  PanelRightClose,
  Pin,
  Plus,
  Search,
  Settings,
  X,
  icons,
  type LucideIcon
} from 'lucide-react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { PlainKey } from '../../../shared/i18n'
import type { PaneSide, Repo, RepoIcon, Workspace, WorkspaceStatus } from '../../../shared/types'
import { useT } from '../i18n'
import { shortcutHint } from '../shortcuts'
import {
  api,
  attempt,
  copyWorkspaceLink,
  markAllRead,
  markWorkspaceUnread,
  modKey,
  openArchiveDialog,
  openExportDialog,
  openHandOffTo,
  openImportDialog,
  openNewWorkspace,
  openOverlay,
  openSettingsPage,
  selectSession,
  recordMilestone,
  selectWorkspace,
  setSidebarFilter,
  setSidebarQuery,
  showRepoHome,
  startTour,
  timeAgo,
  toggleLeftPanel,
  toggleShowFinished,
  useStore
} from '../store'
import { resolveFilter, VIEW_LABEL, viewsOn } from '../../../shared/views'
import { LATER_CHOICES, putAway, waitingLater } from '../../../shared/later'
import { bringBackNow, laterChoiceLabel, laterWhen, saveForLater, takeOutOfLater, useLaterWake } from '../later'
import { BUCKET_LABEL, liveRepo, sidebarGroups, sidebarOrder, STATUS_LABEL, triageAll, type SidebarFilter, type Triage, type TriageInput } from '../triage'
import { promptTitle } from '../../../shared/compare'
import type { CompareSection } from '../../../shared/triage'
import { AddRepoItems } from './AddRepository'
import { RemoveRepoDialog } from './settings/RepoMiscTab'
import { ResizeHandle, type PanelSize } from './resize'
import { AutomationsEntry } from './automations/AutomationsEntry'
import { AssistantEntry } from './assistant/AssistantEntry'
import { PhonePill } from './phone/PhonePill'
import { KeepAwakeChip } from './KeepAwakeChip'
import { ResourceUsage } from './ResourceUsage'
import { SttChip } from './SttChip'
import { UpdateNotice } from './UpdateNotice'
import { TerminalAgentLabel, useHasTerminalAgent } from './agents/TerminalAgents'
import { leadGlyph } from '../../../shared/attention'
import { clockTime } from '../../../shared/usageLimit'
import { PrGlyphView } from './Attention'
import { GitlabMark } from './GitlabMark'
import { cloudAction, CloudSub } from './cloud/CloudBits'
import { isGitlabWorkspace } from '../../../shared/scm'
import { ActionRow, Button, CardButton, ChipButton, ContextMenu, IconButton, Kbd, LinkButton, MenuButton, MenuGroup, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator, Spinner, Status, Tab, TabList, Tabs, TextInput, type StatusTone } from '../ui'

/** A Lucide icon by name: PascalCase ("GitBranch") or kebab-case ("git-branch"). */
export function lucideIcon(name: string | undefined): LucideIcon | undefined {
  if (!name) return undefined
  const all = icons as Record<string, LucideIcon>
  const pascal = name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')
  return all[name] ?? all[pascal]
}

export function RepoIconView({ icon, size = 14 }: { icon?: RepoIcon; size?: number }) {
  if (!icon) return null
  if (icon.kind === 'emoji') {
    return (
      <span className="repo-icon emoji" style={{ fontSize: size - 1, width: size, height: size }} aria-hidden>
        {icon.value}
      </span>
    )
  }
  if (icon.kind === 'image') return <img className="repo-icon image" src={icon.dataUrl} width={size} height={size} alt="" />
  const Icon = lucideIcon(icon.name)
  return Icon ? <Icon size={size} className="repo-icon" aria-hidden /> : null
}

export function DiffBadge({ additions, deletions, muted }: { additions: number; deletions: number; muted?: boolean }) {
  if (!additions && !deletions) return null
  return (
    <span className={`diff-badge ${muted ? 'muted' : ''}`}>
      {additions > 0 && <span className="add">+{additions}</span>}
      {deletions > 0 && <span className="del">-{deletions}</span>}
    </span>
  )
}

/** Open a workspace, on the chat that needs the user if there is one. */
export function openTriaged(t: Triage): void {
  selectWorkspace(t.ws.id)
  // Back from Later: opening it is what bringing it back was for, so it leaves Later.
  if (t.laterBack) void attempt(() => api.updateWorkspace(t.ws.id, { later: null }))
  if (t.bucket === 'attention') recordMilestone('needsYou')
  if (t.bucket === 'attention' && t.sessionId) selectSession(t.ws.id, t.sessionId)
}

/** Everything triage needs, read from the store. */
export function useTriageInput(): TriageInput {
  const snapshot = useStore((s) => s.snapshot)!
  const approvals = useStore((s) => s.approvals)
  const unread = useStore((s) => s.unread)
  const unreadSessions = useStore((s) => s.unreadSessions)
  // Labels and facts in the UI language.
  const t = useT()
  return { snapshot, approvals, unread, unreadSessions, t }
}

function WorkspaceMenu({ ws, x, y, onRename, dismiss }: { ws: Workspace; x: number; y: number; onRename: () => void; dismiss: () => void }) {
  const t = useT()
  const unread = useStore((s) => Boolean(s.unread[ws.id]))
  return (
    <ContextMenu x={x} y={y} label={ws.name} onClose={dismiss}>
      <MenuItem onSelect={onRename}>{t('common.rename')}</MenuItem>
      <MenuItem onSelect={() => void attempt(() => api.updateWorkspace(ws.id, { pinned: !ws.pinned }))}>{ws.pinned ? t('sidebar.menu.unpin') : t('sidebar.menu.pin')}</MenuItem>
      <MenuItem onSelect={() => markWorkspaceUnread(ws.id, !unread)}>{unread ? t('sidebar.menu.markRead') : t('sidebar.menu.markUnread')}</MenuItem>
      <MenuSeparator />
      <MenuLabel>{t('sidebar.menu.status')}</MenuLabel>
      <MenuGroup label={t('sidebar.menu.status')}>
        {(Object.keys(STATUS_LABEL) as WorkspaceStatus[]).map((status) => (
          <MenuRadioItem key={status} checked={ws.status === status} onSelect={() => void attempt(() => api.updateWorkspace(ws.id, { status }))}>
            {t(STATUS_LABEL[status])}
          </MenuRadioItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuLabel>{t('later.menu')}</MenuLabel>
      <MenuGroup label={t('later.menu')}>
        {ws.later && <MenuItem onSelect={() => void bringBackNow(ws)}>{t('later.menu.now')}</MenuItem>}
        {LATER_CHOICES.map((choice) => (
          <MenuItem key={choice} onSelect={() => void saveForLater(ws, choice, t)}>
            {laterChoiceLabel(choice, t)}
          </MenuItem>
        ))}
        {ws.later && <MenuItem onSelect={() => void takeOutOfLater(ws, t)}>{t('later.menu.remove')}</MenuItem>}
      </MenuGroup>
      <MenuSeparator />
      {/* A cloud workspace has no folder here to export or hand off; its sandbox sleeps and wakes instead. */}
      {!ws.cloud && <MenuItem onSelect={() => openExportDialog(ws.id)}>{t('sidebar.menu.export')}</MenuItem>}
      {ws.state === 'ready' && !ws.transfer && !ws.cloud && <MenuItem onSelect={() => openHandOffTo({ workspaceId: ws.id })}>{t('sidebar.menu.handOff')}</MenuItem>}
      {ws.cloud && ws.state !== 'archived' && ws.cloud.status === 'running' && <MenuItem onSelect={() => void cloudAction('sleep', ws, t)}>{t('cloud.action.sleep')}</MenuItem>}
      {ws.cloud && ws.state !== 'archived' && (ws.cloud.status === 'sleeping' || ws.cloud.status === 'capped') && <MenuItem onSelect={() => void cloudAction('wake', ws, t)}>{t('cloud.action.wake')}</MenuItem>}
      {ws.path && <MenuItem onSelect={() => void navigator.clipboard.writeText(ws.path!)}>{t('openIn.copyPath')}</MenuItem>}
      {/* #3: foreman://workspace/<repo>/<workspace>?tab=N; opening it only navigates. */}
      <MenuItem onSelect={() => copyWorkspaceLink(ws.id)}>{t('attention.link.copy')}</MenuItem>
      <MenuItem variant="danger" onSelect={() => openArchiveDialog(ws.id)}>
        {t('sidebar.menu.archive')}
      </MenuItem>
    </ContextMenu>
  )
}

function RepoMenu({ repo, x, y, dismiss, onRemove }: { repo: Repo; x: number; y: number; dismiss: () => void; onRemove: () => void }) {
  const t = useT()
  return (
    <ContextMenu x={x} y={y} label={repo.name} onClose={dismiss}>
      <MenuItem onSelect={() => openNewWorkspace(repo.id)}>{t('sidebar.menu.newWorkspace')}</MenuItem>
      <MenuItem onSelect={() => openSettingsPage({ section: 'repo', repoId: repo.id })}>{t('sidebar.menu.repoSettings')}</MenuItem>
      <MenuItem onSelect={() => void navigator.clipboard.writeText(repo.rootPath)}>{t('openIn.copyPath')}</MenuItem>
      <MenuSeparator />
      <MenuItem variant="danger" onSelect={onRemove}>
        {t('sidebar.menu.removeRepo')}
      </MenuItem>
    </ContextMenu>
  )
}

// A row's tone says what it is in shape as well as colour (Status draws a glyph); `accent` has no glyph of its own.
export const DOT_TONE: Record<string, StatusTone> = { amber: 'warn', red: 'error', green: 'ok', blue: 'info', accent: 'info' }

/** #3: the row leads with what needs you, always; the PR glyph sits apart (PrGlyphView). */
function RowIcon({ t }: { t: Triage }) {
  switch (leadGlyph(t)) {
    case 'attention':
      // The row's label below says the same in words, so the glyph stays out of the reading order.
      return <Status compact aria-hidden tone={DOT_TONE[t.tone ?? ''] ?? 'off'} label={t.label ?? ''} />
    case 'spinner':
      return (
        <span className={`ws-spin ${t.tone ?? ''}`}>
          <Spinner size={13} />
        </span>
      )
    case 'pinned':
      return <Pin size={13} />
    case 'direct':
      return <FolderRoot size={13} />
    case 'adopted':
      return <FolderInput size={13} />
    case 'branch':
      // Cloud workspaces: the cloud is where its branch lives.
      return t.ws.cloud ? <Cloud size={13} /> : <GitBranch size={13} />
  }
}

function WorkspaceRow({ t, index, repo }: { t: Triage; index: number; repo?: Repo }) {
  const { ws } = t
  const tr = useT()
  const selected = useStore((s) => s.selectedWorkspaceId === ws.id)
  const platform = useStore((s) => s.snapshot!.platform)
  const coloredDiffs = useStore((s) => s.snapshot!.settings.coloredSidebarDiffs)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(ws.name)
  // A chat in the workspace that needs you keeps its label.
  const terminalAgent = useHasTerminalAgent(ws.id) && t.bucket !== 'attention'
  // G2: GitLab's mark on rows of GitLab repositories.
  const gitlab = useStore((s) => isGitlabWorkspace(ws, s.snapshot!.repos.find((r) => r.id === ws.repoId), s.snapshot!.settings.gitlabHosts ?? []))

  const saveName = () => {
    setRenaming(false)
    if (name.trim() && name.trim() !== ws.name) void attempt(() => api.updateWorkspace(ws.id, { name }))
  }
  // Repo (when listing them all), branch and age; the label says what's going on.
  const meta = [repo?.name, ws.branch, timeAgo(t.since)].filter(Boolean).join(' · ')
  const icon = (
    <span className="ws-icon" title={ws.direct ? tr('sidebar.row.direct') : ws.adopted ? tr('sidebar.row.adopted') : ws.pinned ? tr('sidebar.row.pinned') : ws.cloud ? tr('cloud.glyph') : undefined}>
      <RowIcon t={t} />
    </span>
  )

  return (
    <>
      <ActionRow
        className={`ws-row ${selected ? 'selected' : ''} ${t.bucket}`}
        selected={selected}
        onPress={() => openTriaged(t)}
        primaryProps={{ className: 'ws-flow' }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        editor={
          renaming ? (
            <div className="ws-edit">
              {icon}
              <TextInput
                compact
                className="ws-rename"
                aria-label={tr('common.rename')}
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveName()
                  if (e.key === 'Escape') setRenaming(false)
                }}
              />
            </div>
          ) : undefined
        }
        actions={
          <span className="ws-end">
            <PrGlyphView ws={ws} />
            {ws.diffStat && <DiffBadge additions={ws.diffStat.additions} deletions={ws.diffStat.deletions} muted={!coloredDiffs && !selected} />}
            {index >= 0 && index < 9 && (
              <span className="ws-shortcut">
                {modKey(platform)}
                {index + 1}
              </span>
            )}
            <IconButton className="ws-archive" label={tr('sidebar.row.archive')} onClick={() => openArchiveDialog(ws.id)}>
              <Archive size={13} />
            </IconButton>
          </span>
        }
      >
        {icon}
        <span className="ws-title">{ws.compare ? `${ws.name} · ${ws.compare.label}` : ws.name}</span>
        {/* #22: a Terminal agent's process and output activity replace the label while it runs; it never claims "needs you". */}
        {terminalAgent ? (
          <TerminalAgentLabel workspaceId={ws.id} />
        ) : (
          t.label && (
            <span className={`ws-label ${t.tone ?? ''}`}>
              {t.limitResume ? tr('attention.limit.resumesAt', { time: clockTime(Date.parse(t.limitResume.resetAt), tr.locale) }) : t.label}
              {t.limitResume ? <span className="ws-detail"> · {tr('attention.limit.usageLimit')}</span> : t.detail && <span className="ws-detail"> · {t.detail}</span>}
            </span>
          )
        )}
        <span className="ws-sub">
          <CloudSub ws={ws} />
          {gitlab && (
            <span className="ws-gitlab" title={tr('gitlab.sidebar.mark')}>
              <GitlabMark size={10} />
            </span>
          )}
          {meta}
        </span>
      </ActionRow>
      {menu && (
        <WorkspaceMenu
          ws={ws}
          x={menu.x}
          y={menu.y}
          dismiss={() => setMenu(null)}
          onRename={() => {
            setName(ws.name)
            setRenaming(true)
          }}
        />
      )}
    </>
  )
}

/** One comparison: its workspaces together under the prompt they were all given. Rows say which model each one is. */
function CompareGroupView({ section, order, repoId, repoById }: { section: CompareSection; order: string[]; repoId: string | null; repoById: Map<string, Repo> }) {
  const t = useT()
  return (
    <section className="ws-group compare" title={section.prompt}>
      <div className="ws-group-head">
        <span>{t('sidebar.compare', { prompt: promptTitle(section.prompt) })}</span>
        <span className="ws-group-count">{section.items.length}</span>
      </div>
      {section.items.map((t) => (
        <WorkspaceRow key={t.ws.id} t={t} index={order.indexOf(t.ws.id)} repo={repoId ? undefined : repoById.get(t.ws.repoId)} />
      ))}
    </section>
  )
}

/** Two letters for a repository without an icon: "kite" → "ki". */
function repoInitials(name: string): string {
  return (name.replace(/[^a-z0-9]/gi, '').slice(0, 2) || '?').toLowerCase()
}

/** The column of repositories down the left edge: All, each repo, and Add; search, shortcuts and settings at the bottom. */
function RepoRail({ attention }: { attention: Map<string | null, number> }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const connections = useStore((s) => s.snapshot!.integrations.connections)
  const mod = useStore((s) => modKey(s.snapshot!.platform))
  const platform = useStore((s) => s.snapshot!.platform)
  const settingsOpen = useStore((s) => Boolean(s.settingsPage))
  const current = useStore((s) => liveRepo(s.snapshot!, s.sidebarView.repo))
  const home = useStore((s) => !s.selectedWorkspaceId && !s.settingsPage)
  const [menu, setMenu] = useState<{ repo: Repo; x: number; y: number } | null>(null)
  const [removing, setRemoving] = useState<Repo | null>(null)
  const tile = (repoId: string | null, label: string, content: ReactNode) => {
    const count = attention.get(repoId) ?? 0
    const name = count ? t('sidebar.rail.needYou', { label, count }) : label
    return (
      // The wrapper draws the ring that says the tile's repository is also what Home is showing.
      <span key={repoId ?? 'all'} className={`rail-tile-wrap ${current === repoId && home ? 'on-home' : ''}`}>
        <CardButton
          className="rail-tile"
          selected={current === repoId}
          title={name}
          aria-label={name}
          aria-pressed={current === repoId}
          onClick={() => showRepoHome(repoId)}
          onContextMenu={(e) => {
            const repo = repos.find((r) => r.id === repoId)
            if (!repo) return
            e.preventDefault()
            setMenu({ repo, x: e.clientX, y: e.clientY })
          }}
        >
          {content}
          {count > 0 && (
            <span className="rail-badge" aria-hidden>
              {count > 9 ? '9+' : count}
            </span>
          )}
        </CardButton>
      </span>
    )
  }
  // A repository that chose its own GitHub connection says which, as the rail's tooltip.
  const githubNames = new Map(
    repos.flatMap((r) => {
      const id = r.integrations?.services?.github
      const name = id && id !== 'off' ? connections.find((c) => c.id === id)?.name : undefined
      return name ? [[r.id, name] as const] : []
    })
  )
  return (
    <nav className="repo-rail" aria-label={t('sidebar.rail.label')}>
      {tile(null, t('home.board.allRepos'), <span className="rail-text">{t('sidebar.rail.all')}</span>)}
      {repos.map((repo) =>
        tile(repo.id, githubNames.get(repo.id) ? `${repo.name} · ${githubNames.get(repo.id)}` : repo.name, repo.icon ? <RepoIconView icon={repo.icon} size={16} /> : <span className="rail-text">{repoInitials(repo.name)}</span>)
      )}
      {/* Drawn in the document beside the button: the rail scrolls, which would clip a menu that opens to its right. */}
      <MenuButton label={t('sidebar.rail.add')} look="dashed" portal placement="right-start" triggerClassName="rail-add" data-tour="add-repo" trigger={<Plus size={15} />}>
        <AddRepoItems />
      </MenuButton>
      <div className="rail-tools">
        <IconButton label={t('sidebar.rail.palette', { key: `${mod}K` })} onClick={() => openOverlay('palette')}>
          <Search size={15} />
        </IconButton>
        <IconButton label={t('sidebar.rail.shortcuts', { key: shortcutHint('shortcuts.help', platform) ?? `${mod}⌥/` })} onClick={() => openOverlay('shortcuts')}>
          <Keyboard size={15} />
        </IconButton>
        <IconButton label={t('tour.label')} data-tour="help" onClick={startTour}>
          <CircleHelp size={15} />
        </IconButton>
        <IconButton label={t('sidebar.rail.settings', { key: `${mod},` })} pressed={settingsOpen} data-tour="settings" onClick={() => openSettingsPage(settingsOpen ? null : { section: 'general' })}>
          <Settings size={15} />
        </IconButton>
      </div>
      {menu && <RepoMenu {...menu} dismiss={() => setMenu(null)} onRemove={() => setRemoving(menu.repo)} />}
      {removing && <RemoveRepoDialog repo={removing} onClose={() => setRemoving(null)} />}
    </nav>
  )
}

const EMPTY: Record<Exclude<SidebarFilter, 'all'>, PlainKey> = {
  'needs-you': 'sidebar.empty.needsYou',
  working: 'sidebar.empty.running',
  pinned: 'sidebar.empty.pinned',
  'in-review': 'sidebar.empty.inReview',
  ready: 'sidebar.empty.ready',
  done: 'sidebar.empty.done',
  later: 'sidebar.empty.later'
}

export function Sidebar({ resize, side = 'left' }: { resize?: PanelSize; side?: PaneSide }) {
  const t = useT()
  const input = useTriageInput()
  const { snapshot, unread } = input
  const view = useStore((s) => s.sidebarView)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const mod = modKey(snapshot.platform)
  const repoId = liveRepo(snapshot, view.repo)
  const repo = snapshot.repos.find((r) => r.id === repoId)

  // Counts ignore the filter and search: they say what's out there.
  const scoped = triageAll(input, repoId)
  const needYou = scoped.filter((t) => t.bucket === 'attention').length
  const running = scoped.filter((t) => t.bucket === 'working').length
  const attention = new Map<string | null, number>([[null, 0]])
  for (const t of triageAll(input, null)) {
    if (t.bucket !== 'attention') continue
    attention.set(null, attention.get(null)! + 1)
    attention.set(t.ws.repoId, (attention.get(t.ws.repoId) ?? 0) + 1)
  }
  const grouped = sidebarGroups(input, view)
  const { compares, hiddenFinished } = grouped
  // The tabs Settings → Appearance → Sidebar & Home turns on, and the one shown (a tab turned off falls back).
  const tabs = viewsOn(snapshot.settings.views, 'tab')
  const filter = resolveFilter(view.filter, snapshot.settings.views)
  // Saved for later: reachable from a line under the list when Later isn't a tab.
  useLaterWake()
  const laterCount = scoped.filter((x) => waitingLater(x.ws, Date.now())).length
  // In Later, a row put away says when it comes back.
  const groups =
    filter === 'later'
      ? grouped.groups.map((g) => ({ ...g, items: g.items.map((x) => (putAway(x, Date.now()) ? { ...x, label: laterWhen(x.ws, t), tone: undefined } : x)) }))
      : grouped.groups
  const order = sidebarOrder(input, view).map((w) => w.id)
  const archived = snapshot.workspaces.filter((w) => w.state === 'archived').length
  const anyUnread = Object.keys(unread).length > 0
  const newRepoId = repoId ?? snapshot.workspaces.find((w) => w.id === selectedId)?.repoId ?? snapshot.repos[0]?.id
  const repoById = new Map(snapshot.repos.map((r) => [r.id, r]))

  return (
    <aside className="sidebar" aria-label={t('sidebar.label')}>
      {resize && <ResizeHandle panel={resize} edge={side === 'right' ? 'left' : 'right'} label={t('sidebar.resize')} />}
      <div className="titlebar drag sidebar-titlebar">
        <PhonePill />
        <IconButton label={t('sidebar.hide', { key: `${mod}B` })} onClick={toggleLeftPanel}>
          {side === 'right' ? <PanelRightClose size={15} /> : <PanelLeftClose size={15} />}
        </IconButton>
      </div>
      <div className="sidebar-body">
        <RepoRail attention={attention} />
        <div className="sidebar-panel">
          <header className="sidebar-head">
            <div className="sidebar-head-text">
              <div className="sidebar-title" role="heading" aria-level={2}>
                {repo?.name ?? t('home.board.allRepos')}
              </div>
              <div className="sidebar-subtitle">
                {repo
                  ? t('sidebar.subtitle.workspaces', { count: scoped.length, branch: repo.defaultBranch })
                  : t('sidebar.subtitle.repos', { count: snapshot.repos.length })}
              </div>
            </div>
            {repo && (
              <IconButton label={t('sidebar.repoSettings')} onClick={() => openSettingsPage({ section: 'repo', repoId: repo.id })}>
                <Settings size={14} />
              </IconButton>
            )}
          </header>
          <AutomationsEntry />
          <AssistantEntry />
          <Button variant="primary" className="sidebar-new" data-tour="new-workspace" aria-keyshortcuts={`${snapshot.platform === 'darwin' ? 'Meta' : 'Control'}+N`} disabled={!newRepoId} icon={<Plus size={14} />} onClick={() => newRepoId && openNewWorkspace(newRepoId)}>
            {t('palette.newWorkspace')}
            <Kbd className="sidebar-new-hint" aria-hidden>
              {mod}N
            </Kbd>
          </Button>
          <div className="sidebar-search">
            <Search size={14} aria-hidden />
            <TextInput
              type="search"
              className="sidebar-search-input"
              aria-label={t('sidebar.search.placeholder')}
              placeholder={t('sidebar.search.placeholder')}
              value={view.query}
              spellCheck={false}
              onChange={(e) => setSidebarQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setSidebarQuery('')}
            />
            {view.query && (
              <IconButton label={t('sidebar.search.clear')} onClick={() => setSidebarQuery('')}>
                <X size={12} />
              </IconButton>
            )}
          </div>
          <div className="sidebar-summary">
            <span className={running ? 'running' : ''}>{t('sidebar.runningCount', { count: running })}</span>
            {needYou > 0 && (
              <ChipButton pill tone="warn" pressed={filter === 'needs-you'} onClick={() => setSidebarFilter(filter === 'needs-you' ? tabs[0] : 'needs-you')}>
                {t('sidebar.needsYouCount', { count: needYou })}
              </ChipButton>
            )}
          </div>
          <Tabs className="sidebar-filters" data-tour="needs-you" variant="pill" value={filter} onChange={(id) => setSidebarFilter(id as SidebarFilter)}>
            <TabList label={t('sidebar.filter.label')}>
              {tabs.map((id) => (
                <Tab key={id} value={id}>
                  {t(VIEW_LABEL[id])}
                </Tab>
              ))}
            </TabList>
          </Tabs>
          {anyUnread && (
            <div className="sidebar-actions">
              <LinkButton size="sm" onClick={markAllRead}>
                {t('sidebar.markAllRead')}
              </LinkButton>
            </div>
          )}
          <div className="sidebar-scroll">
            {groups.map((group) => (
              <Fragment key={group.bucket}>
                <section className={`ws-group ${group.bucket}`} aria-labelledby={`ws-group-${group.bucket}`}>
                  <div className="ws-group-head">
                    <span id={`ws-group-${group.bucket}`} role="heading" aria-level={3}>
                      {t(BUCKET_LABEL[group.bucket])}
                    </span>
                    <span className="ws-group-count">{group.items.length}</span>
                  </div>
                  {group.items.map((t) => (
                    <WorkspaceRow key={t.ws.id} t={t} index={order.indexOf(t.ws.id)} repo={repoId ? undefined : repoById.get(t.ws.repoId)} />
                  ))}
                </section>
                {group.bucket === 'attention' && compares.map((c) => <CompareGroupView key={c.id} section={c} order={order} repoId={repoId} repoById={repoById} />)}
              </Fragment>
            ))}
            {!groups.some((g) => g.bucket === 'attention') && compares.map((c) => <CompareGroupView key={c.id} section={c} order={order} repoId={repoId} repoById={repoById} />)}
            {groups.length === 0 && compares.length === 0 && (
              <div className="sidebar-empty">
                {view.query
                  ? t('sidebar.empty.noMatch')
                  : filter !== 'all'
                    ? t(EMPTY[filter])
                    : snapshot.repos.length
                      ? t('sidebar.empty.noWorkspaces')
                      : t('sidebar.empty.noRepos')}
              </div>
            )}
            {laterCount > 0 && filter !== 'later' && !tabs.includes('later') && (
              <LinkButton size="sm" className="sidebar-more" onClick={() => setSidebarFilter('later')}>
                {t('later.link', { count: laterCount })}
              </LinkButton>
            )}
            {hiddenFinished > 0 && (
              <LinkButton size="sm" className="sidebar-more" onClick={toggleShowFinished}>
                {t('sidebar.showFinished', { count: hiddenFinished })}
              </LinkButton>
            )}
            {view.showFinished && filter === 'all' && !view.query && scoped.some((t) => t.bucket === 'finished') && (
              <LinkButton size="sm" className="sidebar-more" onClick={toggleShowFinished}>
                {t('sidebar.hideFinished')}
              </LinkButton>
            )}
          </div>
          <UpdateNotice />
          <SttChip />
          <KeepAwakeChip />
          <footer className="sidebar-footer">
            <ResourceUsage />
            <Button variant="ghost" size="sm" icon={<Archive size={13} />} onClick={() => openOverlay('archived')} title={t('sidebar.archived.title')}>
              {archived ? t('sidebar.archivedCount', { count: archived }) : t('sidebar.archived')}
            </Button>
            <Button variant="ghost" size="sm" icon={<FileDown size={13} />} disabled={snapshot.repos.length === 0} onClick={openImportDialog} title={t('sidebar.import.title')}>
              {t('sidebar.import')}
            </Button>
            {/* The running version, always in sight; Settings → General has it in full with Check now. */}
            {snapshot.appVersion && (
              <Button variant="ghost" size="sm" className="sidebar-version" onClick={() => openSettingsPage({ section: 'general', scrollTo: 'check-for-updates' })} title={t('sidebar.version.title', { version: snapshot.appVersion })}>
                {t('sidebar.version', { version: snapshot.appVersion })}
              </Button>
            )}
          </footer>
        </div>
      </div>
    </aside>
  )
}
