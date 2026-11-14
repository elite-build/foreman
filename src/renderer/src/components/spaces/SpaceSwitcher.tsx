// The space switcher in the sidebar's header (docs/ai-employees.md §3 and §10): Personal and each organization with how
// many repositories it holds and its memory repository, the current one checked, then Open memory (for an organization
// with a memory repository), New organization… and Manage spaces…. Always drawn: before any organization exists it reads
// Personal, and New organization… is how one is made.
import { Brain, ChevronDown, Plus, Settings2 } from 'lucide-react'
import { currentSpace, reposInSpace, type Organization } from '../../../../shared/organizations'
import { useT } from '../../i18n'
import { openCreateOrganization, openMemory, openSettingsPage, setSpace, useStore } from '../../store'
import { MenuButton, MenuGroup, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator } from '../../ui'
import './spaces.css'

export function SpaceSwitcher() {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const wanted = useStore((s) => s.space)
  const organizations = snapshot.organizations ?? []
  const space = currentSpace(organizations, wanted)
  const current = organizations.find((o) => o.id === space)
  const name = current?.name ?? t('spaces.personal')
  const count = (id: string | null) => reposInSpace(snapshot.repos, organizations, id).length
  const memory = (org: Organization) => snapshot.repos.find((r) => r.id === org.memoryRepoId)?.name
  const detail = (org: Organization) => {
    const repo = memory(org)
    return repo ? t('spaces.switcher.withMemory', { count: count(org.id), memory: repo }) : t('spaces.switcher.noMemory', { count: count(org.id) })
  }
  return (
    <div className="space-switcher">
      <MenuButton
        look="ghost"
        portal
        placement="bottom-start"
        label={t('spaces.switcher.label')}
        aria-label={t('spaces.switcher.trigger', { space: name })}
        triggerClassName="space-switcher-trigger"
        trigger={
          <>
            <span className="space-switcher-name">{name}</span>
            <ChevronDown size={13} aria-hidden />
          </>
        }
      >
        <MenuLabel>{t('spaces.switcher.heading')}</MenuLabel>
        <MenuGroup label={t('spaces.switcher.heading')}>
          <MenuRadioItem checked={space === null} description={t('spaces.switcher.noMemory', { count: count(null) })} onSelect={() => setSpace(null)}>
            {t('spaces.personal')}
          </MenuRadioItem>
          {organizations.map((org) => (
            <MenuRadioItem key={org.id} checked={space === org.id} description={detail(org)} onSelect={() => setSpace(org.id)}>
              {org.name}
            </MenuRadioItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        {/* The space shown has a memory repository: its Memory view (docs/ai-employees.md §10). */}
        {current?.memoryRepoId && (
          <MenuItem icon={<Brain size={14} />} onSelect={() => openMemory(current.id)}>
            {t('memory.openFor', { organization: current.name })}
          </MenuItem>
        )}
        <MenuItem icon={<Plus size={14} />} description={t('spaces.create.menuDetail')} onSelect={() => openCreateOrganization(true)}>
          {t('spaces.create.menu')}
        </MenuItem>
        <MenuItem icon={<Settings2 size={14} />} onSelect={() => openSettingsPage({ section: 'spaces' })}>
          {t('spaces.manage')}
        </MenuItem>
      </MenuButton>
    </div>
  )
}
