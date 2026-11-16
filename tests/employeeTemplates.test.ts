// Starting templates (docs/ai-employees.md §16): fifteen ready Staff employees New organization offers beside Priya and
// Add employee offers in an existing organization: their names and hats around the roster, and who already does a job.
import { describe, expect, it } from 'vitest'
import {
  EMPLOYEE_TEMPLATE_IDS,
  EMPLOYEE_TEMPLATES,
  employeeTemplate,
  isEmployeeTemplateId,
  staffRole,
  templateColour,
  templateDefinitions,
  templateHolders,
  templateInstructions,
  templateName,
  templateNameTaken
} from '../src/shared/employeeTemplates'
import { EMPLOYEE_TEXT_LIMITS, HAT_COLOURS, parseEmployee, serializeEmployee } from '../src/shared/employees'
import { employeeSystemText } from '../src/shared/employeeWork'
import { en } from '../src/shared/i18n/en'

const claude = [{ agent: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'high' as const }]

// Every prompt an employee can be made with: each job at its own access, and each job that writes made read-only.
const prompts = [
  ...EMPLOYEE_TEMPLATES.map((t) => ({ t, access: t.access, text: templateInstructions(t) })),
  ...EMPLOYEE_TEMPLATES.filter((t) => t.access === 'write').map((t) => ({ t, access: 'read' as const, text: templateInstructions(t, 'read') }))
]

