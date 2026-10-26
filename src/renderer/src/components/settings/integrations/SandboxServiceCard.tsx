// Settings → Integrations → Docker, E2B and Daytona: the sandbox
// services remote workspaces can run on besides Vercel (VercelCard keeps Vercel's team, project and plan).
// A card says what the connection points at (a Docker context or host, an API URL), who it was checked as,
// its limits as the provider reports them and how many of its sandboxes run now; a rejected key turns it
// red. Until a provider's module is implemented (CLOUD_PROVIDERS[id].implemented) it says "coming soon",
// and adding one is refused before anything is checked.
import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { cloudProvider, type CloudProviderId } from '../../../../../shared/cloud'
import { DAYTONA_API_URL, type AddConnectionResult, type ConnectionView, type NewConnection } from '../../../../../shared/integrations'
import { runningCloud } from '../../../cloudView'
import { useT } from '../../../i18n'
import { api, attempt, showToast, timeAgo, useStore } from '../../../store'
import { Button, Callout, Dialog, Field, LinkButton, Spinner, Status, Tag, TextInput } from '../../../ui'
import { flashSaved } from '../controls'
import { ReplaceTokenDialog, SecretInput } from './AddConnectionDialog'
import { RemoveDialog, RenameDialog } from './ConnectionDialogs'
import { CardMenu } from './ConnectionsTab'
import { ServiceMark } from './ServiceMark'
import '../../cloud/cloud.css'

/** The sandbox services this card is for: everything but Vercel. */
export type OtherSandboxService = Exclude<CloudProviderId, 'vercel'>

// Where each service's key comes from.
const KEY_URL: Record<OtherSandboxService, string | undefined> = {
  docker: undefined,
  e2b: 'https://e2b.dev/dashboard?tab=keys',
  daytona: 'https://app.daytona.io/dashboard/keys'
}

/** "docker context desktop-linux · Docker 27.3 · checked 2 min ago", "Acme · key ••••x7Qa · checked …". */
function whoLine(c: ConnectionView, t: ReturnType<typeof useT>): string {
  const checked = c.identity?.checkedAt ? t('cloud.provider.checked', { ago: timeAgo(c.identity.checkedAt) }) : ''
  if (c.service === 'docker') {
    const target = c.docker?.host ? c.docker.host : t('cloud.provider.dockerContext', { context: c.docker?.context || 'default' })
    return [target, c.docker?.serverVersion ? `Docker ${c.docker.serverVersion}` : '', checked].filter(Boolean).join(' · ')
  }
  const key = c.hint !== undefined ? t('integrations.card.key', { hint: c.hint || '••••' }) : ''
  const where = c.service === 'daytona' && c.daytona?.apiUrl && c.daytona.apiUrl !== DAYTONA_API_URL ? c.daytona.apiUrl : c.service === 'e2b' ? c.e2b?.domain : undefined
  return [c.identity?.org ?? c.identity?.user, where, key, checked].filter(Boolean).join(' · ')
}

