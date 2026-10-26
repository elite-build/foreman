import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../src/cli/client'
import type { Context } from '../src/cli/command'
import { envRunners, parseEnvFile } from '../src/cli/commands/env'
import { io } from '../src/cli/commands/input'
import { repoRunners } from '../src/cli/commands/repo'
import { settingsRunners } from '../src/cli/commands/settings'
import { renderCommandHelp, renderTopic } from '../src/cli/help'
import { confirm, print } from '../src/cli/output'
import { parseCommandArgs } from '../src/cli/registry'
import '../src/cli/topics/settingsKeys'
import { COMMANDS, commandName, findCommand, type CommandSpec } from '../src/shared/cliCommands'
import { ENV_COMMANDS, REPO_SETTINGS_COMMANDS, SETTINGS_COMMANDS } from '../src/shared/cliCommandsSettings'

const MINE: CommandSpec[] = [...SETTINGS_COMMANDS, ...ENV_COMMANDS, ...REPO_SETTINGS_COMMANDS]
const RUNNERS: Record<string, (ctx: Context) => Promise<void>> = { ...settingsRunners, ...repoRunners, ...envRunners }

interface Sent {
  method: string
  params: unknown
}

type Canned = Record<string, unknown | ((params: Record<string, unknown>) => unknown)>

/** A context whose requests are recorded and answered from `canned`; confirm() is the real one with no terminal to ask on. */
function fake(args: string[], opts: Record<string, unknown> = {}, canned: Canned = {}) {
  const sent: Sent[] = []
  const yes = opts.yes === true
  const ctx: Context = {
    args,
    opts,
    json: opts.json === true,
    quiet: false,
    yes,
    cwd: 'C:\\work\\repo',
    async send<T>(method: string, params?: unknown) {
      sent.push({ method, params })
      if (!(method in canned)) throw new Error(`unexpected request ${method}`)
      const answer = canned[method]
      return (typeof answer === 'function' ? answer((params ?? {}) as Record<string, unknown>) : answer) as T
    },
    print: (value, text) => print(value, text, opts.json === true),
    confirm: (question) => confirm(question, { yes, interactive: false }),
    note: (text) => console.error(text),
    progress: () => undefined
  }
  return { ctx, sent }
}

const result = (text: string, extra: Record<string, unknown> = {}) => ({ text, ...extra })

let out: string[]
let err: string[]

beforeEach(() => {
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')))
  vi.spyOn(io, 'stdinIsTTY').mockReturnValue(false)
  vi.spyOn(io, 'stdoutIsTTY').mockReturnValue(false)
})

afterEach(() => vi.restoreAllMocks())

const rejection = async (run: Promise<unknown>): Promise<CliError> => {
  try {
    await run
  } catch (e) {
    expect(e).toBeInstanceOf(CliError)
    return e as CliError
  }
  throw new Error('expected a CliError')
}

