// A project's channel (docs/ai-employees.md §15), read top to bottom as it happened: your request; the program manager
// planning, then each plan as a card (its parts, who owns each, what each writes and waits for, Foreman's checks, what
// changed since the plan before, the employees it proposes, each to approve); each part starting and what it said when
// it finished, with the file it wrote; the decisions you made and the notes you left; follow-ups and their answers. At
// the bottom, what it waits for you on: the plan (Approve once every owner is approved, Send back with a note, Stop), a
// part's result (Approve, Send back, Stop), a task that couldn't finish (Try again, Stop), the final check; and what
// its employees ask or hold (a question, a pull request). The message box: "@Name …" asks that employee a follow-up,
// anything else is a note that wakes nobody. Beside it: the parts with their states, the files, the workspace and the
// replans left. A plan, and the parts beside the channel, can be read as a table or list or drawn as a map (PlanMap.tsx).
// Pause holds it (what runs finishes); Stop cancels what is going (its files stay). Once closed, Archive
// takes it off the sidebar; an archived channel is read-only, with Restore and Delete. More renames or deletes it.
import { Archive, FileText, Pause, Play, Square } from 'lucide-react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { EmployeeSummary } from '../../../../shared/employees'
import type { PlainKey } from '../../../../shared/i18n'
import { formatDateTime, timeAgo } from '../../../../shared/i18n/time'
import { isArchived, MAX_REPLANS, mentionOf, ownerId, ownerName, planDiff, type PlanPart, type Project, type ProjectArtifact, type ProjectDecision, type ProjectPlan, type ProjectWait } from '../../../../shared/projects'
import { useT } from '../../i18n'
import { api, attempt, openEmployees, openMemory, selectWorkspace, showToast, useStore } from '../../store'
import { Button, Callout, Card, Disclosure, Field, flash, HardHat, LinkButton, Meter, Segmented, Spinner, Status, Tag, TextArea, type HardHatColour } from '../../ui'
import { reduceMotion } from '../../theme'
import { DecisionCard } from '../DecisionCard'
import { ChannelMenu, DeleteChannelsDialog } from './ChannelActions'
import { Markdown } from '../Markdown'
import { ChannelComposer, Post, SystemLine, type ChannelMember } from './Channel'
import { EmployeeDecision, useDecisionItems } from './EmployeeDecisions'
import { PART_STATUS, projectChannel, partTitle, PLAN_STATUS_KEY, projectStatus } from './projectWords'
import { partState, planBefore, planInEffect, PlanMap, useViewChoice } from './PlanMap'
import './employees.css'

function useRoster(orgId: string): EmployeeSummary[] | undefined {
  return useStore((s) => s.snapshot!.employees?.[orgId]?.employees)
}

const nameMap = (roster: readonly EmployeeSummary[] | undefined): Record<string, string> => Object.fromEntries((roster ?? []).map((e) => [e.id, e.name || e.id]))

