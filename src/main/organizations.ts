// Organizations (docs/ai-employees.md §3): create, rename and delete them, move repositories between spaces, and give
// one its memory repository (§4), made here as a new git repository with the layout below and one commit. Every
// method refuses while Settings → Experimental → AI employees is off; nothing here deletes anything on disk.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  isRepoFolderName,
  MAX_ORGANIZATION_NAME,
  MEMORY_MANIFEST,
  memoryChoices,
  memoryOwner,
  moveRefusal,
  organizationNameProblem,
  spaceOf,
  type CreateOrganizationInput,
  type MemoryRefusal,
  type Organization,
  type OrganizationMemory
} from '../shared/organizations'
import { isEmployeeId } from '../shared/memory'
import type { Repo } from '../shared/types'
import { quickStart } from './repoSources'
import type { PersistedState } from './store'

export const AI_EMPLOYEES_OFF = 'AI employees are off. Turn them on in Settings → Experimental.'

export interface OrganizationHost {
  state(): PersistedState
  // Register a repository folder (WorkspaceService.addRepo): a new one lands in Personal, as every added one does.
  addRepo(dir: string): Promise<Repo>
  // Save and tell the windows.
  changed(): void
  // An organization was renamed or given a memory repository: the memory service keeps its `.foreman-memory.json` current.
  organizationChanged?(id: string): void
}

/** The files a new memory repository starts with (docs/ai-employees.md §4). */
export function memoryRepositoryFiles(organization: string): Record<string, string> {
  const keep = ''
  return {
    'README.md': [
      `# ${organization} memory`,
      '',
      `This is the memory repository of the ${organization} organization in Foreman. It belongs to ${organization} alone and is never shared with another organization.`,
      '',
      'It holds what Foreman keeps for the organization, so its code repositories stay clean:',
      '',
      '- `memory/org/`: the organization’s own memory. `PROJECT.md` says what the organization is and wants, `decisions.md` records each decision with its date, and `instructions.md` holds the instructions every AI employee reads first.',
      '- `memory/bots/<id>/`: each AI employee’s own memory.',
      '- `bots/<id>.toml`: each AI employee’s definition.',
      '- `repos/<name>/`: Foreman’s files for repositories that shouldn’t carry their own `.foreman/`.',
      `- \`${MEMORY_MANIFEST}\`: what this repository is, written by Foreman only.`,
      '',
      'Foreman writes here through its memory service, one commit at a time, so `git log` says who learned what and when. You can read and edit it like any repository. It is private until you push it somewhere.',
      ''
    ].join('\n'),
    'memory/org/PROJECT.md': `# ${organization}\n\nWhat ${organization} is, its goals, its preferences and the decisions it has accepted. Every AI employee reads this first.\n`,
    'memory/org/decisions.md': '# Decisions\n\nOne dated entry per decision, newest last. Entries are added, never rewritten.\n',
    'memory/org/instructions.md': `# Instructions\n\nWhat every AI employee in ${organization} should know and do, before its own instructions and its task.\n`,
    'memory/bots/.gitkeep': keep,
    'bots/.gitkeep': keep,
    'repos/.gitkeep': keep,
    [MEMORY_MANIFEST]: `${JSON.stringify({ schema: 1, organization }, null, 2)}\n`
  }
}

/** Make `parentDir/name` a new memory repository for `organization`, with its layout committed once. Returns its folder. */
export function createMemoryRepository(parentDir: string, name: string, organization: string): Promise<string> {
  return quickStart(parentDir, name, { files: memoryRepositoryFiles(organization), message: `Create the ${name} memory repository` })
}

function refusalText(repo: Repo, refusal: MemoryRefusal): string {
  return refusal.kind === 'memory-of'
    ? `${repo.name} is ${refusal.organization}’s memory repository. A memory repository belongs to one organization.`
    : `${repo.name} is in ${refusal.organization}. Move it to Personal first.`
}

function nameError(problem: ReturnType<typeof organizationNameProblem>, name: string): string | null {
  if (problem === 'empty') return 'Give the organization a name.'
  if (problem === 'long') return `Keep the organization’s name to ${MAX_ORGANIZATION_NAME} characters.`
  if (problem === 'taken') return `There is already an organization named ${name.trim()}.`
  return null
}

const isMemory = (value: unknown): value is OrganizationMemory => {
  const m = value as Record<string, unknown> | null
  if (!m || typeof m !== 'object') return false
  if (m.kind === 'later') return true
  if (m.kind === 'existing') return typeof m.repoId === 'string'
  return m.kind === 'create' && typeof m.name === 'string' && typeof m.parentDir === 'string'
}

export class OrganizationService {
  constructor(
    private host: OrganizationHost,
    // Tests may make the memory repository elsewhere; the app uses the real one.
    private makeMemory: typeof createMemoryRepository = createMemoryRepository
  ) {}

  private get state(): PersistedState {
    return this.host.state()
  }

  private get organizations(): Organization[] {
    return (this.state.organizations ??= [])
  }

  private assertOn(): void {
    if (!this.state.settings.aiEmployees) throw new Error(AI_EMPLOYEES_OFF)
  }

  private organization(id: string): Organization {
    const org = this.organizations.find((o) => o.id === id)
    if (!org) throw new Error('Organization not found')
    return org
  }

  private repo(id: string): Repo {
    const repo = this.state.repos.find((r) => r.id === id)
    if (!repo) throw new Error('Repository not found')
    return repo
  }

