// A new version of a flow the assistant proposed with propose_flow (src/main/assistant.ts): its reason and what it adds,
// changes and removes. Here it is only read; the flow studio it was proposed from applies or discards it.
import type { FlowProposal } from '../../../../shared/assistant'
import { useT } from '../../i18n'
import { Card } from '../../ui'
import { FlowChangeList } from '../automations/FlowChanges'

export function FlowProposalCard({ proposal }: { proposal: FlowProposal }) {
  const t = useT()
  return (
    <Card className="assistant-flow-proposal">
      <strong>{t('assistant.flowProposal.title')}</strong>
      {proposal.summary && <span>{proposal.summary}</span>}
      {proposal.changes.length ? <FlowChangeList changes={proposal.changes} label={t('assistant.flowProposal.changes', { count: proposal.changes.length })} /> : <span className="small">{t('assistant.flowProposal.replaces')}</span>}
      <span className="faint small">{t('assistant.flowProposal.note')}</span>
    </Card>
  )
}
