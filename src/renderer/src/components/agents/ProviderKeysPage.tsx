// #22: Settings → Agents & models → Provider keys. The provider list and
// encrypted store OpenCode's Providers dialog uses, shared: each key has an
// "Allowed agents" row, and an agent gets only the keys ticked for it. OpenCode
// reads every key, so its box is locked on. Keys in the shell can be imported,
// ticked for no one; import never replaces a saved key.
import { Check, Download, Lock, Plus } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AGENT_CATALOG, allowedProviderKeys, isAgentEnabled, keyAgents, takesSharedKeys, toggleKeyAgent } from '../../../../shared/agentCatalog'
import { providerInfo } from '../../../../shared/providers'
import type { OpencodeProvider } from '../../../../shared/types'
import { loadAgentCatalog, useAgentCatalog } from '../../agentCatalog'
import { useT } from '../../i18n'
import { api, showToast } from '../../store'
import { AgentIcon } from '../composer/AgentPicker'
import { Button, Callout, Card, Checkbox, Tag } from '../../ui'
import { ProvidersDialog } from '../settings/OpencodeProviders'
import { MaskedValue, Page, saveSettings, useSettings } from '../settings/controls'
import { agentName, SearchField } from './catalogShared'
import './catalog.css'

export function ProviderKeysPage({ tabs }: { tabs: ReactNode }) {
  const t = useT()
  const settings = useSettings()
  const allow = settings.providerKeyAgents
  const { view } = useAgentCatalog()
  const [providers, setProviders] = useState<OpencodeProvider[] | null>(null)
  const [dialog, setDialog] = useState(false)
  const [query, setQuery] = useState('')

  const reload = useCallback(async () => {
    setProviders(await api.opencodeProviders().catch(() => []))
    void loadAgentCatalog(false)
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])

  const saved = (providers ?? []).filter((p) => p.saved).map((p) => p.envVar)
  const q = query.trim().toLowerCase()
  const matches = (envVar: string) => !q || envVar.toLowerCase().includes(q) || providerInfo(envVar).label.toLowerCase().includes(q)
  const inShell = (view?.shellProviderKeys ?? []).filter((v) => !saved.includes(v) && matches(v))
  // G1: every agent that can take shared keys, enabled or not; disabled ones are dimmed (a tick only matters once it's enabled).
  const ticked = new Set(Object.values(allow ?? {}).flat())
  const sharers = AGENT_CATALOG.filter((a) => a.id !== 'opencode' && takesSharedKeys(a.id))
  const enabled = (id: string) => isAgentEnabled(id, settings.agentPrefs)

  const toggle = (envVar: string, id: string, on: boolean) => void saveSettings({ providerKeyAgents: toggleKeyAgent(allow, envVar, id, on) })

  const importKey = async (envVar: string) => {
    const done = await api.importProviderKey(envVar).catch(() => false)
    showToast(done ? t('agentCatalog.key.imported', { name: envVar }) : t('agentCatalog.key.notImported'))
    await reload()
  }

  const savedMap = Object.fromEntries(saved.map((k) => [k, 'x']))

  return (
    <Page title={t('agentCatalog.keys.title')} description={t('agentCatalog.keys.description')}>
      {tabs}
      <Callout tone="info" className="cat-keys-banner">
        <strong>{t('agentCatalog.keys.bannerTitle')}</strong> {t('agentCatalog.keys.banner')}
      </Callout>
      <div className="cat-toolbar">
        <SearchField className="cat-search" aria-label={t('agentCatalog.keys.search')} placeholder={t('agentCatalog.keys.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button size="sm" icon={<Plus size={12} />} onClick={() => setDialog(true)}>
          {t('agentCatalog.keys.add')}
        </Button>
      </div>
      <Card className="cat-rows">
        {providers && !saved.length && !inShell.length && <p className="faint small pk-empty">{t('agentCatalog.keys.none')}</p>}
        {saved.filter(matches).map((envVar) => {
          const agents = keyAgents(envVar, allow)
          return (
            <div key={envVar} className="pk-row">
              <div className="pk-head">
                <strong>{providerInfo(envVar).label}</strong>
                <Check size={13} className="ag-ok" aria-label={t('agentCatalog.keys.saved')} />
                <Tag tone="outline" mono>{envVar}</Tag>
                <span className="spacer" />
                {/* G1: Reveal and Copy, like an agent's own key. */}
                <MaskedValue label={envVar} hint={view?.providerKeyHints?.[envVar]} reveal={() => api.revealProviderKey(envVar)} />
                <span className="faint small">{t('agentCatalog.keys.agentCount', { count: agents.length })}</span>
              </div>
              <div className="pk-allowed small">
                <span className="faint">{t('agentCatalog.keys.allowed')}</span>
                <Checkbox title={t('agentCatalog.keys.opencodeLocked')} checked disabled>
                  <span className="pk-check-text locked">
                    OpenCode <Lock size={10} aria-hidden />
                  </span>
                </Checkbox>
                {sharers.map((a) => (
                  <Checkbox
                    key={a.id}
                    title={enabled(a.id) ? undefined : t('g1.keys.disabledAgent', { agent: a.name })}
                    checked={agents.includes(a.id)}
                    onChange={(e) => toggle(envVar, a.id, e.target.checked)}
                  >
                    <span className={enabled(a.id) ? 'pk-check-text' : 'pk-check-text off'}>{a.name}</span>
                  </Checkbox>
                ))}
              </div>
            </div>
          )
        })}
        {inShell.map((envVar) => (
          <div key={envVar} className="pk-row pk-shell">
            <div className="pk-head">
              <strong>{providerInfo(envVar).label}</strong>
              <Tag tone="outline" mono>{envVar}</Tag>
              <span className="spacer" />
              <span className="faint small">{t('agentCatalog.keys.foundInShell')}</span>
              <Button size="sm" icon={<Download size={12} />} onClick={() => void importKey(envVar)}>
                {t('agentCatalog.key.import')}
              </Button>
            </div>
          </div>
        ))}
      </Card>
      {sharers.length > 0 && (
        <section className="cat-group">
          <header className="cat-group-head">
            <strong>{t('agentCatalog.keys.byAgent')}</strong>
          </header>
          <Card className="cat-rows">
            {sharers.filter((a) => enabled(a.id) || ticked.has(a.id)).map((a) => {
              const keys = Object.keys(allowedProviderKeys(a.id, savedMap, allow))
              return (
                <div key={a.id} className="pk-agent">
                  <span className="pk-agent-name">
                    <AgentIcon agent={a.id} /> {agentName(a.id)}
                  </span>
                  <span className="pk-agent-keys small">
                    {keys.length ? keys.map((k) => <Tag key={k} tone="outline">{providerInfo(k).label}</Tag>) : <span className="faint">{t('agentCatalog.keys.noneTicked', { agent: a.name })}</span>}
                  </span>
                  <span className="faint small">{t('agentCatalog.keys.keyCount', { count: keys.length })}</span>
                </div>
              )
            })}
          </Card>
        </section>
      )}
      {dialog && <ProvidersDialog providers={providers} onChanged={reload} onClose={() => setDialog(false)} />}
    </Page>
  )
}
