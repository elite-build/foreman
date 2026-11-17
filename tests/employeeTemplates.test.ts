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
  templateName,
  templateNameTaken
} from '../src/shared/employeeTemplates'
import { additionsHeading, employeeInstructions, JOB_PROMPT_IDS, jobPrompt, ownPromptNote } from '../src/shared/employeePrompts'
import { EMPLOYEE_TEXT_LIMITS, employeePromptFile, HAT_COLOURS, parseEmployee, serializeEmployee } from '../src/shared/employees'
import { employeeSystemText } from '../src/shared/employeeWork'
import { programManagerDefinition } from '../src/shared/employeeTeams'
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

  it('make Staff employees that read back without problems: a shell, Write on every repository, pushes and pull requests without a hold, no limits', () => {
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
      expect(d.access.profile).toBe('shell')
      expect(d.access.actions).toEqual({ 'slack-post': 'held', linear: 'held', push: 'allowed', 'pull-request': 'allowed' })
      expect(d.access.delegate_to).toEqual([])
      // Linked to its job's prompt, not given a copy: its own file holds only the note for whoever edits it.
      expect(d.template).toBe(template.id)
      expect(d.instructions).toBe(ownPromptNote(template.job, d.id))
      expect(employeeInstructions(d, 'Acme')).toBe(jobPrompt(template.id))
      const back = parseEmployee(serializeEmployee(d), undefined, employeePromptFile(d))
      expect(back.problems).toEqual([])
      expect(back.definition).toEqual(d)
    }
    expect(made.find((d) => d.name === 'Uma')!.role).toBe('Staff UX designer')
    // Uma draws what she proposes as HTML mocks, two options each, in the folder her task names, and lists them.
    const uma = jobPrompt('ux-designer')
    expect(uma).toContain('Draw what you propose as HTML mocks the person opens in a browser')
    expect(uma).toContain('two options (a and b')
    expect(uma).toContain('in the mocks folder your task names, else in your own memory folder under mocks/<yyyy-mm-dd>-<topic>/')
    expect(uma).toContain('Mocks (each file, what it shows, the option you suggest)')
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

  it('stay read-only with an agent that can’t run unattended, where Write would never run, on the same job prompt', () => {
    // An agent this build doesn't know can't run unattended.
    const loadouts = [{ agent: 'not-an-agent', model: '' }] as unknown as typeof claude
    const made = templateDefinitions({ templates: [...EMPLOYEE_TEMPLATE_IDS], repos: ['atlas'], loadouts, taken: [] })
    for (const [i, d] of made.entries()) {
      expect(d.attendance).toBe('attended')
      expect(d.access.repos).toEqual({ atlas: 'read' })
      // What a read-only run may do is Foreman's to say for the run (runAccessText), so the job's text is the same.
      expect(d.template).toBe(EMPLOYEE_TEMPLATES[i].id)
    }
  })

  it('give every job its own prompt file, Priya’s too, with ### headings under Foreman’s and Foreman’s own ending after it, once', () => {
    expect(JOB_PROMPT_IDS).toEqual([...EMPLOYEE_TEMPLATE_IDS, 'program-manager'])
    for (const id of JOB_PROMPT_IDS) {
      const text = jobPrompt(id)
      const headings = text.match(/^#+ .*$/gm) ?? []
      expect(headings[0]).toBe('### Role')
      for (const heading of headings) expect(heading).toMatch(/^#### ?|^### /)
      // Every job's own: no two jobs share a prompt.
      expect(JOB_PROMPT_IDS.filter((other) => jobPrompt(other) === text)).toEqual([id])
    }
    const [ravi] = templateDefinitions({ templates: ['software-engineer'], repos: ['atlas'], loadouts: claude, taken: [] })
    const priya = programManagerDefinition({ repos: ['atlas'], loadouts: claude, taken: [] })
    expect(priya.template).toBe('program-manager')
    for (const d of [ravi, priya]) {
      const { text } = employeeSystemText({ definition: d, organization: 'Acme', access: { repo: 'atlas', access: 'write', profile: 'no-shell', attended: false }, orgInstructions: null })
      expect(text).toContain(`## Your instructions\n\n${jobPrompt(d.template!)}`)
      expect(text.split('\n## How you finish\n')).toHaveLength(2)
      // The note in its own file is for whoever edits it; no run reads it.
      expect(text).not.toContain('<!--')
    }
  })

  it('put what an organization adds after the job’s prompt, under its own heading, and nothing when it added nothing', () => {
    const [quinn] = templateDefinitions({ templates: ['qa-engineer'], repos: ['atlas'], loadouts: claude, taken: [] })
    expect(employeeInstructions(quinn, 'Acme')).toBe(jobPrompt('qa-engineer'))
    const added = { ...quinn, instructions: `${quinn.instructions}\n\nTest the checkout first.` }
    expect(employeeInstructions(added, 'Acme')).toBe(`${jobPrompt('qa-engineer')}\n\n${additionsHeading('Acme')}\n\nTest the checkout first.`)
    expect(additionsHeading('Acme')).toMatch(/^### What Acme adds\n\nThis is Acme’s own, approved by a person. Where it differs from the job’s text above, it wins./)
    // An employee of the organization's own is told its own prompt, without the note at its top; a comment elsewhere stays.
    expect(employeeInstructions({ instructions: `${ownPromptNote('Writer', 'e-ab12')}\n### Role\nYou write.` }, 'Acme')).toBe('### Role\nYou write.')
    expect(employeeInstructions({ instructions: '<!-- draft -->\n### Role\nYou write.' }, 'Acme')).toBe('<!-- draft -->\n### Role\nYou write.')
    expect(employeeInstructions({ instructions: '### Role\nKeep <!-- this --> as it is.' }, 'Acme')).toBe('### Role\nKeep <!-- this --> as it is.')
  })

  it('leave what a run may do to Foreman: no job’s prompt speaks for one access, agent or shell', () => {
    for (const id of JOB_PROMPT_IDS) {
      const text = jobPrompt(id)
      // Foreman's runAccessText says, for each run, how edits are made, whether there is a shell and what counts as evidence.
      expect(text).not.toMatch(/refuses every command|run the checks that cover|file tools|Never run tests|you have no shell|this run is read-only/i)
      // The prompt is for every agent: no one agent's own tool names, and no slot spliced in with doubled punctuation.
      expect(text).not.toMatch(/\b(Glob|Bash|apply_patch|plan mode)\b/)
      expect(text).not.toMatch(/\.\.(?!\.)|\. \.|,\.| \./)
    }
    for (const t of EMPLOYEE_TEMPLATES) for (const r of t.responsibilities) expect(r).not.toMatch(/run the checks that cover|checks (you|it) ran|how you checked/i)
  })
})
