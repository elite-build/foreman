// Repository settings → Integrations: which GitHub, Linear and Slack connection this repository
// uses (the default, another one, or off), where that comes from, and anything that changes what
// agents really get. A chosen connection that can't be used stops here; nothing falls back to
// another account. Kept on this Mac, never in settings.toml.
import { Plug } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { resolvedConnection, type BridgeActivity, type RepoIntegrationService, type RepoServiceView } from '../../../../../shared/integrations'
import { formatClock } from '../../../../../shared/i18n/time'
import type { Repo } from '../../../../../shared/types'
import { useT } from '../../../i18n'
import { api, attempt, openSettingsPage, useStore } from '../../../store'
import { Button, Callout, Select, Status, Switch, type StatusTone } from '../../../ui'
import { flashSaved, rowDomId, Section } from '../controls'
import { SERVICE_NAMES, ServiceMark } from './ServiceMark'
import './integrations.css'

const ROW_IDS: Record<RepoIntegrationService, string> = { github: 'repo-github-account', linear: 'repo-linear', slack: 'repo-slack' }

export function RepoIntegrationsTab({ repo }: { repo: Repo }) {
  const t = useT()
  const integrations = useStore((s) => s.snapshot!.integrations)
  const [views, setViews] = useState<RepoServiceView[] | null>(null)
  const [activity, setActivity] = useState<BridgeActivity[]>([])
  // Re-read when connections or this repository's choices change.
  const stamp = JSON.stringify([integrations.connections.map((c) => [c.id, c.rev, c.problem, c.agentAccess]), repo.integrations])
  const load = useCallback(() => {
    void api.repoIntegrations(repo.id).then(setViews, () => setViews([]))
    void api.integrationActivity(repo.id).then(setActivity, () => setActivity([]))
  }, [repo.id])
  useEffect(load, [load, stamp])
  const suggestion = integrations.suggestions[repo.id]
  return (
    <>
      {suggestion && <SuggestionBanner repo={repo} owner={suggestion.owner} services={suggestion.services} />}
      <div className="int-repo-services">{views?.map((v) => <ServiceRow key={v.service} repo={repo} view={v} />)}</div>
      {views && <Coverage views={views} />}
      {activity.length > 0 && (
        <Section title={t('integrations.repo.activity')} plain>
          <div className="int-log">
            {activity.slice(0, 20).map((a, i) => (
              <div key={i} className="int-log-row">
                <span className="int-log-time">{formatClock(a.at, t.locale)}</span>
                <Status className="int-status" tone={a.ok ? 'ok' : 'error'} label={a.ok ? t('integrations.repo.ok') : t('integrations.repo.refused')} />
                <span className="grow">
                  {SERVICE_NAMES[a.service]} · <span className="mono">{a.tool}</span>
                  {a.error && <span className="muted"> · {a.error}</span>}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

function SuggestionBanner({ repo, owner, services }: { repo: Repo; owner: string; services: Partial<Record<RepoIntegrationService, string>> }) {
  const t = useT()
  const connections = useStore((s) => s.snapshot!.integrations.connections)
  const names = Object.values(services).map((id) => connections.find((c) => c.id === id)?.name).filter(Boolean).join(', ')
  return (
    <div className="int-suggest">
      <Plug size={14} />
      <span className="grow">{t('integrations.suggest.text', { owner, names })}</span>
      <Button size="sm" variant="primary" onClick={() => void attempt(() => api.acceptIntegrationSuggestion(repo.id)).then(flashSaved)}>
        {t('integrations.suggest.use')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.setRepoIntegrationOptions(repo.id, { dismissSuggestion: true }))}>
        {t('integrations.suggest.notNow')}
      </Button>
    </div>
  )
}

function ServiceRow({ repo, view }: { repo: Repo; view: RepoServiceView }) {
  const t = useT()
  const all = useStore((s) => s.snapshot!.integrations.connections)
  const connections = all.filter((c) => c.service === view.service)
  const defaultConn = connections.find((c) => c.isDefault)
  const r = view.resolution
  const c = resolvedConnection(r)
  const choose = async (choice: string) => {
    if ((await attempt(async () => (await api.setRepoIntegration(repo.id, view.service, choice), true))) !== undefined) flashSaved()
  }
  const allowOwn = async (on: boolean) => {
    const current = repo.integrations?.allowOwnMcp ?? []
    const next = on ? [...new Set([...current, view.service])] : current.filter((s) => s !== view.service)
    if ((await attempt(async () => (await api.setRepoIntegrationOptions(repo.id, { allowOwnMcp: next }), true))) !== undefined) flashSaved()
  }
  const status: { tone: StatusTone; text: string } =
    r.state === 'ready' || r.state === 'env'
      ? { tone: 'ok', text: t('integrations.repo.ready') }
      : r.state === 'none'
        ? { tone: 'off', text: r.off ? t('integrations.repo.offState') : t('integrations.repo.notSet') }
        : { tone: 'error', text: r.reason === 'env-conflict' ? t('integrations.repo.unavailable') : r.reason === 'missing' ? t('integrations.repo.removedState') : t('integrations.repo.needsAttention') }
  const own = view.ownServers.filter((s) => s.from !== 'claude.ai')
  const governs = r.state === 'ready' || r.state === 'broken'
  return (
    <div id={rowDomId(ROW_IDS[view.service])} className="int-svc-row">
      <div className="int-svc-head">
        <ServiceMark service={view.service} />
        <span className="int-svc-name">{SERVICE_NAMES[view.service]}</span>
        <Select
          className="int-svc-select"
          label={t('integrations.repo.choice', { service: SERVICE_NAMES[view.service] })}
          value={view.choice}
          onChange={(v) => void choose(v)}
          options={[
            { value: 'default', label: defaultConn ? t('integrations.repo.defaultIs', { name: defaultConn.name }) : t('integrations.repo.defaultNone') },
            ...connections.map((x) => ({ value: x.id, label: x.name })),
            { value: 'off', label: t('integrations.repo.off') },
            ...(view.choice !== 'default' && view.choice !== 'off' && !connections.some((x) => x.id === view.choice) ? [{ value: view.choice, label: t('integrations.repo.removed') }] : [])
          ]}
        />
        <span className="grow" />
        <Status tone={status.tone} label={status.text} />
      </div>
      <div className="int-svc-detail">
        {r.state === 'ready' && <span>{detailLine(view.service, r.connection, t)}</span>}
        {r.state === 'env' && <span>{t('integrations.repo.envToken', { from: view.envToken ?? '' })}</span>}
        {r.state === 'none' && !r.off && <span>{t(`integrations.repo.none.${view.service}`)}</span>}
        {r.state === 'none' && r.off && <span>{t('integrations.repo.offHelp')}</span>}
        {view.service === 'slack' && (r.state === 'ready' || r.state === 'none') && (
          <span className="int-inline">
            {t('integrations.repo.rules')}
            <Select<'mine' | 'off'>
              label={t('integrations.repo.rules')}
              value={repo.integrations?.rules ?? 'mine'}
              options={[
                { value: 'mine', label: t('integrations.repo.rulesMine') },
                { value: 'off', label: t('integrations.repo.rulesOff') }
              ]}
              onChange={(v) => void attempt(() => api.setRepoIntegrationOptions(repo.id, { rules: v })).then(flashSaved)}
            />
          </span>
        )}
      </div>
      {view.service === 'github' && repo.integrations?.githubSuggestion && (
        <Callout tone="info">{t('integrations.repo.detected', { name: all.find((x) => x.id === repo.integrations?.githubSuggestion)?.name ?? '' })}</Callout>
      )}
      {r.state === 'broken' && r.reason === 'env-conflict' && (
        <Callout
          tone="error"
          actions={
            <>
              <Button size="sm" onClick={() => void attempt(() => api.importRepoGithubToken(repo.id)).then((res) => res?.ok && flashSaved())}>
                {t('integrations.repo.makeConnection')}
              </Button>
              <Button size="sm" onClick={() => openSettingsPage({ section: 'repo', repoId: repo.id, tab: 'environment', scrollTo: 'repo-environment-variables' })}>
                {t('integrations.repo.openEnvironment')}
              </Button>
            </>
          }
        >
          {t('integrations.repo.conflict', { from: view.envToken ?? '', name: c?.name ?? '' })}
        </Callout>
      )}
      {r.state === 'broken' && r.reason !== 'env-conflict' && (
        <Callout
          tone="error"
          actions={
            <Button size="sm" onClick={() => openSettingsPage({ section: 'integrations' })}>
              {t('integrations.repo.openIntegrations')}
            </Button>
          }
        >
          {r.reason === 'missing' ? t('integrations.repo.brokenMissing', { service: SERVICE_NAMES[view.service] }) : t('integrations.repo.brokenProblem', { service: SERVICE_NAMES[view.service], name: c?.name ?? '', problem: c?.problem ?? '' })}
        </Callout>
      )}
      {view.sshRemote && r.state === 'ready' && <Callout tone="info">{t('integrations.repo.ssh')}</Callout>}
      {governs && own.length > 0 && (
        <Callout
          tone="info"
          actions={
            <>
              <Switch checked={view.ownAllowed} onChange={(v) => void allowOwn(v)} label={t('integrations.repo.letOwnRun')} /> {t('integrations.repo.letOwnRun')}
            </>
          }
        >
          {view.ownAllowed
            ? t('integrations.repo.ownAllowed', { names: own.map((s) => s.name).join(', ') })
            : t('integrations.repo.ownOff', { names: own.map((s) => s.name).join(', '), service: SERVICE_NAMES[view.service] })}
        </Callout>
      )}
    </div>
  )
}

function detailLine(service: RepoIntegrationService, c: NonNullable<ReturnType<typeof resolvedConnection>>, t: ReturnType<typeof useT>): string {
  const who = [c.identity?.user, c.identity?.org].filter(Boolean).join(' · ')
  if (service === 'github') return t('integrations.repo.githubDetail', { who: who || c.name })
  if (service === 'linear') return t(`integrations.repo.linearDetail.${c.agentAccess}`, { who: who || c.name })
  return t('integrations.repo.slackDetail', { who: c.identity?.org ?? c.name })
}

/** What each kind of agent really gets here, including the ones that get less. */
function Coverage({ views }: { views: RepoServiceView[] }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const github = views.find((v) => v.service === 'github')!.resolution
  const linear = views.find((v) => v.service === 'linear')!.resolution
  const gh =
    github.state === 'ready'
      ? github.connection.name
      : github.state === 'env'
        ? t('integrations.coverage.repoToken')
        : github.state === 'broken'
          ? t('integrations.coverage.blocked')
          : github.off
            ? t('integrations.coverage.notGiven')
            : t('integrations.coverage.ghLogin')
  const ln = platform !== 'win32' && linear.state === 'ready' && linear.connection.agentAccess !== 'off' ? `${linear.connection.name}${linear.connection.agentAccess === 'read' ? ` · ${t('integrations.access.read')}` : ''}` : null
  const rows: { agent: string; gh: string; ln: string; note: string; tone?: 'amber' }[] = [
    { agent: 'Claude Code', gh, ln: ln ?? '—', note: t('integrations.coverage.claude') },
    { agent: 'Codex', gh, ln: ln ?? '—', note: t('integrations.coverage.codex') },
    { agent: t('integrations.coverage.acp'), gh, ln: ln ?? '—', note: t('integrations.coverage.acpNote') },
    { agent: 'Cursor', gh, ln: ln ? t('integrations.coverage.untested') : '—', note: t('integrations.coverage.cursor'), tone: 'amber' },
    { agent: t('integrations.coverage.terminal'), gh, ln: '—', note: t('integrations.coverage.terminalNote') },
    { agent: t('integrations.coverage.kept'), gh, ln: ln ? t('integrations.coverage.paused') : '—', note: t('integrations.coverage.keptNote') }
  ]
  return (
    <Section title={t('integrations.coverage.title')} plain>
      {platform === 'win32' && <p className="set-help">{t('integrations.coverage.windows')}</p>}
      <table className="int-table">
        <thead>
          <tr>
            <th>{t('integrations.coverage.agent')}</th>
            <th>GitHub</th>
            <th>{t('integrations.coverage.linear')}</th>
            <th>{t('integrations.coverage.notes')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.agent}>
              <td>{row.agent}</td>
              <td>{row.gh}</td>
              <td className={row.tone === 'amber' && ln ? 'amber' : undefined}>{row.ln}</td>
              <td className="muted">{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}
