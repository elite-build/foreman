// A repository's .foreman/flows: read-only, bounded, cached by each file's time and size, and a bad file is listed with
// its problems rather than thrown. Also the combined list Automations shows.
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listFlows, readRepoFlows, revalidateRepoFlows } from '../src/main/flowFiles'
import { git } from '../src/main/git'
import { FLOW_STARTERS } from '../src/shared/flowStarters'
import { MAX_FLOW_BYTES, MAX_REPO_FLOWS } from '../src/shared/flows'
import { makeRepo } from './helpers'

const GOOD = FLOW_STARTERS[0].toml

async function repoWithFlows(files: Record<string, string>): Promise<string> {
  const dir = await makeRepo()
  await mkdir(path.join(dir, '.foreman/flows'), { recursive: true })
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, '.foreman/flows', name), content)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  revalidateRepoFlows()
})

describe('repository flow files', () => {
  it('reads .toml files in name order, with the blob SHA git gives as the revision', async () => {
    const dir = await repoWithFlows({ 'b-fix.toml': GOOD, 'a-notes.md': 'ignored', 'c.TOML': GOOD.replace('Fix until green', 'Shouting') })
    const files = readRepoFlows('r1', dir)
    expect(files.map((f) => f.file)).toEqual(['.foreman/flows/b-fix.toml', '.foreman/flows/c.TOML'])
    expect(files[0].id).toBe('repo:r1:.foreman/flows/b-fix.toml')
    expect(files[0].rev).toBe((await git(dir, ['hash-object', '.foreman/flows/b-fix.toml'])).stdout.trim())
    expect('flow' in files[0].parsed && files[0].parsed.flow.name).toBe('Fix until green')
    expect('flow' in files[1].parsed && files[1].parsed.flow.source).toBe('repo')
  })

  it('lists a repository without the folder as having none', async () => {
    const dir = await makeRepo()
    expect(readRepoFlows('r2', dir)).toEqual([])
    expect(readRepoFlows('r3', path.join(dir, 'nowhere'))).toEqual([])
  })

  it('reports bad TOML and a broken graph as problems, never throwing', async () => {
    const dir = await repoWithFlows({ 'broken.toml': 'name = "x"\n[steps\n', 'graph.toml': GOOD.replace('implement = "checks"', 'implement = "nowhere"') })
    const [broken, graph] = readRepoFlows('r4', dir)
    expect('problems' in broken.parsed && broken.parsed.problems[0]).toMatch(/^This isn’t valid TOML/)
    expect('problems' in graph.parsed && graph.parsed.problems).toContain('The edge from “implement” goes to “nowhere”, which is neither a step nor done.')
  })

  it('does not read a file over the size limit, and says so', async () => {
    const dir = await repoWithFlows({ 'huge.toml': `# ${'x'.repeat(MAX_FLOW_BYTES)}\n${GOOD}` })
    const [huge] = readRepoFlows('r5', dir)
    expect(huge.toml).toBe('')
    expect(huge.rev).toBe('')
    expect('problems' in huge.parsed && huge.parsed.problems).toEqual([`The file is larger than ${MAX_FLOW_BYTES / 1024} KB, so it wasn’t read.`])
  })

  it('reads at most the first MAX_REPO_FLOWS files, and skips a folder named like one', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < MAX_REPO_FLOWS + 3; i++) files[`f${String(i).padStart(3, '0')}.toml`] = GOOD
    const dir = await repoWithFlows(files)
    expect(readRepoFlows('r6', dir)).toHaveLength(MAX_REPO_FLOWS)
    const other = await repoWithFlows({ 'z.toml': GOOD })
    await mkdir(path.join(other, '.foreman/flows/a-dir.toml'))
    expect(readRepoFlows('r7', other).map((f) => f.file)).toEqual(['.foreman/flows/z.toml'])
  })

  it('reads a file again only when its size or time changes', async () => {
    const dir = await repoWithFlows({ 'f.toml': GOOD })
    const file = path.join(dir, '.foreman/flows/f.toml')
    // Whole seconds, so setting the time again gives exactly the same stamp.
    const when = new Date('2026-11-01T00:00:00Z')
    await utimes(file, when, when)
    expect(readRepoFlows('r8', dir)[0].toml).toBe(GOOD)
    // Same size, same time: the cached text stands.
    const same = GOOD.replace('Fix until green', 'Fix until grain')
    await writeFile(file, same)
    await utimes(file, when, when)
    expect(readRepoFlows('r8', dir)[0].toml).toBe(GOOD)
    // A new time: read again.
    await utimes(file, when, new Date(when.getTime() + 5000))
    expect(readRepoFlows('r8', dir)[0].toml).toBe(same)
    // A new size: read again.
    await writeFile(file, `${same}\n`)
    expect(readRepoFlows('r8', dir)[0].toml).toBe(`${same}\n`)
  })

  it('with maxAgeMs, reuses a recent listing until it is older or revalidated', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'))
    const dir = await repoWithFlows({ 'a.toml': GOOD })
    expect(readRepoFlows('r9', dir, undefined, { maxAgeMs: 3000 })).toHaveLength(1)
    await writeFile(path.join(dir, '.foreman/flows/b.toml'), GOOD)
    vi.setSystemTime(new Date('2026-11-05T10:00:02Z'))
    expect(readRepoFlows('r9', dir, undefined, { maxAgeMs: 3000 })).toHaveLength(1)
    revalidateRepoFlows()
    expect(readRepoFlows('r9', dir, undefined, { maxAgeMs: 3000 })).toHaveLength(2)
  })
})

describe('listFlows', () => {
  it('lists built-in starters, then repository files, then personal flows, each with a summary or problems', async () => {
    const dir = await repoWithFlows({ 'mine.toml': GOOD.replace('Fix until green', 'Team flow'), 'bad.toml': 'nope' })
    const personal = [
      { id: 'flow-1', toml: FLOW_STARTERS[1].toml.replace('Research then implement', 'My research'), createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T01:00:00.000Z' },
      { id: 'flow-2', toml: 'name = "Broken"', createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' }
    ]
    const list = listFlows([{ id: 'r1', rootPath: dir }], personal)
    expect(list.map((f) => [f.source, f.name])).toEqual([
      ['built-in', 'Fix until green'],
      ['built-in', 'Research then implement'],
      ['repo', 'bad'],
      ['repo', 'Team flow'],
      ['personal', 'My research'],
      ['personal', 'flow-2']
    ])
    expect(list[0]).toMatchObject({ id: 'built-in:fix-until-green', starter: 'fix-until-green', summary: { steps: 6, loops: 2, gates: 1 }, problems: [] })
    expect(list[2].problems).toHaveLength(1)
    expect(list[2].summary).toBeUndefined()
    expect(list[3]).toMatchObject({ repoId: 'r1', file: '.foreman/flows/mine.toml', rev: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(list[4]).toMatchObject({ id: 'flow-1', rev: '2026-11-05T01:00:00.000Z', summary: { steps: 7 } })
    expect(list[5].problems.length).toBeGreaterThan(0)
    // One repository's files only.
    expect(listFlows([{ id: 'r1', rootPath: dir }], [], undefined, 'other').filter((f) => f.source === 'repo')).toEqual([])
  })
})
