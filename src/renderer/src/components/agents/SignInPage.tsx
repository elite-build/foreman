// #22: Settings → Agents & models → Sign-in: every agent, the methods it offers,
// the one in use and what the agent itself reports. Unknown when it can't say;
// keys show only their last four characters. The Login | API key switch here is
// the same setting as the cards on each agent's page.
import { ArrowUpRight, ChevronDown, KeyRound, Layers, LogIn } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { AGENT_CATALOG, canCheckSignIn, isAgentEnabled, LEVELS, signInMethods, type CatalogAgent, type IntegrationLevel } from '../../../../shared/agentCatalog'
import type { AgentAuthMode } from '../../../../shared/types'
import { useAgentCatalog } from '../../agentCatalog'
import { useT } from '../../i18n'
import { api, attempt, openSettingsPage } from '../../store'
import { AgentIcon } from '../composer/AgentPicker'
import { ActionRow, Card, LinkButton, Pressable, Segmented, Status, Tag } from '../../ui'
import { useAuthMode } from '../settings/AgentAuth'
import { Page, useSettings } from '../settings/controls'
import { methodLabel, MethodTags, signInStatusTone, signInText, useSignIn } from './catalogShared'
import { LEVEL_LABEL } from './PickerAgents'
import './catalog.css'

// Rows each group shows before "Show N more".
const FOLD_AT = 5

/** The agent's own status command answers (G1: or what its credentials probe found), for installed and enabled agents that have one. */
function useReportedSignIns(): Record<string, { signedIn: boolean; account?: string; source?: string }> {
  const { view } = useAgentCatalog()
  const prefs = useSettings().agentPrefs
  const [reported, setReported] = useState<Record<string, { signedIn: boolean; account?: string; source?: string }>>({})
  const ids = AGENT_CATALOG.filter((a) => canCheckSignIn(a) && view?.detections[a.id]?.installed && isAgentEnabled(a.id, prefs)).map((a) => a.id)
  const key = ids.join(',')
  useEffect(() => {
    let live = true
    for (const id of key ? key.split(',') : []) {
      void api
        .agentSignInStatus(id)
        .catch(() => null)
        .then((answer) => live && answer && setReported((r) => ({ ...r, [id]: answer })))
    }
    return () => {
      live = false
    }
  }, [key])
  return reported
}

export function SignInPage({ tabs }: { tabs: ReactNode }) {
  const t = useT()
  const prefs = useSettings().agentPrefs
  const [open, setOpen] = useState<Set<IntegrationLevel>>(new Set())
  const reported = useReportedSignIns()

  return (
    <Page title={t('agentCatalog.signin.title')} description={t('agentCatalog.signin.description')}>
      {tabs}
      <div className="cat-legend">
        <div className="cat-legend-item">
          <div className="cat-legend-head">
            <LogIn size={13} /> <strong>{t('agentCatalog.method.login')}</strong>
          </div>
          <p>{t('agentCatalog.signin.legendLogin')}</p>
        </div>
        <div className="cat-legend-item">
          <div className="cat-legend-head">
            <KeyRound size={13} /> <strong>{t('agentCatalog.method.apiKey')}</strong>
          </div>
          <p>{t('agentCatalog.signin.legendApiKey')}</p>
        </div>
        <div className="cat-legend-item">
          <div className="cat-legend-head">
            <Layers size={13} /> <strong>{t('agentCatalog.method.shared')}</strong>
          </div>
          <p>{t('agentCatalog.signin.legendShared')}</p>
        </div>
      </div>
      <div className="si-head small faint">
        <span>{t('agentCatalog.signin.colAgent')}</span>
        <span>{t('agentCatalog.signin.colMethods')}</span>
        <span>{t('agentCatalog.signin.colCurrent')}</span>
        <span>{t('agentCatalog.signin.colStatus')}</span>
      </div>
      {LEVELS.map((level) => {
        const all = AGENT_CATALOG.filter((a) => a.level === level)
        // Enabled agents first, then the rest in catalog order.
        const sorted = [...all.filter((a) => isAgentEnabled(a.id, prefs)), ...all.filter((a) => !isAgentEnabled(a.id, prefs))]
        const expanded = open.has(level) || level === 'full'
        const visible = expanded ? sorted : sorted.slice(0, FOLD_AT)
        const folded = expanded ? [] : sorted.slice(FOLD_AT)
        return (
          <section key={level} className="cat-group">
            <header className="cat-group-head">
              <strong>{t(LEVEL_LABEL[level])}</strong>
              {level === 'chat' && <Tag tone="outline">ACP</Tag>}
              <span className="faint">{all.length}</span>
            </header>
            <Card className="cat-rows">
              {visible.map((agent) => (
                <SignInRow key={agent.id} agent={agent} reported={reported[agent.id]} />
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
    </Page>
  )
}

function SignInRow({ agent, reported }: { agent: CatalogAgent; reported?: { signedIn: boolean; account?: string } }) {
  const t = useT()
  const signIn = useSignIn()
  const auth = useAuthMode(agent.id)
  const methods = signInMethods(agent)
  const state = signIn(agent, reported)
  const both = methods.includes('login') && methods.includes('apiKey')

  let current: ReactNode
  if (!methods.length) current = <span className="faint">{t('agentCatalog.signin.notKnown')}</span>
  else if (both) {
    current = (
      <Segmented<AgentAuthMode>
        plain
        small
        label={t('agentCatalog.signin.colCurrent')}
        value={auth.mode}
        options={[
          { value: 'cli', label: t('agentCatalog.method.login') },
          { value: 'apiKey', label: t('agentCatalog.method.apiKey') }
        ]}
        onChange={(mode) => void auth.select(mode)}
      />
    )
  } else current = <span>{methodLabel(methods[0], t)}</span>

  // What to do next, when there's something to do.
  let action: ReactNode = null
  const open = (page: string) => () => openSettingsPage({ section: 'agents', agent: page })
  if (state.kind === 'not-signed-in') action = <LinkButton onClick={open(agent.id)}>{t('agentCatalog.signin.signIn')}</LinkButton>
  else if (state.kind === 'no-key') action = <LinkButton onClick={open(agent.id)}>{t('agentCatalog.signin.add')}</LinkButton>
  else if (state.kind === 'no-provider-keys') action = <LinkButton onClick={open('keys')}>{t('agentCatalog.signin.choose')}</LinkButton>
  else if (state.kind === 'check-docs')
    action = (
      <LinkButton onClick={() => void attempt(() => api.openExternal(agent.docsUrl))}>
        {t('agentCatalog.method.checkDocs')} <ArrowUpRight size={11} aria-hidden />
      </LinkButton>
    )

  return (
    <div className="si-row">
      <Pressable className="si-agent" onClick={open(agent.id)}>
        <AgentIcon agent={agent.id} /> <strong className="si-agent-name">{agent.name}</strong>
      </Pressable>
      <MethodTags agent={agent} />
      <span className="si-current">{current}</span>
      <span className="si-status small">
        <Status tone={signInStatusTone(state)} label={signInText(state, t)} />
        {action && <> · {action}</>}
      </span>
    </div>
  )
}
