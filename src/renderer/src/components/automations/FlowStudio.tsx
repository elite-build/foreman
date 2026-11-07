// The flow studio (docs/loops-and-graphs.md, "Showing a graph"): a flow opened from Automations as its own page, not a
// dialog. The run graph at a readable size (zoom, fit, full screen), a step or exit selected on it opens in the inspector
// beside it; under it the Assistant (it proposes a whole new document, drawn on the graph with what it adds, changes and
// removes, applied only when the user says), the TOML (linked both ways: a selected step highlights its block, the caret
// in a block selects its step; problems on their lines) and the problems. Built-in and repository flows are read-only
// here; their changes go to a personal copy. Nothing runs from here but Run…, which shows what a run approves.
import { ArrowUpRight, Copy, MessageSquare, MoreHorizontal, Play, Save, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { flowProposalOf, type FlowProposal } from '../../../../shared/assistant'
import { proposalGraph } from '../../../../shared/flowDiff'
import { flowGraph } from '../../../../shared/flowGraph'
import { FLOW_DONE, loopsContaining, parseFlow, stepPersona, type Flow, type FlowListing, type FlowSource, type FlowStep } from '../../../../shared/flows'
import { FLOW_STARTERS, type FlowStarter } from '../../../../shared/flowStarters'
import { flowTomlBlocks, problemLine, stepAtLine, tokenizeFlowToml } from '../../../../shared/flowToml'
import type { ChatItem } from '../../../../shared/types'
import { useT, type RendererT } from '../../i18n'
import { api, attempt, loadAssistant, openFlowDraft, selectAutomation, showToast, useStore, type FlowDraftOpen } from '../../store'
import { Button, Callout, Card, CardButton, ChipButton, CodeEditor, Field, IconButton, LinkButton, MenuButton, MenuItem, Resizer, Select, Spinner, Status, Tab, TabList, TabPanel, Tabs, Tag, type CodeEditorMark } from '../../ui'
import { Composer, Conversation, GateLine } from '../assistant/AssistantView'
import { FlowGraphView, useSettled } from '../FlowDiagram'
import { FlowChangeList } from './FlowChanges'
import { flowTitle, SourceTags, STARTER_NAME } from './FlowStartFields'
import { RunFlowDialog } from './FlowsSection'
import { STEP_KIND } from './flowRunWords'

type PanelTab = 'assistant' | 'steps' | 'toml' | 'problems'
const EMPTY: ChatItem[] = []
const PANEL_MIN = 160
const PANEL_MAX = 720

/** "f:<id>" opens a saved flow (read from the flow list); "f:new" a draft that isn't saved yet. */
export function FlowStudio({ id, draft }: { id: string; draft?: FlowDraftOpen }) {
  const t = useT()
  const [listing, setListing] = useState<FlowListing | null | undefined>(id === 'new' ? null : undefined)
  useEffect(() => {
    if (id === 'new') return
    let live = true
    setListing(undefined)
    api
      .listFlows()
      .then((list) => live && setListing(list.find((f) => f.id === id) ?? null))
      .catch(() => live && setListing(null))
    return () => {
      live = false
    }
  }, [id])
  // A flow deleted elsewhere, or a stale id: back to the library.
  useEffect(() => {
    if (id !== 'new' && listing === null) selectAutomation(null)
  }, [id, listing])
  if (listing === undefined) return <Spinner label={t('flowStudio.loading')} />
  if (id !== 'new' && !listing) return null
  return <Studio key={listing?.id ?? `new:${draft?.toml.length ?? 0}`} listing={listing ?? undefined} draft={draft} />
}

function Studio({ listing, draft }: { listing?: FlowListing; draft?: FlowDraftOpen }) {
  const t = useT()
  const editable = !listing || listing.source === 'personal'
  const source: FlowSource = editable ? 'personal' : listing!.source
  const initial = listing?.toml ?? draft?.toml ?? FLOW_STARTERS[0].toml
  const [toml, setToml] = useState(initial)
  const [saved, setSaved] = useState<{ id?: string; toml: string; listing?: FlowListing }>(listing ? { id: listing.source === 'personal' ? listing.id : undefined, toml: initial, listing } : { toml: '' })
  const [starter, setStarter] = useState<FlowStarter['id'] | ''>(listing ? '' : draft ? '' : FLOW_STARTERS[0].id)
  const [refused, setRefused] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<PanelTab>('assistant')
  const [panel, setPanel] = useState(300)
  const [reveal, setReveal] = useState<number | undefined>(undefined)
  const [proposal, setProposal] = useState<FlowProposal | null>(null)
  // What became of each proposal, wherever it was answered (its card, or the bar over the graph).
  const [resolved, setResolved] = useState<Record<string, 'applied' | 'dismissed'>>({})
  const [ask, setAsk] = useState<{ text: string; at: number } | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const dirty = toml !== saved.toml

  const parsed = useMemo(() => parseFlow(toml, source, t), [toml, source, t])
  const problems = refused ?? ('problems' in parsed ? parsed.problems : [])
  const { warnings } = parsed
  // The graph follows the document once typing pauses; while it doesn't read, the last version that did stays drawn.
  const settled = useSettled(toml, 300)
  // A document put in whole (an applied proposal, a starter) is drawn at once, not after the pause.
  const [whole, setWhole] = useState<string | null>(null)
  const lastGood = useRef<Flow | undefined>(undefined)
  const flow = useMemo(() => {
    const read = settled === toml || whole === toml ? parsed : parseFlow(settled, source, t)
    if ('flow' in read) lastGood.current = read.flow
    return lastGood.current
  }, [settled, toml, whole, parsed, source, t])
  const proposed = useMemo(() => {
    if (!proposal) return undefined
    const read = parseFlow(proposal.toml, 'personal', t)
    return 'flow' in read ? read.flow : undefined
  }, [proposal, t])
  const graph = useMemo(() => (flow && proposed ? proposalGraph(flow, proposed, { t, locale: t.locale }) : flowGraph(flow, undefined, 'run', { t, locale: t.locale })), [flow, proposed, t])
  const blocks = useMemo(() => flowTomlBlocks(toml), [toml])
  const step = selected?.startsWith('step:') ? (proposed ?? flow)?.steps.find((s) => `step:${s.name}` === selected) : undefined
  const edgeIndex = selected?.startsWith('edge:') ? Number(selected.slice(5)) : undefined
  const edge = edgeIndex !== undefined ? graph.edges[edgeIndex] : undefined
  const name = listing && !dirty ? flowTitle(listing, t) : 'flow' in parsed ? parsed.flow.name : listing ? flowTitle(listing, t) : t('flowStudio.untitled')

  const marks: CodeEditorMark[] = useMemo(
    () => [
      ...problems.flatMap((p) => {
        const at = problemLine(p, toml)
        return at ? [{ line: at.line, tone: 'error' as const, message: p, ...(at.column ? { from: at.column } : {}) }] : []
      }),
      ...warnings.flatMap((w) => {
        const at = problemLine(w, toml)
        return at ? [{ line: at.line, tone: 'warn' as const, message: w }] : []
      })
    ],
    [problems, warnings, toml]
  )

  const showInToml = (stepName: string) => {
    const block = blocks.steps[stepName]
    setTab('toml')
    if (block) setReveal(block.from)
  }
  const choose = (id: string | null) => {
    setSelected(id)
    const name = id?.startsWith('step:') ? id.slice(5) : undefined
    if (name && blocks.steps[name]) setReveal(blocks.steps[name].from)
  }

  const save = async () => {
    const result = await attempt(() => api.savePersonalFlow({ ...(saved.id ? { id: saved.id } : {}), toml }))
    if (!result) return
    if ('problems' in result) {
      setRefused(result.problems)
      setTab('problems')
      return
    }
    setSaved({ id: result.flow.id, toml, listing: result.flow })
    showToast(t('flowStudio.saved', { name: result.flow.name }))
    if (!listing) selectAutomation(`f:${result.flow.id}`)
  }
  const remove = async () => {
    if (!saved.id) return
    if ((await attempt(async () => (await api.deletePersonalFlow(saved.id!), true))) === true) selectAutomation(null)
  }
  const copy = (text = toml) => openFlowDraft({ toml: text, notes: [t('flowStudio.copyNote', { name })] })

  const apply = (p: FlowProposal) => {
    setProposal(null)
    setResolved((r) => ({ ...r, [p.proposalId]: 'applied' }))
    if (!editable) return copy(p.toml)
    setWhole(p.toml)
    setToml(p.toml)
    setRefused(null)
    showToast(t('flowStudio.applied'))
  }

  return (
    <div className="flow-studio">
      <header className="flow-studio-head">
        <div className="flow-studio-title">
          <h1 className="auto-page-title">{name}</h1>
          <span className="flow-studio-tags">
            {listing ? <SourceTags flow={saved.listing ?? listing} /> : <Tag>{t('flowStudio.draft')}</Tag>}
            {'flow' in parsed && (
              <span className="faint small">
                {[t('automations.flows.steps', { count: parsed.flow.steps.length }), t('automations.flows.loops', { count: parsed.flow.loops.length }), t('automations.flows.gates', { count: parsed.flow.steps.filter((s) => s.kind === 'gate').length })].join(' · ')}
              </span>
            )}
          </span>
        </div>
        <span className="flow-studio-status">
          {problems.length > 0 ? <Status tone="error" label={t('automations.flows.problems', { count: problems.length })} /> : dirty && editable ? <Status tone="warn" label={t('flowStudio.unsaved')} /> : null}
        </span>
        {!listing && !saved.id && (
          <Field label={t('automations.flows.startFrom')} className="flow-studio-starter">
            {(c) => (
              <Select
                {...c}
                value={starter}
                options={[{ value: '', label: t('flowStudio.startFromDraft') }, ...FLOW_STARTERS.map((s) => ({ value: s.id, label: t(STARTER_NAME[s.id]) }))]}
                onChange={(id) => {
                  setStarter(id as FlowStarter['id'] | '')
                  const found = FLOW_STARTERS.find((s) => s.id === id)
                  const next = found ? found.toml : (draft?.toml ?? FLOW_STARTERS[0].toml)
                  setWhole(next)
                  setToml(next)
                  setRefused(null)
                }}
              />
            )}
          </Field>
        )}
        <span className="flow-studio-actions">
          <Button size="sm" icon={<Play size={12} />} disabled={!saved.listing || dirty || problems.length > 0} title={!saved.listing || dirty ? t('flowStudio.saveFirst') : undefined} onClick={() => setRunning(true)}>
            {t('automations.flows.run')}
          </Button>
          {editable ? (
            <Button size="sm" variant="primary" icon={<Save size={12} />} disabled={!dirty || problems.length > 0} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={<Copy size={12} />} onClick={() => copy()}>
              {t('automations.flows.copy')}
            </Button>
          )}
          {editable && saved.id && (
            <MenuButton look="icon" label={t('flowStudio.more', { name })} trigger={<MoreHorizontal size={14} />}>
              <MenuItem icon={<Copy size={14} />} onSelect={() => copy()}>
                {t('flowStudio.duplicate')}
              </MenuItem>
              <MenuItem icon={<Trash2 size={14} />} variant="danger" onSelect={() => void remove()}>
                {t('common.delete')}
              </MenuItem>
            </MenuButton>
          )}
        </span>
      </header>
      {!editable && (
        <Callout tone="info" role="note" className="flow-studio-note">
          {t('automations.flows.readOnly')}
        </Callout>
      )}
      {draft?.notes?.length ? (
        <Callout tone="info" role="note" className="flow-studio-note" title={t('flowStudio.notesTitle')}>
          <ul className="flow-problems">
            {draft.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <div className="flow-studio-canvas" data-inspecting={step || edge ? '' : undefined}>
        <div className="flow-studio-graph">
          {proposal && (
            <Callout
              tone="warn"
              role="status"
              className="flow-studio-proposing"
              actions={
                <>
                  <Button size="sm" variant="primary" onClick={() => apply(proposal)}>
                    {editable ? t('flowStudio.apply') : t('flowStudio.applyToCopy')}
                  </Button>
                  <Button size="sm" onClick={() => setProposal(null)}>
                    {t('flowStudio.hideProposal')}
                  </Button>
                </>
              }
            >
              {t('flowStudio.proposing')}
            </Callout>
          )}
          {!('flow' in parsed) && flow && (
            <Callout tone="warn" role="status" className="flow-studio-proposing">
              {t('flowStudio.stale')}
            </Callout>
          )}
          {flow ? <FlowGraphView graph={graph} start={`step:${flow.start}`} selected={selected} onSelect={choose} selectableEdges className="flow-studio-graph-view" /> : <p className="faint small">{t('flowStudio.noGraph')}</p>}
        </div>
        {(step || edge) && (
          <aside className="flow-studio-inspector" aria-label={t('flowStudio.inspector')}>
            <div className="flow-studio-inspector-head">
              <strong>{step ? t('flowStudio.stepTitle', { step: step.name }) : t('flowStudio.exitTitle')}</strong>
              <IconButton label={t('common.close')} onClick={() => setSelected(null)}>
                <X size={14} />
              </IconButton>
            </div>
            {step && (proposed ?? flow) && (
              <StepFacts
                flow={(proposed ?? flow)!}
                step={step}
                onGo={(target) => choose(target === FLOW_DONE ? null : `step:${target}`)}
                onToml={() => showInToml(step.name)}
                onAsk={() => {
                  setTab('assistant')
                  setAsk({ text: t('flowStudio.askAboutStep', { step: step.name }), at: Date.now() })
                }}
              />
            )}
            {edge && <EdgeFacts graph={graph} index={edgeIndex!} flow={proposed ?? flow} />}
          </aside>
        )}
      </div>

      <div className="flow-studio-panel" style={{ height: panel }}>
        <Resizer label={t('flowStudio.resize')} edge="top" value={panel} min={PANEL_MIN} max={PANEL_MAX} onResize={(size) => setPanel(size)} onReset={() => setPanel(300)} />
        <Tabs value={tab} onChange={(v) => setTab(v as PanelTab)} className="flow-studio-tabs">
          <TabList label={t('flowStudio.panel')}>
            <Tab value="assistant">
              <Sparkles size={13} aria-hidden /> {t('assistant.title')}
            </Tab>
            <Tab value="steps">{t('flowStudio.stepsTab')}</Tab>
            <Tab value="toml">{t('automations.flows.toml')}</Tab>
            <Tab value="problems">{t('flowStudio.problemsTab', { count: problems.length + warnings.length })}</Tab>
          </TabList>
          <TabPanel value="assistant" keepMounted className="flow-studio-tabpanel">
            <StudioAssistant toml={toml} source={source} editable={editable} describe={Boolean(draft?.describe)} ask={ask} proposal={proposal} resolved={resolved} onShow={setProposal} onApply={apply} onDismiss={(p) => setResolved((r) => ({ ...r, [p.proposalId]: 'dismissed' }))} />
          </TabPanel>
          <TabPanel value="steps" className="flow-studio-tabpanel">
            {flow ? <StepOutline flow={proposed ?? flow} selected={selected} onSelect={choose} /> : <p className="faint small">{t('flowStudio.noGraph')}</p>}
          </TabPanel>
          <TabPanel value="toml" className="flow-studio-tabpanel">
            <CodeEditor
              aria-label={t('automations.flows.toml')}
              className="flow-studio-code"
              value={toml}
              readOnly={!editable}
              onChange={(value) => {
                setToml(value)
                setRefused(null)
              }}
              tokenize={tokenizeFlowToml}
              highlight={step && blocks.steps[step.name] ? blocks.steps[step.name] : null}
              revealLine={reveal}
              onCaretLine={(line) => {
                const at = stepAtLine(toml, line)
                if (at) setSelected(`step:${at}`)
              }}
              marks={marks}
              markLabel={(m) => t(m.tone === 'error' ? 'flowStudio.markProblem' : 'flowStudio.markWarning', { line: m.line, message: m.message })}
            />
          </TabPanel>
          <TabPanel value="problems" className="flow-studio-tabpanel flow-studio-problems">
            {problems.length === 0 && warnings.length === 0 ? (
              <Callout tone="ok" role="status">
                {t('automations.flows.valid')}
              </Callout>
            ) : (
              <ul className="flow-studio-problem-list">
                {[...problems.map((text) => ({ text, tone: 'error' as const })), ...warnings.map((text) => ({ text, tone: 'warn' as const }))].map((p, i) => {
                  const at = problemLine(p.text, toml)
                  return (
                    <li key={i} className="flow-studio-problem">
                      <Status tone={p.tone} label={p.tone === 'error' ? t('flowStudio.problem') : t('flowStudio.warning')} />
                      <span>{p.text}</span>
                      {at && (
                        <LinkButton
                          size="sm"
                          onClick={() => {
                            setTab('toml')
                            setReveal(at.line)
                          }}
                        >
                          {t('flowStudio.goToLine', { line: at.line })}
                        </LinkButton>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </TabPanel>
        </Tabs>
      </div>
      {running && saved.listing && <RunFlowDialog flow={saved.listing} onClose={() => setRunning(false)} />}
    </div>
  )
}

/**
 * The graph as a list (its accessible equivalent, as the Flow and Lineage tabs have theirs): each step in the file's
 * order with its kind, who does it and where its exits go; choosing one selects it, as clicking it on the graph does.
 */
function StepOutline({ flow, selected, onSelect }: { flow: Flow; selected: string | null; onSelect: (id: string) => void }) {
  const t = useT()
  return (
    <ol className="flow-studio-outline" aria-label={t('flowStudio.stepsTab')}>
      {flow.steps.map((step) => {
        const id = `step:${step.name}`
        const out = flow.edges[step.name]
        const exits = out === undefined ? [t('flowGraph.end.done')] : typeof out === 'string' ? [out === FLOW_DONE ? t('flowGraph.end.done') : out] : Object.entries(out).map(([fact, to]) => `${fact} → ${to === FLOW_DONE ? t('flowGraph.end.done') : to}`)
        const persona = stepPersona(flow, step)
        return (
          <li key={step.name}>
            <CardButton className="flow-studio-outline-step" selected={selected === id} aria-pressed={selected === id} onClick={() => onSelect(id)}>
              <strong>{step.name}</strong>
              <span className="faint small">{[t(STEP_KIND[step.kind]), persona].filter(Boolean).join(' · ')}</span>
              <span className="small">{t('flowStudio.exitsLine', { exits: exits.join(', ') })}</span>
            </CardButton>
          </li>
        )
      })}
    </ol>
  )
}

/** A step's facts in the inspector: its kind and who does it, what it is told and shown, its exits and its loops. */
function StepFacts({ flow, step, onGo, onToml, onAsk }: { flow: Flow; step: FlowStep; onGo: (target: string) => void; onToml: () => void; onAsk: () => void }) {
  const t = useT()
  const loadouts = useStore((s) => s.snapshot?.settings.loadouts)
  const persona = stepPersona(flow, step)
  const agent = step as Partial<Extract<FlowStep, { kind: 'turn' }>> & { options?: string[]; show?: string[]; ask?: string; command?: string }
  const slot = agent.loadout ? loadouts?.[agent.loadout - 1] : undefined
  const out = flow.edges[step.name]
  const exits: { fact?: string; to: string }[] = out === undefined ? [{ to: FLOW_DONE }] : typeof out === 'string' ? [{ to: out }] : Object.entries(out).map(([fact, to]) => ({ fact, to }))
  const loops = loopsContaining(flow, step.name)
  const shown = [...(agent.context ?? []), ...(agent.show ?? [])]
  return (
    <div className="flow-studio-facts">
      <dl className="flow-run-facts">
        <dt className="faint">{t('flowStudio.fact.kind')}</dt>
        <dd>{t(STEP_KIND[step.kind])}</dd>
        {persona && (
          <>
            <dt className="faint">{t('flowStudio.fact.persona')}</dt>
            <dd>{persona}</dd>
          </>
        )}
        {(agent.model || slot || agent.agent) && (
          <>
            <dt className="faint">{t('flowStudio.fact.runsOn')}</dt>
            <dd>{agent.model ?? (slot ? t('flowStudio.fact.loadout', { n: agent.loadout!, model: slot.model }) : agent.agent)}</dd>
          </>
        )}
        {(agent.prompt || agent.ask || agent.command) && (
          <>
            <dt className="faint">{agent.ask ? t('flowStudio.fact.asks') : agent.command ? t('flowStudio.fact.runs') : t('flowStudio.fact.prompt')}</dt>
            <dd className="flow-studio-prompt">{agent.prompt ?? agent.ask ?? agent.command}</dd>
          </>
        )}
        {shown.length > 0 && (
          <>
            <dt className="faint">{t('flowStudio.fact.shown')}</dt>
            <dd className="flow-lens-tags">
              {shown.map((ref) => (
                <Tag key={ref} mono>
                  {ref}
                </Tag>
              ))}
            </dd>
          </>
        )}
        <dt className="faint">{t('flowStudio.fact.exits')}</dt>
        <dd>
          <ul className="flow-studio-exits">
            {exits.map((e) => (
              <li key={`${e.fact ?? ''}>${e.to}`}>
                {e.fact && <code>{e.fact}</code>} →{' '}
                <LinkButton size="sm" onClick={() => onGo(e.to)}>
                  {e.to === FLOW_DONE ? t('flowGraph.end.done') : e.to}
                </LinkButton>
              </li>
            ))}
          </ul>
        </dd>
        {loops.length > 0 && (
          <>
            <dt className="faint">{t('flowStudio.fact.loops')}</dt>
            <dd>{loops.map((l) => `${l.name} (${loopWords(l, t)})`).join(', ')}</dd>
          </>
        )}
      </dl>
      <span className="flow-studio-inspector-actions">
        <Button size="sm" icon={<ArrowUpRight size={12} />} onClick={onToml}>
          {t('flowStudio.showInToml')}
        </Button>
        <Button size="sm" icon={<MessageSquare size={12} />} onClick={onAsk}>
          {t('flowStudio.askAssistant')}
        </Button>
      </span>
    </div>
  )
}

const loopWords = (l: Flow['loops'][number], t: RendererT) =>
  [l.at_most.iterations !== undefined ? t('flowGraph.loop.atMostIterations', { max: l.at_most.iterations }) : null, l.at_most.minutes !== undefined ? t('flowGraph.loop.atMostMinutes', { max: l.at_most.minutes }) : null, l.at_most.cost !== undefined ? t('flowGraph.loop.atMostCost', { max: l.at_most.cost.toFixed(2) }) : null]
    .filter(Boolean)
    .join(' · ')

/** An exit's facts: where it leaves and goes, on which fact, and the loop it goes round when it goes back. */
function EdgeFacts({ graph, index, flow }: { graph: ReturnType<typeof flowGraph>; index: number; flow?: Flow }) {
  const t = useT()
  const e = graph.edges[index]
  if (!e) return null
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id
  const from = e.from.replace(/^step:/, '')
  const to = e.to.replace(/^step:/, '')
  const loops = flow ? flow.loops.filter((l) => l.over.includes(from) && l.over.includes(to)) : []
  return (
    <dl className="flow-run-facts">
      <dt className="faint">{t('flowStudio.fact.from')}</dt>
      <dd>{label(e.from)}</dd>
      <dt className="faint">{t('flowStudio.fact.to')}</dt>
      <dd>{label(e.to)}</dd>
      {e.label && (
        <>
          <dt className="faint">{t('flowStudio.fact.when')}</dt>
          <dd>
            <code>{e.label}</code>
          </dd>
        </>
      )}
      {loops.length > 0 && (
        <>
          <dt className="faint">{t('flowStudio.fact.loops')}</dt>
          <dd>{loops.map((l) => `${l.name} (${loopWords(l, t)})`).join(', ')}</dd>
        </>
      )}
    </dl>
  )
}

/**
 * The Assistant tab: a thread of its own whose every message carries the draft, so the assistant reads the flow and
 * proposes a whole new document (propose_flow). Each proposal is a card with its changes; the latest one is drawn on
 * the graph until it is applied or put away.
 */
function StudioAssistant({
  toml,
  source,
  editable,
  describe,
  ask,
  proposal,
  resolved,
  onShow,
  onApply,
  onDismiss
}: {
  toml: string
  source: FlowSource
  editable: boolean
  describe: boolean
  ask?: { text: string; at: number }
  proposal: FlowProposal | null
  resolved: Record<string, 'applied' | 'dismissed'>
  onShow: (p: FlowProposal | null) => void
  onApply: (p: FlowProposal) => void
  onDismiss: (p: FlowProposal) => void
}) {
  const t = useT()
  const assistant = useStore((s) => s.assistant)
  const [threadId, setThreadId] = useState<string | null>(null)
  const items = useStore((s) => (threadId ? (s.assistantItems[threadId] ?? EMPTY) : EMPTY))
  useEffect(() => {
    if (!assistant) void loadAssistant()
  }, [assistant])
  const gate = assistant?.gate ?? { state: 'checking' as const }
  const running = Boolean(assistant?.threads.find((th) => th.id === threadId)?.running)
  const canSend = gate.state === 'ready'

  // A new proposal is drawn on the graph as it arrives.
  const latest = useMemo(() => items.map(flowProposalOf).filter((p): p is FlowProposal => Boolean(p)).at(-1), [items])
  const shownLatest = useRef<string | null>(null)
  useEffect(() => {
    if (!latest || shownLatest.current === latest.proposalId || resolved[latest.proposalId]) return
    shownLatest.current = latest.proposalId
    onShow(latest)
  }, [latest, resolved, onShow])

  const send = async (text: string) => {
    const sent = await attempt(() => api.assistantSend(threadId, text, false, { flow: { toml, source } }))
    if (!sent) return false
    setThreadId(sent.threadId)
    return true
  }

  const renderProposal = (p: FlowProposal) => {
    const state = resolved[p.proposalId]
    const showing = proposal?.proposalId === p.proposalId
    return (
      <Card className="flow-studio-proposal">
        <strong>{t('assistant.flowProposal.title')}</strong>
        {p.summary && <span>{p.summary}</span>}
        {p.changes.length ? <FlowChangeList changes={p.changes} label={t('assistant.flowProposal.changes', { count: p.changes.length })} /> : <span className="small">{t('assistant.flowProposal.replaces')}</span>}
        {!state && p.base !== toml && (
          <Callout tone="warn" role="note">
            {t('flowStudio.baseChanged')}
          </Callout>
        )}
        {state ? (
          <Status tone={state === 'applied' ? 'ok' : 'off'} label={state === 'applied' ? t('flowStudio.appliedState') : t('flowStudio.dismissedState')} />
        ) : (
          <span className="flow-studio-proposal-actions">
            <Button
              size="sm"
              variant="primary"
              onClick={() => onApply(p)}
            >
              {editable ? t('flowStudio.apply') : t('flowStudio.applyToCopy')}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onDismiss(p)
                if (showing) onShow(null)
              }}
            >
              {t('flowStudio.discard')}
            </Button>
            <Button size="sm" variant="ghost" aria-pressed={showing} onClick={() => onShow(showing ? null : p)}>
              {showing ? t('flowStudio.hideOnGraph') : t('flowStudio.showOnGraph')}
            </Button>
          </span>
        )}
      </Card>
    )
  }

  const suggestions = describe ? [] : [t('flowStudio.suggest.explain'), t('flowStudio.suggest.gate'), t('flowStudio.suggest.cheaper')]
  return (
    <div className="flow-studio-assistant">
      <div className="flow-studio-assistant-log">
        {items.length ? (
          <Conversation items={items} title={t('flowStudio.assistantTitle')} threadId={threadId} renderProposal={renderProposal} />
        ) : (
          <div className="flow-studio-assistant-empty">
            <p className="small">{describe ? t('flowStudio.describeIntro') : t('flowStudio.assistantIntro')}</p>
            {canSend && suggestions.length > 0 && (
              <span className="flow-studio-suggestions">
                {suggestions.map((s) => (
                  <ChipButton key={s} onClick={() => void send(s)}>
                    {s}
                  </ChipButton>
                ))}
              </span>
            )}
          </div>
        )}
      </div>
      {!canSend && gate.state !== 'checking' && <GateLine gate={gate} onUseAlternative={() => undefined} />}
      <Composer disabled={!canSend} running={running} threadId={threadId} useAlternative={false} onSend={send} placeholder={describe && !items.length ? t('flowStudio.describePlaceholder') : t('flowStudio.askPlaceholder')} draft={ask} />
    </div>
  )
}
