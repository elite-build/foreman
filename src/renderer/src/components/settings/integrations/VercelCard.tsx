// Settings → Integrations → Vercel: the team cloud workspaces'
// sandboxes run in. The card says who the token belongs to, the team and project, the plan and the limits
// that follow from it, and how many sandboxes run now. A rejected token turns it red; running sandboxes
// keep going until their session ends, and nothing new is made until the token is replaced.
import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { repoCloud } from '../../../../../shared/cloud'
import type { AddConnectionResult, ConnectionView } from '../../../../../shared/integrations'
import { connectionLimits, connectionPlan, repoProviderId, runningCloud, sessionCap, showsConcurrency } from '../../../cloudView'
import { useT } from '../../../i18n'
import { api, attempt, showToast, timeAgo, useStore } from '../../../store'
import { Button, Callout, Dialog, Field, LinkButton, Spinner, Status, Tag, TextInput } from '../../../ui'
import { flashSaved } from '../controls'
import { ReplaceTokenDialog, SecretInput } from './AddConnectionDialog'
import { RemoveDialog, RenameDialog } from './ConnectionDialogs'
import { CardMenu } from './ConnectionsTab'
import { ServiceMark } from './ServiceMark'
import '../../cloud/cloud.css'

const TOKEN_URL = 'https://vercel.com/account/settings/tokens'
// Vercel Sandbox's docs explain the team and project ids it needs.
const IDS_URL = 'https://vercel.com/docs/vercel-sandbox'

export function VercelCard({ connection: c }: { connection: ConnectionView }) {
  const t = useT()
  // Only Vercel's own: other providers' workspaces don't hold Vercel's slots.
  const running = useStore((s) => runningCloud(s.snapshot!.workspaces, 'vercel').length)
  const usedBy = useStore((s) =>
    s.snapshot!.repos
      .filter((r) => repoCloud(r).enabled && repoProviderId(r, s.snapshot!.integrations.connections) === 'vercel' && (!r.cloud?.connectionId || r.cloud.connectionId === c.id))
      .map((r) => r.name)
      .join(', ')
  )
  const [dialog, setDialog] = useState<'rename' | 'remove' | 'token' | null>(null)
  const [checking, setChecking] = useState(false)
  const limits = connectionLimits(c)
  const plan = t(`cloud.plan.${connectionPlan(c)}`)
  const cap = sessionCap(limits)
  const url = c.identity?.url
  const check = async () => {
    setChecking(true)
    const result = await attempt(() => api.checkConnection(c.id))
    setChecking(false)
    if (result) showToast(result.problem ? t('integrations.card.checkFailed', { name: c.name }) : t('integrations.card.checkOk', { name: c.name }), result.problem ? 'error' : 'info')
  }
  const who = t('cloud.vercel.who', {
    user: c.identity?.user ?? '',
    team: c.identity?.orgKey ?? c.identity?.org ?? c.vercel?.teamId ?? '',
    project: c.vercel?.projectId ?? '',
    hint: c.hint ?? '',
    ago: timeAgo(c.identity?.checkedAt)
  })
  return (
    <>
      <div className={`int-card ${c.problem ? 'bad' : ''}`}>
        <div className="int-card-main">
          <div className="int-card-name">
            <span className="int-card-title">{c.name}</span>
            {c.isDefault && <Tag tone="accent">{t('integrations.card.default')}</Tag>}
            {c.problem && <Tag tone="error">{t('cloud.vercel.rejected')}</Tag>}
          </div>
          {c.problem ? <div className="int-card-problem">{t('cloud.vercel.problem', { problem: c.problem })}</div> : <div className="int-card-who">{who}</div>}
          <div className="int-card-meta">
            <Tag tone="outline">{t('cloud.planChip', { plan })}</Tag>
            {c.problem ? (
              usedBy && <Tag tone="outline">{t('cloud.vercel.usedBy', { repos: usedBy })}</Tag>
            ) : (
              <>
                <Tag tone="outline">{cap.hours !== undefined ? t('cloud.sessionHours', { hours: cap.hours }) : t('cloud.sessionMinutes', { minutes: cap.minutes })}</Tag>
                <Tag tone="outline">{t('cloud.maxVcpus', { vcpus: limits.maxVcpus })}</Tag>
                <Tag tone="outline">
                  <Status tone={running ? 'ok' : 'off'} label={showsConcurrency(limits) ? t('cloud.runningOf', { running, limit: limits.maxConcurrent }) : t('cloud.runningCount', { count: running })} />
                </Tag>
              </>
            )}
          </div>
        </div>
        <div className="int-card-actions">
          {c.problem ? (
            <Button size="sm" variant="primary" onClick={() => setDialog('token')}>
              {t('cloud.vercel.replaceToken')}
            </Button>
          ) : (
            <>
              <Button size="sm" disabled={checking} icon={checking ? <Spinner size={12} /> : undefined} onClick={() => void check()}>
                {t('cloud.vercel.test')}
              </Button>
              {url && (
                <Button size="sm" onClick={() => void attempt(() => api.openExternal(url))}>
                  {t('cloud.action.openVercel')} <ExternalLink size={11} aria-hidden />
                </Button>
              )}
            </>
          )}
          <CardMenu
            items={[
              ...(!c.isDefault ? [{ label: t('integrations.card.makeDefault'), run: () => void attempt(() => api.setIntegrationDefault('vercel', c.id)).then(flashSaved) }] : []),
              { label: t('integrations.card.rename'), run: () => setDialog('rename') },
              { label: t('cloud.vercel.replaceToken'), run: () => setDialog('token') },
              { label: t('integrations.card.remove'), danger: true, run: () => setDialog('remove') }
            ]}
          />
        </div>
        {dialog === 'rename' && <RenameDialog connection={c} onClose={() => setDialog(null)} />}
        {dialog === 'remove' && <RemoveDialog connection={c} onClose={() => setDialog(null)} />}
        {dialog === 'token' && <ReplaceTokenDialog connection={c} onClose={() => setDialog(null)} />}
      </div>
      {/* The one honest caveat for Hobby: an unattended turn can't outlast one short session. */}
      {c.isDefault && !c.problem && connectionPlan(c) === 'hobby' && cap.minutes !== undefined && <Callout tone="warn">{t('cloud.vercel.hobbyNote', { minutes: cap.minutes })}</Callout>}
    </>
  )
}

