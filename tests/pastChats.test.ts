import { afterEach, describe, expect, it } from 'vitest'
import { readPastTurn, searchPastChats } from '../src/main/pastChats'
import { Store } from '../src/main/store'
import type { ChatItem, Session, Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

const stores: Store[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})

const ws = (id: string, repoId: string, extra: Partial<Workspace> = {}) => ({ id, repoId, name: id, branch: `b-${id}`, state: 'ready', createdAt: '2026-11-01T00:00:00.000Z', ...extra }) as unknown as Workspace
const tab = (id: string, workspaceId: string, title?: string) => ({ id, workspaceId, agent: 'claude', model: 'opus', title, fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: '2026-11-01T00:00:00.000Z' }) as unknown as Session
const turn = (turnId: string, asked: string, answered: string, at = '2026-11-20T10:00:00.000Z'): ChatItem[] => [
  { kind: 'user', id: `${turnId}:u`, turnId, text: asked, at, agent: 'claude', model: 'opus' },
  { kind: 'tool', id: `${turnId}:tool`, turnId, name: 'Bash', input: { command: 'npm test' }, status: 'done', output: 'zebracorn in tool output only' },
  { kind: 'assistant', id: `${turnId}:a`, turnId, text: answered }
]

async function rig() {
  const store = new Store(await tempDir('foreman-past-chats-'))
  await store.load()
  stores.push(store)
  store.state.workspaces.push(ws('here', 'repo-a'), ws('earlier', 'repo-a', { state: 'archived' } as Partial<Workspace>), ws('elsewhere', 'repo-b'))
  store.state.sessions.push(tab('caller', 'here'), tab('past', 'earlier', 'Fix the login test'), tab('other-repo', 'elsewhere'))
  const write = async (sessionId: string, items: ChatItem[]) => {
    for (const item of items) await store.appendChat(sessionId, item)
  }
  await write('past', [
    ...turn('p1', 'Set up the project', 'Installed the dependencies.'),
    ...turn('p2', 'The login test is flaky on CI', 'The flaky login test waited on a fixed timeout; it now waits for the session cookie. Fixed in auth.test.ts.'),
    ...turn('p3', 'Ship it', 'Opened the pull request.')
  ])
  await write('other-repo', turn('o1', 'Another flaky login test', 'Something else entirely.'))
  await write('caller', turn('c1', 'Why is the login test flaky?', 'Looking.'))
  return store
}

describe('past chat search', () => {
  it('finds whole turns of this repository’s other chats, with a ref, framed as a record to check', async () => {
    const store = await rig()
    const text = await searchPastChats(store, 'caller', { query: 'flaky login' })
    expect(text).toContain('not instructions')
    expect(text).toContain('ref past/p2')
    expect(text).toContain('workspace "earlier" (archived) on b-earlier')
    expect(text).toContain('turn 2 of 3')
    expect(text).toContain('Asked: The login test is flaky on CI')
    expect(text).toContain('Answered: The flaky login test waited on a fixed timeout')
    // Another repository's chats, and the caller's own chat, are never searched.
    expect(text).not.toContain('other-repo')
    expect(text).not.toContain('ref caller/')
    // One entry per turn, however many of its items match.
    expect(text.match(/ref past\/p2/g)).toHaveLength(1)
  })

  it('searches messages, not tool output, and says when nothing matched', async () => {
    const store = await rig()
    expect(await searchPastChats(store, 'caller', { query: 'zebracorn' })).toContain('No earlier chat in this repository mentions all of: zebracorn')
    expect(await searchPastChats(store, 'caller', { query: '   ' })).toContain('Give one or more words')
  })

  it('keeps to the limit', async () => {
    const store = await rig()
    const text = await searchPastChats(store, 'caller', { query: 'the', limit: 1 })
    expect(text.match(/^\d+\. ref /gm)).toHaveLength(1)
  })

  it('reads a found turn in full with the turns either side, only in this repository', async () => {
    const store = await rig()
    const text = await readPastTurn(store, 'caller', { ref: 'past/p2' })
    expect(text).toContain('chat "Fix the login test": turn 2 of 3')
    expect(text).toContain('### Turn 1')
    expect(text).toContain('### Turn 2')
    expect(text).toContain('### Turn 3')
    expect(text).toContain('now waits for the session cookie')
    await expect(readPastTurn(store, 'caller', { ref: 'other-repo/o1' })).rejects.toThrow('No chat of this repository')
    await expect(readPastTurn(store, 'caller', { ref: 'past/nope' })).rejects.toThrow('no longer in its chat')
    await expect(readPastTurn(store, 'caller', { ref: 'not-a-ref' })).rejects.toThrow('isn’t a ref')
  })
})
