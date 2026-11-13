// Create an organization (docs/ai-employees.md §3): a name; a memory repository (create a new one, use an existing
// repository, or decide later); and the repositories to bring from Personal. One dialog, one call: main makes the memory
// repository (one commit) if asked, and moves the ticked repositories with their workspaces and chats.
import { useId, useState } from 'react'
import {
  defaultMemoryName,
  isRepoFolderName,
  memoryChoices,
  organizationNameProblem,
  reposInSpace,
  type MemoryRefusal,
  type Organization,
  type OrganizationMemory,
  type OrganizationNameProblem
} from '../../../../shared/organizations'
import type { PlainKey } from '../../../../shared/i18n'
import { joinWorkspace } from '../../../../shared/openIn'
import type { Repo } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, openCreateOrganization, setSpace, useStore } from '../../store'
import { Button, Callout, Card, Checkbox, Dialog, Field, RadioList, Select, TextInput, type SelectOption } from '../../ui'
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
  // Made from Settings → Spaces: the sidebar shows the new organization and Settings stays open; elsewhere, its Home opens.
  const inSettings = useStore((s) => Boolean(s.settingsPage))
  const workspaceCount = useWorkspaceCount()
  const [name, setName] = useState('')
  const [memory, setMemory] = useState(() => newMemoryDraft(cloneDirectory))
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const headingId = useId()
  const hintId = useId()

  const close = () => !working && openCreateOrganization(false)
  // Shown once something is typed: an empty name only keeps Create off.
  const problem = name.trim() ? organizationNameProblem(name, organizations) : null
  const chosen = memoryOf(memory, name)
  // The memory repository picked from Personal moves with them; it isn't offered twice.
  const personal = reposInSpace(repos, organizations, null).filter((r) => !(memory.kind === 'existing' && r.id === memory.repoId))
  const moving = [...personal.filter((r) => picked.has(r.id)), ...(chosen?.kind === 'existing' ? repos.filter((r) => r.id === chosen.repoId) : [])]
  const ready = Boolean(name.trim()) && !problem && chosen !== null && !working

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked)
    if (on) next.add(id)
    else next.delete(id)
    setPicked(next)
  }

  const submit = async () => {
    if (!ready || !chosen) return
    setWorking(true)
    setError('')
    try {
      const org: Organization = await api.createOrganization({ name: name.trim(), memory: chosen, repoIds: personal.filter((r) => picked.has(r.id)).map((r) => r.id) })
      openCreateOrganization(false)
      setSpace(org.id, { home: !inSettings })
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
      size="lg"
      closeLabel={t('common.close')}
      onClose={close}
      footer={
        <div className="space-dialog-footer">
          <span className="faint small">{chosen?.kind === 'create' ? t('spaces.create.creates', { path: joinWorkspace(chosen.parentDir, chosen.name) }) : null}</span>
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
        <MemoryFields draft={memory} onChange={setMemory} organization={name} allowLater />
        <div className="space-bring" role="group" aria-labelledby={headingId} aria-describedby={hintId}>
          <div id={headingId} className="space-heading">
            {t('spaces.bring.heading')}
          </div>
          <p id={hintId} className="faint small">
            {t('spaces.bring.hint', { organization: name.trim() || t('spaces.memory.thisOrganization') })}
          </p>
          {personal.length ? (
            <Card className="space-bring-list">
              {personal.map((repo) => (
                <Checkbox key={repo.id} className="space-bring-row" checked={picked.has(repo.id)} onChange={(e) => toggle(repo.id, e.target.checked)}>
                  <span className="space-bring-name">{repo.name}</span>
                  <span className="faint small">{t('spaces.repo.workspaces', { count: workspaceCount(repo) })}</span>
                </Checkbox>
              ))}
            </Card>
          ) : (
            <p className="faint small">{t('spaces.bring.none')}</p>
          )}
        </div>
        <Callout tone="info">{moving.length ? t('spaces.create.summary', { count: moving.length }) : t('spaces.create.summaryNone')}</Callout>
        {error && (
          <Callout tone="error" role="alert">
            {error}
          </Callout>
        )}
      </div>
    </Dialog>
  )
}
