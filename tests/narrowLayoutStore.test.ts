// @vitest-environment jsdom
// A narrow window, or 200% zoom (narrowLayout.ts): the steps it takes and where they start, and what ⌘B and ⌘⌥B do there.
// Under 1060 px the workspace list folds to its rail and ⌘B brings it back beside the rail (and folds it again) without
// hiding the rail; with the side panel a sheet, ⌘⌥B opens and closes the sheet and the terminal moves under the chat.
// Above it, nothing changes.
import './domShims'

// The bridge to the main process, in place before the store module reads `window.foreman`.
const bridge = vi.hoisted(() => {
  const invoke: Record<string, ReturnType<typeof vi.fn>> = {}
  ;(window as unknown as { foreman: unknown }).foreman = {
    invoke: new Proxy(invoke, { get: (target, name: string) => (target[name] ??= vi.fn(async () => undefined)) }),
    onEvent: () => () => undefined,
    send: { setUnread: vi.fn() },
    browser: { command: vi.fn(async () => undefined) }
  }
  return { invoke }
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchShortcut, platformOf } from '../src/renderer/src/shortcuts'
import { getState, initStore, openPanelSheet, setPanelSheet, showBottomPanel, toggleLeftPanel, toggleRightPanel } from '../src/renderer/src/store'
import { LIST_FOLDS_BELOW, listFolds, PANEL_SHEET_BELOW, sidebarShows } from '../src/renderer/src/narrowLayout'

const width = (px: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, value: px })

/** The store on a snapshot with this window layout and terminal placement. */
async function load(windowLayout = 'panes', terminalPlacement = 'panel-bottom') {
  bridge.invoke.getSnapshot = vi.fn(async () => ({ platform: 'win32', settings: { windowLayout, terminalPlacement, agentPrefs: {}, loadouts: [] }, repos: [], workspaces: [], sessions: [], catalog: { agents: {} }, agentKeys: {} }))
  bridge.invoke.pendingApprovals = vi.fn(async () => [])
  await initStore()
}

// Back to: the list shown, not asked for beside the rail, the panel beside the chat and open, the terminal closed.
afterEach(() => {
  setPanelSheet(false)
  width(1320)
  if (getState().narrowList) {
    width(900)
    toggleLeftPanel()
    width(1320)
  }
  if (!getState().leftPanelOpen) toggleLeftPanel()
  if (!getState().rightPanelOpen) toggleRightPanel()
  showBottomPanel(false)
  width(1024)
})

describe('where each step starts', () => {
  it('folds the list under the sidebar, the chat and the side panel at their narrowest, and never in the Editor layout', () => {
    // The sidebar's default width (its 64 px rail and a list of about 295 px), the chat and the side panel.
    expect(LIST_FOLDS_BELOW).toBe(360 + 420 + 280)
    expect(PANEL_SHEET_BELOW).toBe(420 + 280)
    expect(listFolds(1059, 'panes')).toBe(true)
    expect(listFolds(1060, 'panes')).toBe(false)
    expect(listFolds(1320, 'tiles')).toBe(false)
    expect(listFolds(660, 'editor')).toBe(false)
  })

  it('shows the rail alone in a narrow window until the list is asked for; hidden is hidden at any width', () => {
    const at = (windowWidth: number, leftPanelOpen = true, narrowList = false) => sidebarShows({ windowWidth, windowLayout: 'panes', leftPanelOpen, narrowList })
    expect(at(1320)).toBe('list')
    expect(at(1060)).toBe('list')
    expect(at(1050)).toBe('rail')
    expect(at(660)).toBe('rail')
    expect(at(660, true, true)).toBe('list')
    expect(at(660, false)).toBe('none')
    expect(at(1320, false)).toBe('none')
  })
})

describe('⌘B in a narrow window', () => {
  it('shows the list beside the rail and folds it again, never hiding the rail; a wide window hides the sidebar as before', async () => {
    await load()
    width(900)
    // Ctrl+B, through the shortcut registry, as App dispatches it.
    const press = () =>
      dispatchShortcut(
        { key: 'b', code: 'KeyB', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, preventDefault: () => undefined, stopPropagation: () => undefined } as never,
        { state: getState(), snapshot: getState().snapshot!, platform: platformOf('win32'), actions: { toggleLeftPanel } } as never,
        false
      )
    expect(getState()).toMatchObject({ leftPanelOpen: true, narrowList: false })
    expect(press()).toBe(true)
    expect(getState()).toMatchObject({ leftPanelOpen: true, narrowList: true })
    press()
    expect(getState()).toMatchObject({ leftPanelOpen: true, narrowList: false })
    width(1320)
    press()
    expect(getState()).toMatchObject({ leftPanelOpen: false, narrowList: false })
  })

  it('in the Editor layout hides the list as it always did', async () => {
    await load('editor')
    width(660)
    toggleLeftPanel()
    expect(getState()).toMatchObject({ leftPanelOpen: false, narrowList: false })
  })
})

describe('the side panel as a sheet', () => {
  it('⌘⌥B opens and closes the sheet, and leaves the docked panel’s setting alone', async () => {
    await load()
    expect(getState().rightPanelOpen).toBe(true)
    setPanelSheet(true)
    toggleRightPanel()
    expect(getState()).toMatchObject({ panelSheetOpen: true, rightPanelOpen: true })
    toggleRightPanel()
    expect(getState()).toMatchObject({ panelSheetOpen: false, rightPanelOpen: true })
  })

  it('closes when the panel goes back beside the chat, and ⌘⌥B toggles the docked panel again', async () => {
    await load()
    setPanelSheet(true)
    openPanelSheet(true)
    setPanelSheet(false)
    expect(getState()).toMatchObject({ panelSheet: false, panelSheetOpen: false })
    toggleRightPanel()
    expect(getState().rightPanelOpen).toBe(false)
  })

  it('a terminal that lives in the side panel opens under the chat instead, without opening the panel', async () => {
    await load('panes', 'panel-bottom')
    toggleRightPanel()
    expect(getState().rightPanelOpen).toBe(false)
    setPanelSheet(true)
    showBottomPanel(true)
    expect(getState()).toMatchObject({ bottomPanelOpen: true, rightPanelOpen: false })
  })
})
