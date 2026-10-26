// G2 backlog: O5's Commits tab badge and cached attribution, and #15's "changed by Tab n" on held selections.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CommitAttribution } from '../src/main/commitAttribution'
import { DiffSelectionService } from '../src/main/diffSelections'
import { branchCommitCount } from '../src/main/diffSources'
import { git } from '../src/main/git'
import { editorsSince, sameFile } from '../src/shared/diffSelection'
import type { ChatItem, DiffComment, DiffSelection, Session, Workspace } from '../src/shared/types'
import { commit, makeRepo } from './helpers'

const tool = (turnId: string, input: unknown, output = '', status: 'done' | 'error' | 'running' = 'done'): ChatItem => ({ kind: 'tool', id: `${turnId}-${Math.random()}`, turnId, name: 'Edit', input, status, output })
const user = (turnId: string, at: string): ChatItem => ({ kind: 'user', id: `u-${turnId}`, turnId, text: 'go', at })
const end = (turnId: string, durationMs: number, files: string[] = []): ChatItem =>
  ({ kind: 'turn-end', id: `e-${turnId}`, turnId, outcome: 'completed', durationMs, ...(files.length ? { delta: { files: files.map((p) => ({ path: p, additions: 1, deletions: 0 })), additions: 1, deletions: 0 } } : {}) }) as ChatItem

describe('the Commits tab’s count', () => {
  it('counts the branch’s own commits since the merge base', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' })
    await git(dir, ['checkout', '-q', '-b', 'feature'])
    const ws = { path: dir, baseBranch: 'main', branch: 'feature' } as Workspace
    expect(await branchCommitCount(ws)).toEqual({ count: 0, more: false })
    for (const n of [1, 2, 3]) {
      await writeFile(path.join(dir, `f${n}.txt`), `${n}\n`)
      await git(dir, ['add', '-A'])
      await commit(dir, `c${n}`)
    }
    expect(await branchCommitCount(ws)).toEqual({ count: 3, more: false })
  })
})

describe('commit attribution, cached', () => {
  const tab = (id: string, patch: Partial<Session> = {}) => ({ id, status: 'idle', lastActivityAt: '2026-10-22T10:00:00Z', ...patch }) as Session
  const madeBy = (sha: string) => tool('t1', { command: 'git commit -m x' }, `[feature ${sha.slice(0, 7)}] x\n 1 file changed`)

  it('reads each chat once until it changes, and remembers named commits', async () => {
    const chats: Record<string, ChatItem[]> = { s1: [madeBy('abc1234def')], s2: [] }
    const reader = vi.fn(async (id: string) => chats[id] ?? [])
    const cache = new CommitAttribution(reader)
    const tabs = [tab('s1'), tab('s2')]
    expect([...(await cache.attribute('w', tabs, ['abc1234def', 'fff0000aaa']))]).toEqual([['abc1234def', 's1']])
    expect(reader).toHaveBeenCalledTimes(2)
    // Same chats, same versions: nothing is read again for the unknown commit.
    await cache.attribute('w', tabs, ['abc1234def', 'fff0000aaa'])
    expect(reader).toHaveBeenCalledTimes(2)
    // Only named commits asked for: no chat is read at all.
    await cache.attribute('w', [tab('s1', { lastActivityAt: 'later' }), tabs[1]], ['abc1234def'])
    expect(reader).toHaveBeenCalledTimes(2)
    // s2 moved on and made the other commit.
    chats.s2 = [madeBy('fff0000aaa')]
    const next = await cache.attribute('w', [tabs[0], tab('s2', { lastActivityAt: '2026-10-22T11:00:00Z' })], ['abc1234def', 'fff0000aaa'])
    expect(next.get('fff0000aaa')).toBe('s2')
    expect(next.get('abc1234def')).toBe('s1')
    expect(reader).toHaveBeenCalledTimes(3)
  })

  it('always reads a running tab again, and still names nobody when two tabs claim a commit', async () => {
    const reader = vi.fn(async () => [madeBy('abc1234def')])
    const cache = new CommitAttribution(reader)
    const running = [tab('s1', { status: 'running' }), tab('s2', { status: 'running' })]
    expect((await cache.attribute('w', running, ['abc1234def'])).size).toBe(0)
    await cache.attribute('w', running, ['abc1234def'])
    expect(reader).toHaveBeenCalledTimes(4)
  })

  it('forgets a workspace, and a named tab that is gone is looked for again', async () => {
    const reader = vi.fn(async () => [madeBy('abc1234def')])
    const cache = new CommitAttribution(reader)
    await cache.attribute('w', [tab('s1')], ['abc1234def'])
    expect((await cache.attribute('w', [tab('s9')], ['abc1234def'])).get('abc1234def')).toBe('s9')
    cache.forget('w', ['s1', 's9'])
    await cache.attribute('w', [tab('s1')], ['abc1234def'])
    expect(reader).toHaveBeenCalledTimes(3)
  })
})

