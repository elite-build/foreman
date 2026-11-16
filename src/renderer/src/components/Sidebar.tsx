import {
  Archive,
  Brain,
  Bug,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleCheck,
  CircleHelp,
  Cloud,
  FileDown,
  FolderGit2,
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
  Users,
  X,
  icons,
  type LucideIcon
} from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
import type { PlainKey } from '../../../shared/i18n'
import type { ArchiveProgressStep, PaneSide, Repo, RepoIcon, Workspace, WorkspaceStatus } from '../../../shared/types'
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
  clientKind,
  openEmployees,
  openMemory,
  openNewWorkspace,
  openOverlay,
  openReportProblem,
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
  toggleRailNames,
  toggleShowFinished,
  toggleSidebarGroup,
  useStore
} from '../store'
import { resolveFilter, VIEW_LABEL, viewsOn } from '../../../shared/views'
import { LATER_CHOICES, putAway, waitingLater } from '../../../shared/later'
import { bringBackNow, laterChoiceLabel, laterWhen, saveForLater, takeOutOfLater, useLaterWake } from '../later'
import { BUCKET_LABEL, foldedBuckets, liveRepo, sidebarGroups, sidebarOrder, STATUS_LABEL, type Bucket, type SidebarFilter, type Triage } from '../triage'
import { promptTitle } from '../../../shared/compare'
import type { CompareSection } from '../../../shared/triage'
import { employeeKey, itemsInSpace, type NeedsYouCounts, type NeedsYouItem } from '../../../shared/needsYou'
import { needsYouOf, useTriageInput } from '../needsYou'
import { employeeOf, openEmployeeItem, rowWords } from './needsYouWords'
import { actionNoun } from './employees/words'
import { AddRepoItems } from './AddRepository'
import { SpaceRailTile, SpaceSwitcher } from './spaces/SpaceSwitcher'
import { TeamSection } from './employees/TeamSection'
import { ProjectsSection } from './employees/ProjectsSection'
import { currentSpace, holdsWorkspaces, memoryOwner, newWorkspaceTarget, snapshotInSpace, spacesOn, workspaceRepos } from '../../../shared/organizations'
import { RemoveRepoDialog } from './settings/RepoMiscTab'
import { ResizeHandle, type PanelSize } from './resize'
import { AutomationsEntry } from './automations/AutomationsEntry'
import { AssistantEntry } from './assistant/AssistantEntry'
import { DeviceChip } from './computers/DeviceChip'
import { ControlledChip } from './computers/ControlledChip'
import { KeepAwakeChip } from './KeepAwakeChip'
import { ResourceUsage } from './ResourceUsage'
import { SttChip } from './SttChip'
import { UpdateNotice } from './UpdateNotice'
import { TerminalAgentLabel, useHasTerminalAgent } from './agents/TerminalAgents'
import { leadGlyph } from '../../../shared/attention'
import { PrGlyphView } from './Attention'
import { GitlabMark } from './GitlabMark'
import { cloudAction, CloudSub } from './cloud/CloudBits'
import { isGitlabWorkspace } from '../../../shared/scm'
import { ActionRow, Button, CardButton, ContextMenu, Glyph, HardHat, IconButton, LinkButton, MenuButton, MenuGroup, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator, Spinner, Status, Tab, TabList, Tabs, TextInput, type HardHatColour, type StatusTone } from '../ui'

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
  // A stopped archive opens its dialog on the step that failed, where Retry and Keep workspace are.
  if (t.action?.kind === 'resolve-archive') {
    recordMilestone('needsYou')
    return openArchiveDialog(t.ws.id)
  }
  selectWorkspace(t.ws.id)
  // Back from Later: opening it is what bringing it back was for, so it leaves Later.
  if (t.laterBack) void attempt(() => api.updateWorkspace(t.ws.id, { later: null }))
  if (t.bucket === 'attention') recordMilestone('needsYou')
  if (t.bucket === 'attention' && t.sessionId) selectSession(t.ws.id, t.sessionId)
}

