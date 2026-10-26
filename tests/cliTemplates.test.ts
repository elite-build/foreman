import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CliCodedError } from '../src/main/cli/host'
import type { CliContext } from '../src/main/cli/methods'
import { COMMANDS_METHODS } from '../src/main/cli/commands'
import { TEMPLATES_METHODS } from '../src/main/cli/templates'
import { defaultSettings } from '../src/main/store'
import type { CommandChangeResult, CommandsApproveResult, CommandsListResult, CommandsRemoveResult } from '../src/shared/cli/commands'
import type { TemplateChangeResult, TemplatesListResult, TemplatesRemoveResult, TemplatesShowResult } from '../src/shared/cli/templates'
import type { ModelInfo } from '../src/shared/agents'
import type { SavedCommand } from '../src/shared/savedCommands'
import type { Api, AppSnapshot, PromptTemplate, Repo, Schedule, Settings, Workspace } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'

const ctx = { request: { method: 'x' }, caller: undefined, signal: undefined, progress: () => undefined } as CliContext

const root = path.resolve('/tmp/foreman-cli-templates/repo')
const repo = { id: 'r1', name: 'foreman', rootPath: root, defaultBranch: 'main' } as Repo
const other = { id: 'r2', name: 'other', rootPath: path.resolve('/tmp/foreman-cli-templates/other'), defaultBranch: 'main' } as Repo

const CLAUDE: ModelInfo[] = [{ id: 'claude-sonnet-5-5[1m]', agent: 'claude', label: 'Sonnet 5.5', efforts: ['low', 'high'], defaultEffort: 'high', supportsFast: false, contextWindow: 1_000_000 }]

const repoTemplate: PromptTemplate = { id: 'repo:r1:release', name: 'Release', body: 'Cut the release', source: 'repo', repoId: 'r1', rev: 'abc1234', file: '.foreman/templates/release.md' }

function setup(over: { settings?: Partial<Settings>; snapshot?: Partial<AppSnapshot>; api?: Partial<Api>; workspaces?: Workspace[] } = {}) {
  const settings = { ...defaultSettings(), ...over.settings }
  const snapshot = { repos: [repo, other], workspaces: over.workspaces ?? [], sessions: [], settings, repoTemplates: { r1: [repoTemplate] }, repoCommands: {}, schedules: [], occurrences: [], catalog: { agents: { claude: { models: CLAUDE } }, outputStyles: [] }, ...over.snapshot } as unknown as AppSnapshot
  const updateSettings = vi.fn(async (patch: Partial<Settings>) => ({ ...settings, ...patch }) as Settings)
  const host = stubHost({ state: () => ({ repos: snapshot.repos, workspaces: snapshot.workspaces, sessions: [], settings }), snapshot: () => snapshot, api: fakeApi({ updateSettings, ...over.api }) })
  const templates = <T>(method: string, params?: unknown) => TEMPLATES_METHODS[method].handle(host, params, ctx) as Promise<T>
  const commands = <T>(method: string, params?: unknown) => COMMANDS_METHODS[method].handle(host, params, ctx) as Promise<T>
  return { host, templates, commands, updateSettings, settings }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(CliCodedError)
  return err as CliCodedError
}

