// The screenshot fixture's organization (main/screenshots.ts, and so the demo): Acme, with its memory repository and one
// code repository of its own, three AI employees and their work, written as the real services would have left it. Max
// (writer) handed Ada (researcher) part of a launch post and finished it; his push waits in Needs you. Ada asked a
// question that waits for an answer and proposed an organization fact. Lin (triage) is a draft nobody has approved. Its
// repositories sit beside atlas and beacon, which stay in Personal, so every other screen looks as it did.
import path from 'node:path'
import type { ForemanDb } from './db'
import { git, gitOut } from './git'
import { employeeFingerprint, seedMemoryFiles } from './employees'
import { createMemoryRepository } from './organizations'
import type { Store } from './store'
import { DEFAULT_MODEL } from '../shared/agents'
import type { EmployeeAction } from '../shared/employeeActions'
import { defaultEmployee, employeePath, parseEmployee, serializeEmployee, type EmployeeDefinition, type EmployeeRecord } from '../shared/employees'
import type { EmployeeQuestion, EmployeeRun, EmployeeTask, EmployeeTaskTransition } from '../shared/employeeWork'
import type { Organization } from '../shared/organizations'
import type { ChatItem, Repo, Session, Workspace } from '../shared/types'

export const ORG_ID = 'org-acme'
const MEMORY_REPO = 'repo-acme-memory'
const SITE_REPO = 'repo-site'
const MAX = 'e-max1'
const ADA = 'e-ada2'
const LIN = 'e-lin3'
const MAX_WORKSPACE = 'ws-kyoto'
const MAX_TAB = 's-kyoto-run'
const ADA_WORKSPACE = 'ws-lima'
const ADA_TAB = 's-lima-run'

/** What seedScreens lends: where things go, its clock, its git helpers and the store it is filling. */
export interface OrganizationSeed {
  repos: string
  worktrees: string
  store: Store
  minutesAgo: (minutes: number) => string
  commitAll: (dir: string, message: string, minutes: number) => Promise<void>
  makeRepo: (dir: string, files: Record<string, string>) => Promise<void>
  makeWorktree: (repoDir: string, worktree: string, branch: string, committed: Record<string, string>, uncommitted: Record<string, string>) => Promise<void>
  writeFiles: (dir: string, files: Record<string, string>) => Promise<void>
}

/** The organization's ids, for the screens that show it (renderer/src/screens.ts). */
export interface OrganizationFixture {
  orgId: string
  employeeId: string
  draftEmployeeId: string
  employeeWorkspaceId: string
  employeeChatId: string
}

const SITE_FILES = {
  'README.md': '# Site\n\nacme.dev: the marketing site and the blog.\n',
  'CHANGELOG.md': '# Changelog\n\n## 2.4\n\n- Rate limits on the public API\n- Sign-in returns you to the page you came from\n',
  'blog/2026-11-launch-2.3.md': '# Atlas 2.3\n\nFaster sign-in, and sessions that survive a token refresh.\n'
}

const LAUNCH_POST = `# Atlas 2.4

The public API now has rate limits, and signing in takes you back to the page you came from.

- **Rate limits:** 60 requests a minute per API key; beyond that the API answers 429 with Retry-After.
- **Sign-in:** the page you were on is kept through sign-in, and only pages on acme.dev are followed.
`

/** One employee's definition as its file says it, read back so its approval fingerprints exactly what the file holds. */
function definition(id: string, colour: string, text: Partial<EmployeeDefinition>, patch: (d: EmployeeDefinition) => EmployeeDefinition): { toml: string; definition: EmployeeDefinition } {
  const base = defaultEmployee({ id, colour, repos: ['site'], loadouts: [{ agent: 'claude', model: DEFAULT_MODEL.claude, effort: 'high' }] })
  const toml = serializeEmployee(patch({ ...base, ...text }))
  const parsed = parseEmployee(toml)
  if (!parsed.definition) throw new Error(`The fixture's ${id} doesn't parse: ${parsed.problems.join(' ')}`)
  return { toml, definition: parsed.definition }
}

