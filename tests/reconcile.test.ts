// Structural sharing for the state snapshot: what didn't change keeps its object, what changed is new, and the walk
// stays cheap for a snapshot with many workspaces, sessions and comments.
import { describe, expect, it } from 'vitest'
import { shareUnchanged } from '../src/shared/reconcile'

const copy = <T>(value: T): T => structuredClone(value)

function snapshot(workspaces = 20, comments = 2000) {
  return {
    platform: 'win32',
    settings: { language: 'en', zoom: 1, loadouts: [{ id: 'l1', name: 'Fast' }], agentPrefs: { claude: { model: 'm' } } },
    repos: [{ id: 'r1', name: 'repo', rootPath: '/r' }],
    workspaces: Array.from({ length: workspaces }, (_, i) => ({ id: `w${i}`, repoId: 'r1', name: `ws${i}`, state: 'ready', diffStat: { added: i, removed: 0 }, checks: { results: [{ name: 'test', status: 'passed' }] } })),
    sessions: Array.from({ length: workspaces }, (_, i) => ({ id: `s${i}`, workspaceId: `w${i}`, status: 'idle', queue: [] as string[], usage: { input: 10, output: 20 } })),
    comments: Array.from({ length: comments }, (_, i) => ({ id: `c${i}`, workspaceId: `w${i % workspaces}`, file: `src/f${i}.ts`, line: i, body: `Comment ${i} `.repeat(8), resolved: false })),
    recentRepos: ['/a', '/b'],
    stopRecord: undefined as undefined | { stops: unknown[] }
  }
}

