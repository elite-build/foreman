// Add repository: open a folder, clone from GitHub or a URL, start a new
// project, or reopen a recent folder.
import { Building2, ChevronRight, Clock, Download, FolderOpen, FolderPlus, Globe, Lock, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { currentSpace, type Organization } from '../../../shared/organizations'
import { GITHUB_REPOS_LISTED, type GithubRepo, type GitIdentity } from '../../../shared/types'
import {
  addPlainFolder,
  addRepository,
  api,
  cloneRepository,
  makeRepository,
  onCloneProgress,
  openAddRepoDialog,
  openCreateOrganization,
  openMakeRepo,
  openRecentRepo,
  quickStartRepository,
  setSpace,
  useStore
} from '../store'
import { useT } from '../i18n'
import { formatChord } from '../shortcuts'
import { timeAgo } from '../../../shared/i18n/time'
import { Button, Callout, Card, Checkbox, Combobox, Dialog, Field, Kbd, Listbox, CardButton, Segmented, Select, Spinner, TextInput } from '../ui'
import { AccountPicker, useGithubAccounts } from './settings/GithubAccount'

/** ~ for the home folder in displayed paths. */
export function tildify(p: string, home: string): string {
  return home && (p === home || p.startsWith(home + '/') || p.startsWith(home + '\\')) ? `~${p.slice(home.length)}` : p
}

function repoNameFromUrl(url: string): string {
  return (url.trim().replace(/[/\\]+$/, '').split(/[/:\\]/).pop() ?? '').replace(/\.git$/i, '')
}

/** A folder field with Browse. */
export function LocationField({ value, onChange, title, description }: { value: string; onChange: (value: string) => void; title: string; description?: string }) {
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

/**
 * The organization showing, when it keeps its repositories in a folder of their own: Clone and Quick start start in that
 * folder, and what they make joins it.
 */
function useOrganizationFolder(): (Organization & { folder: string }) | undefined {
  const org = useStore((s) => {
    const organizations = s.snapshot!.organizations
    const space = currentSpace(organizations, s.space)
    return space ? organizations?.find((o) => o.id === space) : undefined
  })
  return org?.folder ? (org as Organization & { folder: string }) : undefined
}

/** Where a new repository goes, in words: into the organization showing, when it has a folder of its own. */
function useIntoLine(): (key: 'addRepo.clone.into' | 'addRepo.quick.creates', path: string, organization: Organization | undefined) => string {
  const t = useT()
  return (key, path, organization) =>
    organization ? t(key === 'addRepo.clone.into' ? 'addRepo.clone.intoOrganization' : 'addRepo.quick.createsOrganization', { path, organization: organization.name }) : t(key, { path })
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
  const organization = useOrganizationFolder()
  const into = useIntoLine()
  const [url, setUrl] = useState('')
  const [location, setLocation] = useState(organization?.folder ?? settings.cloneDirectory)
  const [repos, setRepos] = useState<GithubRepo[] | null>(null)
  const [protocol, setProtocol] = useState<'https' | 'ssh'>('https')
  const [listError, setListError] = useState('')
  const [query, setQuery] = useState('')
  const [cloning, setCloning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState('')
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
  const options = shown.map((r) => {
    const slash = r.fullName.lastIndexOf('/')
    const pushed = timeAgo(r.pushedAt, t.locale)
    return {
      value: protocol === 'ssh' ? r.sshUrl : r.httpsUrl,
      // The owner recedes so the names line up for scanning.
      label: (
        <>
          <span className="faint">{r.fullName.slice(0, slash + 1)}</span>
          <span className="add-repo-name">{r.fullName.slice(slash + 1)}</span>
        </>
      ),
      // The option's name, with what the trailing time and lock show.
      textValue: [r.fullName, r.private && t('addRepo.clone.private'), pushed].filter(Boolean).join(', '),
      // A description of only an emoji or punctuation says nothing in a list.
      description: r.description && /[\p{L}\p{N}]/u.test(r.description) ? r.description : undefined,
      trailing: (
        <span className="add-repo-meta faint" aria-hidden>
          {pushed}
          <span className="add-repo-lock">{r.private && <Lock size={11} />}</span>
        </span>
      )
    }
  })

  const name = repoNameFromUrl(url)
  const submit = async () => {
    if (cloning || !url.trim() || !location.trim()) return
    setCloning(true)
    setError('')
    setLog([])
    const cloneId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const stop = onCloneProgress(cloneId, (line) => setLog((lines) => [...lines.slice(-60), line]))
    try {
      await cloneRepository(url, location.trim(), cloneId, cloneAs, organization?.id)
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
            {cloning ? t('addRepo.clone.cloning') : t('addRepo.clone.submit')} {!cloning && <Kbd>{formatChord('mod+Enter', platform)}</Kbd>}
          </Button>
        </>
      }
    >
      <div className="add-repo-body" onKeyDown={onKeyDown}>
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
                // GitHub lists the most recently pushed repos only (repoSources.githubRepos), so say where the rest are.
                footer={repos.length >= GITHUB_REPOS_LISTED && !query.trim() ? t('addRepo.clone.recentOnly') : undefined}
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
          description={name && location.trim() ? into('addRepo.clone.into', `${location.replace(/[/\\]+$/, '')}/${name}`, organization) : undefined}
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
  const organization = useOrganizationFolder()
  const into = useIntoLine()
  const [name, setName] = useState('')
  const [location, setLocation] = useState(organization?.folder ?? settings.cloneDirectory)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (working || !name.trim() || !location.trim()) return
    setWorking(true)
    setError('')
    try {
      await quickStartRepository(location.trim(), name.trim(), organization?.id)
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
            {working ? t('newWorkspace.submit.creating') : t('addRepo.quick.submit')} {!working && <Kbd>{formatChord('mod+Enter', platform)}</Kbd>}
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
          description={name.trim() && location.trim() ? into('addRepo.quick.creates', `${location.replace(/[/\\]+$/, '')}/${name.trim()}`, organization) : undefined}
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

  const run = async (identity?: GitIdentity, plain = false) => {
    if (working) return
    setWorking(true)
    setError('')
    try {
      // On success the repository (or the plain folder) is added and the store closes this dialog.
      if (plain) await addPlainFolder(dir)
      else if ((await makeRepository(dir, identity)) === 'needs-identity') setStage('identity')
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
        ) : null}
        {stage === 'confirm' ? (
          <Callout
            tone="neutral"
            title={t('addRepo.plain.title')}
            actions={
              <Button onClick={() => void run(undefined, true)} disabled={working}>
                {t('addRepo.plain.action')}
              </Button>
            }
          >
            {t('addRepo.plain.body')}
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

const PERSONAL = 'personal'

/**
 * Add to Foreman (the rail's +): a repository on the left, which space it joins and the three ways in, with recent folders;
 * an organization on the right. The ways run as the Add menu's do, after the dialog closes and the space chosen is shown.
 */
export function AddToForemanDialog() {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const wanted = useStore((s) => s.space)
  const organizations = snapshot.organizations ?? []
  const shown = currentSpace(organizations, wanted)
  const recent = snapshot.recentRepos.slice(0, 3)
  const [target, setTarget] = useState<string>(shown ?? PERSONAL)
  const spaces = [{ value: PERSONAL, label: t('spaces.personal') }, ...organizations.map((o) => ({ value: o.id, label: o.name }))]
  const go = (run: () => void) => () => {
    const space = target === PERSONAL ? null : target
    openAddRepoDialog(null)
    if (space !== shown) setSpace(space, { home: false })
    run()
  }

  return (
    <Dialog
      title={t('addRepo.add.title')}
      size="lg"
      onClose={() => openAddRepoDialog(null)}
      footer={
        <>
          <span className="add-dialog-drop faint small">
            <Download size={13} aria-hidden /> {t('addRepo.add.drop')}
          </span>
          <Button onClick={() => openAddRepoDialog(null)}>{t('common.cancel')}</Button>
        </>
      }
    >
      <div className="add-dialog">
        <section className="add-dialog-col">
          <div className="add-dialog-head">
            <div className="add-repo-label">{t('addRepo.add.repository')}</div>
            {organizations.length > 0 &&
              (spaces.length <= 4 ? (
                <Segmented small label={t('addRepo.add.to')} value={target} options={spaces} onChange={setTarget} />
              ) : (
                <Select label={t('addRepo.add.to')} value={target} options={spaces} onChange={setTarget} />
              ))}
          </div>
          <CardButton className="add-dialog-way" onClick={go(() => void addRepository())}>
            <FolderOpen size={18} aria-hidden />
            <span className="add-dialog-way-text">
              <span>{t('addRepo.openProject')}</span>
              <span className="faint small">{t('addRepo.add.openDetail')}</span>
            </span>
            <ChevronRight size={14} aria-hidden />
          </CardButton>
          <CardButton className="add-dialog-way" onClick={go(() => openAddRepoDialog('clone'))}>
            <Globe size={18} aria-hidden />
            <span className="add-dialog-way-text">
              <span>{t('addRepo.openGithub')}</span>
              <span className="faint small">{t('addRepo.add.cloneDetail')}</span>
            </span>
            <ChevronRight size={14} aria-hidden />
          </CardButton>
          <CardButton className="add-dialog-way" onClick={go(() => openAddRepoDialog('quick-start'))}>
            <FolderPlus size={18} aria-hidden />
            <span className="add-dialog-way-text">
              <span>{t('addRepo.quickStart')}</span>
              <span className="faint small">{t('addRepo.add.quickDetail')}</span>
            </span>
            <ChevronRight size={14} aria-hidden />
          </CardButton>
          {recent.length > 0 && (
            <>
              <div className="add-repo-label">{t('addRepo.recentFolders')}</div>
              {recent.map((p) => (
                <Button key={p} variant="ghost" size="sm" className="add-dialog-recent" title={p} onClick={go(() => void openRecentRepo(p))}>
                  <Clock size={13} aria-hidden />
                  {tildify(p, snapshot.homeDir)}
                </Button>
              ))}
            </>
          )}
        </section>
        <section className="add-dialog-col">
          <div className="add-dialog-head">
            <div className="add-repo-label">{t('addRepo.add.organization')}</div>
          </div>
          <Card className="add-dialog-org">
            <strong className="add-dialog-org-title">
              <Building2 size={16} aria-hidden /> {t('spaces.create.title')}
            </strong>
            <p className="faint small">{t('addRepo.add.orgBody')}</p>
            <Button
              icon={<Plus size={14} />}
              onClick={() => {
                openAddRepoDialog(null)
                openCreateOrganization(true)
              }}
            >
              {t('spaces.create.menu')}
            </Button>
          </Card>
        </section>
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
