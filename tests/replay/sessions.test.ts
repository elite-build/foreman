// Fixtures through the real SessionService as well as the real driver (docs/agents.md, 9.3): the chat that is stored,
// the approval the window would show, and how the turn ended, for the agents that have recordings.
import { afterEach, describe, expect, it } from 'vitest'
import { readFixture } from '../../src/main/agents/fixtures/format'
import { replayTransport, type ReplayHandle } from '../../src/main/agents/fixtures/replayTransports'
import type { ApprovalRequest, ChatItem } from '../../src/shared/types'
import { waitFor } from '../helpers'
import { setupSessions } from '../sessionHarness'

let handle: ReplayHandle | undefined
afterEach(() => handle?.uninstall())

/** One turn of a chat on `agent`, played from the fixture; the window allows every tool when `allow` is set. */
async function chat(agent: 'claude' | 'codex', scenario: string, allow = false) {
  handle = replayTransport(agent, readFixture(agent, scenario), { speed: 0 })
  const requests: ApprovalRequest[] = []
  let service: Awaited<ReturnType<typeof setupSessions>> | undefined
  service = await setupSessions({
    events: {
      approval: (req) => {
        requests.push(req)
        if (allow) void service!.sessions.respondApproval(req.id, { kind: 'tool', allow: true })
      }
    }
  })
  // As recorded (Ask): Codex's default is to run without asking.
  service.store.state.settings.codexApprovals = 'sandboxed'
  const tab = service.sessions.createSession(service.ws.id, { agent, title: 'chat' })
  await service.sessions.send(tab.id, `Replay the ${scenario} recording`)
  await waitFor(() => expect(service!.ended).toHaveLength(1))
  const items: ChatItem[] = await service.store.readChat(tab.id)
  return { ...service, tab, items, requests, handle }
}

const turnEnd = (items: ChatItem[]) => items.find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end')!

describe.each(['claude', 'codex'] as const)('%s through SessionService', (agent) => {
  it('plain: the answer is in the chat and the turn completed', async () => {
    const { items, ended, handle } = await chat(agent, 'plain')
    expect(items.filter((i) => i.kind === 'assistant').map((i) => (i as { text: string }).text)).toEqual(['ok'])
    expect(turnEnd(items)).toMatchObject({ outcome: 'completed' })
    expect(ended).toHaveLength(1)
    expect(handle.warnings()).toEqual([])
  })

  it('approval: the window is asked, and the answer lets the agent carry on', async () => {
    const { items, requests, sessions, handle } = await chat(agent, 'approval', true)
    expect(requests.length).toBeGreaterThanOrEqual(1)
    expect(requests[0]).toMatchObject({ kind: 'tool' })
    expect(items.some((i) => i.kind === 'tool' && i.status === 'done')).toBe(true)
    expect(turnEnd(items)).toMatchObject({ outcome: 'completed' })
    expect(sessions.pendingApprovals()).toEqual([])
    expect(handle.warnings()).toEqual([])
  })

  it('limit: the turn ends as an error that names the limit', async () => {
    const { items, handle } = await chat(agent, 'limit')
    const end = turnEnd(items)
    expect(end.outcome).toBe('error')
    expect(end.error).toMatch(/limit/i)
    if (agent === 'claude') expect(end.limit?.resetAt).toBeTruthy()
    expect(handle.warnings()).toEqual([])
  })
})
