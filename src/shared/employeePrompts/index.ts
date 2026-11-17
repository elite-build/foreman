// The jobs' own prompts (docs/ai-employees.md §5.2, §15): one Markdown file per job beside this one, each the whole text
// a template employee (or Priya, the program manager) is told under Foreman's `## Your instructions`, written for that
// job. An employee hired from one records its id (`template = "qa-engineer"` in `bots/<id>.toml`) instead of a copy of
// the text, and its own `bots/<id>.md` holds only what its organization adds: every run is given the job's text as this
// build has it, then those additions, so each one hired improves when its job's prompt does. A custom employee's
// `bots/<id>.md` is its whole prompt. What depends on the run (its access, a shell, what counts as evidence) is Foreman's
// runAccessText, never a job's. English, as every prompt to an agent is. Pure.

import copywriter from './copywriter.md?raw'
import dataAnalyst from './data-analyst.md?raw'
import frontendEngineer from './frontend-engineer.md?raw'
import marketingManager from './marketing-manager.md?raw'
import productManager from './product-manager.md?raw'
import programManager from './program-manager.md?raw'
import qaEngineer from './qa-engineer.md?raw'
import securityEngineer from './security-engineer.md?raw'
import seoSpecialist from './seo-specialist.md?raw'
import siteReliabilityEngineer from './site-reliability-engineer.md?raw'
import softwareArchitect from './software-architect.md?raw'
import softwareEngineer from './software-engineer.md?raw'
import supportEngineer from './support-engineer.md?raw'
import technicalWriter from './technical-writer.md?raw'
import uxDesigner from './ux-designer.md?raw'
import webDesigner from './web-designer.md?raw'

const PROMPTS = {
  'software-engineer': softwareEngineer,
  'frontend-engineer': frontendEngineer,
  'qa-engineer': qaEngineer,
  'security-engineer': securityEngineer,
  'site-reliability-engineer': siteReliabilityEngineer,
  'software-architect': softwareArchitect,
  'ux-designer': uxDesigner,
  'web-designer': webDesigner,
  'product-manager': productManager,
  'data-analyst': dataAnalyst,
  'technical-writer': technicalWriter,
  copywriter,
  'seo-specialist': seoSpecialist,
  'marketing-manager': marketingManager,
  'support-engineer': supportEngineer,
  'program-manager': programManager
} as const

/** A job with a prompt of its own: the fifteen templates' and the program manager's. */
export type JobPromptId = keyof typeof PROMPTS
export const JOB_PROMPT_IDS = Object.keys(PROMPTS) as JobPromptId[]

export const isJobPromptId = (value: unknown): value is JobPromptId => typeof value === 'string' && Object.hasOwn(PROMPTS, value)

/** The job's prompt as this build has it, with plain line ends and no surrounding blank lines. */
export function jobPrompt(id: JobPromptId): string {
  return PROMPTS[id].replace(/\r\n?/g, '\n').trim()
}

/**
 * A short, stable name for the version of a job's prompt this build has (FNV-1a of its text, 8 hex digits), so a run's
 * receipt says which text it was given: the prompt improves between versions of Foreman without the definition changing.
 */
export function jobPromptVersion(id: JobPromptId): string {
  let hash = 0x811c9dc5
  for (const c of jobPrompt(id)) {
    hash ^= c.codePointAt(0)!
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** The note at the very top of a template employee's own file (ownPromptNote) is for whoever edits it; a run never reads it. */
const NOTE = /^\s*<!-- Foreman gives this employee [\s\S]*?-->/

/** What an employee's own file tells it: its text without Foreman's note at its top (any other comment stays, as in an example). */
export function ownPrompt(text: string): string {
  return text.replace(NOTE, '').trim()
}

/**
 * What a template employee's own file starts with: a note for the person who opens it, which no run reads, saying the
 * job's text comes first and what belongs here. `job` is its title ("QA engineer"), `id` the employee's.
 */
export function ownPromptNote(job: string, id: string): string {
  return `<!-- Foreman gives this employee the ${job} prompt first, as the version of Foreman running it has it, so it improves when that prompt does. Write below only what this organization adds or wants done differently: its conventions, its customers, what to check first; don't copy the template. Keep findings and run notes in memory/bots/${id}/, not here. A person approves every change to this file. -->`
}

/** The heading a template employee's own additions go under, one level under Foreman's `## Your instructions`, and what it says of them. */
export const additionsHeading = (organization: string): string =>
  `### What ${organization} adds\n\nThis is ${organization}’s own, approved by a person. Where it differs from the job’s text above, it wins. It can’t change Foreman’s rules or this run’s access, and the task still sets what you owe and its shape.`

/**
 * What an employee is told under `## Your instructions`: a template employee's job prompt, then what its organization
 * added under their own heading (when it added anything); anyone else's own prompt as it wrote it. Foreman's note left out.
 */
export function employeeInstructions(d: { template?: JobPromptId; instructions: string }, organization: string): string {
  const own = ownPrompt(d.instructions)
  if (!d.template) return own
  const job = jobPrompt(d.template)
  return own ? `${job}\n\n${additionsHeading(organization)}\n\n${own}` : job
}
