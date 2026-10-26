// O2: Settings → Git → Accounts. One row per host: GitHub as it is today (gh or a
// token, set up in Account & privacy), then gitlab.com and each self-managed GitLab
// host with its own token. A token is tested before it's saved and never comes
// back to the renderer; it is only ever sent to its own host.
import { ChevronDown, ChevronRight, CircleCheck, ExternalLink, Eye, EyeOff, KeyRound, Plus, RefreshCw, SquareTerminal, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { GithubStatus, GitlabConnection, GitlabHostRow } from '../../../../shared/types'
import { api, attempt, openSettingsPage } from '../../store'
import { useT } from '../../i18n'
import { Button, IconButton, LinkButton, Spinner, Status, Tag, TextInput, type StatusTone } from '../../ui'
import { GithubMark, GitlabMark } from '../GitlabMark'
import { flashSaved, rowDomId, Section } from './controls'

export function ScmAccounts() {
  const t = useT()
  const [rows, setRows] = useState<{ hosts: GitlabHostRow[]; glab: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const load = useCallback(async () => {
    try {
      setRows(await api.gitlabHosts())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <Section title={t('gitlab.accounts.title')} description={t('gitlab.accounts.description')} plain>
      <div id={rowDomId('gitlab-accounts')} className="scm-accounts">
        <GithubRow />
        {rows?.hosts.map((row) => <GitlabRow key={row.host} row={row} glab={rows.glab} onChanged={() => void load()} />)}
        {error && <p className="set-status-detail warn scm-account">{t('gitlab.accounts.loadError', { message: error })}</p>}
        {adding ? (
          <AddHost
            onDone={() => {
              setAdding(false)
              void load()
            }}
          />
        ) : (
          <div className="scm-add">
            <Button size="sm" icon={<Plus size={12} />} onClick={() => setAdding(true)}>
              {t('gitlab.accounts.add')}
            </Button>
            <span className="set-help">{t('gitlab.accounts.addHint')}</span>
          </div>
        )}
      </div>
    </Section>
  )
}

/** github.com, unchanged: the same status Account & privacy shows, with a way there. */
function GithubRow() {
  const t = useT()
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setStatus(await api.githubStatus())
    } catch {
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return (
    <div className="scm-account">
      <div className="scm-account-head">
        <GithubMark size={16} />
        <div className="scm-account-name">
          <span className="scm-account-title">
            github.com <Tag>{status?.method === 'token' ? t('gitlab.accounts.tokenPill') : t('gitlab.accounts.ghCli')}</Tag>
          </span>
          <span className="scm-account-status">
            <Status
              tone={!status ? 'off' : status.loggedIn ? 'ok' : 'warn'}
              label={loading && !status ? t('gitlab.accounts.checking') : status?.loggedIn ? t('gitlab.accounts.connectedAs', { user: status.user ?? '' }) : (status?.detail ?? t('gitlab.accounts.notSignedIn'))}
            />
          </span>
        </div>
        <Button size="sm" disabled={loading} icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />} onClick={() => void refresh()}>
          {t('gitlab.accounts.refresh')}
        </Button>
        <Button size="sm" title={t('gitlab.accounts.changeTitle')} onClick={() => openSettingsPage({ section: 'integrations' })}>
          {t('gitlab.accounts.change')}
        </Button>
      </div>
    </div>
  )
}

function useConnection(row: GitlabHostRow) {
  const [result, setResult] = useState<GitlabConnection | null>(null)
  const [testing, setTesting] = useState(false)
  const test = useCallback(async () => {
    setTesting(true)
    try {
      setResult(await api.testGitlabHost(row.url))
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }, [row.url])
  // A saved token is checked once on open, so the row can say who it signs in as.
  useEffect(() => {
    if (row.tokenSaved) void test()
    else setResult(null)
  }, [row.tokenSaved, test])
  return { result, testing, test, setResult }
}

function GitlabRow({ row, glab, onChanged }: { row: GitlabHostRow; glab: boolean; onChanged: () => void }) {
  const t = useT()
  const conn = useConnection(row)
  const [open, setOpen] = useState(row.selfManaged && !row.tokenSaved)
  const status = !row.tokenSaved ? t('gitlab.accounts.notSignedIn') : conn.testing && !conn.result ? t('gitlab.accounts.checking') : conn.result?.ok ? t('gitlab.accounts.connectedAs', { user: conn.result.user }) : conn.result ? conn.result.error : t('gitlab.accounts.checking')
  const tone: StatusTone = !row.tokenSaved ? 'off' : conn.result?.ok ? 'ok' : conn.result ? 'error' : 'off'

  const removeHost = async () => {
    if (!window.confirm(t('gitlab.accounts.removeHostConfirm', { host: row.host }))) return
    if (await attempt(async () => (await api.removeGitlabHost(row.host), true))) {
      flashSaved()
      onChanged()
    }
  }

  return (
    <div className="scm-account">
      <div className="scm-account-head">
        <GitlabMark size={16} />
        <div className="scm-account-name">
          <span className="scm-account-title">
            {/* G2: with its relative URL root, when it has one. */}
            {row.url.replace(/^https:\/\//, '')}
            {row.selfManaged && <Tag>{t('gitlab.accounts.selfManaged')}</Tag>}
            {row.tokenSaved && <Tag>{t('gitlab.accounts.tokenPill')}</Tag>}
          </span>
          <span className="scm-account-status">
            <Status tone={tone} label={status}>
              <span className="faint"> · {row.repos.length ? row.repos.join(', ') : t('gitlab.accounts.noRepos')}</span>
            </Status>
          </span>
        </div>
        {row.tokenSaved && (
          <Button size="sm" disabled={conn.testing} icon={conn.testing ? <Spinner size={12} /> : <RefreshCw size={12} />} onClick={() => void conn.test()}>
            {t('gitlab.accounts.refresh')}
          </Button>
        )}
        <IconButton label={open ? t('gitlab.accounts.hideDetails') : t('gitlab.accounts.showDetails')} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </IconButton>
      </div>
      {open && (
        <div className="scm-account-body">
          {row.selfManaged && (
            <div className="scm-host-row">
              <span className="set-help">{t('gitlab.accounts.hostLabel')}</span>
              <code>{row.url}</code>
              <ConnectionResult result={conn.result} />
            </div>
          )}
          <TokenCard
            row={row}
            onSaved={(result) => {
              conn.setResult(result)
              onChanged()
            }}
          />
          <div className="scm-host-row">
            <Button size="sm" disabled={conn.testing || !row.tokenSaved} icon={conn.testing ? <Spinner size={12} /> : <CircleCheck size={12} />} onClick={() => void conn.test()}>
              {conn.testing ? t('gitlab.accounts.testing') : t('gitlab.accounts.test')}
            </Button>
            {!row.selfManaged && <ConnectionResult result={conn.result} />}
            {glab && <GlabButton row={row} onSaved={(result) => (conn.setResult(result), result.ok && onChanged())} />}
            <span className="spacer" />
            {row.selfManaged && (
              <Button size="sm" icon={<Trash2 size={12} />} onClick={() => void removeHost()}>
                {t('gitlab.accounts.removeHost')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ConnectionResult({ result }: { result: GitlabConnection | null }) {
  const t = useT()
  if (!result) return null
  return result.ok ? (
    <Status role="status" tone="ok" label={t('gitlab.accounts.found', { version: result.version, user: result.user })} />
  ) : (
    <Status role="status" tone="error" label={result.error} />
  )
}

/** "Use glab's login": copies glab's token for this host into the vault, after testing it. Only on click. */
function GlabButton({ row, onSaved }: { row: GitlabHostRow; onSaved: (result: GitlabConnection) => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const use = async () => {
    setBusy(true)
    try {
      const result = await api.useGlabToken(row.url)
      if (result.ok) flashSaved()
      onSaved(result)
    } catch (err) {
      onSaved({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="sm" disabled={busy} icon={busy ? <Spinner size={12} /> : <SquareTerminal size={12} />} title={t('gitlab.accounts.useGlabHelp')} onClick={() => void use()}>
      {t('gitlab.accounts.useGlab')}
    </Button>
  )
}

/** Write-only token input: masked (with reveal while typing), tested before saving, removable. */
function TokenCard({ row, onSaved }: { row: GitlabHostRow; onSaved: (result: GitlabConnection | null) => void }) {
  const t = useT()
  const [value, setValue] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const tokenUrl = `${row.url}/-/user_settings/personal_access_tokens?name=Foreman&scopes=api,read_user`

  const save = async () => {
    const token = value.trim()
    if (!token || busy) return
    setBusy(true)
    setFailed(null)
    try {
      const result = await api.saveGitlabToken(row.url, token)
      if (result && !result.ok) setFailed(result.error)
      else {
        setValue('')
        setShown(false)
        flashSaved()
      }
      onSaved(result)
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(t('gitlab.accounts.removeTokenConfirm', { host: row.host }))) return
    if (await attempt(async () => (await api.saveGitlabToken(row.url, null), true))) {
      flashSaved()
      onSaved(null)
    }
  }

  return (
    <div className="scm-token">
      <span className="scm-token-head">
        <KeyRound size={13} /> {t('gitlab.accounts.tokenTitle')}
      </span>
      <span className="set-help">{t('gitlab.accounts.tokenDesc', { host: row.host })}</span>
      <div className="set-key-field">
        <div className="set-key-field-label">
          <span>{t('gitlab.accounts.tokenFor', { host: row.host })}</span>
          {row.tokenSaved ? <Tag tone="ok">{t('gitlab.accounts.saved')}</Tag> : <Tag>{t('gitlab.accounts.notSet')}</Tag>}
          <span className="spacer" />
          <LinkButton size="sm" onClick={() => void attempt(() => api.openExternal(tokenUrl))}>
            <span className="set-key-link-text">{t('gitlab.accounts.createToken', { host: row.host })}</span> <ExternalLink size={11} aria-hidden />
          </LinkButton>
        </div>
        <div className="set-key-field-input">
          <div className="set-secret-input">
            <TextInput
              type={shown ? 'text' : 'password'}
              mono
              aria-label={t('gitlab.accounts.tokenLabel', { host: row.host })}
              autoComplete="off"
              spellCheck={false}
              placeholder={row.tokenSaved ? t('gitlab.accounts.placeholderReplace') : t('gitlab.accounts.placeholderNew')}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
            />
            <IconButton label={shown ? t('gitlab.accounts.hideToken') : t('gitlab.accounts.showToken')} onClick={() => setShown(!shown)}>
              {shown ? <EyeOff size={14} /> : <Eye size={14} />}
            </IconButton>
          </div>
          <Button size="sm" variant="primary" disabled={!value.trim() || busy} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => void save()}>
            {t('gitlab.accounts.save')}
          </Button>
          {row.tokenSaved && (
            <Button size="sm" disabled={busy} onClick={() => void remove()}>
              {t('gitlab.accounts.remove')}
            </Button>
          )}
        </div>
        {failed && <span className="set-key-message warn">{failed}</span>}
        <span className="set-help">{t.rich('gitlab.accounts.scopes', { api: <code key="a">api</code>, readUser: <code key="r">read_user</code> })}</span>
      </div>
    </div>
  )
}

/** "Add GitLab host…": the address and a token, tested together; nothing is saved unless the host answers as GitLab. */
function AddHost({ onDone }: { onDone: () => void }) {
  const t = useT()
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GitlabConnection | null>(null)

  const add = async () => {
    if (!url.trim() || !token.trim() || busy) return
    setBusy(true)
    try {
      const next = await api.saveGitlabToken(url.trim(), token.trim())
      setResult(next)
      if (next?.ok) {
        flashSaved()
        onDone()
      }
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scm-add-form">
      <div className="scm-host-row">
        <GitlabMark size={16} />
        <TextInput
          mono
          className="scm-host-input"
          aria-label={t('gitlab.accounts.hostInput')}
          placeholder={t('gitlab.accounts.hostPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div className="set-key-field-input">
        <div className="set-secret-input">
          <TextInput
            type={shown ? 'text' : 'password'}
            mono
            aria-label={t('gitlab.accounts.tokenLabel', { host: url.trim() || 'GitLab' })}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('gitlab.accounts.placeholderNew')}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <IconButton label={shown ? t('gitlab.accounts.hideToken') : t('gitlab.accounts.showToken')} onClick={() => setShown(!shown)}>
            {shown ? <EyeOff size={14} /> : <Eye size={14} />}
          </IconButton>
        </div>
        <Button size="sm" variant="primary" disabled={!url.trim() || !token.trim() || busy} icon={busy ? <Spinner size={12} /> : undefined} onClick={() => void add()}>
          {t('gitlab.accounts.addSave')}
        </Button>
        <Button size="sm" disabled={busy} onClick={onDone}>
          {t('gitlab.accounts.cancel')}
        </Button>
      </div>
      <ConnectionResult result={result} />
      <span className="set-help">{t('gitlab.accounts.checkedFirst')}</span>
      <span className="set-help">{t.rich('gitlab.accounts.scopes', { api: <code key="a">api</code>, readUser: <code key="r">read_user</code> })}</span>
    </div>
  )
}