describe('foreman settings', () => {
  it('sends every key and value pair of settings set in one request, with the caller’s folder', async () => {
    const { ctx, sent } = fake(['appearance.theme', 'dark', 'git.branch-prefix', 'yatin/'], {}, { 'settings-set': result('done') })
    await settingsRunners['settings set'](ctx)
    expect(sent).toEqual([{ method: 'settings-set', params: { pairs: [['appearance.theme', 'dark'], ['git.branch-prefix', 'yatin/']], cwd: 'C:\\work\\repo' } }])
    expect(out).toEqual(['done'])
  })

  it('refuses a key with no value, naming it', async () => {
    const { ctx, sent } = fake(['appearance.theme', 'dark', 'git.branch-prefix'])
    const e = await rejection(settingsRunners['settings set'](ctx))
    expect(e.exitCode).toBe(2)
    expect(e.message).toContain('git.branch-prefix has no value')
    expect(sent).toEqual([])
  })

  it('changes a list with --add and --remove by reading the current list first, and sends the whole list', async () => {
    const canned = { 'settings-export': result('{}', { settings: { 'environment.env-files': ['.env', '.env.old'] } }), 'settings-set': result('ok') }
    const add = fake(['environment.env-files'], { add: ['.env.local'] }, canned)
    await settingsRunners['settings set'](add.ctx)
    expect(add.sent.map((s) => s.method)).toEqual(['settings-export', 'settings-set'])
    expect(add.sent[1].params).toMatchObject({ pairs: [['environment.env-files', '.env,.env.old,.env.local']] })
    const remove = fake(['environment.env-files'], { remove: ['.env.old'], add: ['a,b'] }, canned)
    await settingsRunners['settings set'](remove.ctx)
    expect(remove.sent[1].params).toMatchObject({ pairs: [['environment.env-files', '.env,a,b']] })
  })

  it('refuses --add on a setting that is not a list', async () => {
    const { ctx, sent } = fake(['appearance.theme'], { add: ['dark'] })
    const e = await rejection(settingsRunners['settings set'](ctx))
    expect(e.exitCode).toBe(2)
    expect(e.message).toContain('isn’t a list')
    expect(sent).toEqual([])
  })

  it('reads a list from standard input one item per line, and a text setting whole', async () => {
    vi.spyOn(io, 'readStdin').mockResolvedValueOnce('.env\r\n\n.env.local\n')
    const list = fake(['environment.env-files'], { stdin: true }, { 'settings-set': result('ok') })
    await settingsRunners['settings set'](list.ctx)
    expect(list.sent[0].params).toMatchObject({ pairs: [['environment.env-files', '.env,.env.local']] })
    vi.spyOn(io, 'readStdin').mockResolvedValueOnce('yatin/\n')
    const text = fake(['git.branch-prefix'], { stdin: true }, { 'settings-set': result('ok') })
    await settingsRunners['settings set'](text.ctx)
    expect(text.sent[0].params).toMatchObject({ pairs: [['git.branch-prefix', 'yatin/']] })
  })

  it('needs confirmation for reset --all: no --yes and no terminal is exit 6 and sends nothing; --yes sends', async () => {
    const refused = fake([], { all: true }, { 'settings-reset': result('reset') })
    const e = await rejection(settingsRunners['settings reset'](refused.ctx))
    expect(e.exitCode).toBe(6)
    expect(e.code).toBe('needs-confirmation')
    expect(refused.sent).toEqual([])
    const yes = fake([], { all: true, yes: true }, { 'settings-reset': result('reset') })
    await settingsRunners['settings reset'](yes.ctx)
    expect(yes.sent).toEqual([{ method: 'settings-reset', params: { all: true } }])
  })

  it('resets named keys without asking, and refuses keys together with --all or neither', async () => {
    const named = fake(['appearance.theme', 'git.branch-prefix'], {}, { 'settings-reset': result('reset') })
    await settingsRunners['settings reset'](named.ctx)
    expect(named.sent).toEqual([{ method: 'settings-reset', params: { keys: ['appearance.theme', 'git.branch-prefix'] } }])
    expect((await rejection(settingsRunners['settings reset'](fake(['x'], { all: true }).ctx))).exitCode).toBe(2)
    expect((await rejection(settingsRunners['settings reset'](fake([]).ctx))).exitCode).toBe(2)
  })

  it('passes list --page and --changed, search words, path --open, and get keys', async () => {
    const list = fake([], { page: 'git', changed: true }, { 'settings-list': result('rows') })
    await settingsRunners['settings list'](list.ctx)
    expect(list.sent[0].params).toEqual({ page: 'git', changed: true })
    const search = fake(['dark', 'mode'], {}, { 'settings-search': result('hits') })
    await settingsRunners['settings search'](search.ctx)
    expect(search.sent[0].params).toEqual({ query: 'dark mode' })
    const path = fake(['appearance.theme'], { open: true }, { 'settings-path': result('Settings › Appearance › Theme') })
    await settingsRunners['settings path'](path.ctx)
    expect(path.sent[0].params).toEqual({ key: 'appearance.theme', open: true })
    const get = fake(['a.b', 'c.d'], {}, { 'settings-get': result('values') })
    await settingsRunners['settings get'](get.ctx)
    expect(get.sent[0].params).toEqual({ keys: ['a.b', 'c.d'] })
  })

  it('prints the JSON without its text field for --json', async () => {
    const { ctx } = fake([], { json: true }, { 'settings-keys': result('table', { keys: [{ key: 'appearance.theme' }] }) })
    await settingsRunners['settings keys'](ctx)
    expect(JSON.parse(out[0])).toEqual({ keys: [{ key: 'appearance.theme' }] })
  })

  it('exports to standard output as JSON, or to a file', async () => {
    const canned = { 'settings-export': result('{}', { settings: { 'appearance.theme': 'dark' } }) }
    await settingsRunners['settings export'](fake([], {}, canned).ctx)
    expect(JSON.parse(out[0])).toEqual({ 'appearance.theme': 'dark' })
    const write = vi.spyOn(io, 'writeFile').mockResolvedValue(undefined)
    await settingsRunners['settings export'](fake([], { out: 'settings.json' }, canned).ctx)
    expect(write).toHaveBeenCalledWith('settings.json', 'C:\\work\\repo', `${JSON.stringify({ 'appearance.theme': 'dark' }, null, 2)}\n`)
    expect(out[1]).toBe('Wrote 1 settings to settings.json')
  })

  it('imports by previewing the diff, asking, then applying', async () => {
    vi.spyOn(io, 'readFile').mockResolvedValue(JSON.stringify({ 'appearance.theme': 'dark' }))
    const rows = [{ key: 'appearance.theme', from: 'system', to: 'dark' }]
    const canned = { 'settings-import': (p: Record<string, unknown>) => (p.dryRun ? result('Would change 1 setting', { rows }) : result('Changed 1 setting', { rows, applied: true })) }
    const refused = fake(['s.json'], {}, canned)
    expect((await rejection(settingsRunners['settings import'](refused.ctx))).exitCode).toBe(6)
    expect(refused.sent).toHaveLength(1)
    expect(refused.sent[0].params).toMatchObject({ dryRun: true, values: { 'appearance.theme': 'dark' } })
    const yes = fake(['s.json'], { yes: true }, canned)
    await settingsRunners['settings import'](yes.ctx)
    expect(yes.sent.map((s) => (s.params as { dryRun?: boolean }).dryRun)).toEqual([true, undefined])
    expect(out).toContain('Would change 1 setting')
    expect(out).toContain('Changed 1 setting')
  })

  it('says a file that is not JSON is a usage error', async () => {
    vi.spyOn(io, 'readFile').mockResolvedValue('nope')
    expect((await rejection(settingsRunners['settings import'](fake(['s.json']).ctx))).exitCode).toBe(2)
  })

  it('prints its own help with no verb, and refuses an unknown one', async () => {
    await settingsRunners.settings(fake([]).ctx)
    expect(out.join('\n')).toContain('settings set')
    expect(out.join('\n')).toContain('settings import')
    const e = await rejection(settingsRunners.settings(fake(['config']).ctx))
    expect(e.exitCode).toBe(2)
  })
})

