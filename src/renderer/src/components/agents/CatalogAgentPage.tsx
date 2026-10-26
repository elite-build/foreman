// #22: one Chat or Terminal agent's page. Sign-in reuses Claude's Authentication
// UI: Login | API key cards when it has both, the status block, its own login in
// an inline terminal with Check again, and the API key field. Then its
// executable path, what it can do, and the Enable switch.
import { ArrowUpRight, FolderOpen, RefreshCw, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { allowedProviderKeys, binariesFor, canCheckSignIn, catalogAgent, signInMethods, type CatalogAgent } from '../../../../shared/agentCatalog'
import type { PlainKey } from '../../../../shared/i18n'
import { providerInfo } from '../../../../shared/providers'
import type { Settings } from '../../../../shared/types'
import { loadAgentCatalog, useAgentCatalog } from '../../agentCatalog'
import { useT } from '../../i18n'
import { api, attempt, openSettingsPage, useStore } from '../../store'
import { Button, IconButton, LinkButton, Spinner, Status, Tag, TextInput } from '../../ui'
import { ApiKeyField, AuthCards, ExternalLink, useAuthMode, type AuthOption } from '../settings/AgentAuth'
import { LoginTerminal } from '../settings/LoginTerminal'
import { RepoMcpAgentRow } from '../McpConsent'
import { Page, Row, saveSettings, Section, useDraft, useSettings } from '../settings/controls'
import { AgentMonogram } from './AgentMonogram'
import { CapabilityChips, EnableSwitch, signInStatusTone, signInText, useSignIn } from './catalogShared'
import { LEVEL_LABEL } from './PickerAgents'
import { ModelVisibility } from '../settings/ModelVisibility'
import type { AgentKind } from '../../../../shared/agents'
import './catalog.css'

export function CatalogAgentPage({ agent: id, tabs }: { agent: string; tabs: ReactNode }) {
  const t = useT()
  const agent = catalogAgent(id)
  if (!agent) {
    return (
      <Page title={t('agentCatalog.page.title')}>
        {tabs}
        <p className="faint">{t('agentCatalog.agent.unknown')}</p>
      </Page>
    )
  }
  return (
    <Page
      title={
        <span className="cat-agent-title">
          <AgentMonogram agent={agent.id} large /> {agent.name} <Tag tone="outline">{t(LEVEL_LABEL[agent.level])}</Tag>
        </span>
      }
      description={t('agentCatalog.agent.description', { agent: agent.name })}
    >
      {tabs}
      {/* G1 (O8): a Chat agent's models can be hidden from the picker, as the Full agents' can. */}
      {agent.level === 'chat' && <ModelVisibility agent={agent.id as AgentKind} />}
      <Section>
        <AuthRow agent={agent} />
        <PathRow agent={agent} />
        <Row label={t('agentCatalog.agent.capabilities')} help={agent.level === 'terminal' ? t('agentCatalog.agent.terminalHelp') : t('agentCatalog.agent.chatHelp')} stacked>
          <CapabilityChips agent={agent} />
          <Reported agent={agent} />
        </Row>
        <RepoMcpAgentRow agent={agent.id} name={agent.name} />
        <Row label={t('agentCatalog.agent.enable')} help={t('agentCatalog.agent.enableHelp')}>
          <EnableSwitch agent={agent} />
        </Row>
        <Row label={t('agentCatalog.agent.docs')} help={agent.docsUrl}>
          <ExternalLink href={agent.docsUrl} look="button">
            {t('agentCatalog.agent.openDocs')}
          </ExternalLink>
        </Row>
      </Section>
    </Page>
  )
}

const LOGIN_DESC: PlainKey = 'agentCatalog.agent.loginDesc'
const KEY_DESC: PlainKey = 'agentCatalog.agent.keyDesc'

function AuthRow({ agent }: { agent: CatalogAgent }) {
  const t = useT()
  const settings = useSettings()
  const methods = signInMethods(agent)
  const auth = useAuthMode(agent.id)
  const { view, loading, refresh } = useAgentCatalog()
  const signIn = useSignIn()
  const [reported, setReported] = useState<{ signedIn: boolean; account?: string; source?: string } | undefined>()
  const detection = view?.detections[agent.id]

  const check = async () => {
    await refresh()
    if (canCheckSignIn(agent)) setReported((await api.agentSignInStatus(agent.id).catch(() => null)) ?? undefined)
  }
  useEffect(() => {
    if (canCheckSignIn(agent) && detection?.installed) void api.agentSignInStatus(agent.id).then((r) => setReported(r ?? undefined)).catch(() => undefined)
  }, [agent, detection?.installed])

  if (!methods.length) {
    return (
      <Row label={t('agentCatalog.agent.auth')} help={t('agentCatalog.agent.checkDocsHelp', { agent: agent.name })}>
        <ExternalLink href={agent.docsUrl} look="button">
          {t('agentCatalog.method.checkDocs')}
        </ExternalLink>
      </Row>
    )
  }

  const both = methods.includes('login') && methods.includes('apiKey')
  const mode = both ? auth.mode : methods.includes('apiKey') && !methods.includes('login') ? 'apiKey' : 'cli'
  const state = signIn(agent, reported)
  const options: AuthOption[] = [
    { value: 'cli', label: t('agentCatalog.method.login'), description: t(agent.auth.login?.hint ?? LOGIN_DESC) },
    { value: 'apiKey', label: t('agentCatalog.method.apiKey'), description: t(KEY_DESC) }
  ]
  const shared = Object.keys(allowedProviderKeys(agent.id, Object.fromEntries((view?.savedProviderKeys ?? []).map((k) => [k, 'x'])), settings.providerKeyAgents))
  const binary = detection?.path ? detection.path.split(/[\\/]/).pop() : binariesFor(agent, '')[0]
  const loginLabel = [binary, ...(agent.auth.login?.args ?? [])].join(' ')

  return (
    <Row id={`agent-${agent.id}`} label={t('agentCatalog.agent.auth')} help={t('agentCatalog.agent.authHelp', { agent: agent.name })} stacked>
      <div className="ag-auth">
        {both && <AuthCards value={auth.mode} options={options} onChange={(m) => void auth.select(m)} />}
        <div className="ag-status" aria-busy={loading} aria-live="polite">
          <div className="ag-status-head">
            {detection && !detection.installed ? (
              <Status className="ag-status-text" tone="error" label={t('agentCatalog.row.notInstalled')} />
            ) : (
              <Status className="ag-status-text" tone={signInStatusTone(state, true)} label={signInText(state, t)} />
            )}
            <span className="spacer" />
            <Button size="sm" variant="ghost" icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />} disabled={loading} onClick={() => void check()}>
              {t('agentCatalog.agent.refresh')}
            </Button>
          </div>
          {detection?.error && <pre className="cat-error mono small">$ {detection.error.command}{'\n'}{detection.error.output}</pre>}
          {detection?.installed && (
            <dl className="ag-status-table">
              {detection.version && (
                <div className="ag-status-row">
                  <dt>{t('agentCatalog.agent.version')}</dt>
                  <dd className="mono">{detection.version}</dd>
                </div>
              )}
              {detection.path && (
                <div className="ag-status-row">
                  <dt>{t('agentCatalog.agent.path')}</dt>
                  <dd className="mono" title={detection.path}>
                    {detection.path}
                  </dd>
                </div>
              )}
              {detection.acpProgram && (
                // G1: ACP is a separate program for this agent (pi-acp, agy_acp_server); found beside the CLI or on PATH, or not.
                <div className="ag-status-row">
                  <dt>{t('g1.acpProgram.label')}</dt>
                  <dd className="mono" title={detection.acpProgram.path}>
                    {detection.acpProgram.path ?? t('g1.acpProgram.missing', { name: detection.acpProgram.name })}
                  </dd>
                </div>
              )}
            </dl>
          )}
          {detection?.acpProgram && !detection.acpProgram.path && detection.acpProgram.install && <p className="ag-status-detail faint small">{agent.acp?.installHint ? t(agent.acp.installHint) : detection.acpProgram.install}</p>}
          {detection && !detection.installed && (
            <p className="ag-status-detail">
              <ExternalLink href={agent.docsUrl}>{t('agentCatalog.row.howToInstall')}</ExternalLink>
            </p>
          )}
        </div>
        {mode === 'apiKey' && agent.auth.apiKey && <ApiKeyField agent={agent.id} label={t('agentCatalog.agent.keyLabel', { agent: agent.name })} keyUrl={agent.auth.apiKey.keyUrl} />}
        {mode === 'cli' && agent.auth.login && (
          <LoginTerminal
            command={`login:${agent.id}`}
            commandLabel={loginLabel}
            hint={agent.auth.login.hint && t(agent.auth.login.hint)}
            buttonLabel={state.kind === 'signed-in' ? t('agentCatalog.agent.signInAgain') : t('agentCatalog.signin.signIn')}
            primary={state.kind === 'not-signed-in'}
            doneLabel={t('agentCatalog.agent.checkAgain')}
            onDone={() => void check()}
          />
        )}
        {methods.includes('shared') && (
          <div className="ag-key-note">
            {shared.length ? t('agentCatalog.agent.sharedSome', { keys: shared.map((k) => providerInfo(k).label).join(', ') }) : t('agentCatalog.agent.sharedNone')}{' '}
            <LinkButton onClick={() => openSettingsPage({ section: 'agents', agent: 'keys' })}>
              {t('agentCatalog.keys.title')} <ArrowUpRight size={11} aria-hidden />
            </LinkButton>
          </div>
        )}
      </div>
    </Row>
  )
}

