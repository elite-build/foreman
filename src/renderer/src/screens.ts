// Dev-only screenshot hook. Installed only when main loads the page with
// ?screens, which it does only under FOREMAN_SCREENSHOTS=1 (main/screenshots.ts). Main asks for one screen per page
// load; the hook gets there with the store's own actions, waits for the page to settle and answers, then main captures.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { chooseHomeLayout } from './components/HomeBoard'
import { FLOW_STARTERS } from '../../shared/flowStarters'
import type { WindowLayout } from '../../shared/types'
import {
  api,
  getState,
  openAddRepoDialog,
  openAssistant,
  openAutomations,
  openFlowDraft,
  openNewWorkspace,
  openPhoneSetup,
  openSettingsPage,
  selectSession,
  selectWorkspace,
  setWorkspaceFocus,
  showBottomPanel,
  showChecksPanel,
  showEditorSidebar,
  showRepoHome,
  toggleLeftPanel,
  toggleRailNames,
  toggleRightPanel
} from './store'
import { rowDomId } from './components/settings/controls'
import { readWalk, type WalkReading } from './walk'

interface Fixture {
  repoId: string
  workspaceId: string
  chatId: string
  queueChatId: string
  flowWorkspaceId: string
  flowChatId: string
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

/** Both side panels open, the rail narrow and the terminal panel closed, unless a screen asks for it. */
function baseLayout(): void {
  const s = getState()
  if (!s.leftPanelOpen) toggleLeftPanel()
  if (s.railNames) toggleRailNames()
  if (!s.rightPanelOpen) toggleRightPanel()
  showBottomPanel(false)
  // A terminal or Flow run left in a workspace's middle is kept across restarts, so each screen starts without one.
  for (const id of Object.keys(s.workspaceFocus)) setWorkspaceFocus(id, null)
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

// The screens taken with Settings → Experimental → Flows on; every other screen turns it off, so they look as they did.
const FLOW_SCREENS: readonly string[] = ['automations-flows', 'automations-flow-runs', 'automations-flow-run', 'automations-flow-run-models', 'automations-flow-studio', 'automations-flow-studio-step', 'automations-flow-new', 'automations-flow-rename', 'new-workspace-flow', 'workspace-flow', 'workspace-flow-full', 'workspace-lineage']

/** Flows on or off. A setting, so it outlives the page, like the window layout. */
async function flowsSetting(on: boolean): Promise<void> {
  if (Boolean(getState().snapshot?.settings.flows) === on) return
  await api.updateSettings({ flows: on })
  await waitFor(() => Boolean(getState().snapshot?.settings.flows) === on)
}

/** The flow run's workspace with one of its side panel's tabs open; done when that tab's diagram has drawn. */
async function flowTab(f: Fixture, tab: 'flow' | 'lineage'): Promise<string | null> {
  selectWorkspace(f.flowWorkspaceId)
  selectSession(f.flowWorkspaceId, f.flowChatId)
  const button = await waitFor(element(`.side-panel [role="tab"][data-tab-value="${tab}"]`))
  if (!button) return null
  button.click()
  // The graph is drawn once the tab has read the run (the Flow tab) or the history (Lineage).
  return '.side-panel .flow-run .ui-graph .ui-graph__node'
}

// Each screen: get there, and name what shows it has rendered.
const SCREENS: Record<string, (f: Fixture) => Promise<string | null> | string | null> = {
  home: () => (showRepoHome(null), '.home .home-row, .home .home-card'),
  'home-board': () => {
    showRepoHome(null)
    chooseHomeLayout('board')
    return '.home .board'
  },
  // The rail widened in place: each repository's name and what is going on in it beside its tile (baseLayout narrows it).
  'repo-names': () => {
    showRepoHome(null)
    if (!getState().railNames) toggleRailNames()
    return '.repo-rail.names .rail-name'
  },
  'workspace-chat': (f) => (openWorkspace(f), '.chat .user-msg'),
  // The composer's context ring, pressed: what fills the chat's context window.
  'context-usage': async (f) => {
    openWorkspace(f)
    const ring = await waitFor(element('.composer-toolbar button[aria-label^="Context:"]'))
    if (!ring) return null
    ring.click()
    return '.context-pop'
  },
  'composer-queue': (f) => (openWorkspace(f, f.queueChatId), '.composer .queued, .queued'),
  // The terminal panel with no run script and nothing open: the Run tab's launcher.
  'run-launcher': (f) => (openWorkspace(f), showBottomPanel(true), '.bottom-panel .run-launch'),
  terminal: async (f) => {
    openWorkspace(f)
    showBottomPanel(true)
    // No terminal is open until one is asked for: + → New terminal (the menu's first item).
    const plus = await waitFor(element('.bottom-head .new-menu button'))
    if (!plus) return null
    plus.click()
    const item = await waitFor(element('.bottom-menu [role="menuitem"]'))
    if (!item) return null
    item.click()
    const screen = await waitFor(element('.terminal .xterm-screen'))
    // The shell's prompt.
    if (screen) await sleep(1500)
    return '.terminal .xterm-screen'
  },
  // The terminal in the workspace's middle (⌘⇧J), the chat in the side panel's Chat tab (O3).
  'terminal-full': async (f) => {
    const shown = await SCREENS.terminal(f)
    if (!shown) return null
    setWorkspaceFocus(f.workspaceId, 'terminal')
    return '.focus-slot .terminal .xterm-screen'
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
  // The Editor layout with a file open from Changes: the diff in the middle, the chat beside it.
  editor: async (f) => {
    await windowLayout('editor')
    showEditorSidebar('changes')
    openWorkspace(f)
    const row = await waitFor(() => [...document.querySelectorAll<HTMLElement>('.workspace.editor-arrangement .panel-changes .change-row')].find((r) => r.title === 'src/login.ts'))
    if (!row) return null
    row.click()
    return '.workspace.editor-arrangement .file-diff'
  },
  'new-workspace': (f) => {
    showRepoHome(null)
    openNewWorkspace(f.repoId)
    return '.nw-modal'
  },
  'new-workspace-branch': async (f) => {
    showRepoHome(null)
    openNewWorkspace(f.repoId)
    const existing = await waitFor(() => document.querySelector<HTMLInputElement>('.nw-branch input[value="existing"]'))
    if (!existing) return null
    existing.click()
    return '.nw-branch-shelf'
  },
  // Flows on: New workspace's Flow tab, the repository's runnable flows listed and the first one chosen.
  'new-workspace-flow': async (f) => {
    showRepoHome(null)
    openNewWorkspace(f.repoId)
    const flow = await waitFor(() => [...document.querySelectorAll<HTMLElement>('.nw-start-with [role="radio"]')].find((r) => r.textContent === 'Flow'))
    if (!flow) return null
    flow.click()
    return '.nw-flow .flow-picker'
  },
  // Clone GitHub repo, with the fixture's repos listed (main answers githubRepos for the run).
  'clone-repo': () => {
    showRepoHome(null)
    openAddRepoDialog('clone')
    return '.add-repo-combo .ui-option'
  },
  'settings-general': () => (openSettingsPage({ section: 'general' }), '.settings-view'),
  'settings-agents': () => (openSettingsPage({ section: 'agents' }), '.settings-view'),
  // #130: Claude Code's page scrolled to its Accounts section.
  'settings-agent-accounts': () => claudeAccounts(),
  // The Work account's dialog: its details, then its sign-in.
  'agent-account-dialog': async () => {
    if (!(await claudeAccounts())) return null
    const edit = await waitFor(element('.ag-account-actions button'))
    if (!edit) return null
    edit.click()
    return '.ag-dialog .ag-account-signin'
  },
  // The composer's picker on a Claude chat: the Account row under effort and fast.
  'picker-account': async (f) => {
    openWorkspace(f)
    return (await openPicker()) ? '.picker-controls .ui-select' : null
  },
  // The Codex tab, scrolled to its sign-in.
  'settings-agents-codex': async () => {
    openSettingsPage({ section: 'agents', agent: 'codex' })
    const row = await waitFor(() => document.getElementById(rowDomId('agent-codex')))
    if (!row) return null
    row.scrollIntoView({ block: 'start' })
    return '.settings-view'
  },
  'settings-appearance': () => (openSettingsPage({ section: 'appearance' }), '.settings-view'),
  'settings-accessibility': () => (openSettingsPage({ section: 'accessibility' }), '.settings-view'),
  'settings-cloud': () => (openSettingsPage({ section: 'cloud' }), '.settings-view'),
  'settings-repo': (f) => (openSettingsPage({ section: 'repo', repoId: f.repoId }), '.settings-view'),
  'settings-integrations': () => (openSettingsPage({ section: 'integrations' }), '.settings-view'),
  // Data & devices, scrolled to its Devices section: hand-offs, control from other computers, pairing.
  'settings-devices': async () => {
    openSettingsPage({ section: 'data' })
    const row = await waitFor(() => document.getElementById(rowDomId('accept-hand-offs')))
    if (!row) return null
    row.scrollIntoView({ block: 'start' })
    return '.settings-view'
  },
  automations: () => (openAutomations(), '.automations-view'),
  // A built-in template open as its own page.
  'automations-template': () => (openAutomations('t:default-fix-bug'), '.automations-view .auto-page'),
  // Flows on: the built-in and repository flows with their runs, then the personas.
  'automations-flows': async () => {
    openAutomations()
    if (!(await waitFor(() => document.querySelectorAll('.automations-view .flow-item').length >= 3))) return null
    return '.automations-view .flow-runs'
  },
  // The same section switched to every flow's runs, as a table.
  'automations-flow-runs': async () => {
    openAutomations()
    const runs = await waitFor(() => [...document.querySelectorAll<HTMLElement>('.automations-view [role="radio"]')].find((r) => r.textContent === 'Runs') ?? null)
    if (!runs) return null
    runs.click()
    return '.automations-view .flow-runs-table tbody tr'
  },
  // Run a flow on a built-in flow: the bar, the tabs and the graph with each step's model.
  'automations-flow-run': () => (openAutomations('r:built-in:research-then-implement'), '.frp .ui-graph__node'),
  // The same on its Models tab: the tiers, and a model and effort per person.
  'automations-flow-run-models': async () => {
    openAutomations('r:built-in:research-then-implement')
    const tab = await waitFor(() => [...document.querySelectorAll<HTMLElement>('.frp [role="tab"]')].find((t) => t.textContent?.startsWith('Models')) ?? null)
    if (!tab) return null
    tab.click()
    return '.frp-people'
  },
  // A built-in flow opened as its own page: the graph, and the Assistant under it.
  'automations-flow-studio': () => (openAutomations('f:built-in:research-then-implement'), '.flow-studio .ui-graph__node'),
  // The same with a step selected: the inspector beside the graph, and its block in the TOML tab.
  'automations-flow-studio-step': async () => {
    openAutomations('f:built-in:research-then-implement')
    const step = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>('.flow-studio .ui-graph__node')].find((n) => n.querySelector('.ui-graph__title')?.textContent === 'checks') ?? null)
    if (!step) return null
    step.click()
    const toml = await waitFor(() => [...document.querySelectorAll<HTMLElement>('.flow-studio [role="tab"]')].find((tab) => tab.textContent?.includes('TOML')) ?? null)
    toml?.click()
    return '.flow-studio-inspector'
  },
  // New flow: what it is called and where it starts (blank, described, or a copy of a flow).
  'automations-flow-new': async () => {
    openAutomations()
    const button = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>('.automations-view button')].find((b) => b.textContent?.includes('New flow')) ?? null)
    if (!button) return null
    button.click()
    const name = await waitFor(() => document.querySelector<HTMLInputElement>('.new-flow-form input'))
    if (!name) return null
    typeInto(name, 'Plan, build, check')
    return '.new-flow-form'
  },
  // A personal draft with a step being renamed in the inspector: the other places in the flow that follow it.
  'automations-flow-rename': async () => {
    openFlowDraft({ toml: FLOW_STARTERS.find((s) => s.id === 'research-then-implement')!.toml })
    const step = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>('.flow-studio .ui-graph__node')].find((n) => n.querySelector('.ui-graph__title')?.textContent === 'fix') ?? null)
    if (!step) return null
    step.click()
    const name = await waitFor(() => document.querySelector<HTMLInputElement>('.flow-studio-step-name input'))
    if (!name) return null
    typeInto(name, 'repair')
    return '.flow-studio-rename-places'
  },
  // A completed run's Flow tab (Run lens), and the same workspace's Lineage tab (Run lens).
  'workspace-flow': (f) => flowTab(f, 'flow'),
  'workspace-lineage': (f) => flowTab(f, 'lineage'),
  // The same run in the workspace's middle (its full screen), the chat in the side panel's Chat tab (O3).
  'workspace-flow-full': (f) => {
    selectWorkspace(f.flowWorkspaceId)
    selectSession(f.flowWorkspaceId, f.flowChatId)
    setWorkspaceFocus(f.flowWorkspaceId, 'flow')
    return '.focus-view .flow-run .ui-graph .ui-graph__node'
  },
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

/** #130: Settings → Agents → Claude Code, scrolled to its Accounts section. */
async function claudeAccounts(): Promise<string | null> {
  openSettingsPage({ section: 'agents', agent: 'claude' })
  const row = await waitFor(() => document.getElementById(rowDomId('agent-accounts-claude')))
  if (!row) return null
  row.closest('section')?.scrollIntoView({ block: 'start' })
  // Each account's own status check has answered (it runs that account's sign-in check).
  await waitFor(() => document.querySelectorAll('.ag-account-facts .ui-status').length >= 2, 20_000)
  return '.ag-account-actions'
}

/** The composer's model picker, open. */
async function openPicker(): Promise<boolean> {
  const trigger = await waitFor(element('.picker-trigger'))
  if (!trigger) return false
  trigger.click()
  return Boolean(await waitFor(element('.picker-panel .picker-controls')))
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
      await flowsSetting(FLOW_SCREENS.includes(screen))
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

/** Types into a React-controlled input as a person would: its value set natively, then the input event React listens for. */
function typeInto(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
