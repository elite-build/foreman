import { describe, expect, it } from 'vitest'
import { ftsQuery, snippetParts } from '../src/shared/chatIndex'
import type { ChatItem, Session, Workspace } from '../src/shared/types'
import { searchChats } from '../src/main/chatSearch'
import { Store } from '../src/main/store'
import { tempDir } from './helpers'

const ws = (id: string, extra: object = {}) => ({ id, repoId: 'r1', name: `ws-${id}`, state: 'ready', createdAt: '2026-01-01T00:00:00Z', ...extra }) as unknown as Workspace
const tab = (id: string, workspaceId: string, extra: object = {}) =>
  ({ id, workspaceId, title: `tab ${id}`, agent: 'claude', model: 'claude-opus-5-5', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: '2026-01-01T00:00:00Z', ...extra }) as unknown as Session
const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, turnId: `t-${id}`, text, at: '2026-01-01T00:00:00Z' })
const assistant = (id: string, text: string): ChatItem => ({ kind: 'assistant', id, turnId: `t-${id}`, text })
const tool = (id: string, output: string): ChatItem => ({ kind: 'tool', id, turnId: 't1', name: 'Bash', input: { command: 'ls' }, status: 'done', output })

async function rig() {
  const store = new Store(await tempDir('foreman-search-'))
  await store.load()
  store.state.repos.push({ id: 'r1', name: 'repo' } as never)
  store.state.workspaces.push(ws('w1'), ws('w2', { state: 'archived' }))
  store.state.sessions.push(tab('s1', 'w1'), tab('s2', 'w1', { closedAt: '2026-02-01T00:00:00Z' }), tab('s3', 'w2'))
  return store
}

describe('ftsQuery', () => {
  it('quotes words so punctuation is text, and treats the last word as a prefix', () => {
    expect(ftsQuery('fake timers')).toBe('"fake" AND "timers"*')
    expect(ftsQuery('a[0].map() NEAR "x')).toBe('"a[0].map()" AND "NEAR" AND """x"*')
    expect(ftsQuery('   ')).toBeNull()
    expect(ftsQuery('--- ***')).toBeNull()
  })
  it('splits a snippet at its markers', () => {
    expect(snippetParts('use \u0001fake\u0002 timers')).toEqual([
      { text: 'use ', hit: false },
      { text: 'fake', hit: true },
      { text: ' timers', hit: false }
    ])
  })
})

describe('search every chat', () => {
  it('finds user and assistant text in every workspace, archived ones and closed tabs included', async () => {
    const store = await rig()
    await store.appendChat('s1', user('u1', 'How do fake timers work with debounce?'))
    await store.appendChat('s2', assistant('a1', 'Use vi.useFakeTimers for the closed tab'))
    await store.appendChat('s3', user('u2', 'fake timers in the archived workspace'))
    const hits = searchChats(store, 'fake timers')
    expect(hits.map((h) => h.itemId).sort()).toEqual(['u1', 'u2'])
    expect(hits.find((h) => h.itemId === 'u2')).toMatchObject({ archived: true, workspaceName: 'ws-w2', repoName: 'repo', tabTitle: 'tab s3', model: 'claude-opus-5-5', agent: 'claude', closed: false })
    expect(hits[0].snippet).toContain('\u0001')
    // A prefix finds the closed tab's message too.
    const closed = searchChats(store, 'useFake')
    expect(closed).toMatchObject([{ itemId: 'a1', closed: true, sessionId: 's2' }])
    expect(searchChats(store, 'nothing like this')).toEqual([])
    expect(searchChats(store, '')).toEqual([])
    store.close()
  })

  it('searches tool output only when asked', async () => {
    const store = await rig()
    await store.appendChat('s1', tool('tool1', 'ENOENT: no such file xyzzy.txt'))
    await store.appendChat('s1', assistant('a1', 'I could not find the file'))
    expect(searchChats(store, 'xyzzy')).toEqual([])
    expect(searchChats(store, 'xyzzy', { includeToolOutput: true })).toMatchObject([{ itemId: 'tool1', kind: 'tool' }])
    // Message text is found either way.
    expect(searchChats(store, 'could not find')).toHaveLength(1)
    expect(searchChats(store, 'could not find', { includeToolOutput: true })).toHaveLength(1)
    store.close()
  })

  it('follows updates: the last write of an item is what is searched', async () => {
    const store = await rig()
    await store.appendChat('s1', assistant('a1', 'draft about pineapples'))
    await store.appendChat('s1', assistant('a1', 'final about mangoes'))
    expect(searchChats(store, 'pineapples')).toEqual([])
    expect(searchChats(store, 'mangoes')).toHaveLength(1)
    store.close()
  })

  it('drops removed chats and cleared items, unless Keep cleared history is on', async () => {
    const store = await rig()
    await store.appendChat('s1', user('u1', 'remember the walrus'))
    await store.appendChat('s1', assistant('a1', 'the walrus is noted'))
    await store.appendChat('s1', user('u2', 'keep the otter'))
    await store.replaceChat('s1', [user('u2', 'keep the otter')])
    expect(searchChats(store, 'walrus')).toEqual([])
    expect(searchChats(store, 'otter')).toHaveLength(1)

    store.state.settings.keepClearedHistory = true
    await store.appendChat('s3', user('u9', 'badger one'))
    await store.replaceChat('s3', [])
    expect(searchChats(store, 'badger')).toMatchObject([{ itemId: 'u9', cleared: true }])
    store.state.settings.keepClearedHistory = false
    store.keepClearedChanged()
    expect(searchChats(store, 'badger')).toEqual([])

    // A removed tab takes its messages out of the index.
    store.state.sessions = store.state.sessions.filter((s) => s.id !== 's1')
    store.flush()
    expect(searchChats(store, 'otter')).toEqual([])
    store.close()
  })

  it('indexes chats that came from the JSON files, and stays in step after a restart', async () => {
    const dir = await tempDir('foreman-search-')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(`${dir}/sessions`)
    await writeFile(`${dir}/state.json`, JSON.stringify({ version: 1, repos: [], workspaces: [ws('w1')], sessions: [tab('s1', 'w1')], comments: [], settings: {} }))
    await writeFile(`${dir}/sessions/s1.ndjson`, JSON.stringify(user('u1', 'legacy zebra')) + '\n')
    const store = new Store(dir)
    await store.load()
    expect(searchChats(store, 'zebra')).toHaveLength(1)
    store.close()
    const again = new Store(dir)
    await again.load()
    expect(searchChats(again, 'zebra')).toHaveLength(1)
    again.close()
  })
})
