// AI employees (docs/ai-employees.md §5): the definition's shared rules (TOML in and out, strict checking, the safe
// defaults, ids, free hat colours and the fingerprint's text), the lifecycle records, Generate's prompt and its strict
// answer check, and the service against real git repositories through the memory service: Create as one commit with
// the definition and the memory folder, listing invalid files with their problems, Edit with compare-and-set, approval
// and "changed since approval", pause, resume and retire, Generate and Refine with a fake model, and the refusals.
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultEmployee,
  EMPLOYEE_ACTIONS,
  employeeFingerprintText,
  employeeDraftPrompt,
  employeeProblems,
  employeeRefinePrompt,
  employeeStatus,
  freeHatColour,
  HAT_COLOURS,
  newEmployeeId,
  normalizeEmployee,
  parseEmployee,
  parseEmployeeDraftAnswer,
  parseEmployeeRecords,
  saveAsIsText,
  serializeEmployee,
  shuffledHatColour,
  type EmployeeDefinition
} from '../src/shared/employees'
import type { Organization } from '../src/shared/organizations'
import type { Repo } from '../src/shared/types'
import { hardHatColours } from '../src/renderer/src/ui/HardHat'
import { ForemanDb } from '../src/main/db'
import { gitOut } from '../src/main/git'
import { employeeFingerprint, EmployeeService, PRIVACY_MODE_ON } from '../src/main/employees'
import { MemoryService } from '../src/main/memory'
import { createMemoryRepository } from '../src/main/organizations'
import { defaultSettings, type PersistedState } from '../src/main/store'
import { tempDir } from './helpers'

const INSTRUCTIONS = ['## Role', 'You write launch posts.', '', '## What you do', 'Read what merged.', '', '## How you write', 'Short.', '', '## What you never do', 'Publish.', '', '## How you finish', 'A summary and a reason.'].join('\n')

function max(overrides: Partial<EmployeeDefinition> = {}): EmployeeDefinition {
  return {
    ...defaultEmployee({
      id: 'e-7k2m',
      colour: 'orange',
      repos: ['foreman', 'foreman-website'],
      loadouts: [],
      text: { name: 'Max', role: 'Marketing', description: 'Launch posts and release notes.', personality: 'Casual, data-driven.', responsibilities: ['Write launch posts', 'Draft the changelog email'], ask_me_about: 'Release notes', instructions: INSTRUCTIONS }
    }),
    ...overrides
  }
}

