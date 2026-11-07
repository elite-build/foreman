// Personas (docs/loops-and-graphs.md, "Personas: who a step is"): the markdown reader, its strict frontmatter, Claude Code
// subagent files read as they are, applying a persona to a step (narrowing only), the starters, and a flow's checks of
// the personas its steps name.
import { describe, expect, it } from 'vitest'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import { flowPersonaProblems, parseFlow, stepPersona, type Flow } from '../src/shared/flows'
import { createT } from '../src/shared/i18n'
import { applyPersona, claudeAgentModel, findPersona, MAX_PERSONA_BYTES, parseFrontmatter, parsePersona, personaMarkdown, validatePersona, type Persona, type PersonaListing } from '../src/shared/personas'
import { PERSONA_STARTERS } from '../src/shared/personaStarters'

const QA = `---
name: qa-engineer
description: Reviews the change against what was asked; finds problems, never fixes them.
loadout: 3                 # Codex by default (slot 3): read-only, attended, no shell in a review; a step may override
read_only: true
shows: [diff, checks.results]
ends_with: [findings]
---
You are the QA engineer on this change.
`

function read(markdown: string, source: Persona['source'] = 'personal'): Persona {
  const parsed = parsePersona(markdown, source)
  if (!('persona' in parsed)) throw new Error(parsed.problems.join(' '))
  return parsed.persona
}

const problemsOf = (markdown: string, source: Persona['source'] = 'personal'): string[] => {
  const parsed = parsePersona(markdown, source)
  return 'problems' in parsed ? parsed.problems : []
}

describe('the frontmatter', () => {
  it('reads text, numbers, booleans, inline and block lists and block text, and drops comments', () => {
    const front = parseFrontmatter(`---\nname: "a # b"\nloadout: 2 # two\nread_only: false\nshows: [diff, 'note']\ntools:\n  - Read\n  - Grep\ndescription: |\n  Line one\n  line two\n---\nBody`)
    expect(front?.meta).toEqual({ name: 'a # b', loadout: 2, read_only: false, shows: ['diff', 'note'], tools: ['Read', 'Grep'], description: 'Line one\nline two' })
    expect(front?.body).toBe('Body')
    expect(front?.bad).toEqual([])
  })

  it('needs the opening --- on the first line and a closing --- on a line of its own', () => {
    expect(parseFrontmatter('name: x\n---\nbody')).toBeNull()
    expect(parseFrontmatter('---\nname: a---b\n')).toBeNull()
    expect(parseFrontmatter('﻿---\r\nname: x\r\n---\r\nbody')?.meta).toEqual({ name: 'x' })
  })

  it('names the lines that aren’t key: value, and keys given twice', () => {
    const front = parseFrontmatter('---\nname: x\njust words\nname: y\n---\n')
    expect(front?.bad).toEqual([3])
    expect(front?.twice).toEqual(['name'])
  })
})

describe('reading a persona', () => {
  it('reads the page’s qa-engineer as written', () => {
    expect(read(QA)).toEqual({
      name: 'qa-engineer',
      description: 'Reviews the change against what was asked; finds problems, never fixes them.',
      source: 'personal',
      loadout: 3,
      read_only: true,
      shows: ['diff', 'checks.results'],
      ends_with: ['findings'],
      instructions: 'You are the QA engineer on this change.'
    })
  })

  it('refuses what isn’t a persona, saying why', () => {
    expect(problemsOf('no frontmatter here')).toEqual([expect.stringContaining('between two --- lines')])
    expect(problemsOf('---\nname: has space\n---\nx')).toEqual([expect.stringContaining('needs a name')])
    expect(problemsOf('---\nname: a\nloadout: 0\n---\n')).toEqual(['“loadout” should be a whole number, 1 or more.'])
    expect(problemsOf('---\nname: a\nread_only: yes\n---\n')).toEqual(['“read_only” should be true or false.'])
    expect(problemsOf('---\nname: a\nshows: diff\n---\n')).toEqual(['“shows” should be a list, like [a, b].'])
    expect(problemsOf('---\nname: a\nends_with: [done, praise]\n---\n')).toEqual(['“ends_with” can’t include “praise”. Use: review, done, findings, plan.'])
    expect(problemsOf('---\nname: a\nagent: hal\n---\n')).toEqual(['Foreman doesn’t know the agent “hal”.'])
    expect(problemsOf('x'.repeat(MAX_PERSONA_BYTES + 1))).toEqual(['The file is larger than 32 KB, so it wasn’t read.'])
  })

  it('never lets a persona be shown another step’s section: it doesn’t know the flow', () => {
    expect(problemsOf('---\nname: a\nshows: [implement.answer]\n---\n')).toEqual([expect.stringContaining('can’t be shown “implement.answer”')])
  })

  it('warns about fields it doesn’t know and reads the rest', () => {
    const parsed = parsePersona('---\nname: a\ncolour: blue\n---\nHi', 'repo')
    expect('persona' in parsed && parsed.persona.instructions).toBe('Hi')
    expect(parsed.warnings).toEqual(['Foreman doesn’t know “colour”, so it is ignored.'])
  })

  it('speaks the language asked for', () => {
    const parsed = parsePersona('---\nname: a\nread_only: maybe\n---\n', 'personal', createT('de'))
    expect('problems' in parsed && parsed.problems).toEqual(['„read_only“ sollte true oder false sein.'])
  })

  it('round-trips through the document the editor writes', () => {
    const qa = read(QA)
    expect(read(personaMarkdown(qa))).toEqual(qa)
    expect(validatePersona(qa)).toEqual([])
    expect(validatePersona({ ...qa, name: 'no spaces allowed' })).toEqual([expect.stringContaining('needs a name')])
  })
})

