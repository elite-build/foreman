// Spaces and organizations (docs/ai-employees.md §2 and §3). Every repository belongs to exactly one space: Personal,
// which always exists and is today's Foreman, or an organization the person created on purpose. `Repo.spaceId` names
// the organization; absent, the repository is in Personal. Pure, so main, the renderer and the tests read the same rules.
import { parseWorkLimits, type WorkLimits } from './employeeBroker'
import { isEmployeeId } from './memory'
import type { AppSnapshot, Repo, Settings } from './types'

export interface Organization {
  id: string
  name: string
  // Its memory repository (docs/ai-employees.md §4): a registered repository in this organization's space, never
  // another organization's. Absent: decided later (the organization only groups repositories).
  memoryRepoId?: string
  // Its lead employee on this computer (docs/ai-employees.md §7): unaddressed work ("lead") and escalations go to it.
  leadEmployeeId?: string
  // Its guards on chains of employee work, where they differ from the defaults (shared/employeeBroker.ts).
  workLimits?: Partial<WorkLimits>
  createdAt: string
}

/** How an organization gets its memory repository: a new one made in `parentDir/name`, a registered one, or none yet. */
export type OrganizationMemory = { kind: 'create'; name: string; parentDir: string } | { kind: 'existing'; repoId: string } | { kind: 'later' }

export interface CreateOrganizationInput {
  name: string
  memory: OrganizationMemory
  // Repositories brought from Personal; their workspaces and chats come with them.
  repoIds: string[]
}

export const MAX_ORGANIZATION_NAME = 60

/** The file in a memory repository that says what it is (written by Foreman only). */
export const MEMORY_MANIFEST = '.foreman-memory.json'

/** "Foreman Labs" → "foreman-labs": letters and digits, dashes between. Empty for a name with none (中文). */
export function organizationSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The memory repository's folder name a new organization starts with: `<organization>-memory`. */
export function defaultMemoryName(name: string): string {
  const slug = organizationSlug(name)
  return `${slug || 'organization'}-memory`
}

/** A folder name Quick start accepts: letters, digits, dots, dashes and underscores. */
export function isRepoFolderName(name: string): boolean {
  const clean = name.trim()
  return /^[\w.-]+$/.test(clean) && clean !== '.' && clean !== '..'
}

export type OrganizationNameProblem = 'empty' | 'long' | 'taken'

/** Why `name` can't name an organization (another than `exceptId`), or null. Names are compared ignoring case. */
export function organizationNameProblem(name: string, organizations: readonly Organization[], exceptId?: string): OrganizationNameProblem | null {
  const clean = name.trim()
  if (!clean) return 'empty'
  if (clean.length > MAX_ORGANIZATION_NAME) return 'long'
  const lower = clean.toLocaleLowerCase()
  return organizations.some((o) => o.id !== exceptId && o.name.trim().toLocaleLowerCase() === lower) ? 'taken' : null
}

/**
 * Whether spaces apply: AI employees are on (Settings → Experimental) and at least one organization exists. Otherwise
 * there is no switcher and every repository shows as it always did; organizations are kept, never deleted.
 */
export function spacesOn(settings: Pick<Settings, 'aiEmployees'> | undefined, organizations: readonly Organization[] | undefined): boolean {
  return Boolean(settings?.aiEmployees) && (organizations?.length ?? 0) > 0
}

/** The space a repository is in: its organization's id, or null for Personal (also when that organization is gone). */
export function spaceOf(repo: Pick<Repo, 'spaceId'>, organizations: readonly Organization[]): string | null {
  return repo.spaceId && organizations.some((o) => o.id === repo.spaceId) ? repo.spaceId : null
}

/** The repositories in one space (null: Personal), in their usual order. */
export function reposInSpace(repos: readonly Repo[], organizations: readonly Organization[], space: string | null): Repo[] {
  return repos.filter((r) => spaceOf(r, organizations) === space)
}

/** The organization whose memory repository this is. */
export function memoryOwner(repoId: string, organizations: readonly Organization[]): Organization | undefined {
  return organizations.find((o) => o.memoryRepoId === repoId)
}

/** The space shown: the organization asked for while it exists, else Personal. */
export function currentSpace(organizations: readonly Organization[] | undefined, wanted: string | null | undefined): string | null {
  return wanted && organizations?.some((o) => o.id === wanted) ? wanted : null
}

