// #22: pieces the Agents, Sign-in and Provider keys pages share: per-agent state
// read from settings and the catalog view, the capability chips, the level
// legend and the Enable switch.
import { CheckCircle2, KeyRound, Layers, LogIn, MessageSquare, Search, SquareTerminal } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  agentAuthMode,
  allowedProviderKeys,
  CAPABILITIES,
  catalogAgent,
  isAgentEnabled,
  missingCapabilities,
  signInMethods,
  signInState,
  type CatalogAgent,
  type IntegrationLevel,
  type SignInMethod,
  type SignInState
} from '../../../../shared/agentCatalog'
import type { PlainKey } from '../../../../shared/i18n'
import type { AgentKind } from '../../../../shared/agents'
import type { AgentStatus } from '../../../../shared/types'
import { useAgentCatalog } from '../../agentCatalog'
import { useT, type RendererT } from '../../i18n'
import { useStore } from '../../store'
import { Switch, Tag, TextInput, type StatusTone, type TextInputProps } from '../../ui'
import { saveSettings, useSettings } from '../settings/controls'
import { CAPABILITY_LABEL, LEVEL_LABEL } from './PickerAgents'

/** A search box with the magnifier the old one had. `className` is for the box's layout (width, flex). */
export function SearchField({ className, ...props }: Omit<TextInputProps, 'type' | 'className'> & { className?: string }) {
  return (
    <span className={className ? `search-field ${className}` : 'search-field'}>
      <Search size={13} aria-hidden />
      <TextInput {...props} type="search" />
    </span>
  )
}

/** Turns an agent on or off in the picker. Never installs, signs in or starts anything. */
export function setAgentEnabled(prefs: Record<string, { enabled?: boolean }> | undefined, id: string, enabled: boolean): Promise<boolean> {
  return saveSettings({ agentPrefs: { ...prefs, [id]: { ...prefs?.[id], enabled } } })
}

export function EnableSwitch({ agent }: { agent: CatalogAgent }) {
  const t = useT()
  const prefs = useSettings().agentPrefs
  return (
    <Switch
      label={t('agentCatalog.row.enable', { agent: agent.name })}
      checked={isAgentEnabled(agent.id, prefs)}
      onChange={(on) => void setAgentEnabled(prefs, agent.id, on)}
    />
  )
}

/** Capability chips, unsupported ones struck through. G1: Plan turns on when the agent itself declared a plan session mode. */
export function CapabilityChips({ agent }: { agent: CatalogAgent }) {
  const t = useT()
  const modes = useStore((s) => s.snapshot?.catalog.agents[agent.id as AgentKind]?.modes)
  const missing = missingCapabilities(agent.id, modes)
  return (
    <span className="cat-chips">
      {CAPABILITIES.map((c) => {
        const on = !missing.includes(c)
        const declared = on && !agent.capabilities[c]
        return (
          <Tag
            key={c}
            tone="outline"
            title={declared ? t('g1.cap.declaredPlan', { agent: agent.name }) : on ? undefined : t('agentCatalog.cap.unsupported', { cap: t(CAPABILITY_LABEL[c]) })}
          >
            {on ? t(CAPABILITY_LABEL[c]) : <s className="cat-chip-off">{t(CAPABILITY_LABEL[c])}</s>}
          </Tag>
        )
      })}
    </span>
  )
}

const LEVEL_ICON: Record<IntegrationLevel, ReactNode> = {
  full: <CheckCircle2 size={13} />,
  chat: <MessageSquare size={13} />,
  terminal: <SquareTerminal size={13} />
}

const LEVEL_DESC: Record<IntegrationLevel, PlainKey> = {
  full: 'agentCatalog.legend.full',
  chat: 'agentCatalog.legend.chat',
  terminal: 'agentCatalog.legend.terminal'
}

export function LevelLegend() {
  const t = useT()
  return (
    <div className="cat-legend">
      {(['full', 'chat', 'terminal'] as IntegrationLevel[]).map((level) => (
        <div key={level} className="cat-legend-item">
          <div className="cat-legend-head">
            {LEVEL_ICON[level]} <strong>{t(LEVEL_LABEL[level])}</strong>
            {level === 'chat' && <Tag tone="outline">ACP</Tag>}
          </div>
          <p>{t(LEVEL_DESC[level])}</p>
        </div>
      ))}
    </div>
  )
}

