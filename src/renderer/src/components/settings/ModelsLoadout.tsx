// Settings → Default models → Loadout: five slots of favourite models (slot 1
// is the default for new chats) and each agent's models to drag into them.
import { Check, GripVertical, RefreshCw, TriangleAlert, X, Zap } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  AGENT_ORDER,
  AGENTS,
  effortLabel,
  isSameModel,
  modelInfo,
  modelsFor,
  type AgentKind,
  type Loadout,
  type ModelInfo
} from '../../../../shared/agents'
import { useT } from '../../i18n'
import { api, attempt, availableAgents, getState, openSettingsPage, useStore } from '../../store'
import { AgentIcon, ModelChooser, opencodeModelParts } from '../composer/AgentPicker'
import { Button, Card, CardButton, IconButton, LinkButton, Popover, Spinner } from '../../ui'
import { saveSettings, useSettings } from './controls'

const MAX_SLOTS = 5
// A drop this close to a slot still counts as on it.
const TOLERANCE = 16
// The pointer must move this far before a press becomes a drag.
const THRESHOLD = 4

/** Close a popover on a click outside `inside()` or on Escape (without closing settings). */
export function useDismiss(open: boolean, inside: () => Element | null | undefined, onClose: () => void): void {
  const latest = useRef({ inside, onClose })
  latest.current = { inside, onClose }
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      const el = latest.current.inside()
      if (el && !el.contains(e.target as Node)) latest.current.onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      latest.current.onClose()
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])
}

type DragSource = { kind: 'slot'; index: number } | { kind: 'model'; choice: Loadout }

interface DragState {
  source: DragSource
  pointerId: number
  startX: number
  startY: number
  // Where the pointer holds the element, and the element's size.
  dx: number
  dy: number
  width: number
  height: number
  x: number
  y: number
  active: boolean
  // The slot under the pointer.
  over: number | null
}

type PointerHandler = (e: ReactPointerEvent<HTMLElement>) => void
interface DragHandlers {
  onPointerDown: PointerHandler
  onPointerMove: PointerHandler
  onPointerUp: PointerHandler
  onPointerCancel: () => void
}

/** Where a drop would land: the slot that changes, or null for none. */
function landing(drag: DragState | null, count: number): number | null {
  if (!drag?.active || drag.over === null) return null
  if (drag.source.kind === 'slot') return Math.min(drag.over, count - 1)
  if (drag.over < count) return drag.over
  return count < MAX_SLOTS ? count : null
}

function choiceFor(model: ModelInfo): Loadout {
  return { agent: model.agent, model: model.id, effort: model.defaultEffort, fast: false }
}

function modelName(agent: AgentKind, id: string): string {
  const info = modelInfo(agent, id)
  return agent === 'opencode' ? opencodeModelParts(info).name : info.label
}

