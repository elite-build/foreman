// New organization (docs/ai-employees.md §3): a name, and the repositories to bring from Personal (the one the sidebar
// shows ticked). Its memory repository is made beside the others unless More options says otherwise (another folder, an
// existing repository, or later), or its repositories are kept in a folder of their own: then it is made there, and
// Clone and Quick start start there while the organization is showing. Its team (§15) is always the same two: the
// person, and Priya, its program manager, made and approved with it (her definition is fixed). One dialog, one call: main makes the memory repository (one
// commit) if asked, Priya (one more), and moves the ticked repositories with their workspaces and chats.
import { useId, useState } from 'react'
import {
  defaultMemoryName,
  defaultOrganizationFolder,
  isRepoFolderName,
  memoryChoices,
  organizationNameProblem,
  reposInSpace,
  samePath,
  type MemoryRefusal,
  type Organization,
  type OrganizationMemory,
  type OrganizationNameProblem
} from '../../../../shared/organizations'
import type { PlainKey } from '../../../../shared/i18n'
import { joinWorkspace } from '../../../../shared/openIn'
import { PROGRAM_MANAGER_NAME } from '../../../../shared/projects'
import type { Repo } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, openCreateOrganization, setSpace, showToast, useStore } from '../../store'
import { Button, Callout, Card, Checkbox, Dialog, Field, HardHat, LinkButton, RadioList, Select, Tag, TextInput, type SelectOption } from '../../ui'
import { LocationField } from '../AddRepository'
import './spaces.css'

/** What the memory repository fields hold while the dialog is open. `named`: the person typed a name of their own. */
export interface MemoryDraft {
  kind: OrganizationMemory['kind']
  name: string
  named: boolean
  parentDir: string
  repoId: string
}

// One empty list, so a snapshot without organizations reads the same each time (useStore compares by identity).
export const NO_ORGANIZATIONS: Organization[] = []

export const NAME_PROBLEM: Record<OrganizationNameProblem, PlainKey> = {
  empty: 'spaces.name.empty',
  long: 'spaces.name.long',
  taken: 'spaces.name.taken'
}

export function newMemoryDraft(parentDir: string, kind: MemoryDraft['kind'] = 'create'): MemoryDraft {
  return { kind, name: '', named: false, parentDir, repoId: '' }
}

/** The memory repository's folder name: the one typed, else `<organization>-memory`. */
export const memoryName = (draft: MemoryDraft, organization: string) => (draft.named ? draft.name : defaultMemoryName(organization))

/** The draft as the API takes it, or null while it isn't complete. */
export function memoryOf(draft: MemoryDraft, organization: string): OrganizationMemory | null {
  if (draft.kind === 'later') return { kind: 'later' }
  if (draft.kind === 'existing') return draft.repoId ? { kind: 'existing', repoId: draft.repoId } : null
  const name = memoryName(draft, organization).trim()
  return isRepoFolderName(name) && draft.parentDir.trim() ? { kind: 'create', name, parentDir: draft.parentDir.trim() } : null
}

/** Why a repository isn't offered as the memory repository, in words. */
function refusalText(refusal: MemoryRefusal, t: ReturnType<typeof useT>): string {
  return refusal.kind === 'memory-of' ? t('spaces.memory.refused.memoryOf', { organization: refusal.organization }) : t('spaces.memory.refused.inSpace', { organization: refusal.organization })
}

/**
 * The memory repository choice: create a new one (name and folder, with Browse), use an existing repository, or (when
 * `allowLater`) decide later. `organization` is the organization's name (for the default folder name and the hints);
 * `organizationId` an existing organization's id (its own repositories are offered too).
 */