describe('the template methods', () => {
  it('puts lists and shows in the read tier and every change in admin', () => {
    expect(Object.fromEntries(Object.entries(TEMPLATES_METHODS).map(([k, m]) => [k, m.tier]))).toEqual({ 'templates-list': 'read', 'templates-show': 'read', 'templates-add': 'admin', 'templates-edit': 'admin', 'templates-remove': 'admin' })
  })

  it('lists yours and the repository’s with slug, placeholders, source, start model and follow-up', async () => {
    const mine: PromptTemplate = { id: 't-1', name: 'Fix a thing', body: 'Fix {{what}}', startModel: { agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'low' }, followUp: { title: 'Review it', prompt: 'Review' } }
    const { templates } = setup({ settings: { promptTemplates: [mine] } })
    const result = await templates<TemplatesListResult>('templates-list', { cwd: root })
    expect(result.templates).toEqual([
      { slug: 'fix-a-thing', id: 't-1', name: 'Fix a thing', placeholders: ['what'], source: 'personal', startModel: { agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'low' }, followUp: { title: 'Review it' } },
      { slug: 'release', id: 'repo:r1:release', name: 'Release', placeholders: [], source: 'repo', repo: 'foreman', file: '.foreman/templates/release.md' }
    ])
    expect(result.text).toContain('repo foreman')
    // From outside the repository only yours are there.
    const away = await templates<TemplatesListResult>('templates-list', {})
    expect(away.templates.map((t) => t.slug)).toEqual(['fix-a-thing'])
  })

  it('qualifies a repository template a personal one shadows', async () => {
    const { templates } = setup({ settings: { promptTemplates: [{ id: 't-1', name: 'Release', body: 'mine' }] } })
    const result = await templates<TemplatesListResult>('templates-list', { cwd: root })
    expect(result.templates.map((t) => t.slug)).toEqual(['release', 'repo:release'])
  })

  it('shows a template’s body and placeholders, and says when a name is unknown or ambiguous', async () => {
    const { templates } = setup({ settings: { promptTemplates: [{ id: 't-1', name: 'Fix a bug', body: 'Fix {{bug}} in {{file}}' }, { id: 't-2', name: 'Fix a typo', body: 'Fix' }] } })
    const shown = await templates<TemplatesShowResult>('templates-show', { template: 'fix-a-bug', cwd: root })
    expect(shown.body).toBe('Fix {{bug}} in {{file}}')
    expect(shown.template.placeholders).toEqual(['bug', 'file'])
    expect(shown.text).toContain('{{bug}}, {{file}}')
    expect((await failure(templates('templates-show', { template: 'ghost', cwd: root }))).code).toBe('not-found')
    expect((await failure(templates('templates-show', { template: 'fix', cwd: root }))).code).toBe('ambiguous')
    expect((await templates<TemplatesShowResult>('templates-show', { template: 'repo:release', cwd: root })).template.source).toBe('repo')
  })

  it('add writes promptTemplates with a generated id and validates the start model', async () => {
    const { templates, updateSettings, settings } = setup()
    const result = await templates<TemplateChangeResult>('templates-add', { name: '  Weekly   report ', body: 'Summarise {{topic}}', startModel: { agent: 'claude', model: 'claude-sonnet-5-5[1m]' }, followUp: { title: 'Send it', prompt: 'Send the report', model: { agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'low' } } })
    const written = updateSettings.mock.calls[0][0].promptTemplates!
    expect(written.slice(0, settings.promptTemplates.length)).toEqual(settings.promptTemplates)
    expect(written.at(-1)).toMatchObject({ name: 'Weekly report', body: 'Summarise {{topic}}', startModel: { agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'high' }, followUp: { title: 'Send it', prompt: 'Send the report', model: { agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: 'low', fast: false } } })
    expect(written.at(-1)!.id).toMatch(/^t-/)
    expect(result.template.slug).toBe('weekly-report')
    expect(result.notes.join(' ')).toContain('{{topic}}')
  })

  it('add refuses a duplicate name (any case, or the same slug) and writes nothing', async () => {
    const { templates, updateSettings } = setup()
    const dup = await failure(templates('templates-add', { name: 'fix a bug', body: 'x' }))
    expect(dup.code).toBe('invalid')
    expect(dup.message).toContain('already have a template named “Fix a bug”')
    expect((await failure(templates('templates-add', { name: 'Fix-a-Bug!', body: 'x' }))).code).toBe('invalid')
    expect((await failure(templates('templates-add', { name: 'New one', body: '   ' }))).message).toMatch(/needs a prompt/)
    expect((await failure(templates('templates-add', { name: '!!!', body: 'x' }))).message).toMatch(/letters or digits/)
    expect((await failure(templates('templates-add', { name: 'N', body: 'x', startModel: { agent: 'claude', model: 'claude-nope' } }))).message).toMatch(/doesn’t list/)
    expect((await failure(templates('templates-add', { name: 'N', body: 'x', followUp: { title: 'only a title' } }))).message).toMatch(/title and a prompt/)
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('edit changes the fields it is given and keeps the rest', async () => {
    const mine: PromptTemplate = { id: 't-1', name: 'Fix a thing', body: 'Fix it', startModel: { agent: 'claude', model: 'claude-sonnet-5-5[1m]' }, followUp: { title: 'Review', prompt: 'Review it' } }
    const { templates, updateSettings } = setup({ settings: { promptTemplates: [mine] } })
    await templates<TemplateChangeResult>('templates-edit', { template: 'fix-a-thing', name: 'Fix things', clearStartModel: true, followUp: { prompt: 'Review it twice' } })
    expect(updateSettings).toHaveBeenCalledWith({ promptTemplates: [{ id: 't-1', name: 'Fix things', body: 'Fix it', followUp: { title: 'Review', prompt: 'Review it twice' } }] })
    expect((await failure(templates('templates-edit', { template: 'fix-a-thing' }))).message).toMatch(/Nothing to change/)
    expect((await failure(templates('templates-edit', { template: 'fix-a-thing', body: ' ' }))).code).toBe('invalid')
  })

  it('edit refuses to rename onto another template, and says which schedules a text change pauses', async () => {
    const schedule = { id: 's1', templateId: 't-1', state: 'active' } as Schedule
    const { templates } = setup({ settings: { promptTemplates: [{ id: 't-1', name: 'One', body: 'a' }, { id: 't-2', name: 'Two', body: 'b' }] }, snapshot: { schedules: [schedule] } })
    expect((await failure(templates('templates-edit', { template: 'one', name: 'two' }))).message).toMatch(/already have a template named “Two”/)
    const changed = await templates<TemplateChangeResult>('templates-edit', { template: 'one', body: 'new text' })
    expect(changed.notes.join(' ')).toMatch(/1 schedule runs this template and will pause/)
    const renamed = await templates<TemplateChangeResult>('templates-edit', { template: 'one', name: 'Uno' })
    expect(renamed.notes).toEqual([])
  })

  it('remove drops one of yours, and refuses a repository template with the file path', async () => {
    const { templates, updateSettings } = setup({ settings: { promptTemplates: [{ id: 't-1', name: 'One', body: 'a' }, { id: 't-2', name: 'Two', body: 'b' }] } })
    const removed = await templates<TemplatesRemoveResult>('templates-remove', { template: 'one' })
    expect(updateSettings).toHaveBeenCalledWith({ promptTemplates: [{ id: 't-2', name: 'Two', body: 'b' }] })
    expect(removed.removed.name).toBe('One')

    updateSettings.mockClear()
    const refused = await failure(templates('templates-remove', { template: 'repo:release', cwd: root }))
    expect(refused.code).toBe('refused')
    expect(refused.message).toContain('.foreman/templates/release.md')
    expect(refused.message).toContain('read-only')
    expect((await failure(templates('templates-edit', { template: 'repo:release', cwd: root, name: 'x' }))).code).toBe('refused')
    expect(updateSettings).not.toHaveBeenCalled()
  })
})

describe('the saved-command methods', () => {
  const mine = (over: Partial<SavedCommand> = {}): SavedCommand => ({ id: 'cmd-1', name: 'Reset DB', command: 'npm run db:reset', scope: 'repo', repoId: 'r1', ...over })
  const shared = (over: Partial<SavedCommand> = {}): SavedCommand => ({ id: 'repo:r1:tail-logs', name: 'Tail logs', command: 'tail -f log', scope: 'repo', repoId: 'r1', source: 'repo', approved: false, ...over })

  it('lists yours for the repository, the shared ones with their approval state', async () => {
    const { commands } = setup({
      settings: { savedCommands: [mine(), mine({ id: 'cmd-2', name: 'Lint all', scope: 'all', repoId: undefined, command: 'eslint .' }), mine({ id: 'cmd-3', name: 'Other', repoId: 'r2' })] },
      snapshot: { repoCommands: { r1: [shared(), shared({ id: 'repo:r1:ok', name: 'Fine', approved: true })] } }
    })
    const result = await commands<CommandsListResult>('commands-list', { cwd: root })
    expect(result.repo).toBe('foreman')
    expect(result.commands.map((c) => [c.name, c.source, c.approved])).toEqual([['Reset DB', 'personal', undefined], ['Lint all', 'personal', undefined], ['Tail logs', 'repo', false], ['Fine', 'repo', true]])
    expect(result.text).toContain('needs approval')
    // Named by --repo from anywhere.
    const named = await commands<CommandsListResult>('commands-list', { cwd: '/', repo: 'other' })
    expect(named.commands.map((c) => c.name)).toEqual(['Lint all', 'Other'])
  })

  it('add writes savedCommands for this repository or for all, and checks the start folder', async () => {
    const { commands, updateSettings } = setup()
    const added = await commands<CommandChangeResult>('commands-add', { name: ' Reset   DB ', command: 'npm run db:reset', scope: 'repo', cwd: root, startIn: 'packages\\api' })
    expect(updateSettings.mock.calls[0][0].savedCommands).toEqual([{ id: added.command.id, name: 'Reset DB', command: 'npm run db:reset', scope: 'repo', repoId: 'r1', cwd: 'packages/api' }])
    expect(added.command).toMatchObject({ scope: 'repo', repo: 'foreman', startIn: 'packages/api', source: 'personal' })
    await commands('commands-add', { name: 'Lint', command: 'eslint .', scope: 'all', cwd: '/' })
    expect(updateSettings.mock.calls[1][0].savedCommands![0]).toMatchObject({ name: 'Lint', scope: 'all' })
    expect(updateSettings.mock.calls[1][0].savedCommands![0]).not.toHaveProperty('repoId')

    expect((await failure(commands('commands-add', { name: 'X', command: 'x', scope: 'repo', cwd: root, startIn: '../outside' }))).message).toMatch(/inside the workspace/)
    expect((await failure(commands('commands-add', { name: 'X', command: ' ', scope: 'all', cwd: root }))).message).toMatch(/needs the command line/)
    expect((await failure(commands('commands-add', { name: 'X', command: 'x', scope: 'everywhere', cwd: root }))).code).toBe('invalid')
  })

  it('add refuses a duplicate name in the same scope', async () => {
    const { commands, updateSettings } = setup({ settings: { savedCommands: [mine()] } })
    const dup = await failure(commands('commands-add', { name: 'reset db', command: 'x', scope: 'repo', cwd: root }))
    expect(dup.message).toContain('already have a command named “Reset DB”')
    expect(updateSettings).not.toHaveBeenCalled()
    await commands('commands-add', { name: 'reset db', command: 'x', scope: 'all', cwd: root })
    expect(updateSettings).toHaveBeenCalledTimes(1)
  })

  it('edit and remove work on yours by id or name, and refuse a repository’s own', async () => {
    const { commands, updateSettings } = setup({ settings: { savedCommands: [mine()] }, snapshot: { repoCommands: { r1: [shared()] } } })
    await commands<CommandChangeResult>('commands-edit', { id: 'reset db', cwd: root, command: 'npm run db:reset -- --force', startIn: 'api' })
    expect(updateSettings).toHaveBeenLastCalledWith({ savedCommands: [mine({ command: 'npm run db:reset -- --force', cwd: 'api' })] })
    await commands('commands-edit', { id: 'cmd-1', cwd: root, scope: 'all' })
    expect(updateSettings).toHaveBeenLastCalledWith({ savedCommands: [{ id: 'cmd-1', name: 'Reset DB', command: 'npm run db:reset', scope: 'all' }] })
    const removed = await commands<CommandsRemoveResult>('commands-remove', { id: 'cmd-1', cwd: root })
    expect(updateSettings).toHaveBeenLastCalledWith({ savedCommands: [] })
    expect(removed.removed.name).toBe('Reset DB')

    updateSettings.mockClear()
    const refused = await failure(commands('commands-remove', { id: 'Tail logs', cwd: root }))
    expect(refused.code).toBe('refused')
    expect(refused.message).toContain('.foreman/settings.toml')
    expect((await failure(commands('commands-edit', { id: 'ghost', cwd: root, name: 'x' }))).code).toBe('not-found')
    expect((await failure(commands('commands-edit', { id: 'cmd-1', cwd: root }))).message).toMatch(/Nothing to change/)
    expect(updateSettings).not.toHaveBeenCalled()
  })

  describe('approve', () => {
    const ws = { id: 'w1', repoId: 'r1', name: 'lisbon', branch: 'lisbon', state: 'ready', path: path.join(root, 'w') } as Workspace

    it('shows the command and what it was approved as before, and approves nothing without the user’s word', async () => {
      const savedCommandConsent = vi.fn(async () => ({ name: 'Tail logs', command: 'tail -f log', previous: 'tail log', source: 'shared' as const }))
      const approveSavedCommand = vi.fn(async () => undefined)
      const { commands } = setup({ workspaces: [ws], snapshot: { repoCommands: { r1: [shared()] } }, api: { savedCommandConsent, approveSavedCommand } })
      // The id is `repo:r1:tail-logs`; its name finds it too.
      const byName = await commands<CommandsApproveResult>('commands-approve', { workspace: 'lisbon', cwd: root, id: 'Tail logs' })
      expect(byName).toMatchObject({ approved: false, needsConfirmation: true, shown: 'tail -f log', previous: 'tail log' })
      expect(byName.text).toContain('tail -f log')
      expect(approveSavedCommand).not.toHaveBeenCalled()
    })

    it('approves the text that was shown, so a changed file is refused by the service', async () => {
      const savedCommandConsent = vi.fn(async () => ({ name: 'Tail logs', command: 'tail -f log', source: 'shared' as const }))
      const approveSavedCommand = vi.fn(async () => undefined)
      const { commands } = setup({ workspaces: [ws], snapshot: { repoCommands: { r1: [shared()] } }, api: { savedCommandConsent, approveSavedCommand } })
      const result = await commands<CommandsApproveResult>('commands-approve', { workspace: 'lisbon', cwd: root, id: 'repo:r1:tail-logs', shown: 'tail -f old-log' })
      expect(approveSavedCommand).toHaveBeenCalledWith('w1', 'repo:r1:tail-logs', 'tail -f old-log')
      expect(result).toMatchObject({ approved: true })
      await commands('commands-approve', { workspace: 'lisbon', cwd: root, id: 'repo:r1:tail-logs', confirmed: true })
      expect(approveSavedCommand).toHaveBeenLastCalledWith('w1', 'repo:r1:tail-logs', 'tail -f log')
    })

    it('says so when it is approved already, and when the repository shares nothing', async () => {
      const savedCommandConsent = vi.fn(async () => null)
      const { commands } = setup({ workspaces: [ws], snapshot: { repoCommands: { r1: [shared({ approved: true })] } }, api: { savedCommandConsent } })
      expect((await commands<CommandsApproveResult>('commands-approve', { workspace: 'lisbon', cwd: root, id: 'Tail logs' })).text).toMatch(/already approved/)
      const none = setup({ workspaces: [ws] })
      expect((await failure(none.commands('commands-approve', { workspace: 'lisbon', cwd: root, id: 'x' }))).code).toBe('not-found')
    })
  })
})
