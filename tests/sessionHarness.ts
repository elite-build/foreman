import { vi } from 'vitest'
import type { AgentDriver, TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import { claudeDriver } from '../src/main/agents/claude'
import type { ClaudeMirror } from '../src/main/claudeMirror'
import { SessionService, type SessionEvents, type TurnHost } from '../src/main/sessions'
import { Store } from '../src/main/store'
import type { PromptTemplate, TurnOutcome, Workspace } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'

export type Script = (req: TurnRequest, cb: TurnCallbacks, signal: AbortSignal) => Promise<void>

/** A Claude stand-in whose turn runs the given script. */
export function fakeDriver(script: Script): AgentDriver {
  return {
    ...claudeDriver,
    createTurn: (req, cb) => {
      const abort = new AbortController()
      return {
        run: () => script(req, cb, abort.signal),
        stop: async () => abort.abort(),
        steer: () => false,
        setPlanMode: async () => {},
        setModel: async () => {}
      }
    }
  }
}

/** A turn that stays running until released (or stopped, which ends it as cancelled). */
export function gate() {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  const script: Script = async (_req, cb, signal) => {
    await Promise.race([released, new Promise((resolve) => signal.addEventListener('abort', resolve))])
    cb.finished(signal.aborted ? { ok: false, error: 'aborted' } : { ok: true })
  }
  return { release, script }
}

export async function setupSessions(options: {
  mirror?: ClaudeMirror; events?: Partial<SessionEvents>; dir?: string; saveState?: boolean; template?: (id: string | undefined) => PromptTemplate | undefined; turnHost?: TurnHost
  // Another SessionService on the same store and workspace (an app restart), and extra WorkspaceService methods (gitTarget).
  store?: Store; ws?: Workspace; workspaces?: Record<string, unknown>
} = {}) {
  const root = await tempDir('foreman-sessions-')
  const store = options.store ?? new Store(root)
  if (!options.store) {
    await store.load()
    if (!options.saveState) vi.spyOn(store, 'save').mockImplementation(() => {})
  }
  const ws: Workspace = options.ws ?? {
    id: 'ws', repoId: 'repo', name: 'ws', branch: 'b', baseBranch: 'main',
    path: options.dir ?? (await makeRepo()), portBase: 50040, state: 'ready', createdAt: new Date().toISOString()
  }
  if (!store.state.workspaces.includes(ws)) store.state.workspaces.push(ws)
  const workspaces = {
    workspace: () => ws,
    env: () => ({}),
    settingsFor: () => ({ prompts: { general: '' }, sensitivePaths: [] }),
    agentContext: () => '',
    template: options.template ?? ((id?: string) => store.state.settings.promptTemplates.find((t) => t.id === id)),
    ...options.workspaces
  }
  const ended: TurnOutcome[] = []
  const sessions = new SessionService(store, { forAgent: () => ({}) } as never, workspaces as never, {
    changed() {},
    item() {},
    reset() {},
    approval() {},
    approvalResolved() {},
    notify() {},
    turnEnded: (_id, outcome) => void ended.push(outcome),
    ...options.events
  }, undefined, options.mirror, options.turnHost)
  const session = sessions.createSession(ws.id, { agent: 'claude', title: 'chat' })
  return { root, store, ws, sessions, session, ended }
}
