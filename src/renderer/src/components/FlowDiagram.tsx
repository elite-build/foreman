// A flow drawn as a diagram (docs/loops-and-graphs.md, "Showing a graph"): flowGraph → flowMermaid → the chat's Mermaid
// renderer (MermaidBlock's useMermaid, so the same cache, theme and limits), read-only. While it renders a Spinner, when
// it can't a Callout saying why; the source's accTitle gives the SVG its <title>, and the picture is labelled with the
// flow and lens. The outline beside it (the step list) is the accessible equivalent, so nothing here is interactive.
import { useEffect, useMemo, useState } from 'react'
import { flowGraph, flowMermaid, type FlowLens, type FlowMermaidDirection } from '../../../shared/flowGraph'
import type { Flow, FlowRun } from '../../../shared/flows'
import { useT } from '../i18n'
import { Callout, Card, Spinner } from '../ui'
import { DiagramView, mermaidFailure, useMermaid } from './MermaidBlock'
import './flowRun.css'

/** The diagram of `source`, labelled `label`. */
export function FlowDiagram({ source, label, className }: { source: string; label: string; className?: string }) {
  const t = useT()
  const { result, check } = useMermaid(source, true)
  const failure = mermaidFailure(t, true, check, result)
  return (
    <Card className={['flow-diagram', className].filter(Boolean).join(' ')}>
      {failure !== null ? (
        <Callout tone="warn" role="status" title={t('mermaid.failed')}>
          {failure}
        </Callout>
      ) : result?.ok ? (
        <DiagramView svg={result.svg} label={label} />
      ) : (
        <Spinner label={t('mermaid.rendering')} />
      )}
    </Card>
  )
}

/**
 * A flow (and a run of it) through one lens, as a diagram: the Mermaid source, kept steady while nothing changes.
 * `direction`: TB in the side panel (it scrolls down; left to right it shrinks to a strip), LR where it is wide.
 */
export function FlowLensDiagram({ flow, run, lens, workspaceNames, direction = 'LR' }: { flow?: Flow; run?: FlowRun; lens: FlowLens; workspaceNames?: Record<string, string>; direction?: FlowMermaidDirection }) {
  const t = useT()
  const graph = useMemo(() => flowGraph(flow, run, lens, { t, locale: t.locale, workspaceNames }), [flow, run, lens, t, workspaceNames])
  const source = useMemo(() => flowMermaid(graph, { direction }), [graph, direction])
  return <FlowDiagram source={source} label={graph.title} />
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