describe('a Claude Code subagent file', () => {
  const AGENT = `---
name: code-reviewer
description: Reviews code for quality and security.
model: sonnet
tools: Read, Grep, Glob
color: purple
---
You are a senior code reviewer.`

  it('offers its name, description and model for Claude steps, and keeps its tools without applying them', () => {
    const parsed = parsePersona(AGENT, 'claude-agents', undefined, { file: '.claude/agents/code-reviewer.md', rev: 'abc' })
    expect(parsed.warnings).toEqual([])
    expect('persona' in parsed && parsed.persona).toEqual({
      name: 'code-reviewer',
      description: 'Reviews code for quality and security.',
      source: 'claude-agents',
      file: '.claude/agents/code-reviewer.md',
      rev: 'abc',
      agent: 'claude',
      model: 'claude-sonnet-5-5[1m]',
      tools: 'Read, Grep, Glob',
      instructions: 'You are a senior code reviewer.'
    })
  })

  it('takes its name from the file when it has none, and reads past lines it doesn’t understand', () => {
    const parsed = parsePersona('---\ndescription: x\n  odd: indent\n---\nBody', 'claude-agents', undefined, { file: '.claude/agents/helper.md' })
    expect('persona' in parsed && parsed.persona.name).toBe('helper')
  })

  it('maps Claude Code’s model aliases, and inherit to the step’s own', () => {
    expect(claudeAgentModel('opus')).toBe('claude-opus-5-5[1m]')
    expect(claudeAgentModel('haiku')).toBe('claude-haiku-5-5')
    expect(claudeAgentModel('inherit')).toBeUndefined()
    expect(claudeAgentModel(undefined)).toBeUndefined()
    expect(claudeAgentModel('claude-custom-1')).toBe('claude-custom-1')
  })
})

describe('scoped writes on a persona', () => {
  it('reads writes as globs inside the workspace, shows it in the document, and refuses a path outside', () => {
    const pm = read('---\nname: product-manager\nloadout: 2\nwrites: [docs/features/**, "notes/*.md"]\n---\nDecide what to build.')
    expect(pm.writes).toEqual(['docs/features/**', 'notes/*.md'])
    expect(personaMarkdown(pm)).toContain('writes: ["docs/features/**", "notes/*.md"]')
    expect(read(personaMarkdown(pm)).writes).toEqual(pm.writes)
    expect(validatePersona(pm)).toEqual([])
    for (const bad of ['/etc/**', '../outside/**', 'C:/work/**', 'docs//a.md'])
      expect(problemsOf(`---\nname: x\nwrites: [${JSON.stringify(bad)}]\n---\n`)).toEqual([`“${bad}” in writes isn’t a path inside the workspace: write globs relative to its root, such as docs/features/**.`])
    expect(problemsOf('---\nname: x\nwrites: docs/**\n---\n')).toEqual(['“writes” should be a list, like [a, b].'])
  })

  it('warns that writes does nothing on a read-only persona', () => {
    const parsed = parsePersona('---\nname: x\nread_only: true\nwrites: [docs/**]\n---\n', 'personal')
    expect('persona' in parsed && parsed.warnings).toEqual(['writes has no effect: the persona is read-only, so it writes nothing.'])
  })
})