const METHOD_ICON: Record<SignInMethod, ReactNode> = {
  login: <LogIn size={12} />,
  apiKey: <KeyRound size={12} />,
  shared: <Layers size={12} />
}

const METHOD_LABEL: Record<SignInMethod, PlainKey> = {
  login: 'agentCatalog.method.login',
  apiKey: 'agentCatalog.method.apiKey',
  shared: 'agentCatalog.method.shared'
}

export function methodLabel(method: SignInMethod, t: RendererT): string {
  return t(METHOD_LABEL[method])
}

export function MethodTags({ agent }: { agent: CatalogAgent }) {
  const t = useT()
  const methods = signInMethods(agent)
  if (!methods.length) return <Tag tone="outline" className="cat-method">{t('agentCatalog.method.checkDocs')}</Tag>
  return (
    <span className="cat-methods">
      {methods.map((m) => (
        <Tag key={m} tone="outline" className="cat-method">
          {METHOD_ICON[m]} {t(METHOD_LABEL[m])}
        </Tag>
      ))}
    </span>
  )
}

/** Everything the pages need to say about one agent's sign-in, from settings, the vault hints and the catalog view. */
export function useSignIn() {
  const settings = useSettings()
  const hints = useStore((s) => s.snapshot!.agentKeyHints) ?? {}
  const { view } = useAgentCatalog()
  const saved = view?.savedProviderKeys ?? []
  const providerCount = (id: string) =>
    Object.keys(allowedProviderKeys(id, Object.fromEntries(saved.map((k) => [k, 'x'])), settings.providerKeyAgents)).length
  return (agent: CatalogAgent, reported?: { signedIn: boolean; account?: string; source?: string }): SignInState => {
    // Full agents: their own status checks, as their pages show them.
    const status: AgentStatus | undefined = view?.statuses[agent.id]
    const mode = agentAuthMode(agent.id, settings)
    const fullReport = agent.level === 'full' && status?.installed && mode === 'cli' && agent.auth.login ? { signedIn: status.ready, account: status.account ?? status.method } : undefined
    return signInState(agent, { mode, keyHint: hints[agent.id], providerKeys: providerCount(agent.id), reported: reported ?? fullReport })
  }
}

/** The status sentence for a sign-in state. */
export function signInText(state: SignInState, t: RendererT): string {
  switch (state.kind) {
    case 'signed-in':
      // G1: a credentials probe found a sign-in on disk; it doesn't prove it still works, and says where it looked.
      if (state.source) return state.account ? t('g1.signIn.foundAs', { account: state.account, source: state.source }) : t('g1.signIn.found', { source: state.source })
      return state.account ? t('agentCatalog.status.signedInAs', { account: state.account }) : t('agentCatalog.status.signedIn')
    case 'api-key':
      return t('agentCatalog.status.apiKey', { hint: state.hint || '••••' })
    case 'not-signed-in':
      return t('agentCatalog.status.notSignedIn')
    case 'no-key':
      return t('agentCatalog.status.noKey')
    case 'provider-keys':
      return t('agentCatalog.status.providerKeys', { count: state.count })
    case 'no-provider-keys':
      return t('agentCatalog.status.noProviderKeys')
    case 'unknown':
      return t('agentCatalog.status.unknown')
    case 'check-docs':
      return t('agentCatalog.status.checkDocs')
  }
}

export function signInTone(state: SignInState): 'green' | 'amber' | 'faint' {
  if (state.kind === 'signed-in' || state.kind === 'api-key' || state.kind === 'provider-keys') return 'green'
  if (state.kind === 'unknown' || state.kind === 'check-docs') return 'faint'
  return 'amber'
}

/** The Status tone for a sign-in state: signed in (green), something to do (amber, or red where `strict`), unknown (off). */
export function signInStatusTone(state: SignInState, strict = false): StatusTone {
  const tone = signInTone(state)
  return tone === 'green' ? 'ok' : tone === 'faint' ? 'off' : strict ? 'error' : 'warn'
}

export function agentName(id: string): string {
  return catalogAgent(id)?.name ?? id
}
