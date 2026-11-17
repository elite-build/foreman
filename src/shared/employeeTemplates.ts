// Starting templates (docs/ai-employees.md §16): ready Staff employees, one per common job, that New organization offers
// beside Priya and Add employee offers in an existing organization. Each has a name and hat (changed later on its
// page), its job's responsibilities, its job's own prompt (shared/employeePrompts/<id>.md, which the employee is linked
// to rather than given a copy of) and Write on the organization's repositories for every job, so each can push its
// branch and open a pull request. Making the organization approves the ones picked, as it approves Priya; Add employee
// approves the one picked. Their words are sent to agents, so they stay English like every agent prompt; the renderer
// shows the job's title and line through i18n. Pure.

import type { Loadout } from './agents'
import { ownPromptNote, type JobPromptId } from './employeePrompts'
import { proposedDefinition } from './employeeTeams'
import { freeHatColour, newEmployeeId, type EmployeeDefinition, type HatColour } from './employees'

export const EMPLOYEE_TEMPLATE_IDS = [
  'software-engineer',
  'frontend-engineer',
  'qa-engineer',
  'security-engineer',
  'site-reliability-engineer',
  'software-architect',
  'ux-designer',
  'web-designer',
  'product-manager',
  'data-analyst',
  'technical-writer',
  'copywriter',
  'seo-specialist',
  'marketing-manager',
  'support-engineer'
] as const
export type EmployeeTemplateId = (typeof EMPLOYEE_TEMPLATE_IDS)[number]

export type EmployeeTemplateFamily = 'engineering' | 'design' | 'product' | 'data' | 'writing' | 'marketing' | 'customers'

/** A job an employee can be hired for ready to work. Its prompt is its own file, shared/employeePrompts/<id>.md. */
export interface EmployeeTemplate {
  id: EmployeeTemplateId
  family: EmployeeTemplateFamily
  // The job's title in the definition ("Staff software engineer" is its role).
  job: string
  name: string
  colour: HatColour
  // Write on every repository the organization has (every template has it), or Read.
  access: 'read' | 'write'
  // The picker's line, the same as its i18n `line` in English.
  description: string
  // Duties, three or four short lines: the employee's page and the body of Run now.
  responsibilities: string[]
}

