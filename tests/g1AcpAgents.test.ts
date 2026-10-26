// G1: ACP launch details (Droid's --settings overlay, Pi's and Antigravity's
// separate ACP programs) and ACP session modes (an agent's declared plan mode drives the Plan chip). Every agent here
// is a fake: no real Droid, pi-acp or agy_acp_server ran, so these prove Foreman's side only.
import * as acp from '@agentclientprotocol/sdk'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { acpPlanMode, agentControls, catalogAgent, declaresPlanMode, missingCapabilities } from '../src/shared/agentCatalog'
import { supportsPlan } from '../src/shared/agents'
import { planControl } from '../src/shared/switchAgent'
import { createAcpDriver, listAcpSession, sessionModes, type AcpConnector } from '../src/main/agents/acp'
import {
  acpCommand,
  acpConfigFor,
  agyShouldAuthenticate,
  antigravityEnv,
  droidLaunch,
  droidSettings,
  expectedAgentNote,
  piEnv,
  type LaunchEnv
} from '../src/main/agents/catalogDrivers'
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

describe('G1 · separate ACP programs (Pi, Antigravity)', () => {
  it('finds the ACP program beside the agent’s own CLI before PATH', () => {
    const agy = catalogAgent('antigravity')!
    const files = ['/apps/agy/agy', '/apps/agy/agy_acp_server', '/opt/bin/agy_acp_server', '/opt/bin/agy']
    expect(acpCommand(agy, '/apps/agy/agy', posix(files)).file).toBe('/apps/agy/agy_acp_server')
    // Without a configured path, beside the agy found on PATH.
    expect(acpCommand(agy, undefined, posix(['/opt/bin/agy', '/opt/bin/agy_acp_server', '/usr/bin/agy_acp_server'])).file).toBe('/opt/bin/agy_acp_server')
    expect(findAcpProgram(agy, null, posix(['/usr/bin/agy_acp_server']))).toBe('/usr/bin/agy_acp_server')
    // Linux needs the empty --uid flag; Windows looks for the .exe.
    expect(acpCommand(agy, undefined, { ...posix(['/opt/bin/agy_acp_server']), platform: 'linux' }).args).toEqual(['--uid='])
    const win: LaunchEnv = { path: 'C:\\agy', platform: 'win32', pathExt: '.EXE;.CMD', exists: (f) => f === 'C:\\agy\\agy_acp_server.exe' }
    expect(acpCommand(agy, undefined, win).file).toBe('C:\\agy\\agy_acp_server.exe')
  })

  it('reports a missing ACP program separately from the agent itself', async () => {
    const deps = { path: '/opt/bin', platform: 'darwin' as const, exists: (f: string) => f === '/opt/bin/pi', run: async () => 'pi 1.2.3', env: {} }
    const pi = await detectAgent(catalogAgent('pi')!, deps)
    expect(pi).toMatchObject({ installed: true, version: '1.2.3', acpProgram: { name: 'pi-acp', install: 'npm i -g @victor-software-house/pi-acp' } })
    expect(pi.acpProgram!.path).toBeUndefined()
    const found = await detectAgent(catalogAgent('pi')!, { ...deps, exists: (f) => f === '/opt/bin/pi' || f === '/opt/bin/pi-acp' })
    expect(found.acpProgram!.path).toBe('/opt/bin/pi-acp')
    expect((await detectAgent(catalogAgent('gemini')!, { ...deps, exists: (f) => f === '/opt/bin/gemini' })).acpProgram).toBeUndefined()
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
    expect(expectedAgentNote(catalogAgent('gemini')!, { name: 'x', version: '0' })).toBeUndefined()
    const log = newLog()
    const rec = recorder()
    const config = acpConfigFor(catalogAgent('antigravity')!, { connect: inProcess(modalAgent(log, { info: { name: 'antigravity-acp', version: '1.2.0' } })), launchEnv: posix([]) })
    await createAcpDriver(config).createTurn(request(await tempDir()), rec.cb).run()
    expect(rec.notices()).toEqual([expect.stringMatching(/antigravity-acp 1\.2\.0 is older than 1\.3\.0/)])
    expect(rec.results).toEqual([{ ok: true }])
  })

  it('points Antigravity’s server at its helper beside its real location, and never disables workspace trust', async () => {
    const dir = await tempDir('foreman-g1-agy-')
    const server = path.join(dir, process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server')
    const helper = path.join(dir, process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external')
    await writeFile(server, '')
    expect(antigravityEnv(server, {})).toBeUndefined()
    await writeFile(helper, '')
    expect(antigravityEnv(server, {})).toEqual({ ANTIGRAVITY_HARNESS_PATH: await realpath(helper) })
    expect(antigravityEnv(server, { ANTIGRAVITY_HARNESS_PATH: '/mine' })).toBeUndefined()
    expect(JSON.stringify(antigravityEnv(server, {}))).not.toContain('WORKSPACE_TRUST')
  })

  it('reuses an existing Google sign-in for Antigravity only when nothing else is set up', async () => {
    const home = await tempDir('foreman-g1-gemini-')
    const offered = { authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }] }
    expect(agyShouldAuthenticate(offered, home)).toBe(false)
    await writeFile(path.join(home, 'google_accounts.json'), JSON.stringify({ active: 'me@example.com' }))
    expect(agyShouldAuthenticate(offered, home)).toBe(true)
    expect(agyShouldAuthenticate({ authMethods: [] }, home)).toBe(false)
    await mkdir(path.join(home, 'antigravity-acp'))
    await writeFile(path.join(home, 'antigravity-acp', 'settings.json'), JSON.stringify({ auth: { type: 'oauth-personal' } }))
    expect(agyShouldAuthenticate(offered, home)).toBe(false)
  })

  it('calls authenticate before the session when it should, and sends the standing instructions as plain text', async () => {
    const home = await tempDir('foreman-g1-gemini-')
    await writeFile(path.join(home, 'google_accounts.json'), JSON.stringify({ active: 'me@example.com' }))
    const methods: string[] = []
    const prompts: acp.ContentBlock[][] = []
    const agent = () =>
      acp
        .agent({ name: 'agy' })
        .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [{ id: 'oauth-personal', name: 'Google' }] }))
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
    const config = acpConfigFor(catalogAgent('antigravity')!, { connect: inProcess(agent), launchEnv: posix([]), home })
    const rec = recorder()
    await createAcpDriver(config).createTurn(request(await tempDir(), { env: { GEMINI_HOME: home }, systemPromptAppend: 'Be brief.' }), rec.cb).run()
    expect(methods).toEqual(['authenticate:oauth-personal', 'session/new'])
    expect(prompts[0][0]).toEqual({ type: 'text', text: expect.stringContaining('<foreman_standing_instructions>\nBe brief.\n</foreman_standing_instructions>') })
    expect(prompts[0][0]).not.toHaveProperty('annotations')
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
    expect(declaresPlanMode('gemini', modes)).toBe(true)
    expect(declaresPlanMode('opencode', modes)).toBe(true)
    expect(declaresPlanMode('codex', modes)).toBe(false)
    expect(declaresPlanMode('aider', modes)).toBe(false)
    expect(agentControls('gemini')).toMatchObject({ plan: false, steer: false })
    expect(agentControls('gemini', modes)).toMatchObject({ plan: true, steer: false })
    expect(missingCapabilities('gemini')).toContain('plan')
    expect(missingCapabilities('gemini', modes)).not.toContain('plan')
    expect(missingCapabilities('gemini', modes)).toContain('steer')
    expect(supportsPlan('gemini', modes)).toBe(true)
    expect(supportsPlan('claude')).toBe(true)
    expect(supportsPlan('codex', modes)).toBe(false)
    expect(planControl('gemini', { planMode: true, mixed: false, modes })).toBe('on')
    expect(planControl('gemini', { planMode: false, mixed: false })).toBe('hidden')
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
    await createAcpDriver({ kind: 'opencode', label: 'OpenCode', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(log)) })
      .createTurn(request(await tempDir(), { planMode: true }), rec.cb)
      .run()
    expect(log.methods).toEqual(['initialize', 'session/new', 'set_mode:plan'])
    expect(rec.items.some((i) => i.kind === 'assistant' && i.text === 'in plan')).toBe(true)
    expect(rec.results).toEqual([{ ok: true }])
  })

  it('switches through the "mode" config option when the agent lists modes that way', async () => {
    const log = newLog()
    const rec = recorder()
    await createAcpDriver({ kind: 'gemini', label: 'Gemini CLI', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(log, { configOption: true })) })
      .createTurn(request(await tempDir(), { planMode: true }), rec.cb)
      .run()
    expect(log.methods).toContain('set_config:mode=plan')
    expect(rec.results).toEqual([{ ok: true }])
  })

  it('leaves the mode alone without Plan, and the chip follows when the agent leaves plan mode itself', async () => {
    const log = newLog()
    const rec = recorder()
    await createAcpDriver({ kind: 'opencode', label: 'OpenCode', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(log)) })
      .createTurn(request(await tempDir()), rec.cb)
      .run()
    expect(log.methods).toEqual(['initialize', 'session/new'])
    const log2 = newLog()
    const rec2 = recorder()
    await createAcpDriver({ kind: 'opencode', label: 'OpenCode', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(log2, { leavePlanOnPrompt: true })) })
      .createTurn(request(await tempDir(), { planMode: true }), rec2.cb)
      .run()
    expect(rec2.plan).toEqual([false])
  })

  it('doesn’t start a Plan turn it can’t put in plan mode', async () => {
    const noPlan = newLog()
    const rec = recorder()
    await createAcpDriver({ kind: 'gemini', label: 'Gemini CLI', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(noPlan, { modes: [{ id: 'default', name: 'Default' }] })) })
      .createTurn(request(await tempDir(), { planMode: true }), rec.cb)
      .run()
    expect(noPlan.prompts).toEqual([])
    expect(rec.results).toEqual([{ ok: false, error: expect.stringMatching(/doesn’t offer a plan mode/) }])
    const refused = newLog()
    const rec2 = recorder()
    await createAcpDriver({ kind: 'gemini', label: 'Gemini CLI', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(refused, { refuseMode: true })) })
      .createTurn(request(await tempDir(), { planMode: true }), rec2.cb)
      .run()
    expect(refused.prompts).toEqual([])
    expect(rec2.results).toEqual([{ ok: false, error: expect.stringMatching(/Couldn’t switch Gemini CLI to its plan mode/) }])
  })

  it('lists the declared modes with the models', async () => {
    const log = newLog()
    const listed = await listAcpSession({ kind: 'opencode', label: 'OpenCode', command: () => ({ file: 'x', args: [] }), connect: inProcess(modalAgent(log)) }, { cwd: await tempDir(), env: {} })
    expect(listed.modes).toEqual([
      { id: 'build', name: 'Build' },
      { id: 'plan', name: 'Plan' }
    ])
  })
})