export function MemoryFields({
  draft,
  onChange,
  organization,
  organizationId,
  allowLater
}: {
  draft: MemoryDraft
  onChange: (draft: MemoryDraft) => void
  organization: string
  organizationId?: string
  allowLater: boolean
}) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const organizations = useStore((s) => s.snapshot!.organizations ?? NO_ORGANIZATIONS)
  const introId = useId()
  const lineId = useId()
  const set = (patch: Partial<MemoryDraft>) => onChange({ ...draft, ...patch })
  const name = memoryName(draft, organization)
  const shown = organization.trim() || t('spaces.memory.thisOrganization')
  const choices = memoryChoices(repos, organizations, organizationId)
  const options: SelectOption<string>[] = [
    { value: '', label: t('spaces.memory.choose'), disabled: true },
    ...choices.map(({ repo, refusal }) =>
      refusal ? { value: repo.id, label: `${repo.name} · ${refusalText(refusal, t)}`, group: t('spaces.memory.notOffered'), disabled: true } : { value: repo.id, label: repo.name }
    )
  ]
  return (
    <div className="space-memory">
      <p id={introId} className="faint small">
        {t('spaces.memory.intro')}
      </p>
      <RadioList
        legend={t('spaces.memory.legend')}
        aria-describedby={`${introId} ${lineId}`}
        value={draft.kind}
        onChange={(kind) => set({ kind })}
        options={[
          {
            value: 'create',
            label: t('spaces.memory.create'),
            description: t('spaces.memory.createHint'),
            extra:
              draft.kind === 'create' ? (
                <div className="space-memory-extra">
                  <Field label={t('spaces.memory.name')} error={name.trim() && !isRepoFolderName(name) ? t('spaces.memory.nameInvalid') : undefined}>
                    {(control) => <TextInput {...control} mono spellCheck={false} value={name} onChange={(e) => set({ name: e.target.value, named: true })} />}
                  </Field>
                  <LocationField value={draft.parentDir} onChange={(parentDir) => set({ parentDir })} title={t('spaces.memory.locationTitle')} />
                </div>
              ) : undefined
          },
          {
            value: 'existing',
            label: t('spaces.memory.existing'),
            description: t('spaces.memory.existingHint', { organization: shown }),
            extra:
              draft.kind === 'existing' ? (
                <div className="space-memory-extra">
                  <Field label={t('spaces.memory.repository')}>{(control) => <Select {...control} value={draft.repoId} options={options} onChange={(repoId) => set({ repoId })} />}</Field>
                </div>
              ) : undefined
          },
          ...(allowLater ? [{ value: 'later' as const, label: t('spaces.memory.later'), description: t('spaces.memory.laterHint') }] : [])
        ]}
      />
      <p id={lineId} className="faint small">
        {t('spaces.memory.neverShared')}
      </p>
    </div>
  )
}

/** The last part of a folder's path: "foreman-org" for C:\code\foreman-org. */
const folderName = (dir: string) => dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? dir

/** "3 workspaces", for a repository in a list. */
function useWorkspaceCount(): (repo: Repo) => number {
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  return (repo) => workspaces.filter((w) => w.repoId === repo.id && w.state !== 'archived').length
}

