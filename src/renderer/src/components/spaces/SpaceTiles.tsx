// The spaces at the top of the sidebar's rail (docs/ai-employees.md §3, §10; docs/decisions.md, 2026-11-18).
import { Plus, Settings2, User } from 'lucide-react'
import { useState } from 'react'
import { currentSpace, spaceIcon, type Organization } from '../../../../shared/organizations'
import { useT } from '../../i18n'
import { useNeedsYou } from '../../needsYou'
import { openCreateOrganization, openSettingsPage, setSpace, useStore } from '../../store'
import { CardButton, ContextMenu, IconButton, MenuItem } from '../../ui'
import { RepoIconView } from '../settings/RepoIcon'

/**
 * The spaces at the top of the rail (docs/ai-employees.md §3, §10): Personal, then each organization, a tile each with its
 * name under it, so which space is shown is never a word in a menu. The one shown is the selected tile; every other says
 * ▲ and how much waits in it (the shared needs-you count), so where else you're wanted is in sight too (what waits here is
 * on Inbox). A tile shows its space (and Home); right-click an organization's for Manage spaces (never its memory: nothing
 * on the left opens it, docs/decisions.md). + under them makes an organization.
 */
export function SpaceTiles() {
  const t = useT()
  const organizations = useStore((s) => s.snapshot!.organizations) ?? []
  const repos = useStore((s) => s.snapshot!.repos)
  const wanted = useStore((s) => s.space)
  const { counts } = useNeedsYou()
  const shown = currentSpace(organizations, wanted)
  const [menu, setMenu] = useState<{ org: Organization; x: number; y: number } | null>(null)
  const spaces: { id: string | null; name: string; org?: Organization }[] = [{ id: null, name: t('spaces.personal') }, ...organizations.map((org) => ({ id: org.id, name: org.name, org }))]
  return (
    <nav className="rail-spaces" aria-label={t('sidebar.spaces.label')}>
      {spaces.map(({ id, name, org }) => {
        const on = id === shown
        const waiting = on ? 0 : (counts.bySpace.get(id) ?? 0)
        const label = waiting ? t('sidebar.rail.needYou', { label: name, count: waiting }) : name
        return (
          <span key={id ?? 'personal'} className={`rail-space ${on ? 'on' : ''}`}>
            <CardButton
              className="rail-tile"
              selected={on}
              aria-pressed={on}
              aria-label={label}
              title={label}
              onClick={() => setSpace(id)}
              onContextMenu={
                org
                  ? (e) => {
                      e.preventDefault()
                      setMenu({ org, x: e.clientX, y: e.clientY })
                    }
                  : undefined
              }
            >
              {id === null ? (
                <User size={16} aria-hidden />
              ) : org && spaceIcon(org, repos) ? (
                // Its own icon, or its repository of the same name's (Settings → Spaces).
                <RepoIconView icon={spaceIcon(org, repos)} name={name} size={18} />
              ) : (
                <span className="rail-initial" aria-hidden>
                  {Array.from(name)[0]?.toUpperCase() ?? '?'}
                </span>
              )}
              {waiting > 0 && (
                <span className="rail-badge" aria-hidden>
                  {waiting > 9 ? '9+' : waiting}
                </span>
              )}
            </CardButton>
            {/* The tile's name says it; this is the same word for the eye. */}
            <span className="rail-space-name" aria-hidden>
              {name}
            </span>
          </span>
        )
      })}
      <IconButton className="rail-new-space" label={t('spaces.create.menu')} onClick={() => openCreateOrganization(true)}>
        <Plus size={15} />
      </IconButton>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} label={menu.org.name} onClose={() => setMenu(null)}>
          <MenuItem icon={<Settings2 size={14} />} onSelect={() => openSettingsPage({ section: 'spaces' })}>
            {t('spaces.manage')}
          </MenuItem>
        </ContextMenu>
      )}
    </nav>
  )
}
