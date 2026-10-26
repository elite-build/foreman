import type { CliHost } from '../src/main/cliServer'
import { defaultSettings } from '../src/main/store'
import type { Api } from '../src/shared/types'

/** An Api that throws "not expected" for every method; a test passes the one or two it uses. */
export function fakeApi(overrides: Partial<Api> = {}): Api {
  return new Proxy(overrides, {
    get: (target, name) => {
      if (typeof name !== 'string' || name === 'then') return undefined
      if (name in target) return target[name as keyof Api]
      return () => {
        throw new Error(`not expected: api.${name}`)
      }
    }
  }) as Api
}

/** A CliHost that does nothing; tests override what they use. */
export function stubHost(overrides: Partial<CliHost> = {}): CliHost {
  return {
    api: fakeApi(),
    snapshot: () => {
      throw new Error('not expected: snapshot')
    },
    resolvedRepoSettings: () => {
      throw new Error('not expected: resolvedRepoSettings')
    },
    platform: process.platform,
    onEvent: () => () => undefined,
    appInfo: () => ({ version: '0.0.0-test', packaged: false, dataDir: '' }),
    cliToken: () => 'test-token',
    state: () => ({ repos: [], workspaces: [], sessions: [], settings: defaultSettings() }),
    approvals: () => [],
    turnStatus: async () => null,
    firstTurn: async () => undefined,
    deliver: async () => {
      throw new Error('not expected')
    },
    cancelTurn: async () => null,
    createWorkspace: async () => {
      throw new Error('not expected')
    },
    reveal: () => undefined,
    showSetting: () => undefined,
    setupOutcome: async () => ({ failed: false, held: false, logTail: '' }),
    startHeldMessage: async () => undefined,
    runChecks: async () => {
      throw new Error('not expected')
    },
    exportInfo: async () => {
      throw new Error('not expected')
    },
    exportWorkspace: async () => {
      throw new Error('not expected')
    },
    stageImport: async () => {
      throw new Error('not expected')
    },
    importStaged: async () => {
      throw new Error('not expected')
    },
    discardImport: async () => undefined,
    identifyCaller: () => null,
    recordReport: () => {
      throw new Error('not expected')
    },
    agentsMayStart: () => false,
    ...overrides
  }
}