describe('applying a persona to a step: narrowing only', () => {
  const qa = read(QA)
  const step = { name: 'qa' }

  it('gives the step the persona’s loadout, read-only and what it is shown', () => {
    expect(applyPersona(step, qa)).toEqual({ loadout: 3, readOnly: true, context: ['diff', 'checks.results'], endsWith: ['findings'], problems: [] })
  })

  it('lets the step override the loadout and add to what it is shown, without repeating a source', () => {
    const applied = applyPersona({ ...step, loadout: 2, context: ['checks.results', 'task'] }, qa)
    expect(applied).toMatchObject({ loadout: 2, context: ['diff', 'checks.results', 'task'], problems: [] })
    expect(applyPersona({ ...step, agent: 'claude', model: 'claude-haiku-5-5' }, qa)).toMatchObject({ agent: 'claude', model: 'claude-haiku-5-5' })
    expect(applyPersona({ ...step, agent: 'claude' }, qa).loadout).toBeUndefined()
  })

  it('never turns a read-only persona’s read-only off', () => {
    const applied = applyPersona({ ...step, read_only: false }, qa)
    expect(applied.readOnly).toBe(true)
    expect(applied.problems).toEqual(['Step “qa” sets read_only = false, but its persona “qa-engineer” is read-only, and a step can’t turn that off.'])
    // A step can turn it on for a persona that edits.
    expect(applyPersona({ ...step, read_only: true }, read('---\nname: dev\n---\n')).readOnly).toBe(true)
  })

  it('keeps only the persona’s MCP servers, fewer when the step says so, never one it doesn’t keep', () => {
    const narrow = read('---\nname: narrow\nmcp: [github, docs]\n---\n')
    expect(applyPersona(step, narrow).mcp).toEqual(['github', 'docs'])
    expect(applyPersona({ ...step, mcp: ['docs'] }, narrow)).toMatchObject({ mcp: ['docs'], problems: [] })
    const wider = applyPersona({ ...step, mcp: ['docs', 'shell'] }, narrow)
    expect(wider.mcp).toEqual(['docs'])
    expect(wider.problems).toEqual(['Step “qa” keeps MCP servers its persona “narrow” doesn’t: shell. A step can only keep fewer.'])
    // No persona list: every server, unless the step itself narrows.
    expect(applyPersona(step, qa).mcp).toBeUndefined()
    expect(applyPersona({ ...step, mcp: [] }, undefined).mcp).toEqual([])
  })

  it('scopes writes to the persona’s globs; a step may narrow them, never widen them, and read-only drops them', () => {
    const pm = read('---\nname: pm\nwrites: [docs/features/**]\n---\n')
    expect(applyPersona(step, pm)).toMatchObject({ readOnly: false, writes: ['docs/features/**'], problems: [] })
    expect(applyPersona({ ...step, writes: ['docs/features/search/**'] }, pm)).toMatchObject({ writes: ['docs/features/search/**'], problems: [] })
    const wider = applyPersona({ ...step, writes: ['docs/**', 'docs/features/a.md'] }, pm)
    expect(wider.writes).toEqual(['docs/features/a.md'])
    expect(wider.problems).toEqual(['Step “qa” writes to docs/**, outside what its persona “pm” may write (docs/features/**). A step can only narrow it.'])
    // A persona with none: the step may scope its own; a read-only turn writes nothing at all.
    expect(applyPersona({ ...step, writes: ['notes/**'] }, undefined).writes).toEqual(['notes/**'])
    expect(applyPersona({ ...step, read_only: true }, pm).writes).toBeUndefined()
    expect(applyPersona(step, qa).writes).toBeUndefined()
  })

  it('falls back to a subagent’s agent and model when the step names none', () => {
    const agent = read('---\nname: r\nmodel: opus\n---\nx', 'claude-agents')
    expect(applyPersona(step, agent)).toMatchObject({ agent: 'claude', model: 'claude-opus-5-5[1m]' })
  })
})

