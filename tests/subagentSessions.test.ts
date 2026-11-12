// Subagents as first-class, in the session service (docs/agents.md 6): an approval or question from a subagent says so on its
// way to the window, the phone and the CLI, and Stop on one subagent reaches the running turn without ending it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import type { AgentDriver, TurnCallbacks } from '../src/main/agents/types'
import { askText } from '../src/main/cli/approvals'
import type { ApprovalRequest } from '../src/shared/types'
import { setupSessions } from './sessionHarness'

afterEach(() => registerDriver(claudeDriver))

const until = (check: () => void) => vi.waitFor(check, { timeout: 20_000, interval: 20 })

/** A Claude stand-in whose turn runs `script` and can stop one subagent. */
function subagentDriver(script: (cb: TurnCallbacks, signal: AbortSignal) => Promise<void>, stopChild: (id: string) => Promise<void>): AgentDriver {
  return {
    ...claudeDriver,
    createTurn: (_req, cb) => {
      const abort = new AbortController()
      return {
        run: () => script(cb, abort.signal),
        stop: async () => abort.abort(),
        steer: () => false,
        setPlanMode: async () => {},
        setModel: async () => {},
        stopChild
      }
    }
  }
}

const gateScript = () => {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  return { release, released }
}

describe('a subagent’s approvals and questions', () => {
  it('carry the subagent to the window, the pending list and the CLI’s line', async () => {
    const gate = gateScript()
    registerDriver(
      subagentDriver(
        async (cb, signal) => {
          void cb.approveTool({ kind: 'tool', toolName: 'Bash', input: { command: 'npm test' }, subagent: { id: 'task-1', name: 'explore-tests' } }, signal)
          void cb.ask([{ question: 'Which?', options: [{ label: 'A' }] }], signal, { id: 'task-1', name: 'explore-tests' })
          await gate.released
          cb.finished({ ok: true })
        },
        async () => {}
      )
    )
    const shown: ApprovalRequest[] = []
    const { sessions, session } = await setupSessions({ events: { approval: (a) => void shown.push(a) } })
    await sessions.send(session.id, 'go')
    await until(() => expect(shown).toHaveLength(2))
    expect(shown[0]).toMatchObject({ kind: 'tool', toolName: 'Bash', subagent: { id: 'task-1', name: 'explore-tests' } })
    expect(shown[1]).toMatchObject({ kind: 'question', subagent: { id: 'task-1', name: 'explore-tests' } })
    expect(sessions.pendingApprovals().map((a) => ('subagent' in a ? a.subagent?.name : undefined))).toEqual(['explore-tests', 'explore-tests'])
    // The same request still answers the way every approval does.
    await sessions.respondApproval(shown[0].id, { kind: 'tool', allow: true })
    expect(sessions.pendingApprovals()).toHaveLength(1)
    expect(askText(shown[0])).toBe('From subagent explore-tests: Bash: npm test')
    expect(askText({ ...shown[0], subagent: { id: 'x', name: '' } } as ApprovalRequest)).toMatch(/^From a subagent: /)
    gate.release()
    await sessions.cancel(session.id)
  })

  it('leave an ordinary approval alone', async () => {
    const gate = gateScript()
    registerDriver(
      subagentDriver(
        async (cb, signal) => {
          void cb.approveTool({ kind: 'tool', toolName: 'Bash', input: { command: 'ls' } }, signal)
          await gate.released
          cb.finished({ ok: true })
        },
        async () => {}
      )
    )
    const shown: ApprovalRequest[] = []
    const { sessions, session } = await setupSessions({ events: { approval: (a) => void shown.push(a) } })
    await sessions.send(session.id, 'go')
    await until(() => expect(shown).toHaveLength(1))
    expect(shown[0]).not.toHaveProperty('subagent')
    expect(askText(shown[0])).toBe('Bash: ls')
    gate.release()
    await sessions.cancel(session.id)
  })
})

describe('stopping one subagent', () => {
  it('reaches the running turn, which carries on', async () => {
    const gate = gateScript()
    const stopChild = vi.fn(async () => {})
    registerDriver(
      subagentDriver(async (cb) => {
        await gate.released
        cb.finished({ ok: true })
      }, stopChild)
    )
    const { sessions, session } = await setupSessions()
    await sessions.send(session.id, 'go')
    await until(() => expect(session.status).toBe('running'))
    await sessions.stopChild(session.id, 'task-1')
    expect(stopChild).toHaveBeenCalledWith('task-1')
    // The turn is still the running one.
    expect(session.status).toBe('running')
    gate.release()
    await until(() => expect(session.status).toBe('idle'))
  })

  it('says so when nothing runs, when the agent can’t stop one, and passes on what the turn refuses', async () => {
    const { sessions, session } = await setupSessions()
    await expect(sessions.stopChild(session.id, 'task-1')).rejects.toThrow('No subagent is running')
    const gate = gateScript()
    registerDriver(
      subagentDriver(
        async (cb) => {
          await gate.released
          cb.finished({ ok: true })
        },
        async () => {
          throw new Error('That subagent is not running')
        }
      )
    )
    await sessions.send(session.id, 'go')
    await until(() => expect(session.status).toBe('running'))
    await expect(sessions.stopChild(session.id, 'gone')).rejects.toThrow('not running')
    gate.release()
    await until(() => expect(session.status).toBe('idle'))
    // Codex's record doesn't offer it: refused before the turn is asked.
    const codex = sessions.createSession(session.workspaceId, { agent: 'codex', title: 'codex' })
    await expect(sessions.stopChild(codex.id, 'task-1')).rejects.toThrow('can’t stop a subagent')
  })
})
