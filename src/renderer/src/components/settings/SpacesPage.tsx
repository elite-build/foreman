// Settings → Spaces ("Manage spaces…", docs/ai-employees.md §10): a card per space with its memory and its code
// repositories, Rename and Delete for an organization, and per repository a "Move to" choice of spaces. An
// organization's memory repository is never named or listed: its card says only whether the memory stays on this
// computer or is linked to a remote (Link to GitHub…, Push now, Unlink), and opens the Memory view. Shown only while AI
// employees are on (Settings → Experimental).
import { Brain, MoreHorizontal, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { defaultMemoryName, moveRefusal, organizationNameProblem, reposInSpace, spaceIcon, workspaceRepos, type MemoryLinkInput, type Organization } from '../../../../shared/organizations'
import { formatDate, formatDateTime } from '../../../../shared/i18n/time'
import type { Repo } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, openCreateOrganization, openMemory, openSettingsPage, showToast, useStore } from '../../store'
import { ActionRow, Button, Callout, Card, Dialog, Field, MenuButton, MenuGroup, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator, RadioList, Select, Spinner, TextInput } from '../../ui'
import { NAME_PROBLEM, NO_ORGANIZATIONS } from '../spaces/CreateOrganizationDialog'
import { useGithubAccounts } from './GithubAccount'
import { Page } from './controls'
import { IconPicker } from './RepoIcon'
import '../spaces/spaces.css'

export function SpacesPage() {
  const t = useT()
  const organizations = useStore((s) => s.snapshot!.organizations ?? NO_ORGANIZATIONS)
  const [renaming, setRenaming] = useState<Organization | null>(null)
  const [deleting, setDeleting] = useState<Organization | null>(null)
  const [linking, setLinking] = useState<Organization | null>(null)
  return (
    <Page title={t('spaces.page.title')} description={t('spaces.page.desc')}>
      <div className="spaces-actions">
        <Button icon={<Plus size={14} />} onClick={() => openCreateOrganization(true)}>
          {t('spaces.create.menu')}
        </Button>
      </div>
      <div className="spaces-grid">
        <SpaceCard organization={null} />
        {organizations.map((org) => (
          <SpaceCard key={org.id} organization={org} onRename={() => setRenaming(org)} onDelete={() => setDeleting(org)} onLink={() => setLinking(org)} />
        ))}
      </div>
      <p className="spaces-note faint small">{t('spaces.page.note')}</p>
      {renaming && <RenameOrganizationDialog organization={renaming} onClose={() => setRenaming(null)} />}
      {deleting && <DeleteOrganizationDialog organization={deleting} onClose={() => setDeleting(null)} />}
      {linking && <LinkMemoryDialog organization={linking} onClose={() => setLinking(null)} />}
    </Page>
  )
}

/** One space: Personal (`organization` null) or an organization. */
function SpaceCard({ organization, onRename, onDelete, onLink }: { organization: Organization | null; onRename?: () => void; onDelete?: () => void; onLink?: () => void }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const organizations = useStore((s) => s.snapshot!.organizations ?? NO_ORGANIZATIONS)
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const titleId = useId()
  const space = organization?.id ?? null
  const name = organization?.name ?? t('spaces.personal')
  // Code repositories only: the memory repository is the Memory section, never a repository in the list.
  const listed = workspaceRepos(reposInSpace(repos, organizations, space), organizations)
  const count = (repo: Repo) => workspaces.filter((w) => w.repoId === repo.id && w.state !== 'archived').length
  return (
    <Card as="section" className="space-card" aria-labelledby={titleId}>
      <div className="space-card-head">
        {/* An organization's icon (its tile on the sidebar's rail); with none, its repository of the same name lends one. */}
        {organization && (
          <IconPicker
            icon={spaceIcon(organization, repos)}
            name={organization.name}
            label={t('spaces.icon.change', { organization: organization.name })}
            dialog={t('spaces.icon.dialog')}
            save={(icon) => attempt(() => api.setOrganizationIcon(organization.id, icon)).then((saved) => Boolean(saved))}
          />
        )}
        <div>
          <h2 id={titleId} className="space-heading">
            {name}
          </h2>
          <div className="faint small">{organization ? t('spaces.org.since', { date: formatDate(organization.createdAt, t.locale, { day: 'numeric', month: 'short', year: 'numeric' }) }) : t('spaces.personal.detail')}</div>
        </div>
        {organization && (
          <div className="space-card-actions">
            <Button size="sm" aria-describedby={titleId} onClick={onRename}>
              {t('spaces.rename.button')}
            </Button>
            <Button size="sm" variant="danger" aria-describedby={titleId} onClick={onDelete}>
              {t('spaces.delete.button')}
            </Button>
          </div>
        )}
      </div>
      <div className="space-card-section">
        <div className="space-heading">{t('spaces.memory.heading')}</div>
        {organization ? <MemorySection organization={organization} titleId={titleId} onLink={onLink} /> : <div className="faint small">{t('spaces.personal.noMemory')}</div>}
      </div>
      <div className="space-card-section">
        <div className="space-heading">{t('spaces.repos.heading', { count: listed.length })}</div>
        {listed.length ? (
          <ul className="space-repos" aria-label={t('spaces.repos.label', { name })}>
            {listed.map((repo) => (
              <li key={repo.id}>
                <ActionRow divided actions={<MoveMenu repo={repo} />}>
                  <span className="space-repo">
                    <span className="space-repo-name">
                      <span>{repo.name}</span>
                    </span>
                    <span className="faint small">{t('spaces.repo.workspaces', { count: count(repo) })}</span>
                  </span>
                </ActionRow>
              </li>
            ))}
          </ul>
        ) : (
          <p className="faint small">{t('spaces.repos.none')}</p>
        )}
      </div>
    </Card>
  )
}