/**
 * The snapshot as one space sees it: its repositories (the memory repository first) and their workspaces. While spaces
 * don't apply it is the snapshot itself, so everything is listed as it always was.
 */
export function snapshotInSpace(snapshot: AppSnapshot, wanted: string | null | undefined): AppSnapshot {
  const organizations = snapshot.organizations ?? []
  if (!spacesOn(snapshot.settings, organizations)) return snapshot
  const space = currentSpace(organizations, wanted)
  const memory = space ? organizations.find((o) => o.id === space)?.memoryRepoId : undefined
  const repos = reposInSpace(snapshot.repos, organizations, space).sort((a, b) => Number(b.id === memory) - Number(a.id === memory))
  const ids = new Set(repos.map((r) => r.id))
  return { ...snapshot, repos, workspaces: snapshot.workspaces.filter((w) => ids.has(w.repoId)) }
}

/** Why a repository can't be an organization's memory repository: it is another one's, or it is in another organization. */
export type MemoryRefusal = { kind: 'memory-of'; organization: string } | { kind: 'in-space'; organization: string }

export interface MemoryChoice {
  repo: Repo
  refusal?: MemoryRefusal
}

/**
 * The repositories `organizationId` (undefined: one being created) could take as its memory repository, offered ones
 * first: those named like one (`…-memory`) first among them. A repository in Personal or in this organization is
 * offered; another organization's memory repository, or any repository in another organization, is listed with why not.
 */
export function memoryChoices(repos: readonly Repo[], organizations: readonly Organization[], organizationId?: string): MemoryChoice[] {
  const named = (r: Repo) => Number(/-memory$/i.test(r.name))
  const choices = repos.map((repo): MemoryChoice => {
    const owner = memoryOwner(repo.id, organizations)
    if (owner && owner.id !== organizationId) return { repo, refusal: { kind: 'memory-of', organization: owner.name } }
    const space = spaceOf(repo, organizations)
    if (space && space !== organizationId) return { repo, refusal: { kind: 'in-space', organization: organizations.find((o) => o.id === space)!.name } }
    return { repo }
  })
  return choices.sort((a, b) => Number(Boolean(a.refusal)) - Number(Boolean(b.refusal)) || named(b.repo) - named(a.repo))
}

/** Why a repository can't move to `target` (null: Personal): an organization's memory repository stays in its organization. */
export function moveRefusal(repoId: string, target: string | null, organizations: readonly Organization[]): MemoryRefusal | null {
  const owner = memoryOwner(repoId, organizations)
  return owner && owner.id !== target ? { kind: 'memory-of', organization: owner.name } : null
}

/** The organizations in state.json, checked entry by entry: anything malformed, or a second use of an id, is dropped. */
export function parseOrganizations(value: unknown): Organization[] {
  if (!Array.isArray(value)) return []
  const out: Organization[] = []
  for (const entry of value as Record<string, unknown>[]) {
    if (!entry || typeof entry !== 'object') continue
    const { id, name, memoryRepoId, leadEmployeeId, workLimits, createdAt } = entry
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim() || typeof createdAt !== 'string') continue
    if (out.some((o) => o.id === id)) continue
    const limits = parseWorkLimits(workLimits)
    out.push({
      id,
      name,
      ...(typeof memoryRepoId === 'string' && memoryRepoId ? { memoryRepoId } : {}),
      ...(typeof leadEmployeeId === 'string' && isEmployeeId(leadEmployeeId) ? { leadEmployeeId } : {}),
      ...(limits ? { workLimits: limits } : {}),
      createdAt
    })
  }
  return out
}

/**
 * Bring organizations and repositories into agreement after a load or a hand edit, in place: a memory repository that is
 * no longer registered, or already another organization's, is let go; a memory repository is in its organization's space;
 * and a repository in an organization that is gone is in Personal. Nothing on disk is touched.
 */
export function reconcileSpaces(organizations: Organization[], repos: Repo[]): void {
  const taken = new Set<string>()
  for (const org of organizations) {
    const repo = org.memoryRepoId ? repos.find((r) => r.id === org.memoryRepoId) : undefined
    if (!repo || taken.has(repo.id)) delete org.memoryRepoId
    else {
      taken.add(repo.id)
      repo.spaceId = org.id
    }
  }
  for (const repo of repos) {
    if (repo.spaceId !== undefined && !organizations.some((o) => o.id === repo.spaceId)) delete repo.spaceId
  }
}
