import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type Ref } from 'react'
import { Maximize2, Scan, ZoomIn, ZoomOut } from 'lucide-react'
import { Glyph, type GlyphName } from './Glyph'
import { IconButton } from './IconButton'
import { Spinner } from './Spinner'

// A drawn graph of steps and the ways between them (a flow, a run, a lineage). It lays nothing out: the caller gives
// every node its position and size in graph units, and every edge the sides it leaves and enters by. The component
// scales the picture (zoom 1 is 1px per unit), draws the edges as curves with arrowheads in an SVG layer, and the nodes,
// edge labels and notes as HTML over it, so a node is a real button with native focus when the graph is interactive.
//
// Interactive (onSelect given): one tab stop with a roving focus over the nodes (and the edges, with selectableEdges).
// Arrows move to the nearest item that way, preferring one connected to the current item; Home and End go to the first
// and last node; Enter and Space select; Escape clears the selection. Otherwise it is a picture: role="img" with `label`,
// no tab stops. A thumbnail is a tiny picture with no text, hidden from assistive tech unless the caller says otherwise.

export type GraphSide = 'left' | 'right' | 'top' | 'bottom'
export type GraphShape = 'card' | 'pill' | 'gate' | 'square'
// A step's state, drawn as a Glyph shape (Spinner while running) and said by `toneLabel`.
export type GraphTone = 'ok' | 'running' | 'waiting' | 'error' | 'off'
// A proposed change, drawn as a coloured (and, for removed, dashed) outline and said by `markLabel`, shown as a badge.
export type GraphMark = 'added' | 'changed' | 'removed'

export type GraphNode = {
  // Unique across nodes and edges: `selected` and `onSelect` name either.
  id: string
  // Top-left corner and size, in graph units.
  x: number
  y: number
  width: number
  height: number
  // card (rounded, the default), pill (start and end), gate (chamfered corners), square (square corners: checks).
  shape?: GraphShape
  // The step's name, in the code font. A pill shows only this.
  title: string
  // The line above the title: an icon (12px or so) and the kind of step, small and muted.
  kicker?: ReactNode
  // The line under the title: who runs it, or what it did.
  detail?: string
  tone?: GraphTone
  // The tone in words, read with the node's name. Required in practice whenever `tone` is set on an interactive graph.
  toneLabel?: string
  mark?: GraphMark
  // The mark in words ("+ new", "~ edited"): drawn as a badge on the top edge and read with the name.
  markLabel?: string
  // A short count on the top edge ("×3").
  badge?: string
  // Not on the path being shown: no fill, muted text.
  dim?: boolean
  // The accessible name, when the default (title, detail, toneLabel, markLabel) isn't right.
  label?: string
}

export type GraphEnd = {
  node: string
  side: GraphSide
  // Along the side, from its middle, in graph units: two edges on one side don't overlap.
  offset?: number
}

export type GraphEdge = {
  id: string
  from: GraphEnd
  to: GraphEnd
  // Drawn in a pill at the curve's middle.
  label?: string
  // dashed: a loop back. dotted: inferred.
  line?: 'solid' | 'dashed' | 'dotted'
  // strong: the path taken. faint: not reached.
  weight?: 'normal' | 'strong' | 'faint'
  mark?: GraphMark
  // The mark in words, drawn beside the label and read with the name.
  markLabel?: string
  // The accessible name, when the default (label, markLabel, the from and to nodes' titles) isn't right.
  name?: string
}

// A small box beside the graph that explains part of it (a loop's bound and how far it got). Not selectable.
export type GraphNote = {
  id: string
  x: number
  y: number
  width: number
  title: string
  detail?: string
  // An icon before the title (decorative).
  icon?: ReactNode
  tone?: 'running' | 'error'
  mark?: GraphMark
}

export type GraphLabels = {
  zoomIn: string
  zoomOut: string
  fit: string
  // The zoom as shown between the buttons ("85%").
  zoomValue: (percent: number) => string
  fullScreen?: string
}

