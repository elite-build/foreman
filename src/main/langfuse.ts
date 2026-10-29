// Langfuse's public API with a project's key pair: which project a key is, and the read-only tools
// agents get through the integration bridge to debug an app's traces. Reads go through the
// Observations API v2 (Langfuse's older trace and session reads are deprecated and gone on v4).
// Keys are sent only to the connection's host, never redirected.
import type { ConnectionIdentity, LangfuseConnectionInfo } from '../shared/integrations'

export type Fetch = typeof fetch

export class LangfuseError extends Error {
  constructor(
    message: string,
    readonly auth = false
  ) {
    super(message)
  }
}

interface Keys extends LangfuseConnectionInfo {
  secretKey: string
}

function basic(keys: Keys): string {
  return `Basic ${Buffer.from(`${keys.publicKey}:${keys.secretKey}`).toString('base64')}`
}

async function get<T>(keys: Keys, route: string, params: Record<string, string | undefined> = {}, doFetch: Fetch = fetch): Promise<T> {
  const url = new URL(`${keys.host}/api/public${route}`)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  let res: Response
  try {
    res = await doFetch(url, { redirect: 'error', headers: { Authorization: basic(keys), Accept: 'application/json', 'User-Agent': 'Foreman' }, signal: AbortSignal.timeout(30_000) })
  } catch (err) {
    throw new LangfuseError(`Couldn’t reach Langfuse at ${keys.host}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (res.status === 401 || res.status === 403) throw new LangfuseError('Langfuse refused this key pair. The keys may have been deleted, mistyped or made for another host.', true)
  if (res.status === 404 && route.startsWith('/v2/')) throw new LangfuseError(`${keys.host} doesn’t have Langfuse’s Observations API v2. A self-hosted Langfuse needs updating to use these tools.`)
  if (res.status === 429) throw new LangfuseError('Langfuse is rate limiting these requests. Wait a little, then ask for less (a smaller limit or time range).')
  const body = (await res.json().catch(() => null)) as (T & { message?: unknown; error?: unknown }) | null
  if (!res.ok || !body) {
    const detail = body && typeof body.message === 'string' ? body.message : body && typeof body.error === 'string' ? body.error : ''
    throw new LangfuseError(`Langfuse answered ${res.status}${detail ? `: ${detail}` : ''}`)
  }
  return body
}

/** The project a key pair belongs to (a project's keys see exactly one). */
export async function langfuseProject(keys: Keys, doFetch?: Fetch): Promise<ConnectionIdentity> {
  if (!/^pk-lf-/.test(keys.publicKey)) throw new LangfuseError(keys.publicKey.startsWith('sk-lf-') ? 'That’s the secret key. The public key starts with pk-lf-.' : 'Paste the public key, which starts with pk-lf-.')
  if (!/^sk-lf-/.test(keys.secretKey)) throw new LangfuseError(keys.secretKey.startsWith('pk-lf-') ? 'That’s the public key. The secret key starts with sk-lf-.' : 'Paste the secret key, which starts with sk-lf-.')
  const body = await get<{ data?: { id: string; name: string; organization?: { id?: string; name?: string } }[] }>(keys, '/projects', {}, doFetch)
  const project = body.data?.[0]
  if (!project) throw new LangfuseError('These keys don’t belong to a Langfuse project. Use a project’s API keys (Project settings → API Keys).')
  return {
    user: project.organization?.name || project.name,
    org: project.name,
    orgId: project.id,
    url: `${keys.host}/project/${project.id}`,
    checkedAt: new Date().toISOString()
  }
}

// ---- tools for agents ----

const FIELD_GROUPS = ['basic', 'time', 'io', 'metadata', 'model', 'usage', 'prompt', 'metrics', 'trace_context'] as const
const ALL_FIELDS = FIELD_GROUPS.join(',')
const TYPES = ['GENERATION', 'SPAN', 'EVENT', 'AGENT', 'TOOL', 'CHAIN', 'RETRIEVER', 'EVALUATOR', 'EMBEDDING', 'GUARDRAIL']
const LEVELS = ['DEBUG', 'DEFAULT', 'WARNING', 'ERROR']
// What one reply may hold, so a trace with huge prompts can't flood the agent's context.
const REPLY_LIMIT = 150_000
const TRACE_PAGES = 5
const DAY = 24 * 60 * 60 * 1000

const maxFieldChars = (fallback: number) => ({ type: 'integer', minimum: 200, maximum: 50_000, description: `Longer text fields are cut to this many characters (default ${fallback}).` })

export const LANGFUSE_TOOLS = [
  {
    name: 'search_observations',
    title: 'Search Langfuse observations',
    description:
      'Find observations (spans, generations, events, tool calls) in the Langfuse project, newest first. Use it to find failing traces (level ERROR), slow or costly calls, or everything in a session or for a user. ' +
      'Without traceId or sessionId it searches the last 24 hours unless you give from/to. rootsOnly lists one row per trace. Pass `cursor` from the reply to get the next page. ' +
      'For anything else, add `filter` conditions in Langfuse’s format, e.g. {"type":"number","column":"latency","operator":">=","value":5}, {"type":"stringObject","column":"metadata","key":"tenant","operator":"=","value":"acme"} or {"type":"string","column":"output","operator":"matches","value":"timeout"}.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO 8601 time: observations that started at or after it.' },
        to: { type: 'string', description: 'ISO 8601 time: observations that started before it.' },
        traceId: { type: 'string' },
        sessionId: { type: 'string' },
        userId: { type: 'string' },
        name: { type: 'string', description: 'Exact observation name.' },
        traceName: { type: 'string', description: 'Exact name of the trace the observations belong to.' },
        environment: { type: 'string' },
        type: { type: 'string', enum: TYPES },
        level: { type: 'string', enum: LEVELS },
        rootsOnly: { type: 'boolean', description: 'Only each trace’s root observation: one row per trace.' },
        fields: { type: 'array', items: { type: 'string', enum: FIELD_GROUPS }, description: 'Field groups beside id, traceId, times and type. Default: basic, trace_context, metrics, usage. Add io for inputs and outputs.' },
        filter: { type: 'array', items: { type: 'object' }, description: 'More Langfuse filter conditions: {type, column, operator, value, key?}.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 25.' },
        cursor: { type: 'string' },
        maxFieldChars: maxFieldChars(2000)
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'get_trace',
    title: 'Get a Langfuse trace',
    description: 'Every observation in one trace, in start order, with inputs, outputs, errors, model, usage, cost and latency. Start here when you have a trace id (from the app’s logs, a Langfuse URL or search_observations).',
    inputSchema: {
      type: 'object',
      properties: { traceId: { type: 'string' }, includeIO: { type: 'boolean', description: 'Include inputs and outputs (default true).' }, maxFieldChars: maxFieldChars(4000) },
      required: ['traceId'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'get_observation',
    title: 'Get a Langfuse observation',
    description: 'One observation with every field, its input and output much less cut down. Use it after get_trace cut a field you need.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, maxFieldChars: maxFieldChars(20_000) },
      required: ['id'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  }
]

type Condition = { type: string; column: string; operator: string; value?: unknown; key?: string }
type Observation = Record<string, unknown> & { id: string; traceId?: string; startTime?: string; parentObservationId?: string | null }
type Page = { data?: Observation[]; meta?: { cursor?: string | null } }

class ArgError extends Error {}

function text(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new ArgError(`${key} must be text.`)
  return v
}

function int(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const v = args[key]
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ArgError(`${key} must be a number.`)
  return Math.min(max, Math.max(min, Math.round(v)))
}

function time(args: Record<string, unknown>, key: string): string | undefined {
  const v = text(args, key)
  if (v === undefined) return undefined
  const at = new Date(v)
  if (Number.isNaN(at.getTime())) throw new ArgError(`${key} must be an ISO 8601 time, like 2026-10-29T09:00:00Z.`)
  return at.toISOString()
}

/** Inputs and outputs come back as raw strings: JSON is parsed so long values are cut field by field, not mid-structure. */
function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const s = value.trim()
  if (!(s.startsWith('{') || s.startsWith('[') || s.startsWith('"'))) return value
  try {
    return JSON.parse(s)
  } catch {
    return value
  }
}

/** Every string longer than `max` cut, saying how much is left out. */
export function clip(value: unknown, max: number): unknown {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}… [${value.length - max} more characters]` : value
  if (Array.isArray(value)) return value.map((v) => clip(v, max))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, max)]))
  return value
}