describe('the starters', () => {
  it('each read with no warnings, and the architect, QA, designer and the reviewers are read-only', () => {
    for (const s of PERSONA_STARTERS) {
      const parsed = parsePersona(s.markdown, 'built-in')
      expect('persona' in parsed && parsed.warnings, s.name).toEqual([])
      expect(validatePersona(read(s.markdown, 'built-in')), s.name).toEqual([])
    }
    const personas = PERSONA_STARTERS.map((s) => read(s.markdown, 'built-in'))
    expect(personas.map((p) => p.name)).toEqual(['architect', 'developer', 'qa-engineer', 'designer', 'product-manager', 'ux-designer', 'security-reviewer', 'docs-writer', 'researcher', 'research-reviewer'])
    expect(personas.map((p) => Boolean(p.read_only))).toEqual([true, false, true, true, false, false, true, false, false, true])
    // The ones that write are scoped to the documents they own.
    expect(Object.fromEntries(personas.filter((p) => p.writes).map((p) => [p.name, p.writes]))).toEqual({
      'product-manager': ['docs/features/**'],
      'ux-designer': ['docs/features/**'],
      'docs-writer': ['docs/**'],
      researcher: ['docs/research/**']
    })
    expect(personas.find((p) => p.name === 'product-manager')).toMatchObject({ loadout: 2, shows: ['task', 'tree', 'note'], ends_with: ['done'] })
    expect(personas.find((p) => p.name === 'security-reviewer')).toMatchObject({ shows: ['diff', 'checks.results'], ends_with: ['findings'] })
    expect(personas.find((p) => p.name === 'research-reviewer')).toMatchObject({ shows: ['task'], ends_with: ['findings'] })
    expect(personas.find((p) => p.name === 'researcher')).toMatchObject({ loadout: 1 })
    expect(personas.find((p) => p.name === 'architect')).toMatchObject({ shows: ['task', 'tree'], ends_with: ['plan'] })
    expect(personas.find((p) => p.name === 'developer')).toMatchObject({ shows: ['task', 'checks.results'], ends_with: ['done'] })
    expect(personas.find((p) => p.name === 'designer')).toMatchObject({ shows: ['diff', 'note'], ends_with: ['findings'] })
    // The qa-engineer is the page's file, as written there.
    expect(PERSONA_STARTERS.find((s) => s.name === 'qa-engineer')!.markdown.startsWith(QA.split('\n').slice(0, 9).join('\n'))).toBe(true)
  })

  it('cover every persona the starter flows name', () => {
    const names = new Set(PERSONA_STARTERS.map((s) => s.name as string))
    for (const starter of FLOW_STARTERS) {
      const parsed = parseFlow(starter.toml, 'built-in')
      if (!('flow' in parsed)) throw new Error(parsed.problems.join(' '))
      for (const step of parsed.flow.steps) if ('persona' in step && step.persona) expect(names.has(step.persona)).toBe(true)
    }
  })
})

describe('which persona a name means', () => {
  const listing = (source: PersonaListing['source'], repoId?: string): PersonaListing => {
    const persona = { ...read(QA), source }
    return { id: `${source}:${repoId ?? ''}`, source, name: persona.name, ...(repoId ? { repoId } : {}), markdown: QA, persona, problems: [], warnings: [] }
  }

  it('finds yours first, then the repository’s, its .claude/agents, then the built-in one', () => {
    const all = [listing('built-in'), listing('claude-agents', 'r1'), listing('repo', 'r1'), listing('personal')]
    expect(findPersona(all, 'QA-Engineer', 'r1')?.source).toBe('personal')
    expect(findPersona(all.slice(0, 3), 'qa-engineer', 'r1')?.source).toBe('repo')
    expect(findPersona(all.slice(0, 2), 'qa-engineer', 'r1')?.source).toBe('claude-agents')
    // Another repository's files don't count.
    expect(findPersona(all.slice(0, 3), 'qa-engineer', 'r2')?.source).toBe('built-in')
    expect(findPersona(all, 'nobody', 'r1')).toBeUndefined()
  })
})

describe('a flow’s personas', () => {
  const FLOW = `name = "F"
[start]
step = "build"
[steps.build]
kind = "turn"
prompt = "x"
persona = "qa-engineer"
read_only = false
[steps.fix]
kind = "turn"
prompt = "y"
same_tab = "build"
[steps.other]
kind = "turn"
prompt = "z"
persona = "ghost"
[edges]
build = "fix"
fix = "other"
`
  const flowOf = (toml: string): Flow => {
    const parsed = parseFlow(toml, 'personal')
    if (!('flow' in parsed)) throw new Error(parsed.problems.join(' '))
    return parsed.flow
  }

  it('a step continuing another’s tab runs as that step’s persona', () => {
    const flow = flowOf(FLOW)
    expect(flow.steps.map((s) => stepPersona(flow, s))).toEqual(['qa-engineer', 'qa-engineer', 'ghost'])
  })

  it('names a persona that isn’t there and a step that loosens one, when the personas are known', () => {
    const qa = read(QA)
    const lookup = (name: string) => (name === 'qa-engineer' ? qa : undefined)
    expect(flowPersonaProblems(flowOf(FLOW), lookup)).toEqual([
      'Step “build” sets read_only = false, but its persona “qa-engineer” is read-only, and a step can’t turn that off.',
      expect.stringContaining('Step “other” runs as the persona “ghost”, which isn’t here')
    ])
    // Without the personas the flow still reads; with them, they are errors.
    expect('flow' in parseFlow(FLOW, 'personal')).toBe(true)
    expect('problems' in parseFlow(FLOW, 'personal', undefined, lookup)).toBe(true)
  })

  it('reads read_only and mcp on a step, and refuses a read_only that isn’t a boolean', () => {
    const flow = flowOf(FLOW.replace('read_only = false', 'read_only = true\nmcp = ["docs"]'))
    expect(flow.steps[0]).toMatchObject({ read_only: true, mcp: ['docs'] })
    const bad = parseFlow(FLOW.replace('read_only = false', 'read_only = "no"'), 'personal')
    expect('problems' in bad && bad.problems).toContain('Step “build”: “read_only” should be true or false.')
  })
})
