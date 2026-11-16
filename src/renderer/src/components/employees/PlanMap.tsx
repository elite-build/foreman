// A project's plan drawn as a map (docs/ai-employees.md §15), beside the plan's table: one node per part, with its
// owner's hat and name, its title and the file it writes, its state in a glyph and a word; an edge for each "after",
// labelled with the file the waiting part reads, strong once that file is written; the parts the person checks in the
// gate shape; owners still only proposed dim, with Review on the selected part; what changed since the plan before
// marked in words (New, Changed, Taken out). Wide in the plan card, where selecting a part opens its brief under the map;
// compact in the side column, where the titles are the files and selecting a part takes the channel to its newest post.
// The plan's table stays the accessible equivalent: the same parts, owners, files, order and checks.
import { useMemo, useState, type ReactNode } from 'react'
import type { EmployeeSummary } from '../../../../shared/employees'
import { layoutPlan, type PlanLayoutForm } from '../../../../shared/planLayout'
import { ownerId, ownerName, planDiff, type PartState, type PartStatus, type PlanPart, type Project, type ProjectPlan } from '../../../../shared/projects'
import { useT, type RendererT } from '../../i18n'
import { openEmployees } from '../../store'
import { Button, Card, Dialog, Graph, HardHat, Tag, type GraphEdge, type GraphNode, type GraphTone, type HardHatColour } from '../../ui'
import { useGraphLabels } from '../FlowDiagram'
import { PART_STATUS } from './projectWords'
import './employees.css'

const TONE: Record<PartState, GraphTone> = { pending: 'off', running: 'running', gate: 'waiting', done: 'ok', stuck: 'error' }

/** Whether this plan is the one in effect, so its parts have states. */
export const planInEffect = (project: Pick<Project, 'plan'>, plan: Pick<ProjectPlan, 'version' | 'status'>): boolean =>
  project.plan?.version === plan.version && (plan.status === 'approved' || plan.status === 'went-ahead')

/** The plan a version replaced, for what changed: the newest earlier one that was in effect or replaced. */
export const planBefore = (project: Pick<Project, 'plans'>, plan: Pick<ProjectPlan, 'version'>): ProjectPlan | undefined =>
  [...project.plans].reverse().find((p) => p.version < plan.version && (p.status === 'approved' || p.status === 'went-ahead' || p.status === 'replaced'))

/** A part's state in this plan: the project's record once it is in effect, waiting while the plan waits, none after. */
export function partState(project: Pick<Project, 'plan' | 'parts'>, plan: Pick<ProjectPlan, 'version' | 'status'>, partId: string): PartStatus | undefined {
  if (planInEffect(project, plan)) return project.parts[partId] ?? { state: 'pending', round: 0 }
  return plan.status === 'waiting' ? { state: 'pending', round: 0 } : undefined
}

/** Whether a part's owner is an approved employee (not a proposal still to make, or a draft still to approve). */
export function ownerApproved(plan: Pick<ProjectPlan, 'proposedIds'>, owner: string, roster: readonly EmployeeSummary[] | undefined): boolean {
  const id = ownerId(plan, owner)
  const e = id ? roster?.find((x) => x.id === id) : undefined
  return Boolean(e && e.state !== 'draft' && e.state !== 'retired')
}

interface PlanMapData {
  width: number
  height: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  tags: ReactNode[]
}