function shaped(o: Observation, max: number): Observation {
  const out: Observation = { ...o }
  if ('input' in out) out.input = parsed(out.input)
  if ('output' in out) out.output = parsed(out.output)
  if ('metadata' in out) out.metadata = parsed(out.metadata)
  return clip(out, max) as Observation
}

function reply(value: unknown): Record<string, unknown> {
  let body = JSON.stringify(value, null, 1)
  if (body.length > REPLY_LIMIT) body = `${body.slice(0, REPLY_LIMIT)}\n… [cut: ${body.length - REPLY_LIMIT} more characters. Ask for fewer rows or fields, or a smaller maxFieldChars.]`
  return { content: [{ type: 'text', text: body }] }
}

async function observations(keys: Keys, conditions: Condition[], params: { fields: string; limit: number; cursor?: string }, doFetch?: Fetch): Promise<Page> {
  return get<Page>(keys, '/v2/observations', { fields: params.fields, limit: String(params.limit), cursor: params.cursor, filter: JSON.stringify(conditions) }, doFetch)
}

async function searchObservations(keys: Keys, args: Record<string, unknown>, doFetch?: Fetch, now = Date.now()): Promise<Record<string, unknown>> {
  const conditions: Condition[] = []
  const equals = (column: string, value: string | undefined) => value !== undefined && conditions.push({ type: 'string', column, operator: '=', value })
  const traceId = text(args, 'traceId')
  const sessionId = text(args, 'sessionId')
  equals('traceId', traceId)
  equals('sessionId', sessionId)
  equals('userId', text(args, 'userId'))
  equals('name', text(args, 'name'))
  equals('traceName', text(args, 'traceName'))
  equals('environment', text(args, 'environment'))
  const type = text(args, 'type')
  if (type !== undefined && !TYPES.includes(type)) throw new ArgError(`type must be one of ${TYPES.join(', ')}.`)
  equals('type', type)
  const level = text(args, 'level')
  if (level !== undefined && !LEVELS.includes(level)) throw new ArgError(`level must be one of ${LEVELS.join(', ')}.`)
  equals('level', level)
  if (args.rootsOnly === true) conditions.push({ type: 'boolean', column: 'isRootObservation', operator: '=', value: true })
  // Langfuse asks for bounded reads; a trace or a session is bounded already.
  const to = time(args, 'to')
  const from = time(args, 'from') ?? (traceId || sessionId ? undefined : new Date((to ? Date.parse(to) : now) - DAY).toISOString())
  if (from) conditions.push({ type: 'datetime', column: 'startTime', operator: '>=', value: from })
  if (to) conditions.push({ type: 'datetime', column: 'startTime', operator: '<', value: to })
  if (args.filter !== undefined) {
    if (!Array.isArray(args.filter) || args.filter.some((c) => !c || typeof c !== 'object' || typeof (c as Condition).column !== 'string' || typeof (c as Condition).operator !== 'string' || typeof (c as Condition).type !== 'string')) {
      throw new ArgError('filter must be a list of {type, column, operator, value} conditions.')
    }
    conditions.push(...(args.filter as Condition[]))
  }
  let groups = ['basic', 'trace_context', 'metrics', 'usage']
  if (args.fields !== undefined) {
    if (!Array.isArray(args.fields) || args.fields.some((f) => !(FIELD_GROUPS as readonly unknown[]).includes(f))) throw new ArgError(`fields must be a list of ${FIELD_GROUPS.join(', ')}.`)
    groups = [...new Set(['basic', ...(args.fields as string[])])]
  }
  const max = int(args, 'maxFieldChars', 2000, 200, 50_000)
  const page = await observations(keys, conditions, { fields: groups.join(','), limit: int(args, 'limit', 25, 1, 100), cursor: text(args, 'cursor') }, doFetch)
  const rows = (page.data ?? []).map((o) => shaped(o, max))
  return reply({ ...(from ? { from } : {}), ...(to ? { to } : {}), count: rows.length, ...(page.meta?.cursor ? { nextCursor: page.meta.cursor } : {}), observations: rows })
}