export async function seedOrganization(seed: OrganizationSeed): Promise<OrganizationFixture> {
  const { store, minutesAgo, commitAll } = seed
  const at = minutesAgo
  const db = store.db as ForemanDb

  // ---- its repositories: the memory repository Foreman made, and the site ----
  const memory = await createMemoryRepository(seed.repos, 'acme-memory', 'Acme')
  const site = path.join(seed.repos, 'site')
  await seed.makeRepo(site, SITE_FILES)

  const max = definition(MAX, 'orange', {
    name: 'Max',
    role: 'Writer',
    description: 'Writes the release notes and launch posts for acme.dev.',
    personality: 'Concise and friendly.',
    responsibilities: ['Draft a launch post for every release', 'Keep CHANGELOG.md and the blog in step'],
    ask_me_about: 'Release notes, the blog',
    instructions: 'Write in plain words for customers, not engineers. Push drafts to a branch; never publish.'
  }, (d) => ({
    ...d,
    access: { ...d.access, repos: { site: 'write' }, memory_write: ['org/docs'], delegate_to: [ADA] },
    triggers: [{ kind: 'schedule', id: 'monday-notes', prompt: 'Draft this week’s release notes from what merged.', recurrence: 'weekly', start_date: '2026-11-02', time: '09:00', timezone: 'Europe/London', weekdays: [1], missed: 'skip', overlap: 'skip', enabled: true }]
  }))
  const ada = definition(ADA, 'pink', {
    name: 'Ada',
    role: 'Researcher',
    description: 'Finds out what changed and why, from the code, the changelog and the pull requests.',
    personality: 'Thorough and data-driven.',
    responsibilities: ['Answer questions about what changed in a release', 'Keep memory/org/PROJECT.md current'],
    ask_me_about: 'What changed, and when',
    instructions: 'Say where each fact comes from. Ask when two sources disagree.'
  }, (d) => d)
  const lin = definition(LIN, 'teal', {
    name: 'Lin',
    role: 'Triage',
    description: 'Reads new issues each morning and labels them.',
    personality: 'Direct.',
    responsibilities: ['Label new issues', 'Flag anything that looks like an outage'],
    instructions: 'Label new issues by area. Never close one.'
  }, (d) => d)

  await seed.writeFiles(memory, {
    [employeePath(MAX)]: max.toml,
    [employeePath(ADA)]: ada.toml,
    [employeePath(LIN)]: lin.toml,
    ...seedMemoryFiles(max.definition),
    ...seedMemoryFiles(ada.definition),
    ...seedMemoryFiles(lin.definition),
    'memory/org/PROJECT.md': '# Acme\n\nAcme makes Atlas, the customer web app, and Beacon, its status page.\n\n- Releases ship on Tuesdays.\n- The blog lives in the site repository, under blog/.\n',
    'memory/org/instructions.md': '# Instructions\n\nWrite for customers. Never publish or merge: push to a branch and let a person decide.\n'
  })
  await commitAll(memory, 'Add Max, Ada and Lin', 3 * 24 * 60 - 30)
  const blobOf = async (file: string) => (await gitOut(memory, ['rev-parse', `HEAD:${file}`])).trim()
  const approved = { max: await blobOf(employeePath(MAX)), ada: await blobOf(employeePath(ADA)) }
  // Each run's memory is committed as its employee, with who made it, in which run, for which task.
  const commitAs = async (employee: string, name: string, runId: string, taskId: string, subject: string, minutes: number) => {
    await git(memory, ['add', '-A'])
    await git(memory, ['-c', `user.name=${name}`, '-c', `user.email=${employee}@employees.foreman`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject, '-m', `Foreman-Employee: ${employee}\nForeman-Run: ${runId}\nForeman-Task: ${taskId}`], {
      env: { GIT_AUTHOR_DATE: at(minutes), GIT_COMMITTER_DATE: at(minutes) }
    })
  }
  await seed.writeFiles(memory, {
    'memory/org/docs/changes-2.4.md': '# What changed in Atlas since 2.3\n\n1. Rate limits on the public API (src/rateLimit.ts).\n2. Sign-in returns to the page you came from (src/redirect.ts).\n',
    [`memory/bots/${ADA}/RECAP.md`]: '# Recap\n\nListed what changed in Atlas since 2.3 for Max, in memory/org/docs/changes-2.4.md.\n'
  })
  await commitAs(ADA, 'Ada', 'run-ada-1', 'task-changes', 'Recap: List what changed in Atlas since 2.3', 62)
  await seed.writeFiles(memory, {
    'memory/org/docs/launch-2.4.md': LAUNCH_POST,
    [`memory/bots/${MAX}/RECAP.md`]: '# Recap\n\nDrafted the Atlas 2.4 launch post from Ada’s list of changes; pushed it to max/launch-2.4, waiting for a person to send the push.\n'
  })
  await commitAs(MAX, 'Max', 'run-max-2', 'task-launch', 'Recap: Write the Atlas 2.4 launch post', 40)

  // ---- Max's and Ada's runs' workspaces in the site ----
  const kyoto = path.join(seed.worktrees, 'site', 'kyoto')
  const lima = path.join(seed.worktrees, 'site', 'lima')
  await seed.makeWorktree(site, kyoto, 'max/launch-2.4', { 'blog/2026-11-launch-2.4.md': LAUNCH_POST }, {})
  // Ada's run reads only: her branch is main as it was.
  await git(site, ['worktree', 'add', '-q', '-b', 'ada/launch-date', lima, 'main'])
  const head = (await gitOut(kyoto, ['rev-parse', 'HEAD'])).trim()

  // ---- state.json: the organization, its repositories, approvals ----
  const repo = (id: string, name: string, rootPath: string): Repo => ({ id, name, rootPath, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: at(3 * 24 * 60), spaceId: ORG_ID })
  store.state.repos.push(repo(MEMORY_REPO, 'acme-memory', memory), repo(SITE_REPO, 'site', site))
  const organization: Organization = { id: ORG_ID, name: 'Acme', memoryRepoId: MEMORY_REPO, leadEmployeeId: ADA, createdAt: at(3 * 24 * 60) }
  store.state.organizations = [organization]
  const records: EmployeeRecord[] = [
    { orgId: ORG_ID, id: MAX, state: 'active', approvedFingerprint: employeeFingerprint(max.definition), approvedBlob: approved.max, approvedAt: at(3 * 24 * 60 - 25) },
    { orgId: ORG_ID, id: ADA, state: 'active', approvedFingerprint: employeeFingerprint(ada.definition), approvedBlob: approved.ada, approvedAt: at(3 * 24 * 60 - 25) },
    { orgId: ORG_ID, id: LIN, state: 'draft' }
  ]
  store.state.employees = records

  const by = (employeeId: string, runId: string, taskId: string, title: string) => ({ via: 'employee' as const, orgId: ORG_ID, employeeId, runId, taskId, title })
  const workspace = (id: string, name: string, branch: string, wsPath: string, minutes: number, extra: Partial<Workspace>): Workspace => ({
    id, repoId: SITE_REPO, name, branch, baseBranch: 'main', path: wsPath, portBase: 50050, state: 'ready', createdAt: at(minutes), ...extra
  })
  store.state.workspaces.push(
    workspace(MAX_WORKSPACE, 'kyoto', 'max/launch-2.4', kyoto, 70, { startedBy: by(MAX, 'run-max-2', 'task-launch', 'Write the Atlas 2.4 launch post'), diffStat: { files: 1, additions: 6, deletions: 0 } }),
    workspace(ADA_WORKSPACE, 'lima', 'ada/launch-date', lima, 30, { startedBy: by(ADA, 'run-ada-3', 'task-date', 'Which day does 2.4 launch?') })
  )
  const tab = (id: string, workspaceId: string, title: string, minutes: number, employeeId: string, runId: string, readOnly: boolean): Session => ({
    id, workspaceId, title, agent: 'claude', model: DEFAULT_MODEL.claude, effort: 'high', fastMode: false, planMode: readOnly, status: 'idle', queue: [],
    lastTurn: { outcome: 'completed', turnId: `${id}-t1`, endedAt: at(minutes) },
    unattended: { employeeRunId: runId, employeeId, orgId: ORG_ID, persona: { mcp: [], ...(readOnly ? { readOnly: true } : {}) } },
    createdAt: at(minutes + 8), lastActivityAt: at(minutes)
  })
  store.state.sessions.push(tab(MAX_TAB, MAX_WORKSPACE, 'Write the Atlas 2.4 launch post', 42, MAX, 'run-max-2', false), tab(ADA_TAB, ADA_WORKSPACE, 'Which day does 2.4 launch?', 22, ADA, 'run-ada-3', true))
  for (const item of runChat(MAX_TAB, MAX, 'run-max-2', 'task-launch', at(50), 'Write the Atlas 2.4 launch post, from Ada’s list of changes, and push it to a branch.', [
    { kind: 'tool', id: `${MAX_TAB}-t1:read`, turnId: `${MAX_TAB}-t1`, name: 'mcp__foreman-app__memory_read', input: { path: 'memory/org/docs/changes-2.4.md' }, status: 'done', output: 'Rate limits on the public API; sign-in returns to the page you came from.' },
    { kind: 'tool', id: `${MAX_TAB}-t1:write`, turnId: `${MAX_TAB}-t1`, name: 'Write', input: { file_path: 'blog/2026-11-launch-2.4.md' }, status: 'done', output: 'The file blog/2026-11-launch-2.4.md has been written.' },
    { kind: 'tool', id: `${MAX_TAB}-t1:push`, turnId: `${MAX_TAB}-t1`, name: 'mcp__foreman-app__request_push', input: {}, status: 'done', output: 'Held for a person: a push of max/launch-2.4 (1 commit ahead of main). It goes once they send it.' }
  ], 'Drafted the post in blog/2026-11-launch-2.4.md and asked to push max/launch-2.4. The push waits for you in Needs you.')) await store.appendChat(MAX_TAB, item)
  for (const item of runChat(ADA_TAB, ADA, 'run-ada-3', 'task-date', at(30), 'Find out which day Atlas 2.4 launches, so the post can say it.', [
    { kind: 'tool', id: `${ADA_TAB}-t1:ask`, turnId: `${ADA_TAB}-t1`, name: 'mcp__foreman-app__ask_person', input: { question: 'Which day does Atlas 2.4 launch?' }, status: 'done', output: 'Asked. Your task waits for the answer; the run can end.' }
  ], 'CHANGELOG.md says 2.4 ships this week, and PROJECT.md says releases ship on Tuesdays, but the 2.3 post went out on a Thursday. I asked which day.')) await store.appendChat(ADA_TAB, item)

  // ---- foreman.db: tasks, their logs, runs, the question, the held push and a proposal ----
  const task = (t: Partial<EmployeeTask> & Pick<EmployeeTask, 'id' | 'employeeId' | 'title' | 'body' | 'from' | 'state'>, minutes: number, updated: number): EmployeeTask => ({
    orgId: ORG_ID, requestId: `req-${t.id}`, rootId: t.id, parentId: null, targetRepoId: SITE_REPO, depth: 0, createdAt: at(minutes), updatedAt: at(updated), ...t
  })
  const tasks: EmployeeTask[] = [
    task({ id: 'task-launch', employeeId: MAX, title: 'Write the Atlas 2.4 launch post', body: 'Write the Atlas 2.4 launch post, from what changed, and push it to a branch for me to look at.', from: 'person', cause: 'person', state: 'closed', closureReason: 'done', resultSummary: 'Drafted the Atlas 2.4 launch post and asked to push it to max/launch-2.4.', result: { status: 'done', summary: 'Drafted the Atlas 2.4 launch post and asked to push it to max/launch-2.4.', artifacts: ['memory/org/docs/launch-2.4.md'], runId: 'run-max-2', at: at(41) } }, 90, 41),
    task({ id: 'task-changes', employeeId: ADA, title: 'List what changed in Atlas since 2.3', body: 'List what changed in Atlas since 2.3, customer-facing changes first.', from: 'employee', rootId: 'task-launch', parentId: 'task-launch', depth: 1, cause: 'run:run-max-1', requestedBy: { employeeId: MAX, name: 'Max', taskId: 'task-launch', runId: 'run-max-1' }, contract: { expecting: 'A list in memory/org/docs/changes-2.4.md' }, state: 'closed', closureReason: 'done', resultSummary: 'Two customer-facing changes: API rate limits, and sign-in returning to the page you came from.', result: { status: 'done', summary: 'Two customer-facing changes: API rate limits, and sign-in returning to the page you came from.', artifacts: ['memory/org/docs/changes-2.4.md'], runId: 'run-ada-1', at: at(62) } }, 84, 62),
    task({ id: 'task-date', employeeId: ADA, title: 'Which day does 2.4 launch?', body: 'Find out which day Atlas 2.4 launches, so the post can say it.', from: 'person', cause: 'person', state: 'waiting', waitingOn: 'person', reason: 'Asks: Which day does Atlas 2.4 launch?', question: { id: 'q-date', question: 'Which day does Atlas 2.4 launch?', options: ['Tuesday 17 November', 'Thursday 19 November'], runId: 'run-ada-3', askedAt: at(23) } }, 32, 23),
    task({ id: 'task-monday', employeeId: MAX, title: 'Draft this week’s release notes from what merged.', body: 'Draft this week’s release notes from what merged.', from: 'schedule', cause: 'trigger:monday-notes', trigger: { id: 'monday-notes', plannedAt: at(4 * 24 * 60) }, state: 'closed', closureReason: 'no-follow-on', resultSummary: 'Nothing merged since last Monday’s notes.', result: { status: 'no-update', summary: 'Nothing merged since last Monday’s notes.', runId: 'run-max-0', at: at(4 * 24 * 60 - 6) } }, 4 * 24 * 60, 4 * 24 * 60 - 6)
  ]
  const run = (r: Partial<EmployeeRun> & Pick<EmployeeRun, 'id' | 'taskId' | 'employeeId' | 'attempt' | 'state'>, from: number, to: number): EmployeeRun => ({
    orgId: ORG_ID, started: true, turnIds: [], agent: 'claude', model: DEFAULT_MODEL.claude, effort: 'high', repoId: SITE_REPO, minutes: 30, createdAt: at(from), admittedAt: at(from), startedAt: at(from), endedAt: at(to), updatedAt: at(to), ...r
  })
  const runs: EmployeeRun[] = [
    run({ id: 'run-max-0', taskId: 'task-monday', employeeId: MAX, attempt: 1, state: 'completed', rootId: 'task-monday', causeId: 'trigger:monday-notes', access: 'write', profile: 'no-shell', usage: { costUsd: 0.08, durationMs: 5 * 60_000 } }, 4 * 24 * 60, 4 * 24 * 60 - 6),
    run({ id: 'run-max-1', taskId: 'task-launch', employeeId: MAX, attempt: 1, state: 'completed', parked: true, rootId: 'task-launch', causeId: 'person', access: 'write', profile: 'no-shell', reason: 'Its task waits for the work it handed off, or the time it chose.', usage: { costUsd: 0.12, durationMs: 4 * 60_000 } }, 90, 86),
    run({ id: 'run-ada-1', taskId: 'task-changes', employeeId: ADA, attempt: 1, state: 'completed', rootId: 'task-launch', causeId: 'run:run-max-1', access: 'read', profile: 'no-shell', usage: { costUsd: 0.21, durationMs: 20 * 60_000 } }, 84, 62),
    run({ id: 'run-max-2', taskId: 'task-launch', employeeId: MAX, attempt: 2, state: 'completed', rootId: 'task-launch', causeId: 'results', access: 'write', profile: 'no-shell', workspaceId: MAX_WORKSPACE, sessionId: MAX_TAB, turnIds: [`${MAX_TAB}-t1`], memoryCommit: (await gitOut(memory, ['rev-parse', 'HEAD'])).trim(), usage: { costUsd: 0.34, durationMs: 9 * 60_000 } }, 51, 41),
    run({ id: 'run-ada-3', taskId: 'task-date', employeeId: ADA, attempt: 1, state: 'completed', parked: true, rootId: 'task-date', causeId: 'person', access: 'read', profile: 'no-shell', workspaceId: ADA_WORKSPACE, sessionId: ADA_TAB, turnIds: [`${ADA_TAB}-t1`], reason: 'It asked a person; its task waits for the answer.', usage: { costUsd: 0.09, durationMs: 7 * 60_000 } }, 30, 22)
  ]
  const transitions: Omit<EmployeeTaskTransition, 'seq'>[] = [
    { taskId: 'task-monday', runId: null, at: at(4 * 24 * 60), from: null, to: 'open', event: 'saved', detail: 'Fired by its trigger.' },
    { taskId: 'task-monday', runId: 'run-max-0', at: at(4 * 24 * 60), from: 'open', to: 'running', event: 'admitted', detail: 'Attempt 1' },
    { taskId: 'task-monday', runId: 'run-max-0', at: at(4 * 24 * 60 - 6), from: 'running', to: 'closed', event: 'completed' },
    { taskId: 'task-launch', runId: null, at: at(90), from: null, to: 'open', event: 'saved' },
    { taskId: 'task-launch', runId: 'run-max-1', at: at(90), from: 'open', to: 'running', event: 'admitted', detail: 'Attempt 1' },
    { taskId: 'task-launch', runId: 'run-max-1', at: at(86), from: 'running', to: 'waiting', event: 'handed-off', detail: 'Waits for Ada: List what changed in Atlas since 2.3' },
    { taskId: 'task-changes', runId: null, at: at(86), from: null, to: 'open', event: 'saved', detail: 'Handed over by Max.' },
    { taskId: 'task-changes', runId: 'run-ada-1', at: at(84), from: 'open', to: 'running', event: 'admitted', detail: 'Attempt 1' },
    { taskId: 'task-changes', runId: 'run-ada-1', at: at(62), from: 'running', to: 'closed', event: 'completed' },
    { taskId: 'task-launch', runId: 'run-max-2', at: at(51), from: 'waiting', to: 'running', event: 'admitted', detail: 'Attempt 2' },
    { taskId: 'task-launch', runId: 'run-max-2', at: at(41), from: 'running', to: 'closed', event: 'completed' },
    { taskId: 'task-date', runId: null, at: at(32), from: null, to: 'open', event: 'saved' },
    { taskId: 'task-date', runId: 'run-ada-3', at: at(30), from: 'open', to: 'running', event: 'admitted', detail: 'Attempt 1' },
    { taskId: 'task-date', runId: 'run-ada-3', at: at(23), from: 'running', to: 'waiting', event: 'asked', detail: 'Which day does Atlas 2.4 launch?' }
  ]
  const question: EmployeeQuestion = { id: 'q-date', orgId: ORG_ID, taskId: 'task-date', runId: 'run-ada-3', employeeId: ADA, question: 'Which day does Atlas 2.4 launch?', options: ['Tuesday 17 November', 'Thursday 19 November'], workspaceId: ADA_WORKSPACE, sessionId: ADA_TAB, state: 'open', askedAt: at(23), updatedAt: at(23) }
  const push: EmployeeAction = {
    id: 'act-push', orgId: ORG_ID, employeeId: MAX, taskId: 'task-launch', runId: 'run-max-2', repoId: SITE_REPO, kind: 'push',
    payload: { kind: 'push', connection: 'gh’s active account', workspaceId: MAX_WORKSPACE, branch: 'max/launch-2.4', base: 'main', head, ahead: 1, commits: [{ sha: head.slice(0, 7), subject: 'Work on max/launch-2.4' }] },
    policy: 'held', state: 'held', key: 'fixture-push-launch', createdAt: at(42), updatedAt: at(42)
  }
  db.transaction(() => {
    for (const t of tasks) db.putEmployeeTask(t)
    for (const r of runs) db.putEmployeeRun(r)
    for (const tr of transitions) db.addEmployeeTaskTransition(tr)
    db.putEmployeeQuestion(question)
    db.putEmployeeAction(push)
    db.putEmployeeRoot({ rootId: 'task-launch', orgId: ORG_ID, runsUsed: 3, runsAllowed: 20, descendants: 1, active: 0, state: 'closed', createdAt: at(90), updatedAt: at(41) })
    db.putEmployeeRoot({ rootId: 'task-date', orgId: ORG_ID, runsUsed: 1, runsAllowed: 20, descendants: 0, active: 1, state: 'open', createdAt: at(32), updatedAt: at(23) })
    db.putEmployeeRoot({ rootId: 'task-monday', orgId: ORG_ID, runsUsed: 1, runsAllowed: 20, descendants: 0, active: 0, state: 'closed', createdAt: at(4 * 24 * 60), updatedAt: at(4 * 24 * 60 - 6) })
    // Ada's proposal for the whole organization: a person keeps or retires it in Needs you.
    db.putMemoryMutation({
      id: 'mut-proposal', orgId: ORG_ID, runId: 'run-ada-3', state: 'proposed', expectedHead: null, commitId: null, paths: ['memory/org/PROJECT.md'],
      detail: { changes: [{ kind: 'append', path: 'memory/org/PROJECT.md', text: '- 2.3 shipped on a Thursday: check the launch day for each release rather than assuming Tuesday.\n' }], proposal: { employeeId: ADA, taskId: 'task-date', why: 'A fact for the whole organization goes in memory/org/PROJECT.md, which a person keeps.' } },
      createdAt: at(24), updatedAt: at(24)
    })
  })
  return { orgId: ORG_ID, employeeId: MAX, draftEmployeeId: LIN, employeeWorkspaceId: MAX_WORKSPACE, employeeChatId: MAX_TAB }
}

/** A run's one turn: Foreman's message marked as the employee's, what it did, its answer, the end. */
function runChat(sessionId: string, employeeId: string, runId: string, taskId: string, asked: string, ask: string, tools: ChatItem[], reply: string): ChatItem[] {
  const turnId = `${sessionId}-t1`
  return [
    { kind: 'user', id: `${turnId}:user`, turnId, at: asked, text: ask, origin: { kind: 'employee', orgId: ORG_ID, employeeId, runId, taskId } },
    ...tools,
    { kind: 'assistant', id: `${turnId}:a1`, turnId, text: reply },
    { kind: 'result', id: `${turnId}:result`, turnId, ok: true, costUsd: 0.3, durationMs: 8 * 60_000, turns: tools.length + 1 },
    { kind: 'turn-end', id: `turn-end:${turnId}`, turnId, outcome: 'completed', durationMs: 8 * 60_000 }
  ]
}
