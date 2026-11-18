// Spaces and organizations (docs/ai-employees.md §2 and §3). Every repository belongs to exactly one space: Personal,
// which always exists and is today's Foreman, or an organization the person created on purpose. `Repo.spaceId` names
// the organization; absent, the repository is in Personal. Pure, so main, the renderer and the tests read the same rules.
import { parseWorkLimits, type WorkLimits } from './employeeBroker'
import { isEmployeeId } from './memory'
import { joinWorkspace } from './openIn'
import type { AppSnapshot, Repo } from './types'

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
  // Its program manager (docs/ai-employees.md §15): made with it, and where every project starts.
  programManagerId?: string
  // The folder its new repositories go in: Clone and Quick start while it is showing start there, and what they make
  // joins it. Its memory repository is made there too when made with it. Absent: they go where Personal's do.
  folder?: string
  // The remote its memory repository is pushed to after each commit (Settings → Spaces → Link to GitHub). Absent: the
  // memory stays on this computer.
  memoryLink?: MemoryLink
  // Only in createOrganization's answer: why its program manager couldn't be made (the organization was). Never saved.
  teamProblem?: string
  createdAt: string
}

/** Where an organization's memory repository is pushed: a remote URL (no credentials in it), the gh account, the last push. */
export interface MemoryLink {
  remoteUrl: string
  account?: string
  // The last push that landed, and why the last one that didn't failed (cleared by the next that lands).
  pushedAt?: string
  error?: string
}

/** How an organization links its memory: a private GitHub repository made for it, or a remote URL the person pastes. */
export type MemoryLinkInput = { kind: 'create'; name: string; account?: string } | { kind: 'existing'; remoteUrl: string; account?: string }

/**
 * How an organization gets its memory repository: a new one made in `parentDir/name`; a new one in `parentDir` named
 * `<organization>-memory` (the first free name), which New organization asks for without showing it; a registered one;
 * or none yet.
 */
export type OrganizationMemory =
  | { kind: 'create'; name: string; parentDir: string }
  | { kind: 'auto'; parentDir: string }
  | { kind: 'existing'; repoId: string }
  | { kind: 'later' }

