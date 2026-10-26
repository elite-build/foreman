import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatItem, Session, Workspace } from '../src/shared/types'
import { DataService } from '../src/main/dataService'
import { ForemanDb } from '../src/main/db'
import { Store } from '../src/main/store'
import { tempDir } from './helpers'

const ws = (id: string, extra: Partial<Workspace> = {}) => ({ id, repoId: 'r1', name: id, createdAt: '2026-01-01T00:00:00Z', ...extra }) as unknown as Workspace
const session = (id: string, workspaceId: string) => ({ id, workspaceId, agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: '2026-01-01T00:00:00Z' }) as unknown as Session
const user = (id: string, turnId: string, text: string, extra: object = {}): ChatItem => ({ kind: 'user', id, turnId, text, at: '2026-01-01T00:00:00Z', ...extra }) as ChatItem
const assistant = (id: string, turnId: string, text: string): ChatItem => ({ kind: 'assistant', id, turnId, text })

/** The replay Store.readChat did over the NDJSON files: a later line with the same id replaces the earlier one in place. */
function legacyReadChat(text: string): ChatItem[] {
  const byId = new Map<string, ChatItem>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line) as ChatItem
      byId.set(item.id, item)
    } catch {
      // torn line
    }
  }
  return [...byId.values()]
}

const nd = (...lines: (object | string)[]) => lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'

async function legacyDir(logs: Record<string, string>, state?: object) {
  const dir = await tempDir('foreman-db-')
  await mkdir(path.join(dir, 'sessions'), { recursive: true })
  const workspaces = [ws('w1', { checks: { running: false, results: [{ name: 'lint', command: 'x', status: 'passed', startedAt: 'a', logPath: 'l', fingerprint: {} }] } as never }), ws('w2')]
  const body = state ?? {
    version: 1,
    repos: [{ id: 'r1', name: 'repo', rootPath: '/tmp/repo' }],
    workspaces,
    sessions: [session('s1', 'w1'), session('s2', 'w2')],
    comments: [{ id: 'c1', workspaceId: 'w1' }],
    settings: { theme: 'dark' }
  }
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(body))
  for (const [id, text] of Object.entries(logs)) await writeFile(path.join(dir, 'sessions', `${id}.ndjson`), text)
  return dir
}

const log1 = nd(
  user('u1', 't1', 'first'),
  assistant('a1', 't1', 'partial'),
  '{"kind":"assistant","id":"a2","turnId":"t1","text":"tor',
  'not json at all',
  assistant('a1', 't1', 'final'),
  { id: 'no-kind' },
  user('u2', 't2', 'second')
) + '{"kind":"assistant","id":"a3","turn'

