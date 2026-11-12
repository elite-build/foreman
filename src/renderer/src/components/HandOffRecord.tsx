// "What Codex received" (docs/agents.md 5.5): the record of what a tab's next agent was given when the chat switched to it,
// opened from the notice in the chat and from Lineage's switch edge. The code calls it a hand-off; the words never do,
// because Hand off already means moving a workspace to another computer and handing a plan or review to a new chat.
import { useState, type ReactNode } from 'react'
import { offers } from '../../../shared/agentCapabilities'
import { instanceLabel } from '../../../shared/agentInstances'
import { AGENTS, modelInfo } from '../../../shared/agents'
import { READ_CHAT_HISTORY_TOOL_NAME, type ChatHandOff, type HandOffParty, type HandOffTurn } from '../../../shared/chatHandOff'
import { useT } from '../i18n'
import { openSettingsPage, useCapabilities, useStore } from '../store'
import { Button, Dialog, Glyph, LinkButton, Meter, Tag } from '../ui'
import { AgentIcon } from './composer/AgentPicker'
import './handOffRecord.css'

const agentName = (agent: string) => AGENTS[agent as keyof typeof AGENTS]?.label ?? agent

/**
 * The notice's words about a record: "6 turns in full, 4 condensed, 3 left out · 15,200 of 16,000 tokens" (the tokens are an
 * estimate, and the dialog says so), or for an agent that resumed its own conversation "3 turns since you left · 4,100 of …".
 */
export function useHandOffSummary(): (handOff: ChatHandOff, resumed?: boolean) => string {
  const t = useT()
  return (handOff, resumed) => {
    const size = t('handOff.tokens', { used: handOff.usedTokens.toLocaleString(t.locale), budget: handOff.budgetTokens.toLocaleString(t.locale) })
    if (resumed) return `${t('handOff.delta.turns', { count: handOff.full.length + handOff.condensed.length + handOff.omitted.length })} · ${size}`
    const parts = [
      t('handOff.count.full', { count: handOff.full.length }),
      ...(handOff.condensed.length ? [t('handOff.count.condensed', { count: handOff.condensed.length })] : []),
      ...(handOff.omitted.length ? [t('handOff.count.omitted', { count: handOff.omitted.length })] : [])
    ]
    return `${parts.join(', ')} · ${size}`
  }
}

/** The link "What Codex received" that opens the record in a dialog; focus returns to it when the dialog closes. */
export function WhatReceivedLink({ handOff, size }: { handOff: ChatHandOff; size?: 'inherit' | 'sm' }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <>
      <LinkButton size={size} underline onClick={() => setOpen(true)}>
        {t('handOff.link', { agent: agentName(handOff.to.agent) })}
      </LinkButton>
      {open && <HandOffDialog handOff={handOff} onClose={() => setOpen(false)} />}
    </>
  )
}

function PartyLine({ party }: { party: HandOffParty }) {
  const instances = useStore((s) => s.snapshot?.settings.agentInstances)
  const account = instanceLabel(instances, party.agent, party.instance)
  return (
    <span className="hor-party">
      <AgentIcon agent={party.agent} />
      <span>{[agentName(party.agent), modelInfo(party.agent, party.model).label, account].filter(Boolean).join(' · ')}</span>
    </span>
  )
}

function TurnRows({ turns }: { turns: HandOffTurn[] }) {
  const t = useT()
  return (
    <ul className="hor-turns">
      {turns.map((turn) => (
        <li key={turn.id} className="hor-turn">
          <span className="hor-turn-n">{t('handOff.turn.n', { n: turn.n })}</span>
          <span className="hor-turn-who">{agentName(turn.agent)}</span>
          <span className="hor-turn-text">{turn.request}</span>
          <span className="hor-turn-size faint small">{turn.tokens ? t('handOff.turn.tokens', { count: turn.tokens.toLocaleString(t.locale) }) : ''}</span>
        </li>
      ))}
    </ul>
  )
}

