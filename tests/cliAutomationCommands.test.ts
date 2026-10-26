import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../src/cli/client'
import type { Context } from '../src/cli/command'
import { automationRunners } from '../src/cli/commands/automations'
import { io } from '../src/cli/commands/input'
import { renderCommandHelp } from '../src/cli/help'
import { confirm } from '../src/cli/output'
import { ERROR_EXIT } from '../src/cli/protocol'
import { parseCommandArgs } from '../src/cli/registry'
import { COMMANDS, commandName, findCommand, type CommandSpec } from '../src/shared/cliCommands'
import { AUTOMATION_COMMANDS } from '../src/shared/cliCommandsAutomations'

// The automation commands as exposed by the combined command registry.
const ALL: CommandSpec[] = [...COMMANDS.filter((c) => !AUTOMATION_COMMANDS.some((a) => commandName(a) === commandName(c))), ...AUTOMATION_COMMANDS]

type Answers = Record<string, unknown>

/** Parse a command line the way the registry does, and run its function against canned answers. */
async function run(line: string[], answers: Answers = {}, extra: Partial<Context> = {}) {
  const found = findCommand(line, ALL)
  if ('error' in found) throw new Error(found.error)
  const { opts, positionals } = parseCommandArgs(found.spec, found.rest)
  const sent: [string, Record<string, unknown>][] = []
  const out: string[] = []
  const context: Context = {
    args: positionals,
    opts,
    json: Boolean(opts.json),
    quiet: false,
    yes: Boolean(opts.yes),
    cwd: '/work',
    send: (async (method: string, params?: unknown) => {
      sent.push([method, (params ?? {}) as Record<string, unknown>])
      const answer = answers[method]
      return typeof answer === 'function' ? (answer as (p: Record<string, unknown>) => unknown)((params ?? {}) as Record<string, unknown>) : answer
    }) as Context['send'],
    print: (value, text) => void out.push(opts.json ? JSON.stringify(value) : typeof text === 'function' ? text() : text),
    // The real question, with nobody to ask unless --yes: what a script gets.
    confirm: (question) => confirm(question, { yes: Boolean(opts.yes), interactive: false }),
    note: () => undefined,
    progress: () => undefined,
    ...extra
  }
  const result = automationRunners[commandName(found.spec)](context)
  return { done: result, sent, out, spec: found.spec }
}

async function ran(...args: Parameters<typeof run>) {
  const r = await run(...args)
  await r.done
  return r
}

const text = (t: string) => ({ text: t })

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('the automation command table', () => {
  it('has no two commands with the same path and does not declare the paths other agents own', () => {
    const names = AUTOMATION_COMMANDS.map(commandName)
    expect(new Set(names).size).toBe(names.length)
    expect(names).not.toContain('agents key')
    expect(names).not.toContain('cloud token')
    expect(names).not.toContain('templates')
  })

  it('gives every command a summary, usage and an example, and renders its help', () => {
    for (const spec of AUTOMATION_COMMANDS) {
      const name = commandName(spec)
      expect(spec.summary, name).toBeTruthy()
      expect(spec.usage.startsWith(`foreman ${name}`), name).toBe(true)
      expect(spec.examples?.length, name).toBeGreaterThan(0)
      const help = renderCommandHelp(spec)
      expect(help, name).toContain(spec.usage)
      for (const option of Object.keys(spec.options)) expect(help, `${name} --${option}`).toContain(`--${option}`)
    }
  })

  it('has a function for every command and none without a spec', () => {
    expect(Object.keys(automationRunners).sort()).toEqual(AUTOMATION_COMMANDS.map(commandName).sort())
  })

  it('puts the groups where the plan says', () => {
    const group = (name: string) => AUTOMATION_COMMANDS.find((c) => commandName(c) === name)?.group
    expect(group('usage')).toBe('app')
    expect(group('data')).toBe('app')
    expect(group('loadouts')).toBe('settings')
    expect(group('connections add')).toBe('settings')
  })

  it('resolves templates show to this array and leaves the older templates list alone', () => {
    const show = findCommand(['templates', 'show', 'fix'], ALL)
    expect('spec' in show && show.spec.path).toEqual(['templates', 'show'])
    expect('spec' in show && show.rest).toEqual(['fix'])
    expect('spec' in show && show.spec).toBe(AUTOMATION_COMMANDS.find((c) => commandName(c) === 'templates show'))
    const list = findCommand(['templates', '--json'], ALL)
    expect('spec' in list && list.spec.path).toEqual(['templates'])
    expect('spec' in list && list.spec.args).toEqual([])
  })

  it('marks the commands that read a secret or delete for good as not for the assistant to run', () => {
    for (const name of ['connections add', 'git-backup', 'data delete-legacy']) expect(AUTOMATION_COMMANDS.find((c) => commandName(c) === name)?.noAssistant, name).toBeTruthy()
  })

  it('takes no option named token, so a token can’t be an argument', () => {
    const add = AUTOMATION_COMMANDS.find((c) => commandName(c) === 'connections add')!
    expect(Object.keys(add.options)).not.toContain('token')
    expect(() => parseCommandArgs(add, ['vercel', '--token', 'secret'])).toThrow(/doesn’t take --token/)
  })
})

