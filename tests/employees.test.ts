// AI employees (docs/ai-employees.md §5): the definition's shared rules (TOML in and out, strict checking, the safe
// defaults, ids, free hat colours and the fingerprint's text), the lifecycle records, Generate's prompt and its strict
// answer check, and the service against real git repositories through the memory service: Create as one commit with
// the definition and the memory folder, listing invalid files with their problems, Edit with compare-and-set, approval
// and "changed since approval", pause, resume and retire, Generate and Refine with a fake model, and the refusals.
import path from 'node:path'
import earlierQaPromptFile from './fixtures/earlier-qa-engineer-prompt.md?raw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultEmployee,
  EMPLOYEE_ACTIONS,
  employeeFingerprintText,
  employeeDraftPrompt,
  employeePath,
  employeePromptFile,
  employeePromptPath,
  employeeProblems,
  employeeRefinePrompt,
  employeeStatus,
  freeHatColour,
  HAT_COLOURS,
  newEmployee,
  newEmployeeId,
  normalizeEmployee,
  parseEmployee,
  parseEmployeeDraftAnswer,
  parseEmployeeRecords,
  saveAsIsText,
  serializeEmployee,
  shuffledHatColour,
  withFullAccess,
  type EmployeeDefinition
} from '../src/shared/employees'
import type { Organization } from '../src/shared/organizations'
import type { Repo } from '../src/shared/types'
import { hardHatColours } from '../src/renderer/src/ui/HardHat'
import { ForemanDb } from '../src/main/db'
import { gitOut } from '../src/main/git'
import { employeeFingerprint, EmployeeService, FULL_ACCESS_MIGRATION, JOB_PROMPTS_MIGRATION, PRIVACY_MODE_ON } from '../src/main/employees'
import { MemoryService } from '../src/main/memory'
import { createMemoryRepository, OrganizationService } from '../src/main/organizations'
import { defaultSettings, type PersistedState } from '../src/main/store'
import { tempDir } from './helpers'
import { programManagerDefinition, proposedDefinition } from '../src/shared/employeeTeams'
import { ownPromptNote } from '../src/shared/employeePrompts'

