// The renderer's side of i18n (see shared/i18n): the locale from Settings →
// General → Language, a `t` that re-renders components when it changes, and
// <html lang> kept in step. Switching applies at once; no restart.
import { createElement, Fragment, useLayoutEffect, useMemo, type ReactNode } from 'react'
import { createT, resolveLocale, translateRich, type Locale, type MessageKey, type ParamValue, type TFunction } from '../../shared/i18n'
import { getState, useStore } from './store'

/** The OS's preferred languages, as Chromium reports them. */
export function systemLanguages(): readonly string[] {
  return navigator.languages?.length ? navigator.languages : [navigator.language]
}

export function useLocale(): Locale {
  const setting = useStore((s) => s.snapshot?.settings.language)
  return resolveLocale(setting, systemLanguages())
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

/** `const t = useT()` in a component; it re-renders when the language changes. */
export function useT(): RendererT {
  const locale = useLocale()
  return useMemo(() => rendererT(locale), [locale])
}

/**
 * Outside React (toasts from the store, event handlers): the current language at
 * call time. Components should use useT() so they update when it changes.
 */
export const t: TFunction = (key, ...args) => createT(resolveLocale(getState().snapshot?.settings.language, systemLanguages()))(key, ...args)

/** Rendered once next to <App />; keeps <html lang> on the UI language (screen readers, hyphenation). */
export function LocaleSync(): null {
  const locale = useLocale()
  useLayoutEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  return null
}
