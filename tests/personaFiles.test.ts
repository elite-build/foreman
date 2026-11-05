// A repository's personas: .foreman/personas/*.md and its Claude Code subagents in .claude/agents/*.md, read-only,
// bounded and cached like flow files, a bad file listed with its problems; the combined list Automations shows; and the
// flows listed with the personas they name resolved, a missing one a problem on the flow.
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listFlows, revalidateRepoFlows } from '../src/main/flowFiles'
import { listPersonas, readRepoPersonas, revalidateRepoPersonas } from '../src/main/personaFiles'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import { CLAUDE_AGENTS_DIR, MAX_PERSONA_BYTES, MAX_REPO_PERSONAS, PERSONA_DIR, type PersonalPersona } from '../src/shared/personas'
import { makeRepo } from './helpers'

const REVIEWER = `---
name: reviewer
read_only: true
shows: [diff]
ends_with: [findings]
---
You review; you don't fix.
`

const SUBAGENT = `---
name: code-reviewer
description: Reviews code.
model: haiku
tools: Read, Grep
---
You are a careful reviewer.
`

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await makeRepo()
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await writeFile(path.join(dir, file), content)
  }
  return dir
}

const personal = (id: string, markdown: string): PersonalPersona => ({ id, markdown, createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T01:00:00.000Z' })

afterEach(() => {
  revalidateRepoPersonas()
  revalidateRepoFlows()
})

describe('repository persona files', () => {
  it('reads .foreman/personas then .claude/agents, each in name order, with the blob SHA as the revision', async () => {
    const dir = await repoWith({ [`${PERSONA_DIR}/reviewer.md`]: REVIEWER, [`${PERSONA_DIR}/notes.txt`]: 'ignored', [`${CLAUDE_AGENTS_DIR}/code-reviewer.md`]: SUBAGENT })
    const list = readRepoPersonas('r1', dir)
    expect(list.map((p) => [p.source, p.file, p.name])).toEqual([
      ['repo', '.foreman/personas/reviewer.md', 'reviewer'],
      ['claude-agents', '.claude/agents/code-reviewer.md', 'code-reviewer']
    ])
    expect(list[0]).toMatchObject({ id: 'repo:r1:.foreman/personas/reviewer.md', repoId: 'r1', rev: expect.stringMatching(/^[0-9a-f]{40}$/), persona: { read_only: true, file: '.foreman/personas/reviewer.md' } })
    // A Claude Code subagent is offered for Claude steps as it is: its model mapped, its tools kept and not applied.
    expect(list[1].persona).toMatchObject({ source: 'claude-agents', agent: 'claude', model: 'claude-haiku-5-5', tools: 'Read, Grep', description: 'Reviews code.' })
    expect(list[1].persona?.read_only).toBeUndefined()
  })

  it('lists a file that isn’t a persona by its file name with its problems, and one too large without reading it', async () => {
    const dir = await repoWith({ [`${PERSONA_DIR}/broken.md`]: 'just words', [`${PERSONA_DIR}/huge.md`]: `---\nname: huge\n---\n${'x'.repeat(MAX_PERSONA_BYTES)}` })
    const [broken, huge] = readRepoPersonas('r2', dir)
    expect(broken).toMatchObject({ name: 'broken', problems: [expect.stringContaining('between two --- lines')] })
    expect(broken.persona).toBeUndefined()
    expect(huge).toMatchObject({ name: 'huge', markdown: '', problems: [`The file is larger than ${MAX_PERSONA_BYTES / 1024} KB, so it wasn’t read.`] })
  })

  it('reads at most MAX_REPO_PERSONAS files a folder, only regular files, and nothing when there is no folder', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < MAX_REPO_PERSONAS + 2; i++) files[`${PERSONA_DIR}/p${String(i).padStart(3, '0')}.md`] = REVIEWER.replace('reviewer', `p${i}`)
    const dir = await repoWith(files)
    expect(readRepoPersonas('r3', dir)).toHaveLength(MAX_REPO_PERSONAS)
    const other = await repoWith({ [`${PERSONA_DIR}/z.md`]: REVIEWER })
    await mkdir(path.join(other, PERSONA_DIR, 'a-dir.md'))
    // A link could point outside the repository; it isn't followed (where links can be made).
    await symlink(path.join(other, PERSONA_DIR, 'z.md'), path.join(other, PERSONA_DIR, 'link.md')).catch(() => undefined)
    expect(readRepoPersonas('r4', other).map((p) => p.file)).toEqual(['.foreman/personas/z.md'])
    expect(readRepoPersonas('r5', path.join(other, 'nowhere'))).toEqual([])
  })
})

