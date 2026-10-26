import { vi } from 'vitest'
import { defaultSettings } from '../src/main/store'
import { ForemanDelegation } from '../src/main/foremanDelegation'
import type { ChatItem, CreateWorkspaceOptions, Repo, Session, TurnStatus, Workspace } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'

export function delegationRig() {
  const repo = { id: 'r', name: 'Project', rootPath: process.cwd(), defaultBranch: 'main' } as Repo
  const ws: Workspace = { id: 'w', repoId: 'r', name: 'Coordinator', branch: 'main', baseBranch: 'main', portBase: 50030, state: 'ready', createdAt: '' }
  const session: Session = { id: 's', workspaceId: 'w', agent: 'claude', model: 'fable', fastMode: false, planMode: false, status: 'running', turnId: 'own', queue: [], createdAt: '' }
  const state = { repos: [repo, { ...repo, id: 'other', name: 'Other' }], workspaces: [ws], sessions: [session], settings: defaultSettings() }
  state.settings.loadouts = [
    { agent: 'claude', model: 'fable', fast: false },
    { agent: 'codex', model: 'astra', fast: false },
    { agent: 'opencode', model: 'implementation', fast: false },
    { agent: 'cursor', model: 'implementation', fast: false }
  ]
  const turns = new Map<string, TurnStatus>([['own', { workspaceId: 'w', sessionId: 's', turnId: 'own', state: 'running' }]])
  const chats = new Map<string, ChatItem[]>()
  const allowed = { value: true }
  let sequence = 0
  const createWorkspace = vi.fn(async (repoId: string, options: CreateWorkspaceOptions) => {
    const id = `task-${++sequence}`
    const child: Workspace = { ...ws, id, repoId, name: id, branch: options.branch?.name ?? id, state: 'setting-up' }
    state.workspaces.push(child)
    const chat: Session = { ...session, id: `${id}-chat`, workspaceId: id, agent: options.loadout!.agent, model: options.loadout!.model, status: 'idle', turnId: undefined, queue: [] }
    state.sessions.push(chat)
    return child
  })
  const deliver = vi.fn(async (sessionId: string, text: string) => {
    const target = state.sessions.find((s) => s.id === sessionId)!
    const turnId = `sent-${++sequence}`
    turns.set(turnId, { workspaceId: target.workspaceId, sessionId, turnId, state: 'queued' })
    return { disposition: 'queued' as const, turnId }
  })
  const cancelTurn = vi.fn(async (id: string) => {
    const turn = turns.get(id)!
    const ended = { ...turn, state: 'ended' as const, outcome: 'cancelled' as const }
    turns.set(id, ended)
    return ended
  })
  const getChat = vi.fn(async (id: string) => chats.get(id) ?? [])
  const setupOutcome = vi.fn(async () => ({ failed: false, held: false, logTail: '' }))
  const host = stubHost({ state: () => state, api: fakeApi({ getChat }), createWorkspace, deliver, cancelTurn, setupOutcome,
    agentsMayStart: () => allowed.value, turnStatus: async (id) => turns.get(id) ?? null })
  const service = new ForemanDelegation(host)
  const scope = { workspaceId: 'w', sessionId: 's', readOnly: false }
  return { service, scope, state, session, ws, host, allowed, turns, chats, createWorkspace, deliver, cancelTurn, getChat, setupOutcome }
}
