// /mcp-status: the chat's MCP servers and whether they connected.
import { ArrowUpRight, CircleCheck, CircleDashed, CircleSlash, Clock, KeyRound, RefreshCw, SquareTerminal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { McpConnectionStatus, McpServerInfo, McpStatusResult } from '../../../shared/types'
import { api, attempt, openMcpStatus, showToast, timeAgo, useStore } from '../store'
import { useT } from '../i18n'
import type { PlainKey } from '../../../shared/i18n'
import { Button, Callout, Dialog, Disclosure, IconButton, LinkButton, Spinner } from '../ui'
import { TerminalView } from './TerminalView'

const MCP_DOCS = 'https://code.claude.com/docs/en/mcp'
// claude.ai connectors sign in on claude.ai, not in Claude Code.
const CLAUDE_AI_CONNECTORS = 'https://claude.ai/settings/connectors'
// Keep asking while servers are still connecting, for up to a minute.
const POLL_MS = 1000
const MAX_POLLS = 60

const STATE_LABEL: Record<McpConnectionStatus, PlainKey | undefined> = {
  connected: undefined,
  failed: 'mcpStatus.state.failed',
  pending: 'mcpStatus.state.pending',
  'needs-auth': 'mcpStatus.state.needsAuth',
  disabled: 'mcpStatus.state.disabled',
  // G1: handed to an agent that can't say whether it connected.
  passed: 'mcpStatus.state.passed'
}

// Servers that need the user come first.
const ORDER: McpConnectionStatus[] = ['failed', 'needs-auth', 'pending', 'connected', 'passed', 'disabled']

function StatusIcon({ status }: { status: McpConnectionStatus }) {
  if (status === 'connected') return <CircleCheck size={14} className="mcp-icon connected" />
  if (status === 'failed') return <X size={14} className="mcp-icon failed" />
  if (status === 'pending') return <Clock size={14} className="mcp-icon pending" />
  if (status === 'needs-auth') return <KeyRound size={14} className="mcp-icon needs-auth" />
  if (status === 'passed') return <CircleDashed size={14} className="mcp-icon passed" />
  return <CircleSlash size={14} className="mcp-icon disabled" />
}

export function McpStatusDialog({ sessionId }: { sessionId: string }) {
  const t = useT()
  const session = useStore((s) => s.snapshot!.sessions.find((x) => x.id === sessionId))
  const [result, setResult] = useState<McpStatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState<string | null>(null)
  const [authOpen, setAuthOpen] = useState(false)
  const request = useRef(0)
  const polls = useRef(0)
  const close = () => openMcpStatus(null)

  // `quiet` (polling) leaves the Refresh button alone.
  const load = async (restart: boolean, quiet = false) => {
    const id = ++request.current
    if (restart) polls.current = 0
    if (!quiet) setLoading(true)
    try {
      const next = await api.mcpStatus(sessionId, restart)
      if (id !== request.current) return
      setResult(next)
      setError(null)
    } catch (err) {
      if (id !== request.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (id === request.current) setLoading(false)
    }
  }

  useEffect(() => {
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Follow servers that are still connecting.
  useEffect(() => {
    if (loading || !result?.servers.some((s) => s.status === 'pending') || polls.current >= MAX_POLLS) return
    const timer = setTimeout(() => {
      polls.current++
      void load(false, true)
    }, POLL_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, loading])

  useEffect(() => {
    if (!session) close()
  }, [session])
  if (!session) return null

  const reconnect = async (name: string) => {
    setReconnecting(name)
    const ok = await attempt(async () => {
      await api.reconnectMcpServer(sessionId, name)
      return true
    })
    setReconnecting(null)
    if (ok) showToast(t('mcpStatus.reconnected', { name }))
    await load(false, true)
  }

  const servers = [...(result?.servers ?? [])].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const subtitle = !result
    ? t('mcpStatus.starting')
    : result.repoOnly
      ? result.repoOnly.passedAt
        ? t('g1.mcpStatus.repoOnlyPassed', { agent: result.repoOnly.agent, when: timeAgo(result.repoOnly.passedAt) })
        : t('g1.mcpStatus.repoOnly', { agent: result.repoOnly.agent })
      : result.live
      ? t('mcpStatus.live')
      : t('mcpStatus.notLive')

  return (
    <Dialog
      title={t('mcpStatus.title')}
      onClose={close}
      size="lg"
      className="dlg mcp-modal"
      footer={
        <>
          <LinkButton className="dlg-start mcp-footer-btn" disabled={loading && !result} onClick={() => void load(true)}>
            {loading ? <Spinner size={14} /> : <RefreshCw size={14} aria-hidden />} {t('mcpStatus.refresh')}
          </LinkButton>
          <LinkButton className="mcp-footer-btn" onClick={() => void attempt(() => api.openExternal(MCP_DOCS))}>
            <ArrowUpRight size={14} aria-hidden /> {t('mcpStatus.docs')}
          </LinkButton>
        </>
      }
    >
      <p className="muted mcp-subtitle">{subtitle}</p>
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
      {result && !result.supported && <p className="muted">{t('mcpStatus.unsupported')}</p>}
      {result?.repoOnly && servers.length === 0 && !error && <p className="muted">{t('g1.mcpStatus.repoOnlyNone')}</p>}
      {result?.supported && !result.repoOnly && servers.length === 0 && !error && (
        <p className="muted">
          {t.rich('mcpStatus.none', { command: <code>claude mcp add</code>, file: <code>.mcp.json</code> })}
        </p>
      )}
      {servers.length > 0 && (
        <ul className="mcp-list">
          {servers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              open={expanded === server.name}
              onToggle={() => setExpanded(expanded === server.name ? null : server.name)}
              reconnecting={reconnecting === server.name}
              onReconnect={() => void reconnect(server.name)}
              onAuthenticate={() =>
                server.scope === 'claudeai' ? void attempt(() => api.openExternal(CLAUDE_AI_CONNECTORS)) : setAuthOpen(true)
              }
            />
          ))}
        </ul>
      )}
      {authOpen && (
        <McpAuthTerminal
          workspaceId={session.workspaceId}
          onDone={() => {
            setAuthOpen(false)
            void load(true)
          }}
          onClose={() => setAuthOpen(false)}
        />
      )}
    </Dialog>
  )
}

function ServerRow({
  server,
  open,
  onToggle,
  reconnecting,
  onReconnect,
  onAuthenticate
}: {
  server: McpServerInfo
  open: boolean
  onToggle: () => void
  reconnecting: boolean
  onReconnect: () => void
  onAuthenticate: () => void
}) {
  const t = useT()
  const key = STATE_LABEL[server.status]
  const label = key && t(key)
  const toolCount = server.tools?.length
  return (
    <li className={`mcp-row ${server.status} ${open ? 'open' : ''}`}>
      <Disclosure
        open={open}
        onOpenChange={onToggle}
        label={
          <>
            <StatusIcon status={server.status} />
            <span className="mcp-name">{server.name}</span>
            {label && <span className="mcp-state">({label})</span>}
            {server.origin && <span className="faint small mcp-origin">{server.origin}</span>}
            <span className="spacer" />
            {toolCount !== undefined && <span className="faint small">{t('mcpStatus.tools', { count: toolCount })}</span>}
          </>
        }
      >
        <div className="mcp-detail">
          {server.error && <pre className="mcp-detail-error">{server.error}</pre>}
          {server.status === 'needs-auth' && (
            <p className="small muted">
              {server.scope === 'claudeai'
                ? t('mcpStatus.needsAuth.claudeai')
                : t('mcpStatus.needsAuth.server')}
            </p>
          )}
          <dl className="mcp-facts small">
            {server.transport && (
              <>
                <dt>{t('mcpStatus.fact.transport')}</dt>
                <dd>{server.transport}</dd>
              </>
            )}
            {server.target && (
              <>
                <dt>{server.transport === 'stdio' ? t('mcpStatus.fact.command') : 'URL'}</dt>
                <dd className="mono">{server.target}</dd>
              </>
            )}
            {server.origin && (
              <>
                <dt>{t('mcpStatus.fact.source')}</dt>
                <dd>{server.origin}</dd>
              </>
            )}
            {server.scope && (
              <>
                <dt>{t('mcpStatus.fact.scope')}</dt>
                <dd>{server.scope}</dd>
              </>
            )}
          </dl>
          {server.tools && server.tools.length > 0 && (
            <div className="mcp-tools">
              {server.tools.map((tool) => (
                <span key={tool} className="mcp-tool mono">
                  {tool}
                </span>
              ))}
            </div>
          )}
          {server.status !== 'disabled' && server.status !== 'passed' && (
            <div className="mcp-actions">
              {server.status === 'needs-auth' && (
                <Button size="sm" variant="primary" icon={<KeyRound size={12} />} onClick={onAuthenticate}>
                  {t('mcpStatus.authenticate')}
                </Button>
              )}
              {server.status !== 'pending' && (
                // aria-disabled, not disabled: a disabled button drops focus out of the dialog, and Escape with it.
                <Button size="sm" icon={reconnecting ? <Spinner size={12} /> : <RefreshCw size={12} />} aria-disabled={reconnecting} onClick={() => !reconnecting && onReconnect()}>
                  {reconnecting ? t('mcpStatus.reconnecting') : t('mcpStatus.reconnect')}
                </Button>
              )}
            </div>
          )}
        </div>
      </Disclosure>
    </li>
  )
}

/** Claude Code's /mcp screen in a terminal, where servers that use OAuth sign in. */
function McpAuthTerminal({ workspaceId, onDone, onClose }: { workspaceId: string; onDone: () => void; onClose: () => void }) {
  const [exitCode, setExitCode] = useState<number | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const t = useT()
  const status = exitCode === null ? t('mcpStatus.auth.pick') : t('mcpStatus.auth.exited')
  return (
    // Escape belongs to the terminal here, not the dialog.
    <div className="mcp-terminal" onKeyDown={(e) => e.key === 'Escape' && e.stopPropagation()}>
      <div className="mcp-terminal-head">
        <SquareTerminal size={13} className="faint" aria-hidden />
        <span className="small">{status}</span>
        <span className="spacer" />
        <Button size="sm" variant="primary" onClick={onDone}>
          {t('common.done')}
        </Button>
        <IconButton label={t('mcpStatus.auth.close')} onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="mcp-terminal-body" ref={body}>
        <TerminalView
          workspaceId={workspaceId}
          kind="command"
          command="claude-mcp"
          sendAs="MCP sign-in"
          visible
          onSpawn={() => body.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus()}
          onExit={setExitCode}
        />
      </div>
    </div>
  )
}
