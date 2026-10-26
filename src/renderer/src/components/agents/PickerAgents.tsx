// #22: the agent rows of the model picker, grouped Full / Chat / Terminal, and
// "Manage agents… · N of M enabled" at the bottom. Only enabled agents are
// listed. A Chat agent's hover note says which controls it lacks; a Terminal
// agent opens a terminal tab in the workspace instead of choosing a model.
import { Settings2 } from 'lucide-react'
import { Fragment } from 'react'
import { useAgentStatuses } from '../../agentReadiness'
import { catalogAgent, type Capability, type IntegrationLevel } from '../../../../shared/agentCatalog'
import { enabledCount, noteCapabilities, pickerGroups, type PickerAgent } from '../../../../shared/agentPicker'
import type { AgentKind } from '../../../../shared/agents'
import type { PlainKey } from '../../../../shared/i18n'
import { useT, type RendererT } from '../../i18n'
import { openSettingsPage, useStore } from '../../store'
import { ActionRow, ChipButton, LinkButton } from '../../ui'
import { AgentIcon } from '../composer/AgentPicker'
import './catalog.css'

export const LEVEL_LABEL: Record<IntegrationLevel, PlainKey> = {
  full: 'agentCatalog.level.full',
  chat: 'agentCatalog.level.chat',
  terminal: 'agentCatalog.level.terminal'
}

export const CAPABILITY_LABEL: Record<Capability, PlainKey> = {
  approvals: 'agentCatalog.cap.approvals',
  plan: 'agentCatalog.cap.plan',
  steer: 'agentCatalog.cap.steer',
  rewind: 'agentCatalog.cap.rewind',
  mcp: 'agentCatalog.cap.mcp',
  cost: 'agentCatalog.cap.cost'
}

const NOTE_LABEL: Partial<Record<Capability, PlainKey>> = {
  plan: 'agentCatalog.picker.noPlan',
  rewind: 'agentCatalog.picker.noRewind',
  steer: 'agentCatalog.picker.noSteer'
}

/** "Gemini CLI: no plan mode, no rewind", or undefined when nothing's missing. */
export function capabilityNote(agent: PickerAgent, t: RendererT): string | undefined {
  const missing = noteCapabilities(agent)
  if (!missing.length) return undefined
  return t('agentCatalog.picker.note', { agent: catalogAgent(agent.id)?.name ?? agent.id, missing: missing.map((c) => t(NOTE_LABEL[c]!)).join(', ') })
}

function usePickerGroups() {
  const prefs = useStore((s) => s.snapshot!.settings.agentPrefs)
  const cursor = useStore((s) => s.snapshot!.agentKeys.CURSOR_API_KEY !== undefined)
  const opencode = useStore((s) => s.opencodeInstalled)
  const statuses = useAgentStatuses()
  return pickerGroups(prefs, { cursor, opencode, statuses })
}

export function PickerAgentGroups({
  current,
  onPick,
  onSetUp,
  onTerminal,
  terminalNote
}: {
  current: string
  onPick: (agent: AgentKind) => void
  // An enabled agent that isn't set up yet: open its settings.
  onSetUp: (agent: string) => void
  // Absent: the Terminal group isn't offered here (no workspace to run in).
  onTerminal?: (agent: string) => void
  // O1: the hover note for a Terminal agent in a chat it can't continue (it always opens a new terminal tab).
  terminalNote?: (agent: string) => string
}) {
  const t = useT()
  const groups = usePickerGroups().filter((g) => g.level !== 'terminal' || onTerminal)
  return (
    <div className="picker-agent-groups">
      {groups.map((group) => (
        <div key={group.level} className="picker-agent-group">
          <div className="picker-label">{t(LEVEL_LABEL[group.level])}</div>
          <div className="picker-agents">
            {group.agents.map((agent) => {
              const name = catalogAgent(agent.id)?.name ?? agent.id
              const note = capabilityNote(agent, t)
              if (group.level === 'terminal') {
                return (
                  <ChipButton key={agent.id} title={terminalNote?.(name) ?? t('agentCatalog.picker.terminalNote', { agent: name })} onClick={() => onTerminal?.(agent.id)}>
                    <AgentIcon agent={agent.id} /> {name}
                  </ChipButton>
                )
              }
              if (!agent.ready) {
                return (
                  <ChipButton key={agent.id} title={t('agentCatalog.picker.setUp', { agent: name })} onClick={() => onSetUp(agent.id)}>
                    <span className="faint">+ {name}</span>
                  </ChipButton>
                )
              }
              const evidence = agent.readiness
              const chip = (
                <ChipButton key={agent.id} pressed={agent.id === current} title={note} onClick={() => onPick(agent.id as AgentKind)}>
                  <AgentIcon agent={agent.id} /> {name}
                  {/* Wording by evidence. Only what needs attention is shown; the rest is for screen readers. */}
                  {evidence && evidence.evidenceKey !== 'agentReadiness.checking' && (evidence.attention ? <span className="faint small"> · {t(evidence.evidenceKey)}</span> : <span className="sr-only">, {t(evidence.evidenceKey)}</span>)}
                </ChipButton>
              )
              // A signed-out agent stays selectable; the link beside it goes to its sign-in.
              if (!evidence?.needsSignIn) return chip
              return (
                <Fragment key={agent.id}>
                  {chip}
                  <LinkButton size="sm" aria-label={t('chat.notice.signIn', { agent: name })} onClick={() => onSetUp(agent.id)}>
                    {t('agentReadiness.signIn')}
                  </LinkButton>
                </Fragment>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

export function ManageAgentsRow({ onClose }: { onClose: () => void }) {
  const t = useT()
  const prefs = useStore((s) => s.snapshot!.settings.agentPrefs)
  const { enabled, total } = enabledCount(prefs)
  return (
    <div className="picker-section">
      <ActionRow
        className="picker-row-edit"
        primaryProps={{ className: 'picker-row-main' }}
        onPress={() => {
          onClose()
          openSettingsPage({ section: 'agents', agent: 'catalog' })
        }}
      >
        <Settings2 size={13} className="picker-row-edit-icon" aria-hidden />
        <span className="picker-row-edit-label">{t('agentCatalog.picker.manage')}</span>
        <span className="spacer" />
        <span className="faint small">{t('agentCatalog.picker.enabledCount', { enabled, total })}</span>
      </ActionRow>
    </div>
  )
}