describe('foreman repo settings', () => {
  it('sends the repository and the caller’s folder with every request', async () => {
    const list = fake([], { repo: 'api', shared: true }, { 'repo-settings-list': result('rows') })
    await repoRunners['repo settings list'](list.ctx)
    expect(list.sent[0]).toEqual({ method: 'repo-settings-list', params: { repo: 'api', cwd: 'C:\\work\\repo', shared: true } })
    const set = fake(['scripts.checks-after-turn', 'on'], { repo: 'foreman' }, { 'repo-settings-set': result('ok') })
    await repoRunners['repo settings set'](set.ctx)
    expect(set.sent[0]).toEqual({ method: 'repo-settings-set', params: { repo: 'foreman', cwd: 'C:\\work\\repo', pairs: [['scripts.checks-after-turn', 'on']] } })
  })

  it('reads a text setting from --file and sends the text as it is', async () => {
    const read = vi.spyOn(io, 'readFile').mockResolvedValue('Be brief.\n\nUse tests.\n')
    const { ctx, sent } = fake(['actions.prompt-general'], { file: 'prompt.md' }, { 'repo-settings-set': result('ok') })
    await repoRunners['repo settings set'](ctx)
    expect(read).toHaveBeenCalledWith('prompt.md', 'C:\\work\\repo')
    expect((sent[0].params as { pairs: unknown }).pairs).toEqual([['actions.prompt-general', 'Be brief.\n\nUse tests.\n']])
  })

  it('reads a text setting from standard input, and a list one item per line', async () => {
    vi.spyOn(io, 'readStdin').mockResolvedValueOnce('npm ci\n')
    const text = fake(['cloud.install-script'], { stdin: true }, { 'repo-settings-set': result('ok') })
    await repoRunners['repo settings set'](text.ctx)
    expect((text.sent[0].params as { pairs: unknown }).pairs).toEqual([['cloud.install-script', 'npm ci\n']])
    vi.spyOn(io, 'readStdin').mockResolvedValueOnce('secrets/\n.env\n')
    const list = fake(['git.sensitive-paths'], { stdin: true }, { 'repo-settings-set': result('ok') })
    await repoRunners['repo settings set'](list.ctx)
    expect((list.sent[0].params as { pairs: unknown }).pairs).toEqual([['git.sensitive-paths', 'secrets/,.env']])
  })

  it('turns an image file into the icon’s data URL', async () => {
    vi.spyOn(io, 'readBytes').mockResolvedValue(Buffer.from('PNGDATA'))
    const { ctx, sent } = fake(['repo.icon'], { file: 'logo.png' }, { 'repo-settings-set': result('ok') })
    await repoRunners['repo settings set'](ctx)
    expect((sent[0].params as { pairs: unknown }).pairs).toEqual([['repo.icon', `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`]])
    const bad = fake(['repo.icon'], { file: 'logo.txt' })
    expect((await rejection(repoRunners['repo settings set'](bad.ctx))).exitCode).toBe(2)
  })

  it('adds to and removes from a list by reading its printed value', async () => {
    const canned = { 'repo-settings-get': result('', { rows: [{ key: 'git.sensitive-paths', value: 'secrets/, .env' }] }), 'repo-settings-set': result('ok') }
    const { ctx, sent } = fake(['git.sensitive-paths'], { add: ['keys/'], remove: ['.env'] }, canned)
    await repoRunners['repo settings set'](ctx)
    expect(sent.map((s) => s.method)).toEqual(['repo-settings-get', 'repo-settings-set'])
    expect((sent[1].params as { pairs: unknown }).pairs).toEqual([['git.sensitive-paths', 'secrets/,keys/']])
    const none = fake(['git.sensitive-paths'], { add: ['x'] }, { ...canned, 'repo-settings-get': result('', { rows: [{ key: 'git.sensitive-paths', value: '(none)' }] }) })
    await repoRunners['repo settings set'](none.ctx)
    expect((none.sent[1].params as { pairs: unknown }).pairs).toEqual([['git.sensitive-paths', 'x']])
  })

  it('refuses two value sources at once', async () => {
    const { ctx, sent } = fake(['actions.prompt-general'], { file: 'a.md', stdin: true })
    expect((await rejection(repoRunners['repo settings set'](ctx))).exitCode).toBe(2)
    expect(sent).toEqual([])
  })

  it('unsets by sending the keys, and refuses none', async () => {
    const { ctx, sent } = fake(['scripts.checks-after-turn', 'actions.prompt-general'], { repo: 'api' }, { 'repo-settings-unset': result('ok') })
    await repoRunners['repo settings unset'](ctx)
    expect(sent[0]).toEqual({ method: 'repo-settings-unset', params: { repo: 'api', cwd: 'C:\\work\\repo', keys: ['scripts.checks-after-turn', 'actions.prompt-general'] } })
    expect((await rejection(repoRunners['repo settings unset'](fake([]).ctx))).exitCode).toBe(2)
  })

  it('asks the file method to open the committed file with --open', async () => {
    const { ctx, sent } = fake([], { open: true }, { 'repo-settings-file': result('path') })
    await repoRunners['repo settings file'](ctx)
    expect(sent[0].params).toMatchObject({ open: true })
  })

  it('lists steps through the read twin, and edits through the write method', async () => {
    const list = fake([], {}, { 'repo-setup-list': result('steps') })
    await repoRunners['repo setup'](list.ctx)
    expect(list.sent[0]).toEqual({ method: 'repo-setup-list', params: { repo: undefined, cwd: 'C:\\work\\repo', target: 'setup' } })
    const add = fake(['add', 'install', 'npm', 'ci'], { timeout: '600', parallel: true, at: '2' }, { 'repo-setup': result('added') })
    await repoRunners['repo setup'](add.ctx)
    expect(add.sent[0].params).toMatchObject({ target: 'setup', verb: 'add', name: 'install', command: 'npm ci', timeoutSec: 600, parallel: true, at: 2 })
    const archive = fake(['move', '3', '1'], {}, { 'repo-setup': result('moved') })
    await repoRunners['repo archive-steps'](archive.ctx)
    expect(archive.sent[0].params).toMatchObject({ target: 'archive', verb: 'move', from: 3, to: 1 })
    const remove = fake(['remove', '2'], {}, { 'repo-setup': result('removed') })
    await repoRunners['repo setup'](remove.ctx)
    expect(remove.sent[0].params).toMatchObject({ verb: 'remove', name: '2' })
  })

  it('asks before clearing or inheriting steps', async () => {
    for (const verb of ['clear', 'inherit']) {
      const refused = fake([verb], {}, { 'repo-setup': result('ok') })
      expect((await rejection(repoRunners['repo setup'](refused.ctx))).exitCode).toBe(6)
      expect(refused.sent).toEqual([])
      const yes = fake([verb], { yes: true }, { 'repo-setup': result('ok') })
      await repoRunners['repo setup'](yes.ctx)
      expect(yes.sent[0].params).toMatchObject({ verb, target: 'setup' })
    }
  })

  it('sends scripts and checks with their options', async () => {
    const add = fake(['add', 'dev', 'npm', 'run', 'dev'], { default: true, hidden: true, icon: 'play', 'preview-url': 'http://localhost:3000' }, { 'repo-scripts': result('ok') })
    await repoRunners['repo scripts'](add.ctx)
    expect(add.sent[0].params).toMatchObject({ verb: 'add', name: 'dev', command: 'npm run dev', default: true, hidden: true, icon: 'play', previewUrl: 'http://localhost:3000' })
    const def = fake(['set-default', 'dev'], {}, { 'repo-scripts': result('ok') })
    await repoRunners['repo scripts'](def.ctx)
    expect(def.sent[0].params).toMatchObject({ verb: 'set-default', name: 'dev' })
    const list = fake([], {}, { 'repo-scripts-list': result('scripts'), 'repo-checks-list': result('checks') })
    await repoRunners['repo scripts'](list.ctx)
    await repoRunners['repo checks'](fake([], {}, { 'repo-checks-list': result('checks') }).ctx)
    expect(list.sent[0].method).toBe('repo-scripts-list')
    const check = fake(['add', 'test', 'npm', 'test'], {}, { 'repo-checks': result('ok') })
    await repoRunners['repo checks'](check.ctx)
    expect(check.sent[0].params).toMatchObject({ verb: 'add', name: 'test', command: 'npm test' })
  })

  describe('checks approve', () => {
    const items = [
      { name: 'test', command: 'npm test', hash: 'h1', source: 'shared', approved: false },
      { name: 'lint', command: 'npm run lint', hash: 'h2', source: 'local', approved: true }
    ]
    const canned = { 'checks-list': result('Checks for api:\n  test  h1  needs approval', { workspace: { id: 'w', name: 'api' }, items }), 'checks-approve': result('Approved 2 commands and started the checks in api.', { started: true }) }

    it('lists first, then sends the hashes it showed once confirmed', async () => {
      const { ctx, sent } = fake(['api'], { yes: true }, canned)
      await repoRunners['checks approve'](ctx)
      expect(sent.map((s) => s.method)).toEqual(['checks-list', 'checks-approve'])
      expect(sent[0].params).toEqual({ cwd: 'C:\\work\\repo', workspace: 'api' })
      expect(sent[1].params).toEqual({ cwd: 'C:\\work\\repo', workspace: 'api', hashes: ['h1', 'h2'] })
      expect(out[0]).toContain('Checks for api')
    })

    it('does not approve without --yes when there is no terminal (exit 6)', async () => {
      const { ctx, sent } = fake([], {}, canned)
      expect((await rejection(repoRunners['checks approve'](ctx))).exitCode).toBe(6)
      expect(sent.map((s) => s.method)).toEqual(['checks-list'])
    })

    it('leaves it alone when everything is already approved', async () => {
      const done = { 'checks-list': result('Checks for api', { workspace: { id: 'w', name: 'api' }, items: items.map((i) => ({ ...i, approved: true })) }) }
      const { ctx, sent } = fake([], { yes: true }, done)
      await repoRunners['checks approve'](ctx)
      expect(sent.map((s) => s.method)).toEqual(['checks-list'])
      expect(out.join('\n')).toContain('already approved')
    })
  })

  describe('auto-review', () => {
    const preview = { fingerprint: 'abc', reviewer: { agent: 'codex', model: 'gpt-5' } }
    const canned = {
      'repo-auto-review': (p: Record<string, unknown>) => (p.shown ? result('Auto review is on for api.', { enabled: true }) : result('Auto review would use codex gpt-5.\nNothing is on yet. Turn it on with what is shown above: foreman repo auto-review on --yes', { enabled: false, needsConfirmation: true, preview })),
      'repo-auto-review-status': result('Auto review is off for api.')
    }

    it('asks for the preview, prints it, confirms, then calls again with exactly what was shown', async () => {
      const { ctx, sent } = fake(['on', 'gpt-5'], { yes: true, reviewer: 'codex', exclude: ['docs/**'], effort: 'high', fast: true }, canned)
      await repoRunners['repo auto-review'](ctx)
      expect(sent).toHaveLength(2)
      expect(sent[0].params).toMatchObject({ verb: 'on', reviewer: { agent: 'codex', model: 'gpt-5', effort: 'high', fast: true }, exclusions: ['docs/**'] })
      expect(sent[0].params).not.toHaveProperty('shown')
      expect(sent[1].params).toMatchObject({ verb: 'on', shown: preview })
      expect(sent[1].params).not.toHaveProperty('reviewer')
      expect(out[0]).toContain('Auto review would use codex gpt-5.')
      expect(out[0]).not.toContain('Nothing is on yet')
      expect(out[1]).toBe('Auto review is on for api.')
    })

    it('changes nothing without --yes when there is no terminal', async () => {
      const { ctx, sent } = fake(['on'], {}, canned)
      expect((await rejection(repoRunners['repo auto-review'](ctx))).exitCode).toBe(6)
      expect(sent).toHaveLength(1)
    })

    it('needs a model with --reviewer, takes --model instead of the word, and looks through the read twin for status', async () => {
      expect((await rejection(repoRunners['repo auto-review'](fake(['on'], { reviewer: 'codex' }).ctx))).exitCode).toBe(2)
      const model = fake(['on'], { yes: true, reviewer: 'codex', model: 'gpt-5' }, canned)
      await repoRunners['repo auto-review'](model.ctx)
      expect(model.sent[0].params).toMatchObject({ reviewer: { agent: 'codex', model: 'gpt-5' } })
      const status = fake([], {}, canned)
      await repoRunners['repo auto-review'](status.ctx)
      expect(status.sent[0].method).toBe('repo-auto-review-status')
      const off = fake(['off'], {}, canned)
      await repoRunners['repo auto-review'](off.ctx)
      expect(off.sent[0]).toMatchObject({ method: 'repo-auto-review', params: { verb: 'off' } })
    })
  })

  it('shows integrations through the read method', async () => {
    const { ctx, sent } = fake([], { repo: 'api' }, { 'repo-integrations': result('rows') })
    await repoRunners['repo integrations'](ctx)
    expect(sent[0].method).toBe('repo-integrations')
  })

  it('prints its own help with no verb', async () => {
    await repoRunners['repo settings'](fake([]).ctx)
    expect(out.join('\n')).toContain('repo settings unset')
  })
})

