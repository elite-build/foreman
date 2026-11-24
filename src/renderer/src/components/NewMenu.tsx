// The sidebar's one way to add anything: a full-width split button under its top row. The main half makes what the mode
// is about (Inbox and Work a workspace, Team an employee, Channels a project); the ▾ opens the list of everything there
// is to make (NewList in Overlays.tsx, also Ctrl+Shift+N) in the middle of the window, the mode's own item first. Inbox
// and Work also have a folder-plus at the row's end: a short menu of the ways to add a repository to the space shown.
// When the list is folded away (a narrow window) or hidden, one icon button on the rail opens the same list.
import { Clock, Ellipsis, FolderOpen, FolderPlus, Globe, Plus } from 'lucide-react'
import { currentSpace, newWorkspaceTarget, snapshotInSpace, workspaceRepos } from '../../../shared/organizations'
import { useT } from '../i18n'
import { shortcutHint } from '../shortcuts'
import { SIDEBAR_MODE_LABEL, shownMode, shownOrganization, sidebarModes } from '../sidebarModes'
import {
  addRepository,
  clientKind,
  modKey,
  openAddRepoDialog,
  openAutomations,
  openCreateOrganization,
  openEmployees,
  openImportDialog,
  openNewWorkspace,
  openOverlay,
  openRecentRepo,
  useStore,
  type SidebarMode
} from '../store'
import { Button, MenuButton, MenuGroup, MenuItem, MenuLabel, MenuSeparator, SplitButton } from '../ui'
import { tildify } from './AddRepository'

/** One thing the list can make. `run` does it; the list closes itself first. */
export interface NewRow {
  id: string
  label: string
  detail?: string
  group: string
  hint?: string
  // A recent folder: listed only once something is typed, so the resting list stays short.
  recent?: boolean
  run: () => void
}

/**
 * What there is to make in the space shown, ordered by the sidebar's mode: its own item first (`primary`, what the
 * button's main half does), then the rest of the space, then the ways to bring something into Foreman.
 */
export function useNewRows(): { primary: NewRow; rows: NewRow[]; mode: SidebarMode } {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const space = useStore((s) => s.space)
  const picked = useStore((s) => s.sidebarView.repo)
  const selectedWorkspaceId = useStore((s) => s.selectedWorkspaceId)
  const wantedMode = useStore((s) => s.sidebarMode)
  const mode = shownMode(wantedMode, sidebarModes(snapshot, space))
  // Employees and projects belong to an organization with a memory repository, while it is the space shown.
  const org = shownOrganization(snapshot, space)
  const pm = org?.programManagerId ? snapshot.employees?.[org.id]?.employees.find((e) => e.id === org.programManagerId) : undefined
  const repoId = newWorkspaceTarget(snapshot, { space, picked, selectedWorkspaceId })
  const repos = workspaceRepos(snapshotInSpace(snapshot, space).repos, snapshot.organizations)
  const key = shortcutHint('workspace.new', snapshot.platform) ?? `${modKey(snapshot.platform)}N`
  const here = t('newList.inMode', { mode: t(SIDEBAR_MODE_LABEL[mode]) })
  const also = t('newList.also', { space: org?.name ?? t('spaces.personal') })
  const bring = t('newList.bring')

  // A workspace per repository of the space, the one Ctrl+N uses first.
  const ordered = repoId ? [...repos.filter((r) => r.id === repoId), ...repos.filter((r) => r.id !== repoId)] : repos
  const workspaces: Omit<NewRow, 'group'>[] = ordered.map((r, i) => ({
    id: `workspace-${r.id}`,
    label: t('palette.newWorkspace'),
    detail: t('sidebar.add.workspaceIn', { repo: r.name }),
    hint: i === 0 ? key : undefined,
    run: () => openNewWorkspace(r.id)
  }))
  const employee: Omit<NewRow, 'group'> | undefined = org && {
    id: 'employee',
    label: t('sidebar.team.newEmployee'),
    detail: t('sidebar.add.employeeIn', { organization: org.name }),
    run: () => openEmployees({ orgId: org.id, page: 'new' })
  }
  // A new project is planned by the program manager: the organization's channel with @name in its box.
  const project: Omit<NewRow, 'group'> | undefined = org?.programManagerId
    ? { id: 'project', label: t('projects.new'), detail: t('sidebar.add.channelWith', { name: pm?.name || t('projects.pmDefault') }), run: () => openEmployees({ orgId: org.id, page: 'channel', mention: Date.now() }) }
    : undefined
  const automation: Omit<NewRow, 'group'> = { id: 'automation', label: t('sidebar.add.automation'), detail: t('sidebar.add.automationDetail'), run: () => openAutomations() }
  const openFolder: Omit<NewRow, 'group'> = { id: 'open-project', label: t('addRepo.openProject'), run: () => void addRepository() }

  // The main half: the mode's own thing, else a workspace, else (no repository yet) a repository.
  const main: Omit<NewRow, 'group'> =
    (mode === 'team' && employee) || (mode === 'channels' && project) || workspaces[0] || { ...openFolder, id: 'add-repository', label: t('sidebar.addRepository') }

  const inSpace = [...workspaces, project, employee, automation].filter((r): r is Omit<NewRow, 'group'> => Boolean(r) && r!.id !== main.id)
  const recents = (snapshot.recentRepos ?? []).map((p) => ({ id: `recent-${p}`, label: tildify(p, snapshot.homeDir), detail: t('newList.recent'), recent: true, run: () => void openRecentRepo(p) }))
  const rows: NewRow[] = [
    { ...main, group: here },
    ...inSpace.map((r) => ({ ...r, group: also })),
    ...(main.id === 'add-repository' ? [] : [openFolder]).map((r) => ({ ...r, group: bring })),
    { id: 'clone', label: t('addRepo.openGithub'), group: bring, run: () => openAddRepoDialog('clone') },
    { id: 'quick-start', label: t('addRepo.quickStart'), group: bring, run: () => openAddRepoDialog('quick-start') },
    ...recents.map((r) => ({ ...r, group: bring })),
    // A .foreman file is picked on the computer: the window's alone.
    ...(clientKind === 'window' && snapshot.repos.length ? [{ id: 'import', label: t('sidebar.import'), detail: t('sidebar.import.title'), group: bring, run: openImportDialog }] : []),
    { id: 'organization', label: t('spaces.create.menu'), detail: t('spaces.create.menuDetail'), group: bring, run: () => openCreateOrganization(true) }
  ]
  return { primary: rows[0], rows, mode }
}

