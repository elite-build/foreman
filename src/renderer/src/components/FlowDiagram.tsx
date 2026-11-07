// A flow drawn as a graph (docs/loops-and-graphs.md, "Showing a graph"): flowGraph → layoutFlowGraph (where each node
// goes) → the design system's Graph, at a size people can read, with zoom, fit and full screen. A step's kind, who runs
// it and its state are on its card; a run's path is drawn strong and what it didn't reach faint; a loop going round is
// dashed and named by a note with its bounds; an inferred link (lineage) is dotted; a proposal's parts carry their mark
// in words. Selecting is optional: the outline beside it stays the accessible equivalent and what opens things.
import { Bot, Clock, Database, Eye, FileText, FolderGit2, GitBranch, GitPullRequest, ListChecks, Repeat, Shuffle, Split, SquareTerminal, UserCheck, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { FLOW_STATE_GLYPH, flowGraph, type FlowGraph, type FlowGraphNode, type FlowLens, type FlowNodeState } from '../../../shared/flowGraph'
import { layoutFlowGraph, type FlowLayoutDirection } from '../../../shared/flowLayout'
import type { Flow, FlowRun, FlowStepKind } from '../../../shared/flows'
import type { PlainKey } from '../../../shared/i18n'
import { useT, type RendererT } from '../i18n'
import { Dialog, Graph, type GraphEdge, type GraphLabels, type GraphMark, type GraphNode, type GraphNote, type GraphShape, type GraphTone } from '../ui'
import { STEP_KIND } from './automations/flowRunWords'
import './flowRun.css'

const KIND_ICON: Record<FlowStepKind, LucideIcon> = { turn: Bot, review: Eye, checks: ListChecks, gate: UserCheck, script: SquareTerminal, decide: Split, workspace: FolderGit2, wait: Clock, pick: Shuffle, pr: GitPullRequest }
const NODE_ICON: Record<Exclude<FlowGraphNode['kind'], 'step' | 'end'>, LucideIcon> = { source: FileText, memory: Database, tree: GitBranch }
const NODE_WORD: Record<Exclude<FlowGraphNode['kind'], 'step' | 'end'>, PlainKey> = { source: 'flowGraph.node.source', memory: 'flowGraph.node.memory', tree: 'flowGraph.node.tree' }

const TONE: Record<FlowNodeState, GraphTone> = { completed: 'ok', running: 'running', waiting: 'waiting', failed: 'error', stopped: 'off', 'not-yet': 'off' }
const STATE_WORD: Record<FlowNodeState, PlainKey> = {
  completed: 'flowGraph.state.completed',
  running: 'flowGraph.state.running',
  waiting: 'flowGraph.state.waiting',
  failed: 'flowGraph.state.failed',
  stopped: 'flowGraph.state.stopped',
  'not-yet': 'flowGraph.state.notYet'
}
const MARK_WORD: Record<GraphMark, PlainKey> = { added: 'flowGraph.mark.added', changed: 'flowGraph.mark.changed', removed: 'flowGraph.mark.removed' }

const STATE_GLYPHS = Object.values(FLOW_STATE_GLYPH)

const shapeOf = (n: FlowGraphNode): GraphShape => (n.kind === 'end' ? 'pill' : n.stepKind === 'gate' || n.stepKind === 'pick' || n.stepKind === 'decide' ? 'gate' : n.stepKind === 'checks' || n.stepKind === 'script' ? 'square' : 'card')

/**
 * The line under a node's name: what the lens adds (a context window, a tree) where there is one, else who runs the
 * step. flowGraph's sublabel lines are "· kind · persona · model", then the state, then the lens's line.
 */
function detailOf(n: FlowGraphNode, lens: FlowLens): string | undefined {
  const lines = (n.sublabel ?? '').split('\n').filter(Boolean)
  if (n.kind !== 'step') return lines[0]
  const who = lines.find((l) => l.startsWith('· '))
  const added = lines.filter((l) => !l.startsWith('· ') && !STATE_GLYPHS.some((g) => l.startsWith(g)))
  if ((lens === 'context' || lens === 'data') && added.length) return added.at(-1)
  if (!who) return added[0]
  const parts = who.slice(2).split(' · ')
  return (n.stepKind && parts[0] === n.stepKind ? parts.slice(1) : parts).join(' · ') || undefined
}

export interface FlowGraphViewProps {
  graph: FlowGraph
  direction?: FlowLayoutDirection
  // The node the path starts from (a flow's start step), for the layout.
  start?: string
  selected?: string | null
  onSelect?: (id: string | null) => void
  // Exits can be selected too (the flow studio's inspector).
  selectableEdges?: boolean
  // A tiny picture with no text (the flows list's cards).
  thumbnail?: boolean
  className?: string
}

/** The Graph's props for a flow graph: nodes and edges placed by the layout, worded for this locale. */
export function useFlowGraphProps(graph: FlowGraph, direction: FlowLayoutDirection, start: string | undefined, t: RendererT) {
  return useMemo(() => {
    const layout = layoutFlowGraph(graph, { direction, ...(start ? { start } : {}) })
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    const nodes: GraphNode[] = layout.nodes.map((box) => {
      const n = byId.get(box.of)!
      const Icon = n.kind === 'step' ? (n.stepKind ? KIND_ICON[n.stepKind] : Bot) : n.kind === 'end' ? undefined : NODE_ICON[n.kind]
      const word = n.kind === 'step' ? (n.stepKind ? t(STEP_KIND[n.stepKind]) : undefined) : n.kind === 'end' ? undefined : t(NODE_WORD[n.kind])
      const tone = n.state ? TONE[n.state] : undefined
      return {
        id: box.id,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        shape: shapeOf(n),
        title: n.label,
        ...(Icon && word
          ? {
              kicker: (
                <>
                  <Icon size={12} aria-hidden /> {word}
                </>
              )
            }
          : {}),
        ...(detailOf(n, graph.lens) ? { detail: detailOf(n, graph.lens) } : {}),
        ...(tone && n.state ? { tone, toneLabel: t(STATE_WORD[n.state]) } : {}),
        ...(n.state === 'not-yet' ? { dim: true } : {}),
        ...(n.runs && n.runs > 1 ? { badge: `×${n.runs}` } : {}),
        ...(n.mark ? { mark: n.mark, markLabel: t(MARK_WORD[n.mark]) } : {})
      }
    })
    const edges: GraphEdge[] = layout.edges.map((le) => {
      const e = graph.edges[le.edge]
      return {
        id: `edge:${le.edge}`,
        from: { node: le.from.node, side: le.from.side, offset: le.from.offset },
        to: { node: le.to.node, side: le.to.side, offset: le.to.offset },
        ...(e.label ? { label: e.label } : {}),
        line: e.reconstructed ? 'dotted' : le.back ? 'dashed' : 'solid',
        ...(e.taken === true ? { weight: 'strong' as const } : e.taken === false ? { weight: 'faint' as const } : {}),
        ...(e.mark ? { mark: e.mark, markLabel: t(MARK_WORD[e.mark]) } : {})
      }
    })
    const notes: GraphNote[] = layout.notes.map((ln) => {
      const loop = graph.loops.find((l) => l.name === ln.loop)!
      const detail = loop.title.startsWith(`${loop.name} · `) ? loop.title.slice(loop.name.length + 3) : undefined
      return {
        id: `loop:${loop.name}`,
        x: ln.x,
        y: ln.y,
        width: ln.width,
        title: loop.name,
        icon: <Repeat size={12} />,
        ...(detail ? { detail } : {}),
        ...(loop.mark ? { mark: loop.mark, markLabel: t(MARK_WORD[loop.mark]) } : {})
      }
    })
    return { width: layout.width, height: layout.height, nodes, edges, notes }
  }, [graph, direction, start, t])
}

/** The toolbar's words. */
export function useGraphLabels(): GraphLabels {
  const t = useT()
  return useMemo(() => {
    const percent = new Intl.NumberFormat(t.locale, { style: 'percent', maximumFractionDigits: 0 })
    return { zoomIn: t('flowGraph.zoomIn'), zoomOut: t('flowGraph.zoomOut'), fit: t('flowGraph.fit'), fullScreen: t('flowGraph.fullScreen'), zoomValue: (p: number) => percent.format(p / 100) }
  }, [t])
}

// The smallest zoom a graph starts fitted at: below it the words get too small to read, so it starts at 100% and scrolls.
const FIT_AT_LEAST = 0.7

/** A flow graph as the design system's Graph, with a full-screen view that opens in a dialog. */
export function FlowGraphView({ graph, direction = 'wide', start, selected, onSelect, selectableEdges, thumbnail, className }: FlowGraphViewProps) {
  const t = useT()
  const props = useFlowGraphProps(graph, direction, start, t)
  const labels = useGraphLabels()
  const [full, setFull] = useState(false)
  // The zoom follows the width while that keeps the words readable, else 100% and it scrolls; once the toolbar (or
  // Ctrl + wheel) sets a zoom, that holds. The width is the graph's own, watched, so a panel opening beside it counts.
  const [chosen, setChosen] = useState<number | 'fit' | null>(null)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!box || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(box)
    return () => observer.disconnect()
  }, [box])
  // The selected step stays in view when the graph narrows (an inspector opening beside it) or the selection moves.
  useEffect(() => {
    if (!box || !selected) return
    box.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [box, selected, width])
  const fitsReadably = width <= 0 || props.width <= 0 || (width - 40) / props.width >= FIT_AT_LEAST
  const zoom = chosen ?? (fitsReadably ? 'fit' : 1)
  if (thumbnail) return <Graph {...props} label={graph.title} thumbnail className={className} />
  return (
    <>
      <Graph
        {...props}
        ref={setBox}
        label={graph.title}
        labels={labels}
        zoom={zoom}
        onZoomChange={setChosen}
        onFullScreen={() => setFull(true)}
        selected={selected}
        onSelect={onSelect}
        selectableEdges={selectableEdges}
        className={['flow-graph', className].filter(Boolean).join(' ')}
      />
      {full && (
        <Dialog title={graph.title} onClose={() => setFull(false)} size="xl" closeOnBackdrop>
          <Graph {...props} label={graph.title} labels={labels} selected={selected} onSelect={onSelect} selectableEdges={selectableEdges} className="flow-graph-full" />
        </Dialog>
      )}
    </>
  )
}

/**
 * A flow (and a run of it) through one lens, as a graph. `direction`: TB in the side panel (it scrolls down), LR where
 * it is wide.
 */
export function FlowLensDiagram({
  flow,
  run,
  lens,
  workspaceNames,
  direction = 'LR',
  selected,
  onSelect,
  thumbnail,
  className
}: {
  flow?: Flow
  run?: FlowRun
  lens: FlowLens
  workspaceNames?: Record<string, string>
  direction?: 'LR' | 'TB'
  selected?: string | null
  onSelect?: (id: string | null) => void
  thumbnail?: boolean
  className?: string
}) {
  const t = useT()
  const graph = useMemo(() => flowGraph(flow, run, lens, { t, locale: t.locale, workspaceNames }), [flow, run, lens, t, workspaceNames])
  const start = flow?.start ? `step:${flow.start}` : run?.steps[0] ? `step:${run.steps[0].name}` : undefined
  return <FlowGraphView graph={graph} direction={direction === 'TB' ? 'tall' : 'wide'} start={start} selected={selected} onSelect={onSelect} thumbnail={thumbnail} className={className} />
}

/** `value`, once it has stayed the same for `ms` (a flow being typed is drawn when the typing pauses). */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}