describe('migration to foreman.db', () => {
  it('imports the JSON files, reports damaged records and keeps the originals in legacy/', async () => {
    const dir = await legacyDir({ s1: log1, s2: nd(user('x1', 't9', 'other')), orphan: nd(user('o', 't', 'lost')) })
    const store = new Store(dir)
    await store.load()
    expect(store.migration).toMatchObject({ status: 'migrated', counts: { workspaces: 2, sessions: 2, comments: 1, items: 4, checks: 1 } })
    expect(store.migration!.malformed.map((m) => [m.file, m.line])).toEqual([
      ['sessions/s1.ndjson', 3],
      ['sessions/s1.ndjson', 4],
      ['sessions/s1.ndjson', 6],
      ['sessions/s1.ndjson', 8]
    ])
    expect(store.migration!.warnings.join('\n')).toContain('orphan.ndjson')
    // Same answer the old readChat gave (except for a line with no kind, which is reported instead), including a1 keeping its first place with its last content.
    expect(await store.readChat('s1')).toEqual(legacyReadChat(log1).filter((i) => i.kind))
    expect((await store.readChat('s1')).map((i) => i.id)).toEqual(['u1', 'a1', 'u2'])
    expect(store.state.workspaces.find((w) => w.id === 'w1')?.checks?.results).toHaveLength(1)
    expect(store.state.settings.theme).toBe('dark')
    expect(existsSync(path.join(dir, 'legacy', 'sessions', 's1.ndjson'))).toBe(true)
    expect(existsSync(path.join(dir, 'sessions'))).toBe(false)
    const originalState = JSON.parse(await readFile(path.join(dir, 'legacy', 'state.json'), 'utf8'))
    expect(originalState.workspaces).toHaveLength(2)
    const slim = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
    expect(slim.workspaces).toBeUndefined()
    expect(slim.settings.theme).toBe('dark')
    expect(existsSync(path.join(dir, 'foreman.db.tmp'))).toBe(false)
    store.close()
    // A second start just opens the database.
    const again = new Store(dir)
    await again.load()
    expect(again.migration?.status).toBe('migrated')
    expect(again.state.sessions).toHaveLength(2)
    expect((await again.readChat('s1')).length).toBe(3)
    again.close()
  })

  it('starts fresh when there is nothing to import', async () => {
    const dir = await tempDir('foreman-db-')
    const store = new Store(dir)
    await store.load()
    expect(store.migration?.status).toBe('fresh')
    expect(existsSync(path.join(dir, 'legacy'))).toBe(false)
    store.close()
  })

  it('leaves everything alone and can be re-run when a migration fails before the swap', async () => {
    const dir = await legacyDir({ s1: log1 })
    const good = await readFile(path.join(dir, 'state.json'), 'utf8')
    await writeFile(path.join(dir, 'state.json'), '{ broken')
    // A leftover half-built database from an earlier attempt is discarded.
    await writeFile(path.join(dir, 'foreman.db.tmp'), 'garbage')
    await expect(new Store(dir).load()).rejects.toThrow(/state\.json could not be read/)
    expect(existsSync(path.join(dir, 'foreman.db'))).toBe(false)
    expect(existsSync(path.join(dir, 'sessions', 's1.ndjson'))).toBe(true)
    await writeFile(path.join(dir, 'state.json'), good)
    const store = new Store(dir)
    await store.load()
    expect(store.migration?.status).toBe('migrated')
    expect(store.state.workspaces).toHaveLength(2)
    store.close()
  })

  it('finishes a migration that stopped after the database was renamed into place', async () => {
    const dir = await legacyDir({ s1: log1 })
    const first = new Store(dir)
    await first.load()
    first.close()
    // As if the process died before the marker and before the originals moved.
    const { rm, rename, copyFile } = await import('node:fs/promises')
    await rm(path.join(dir, 'migration.json'))
    await copyFile(path.join(dir, 'legacy', 'state.json'), path.join(dir, 'state.json'))
    await rm(path.join(dir, 'legacy', 'state.json'))
    await mkdir(path.join(dir, 'sessions'))
    await rename(path.join(dir, 'legacy', 'sessions', 's1.ndjson'), path.join(dir, 'sessions', 's1.ndjson'))
    const store = new Store(dir)
    await store.load()
    expect(store.migration?.status).toBe('migrated')
    expect(existsSync(path.join(dir, 'migration.json'))).toBe(true)
    expect(existsSync(path.join(dir, 'legacy', 'sessions', 's1.ndjson'))).toBe(true)
    expect((await store.readChat('s1')).map((i) => i.id)).toEqual(['u1', 'a1', 'u2'])
    expect(store.state.workspaces).toHaveLength(2)
    store.close()
  })
})

