// An organization's memory proposals (docs/ai-employees.md §4, §10): changes its AI employees may only propose (the
// organization's PROJECT.md, decisions.md and instructions.md, definitions, repositories' files, or a folder their
// definition doesn't grant), each with who proposed it, why, the text, and Keep (a commit as you, through the memory
// service) or Retire (nothing is written). Shown in the Team page's Needs you and in the Memory view.
import { useState } from 'react'
import type { MemoryProposal } from '../../../../shared/memory'
import { useT } from '../../i18n'
import { api, showToast, useStore } from '../../store'
import { Button, Callout, Card } from '../../ui'
import './employees.css'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function ProposalRow({ proposal, who }: { proposal: MemoryProposal; who: string }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
  return (
    <Card as="li" className="employee-task">
      <div className="employee-task-head">
        <span className="employee-task-title">{t(proposal.kind === 'append' ? 'employees.proposal.append' : 'employees.proposal.write', { name: who, path: proposal.path })}</span>
      </div>
      {proposal.why && <p className="employee-task-why employee-faint">{proposal.why}</p>}
      <pre className="employee-proposal-text mono" aria-label={t('employees.proposal.textLabel', { path: proposal.path })}>
        {proposal.text}
      </pre>
      {error && (
        <Callout tone="warn" role="alert">
          {error}
        </Callout>
      )}
      <div className="employee-card-actions">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(true)}>
          {t('employees.proposal.keep')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(false)}>
          {t('employees.proposal.retire')}
        </Button>
        <span className="employee-faint">{t('employees.proposal.keepHint')}</span>
      </div>
    </Card>
  )
}

/** The organization's proposals waiting for a person, oldest first; nothing when there are none. */
export function MemoryProposals({ orgId, headingLevel = 2 }: { orgId: string; headingLevel?: 2 | 3 }) {
  const t = useT()
  const proposals = useStore((s) => s.snapshot!.employeeWork?.[orgId]?.proposals ?? [])
  const roster = useStore((s) => s.snapshot!.employees?.[orgId]?.employees ?? [])
  if (!proposals.length) return null
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  return (
    <section className="team-needs-you" aria-labelledby={`proposals-${orgId}`}>
      <Heading id={`proposals-${orgId}`} className="employee-subheading">
        {t('employees.proposal.heading', { count: proposals.length })}
      </Heading>
      <ul className="employee-work-list" aria-labelledby={`proposals-${orgId}`}>
        {proposals.map((p) => (
          <ProposalRow key={p.id} proposal={p} who={roster.find((e) => e.id === p.employeeId)?.name || p.employeeId} />
        ))}
      </ul>
    </section>
  )
}