export type GraphProps = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onSelect' | 'role' | 'aria-label'> & {
  // The graph's accessible name: the picture's (role="img") or the group's.
  label: string
  // The extent of the graph, in graph units.
  width: number
  height: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  notes?: GraphNote[]
  // The id of the selected node or edge.
  selected?: string | null
  // Makes the graph interactive. Called with an id on click, Enter or Space, and with null on Escape or a click on
  // empty space.
  onSelect?: (id: string | null) => void
  // Edges can be selected too: by their label (or a small handle at the middle of an unlabelled one) and their line.
  selectableEdges?: boolean
  // 1 is 1px per graph unit. 'fit' fits the width of the viewport, never above 1 (a thumbnail fits both ways).
  // Controlled when onZoomChange is given; otherwise this is the starting zoom (1, or 'fit' for a thumbnail).
  zoom?: number | 'fit'
  onZoomChange?: (zoom: number | 'fit') => void
  // The zoom toolbar's words. Without them there is no toolbar (Ctrl or ⌘ + wheel still zooms).
  labels?: GraphLabels
  // Adds a full-screen button to the toolbar (needs labels.fullScreen). The caller does the rest.
  onFullScreen?: () => void
  thumbnail?: boolean
  // Drawn in the viewport, over the graph and outside the scaled layer (a popover's anchor). The scrolled canvas is the
  // containing block, with --ui-graph-scale set to the zoom, so left: calc(var(--x) * var(--ui-graph-scale) * 1px) works.
  children?: ReactNode
  ref?: Ref<HTMLDivElement>
}

const ZOOM_MIN = 0.25
const ZOOM_MAX = 2
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
// A gate's cut corners, and how far the selected outline stands off the shape, in graph units.
const CHAMFER = 10
const HALO = 5

// One arrowhead per edge look, so the head is the line's colour.
const MARKERS = ['normal', 'strong', 'faint', 'added', 'changed', 'removed', 'selected']

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

const GLYPHS: Record<Exclude<GraphTone, 'running'>, GlyphName> = { ok: 'ok', waiting: 'warn', error: 'error', off: 'off' }

type Port = { x: number; y: number; dx: number; dy: number }

function port(n: GraphNode, end: GraphEnd): Port {
  const o = end.offset ?? 0
  if (end.side === 'left') return { x: n.x, y: n.y + n.height / 2 + o, dx: -1, dy: 0 }
  if (end.side === 'right') return { x: n.x + n.width, y: n.y + n.height / 2 + o, dx: 1, dy: 0 }
  if (end.side === 'top') return { x: n.x + n.width / 2 + o, y: n.y, dx: 0, dy: -1 }
  return { x: n.x + n.width / 2 + o, y: n.y + n.height, dx: 0, dy: 1 }
}

// A cubic curve that leaves each end along its side's normal; `mid` is the curve's point at t = 0.5, for the label.
// Two ends facing the same way (a loop back over the top) bow out a fixed distance; otherwise the pull grows with the gap.
function curve(a: Port, b: Port): { d: string; mid: { x: number; y: number } } {
  const same = a.dx === b.dx && a.dy === b.dy
  const k = same ? 34 : Math.max(24, Math.min(80, Math.hypot(b.x - a.x, b.y - a.y) / 2.4))
  const p1 = { x: a.x + a.dx * k, y: a.y + a.dy * k }
  const p2 = { x: b.x + b.dx * k, y: b.y + b.dy * k }
  const mid = { x: (a.x + 3 * p1.x + 3 * p2.x + b.x) / 8, y: (a.y + 3 * p1.y + 3 * p2.y + b.y) / 8 }
  return { d: `M${a.x},${a.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${b.x},${b.y}`, mid }
}

// The node's outline, grown by `grow` on every side (the selected halo). Corner radii of cards and squares are tokens,
// set in graph.css; a pill's ends are half its height, and a gate's cut corners grow with the outline.
function Shape({ shape, width, height, grow = 0, className }: { shape: GraphShape; width: number; height: number; grow?: number; className: string }) {
  const x = -grow
  const y = -grow
  const w = width + grow * 2
  const h = height + grow * 2
  if (shape === 'gate') {
    const c = CHAMFER + grow * (2 - Math.SQRT2)
    return <path className={className} d={`M${x + c} ${y}H${x + w - c}L${x + w} ${y + c}V${y + h - c}L${x + w - c} ${y + h}H${x + c}L${x} ${y + h - c}V${y + c}Z`} />
  }
  if (shape === 'pill') return <rect className={className} x={x} y={y} width={w} height={h} rx={h / 2} ry={h / 2} />
  return <rect className={className} x={x} y={y} width={w} height={h} />
}

