// A stand-in for the renderer's store module, for jsdom tests of whole components (composer, settings pages).
// The real store talks to the main process through window.foreman, which a test has no use for. Use it with
//   vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
// then set what a component reads on `fakeState` and watch the calls on `fakeApi`.
import { vi } from 'vitest'

export const fakeApi: Record<string, ReturnType<typeof vi.fn>> = {}

/** The store's state as a component selects from it. Replace fields per test. */
export const fakeState: Record<string, any> = {
  snapshot: {
    platform: 'win32',
    settings: {
      language: undefined,
      followUpMode: 'queue',
      messageSendKey: 'enter',
      autoConvertLongText: true,
      promptTemplates: [],
      loadouts: [],
      requireToolApprovals: false,
      alwaysShowContextUsage: false,
      hiddenModels: {},
      opencodeModels: [],
      agentPrefs: {},
      cloud: {}
    },
    repoTemplates: {},
    comments: [],
    workspaces: [],
    sessions: [],
    catalog: { agents: {} },
    agentKeys: {},
    integrations: { connections: [] }
  },
  chats: {},
  composerFill: null,
  rightPanelOpen: false
}

export function resetFake(): void {
  for (const key of Object.keys(fakeApi)) delete fakeApi[key]
}

// Any api method a test did not define is a no-op that resolves to undefined.
const api = new Proxy(fakeApi, {
  get: (target, name: string) => (target[name] ??= vi.fn(async () => undefined))
})

const known: Record<string, unknown> = {
  api,
  bridge: { pathForFile: () => '', onEvent: () => () => undefined },
  getState: () => fakeState,
  useStore: (selector: (s: typeof fakeState) => unknown) => selector(fakeState),
  // The window is on screen unless a test says otherwise.
  useWindowVisible: () => fakeState.windowVisible !== false,
  attempt: async (fn: () => unknown) => fn(),
  modKey: () => 'Ctrl',
  availableAgents: () => ({ claude: true, codex: true, cursor: true, opencode: true }),
  onUiCommand: () => () => undefined,
  takeComposerFill: () => null,
  showToast: vi.fn(),
  showError: vi.fn()
}

// Every other export (openSettingsPage, newChat, …) is a spy.
export const storeModule: Record<string, unknown> = new Proxy(known, {
  get: (target, name: string) => {
    if (name === '__esModule') return true
    if (name === 'then') return undefined
    return (target[name] ??= vi.fn())
  },
  has: () => true
})
