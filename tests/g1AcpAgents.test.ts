// G1: ACP launch details (Droid's --settings overlay, Pi's separate ACP program, Antigravity's `agy acp` and its
// Gemini API key, Grok Build's `grok agent stdio` and its sign-in, Hermes Agent's `hermes acp`) and ACP session modes
// (an agent's declared plan mode drives the Plan chip). Every agent here is a fake: no real Droid, pi-acp, agy, grok or hermes ran, so these prove Foreman's side only.
import * as acp from '@agentclientprotocol/sdk/unstable'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCapabilities } from '../src/shared/agentCapabilities'
import { acpPlanMode, capsOf, catalogAgent, staticCapabilities } from '../src/shared/agentCatalog'
import { planControl } from '../src/shared/switchAgent'
import { createAcpDriver, listAcpSession, sessionModes, type AcpConnector } from '../src/main/agents/acp'
import {
  acpCommand,
  acpConfigFor,
  agyUsesApiKey,
  droidLaunch,
  droidSettings,
  expectedAgentNote,
  grokAuthMethod,
  piEnv,
  type LaunchEnv
} from '../src/main/agents/acp/catalogDrivers'
import { detectAgent, findAcpProgram } from '../src/main/agents/catalogDetect'
import type { TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import type { ChatItem } from '../src/shared/types'
import { tempDir } from './helpers'

const posix = (files: string[], dirs = '/usr/bin:/opt/bin'): LaunchEnv => ({ path: dirs, platform: 'darwin', exists: (f) => files.includes(f) })

function request(cwd: string, over: Partial<TurnRequest> = {}): TurnRequest {
  return { turnId: 't1', prompt: 'hello', cwd, env: {}, model: '', fastMode: false, planMode: false, approvals: 'ask', systemPromptAppend: '', ...over }
}

function recorder() {
  const items: ChatItem[] = []
  const results: unknown[] = []
  const plan: boolean[] = []
  const cb: TurnCallbacks = {
    item: (item, transient) => void (!transient && items.push(item)),
    sessionStarted: () => {},
    assistantMessage: () => {},
    approveTool: async () => ({ kind: 'tool', allow: true }),
    reviewPlan: async () => ({ kind: 'plan', approve: true }),
    ask: async () => ({ kind: 'question', skipped: true }),
    planModeChanged: (on) => void plan.push(on),
    autoAcceptEdits: () => {},
    usage: () => {},
    finished: (r) => void results.push(r)
  }
  const notices = () => items.filter((i): i is Extract<ChatItem, { kind: 'notice' }> => i.kind === 'notice').map((i) => i.text)
  return { cb, items, results, plan, notices }
}

function inProcess(make: () => acp.AgentApp, spawned?: { command: { file: string; args: string[]; env: Record<string, string> }[] }): AcpConnector {
  return (launch) => {
    spawned?.command.push({ file: launch.file, args: launch.args, env: launch.env })
    const toAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>()
    const toClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>()
    const conn = make().connect({ readable: toAgent.readable, writable: toClient.writable })
    return { stream: { readable: toClient.readable, writable: toAgent.writable }, failure: () => ({ stderr: '' }), close: async () => conn.close() }
  }
}

interface FakeLog {
  methods: string[]
  modes: string[]
  prompts: acp.ContentBlock[][]
}

/** A fake ACP agent with session modes (legacy `modes`, or a "mode" config option), that can switch mode on its own. */
function modalAgent(log: FakeLog, opts: { configOption?: boolean; modes?: { id: string; name: string }[]; leavePlanOnPrompt?: boolean; refuseMode?: boolean; info?: { name: string; version: string } } = {}) {
  const modes = opts.modes ?? [
    { id: 'build', name: 'Build' },
    { id: 'plan', name: 'Plan' }
  ]
  let current = modes[0].id
  const state = () =>
    opts.configOption
      ? { configOptions: [{ type: 'select' as const, id: 'mode', name: 'Mode', category: 'mode', currentValue: current, options: modes.map((m) => ({ value: m.id, name: m.name })) }] }
      : { modes: { currentModeId: current, availableModes: modes } }
  return () =>
    acp
      .agent({ name: 'fake-modal' })
      .onRequest(acp.methods.agent.initialize, () => {
        log.methods.push('initialize')
        return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, ...(opts.info ? { agentInfo: opts.info } : {}) }
      })
      .onRequest(acp.methods.agent.session.new, () => {
        log.methods.push('session/new')
        return { sessionId: 's1', ...state() }
      })
      .onRequest(acp.methods.agent.session.setMode, ({ params }) => {
        log.methods.push(`set_mode:${params.modeId}`)
        if (opts.refuseMode) throw acp.RequestError.invalidParams({}, 'no')
        current = params.modeId
        log.modes.push(current)
        return {}
      })
      .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
        log.methods.push(`set_config:${params.configId}=${String(params.value)}`)
        current = String(params.value)
        log.modes.push(current)
        return state() as never
      })
      .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
        log.prompts.push(params.prompt)
        if (opts.leavePlanOnPrompt) {
          current = 'build'
          await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'build' } })
        }
        await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `in ${current}` } } })
        return { stopReason: 'end_turn' }
      })
}

