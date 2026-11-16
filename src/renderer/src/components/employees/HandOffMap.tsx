// Hand-offs outside projects, on the Team page (docs/ai-employees.md §7, §15). A project draws its plan in its own
// channel; work one employee hands to another outside any project (Max asks Ada what changed, then asks to push) has no
// channel, so it is drawn here, a map per chain: what started it, each task to the right of the task that handed it
// over (owner, title, state in a glyph and a word), the result going back, and each held action under the task that
// asked for it. Selecting a task or an action opens what waits for you on it, as the same one-line decision as in the
// employee's column; nothing on the map decides anything. Open while something in it waits for you.
import { Flag } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { EmployeeSummary } from '../../../../shared/employees'
import type { EmployeeRootLedger, EmployeeTask } from '../../../../shared/employeeWork'
import { handoffChains, layoutChain, START_NODE } from '../../../../shared/handoffMap'
import { timeAgo } from '../../../../shared/i18n/time'
import { useT, type RendererT } from '../../i18n'
import { api, openEmployees, useStore } from '../../store'
import { Button, Disclosure, Graph, HardHat, Status, Tag, type GraphEdge, type GraphNode, type GraphTone, type HardHatColour } from '../../ui'
import { useGraphLabels } from '../FlowDiagram'
import { DecisionRows, useDecisionItems, type DecisionItem } from './EmployeeDecisions'
import { actionKindWord } from './HeldActions'
import { ACTION_STATE_LABEL, actionNoun, taskWord } from './words'
import './employees.css'

type ActionItem = Extract<DecisionItem, { kind: 'action' }>

const actionNode = (id: string) => `action:${id}`
const basename = (path: string) => path.split('/').pop() || path

/** A task's state as the map draws it: running spins, what waits for a person is ▲, done is ●. */
function taskTone(task: EmployeeTask): GraphTone {
  if (task.state === 'running') return 'running'
  const tone = taskWord(task).tone
  return tone === 'ok' ? 'ok' : tone === 'error' ? 'error' : tone === 'warn' ? 'waiting' : 'off'
}

/** The chain's Graph: nodes, edges and the size, from the layout. */
function useChainGraph(chain: EmployeeTask[], actions: ActionItem[], roster: readonly EmployeeSummary[] | undefined, t: RendererT) {
  return useMemo(() => {
    const root = chain[0]
    const start = root.from === 'person' ? t('projects.you') : root.from === 'schedule' ? t('employees.handoffs.schedule') : root.from === 'event' ? t('employees.handoffs.event') : ''
    const results = chain.filter((c) => c.parentId && c.state === 'closed' && (c.closureReason ?? 'done') === 'done').map((c) => c.id)
    const layout = layoutChain({
      start: Boolean(start),
      tasks: chain.map((c) => ({ id: c.id, parentId: c.parentId })),
      actions: actions.map((a) => ({ id: actionNode(a.action.id), taskId: a.action.taskId })),
      results
    })
    const byTask = new Map(chain.map((c) => [c.id, c]))
    const byAction = new Map(actions.map((a) => [actionNode(a.action.id), a]))
    const person = (id: string) => roster?.find((e) => e.id === id)
    const nodes: GraphNode[] = layout.boxes.map((b) => {
      const base = { id: b.id, x: b.x, y: b.y, width: b.width, height: b.height }
      if (b.kind === 'start') return { ...base, shape: 'pill' as const, title: start }
      const action = byAction.get(b.id)
      if (action) {
        const word = t(ACTION_STATE_LABEL[action.action.state])
        const kind = actionKindWord(action.action.payload, t)
        const title = actionNoun(action.action.payload, t)
        return {
          ...base,
          shape: 'gate' as const,
          title,
          kicker: t('employees.handoffs.heldKind', { kind }),
          detail: `${word} · ${timeAgo(action.action.createdAt, t.locale)}`,
          tone: action.action.state === 'failed' ? ('error' as const) : ('waiting' as const),
          toneLabel: word,
          label: [title, t('employees.handoffs.heldKind', { kind }), word].join(', ')
        }
      }
      const task = byTask.get(b.id)!
      const e = person(task.employeeId)
      const name = e?.name || task.employeeId
      const word = t(taskWord(task).label)
      return {
        ...base,
        title: task.title,
        kicker: (
          <>
            <HardHat colour={(e?.colour ?? 'slate') as HardHatColour} size={12} /> {[name, e?.role].filter(Boolean).join(' · ')}
          </>
        ),
        detail: `${word} · ${timeAgo(task.updatedAt, t.locale)}`,
        tone: taskTone(task),
        toneLabel: word,
        label: [task.title, name, word].join(', ')
      }
    })
    const edges: GraphEdge[] = layout.edges.map((e) => {
      const ends = { id: `edge:${e.id}`, from: e.from, to: e.to }
      if (e.kind === 'start') return { ...ends, label: t('employees.handoffs.asked', { ago: timeAgo(root.createdAt, t.locale) }) }
      if (e.kind === 'handoff') {
        const child = byTask.get(e.to.node)
        return { ...ends, label: child ? t('employees.handoffs.handedOff', { ago: timeAgo(child.createdAt, t.locale) }) : undefined, weight: 'strong' as const }
      }
      if (e.kind === 'result') {
        const file = byTask.get(e.from.node)?.result?.artifacts?.[0]
        return { ...ends, line: 'dashed' as const, label: file ? t('employees.handoffs.resultFile', { file: basename(file) }) : t('employees.handoffs.result') }
      }
      return { ...ends, label: t('employees.handoffs.held') }
    })
    return { width: layout.width, height: layout.height, nodes, edges, start: START_NODE }
  }, [chain, actions, roster, t])
}

