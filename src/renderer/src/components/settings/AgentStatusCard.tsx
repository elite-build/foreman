// Connection status for one agent: a hook that asks the main process, and the
// block on the Agents page that shows the answer.
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AGENTS } from '../../../../shared/agents'
import type { TFunction } from '../../../../shared/i18n'
import type { AgentAuthMode, AgentKind, AgentStatus } from '../../../../shared/types'
import { recordAgentStatus } from '../../agentReadiness'
import { useT } from '../../i18n'
import { api, refreshOpencode } from '../../store'
import { Button, Spinner, Status } from '../../ui'

export interface AgentStatusState {
  status: AgentStatus | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * The agent's status, fetched on mount, on refresh, and whenever `key`
 * changes. A key change clears the old answer unless `keepStale` is set.
 */
export function useAgentStatus(agent: AgentKind, key = '', keepStale = false): AgentStatusState {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Only the latest request may update the state.
  const request = useRef(0)

  const refresh = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    try {
      const next = await api.agentStatus(agent)
      if (id !== request.current) return
      setStatus(next)
      setError(null)
      // The picker and the in-chat sign-in card learn the answer too.
      recordAgentStatus(next)
    } catch (err) {
      if (id !== request.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (id === request.current) setLoading(false)
    }
    // The agent picker offers OpenCode only once it's installed.
    if (agent === 'opencode') void refreshOpencode()
  }, [agent])

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

// Whose API key each agent takes (provider names, not translated).
const KEY_PROVIDERS: Partial<Record<AgentKind, string>> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  cursor: 'Cursor'
}

/** What the status block says, given how the agent is set to sign in. */
export function statusView(agent: AgentKind, state: AgentStatusState, mode: AgentAuthMode, hasKey: boolean, t: TFunction): StatusView | null {
  if (state.error) return { connected: false, message: t('agentSettings.status.checkFailed'), detail: state.error }
  const status = state.status
  if (!status) return null
  if (!status.installed) return { connected: false, message: status.detail || t('agentSettings.status.notInstalled', { agent: AGENTS[agent].label }) }
  if (mode === 'apiKey' && !hasKey) {
    const provider = KEY_PROVIDERS[agent]
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

/** "Connected" or why not, a Refresh button, and the version and account details. */
export function AgentStatusBlock({ state, view }: { state: AgentStatusState; view: StatusView | null }) {
  const t = useT()
  const { status, loading, refresh } = state
  const rows: [string, string, boolean?][] = []
  if (status?.version) rows.push([t('agentCatalog.agent.version'), status.version, true])
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
    </div>
  )
}