/** The record itself: how it was delivered, the size against the setting, and the turns in full, condensed and left out. */
export function HandOffDialog({ handOff, onClose }: { handOff: ChatHandOff; onClose: () => void }) {
  const t = useT()
  const to = agentName(handOff.to.agent)
  const caps = useCapabilities(handOff.to.agent, handOff.to.instance)
  const canRead = Boolean(caps) && offers(caps!.tools.mcp)
  const byId = new Map(handOff.turns.map((turn) => [turn.id, turn]))
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((turn): turn is HandOffTurn => Boolean(turn))
  const full = pick(handOff.full)
  const condensed = pick(handOff.condensed)
  const omitted = pick(handOff.omitted)
  const since = handOff.sinceTurn ? byId.get(handOff.sinceTurn)?.n : undefined
  const used = handOff.usedTokens.toLocaleString(t.locale)
  const budget = handOff.budgetTokens.toLocaleString(t.locale)
  const sizeText = t('handOff.dialog.sizeValue', { used, budget })
  const range = omitted.length ? (omitted.length === 1 ? String(omitted[0].n) : `${omitted[0].n}–${omitted.at(-1)!.n}`) : ''
  return (
    <Dialog
      title={t('handOff.link', { agent: to })}
      size="lg"
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <dl className="hor-kv">
        <dt className="muted">{t('handOff.dialog.from')}</dt>
        <dd>
          <PartyLine party={handOff.from} />
        </dd>
        <dt className="muted">{t('handOff.dialog.to')}</dt>
        <dd>
          <PartyLine party={handOff.to} />
        </dd>
        <dt className="muted">{t('handOff.dialog.how')}</dt>
        <dd>
          <span>{t(`handOff.how.${handOff.strategy}`, { agent: to })}</span>
          <Tag tone="outline" mono>
            {handOff.strategy}
          </Tag>
          {since !== undefined && <span className="hor-note faint small">{t('handOff.dialog.since', { n: since, agent: to })}</span>}
          {!handOff.turnId && <span className="hor-note faint small">{t('handOff.dialog.pending')}</span>}
        </dd>
        <dt className="muted">{t('handOff.dialog.size')}</dt>
        <dd>
          <span className="hor-size">
            <Meter className="hor-meter" label={t('handOff.dialog.size')} value={handOff.usedTokens} max={handOff.budgetTokens} valueText={sizeText} />
            <span className="mono small">{sizeText}</span>
          </span>
          <span className="hor-note faint small">
            {t('handOff.dialog.estimate')}{' '}
            <LinkButton
              size="sm"
              onClick={() => {
                onClose()
                openSettingsPage({ section: 'models' })
              }}
            >
              {t('handOff.dialog.change')}
            </LinkButton>
          </span>
        </dd>
      </dl>
      <Group tone="ok" title={t('handOff.full.title')} sum={t('handOff.full.sum', { count: full.length })} empty={!full.length}>
        <TurnRows turns={full} />
      </Group>
      <Group tone="info" title={t('handOff.condensed.title')} sum={t('handOff.condensed.sum', { count: condensed.length })} empty={!condensed.length}>
        <TurnRows turns={condensed} />
      </Group>
      <Group tone="off" title={t('handOff.omitted.title')} sum={t('handOff.omitted.sum', { count: omitted.length, range })} empty={!omitted.length}>
        <TurnRows turns={omitted} />
        <p className="small soft">{canRead ? t('handOff.omitted.note', { agent: to, tool: READ_CHAT_HISTORY_TOOL_NAME }) : t('handOff.omitted.noteNoTool', { agent: to })}</p>
      </Group>
    </Dialog>
  )
}

function Group({ tone, title, sum, empty, children }: { tone: 'ok' | 'info' | 'off'; title: string; sum: string; empty: boolean; children: ReactNode }) {
  if (empty) return null
  return (
    <section className="hor-group">
      <div className="hor-head">
        <Glyph name={tone} />
        <h3 className="hor-title">{title}</h3>
        <span className="faint small">{sum}</span>
      </div>
      {children}
    </section>
  )
}
