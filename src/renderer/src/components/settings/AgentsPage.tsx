import { AGENT_CATALOG, isAgentEnabled } from '../../../../shared/agentCatalog'
import { AGENT_ORDER, AGENTS } from '../../../../shared/agents'
import type { TFunction } from '../../../../shared/i18n'
import type { AgentKind } from '../../../../shared/types'
import { useT } from '../../i18n'
import { CatalogAgentPage } from '../agents/CatalogAgentPage'
import { CatalogPage } from '../agents/CatalogPage'
import { ProviderKeysPage } from '../agents/ProviderKeysPage'
import { SignInPage } from '../agents/SignInPage'
import { isFirstLoadout, setAgentForNewWorkspaces } from '../../agentReadiness'
import { openSettingsPage, useStore } from '../../store'
import { AgentIcon } from '../composer/AgentPicker'
import { RepoMcpAgentRow } from '../McpConsent'
import { ApiKeyField, AuthCards, ConfigFileRow, ExecutablePathRow, ExternalLink, useAuthMode, type AuthOption } from './AgentAuth'
import { AgentStatusBlock, statusView, useAgentStatus } from './AgentStatusCard'
import { LoginTerminal } from './LoginTerminal'
import { ModelVisibility } from './ModelVisibility'
import { OpencodePanel } from './OpencodePanel'
import { Button, Status, Tab, TabList, Tabs } from '../../ui'
import { Page, Row, saveSettings, Section, ToggleRow, useSettings } from './controls'
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
  const full = (AGENT_ORDER as string[]).includes(agent) ? (agent as AgentKind) : null
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
      {/* O8: OpenCode keeps its own model chooser. */}
      {full && full !== 'opencode' && <ModelVisibility agent={full} />}
      {agent === 'claude' && <ClaudePanel />}
      {agent === 'codex' && <CodexPanel />}
      {agent === 'cursor' && <CursorPanel />}
      {agent === 'opencode' && <OpencodePanel />}
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

// #22: "CLI" is "Login" now, on every agent's cards.
const claudeAuth = (t: TFunction): AuthOption[] => [
  { value: 'cli', label: t('agentCatalog.method.login'), description: t('agentSettings.claude.loginDesc') },
  { value: 'apiKey', label: t('agentCatalog.method.apiKey'), description: t('agentSettings.claude.keyDesc') }
]

const codexAuth = (t: TFunction): AuthOption[] => [
  { value: 'cli', label: t('agentCatalog.method.login'), description: t('agentSettings.codex.loginDesc') },
  { value: 'apiKey', label: t('agentCatalog.method.apiKey'), description: t('agentSettings.codex.keyDesc') }
]

function ClaudePanel() {
  const t = useT()
  const settings = useSettings()
  const hint = useStore((s) => s.snapshot!.agentKeys.ANTHROPIC_API_KEY)
  const auth = useAuthMode('claude')
  // Check again whenever something that changes the answer changes.
  const state = useAgentStatus('claude', [auth.saved, hint ?? '', settings.claudeExecutablePath].join('\n'))
  const view = statusView('claude', state, auth.mode, hint !== undefined, t)

  return (
    <Section>
      <Row id="agent-claude" label={t('agentCatalog.agent.auth')} help={t('agentCatalog.agent.authHelp', { agent: 'Claude Code' })} stacked>
        <div className="ag-auth">
          <AuthCards value={auth.mode} options={claudeAuth(t)} onChange={(mode) => void auth.select(mode)} />
          <AgentStatusBlock state={state} view={view} />
          {auth.mode === 'apiKey' ? (
            <ApiKeyField agent="claude" label={t('agentCatalog.agent.keyLabel', { agent: 'Anthropic' })} keyUrl="https://console.anthropic.com/settings/keys" />
          ) : (
            <LoginTerminal
              command="claude-login"
              commandLabel="claude auth login"
              buttonLabel={view?.connected ? t('agentCatalog.agent.signInAgain') : t('agentCatalog.signin.signIn')}
              primary={view !== null && !view.connected}
              onDone={() => void state.refresh()}
            />
          )}
        </div>
      </Row>
      <ToggleRow
        id="chrome-mode"
        label={t('settings.row.chromeMode')}
        help={
          <>
            {t.rich('agentSettings.chrome.help', { docs: <ExternalLink key="docs" href="https://code.claude.com/docs/en/chrome">{t('agentSettings.chrome.docs')}</ExternalLink> })}
          </>
        }
        checked={settings.chromeMode}
        onChange={(chromeMode) => void saveSettings({ chromeMode })}
      />
      {view?.connected && <UseForNewRow agent="claude" />}
      <ExecutablePathRow setting="claudeExecutablePath" binary="claude" name="Claude Code" />
      <ConfigFileRow label={t('agentSettings.claude.config')} segments={['.claude', 'settings.json']} />
    </Section>
  )
}

