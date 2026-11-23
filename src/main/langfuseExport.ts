// Sending Foreman's own traces to Langfuse (docs/telemetry.md, "Langfuse"). Off until the person at this computer's
// window picks a Langfuse connection for it (a `window`-scope call: no phone, browser, paired computer, CLI or agent can).
// Then every turn that ends from that moment is sent as a trace, and Foreman's stalls and errors as events; "Send
// earlier turns" sends the turns of the last days and the event log's lines too. Each turn and event goes once per
// destination (the ledger in foreman.db): Langfuse doesn't reliably merge a span sent twice. Sending runs in the
// background, a turn at a time, and never retries a refused key: the connection is marked and sending stops.
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentCapabilities } from '../shared/agentCapabilities'
import type { DiagnosticEvent } from '../shared/diagnostics'
import type { LangfuseExportChoice, LangfuseExportConfig, LangfuseExportStatus, LangfuseReach } from '../shared/langfuseExport'
import type { Connection } from '../shared/integrations'
import type { ChatItem, Repo, Session, Workspace } from '../shared/types'
import type { ForemanDb } from './db'
import { LangfuseError, langfuseProject, type Fetch } from './langfuse'
import { claudeTurnParts, eventKey, eventSpan, exportedEvent, itemTools, otlpRequest, turnSpans, type OtlpSpan, type SenderFacts, type TurnFacts } from './langfuseTrace'

// A turn's trace waits this long after it ends, so the transcript mirror has written its last entries.
const TURN_DELAY_MS = 5_000
// After Foreman starts, Langfuse is asked once whether it answers, so a project that is down or refuses the keys is said.
const CHECK_DELAY_MS = 15_000
// Events wait to be sent together.
const EVENT_DELAY_MS = 30_000
// Everything not yet sent is looked for again this often (a send that failed, a turn missed while offline).
const SWEEP_MS = 10 * 60_000
// One request stays well under Langfuse Cloud's 5 MB.
const MAX_BATCH_BYTES = 2_500_000
const MAX_BATCH_TURNS = 20
// Transcript entries this close outside a turn's start and end still belong to it (clocks of the writes differ a little).
const EDGE_MS = 2_000
const DAY = 24 * 60 * 60 * 1000

export interface LangfuseExportDeps {
  store: { state: { langfuseExport?: LangfuseExportConfig; sessions: Session[]; workspaces: Workspace[]; repos: Repo[] }; save(): void }
  db: () => ForemanDb
  // What an agent reports (a running-total cost) and keeps (a mirrored transcript), from its capability record.
  capabilities: (agent: string) => AgentCapabilities | undefined
  connection: (id: string) => Connection | undefined
  secret: (id: string) => string | undefined
  markProblem: (id: string, problem: string) => void
  // Tells the window Langfuse didn't answer (or refused the keys) when Foreman started.
  notify?: (problem: { host: string; refused: boolean }) => void
  device: () => { id: string; name: string }
  // The event log's recent events (the ring, kept whether or not Keep diagnostics is on) and its files' folder.
  recentEvents: () => DiagnosticEvent[]
  logsDir: string
  version: string
  packaged: boolean
  platform?: string
  machine?: () => string
  fetch?: Fetch
  now?: () => number
  changed: () => void
}

type Job = { since: string; fromLog: boolean; backfillDays?: number }

export class LangfuseExport {
  private sentTurns = 0
  private sentEvents = 0
  private lastSentAt?: string
  private lastError?: string
  private backfill?: { days: number; done: number; total: number }
  private reach?: LangfuseReach
  private checking: Promise<void> | null = null
  private running: Promise<void> | null = null
  private queued: Job | null = null
  private turnTimer?: ReturnType<typeof setTimeout>
  private eventTimer?: ReturnType<typeof setTimeout>
  private sweepTimer?: ReturnType<typeof setInterval>
  private readonly startedAt: string
  private runAt?: string

