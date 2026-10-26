// Repository → Git: base branch, remote and per-repo git behaviour.
import { GitBranch, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { BranchInfo, Repo } from '../../../../shared/types'
import { rankItems } from '../../fuzzy'
import { useT } from '../../i18n'
import { api } from '../../store'
import { Combobox, IconButton, LinkButton, Select, Spinner, Tag, type ListboxOption } from '../../ui'
import { RepoToggleRow, Row, saveRepo, Section } from './controls'
import { GithubAccountLink } from './GithubAccount'
import { SensitivePathsRow } from './RepoChecks'

export function GitTab({ repo }: { repo: Repo }) {
  const t = useT()
  return (
    <>
      <Section>
        <Row id="repo-base-branch" label={t('repoSettings.baseBranch.label')} help={t('repoSettings.baseBranch.help')}>
          <BranchPicker repo={repo} />
        </Row>
        <RemoteRow repo={repo} />
        <GithubAccountLink repo={repo} />
        <RepoToggleRow
          repoId={repo.id}
          setting="workInRepoFolder"
          id="repo-work-in-repo-folder"
          label={t('repoSettings.workInRepoFolder.label')}
          help={t('repoSettings.workInRepoFolder.help')}
        />
      </Section>
      <Section>
        <RepoToggleRow
          repoId={repo.id}
          setting="deleteBranchOnArchive"
          id="repo-delete-branch-on-archive"
          label={t('settings.git.deleteBranchOnArchive.label')}
          help={t('repoSettings.deleteBranchOnArchive.help')}
        />
        <RepoToggleRow
          repoId={repo.id}
          setting="archiveOnMerge"
          id="repo-archive-on-merge"
          label={t('settings.git.archiveOnMerge.label')}
          help={t('settings.git.archiveOnMerge.help')}
        />
        <RepoToggleRow
          repoId={repo.id}
          setting="suggestFollowups"
          id="repo-suggest-followups"
          label={t('repoSettings.suggestFollowups.label')}
          help={t('repoSettings.suggestFollowups.help')}
        />
        <RepoToggleRow
          repoId={repo.id}
          setting="warnBaseMoved"
          id="repo-warn-base-moved"
          label={t('gitPanel.baseWatch.label')}
          help={t('repoSettings.warnBaseMoved.help')}
        />
        <RepoToggleRow
          repoId={repo.id}
          setting="pushAutoSetupRemote"
          id="repo-push-auto-setup-remote"
          label={t('settings.git.pushAutoSetupRemote.label')}
          help={t.rich('repoSettings.pushAutoSetupRemote.help', { command: <code key="cmd">git push</code> })}
        />
      </Section>
      <Section>
        <SensitivePathsRow repo={repo} />
      </Section>
    </>
  )
}

// ---- base branch ----

type Branches = { status: 'loading' | 'ready' | 'error'; list: BranchInfo[] }

function BranchPicker({ repo }: { repo: Repo }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<Branches>({ status: 'ready', list: [] })
  const [query, setQuery] = useState('')
  const request = useRef(0)

  const load = async (fetch = false) => {
    const id = ++request.current
    setBranches((b) => ({ status: 'loading', list: b.list }))
    try {
      const next = await api.listBranches(repo.id, fetch ? { fetch: true } : undefined)
      if (id === request.current) setBranches({ status: 'ready', list: next })
    } catch {
      if (id === request.current) setBranches((b) => ({ status: 'error', list: b.list }))
    }
  }

  // The list is asked for each time it opens (not on every key typed into it).
  const onOpenChange = (next: boolean) => {
    if (next && !open) {
      setQuery('')
      void load()
    }
    setOpen(next)
  }

  const matches = rankItems(branches.list, query, (b) => b.name).slice(0, 200)
  const remoteName = (b: BranchInfo) => (b.remote && repo.hasOrigin ? `${repo.remote}/${b.name}` : b.name)

  const choose = (name: string) => {
    if (name !== repo.defaultBranch) void saveRepo(repo.id, { defaultBranch: name })
  }

  const options: ListboxOption[] = matches.map((b) => ({
    value: b.name,
    label: remoteName(b),
    title: b.checkedOutAt ? t('repoSettings.branch.checkedOutAt', { path: b.checkedOutAt }) : undefined,
    trailing: (
      <>
        {b.isDefault && <Tag tone="accent">{t('repoSettings.branch.defaultTag')}</Tag>}
        {repo.hasOrigin && !b.remote && <Tag>{t('repoSettings.branch.localOnly')}</Tag>}
      </>
    )
  }))

  const empty =
    branches.status === 'loading' && !branches.list.length ? (
      t('repoSettings.branch.loading')
    ) : branches.status === 'error' && !branches.list.length ? (
      <>
        {t('repoSettings.branch.loadFailed')}{' '}
        <LinkButton size="sm" onClick={() => void load()}>
          {t('repoSettings.branch.tryAgain')}
        </LinkButton>
      </>
    ) : (
      t('repoSettings.branch.noMatch')
    )

  const label = repo.hasOrigin ? `${repo.remote}/${repo.defaultBranch}` : repo.defaultBranch
  const loading = branches.status === 'loading'

  return (
    <div className="repo-combo">
      <Combobox
        className="repo-combo-field"
        label={t('repoSettings.branch.search')}
        mono
        leading={<GitBranch size={13} className="faint" aria-hidden />}
        placeholder={label}
        value={repo.defaultBranch}
        options={options}
        onChange={choose}
        query={query}
        onQueryChange={setQuery}
        open={open}
        onOpenChange={onOpenChange}
        empty={empty}
        footer={branches.status === 'error' && branches.list.length > 0 ? t('repoSettings.branch.refreshFailed') : undefined}
      />
      <IconButton label={t('repoSettings.branch.fetch')} disabled={loading || !repo.hasOrigin} onClick={() => void load(true)}>
        {loading && branches.list.length ? <Spinner size={13} /> : <RefreshCw size={13} />}
      </IconButton>
    </div>
  )
}

// ---- remote ----

function RemoteRow({ repo }: { repo: Repo }) {
  const t = useT()
  const [remotes, setRemotes] = useState<string[] | null>(null)
  useEffect(() => {
    let live = true
    api
      .listRemotes(repo.id)
      .then((list) => live && setRemotes(list))
      .catch(() => live && setRemotes([]))
    return () => {
      live = false
    }
  }, [repo.id])

  const names = [...new Set([...(remotes ?? []), repo.remote])]
  const missing = remotes !== null && remotes.length > 0 && !remotes.includes(repo.remote)
  return (
    <Row
      id="repo-remote"
      label={t('repoSettings.remote.label')}
      help={t('repoSettings.remote.help')}
      detail={
        remotes?.length === 0 ? (
          t('repoSettings.remote.none')
        ) : missing ? (
          <span className="repo-warning-text">{t('repoSettings.remote.missing', { remote: repo.remote })}</span>
        ) : undefined
      }
      onReset={repo.remote !== 'origin' && remotes?.includes('origin') ? () => void saveRepo(repo.id, { remote: 'origin' }) : undefined}
    >
      <Select
        label={t('repoSettings.remote.label')}
        value={repo.remote}
        disabled={!remotes?.length}
        options={names.map((name) => ({ value: name, label: name }))}
        onChange={(remote) => void saveRepo(repo.id, { remote })}
      />
    </Row>
  )
}
