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
  openCreateOrganization,
  openEmployees,
  openFlowDraft,
  openMemory,
  openNewWorkspace,
  openOverlay,
  openPhoneSetup,
  openSettingsPage,
  selectSession,
  selectWorkspace,
  setSidebarMode,
  setSpace,
  setWorkspaceFocus,
  showBottomPanel,
  showChecksPanel,
  showEditorSidebar,
  showRepoHome,
  toggleLeftPanel,
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
  // Acme, its employees and a run's workspace (main/screensOrganization.ts).
  organization: { orgId: string; employeeId: string; draftEmployeeId: string; employeeWorkspaceId: string; employeeChatId: string }
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
  if (s.sidebarMode !== 'work') setSidebarMode('work')
  // The list of things to make (New's ▾) is an overlay: it stays open across screens unless closed.
  if (s.overlay) openOverlay(null)
  if (!s.rightPanelOpen) toggleRightPanel()
  showBottomPanel(false)
  // The space shown is kept across restarts: each screen starts in Personal, and the organization's screens move to Acme.
  if (s.space !== null) setSpace(null, { home: false })
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
  // The sidebar on Inbox: what needs you in Personal, with what waits in the other spaces under it (baseLayout puts it back on Work).
  'sidebar-inbox': () => {
    showRepoHome(null)
    setSidebarMode('inbox')
    return '.sidebar-inbox .ws-row'
  },
  'workspace-chat': (f) => (openWorkspace(f), '.chat .user-msg'),
  // The composer's context trigger ("15K left"), pressed: what fills the chat's context window.
  'context-usage': async (f) => {
    openWorkspace(f)
    const ring = await waitFor(element('.composer-toolbar .context-trigger'))
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
    // No terminal is open until one is asked for: + opens one in the default shell.
    const plus = await waitFor(element('.bottom-head .new-menu > .ui-btn'))
    if (!plus) return null
    plus.click()
    const screen = await waitFor(element('.terminal .xterm-screen'))
    // The shell's prompt.
    if (screen) await sleep(1500)
    return '.terminal .xterm-screen'
  },
  // The arrow beside +, open: the shells found (Windows), the default marked, then the saved commands.
  'terminal-new-menu': async (f) => {
    const shown = await SCREENS.terminal(f)
    if (!shown) return null
    const arrow = await waitFor(element('.bottom-head .new-menu .ui-split__menu > .ui-btn'))
    if (!arrow) return null
    arrow.click()
    const item = await waitFor(element('.ui-menu [role="menuitem"]'))
    // The shells are looked up as it opens.
    if (item) await sleep(800)
    return '.ui-menu'
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
  // Write a full prompt's questions (main answers writePrompt with three for the run): the message folded to a line,
  // the questions in their own scrolling box, Write prompt and Skip questions under it.
  'new-workspace-questions': async (f) => {
    showRepoHome(null)
    openNewWorkspace(f.repoId)
    const message = await waitFor(() => document.querySelector<HTMLTextAreaElement>('.nw-composer textarea'))
    if (!message) return null
    typeInto(message, 'Fix the login window. It logs me out randomly.')
    const write = await waitFor(() => document.querySelector<HTMLButtonElement>('.nw-write:not(:disabled)'))
    if (!write) return null
    write.click()
    return '.nw-write-question'
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
  // Add to Foreman, the rail's +: a repository (and the space it joins) beside an organization.
  'add-dialog': () => {
    showRepoHome(null)
    openAddRepoDialog('add')
    return '.add-dialog'
  },
  // The folder-plus beside New workspace, in Personal and Work: the menu of the ways to add a repository.
  'add-menu': async () => {
    setSpace(null, { home: false })
    setSidebarMode('work')
    const trigger = await waitFor(element('.sidebar-add-repo'))
    if (!trigger) return null
    trigger.click()
    await waitFor(element('.ui-menu [role="menuitem"]'))
    return '.ui-menu'
  },
  // Settings › Quick: what Settings opens on.
  'settings-quick': () => (openSettingsPage({ section: 'quick' }), '.settings-view .qt-grid'),
  // Choosing tiles: move and remove on each, Add a tile, and the line where the gear's popover stops.
  'settings-quick-choose': async () => {
    openSettingsPage({ section: 'quick' })
    const choose = await waitFor(element('.settings-view .qt-bar button'))
    if (!choose) return null
    choose.click()
    return '.settings-view .qt-cut'
  },
  // The rail's gear: the first Quick tiles in a popover over Home.
  'quick-popover': async () => {
    openSettingsPage(null)
    showRepoHome(null)
    const gear = await waitFor(element('[data-tour="settings"]'))
    if (!gear) return null
    gear.click()
    return '.qt-pop .qt-grid'
  },
  'settings-general': () => (openSettingsPage({ section: 'general' }), '.settings-view'),
  'settings-agents': () => (openSettingsPage({ section: 'agents' }), '.settings-view'),
  // #130: Claude Code's Accounts page.
  'settings-agent-accounts': () => claudeAccounts(),
  // The Work account's dialog: its details, then its sign-in.
  'agent-account-dialog': async () => {
    if (!(await claudeAccounts())) return null
    // An account that isn't signed in carries Sign in, which opens its dialog at the sign-in.
    const fix = await waitFor(element('.ag-account-fix'))
    if (!fix) return null
    fix.click()
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
  // Devices → Computers: hand-offs, control from other computers, pairing.
  'settings-devices': async () => {
    openSettingsPage({ section: 'devices', part: 'computers' })
    const row = await waitFor(() => document.getElementById(rowDomId('accept-hand-offs')))
    if (!row) return null
    row.scrollIntoView({ block: 'start' })
    return '.settings-view'
  },
  'settings-langfuse': async () => {
    openSettingsPage({ section: 'data', part: 'langfuse' })
    // The section draws once its status has come back.
    return (await waitFor(() => document.getElementById(rowDomId('langfuse-export')))) ? '.settings-view' : null
  },
  automations: () => (openAutomations(), '.automations-view'),
  // A built-in template open as its own page.
  'automations-template': () => (openAutomations('t:default-fix-bug'), '.automations-view .auto-page'),
  // Flows on: "I want to…", and the flows that do the job of the flow run last, each drawn, then their latest runs.
  'automations-flows': async () => {
    openAutomations()
    if (!(await waitFor(() => document.querySelectorAll('.automations-view .flow-job-card').length >= 2))) return null
    return '.automations-view .flow-job-picture .ui-graph__node'
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
  // AI employees (docs/ai-employees.md §10), in the fixture's organization: the Team page with Max's push and Ada's
  // proposal waiting in Needs you, Max's page, Lin's approval plan, New employee, the Memory view and Max's run's workspace.
  team: async (f) => {
    setSpace(f.organization.orgId)
    openEmployees({ orgId: f.organization.orgId, page: 'team' })
    // Done once the held push is drawn, the last part to arrive.
    return (await waitFor(() => document.querySelector('.team-page')?.textContent?.includes('max/launch-2.4'))) ? '.team-page' : null
  },
  // Every channel of the organization on one page, its archived one too (docs/ai-employees.md §15).
  channels: async (f) => {
    setSpace(f.organization.orgId)
    openEmployees({ orgId: f.organization.orgId, page: 'channels' })
    return (await waitFor(() => document.querySelector('.channels-list')?.textContent?.includes('#onboarding-emails'))) ? '.channels-page' : null
  },
  // The sidebar on Channels, its New making a project, and New's ▾ open: the list of everything to make, the project first.
  'new-list': async (f) => {
    setSpace(f.organization.orgId)
    setSidebarMode('channels')
    openEmployees({ orgId: f.organization.orgId, page: 'channels' })
    openOverlay('new')
    return '.overlay [role="option"]'
  },
  // A project under way: the program manager's questions and your answers, then the plan drawn as a workflow.
  project: async (f) => {
    setSpace(f.organization.orgId)
    openEmployees({ orgId: f.organization.orgId, page: 'project', id: 'proj-sso' })
    return (await waitFor(() => Boolean(document.querySelector('.channel-page .channel-workflow .ui-graph__node')))) ? '.channel-page' : null
  },
  // The same project scrolled to its plan: the workflow, the order, and what she understood.
  'project-plan': async (f) => {
    setSpace(f.organization.orgId)
    openEmployees({ orgId: f.organization.orgId, page: 'project', id: 'proj-sso' })
    if (!(await waitFor(() => Boolean(document.querySelector('.channel-page .channel-workflow .ui-graph__node'))))) return null
    document.querySelector('.channel-page .channel-plan[aria-label="Plan v1"]')?.scrollIntoView({ block: 'start' })
    return '.channel-page'
  },
  // The same project with the parts beside the channel drawn as a map (components/employees/PlanMap.tsx).
  'project-parts': async (f) => {
    localStorage.setItem('foreman.projects.partsView', 'map')
    setSpace(f.organization.orgId)
    openEmployees({ orgId: f.organization.orgId, page: 'project', id: 'proj-sso' })
    return (await waitFor(() => Boolean(document.querySelector('.channel-side .plan-map .ui-graph__node')))) ? '.channel-page' : null
  },
  employee: (f) => {
    setSpace(f.organization.orgId)
    openEmployees({ orgId: f.organization.orgId, page: 'employee', id: f.organization.employeeId })
    return '.employee-page .employee-name'
  },
  'employee-approve': async (f) => {
    setSpace(f.organization.orgId)
    openEmployees({ orgId: f.organization.orgId, page: 'employee', id: f.organization.draftEmployeeId })
    // A draft's page is its plan (docs/ai-employees.md §5.3): what it may do once approved, Approve <name> in its header.
    return (await waitFor(() => document.querySelector('.employee-page .employee-review'))) ? '.employee-page' : null
  },
  'new-employee': (f) => {
    setSpace(f.organization.orgId)
    openEmployees({ orgId: f.organization.orgId, page: 'new' })
    return '.new-employee'
  },
  memory: (f) => {
    setSpace(f.organization.orgId)
    openMemory(f.organization.orgId)
    // The file tree's first entry, not the header: the header is there while the tree still says Loading….
    return '.memory-view .files-tree .file-node'
  },
  'employee-workspace': (f) => {
    setSpace(f.organization.orgId, { home: false })
    selectWorkspace(f.organization.employeeWorkspaceId)
    selectSession(f.organization.employeeWorkspaceId, f.organization.employeeChatId)
    return '.employee-run-banner'
  },
  // New organization from Personal's Home, a name typed: one line says what its memory repository will be.
  'new-organization': async () => {
    showRepoHome(null)
    openCreateOrganization(true)
    const name = await waitFor(() => document.querySelector<HTMLInputElement>('.space-dialog-body input[type="text"]'))
    if (!name) return null
    typeInto(name, 'Northwind')
    return '.space-dialog-body'
  },
  // The same, its repositories kept in a folder of their own: the folder field, and the memory line naming it.
  'new-organization-folder': async () => {
    showRepoHome(null)
    openCreateOrganization(true)
    const name = await waitFor(() => document.querySelector<HTMLInputElement>('.space-dialog-body input[type="text"]'))
    if (!name) return null
    typeInto(name, 'Northwind')
    document.querySelector<HTMLInputElement>('.space-together input[type="checkbox"]')?.click()
    return '.space-together-extra'
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

/** #130: Settings → Agents → Claude Code → Accounts. */
async function claudeAccounts(): Promise<string | null> {
  openSettingsPage({ section: 'agents', agent: 'claude', part: 'accounts' })
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
function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
