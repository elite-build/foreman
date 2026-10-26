// #22: Settings → Agents & models → Agents: every agent Foreman can run, in three
// honest levels. Installed state is checked (PATH, --version), not assumed;
// enabling an agent only adds it to the picker; Foreman never installs anything.
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { AGENT_CATALOG, filterCatalog, isAgentEnabled, LEVELS, type CatalogAgent, type CatalogFilter, type IntegrationLevel } from '../../../../shared/agentCatalog'
import type { PlainKey } from '../../../../shared/i18n'
import { useAgentCatalog } from '../../agentCatalog'
import { useT } from '../../i18n'
import { openSettingsPage, timeAgo } from '../../store'
import { AgentIcon } from '../composer/AgentPicker'
import { ActionRow, Button, Callout, Card, LinkButton, Pressable, Segmented, Spinner, Status, Tag } from '../../ui'
import { ExternalLink } from '../settings/AgentAuth'
import { Page, useSettings } from '../settings/controls'
import { CapabilityChips, EnableSwitch, LevelLegend, SearchField, signInStatusTone, signInText, useSignIn } from './catalogShared'
import { LEVEL_LABEL } from './PickerAgents'
import './catalog.css'

const GROUP_NOTE: Record<IntegrationLevel, PlainKey> = {
  full: 'agentCatalog.group.fullNote',
  chat: 'agentCatalog.group.chatNote',
  terminal: 'agentCatalog.group.terminalNote'
}

// Rows a group shows before "Show N more" (enabled and installed agents always show).
const FOLD_AT = 4

export function CatalogPage({ tabs }: { tabs: ReactNode }) {
  const t = useT()
  const { view, loading, error, refresh } = useAgentCatalog()
  const prefs = useSettings().agentPrefs
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CatalogFilter>('all')
  const [open, setOpen] = useState<Set<IntegrationLevel>>(new Set())

  const enabled = (id: string) => isAgentEnabled(id, prefs)
  const installed = (id: string) => Boolean(view?.detections[id]?.installed)
  const count = (f: CatalogFilter) => filterCatalog(AGENT_CATALOG, f, '', { enabled, installed }).length
  const shown = filterCatalog(AGENT_CATALOG, filter, query, { enabled, installed })
  const folding = filter === 'all' && !query.trim()

  const filters: { value: CatalogFilter; label: PlainKey }[] = [
    { value: 'all', label: 'agentCatalog.filter.all' },
    { value: 'enabled', label: 'agentCatalog.filter.enabled' },
    { value: 'installed', label: 'agentCatalog.filter.installed' },
    { value: 'chat', label: 'agentCatalog.filter.chat' },
    { value: 'terminal', label: 'agentCatalog.filter.terminal' }
  ]

  return (
    <Page title={t('agentCatalog.page.title')} description={t('agentCatalog.page.description')}>
      {tabs}
      <div className="cat-checked">
        <span className="faint small">
          {loading ? t('agentCatalog.page.checking') : view?.checkedAt ? t('agentCatalog.page.checkedAgo', { ago: timeAgo(view.checkedAt) }) : ''}
        </span>
        <Button size="sm" icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />} disabled={loading} onClick={() => void refresh()}>
          {t('agentCatalog.page.checkAgain')}
        </Button>
      </div>
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
      <LevelLegend />
      <div className="cat-toolbar">
        <SearchField
          className="cat-search"
          aria-label={t('agentCatalog.page.search', { count: AGENT_CATALOG.length })}
          placeholder={t('agentCatalog.page.search', { count: AGENT_CATALOG.length })}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Segmented
          plain
          small
          label={t('agentCatalog.filter.label')}
          value={filter}
          options={filters.map((f) => ({
            value: f.value,
            label: (
              <>
                {t(f.label)} <span className="faint">{count(f.value)}</span>
              </>
            )
          }))}
          onChange={setFilter}
        />
      </div>
      {LEVELS.map((level) => {
        const rows = shown.filter((a) => a.level === level)
        if (!rows.length) return null
        const all = AGENT_CATALOG.filter((a) => a.level === level)
        const on = all.filter((a) => enabled(a.id)).length
        let visible = rows
        let folded: CatalogAgent[] = []
        if (folding && !open.has(level)) {
          const keep = new Set(rows.filter((a) => enabled(a.id) || installed(a.id)).map((a) => a.id))
          for (const a of rows) if (keep.size < FOLD_AT) keep.add(a.id)
          visible = rows.filter((a) => keep.has(a.id))
          folded = rows.filter((a) => !keep.has(a.id))
        }
        return (
          <section key={level} className="cat-group">
            <header className="cat-group-head">
              <strong>{t(LEVEL_LABEL[level])}</strong>
              {level === 'chat' && <Tag tone="outline">ACP</Tag>}
              <span className="faint">{t('agentCatalog.group.count', { count: all.length, enabled: on })}</span>
              <span className="spacer" />
              <span className="faint small">{t(GROUP_NOTE[level])}</span>
            </header>
            <Card className="cat-rows">
              {visible.map((agent) => (
                <CatalogRow key={agent.id} agent={agent} />
              ))}
              {folded.length > 0 && (
                <ActionRow divided className="cat-more" primaryProps={{ className: 'cat-more-line' }} onPress={() => setOpen(new Set([...open, level]))}>
                  <ChevronDown size={13} aria-hidden /> <span className="small">{t('agentCatalog.group.showMore', { count: folded.length })}</span>
                  <span className="faint small cat-more-names">{folded.map((a) => a.name).join(', ')}</span>
                </ActionRow>
              )}
            </Card>
          </section>
        )
      })}
      {!shown.length && <p className="faint small">{t('agentCatalog.page.none')}</p>}
    </Page>
  )
}

