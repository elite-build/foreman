// Add repository: open a folder, clone from GitHub or a URL, start a new
// project, or reopen a recent folder.
import { Folder, FolderOpen, FolderPlus, Globe, Lock, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { GithubRepo, GitIdentity } from '../../../shared/types'
import {
  addRepository,
  api,
  cloneRepository,
  makeRepository,
  modKey,
  onCloneProgress,
  openAddRepoDialog,
  openMakeRepo,
  openRecentRepo,
  quickStartRepository,
  useStore
} from '../store'
import { useT } from '../i18n'
import { Button, Callout, Checkbox, Combobox, Dialog, Field, Kbd, Listbox, MenuControlRow, MenuGroup, MenuItem, MenuSeparator, CardButton, Spinner, TextInput } from '../ui'
import { AccountPicker, useGithubAccounts } from './settings/GithubAccount'

/** ~ for the home folder in displayed paths. */
function tildify(p: string, home: string): string {
  return home && (p === home || p.startsWith(home + '/') || p.startsWith(home + '\\')) ? `~${p.slice(home.length)}` : p
}

function repoNameFromUrl(url: string): string {
  return (url.trim().replace(/[/\\]+$/, '').split(/[/:\\]/).pop() ?? '').replace(/\.git$/i, '')
}

/**
 * The items of the Add repository menu: Open project, Open GitHub project, Quick start, Recents. Rendered inside a
 * `MenuButton` (the rail's Add button draws it beside itself, in the document, so the scrolling rail can't clip it).
 */
export function AddRepoItems() {
  const t = useT()
  const recents = useStore((s) => s.snapshot!.recentRepos)
  const home = useStore((s) => s.snapshot!.homeDir)
  return (
    <>
      <MenuItem icon={<FolderOpen size={15} />} onSelect={() => void addRepository()}>
        {t('addRepo.openProject')}
      </MenuItem>
      <MenuItem icon={<Globe size={15} />} onSelect={() => openAddRepoDialog('clone')}>
        {t('addRepo.openGithub')}
      </MenuItem>
      <MenuItem icon={<FolderPlus size={15} />} onSelect={() => openAddRepoDialog('quick-start')}>
        {t('addRepo.quickStart')}
      </MenuItem>
      {recents.length > 0 && (
        <>
          <MenuSeparator />
          <MenuGroup label={t('addRepo.recents')}>
            {recents.map((p) => (
              // DS-TODO(B1): a MenuItem can't carry a second action, so each recent folder is a row of two buttons (Open, and forget with ×) instead of one item with a × beside it.
              <MenuControlRow key={p} label={tildify(p, home)} icon={<Folder size={14} />}>
                <MenuItem title={p} aria-label={t('addRepo.openRecent', { path: p })} closeOnSelect onSelect={() => void openRecentRepo(p)}>
                  {t('common.open')}
                </MenuItem>
                <MenuItem aria-label={t('addRepo.forgetRecent', { path: p })} closeOnSelect={false} onSelect={() => void api.forgetRecentRepo(p)}>
                  <X size={12} />
                </MenuItem>
              </MenuControlRow>
            ))}
          </MenuGroup>
        </>
      )}
    </>
  )
}

/** A folder field with Browse. */
function LocationField({ value, onChange, title, description }: { value: string; onChange: (value: string) => void; title: string; description?: string }) {
  const t = useT()
  return (
    <Field className="add-repo-section" label={t('addRepo.location.label')} description={description}>
      {(control) => (
        <div className="add-repo-location">
          <TextInput {...control} mono value={value} spellCheck={false} placeholder={t('addRepo.location.placeholder')} onChange={(e) => onChange(e.target.value)} />
          <Button
            size="sm"
            onClick={async () => {
              const picked = await api.pickPath({ kind: 'directory', title, defaultPath: value || undefined }).catch(() => null)
              if (picked) onChange(picked)
            }}
          >
            {t('addRepo.location.browse')}
          </Button>
        </div>
      )}
    </Field>
  )
}

function useSubmitShortcut(submit: () => void) {
  const platform = useStore((s) => s.snapshot!.platform)
  return (e: React.KeyboardEvent) => {
    const mod = platform === 'darwin' ? e.metaKey : e.ctrlKey
    if (e.key === 'Enter' && (mod || (e.target as HTMLElement).tagName === 'INPUT')) {
      e.preventDefault()
      submit()
    }
  }
}

export function CloneRepoDialog() {
  const t = useT()
  const settings = useStore((s) => s.snapshot!.settings)
  const platform = useStore((s) => s.snapshot!.platform)
  const [url, setUrl] = useState('')
  const [location, setLocation] = useState(settings.cloneDirectory)
  const [repos, setRepos] = useState<GithubRepo[] | null>(null)
  const [protocol, setProtocol] = useState<'https' | 'ssh'>('https')
  const [listError, setListError] = useState('')
  const [query, setQuery] = useState('')
  const [cloning, setCloning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState('')
  const mod = modKey(platform)
  // With several gh accounts signed in, clone (and link the repo) as a chosen one.
  const accounts = useGithubAccounts()
  const [account, setAccount] = useState<string | null>(null)
  const choosing = (accounts?.length ?? 0) > 1
  useEffect(() => {
    if (accounts && accounts.length > 1) setAccount((current) => current ?? accounts.find((a) => a.active)?.login ?? accounts[0].login)
  }, [accounts])
  const cloneAs = choosing ? account ?? undefined : undefined

  useEffect(() => {
    // Wait for the account before listing, so the list is the right account's.
    if (!accounts || (choosing && !account)) return
    let live = true
    setRepos(null)
    setListError('')
    void api
      .githubRepos(cloneAs)
      .then((result) => {
        if (!live) return
        setRepos(result.repos)
        setProtocol(result.protocol)
        if (result.error) setListError(result.error)
      })
      .catch((err: unknown) => live && (setRepos([]), setListError(err instanceof Error ? err.message : String(err))))
    return () => {
      live = false
    }
  }, [accounts, choosing, account, cloneAs])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q)).slice(0, 50)
  }, [repos, query])
  const options = shown.map((r) => ({
    value: protocol === 'ssh' ? r.sshUrl : r.httpsUrl,
    label: r.fullName,
    description: r.description || undefined,
    trailing: r.private ? <Lock size={11} role="img" aria-label={t('addRepo.clone.private')} /> : undefined
  }))

  const name = repoNameFromUrl(url)
  const submit = async () => {
    if (cloning || !url.trim() || !location.trim()) return
    setCloning(true)
    setError('')
    setLog([])
    const cloneId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const stop = onCloneProgress(cloneId, (line) => setLog((lines) => [...lines.slice(-60), line]))
    try {
      await cloneRepository(url, location.trim(), cloneId, cloneAs)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      stop()
      setCloning(false)
    }
  }
  const onKeyDown = useSubmitShortcut(() => void submit())

  return (
    <Dialog
      title={t('addRepo.clone.title')}
      onClose={() => !cloning && openAddRepoDialog(null)}
      headerExtra={
        choosing && accounts && account ? (
          <div className="clone-account">
            <span className="faint small">{t('addRepo.clone.as')}</span>
            <AccountPicker accounts={accounts} value={account} small onChange={(login) => login && setAccount(login)} />
          </div>
        ) : undefined
      }
      footer={
        <>
          <Button onClick={() => openAddRepoDialog(null)} disabled={cloning}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={cloning || !url.trim() || !location.trim()}>
            {cloning ? t('addRepo.clone.cloning') : t('addRepo.clone.submit')} {!cloning && <Kbd>{mod}↵</Kbd>}
          </Button>
        </>
      }
    >
      <div className="add-repo-body" onKeyDown={onKeyDown}>
        <p className="faint small">{cloneAs ? t('addRepo.clone.introAs', { account: cloneAs }) : t('addRepo.clone.intro')}</p>
        {repos === null ? (
          <div className="faint small add-repo-loading" role="status">
            <Spinner size={13} /> {t('addRepo.clone.loading')}
          </div>
        ) : repos.length > 0 ? (
          <div className="add-repo-section">
            <div className="add-repo-label">{t('addRepo.clone.recent')}</div>
            {repos.length >= 5 ? (
              <Combobox
                className="add-repo-combo"
                label={t('addRepo.clone.listLabel')}
                placeholder={t('addRepo.clone.search')}
                inline
                open
                leading={<Search size={13} aria-hidden />}
                query={query}
                onQueryChange={setQuery}
                empty={t('addRepo.clone.noMatch')}
                options={options}
                value={url}
                onChange={setUrl}
              />
            ) : (
              <Listbox className="add-repo-list" label={t('addRepo.clone.listLabel')} options={options} value={url} onChange={setUrl} />
            )}
          </div>
        ) : listError ? (
          <p className="faint small">{t('addRepo.clone.signIn')}</p>
        ) : null}

        <Field className="add-repo-section" label={t('addRepo.clone.url')}>
          {(control) => (
            <TextInput
              {...control}
              className="add-repo-url"
              mono
              autoFocus
              spellCheck={false}
              autoComplete="off"
              value={url}
              placeholder={protocol === 'ssh' ? 'git@github.com:user/repo.git' : 'https://github.com/user/repo.git'}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        </Field>

        <LocationField
          value={location}
          onChange={setLocation}
          title={t('addRepo.clone.locationTitle')}
          description={name && location.trim() ? t('addRepo.clone.into', { path: `${location.replace(/[/\\]+$/, '')}/${name}` }) : undefined}
        />

        {cloning && (
          <div className="add-repo-progress">
            <div className="faint small">
              <Spinner size={13} /> {t('addRepo.clone.cloning')}
            </div>
            {log.length > 0 && <pre className="add-repo-log">{log.slice(-12).join('\n')}</pre>}
          </div>
        )}
        {error && (
          <Callout tone="error" role="alert" className="add-repo-error">
            {error}
          </Callout>
        )}
      </div>
    </Dialog>
  )
}

export function QuickStartDialog() {
  const t = useT()
  const settings = useStore((s) => s.snapshot!.settings)
  const platform = useStore((s) => s.snapshot!.platform)
  const [name, setName] = useState('')
  const [location, setLocation] = useState(settings.cloneDirectory)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const mod = modKey(platform)

  const submit = async () => {
    if (working || !name.trim() || !location.trim()) return
    setWorking(true)
    setError('')
    try {
      await quickStartRepository(location.trim(), name.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      setWorking(false)
    }
  }
  const onKeyDown = useSubmitShortcut(() => void submit())

  return (
    <Dialog
      title={t('addRepo.quickStart')}
      onClose={() => !working && openAddRepoDialog(null)}
      footer={
        <>
          <Button onClick={() => openAddRepoDialog(null)} disabled={working}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={working || !name.trim() || !location.trim()}>
            {working ? t('newWorkspace.submit.creating') : t('addRepo.quick.submit')} {!working && <Kbd>{mod}↵</Kbd>}
          </Button>
        </>
      }
    >
      <div className="add-repo-body" onKeyDown={onKeyDown}>
        <p className="faint small">{t('addRepo.quick.intro')}</p>
        <Field className="add-repo-section" label={t('addRepo.quick.name')}>
          {(control) => <TextInput {...control} className="add-repo-url" mono autoFocus spellCheck={false} value={name} placeholder="my-project" onChange={(e) => setName(e.target.value)} />}
        </Field>
        <LocationField
          value={location}
          onChange={setLocation}
          title={t('addRepo.quick.locationTitle')}
          description={name.trim() && location.trim() ? t('addRepo.quick.creates', { path: `${location.replace(/[/\\]+$/, '')}/${name.trim()}` }) : undefined}
        />
        {error && (
          <Callout tone="error" role="alert" className="add-repo-error">
            {error}
          </Callout>
        )}
      </div>
    </Dialog>
  )
}

/**
 * A folder that isn't a Git repository: offers to make it one (git init and a first commit of the files in it) and,
 * when Git has no name and email to commit with, asks for them and carries on.
 */
export function MakeRepoDialog({ dir }: { dir: string }) {
  const t = useT()
  const [stage, setStage] = useState<'confirm' | 'identity'>('confirm')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [global, setGlobal] = useState(false)
  const folder = dir.split(/[/\\]/).filter(Boolean).pop() ?? dir
  const identityReady = name.trim() !== '' && /^\S+@\S+$/.test(email.trim())

  const run = async (identity?: GitIdentity) => {
    if (working) return
    setWorking(true)
    setError('')
    try {
      // On success the repository is added and the store closes this dialog.
      if ((await makeRepository(dir, identity)) === 'needs-identity') setStage('identity')
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      setWorking(false)
    }
  }
  const saveIdentity = () => identityReady && void run({ name: name.trim(), email: email.trim(), global })
  const close = () => !working && openMakeRepo(null)
  const onKeyDown = useSubmitShortcut(saveIdentity)

  return (
    <Dialog
      title={stage === 'identity' ? t('addRepo.makeRepo.identity.title') : t('addRepo.makeRepo.title')}
      description={<span className="mono">{dir}</span>}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={working}>
            {t('common.cancel')}
          </Button>
          {stage === 'identity' && (
            <Button variant="primary" onClick={saveIdentity} disabled={working || !identityReady}>
              {working ? <Spinner size={13} /> : null} {t('addRepo.makeRepo.identity.save')}
            </Button>
          )}
        </>
      }
    >
      <div className="add-repo-body">
        {stage === 'confirm' ? (
          <Callout
            tone="info"
            title={t('addRepo.makeRepo.callout.title')}
            actions={
              <Button variant="primary" autoFocus onClick={() => void run()} disabled={working}>
                {working ? <Spinner size={13} /> : null} {t('addRepo.makeRepo.action')}
              </Button>
            }
          >
            {t('addRepo.makeRepo.callout.body', { folder })}
          </Callout>
        ) : (
          <>
            <p className="faint small">{t('addRepo.makeRepo.identity.body')}</p>
            <div className="add-repo-body" onKeyDown={onKeyDown}>
              <Field className="add-repo-section" label={t('addRepo.makeRepo.identity.name')}>
                {(control) => <TextInput {...control} autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}
              </Field>
              <Field className="add-repo-section" label={t('addRepo.makeRepo.identity.email')}>
                {(control) => <TextInput {...control} autoComplete="email" inputMode="email" spellCheck={false} value={email} placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)} />}
              </Field>
              <Checkbox checked={global} onChange={(e) => setGlobal(e.target.checked)}>
                {t('addRepo.makeRepo.identity.global')}
              </Checkbox>
            </div>
          </>
        )}
        {error && (
          <Callout tone="error" role="alert" className="add-repo-error">
            {error}
          </Callout>
        )}
      </div>
    </Dialog>
  )
}

/** Home screen: the same three ways in, as cards. */
export function AddRepoCards() {
  const t = useT()
  return (
    <div className="add-repo-cards">
      <CardButton className="add-repo-card" onClick={() => void addRepository()}>
        <FolderOpen size={18} aria-hidden />
        <span>{t('addRepo.openProject')}</span>
      </CardButton>
      <CardButton className="add-repo-card" onClick={() => openAddRepoDialog('clone')}>
        <Globe size={18} aria-hidden />
        <span>{t('addRepo.openGithub')}</span>
      </CardButton>
      <CardButton className="add-repo-card" onClick={() => openAddRepoDialog('quick-start')}>
        <FolderPlus size={18} aria-hidden />
        <span>{t('addRepo.quickStart')}</span>
      </CardButton>
    </div>
  )
}
