// Dev-only demo (main/demo.ts): Acme fuller than the screenshot fixture's (screensOrganization.ts), so the sidebar's Work,
// Team and Channels have something to show. Two more code repositories, billing and docs, each with a workspace (Work lists
// a repository once it has one), and four more employees: Priya, the program manager every new organization starts with
// (she plans its channels), Ravi, Uma and Quinn. Seeded after the fixture's organization, so the screenshot fixture and the
// tests that read it stay as they are.
import path from 'node:path'
import { gitOut } from './git'
import { employeeFingerprint, seedMemoryFiles } from './employees'
import { DEFAULT_MODEL } from '../shared/agents'
import { programManagerDefinition } from '../shared/employeeTeams'
import { defaultEmployee, employeePath, employeePromptFile, employeePromptPath, parseEmployee, serializeEmployee, type EmployeeDefinition, type EmployeeRecord } from '../shared/employees'
import type { Repo, RepoIcon, Workspace } from '../shared/types'
import { MEMORY_REPO, ORG_ID, type OrganizationSeed } from './screensOrganization'

const BILLING_REPO = 'repo-billing'
const DOCS_REPO = 'repo-docs'
const LOADOUTS = [{ agent: 'claude' as const, model: DEFAULT_MODEL.claude, effort: 'high' as const }]

/** A definition as its files say it, read back so its approval fingerprints exactly what they hold. */
function asFiles(made: EmployeeDefinition): { toml: string; prompt: string; definition: EmployeeDefinition } {
  const toml = serializeEmployee(made)
  const prompt = employeePromptFile(made)
  const parsed = parseEmployee(toml, undefined, prompt)
  if (!parsed.definition) throw new Error(`The demo's ${made.id} doesn't parse: ${parsed.problems.join(' ')}`)
  return { toml, prompt, definition: parsed.definition }
}

const person = (id: string, colour: string, repos: string[], text: Partial<EmployeeDefinition>) => asFiles({ ...defaultEmployee({ id, colour, repos, loadouts: LOADOUTS }), ...text })

