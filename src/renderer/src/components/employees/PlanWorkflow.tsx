// A plan drawn as its workflow (docs/ai-employees.md §15), with the design system's Graph: your request, the program
// manager's questions, each part with its owner and the file it writes, your check after each part that has one, then
// her acceptance and your final check for a large plan, and the end, top to bottom in the order things happen, with
// what runs at the same time side by side (planWorkflow in shared/projects.ts places them; plan.md draws the same as a
// Mermaid flowchart). Top to bottom because a channel is narrow and scrolls down: the drawing is as tall as it needs and
// the page scrolls, never the drawing. Once the plan is in effect each part shows its state. A picture: the order and
// the parts table under it say the same in words.
import { CircleCheck, FileText, MessageCircleQuestion, User } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ownerId, ownerName, planWorkflow, type PartStatus, type ProjectPlan } from '../../../../shared/projects'
import type { EmployeeSummary } from '../../../../shared/employees'
import { useT } from '../../i18n'
import { Dialog, Graph, HardHat, type GraphEdge, type GraphNode, type GraphTone, type HardHatColour } from '../../ui'
import { useGraphLabels } from '../FlowDiagram'
import { PART_STATUS, partLook, type PartLook } from './projectWords'

const CARD = { width: 180, height: 60 }
const PILL = { width: 132, height: 34 }
const LANE = CARD.width + 24
const STAGE = CARD.height + 36

const TONE: Record<PartLook, GraphTone | undefined> = { pending: undefined, running: 'running', gate: 'waiting', done: 'ok', stuck: 'error', stopped: 'off', replan: 'waiting' }

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
    const width = flow.lanes * LANE - (LANE - CARD.width)
    const inStage = new Map<number, number>()
    for (const s of flow.steps) inStage.set(s.stage, (inStage.get(s.stage) ?? 0) + 1)
    const nodes: GraphNode[] = flow.steps.map((s) => {
      const part = s.partId ? plan.parts.find((p) => p.id === s.partId) : undefined
      const pill = s.kind === 'request' || s.kind === 'end'
      const size = pill ? PILL : CARD
      // Each stage's steps side by side, the stage centred.
      const left = (width - ((inStage.get(s.stage) ?? 1) * LANE - (LANE - CARD.width))) / 2
      const box = { id: s.id, x: left + s.lane * LANE + (CARD.width - size.width) / 2, y: s.stage * STAGE + (CARD.height - size.height) / 2, ...size }
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
          const state = part && parts ? partLook(parts[part.id] ?? { state: 'pending' }) : undefined
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
    const edges: GraphEdge[] = flow.links.map((l, i) => ({ id: `link:${i}`, from: { node: l.from, side: 'bottom' }, to: { node: l.to, side: 'top' } }))
    return { nodes, edges, width, height: flow.stages * STAGE - (STAGE - CARD.height) }
  }, [plan, questions, parts, names, roster, pmName, t])
  const label = t('projects.workflow.label', { version: plan.version })
  return (
    <>
      <Graph label={label} labels={labels} bar={{ grow: true }} onFullScreen={() => setFull(true)} className="channel-workflow" {...drawn} />
      {full && (
        <Dialog title={label} onClose={() => setFull(false)} size="xl" closeOnBackdrop>
          <Graph label={label} labels={labels} bar={{}} className="flow-graph-full" {...drawn} />
        </Dialog>
      )}
    </>
  )
}
