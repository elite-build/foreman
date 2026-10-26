import { describe, expect, it } from 'vitest'
import {
  CATALOGUES,
  completeness,
  createT,
  interpolate,
  LOCALES,
  matchLocale,
  resolveLocale,
  resolveSystemLocale,
  translate,
  translateRich,
  type Catalogue,
  type MessageKey
} from '../src/shared/i18n'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'

const KEYS = Object.keys(en) as MessageKey[]

describe('i18n: lookup and fallback', () => {
  it('English is the source and translates to itself', () => {
    expect(translate('en', 'sidebar.filter.needsYou')).toBe('Needs you')
  })

  it('a locale uses its own text when it has it', () => {
    expect(translate('es', 'sidebar.filter.needsYou')).toBe('Te necesitan')
  })

  it('a key a locale has not translated falls back to English, never blank or the raw key', () => {
    // Every locale is complete since O13b, so an empty catalogue stands in for an untranslated one.
    expect(translate('fr', 'sidebar.filter.pinned', undefined, {})).toBe('Pinned')
    const partial: Catalogue = { 'sidebar.filter.all': 'Tous', 'sidebar.filter.running': '' }
    expect(translate('fr', 'sidebar.filter.all', undefined, partial)).toBe('Tous')
    // An empty string counts as untranslated.
    expect(translate('fr', 'sidebar.filter.running', undefined, partial)).toBe('Running')
  })

  it('createT binds a locale', () => {
    const t = createT('es')
    expect(t('sidebar.filter.all')).toBe('Todos')
    expect(t('sidebar.needsYouCount', { count: 3 })).toBe('Te necesitan · 3')
  })

  it('checks keys and params at compile time', () => {
    const t = createT('en')
    // @ts-expect-error {keys} is required
    t('settings.general.followUp.detailQueue')
    // @ts-expect-error a key without placeholders takes no params
    t('sidebar.filter.all', { count: 1 })
    // @ts-expect-error not a key
    expect(t('sidebar.nope')).toBe('sidebar.nope')
    expect(t('sidebar.runningCount', { count: 2 })).toBe('2 running')
  })

  it('every locale only uses keys English has', () => {
    for (const { code } of LOCALES) for (const key of Object.keys(CATALOGUES[code])) expect(KEYS).toContain(key)
  })
})

describe('i18n: interpolation', () => {
  it('fills {name} placeholders, repeated ones too', () => {
    expect(interpolate('Use {keys} to {verb}, {keys}!', { keys: '⌘ Enter', verb: 'queue' })).toBe('Use ⌘ Enter to queue, ⌘ Enter!')
    expect(translate('en', 'settings.general.followUp.detailQueue', { keys: 'Ctrl+Enter' })).toBe('Use Ctrl+Enter to queue')
    expect(translate('es', 'settings.general.followUp.detailQueue', { keys: '⌘ Enter' })).toBe('Usa ⌘ Enter para poner en cola')
  })

  it('leaves a placeholder with no value as written', () => {
    expect(interpolate('Hello {name}', {})).toBe('Hello {name}')
    expect(interpolate('Hello {name}')).toBe('Hello {name}')
  })

  it('takes numbers', () => {
    expect(interpolate('{n} items', { n: 0 })).toBe('0 items')
  })

  it('can put non-string values (React nodes) in placeholders', () => {
    const code = { node: 'code' }
    const parts = translateRich('en', 'settings.general.editor.help', { code, cursor: 'C', zed: 'Z' })
    expect(parts[0]).toBe('Used by Open in editor. It gets the folder to open as its argument, for example ')
    expect(parts[1]).toBe(code)
    expect(parts.filter((p) => typeof p === 'string').join('')).toContain(', C or Z.')
    expect(translateRich('es', 'settings.general.editor.help', { code: 'a', cursor: 'b', zed: 'c' }).join('')).toBe(
      'Lo usa Abrir en el editor. Recibe como argumento la carpeta que abrir, por ejemplo a, b o c.'
    )
  })
})

