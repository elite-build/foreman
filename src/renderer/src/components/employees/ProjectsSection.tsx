// The sidebar's Channels row for an organization (docs/ai-employees.md §15), under its Team row: one row like Team's,
// with how many things its projects wait on the person for and a chevron that shows, remembered open or closed, the
// organization's channel (where `@Priya …` starts a project) and a channel per project going or lately closed, each with
// its state and what it is doing on the line under its name. Shown only while the organization is the space shown and
// has a memory repository.
import { ChevronDown, ChevronRight, Hash } from 'lucide-react'
import { useId } from 'react'
import { currentSpace, spacesOn } from '../../../../shared/organizations'
import { useT } from '../../i18n'
import { openEmployees, toggleProjectsOpen, useStore } from '../../store'
import { ActionRow, IconButton, Status } from '../../ui'
import { channelName, orgChannelSlug, projectStatus } from './projectWords'
import './employees.css'

export function ProjectsSection() {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const wanted = useStore((s) => s.space)
  const route = useStore((s) => s.employeesView)
  const open = useStore((s) => Boolean(s.projectsOpen))
  const listId = useId()
  const organizations = snapshot.organizations ?? []
  if (!spacesOn(organizations)) return null
  const space = currentSpace(organizations, wanted)
  const org = organizations.find((o) => o.id === space)
  if (!org?.memoryRepoId) return null
  const projects = snapshot.projects?.[org.id] ?? []
  const waiting = projects.reduce((n, p) => n + (p.phase === 'closed' ? 0 : p.waits.length), 0)
  const pm = org.programManagerId ? snapshot.employees?.[org.id]?.employees.find((e) => e.id === org.programManagerId) : undefined
  const pmName = pm?.name || t('projects.pmDefault')
  const orgSelected = route?.orgId === org.id && route.page === 'channel'
  return (
    <section className="team-section projects-section" aria-label={t('projects.heading')}>
      <ActionRow
        card
        className="team-entry"
        onPress={toggleProjectsOpen}
        primaryProps={{ 'aria-expanded': open, 'aria-controls': listId, 'aria-label': waiting ? t('sidebar.rail.needYou', { label: t('projects.heading'), count: waiting }) : t('projects.heading') }}
        actions={
          <IconButton className="team-entry-fold" label={t('projects.fold')} aria-expanded={open} aria-controls={listId} onClick={toggleProjectsOpen}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </IconButton>
        }
      >
        <Hash size={14} aria-hidden />
        <span className="team-entry-label">{t('projects.heading')}</span>
        {waiting > 0 && (
          <Status className="team-entry-count" compact tone="warn" label={t('home.banner.needYou', { count: waiting })}>
            <span aria-hidden>{waiting}</span>
          </Status>
        )}
      </ActionRow>
      <div id={listId} className="team-fold" hidden={!open}>
        <ul className="team-list" aria-label={t('projects.listLabel', { organization: org.name })}>
          <li>
            <ActionRow className="team-row" primaryProps={{ className: 'team-row-main' }} selected={orgSelected} onPress={() => openEmployees({ orgId: org.id, page: 'channel' })}>
              <span className="team-row-who">
                <span className="team-row-name">{channelName(orgChannelSlug(org.name))}</span>
              </span>
              <span className="team-row-line">
                <span className="team-row-doing">{t('projects.orgChannel.line', { name: pmName })}</span>
              </span>
            </ActionRow>
          </li>
          {projects.map((p) => {
            const status = projectStatus(p, t, pmName)
            const selected = route?.orgId === org.id && route.page === 'project' && route.id === p.id
            return (
              <li key={p.id}>
                <ActionRow className="team-row" primaryProps={{ className: 'team-row-main', title: p.title }} selected={selected} onPress={() => openEmployees({ orgId: org.id, page: 'project', id: p.id })}>
                  <span className="team-row-who">
                    <span className="team-row-name">{channelName(p.slug)}</span>
                  </span>
                  <span className="team-row-line">
                    <Status className="team-row-status" tone={status.tone} label={status.label} />
                    <span className="team-row-doing" title={status.line}>
                      {status.line}
                    </span>
                  </span>
                </ActionRow>
              </li>
            )
          })}
        </ul>
        {projects.length === 0 && <p className="team-empty">{t('projects.empty', { name: pmName })}</p>}
      </div>
    </section>
  )
}
