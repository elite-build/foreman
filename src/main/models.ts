// The model catalog: each agent says which models it offers with the current
// sign-in, and the picker shows exactly that. Lists are cached in app state so
// the picker is filled at startup, then refreshed in the background.
import { AGENT_ORDER, setModelCatalog, type AgentKind, type ModelCatalog } from '../shared/agents'
import type { AcpMode } from '../shared/agentCatalog'
import type { ModelCatalogState } from '../shared/types'
import { driverFor } from './agents/registry'
import type { OneShotOptions } from './agents/types'
import type { Store } from './store'

export class ModelCatalogService {
  private inflight = new Map<AgentKind, Promise<void>>()

  constructor(
    private store: Store,
    private optionsFor: (agent: AgentKind) => OneShotOptions,
    private changed: () => void
  ) {
    setModelCatalog(this.models())
  }

  // The Full agents, plus any Chat agent (#22) that has been asked for its models.
  private listed(): AgentKind[] {
    const asked = [...Object.keys(this.store.state.catalog.agents), ...this.inflight.keys()] as AgentKind[]
    return [...new Set([...AGENT_ORDER, ...asked])]
  }

  /** The state the renderer sees, with fetches in progress marked. */
  state(): ModelCatalogState {
    const { agents, outputStyles } = this.store.state.catalog
    const marked = Object.fromEntries(this.listed().map((a) => [a, { models: [], ...agents[a], loading: this.inflight.has(a) || undefined }]))
    return { agents: marked, outputStyles }
  }

  private models(): ModelCatalog {
    const { agents } = this.store.state.catalog
    return Object.fromEntries(this.listed().map((a) => [a, agents[a]?.models ?? []]))
  }

  /** Ask the agent for its models again. Concurrent calls share one fetch. */
  refresh(agent: AgentKind): Promise<void> {
    const running = this.inflight.get(agent)
    if (running) return running
    const work = this.fetch(agent).finally(() => {
      this.inflight.delete(agent)
      this.changed()
    })
    this.inflight.set(agent, work)
    this.changed()
    return work
  }

  refreshAll(agents: AgentKind[] = AGENT_ORDER): Promise<void> {
    return Promise.all(agents.map((a) => this.refresh(a))).then(() => undefined)
  }

  private async fetch(agent: AgentKind): Promise<void> {
    const driver = driverFor(agent)
    if (!driver.listModels) return
    const catalog = this.store.state.catalog
    const previous = catalog.agents[agent]
    try {
      const list = await driver.listModels(this.optionsFor(agent))
      // G1: an ACP agent's declared session modes come with its list; a later turn may update them (declaredModes).
      const modes = list.modes ?? previous?.modes
      catalog.agents[agent] = { models: list.models, ...(modes?.length ? { modes } : {}), fetchedAt: new Date().toISOString() }
      if (list.outputStyles?.length) catalog.outputStyles = list.outputStyles
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      catalog.agents[agent] = { models: previous?.models ?? [], ...(previous?.modes ? { modes: previous.modes } : {}), fetchedAt: previous?.fetchedAt, error }
    }
    setModelCatalog(this.models())
    this.store.save()
  }

  /** G1: the session modes an ACP agent declared when a turn started. Returns true when they changed (the Plan chip may follow). */
  declaredModes(agent: AgentKind, modes: AcpMode[]): boolean {
    const catalog = this.store.state.catalog
    const previous = catalog.agents[agent]
    if (JSON.stringify(previous?.modes ?? []) === JSON.stringify(modes)) return false
    catalog.agents[agent] = { models: previous?.models ?? [], ...previous, modes: modes.length ? modes : undefined }
    this.store.save()
    return true
  }
}
