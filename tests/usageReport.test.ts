import { describe, expect, it } from 'vitest'
import { costText, usageReport, type UsageRow, type UsageSession, type UsageWorkspace } from '../src/shared/usageReport'
import { DataService } from '../src/main/dataService'
import type { ChatItem, Session, Workspace } from '../src/shared/types'
import { Store } from '../src/main/store'
import { tempDir } from './helpers'

const NOW = new Date('2026-06-30T12:00:00Z')
const day = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString()

const sessions: UsageSession[] = [
  { id: 's1', workspaceId: 'w1', agent: 'claude', model: 'opus', createdAt: day(20) },
  { id: 's2', workspaceId: 'w1', agent: 'codex', model: 'gpt', createdAt: day(19) },
  { id: 's3', workspaceId: 'w2', agent: 'claude', model: 'opus', createdAt: day(10) },
  { id: 'fork', workspaceId: 'w1', agent: 'claude', model: 'opus', createdAt: day(5) },
  { id: 'copy', workspaceId: 'w3', agent: 'claude', model: 'opus', createdAt: day(1) }
]
const workspaces: UsageWorkspace[] = [
  { id: 'w1', repoId: 'rA', imported: false, createdAt: day(20) },
  { id: 'w2', repoId: 'rB', imported: false, createdAt: day(10) },
  { id: 'w3', repoId: 'rA', imported: true, createdAt: day(1) }
]
const turn = (sessionId: string, turnId: string, ago: number, o: { cost?: number; ms?: number; ended?: boolean } = {}): UsageRow[] => [
  { sessionId, turnId, kind: 'user', at: day(ago) },
  ...(o.ended === false ? [] : [{ sessionId, turnId, kind: 'result' as const, at: day(ago), costUsd: o.cost, durationMs: o.ms }, { sessionId, turnId, kind: 'turn-end' as const, at: day(ago), durationMs: o.ms }])
]
const report = (rows: UsageRow[], days = 30) => usageReport({ rows, sessions, workspaces, days, now: NOW })

describe('usage report', () => {
  it('sums cost, turns and time by repo and model', () => {
    const r = report([...turn('s1', 't1', 2, { cost: 1.5, ms: 60_000 }), ...turn('s1', 't2', 3, { cost: 0.5, ms: 30_000 }), ...turn('s3', 't3', 4, { cost: 2, ms: 10_000 })])
    expect(r.total).toMatchObject({ turns: 3, agentMs: 100_000, costUsd: 4, partial: false })
    expect(r.total.workspaceIds.sort()).toEqual(['w1', 'w2'])
    expect(r.byRepo.map((x) => [x.repoId, x.costUsd, x.turns])).toEqual([
      ['rA', 2, 2],
      ['rB', 2, 1]
    ])
    expect(r.byModel).toMatchObject([{ agent: 'claude', model: 'opus', turns: 3, costUsd: 4 }])
  })

  it('keeps unknown cost unknown, and marks a total that leaves any out as partial', () => {
    const r = report([...turn('s1', 't1', 2, { cost: 1, ms: 1000 }), ...turn('s2', 't2', 2, { ms: 5000 })])
    expect(r.total).toMatchObject({ turns: 2, costUsd: 1, partial: true, costKnownTurns: 1, costUnknownTurns: 1 })
    expect(costText(r.total)).toBe('$1.00+')
    const gpt = r.byModel.find((m) => m.agent === 'codex')!
    expect(gpt).toMatchObject({ turns: 1, agentMs: 5000, costUsd: null, partial: true })
    expect(costText(gpt)).toBeNull()
    // Unknown cost groups sort after those with a cost.
    expect(r.byModel.map((m) => m.agent)).toEqual(['claude', 'codex'])
    expect(costText({ costUsd: 3, partial: false })).toBe('$3.00')
  })

  it('counts a forked or imported copy of a turn once, crediting the original', () => {
    const rows = [
      ...turn('s1', 't1', 6, { cost: 1, ms: 1000 }),
      // The fork carries its parent's turn and adds one of its own.
      ...turn('fork', 't1', 6, { cost: 1, ms: 1000 }),
      ...turn('fork', 't2', 2, { cost: 2, ms: 2000 }),
      // An imported copy of the parent's chat on this machine.
      ...turn('copy', 't1', 6, { cost: 1, ms: 1000 })
    ]
    const r = report(rows)
    expect(r.total).toMatchObject({ turns: 2, costUsd: 3, agentMs: 3000 })
    expect(r.total.workspaceIds).toEqual(['w1'])
    // A copy that reported a cost fills in for an original that did not.
    expect(report([...turn('s1', 'x', 2, { ms: 10 }), ...turn('copy', 'x', 2, { cost: 0.25, ms: 10 })]).total).toMatchObject({ turns: 1, costUsd: 0.25, partial: false })
  })

  it('counts a turn from an imported chat when the original is not here', () => {
    const r = report(turn('copy', 'only', 1, { cost: 1, ms: 5 }))
    expect(r.total).toMatchObject({ turns: 1, costUsd: 1 })
    expect(r.total.workspaceIds).toEqual(['w3'])
  })

  it('limits to the range by when the turn started, and ignores unfinished turns and removed chats', () => {
    const rows = [...turn('s1', 'old', 40, { cost: 9 }), ...turn('s1', 'new', 6, { cost: 1 }), ...turn('s1', 'running', 1, { ended: false }), ...turn('gone', 'g', 1, { cost: 5 })]
    expect(report(rows, 30).total).toMatchObject({ turns: 1, costUsd: 1 })
    expect(report(rows, 7).total.turns).toBe(1)
    expect(report(rows, 90).total).toMatchObject({ turns: 2, costUsd: 10 })
    expect(report([], 30).total).toMatchObject({ turns: 0, costUsd: null, partial: false })
  })
})

