// The settings menu: a search box over collapsible groups. A category opens to list its
// settings, a repository to list its sections; typing turns the menu into ranked results.
import { ArrowLeft, ChevronRight, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Repo } from '../../../../shared/types'
import { useT } from '../../i18n'
import { openSettingsPage, useStore, type RepoSection, type SettingsPage } from '../../store'
import { ActionRow, Button, Combobox, IconButton, Kbd, Pressable, type ListboxOption } from '../../ui'
import { lucideIcon } from './RepoIcon'
import { CATEGORIES, categoryOf, REPO_TAB_LABELS, SETTINGS, type SettingsCategory } from './registry'
import { buildIndex, highlight, PAGE_ICONS, REPO_TAB_ICONS, rowDescription, rowTitle, search, type SearchItem } from './searchIndex'

const REPO_TABS = Object.keys(REPO_TAB_LABELS) as RepoSection[]

// Groups opened or closed by hand, kept while the app runs. The open page's group starts open.
const toggled = new Map<string, boolean>()

export function SettingsNav({ page, repoTab, onClose }: { page: SettingsPage; repoTab: (repoId: string) => RepoSection; onClose: () => void }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const mac = useStore((s) => s.snapshot!.platform === 'darwin')
  // A repository's Cloud tab shows once cloud workspaces are on (Settings → Cloud workspaces).
  const cloudOn = useStore((s) => Boolean(s.snapshot!.settings.cloud?.enabled))
  const repoTabs = cloudOn ? REPO_TABS : REPO_TABS.filter((tab) => tab !== 'cloud')
  const [query, setQuery] = useState('')
  const [, rerender] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const current = page.section === 'repo' ? `repo:${page.repoId}` : categoryOf(page.section)

  // ⌘F (Ctrl+F) focuses the search box.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!mod || e.shiftKey || e.altKey || e.code !== 'KeyF') return
      // Ctrl+F belongs to the sign-in terminal when it has focus.
      if (!mac && (e.target as Element | null)?.closest?.('.terminal')) return
      e.preventDefault()
      input.current?.focus()
      input.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mac])

  const isOpen = (id: string) => toggled.get(id) ?? id === current
  const toggle = (id: string) => {
    toggled.set(id, !isOpen(id))
    rerender((n) => n + 1)
  }
  const open = (target: SettingsPage) => {
    setQuery('')
    openSettingsPage(target)
  }

  return (
    <nav className="set-nav" aria-label={t('settings.nav.label')}>
      <div className="titlebar drag set-nav-top">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={13} />} title="Esc" onClick={onClose}>
          {t('common.back')}
        </Button>
      </div>
      <SearchBox inputRef={input} query={query} onQuery={setQuery} repos={repos} mac={mac} onPick={open} />
      {!query.trim() && (
        <div className="set-nav-scroll">
          {CATEGORIES.map((c) => (
            <CategoryGroup key={c.id} id={c.id} page={page} open={isOpen(c.id)} onToggle={() => toggle(c.id)} onOpen={open} mac={mac} />
          ))}
          <div className="set-nav-section">{t('settings.nav.repositories')}</div>
          {repos.map((r) => {
            const id = `repo:${r.id}`
            const expanded = isOpen(id)
            const selectedRepo = page.section === 'repo' && page.repoId === r.id
            return (
              <div key={r.id} className="set-nav-group">
                <GroupHead
                  label={r.name}
                  title={r.rootPath}
                  icon={<RepoAvatar repo={r} />}
                  open={expanded}
                  selected={selectedRepo}
                  onToggle={() => toggle(id)}
                  onOpen={() => open({ section: 'repo', repoId: r.id, tab: repoTab(r.id) })}
                />
                {expanded &&
                  repoTabs.map((tab) => {
                    const Icon = REPO_TAB_ICONS[tab]
                    const on = selectedRepo && (page.section === 'repo' && page.tab ? page.tab : repoTab(r.id)) === tab
                    return (
                      <ActionRow key={tab} selected={on} className="set-nav-row" primaryProps={{ className: 'set-nav-row-main' }} onPress={() => open({ section: 'repo', repoId: r.id, tab })}>
                        <Icon size={12} aria-hidden /> <span className="set-nav-row-text">{t(REPO_TAB_LABELS[tab])}</span>
                      </ActionRow>
                    )
                  })}
              </div>
            )
          })}
          {repos.length === 0 && <p className="set-nav-empty">{t('common.none')}</p>}
        </div>
      )}
    </nav>
  )
}

function GroupHead({ label, title, icon, open, selected, count, onToggle, onOpen }: { label: string; title?: string; icon: React.ReactNode; open: boolean; selected: boolean; count?: number; onToggle: () => void; onOpen: () => void }) {
  const t = useT()
  return (
    <div className={`set-nav-head ${selected ? 'selected' : ''}`}>
      <IconButton className="set-nav-chevron" label={open ? t('settings.nav.collapse', { label }) : t('settings.nav.expand', { label })} aria-expanded={open} onClick={onToggle}>
        <ChevronRight size={12} className={open ? 'open' : ''} />
      </IconButton>
      <Pressable className="set-nav-label" title={title} aria-current={selected ? 'page' : undefined} onClick={onOpen}>
        {icon}
        <span className="set-nav-text">{label}</span>
        {count !== undefined && <span className="set-nav-count">{count}</span>}
      </Pressable>
    </div>
  )
}

