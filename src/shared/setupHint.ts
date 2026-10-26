// The one-time offer of "Set up this repo" (R-3): a repo with no committed
// settings file, on its first workspace, until dismissed or used.
import type { Repo, ResolvedRepoSettings, Workspace } from './types'

export function offerSetupHint(repo: Repo | undefined, resolved: Pick<ResolvedRepoSettings, 'sharedFile'> | undefined, workspaces: Workspace[], ws: Workspace): boolean {
  if (!repo || repo.setupHintDismissed || resolved?.sharedFile) return false
  if (ws.state !== 'ready' || !ws.path) return false
  // Only the first workspace the repo ever had (archived ones count).
  const ofRepo = workspaces.filter((w) => w.repoId === repo.id)
  return ofRepo.length === 1 && ofRepo[0].id === ws.id
}