describe('employees: the definition', () => {
  it('offers the same twelve hat colours, in the same order, as ui/HardHat draws', () => {
    expect([...HAT_COLOURS]).toEqual([...hardHatColours])
  })

  it('starts a new employee at the safest settings, on the person’s default agent and model', () => {
    const d = defaultEmployee({ id: 'e-abcd', colour: 'teal', repos: ['site', 'api'], loadouts: [{ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }] })
    expect(d.access).toEqual({
      repos: { site: 'read', api: 'read' },
      memory_write: [],
      profile: 'no-shell',
      mcp: [],
      delegate_to: [],
      actions: Object.fromEntries(EMPLOYEE_ACTIONS.map((a) => [a, 'held']))
    })
    expect(Object.values(d.access.actions).every((p) => p === 'held')).toBe(true)
    expect(d.attendance).toBe('unattended')
    expect(d.model).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', fallbacks: [] })
    expect(d.limits).toEqual({ runs_per_day: 6, minutes_per_run: 30 })
    expect(d.look).toEqual({ family: 'hardhat', colour: 'teal' })
  })

  it('makes an employee on an agent that can’t run unattended attended (Codex is offered attended only)', () => {
    const d = defaultEmployee({ id: 'e-abcd', colour: 'teal', repos: [], loadouts: [{ agent: 'codex', model: 'gpt-6.1-sol' }] })
    expect(d.attendance).toBe('attended')
    expect(d.model.agent).toBe('codex')
    expect(employeeProblems({ ...d, name: 'Ada' })).toEqual([])
    expect(employeeProblems({ ...d, name: 'Ada', attendance: 'unattended' })).toEqual(['codex can’t run unattended: make the employee attended.'])
  })

  it('writes the file as §5.1 lays it out and reads it back the same', () => {
    const toml = serializeEmployee(max({ access: { ...max().access, memory_write: ['org/docs'], repos: { 'foreman-website': 'write', foreman: 'read' } }, limits: { runs_per_day: 6, minutes_per_run: 30, cost_per_day_usd: 5 } }))
    expect(toml).toContain('id = "e-7k2m"\nname = "Max"\nrole = "Marketing"')
    expect(toml).toContain('look = { family = "hardhat", colour = "orange" }')
    expect(toml).toContain('responsibilities = [\n  "Write launch posts",\n  "Draft the changelog email",\n]')
    expect(toml).toContain('instructions = """\n## Role\n')
    expect(toml).toContain('model = { agent = "claude", model = "claude-opus-5-5[1m]", fallbacks = [] }')
    expect(toml).toContain('\n[access]\nrepos = { "foreman" = "read", "foreman-website" = "write" }\nmemory_write = ["org/docs"]\nprofile = "no-shell"')
    expect(toml).toContain('\n[limits]\nruns_per_day = 6\nminutes_per_run = 30\ncost_per_day_usd = 5\n')
    const back = parseEmployee(toml)
    expect(back.problems).toEqual([])
    expect(back.definition).toEqual(normalizeEmployee(parseEmployee(toml).definition!))
    expect(serializeEmployee(back.definition!)).toBe(toml)
  })

  it('keeps any prompt exactly through the file: quotes, backslashes, control characters and line ends', () => {
    for (const instructions of ['He said """hi""" then ""', 'ends with a quote"', 'ends with two ""', 'five """"" quotes', 'C:\\path\\ and a trailing \\', 'tab\there\u0001bell\u007f', 'line\nline\n\nline', '中文 and 😀 emoji']) {
      const back = parseEmployee(serializeEmployee(max({ instructions })))
      expect(back.problems, instructions).toEqual([])
      expect(back.definition!.instructions).toBe(instructions)
    }
    expect(parseEmployee(serializeEmployee(max({ instructions: 'a\r\nb\rc' }))).definition!.instructions).toBe('a\nb\nc')
    expect(parseEmployee(serializeEmployee(max({ name: 'Max "the" \\ Writer', description: 'one\nline' })))).toMatchObject({ definition: { name: 'Max "the" \\ Writer', description: 'one line' } })
  })

  it('says what is wrong with a file, and gives no definition while anything is', () => {
    expect(parseEmployee('name = ').problems[0]).toMatch(/^This isn’t valid TOML: /)
    const base = serializeEmployee(max())
    const problems = (toml: string) => parseEmployee(toml).problems
    // Triggers are a known field, checked like the rest: a cron trigger needs its expression and time zone.
    expect(problems(`${base}\n[[triggers]]\nkind = "cron"\n`)).toEqual(['triggers[1].cron is missing.', 'triggers[1].timezone is missing.'])
    expect(problems(`${base}\n[[triggers]]\nkind = "cron"\ncron = "0 9 * * 1"\ntimezone = "UTC"\nwhen = "now"\n`)).toEqual(['Unknown field triggers[1].when.'])
    expect(problems(base.replace('role = "Marketing"', 'role = 3'))).toEqual(['role must be text.'])
    expect(problems(base.replace('name = "Max"\n', ''))).toEqual(['name is missing.'])
    expect(problems(base.replace('id = "e-7k2m"', 'id = "Max!"'))).toEqual(['id must be lower-case letters, digits and dashes, like e-7k2m.'])
    expect(problems(base.replace('profile = "no-shell"', 'profile = "root"'))).toEqual(['access.profile must be one of: no-shell, shell.'])
    expect(problems(base.replace('"foreman" = "read"', '"foreman" = "admin"'))).toEqual(['access.repos."foreman" must be one of: none, read, write.'])
    expect(problems(base.replace('memory_write = []', 'memory_write = ["org/PROJECT.md"]'))).toEqual(['access.memory_write must be one of: org/docs, org/data.'])
    expect(problems(base.replace('delegate_to = []', 'delegate_to = ["e-7k2m"]'))).toEqual(['access.delegate_to can’t name the employee itself.'])
    expect(problems(base.replace('"slack-post" = "held"', '"slack-post" = "maybe"'))).toEqual(['access.actions."slack-post" must be one of: held, allowed, never.'])
    expect(problems(base.replace('runs_per_day = 6', 'runs_per_day = 0'))).toEqual(['limits.runs_per_day must be a whole number from 1 to 100.'])
    expect(problems(base.replace('minutes_per_run = 30', 'minutes_per_run = 2.5'))).toEqual(['limits.minutes_per_run must be a whole number from 1 to 240.'])
    expect(problems(base.replace('agent = "claude"', 'agent = "aider"'))).toEqual(['aider isn’t an agent an employee can run on.'])
    expect(problems(base.replace('look = { family = "hardhat", colour = "orange" }', 'look = { family = "robot", colour = "orange" }'))).toEqual(['look.family must be one of: hardhat.'])
    // A colour a newer Foreman knows is read; it is drawn as the quietest hat.
    expect(problems(base.replace('colour = "orange"', 'colour = "magenta"'))).toEqual([])
  })

  it('takes the fingerprint’s text over the normalized file without the hat', () => {
    const a = max()
    const shuffled: EmployeeDefinition = { ...a, access: { ...a.access, repos: { 'foreman-website': 'read', foreman: 'read' }, mcp: ['b', 'a', 'a'] }, instructions: a.instructions.replace(/\n/g, '\r\n') }
    expect(employeeFingerprintText({ ...a, access: { ...a.access, mcp: ['a', 'b'] } })).toBe(employeeFingerprintText(shuffled))
    expect(employeeFingerprintText(a)).not.toContain('look')
    expect(employeeFingerprint({ ...a, look: { family: 'hardhat', colour: 'pink' } })).toBe(employeeFingerprint(a))
    expect(employeeFingerprint({ ...a, access: { ...a.access, repos: { ...a.access.repos, foreman: 'write' } } })).not.toBe(employeeFingerprint(a))
    expect(employeeFingerprint({ ...a, model: { ...a.model, model: 'claude-haiku-5-5' } })).not.toBe(employeeFingerprint(a))
    expect(employeeFingerprint(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('picks the first colour nobody wears; a thirteenth repeats the least worn', () => {
    expect(freeHatColour([])).toBe('orange')
    expect(freeHatColour(['orange', 'pink'])).toBe('teal')
    expect(freeHatColour([...HAT_COLOURS])).toBe('orange')
    expect(freeHatColour([...HAT_COLOURS, 'orange'])).toBe('pink')
    expect(shuffledHatColour(['orange'], 'teal', () => 0)).toBe('pink')
    expect(HAT_COLOURS.filter((c) => c !== 'orange')).toContain(shuffledHatColour(['orange'], undefined, () => 0.99))
  })

  it('makes stable ids that are never one already taken', () => {
    expect(newEmployeeId([])).toMatch(/^e-[a-z0-9]{4}$/)
    let calls = 0
    // The first four characters come out as e-aaaa, which is taken: the next try differs.
    const random = () => (calls++ < 4 ? 0 : 0.5)
    const id = newEmployeeId(['e-aaaa'], random)
    expect(id).not.toBe('e-aaaa')
    expect(id).toMatch(/^e-[a-z0-9]{4}$/)
    // When every four-character id is taken (always the same draw), it grows a character.
    expect(newEmployeeId(['e-aaaa'], () => 0)).toBe('e-aaaaa')
  })

  it('reads the records in state.json entry by entry', () => {
    const fp = 'a'.repeat(64)
    expect(
      parseEmployeeRecords([
        { orgId: 'o1', id: 'e-1abc', state: 'active', approvedFingerprint: fp, approvedBlob: 'b'.repeat(40), approvedAt: '2026-11-13T10:00:00Z' },
        { orgId: 'o1', id: 'e-1abc', state: 'paused' },
        { orgId: 'o1', id: 'e-2abc', state: 'active' },
        { orgId: 'o1', id: 'Bad Id', state: 'draft' },
        { orgId: 'o1', id: 'e-3abc', state: 'sleeping' },
        { orgId: 'o1', id: 'e-4abc', state: 'paused', pausedKind: 'person', approvedFingerprint: fp },
        null
      ])
    ).toEqual([
      { orgId: 'o1', id: 'e-1abc', state: 'active', approvedFingerprint: fp, approvedBlob: 'b'.repeat(40), approvedAt: '2026-11-13T10:00:00Z' },
      { orgId: 'o1', id: 'e-2abc', state: 'draft' },
      { orgId: 'o1', id: 'e-4abc', state: 'paused', pausedKind: 'person', approvedFingerprint: fp }
    ])
    expect(parseEmployeeRecords('nope')).toEqual([])
  })

  it('shows one state word: a problem, retired, changed, paused, draft or idle', () => {
    const e = { problems: [] as string[], state: 'active' as const, changed: false }
    expect(employeeStatus(e)).toBe('idle')
    expect(employeeStatus({ ...e, changed: true })).toBe('changed')
    expect(employeeStatus({ ...e, state: 'paused' })).toBe('paused')
    expect(employeeStatus({ ...e, state: 'draft' })).toBe('draft')
    expect(employeeStatus({ ...e, state: 'retired', changed: true })).toBe('retired')
    expect(employeeStatus({ ...e, problems: ['x'] })).toBe('invalid')
  })

  it('Save as is keeps the person’s words as the instructions and leaves the name to them', () => {
    expect(saveAsIsText('  Writes release notes.\nAnd the changelog.  ', 'Casual')).toEqual({ name: '', role: '', description: 'Writes release notes. And the changelog.', personality: 'Casual', responsibilities: [], ask_me_about: '', instructions: 'Writes release notes.\nAnd the changelog.' })
  })
})

const GOOD_ANSWER = {
  name: 'Max',
  role: 'Marketing',
  description: 'Launch posts and release notes from what ships.',
  personality: 'Casual, data-driven: short sentences.',
  responsibilities: ['Write launch posts', 'Draft the changelog email'],
  ask_me_about: 'Release notes',
  instructions: INSTRUCTIONS,
  colour: 'teal',
  suggested: [
    { kind: 'repo-write', detail: 'foreman-website', reason: 'It edits the changelog page.' },
    { kind: 'repo-write', detail: 'somebody-else', reason: 'Not ours.' },
    { kind: 'schedule', detail: 'Mondays at 9', reason: 'A weekly update.' },
    { kind: 'root', detail: 'everything', reason: 'No.' }
  ],
  access: { repos: { foreman: 'write' }, profile: 'shell' },
  actions: { publish: 'allowed' },
  delegate_to: ['e-0000'],
  mcp: ['github']
}

describe('employees: Generate’s request and its answer', () => {
  it('asks for the five sections and sends the description, personality, repositories and free colours', () => {
    const prompt = employeeDraftPrompt({ organization: 'Foreman', description: 'A marketing person.', traits: ['casual', 'data-driven'], otherTrait: 'warm', repos: ['foreman', 'foreman-website'], freeColours: ['teal', 'blue'] })
    expect(prompt).toContain('A marketing person.')
    expect(prompt).toContain('Personality the person picked: casual, data driven, warm.')
    expect(prompt).toContain('The organization’s repositories: foreman, foreman-website.')
    expect(prompt).toContain('Hat colours nobody in the organization wears yet: teal, blue.')
    expect(prompt).toContain('Role, What you do, How you write, What you never do, How you finish')
    expect(prompt).toMatch(/never yours/)
    expect(employeeDraftPrompt({ organization: 'Foreman', description: 'x', traits: [], repos: [], freeColours: [] })).toContain('The person picked no personality')
    const refine = employeeRefinePrompt({ organization: 'Foreman', draft: { ...GOOD_ANSWER, responsibilities: GOOD_ANSWER.responsibilities }, request: 'Also the newsletter', repos: ['foreman'] })
    expect(refine).toContain('Also the newsletter')
    expect(refine).toContain('"name": "Max"')
    expect(refine).toContain('Change only what the request asks')
  })

  it('reads only the words from a good answer: never access, actions, profile, MCP servers or delegation', () => {
    const answer = parseEmployeeDraftAnswer(JSON.stringify(GOOD_ANSWER), { repos: ['foreman', 'foreman-website'], freeColours: ['teal', 'blue'] })
    expect(answer).toEqual({
      ok: true,
      text: { name: 'Max', role: 'Marketing', description: GOOD_ANSWER.description, personality: GOOD_ANSWER.personality, responsibilities: GOOD_ANSWER.responsibilities, ask_me_about: 'Release notes', instructions: INSTRUCTIONS },
      colour: 'teal',
      suggested: [
        { kind: 'repo-write', detail: 'foreman-website', reason: 'It edits the changelog page.' },
        { kind: 'schedule', detail: 'Mondays at 9', reason: 'A weekly update.' }
      ]
    })
    expect(JSON.stringify(answer)).not.toMatch(/shell|publish|github|e-0000/)
  })

  it('tolerates a code fence around the object, drops a colour someone wears, and refuses anything else', () => {
    const context = { repos: ['foreman'], freeColours: ['blue'] }
    const fenced = parseEmployeeDraftAnswer(`\`\`\`json\n${JSON.stringify(GOOD_ANSWER)}\n\`\`\``, context)
    expect(fenced.ok).toBe(true)
    expect(fenced.ok && fenced.colour).toBe(undefined)
    expect(parseEmployeeDraftAnswer(`Here you go: ${JSON.stringify(GOOD_ANSWER)}`, context)).toEqual({ ok: false, problem: 'The answer wasn’t a JSON object.' })
    expect(parseEmployeeDraftAnswer('[]', context)).toEqual({ ok: false, problem: 'The answer wasn’t a JSON object.' })
    expect(parseEmployeeDraftAnswer(JSON.stringify({ ...GOOD_ANSWER, name: '' }), context)).toEqual({ ok: false, problem: 'The answer has no name.' })
    expect(parseEmployeeDraftAnswer(JSON.stringify({ ...GOOD_ANSWER, responsibilities: 'all of it' }), context)).toEqual({ ok: false, problem: 'The answer’s responsibilities aren’t a list of text.' })
    expect(parseEmployeeDraftAnswer(JSON.stringify({ ...GOOD_ANSWER, instructions: INSTRUCTIONS.replace('## How you finish', '## Finally') }), context)).toEqual({ ok: false, problem: 'The instructions are missing “How you finish”.' })
    expect(parseEmployeeDraftAnswer(JSON.stringify({ ...GOOD_ANSWER, role: 'r'.repeat(61) }), context)).toEqual({ ok: false, problem: 'The answer’s role is longer than 60 characters.' })
  })
})

// ---- the service, against a real memory repository ----

const opened: ForemanDb[] = []
afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close()
    } catch {
      // Already closed.
    }
  }
})

