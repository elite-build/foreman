import { useState } from 'react'
import { Bot, Eye, ListChecks, Repeat, UserCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { Combobox } from '../Combobox'
import { Dialog, Sheet } from '../Dialog'
import { Graph } from '../Graph'
import type { GraphEdge, GraphNode, GraphNote } from '../Graph'
import { HoverCard } from '../HoverCard'
import { Listbox } from '../Listbox'
import type { ListboxOption } from '../Listbox'
import { Popover } from '../Popover'
import { Resizer } from '../Resizer'
import { Tree, TreeItem } from '../Tree'
import type { TreeNodeRow } from '../Tree'

// Dev-only page of every overlay and structure component, states included. Plain strings: it never ships.
// Dialogs and sheets are drawn as non-modal previews inside frames so they can all be seen (and screenshotted) at
// once; the buttons open the real, modal ones.

const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 16 } as const
const stack = { display: 'flex', flexDirection: 'column', gap: 8 } as const
const frame = { position: 'relative', width: 420, height: 300, overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' } as const

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ ...stack, marginBottom: 24 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {children}
    </section>
  )
}

const LANGUAGES: ListboxOption[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français', disabled: true, description: 'Translation in progress' },
  { value: 'de', label: 'Deutsch' },
  { value: 'long', label: 'A language with a very long name that has to be cut off at the edge of the list' }
]

const MODELS: ListboxOption[] = [
  { value: 'a', label: 'Claude Opus', group: 'Claude', trailing: <span className="faint">default</span> },
  { value: 'b', label: 'Claude Sonnet', group: 'Claude', description: 'Faster, lower cost' },
  { value: 'c', label: 'GPT', group: 'Codex' },
  { value: 'd', label: 'Composer', group: 'Cursor', disabled: true, description: 'Not signed in' }
]

const BRANCHES: ListboxOption[] = [
  { value: 'main', label: 'main', trailing: <span className="faint">default</span> },
  { value: 'feature/login', label: 'feature/login' },
  { value: 'feature/logout', label: 'feature/logout', disabled: true, description: '~/work/logout' },
  { value: 'release/2026-10-with-a-very-long-branch-name-that-keeps-going', label: 'release/2026-10-with-a-very-long-branch-name-that-keeps-going' }
]

const TREE: (TreeNodeRow & { name: string })[] = [
  { path: 'src', name: 'src', dir: true, depth: 0, expanded: true },
  { path: 'src/main', name: 'main', dir: true, depth: 1, expanded: false },
  { path: 'src/shared', name: 'shared', dir: true, depth: 1, expanded: true },
  { path: 'src/shared/types.ts', name: 'types.ts', dir: false, depth: 2 },
  { path: 'src/shared/a-file-with-a-rather-long-name-that-is-cut-off.ts', name: 'a-file-with-a-rather-long-name-that-is-cut-off.ts', dir: false, depth: 2 },
  { path: 'README.md', name: 'README.md', dir: false, depth: 0 }
]

function PopoverDemo({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen)
  return (
    <div style={{ height: 240, display: 'flex', alignItems: 'flex-end' }}>
      <Popover open={open} onOpenChange={setOpen} label="Model" trigger={(props) => <button {...props} className="ui-btn">Model</button>}>
        <Listbox label="Models" options={MODELS} value="b" onChange={() => setOpen(false)} />
      </Popover>
    </div>
  )
}

function ComboDemo({ startOpen, inline, initial = '' }: { startOpen?: boolean; inline?: boolean; initial?: string }) {
  const [query, setQuery] = useState(initial)
  const [value, setValue] = useState<string | null>('main')
  const [open, setOpen] = useState<boolean | undefined>(startOpen)
  const shown = BRANCHES.filter((b) => b.value.includes(query))
  return (
    <div style={{ width: 300 }}>
      <Combobox
        label="Branch"
        mono
        inline={inline}
        options={shown}
        value={value}
        query={query}
        onQueryChange={setQuery}
        onChange={setValue}
        open={open}
        onOpenChange={startOpen === undefined ? undefined : setOpen}
        placeholder={value ?? 'Choose a branch'}
        empty="No branches match"
      />
    </div>
  )
}

