// OpenCode through its own server (`opencode serve`) and @opencode-ai/sdk: sessions it keeps itself, which Foreman
// continues, forks and rewinds; its plan agent, questions, subagents, compaction and permission rules (docs/agents.md,
// "OpenCode"). Each turn starts a server of its own (server.ts, turn.ts).
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type { EffortLevel, ModelInfo } from '../../../shared/agents'
import type { AgentStatus } from '../../../shared/types'
import { launchProblem } from '../../../shared/launchProblem'
import { runProgram } from '../catalogDetect'
import type { AgentDriver, OneShotOptions } from '../types'
import { opencodeBinary, serveArgs, spawnOpencodeServer, type OpencodeLauncher, type OpencodeServer } from './server'
import { INSTALL_HINT, LABEL, OpencodeTurn } from './turn'

export { opencodeBinary } from './server'

const LIST_TIMEOUT_MS = 20_000
const EFFORTS: readonly EffortLevel[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`${LABEL} did not ${what} in time`)), ms).unref?.())])
}

/** Starts a server outside any turn (to list models or commands), runs `use` on it and closes it. */
async function withServer<T>(options: OneShotOptions, launch: OpencodeLauncher, what: string, use: (client: ReturnType<typeof createOpencodeClient>) => Promise<T>): Promise<T> {
  let server: OpencodeServer | undefined
  try {
    return await within(
      (async () => {
        server = await launch({ file: opencodeBinary(options.executablePath), args: serveArgs(), cwd: options.cwd, env: options.env })
        return await use(createOpencodeClient({ baseUrl: server.baseUrl, fetch: server.fetch, directory: options.cwd }))
      })(),
      LIST_TIMEOUT_MS,
      what
    )
  } finally {
    await server?.close()
  }
}

/** The models OpenCode can use with the providers it is connected to, as `provider/model`, with their effort variants. */
export async function listOpencodeModels(options: OneShotOptions, launch: OpencodeLauncher = spawnOpencodeServer): Promise<ModelInfo[]> {
  return withServer(options, launch, 'list its models', async (client) => {
    const res = await client.config.providers({})
    if (!res.data) throw new Error(`${LABEL} didn't list its models`)
    const { providers, default: defaults } = res.data
    return providers.flatMap((provider) =>
      Object.values(provider.models).map(
        (model): ModelInfo => ({
          id: `${provider.id}/${model.id}`,
          agent: 'opencode',
          label: model.name || model.id,
          efforts: EFFORTS.filter((e) => model.variants && e in model.variants),
          supportsFast: false,
          contextWindow: model.limit.context || 200_000,
          ...(model.limit.context ? { contextReported: true } : {}),
          ...(defaults[provider.id] === model.id ? { isDefault: true } : {}),
          ...(model.status === 'deprecated' ? { hidden: true } : {})
        })
      )
    )
  })
}

/** The driver, with the server it starts replaceable (tests). */
export function createOpencodeDriver(launch?: OpencodeLauncher): AgentDriver {
  return {
    kind: 'opencode',

    createTurn: (request, callbacks) => new OpencodeTurn(request, callbacks, { launch }),

    async listModels(options) {
      return { models: await listOpencodeModels(options, launch) }
    },

    /** OpenCode's own commands (`/init`, `/review`, the user's and the project's), for the composer's list. */
    async slashCommands(cwd, env) {
      const options = { cwd, env: { ...(process.env as Record<string, string>), ...env } }
      return withServer(options, launch ?? spawnOpencodeServer, 'list its commands', async (client) => {
        const res = await client.command.list({})
        return (res.data ?? []).map((c) => ({ name: c.name, description: c.description ?? '' }))
      })
    },

    async status(env, executablePath): Promise<AgentStatus> {
      try {
        const out = (await runProgram(opencodeBinary(executablePath), ['--version'], env)).trim()
        const version = /\d+(\.\d+)+[\w.+-]*/.exec(out)?.[0] ?? (out.split(/\s+/).pop() || undefined)
        return { agent: 'opencode', installed: true, ready: true, version }
      } catch {
        return { agent: 'opencode', installed: false, ready: false, detail: launchProblem('opencode', { name: LABEL, notInstalled: true, installHint: INSTALL_HINT }).text }
      }
    },

    // In a cloud sandbox OpenCode reads whichever provider key its model needs: every provider key goes in, under what the user set.
    cloudEnv: ({ env, secrets }) => ({ ...secrets.providerKeys(), ...env })
  }
}

export const opencodeDriver: AgentDriver = createOpencodeDriver()
