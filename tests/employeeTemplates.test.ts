// Starting templates (docs/ai-employees.md §16): fifteen ready Staff employees New organization offers beside Priya.
import { describe, expect, it } from 'vitest'
import { EMPLOYEE_TEMPLATE_IDS, EMPLOYEE_TEMPLATES, isEmployeeTemplateId, staffRole, templateDefinitions } from '../src/shared/employeeTemplates'
import { parseEmployee, serializeEmployee } from '../src/shared/employees'
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

  it('stay read-only with an agent that can’t run unattended, where Write would never run', () => {
    // An agent this build doesn't know can't run unattended.
    const loadouts = [{ agent: 'not-an-agent', model: '' }] as unknown as typeof claude
    const [ravi] = templateDefinitions({ templates: ['software-engineer'], repos: ['atlas'], loadouts, taken: [] })
    expect(ravi.attendance).toBe('attended')
    expect(ravi.access.repos).toEqual({ atlas: 'read' })
  })
})
