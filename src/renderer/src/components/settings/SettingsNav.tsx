// The settings menu: a search box over two trees, the settings (category → page, or agent → its parts; pages.ts) and
// the repositories (repository → its pages). One tab stop per tree: ↑ ↓ move, → opens a group (and its first page),
// ← closes it, Enter opens a page. Only the open page's groups stay open. While searching, the results fill the page
// (SearchResults.tsx) and each category here says how many it has.
import { ArrowLeft, ChevronRight, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import type { Repo } from '../../../../shared/types'
import { useT } from '../../i18n'
import { openSettingsPage, useStore, type RepoSection, type SettingsPage } from '../../store'
import { Button, IconButton, Kbd, TextInput, Tree, TreeItem, type TreeNodeRow } from '../../ui'
import { lucideIcon } from './RepoIcon'
import { firstPage, linkTo, pageNode, pathTo, settingsTree, type SettingsNode } from './pages'
import { categoryOf, REPO_TAB_LABELS, SETTINGS, type SettingsCategory } from './registry'
import { categoryIcon, type SearchItem } from './searchIndex'

const REPO_TABS = Object.keys(REPO_TAB_LABELS) as RepoSection[]

/** The menu's tree for the open page (an agent that isn't turned on is listed while its page is open). */
export function useSettingsTree(page: SettingsPage | null): SettingsNode[] {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const agentPrefs = useStore((s) => s.snapshot!.settings.agentPrefs)
  const openAgent = page?.section === 'agents' ? page.agent : undefined
  return useMemo(() => settingsTree({ t, platform, agentPrefs, openAgent }), [t, platform, agentPrefs, openAgent])
}

interface Props {
  page: SettingsPage
  repoTab: (repoId: string) => RepoSection
  onClose: () => void
  query: string
  onQuery: (query: string) => void
  // The search's results while there is a query: each category counts its own.
  results: SearchItem[]
  inputRef: RefObject<HTMLInputElement | null>
  // ↓ in the search box: into the results.
  onResults: () => void
}

export function SettingsNav({ page, repoTab, onClose, query, onQuery, results, inputRef, onResults }: Props) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const mac = useStore((s) => s.snapshot!.platform === 'darwin')
  const windows = useStore((s) => s.snapshot!.platform === 'win32')
  // A repository's Cloud tab shows once cloud workspaces are on (Settings → Remote workspaces).
  const cloudOn = useStore((s) => Boolean(s.snapshot!.settings.cloud?.enabled))
  const repoTabs = cloudOn ? REPO_TABS : REPO_TABS.filter((tab) => tab !== 'cloud')
  const tree = useSettingsTree(page)
  const searching = query.trim() !== ''

  // The open page's node, and the groups above it: those are open unless closed by hand.
  const current = page.section === 'repo' ? undefined : pageNode(tree, page)
  const currentPath = useMemo(() => (current ? pathTo(tree, current.id) : []), [tree, current])
  const repoId = page.section === 'repo' ? page.repoId : undefined
  const currentTab = page.section === 'repo' ? (page.tab ?? repoTab(page.repoId)) : undefined
  const pageKey = current?.id ?? `repo:${repoId}/${currentTab}`
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => setClosed(new Set()), [pageKey])
  const ancestors = useMemo(() => new Set([...currentPath.slice(0, -1).map((n) => n.id), ...(repoId ? [`repo:${repoId}`] : [])]), [currentPath, repoId])
  const isOpen = (id: string) => ancestors.has(id) && !closed.has(id)

  // ⌘F (Ctrl+F) focuses the search box.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!mod || e.shiftKey || e.altKey || e.code !== 'KeyF') return
      // Ctrl+F belongs to the sign-in terminal when it has focus.
      if (!mac && (e.target as Element | null)?.closest?.('.terminal')) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mac, inputRef])

  const open = (target: SettingsPage) => {
    onQuery('')
    openSettingsPage(target)
  }

  // Opening a closed group: back open when the page is in it, else its first page (whose group then opens).
  const toggle = (id: string, first: () => SettingsPage | undefined) => {
    if (isOpen(id)) return setClosed(new Set([...closed, id]))
    if (ancestors.has(id)) return setClosed(new Set([...closed].filter((c) => c !== id)))
    const target = first()
    if (target) open(target)
  }

  // ---- the settings tree ----
  const byId = useMemo(() => new Map(flatten(tree).map((n) => [n.id, n])), [tree])
  const rows: TreeNodeRow[] = []
  const add = (nodes: SettingsNode[], depth: number) => {
    for (const node of nodes) {
      const dir = Boolean(node.children)
      const expanded = dir && isOpen(node.id)
      rows.push({ path: node.id, dir, depth, expanded, label: node.label })
      if (expanded) add(node.children!, depth + 1)
    }
  }
  add(tree, 0)
  // The selected row: the open page, or the closed group it is hidden in.
  const selected = currentPath.find((n) => n.children && !isOpen(n.id))?.id ?? current?.id

  const counts = useMemo(() => {
    const out = new Map<string, number>()
    if (searching) for (const r of results) out.set(r.groupKey, (out.get(r.groupKey) ?? 0) + 1)
    else for (const row of SETTINGS) if (row.page.section !== 'repo' && (!row.mac || mac) && (!row.windows || windows)) out.set(categoryOf(row.page.section), (out.get(categoryOf(row.page.section)) ?? 0) + 1)
    return out
  }, [searching, results, mac, windows])
  const countOf = (key: string): ReactNode => {
    const n = counts.get(key)
    if (searching) return n ? <span className="set-nav-count">{t('settings.search.found', { count: n })}</span> : null
    return n ? <span className="set-nav-count">{n}</span> : null
  }

  // ---- the repositories tree ----
  const repoRows: TreeNodeRow[] = repos.flatMap((r) => {
    const id = `repo:${r.id}`
    const expanded = isOpen(id)
    return [{ path: id, dir: true, depth: 0, expanded, label: r.name }, ...(expanded ? repoTabs.map((tab) => ({ path: `${id}/${tab}`, dir: false, depth: 1, label: t(REPO_TAB_LABELS[tab]) })) : [])]
  })
  const repoSelected = repoId ? (isOpen(`repo:${repoId}`) ? `repo:${repoId}/${currentTab}` : `repo:${repoId}`) : undefined

  return (
    <nav className="set-nav" aria-label={t('settings.nav.label')}>
      <div className="titlebar drag set-nav-top">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={13} />} title="Esc" onClick={onClose}>
          {t('common.back')}
        </Button>
      </div>
      <div className="set-nav-search">
        <Search size={14} className="set-nav-search-icon faint" aria-hidden />
        <TextInput
          ref={inputRef}
          className="set-nav-search-input"
          aria-label={t('settings.search.label')}
          placeholder={t('settings.search.placeholder')}
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Escape' && query) {
              // Clear first; the next Escape closes settings.
              e.preventDefault()
              e.stopPropagation()
              onQuery('')
            } else if (e.key === 'ArrowDown' && searching && results.length) {
              e.preventDefault()
              onResults()
            } else if (e.key === 'Enter' && searching && results.length) {
              // The best match, as the list shows it first in its group.
              e.preventDefault()
              open(results[0].target)
            }
          }}
        />
        <span className="set-nav-search-end">
          {query ? (
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
          )}
        </span>
      </div>
      <div className="set-nav-scroll">
        <Tree
          label={t('settings.nav.label')}
          className="set-nav-tree"
          rows={rows}
          onToggle={(id) => toggle(id, () => {
            const first = firstPage(byId.get(id)!)
            return first && linkTo(first)
          })}
          onOpen={(id) => open(linkTo(byId.get(id)!))}
        >
          {rows.map((row) => {
            const node = byId.get(row.path)!
            const top = row.depth === 0
            const Icon = categoryIcon(node.category as SettingsCategory)
            return (
              <TreeItem key={row.path} path={row.path} selected={row.path === selected} aria-current={row.path === current?.id ? 'page' : undefined} className="set-nav-item">
                <NavChevron dir={row.dir} open={Boolean(row.expanded)} />
                {top && <Icon size={14} aria-hidden className="set-nav-icon" />}
                <span className="set-nav-text">{row.label}</span>
                {top && countOf(node.category)}
              </TreeItem>
            )
          })}
        </Tree>
        <div className="set-nav-section" aria-hidden>
          {t('settings.nav.repositories')}
        </div>
        {repos.length > 0 ? (
          <Tree
            label={t('settings.nav.repositories')}
            className="set-nav-tree"
            rows={repoRows}
            onToggle={(id) => toggle(id, () => ({ section: 'repo', repoId: id.slice('repo:'.length), tab: repoTab(id.slice('repo:'.length)) }))}
            onOpen={(path) => {
              const [id, tab] = path.slice('repo:'.length).split('/')
              open({ section: 'repo', repoId: id, tab: tab as RepoSection })
            }}
          >
            {repoRows.map((row) => {
              const repo = row.depth === 0 ? repos.find((r) => `repo:${r.id}` === row.path) : undefined
              const here = repo ? repoId === repo.id && !row.expanded : row.path === `repo:${repoId}/${currentTab}`
              return (
                <TreeItem key={row.path} path={row.path} selected={row.path === repoSelected} aria-current={here ? 'page' : undefined} title={repo?.rootPath} className="set-nav-item">
                  <NavChevron dir={row.dir} open={Boolean(row.expanded)} />
                  {repo && <RepoAvatar repo={repo} />}
                  <span className="set-nav-text">{row.label}</span>
                  {repo && countOf(`repo:${repo.id}`)}
                </TreeItem>
              )
            })}
          </Tree>
        ) : (
          <p className="set-nav-empty">{t('common.none')}</p>
        )}
      </div>
    </nav>
  )
}

const flatten = (nodes: SettingsNode[]): SettingsNode[] => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])])

/** A group's open/closed mark (the tree says it in words: aria-expanded); a page gets the same room, empty. */
function NavChevron({ dir, open }: { dir: boolean; open: boolean }) {
  return <span className="set-nav-chevron">{dir && <ChevronRight size={12} className={open ? 'open' : undefined} aria-hidden />}</span>
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