function CategoryGroup({ id, page, open, onToggle, onOpen, mac }: { id: SettingsCategory; page: SettingsPage; open: boolean; onToggle: () => void; onOpen: (target: SettingsPage) => void; mac: boolean }) {
  const t = useT()
  const category = CATEGORIES.find((c) => c.id === id)!
  const Icon = PAGE_ICONS[category.pages[0]]
  // Windows-only rows (O4) are left out elsewhere.
  const windows = useStore((s) => s.snapshot!.platform === 'win32')
  const rows = useMemo(() => SETTINGS.filter((s) => s.page.section !== 'repo' && (!s.mac || mac) && (!s.windows || windows) && categoryOf(s.page.section) === id), [id, mac, windows])
  const selected = page.section !== 'repo' && categoryOf(page.section) === id
  return (
    <div className="set-nav-group">
      <GroupHead
        label={t(category.label)}
        icon={<Icon size={14} />}
        open={open}
        selected={selected && !page.scrollTo}
        count={rows.length}
        onToggle={onToggle}
        onOpen={() => onOpen({ section: category.pages[0] } as SettingsPage)}
      />
      {open &&
        rows.map((r) => (
          <ActionRow
            key={r.id}
            selected={page.scrollTo === r.id}
            className="set-nav-row"
            primaryProps={{ className: 'set-nav-row-main', title: rowDescription(r, t) }}
            onPress={() => onOpen({ ...(r.page as SettingsPage), scrollTo: r.id })}
          >
            <span className="set-nav-row-text">{rowTitle(r, t)}</span>
          </ActionRow>
        ))}
    </div>
  )
}

/** Results while typing, grouped under the category or repository they belong to. */
function SearchBox({ inputRef, query, onQuery, repos, mac, onPick }: { inputRef: React.RefObject<HTMLInputElement | null>; query: string; onQuery: (q: string) => void; repos: Repo[]; mac: boolean; onPick: (target: SettingsPage) => void }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const items = useMemo(() => buildIndex(repos, mac, t, platform), [repos, mac, t, platform])
  const results = useMemo(() => search(items, query), [items, query])
  const searching = query.trim() !== ''

  // One option per result, in the order drawn; the value is the result's position. Options that share a group label
  // are listed together under it.
  const options = useMemo<ListboxOption<number>[]>(() => {
    const out: { label: string; items: { item: SearchItem; n: number }[] }[] = []
    results.forEach((item, n) => {
      const target = item.target
      const label = target.section === 'repo' ? (repos.find((r) => r.id === target.repoId)?.name ?? t('settings.nav.repository')) : t(CATEGORIES.find((c) => c.id === categoryOf(target.section))!.label)
      const group = out.find((g) => g.label === label) ?? (out.push({ label, items: [] }), out[out.length - 1])
      group.items.push({ item, n })
    })
    return out.flatMap((g) =>
      g.items.map(({ item, n }) => {
        const Icon = item.icon
        return { value: n, label: highlight(item.label, query), textValue: item.label, description: item.sub, group: g.label, leading: <Icon size={13} aria-hidden /> }
      })
    )
  }, [results, query, repos, t])

  return (
    <Combobox<number>
      className="set-nav-search"
      inputRef={inputRef}
      label={t('settings.search.label')}
      placeholder={t('settings.search.placeholder')}
      query={query}
      onQueryChange={onQuery}
      // The results are on whenever there is a query; leaving the box doesn't clear it.
      open={searching}
      inline
      options={options}
      empty={t('settings.search.empty', { query: query.trim() })}
      onChange={(n) => onPick(results[n].target)}
      onKeyDown={(e) => {
        // Clear first; the next Escape closes settings.
        if (e.key === 'Escape' && query) {
          e.preventDefault()
          e.stopPropagation()
          onQuery('')
        }
      }}
      leading={<Search size={14} aria-hidden />}
      trailing={
        query ? (
          <IconButton
            label={t('settings.search.clear')}
            onClick={() => {
              onQuery('')
              inputRef.current?.focus()
            }}
          >
            <X size={12} />
          </IconButton>
        ) : (
          <Kbd aria-hidden>{mac ? '⌘F' : 'Ctrl+F'}</Kbd>
        )
      }
    />
  )
}

function RepoAvatar({ repo }: { repo: Repo }) {
  const icon = repo.icon
  if (icon?.kind === 'image') return <img className="set-repo-avatar image" src={icon.dataUrl} alt="" />
  if (icon?.kind === 'emoji') return <span className="set-repo-avatar emoji" aria-hidden>{icon.value}</span>
  const Lucide = icon?.kind === 'lucide' ? lucideIcon(icon.name) : undefined
  if (Lucide) return <Lucide size={14} />
  return (
    <span className="set-repo-avatar letter" aria-hidden>
      {(repo.name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}