export function LoadoutEditor() {
  const t = useT()
  const saved = useSettings().loadouts
  // Shown until the saved list comes back, so a drop doesn't flicker.
  const [optimistic, setOptimistic] = useState<Loadout[] | null>(null)
  const loadouts = optimistic ?? saved
  const saves = useRef(0)
  const [chooser, setChooser] = useState<number | null>(null)
  const [equipped, setEquipped] = useState<number | null>(null)
  const equipTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const slotRefs = useRef<(HTMLDivElement | null)[]>([])
  const dragRef = useRef<DragState | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)

  // Ask agents that haven't reported their models yet.
  useEffect(() => {
    const s = getState()
    const available = availableAgents(s)
    for (const agent of AGENT_ORDER) {
      const entry = s.snapshot?.catalog.agents[agent]
      if (available[agent] && !entry?.fetchedAt && !entry?.loading && !entry?.error) void api.refreshModels(agent).catch(() => undefined)
    }
    return () => clearTimeout(equipTimer.current)
  }, [])

  // Escape cancels a drag.
  useEffect(() => {
    if (!drag?.active) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      dragRef.current = null
      setDrag(null)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [drag?.active])

  const save = async (next: Loadout[], equip?: number) => {
    const n = ++saves.current
    setOptimistic(next)
    if (equip !== undefined) {
      clearTimeout(equipTimer.current)
      setEquipped(equip)
      equipTimer.current = setTimeout(() => setEquipped(null), 450)
    }
    await saveSettings({ loadouts: next })
    if (n === saves.current) setOptimistic(null)
  }

  const replace = (index: number, choice: Loadout) => void save(loadouts.map((l, i) => (i === index ? choice : l)))
  const remove = (index: number) => {
    if (loadouts.length <= 1) return
    setChooser(null)
    void save(loadouts.filter((_, i) => i !== index))
  }
  const add = (choice: Loadout) => {
    if (loadouts.length < MAX_SLOTS) void save([...loadouts, choice], loadouts.length)
    else void save(loadouts.map((l, i) => (i === MAX_SLOTS - 1 ? choice : l)), MAX_SLOTS - 1)
  }

  /** The slot nearest the pointer, within the tolerance. */
  const hitTest = (x: number, y: number): number | null => {
    let best: number | null = null
    let bestDistance = Infinity
    slotRefs.current.forEach((el, i) => {
      if (!el) return
      const r = el.getBoundingClientRect()
      if (x < r.left - TOLERANCE || x > r.right + TOLERANCE || y < r.top - TOLERANCE || y > r.bottom + TOLERANCE) return
      const distance = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2))
      if (distance < bestDistance) {
        best = i
        bestDistance = distance
      }
    })
    return best
  }

  const drop = (source: DragSource, target: number | null) => {
    const count = loadouts.length
    if (source.kind === 'slot') {
      // Dropped outside every slot: remove it, unless it's the last one.
      if (target === null) return remove(source.index)
      const to = Math.min(target, count - 1)
      if (to === source.index) return
      const next = loadouts.slice()
      const [moved] = next.splice(source.index, 1)
      next.splice(to, 0, moved)
      void save(next, to)
      return
    }
    if (target === null) return
    if (target < count) void save(loadouts.map((l, i) => (i === target ? source.choice : l)), target)
    else if (count < MAX_SLOTS) void save([...loadouts, source.choice], count)
  }

  /** Pointer handlers that drag `source`; a press without movement calls onTap. */
  const bind = (source: DragSource, onTap?: () => void): DragHandlers => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      const rect = e.currentTarget.getBoundingClientRect()
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // Not an active pointer (synthetic events); the drag still works over the element.
      }
      dragRef.current = {
        source,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        dx: e.clientX - rect.left,
        dy: e.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        x: e.clientX,
        y: e.clientY,
        active: false,
        over: null
      }
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < THRESHOLD) return
      if (!d.active) setChooser(null)
      const next = { ...d, active: true, x: e.clientX, y: e.clientY, over: hitTest(e.clientX, e.clientY) }
      dragRef.current = next
      setDrag(next)
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      dragRef.current = null
      setDrag(null)
      if (d.active) drop(d.source, hitTest(e.clientX, e.clientY))
      else onTap?.()
    },
    onPointerCancel: () => {
      dragRef.current = null
      setDrag(null)
    }
  })

  const target = landing(drag, loadouts.length)
  const removing = Boolean(drag?.active && drag.source.kind === 'slot' && drag.over === null && loadouts.length > 1)
  const liftedSlot = drag?.active && drag.source.kind === 'slot' ? drag.source.index : null
  const liftedModel = drag?.active && drag.source.kind === 'model' ? drag.source.choice : null

  return (
    <div className="ml-loadout">
      <div className="ml-slots">
        {Array.from({ length: MAX_SLOTS }, (_, i) => {
          const loadout = loadouts[i]
          return (
            <div
              key={i}
              ref={(el) => {
                slotRefs.current[i] = el
              }}
              className={`ml-slot ${loadout ? 'filled' : 'empty'}`}
            >
              {loadout ? (
                <>
                  <Popover
                    className="ml-slot-pop"
                    open={chooser === i}
                    onOpenChange={(next) => setChooser(next ? i : null)}
                    side="bottom"
                    align={i >= 3 ? 'end' : 'start'}
                    label={t('loadout.slotModel', { n: i + 1 })}
                    trigger={(pop) => (
                      <CardButton
                        ref={pop.ref}
                        className={`ml-card ${equipped === i ? 'equip' : ''}`}
                        selected={chooser === i}
                        target={target === i}
                        lifted={liftedSlot === i}
                        aria-label={t('loadout.slot.label', { n: i + 1, model: modelName(loadout.agent, loadout.model) })}
                        aria-haspopup={pop['aria-haspopup']}
                        aria-expanded={pop['aria-expanded']}
                        aria-controls={pop['aria-controls']}
                        title={t('loadout.changeModel')}
                        {...bind({ kind: 'slot', index: i }, pop.onClick)}
                        // Pointer presses open it on release; this is Enter and Space.
                        onClick={(e) => e.detail === 0 && pop.onClick()}
                      >
                        <CardFace loadout={loadout} index={i} />
                      </CardButton>
                    )}
                  >
                    <ModelChooser
                      inPopover
                      label={t('loadout.slotModel', { n: i + 1 })}
                      value={loadout}
                      onChoose={(choice) => {
                        setChooser(null)
                        void save(loadouts.map((l, n) => (n === i ? choice : l)), i)
                      }}
                      onEffort={(effort) => replace(i, { ...loadout, effort })}
                      onFast={(fast) => replace(i, { ...loadout, fast })}
                      onClose={() => setChooser(null)}
                    />
                  </Popover>
                  {loadouts.length > 1 && (
                    <IconButton className="ml-remove" variant="badge" label={t('loadout.removeSlot', { n: i + 1 })} onClick={() => remove(i)}>
                      <X size={11} strokeWidth={2.5} />
                    </IconButton>
                  )}
                </>
              ) : (
                <Card empty target={target === i} className="ml-empty">
                  <span className="ml-empty-text">{i === loadouts.length ? t('loadout.dropHere') : t('loadout.empty')}</span>
                </Card>
              )}
              <span className="ml-slot-num" aria-hidden>
                {i + 1}
              </span>
            </div>
          )
        })}
      </div>

      <div className="ml-columns">
        {AGENT_ORDER.map((agent) => (
          <AgentColumn key={agent} agent={agent} loadouts={loadouts} lifted={liftedModel} bind={bind} onAdd={add} />
        ))}
      </div>

      {drag?.active &&
        createPortal(
          <Card
            interactive
            ghost
            size={drag.source.kind === 'slot' ? 'md' : 'sm'}
            tone={removing ? 'danger' : 'default'}
            className={`ml-ghost ${drag.source.kind === 'slot' ? 'ml-card' : `ml-model ${drag.source.choice.agent === 'opencode' ? 'two-line' : ''}`}`}
            style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.width, height: drag.height }}
            aria-hidden
          >
            {drag.source.kind === 'slot' ? (
              loadouts[drag.source.index] && <CardFace loadout={loadouts[drag.source.index]} index={drag.source.index} />
            ) : (
              <ModelRowFace choice={drag.source.choice} equipped={false} />
            )}
          </Card>,
          document.body
        )}
    </div>
  )
}