/** The Graph's nodes, edges and the words in the bar above them, for one plan in one form. */
function usePlanGraph(project: Project, plan: ProjectPlan, form: PlanLayoutForm, names: Record<string, string>, roster: readonly EmployeeSummary[] | undefined, t: RendererT): PlanMapData {
  return useMemo(() => {
    const before = planBefore(project, plan)
    const diff = before ? planDiff(before, plan) : undefined
    const removed = before && diff ? before.parts.filter((p) => diff.removed.includes(p.id)) : []
    const layout = layoutPlan([...plan.parts, ...removed], form)
    const at = new Map(layout.boxes.map((b) => [b.id, b]))
    const live = planInEffect(project, plan)
    const colour = (of: Pick<ProjectPlan, 'proposedIds'>, owner: string) => (roster?.find((e) => e.id === ownerId(of, owner))?.colour ?? 'slate') as HardHatColour
    const writes = new Map([...removed, ...plan.parts].map((p) => [p.id, p.writes]))
    const after = (of: ProjectPlan, part: PlanPart) => {
      const titles = part.dependsOn.map((d) => of.parts.find((p) => p.id === d)?.title).filter(Boolean)
      return titles.length ? `${t('projects.plan.col.after')}: ${titles.join(', ')}` : ''
    }

    // A part a replan took out has no state: its badge says it is taken out.
    const node = (part: PlanPart, of: ProjectPlan, gone: boolean): GraphNode => {
      const b = at.get(part.id)!
      const owner = ownerName(of, part.owner, names)
      const proposed = !gone && !ownerApproved(of, part.owner, roster)
      const status = gone ? undefined : partState(project, plan, part.id)
      const word = status ? (status.round > 1 ? `${t(PART_STATUS[status.state].label)} · ${t('projects.round', { round: status.round })}` : t(PART_STATUS[status.state].label)) : ''
      const mark = gone ? ('removed' as const) : diff?.added.includes(part.id) ? ('added' as const) : diff?.changed.includes(part.id) ? ('changed' as const) : undefined
      const markLabel = mark === 'removed' ? t('projects.map.removed') : mark === 'added' ? t('projects.plan.added') : mark === 'changed' ? t('projects.plan.changed') : undefined
      const who = [owner, proposed ? t('projects.map.proposed') : '', part.gate ? t('projects.map.youCheck') : ''].filter(Boolean)
      const title = form === 'compact' ? part.writes : part.title
      return {
        id: part.id,
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        shape: part.gate ? 'gate' : 'card',
        title,
        kicker: (
          <>
            <HardHat colour={colour(of, part.owner)} size={12} /> {who.join(' · ')}
          </>
        ),
        detail: form === 'compact' ? word || undefined : [part.writes, word].filter(Boolean).join(' · '),
        ...(status ? { tone: TONE[status.state], toneLabel: word } : {}),
        ...(proposed && !live ? { dim: true } : {}),
        ...(mark && markLabel ? { mark, markLabel } : {}),
        // The kicker isn't read with the node, and the arrows aren't read at all, so the name says both: with the
        // table's columns in it, a screen reader hears the same plan in either view.
        label: [title, form === 'compact' ? part.title : part.writes, ...who, after(of, part), word, markLabel].filter(Boolean).join(', ')
      }
    }
    const nodes = [...plan.parts.map((p) => node(p, plan, false)), ...removed.map((p) => node(p, before!, true))]

    const pairs = new Set(plan.parts.flatMap((p) => p.dependsOn.map((d) => `${d}>${p.id}`)))
    const beforePairs = new Set((before?.parts ?? []).flatMap((p) => p.dependsOn.map((d) => `${d}>${p.id}`)))
    const edges: GraphEdge[] = layout.edges.map((e) => {
      const key = `${e.from}>${e.to}`
      const gone = !pairs.has(key) || removed.some((p) => p.id === e.from || p.id === e.to)
      const added = !gone && Boolean(before) && !beforePairs.has(key)
      const written = live && project.parts[e.from]?.state === 'done'
      const label = writes.get(e.from)
      return {
        id: `edge:${key}`,
        from: { node: e.fromEnd.node, side: e.fromEnd.side, offset: e.fromEnd.offset },
        to: { node: e.toEnd.node, side: e.toEnd.side, offset: e.toEnd.offset },
        ...(form === 'wide' && label ? { label } : {}),
        ...(gone ? { line: 'dashed' as const, mark: 'removed' as const, markLabel: t('projects.map.removed') } : added ? { mark: 'added' as const, markLabel: t('projects.plan.added') } : {}),
        ...(written ? { weight: 'strong' as const } : {})
      }
    })
    // Edges the replan took away between parts that are both still drawn.
    for (const key of beforePairs) {
      if (pairs.has(key)) continue
      const [from, to] = key.split('>')
      if (!at.has(from) || !at.has(to) || layout.edges.some((e) => e.from === from && e.to === to)) continue
      edges.push({ id: `edge:${key}`, from: { node: from, side: 'bottom', offset: 0 }, to: { node: to, side: 'top', offset: 0 }, line: 'dashed', mark: 'removed', markLabel: t('projects.map.removed') })
    }

    const tags: ReactNode[] = []
    if (live) {
      const done = plan.parts.filter((p) => project.parts[p.id]?.state === 'done').length
      tags.push(<Tag key="done">{t('projects.map.done', { done, count: plan.parts.length })}</Tag>)
    } else tags.push(<Tag key="parts">{t('projects.map.parts', { count: plan.parts.length })}</Tag>)
    const checks = plan.parts.filter((p) => p.gate).length
    if (checks && form === 'wide') tags.push(<Tag key="checks">{t('projects.map.checks', { count: checks })}</Tag>)
    const toApprove = new Set(plan.parts.filter((p) => !ownerApproved(plan, p.owner, roster)).map((p) => p.owner)).size
    if (toApprove && plan.status === 'waiting') tags.push(<Tag key="approve" tone="warn">{t('projects.map.toApprove', { count: toApprove })}</Tag>)
    if (diff && form === 'wide') {
      if (diff.added.length) tags.push(<Tag key="new">{t('projects.map.new', { count: diff.added.length })}</Tag>)
      if (diff.changed.length) tags.push(<Tag key="changed">{t('projects.map.changed', { count: diff.changed.length })}</Tag>)
      if (diff.removed.length) tags.push(<Tag key="removed">{t('projects.map.takenOut', { count: diff.removed.length })}</Tag>)
    }
    return { width: layout.width, height: layout.height, nodes, edges, tags }
  }, [project, plan, form, names, roster, t])
}