export const EMPLOYEE_TEMPLATES: readonly EmployeeTemplate[] = [
  {
    id: 'software-engineer',
    family: 'engineering',
    job: 'Software engineer',
    name: 'Ravi',
    colour: 'blue',
    access: 'write',
    description: 'Builds and fixes features, with tests, on its own branch.',
    responsibilities: ['Build and fix what is asked, with tests, in the repository’s conventions', 'Find the cause of a bug before fixing it', 'Keep each change small and compatible with what exists', 'Report what changed, what was not run and what is left']
  },
  {
    id: 'frontend-engineer',
    family: 'engineering',
    job: 'Frontend engineer',
    name: 'Mei',
    colour: 'cyan',
    access: 'write',
    description: 'Builds screens and components and keeps them accessible.',
    responsibilities: ['Build and fix screens and components, with tests, from the design system', 'Build every state: empty, loading, error, narrow', 'Keep every screen usable by keyboard and screen reader', 'Report what changed and what still needs a person to look']
  },
  {
    id: 'qa-engineer',
    family: 'engineering',
    job: 'QA engineer',
    name: 'Quinn',
    colour: 'green',
    access: 'write',
    description: 'Reviews what others build and says what breaks.',
    responsibilities: ['Check each change against what was asked, item by item', 'Find what breaks at the edges and what the tests don’t cover', 'Write test plans someone can run', 'Report each problem with where it is, how to show it and a fix']
  },
  {
    id: 'security-engineer',
    family: 'engineering',
    job: 'Security engineer',
    name: 'Omar',
    colour: 'red',
    access: 'write',
    description: 'Reviews changes and dependencies for security risks.',
    responsibilities: ['Review changes for the ways in: input, access, secrets, injection, unsafe defaults', 'List dependencies from the lockfile and what is known about them, with its source', 'Rate each risk by what an attacker can do and how easily', 'Report each risk with its path, severity and a fix']
  },
  {
    id: 'site-reliability-engineer',
    family: 'engineering',
    job: 'Site reliability engineer',
    name: 'Sofia',
    colour: 'brown',
    access: 'write',
    description: 'Keeps builds, deploys and services healthy.',
    responsibilities: ['Find the cause of failing builds, deploys and services from what is recorded', 'Fix causes in the files that run them, with the rollback said', 'Make the next failure visible: checks, logs, alerts', 'Report what a person should run to confirm the fix']
  },
  {
    id: 'software-architect',
    family: 'engineering',
    job: 'Software architect',
    name: 'Kenji',
    colour: 'slate',
    access: 'write',
    description: 'Shapes the system and reviews big changes before they start.',
    responsibilities: ['Plan big changes before they start: modules, order, interfaces, risks', 'Review designs against the system’s boundaries and invariants', 'Choose between options and say why', 'Report a plan with its decisions, open questions and checks']
  },
  {
    id: 'ux-designer',
    family: 'design',
    job: 'UX designer',
    name: 'Uma',
    colour: 'pink',
    access: 'write',
    description: 'Reviews screens and flows, and specifies what to build.',
    responsibilities: ['Walk each flow as the person using it and find where they get stuck', 'Review states, words, keyboard and narrow widths', 'Specify what to build: layout, states, words, keyboard, components', 'Report findings ordered by harm, or a spec someone can build']
  },
  {
    id: 'web-designer',
    family: 'design',
    job: 'Web designer',
    name: 'Leo',
    colour: 'lime',
    access: 'write',
    description: 'Designs and builds marketing and content sites.',
    responsibilities: ['Design and build pages in the site’s own stack', 'Give each page a clear purpose, on a phone and by keyboard', 'Keep pages light and findable: images, scripts, titles, structure', 'Report what changed and how to see it']
  },
  {
    id: 'product-manager',
    family: 'product',
    job: 'Product manager',
    name: 'Nia',
    colour: 'purple',
    access: 'write',
    description: 'Recommends what to build next and writes the requirements.',
    responsibilities: ['Name who has the problem and what it costs them before anything else', 'Write requirements someone can build from and test: Must, Won’t, done', 'Recommend what to build, defer or drop, with reasons', 'Report requirements or an ordered roadmap']
  },
  {
    id: 'data-analyst',
    family: 'data',
    job: 'Data analyst',
    name: 'Dara',
    colour: 'yellow',
    access: 'write',
    description: 'Answers questions with data and specifies dashboards.',
    responsibilities: ['Turn each question into one that can be measured', 'Find and check the data: source, definition, gaps', 'Answer with the number, its source, its method and how sure you are, or with the analysis still to run', 'Specify dashboards by the question each chart answers']
  },
  {
    id: 'technical-writer',
    family: 'writing',
    job: 'Technical writer',
    name: 'Theo',
    colour: 'orange',
    access: 'write',
    description: 'Writes the docs and keeps them up to date.',
    responsibilities: ['Write the docs people need for a task: guides, references, READMEs', 'Check every step and claim against the code', 'Find and fix every page a change makes wrong', 'Report what was checked and what was not']
  },
  {
    id: 'copywriter',
    family: 'writing',
    job: 'Copywriter',
    name: 'Ines',
    colour: 'purple',
    access: 'write',
    description: 'Writes release notes, launch posts and site copy.',
    responsibilities: ['Write release notes, launch posts and site copy from the source', 'Lead with what changes for the reader, in their words', 'Keep one voice and one set of terms across everything', 'Report the copy, where it goes and what backs each claim']
  },
  {
    id: 'seo-specialist',
    family: 'marketing',
    job: 'SEO specialist',
    name: 'Sam',
    colour: 'green',
    access: 'write',
    description: 'Audits the site for search and suggests fixes.',
    responsibilities: ['Audit the site from its code: titles, structure, links, canonicals, sitemap, structured data', 'Map pages to what people search for and find the gaps', 'Find what in the files slows pages and say what to measure', 'Report fixes in order, each with where it is']
  },
  {
    id: 'marketing-manager',
    family: 'marketing',
    job: 'Marketing manager',
    name: 'Ana',
    colour: 'orange',
    access: 'write',
    description: 'Plans launches and the messages around them.',
    responsibilities: ['Name who it is for and the one thing they should remember', 'Plan each launch: message, proof, channels, order, owners', 'Write the words ready to use, with what backs each claim', 'Report a launch plan with the decisions it needs from the person']
  },
  {
    id: 'support-engineer',
    family: 'customers',
    job: 'Support engineer',
    name: 'Jonah',
    colour: 'cyan',
    access: 'write',
    description: 'Triages issues and traces what users report in the code.',
    responsibilities: ['Triage each report: what it is, how bad, who should take it', 'Trace it in the code and say where it likely starts', 'Carry every detail forward and ask the user only for what is missing', 'Report a triage note with the next step']
  }
]

export const isEmployeeTemplateId = (value: unknown): value is EmployeeTemplateId => typeof value === 'string' && (EMPLOYEE_TEMPLATE_IDS as readonly string[]).includes(value)

