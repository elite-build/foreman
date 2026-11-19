import { ArrowLeft, ArrowRight, ChevronRight, FileCode } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { EnvScope } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, openAssistant, openSettingsPage, useStore, type RepoSection, type SettingsPage } from '../../store'
import { Button, Callout, flash } from '../../ui'
import { AccountPage } from './AccountPage'
import { AdvancedPage } from './AdvancedPage'
import { DataPage } from './DataPage'
import { DevicesPage } from './DevicesPage'
import { UsagePage } from './UsagePage'
import { AgentsPage } from './AgentsPage'
import { AccessibilityPage } from './AccessibilityPage'
import { AppearancePage } from './AppearancePage'
import { PartView, rowDomId, SavedHint, type PartViewValue } from './controls'
import { EnvironmentPage } from './EnvironmentPage'
import { settingFlashParts } from './flashParts'
import { ExperimentalPage } from './ExperimentalPage'
import { CloudPage } from './CloudPage'
import { GeneralPage } from './GeneralPage'
import { GitPage } from './GitPage'
import { IntegrationsPage } from './integrations/IntegrationsPage'
import { ModelsPage } from './ModelsPage'
import { linkTo, pageNode, pageNodes, pathTo, type PageRef, type SettingsNode } from './pages'
import { REPO_TAB_LABELS } from './registry'
import { QuickPage } from './QuickTiles'
import { RepoPage } from './RepoPage'
import { SearchResults } from './SearchResults'
import { buildIndex, search } from './searchIndex'
import { SpacesPage } from './SpacesPage'
import { SettingsNav, useSettingsTree } from './SettingsNav'
import './settings.css'

const DEFAULT_REPO_TAB: RepoSection = 'environment'
const USER_ENV: EnvScope = { kind: 'user' }

// The section last viewed per repository, so clicking a repo goes back to it.
const lastRepoTab = new Map<string, RepoSection>()

const close = () => openSettingsPage(null)
const repoTab = (repoId: string, tab?: RepoSection) => tab ?? lastRepoTab.get(repoId) ?? DEFAULT_REPO_TAB

/**
 * Full-height settings: the menu on the left, one short page on the right (a part of a settings page, or a
 * repository's page), with Previous and Next under it; or, while searching, the results. Covers the workspace area of
 * `.main`.
 */