async function rig(options: { answer?: string } = {}) {
  const parent = await tempDir('foreman-employees-')
  const root = await createMemoryRepository(parent, 'acme-memory', 'Acme')
  const db = new ForemanDb(path.join(await tempDir('foreman-employees-db-'), 'foreman.db'))
  opened.push(db)
  const memoryRepo = { id: 'mem', name: 'acme-memory', rootPath: root, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: '2026-11-01T00:00:00.000Z', spaceId: 'o1' } as unknown as Repo
  const site = { id: 'site', name: 'foreman-website', rootPath: path.join(parent, 'site'), defaultBranch: 'main', local: {}, createdAt: '2026-11-01T00:00:00.000Z', spaceId: 'o1' } as unknown as Repo
  const blog = { id: 'blog', name: 'blog', rootPath: path.join(parent, 'blog'), defaultBranch: 'main', local: {}, createdAt: '2026-11-01T00:00:00.000Z' } as unknown as Repo
  const org: Organization = { id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: '2026-11-05T00:00:00.000Z' }
  const bare: Organization = { id: 'o2', name: 'Later', createdAt: '2026-11-05T00:00:00.000Z' }
  const state = { repos: [memoryRepo, site, blog], organizations: [org, bare], settings: defaultSettings() } as unknown as PersistedState
  const memory = new MemoryService({ state: () => state, db: () => db, sensitivePaths: () => [], changed: () => undefined })
  const counts = { changed: 0 }
  const draft = vi.fn(async (_request: { system: string; prompt: string }) => ({ text: options.answer ?? JSON.stringify(GOOD_ANSWER), agent: 'claude', model: 'claude-sonnet-5-5' }))
  const employees = new EmployeeService({ state: () => state, memory, changed: () => void counts.changed++, draft, now: () => new Date('2026-11-13T10:42:00.000Z') })
  return { root, state, memory, employees, draft, counts }
}

