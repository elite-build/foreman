// O9: saved shell commands (Cues). Storage and layering of your commands and the repo's,
// the settings.toml parsing, approval shared with checks (an unapproved repo command doesn't
// run; a changed one asks again), and the terminal launch a command's tab starts with.
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import { ChecksService, commandHash } from '../src/main/checks'
import { fromToml, readSharedLayer } from '../src/main/repoSettings'
import { approveCommand, commandLaunch, consentItem, isApproved, repoCommands, runnableCommand } from '../src/main/savedCommands'
import { defaultSettings, Store, type PersistedState } from '../src/main/store'
import { createT } from '../src/shared/i18n'
import {
  commandBanner,
  commandInput,
  commandsForRepo,
  commandsFromToml,
  findCommand,
  needsApproval,
  normalizeCommandCwd,
  parseSavedCommands,
  repoCommandList,
  type SavedCommand
} from '../src/shared/savedCommands'
import type { Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

const t = createT('en')

const mine = (over: Partial<SavedCommand> & Pick<SavedCommand, 'id' | 'name'>): SavedCommand => ({ command: 'echo hi', scope: 'all', ...over })

/** A repository folder with this .foreman/settings.toml. The mtime moves forward on each write, so the cache reads it again. */
async function repoWith(toml: string, dir?: string): Promise<{ id: string; rootPath: string }> {
  const rootPath = dir ?? (await tempDir('foreman-cues-'))
  const file = path.join(rootPath, '.foreman', 'settings.toml')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, toml)
  const later = new Date(Date.now() + Math.floor(Math.random() * 100_000) + 1000)
  await utimes(file, later, later)
  return { id: 'r1', rootPath }
}

const LEDGER = `
[[commands]]
name = "Tail API logs"
command = "docker compose logs -f api"

[[commands]]
name = "Seed demo data"
command = "npm run seed:demo"
cwd = "services/api"
`

describe('saved commands: storage', () => {
  it('starts empty and keeps your commands across a restart', async () => {
    expect(defaultSettings().savedCommands).toEqual([])
    const dir = await tempDir('foreman-cues-')
    const store = new Store(dir)
    await store.load()
    store.state.settings.savedCommands = [mine({ id: 'a', name: 'Reset test DB', command: 'npm run db:reset', scope: 'repo', repoId: 'r1' })]
    store.flush()
    const again = new Store(dir)
    await again.load()
    expect(again.state.settings.savedCommands).toEqual([{ id: 'a', name: 'Reset test DB', command: 'npm run db:reset', scope: 'repo', repoId: 'r1' }])
    again.close()
    store.close()
  })

  it('drops malformed entries when loading, field by field', async () => {
    const dir = await tempDir('foreman-cues-')
    const store = new Store(dir)
    await store.load()
    ;(store.state.settings as unknown as Record<string, unknown>).savedCommands = [
      { id: 'ok', name: '  Regenerate   types ', command: 'npm run gen:types', scope: 'all' },
      { id: 'no-name', name: '   ', command: 'x', scope: 'all' },
      { name: 'No id', command: 'x', scope: 'all' },
      { id: 'repo:r1:sneaky', name: 'Pretends to be the repo’s', command: 'x', scope: 'all' },
      'not a command',
      { id: 'ok', name: 'Same id again', command: 'x', scope: 'all' }
    ]
    store.flush()
    const again = new Store(dir)
    await again.load()
    expect(again.state.settings.savedCommands).toEqual([{ id: 'ok', name: 'Regenerate types', command: 'npm run gen:types', scope: 'all' }])
    again.close()
    store.close()
  })

  it('"This repo" without a repository becomes all repos, and a folder outside the workspace is dropped', () => {
    expect(parseSavedCommands([{ id: 'a', name: 'A', command: 'x', scope: 'repo' }])).toEqual([{ id: 'a', name: 'A', command: 'x', scope: 'all' }])
    expect(parseSavedCommands([{ id: 'a', name: 'A', command: 'x', scope: 'all', repoId: 'r1', cwd: '../elsewhere' }])).toEqual([{ id: 'a', name: 'A', command: 'x', scope: 'all' }])
    expect(parseSavedCommands([{ id: 'a', name: 'A', command: 'x', scope: 'all', cwd: 'packages\\api\\' }])[0].cwd).toBe('packages/api')
  })

  it('normalizes the start folder: relative, inside the workspace', () => {
    expect(normalizeCommandCwd('')).toBeUndefined()
    expect(normalizeCommandCwd(' . ')).toBeUndefined()
    expect(normalizeCommandCwd('./packages//api/')).toBe('packages/api')
    expect(normalizeCommandCwd('/etc')).toBeNull()
    expect(normalizeCommandCwd('C:\\Windows')).toBeNull()
    expect(normalizeCommandCwd('~/code')).toBeNull()
    expect(normalizeCommandCwd('packages/../..')).toBeNull()
  })
})

