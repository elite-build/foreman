// Dev-only screenshot hook. Installed only when main loads the page with
// ?screens, which it does only under FOREMAN_SCREENSHOTS=1 (main/screenshots.ts). Main asks for one screen per page
// load; the hook gets there with the store's own actions, waits for the page to settle and answers, then main captures.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { chooseHomeLayout } from './components/HomeBoard'
import type { WindowLayout } from '../../shared/types'
import {
  api,
  getState,
  openAssistant,
  openAutomations,
  openNewWorkspace,
  openPhoneSetup,
  openSettingsPage,
  selectSession,
  selectWorkspace,
  showBottomPanel,
  showChecksPanel,
  showRepoHome,
  toggleLeftPanel,
  toggleRightPanel
} from './store'
import { readWalk, type WalkReading } from './walk'

interface Fixture {
  repoId: string
  workspaceId: string
  chatId: string
  queueChatId: string
  now: number
}

declare global {
  interface Window {
    __foremanScreens?: {
      show: (screen: string, fixture: Fixture) => Promise<{ skipped?: string; pages?: number }>
      // A screen taller than the window (the component galleries) is taken a page at a time.
      page?: (index: number) => Promise<void>
      // The keyboard walk (main/keyboardWalk.ts): what has focus and what the live region says, after main pressed a key.
      probe: (watch?: string[]) => WalkReading
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
// A covered window may not paint; a frame waits 100 ms at most.
const frame = () => new Promise<void>((resolve) => (requestAnimationFrame(() => resolve()), setTimeout(resolve, 100)))

async function waitFor<T>(find: () => T | null | undefined | false, timeoutMs = 8000): Promise<T | null> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const found = find()
    if (found) return found
    if (Date.now() > end) return null
    await sleep(50)
  }
}

const element = (selector: string) => () => document.querySelector<HTMLElement>(selector)

/** Fonts loaded, then no DOM change for `quietMs` (at most `maxMs`), then two frames painted. */
async function settle(quietMs = 400, maxMs = 5000): Promise<void> {
  await document.fonts.ready
  await new Promise<void>((resolve) => {
    let timer = setTimeout(done, quietMs)
    const cap = setTimeout(done, maxMs)
    const observer = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(done, quietMs)
    })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    function done() {
      observer.disconnect()
      clearTimeout(timer)
      clearTimeout(cap)
      resolve()
    }
  })
  await frame()
  await frame()
}

/** Both side panels open and the terminal panel closed, unless a screen asks for it. */
function baseLayout(): void {
  const s = getState()
  if (!s.leftPanelOpen) toggleLeftPanel()
  if (!s.rightPanelOpen) toggleRightPanel()
  showBottomPanel(false)
  chooseHomeLayout('list')
}

/** The window layout a screen is taken in: Three panes, unless the screen asks for Tiles. It's a setting, so it outlives the page. */
async function windowLayout(layout: WindowLayout): Promise<void> {
  if (getState().snapshot?.settings.windowLayout === layout) return
  await api.updateSettings({ windowLayout: layout })
  await waitFor(() => getState().snapshot?.settings.windowLayout === layout)
}

function openWorkspace(f: Fixture, sessionId = f.chatId): void {
  selectWorkspace(f.workspaceId)
  selectSession(f.workspaceId, sessionId)
}

