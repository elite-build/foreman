import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
// After App, and so after every feature stylesheet it pulls in: ui/ wins where both style a control.
import './ui/ui.css'
import { AccessibilitySync } from './accessibility'
import { AppearanceSync } from './appearance'
import { LocaleSync } from './i18n'
import { BatterySync } from './components/KeepAwakeChip'
import { initStore } from './store'

// Dev-only: main loads the page with ?screens only for a screenshot run (FOREMAN_SCREENSHOTS=1, main/screenshots.ts).
// The hook pins the clock, so it goes in before the store's first render.
const screens = new URLSearchParams(location.search).has('screens') ? import('./screens').then((m) => m.installScreens()) : undefined

void Promise.resolve(screens).then(initStore).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppearanceSync />
      <AccessibilitySync />
      <LocaleSync />
      <BatterySync />
      <App />
    </StrictMode>
  )
})
