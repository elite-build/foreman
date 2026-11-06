// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Graph, type GraphEdge, type GraphLabels, type GraphNode, type GraphNote } from '../../src/renderer/src/ui/Graph'

afterEach(cleanup)

// start → plan → checks → done, with checks → fix → checks looping below:
//
//   start   plan   checks   done
//                   fix
const NODES: GraphNode[] = [
  { id: 'start', x: 0, y: 16, width: 76, height: 30, shape: 'pill', title: 'Start' },
  { id: 'plan', x: 120, y: 0, width: 140, height: 62, title: 'plan', detail: 'architect', tone: 'ok', toneLabel: 'done' },
  { id: 'checks', x: 320, y: 0, width: 140, height: 62, shape: 'square', title: 'checks', detail: 'lint · test', tone: 'running', toneLabel: 'running', badge: '×3' },
  { id: 'done', x: 520, y: 16, width: 76, height: 30, shape: 'pill', title: 'Done', tone: 'off', toneLabel: 'not reached' },
  { id: 'fix', x: 320, y: 140, width: 140, height: 62, title: 'fix', detail: 'developer', mark: 'added', markLabel: 'new', label: 'fix, a new step' }
]
const EDGES: GraphEdge[] = [
  { id: 'e1', from: { node: 'start', side: 'right' }, to: { node: 'plan', side: 'left' } },
  { id: 'e2', from: { node: 'plan', side: 'right' }, to: { node: 'checks', side: 'left' }, weight: 'strong' },
  { id: 'e3', from: { node: 'checks', side: 'right' }, to: { node: 'done', side: 'left' }, label: 'passed', weight: 'faint' },
  { id: 'e4', from: { node: 'checks', side: 'bottom', offset: 20 }, to: { node: 'fix', side: 'top', offset: 20 }, label: 'failed', mark: 'added', markLabel: 'new' },
  { id: 'e5', from: { node: 'fix', side: 'top', offset: -20 }, to: { node: 'checks', side: 'bottom', offset: -20 }, line: 'dashed' }
]
const NOTES: GraphNote[] = [{ id: 'loop', x: 120, y: 150, width: 160, title: 'fix-until-green', detail: 'at most 4 passes', tone: 'running' }]
const LABELS: GraphLabels = { zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit', zoomValue: (p) => `${p}%`, fullScreen: 'Full screen' }

function Selectable({ onSelect = () => {}, initial = null, selectableEdges = false }: { onSelect?: (id: string | null) => void; initial?: string | null; selectableEdges?: boolean }) {
  const [selected, setSelected] = useState<string | null>(initial)
  return (
    <>
      <button>Before</button>
      <Graph
        label="Fix until green"
        width={600}
        height={210}
        nodes={NODES}
        edges={EDGES}
        notes={NOTES}
        selected={selected}
        selectableEdges={selectableEdges}
        onSelect={(id) => {
          setSelected(id)
          onSelect(id)
        }}
      />
      <button>After</button>
    </>
  )
}

const focusedName = () => document.activeElement?.getAttribute('aria-label')

describe('Graph', () => {
  it('is a picture without onSelect: role="img" with the label, no buttons and no tab stops', () => {
    const { container } = render(<Graph label="Fix until green" width={600} height={210} nodes={NODES} edges={EDGES} notes={NOTES} />)
    expect(screen.getByRole('img', { name: 'Fix until green' })).toBeTruthy()
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(container.querySelectorAll('[tabindex]:not([tabindex="-1"]), button, a[href], input')).toHaveLength(0)
    // Still drawn: every node's title, the edge labels and the note.
    expect(container.querySelectorAll('.ui-graph__node')).toHaveLength(5)
    expect(container.textContent).toContain('passed')
    expect(container.textContent).toContain('fix-until-green')
  })

  it('draws one curve per edge, leaving and entering along the sides, with an arrowhead', () => {
    const { container } = render(<Graph label="G" width={600} height={210} nodes={NODES} edges={EDGES} />)
    const paths = [...container.querySelectorAll<SVGPathElement>('.ui-graph__path')]
    expect(paths).toHaveLength(5)
    // start's right side (76, 31) to plan's left side (120, 31): control points pulled out along each side's normal.
    expect(paths[0].getAttribute('d')).toBe('M76,31 C100,31 96,31 120,31')
    expect(paths[0].getAttribute('marker-end')).toMatch(/^url\(#.+-arrow-normal\)$/)
    expect(paths[1].getAttribute('marker-end')).toMatch(/-arrow-strong\)$/)
    expect(paths[3].getAttribute('marker-end')).toMatch(/-arrow-added\)$/)
    // The label sits at the curve's middle.
    const label = within(container).getByText('passed').closest<HTMLElement>('.ui-graph__label')!
    expect(label.style.left).toBe('490px')
    expect(label.style.top).toBe('31px')
  })

  it('positions nodes in graph units and marks shape, tone and mark as data, with a glyph for the tone', () => {
    const { container } = render(<Graph label="G" width={600} height={210} nodes={NODES} edges={EDGES} />)
    const checks = container.querySelector<HTMLElement>('[data-shape="square"]')!
    expect([checks.style.left, checks.style.top, checks.style.width, checks.style.height]).toEqual(['320px', '0px', '140px', '62px'])
    expect(checks.dataset.tone).toBe('running')
    expect(checks.querySelector('.ui-spinner')).toBeTruthy()
    expect(checks.textContent).toContain('×3')
    const plan = within(container).getByText('plan').closest('.ui-graph__node')!
    expect(plan.querySelector('.ui-glyph')?.getAttribute('data-glyph')).toBe('ok')
    const done = within(container).getByText('Done').closest('.ui-graph__node')!
    expect(done.querySelector('.ui-glyph')?.getAttribute('data-glyph')).toBe('off')
    const fix = within(container).getByText('fix').closest<HTMLElement>('.ui-graph__node')!
    expect(fix.dataset.mark).toBe('added')
    expect(within(fix).getByText('new')).toBeTruthy()
  })

  it('names each node from its title, detail, toneLabel and markLabel, unless label overrides', () => {
    render(<Selectable />)
    expect(screen.getByRole('group', { name: 'Fix until green' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'plan, architect, done' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'checks, lint · test, running' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Done, not reached' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'fix, a new step' })).toBeTruthy()
  })

  it('names a selectable edge from its label, mark and the two ends; an unlabelled one gets a handle', () => {
    render(<Selectable selectableEdges />)
    expect(screen.getByRole('button', { name: 'passed, checks, Done' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'failed, new, checks, fix' })).toBeTruthy()
    const handle = screen.getByRole('button', { name: 'fix, checks' })
    expect(handle.className).toBe('ui-graph__handle')
  })

  it('is one tab stop: the first node, or the selected item', async () => {
    const user = userEvent.setup()
    render(<Selectable />)
    await user.tab()
    await user.tab()
    expect(focusedName()).toBe('Start')
    expect(screen.getAllByRole('button').filter((b) => b.tabIndex === 0).map((b) => b.textContent)).toEqual(['Before', 'Start', 'After'])
    await user.tab()
    expect(document.activeElement?.textContent).toBe('After')
    cleanup()
    render(<Selectable initial="checks" />)
    await user.tab()
    await user.tab()
    expect(focusedName()).toBe('checks, lint · test, running')
  })

  it('arrows move to the nearest item that way, preferring connected ones; Home and End go to the first and last node', async () => {
    const user = userEvent.setup()
    render(<Selectable />)
    screen.getByRole('button', { name: 'Start' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(focusedName()).toBe('plan, architect, done')
    await user.keyboard('{ArrowRight}')
    expect(focusedName()).toBe('checks, lint · test, running')
    await user.keyboard('{ArrowDown}')
    expect(focusedName()).toBe('fix, a new step')
    await user.keyboard('{ArrowUp}')
    expect(focusedName()).toBe('checks, lint · test, running')
    await user.keyboard('{ArrowRight}')
    expect(focusedName()).toBe('Done, not reached')
    // Nothing further right: focus stays.
    await user.keyboard('{ArrowRight}')
    expect(focusedName()).toBe('Done, not reached')
    await user.keyboard('{Home}')
    expect(focusedName()).toBe('Start')
    await user.keyboard('{End}')
    expect(focusedName()).toBe('fix, a new step')
    // The roving tab stop follows focus.
    expect(screen.getByRole('button', { name: 'fix, a new step' }).tabIndex).toBe(0)
    expect(screen.getByRole('button', { name: 'Start' }).tabIndex).toBe(-1)
  })

  it('prefers an item connected to the current one over a nearer one that is not', async () => {
    const user = userEvent.setup()
    // From c, b is nearer straight up, but only a is connected to c.
    const nodes: GraphNode[] = [
      { id: 'a', x: 0, y: 0, width: 100, height: 40, title: 'a' },
      { id: 'b', x: 10, y: 80, width: 100, height: 40, title: 'b' },
      { id: 'c', x: 0, y: 200, width: 100, height: 40, title: 'c' }
    ]
    const edges: GraphEdge[] = [{ id: 'e', from: { node: 'c', side: 'top' }, to: { node: 'a', side: 'bottom' } }]
    render(<Graph label="G" width={300} height={240} nodes={nodes} edges={edges} onSelect={() => {}} />)
    screen.getByRole('button', { name: 'c' }).focus()
    await user.keyboard('{ArrowUp}')
    expect(focusedName()).toBe('a')
    // Without the edge, the nearest wins.
    cleanup()
    render(<Graph label="G" width={300} height={240} nodes={nodes} edges={[]} onSelect={() => {}} />)
    screen.getByRole('button', { name: 'c' }).focus()
    await user.keyboard('{ArrowUp}')
    expect(focusedName()).toBe('b')
  })

  it('reaches edges with the arrows when they are selectable', async () => {
    const user = userEvent.setup()
    render(<Selectable selectableEdges />)
    screen.getByRole('button', { name: 'checks, lint · test, running' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(focusedName()).toBe('passed, checks, Done')
    await user.keyboard('{ArrowRight}')
    expect(focusedName()).toBe('Done, not reached')
  })

  it('Enter and Space select; Escape clears; the selected item is aria-pressed', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Selectable onSelect={onSelect} selectableEdges />)
    const plan = screen.getByRole('button', { name: 'plan, architect, done' })
    plan.focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenLastCalledWith('plan')
    expect(plan.getAttribute('aria-pressed')).toBe('true')
    expect(plan.hasAttribute('data-selected')).toBe(true)
    // → from plan reaches the (unlabelled) edge to checks first: it is connected and nearer.
    await user.keyboard('{ArrowRight}')
    expect(focusedName()).toBe('plan, checks')
    await user.keyboard(' ')
    expect(onSelect).toHaveBeenLastCalledWith('e2')
    expect(plan.getAttribute('aria-pressed')).toBe('false')
    await user.keyboard('{Escape}')
    expect(onSelect).toHaveBeenLastCalledWith(null)
    expect(screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true')).toEqual([])
    // With nothing selected, Escape is left for whatever is around the graph (a dialog, full screen).
    const around = vi.fn()
    document.addEventListener('keydown', around)
    await user.keyboard('{Escape}')
    document.removeEventListener('keydown', around)
    expect(onSelect).toHaveBeenCalledTimes(3)
    expect(around.mock.calls[0][0].defaultPrevented).toBe(false)
  })

  it('a click selects a node, an edge label or an edge line; a click on empty space clears', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const { container } = render(<Selectable onSelect={onSelect} selectableEdges />)
    await user.click(screen.getByRole('button', { name: 'fix, a new step' }))
    expect(onSelect).toHaveBeenLastCalledWith('fix')
    await user.click(screen.getByRole('button', { name: 'passed, checks, Done' }))
    expect(onSelect).toHaveBeenLastCalledWith('e3')
    fireEvent.click(container.querySelectorAll('.ui-graph__hit')[1])
    expect(onSelect).toHaveBeenLastCalledWith('e2')
    expect(focusedName()).toBe('plan, checks')
    fireEvent.click(container.querySelector('.ui-graph__layer')!)
    expect(onSelect).toHaveBeenLastCalledWith(null)
  })

  it('edge lines are not clickable unless edges are selectable', () => {
    const { container } = render(<Selectable />)
    expect(container.querySelectorAll('.ui-graph__hit')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /passed/ })).toBeNull()
  })

  it('does not clear the selection for a click inside its children (an overlay the feature draws)', () => {
    const onSelect = vi.fn()
    render(
      <Graph label="G" width={600} height={210} nodes={NODES} edges={EDGES} selected="plan" onSelect={onSelect}>
        <span>An overlay</span>
      </Graph>
    )
    fireEvent.click(screen.getByText('An overlay'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('has a toolbar only with labels: zoom out, the zoom, zoom in, fit, and full screen with onFullScreen', async () => {
    const user = userEvent.setup()
    const onFullScreen = vi.fn()
    const { container, rerender } = render(<Graph label="G" width={600} height={210} nodes={NODES} edges={EDGES} />)
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull()
    rerender(<Graph label="G" width={600} height={210} nodes={NODES} edges={EDGES} labels={LABELS} onFullScreen={onFullScreen} />)
    const layer = container.querySelector<HTMLElement>('.ui-graph__layer')!
    expect(layer.style.zoom).toBe('1')
    expect(screen.getByText('100%')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByText('110%')).toBeTruthy()
    expect(layer.style.zoom).toBe('1.1')
    await user.click(screen.getByRole('button', { name: 'Zoom out' }))
    await user.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(screen.getByText('90%')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Full screen' }))
    expect(onFullScreen).toHaveBeenCalledOnce()
    // Fit: jsdom has no layout, so the viewport's width is unknown and fit stays at 1 (never above).
    await user.click(screen.getByRole('button', { name: 'Fit' }))
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('clamps the zoom and disables the button at each end; reports changes when controlled', async () => {
    const user = userEvent.setup()
    const onZoomChange = vi.fn()
    const { rerender } = render(<Graph label="G" width={600} height={210} nodes={NODES} edges={EDGES} labels={LABELS} zoom={9} onZoomChange={onZoomChange} />)
    expect(screen.getByText('200%')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(onZoomChange).toHaveBeenLastCalledWith(1.75)
    // Controlled: the caller's value stands until it changes.
    expect(screen.getByText('200%')).toBeTruthy()
    rerender(<Graph label="G" width={600} height={210} nodes={NODES} edges={EDGES} labels={LABELS} zoom={0.1} onZoomChange={onZoomChange} />)
    expect(screen.getByText('25%')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Fit' }))
    expect(onZoomChange).toHaveBeenLastCalledWith('fit')
  })

  it('zooms with Ctrl + wheel, and leaves a plain wheel to scroll', () => {
    const onZoomChange = vi.fn()
    const { container } = render(<Graph label="G" width={600} height={210} nodes={NODES} edges={EDGES} onZoomChange={onZoomChange} zoom={1} />)
    const viewport = container.querySelector('.ui-graph__viewport')!
    const plain = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
    viewport.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
    expect(onZoomChange).not.toHaveBeenCalled()
    const zoom = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
    viewport.dispatchEvent(zoom)
    expect(zoom.defaultPrevented).toBe(true)
    expect(onZoomChange).toHaveBeenLastCalledWith(1.22)
  })

  it('a thumbnail is hidden from assistive tech, has no text, no toolbar and no buttons', () => {
    const { container } = render(<Graph thumbnail label="Fix until green" width={600} height={210} nodes={NODES} edges={EDGES} notes={NOTES} labels={LABELS} onSelect={() => {}} />)
    const root = container.firstElementChild as HTMLElement
    expect(root.getAttribute('aria-hidden')).toBe('true')
    expect(root.className).toContain('ui-graph--thumbnail')
    expect(root.textContent).toBe('')
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelectorAll('.ui-graph__node')).toHaveLength(5)
    expect(container.querySelectorAll('.ui-graph__path')).toHaveLength(5)
  })

  it('a thumbnail can be shown to assistive tech when the caller says so', () => {
    render(<Graph thumbnail aria-hidden={false} label="Fix until green" width={600} height={210} nodes={NODES} edges={EDGES} />)
    expect(screen.getByRole('img', { name: 'Fix until green' })).toBeTruthy()
  })

  it('throws for an edge that names a node it was not given', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const edges: GraphEdge[] = [{ id: 'x', from: { node: 'plan', side: 'right' }, to: { node: 'nowhere', side: 'left' } }]
    expect(() => render(<Graph label="G" width={600} height={210} nodes={NODES} edges={edges} />)).toThrow(/"x".*isn't in nodes/)
    vi.restoreAllMocks()
  })

  it('passes native props and className to the root and takes a ref', () => {
    let el: HTMLDivElement | null = null
    render(<Graph ref={(node) => void (el = node)} className="flow-canvas" data-testid="g" label="G" width={600} height={210} nodes={NODES} edges={EDGES} />)
    expect(screen.getByTestId('g')).toBe(el)
    expect(el!.className).toBe('ui-graph flow-canvas')
  })
})
