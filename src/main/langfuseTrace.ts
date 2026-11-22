// What Foreman sends Langfuse (docs/telemetry.md, "Langfuse"), built as OTLP/JSON spans: Langfuse's OpenTelemetry
// endpoint is its one way in (its batch ingestion API is retired), and it reads the `langfuse.*` attributes below.
// A turn is a trace: an `agent` span for the turn, a `generation` per model call with its tokens and cost, a `tool` span
// per tool call, and an `agent` span per subagent holding its own calls. Foreman's stalls and errors are `event` spans
// in one trace per app run. Pure: the service gathers the facts and sends; nothing here reads a file or the network.
import { createHash } from 'node:crypto'
import type { DiagnosticEvent } from '../shared/diagnostics'
import type { TokenCounts } from '../shared/langfuseExport'
import type { ChatItem, TurnOutcome } from '../shared/types'

/** Longest prompt, answer or tool text sent when content is on; longer is cut, saying how much was left out. */
export const MAX_TEXT = 8_000

export interface ToolCallFact {
  id: string
  name: string
  start: string
  end?: string
  error: boolean
  // The subagent that made it (its key in `subagents`).
  subagent?: string
  input?: unknown
  output?: unknown
}

export interface ModelCallFact {
  id: string
  model: string
  start: string
  end: string
  tokens: TokenCounts
  subagent?: string
  output?: string
}

export interface SubagentFact {
  key: string
  name: string
  start: string
  end: string
}

export interface TurnFacts {
  turnId: string
  chatId: string
  workspace: { id: string; name: string }
  repo?: { id: string; name: string }
  agent: string
  model?: string
  startedAt: string
  endedAt: string
  outcome: TurnOutcome
  error?: string
  // What the agent said the turn cost, when it did.
  costUsd?: number
  prompt?: string
  answer?: string
  calls: ModelCallFact[]
  tools: ToolCallFact[]
  subagents: SubagentFact[]
}

/** Who sends: the same on every span, so any observation can be filtered by it. */
export interface SenderFacts {
  device: { id: string; name: string }
  version: string
  platform: string
  // `production` for an installed Foreman, `development` for one run from source.
  environment: string
}

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: AnyValue[] } }
export interface KeyValue {
  key: string
  value: AnyValue
}
export interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: 1
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: KeyValue[]
  status?: { code: 0 | 1 | 2; message?: string }
}
export interface OtlpRequest {
  resourceSpans: { resource: { attributes: KeyValue[] }; scopeSpans: { scope: { name: string; version: string }; spans: OtlpSpan[] }[] }[]
}

const hex = (key: string, length: number) => createHash('sha256').update(key).digest('hex').slice(0, length)
/** A trace id from a stable key, so the same turn is the same trace from whichever computer or run sends it. */
export const traceIdFor = (key: string) => hex(`trace:${key}`, 32)
const spanIdFor = (key: string) => hex(`span:${key}`, 16)

function nanos(iso: string): string {
  const ms = Date.parse(iso)
  return (BigInt(Number.isFinite(ms) ? ms : 0) * 1_000_000n).toString()
}

function value(v: string | number | boolean | string[]): AnyValue {
  if (Array.isArray(v)) return { arrayValue: { values: v.map((s) => ({ stringValue: s })) } }
  if (typeof v === 'boolean') return { boolValue: v }
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
  return { stringValue: v }
}

function attrs(record: Record<string, string | number | boolean | string[] | undefined>): KeyValue[] {
  return Object.entries(record).flatMap(([key, v]) => (v === undefined || v === '' ? [] : [{ key, value: value(v) }]))
}

/** Text cut to `max`, saying how much was left out. */
export function clipText(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return String(v)
  }
}

/** Langfuse's own names for each bucket: Anthropic's for Claude, OpenAI's for the rest, so its model prices match them. */
export function usageDetails(agent: string, tokens: TokenCounts): Record<string, number> {
  const out: Record<string, number> = { input: tokens.input, output: tokens.output }
  if (agent === 'claude') {
    if (tokens.cacheRead) out.cache_read_input_tokens = tokens.cacheRead
    if (tokens.cacheWrite) out.cache_creation_input_tokens = tokens.cacheWrite
  } else {
    if (tokens.cacheRead) out.input_cached_tokens = tokens.cacheRead
    if (tokens.cacheWrite) out.input_cache_creation_tokens = tokens.cacheWrite
  }
  return out
}

// Anthropic's prices relative to uncached input, the same for every Claude model: cache reads a tenth, cache writes a
// quarter more, output five times. Only shares within one turn are taken from them, never a price.
const WEIGHT = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 }
const weight = (t: TokenCounts) => t.input * WEIGHT.input + (t.cacheRead ?? 0) * WEIGHT.cacheRead + (t.cacheWrite ?? 0) * WEIGHT.cacheWrite + t.output * WEIGHT.output