export interface PlanMapProps {
  orgId: string
  project: Project
  plan: ProjectPlan
  form: PlanLayoutForm
  names: Record<string, string>
  roster?: EmployeeSummary[]
  label: string
  selected: string | null
  onSelect: (id: string | null) => void
}

/** The plan as a Graph, with its zoom and full screen in a bar above it that also says what the plan holds. */
export function PlanMap({ orgId, project, plan, form, names, roster, label, selected, onSelect }: PlanMapProps) {
  const t = useT()
  const graph = usePlanGraph(project, plan, form, names, roster, t)
  const labels = useGraphLabels()
  const [zoom, setZoom] = useState<number | 'fit' | null>(null)
  const [full, setFull] = useState(false)
  const start = (
    <ul className="plan-map-tags" aria-label={t('projects.map.summary')}>
      {graph.tags.map((tag, i) => (
        <li key={i}>{tag}</li>
      ))}
    </ul>
  )
  const part = selected ? plan.parts.find((p) => p.id === selected) : undefined
  return (
    <div className={`plan-map plan-map-${form}`}>
      <Graph
        label={label}
        width={graph.width}
        height={graph.height}
        nodes={graph.nodes}
        edges={graph.edges}
        selected={selected}
        onSelect={onSelect}
        labels={labels}
        zoom={zoom ?? (form === 'compact' ? 'fit' : 1)}
        onZoomChange={setZoom}
        onFullScreen={() => setFull(true)}
        bar={{ start, grow: true }}
        className="plan-map-graph"
      />
      {form === 'wide' && part && <PartBrief orgId={orgId} project={project} plan={plan} part={part} names={names} roster={roster} />}
      {full && (
        <Dialog title={label} onClose={() => setFull(false)} size="xl" closeOnBackdrop>
          <PlanMapFull project={project} plan={plan} names={names} roster={roster} label={label} selected={selected} onSelect={onSelect} />
        </Dialog>
      )}
    </div>
  )
}

