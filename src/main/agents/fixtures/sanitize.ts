// Makes a recording safe to commit (docs/agents.md, 9.2). The recorder already runs in isolation (a fresh data
// folder, no integrations, no repository MCP servers, no provider keys, no hooks), so secrets mostly never enter the
// traffic; this replaces what remains with stable placeholders, consistent within a file:
//   - paths: the temporary repository `<repo>`, the recording's folder `<tmp>`, the home folder `<home>`
//   - tokens, keys and JWTs `<token-1>`, `<jwt-1>`; emails `<email-1>`; account and organisation ids `<account-id-1>`
//   - every value in an `env` object `<env>`
// `findLeaks` is the check tests/agentFixtures.test.ts runs over every fixture; it uses the same patterns, plus the
// shapes of home paths in general, so a recording made by someone else on another machine is held to the same rule.
import type { Fixture, Frame } from './format'

export interface PlaceholderPaths {
  repo?: string
  home?: string
  tmp?: string
  /** What `<epoch+N>` is relative to: milliseconds, default now. */
  now?: number
}

/** What the recording ran with: the paths to replace (and any other spelling of them) and who was signed in. */
export interface SanitizeContext {
  repo: string
  tmp: string
  home: string
  /** Other spellings of the same folders (a short 8.3 name, the real path behind a link, the system temp folder). */
  aliases?: { path: string; as: 'repo' | 'tmp' | 'home' }[]
  /** The account's login name on this computer, replaced wherever it appears. */
  username?: string
  /** Literal strings to replace (an account's email or id the recorder knows), by the placeholder to put. */
  literals?: Record<string, string>
}

const PLACEHOLDER = /<(repo|home|tmp)>/g
/** Anything a sanitised file holds in place of a value. */
export const PLACEHOLDER_VALUE = /^<[a-z0-9][a-z0-9:_.-]*>$/i

/**
 * Puts a run's real paths where the fixture says `<repo>`, `<home>` and `<tmp>`. A value that is exactly `<epoch+N>` becomes
 * the time N seconds from now, as epoch seconds (a recorded reset time would be in the past by the time the fixture is
 * replayed; an `edited` limit fixture says when its limit resets relative to the replay instead).
 */
export function fillPlaceholders<T>(value: T, paths: PlaceholderPaths): T {
  if (typeof value === 'string') {
    const ahead = /^<epoch\+(\d+)>$/.exec(value)
    if (ahead) return (Math.floor((paths.now ?? Date.now()) / 1000) + Number(ahead[1])) as T
    return value.replace(PLACEHOLDER, (whole, name: 'repo' | 'home' | 'tmp') => paths[name] ?? whole) as T
  }
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, paths)) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [fillPlaceholders(k, paths), fillPlaceholders(v, paths)])) as T
  }
  return value
}

const JWT = /eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]{3,}){1,2}/g
// Each of these is a secret whatever it is called.
const SECRETS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
]
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
// Addresses that identify nobody: reserved for examples, or the ones every Claude Code install's own text names.
const HARMLESS_EMAIL = /@(example\.(com|org|net)|users\.noreply\.github\.com)$|^noreply@(anthropic|openai)\.com$/i
const harmless = (email: string) => HARMLESS_EMAIL.test(email)

// Keys whose string value names an account, an organisation or a person.
const IDENTITY_KEY = /^(e-?mail(_?address)?|(account|org|organi[sz]ation|user|tenant|customer|member|subscription)_?(uuid|id)|(organi[sz]ation|account|user|full|given|family)_?name|login|installation_?id|(host|machine|computer)_?name|hostname)$/i

// An organisation's name, and the plan an account is on: replaced whole (`<org>`, `<plan>`), never partly.
const ORG_KEY = /^organi[sz]ation$/i
const PLAN_KEY = /^(subscription|plan)_?type$/i

/**
 * What ships inside the Claude Code CLI itself: its built-in slash commands and bundled skills (the `builtin` ones of the
 * initialize response), their aliases, its agents and its built-in plugins. Anything else in a skill, command, agent or
 * plugin list came from the account (claude.ai org skills, namespaced `anthropic-skills:`), from the person's own
 * folders, or from a plugin they installed, and is replaced by `<skill-1>` and so on. The list is Claude Code 2.1.301's;
 * a newer CLI that adds a built-in shows up in the leak check as a name to add here after looking at it.
 */
