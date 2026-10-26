// One call that attaches every function of the agent, template, saved-command, schedule, integration and data commands:
// the registry calls `registerAutomationCommands((name, run) => RUNNERS.set(name, run))`.
import type { Run } from '../command'
import { agentRunners } from './agents'
import { dataRunners } from './data'
import { integrationRunners } from './integrations'
import { savedCommandRunners } from './savedCommands'
import { scheduleRunners } from './schedules'
import { templateRunners } from './templates'

export const automationRunners: Record<string, Run> = { ...agentRunners, ...templateRunners, ...savedCommandRunners, ...scheduleRunners, ...integrationRunners, ...dataRunners }

export function registerAutomationCommands(register: (name: string, run: Run) => void): void {
  for (const [name, run] of Object.entries(automationRunners)) register(name, run)
}
