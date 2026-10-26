// Settings → Agents → OpenCode.
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { PROVIDER_KEYS } from '../../../../shared/providers'
import type { OpencodeProvider } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, useStore } from '../../store'
import { AgentIcon } from '../composer/AgentPicker'
import { Button, Disclosure, Spinner, Tag } from '../../ui'
import { ExecutablePathRow, ExternalLink } from './AgentAuth'
import { useAgentStatus, type AgentStatusState } from './AgentStatusCard'
import { Row, rowDomId, Section, useSettings } from './controls'
import { OpencodeModelsDialog } from './OpencodeModels'
import { providerSource, ProvidersDialog } from './OpencodeProviders'

const DOCS = 'https://opencode.ai/docs'

export function OpencodePanel() {
  const t = useT()
  const settings = useSettings()
  const state = useAgentStatus('opencode', settings.opencodeExecutablePath, true)
  const { status } = state

  if (!status && !state.error) {
    return (
      <div className="ag-oc-empty" id={rowDomId('agent-opencode')}>
        <Spinner size={16} />
        <span className="muted">{t('agentCatalog.page.checking')}</span>
      </div>
    )
  }

  if (!status?.installed) {
    return (
      <>
        <div className="ag-oc-empty" id={rowDomId('agent-opencode')}>
          <span className="ag-oc-mark">
            <AgentIcon agent="opencode" size={28} />
          </span>
          <div className="ag-oc-title">OpenCode</div>
          <p className="ag-oc-tagline">{t('opencode.tagline')}</p>
          <div className="ag-oc-actions">
            <ExternalLink href={DOCS} look="primary">
              {t('opencode.install')}
            </ExternalLink>
            <Button size="sm" icon={state.loading ? <Spinner size={12} /> : <RefreshCw size={12} />} disabled={state.loading} onClick={() => void state.refresh()}>
              {t('agentCatalog.agent.checkAgain')}
            </Button>
          </div>
          <p className="ag-oc-hint">{state.error ?? t('opencode.installHint')}</p>
        </div>
        <Advanced state={state} initiallyOpen />
      </>
    )
  }

  return <InstalledPanel state={state} />
}

function InstalledPanel({ state }: { state: AgentStatusState }) {
  const t = useT()
  const settings = useSettings()
  const agentKeys = useStore((s) => s.snapshot!.agentKeys)
  const [providers, setProviders] = useState<OpencodeProvider[] | null>(null)
  const [dialog, setDialog] = useState<'providers' | 'models' | null>(null)

  const loadProviders = useCallback(async () => {
    const list = await api.opencodeProviders().catch(() => null)
    if (list) setProviders(list)
  }, [])
  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

  const configured = PROVIDER_KEYS.filter((p) => providerSource(p.envVar, providers, agentKeys))
  const modelCount = settings.opencodeModels.length
  const closeDialog = useCallback(() => setDialog(null), [])

  return (
    <>
      <div className="ag-oc-head">
        <span className="ag-oc-mark small">
          <AgentIcon agent="opencode" size={20} />
        </span>
        <div className="ag-oc-head-text">
          <div className="ag-oc-title">OpenCode</div>
          <div className="ag-oc-tagline">{t('opencode.tagline')}</div>
        </div>
        <span className="spacer" />
        <ExternalLink href={DOCS}>{t('agentCatalog.agent.docs')}</ExternalLink>
      </div>

      <Section>
        <Row
          id="agent-opencode"
          label={
            <>
              {t('opencode.providers.label')} <span className="ag-count">{providers ? t('opencode.providers.count', { count: configured.length }) : t('opencode.providers.countLoading')}</span>
            </>
          }
          help={configured.length ? configured.map((p) => p.label).join(', ') : t('opencode.providers.help')}
        >
          <Button size="sm" variant={providers && configured.length === 0 ? 'primary' : 'default'} onClick={() => setDialog('providers')}>
            {providers && configured.length === 0 ? t('opencode.providers.addFirst') : t('opencode.configure')}
          </Button>
        </Row>
        <Row
          label={
            <>
              {t('opencode.models.label')} <span className="ag-count">{t('opencode.models.count', { count: modelCount })}</span>
            </>
          }
          help={t('opencode.models.help')}
        >
          <Button size="sm" variant={modelCount === 0 ? 'primary' : 'default'} onClick={() => setDialog('models')}>
            {modelCount === 0 ? t('opencode.models.addFirst') : t('opencode.configure')}
          </Button>
        </Row>
      </Section>

      <Advanced state={state} initiallyOpen={Boolean(settings.opencodeExecutablePath)} />

      {dialog === 'providers' && <ProvidersDialog providers={providers} onChanged={loadProviders} onClose={closeDialog} />}
      {dialog === 'models' && <OpencodeModelsDialog onClose={closeDialog} />}
    </>
  )
}

function Advanced({ state, initiallyOpen }: { state: AgentStatusState; initiallyOpen: boolean }) {
  const t = useT()
  const { status, loading, refresh } = state
  return (
    <Section plain>
      <div className="set-card">
        <Disclosure className="ag-details" label={t('opencode.advanced')} defaultOpen={initiallyOpen}>
          <div className="ag-details-body">
            <Row label={t('opencode.status')} help={status?.installed ? undefined : status?.detail}>
              <Tag tone={status?.installed ? 'ok' : 'error'}>
                {status?.installed ? (status.version ? t('opencode.installedVersion', { version: status.version }) : t('opencode.installed')) : t('opencode.missing')}
              </Tag>
              <Button size="sm" variant="ghost" icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />} disabled={loading} onClick={() => void refresh()}>
                {t('common.refresh')}
              </Button>
            </Row>
            <ExecutablePathRow
              setting="opencodeExecutablePath"
              binary="opencode"
              name="OpenCode"
              help={t('opencode.path.help')}
              placeholder={t('opencode.path.onPath')}
              fallback={t('opencode.path.onPath')}
            />
          </div>
        </Disclosure>
      </div>
    </Section>
  )
}