/** The Team page's section: one map per chain of hand-offs outside projects, open or changed in the last day. */
export function HandOffs({ orgId }: { orgId: string }) {
  const t = useT()
  const revision = useStore((s) => s.snapshot!.employeeWork?.[orgId]?.revision)
  const ledgers = useStore((s) => s.snapshot!.employeeWork?.[orgId]?.roots)
  const roster = useStore((s) => s.snapshot!.employees?.[orgId]?.employees)
  const items = useDecisionItems(orgId)
  const [tasks, setTasks] = useState<EmployeeTask[] | null>(null)
  const [open, setOpen] = useState<boolean | null>(null)
  // The snapshot carries only work not yet over; the chains closed in the last day come from the task list, read again
  // whenever the organization's work moves.
  useEffect(() => {
    let live = true
    api.listEmployeeTasks(orgId).then(
      (list) => live && setTasks(list),
      () => live && setTasks([])
    )
    return () => {
      live = false
    }
  }, [orgId, revision])
  const chains = useMemo(() => (tasks ? handoffChains(tasks, Date.now()) : []), [tasks])
  if (!chains.length) return null
  const inChain = (chain: EmployeeTask[]) => {
    const ids = new Set(chain.map((c) => c.id))
    return items.filter((i) => (i.kind === 'action' ? ids.has(i.action.taskId) : i.kind === 'question' || i.kind === 'task' ? ids.has(i.task.id) : false))
  }
  const waiting = chains.some((c) => inChain(c).length > 0)
  return (
    <section className="team-handoffs" aria-label={t('employees.handoffs.heading')}>
      <Disclosure
        open={open ?? waiting}
        onOpenChange={setOpen}
        label={
          <span className="team-handoffs-head">
            <span className="employee-subheading">{t('employees.handoffs.heading')}</span>{' '}
            <span className="employee-faint">· {chains.length}</span>
          </span>
        }
      >
        <div className="team-handoffs-body">
          <p className="employee-faint">{t('employees.handoffs.about')}</p>
          {chains.map((chain) => (
            <ChainMap key={chain[0].rootId} orgId={orgId} chain={chain} items={inChain(chain)} roster={roster} ledger={ledgers?.[chain[0].rootId]} />
          ))}
        </div>
      </Disclosure>
    </section>
  )
}

/** One chain as a map, with what it holds in the bar above, and what waits for you on the selected task or action under it. */
function ChainMap({ orgId, chain, items, roster, ledger }: { orgId: string; chain: EmployeeTask[]; items: DecisionItem[]; roster?: EmployeeSummary[]; ledger?: EmployeeRootLedger }) {
  const t = useT()
  const actions = items.filter((i): i is ActionItem => i.kind === 'action')
  const graph = useChainGraph(chain, actions, roster, t)
  const labels = useGraphLabels()
  const [zoom, setZoom] = useState<number | 'fit'>(1)
  const [selected, setSelected] = useState<string | null>(null)
  const root = chain[0]
  const bar = (
    <span className="team-handoffs-bar">
      <Flag size={12} aria-hidden /> <span>{root.title}</span>
      {ledger && <span className="employee-faint">{t('employees.handoffs.runs', { used: ledger.runsUsed, allowed: ledger.runsAllowed })}</span>}
      {items.length > 0 && <Tag tone="warn">{t('employees.needsYou.count', { count: items.length })}</Tag>}
    </span>
  )
  const action = selected ? actions.find((a) => actionNode(a.action.id) === selected) : undefined
  const task = selected && !action ? chain.find((c) => c.id === selected) : undefined
  const decisions = action ? [action] : task ? items.filter((i) => (i.kind === 'question' || i.kind === 'task') && i.task.id === task.id) : []
  const owner = task ? roster?.find((e) => e.id === task.employeeId) : undefined
  return (
    <div className="team-handoffs-chain">
      <Graph
        label={t('employees.handoffs.chain', { title: root.title })}
        width={graph.width}
        height={graph.height}
        nodes={graph.nodes}
        edges={graph.edges}
        selected={selected}
        onSelect={(id) => setSelected(id === graph.start ? null : id)}
        labels={labels}
        zoom={zoom}
        onZoomChange={setZoom}
        bar={{ start: bar, grow: true }}
      />
      {decisions.length > 0 && <DecisionRows orgId={orgId} items={decisions} label={t('employees.handoffs.decisions', { title: root.title })} openFirst />}
      {task && !decisions.length && (
        <div className="team-handoffs-task">
          <Status tone={taskWord(task).tone} label={t(taskWord(task).label)} />
          <span>{task.title}</span>
          {owner && (
            <Button size="sm" onClick={() => openEmployees({ orgId, page: 'employee', id: owner.id })}>
              {t('employees.handoffs.open', { name: owner.name || owner.id })}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
