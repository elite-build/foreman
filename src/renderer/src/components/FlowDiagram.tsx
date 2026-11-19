// A flow drawn as a graph (docs/loops-and-graphs.md, "Showing a graph"): flowGraph → layoutFlowGraph (where each node
// goes) → the design system's Graph, at a size people can read, with zoom, fit and full screen. A step's kind, who runs
// it and its state are on its card; a run's path is drawn strong and what it didn't reach faint; a loop going round is
// dashed, and named with its bounds by a Tag in the bar above the drawing, beside the zoom, so nothing covers the graph;
// an inferred link (lineage) is dotted; a proposal's parts carry their mark in words. Selecting is optional: the outline
// beside it stays the accessible equivalent and what opens things.
import { Bot, Clock, Database, Eye, FileText, FolderGit2, GitBranch, GitPullRequest, ListChecks, Repeat, Shuffle, Split, SquareTerminal, UserCheck, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { FLOW_STATE_GLYPH, flowGraph, modelWords, type FlowGraph, type FlowGraphNode, type FlowLens, type FlowNodeState } from '../../../shared/flowGraph'
import { layoutFlowGraph, type FlowLayoutDirection } from '../../../shared/flowLayout'
import type { Flow, FlowRun, FlowStepKind } from '../../../shared/flows'
import type { PlainKey } from '../../../shared/i18n'
import { useT, type RendererT } from '../i18n'
import { Dialog, Graph, Tag, type GraphEdge, type GraphLabels, type GraphMark, type GraphNode, type GraphShape, type GraphTone, type TagTone } from '../ui'
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
// A loop's Tag in a proposal: the tone's glyph and colour, with the mark's words in the tag.
const MARK_TONE: Record<GraphMark, TagTone> = { added: 'ok', changed: 'warn', removed: 'error' }

const STATE_GLYPHS = Object.values(FLOW_STATE_GLYPH)

const shapeOf = (n: FlowGraphNode): GraphShape => (n.kind === 'end' ? 'pill' : n.stepKind === 'gate' || n.stepKind === 'pick' || n.stepKind === 'decide' ? 'gate' : n.stepKind === 'checks' || n.stepKind === 'script' ? 'square' : 'card')

/**
 * The line under a node's name: what the lens adds (a context window, a tree) where there is one, else who runs the
 * step. flowGraph's sublabel lines are "· kind · persona · model", then the state, then the lens's line. Top to bottom
 * (a side panel, at 100%) the model is left out so the person fits: the step's card and the Run a flow page say it.
 */
function detailOf(n: FlowGraphNode, lens: FlowLens, direction: FlowLayoutDirection): string | undefined {
  const lines = (n.sublabel ?? '').split('\n').filter(Boolean)
  if (n.kind !== 'step') return lines[0]
  const who = lines.find((l) => l.startsWith('· '))
  const added = lines.filter((l) => !l.startsWith('· ') && !STATE_GLYPHS.some((g) => l.startsWith(g)))
  if ((lens === 'context' || lens === 'data') && added.length) return added.at(-1)
  if (!who) return added[0]
  let parts = who.slice(2).split(' · ')
  if (n.stepKind && parts[0] === n.stepKind) parts = parts.slice(1)
  if (direction === 'tall' && n.model && parts.length > 1 && parts.at(-1) === modelWords(n.model)) parts = parts.slice(0, -1)
  return parts.join(' · ') || undefined
}

/** A loop as the bar above the graph names it: its name, its bounds and how far a run got, and a proposal's mark. */
interface FlowGraphLoopTag {
  name: string
  text: string
  mark?: GraphMark
  markLabel?: string
}

/** The loops, as Tags at the start of the graph's bar (outside the drawing, so the zoom never covers one). */
function LoopTags({ loops }: { loops: FlowGraphLoopTag[] }) {
  const t = useT()
  if (!loops.length) return null
  return (
    <ul className="flow-graph-loops" aria-label={t('flowGraph.loops')}>
      {loops.map((loop) => (
        <li key={loop.name}>
          <Tag mono tone={loop.mark ? MARK_TONE[loop.mark] : 'neutral'}>
            <Repeat size={11} aria-hidden />
            {loop.markLabel ? `${loop.text} · ${loop.markLabel}` : loop.text}
          </Tag>
        </li>
      ))}
    </ul>
  )
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
  // The line under a node's name, by node id ("step:<name>"), instead of who runs it (the Run a flow page's models).
  details?: Record<string, string>
  // The toolbar's full-screen button: by default it opens the graph in a dialog; a function does that instead (the Flow
  // tab puts its run in the workspace's middle), and null leaves the button out (the run already is in the middle).
  fullScreen?: (() => void) | null
  // The canvas as tall as the graph, so the page around it scrolls rather than the graph (the Flow tab).
  grow?: boolean
  className?: string
}

/**
 * The Graph's props for a flow graph: nodes and edges placed by the layout, worded for this locale. `compact` draws it
 * whole in a card: smaller steps, each its name and who runs it, and words only on the edges that branch or go back
 * (the main path reads left to right without them).
 */
export function useFlowGraphProps(graph: FlowGraph, direction: FlowLayoutDirection, start: string | undefined, t: RendererT, details?: Record<string, string>, compact = false) {
  return useMemo(() => {
    // Without its loops the layout places no notes in the drawing: they are Tags in the bar above it.
    const layout = layoutFlowGraph({ ...graph, loops: [] }, { direction, ...(start ? { start } : {}), compact })
    // Compact: who runs a step without its model, as in a side panel.
    const detailDirection: FlowLayoutDirection = compact ? 'tall' : direction
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
        ...(Icon && word && !compact
          ? {
              kicker: (
                <>
                  <Icon size={12} aria-hidden /> {word}
                </>
              )
            }
          : {}),
        ...((details?.[n.id] ?? detailOf(n, graph.lens, detailDirection)) ? { detail: details?.[n.id] ?? detailOf(n, graph.lens, detailDirection) } : {}),
        ...(tone && n.state ? { tone, toneLabel: t(STATE_WORD[n.state]) } : {}),
        ...(n.state === 'not-yet' ? { dim: true } : {}),
        ...(n.runs && n.runs > 1 ? { badge: `×${n.runs}` } : {}),
        ...(n.mark ? { mark: n.mark, markLabel: t(MARK_WORD[n.mark]) } : {})
      }
    })
    const edges: GraphEdge[] = layout.edges.map((le) => {
      const e = graph.edges[le.edge]
      const straight = !le.back && le.from.side === 'right' && le.to.side === 'left'
      return {
        id: `edge:${le.edge}`,
        from: { node: le.from.node, side: le.from.side, offset: le.from.offset },
        to: { node: le.to.node, side: le.to.side, offset: le.to.offset },
        ...(e.label && !(compact && straight) ? { label: e.label } : {}),
        line: e.reconstructed ? 'dotted' : le.back ? 'dashed' : 'solid',
        ...(e.taken === true ? { weight: 'strong' as const } : e.taken === false ? { weight: 'faint' as const } : {}),
        ...(e.mark ? { mark: e.mark, markLabel: t(MARK_WORD[e.mark]) } : {})
      }
    })
    // The loops that span a drawn step, as the bar names them: "fix-until-green · iteration 2 of at most 4 · 9 of 45 min".
    const drawn = new Set(nodes.map((n) => n.id))
    const loops: FlowGraphLoopTag[] = graph.loops
      .filter((loop) => loop.over.some((s) => drawn.has(`step:${s}`)))
      .map((loop) => ({ name: loop.name, text: loop.title, ...(loop.mark ? { mark: loop.mark, markLabel: t(MARK_WORD[loop.mark]) } : {}) }))
    return { width: layout.width, height: layout.height, nodes, edges, loops }
  }, [graph, direction, start, t, details, compact])
}

