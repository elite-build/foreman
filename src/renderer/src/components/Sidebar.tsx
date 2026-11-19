import {
  Archive,
  Bug,
  CircleHelp,
  Cloud,
  Command,
  Ellipsis,
  FolderGit2,
  FolderInput,
  FolderRoot,
  GitBranch,
  Hash,
  Inbox,
  Keyboard,
  Layers,
  PanelLeftClose,
  PanelRightClose,
  Pin,
  Search,
  Users,
  X,
  icons,
  type LucideIcon
} from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
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
  clientKind,
  openNewWorkspace,
  openOverlay,
  openReportProblem,
  openSettingsPage,
  pickEditorSidebar,
  selectSession,
  recordMilestone,
  selectWorkspace,
  setSidebarFilter,
  setSidebarGroupBy,
  setSidebarMode,
  setSidebarQuery,
  setSpace,
  startTour,
  timeAgo,
  toggleLeftPanel,
  toggleShowFinished,
  toggleSidebarGroup,
  useStore,
  type SidebarMode
} from '../store'
import { LATER_CHOICES, putAway, waitingLater } from '../../../shared/later'
import { bringBackNow, laterChoiceLabel, laterWhen, saveForLater, takeOutOfLater, useLaterWake } from '../later'
import { BUCKET_LABEL, compareFoldKey, foldedBuckets, listsWorkspace, projectWorkspaceIds, repoFoldKey, repoGroups, sidebarGroups, sidebarOrder, STATUS_LABEL, type Triage } from '../triage'
import { promptTitle } from '../../../shared/compare'
import { matchesWorkspace, workspacePurpose, type CompareSection } from '../../../shared/triage'
import { inChannel, itemsInSpace, projectTaskIds, type NeedsYouItem } from '../../../shared/needsYou'
import { needsYouOf, useNeedsYou, useTriageInput } from '../needsYou'
import { employeeOf, openEmployeeItem, rowWords } from './needsYouWords'
import { actionNoun } from './employees/words'
import { NewMenu } from './NewMenu'
import { SidebarSection } from './SidebarSection'
import { SpaceTiles } from './spaces/SpaceTiles'
import { TeamList } from './employees/TeamSection'
import { ChannelList } from './employees/ProjectsSection'
import { SIDEBAR_MODE_LABEL, shownMode, sidebarModes, workView } from '../sidebarModes'
import { currentSpace, snapshotInSpace, spacesOn } from '../../../shared/organizations'
import { QuickSettingsButton } from './settings/QuickTiles'
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
import { ActionRow, Button, ContextMenu, Glyph, HardHat, HoverCard, IconButton, LinkButton, MenuButton, MenuGroup, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator, Spinner, Status, Tab, TabList, TabPanel, Tabs, TextInput, type HardHatColour, type HoverCardTriggerProps, type StatusTone } from '../ui'

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