/**
 * The turn's reported cost shared across its model calls by what each would cost at Claude's relative prices, so the
 * calls add up to exactly what the agent reported. Langfuse prefers a cost it is given to one it works out.
 */
export function apportion(total: number, calls: ModelCallFact[]): number[] {
  const weights = calls.map((c) => weight(c.tokens))
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0) return calls.map((_, i) => (i === 0 ? total : 0))
  return weights.map((w) => (total * w) / sum)
}

function levelOf(outcome: TurnOutcome): 'ERROR' | 'WARNING' | undefined {
  if (outcome === 'error') return 'ERROR'
  if (outcome === 'interrupted') return 'WARNING'
  return undefined
}

/** Every span of one turn. Content (prompt, answer, model output, tool inputs and outputs) only when `content`. */
export function turnSpans(turn: TurnFacts, sender: SenderFacts, content: boolean): OtlpSpan[] {
  const traceId = traceIdFor(turn.turnId)
  const rootId = spanIdFor(`${turn.turnId}:turn`)
  const tags = [turn.agent, sender.device.name, sender.platform, ...(turn.repo ? [turn.repo.name] : [])]
  // Langfuse filters each observation by what it carries itself, so the trace's attributes go on every span.
  const trace = attrs({
    'langfuse.trace.name': 'turn',
    'langfuse.session.id': turn.chatId,
    'langfuse.user.id': sender.device.name,
    'langfuse.release': sender.version,
    'langfuse.version': sender.version,
    'langfuse.environment': sender.environment,
    'langfuse.trace.tags': tags,
    'langfuse.trace.metadata.device_id': sender.device.id,
    'langfuse.trace.metadata.platform': sender.platform,
    'langfuse.trace.metadata.agent': turn.agent,
    'langfuse.trace.metadata.workspace': turn.workspace.name,
    'langfuse.trace.metadata.workspace_id': turn.workspace.id,
    'langfuse.trace.metadata.repo': turn.repo?.name,
    'langfuse.trace.metadata.turn_id': turn.turnId
  })
  const span = (key: string, name: string, start: string, end: string, own: KeyValue[], parent: string | undefined = rootId, error?: string): OtlpSpan => ({
    traceId,
    spanId: key === 'turn' ? rootId : spanIdFor(`${turn.turnId}:${key}`),
    ...(parent && key !== 'turn' ? { parentSpanId: parent } : {}),
    name,
    kind: 1,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(end < start ? start : end),
    attributes: [...trace, ...own],
    ...(error !== undefined ? { status: { code: 2 as const, message: error } } : {})
  })

  const level = levelOf(turn.outcome)
  const spans: OtlpSpan[] = [
    span(
      'turn',
      `${turn.agent} turn`,
      turn.startedAt,
      turn.endedAt,
      attrs({
        'langfuse.observation.type': 'agent',
        'langfuse.observation.level': level,
        'langfuse.observation.status_message': turn.error ? clipText(turn.error, 500) : undefined,
        'langfuse.observation.model.name': turn.model,
        'langfuse.observation.metadata.outcome': turn.outcome,
        'langfuse.observation.metadata.reported_cost_usd': turn.costUsd !== undefined ? String(turn.costUsd) : undefined,
        'langfuse.observation.input': content && turn.prompt ? JSON.stringify(clipText(turn.prompt)) : undefined,
        'langfuse.observation.output': content && turn.answer ? JSON.stringify(clipText(turn.answer)) : undefined
      }),
      undefined,
      turn.outcome === 'error' ? clipText(turn.error ?? 'error', 500) : undefined
    )
  ]

  const subagentParent = (key: string | undefined) => (key ? spanIdFor(`${turn.turnId}:sub:${key}`) : rootId)
  for (const sub of turn.subagents) {
    spans.push(span(`sub:${sub.key}`, sub.name, sub.start, sub.end, attrs({ 'langfuse.observation.type': 'agent' })))
  }

  const costs = turn.costUsd !== undefined && turn.calls.length ? apportion(turn.costUsd, turn.calls) : []
  turn.calls.forEach((call, i) => {
    spans.push(
      span(
        `call:${call.id}`,
        call.model,
        call.start,
        call.end,
        attrs({
          'langfuse.observation.type': 'generation',
          'langfuse.observation.model.name': call.model,
          'langfuse.observation.usage_details': JSON.stringify(usageDetails(turn.agent, call.tokens)),
          'langfuse.observation.cost_details': costs[i] !== undefined ? JSON.stringify({ total: costs[i] }) : undefined,
          'langfuse.observation.metadata.reasoning_tokens': call.tokens.reasoning ? String(call.tokens.reasoning) : undefined,
          'langfuse.observation.output': content && call.output ? JSON.stringify(clipText(call.output)) : undefined
        }),
        subagentParent(call.subagent)
      )
    )
  })

  for (const tool of turn.tools) {
    spans.push(
      span(
        `tool:${tool.id}`,
        tool.name,
        tool.start,
        tool.end ?? tool.start,
        attrs({
          'langfuse.observation.type': 'tool',
          'langfuse.observation.level': tool.error ? 'ERROR' : undefined,
          'langfuse.observation.input': content && tool.input !== undefined ? JSON.stringify(clipText(asText(tool.input))) : undefined,
          'langfuse.observation.output': content && tool.output !== undefined ? JSON.stringify(clipText(asText(tool.output))) : undefined
        }),
        subagentParent(tool.subagent),
        tool.error ? 'error' : undefined
      )
    )
  }
  return spans
}

