// Adding a connection. Every key is checked with its service before anything is saved, and the
// dialog shows who it belongs to, so a personal key can't be saved as the work one by mistake.
// Slack takes four steps: the app (from Foreman's manifest), its bot token, who "me" is, and
// where rules may post.
import { Copy, ExternalLink, Eye, EyeOff, Search, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { AddConnectionResult, AgentAccess, ConnectionView, RepoIntegrationService, SlackChannelView, SlackPersonView } from '../../../../../shared/integrations'
import { useT } from '../../../i18n'
import { api, attempt, showToast } from '../../../store'
import { Button, Callout, Checkbox, Combobox, Dialog, Field, IconButton, LinkButton, RadioList, Segmented, Select, Spinner, Tag, TextInput, type FieldControlProps } from '../../../ui'
import { flashSaved } from '../controls'
import { SERVICE_NAMES, ServiceMark } from './ServiceMark'

const TOKEN_LINKS: Record<RepoIntegrationService, string> = {
  github: 'https://github.com/settings/personal-access-tokens/new',
  linear: 'https://linear.app/settings/account/security',
  slack: 'https://api.slack.com/apps'
}

/** A secret being typed (a token or key): masked until the eye is pressed. Inside a `Field`, pass its `control` props so the field's label names it. */
export function SecretInput({
  value,
  onChange,
  label,
  placeholder,
  onEnter,
  control
}: {
  value: string
  onChange: (v: string) => void
  label: string
  placeholder?: string
  onEnter?: () => void
  control?: FieldControlProps
}) {
  const t = useT()
  const [shown, setShown] = useState(false)
  return (
    <div className="set-secret-input int-secret">
      <TextInput
        {...control}
        type={shown ? 'text' : 'password'}
        mono
        aria-label={control ? undefined : label}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
      />
      <IconButton label={shown ? t('integrations.add.hide') : t('integrations.add.show')} onClick={() => setShown(!shown)}>
        {shown ? <EyeOff size={14} /> : <Eye size={14} />}
      </IconButton>
    </div>
  )
}

function whoText(c: Pick<ConnectionView, 'service' | 'identity'>): string {
  const id = c.identity
  if (!id) return ''
  if (c.service === 'github') return id.user
  if (c.service === 'linear') return [id.user, id.email, id.org && `${id.org} (linear.app/${id.orgKey})`].filter(Boolean).join(' · ')
  return [id.user, id.org, id.url?.replace(/^https?:\/\//, '').replace(/\/$/, '')].filter(Boolean).join(' · ')
}

/** The dialog every connection form sits in: the service's mark beside the title, and the form's own buttons in the footer. */
function ConnectionDialog({ title, service, onClose, footer, children }: { title: string; service: RepoIntegrationService; onClose: () => void; footer: ReactNode; children: ReactNode }) {
  const t = useT()
  return (
    <Dialog title={title} size="lg" closeLabel={t('common.close')} onClose={onClose} headerExtra={<ServiceMark service={service} size={22} />} footer={footer}>
      {children}
    </Dialog>
  )
}

export function AddConnectionDialog({ service, existing, onClose }: { service: RepoIntegrationService; existing?: ConnectionView; onClose: () => void }) {
  if (service === 'github') return <AddGithub onClose={onClose} />
  if (service === 'linear') return <AddLinear onClose={onClose} />
  return <AddSlack existing={existing} onClose={onClose} />
}

// ---- GitHub: a gh account, or a token ----

function AddGithub({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [mode, setMode] = useState<'gh' | 'token'>('gh')
  const [accounts, setAccounts] = useState<{ login: string; active: boolean; connected: boolean }[] | null>(null)
  const [login, setLogin] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void api.ghAccountsForIntegrations().then((list) => {
      setAccounts(list)
      setLogin(list.find((a) => !a.connected)?.login ?? null)
      if (!list.some((a) => !a.connected)) setMode('token')
    }, () => setAccounts([]))
  }, [])
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const result =
        mode === 'gh'
          ? await api.addConnection({ service: 'github', name: name.trim() || undefined, auth: { kind: 'gh-account', login: login! } })
          : await api.addConnection({ service: 'github', name: name.trim() || undefined, auth: { kind: 'token' }, token: token.trim(), allowDuplicate: true })
      if (!result.ok) setError(result.error)
      else {
        flashSaved()
        showToast(t('integrations.add.added', { name: result.connection.name }))
        onClose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const free = accounts?.filter((a) => !a.connected) ?? []
  return (
    <ConnectionDialog
      title={t('integrations.add.github')}
      service="github"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || (mode === 'gh' ? !login : !token.trim())} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => void save()}>
            {t('integrations.add.save')}
          </Button>
        </>
      }
    >
      <div className="int-form">
        <Segmented
          label={t('integrations.github.how')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'gh', label: t('integrations.github.ghAccount'), disabled: !free.length, title: free.length ? undefined : t('integrations.github.noFreeAccounts') },
            { value: 'token', label: t('integrations.github.token') }
          ]}
        />
        {mode === 'gh' ? (
          <div className="field">
            {accounts === null ? (
              <>
                <span className="int-label">{t('integrations.github.pickAccount')}</span>
                <span className="muted small">
                  <Spinner size={12} /> {t('integrations.github.loading')}
                </span>
              </>
            ) : (
              <RadioList
                legend={t('integrations.github.pickAccount')}
                value={login ?? undefined}
                onChange={setLogin}
                options={accounts.map((a) => ({
                  value: a.login,
                  label: (
                    <>
                      {a.login}
                      {a.active && (
                        <>
                          {' '}
                          <Tag tone="outline">{t('integrations.github.active')}</Tag>
                        </>
                      )}
                    </>
                  ),
                  disabled: a.connected,
                  reason: a.connected ? t('integrations.github.alreadyAdded') : undefined
                }))}
              />
            )}
            <span className="set-help">{t.rich('integrations.github.ghHelp', { command: <code key="c">gh auth login</code> })}</span>
          </div>
        ) : (
          <Field
            label={t('integrations.github.tokenLabel')}
            description={
              <>
                {t('integrations.github.tokenHelp')}{' '}
                <LinkButton size="sm" onClick={() => void attempt(() => api.openExternal(TOKEN_LINKS.github))}>
                  {t('integrations.add.createKey')} <ExternalLink size={11} aria-hidden />
                </LinkButton>
              </>
            }
          >
            {(c) => <SecretInput control={c} value={token} onChange={setToken} label={t('integrations.github.tokenLabel')} placeholder="github_pat_…" onEnter={() => void save()} />}
          </Field>
        )}
        <Field label={t('integrations.add.name')}>
          {(c) => <TextInput {...c} className="wide" value={name} placeholder={t('integrations.add.namePlaceholder')} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <p className="set-help">{t('integrations.github.agentsNote')}</p>
        {error && <Callout tone="error" role="alert">{error}</Callout>}
      </div>
    </ConnectionDialog>
  )
}