/**
 * An organization's memory: where it is kept (this computer, or the remote it is pushed to, with the last push or why it
 * failed), Open memory, and Link to GitHub… or Push now and Unlink. Without a memory repository yet (an organization that
 * decided later), Set up memory makes one beside its repositories, unnamed here as in New organization.
 */
function MemorySection({ organization, titleId, onLink }: { organization: Organization; titleId: string; onLink?: () => void }) {
  const t = useT()
  const cloneDirectory = useStore((s) => s.snapshot!.settings.cloneDirectory)
  const [busy, setBusy] = useState(false)
  const link = organization.memoryLink
  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    const result = await attempt(work)
    setBusy(false)
    if (result !== undefined && done) showToast(done)
  }
  if (!organization.memoryRepoId)
    return (
      <>
        <div className="faint small">{t('spaces.memory.none')}</div>
        <div className="space-card-memory">
          <Button
            size="sm"
            aria-describedby={titleId}
            disabled={busy}
            icon={busy ? <Spinner size={13} /> : undefined}
            onClick={() => void run(() => api.setOrganizationMemory(organization.id, { kind: 'auto', parentDir: organization.folder ?? cloneDirectory }))}
          >
            {t('spaces.memory.setUp')}
          </Button>
        </div>
      </>
    )
  return (
    <>
      <div className="faint small">{link ? t('spaces.memory.linked', { url: link.remoteUrl }) : t('spaces.memory.local')}</div>
      {link?.pushedAt && <div className="faint small">{t('spaces.memory.pushedAt', { date: formatDateTime(link.pushedAt, t.locale) })}</div>}
      {link?.error && (
        <Callout tone="error" role="alert">
          {t('spaces.memory.pushFailed', { reason: link.error })}
        </Callout>
      )}
      <div className="space-card-memory">
        <Button size="sm" icon={<Brain size={13} />} aria-describedby={titleId} onClick={() => openMemory(organization.id)}>
          {t('memory.open')}
        </Button>
        {link ? (
          <>
            <Button size="sm" aria-describedby={titleId} disabled={busy} icon={busy ? <Spinner size={13} /> : undefined} onClick={() => void run(() => api.pushOrganizationMemory(organization.id), t('spaces.memory.pushed'))}>
              {t('spaces.memory.pushNow')}
            </Button>
            <Button size="sm" aria-describedby={titleId} disabled={busy} onClick={() => void run(() => api.unlinkOrganizationMemory(organization.id), t('spaces.memory.unlinked'))}>
              {t('spaces.memory.unlink')}
            </Button>
          </>
        ) : (
          <Button size="sm" aria-describedby={titleId} onClick={onLink}>
            {t('spaces.memory.link')}
          </Button>
        )}
      </div>
    </>
  )
}

/** A repository's menu: Move to (Personal and each organization, the current one checked), then Repository settings…. */
function MoveMenu({ repo }: { repo: Repo }) {
  const t = useT()
  const organizations = useStore((s) => s.snapshot!.organizations ?? NO_ORGANIZATIONS)
  const current = repo.spaceId && organizations.some((o) => o.id === repo.spaceId) ? repo.spaceId : null
  const spaces: { id: string | null; name: string }[] = [{ id: null, name: t('spaces.personal') }, ...organizations.map((o) => ({ id: o.id, name: o.name }))]
  const move = (id: string | null) => {
    if (id === current) return
    void attempt(() => api.moveRepoToSpace(repo.id, id))
  }
  return (
    <MenuButton look="icon" portal placement="bottom-end" label={t('spaces.move.menu', { repo: repo.name })} trigger={<MoreHorizontal size={14} />}>
      <MenuLabel>{t('spaces.move.heading')}</MenuLabel>
      <MenuGroup label={t('spaces.move.heading')}>
        {spaces.map((space) => {
          const refused = space.id !== current && moveRefusal(repo.id, space.id, organizations)
          return (
            <MenuRadioItem
              key={space.id ?? 'personal'}
              checked={space.id === current}
              disabled={Boolean(refused)}
              title={refused ? t('spaces.move.memoryStays', { organization: refused.organization }) : undefined}
              onSelect={() => move(space.id)}
            >
              {space.name}
            </MenuRadioItem>
          )
        })}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem onSelect={() => openSettingsPage({ section: 'repo', repoId: repo.id })}>{t('sidebar.menu.repoSettings')}</MenuItem>
    </MenuButton>
  )
}

