// Keeps <html> in sync with the Accessibility settings: the content text size property and the resolved
// reduce-motion attribute (theme.ts), which the stylesheets and code like ui/flash.ts read.
import { useLayoutEffect } from 'react'
import { useStore } from './store'
import { setContentFontSize, setReduceMotionSetting } from './theme'

/** Rendered once next to <AppearanceSync />; applies the settings before each paint. */
export function AccessibilitySync(): null {
  const contentFontSize = useStore((s) => s.snapshot?.settings.contentFontSize)
  const reduceMotion = useStore((s) => s.snapshot?.settings.reduceMotion)

  useLayoutEffect(() => setContentFontSize(contentFontSize), [contentFontSize])
  useLayoutEffect(() => setReduceMotionSetting(reduceMotion), [reduceMotion])

  return null
}