// ---- Linear: a personal API key ----

function AddLinear({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [access, setAccess] = useState<AgentAccess>('read')
  const [makeDefault, setMakeDefault] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AddConnectionResult | null>(null)
  const save = async (allowDuplicate = false) => {
    setBusy(true)
    try {
      const r = await api.addConnection({ service: 'linear', name: name.trim() || undefined, auth: { kind: 'token' }, token: token.trim(), agentAccess: access, allowDuplicate })
      setResult(r)
      if (r.ok) {
        if (makeDefault && !r.connection.isDefault) await api.setIntegrationDefault('linear', r.connection.id)
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
  const duplicate = result && !result.ok && result.duplicateOf
  return (
    <ConnectionDialog
      title={t('integrations.add.linear')}
      service="linear"
      onClose={onClose}
      footer={
        <>
          <span className="set-help int-encrypted">{t('integrations.add.encrypted')}</span>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !token.trim()} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => void save()}>
            {t('integrations.add.checkSave')}
          </Button>
        </>
      }
    >
      <div className="int-form">
        <Field label={t('integrations.add.name')} description={t('integrations.add.nameHelp')}>
          {(c) => <TextInput {...c} className="wide" value={name} placeholder={t('integrations.linear.namePlaceholder')} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field
          label={t('integrations.linear.key')}
          description={
            <>
              {t('integrations.linear.keyHelp')}{' '}
              <LinkButton size="sm" onClick={() => void attempt(() => api.openExternal(TOKEN_LINKS.linear))}>
                {t('integrations.linear.open')} <ExternalLink size={11} aria-hidden />
              </LinkButton>
            </>
          }
          error={result && !result.ok && !duplicate ? result.error : undefined}
        >
          {(c) => (
            <SecretInput
              control={c}
              value={token}
              onChange={(v) => {
                setToken(v)
                setResult(null)
              }}
              label={t('integrations.linear.key')}
              placeholder="lin_api_…"
              onEnter={() => void save()}
            />
          )}
        </Field>
        {duplicate && result.identity && (
          <Callout
            tone="warn"
            actions={
              <>
                <Button
                  size="sm"
                  onClick={() => {
                    setToken('')
                    setResult(null)
                  }}
                >
                  {t('integrations.linear.pasteAnother')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void save(true)}>
                  {t('integrations.linear.addAnyway')}
                </Button>
              </>
            }
          >
            {t('integrations.linear.duplicate', { org: result.identity.org ?? '', name: result.duplicateOf ?? '' })}
          </Callout>
        )}
        <div className="field">
          <span className="int-label">{t('integrations.access.label')}</span>
          <Segmented
            label={t('integrations.access.label')}
            value={access}
            onChange={setAccess}
            options={[
              { value: 'off', label: t('integrations.access.off') },
              { value: 'read', label: t('integrations.access.read') },
              { value: 'write', label: t('integrations.access.write') }
            ]}
          />
          <span className="set-help">{t(`integrations.access.${access}Help`)}</span>
        </div>
        <Checkbox checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)}>
          {t('integrations.add.makeDefault', { service: 'Linear' })}
        </Checkbox>
      </div>
    </ConnectionDialog>
  )
}

// ---- Slack: the app, its token, who you are, where it may post ----

function AddSlack({ existing, onClose }: { existing?: ConnectionView; onClose: () => void }) {
  const t = useT()
  const [connection, setConnection] = useState<ConnectionView | null>(existing ?? null)
  const [token, setToken] = useState('')
  const [name, setName] = useState(existing?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [me, setMe] = useState<{ id: string; name: string } | null>(existing?.slack?.me ?? null)
  const [destinations, setDestinations] = useState(existing?.slack?.destinations ?? [])

  const manifest = async (copy: boolean) => {
    const m = await attempt(() => api.slackManifest())
    if (!m) return
    if (copy) {
      await navigator.clipboard.writeText(m.json).then(() => showToast(t('integrations.slack.manifestCopied')), () => showToast(t('integrations.slack.copyFailed'), 'error'))
    } else void attempt(() => api.openExternal(m.url))
  }
  const check = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.addConnection({ service: 'slack', name: name.trim() || undefined, auth: { kind: 'token' }, token: token.trim(), allowDuplicate: true })
      if (r.ok) {
        setConnection(r.connection)
        if (!name.trim()) setName(r.connection.name)
      } else setError(r.error)
    } finally {
      setBusy(false)
    }
  }
  const done = async () => {
    if (!connection) return onClose()
    setBusy(true)
    const saved = await attempt(() => api.updateConnection(connection.id, { name: name.trim() || connection.name, slackMe: me, destinations }))
    setBusy(false)
    if (saved?.ok) {
      flashSaved()
      if (!existing) showToast(t('integrations.add.added', { name: saved.connection.name }))
      onClose()
    } else if (saved && !saved.ok) setError(saved.error)
  }
  const cancel = () => {
    // Made in step 2 and abandoned: take it back out.
    if (connection && !existing) void attempt(() => api.removeConnection(connection.id))
    onClose()
  }

  return (
    <ConnectionDialog
      title={existing ? t('integrations.slack.editTitle', { name: existing.name }) : t('integrations.add.slack')}
      service="slack"
      onClose={onClose}
      footer={
        <>
          <Button onClick={cancel}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!connection || busy} onClick={() => void done()}>
            {t('integrations.add.save')}
          </Button>
        </>
      }
    >
      <div className="int-form">
        <ol className="int-steps">
          {!existing && (
            <li className="int-step">
              <span className="int-step-n">1</span>
              <div className="int-step-body">
                <b>{t('integrations.slack.step1')}</b>
                <div className="int-row">
                  <Button size="sm" onClick={() => void manifest(false)}>
                    {t('integrations.slack.createApp')} <ExternalLink size={11} aria-hidden />
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => void manifest(true)}>
                    {t('integrations.slack.copyManifest')}
                  </Button>
                </div>
                <span className="set-help">{t('integrations.slack.scopes')}</span>
              </div>
            </li>
          )}
          {!existing && (
            <li className="int-step">
              <span className={`int-step-n ${connection ? 'done' : ''}`}>{connection ? '✓' : '2'}</span>
              <div className="int-step-body">
                <b>{t('integrations.slack.step2')}</b>
                {connection ? (
                  <Callout tone="ok" role="status">
                    {whoText(connection)}
                  </Callout>
                ) : (
                  <div className="int-row">
                    <SecretInput value={token} onChange={setToken} label={t('integrations.slack.token')} placeholder="xoxb-…" onEnter={() => void check()} />
                    <Button size="sm" variant="primary" disabled={busy || !token.trim()} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => void check()}>
                      {t('integrations.slack.check')}
                    </Button>
                  </div>
                )}
                {error && <Callout tone="error" role="alert">{error}</Callout>}
              </div>
            </li>
          )}
          <li className={`int-step ${connection ? '' : 'waiting'}`}>
            <span className={`int-step-n ${me ? 'done' : ''}`}>{me ? '✓' : existing ? '1' : '3'}</span>
            <div className="int-step-body">
              <b>{t('integrations.slack.step3', { workspace: connection?.identity?.org ?? 'Slack' })}</b>
              {connection && <PersonPicker connectionId={connection.id} value={me} onChange={setMe} />}
              <span className="set-help">{t('integrations.slack.meHelp')}</span>
            </div>
          </li>
          <li className={`int-step ${connection ? '' : 'waiting'}`}>
            <span className="int-step-n">{existing ? '2' : '4'}</span>
            <div className="int-step-body">
              <b>
                {t('integrations.slack.step4')} <span className="muted">{t('integrations.slack.step4Optional')}</span>
              </b>
              {connection && <ChannelPicker connectionId={connection.id} value={destinations} onChange={setDestinations} />}
              <span className="set-help">{t('integrations.slack.privateHelp')}</span>
            </div>
          </li>
        </ol>
        {connection && (
          <Field label={t('integrations.add.name')}>
            {(c) => <TextInput {...c} className="wide" value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
        )}
      </div>
    </ConnectionDialog>
  )
}