/** `onChanged`: an archived project isn't in the snapshot, so its view reads it again after a change made here. */
export function ProjectPage({ orgId, project, onChanged }: { orgId: string; project: Project; onChanged?: () => void }) {
  const t = useT()
  const roster = useRoster(orgId)
  const names = nameMap(roster)
  const pm = roster?.find((e) => e.id === project.pmId)
  const pmName = pm?.name || t('projects.pmDefault')
  const status = projectStatus(project, t, pmName)
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === project.repoId))
  const [stopping, setStopping] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const open = project.phase !== 'closed'
  const archived = isArchived(project, Date.now())
  const gone = () => openEmployees({ orgId, page: 'channels' })
  const archive = (to: boolean) =>
    void attempt(async () => {
      await api.archiveProject(project.id, to)
      showToast(t(to ? 'projects.archive.done' : 'projects.archive.restored', { channel: projectChannel(project) }))
      onChanged?.()
    })
  // Who the box can name: everyone who worked on it, the program manager first.
  const worked = [...new Set([project.pmId, ...project.steps.map((s) => s.employeeId)])]
  const members: ChannelMember[] = worked.flatMap((id) => {
    const e = roster?.find((x) => x.id === id)
    return e ? [{ id: e.id, name: e.name || e.id, colour: e.colour, role: e.role }] : []
  })
  const send = async (text: string): Promise<boolean> => {
    const m = mentionOf(
      text,
      members.map((x) => x.name)
    )
    const to = m ? members.find((x) => x.name === m.name) : undefined
    let ok = false
    await attempt(async () => {
      if (to && m?.rest) {
        await api.askProjectFollowUp(project.id, to.id, m.rest)
        showToast(t('projects.followUp.sent', { name: to.name }))
      } else await api.noteProject(project.id, text)
      ok = true
    })
    return ok
  }
  return (
    <div className="channel-page">
      <div className="channel-main">
        <div className="team-page-head">
          <div className="project-head-who">
            <h2 className="employee-name">{projectChannel(project)}</h2>
            <span className="employee-faint">{[project.title, repo?.name, t('projects.meta.started', { when: formatDateTime(project.createdAt, t.locale) })].filter(Boolean).join(' · ')}</span>
          </div>
          <div className="employee-card-actions">
            <Status tone={status.tone} label={status.label} />
            {open &&
              (project.paused ? (
                <Button size="sm" icon={<Play size={13} />} onClick={() => void attempt(() => api.pauseProject(project.id, false))}>
                  {t('projects.action.resume')}
                </Button>
              ) : (
                <Button size="sm" icon={<Pause size={13} />} onClick={() => void attempt(() => api.pauseProject(project.id, true))}>
                  {t('projects.action.pause')}
                </Button>
              ))}
            {open && (
              <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={() => setStopping(true)}>
                {t('projects.action.stop')}
              </Button>
            )}
            {!open && !archived && (
              <Button size="sm" icon={<Archive size={13} />} onClick={() => archive(true)}>
                {t('projects.menu.archive')}
              </Button>
            )}
            <ChannelMenu project={project} look="button" onChanged={onChanged} onDeleted={gone} />
          </div>
        </div>
        {stopping && (
          <Callout
            tone="warn"
            role="alert"
            title={t('projects.stop.title')}
            actions={
              <>
                <Button size="sm" onClick={() => setStopping(false)}>
                  {t('projects.stop.keep')}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    void attempt(async () => {
                      await api.stopProject(project.id)
                      setStopping(false)
                      showToast(t('projects.stop.done', { title: project.title }))
                    })
                  }
                >
                  {t('projects.action.stop')}
                </Button>
              </>
            }
          >
            {t('projects.stop.body')}
          </Callout>
        )}
        {project.paused && open && <Callout tone="info">{t('projects.paused')}</Callout>}
        {archived && (
          <Callout
            tone="info"
            actions={
              <>
                <Button size="sm" onClick={() => archive(false)}>
                  {t('projects.menu.restore')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => setDeleting(true)}>
                  {t('projects.menu.delete')}
                </Button>
              </>
            }
          >
            {t('projects.archive.readOnly', { when: formatDateTime(project.archivedAt ?? project.closedAt ?? project.updatedAt, t.locale) })}
          </Callout>
        )}
        {deleting && <DeleteChannelsDialog projects={[project]} onClose={() => setDeleting(false)} onDeleted={gone} />}
        <Timeline orgId={orgId} project={project} names={names} roster={roster} pmName={pmName} />
        <Waiting orgId={orgId} project={project} names={names} roster={roster} />
        {!archived && (
          <ChannelComposer
            label={t('projects.composer.label', { channel: projectChannel(project) })}
            placeholder={t('projects.composer.placeholder')}
            members={members}
            onSend={send}
            hint={t('projects.composer.hint')}
          />
        )}
      </div>
      <SidePanel orgId={orgId} project={project} names={names} roster={roster} />
    </div>
  )
}

interface Entry {
  at: string
  key: string
  node: ReactNode
}

/** Where a step's line is in the channel, so the side column's map can take the channel there. */
const stepDomId = (projectId: string, taskId: string, end: 'start' | 'end') => `project-${projectId}-${end}-${taskId}`
const planDomId = (projectId: string, version: number) => `project-${projectId}-plan-${version}`

