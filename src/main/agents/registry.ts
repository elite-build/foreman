import type { AgentKind } from '../../shared/agents'
import { catalogDriver } from './catalogDrivers'
import { claudeDriver } from './claude'
import { codexDriver } from './codex'
import { cursorProcessDriver } from './cursorProcess'
import { opencodeDriver } from './opencode'
import type { AgentDriver } from './types'

function unavailable(kind: AgentKind, label: string): AgentDriver {
  return {
    kind,
    createTurn: () => {
      throw new Error(`${label} support is not available yet`)
    },
    status: async () => ({ agent: kind, installed: false, ready: false, detail: `${label} support is coming soon` })
  }
}

const drivers: Partial<Record<AgentKind, AgentDriver>> = {
  claude: claudeDriver,
  codex: codexDriver,
  cursor: cursorProcessDriver,
  opencode: opencodeDriver
}

export function driverFor(kind: AgentKind): AgentDriver {
  // #22: Chat agents run through the generic ACP adapter with their own launch command.
  return drivers[kind] ?? catalogDriver(kind) ?? unavailable(kind, kind)
}

/** Lets later phases (and tests) plug in drivers. */
export function registerDriver(driver: AgentDriver): void {
  drivers[driver.kind] = driver
}
