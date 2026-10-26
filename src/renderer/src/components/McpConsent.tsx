// R-4: a repository proposes MCP servers in .foreman/settings.toml. They run commands on this Mac,
// so each is approved on its own, tied to what it is now. The side panel shows where each stands.
// #20: one approval covers every agent that takes repo servers (Claude, Codex, OpenCode, Chat agents);
// the dialog, the side panel and each agent's page say which agents those are, and why Cursor isn't one.
import { useEffect, useId, useState } from 'react'
import { repoMcpReach, repoMcpSupport, type RepoMcpReachRow, type RepoMcpSupport } from '../../../shared/agentCatalog'
import type { RepoMcpProposal, RepoMcpView } from '../../../shared/types'
import { useT, type RendererT } from '../i18n'
import { activeSessionId, api, attempt, openMcpConsent, useStore } from '../store'
import { AgentIcon } from './composer/AgentPicker'
import { Row, useSettings } from './settings/controls'
import { formatClock } from '../../../shared/i18n/time'
import { Button, Callout, Checkbox, Dialog, Glyph, Tag } from '../ui'

function commandLine(p: RepoMcpProposal): string {
  return [p.server.command, ...p.server.args].join(' ')
}

function scopeText(p: RepoMcpProposal, t: RendererT): string {
  return p.server.env.length ? t('mcpConsent.env', { vars: p.server.env.join(', '), scopes: p.server.scopes.join(' + ') || t('mcpConsent.noScope') }) : t('mcpConsent.envNone')
}

/** #20: why an agent gets no repo servers. */
export function repoMcpReason(support: RepoMcpSupport, t: RendererT): string {
  if (support.supported) return ''
  return t(support.reason === 'cursor' ? 'repoMcp.reason.cursor' : support.reason === 'terminal' ? 'repoMcp.reason.terminal' : 'repoMcp.reason.unknown')
}

/** #20: how an agent gets them, for a chip's tooltip. */
function viaText(row: RepoMcpReachRow, t: RendererT): string {
  if (!row.support.supported) return t('repoMcp.reach.notSupportedTitle', { reason: repoMcpReason(row.support, t) })
  const via = row.support.via
  // G1: Cursor through its SDK, untested without a key.
  if (via === 'cursor') return t('g1.repoMcp.via.cursor', { agent: row.name })
  return t(via === 'sdk' ? 'repoMcp.reach.via.sdk' : via === 'config' ? 'repoMcp.reach.via.config' : 'repoMcp.reach.via.acp', { agent: row.name })
}

function useReach(): RepoMcpReachRow[] {
  return repoMcpReach(useSettings().agentPrefs)
}

/** "available to: Claude · Codex · OpenCode | Cursor: not supported" */
function ReachLine({ rows }: { rows: RepoMcpReachRow[] }) {
  const t = useT()
  const yes = rows.filter((r) => r.support.supported)
  const no = rows.filter((r) => !r.support.supported)
  return (
    <span className="mcp-reach">
      <span className="mcp-reach-label">{t('repoMcp.reach.availableTo')}</span>
      {yes.map((r, i) => (
        <span key={r.id} className="mcp-reach-yes">
          {i > 0 && <span className="faint">·</span>}
          <span className="mcp-agent" title={viaText(r, t)}>
            <AgentIcon agent={r.id} size={12} />
            {r.name}
          </span>
        </span>
      ))}
      {no.map((r) => (
        <span key={r.id} className="mcp-reach-no" title={viaText(r, t)}>
          <AgentIcon agent={r.id} size={12} />
          {t('repoMcp.reach.notSupported', { agent: r.name })}
        </span>
      ))}
    </span>
  )
}