function CardFace({ loadout, index }: { loadout: Loadout; index: number }) {
  const t = useT()
  const available = useStore((s) => availableAgents(s))[loadout.agent]
  const info = modelInfo(loadout.agent, loadout.model)
  const parts = loadout.agent === 'opencode' ? opencodeModelParts(info) : null
  const effort = info.efforts.length > 0 ? effortLabel(loadout.effort ?? info.defaultEffort, t) : ''
  return (
    <>
      {index === 0 && <span className="ml-default">{t('common.default')}</span>}
      <span className="ml-card-icon">
        <AgentIcon agent={loadout.agent} size={26} />
      </span>
      <span className="ml-card-label">{parts?.name ?? info.label}</span>
      <span className="ml-card-meta">
        {!available && (
          <span className="ml-card-warn" title={t('loadout.notSetUp', { agent: AGENTS[loadout.agent].label })}>
            <TriangleAlert size={10} />
          </span>
        )}
        <span className="ml-card-meta-text">{parts ? parts.providerLabel : effort}</span>
        {loadout.fast && <Zap size={10} className="fast-on" />}
      </span>
    </>
  )
}

function ModelRowFace({ choice, equipped }: { choice: Loadout; equipped: boolean }) {
  const t = useT()
  const info = modelInfo(choice.agent, choice.model)
  const parts = choice.agent === 'opencode' ? opencodeModelParts(info) : null
  return (
    <>
      <span className="ml-model-text">
        <span className="ml-model-label">{parts?.name ?? info.label}</span>
        {parts && <span className="ml-model-provider">{parts.providerLabel}</span>}
      </span>
      {equipped && <Check size={13} className="ml-model-check" aria-label={t('loadout.inLoadout')} />}
      <GripVertical size={13} className="ml-model-grip" aria-hidden />
    </>
  )
}