const newLog = (): FakeLog => ({ methods: [], modes: [], prompts: [] })

describe('G1 · Droid’s --settings overlay', () => {
  it('maps the model and Foreman’s approval setting, and leaves Droid alone when neither applies', () => {
    expect(droidSettings('', 'ask')).toBeNull()
    expect(droidSettings('claude-x', 'ask')).toEqual({ model: 'claude-x' })
    expect(droidSettings('', 'ask-except-edits')).toEqual({ sessionDefaultSettings: { autonomyLevel: 'low' } })
    expect(droidSettings(' gpt ', 'never-ask')).toEqual({ sessionDefaultSettings: { autonomyLevel: 'high' }, model: 'gpt' })
  })

  it('writes the overlay in Foreman’s own folder, passes it before `exec`, and removes it after the turn', async () => {
    const runtime = await tempDir('foreman-g1-runtime-')
    const cwd = await tempDir('foreman-g1-droid-cwd-')
    const spawned = { command: [] as { file: string; args: string[]; env: Record<string, string> }[] }
    const log = newLog()
    const config = acpConfigFor(catalogAgent('droid')!, { connect: inProcess(modalAgent(log), spawned), launchEnv: posix(['/opt/bin/droid']), runtimeDir: runtime })
    const rec = recorder()
    await createAcpDriver(config).createTurn(request(cwd, { model: 'glm-5', approvals: 'auto', turnId: 'turn/1' }), rec.cb).run()
    const args = spawned.command[0].args
    expect(spawned.command[0].file).toBe('/opt/bin/droid')
    expect(args.slice(0, 1)).toEqual(['--settings'])
    expect(args.slice(2)).toEqual(['exec', '--output-format', 'acp-daemon'])
    const file = args[1]
    expect(file.startsWith(path.join(runtime, 'droid'))).toBe(true)
    expect(path.basename(file)).toBe('foreman-droid-turn-1-settings.json')
    expect(file.startsWith(cwd)).toBe(false)
    expect(existsSync(file)).toBe(false)
    expect(rec.results).toEqual([{ ok: true }])
  })

  it('writes nothing for model listing or a turn with nothing to override', async () => {
    const runtime = await tempDir('foreman-g1-runtime-')
    expect(droidLaunch(undefined, runtime)).toEqual({ prefix: [] })
    expect(droidLaunch({ turnId: 't', cwd: '/w', model: '', approvals: 'ask', env: {} }, runtime)).toEqual({ prefix: [] })
    const made = droidLaunch({ turnId: 't', cwd: '/w', model: 'm', approvals: 'ask', env: {} }, runtime)
    expect(JSON.parse(await readFile(made.prefix[1], 'utf8'))).toEqual({ model: 'm' })
    made.cleanup!()
    expect(existsSync(made.prefix[1])).toBe(false)
  })
})

