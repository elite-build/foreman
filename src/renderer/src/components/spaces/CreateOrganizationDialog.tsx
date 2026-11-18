// New organization (docs/ai-employees.md §3): a name, and the repositories to bring from Personal (the one the sidebar
// shows ticked). Its memory repository is never shown: main makes it beside the others, or in the organization's own
// folder when its repositories are kept together (then Clone and Quick start start there while the organization is
// showing). Linking it to GitHub is in Settings → Spaces. Its team (§15) is always the person and Priya, its program
// manager, made and approved with it (her definition is fixed), and any starting templates (§16) the person picks with
// the chips or Compare jobs, approved with her. One dialog, one call: main makes the memory repository (one commit), the
// team (one more), and moves the ticked repositories with their workspaces and chats.
import { useEffect, useId, useRef, useState } from 'react'
import { EMPLOYEE_TEMPLATES, type EmployeeTemplateId } from '../../../../shared/employeeTemplates'
import { defaultOrganizationFolder, organizationNameProblem, reposInSpace, type Organization, type OrganizationMemory, type OrganizationNameProblem } from '../../../../shared/organizations'
import type { PlainKey } from '../../../../shared/i18n'
import { PROGRAM_MANAGER_NAME } from '../../../../shared/projects'
import type { Repo } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, openCreateOrganization, setSpace, showToast, useStore } from '../../store'
import { Button, Callout, Card, Checkbox, Dialog, Field, HardHat, LinkButton, Tag, TextInput } from '../../ui'
import { LocationField } from '../AddRepository'
import { CompareJobs, PickedWho, TemplateChips } from './TeamTemplates'
import './spaces.css'

// One empty list, so a snapshot without organizations reads the same each time (useStore compares by identity).
export const NO_ORGANIZATIONS: Organization[] = []

export const NAME_PROBLEM: Record<OrganizationNameProblem, PlainKey> = {
  empty: 'spaces.name.empty',
  long: 'spaces.name.long',
  taken: 'spaces.name.taken'
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
  // The repository the sidebar shows is the likeliest to belong in it: ticked to start with.
  const viewing = useStore((s) => s.sidebarView.repo)
  // Made from Settings → Spaces: the sidebar shows the new organization and Settings stays open; elsewhere, its Home opens.
  const inSettings = useStore((s) => Boolean(s.settingsPage))
  const workspaceCount = useWorkspaceCount()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(viewing && reposInSpace(repos, organizations, null).some((r) => r.id === viewing) ? [viewing] : []))
  // Its repositories in a folder of their own: the folder follows the name until one is typed or browsed to.
  const [together, setTogether] = useState(false)
  const [folder, setFolder] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  // The starting templates picked, and whether Compare jobs is showing them as cards instead of the form.
  const [templates, setTemplates] = useState<ReadonlySet<EmployeeTemplateId>>(() => new Set())
  const [comparing, setComparing] = useState(false)
  const firstCard = useRef<HTMLButtonElement>(null)
  const compareLink = useRef<HTMLButtonElement>(null)
  const comparedOnce = useRef(false)
  const headingId = useId()
  const teamHeadingId = useId()
  const addHeadingId = useId()
  const togetherHintId = useId()

  // Into Compare jobs, focus goes to its first card; back out, to the link that opened it.
  useEffect(() => {
    if (comparing) {
      comparedOnce.current = true
      firstCard.current?.focus()
    } else if (comparedOnce.current) compareLink.current?.focus()
  }, [comparing])

  const close = () => !working && openCreateOrganization(false)
  // Shown once something is typed: an empty name only keeps Create off.
  // Not while it is being made: the organization it is making already has the name.
  const problem = name.trim() && !working ? organizationNameProblem(name, organizations) : null
  const folderPath = folder ?? defaultOrganizationFolder(name, cloneDirectory, repos)
  // Main names it `<organization>-memory` (or the next free name), in the organization's folder or beside the others.
  const memory: OrganizationMemory = { kind: 'auto', parentDir: together ? folderPath.trim() : cloneDirectory }
  const personal = reposInSpace(repos, organizations, null)
  const ready = Boolean(name.trim()) && !problem && Boolean(memory.parentDir.trim()) && !working

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked)
    if (on) next.add(id)
    else next.delete(id)
    setPicked(next)
  }
  const toggleTemplate = (id: EmployeeTemplateId, on: boolean) => {
    const next = new Set(templates)
    if (on) next.add(id)
    else next.delete(id)
    setTemplates(next)
  }
  const hired = EMPLOYEE_TEMPLATES.filter((tpl) => templates.has(tpl.id))
  const names = (list: string[]) => new Intl.ListFormat(t.locale, { type: 'conjunction' }).format(list)

  const submit = async () => {
    if (!ready) return
    setWorking(true)
    setError('')
    try {
      const org: Organization = await api.createOrganization({
        name: name.trim(),
        memory,
        repoIds: personal.filter((r) => picked.has(r.id)).map((r) => r.id),
        ...(together ? { folder: folderPath.trim() } : {}),
        ...(hired.length ? { templates: hired.map((tpl) => tpl.id) } : {})
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

  if (comparing)
    return (
      <Dialog
        title={t('spaces.compare.title')}
        description={t('spaces.compare.desc')}
        size="lg"
        closeLabel={t('common.back')}
        onClose={() => setComparing(false)}
        footer={
          <div className="space-dialog-footer">
            <span className="faint small">{hired.length ? t('spaces.compare.picked', { count: hired.length, names: names(hired.map((tpl) => tpl.name)) }) : t('spaces.compare.none')}</span>
            <Button variant="primary" onClick={() => setComparing(false)}>
              {t('common.done')}
            </Button>
          </div>
        }
      >
        <CompareJobs picked={templates} onToggle={toggleTemplate} firstRef={firstCard} />
      </Dialog>
    )

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
            {hired.length ? t('spaces.team.approvesMany', { names: names([PROGRAM_MANAGER_NAME, ...hired.map((tpl) => tpl.name)]) }) : t('spaces.team.approves', { name: PROGRAM_MANAGER_NAME })}
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
            <span className="faint small">{t('spaces.team.count', { count: 2 + hired.length })}</span>
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
            <Checkbox className="space-bring-row" checked disabled>
              <span className="space-team-who">
                <HardHat colour="teal" size={18} />
                <span className="space-bring-name">
                  {PROGRAM_MANAGER_NAME} <span className="faint small">{t('spaces.team.pm')}</span>
                </span>
                <Tag>{t('spaces.team.always')}</Tag>
              </span>
            </Checkbox>
            {hired.map((tpl) => (
              <Checkbox key={tpl.id} className="space-bring-row" checked onChange={(e) => toggleTemplate(tpl.id, e.target.checked)}>
                <PickedWho template={tpl} />
              </Checkbox>
            ))}
          </Card>
          <div className="space-team-heading">
            <span id={addHeadingId} className="space-heading">
              {t('spaces.team.add')}
            </span>
            <LinkButton ref={compareLink} onClick={() => setComparing(true)}>
              {t('spaces.team.compare')}
            </LinkButton>
          </div>
          <TemplateChips picked={templates} onToggle={toggleTemplate} labelledBy={addHeadingId} />
          <p className="faint small space-team-note">{t('spaces.team.addNote')}</p>
          <p className="faint small space-team-note">{t('spaces.team.proposes', { name: PROGRAM_MANAGER_NAME })}</p>
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
        {error && (
          <Callout tone="error" role="alert">
            {error}
          </Callout>
        )}
      </div>
    </Dialog>
  )
}