export const employeeTemplate = (id: EmployeeTemplateId): EmployeeTemplate => EMPLOYEE_TEMPLATES.find((t) => t.id === id)!

/** A job's title: a template's ("QA engineer"), or the program manager's. */
export const jobTitle = (id: JobPromptId): string => (id === 'program-manager' ? 'Program manager' : employeeTemplate(id).job)

/** "Staff software engineer", "Staff UX designer": a title in a sentence keeps its initialisms. */
export const staffRole = (template: EmployeeTemplate): string => `Staff ${/^[A-Z]{2}/.test(template.job) ? template.job : template.job.charAt(0).toLowerCase() + template.job.slice(1)}`

/**
 * A template employee's name: its own, else "<name> (<job>)" once an employee has that, then "<name> (<job>) 2", 3…
 * `takenNames` are every employee's names, retired ones too; compared ignoring case and surrounding spaces.
 */
export function templateName(template: EmployeeTemplate, takenNames: Iterable<string>): string {
  const taken = new Set([...takenNames].map((n) => n.trim().toLocaleLowerCase()))
  if (!taken.has(template.name.toLocaleLowerCase())) return template.name
  const job = `${template.name} (${template.job})`
  if (!taken.has(job.toLocaleLowerCase())) return job
  for (let n = 2; ; n++) if (!taken.has(`${job} ${n}`.toLocaleLowerCase())) return `${job} ${n}`
}

/**
 * The name templateName tried last before `name`, which was taken ("Named Quinn (QA engineer) 2: … already called
 * Quinn (QA engineer)"): the template's own name for "<name> (<job>)", "<name> (<job>)" for "… 2", "… 2" for "… 3".
 * The template's own name for any other name.
 */
export function templateNameTaken(template: EmployeeTemplate, name: string): string {
  const job = `${template.name} (${template.job})`
  const n = name.startsWith(`${job} `) ? Number(name.slice(job.length + 1)) : NaN
  if (!Number.isInteger(n) || n < 2) return template.name
  return n === 2 ? job : `${job} ${n - 1}`
}

/** A template employee's hat: its own colour unless an employee who isn't retired wears it, then the first free one (§5.4). */
export function templateColour(template: EmployeeTemplate, worn: readonly string[]): HatColour {
  return worn.includes(template.colour) ? freeHatColour(worn) : template.colour
}

/**
 * Who already does the template's job: the names of the employees who aren't retired whose role is its Staff role,
 * ignoring case ("You already have Quinn"). The role stands for the job until a definition records its profile (§16.1).
 */
export function templateHolders(template: EmployeeTemplate, roster: readonly { name: string; role: string; retired: boolean }[]): string[] {
  const role = staffRole(template).toLocaleLowerCase()
  return roster.filter((e) => !e.retired && e.role.trim().toLocaleLowerCase() === role).map((e) => e.name)
}

/**
 * The definitions for the templates picked, in the catalogue's order and each once, on the organization's repositories.
 * `taken` and `takenNames` are the ids and names already in it (Priya's too, retired employees' too): a template whose
 * name is taken is named as templateName says. With `worn` (the hats of the employees who aren't retired), a template
 * whose colour is worn gets a free one, as Add employee does; without it each wears its own, as in New organization.
 */
export function templateDefinitions(input: {
  templates: readonly EmployeeTemplateId[]
  repos: readonly string[]
  loadouts: readonly Pick<Loadout, 'agent' | 'model' | 'effort'>[]
  taken: Iterable<string>
  takenNames?: readonly string[]
  worn?: readonly string[]
}): EmployeeDefinition[] {
  const ids = new Set(input.taken)
  const names = [...(input.takenNames ?? [])]
  const worn = input.worn ? [...input.worn] : null
  const wanted = new Set(input.templates)
  return EMPLOYEE_TEMPLATES.filter((t) => wanted.has(t.id)).map((t) => {
    const id = newEmployeeId(ids)
    ids.add(id)
    const name = templateName(t, names)
    names.push(name)
    const colour = worn ? templateColour(t, worn) : t.colour
    worn?.push(colour)
    // Linked to its job's prompt; its own file starts with the note, and what its organization adds goes under it.
    return proposedDefinition({
      id,
      colour,
      name,
      role: staffRole(t),
      description: t.description,
      responsibilities: t.responsibilities,
      template: t.id,
      instructions: ownPromptNote(t.job, id),
      repos: Object.fromEntries(input.repos.map((r) => [r, t.access])),
      loadouts: input.loadouts
    })
  })
}