/** Takes the channel to a part's newest post (or the plan, before the part has started) and flashes it. */
function jumpToPart(project: Project, partId: string): void {
  const step = project.steps
    .filter((s) => s.partId === partId)
    .sort((a, b) => (a.endedAt ?? a.startedAt).localeCompare(b.endedAt ?? b.startedAt))
    .at(-1)
  const plan = project.plan ?? project.plans.at(-1)
  const id = step ? stepDomId(project.id, step.taskId, step.state !== 'running' && step.endedAt ? 'end' : 'start') : undefined
  const el = (id ? document.getElementById(id) : null) ?? (plan ? document.getElementById(planDomId(project.id, plan.version)) : null)
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' })
  flash(el, { duration: 1800 })
}

/** Everything that happened, in order. */
function Timeline({ orgId, project, names, roster, pmName }: { orgId: string; project: Project; names: Record<string, string>; roster?: EmployeeSummary[]; pmName: string }) {
  const t = useT()
  const member = (id: string) => roster?.find((e) => e.id === id)
  const who = (id: string) => member(id)?.name || names[id] || id
  const entries: Entry[] = [
    {
      at: project.createdAt,
      key: 'request',
      node: (
        <Post who={t('projects.you')} at={project.createdAt}>
          <p className="channel-text">
            @{pmName} {project.requirement}
          </p>
          {project.fromWorkspaceId && <span className="employee-faint">{t('projects.fromWorkspace')}</span>}
        </Post>
      )
    }
  ]
  for (const step of project.steps) {
    const e = member(step.employeeId)
    const part = step.partId ? partTitle(project, step.partId) : ''
    const round = step.round > 1 ? ` · ${t('projects.round', { round: step.round })}` : ''
    if (step.kind === 'follow-up') {
      entries.push({
        at: step.startedAt,
        key: `ask:${step.taskId}`,
        node: (
          <Post who={t('projects.you')} at={step.startedAt}>
            <p className="channel-text">
              @{who(step.employeeId)} {step.question}
            </p>
          </Post>
        )
      })
    } else {
      const started =
        step.kind === 'plan'
          ? t(project.plans.some((p) => p.taskId !== step.taskId && Date.parse(p.at) < Date.parse(step.startedAt)) ? 'projects.log.replanning' : 'projects.log.planning', { name: who(step.employeeId) })
          : step.kind === 'accept'
            ? t('projects.log.accepting', { name: who(step.employeeId) })
            : t('projects.log.partStarted', { name: who(step.employeeId), part })
      entries.push({ at: step.startedAt, key: `start:${step.taskId}`, node: <SystemLine id={stepDomId(project.id, step.taskId, 'start')}>{`${started}${round}`}</SystemLine> })
    }
    if (step.state !== 'running' && step.endedAt) {
      const artifact = Object.values(project.artifacts).find((a) => a.taskId === step.taskId)
      const plan = step.kind === 'plan' ? project.plans.find((p) => p.taskId === step.taskId) : undefined
      entries.push({
        at: step.endedAt,
        key: `end:${step.taskId}`,
        node: (
          <Post id={stepDomId(project.id, step.taskId, 'end')} who={who(step.employeeId)} colour={e?.colour} role={e?.role} at={step.endedAt}>
            {step.state === 'stuck' && <Status tone="error" label={t('projects.part.stuck')} />}
            {step.summary && <Markdown text={step.summary} />}
            {!step.summary && step.reason && <p className="channel-text">{step.reason}</p>}
            {step.decision && <Tag>{t(step.decision === 'accept' ? 'projects.decision.accept' : 'projects.decision.replan')}</Tag>}
            {plan && <PlanCard orgId={orgId} project={project} plan={plan} names={names} roster={roster} />}
            {artifact && !plan && <ArtifactCard orgId={orgId} artifact={artifact} who={who(artifact.employeeId)} />}
          </Post>
        )
      })
    }
  }
  for (const [i, d] of project.decisions.entries()) {
    const part = d.partId ? partTitle(project, d.partId) : ''
    const what = d.waitKind === 'gate' && d.decision !== 'stop' ? t(d.decision === 'approve' ? 'projects.log.partApproved' : 'projects.log.partSentBack', { part }) : t(DECISION_LOG[d.waitKind][d.decision] ?? 'projects.log.decided')
    entries.push({
      at: d.at,
      key: `decision:${i}`,
      node: (
        <Post who={t('projects.you')} at={d.at}>
          <p className="channel-text">{what}</p>
          {d.note && <p className="channel-quote">“{d.note}”</p>}
        </Post>
      )
    })
  }
  for (const [i, n] of project.notes.entries()) {
    entries.push({
      at: n.at,
      key: `note:${i}`,
      node: (
        <Post who={t('projects.you')} at={n.at}>
          <p className="channel-text">{n.text}</p>
        </Post>
      )
    })
  }
  if (project.phase === 'closed' && project.closedAt)
    entries.push({ at: project.closedAt, key: 'closed', node: <SystemLine>{t(project.outcome === 'done' ? 'projects.log.closedDone' : 'projects.log.closedStopped', { when: formatDateTime(project.closedAt, t.locale) })}</SystemLine> })
  entries.sort((a, b) => a.at.localeCompare(b.at))
  return (
    <ol className="channel-timeline" aria-label={t('projects.timeline', { channel: projectChannel(project) })}>
      {entries.map((e) => (
        <Fragment key={e.key}>{e.node}</Fragment>
      ))}
    </ol>
  )
}

