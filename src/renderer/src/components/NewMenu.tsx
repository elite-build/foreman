// The sidebar's one way to add anything: a + that opens a menu of every kind of thing there is to add. A workspace (Ctrl+N
// still makes one at once), in an organization an employee and a channel, an automation, a repository (open, clone, quick
// start, a recent folder), a workspace from a .foreman file, and an organization. It sits at the end of the sidebar's top
// row, and on the rail when the list is folded away (a narrow window) or hidden.
import { FileDown, GitBranch, Hash, Network, Plus, UserPlus, Zap } from 'lucide-react'
import { currentSpace, spacesOn } from '../../../shared/organizations'
import { useT } from '../i18n'
import { shortcutHint } from '../shortcuts'
import { clientKind, modKey, openAutomations, openCreateOrganization, openEmployees, openImportDialog, openNewWorkspace, useStore } from '../store'
import { MenuButton, MenuItem, MenuLabel, MenuSeparator, type MenuPlacement } from '../ui'
import { AddRepoItems } from './AddRepository'

/**
 * `repoId`: the repository a new workspace goes in (the one Ctrl+N uses, newWorkspaceTarget), undefined when there is none
 * to work in. `rail`: drawn as the rail's tile, its menu opening beside it.
 */
export function NewMenu({ repoId, rail }: { repoId: string | undefined; rail?: boolean }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const wanted = useStore((s) => s.space)
  const organizations = snapshot.organizations ?? []
  // Employees and channels belong to an organization with a memory repository, while it is the space shown.
  const org = spacesOn(organizations) ? organizations.find((o) => o.id === currentSpace(organizations, wanted) && o.memoryRepoId) : undefined
  const pm = org?.programManagerId ? snapshot.employees?.[org.id]?.employees.find((e) => e.id === org.programManagerId) : undefined
  const repo = repoId ? snapshot.repos.find((r) => r.id === repoId) : undefined
  const key = shortcutHint('workspace.new', snapshot.platform) ?? `${modKey(snapshot.platform)}N`
  const placement: MenuPlacement = rail ? 'right-start' : 'bottom-end'
  return (
    // Both tour steps about adding (a repository, a workspace) point at the one +.
    <span className="sidebar-add-wrap" data-tour="add-repo">
      <MenuButton
        look="primary"
        iconOnly
        portal
        placement={placement}
        label={t('sidebar.new')}
        triggerClassName={rail ? 'rail-add' : 'sidebar-add'}
        data-tour="new-workspace"
        trigger={<Plus size={15} aria-hidden />}
      >
        <MenuItem
          icon={<GitBranch size={14} />}
          hint={key}
          description={repo ? t('sidebar.add.workspaceIn', { repo: repo.name }) : undefined}
          disabled={!repoId}
          reason={repoId ? undefined : t('sidebar.add.noRepo')}
          aria-keyshortcuts={snapshot.platform === 'darwin' ? 'Meta+N' : 'Control+N'}
          onSelect={() => repoId && openNewWorkspace(repoId)}
        >
          {t('palette.newWorkspace')}
        </MenuItem>
        {org && (
          <MenuItem icon={<UserPlus size={14} />} description={t('sidebar.add.employeeIn', { organization: org.name })} onSelect={() => openEmployees({ orgId: org.id, page: 'new' })}>
            {t('sidebar.team.newEmployee')}
          </MenuItem>
        )}
        {/* A new channel is a project the program manager plans: the organization's channel with @name in its box. */}
        {org?.programManagerId && (
          <MenuItem icon={<Hash size={14} />} description={t('sidebar.add.channelWith', { name: pm?.name || t('projects.pmDefault') })} onSelect={() => openEmployees({ orgId: org.id, page: 'channel', mention: Date.now() })}>
            {t('projects.new')}
          </MenuItem>
        )}
        <MenuItem icon={<Zap size={14} />} description={t('sidebar.add.automationDetail')} onSelect={() => openAutomations()}>
          {t('sidebar.add.automation')}
        </MenuItem>
        <MenuSeparator />
        <MenuLabel>{t('sidebar.rail.add')}</MenuLabel>
        <AddRepoItems />
        <MenuSeparator />
        {/* A .foreman file is picked on the computer: the window's alone. */}
        {clientKind === 'window' && (
          <MenuItem icon={<FileDown size={14} />} description={t('sidebar.import.title')} disabled={snapshot.repos.length === 0} onSelect={openImportDialog}>
            {t('sidebar.import')}
          </MenuItem>
        )}
        <MenuItem icon={<Network size={14} />} description={t('spaces.create.menuDetail')} onSelect={() => openCreateOrganization(true)}>
          {t('spaces.create.menu')}
        </MenuItem>
      </MenuButton>
    </span>
  )
}
