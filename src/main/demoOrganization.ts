// Dev-only demo (main/demo.ts): Acme fuller than the screenshot fixture's (screensOrganization.ts), so the sidebar's Work,
// Team and Channels have something to show. Three more code repositories, billing, docs and mobile, each with a workspace
// (Work lists a repository once it has one), and six more employees: Priya, the program manager every new organization
// starts with (she plans its channels), Ravi, Uma, Quinn, Kai and Iris. The fixture's single sign-on project goes on from
// where the fixture left it: its two running parts start again when the demo opens (projects.recover), so its channel
// moves. Then Lumen, a second, smaller organization (demoLumen.ts), and what the accounts last said about their usage
// (Settings → Usage). Seeded after the fixture's organization, so the screenshot fixture and the tests that read it stay
// as they are.
import path from 'node:path'
import type { ForemanDb } from './db'
import { gitOut } from './git'
import { employeeFingerprint, seedMemoryFiles } from './employees'
import { seedLumen } from './demoLumen'
import { DEFAULT_MODEL } from '../shared/agents'
import { programManagerDefinition } from '../shared/employeeTeams'
import { defaultEmployee, employeePath, employeePromptFile, employeePromptPath, parseEmployee, serializeEmployee, type EmployeeDefinition, type EmployeeRecord } from '../shared/employees'
import type { AccountLimits } from '../shared/limits'
import type { RepoIcon, Repo, Workspace } from '../shared/types'
import { DEMO_PARTS, type DemoPart } from '../shared/scenarios'
import { MEMORY_REPO, ORG_ID, type OrganizationSeed } from './screensOrganization'

const BILLING_REPO = 'repo-billing'
const DOCS_REPO = 'repo-docs'
const MOBILE_REPO = 'repo-mobile'
export const DEMO_LOADOUTS = [{ agent: 'claude' as const, model: DEFAULT_MODEL.claude, effort: 'high' as const }]

/** A definition as its files say it, read back so its approval fingerprints exactly what they hold. */
export function asFiles(made: EmployeeDefinition): { toml: string; prompt: string; definition: EmployeeDefinition } {
  const toml = serializeEmployee(made)
  const prompt = employeePromptFile(made)
  const parsed = parseEmployee(toml, undefined, prompt)
  if (!parsed.definition) throw new Error(`The demo's ${made.id} doesn't parse: ${parsed.problems.join(' ')}`)
  return { toml, prompt, definition: parsed.definition }
}

export const demoPerson = (id: string, colour: string, repos: string[], text: Partial<EmployeeDefinition>) => asFiles({ ...defaultEmployee({ id, colour, repos, loadouts: DEMO_LOADOUTS }), ...text })

type Made = ReturnType<typeof asFiles>

/** Commit a team's files in an organization's memory repository and approve each one as committed. */
export async function hire(seed: OrganizationSeed, orgId: string, memory: string, team: Made[], message: string, minutes: number): Promise<EmployeeRecord[]> {
  const files: Record<string, string> = {}
  for (const e of team) {
    files[employeePath(e.definition.id)] = e.toml
    files[employeePromptPath(e.definition.id)] = e.prompt
    Object.assign(files, seedMemoryFiles(e.definition))
  }
  await seed.writeFiles(memory, files)
  await seed.commitAll(memory, message, minutes)
  const blobOf = async (file: string) => (await gitOut(memory, ['rev-parse', `HEAD:${file}`])).trim()
  const records: EmployeeRecord[] = []
  for (const e of team) {
    const id = e.definition.id
    records.push({ orgId, id, state: 'active', approvedFingerprint: employeeFingerprint(e.definition), approvedBlob: await blobOf(employeePath(id)), approvedPromptBlob: await blobOf(employeePromptPath(id)), approvedAt: seed.minutesAgo(minutes - 5) })
  }
  return records
}

/** The parts a scenario asked for (shared/scenarios.ts); the demo itself seeds every one. */
export async function seedDemoOrganization(seed: OrganizationSeed, parts: readonly DemoPart[] = DEMO_PARTS): Promise<void> {
  if (parts.includes('team')) await seedTeam(seed)
  // Single sign-on goes on: the copy and the guide start again when the app opens (projects.recover), so its channel moves.
  if (parts.includes('channels')) {
    const db = seed.store.db as ForemanDb
    const sso = db.project('proj-sso')
    if (sso) {
      sso.parts = { ...sso.parts, copy: { state: 'pending', round: 0 }, guide: { state: 'pending', round: 0 } }
      sso.steps = sso.steps.filter((s) => !(s.kind === 'part' && (s.partId === 'copy' || s.partId === 'guide')))
      db.putProject(sso)
    }
  }
  if (parts.includes('lumen')) await seedLumen(seed)
  if (parts.includes('usage')) seedUsage(seed)
}

