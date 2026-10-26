import { ArrowLeft, ChevronRight, FileCode } from 'lucide-react'
import { Fragment, useEffect, useRef } from 'react'
import type { EnvScope } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, openAssistant, openSettingsPage, useStore, type PersonalSection, type RepoSection, type SettingsPage } from '../../store'
import { Button, Callout, flash } from '../../ui'
import { AccountPage } from './AccountPage'
import { AdvancedPage } from './AdvancedPage'
import { DataPage } from './DataPage'
import { UsagePage } from './UsagePage'
import { AgentsPage } from './AgentsPage'
import { AccessibilityPage } from './AccessibilityPage'
import { AppearancePage } from './AppearancePage'
import { rowDomId, SavedHint } from './controls'
import { EnvironmentPage } from './EnvironmentPage'
import { settingFlashParts } from './flashParts'
import { ExperimentalPage } from './ExperimentalPage'
import { CloudPage } from './CloudPage'
import { GeneralPage } from './GeneralPage'
import { GitPage } from './GitPage'
import { IntegrationsPage } from './integrations/IntegrationsPage'
import { ModelsPage } from './ModelsPage'
import { CATEGORIES, categoryOf, REPO_TAB_LABELS, type SettingsCategory } from './registry'
import { RepoPage } from './RepoPage'
import { SettingsNav } from './SettingsNav'
import './settings.css'

const DEFAULT_REPO_TAB: RepoSection = 'environment'
const USER_ENV: EnvScope = { kind: 'user' }

// The section last viewed per repository, so clicking a repo goes back to it.
const lastRepoTab = new Map<string, RepoSection>()

const close = () => openSettingsPage(null)
const repoTab = (repoId: string, tab?: RepoSection) => tab ?? lastRepoTab.get(repoId) ?? DEFAULT_REPO_TAB

/** Full-height settings page: the menu on the left, a category's or repository section's page on the right. Covers the workspace area of `.main`. */
export function SettingsView({ page }: { page: SettingsPage }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const repoSettings = useStore((s) => s.snapshot!.repoSettings)
  // Opened from the assistant's "Show in Settings": one click back to the conversation.
  const fromAssistant = useStore((s) => s.assistantReturn)
  const scroller = useRef<HTMLDivElement>(null)
  const repo = page.section === 'repo' ? repos.find((r) => r.id === page.repoId) : undefined
  const tab = page.section === 'repo' ? repoTab(page.repoId, page.tab) : undefined
  const category = page.section === 'repo' ? null : categoryOf(page.section)
  const pageKey = page.section === 'repo' ? `repo:${page.repoId}:${tab}` : page.section === 'agents' ? `agents:${page.agent ?? ''}` : category

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
    if (page.section === 'repo' && !repo) openSettingsPage({ section: 'general' })
  }, [page, repo])

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [pageKey])

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
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
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

  return (
    <div className="settings-view">
      <SettingsNav page={page} repoTab={(id) => repoTab(id)} onClose={close} />
      <div className="set-main">
        <header className="titlebar drag set-header">
          <div className="set-crumbs">
            <span className="muted">{t('settings.nav.label')}</span>
            <ChevronRight size={13} className="faint" />
            {repo && tab ? (
              <>
                <span className="muted set-crumb-repo">{repo.name}</span>
                <ChevronRight size={13} className="faint" />
                <span className="set-crumb-current">{t(REPO_TAB_LABELS[tab])}</span>
              </>
            ) : (
              <span className="set-crumb-current">{category && t(CATEGORIES.find((c) => c.id === category)!.label)}</span>
            )}
          </div>
          <div className="set-header-actions">
            {fromAssistant && (
              <Button size="sm" icon={<ArrowLeft size={13} />} onClick={openAssistant}>
                {t('assistant.back')}
              </Button>
            )}
            <SavedHint />
            {repo && (
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
            {sharedError && (
              <Callout tone="warn" role="alert" className="set-shared-error">
                <div>{sharedError}</div>
                <div className="set-banner-sub">{t('settings.header.sharedErrorNote')}</div>
              </Callout>
            )}
            {repo && tab ? <RepoPage key={repo.id} repoId={repo.id} tab={tab} /> : category && <CategoryContent category={category} page={page} />}
          </div>
        </div>
      </div>
    </div>
  )
}

/** A category's pages, one after another. */
function CategoryContent({ category, page }: { category: SettingsCategory; page: SettingsPage }) {
  const pages = CATEGORIES.find((c) => c.id === category)!.pages
  return (
    <>
      {pages.map((section, n) => (
        <Fragment key={section}>
          {n > 0 && <hr className="set-page-sep" />}
          <SectionPage section={section} page={page} />
        </Fragment>
      ))}
    </>
  )
}

function SectionPage({ section, page }: { section: PersonalSection | 'agents'; page: SettingsPage }) {
  switch (section) {
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
      return <AgentsPage agent={(page.section === 'agents' && page.agent) || 'catalog'} />
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
    case 'cloud':
      return <CloudPage />
  }
}
