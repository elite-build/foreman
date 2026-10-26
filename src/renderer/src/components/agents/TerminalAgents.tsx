// #22: Terminal agents in the workspace: a tab per agent process next to the
// chats, the terminal itself under a banner saying what Foreman can't see, and
// the sidebar's "Aider · running · output 2s ago". Status comes from the process
// and its output only; it never says the agent needs you.
import { RotateCw, Square, SquareTerminal, X } from 'lucide-react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { catalogAgent, terminalActivity, type TerminalAgentRun } from '../../../../shared/agentCatalog'
import { closeAgentTab, closeNeedsConfirm, openAgentTab, restartAgentTab, showAgentTab, tabsOf, type AgentTab, type AgentTabsState } from '../../../../shared/agentTabs'
import { formatClock } from '../../../../shared/i18n/time'
import { refreshTerminalAgentRuns, useSecondClock, useTerminalAgentRuns } from '../../agentCatalog'
import { useT } from '../../i18n'
import { bridge, selectBrowserTab } from '../../store'
import { Button, IconButton, Tab } from '../../ui'
import { TerminalView } from '../TerminalView'
import { AgentMonogram } from './AgentMonogram'
import './catalog.css'

// ---- tab state (renderer only; tabs end with the app) ----

let state: AgentTabsState = {}
const listeners = new Set<() => void>()
const set = (next: AgentTabsState) => {
  state = next
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
// Each tab's terminal id once it has started, for Stop and for matching its run.
const ptyOf = new Map<string, string>()
let counter = 0

export function useAgentTabs(workspaceId: string) {
  return useSyncExternalStore(subscribe, () => tabsOf(state, workspaceId))
}

/** Opens a Terminal agent in a new tab of the workspace and shows it. */
export function openTerminalAgent(workspaceId: string, agent: string): void {
  selectBrowserTab(workspaceId, false)
  set(openAgentTab(state, workspaceId, agent, `agent-${++counter}`))
}

/** Shows a Terminal agent's tab, or (null) goes back to the chat. */
export function showTerminalAgentTab(workspaceId: string, key: string | null): void {
  if (key) selectBrowserTab(workspaceId, false)
  set(showAgentTab(state, workspaceId, key))
}

function runFor(runs: TerminalAgentRun[], key: string): TerminalAgentRun | undefined {
  const pty = ptyOf.get(key)
  return pty ? runs.find((r) => r.ptyId === pty) : undefined
}

// ---- the tab strip ----

/** The value a Terminal agent's tab has in the chat strip's `Tabs` (its `value` is this while the tab is shown). */
export const agentTabValue = (key: string): string => `agent:${key}`

/**
 * One `Tab` per Terminal agent, to render inside the chat strip's `TabList`. The tab is selected when the strip's
 * `Tabs` value is `agentTabValue(tab.key)`, which the strip sets from `useAgentTabs(workspaceId).active` unless a
 * file covers the chat; `covered` stays in the props so the caller needn't change.
 */
export function TerminalAgentTabs({ workspaceId }: { workspaceId: string; covered?: boolean }) {
  const t = useT()
  const { tabs } = useAgentTabs(workspaceId)
  const runs = useTerminalAgentRuns()
  if (!tabs.length) return null

  const close = (tab: AgentTab) => {
    const run = runFor(runs, tab.key)
    const name = catalogAgent(tab.agent)?.name ?? tab.agent
    if (closeNeedsConfirm(run?.lastOutputAt, run?.exitCode !== undefined, Date.now()) && !window.confirm(t('agentCatalog.terminal.closeConfirm', { agent: name }))) return
    set(closeAgentTab(state, workspaceId, tab.key))
    ptyOf.delete(tab.key)
    refreshTerminalAgentRuns()
  }

  return (
    <>
      {tabs.map((tab) => (
        <Tab
          key={tab.key}
          value={agentTabValue(tab.key)}
          className="agent-tab"
          onClick={() => showTerminalAgentTab(workspaceId, tab.key)}
          actions={
            <IconButton label={t('agentCatalog.terminal.closeTab')} onClick={() => close(tab)}>
              <X size={11} />
            </IconButton>
          }
        >
          <AgentMonogram agent={tab.agent} />
          <span className="chat-tab-title">{catalogAgent(tab.agent)?.name ?? tab.agent}</span>
          <span className="tab-model">{t('agentCatalog.terminal.tag')}</span>
        </Tab>
      ))}
    </>
  )
}

// ---- the tab bodies ----

/** Every Terminal agent tab of the workspace, kept mounted so the processes keep running; only the active one shows. */
export function TerminalAgentBodies({ workspaceId, covered, hidden }: { workspaceId: string; covered: boolean; hidden: boolean }) {
  const { tabs, active } = useAgentTabs(workspaceId)
  return (
    <>
      {tabs.map((tab) => (
        <div key={tab.key} className="fill" style={{ display: !covered && active === tab.key ? undefined : 'none' }}>
          <TerminalAgentBody workspaceId={workspaceId} tab={tab} visible={!covered && !hidden && active === tab.key} />
        </div>
      ))}
    </>
  )
}

function TerminalAgentBody({ workspaceId, tab, visible }: { workspaceId: string; tab: AgentTab; visible: boolean }) {
  const t = useT()
  const agent = catalogAgent(tab.agent)
  const [exit, setExit] = useState<number | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const name = agent?.name ?? tab.agent

  return (
    <div className="agent-term">
      <div className="agent-term-banner" role="note">
        <SquareTerminal size={13} />
        <span>
          <strong>{t('agentCatalog.terminal.bannerTitle')}</strong> · {t('agentCatalog.terminal.banner')}
        </span>
        <span className="spacer" />
        <IconButton
          label={t('agentCatalog.terminal.restart')}
          onClick={() => {
            setExit(null)
            set(restartAgentTab(state, workspaceId, tab.key))
          }}
        >
          <RotateCw size={13} />
        </IconButton>
        <Button
          size="sm"
          icon={<Square size={11} />}
          disabled={exit !== null}
          onClick={() => {
            const pty = ptyOf.get(tab.key)
            if (pty) bridge.send.ptyKill(pty)
          }}
        >
          {t('agentCatalog.terminal.stop')}
        </Button>
      </div>
      <div className="agent-term-body">
        <TerminalView
          key={`${tab.key}:${tab.run}`}
          workspaceId={workspaceId}
          kind="agent"
          command={tab.agent}
          visible={visible}
          onSpawn={(id) => {
            ptyOf.set(tab.key, id)
            setStartedAt(Date.now())
            refreshTerminalAgentRuns()
          }}
          onExit={(code) => {
            setExit(code)
            refreshTerminalAgentRuns()
          }}
        />
      </div>
      <div className="agent-term-foot faint small">
        <span className="mono">
          {name}
          {startedAt !== null && ` · ${t('agentCatalog.terminal.started', { time: formatClock(startedAt, t.locale) })}`}
          {exit !== null && ` · ${t('agentCatalog.terminal.exited', { code: exit })}`}
        </span>
        <span className="spacer" />
        <span>{t('agentCatalog.terminal.typeHere')}</span>
      </div>
    </div>
  )
}

// ---- the sidebar ----

/** "Aider · running · output 2s ago", "Aider · quiet", or null when no Terminal agent runs in the workspace. */
export function TerminalAgentLabel({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const runs = useTerminalAgentRuns()
  const live = useMemo(() => runs.filter((r) => r.workspaceId === workspaceId && r.exitCode === undefined), [runs, workspaceId])
  const now = useSecondClock(live.length > 0)
  if (!live.length) return null
  // The most recently active one speaks for the workspace.
  const run = live.reduce((a, b) => (b.lastOutputAt > a.lastOutputAt ? b : a))
  const name = catalogAgent(run.agent)?.name ?? run.agent
  const activity = terminalActivity(run, now)
  return (
    <span className="ws-label agent-run">
      {name} · <span className="agent-run-state">{activity.kind === 'running' ? t('agentCatalog.terminal.running') : t('agentCatalog.terminal.quiet')}</span>
      {activity.kind === 'running' && <span className="ws-detail"> · {t('agentCatalog.terminal.outputAgo', { seconds: activity.secondsAgo })}</span>}
      {live.length > 1 && <span className="ws-detail"> · +{live.length - 1}</span>}
    </span>
  )
}

/** Whether a Terminal agent runs in the workspace now (the sidebar shows its line instead of the usual label). */
export function useHasTerminalAgent(workspaceId: string): boolean {
  const runs = useTerminalAgentRuns()
  return runs.some((r) => r.workspaceId === workspaceId && r.exitCode === undefined)
}
