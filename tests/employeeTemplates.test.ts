// Starting templates (docs/ai-employees.md §16): fifteen ready Staff employees New organization offers beside Priya and
// Add employee offers in an existing organization: their names and hats around the roster, and who already does a job.
import { describe, expect, it } from 'vitest'
import { EMPLOYEE_TEMPLATE_IDS, EMPLOYEE_TEMPLATES, employeeTemplate, isEmployeeTemplateId, staffRole, templateColour, templateDefinitions, templateHolders, templateName } from '../src/shared/employeeTemplates'
import { HAT_COLOURS, parseEmployee, serializeEmployee } from '../src/shared/employees'
import { en } from '../src/shared/i18n/en'

const claude = [{ agent: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'high' as const }]

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

  it('make Staff employees that read back without problems: Write on every repository for a job that writes, Read for the rest', () => {
    const made = templateDefinitions({ templates: [...EMPLOYEE_TEMPLATE_IDS], repos: ['atlas', 'site'], loadouts: claude, taken: [] })
    expect(made).toHaveLength(15)
    expect(new Set(made.map((d) => d.id)).size).toBe(15)
    for (const [i, d] of made.entries()) {
      const template = EMPLOYEE_TEMPLATES[i]
      expect(d.name).toBe(template.name)
      expect(d.role).toBe(staffRole(template))
      expect(d.look.colour).toBe(template.colour)
      expect(d.access.repos).toEqual({ atlas: template.access, site: template.access })
      expect(d.access.profile).toBe('no-shell')
      expect(Object.values(d.access.actions).every((a) => a === 'held')).toBe(true)
      expect(d.instructions).toContain('## How you finish')
      const back = parseEmployee(serializeEmployee(d))
      expect(back.problems).toEqual([])
    }
    expect(made.find((d) => d.name === 'Uma')!.role).toBe('Staff UX designer')
    expect(made.find((d) => d.name === 'Ravi')!.role).toBe('Staff software engineer')
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
    const [ravi] = templateDefinitions({ templates: ['software-engineer'], repos: ['atlas'], loadouts, taken: [] })
    expect(ravi.attendance).toBe('attended')
    expect(ravi.access.repos).toEqual({ atlas: 'read' })
  })
})
