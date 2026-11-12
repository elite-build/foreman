// Settings → Agents → a Full agent: its own panel (sign-in, key, executable, config file). A map keyed by the agent's id is data,
// not a branch on it (docs/agents.md, 2.4); the page looks its panel up here and knows no agent by name. What differs in
// words or defaults between agents comes from the catalog (`auth.cards`, `auth.apiKey`, `readiness`), not from here.
import type { ComponentType } from 'react'
import { AGENTS } from '../../../../shared/agents'
import type { FullAgentId } from '../../../../shared/agentCatalog'
import type { AgentKind } from '../../../../shared/types'
import { isFirstLoadout, setAgentForNewWorkspaces } from '../../agentReadiness'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { IDLE_COMPACT_CHOICES, choicesWith } from '../../../../shared/agentSlots'
import { formatNumber } from '../../../../shared/i18n/time'
import { Button, Select, Status } from '../../ui'
import { ApiKeyField, AuthCards, authOptions, ConfigFileRow, ExecutablePathRow, ExternalLink, useAuthMode } from './AgentAuth'
import { AgentStatusBlock, statusView, useAgentStatus } from './AgentStatusCard'
import { CodexSignIn } from './CodexSignIn'
import { LoginTerminal } from './LoginTerminal'
import { OpencodePanel } from './OpencodePanel'
import { resetSettings, Row, saveSettings, Section, ToggleRow, useSettings } from './controls'

/** Claude Code: compact a chat left idle with a large context, just before its prompt cache expires (off until chosen; it spends usage). */
export function IdleCompactRow() {
  const t = useT()
  const settings = useSettings()
  const value = settings.idleCompactTokens ?? 0
  return (
    <Row
      id="idle-compact"
      label={t('agentSettings.claude.idleCompact.label')}
      help={t('agentSettings.claude.idleCompact.help')}
      onReset={value ? () => void resetSettings(['idleCompactTokens']) : undefined}
    >
      {(control) => (
        <Select<string>
          {...control}
          width={190}
          value={String(value)}
          options={choicesWith(IDLE_COMPACT_CHOICES, value).map((n) => ({ value: String(n), label: n ? t('agentSettings.claude.idleCompact.over', { count: formatNumber(n, t.locale) }) : t('agentSettings.claude.idleCompact.off') }))}
          onChange={(next) => void saveSettings({ idleCompactTokens: Number(next) })}
        />
      )}
    </Row>
  )
}

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
          <AuthCards value={auth.mode} options={authOptions('claude', t)} onChange={(mode) => void auth.select(mode)} />
          <AgentStatusBlock agent="claude" state={state} view={view} updatable />
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
      <IdleCompactRow />
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
          <AuthCards value={auth.mode} options={authOptions('codex', t)} onChange={(mode) => void auth.select(mode)} />
          <AgentStatusBlock agent="codex" state={state} view={view} updatable />
          {auth.mode === 'apiKey' ? (
            <ApiKeyField agent="codex" label={t('agentCatalog.agent.keyLabel', { agent: 'OpenAI' })} keyUrl="https://platform.openai.com/api-keys" />
          ) : (
            <>
              <CodexSignIn connected={view?.connected === true} onSignedIn={() => void state.refresh()} />
              {/* Sign-in in the browser is the way in; the terminal stays for a machine where it can't open one. */}
              <LoginTerminal command="codex-login" commandLabel="codex login" buttonLabel={t('agentSettings.codex.useTerminal')} onDone={() => void state.refresh()} />
            </>
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

/** Each Full agent's panel. */
export const AGENT_PANELS: Record<FullAgentId, ComponentType> = {
  claude: ClaudePanel,
  codex: CodexPanel,
  cursor: CursorPanel,
  opencode: OpencodePanel
}
