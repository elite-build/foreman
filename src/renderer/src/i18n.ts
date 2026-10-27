// The renderer's side of i18n (see shared/i18n): the locale from Settings →
// General → Language, a `t` that re-renders components when it changes, and
// <html lang> kept in step. Switching applies at once; no restart.
import { createContext, createElement, Fragment, useContext, useLayoutEffect, type ReactNode } from 'react'
import { createT, resolveLocale, translateRich, type Locale, type MessageKey, type ParamValue, type TFunction } from '../../shared/i18n'
import { getState, useStore } from './store'

/** The OS's preferred languages, as Chromium reports them. */
export function systemLanguages(): readonly string[] {
  return navigator.languages?.length ? navigator.languages : [navigator.language]
}

export interface RendererT extends TFunction {
  /** A string whose placeholders take React nodes, e.g. `t.rich('…', { code: <code>code</code> })`. */
  rich: (key: MessageKey, nodes: Record<string, ParamValue | ReactNode>) => ReactNode[]
  locale: Locale
}

function rendererT(locale: Locale): RendererT {
  return Object.assign(createT(locale), {
    // Each part gets a keyed Fragment: the result is rendered as an array, and callers pass bare elements.
    rich: (key: MessageKey, nodes: Record<string, ParamValue | ReactNode>) =>
      translateRich<ReactNode>(locale, key, nodes).map((part, i) => createElement(Fragment, { key: i }, part)),
    locale
  })
}

// One `t` per locale, so every component gets the same function (and memo'd ones see no change).
const byLocale = new Map<Locale, RendererT>()
function tFor(locale: Locale): RendererT {
  let t = byLocale.get(locale)
  if (!t) byLocale.set(locale, (t = rendererT(locale)))
  return t
}

// The `t` for the language setting, provided once at the root (LocaleProvider): nearly every component translates, and a
// store subscription in each (every chat row among them) made each store event read the setting thousands of times.
const LocaleContext = createContext<RendererT | null>(null)

/** Around the whole app (main.tsx): the one place that follows the language setting, for every `useT` below it. */
export function LocaleProvider({ children }: { children?: ReactNode }): ReactNode {
  const setting = useStore((s) => s.snapshot?.settings.language)
  const t = tFor(resolveLocale(setting, systemLanguages()))
  return createElement(LocaleContext.Provider, { value: t }, children)
}

/** `const t = useT()` in a component; it re-renders when the language changes. */
export function useT(): RendererT {
  // Outside a LocaleProvider (a component rendered on its own, as in a test): the language as it is at this render.
  return useContext(LocaleContext) ?? tFor(currentLocale())
}

export function useLocale(): Locale {
  return useT().locale
}

function currentLocale(): Locale {
  return resolveLocale(getState().snapshot?.settings.language, systemLanguages())
}

/**
 * Outside React (toasts from the store, event handlers): the current language at
 * call time. Components should use useT() so they update when it changes.
 */
export const t: TFunction = (key, ...args) => createT(currentLocale())(key, ...args)

/** Rendered once next to <App />; keeps <html lang> on the UI language (screen readers, hyphenation). */
export function LocaleSync(): null {
  const locale = useLocale()
  useLayoutEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  return null
}
