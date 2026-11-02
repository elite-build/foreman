// Connections, grouped by service. Each card says who the account is (as the service answered),
// whether it's the default, how many repositories use it and what agents may do with it.
import { MoreHorizontal, Plus } from 'lucide-react'
import { useState } from 'react'
import { AGENT_TOOL_SERVICES, INTEGRATION_SERVICES, isSandboxService, SANDBOX_SERVICES, type AgentAccess, type ConnectionView, type IntegrationService, type RepoIntegrationService } from '../../../../../shared/integrations'
import { useT } from '../../../i18n'
import { api, attempt, showToast, useStore } from '../../../store'
import { Button, LinkButton, MenuButton, MenuItem, Segmented, Spinner, Switch, Tag } from '../../../ui'
import { flashSaved } from '../controls'
import { AddConnectionDialog, LangfuseAccess, ReplaceTokenDialog } from './AddConnectionDialog'
import { RenameDialog, RemoveDialog, UseInReposDialog } from './ConnectionDialogs'
import { SERVICE_NAMES, ServiceMark } from './ServiceMark'
import { AddSandboxDialog, SandboxServiceCard } from './SandboxServiceCard'
import { AddVercelDialog, VercelCard } from './VercelCard'

export function ConnectionsTab() {
  const t = useT()
  const connections = useStore((s) => s.snapshot!.integrations.connections)
  const [adding, setAdding] = useState<IntegrationService | null>(null)
  // The sandbox services (remote workspaces) show once those are turned on, or while a connection to one exists, after GitHub as in the mocks.
  const cloudOn = useStore((s) => Boolean(s.snapshot!.settings.cloud?.enabled))
  const sandbox = SANDBOX_SERVICES.filter((service) => cloudOn || connections.some((c) => c.service === service))
  const services: IntegrationService[] = ['github', ...sandbox, ...INTEGRATION_SERVICES.filter((s) => s !== 'github')]
  return (
    <div className="int-connections">
      {services.map((service) => {
        const list = connections.filter((c) => c.service === service)
        return (
          <section key={service} className="int-service">
            <h2 className="int-service-head">
              <ServiceMark service={service} /> {SERVICE_NAMES[service]}
              <span className="int-service-hint">{t(`integrations.service.${service}.hint`)}</span>
            </h2>
            {list.map((c) =>
              service === 'vercel' ? <VercelCard key={c.id} connection={c} /> : isSandboxService(service) ? <SandboxServiceCard key={c.id} connection={c} /> : <ConnectionCard key={c.id} connection={c} cloudOn={cloudOn} />
            )}
            {!list.length && <p className="int-empty">{t(`integrations.service.${service}.empty`)}</p>}
            <Button icon={<Plus size={13} />} onClick={() => setAdding(service)}>
              {t(`integrations.add.${service}`)}
            </Button>
          </section>
        )
      })}
      {adding === 'vercel' ? (
        <AddVercelDialog onClose={() => setAdding(null)} />
      ) : adding && isSandboxService(adding) ? (
        <AddSandboxDialog service={adding} onClose={() => setAdding(null)} />
      ) : (
        adding && <AddConnectionDialog service={adding as RepoIntegrationService} onClose={() => setAdding(null)} />
      )}
    </div>
  )
}