describe('foreman env', () => {
  const SECRET = 'sk-very-secret-value-123'

  it('reads a value from standard input, drops one trailing newline and never prints it', async () => {
    vi.spyOn(io, 'readStdin').mockResolvedValue(`${SECRET}\n`)
    const { ctx, sent } = fake(['MY_TOKEN'], { stdin: true, repo: 'api' }, { 'env-set': result('Saved MY_TOKEN for api (…-123).', { key: 'MY_TOKEN' }) })
    await envRunners['env set'](ctx)
    expect(sent[0]).toEqual({ method: 'env-set', params: { repo: 'api', cwd: 'C:\\work\\repo', key: 'MY_TOKEN', value: SECRET } })
    expect([...out, ...err].join('\n')).not.toContain(SECRET)
  })

  it('also keeps the value out of --json output', async () => {
    vi.spyOn(io, 'readStdin').mockResolvedValue(SECRET)
    const { ctx } = fake(['MY_TOKEN'], { stdin: true, json: true }, { 'env-set': result('Saved.', { key: 'MY_TOKEN' }) })
    await envRunners['env set'](ctx)
    expect([...out, ...err].join('\n')).not.toContain(SECRET)
  })

  it('prompts without echo on a terminal, and says to use --stdin without one', async () => {
    vi.spyOn(io, 'stdinIsTTY').mockReturnValue(true)
    const prompt = vi.spyOn(io, 'promptSecret').mockResolvedValue(SECRET)
    const { ctx, sent } = fake(['MY_TOKEN'], {}, { 'env-set': result('Saved.') })
    await envRunners['env set'](ctx)
    expect(prompt).toHaveBeenCalledWith('Value for MY_TOKEN (not shown): ')
    expect((sent[0].params as { value: string }).value).toBe(SECRET)
    vi.spyOn(io, 'stdinIsTTY').mockReturnValue(false)
    const e = await rejection(envRunners['env set'](fake(['MY_TOKEN']).ctx))
    expect(e.exitCode).toBe(2)
    expect(e.message).toContain('--stdin')
  })

  it('accepts an inline value, and refuses one together with --stdin', async () => {
    const inline = fake(['API_URL', 'https://example.test'], {}, { 'env-set': result('Saved.') })
    await envRunners['env set'](inline.ctx)
    expect((inline.sent[0].params as { value: string }).value).toBe('https://example.test')
    expect((await rejection(envRunners['env set'](fake(['A', 'b'], { stdin: true }).ctx))).exitCode).toBe(2)
  })

  it('removes variables, asking first only for more than three', async () => {
    const few = fake(['A', 'B', 'C'], {}, { 'env-unset': result('Removed.') })
    await envRunners['env unset'](few.ctx)
    expect(few.sent[0].params).toMatchObject({ keys: ['A', 'B', 'C'] })
    const many = fake(['A', 'B', 'C', 'D'], {}, { 'env-unset': result('Removed.') })
    expect((await rejection(envRunners['env unset'](many.ctx))).exitCode).toBe(6)
    expect(many.sent).toEqual([])
    const yes = fake(['A', 'B', 'C', 'D'], { yes: true }, { 'env-unset': result('Removed.') })
    await envRunners['env unset'](yes.ctx)
    expect(yes.sent).toHaveLength(1)
  })

  it('renames with both names', async () => {
    const { ctx, sent } = fake(['OLD', 'NEW'], {}, { 'env-rename': result('Renamed.') })
    await envRunners['env rename'](ctx)
    expect(sent[0].params).toMatchObject({ from: 'OLD', to: 'NEW' })
  })

  describe('get', () => {
    const listing = result('', { scope: { kind: 'user' }, vars: [{ key: 'MY_TOKEN', origin: 'saved' }, { key: 'FROM_FILE', origin: 'file', file: '.env' }], files: [] })

    it('says only where a variable comes from without --reveal', async () => {
      const { ctx, sent } = fake(['FROM_FILE'], {}, { 'env-list': listing })
      await envRunners['env get'](ctx)
      expect(sent.map((s) => s.method)).toEqual(['env-list'])
      expect(out).toEqual(['FROM_FILE  from .env'])
      const missing = fake(['NOPE'], {}, { 'env-list': listing })
      const e = await rejection(envRunners['env get'](missing.ctx))
      expect(e.exitCode).toBe(8)
    })

    it('refuses --reveal without a terminal unless --force, and asks the app for nothing', async () => {
      const { ctx, sent } = fake(['MY_TOKEN'], { reveal: true }, { 'env-reveal': result(SECRET, { key: 'MY_TOKEN', value: SECRET }) })
      const e = await rejection(envRunners['env get'](ctx))
      expect(e.exitCode).toBe(7)
      expect(e.code).toBe('refused')
      expect(sent).toEqual([])
      expect(out).toEqual([])
    })

    it('prints the value to standard output and says it was revealed on standard error', async () => {
      const forced = fake(['MY_TOKEN'], { reveal: true, force: true }, { 'env-reveal': result(SECRET, { key: 'MY_TOKEN', value: SECRET }) })
      await envRunners['env get'](forced.ctx)
      expect(out).toEqual([SECRET])
      expect(err).toEqual(['revealed MY_TOKEN'])
      out.length = 0
      err.length = 0
      vi.spyOn(io, 'stdoutIsTTY').mockReturnValue(true)
      const terminal = fake(['MY_TOKEN'], { reveal: true, repo: 'api' }, { 'env-reveal': result(SECRET, { key: 'MY_TOKEN', value: SECRET }) })
      await envRunners['env get'](terminal.ctx)
      expect(terminal.sent[0].params).toMatchObject({ key: 'MY_TOKEN', repo: 'api' })
      expect(out).toEqual([SECRET])
    })
  })

  it('lists env files from the read method and changes them through the write one', async () => {
    const listing = result('', { scope: { kind: 'user' }, vars: [], files: [{ path: '.env', resolved: 'C:\\.env', count: 2 }] })
    const list = fake([], {}, { 'env-list': listing })
    await envRunners['env files'](list.ctx)
    expect(out.join('\n')).toContain('.env')
    expect(out.join('\n')).toContain('2 variables')
    const add = fake(['add', '.env.local'], { repo: 'api' }, { 'env-files': result('Added.') })
    await envRunners['env files'](add.ctx)
    expect(add.sent[0]).toEqual({ method: 'env-files', params: { repo: 'api', cwd: 'C:\\work\\repo', verb: 'add', path: '.env.local' } })
  })

  describe('import', () => {
    const file = ['# comment', '', 'PLAIN=value', 'export EXPORTED=yes', 'DOUBLE="two words # kept"', "SINGLE='a $b'", 'INLINE=abc # trailing', 'ESCAPED="line\\nbreak"', 'MULTI="one', 'two"', 'EMPTY=', 'not a line', '1BAD=x'].join('\n')

    it('parses KEY=VALUE lines, strips quotes, skips comments and counts what it could not read', () => {
      const { entries, skipped } = parseEnvFile(file)
      expect(entries).toEqual([
        ['PLAIN', 'value'],
        ['EXPORTED', 'yes'],
        ['DOUBLE', 'two words # kept'],
        ['SINGLE', 'a $b'],
        ['INLINE', 'abc'],
        ['ESCAPED', 'line\nbreak'],
        ['MULTI', 'one\ntwo'],
        ['EMPTY', '']
      ])
      expect(skipped).toBe(2)
    })

    it('previews the names, asks, then saves, and never prints a value', async () => {
      vi.spyOn(io, 'readFile').mockResolvedValue('A=top-secret-1\nB="top-secret-2"\n')
      const names = [{ key: 'A', status: 'new' }, { key: 'B', status: 'replaces' }]
      const canned = { 'env-import': (p: Record<string, unknown>) => result(p.dryRun ? 'Would save 2 variables for you:\n  A  new\n  B  replaces the saved value' : 'Saved 2 variables for you:', { names, saved: !p.dryRun }) }
      const refused = fake(['.env'], {}, canned)
      expect((await rejection(envRunners['env import'](refused.ctx))).exitCode).toBe(6)
      expect(refused.sent).toHaveLength(1)
      const yes = fake(['.env'], { yes: true, repo: 'api' }, canned)
      await envRunners['env import'](yes.ctx)
      expect(yes.sent.map((s) => (s.params as { dryRun?: boolean }).dryRun)).toEqual([true, undefined])
      expect(yes.sent[1].params).toMatchObject({ repo: 'api', entries: [['A', 'top-secret-1'], ['B', 'top-secret-2']] })
      expect([...out, ...err].join('\n')).not.toContain('top-secret')
    })

    it('says so when the file has no variables', async () => {
      vi.spyOn(io, 'readFile').mockResolvedValue('# nothing here\n')
      expect((await rejection(envRunners['env import'](fake(['.env']).ctx))).exitCode).toBe(2)
    })
  })
})