function PathRow({ agent }: { agent: CatalogAgent }) {
  const t = useT()
  const settings = useSettings()
  const value = settings.agentPrefs?.[agent.id]?.path ?? ''
  const platform = useStore((s) => s.snapshot!.platform)
  const save = (next: string) => {
    const prefs = { ...settings.agentPrefs, [agent.id]: { ...settings.agentPrefs?.[agent.id], path: next.trim() || undefined } }
    void saveSettings({ agentPrefs: prefs } as Partial<Settings>).then(() => loadAgentCatalog(true))
  }
  const draft = useDraft(value, save)
  const browse = async () => {
    const picked = await attempt(() => api.pickPath({ kind: 'file', title: t('agentCatalog.agent.pathTitle', { agent: agent.name }), defaultPath: value || undefined }))
    if (picked) save(picked)
  }
  const binary = binariesFor(agent, platform)[0]
  return (
    <Row label={t('agentCatalog.agent.pathLabel', { agent: agent.name })} help={t('agentCatalog.agent.pathHelp', { binary })} stacked>
      {(control) => (
        <div className="ag-path">
          <div className="ag-path-input">
            <TextInput {...control} {...draft} mono spellCheck={false} autoComplete="off" placeholder={binary} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
            {value && (
              <IconButton label={t('agentCatalog.agent.pathReset')} onClick={() => save('')}>
                <X size={13} />
              </IconButton>
            )}
            <IconButton label={t('agentCatalog.agent.pathBrowse')} onClick={() => void browse()}>
              <FolderOpen size={13} />
            </IconButton>
          </div>
        </div>
      )}
    </Row>
  )
}

/** What the agent declared over ACP the last time it ran, said as the agent's own claim. */
function Reported({ agent }: { agent: CatalogAgent }) {
  const t = useT()
  const { view } = useAgentCatalog()
  if (agent.level !== 'chat') return null
  const r = view?.acp[agent.id]
  if (!r) return <p className="faint small">{t('agentCatalog.agent.notRunYet')}</p>
  const said = [
    r.loadSession || r.resume ? t('agentCatalog.agent.saidResume') : t('agentCatalog.agent.saidNoResume'),
    r.images ? t('agentCatalog.agent.saidImages') : null,
    r.modes.length ? t('agentCatalog.agent.saidModes', { modes: r.modes.join(', ') }) : null,
    // G1: what the program says it is (a separate ACP program like pi-acp names itself here).
    r.agentInfo ? t('g1.reported.program', { name: r.agentInfo.name, version: r.agentInfo.version }) : null
  ].filter(Boolean)
  return <p className="faint small">{t('agentCatalog.agent.reported', { what: said.join(' · ') })}</p>
}