const DECISION_LOG: Record<ProjectWait['kind'], Partial<Record<ProjectDecision, PlainKey>>> = {
  plan: { approve: 'projects.log.planApproved', 'send-back': 'projects.log.planSentBack', stop: 'projects.log.stopped' },
  gate: { stop: 'projects.log.stopped' },
  stuck: { retry: 'projects.log.retried', stop: 'projects.log.stopped' },
  final: { approve: 'projects.log.finalApproved', 'send-back': 'projects.log.finalSentBack', stop: 'projects.log.stopped' }
}

/** A file a part wrote, its newest version: its name and who wrote it, opening to its words. */
function ArtifactCard({ orgId, artifact, who }: { orgId: string; artifact: ProjectArtifact; who: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <Card className="channel-artifact">
      <Disclosure
        quiet
        open={open}
        onOpenChange={setOpen}
        label={
          <span className="channel-artifact-head">
            <FileText size={13} aria-hidden /> <span>{artifact.file}</span>
            <span className="employee-faint">{t('projects.artifact.meta', { version: artifact.version, name: who, ago: timeAgo(artifact.at, t.locale) })}</span>
          </span>
        }
      >
        {open && <ArtifactText orgId={orgId} artifact={artifact} />}
      </Disclosure>
    </Card>
  )
}

function ArtifactText({ orgId, artifact }: { orgId: string; artifact: ProjectArtifact }) {
  const t = useT()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api.memoryReadFile(orgId, artifact.path).then(
      (file) => live && setText(file.text ?? ''),
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err))
    )
    return () => {
      live = false
    }
  }, [orgId, artifact.path, artifact.commit])
  if (error)
    return (
      <Callout tone="error" role="alert">
        {error}
      </Callout>
    )
  if (text === null)
    return (
      <div className="employees-loading" role="status">
        <Spinner size={13} /> <span>{t('common.loading')}</span>
      </div>
    )
  return (
    <div className="project-artifact">
      <span className="employee-faint mono">{[artifact.path, artifact.commit?.slice(0, 12)].filter(Boolean).join(' @ ')}</span>
      <Markdown text={text} />
      <div className="employee-card-actions">
        <LinkButton onClick={() => openMemory(orgId)}>{t('projects.openMemory')}</LinkButton>
      </div>
    </div>
  )
}

