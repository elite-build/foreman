// What waits for a person from an organization's employees, as one ordered list of decisions, and the pure rules the
// decision cards and a draft's plan read (shared/employeeDecisions.ts): which proposals are the whole organization's,
// which of a run's decisions its workspace shows, what a definition lets an employee do in groups (only what is true
// for it), what changed since approval and whether it widens anything, and a remote's URL without secrets.
import { describe, expect, it } from 'vitest'
import { remoteWhere, type EmployeeAction } from '../src/shared/employeeActions'
import { definitionChanges, isOrganizationWide, leavesComputer, needsYouItems, planGroups, runItems } from '../src/shared/employeeDecisions'
import { defaultEmployee, type EmployeeDefinition } from '../src/shared/employees'
import type { EmployeeTask, EmployeeWorkView } from '../src/shared/employeeWork'
import type { MemoryProposal } from '../src/shared/memory'

const at = (minutes: number) => new Date(Date.parse('2026-11-14T10:00:00Z') - minutes * 60_000).toISOString()

const task = (id: string, employeeId: string, patch: Partial<EmployeeTask> = {}): EmployeeTask => ({
  id, orgId: 'o1', employeeId, requestId: id, rootId: id, parentId: null, title: `Task ${id}`, body: '', from: 'person', targetRepoId: 'site', state: 'running', createdAt: at(60), updatedAt: at(60), ...patch
})
const push = (id: string, employeeId: string, minutes: number, patch: Partial<EmployeeAction> = {}): EmployeeAction => ({
  id, orgId: 'o1', employeeId, taskId: 't-launch', runId: 'r-max', repoId: 'site', kind: 'push', policy: 'held', state: 'held', key: id,
  payload: { kind: 'push', connection: 'gh', workspaceId: 'ws-max', branch: 'max/launch', base: 'main', head: 'abc', ahead: 1, commits: [] },
  createdAt: at(minutes), updatedAt: at(minutes), ...patch
})
const proposal = (id: string, employeeId: string, path: string, minutes: number, patch: Partial<MemoryProposal> = {}): MemoryProposal => ({ id, orgId: 'o1', path, kind: 'append', text: '- x\n', employeeId, runId: 'r-ada', taskId: 't-date', createdAt: at(minutes), ...patch })

const view = (patch: Partial<EmployeeWorkView>): EmployeeWorkView => ({ tasks: [], runs: [], last: {}, proposals: [], revision: 1, ...patch })

describe('what waits for a person', () => {
  const work = view({
    tasks: [
      task('t-date', 'e-ada', { state: 'waiting', waitingOn: 'person', question: { id: 'q1', question: 'Which day?', options: ['Tue', 'Thu'], runId: 'r-ada', askedAt: at(23) } }),
      task('t-spent', 'e-max', { state: 'open', hold: 'root-limit', updatedAt: at(5) }),
      task('t-reply', 'e-max', { state: 'waiting', waitingOn: 'reply' }),
      task('t-run', 'e-ada')
    ],
    actions: [push('a-push', 'e-max', 42), push('a-sent', 'e-max', 50, { state: 'sent' })],
    proposals: [proposal('p-org', 'e-ada', 'memory/org/PROJECT.md', 33), proposal('p-own', 'e-ada', 'memory/bots/e-ada/MEMORY.md', 1)]
  })

  it('lists questions, tasks that need a person, held actions and proposals as one list, oldest first', () => {
    expect(needsYouItems(work).map((i) => i.id)).toEqual(['action:a-push', 'proposal:p-org', 'question:t-date', 'task:t-spent', 'proposal:p-own'])
  })

  it('leaves out work waiting on other employees and actions already sent', () => {
    const ids = needsYouItems(work).map((i) => i.id)
    expect(ids).not.toContain('task:t-reply')
    expect(ids).not.toContain('action:a-sent')
    expect(ids).not.toContain('task:t-run')
  })

  it('narrows to one employee', () => {
    expect(needsYouItems(work, 'e-max').map((i) => i.id)).toEqual(['action:a-push', 'task:t-spent'])
    expect(needsYouItems(undefined)).toEqual([])
  })

  it('says only what is outward leaves this computer', () => {
    const items = needsYouItems(work)
    expect(items.filter(leavesComputer).map((i) => i.id)).toEqual(['action:a-push'])
  })

  it('puts a change outside the proposer’s own folder in the organization’s strip', () => {
    expect(isOrganizationWide(proposal('a', 'e-ada', 'memory/org/PROJECT.md', 0))).toBe(true)
    expect(isOrganizationWide(proposal('b', 'e-ada', 'bots/e-lin3.toml', 0))).toBe(true)
    expect(isOrganizationWide(proposal('c', 'e-ada', 'memory/bots/e-ada/MEMORY.md', 0))).toBe(false)
    // Another employee's folder is nobody's own job here either.
    expect(isOrganizationWide(proposal('d', 'e-ada', 'memory/bots/e-max/MEMORY.md', 0))).toBe(true)
  })

  it('gives a run’s workspace its own task’s decisions only, what it waits on first', () => {
    expect(runItems(work, { employeeId: 'e-max', taskId: 't-launch', runId: 'r-max' }).map((i) => i.id)).toEqual(['action:a-push'])
    expect(runItems(work, { employeeId: 'e-ada', taskId: 't-date', runId: 'r-ada' }).map((i) => i.id)).toEqual(['question:t-date', 'proposal:p-org', 'proposal:p-own'])
    expect(runItems(work, { employeeId: 'e-ada', taskId: 't-other' })).toEqual([])
  })
})

