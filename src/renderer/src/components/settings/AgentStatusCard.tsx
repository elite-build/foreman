// Connection status for one agent: a hook that asks the main process, and the
// block on the Agents page that shows the answer.
import { ArrowUpCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { catalogAgent } from '../../../../shared/agentCatalog'
import { brokenReason, degradedReason, updateArgs, versionStatus } from '../../../../shared/agentVersions'
import { AGENTS } from '../../../../shared/agents'
import type { TFunction } from '../../../../shared/i18n'
import type { AgentAuthMode, AgentKind, AgentStatus } from '../../../../shared/types'
import { recordAgentStatus } from '../../agentReadiness'
import { useT } from '../../i18n'
import { api, refreshOpencode } from '../../store'
import { Button, Spinner, Status } from '../../ui'
import { LoginTerminal } from './LoginTerminal'

export interface AgentStatusState {
  status: AgentStatus | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * The agent's status, fetched on mount, on refresh, and whenever `key`
 * changes. A key change clears the old answer unless `keepStale` is set.
 * #130: `instanceId` asks about one of the agent's other accounts, which says nothing about whether the agent is ready.
 */
export function useAgentStatus(agent: AgentKind, key = '', keepStale = false, instanceId?: string): AgentStatusState {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Only the latest request may update the state.
  const request = useRef(0)

  const refresh = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    try {
      const next = await api.agentStatus(agent, instanceId)
      if (id !== request.current) return
      setStatus(next)
      setError(null)
      // The picker and the in-chat sign-in card learn the answer too.
      if (!instanceId) recordAgentStatus(next)
    } catch (err) {
      if (id !== request.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (id === request.current) setLoading(false)
    }
    // The agent picker offers an agent judged only by whether it's installed (OpenCode) once it is.
    if (catalogAgent(agent)?.readiness === 'installed') void refreshOpencode()
  }, [agent, instanceId])

  // When what the answer depends on changes, the old answer no longer applies.
  const first = useRef(true)
  useEffect(() => {
    if (!first.current && !keepStale) {
      setStatus(null)
      setError(null)
    }
    first.current = false
    void refresh()
    // keepStale is fixed for a caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, key])

  return { status, loading, error, refresh }
}

export interface StatusView {
  connected: boolean
  message: string
  detail?: string
}

/** What the status block says, given how the agent is set to sign in. */
export function statusView(agent: AgentKind, state: AgentStatusState, mode: AgentAuthMode, hasKey: boolean, t: TFunction): StatusView | null {
  if (state.error) return { connected: false, message: t('agentSettings.status.checkFailed'), detail: state.error }
  const status = state.status
  if (!status) return null
  if (!status.installed) return { connected: false, message: status.detail || t('agentSettings.status.notInstalled', { agent: AGENTS[agent].label }) }
  if (mode === 'apiKey' && !hasKey) {
    const provider = catalogAgent(agent)?.auth.apiKey?.provider
    return { connected: false, message: provider ? t('agentSettings.status.noProviderKey', { provider }) : t('agentCatalog.status.noKey') }
  }
  if (status.ready) return { connected: true, message: t('agentSettings.status.connected') }
  const detail = status.detail && status.detail !== 'Not signed in' ? status.detail : undefined
  return { connected: false, message: mode === 'apiKey' ? t('agentSettings.status.keyUnverified') : t('agentSettings.status.cliNotAuthenticated'), detail }
}

function methodLabel(method: string, t: TFunction): string {
  if (/bedrock|vertex|foundry/i.test(method)) return t('agentSettings.status.provider')
  return /account$/i.test(method) ? t('agentSettings.status.loginMethod') : t('agentSettings.status.auth')
}

/**
 * "Connected" or why not, a Refresh button, and the version and account details. The version has the word the agent's table
 * gives it next to it (tested, untested, degraded, broken); where the agent has an update command and runs from the user's
 * own copy, `updatable` adds an Update button that runs it in a terminal here (never unseen).
 */
export function AgentStatusBlock({ agent, state, view, updatable }: { agent: AgentKind; state: AgentStatusState; view: StatusView | null; updatable?: boolean }) {
  const t = useT()
  const { status, loading, refresh } = state
  const rows: [string, string, boolean?][] = []
  const version = status?.version
  const word = version && catalogAgent(agent)?.versions ? versionStatus(agent, version) : undefined
  if (version) rows.push([t('agentCatalog.agent.version'), word ? t('agentVersion.withWord', { version, word: t(`agentVersion.${word}`) }) : version, true])
  // What is wrong with this version, when the table says: the agent runs, or it won't.
  const table = catalogAgent(agent)?.versions
  const reasonKey = word === 'degraded' ? degradedReason(table, version) : word === 'broken' ? brokenReason(table, version)?.why : undefined
  const command = catalogAgent(agent)?.binaries[0]
  const canUpdate = updatable && status?.installed && !status.bundled && updateArgs(agent) && command
  if (view?.connected && status?.method) rows.push([methodLabel(status.method, t), status.method])
  if (view?.connected && status?.account) rows.push([t('agentSettings.status.account'), status.account])

  return (
    <div className="ag-status" aria-busy={loading} aria-live="polite">
      <div className="ag-status-head">
        {view ? (
          <Status className="ag-status-text" tone={view.connected ? 'ok' : 'error'} label={view.message} />
        ) : (
          <span className="ag-status-text muted">{t('agentSettings.status.checking')}</span>
        )}
        <span className="spacer" />
        <Button size="sm" variant="ghost" icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />} disabled={loading} onClick={() => void refresh()}>
          {t('common.refresh')}
        </Button>
      </div>
      {view?.detail && <p className="ag-status-detail">{view.detail}</p>}
      {reasonKey && <p className="ag-status-detail">{t(reasonKey)}</p>}
      {rows.length > 0 && (
        <dl className="ag-status-table">
          {rows.map(([label, value, mono]) => (
            <div key={label} className="ag-status-row">
              <dt>{label}</dt>
              <dd className={mono ? 'mono' : undefined} title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {canUpdate && (
        <LoginTerminal
          command={`update:${agent}`}
          commandLabel={`${command} ${updateArgs(agent)!.join(' ')}`}
          buttonLabel={t('agentVersion.update')}
          icon={<ArrowUpCircle size={13} />}
          onDone={() => void refresh()}
        />
      )}
    </div>
  )
}
