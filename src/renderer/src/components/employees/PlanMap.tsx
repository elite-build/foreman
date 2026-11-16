// A project's parts drawn as a map in the channel's side column (docs/ai-employees.md §15): one node per part, titled by
// the file it writes, with its owner's hat and name and its state in a glyph and a word; an edge for each "after", strong
// once that file is written; the parts the person checks in the gate shape; owners still only proposed dim; what changed
// since the plan before marked in words (New, Changed, Taken out). Selecting a part takes the channel to its newest post
// (the caller does). Full screen draws it wide, with each part's title and the files on the edges. Each node's name
// carries the plan table's columns, so the map reads like the list beside it. The plan card draws the plan's workflow
// (PlanWorkflow.tsx); this is the parts' live picture.
import { useMemo, useState, type ReactNode } from 'react'
import type { EmployeeSummary } from '../../../../shared/employees'
import { layoutPlan, type PlanLayoutForm } from '../../../../shared/planLayout'
import { ownerId, ownerName, planDiff, type PartState, type PartStatus, type PlanPart, type Project, type ProjectPlan } from '../../../../shared/projects'
import { useT, type RendererT } from '../../i18n'
import { Dialog, Graph, HardHat, Tag, type GraphEdge, type GraphNode, type GraphTone, type HardHatColour } from '../../ui'
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
  project: Project
  plan: ProjectPlan
  names: Record<string, string>
  roster?: EmployeeSummary[]
  label: string
  selected: string | null
  onSelect: (id: string | null) => void
}

/** The parts as a compact Graph, with what the plan holds, its zoom and full screen in a bar above it. */
export function PlanMap({ project, plan, names, roster, label, selected, onSelect }: PlanMapProps) {
  const t = useT()
  const graph = usePlanGraph(project, plan, 'compact', names, roster, t)
  const labels = useGraphLabels()
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [full, setFull] = useState(false)
  return (
    <div className="plan-map">
      <Graph
        label={label}
        width={graph.width}
        height={graph.height}
        nodes={graph.nodes}
        edges={graph.edges}
        selected={selected}
        onSelect={onSelect}
        labels={labels}
        zoom={zoom}
        onZoomChange={setZoom}
        onFullScreen={() => setFull(true)}
        bar={{ start: <PlanTags tags={graph.tags} />, grow: true }}
        className="plan-map-graph"
      />
      {full && (
        <Dialog title={label} onClose={() => setFull(false)} size="xl" closeOnBackdrop>
          <PlanMapFull project={project} plan={plan} names={names} roster={roster} label={label} selected={selected} onSelect={onSelect} />
        </Dialog>
      )}
    </div>
  )
}

/** What the plan holds, as Tags at the start of the graph's bar. */
function PlanTags({ tags }: { tags: ReactNode[] }) {
  const t = useT()
  return (
    <ul className="plan-map-tags" aria-label={t('projects.map.summary')}>
      {tags.map((tag, i) => (
        <li key={i}>{tag}</li>
      ))}
    </ul>
  )
}

/** Full screen: the map wide, with each part's title and the files on the edges. */
function PlanMapFull({ project, plan, names, roster, label, selected, onSelect }: PlanMapProps) {
  const t = useT()
  const graph = usePlanGraph(project, plan, 'wide', names, roster, t)
  const labels = useGraphLabels()
  return <Graph label={label} width={graph.width} height={graph.height} nodes={graph.nodes} edges={graph.edges} selected={selected} onSelect={onSelect} labels={labels} bar={{ start: <PlanTags tags={graph.tags} /> }} className="plan-map-full" />
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