/** Acme's three more repositories with a workspace each, and six more employees, Priya its program manager. */
async function seedTeam(seed: OrganizationSeed): Promise<void> {
  const { store, minutesAgo: at } = seed
  const memory = store.state.repos.find((r) => r.id === MEMORY_REPO)!.rootPath

  // ---- three more code repositories, each with a workspace ----
  const billing = path.join(seed.repos, 'billing')
  const docs = path.join(seed.repos, 'docs')
  const mobile = path.join(seed.repos, 'mobile')
  await seed.makeRepo(billing, { 'README.md': '# Billing\n\nInvoices, plans and the Stripe webhooks for Atlas.\n', 'src/invoice.ts': 'export const CURRENCY = "usd"\n' })
  await seed.makeRepo(docs, { 'README.md': '# Docs\n\ndeveloper.acme.dev: the API reference and guides.\n', 'guides/rate-limits.md': '# Rate limits\n\nComing with Atlas 2.4.\n' })
  await seed.makeRepo(mobile, {
    'README.md': '# Mobile\n\nThe Atlas app for iOS and Android (React Native).\n',
    'package.json': '{\n  "name": "atlas-mobile",\n  "private": true\n}\n',
    'src/api.ts': 'export async function load(path: string): Promise<unknown> {\n  const response = await fetch(`https://api.acme.dev${path}`)\n  return response.json()\n}\n'
  })
  const sapporo = path.join(seed.worktrees, 'billing', 'sapporo')
  const porto = path.join(seed.worktrees, 'docs', 'porto')
  const nairobi = path.join(seed.worktrees, 'mobile', 'nairobi')
  await seed.makeWorktree(billing, sapporo, 'annual-plans', { 'src/plans.ts': 'export const PLANS = ["monthly", "annual"]\n' }, {})
  await seed.makeWorktree(docs, porto, 'rate-limit-guide', { 'guides/README.md': '# Guides\n\n- Rate limits\n' }, { 'guides/rate-limits.md': '# Rate limits\n\n60 requests a minute per API key. Beyond that the API answers 429 with Retry-After.\n' })
  await seed.makeWorktree(mobile, nairobi, 'offline-cache', { 'src/cache.ts': 'const cache = new Map<string, unknown>()\n\nexport const cached = (path: string) => cache.get(path)\n' }, {})
  const repo = (id: string, name: string, rootPath: string): Repo => ({ id, name, rootPath, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: at(2 * 24 * 60), spaceId: ORG_ID })
  store.state.repos.push(repo(BILLING_REPO, 'billing', billing), repo(DOCS_REPO, 'docs', docs), repo(MOBILE_REPO, 'mobile', mobile))
  const workspace = (id: string, repoId: string, name: string, branch: string, wsPath: string, minutes: number, extra: Partial<Workspace>): Workspace => ({
    id, repoId, name, branch, baseBranch: 'main', path: wsPath, portBase: 50050, state: 'ready', createdAt: at(minutes), ...extra
  })
  store.state.workspaces.push(
    workspace('ws-sapporo', BILLING_REPO, 'sapporo', 'annual-plans', sapporo, 200, { status: 'in-progress', statusAt: at(150), diffStat: { files: 1, additions: 1, deletions: 0 } }),
    workspace('ws-porto', DOCS_REPO, 'porto', 'rate-limit-guide', porto, 90, { diffStat: { files: 1, additions: 3, deletions: 1 } }),
    workspace('ws-nairobi', MOBILE_REPO, 'nairobi', 'offline-cache', nairobi, 45, { status: 'in-progress', statusAt: at(40), diffStat: { files: 1, additions: 3, deletions: 0 } })
  )

  // ---- six more employees, approved, Priya the program manager ----
  // The fixture's organization is seeded first: its employees and the organization are there.
  const employees = store.state.employees ?? []
  const taken = employees.map((e) => e.id)
  const priya = asFiles(programManagerDefinition({ repos: ['site', 'billing', 'docs', 'mobile'], loadouts: DEMO_LOADOUTS, taken }))
  const ravi = demoPerson('e-ravi4', 'green', ['billing', 'site'], {
    name: 'Ravi',
    role: 'Engineer',
    description: 'Builds the parts of a plan that change code, in billing and the site.',
    personality: 'Careful and quick.',
    responsibilities: ['Build what a plan’s parts ask for', 'Keep the tests passing'],
    ask_me_about: 'How billing works',
    instructions: 'Work on a branch, with tests. Never merge.'
  })
  const uma = demoPerson('e-uma5', 'purple', ['site', 'docs', 'mobile'], {
    name: 'Uma',
    role: 'Designer',
    description: 'Draws HTML mocks of pages before they are built.',
    personality: 'Visual and plain-spoken.',
    responsibilities: ['Mock new pages before they are built', 'Keep the site’s look consistent'],
    ask_me_about: 'How a page should look',
    instructions: 'Draw mocks as HTML in the project’s folder; say what each one tries.'
  })
  const quinn = demoPerson('e-quinn6', 'yellow', ['site', 'billing', 'docs', 'mobile'], {
    name: 'Quinn',
    role: 'QA',
    description: 'Tests what the others build and writes down what breaks.',
    personality: 'Sceptical and exact.',
    responsibilities: ['Write a test plan for each part', 'Report what fails, with steps'],
    ask_me_about: 'What was tested',
    instructions: 'Report every failure with the steps that show it.'
  })
  const kai = demoPerson('e-kai7', 'blue', ['mobile'], {
    name: 'Kai',
    role: 'Mobile engineer',
    description: 'Builds the Atlas app for iOS and Android.',
    personality: 'Pragmatic.',
    responsibilities: ['Build the app’s parts of a plan', 'Keep the app fast on a slow network'],
    ask_me_about: 'The mobile app',
    instructions: 'Test on a slow network as well as a fast one.'
  })
  const iris = demoPerson('e-iris8', 'red', ['docs', 'site'], {
    name: 'Iris',
    role: 'Technical writer',
    description: 'Writes the API guides and keeps the reference in step with the code.',
    personality: 'Precise and friendly.',
    responsibilities: ['Write a guide for every new API feature', 'Keep examples runnable'],
    ask_me_about: 'The API docs',
    instructions: 'Every example must run as written. Say which version a guide is for.'
  })
  employees.push(...(await hire(seed, ORG_ID, memory, [priya, ravi, uma, quinn, kai, iris], 'Add Priya, Ravi, Uma, Quinn, Kai and Iris', 2 * 24 * 60)))
  store.state.employees = employees
  const org = store.state.organizations!.find((o) => o.id === ORG_ID)!
  org.programManagerId = priya.definition.id
  // Its own icon on the rail (Settings → Spaces lets the person change it).
  org.icon = DEMO_ORGANIZATION_ICON
}