  constructor(private deps: LangfuseExportDeps) {
    this.startedAt = new Date(this.now()).toISOString()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private machine(): string {
    return (this.deps.machine ?? os.hostname)()
  }

  /** The choice, when it was made at this computer. */
  private config(): LangfuseExportConfig | undefined {
    const c = this.deps.store.state.langfuseExport
    return c && c.machine === this.machine() ? c : undefined
  }

  /** The connection to send to, with its keys, or why not. */
  private destination(): { connection: Connection; host: string; publicKey: string; secretKey: string; target: string } | { off: string } {
    const config = this.config()
    if (!config) return { off: 'off' }
    const connection = this.deps.connection(config.connectionId)
    if (!connection || connection.service !== 'langfuse' || !connection.langfuse) return { off: 'The Langfuse connection chosen for sending no longer exists. Choose one again.' }
    const secretKey = this.deps.secret(connection.id)
    if (!secretKey) return { off: 'The Langfuse connection has no secret key. Replace its keys in Settings → Integrations.' }
    const { host, publicKey } = connection.langfuse
    // The key pair names one project: the same project re-added under another connection keeps what was sent.
    return { connection, host, publicKey, secretKey, target: `${host}|${publicKey}` }
  }

  status(): LangfuseExportStatus {
    const stored = this.deps.store.state.langfuseExport
    const config = this.config()
    return {
      connectionId: config?.connectionId ?? null,
      content: config?.content ?? false,
      ...(stored && !config ? { otherMachine: stored.machine } : {}),
      ...(config ? { enabledAt: config.enabledAt } : {}),
      device: this.deps.device(),
      ...(this.lastSentAt ? { lastSentAt: this.lastSentAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      sentTurns: this.sentTurns,
      sentEvents: this.sentEvents,
      ...(this.backfill ? { backfill: { ...this.backfill } } : {}),
      ...(this.reach && config ? { reach: { ...this.reach } } : {})
    }
  }

  /** Turns sending on (to a Langfuse connection) or off. Only the window calls this. */
  configure(choice: LangfuseExportChoice): LangfuseExportStatus {
    if (!choice.connectionId) {
      delete this.deps.store.state.langfuseExport
      this.lastError = undefined
      this.reach = undefined
    } else {
      const connection = this.deps.connection(choice.connectionId)
      if (!connection || connection.service !== 'langfuse') throw new Error('Choose a Langfuse connection.')
      const old = this.config()
      // From now on, unless it was already on for the same connection (then only the content choice changes).
      const enabledAt = old && old.connectionId === choice.connectionId ? old.enabledAt : new Date(this.now()).toISOString()
      this.deps.store.state.langfuseExport = { connectionId: choice.connectionId, content: choice.content, machine: this.machine(), enabledAt }
      this.lastError = undefined
    }
    this.deps.store.save()
    this.deps.changed()
    if (this.config()) {
      // A project chosen now is checked at once; the section says the answer, no toast.
      this.checking = this.check(false).finally(() => (this.checking = null))
      this.schedule({ since: this.config()!.enabledAt, fromLog: false })
    }
    return this.status()
  }

  /** Sends the turns and events of the last `days` that weren't sent yet. */
  sendEarlier(days: number): LangfuseExportStatus {
    if (!this.config()) throw new Error('Turn on sending to Langfuse first.')
    const since = new Date(this.now() - Math.max(1, Math.min(365, days)) * DAY).toISOString()
    this.backfill = { days, done: 0, total: 0 }
    this.schedule({ since, fromLog: true, backfillDays: days })
    return this.status()
  }

  /** Starts the sweep; the first one shortly after startup catches up on what ended while Foreman was closed. */
  start(): void {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS)
    this.sweepTimer.unref?.()
    const first = setTimeout(() => this.sweep(), 30_000)
    first.unref?.()
    const check = setTimeout(() => void this.check(true), CHECK_DELAY_MS)
    check.unref?.()
  }

  /**
   * Asks Langfuse who the connection's keys belong to, which needs both an answer and keys it accepts. `announce`: tell
   * the window when it fails (at startup); either way the section shows it until a check or a send succeeds.
   */
  async check(announce: boolean): Promise<void> {
    const dest = this.destination()
    if ('off' in dest) return
    let state: LangfuseReach['state'] = 'ok'
    try {
      await langfuseProject({ host: dest.host, publicKey: dest.publicKey, secretKey: dest.secretKey }, this.deps.fetch)
    } catch (err) {
      const refused = err instanceof LangfuseError && err.auth
      state = refused ? 'refused' : 'unreachable'
      this.lastError = err instanceof Error ? err.message : String(err)
      if (refused) this.deps.markProblem(dest.connection.id, this.lastError)
    }
    // Turned off or moved to another project while it was asking: that answer no longer applies.
    const now = this.destination()
    if ('off' in now || now.target !== dest.target) return
    this.reached(state, dest.host)
    if (state !== 'ok' && announce) this.deps.notify?.({ host: dest.host, refused: state === 'refused' })
  }

  private reached(state: LangfuseReach['state'], host: string): void {
    if (state === 'ok' && this.reach?.state !== 'ok') this.lastError = undefined
    this.reach = { state, host, at: new Date(this.now()).toISOString() }
    this.deps.changed()
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.turnTimer) clearTimeout(this.turnTimer)
    if (this.eventTimer) clearTimeout(this.eventTimer)
  }

  /** The event log's listener: a turn that ended, or an event worth sending. */
  onEvent(event: DiagnosticEvent): void {
    // This run's start as the event log has it, so its events share the trace the log's lines would give them.
    if (event.kind === 'app.start') this.runAt = event.at
    const config = this.config()
    if (!config) return
    if (event.kind === 'turn.end') {
      if (this.turnTimer) clearTimeout(this.turnTimer)
      this.turnTimer = setTimeout(() => this.sweep(), TURN_DELAY_MS)
    } else if (exportedEvent(event) && !this.eventTimer) {
      this.eventTimer = setTimeout(() => {
        this.eventTimer = undefined
        this.sweep()
      }, EVENT_DELAY_MS)
    }
  }

  private sweep(): void {
    const config = this.config()
    if (config) this.schedule({ since: config.enabledAt, fromLog: false })
  }

  /** One job at a time; a job asked for meanwhile runs next (the wider one, when two are waiting). */
  private schedule(job: Job): void {
    if (this.running) {
      this.queued = !this.queued || job.since < this.queued.since || job.backfillDays ? job : this.queued
      return
    }
    this.running = this.run(job)
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        this.running = null
        if (this.backfill && job.backfillDays) this.backfill = undefined
        this.deps.changed()
        const next = this.queued
        this.queued = null
        if (next) this.schedule(next)
      })
  }

  /** Waits until no job or check is running or waiting (tests, quitting). */
  async idle(): Promise<void> {
    while (this.running || this.checking) {
      await this.checking
      await this.running
    }
  }

  private sender(): SenderFacts {
    return { device: this.deps.device(), version: this.deps.version, platform: this.deps.platform ?? process.platform, environment: this.deps.packaged ? 'production' : 'development' }
  }

  private async run(job: Job): Promise<void> {
    const dest = this.destination()
    if ('off' in dest) {
      if (dest.off !== 'off') this.lastError = dest.off
      return
    }
    const config = this.config()!
    const db = this.deps.db()
    const sender = this.sender()

    // Turns, once each: a forked chat repeats its parent's turns under the same id.
    const seen = new Set<string>()
    const turns = db.endedTurns(job.since).filter((t) => (seen.has(t.turnId) ? false : (seen.add(t.turnId), true)))
    const sentTurns = db.langfuseSent(dest.target, turns.map((t) => `turn:${t.turnId}`))
    const todo = turns.filter((t) => !sentTurns.has(`turn:${t.turnId}`))

    const events = await this.events(job)
    const sentEvents = db.langfuseSent(dest.target, events.map((e) => eventKey(e.event)))
    const newEvents = events.filter((e) => !sentEvents.has(eventKey(e.event)))

    if (this.backfill && job.backfillDays) this.backfill.total = todo.length + newEvents.length
    this.deps.changed()

    let batch: OtlpSpan[] = []
    let keys: string[] = []
    let bytes = 0
    let batchTurns = 0
    const flush = async () => {
      if (!batch.length) return
      this.lastError = undefined
      await this.send(dest, batch, sender)
      db.markLangfuseSent(dest.target, keys, new Date(this.now()).toISOString())
      const turnsSent = keys.filter((k) => k.startsWith('turn:')).length
      this.sentTurns += turnsSent
      this.sentEvents += keys.length - turnsSent
      if (this.backfill && job.backfillDays) this.backfill.done += keys.length
      this.lastSentAt = new Date(this.now()).toISOString()
      this.deps.changed()
      batch = []
      keys = []
      bytes = 0
      batchTurns = 0
    }

    for (const t of todo) {
      // A turn at a time, letting everything else run in between: this reads and parses its items and transcript.
      await new Promise((resolve) => setImmediate(resolve))
      if (!this.config()) return
      const facts = this.turnFacts(db, t.sessionId, t.turnId, config.content)
      if (!facts) continue
      const spans = turnSpans(facts, sender, config.content)
      const size = JSON.stringify(spans).length
      if (batch.length && (bytes + size > MAX_BATCH_BYTES || batchTurns >= MAX_BATCH_TURNS)) await flush()
      batch.push(...spans)
      keys.push(`turn:${t.turnId}`)
      bytes += size
      batchTurns++
    }
    for (const { event, run } of newEvents) {
      const span = eventSpan(event, run, sender)
      const size = JSON.stringify(span).length
      if (batch.length && bytes + size > MAX_BATCH_BYTES) await flush()
      batch.push(span)
      keys.push(eventKey(event))
      bytes += size
    }
    await flush()
  }

  /** Events to send, each with the start of the app run it happened in: the ring's, and for earlier ones the log's. */
  private async events(job: Job): Promise<{ event: DiagnosticEvent; run: string }[]> {
    const out = new Map<string, { event: DiagnosticEvent; run: string }>()
    // An event belongs to the run of the last app.start before it; this run's own start is the fallback.
    let run = this.startedAt
    const take = (lines: DiagnosticEvent[]) => {
      for (const event of lines) {
        if (event.kind === 'app.start') run = event.at
        if (event.at < job.since || !exportedEvent(event)) continue
        if (!out.has(eventKey(event))) out.set(eventKey(event), { event, run })
      }
    }
    if (job.fromLog) {
      // The previous file first: it holds the older lines. Each is at most 5 MB (LOG_MAX_BYTES).
      for (const name of ['foreman.log.1', 'foreman.log']) {
        const text = await readFile(path.join(this.deps.logsDir, name), 'utf8').catch(() => '')
        take(text.split('\n').flatMap((line) => {
          if (!line) return []
          try {
            const parsed = JSON.parse(line) as DiagnosticEvent
            return parsed && typeof parsed.at === 'string' && typeof parsed.kind === 'string' ? [parsed] : []
          } catch {
            return []
          }
        }))
      }
    }
    // The ring: this run's events, Keep diagnostics on or off.
    run = this.runAt ?? this.startedAt
    take(this.deps.recentEvents())
    return [...out.values()].sort((a, b) => a.event.at.localeCompare(b.event.at))
  }

  /** What one turn did, read from its items and (for Claude) its mirrored transcript. Null when it has no end. */
  private turnFacts(db: ForemanDb, sessionId: string, turnId: string, content: boolean): TurnFacts | null {
    const rows = db.turnItems(sessionId, turnId)
    const endRow = rows.find((r) => r.item.kind === 'turn-end')
    if (!endRow || endRow.item.kind !== 'turn-end') return null
    const end = endRow.item
    const endedAt = endRow.at
    const userRow = rows.find((r) => r.item.kind === 'user')
    const user = userRow?.item.kind === 'user' ? userRow.item : undefined
    const startedAt = user?.at ?? (end.durationMs ? new Date(Date.parse(endedAt) - end.durationMs).toISOString() : endedAt)
    const resultRow = [...rows].reverse().find((r) => r.item.kind === 'result')
    const result = resultRow?.item.kind === 'result' ? resultRow.item : undefined

    const { sessions, workspaces, repos } = this.deps.store.state
    const session = sessions.find((s) => s.id === sessionId)
    const ws = workspaces.find((w) => w.id === session?.workspaceId)
    const repo = ws ? repos.find((r) => r.id === ws.repoId) : undefined
    const agent = user?.agent ?? session?.agent ?? 'unknown'
    const model = user?.model ?? session?.model

    const caps = this.deps.capabilities(agent)
    let costUsd: number | undefined
    if (result?.costUsd !== undefined && resultRow) {
      if (caps?.usage.costRunningTotal) {
        // A running total for the conversation: this turn's share is what it added. One that went down (a /clear,
        // a crash's zeroed result) says nothing about this turn.
        const before = db.resultBefore(sessionId, resultRow.seq)
        const delta = result.costUsd - (before?.costUsd ?? 0)
        costUsd = delta >= 0 ? delta : undefined
      } else costUsd = result.costUsd
    }

    let parts: Pick<TurnFacts, 'calls' | 'tools' | 'subagents'> = { calls: [], tools: [], subagents: [] }
    if (caps?.features.transcriptMirror) {
      const conversations = [...new Set([result?.agentSession, ...rows.map((r) => (r.item.kind === 'user' ? r.item.resumeFrom?.sessionId : undefined)), session?.agentSessionId].filter((id): id is string => Boolean(id)))]
      const from = new Date(Date.parse(startedAt) - EDGE_MS).toISOString()
      const to = new Date(Date.parse(endedAt) + EDGE_MS).toISOString()
      parts = claudeTurnParts(db.transcriptBetween(conversations, from, to), content)
    }
    if (!parts.calls.length) {
      const own = rows.filter((r) => r.item.kind !== 'turn-end')
      parts = {
        calls: result?.tokens ? [{ id: turnId, model: model || agent, start: startedAt, end: endedAt, tokens: result.tokens }] : [],
        tools: parts.tools.length ? parts.tools : itemTools(own, endedAt, content),
        subagents: parts.subagents
      }
    }

    const answer = [...rows].reverse().find((r): r is { item: Extract<ChatItem, { kind: 'assistant' }>; at: string; seq: number } => r.item.kind === 'assistant' && !r.item.parentToolUseId)?.item.text
    return {
      turnId,
      chatId: sessionId,
      workspace: { id: ws?.id ?? session?.workspaceId ?? '', name: ws?.name ?? '' },
      ...(repo ? { repo: { id: repo.id, name: repo.name } } : {}),
      agent,
      ...(model ? { model } : {}),
      startedAt,
      endedAt,
      outcome: end.outcome,
      ...(end.error ? { error: end.error } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(content && user?.text ? { prompt: user.text } : {}),
      ...(content && answer ? { answer } : {}),
      ...parts
    }
  }

  private async send(dest: { connection: Connection; host: string; publicKey: string; secretKey: string }, spans: OtlpSpan[], sender: SenderFacts): Promise<void> {
    const doFetch = this.deps.fetch ?? fetch
    let res: Response
    try {
      res = await doFetch(`${dest.host}/api/public/otel/v1/traces`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Basic ${Buffer.from(`${dest.publicKey}:${dest.secretKey}`).toString('base64')}`,
          'Content-Type': 'application/json',
          // Without it Langfuse may take up to ten minutes to show what arrived.
          'x-langfuse-ingestion-version': '4',
          'User-Agent': 'Foreman'
        },
        body: JSON.stringify(otlpRequest(spans, sender)),
        signal: AbortSignal.timeout(60_000)
      })
    } catch (err) {
      this.reached('unreachable', dest.host)
      throw new LangfuseError(`Couldn’t reach Langfuse at ${dest.host}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (res.status === 401 || res.status === 403) {
      const message = 'Langfuse refused this key pair. The keys may have been deleted, mistyped or made for another host.'
      this.deps.markProblem(dest.connection.id, message)
      this.reached('refused', dest.host)
      throw new LangfuseError(message, true)
    }
    if (res.status === 404) throw new LangfuseError(`${dest.host} doesn’t take OpenTelemetry traces. A self-hosted Langfuse needs version 3.22 or later.`)
    if (res.status === 429) throw new LangfuseError(`Langfuse is limiting requests${res.headers.get('retry-after') ? ` for ${res.headers.get('retry-after')} seconds` : ''}. Foreman tries again later.`)
    const body = (await res.json().catch(() => null)) as { partialSuccess?: { rejectedSpans?: number | string; errorMessage?: string }; message?: string } | null
    if (!res.ok) throw new LangfuseError(`Langfuse answered ${res.status}${body?.message ? `: ${body.message}` : ''}`)
    this.reached('ok', dest.host)
    // Spans Langfuse turned down are said, not sent again: the same spans would be turned down again.
    const rejected = Number(body?.partialSuccess?.rejectedSpans ?? 0)
    if (rejected > 0) this.lastError = `Langfuse turned down ${rejected} of ${spans.length} spans${body?.partialSuccess?.errorMessage ? `: ${body.partialSuccess.errorMessage}` : ''}`
  }
}