describe('G1 · separate ACP programs (Pi)', () => {
  it('finds the ACP program beside the agent’s own CLI before PATH', () => {
    const pi = catalogAgent('pi')!
    const files = ['/apps/pi/pi', '/apps/pi/pi-acp', '/opt/bin/pi-acp', '/opt/bin/pi']
    expect(acpCommand(pi, '/apps/pi/pi', posix(files))).toEqual({ file: '/apps/pi/pi-acp', args: [] })
    // Without a configured path, beside the pi found on PATH.
    expect(acpCommand(pi, undefined, posix(['/opt/bin/pi', '/opt/bin/pi-acp', '/usr/bin/pi-acp'])).file).toBe('/opt/bin/pi-acp')
    expect(findAcpProgram(pi, null, posix(['/usr/bin/pi-acp']))).toBe('/usr/bin/pi-acp')
    // Windows: npm's .cmd shim, started through cmd.exe.
    const win: LaunchEnv = { path: 'C:\\pi', platform: 'win32', pathExt: '.EXE;.CMD', exists: (f) => f === 'C:\\pi\\pi-acp.cmd' }
    expect(acpCommand(pi, undefined, win).args).toEqual(['/d', '/c', 'C:\\pi\\pi-acp.cmd'])
  })

  it('reports a missing ACP program separately from the agent itself', async () => {
    const deps = { path: '/opt/bin', platform: 'darwin' as const, exists: (f: string) => f === '/opt/bin/pi', run: async () => 'pi 1.2.3', env: {} }
    const pi = await detectAgent(catalogAgent('pi')!, deps)
    expect(pi).toMatchObject({ installed: true, version: '1.2.3', acpProgram: { name: 'pi-acp', install: 'npm i -g @victor-software-house/pi-acp' } })
    expect(pi.acpProgram!.path).toBeUndefined()
    const found = await detectAgent(catalogAgent('pi')!, { ...deps, exists: (f) => f === '/opt/bin/pi' || f === '/opt/bin/pi-acp' })
    expect(found.acpProgram!.path).toBe('/opt/bin/pi-acp')
    // Antigravity's ACP is a mode of agy itself: nothing separate to report.
    expect((await detectAgent(catalogAgent('antigravity')!, { ...deps, exists: (f) => f === '/opt/bin/agy' })).acpProgram).toBeUndefined()
  })

  it('gives pi-acp’s daemon a socket folder per workspace, outside the repo', () => {
    const a = piEnv({ cwd: '/work/a' })!.PI_ACP_SOCKET_DIR
    expect(piEnv({ cwd: '/work/a' })!.PI_ACP_SOCKET_DIR).toBe(a)
    expect(piEnv({ cwd: '/work/b' })!.PI_ACP_SOCKET_DIR).not.toBe(a)
    expect(a.startsWith('/work')).toBe(false)
    expect(piEnv(undefined)).toBeUndefined()
  })

  it('starts pi-acp once more when it exits during its first handshake', async () => {
    const log = newLog()
    let starts = 0
    const flaky: AcpConnector = (launch) => {
      starts++
      if (starts === 1) {
        // Exits at once: the connection closes before initialize is answered.
        const toClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>()
        const toAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>()
        void toClient.writable.close()
        return { stream: { readable: toClient.readable, writable: toAgent.writable }, failure: () => ({ stderr: '' }), close: async () => undefined }
      }
      return inProcess(modalAgent(log, { info: { name: '@victor-software-house/pi-acp', version: '0.18.0' } }))(launch)
    }
    const rec = recorder()
    await createAcpDriver(acpConfigFor(catalogAgent('pi')!, { connect: flaky, launchEnv: posix(['/opt/bin/pi-acp']) })).createTurn(request(await tempDir()), rec.cb).run()
    expect(starts).toBe(2)
    expect(rec.results).toEqual([{ ok: true }])
    expect(rec.notices()).toEqual([])
  })

  it('notes an unexpected program or a version below the configured minimum, and still runs the turn', async () => {
    const pi = catalogAgent('pi')!
    expect(expectedAgentNote(pi, { name: '@victor-software-house/pi-acp', version: '0.17.1' })).toBeUndefined()
    expect(expectedAgentNote(pi, { name: '@victor-software-house/pi-acp', version: '0.16.9' })).toMatch(/older than 0\.17\.1/)
    expect(expectedAgentNote(pi, { name: 'something-else', version: '9.9.9' })).toMatch(/expected the @victor-software-house\/pi-acp program/)
    expect(expectedAgentNote(catalogAgent('qwen')!, { name: 'x', version: '0' })).toBeUndefined()
    const agy = catalogAgent('antigravity')!
    expect(expectedAgentNote(agy, { name: 'Antigravity ACP Server', version: '1.5.16' })).toBeUndefined()
    expect(expectedAgentNote(agy, { name: 'antigravity-acp', version: '1.5.16' })).toMatch(/expected the Antigravity ACP Server program/)
    const log = newLog()
    const rec = recorder()
    const config = acpConfigFor(agy, { connect: inProcess(modalAgent(log, { info: { name: 'Antigravity ACP Server', version: '1.4.9' } })), launchEnv: posix([]) })
    await createAcpDriver(config).createTurn(request(await tempDir()), rec.cb).run()
    expect(rec.notices()).toEqual([expect.stringMatching(/Antigravity ACP Server 1\.4\.9 is older than 1\.5\.0/)])
    expect(rec.results).toEqual([{ ok: true }])
  })
})