describe('employee templates', () => {
  it('are fifteen jobs, each once, each with its own name, and every one has its words in English', () => {
    expect(EMPLOYEE_TEMPLATES.map((t) => t.id)).toEqual([...EMPLOYEE_TEMPLATE_IDS])
    expect(EMPLOYEE_TEMPLATES).toHaveLength(15)
    expect(new Set(EMPLOYEE_TEMPLATES.map((t) => t.name)).size).toBe(15)
    for (const t of EMPLOYEE_TEMPLATES) {
      for (const part of ['title', 'line', 'gives'] as const) expect(en[`spaces.template.${t.id}.${part}`]).toBeTruthy()
      expect(en[`spaces.family.${t.family}`]).toBeTruthy()
    }
    expect(isEmployeeTemplateId('ux-designer')).toBe(true)
    expect(isEmployeeTemplateId('wizard')).toBe(false)
    expect(isEmployeeTemplateId(3)).toBe(false)
  })

  it('make Staff employees that read back without problems: Write on every repository, pushes and pull requests without a hold, no limits', () => {
    const made = templateDefinitions({ templates: [...EMPLOYEE_TEMPLATE_IDS], repos: ['atlas', 'site'], loadouts: claude, taken: [] })
    expect(made).toHaveLength(15)
    expect(new Set(made.map((d) => d.id)).size).toBe(15)
    for (const [i, d] of made.entries()) {
      const template = EMPLOYEE_TEMPLATES[i]
      expect(d.name).toBe(template.name)
      expect(d.role).toBe(staffRole(template))
      expect(d.look.colour).toBe(template.colour)
      expect(template.access).toBe('write')
      expect(d.access.repos).toEqual({ atlas: 'write', site: 'write' })
      expect(d.access.profile).toBe('no-shell')
      expect(d.access.actions).toEqual({ 'slack-post': 'held', linear: 'held', push: 'allowed', 'pull-request': 'allowed' })
      expect(d.access.delegate_to).toEqual([])
      expect(d.limits).toEqual({})
      expect(d.instructions).toBe(templateInstructions(template))
      expect(d.instructions).toContain('request_push and request_pull_request')
      const back = parseEmployee(serializeEmployee(d))
      expect(back.problems).toEqual([])
    }
    expect(made.find((d) => d.name === 'Uma')!.role).toBe('Staff UX designer')
    expect(made.find((d) => d.name === 'Ravi')!.role).toBe('Staff software engineer')
    for (const t of EMPLOYEE_TEMPLATES) {
      expect(t.description).toBe(en[`spaces.template.${t.id}.line`])
      expect(t.responsibilities.length).toBeGreaterThanOrEqual(3)
      expect(t.responsibilities.length).toBeLessThanOrEqual(4)
      for (const r of t.responsibilities) expect(r.length).toBeLessThanOrEqual(EMPLOYEE_TEXT_LIMITS.responsibility)
    }
  })

  it('make only those picked, each once, in the catalogue’s order, around the ids and names already taken', () => {
    const made = templateDefinitions({ templates: ['ux-designer', 'software-engineer', 'ux-designer'], repos: ['atlas'], loadouts: claude, taken: ['e-pri1'], takenNames: ['Priya', 'ravi'] })
    expect(made.map((d) => d.name)).toEqual(['Ravi (Software engineer)', 'Uma'])
    expect(made.map((d) => d.id)).not.toContain('e-pri1')
  })

  it('name a job whose name is taken "<name> (<job>)", then number it, ignoring case and spaces', () => {
    const qa = employeeTemplate('qa-engineer')
    expect(templateName(qa, ['Priya'])).toBe('Quinn')
    expect(templateName(qa, [' quinn '])).toBe('Quinn (QA engineer)')
    expect(templateName(qa, ['Quinn', 'quinn (qa engineer)'])).toBe('Quinn (QA engineer) 2')
    expect(templateName(qa, ['Quinn', 'Quinn (QA engineer)', 'Quinn (QA engineer) 2'])).toBe('Quinn (QA engineer) 3')
    // A third QA engineer no longer gets the second one's name.
    expect(templateDefinitions({ templates: ['qa-engineer'], repos: [], loadouts: claude, taken: [], takenNames: ['Quinn', 'Quinn (QA engineer)'] })[0].name).toBe('Quinn (QA engineer) 2')
  })

  it('say which name gave way to a renamed one: the last name tried before it', () => {
    const qa = employeeTemplate('qa-engineer')
    expect(templateNameTaken(qa, 'Quinn (QA engineer)')).toBe('Quinn')
    expect(templateNameTaken(qa, 'Quinn (QA engineer) 2')).toBe('Quinn (QA engineer)')
    expect(templateNameTaken(qa, 'Quinn (QA engineer) 3')).toBe('Quinn (QA engineer) 2')
    // Anything else gives the template's own name.
    expect(templateNameTaken(qa, 'Quinn (QA engineer) x')).toBe('Quinn')
    expect(templateNameTaken(qa, 'Quinn')).toBe('Quinn')
  })

  it('wear their own hat unless it is worn, then the first free one; without `worn` (New organization) each wears its own', () => {
    const qa = employeeTemplate('qa-engineer')
    expect(templateColour(qa, ['teal'])).toBe('green')
    expect(templateColour(qa, ['green', 'orange'])).toBe('pink')
    // All twelve worn: the first of the least worn repeats.
    expect(templateColour(qa, [...HAT_COLOURS])).toBe('orange')
    // Quinn and Sam are both green: the second gives way to the first one free.
    expect(templateDefinitions({ templates: ['qa-engineer', 'seo-specialist'], repos: [], loadouts: claude, taken: [], worn: ['teal'] }).map((d) => d.look.colour)).toEqual(['green', 'orange'])
    expect(templateDefinitions({ templates: ['qa-engineer', 'seo-specialist'], repos: [], loadouts: claude, taken: [] }).map((d) => d.look.colour)).toEqual(['green', 'green'])
  })

  it('know who already does a job by its Staff role, ignoring case, leaving retired employees out', () => {
    const roster = [
      { name: 'Quinn', role: 'Staff QA engineer', retired: false },
      { name: 'Q2', role: ' staff qa engineer ', retired: false },
      { name: 'Old', role: 'Staff QA engineer', retired: true },
      { name: 'Ravi', role: 'Staff software engineer', retired: false }
    ]
    expect(templateHolders(employeeTemplate('qa-engineer'), roster)).toEqual(['Quinn', 'Q2'])
    expect(templateHolders(employeeTemplate('ux-designer'), roster)).toEqual([])
  })

  it('stay read-only with an agent that can’t run unattended, where Write would never run', () => {
    // An agent this build doesn't know can't run unattended.
    const loadouts = [{ agent: 'not-an-agent', model: '' }] as unknown as typeof claude
    const made = templateDefinitions({ templates: [...EMPLOYEE_TEMPLATE_IDS], repos: ['atlas'], loadouts, taken: [] })
    for (const [i, d] of made.entries()) {
      const template = EMPLOYEE_TEMPLATES[i]
      expect(d.attendance).toBe('attended')
      expect(d.access.repos).toEqual({ atlas: 'read' })
      // A job that writes is told it is read-only, in its own words; a job that reads keeps its prompt.
      expect(d.instructions).toBe(templateInstructions(template, 'read'))
      expect(d.instructions.includes('Your access is Read')).toBe(template.access === 'write')
    }
  })

  it('give every prompt the five headings one level under Foreman’s, and Foreman’s own ending after them, once', () => {
    const headings = ['### Role', '### What you do', '### How you write', '### What you never do', '### How you finish']
    for (const { text } of prompts) {
      expect(text.match(/^#+ .*$/gm)).toEqual(headings)
      // Every job writes, and the write access line is the longer one.
      expect(text.length).toBeLessThanOrEqual(4_600)
    }
    const [ravi] = templateDefinitions({ templates: ['software-engineer'], repos: ['atlas'], loadouts: claude, taken: [] })
    const { text } = employeeSystemText({ definition: ravi, organization: 'Acme', access: { repo: 'atlas', access: 'write', profile: 'no-shell', attended: false }, orgInstructions: null })
    expect(text.split('\n## How you finish\n')).toHaveLength(2)
    expect(text.indexOf('### How you finish')).toBeLessThan(text.indexOf('\n## How you finish\n'))
  })

  it('say what each access may do, and never what a no-shell run can’t do or can’t know', () => {
    for (const { t, access, text } of prompts) {
      if (access === 'write') {
        expect(text).toContain('file tools')
        expect(text).toContain('request_push')
        expect(text).not.toContain('You change no file')
      } else {
        expect(text).toContain('You change no file')
        expect(text).not.toContain('request_push')
      }
      // The claims the first templates made: checks a run with no shell had "run", and a refusal Codex doesn't make.
      for (const words of [text, ...t.responsibilities]) expect(words).not.toMatch(/refuses every command|run the checks that cover|checks (you|it) ran|how you checked|finish at once/i)
      // The prompt is for every agent: no one agent's own tool names, and no slot spliced in with doubled punctuation.
      expect(text).not.toMatch(/\b(Glob|Bash|apply_patch|plan mode)\b/)
      expect(text).not.toMatch(/\.\.|\. \.|,\.| \./)
    }
  })
})