export function SandboxServiceCard({ connection: c }: { connection: ConnectionView }) {
  const t = useT()
  const service = c.service as OtherSandboxService
  const info = cloudProvider(service)
  const running = useStore((s) => runningCloud(s.snapshot!.workspaces, service).length)
  const [dialog, setDialog] = useState<'rename' | 'remove' | 'token' | null>(null)
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    const result = await attempt(() => api.checkConnection(c.id))
    setChecking(false)
    if (result) showToast(result.problem ? t('integrations.card.checkFailed', { name: c.name }) : t('integrations.card.checkOk', { name: c.name }), result.problem ? 'error' : 'info')
  }
  const url = c.identity?.url
  return (
    <div className={`int-card ${c.problem ? 'bad' : ''}`}>
      <div className="int-card-main">
        <div className="int-card-name">
          <span className="int-card-title">{c.name}</span>
          {c.isDefault && <Tag tone="accent">{t('integrations.card.default')}</Tag>}
          {!info.implemented && <Tag tone="outline">{t('cloud.repo.provider.soonTag')}</Tag>}
          {c.problem && <Tag tone="error">{t('integrations.card.needsAttention')}</Tag>}
        </div>
        {c.problem ? <div className="int-card-problem">{t('cloud.provider.problem', { problem: c.problem, provider: info.label })}</div> : <div className="int-card-who">{whoLine(c, t)}</div>}
        <div className="int-card-meta">
          <Tag tone="outline">{info.kind === 'local' ? t('cloud.repo.provider.local') : t('cloud.repo.provider.hosted')}</Tag>
          <Tag tone="outline">
            <Status tone={running ? 'ok' : 'off'} label={t('cloud.runningCount', { count: running })} />
          </Tag>
        </div>
      </div>
      <div className="int-card-actions">
        {c.problem && c.auth.kind === 'token' ? (
          <Button size="sm" variant="primary" onClick={() => setDialog('token')}>
            {t('integrations.card.replaceKey')}
          </Button>
        ) : (
          <>
            <Button size="sm" disabled={checking || !info.implemented} icon={checking ? <Spinner size={12} /> : undefined} onClick={() => void check()}>
              {t('cloud.vercel.test')}
            </Button>
            {url && (
              <Button size="sm" onClick={() => void attempt(() => api.openExternal(url))}>
                {t('cloud.action.openProvider', { provider: info.label })} <ExternalLink size={11} aria-hidden />
              </Button>
            )}
          </>
        )}
        <CardMenu
          items={[
            ...(!c.isDefault ? [{ label: t('integrations.card.makeDefault'), run: () => void attempt(() => api.setIntegrationDefault(service, c.id)).then(flashSaved) }] : []),
            { label: t('integrations.card.rename'), run: () => setDialog('rename') },
            ...(c.auth.kind === 'token' ? [{ label: t('integrations.card.replaceKey'), run: () => setDialog('token') }] : []),
            { label: t('integrations.card.remove'), danger: true, run: () => setDialog('remove') }
          ]}
        />
      </div>
      {dialog === 'rename' && <RenameDialog connection={c} onClose={() => setDialog(null)} />}
      {dialog === 'remove' && <RemoveDialog connection={c} onClose={() => setDialog(null)} />}
      {dialog === 'token' && <ReplaceTokenDialog connection={c} onClose={() => setDialog(null)} />}
    </div>
  )
}

/**
 * Add Docker (a context or a DOCKER_HOST, no secret), E2B (an API key, and a domain when self-hosted) or Daytona (an API
 * key, the API URL and a target region). Checked with the service before anything is saved.
 */