describe('listPersonas', () => {
  it('lists the built-in ones, then each repository’s files, then personal ones', async () => {
    const dir = await repoWith({ [`${PERSONA_DIR}/reviewer.md`]: REVIEWER })
    const list = listPersonas([{ id: 'r1', rootPath: dir }], [personal('persona-1', REVIEWER.replace('name: reviewer', 'name: mine')), personal('persona-2', 'broken')])
    expect(list.map((p) => [p.source, p.name])).toEqual([
      ['built-in', 'architect'],
      ['built-in', 'developer'],
      ['built-in', 'qa-engineer'],
      ['built-in', 'designer'],
      ['repo', 'reviewer'],
      ['personal', 'mine'],
      ['personal', 'persona-2']
    ])
    expect(list[0]).toMatchObject({ id: 'built-in:architect', problems: [] })
    expect(list[5]).toMatchObject({ id: 'persona-1', rev: '2026-11-05T01:00:00.000Z', persona: { source: 'personal' } })
    expect(list[6].problems.length).toBeGreaterThan(0)
    // One repository's files only.
    expect(listPersonas([{ id: 'r1', rootPath: dir }], [], undefined, 'other').filter((p) => p.source === 'repo')).toEqual([])
  })
})

describe('flows with their personas resolved', () => {
  it('names each persona a flow uses as found, and a missing one or a loosened one as a problem on the flow', async () => {
    const flow = `name = "Team"
[start]
step = "look"
[steps.look]
kind = "turn"
prompt = "Look."
persona = "reviewer"
[steps.again]
kind = "turn"
prompt = "Again."
persona = "nobody"
[steps.edit]
kind = "turn"
prompt = "Edit."
persona = "reviewer"
read_only = false
[edges]
look = "again"
again = "edit"
`
    const dir = await repoWith({ [`${PERSONA_DIR}/reviewer.md`]: REVIEWER, '.foreman/flows/team.toml': flow })
    const repos = [{ id: 'r1', rootPath: dir }]
    const personas = listPersonas(repos, [])
    const flows = listFlows(repos, [], undefined, undefined, personas)
    const team = flows.find((f) => f.name === 'Team')!
    expect(team.personas).toEqual([{ name: 'reviewer', source: 'repo', file: '.foreman/personas/reviewer.md', rev: expect.stringMatching(/^[0-9a-f]{40}$/), readOnly: true }])
    expect(team.problems).toEqual([expect.stringContaining('Step “again” runs as the persona “nobody”'), expect.stringContaining('Step “edit” sets read_only = false')])
    // The summary stands, so the list can still say what the flow is.
    expect(team.summary).toMatchObject({ steps: 3, personas: ['reviewer', 'nobody'] })
    // The starters' personas are built in, so they have no persona problems.
    const starter = flows.find((f) => f.starter === FLOW_STARTERS[0].id)!
    expect(starter.problems).toEqual([])
    expect(starter.personas?.map((p) => [p.name, p.source])).toEqual([
      ['developer', 'built-in'],
      ['qa-engineer', 'built-in']
    ])
    // A personal persona of the same name is the one a flow uses.
    const mine = listPersonas(repos, [personal('persona-1', REVIEWER.replace('read_only: true', 'read_only: false'))])
    const again = listFlows(repos, [], undefined, undefined, mine).find((f) => f.name === 'Team')!
    expect(again.personas?.[0]).toMatchObject({ name: 'reviewer', source: 'personal' })
    expect(again.problems).toHaveLength(1)
  })
})
