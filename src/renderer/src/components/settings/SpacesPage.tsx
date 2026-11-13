// Settings → Spaces ("Manage spaces…", docs/ai-employees.md §10): a card per space with its memory repository and
// its repositories, Rename and Delete for an organization, and per repository a "Move to" choice of spaces. Shown only
// while AI employees are on (Settings → Experimental).
import { Brain, MoreHorizontal, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { memoryOwner, moveRefusal, organizationNameProblem, reposInSpace, type Organization } from '../../../../shared/organizations'
import { formatDate } from '../../../../shared/i18n/time'
import type { Repo } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, openCreateOrganization, openMemory, openSettingsPage, useStore } from '../../store'
import { ActionRow, Button, Callout, Card, Dialog, Field, LinkButton, MenuButton, MenuGroup, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator, Tag, TextInput } from '../../ui'
import { MemoryFields, memoryOf, NAME_PROBLEM, newMemoryDraft, NO_ORGANIZATIONS } from '../spaces/CreateOrganizationDialog'
import { Page } from './controls'
import '../spaces/spaces.css'

export function SpacesPage() {
  const t = useT()
  const organizations = useStore((s) => s.snapshot!.organizations ?? NO_ORGANIZATIONS)
  const [renaming, setRenaming] = useState<Organization | null>(null)
  const [deleting, setDeleting] = useState<Organization | null>(null)
  const [choosing, setChoosing] = useState<Organization | null>(null)
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
          <SpaceCard key={org.id} organization={org} onRename={() => setRenaming(org)} onDelete={() => setDeleting(org)} onChooseMemory={() => setChoosing(org)} />
        ))}
      </div>
      <p className="spaces-note faint small">{t('spaces.page.note')}</p>
      {renaming && <RenameOrganizationDialog organization={renaming} onClose={() => setRenaming(null)} />}
      {deleting && <DeleteOrganizationDialog organization={deleting} onClose={() => setDeleting(null)} />}
      {choosing && <ChooseMemoryDialog organization={choosing} onClose={() => setChoosing(null)} />}
    </Page>
  )
}

/** One space: Personal (`organization` null) or an organization. */
function SpaceCard({ organization, onRename, onDelete, onChooseMemory }: { organization: Organization | null; onRename?: () => void; onDelete?: () => void; onChooseMemory?: () => void }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const organizations = useStore((s) => s.snapshot!.organizations ?? NO_ORGANIZATIONS)
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  const titleId = useId()
  const space = organization?.id ?? null
  const name = organization?.name ?? t('spaces.personal')
  const inSpace = reposInSpace(repos, organizations, space)
  const memory = organization?.memoryRepoId ? repos.find((r) => r.id === organization.memoryRepoId) : undefined
  // The memory repository first, as the sidebar lists it.
  const listed = memory ? [memory, ...inSpace.filter((r) => r.id !== memory.id)] : inSpace
  const count = (repo: Repo) => workspaces.filter((w) => w.repoId === repo.id && w.state !== 'archived').length
  return (
    <Card as="section" className="space-card" aria-labelledby={titleId}>
      <div className="space-card-head">
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
        <div className="space-heading">{t('spaces.memory.legend')}</div>
        <div className="space-card-memory">
          {memory ? (
            <>
              <span>{memory.name}</span>
              <Tag>{t('spaces.memoryTag')}</Tag>
              {organization && (
                <Button size="sm" icon={<Brain size={13} />} aria-describedby={titleId} onClick={() => openMemory(organization.id)}>
                  {t('memory.open')}
                </Button>
              )}
            </>
          ) : (
            <>
              <span className="faint">{t('common.none')}</span>
              {organization && (
                <LinkButton underline onClick={onChooseMemory} aria-describedby={titleId}>
                  {t('spaces.memory.chooseLink')}
                </LinkButton>
              )}
            </>
          )}
        </div>
        <div className="faint small">{organization ? (memory ? memory.rootPath : t('spaces.memory.laterHint')) : t('spaces.personal.noMemory')}</div>
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
                      {repo.id === memory?.id && <Tag>{t('spaces.memoryTag')}</Tag>}
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

/** A repository's menu: Move to (Personal and each organization, the current one checked), then Repository settings…. */
function MoveMenu({ repo }: { repo: Repo }) {
  const t = useT()
  const organizations = useStore((s) => s.snapshot!.organizations ?? NO_ORGANIZATIONS)
  const current = repo.spaceId && organizations.some((o) => o.id === repo.spaceId) ? repo.spaceId : null
  const owner = memoryOwner(repo.id, organizations)
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
              // The memory repository's own space says why the others are off: a disabled item can't be focused to read it.
              description={space.id === current && owner ? t('spaces.move.memoryStays', { organization: owner.name }) : undefined}
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

/** "Choose one…": an organization that decided later gets its memory repository now. */
function ChooseMemoryDialog({ organization, onClose }: { organization: Organization; onClose: () => void }) {
  const t = useT()
  const cloneDirectory = useStore((s) => s.snapshot!.settings.cloneDirectory)
  const [draft, setDraft] = useState(() => newMemoryDraft(cloneDirectory))
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const chosen = memoryOf(draft, organization.name)
  const save = async () => {
    if (!chosen || working) return
    setWorking(true)
    setError('')
    try {
      await api.setOrganizationMemory(organization.id, chosen)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }
  return (
    <Dialog
      title={t('spaces.memory.chooseTitle', { name: organization.name })}
      size="lg"
      closeLabel={t('common.close')}
      onClose={() => !working && onClose()}
      footer={
        <>
          <Button onClick={onClose} disabled={working}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!chosen || working} onClick={() => void save()}>
            {working ? t('spaces.create.working') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-dialog-body">
        <MemoryFields draft={draft} onChange={setDraft} organization={organization.name} organizationId={organization.id} allowLater={false} />
        {error && (
          <Callout tone="error" role="alert">
            {error}
          </Callout>
        )}
      </div>
    </Dialog>
  )
}