/** Search the Slack workspace's people by name, handle or email; pick one. */
export function PersonPicker({ connectionId, value, onChange }: { connectionId: string; value: { id: string; name: string } | null; onChange: (p: { id: string; name: string } | null) => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [people, setPeople] = useState<SlackPersonView[]>([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (value || query.trim().length < 2) {
      setPeople([])
      return
    }
    let gone = false
    setLoading(true)
    const timer = setTimeout(() => {
      api.slackPeople(connectionId, query).then(
        (list) => !gone && setPeople(list),
        () => !gone && setPeople([])
      ).finally(() => !gone && setLoading(false))
    }, 250)
    return () => {
      gone = true
      clearTimeout(timer)
    }
  }, [connectionId, query, value])
  if (value)
    return (
      <div className="int-picked">
        <b>{value.name}</b>
        <IconButton label={t('integrations.slack.change')} onClick={() => onChange(null)}>
          <X size={13} />
        </IconButton>
      </div>
    )
  return (
    <Combobox
      inline
      autoFocus
      label={t('integrations.slack.searchPeople')}
      placeholder={t('integrations.slack.searchPeople')}
      query={query}
      onQueryChange={setQuery}
      leading={<Search size={13} aria-hidden />}
      trailing={loading ? <Spinner size={12} label={t('common.loading')} /> : undefined}
      options={people.map((p) => ({ value: p.id, label: p.name, description: `@${p.handle}${p.email ? ` · ${p.email}` : ''}` }))}
      onChange={(id) => {
        const p = people.find((x) => x.id === id)
        if (p) onChange({ id: p.id, name: p.name })
      }}
    />
  )
}

function ChannelPicker({ connectionId, value, onChange }: { connectionId: string; value: { id: string; name: string }[]; onChange: (v: { id: string; name: string }[]) => void }) {
  const t = useT()
  const [channels, setChannels] = useState<SlackChannelView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.slackChannels(connectionId).then(setChannels, (err: Error) => setError(err.message))
  }, [connectionId])
  const picked = new Set(value.map((d) => d.id))
  return (
    <div className="int-channels">
      <div className="int-row wrap">
        {value.map((d) => (
          <Tag key={d.id} className="int-chip">
            #{d.name}
            <IconButton label={t('integrations.slack.removeChannel', { name: d.name })} onClick={() => onChange(value.filter((x) => x.id !== d.id))}>
              <X size={11} />
            </IconButton>
          </Tag>
        ))}
      </div>
      {error ? (
        <Callout tone="error" role="alert">{error}</Callout>
      ) : channels === null ? (
        <Spinner size={12} label={t('common.loading')} />
      ) : (
        <Select
          label={t('integrations.slack.addChannel')}
          value=""
          options={[
            { value: '', label: t('integrations.slack.addChannel') },
            ...channels
              .filter((c) => !picked.has(c.id) && (c.member || !c.private))
              .map((c) => ({ value: c.id, label: `#${c.name}${c.member ? '' : ` ${t('integrations.slack.notMember')}`}` }))
          ]}
          onChange={(id) => {
            const c = channels.find((x) => x.id === id)
            if (c) onChange([...value, { id: c.id, name: c.name }])
          }}
        />
      )}
    </div>
  )
}

/** Replace a token or key: it must be the same account (a different one is a new connection). */
export function ReplaceTokenDialog({ connection, onClose }: { connection: ConnectionView; onClose: () => void }) {
  const t = useT()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.updateConnection(connection.id, { token: token.trim() })
      if (r.ok) {
        flashSaved()
        showToast(t('integrations.replace.done', { name: connection.name }))
        onClose()
      } else setError(r.error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={t('integrations.replace.title', { name: connection.name })}
      size="lg"
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !token.trim()} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => void save()}>
            {t('integrations.add.checkSave')}
          </Button>
        </>
      }
    >
      <div className="int-form">
        <Field label={t('integrations.replace.label')} description={t('integrations.replace.help', { service: SERVICE_NAMES[connection.service] })} error={error ?? undefined}>
          {(c) => <SecretInput control={c} value={token} onChange={setToken} label={t('integrations.replace.label')} onEnter={() => void save()} />}
        </Field>
      </div>
    </Dialog>
  )
}