// ---- events ----

/** The event log's kinds that go to Langfuse, and how serious each is. Turn starts and ends are the turn traces. */
const EVENT_LEVEL: Record<string, 'ERROR' | 'WARNING'> = {
  exception: 'ERROR',
  rejection: 'ERROR',
  'renderer.gone': 'ERROR',
  'process.gone': 'WARNING',
  'window.unresponsive': 'WARNING',
  stall: 'WARNING',
  error: 'WARNING'
}

// Console lines that are warnings from a library, not Foreman going wrong: one on every Claude turn in bypass mode
// would bury everything else.
const NOISE = [/CLAUDE_SDK_CAN_USE_TOOL_SHADOWED/, /ExperimentalWarning/]

/** Whether an event-log line goes to Langfuse. */
export function exportedEvent(event: DiagnosticEvent): boolean {
  if (!(event.kind in EVENT_LEVEL)) return false
  if (event.kind === 'error' && NOISE.some((re) => re.test(String(event.line ?? '')))) return false
  return true
}

/** The ledger key of an event: the same line read from the log or the ring is one event. */
export const eventKey = (event: DiagnosticEvent) => `event:${event.at}:${event.kind}`

function eventMessage(event: DiagnosticEvent): string | undefined {
  const text = event.message ?? event.line ?? event.reason
  return typeof text === 'string' ? clipText(text, 1_000) : undefined
}

/** A stall's slowest timings, so the event says what was running when the main thread stopped answering. */
function stallTimings(event: DiagnosticEvent): string | undefined {
  const timings = event.timings as Record<string, { count: number; totalMs: number; maxMs: number }> | undefined
  if (!timings) return undefined
  const top = Object.entries(timings)
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .slice(0, 8)
    .map(([name, t]) => `${name} ${Math.round(t.totalMs)}ms (${t.count}×, max ${Math.round(t.maxMs)}ms)`)
  return top.length ? top.join('; ') : undefined
}

/** One event as a span of its app run's trace (`run` is when that run started). */
export function eventSpan(event: DiagnosticEvent, run: string, sender: SenderFacts): OtlpSpan {
  const runKey = `app:${sender.device.id}:${run}`
  const message = eventMessage(event)
  return {
    traceId: traceIdFor(runKey),
    spanId: spanIdFor(eventKey(event)),
    name: event.kind,
    kind: 1,
    startTimeUnixNano: nanos(event.at),
    endTimeUnixNano: nanos(event.at),
    attributes: attrs({
      'langfuse.trace.name': 'app',
      'langfuse.session.id': `app-${sender.device.id}`,
      'langfuse.user.id': sender.device.name,
      'langfuse.release': sender.version,
      'langfuse.version': sender.version,
      'langfuse.environment': sender.environment,
      'langfuse.trace.tags': ['app', sender.device.name, sender.platform],
      'langfuse.trace.metadata.device_id': sender.device.id,
      'langfuse.trace.metadata.platform': sender.platform,
      'langfuse.trace.metadata.run_started': run,
      'langfuse.observation.type': 'event',
      'langfuse.observation.level': EVENT_LEVEL[event.kind],
      'langfuse.observation.status_message': message,
      'langfuse.observation.metadata.max_ms': typeof event.maxMs === 'number' ? String(Math.round(event.maxMs)) : undefined,
      'langfuse.observation.metadata.p99_ms': typeof event.p99Ms === 'number' ? String(Math.round(event.p99Ms)) : undefined,
      'langfuse.observation.metadata.timings': event.kind === 'stall' ? stallTimings(event) : undefined,
      'langfuse.observation.metadata.process': typeof event.type === 'string' ? event.type : undefined,
      'langfuse.observation.metadata.exit_code': typeof event.exitCode === 'number' ? String(event.exitCode) : undefined,
      'langfuse.observation.metadata.stack': typeof event.stack === 'string' ? clipText(event.stack, 2_000) : undefined
    }),
    ...(EVENT_LEVEL[event.kind] === 'ERROR' ? { status: { code: 2 as const, ...(message ? { message } : {}) } } : {})
  }
}

