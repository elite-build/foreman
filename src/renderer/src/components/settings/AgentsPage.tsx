import type { FullAgentId } from '../../../../shared/agentCatalog'
import { AGENT_ORDER, AGENTS } from '../../../../shared/agents'
import { takesInstances } from '../../../../shared/agentInstances'
import { useT } from '../../i18n'
import { CapabilitiesSection } from '../agents/CapabilityList'
import { CatalogAgentPage } from '../agents/CatalogAgentPage'
import { CatalogPage } from '../agents/CatalogPage'
import { ProviderKeysPage } from '../agents/ProviderKeysPage'
import { SignInPage } from '../agents/SignInPage'
import { RepoMcpAgentRow } from '../McpConsent'
import { AgentAccounts } from './AgentAccounts'
import { AGENT_PANELS } from './agentPanels'
import { ModelVisibility } from './ModelVisibility'
import { Page, Part, Section } from './controls'
import { agentParts } from './pages'
import './agents.css'

/**
 * Settings → Agents & models. #22: `agent` picks the page: the catalog (default), Sign-in, Provider keys, a Full agent's
 * own page, or any other catalog agent's page. The settings menu lists them (pages.ts), so there is no tab bar; a Full
 * agent's page is in parts (sign-in, accounts, models, capabilities, repo MCP servers), each a menu entry of its own.
 */
export function AgentsPage({ agent }: { agent: string }) {
  const t = useT()
  if (agent === 'catalog') return <CatalogPage tabs={null} />
  if (agent === 'signin') return <SignInPage tabs={null} />
  if (agent === 'keys') return <ProviderKeysPage tabs={null} />
  if (!(AGENT_ORDER as string[]).includes(agent)) return <CatalogAgentPage agent={agent} tabs={null} />
  const full = agent as FullAgentId
  const Panel = AGENT_PANELS[full]
  const name = AGENTS[full].label
  const parts = agentParts(full)
  return (
    <Page title={name} description={t('agentSettings.page.description')}>
      <Part id="signin">
        <Panel />
      </Part>
      {/* #130: the agent's other accounts. */}
      {takesInstances(full) && (
        <Part id="accounts" lead>
          <AgentAccounts agent={full} />
        </Part>
      )}
      {/* O8: an agent that lists a chosen subset of its models keeps its own model chooser. */}
      {parts.includes('models') && (
        <Part id="models" lead>
          <ModelVisibility agent={full} />
        </Part>
      )}
      {/* docs/agents.md 2.6: what Foreman can do with this agent, from its capability record. */}
      <Part id="capabilities" lead>
        <CapabilitiesSection agent={full} name={name} />
      </Part>
      {/* #20: whether this agent gets the repo's approved MCP servers. */}
      <Section part="mcp">
        <RepoMcpAgentRow agent={full} name={name} />
      </Section>
    </Page>
  )
}