function Dialogs() {
  const [dialog, setDialog] = useState(false)
  const [sheet, setSheet] = useState(false)
  return (
    <div style={row}>
      <div style={stack}>
        <span className="faint">Dialog (preview)</span>
        <div style={frame}>
          <Dialog preview title="Rename workspace" description="Pick a name you will recognise." closeLabel="Close" onClose={() => {}} footer={<><button className="ui-btn">Cancel</button><button className="ui-btn ui-btn--primary">Save</button></>}>
            <input aria-label="Name" defaultValue="fix-login" style={{ width: '100%' }} />
          </Dialog>
        </div>
      </div>
      <div style={stack}>
        <span className="faint">Dialog, large, toolbar, long body (preview)</span>
        <div style={frame}>
          <Dialog preview size="lg" title="Choose an agent" toolbar={<input aria-label="Search" placeholder="Search" style={{ width: '100%' }} />} onClose={() => {}} footer={<button className="ui-btn">Done</button>}>
            {Array.from({ length: 12 }, (_, i) => (
              <p key={i} style={{ margin: '0 0 8px' }}>Agent {i + 1}: a line of body text that scrolls inside the dialog.</p>
            ))}
          </Dialog>
        </div>
      </div>
      <div style={stack}>
        <span className="faint">Sheet (preview)</span>
        <div style={frame}>
          <Sheet preview title="Add variable" description="Saved for every workspace." closeLabel="Close" onClose={() => {}} footer={<><button className="ui-btn">Cancel</button><button className="ui-btn ui-btn--primary">Save</button></>}>
            <label style={stack}>
              Name
              <input defaultValue="ANTHROPIC_BASE_URL" />
            </label>
          </Sheet>
        </div>
      </div>
      <div style={stack}>
        <span className="faint">Real, modal</span>
        <button className="ui-btn" onClick={() => setDialog(true)}>Open dialog</button>
        <button className="ui-btn" onClick={() => setSheet(true)}>Open sheet</button>
        {dialog && (
          <Dialog title="Delete workspace" closeLabel="Close" onClose={() => setDialog(false)} footer={<button className="ui-btn ui-btn--danger" onClick={() => setDialog(false)}>Delete</button>}>
            <p style={{ margin: 0 }}>This removes the worktree. Escape or the backdrop closes it.</p>
          </Dialog>
        )}
        {sheet && (
          <Sheet title="Edit variable" closeLabel="Close" onClose={() => setSheet(false)} footer={<button className="ui-btn ui-btn--primary" onClick={() => setSheet(false)}>Save</button>}>
            <input aria-label="Value" defaultValue="value" />
          </Sheet>
        )}
      </div>
    </div>
  )
}

function TreeDemo() {
  const [selected, setSelected] = useState('src/shared/types.ts')
  return (
    <div style={{ width: 300 }}>
      <Tree label="Files" rows={TREE} onToggle={() => {}} onOpen={setSelected}>
        {TREE.map((r) => (
          <TreeItem key={r.path} path={r.path} selected={r.path === selected} title={r.path}>
            <span className="mono">{r.name}</span>
          </TreeItem>
        ))}
      </Tree>
    </div>
  )
}