/** The toolbar's words. */
export function useGraphLabels(): GraphLabels {
  const t = useT()
  return useMemo(() => {
    const percent = new Intl.NumberFormat(t.locale, { style: 'percent', maximumFractionDigits: 0 })
    return { zoomIn: t('flowGraph.zoomIn'), zoomOut: t('flowGraph.zoomOut'), fit: t('flowGraph.fit'), fullScreen: t('flowGraph.fullScreen'), zoomValue: (p: number) => percent.format(p / 100) }
  }, [t])
}

/**
 * A flow graph as the design system's Graph, with its loops and the zoom in a bar above the drawing, and a full-screen
 * view that opens in a dialog unless `fullScreen` says.
 */
export function FlowGraphView({ graph, direction = 'wide', start, selected, onSelect, selectableEdges, thumbnail, details, fullScreen, grow, className }: FlowGraphViewProps) {
  const t = useT()
  const { loops, ...props } = useFlowGraphProps(graph, direction, start, t, details)
  const labels = useGraphLabels()
  const [full, setFull] = useState(false)
  // It opens at 100%, the smallest zoom whose words are still 11px, and scrolls; it never shrinks to fit (the words would
  // go to 7-8px). Once the toolbar (or Ctrl + wheel) sets a zoom, that holds, so an inspector opening beside it, or a
  // step being selected, doesn't change it: Graph keeps the selected step in view instead.
  const [chosen, setChosen] = useState<number | 'fit' | null>(null)
  const zoom = chosen ?? 1
  if (thumbnail) return <Graph {...props} label={graph.title} thumbnail className={className} />
  const loopTags = loops.length ? <LoopTags loops={loops} /> : undefined
  return (
    <>
      <Graph
        {...props}
        label={graph.title}
        labels={labels}
        zoom={zoom}
        onZoomChange={setChosen}
        onFullScreen={fullScreen === null ? undefined : (fullScreen ?? (() => setFull(true)))}
        bar={{ start: loopTags, grow }}
        selected={selected}
        onSelect={onSelect}
        selectableEdges={selectableEdges}
        className={['flow-graph', grow && 'flow-graph-grow', className].filter(Boolean).join(' ')}
      />
      {full && (
        <Dialog title={graph.title} onClose={() => setFull(false)} size="xl" closeOnBackdrop>
          <Graph {...props} label={graph.title} labels={labels} bar={{ start: loopTags }} selected={selected} onSelect={onSelect} selectableEdges={selectableEdges} className="flow-graph-full" />
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
  details,
  fullScreen,
  grow,
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
  details?: Record<string, string>
  fullScreen?: (() => void) | null
  grow?: boolean
  className?: string
}) {
  const t = useT()
  const graph = useMemo(() => flowGraph(flow, run, lens, { t, locale: t.locale, workspaceNames }), [flow, run, lens, t, workspaceNames])
  const start = flow?.start ? `step:${flow.start}` : run?.steps[0] ? `step:${run.steps[0].name}` : undefined
  return <FlowGraphView graph={graph} direction={direction === 'TB' ? 'tall' : 'wide'} start={start} selected={selected} onSelect={onSelect} thumbnail={thumbnail} details={details} fullScreen={fullScreen} grow={grow} className={className} />
}

/**
 * A flow drawn whole as a picture in a card (Automations' flows list): the compact layout fitted to the card's width,
 * as tall as it needs, with no toolbar. With a run going, its step is drawn in its state. The card around it says the
 * rest in words, and opens the flow.
 */
export function FlowPicture({ flow, run, label, className }: { flow: Flow; run?: FlowRun; label: string; className?: string }) {
  const t = useT()
  const graph = useMemo(() => flowGraph(flow, run, 'run', { t, locale: t.locale }), [flow, run, t])
  const { width, height, nodes, edges } = useFlowGraphProps(graph, 'wide', `step:${flow.start}`, t, undefined, true)
  return <Graph width={width} height={height} nodes={nodes} edges={edges} label={label} zoom="fit" bar={{ grow: true }} className={['flow-picture', className].filter(Boolean).join(' ')} />
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