export const CLI_BUNDLED_COMMANDS: ReadonlySet<string> = new Set([
  '__remote-workflow', 'advisor', 'agents', 'auto-mode-setup', 'autocompact', 'batch', 'claude-api', 'clear', 'code-review', 'color', 'compact', 'config',
  'context', 'dataviz', 'debug', 'deep-research', 'design', 'design-consent', 'design-revoke', 'design-sync', 'doctor', 'effort', 'extra-usage', 'fast',
  'fewer-permission-prompts', 'focus', 'goal', 'heapdump', 'import', 'init', 'insights', 'list-agents', 'loop', 'mcp', 'model', 'output-style',
  'plugin-authoring', 'recap', 'reload-plugins', 'reload-skills', 'rename', 'run', 'run-skill-generator', 'schedule', 'security-review', 'simplify',
  'skill-doctor', 'team-onboarding', 'update-config', 'usage', 'usage-credits', 'verify', 'workflow-authoring', 'workflow-launch-exec',
  // The aliases of those.
  'checkup', 'cost', 'name', 'new', 'peers', 'proactive', 'reset', 'review', 'routines', 'settings', 'stats'
])
export const CLI_BUNDLED_AGENTS: ReadonlySet<string> = new Set(['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'])
const BUNDLED_PLUGIN = /^cc-plugin-[a-z-]+(@builtin)?$/

// Keys whose array holds command and skill names, and the ones whose array holds objects with a `name`.
const NAME_LISTS = new Set(['skills', 'slash_commands', 'terminal_slash_commands', 'aliases'])
const OBJECT_LISTS = new Set(['commands', 'agents', 'plugins', 'skillFrontmatter'])
const isName = (v: unknown): v is { name: string } => typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string'

/** Whether a name in the list under `key` ships with the CLI (or is already a placeholder). */
function bundled(key: string, name: string, entry?: Record<string, unknown>): boolean {
  if (PLACEHOLDER_VALUE.test(name)) return true
  if (key === 'agents') return CLI_BUNDLED_AGENTS.has(name)
  // The context usage's skill list says where each came from: the CLI's own are `built-in` (there are some, like keybindings-help, that no command has).
  if (key === 'skillFrontmatter') return entry?.source === 'built-in'
  if (key === 'plugins') return BUNDLED_PLUGIN.test(name) && (entry?.path === undefined || entry.path === 'builtin')
  return CLI_BUNDLED_COMMANDS.has(name)
}

/** Codex's `remoteControl/status/changed` names the computer in `serverName` beside the installation's id; an MCP server's `serverName` is just a name. */
const hostKey = (owner: Record<string, unknown>, key: string): string => (key === 'serverName' && 'installationId' in owner ? 'hostname' : key)

/**
 * Replaces values with `<kind-n>`, the same one for the same value. Sanitising a file again continues after the numbers it already
 * holds, so a value met the second time never takes the number of a different one the first time.
 */
class Placeholders {
  private seen = new Map<string, string>()
  private counts = new Map<string, number>()

  constructor(frames: Frame[] = []) {
    const text = JSON.stringify(frames)
    for (const m of text.matchAll(/<([a-z][a-z-]*)-(\d+)>/g)) {
      const n = Number(m[2])
      if (n > (this.counts.get(m[1]) ?? 0)) this.counts.set(m[1], n)
    }
  }

