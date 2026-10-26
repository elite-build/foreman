// How the noun handlers (agents, templates, commands, schedules, integrations, data) find what a command names
// ("name, id or unique start of the id") and say it, with one set of error texts, plus the small formatters they share.
import { CliCodedError } from './host'

export const notFound = (message: string, hint?: string): CliCodedError => new CliCodedError('not-found', message, hint)
export const ambiguous = (message: string, hint?: string): CliCodedError => new CliCodedError('ambiguous', message, hint)
export const refused = (message: string, hint?: string): CliCodedError => new CliCodedError('refused', message, hint)

export interface RefSpec<T> {
  id(item: T): string
  names(item: T): string[]
  // How one candidate is listed in an error ("Daily review (id 1a2b…)").
  describe(item: T): string
}

/**
 * The one item `query` means: an exact id, an exact name (any case), the start of one id (four characters or more),
 * or a name that only one item has. Several matches are an error that names each; none is "No <what> named …".
 */
export function findByRef<T>(items: T[], query: string, what: string, spec: RefSpec<T>): T {
  const q = query.trim()
  if (!q) throw notFound(`Name a ${what}.`)
  const lower = q.toLowerCase()
  const byId = items.find((i) => spec.id(i) === q)
  if (byId) return byId
  const byName = items.filter((i) => spec.names(i).some((n) => n.trim().toLowerCase() === lower))
  if (byName.length === 1) return byName[0]
  const byPrefix = q.length >= 4 ? items.filter((i) => spec.id(i).toLowerCase().startsWith(lower)) : []
  if (!byName.length && byPrefix.length === 1) return byPrefix[0]
  const several = byName.length > 1 ? byName : byPrefix
  if (several.length > 1) throw ambiguous(`“${q}” matches several ${what}s: ${several.map(spec.describe).join('; ')}. Pass the id.`)
  throw notFound(`No ${what} named “${q}”.${items.length ? ` ${what[0].toUpperCase()}${what.slice(1)}s: ${items.map((i) => spec.names(i)[0] ?? spec.id(i)).join(', ')}` : ''}`)
}

/** A URL with the user name and password taken out (`https://user:token@host/x` → `https://host/x`); other text as it is. */
export function redactUrl(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1')
}

/** An error message with a secret that was sent in the request taken out of it. */
export function scrubSecret(message: string, secret: string | undefined): string {
  const s = secret?.trim()
  return s && s.length >= 6 ? message.split(s).join('[token]') : message
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "1.5 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

/** "1M" and "475k": a context window. */
export function tokensText(n: number): string {
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** The first line of `text`, cut to `max` characters with an ellipsis. */
export function firstLine(text: string, max = 80): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** "2026-10-24T09:00:00.000Z" → "2026-10-24 09:00 UTC". */
export function utcText(iso: string | undefined): string {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : ''
}

/** "2m 30s", "1h 5m", "40s". */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}