export function CreateOrganizationDialog() {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const organizations = useStore((s) => s.snapshot!.organizations ?? NO_ORGANIZATIONS)
  const cloneDirectory = useStore((s) => s.snapshot!.settings.cloneDirectory)
  // The repository the sidebar shows is the likeliest to belong in it: ticked to start with.
  const viewing = useStore((s) => s.sidebarView.repo)
  // Made from Settings → Spaces: the sidebar shows the new organization and Settings stays open; elsewhere, its Home opens.
  const inSettings = useStore((s) => Boolean(s.settingsPage))
  const workspaceCount = useWorkspaceCount()
  const [name, setName] = useState('')
  const [memory, setMemory] = useState(() => newMemoryDraft(cloneDirectory))
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(viewing && reposInSpace(repos, organizations, null).some((r) => r.id === viewing) ? [viewing] : []))
  // The memory repository's other choices (its folder, an existing repository, later) wait behind More options.
  const [more, setMore] = useState(false)
  // Its repositories in a folder of their own: the folder follows the name until one is typed or browsed to.
  const [together, setTogether] = useState(false)
  const [folder, setFolder] = useState<string | null>(null)
  // The memory repository goes in that folder until More options puts it somewhere else.
  const [memoryPlaced, setMemoryPlaced] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const headingId = useId()
  const teamHeadingId = useId()
  const togetherHintId = useId()

  const close = () => !working && openCreateOrganization(false)
  // Shown once something is typed: an empty name only keeps Create off.
  // Not while it is being made: the organization it is making already has the name.
  const problem = name.trim() && !working ? organizationNameProblem(name, organizations) : null
  const folderPath = folder ?? defaultOrganizationFolder(name, cloneDirectory, repos)
  const memoryParent = together && !memoryPlaced ? folderPath : memory.parentDir
  const placedMemory = { ...memory, parentDir: memoryParent }
  const chosen = memoryOf(placedMemory, name)
  // The memory repository picked from Personal moves with them; it isn't offered twice.
  const personal = reposInSpace(repos, organizations, null).filter((r) => !(memory.kind === 'existing' && r.id === memory.repoId))
  const ready = Boolean(name.trim()) && !problem && chosen !== null && !(together && !folderPath.trim()) && !working
  // What happens to memory, in one line while More options is closed (the default: a new repository beside the others).
  const memoryLine =
    memory.kind === 'create'
      ? samePath(memoryParent, cloneDirectory)
        ? t('spaces.create.memoryLine', { name: memoryName(memory, name) })
        : t('spaces.create.memoryLineAt', { name: memoryName(memory, name), folder: together && samePath(memoryParent, folderPath) ? folderName(folderPath) : memoryParent.trim() })
      : memory.kind === 'existing'
        ? t('spaces.create.memoryExisting', { name: repos.find((r) => r.id === memory.repoId)?.name ?? '' })
        : t('spaces.memory.laterHint')

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked)
    if (on) next.add(id)
    else next.delete(id)
    setPicked(next)
  }
  // Priya lives in the memory repository: while it is decided later, she comes with it.
  const teamPossible = memory.kind !== 'later'

  const submit = async () => {
    if (!ready || !chosen) return
    setWorking(true)
    setError('')
    try {
      const org: Organization = await api.createOrganization({
        name: name.trim(),
        memory: chosen,
        repoIds: personal.filter((r) => picked.has(r.id)).map((r) => r.id),
        ...(together ? { folder: folderPath.trim() } : {})
      })
      openCreateOrganization(false)
      setSpace(org.id, { home: !inSettings })
      // The organization was made; only its program manager wasn't (said once, never kept).
      if (org.teamProblem) showToast(t('spaces.team.failed', { reason: org.teamProblem }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  return (
    <Dialog
      title={t('spaces.create.title')}
      description={t('spaces.create.desc')}
      size="md"
      closeLabel={t('common.close')}
      onClose={close}
      footer={
        <div className="space-dialog-footer">
          <span className="faint small">
            {more && chosen?.kind === 'create' ? t('spaces.create.creates', { path: joinWorkspace(chosen.parentDir, chosen.name) }) : teamPossible ? t('spaces.team.approves', { name: PROGRAM_MANAGER_NAME }) : null}
          </span>
          <Button onClick={close} disabled={working}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!ready}>
            {working ? t('spaces.create.working') : t('spaces.create.submit')}
          </Button>
        </div>
      }
    >
      <div
        className="space-dialog-body"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text') {
            e.preventDefault()
            void submit()
          }
        }}
      >
        <Field label={t('spaces.name.label')} error={problem ? t(NAME_PROBLEM[problem]) : undefined}>
          {(control) => <TextInput {...control} autoFocus value={name} placeholder={t('spaces.name.placeholder')} onChange={(e) => setName(e.target.value)} />}
        </Field>
        {personal.length > 0 && (
          <div className="space-bring" role="group" aria-labelledby={headingId}>
            <div id={headingId} className="space-heading">
              {t('spaces.bring.heading')}
            </div>
            <Card className="space-bring-list">
              {personal.map((repo) => (
                <Checkbox key={repo.id} className="space-bring-row" checked={picked.has(repo.id)} onChange={(e) => toggle(repo.id, e.target.checked)}>
                  <span className="space-bring-name">{repo.name}</span>
                  <span className="faint small">{t('spaces.repo.workspaces', { count: workspaceCount(repo) })}</span>
                </Checkbox>
              ))}
            </Card>
          </div>
        )}
        <div className="space-bring" role="group" aria-labelledby={teamHeadingId}>
          <div className="space-heading space-team-heading">
            <span id={teamHeadingId}>{t('spaces.team.heading')}</span>
            <span className="faint small">{t('spaces.team.count', { count: teamPossible ? 2 : 1 })}</span>
          </div>
          <Card className="space-bring-list space-team-list">
            <Checkbox className="space-bring-row" checked disabled>
              <span className="space-team-who">
                <HardHat colour="slate" size={18} />
                <span className="space-bring-name">
                  {t('projects.you')} <span className="faint small">{t('spaces.team.you')}</span>
                </span>
                <Tag>{t('spaces.team.always')}</Tag>
              </span>
            </Checkbox>
            <Checkbox className="space-bring-row" checked={teamPossible} disabled>
              <span className="space-team-who">
                <HardHat colour="teal" size={18} />
                <span className="space-bring-name">
                  {PROGRAM_MANAGER_NAME} <span className="faint small">{t('spaces.team.pm')}</span>
                </span>
                <Tag>{t('spaces.team.always')}</Tag>
              </span>
            </Checkbox>
          </Card>
          <p className="faint small space-team-note">{teamPossible ? t('spaces.team.proposes', { name: PROGRAM_MANAGER_NAME }) : t('spaces.team.needsMemory', { name: PROGRAM_MANAGER_NAME })}</p>
        </div>
        <div className="space-together">
          <Checkbox checked={together} onChange={(e) => setTogether(e.target.checked)} aria-describedby={togetherHintId}>
            {t('spaces.create.together')}
          </Checkbox>
          <p id={togetherHintId} className="faint small space-together-hint">
            {t('spaces.create.togetherHint', { name: name.trim() || t('spaces.memory.thisOrganization') })}
          </p>
          {together && (
            <div className="space-together-extra">
              <LocationField value={folderPath} onChange={setFolder} title={t('spaces.create.folderTitle')} />
            </div>
          )}
        </div>
        {more ? (
          <MemoryFields
            draft={placedMemory}
            onChange={(next) => {
              // Until a folder of its own is chosen here, the draft keeps the one it would go back to.
              const placed = memoryPlaced || next.parentDir !== memoryParent
              setMemoryPlaced(placed)
              setMemory(placed ? next : { ...next, parentDir: memory.parentDir })
            }}
            organization={name}
            allowLater
          />
        ) : (
          <p className="faint small">
            {memoryLine}{' '}
            <LinkButton onClick={() => setMore(true)}>{t('spaces.create.more')}</LinkButton>
          </p>
        )}
        {error && (
          <Callout tone="error" role="alert">
            {error}
          </Callout>
        )}
      </div>
    </Dialog>
  )
}
