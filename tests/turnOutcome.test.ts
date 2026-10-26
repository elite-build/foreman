import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerDriver } from '../src/main/agents/registry'
import { claudeDriver } from '../src/main/agents/claude'
import type { AgentDriver, TurnCallbacks, TurnRequest, TurnResult } from '../src/main/agents/types'
import { SessionService } from '../src/main/sessions'
import { Store } from '../src/main/store'
import type { ChatItem, Session, TurnOutcome, Workspace } from '../src/shared/types'
import { makeRepo, tempDir, waitFor } from './helpers'
import { wsPath } from '../src/shared/workspacePath'

afterEach(() => registerDriver(claudeDriver))

type Script = (req: TurnRequest, cb: TurnCallbacks, signal: AbortSignal) => Promise<void>

/** A Claude stand-in whose turn runs the given script. */
function fakeDriver(script: Script, onStop?: () => void): AgentDriver {
  return {
    ...claudeDriver,
    createTurn: (req, cb) => {
      const abort = new AbortController()
      return {
        run: () => script(req, cb, abort.signal),
        stop: async () => {
          onStop?.()
          abort.abort()
        },
        steer: () => false,
        setPlanMode: async () => {},
        setModel: async () => {}
      }
    }
  }
}

async function setup(dir?: string) {
  const root = await tempDir('foreman-outcome-')
  const store = new Store(root)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const ws: Workspace = {
    id: 'ws', repoId: 'repo', name: 'ws', branch: 'b', baseBranch: 'main',
    path: dir ?? (await makeRepo()), portBase: 50040, state: 'ready', createdAt: new Date().toISOString()
  }
  const workspaces = {
    workspace: () => ws,
    env: () => ({}),
    settingsFor: () => ({ prompts: { general: '' } }),
    agentContext: () => ''
  }
  const ended: TurnOutcome[] = []
  const sessions = new SessionService(store, { forAgent: () => ({}) } as never, workspaces as never, {
    changed() {},
    item() {},
    reset() {},
    approval() {},
    approvalResolved() {},
    notify() {},
    turnEnded: (_id, outcome) => void ended.push(outcome)
  })
  const session = sessions.createSession(ws.id, { agent: 'claude', title: 'chat' })
  const turnEnd = async () => {
    let item: Extract<ChatItem, { kind: 'turn-end' }> | undefined
    await waitFor(async () => {
      item = (await store.readChat(session.id)).find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end')
      expect(item).toBeDefined()
    })
    return item!
  }
  return { store, ws, sessions, session, ended, turnEnd }
}

const finishWith = (result: TurnResult): Script => async (_req, cb) => cb.finished(result)

describe('turn outcome', () => {
  it('records a completed turn, with what it changed', async () => {
    const { sessions, session, ended, turnEnd, ws } = await setup()
    registerDriver(
      fakeDriver(async (_req, cb) => {
        await writeFile(path.join(wsPath(ws), 'new.txt'), 'a\nb\n')
        cb.finished({ ok: true })
      })
    )
    await sessions.send(session.id, 'go')
    const item = await turnEnd()
    expect(item).toMatchObject({ outcome: 'completed', delta: { additions: 2, deletions: 0, files: [{ path: 'new.txt', additions: 2, deletions: 0 }] } })
    expect(item.error).toBeUndefined()
    expect(typeof item.durationMs).toBe('number')
    expect(session.status).toBe('idle')
    expect(session.turnId).toBeUndefined()
    expect(ended).toEqual(['completed'])
  })

  it('calling finished() after a failure is an error, with its cause', async () => {
    const { sessions, session, turnEnd } = await setup()
    registerDriver(fakeDriver(finishWith({ ok: false, error: 'turn.failed: quota exceeded' })))
    await sessions.send(session.id, 'go')
    expect(await turnEnd()).toMatchObject({ outcome: 'error', error: 'turn.failed: quota exceeded' })
  })

  it('a turn that never reports a result is an error', async () => {
    const { sessions, session, turnEnd } = await setup()
    registerDriver(fakeDriver(async () => {}))
    await sessions.send(session.id, 'go')
    expect(await turnEnd()).toMatchObject({ outcome: 'error', error: expect.stringContaining('without reporting a result') })
  })

  it('a turn that throws is an error, and does not break the queue', async () => {
    const { sessions, session, turnEnd } = await setup()
    registerDriver(
      fakeDriver(async () => {
        throw new Error('boom')
      })
    )
    await sessions.send(session.id, 'go')
    expect(await turnEnd()).toMatchObject({ outcome: 'error', error: 'boom' })
  })

  it('records a stopped turn as cancelled, even if the agent reports an error', async () => {
    const { sessions, session, turnEnd } = await setup()
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    registerDriver(
      fakeDriver(async (_req, cb, signal) => {
        started()
        await new Promise((resolve) => signal.addEventListener('abort', resolve))
        cb.finished({ ok: false, error: 'aborted' })
      })
    )
    await sessions.send(session.id, 'go')
    await running
    await sessions.cancel(session.id)
    expect(await turnEnd()).toMatchObject({ outcome: 'cancelled' })
  })

  it('ends the turn when the agent cannot be created', async () => {
    const { sessions, session, turnEnd, ended } = await setup()
    registerDriver({
      ...claudeDriver,
      createTurn: () => {
        throw new Error('Codex support is not available yet')
      }
    })
    await sessions.send(session.id, 'go')
    expect(await turnEnd()).toMatchObject({ outcome: 'error', error: 'Codex support is not available yet' })
    expect(session.status).toBe('idle')
    expect(ended).toEqual(['error'])
  })

  it('still ends the turn when the workspace is not a git repository', async () => {
    const { sessions, session, turnEnd } = await setup(await tempDir())
    registerDriver(fakeDriver(finishWith({ ok: true })))
    await sessions.send(session.id, 'go')
    const item = await turnEnd()
    expect(item.outcome).toBe('completed')
    // No checkpoints, so no per-turn figures rather than "nothing changed".
    expect(item.delta).toBeUndefined()
  })
})

describe('restart', () => {
  it('marks a turn that was running as interrupted, once', async () => {
    const root = await tempDir('foreman-restart-')
    const first = new Store(root)
    await first.load()
    const session = { id: 's1', workspaceId: 'ws', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'running', turnId: 't9', turnStartedAt: '2026-01-01T00:00:00Z', queue: [], createdAt: '2026-01-01T00:00:00Z' } as Session
    first.state.sessions.push(session)
    first.state.settings.loadouts = first.state.settings.loadouts ?? []
    first.flush()
    await first.appendChat('s1', { kind: 'user', id: 'user:t9', turnId: 't9', text: 'hi', at: '2026-01-01T00:00:00Z' })

    for (let i = 0; i < 2; i++) {
      const store = new Store(root)
      await store.load()
      expect(store.state.sessions[0]).toMatchObject({ status: 'idle', turnId: undefined })
      const items = await store.readChat('s1')
      expect(items.filter((x) => x.kind === 'turn-end')).toMatchObject([{ id: 'turn-end:t9', turnId: 't9', outcome: 'interrupted' }])
      store.flush()
    }
  })

  it('does not interrupt a session that was idle', async () => {
    const root = await tempDir('foreman-restart-')
    const first = new Store(root)
    await first.load()
    first.state.sessions.push({ id: 's2', workspaceId: 'ws', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: 'x' } as Session)
    first.flush()
    const store = new Store(root)
    await store.load()
    expect(await store.readChat('s2')).toEqual([])
  })
})