describe('foreman keys and tokens', () => {
  const SECRET = 'sk-another-secret-456'

  it('refuses a key put on the command line', async () => {
    const { ctx, sent } = fake(['OPENAI_API_KEY', SECRET])
    const e = await rejection(envRunners['keys set'](ctx))
    expect(e.exitCode).toBe(2)
    expect(e.message).not.toContain(SECRET)
    expect(sent).toEqual([])
  })

  it('reads a key from standard input, or copies it from the shell', async () => {
    vi.spyOn(io, 'readStdin').mockResolvedValue(`${SECRET}\r\n`)
    const stdin = fake(['OPENAI_API_KEY'], { stdin: true }, { 'keys-set': result('Saved OPENAI_API_KEY (…456).') })
    await envRunners['keys set'](stdin.ctx)
    expect(stdin.sent[0]).toEqual({ method: 'keys-set', params: { envVar: 'OPENAI_API_KEY', value: SECRET } })
    expect([...out, ...err].join('\n')).not.toContain(SECRET)
    const shell = fake(['OPENAI_API_KEY'], { 'from-shell': true }, { 'keys-set': result('Imported.') })
    await envRunners['keys set'](shell.ctx)
    expect(shell.sent[0].params).toEqual({ envVar: 'OPENAI_API_KEY', fromShell: true })
  })

  it('removes a key only after confirmation, and allows or denies agents', async () => {
    const refused = fake(['OPENAI_API_KEY'], {}, { 'keys-remove': result('Removed.') })
    expect((await rejection(envRunners['keys remove'](refused.ctx))).exitCode).toBe(6)
    expect(refused.sent).toEqual([])
    const yes = fake(['OPENAI_API_KEY'], { yes: true }, { 'keys-remove': result('Removed.') })
    await envRunners['keys remove'](yes.ctx)
    expect(yes.sent[0]).toEqual({ method: 'keys-remove', params: { envVar: 'OPENAI_API_KEY' } })
    const allow = fake(['OPENAI_API_KEY', 'codex', 'claude'], {}, { 'keys-allow': result('ok'), 'keys-deny': result('ok') })
    await envRunners['keys allow'](allow.ctx)
    expect(allow.sent[0]).toEqual({ method: 'keys-allow', params: { envVar: 'OPENAI_API_KEY', agents: ['codex', 'claude'] } })
    const deny = fake(['OPENAI_API_KEY', 'claude'], {}, { 'keys-deny': result('ok') })
    await envRunners['keys deny'](deny.ctx)
    expect(deny.sent[0].method).toBe('keys-deny')
  })

  it('reveals a key only to a terminal or with --force', async () => {
    const canned = { 'keys-reveal': result(SECRET, { key: 'OPENAI_API_KEY', value: SECRET }) }
    expect((await rejection(envRunners['keys reveal'](fake(['OPENAI_API_KEY'], {}, canned).ctx))).exitCode).toBe(7)
    await envRunners['keys reveal'](fake(['OPENAI_API_KEY'], { force: true }, canned).ctx)
    expect(out).toEqual([SECRET])
    expect(err).toEqual(['revealed OPENAI_API_KEY'])
  })

  it('reads the GitHub, cloud and agent secrets from standard input and sends them under the right method', async () => {
    vi.spyOn(io, 'readStdin').mockResolvedValue(`${SECRET}\n`)
    const gh = fake([], { stdin: true }, { 'github-token-set': result('Saved.') })
    await envRunners['github token set'](gh.ctx)
    expect(gh.sent[0]).toEqual({ method: 'github-token-set', params: { token: SECRET } })
    const cloud = fake([], { stdin: true }, { 'cloud-token-set': result('Saved.') })
    await envRunners['cloud token set'](cloud.ctx)
    expect(cloud.sent[0]).toEqual({ method: 'cloud-token-set', params: { token: SECRET } })
    const agent = fake(['codex'], { stdin: true }, { 'agents-key-set': result('Saved.') })
    await envRunners['agents key'](agent.ctx)
    expect(agent.sent[0]).toEqual({ method: 'agents-key-set', params: { agent: 'codex', value: SECRET } })
    const removed = fake(['codex'], { remove: true }, { 'agents-key-set': result('Removed.') })
    await envRunners['agents key'](removed.ctx)
    expect(removed.sent[0].params).toEqual({ agent: 'codex', remove: true })
    expect([...out, ...err].join('\n')).not.toContain(SECRET)
  })

  it('takes a GitLab token from standard input or glab, never from the command line', async () => {
    vi.spyOn(io, 'readStdin').mockResolvedValue(`${SECRET}\n`)
    const add = fake(['https://gitlab.example.com'], { 'token-stdin': true }, { 'gitlab-add': result('Saved.') })
    await envRunners['gitlab add'](add.ctx)
    expect(add.sent[0].params).toEqual({ url: 'https://gitlab.example.com', token: SECRET })
    const glab = fake(['https://gitlab.com'], { 'from-glab': true }, { 'gitlab-add': result('Saved.') })
    await envRunners['gitlab add'](glab.ctx)
    expect(glab.sent[0].params).toEqual({ url: 'https://gitlab.com', fromGlab: true })
    expect((await rejection(envRunners['gitlab add'](fake(['https://x.test', SECRET]).ctx))).exitCode).toBe(2)
  })

  it('confirms before forgetting a GitLab host, and sends the read twins for status commands', async () => {
    const refused = fake(['gitlab.example.com'], {}, { 'gitlab-remove': result('ok') })
    expect((await rejection(envRunners['gitlab remove'](refused.ctx))).exitCode).toBe(6)
    const reads: [string, string[], string][] = [
      ['env', [], 'env-list'],
      ['keys', ['list'], 'keys-list'],
      ['github', [], 'github-status'],
      ['github accounts', [], 'github-accounts'],
      ['gitlab', [], 'gitlab-list'],
      ['cloud token', ['status'], 'cloud-token-status']
    ]
    for (const [name, args, method] of reads) {
      const { ctx, sent } = fake(args, {}, { [method]: result('ok') })
      await envRunners[name](ctx)
      expect(sent[0].method, name).toBe(method)
    }
    expect((await rejection(envRunners.github(fake(['token']).ctx))).exitCode).toBe(2)
  })
})