export async function seedDemoOrganization(seed: OrganizationSeed): Promise<void> {
  const { store, minutesAgo: at } = seed
  const memory = store.state.repos.find((r) => r.id === MEMORY_REPO)!.rootPath

  // ---- two more code repositories, each with a workspace ----
  const billing = path.join(seed.repos, 'billing')
  const docs = path.join(seed.repos, 'docs')
  await seed.makeRepo(billing, { 'README.md': '# Billing\n\nInvoices, plans and the Stripe webhooks for Atlas.\n', 'src/invoice.ts': 'export const CURRENCY = "usd"\n' })
  await seed.makeRepo(docs, { 'README.md': '# Docs\n\ndeveloper.acme.dev: the API reference and guides.\n', 'guides/rate-limits.md': '# Rate limits\n\nComing with Atlas 2.4.\n' })
  const sapporo = path.join(seed.worktrees, 'billing', 'sapporo')
  const porto = path.join(seed.worktrees, 'docs', 'porto')
  await seed.makeWorktree(billing, sapporo, 'annual-plans', { 'src/plans.ts': 'export const PLANS = ["monthly", "annual"]\n' }, {})
  await seed.makeWorktree(docs, porto, 'rate-limit-guide', { 'guides/README.md': '# Guides\n\n- Rate limits\n' }, { 'guides/rate-limits.md': '# Rate limits\n\n60 requests a minute per API key. Beyond that the API answers 429 with Retry-After.\n' })
  const repo = (id: string, name: string, rootPath: string): Repo => ({ id, name, rootPath, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: at(2 * 24 * 60), spaceId: ORG_ID })
  store.state.repos.push(repo(BILLING_REPO, 'billing', billing), repo(DOCS_REPO, 'docs', docs))
  const workspace = (id: string, repoId: string, name: string, branch: string, wsPath: string, minutes: number, extra: Partial<Workspace>): Workspace => ({
    id, repoId, name, branch, baseBranch: 'main', path: wsPath, portBase: 50050, state: 'ready', createdAt: at(minutes), ...extra
  })
  store.state.workspaces.push(
    workspace('ws-sapporo', BILLING_REPO, 'sapporo', 'annual-plans', sapporo, 200, { status: 'in-progress', statusAt: at(150), diffStat: { files: 1, additions: 1, deletions: 0 } }),
    workspace('ws-porto', DOCS_REPO, 'porto', 'rate-limit-guide', porto, 90, { diffStat: { files: 1, additions: 3, deletions: 1 } })
  )

  // ---- four more employees, approved, Priya the program manager ----
  // The fixture's organization is seeded first: its employees and the organization are there.
  const employees = store.state.employees ?? []
  const taken = employees.map((e) => e.id)
  const priya = asFiles(programManagerDefinition({ repos: ['site', 'billing', 'docs'], loadouts: LOADOUTS, taken }))
  const ravi = person('e-ravi4', 'green', ['billing', 'site'], {
    name: 'Ravi',
    role: 'Engineer',
    description: 'Builds the parts of a plan that change code, in billing and the site.',
    personality: 'Careful and quick.',
    responsibilities: ['Build what a plan’s parts ask for', 'Keep the tests passing'],
    ask_me_about: 'How billing works',
    instructions: 'Work on a branch, with tests. Never merge.'
  })
  const uma = person('e-uma5', 'purple', ['site', 'docs'], {
    name: 'Uma',
    role: 'Designer',
    description: 'Draws HTML mocks of pages before they are built.',
    personality: 'Visual and plain-spoken.',
    responsibilities: ['Mock new pages before they are built', 'Keep the site’s look consistent'],
    ask_me_about: 'How a page should look',
    instructions: 'Draw mocks as HTML in the project’s folder; say what each one tries.'
  })
  const quinn = person('e-quinn6', 'yellow', ['site', 'billing', 'docs'], {
    name: 'Quinn',
    role: 'QA',
    description: 'Tests what the others build and writes down what breaks.',
    personality: 'Sceptical and exact.',
    responsibilities: ['Write a test plan for each part', 'Report what fails, with steps'],
    ask_me_about: 'What was tested',
    instructions: 'Report every failure with the steps that show it.'
  })
  const team = [priya, ravi, uma, quinn]
  const files: Record<string, string> = {}
  for (const e of team) {
    files[employeePath(e.definition.id)] = e.toml
    files[employeePromptPath(e.definition.id)] = e.prompt
    Object.assign(files, seedMemoryFiles(e.definition))
  }
  await seed.writeFiles(memory, files)
  await seed.commitAll(memory, 'Add Priya, Ravi, Uma and Quinn', 2 * 24 * 60)
  const blobOf = async (file: string) => (await gitOut(memory, ['rev-parse', `HEAD:${file}`])).trim()
  for (const e of team) {
    const id = e.definition.id
    const record: EmployeeRecord = { orgId: ORG_ID, id, state: 'active', approvedFingerprint: employeeFingerprint(e.definition), approvedBlob: await blobOf(employeePath(id)), approvedPromptBlob: await blobOf(employeePromptPath(id)), approvedAt: at(2 * 24 * 60 - 5) }
    employees.push(record)
  }
  store.state.employees = employees
  const org = store.state.organizations!.find((o) => o.id === ORG_ID)!
  org.programManagerId = priya.definition.id
  // Its own icon on the rail (Settings → Spaces lets the person change it).
  org.icon = DEMO_ORGANIZATION_ICON
  const migrations = (store.state.migrations ??= [])
  if (!migrations.includes('demo-organization-icon')) migrations.push('demo-organization-icon')
}

/** Acme's icon in the demo. */
export const DEMO_ORGANIZATION_ICON: RepoIcon = { kind: 'lucide', name: 'rocket' }