describe('loadouts, models and agents', () => {
  it('loadouts set sends the slot, agent, model, effort and fast', async () => {
    const { sent, out } = await ran(['loadouts', 'set', '2', 'claude', 'claude-opus-5-5', '--effort', 'high', '--fast'], { 'loadouts-set': text('Saved slot 2.') })
    expect(sent).toEqual([['loadouts-set', { slot: 2, agent: 'claude', model: 'claude-opus-5-5', effort: 'high', fast: true }]])
    expect(out).toEqual(['Saved slot 2.'])
    const off = await ran(['loadouts', 'set', '1', 'codex', 'gpt-5.5', '--no-fast'], { 'loadouts-set': text('ok') })
    expect(off.sent[0][1]).toMatchObject({ slot: 1, fast: false })
    const neither = await ran(['loadouts', 'add', 'codex', 'gpt-5.5'], { 'loadouts-add': text('ok') })
    expect(neither.sent[0]).toEqual(['loadouts-add', { agent: 'codex', model: 'gpt-5.5', effort: undefined, fast: undefined }])
  })

  it('loadouts set refuses a bad slot, effort or both fast flags before sending', async () => {
    for (const line of [['loadouts', 'set', 'x', 'claude', 'm'], ['loadouts', 'set', '0', 'claude', 'm'], ['loadouts', 'set', '1', 'claude', 'm', '--effort', 'huge'], ['loadouts', 'set', '1', 'claude', 'm', '--fast', '--no-fast'], ['loadouts', 'set', '1', 'claude']]) {
      const r = await run(line, {})
      await expect(r.done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
      expect(r.sent, line.join(' ')).toEqual([])
    }
  })

  it('loadouts remove and move send their slots; remove asks first', async () => {
    await expect((await run(['loadouts', 'remove', '3'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT['needs-confirmation'] })
    const removed = await ran(['loadouts', 'remove', '3', '--yes'], { 'loadouts-remove': text('Removed.') })
    expect(removed.sent).toEqual([['loadouts-remove', { slot: 3 }]])
    const moved = await ran(['loadouts', 'move', '3', '1'], { 'loadouts-move': text('Moved.') })
    expect(moved.sent).toEqual([['loadouts-move', { from: 3, to: 1 }]])
  })

  it('loadouts lists, and review-model gets or sets', async () => {
    expect((await ran(['loadouts'], { 'loadouts-list': text('1 claude') })).out).toEqual(['1 claude'])
    expect((await ran(['loadouts', 'list'], { 'loadouts-list': text('1 claude') })).sent).toEqual([['loadouts-list', {}]])
    expect((await ran(['review-model'], { 'review-model-get': text('Review model: claude') })).sent[0][0]).toBe('review-model-get')
    const set = await ran(['review-model', 'set', 'claude', 'opus', '--effort', 'max'], { 'review-model-set': text('ok') })
    expect(set.sent).toEqual([['review-model-set', { agent: 'claude', model: 'opus', effort: 'max', fast: undefined }]])
    await expect((await run(['review-model', 'get'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
  })

  it('models list, hide, show and refresh send the agent and the model ids', async () => {
    expect((await ran(['models', 'claude', '--all'], { 'models-list': text('m') })).sent).toEqual([['models-list', { agent: 'claude', all: true }]])
    expect((await ran(['models'], { 'models-list': text('m') })).sent).toEqual([['models-list', { agent: undefined, all: undefined }]])
    expect((await ran(['models', 'hide', 'claude', 'a', 'b'], { 'models-hide': text('h') })).sent).toEqual([['models-hide', { agent: 'claude', models: ['a', 'b'] }]])
    expect((await ran(['models', 'show', 'claude', 'a'], { 'models-show': text('s') })).sent).toEqual([['models-show', { agent: 'claude', models: ['a'] }]])
    expect((await ran(['models', 'refresh', 'codex'], { 'models-refresh': text('r') })).sent).toEqual([['models-refresh', { agent: 'codex' }]])
    await expect((await run(['models', 'hide', 'claude'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
  })

  it('agents auth maps login and api-key to the mode', async () => {
    expect((await ran(['agents', 'auth', 'claude', 'api-key'], { 'agents-auth': text('ok') })).sent).toEqual([['agents-auth', { id: 'claude', mode: 'api-key' }]])
    expect((await ran(['agents', 'auth', 'codex', 'login'], { 'agents-auth': text('ok') })).sent).toEqual([['agents-auth', { id: 'codex', mode: 'login' }]])
    const bad = await run(['agents', 'auth', 'codex', 'token'], {})
    await expect(bad.done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
    expect(bad.sent).toEqual([])
  })

  it('agents lists, enables, disables, sets a path and reports status', async () => {
    expect((await ran(['agents', '--refresh'], { 'agents-list': text('a') })).sent).toEqual([['agents-list', { refresh: true }]])
    expect((await ran(['agents', 'enable', 'codex'], { 'agents-enable': text('a') })).sent).toEqual([['agents-enable', { id: 'codex' }]])
    expect((await ran(['agents', 'disable', 'codex'], { 'agents-disable': text('a') })).sent).toEqual([['agents-disable', { id: 'codex' }]])
    expect((await ran(['agents', 'path', 'codex', './bin/codex'], { 'agents-path': text('a') })).sent).toEqual([['agents-path', { id: 'codex', path: './bin/codex', clear: undefined, cwd: '/work' }]])
    expect((await ran(['agents', 'path', 'codex', '--clear'], { 'agents-path': text('a') })).sent[0][1]).toMatchObject({ clear: true, path: undefined })
    expect((await ran(['agents', 'status', 'claude'], { 'agents-status': text('a') })).sent).toEqual([['agents-status', { id: 'claude' }]])
    for (const line of [['agents', 'path', 'codex'], ['agents', 'path', 'codex', 'x', '--clear']]) await expect((await run(line, {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
  })
})

describe('templates', () => {
  it('show sends the template and where the command ran', async () => {
    const { sent, out } = await ran(['templates', 'show', 'fix-a-bug'], { 'templates-show': text('Fix a bug\n\nbody') })
    expect(sent).toEqual([['templates-show', { template: 'fix-a-bug', cwd: '/work' }]])
    expect(out).toEqual(['Fix a bug\n\nbody'])
  })

  it('add --stdin reads the prompt from standard input and sends the models', async () => {
    const read = vi.spyOn(io, 'readStdin').mockResolvedValue('Fix {{issue}}\n')
    const { sent } = await ran(['templates', 'add', 'fix-a-bug', '--stdin', '--agent', 'claude', '--model', 'opus', '--effort', 'high', '--follow-up', 'Ship it', '--follow-up-prompt', 'Open a PR'], { 'templates-add': text('Added.') })
    expect(read).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([['templates-add', { name: 'fix-a-bug', body: 'Fix {{issue}}\n', startModel: { agent: 'claude', model: 'opus', effort: 'high' }, followUp: { title: 'Ship it', prompt: 'Open a PR' } }]])
  })

  it('add --file reads relative to where the command ran, and wants exactly one source', async () => {
    const readFile = vi.spyOn(io, 'readFile').mockResolvedValue('from file')
    const { sent } = await ran(['templates', 'add', 'x', '--file', 'p.md'], { 'templates-add': text('ok') })
    expect(readFile).toHaveBeenCalledWith('p.md', '/work')
    expect(sent[0][1]).toMatchObject({ name: 'x', body: 'from file' })
    for (const line of [['templates', 'add', 'x'], ['templates', 'add', 'x', '--file', 'p.md', '--stdin'], ['templates', 'add', 'x', '--stdin', '--agent', 'claude'], ['templates', 'add', 'x', '--stdin', '--follow-up', 't']]) {
      vi.spyOn(io, 'readStdin').mockResolvedValue('body')
      const r = await run(line, { 'templates-add': text('ok') })
      await expect(r.done, line.join(' ')).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
      expect(r.sent, line.join(' ')).toEqual([])
    }
  })

  it('edit sends only what changed, and refuses an empty change', async () => {
    const { sent } = await ran(['templates', 'edit', 'fix', '--name', 'Fix it', '--clear-start-model'], { 'templates-edit': text('ok') })
    expect(sent[0][1]).toMatchObject({ template: 'fix', name: 'Fix it', clearStartModel: true, cwd: '/work' })
    expect(sent[0][1].body).toBeUndefined()
    await expect((await run(['templates', 'edit', 'fix'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
    await expect((await run(['templates', 'edit', 'fix', '--clear-start-model', '--agent', 'claude', '--model', 'm'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
  })

  it('remove without --yes and without a terminal is exit 6 and removes nothing', async () => {
    const r = await run(['templates', 'remove', 'fix'], { 'templates-remove': text('Removed.') })
    await expect(r.done).rejects.toMatchObject({ exitCode: ERROR_EXIT['needs-confirmation'] })
    expect(r.sent).toEqual([])
    const yes = await ran(['templates', 'remove', 'fix', '--yes'], { 'templates-remove': text('Removed.') })
    expect(yes.sent).toEqual([['templates-remove', { template: 'fix', cwd: '/work' }]])
  })

  it('remove says no and exits 1 when the answer is no', async () => {
    const { sent } = await ran(['templates', 'remove', 'fix'], {}, { confirm: async () => false })
    expect(sent).toEqual([])
    expect(process.exitCode).toBe(1)
  })
})

describe('saved commands', () => {
  it('list, add and remove send the repository and where the command ran', async () => {
    expect((await ran(['commands', '--repo', 'api'], { 'commands-list': text('l') })).sent).toEqual([['commands-list', { repo: 'api', cwd: '/work' }]])
    const add = await ran(['commands', 'add', 'Dev', 'npm run dev', '--start-in', 'web'], { 'commands-add': text('a') })
    expect(add.sent).toEqual([['commands-add', { name: 'Dev', command: 'npm run dev', scope: 'repo', repo: undefined, cwd: '/work', startIn: 'web' }]])
    expect((await ran(['commands', 'add', 'Lint', 'npm run lint', '--all'], { 'commands-add': text('a') })).sent[0][1]).toMatchObject({ scope: 'all' })
    await expect((await run(['commands', 'add', 'x', 'y', '--all', '--repo', 'api'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
    await expect((await run(['commands', 'remove', 'dev'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT['needs-confirmation'] })
    expect((await ran(['commands', 'remove', 'dev', '--yes'], { 'commands-remove': text('r') })).sent).toEqual([['commands-remove', { id: 'dev', repo: undefined, cwd: '/work' }]])
  })

  it('approve shows the text it would approve, asks, then approves exactly that text', async () => {
    const shown = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const asked: string[] = []
    const preview = { command: { id: 'c1', name: 'dev' }, approved: false, needsConfirmation: true, shown: 'npm run dev', text: 'Approving “dev” lets the Run menu type:\n\nnpm run dev' }
    const { sent, out } = await ran(['commands', 'approve', 'dev', 'api-hotfix'], { 'commands-approve': (p: Record<string, unknown>) => (p.shown ? { approved: true, text: 'Approved.' } : preview) }, { confirm: async (q) => (asked.push(q), true) })
    expect(sent).toEqual([
      ['commands-approve', { id: 'dev', workspace: 'api-hotfix', cwd: '/work' }],
      ['commands-approve', { id: 'dev', workspace: 'api-hotfix', cwd: '/work', shown: 'npm run dev' }]
    ])
    expect(shown).toHaveBeenCalledWith(preview.text)
    expect(asked).toEqual(['Approve “dev” on this computer?'])
    expect(out).toEqual(['Approved.'])
    // The workspace defaults to the one the command ran in.
    const dot = await ran(['commands', 'approve', 'dev'], { 'commands-approve': { approved: true, text: 'Already.' } })
    expect(dot.sent[0][1]).toMatchObject({ workspace: '.' })
  })
})

describe('schedules', () => {
  const fingerprint = { template: 't1', setup: 's1', checks: 'c1', mcp: 'm1' }
  const preview = { request: {}, fingerprint, summary: {}, cadence: 'every day at 09:00 (Europe/London)', nextRuns: [], text: 'Schedule “nightly”\nRepository: api' }
  const saved = { saved: true, text: 'Scheduled “nightly” in api.' }
  const line = ['schedules', 'add', 'nightly', '--repo', 'api', '--every', 'daily', '--at', '09:00', '--tz', 'Europe/London', '--max-minutes', '45']

  it('add --yes asks the app for the preview, then saves with the fingerprint it shows', async () => {
    const shown = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const answers = { 'schedules-add': (p: Record<string, unknown>) => (p.shown ? saved : { saved: false, needsConfirmation: true, preview, text: `${preview.text}\n\nNothing is saved yet.` }) }
    const { sent, out } = await ran([...line, '--yes'], answers)
    expect(sent.map(([method]) => method)).toEqual(['schedules-add', 'schedules-add'])
    expect(sent[0][1].shown).toBeUndefined()
    expect(sent[1][1].shown).toEqual(fingerprint)
    expect(sent[0][1]).toMatchObject({ template: 'nightly', repo: 'api', recurrence: 'daily', at: '09:00', tz: 'Europe/London', maxMinutes: 45, cwd: '/work' })
    expect(shown).toHaveBeenCalledWith(preview.text)
    expect(out).toEqual(['Scheduled “nightly” in api.'])
  })

  it('add without --yes and without a terminal prints the preview, exits 6 and saves nothing', async () => {
    const shown = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = await run(line, { 'schedules-add': { saved: false, needsConfirmation: true, preview, text: preview.text } })
    await expect(r.done).rejects.toMatchObject({ exitCode: ERROR_EXIT['needs-confirmation'] })
    expect(r.sent).toHaveLength(1)
    expect(shown).toHaveBeenCalledWith(preview.text)
  })

  it('add says no and saves nothing when the answer is no', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { sent } = await ran(line, { 'schedules-add': { saved: false, needsConfirmation: true, preview, text: preview.text } }, { confirm: async () => false })
    expect(sent).toHaveLength(1)
    expect(process.exitCode).toBe(1)
  })

  it('add takes no template values: the app’s placeholder message comes through, or the command says so', async () => {
    const placeholders = new CliError('“nightly” has placeholders to fill in each time ({{issue}}).', ERROR_EXIT.invalid, 'invalid')
    const withPlaceholders = await run([...line, 'ENG-1'], {
      'schedules-preview': () => {
        throw placeholders
      }
    })
    await expect(withPlaceholders.done).rejects.toBe(placeholders)
    expect(withPlaceholders.sent.map(([m]) => m)).toEqual(['schedules-preview'])
    const none = await run([...line, 'ENG-1'], { 'schedules-preview': preview })
    await expect(none.done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid, message: expect.stringContaining('takes no values') })
    expect(none.sent.map(([m]) => m)).toEqual(['schedules-preview'])
  })

  it('refuses options that do not fit the cadence before sending', async () => {
    for (const bad of [['--every', 'fortnightly'], ['--every', 'daily', '--on', 'mon'], ['--every', 'weekly', '--day-of-month', '3'], ['--max-minutes', 'soon'], ['--day-of-month', '40']]) {
      const r = await run(['schedules', 'add', 'nightly', '--at', '09:00', ...bad], {})
      await expect(r.done, bad.join(' ')).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
      expect(r.sent).toEqual([])
    }
  })

  it('preview sends the same parameters and prints the text; weekly days travel as a list', async () => {
    const { sent, out } = await ran(['schedules', 'preview', 'nightly', '--every', 'weekly', '--on', 'mon,wed', '--at', '08:30'], { 'schedules-preview': preview })
    expect(sent[0][0]).toBe('schedules-preview')
    expect(sent[0][1]).toMatchObject({ template: 'nightly', recurrence: 'weekly', on: ['mon', 'wed'], at: '08:30' })
    expect(out).toEqual([preview.text])
  })

  it('edit sends only the options given and saves with the fingerprint; with nothing to change it errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const answers = { 'schedules-edit': (p: Record<string, unknown>) => (p.shown ? saved : { saved: false, needsConfirmation: true, preview, text: preview.text }) }
    const { sent } = await ran(['schedules', 'edit', '4f2a', '--at', '10:30', '--yes'], answers)
    expect(sent[0][1]).toMatchObject({ id: '4f2a', at: '10:30', cwd: '/work' })
    expect(sent[0][1].recurrence).toBeUndefined()
    expect(sent[1][1].shown).toEqual(fingerprint)
    await expect((await run(['schedules', 'edit', '4f2a'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
  })

  it('approve shows what changed, asks, then approves the fingerprint it showed', async () => {
    const shown = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const first = { approved: false, needsConfirmation: true, changed: ['the setup script'], preview, text: `Since you approved “nightly”, the setup script changed.\n\n${preview.text}\n\nNothing is approved yet. Approve it with the fingerprint above (\`--yes\`).` }
    const asked: string[] = []
    const { sent, out } = await ran(['schedules', 'approve', '4f2a'], { 'schedules-approve': (p: Record<string, unknown>) => (p.shown ? { approved: true, changed: [], text: 'Approved “nightly”.' } : first) }, { confirm: async (q) => (asked.push(q), true) })
    expect(sent).toEqual([
      ['schedules-approve', { id: '4f2a' }],
      ['schedules-approve', { id: '4f2a', shown: fingerprint }]
    ])
    expect(shown).toHaveBeenCalledWith(`Since you approved “nightly”, the setup script changed.\n\n${preview.text}`)
    expect(asked).toEqual(['Approve this schedule?'])
    expect(out).toEqual(['Approved “nightly”.'])
  })

  it('approve in a script without --yes exits 6 having approved nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = await run(['schedules', 'approve', '4f2a'], { 'schedules-approve': { approved: false, needsConfirmation: true, changed: [], preview, text: preview.text } })
    await expect(r.done).rejects.toMatchObject({ exitCode: ERROR_EXIT['needs-confirmation'] })
    expect(r.sent).toHaveLength(1)
  })

  it('pause, resume, runs and stop-run send their ids; remove asks first', async () => {
    expect((await ran(['schedules', 'pause', '4f2a'], { 'schedules-pause': text('p') })).sent).toEqual([['schedules-pause', { id: '4f2a' }]])
    expect((await ran(['schedules', 'resume', '4f2a'], { 'schedules-resume': text('p') })).sent).toEqual([['schedules-resume', { id: '4f2a' }]])
    expect((await ran(['schedules', 'runs'], { 'schedules-runs': text('r') })).sent).toEqual([['schedules-runs', { id: undefined }]])
    expect((await ran(['schedules', 'runs', 'nightly'], { 'schedules-runs': text('r') })).sent).toEqual([['schedules-runs', { id: 'nightly' }]])
    expect((await ran(['schedules', 'stop-run', '9c1d'], { 'schedules-stop-run': text('s') })).sent).toEqual([['schedules-stop-run', { occurrence: '9c1d' }]])
    expect((await ran(['schedules'], { 'schedules-list': text('l') })).sent[0][0]).toBe('schedules-list')
    await expect((await run(['schedules', 'remove', '4f2a'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT['needs-confirmation'] })
    expect((await ran(['schedules', 'remove', '4f2a', '--yes'], { 'schedules-remove': text('r') })).sent).toEqual([['schedules-remove', { id: '4f2a' }]])
  })
})

describe('connections', () => {
  it('add vercel without --team-id or --project-id errors before reading a token or sending anything', async () => {
    const read = vi.spyOn(io, 'readStdin').mockResolvedValue('tok')
    vi.spyOn(io, 'stdinIsTTY').mockReturnValue(false)
    const r = await run(['connections', 'add', 'vercel', '--token-stdin', '--project-id', 'prj_1'], {})
    await expect(r.done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid, message: expect.stringContaining('--team-id') })
    expect(r.sent).toEqual([])
    expect(read).not.toHaveBeenCalled()
    const both = await run(['connections', 'add', 'vercel', '--token-stdin'], {})
    await expect(both.done).rejects.toThrow(/--team-id and --project-id/)
  })

  it('add refuses options the service does not take, and a token where there is none', async () => {
    vi.spyOn(io, 'stdinIsTTY').mockReturnValue(false)
    for (const line of [['connections', 'add', 'github', '--team-id', 't', '--gh-active'], ['connections', 'add', 'docker', '--token-stdin'], ['connections', 'add', 'slack', '--gh-active'], ['connections', 'add', 'github', '--gh-active', '--gh-account', 'octocat'], ['connections', 'add', 'github', '--gh-active', '--token-stdin'], ['connections', 'add', 'nope']]) {
      const r = await run(line, {})
      await expect(r.done, line.join(' ')).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
      expect(r.sent, line.join(' ')).toEqual([])
    }
  })

  it('add without a terminal and without --token-stdin tells you to pipe the token in', async () => {
    vi.spyOn(io, 'stdinIsTTY').mockReturnValue(false)
    const r = await run(['connections', 'add', 'linear'], {})
    await expect(r.done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid, message: expect.stringContaining('--token-stdin') })
    expect(r.sent).toEqual([])
  })

  it('add reads the token from standard input, sends it as a parameter only, and never prints it', async () => {
    vi.spyOn(io, 'stdinIsTTY').mockReturnValue(false)
    vi.spyOn(io, 'readStdin').mockResolvedValue('lin_api_SECRET\n')
    const printed = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const argv = ['connections', 'add', 'linear', '--token-stdin', '--label', 'Acme', '--default', '--agent-access', 'write']
    const { sent, out } = await ran(argv, { 'connections-add': text('Added the linear connection “Acme”, signed in as me@acme.') })
    expect(sent).toHaveLength(1)
    expect(sent[0][1]).toMatchObject({ service: 'linear', name: 'Acme', token: 'lin_api_SECRET', setDefault: true, agentAccess: 'write' })
    expect(argv.join(' ')).not.toContain('SECRET')
    for (const shown of [out.join('\n'), printed.mock.calls.join('\n'), errors.mock.calls.join('\n')]) expect(shown).not.toContain('SECRET')
    // Under --json the answer is the app's, which never carries the token.
    const json = await ran([...argv, '--json'], { 'connections-add': { connection: { id: 'c1', hint: 'CRET' }, text: 'ok' } })
    expect(json.out.join('')).not.toContain('SECRET')
  })

  it('add sends provider fields and the gh account without a token', async () => {
    vi.spyOn(io, 'stdinIsTTY').mockReturnValue(false)
    vi.spyOn(io, 'readStdin').mockResolvedValue('vercel-token')
    const vercel = await ran(['connections', 'add', 'vercel', '--token-stdin', '--team-id', 'team_1', '--project-id', 'prj_2'], { 'connections-add': text('ok') })
    expect(vercel.sent[0][1]).toMatchObject({ service: 'vercel', vercel: { teamId: 'team_1', projectId: 'prj_2' }, token: 'vercel-token' })
    const gh = await ran(['connections', 'add', 'github', '--gh-account', 'octocat', '--label', 'Work'], { 'connections-add': text('ok') })
    expect(gh.sent[0][1]).toMatchObject({ service: 'github', ghAccount: 'octocat', name: 'Work' })
    expect('token' in gh.sent[0][1]).toBe(false)
    const docker = await ran(['connections', 'add', 'docker', '--context', 'colima'], { 'connections-add': text('ok') })
    expect(docker.sent[0][1]).toMatchObject({ service: 'docker', docker: { context: 'colima' } })
    expect('token' in docker.sent[0][1]).toBe(false)
    // Daytona's API URL has a default, so it is not required; its token is.
    const daytona = await ran(['connections', 'add', 'daytona', '--token-stdin'], { 'connections-add': text('ok') })
    expect(daytona.sent[0][1]).toMatchObject({ service: 'daytona', daytona: {}, token: 'vercel-token' })
  })

  it('remove prints what it affects, asks, then removes with confirmed', async () => {
    const shown = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const impact = { repos: ['api'], isDefault: true, rules: 1 }
    const preview = { removed: false, needsConfirmation: true, impact, text: 'Removing “Acme” (slack): 1 repository uses it.' }
    const asked: string[] = []
    const { sent, out } = await ran(['connections', 'remove', 'acme'], { 'connections-remove': (p: Record<string, unknown>) => (p.confirmed ? { removed: true, impact, text: 'Removed the slack connection “Acme”.' } : preview) }, { confirm: async (q) => (asked.push(q), true) })
    expect(sent).toEqual([
      ['connections-remove', { id: 'acme' }],
      ['connections-remove', { id: 'acme', confirmed: true }]
    ])
    expect(shown).toHaveBeenCalledWith(preview.text)
    expect(asked).toEqual(['Remove the connection “acme”?'])
    expect(out).toEqual(['Removed the slack connection “Acme”.'])
  })

  it('remove in a script without --yes prints the impact and exits 6; no removes nothing', async () => {
    const shown = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const answers = { 'connections-remove': { removed: false, needsConfirmation: true, impact: {}, text: 'Removing it affects nothing else.' } }
    const r = await run(['connections', 'remove', 'acme'], answers)
    await expect(r.done).rejects.toMatchObject({ exitCode: ERROR_EXIT['needs-confirmation'] })
    expect(r.sent).toHaveLength(1)
    expect(shown).toHaveBeenCalledWith('Removing it affects nothing else.')
    const no = await ran(['connections', 'remove', 'acme'], answers, { confirm: async () => false })
    expect(no.sent).toHaveLength(1)
    expect(process.exitCode).toBe(1)
  })

  it('check, default and apply send their words; a failed check exits 1', async () => {
    expect((await ran(['connections', 'check', 'work'], { 'connections-check': { ok: true, text: 'works' } })).sent).toEqual([['connections-check', { id: 'work' }]])
    expect(process.exitCode).toBeUndefined()
    await ran(['connections', 'check', 'work'], { 'connections-check': { ok: false, text: 'problem' } })
    expect(process.exitCode).toBe(1)
    expect((await ran(['connections', 'default', 'slack', 'none'], { 'connections-default': text('d') })).sent).toEqual([['connections-default', { service: 'slack', id: 'none' }]])
    expect((await ran(['connections', 'apply', 'work', '--repos', 'api, web', '--replace'], { 'connections-apply': text('a') })).sent).toEqual([['connections-apply', { id: 'work', repos: ['api', 'web'], replace: true, cwd: '/work' }]])
    await expect((await run(['connections', 'apply', 'work'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
    expect((await ran(['connections'], { 'connections-list': text('l') })).sent[0][0]).toBe('connections-list')
  })
})

describe('slack and linear', () => {
  it('rules list, add, remove and consent send the verb and what the rule needs', async () => {
    expect((await ran(['slack', 'rules'], { 'slack-rules': text('l') })).sent).toEqual([['slack-rules', { verb: 'list' }]])
    const add = await ran(['slack', 'rules', 'add', '--event', 'pr-ready', '--recipient', 'channel', '--channel', 'eng', '--repos', 'api,web', '--away-only'], { 'slack-rules': text('a') })
    expect(add.sent[0][1]).toMatchObject({ verb: 'add', event: 'pr-ready', recipient: 'channel', channel: 'eng', repos: ['api', 'web'], awayOnly: true, cwd: '/work' })
    expect((await ran(['slack', 'rules', 'remove', '3fa9'], { 'slack-rules': text('r') })).sent).toEqual([['slack-rules', { verb: 'remove', id: '3fa9' }]])
    for (const line of [['slack', 'rules', 'add'], ['slack', 'rules', 'add', '--event', 'party'], ['slack', 'rules', 'remove'], ['slack', 'rules', 'list', '--event', 'pr-ready'], ['slack', 'rules', 'explode']]) {
      const r = await run(line, {})
      await expect(r.done, line.join(' ')).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
      expect(r.sent, line.join(' ')).toEqual([])
    }
  })

  it('rules consent shows what would go out, asks, then confirms', async () => {
    const shown = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { sent } = await ran(['slack', 'rules', 'consent', '3fa9'], { 'slack-rules': (p: Record<string, unknown>) => (p.confirmed ? text('The rule now sends without asking.') : { needsConfirmation: true, text: 'Consenting lets Foreman send …' }) }, { confirm: async () => true })
    expect(sent).toEqual([
      ['slack-rules', { verb: 'consent', id: '3fa9' }],
      ['slack-rules', { verb: 'consent', id: '3fa9', confirmed: true }]
    ])
    expect(shown).toHaveBeenCalledWith('Consenting lets Foreman send …')
  })

  it('people, deliveries, answer, resend and linear issues send their words', async () => {
    expect((await ran(['slack', 'people'], { 'slack-people': text('p') })).sent[0][1]).toMatchObject({ verb: 'list' })
    expect((await ran(['slack', 'people', 'link', 'octocat', 'U012', '--team', 'T1', '--name', 'Octo'], { 'slack-people': text('p') })).sent[0][1]).toEqual({ verb: 'link', githubLogin: 'octocat', slackId: 'U012', teamId: 'T1', name: 'Octo' })
    expect((await ran(['slack', 'people', 'unlink', 'octocat', '--team', 'T1'], { 'slack-people': text('p') })).sent[0][1]).toMatchObject({ verb: 'unlink', githubLogin: 'octocat', teamId: 'T1' })
    await expect((await run(['slack', 'people', 'link', 'octocat'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
    expect((await ran(['slack', 'deliveries', '--connection', 'acme'], { 'slack-deliveries': text('d') })).sent).toEqual([['slack-deliveries', { connection: 'acme' }]])
    expect((await ran(['slack', 'answer', '7be1', 'send', '--text', 'Hello'], { 'slack-answer': text('a') })).sent).toEqual([['slack-answer', { id: '7be1', action: 'send', text: 'Hello' }]])
    await expect((await run(['slack', 'answer', '7be1', 'skip', '--text', 'x'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
    expect((await ran(['slack', 'resend', '7be1'], { 'slack-resend': text('r') })).sent).toEqual([['slack-resend', { id: '7be1' }]])
    expect((await ran(['linear', 'issues', '--repo', 'api'], { 'linear-issues': text('i') })).sent).toEqual([['linear-issues', { repo: 'api', cwd: '/work' }]])
  })
})

describe('backup, git-backup, data and usage', () => {
  it('backup defaults to status and now backs up', async () => {
    expect((await ran(['backup'], { 'backup-status': text('s') })).sent[0][0]).toBe('backup-status')
    expect((await ran(['backup', 'now'], { 'backup-now': text('n') })).sent[0][0]).toBe('backup-now')
    await expect((await run(['backup', 'later'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
  })

  it('git-backup status, configure, create-repo, now and preview send the remote and account', async () => {
    expect((await ran(['git-backup'], { 'git-backup-status': text('s') })).sent[0][0]).toBe('git-backup-status')
    expect((await ran(['git-backup', 'configure', 'git@github.com:me/b.git', '--account', 'me', '--daily'], { 'git-backup-configure': text('c') })).sent).toEqual([['git-backup-configure', { remote: 'git@github.com:me/b.git', account: 'me', daily: true }]])
    expect((await ran(['git-backup', 'configure', 'git@github.com:me/b.git', '--no-daily'], { 'git-backup-configure': text('c') })).sent[0][1].daily).toBe(false)
    expect((await ran(['git-backup', 'configure', 'git@github.com:me/b.git'], { 'git-backup-configure': text('c') })).sent[0][1].daily).toBeUndefined()
    expect((await ran(['git-backup', 'create-repo', 'foreman-backup'], { 'git-backup-create-repo': text('c') })).sent).toEqual([['git-backup-create-repo', { name: 'foreman-backup', account: undefined }]])
    expect((await ran(['git-backup', 'now'], { 'git-backup-now': text('n') })).sent[0][0]).toBe('git-backup-now')
    expect((await ran(['git-backup', 'preview', 'remote', '--account', 'me'], { 'git-backup-preview': text('p') })).sent).toEqual([['git-backup-preview', { remote: 'remote', account: 'me' }]])
    for (const line of [['git-backup', 'configure'], ['git-backup', 'status', '--daily'], ['git-backup', 'preview', 'r', '--categories', 'settings'], ['git-backup', 'configure', 'r', '--daily', '--no-daily'], ['git-backup', 'now', 'extra']]) {
      const r = await run(line, {})
      await expect(r.done, line.join(' ')).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
      expect(r.sent, line.join(' ')).toEqual([])
    }
  })

  it('git-backup restore shows the preview, asks, then restores that preview by its stage id', async () => {
    const shown = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const preview = { restored: false, needsConfirmation: true, preview: { stageId: 'stage-9' }, text: 'Backup made …\n\nNothing is restored yet.' }
    const { sent, out } = await ran(['git-backup', 'restore', 'remote', '--categories', 'settings,templates'], { 'git-backup-restore': (p: Record<string, unknown>) => (p.confirmed ? { restored: true, text: 'Restored 3 settings.' } : preview) }, { confirm: async () => true })
    expect(sent).toEqual([
      ['git-backup-restore', { remote: 'remote', account: undefined, categories: ['settings', 'templates'] }],
      ['git-backup-restore', { remote: 'remote', account: undefined, categories: ['settings', 'templates'], stageId: 'stage-9', confirmed: true }]
    ])
    expect(shown).toHaveBeenCalledWith(preview.text)
    expect(out).toEqual(['Restored 3 settings.'])
  })

  it('git-backup restore in a script without --yes exits 6 having restored nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = await run(['git-backup', 'restore', 'remote'], { 'git-backup-restore': { restored: false, needsConfirmation: true, preview: { stageId: 's' }, text: 'preview' } })
    await expect(r.done).rejects.toMatchObject({ exitCode: ERROR_EXIT['needs-confirmation'] })
    expect(r.sent).toHaveLength(1)
  })

  it('data prints the info, and delete-legacy says how much it deletes before asking', async () => {
    expect((await ran(['data'], { 'data-info': text('i') })).sent[0][0]).toBe('data-info')
    const asked: string[] = []
    const info = { legacy: { files: 3, bytes: 5 * 1024 * 1024 }, text: 'i' }
    const { sent } = await ran(['data', 'delete-legacy'], { 'data-info': info, 'data-delete-legacy': text('Deleted 3 files.') }, { confirm: async (q) => (asked.push(q), true) })
    expect(sent.map(([m]) => m)).toEqual(['data-info', 'data-delete-legacy'])
    expect(asked[0]).toContain('3 files')
    expect(asked[0]).toContain('5.0 MB')
    const script = await run(['data', 'delete-legacy'], { 'data-info': info, 'data-delete-legacy': text('Deleted.') })
    await expect(script.done).rejects.toMatchObject({ exitCode: ERROR_EXIT['needs-confirmation'] })
    expect(script.sent.map(([m]) => m)).toEqual(['data-info'])
    // Nothing left over: nothing to ask about.
    const none = await ran(['data', 'delete-legacy'], { 'data-info': { legacy: { files: 0, bytes: 0 }, text: 'i' }, 'data-delete-legacy': text('Nothing to delete.') })
    expect(none.out).toEqual(['Nothing to delete.'])
  })

  it('usage --days 30 sends days as a number', async () => {
    expect((await ran(['usage', '--days', '30'], { usage: text('u') })).sent).toEqual([['usage', { days: 30 }]])
    expect((await ran(['usage'], { usage: text('u') })).sent).toEqual([['usage', { days: undefined }]])
    await expect((await run(['usage', '--days', 'week'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
    await expect((await run(['usage', '--days', '4000'], {})).done).rejects.toMatchObject({ exitCode: ERROR_EXIT.invalid })
  })

  it('prints JSON for --json', async () => {
    const result = { days: 7, text: 'The last 7 days' }
    const { out } = await ran(['usage', '--days', '7', '--json'], { usage: result })
    expect(JSON.parse(out[0])).toEqual(result)
  })
})
