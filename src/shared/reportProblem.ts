// Report a problem (O20): the diagnostics Foreman fills in, "Remove paths and
// tokens", and the pre-filled GitHub issue link. Pure, so the dialog and the
// tests share it. Nothing here sends anything: the user opens the link in their
// browser (and posts it there) or copies the report.
//
// The report itself stays in English whatever the UI language, since it is read
// by whoever maintains Foreman; only the dialog around it is translated.
import { githubSlug } from './githubLink'

/** What one agent's status check said. Fields left out are unknown. */
export interface AgentDiagnostic {
  // Display name, e.g. "Claude Code".
  name: string
  installed?: boolean
  ready?: boolean
  version?: string
  // How it is signed in, e.g. "Claude Max account" (never the account itself).
  method?: string
  // Why the status is unknown: the check failed or didn't answer in time.
  problem?: string
}

export interface ReportDiagnostics {
  foremanVersion: string
  // An installed build, or run from source.
  packaged: boolean
  // process.platform and process.arch.
  platform: string
  arch: string
  // The OS by name and version, e.g. "Windows 11 Pro 10.0.26200" or "macOS 26.1".
  os: string
  electron?: string
  chrome?: string
  node: string
  agents: AgentDiagnostic[]
  // Error lines Foreman logged since it started, newest last (at most REPORT_ERROR_LINES).
  errors: string[]
  // owner/name of Foreman's own GitHub repository, or null when it couldn't be found.
  repo: string | null
  // What "Remove paths and tokens" replaces. Never shown on their own.
  home: string
  user: string
}

/** How many of the latest error lines go in a report. */
export const REPORT_ERROR_LINES = 5

/** Longer pre-filled links risk being cut off by the browser or GitHub; past this the report is copied instead. */
export const MAX_ISSUE_URL_LENGTH = 7000

/** The issue body when the report didn't fit in the link and was copied instead. */
export const ISSUE_PASTE_NOTE = '_The report was too long for a link, so Foreman copied it to the clipboard. Paste it here._'

const LABEL_WIDTH = 10

function row(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`
}

/** One agent as a diagnostics line: its version and whether it is ready, or why that's unknown. */
export function agentLine(agent: AgentDiagnostic): string {
  if (agent.problem) return `${agent.name}: status unknown (${agent.problem})`
  if (agent.installed === false) return `${agent.name}: not found`
  const version = agent.version ?? 'version unknown'
  const state = agent.ready === undefined ? 'sign-in unknown' : agent.ready ? `ready${agent.method ? `, ${agent.method}` : ''}` : 'not ready'
  return `${agent.name} ${version} (${state})`
}

/** The diagnostics block as the dialog first shows it; the user may edit it before posting. */
export function formatDiagnostics(d: ReportDiagnostics): string {
  const runtime = [d.electron && `Electron ${d.electron}`, d.chrome && `Chrome ${d.chrome}`, `Node ${d.node}`].filter(Boolean).join(' · ')
  const lines = [
    row('Foreman', `${d.foremanVersion} (${d.platform}-${d.arch}, ${d.packaged ? 'installed' : 'from source'})`),
    row('OS', d.os),
    row('Runtime', runtime)
  ]
  if (!d.agents.length) lines.push(row('Agents', 'none checked'))
  d.agents.forEach((agent, i) => lines.push(row(i === 0 ? 'Agents' : '', agentLine(agent))))
  lines.push('')
  if (!d.errors.length) lines.push('Last errors: no recent errors recorded')
  else lines.push('Last errors (this session, newest last)', ...d.errors.slice(-REPORT_ERROR_LINES))
  return lines.join('\n')
}

// ---- redaction ----

export type RedactionKind = 'path' | 'user' | 'token' | 'email'

/** A run of the redacted text: as written, or a replacement with what it replaced. */
export interface RedactSegment {
  text: string
  kind?: RedactionKind
  original?: string
}

export interface Redaction {
  // The text with every match replaced.
  text: string
  segments: RedactSegment[]
  counts: Record<RedactionKind, number>
  total: number
}

/** The home folder and user name to replace; both optional. */
export interface RedactContext {
  home?: string
  user?: string
}

export const REDACTION_TEXT: Record<RedactionKind, string> = { path: '~', user: '<user>', token: '<token>', email: '<email>' }

interface Rule {
  kind: RedactionKind
  re: RegExp
  // Replace only this capture group (e.g. the value after "password=").
  group?: number
  keep?: (match: string) => boolean
}

// Things shaped like keys and tokens. Matching is by pattern, so the dialog asks the user to read the result.
const TOKEN_RULES: Rule[] = [
  // OpenAI and Anthropic (sk-ant-…) keys.
  { kind: 'token', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: 'token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_.
  { kind: 'token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  // Slack.
  { kind: 'token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  // AWS access key ids.
  { kind: 'token', re: /\bAKIA[0-9A-Z]{16}\b/g },
  // JSON web tokens.
  { kind: 'token', re: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g },
  // user:password@ in a URL.
  { kind: 'token', re: /\/\/([^\s:/@]+:[^\s/@]+)@/g, group: 1 },
  { kind: 'token', re: /\bBearer\s+([A-Za-z0-9._~+/-]{12,}=*)/g, group: 1 },
  // The value in "api_key=…", "password: …", "token=…".
  { kind: 'token', re: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|token)\b["']?\s*[:=]\s*["']?([^\s"',;]{8,})/gi, group: 1 },
  // Long hex secrets (32+ characters; git commit ids go too).
  { kind: 'token', re: /\b[0-9a-f]{32,}\b/gi },
  // Long base64-like runs mixing digits, upper and lower case letters.
  { kind: 'token', re: /(?<![\w+=-])(?=[\w+-]*\d)(?=[\w+-]*[a-z])(?=[\w+-]*[A-Z])[A-Za-z0-9+_-]{40,}={0,2}/g }
]

const EMAIL_RULE: Rule = {
  kind: 'email',
  re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  // git@github.com in an SSH remote isn't anyone's address.
  keep: (match) => !/^git@/i.test(match)
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The home folder with either slash direction (and doubled backslashes, as in JSON), any letter case. */
function homeRule(home: string): Rule | null {
  const parts = home.split(/[\\/]+/).filter(Boolean)
  if (!parts.length) return null
  const lead = /^[\\/]/.test(home) ? '[\\\\/]' : '(?<![\\w.])'
  return { kind: 'path', re: new RegExp(`${lead}${parts.map(escapeRegExp).join('[\\\\/]+')}(?![\\w.-])`, 'gi') }
}

function userRule(user: string): Rule | null {
  // Too short to replace without hitting ordinary words.
  if (user.trim().length < 3) return null
  return { kind: 'user', re: new RegExp(`(?<![\\w.-])${escapeRegExp(user.trim())}(?![\\w-])`, 'gi') }
}

/**
 * Replace the home folder with ~, the user name with <user>, anything shaped
 * like a key or token with <token>, and email addresses with <email>.
 * Earlier and longer matches win where two overlap.
 */
export function redact(text: string, context: RedactContext = {}): Redaction {
  const rules = [
    ...TOKEN_RULES,
    EMAIL_RULE,
    context.home ? homeRule(context.home) : null,
    context.user ? userRule(context.user) : null
  ].filter((r): r is Rule => r !== null)
  const found: { start: number; end: number; kind: RedactionKind }[] = []
  for (const rule of rules) {
    for (const m of text.matchAll(rule.re)) {
      if (rule.keep && !rule.keep(m[0])) continue
      const part = rule.group ? m[rule.group] : m[0]
      if (!part) continue
      const start = m.index + (rule.group ? m[0].indexOf(part) : 0)
      found.push({ start, end: start + part.length, kind: rule.kind })
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const counts: Record<RedactionKind, number> = { path: 0, user: 0, token: 0, email: 0 }
  const segments: RedactSegment[] = []
  let at = 0
  for (const match of found) {
    if (match.start < at) continue
    if (match.start > at) segments.push({ text: text.slice(at, match.start) })
    segments.push({ text: REDACTION_TEXT[match.kind], kind: match.kind, original: text.slice(match.start, match.end) })
    counts[match.kind]++
    at = match.end
  }
  if (at < text.length) segments.push({ text: text.slice(at) })
  return { text: segments.map((s) => s.text).join(''), segments, counts, total: counts.path + counts.user + counts.token + counts.email }
}

/** The text unchanged, as one segment, for when redaction is off. */
export function unredacted(text: string): Redaction {
  return { text, segments: text ? [{ text }] : [], counts: { path: 0, user: 0, token: 0, email: 0 }, total: 0 }
}

// ---- the issue ----

const TITLE_MAX = 80

/** The issue title: the description's first line, shortened. */
export function issueTitle(description: string): string {
  const first = description.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).find(Boolean)
  if (!first) return 'Problem report'
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1).trimEnd()}…` : first
}