describe('the chat store', () => {
  async function open() {
    const dir = await tempDir('foreman-db-')
    const store = new Store(dir)
    await store.load()
    store.state.workspaces.push(ws('w1'))
    store.state.sessions.push(session('s1', 'w1'))
    return { dir, store }
  }

  it('keeps the first place and the last content of an item written again', async () => {
    const { store } = await open()
    const writes: ChatItem[] = [user('u1', 't1', 'hi'), assistant('a1', 't1', 'he'), assistant('a1', 't1', 'hel'), assistant('a2', 't1', 'second'), assistant('a1', 't1', 'hello')]
    for (const w of writes) await store.appendChat('s1', w)
    const expected = legacyReadChat(writes.map((w) => JSON.stringify(w)).join('\n'))
    expect(await store.readChat('s1')).toEqual(expected)
    expect((await store.readChat('s1')).map((i) => i.id)).toEqual(['u1', 'a1', 'a2'])
    expect(await store.readChat('nobody')).toEqual([])
    store.close()
  })

  it('persists workspaces, sessions, comments and check results across a restart, and drops a removed chat', async () => {
    const { dir, store } = await open()
    store.state.workspaces[0].checks = { running: false, results: [{ name: 'a', command: 'a', status: 'passed', startedAt: 's', logPath: 'l', fingerprint: {} as never }] }
    store.state.comments.push({ id: 'c1', workspaceId: 'w1' } as never)
    await store.appendChat('s1', user('u1', 't1', 'hi'))
    store.close()
    const next = new Store(dir)
    await next.load()
    expect(next.state.workspaces.map((w) => w.id)).toEqual(['w1'])
    expect(next.state.workspaces[0].checks?.results.map((r) => r.name)).toEqual(['a'])
    expect(next.state.comments).toHaveLength(1)
    expect((await next.readChat('s1')).length).toBe(1)
    next.state.sessions = []
    next.flush()
    expect(next.db.counts().items).toBe(0)
    next.close()
  })

  it('keeps only receipts for what /clear or a rewind drops, unless Keep cleared history is on', async () => {
    const { store } = await open()
    const items: ChatItem[] = [
      user('u1', 't1', 'secret plan', { attachments: [{ name: 'a.txt', path: '/x/a.txt', kind: 'text' }] }),
      assistant('a1', 't1', 'secret answer'),
      { kind: 'result', id: 'r1', turnId: 't1', ok: true, costUsd: 0.5, durationMs: 1000 },
      user('u2', 't2', 'keep me')
    ]
    for (const i of items) await store.appendChat('s1', i)
    await store.replaceChat('s1', [items[3]])
    expect((await store.readChat('s1')).map((i) => i.id)).toEqual(['u2'])
    const dump = JSON.stringify(store.db.db.prepare('SELECT * FROM items').all())
    expect(dump).not.toContain('secret')
    // The receipt of the turn's cost survives.
    expect(store.db.db.prepare("SELECT json FROM items WHERE id = 'r1'").get()).toMatchObject({ json: expect.stringContaining('0.5') })
    expect(store.db.attachmentRefs()).toEqual([])

    store.state.settings.keepClearedHistory = true
    await store.replaceChat('s1', [])
    expect(JSON.stringify(store.db.db.prepare('SELECT text FROM items WHERE superseded = 1').all())).toContain('keep me')
    store.state.settings.keepClearedHistory = false
    store.keepClearedChanged()
    expect(JSON.stringify(store.db.db.prepare('SELECT text FROM items').all())).not.toContain('keep me')
    store.close()
  })

  it('counts messages and lists attachment references', async () => {
    const { store } = await open()
    await store.appendChat('s1', user('u1', 't1', 'a', { attachments: [{ name: 'a.txt', path: '/x/a.txt', kind: 'text' }] }))
    await store.appendChat('s1', assistant('a1', 't1', 'b'))
    await store.appendChat('s1', { kind: 'notice', id: 'n', level: 'info', text: 'x' })
    expect(store.db.messageCount()).toBe(2)
    expect(store.db.attachmentRefs()).toMatchObject([{ sessionId: 's1', itemId: 'u1', path: '/x/a.txt' }])
    store.close()
  })
})

describe('backup', () => {
  it('copies a consistent database and lists attachments, flagging missing files', async () => {
    const dir = await tempDir('foreman-db-')
    const folder = await tempDir('foreman-backup-')
    const real = path.join(dir, 'real.txt')
    await writeFile(real, 'hello')
    const store = new Store(dir)
    await store.load()
    store.state.settings.backupFolder = folder
    store.state.workspaces.push(ws('w1'))
    store.state.sessions.push(session('s1', 'w1'))
    await store.appendChat('s1', user('u1', 't1', 'hi', { attachments: [{ name: 'real.txt', path: real, kind: 'text' }, { name: 'gone.txt', path: path.join(dir, 'gone.txt'), kind: 'text' }] }))
    const data = new DataService(store, () => new Date('2026-03-01T10:00:00Z'))
    const result = await data.backupNow()
    expect(result).toMatchObject({ attachments: 2, missingAttachments: 1 })
    const copy = new ForemanDb(result.path)
    expect(copy.messageCount()).toBe(1)
    expect(copy.integrityCheck()).toBe('ok')
    copy.close()
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
    expect(manifest.attachments.find((a: { path: string }) => a.path === real)).toMatchObject({ size: 5 })
    expect(manifest.attachments.filter((a: { missing?: boolean }) => a.missing)).toHaveLength(1)
    expect((await data.info()).lastBackup?.path).toBe(result.path)
    expect((await data.info()).messages).toBe(1)
    store.close()
  })

  it('makes the daily backup only when it is on and a day has passed', async () => {
    const dir = await tempDir('foreman-db-')
    let now = new Date('2026-03-01T10:00:00Z')
    const store = new Store(dir)
    await store.load()
    const data = new DataService(store, () => now)
    expect(await data.backupIfDue()).toBeUndefined()
    store.state.settings.dailyBackup = true
    expect(await data.backupIfDue()).toBeDefined()
    now = new Date('2026-03-01T20:00:00Z')
    expect(await data.backupIfDue()).toBeUndefined()
    now = new Date('2026-03-02T10:00:01Z')
    expect(await data.backupIfDue()).toBeDefined()
    expect(readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.db'))).toHaveLength(2)
    store.close()
  })
})