describe('usage from the database', () => {
  const ws = (id: string, extra: object = {}) => ({ id, repoId: 'r1', name: id, state: 'ready', createdAt: day(30), ...extra }) as unknown as Workspace
  const tab = (id: string, workspaceId: string) => ({ id, workspaceId, agent: 'claude', model: 'opus', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: day(30) }) as unknown as Session
  const user = (id: string, turnId: string, at: string): ChatItem => ({ kind: 'user', id, turnId, text: 'secret words', at })
  const result = (id: string, turnId: string, costUsd?: number): ChatItem => ({ kind: 'result', id, turnId, ok: true, costUsd, durationMs: 1000 })

  it('still counts turns after /clear when only receipts are kept', async () => {
    const store = new Store(await tempDir('foreman-usage-'))
    await store.load()
    store.state.workspaces.push(ws('w1'))
    store.state.sessions.push(tab('s1', 'w1'))
    for (const i of [user('u1', 't1', day(3)), result('r1', 't1', 0.4), user('u2', 't2', day(2)), result('r2', 't2')]) await store.appendChat('s1', i)
    const data = new DataService(store, () => NOW)
    expect(data.usage(30).total).toMatchObject({ turns: 2, costUsd: 0.4, partial: true })
    await store.replaceChat('s1', [])
    expect(await store.readChat('s1')).toEqual([])
    expect(data.usage(30).total).toMatchObject({ turns: 2, costUsd: 0.4, partial: true })
    expect(JSON.stringify(store.db.db.prepare('SELECT * FROM items').all())).not.toContain('secret')
    expect(data.usage(7).byModel).toMatchObject([{ agent: 'claude', model: 'opus', turns: 2 }])
    store.close()
  })

  it('dates migrated turns by their user message, not by when the migration ran', async () => {
    const dir = await tempDir('foreman-usage-')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(`${dir}/sessions`)
    await writeFile(`${dir}/state.json`, JSON.stringify({ version: 1, repos: [], workspaces: [ws('w1')], sessions: [tab('s1', 'w1')], comments: [], settings: {} }))
    const lines = [user('u1', 'old', day(200)), result('r1', 'old', 7), user('u2', 'recent', day(1)), result('r2', 'recent', 1)]
    await writeFile(`${dir}/sessions/s1.ndjson`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const store = new Store(dir)
    await store.load()
    const data = new DataService(store, () => NOW)
    expect(data.usage(30).total).toMatchObject({ turns: 1, costUsd: 1 })
    expect(data.usage(90).total.turns).toBe(1)
    store.close()
  })
})
