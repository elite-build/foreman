// `foreman persona list | show | add | remove`: the command table, the app's side (behind Settings → Experimental →
// Flows, personal personas only for add and remove, a name meaning the persona a step would run as), and the flow
// commands naming each persona with where it comes from.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { personaRunners } from '../src/cli/commands/personas'
import { renderCommandHelp } from '../src/cli/help'
import { FLOW_METHODS, FLOWS_OFF, personaRefText } from '../src/main/cli/flows'
import type { CliContext } from '../src/main/cli/methods'
import { PERSONA_METHODS } from '../src/main/cli/personas'
import { CliCodedError } from '../src/main/cliServer'
import { listFlows } from '../src/main/flowFiles'
import { listPersonas, personalPersonaListing } from '../src/main/personaFiles'
import { defaultSettings } from '../src/main/store'
import type { FlowShowResult } from '../src/shared/cli/flows'
import type { PersonaAddResult, PersonaListResult, PersonaRemoveResult, PersonaShowResult } from '../src/shared/cli/personas'
import { COMMANDS, commandName, findCommand } from '../src/shared/cliCommands'
import { PERSONA_COMMANDS } from '../src/shared/cliCommandsAutomations'
import type { PersonalFlow } from '../src/shared/flows'
import type { PersonalPersona } from '../src/shared/personas'
import type { Repo, Settings } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'

const root = path.resolve('/tmp/foreman-cli-personas/repo')
const repo = { id: 'r1', name: 'api', rootPath: root, defaultBranch: 'main' } as Repo
const ctx: CliContext = { request: { method: 'x' } as CliContext['request'], caller: undefined, signal: undefined, progress: () => undefined }

const MINE = `---
name: qa-engineer
read_only: true
shows: [diff]
ends_with: [findings]
---
Only find.
`

const FLOW = `name = "Checked"
[start]
step = "look"
[steps.look]
kind = "turn"
prompt = "Look."
persona = "qa-engineer"
`