/** "yatin-c · personal access token ••••x7Qa", "Yatin · Appsmith · linear.app/appsmith", "Foreman bot in Appsmith". */
function identityLine(c: ConnectionView, t: ReturnType<typeof useT>): string {
  const id = c.identity
  const key = c.hint !== undefined ? t('integrations.card.key', { hint: c.hint || '••••' }) : ''
  if (c.service === 'github') {
    if (c.auth.kind === 'gh-account') return t('integrations.card.ghAccount', { login: c.auth.login })
    if (c.auth.kind === 'gh-active') return id ? t('integrations.card.ghActiveAs', { login: id.user }) : t('integrations.card.ghActive')
    return [id?.user, t('integrations.card.pat'), key].filter(Boolean).join(' · ')
  }
  if (c.service === 'linear') return [id?.user, id?.org, id?.orgKey ? `linear.app/${id.orgKey}` : '', key].filter(Boolean).join(' · ')
  // "Kite · Appsmith · cloud.langfuse.com · key ••••x7Qa": the project, its organization and where it runs.
  if (c.service === 'langfuse') return [id?.org, id?.user !== id?.org ? id?.user : '', c.langfuse?.host.replace(/^https?:\/\//, ''), key].filter(Boolean).join(' · ')
  return [t('integrations.card.slackBot', { workspace: id?.org ?? 'Slack' }), c.slack?.me ? t('integrations.card.slackMe', { name: c.slack.me.name }) : ''].filter(Boolean).join(' · ')
}

function ConnectionCard({ connection: c, cloudOn }: { connection: ConnectionView; cloudOn: boolean }) {
  const t = useT()
  const [dialog, setDialog] = useState<'repos' | 'rename' | 'remove' | 'token' | 'slack' | null>(null)
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    const result = await attempt(() => api.checkConnection(c.id))
    setChecking(false)
    if (result) showToast(result.problem ? t('integrations.card.checkFailed', { name: c.name }) : t('integrations.card.checkOk', { name: c.name }))
  }
  const setAccess = async (agentAccess: AgentAccess) => {
    if (await attempt(() => api.updateConnection(c.id, { agentAccess }))) flashSaved()
  }
  return (
    <div className={`int-card ${c.problem ? 'bad' : ''}`}>
      <div className="int-card-main">
        <div className="int-card-name">
          <span className="int-card-title">{c.name}</span>
          {c.isDefault && <Tag tone="accent">{t('integrations.card.default')}</Tag>}
          {c.problem && <Tag tone="error">{t('integrations.card.needsAttention')}</Tag>}
        </div>
        <div className="int-card-who">{identityLine(c, t)}</div>
        {c.problem && <div className="int-card-problem">{t('integrations.card.problem', { problem: c.problem, count: c.usedBy })}</div>}
        {c.service === 'slack' && !c.slack?.me && !c.problem && (
          <div className="int-card-warn">
            {t('integrations.card.slackNoMe')}{' '}
            <LinkButton size="sm" onClick={() => setDialog('slack')}>
              {t('integrations.card.slackPickMe')}
            </LinkButton>
          </div>
        )}
        <div className="int-card-meta">
          <Tag tone="outline">{t('integrations.card.usedBy', { count: c.usedBy })}</Tag>
          {c.service === 'github' && <Tag tone="outline">{t('integrations.card.ghToken')}</Tag>}
          {/* Cloud workspaces clone with the repository's GitHub token; Linear and Slack tools don't reach a sandbox yet (PLAN §10). */}
          {cloudOn && c.service === 'github' && c.isDefault && <Tag tone="outline">{t('cloud.github.clones')}</Tag>}
          {cloudOn && c.service !== 'github' && <Tag tone="warn">{t('cloud.notInCloud')}</Tag>}
          {c.service === 'linear' && c.linearGithub !== undefined && (
            <Tag tone="outline" title={t('integrations.card.linearGithubHelp')}>
              {c.linearGithub ? t('integrations.card.linearGithubOn') : t('integrations.card.linearGithubOff')}
            </Tag>
          )}
          {c.service === 'slack' &&
            c.slack?.destinations.map((d) => (
              <Tag key={d.id} tone="outline">
                #{d.name}
              </Tag>
            ))}
        </div>
        {c.service === 'linear' && (
          <div className="int-card-access">
            <span className="int-card-access-label">{t('integrations.access.label')}</span>
            <Segmented
              small
              plain
              label={t('integrations.access.label')}
              value={c.agentAccess}
              onChange={(v) => void setAccess(v)}
              options={[
                { value: 'off', label: t('integrations.access.off') },
                { value: 'read', label: t('integrations.access.read') },
                { value: 'write', label: t('integrations.access.write') }
              ]}
            />
          </div>
        )}
        {c.service === 'langfuse' && (
          <div className="int-card-access">
            <span className="int-card-access-label">{t('integrations.access.label')}</span>
            <LangfuseAccess small value={c.agentAccess} onChange={(v) => void setAccess(v)} />
          </div>
        )}
        {c.service === 'slack' && <div className="int-card-access">
          <Switch checked={c.agentAccess === 'write'} onChange={(on) => void setAccess(on ? 'write' : 'off')} label={t('integrations.slack.agentPosting')} />
          <span>{t('integrations.slack.agentPosting')}</span>
          <span className="set-help">{t('integrations.slack.agentPostingHelp')}</span>
        </div>}
        {AGENT_TOOL_SERVICES.includes(c.service as RepoIntegrationService) && c.agentAccess !== 'off' && (
          <div className="int-card-access">
            <Switch checked={!c.startsOff} onChange={(on) => void attempt(() => api.updateConnection(c.id, { startsOff: !on })).then((r) => r && flashSaved())} label={t('integrations.starts.label')} />
            <span>{t('integrations.starts.label')}</span>
            <span className="set-help">{t('integrations.starts.help')}</span>
          </div>
        )}
      </div>
      <div className="int-card-actions">
        {c.problem && c.auth.kind === 'token' && (
          <Button size="sm" variant="primary" onClick={() => setDialog('token')}>
            {t('integrations.card.replaceKey')}
          </Button>
        )}
        <Button size="sm" onClick={() => setDialog('repos')}>
          {t('integrations.card.useIn')}
        </Button>
        <CardMenu
          items={[
            ...(!c.isDefault ? [{ label: t('integrations.card.makeDefault'), run: () => void attempt(() => api.setIntegrationDefault(c.service, c.id)).then(flashSaved) }] : []),
            { label: t('integrations.card.rename'), run: () => setDialog('rename') },
            ...(c.service === 'slack' ? [{ label: t('integrations.card.slackSettings'), run: () => setDialog('slack') }] : []),
            ...(c.auth.kind === 'token' ? [{ label: t('integrations.card.replaceKey'), run: () => setDialog('token') }] : []),
            { label: checking ? t('integrations.card.checking') : t('integrations.card.check'), run: () => void check() },
            { label: t('integrations.card.remove'), danger: true, run: () => setDialog('remove') }
          ]}
        />
        {checking && <Spinner size={13} label={t('integrations.card.checking')} />}
      </div>
      {dialog === 'repos' && <UseInReposDialog connection={c} onClose={() => setDialog(null)} />}
      {dialog === 'rename' && <RenameDialog connection={c} onClose={() => setDialog(null)} />}
      {dialog === 'remove' && <RemoveDialog connection={c} onClose={() => setDialog(null)} />}
      {dialog === 'token' && <ReplaceTokenDialog connection={c} onClose={() => setDialog(null)} />}
      {dialog === 'slack' && <AddConnectionDialog service="slack" existing={c} onClose={() => setDialog(null)} />}
    </div>
  )
}

export function CardMenu({ items }: { items: { label: string; run: () => void; danger?: boolean }[] }) {
  const t = useT()
  return (
    <MenuButton look="icon" label={t('integrations.card.more')} trigger={<MoreHorizontal size={14} />} menuClassName="int-card-menu">
      {items.map((item) => (
        <MenuItem key={item.label} variant={item.danger ? 'danger' : 'default'} onSelect={item.run}>
          {item.label}
        </MenuItem>
      ))}
    </MenuButton>
  )
}