/** A repository's menu (its heading's ⋯ in Work). Only code repositories are listed: an organization's memory never is. */
function RepoMenuItems({ repo, onRemove }: { repo: Repo; onRemove: () => void }) {
  const t = useT()
  return (
    <>
      <MenuItem onSelect={() => openNewWorkspace(repo.id)}>{t('sidebar.menu.newWorkspace')}</MenuItem>
      <MenuItem onSelect={() => openSettingsPage({ section: 'repo', repoId: repo.id })}>{t('sidebar.menu.repoSettings')}</MenuItem>
      <MenuItem onSelect={() => void navigator.clipboard.writeText(repo.rootPath)}>{t('openIn.copyPath')}</MenuItem>
      <MenuSeparator />
      <MenuItem variant="danger" onSelect={onRemove}>
        {t('sidebar.menu.removeRepo')}
      </MenuItem>
    </>
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
          <Spinner size={15} />
        </span>
      )
    case 'pinned':
      return <Pin size={15} />
    case 'direct':
      return <FolderRoot size={15} />
    case 'adopted':
      return <FolderInput size={15} />
    case 'branch':
      // Cloud workspaces: the cloud is where its branch lives.
      return t.ws.cloud ? <Cloud size={15} /> : <GitBranch size={15} />
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

function WorkspaceRow({ t, index }: { t: Triage; index: number }) {
  const { ws } = t
  const tr = useT()
  // While the Assistant covers the workspace, its entry is the one thing selected; the workspace stays chosen for when it closes.
  const selected = useStore((s) => s.selectedWorkspaceId === ws.id && !(s.assistantOpen && s.snapshot!.settings.assistantEnabled))
  // Finished while you looked elsewhere: its name in bold until opened, as an unread channel's is in Slack.
  const unread = useStore((s) => Boolean(s.unread[ws.id]))
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
  // What it is for (its first chat's title, an employee run's task), its name until a chat has a title.
  const purpose = workspacePurpose(ws, snapshot.sessions)

  const saveName = () => {
    setRenaming(false)
    const next = name.trim()
    // Renaming changes what the row shows: its chat's title while that is its purpose, else the workspace's name.
    if (purpose?.sessionId) {
      if (next && next !== purpose.text) void attempt(() => api.updateSession(purpose.sessionId!, { title: next }))
    } else if (next && next !== ws.name) void attempt(() => api.updateWorkspace(ws.id, { name: next }))
  }
  const shown = purpose?.text ?? ws.name
  // The chat a label names (the one whose turn failed…), unless the row's title already is that chat's.
  const detail = t.label && t.detail && t.detail !== purpose?.text ? t.detail : undefined
  // Repository, the workspace's name and its branch (once each), and age, in the hover card.
  const fullMeta = [snapshot.repos.find((r) => r.id === ws.repoId)?.name, purpose ? ws.name : undefined, ws.branch !== ws.name ? ws.branch : undefined, timeAgo(t.since)].filter(Boolean).join(' · ')
  // What is going on, in words. docs/ai-employees.md §10: a run says whose it is ("Ada asks · Which day does 2.4 launch?").
  const said = employee && ws.startedBy?.via === 'employee' ? (t.namesEmployee ? t.label : t.label ? tr('sidebar.row.byEmployee', { name: employee.name, label: t.label }) : tr('employees.banner.title', { name: employee.name })) : t.label
  const title = ws.compare ? `${shown} · ${ws.compare.label}` : shown
  const icon = (
    <span className="ws-icon" title={archive ? undefined : ws.direct ? tr('sidebar.row.direct') : ws.adopted ? tr('sidebar.row.adopted') : ws.pinned ? tr('sidebar.row.pinned') : ws.cloud ? tr('cloud.glyph') : undefined}>
      {archive?.stopped ? (
        <Status compact aria-hidden tone="warn" label={tr('sidebar.row.archiveStopped')} />
      ) : archive ? (
        <span className="ws-spin blue">
          <Spinner size={15} />
        </span>
      ) : (
        <RowIcon t={t} />
      )}
    </span>
  )

  // One line: glyph, title, label (it gives way first), the employee's hat, and Ctrl+n on hover. The rest (repository,
  // branch, age, the whole label, the shortcut) is in the hover card, which opens on hover and on keyboard focus, never
  // because a click focused the row.
  const row = (card?: HoverCardTriggerProps) => (
      <ActionRow
        className={`ws-row ${selected ? 'selected' : ''} ${unread ? 'unread' : ''} ${t.bucket} ${archiving ? 'archiving' : ''}`}
        selected={selected}
        // A stopped archive opens its dialog, where Retry is.
        onPress={() => (archive?.stopped ? openArchiveDialog(ws.id) : openTriaged(t))}
        primaryProps={{ ...card, className: 'ws-flow' }}
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
        <span className="ws-title">{title}</span>
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
        ) : (
          said && (
            <span className={`ws-label ${t.tone ?? ''}`}>
              {said}
              {detail && <span className="ws-detail"> · {detail}</span>}
            </span>
          )
        )}
        {/* Whose run it is: identity only; the leading glyph says the state. */}
        {employee && (
          <span className="ws-hat">
            <HardHat colour={employee.colour as HardHatColour} size={16} />
          </span>
        )}
      </ActionRow>
  )

  return (
    <>
      {/* Renaming, the row is a field: no card. */}
      {renaming ? (
        row()
      ) : (
        <HoverCard label={title} side="right" width={260} className="ws-card" openOnFocus="keyboard" trigger={row}>
          <span className="ws-card-title">{title}</span>
          <span className="ws-card-line">
            <CloudSub ws={ws} />
            {gitlab && (
              <span className="ws-gitlab" title={tr('gitlab.sidebar.mark')}>
                <GitlabMark size={10} />
              </span>
            )}
            {fullMeta}
          </span>
          {said && !archive && (
            <span className="ws-card-line">
              {employee && (
                <span className="ws-hat">
                  <HardHat colour={employee.colour as HardHatColour} size={14} />
                </span>
              )}
              {detail ? `${said} · ${detail}` : said}
            </span>
          )}
          {index >= 0 && index < 9 && <span className="ws-card-key">{tr('sidebar.row.opensWith', { key: `${modKey(platform)}${index + 1}` })}</span>}
        </HoverCard>
      )}
      {menu && (
        <WorkspaceMenu
          ws={ws}
          x={menu.x}
          y={menu.y}
          dismiss={() => setMenu(null)}
          onRename={() => {
            setName(shown)
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
 * like a workspace's in Needs your attention, on one line: ▲ (◆ when sending failed), what it is, the kind in words and
 * the employee's hat; its hover card adds the employee's name, the repository and how long it has waited. It opens the
 * Team page, where it is decided.
 */
function NeedsYouRow({ item }: { item: NeedsYouItem }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const employee = employeeOf(snapshot, item)
  const { title, label } = rowWords(item, snapshot, t, (p) => actionNoun(p, t))
  const failed = item.action?.state === 'failed'
  const repo = item.repoId ? snapshot.repos.find((r) => r.id === item.repoId)?.name : undefined
  const meta = [employee?.name, repo, item.since ? timeAgo(item.since) : ''].filter(Boolean).join(' · ')
  const hat = employee && (
    <span className="ws-hat">
      <HardHat colour={employee.colour as HardHatColour} size={14} />
    </span>
  )
  return (
    <HoverCard
      label={title}
      side="right"
      width={260}
      className="ws-card"
      openOnFocus="keyboard"
      trigger={(card) => (
        <ActionRow className="ws-row attention needs-row" onPress={() => openEmployeeItem(item)} primaryProps={{ ...card, className: 'ws-flow' }}>
          <span className="ws-icon">
            <Status compact aria-hidden tone={failed ? 'error' : 'warn'} label={label} />
          </span>
          <span className="ws-title">{title}</span>
          <span className={`ws-label ${failed ? 'red' : 'amber'}`}>{label}</span>
          {hat}
        </ActionRow>
      )}
    >
      <span className="ws-card-title">{title}</span>
      <span className="ws-card-line">{label}</span>
      <span className="ws-card-line">
        {hat}
        {meta}
      </span>
    </HoverCard>
  )
}

/**
 * One comparison: its workspaces together under the prompt they were all given. Rows say which model each one is. A
 * flow run's workspaces are grouped the same way, under the flow's name. Its heading folds like every group's.
 */
function CompareGroupView({ section, order, folded, foldable }: { section: CompareSection; order: string[]; folded: boolean; foldable: boolean }) {
  const t = useT()
  return (
    <SidebarSection
      className="ws-group compare"
      title={section.flow === undefined ? section.prompt : undefined}
      name={section.flow !== undefined ? t('sidebar.flowRun', { name: section.flow }) : t('sidebar.compare', { prompt: promptTitle(section.prompt) })}
      count={section.items.length}
      // Its members are in no other group, so folded it says ▲ for those that wait on the person.
      needs={section.items.filter((x) => x.bucket === 'attention').length}
      open={!folded}
      onToggle={() => toggleSidebarGroup(compareFoldKey(section.id))}
      foldable={foldable}
    >
      <div className="ws-group-rows">
        {section.items.map((t) => (
          <WorkspaceRow key={t.ws.id} t={t} index={order.indexOf(t.ws.id)} />
        ))}
      </div>
    </SidebarSection>
  )
}

const MODE_ICON: Record<SidebarMode, LucideIcon> = { inbox: Inbox, work: GitBranch, team: Users, channels: Hash }

/**
 * The modes under the spaces: tabs (ui/Tabs, rail) over the list beside them, each an icon over its name. Inbox says ▲ and
 * how much waits in the space shown; Channels, what its projects wait on (that is in their channels, not Inbox). ↑ ↓ move
 * between them.
 */
function ModeTabs({ modes, waiting }: { modes: SidebarMode[]; waiting: Partial<Record<SidebarMode, number>> }) {
  const t = useT()
  return (
    <TabList className="rail-modes" label={t('sidebar.mode.label')} orientation="vertical">
      {modes.map((mode) => {
        const Icon = MODE_ICON[mode]
        const label = t(SIDEBAR_MODE_LABEL[mode])
        const count = waiting[mode] ?? 0
        return (
          <Tab key={mode} value={mode} aria-label={count ? t('sidebar.rail.needYou', { label, count }) : undefined} data-tour={mode === 'inbox' ? 'needs-you' : undefined}>
            <span className="rail-mode-icon">
              <Icon size={18} aria-hidden />
              {count > 0 && (
                <span className="rail-badge" aria-hidden>
                  {count > 9 ? '9+' : count}
                </span>
              )}
            </span>
            <span className="rail-mode-name">{label}</span>
          </Tab>
        )
      })}
    </TabList>
  )
}

/**
 * The foot of the rail, as the repository rail's was: Automations and the Assistant, then the command palette, shortcuts,
 * reporting a problem, the tour and Quick settings (the gear: a popover of tiles, with the way into Settings), each an
 * icon named with its key.
 */
function RailTools() {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const mod = modKey(platform)
  return (
    <div className="rail-tools">
      <AutomationsEntry className="rail-entry" />
      <AssistantEntry className="rail-entry" />
      <span className="rail-divider" aria-hidden />
      {/* ⌘, not a magnifier: Find (the list's ⌕) is the magnifier on screen. */}
      <IconButton label={t('sidebar.rail.palette', { key: `${mod}K` })} onClick={() => openOverlay('palette')}>
        <Command size={15} />
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
      {/* Quick settings over your work; All settings (and Ctrl+,) opens the page. */}
      <QuickSettingsButton />
    </div>
  )
}

/** A repository's heading in Work: ⋯ has its menu (a workspace in it, its settings, its path, remove). Making things is New's, under the top row. */
function RepoActions({ repo }: { repo: Repo }) {
  const t = useT()
  const [removing, setRemoving] = useState(false)
  return (
    <>
      <MenuButton look="icon" iconOnly small portal label={t('sidebar.repo.more', { repo: repo.name })} trigger={<Ellipsis size={13} aria-hidden />}>
        <RepoMenuItems repo={repo} onRemove={() => setRemoving(true)} />
      </MenuButton>
      {removing && <RemoveRepoDialog repo={repo} onClose={() => setRemoving(false)} />}
    </>
  )
}

/**
 * The sidebar (docs/decisions.md, 2026-11-18): a rail of spaces and modes, and beside it the list of the mode picked. The
 * spaces are tiles with their names (where you are, and ▲ where else you're wanted); the modes are tabs (Inbox, Work, and in
 * an organization Team and Channels); Automations, the Assistant, Settings and ⋯ are at the rail's foot. The Editor
 * layout puts its activity bar (`views`) at the top of the rail and hides the list (`list` false) while the rail has picked
 * another view or the sidebar is hidden. `folded`: a narrow window folded the list to the rail (narrowLayout.ts); picking
 * a mode shows the list beside it again.
 */
export function Sidebar({ resize, side = 'left', views, list = true }: { resize?: PanelSize; side?: PaneSide; views?: ReactNode; list?: boolean; folded?: boolean }) {
  const t = useT()
  const everything = useTriageInput()
  // The space the sidebar shows (docs/ai-employees.md §3): its repositories and their workspaces only. While spaces
  // don't apply this is the whole snapshot, as it always was.
  const space = useStore((s) => s.space)
  const input = { ...everything, snapshot: snapshotInSpace(everything.snapshot, space) }
  const { snapshot } = input
  const stored = useStore((s) => s.sidebarView)
  // Work lists every repository of the space (Home's repository filter is Home's): all of it, or what is saved for later.
  const view = workView(stored)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const mod = modKey(snapshot.platform)
  const modes = sidebarModes(everything.snapshot, space)
  const mode = shownMode(useStore((s) => s.sidebarMode), modes)

  // What needs you is the shared count (src/shared/needsYou.ts) for every space at once, so Inbox, the space tiles and
  // Home agree. A project's workspace and what its tasks ask are in its channel, not rows here.
  const need = needsYouOf(everything)
  const shownSpace = currentSpace(everything.snapshot.organizations, space)
  const spaceName = everything.snapshot.organizations?.find((o) => o.id === shownSpace)?.name ?? t('spaces.personal')
  const inSpace = new Set(snapshot.workspaces.map((w) => w.id))
  const projectIds = projectWorkspaceIds(snapshot)
  const spaceTriage = need.triaged.filter((x) => inSpace.has(x.ws.id) && listsWorkspace(x, projectIds, everything.approvals))
  const projectTasks = projectTaskIds(everything.snapshot)
  const spaceNeeds = itemsInSpace(need.items, shownSpace).filter((i) => !inChannel(i, projectTasks))
  // What the organization's projects wait on: their channels', counted on the Channels tab.
  const channelWaits = (shownSpace ? (everything.snapshot.projects?.[shownSpace] ?? []) : []).reduce((n, p) => n + (p.phase === 'closed' ? 0 : p.waits.length), 0)
  const query = view.query.trim().toLowerCase()
  // Archived work stays about everything, whichever space is shown.
  const archived = everything.snapshot.workspaces.filter((w) => w.state === 'archived').length
  const anyUnread = Object.keys(everything.unread).length > 0
  const order = sidebarOrder(input, view).map((w) => w.id)
  // Saved for later: reachable from a line under Work's list.
  useLaterWake()
  const now = Date.now()
  const laterCount = spaceTriage.filter((x) => waitingLater(x.ws, now)).length
  const later = view.filter === 'later'
  const laterLabel = (x: Triage): Triage => (later && putAway(x, now) ? { ...x, label: laterWhen(x.ws, t), tone: undefined } : x)
  const foldedGroups = foldedBuckets(view, snapshot.settings)
  const foldable = !later && !query
  const titleOf = (i: NeedsYouItem) => rowWords(i, everything.snapshot, t, (p) => actionNoun(p, t)).title.toLowerCase()
  // An employee's decisions with no workspace row of their own (a held push, a memory proposal…) are rows beside the
  // workspaces that wait: they leave the computer, or change what every employee reads.
  const decisions = spaceNeeds.filter((i) => i.kind !== 'workspace' && (!query || titleOf(i).includes(query)))
  const row = (x: Triage) => <WorkspaceRow key={x.ws.id} t={x} index={order.indexOf(x.ws.id)} />
  // Oldest first, workspaces and decisions together.
  const waitingRows = (items: Triage[], extra: NeedsYouItem[]) =>
    [...items.map((x) => ({ since: x.since, node: row(x) })), ...extra.map((i) => ({ since: i.since, node: <NeedsYouRow key={i.id} item={i} /> }))]
      .sort((a, b) => a.since.localeCompare(b.since))
      .map((r) => r.node)

  // Find: ⌕ in the top row opens the box in place, over the title (+ stays). It stays open while it has text; Escape
  // clears and closes it and puts focus back on ⌕; leaving it empty closes it. Inbox and Work have it.
  const [finding, setFinding] = useState(false)
  const findButton = useRef<HTMLButtonElement>(null)
  const findBox = useRef<HTMLInputElement>(null)
  const backToFind = useRef(false)
  const finds = mode === 'inbox' || mode === 'work'
  const findOpen = finds && (finding || view.query !== '')
  useEffect(() => {
    if (findOpen || !backToFind.current) return
    backToFind.current = false
    findButton.current?.focus()
  }, [findOpen])
  const closeFind = () => {
    backToFind.current = true
    setSidebarQuery('')
    setFinding(false)
  }
  // A row's hover card, open under a resting pointer, takes Escape at window capture and stops it, so the box's own
  // handler never hears it. This listener is added once, before any card opens, so it hears Escape first: it closes Find
  // and lets the card close too.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || !findBox.current || document.activeElement !== findBox.current) return
      backToFind.current = true
      setSidebarQuery('')
      setFinding(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const pick = (next: string) => {
    setSidebarMode(next as SidebarMode)
    // The Editor layout's rail had another view picked: the list comes back to show the mode.
    if (views && !list) pickEditorSidebar('workspaces')
  }

  // Inbox: everything in the space that waits on the person, oldest first, then what waits in the other spaces.
  const inbox = () => {
    const rows = waitingRows(
      spaceTriage.filter((x) => x.bucket === 'attention' && !putAway(x, now) && (!query || matchesWorkspace(x.ws, everything.snapshot.sessions, query))),
      decisions
    )
    return (
      <>
        {rows.length ? <div className="ws-group-rows">{rows}</div> : <p className="sidebar-empty">{query ? t('sidebar.empty.noMatch') : t('sidebar.inbox.empty', { space: spaceName })}</p>}
        <Elsewhere shown={shownSpace} />
      </>
    )
  }

  // Work, by repository: each repository's workspaces under its heading, what needs you first; a line above them says
  // how much waits in Inbox, so the mode never hides it.
  const byRepository = () => {
    const { groups, hiddenFinished } = repoGroups(input, view)
    return (
      <>
        {spaceNeeds.length > 0 && !later && (
          <ActionRow className="sb-row sidebar-strip" primaryProps={{ className: 'sb-row-main' }} onPress={() => pick('inbox')}>
            <span className="sb-row-icon sidebar-strip-mark">
              <Glyph name="warn" />
            </span>
            <span className="sb-row-line">{t('sidebar.inbox.strip', { count: spaceNeeds.length })}</span>
          </ActionRow>
        )}
        {groups.map(({ repo, items }) => (
          <SidebarSection
            key={repo.id}
            className="ws-group repo"
            name={repo.name}
            icon={repo.icon ? <RepoIconView icon={repo.icon} size={15} /> : <FolderGit2 size={15} />}
            count={items.length}
            needs={items.filter((x) => x.bucket === 'attention').length}
            open={!foldedGroups.has(repoFoldKey(repo.id))}
            onToggle={() => toggleSidebarGroup(repoFoldKey(repo.id))}
            foldable={foldable}
            actions={<RepoActions repo={repo} />}
          >
            <div className="ws-group-rows">{items.map((x) => row(laterLabel(x)))}</div>
          </SidebarSection>
        ))}
        {groups.length === 0 && <p className="sidebar-empty">{workEmpty()}</p>}
        {workLinks(hiddenFinished)}
      </>
    )
  }

  // Work, by state: needs you (with the decisions), comparisons and flow runs, working, the rest.
  const byState = () => {
    const grouped = sidebarGroups(input, view)
    const { compares, hiddenFinished } = grouped
    const groups = grouped.groups.map((g) => ({ ...g, items: g.items.map(laterLabel) }))
    const extra = later ? [] : decisions
    const listed = extra.length && !groups.some((g) => g.bucket === 'attention') ? [{ bucket: 'attention' as const, items: [] as Triage[] }, ...groups] : groups
    const compareViews = compares.map((c) => <CompareGroupView key={c.id} section={c} order={order} folded={foldedGroups.has(compareFoldKey(c.id))} foldable={foldable} />)
    return (
      <>
        {listed.map((group) => {
          const count = group.items.length + (group.bucket === 'attention' ? extra.length : 0)
          return (
            <Fragment key={group.bucket}>
              {/* Folded, Needs your attention says ▲ and its count on its heading, so what waits is never out of sight. */}
              <SidebarSection
                className={`ws-group ${group.bucket}`}
                name={t(BUCKET_LABEL[group.bucket])}
                count={count}
                needs={group.bucket === 'attention' ? count : 0}
                open={!foldedGroups.has(group.bucket)}
                onToggle={() => toggleSidebarGroup(group.bucket)}
                foldable={foldable}
              >
                <div className="ws-group-rows">{group.bucket === 'attention' ? waitingRows(group.items, extra) : group.items.map((x) => row(x))}</div>
              </SidebarSection>
              {group.bucket === 'attention' && compareViews}
            </Fragment>
          )
        })}
        {!listed.some((g) => g.bucket === 'attention') && compareViews}
        {listed.length === 0 && compares.length === 0 && <p className="sidebar-empty">{workEmpty()}</p>}
        {workLinks(hiddenFinished)}
      </>
    )
  }
  const workEmpty = () => (query ? t('sidebar.empty.noMatch') : later ? t('sidebar.empty.later') : snapshot.repos.length ? t('sidebar.empty.noWorkspaces') : t('sidebar.empty.noRepos'))
  const workLinks = (hiddenFinished: number) => (
    <>
      {later ? (
        <LinkButton size="sm" className="sidebar-more" onClick={() => setSidebarFilter('all')}>
          {t('sidebar.later.back')}
        </LinkButton>
      ) : (
        laterCount > 0 && (
          <LinkButton size="sm" className="sidebar-more" onClick={() => setSidebarFilter('later')}>
            {t('later.link', { count: laterCount })}
          </LinkButton>
        )
      )}
      {hiddenFinished > 0 && (
        <LinkButton size="sm" className="sidebar-more" onClick={toggleShowFinished}>
          {t('sidebar.showFinished', { count: hiddenFinished })}
        </LinkButton>
      )}
      {view.showFinished && !later && !query && spaceTriage.some((x) => x.bucket === 'finished') && (
        <LinkButton size="sm" className="sidebar-more" onClick={toggleShowFinished}>
          {t('sidebar.hideFinished')}
        </LinkButton>
      )}
    </>
  )

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
      <Tabs variant="rail" value={mode} onChange={pick} className="sidebar-body">
        <div className="sidebar-rail">
          {views}
          <SpaceTiles />
          <span className="rail-divider" aria-hidden />
          {/* The list is hidden (folded, or the Editor layout's other views): New stays reachable here, by the work, as one
              button that opens the list of everything to make. */}
          {!list && (
            <span className="rail-item">
              <NewMenu rail />
            </span>
          )}
          <ModeTabs modes={modes} waiting={{ inbox: spaceNeeds.length, channels: channelWaits }} />
          <RailTools />
        </div>
        {list && (
          <div className="sidebar-panel">
            {/* The top row: the space and the mode, Group by (Work) and ⌕ (Inbox and Work). While Find is open, its box
                takes the row's place. Under it, New: the mode's own thing, and ▾ for everything else. */}
            <div className="sidebar-top">
              {findOpen ? (
                <div className="sidebar-search">
                  <Search size={13} aria-hidden />
                  <TextInput
                    ref={findBox}
                    type="search"
                    compact
                    className="sidebar-search-input"
                    aria-label={t('sidebar.search.placeholder')}
                    placeholder={t('sidebar.search.short')}
                    value={view.query}
                    spellCheck={false}
                    autoFocus={finding}
                    onChange={(e) => setSidebarQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Escape') return
                      e.preventDefault()
                      closeFind()
                    }}
                    // Left empty, it closes; with text in it, it stays open so the list stays found.
                    onBlur={(e) => !e.currentTarget.value && setFinding(false)}
                  />
                  {view.query && (
                    <IconButton
                      label={t('sidebar.search.clear')}
                      onClick={() => {
                        setSidebarQuery('')
                        setFinding(true)
                        findBox.current?.focus()
                      }}
                    >
                      <X size={12} />
                    </IconButton>
                  )}
                </div>
              ) : (
                <>
                  <h2 className="sidebar-title">
                    <span className="sidebar-title-space">{spaceName}</span>
                    <span className="sidebar-title-mode">{t(SIDEBAR_MODE_LABEL[mode])}</span>
                  </h2>
                  {mode === 'work' && (
                    <MenuButton look="icon" iconOnly small portal label={t('sidebar.groupBy')} trigger={<Layers size={14} aria-hidden />}>
                      <MenuGroup label={t('sidebar.groupBy')}>
                        <MenuRadioItem checked={view.groupBy !== 'state'} onSelect={() => setSidebarGroupBy('repository')}>
                          {t('sidebar.groupBy.repository')}
                        </MenuRadioItem>
                        <MenuRadioItem checked={view.groupBy === 'state'} onSelect={() => setSidebarGroupBy('state')}>
                          {t('sidebar.groupBy.state')}
                        </MenuRadioItem>
                      </MenuGroup>
                    </MenuButton>
                  )}
                  {finds && (
                    <IconButton ref={findButton} label={t('sidebar.find')} onClick={() => setFinding(true)}>
                      <Search size={15} />
                    </IconButton>
                  )}
                </>
              )}
            </div>
            <NewMenu />
            <TabPanel value={mode} className={`sidebar-scroll sidebar-${mode}`}>
              {finds && anyUnread && (
                <div className="sidebar-actions">
                  <LinkButton size="sm" onClick={markAllRead}>
                    {t('sidebar.markAllRead')}
                  </LinkButton>
                </div>
              )}
              {mode === 'inbox' && inbox()}
              {mode === 'work' && (view.groupBy === 'state' ? byState() : byRepository())}
              {mode === 'team' && <TeamList />}
              {mode === 'channels' && <ChannelList />}
            </TabPanel>
            <UpdateNotice />
            <SttChip />
            <KeepAwakeChip />
            <SidebarFooter archived={archived} />
          </div>
        )}
      </Tabs>
    </aside>
  )
}

/** Under Inbox: what waits in the other spaces, each a link to that space's Inbox. Nothing when nothing does. */
function Elsewhere({ shown }: { shown: string | null }) {
  const t = useT()
  const organizations = useStore((s) => s.snapshot!.organizations) ?? []
  const { counts } = useNeedsYou()
  if (!spacesOn(organizations)) return null
  const others = [{ id: null as string | null, name: t('spaces.personal') }, ...organizations.map((o) => ({ id: o.id as string | null, name: o.name }))].filter((s) => s.id !== shown && (counts.bySpace.get(s.id) ?? 0) > 0)
  if (!others.length) return null
  return (
    <div className="sidebar-elsewhere">
      <span className="sidebar-elsewhere-label">{t('sidebar.inbox.elsewhere')}</span>
      {others.map((s) => {
        const n = counts.bySpace.get(s.id) ?? 0
        return (
          <LinkButton key={s.id ?? 'personal'} size="sm" aria-label={t('sidebar.rail.needYou', { label: s.name, count: n })} onClick={() => setSpace(s.id, { home: false })}>
            {s.name}
            <span className="sidebar-elsewhere-need" aria-hidden>
              <Glyph name="warn" />
              {n}
            </span>
          </LinkButton>
        )
      })}
    </div>
  )
}

/** The list's foot, as before: resource usage (while Settings → Experimental turns it on), Archived and its count, the version. */
function SidebarFooter({ archived }: { archived: number }) {
  const t = useT()
  const version = useStore((s) => s.snapshot!.appVersion)
  return (
    <footer className="sidebar-footer">
      <ResourceUsage />
      {archived > 0 ? (
        <Button variant="ghost" size="sm" icon={<Archive size={13} />} aria-label={t('sidebar.archivedCount', { count: archived })} onClick={() => openOverlay('archived')} title={t('sidebar.archived.title')}>
          {archived}
        </Button>
      ) : (
        <IconButton label={t('sidebar.archived')} onClick={() => openOverlay('archived')}>
          <Archive size={13} />
        </IconButton>
      )}
      {/* The running version, always in sight; Settings → General has it in full with Check now. */}
      {version && (
        <Button variant="ghost" size="sm" className="sidebar-version" onClick={() => openSettingsPage({ section: 'general', scrollTo: 'check-for-updates' })} title={t('sidebar.version.title', { version })}>
          {t('sidebar.version', { version })}
        </Button>
      )}
    </footer>
  )
}