describe('G1 · Antigravity through `agy acp`', () => {
  /** A fake `agy acp` that offers its sign-in methods and logs which one Foreman selects. */
  function agyAgent(methods: string[], prompts: acp.ContentBlock[][] = []) {
    return () =>
      acp
        .agent({ name: 'agy' })
        .onRequest(acp.methods.agent.initialize, () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: {},
          authMethods: [
            { id: 'oauth-personal', name: 'Log in with Google' },
            { id: 'gemini-api-key', name: 'Use Gemini API key' }
          ]
        }))
        .onRequest(acp.methods.agent.authenticate, ({ params }) => {
          methods.push(`authenticate:${params.methodId}`)
          return {}
        })
        .onRequest(acp.methods.agent.session.new, () => {
          methods.push('session/new')
          return { sessionId: 'a' }
        })
        .onRequest(acp.methods.agent.session.prompt, ({ params }) => {
          prompts.push(params.prompt)
          return { stopReason: 'end_turn' }
        })
  }

  it('launches agy itself with `acp`: the configured path, else agy on PATH', () => {
    const agy = catalogAgent('antigravity')!
    expect(acpCommand(agy, '/apps/agy/agy', posix([]))).toEqual({ file: '/apps/agy/agy', args: ['acp'] })
    expect(acpCommand(agy, undefined, posix(['/opt/bin/agy']))).toEqual({ file: '/opt/bin/agy', args: ['acp'] })
    // An old agy_acp_server beside it isn't looked for any more, and Linux takes no extra arguments.
    expect(acpCommand(agy, undefined, posix(['/opt/bin/agy', '/opt/bin/agy_acp_server'])).file).toBe('/opt/bin/agy')
    expect(findAcpProgram(agy, '/opt/bin/agy', posix(['/opt/bin/agy', '/opt/bin/agy_acp_server']))).toBeNull()
    expect(acpCommand(agy, undefined, { ...posix(['/opt/bin/agy']), platform: 'linux' })).toEqual({ file: '/opt/bin/agy', args: ['acp'] })
    // Not found: its bare name, so the spawn fails as not installed.
    expect(acpCommand(agy, undefined, posix([]))).toEqual({ file: 'agy', args: ['acp'] })
    const win: LaunchEnv = { path: 'C:\\agy', platform: 'win32', pathExt: '.EXE;.CMD', exists: (f) => f === 'C:\\agy\\agy.exe' }
    expect(acpCommand(agy, undefined, win)).toEqual({ file: 'C:\\agy\\agy.exe', args: ['acp'] })
  })

  it('selects the Gemini API key method only with a key in the environment and the method offered', () => {
    const offered = { authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }, { id: 'gemini-api-key', name: 'Use Gemini API key' }] }
    expect(agyUsesApiKey(offered, { GEMINI_API_KEY: 'AIza-key' })).toBe(true)
    expect(agyUsesApiKey(offered, { GEMINI_API_KEY: '  ' })).toBe(false)
    expect(agyUsesApiKey(offered, { GEMINI_API_KEY: '' })).toBe(false)
    expect(agyUsesApiKey(offered, {})).toBe(false)
    // Another Google variable doesn't count.
    expect(agyUsesApiKey(offered, { GOOGLE_API_KEY: 'AIza-key' })).toBe(false)
    expect(agyUsesApiKey({ authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }] }, { GEMINI_API_KEY: 'AIza-key' })).toBe(false)
    expect(agyUsesApiKey({ authMethods: [] }, { GEMINI_API_KEY: 'AIza-key' })).toBe(false)
    expect(agyUsesApiKey({}, { GEMINI_API_KEY: 'AIza-key' })).toBe(false)
  })

  it('with a Gemini API key, selects it before the session, and sends the standing instructions as plain text', async () => {
    const methods: string[] = []
    const prompts: acp.ContentBlock[][] = []
    const spawned = { command: [] as { file: string; args: string[]; env: Record<string, string> }[] }
    const config = acpConfigFor(catalogAgent('antigravity')!, { connect: inProcess(agyAgent(methods, prompts), spawned), launchEnv: posix(['/opt/bin/agy']) })
    const rec = recorder()
    await createAcpDriver(config).createTurn(request(await tempDir(), { env: { GEMINI_API_KEY: 'AIza-key' }, systemPromptAppend: 'Be brief.' }), rec.cb).run()
    expect(spawned.command.map((c) => [c.file, c.args])).toEqual([['/opt/bin/agy', ['acp']]])
    expect(methods).toEqual(['authenticate:gemini-api-key', 'session/new'])
    expect(prompts[0][0]).toEqual({ type: 'text', text: expect.stringContaining('<foreman_standing_instructions>\nBe brief.\n</foreman_standing_instructions>') })
    expect(prompts[0][0]).not.toHaveProperty('annotations')
    expect(rec.notices()).toEqual([])
    expect(rec.results).toEqual([{ ok: true }])
  })

  it('in Login mode (no key) selects nothing: agy reuses its own saved sign-in', async () => {
    const methods: string[] = []
    const config = acpConfigFor(catalogAgent('antigravity')!, { connect: inProcess(agyAgent(methods)), launchEnv: posix(['/opt/bin/agy']) })
    const rec = recorder()
    await createAcpDriver(config).createTurn(request(await tempDir()), rec.cb).run()
    expect(methods).toEqual(['session/new'])
    expect(rec.results).toEqual([{ ok: true }])
  })
})

