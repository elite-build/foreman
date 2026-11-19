// The program manager every organization has (docs/ai-employees.md §15): made with the organization, approved with it
// (her definition is fixed and the same everywhere), and its lead. She asks before she plans, plans projects, proposes
// the employees a plan needs, reviews what parts produce and accepts the result; like every employee she may write the
// organization's repositories, push and open pull requests, but she never starts work herself: Foreman starts each part
// of the plan the person approved. Pure.

import { canRunUnattended } from './agentCatalog'
import type { Loadout } from './agents'
import { ownPromptNote, type JobPromptId } from './employeePrompts'
import { newEmployee, newEmployeeId, type EmployeeDefinition } from './employees'
import { PROGRAM_MANAGER_NAME } from './projects'

/**
 * Priya's definition: Write on every repository the organization has, pushes and pull requests allowed, a shell, no
 * limits, as every new employee has (newEmployee). Her prompt is the program manager's
 * (shared/employeePrompts/program-manager.md), linked rather than copied.
 */
export function programManagerDefinition(input: { repos: readonly string[]; loadouts: readonly Pick<Loadout, 'agent' | 'model' | 'effort'>[]; taken: Iterable<string>; takenNames?: readonly string[] }): EmployeeDefinition {
  const unattended = input.loadouts.find((l) => canRunUnattended(l.agent))
  const names = (input.takenNames ?? []).map((n) => n.toLocaleLowerCase())
  const name = names.includes(PROGRAM_MANAGER_NAME.toLocaleLowerCase()) ? `${PROGRAM_MANAGER_NAME} (PM)` : PROGRAM_MANAGER_NAME
  const id = newEmployeeId(input.taken)
  const made = newEmployee({
    id,
    colour: 'teal',
    repos: input.repos,
    loadouts: unattended ? [unattended] : input.loadouts,
    text: {
      name,
      role: 'Program manager',
      description: 'Plans every project, proposes who it needs, reviews each part and accepts the result.',
      responsibilities: ['Ask what you need to know before you plan', 'Plan each project the person tags you with', 'Propose employees when nobody on the team fits', 'Replan when a part can’t finish', 'Accept the result against what was asked'],
      ask_me_about: 'Projects: what is planned, who does what, and where it stands',
      instructions: ownPromptNote('Program manager', id)
    }
  })
  return { ...made, template: 'program-manager' }
}

/**
 * A draft for an employee the program manager proposed, or a template's: Write on every repository the plan names, as
 * every employee has. With `template`, it is linked to that job's prompt and `instructions` is what it adds.
 */
export function proposedDefinition(input: {
  id: string
  colour: string
  name: string
  role: string
  description: string
  responsibilities: readonly string[]
  template?: JobPromptId
  instructions: string
  repos: Record<string, 'read' | 'write'>
  loadouts: readonly Pick<Loadout, 'agent' | 'model' | 'effort'>[]
}): EmployeeDefinition {
  const unattended = input.loadouts.find((l) => canRunUnattended(l.agent))
  // newEmployee gives Write on each, or Read when its agent can't run unattended (an attended employee is read-only).
  const made = newEmployee({
    id: input.id,
    colour: input.colour,
    repos: Object.keys(input.repos),
    loadouts: unattended ? [unattended] : input.loadouts,
    text: { name: input.name, role: input.role, description: input.description, responsibilities: [...input.responsibilities], ask_me_about: input.role, instructions: input.instructions }
  })
  return input.template ? { ...made, template: input.template } : made
}
