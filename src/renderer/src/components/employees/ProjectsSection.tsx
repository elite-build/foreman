// The sidebar's Channels section for an organization (docs/ai-employees.md §15), under its Team section: a heading like
// every other section's (SidebarSection: it folds, remembered, and says ▲ and how many things its projects wait on the
// person for while folded), then one line per channel: the organization's channel, and a channel per project going or
// closed and not archived, with its state by shape, its name and what it is doing (who is at it while an employee works
// on it, else its stage), and a ⋯ menu (rename, archive, delete) shown on hover and focus. "All channels" under them opens
// the Channels page, where archived ones are too; a new channel is in the sidebar's + menu (NewMenu). Shown only while the
// organization is the space shown and has a memory repository.
import { Hash } from 'lucide-react'
import { currentSpace, spacesOn } from '../../../../shared/organizations'
import { projectLive } from '../../../../shared/projects'
import { useT } from '../../i18n'
import { openEmployees, toggleProjectsOpen, useStore } from '../../store'
import { ActionRow, LinkButton, Status } from '../../ui'
import { SidebarSection } from '../SidebarSection'
import { ChannelMenu } from './ChannelActions'
import { isWorking, liveWhat } from './ProjectLive'
import { channelName, orgChannelSlug, projectChannel, projectStatus } from './projectWords'
import './employees.css'

export function ProjectsSection() {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const wanted = useStore((s) => s.space)
  const route = useStore((s) => s.employeesView)
  const open = useStore((s) => Boolean(s.projectsOpen))
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
  const runs = snapshot.employeeWork?.[org.id]?.runs ?? []
  const nameOf = (id: string) => snapshot.employees?.[org.id]?.employees.find((e) => e.id === id)?.name || id
  return (
    <SidebarSection className="projects-section" name={t('projects.heading')} count={projects.length + 1} needs={waiting} open={open} onToggle={toggleProjectsOpen}>
      <ul className="sb-list" aria-label={t('projects.listLabel', { organization: org.name })}>
        <li>
          <ActionRow className="sb-row" primaryProps={{ className: 'sb-row-main' }} selected={orgSelected} onPress={() => openEmployees({ orgId: org.id, page: 'channel' })}>
            <span className="sb-row-icon">
              <Hash size={13} aria-hidden />
            </span>
            <span className="sb-row-name">{channelName(orgChannelSlug(org.name))}</span>
            <span className="sb-row-line">{t('projects.orgChannel.line', { name: pmName })}</span>
          </ActionRow>
        </li>
        {projects.map((p) => {
          const status = projectStatus(p, t, pmName)
          const live = projectLive(p, runs)
          // While someone works on it, the line says who and on what; else what its stage is.
          const line = isWorking(live) ? liveWhat(p, live[0], nameOf(live[0].step.employeeId), t) : status.line
          const selected = route?.orgId === org.id && route.page === 'project' && route.id === p.id
          return (
            <li key={p.id}>
              <ActionRow
                className="sb-row"
                primaryProps={{ className: 'sb-row-main', title: [p.title, line].filter(Boolean).join(' · ') }}
                selected={selected}
                onPress={() => openEmployees({ orgId: org.id, page: 'project', id: p.id })}
                revealActions
                actions={<ChannelMenu project={p} />}
              >
                {/* Its state by shape; the word is the button's too. */}
                <span className="sb-row-icon">
                  <Status compact tone={status.tone} busy={isWorking(live)} label={status.label} />
                </span>
                <span className="sb-row-name">{projectChannel(p)}</span>
                <span className="sb-row-line">{line}</span>
              </ActionRow>
            </li>
          )
        })}
      </ul>
      {projects.length === 0 && <p className="sb-empty">{t('projects.empty', { name: pmName })}</p>}
      <LinkButton size="sm" className="sb-link" aria-current={route?.orgId === org.id && route.page === 'channels' ? 'page' : undefined} onClick={() => openEmployees({ orgId: org.id, page: 'channels' })}>
        {t('projects.all.row')}
      </LinkButton>
    </SidebarSection>
  )
}