describe('G1 · Grok Build through `grok agent stdio`', () => {
  /** A fake `grok agent stdio` that offers xAI's two sign-in methods and logs what Foreman sends. */
  function grokAgent(methods: string[], metas: unknown[] = [], offered = ['xai.api_key', 'cached_token']) {
    return () =>
      acp
        .agent({ name: 'grok' })
        .onRequest(acp.methods.agent.initialize, () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: {},
          authMethods: offered.map((id) => ({ id, name: id }))
        }))
        .onRequest(acp.methods.agent.authenticate, ({ params }) => {
          methods.push(`authenticate:${params.methodId}`)
          metas.push(params._meta)
          return {}
        })
        .onRequest(acp.methods.agent.session.new, () => {
          methods.push('session/new')
          return { sessionId: 'g' }
        })
        .onRequest(acp.methods.agent.session.prompt, () => ({ stopReason: 'end_turn' }))
  }

  it('launches grok with `agent stdio`: the configured path, else grok on PATH, else its bare name', () => {
    const grok = catalogAgent('grok')!
    expect(grok.level).toBe('chat')
    expect(acpCommand(grok, '/apps/grok', posix([]))).toEqual({ file: '/apps/grok', args: ['agent', 'stdio'] })
    expect(acpCommand(grok, undefined, posix(['/opt/bin/grok']))).toEqual({ file: '/opt/bin/grok', args: ['agent', 'stdio'] })
    expect(acpCommand(grok, undefined, posix([]))).toEqual({ file: 'grok', args: ['agent', 'stdio'] })
    const win: LaunchEnv = { path: 'C:\\grok', platform: 'win32', pathExt: '.EXE;.CMD', exists: (f) => f === 'C:\\grok\\grok.exe' }
    expect(acpCommand(grok, undefined, win)).toEqual({ file: 'C:\\grok\\grok.exe', args: ['agent', 'stdio'] })
  })

  it('picks the API key method only with XAI_API_KEY set and offered, else its saved sign-in, else nothing', () => {
    const both = { authMethods: [{ id: 'xai.api_key', name: 'API key' }, { id: 'cached_token', name: 'Saved login' }] }
    expect(grokAuthMethod(both, { XAI_API_KEY: 'xai-key' })).toBe('xai.api_key')
    expect(grokAuthMethod(both, { XAI_API_KEY: '  ' })).toBe('cached_token')
    expect(grokAuthMethod(both, {})).toBe('cached_token')
    expect(grokAuthMethod({ authMethods: [{ id: 'cached_token', name: 'Saved login' }] }, { XAI_API_KEY: 'xai-key' })).toBe('cached_token')
    expect(grokAuthMethod({ authMethods: [{ id: 'xai.api_key', name: 'API key' }] }, {})).toBeUndefined()
    expect(grokAuthMethod({ authMethods: [] }, { XAI_API_KEY: 'xai-key' })).toBeUndefined()
    expect(grokAuthMethod({}, {})).toBeUndefined()
  })

  it('authenticates headless before the session: the key in API-key mode, the saved login otherwise', async () => {
    for (const [env, method] of [[{ XAI_API_KEY: 'xai-key' }, 'xai.api_key'], [{}, 'cached_token']] as const) {
      const methods: string[] = []
      const metas: unknown[] = []
      const spawned = { command: [] as { file: string; args: string[]; env: Record<string, string> }[] }
      const config = acpConfigFor(catalogAgent('grok')!, { connect: inProcess(grokAgent(methods, metas), spawned), launchEnv: posix(['/opt/bin/grok']) })
      const rec = recorder()
      await createAcpDriver(config).createTurn(request(await tempDir(), { env: { ...env } }), rec.cb).run()
      expect(spawned.command.map((c) => [c.file, c.args])).toEqual([['/opt/bin/grok', ['agent', 'stdio']]])
      expect(methods).toEqual([`authenticate:${method}`, 'session/new'])
      expect(metas).toEqual([{ headless: true }])
      expect(rec.results).toEqual([{ ok: true }])
    }
  })

  it('offering neither method skips authenticate and still runs the turn', async () => {
    const methods: string[] = []
    const config = acpConfigFor(catalogAgent('grok')!, { connect: inProcess(grokAgent(methods, [], [])), launchEnv: posix(['/opt/bin/grok']) })
    const rec = recorder()
    await createAcpDriver(config).createTurn(request(await tempDir()), rec.cb).run()
    expect(methods).toEqual(['session/new'])
    expect(rec.results).toEqual([{ ok: true }])
  })
})

