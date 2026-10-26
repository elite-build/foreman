// Keeps <html> in sync with the appearance settings: the colour-vision data
// attribute that ui/tokens.css keys its overrides on, plus the mono font and
// ligature variables.
import { useLayoutEffect } from 'react'
import type { Settings } from '../../shared/types'
import { useStore } from './store'
import { fontStack, MONO_FALLBACK, notifyAppearanceChange } from './theme'

type AppearanceSettings = Pick<Settings, 'colorVision' | 'monoFont' | 'codeLigatures'>

// Names offered in Settings → the font-family names to ask for.
const FONT_ALIASES: Record<string, string> = {
  'Geist Mono': '"Geist Mono Variable", "Geist Mono"',
  'iA Writer Mono': '"iA Writer Mono", "iA Writer Mono S", "iA Writer Mono V"'
}

export function monoStack(font: string): string {
  const name = font.trim()
  const alias = FONT_ALIASES[name || 'Geist Mono']
  return alias ? `${alias}, ${MONO_FALLBACK}` : fontStack(name, MONO_FALLBACK)
}

export function applyAppearance(settings: AppearanceSettings): void {
  const root = document.documentElement
  root.dataset.colorVision = settings.colorVision || 'default'
  root.style.setProperty('--mono', monoStack(settings.monoFont ?? ''))
  root.style.setProperty('--code-ligatures', settings.codeLigatures === false ? 'none' : 'normal')
  notifyAppearanceChange()
}

/** Rendered once next to <App />; applies the settings before each paint. */
export function AppearanceSync(): null {
  const colorVision = useStore((s) => s.snapshot?.settings.colorVision ?? 'default')
  const monoFont = useStore((s) => s.snapshot?.settings.monoFont ?? '')
  const codeLigatures = useStore((s) => s.snapshot?.settings.codeLigatures ?? true)

  useLayoutEffect(() => {
    applyAppearance({ colorVision, monoFont, codeLigatures })
  }, [colorVision, monoFont, codeLigatures])

  return null
}
