// Bridges the CSS theme tokens to code that needs concrete values (xterm).
import type { ITheme } from '@xterm/xterm'
import { useSyncExternalStore } from 'react'
import type { Settings } from '../../shared/types'
// Content text size rules (chat Markdown, diffs, the file viewer); last in the cascade, so loaded from here.
import './styles/content-size.css'

const media = window.matchMedia('(prefers-color-scheme: dark)')

// ---- Reduce motion: one resolved value for CSS (html[data-reduce-motion]) and for code ----

/** The reduce-motion setting resolved: 'on' and 'off' as chosen, 'auto' as the OS asks. */
export function resolveReduceMotion(setting: Settings['reduceMotion'] | undefined, osReduces: boolean | undefined): boolean {
  if (setting === 'on') return true
  if (setting === 'off') return false
  return osReduces === true
}

const motionMedia = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
const motionListeners = new Set<() => void>()
let motionSetting: Settings['reduceMotion'] = 'auto'
let motionResolved = false

function applyReduceMotion(): void {
  const next = resolveReduceMotion(motionSetting, motionMedia?.matches)
  document.documentElement.dataset.reduceMotion = next ? 'on' : 'off'
  if (next === motionResolved) return
  motionResolved = next
  for (const listener of motionListeners) listener()
}

/** Called when the setting loads or changes. Until then (and for 'auto') the OS preference decides, live. */
export function setReduceMotionSetting(setting: Settings['reduceMotion'] | undefined): void {
  motionSetting = setting === 'on' || setting === 'off' ? setting : 'auto'
  applyReduceMotion()
}

/** Whether motion is reduced right now: what html[data-reduce-motion="on"] means to the stylesheets. */
export function reduceMotion(): boolean {
  return motionResolved
}

function onReduceMotionChange(listener: () => void): () => void {
  motionListeners.add(listener)
  return () => motionListeners.delete(listener)
}

/** reduceMotion() for a component: re-renders when the setting or the OS preference changes. */
export function useReduceMotion(): boolean {
  return useSyncExternalStore(onReduceMotionChange, reduceMotion)
}

motionMedia?.addEventListener?.('change', applyReduceMotion)
applyReduceMotion()

/** The content text size in px (12-24) as ui/tokens.css's --text-content reads it; anything else puts the default back. */
export function setContentFontSize(px: number | undefined): void {
  const root = document.documentElement
  if (typeof px === 'number' && Number.isFinite(px)) root.style.setProperty('--content-font-size', `${Math.min(Math.max(Math.round(px), 12), 24)}px`)
  else root.style.removeProperty('--content-font-size')
}

/** What follows a chosen mono font (matches --mono in styles.css). */
export const MONO_FALLBACK = 'ui-monospace, Menlo, Consolas, monospace'
const TERMINAL_FONT = `"Geist Mono Variable", ${MONO_FALLBACK}`

/** A font name typed by the user, put in front of a fallback stack. */
export function fontStack(font: string, fallback: string): string {
  const name = font.trim().replace(/^['"]|['"]$/g, '')
  if (!name) return fallback
  // Already a stack ("Fira Code, monospace"): keep it as written.
  return `${name.includes(',') ? name : `"${name}"`}, ${fallback}`
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function terminalTheme(): ITheme {
  const dark = media.matches
  return {
    background: token('--term-bg'),
    foreground: token('--term-fg'),
    cursor: token('--term-fg'),
    cursorAccent: token('--term-bg'),
    selectionBackground: token('--term-selection'),
    // Keep ANSI black/white readable on either background.
    black: dark ? '#1c1816' : '#3a332f',
    brightBlack: dark ? '#6d6460' : '#8a807a',
    white: dark ? '#d8d0cb' : '#6d6460',
    brightWhite: dark ? '#f5f0ec' : '#3a332f'
  }
}

let colorProbe: CanvasRenderingContext2D | null = null

/** Any CSS colour as [r, g, b], via the canvas's own parser; null if it can't be read. */
function rgbOf(color: string): [number, number, number] | null {
  colorProbe ??= document.createElement('canvas').getContext('2d')
  if (!colorProbe || !color) return null
  colorProbe.fillStyle = '#000000'
  colorProbe.fillStyle = color
  const value = String(colorProbe.fillStyle)
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1]
  if (hex) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
  const parts = /^rgba?\(([^)]+)\)/.exec(value)?.[1].split(',').map((p) => Number(p.trim()))
  return parts && parts.length >= 3 ? [parts[0], parts[1], parts[2]] : null
}

/** `share` of colour a over b, as #rrggbb (xterm decorations take only that form). */
function mixHex(a: string, b: string, share: number): string | undefined {
  const x = rgbOf(a)
  const y = rgbOf(b) ?? x
  if (!x || !y) return undefined
  return `#${x.map((v, i) => Math.round(v * share + y[i] * (1 - share)).toString(16).padStart(2, '0')).join('')}`
}

/** Find-in-terminal highlights (O3): every match in a light amber, the current one in full amber, as the chat's find does. */
export function terminalSearchColors(): { matchBackground?: string; activeMatchBackground?: string; matchOverviewRuler: string; activeMatchColorOverviewRuler: string } {
  const amber = token('--amber')
  const panel = token('--bg-panel')
  const active = mixHex(amber, panel, 1)
  return {
    matchBackground: mixHex(amber, panel, 0.32),
    activeMatchBackground: active,
    matchOverviewRuler: active ?? amber,
    activeMatchColorOverviewRuler: active ?? amber
  }
}

type TerminalSettings = Pick<Settings, 'terminalFont' | 'terminalFontSize' | 'terminalScrollbackMb'> & Partial<Pick<Settings, 'terminalScreenReader' | 'contentFontSize'>>

/** Whether terminals run xterm's screen reader mode: the setting, where 'auto' (and anything unknown) follows the OS. */
export function screenReaderMode(setting: Settings['terminalScreenReader'] | undefined, osReportsScreenReader: boolean | undefined): boolean {
  if (setting === 'on') return true
  if (setting === 'off') return false
  return osReportsScreenReader === true
}

/** xterm options that follow the terminal settings. */
export function terminalOptions(settings: TerminalSettings | undefined, osReportsScreenReader?: boolean): { fontFamily: string; fontSize: number; scrollback: number; screenReaderMode: boolean } {
  // 'content': the terminal follows the content text size (13 until it is known).
  const size = Number(settings?.terminalFontSize === 'content' ? (settings.contentFontSize ?? 13) : settings?.terminalFontSize)
  const mb = Number(settings?.terminalScrollbackMb)
  return {
    fontFamily: fontStack(settings?.terminalFont ?? '', TERMINAL_FONT),
    fontSize: Number.isFinite(size) && size > 0 ? Math.min(Math.max(Math.round(size), 8), 32) : 12,
    // Roughly 5000 lines per megabyte.
    scrollback: Number.isFinite(mb) && mb >= 0 ? Math.round(mb * 5000) : 10_000,
    screenReaderMode: screenReaderMode(settings?.terminalScreenReader, osReportsScreenReader)
  }
}

const listeners = new Set<() => void>()

/** Called by appearance.ts after it changes the document's colours. */
export function notifyAppearanceChange(): void {
  for (const listener of listeners) listener()
}

/** Calls back whenever the effective colours change: light/dark, or an appearance setting. */
export function onAppearanceChange(callback: () => void): () => void {
  media.addEventListener('change', callback)
  listeners.add(callback)
  return () => {
    media.removeEventListener('change', callback)
    listeners.delete(callback)
  }
}
