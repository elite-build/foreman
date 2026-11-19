// An organization's channel (docs/ai-employees.md §15): where a project starts. Its program manager's welcome, then each
// project as the line that started it with a link to its own channel, then the message box: "@Priya …" starts a project
// (she plans it in its channel), "@Ravi …" asks Ravi as Ask does. A small change is still a workspace: the line under the
// box opens New workspace. Beside it: who is here, the projects and the repositories. An organization made before
// program managers gets an Add button instead. The sidebar's + (a new channel) opens it with "@Priya " in the box.
import { mentionOf, type Project } from '../../../../shared/projects'
import { reposInSpace } from '../../../../shared/organizations'
import { useT } from '../../i18n'
import { api, attempt, openEmployees, openNewWorkspace, showToast, useStore } from '../../store'
import { Button, Callout, Card, CardButton, HardHat, LinkButton, Select, Status, type HardHatColour } from '../../ui'
import { useState } from 'react'
import { ChannelComposer, Post, type ChannelMember } from './Channel'
import { isWorking, useProjectLive } from './ProjectLive'
import { channelName, orgChannelSlug, projectChannel, projectStatus } from './projectWords'
import './employees.css'

export function OrgChannel({ orgId, mention }: { orgId: string; mention?: number }) {
  const t = useT()
  const organization = useStore((s) => s.snapshot!.organizations?.find((o) => o.id === orgId))
  const roster = useStore((s) => s.snapshot!.employees?.[orgId]?.employees)
  const projects = useStore((s) => s.snapshot!.projects?.[orgId])
  const allRepos = useStore((s) => s.snapshot!.repos)
  const organizations = useStore((s) => s.snapshot!.organizations)
  const [repoId, setRepoId] = useState('')
  const [adding, setAdding] = useState(false)
  if (!organization) return null
  const work = reposInSpace(allRepos, organizations ?? [], orgId).filter((r) => r.id !== organization.memoryRepoId)
  const repo = work.find((r) => r.id === repoId) ?? work[0]
  const employees = (roster ?? []).filter((e) => e.state !== 'retired')
  const pm = employees.find((e) => e.id === organization.programManagerId)
  const pmName = pm?.name || t('projects.pmDefault')
  const members: ChannelMember[] = [...(pm ? [pm] : []), ...employees.filter((e) => e !== pm)].map((e) => ({ id: e.id, name: e.name || e.id, colour: e.colour, role: e.role }))
  const listed = [...(projects ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const send = async (text: string): Promise<boolean> => {
    const m = mentionOf(
      text,
      members.map((x) => x.name)
    )
    const to = m ? members.find((x) => x.name === m.name) : undefined
    if (!m || !to || !m.rest) {
      showToast(to ? t('projects.composer.askWhat', { name: to.name }) : t('projects.orgChannel.tagFirst', { name: pmName }))
      return false
    }
    let ok = false
    await attempt(async () => {
      if (to.id === organization.programManagerId) {
        const project = await api.startProject(orgId, { requirement: m.rest, ...(repo ? { repoId: repo.id } : {}) })
        showToast(t('projects.started', { title: project.title, name: pmName }))
        openEmployees({ orgId, page: 'project', id: project.id })
      } else {
        await api.askEmployee(orgId, to.id, { body: m.rest, ...(repo ? { repoId: repo.id } : {}) })
        showToast(t('projects.orgChannel.asked', { name: to.name }))
      }
      ok = true
    })
    return ok
  }
  const add = () => {
    setAdding(true)
    void attempt(() => api.addProgramManager(orgId)).finally(() => setAdding(false))
  }
  return (
    <div className="channel-page">
      <div className="channel-main">
        <div className="team-page-head">
          <div className="project-head-who">
            <h2 className="employee-name">{channelName(orgChannelSlug(organization.name))}</h2>
            <span className="employee-faint">{t('projects.orgChannel.about', { organization: organization.name })}</span>
          </div>
        </div>
        {!pm && (
          <Callout
            tone="info"
            title={t('projects.pmMissing.title')}
            actions={
              <Button size="sm" variant="primary" disabled={adding} onClick={add}>
                {t('projects.pmMissing.add', { name: t('projects.pmDefault') })}
              </Button>
            }
          >
            {t('projects.pmMissing.body')}
          </Callout>
        )}
        <ol className="channel-timeline" aria-label={t('projects.timeline', { channel: channelName(orgChannelSlug(organization.name)) })}>
          {pm && (
            <Post who={pmName} colour={pm.colour} role={pm.role} at={pm.approvedAt ?? organization.createdAt ?? new Date().toISOString()}>
              <p className="channel-text">{t('projects.orgChannel.hello')}</p>
            </Post>
          )}
          {listed.map((p) => (
            <StartedPost key={p.id} orgId={orgId} project={p} pmName={pmName} />
          ))}
        </ol>
        <ChannelComposer
          key={mention}
          initial={mention && pm ? `@${pmName} ` : undefined}
          label={t('projects.orgChannel.label', { channel: channelName(orgChannelSlug(organization.name)) })}
          placeholder={t('projects.orgChannel.placeholder', { name: pmName })}
          members={members}
          onSend={send}
          hint={
            <>
              {work.length > 1 && <Select label={t('projects.orgChannel.repo')} value={repo?.id ?? ''} onChange={setRepoId} options={work.map((r) => ({ value: r.id, label: r.name }))} />}
              <span>{t('projects.orgChannel.small')}</span>
              <LinkButton underline onClick={() => openNewWorkspace(repo?.id ?? null)}>
                {t('projects.orgChannel.newWorkspace')}
              </LinkButton>
            </>
          }
        />
      </div>
      <aside className="channel-side" aria-label={t('projects.orgChannel.side')}>
        <Card className="channel-side-card">
          <span className="employee-subheading">{t('projects.side.members', { count: members.length + 1 })}</span>
          <ul className="channel-side-list">
            <li className="channel-side-row">
              <HardHat colour="slate" size={16} />
              <span>{t('projects.you')}</span>
              <span className="employee-faint">{t('projects.side.youDo')}</span>
            </li>
            {members.map((m) => (
              <li key={m.id} className="channel-side-row">
                <HardHat colour={m.colour as HardHatColour} size={16} />
                <LinkButton onClick={() => openEmployees({ orgId, page: 'employee', id: m.id })}>{m.name}</LinkButton>
                <span className="employee-faint">{m.role}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="channel-side-card">
          <span className="employee-subheading">{t('projects.side.repos')}</span>
          <ul className="channel-side-list">
            {work.map((r) => (
              <li key={r.id} className="channel-side-row">
                <span>{r.name}</span>
              </li>
            ))}
            {work.length === 0 && <li className="employee-faint">{t('projects.side.noRepos')}</li>}
          </ul>
        </Card>
      </aside>
    </div>
  )
}

/** A project as the line that started it, with its channel under it. */
function StartedPost({ orgId, project, pmName }: { orgId: string; project: Project; pmName: string }) {
  const t = useT()
  const status = projectStatus(project, t, pmName)
  const live = useProjectLive(project)
  return (
    <Post who={t('projects.you')} at={project.createdAt}>
      <p className="channel-text">
        @{pmName} {project.requirement}
      </p>
      <CardButton className="channel-link" onClick={() => openEmployees({ orgId, page: 'project', id: project.id })}>
        <span className="employee-subheading">{projectChannel(project)}</span>
        <Status tone={status.tone} busy={isWorking(live)} label={status.label} />
        <span className="employee-faint">{status.line}</span>
      </CardButton>
    </Post>
  )
}