function CodexPanel() {
  const t = useT()
  const settings = useSettings()
  const hint = useStore((s) => s.snapshot!.agentKeys.CODEX_API_KEY)
  const auth = useAuthMode('codex')
  const state = useAgentStatus('codex', [auth.saved, hint ?? '', settings.codexExecutablePath].join('\n'))
  const view = statusView('codex', state, auth.mode, hint !== undefined, t)

  return (
    <Section>
      <Row id="agent-codex" label={t('agentCatalog.agent.auth')} help={t('agentCatalog.agent.authHelp', { agent: 'Codex' })} stacked>
        <div className="ag-auth">
          <AuthCards value={auth.mode} options={codexAuth(t)} onChange={(mode) => void auth.select(mode)} />
          <AgentStatusBlock state={state} view={view} />
          {auth.mode === 'apiKey' ? (
            <ApiKeyField agent="codex" label={t('agentCatalog.agent.keyLabel', { agent: 'OpenAI' })} keyUrl="https://platform.openai.com/api-keys" />
          ) : (
            <LoginTerminal
              command="codex-login"
              commandLabel="codex login"
              buttonLabel={view?.connected ? t('agentCatalog.agent.signInAgain') : t('agentCatalog.signin.signIn')}
              primary={view !== null && !view.connected}
              onDone={() => void state.refresh()}
            />
          )}
        </div>
      </Row>
      {view?.connected && <UseForNewRow agent="codex" />}
      <ExecutablePathRow setting="codexExecutablePath" binary="codex" name="Codex" />
      <ConfigFileRow label={t('agentSettings.codex.config')} segments={['.codex', 'config.toml']} />
    </Section>
  )
}

function CursorPanel() {
  const t = useT()
  const saved = useStore((s) => s.snapshot!.agentKeys.CURSOR_API_KEY !== undefined)
  return (
    <Section>
      <Row
        id="agent-cursor"
        label={t('agentCatalog.method.apiKey')}
        help={saved ? t('agentSettings.cursor.saved') : t('agentSettings.cursor.none')}
      >
        <ExternalLink href="https://cursor.com/dashboard/api?section=user-keys#user-api-keys" look="button">
          {t('agentSettings.getKey')}
        </ExternalLink>
      </Row>
      <div className="set-pad">
        <ApiKeyField agent="cursor" label={t('agentCatalog.agent.keyLabel', { agent: 'Cursor' })} />
      </div>
      {saved && <UseForNewRow agent="cursor" />}
    </Section>
  )
}

/** "Use for new workspaces" on a signed-in agent: moves its first loadout to the top, which is where new workspaces start. */
function UseForNewRow({ agent }: { agent: AgentKind }) {
  const t = useT()
  const loadouts = useSettings().loadouts
  if (!loadouts.some((l) => l.agent === agent)) return null
  const name = AGENTS[agent].label
  return (
    <Row label={t('agentSettings.useForNew.label')} help={t('agentSettings.useForNew.help', { agent: name })}>
      {isFirstLoadout(loadouts, agent) ? (
        <Status tone="ok" label={t('agentSettings.useForNew.current', { agent: name })} />
      ) : (
        <Button size="sm" onClick={() => void setAgentForNewWorkspaces(agent)}>
          {t('agentSettings.useForNew.button', { agent: name })}
        </Button>
      )}
    </Row>
  )
}