/** What the accounts last said about their usage (Settings → Usage). */
function seedUsage(seed: OrganizationSeed): void {
  const { store, minutesAgo: at } = seed
  const inMinutes = (minutes: number) => at(-minutes)
  const limits: AccountLimits[] = [
    {
      agent: 'claude',
      updatedAt: at(2),
      windows: [
        { kind: 'session', usedPercent: 46, resetsAt: inMinutes(170), state: 'ok' },
        { kind: 'weekly', usedPercent: 63, resetsAt: inMinutes(3 * 24 * 60), state: 'ok' },
        { kind: 'model-weekly', label: 'Opus', usedPercent: 84, resetsAt: inMinutes(3 * 24 * 60), state: 'warning' }
      ]
    },
    { agent: 'claude', instance: 'ai-work0001', updatedAt: at(30), windows: [{ kind: 'session', usedPercent: 12, resetsAt: inMinutes(240), state: 'ok' }, { kind: 'weekly', usedPercent: 31, resetsAt: inMinutes(5 * 24 * 60), state: 'ok' }] },
    { agent: 'codex', updatedAt: at(15), windows: [{ kind: 'session', usedPercent: 22, resetsAt: inMinutes(200), state: 'ok' }, { kind: 'weekly', usedPercent: 48, resetsAt: inMinutes(4 * 24 * 60), state: 'ok' }] }
  ]
  store.state.limits = limits
}

/** Acme's icon in the demo. */
export const DEMO_ORGANIZATION_ICON: RepoIcon = { kind: 'lucide', name: 'rocket' }
