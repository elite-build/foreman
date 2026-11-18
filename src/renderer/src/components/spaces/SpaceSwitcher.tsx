// The space switcher, the start of the sidebar's top row (docs/ai-employees.md §3 and §10): the space shown and, when
// another space has something waiting, where ("▲ 3 in Acme", only "▲ 3" in a narrow sidebar). Its line (the space's
// code repositories, or the repository picked) is its tooltip and the first line of its menu. The menu lists Personal and
// each organization with how much waits in it and how many code repositories it holds, the current one checked, then
// Manage spaces…; an organization's memory repository is never named or opened here (nothing on the left shows what
// Foreman keeps for it). Always drawn: before any organization exists it reads Personal; New organization… is in the
// sidebar's + menu (NewMenu). Every count is the shared needs-you count (src/shared/needsYou.ts). In a narrow window the
// sidebar folds to its rail, and the switcher is the rail's top tile (SpaceRailTile): the space's initial, "▲ 3" when
// another space waits, and the same menu.
import { ChevronDown, Settings2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { currentSpace, reposInSpace, spacesOn, workspaceRepos } from '../../../../shared/organizations'
import { useT } from '../../i18n'
import { useNeedsYou } from '../../needsYou'
import { openSettingsPage, setSpace, useStore } from '../../store'
import { Glyph, MenuButton, MenuGroup, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator } from '../../ui'
import './spaces.css'

/** The space shown, what waits in each space, and where else something waits: the heading's and the rail tile's. */
function useSpaces() {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const wanted = useStore((s) => s.space)
  const { counts } = useNeedsYou()
  const organizations = snapshot.organizations ?? []
  const space = currentSpace(organizations, wanted)
  const current = organizations.find((o) => o.id === space)
  const name = current?.name ?? t('spaces.personal')
  const spaceName = (id: string | null) => (id ? organizations.find((o) => o.id === id)?.name : t('spaces.personal'))
  // Code repositories only: an organization's memory repository holds no workspaces and isn't counted as one.
  const count = (id: string | null) => workspaceRepos(reposInSpace(snapshot.repos, organizations, id), organizations).length
  const waiting = (id: string | null) => counts.bySpace.get(id) ?? 0
  const detail = (id: string | null) => t('sidebar.subtitle.repos', { count: count(id) })
  // "▲1 needs you · 2 repositories": how much waits in a space comes first in its description.
  const description = (id: string | null, rest: string): ReactNode => {
    const n = waiting(id)
    if (!n) return rest
    return (
      <>
        <span className="space-switcher-need">
          <span className="space-switcher-mark"><Glyph name="warn" /></span>
          {t('home.banner.needYou', { count: n })}
        </span>
        {` · ${rest}`}
      </>
    )
  }
  // Where else something waits: one other space by name, several together.
  const others = spacesOn(organizations) ? [...counts.bySpace].filter(([id, n]) => id !== space && n > 0 && spaceName(id)) : []
  const elsewhere = others.length === 1 ? t('needsYou.inSpace', { count: others[0][1], space: spaceName(others[0][0])! }) : others.length ? t('needsYou.inOtherSpaces', { count: others.reduce((sum, [, n]) => sum + n, 0) }) : ''
  const elsewhereCount = others.reduce((sum, [, n]) => sum + n, 0)
  const items = (line?: string) => (
    <>
      {line && <MenuLabel>{line}</MenuLabel>}
      <MenuLabel>{t('spaces.switcher.heading')}</MenuLabel>
      <MenuGroup label={t('spaces.switcher.heading')}>
        <MenuRadioItem checked={space === null} description={description(null, detail(null))} onSelect={() => setSpace(null)}>
          {t('spaces.personal')}
        </MenuRadioItem>
        {organizations.map((org) => (
          <MenuRadioItem key={org.id} checked={space === org.id} description={description(org.id, detail(org.id))} onSelect={() => setSpace(org.id)}>
            {org.name}
          </MenuRadioItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem icon={<Settings2 size={14} />} onSelect={() => openSettingsPage({ section: 'spaces' })}>
        {t('spaces.manage')}
      </MenuItem>
    </>
  )
  return { name, elsewhere, elsewhereCount, items }
}

/**
 * `line`: the space's code repositories, or the repository picked: the switcher's tooltip and its menu's first line.
 * What needs the person in this space is on the Needs you tab and the rail, so the heading doesn't say it again.
 */
export function SpaceSwitcher({ line }: { line?: string }) {
  const t = useT()
  const { name, elsewhere, elsewhereCount, items } = useSpaces()
  return (
    <header className="space-switcher">
      <div className="space-switcher-title" role="heading" aria-level={2}>
        <MenuButton
          look="ghost"
          portal
          placement="bottom-start"
          label={t('spaces.switcher.label')}
          aria-label={elsewhere ? t('spaces.switcher.triggerWaiting', { space: name, waiting: elsewhere }) : t('spaces.switcher.trigger', { space: name })}
          title={line}
          triggerClassName="space-switcher-trigger"
          trigger={
            <>
              <span className="space-switcher-name">{name}</span>
              <ChevronDown size={14} aria-hidden />
              {elsewhere && (
                <span className="space-switcher-elsewhere">
                  <span className="space-switcher-mark">
                    <Glyph name="warn" />
                  </span>
                  {/* A narrow sidebar keeps the ▲ and the count; the words give way (the button's name keeps them). */}
                  <span className="space-switcher-elsewhere-count">{elsewhereCount}</span>
                  <span className="space-switcher-elsewhere-text">{elsewhere}</span>
                </span>
              )}
            </>
          }
        >
          {items(line)}
        </MenuButton>
      </div>
    </header>
  )
}

/**
 * The switcher as the rail's top tile, while a narrow window folds the list to its rail: the space's initial, with "▲ 3"
 * when another space has something waiting (what this space waits on is on All, under it), opening the same menu beside
 * the rail. Its name says the space and, when it is so, where else something waits.
 */
export function SpaceRailTile() {
  const t = useT()
  const { name, elsewhere, elsewhereCount, items } = useSpaces()
  return (
    <MenuButton
      portal
      placement="right-start"
      label={t('spaces.switcher.label')}
      aria-label={elsewhere ? t('spaces.switcher.triggerWaiting', { space: name, waiting: elsewhere }) : t('spaces.switcher.trigger', { space: name })}
      title={elsewhere ? t('spaces.switcher.triggerWaiting', { space: name, waiting: elsewhere }) : t('spaces.switcher.trigger', { space: name })}
      triggerClassName="rail-space"
      trigger={
        <>
          <span className="rail-text" aria-hidden>
            {Array.from(name)[0]?.toUpperCase() ?? '?'}
          </span>
          {elsewhereCount > 0 && (
            <span className="rail-badge" aria-hidden>
              <Glyph name="warn" />
              {elsewhereCount > 9 ? '9+' : elsewhereCount}
            </span>
          )}
        </>
      }
    >
      {items()}
    </MenuButton>
  )
}
