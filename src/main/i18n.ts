// Foreman's own words in the main process (O13b): notifications, native dialogs, the app menu, the tray and
// phone pushes, in Settings → General → Language. Errors, logs, agent prompts and `foreman` CLI output stay English.
// Electron isn't imported here, so tests and the agent host can load anything that uses this; index.ts hands
// over the OS's languages at startup, and without them the process's own locale stands in.
import { createT, resolveLocale, type LanguageSetting, type Locale, type TFunction } from '../shared/i18n'

let systemLanguages: () => readonly string[] = () => []

/** index.ts: Electron's app.getPreferredSystemLanguages() and app.getLocale(), best first. */
export function setSystemLanguages(source: () => readonly string[]): void {
  systemLanguages = source
}

/** The OS's languages, best first: the injected list, then the process's own locale. */
function preferred(): string[] {
  let tags: readonly string[] = []
  try {
    tags = systemLanguages()
  } catch {
    // Not ready yet: the process's own locale.
  }
  return [...tags, Intl.DateTimeFormat().resolvedOptions().locale]
}

/** The locale main's text is shown in. A missing setting (tests) counts as System. */
export function mainLocale(settings: { language?: LanguageSetting } | undefined): Locale {
  return resolveLocale(settings?.language, preferred())
}

/** A `t` in the user's language, for text main shows (resolve it when the text is made, not once). */
export function mainT(settings: { language?: LanguageSetting } | undefined): TFunction {
  return createT(mainLocale(settings))
}