/** The request body for a batch of spans. */
export function otlpRequest(spans: OtlpSpan[], sender: SenderFacts): OtlpRequest {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attrs({
            'service.name': 'foreman',
            'service.version': sender.version,
            'host.name': sender.device.name,
            'os.type': sender.platform,
            'deployment.environment.name': sender.environment
          })
        },
        scopeSpans: [{ scope: { name: 'foreman', version: sender.version }, spans }]
      }
    ]
  }
}

// ---- reading a turn ----

type Entry = { subpath: string; json: Record<string, unknown> }
type Block = { type?: string; id?: string; name?: string; input?: unknown; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: { thinking_tokens?: number }
}

function claudeTokens(u: ClaudeUsage | undefined): TokenCounts {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    ...(u?.cache_read_input_tokens ? { cacheRead: u.cache_read_input_tokens } : {}),
    ...(u?.cache_creation_input_tokens ? { cacheWrite: u.cache_creation_input_tokens } : {}),
    ...(u?.output_tokens_details?.thinking_tokens ? { reasoning: u.output_tokens_details.thinking_tokens } : {})
  }
}

/**
 * A Claude turn's model calls, tool calls and subagents from its transcript entries (main and subagents, in order),
 * as Foreman's mirror keeps them. One response is written as one entry per content block, each with the same
 * message id and usage, so a call is the entries of one id. It starts after the entry before it.
 */
export function claudeTurnParts(entries: Entry[], content: boolean): Pick<TurnFacts, 'calls' | 'tools' | 'subagents'> {
  const calls = new Map<string, ModelCallFact>()
  const tools = new Map<string, ToolCallFact>()
  const subagents = new Map<string, SubagentFact>()
  const lastAt = new Map<string, string>()
  for (const { subpath, json } of entries) {
    const at = typeof json.timestamp === 'string' ? json.timestamp : undefined
    if (!at) continue
    const subagent = subpath || undefined
    if (subagent) {
      const known = subagents.get(subagent)
      if (known) known.end = at
      else subagents.set(subagent, { key: subagent, name: subagent.split('/').pop() || subagent, start: at, end: at })
    }
    const message = json.message as { id?: string; model?: string; usage?: ClaudeUsage; content?: unknown } | undefined
    const blocks = Array.isArray(message?.content) ? (message.content as Block[]) : []
    if (json.type === 'assistant' && message?.id && message.model && message.model !== '<synthetic>') {
      const call = calls.get(message.id) ?? { id: message.id, model: message.model, start: lastAt.get(subpath) ?? at, end: at, tokens: claudeTokens(message.usage), ...(subagent ? { subagent } : {}) }
      call.end = at
      call.tokens = claudeTokens(message.usage)
      for (const block of blocks) {
        if (block.type === 'text' && content && block.text) call.output = (call.output ? `${call.output}\n` : '') + block.text
        if (block.type === 'tool_use' && block.id) tools.set(block.id, { id: block.id, name: block.name ?? 'tool', start: at, error: false, ...(subagent ? { subagent } : {}), ...(content ? { input: block.input } : {}) })
      }
      calls.set(message.id, call)
    } else if (json.type === 'user') {
      for (const block of blocks) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue
        const tool = tools.get(block.tool_use_id)
        if (!tool) continue
        tool.end = at
        tool.error = Boolean(block.is_error)
        if (content) tool.output = block.content
      }
    }
    lastAt.set(subpath, at)
  }
  return { calls: [...calls.values()], tools: [...tools.values()], subagents: [...subagents.values()] }
}

/**
 * An agent's tool calls from the chat's own items, for agents without a transcript Foreman keeps. An item's time is
 * when it was first written (the call started); it ends when the next item came.
 */
export function itemTools(items: { item: ChatItem; at: string }[], endedAt: string, content: boolean): ToolCallFact[] {
  const out: ToolCallFact[] = []
  items.forEach(({ item, at }, i) => {
    if (item.kind !== 'tool' || item.parentToolUseId) return
    out.push({
      id: item.id,
      name: item.name,
      start: at,
      end: items[i + 1]?.at ?? endedAt,
      error: item.status === 'error',
      ...(content ? { input: item.input, ...(item.output !== undefined ? { output: item.output } : {}) } : {})
    })
  })
  return out
}