// As an earlier Foreman wrote it, with LF: a Windows checkout gives the fixture CRLF.
const earlierQaPrompt = earlierQaPromptFile.replace(/\r\n/g, '\n')
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

  it('starts a new employee with a shell, reading its repositories, on the person’s default agent and model', () => {
    const d = defaultEmployee({ id: 'e-abcd', colour: 'teal', repos: ['site', 'api'], loadouts: [{ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }] })
    expect(d.access).toEqual({
      repos: { site: 'read', api: 'read' },
      memory_write: [],
      profile: 'shell',
      delegate_to: [],
      actions: Object.fromEntries(EMPLOYEE_ACTIONS.map((a) => [a, 'held']))
    })
    expect(Object.values(d.access.actions).every((p) => p === 'held')).toBe(true)
    expect(d.attendance).toBe('unattended')
    expect(d.model).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', fallbacks: [] })
    expect(d).not.toHaveProperty('limits')
    expect(d.look).toEqual({ family: 'hardhat', colour: 'teal' })
  })

  it('gives a new employee Write where it reads, a shell, pushes and pull requests without a hold, and no limits', () => {
    const input = { id: 'e-abcd', colour: 'teal', repos: ['site', 'api'], loadouts: [{ agent: 'claude' as const, model: 'claude-sonnet-5-5' }], text: { name: 'Ada' } }
    const d = newEmployee(input)
    expect(d.access.repos).toEqual({ site: 'write', api: 'write' })
    expect(d.access.actions).toEqual({ 'slack-post': 'held', linear: 'held', push: 'allowed', 'pull-request': 'allowed' })
    expect(d.access.profile).toBe('shell')
    // No MCP list and no limits in the file: every run has every MCP server, and no employee has limits.
    expect(serializeEmployee(d)).not.toMatch(/^mcp = |\[limits\]/m)
    expect(parseEmployee(serializeEmployee(d)).definition).toEqual(normalizeEmployee(d))
    // Attended runs read-only, so an attended employee keeps Read; a repository given no access stays so.
    expect(newEmployee({ ...input, loadouts: [{ agent: 'codex', model: 'gpt-6.1-sol' }] }).access.repos).toEqual({ site: 'read', api: 'read' })
    const limited = { ...defaultEmployee(input), access: { ...defaultEmployee(input).access, repos: { site: 'none' as const, api: 'read' as const }, profile: 'no-shell' as const } }
    expect(withFullAccess(limited)).toMatchObject({ access: { repos: { site: 'none', api: 'write' }, profile: 'shell' } })
  })

  it('makes an employee on an agent that can’t run unattended attended (Codex is offered attended only)', () => {
    const d = defaultEmployee({ id: 'e-abcd', colour: 'teal', repos: [], loadouts: [{ agent: 'codex', model: 'gpt-6.1-sol' }] })
    expect(d.attendance).toBe('attended')
    expect(d.model.agent).toBe('codex')
    expect(employeeProblems({ ...d, name: 'Ada' })).toEqual([])
    expect(employeeProblems({ ...d, name: 'Ada', attendance: 'unattended' })).toEqual(['codex can’t run unattended: make the employee attended.'])
  })

  it('writes the file as §5.1 lays it out and reads it back the same', () => {
    const toml = serializeEmployee(max({ access: { ...max().access, memory_write: ['org/docs'], repos: { 'foreman-website': 'write', foreman: 'read' } } }))
    expect(toml).toContain('id = "e-7k2m"\nname = "Max"\nrole = "Marketing"')
    expect(toml).toContain('look = { family = "hardhat", colour = "orange" }')
    expect(toml).toContain('responsibilities = [\n  "Write launch posts",\n  "Draft the changelog email",\n]')
    // The prompt is its own file, bots/<id>.md; the fingerprint's text still has it, as one file had it before.
    expect(toml).not.toContain('instructions')
    expect(employeePromptFile(max())).toMatch(/^## Role\n[\s\S]*\n$/)
    expect(serializeEmployee(max(), { instructions: true })).toContain('instructions = """\n## Role\n')
    expect(toml).toContain('model = { agent = "claude", model = "claude-opus-5-5[1m]", fallbacks = [] }')
    expect(toml).toContain('\n[access]\nrepos = { "foreman" = "read", "foreman-website" = "write" }\nmemory_write = ["org/docs"]\nprofile = "shell"\ndelegate_to = []')
    expect(toml).not.toContain('[limits]')
    const back = parseEmployee(toml, undefined, employeePromptFile(max()))
    expect(back.problems).toEqual([])
    expect(back.definition!.instructions).toBe(INSTRUCTIONS)
    expect(serializeEmployee(back.definition!)).toBe(toml)
    // A file from before every run had every MCP server and no employee had limits still reads; both mean nothing now.
    const older = parseEmployee(toml.replace('profile = "shell"\n', 'profile = "shell"\nmcp = ["linear"]\n') + '\n[limits]\nruns_per_day = 6\nminutes_per_run = 30\n', undefined, employeePromptFile(max()))
    expect(older.problems).toEqual([])
    expect(serializeEmployee(older.definition!)).toBe(toml)
    // A file from before prompts had their own still reads, with its prompt in it.
    expect(parseEmployee(serializeEmployee(max(), { instructions: true })).definition).toEqual(normalizeEmployee(max()))
  })

  it('reads the prompt from its own file, refuses two different prompts, and records the job a template employee is given', () => {
    const d = max()
    const legacy = serializeEmployee(d, { instructions: true })
    // The same prompt in both is fine; two different ones can't say which runs.
    expect(parseEmployee(legacy, undefined, employeePromptFile(d)).problems).toEqual([])
    expect(parseEmployee(legacy, undefined, 'Something else.').problems).toEqual(['The prompt is in both this file and bots/<id>.md, and they differ. Keep it in one: take `instructions` out of this file, or make the two the same.'])
    const quinn = { ...d, template: 'qa-engineer' as const, instructions: 'Test the checkout first.' }
    const toml = serializeEmployee(quinn)
    expect(toml).toContain('ask_me_about = "Release notes"\ntemplate = "qa-engineer"\n')
    expect(parseEmployee(toml, undefined, employeePromptFile(quinn)).definition).toEqual(normalizeEmployee(quinn))
    expect(parseEmployee(toml.replace('qa-engineer', 'wizard')).problems[0]).toMatch(/^template must be one of: software-engineer, /)
    // Moving a prompt to its own file moves no fingerprint; linking a job does.
    expect(employeeFingerprintText(d)).toBe(serializeEmployee(d, { look: false, instructions: true }))
    expect(employeeFingerprintText(quinn)).not.toBe(employeeFingerprintText({ ...quinn, template: undefined }))
  })

  it('keeps any prompt exactly through the file: quotes, backslashes, control characters and line ends', () => {
    for (const instructions of ['He said """hi""" then ""', 'ends with a quote"', 'ends with two ""', 'five """"" quotes', 'C:\\path\\ and a trailing \\', 'tab\there\u0001bell\u007f', 'line\nline\n\nline', '中文 and 😀 emoji']) {
      // In its own file, and in the definition as a file before prompts had their own kept it.
      const d = max({ instructions })
      const back = parseEmployee(serializeEmployee(d), undefined, employeePromptFile(d))
      expect(back.problems, instructions).toEqual([])
      expect(back.definition!.instructions).toBe(instructions)
      expect(parseEmployee(serializeEmployee(d, { instructions: true })).definition!.instructions).toBe(instructions)
    }
    expect(parseEmployee(serializeEmployee(max()), undefined, 'a\r\nb\rc').definition!.instructions).toBe('a\nb\nc')
    expect(parseEmployee(serializeEmployee(max({ instructions: 'a\r\nb\rc' }), { instructions: true })).definition!.instructions).toBe('a\nb\nc')
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
    expect(problems(base.replace('profile = "shell"', 'profile = "root"'))).toEqual(['access.profile must be one of: no-shell, shell.'])
    expect(problems(base.replace('"foreman" = "read"', '"foreman" = "admin"'))).toEqual(['access.repos."foreman" must be one of: none, read, write.'])
    expect(problems(base.replace('memory_write = []', 'memory_write = ["org/PROJECT.md"]'))).toEqual(['access.memory_write must be one of: org/docs, org/data.'])
    expect(problems(base.replace('delegate_to = []', 'delegate_to = ["e-7k2m"]'))).toEqual(['access.delegate_to can’t name the employee itself.'])
    expect(problems(base.replace('"slack-post" = "held"', '"slack-post" = "maybe"'))).toEqual(['access.actions."slack-post" must be one of: held, allowed, never.'])
    expect(problems(`limits = 3\n${base}`)).toEqual(['limits must be a table.'])
    expect(problems(base.replace('agent = "claude"', 'agent = "aider"'))).toEqual(['aider isn’t an agent an employee can run on.'])
    expect(problems(base.replace('look = { family = "hardhat", colour = "orange" }', 'look = { family = "robot", colour = "orange" }'))).toEqual(['look.family must be one of: hardhat.'])
    // A colour a newer Foreman knows is read; it is drawn as the quietest hat.
    expect(problems(base.replace('colour = "orange"', 'colour = "magenta"'))).toEqual([])
  })

  it('takes the fingerprint’s text over the normalized file without the hat', () => {
    const a = max()
    const shuffled: EmployeeDefinition = { ...a, access: { ...a.access, repos: { 'foreman-website': 'read', foreman: 'read' }, delegate_to: ['e-b', 'e-a', 'e-a'] }, instructions: a.instructions.replace(/\n/g, '\r\n') }
    expect(employeeFingerprintText({ ...a, access: { ...a.access, delegate_to: ['e-a', 'e-b'] } })).toBe(employeeFingerprintText(shuffled))
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

  it('Use my words keeps the person’s words as the instructions and leaves the name to them', () => {
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
    expect((await gitOut(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()).toEqual(['bots/e-7k2m.md', 'bots/e-7k2m.toml', 'memory/bots/e-7k2m/MEMORY.md', 'memory/bots/e-7k2m/journal.md'])
    const message = await gitOut(root, ['log', '-1', '--format=%B'])
    expect(message).toContain('Add AI employee Max (bots/e-7k2m.toml)')
    expect(message).toContain('Foreman-Edited-By: person')
    expect(await gitOut(root, ['show', 'HEAD:bots/e-7k2m.toml'])).toBe(serializeEmployee(definitionFor()).trimEnd())
    expect(await gitOut(root, ['show', 'HEAD:bots/e-7k2m.md'])).toBe(definitionFor().instructions.trim())
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

  it('gives the employees an organization already had a shell once, in one commit, writes their files without an MCP list or limits, and moves their approvals with it', async () => {
    const { root, memory, employees, state } = await rig()
    const old = definitionFor({ access: { ...definitionFor().access, profile: 'no-shell' } })
    // As an earlier Foreman wrote it: an MCP list and limits in the file, and an approval whose fingerprint was taken
    // over them, which this build can't take again. The approval's blob says which file it was.
    const text = serializeEmployee(old).replace('profile = "no-shell"\n', 'profile = "no-shell"\nmcp = []\n') + '\n[limits]\nruns_per_day = 6\n'
    const written = await memory.commitAsPerson(
      'o1',
      [
        { kind: 'write', path: employeePath(old.id), text, expectedBlob: null },
        { kind: 'write', path: employeePromptPath(old.id), text: employeePromptFile(old), expectedBlob: null }
      ],
      { subject: 'An earlier Foreman' }
    )
    expect(written.ok).toBe(true)
    await employees.approve('o1', old.id)
    const record = state.employees!.find((r) => r.id === old.id)!
    record.approvedFingerprint = 'f'.repeat(64)
    // Upgraded from a Foreman that had already linked jobs and given Write and pushes.
    state.migrations = [`${JOB_PROMPTS_MIGRATION}:o1`, 'employees-full-access:o1']
    const before = await gitOut(root, ['rev-parse', 'HEAD'])
    await employees.refresh('o1')
    expect(await gitOut(root, ['rev-list', '--count', `${before}..HEAD`])).toBe('1')
    expect(await gitOut(root, ['log', '-1', '--format=%s'])).toBe('Give every AI employee a shell, every MCP server and no limits')
    const [view] = (await employees.list('o1')).employees
    expect(view.definition).toEqual(withFullAccess(old))
    expect(view.definition!.access).toMatchObject({ repos: { 'foreman-website': 'write' }, profile: 'shell' })
    expect(view.text).not.toContain('mcp =')
    expect(view.text).not.toContain('[limits]')
    // The person asked for exactly this change, so the approval moved with it: still approved, not changed.
    expect(view).toMatchObject({ state: 'active', changed: false })
    expect(record.approvedFingerprint).toBe(view.fingerprint)
    expect(state.migrations).toContain(`${FULL_ACCESS_MIGRATION}:o1`)
    // Once: a shell turned off afterwards stays off.
    const again = await employees.update('o1', old.id, { ...view.definition!, access: { ...view.definition!.access, profile: 'no-shell' } }, view.blob)
    expect(again.ok).toBe(true)
    await employees.refresh('o1')
    expect((await employees.list('o1')).employees[0].definition!.access.profile).toBe('no-shell')
  })

  it('moves no approval of a file other than the one approved', async () => {
    const { memory, employees, state } = await rig()
    const old = definitionFor({ access: { ...definitionFor().access, profile: 'no-shell' } })
    const created = await employees.create('o1', old, { approve: true })
    // Changed after it was approved (a wider repository), then the migration: nothing moves, it waits for a person.
    const changed = { ...old, access: { ...old.access, repos: { 'foreman-website': 'write' as const } }, responsibilities: ['Something new'] }
    const result = await memory.commitAsPerson('o1', [{ kind: 'write', path: created.path, text: serializeEmployee(changed), expectedBlob: created.blob }], { subject: 'An edit' })
    expect(result.ok).toBe(true)
    state.migrations = (state.migrations ?? []).filter((m) => !m.startsWith(FULL_ACCESS_MIGRATION))
    await employees.refresh('o1')
    expect((await employees.list('o1')).employees[0]).toMatchObject({ changed: true })
  })

  it('moves an approval when another computer made the change, and only when nothing else changed', async () => {
    const { memory, employees, state } = await rig()
    const limited = definitionFor({ access: { ...definitionFor().access, profile: 'no-shell' } })
    const kept = await employees.create('o1', limited, { approve: true })
    const edited = await employees.create('o1', { ...limited, id: 'e-ab12', name: 'Ada' }, { approve: true })
    // Another computer's commit: Max only widened, Ada widened and told something new.
    const result = await memory.commitAsPerson(
      'o1',
      [
        { kind: 'write', path: kept.path, text: serializeEmployee(withFullAccess(limited)), expectedBlob: kept.blob },
        { kind: 'write', path: edited.path, text: serializeEmployee(withFullAccess({ ...limited, id: 'e-ab12', name: 'Ada' })), expectedBlob: edited.blob },
        { kind: 'write', path: 'bots/e-ab12.md', text: 'Something else.\n', expectedBlob: edited.promptBlob }
      ],
      { subject: 'Give every AI employee a shell, every MCP server and no limits' }
    )
    expect(result.ok).toBe(true)
    await employees.refresh('o1')
    const byName = Object.fromEntries((await employees.list('o1')).employees.map((e) => [e.name, e]))
    expect(byName.Max).toMatchObject({ state: 'active', changed: false })
    expect(byName.Ada).toMatchObject({ state: 'active', changed: true })
    expect(state.migrations).toContain(`${FULL_ACCESS_MIGRATION}:o1`)
  })

  it('gives every employee its own prompt file, and links one given a job’s prompt word for word to that job, moving its approval, here and on another computer', async () => {
    const { root, memory, employees, state } = await rig()
    state.migrations = [`${FULL_ACCESS_MIGRATION}:o1`]
    // As an earlier Foreman wrote them, each prompt in its definition: Quinn's is the QA engineer's word for word,
    // Quill's was edited after, and Max's is its own.
    const quinn = definitionFor({ id: 'e-qnab', name: 'Quinn', role: 'Staff QA engineer', instructions: earlierQaPrompt })
    const quill = definitionFor({ id: 'e-qnac', name: 'Quill', role: 'Staff QA engineer', instructions: `${earlierQaPrompt.trim()}\nTest the checkout first.` })
    const max = definitionFor()
    const written = await memory.commitAsPerson('o1', [quinn, quill, max].map((d) => ({ kind: 'write' as const, path: employeePath(d.id), text: serializeEmployee(d, { instructions: true }), expectedBlob: null })), { subject: 'An earlier Foreman' })
    expect(written.ok).toBe(true)
    for (const d of [quinn, quill, max]) await employees.approve('o1', d.id)
    const elsewhere = structuredClone(state.employees!)
    const before = await gitOut(root, ['rev-parse', 'HEAD'])
    await employees.refresh('o1')
    expect(await gitOut(root, ['rev-list', '--count', `${before}..HEAD`])).toBe('1')
    expect(await gitOut(root, ['log', '-1', '--format=%s'])).toBe('Give every AI employee its own prompt file, and its job’s prompt as Foreman has it')
    const byName = Object.fromEntries((await employees.list('o1')).employees.map((e) => [e.name, e]))
    // Quinn now gets the QA engineer's prompt as this Foreman has it; still approved, since the person asked for this.
    expect(byName.Quinn.definition).toMatchObject({ template: 'qa-engineer', instructions: ownPromptNote('QA engineer', 'e-qnab') })
    expect(byName.Quinn).toMatchObject({ state: 'active', changed: false, prompt: `${ownPromptNote('QA engineer', 'e-qnab')}\n` })
    // An edited prompt and an employee's own words stay its own, only moved to their own files: nothing to approve again.
    expect(byName.Quill.definition!.template).toBeUndefined()
    expect(byName.Quill).toMatchObject({ state: 'active', changed: false, prompt: `${earlierQaPrompt.trim()}\nTest the checkout first.\n` })
    expect(byName.Max).toMatchObject({ state: 'active', changed: false, prompt: `${INSTRUCTIONS}\n` })
    for (const e of Object.values(byName)) expect(e.text).not.toContain('instructions')
    expect(state.migrations).toContain(`${JOB_PROMPTS_MIGRATION}:o1`)
    // Once: nothing more to write.
    const after = await gitOut(root, ['rev-parse', 'HEAD'])
    await employees.refresh('o1')
    expect(await gitOut(root, ['rev-parse', 'HEAD'])).toBe(after)
    // Another computer that approved them as they were reads the commit: its approvals move the same way.
    const other = { ...state, employees: elsewhere, migrations: [`${FULL_ACCESS_MIGRATION}:o1`] } as PersistedState
    const there = new EmployeeService({ state: () => other, memory, changed: () => undefined })
    await there.refresh('o1')
    expect((await there.list('o1')).employees.map((e) => [e.name, e.changed])).toEqual([['Max', false], ['Quill', false], ['Quinn', false]])
    expect(await gitOut(root, ['rev-parse', 'HEAD'])).toBe(after)
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
    await expect(bad.employees.generate('o1', { description: 'x', traits: [] })).rejects.toThrow('The draft didn’t come back as expected: The answer wasn’t a JSON object. Try again, or press Use my words.')
    const { employees, state, draft } = await rig()
    state.settings.privacyMode = true
    await expect(employees.generate('o1', { description: 'x', traits: [] })).rejects.toThrow(PRIVACY_MODE_ON)
    await expect(employees.refine('o1', { name: 'Max', role: '', description: '', personality: '', responsibilities: [], ask_me_about: '', instructions: '' }, 'more')).rejects.toThrow(PRIVACY_MODE_ON)
    expect(draft).not.toHaveBeenCalled()
  })
})

describe('employees: several at once (docs/ai-employees.md §15)', () => {
  const loadouts = [{ agent: 'claude' as const, model: 'claude-sonnet-5-5' }]
  const team = () => {
    const priya = programManagerDefinition({ repos: ['foreman-website'], loadouts, taken: [] })
    const ravi = proposedDefinition({ id: 'e-rav1', colour: 'orange', name: 'Ravi', role: 'Developer', description: 'Builds it.', responsibilities: ['Build'], instructions: INSTRUCTIONS, repos: { 'foreman-website': 'write' }, loadouts })
    return [priya, ravi]
  }

  it('makes each a draft in one commit by the person, its definition and memory folder each', async () => {
    const { root, employees, state } = await rig()
    const before = await gitOut(root, ['rev-parse', 'HEAD'])
    const definitions = team()
    const made = await employees.createTeam('o1', definitions)
    expect(made.map((e) => [e.name, e.state])).toEqual([
      ['Priya', 'draft'],
      ['Ravi', 'draft']
    ])
    expect(await gitOut(root, ['rev-list', '--count', `${before}..HEAD`])).toBe('1')
    const files = (await gitOut(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n')
    for (const d of definitions) expect(files).toEqual(expect.arrayContaining([`bots/${d.id}.toml`, `memory/bots/${d.id}/MEMORY.md`, `memory/bots/${d.id}/journal.md`]))
    expect(await gitOut(root, ['log', '-1', '--format=%s'])).toBe('Add the team: Priya, Ravi')
    // Nothing is approved here.
    expect((state.employees ?? []).every((r) => r.state === 'draft')).toBe(true)
    expect(made.find((e) => e.name === 'Ravi')!.definition!.access.repos).toEqual({ 'foreman-website': 'write' })
  })

  it('refuses a hand-off outside the team or the organization, a name in use, and an id in use, writing nothing', async () => {
    const { root, employees } = await rig()
    const before = await gitOut(root, ['rev-parse', 'HEAD'])
    const [priya] = team()
    await expect(employees.createTeam('o1', [{ ...priya, access: { ...priya.access, delegate_to: ['e-zzzz'] } }])).rejects.toThrow('e-zzzz isn’t one')
    await employees.createTeam('o1', [priya])
    const again = { ...programManagerDefinition({ repos: [], loadouts, taken: [priya.id] }), name: 'Priya' }
    await expect(employees.createTeam('o1', [again])).rejects.toThrow('There is already an employee named Priya')
    await expect(employees.createTeam('o1', [{ ...again, name: 'Nina' }, { ...again, name: 'Nora' }])).rejects.toThrow('already used')
    expect(await gitOut(root, ['rev-list', '--count', `${before}..HEAD`])).toBe('1')
    await expect(employees.createTeam('o2', [again])).rejects.toThrow('has no memory repository')
  })
})

describe('employees: adding a job template (docs/ai-employees.md §5.3, §16)', () => {
  const claude = [{ agent: 'claude' as const, model: 'claude-sonnet-5-5', fast: false }]
  const ready = async () => {
    const r = await rig()
    r.state.settings.loadouts = claude as typeof r.state.settings.loadouts
    return r
  }

  it('makes the employee and approves it at once, in one commit, with the template’s access on the organization’s repositories', async () => {
    const { root, employees, state } = await ready()
    const before = await gitOut(root, ['rev-parse', 'HEAD'])
    const { employee, approveError } = await employees.addTemplate('o1', 'software-engineer')
    expect(approveError).toBeUndefined()
    expect(employee).toMatchObject({ name: 'Ravi', role: 'Staff software engineer', colour: 'blue', state: 'active', changed: false, approvedAt: '2026-11-13T10:42:00.000Z' })
    expect(await gitOut(root, ['rev-list', '--count', `${before}..HEAD`])).toBe('1')
    expect((await gitOut(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()).toEqual([`bots/${employee.id}.md`, `bots/${employee.id}.toml`, `memory/bots/${employee.id}/MEMORY.md`, `memory/bots/${employee.id}/journal.md`])
    // Linked to its job's prompt; its own file is the note for whoever edits it.
    expect(employee.definition!.template).toBe('software-engineer')
    expect(employee.prompt).toBe(`${ownPromptNote('Software engineer', employee.id)}\n`)
    expect(await gitOut(root, ['log', '-1', '--format=%s'])).toBe(`Add AI employee Ravi (bots/${employee.id}.toml)`)
    // Write on its own organization's repositories: not the memory repository, not Personal's; on the person's agent.
    expect(employee.definition!.access.repos).toEqual({ 'foreman-website': 'write' })
    expect(employee.definition!.model).toMatchObject({ agent: 'claude', model: 'claude-sonnet-5-5' })
    expect(state.employees!.find((r) => r.id === employee.id)).toMatchObject({ state: 'active', approvedFingerprint: employee.fingerprint, approvedBlob: employee.blob })
    // Every job writes, and pushes and opens pull requests without a hold.
    const qa = (await employees.addTemplate('o1', 'qa-engineer')).employee.definition!
    expect(qa.access.repos).toEqual({ 'foreman-website': 'write' })
    expect(qa.access.actions).toMatchObject({ push: 'allowed', 'pull-request': 'allowed' })
    expect(qa.access.profile).toBe('shell')
  })

  it('names a job the roster has "<name> (<job>)", then numbers it, counting retired employees’ names', async () => {
    const { employees } = await ready()
    const first = await employees.addTemplate('o1', 'qa-engineer')
    expect(first.employee.name).toBe('Quinn')
    expect((await employees.addTemplate('o1', 'qa-engineer')).employee.name).toBe('Quinn (QA engineer)')
    expect((await employees.addTemplate('o1', 'qa-engineer')).employee.name).toBe('Quinn (QA engineer) 2')
    await employees.retire('o1', first.employee.id)
    expect((await employees.addTemplate('o1', 'qa-engineer')).employee.name).toBe('Quinn (QA engineer) 3')
  })

  it('wears the template’s hat unless someone who isn’t retired wears it, Priya included; then the first free one', async () => {
    const { employees } = await ready()
    await employees.createTeam('o1', [programManagerDefinition({ repos: [], loadouts: claude, taken: [] })])
    expect((await employees.addTemplate('o1', 'technical-writer')).employee.colour).toBe('orange')
    expect((await employees.addTemplate('o1', 'ux-designer')).employee.colour).toBe('pink')
    // Ana's orange is Theo's; pink is Uma's and teal Priya's: blue.
    const ana = await employees.addTemplate('o1', 'marketing-manager')
    expect(ana.employee.colour).toBe('blue')
    // A colour only a retired employee wears is free again.
    await employees.retire('o1', ana.employee.id)
    expect((await employees.addTemplate('o1', 'software-engineer')).employee.colour).toBe('blue')
  })

  it('repeats the least-worn colour once all twelve are worn', async () => {
    const { employees } = await ready()
    const ids: string[] = []
    const team = HAT_COLOURS.map((colour, i) => {
      const id = newEmployeeId(ids)
      ids.push(id)
      return proposedDefinition({ id, colour, name: `Helper ${i + 1}`, role: 'Helper', description: 'Helps.', responsibilities: ['Help'], instructions: INSTRUCTIONS, repos: {}, loadouts: claude })
    })
    await employees.createTeam('o1', team)
    expect((await employees.addTemplate('o1', 'qa-engineer')).employee.colour).toBe('orange')
  })

  it('adds a template with no repository access when the organization has only its memory repository', async () => {
    const { employees, state } = await ready()
    state.repos = state.repos.filter((r) => r.id !== 'site')
    const { employee } = await employees.addTemplate('o1', 'software-engineer')
    expect(employee).toMatchObject({ name: 'Ravi', state: 'active' })
    expect(employee.definition!.access.repos).toEqual({})
  })

  it('refuses a job it doesn’t know, and an organization without a memory repository, writing nothing', async () => {
    const { root, employees } = await ready()
    const before = await gitOut(root, ['rev-parse', 'HEAD'])
    await expect(employees.addTemplate('o1', 'wizard')).rejects.toThrow('There is no such job to add.')
    await expect(employees.addTemplate('o2', 'qa-engineer')).rejects.toThrow('Later has no memory repository')
    expect(await gitOut(root, ['rev-parse', 'HEAD'])).toBe(before)
  })

  it('leaves the employee a draft and says why when approving fails; what was made stays', async () => {
    const { employees, state } = await ready()
    vi.spyOn(employees, 'approve').mockRejectedValueOnce(new Error('The disk is full.'))
    const { employee, approveError } = await employees.addTemplate('o1', 'qa-engineer')
    expect(approveError).toBe('The disk is full.')
    expect(employee).toMatchObject({ name: 'Quinn', state: 'draft' })
    expect(state.employees!.find((r) => r.id === employee.id)).toEqual({ orgId: 'o1', id: employee.id, state: 'draft' })
    expect((await employees.list('o1')).employees.map((e) => e.name)).toEqual(['Quinn'])
  })

  it('New organization: Priya and the templates picked with her, in one commit, each approved', async () => {
    const { root, employees } = await ready()
    const before = await gitOut(root, ['rev-parse', 'HEAD'])
    const id = await employees.addProgramManager('o1', ['qa-engineer', 'software-engineer'])
    expect(await gitOut(root, ['rev-list', '--count', `${before}..HEAD`])).toBe('1')
    expect(await gitOut(root, ['log', '-1', '--format=%s'])).toBe('Add the team: Priya, Ravi, Quinn')
    const made = (await employees.list('o1')).employees
    expect(made.map((e) => `${e.name}: ${e.state}`).sort()).toEqual(['Priya: active', 'Quinn: active', 'Ravi: active'])
    expect(made.find((e) => e.name === 'Priya')!.id).toBe(id)
    const files = (await gitOut(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n')
    for (const e of made) expect(files).toEqual(expect.arrayContaining([`bots/${e.id}.toml`, `memory/bots/${e.id}/MEMORY.md`, `memory/bots/${e.id}/journal.md`]))
  })

  it('retiring Priya leaves the organization without a program manager, so Add Priya makes a new one; an earlier build’s retired one too', async () => {
    const { employees, state } = await ready()
    const organizations = new OrganizationService({ state: () => state, addRepo: async () => { throw new Error('no') }, changed: () => undefined, createProgramManager: (org, templates = []) => employees.addProgramManager(org.id, templates) })
    const org = state.organizations!.find((o) => o.id === 'o1')!
    await organizations.ensureProgramManager('o1')
    const first = org.programManagerId!
    expect(org).toMatchObject({ programManagerId: first, leadEmployeeId: first })
    await employees.retire('o1', first)
    expect(org.programManagerId).toBeUndefined()
    expect(org.leadEmployeeId).toBeUndefined()
    // Add Priya: a new one, approved, under a name the retired one doesn't have.
    await organizations.ensureProgramManager('o1')
    const second = org.programManagerId!
    expect(second).not.toBe(first)
    expect(org.leadEmployeeId).toBe(second)
    const roster = (await employees.list('o1')).employees
    expect(roster.find((e) => e.id === second)).toMatchObject({ name: 'Priya (PM)', state: 'active', changed: false })
    // A lead the person chose stays when the program manager retires; and a third program manager is numbered.
    org.leadEmployeeId = 'e-lead'
    await employees.retire('o1', second)
    expect(org).toMatchObject({ leadEmployeeId: 'e-lead' })
    expect(org.programManagerId).toBeUndefined()
    await organizations.ensureProgramManager('o1')
    expect((await employees.list('o1')).employees.find((e) => e.id === org.programManagerId)!.name).toBe('Priya (PM) 2')
    // One an earlier build retired kept her place: the next read gives it up.
    org.programManagerId = first
    await employees.refresh('o1')
    expect(org.programManagerId).toBeUndefined()
  })

  it('gives Priya a repository that joins the organization, keeping her approval; an approval of an earlier version stays where it was', async () => {
    const { root, employees, state } = await ready()
    const id = await employees.addProgramManager('o1')
    state.organizations!.find((o) => o.id === 'o1')!.programManagerId = id
    expect((await employees.list('o1')).employees[0].definition!.access.repos).toEqual({ 'foreman-website': 'write' })
    // blog moves into Acme: she gets Write on it, in one commit by the person, and is still approved.
    state.repos.find((r) => r.id === 'blog')!.spaceId = 'o1'
    const before = await gitOut(root, ['rev-parse', 'HEAD'])
    expect(await employees.grantProgramManagerRepo('o1', 'blog')).toBe(true)
    expect(await gitOut(root, ['rev-list', '--count', `${before}..HEAD`])).toBe('1')
    expect(await gitOut(root, ['log', '-1', '--format=%s'])).toBe(`Give AI employee Priya blog (bots/${id}.toml)`)
    const [priya] = (await employees.list('o1')).employees
    expect(priya.definition!.access.repos).toEqual({ 'foreman-website': 'write', blog: 'write' })
    expect(priya).toMatchObject({ state: 'active', changed: false })
    expect(state.employees!.find((r) => r.id === id)).toMatchObject({ approvedFingerprint: priya.fingerprint, approvedBlob: priya.blob })
    // Once: she has it now, and an access the person set (none too) is theirs.
    expect(await employees.grantProgramManagerRepo('o1', 'blog')).toBe(false)
    // Changed since she was approved: the repository is still given, and she still waits for a person's approval.
    const edited = await employees.update('o1', id, { ...priya.definition!, role: 'Planner' }, priya.blob)
    expect(edited.ok).toBe(true)
    const approval = state.employees!.find((r) => r.id === id)!.approvedFingerprint
    expect(await employees.grantProgramManagerRepo('o1', 'docs')).toBe(true)
    const after = (await employees.list('o1')).employees[0]
    expect(after.definition!.access.repos.docs).toBe('write')
    expect(after).toMatchObject({ changed: true })
    expect(state.employees!.find((r) => r.id === id)!.approvedFingerprint).toBe(approval)
  })

  it('New organization: an approval that fails throws, and what was made stays as drafts', async () => {
    const { employees } = await ready()
    vi.spyOn(employees, 'approve').mockRejectedValueOnce(new Error('The disk is full.'))
    await expect(employees.addProgramManager('o1', ['qa-engineer'])).rejects.toThrow('The disk is full.')
    expect((await employees.list('o1')).employees.map((e) => `${e.name}: ${e.state}`).sort()).toEqual(['Priya: draft', 'Quinn: draft'])
  })
})