describe('which tab changed selected lines', () => {
  const SEL = '2026-10-22T14:00:00Z'
  it('names tabs whose turns since the selection edited the file, by tool call or checkpoint', () => {
    const chats = [
      // Edited a.txt before the selection: doesn't count.
      { sessionId: 'old', items: [user('t1', '2026-10-22T13:00:00Z'), tool('t1', { file_path: '/repo/a.txt' }), end('t1', 60_000)] },
      // Edited it after.
      { sessionId: 'tab2', items: [user('t2', '2026-10-22T14:01:00Z'), tool('t2', { file_path: 'C:\\repo\\a.txt' }), end('t2', 1000)] },
      // A turn that started before but ended after the selection, seen only in its checkpoint delta.
      { sessionId: 'tab3', items: [user('t3', '2026-10-22T13:59:00Z'), end('t3', 5 * 60_000, ['a.txt'])] },
      // Still running.
      { sessionId: 'tab4', items: [user('t4', '2026-10-22T14:02:00Z'), tool('t4', { path: 'a.txt' })] },
      // Another file, a failed edit, and an edit of a file with a similar name.
      { sessionId: 'tab5', items: [user('t5', '2026-10-22T14:02:00Z'), tool('t5', { file_path: 'b.txt' }), tool('t5', { file_path: 'a.txt' }, '', 'error'), tool('t5', { file_path: 'xa.txt' }), end('t5', 10)] }
    ]
    expect(editorsSince('a.txt', SEL, chats)).toEqual(['tab2', 'tab3', 'tab4'])
    expect(editorsSince('a.txt', SEL, [])).toEqual([])
  })

  it('compares paths as the worktree has them', () => {
    expect(sameFile('src/a.ts', 'src/a.ts')).toBe(true)
    expect(sameFile('./src/a.ts', 'src/a.ts')).toBe(true)
    expect(sameFile('/home/me/ws/src/a.ts', 'src/a.ts')).toBe(true)
    expect(sameFile('C:\\ws\\src\\a.ts', 'src/a.ts')).toBe(true)
    expect(sameFile('/ws/xsrc/a.ts', 'src/a.ts')).toBe(false)
  })

  it('a held selection says who changed its lines, or that nobody Foreman saw did', async () => {
    const fileText = (edit: Record<number, string> = {}) => Array.from({ length: 6 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'
    const dir = await makeRepo({ 'a.txt': fileText() })
    await git(dir, ['checkout', '-q', '-b', 'feature'])
    const ws = { id: 'w1', path: dir, baseBranch: 'main', branch: 'feature' } as Workspace
    const comments: DiffComment[] = []
    const sessions = [{ id: 't1', workspaceId: 'w1', status: 'idle', queue: [] }, { id: 't2', workspaceId: 'w1', status: 'idle', queue: [] }] as unknown as Session[]
    const chats: Record<string, ChatItem[]> = { t1: [], t2: [user('x', '2026-10-22T14:07:00Z'), tool('x', { file_path: path.join(dir, 'a.txt') }), end('x', 1000)] }
    const service = new DiffSelectionService({
      comments: () => comments,
      sessions: () => sessions,
      workspace: () => ws,
      send: async () => 'started',
      createSession: () => sessions[0],
      readChat: async (id) => chats[id] ?? [],
      changed: () => undefined,
      now: () => new Date('2026-10-22T14:09:00Z')
    })
    const selection: DiffSelection = { action: 'ask', side: 'new', start: 2, end: 2, lines: ['line 2'], scope: 'all', at: '2026-10-22T14:06:00Z' }
    await writeFile(path.join(dir, 'a.txt'), fileText({ 2: 'EDITED' }))
    expect((await service.send('w1', { file: 'a.txt', body: 'Ask: why?', selection }, 't1')).status).toBe('held')
    expect(comments[0].stale).toMatchObject({ lines: ['EDITED'], changedBy: ['t2'] })
    // Nobody's turn touched it: empty, so the review says who isn't known.
    chats.t2 = []
    await service.send('w1', { file: 'a.txt', body: 'Ask: and?', selection }, 't1')
    expect(comments[1].stale?.changedBy).toEqual([])
    // The old side isn't attributed (it changes when the base moves).
    await service.send('w1', { file: 'a.txt', body: 'Ask: old?', selection: { ...selection, side: 'old', lines: ['nope'] } }, 't1')
    expect(comments[2].stale).toBeDefined()
    expect(comments[2].stale).not.toHaveProperty('changedBy')
  })
})
