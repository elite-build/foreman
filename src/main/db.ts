// foreman.db: workspaces, sessions, comments, chat items, check results and
// attachment references. One connection, owned by the main process (WAL).
// Uses Node's built-in SQLite, so there is no native module to package.
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { itemText, receiptOf } from '../shared/itemText'
import type { UsageRow } from '../shared/usageReport'
import type { AssistantThread } from '../shared/assistant'
import type { ChatItem, CheckResult, DiffComment, Session, Workspace } from '../shared/types'

type SqliteModule = typeof import('node:sqlite')

let sqlite: SqliteModule | undefined

/** Loads node:sqlite without printing its ExperimentalWarning (Node 22 and 24 both emit it once). */
export function loadSqlite(): SqliteModule {
  if (sqlite) return sqlite
  const emit = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message
    if (/SQLite/i.test(text)) return
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    sqlite = process.getBuiltinModule('node:sqlite') as SqliteModule
  } finally {
    process.emitWarning = emit
  }
  return sqlite
}

/** Each entry upgrades the schema by one version. Never edit one that has shipped. */
const SCHEMA: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, repo_id TEXT, json TEXT NOT NULL);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, json TEXT NOT NULL);
  CREATE TABLE comments (id TEXT PRIMARY KEY, workspace_id TEXT, json TEXT NOT NULL);
  CREATE TABLE checks (workspace_id TEXT NOT NULL, idx INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (workspace_id, idx));
  -- seq is the chat order: a later write of the same item keeps its place (last one wins).
  CREATE TABLE items (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    turn_id TEXT,
    at TEXT NOT NULL,
    json TEXT NOT NULL,
    text TEXT,
    tool_text TEXT,
    -- Cleared or rewound: hidden from the chat; the content is gone unless "Keep cleared history" is on.
    superseded INTEGER NOT NULL DEFAULT 0,
    UNIQUE (session_id, id)
  );
  CREATE INDEX items_turn ON items (session_id, turn_id);
  CREATE TABLE attachments (session_id TEXT NOT NULL, item_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL);
  CREATE INDEX attachments_item ON attachments (session_id, item_id);
  `,
  // Search: an index over message text and, in its own column, tool text.
  `
  CREATE VIRTUAL TABLE items_fts USING fts5(text, tool_text, content = 'items', content_rowid = 'seq', tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER items_fts_insert AFTER INSERT ON items BEGIN
    INSERT INTO items_fts (rowid, text, tool_text) VALUES (new.seq, new.text, new.tool_text);
  END;
  CREATE TRIGGER items_fts_delete AFTER DELETE ON items BEGIN
    INSERT INTO items_fts (items_fts, rowid, text, tool_text) VALUES ('delete', old.seq, old.text, old.tool_text);
  END;
  CREATE TRIGGER items_fts_update AFTER UPDATE OF text, tool_text ON items BEGIN
    INSERT INTO items_fts (items_fts, rowid, text, tool_text) VALUES ('delete', old.seq, old.text, old.tool_text);
    INSERT INTO items_fts (rowid, text, tool_text) VALUES (new.seq, new.text, new.tool_text);
  END;
  INSERT INTO items_fts (items_fts) VALUES ('rebuild');
  `,
  // Claude's own transcripts, mirrored through the SDK's SessionStore. A uuid is the dedupe key; entries without one stay in order.
  `
  CREATE TABLE claude_transcripts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    project_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    subpath TEXT NOT NULL DEFAULT '',
    uuid TEXT,
    json TEXT NOT NULL
  );
  CREATE UNIQUE INDEX claude_transcripts_uuid ON claude_transcripts (project_key, session_id, subpath, uuid);
  CREATE INDEX claude_transcripts_session ON claude_transcripts (session_id);
  CREATE TABLE claude_mirror_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    subpath TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL,
    error TEXT NOT NULL
  );
  CREATE INDEX claude_mirror_errors_session ON claude_mirror_errors (session_id);
  `,
  // #3: Home → Recent's history of attention transitions (bounded to 500 events or 30 days by the service).
  `
  CREATE TABLE attention_events (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL);
  CREATE INDEX attention_events_at ON attention_events (at);
  `,
  // The assistant's threads and their chat items, apart from workspace chats (search, export and the orphan sweep never see them).
  `
  CREATE TABLE assistant_threads (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, json TEXT NOT NULL);
  CREATE TABLE assistant_items (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    id TEXT NOT NULL,
    json TEXT NOT NULL,
    UNIQUE (thread_id, id)
  );
  `,
  // Integrations: Slack messages rules made, one row per recipient. The unique key makes each occurrence send at most once.
  `
  CREATE TABLE slack_deliveries (id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, occurrence TEXT NOT NULL, recipient TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL, UNIQUE (rule_id, occurrence, recipient));
  CREATE INDEX slack_deliveries_at ON slack_deliveries (at);
  `
]

export const SCHEMA_VERSION = SCHEMA.length

export interface DbRows {
  workspaces: Workspace[]
  sessions: Session[]
  comments: DiffComment[]
}

export interface DbCounts {
  workspaces: number
  sessions: number
  comments: number
  items: number
  checks: number
}

export interface RawHit {
  sessionId: string
  itemId: string
  kind: string
  at: string
  cleared: boolean
  snippet: string
  // O1: the agent and model the hit's turn was sent to, when its message recorded them.
  agent?: string
  model?: string
}

export class ForemanDb {
  readonly db: DatabaseSync
  private statements = new Map<string, StatementSync>()
  // The JSON last written per row, so a save touches only what changed.
  private written = emptyWritten()

  constructor(readonly file: string) {
    const { DatabaseSync } = loadSqlite()
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;')
    this.upgrade()
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.statements.set(sql, s)
    }
    return s
  }

  private upgrade(): void {
    const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (current > SCHEMA_VERSION) throw new Error(`foreman.db is from a newer version of Foreman (schema ${current}).`)
    for (let v = current; v < SCHEMA_VERSION; v++) {
      this.transaction(() => {
        this.db.exec(SCHEMA[v])
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  }

  private depth = 0

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    } finally {
      this.depth--
    }
  }

  close(): void {
    this.statements.clear()
    this.db.close()
  }

  // ---- meta ----

  getMeta(key: string): string | undefined {
    return (this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
  }

  setMeta(key: string, value: string): void {
    this.stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // ---- workspaces, sessions, comments ----

  readRows(): DbRows {
    const parse = <T>(sql: string): T[] => (this.stmt(sql).all() as { json: string }[]).map((r) => JSON.parse(r.json) as T)
    const workspaces = parse<Workspace>('SELECT json FROM workspaces ORDER BY rowid')
    const results = new Map<string, CheckResult[]>()
    for (const row of this.stmt('SELECT workspace_id, json FROM checks ORDER BY workspace_id, idx').all() as { workspace_id: string; json: string }[]) {
      const list = results.get(row.workspace_id) ?? []
      list.push(JSON.parse(row.json) as CheckResult)
      results.set(row.workspace_id, list)
    }
    for (const ws of workspaces) {
      const list = results.get(ws.id)
      if (ws.checks && list) ws.checks.results = list
    }
    const rows = { workspaces, sessions: parse<Session>('SELECT json FROM sessions ORDER BY rowid'), comments: parse<DiffComment>('SELECT json FROM comments ORDER BY rowid') }
    this.prime(rows)
    return rows
  }

  /** Remember what the database holds for these rows (after a read or an import). */
  private prime(rows: DbRows): void {
    this.written.workspaces = new Map(rows.workspaces.map((w) => [w.id, serializeWorkspace(w).json]))
    this.written.checks = new Map(rows.workspaces.map((w) => [w.id, serializeWorkspace(w).results]))
    this.written.sessions = new Map(rows.sessions.map((s) => [s.id, JSON.stringify(s)]))
    this.written.comments = new Map(rows.comments.map((c) => [c.id, JSON.stringify(c)]))
  }

  /** Make the tables match these rows. Rows that went away take their chat items, check results and attachment refs with them. */
  syncRows(rows: DbRows): void {
    const wsJson = new Map<string, { json: string; results: string }>()
    for (const w of rows.workspaces) wsJson.set(w.id, serializeWorkspace(w))
    const sessionJson = new Map(rows.sessions.map((s) => [s.id, JSON.stringify(s)]))
    const commentJson = new Map(rows.comments.map((c) => [c.id, JSON.stringify(c)]))

    const changed =
      this.differs(this.written.workspaces, new Map([...wsJson].map(([id, v]) => [id, v.json]))) ||
      this.differs(this.written.sessions, sessionJson) ||
      this.differs(this.written.comments, commentJson) ||
      rows.workspaces.some((w) => this.written.checks.get(w.id) !== wsJson.get(w.id)!.results)
    if (!changed) return

    this.transaction(() => {
      for (const w of rows.workspaces) {
        const v = wsJson.get(w.id)!
        if (this.written.workspaces.get(w.id) !== v.json) {
          this.stmt('INSERT INTO workspaces (id, repo_id, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET repo_id = excluded.repo_id, json = excluded.json').run(w.id, w.repoId ?? null, v.json)
        }
        if (this.written.checks.get(w.id) !== v.results) {
          this.stmt('DELETE FROM checks WHERE workspace_id = ?').run(w.id)
          ;(w.checks?.results ?? []).forEach((r, i) => this.stmt('INSERT INTO checks (workspace_id, idx, json) VALUES (?, ?, ?)').run(w.id, i, JSON.stringify(r)))
        }
      }
      for (const id of this.written.workspaces.keys()) {
        if (wsJson.has(id)) continue
        this.stmt('DELETE FROM workspaces WHERE id = ?').run(id)
        this.stmt('DELETE FROM checks WHERE workspace_id = ?').run(id)
      }
      for (const s of rows.sessions) {
        const json = sessionJson.get(s.id)!
        if (this.written.sessions.get(s.id) !== json) {
          this.stmt('INSERT INTO sessions (id, workspace_id, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, json = excluded.json').run(s.id, s.workspaceId, json)
        }
      }
      for (const id of this.written.sessions.keys()) if (!sessionJson.has(id)) this.deleteItems(id)
      for (const id of this.written.sessions.keys()) if (!sessionJson.has(id)) this.stmt('DELETE FROM sessions WHERE id = ?').run(id)
      for (const c of rows.comments) {
        const json = commentJson.get(c.id)!
        if (this.written.comments.get(c.id) !== json) {
          this.stmt('INSERT INTO comments (id, workspace_id, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, json = excluded.json').run(c.id, c.workspaceId, json)
        }
      }
      for (const id of this.written.comments.keys()) if (!commentJson.has(id)) this.stmt('DELETE FROM comments WHERE id = ?').run(id)
    })
    this.written.workspaces = new Map([...wsJson].map(([id, v]) => [id, v.json]))
    this.written.checks = new Map([...wsJson].map(([id, v]) => [id, v.results]))
    this.written.sessions = sessionJson
    this.written.comments = commentJson
  }

  private differs(a: Map<string, string>, b: Map<string, string>): boolean {
    if (a.size !== b.size) return true
    for (const [k, v] of b) if (a.get(k) !== v) return true
    return false
  }

  /** Items whose session is gone (a late write after the tab was removed). */
  sweepOrphans(): number {
    const ids = (this.stmt('SELECT DISTINCT session_id FROM items WHERE session_id NOT IN (SELECT id FROM sessions)').all() as { session_id: string }[]).map((r) => r.session_id)
    this.transaction(() => ids.forEach((id) => this.deleteItems(id)))
    return ids.length
  }

  // ---- assistant ----

  readAssistantThreads(): AssistantThread[] {
    return (this.stmt('SELECT json FROM assistant_threads ORDER BY updated_at DESC').all() as { json: string }[]).map((r) => JSON.parse(r.json) as AssistantThread)
  }

  putAssistantThread(thread: AssistantThread): void {
    this.stmt('INSERT INTO assistant_threads (id, updated_at, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, json = excluded.json').run(thread.id, thread.updatedAt, JSON.stringify(thread))
  }

  /** Append, or update by id: the item keeps its place in the thread. */
  putAssistantItem(threadId: string, item: ChatItem): void {
    this.stmt('INSERT INTO assistant_items (thread_id, id, json) VALUES (?, ?, ?) ON CONFLICT(thread_id, id) DO UPDATE SET json = excluded.json').run(threadId, item.id, JSON.stringify(item))
  }

  readAssistantItems(threadId: string): ChatItem[] {
    return (this.stmt('SELECT json FROM assistant_items WHERE thread_id = ? ORDER BY seq').all(threadId) as { json: string }[]).map((r) => JSON.parse(r.json) as ChatItem)
  }

  /** Remove threads and their items; every thread when no ids are given. */
  deleteAssistantThreads(ids?: string[]): void {
    this.transaction(() => {
      if (!ids) {
        this.stmt('DELETE FROM assistant_items').run()
        this.stmt('DELETE FROM assistant_threads').run()
        return
      }
      for (const id of ids) {
        this.stmt('DELETE FROM assistant_items WHERE thread_id = ?').run(id)
        this.stmt('DELETE FROM assistant_threads WHERE id = ?').run(id)
      }
    })
  }

  // ---- chat items ----

  /** Append, or update by id: the item keeps its place in the chat. */
  putItem(sessionId: string, item: ChatItem, fallbackAt?: string): void {
    const { text, toolText } = itemText(item)
    const given = 'at' in item && typeof item.at === 'string' ? item.at : (fallbackAt ?? null)
    this.stmt(
      `INSERT INTO items (session_id, id, kind, turn_id, at, json, text, tool_text, superseded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(session_id, id) DO UPDATE SET kind = excluded.kind, turn_id = excluded.turn_id,
         at = CASE WHEN ? IS NOT NULL THEN excluded.at ELSE items.at END,
         json = excluded.json, text = excluded.text, tool_text = excluded.tool_text, superseded = 0`
    ).run(sessionId, item.id, item.kind, 'turnId' in item ? item.turnId ?? null : null, given ?? new Date().toISOString(), JSON.stringify(item), text, toolText, given)
    this.putAttachments(sessionId, item)
  }

  private putAttachments(sessionId: string, item: ChatItem): void {
    this.stmt('DELETE FROM attachments WHERE session_id = ? AND item_id = ?').run(sessionId, item.id)
    if (item.kind !== 'user') return
    for (const a of item.attachments ?? []) this.stmt('INSERT INTO attachments (session_id, item_id, name, path, kind) VALUES (?, ?, ?, ?, ?)').run(sessionId, item.id, a.name, a.path, a.kind)
  }

  /** The chat in order, one entry per id (the last write of it). */
  readItems(sessionId: string): ChatItem[] {
    return (this.stmt('SELECT json FROM items WHERE session_id = ? AND superseded = 0 ORDER BY seq').all(sessionId) as { json: string }[]).map((r) => JSON.parse(r.json) as ChatItem)
  }

  /**
   * Make this the chat. What it drops (a /clear, a rewind) is kept as superseded
   * items when `keepCleared`, otherwise only as receipts without any content.
   */
  replaceItems(sessionId: string, items: ChatItem[], keepCleared: boolean): void {
    this.transaction(() => {
      const keep = new Set(items.map((i) => i.id))
      const old = this.stmt('SELECT id, json FROM items WHERE session_id = ? AND superseded = 0 ORDER BY seq').all(sessionId) as { id: string; json: string }[]
      const dropped = old.filter((o) => !keep.has(o.id)).map((o) => JSON.parse(o.json) as ChatItem)
      // Rows superseded earlier stay as they are, unless the new chat reuses their ids.
      this.stmt('DELETE FROM items WHERE session_id = ? AND superseded = 0').run(sessionId)
      this.stmt('DELETE FROM attachments WHERE session_id = ?').run(sessionId)
      for (const item of dropped) this.putSuperseded(sessionId, item, keepCleared)
      for (const item of items) {
        this.stmt('DELETE FROM items WHERE session_id = ? AND id = ?').run(sessionId, item.id)
        this.putItem(sessionId, item)
      }
    })
  }

  private putSuperseded(sessionId: string, item: ChatItem, keepContent: boolean): void {
    const stored = keepContent ? item : receiptOf(item)
    const { text, toolText } = keepContent ? itemText(item) : { text: null, toolText: null }
    // Not INSERT OR REPLACE: that would not fire the trigger that keeps the search index in step.
    this.stmt('DELETE FROM items WHERE session_id = ? AND id = ?').run(sessionId, item.id)
    this.stmt('INSERT INTO items (session_id, id, kind, turn_id, at, json, text, tool_text, superseded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)').run(
      sessionId,
      item.id,
      item.kind,
      'turnId' in item ? item.turnId ?? null : null,
      'at' in item && typeof item.at === 'string' ? item.at : new Date().toISOString(),
      JSON.stringify(stored),
      text,
      toolText
    )
  }

  /** Drop the content of everything cleared so far (Keep cleared history was turned off). */
  scrubCleared(): void {
    this.transaction(() => {
      const rows = this.stmt("SELECT seq, json FROM items WHERE superseded = 1 AND (text IS NOT NULL OR tool_text IS NOT NULL OR kind NOT IN ('result', 'turn-end', 'user'))").all() as { seq: number; json: string }[]
      for (const r of rows) {
        this.stmt('UPDATE items SET json = ?, text = NULL, tool_text = NULL WHERE seq = ?').run(JSON.stringify(receiptOf(JSON.parse(r.json) as ChatItem)), r.seq)
      }
    })
  }

  /** Remove a chat and the attachment references that belonged to it. */
  deleteItems(sessionId: string): void {
    this.stmt('DELETE FROM items WHERE session_id = ?').run(sessionId)
    this.stmt('DELETE FROM attachments WHERE session_id = ?').run(sessionId)
  }

  // ---- Claude transcript mirror ----

  mirrorAppend(key: { projectKey: string; sessionId: string; subpath?: string }, entries: { uuid?: string; [k: string]: unknown }[]): void {
    this.transaction(() => {
      for (const entry of entries) {
        const uuid = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : null
        this.stmt('INSERT OR IGNORE INTO claude_transcripts (project_key, session_id, subpath, uuid, json) VALUES (?, ?, ?, ?, ?)').run(key.projectKey, key.sessionId, key.subpath ?? '', uuid, JSON.stringify(entry))
      }
    })
  }

  /** The entries stored for a key, in order, or null when none were ever written. When this project key has none, the same session under another key (an imported one, whose folder is a different path) is used. */
  mirrorLoad(key: { projectKey: string; sessionId: string; subpath?: string }): { [k: string]: unknown }[] | null {
    const read = (sql: string, ...args: string[]) => (this.stmt(sql).all(...args) as { json: string }[]).map((r) => JSON.parse(r.json) as { [k: string]: unknown })
    const sub = key.subpath ?? ''
    let rows = read('SELECT json FROM claude_transcripts WHERE project_key = ? AND session_id = ? AND subpath = ? ORDER BY seq', key.projectKey, key.sessionId, sub)
    if (!rows.length) {
      const other = this.stmt('SELECT project_key FROM claude_transcripts WHERE session_id = ? AND subpath = ? ORDER BY seq LIMIT 1').get(key.sessionId, sub) as { project_key: string } | undefined
      if (other) rows = read('SELECT json FROM claude_transcripts WHERE project_key = ? AND session_id = ? AND subpath = ? ORDER BY seq', other.project_key, key.sessionId, sub)
    }
    return rows.length ? rows : null
  }

  mirrorDelete(key: { projectKey: string; sessionId: string; subpath?: string }): void {
    if (key.subpath === undefined) this.stmt('DELETE FROM claude_transcripts WHERE project_key = ? AND session_id = ?').run(key.projectKey, key.sessionId)
    else this.stmt('DELETE FROM claude_transcripts WHERE project_key = ? AND session_id = ? AND subpath = ?').run(key.projectKey, key.sessionId, key.subpath)
  }

  mirrorSessions(projectKey: string): { sessionId: string; mtime: number }[] {
    return (this.stmt("SELECT DISTINCT session_id FROM claude_transcripts WHERE project_key = ? AND subpath = ''").all(projectKey) as { session_id: string }[]).map((r) => ({ sessionId: r.session_id, mtime: 0 }))
  }

  mirrorSubpaths(sessionId: string): string[] {
    return (this.stmt("SELECT DISTINCT subpath FROM claude_transcripts WHERE session_id = ? AND subpath != '' ORDER BY subpath").all(sessionId) as { subpath: string }[]).map((r) => r.subpath)
  }

  mirrorHasMain(sessionId: string): boolean {
    return Boolean(this.stmt("SELECT 1 AS x FROM claude_transcripts WHERE session_id = ? AND subpath = '' LIMIT 1").get(sessionId))
  }

  /** Move a session's entries to another project key (an imported session, once its folder exists). */
  mirrorRekey(from: string, to: string, sessionIds: string[]): void {
    this.transaction(() => {
      for (const id of sessionIds) this.stmt('UPDATE OR IGNORE claude_transcripts SET project_key = ? WHERE project_key = ? AND session_id = ?').run(to, from, id)
      this.stmt('DELETE FROM claude_transcripts WHERE project_key = ?').run(from)
    })
  }

  mirrorAddError(sessionId: string, subpath: string | undefined, error: string, at = new Date().toISOString()): void {
    this.stmt('INSERT INTO claude_mirror_errors (session_id, subpath, at, error) VALUES (?, ?, ?, ?)').run(sessionId, subpath ?? '', at, error.slice(0, 2000))
  }

  mirrorErrorCount(sessionId?: string): number {
    const row = sessionId
      ? (this.stmt('SELECT COUNT(*) AS n FROM claude_mirror_errors WHERE session_id = ?').get(sessionId) as { n: number })
      : (this.stmt('SELECT COUNT(*) AS n FROM claude_mirror_errors').get() as { n: number })
    return row.n
  }

  mirrorSessionCount(): number {
    return (this.stmt("SELECT COUNT(DISTINCT session_id) AS n FROM claude_transcripts WHERE subpath = ''").get() as { n: number }).n
  }

  /** Forget a session's mirror (its chat was deleted), errors included. */
  mirrorForget(sessionId: string): void {
    this.stmt('DELETE FROM claude_transcripts WHERE session_id = ?').run(sessionId)
    this.stmt('DELETE FROM claude_mirror_errors WHERE session_id = ?').run(sessionId)
  }

  // ---- search ----

  /** Items matching an FTS5 expression (see shared/chatIndex.ts), best first. Snippets mark hits with \u0001 and \u0002. */
  searchItems(match: string, options: { toolOutput: boolean; cleared: boolean; limit: number }): RawHit[] {
    const columns = options.toolOutput ? '{text tool_text}' : 'text'
    // O1: the agent and model of the hit's turn, from its message (a tab can switch agents).
    const rows = this.stmt(
      `SELECT i.session_id, i.id, i.kind, i.at, i.superseded,
              snippet(items_fts, -1, char(1), char(2), '…', 14) AS snippet,
              (SELECT json_extract(u.json, '$.agent') FROM items u
                WHERE u.session_id = i.session_id AND u.turn_id = i.turn_id AND u.kind = 'user' ORDER BY u.seq DESC LIMIT 1) AS agent,
              (SELECT json_extract(u.json, '$.model') FROM items u
                WHERE u.session_id = i.session_id AND u.turn_id = i.turn_id AND u.kind = 'user' ORDER BY u.seq DESC LIMIT 1) AS model
       FROM items_fts JOIN items i ON i.seq = items_fts.rowid
       WHERE items_fts MATCH ? AND (i.superseded = 0 OR ?)
       ORDER BY bm25(items_fts), i.seq DESC LIMIT ?`
    ).all(`${columns} : (${match})`, options.cleared ? 1 : 0, options.limit) as { session_id: string; id: string; kind: string; at: string; superseded: number; snippet: string; agent: string | null; model: string | null }[]
    return rows.map((r) => ({ sessionId: r.session_id, itemId: r.id, kind: r.kind, at: r.at, cleared: r.superseded === 1, snippet: r.snippet, ...(r.agent && r.model ? { agent: r.agent, model: r.model } : {}) }))
  }

  // ---- usage ----

  /**
   * What the usage report reads: every user, result and turn-end item (cleared ones too, as receipts)
   * of turns that have an item since the cutoff. The report applies the exact start time.
   */
  usageRows(since: string): UsageRow[] {
    const rows = this.stmt(
      `SELECT session_id, turn_id, kind, at, json_extract(json, '$.costUsd') AS cost, json_extract(json, '$.durationMs') AS duration,
              json_extract(json, '$.agent') AS agent, json_extract(json, '$.model') AS model
       FROM items
       WHERE kind IN ('user', 'result', 'turn-end') AND turn_id IS NOT NULL
         AND turn_id IN (SELECT turn_id FROM items WHERE kind IN ('user', 'result', 'turn-end') AND at >= ?)`
    ).all(since) as { session_id: string; turn_id: string; kind: UsageRow['kind']; at: string; cost: number | null; duration: number | null; agent: string | null; model: string | null }[]
    // O1: a message records the agent and model it was sent to.
    return rows.map((r) => ({ sessionId: r.session_id, turnId: r.turn_id, kind: r.kind, at: r.at, costUsd: r.cost ?? undefined, durationMs: r.duration ?? undefined, ...(r.kind === 'user' && r.agent && r.model ? { agent: r.agent as UsageRow['agent'], model: r.model } : {}) }))
  }

  // ---- #3 attention history ----

  /** The log, oldest first. */
  readAttention<T>(): T[] {
    return (this.stmt('SELECT json FROM attention_events ORDER BY at, rowid').all() as { json: string }[]).map((r) => JSON.parse(r.json) as T)
  }

  /** Write one event (new, or a repeat folded into it) and drop the ones the bound let go, together. */
  writeAttention(event: { id: string; workspaceId: string; at: string }, dropped: string[]): void {
    this.transaction(() => {
      this.stmt('INSERT INTO attention_events (id, workspace_id, at, json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, json = excluded.json').run(
        event.id,
        event.workspaceId,
        event.at,
        JSON.stringify(event)
      )
      for (const id of dropped) this.stmt('DELETE FROM attention_events WHERE id = ?').run(id)
    })
  }

  // ---- Integrations: Slack deliveries ----

  /** Record a delivery unless this rule already has one for the occurrence and recipient. True when it's new. */
  addDelivery(d: { id: string; ruleId: string; occurrence: string; recipientId: string; at: string }): boolean {
    const r = this.stmt('INSERT INTO slack_deliveries (id, rule_id, occurrence, recipient, at, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(
      d.id,
      d.ruleId,
      d.occurrence,
      d.recipientId,
      d.at,
      JSON.stringify(d)
    )
    return Number(r.changes) > 0
  }

  putDelivery(d: { id: string }): void {
    this.stmt('UPDATE slack_deliveries SET json = ? WHERE id = ?').run(JSON.stringify(d), d.id)
  }

  readDeliveries<T>(limit = 200): T[] {
    return (this.stmt('SELECT json FROM slack_deliveries ORDER BY at DESC, rowid DESC LIMIT ?').all(limit) as { json: string }[]).map((r) => JSON.parse(r.json) as T)
  }

  /** Deliveries still waiting (asking, queued), oldest first. */
  openDeliveries<T>(): T[] {
    return (this.stmt("SELECT json FROM slack_deliveries WHERE json_extract(json, '$.status') IN ('asking', 'queued') ORDER BY at, rowid").all() as { json: string }[]).map((r) => JSON.parse(r.json) as T)
  }

  /** Keep the newest `keep` deliveries. */
  pruneDeliveries(keep = 1000): void {
    this.stmt('DELETE FROM slack_deliveries WHERE rowid NOT IN (SELECT rowid FROM slack_deliveries ORDER BY at DESC, rowid DESC LIMIT ?)').run(keep)
  }

  // ---- facts about the database ----

  counts(): DbCounts {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n
    return {
      workspaces: n('SELECT count(*) AS n FROM workspaces'),
      sessions: n('SELECT count(*) AS n FROM sessions'),
      comments: n('SELECT count(*) AS n FROM comments'),
      items: n('SELECT count(*) AS n FROM items WHERE superseded = 0'),
      checks: n('SELECT count(*) AS n FROM checks')
    }
  }

  /** User and assistant messages in live chats. */
  messageCount(): number {
    return (this.stmt("SELECT count(*) AS n FROM items WHERE superseded = 0 AND kind IN ('user', 'assistant')").get() as { n: number }).n
  }

  attachmentRefs(): { sessionId: string; itemId: string; name: string; path: string; kind: string }[] {
    return (this.stmt('SELECT session_id, item_id, name, path, kind FROM attachments ORDER BY rowid').all() as { session_id: string; item_id: string; name: string; path: string; kind: string }[]).map((r) => ({
      sessionId: r.session_id,
      itemId: r.item_id,
      name: r.name,
      path: r.path,
      kind: r.kind
    }))
  }

  integrityCheck(): string {
    return (this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
  }

  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  /** A consistent copy of the whole database in one file (safe while the app writes). */
  backupTo(file: string): void {
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  }

  /** Replace what is in the tables with imported rows (used by the migration only). */
  importRows(rows: DbRows, chats: Map<string, ChatItem[]>): void {
    this.transaction(() => {
      this.written = emptyWritten()
      this.syncRows(rows)
      for (const [sessionId, items] of chats) {
        // Old logs only dated the user's message; the items after it happened then or soon after.
        let at: string | undefined
        for (const item of items) {
          if ('at' in item && typeof item.at === 'string') at = item.at
          this.putItem(sessionId, item, at)
        }
      }
    })
  }
}

function serializeWorkspace(w: Workspace): { json: string; results: string } {
  const results = w.checks?.results ?? []
  const stripped = w.checks ? { ...w, checks: { ...w.checks, results: [] } } : w
  return { json: JSON.stringify(stripped), results: JSON.stringify(results) }
}

function emptyWritten() {
  return { workspaces: new Map<string, string>(), sessions: new Map<string, string>(), comments: new Map<string, string>(), checks: new Map<string, string>() }
}