// Everything triage needs, read from the store (it lives beside the shared needs-you count now).
export { useTriageInput }

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
      {!ws.cloud && clientKind === 'window' && <MenuItem onSelect={() => openExportDialog(ws.id)}>{t('sidebar.menu.export')}</MenuItem>}
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
  // An organization's memory repository never has workspaces (docs/ai-employees.md §4).
  const workspaces = useStore((s) => holdsWorkspaces(repo.id, s.snapshot!.organizations))
  return (
    <ContextMenu x={x} y={y} label={repo.name} onClose={dismiss}>
      {workspaces && <MenuItem onSelect={() => openNewWorkspace(repo.id)}>{t('sidebar.menu.newWorkspace')}</MenuItem>}
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

// The step an archive in the background is on, after "Archiving…" in its row.
const ARCHIVE_STEP: Record<ArchiveProgressStep, PlainKey> = {
  stop: 'sidebar.row.archiveStep.stop',
  checkpoint: 'stop.archive.step.checkpoint',
  diff: 'stop.archive.step.diff',
  script: 'stop.archive.step.script',
  docker: 'docker.archive.stepUnknown',
  remove: 'stop.archive.step.remove',
  sandbox: 'cloud.archive.step.sandbox'
}

function WorkspaceRow({ t, index, repo }: { t: Triage; index: number; repo?: Repo }) {
  const { ws } = t
  const tr = useT()
  // While the Assistant covers the workspace, its entry is the one thing selected; the workspace stays chosen for when it closes.
  const selected = useStore((s) => s.selectedWorkspaceId === ws.id && !(s.assistantOpen && s.snapshot!.settings.assistantEnabled))
  const platform = useStore((s) => s.snapshot!.platform)
  const coloredDiffs = useStore((s) => s.snapshot!.settings.coloredSidebarDiffs)
  // An archive running in the background (or stopped on a step that needs you) says so in place of the row's label.
  // A stopped archive is also kept on the workspace (archiveStopped), so it still says so after a restart.
  const run = useStore((s) => s.archiveRuns[ws.id])
  const archive = run ?? (ws.archiveStopped ? { stopped: true, step: null } : undefined)
  const archiving = Boolean(archive && !archive.stopped)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(ws.name)
  // A chat in the workspace that needs you keeps its label.
  const terminalAgent = useHasTerminalAgent(ws.id) && t.bucket !== 'attention'
  // G2: GitLab's mark on rows of GitLab repositories.
  const gitlab = useStore((s) => isGitlabWorkspace(ws, s.snapshot!.repos.find((r) => r.id === ws.repoId), s.snapshot!.settings.gitlabHosts ?? []))
  // The employee whose run this is, for its hat and name.
  const snapshot = useStore((s) => s.snapshot!)
  const employee = ws.startedBy?.via === 'employee' ? employeeOf(snapshot, ws.startedBy) : undefined

  const saveName = () => {
    setRenaming(false)
    if (name.trim() && name.trim() !== ws.name) void attempt(() => api.updateWorkspace(ws.id, { name }))
  }
  // Repo (when listing them all), branch and age; the label says what's going on.
  const meta = [repo?.name, ws.branch, timeAgo(t.since)].filter(Boolean).join(' · ')
  const icon = (
    <span className="ws-icon" title={archive ? undefined : ws.direct ? tr('sidebar.row.direct') : ws.adopted ? tr('sidebar.row.adopted') : ws.pinned ? tr('sidebar.row.pinned') : ws.cloud ? tr('cloud.glyph') : undefined}>
      {archive?.stopped ? (
        <Status compact aria-hidden tone="warn" label={tr('sidebar.row.archiveStopped')} />
      ) : archive ? (
        <span className="ws-spin blue">
          <Spinner size={13} />
        </span>
      ) : (
        <RowIcon t={t} />
      )}
    </span>
  )

  return (
    <>
      <ActionRow
        className={`ws-row ${selected ? 'selected' : ''} ${t.bucket} ${archiving ? 'archiving' : ''}`}
        selected={selected}
        // A stopped archive opens its dialog, where Retry is.
        onPress={() => (archive?.stopped ? openArchiveDialog(ws.id) : openTriaged(t))}
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
            {ws.diffStat && !archiving && <DiffBadge additions={ws.diffStat.additions} deletions={ws.diffStat.deletions} muted={!coloredDiffs && !selected} />}
            {index >= 0 && index < 9 && (
              <span className="ws-shortcut">
                {modKey(platform)}
                {index + 1}
              </span>
            )}
            {!archiving && (
              <IconButton className="ws-archive" label={tr('sidebar.row.archive')} onClick={() => openArchiveDialog(ws.id)}>
                <Archive size={13} />
              </IconButton>
            )}
          </span>
        }
      >
        {icon}
        <span className="ws-title">{ws.compare ? `${ws.name} · ${ws.compare.label}` : ws.name}</span>
        {/* #22: a Terminal agent's process and output activity replace the label while it runs; it never claims "needs you". */}
        {archive ? (
          <span className={`ws-label ${archive.stopped ? 'amber' : 'blue'}`}>
            {tr(archive.stopped ? 'sidebar.row.archiveStopped' : 'sidebar.row.archiving')}
            {archive.stopped ? (
              <span className="ws-detail"> · {tr('sidebar.row.archiveStoppedDetail')}</span>
            ) : (
              archive.step && <span className="ws-detail"> · {tr(ARCHIVE_STEP[archive.step])}</span>
            )}
          </span>
        ) : terminalAgent ? (
          <TerminalAgentLabel workspaceId={ws.id} />
        ) : employee && ws.startedBy?.via === 'employee' ? (
          // docs/ai-employees.md §10: a run says whose it is, by hat and name ("Ada asks · Which day does 2.4 launch?").
          // The leading glyph still says the state; the hat is identity only.
          <span className={`ws-label ${t.tone ?? ''}`}>
            <span className="ws-hat">
              <HardHat colour={employee.colour as HardHatColour} size={14} />
            </span>
            {t.namesEmployee ? t.label : t.label ? tr('sidebar.row.byEmployee', { name: employee.name, label: t.label }) : tr('sidebar.row.employeeRun', { name: employee.name, title: ws.startedBy.title })}
            {t.label && t.detail && <span className="ws-detail"> · {t.detail}</span>}
          </span>
        ) : (
          t.label && (
            <span className={`ws-label ${t.tone ?? ''}`}>
              {t.label}
              {t.detail && <span className="ws-detail"> · {t.detail}</span>}
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

/**
 * An employee's decision with no workspace of its own in the list (docs/ai-employees.md §10): a held push or other
 * outward action (it leaves the computer), a memory proposal, a question whose run's workspace is gone, a pause. A row
 * like a workspace's in Needs your attention: ▲ (◆ when sending failed), what it is, the kind in words, and the
 * employee's hat and name with the repository and how long it has waited. It opens the Team page, where it is decided.
 */
function NeedsYouRow({ item }: { item: NeedsYouItem }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const employee = employeeOf(snapshot, item)
  const { title, label } = rowWords(item, snapshot, t, (p) => actionNoun(p, t))
  const failed = item.action?.state === 'failed'
  const repo = item.repoId ? snapshot.repos.find((r) => r.id === item.repoId)?.name : undefined
  const meta = [employee?.name, repo, item.since ? timeAgo(item.since) : ''].filter(Boolean).join(' · ')
  return (
    <ActionRow className="ws-row attention needs-row" onPress={() => openEmployeeItem(item)} primaryProps={{ className: 'ws-flow' }}>
      <span className="ws-icon">
        <Status compact aria-hidden tone={failed ? 'error' : 'warn'} label={label} />
      </span>
      <span className="ws-title">{title}</span>
      <span className={`ws-label ${failed ? 'red' : 'amber'}`}>{label}</span>
      <span className="ws-sub">
        {employee && (
          <span className="ws-hat">
            <HardHat colour={employee.colour as HardHatColour} size={14} />
          </span>
        )}
        {meta}
      </span>
    </ActionRow>
  )
}

/**
 * One comparison: its workspaces together under the prompt they were all given. Rows say which model each one is. A
 * flow run's workspaces are grouped the same way, under the flow's name.
 */
function CompareGroupView({ section, order, repoId, repoById }: { section: CompareSection; order: string[]; repoId: string | null; repoById: Map<string, Repo> }) {
  const t = useT()
  return (
    <section className="ws-group compare" title={section.flow === undefined ? section.prompt : undefined}>
      <div className="ws-group-head">
        <span>{section.flow !== undefined ? t('sidebar.flowRun', { name: section.flow }) : t('sidebar.compare', { prompt: promptTitle(section.prompt) })}</span>
        <span className="ws-group-count">{section.items.length}</span>
      </div>
      {section.items.map((t) => (
        <WorkspaceRow key={t.ws.id} t={t} index={order.indexOf(t.ws.id)} repo={repoId ? undefined : repoById.get(t.ws.repoId)} />
      ))}
    </section>
  )
}

// A group's icon on its heading card: what needs you by its shape, what runs spinning, the rest as workspaces.
function GroupIcon({ bucket }: { bucket: Bucket }) {
  if (bucket === 'attention') return <Glyph name="warn" />
  if (bucket === 'working')
    return (
      <span className="ws-spin blue">
        <Spinner size={13} />
      </span>
    )
  if (bucket === 'finished') return <CircleCheck size={14} aria-hidden />
  return <FolderGit2 size={14} aria-hidden />
}

/**
 * A group's heading: a card like the Team and Channels rows, with its icon, name, count and a chevron that folds the
 * group's rows away, remembered. Folded, Needs your attention says its count with ▲, so a folded group that waits on you
 * still says so. `foldable` is off while a filter or a search narrows the list: it shows every row it found then.
 */
function GroupHead({ bucket, count, folded, foldable, labelId, listId }: { bucket: Bucket; count: number; folded: boolean; foldable: boolean; labelId: string; listId: string }) {
  const t = useT()
  const name = t(BUCKET_LABEL[bucket])
  const toggle = () => toggleSidebarGroup(bucket)
  return (
    // Named by the group alone: the card's buttons are inside it, and the chevron's label would repeat the name.
    <div role="heading" aria-level={3} aria-labelledby={labelId}>
      <ActionRow
        card
        className="ws-group-entry"
        onPress={foldable ? toggle : undefined}
        primaryProps={foldable ? { 'aria-expanded': !folded, 'aria-controls': listId } : undefined}
        actions={
          foldable && (
            <IconButton label={t('triage.bucket.fold', { group: name })} aria-expanded={!folded} aria-controls={listId} onClick={toggle}>
              {folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </IconButton>
          )
        }
      >
        <GroupIcon bucket={bucket} />
        <span id={labelId} className="ws-group-label">
          {name}
        </span>
        {bucket === 'attention' && folded ? (
          <Status className="ws-group-need" compact tone="warn" label={t('home.banner.needYou', { count })}>
            <span aria-hidden>{count}</span>
          </Status>
        ) : (
          <span className="ws-group-count">{count}</span>
        )}
      </ActionRow>
    </div>
  )
}

/** Two letters for a repository without an icon: "kite" → "ki". */
function repoInitials(name: string): string {
  return (name.replace(/[^a-z0-9]/gi, '').slice(0, 2) || '?').toLowerCase()
}

/** What is going on in one repository (or, under `null`, in all of them): the rail's badges and lines. */
type RepoCount = { attention: number; working: number; total: number }

/** A repository's icon, or its initials when it has none: the rail's tiles. */
function repoMark(repo: Repo): ReactNode {
  return repo.icon ? <RepoIconView icon={repo.icon} size={16} /> : <span className="rail-text">{repoInitials(repo.name)}</span>
}

/**
 * The sidebar's Team row as a rail tile, while a narrow window folds the list to its rail: the organization's employees,
 * with "▲ 2" for what of theirs waits for the person (the same count as the Team row, TeamSection), opening the Team page.
 * Only where the Team row would show: an organization with a memory repository is the space shown.
 */
function TeamRailTile({ needs }: { needs: NeedsYouCounts }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const wanted = useStore((s) => s.space)
  const route = useStore((s) => s.employeesView)
  const organizations = snapshot.organizations ?? []
  if (!spacesOn(organizations)) return null
  const org = organizations.find((o) => o.id === currentSpace(organizations, wanted))
  if (!org?.memoryRepoId) return null
  const employees = (snapshot.employees?.[org.id]?.employees ?? []).filter((e) => e.state !== 'retired')
  const count = employees.reduce((sum, e) => sum + (needs.byEmployee.get(employeeKey(org.id, e.id)) ?? 0), 0)
  const label = t('employees.team.heading')
  const name = count ? t('sidebar.rail.needYou', { label, count }) : label
  const on = route?.orgId === org.id && route.page === 'team'
  return (
    <span className={`rail-item ${on ? 'on' : ''}`}>
      <span className="rail-tile-wrap">
        <CardButton className="rail-tile" selected={on} title={name} aria-label={name} aria-pressed={on} onClick={() => openEmployees({ orgId: org.id, page: 'team' })}>
          <Users size={16} aria-hidden />
          {count > 0 && (
            <span className="rail-badge" aria-hidden>
              <Glyph name="warn" />
              {count > 9 ? '9+' : count}
            </span>
          )}
        </CardButton>
      </span>
    </span>
  )
}

/**
 * The column of repositories down the left edge: All, each repo, and Add; search, shortcuts and settings at the bottom.
 * Its toggle widens it in place to put each repository's name and what is going on in it beside the tile (the store's
 * `railNames`), and narrows it back.
 */
function RepoRail({ counts, repos, folded }: { counts: Map<string | null, RepoCount>; repos: Repo[]; folded?: NeedsYouCounts }) {
  const t = useT()
  // The space's organizations, for the memory repository's mark in its tooltip.
  const organizations = useStore((s) => s.snapshot!.organizations)
  const connections = useStore((s) => s.snapshot!.integrations.connections)
  const mod = useStore((s) => modKey(s.snapshot!.platform))
  const platform = useStore((s) => s.snapshot!.platform)
  const settingsOpen = useStore((s) => Boolean(s.settingsPage))
  const picked = useStore((s) => s.sidebarView.repo)
  // A repository picked in another space isn't on this rail: All is.
  const current = picked && repos.some((r) => r.id === picked) ? picked : null
  // Home is showing only while no workspace is open and no page covers it (App.tsx's `covered`): Settings, Automations,
  // the Assistant, an organization's Memory view or its Team, employee and New employee pages.
  const home = useStore(
    (s) =>
      !s.selectedWorkspaceId &&
      !s.settingsPage &&
      !s.automations &&
      !(s.assistantOpen && s.snapshot!.settings.assistantEnabled) &&
      !(s.memoryView && s.snapshot!.organizations?.some((o) => o.id === s.memoryView)) &&
      !(s.employeesView && s.snapshot!.organizations?.some((o) => o.id === s.employeesView!.orgId))
  )
  const names = useStore((s) => s.railNames)
  // The Memory view of the organization shown, open: its memory tile is the one pressed.
  const memoryView = useStore((s) => s.memoryView)
  const [menu, setMenu] = useState<{ repo: Repo; x: number; y: number } | null>(null)
  const [removing, setRemoving] = useState<Repo | null>(null)
  // Beside a name: what needs you and what runs, or (when nothing does) how many workspaces it has.
  const line = (repoId: string | null, quiet: string) => {
    const c = counts.get(repoId)
    const busy = [c?.attention ? t('home.banner.needYou', { count: c.attention }) : '', c?.working ? t('sidebar.runningCount', { count: c.working }) : ''].filter(Boolean)
    return busy.length ? busy.join(' · ') : quiet
  }
  // `memory`: an organization's memory repository, whose tile is the way into its Memory view, not a repository to pick.
  const tile = (repoId: string | null, label: string, title: string, quiet: string, content: ReactNode, memory?: string) => {
    const count = counts.get(repoId)?.attention ?? 0
    const name = count ? t('sidebar.rail.needYou', { label, count }) : label
    const lineId = `rail-line-${repoId ?? 'all'}`
    const on = memory ? memoryView === memory : current === repoId
    return (
      <span key={repoId ?? 'all'} className={`rail-item ${on ? 'on' : ''}`}>
        {/* The wrapper draws the ring that says the tile's repository is also what Home is showing. */}
        <span className={`rail-tile-wrap ${!memory && current === repoId && home ? 'on-home' : ''}`}>
          <CardButton
            className="rail-tile"
            selected={on}
            title={names ? undefined : name}
            aria-label={name}
            aria-describedby={names ? lineId : undefined}
            aria-pressed={on}
            onClick={() => (memory ? openMemory(memory) : showRepoHome(repoId))}
            onContextMenu={(e) => {
              const repo = repos.find((r) => r.id === repoId)
              if (!repo) return
              e.preventDefault()
              setMenu({ repo, x: e.clientX, y: e.clientY })
            }}
          >
            {content}
            {/* With names shown, the line beside the tile says it in words. */}
            {count > 0 && !names && (
              <span className="rail-badge" aria-hidden>
                <Glyph name="warn" />
                {count > 9 ? '9+' : count}
              </span>
            )}
          </CardButton>
        </span>
        {/* The tile's name already says the title, and describes it with the line; the button reaches over both, so
            clicking the name picks the repository too. */}
        {names && (
          <span className="rail-name" aria-hidden>
            <span className="rail-name-title">{title}</span>
            <span className="rail-name-line" id={lineId}>
              {line(repoId, quiet)}
            </span>
          </span>
        )}
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
  const tileLabel = (repo: Repo) => [repo.name, githubNames.get(repo.id)].filter(Boolean).join(' · ')
  // Code repositories only: an organization's memory repository is its Memory tile (docs/ai-employees.md §10).
  const codeRepos = workspaceRepos(repos, organizations)
  return (
    <nav className={`repo-rail ${names ? 'names' : ''}`} aria-label={t('sidebar.rail.label')}>
      {/* The list folded to the rail (a narrow window): its heading, the space switcher, and its Team row come with it. */}
      {folded && (
        <>
          <span className="rail-item">
            <SpaceRailTile />
          </span>
          <TeamRailTile needs={folded} />
          <span className="rail-divider" aria-hidden />
        </>
      )}
      {tile(null, t('home.board.allRepos'), t('home.board.allRepos'), t('sidebar.subtitle.repos', { count: codeRepos.length }), <span className="rail-text">{t('sidebar.rail.all')}</span>)}
      {repos.map((repo) => {
        const owner = memoryOwner(repo.id, organizations ?? [])
        if (owner) {
          const label = t('sidebar.rail.memory', { organization: owner.name })
          return tile(repo.id, label, label, repo.name, <Brain size={16} aria-hidden />, owner.id)
        }
        return tile(repo.id, tileLabel(repo), repo.name, t('sidebar.subtitle.workspaces', { count: counts.get(repo.id)?.total ?? 0, branch: repo.defaultBranch }), repoMark(repo))
      })}
      <span className="rail-item">
        {/* Drawn in the document beside the button: the rail scrolls, which would clip a menu that opens to its right. */}
        <MenuButton label={t('sidebar.rail.add')} look="dashed" portal placement="right-start" triggerClassName="rail-add" data-tour="add-repo" trigger={<Plus size={15} />}>
          <AddRepoItems />
        </MenuButton>
        {names && (
          <span className="rail-name" aria-hidden>
            <span className="rail-name-title">{t('sidebar.rail.add')}</span>
          </span>
        )}
      </span>
      <div className="rail-tools">
        {/* One toggle, in place: pressed, the rail is wide with names; pressed again, it is back to its tiles. */}
        <IconButton label={t('sidebar.rail.names', { key: shortcutHint('panel.railNames', platform) ?? `${mod}⇧N` })} pressed={names} onClick={toggleRailNames}>
          {names ? <ChevronsLeft size={15} /> : <ChevronsRight size={15} />}
        </IconButton>
        <IconButton label={t('sidebar.rail.palette', { key: `${mod}K` })} onClick={() => openOverlay('palette')}>
          <Search size={15} />
        </IconButton>
        <IconButton label={t('sidebar.rail.shortcuts', { key: shortcutHint('shortcuts.help', platform) ?? `${mod}⌥/` })} onClick={() => openOverlay('shortcuts')}>
          <Keyboard size={15} />
        </IconButton>
        <IconButton label={t('sidebar.rail.report', { key: shortcutHint('report.problem', platform) ?? `${mod}⌥R` })} onClick={() => openReportProblem(true)}>
          <Bug size={15} />
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

/**
 * The sidebar: the repository rail and the workspace list. The Editor layout puts its activity bar (`views`) at the top of
 * the rail and hides the list (`list` false) while the rail has picked another view or the sidebar is hidden. `folded`: a
 * narrow window folded the list to the rail (narrowLayout.ts), so the rail carries the space switcher and Team too.
 */
export function Sidebar({ resize, side = 'left', views, list = true, folded }: { resize?: PanelSize; side?: PaneSide; views?: ReactNode; list?: boolean; folded?: boolean }) {
  const t = useT()
  const everything = useTriageInput()
  // The space the sidebar shows (docs/ai-employees.md §3): its repositories and their workspaces only. While spaces
  // don't apply this is the whole snapshot, as it always was.
  const space = useStore((s) => s.space)
  const input = { ...everything, snapshot: snapshotInSpace(everything.snapshot, space) }
  const { snapshot, unread } = input
  const view = useStore((s) => s.sidebarView)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const mod = modKey(snapshot.platform)
  const repoId = liveRepo(snapshot, view.repo)
  const repo = snapshot.repos.find((r) => r.id === repoId)

  // Counts ignore the filter and search: they say what's out there. What needs you is the shared count
  // (src/shared/needsYou.ts) for every space at once, so the heading, the rail, the tab and the group agree with Home.
  const need = needsYouOf(everything)
  const shownSpace = currentSpace(everything.snapshot.organizations, space)
  const inSpace = new Set(snapshot.workspaces.map((w) => w.id))
  const spaceTriage = need.triaged.filter((x) => inSpace.has(x.ws.id))
  const scoped = repoId ? spaceTriage.filter((x) => x.ws.repoId === repoId) : spaceTriage
  const spaceNeeds = itemsInSpace(need.items, shownSpace)
  const scopedNeeds = repoId ? spaceNeeds.filter((i) => i.repoId === repoId) : spaceNeeds
  const running = scoped.filter((t) => t.bucket === 'working').length
  const counts = new Map<string | null, RepoCount>()
  const tally = (key: string | null, t: Triage) => {
    const c = counts.get(key) ?? { attention: 0, working: 0, total: 0 }
    c.total++
    if (t.bucket === 'working') c.working++
    counts.set(key, c)
  }
  for (const t of spaceTriage) {
    tally(null, t)
    tally(t.ws.repoId, t)
  }
  // ▲ on the rail: the space's count on All, each repository's on its tile (a proposal on the memory repository's).
  counts.set(null, { ...(counts.get(null) ?? { working: 0, total: 0 }), attention: spaceNeeds.length })
  for (const r of snapshot.repos) counts.set(r.id, { ...(counts.get(r.id) ?? { working: 0, total: 0 }), attention: need.counts.byRepo.get(r.id) ?? 0 })
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
  // The groups folded under their heading cards; a filter or a search shows every group open.
  const foldedGroups = foldedBuckets(view, snapshot.settings)
  const foldable = filter === 'all' && !view.query.trim()
  // Archived work and Import stay about everything, whichever space is shown.
  const archived = everything.snapshot.workspaces.filter((w) => w.state === 'archived').length
  const anyUnread = Object.keys(unread).length > 0
  // The same repository ⌘N opens on (App.tsx): never an organization's memory repository.
  const newRepoId = newWorkspaceTarget(everything.snapshot, { space, picked: view.repo, selectedWorkspaceId: selectedId })
  const repoById = new Map(snapshot.repos.map((r) => [r.id, r]))
  // An employee's decisions with no workspace row of their own (a held push, a memory proposal…) are rows in Needs your
  // attention too: they leave the computer, or change what every employee reads.
  const query = view.query.trim().toLowerCase()
  const extraRows = filter === 'all' || filter === 'needs-you' ? scopedNeeds.filter((i) => i.kind !== 'workspace' && (!query || rowWords(i, everything.snapshot, t, (p) => actionNoun(p, t)).title.toLowerCase().includes(query))) : []
  const listed = extraRows.length && !groups.some((g) => g.bucket === 'attention') ? [{ bucket: 'attention' as const, items: [] as Triage[] }, ...groups] : groups
  // Oldest first, workspaces and decisions together.
  const attentionRows = (items: Triage[]) =>
    [
      ...items.map((x) => ({ since: x.since, node: <WorkspaceRow key={x.ws.id} t={x} index={order.indexOf(x.ws.id)} repo={repoId ? undefined : repoById.get(x.ws.repoId)} /> })),
      ...extraRows.map((i) => ({ since: i.since, node: <NeedsYouRow key={i.id} item={i} /> }))
    ]
      .sort((a, b) => a.since.localeCompare(b.since))
      .map((r) => r.node)
  // The heading's line: the repository picked and its workspaces, else the space's code repositories (never its memory).
  const headingLine = repo ? `${repo.name} · ${t('sidebar.subtitle.workspaces', { count: scoped.length, branch: repo.defaultBranch })}` : t('sidebar.subtitle.repos', { count: workspaceRepos(snapshot.repos, snapshot.organizations).length })
  // A tab's count, after its name: what needs you (▲) and what runs.
  const tabCount = (id: SidebarFilter): number => (id === 'needs-you' ? scopedNeeds.length : id === 'working' ? running : 0)
  const newKey = shortcutHint('workspace.new', snapshot.platform) ?? `${mod}N`

  return (
    <aside className="sidebar" aria-label={t('sidebar.label')}>
      {resize && list && <ResizeHandle panel={resize} edge={side === 'right' ? 'left' : 'right'} label={t('sidebar.resize')} />}
      <div className="titlebar drag sidebar-titlebar">
        {list && (
          <>
            <DeviceChip />
            <ControlledChip />
            <IconButton label={t('sidebar.hide', { key: `${mod}B` })} onClick={toggleLeftPanel}>
              {side === 'right' ? <PanelRightClose size={15} /> : <PanelLeftClose size={15} />}
            </IconButton>
          </>
        )}
      </div>
      <div className="sidebar-body">
        {views ? (
          <div className="rail-column">
            {views}
            <RepoRail counts={counts} repos={snapshot.repos} />
          </div>
        ) : (
          <RepoRail counts={counts} repos={snapshot.repos} folded={folded && !list ? need.counts : undefined} />
        )}
        {list && (
          <div className="sidebar-panel">
            {/* The space switcher is the heading (docs/ai-employees.md §10): the space, then its repositories (or the one
                picked) and how much in it needs you. */}
            <SpaceSwitcher
              line={headingLine}
              end={
                repo && (
                  <IconButton label={t('sidebar.repoSettings')} onClick={() => openSettingsPage({ section: 'repo', repoId: repo.id })}>
                    <Settings size={14} />
                  </IconButton>
                )
              }
            />
            {/* Two places you open now and then share a row. */}
            <div className="sidebar-pair">
              <AutomationsEntry />
              <AssistantEntry />
            </div>
            {/* An organization's employees (docs/ai-employees.md §10), only while it is the space shown: one row. */}
            <TeamSection />
            {/* Its projects (docs/ai-employees.md §15): the line that starts one, and those going. */}
            <ProjectsSection />
            {/* Find and the one primary action share a row; Ctrl+N is in New's tooltip and shortcut. */}
            <div className="sidebar-find">
              <div className="sidebar-search">
                <Search size={14} aria-hidden />
                <TextInput
                  type="search"
                  className="sidebar-search-input"
                  aria-label={t('sidebar.search.placeholder')}
                  placeholder={t('sidebar.search.short')}
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
              <Button
                variant="primary"
                className="sidebar-new"
                data-tour="new-workspace"
                aria-label={t('palette.newWorkspace')}
                title={t('sidebar.newTitle', { key: newKey })}
                aria-keyshortcuts={`${snapshot.platform === 'darwin' ? 'Meta' : 'Control'}+N`}
                disabled={!newRepoId}
                icon={<Plus size={14} />}
                onClick={() => newRepoId && openNewWorkspace(newRepoId)}
              >
                {t('sidebar.new')}
              </Button>
            </div>
            {/* The filters, each with its count (▲ what needs you, what runs): the one place the sidebar says how many. */}
            <Tabs className="sidebar-filters" data-tour="needs-you" variant="pill" value={filter} onChange={(id) => setSidebarFilter(id as SidebarFilter)}>
              <TabList label={t('sidebar.filter.label')}>
                {tabs.map((id) => {
                  const n = tabCount(id)
                  return (
                    <Tab key={id} value={id} aria-label={n ? t('sidebar.tabCount', { label: t(VIEW_LABEL[id]), count: n }) : undefined}>
                      {t(VIEW_LABEL[id])}
                      {n > 0 && (
                        <span className={`sidebar-tab-count ${id === 'needs-you' ? 'warn' : ''}`} aria-hidden>
                          {id === 'needs-you' && <Glyph name="warn" />}
                          {n}
                        </span>
                      )}
                    </Tab>
                  )
                })}
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
              {listed.map((group) => (
                <Fragment key={group.bucket}>
                  <section className={`ws-group ${group.bucket}`} aria-labelledby={`ws-group-${group.bucket}`}>
                    <GroupHead
                      bucket={group.bucket}
                      count={group.items.length + (group.bucket === 'attention' ? extraRows.length : 0)}
                      folded={foldedGroups.has(group.bucket)}
                      foldable={foldable}
                      labelId={`ws-group-${group.bucket}`}
                      listId={`ws-group-rows-${group.bucket}`}
                    />
                    <div id={`ws-group-rows-${group.bucket}`} className="ws-group-rows" hidden={foldedGroups.has(group.bucket)}>
                      {group.bucket === 'attention'
                        ? attentionRows(group.items)
                        : group.items.map((t) => <WorkspaceRow key={t.ws.id} t={t} index={order.indexOf(t.ws.id)} repo={repoId ? undefined : repoById.get(t.ws.repoId)} />)}
                    </div>
                  </section>
                  {group.bucket === 'attention' && compares.map((c) => <CompareGroupView key={c.id} section={c} order={order} repoId={repoId} repoById={repoById} />)}
                </Fragment>
              ))}
              {!listed.some((g) => g.bucket === 'attention') && compares.map((c) => <CompareGroupView key={c.id} section={c} order={order} repoId={repoId} repoById={repoById} />)}
              {listed.length === 0 && compares.length === 0 && (
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
              {/* A .foreman file is picked on the computer: the window's alone. */}
              {clientKind === 'window' && (
                <Button variant="ghost" size="sm" icon={<FileDown size={13} />} disabled={everything.snapshot.repos.length === 0} onClick={openImportDialog} title={t('sidebar.import.title')}>
                  {t('sidebar.import')}
                </Button>
              )}
              {/* The running version, always in sight; Settings → General has it in full with Check now. */}
              {snapshot.appVersion && (
                <Button variant="ghost" size="sm" className="sidebar-version" onClick={() => openSettingsPage({ section: 'general', scrollTo: 'check-for-updates' })} title={t('sidebar.version.title', { version: snapshot.appVersion })}>
                  {t('sidebar.version', { version: snapshot.appVersion })}
                </Button>
              )}
            </footer>
          </div>
        )}
      </div>
    </aside>
  )
}