describe('saved commands: settings.toml', () => {
  it('reads [[commands]] tables with a name and command, and an optional folder', () => {
    expect(commandsFromToml(parse(LEDGER).commands)).toEqual([
      { name: 'Tail API logs', command: 'docker compose logs -f api' },
      { name: 'Seed demo data', command: 'npm run seed:demo', cwd: 'services/api' }
    ])
  })

  it('takes a table keyed by name too, as checks do', () => {
    expect(commandsFromToml(parse('[commands]\n"Reset test DB" = "npm run db:reset"\nlint = { command = "npm run lint" }').commands)).toEqual([
      { name: 'Reset test DB', command: 'npm run db:reset' },
      { name: 'lint', command: 'npm run lint' }
    ])
  })

  it('skips entries without a name or command, repeated names, and folders outside the workspace', () => {
    const doc = parse(`
[[commands]]
command = "no name"
[[commands]]
name = "No command"
[[commands]]
name = "Logs"
command = "first"
[[commands]]
name = "Logs"
command = "second"
[[commands]]
name = "Escapes"
command = "rm -rf ."
cwd = "../../"
`)
    expect(commandsFromToml(doc.commands)).toEqual([{ name: 'Logs', command: 'first' }])
    expect(commandsFromToml(undefined)).toEqual([])
    expect(commandsFromToml('npm test')).toEqual([])
  })

  it('is part of the shared settings layer, read from the repo folder', async () => {
    expect(fromToml(parse(LEDGER) as Record<string, unknown>).commands).toHaveLength(2)
    const repo = await repoWith(LEDGER)
    expect(readSharedLayer(repo.rootPath).commands?.map((c) => c.name)).toEqual(['Tail API logs', 'Seed demo data'])
  })
})

describe('saved commands: layering', () => {
  const personal = [
    mine({ id: 'reset', name: 'Reset test DB', scope: 'repo', repoId: 'r1' }),
    mine({ id: 'other', name: 'Other repo only', scope: 'repo', repoId: 'r2' }),
    mine({ id: 'types', name: 'Regenerate types', scope: 'all' }),
    mine({ id: 'empty', name: 'Not written yet', command: '  ', scope: 'all' })
  ]
  const fromRepo = repoCommandList('r1', commandsFromToml(parse(LEDGER).commands), () => false)

  it('a workspace sees this repo’s (yours, then the repo’s) and yours for all repos; never another repo’s or empty ones', () => {
    const { repo, all } = commandsForRepo(personal, fromRepo, 'r1')
    expect(repo.map((c) => c.id)).toEqual(['reset', 'repo:r1:tail-api-logs', 'repo:r1:seed-demo-data'])
    expect(all.map((c) => c.id)).toEqual(['types'])
    expect(commandsForRepo(personal, fromRepo, 'r2').repo.map((c) => c.id)).toEqual(['other'])
  })

  it('repo commands are marked as from the repo, read-only and needing approval until approved', () => {
    expect(fromRepo[0]).toMatchObject({ source: 'repo', scope: 'repo', repoId: 'r1', approved: false })
    expect(needsApproval(fromRepo[0])).toBe(true)
    expect(needsApproval(personal[0])).toBe(false)
  })

  it('names with the same slug still get their own ids', () => {
    const list = repoCommandList('r1', [{ name: 'Logs!', command: 'a' }, { name: 'logs', command: 'b' }], () => true)
    expect(list.map((c) => c.id)).toEqual(['repo:r1:logs', 'repo:r1:logs-2'])
  })

  it('finds a command only where it is offered', () => {
    expect(findCommand(personal, fromRepo, 'r1', 'reset')?.name).toBe('Reset test DB')
    expect(findCommand(personal, fromRepo, 'r1', 'other')).toBeUndefined()
    expect(findCommand(personal, fromRepo, 'r2', 'repo:r1:tail-api-logs')).toBeUndefined()
  })
})