// Each screen: get there, and name what shows it has rendered.
const SCREENS: Record<string, (f: Fixture) => Promise<string | null> | string | null> = {
  home: () => (showRepoHome(null), '.home .home-row, .home .home-card'),
  'home-board': () => {
    showRepoHome(null)
    chooseHomeLayout('board')
    return '.home .board'
  },
  'workspace-chat': (f) => (openWorkspace(f), '.chat .user-msg'),
  'composer-queue': (f) => (openWorkspace(f, f.queueChatId), '.composer .queued, .queued'),
  terminal: async (f) => {
    openWorkspace(f)
    showBottomPanel(true)
    const tab = await waitFor(element('.bottom-tabs .bottom-tab > button'))
    if (!tab) return null
    tab.click()
    const screen = await waitFor(element('.terminal .xterm-screen'))
    // The shell's prompt.
    if (screen) await sleep(1500)
    return '.terminal .xterm-screen'
  },
  'file-diff': async (f) => {
    openWorkspace(f)
    const row = await waitFor(() => [...document.querySelectorAll<HTMLElement>('.panel-changes .change-row')].find((r) => r.title === 'src/login.ts'))
    if (!row) return null
    row.click()
    return '.file-diff'
  },
  'git-panel': (f) => {
    openWorkspace(f)
    showChecksPanel(f.workspaceId)
    return '.side-panel .checks'
  },
  tiles: async (f) => {
    await windowLayout('tiles')
    openWorkspace(f)
    return '.tiles-grid .tile .chat'
  },
  'new-workspace': (f) => {
    showRepoHome(null)
    openNewWorkspace(f.repoId)
    return '.nw-modal'
  },
  'settings-general': () => (openSettingsPage({ section: 'general' }), '.settings-view'),
  'settings-agents': () => (openSettingsPage({ section: 'agents' }), '.settings-view'),
  'settings-appearance': () => (openSettingsPage({ section: 'appearance' }), '.settings-view'),
  'settings-accessibility': () => (openSettingsPage({ section: 'accessibility' }), '.settings-view'),
  'settings-cloud': () => (openSettingsPage({ section: 'cloud' }), '.settings-view'),
  'settings-repo': (f) => (openSettingsPage({ section: 'repo', repoId: f.repoId }), '.settings-view'),
  'settings-integrations': () => (openSettingsPage({ section: 'integrations' }), '.settings-view'),
  automations: () => (openAutomations(), '.automations-view'),
  assistant: () => (openAssistant(), '.assistant-view'),
  'phone-pairing': () => {
    showRepoHome(null)
    openPhoneSetup(true)
    return '.phone-setup-modal'
  },
  // A settings row reached from the navigation, with its flash held (ui/flash.ts `hold`).
  'flash-loadout': () => showFlash({ section: 'models' }, 'loadout'),
  'flash-claude-models': () => showFlash({ section: 'agents', agent: 'claude' }, 'models-claude'),
  'flash-claude-agent': () => showFlash({ section: 'agents', agent: 'claude' }, 'agent-claude'),
  'flash-chrome-mode': () => showFlash({ section: 'agents', agent: 'claude' }, 'chrome-mode'),
  'flash-output-style': () => showFlash({ section: 'models' }, 'claude-output-style'),
  'gallery-2a': () => showGallery('2a'),
  'gallery-2b': () => showGallery('2b'),
  'gallery-2c': () => showGallery('2c'),
  'gallery-2d': () => showGallery('2d')
}

async function showFlash(page: Parameters<typeof openSettingsPage>[0] & object, rowId: string): Promise<string | null> {
  openSettingsPage({ ...page, scrollTo: rowId })
  const lit = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[data-ui-flash]')]
    return found.length ? found : null
  })
  if (!lit) return null
  // Hold the flash (ui/flash: `hold` keeps its wash on, with no fade and no timer): it goes after 1.4 s otherwise. A tall
  // target lights its title and description, so every lit element is held.
  for (const el of lit) el.setAttribute('data-ui-flash', 'hold')
  return '[data-ui-flash]'
}

// The design system's component galleries (ui/gallery/), drawn over the app in its theme, one batch per screen.
const GALLERIES = {
  '2a': () => import('./ui/gallery/2a').then((m) => m.Gallery2a),
  '2b': () => import('./ui/gallery/2b').then((m) => m.Gallery2b),
  '2c': () => import('./ui/gallery/2c').then((m) => m.Gallery2c),
  '2d': () => import('./ui/gallery/2d').then((m) => m.Gallery2d)
}

async function showGallery(batch: keyof typeof GALLERIES): Promise<string> {
  const Gallery = await GALLERIES[batch]()
  const host = document.createElement('div')
  host.className = 'screens-gallery'
  host.style.cssText = 'position:fixed;inset:0;z-index:1000;overflow:auto;padding:24px 32px;background:var(--bg);color:var(--text)'
  document.body.append(host)
  createRoot(host).render(createElement(Gallery))
  return '.screens-gallery > *'
}

function galleryPages(): number {
  const host = document.querySelector<HTMLElement>('.screens-gallery')
  return host ? Math.max(1, Math.ceil(host.scrollHeight / host.clientHeight)) : 1
}

/**
 * Before the store loads: the page's clock starts at the time main pinned (?screens=<ms>) and runs on from there, so
 * relative times don't tick over between runs; and no animation or transition, so spinners and fades stop at rest.
 */
function pinPage(): void {
  const pinned = Number(new URLSearchParams(location.search).get('screens'))
  if (pinned > 1) {
    const realNow = Date.now.bind(Date)
    const offset = realNow() - pinned
    Date.now = () => realNow() - offset
  }
  const style = document.createElement('style')
  style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'
  document.head.append(style)
}

export function installScreens(): void {
  pinPage()
  window.__foremanScreens = {
    async show(screen, fixture) {
      const go = SCREENS[screen]
      if (!go) return { skipped: `unknown screen ${screen}` }
      if (!(await waitFor(() => getState().snapshot, 15_000))) return { skipped: 'the store never loaded' }
      baseLayout()
      await windowLayout('panes')
      const selector = await go(fixture)
      if (!selector || !(await waitFor(element(selector)))) return { skipped: `${screen} did not render${selector ? ` (${selector})` : ''}` }
      await settle()
      // No caret or focus ring left by navigation, so runs compare.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      await settle(200, 1000)
      return { pages: galleryPages() }
    },
    async page(index) {
      const host = document.querySelector<HTMLElement>('.screens-gallery')
      if (host) host.scrollTop = index * host.clientHeight
      await settle(200, 1000)
    },
    probe: (watch) => readWalk(watch)
  }
}
