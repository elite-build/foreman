// O13b: the catalogues as a whole. Every locale is complete, every key the code
// uses exists, translations keep English's placeholders, plural messages have each
// language's CLDR forms, and dates and ages follow the UI language.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOGUES, completeness, LOCALES, type Locale, type Message, type MessageKey } from '../src/shared/i18n'
import { en } from '../src/shared/i18n/en'
import { formatClock, formatDate, formatDateTime, formatNumber, timeAgo, timeWaited } from '../src/shared/i18n/time'

const KEYS = Object.keys(en) as MessageKey[]
const TRANSLATED = LOCALES.map((l) => l.code).filter((c) => c !== 'en')

/**
 * Keys a locale deliberately leaves in English (they fall back to en.ts). Keep this short,
 * and say why: names and code that read the same in every language belong here.
 */
const LEFT_ENGLISH: Partial<Record<Locale, MessageKey[]>> = {}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

const placeholders = (text: string): string[] => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()
const forms = (message: Message): string[] => (typeof message === 'string' ? [message] : Object.values(message).filter((v): v is string => typeof v === 'string'))

describe('i18n catalogue: keys used in code', () => {
  it('every t("…") key in src exists in en.ts', () => {
    const missing: string[] = []
    for (const file of sourceFiles('src')) {
      if (file.includes(join('shared', 'i18n'))) continue
      const text = readFileSync(file, 'utf8')
      // t('key'), t.rich('key'), tNow()('key'), createT(locale)('key') and the like.
      for (const m of text.matchAll(/(?:\bt|\.rich|\)|\btr|\bT)\(\s*'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g)) {
        if (!(m[1] in en)) missing.push(`${file}: ${m[1]}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('i18n catalogue: translations', () => {
  it.each(TRANSLATED)('%s is complete, apart from keys deliberately left English', (code) => {
    const catalogue = CATALOGUES[code]
    const left = new Set(LEFT_ENGLISH[code] ?? [])
    const untranslated = KEYS.filter((k) => !left.has(k) && (catalogue[k] === undefined || catalogue[k] === ''))
    expect(untranslated).toEqual([])
    if (!left.size) expect(completeness(code)).toBe(100)
  })

  it.each(TRANSLATED)('%s keeps English’s placeholders in every form', (code) => {
    const wrong: string[] = []
    const check = (key: string, form: string, english: string, category: string) => {
      const got = placeholders(form)
      const want = placeholders(english)
      const named = (list: string[]) => list.filter((p) => p !== 'count').join()
      if (named(got) !== named(want)) wrong.push(`${key} (${category}): ${JSON.stringify(form)} has {${got}} but English has {${want}}`)
      // {count} stays wherever English shows the number, except a one/zero form may name it in words.
      if (want.includes('count') && !got.includes('count') && category !== 'one' && category !== 'zero') wrong.push(`${key} (${category}): lost {count}`)
    }
    for (const [key, message] of Object.entries(CATALOGUES[code]) as [MessageKey, Message][]) {
      const source = en[key] as Message
      if (typeof source === 'string') {
        if (typeof message !== 'string') wrong.push(`${key}: English is a plain string`)
        else check(key, message, source, 'string')
        continue
      }
      // A plural message: each form against English's same form, or English's other.
      if (typeof message === 'string') check(key, message, source.other, 'other')
      else for (const [category, form] of Object.entries(message)) check(key, form as string, (source as Record<string, string>)[category] ?? source.other, category)
    }
    expect(wrong).toEqual([])
  })

  it.each(TRANSLATED)('%s plural messages have the forms its language needs', (code) => {
    const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories as string[]
    // es, fr and pt-BR have a CLDR "many" form only for exact millions ("1 millón de…"); it
    // falls back to "other", which reads correctly in Foreman's counts, so it isn't required.
    const required = categories.filter((c) => c !== 'many')
    const wrong: string[] = []
    for (const key of KEYS) {
      const source = en[key] as Message
      const message = CATALOGUES[code][key]
      if (typeof source === 'string' || message === undefined) continue
      if (typeof message === 'string') continue // a plain string is fine where the form never changes
      for (const c of required) if (!(c in message)) wrong.push(`${key}: missing ${c}`)
      for (const c of Object.keys(message)) if (c !== 'zero' && !categories.includes(c)) wrong.push(`${key}: ${c} isn't a ${code} form`)
      if ('zero' in source && !('zero' in message)) wrong.push(`${key}: English has a zero form`)
    }
    expect(wrong).toEqual([])
  })

  it('English plural messages have one and other', () => {
    for (const key of KEYS) {
      const message = en[key] as Message
      if (typeof message !== 'string') expect(Object.keys(message), key).toEqual(expect.arrayContaining(['one', 'other']))
    }
  })
})

describe('i18n: dates, times and ages', () => {
  const now = Date.parse('2026-10-22T12:00:00Z')
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()
  // Intl puts no-break spaces in some languages ("il y a 12 min"); compare with plain ones.
  const plain = (s: string) => s.replace(/\s/g, ' ')

  it('English keeps the compact style', () => {
    expect(timeAgo(ago(20), 'en', now)).toBe('just now')
    expect(timeAgo(ago(12 * 60), 'en', now)).toBe('12m ago')
    expect(timeAgo(ago(3 * 3600 + 5), 'en', now)).toBe('3h ago')
    expect(timeAgo(ago(86400), 'en', now)).toBe('1d ago')
    expect(timeAgo(ago(2 * 86400), 'en', now)).toBe('2d ago')
    expect(timeAgo(undefined, 'en', now)).toBe('')
    expect(timeWaited(ago(12 * 3600), 'en', now)).toBe('12h')
    expect(timeWaited(ago(4 * 60), 'en', now)).toBe('4m')
    expect(timeWaited(ago(5), 'en', now)).toBe('a moment')
  })

  it('other languages use their own words and order', () => {
    expect(plain(timeAgo(ago(12 * 60), 'es', now))).toBe('hace 12 min')
    expect(plain(timeAgo(ago(12 * 60), 'fr', now))).toBe('il y a 12 min')
    expect(plain(timeAgo(ago(3 * 3600), 'de', now))).toBe('vor 3 Std.')
    expect(plain(timeAgo(ago(12 * 60), 'ja', now))).toBe('12分前')
    expect(plain(timeAgo(ago(12 * 60), 'zh-CN', now))).toBe('12分钟前')
    expect(plain(timeAgo(ago(3 * 3600), 'ko', now))).toBe('3시간 전')
    expect(plain(timeAgo(ago(2 * 86400), 'pt-BR', now))).toMatch(/^há 2 dias?$/)
    // Under a minute comes from the catalogue, so each language has its own words.
    for (const code of TRANSLATED) expect(timeAgo(ago(1), code, now)).not.toBe('just now')
  })

  it('formats clock times, dates and numbers per language', () => {
    const at = Date.parse('2026-03-05T14:06:00')
    expect(formatClock(at, 'en')).toBe('02:06 PM')
    expect(formatClock(at, 'de')).toBe('14:06')
    expect(formatDate(at, 'en')).toBe('3/5/2026')
    expect(formatDate(at, 'de')).toBe('5.3.2026')
    expect(formatDate(at, 'ja')).toBe('2026/3/5')
    expect(plain(formatDateTime(at, 'fr', { day: 'numeric', month: 'long' }))).toBe('5 mars')
    expect(plain(formatDateTime(at, 'es', { day: 'numeric', month: 'short' }))).toBe('5 mar')
    expect(formatNumber(12345, 'en')).toBe('12,345')
    expect(plain(formatNumber(12345, 'de'))).toBe('12.345')
  })
})