interface AgentColumnProps {
  agent: AgentKind
  loadouts: Loadout[]
  // The model being dragged, if any.
  lifted: Loadout | null
  bind: (source: DragSource) => DragHandlers
  onAdd: (choice: Loadout) => void
}

function AgentColumn({ agent, loadouts, lifted, bind, onAdd }: AgentColumnProps) {
  const t = useT()
  const available = useStore((s) => availableAgents(s))[agent]
  // Subscribing re-renders the column when the agent reports new models.
  const entry = useStore((s) => s.snapshot!.catalog.agents[agent])
  const chosenOpencode = useStore((s) => s.snapshot!.settings.opencodeModels)
  const label = AGENTS[agent].label

  const configure = (
    <Button size="sm" className="ml-configure" onClick={() => openSettingsPage({ section: 'agents', agent })}>
      {t('loadout.configure', { agent: label })}
    </Button>
  )

  let content
  if (!available || (agent === 'opencode' && chosenOpencode.length === 0)) {
    content = configure
  } else if (entry?.loading && !entry.models.length) {
    content = (
      <div className="ml-col-state">
        <Spinner size={13} /> {t('loadout.loading')}
      </div>
    )
  } else if (entry?.error && !entry.models.length) {
    content = (
      <div className="ml-col-state error">
        <span>{t('loadout.loadFailed')}</span>
        <LinkButton size="sm" title={entry.error} onClick={() => void attempt(() => api.refreshModels(agent))}>
          <RefreshCw size={11} aria-hidden /> {t('common.retry')}
        </LinkButton>
      </div>
    )
  } else {
    // OpenCode lists only the models chosen on the Agents page.
    const models = agent === 'opencode' ? chosenOpencode.map((id) => modelInfo('opencode', id)) : modelsFor(agent)
    content = models.map((m) => {
      const choice = choiceFor(m)
      const equipped = loadouts.some((l) => l.agent === agent && isSameModel(agent, l.model, m.id))
      const parts = agent === 'opencode' ? opencodeModelParts(m) : null
      const isLifted = lifted?.agent === agent && isSameModel(agent, lifted.model, m.id)
      return (
        <CardButton
          key={m.id}
          size="sm"
          lifted={isLifted}
          className={`ml-model ${parts ? 'two-line' : ''}`}
          aria-label={
            parts
              ? t(equipped ? 'loadout.addProviderIn' : 'loadout.addProvider', { model: parts.name, provider: parts.providerLabel })
              : t(equipped ? 'loadout.addIn' : 'loadout.add', { model: m.label })
          }
          title={t('loadout.dragHint')}
          {...bind({ kind: 'model', choice })}
          // Keyboard only (Enter or Space); a mouse drags instead.
          onClick={(e) => e.detail === 0 && onAdd(choice)}
        >
          <ModelRowFace choice={choice} equipped={equipped} />
        </CardButton>
      )
    })
  }

  return (
    <div className="ml-col">
      <div className="ml-col-head">
        <AgentIcon agent={agent} /> {label}
      </div>
      <div className="ml-col-list">{content}</div>
    </div>
  )
}
