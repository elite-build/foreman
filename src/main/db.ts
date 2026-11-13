// foreman.db: workspaces, sessions, comments, chat items, check results and
// attachment references. One connection, owned by the main process (WAL).
// Uses Node's built-in SQLite, so there is no native module to package.
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { itemText, receiptOf } from '../shared/itemText'
import type { UsageRow } from '../shared/usageReport'
import type { AssistantThread } from '../shared/assistant'
import type { ChatItem, CheckResult, DiffComment, Session, Workspace } from '../shared/types'
import type { MemoryChange, MemoryMutationState } from '../shared/memory'
import type { EmployeeQuestion, EmployeeRootLedger, EmployeeRun, EmployeeTask, EmployeeTaskTransition } from '../shared/employeeWork'
import type { EmployeeAction } from '../shared/employeeActions'
import { perf } from './perf'

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
  `,
  // AI employees' memory repositories (docs/ai-employees.md §4 and §12): each organization's last commit the memory
  // service made (its baseline for foreign changes), and every intended commit, recorded before git is touched.
  `
  CREATE TABLE memory_heads (org_id TEXT PRIMARY KEY, head TEXT NOT NULL, at TEXT NOT NULL);
  CREATE TABLE memory_mutations (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    run_id TEXT,
    -- staged | committing | committed | refused | conflict
    state TEXT NOT NULL,
    expected_head TEXT,
    commit_id TEXT,
    paths TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX memory_mutations_state ON memory_mutations (org_id, state);
  CREATE INDEX memory_mutations_run ON memory_mutations (org_id, run_id);
  `,
  // The memory search index: each text file at a memory repository's head, by organization, path and blob. A cache the
  // service rebuilds from git; emptying it is harmless.
  `
  CREATE TABLE memory_docs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id TEXT NOT NULL,
    path TEXT NOT NULL,
    blob TEXT NOT NULL,
    text TEXT NOT NULL,
    UNIQUE (org_id, path)
  );
  CREATE VIRTUAL TABLE memory_fts USING fts5(path, text, content = 'memory_docs', content_rowid = 'seq', tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER memory_fts_insert AFTER INSERT ON memory_docs BEGIN
    INSERT INTO memory_fts (rowid, path, text) VALUES (new.seq, new.path, new.text);
  END;
  CREATE TRIGGER memory_fts_delete AFTER DELETE ON memory_docs BEGIN
    INSERT INTO memory_fts (memory_fts, rowid, path, text) VALUES ('delete', old.seq, old.path, old.text);
  END;
  CREATE TRIGGER memory_fts_update AFTER UPDATE OF path, text ON memory_docs BEGIN
    INSERT INTO memory_fts (memory_fts, rowid, path, text) VALUES ('delete', old.seq, old.path, old.text);
    INSERT INTO memory_fts (rowid, path, text) VALUES (new.seq, new.path, new.text);
  END;
  `,
  // AI employees' work (docs/ai-employees.md §6 and §12): tasks (a piece of accepted work with an owner, a state and, once
  // closed, a reason), every transition of one (append-only), and runs (one attempt at a task: a workspace and its session).
  `
  CREATE TABLE employee_tasks (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    -- the same for every attempt at the task
    request_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    parent_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    -- person | schedule | employee
    from_kind TEXT NOT NULL,
    target_repo_id TEXT,
    -- open | running | waiting | closed
    state TEXT NOT NULL,
    -- paused | queued | stopped, while open
    hold TEXT,
    -- person, while waiting
    waiting_on TEXT,
    reason TEXT,
    -- done | handed-off | blocked | declined | canceled | escalated | superseded | no-follow-on
    closure_reason TEXT,
    closure_detail TEXT,
    result_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX employee_tasks_employee ON employee_tasks (org_id, employee_id, state);
  CREATE UNIQUE INDEX employee_tasks_request ON employee_tasks (org_id, request_id);
  CREATE TABLE employee_task_transitions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    run_id TEXT,
    at TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX employee_task_transitions_task ON employee_task_transitions (task_id, seq);
  CREATE TABLE employee_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    -- queued | admitted | provisioning | running | completed | failed | needs-you | uncertain | cancelled | timed-out
    state TEXT NOT NULL,
    -- 1 once a turn was handed to the agent
    started INTEGER NOT NULL DEFAULT 0,
    workspace_id TEXT,
    session_id TEXT,
    turn_ids TEXT NOT NULL DEFAULT '[]',
    agent TEXT,
    model TEXT,
    memory_base TEXT,
    memory_commit TEXT,
    usage TEXT,
    reason TEXT,
    -- what else the run ran with: its repository, access, profile, effort, persona
    json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    admitted_at TEXT,
    started_at TEXT,
    ended_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX employee_runs_employee ON employee_runs (org_id, employee_id, state);
  CREATE INDEX employee_runs_task ON employee_runs (task_id);
  CREATE INDEX employee_runs_session ON employee_runs (session_id);
  `,
  // An AI employee's own tools (docs/ai-employees.md §6.2, §6.4): what else a task keeps (its result from finish_task, the
  // question it waits on), and every question an employee asked a person, with the one answer each may get.
  `
  ALTER TABLE employee_tasks ADD COLUMN json TEXT NOT NULL DEFAULT '{}';
  CREATE TABLE employee_questions (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    workspace_id TEXT,
    session_id TEXT,
    report_id TEXT,
    -- open | answered | canceled
    state TEXT NOT NULL,
    answer TEXT,
    asked_at TEXT NOT NULL,
    answered_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX employee_questions_task ON employee_questions (task_id, asked_at);
  `,
  // AI employees working together (docs/ai-employees.md §7): each chain of work's ledger, one per root task (runs used
  // and allowed, tasks handed off, tasks still open, its state), reserved before admission; and the indexes the broker
  // walks a chain by (its root, a task's children).
  `
  CREATE TABLE employee_roots (
    root_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    runs_used INTEGER NOT NULL DEFAULT 0,
    runs_allowed INTEGER NOT NULL,
    descendants INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0,
    -- open | spent | canceled | closed
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX employee_roots_org ON employee_roots (org_id, state);
  CREATE INDEX employee_tasks_root ON employee_tasks (root_id);
  CREATE INDEX employee_tasks_parent ON employee_tasks (parent_id);
  `,
  // An AI employee's outward actions (docs/ai-employees.md §9): each one a run asked a brokered route for (a bridged
  // Slack post or Linear change, Foreman's push or pull request), recorded with its exact payload before anything is
  // sent, then sent, held for a person or refused as its definition says. The idempotency key makes asking twice, a
  // double Send and a restart find the same action. No secret is kept: only the connection's id.
  `
  CREATE TABLE employee_actions (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    repo_id TEXT,
    -- slack-post | linear | push | pull-request
    kind TEXT NOT NULL,
    -- the exact payload: destination, the connection's id and name, the words
    payload TEXT NOT NULL,
    -- held | allowed | never, as the definition said when it was recorded
    policy TEXT NOT NULL,
    -- held | approved | sent | skipped | failed | refused | uncertain
    state TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    -- the message link or pull request, what the service said, or the error
    result TEXT,
    -- who let it go, whether a person edited it, why it was refused or skipped
    json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT,
    settled_at TEXT
  );
  CREATE UNIQUE INDEX employee_actions_key ON employee_actions (idempotency_key);
  CREATE INDEX employee_actions_task ON employee_actions (task_id, created_at);
  CREATE INDEX employee_actions_org ON employee_actions (org_id, state);
  CREATE INDEX employee_actions_run ON employee_actions (run_id);
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

/** An intended commit to a memory repository (main/memory.ts): recorded before git is touched, finalised after. */
export interface MemoryMutationRow {
  id: string
  orgId: string
  // The run whose staged changes these are; null for a person's edit or Foreman's own.
  runId: string | null
  state: MemoryMutationState
  // The head the commit is made against, once committing.
  expectedHead: string | null
  // The commit made, once made (before the branch moves, so a crash can be told apart).
  commitId: string | null
  paths: string[]
  detail: MemoryMutationDetail
  createdAt: string
  updatedAt: string
}

export interface MemoryMutationDetail {
  changes: MemoryChange[]
  // Why it was refused or conflicted ('discarded', 'foreign', 'interrupted', the conflicting path…).
  reason?: string
  conflictPath?: string
  // For the commit: the author (absent: git's configured user), the subject and the trailers.
  author?: { name: string; email: string }
  subject?: string
  trailers?: { key: string; value: string }[]
  // An employee's proposal (state `proposed` until a person keeps or retires it): who proposed it, for which task, and why.
  proposal?: { employeeId: string; taskId?: string; why?: string }
}

type RawMutation = { id: string; org_id: string; run_id: string | null; state: string; expected_head: string | null; commit_id: string | null; paths: string; json: string; created_at: string; updated_at: string }

const mutationRow = (r: RawMutation): MemoryMutationRow => ({
  id: r.id,
  orgId: r.org_id,
  runId: r.run_id,
  state: r.state as MemoryMutationState,
  expectedHead: r.expected_head,
  commitId: r.commit_id,
  paths: JSON.parse(r.paths) as string[],
  detail: JSON.parse(r.json) as MemoryMutationDetail,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

type RawTask = {
  id: string; org_id: string; employee_id: string; request_id: string; root_id: string; parent_id: string | null; title: string; body: string; from_kind: string
  target_repo_id: string | null; state: string; hold: string | null; waiting_on: string | null; reason: string | null; closure_reason: string | null
  closure_detail: string | null; result_summary: string | null; created_at: string; updated_at: string; json?: string | null
}

/** The fields a task keeps in its `json` column. */
const TASK_EXTRA = ['result', 'question', 'trigger', 'depth', 'cause', 'kind', 'requestedBy', 'contract', 'waitingFor', 'deliveries', 'awaiting', 'successorId', 'actionNews', 'event', 'causedBy', 'limitHold'] as const

type RawRoot = { root_id: string; org_id: string; runs_used: number; runs_allowed: number; descendants: number; active: number; state: string; created_at: string; updated_at: string }

const rootRow = (r: RawRoot): EmployeeRootLedger => ({
  rootId: r.root_id,
  orgId: r.org_id,
  runsUsed: r.runs_used,
  runsAllowed: r.runs_allowed,
  descendants: r.descendants,
  active: r.active,
  state: r.state as EmployeeRootLedger['state'],
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

function taskExtra(json: string | null | undefined): Partial<Pick<EmployeeTask, (typeof TASK_EXTRA)[number]>> {
  const extra = JSON.parse(json || '{}') as Partial<EmployeeTask>
  return Object.fromEntries(TASK_EXTRA.filter((k) => extra[k] !== undefined).map((k) => [k, extra[k]]))
}

type RawQuestion = {
  id: string; org_id: string; task_id: string; run_id: string; employee_id: string; question: string; options: string; workspace_id: string | null; session_id: string | null
  report_id: string | null; state: string; answer: string | null; asked_at: string; answered_at: string | null; updated_at: string
}

const questionRow = (r: RawQuestion): EmployeeQuestion => ({
  id: r.id,
  orgId: r.org_id,
  taskId: r.task_id,
  runId: r.run_id,
  employeeId: r.employee_id,
  question: r.question,
  options: JSON.parse(r.options || '[]') as string[],
  ...(r.workspace_id ? { workspaceId: r.workspace_id } : {}),
  ...(r.session_id ? { sessionId: r.session_id } : {}),
  ...(r.report_id ? { reportId: r.report_id } : {}),
  state: r.state as EmployeeQuestion['state'],
  ...(r.answer !== null ? { answer: r.answer } : {}),
  askedAt: r.asked_at,
  ...(r.answered_at ? { answeredAt: r.answered_at } : {}),
  updatedAt: r.updated_at
})

const taskRow = (r: RawTask): EmployeeTask => ({
  id: r.id,
  orgId: r.org_id,
  employeeId: r.employee_id,
  requestId: r.request_id,
  rootId: r.root_id,
  parentId: r.parent_id,
  title: r.title,
  body: r.body,
  from: r.from_kind as EmployeeTask['from'],
  targetRepoId: r.target_repo_id,
  state: r.state as EmployeeTask['state'],
  ...(r.hold ? { hold: r.hold as EmployeeTask['hold'] } : {}),
  ...(r.waiting_on ? { waitingOn: r.waiting_on as EmployeeTask['waitingOn'] } : {}),
  ...(r.reason ? { reason: r.reason } : {}),
  ...(r.closure_reason ? { closureReason: r.closure_reason as EmployeeTask['closureReason'] } : {}),
  ...(r.closure_detail ? { closureDetail: r.closure_detail } : {}),
  ...(r.result_summary ? { resultSummary: r.result_summary } : {}),
  ...taskExtra(r.json),
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

type RawRun = {
  id: string; task_id: string; employee_id: string; org_id: string; attempt: number; state: string; started: number; workspace_id: string | null; session_id: string | null
  turn_ids: string; agent: string | null; model: string | null; memory_base: string | null; memory_commit: string | null; usage: string | null; reason: string | null; json: string
  created_at: string; admitted_at: string | null; started_at: string | null; ended_at: string | null; updated_at: string
}

/** The fields a run keeps in its `json` column. */
const RUN_EXTRA = ['repoId', 'access', 'profile', 'attended', 'persona', 'effort', 'minutes', 'rootId', 'causeId', 'parked'] as const

const runRow = (r: RawRun): EmployeeRun => {
  const extra = JSON.parse(r.json || '{}') as Partial<EmployeeRun>
  const kept = Object.fromEntries(RUN_EXTRA.filter((k) => extra[k] !== undefined).map((k) => [k, extra[k]]))
  return {
    id: r.id,
    taskId: r.task_id,
    employeeId: r.employee_id,
    orgId: r.org_id,
    attempt: r.attempt,
    state: r.state as EmployeeRun['state'],
    started: r.started === 1,
    ...(r.workspace_id ? { workspaceId: r.workspace_id } : {}),
    ...(r.session_id ? { sessionId: r.session_id } : {}),
    turnIds: JSON.parse(r.turn_ids || '[]') as string[],
    ...(r.agent ? { agent: r.agent } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...kept,
    ...(r.memory_base ? { memoryBase: r.memory_base } : {}),
    ...(r.memory_commit ? { memoryCommit: r.memory_commit } : {}),
    ...(r.usage ? { usage: JSON.parse(r.usage) as EmployeeRun['usage'] } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    createdAt: r.created_at,
    ...(r.admitted_at ? { admittedAt: r.admitted_at } : {}),
    ...(r.started_at ? { startedAt: r.started_at } : {}),
    ...(r.ended_at ? { endedAt: r.ended_at } : {}),
    updatedAt: r.updated_at
  }
}

type RawAction = {
  id: string; org_id: string; employee_id: string; task_id: string; run_id: string; repo_id: string | null; kind: string; payload: string; policy: string; state: string
  idempotency_key: string; result: string | null; json: string; created_at: string; updated_at: string; sent_at: string | null; settled_at: string | null
}

/** The fields an action keeps in its `json` column. */
const ACTION_EXTRA = ['decidedBy', 'edited', 'reason'] as const

const actionRow = (r: RawAction): EmployeeAction => {
  const extra = JSON.parse(r.json || '{}') as Partial<EmployeeAction>
  return {
    id: r.id,
    orgId: r.org_id,
    employeeId: r.employee_id,
    taskId: r.task_id,
    runId: r.run_id,
    repoId: r.repo_id,
    kind: r.kind as EmployeeAction['kind'],
    payload: JSON.parse(r.payload) as EmployeeAction['payload'],
    policy: r.policy as EmployeeAction['policy'],
    state: r.state as EmployeeAction['state'],
    key: r.idempotency_key,
    ...Object.fromEntries(ACTION_EXTRA.filter((k) => extra[k] !== undefined).map((k) => [k, extra[k]])),
    ...(r.result ? { result: JSON.parse(r.result) as EmployeeAction['result'] } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.sent_at ? { sentAt: r.sent_at } : {}),
    ...(r.settled_at ? { settledAt: r.settled_at } : {})
  }
}

/** An action's columns, in the order the insert names them. */
function actionValues(a: EmployeeAction): (string | null)[] {
  const extra = Object.fromEntries(ACTION_EXTRA.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))
  return [
    a.id, a.orgId, a.employeeId, a.taskId, a.runId, a.repoId, a.kind, JSON.stringify(a.payload), a.policy, a.state, a.key, a.result ? JSON.stringify(a.result) : null,
    JSON.stringify(extra), a.createdAt, a.updatedAt, a.sentAt ?? null, a.settledAt ?? null
  ]
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
    // Synchronous, on the main thread, once per saved chat item: `db.putItem` shows what that costs.
    perf.timed('db.putItem', () => {
      const { text, toolText } = itemText(item)
      const given = 'at' in item && typeof item.at === 'string' ? item.at : (fallbackAt ?? null)
      this.stmt(
        `INSERT INTO items (session_id, id, kind, turn_id, at, json, text, tool_text, superseded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(session_id, id) DO UPDATE SET kind = excluded.kind, turn_id = excluded.turn_id,
           at = CASE WHEN ? IS NOT NULL THEN excluded.at ELSE items.at END,
           json = excluded.json, text = excluded.text, tool_text = excluded.tool_text, superseded = 0`
      ).run(sessionId, item.id, item.kind, 'turnId' in item ? item.turnId ?? null : null, given ?? new Date().toISOString(), JSON.stringify(item), text, toolText, given)
      this.putAttachments(sessionId, item)
    })
  }

  private putAttachments(sessionId: string, item: ChatItem): void {
    this.stmt('DELETE FROM attachments WHERE session_id = ? AND item_id = ?').run(sessionId, item.id)
    if (item.kind !== 'user') return
    for (const a of item.attachments ?? []) this.stmt('INSERT INTO attachments (session_id, item_id, name, path, kind) VALUES (?, ?, ?, ?, ?)').run(sessionId, item.id, a.name, a.path, a.kind)
  }

  /** The chat in order, one entry per id (the last write of it). */
  readItems(sessionId: string): ChatItem[] {
    // A whole chat read and parsed, synchronously: `db.readChat`.
    return perf.timed('db.readChat', () =>
      (this.stmt('SELECT json FROM items WHERE session_id = ? AND superseded = 0 ORDER BY seq').all(sessionId) as { json: string }[]).map((r) => JSON.parse(r.json) as ChatItem)
    )
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

  // ---- memory repositories (main/memory.ts) ----

  /** The last commit the memory service made (or accepted) in an organization's memory repository. */
  memoryBaseline(orgId: string): string | undefined {
    return (this.stmt('SELECT head FROM memory_heads WHERE org_id = ?').get(orgId) as { head: string } | undefined)?.head
  }

  setMemoryBaseline(orgId: string, head: string, at = new Date().toISOString()): void {
    this.stmt('INSERT INTO memory_heads (org_id, head, at) VALUES (?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET head = excluded.head, at = excluded.at').run(orgId, head, at)
  }

  putMemoryMutation(row: MemoryMutationRow): void {
    this.stmt(
      `INSERT INTO memory_mutations (id, org_id, run_id, state, expected_head, commit_id, paths, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, expected_head = excluded.expected_head, commit_id = excluded.commit_id, paths = excluded.paths, json = excluded.json, updated_at = excluded.updated_at`
    ).run(row.id, row.orgId, row.runId, row.state, row.expectedHead, row.commitId, JSON.stringify(row.paths), JSON.stringify(row.detail), row.createdAt, row.updatedAt)
  }

  memoryMutation(id: string): MemoryMutationRow | undefined {
    const r = this.stmt('SELECT * FROM memory_mutations WHERE id = ?').get(id) as RawMutation | undefined
    return r && mutationRow(r)
  }

  /** An organization's intents, oldest first; only those in `states` when given. */
  memoryMutations(orgId: string | null, states?: readonly string[]): MemoryMutationRow[] {
    const rows = (orgId === null ? this.stmt('SELECT * FROM memory_mutations ORDER BY created_at, rowid').all() : this.stmt('SELECT * FROM memory_mutations WHERE org_id = ? ORDER BY created_at, rowid').all(orgId)) as unknown as RawMutation[]
    return rows.map(mutationRow).filter((r) => !states || states.includes(r.state))
  }

  /** The index's files for an organization: path → blob. */
  memoryDocs(orgId: string): Map<string, string> {
    const rows = this.stmt('SELECT path, blob FROM memory_docs WHERE org_id = ?').all(orgId) as { path: string; blob: string }[]
    return new Map(rows.map((r) => [r.path, r.blob]))
  }

  putMemoryDoc(orgId: string, path: string, blob: string, text: string): void {
    this.stmt('INSERT INTO memory_docs (org_id, path, blob, text) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, path) DO UPDATE SET blob = excluded.blob, text = excluded.text').run(orgId, path, blob, text)
  }

  deleteMemoryDoc(orgId: string, path: string): void {
    this.stmt('DELETE FROM memory_docs WHERE org_id = ? AND path = ?').run(orgId, path)
  }

  /** Forget an organization's index (or every one): the next search builds it again. */
  clearMemoryIndex(orgId?: string): void {
    if (orgId === undefined) this.stmt('DELETE FROM memory_docs').run()
    else this.stmt('DELETE FROM memory_docs WHERE org_id = ?').run(orgId)
  }

  /** Files matching an FTS5 expression (shared/chatIndex.ts ftsQuery) in path or text, best first. */
  searchMemory(orgId: string, match: string, limit: number): { path: string; blob: string; snippet: string; rank: number }[] {
    return this.stmt(
      `SELECT d.path AS path, d.blob AS blob, snippet(memory_fts, 1, char(1), char(2), '…', 14) AS snippet, bm25(memory_fts) AS rank
       FROM memory_fts JOIN memory_docs d ON d.seq = memory_fts.rowid
       WHERE memory_fts MATCH ? AND d.org_id = ?
       ORDER BY rank, d.path LIMIT ?`
    ).all(match, orgId, limit) as { path: string; blob: string; snippet: string; rank: number }[]
  }

  // ---- AI employees' tasks and runs (main/employeeWork.ts) ----

  putEmployeeTask(t: EmployeeTask): void {
    this.stmt(
      `INSERT INTO employee_tasks (id, org_id, employee_id, request_id, root_id, parent_id, title, body, from_kind, target_repo_id, state, hold, waiting_on, reason, closure_reason, closure_detail, result_summary, json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, body = excluded.body, target_repo_id = excluded.target_repo_id, state = excluded.state, hold = excluded.hold,
         waiting_on = excluded.waiting_on, reason = excluded.reason, closure_reason = excluded.closure_reason, closure_detail = excluded.closure_detail,
         result_summary = excluded.result_summary, json = excluded.json, updated_at = excluded.updated_at`
    ).run(
      t.id, t.orgId, t.employeeId, t.requestId, t.rootId, t.parentId, t.title, t.body, t.from, t.targetRepoId, t.state, t.hold ?? null, t.waitingOn ?? null, t.reason ?? null,
      t.closureReason ?? null, t.closureDetail ?? null, t.resultSummary ?? null, JSON.stringify(Object.fromEntries(TASK_EXTRA.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]))),
      t.createdAt, t.updatedAt
    )
  }

  employeeTask(id: string): EmployeeTask | undefined {
    const r = this.stmt('SELECT * FROM employee_tasks WHERE id = ?').get(id) as RawTask | undefined
    return r && taskRow(r)
  }

  /** An organization's tasks (one employee's when given), newest first; only those in `states` when given. */
  employeeTasks(orgId: string, options: { employeeId?: string; states?: readonly string[]; limit?: number } = {}): EmployeeTask[] {
    const rows = (options.employeeId
      ? this.stmt('SELECT * FROM employee_tasks WHERE org_id = ? AND employee_id = ? ORDER BY created_at DESC, rowid DESC').all(orgId, options.employeeId)
      : this.stmt('SELECT * FROM employee_tasks WHERE org_id = ? ORDER BY created_at DESC, rowid DESC').all(orgId)) as unknown as RawTask[]
    const out = rows.map(taskRow).filter((t) => !options.states || options.states.includes(t.state))
    return options.limit ? out.slice(0, options.limit) : out
  }

  /** The task an organization made for a request id, if any (each request id makes one task: a trigger's firing after a crash dedupes on it). */
  employeeTaskByRequest(orgId: string, requestId: string): EmployeeTask | undefined {
    const r = this.stmt('SELECT * FROM employee_tasks WHERE org_id = ? AND request_id = ?').get(orgId, requestId) as RawTask | undefined
    return r && taskRow(r)
  }

  /** Every task in these states, in any organization, oldest first. */
  employeeTasksIn(states: readonly string[]): EmployeeTask[] {
    const rows = this.stmt('SELECT * FROM employee_tasks ORDER BY created_at, rowid').all() as unknown as RawTask[]
    return rows.map(taskRow).filter((t) => states.includes(t.state))
  }

  /** Every task of one chain (its root's id), oldest first. */
  employeeTasksOfRoot(rootId: string): EmployeeTask[] {
    return (this.stmt('SELECT * FROM employee_tasks WHERE root_id = ? ORDER BY created_at, rowid').all(rootId) as unknown as RawTask[]).map(taskRow)
  }

  /** A task's children (the tasks handed off from it), oldest first. */
  employeeTaskChildren(taskId: string): EmployeeTask[] {
    return (this.stmt('SELECT * FROM employee_tasks WHERE parent_id = ? ORDER BY created_at, rowid').all(taskId) as unknown as RawTask[]).map(taskRow)
  }

  putEmployeeRoot(r: EmployeeRootLedger): void {
    this.stmt(
      `INSERT INTO employee_roots (root_id, org_id, runs_used, runs_allowed, descendants, active, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (root_id) DO UPDATE SET runs_used = excluded.runs_used, runs_allowed = excluded.runs_allowed, descendants = excluded.descendants,
         active = excluded.active, state = excluded.state, updated_at = excluded.updated_at`
    ).run(r.rootId, r.orgId, r.runsUsed, r.runsAllowed, r.descendants, r.active, r.state, r.createdAt, r.updatedAt)
  }

  employeeRoot(rootId: string): EmployeeRootLedger | undefined {
    const r = this.stmt('SELECT * FROM employee_roots WHERE root_id = ?').get(rootId) as RawRoot | undefined
    return r && rootRow(r)
  }

  /** How many of a chain's tasks aren't closed. */
  activeInRoot(rootId: string): number {
    return (this.stmt("SELECT count(*) AS n FROM employee_tasks WHERE root_id = ? AND state != 'closed'").get(rootId) as { n: number }).n
  }

  /** Each employee's last closed task in an organization. */
  lastClosedEmployeeTasks(orgId: string): EmployeeTask[] {
    const rows = this.stmt(
      `SELECT t.* FROM employee_tasks t
       JOIN (SELECT employee_id, MAX(updated_at) AS at FROM employee_tasks WHERE org_id = ? AND state = 'closed' GROUP BY employee_id) last
       ON last.employee_id = t.employee_id AND last.at = t.updated_at
       WHERE t.org_id = ? AND t.state = 'closed'`
    ).all(orgId, orgId) as unknown as RawTask[]
    return rows.map(taskRow)
  }

  addEmployeeTaskTransition(tr: Omit<EmployeeTaskTransition, 'seq'>): void {
    this.stmt('INSERT INTO employee_task_transitions (task_id, run_id, at, from_state, to_state, event, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tr.taskId, tr.runId, tr.at, tr.from, tr.to, tr.event, tr.detail ?? null)
  }

  employeeTaskTransitions(taskId: string): EmployeeTaskTransition[] {
    const rows = this.stmt('SELECT * FROM employee_task_transitions WHERE task_id = ? ORDER BY seq').all(taskId) as {
      seq: number; task_id: string; run_id: string | null; at: string; from_state: string | null; to_state: string; event: string; detail: string | null
    }[]
    return rows.map((r) => ({ seq: r.seq, taskId: r.task_id, runId: r.run_id, at: r.at, from: r.from_state as EmployeeTaskTransition['from'], to: r.to_state as EmployeeTaskTransition['to'], event: r.event, ...(r.detail ? { detail: r.detail } : {}) }))
  }

  putEmployeeRun(run: EmployeeRun): void {
    const extra = Object.fromEntries(RUN_EXTRA.filter((k) => run[k] !== undefined).map((k) => [k, run[k]]))
    this.stmt(
      `INSERT INTO employee_runs (id, task_id, employee_id, org_id, attempt, state, started, workspace_id, session_id, turn_ids, agent, model, memory_base, memory_commit, usage, reason, json, created_at, admitted_at, started_at, ended_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, started = excluded.started, workspace_id = excluded.workspace_id, session_id = excluded.session_id,
         turn_ids = excluded.turn_ids, agent = excluded.agent, model = excluded.model, memory_base = excluded.memory_base, memory_commit = excluded.memory_commit,
         usage = excluded.usage, reason = excluded.reason, json = excluded.json, admitted_at = excluded.admitted_at, started_at = excluded.started_at,
         ended_at = excluded.ended_at, updated_at = excluded.updated_at`
    ).run(
      run.id, run.taskId, run.employeeId, run.orgId, run.attempt, run.state, run.started ? 1 : 0, run.workspaceId ?? null, run.sessionId ?? null, JSON.stringify(run.turnIds),
      run.agent ?? null, run.model ?? null, run.memoryBase ?? null, run.memoryCommit ?? null, run.usage ? JSON.stringify(run.usage) : null, run.reason ?? null,
      JSON.stringify(extra), run.createdAt, run.admittedAt ?? null, run.startedAt ?? null, run.endedAt ?? null, run.updatedAt
    )
  }

  employeeRun(id: string): EmployeeRun | undefined {
    const r = this.stmt('SELECT * FROM employee_runs WHERE id = ?').get(id) as RawRun | undefined
    return r && runRow(r)
  }

  /** Runs, newest first: an organization's (one employee's, one task's when given), or every organization's in `states`. */
  employeeRuns(options: { orgId?: string; employeeId?: string; taskId?: string; sessionId?: string; states?: readonly string[]; limit?: number } = {}): EmployeeRun[] {
    const where: string[] = []
    const args: string[] = []
    for (const [column, value] of [['org_id', options.orgId], ['employee_id', options.employeeId], ['task_id', options.taskId], ['session_id', options.sessionId]] as const) {
      if (value === undefined) continue
      where.push(`${column} = ?`)
      args.push(value)
    }
    const sql = `SELECT * FROM employee_runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC`
    const out = (this.stmt(sql).all(...args) as unknown as RawRun[]).map(runRow).filter((r) => !options.states || options.states.includes(r.state))
    return options.limit ? out.slice(0, options.limit) : out
  }

  putEmployeeQuestion(q: EmployeeQuestion): void {
    this.stmt(
      `INSERT INTO employee_questions (id, org_id, task_id, run_id, employee_id, question, options, workspace_id, session_id, report_id, state, answer, asked_at, answered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET report_id = excluded.report_id, state = excluded.state, answer = excluded.answer, answered_at = excluded.answered_at, updated_at = excluded.updated_at`
    ).run(
      q.id, q.orgId, q.taskId, q.runId, q.employeeId, q.question, JSON.stringify(q.options), q.workspaceId ?? null, q.sessionId ?? null, q.reportId ?? null, q.state,
      q.answer ?? null, q.askedAt, q.answeredAt ?? null, q.updatedAt
    )
  }

  employeeQuestion(id: string): EmployeeQuestion | undefined {
    const r = this.stmt('SELECT * FROM employee_questions WHERE id = ?').get(id) as RawQuestion | undefined
    return r && questionRow(r)
  }

  /** A task's questions, oldest first. */
  employeeQuestions(taskId: string): EmployeeQuestion[] {
    return (this.stmt('SELECT * FROM employee_questions WHERE task_id = ? ORDER BY asked_at, rowid').all(taskId) as unknown as RawQuestion[]).map(questionRow)
  }

  /**
   * Record a new outward action. False (and nothing written) when an action with its idempotency key exists already:
   * the caller reads that one instead.
   */
  addEmployeeAction(a: EmployeeAction): boolean {
    const r = this.stmt(
      `INSERT OR IGNORE INTO employee_actions (id, org_id, employee_id, task_id, run_id, repo_id, kind, payload, policy, state, idempotency_key, result, json, created_at, updated_at, sent_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...actionValues(a))
    return Number(r.changes) > 0
  }

  /** Save an action's new state (its payload too: a person's edit changes its words, never its destination). */
  putEmployeeAction(a: EmployeeAction): void {
    this.stmt(
      `INSERT INTO employee_actions (id, org_id, employee_id, task_id, run_id, repo_id, kind, payload, policy, state, idempotency_key, result, json, created_at, updated_at, sent_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, state = excluded.state, result = excluded.result, json = excluded.json, updated_at = excluded.updated_at,
         sent_at = excluded.sent_at, settled_at = excluded.settled_at`
    ).run(...actionValues(a))
  }

  employeeAction(id: string): EmployeeAction | undefined {
    const r = this.stmt('SELECT * FROM employee_actions WHERE id = ?').get(id) as RawAction | undefined
    return r && actionRow(r)
  }

  employeeActionByKey(key: string): EmployeeAction | undefined {
    const r = this.stmt('SELECT * FROM employee_actions WHERE idempotency_key = ?').get(key) as RawAction | undefined
    return r && actionRow(r)
  }

  /** Actions, oldest first, narrowed by organization, task, run, employee, state, and those made since a time. */
  employeeActions(options: { orgId?: string; taskId?: string; runId?: string; employeeId?: string; states?: readonly string[]; since?: string } = {}): EmployeeAction[] {
    const where: string[] = []
    const args: string[] = []
    for (const [column, value] of [['org_id', options.orgId], ['task_id', options.taskId], ['run_id', options.runId], ['employee_id', options.employeeId]] as const) {
      if (value === undefined) continue
      where.push(`${column} = ?`)
      args.push(value)
    }
    if (options.since) {
      where.push('created_at >= ?')
      args.push(options.since)
    }
    const sql = `SELECT * FROM employee_actions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid`
    return (this.stmt(sql).all(...args) as unknown as RawAction[]).map(actionRow).filter((a) => !options.states || options.states.includes(a.state))
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