describe('saved commands: approval, shared with checks', () => {
  const state = (): Pick<PersistedState, 'checkApprovals' | 'commandApprovedText'> => ({})

  it('an unapproved repo command doesn’t run; approving it lets it run', async () => {
    const repo = await repoWith(LEDGER)
    const s = state()
    const [tail] = repoCommands(s, repo)
    expect(tail.approved).toBe(false)
    expect(() => runnableCommand([], repoCommands(s, repo), 'r1', tail.id)).toThrow(/Approve “Tail API logs”/)
    expect(consentItem(s, tail)).toEqual({ name: 'Tail API logs', command: 'docker compose logs -f api', previous: undefined, source: 'shared' })
    approveCommand(s, tail)
    expect(s.checkApprovals?.r1).toEqual([commandHash('docker compose logs -f api')])
    expect(runnableCommand([], repoCommands(s, repo), 'r1', tail.id).name).toBe('Tail API logs')
  })

  it('a changed command asks again, showing the text approved before', async () => {
    const repo = await repoWith(LEDGER)
    const s = state()
    approveCommand(s, repoCommands(s, repo)[0])
    await repoWith(LEDGER.replace('logs -f api', 'logs -f api worker'), repo.rootPath)
    const [tail] = repoCommands(s, repo)
    expect(tail.approved).toBe(false)
    expect(() => runnableCommand([], [tail], 'r1', tail.id)).toThrow()
    expect(consentItem(s, tail).previous).toBe('docker compose logs -f api')
  })

  it('a command approved as a check counts here, and one approved here counts as a check', async () => {
    const repo = await repoWith(LEDGER)
    const s = state()
    s.checkApprovals = { r1: [commandHash('npm run seed:demo')] }
    expect(repoCommands(s, repo).map((c) => c.approved)).toEqual([false, true])
    approveCommand(s, repoCommands(s, repo)[0])
    const ws = { id: 'ws1', repoId: 'r1', name: 'lisbon', path: repo.rootPath, state: 'ready' } as Workspace
    const checks = new ChecksService({
      store: { state: s, save: () => undefined } as unknown as Store,
      workspace: () => ws,
      checks: () => [{ name: 'logs', command: 'docker compose logs -f api', source: 'shared' }],
      env: () => ({}),
      changed: () => undefined
    })
    expect(checks.consentNeeded('ws1')).toEqual([])
    expect(isApproved(s, 'r1', 'docker compose logs -f api')).toBe(true)
    expect(isApproved(s, 'r2', 'docker compose logs -f api')).toBe(false)
  })

  it('your own commands never ask, and a missing one is an error', () => {
    const reset = mine({ id: 'reset', name: 'Reset test DB', command: 'npm run db:reset', scope: 'repo', repoId: 'r1' })
    expect(runnableCommand([reset], [], 'r1', 'reset').command).toBe('npm run db:reset')
    expect(() => runnableCommand([reset], [], 'r1', 'gone')).toThrow(/isn’t saved/)
    // Approving one of yours records nothing: there's nothing to approve.
    const s = state()
    approveCommand(s, reset)
    expect(s.checkApprovals).toBeUndefined()
  })
})

describe('saved commands: the terminal launch', () => {
  it('starts in the workspace with the banner and the command typed in', () => {
    const c = mine({ id: 'reset', name: 'Reset test DB', command: 'npm run db:reset' })
    const launch = commandLaunch(c, { name: 'lisbon', path: path.resolve('/work/lisbon') }, t, () => true)
    expect(launch).toEqual({
      cwd: path.resolve('/work/lisbon'),
      input: 'npm run db:reset\r',
      notice: '▶ Reset test DB\r\n  npm run db:reset\r\n  in lisbon · its environment'
    })
  })

  it('starts in the command’s folder inside the workspace, and says so', () => {
    const c = mine({ id: 'seed', name: 'Seed demo data', command: 'npm run seed:demo', cwd: 'services/api' })
    const launch = commandLaunch(c, { name: 'lisbon', path: path.resolve('/work/lisbon') }, t, () => true)
    expect(launch.cwd).toBe(path.join(path.resolve('/work/lisbon'), 'services', 'api'))
    expect(launch.notice).toContain('in lisbon/services/api · its environment')
  })

  it('refuses a folder that is missing or outside the workspace', () => {
    const missing = mine({ id: 'm', name: 'M', cwd: 'nope' })
    expect(() => commandLaunch(missing, { name: 'lisbon', path: path.resolve('/work/lisbon') }, t, () => false)).toThrow(/nope/)
    const outside = mine({ id: 'o', name: 'O', cwd: '../other' })
    expect(() => commandLaunch(outside, { name: 'lisbon', path: path.resolve('/work/lisbon') }, t, () => true)).toThrow(/outside/)
  })

  it('types each line of a multi-line command with Enter, and shows the first in the banner', () => {
    expect(commandInput('npm ci\r\nnpm test\n\n')).toBe('npm ci\rnpm test\r')
    expect(commandBanner({ name: 'Fresh', command: 'npm ci\nnpm test' }, 'oslo', t)).toBe('▶ Fresh\r\n  npm ci …\r\n  in oslo · its environment')
    expect(commandBanner({ name: 'Fresh', command: 'npm ci' }, 'oslo', createT('es'))).toContain('en oslo · su entorno')
  })
})