export interface CreateOrganizationInput {
  name: string
  memory: OrganizationMemory
  // Repositories brought from Personal; their workspaces and chats come with them. They stay where they are on disk.
  repoIds: string[]
  // Keep its repositories in a folder of their own (Organization.folder): an absolute path, made if it isn't there.
  folder?: string
  // Starting templates (shared/employeeTemplates.ts) to make with Priya and approve with the organization. They need its
  // memory repository, as she does: with none yet, they aren't made.
  templates?: import('./employeeTemplates').EmployeeTemplateId[]
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

/** The first of `<organization>-memory`, `<organization>-memory-2`, … that `taken` doesn't refuse. */
export function freeMemoryName(organization: string, taken: (name: string) => boolean): string {
  const base = defaultMemoryName(organization)
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`
    if (!taken(name)) return name
  }
}

/** Whether two paths name the same folder, ignoring separators, a trailing one and case. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * The folder a new organization's repositories start in: `<clone location>/<organization>`, or `…/<organization>-org`
 * when a registered repository is already that folder (an organization named after one of its repositories).
 */
export function defaultOrganizationFolder(name: string, cloneDirectory: string, repos: readonly Pick<Repo, 'rootPath'>[]): string {
  const slug = organizationSlug(name) || 'organization'
  const plain = joinWorkspace(cloneDirectory, slug)
  return repos.some((r) => samePath(r.rootPath, plain)) ? joinWorkspace(cloneDirectory, `${slug}-org`) : plain
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
 * Whether spaces split the repositories: at least one organization exists. Until then every repository is in Personal
 * and shows as it always did; the switcher still offers New organization….
 */
export function spacesOn(organizations: readonly Organization[] | undefined): boolean {
  return (organizations?.length ?? 0) > 0
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

/**
 * Whether a repository can have workspaces: an organization's memory repository never does (docs/ai-employees.md §4,
 * Foreman's memory service is its only writer), so nothing offers or makes one there.
 */
export function holdsWorkspaces(repoId: string, organizations: readonly Organization[] | undefined): boolean {
  return !memoryOwner(repoId, organizations ?? [])
}

/** The repositories a workspace can be made in, in their usual order: every one but the organizations' memory repositories. */
export function workspaceRepos(repos: readonly Repo[], organizations: readonly Organization[] | undefined): Repo[] {
  return repos.filter((r) => holdsWorkspaces(r.id, organizations))
}

/**
 * The repository New workspace opens on, wherever it is asked for (the sidebar's button, ⌘N, Home, the palette): the
 * one the sidebar picked, else the selected workspace's, else the first of the space shown, each only while it is in
 * that space and never an organization's memory repository. Undefined when the space has none to offer.
 */
export function newWorkspaceTarget(snapshot: AppSnapshot, view: { space: string | null | undefined; picked: string | null | undefined; selectedWorkspaceId: string | null | undefined }): string | undefined {
  const shown = snapshotInSpace(snapshot, view.space)
  const usable = (id: string | null | undefined) => (id && shown.repos.some((r) => r.id === id) && holdsWorkspaces(id, snapshot.organizations) ? id : undefined)
  const selected = view.selectedWorkspaceId ? shown.workspaces.find((w) => w.id === view.selectedWorkspaceId)?.repoId : undefined
  return usable(view.picked) ?? usable(selected) ?? workspaceRepos(shown.repos, snapshot.organizations)[0]?.id
}

/** The space shown: the organization asked for while it exists, else Personal. */
export function currentSpace(organizations: readonly Organization[] | undefined, wanted: string | null | undefined): string | null {
  return wanted && organizations?.some((o) => o.id === wanted) ? wanted : null
}

/**
 * The snapshot as one space sees it: its code repositories and their workspaces. An organization's memory repository is
 * never listed (what Foreman keeps for it isn't shown on the left). While spaces don't apply it is the snapshot itself,
 * so everything is listed as it always was.
 */
export function snapshotInSpace(snapshot: AppSnapshot, wanted: string | null | undefined): AppSnapshot {
  const organizations = snapshot.organizations ?? []
  if (!spacesOn(organizations)) return snapshot
  const space = currentSpace(organizations, wanted)
  const repos = workspaceRepos(reposInSpace(snapshot.repos, organizations, space), organizations)
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
    const { id, name, memoryRepoId, leadEmployeeId, workLimits, programManagerId, folder, memoryLink, createdAt } = entry
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim() || typeof createdAt !== 'string') continue
    if (out.some((o) => o.id === id)) continue
    const limits = parseWorkLimits(workLimits)
    out.push({
      id,
      name,
      ...(typeof memoryRepoId === 'string' && memoryRepoId ? { memoryRepoId } : {}),
      ...(typeof leadEmployeeId === 'string' && isEmployeeId(leadEmployeeId) ? { leadEmployeeId } : {}),
      ...(limits ? { workLimits: limits } : {}),
      ...(typeof programManagerId === 'string' && isEmployeeId(programManagerId) ? { programManagerId } : {}),
      ...(typeof folder === 'string' && folder.trim() ? { folder } : {}),
      ...(parseMemoryLink(memoryLink) ? { memoryLink: parseMemoryLink(memoryLink) } : {}),
      createdAt
    })
  }
  return out
}

function parseMemoryLink(value: unknown): MemoryLink | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { remoteUrl, account, pushedAt, error } = value as Record<string, unknown>
  if (typeof remoteUrl !== 'string' || !remoteUrl.trim()) return undefined
  return {
    remoteUrl,
    ...(typeof account === 'string' && account ? { account } : {}),
    ...(typeof pushedAt === 'string' && pushedAt ? { pushedAt } : {}),
    ...(typeof error === 'string' && error ? { error } : {})
  }
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
