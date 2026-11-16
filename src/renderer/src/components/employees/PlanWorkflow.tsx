// A plan drawn as its workflow (docs/ai-employees.md §15), with the design system's Graph: your request, the program
// manager's questions, each part with its owner and the file it writes, your check after each part that has one, then
// her acceptance and your final check for a large plan, and the end, left to right in the order things happen, each
// check under what it checks (planWorkflow in shared/projects.ts places them; plan.md draws the same as a Mermaid
// flowchart). Once the plan is in effect each part shows its state. A picture that scrolls, with full screen for a wide
// one: the order and the parts table under it say the same in words.
import { CircleCheck, FileText, MessageCircleQuestion, User } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ownerId, ownerName, planWorkflow, type PartStatus, type ProjectPlan } from '../../../../shared/projects'
import type { EmployeeSummary } from '../../../../shared/employees'
import { useT } from '../../i18n'
import { Dialog, Graph, HardHat, type GraphEdge, type GraphNode, type GraphTone, type HardHatColour } from '../../ui'
import { useGraphLabels } from '../FlowDiagram'
import { PART_STATUS } from './projectWords'

const CARD = { width: 188, height: 64 }
const PILL = { width: 132, height: 36 }
const COLUMN = CARD.width + 52
const ROW = CARD.height + 24

const TONE: Record<PartStatus['state'], GraphTone | undefined> = { pending: undefined, running: 'running', gate: 'waiting', done: 'ok', stuck: 'error' }

export function PlanWorkflow({
  plan,
  questions,
  parts,
  names,
  roster,
  pmName
}: {
  plan: ProjectPlan
  // How many questions the person answered before it (0: she asked none).
  questions: number
  // The parts' states, once the plan is in effect.
  parts?: Record<string, PartStatus>
  names: Record<string, string>
  roster?: EmployeeSummary[]
  pmName: string
}) {
  const t = useT()
  const labels = useGraphLabels()
  const [full, setFull] = useState(false)
  const drawn = useMemo(() => {
    const flow = planWorkflow(plan, { questions: questions > 0 })
    const height = flow.rows * ROW
    const inColumn = new Map<number, number>()
    for (const s of flow.steps) inColumn.set(s.column, (inColumn.get(s.column) ?? 0) + 1)
    const nodes: GraphNode[] = flow.steps.map((s) => {
      const part = s.partId ? plan.parts.find((p) => p.id === s.partId) : undefined
      const pill = s.kind === 'request' || s.kind === 'end'
      const size = pill ? PILL : CARD
      const top = (height - (inColumn.get(s.column) ?? 1) * ROW) / 2 + s.row * ROW + (ROW - size.height) / 2
      const box = { id: s.id, x: s.column * COLUMN + (CARD.width - size.width) / 2, y: top, ...size }
      switch (s.kind) {
        case 'request':
          return { ...box, shape: 'pill', title: t('projects.workflow.request') }
        case 'end':
          return { ...box, shape: 'pill', title: t('projects.workflow.end') }
        case 'questions':
          return {
            ...box,
            kicker: (
              <>
                <MessageCircleQuestion size={12} aria-hidden /> {pmName}
              </>
            ),
            title: t('projects.workflow.questions'),
            detail: t('projects.workflow.answered', { count: questions })
          }
        case 'part': {
          const owner = part ? ownerName(plan, part.owner, names) : ''
          const colour = (part && roster?.find((e) => e.id === ownerId(plan, part.owner))?.colour) || 'slate'
          const state = part && parts ? (parts[part.id]?.state ?? 'pending') : undefined
          const tone = state ? TONE[state] : undefined
          return {
            ...box,
            kicker: (
              <>
                <HardHat colour={colour as HardHatColour} size={12} /> {owner}
              </>
            ),
            title: part?.title ?? s.partId ?? '',
            detail: part?.writes ?? '',
            ...(tone && state ? { tone, toneLabel: t(PART_STATUS[state].label) } : {})
          }
        }
        case 'check':
          return {
            ...box,
            shape: 'gate',
            kicker: (
              <>
                <User size={12} aria-hidden /> {t('projects.you')}
              </>
            ),
            title: t('projects.workflow.check'),
            detail: part?.title ?? ''
          }
        case 'accept':
          return {
            ...box,
            kicker: (
              <>
                <FileText size={12} aria-hidden /> {pmName}
              </>
            ),
            title: t('projects.workflow.accept'),
            detail: 'acceptance.md'
          }
        case 'final':
          return {
            ...box,
            shape: 'gate',
            kicker: (
              <>
                <CircleCheck size={12} aria-hidden /> {t('projects.you')}
              </>
            ),
            title: t('projects.workflow.final')
          }
      }
    })
    // A check stands under what it checks: the way between them goes down; every other way goes right.
    const column = new Map(flow.steps.map((s) => [s.id, s.column]))
    const edges: GraphEdge[] = flow.links.map((l, i) =>
      column.get(l.from) === column.get(l.to) ? { id: `link:${i}`, from: { node: l.from, side: 'bottom' }, to: { node: l.to, side: 'top' } } : { id: `link:${i}`, from: { node: l.from, side: 'right' }, to: { node: l.to, side: 'left' } }
    )
    return { nodes, edges, width: flow.columns * COLUMN - (COLUMN - CARD.width), height }
  }, [plan, questions, parts, names, roster, pmName, t])
  const label = t('projects.workflow.label', { version: plan.version })
  return (
    <>
      <Graph label={label} labels={labels} bar={{}} onFullScreen={() => setFull(true)} className="channel-workflow" {...drawn} />
      {full && (
        <Dialog title={label} onClose={() => setFull(false)} size="xl" closeOnBackdrop>
          <Graph label={label} labels={labels} bar={{}} className="flow-graph-full" {...drawn} />
        </Dialog>
      )}
    </>
  )
}