/** Add Vercel team: token, team id and project id, checked with Vercel before anything is saved. */
export function AddVercelDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [teamId, setTeamId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AddConnectionResult | null>(null)
  const ready = Boolean(token.trim() && teamId.trim() && projectId.trim())
  const save = async (allowDuplicate = false) => {
    if (!ready || busy) return
    setBusy(true)
    try {
      const r = await api.addConnection({ service: 'vercel', name: name.trim() || undefined, auth: { kind: 'token' }, token: token.trim(), vercel: { teamId: teamId.trim(), projectId: projectId.trim() }, allowDuplicate })
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
  return (
    <Dialog
      title={t('integrations.add.vercel')}
      size="lg"
      closeLabel={t('common.close')}
      onClose={onClose}
      headerExtra={<ServiceMark service="vercel" size={22} />}
      footer={
        <>
          <span className="set-help int-encrypted">{t('integrations.add.encrypted')}</span>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !ready} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => void save()}>
            {t('integrations.add.checkSave')}
          </Button>
        </>
      }
    >
      <div className="int-form">
        <Field label={t('cloud.add.token')} description={<>{t('cloud.add.tokenHelp')} {link(t('cloud.add.createToken'), TOKEN_URL)}</>}>
          {(c) => (
            <SecretInput
              control={c}
              value={token}
              onChange={(v) => {
                setToken(v)
                edited()
              }}
              label={t('cloud.add.token')}
              onEnter={() => void save()}
            />
          )}
        </Field>
        <Field label={t('cloud.add.team')} description={<>{t('cloud.add.teamHelp')} {link(t('cloud.add.docs'), IDS_URL)}</>}>
          {(c) => (
            <TextInput
              {...c}
              className="wide"
              mono
              spellCheck={false}
              autoComplete="off"
              placeholder="team_…"
              value={teamId}
              onChange={(e) => {
                setTeamId(e.target.value)
                edited()
              }}
            />
          )}
        </Field>
        <Field label={t('cloud.add.project')} description={t('cloud.add.projectHelp')}>
          {(c) => (
            <TextInput
              {...c}
              className="wide"
              mono
              spellCheck={false}
              autoComplete="off"
              placeholder="prj_…"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value)
                edited()
              }}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
            />
          )}
        </Field>
        <Field label={t('integrations.add.name')} description={t('integrations.add.nameHelp')}>
          {(c) => <TextInput {...c} className="wide" value={name} placeholder={t('cloud.add.namePlaceholder')} onChange={(e) => setName(e.target.value)} />}
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
            {t('cloud.add.duplicate', { name: result.duplicateOf ?? '' })}
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
