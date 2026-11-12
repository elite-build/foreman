// The lines in a chat where it switched agents or moved to another account (docs/agents.md 5.5): what the next agent was
// given, in counts, with "What Codex received" as a link to the record.
import { AGENTS, modelInfo } from '../../../shared/agents'
import type { ChatHandOff } from '../../../shared/chatHandOff'
import type { AgentSwitch } from '../../../shared/switchAgent'
import { useT } from '../i18n'
import { AgentIcon } from './composer/AgentPicker'
import { useHandOffSummary, WhatReceivedLink } from './HandOffRecord'
import './switchAgent.css'

/** O1: the line where a chat switched agents: "Switched to Codex · GPT-6.1 Sol · 6 turns in full, 4 condensed, 3 left out …", or the older text for a switch from before the record. */
export function SwitchDivider({ switched }: { switched: AgentSwitch }) {
  const t = useT()
  const summary = useHandOffSummary()
  const name = `${AGENTS[switched.to]?.label ?? switched.to} · ${modelInfo(switched.to, switched.model).label}`
  const record = switched.handOff
  const resumed = switched.carried === 'native'
  return (
    // A separator's children are presentational, so the line that holds the link is a plain block.
    <div className="agent-switch" role={record ? undefined : 'separator'}>
      <span className="agent-switch-text">
        <AgentIcon agent={switched.to} size={12} />
        {record ? (
          // What the agent was given: counts and size, and the record behind a link ("What Codex received").
          <span>
            {t.rich(resumed ? 'handOff.notice.back' : 'handOff.notice.switched', { name: <b key="n">{name}</b> })} · {summary(record, resumed)} · <WhatReceivedLink handOff={record} />
          </span>
        ) : (
          <span>{t.rich(resumed ? 'switchAgent.divider.native' : 'switchAgent.divider.history', { name: <b key="n">{name}</b> })}</span>
        )}
      </span>
    </div>
  )
}

/** #130: the line where a tab moved to another account (a new conversation there), with the record of what it was given. */
export function MoveDivider({ text, handOff }: { text: string; handOff: ChatHandOff }) {
  const summary = useHandOffSummary()
  return (
    <div className="agent-switch">
      <span className="agent-switch-text">
        <AgentIcon agent={handOff.to.agent} size={12} />
        <span>
          {text} · {summary(handOff)} · <WhatReceivedLink handOff={handOff} />
        </span>
      </span>
    </div>
  )
}