function RenameOrganizationDialog({ organization, onClose }: { organization: Organization; onClose: () => void }) {
  const t = useT()
  const organizations = useStore((s) => s.snapshot!.organizations ?? NO_ORGANIZATIONS)
  const [name, setName] = useState(organization.name)
  const [error, setError] = useState('')
  const problem = organizationNameProblem(name, organizations, organization.id)
  const save = async () => {
    if (problem) return
    try {
      await api.renameOrganization(organization.id, name.trim())
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <Dialog
      title={t('spaces.rename.title', { name: organization.name })}
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={Boolean(problem)} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-dialog-body">
        <Field label={t('spaces.name.label')} error={problem && problem !== 'empty' ? t(NAME_PROBLEM[problem]) : undefined}>
          {(control) => <TextInput {...control} autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />}
        </Field>
        {error && (
          <Callout tone="error" role="alert">
            {error}
          </Callout>
        )}
      </div>
    </Dialog>
  )
}

function DeleteOrganizationDialog({ organization, onClose }: { organization: Organization; onClose: () => void }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const organizations = useStore((s) => s.snapshot!.organizations ?? NO_ORGANIZATIONS)
  const count = reposInSpace(repos, organizations, organization.id).length
  const remove = async () => {
    const done = await attempt(async () => (await api.deleteOrganization(organization.id), true))
    if (done) onClose()
  }
  return (
    <Dialog
      title={t('spaces.delete.title', { name: organization.name })}
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} autoFocus>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={() => void remove()}>
            {t('spaces.delete.confirm')}
          </Button>
        </>
      }
    >
      <p>{t('spaces.delete.body', { count })}</p>
    </Dialog>
  )
}

/**
 * Link to GitHub…: a new private repository made with gh (named `<organization>-memory` to start with), or the URL of an
 * empty one the person already has. Linking pushes the memory there at once; from then on each memory commit is pushed.
 */
function LinkMemoryDialog({ organization, onClose }: { organization: Organization; onClose: () => void }) {
  const t = useT()
  const accounts = useGithubAccounts()
  const [kind, setKind] = useState<MemoryLinkInput['kind']>('create')
  const [name, setName] = useState(() => defaultMemoryName(organization.name))
  const [url, setUrl] = useState('')
  const [account, setAccount] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const who = account || undefined
  const input: MemoryLinkInput | null = kind === 'create' ? (name.trim() ? { kind, name: name.trim(), account: who } : null) : url.trim() ? { kind, remoteUrl: url.trim(), account: who } : null
  const save = async () => {
    if (!input || working) return
    setWorking(true)
    setError('')
    try {
      await api.linkOrganizationMemory(organization.id, input)
      showToast(t('spaces.link.done', { name: organization.name }))
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }
  return (
    <Dialog
      title={t('spaces.link.title', { name: organization.name })}
      description={t('spaces.link.desc')}
      closeLabel={t('common.close')}
      onClose={() => !working && onClose()}
      footer={
        <>
          <Button onClick={onClose} disabled={working}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!input || working} icon={working ? <Spinner size={13} /> : undefined} onClick={() => void save()}>
            {working ? t('spaces.link.working') : t('spaces.link.submit')}
          </Button>
        </>
      }
    >
      <div className="space-dialog-body">
        <RadioList
          legend={t('spaces.link.legend')}
          value={kind}
          onChange={setKind}
          options={[
            {
              value: 'create',
              label: t('spaces.link.create'),
              description: t('spaces.link.createHint'),
              extra:
                kind === 'create' ? (
                  <div className="space-memory-extra">
                    <Field label={t('spaces.link.name')}>{(control) => <TextInput {...control} mono spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
                  </div>
                ) : undefined
            },
            {
              value: 'existing',
              label: t('spaces.link.existing'),
              description: t('spaces.link.existingHint'),
              extra:
                kind === 'existing' ? (
                  <div className="space-memory-extra">
                    <Field label={t('spaces.link.url')}>
                      {(control) => <TextInput {...control} mono spellCheck={false} placeholder="https://github.com/you/memory.git" value={url} onChange={(e) => setUrl(e.target.value)} />}
                    </Field>
                  </div>
                ) : undefined
            }
          ]}
        />
        {accounts && accounts.length > 0 && (
          <Field label={t('settings.gitBackup.account')}>
            {(control) => (
              <Select
                {...control}
                value={account}
                onChange={setAccount}
                options={[{ value: '', label: t('settings.gitBackup.activeAccount') }, ...accounts.map((a) => ({ value: a.login, label: a.active ? t('settings.gitBackup.accountActive', { login: a.login }) : a.login }))]}
              />
            )}
          </Field>
        )}
        <p className="faint small">{t('spaces.link.private')}</p>
        {error && (
          <Callout tone="error" role="alert">
            {error}
          </Callout>
        )}
      </div>
    </Dialog>
  )
}