/** A plan as the program manager gave it, checked by Foreman: its parts as a table, or drawn as a map. */
function PlanCard({ orgId, project, plan, names, roster }: { orgId: string; project: Project; plan: ProjectPlan; names: Record<string, string>; roster?: EmployeeSummary[] }) {
  const t = useT()
  const before = planBefore(project, plan)
  const diff = before ? planDiff(before, plan) : undefined
  const owner = (part: PlanPart) => ownerName(plan, part.owner, names)
  const colour = (part: PlanPart) => roster?.find((e) => e.id === ownerId(plan, part.owner))?.colour ?? 'slate'
  const [view, setView] = useViewChoice('foreman.projects.planView', ['table', 'map'] as const, 'table')
  const [picked, setPicked] = useState<string | null>(null)
  // Once the plan is in effect, the table says where each part is: the outline the map draws.
  const live = planInEffect(project, plan)
  return (
    <Card as="section" id={planDomId(project.id, plan.version)} className="channel-plan" aria-label={t('projects.plan.label', { version: plan.version })}>
      <div className="channel-plan-top">
        <div className="channel-plan-head">
          <span className="employee-subheading">{t('projects.plan.title', { version: plan.version })}</span>
          <Tag>{t(plan.size === 'small' ? 'projects.size.small' : 'projects.size.large')}</Tag>
          <Tag>{t(PLAN_STATUS_KEY[plan.status])}</Tag>
        </div>
        <Segmented
          small
          label={t('projects.view.label', { version: plan.version })}
          value={view}
          onChange={setView}
          options={[
            { value: 'table', label: t('projects.view.table') },
            { value: 'map', label: t('projects.view.map') }
          ]}
        />
      </div>
      <p className="channel-text">{plan.summary}</p>
      {view === 'map' ? (
        <PlanMap orgId={orgId} project={project} plan={plan} form="wide" names={names} roster={roster} label={t('projects.map.label', { version: plan.version })} selected={picked} onSelect={setPicked} />
      ) : (
        <table className="channel-plan-parts">
          <thead>
            <tr>
              <th scope="col">{t('projects.plan.col.part')}</th>
              <th scope="col">{t('projects.plan.col.owner')}</th>
              <th scope="col">{t('projects.plan.col.writes')}</th>
              <th scope="col">{t('projects.plan.col.after')}</th>
              <th scope="col">{t('projects.plan.col.check')}</th>
              {live && <th scope="col">{t('projects.plan.col.state')}</th>}
            </tr>
          </thead>
          <tbody>
            {plan.parts.map((p) => {
              const state = live ? partState(project, plan, p.id) : undefined
              return (
                <tr key={p.id}>
                  <td>
                    {p.title}
                    {diff?.added.includes(p.id) && <Tag>{t('projects.plan.added')}</Tag>}
                    {diff?.changed.includes(p.id) && <Tag>{t('projects.plan.changed')}</Tag>}
                  </td>
                  <td>
                    <span className="channel-owner">
                      <HardHat colour={colour(p) as HardHatColour} size={14} /> {owner(p)}
                    </span>
                  </td>
                  <td className="mono">{p.writes}</td>
                  <td>{p.dependsOn.map((d) => partTitle({ plan, plans: [] }, d)).join(', ') || '—'}</td>
                  <td>{p.gate ? t('projects.plan.youCheck') : '—'}</td>
                  {live && <td>{state && <Status tone={PART_STATUS[state.state].tone} label={state.round > 1 ? `${t(PART_STATUS[state.state].label)} · ${t('projects.round', { round: state.round })}` : t(PART_STATUS[state.state].label)} />}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {view === 'table' && diff && diff.removed.length > 0 && <p className="employee-faint">{t('projects.plan.removed', { parts: diff.removed.map((id) => partTitle({ plan: before, plans: [] }, id)).join(', ') })}</p>}
      <p className="employee-faint">{t('projects.plan.checked', { count: plan.parts.length })}</p>
      {plan.proposed.length > 0 && <Proposed orgId={orgId} plan={plan} roster={roster} />}
      <Disclosure quiet label={t('projects.plan.briefs')}>
        <dl className="channel-briefs">
          {plan.parts.map((p) => (
            <div key={p.id}>
              <dt className="employee-subheading">{p.title}</dt>
              <dd>{p.brief}</dd>
            </div>
          ))}
        </dl>
      </Disclosure>
    </Card>
  )
}

/** The employees a plan proposes: each made as a draft, each approved on its own page. */
function Proposed({ orgId, plan, roster }: { orgId: string; plan: ProjectPlan; roster?: EmployeeSummary[] }) {
  const t = useT()
  return (
    <div className="channel-proposed">
      <span className="employee-subheading">{t('projects.plan.proposed', { count: plan.proposed.length })}</span>
      <ul className="channel-side-list">
        {plan.proposed.map((p) => {
          const id = plan.proposedIds[p.key]
          const e = id ? roster?.find((x) => x.id === id) : undefined
          const approved = e && e.state !== 'draft' && e.state !== 'retired'
          return (
            <li key={p.key} className="channel-proposed-row">
              <HardHat colour={(e?.colour ?? 'slate') as HardHatColour} size={20} />
              <span className="project-head-who">
                <span>
                  {p.name} <span className="employee-faint">{p.role}</span>
                </span>
                <span className="employee-faint">{p.description || p.responsibilities.join(' · ')}</span>
              </span>
              {approved ? (
                <Status tone="ok" label={t('projects.plan.approvedEmployee')} />
              ) : e ? (
                <Button size="sm" onClick={() => openEmployees({ orgId, page: 'employee', id: e.id })}>
                  {t('projects.plan.review', { name: p.name })}
                </Button>
              ) : (
                <Status tone="off" label={t('projects.plan.notMade')} />
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** What the project waits for you on, then what its employees ask or hold. */
function Waiting({ orgId, project, names, roster }: { orgId: string; project: Project; names: Record<string, string>; roster?: EmployeeSummary[] }) {
  const t = useT()
  const items = useDecisionItems(orgId)
  const tasks = new Set(project.steps.map((s) => s.taskId))
  const theirs = items.filter((i) => (i.kind === 'question' || i.kind === 'task' ? tasks.has(i.task.id) : i.kind === 'action' ? tasks.has(i.action.taskId) : false))
  const waits = project.phase === 'closed' ? [] : project.waits
  if (!waits.length && !theirs.length) return null
  return (
    <section className="channel-waiting" aria-label={t('projects.waiting.label')}>
      <span className="employee-subheading">{t('projects.waiting.heading', { count: waits.length + theirs.length })}</span>
      {waits.map((w) => (
        <WaitCard key={w.id} orgId={orgId} project={project} wait={w} names={names} roster={roster} />
      ))}
      {theirs.map((item) => (
        <EmployeeDecision key={item.id} orgId={orgId} item={item} place={{ form: 'card' }} />
      ))}
    </section>
  )
}

/** One thing the project waits on, as a decision card with a note for a send-back or a retry. */
function WaitCard({ orgId, project, wait, names, roster }: { orgId: string; project: Project; wait: ProjectWait; names: Record<string, string>; roster?: EmployeeSummary[] }) {
  const t = useT()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const decide = (decision: ProjectDecision) => {
    if (busy) return
    setBusy(true)
    void attempt(async () => {
      await api.decideProject(project.id, wait.id, decision, note.trim() || undefined)
      setNote('')
    }).finally(() => setBusy(false))
  }
  const you = (
    <span className="channel-owner">
      <HardHat colour="slate" size={16} /> {t('projects.you')}
    </span>
  )
  const age = timeAgo(wait.since, t.locale)
  const stop = { label: t('projects.action.stop'), disabled: busy, onAct: () => decide('stop') }
  const noteField = (label: string, hint?: string) => (
    <Field label={label} description={hint}>
      {(control) => <TextArea {...control} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
    </Field>
  )
  if (wait.kind === 'stuck') {
    const part = wait.partId ? partTitle(project, wait.partId) : ''
    return (
      <DecisionCard
        who={you}
        kind={t('projects.wait.stuck')}
        age={age}
        subject={part ? t('projects.stuck.subjectPart', { part }) : t('projects.stuck.subject')}
        consequence={t('projects.stuck.consequence')}
        decline={stop}
        main={{ label: t('projects.stuck.retry'), disabled: busy, onAct: () => decide('retry') }}
      >
        {wait.reason && <p className="channel-quote">{wait.reason}</p>}
        {noteField(t('projects.stuck.noteLabel'))}
      </DecisionCard>
    )
  }
  if (wait.kind === 'plan') {
    const plan = [...project.plans].reverse().find((p) => p.status === 'waiting')
    // Every owner approved: a proposed one is approved on its own page first.
    const unapproved = plan
      ? [...new Set(plan.parts.map((p) => p.owner))].flatMap((o) => {
          const id = ownerId(plan, o)
          const e = id ? roster?.find((x) => x.id === id) : undefined
          return e && e.state !== 'draft' && e.state !== 'retired' ? [] : [ownerName(plan, o, names)]
        })
      : []
    return (
      <DecisionCard
        who={you}
        kind={t('projects.wait.plan')}
        age={age}
        subject={plan ? t('projects.planGate.subject', { version: plan.version, count: plan.parts.length }) : t('projects.wait.plan')}
        consequence={unapproved.length ? t('projects.planGate.approveFirst', { names: unapproved.join(', ') }) : t('projects.planGate.consequence')}
        decline={stop}
        alternate={{ label: t('projects.action.sendBack'), disabled: busy || !note.trim(), title: !note.trim() ? t('projects.noteFirst') : undefined, onAct: () => decide('send-back') }}
        main={{ label: t('projects.planGate.approve'), disabled: busy || !plan || unapproved.length > 0, title: unapproved.length ? t('projects.planGate.approveFirst', { names: unapproved.join(', ') }) : undefined, onAct: () => decide('approve') }}
      >
        {noteField(t('projects.planGate.noteLabel'))}
      </DecisionCard>
    )
  }
  if (wait.kind === 'gate') {
    const part = partTitle(project, wait.partId)
    const artifact = Object.values(project.artifacts).find((a) => a.partId === wait.partId)
    return (
      <DecisionCard
        who={you}
        kind={t('projects.wait.gate')}
        age={age}
        subject={t('projects.gate.subject', { part })}
        consequence={t('projects.gate.consequence')}
        decline={stop}
        alternate={{ label: t('projects.action.sendBack'), disabled: busy || !note.trim(), title: !note.trim() ? t('projects.noteFirst') : undefined, onAct: () => decide('send-back') }}
        main={{ label: t('projects.gate.approve'), disabled: busy, onAct: () => decide('approve') }}
      >
        {artifact && <ArtifactCard orgId={orgId} artifact={artifact} who={names[artifact.employeeId] ?? artifact.employeeId} />}
        {noteField(t('projects.gate.noteLabel'))}
      </DecisionCard>
    )
  }
  const acceptance = Object.values(project.artifacts).find((a) => a.file === 'acceptance.md')
  const left = Math.max(0, MAX_REPLANS - project.replans)
  return (
    <DecisionCard
      who={you}
      kind={t('projects.wait.final')}
      age={age}
      subject={t('projects.final.subject', { title: project.title })}
      consequence={t('projects.final.consequence')}
      decline={stop}
      alternate={{ label: t('projects.action.sendBack'), disabled: busy || !note.trim() || left === 0, title: left === 0 ? t('projects.final.noReplans') : !note.trim() ? t('projects.noteFirst') : undefined, onAct: () => decide('send-back') }}
      main={{ label: t('projects.final.approve'), disabled: busy, onAct: () => decide('approve') }}
    >
      {wait.reason && <p className="channel-quote">{wait.reason}</p>}
      {acceptance && <ArtifactCard orgId={orgId} artifact={acceptance} who={names[acceptance.employeeId] ?? acceptance.employeeId} />}
      {noteField(t('projects.final.noteLabel'), t('projects.replansLeft', { count: left }))}
    </DecisionCard>
  )
}

/** Beside the channel: the parts and their states (a list, or a map that takes the channel to a part), the files, the workspace, the replans left. */
function SidePanel({ orgId, project, names, roster }: { orgId: string; project: Project; names: Record<string, string>; roster?: EmployeeSummary[] }) {
  const t = useT()
  const plan = project.plan ?? project.plans.at(-1)
  const artifacts = Object.values(project.artifacts).sort((a, b) => a.at.localeCompare(b.at))
  const alive = useStore((s) => (project.workspaceId ? s.snapshot!.workspaces.some((w) => w.id === project.workspaceId) : false))
  const [view, setView] = useViewChoice('foreman.projects.partsView', ['list', 'map'] as const, 'list')
  const [picked, setPicked] = useState<string | null>(null)
  const pick = (id: string | null) => {
    setPicked(id)
    if (id) jumpToPart(project, id)
  }
  return (
    <aside className="channel-side" aria-label={t('projects.side.label', { channel: projectChannel(project) })}>
      <Card className="channel-side-card">
        <div className="channel-side-top">
          <span className="employee-subheading">{t('projects.side.parts', { count: plan?.parts.length ?? 0 })}</span>
          {plan && (
            <Segmented
              small
              label={t('projects.side.view')}
              value={view}
              onChange={setView}
              options={[
                { value: 'list', label: t('projects.side.list') },
                { value: 'map', label: t('projects.view.map') }
              ]}
            />
          )}
        </div>
        {plan && view === 'map' ? (
          <PlanMap orgId={orgId} project={project} plan={plan} form="compact" names={names} roster={roster} label={t('projects.map.sideLabel', { channel: projectChannel(project) })} selected={picked} onSelect={pick} />
        ) : plan ? (
          <ul className="channel-side-list">
            {plan.parts.map((p) => {
              const s = project.plan ? (project.parts[p.id] ?? { state: 'pending' as const, round: 0 }) : { state: 'pending' as const, round: 0 }
              const st = PART_STATUS[s.state]
              const id = ownerId(plan, p.owner)
              const e = id ? roster?.find((x) => x.id === id) : undefined
              return (
                <li key={p.id} className="channel-side-part">
                  <HardHat colour={(e?.colour ?? 'slate') as HardHatColour} size={16} />
                  <span className="project-head-who">
                    <span>{p.title}</span>
                    <span className="employee-faint">{ownerName(plan, p.owner, names)}</span>
                  </span>
                  <Status tone={st.tone} label={s.round > 1 ? `${t(st.label)} · ${t('projects.round', { round: s.round })}` : t(st.label)} />
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="employee-faint">{t('projects.side.noPlan')}</p>
        )}
      </Card>
      <Card className="channel-side-card">
        <span className="employee-subheading">{t('projects.side.files', { count: artifacts.length })}</span>
        {artifacts.length ? (
          <ul className="channel-side-list">
            {artifacts.map((a) => (
              <li key={a.file} className="channel-side-row">
                <FileText size={13} aria-hidden />
                <span className="mono">{a.file}</span>
                <span className="employee-faint">v{a.version}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="employee-faint">{t('projects.side.noFiles')}</p>
        )}
        {artifacts.length > 0 && <LinkButton onClick={() => openMemory(orgId)}>{t('projects.openMemory')}</LinkButton>}
      </Card>
      <Card className="channel-side-card">
        <span className="employee-subheading">{t('projects.side.workspace')}</span>
        {project.workspaceId && alive ? (
          <Button size="sm" onClick={() => selectWorkspace(project.workspaceId!)}>
            {t('projects.openWorkspace')}
          </Button>
        ) : (
          <p className="employee-faint">{t(project.workspaceId ? 'projects.side.workspaceGone' : 'projects.side.noWorkspace')}</p>
        )}
        <Meter label={t('projects.side.replans')} value={project.replans} max={MAX_REPLANS} valueText={t('projects.side.replansUsed', { used: project.replans, max: MAX_REPLANS })} tone={project.replans >= MAX_REPLANS ? 'warn' : 'ok'} />
        <span className="employee-faint">{t('projects.side.replansUsed', { used: project.replans, max: MAX_REPLANS })}</span>
      </Card>
    </aside>
  )
}
