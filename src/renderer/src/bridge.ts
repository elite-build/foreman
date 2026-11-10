// Which transport the renderer talks to main through (docs/server.md, "A browser"). In the desktop window the preload
// put `window.foreman` there (Electron IPC); in a browser that loaded /app from the phone server nothing did, and the
// renderer speaks to the same API over /api/ws instead. store.ts re-exports `bridge` and `api`, so components never
// know which one they have.
import { createT, resolveLocale, type LanguageSetting } from '../../shared/i18n'
import type { Bridge } from '../../shared/types'
import { createSocketBridge, type SocketBridge } from './socketBridge'

declare global {
  interface Window {
    foreman: Bridge
  }
}

// The language setting, as the store has it. The store hands over a getter rather than this importing the store, which
// imports this.
let language: () => LanguageSetting | undefined = () => undefined
export function followLanguage(get: () => LanguageSetting | undefined): void {
  language = get
}

const systemLanguages = () => (typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language])

/** The socket bridge, or null in the desktop window. It opens its connection the first time it is used. */
export const socketBridge: SocketBridge | null = window.foreman ? null : createSocketBridge({ text: (key) => createT(resolveLocale(language(), systemLanguages()))(key) })

export const bridge: Bridge = window.foreman ?? socketBridge!

/** The desktop window, or the renderer in a browser: what only the window can do is hidden or refused in a browser. */
export const clientKind: 'window' | 'browser' = socketBridge ? 'browser' : 'window'
