// The assistant and the `foreman` command: CLI keys in settings search, cli_help and
// cli_status, run_foreman's pending run and the click that runs it in process, the prompt and the guide.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliLine, searchCommands } from '../src/shared/assistantCli'
import { commandLine, foremanRunOf, runFollowUp, MAX_ASSISTANT_MESSAGE, searchSettings } from '../src/shared/assistant'
import { assistantSystemPrompt } from '../src/shared/assistantGuide'
import { COMMANDS, GROUP_LABELS, commandName } from '../src/shared/cliCommands'
import { REPO_SETTINGS_SCHEMA } from '../src/shared/repoSettingsSchema'
import { SETTINGS_SCHEMA } from '../src/shared/settingsSchema'
import { SETTINGS } from '../src/shared/settingsRegistry'
import type { AgentStatus, ChatItem, MainEvent } from '../src/shared/types'
import { AssistantService } from '../src/main/assistant'
import { ForemanActions } from '../src/main/foremanActions'
import { delegationRig } from './foremanDelegationHarness'
import { runCli } from '../src/main/cli/inProcess'
import type { AgentDriver, AssistantTools, TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import { Store } from '../src/main/store'
import { fakeApi, stubHost } from './cliHost'
import { tempDir } from './helpers'

const ready = { claude: { agent: 'claude', installed: true, ready: true } as AgentStatus }

// ---- search_settings carries the CLI key ----

describe('settings search names the command', () => {
  it('every registry row with a spec gets a cli line naming a key that exists', () => {
    const personal = SETTINGS_SCHEMA.filter((s) => s.registryId)
    const repository = REPO_SETTINGS_SCHEMA.filter((s) => s.registryId)
    expect(personal.length).toBeGreaterThan(20)
    expect(repository.length).toBeGreaterThan(5)
    for (const spec of personal) {
      const row = SETTINGS.find((e) => e.id === spec.registryId)
      expect(row, spec.key).toBeDefined()
      expect(cliLine(row!), spec.key).toContain(spec.key)
    }
    for (const spec of repository) {
      const row = SETTINGS.find((e) => e.id === spec.registryId)!
      const line = cliLine(row)
      expect(line, spec.key).toContain(`foreman repo settings set ${spec.key}`)
      expect(line, spec.key).toContain('--repo <name>')
    }
  })

  it('says what a key takes, and none for a row with no command', () => {
    const theme = SETTINGS.find((e) => e.id === 'theme')!
    expect(cliLine(theme)).toBe('cli: foreman settings set appearance.theme <system|light|dark>')
    const without = SETTINGS.filter((e) => cliLine(e) === 'cli: none')
    expect(without.length).toBeGreaterThan(0)
  })

  it('shows the line in the tool result, for settings and repository rows alike', async () => {
    const { service } = await rig()
    const tools = service.tools()
    expect(tools.searchSettings('theme')).toMatch(/id: theme .* · cli: foreman settings set appearance\.theme <system\|light\|dark>/)
    const repoRow = SETTINGS.find((e) => e.id === 'repo-checks-after-turn')!
    const found = searchSettings(repoRow.title, 'darwin')
    expect(found.some((e) => e.id === repoRow.id)).toBe(true)
    expect(tools.searchSettings(repoRow.title)).toContain('foreman repo settings set scripts.checks-after-turn <on|off> --repo <name>')
  })
})

// ---- cli_help and cli_status ----

describe('cli_help', () => {
  it('finds archive with its options and examples', async () => {
    const { service } = await rig()
    const help = service.tools().cliHelp('archive')
    expect(help).toMatch(/foreman (ws|workspace) archive/)
    const archive = COMMANDS.find((c) => commandName(c) === 'workspace archive')!
    for (const name of Object.keys(archive.options)) expect(help).toContain(`--${name}`)
    expect(help).toContain('--yes')
    expect(help).toContain('Usage:')
    expect(help).toContain('Examples:')
  })

  it('shows a secret-taking command with --stdin and no value placeholder', async () => {
    const { service } = await rig()
    const help = service.tools().cliHelp('token')
    expect(help).toContain('--stdin')
    expect(help).not.toMatch(/--(token|value|key|secret|password)\s+<[^>]+>/)
    // It says the assistant may not run it.
    expect(help).toContain('You may not run this one with run_foreman')
  })

  it('returns at most five commands, and says when none match', async () => {
    const { service } = await rig()
    expect(searchCommands('settings', COMMANDS).length).toBeLessThanOrEqual(5)
    expect(service.tools().cliHelp('zzzzqq')).toMatch(/No command matches/)
    expect(searchCommands('mcp bridge', COMMANDS).every((c) => !c.hidden)).toBe(true)
  })
})

describe('cli_status', () => {
  it('reports the install and the app version through the same Api the window uses', async () => {
    const { service } = await rig()
    const tools = service.tools()
    expect(await tools.cliStatus()).toMatch(/not available/)
    service.attachCli(stubHost({ api: fakeApi({ cliStatus: async () => ({ installed: true, path: '/usr/local/bin/foreman' }) }), appInfo: () => ({ version: '9.9.9', packaged: false, dataDir: '' }) }))
    expect(await tools.cliStatus()).toContain('Foreman 9.9.9. The foreman command is installed at /usr/local/bin/foreman')
    service.attachCli(stubHost({ api: fakeApi({ cliStatus: async () => ({ installed: false, path: null }) }) }))
    expect(await tools.cliStatus()).toMatch(/not installed.*Settings › Advanced/)
  })
})

// ---- the prompt and the guide ----

describe('prompt and guide', () => {
  const prompt = assistantSystemPrompt('darwin')

  it('asks for both forms and says a run needs the click', () => {
    expect(prompt).toContain('give both forms: the steps in the app, then')
    expect(prompt).toContain('the command on its own line in a code block')
    expect(prompt).toContain('You can propose a `foreman` command with run_foreman; it runs only when the user clicks Run.')
    expect(prompt).toContain('Prefer showing the steps and the command; propose a run when the user asks you to do it, or says "just do it".')
    expect(prompt).not.toContain('You cannot change settings, run commands')
  })

  it('keeps the secrets rule and stays static', () => {
    expect(prompt).toContain('Never ask for, repeat or guess API keys')
    expect(prompt).toContain('--stdin')
    expect(prompt).toContain('every command takes --json'.replace('every', 'Every'))
    expect(prompt).toContain('appearance.theme')
    expect(prompt).toContain('scripts.checks-after-turn')
  })

  it('names every group of `foreman help`', () => {
    const guide = prompt.toLowerCase()
    for (const label of Object.values(GROUP_LABELS)) expect(guide, label).toContain(label.toLowerCase())
  })
})

// ---- run_foreman ----

interface FakeTurn {
  request: TurnRequest
  callbacks: TurnCallbacks
  finish(): void
}

function fakeDriver() {
  const turns: FakeTurn[] = []
  const driver = {
    kind: 'claude',
    createTurn(request: TurnRequest, callbacks: TurnCallbacks) {
      let end: () => void = () => {}
      const ended = new Promise<void>((resolve) => (end = resolve))
      turns.push({
        request,
        callbacks,
        finish() {
          callbacks.finished({ ok: true })
          end()
        }
      })
      return { run: () => ended, stop: async () => end(), steer: () => false, setPlanMode: async () => undefined, setModel: async () => undefined }
    },
    status: async () => ({ agent: 'claude', installed: true, ready: true })
  } as unknown as AgentDriver
  return { driver, turns }
}

const roots: string[] = []
afterEach(() => vi.restoreAllMocks())

async function rig() {
  const root = await tempDir('foreman-assistant-cli-')
  roots.push(root)
  const store = new Store(root)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const events: MainEvent[] = []
  const { driver, turns } = fakeDriver()
  const service = new AssistantService({
    store,
    environment: { forAgent: () => ({ PATH: '/bin' }) },
    statuses: async () => ready,
    platform: 'darwin',
    dir: `${root}/assistant`,
    broadcast: (event) => void events.push(event),
    driverFor: () => driver
  })
  return { store, service, turns, events }
}

/** A thread with a first turn open, the assistant's tools of that turn, and a host that counts its reads. */
async function proposing() {
  const r = await rig()
  const state = vi.fn(() => r.store.state)
  r.service.attachCli(stubHost({ state: state as never }))
  const { threadId } = await r.service.send(null, 'Set the theme to dark')
  const turn = r.turns[0]
  const tools = turn.request.assistant!.tools as AssistantTools
  return { ...r, state, threadId, turn, tools }
}

const runItems = (items: ChatItem[]) => items.filter((i) => foremanRunOf(i))

describe('run_foreman', () => {
  it('leaves a pending run and runs nothing until the click', async () => {
    const { service, state, threadId, tools } = await proposing()
    const answer = tools.runForeman(['settings', 'get', 'appearance.theme'])
    expect(answer).toBe('Waiting for the user to click Run: foreman settings get appearance.theme')
    expect(state).not.toHaveBeenCalled()
    const [item] = runItems(service.items(threadId))
    expect(foremanRunOf(item)).toMatchObject({ command: 'foreman settings get appearance.theme', state: 'pending' })
    expect(item).toMatchObject({ kind: 'tool', name: 'foreman', status: 'running' })
    expect(state).not.toHaveBeenCalled()
  })

  it('will not propose foreman ask, which runs the assistant itself, and cli_help says so', async () => {
    const { service, threadId, tools } = await proposing()
    const answer = tools.runForeman(['ask', 'what needs me?'])
    expect(answer).toContain('it runs the assistant itself')
    expect(answer).toContain('copy it')
    expect(runItems(service.items(threadId))).toEqual([])
    expect(tools.cliHelp('ask foreman a question')).toContain('You may not run this one with run_foreman: it runs the assistant itself')
  })

  it('refuses a command the assistant may not run, with its reason', async () => {
    const { service, threadId, tools } = await proposing()
    const secret = COMMANDS.find((c) => c.noAssistant && c.path[0] === 'keys' && c.path[1] === 'set')!
    const answer = tools.runForeman(['keys', 'set', 'OPENAI_API_KEY'])
    expect(answer).toContain(secret.noAssistant!)
    expect(answer).toContain('copy it')
    expect(runItems(service.items(threadId))).toEqual([])
    // A command that reads standard input can't be run from here either.
    expect(tools.runForeman(['settings', 'set', 'environment.env-files', '--stdin'])).toMatch(/--stdin reads from a terminal/)
    expect(tools.runForeman(['env', 'get', 'KEY', '--reveal'])).toMatch(/secret|reveals/)
    expect(runItems(service.items(threadId))).toEqual([])
  })

  it('returns the usage error for an option the command lacks, an unknown command, or no command', async () => {
    const { service, threadId, tools } = await proposing()
    expect(tools.runForeman(['settings', 'get', '--nope', 'appearance.theme'])).toMatch(/foreman settings get doesn’t take --nope/)
    expect(tools.runForeman(['frobnicate'])).toMatch(/Unknown command/)
    expect(tools.runForeman(['mcp-bridge'])).not.toMatch(/Waiting/)
    expect(runItems(service.items(threadId))).toEqual([])
  })

  it('runs in process on Run, shows the output under the command and tells the assistant', async () => {
    const { service, store, events, turns, threadId, turn, tools } = await proposing()
    store.state.settings.theme = 'dark'
    tools.runForeman(['settings', 'get', 'appearance.theme'])
    turn.callbacks.item({ kind: 'assistant', id: 'a1', turnId: turn.request.turnId, text: 'Waiting for you to click Run.' })
    turn.finish()
    await service.settled(threadId)
    const [pending] = runItems(service.items(threadId))
    const runId = (foremanRunOf(pending)!).runId

    await service.confirmRun(threadId, runId)

    const [item] = runItems(service.items(threadId))
    expect(foremanRunOf(item)).toMatchObject({ state: 'done', exitCode: 0 })
    expect(item).toMatchObject({ status: 'done' })
    expect(item.kind === 'tool' && item.output).toContain('appearance.theme')
    expect(item.kind === 'tool' && item.output).toContain('dark')
    expect(events.some((e) => e.type === 'assistant-item' && foremanRunOf(e.item)?.state === 'running')).toBe(true)

    // The result goes back as a message the user's click sent: a new turn on the same thread.
    expect(turns).toHaveLength(2)
    expect(turns[1].request.prompt).toMatch(/^\[foreman settings get appearance\.theme\] exited 0\n/)
    expect(turns[1].request.prompt.length).toBeLessThanOrEqual(MAX_ASSISTANT_MESSAGE)
    const system = service.items(threadId).find((i) => i.kind === 'user' && i.system)
    expect(system).toBeDefined()
    // One click, one run.
    await expect(service.confirmRun(threadId, runId)).rejects.toThrow(/isn’t waiting/)
    expect(turns).toHaveLength(2)
  })

  it('waits for the proposing turn to finish before telling the assistant', async () => {
    const { service, turns, threadId, turn, tools } = await proposing()
    tools.runForeman(['settings', 'get', 'appearance.theme'])
    const runId = foremanRunOf(runItems(service.items(threadId))[0])!.runId
    const clicked = service.confirmRun(threadId, runId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turns).toHaveLength(1)
    turn.finish()
    await clicked
    expect(turns).toHaveLength(2)
  })

  it('records a failing command with its exit code', async () => {
    const { service, threadId, turn, tools } = await proposing()
    tools.runForeman(['settings', 'get', 'appearance.nope'])
    turn.finish()
    await service.settled(threadId)
    const runId = foremanRunOf(runItems(service.items(threadId))[0])!.runId
    await service.confirmRun(threadId, runId)
    const item = runItems(service.items(threadId))[0]
    expect(foremanRunOf(item)?.exitCode).not.toBe(0)
    expect(item).toMatchObject({ status: 'error' })
  })

  it('discards a run the user cancels', async () => {
    const { service, state, threadId, turn, tools, turns } = await proposing()
    tools.runForeman(['settings', 'get', 'appearance.theme'])
    const runId = foremanRunOf(runItems(service.items(threadId))[0])!.runId
    await service.cancelRun(threadId, runId)
    expect(foremanRunOf(runItems(service.items(threadId))[0])).toMatchObject({ state: 'cancelled' })
    turn.finish()
    await service.settled(threadId)
    await expect(service.confirmRun(threadId, runId)).rejects.toThrow(/isn’t waiting/)
    expect(state).not.toHaveBeenCalled()
    expect(turns).toHaveLength(1)
  })

  it('drops a command still waiting when Foreman restarts', async () => {
    const { service, store, threadId, tools } = await proposing()
    tools.runForeman(['settings', 'get', 'appearance.theme'])
    const again = new AssistantService({
      store,
      environment: { forAgent: () => ({}) },
      statuses: async () => ready,
      platform: 'darwin',
      dir: 'x',
      broadcast: () => undefined
    })
    expect(foremanRunOf(runItems(again.items(threadId)).at(-1)!)).toMatchObject({ state: 'cancelled' })
    again.attachCli(stubHost())
    await expect(again.confirmRun(threadId, foremanRunOf(runItems(again.items(threadId))[0])!.runId)).rejects.toThrow(/isn’t waiting/)
  })
})

// ---- runCli ----

describe('runCli', () => {
  const options = { confirmed: true as const, cwd: process.cwd() }

  it('runs settings get in process and prints what the terminal would', async () => {
    const host = stubHost()
    host.state().settings.theme = 'dark'
    const result = await runCli(['settings', 'get', 'appearance.theme'], stubHost(), options)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('appearance.theme')
    expect(result.stderr).toBe('')
  })

  it('honours --json', async () => {
    const result = await runCli(['settings', 'get', 'appearance.theme', '--json'], stubHost(), options)
    expect(result.exitCode).toBe(0)
    expect(result.json).toMatchObject({ rows: [expect.objectContaining({ key: 'appearance.theme' })] })
    expect(JSON.parse(result.stdout)).toEqual(result.json)
  })

  it('turns a failure into an exit code and the message', async () => {
    const result = await runCli(['settings', 'get', 'appearance.nope'], stubHost(), options)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('No setting called')
  })

  it('answers a bad option as a usage error and never throws', async () => {
    const result = await runCli(['settings', 'get', '--nope'], stubHost(), options)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('doesn’t take --nope')
  })

  it('refuses mcp-bridge, and anything reading standard input or a revealed secret', async () => {
    expect((await runCli(['mcp-bridge'], stubHost(), options)).exitCode).not.toBe(0)
    expect((await runCli(['settings', 'set', 'environment.env-files', '--stdin'], stubHost(), options)).stderr).toMatch(/stdin/)
    expect((await runCli(['env', 'get', 'X', '--reveal'], stubHost(), options)).exitCode).toBe(2)
  })

  it('does not run without the click', async () => {
    const result = await runCli(['settings', 'get', 'appearance.theme'], stubHost(), { ...options, confirmed: false as never })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe('')
  })

  it('leaves console and the exit code as it found them', async () => {
    const log = console.log
    const exit = process.exitCode
    await runCli(['settings', 'get', 'appearance.nope'], stubHost(), options)
    expect(console.log).toBe(log)
    expect(process.exitCode).toBe(exit)
  })
})

describe('what a finished command says to the assistant', () => {
  it('quotes words the way a person would type them and stays within the message limit', () => {
    expect(commandLine(['settings', 'set', 'git.branch-prefix', 'my prefix/'])).toBe('foreman settings set git.branch-prefix "my prefix/"')
    const long = runFollowUp(['status'], 0, 'x'.repeat(MAX_ASSISTANT_MESSAGE * 2))
    expect(long.length).toBeLessThanOrEqual(MAX_ASSISTANT_MESSAGE)
    expect(long.startsWith('[foreman status] exited 0\n')).toBe(true)
    expect(runFollowUp(['status'], 1, '')).toBe('[foreman status] exited 1')
  })
})

describe('assistant Foreman actions', () => {
  async function actionRig() {
    const r = await rig()
    r.store.state.workspaces.push({ id: 'w', repoId: 'r', name: 'Website', branch: 'task', baseBranch: 'main', portBase: 50030, state: 'ready', createdAt: '' })
    const api = {
      checksStatus: vi.fn(async () => ({ configured: true, running: false, rows: [] })),
      runChecks: vi.fn(async () => ({ started: true as const })),
      openPreview: vi.fn(async () => {})
    }
    r.service.foremanActions = new ForemanActions({ state: () => r.store.state, api })
    const { threadId } = await r.service.send(null, 'Open the preview')
    const turn = r.turns[0]
    return { ...r, api, threadId, turn, tools: turn.request.assistant!.tools }
  }

  it('reads live state without a click, then proposes a mutation and executes it exactly once on confirmation', async () => {
    const { service, api, threadId, turn, tools, turns } = await actionRig()
    expect(JSON.parse(await tools.foremanAction!('get_workspace_status', 'w'))).toMatchObject({ id: 'w', state: 'ready' })
    await tools.foremanAction!('get_check_results', 'w')
    expect(api.checksStatus).toHaveBeenCalledWith('w')
    expect(runItems(service.items(threadId))).toEqual([])
    expect(await tools.foremanAction!('open_preview', 'w')).toContain('Waiting for the user')
    expect(api.openPreview).not.toHaveBeenCalled()
    const pending = foremanRunOf(runItems(service.items(threadId))[0])!
    expect(pending).toMatchObject({ command: 'Open preview: Website (w)', state: 'pending' })
    turn.finish()
    await service.settled(threadId)
    await service.confirmRun(threadId, pending.runId)
    expect(api.openPreview).toHaveBeenCalledExactlyOnceWith('w')
    expect(foremanRunOf(runItems(service.items(threadId))[0])).toMatchObject({ state: 'done', exitCode: 0 })
    expect(turns[1].request.prompt).toContain('[Foreman action open_preview] exited 0')
    await expect(service.confirmRun(threadId, pending.runId)).rejects.toThrow()
    expect(api.openPreview).toHaveBeenCalledTimes(1)
  })

  it('cancels without running and revalidates workspace availability when the user confirms', async () => {
    const { service, api, store, threadId, turn, tools } = await actionRig()
    await tools.foremanAction!('run_checks', 'w')
    const first = foremanRunOf(runItems(service.items(threadId))[0])!
    await service.cancelRun(threadId, first.runId)
    expect(api.runChecks).not.toHaveBeenCalled()
    await tools.foremanAction!('open_preview', 'w')
    const second = foremanRunOf(runItems(service.items(threadId))[1])!
    store.state.workspaces[0].state = 'archived'
    turn.finish()
    await service.settled(threadId)
    await service.confirmRun(threadId, second.runId)
    expect(api.openPreview).not.toHaveBeenCalled()
    expect(foremanRunOf(runItems(service.items(threadId))[1])).toMatchObject({ state: 'done', exitCode: 1 })
  })
})

describe('assistant delegation', () => {
  async function delegationAssistant() {
    const r = await rig()
    const delegation = delegationRig()
    r.service.delegation = delegation.service
    const { threadId } = await r.service.send(null, 'Have one agent research and another plan')
    const turn = r.turns[0]
    return { ...r, ...delegation, service: r.service, turns: r.turns, threadId, turn, tools: turn.request.assistant!.tools }
  }

  it('discovers loadouts without a click and starts the selected task only once after confirmation', async () => {
    const r = await delegationAssistant()
    expect(JSON.parse(await r.tools.delegate!('list_delegation_options', {}))).toMatchObject({ delegationEnabled: true, loadouts: [{ slot: 1 }, { slot: 2 }, { slot: 3 }, { slot: 4 }] })
    const args = { repoId: 'r', prompt: 'Research this design', loadout: 1 }
    expect(await r.tools.delegate!('start_task', args)).toContain('Waiting for the user')
    expect(r.createWorkspace).not.toHaveBeenCalled()
    const pending = foremanRunOf(runItems(r.service.items(r.threadId))[0])!
    expect(pending.command).toContain('Research this design')
    expect(pending.command).toContain('"loadout": 1')
    r.turn.finish()
    await r.service.settled(r.threadId)
    await r.service.confirmRun(r.threadId, pending.runId)
    expect(r.createWorkspace).toHaveBeenCalledTimes(1)
    expect(r.turns[1].request.prompt).toContain('[Foreman action start_task] exited 0')
    await expect(r.service.confirmRun(r.threadId, pending.runId)).rejects.toThrow()
  })

  it('cancels proposals without execution and rechecks stale targets at confirmation', async () => {
    const r = await delegationAssistant()
    await r.tools.delegate!('start_task', { repoId: 'r', prompt: 'Research', loadout: 1 })
    const first = foremanRunOf(runItems(r.service.items(r.threadId))[0])!
    await r.service.cancelRun(r.threadId, first.runId)
    expect(r.createWorkspace).not.toHaveBeenCalled()
    await r.tools.delegate!('send_task', { workspaceId: 'w', sessionId: 's', prompt: 'Plan from these findings' })
    const second = foremanRunOf(runItems(r.service.items(r.threadId))[1])!
    r.session.closedAt = 'now'
    r.turn.finish()
    await r.service.settled(r.threadId)
    await r.service.confirmRun(r.threadId, second.runId)
    expect(r.deliver).not.toHaveBeenCalled()
    expect(foremanRunOf(runItems(r.service.items(r.threadId))[1])).toMatchObject({ state: 'done', exitCode: 1 })
  })
})