const personal = (id: string, markdown: string): PersonalPersona => ({ id, markdown, createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T01:00:00.000Z' })

function rig(over: { settings?: Partial<Settings>; personas?: PersonalPersona[] } = {}) {
  const settings = { ...defaultSettings(), flows: true, ...over.settings }
  let mine = over.personas ?? [personal('persona-qa', MINE)]
  const flows: PersonalFlow[] = [{ id: 'flow-checked', toml: FLOW, createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' }]
  const calls: [string, ...unknown[]][] = []
  const api = fakeApi({
    listPersonas: async () => ({ personas: listPersonas([], mine), mcpServers: [] }),
    listFlows: async () => listFlows([], flows, undefined, undefined, listPersonas([], mine)),
    savePersonalPersona: async (input) => {
      calls.push(['savePersonalPersona', input])
      const listing = personalPersonaListing(personal('persona-new', input.markdown))
      return listing.problems.length ? { problems: listing.problems } : { persona: listing }
    },
    deletePersonalPersona: async (id) => {
      calls.push(['deletePersonalPersona', id])
      mine = mine.filter((p) => p.id !== id)
    }
  })
  const host = stubHost({ api, state: () => ({ repos: [repo], workspaces: [], sessions: [], settings }) })
  const call = async <T>(method: string, params?: unknown): Promise<T> => (await (PERSONA_METHODS[method] ?? FLOW_METHODS[method]).handle(host, params, ctx)) as T
  return { call, calls }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(CliCodedError)
  return err as CliCodedError
}

describe('the persona command table', () => {
  it('declares list, show, add and remove beside the flows, each with help and an example, reads in read and the rest in act', () => {
    expect(PERSONA_COMMANDS.map(commandName)).toEqual(['persona list', 'persona show', 'persona add', 'persona remove'])
    for (const spec of PERSONA_COMMANDS) {
      const name = commandName(spec)
      expect(COMMANDS, name).toContain(spec)
      expect(spec.usage.startsWith(`foreman ${name}`), name).toBe(true)
      const help = renderCommandHelp(spec)
      for (const option of Object.keys(spec.options)) expect(help, `${name} --${option}`).toContain(`--${option}`)
      for (const example of spec.examples ?? []) expect(findCommand(example.split(' ').slice(1)), example).toMatchObject({ spec })
    }
    expect(Object.keys(personaRunners).sort()).toEqual(PERSONA_COMMANDS.map(commandName).sort())
    expect(Object.fromEntries(PERSONA_COMMANDS.map((c) => [commandName(c), c.tier]))).toEqual({ 'persona list': 'read', 'persona show': 'read', 'persona add': 'act', 'persona remove': 'act' })
    expect(Object.fromEntries(Object.entries(PERSONA_METHODS).map(([m, d]) => [m, d.tier]))).toEqual({ 'persona-list': 'read', 'persona-show': 'read', 'persona-add': 'act', 'persona-remove': 'act' })
  })
})

describe('persona methods', () => {
  it('refuse while Flows are off, naming the setting', async () => {
    const { call } = rig({ settings: { flows: false } })
    for (const method of Object.keys(PERSONA_METHODS)) {
      const err = await failure(call(method, { persona: 'qa-engineer', cwd: root, markdown: MINE }))
      expect(err.code, method).toBe('refused')
      expect(err.message, method).toBe(FLOWS_OFF)
    }
  })

  it('list: each persona with its source and what it is, and one another comes before', async () => {
    const { call } = rig()
    const result = await call<PersonaListResult>('persona-list', { cwd: root })
    expect(result.personas.map((p) => `${p.source}:${p.name}`)).toEqual(['built-in:architect', 'built-in:developer', 'built-in:qa-engineer', 'built-in:designer', 'personal:qa-engineer'])
    expect(result.personas.find((p) => p.id === 'built-in:qa-engineer')).toMatchObject({ readOnly: true, loadout: 3, endsWith: ['review', 'done'], shadowedBy: 'persona-qa' })
    expect(result.text.split('\n')[0]).toMatch(/^NAME\s+SOURCE\s+FILE\s+REV\s+WHAT IT IS$/)
    expect(result.text).toMatch(/architect\s+built-in\s+read-only · ends with plan/)
    expect(result.text).toContain('  not used: your personal persona of the same name comes first')
  })

  it('show: a name means the persona a step would run as, with the flows that name it and the document', async () => {
    const { call } = rig()
    const mine = await call<PersonaShowResult>('persona-show', { persona: 'qa-engineer', cwd: root })
    expect(mine.persona).toMatchObject({ id: 'persona-qa', source: 'personal' })
    expect(mine.usedBy).toEqual(['Fix until green', 'Research then implement', 'Checked'])
    expect(mine.text).toContain('What it is: read-only · ends with findings')
    expect(mine.text).toContain('MCP servers: every one the repository and integrations give')
    expect(mine.markdown).toBe(MINE)
    const builtIn = await call<PersonaShowResult>('persona-show', { persona: 'built-in:qa-engineer', cwd: root })
    expect(builtIn.text).toContain('Not used: your personal persona of the same name comes first.')
    expect((await failure(call('persona-show', { persona: 'nobody', cwd: root }))).code).toBe('not-found')
  })

  it('add: saves a personal persona, or lists its problems and saves nothing', async () => {
    const { call, calls } = rig()
    const saved = await call<PersonaAddResult>('persona-add', { markdown: MINE.replace('qa-engineer', 'finder') })
    expect(saved).toMatchObject({ saved: true, persona: { name: 'finder', source: 'personal' } })
    expect(saved.text).toBe('Saved the personal persona “finder” (id persona-new).')
    const broken = await call<PersonaAddResult>('persona-add', { markdown: 'just words' })
    expect(broken.saved).toBe(false)
    expect(broken.text).toContain('Not saved: the persona has a problem.')
    expect(calls).toHaveLength(2)
  })

  it('remove: personal personas only', async () => {
    const { call, calls } = rig()
    const removed = await call<PersonaRemoveResult>('persona-remove', { persona: 'qa-engineer' })
    expect(removed.removed).toMatchObject({ id: 'persona-qa' })
    expect(calls).toEqual([['deletePersonalPersona', 'persona-qa']])
    // Now the name means the built-in one, which can't be removed here.
    const builtIn = await failure(call('persona-remove', { persona: 'qa-engineer' }))
    expect(builtIn.code).toBe('refused')
    expect(builtIn.message).toContain('built into Foreman')
  })
})

describe('flow commands name the personas', () => {
  it('flow show lists each persona with where it comes from', async () => {
    const { call } = rig()
    const result = await call<FlowShowResult>('flow-show', { flow: 'Checked', cwd: root })
    expect(result.text).toContain('Persona qa-engineer (personal, saved 2026-11-05, read-only)')
  })

  it('says where a persona comes from and its revision', () => {
    expect(personaRefText({ name: 'developer', source: 'built-in' })).toBe('developer (built-in)')
    expect(personaRefText({ name: 'reviewer', source: 'repo', file: '.foreman/personas/reviewer.md', rev: '0123456789abcdef', readOnly: true })).toBe('reviewer (.foreman/personas/reviewer.md at 0123456, read-only)')
    expect(personaRefText({ name: 'helper', source: 'claude-agents', file: '.claude/agents/helper.md', rev: 'fedcba9876543210' })).toBe('helper (.claude/agents/helper.md at fedcba9)')
  })
})
