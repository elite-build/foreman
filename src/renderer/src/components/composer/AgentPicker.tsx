import { ArrowRightLeft, Braces, Check, ChevronDown, EyeOff, MessageSquarePlus, MousePointer2, Search, Settings2, Sparkle, SquareTerminal, Zap, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  AGENT_ORDER,
  AGENTS,
  allModels,
  effortAxisLabel,
  effortLabel,
  isSameModel,
  modelInfo,
  modelsFor,
  supportsPlan,
  type AgentKind,
  type EffortLevel,
  type Loadout,
  type ModelInfo
} from '../../../../shared/agents'
import { isModelHidden, pickerModels, type HiddenModels } from '../../../../shared/modelVisibility'
import { PROVIDER_KEYS } from '../../../../shared/providers'
import type { Session } from '../../../../shared/types'
import { continueBlock, modelChoiceAction } from '../../../../shared/switchAgent'
import { api, attempt, availableAgents, getState, modKey, newChat, openSettingsPage, useStore } from '../../store'
import { t as storeT, useT } from '../../i18n'
import { ActionRow, ChipButton, Kbd, LinkButton, Popover, Segmented, Switch, TextInput } from '../../ui'
import { AgentMonogram } from '../agents/AgentMonogram'
import { ManageAgentsRow, PickerAgentGroups } from '../agents/PickerAgents'
import { openTerminalAgent } from '../agents/TerminalAgents'
import '../settings/agents.css'
import '../switchAgent.css'

const AGENT_ICON: Partial<Record<string, LucideIcon>> = {
  claude: Sparkle,
  codex: Braces,
  cursor: MousePointer2,
  opencode: SquareTerminal
}

/** The Full agents' icons; every other catalog agent (#22) shows its two-letter monogram. */
export function AgentIcon({ agent, size = 13 }: { agent: AgentKind | string; size?: number }) {
  const Icon = AGENT_ICON[agent]
  if (!Icon) return <AgentMonogram agent={agent} />
  return <Icon size={size} className={`agent-icon ${agent}`} />
}

// ---- OpenCode model names ----