describe('G1 · Hermes Agent through `hermes acp`', () => {
  it('launches hermes with `acp` and takes the provider keys ticked for it', () => {
    const hermes = catalogAgent('hermes')!
    expect(acpCommand(hermes, undefined, posix(['/opt/bin/hermes']))).toEqual({ file: '/opt/bin/hermes', args: ['acp'] })
    expect(acpCommand(hermes, undefined, posix([]))).toEqual({ file: 'hermes', args: ['acp'] })
    const win: LaunchEnv = { path: 'C:\\hermes\\bin', platform: 'win32', pathExt: '.EXE;.CMD', exists: (f) => f === 'C:\\hermes\\bin\\hermes.exe' }
    expect(acpCommand(hermes, undefined, win)).toEqual({ file: 'C:\\hermes\\bin\\hermes.exe', args: ['acp'] })
    expect(hermes.auth).toMatchObject({ login: { args: ['model'] }, sharedKeys: true, confirmed: true })
    expect(hermes.auth.apiKey).toBeUndefined()
  })

  it('declares no plan mode: its session modes are about edit approvals, so Plan stays off', () => {
    const modes = [{ id: 'default', name: 'Default' }, { id: 'accept_edits', name: 'Accept Edits' }, { id: 'dont_ask', name: "Don't Ask" }]
    expect(acpPlanMode(modes)).toBeUndefined()
    expect(capsOf(staticCapabilities('hermes')!)).toMatchObject({ plan: false, approvals: true, rewind: true, mcp: true })
  })
})