describe('i18n: plurals', () => {
  it('picks the form for the count, with zero as an optional override', () => {
    expect(translate('en', 'sidebar.runningCount', { count: 0 })).toBe('Nothing running')
    expect(translate('en', 'sidebar.runningCount', { count: 1 })).toBe('1 running')
    expect(translate('en', 'sidebar.runningCount', { count: 4 })).toBe('4 running')
    expect(translate('es', 'sidebar.runningCount', { count: 0 })).toBe('Nada en curso')
    expect(translate('es', 'sidebar.runningCount', { count: 2 })).toBe('2 en curso')
  })

  it('uses the locale’s own plural rules and falls back to other', () => {
    const forms = { one: 'one {count}', few: 'few {count}', many: 'many {count}', other: 'other {count}' }
    // Polish-style rules aren't shipped, but the picker must follow Intl's categories: Japanese has only "other".
    const ja: Catalogue = { 'sidebar.runningCount': forms }
    expect(translate('ja', 'sidebar.runningCount', { count: 1 }, ja)).toBe('other 1')
    const fr: Catalogue = { 'sidebar.runningCount': { one: '{count} en cours', other: '{count} en cours (pl)' } }
    // French treats 0 and 1 as "one"; there's no zero form here, so 0 uses "one".
    expect(translate('fr', 'sidebar.runningCount', { count: 0 }, fr)).toBe('0 en cours')
    expect(translate('fr', 'sidebar.runningCount', { count: 1 }, fr)).toBe('1 en cours')
    expect(translate('fr', 'sidebar.runningCount', { count: 2 }, fr)).toBe('2 en cours (pl)')
  })

  it('a translator may give a plain string for a plural key', () => {
    const ko: Catalogue = { 'sidebar.runningCount': '{count}개 실행 중' }
    expect(translate('ko', 'sidebar.runningCount', { count: 3 }, ko)).toBe('3개 실행 중')
  })
})

describe('i18n: completeness', () => {
  it('English is always 100%', () => {
    expect(completeness('en')).toBe(100)
  })

  it('Spanish covers every key', () => {
    expect(KEYS.filter((k) => !(k in es))).toEqual([])
    expect(completeness('es')).toBe(100)
  })

  it('counts translated keys, rounding down so 100% means complete', () => {
    expect(completeness('de', {})).toBe(0)
    const one: Catalogue = { [KEYS[0]]: 'x' }
    expect(completeness('de', one)).toBe(Math.floor(100 / KEYS.length))
    const allButOne = Object.fromEntries(KEYS.slice(1).map((k) => [k, 'x'])) as Catalogue
    expect(completeness('de', allButOne)).toBeLessThan(100)
    // Empty strings don't count.
    expect(completeness('de', { [KEYS[0]]: '' })).toBe(0)
  })
})

describe('i18n: system locale', () => {
  it('maps OS tags onto the supported languages', () => {
    expect(matchLocale('es-MX')).toBe('es')
    expect(matchLocale('es')).toBe('es')
    expect(matchLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(matchLocale('zh-CN')).toBe('zh-CN')
    expect(matchLocale('zh')).toBe('zh-CN')
    expect(matchLocale('pt-BR')).toBe('pt-BR')
    expect(matchLocale('pt-PT')).toBe('pt-BR')
    expect(matchLocale('en-GB')).toBe('en')
    expect(matchLocale('ja-JP')).toBe('ja')
    expect(matchLocale('ko-KR')).toBe('ko')
    expect(matchLocale('fr-CA')).toBe('fr')
    expect(matchLocale('de-AT')).toBe('de')
  })

  it('reads POSIX-style tags', () => {
    expect(matchLocale('es_MX.UTF-8')).toBe('es')
    expect(matchLocale('de_DE@euro')).toBe('de')
  })

  it('does not offer Simplified Chinese for Traditional', () => {
    expect(matchLocale('zh-Hant-TW')).toBeNull()
    expect(matchLocale('zh-TW')).toBeNull()
    expect(matchLocale('zh-HK')).toBeNull()
    expect(matchLocale('zh-Hans-HK')).toBe('zh-CN')
  })

  it('unknown tags give nothing, and the system falls back to English', () => {
    expect(matchLocale('ru-RU')).toBeNull()
    expect(matchLocale('')).toBeNull()
    expect(matchLocale('C')).toBeNull()
    expect(resolveSystemLocale(['ru-RU'])).toBe('en')
    expect(resolveSystemLocale([])).toBe('en')
  })

  it('takes the first preferred language Foreman has', () => {
    expect(resolveSystemLocale(['ru-RU', 'zh-Hant-TW', 'ja-JP', 'en-US'])).toBe('ja')
  })

  it('the setting wins over the system unless it is System', () => {
    expect(resolveLocale('system', ['es-MX'])).toBe('es')
    expect(resolveLocale('de', ['es-MX'])).toBe('de')
    // A value from a newer or hand-edited state.json is treated as System.
    expect(resolveLocale('xx' as never, ['ko-KR'])).toBe('ko')
  })
})
