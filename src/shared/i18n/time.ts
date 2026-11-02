// Dates, times and ages in the UI language (O13b): Intl.RelativeTimeFormat,
// Intl.NumberFormat units and Intl.DateTimeFormat, keyed by our Locale codes.
// English keeps Foreman's compact style ("just now", "12m ago", "3h ago", "2d ago").
import { createT, type Locale } from './index'

type When = string | number | Date | undefined | null

const ms = (at: Exclude<When, undefined | null>): number => (at instanceof Date ? at.getTime() : typeof at === 'number' ? at : new Date(at).getTime())

// The narrow style reads best in most languages ("hace 12 min", "12分前"); French and
// German narrow forms are cryptic ("-12 min", "vor 12 m"), so they use short.
const RELATIVE_STYLE: Record<Locale, Intl.RelativeTimeFormatStyle> = { en: 'narrow', 'zh-CN': 'narrow', ja: 'narrow', ko: 'narrow', es: 'narrow', fr: 'short', de: 'short', 'pt-BR': 'narrow' }

const relative = new Map<Locale, Intl.RelativeTimeFormat>()
function relativeFormat(locale: Locale): Intl.RelativeTimeFormat {
  let f = relative.get(locale)
  if (!f) relative.set(locale, (f = new Intl.RelativeTimeFormat(locale, { style: RELATIVE_STYLE[locale], numeric: 'always' })))
  return f
}

/** Whole minutes, hours or days since `at` (a minute or more), as the unit to show. */
function span(at: number, now: number): { value: number; unit: 'minute' | 'hour' | 'day' } | null {
  const seconds = Math.max(0, (now - at) / 1000)
  if (seconds < 60) return null
  if (seconds < 3600) return { value: Math.floor(seconds / 60), unit: 'minute' }
  if (seconds < 86400) return { value: Math.floor(seconds / 3600), unit: 'hour' }
  return { value: Math.floor(seconds / 86400), unit: 'day' }
}

/** "just now", "12m ago", "3h ago", "2d ago" (en); "hace 12 min", "12分前"… Empty for no date. */
export function timeAgo(at: When, locale: Locale, now = Date.now()): string {
  if (at === undefined || at === null || at === '') return ''
  const s = span(ms(at), now)
  return s ? relativeFormat(locale).format(-s.value, s.unit) : createT(locale)('time.justNow')
}

const units = new Map<string, Intl.NumberFormat>()
function unitFormat(locale: Locale, unit: string): Intl.NumberFormat {
  const id = `${locale}|${unit}`
  let f = units.get(id)
  if (!f) units.set(id, (f = new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: locale === 'ja' ? 'short' : 'narrow' })))
  return f
}

/** How long since `at`, without "ago": "12h", "4m", "2d" (en); "a moment" under a minute. */
export function timeWaited(at: When, locale: Locale, now = Date.now()): string {
  if (at === undefined || at === null || at === '') return ''
  const s = span(ms(at), now)
  return s ? unitFormat(locale, s.unit).format(s.value) : createT(locale)('time.aMoment')
}

/** A clock time, "14:06" or "02:06 PM" as the language writes it. */
export function formatClock(at: Exclude<When, undefined | null>, locale: Locale): string {
  return new Date(ms(at)).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

/** A date and time; the language's default form unless `options` say otherwise. */
export function formatDateTime(at: Exclude<When, undefined | null>, locale: Locale, options?: Intl.DateTimeFormatOptions): string {
  return new Date(ms(at)).toLocaleString(locale, options)
}

/** A date; the language's default form unless `options` say otherwise. */
export function formatDate(at: Exclude<When, undefined | null>, locale: Locale, options?: Intl.DateTimeFormatOptions): string {
  return new Date(ms(at)).toLocaleDateString(locale, options)
}

/** A number with the language's grouping ("12,345", "12.345", "12 345"). */
export function formatNumber(n: number, locale: Locale): string {
  return n.toLocaleString(locale)
}

const compacts = new Map<string, Intl.NumberFormat>()
/** A number in the language's short form: "9.1K" (en), "9100" (de), "9.1万"… */
export function formatCompact(n: number, locale: Locale): string {
  let f = compacts.get(locale)
  if (!f) compacts.set(locale, (f = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })))
  return f.format(n)
}

const sizes = new Map<string, Intl.NumberFormat>()
/** A memory size in the language's own units and digits: "512 MB", "1.2 GB" (en); "1,2 Go" (fr). */
export function formatMemory(bytes: number, locale: Locale): string {
  const mb = Math.max(0, bytes) / (1024 * 1024)
  const unit = mb >= 1024 ? 'gigabyte' : 'megabyte'
  const id = `${locale}|${unit}`
  let f = sizes.get(id)
  if (!f) sizes.set(id, (f = new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: unit === 'gigabyte' ? 1 : 0 })))
  return f.format(unit === 'gigabyte' ? mb / 1024 : mb)
}
