// The gh account a repository's GitHub work runs as: a picker (Repo → Git and
// the clone dialog) and the Repo → Git row with auto-detect.
import { ChevronsUpDown, LogIn, ScanSearch, User } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AccountDetection, GithubAccount, Repo } from '../../../../shared/types'
import { useT, type RendererT } from '../../i18n'
import { api, attempt, openSettingsPage, useStore } from '../../store'
import { ActionRow, Button, Listbox, Popover, Spinner, Status, Tag, type ListboxOption } from '../../ui'
import { Row } from './controls'

/** The accounts signed in to gh; null while loading. */
export function useGithubAccounts(): GithubAccount[] | null {
  const [accounts, setAccounts] = useState<GithubAccount[] | null>(null)
  useEffect(() => {
    let live = true
    api
      .githubAccounts()
      .then((list) => live && setAccounts(list))
      .catch(() => live && setAccounts([]))
    return () => {
      live = false
    }
  }, [])
  return accounts
}

export function AccountAvatar({ login }: { login: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className="gh-avatar letter" aria-hidden>{login[0]?.toUpperCase()}</span>
  return <img className="gh-avatar" src={`https://github.com/${encodeURIComponent(login)}.png?size=40`} alt="" onError={() => setFailed(true)} />
}

interface PickerProps {
  accounts: GithubAccount[]
  // null: gh's active account (only offered with allowDefault).
  value: string | null
  onChange: (login: string | null) => void
  allowDefault?: boolean
  // Who can push to the repo, once known; tags each account.
  pushers?: string[] | null
  onOpen?: () => void
  small?: boolean
}

export function AccountPicker({ accounts, value, onChange, allowDefault, pushers, onOpen, small }: PickerProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const active = accounts.find((a) => a.active)?.login

  const choose = (login: string | null) => {
    setOpen(false)
    if (login !== value) onChange(login)
  }
  const avatar = (login: string | null) => (login ? <AccountAvatar login={login} /> : <span className="gh-avatar default"><User size={11} /></span>)
  // gh's active account (null) first when it's offered, then each account; a chosen login that isn't signed in any more stays listed.
  const options = useMemo<ListboxOption<string | null>[]>(() => {
    const row = (login: string | null): ListboxOption<string | null> => ({
      value: login,
      label: login ?? t('githubAccount.default'),
      leading: avatar(login),
      trailing: !login
        ? active && <Tag>{active}</Tag>
        : pushers && (pushers.includes(login) ? <Tag>{t('githubAccount.canPush')}</Tag> : <Tag>{t('githubAccount.readOnly')}</Tag>)
    })
    return [...(allowDefault ? [row(null)] : []), ...accounts.map((a) => row(a.login)), ...(value && !accounts.some((a) => a.login === value) ? [row(value)] : [])]
  }, [accounts, active, allowDefault, pushers, t, value])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next && !open) onOpen?.()
        setOpen(next)
      }}
      label={t('settings.row.repoGithubAccount')}
      side="bottom"
      panelClassName="gh-account-popover"
      trigger={(p) => (
        <Button {...p} size={small ? 'sm' : 'md'} className="gh-account-button" icon={avatar(value)}>
          <span className="repo-combo-value">{value ?? t('githubAccount.default')}</span>
          <ChevronsUpDown size={13} className="faint" aria-hidden />
        </Button>
      )}
    >
      <Listbox label={t('settings.row.repoGithubAccount')} options={options} value={value} onChange={choose} />
      <ActionRow
        primaryProps={{ className: 'gh-account-signin' }}
        onPress={() => {
          setOpen(false)
          openSettingsPage({ section: 'account' })
        }}
      >
        <LogIn size={13} aria-hidden />
        <span>{t('githubAccount.signInAnother')}</span>
      </ActionRow>
    </Popover>
  )
}

const isSsh = (url: string) => /^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(url.trim())

/** "alice and bob" (English joins every name with "and"); other languages use their own list style. */
const names = (list: string[], t: RendererT) => (t.locale === 'en' ? list.join(' and ') : new Intl.ListFormat(t.locale, { type: 'conjunction' }).format(list))

/**
 * Repo → Git: which GitHub connection this repository's pushes, pull requests and agents use. The
 * choice itself lives in Repository settings → Integrations; "Detect" picks the one signed-in gh
 * account that can push, as before.
 */
export function GithubAccountLink({ repo }: { repo: Repo }) {
  const t = useT()
  const integrations = useStore((s) => s.snapshot!.integrations)
  const [detecting, setDetecting] = useState(false)
  const [detection, setDetection] = useState<AccountDetection | null>(null)
  const choice = repo.integrations?.services?.github
  const def = integrations.connections.find((c) => c.service === 'github' && c.isDefault)
  const chosen = choice && choice !== 'off' ? integrations.connections.find((c) => c.id === choice) : undefined
  const value =
    choice === 'off' ? t('integrations.repo.off') : choice ? (chosen?.name ?? t('integrations.repo.removed')) : def ? t('integrations.repo.defaultIs', { name: def.name }) : t('githubAccount.default')
  const detect = async () => {
    setDetecting(true)
    const result = await attempt(() => api.detectRepoAccount(repo.id, true))
    setDetecting(false)
    if (result) setDetection(result)
  }
  let detail: ReactNode
  if (detection?.slug && !detecting) {
    const { slug, account, pushers } = detection
    detail = account ? (
      <Status tone="ok" label={pushers.length === 1 ? t('githubAccount.onlyPusher', { account, slug }) : t('githubAccount.owner', { pushers: names(pushers, t), slug, account })} />
    ) : (
      <Status tone="warn" label={pushers.length > 1 ? t('githubAccount.several', { pushers: names(pushers, t), slug }) : t('githubAccount.nobody', { slug })} />
    )
  } else if (detection && !detection.slug) detail = t('githubAccount.notGithub')
  return (
    <Row
      label={t('settings.row.repoGithubAccount')}
      help={t('integrations.repo.gitTabHelp')}
      source={repo.integrations?.githubDetected ? { text: t('githubAccount.autoDetected') } : undefined}
      detail={detail}
    >
      <div className="gh-account-control">
        <Button size="sm" disabled={detecting || !repo.hasOrigin} icon={detecting ? <Spinner size={13} /> : <ScanSearch size={13} />} title={t('githubAccount.detectTitle')} onClick={() => void detect()}>
          {detecting ? t('githubAccount.detecting') : t('githubAccount.detect')}
        </Button>
        <Button size="sm" icon={<User size={13} />} onClick={() => openSettingsPage({ section: 'repo', repoId: repo.id, tab: 'integrations', scrollTo: 'repo-github-account' })}>
          {value}
        </Button>
      </div>
    </Row>
  )
}