describe('G1 · ACP session modes and the Plan chip', () => {
  it('finds a declared plan mode only by its id or name', () => {
    expect(acpPlanMode([{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }])?.id).toBe('plan')
    expect(acpPlanMode([{ id: 'architect', name: 'Plan' }])?.id).toBe('architect')
    expect(acpPlanMode([{ id: 'default', name: 'Default' }, { id: 'yolo', name: 'Planless yolo' }])).toBeUndefined()
    expect(acpPlanMode(undefined)).toBeUndefined()
  })

  it('turns the Plan chip on for an ACP agent that declared a plan mode; steering stays off', () => {
    const modes = [{ id: 'plan', name: 'Plan' }]
    const declare = (id: string) => resolveCapabilities(staticCapabilities(id)!, acpPlanMode(modes) ? { planMode: true } : undefined)
    // The chips are read from the record with what the agent declared folded in.
    expect(capsOf(staticCapabilities('qwen')!)).toMatchObject({ plan: false, steer: false })
    expect(capsOf(declare('qwen'))).toMatchObject({ plan: true, steer: false })
    // OpenCode's plan agent is in its record, declared or not.
    expect(capsOf(staticCapabilities('opencode')!).plan).toBe(true)
    // Only an agent whose record says it declares a plan mode takes one from what it declared.
    expect(capsOf(declare('cursor')).plan).toBe(false)
    expect(capsOf(declare('claude')).plan).toBe(true)
    // What it declared is folded into the record the control reads; without it the chip stays, disabled, saying why.
    expect(planControl(declare('qwen'), { planMode: true })).toBe('on')
    expect(planControl(staticCapabilities('qwen'), { planMode: false })).toBe('unavailable')
  })

  it('reads modes from `modes` and from a "mode" config option', () => {
    expect(sessionModes({ modes: { currentModeId: 'a', availableModes: [{ id: 'a', name: 'A' }] } })).toMatchObject({ modes: [{ id: 'a', name: 'A' }], current: 'a' })
    const viaOption = sessionModes({ configOptions: [{ type: 'select', id: 'm', name: 'Mode', category: 'mode', currentValue: 'b', options: [{ value: 'b', name: 'B' }] }] })
    expect(viaOption).toMatchObject({ modes: [{ id: 'b', name: 'B' }], current: 'b' })
    expect(viaOption.option?.id).toBe('m')
  })

  it('switches into the declared plan mode before prompting (session/set_mode)', async () => {
    const log = newLog()
    const rec = recorder()
    await createAcpDriver({ kind: 'qwen', label: 'Qwen Code', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(log)) })
      .createTurn(request(await tempDir(), { planMode: true }), rec.cb)
      .run()
    expect(log.methods).toEqual(['initialize', 'session/new', 'set_mode:plan'])
    expect(rec.items.some((i) => i.kind === 'assistant' && i.text === 'in plan')).toBe(true)
    expect(rec.results).toEqual([{ ok: true }])
  })

  it('switches through the "mode" config option when the agent lists modes that way', async () => {
    const log = newLog()
    const rec = recorder()
    await createAcpDriver({ kind: 'qwen', label: 'Qwen Code', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(log, { configOption: true })) })
      .createTurn(request(await tempDir(), { planMode: true }), rec.cb)
      .run()
    expect(log.methods).toContain('set_config:mode=plan')
    expect(rec.results).toEqual([{ ok: true }])
  })

  it('leaves the mode alone without Plan, and the chip follows when the agent leaves plan mode itself', async () => {
    const log = newLog()
    const rec = recorder()
    await createAcpDriver({ kind: 'qwen', label: 'Qwen Code', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(log)) })
      .createTurn(request(await tempDir()), rec.cb)
      .run()
    expect(log.methods).toEqual(['initialize', 'session/new'])
    const log2 = newLog()
    const rec2 = recorder()
    await createAcpDriver({ kind: 'qwen', label: 'Qwen Code', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(log2, { leavePlanOnPrompt: true })) })
      .createTurn(request(await tempDir(), { planMode: true }), rec2.cb)
      .run()
    expect(rec2.plan).toEqual([false])
  })

  it('doesn’t start a Plan turn it can’t put in plan mode', async () => {
    const noPlan = newLog()
    const rec = recorder()
    await createAcpDriver({ kind: 'qwen', label: 'Qwen Code', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(noPlan, { modes: [{ id: 'default', name: 'Default' }] })) })
      .createTurn(request(await tempDir(), { planMode: true }), rec.cb)
      .run()
    expect(noPlan.prompts).toEqual([])
    expect(rec.results).toEqual([{ ok: false, error: expect.stringMatching(/doesn’t offer a plan mode/) }])
    const refused = newLog()
    const rec2 = recorder()
    await createAcpDriver({ kind: 'qwen', label: 'Qwen Code', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(refused, { refuseMode: true })) })
      .createTurn(request(await tempDir(), { planMode: true }), rec2.cb)
      .run()
    expect(refused.prompts).toEqual([])
    expect(rec2.results).toEqual([{ ok: false, error: expect.stringMatching(/Couldn’t switch Qwen Code to its plan mode/) }])
  })

  it('lists the declared modes with the models', async () => {
    const log = newLog()
    const listed = await listAcpSession({ kind: 'qwen', label: 'Qwen Code', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(log)) }, { cwd: await tempDir(), env: {} })
    expect(listed.modes).toEqual([
      { id: 'build', name: 'Build' },
      { id: 'plan', name: 'Plan' }
    ])
  })
})