export function SettingsView({ page }: { page: SettingsPage }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const repoSettings = useStore((s) => s.snapshot!.repoSettings)
  const platform = useStore((s) => s.snapshot!.platform)
  const agentPrefs = useStore((s) => s.snapshot!.settings.agentPrefs)
  // Opened from the assistant's "Show in Settings": one click back to the conversation.
  const fromAssistant = useStore((s) => s.assistantReturn)
  const scroller = useRef<HTMLDivElement>(null)
  const searchBox = useRef<HTMLInputElement>(null)
  const resultList = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const tree = useSettingsTree(page)
  const repo = page.section === 'repo' ? repos.find((r) => r.id === page.repoId) : undefined
  const tab = page.section === 'repo' ? repoTab(page.repoId, page.tab) : undefined
  const node = page.section === 'repo' ? undefined : pageNode(tree, page)
  const pageKey = page.section === 'repo' ? `repo:${page.repoId}:${tab}` : node?.id

  // Search: every menu entry, setting and repository page; the results replace the page while there is a query.
  const searching = query.trim() !== ''
  const items = useMemo(() => buildIndex(repos, platform === 'darwin', t, platform, agentPrefs), [repos, platform, t, agentPrefs])
  const results = useMemo(() => search(items, query), [items, query])
  const groupOrder = useMemo(() => [...tree.map((n) => n.category), ...repos.map((r) => `repo:${r.id}`)], [tree, repos])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // The sign-in terminal may need Escape itself.
      if ((e.target as Element | null)?.closest?.('.terminal')) return
      e.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (page.section === 'repo' && tab) lastRepoTab.set(page.repoId, tab)
  }, [page, tab])

  // A removed repository's pages go away with it.
  useEffect(() => {
    if (page.section === 'repo' && !repo) openSettingsPage({ section: 'quick' })
  }, [page, repo])

  useEffect(() => {
    scroller.current?.scrollTo?.({ top: 0 })
  }, [pageKey, searching])

  // Scroll to the row search picked and flash it. Rows can appear a moment
  // after the page (when they wait for data), so look for it a few times.
  useEffect(() => {
    const target = page.scrollTo
    if (!target) return
    let tries = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let unflash: (() => void) | undefined
    const find = () => {
      const row = document.getElementById(rowDomId(target))
      if (!row) {
        if (++tries < 20) retry = setTimeout(find, 50)
        return
      }
      row.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      // ui/flash: a neutral wash around the row; on a tall block, around its title and description only.
      unflash = flash(row, { parts: settingFlashParts })
    }
    const frame = requestAnimationFrame(find)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(retry)
      unflash?.()
    }
  }, [page])

  const sharedError = repo ? repoSettings[repo.id]?.sharedError : undefined
  const sharedFile = repo ? repoSettings[repo.id]?.sharedFile : undefined
  // Where you are: the menu's path to the page.
  const crumbs = searching ? [t('settings.search.crumb', { query: query.trim() })] : repo && tab ? [repo.name, t(REPO_TAB_LABELS[tab])] : node ? pathTo(tree, node.id).map((n) => n.label) : []
  const openResult = (target: SettingsPage) => {
    setQuery('')
    openSettingsPage(target)
  }

  return (
    <div className="settings-view">
      <SettingsNav
        page={page}
        repoTab={(id) => repoTab(id)}
        onClose={close}
        query={query}
        onQuery={setQuery}
        results={results}
        inputRef={searchBox}
        onResults={() => resultList.current?.querySelector<HTMLElement>('button.set-result-main')?.focus()}
      />
      <div className="set-main">
        <header className="titlebar drag set-header">
          <nav className="set-crumbs" aria-label={t('settings.crumbs.label')}>
            <span className="muted">{t('settings.nav.label')}</span>
            {crumbs.map((crumb, i) => (
              <Fragment key={i}>
                <ChevronRight size={13} className="faint" aria-hidden />
                <span className={i === crumbs.length - 1 ? 'set-crumb-current' : 'muted set-crumb-repo'} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
                  {crumb}
                </span>
              </Fragment>
            ))}
          </nav>
          <div className="set-header-actions">
            {fromAssistant && (
              <Button size="sm" icon={<ArrowLeft size={13} />} onClick={openAssistant}>
                {t('assistant.back')}
              </Button>
            )}
            <SavedHint />
            {repo && !searching && (
              <Button
                size="sm"
                icon={<FileCode size={13} />}
                title={sharedFile ?? t('settings.header.openSettingsFileHint')}
                onClick={() => void attempt(() => api.openRepoSettingsFile(repo.id))}
              >
                {t('settings.header.openSettingsFile')}
              </Button>
            )}
          </div>
        </header>

        <div className="set-scroll" ref={scroller}>
          <div className="set-content">
            {searching ? (
              <SearchResults
                query={query}
                results={results}
                order={groupOrder}
                onOpen={openResult}
                onExit={(clear) => {
                  if (clear) setQuery('')
                  searchBox.current?.focus()
                }}
                listRef={resultList}
              />
            ) : (
              <>
                {sharedError && (
                  <Callout tone="warn" role="alert" className="set-shared-error">
                    <div>{sharedError}</div>
                    <div className="set-banner-sub">{t('settings.header.sharedErrorNote')}</div>
                  </Callout>
                )}
                {repo && tab ? <RepoPage key={repo.id} repoId={repo.id} tab={tab} /> : node && <PartPage tree={tree} node={node} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** One page of the menu: its part of a settings page, then Previous and Next. */
function PartPage({ tree, node }: { tree: SettingsNode[]; node: SettingsNode }) {
  const t = useT()
  const all = pageNodes(tree)
  const at = all.findIndex((n) => n.id === node.id)
  const previous = at > 0 ? all[at - 1] : undefined
  const next = at >= 0 ? all[at + 1] : undefined
  const ref = node.page!
  const first = all.find((n) => n.page!.section === ref.section && n.page!.agent === ref.agent) === node
  const view: PartViewValue | null = ref.part ? { part: ref.part, title: node.title, first } : null
  return (
    <>
      <PartView value={view}>
        <SectionPage page={ref} />
      </PartView>
      {(previous || next) && (
        <nav className="set-pager" aria-label={t('settings.pager.label')}>
          {previous ? (
            <Button icon={<ArrowLeft size={13} />} onClick={() => openSettingsPage(linkTo(previous))}>
              <span className="muted">{t('settings.pager.previous')}</span> {previous.label}
            </Button>
          ) : (
            <span />
          )}
          {next && (
            <Button onClick={() => openSettingsPage(linkTo(next))}>
              <span className="muted">{t('settings.pager.next')}</span> {next.label} <ArrowRight size={13} aria-hidden />
            </Button>
          )}
        </nav>
      )}
    </>
  )
}

function SectionPage({ page }: { page: PageRef }) {
  switch (page.section) {
    case 'quick':
      return <QuickPage />
    case 'general':
      return <GeneralPage />
    case 'account':
      return <AccountPage />
    case 'integrations':
      return <IntegrationsPage />
    case 'appearance':
      return <AppearancePage />
    case 'accessibility':
      return <AccessibilityPage />
    case 'models':
      return <ModelsPage />
    case 'git':
      return <GitPage />
    case 'agents':
      // #22: the catalog is the Agents page's front page.
      return <AgentsPage agent={page.agent || 'catalog'} />
    case 'environment':
      return <EnvironmentPage scope={USER_ENV} />
    case 'experimental':
      return <ExperimentalPage />
    case 'advanced':
      return <AdvancedPage />
    case 'usage':
      return <UsagePage />
    case 'data':
      return <DataPage />
    case 'devices':
      return <DevicesPage />
    case 'cloud':
      return <CloudPage />
    case 'spaces':
      return <SpacesPage />
  }
}