describe('shareUnchanged', () => {
  it('returns the previous object when the two are deeply equal', () => {
    const prev = snapshot()
    expect(shareUnchanged(prev, copy(prev))).toBe(prev)
  })

  it('keeps unchanged entities and sub-objects, and gives changed ones (and their parents) new objects', () => {
    const prev = snapshot()
    const next = copy(prev)
    next.sessions[3].status = 'running'
    const out = shareUnchanged(prev, next)
    expect(out).not.toBe(prev)
    expect(out).toEqual(next)
    expect(out.sessions).not.toBe(prev.sessions)
    expect(out.sessions[3]).not.toBe(prev.sessions[3])
    expect(out.sessions[3].status).toBe('running')
    // The changed session's unchanged parts, its siblings and the other sections are the previous objects.
    expect(out.sessions[3].usage).toBe(prev.sessions[3].usage)
    expect(out.sessions[2]).toBe(prev.sessions[2])
    expect(out.workspaces).toBe(prev.workspaces)
    expect(out.comments).toBe(prev.comments)
    expect(out.settings).toBe(prev.settings)
    expect(out.recentRepos).toBe(prev.recentRepos)
  })

  it('propagates a deeply nested change', () => {
    const prev = snapshot()
    const next = copy(prev)
    next.workspaces[5].checks.results[0].status = 'failed'
    const out = shareUnchanged(prev, next)
    expect(out.workspaces[5].checks.results[0].status).toBe('failed')
    expect(out.workspaces[5]).not.toBe(prev.workspaces[5])
    expect(out.workspaces[5].diffStat).toBe(prev.workspaces[5].diffStat)
    expect(out.workspaces[4]).toBe(prev.workspaces[4])
    expect(out.settings).toBe(prev.settings)
  })

  it('matches entries by id across a reorder, a removal and an insert', () => {
    const prev = snapshot(5, 10)
    const next = copy(prev)
    next.workspaces.reverse()
    next.sessions.splice(1, 1)
    next.sessions.unshift({ id: 'new', workspaceId: 'w0', status: 'idle', queue: [], usage: { input: 0, output: 0 } })
    const out = shareUnchanged(prev, next)
    expect(out).toEqual(next)
    expect(out.workspaces).not.toBe(prev.workspaces)
    expect(out.workspaces.map((w) => w.id)).toEqual(['w4', 'w3', 'w2', 'w1', 'w0'])
    out.workspaces.forEach((w) => expect(w).toBe(prev.workspaces.find((p) => p.id === w.id)))
    expect(out.sessions.map((s) => s.id)).toEqual(['new', 's0', 's2', 's3', 's4'])
    expect(out.sessions[0]).toBe(next.sessions[0])
    for (const s of out.sessions.slice(1)) expect(s).toBe(prev.sessions.find((p) => p.id === s.id))
  })

  it('a shorter or longer list is a change, even when every entry is reused', () => {
    const prev = { list: [{ id: 'a' }, { id: 'b' }] }
    const shorter = shareUnchanged(prev, { list: [{ id: 'a' }] })
    expect(shorter.list).not.toBe(prev.list)
    expect(shorter.list[0]).toBe(prev.list[0])
    const longer = shareUnchanged(prev, { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
    expect(longer.list).toHaveLength(3)
    expect(longer.list[1]).toBe(prev.list[1])
  })

  it('treats an added, removed or undefined key as a change', () => {
    const prev = { a: 1, b: { x: 1 } } as Record<string, unknown>
    expect(shareUnchanged(prev, { a: 1, b: { x: 1 }, c: undefined })).not.toBe(prev)
    expect(shareUnchanged(prev, { a: 1 })).toEqual({ a: 1 })
    const added = shareUnchanged(prev, { a: 1, b: { x: 1 }, c: 2 })
    expect(added).toEqual({ a: 1, b: { x: 1 }, c: 2 })
    expect(added.b).toBe(prev.b)
  })

  it('compares primitives, null, dates and kinds of value', () => {
    expect(shareUnchanged(null, { a: 1 })).toEqual({ a: 1 })
    expect(shareUnchanged({ a: 1 }, null)).toBeNull()
    expect(shareUnchanged([1, 2], { 0: 1, 1: 2 })).toEqual({ 0: 1, 1: 2 })
    expect(shareUnchanged({ n: NaN }, { n: NaN })).toEqual({ n: NaN })
    const prev = { at: new Date(5), v: [1, 'a', null, true] }
    expect(shareUnchanged(prev, { at: new Date(5), v: [1, 'a', null, true] })).toBe(prev)
    const later = shareUnchanged(prev, { at: new Date(6), v: [1, 'a', null, true] })
    expect(later.at.getTime()).toBe(6)
    expect(later.v).toBe(prev.v)
  })

  it('does not modify either argument', () => {
    const prev = snapshot(3, 3)
    const next = copy(prev)
    next.sessions[0].status = 'running'
    const nextBefore = copy(next)
    const nextSessions = next.sessions
    const prevBefore = copy(prev)
    shareUnchanged(prev, next)
    expect(next).toEqual(nextBefore)
    expect(next.sessions).toBe(nextSessions)
    expect(next.sessions[1]).not.toBe(prev.sessions[1])
    expect(prev).toEqual(prevBefore)
  })

  it('stays fast for a snapshot with many workspaces, sessions and comments', () => {
    const prev = snapshot(40, 5000)
    const runs = 20
    const nexts = Array.from({ length: runs }, () => copy(prev))
    for (const n of nexts) n.sessions[7].status = 'running'
    // Warmed up first, as it is after the window's first few snapshots.
    for (let i = 0; i < 5; i++) {
      shareUnchanged(prev, copy(prev))
      JSON.stringify(prev)
    }
    const started = performance.now()
    for (const n of nexts) shareUnchanged(prev, n)
    const walk = (performance.now() - started) / runs
    const t0 = performance.now()
    for (const n of nexts) JSON.stringify(n)
    const stringify = (performance.now() - t0) / runs
    // A generous bound for a loaded machine; the walk is usually well under 2 ms here.
    expect(walk).toBeLessThan(50)
    console.info(`shareUnchanged: ${walk.toFixed(2)} ms per snapshot; JSON.stringify of the same: ${stringify.toFixed(2)} ms`)
  })
})