  /** Checks a memory choice before anything is made or moved; returns the existing repository it names, if any. */
  private checkMemory(memory: OrganizationMemory, organizationId?: string): Repo | undefined {
    if (memory.kind === 'later') return undefined
    if (memory.kind === 'create') {
      if (!isRepoFolderName(memory.name)) throw new Error('Use letters, numbers, dots, dashes or underscores for the memory repository’s name')
      if (!memory.parentDir.trim() || !path.isAbsolute(memory.parentDir.trim())) throw new Error('Choose the folder the memory repository goes in')
      return undefined
    }
    const repo = this.repo(memory.repoId)
    const refusal = memoryChoices(this.state.repos, this.organizations, organizationId).find((c) => c.repo.id === repo.id)?.refusal
    if (refusal) throw new Error(refusalText(repo, refusal))
    return repo
  }

  /** Make or pick the memory repository; the repository it names is moved into the organization's space by the caller. */
  private async memoryRepo(memory: OrganizationMemory, organization: string, existing: Repo | undefined): Promise<Repo | undefined> {
    if (memory.kind === 'existing') return existing
    if (memory.kind !== 'create') return undefined
    const dir = await this.makeMemory(memory.parentDir.trim(), memory.name.trim(), organization)
    this.state.settings.cloneDirectory = memory.parentDir.trim()
    return this.host.addRepo(dir)
  }

  async create(input: CreateOrganizationInput): Promise<Organization> {
    this.assertOn()
    if (!input || typeof input.name !== 'string' || !isMemory(input.memory) || !Array.isArray(input.repoIds) || input.repoIds.some((id) => typeof id !== 'string')) {
      throw new Error('Invalid organization')
    }
    const name = input.name.trim()
    const problem = nameError(organizationNameProblem(name, this.organizations), name)
    if (problem) throw new Error(problem)
    // Only repositories in Personal are brought; each is checked before anything is made on disk.
    const brought = [...new Set(input.repoIds)].map((id) => this.repo(id))
    for (const repo of brought) {
      const space = spaceOf(repo, this.organizations)
      if (space) throw new Error(`${repo.name} is in ${this.organization(space).name}, not Personal`)
    }
    const existing = this.checkMemory(input.memory)
    const memory = await this.memoryRepo(input.memory, name, existing)
    const org: Organization = { id: randomUUID(), name, ...(memory ? { memoryRepoId: memory.id } : {}), createdAt: new Date().toISOString() }
    this.organizations.push(org)
    for (const repo of [...brought, ...(memory ? [memory] : [])]) repo.spaceId = org.id
    this.host.changed()
    if (memory) this.host.organizationChanged?.(org.id)
    return org
  }

  rename(id: string, name: string): Organization {
    this.assertOn()
    const org = this.organization(id)
    const clean = typeof name === 'string' ? name.trim() : ''
    const problem = nameError(organizationNameProblem(clean, this.organizations, id), clean)
    if (problem) throw new Error(problem)
    org.name = clean
    this.host.changed()
    this.host.organizationChanged?.(org.id)
    return org
  }

  /** The organization goes; its repositories, the memory repository too, are in Personal again. Nothing on disk changes. */
  delete(id: string): void {
    this.assertOn()
    this.organization(id)
    for (const repo of this.state.repos) if (repo.spaceId === id) delete repo.spaceId
    this.state.organizations = this.organizations.filter((o) => o.id !== id)
    this.host.changed()
  }

  /**
   * Name the organization's lead employee on this computer, or none (docs/ai-employees.md §7): unaddressed work ("lead")
   * and escalations go to it. The caller checks the employee is one of the organization's.
   */
  setLead(id: string, employeeId: string | null): Organization {
    this.assertOn()
    const org = this.organization(id)
    if (employeeId === null) delete org.leadEmployeeId
    else if (typeof employeeId === 'string' && isEmployeeId(employeeId)) org.leadEmployeeId = employeeId
    else throw new Error('Employee not found')
    this.host.changed()
    return org
  }

  moveRepo(repoId: string, organizationId: string | null): void {
    this.assertOn()
    const repo = this.repo(repoId)
    if (organizationId !== null) this.organization(organizationId)
    const refusal = moveRefusal(repoId, organizationId, this.organizations)
    if (refusal) throw new Error(`${repo.name} is ${refusal.organization}’s memory repository, so it stays in ${refusal.organization}.`)
    if (organizationId) repo.spaceId = organizationId
    else delete repo.spaceId
    this.host.changed()
  }

  /** For an organization without one: make or pick its memory repository now. */
  async setMemory(organizationId: string, memory: OrganizationMemory): Promise<Organization> {
    this.assertOn()
    const org = this.organization(organizationId)
    if (!isMemory(memory)) throw new Error('Invalid memory repository')
    if (memory.kind === 'later') return org
    if (org.memoryRepoId) throw new Error(`${org.name} already has a memory repository`)
    const existing = this.checkMemory(memory, org.id)
    const repo = await this.memoryRepo(memory, org.name, existing)
    if (!repo) return org
    // Made or picked while it waited: still nobody else's.
    if (memoryOwner(repo.id, this.organizations)) throw new Error(`${repo.name} is already a memory repository`)
    org.memoryRepoId = repo.id
    repo.spaceId = org.id
    this.host.changed()
    this.host.organizationChanged?.(org.id)
    return org
  }

  /** A repository left Foreman: an organization it was the memory repository of has none now. Runs whether or not the switch is on. */
  repoRemoved(repoId: string): void {
    let changed = false
    for (const org of this.organizations) {
      if (org.memoryRepoId !== repoId) continue
      delete org.memoryRepoId
      changed = true
    }
    if (changed) this.host.changed()
  }
}
