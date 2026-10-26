// A repository's settings. The settings nav picks the tab; this renders the
// repository header and that tab's rows (Settings shows settings.toml errors).
import type { ReactNode } from 'react'
import type { PlainKey } from '../../../../shared/i18n'
import { useT } from '../../i18n'
import { useStore, type RepoSection } from '../../store'
import { Page } from './controls'
import { EnvironmentPage } from './EnvironmentPage'
import { REPO_TAB_LABELS } from './registry'
import { ActionsTab } from './RepoActionsTab'
import { GitTab } from './RepoGitTab'
import { RepoIconView } from './RepoIcon'
import { RepoIntegrationsTab } from './integrations/RepoIntegrationsTab'
import { MiscTab } from './RepoMiscTab'
import { ScriptsTab } from './RepoScriptsTab'
import { RepoCloudTab } from './RepoCloudTab'
import './repo.css'

const DESCRIPTIONS: Record<Exclude<RepoSection, 'environment'>, PlainKey> = {
  git: 'repoSettings.page.git',
  integrations: 'repoSettings.page.integrations',
  scripts: 'repoSettings.page.scripts',
  actions: 'repoSettings.page.actions',
  cloud: 'repoSettings.page.cloud',
  misc: 'repoSettings.page.misc'
}

export function RepoPage({ repoId, tab }: { repoId: string; tab: RepoSection }) {
  const t = useT()
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === repoId))
  const resolved = useStore((s) => s.snapshot!.repoSettings[repoId])
  // Removed (or not loaded yet): the tabs below need both.
  if (!repo || !resolved) return <Page title={t('repoSettings.notFound.title')} description={t('repoSettings.notFound.desc')} />

  let content: ReactNode
  switch (tab) {
    case 'git':
      content = <GitTab repo={repo} />
      break
    case 'environment':
      content = <EnvironmentPage scope={{ kind: 'repo', repoId }} />
      break
    case 'integrations':
      content = <RepoIntegrationsTab repo={repo} />
      break
    case 'scripts':
      content = <ScriptsTab repo={repo} />
      break
    case 'actions':
      content = <ActionsTab repo={repo} />
      break
    case 'misc':
      content = <MiscTab repo={repo} />
      break
    case 'cloud':
      content = <RepoCloudTab repo={repo} />
      break
  }

  return (
    <div className="repo-page">
      <div className="repo-eyebrow" title={repo.rootPath}>
        <span className="repo-eyebrow-icon">
          <RepoIconView icon={repo.icon} name={repo.name} size={14} />
        </span>
        <span className="repo-eyebrow-name">{repo.name}</span>
      </div>
      {tab === 'environment' ? (
        content
      ) : (
        <Page title={t(REPO_TAB_LABELS[tab])} description={t(DESCRIPTIONS[tab])}>
          {content}
        </Page>
      )}
    </div>
  )
}