/** A code fence the text can't close early. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length))
  return '`'.repeat(longest + 1)
}

/** The issue body: what happened, then the diagnostics in a code block. */
export function issueBody(description: string, diagnostics: string): string {
  const what = description.trim() || '_No description given._'
  const diag = diagnostics.trimEnd()
  const f = fence(diag)
  return `### What happened\n\n${what}\n\n### Diagnostics\n\n${f}text\n${diag}\n${f}\n`
}

export interface IssueReport {
  title: Redaction
  body: Redaction
}

/** Title and body as they'll be posted, redacted when `redactOn`. */
export function buildReport(description: string, diagnostics: string, redactOn: boolean, context: RedactContext): IssueReport {
  const apply = (text: string) => (redactOn ? redact(text, context) : unredacted(text))
  return { title: apply(issueTitle(description)), body: apply(issueBody(description, diagnostics)) }
}

/** The whole report as text, for the clipboard. */
export function reportText(report: { title: string; body: string }): string {
  return `${report.title}\n\n${report.body}`
}

const SLUG = /^[\w.-]+\/[\w.-]+$/

export function issueUrl(repo: string, title: string, body: string): string {
  return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}

export interface IssuePlan {
  url: string
  // The body didn't fit in the link: copy the report first; the link carries ISSUE_PASTE_NOTE instead.
  copy: boolean
}

/** The new-issue link for `repo` (owner/name), or, over `max` characters, a link that asks for the copied report to be pasted. */
export function planIssue(repo: string, title: string, body: string, max = MAX_ISSUE_URL_LENGTH): IssuePlan {
  if (!SLUG.test(repo)) throw new Error(`Not a GitHub repository: ${repo}`)
  const full = issueUrl(repo, title, body)
  if (full.length <= max) return { url: full, copy: false }
  return { url: issueUrl(repo, title, ISSUE_PASTE_NOTE), copy: true }
}

/**
 * owner/name from package.json's `repository`: "owner/name", "github:owner/name",
 * a GitHub URL, or { url }. null for anything not on GitHub.
 */
export function githubRepoFromPackage(repository: unknown): string | null {
  const value = typeof repository === 'object' && repository !== null ? (repository as { url?: unknown }).url : repository
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/^git\+/, '')
  const short = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(text)
  if (short) return short[1]
  return githubSlug(text)
}