function providerName(id: string): string {
  if (!id) return storeT('agentPicker.provider.other')
  const envVar = `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  const known = PROVIDER_KEYS.find((p) => p.envVar === envVar)
  if (known) return known.label
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * OpenCode ids look like "anthropic/claude-sonnet-4-5", and labels may carry
 * the provider too ("Anthropic/Claude Sonnet 4.5"). Splits off the provider.
 */
export function opencodeModelParts(model: Pick<ModelInfo, 'id' | 'label'>): { provider: string; providerLabel: string; name: string } {
  const idSlash = model.id.indexOf('/')
  const labelSlash = model.label.indexOf('/')
  const fromLabel = model.label !== model.id && labelSlash > 0
  const provider = idSlash > 0 ? model.id.slice(0, idSlash) : fromLabel ? model.label.slice(0, labelSlash).trim().toLowerCase() : ''
  const providerLabel = fromLabel ? model.label.slice(0, labelSlash).trim() : providerName(provider)
  const name = fromLabel ? model.label.slice(labelSlash + 1).trim() : idSlash > 0 && model.label === model.id ? model.id.slice(idSlash + 1) : model.label
  return { provider, providerLabel, name: name || model.id }
}

/** Apply a model choice in this tab. O1: with another agent in a chat with history, this continues the chat with that agent. */
export async function chooseModel(session: Session, choice: Loadout): Promise<void> {
  await attempt(() =>
    api.updateSession(session.id, { agent: choice.agent, model: choice.model, effort: choice.effort, fastMode: choice.fast })
  )
}

/** O1 "Open a new chat instead": the other agent starts empty in a new tab, and this chat stays as it is. */
export async function openChatWith(session: Session, choice: Loadout): Promise<void> {
  await newChat(session.workspaceId, { agent: choice.agent, model: choice.model, effort: choice.effort, fastMode: choice.fast })
}

// O1: a loadout shortcut for another agent opens the picker on the same choice the picker offers.
const ASK_SWITCH = 'foreman:o1-ask-switch'

function matches(model: ModelInfo, query: string): boolean {
  const q = query.toLowerCase()
  const provider = model.agent === 'opencode' ? opencodeModelParts(model).providerLabel.toLowerCase() : ''
  return (
    model.label.toLowerCase().includes(q) ||
    model.id.toLowerCase().includes(q) ||
    AGENTS[model.agent].label.toLowerCase().includes(q) ||
    provider.includes(q)
  )
}

export interface ModelChooserProps {
  // The current choice; its model drives the effort and fast controls.
  value: Loadout
  onChoose: (choice: Loadout) => void
  onEffort: (effort: EffortLevel) => void
  onFast: (fast: boolean) => void
  // Close the chooser (called before it navigates to settings).
  onClose: () => void
  label?: string
  // Extra classes on the popover, e.g. "below" to open downwards.
  className?: string
  // Shown above the agent tabs while not searching (the composer's loadouts).
  top?: ReactNode
  // Text at the end of a model row, e.g. "Opens in new chat".
  note?: (model: ModelInfo) => ReactNode
  footer?: ReactNode
  fastHint?: string
  // #22: start a Terminal agent (shown only where there's a workspace to run it in).
  onTerminalAgent?: (agent: string) => void
  // O1: a model of another agent waiting on "Continue here or open a new chat" (its row is marked), and that choice, shown in place of the controls.
  pending?: Pick<Loadout, 'agent' | 'model'>
  choice?: ReactNode
  // O1: the Terminal agents' hover note in a chat they can't continue.
  terminalNote?: (agent: string) => string
  // Inside a Popover, which draws the panel and takes its name: no positioning or surface of its own.
  inPopover?: boolean
  // Keys pressed anywhere in the chooser (AgentPicker answers Enter and Escape while a choice is waiting).
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void
}

const NO_HIDDEN: HiddenModels = {}

/** Search, agent tabs, model list, effort and fast mode: the body of every model picker. */
export function ModelChooser({ value, onChoose, onEffort, onFast, onClose, label, className, top, note, footer, fastHint, onTerminalAgent, pending, choice, terminalNote, inPopover, onKeyDown }: ModelChooserProps) {
  const t = useT()
  const available = useStore((s) => availableAgents(s))
  // Subscribing re-renders the chooser when an agent reports new models.
  const catalog = useStore((s) => s.snapshot!.catalog)
  const chosenOpencode = useStore((s) => s.snapshot!.settings.opencodeModels)
  // O8: models hidden in Settings → Agents; "N hidden · Show" reveals them until the picker closes.
  const hiddenModels = useStore((s) => s.snapshot!.settings.hiddenModels) ?? NO_HIDDEN
  const [revealHidden, setRevealHidden] = useState(false)
  const [query, setQuery] = useState('')
  const [agentTab, setAgentTab] = useState<AgentKind>(value.agent)
  const entry = catalog.agents[agentTab]
  const model = modelInfo(value.agent, value.model)
  const effort = value.effort ?? model.defaultEffort
  const q = query.trim()

  // The first time a tab is opened without a list, ask the agent for one.
  useEffect(() => {
    if (available[agentTab] && !entry?.fetchedAt && !entry?.loading && !entry?.error) void api.refreshModels(agentTab).catch(() => undefined)
  }, [agentTab, entry, available])

  const { listed, hiddenLeft } = useMemo(() => {
    // Search still finds hidden models (each row says so).
    if (q) return { listed: allModels().filter((m) => available[m.agent] && (m.agent !== 'opencode' || chosenOpencode.includes(m.id)) && matches(m, q)), hiddenLeft: 0 }
    // OpenCode can offer hundreds of models; only the chosen ones are listed.
    if (agentTab === 'opencode') return { listed: chosenOpencode.map((id) => modelInfo('opencode', id)), hiddenLeft: 0 }
    const models = modelsFor(agentTab)
    if (!models.length && !entry?.loading) return { listed: [modelInfo(agentTab, '')], hiddenLeft: 0 }
    // The current model always shows; revealed hidden models go under the others.
    const split = pickerModels(models, hiddenModels, value)
    return revealHidden ? { listed: [...split.shown, ...split.hidden], hiddenLeft: 0 } : { listed: split.shown, hiddenLeft: split.hidden.length }
    // modelsFor reads the catalog the store keeps current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, agentTab, available, entry, catalog, chosenOpencode, hiddenModels, revealHidden, value.agent, value.model])

  const choose = (m: ModelInfo) => {
    const same = m.agent === value.agent && isSameModel(m.agent, m.id, value.model)
    onChoose(same ? value : { agent: m.agent, model: m.id, effort: m.defaultEffort, fast: false })
  }

  const openAgentSettings = (agent: string) => {
    onClose()
    openSettingsPage({ section: 'agents', agent })
  }

  const showEditOpencode = !q && agentTab === 'opencode'

  return (
    // Standalone (the callers that place it themselves) it is a named group; in a Popover the panel is the dialog.
    <div className={`${inPopover ? 'picker-body' : 'picker'} ${className ?? ''}`} role={inPopover ? undefined : 'group'} aria-label={inPopover ? undefined : (label ?? t('agentPicker.label'))} onKeyDown={onKeyDown}>
      <div className="picker-search">
        <Search size={13} aria-hidden />
        <TextInput autoFocus aria-label={t('agentPicker.search')} placeholder={t('agentPicker.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {!q && top}

      {/* #22: enabled agents only, grouped Full / Chat / Terminal. */}
      {!q && (
        <PickerAgentGroups
          current={agentTab}
          onPick={(agent) => setAgentTab(agent)}
          onSetUp={openAgentSettings}
          terminalNote={terminalNote}
          onTerminal={
            onTerminalAgent &&
            ((agent) => {
              onClose()
              onTerminalAgent(agent)
            })
          }
        />
      )}

      <div className="picker-section picker-models">
        {listed.length === 0 && !showEditOpencode && (
          <div className="faint small pad">{entry?.loading && !q ? t('agentPicker.asking', { agent: AGENTS[agentTab].label }) : t('agentPicker.noModels')}</div>
        )}
        {!q && entry?.error && (
          <div className="picker-error small">
            <span>{t('agentPicker.refreshFailed', { error: entry.error })}</span>
            <LinkButton size="sm" onClick={() => void attempt(() => api.refreshModels(agentTab))}>
              {t('common.retry')}
            </LinkButton>
          </div>
        )}
        {listed.map((m) => {
          const current = m.agent === value.agent && isSameModel(m.agent, m.id, value.model)
          const waiting = pending && m.agent === pending.agent && isSameModel(m.agent, m.id, pending.model)
          const parts = m.agent === 'opencode' ? opencodeModelParts(m) : null
          return (
            <ActionRow
              key={`${m.agent}:${m.id}`}
              selected={current}
              pending={Boolean(waiting)}
              onPress={() => choose(m)}
              primaryProps={{ className: 'picker-row-main' }}
            >
              <AgentIcon agent={m.agent} />
              <span className="picker-row-label">{parts ? parts.name : m.label}</span>
              {parts ? (
                <span className="faint small picker-row-meta">{parts.providerLabel}</span>
              ) : (
                q && <span className="faint small picker-row-meta">{AGENTS[m.agent].label}</span>
              )}
              {isModelHidden(hiddenModels, m.agent, m.id) && <span className="faint small picker-row-meta">{t('models.picker.hiddenTag')}</span>}
              <span className="spacer" />
              {note?.(m)}
              {current && <Check size={13} className="picker-current" aria-hidden />}
            </ActionRow>
          )
        })}
        {hiddenLeft > 0 && (
          <ActionRow onPress={() => setRevealHidden(true)} primaryProps={{ className: 'picker-row-main' }}>
            <EyeOff size={12} aria-hidden />
            <span className="faint small">{t('models.picker.hidden', { count: hiddenLeft })}</span>
          </ActionRow>
        )}
        {showEditOpencode && (
          <ActionRow onPress={() => openAgentSettings('opencode')} primaryProps={{ className: 'picker-row-main' }}>
            <Settings2 size={13} aria-hidden />
            <span>{t('agentPicker.chooseOpencode')}</span>
          </ActionRow>
        )}
      </div>

      {choice ?? (
      <>
      <div className="picker-section picker-controls">
        <div className="picker-control">
          <span className="picker-label">{effortAxisLabel(value.agent, t)}</span>
          {model.efforts.length === 0 ? (
            <span className="faint small">{t('agentPicker.notSupported')}</span>
          ) : (
            <Segmented
              plain
              label={effortAxisLabel(value.agent, t)}
              value={effort}
              options={model.efforts.map((level) => ({ value: level, label: effortLabel(level, t) }))}
              onChange={onEffort}
            />
          )}
        </div>
        <div className="picker-control">
          <span className="picker-label">
            <Zap size={12} /> {t('agentPicker.fast')}
          </span>
          <Switch
            label={t('agentPicker.fast')}
            title={model.supportsFast ? fastHint : t('agentPicker.fastUnsupported')}
            checked={value.fast}
            disabled={!model.supportsFast}
            onChange={onFast}
          />
        </div>
      </div>

      <ManageAgentsRow onClose={onClose} />
      </>
      )}
      {footer}
    </div>
  )
}

export function AgentPicker({
  session,
  hasHistory,
  open,
  onOpenChange
}: {
  session: Session
  hasHistory: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const loadouts = useStore((s) => s.snapshot!.settings.loadouts)
  const platform = useStore((s) => s.snapshot!.platform)
  const available = useStore((s) => availableAgents(s))
  // O1: another agent's model, waiting on "Continue this chat with …" or "Open a new chat instead".
  const [pending, setPending] = useState<Loadout | null>(null)
  const model = modelInfo(session.agent, session.model)
  const effort = session.effort ?? model.defaultEffort
  const mod = modKey(platform)
  const blocked = pending ? continueBlock(session, pending.agent) : null

  const close = () => {
    setPending(null)
    onOpenChange(false)
  }
  const continueHere = async (choice: Loadout) => {
    close()
    await chooseModel(session, choice)
  }
  const newChatInstead = async (choice: Loadout) => {
    close()
    await openChatWith(session, choice)
  }

  useEffect(() => {
    if (!open) setPending(null)
  }, [open])

  // A loadout shortcut (⌘⌃N) for another agent lands on the same choice.
  useEffect(() => {
    const ask = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string; choice: Loadout }>).detail
      if (detail.sessionId !== session.id) return
      onOpenChange(true)
      setPending(detail.choice)
    }
    window.addEventListener(ASK_SWITCH, ask)
    return () => window.removeEventListener(ASK_SWITCH, ask)
  }, [session.id, onOpenChange])

  // Keys inside the picker. While a choice waits, Escape steps back from it first (before the Popover closes) and Enter
  // continues (⌘Enter opens a new chat).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!pending || e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setPending(null)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const modDown = platform === 'darwin' ? e.metaKey : e.ctrlKey
      if (modDown) void newChatInstead(pending)
      else if (!blocked) void continueHere(pending)
    }
  }

  const pick = async (choice: Loadout) => {
    if (modelChoiceAction(session, hasHistory, choice) === 'ask') return setPending(choice)
    await continueHere(choice)
  }

  const setEffort = (effort: EffortLevel) => void attempt(() => api.updateSession(session.id, { effort }))
  const setFast = (fastMode: boolean) => void attempt(() => api.updateSession(session.id, { fastMode }))
  const switches = (agent: AgentKind) => agent !== session.agent && hasHistory

  const loadoutSection = loadouts.length > 0 && (
    <div className="picker-section">
      <div className="picker-label">{t('agentPicker.loadouts')}</div>
      {loadouts.map((loadout, n) => {
        const info = modelInfo(loadout.agent, loadout.model)
        const name = loadout.agent === 'opencode' ? opencodeModelParts(info).name : info.label
        return (
          <ActionRow key={n} onPress={() => void pick(loadout)} disabled={!available[loadout.agent]} primaryProps={{ className: 'picker-row-main' }}>
            <span className="picker-num">{n + 1}</span>
            <AgentIcon agent={loadout.agent} />
            <span className="picker-row-label">{name}</span>
            {loadout.effort && <span className="faint">{effortLabel(loadout.effort, t)}</span>}
            {loadout.fast && <Zap size={11} className="fast-on" aria-hidden />}
            <span className="spacer" />
            {switches(loadout.agent) ? <span className="faint small switch-note">{t('switchAgent.row.switches')}</span> : <Kbd>{platform === 'darwin' ? `⌘⌃${n + 1}` : `Ctrl+Shift+${n + 1}`}</Kbd>}
          </ActionRow>
        )
      })}
    </div>
  )

  const footer = (
    <div className="picker-footer faint small">
      <span>{t('agentPicker.footer', { cycleKey: `${mod}⇧/`, effort: effortAxisLabel(session.agent, t).toLocaleLowerCase(t.locale), fastKey: `${mod}⇧E` })}</span>
      <LinkButton
        size="sm"
        onClick={() => {
          onOpenChange(false)
          openSettingsPage({ section: 'models' })
        }}
      >
        {t('agentPicker.editLoadouts')}
      </LinkButton>
    </div>
  )

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={t('agentPicker.label')}
      panelClassName="picker-panel"
      trigger={(popover) => (
        <ChipButton {...popover} className="picker-trigger" title={t('agentPicker.triggerTitle', { key: `${mod}/` })}>
          <AgentIcon agent={session.agent} />
          <span>{session.agent === 'opencode' ? opencodeModelParts(model).name : model.label}</span>
          {effort && model.efforts.length > 0 && <span className="faint">{effortLabel(effort, t)}</span>}
          {session.fastMode && <Zap size={12} className="fast-on" aria-hidden />}
          <ChevronDown size={12} className="faint" aria-hidden />
        </ChipButton>
      )}
    >
      <ModelChooser
        inPopover
        onKeyDown={onKeyDown}
        value={{ agent: session.agent, model: session.model, effort: session.effort, fast: session.fastMode }}
        onChoose={(choice) => void pick(choice)}
        onEffort={setEffort}
        onFast={setFast}
        onClose={() => onOpenChange(false)}
        top={loadoutSection}
        note={(m) => (switches(m.agent) ? <span className="faint small switch-note">{t('switchAgent.row.switches')}</span> : null)}
        footer={footer}
        onTerminalAgent={(agent) => {
          openTerminalAgent(session.workspaceId, agent)
        }}
        terminalNote={hasHistory ? (agent) => t('switchAgent.terminalNote', { agent }) : undefined}
        fastHint={`${mod}⇧E`}
        pending={pending ?? undefined}
        choice={
          pending && (
            <SwitchChoice
              session={session}
              choice={pending}
              blocked={blocked}
              mod={mod}
              onContinue={() => void continueHere(pending)}
              onNewChat={() => void newChatInstead(pending)}
            />
          )
        }
      />
    </Popover>
  )
}

/**
 * O1: another agent's model in a chat with messages. Enter continues this chat with it in the same tab (the default,
 * as the mock shows); ⌘Enter opens a new chat instead, as Foreman did before.
 */
function SwitchChoice({
  session,
  choice,
  blocked,
  mod,
  onContinue,
  onNewChat
}: {
  session: Session
  choice: Loadout
  blocked: ReturnType<typeof continueBlock>
  mod: string
  onContinue: () => void
  onNewChat: () => void
}) {
  const t = useT()
  const info = modelInfo(choice.agent, choice.model)
  const name = choice.agent === 'opencode' ? opencodeModelParts(info).name : info.label
  const agent = AGENTS[choice.agent].label
  const current = AGENTS[session.agent].label
  // Switching back to an agent that ran here resumes its own conversation.
  const native = Boolean(session.parked?.[choice.agent])
  const why =
    blocked === 'running'
      ? t('switchAgent.choice.blocked.running')
      : blocked === 'read-only'
        ? t('switchAgent.choice.blocked.readOnly', { agent })
        : blocked === 'history'
          ? t('switchAgent.choice.blocked.history')
          : null
  return (
    <div className="picker-section switch-choice" role="group" aria-label={t('switchAgent.choice.label')}>
      <div className="switch-choice-head">{t.rich('switchAgent.choice.head', { model: <b key="m">{name}</b>, agent, current })}</div>
      <ActionRow className="switch-opt" selected={!blocked} disabled={Boolean(blocked)} onPress={onContinue} primaryProps={{ className: 'switch-opt-main' }}>
        <span className="switch-opt-icon">
          <ArrowRightLeft size={14} aria-hidden />
        </span>
        <span className="switch-opt-text">
          <span className="switch-opt-title">{t('switchAgent.choice.continue', { agent })}</span>
          <span className="switch-opt-sub">{why ?? t(native ? 'switchAgent.choice.continueNative' : 'switchAgent.choice.continueHistory', { agent })}</span>
        </span>
        {!blocked && <Kbd>↵</Kbd>}
      </ActionRow>
      <ActionRow className="switch-opt" onPress={onNewChat} primaryProps={{ className: 'switch-opt-main' }}>
        <span className="switch-opt-icon">
          <MessageSquarePlus size={14} aria-hidden />
        </span>
        <span className="switch-opt-text">
          <span className="switch-opt-title">{t('switchAgent.choice.newChat')}</span>
          <span className="switch-opt-sub">{t('switchAgent.choice.newChatSub', { agent, current })}</span>
        </span>
        <Kbd>{mod}↵</Kbd>
      </ActionRow>
      <div className="switch-choice-note faint small">
        {t('switchAgent.choice.follows', { agent })}
        {!supportsPlan(choice.agent, getState().snapshot?.catalog.agents[choice.agent]?.modes) && ` ${t('switchAgent.choice.noPlan', { agent })}`}
      </div>
    </div>
  )
}

/** Apply loadout N (⌘⌃1–5) to the active chat. O1: another agent's loadout in a chat with messages opens the picker on the choice. */
export async function equipLoadout(session: Session, hasHistory: boolean, index: number): Promise<void> {
  const loadout = getState().snapshot?.settings.loadouts[index]
  if (!loadout) return
  if (!availableAgents(getState())[loadout.agent]) {
    openSettingsPage({ section: 'agents', agent: loadout.agent })
    return
  }
  if (modelChoiceAction(session, hasHistory, loadout) === 'ask') {
    window.dispatchEvent(new CustomEvent(ASK_SWITCH, { detail: { sessionId: session.id, choice: loadout } }))
    return
  }
  await chooseModel(session, loadout)
}
