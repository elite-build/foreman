// #22: the two-letter badge for catalog agents that have no icon of their own.
import { catalogAgent } from '../../../../shared/agentCatalog'
import './catalog.css'

export function AgentMonogram({ agent, large }: { agent: string; large?: boolean }) {
  const info = catalogAgent(agent)
  return (
    <span className={`agent-mono ${large ? 'large' : ''}`} aria-hidden>
      {info?.monogram ?? agent.slice(0, 2)}
    </span>
  )
}
