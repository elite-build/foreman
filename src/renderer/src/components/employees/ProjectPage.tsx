// A project's channel (docs/ai-employees.md §15), read top to bottom as it happened: your request; the program manager's
// questions and your answers; her planning, then each plan as a card (drawn as its workflow, what she understood, done
// when, out of scope and what she assumed, its parts, who owns each, what each writes and waits for, Foreman's checks, what
// changed since the plan before, the employees it proposes, each to approve); each part starting and what it said when
// it finished, with the file it wrote and the HTML mocks it drew (each opens in the browser), and a button for any
// other page its task named (a mock elsewhere in memory); the decisions you made (an approval at a gate with Undo
// approval while what it started still runs) and the notes you left; follow-ups and their answers; each push and pull
// request its runs made (the publisher's own, from its shell, too), with a link to open; and last, who is at
// work on it now, for how long, with a link to watch (ProjectLive.tsx). Under it, what it waits for you on: her questions
// (Send answers, Plan with what you have with the answers given, Stop), the plan (Approve once every owner is approved,
// Send back with a note, Stop), a part's result (Approve, with an optional pick among its mocks; with a note written,
// Send back is the main act and Approve with note goes beside it), a task that couldn't finish (Try again, Stop), the
// final check; a note holds Approve on the plan and the final check, where it would reach nobody. What you type there is
// kept while you look elsewhere (projectDrafts.ts); Stop on a card asks first, and Esc never stops. Then what its
// employees ask or hold (a question, a pull request). The message box: "@Name …" asks that employee (anyone who worked on
// it or owns a part): into their running work when it takes words mid-turn, else a follow-up (after that work, while it
// runs); anything else is for the program manager, who reads it and answers in the channel, or replans. Beside it: the parts with their states (and
// what a part that changes the repository waits for while another does), the
// files, the workspace (where its work is once archived, with Restore) and the replans left. Pause holds it (what runs
// finishes); Stop cancels what is going (its files stay).
// Once closed, Archive takes it off the sidebar; an archived channel is read-only, with Restore and Delete. More renames
// or deletes it.
import { Archive, FileText, Pause, Play, Square } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { EmployeeSummary } from '../../../../shared/employees'
import type { PlainKey } from '../../../../shared/i18n'
import { formatDateTime, formatNumber, timeAgo } from '../../../../shared/i18n/time'
import { joinWorkspace } from '../../../../shared/openIn'
import type { ArchivedWork, Workspace } from '../../../../shared/types'
import { projectNeeds } from '../../../../shared/needsYou'
import { gateNoteTo, isArchived, lastApproval, MAX_ANSWER, MAX_NOTE, MAX_QUESTION_ROUNDS, MAX_REPLANS, mentionOf, ownerId, ownerName, planDiff, planSeen, planStages, roundSeen, waitingOnRepo, type PlanPart, type Project, type ProjectArtifact, type ProjectDecideOptions, type ProjectDecision, type ProjectDecisionRecord, type ProjectLive, type ProjectPlan, type ProjectStep, type ProjectWait, type QuestionRound } from '../../../../shared/projects'
import { useT } from '../../i18n'
import { api, attempt, openArchivedChats, openEmployees, openMemory, restoreArchived, selectWorkspace, showToast, useStore } from '../../store'
import { Button, Callout, Card, ChipButton, Disclosure, Field, flash, HardHat, LinkButton, Meter, RadioList, Segmented, Spinner, Status, Tag, TextArea, type HardHatColour } from '../../ui'
import { reduceMotion } from '../../theme'
import { DecisionCard, type DecisionAct } from '../DecisionCard'
import { OpenFileChip } from '../OpenFileChip'
import { ChannelMenu, DeleteChannelsDialog } from './ChannelActions'
import { Markdown } from '../Markdown'
import { ChannelComposer, Post, SystemLine, type ChannelMember } from './Channel'
import { LiveLines, LiveTag, useProjectLive } from './ProjectLive'
import { EmployeeDecision, useDecisionItems } from './EmployeeDecisions'
import { ACTION_STATE_TONE } from './HeldActions'
import { ACTION_STATE_LABEL } from './words'
import { PageLinks } from './PageLinks'
import { PlanWorkflow } from './PlanWorkflow'
import { partState, planInEffect, PlanMap, useViewChoice } from './PlanMap'
import { clearWaitDrafts, keepWaitDrafts, useWaitDraft } from './projectDrafts'
import { PART_STATUS, partLook, projectChannel, partTitle, PLAN_STATUS_KEY, projectStatus } from './projectWords'
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
  const work = useStore((s) => s.snapshot!.employeeWork?.[orgId])
  const status = projectStatus(project, t, pmName, projectNeeds(project, work).asks)
  const live = useProjectLive(project)
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === project.repoId))
  // Stop asks first, where it was pressed: in the header, or on a card of what the project waits for.
  const [stopping, setStopping] = useState<'head' | 'card' | null>(null)
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
  // Who the box can name: the program manager first, everyone who worked on it, and every owner of the plan (a proposed
  // one once approved), so a planned owner can be asked before their part starts.
  const plan = project.plan ?? project.plans.at(-1)
  const owners = plan ? plan.parts.flatMap((p) => ownerId(plan, p.owner) ?? []) : []
  const worked = new Set(project.steps.map((s) => s.employeeId))
  const members: ChannelMember[] = [...new Set([project.pmId, ...worked, ...owners])].flatMap((id) => {
    const e = roster?.find((x) => x.id === id)
    const named = e && (worked.has(id) || id === project.pmId || (e.state !== 'draft' && e.state !== 'retired'))
    return e && named ? [{ id: e.id, name: e.name || e.id, colour: e.colour, role: e.role }] : []
  })
  const send = async (text: string): Promise<boolean> => {
    const m = mentionOf(
      text,
      members.map((x) => x.name)
    )
    const to = m ? members.find((x) => x.name === m.name) : undefined
    // A name and nothing after it asks nothing: say so, and keep it in the box.
    if (to && !m?.rest) {
      showToast(t('projects.composer.askWhat', { name: to.name }))
      return false
    }
    let ok = false
    await attempt(async () => {
      if (to && m?.rest) {
        const task = await api.askProjectFollowUp(project.id, to.id, m.rest)
        // Into their running work; a follow-up held until it ends; or a follow-up now.
        const how = task.project?.kind !== 'follow-up' ? 'projects.followUp.steered' : task.project.after && task.state === 'open' ? 'projects.followUp.held' : 'projects.followUp.sent'
        showToast(t(how, { name: to.name }))
      } else {
        await api.noteProject(project.id, text)
        if (open) showToast(t('projects.message.sent', { name: pmName }))
      }
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
            {/* Its stage says where it is; this says whether anyone is at it now. */}
            {open && <LiveTag live={live} busyStage={status.tone === 'info'} who={(id) => names[id] ?? id} />}
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
              <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={() => setStopping('head')}>
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
        {stopping === 'head' && <StopConfirm project={project} onDone={() => setStopping(null)} />}
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
        <Timeline orgId={orgId} project={project} names={names} roster={roster} pmName={pmName} live={live} />
        <Waiting orgId={orgId} project={project} names={names} roster={roster} pmName={pmName} stopping={stopping === 'card'} onStop={() => setStopping('card')} onStopDone={() => setStopping(null)} />
        {!archived && (
          <ChannelComposer
            label={t('projects.composer.label', { channel: projectChannel(project) })}
            placeholder={open ? t('projects.composer.placeholderPm', { name: pmName }) : t('projects.composer.placeholder')}
            members={members}
            onSend={send}
            hint={open ? t('projects.composer.hintPm', { name: pmName }) : t('projects.composer.hint')}
          />
        )}
      </div>
      <SidePanel orgId={orgId} project={project} names={names} roster={roster} live={live} />
    </div>
  )
}

/** Stop, once confirmed: what is running is canceled and the project closes. */
function StopConfirm({ project, onDone }: { project: Project; onDone: () => void }) {
  const t = useT()
  return (
    <Callout
      tone="warn"
      role="alert"
      title={t('projects.stop.title')}
      actions={
        <>
          <Button size="sm" onClick={onDone}>
            {t('projects.stop.keep')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              void attempt(async () => {
                await api.stopProject(project.id)
                onDone()
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
function Timeline({ orgId, project, names, roster, pmName, live }: { orgId: string; project: Project; names: Record<string, string>; roster?: EmployeeSummary[]; pmName: string; live: readonly ProjectLive[] }) {
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
            : step.kind === 'message'
              ? t('projects.log.message', { name: who(step.employeeId) })
              : t('projects.log.partStarted', { name: who(step.employeeId), part })
      entries.push({ at: step.startedAt, key: `start:${step.taskId}`, node: <SystemLine id={stepDomId(project.id, step.taskId, 'start')}>{`${started}${round}`}</SystemLine> })
    }
    if (step.state !== 'running' && step.endedAt) {
      const artifact = Object.values(project.artifacts).find((a) => a.taskId === step.taskId)
      // A plan comes from her planning, or from her reading the channel (a replan).
      const plan = step.kind === 'plan' || step.kind === 'message' ? project.plans.find((p) => p.taskId === step.taskId) : undefined
      const asks = step.kind === 'plan' && !plan ? project.asks?.find((r) => r.taskId === step.taskId) : undefined
      entries.push({
        at: step.endedAt,
        key: `end:${step.taskId}`,
        node: (
          <Post id={stepDomId(project.id, step.taskId, 'end')} who={who(step.employeeId)} colour={e?.colour} role={e?.role} at={step.endedAt}>
            {step.state === 'stuck' && <StepEnd step={step} />}
            {step.changedRepo && <Callout tone="warn">{t(step.changedRepo === 'shared' ? 'projects.step.changedRepoShared' : 'projects.step.changedRepo')}</Callout>}
            {step.summary && <StepSummary step={step} />}
            {!step.summary && step.reason && <p className="channel-text">{step.reason}</p>}
            {step.decision && <Tag>{t(STEP_DECISION[step.decision] ?? 'projects.decision.replan')}</Tag>}
            {asks && <QuestionsList round={asks} />}
            {plan && <PlanCard orgId={orgId} project={project} plan={plan} names={names} roster={roster} pmName={pmName} />}
            {artifact && !plan && <ArtifactCard orgId={orgId} artifact={artifact} who={who(artifact.employeeId)} approved={artifact.partId ? lastApproval(project.decisions, artifact.partId) : undefined} />}
            {/* Pages elsewhere in memory; the mocks in the part's own folder are under its file. */}
            <PageLinks orgId={orgId} files={step.files} except={artifact && !plan ? artifact.mocks : undefined} />
          </Post>
        )
      })
    }
  }
  for (const [i, d] of project.decisions.entries()) {
    const part = d.partId ? partTitle(project, d.partId) : ''
    const file = d.pick ? d.pick.slice(d.pick.lastIndexOf('/') + 1) : ''
    const what =
      d.waitKind === 'gate' && d.decision !== 'stop'
        ? t(d.decision === 'undo' ? 'projects.log.partUndone' : d.decision !== 'approve' ? 'projects.log.partSentBack' : file ? 'projects.log.partApprovedPick' : 'projects.log.partApproved', { part, file })
        : t(DECISION_LOG[d.waitKind][d.decision] ?? 'projects.log.decided')
    entries.push({
      at: d.at,
      key: `decision:${i}`,
      node: (
        <Post who={t('projects.you')} at={d.at}>
          <p className="channel-text">{what}</p>
          {d.note && <p className="channel-quote">“{d.note}”</p>}
          {d.decision === 'approve' && d.waitKind === 'gate' && <UndoApproval project={project} decision={d} part={part} />}
        </Post>
      )
    })
  }
  // Your answers to her questions; and that she should plan with what she has, said by Foreman, not put in your mouth.
  for (const r of project.asks ?? []) {
    if (!r.answeredAt) continue
    const given = r.questions.flatMap((q, i) => (r.answers?.[i]?.trim() ? [{ q, a: r.answers[i], i }] : []))
    if (given.length)
      entries.push({
        at: r.answeredAt,
        key: `answers:${r.round}`,
        node: (
          <Post who={t('projects.you')} at={r.answeredAt}>
            <dl className="channel-answers">
              {given.map(({ q, a, i }) => (
                <div key={i}>
                  <dt className="employee-faint">{q.question}</dt>
                  <dd>{a}</dd>
                </div>
              ))}
            </dl>
          </Post>
        )
      })
    if (r.skipped) entries.push({ at: r.answeredAt, key: `skipped:${r.round}`, node: <SystemLine>{t('projects.questions.skippedLog', { name: pmName, done: given.length, count: r.questions.length })}</SystemLine> })
  }
  // What you wrote in the channel: for her (no name), or put into someone's running work ("You → Ravi").
  for (const [i, n] of project.notes.entries()) {
    entries.push({
      at: n.at,
      key: `note:${i}`,
      node: (
        <Post who={n.to ? t('projects.note.to', { name: who(n.to) }) : t('projects.you')} at={n.at}>
          <p className="channel-text">{n.text}</p>
          {n.to && <span className="employee-faint">{t('projects.note.steered', { name: who(n.to) })}</span>}
        </Post>
      )
    })
  }
  // What its runs pushed or opened: through Foreman, or from the publishing part's shell (found when it ended).
  for (const [i, p] of (project.published ?? []).entries()) {
    const e = member(p.employeeId)
    entries.push({
      at: p.at,
      key: `published:${i}`,
      node: (
        <Post who={who(p.employeeId)} colour={e?.colour} role={e?.role} at={p.at}>
          <p className="channel-text">{p.kind === 'push' ? t('projects.published.push', { branch: p.branch ?? '' }) : p.title ? t('projects.published.prTitled', { title: p.title }) : t('projects.published.pr')}</p>
          <span className="employee-card-actions">
            <Status tone={ACTION_STATE_TONE[p.state]} label={t(ACTION_STATE_LABEL[p.state])} />
            {p.via === 'shell' && <span className="employee-faint">{t('projects.published.shell')}</span>}
            {p.link && (
              <LinkButton size="sm" underline onClick={() => void api.openExternal(p.link!)}>
                {t('projects.published.open')}
              </LinkButton>
            )}
          </span>
        </Post>
      )
    })
  }
  if (project.phase === 'closed' && project.closedAt)
    entries.push({
      at: project.closedAt,
      key: 'closed',
      node: (
        <SystemLine>
          {t(project.outcome === 'done' ? 'projects.log.closedDone' : 'projects.log.closedStopped', { when: formatDateTime(project.closedAt, t.locale) })}
          {/* Stopped: where its work is now. */}
          {project.outcome === 'stopped' && <ProjectWorkspace project={project} />}
        </SystemLine>
      )
    })
  entries.sort((a, b) => a.at.localeCompare(b.at))
  return (
    <ol className="channel-timeline" aria-label={t('projects.timeline', { channel: projectChannel(project) })}>
      {entries.map((e) => (
        <Fragment key={e.key}>{e.node}</Fragment>
      ))}
      {/* Now, after everything that happened: where each answer will appear. */}
      <LiveLines project={project} live={live} who={who} />
    </ol>
  )
}

/** How a step that didn't finish ended: the person stopped it or took back its approval, it asked for a replan, or it was stuck. */
function StepEnd({ step }: { step: ProjectStep }) {
  const t = useT()
  if (step.end === 'stopped') return <Status tone="off" label={t('projects.part.stopped')} />
  if (step.end === 'undone') return <Status tone="off" label={t('projects.step.undone')} />
  if (step.end === 'replan') return <Status tone="warn" label={t('projects.step.replan')} />
  return <Status tone="error" label={t('projects.part.stuck')} />
}

/** What a step said it did; cut where it was too long to keep, with the whole result a button away. */
function StepSummary({ step }: { step: ProjectStep }) {
  const t = useT()
  const [full, setFull] = useState<string | null>(null)
  if (!step.summary) return null
  if (!step.summaryCut) return <Markdown text={step.summary} />
  const show = (open: boolean) => {
    if (!open || full !== null) return
    void attempt(async () => {
      const chain = await api.employeeTaskChain(step.taskId)
      setFull(chain.task.result?.summary ?? chain.task.resultSummary ?? step.summary ?? '')
    })
  }
  return (
    <>
      <Markdown text={step.summary} />
      <p className="employee-faint">{t('projects.summary.cut', { count: formatNumber(step.summaryCut, t.locale) })}</p>
      <Disclosure quiet label={t('projects.summary.full')} onOpenChange={show}>
        {full === null ? (
          <div className="employees-loading" role="status">
            <Spinner size={13} /> <span>{t('common.loading')}</span>
          </div>
        ) : (
          <Markdown text={full} />
        )}
      </Disclosure>
    </>
  )
}

/**
 * Undo approval, under an approval at a part's gate, while what it started still runs and has published nothing: main
 * says which (Project.undoable), as only it sees every push and pull request.
 */
function UndoApproval({ project, decision, part }: { project: Project; decision: ProjectDecisionRecord; part: string }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  if (!project.undoable?.includes(decision.at)) return null
  const undo = () => {
    setBusy(true)
    void attempt(async () => {
      await api.undoProjectDecision(project.id, decision.at)
      showToast(t('projects.undo.done', { part }))
    }).finally(() => setBusy(false))
  }
  return (
    <div className="employee-card-actions">
      <Button size="sm" disabled={busy} onClick={undo}>
        {t('projects.undo.action')}
      </Button>
    </div>
  )
}

/** A step's decision, as its post says it: the acceptance's, or a check's verdict. */
const STEP_DECISION: Record<string, PlainKey> = { accept: 'projects.decision.accept', replan: 'projects.decision.replan', pass: 'projects.decision.pass', fail: 'projects.decision.fail' }

const DECISION_LOG: Record<ProjectWait['kind'], Partial<Record<ProjectDecision, PlainKey>>> = {
  questions: { stop: 'projects.log.stopped' },
  plan: { approve: 'projects.log.planApproved', 'send-back': 'projects.log.planSentBack', stop: 'projects.log.stopped' },
  gate: { stop: 'projects.log.stopped' },
  stuck: { retry: 'projects.log.retried', stop: 'projects.log.stopped' },
  final: { approve: 'projects.log.finalApproved', 'send-back': 'projects.log.finalSentBack', stop: 'projects.log.stopped' }
}

/**
 * A file a part wrote, its newest version: its name and who wrote it, opening to its words. `approved`: the person's
 * approval at the part's gate; a version written after the one approved (a follow-up changed it) says so.
 */
function ArtifactCard({ orgId, artifact, who, approved }: { orgId: string; artifact: ProjectArtifact; who: string; approved?: ProjectDecisionRecord }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const changed = approved?.version !== undefined && artifact.version > approved.version
  return (
    <Card className="channel-artifact">
      {changed && <Status tone="warn" label={t('projects.artifact.changedAfter', { version: approved!.version! })} />}
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
      {artifact.mocks?.length ? <ArtifactMocks orgId={orgId} mocks={artifact.mocks} commit={artifact.commit} /> : null}
    </Card>
  )
}

/**
 * The HTML mocks a part drew with this version (shared/projects.ts mocksFolder): each a chip that opens it in the
 * browser as it was in this version's commit (openMemoryAt: a later follow-up's change doesn't show under an earlier
 * post or approval), so the person sees the screens without opening the file. Without a commit, from the memory
 * repository's folder as it is now; names only when that isn't on this computer.
 */
function ArtifactMocks({ orgId, mocks, commit }: { orgId: string; mocks: readonly string[]; commit?: string }) {
  const t = useT()
  const root = useStore((s) => {
    const org = s.snapshot!.organizations?.find((o) => o.id === orgId)
    return s.snapshot!.repos.find((r) => r.id === org?.memoryRepoId)?.rootPath
  })
  return (
    <div className="project-mocks">
      <span className="employee-faint">{t('projects.artifact.mocks', { count: mocks.length })}</span>
      {mocks.map((m) => {
        const name = m.slice(m.lastIndexOf('/') + 1)
        if (commit)
          return (
            <ChipButton key={m} path title={`${m} @ ${commit.slice(0, 12)}`} onClick={() => void attempt(() => api.openMemoryAt(orgId, m, commit))}>
              {name}
            </ChipButton>
          )
        // No workspace: the memory repository's files have no preview in Foreman, only the browser and the folder.
        return root ? <OpenFileChip key={m} path={joinWorkspace(root, m)} label={name} access={{ workspaceId: '', root, preview: false }} /> : <span key={m} className="mono">{name}</span>
      })}
    </div>
  )
}

function ArtifactText({ orgId, artifact }: { orgId: string; artifact: ProjectArtifact }) {
  const t = useT()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    // The version it labels (its commit), not the file as it is now.
    api.memoryReadFile(orgId, artifact.path, artifact.commit).then(
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

/** A part's state in a plan in effect, as the side column says it. */
function PartState({ project, plan, partId }: { project: Project; plan: ProjectPlan; partId: string }) {
  const t = useT()
  const state = partState(project, plan, partId)
  if (!state) return null
  const word = t(PART_STATUS[partLook(state)].label)
  return <Status tone={PART_STATUS[partLook(state)].tone} label={state.round > 1 ? `${word} · ${t('projects.round', { round: state.round })}` : word} />
}

/** A plan's list (what she understood, done when, out of scope, assumptions) under its heading, or a line saying there is none. */
function PlanList({ heading, items, none }: { heading: string; items: string[] | undefined; none?: string }) {
  if (!items?.length && !none) return null
  return (
    <div className="channel-plan-list">
      <span className="employee-subheading">{heading}</span>
      {items?.length ? (
        <ul>
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      ) : (
        <p className="employee-faint">{none}</p>
      )}
    </div>
  )
}

/** A plan as the program manager gave it, checked by Foreman: drawn as its workflow, then in words. */
function PlanCard({ orgId, project, plan, names, roster, pmName }: { orgId: string; project: Project; plan: ProjectPlan; names: Record<string, string>; roster?: EmployeeSummary[]; pmName: string }) {
  const t = useT()
  const before = [...project.plans].reverse().find((p) => p.version < plan.version && (p.status === 'approved' || p.status === 'went-ahead' || p.status === 'replaced'))
  const diff = before ? planDiff(before, plan) : undefined
  const owner = (part: PlanPart) => ownerName(plan, part.owner, names)
  const colour = (part: PlanPart) => roster?.find((e) => e.id === ownerId(plan, part.owner))?.colour ?? 'slate'
  const answered = (project.asks ?? []).filter((r) => r.answers && (r.answeredAt ?? '') <= plan.at).reduce((n, r) => n + r.questions.length, 0)
  const inEffect = project.plan?.version === plan.version
  const title = (id: string) => plan.parts.find((p) => p.id === id)?.title ?? id
  // Plans made before she asked first have none of these lists.
  const asked = plan.understood !== undefined
  return (
    <Card as="section" id={planDomId(project.id, plan.version)} className="channel-plan" aria-label={t('projects.plan.label', { version: plan.version })}>
      <div className="channel-plan-head">
        <span className="employee-subheading">{t('projects.plan.title', { version: plan.version })}</span>
        <Tag>{t(plan.size === 'small' ? 'projects.size.small' : 'projects.size.large')}</Tag>
        <Tag>{t(PLAN_STATUS_KEY[plan.status])}</Tag>
      </div>
      <p className="channel-text">{plan.summary}</p>
      <PlanWorkflow plan={plan} questions={answered} parts={inEffect ? project.parts : undefined} names={names} roster={roster} pmName={pmName} />
      <ol className="channel-plan-order" aria-label={t('projects.plan.order')}>
        {planStages(plan.parts).map((stage, i) => {
          const checks = stage.filter((id) => plan.parts.find((p) => p.id === id)?.gate)
          const who = stage.map((id) => t('projects.plan.orderPart', { part: title(id), name: owner(plan.parts.find((p) => p.id === id)!) })).join(', ')
          return (
            <li key={i}>
              {stage.length > 1 ? t('projects.plan.orderTogether', { parts: who }) : who}
              {checks.length > 0 && ` ${t('projects.plan.orderCheck', { parts: checks.map(title).join(', ') })}`}
            </li>
          )
        })}
        {plan.size === 'large' && <li>{t('projects.plan.orderAccept', { name: pmName })}</li>}
      </ol>
      {asked && (
        <div className="channel-plan-lists">
          <PlanList heading={t('projects.plan.understood')} items={plan.understood} />
          <PlanList heading={t('projects.plan.doneWhen')} items={plan.doneWhen} />
          <PlanList heading={t('projects.plan.outOfScope')} items={plan.outOfScope} />
          <PlanList heading={plan.assumptions?.length ? t('projects.plan.assumptionsCheck') : t('projects.plan.assumptions')} items={plan.assumptions} none={t('projects.plan.noAssumptions')} />
        </div>
      )}
      <table className="channel-plan-parts">
        <thead>
          <tr>
            <th scope="col">{t('projects.plan.col.part')}</th>
            <th scope="col">{t('projects.plan.col.owner')}</th>
            <th scope="col">{t('projects.plan.col.writes')}</th>
            <th scope="col">{t('projects.plan.col.after')}</th>
            <th scope="col">{t('projects.plan.col.check')}</th>
            {planInEffect(project, plan) && <th scope="col">{t('projects.plan.col.state')}</th>}
          </tr>
        </thead>
        <tbody>
          {plan.parts.map((p) => (
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
              {planInEffect(project, plan) && <td><PartState project={project} plan={plan} partId={p.id} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {diff && diff.removed.length > 0 && <p className="employee-faint">{t('projects.plan.removed', { parts: diff.removed.map((id) => partTitle({ plan: before, plans: [] }, id)).join(', ') })}</p>}
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

/** What she asked in a round, in her post: what she understood so far, then each question with why she asks. */
function QuestionsList({ round }: { round: QuestionRound }) {
  const t = useT()
  return (
    <Card as="section" className="channel-plan" aria-label={t('projects.questions.label', { round: round.round })}>
      <div className="channel-plan-head">
        <span className="employee-subheading">{t('projects.questions.title', { count: round.questions.length })}</span>
        <Tag>{t('projects.questions.round', { round: round.round, max: MAX_QUESTION_ROUNDS })}</Tag>
      </div>
      {round.understood.length > 0 && <PlanList heading={t('projects.questions.understood')} items={round.understood} />}
      <ol className="channel-questions">
        {round.questions.map((q, i) => (
          <li key={i}>
            <span>{q.question}</span>
            {q.why && <span className="employee-faint">{q.why}</span>}
          </li>
        ))}
      </ol>
    </Card>
  )
}

/**
 * Her questions, waiting for you: every one on one card, each with its options (and an answer in your own words), then
 * Send answers once each is answered (before that it goes to the first unanswered one and names them all; Ctrl+Enter
 * too), Plan with what you have (she gets the answers you gave and assumes the rest), or Stop (asked first; Esc never
 * stops). What you typed is kept while you look elsewhere (projectDrafts.ts).
 */
function QuestionsCard({ project, wait, pmName, stop, age, who }: { project: Project; wait: ProjectWait; pmName: string; stop: DecisionAct; age: string; who: ReactNode }) {
  const t = useT()
  const round = (project.asks ?? []).find((r) => !r.answers && !r.skipped)
  // Kept for these questions as they were shown: answers typed for one round never land under another's.
  const seen = round ? roundSeen(round) : ''
  const [choices, setChoices] = useWaitDraft<Record<number, string>>(project.id, wait.id, `choices:${seen}`, {})
  const [own, setOwn] = useWaitDraft<Record<number, string>>(project.id, wait.id, `own:${seen}`, {})
  const [busy, setBusy] = useState(false)
  // Send was pressed with a question unanswered: the foot names which ones until each is.
  const [tried, setTried] = useState(false)
  const list = useRef<HTMLOListElement>(null)
  if (!round) return null
  const answerOf = (i: number): string => {
    const q = round.questions[i]
    const choice = choices[i]
    if (q.options.length && choice !== undefined && choice !== 'own') return q.options[Number(choice)] ?? ''
    return (own[i] ?? '').trim()
  }
  const answers = round.questions.map((_, i) => answerOf(i))
  const done = answers.filter(Boolean).length
  const missing = answers.flatMap((a, i) => (a ? [] : [i]))
  const send = (skip: boolean) => {
    if (busy) return
    if (!skip && missing.length) {
      // Send stays pressable, so it can say why it didn't send: to the first unanswered question, and name the rest.
      setTried(true)
      list.current?.children[missing[0]]?.querySelector<HTMLElement>('input, textarea')?.focus()
      return
    }
    setBusy(true)
    void attempt(async () => {
      // Plan with what you have sends what was answered too, blank for the rest.
      await api.answerProject(project.id, wait.id, answers, skip ? { skip: true, seen } : { seen })
      clearWaitDrafts(project.id, wait.id)
      showToast(t(skip ? 'projects.questions.skipped' : 'projects.questions.sent', { name: pmName }))
    }).finally(() => setBusy(false))
  }
  return (
    <DecisionCard
      who={who}
      kind={t('projects.wait.questions')}
      age={age}
      subject={t('projects.questions.subject', { name: pmName, count: round.questions.length })}
      consequence={t('projects.questions.consequence', { name: pmName })}
      footStart={
        <span role="status">
          {tried && missing.length ? (
            <Status tone="warn" label={t('projects.questions.missing', { count: missing.length, list: new Intl.ListFormat(t.locale, { type: 'conjunction' }).format(missing.map((i) => formatNumber(i + 1, t.locale))) })} />
          ) : (
            <span className="employee-faint">{t('projects.questions.progress', { done, count: round.questions.length })}</span>
          )}
        </span>
      }
      escDeclines={false}
      modEnter="main"
      decline={stop}
      alternate={{ label: t('projects.questions.skip'), disabled: busy, title: t('projects.questions.skipHint', { name: pmName }), onAct: () => send(true) }}
      main={{ label: t('projects.questions.send'), disabled: busy, onAct: () => send(false) }}
    >
      <ol className="channel-questions" ref={list}>
        {round.questions.map((q, i) => {
          const ownField = (
            <Field label={t(q.options.length ? 'employees.question.own' : 'employees.question.answer')} description={q.options.length ? undefined : q.why}>
              {(c) => <TextArea {...c} rows={2} maxLength={MAX_ANSWER} value={own[i] ?? ''} onChange={(e) => setOwn({ ...own, [i]: e.target.value })} />}
            </Field>
          )
          return (
            <li key={i}>
              <span className="employee-question-text">{q.question}</span>
              {q.options.length > 0 ? (
                <>
                  {q.why && <span className="employee-faint">{q.why}</span>}
                  <RadioList
                    legend={q.question}
                    hideLegend
                    value={choices[i]}
                    onChange={(v) => setChoices({ ...choices, [i]: v })}
                    options={[
                      ...q.options.map((o, n) => ({ value: String(n), label: o })),
                      { value: 'own', label: t('employees.question.ownOption'), ...(choices[i] === 'own' ? { extra: ownField } : {}) }
                    ]}
                  />
                </>
              ) : (
                ownField
              )}
            </li>
          )
        })}
      </ol>
    </DecisionCard>
  )
}

/** What a proposed employee will be able to do once approved, as its draft has it: every employee has a shell, and publishes where it writes. */
function proposedAccessText(repos: Record<string, 'read' | 'write'>, t: ReturnType<typeof useT>): string {
  const of = (access: 'read' | 'write') => Object.keys(repos).filter((r) => repos[r] === access)
  const lines = [of('write').length ? t('projects.plan.accessWrite', { repos: of('write').join(', ') }) : '', of('read').length ? t('projects.plan.accessRead', { repos: of('read').join(', ') }) : ''].filter(Boolean)
  return lines.length ? lines.join(' · ') : t('projects.plan.accessNone')
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
                <span className="employee-faint">{proposedAccessText(p.repos, t)}</span>
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

/** What the project waits for you on, then what its employees ask or hold. Stop on a card asks here first. */
function Waiting({
  orgId,
  project,
  names,
  roster,
  pmName,
  stopping,
  onStop,
  onStopDone
}: {
  orgId: string
  project: Project
  names: Record<string, string>
  roster?: EmployeeSummary[]
  pmName: string
  stopping: boolean
  onStop: () => void
  onStopDone: () => void
}) {
  const t = useT()
  const items = useDecisionItems(orgId)
  const tasks = new Set(project.steps.map((s) => s.taskId))
  const theirs = items.filter((i) => (i.kind === 'question' || i.kind === 'task' ? tasks.has(i.task.id) : i.kind === 'action' ? tasks.has(i.action.taskId) : false))
  const waits = project.phase === 'closed' ? [] : project.waits
  const ids = waits.map((w) => w.id).join(',')
  // What was typed for a wait that is gone (decided, replaced, the project closed) goes with it.
  useEffect(() => keepWaitDrafts(project.id, ids ? ids.split(',') : []), [project.id, ids])
  if (!waits.length && !theirs.length) return null
  return (
    <section className="channel-waiting" aria-label={t('projects.waiting.label')}>
      <span className="employee-subheading">{t('projects.waiting.heading', { count: waits.length + theirs.length })}</span>
      {stopping && <StopConfirm project={project} onDone={onStopDone} />}
      {waits.map((w) => (
        <WaitCard key={w.id} orgId={orgId} project={project} wait={w} names={names} roster={roster} pmName={pmName} onStop={onStop} />
      ))}
      {theirs.map((item) => (
        <EmployeeDecision key={item.id} orgId={orgId} item={item} place={{ form: 'card' }} />
      ))}
    </section>
  )
}

/**
 * One thing the project waits on, as a decision card with a note for a send-back or a retry. Stop is on every card, but
 * asks first and has no key: Esc in a card never ends the project. At a part's gate a written note makes Send back the
 * main act (Enter, Ctrl+Enter), with Approve with note beside it; a mock can be picked there.
 */
function WaitCard({ orgId, project, wait, names, roster, pmName, onStop }: { orgId: string; project: Project; wait: ProjectWait; names: Record<string, string>; roster?: EmployeeSummary[]; pmName: string; onStop: () => void }) {
  const t = useT()
  const [note, setNote] = useWaitDraft(project.id, wait.id, 'note', '')
  const [pick, setPick] = useWaitDraft(project.id, wait.id, 'pick', '')
  const [busy, setBusy] = useState(false)
  const decide = (decision: ProjectDecision, options?: ProjectDecideOptions) => {
    if (busy) return
    setBusy(true)
    void attempt(async () => {
      if (options) await api.decideProject(project.id, wait.id, decision, note.trim() || undefined, options)
      else await api.decideProject(project.id, wait.id, decision, note.trim() || undefined)
      setNote('')
      clearWaitDrafts(project.id, wait.id)
    }).finally(() => setBusy(false))
  }
  const you = (
    <span className="channel-owner">
      <HardHat colour="slate" size={16} /> {t('projects.you')}
    </span>
  )
  const age = timeAgo(wait.since, t.locale)
  // A note goes with Send back; at a part's gate also with Approve, to what starts next. The plan and the final gate pass
  // an approval's note to nobody, so a written note holds Approve there.
  const noted = Boolean(note.trim())
  const stop = { label: t('projects.action.stop'), disabled: busy, onAct: onStop }
  const noteField = (label: string, hint?: string) => (
    <Field label={label} description={hint}>
      {(control) => <TextArea {...control} rows={2} maxLength={MAX_NOTE} value={note} onChange={(e) => setNote(e.target.value)} />}
    </Field>
  )
  if (wait.kind === 'questions') return <QuestionsCard project={project} wait={wait} pmName={pmName} stop={stop} age={age} who={you} />
  if (wait.kind === 'stuck') {
    const part = wait.partId ? partTitle(project, wait.partId) : ''
    return (
      <DecisionCard
        who={you}
        kind={t('projects.wait.stuck')}
        age={age}
        subject={part ? t('projects.stuck.subjectPart', { part }) : t('projects.stuck.subject')}
        consequence={t('projects.stuck.consequence')}
        escDeclines={false}
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
    // The plan on this card: one changed since is refused, not approved unseen.
    const seen = plan ? { seen: planSeen(plan) } : undefined
    return (
      <DecisionCard
        who={you}
        kind={t('projects.wait.plan')}
        age={age}
        subject={plan ? t('projects.planGate.subject', { version: plan.version, count: plan.parts.length }) : t('projects.wait.plan')}
        consequence={unapproved.length ? t('projects.planGate.approveFirst', { names: unapproved.join(', ') }) : t('projects.planGate.consequence')}
        escDeclines={false}
        decline={stop}
        alternate={{ label: t('projects.action.sendBack'), disabled: busy || !note.trim(), title: !note.trim() ? t('projects.noteFirst') : undefined, onAct: () => decide('send-back', seen) }}
        main={{ label: t('projects.planGate.approve'), disabled: busy || !plan || unapproved.length > 0 || noted, title: unapproved.length ? t('projects.planGate.approveFirst', { names: unapproved.join(', ') }) : noted ? t('projects.noteBlocksApprove') : undefined, onAct: () => decide('approve', seen) }}
      >
        {noteField(t('projects.planGate.noteLabel'))}
      </DecisionCard>
    )
  }
  if (wait.kind === 'gate') {
    const part = partTitle(project, wait.partId)
    const artifact = Object.values(project.artifacts).find((a) => a.partId === wait.partId)
    // Where a note with Approve goes (gateNoteTo): what starts next, her acceptance, or nowhere (then only Send back takes one).
    const to = project.plan && wait.partId ? gateNoteTo(project.plan, wait.partId) : 'parts'
    const options = (artifact?.mocks ?? []).filter((m) => !m.endsWith('/index.html'))
    const picked = pick && options.includes(pick) ? pick : ''
    const approve: DecisionAct = {
      label: noted ? t('projects.gate.approveWithNote') : t('projects.gate.approve'),
      disabled: busy || (noted && to === 'nobody'),
      title: noted && to === 'nobody' ? t('projects.noteBlocksApprove') : undefined,
      onAct: () => decide('approve', picked ? { pick: picked } : undefined)
    }
    const sendBack: DecisionAct = { label: t('projects.action.sendBack'), disabled: busy || !noted, title: !noted ? t('projects.noteFirst') : undefined, onAct: () => decide('send-back') }
    return (
      <DecisionCard
        who={you}
        kind={t('projects.wait.gate')}
        age={age}
        subject={t('projects.gate.subject', { part })}
        consequence={!noted ? t('projects.gate.consequence') : to === 'parts' ? t('projects.gate.consequenceNote') : to === 'acceptance' ? t('projects.gate.consequenceNoteAccept', { name: pmName }) : t('projects.gate.consequenceNoteNowhere')}
        escDeclines={false}
        // A written note is most likely a change asked for: Send back is the main act then, on Enter and Ctrl+Enter.
        modEnter={noted ? 'main' : 'alternate'}
        decline={stop}
        alternate={noted ? approve : sendBack}
        main={noted ? sendBack : approve}
      >
        {artifact && <ArtifactCard orgId={orgId} artifact={artifact} who={names[artifact.employeeId] ?? artifact.employeeId} approved={artifact.partId ? lastApproval(project.decisions, artifact.partId) : undefined} />}
        {options.length > 1 && to !== 'nobody' && (
          <RadioList
            legend={t('projects.gate.pickLegend')}
            value={picked}
            onChange={setPick}
            options={[{ value: '', label: t('projects.gate.pickNone') }, ...options.map((m) => ({ value: m, label: <span className="mono">{m.slice(m.lastIndexOf('/') + 1)}</span> }))]}
          />
        )}
        {noteField(to === 'parts' ? t('projects.gate.noteLabel') : to === 'acceptance' ? t('projects.gate.noteLabelAccept', { name: pmName }) : t('projects.gate.noteLabelNowhere'))}
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
      escDeclines={false}
      decline={stop}
      alternate={{ label: t('projects.action.sendBack'), disabled: busy || !note.trim() || left === 0, title: left === 0 ? t('projects.final.noReplans') : !note.trim() ? t('projects.noteFirst') : undefined, onAct: () => decide('send-back') }}
      main={{ label: t('projects.final.approve'), disabled: busy || noted, title: noted ? t('projects.noteBlocksApprove') : undefined, onAct: () => decide('approve') }}
    >
      {wait.reason && <p className="channel-quote">{wait.reason}</p>}
      {acceptance && <ArtifactCard orgId={orgId} artifact={acceptance} who={names[acceptance.employeeId] ?? acceptance.employeeId} />}
      {noteField(t('projects.final.noteLabel'), t('projects.replansLeft', { count: left }))}
    </DecisionCard>
  )
}

/**
 * Where a project's work is (its workspace): open while it is here; once archived, its name, what its branch and the
 * archive keep, and Restore (the existing restore: its worktree and changes back) or Read its chats.
 */
function ProjectWorkspace({ project, side }: { project: Project; side?: boolean }) {
  const t = useT()
  const ws = useStore((s) => (project.workspaceId ? s.snapshot!.workspaces.find((w) => w.id === project.workspaceId) : undefined))
  if (!project.workspaceId) return side ? <p className="employee-faint">{t('projects.side.noWorkspace')}</p> : null
  if (!ws) return side ? <p className="employee-faint">{t('projects.side.workspaceGone')}</p> : null
  if (ws.state !== 'archived')
    return side ? (
      <Button size="sm" onClick={() => selectWorkspace(ws.id)}>
        {t('projects.openWorkspace')}
      </Button>
    ) : null
  return <ArchivedWorkspace ws={ws} />
}

function ArchivedWorkspace({ ws }: { ws: Workspace }) {
  const t = useT()
  const [work, setWork] = useState<Pick<ArchivedWork, 'branch' | 'deletesBranch' | 'unpushed' | 'uncommitted'> | null>(null)
  useEffect(() => {
    let live = true
    api.archivedWork([ws.id]).then(
      (found) => live && found[0] && setWork(found[0]),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [ws.id, ws.archivedAt])
  const files = ws.archiveDiff?.files
  return (
    <span className="project-head-who">
      <span>{t('projects.side.archivedAs', { name: ws.name })}</span>
      {work && (
        <span className="employee-faint">
          {/* Git couldn't say; a branch archiving keeps whatever (the default branch, another's, one added from disk); commits only here; none. */}
          {work.unpushed === null
            ? t('projects.side.archivedBranchUnknown', { branch: work.branch })
            : !work.deletesBranch
              ? t('projects.side.archivedBranchKept', { branch: work.branch })
              : work.unpushed > 0
                ? t('projects.side.archivedCommits', { count: work.unpushed, branch: work.branch })
                : t('projects.side.archivedNoCommits', { branch: work.branch })}
        </span>
      )}
      {(work?.uncommitted || files) && <span className="employee-faint">{t('projects.side.archivedChanges')}</span>}
      <span className="employee-card-actions">
        <Button size="sm" onClick={() => void restoreArchived(ws.id)}>
          {t('projects.side.restore')}
        </Button>
        <LinkButton onClick={() => openArchivedChats(ws.id)}>{t('projects.side.readArchived')}</LinkButton>
      </span>
    </span>
  )
}

/** Beside the channel: the parts and their states (a list, or a map that takes the channel to a part), the files, the workspace, the replans left. */
function SidePanel({ orgId, project, names, roster, live }: { orgId: string; project: Project; names: Record<string, string>; roster?: EmployeeSummary[]; live: readonly ProjectLive[] }) {
  const t = useT()
  const plan = project.plan ?? project.plans.at(-1)
  const artifacts = Object.values(project.artifacts).sort((a, b) => a.at.localeCompare(b.at))
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
          <PlanMap project={project} plan={plan} names={names} roster={roster} label={t('projects.map.sideLabel', { channel: projectChannel(project) })} selected={picked} onSelect={pick} />
        ) : plan ? (
          <ul className="channel-side-list">
            {plan.parts.map((p) => {
              const s = project.plan ? (project.parts[p.id] ?? { state: 'pending' as const, round: 0 }) : { state: 'pending' as const, round: 0 }
              const st = PART_STATUS[partLook(s)]
              const id = ownerId(plan, p.owner)
              const e = id ? roster?.find((x) => x.id === id) : undefined
              // Ready, but another part changes the repository now: one at a time.
              const behind = project.plan && project.phase === 'working' ? waitingOnRepo(project.plan, project.parts, p.id) : undefined
              return (
                <li key={p.id} className="channel-side-part">
                  <HardHat colour={(e?.colour ?? 'slate') as HardHatColour} size={16} />
                  <span className="project-head-who">
                    <span>{p.title}</span>
                    <span className="employee-faint">{ownerName(plan, p.owner, names)}</span>
                    {behind && <span className="employee-faint">{t('projects.part.waitsFor', { part: behind.title })}</span>}
                  </span>
                  <Status
                    tone={st.tone}
                    busy={live.some((l) => l.state === 'working' && l.step.partId === p.id)}
                    label={s.round > 1 ? `${t(st.label)} · ${t('projects.round', { round: s.round })}` : t(st.label)}
                  />
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
        <ProjectWorkspace project={project} side />
        <Meter label={t('projects.side.replans')} value={project.replans} max={MAX_REPLANS} valueText={t('projects.side.replansUsed', { used: project.replans, max: MAX_REPLANS })} tone={project.replans >= MAX_REPLANS ? 'warn' : 'ok'} />
        <span className="employee-faint">{t('projects.side.replansUsed', { used: project.replans, max: MAX_REPLANS })}</span>
      </Card>
    </aside>
  )
}