function CatalogRow({ agent }: { agent: CatalogAgent }) {
  const t = useT()
  const { view } = useAgentCatalog()
  const signIn = useSignIn()
  const [showError, setShowError] = useState(false)
  const detection = view?.detections[agent.id]
  const state = signIn(agent)

  let line: ReactNode
  if (!view) line = <span className="faint">{t('agentCatalog.page.checking')}</span>
  else if (!detection?.installed) {
    line = (
      <>
        <span className="faint">{t('agentCatalog.row.notInstalled')}</span> · <ExternalLink href={agent.docsUrl}>{t('agentCatalog.row.howToInstall')}</ExternalLink>
      </>
    )
  } else if (detection.error) {
    line = (
      <>
        <Tag tone="warn">{t('agentCatalog.row.couldntStart')}</Tag> ·{' '}
        <LinkButton aria-expanded={showError} onClick={() => setShowError(!showError)}>
          {showError ? t('agentCatalog.row.hideError') : t('agentCatalog.row.showError')}
        </LinkButton>
      </>
    )
  } else if (detection.acpProgram && !detection.acpProgram.path) {
    // G1: the agent is installed, but the separate program its ACP mode needs isn't.
    line = (
      <Tag tone="warn" title={agent.acp?.installHint ? t(agent.acp.installHint) : detection.acpProgram.install}>
        {t('g1.acpProgram.missing', { name: detection.acpProgram.name })}
      </Tag>
    )
  } else {
    line = (
      <>
        {detection.version && <span className="mono">{detection.version}</span>}
        {detection.version && ' · '}
        <Status tone={signInStatusTone(state)} label={signInText(state, t)} />
      </>
    )
  }

  return (
    <div className="cat-row">
      <AgentIcon agent={agent.id} />
      <div className="cat-row-main">
        <Pressable className="cat-row-name" onClick={() => openSettingsPage({ section: 'agents', agent: agent.id })}>
          <strong className="cat-row-title">{agent.name}</strong> <ChevronRight size={12} className="faint" aria-hidden />
        </Pressable>
        <div className="cat-row-line small">{line}</div>
        {showError && detection?.error && (
          <pre className="cat-error mono small">
            $ {detection.error.command}
            {'\n'}
            {detection.error.output}
          </pre>
        )}
        {agent.acp?.source === 'docs' && <div className="faint small">{t('agentCatalog.row.unverifiedAcp', { args: agent.acp.args.join(' ') })}</div>}
      </div>
      <CapabilityChips agent={agent} />
      <EnableSwitch agent={agent} />
    </div>
  )
}
