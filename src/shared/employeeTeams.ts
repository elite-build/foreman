// The program manager every organization has (docs/ai-employees.md §15): made with the organization, approved with it
// (her definition is fixed and the same everywhere), and its lead. She plans projects, proposes the employees a plan
// needs, reviews what parts produce and accepts the result; she never changes a repository, never sends anything
// outward and never starts work herself: Foreman starts each part of the plan the person approved. Pure.

import { canRunUnattended } from './agentCatalog'
import type { Loadout } from './agents'
import { defaultEmployee, newEmployeeId, type EmployeeDefinition } from './employees'
import { PROGRAM_MANAGER_NAME } from './projects'

const INSTRUCTIONS = `## Role
You are the program manager. Every project in this organization starts with you: the person tags you with what should exist, and you decide whether it is worth doing and how big it is, plan it, review what each part produces, replan when something goes wrong, and accept the result.

## What you do
- Plan: break the request into parts, each with one owner, the file it writes, what it reads and what must finish first, and say where the person checks. Use the people on the team; when nobody fits, propose a new employee (the person approves each one). Give your plan with project_plan.
- Replan: when a part can't finish or the result isn't right, give the plan's owners what they need to fix it, and change as little as possible.
- Accept: at the end, check the result against everything the person asked for, and say plainly what is met and what isn't.

## How you write
Short, plain sentences. Name the user and the problem first. Never estimate effort in time.

## What you never do
Change a repository, run a shell, send anything outside this computer, or grant anyone access: Foreman starts the parts of the plan the person approved.

## How you finish
A planning task ends with project_plan, then finish_task done. An acceptance writes acceptance.md and finishes with the decision it asks for. When the request is too thin to plan, ask the person with ask_person.`

/** Priya's definition: Read on every repository the organization has, no shell, everything outward held, many short runs. */
export function programManagerDefinition(input: { repos: readonly string[]; loadouts: readonly Pick<Loadout, 'agent' | 'model' | 'effort'>[]; taken: Iterable<string>; takenNames?: readonly string[] }): EmployeeDefinition {
  const unattended = input.loadouts.find((l) => canRunUnattended(l.agent))
  const names = (input.takenNames ?? []).map((n) => n.toLocaleLowerCase())
  const name = names.includes(PROGRAM_MANAGER_NAME.toLocaleLowerCase()) ? `${PROGRAM_MANAGER_NAME} (PM)` : PROGRAM_MANAGER_NAME
  const base = defaultEmployee({
    id: newEmployeeId(input.taken),
    colour: 'teal',
    repos: input.repos,
    loadouts: unattended ? [unattended] : input.loadouts,
    text: {
      name,
      role: 'Program manager',
      description: 'Plans every project, proposes who it needs, reviews each part and accepts the result.',
      responsibilities: ['Plan each project the person tags you with', 'Propose employees when nobody on the team fits', 'Replan when a part can’t finish', 'Accept the result against what was asked'],
      ask_me_about: 'Projects: what is planned, who does what, and where it stands',
      instructions: INSTRUCTIONS
    }
  })
  return { ...base, limits: { ...base.limits, runs_per_day: 100, minutes_per_run: 20 } }
}

/** A draft for an employee the program manager proposed: the safest settings, Write only where the plan asks for it. */
export function proposedDefinition(input: {
  id: string
  colour: string
  name: string
  role: string
  description: string
  responsibilities: readonly string[]
  instructions: string
  repos: Record<string, 'read' | 'write'>
  loadouts: readonly Pick<Loadout, 'agent' | 'model' | 'effort'>[]
}): EmployeeDefinition {
  const unattended = input.loadouts.find((l) => canRunUnattended(l.agent))
  const base = defaultEmployee({
    id: input.id,
    colour: input.colour,
    repos: Object.keys(input.repos),
    loadouts: unattended ? [unattended] : input.loadouts,
    text: { name: input.name, role: input.role, description: input.description, responsibilities: [...input.responsibilities], ask_me_about: input.role, instructions: input.instructions }
  })
  // An agent that can't run unattended is attended, and an attended employee is read-only: Write would never run.
  const write = base.attendance === 'unattended'
  return {
    ...base,
    access: { ...base.access, repos: Object.fromEntries(Object.entries(input.repos).map(([r, a]) => [r, a === 'write' && write ? 'write' : 'read'])) },
    limits: { ...base.limits, runs_per_day: 20, minutes_per_run: 45 }
  }
}
