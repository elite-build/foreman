import { AGENT_CATALOG, catalogAgent, isAgentEnabled, type FullAgentId } from '../../../../shared/agentCatalog'
import { AGENT_ORDER, AGENTS } from '../../../../shared/agents'
import { takesInstances } from '../../../../shared/agentInstances'
import { useT } from '../../i18n'
import { CapabilitiesSection } from '../agents/CapabilityList'
import { CatalogAgentPage } from '../agents/CatalogAgentPage'
import { CatalogPage } from '../agents/CatalogPage'
import { ProviderKeysPage } from '../agents/ProviderKeysPage'
import { SignInPage } from '../agents/SignInPage'
import { openSettingsPage } from '../../store'
import { AgentIcon } from '../composer/AgentPicker'
import { RepoMcpAgentRow } from '../McpConsent'
import { AgentAccounts } from './AgentAccounts'
import { AGENT_PANELS } from './agentPanels'
import { ModelVisibility } from './ModelVisibility'
import { Tab, TabList, Tabs } from '../../ui'
import { Page, Section, useSettings } from './controls'
import './agents.css'

/**
 * Settings → Agents & models. #22: `agent` picks the page: the catalog (default), Sign-in,
 * Provider keys, a Full agent's own panel, or any other catalog agent's page.
 */
export function AgentsPage({ agent }: { agent: string }) {
  const t = useT()
  const prefs = useSettings().agentPrefs
  // The three overview pages, the Full agents, then every other enabled agent.
  const others = AGENT_CATALOG.filter((a) => a.level !== 'full' && (isAgentEnabled(a.id, prefs) || a.id === agent))
  const tabs = [
    { value: 'catalog', label: t('agentCatalog.page.title') },
    { value: 'signin', label: t('agentCatalog.signin.title') },
    { value: 'keys', label: t('agentCatalog.keys.title') },
    ...[...AGENT_ORDER.map((kind) => ({ id: kind as string, name: AGENTS[kind].label })), ...others.map((a) => ({ id: a.id, name: a.name }))].map(({ id, name }) => ({
      value: id,
      label: (
        <span className="ag-tab">
          <AgentIcon agent={id} /> {name}
        </span>
      )
    }))
  ]
  const full = (AGENT_ORDER as string[]).includes(agent) ? (agent as FullAgentId) : null
  const Panel = full ? AGENT_PANELS[full] : null
  const page = (
    <>
      <Tabs className="ag-tabs" value={agent} onChange={(next) => openSettingsPage({ section: 'agents', agent: next })}>
        <TabList label={t('agentSettings.tabs.label')}>
          {tabs.map((tab) => (
            <Tab key={tab.value} value={tab.value}>
              {tab.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>
      {/* O8: an agent that lists a chosen subset of its models keeps its own model chooser. */}
      {full && !catalogAgent(full)?.settings?.models && <ModelVisibility agent={full} />}
      {Panel && <Panel />}
      {/* docs/agents.md 2.6: what Foreman can do with this agent, from its capability record. */}
      {full && <CapabilitiesSection agent={full} name={AGENTS[full].label} />}
      {/* #130: the agent's other accounts. */}
      {full && takesInstances(full) && <AgentAccounts agent={full} />}
      {/* #20: whether this agent gets the repo's approved MCP servers. */}
      {full && (
        <Section>
          <RepoMcpAgentRow agent={full} name={AGENTS[full].label} />
        </Section>
      )}
    </>
  )
  if (agent === 'catalog') return <CatalogPage tabs={page} />
  if (agent === 'signin') return <SignInPage tabs={page} />
  if (agent === 'keys') return <ProviderKeysPage tabs={page} />
  if (!full) return <CatalogAgentPage agent={agent} tabs={page} />
  return (
    <Page title={t('agentCatalog.page.title')} description={t('agentSettings.page.description')}>
      {page}
    </Page>
  )
}
