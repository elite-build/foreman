// An organization's memory proposals (docs/ai-employees.md §4, §10): changes its AI employees may only propose (the
// organization's PROJECT.md, decisions.md and instructions.md, definitions, repositories' files, or a folder their
// definition doesn't grant). Each is a decision card (components/DecisionCard.tsx): who proposed it and their own reason,
// the lines it adds, the line saying what adding it does, and Discard · Add to PROJECT.md (a commit as you, through the
// memory service; Discard writes nothing). Shown on the Team page, an employee's page and in the Memory view.
import { useState, type ReactNode } from 'react'
import { fileName } from '../../../../shared/employeeDecisions'
import { employeeIdOfPath, employeeIdOfPromptPath } from '../../../../shared/employees'
import { timeAgo } from '../../../../shared/i18n/time'
import type { MemoryProposal } from '../../../../shared/memory'
import { useT } from '../../i18n'
import { api, openMemory, showToast, useStore } from '../../store'
import { Callout, HardHat, LinkButton, type HardHatColour } from '../../ui'
import { PlacedDecision, type DecisionPlace } from '../DecisionCard'
import './employees.css'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A proposal as a decision: the employee's reason, the change, what adding it does; Discard, then the act. */
export function ProposalDecision({ proposal, place, who }: { proposal: MemoryProposal; place: DecisionPlace; who: ReactNode }) {
  const t = useT()
  const name = useStore((s) => s.snapshot!.employees?.[proposal.orgId]?.employees.find((e) => e.id === proposal.employeeId)?.name) || proposal.employeeId
  const memory = useStore((s) => {
    const org = s.snapshot!.organizations?.find((o) => o.id === proposal.orgId)
    return s.snapshot!.repos.find((r) => r.id === org?.memoryRepoId)?.name ?? ''
  })
  const task = useStore((s) => {
    const view = s.snapshot!.employeeWork?.[proposal.orgId]
    if (!proposal.taskId || !view) return undefined
    return view.tasks.find((x) => x.id === proposal.taskId)?.title ?? Object.values(view.last).find((x) => x.id === proposal.taskId)?.title
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const file = fileName(proposal.path)
  // A definition or an employee's own prompt: keeping either changes what it runs with, so it is approved again.
  const definition = employeeIdOfPath(proposal.path) !== null || employeeIdOfPromptPath(proposal.path) !== null
  const act = async (keep: boolean) => {
    setBusy(true)
    setError('')
    try {
      if (keep) {
        const out = await api.keepMemoryProposal(proposal.orgId, proposal.id)
        if (!out.ok) {
          setError(t('employees.proposal.conflict', { path: out.path }))
          return
        }
        showToast(t('employees.proposal.kept', { path: proposal.path }))
      } else {
        await api.retireMemoryProposal(proposal.orgId, proposal.id)
        showToast(t('employees.proposal.retired', { path: proposal.path }))
      }
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }
  const actLabel = definition ? t('employees.decision.memory.actDefinition') : proposal.kind === 'append' ? t('employees.decision.memory.actAppend', { file }) : t('employees.decision.memory.actWrite', { file })
  const lines = proposal.text.replace(/\n$/, '').split('\n')
  const body = (
    <>
      {(proposal.why || task) && (
        <p className="employee-question-text">
          {proposal.why && <span>{t('employees.decision.memory.said', { name, why: proposal.why })} </span>}
          {task && <span className="employee-faint">{t('employees.decision.memory.from', { title: task })}</span>}
        </p>
      )}
      <div className="employee-proposal">
        <div className="employee-proposal-file">
          <code>{proposal.path}</code>
          <LinkButton size="sm" underline onClick={() => openMemory(proposal.orgId)}>
            {t('employees.decision.memory.open')}
          </LinkButton>
        </div>
        {proposal.kind === 'append' ? (
          <ol className="employee-diff" aria-label={t('employees.proposal.textLabel', { path: proposal.path })}>
            {lines.map((line, i) => (
              <li key={i} className="employee-diff-line mono">
                <span aria-hidden>+ </span>
                <span className="sr-only">{t('employees.diff.added')} </span>
                {line || ' '}
              </li>
            ))}
          </ol>
        ) : (
          <pre className="employee-proposal-text mono" aria-label={t('employees.proposal.textLabel', { path: proposal.path })}>
            {proposal.text}
          </pre>
        )}
      </div>
      {error && (
        <Callout tone="warn" role="alert">
          {error}
        </Callout>
      )}
    </>
  )
  const keep = () => void act(true)
  return (
    <PlacedDecision
      place={place}
      parts={{
        who,
        kind: t('decision.kind.memory'),
        age: timeAgo(proposal.createdAt, t.locale),
        subject: definition ? t('employees.decision.memory.subjectDefinition') : proposal.kind === 'append' ? t('employees.decision.memory.subjectAppend', { file }) : t('employees.decision.memory.subjectWrite', { file }),
        children: body,
        consequence: definition
          ? t('employees.decision.memory.consequenceDefinition', { memory })
          : proposal.kind === 'append'
            ? t('employees.decision.memory.consequenceAppend', { file, memory })
            : t('employees.decision.memory.consequenceWrite', { file, memory }),
        decline: { label: t('employees.decision.memory.discard'), disabled: busy, onAct: () => void act(false) },
        main: { label: actLabel, disabled: busy, onAct: keep },
        // It stays on this computer, so the row can act at once.
        rowAct: { label: actLabel, disabled: busy, onAct: keep }
      }}
    />
  )
}

/** The hat and name a decision's header shows for an employee. */
export function EmployeeWho({ orgId, employeeId }: { orgId: string; employeeId: string }) {
  const e = useStore((s) => s.snapshot!.employees?.[orgId]?.employees.find((x) => x.id === employeeId))
  return (
    <>
      <HardHat colour={(e?.colour ?? '') as HardHatColour} size={16} />
      {e?.name || employeeId}
    </>
  )
}

/** The organization's proposals waiting for a person, oldest first, as cards; nothing when there are none. */
export function MemoryProposals({ orgId, headingLevel = 2 }: { orgId: string; headingLevel?: 2 | 3 }) {
  const t = useT()
  const proposals = useStore((s) => s.snapshot!.employeeWork?.[orgId]?.proposals ?? [])
  if (!proposals.length) return null
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  return (
    <section className="team-needs-you" aria-labelledby={`proposals-${orgId}`}>
      <Heading id={`proposals-${orgId}`} className="employee-subheading">
        {t('employees.proposal.heading', { count: proposals.length })}
      </Heading>
      <ul className="employee-work-list" aria-labelledby={`proposals-${orgId}`}>
        {proposals.map((p) => (
          <li key={p.id}>
            <ProposalDecision proposal={p} place={{ form: 'card' }} who={<EmployeeWho orgId={orgId} employeeId={p.employeeId} />} />
          </li>
        ))}
      </ul>
    </section>
  )
}