async function getTrace(keys: Keys, args: Record<string, unknown>, doFetch?: Fetch): Promise<Record<string, unknown>> {
  const traceId = text(args, 'traceId')
  if (!traceId) throw new ArgError('traceId is required.')
  const max = int(args, 'maxFieldChars', 4000, 200, 50_000)
  const fields = args.includeIO === false ? FIELD_GROUPS.filter((f) => f !== 'io').join(',') : ALL_FIELDS
  const all: Observation[] = []
  let cursor: string | undefined
  let more = false
  for (let i = 0; i < TRACE_PAGES; i++) {
    const page = await observations(keys, [{ type: 'string', column: 'traceId', operator: '=', value: traceId }], { fields, limit: 100, cursor }, doFetch)
    all.push(...(page.data ?? []))
    cursor = page.meta?.cursor ?? undefined
    if (!cursor) break
    more = i === TRACE_PAGES - 1
  }
  if (!all.length) return reply({ traceId, found: false, note: 'No observations with this trace id. Langfuse may still be ingesting it, or it is in another project.' })
  all.sort((a, b) => String(a.startTime ?? '').localeCompare(String(b.startTime ?? '')))
  const root = all.find((o) => o.isRootObservation === true) ?? all.find((o) => !o.parentObservationId) ?? all[0]
  const cost = all.reduce((sum, o) => sum + (typeof o.totalCost === 'number' ? o.totalCost : 0), 0)
  const problems = all.filter((o) => o.level === 'ERROR' || o.level === 'WARNING').map((o) => ({ id: o.id, name: o.name, level: o.level, statusMessage: o.statusMessage }))
  return reply({
    traceId,
    traceName: root.traceName,
    sessionId: root.sessionId,
    userId: root.userId,
    environment: root.environment,
    tags: root.tags,
    release: root.release,
    url: `${keys.host}/project/${String(root.projectId ?? '')}/traces/${encodeURIComponent(traceId)}`,
    observationCount: all.length,
    ...(more ? { note: `Only the first ${all.length} observations; use search_observations with this traceId and a cursor for the rest.` } : {}),
    ...(cost ? { totalCost: cost } : {}),
    errorsAndWarnings: problems,
    observations: all.map((o) => shaped(o, max))
  })
}