  for(kind: string, value: string): string {
    const key = `${kind}\0${value}`
    let ph = this.seen.get(key)
    if (!ph) {
      const n = (this.counts.get(kind) ?? 0) + 1
      this.counts.set(kind, n)
      ph = `<${kind}-${n}>`
      this.seen.set(key, ph)
    }
    return ph
  }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The spellings a path takes in text: as is, with forward slashes, and with each backslash doubled or quadrupled (JSON inside JSON). */
function spellings(p: string): string[] {
  const trimmed = p.replace(/[\\/]+$/, '')
  const forward = trimmed.replace(/\\/g, '/')
  const back = trimmed.replace(/\//g, '\\')
  // Claude Code names a project's folder after its path with every other character a dash (C--Users-name-repo).
  const dashed = trimmed.replace(/[^A-Za-z0-9]/g, '-')
  return [...new Set([trimmed, forward, back, back.replace(/\\/g, '\\\\'), back.replace(/\\/g, '\\\\\\\\'), dashed])].filter(Boolean)
}

function pathPattern(ctx: SanitizeContext): { pattern: RegExp; kind: (match: string) => 'repo' | 'tmp' | 'home' } {
  const roots: { text: string; as: 'repo' | 'tmp' | 'home' }[] = []
  const add = (p: string | undefined, as: 'repo' | 'tmp' | 'home') => {
    if (p) for (const text of spellings(p)) roots.push({ text, as })
  }
  add(ctx.repo, 'repo')
  add(ctx.tmp, 'tmp')
  add(ctx.home, 'home')
  for (const a of ctx.aliases ?? []) add(a.path, a.as)
  // The longest first, so the repository inside the recording's folder inside the home folder is the repository.
  roots.sort((a, b) => b.text.length - a.text.length)
  // No folders to look for (sanitising a recording again): a pattern that matches nothing.
  const pattern = roots.length ? new RegExp(roots.map((r) => escapeRegex(r.text)).join('|'), 'gi') : /(?!)/g
  const lookup = new Map(roots.map((r) => [r.text.toLowerCase(), r.as]))
  return { pattern, kind: (match) => lookup.get(match.toLowerCase())! }
}

// After a placeholder, the rest of the path with forward slashes: one spelling, whichever system recorded it.
const AFTER_PLACEHOLDER = /(<(?:repo|tmp|home)>)((?:[\\/]+[^\s"'<>*?|`]*)?)/g

/**
 * Text that streams in fragments cut anywhere (a path, an email or a login name can be split across two of them and match
 * neither), and what each stream is called. The fragments of one stream, in order, are one text:
 *   - Claude Code's `content_block_delta` frames: `text_delta`, `thinking_delta` and a tool input's `input_json_delta`, per
 *     content block (its index, until that block's `content_block_stop`: the same index is used again by the next message);
 *   - Codex's item deltas (`item/agentMessage/delta`, `item/reasoning/textDelta`, `item/commandExecution/outputDelta`,
 *     `item/fileChange/outputDelta`, `item/plan/delta` …), per method and item (and content or summary index where it has one).
 */
interface StreamPart {
  /** The stream this fragment belongs to. */
  key: string
  text: string
  /** The frame data with this fragment's text replaced. */
  withText(text: string): unknown
}

const CLAUDE_DELTAS: Record<string, string> = { input_json_delta: 'partial_json', text_delta: 'text', thinking_delta: 'thinking' }
const CODEX_DELTA = /^item\/(?:[\w/]*\/)?[\w]*[dD]elta$/

function streamPartOf(data: unknown): StreamPart | undefined {
  const d = data as { type?: string; method?: string; event?: { type?: string; index?: number; delta?: Record<string, unknown> }; params?: Record<string, unknown> } | undefined
  if (d?.type === 'stream_event' && d.event?.type === 'content_block_delta' && d.event.delta) {
    const kind = String(d.event.delta.type)
    const field = CLAUDE_DELTAS[kind]
    const text = field ? d.event.delta[field] : undefined
    if (!field || typeof text !== 'string') return undefined
    return {
      key: `claude:${d.event.index ?? 0}:${kind}`,
      text,
      withText: (next) => {
        const copy = structuredClone(data) as { event: { delta: Record<string, unknown> } }
        copy.event.delta[field] = next
        return copy
      }
    }
  }
  if (typeof d?.method === 'string' && CODEX_DELTA.test(d.method) && typeof d.params?.itemId === 'string' && typeof d.params.delta === 'string') {
    const part = d.params.contentIndex ?? d.params.summaryIndex ?? ''
    return {
      key: `codex:${d.method}:${d.params.itemId}:${String(part)}`,
      text: d.params.delta,
      withText: (next) => {
        const copy = structuredClone(data) as { params: { delta: string } }
        copy.params.delta = next
        return copy
      }
    }
  }
  return undefined
}

/** The prefix of the streams a frame closes (Claude's `content_block_stop` ends that block's streams, so a reused index starts a new text). */
function streamEndedBy(data: unknown): string | undefined {
  const d = data as { type?: string; event?: { type?: string; index?: number } } | undefined
  return d?.type === 'stream_event' && d.event?.type === 'content_block_stop' ? `claude:${d.event.index ?? 0}:` : undefined
}

/** Each stream's fragments (the frames they are in, in order) with more than one fragment: the streams where a split can hide something. */
function splitStreams(frames: Frame[]): { frames: number[]; texts: string[] }[] {
  const open = new Map<string, number[]>()
  const done: number[][] = []
  const close = (prefix: string) => {
    for (const key of [...open.keys()]) {
      if (!key.startsWith(prefix)) continue
      done.push(open.get(key)!)
      open.delete(key)
    }
  }
  frames.forEach((f, i) => {
    const part = streamPartOf(f.data)
    if (part) open.set(part.key, [...(open.get(part.key) ?? []), i])
    else {
      const ended = streamEndedBy(f.data)
      if (ended) close(ended)
    }
  })
  close('')
  return done.filter((at) => at.length > 1).map((at) => ({ frames: at, texts: at.map((i) => streamPartOf(frames[i].data)!.text) }))
}

/**
 * Where cleaning a stream's fragments joined changes them, the cleaned text goes in the first fragment and the rest are empty:
 * still the same text once joined, which is all a reader of the fragments does with them.
 */
function mergeSplitFragments(frames: Frame[], clean: (text: string) => string): Frame[] {
  const out = frames.map((f) => ({ ...f }))
  for (const stream of splitStreams(frames)) {
    const joined = stream.texts.join('')
    const cleaned = clean(joined)
    if (cleaned === joined) continue
    stream.frames.forEach((i, n) => {
      out[i].data = streamPartOf(out[i].data)!.withText(n === 0 ? cleaned : '')
    })
  }
  return out
}

export function sanitizeFrames(frames: Frame[], ctx: SanitizeContext): Frame[] {
  const paths = pathPattern(ctx)
  const ph = new Placeholders(frames)
  const username = ctx.username && ctx.username.length >= 4 ? new RegExp(`\\b${escapeRegex(ctx.username)}\\b`, 'gi') : undefined
  const literals = Object.entries(ctx.literals ?? {}).filter(([value]) => value.length >= 4)

  const clean = (text: string): string => {
    let s = text.replace(paths.pattern, (m) => `<${paths.kind(m)}>`)
    s = s.replace(AFTER_PLACEHOLDER, (_whole, head: string, tail: string) => head + tail.replace(/\\+/g, '/'))
    // The recorder's own folder (`foreman-record-…`, the repository inside it) whichever way an earlier pass left its parent.
    s = s.replace(/<tmp>\/foreman-record-[\w-]+(\/repo)?(?![\w-])/g, (_whole, repo?: string) => (repo ? '<repo>' : '<tmp>'))
    for (const [value, as] of literals) s = s.split(value).join(as)
    s = s.replace(JWT, (m) => ph.for('jwt', m))
    for (const secret of SECRETS) s = s.replace(secret, (m) => ph.for('token', m))
    s = s.replace(EMAIL, (m) => (harmless(m) ? m : ph.for('email', m)))
    // An org skill named in any text (a tool call's input, a listing).
    s = s.replace(/\banthropic-skills:[\w.-]+/g, (m) => ph.for('skill', m))
    if (username) s = s.replace(username, '<user>')
    return s
  }

  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') {
      if (!value || PLACEHOLDER_VALUE.test(value)) return value
      if (key && ORG_KEY.test(key)) return '<org>'
      if (key && PLAN_KEY.test(key)) return '<plan>'
      if (key && IDENTITY_KEY.test(key)) return ph.for(/mail/i.test(key) ? 'email' : /name|login/i.test(key) ? 'name' : 'account-id', value)
      return clean(value)
    }
    if (Array.isArray(value)) {
      // A list of skills, commands, agents or plugins keeps what ships with the CLI and names the rest only as `<skill-n>`.
      if (key && NAME_LISTS.has(key)) return value.map((v) => (typeof v === 'string' && !bundled(key, v) ? ph.for('skill', v) : walk(v)))
      if (key && OBJECT_LISTS.has(key)) {
        return value.map((v) => {
          if (typeof v === 'string' && key === 'agents') return bundled(key, v) ? v : ph.for('agent', v)
          if (!isName(v)) return walk(v)
          const entry = v as Record<string, unknown>
          if (bundled(key, v.name, entry)) return walk(v)
          // Not the CLI's: its name, what it says it does and how it is called are all the account's or the person's.
          const kind = key === 'plugins' ? 'plugin' : key === 'agents' ? 'agent' : 'skill'
          const own: Record<string, unknown> = {}
          for (const [k, x] of Object.entries(entry)) {
            if (k === 'name' || k === 'source') own[k] = ph.for(kind, String(x))
            else if (k === 'aliases' && Array.isArray(x)) own[k] = x.map((a) => ph.for(kind, String(a)))
            else if (k === 'description' || k === 'argumentHint' || k === 'path') own[k] = x ? `<${kind}>` : x
            else own[k] = walk(x, k)
          }
          return own
        })
      }
      return value.map((v) => walk(v))
    }
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        if (k === 'env' && typeof v === 'object' && v !== null && !Array.isArray(v)) {
          out[clean(k)] = Object.fromEntries(Object.keys(v).map((name) => [clean(name), '<env>']))
        } else out[clean(k)] = walk(v, hostKey(value as Record<string, unknown>, k))
      }
      return out
    }
    return value
  }
  return mergeSplitFragments(frames, clean).map((f) => ({ ...f, data: walk(f.data) }))
}

export function sanitizeFixture(fixture: Fixture, ctx: SanitizeContext): Fixture {
  return { header: fixture.header, frames: sanitizeFrames(fixture.frames, ctx) }
}

/** Where a person's home folder shows in a path, whoever's it is. */
const HOME_PATHS: RegExp[] = [
  /\b[A-Za-z]:(?:\\|\/)+Users(?:\\|\/)+(?!Public\b|Default\b|All Users\b)[^\\/<\s"'*?|]+/g,
  /(?:^|[\s"'=:(])\/Users\/(?!Shared\b)[^/<\s"']+/g,
  /(?:^|[\s"'=:(])\/home\/(?!user\b|runner\b)[^/<\s"']+/g
]

/** What a fixture must not hold. Empty when it is safe to commit. `machine` adds this computer's home folder and login name. */
export function findLeaks(fixture: Fixture, machine: { home?: string; username?: string } = {}): string[] {
  const found: string[] = []
  const note = (what: string, frame: number) => found.push(`frame ${frame}: ${what}`)
  const home = machine.home ? spellings(machine.home).map((s) => s.toLowerCase()) : []
  const username = machine.username && machine.username.length >= 4 ? new RegExp(`\\b${escapeRegex(machine.username)}\\b`, 'i') : undefined

  const inspect = (text: string, frame: number) => {
    const lower = text.toLowerCase()
    for (const h of home) if (lower.includes(h)) note(`holds the home folder ${h}`, frame)
    if (username?.test(text)) note('holds the login name of the person who recorded it', frame)
    for (const re of HOME_PATHS) for (const m of text.matchAll(re)) note(`holds a home folder path (${m[0].trim()})`, frame)
    for (const m of text.matchAll(EMAIL)) if (!harmless(m[0])) note(`holds an email address (${m[0]})`, frame)
    if (/eyJ[A-Za-z0-9_-]{10,}/.test(text)) note('holds a JWT', frame)
    for (const re of SECRETS) if (new RegExp(re.source).test(text)) note(`holds a key or token (${re.source.slice(0, 18)}…)`, frame)
  }

  const walk = (value: unknown, frame: number, key?: string) => {
    if (typeof value === 'string') {
      inspect(value, frame)
      if (/\banthropic-skills:/.test(value)) note('names a claude.ai org skill (anthropic-skills:)', frame)
      if (key && ORG_KEY.test(key) && value && !PLACEHOLDER_VALUE.test(value)) note(`holds an organisation name under "${key}"`, frame)
      if (key && PLAN_KEY.test(key) && value && !PLACEHOLDER_VALUE.test(value)) note(`holds the account's plan under "${key}"`, frame)
      if (key && IDENTITY_KEY.test(key) && value && !PLACEHOLDER_VALUE.test(value)) note(`holds an identity under "${key}"`, frame)
    } else if (Array.isArray(value)) {
      for (const v of value) {
        const name = typeof v === 'string' ? v : isName(v) ? v.name : undefined
        if (key && name !== undefined && (NAME_LISTS.has(key) || OBJECT_LISTS.has(key)) && !bundled(key, name, typeof v === 'object' ? (v as Record<string, unknown>) : undefined)) {
          note(`lists a ${key === 'plugins' ? 'plugin' : key === 'agents' ? 'agent' : 'skill or command'} the CLI does not ship with ("${name}" in "${key}")`, frame)
        }
        walk(v, frame)
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value)) {
        inspect(k, frame)
        if (k === 'env' && typeof v === 'object' && v !== null && !Array.isArray(v)) {
          for (const [name, val] of Object.entries(v)) if (typeof val !== 'string' || !PLACEHOLDER_VALUE.test(val)) note(`env value of ${name} is not a placeholder`, frame)
        } else walk(v, frame, hostKey(value as Record<string, unknown>, k))
      }
    }
  }
  inspect(JSON.stringify(fixture.header), 0)
  fixture.frames.forEach((f, i) => walk(f.data, i + 1))
  // What a split hides from the frame-by-frame check above: a streamed text's fragments read as one (a path cut as `C:/Users/P` + `at/…`).
  for (const stream of splitStreams(fixture.frames)) inspect(stream.texts.join(''), stream.frames[0] + 1)
  return [...new Set(found)]
}