export function McpConsentDialog({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const uid = useId()
  const reach = useReach()
  const [view, setView] = useState<RepoMcpView | null>(null)
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const close = () => openMcpConsent(null)

  useEffect(() => {
    void attempt(() => api.repoMcp(workspaceId)).then((next) => {
      if (!next) return
      setView(next)
      // Nothing is pre-approved: what was approved stays checked, everything else starts unchecked.
      setChecked(Object.fromEntries(next.proposals.map((p) => [p.server.name, p.state === 'approved'])))
    })
  }, [workspaceId])

  if (!view) return null
  const n = view.proposals.length
  // Not now (or Escape): nothing new is approved, what was approved stays, and it isn't asked again until something changes.
  const dismiss = () => {
    void attempt(() => api.approveRepoMcp(workspaceId, view.proposals.filter((p) => p.state === 'approved').map((p) => p.server.name)))
    close()
  }
  const save = async () => {
    setBusy(true)
    const names = view.proposals.filter((p) => checked[p.server.name]).map((p) => p.server.name)
    const done = await attempt(async () => (await api.approveRepoMcp(workspaceId, names), true))
    setBusy(false)
    if (done) close()
  }
  const supported = reach.filter((r) => r.support.supported).map((r) => r.name)
  // The reason is said once, here, rather than on every server.
  const reasons = [...new Set(reach.filter((r) => !r.support.supported).map((r) => repoMcpReason(r.support, t)))].join(' ')
  return (
    <Dialog
      title={t('mcpConsent.title', { count: n })}
      onClose={dismiss}
      size="lg"
      className="dlg"
      footer={
        <>
          <Button onClick={dismiss}>{t('mcpConsent.notNow')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {t('mcpConsent.approve')}
          </Button>
        </>
      }
    >
      <p className="small muted">
        {t.rich('mcpConsent.intro', { file: <code>{view.file ? view.file.split('/').slice(-2).join('/') : '.foreman/settings.toml'}</code> })}
      </p>
      <div className="mcp-consent-list">
        {view.proposals.map((p, i) => (
          <Checkbox
            key={p.server.name}
            className="mcp-consent-row"
            checked={Boolean(checked[p.server.name])}
            onChange={(e) => setChecked({ ...checked, [p.server.name]: e.target.checked })}
            aria-labelledby={`${uid}-${i}-name`}
            aria-describedby={`${uid}-${i}-detail`}
          >
            <span className="mcp-consent-text">
              <span>
                <b id={`${uid}-${i}-name`}>{p.server.name}</b>
                {p.state === 'changed' && <span className="mcp-changed"> {t('mcpConsent.changed')}</span>}
              </span>
              <span id={`${uid}-${i}-detail`} className="mcp-consent-detail">
                <span className="mono small mcp-consent-cmd">{commandLine(p)}</span>
                <span className="small faint">
                  {scopeText(p, t)}
                  {p.scripts.map((s) => (
                    <span key={s.path}>
                      {' · '}
                      {t('mcpConsent.runs', { path: s.path, hash: s.hash.slice(0, 8) })}
                    </span>
                  ))}
                  {p.missingEnv.length > 0 && <span> · {t('mcpConsent.notSet', { vars: p.missingEnv.join(', ') })}</span>}
                </span>
                <span className="small faint">{t('mcpConsent.fingerprint', { hash: p.fingerprint.slice(0, 8) })}</span>
              </span>
              <ReachLine rows={reach} />
            </span>
          </Checkbox>
        ))}
      </div>
      <Callout>{t('repoMcp.consent.note', { agents: new Intl.ListFormat(t.locale, { type: 'conjunction' }).format(supported), reason: reasons })}</Callout>
    </Dialog>
  )
}

/** The side panel's MCP section: each server the repo proposes, where it came from, whether it may run and which agents get it. */
export function McpSection({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const reach = useReach()
  const [view, setView] = useState<RepoMcpView | null>(null)
  const consent = useStore((s) => s.mcpConsent)
  // Re-read when the dialog closes (a new answer) and when the workspace's state changes (settings may have been edited).
  const stamp = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === workspaceId)?.state)
  // #20: the tab you're in, to say when it got a server.
  const tab = useStore((s) => {
    const id = activeSessionId(s, workspaceId)
    return s.snapshot!.sessions.find((x) => x.id === id)
  })
  useEffect(() => {
    let live = true
    void api.repoMcp(workspaceId).then((next) => live && setView(next)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [workspaceId, consent, stamp])
  if (!view?.proposals.length) return null
  const waiting = view.proposals.some((p) => p.state !== 'approved')
  const chipTitle = (row: RepoMcpReachRow, server: string): string => {
    const what = viaText(row, t)
    const got = tab?.agent === row.id && tab.repoMcp?.servers.includes(server) ? tab.repoMcp.at : undefined
    return got ? t('repoMcp.reach.gotAt', { what, time: formatClock(got, t.locale) }) : what
  }
  return (
    <div className="checks-group mcp-section">
      <div className="checks-head">
        MCP
        <span className="spacer" />
        {waiting && (
          <Button size="sm" onClick={() => openMcpConsent(workspaceId)}>
            {t('mcpConsent.review')}
          </Button>
        )}
      </div>
      {view.proposals.map((p) => (
        <div key={p.server.name}>
          <div className="row small mcp-section-row" title={commandLine(p)}>
            {/* The state is in the words after the name; the shape repeats it. */}
            <Glyph name={p.state === 'approved' ? 'ok' : 'warn'} />
            {p.server.name}
            <span className="faint">
              {' · '}
              {t('mcpConsent.origin')} · {p.state === 'approved' ? t('mcpConsent.state.approved') : p.state === 'changed' ? t('mcpConsent.state.changed') : t('mcpConsent.state.notApproved')}
            </span>
          </div>
          <div className="mcp-reach-box">
            {p.state === 'approved' ? (
              <div className="mcp-reach-row">
                {reach.map((r) => (
                  <Tag key={r.id} tone={r.support.supported ? 'neutral' : 'outline'} className={r.support.supported ? undefined : 'mcp-chip-off'} title={chipTitle(r, p.server.name)}>
                    <AgentIcon agent={r.id} size={11} />
                    {r.support.supported ? r.name : t('repoMcp.reach.off', { agent: r.name })}
                  </Tag>
                ))}
              </div>
            ) : (
              // A changed or new server reaches nobody, not even the agents that had the old version.
              <div className="mcp-reach-row faint">{t(p.state === 'changed' ? 'repoMcp.section.waitingChanged' : 'repoMcp.section.waitingNew')}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/** #20: an agent page's row saying whether that agent gets repo MCP servers, and how or why not. */
export function RepoMcpAgentRow({ agent, name }: { agent: string; name: string }) {
  const t = useT()
  const support = repoMcpSupport(agent)
  const text = support.supported
    ? support.via === 'cursor'
      ? t('g1.repoMcp.agent.cursor', { agent: name })
      : t(support.via === 'sdk' ? 'repoMcp.agent.sdk' : support.via === 'config' ? 'repoMcp.agent.config' : 'repoMcp.agent.acp', { agent: name })
    : repoMcpReason(support, t)
  return (
    <Row label={t('repoMcp.agent.label')} help={t('repoMcp.agent.help')} stacked>
      <div className={`small mcp-agent-reach ${support.supported ? '' : 'faint'}`}>
        <Glyph name={support.supported ? 'ok' : 'off'} /> {text}
      </div>
    </Row>
  )
}