export function AddSandboxDialog({ service, onClose }: { service: OtherSandboxService; onClose: () => void }) {
  const t = useT()
  const info = cloudProvider(service)
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  // Docker: context or host. E2B: domain. Daytona: API URL and target.
  const [first, setFirst] = useState(service === 'daytona' ? DAYTONA_API_URL : '')
  const [second, setSecond] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AddConnectionResult | null>(null)
  const docker = service === 'docker'
  const ready = info.implemented && (docker || Boolean(token.trim()))
  const input = (allowDuplicate: boolean): NewConnection => {
    const base = { name: name.trim() || undefined, allowDuplicate }
    if (service === 'docker') return { ...base, service, auth: { kind: 'docker-context' }, docker: { ...(first.trim() ? { context: first.trim() } : {}), ...(second.trim() ? { host: second.trim() } : {}) } }
    if (service === 'e2b') return { ...base, service, auth: { kind: 'token' }, token: token.trim(), e2b: first.trim() ? { domain: first.trim() } : {} }
    return { ...base, service, auth: { kind: 'token' }, token: token.trim(), daytona: { apiUrl: first.trim() || DAYTONA_API_URL, ...(second.trim() ? { target: second.trim() } : {}) } }
  }
  const save = async (allowDuplicate = false) => {
    if (!ready || busy) return
    setBusy(true)
    try {
      const r = await api.addConnection(input(allowDuplicate))
      setResult(r)
      if (r.ok) {
        flashSaved()
        showToast(t('integrations.add.added', { name: r.connection.name }))
        onClose()
      }
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }
  const edited = () => setResult(null)
  const duplicate = result && !result.ok && result.duplicateOf
  const link = (label: string, href: string) => (
    <LinkButton size="sm" onClick={() => void attempt(() => api.openExternal(href))}>
      {label} <ExternalLink size={11} aria-hidden />
    </LinkButton>
  )
  const field = (label: string, value: string, set: (v: string) => void, help: string, placeholder?: string) => (
    <Field label={label} description={help}>
      {(c) => (
        <TextInput
          {...c}
          className="wide"
          mono
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            set(e.target.value)
            edited()
          }}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
        />
      )}
    </Field>
  )
  const keyUrl = KEY_URL[service]
  return (
    <Dialog
      title={t(`integrations.add.${service}`)}
      size="lg"
      closeLabel={t('common.close')}
      onClose={onClose}
      headerExtra={<ServiceMark service={service} size={22} />}
      footer={
        <>
          {!docker && <span className="set-help int-encrypted">{t('integrations.add.encrypted')}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !ready} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => void save()}>
            {t('integrations.add.checkSave')}
          </Button>
        </>
      }
    >
      <div className="int-form">
        {!info.implemented && <Callout tone="warn">{t('cloud.provider.soonAdd', { provider: info.label })}</Callout>}
        {docker ? (
          <>
            {field(t('cloud.add.dockerContext'), first, setFirst, t('cloud.add.dockerContextHelp'), 'default')}
            {field(t('cloud.add.dockerHost'), second, setSecond, t('cloud.add.dockerHostHelp'), 'ssh://user@host')}
          </>
        ) : (
          <>
            <Field label={t('cloud.add.apiKey')} description={<>{t('cloud.add.apiKeyHelp', { provider: info.label })} {keyUrl && link(t('cloud.add.createKey'), keyUrl)}</>}>
              {(c) => (
                <SecretInput
                  control={c}
                  value={token}
                  onChange={(v) => {
                    setToken(v)
                    edited()
                  }}
                  label={t('cloud.add.apiKey')}
                  placeholder={info.connection.fields.find((f) => f.secret)?.placeholder}
                  onEnter={() => void save()}
                />
              )}
            </Field>
            {service === 'e2b' && field(t('cloud.add.e2bDomain'), first, setFirst, t('cloud.add.e2bDomainHelp'), 'e2b.app')}
            {service === 'daytona' && (
              <>
                {field(t('cloud.add.daytonaUrl'), first, setFirst, t('cloud.add.daytonaUrlHelp'), DAYTONA_API_URL)}
                {field(t('cloud.add.daytonaTarget'), second, setSecond, t('cloud.add.daytonaTargetHelp'), 'us')}
              </>
            )}
          </>
        )}
        <Field label={t('integrations.add.name')} description={<>{t('integrations.add.nameHelp')} {link(t('cloud.add.docs'), info.docsUrl)}</>}>
          {(c) => <TextInput {...c} className="wide" value={name} placeholder={info.label} onChange={(e) => setName(e.target.value)} />}
        </Field>
        {duplicate && (
          <Callout
            tone="warn"
            actions={
              <Button size="sm" variant="ghost" onClick={() => void save(true)}>
                {t('cloud.add.addAnyway')}
              </Button>
            }
          >
            {t('cloud.provider.duplicate', { name: result.duplicateOf ?? '' })}
          </Callout>
        )}
        {result && !result.ok && !duplicate && (
          <Callout tone="error" role="alert">
            {result.error}
          </Callout>
        )}
      </div>
    </Dialog>
  )
}