describe('what a definition lets an employee do (a draft’s page is its plan)', () => {
  const lin = (patch: (d: EmployeeDefinition) => EmployeeDefinition = (d) => d): EmployeeDefinition =>
    patch(defaultEmployee({ id: 'e-lin3', colour: 'teal', repos: ['site'], loadouts: [{ agent: 'claude', model: 'claude-opus-5-5' }], text: { name: 'Lin', role: 'Triage' } }))
  const kinds = (lines: { kind: string; action?: string }[]) => lines.map((l) => (l.kind === 'action' ? `action:${l.action}` : l.kind))

  it('says a read-only employee can’t change a repository or publish, and has a shell and every MCP server', () => {
    const groups = planGroups(lin())
    expect(kinds(groups.can)).toEqual(['read', 'notes', 'shell', 'mcp'])
    expect(kinds(groups.cant)).toEqual(['no-repo-change', 'no-publish', 'no-delegate'])
    // Slack and Linear are reachable from every run (every MCP server is there), and held until it allows them.
    expect(kinds(groups.asks)).toEqual(['shared-memory', 'action:slack-post', 'action:linear'])
    expect(groups.cant[0]).toMatchObject({ kind: 'no-repo-change', reads: ['site'] })
  })

  it('lists pushes as asking first once it can write, and no shell under Can’t once it is turned off', () => {
    const d = lin((x) => ({ ...x, access: { ...x.access, repos: { site: 'write' }, profile: 'no-shell' } }))
    const groups = planGroups(d)
    expect(kinds(groups.can)).toEqual(['write', 'notes', 'mcp'])
    expect(kinds(groups.cant)).toEqual(['no-shell', 'no-delegate'])
    expect(kinds(groups.asks)).toEqual(['shared-memory', 'action:push', 'action:pull-request', 'action:slack-post', 'action:linear'])
  })

  it('puts an action the definition allows under Can and one it never allows under Can’t', () => {
    const d = lin((x) => ({ ...x, access: { ...x.access, repos: { site: 'write' }, delegate_to: ['e-ada'], actions: { ...x.access.actions, push: 'allowed', 'pull-request': 'never' } } }))
    const groups = planGroups(d)
    expect(kinds(groups.can)).toEqual(['write', 'notes', 'shell', 'mcp', 'delegate', 'action:push'])
    expect(kinds(groups.cant)).toContain('action:pull-request')
    expect(kinds(groups.asks)).not.toContain('action:push')
  })
})

describe('what changed since approval', () => {
  const base: EmployeeDefinition = defaultEmployee({ id: 'e-lin3', colour: 'teal', repos: ['site'], loadouts: [{ agent: 'claude', model: 'claude-opus-5-5' }], text: { name: 'Lin', role: 'Triage', instructions: 'Label new issues.' } })

  it('lists each difference, old → new, and tags what widens what it may do', () => {
    const after: EmployeeDefinition = {
      ...base,
      instructions: 'Label new issues by priority.',
      access: { ...base.access, repos: { site: 'write' }, actions: { ...base.access.actions, linear: 'allowed' } },
      triggers: [{ id: 't-1', kind: 'cron', cron: '0 8 * * 1-5', timezone: 'Europe/London', missed: 'skip', overlap: 'skip', enabled: true }]
    }
    const changes = definitionChanges(base, after)
    expect(changes.map((c) => [c.field, c.subject, c.before, c.after, c.wider])).toEqual([
      ['repo', 'site', 'read', 'write', true],
      ['action', 'linear', 'held', 'allowed', true],
      ['triggers', undefined, '0', '1', true],
      ['instructions', undefined, `\n${base.instructions}`, `\n${after.instructions}`, false]
    ])
  })

  it('says a narrowing is not wider, and the hat isn’t a change at all', () => {
    const after: EmployeeDefinition = { ...base, look: { family: 'hardhat', colour: 'pink' }, access: { ...base.access, repos: {}, profile: 'no-shell' } }
    expect(definitionChanges(base, after).map((c) => [c.field, c.wider])).toEqual([
      ['repo', false],
      ['profile', false]
    ])
    expect(definitionChanges(base, base)).toEqual([])
    // Turning the shell back on is wider.
    expect(definitionChanges(after, base).find((c) => c.field === 'profile')).toMatchObject({ before: 'no-shell', after: 'shell', wider: true })
  })
})

describe('a remote, as a person reads it', () => {
  it('drops the scheme, the user and any token, and the .git', () => {
    expect(remoteWhere('git@github.com:acme/site.git')).toBe('github.com/acme/site')
    expect(remoteWhere('https://x-access-token:ghp_secret@github.com/acme/site.git')).toBe('github.com/acme/site')
    expect(remoteWhere('ssh://git@gitlab.example.com:2222/team/app.git')).toBe('gitlab.example.com/team/app')
    expect(remoteWhere('/srv/git/site.git')).toBe('/srv/git/site.git')
    expect(remoteWhere('  ')).toBe('')
  })
})
