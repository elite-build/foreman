// Settings → Agents → an agent → Capabilities (docs/agents.md, 2.6): the capability record drawn as a list, in groups, each line
// "Works", "Works with a fallback" (and what Foreman does instead) or "Not offered" (and why), with who enforces the rules and
// what the record was tested against. Used by a Full agent's page and a Chat agent's page, so both say the same thing.
// The words are a shape and a word (Status), never colour alone; each group is a Disclosure that starts closed when everything
// in it works.
import { Lock } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AgentCapabilities, Level } from '../../../../shared/agentCapabilities'
import { capabilityGroups, countLevels, MODE_LABEL, startsOpen, type CapabilityGroup, type CapabilityLine } from '../../../../shared/agentCapabilityList'
import { testedVersion } from '../../../../shared/agentVersions'
import type { PlainKey } from '../../../../shared/i18n'
import { useT, type RendererT } from '../../i18n'
import { useCapabilities } from '../../store'
import { ActionRow, Disclosure, Status, Tag, type StatusTone } from '../../ui'
import { Section } from '../settings/controls'
import './capabilities.css'

const TONE: Record<Level, StatusTone> = { native: 'ok', fallback: 'info', none: 'off' }
const WORD: Record<Level, PlainKey> = { native: 'agentCaps.level.native', fallback: 'agentCaps.level.fallback', none: 'agentCaps.level.none' }

/** "2 work · 1 with a fallback · 1 not offered": only the parts that aren't zero. */
function summary(group: CapabilityGroup, t: RendererT): string {
  const n = countLevels(group.lines)
  return [
    n.native > 0 && t('agentCaps.sum.native', { count: n.native }),
    n.fallback > 0 && t('agentCaps.sum.fallback', { count: n.fallback }),
    n.none > 0 && t('agentCaps.sum.none', { count: n.none })
  ]
    .filter(Boolean)
    .join(' · ')
}

/** What follows the word: the fallback sentence, the reason, or a short note on how it works. */
function lineText(line: CapabilityLine, t: RendererT): string | null {
  if (line.detail) return t(line.detail)
  if (line.modes && line.level === 'native') return t('agentCaps.note.modes', { modes: line.modes.map((m) => t(MODE_LABEL[m])).join(', ') })
  if (line.note) return t(line.note)
  return null
}

function Line({ line }: { line: CapabilityLine }) {
  const t = useT()
  const text = lineText(line, t)
  return (
    <li>
      <ActionRow>
        <div className="cap-line">
          <span className="cap-name">{t(line.label)}</span>
          <span className="cap-result">
            <Status tone={TONE[line.level]} label={t(WORD[line.level])} />
            {text && <span className="faint small">{text}</span>}
          </span>
        </div>
      </ActionRow>
    </li>
  )
}

function Group({ group }: { group: CapabilityGroup }) {
  const t = useT()
  const name = t(group.label)
  return (
    <Disclosure
      className="cap-group"
      defaultOpen={startsOpen(group)}
      label={
        <span className="cap-group-label">
          <span>{name}</span>
          <span className="faint small">{summary(group, t)}</span>
        </span>
      }
    >
      <ul className="cap-lines" aria-label={name}>
        {group.lines.map((line) => (
          <Line key={line.id} line={line} />
        ))}
      </ul>
    </Disclosure>
  )
}

/** The groups of one record. */
export function CapabilityList({ record }: { record: AgentCapabilities }) {
  return (
    <>
      {capabilityGroups(record).map((group) => (
        <Group key={group.id} group={group} />
      ))}
    </>
  )
}

/**
 * The page section: who holds the rules, what the record was tested against, then the groups. `instance` asks for one of the
 * agent's accounts (what that account declared is folded in); the default account when absent.
 */
export function CapabilitiesSection({ agent, name, instance, children }: { agent: string; name: string; instance?: string; children?: ReactNode }) {
  const t = useT()
  const record = useCapabilities(agent, instance)
  if (!record) return null
  const byAgent = record.enforcement.by === 'agent'
  const recorded = record.evidence === 'recorded'
  // The version the recordings were made with, from the agent's version table: "Tested against recorded traffic · Codex 0.163.0".
  const testedWith = recorded ? testedVersion(agent) : undefined
  return (
    <Section title={t('agentCaps.title')} description={t('agentCaps.description', { agent: name })}>
      <div className="set-pad cap-meta">
        <div className="cap-enforced">
          <Tag tone="outline">
            <Lock size={12} aria-hidden /> {t(byAgent ? 'agentCaps.enforced.agent' : 'agentCaps.enforced.foreman')}
          </Tag>
          <span className="faint small">{t(byAgent ? 'agentCaps.enforcedNote.agent' : 'agentCaps.enforcedNote.foreman', { agent: name })}</span>
        </div>
        <div className="cap-evidence">
          <Tag tone={recorded ? 'ok' : 'info'}>{t(recorded ? 'agentCaps.evidenceTag.recorded' : 'agentCaps.evidenceTag.simulated')}</Tag>
          <span className="faint small">{testedWith ? t('agentCaps.evidence.recordedWith', { agent: name, version: testedWith }) : t(recorded ? 'agentCaps.evidence.recorded' : 'agentCaps.evidence.simulated')}</span>
        </div>
      </div>
      <CapabilityList record={record} />
      {children && <div className="set-pad">{children}</div>}
    </Section>
  )
}