const definitionFor = (overrides: Partial<EmployeeDefinition> = {}) => max({ access: { ...max().access, repos: { 'foreman-website': 'read' } }, ...overrides })

describe('employees: the service', () => {
  it('creates an employee as one commit by the person: its definition, MEMORY.md and journal.md, as a draft', async () => {
    const { root, employees, state } = await rig()
    const before = await gitOut(root, ['rev-parse', 'HEAD'])
    const created = await employees.create('o1', definitionFor())
    expect(created).toMatchObject({ id: 'e-7k2m', path: 'bots/e-7k2m.toml', name: 'Max', state: 'draft', changed: false, problems: [] })
    expect(await gitOut(root, ['rev-list', '--count', `${before}..HEAD`])).toBe('1')
    expect((await gitOut(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()).toEqual(['bots/e-7k2m.toml', 'memory/bots/e-7k2m/MEMORY.md', 'memory/bots/e-7k2m/journal.md'])
    const message = await gitOut(root, ['log', '-1', '--format=%B'])
    expect(message).toContain('Add AI employee Max (bots/e-7k2m.toml)')
    expect(message).toContain('Foreman-Edited-By: person')
    expect(await gitOut(root, ['show', 'HEAD:bots/e-7k2m.toml'])).toBe(serializeEmployee(definitionFor()).trimEnd())
    expect(await gitOut(root, ['show', 'HEAD:memory/bots/e-7k2m/journal.md'])).toMatch(/^# Journal/)
    expect(state.employees).toEqual([{ orgId: 'o1', id: 'e-7k2m', state: 'draft' }])
    const list = await employees.list('o1')
    expect(list.employees.map((e) => [e.id, e.state, e.definition?.name])).toEqual([['e-7k2m', 'draft', 'Max']])
    expect(employees.rosters().o1.employees[0]).toMatchObject({ id: 'e-7k2m', name: 'Max', colour: 'orange', state: 'draft', agent: 'claude' })
  })

  it('creates and approves at once, recording the fingerprint here', async () => {
    const { employees, state } = await rig()
    const created = await employees.create('o1', definitionFor(), { approve: true })
    expect(created).toMatchObject({ state: 'active', changed: false, approvedAt: '2026-11-13T10:42:00.000Z' })
    expect(state.employees![0].approvedFingerprint).toBe(employeeFingerprint(definitionFor()))
    expect(state.employees![0].approvedBlob).toBe(created.blob)
  })

  it('never reuses an id, and refuses a name another employee has', async () => {
    const { employees, memory } = await rig()
    // A memory folder left behind by an employee whose definition is gone still holds its id.
    await memory.writeAsPerson('o1', 'memory/bots/e-7k2m/notes.md', 'old\n', null)
    const created = await employees.create('o1', definitionFor())
    expect(created.id).not.toBe('e-7k2m')
    expect(created.path).toBe(`bots/${created.id}.toml`)
    await expect(employees.create('o1', definitionFor({ id: 'e-other', name: ' max ' }))).rejects.toThrow('There is already an employee named max in this organization.')
    await expect(employees.create('o1', definitionFor({ id: 'e-other', name: 'Ada', access: { ...definitionFor().access, delegate_to: ['e-zzzz'] } }))).rejects.toThrow(/can only hand tasks to employees of Acme/)
    await expect(employees.create('o1', { ...definitionFor(), limits: { runs_per_day: 0, minutes_per_run: 30 } })).rejects.toThrow('The employee can’t be saved: limits.runs_per_day must be a whole number from 1 to 100.')
  })

  it('lists a file it can’t read with its problems instead of dropping it', async () => {
    const { employees, memory } = await rig()
    await employees.create('o1', definitionFor())
    await memory.writeAsPerson('o1', 'bots/e-bad1.toml', 'name = "Broken"\nrole = [\n', null)
    await memory.writeAsPerson('o1', 'bots/e-moved.toml', serializeEmployee(definitionFor({ id: 'e-else', name: 'Else' })), null)
    const list = await employees.list('o1')
    const bad = list.employees.find((e) => e.id === 'e-bad1')!
    expect(bad.definition).toBeUndefined()
    expect(bad.problems[0]).toMatch(/^This isn’t valid TOML/)
    expect(bad.name).toBe('')
    expect(list.employees.find((e) => e.id === 'e-moved')!.problems).toEqual(['bots/e-moved.toml holds the definition of e-else: a definition’s file is named after its id.'])
    await expect(employees.approve('o1', 'e-bad1')).rejects.toThrow('bots/e-bad1.toml has problems to fix before it can be approved.')
  })

  it('saves an edit only against the file as it was read', async () => {
    const { employees, root } = await rig()
    const created = await employees.create('o1', definitionFor())
    const first = await employees.update('o1', created.id, definitionFor({ role: 'Launches' }), created.blob)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.employee.role).toBe('Launches')
    expect(await gitOut(root, ['log', '-1', '--format=%s'])).toBe('Edit AI employee Max (bots/e-7k2m.toml)')
    const stale = await employees.update('o1', created.id, definitionFor({ role: 'Stale' }), created.blob)
    expect(stale).toEqual({ ok: false, conflict: { blob: first.employee.blob, text: expect.stringContaining('role = "Launches"') } })
    await expect(employees.update('o1', created.id, definitionFor({ id: 'e-zzzz' }), first.employee.blob)).rejects.toThrow('An employee’s id never changes.')
  })

  it('flags an approved employee whose definition changed, shows what changed, and clears it when approved again', async () => {
    const { employees } = await rig()
    const created = await employees.create('o1', definitionFor(), { approve: true })
    // A new hat is who it is, not what it may do: no new approval needed.
    const hat = await employees.update('o1', created.id, definitionFor({ look: { family: 'hardhat', colour: 'pink' } }), created.blob)
    expect(hat.ok && hat.employee.changed).toBe(false)
    if (!hat.ok) return
    const wider = definitionFor({ look: { family: 'hardhat', colour: 'pink' }, access: { ...definitionFor().access, repos: { 'foreman-website': 'write' } } })
    const edited = await employees.update('o1', created.id, wider, hat.employee.blob)
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.employee).toMatchObject({ state: 'active', changed: true })
    expect(edited.employee.approvedText).toContain('repos = { "foreman-website" = "read" }')
    expect(edited.employee.text).toContain('repos = { "foreman-website" = "write" }')
    expect(employees.rosters().o1.employees[0].changed).toBe(true)
    await expect(employees.approve('o1', created.id, created.fingerprint)).rejects.toThrow('Max’s definition changed while you were reading the plan. Look at it again.')
    const approved = await employees.approve('o1', created.id, edited.employee.fingerprint)
    expect(approved).toMatchObject({ state: 'active', changed: false })
    expect(approved.approvedText).toBeUndefined()
  })

  it('pauses an employee after two runs in a row that didn’t finish, saying how the last ended; a finished run resets the count, and Resume starts it over', async () => {
    const { employees, state } = await rig()
    const created = await employees.create('o1', definitionFor(), { approve: true })
    const record = () => state.employees!.find((r) => r.id === created.id)!
    employees.runEnded('o1', created.id, { failed: true, detail: 'The model is overloaded.' })
    expect(record()).toMatchObject({ state: 'active', failures: 1 })
    // One that finished in between: the count starts over.
    employees.runEnded('o1', created.id, { failed: false })
    expect(record().failures).toBeUndefined()
    employees.runEnded('o1', created.id, { failed: true, detail: 'The model is overloaded.' })
    employees.runEnded('o1', created.id, { failed: true, detail: 'Stopped after the maximum of 30 minutes.' })
    expect(record()).toMatchObject({ state: 'paused', pausedKind: 'failures', pausedDetail: 'Stopped after the maximum of 30 minutes.', failures: 2 })
    expect(employees.rosters().o1.employees[0]).toMatchObject({ state: 'paused', pausedKind: 'failures', pausedDetail: 'Stopped after the maximum of 30 minutes.' })
    // It reads back from state.json as it was written.
    expect(parseEmployeeRecords(JSON.parse(JSON.stringify(state.employees)))[0]).toMatchObject({ state: 'paused', pausedKind: 'failures', failures: 2 })
    await employees.resume('o1', created.id)
    expect(record()).toEqual(expect.objectContaining({ state: 'active' }))
    expect(record().failures).toBeUndefined()
    expect(record().pausedDetail).toBeUndefined()
    // One a person paused stays paused by the person, whatever fails meanwhile.
    employees.runEnded('o1', created.id, { failed: true })
    await employees.pause('o1', created.id)
    employees.runEnded('o1', created.id, { failed: true })
    expect(record()).toMatchObject({ state: 'paused', pausedKind: 'person' })
  })

  it('pauses and resumes an approved employee; retires any, which then stays as it is', async () => {
    const { employees, state, counts } = await rig()
    const draft = await employees.create('o1', definitionFor())
    await expect(employees.pause('o1', draft.id)).rejects.toThrow('Approve this employee first: a draft doesn’t run, so there is nothing to pause.')
    await employees.approve('o1', draft.id)
    const before = counts.changed
    await employees.pause('o1', draft.id)
    expect(state.employees![0]).toMatchObject({ state: 'paused', pausedKind: 'person' })
    expect(counts.changed).toBeGreaterThan(before)
    // Approving a paused employee again keeps it paused.
    await employees.approve('o1', draft.id)
    expect(state.employees![0].state).toBe('paused')
    await employees.resume('o1', draft.id)
    expect(state.employees![0]).toEqual(expect.objectContaining({ state: 'active' }))
    expect(state.employees![0].pausedKind).toBeUndefined()
    await employees.retire('o1', draft.id)
    expect(state.employees![0].state).toBe('retired')
    await expect(employees.resume('o1', draft.id)).rejects.toThrow('This employee is retired.')
    await expect(employees.approve('o1', draft.id)).rejects.toThrow('Max is retired.')
    const list = await employees.list('o1')
    await expect(employees.update('o1', draft.id, definitionFor({ role: 'Back' }), list.employees[0].blob)).rejects.toThrow('Max is retired.')
    // Its files stay.
    expect(list.employees[0]).toMatchObject({ id: draft.id, state: 'retired' })
    await expect(employees.pause('o1', 'e-none')).rejects.toThrow('Employee not found')
  })

  it('refuses everything for an organization without a memory repository', async () => {
    const { employees, draft } = await rig()
    await expect(employees.list('o2')).rejects.toThrow('Later has no memory repository. Choose one in Settings → Spaces.')
    await expect(employees.generate('o2', { description: 'x', traits: [] })).rejects.toThrow('Later has no memory repository')
    expect(draft).not.toHaveBeenCalled()
  })

  it('Generate sends one request with the organization’s repositories and returns words, a free colour and suggestions only', async () => {
    const { employees, draft } = await rig()
    await employees.create('o1', definitionFor({ look: { family: 'hardhat', colour: 'orange' } }))
    const result = await employees.generate('o1', { description: 'A marketing person.', traits: ['casual'] })
    expect(draft).toHaveBeenCalledTimes(1)
    const request = draft.mock.calls[0][0]
    expect(request.system).toMatch(/no tools/)
    // Its own space's code repositories, not its memory repository and not Personal's.
    expect(request.prompt).toContain('The organization’s repositories: foreman-website.')
    expect(request.prompt).not.toContain('acme-memory')
    expect(request.prompt).not.toContain('blog')
    expect(request.prompt).toContain('Hat colours nobody in the organization wears yet: pink, teal')
    expect(result).toEqual({
      text: expect.objectContaining({ name: 'Max', instructions: INSTRUCTIONS }),
      colour: 'teal',
      suggested: [
        { kind: 'repo-write', detail: 'foreman-website', reason: 'It edits the changelog page.' },
        { kind: 'schedule', detail: 'Mondays at 9', reason: 'A weekly update.' }
      ],
      agent: 'claude',
      model: 'claude-sonnet-5-5'
    })
    expect(Object.keys(result).sort()).toEqual(['agent', 'colour', 'model', 'suggested', 'text'])
    // A hat the person picked is theirs: no colour comes back.
    expect((await employees.generate('o1', { description: 'x', traits: [], colour: 'red' })).colour).toBeUndefined()
  })

  it('Refine sends the draft and the change; the hat and every setting stay out of it', async () => {
    const { employees, draft } = await rig()
    const result = await employees.refine('o1', { name: 'Max', role: 'Marketing', description: 'd', personality: 'p', responsibilities: ['a'], ask_me_about: 'x', instructions: 'i' }, 'Also the newsletter')
    expect(draft.mock.calls[0][0].prompt).toContain('Also the newsletter')
    expect(result.colour).toBeUndefined()
    await expect(employees.refine('o1', { name: 1 } as never, 'x')).rejects.toThrow('Invalid draft')
    await expect(employees.refine('o1', { name: 'Max', role: '', description: '', personality: '', responsibilities: [], ask_me_about: '', instructions: '' }, '  ')).rejects.toThrow('Say what to change.')
  })

  it('says plainly when the answer isn’t a draft, and under Privacy mode sends nothing at all', async () => {
    const bad = await rig({ answer: 'Sure! Max is a marketer.' })
    await expect(bad.employees.generate('o1', { description: 'x', traits: [] })).rejects.toThrow('The draft didn’t come back as expected: The answer wasn’t a JSON object. Try again, or use Save as is.')
    const { employees, state, draft } = await rig()
    state.settings.privacyMode = true
    await expect(employees.generate('o1', { description: 'x', traits: [] })).rejects.toThrow(PRIVACY_MODE_ON)
    await expect(employees.refine('o1', { name: 'Max', role: '', description: '', personality: '', responsibilities: [], ask_me_about: '', instructions: '' }, 'more')).rejects.toThrow(PRIVACY_MODE_ON)
    expect(draft).not.toHaveBeenCalled()
  })
})