// Research then implement, laid out by hand (the feature's layout function will do this): 140×62 cards, 76×30 pills.
const kicker = (icon: ReactNode, word: string) => (
  <>
    {icon}
    {word}
  </>
)
const TURN = kicker(<Bot size={12} />, 'Agent turn')
const card = (id: string, x: number, y: number, title: string, detail: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, x, y, width: 140, height: 62, title, detail, kicker: TURN, ...extra })
const pill = (id: string, x: number, y: number, title: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, x, y, width: 76, height: 30, shape: 'pill', title, ...extra })
const FLOW_NODES: GraphNode[] = [
  pill('start', 14, 72, 'Start'),
  card('plan', 112, 56, 'plan', 'architect · loadout 2'),
  card('plan-check', 322, 56, 'plan-check', '“Is this the plan?”', { shape: 'gate', kicker: kicker(<UserCheck size={12} />, 'Gate · you decide') }),
  card('implement', 532, 56, 'implement', 'developer'),
  pill('end', 354, 212, 'Stopped'),
  card('checks', 532, 196, 'checks', 'lint · typecheck · test', { shape: 'square', kicker: kicker(<ListChecks size={12} />, 'Checks') }),
  card('qa', 742, 196, 'qa', 'qa-engineer', { kicker: kicker(<Eye size={12} />, 'Review · read-only') }),
  pill('done', 952, 212, 'Done'),
  card('fix', 532, 330, 'fix', 'same tab as implement'),
  card('address', 742, 330, 'address', 'same tab as implement')
]
type EdgeExtra = Partial<GraphEdge> & { fromOffset?: number; toOffset?: number }
const edge = (id: string, from: string, fromSide: GraphEdge['from']['side'], to: string, toSide: GraphEdge['to']['side'], extra: EdgeExtra = {}): GraphEdge => {
  const { fromOffset, toOffset, ...rest } = extra
  return { id, from: { node: from, side: fromSide, offset: fromOffset }, to: { node: to, side: toSide, offset: toOffset }, ...rest }
}
const FLOW_EDGES: GraphEdge[] = [
  edge('start>plan', 'start', 'right', 'plan', 'left'),
  edge('plan>plan-check', 'plan', 'right', 'plan-check', 'left'),
  edge('plan-check>implement', 'plan-check', 'right', 'implement', 'left', { label: 'continued' }),
  edge('plan-check>plan', 'plan-check', 'top', 'plan', 'top', { label: 'sent back', line: 'dashed' }),
  edge('plan-check>end', 'plan-check', 'bottom', 'end', 'top', { label: 'stopped' }),
  edge('implement>checks', 'implement', 'bottom', 'checks', 'top'),
  edge('checks>qa', 'checks', 'right', 'qa', 'left', { label: 'passed', fromOffset: -10, toOffset: -10 }),
  edge('checks>fix', 'checks', 'bottom', 'fix', 'top', { label: 'failed', fromOffset: 20, toOffset: 20 }),
  edge('fix>checks', 'fix', 'top', 'checks', 'bottom', { line: 'dashed', fromOffset: -20, toOffset: -20 }),
  edge('qa>done', 'qa', 'right', 'done', 'left', { label: 'clean' }),
  edge('qa>address', 'qa', 'bottom', 'address', 'top', { label: 'findings' }),
  edge('address>checks', 'address', 'left', 'checks', 'right', { line: 'dashed', toOffset: 16 })
]
const FLOW_NOTES: GraphNote[] = [
  { id: 'fix-until-green', x: 330, y: 342, width: 176, title: 'fix-until-green', detail: 'at most 4 passes · 45 min', icon: <Repeat size={12} /> },
  { id: 'qa-until-clean', x: 898, y: 342, width: 150, title: 'qa-until-clean', detail: 'at most 2 passes', icon: <Repeat size={12} /> }
]
const GRAPH_LABELS = { zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit to width', zoomValue: (percent: number) => `${percent}%`, fullScreen: 'Full screen' }

// A run part-way through: checks on its third pass, the path so far strong, what it hasn't reached faint.
const RUN_STATE: Record<string, Partial<GraphNode>> = {
  start: { tone: 'ok', toneLabel: 'done' },
  plan: { tone: 'ok', toneLabel: 'done', detail: '1 pass · 6 min · $0.41' },
  'plan-check': { tone: 'ok', toneLabel: 'done', detail: 'continued by you, 10:42' },
  implement: { tone: 'ok', toneLabel: 'done', detail: '1 pass · 11 min · $0.88' },
  checks: { tone: 'running', toneLabel: 'running', badge: '×3', detail: 'pass 3 · running 0:48' },
  fix: { tone: 'ok', toneLabel: 'done', badge: '×2', detail: '2 passes · $0.78' },
  qa: { tone: 'waiting', toneLabel: 'waiting for you', detail: 'waiting for you · 4 min' },
  address: { tone: 'off', toneLabel: 'not reached', dim: true },
  done: { tone: 'off', toneLabel: 'not reached', dim: true },
  end: { tone: 'error', toneLabel: 'failed', badge: '×1' }
}
const TAKEN = new Set(['start>plan', 'plan>plan-check', 'plan-check>implement', 'implement>checks', 'checks>fix', 'fix>checks'])
const RUN_NODES: GraphNode[] = FLOW_NODES.map((n) => ({ ...n, ...RUN_STATE[n.id] }))
const RUN_EDGES: GraphEdge[] = FLOW_EDGES.map((e) => ({ ...e, weight: TAKEN.has(e.id) ? 'strong' : 'faint' }))
const RUN_NOTES: GraphNote[] = [
  { ...FLOW_NOTES[0], detail: 'pass 3 of 4 · 10 of 45 min', tone: 'running', toneLabel: 'running' },
  { ...FLOW_NOTES[1], detail: '2 of 2 passes used', tone: 'error', toneLabel: 'stopped' }
]

// The assistant's proposal: a new security review, qa edited, qa → done removed.
const PROPOSAL_NODES: GraphNode[] = [
  ...FLOW_NODES.map((n): GraphNode => (n.id === 'qa' ? { ...n, mark: 'changed', markLabel: '~ edited', detail: 'qa-engineer · loadout 2' } : n.id === 'done' ? { ...n, x: 984, y: 352 } : n)),
  card('security', 952, 196, 'security', 'security-reviewer', { kicker: kicker(<Eye size={12} />, 'Review · read-only'), mark: 'added', markLabel: '+ new' })
]
const PROPOSAL_EDGES: GraphEdge[] = [
  ...FLOW_EDGES.map((e): GraphEdge => (e.id === 'qa>done' ? { ...e, mark: 'removed', markLabel: 'removed' } : e)),
  edge('qa>security', 'qa', 'right', 'security', 'left', { label: 'clean', mark: 'added', markLabel: '+ new' }),
  edge('security>done', 'security', 'bottom', 'done', 'top', { label: 'clean', mark: 'added', markLabel: '+ new', fromOffset: 30 }),
  edge('security>address', 'security', 'bottom', 'address', 'right', { label: 'findings', mark: 'added', markLabel: '+ new', fromOffset: -30 })
]
const PROPOSAL_NOTES: GraphNote[] = [FLOW_NOTES[0], { ...FLOW_NOTES[1], x: 742, y: 404, width: 176, detail: 'at most 3 passes (was 2)', mark: 'changed', markLabel: '~ edited' }]

function GraphDemo() {
  const [selected, setSelected] = useState<string | null>('qa')
  const [proposed, setProposed] = useState<string | null>('security')
  const [zoom, setZoom] = useState<number | 'fit'>(0.85)
  return (
    <div style={stack}>
      <span className="faint">Interactive, exits selectable: Tab in, arrows move, Enter selects, Escape clears; Ctrl + wheel zooms; drag empty space to pan. Selected: {selected ?? 'nothing'}</span>
      <Graph
        label="Research then implement"
        width={1060}
        height={400}
        nodes={FLOW_NODES}
        edges={FLOW_EDGES}
        notes={FLOW_NOTES}
        selected={selected}
        onSelect={setSelected}
        selectableEdges
        zoom={zoom}
        onZoomChange={setZoom}
        labels={GRAPH_LABELS}
        onFullScreen={() => setZoom('fit')}
        style={{ height: 420 }}
      />
      <span className="faint">A run: done, running, waiting, failed and not reached; badges; the path taken strong, the rest faint (a picture: role=img, no tab stops)</span>
      <Graph label="Research then implement, running: checks, pass 3" width={1060} height={400} nodes={RUN_NODES} edges={RUN_EDGES} notes={RUN_NOTES} zoom={0.75} />
      <span className="faint">A proposal: added, changed, removed (fits the width)</span>
      <Graph
        label="Research then implement, with the assistant's changes"
        width={1110}
        height={452}
        nodes={PROPOSAL_NODES}
        edges={PROPOSAL_EDGES}
        notes={PROPOSAL_NOTES}
        zoom="fit"
        selected={proposed}
        onSelect={setProposed}
        labels={GRAPH_LABELS}
      />
      <span className="faint">Thumbnails: no text, hidden from assistive tech (the list row says what it is)</span>
      <div style={row}>
        <Graph thumbnail label="Research then implement" width={1060} height={400} nodes={FLOW_NODES} edges={FLOW_EDGES} style={{ width: 200, height: 76 }} />
        <Graph thumbnail label="Research then implement, running" width={1060} height={400} nodes={RUN_NODES} edges={RUN_EDGES} style={{ width: 200, height: 76 }} />
      </div>
    </div>
  )
}

function ResizerDemo() {
  const [size, setSize] = useState(220)
  return (
    <div style={{ display: 'flex', height: 120, width: 520, border: '1px solid var(--border)' }}>
      <div style={{ position: 'relative', width: size, flex: 'none', padding: 8, background: 'var(--bg-sidebar)' }}>
        Panel, {size}px
        <Resizer label="Resize panel" edge="right" value={size} min={140} max={360} onResize={(next) => setSize(next)} onReset={() => setSize(220)} />
      </div>
      <div style={{ padding: 8 }}>Content</div>
    </div>
  )
}

export function Gallery2d() {
  const [lang, setLang] = useState('es')
  return (
    <div>
      <Section title="Popover">
        <div style={row}>
          <PopoverDemo startOpen={false} />
          <PopoverDemo startOpen />
        </div>
      </Section>

      <Section title="HoverCard (focus or hover the trigger; the second is held open)">
        <div style={{ ...row, minHeight: 140 }}>
          <HoverCard label="Pull request" trigger={(props) => <button {...props} className="ui-btn">PR #42</button>}>
            <strong>PR #42</strong>
            <span>CI failing (2 checks)</span>
            <button className="ui-link-btn">Refresh</button>
          </HoverCard>
          <HoverCard label="Why" open side="right" width={260} trigger={(props) => <button {...props} className="ui-btn">Why is it here?</button>}>
            <strong>Why this card is in Ready</strong>
            <span>All checks passed, review approved.</span>
          </HoverCard>
        </div>
      </Section>

      <Section title="Listbox">
        <div style={row}>
          <div style={{ width: 260, border: '1px solid var(--border-control)', borderRadius: 'var(--radius-md)' }}>
            <Listbox label="Language" options={LANGUAGES} value={lang} onChange={setLang} />
          </div>
          <div style={{ width: 260, border: '1px solid var(--border-control)', borderRadius: 'var(--radius-md)' }}>
            <Listbox label="Models, grouped" options={MODELS} value="b" onChange={() => {}} />
          </div>
        </div>
      </Section>

      <Section title="Combobox (closed, open with a long option, empty, inline results)">
        <div style={{ ...row, minHeight: 260 }}>
          <ComboDemo />
          <ComboDemo startOpen />
          <ComboDemo startOpen initial="zzz" />
          <ComboDemo startOpen inline initial="feature" />
        </div>
      </Section>

      <Section title="Dialog and Sheet">
        <Dialogs />
      </Section>

      <Section title="Tree">
        <TreeDemo />
      </Section>

      <Section title="Graph">
        <GraphDemo />
      </Section>

      <Section title="Resizer (arrow keys, drag, double-click to reset)">
        <ResizerDemo />
      </Section>
    </div>
  )
}
