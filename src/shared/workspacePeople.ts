import people from './workspacePeople.json' with { type: 'json' }
import type { Workspace } from './types'

export interface WorkspacePerson {
  name: string
  fullName: string
  contribution: string
  source: string
}

/** Bundled data only: naming and rendering never fetch biographies. */
export const WORKSPACE_PEOPLE: readonly WorkspacePerson[] = people
const byName = new Map(WORKSPACE_PEOPLE.map((person) => [person.name, person]))

/** Resolve both prefixed branches and generated collision suffixes, e.g. user/tesla-2. */
export function findWorkspacePerson(name: string | undefined): WorkspacePerson | undefined {
  if (!name) return undefined
  const base = name.trim().toLowerCase().split('/').pop()!
  return byName.get(base) ?? byName.get(base.replace(/-\d+$/, ''))
}

/** Persisted namesakes survive automatic task-based workspace/branch renaming. */
export function workspacePerson(workspace: Pick<Workspace, 'namesake' | 'name' | 'branch' | 'placeholderBranch'>): WorkspacePerson | undefined {
  if (workspace.namesake) return findWorkspacePerson(workspace.namesake)
  return findWorkspacePerson(workspace.placeholderBranch) ?? findWorkspacePerson(workspace.branch) ?? findWorkspacePerson(workspace.name)
}