type Item = { id: string; x: number; y: number; links: Set<string> }

const ARROWS: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }

// The item an arrow key moves to: the nearest one that way (distance along the arrow plus twice the distance across it),
// preferring an item connected to the current one when there is one within 45° of the arrow.
function nearest(items: Item[], from: Item, key: string): Item | undefined {
  const [ux, uy] = ARROWS[key]
  let best: Item | undefined
  let bestScore = Infinity
  let linked: Item | undefined
  let linkedScore = Infinity
  for (const it of items) {
    if (it === from) continue
    const dx = it.x - from.x
    const dy = it.y - from.y
    const along = dx * ux + dy * uy
    if (along <= 1) continue
    const across = Math.abs(dx * uy - dy * ux)
    const score = along + across * 2
    if (score < bestScore) {
      best = it
      bestScore = score
    }
    if (across <= along && from.links.has(it.id) && score < linkedScore) {
      linked = it
      linkedScore = score
    }
  }
  return linked ?? best
}

const sanitize = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '')

export function Graph({
  label,
  width,
  height,
  nodes,
  edges,
  notes = [],
  selected = null,
  onSelect,
  selectableEdges = false,
  zoom,
  onZoomChange,
  labels,
  onFullScreen,
  thumbnail = false,
  className,
  children,
  ref,
  ...rest
}: GraphProps) {
  const interactive = Boolean(onSelect) && !thumbnail
  const edgesSelectable = interactive && selectableEdges
  const uid = sanitize(useId())
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const els = useRef(new Map<string, HTMLElement>())

  // ---- zoom ----
  const [ownZoom, setOwnZoom] = useState<number | 'fit'>(zoom ?? (thumbnail ? 'fit' : 1))
  const requested = onZoomChange ? (zoom ?? (thumbnail ? 'fit' : 1)) : ownZoom
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setBox({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  let fit = 1
  if (box && box.width > 0 && width > 0) {
    fit = box.width / width
    if (thumbnail && box.height > 0 && height > 0) fit = Math.min(fit, box.height / height)
    fit = Math.min(1, fit)
  }
  const scale = requested === 'fit' ? fit : clampZoom(requested)
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  // Zooming keeps the graph point under `clientX, clientY` where it was (the pointer, or the viewport's centre).
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null)
  const setZoom = (next: number | 'fit', around?: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    if (around && canvas) {
      const rect = canvas.getBoundingClientRect()
      const current = scaleRef.current
      anchor.current = { x: (around.clientX - rect.left) / current, y: (around.clientY - rect.top) / current, ...around }
    }
    if (!onZoomChange) setOwnZoom(next)
    onZoomChange?.(next)
  }
  const setZoomRef = useRef(setZoom)
  setZoomRef.current = setZoom
  useLayoutEffect(() => {
    const a = anchor.current
    anchor.current = null
    const viewport = viewportRef.current
    const canvas = canvasRef.current
    if (!a || !viewport || !canvas) return
    const rect = canvas.getBoundingClientRect()
    viewport.scrollLeft += rect.left + a.x * scale - a.clientX
    viewport.scrollTop += rect.top + a.y * scale - a.clientY
  }, [scale])

  // Ctrl or ⌘ + wheel zooms (a native listener: React's wheel listener is passive and can't stop the page zooming).
  useEffect(() => {
    const el = viewportRef.current
    if (!el || thumbnail) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const next = Math.round(clampZoom(scaleRef.current * Math.exp(-e.deltaY * 0.002)) * 100) / 100
      if (next !== scaleRef.current) setZoomRef.current(next, { clientX: e.clientX, clientY: e.clientY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [thumbnail])

  const centre = () => {
    const rect = viewportRef.current?.getBoundingClientRect()
    return rect ? { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 } : undefined
  }
  const zoomIn = () => setZoom(ZOOM_STEPS.find((s) => s > scale + 0.001) ?? ZOOM_MAX, centre())
  const zoomOut = () => setZoom([...ZOOM_STEPS].reverse().find((s) => s < scale - 0.001) ?? ZOOM_MIN, centre())

  // ---- geometry ----
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const drawn = useMemo(
    () =>
      edges.map((e) => {
        const from = byId.get(e.from.node)
        const to = byId.get(e.to.node)
        if (!from || !to) throw new Error(`Graph edge "${e.id}" names a node that isn't in nodes`)
        return { edge: e, from, to, ...curve(port(from, e.from), port(to, e.to)) }
      }),
    [edges, byId]
  )

  // ---- roving focus ----
  const items = useMemo(() => {
    const list: Item[] = nodes.map((n) => ({ id: n.id, x: n.x + n.width / 2, y: n.y + n.height / 2, links: new Set<string>() }))
    const index = new Map(list.map((it) => [it.id, it]))
    for (const { edge, mid } of drawn) {
      const a = index.get(edge.from.node)
      const b = index.get(edge.to.node)
      a?.links.add(edge.to.node)
      b?.links.add(edge.from.node)
      if (edgesSelectable) {
        a?.links.add(edge.id)
        b?.links.add(edge.id)
        list.push({ id: edge.id, x: mid.x, y: mid.y, links: new Set([edge.from.node, edge.to.node]) })
      }
    }
    return list
  }, [nodes, drawn, edgesSelectable])
  const [focused, setFocused] = useState<string | null>(null)
  const has = (id: string | null): id is string => id !== null && items.some((it) => it.id === id)
  // The focused item while focus is inside; otherwise the selected one, else the first node.
  const tabStop = has(focused) ? focused : has(selected) ? selected : items[0]?.id

  const focusItem = (id: string) => {
    const el = els.current.get(id)
    if (!el) return
    setFocused(id)
    el.focus()
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }
  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(id, el)
    else els.current.delete(id)
  }
  const choose = (id: string) => {
    setFocused(id)
    onSelect?.(id)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (e.key === 'Escape') {
      if (selected === null) return
      e.preventDefault()
      onSelect?.(null)
      return
    }
    const id = (e.target as HTMLElement).dataset.uiGraphItem
    const current = items.find((it) => it.id === id)
    if (!current) return
    let next: Item | undefined
    if (e.key === 'Home') next = items[0]
    else if (e.key === 'End') next = [...items].reverse().find((it) => byId.has(it.id))
    else if (ARROWS[e.key]) next = nearest(items, current, e.key)
    else return
    e.preventDefault()
    if (next) focusItem(next.id)
  }
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    // Focus left the graph: next time Tab lands on the selected item.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null)
  }

  // ---- pointer: click empty space to clear, drag it to pan ----
  const pan = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
  const panned = useRef(false)
  const onEmpty = (target: EventTarget | null) => {
    const el = target as Element | null
    const viewport = viewportRef.current
    if (!el || !viewport || el.closest?.('[data-ui-graph-item]')) return false
    return el === viewport || el === canvasRef.current || Boolean(layerRef.current?.contains(el))
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    panned.current = false
    if (thumbnail || e.button !== 0 || !viewport || !onEmpty(e.target)) return
    pan.current = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, moved: false }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = pan.current
    const viewport = viewportRef.current
    if (!p || !viewport) return
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4) return
    if (!p.moved) {
      p.moved = true
      viewport.setPointerCapture?.(e.pointerId)
      viewport.dataset.panning = ''
    }
    viewport.scrollLeft = p.left - (e.clientX - p.x)
    viewport.scrollTop = p.top - (e.clientY - p.y)
  }
  const endPan = () => {
    if (pan.current?.moved) panned.current = true
    pan.current = null
    delete viewportRef.current?.dataset.panning
  }
  const onViewportClick = (e: MouseEvent<HTMLDivElement>) => {
    if (panned.current) {
      panned.current = false
      return
    }
    if (interactive && selected !== null && onEmpty(e.target)) onSelect?.(null)
  }

  // ---- drawing ----
  const arrow = (variant: string) => `url(#${uid}-arrow-${variant})`
  const edgeVariant = (e: GraphEdge, isSelected: boolean) => (isSelected ? 'selected' : (e.mark ?? e.weight ?? 'normal'))
  const showTools = Boolean(labels) && !thumbnail

  const nodeName = (n: GraphNode) => n.label ?? [n.title, n.detail, n.toneLabel, n.markLabel].filter(Boolean).join(', ')
  const edgeName = (e: GraphEdge, from: GraphNode, to: GraphNode) => e.name ?? [e.label, e.markLabel, from.title, to.title].filter(Boolean).join(', ')

  const renderNode = (n: GraphNode) => {
    const shape = n.shape ?? 'card'
    const isSelected = interactive && selected === n.id
    const body = (
      <>
        <svg className="ui-graph__frame" width={n.width} height={n.height} aria-hidden="true" focusable="false">
          {isSelected && <Shape className="ui-graph__halo" shape={shape} width={n.width} height={n.height} grow={HALO} />}
          <Shape className="ui-graph__shape" shape={shape} width={n.width} height={n.height} />
        </svg>
        {!thumbnail && (
          <>
            {shape !== 'pill' && n.kicker !== undefined && <span className="ui-graph__kicker">{n.kicker}</span>}
            <span className="ui-graph__title">{n.title}</span>
            {shape !== 'pill' && n.detail && <span className="ui-graph__detail">{n.detail}</span>}
            {n.tone && (
              <span className="ui-graph__status" data-tone={n.tone}>
                {n.tone === 'running' ? <Spinner size={12} /> : <Glyph name={GLYPHS[n.tone]} />}
              </span>
            )}
            {(n.badge || (n.mark && n.markLabel)) && (
              <span className="ui-graph__badges">
                {n.mark && n.markLabel && (
                  <span className="ui-graph__badge" data-mark={n.mark}>
                    {n.markLabel}
                  </span>
                )}
                {n.badge && (
                  <span className="ui-graph__badge" data-tone={n.tone}>
                    {n.badge}
                  </span>
                )}
              </span>
            )}
          </>
        )}
      </>
    )
    const common = {
      className: 'ui-graph__node',
      'data-shape': shape,
      'data-tone': n.tone,
      'data-mark': n.mark,
      'data-dim': n.dim || undefined,
      'data-selected': isSelected || undefined,
      style: { left: n.x, top: n.y, width: n.width, height: n.height } satisfies CSSProperties
    }
    if (!interactive) {
      return (
        <div key={n.id} {...common}>
          {body}
        </div>
      )
    }
    return (
      <button
        key={n.id}
        {...common}
        ref={register(n.id)}
        type="button"
        data-ui-graph-item={n.id}
        aria-label={nodeName(n)}
        aria-pressed={isSelected}
        tabIndex={n.id === tabStop ? 0 : -1}
        onFocus={() => setFocused(n.id)}
        onClick={() => choose(n.id)}
      >
        {body}
      </button>
    )
  }

  const renderEdgeLabel = ({ edge: e, from, to, mid }: (typeof drawn)[number]) => {
    const isSelected = edgesSelectable && selected === e.id
    const text = e.label || (e.mark && e.markLabel) ? (
      <>
        {e.label && <span className="ui-graph__label-text">{e.label}</span>}
        {e.mark && e.markLabel && <span className="ui-graph__label-mark">{e.markLabel}</span>}
      </>
    ) : null
    const common = {
      'data-line': e.line,
      'data-weight': e.weight,
      'data-mark': e.mark,
      'data-selected': isSelected || undefined,
      style: { left: mid.x, top: mid.y } satisfies CSSProperties
    }
    if (!edgesSelectable) {
      if (!text || thumbnail) return null
      return (
        <span key={e.id} className="ui-graph__label" {...common}>
          {text}
        </span>
      )
    }
    return (
      <button
        key={e.id}
        {...common}
        className={text ? 'ui-graph__label' : 'ui-graph__handle'}
        ref={register(e.id)}
        type="button"
        data-ui-graph-item={e.id}
        aria-label={edgeName(e, from, to)}
        aria-pressed={isSelected}
        tabIndex={e.id === tabStop ? 0 : -1}
        onFocus={() => setFocused(e.id)}
        onClick={() => choose(e.id)}
      >
        {text}
      </button>
    )
  }

  return (
    <div
      {...rest}
      ref={ref}
      className={['ui-graph', thumbnail && 'ui-graph--thumbnail', className].filter(Boolean).join(' ')}
      data-interactive={interactive || undefined}
      data-tools={showTools || undefined}
      aria-hidden={rest['aria-hidden'] ?? (thumbnail ? true : undefined)}
    >
      <div
        ref={viewportRef}
        className="ui-graph__viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onClick={onViewportClick}
      >
        <div ref={canvasRef} className="ui-graph__canvas" style={{ '--ui-graph-scale': scale } as CSSProperties}>
          <div
            ref={layerRef}
            className="ui-graph__layer"
            role={interactive ? 'group' : 'img'}
            aria-label={label}
            style={{ width, height, zoom: scale }}
            onKeyDown={interactive ? onKeyDown : undefined}
            onBlur={interactive ? onBlur : undefined}
          >
            <svg className="ui-graph__edges" width={width} height={height} aria-hidden="true" focusable="false">
              <defs>
                {MARKERS.map((m) => (
                  <marker key={m} id={`${uid}-arrow-${m}`} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth={m === 'strong' || m === 'selected' ? 11 : 9} markerHeight={m === 'strong' || m === 'selected' ? 11 : 9} orient="auto-start-reverse">
                    <path className="ui-graph__arrow" data-variant={m} d="M0 1L10 5L0 9Z" />
                  </marker>
                ))}
              </defs>
              {drawn.map(({ edge: e, d }) => {
                const isSelected = edgesSelectable && selected === e.id
                return (
                  <g key={e.id} className="ui-graph__edge" data-line={e.line} data-weight={e.weight} data-mark={e.mark} data-selected={isSelected || undefined}>
                    {isSelected && <path className="ui-graph__edge-halo" d={d} />}
                    <path className="ui-graph__path" d={d} markerEnd={thumbnail ? undefined : arrow(edgeVariant(e, isSelected))} />
                    {edgesSelectable && (
                      <path
                        className="ui-graph__hit"
                        d={d}
                        data-ui-graph-item={e.id}
                        onClick={() => {
                          // The line can't take focus: its label (or handle) does, so the keyboard carries on from here.
                          focusItem(e.id)
                          choose(e.id)
                        }}
                      />
                    )}
                  </g>
                )
              })}
            </svg>
            {!thumbnail &&
              notes.map((note) => (
                <div key={note.id} className="ui-graph__note" data-tone={note.tone} data-mark={note.mark} style={{ left: note.x, top: note.y, width: note.width }}>
                  <span className="ui-graph__note-title">
                    {note.icon && (
                      <span className="ui-graph__note-icon" aria-hidden="true">
                        {note.icon}
                      </span>
                    )}
                    {note.title}
                  </span>
                  {note.detail && <span className="ui-graph__note-detail">{note.detail}</span>}
                </div>
              ))}
            {nodes.map(renderNode)}
            {drawn.map(renderEdgeLabel)}
          </div>
          {children}
        </div>
      </div>
      {showTools && labels && (
        <div className="ui-graph__tools">
          <IconButton label={labels.zoomOut} onClick={zoomOut} disabled={scale <= ZOOM_MIN + 0.001}>
            <ZoomOut size={14} />
          </IconButton>
          <span className="ui-graph__zoom" aria-live="polite">
            {labels.zoomValue(Math.round(scale * 100))}
          </span>
          <IconButton label={labels.zoomIn} onClick={zoomIn} disabled={scale >= ZOOM_MAX - 0.001}>
            <ZoomIn size={14} />
          </IconButton>
          <span className="ui-graph__sep" aria-hidden="true" />
          <IconButton label={labels.fit} onClick={() => setZoom('fit')}>
            <Scan size={14} />
          </IconButton>
          {onFullScreen && labels.fullScreen && (
            <IconButton label={labels.fullScreen} onClick={onFullScreen}>
              <Maximize2 size={14} />
            </IconButton>
          )}
        </div>
      )}
    </div>
  )
}