/** Full screen: the wide map with room, whichever form opened it. */
function PlanMapFull({ project, plan, names, roster, label, selected, onSelect }: Omit<PlanMapProps, 'orgId' | 'form'>) {
  const t = useT()
  const graph = usePlanGraph(project, plan, 'wide', names, roster, t)
  const labels = useGraphLabels()
  return <Graph label={label} width={graph.width} height={graph.height} nodes={graph.nodes} edges={graph.edges} selected={selected} onSelect={onSelect} labels={labels} bar={{}} className="plan-map-full" />
}

/** The selected part under the wide map: its owner, its brief, what it reads and writes, and Review for a proposed owner. */
function PartBrief({ orgId, project, plan, part, names, roster }: { orgId: string; project: Project; plan: ProjectPlan; part: PlanPart; names: Record<string, string>; roster?: EmployeeSummary[] }) {
  const t = useT()
  const id = ownerId(plan, part.owner)
  const e = id ? roster?.find((x) => x.id === id) : undefined
  const proposed = plan.proposed.find((p) => plan.proposedIds[p.key] === id || `new:${p.key}` === part.owner)
  const approved = ownerApproved(plan, part.owner, roster)
  const owner = ownerName(plan, part.owner, names)
  const title = (pid: string) => plan.parts.find((p) => p.id === pid)?.title ?? pid
  const reads = [...new Set([...part.dependsOn, ...part.reads])].map((pid) => plan.parts.find((p) => p.id === pid)?.writes).filter((f): f is string => Boolean(f))
  const next = plan.parts.filter((p) => p.dependsOn.includes(part.id)).map((p) => title(p.id))
  const lines = [reads.length ? t('projects.map.reads', { files: reads.join(', ') }) : '', t('projects.map.writes', { file: part.writes }), part.gate ? (next.length ? t('projects.map.checkBefore', { parts: next.join(', ') }) : t('projects.map.checkResult')) : '']
  const status = partState(project, plan, part.id)
  return (
    <Card as="section" className="plan-map-brief" aria-label={t('projects.map.briefLabel', { part: part.title })}>
      <div className="plan-map-brief-head">
        <HardHat colour={(e?.colour ?? 'slate') as HardHatColour} size={20} />
        <span className="project-head-who">
          <span className="employee-subheading">{part.title}</span>
          <span className="employee-faint">{[owner, e?.role ?? proposed?.role, approved ? '' : t('projects.map.notApproved'), status ? t(PART_STATUS[status.state].label) : ''].filter(Boolean).join(' · ')}</span>
        </span>
        {!approved && e && (
          <Button size="sm" onClick={() => openEmployees({ orgId, page: 'employee', id: e.id })}>
            {t('projects.plan.review', { name: owner })}
          </Button>
        )}
      </div>
      <p className="channel-text">{part.brief}</p>
      <p className="employee-faint">{lines.filter(Boolean).join(' · ')}</p>
    </Card>
  )
}

/** A choice kept on this computer (like the diff's layout): which way a plan or its parts are shown. */
export function useViewChoice<T extends string>(key: string, values: readonly T[], fallback: T): [T, (value: T) => void] {
  const read = (): T => {
    try {
      const v = localStorage.getItem(key)
      return values.includes(v as T) ? (v as T) : fallback
    } catch {
      return fallback
    }
  }
  const [value, setValue] = useState<T>(read)
  const set = (next: T) => {
    setValue(next)
    try {
      localStorage.setItem(key, next)
    } catch {
      // Private storage full or off: the choice lasts while the page is open.
    }
  }
  return [value, set]
}

