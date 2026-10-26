// Compare models: the same prompt in the source workspace and in one or two
// sibling workspaces, each made from a fresh checkpoint of the source. The
// siblings share a compareId. There is no winner and no merge here: the user
// opens whichever they like and archives the rest.
import { randomUUID } from 'node:crypto'
import { modelInfo } from '../shared/agents'
import { COMPARE_MAX_EXTRA, compareBlock } from '../shared/compare'
import type { CompareRequest, CompareResult, Loadout, SendDisposition, Workspace } from '../shared/types'
import { wsPath } from '../shared/workspacePath'
import { deleteCheckpoints, restoreCheckpoint, saveCheckpoint } from './checkpoints'
import type { Store } from './store'
import type { WorkspaceService } from './workspaces'

export interface CompareDeps {
  store: Store
  workspaces: WorkspaceService
  // Any turn running, starting or queued in the workspace.
  isRunning(workspaceId: string): boolean
  // Send to an existing tab, as if typed.
  send(sessionId: string, text: string): Promise<SendDisposition>
  // Open the first chat of a workspace and send the prompt once it is ready; returns the chat's id.
  startChat(workspaceId: string, prompt: string, loadout: Loadout): string
  // Archive without deleting the branch (stops terminals and sessions first).
  archive(workspaceId: string): Promise<void>
}

const labelOf = (model: Loadout) => modelInfo(model.agent, model.model).label

export class CompareService {
  // Source workspace → the start in progress, so a double-click can't create twice.
  private starting = new Map<string, Promise<CompareResult>>()

  constructor(private deps: CompareDeps) {}

  /** Why a comparison can't start from this workspace now, or null. */
  block(workspaceId: string): string | null {
    const { store, workspaces } = this.deps
    const ws = workspaces.workspace(workspaceId)
    const tabs = store.state.sessions.filter((s) => s.workspaceId === workspaceId)
    return compareBlock(ws, tabs) ?? (this.deps.isRunning(workspaceId) ? 'An agent is still working here. Compare needs every tab to be idle.' : null)
  }

  start(workspaceId: string, request: CompareRequest): Promise<CompareResult> {
    const running = this.starting.get(workspaceId)
    if (running) return Promise.reject(new Error('A comparison is already starting from this workspace.'))
    const run = this.run(workspaceId, request).finally(() => this.starting.delete(workspaceId))
    this.starting.set(workspaceId, run)
    return run
  }

  private async run(workspaceId: string, request: CompareRequest): Promise<CompareResult> {
    const { store, workspaces } = this.deps
    const prompt = request.prompt.trim()
    if (!prompt) throw new Error('Write the prompt to send to every model.')
    if (request.models.length < 1 || request.models.length > COMPARE_MAX_EXTRA) throw new Error(`Pick one or two extra models to compare with.`)
    const source = workspaces.workspace(workspaceId)
    const tab = store.state.sessions.find((s) => s.id === request.sessionId && s.workspaceId === workspaceId && !s.closedAt)
    if (!tab) throw new Error('That chat is not open in this workspace.')
    if (tab.importedMode === 'history') throw new Error('This chat was imported as history only.')
    const blocked = this.block(workspaceId)
    if (blocked) throw new Error(blocked)

    // 1. A fresh snapshot of the source: HEAD, index and the working tree, untracked files included.
    const compareId = randomUUID()
    const checkpointId = `compare-${compareId}`
    const saved = await saveCheckpoint(wsPath(source), checkpointId)
    if (!saved.ok) throw new Error(`Couldn’t snapshot ${source.name}: ${saved.reason}.`)

    const created: Workspace[] = []
    try {
      // 2. Siblings with setup held back, so the snapshot lands before setup sees the tree.
      for (const model of request.models) {
        const sibling = await workspaces.createWorkspace(source.repoId, { baseBranch: source.baseBranch, deferSetup: true })
        sibling.compareId = compareId
        sibling.compare = { prompt, label: labelOf(model) }
        created.push(sibling)
        workspaces.touch()
      }
      // 3. Restore into each, then let setup run.
      for (const sibling of created) {
        try {
          await workspaces.worktreePrepared(sibling.id)
          await restoreCheckpoint(wsPath(sibling), checkpointId)
          workspaces.continueSetup(sibling.id)
        } catch (err) {
          // This one is left in error (visible in the group); the others carry on.
          workspaces.continueSetup(sibling.id, `Couldn’t copy ${source.name} into this workspace: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } catch (err) {
      for (const sibling of created) workspaces.continueSetup(sibling.id, 'Compare was cancelled.')
      for (const sibling of created) await this.deps.archive(sibling.id).catch(() => undefined)
      await deleteCheckpoints(wsPath(source), checkpointId).catch(() => undefined)
      throw err
    }

    // 4. The same prompt, each with its own model. The source's tab keeps the model it has.
    created.forEach((sibling, n) => {
      sibling.compare!.sessionId = this.deps.startChat(sibling.id, prompt, request.models[n])
    })
    source.compareId = compareId
    source.compare = { prompt, label: labelOf({ agent: tab.agent, model: tab.model, fast: false }), sessionId: tab.id }
    workspaces.touch()
    await deleteCheckpoints(wsPath(source), checkpointId).catch(() => undefined)
    await this.deps.send(tab.id, prompt)
    return { compareId, workspaces: [source, ...created] }
  }

  /** Archive every other workspace of a comparison. Nothing is merged and nothing is picked for you. */
  async archiveOthers(compareId: string, keepWorkspaceId: string): Promise<void> {
    const { store } = this.deps
    const group = store.state.workspaces.filter((w) => w.compareId === compareId && w.state !== 'archived')
    if (!group.some((w) => w.id === keepWorkspaceId)) throw new Error('That workspace is not part of this comparison.')
    const others = group.filter((w) => w.id !== keepWorkspaceId)
    const busy = others.find((w) => this.deps.isRunning(w.id))
    if (busy) throw new Error(`${busy.name} is still working. Stop it first, or wait for it to finish.`)
    for (const ws of others) await this.deps.archive(ws.id)
    // What remains is no longer a comparison.
    for (const ws of store.state.workspaces) {
      if (ws.compareId === compareId && ws.state !== 'archived' && group.length - others.length < 2) {
        delete ws.compareId
        delete ws.compare
      }
    }
    this.deps.workspaces.touch()
  }
}