describe('the command table for these commands', () => {
  it('gives each a summary, a usage line that starts with its name, an example and help that renders', () => {
    for (const c of MINE) {
      const name = commandName(c)
      expect(c.summary, name).not.toBe('')
      expect(c.usage.startsWith(`foreman ${name}`), c.usage).toBe(true)
      expect(c.examples?.length, name).toBeGreaterThan(0)
      const help = renderCommandHelp(c)
      expect(help, name).toContain(c.usage)
      for (const option of Object.keys(c.options)) expect(help, `${name} --${option}`).toContain(`--${option}`)
      for (const example of c.examples ?? []) expect(help).toContain(example)
    }
  })

  it('has no repeated path, no clash with the existing commands, and a function for each path and no other', () => {
    const names = MINE.map(commandName)
    expect(new Set(names).size).toBe(names.length)
    // Declared once in the shared table (or not yet merged into it), never twice.
    for (const name of names) expect(COMMANDS.filter((c) => commandName(c) === name).length, `${name} is declared elsewhere too`).toBeLessThanOrEqual(1)
    expect(Object.keys(RUNNERS).sort()).toEqual([...names].sort())
  })

  it('is the group the plan names, and a short option is never one of the common ones', () => {
    for (const c of MINE) {
      expect(['settings', 'repos', 'work', 'remote'], commandName(c)).toContain(c.group)
      const shorts = Object.values(c.options).flatMap((o) => (o.short ? [o.short] : []))
      expect(new Set(shorts).size, commandName(c)).toBe(shorts.length)
      for (const short of shorts) expect(['q', 'y', 'h'], commandName(c)).not.toContain(short)
    }
    expect(MINE.filter((c) => c.path[0] === 'repo').every((c) => c.group === 'repos')).toBe(true)
    // `checks approve` sits beside `checks` in the help: it is the consent that command asks for.
    expect(MINE.find((c) => commandName(c) === 'checks approve')?.group).toBe('work')
    expect(MINE.filter((c) => c.path[0] === 'settings').every((c) => c.group === 'settings')).toBe(true)
  })

  it('marks every command that reads a secret from the terminal, and every one that reveals one', () => {
    const named = (n: string) => MINE.find((c) => commandName(c) === n)!
    for (const n of ['env set', 'keys set', 'github token set', 'gitlab add', 'cloud token set', 'agents key']) expect(named(n).noAssistant, n).toBe('reads a secret from the terminal')
    for (const n of ['env get', 'keys reveal']) expect(named(n).noAssistant, n).toBe('reveals a secret')
    expect(named('settings reset').noAssistant).toBeUndefined()
  })

  it('makes every look a read and every change an admin command', () => {
    const named = (n: string) => MINE.find((c) => commandName(c) === n)!
    for (const n of ['settings list', 'settings get', 'settings keys', 'settings search', 'settings path', 'settings export', 'repo settings list', 'repo settings get', 'repo settings file', 'repo integrations', 'env', 'keys', 'github', 'gitlab', 'cloud token']) expect(named(n).tier, n).toBe('read')
    for (const n of ['settings set', 'settings reset', 'settings import', 'repo settings set', 'repo settings unset', 'repo setup', 'checks approve', 'repo auto-review', 'env set', 'keys remove', 'github token clear']) expect(named(n).tier, n).toBe('admin')
  })

  it('resolves each path to itself among the existing commands, and parses repeated and string options', () => {
    const all = [...COMMANDS.filter((c) => !MINE.some((m) => commandName(m) === commandName(c))), ...MINE]
    for (const c of MINE) {
      const found = findCommand(c.path, all)
      expect('spec' in found && commandName(found.spec), commandName(c)).toBe(commandName(c))
    }
    const set = MINE.find((c) => commandName(c) === 'settings set')!
    expect(parseCommandArgs(set, ['environment.env-files', '--add', 'a', '--add', 'b']).opts.add).toEqual(['a', 'b'])
    const auto = MINE.find((c) => commandName(c) === 'repo auto-review')!
    const parsed = parseCommandArgs(auto, ['on', '--reviewer', 'codex', 'gpt-5', '--exclude', 'a', '--exclude', 'b', '--yes'])
    expect(parsed.positionals).toEqual(['on', 'gpt-5'])
    expect(parsed.opts).toMatchObject({ reviewer: 'codex', exclude: ['a', 'b'], yes: true })
  })
})

describe('the settings-keys help topic', () => {
  it('lists personal and repository keys with what they take and the title', () => {
    const text = renderTopic('settings-keys')!
    expect(text).toContain('appearance.theme')
    expect(text).toContain('system | light | dark')
    expect(text).toContain('scripts.checks-after-turn')
    expect(text).toContain('actions.prompt-general')
    expect(text).toContain('cloud.install-script')
    expect(text).toContain('Appearance')
    expect(text).toContain('Scripts')
    expect(text).toContain('integer 10-20')
  })
})
