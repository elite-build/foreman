// Foreman's UI strings in several languages (O13). A small hand-rolled module:
// typed keys from the English catalogue, `{name}` interpolation, Intl.PluralRules
// plurals, and English for anything a locale hasn't translated. Pure, so both the
// renderer (useT in renderer/src/i18n.ts) and main (notifications, dialogs) use it.
// Only Foreman's own words are translated, never user content.
import { de } from './de'
import { en } from './en'
import { es } from './es'
import { fr } from './fr'
import { ja } from './ja'
import { ko } from './ko'
import { ptBR } from './pt-BR'
import type { Catalogue, Message, MessageKey, ParamValue, PluralMessage, TFunction } from './types'
import { zhCN } from './zh-CN'

export type { Catalogue, Message, MessageKey, MessageParams, ParamValue, PlainKey, PluralMessage, TArgs, TFunction } from './types'

/** The languages offered, each named in its own language (in Settings → General's order). */
export const LOCALES = [
  { code: 'en', name: 'English' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'pt-BR', name: 'Português (Brasil)' }
] as const

export type Locale = (typeof LOCALES)[number]['code']

/** The Language preference: follow the OS, or one language. */
export type LanguageSetting = 'system' | Locale

export const CATALOGUES: Record<Locale, Catalogue> = { en, 'zh-CN': zhCN, ja, ko, es, fr, de, 'pt-BR': ptBR }

const KEYS = Object.keys(en) as MessageKey[]

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.hasOwn(CATALOGUES, value)
}

export function localeName(locale: Locale): string {
  return LOCALES.find((l) => l.code === locale)!.name
}

// ---- formatting ----

/** Fill `{name}` placeholders; one with no value stays as written. */
export function interpolate(text: string, params?: Record<string, ParamValue>): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (params[name] === undefined ? whole : String(params[name])))
}

const pluralRules = new Map<string, Intl.PluralRules>()

function pluralForm(message: PluralMessage, locale: string, count: unknown): string {
  if (typeof count !== 'number') return message.other
  if (count === 0 && message.zero !== undefined) return message.zero
  let rules = pluralRules.get(locale)
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(locale)))
  return message[rules.select(count)] ?? message.other
}

const translated = (message: Message | undefined): message is Message => message !== undefined && message !== ''

/** The message's text in `locale`, before interpolation, and the language it's really in. */
function lookup(locale: Locale, key: MessageKey, count: unknown, catalogue: Catalogue): string {
  const own = catalogue[key]
  // Untranslated: the English text, with English plural rules.
  const [message, lang] = translated(own) ? [own, locale] : [en[key] as Message, 'en']
  if (message === undefined) return key
  return typeof message === 'string' ? message : pluralForm(message, lang, count)
}

/**
 * One string in `locale`. Prefer `createT(locale)` (or `useT()` in the renderer),
 * which checks params against the key. `catalogue` overrides the locale's own (tests).
 */
export function translate(locale: Locale, key: MessageKey, params?: Record<string, ParamValue>, catalogue: Catalogue = CATALOGUES[locale]): string {
  return interpolate(lookup(locale, key, params?.count, catalogue), params)
}

/** A `t(key, params?)` bound to one locale. */
export function createT(locale: Locale): TFunction {
  return (key, ...[params]) => translate(locale, key, params as Record<string, ParamValue> | undefined)
}

/**
 * Like translate, but placeholders may take any value (React nodes, for example).
 * Returns the text cut into parts around them, e.g. ['for example ', <code>code</code>, '.'].
 */
export function translateRich<N>(locale: Locale, key: MessageKey, values: Record<string, ParamValue | N>): (string | N)[] {
  const text = lookup(locale, key, values.count, CATALOGUES[locale])
  const parts: (string | N)[] = []
  let last = 0
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    if (!(match[1] in values)) continue
    const value = values[match[1]]
    parts.push(text.slice(last, match.index))
    parts.push(typeof value === 'string' || typeof value === 'number' ? String(value) : value)
    last = match.index + match[0].length
  }
  parts.push(text.slice(last))
  return parts.filter((part) => part !== '')
}

// ---- completeness ----

/** Percent of English keys a locale translates, rounded down so 100 means complete. */
export function completeness(locale: Locale, catalogue: Catalogue = CATALOGUES[locale]): number {
  if (locale === 'en') return 100
  const done = KEYS.filter((key) => translated(catalogue[key])).length
  return Math.floor((done * 100) / KEYS.length)
}

// ---- choosing a locale ----

/**
 * The supported locale for an OS language tag ("es-MX", "zh-Hans-CN", "pt_BR.UTF-8"),
 * or null. Any Spanish is es, any Portuguese pt-BR, and Simplified Chinese zh-CN;
 * Traditional Chinese (Hant, TW, HK, MO) isn't offered Simplified.
 */
export function matchLocale(tag: string): Locale | null {
  const parts = tag
    .trim()
    .replace(/[.@].*$/, '')
    .toLowerCase()
    .split(/[-_]/)
  const [lang, ...rest] = parts
  switch (lang) {
    case 'en':
    case 'ja':
    case 'ko':
    case 'es':
    case 'fr':
    case 'de':
      return lang
    case 'pt':
      return 'pt-BR'
    case 'zh':
      if (rest.includes('hans')) return 'zh-CN'
      return rest.some((p) => ['hant', 'tw', 'hk', 'mo'].includes(p)) ? null : 'zh-CN'
    default:
      return null
  }
}

/** The first of the OS's preferred languages that Foreman has, else English. */
export function resolveSystemLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const locale = matchLocale(tag)
    if (locale) return locale
  }
  return 'en'
}

/**
 * The locale to show. `preferred` is the OS's language list: navigator.languages in the
 * renderer, app.getPreferredSystemLanguages() in main. An unknown setting counts as System.
 */
export function resolveLocale(setting: LanguageSetting | undefined, preferred: readonly string[]): Locale {
  return setting && setting !== 'system' && isLocale(setting) ? setting : resolveSystemLocale(preferred)
}