async function getObservation(keys: Keys, args: Record<string, unknown>, doFetch?: Fetch): Promise<Record<string, unknown>> {
  const id = text(args, 'id')
  if (!id) throw new ArgError('id is required.')
  const page = await observations(keys, [{ type: 'string', column: 'id', operator: '=', value: id }], { fields: ALL_FIELDS, limit: 1 }, doFetch)
  const found = page.data?.[0]
  if (!found) return reply({ id, found: false })
  return reply(shaped(found, int(args, 'maxFieldChars', 20_000, 200, 50_000)))
}

/**
 * Runs one agent tool call against the connection's project. A bad argument is the tool's error
 * (isError), for the agent to fix; Langfuse refusing the keys throws a LangfuseError with `auth`.
 */
export async function langfuseCall(keys: Keys, name: string, args: Record<string, unknown> | undefined, doFetch?: Fetch, now?: number): Promise<Record<string, unknown>> {
  try {
    if (name === 'search_observations') return await searchObservations(keys, args ?? {}, doFetch, now)
    if (name === 'get_trace') return await getTrace(keys, args ?? {}, doFetch)
    if (name === 'get_observation') return await getObservation(keys, args ?? {}, doFetch)
    return { content: [{ type: 'text', text: `There’s no Langfuse tool called “${name}”.` }], isError: true }
  } catch (err) {
    if (err instanceof ArgError) return { content: [{ type: 'text', text: err.message }], isError: true }
    throw err
  }
}