/** `rail`: the folded rail's icon button, which opens the list. */
export function NewMenu({ rail }: { rail?: boolean }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const platform = snapshot.platform
  const space = useStore((s) => s.space)
  const { primary, mode } = useNewRows()
  const more = t('newList.more')
  // The space shown, by name: the folder-plus says which one a new repository joins.
  const shownSpace = currentSpace(snapshot.organizations, space)
  const addLabel = t('sidebar.addRepo.label', { space: snapshot.organizations?.find((o) => o.id === shownSpace)?.name ?? t('spaces.personal') })
  const recent = (snapshot.recentRepos ?? []).slice(0, 3)
  const listKey = shortcutHint('new.list', platform)
  if (rail)
    return (
      <span className="rail-add-wrap" data-tour="add-repo">
        <Button variant="primary" className="rail-add" aria-label={more} title={listKey ? `${more} (${listKey})` : more} aria-haspopup="dialog" data-tour="new-workspace" onClick={() => openOverlay('new')}>
          <Plus size={15} aria-hidden />
        </Button>
      </span>
    )
  return (
    // The tour's add steps (a repository, a workspace) point at the split button and the folder-plus.
    <div className="sidebar-new">
      <SplitButton
        variant="primary"
        className="sidebar-new-split"
        label={
          <>
            <Plus size={14} aria-hidden />
            <span className="sidebar-new-label">{primary.label}</span>
            {primary.hint && <span className="sidebar-new-hint">{primary.hint}</span>}
          </>
        }
        aria-label={primary.label}
        aria-keyshortcuts={primary.hint ? (platform === 'darwin' ? 'Meta+N' : 'Control+N') : undefined}
        data-tour="new-workspace"
        menuLabel={listKey ? `${more} (${listKey})` : more}
        onClick={primary.run}
        onArrowClick={() => openOverlay('new')}
      />
      {(mode === 'inbox' || mode === 'work') && (
        <MenuButton
          look="button"
          iconOnly
          placement="bottom-end"
          label={addLabel}
          trigger={<FolderPlus size={16} aria-hidden />}
          triggerClassName="sidebar-add-repo"
          data-tour="add-repo"
        >
          <MenuLabel>{addLabel}</MenuLabel>
          <MenuGroup label={addLabel}>
            <MenuItem icon={<FolderOpen size={14} />} onSelect={() => void addRepository()}>
              {t('addRepo.openProject')}
            </MenuItem>
            <MenuItem icon={<Globe size={14} />} onSelect={() => openAddRepoDialog('clone')}>
              {t('addRepo.openGithub')}
            </MenuItem>
            <MenuItem icon={<FolderPlus size={14} />} onSelect={() => openAddRepoDialog('quick-start')}>
              {t('addRepo.quickStart')}
            </MenuItem>
          </MenuGroup>
          {recent.length > 0 && (
            <>
              <MenuLabel>{t('addRepo.recentFolders')}</MenuLabel>
              <MenuGroup label={t('addRepo.recentFolders')}>
                {recent.map((p) => (
                  <MenuItem key={p} icon={<Clock size={14} />} title={p} onSelect={() => void openRecentRepo(p)}>
                    {tildify(p, snapshot.homeDir)}
                  </MenuItem>
                ))}
              </MenuGroup>
            </>
          )}
          <MenuSeparator />
          <MenuItem icon={<Ellipsis size={14} />} description={t('addRepo.moreDetail')} onSelect={() => openAddRepoDialog('add')}>
            {t('addRepo.more')}
          </MenuItem>
        </MenuButton>
      )}
    </div>
  )
}
