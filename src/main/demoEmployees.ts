// Dev-only demo (main/demo.ts): AI employees whose runs are a script, and a director that keeps the demo's channels moving.
//
// An employee's run in the demo is a scripted turn (EmployeeDemoTurn, which demoRun.ts's driver gives every employee
// turn) that calls the employee's real Foreman tools through EmployeeTools, the same calls a model would make: Priya's
// project_questions and project_plan, a part's memory_write and finish_task, an acceptance's decision. So the work
// service, the memory repository and the project service move exactly as they would; only the words are written here.
//
// The director (startDemoDirector) starts the demo's channels a few seconds apart, in both organizations, and plays the
// person for some of them, so that a few minutes after the demo opens its channels stand at every stage there is: Priya
// asking (her questions wait for you), a plan waiting for your approval, parts at work, a mock waiting for you to check
// it, a part that didn't finish (Retry), a paused project, one at its final check, and a release whose changelog runs
// into the account's usage limit, waits for the reset with the rest of the team's new work, and then goes on by itself.
// It acts only on what it started and only once (round 1, plan version 1), so what you answer or decide stays yours, and a
// kept demo picks up where it was: a channel already past a step is left alone.
import type { ForemanDb } from './db'
import type { Core } from './core'
import type { Store } from './store'
import type { AgentTurn, TurnCallbacks, TurnRequest } from './agents/types'
import { questionState, type PlanInput, type Project, type QuestionsInput } from '../shared/projects'
import type { EmployeeToolName } from '../shared/employeeTools'
import type { EmployeeRun, EmployeeTask } from '../shared/employeeWork'
import type { ChatItem } from '../shared/types'
import { ORG_ID } from './screensOrganization'
import { LUMEN_CLI_REPO, LUMEN_ID, LUMEN_SITE_REPO } from './demoLumen'

let bound: { core: Core; store: Store } | null = null

/** Once the core is up (main/index.ts): the scripted runs call its employee tools. */
export function bindDemoEmployees(core: Core, store: Store): void {
  bound = { core, store }
}

/** An AI employee's run: its turn is this script, never the replayed recordings a person's chat gets. */
export const isEmployeeTurn = (request: TurnRequest): boolean => request.employee === true

// ---- the channels: what each asks, plans and writes, and what the director decides ----

interface Story {
  orgId: string
  repoId: string
  requirement: string
  // Seconds after the demo opens that the director starts it.
  at: number
  understood: string[]
  questions: QuestionsInput['questions']
  // The director's answers; absent: the questions wait for you.
  answers?: string[]
  plan: PlanInput
  // The director approves the plan (otherwise it waits for you), pausing the project first when `pause`.
  approve?: boolean
  pause?: boolean
  // Parts whose first round runs into the usage limit, or doesn't finish.
  limit?: string
  stuck?: { part: string; summary: string }
  // What each part writes, by part id (a default otherwise).
  files?: Record<string, string>
  // Parts that also draw an HTML mock.
  mocks?: Record<string, string>
}

const MOCK = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.5 system-ui;margin:40px;color:#1d1d1f}main{max-width:880px;margin:auto}.plans{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.plan{border:1px solid #d2d2d7;border-radius:12px;padding:20px}.price{font-size:28px;font-weight:600}.note{color:#6e6e73}</style></head>
<body><main>${body}</main></body>
</html>
`

const STORIES: Story[] = [
  {
    orgId: ORG_ID,
    repoId: 'repo-site',
    requirement: 'A pricing page for usage-based plans, so teams can see what they would pay before they talk to sales.',
    at: 4,
    understood: ['Teams want to know what Atlas costs at their size before a sales call.'],
    questions: [
      { question: 'What does a team pay for?', why: 'It decides what the page’s calculator asks.', options: ['Seats', 'API requests', 'Seats and API requests'] },
      { question: 'Should the page show a calculator, or a table of tiers?', options: ['A calculator', 'A table of tiers', 'Both'] }
    ],
    answers: ['Seats and API requests', 'Both'],
    approve: true,
    plan: {
      summary: 'A pricing page on acme.dev with three tiers and a calculator for seats and API requests.',
      size: 'small',
      understood: ['Teams pay for seats and API requests.', 'The page shows a table of tiers and a calculator.'],
      done_when: ['The mock is approved.', 'The copy covers every tier.'],
      parts: [
        { id: 'mock', title: 'Mock the pricing page', owner: 'Uma', brief: 'Draw the page: three tiers and the calculator under them.', writes: 'mock-notes.md', gate_after: true },
        { id: 'copy', title: 'Write the pricing copy', owner: 'Max', brief: 'Write each tier’s name, price line and what it includes.', writes: 'pricing-copy.md' }
      ]
    },
    files: {
      mock: '# The pricing page mock\n\nThree tiers side by side, then the calculator: seats and API requests a month, with the price as you type.\n\n- The calculator starts at 10 seats and 100,000 requests, a typical team.\n- Enterprise has no price: “Talk to us”.\n',
      copy: '# Pricing copy\n\n## Team: $12 a seat\n\nEverything you need to ship: 100,000 API requests a month included.\n\n## Business: $24 a seat\n\nSingle sign-on, audit logs and 1,000,000 requests a month.\n\n## Enterprise: talk to us\n\nYour own limits, a support plan and invoices.\n'
    },
    mocks: {
      mock: MOCK('Pricing', '<h1>Pricing</h1><p class="note">Pay for the seats you use and the requests you send.</p><div class="plans"><div class="plan"><h2>Team</h2><div class="price">$12</div><p>a seat a month · 100k requests</p></div><div class="plan"><h2>Business</h2><div class="price">$24</div><p>a seat a month · 1M requests · SSO</p></div><div class="plan"><h2>Enterprise</h2><div class="price">Talk to us</div><p>Your own limits</p></div></div><h2>What would we pay?</h2><p>10 seats · 100,000 requests a month → <strong>$120 a month</strong></p>')
    }
  },
  {
    orgId: ORG_ID,
    repoId: 'repo-docs',
    requirement: 'A guide to the API’s rate limits, with examples that back off when the API answers 429.',
    at: 14,
    understood: ['Developers hit the new 60-a-minute limit and don’t know how to back off.'],
    questions: [
      { question: 'Which languages should the examples be in?', options: ['curl only', 'curl and JavaScript', 'curl, JavaScript and Python'] },
      { question: 'Should the guide say how to ask for a higher limit?', options: ['Yes', 'No'] }
    ],
    answers: ['curl, JavaScript and Python', 'Yes'],
    approve: true,
    plan: {
      summary: 'A rate-limits guide on developer.acme.dev, with runnable examples that honour Retry-After.',
      size: 'small',
      understood: ['Examples in curl, JavaScript and Python.', 'The guide says how to ask for a higher limit.'],
      done_when: ['Every example runs against the staging API.'],
      parts: [
        { id: 'guide', title: 'Write the guide', owner: 'Iris', brief: 'Explain the limit, the 429 answer and Retry-After, with an example in each language.', writes: 'guide.md' },
        { id: 'examples', title: 'Run every example', owner: 'Quinn', brief: 'Run each example against the staging API and report what fails.', writes: 'example-report.md', depends_on: ['guide'] }
      ]
    },
    stuck: { part: 'examples', summary: 'I couldn’t run the examples: they need a staging API key, and none is set for this organization. Add STAGING_API_KEY to the docs repository’s environment, then retry.' },
    files: {
      guide: '# Rate limits\n\nThe API answers at most **60 requests a minute** per API key. Beyond that it answers `429 Too Many Requests` with a `Retry-After` header: wait that many seconds, then send the request again.\n\n```js\nconst response = await fetch(url, init)\nif (response.status === 429) await sleep(Number(response.headers.get(\'Retry-After\')) * 1000)\n```\n\nNeed more? Ask support for a higher limit with your key’s name.\n',
      examples: '# Example report\n\n| Example | Result |\n| --- | --- |\n| curl | Passed |\n| JavaScript | Passed |\n| Python | Passed |\n'
    }
  },
  {
    orgId: ORG_ID,
    repoId: 'repo-mobile',
    requirement: 'Offline mode for the mobile app: read the last synced projects without a connection, and sync changes when it comes back.',
    at: 24,
    understood: ['People use the app on trains and planes and see an empty screen.'],
    questions: [
      { question: 'What must work offline?', options: ['Reading only', 'Reading and editing'] },
      { question: 'How much may the app keep on the phone?', options: ['The last 7 days', 'The last 30 days', 'Everything'] },
      { question: 'When two people edit the same thing offline, who wins?', options: ['The last to sync', 'Ask the person'] }
    ],
    answers: ['Reading and editing', 'The last 30 days', 'Ask the person'],
    plan: {
      summary: 'Offline reading and editing in the Atlas app: 30 days kept on the phone, changes synced when it reconnects, conflicts shown to the person.',
      size: 'large',
      understood: ['Reading and editing work offline.', 'The app keeps the last 30 days.', 'A conflict asks the person which to keep.'],
      done_when: ['A project opened online reads in airplane mode.', 'An edit made offline syncs when the phone reconnects.', 'A conflict shows both versions.'],
      out_of_scope: ['Offline attachments.'],
      parts: [
        { id: 'conflict-ux', title: 'Mock the conflict screen', owner: 'Uma', brief: 'Draw how the app shows two versions of one edit, and asks which to keep.', writes: 'conflict-mock.md', gate_after: true },
        { id: 'cache', title: 'Keep 30 days on the phone', owner: 'Kai', brief: 'Store the last 30 days of projects in SQLite, and read from it offline.', writes: 'cache.md' },
        { id: 'sync', title: 'Sync offline edits', owner: 'Kai', brief: 'Queue edits made offline and send them on reconnect; show a conflict when one comes back.', writes: 'sync.md', depends_on: ['cache', 'conflict-ux'] },
        { id: 'test', title: 'Test in airplane mode', owner: 'Quinn', brief: 'Test reading, editing and a conflict with the network off and on again.', writes: 'test-report.md', depends_on: ['sync'] }
      ]
    }
  },
  {
    orgId: ORG_ID,
    repoId: 'repo-billing',
    requirement: 'Annual plans on the billing page, at two months free, for teams that want one invoice a year.',
    at: 34,
    understood: ['Finance teams ask for one invoice a year instead of twelve.'],
    questions: [
      { question: 'Can a team switch from monthly to annual mid-cycle?', why: 'It decides whether we prorate.', options: ['Yes, prorated', 'Only at renewal'] },
      { question: 'Should annual plans be refundable?', options: ['Within 30 days', 'No'] },
      { question: 'Who should see the annual option?', options: ['Every team', 'Teams of 10 seats or more'] }
    ],
    plan: { summary: '', size: 'small', parts: [] }
  },
  {
    orgId: LUMEN_ID,
    repoId: LUMEN_CLI_REPO,
    requirement: 'A plugin API for Lumen, so people can add their own commands without forking it.',
    at: 9,
    understood: ['People fork Lumen to add one command, then can’t take our releases.'],
    questions: [
      { question: 'How are plugins found?', options: ['npm packages named lumen-plugin-*', 'A plugins folder in the config'] },
      { question: 'May a plugin change an existing command?', options: ['No, only add new ones', 'Yes'] }
    ],
    plan: { summary: '', size: 'small', parts: [] }
  },
  {
    orgId: LUMEN_ID,
    repoId: LUMEN_SITE_REPO,
    requirement: 'Search on the docs site, so people find a flag without reading every page.',
    at: 19,
    understood: ['People ask in issues for flags that are documented.'],
    questions: [{ question: 'Should search run in the browser, or on a hosted service?', options: ['In the browser', 'A hosted service'] }],
    answers: ['In the browser'],
    approve: true,
    pause: true,
    plan: {
      summary: 'Search on lumen.dev that runs in the browser, over every page and every flag.',
      size: 'small',
      understood: ['Search runs in the browser, with no service to host.'],
      done_when: ['Searching for a flag finds the page that documents it.'],
      parts: [
        { id: 'index', title: 'Build the search index', owner: 'Theo', brief: 'Build an index of every page and flag when the site builds.', writes: 'index.md' },
        { id: 'box', title: 'Add the search box', owner: 'Noor', brief: 'Add a search box to every page, with results as you type.', writes: 'search-box.md', depends_on: ['index'] }
      ]
    }
  },
  {
    orgId: LUMEN_ID,
    repoId: LUMEN_CLI_REPO,
    requirement: 'Release Lumen 0.9: the changelog and a release post for the new TOML config.',
    at: 75,
    understood: ['0.9 reads lumen.toml, and still reads .lumenrc.json for one release.'],
    questions: [{ question: 'Is anything else going into 0.9?', options: ['Only the TOML config', 'The TOML config and the faster tail'] }],
    answers: ['The TOML config and the faster tail'],
    approve: true,
    limit: 'changelog',
    plan: {
      summary: 'Lumen 0.9: its changelog and a release post about lumen.toml and the faster tail.',
      size: 'small',
      understood: ['0.9 has the TOML config and the faster tail.'],
      done_when: ['The changelog lists both changes.', 'The post shows lumen.toml and how to move to it.'],
      parts: [
        { id: 'changelog', title: 'Write the 0.9 changelog', owner: 'Theo', brief: 'List what changed since 0.8.2, with each pull request.', writes: 'changelog.md' },
        { id: 'post', title: 'Write the release post', owner: 'Noor', brief: 'Write the post for lumen.dev, with lumen.toml and how to move to it.', writes: 'post.md', depends_on: ['changelog'] }
      ]
    },
    files: {
      changelog: '# 0.9.0\n\n- **lumen.toml.** Lumen reads its config from `lumen.toml`; `.lumenrc.json` still works until 1.0 (#212).\n- **A faster tail.** `lumen tail` reads 4x faster on large files (#219).\n',
      post: '# Lumen 0.9: a TOML config and a faster tail\n\nLumen now reads `lumen.toml`:\n\n```toml\ntheme = "dark"\npage_size = 200\n```\n\nYour `.lumenrc.json` keeps working until 1.0. Run `lumen config migrate` to move to TOML.\n'
    }
  }
]

/** The demo's story a project was started from; undefined for one the person started. */
const storyOf = (project: Project): Story | undefined => STORIES.find((s) => s.orgId === project.orgId && s.requirement === project.requirement)

// What the fixture's single sign-on project writes as it goes on.
const SSO_FILES: Record<string, string> = {
  copy: '# Sign-in page copy\n\n**Sign in with your company account**\n\nEnter your work email and we’ll send you to your company’s sign-in page.\n\nNo company account? [Sign in with a password](#) instead.\n',
  guide: '# Set up single sign-on\n\n1. In Atlas, open **Settings → Security → Single sign-on** and choose **Add a SAML provider**.\n2. Copy the ACS URL and the entity ID into your provider (Okta: **Applications → Create App Integration → SAML 2.0**).\n3. Paste your provider’s metadata URL back into Atlas and choose **Test**.\n4. When the test signs you in, turn it on for your team.\n\nPasswords keep working beside it.\n',
  review: '# Checked against the requirements\n\n- Any SAML 2.0 provider: the guide uses metadata, nothing Okta-only. ✓\n- Each team’s admin sets it up in Settings. ✓\n- Passwords stay beside single sign-on: the sign-in copy offers both. ✓\n'
}

// ---- the scripted run ----

type Beat =
  | { say: string }
  | { call: EmployeeToolName; args: Record<string, unknown>; ms: number }
  | { show: string; input: Record<string, unknown>; output: string; ms: number }
  | { limit: number }

const call = (name: EmployeeToolName, args: Record<string, unknown>, ms = 2200): Beat => ({ call: name, args, ms })
const firstLine = (text: string) => text.split('\n')[0].replace(/^#+\s*/, '')

function questionBeats(project: Project, story: Story | undefined): Beat[] {
  const questions = story?.questions ?? [
    { question: 'Who is this for?', options: ['Our customers', 'Our own team'] },
    { question: 'What must be true when it’s done?' }
  ]
  return [
    { say: `Before I plan “${project.title}”, a few things I can’t guess.` },
    call('project_questions', { understood: story?.understood ?? [project.requirement], questions }),
    call('finish_task', { status: 'done', summary: `${questions.length} ${questions.length === 1 ? 'question' : 'questions'} before I plan.` }, 1200)
  ]
}

function planBeats(project: Project, story: Story | undefined): Beat[] {
  const replan = project.plan
  const input: PlanInput = replan
    ? {
        summary: replan.summary,
        size: replan.size,
        understood: replan.understood,
        done_when: replan.doneWhen,
        parts: replan.parts.map((p) => ({ id: p.id, title: p.title, owner: p.owner, brief: p.brief, reads: p.reads, writes: p.writes, depends_on: p.dependsOn, gate_after: p.gate }))
      }
    : story?.plan.parts.length
      ? story.plan
      : {
          summary: project.requirement,
          size: 'small',
          understood: [project.requirement],
          done_when: ['It does what was asked.'],
          parts: [{ id: 'write-up', title: 'Write it up', owner: project.pmId, brief: project.requirement, writes: 'write-up.md' }]
        }
  return [
    { say: replan ? 'The plan stands as it is: the same parts, with the same owners.' : 'Thanks: that’s enough to plan.' },
    { show: 'mcp__foreman-app__memory_read', input: { path: 'memory/org/PROJECT.md' }, output: 'What the organization makes, and how it works.', ms: 1500 },
    call('project_plan', input as unknown as Record<string, unknown>, 3000),
    call('finish_task', { status: 'done', summary: `${input.parts.length} ${input.parts.length === 1 ? 'part' : 'parts'}, ${input.size}.` }, 1200)
  ]
}

function partBeats(task: EmployeeTask, run: EmployeeRun, project: Project, story: Story | undefined): Beat[] {
  const partId = task.project?.partId ?? ''
  const part = project.plan?.parts.find((p) => p.id === partId)
  const title = part?.title ?? task.title
  const produces = task.contract?.produces ?? ''
  if (story?.limit === partId && run.attempt === 1) return [{ say: `Starting on “${title}”.` }, { show: 'Read', input: { file_path: 'CHANGELOG.md' }, output: '# Changelog\n\n## 0.8.2 …', ms: 1800 }, { limit: 2 }]
  if (story?.stuck?.part === partId && (task.project?.round ?? 1) === 1) {
    return [
      { say: `Running each example in the guide against the staging API.` },
      { show: 'Bash', input: { command: 'curl -i https://staging.api.acme.dev/v1/projects', description: 'Run the curl example' }, output: 'HTTP/2 401\n{"error":"missing API key"}', ms: 2500 },
      call('finish_task', { status: 'declined', summary: story.stuck.summary }, 1500)
    ]
  }
  const text = story?.files?.[partId] ?? (project.id === 'proj-sso' ? SSO_FILES[partId] : undefined) ?? `# ${title}\n\n${part?.brief ?? task.title}\n\nDone as the brief asks.\n`
  const mock = story?.mocks?.[partId]
  const folder = task.contract?.writesUnder?.[0]
  const mockPath = mock && folder ? `${folder.endsWith('/') ? folder : `${folder}/`}index.html` : undefined
  return [
    { say: `Working on “${title}”.` },
    ...(task.contract?.inputs?.length ? [{ show: 'mcp__foreman-app__memory_read', input: { path: task.contract.inputs[0].path }, output: 'Read.', ms: 1600 } as Beat] : []),
    ...(mockPath ? [call('memory_write', { path: mockPath, text: mock, expected: null, why: 'The mock this part draws.' }, 3500)] : []),
    call('memory_write', { path: produces, text, expected: null, why: `What “${title}” asks for.` }, 3000),
    call('finish_task', { status: 'done', summary: `${firstLine(text)}: written to ${produces.split('/').pop()}.`, artifacts: [produces, ...(mockPath ? [mockPath] : [])] }, 1500)
  ]
}

function acceptBeats(task: EmployeeTask, project: Project): Beat[] {
  const produces = task.contract?.produces ?? ''
  const text = `# Acceptance\n\nEvery part of “${project.title}” is done and checked against what was asked:\n\n${(project.plan?.doneWhen ?? []).map((d) => `- ${d} ✓`).join('\n')}\n`
  return [
    { say: 'Reading every part against the plan.' },
    call('memory_write', { path: produces, text, expected: null, why: 'The acceptance.' }, 2500),
    call('finish_task', { status: 'done', summary: 'Accepted: it does what was asked. Ready for your final check.', decision: 'accept' }, 1500)
  ]
}

function taskBeats(task: EmployeeTask): Beat[] {
  if (task.trigger?.id === 'hourly-triage')
    return [
      { show: 'Bash', input: { command: 'gh issue list --label new', description: 'List new issues' }, output: '#231  lumen tail drops lines after rotation\n#232  Support NO_COLOR', ms: 2500 },
      call('finish_task', { status: 'done', summary: 'Labelled 2 new issues: #231 as tail, #232 as output. Asked #231’s reporter for their rotation settings.' }, 1500)
    ]
  if (task.trigger) return [call('report_no_update', {}, 1500)]
  return [
    { say: 'On it.' },
    call('finish_task', { status: 'done', summary: `Done: ${task.title}` }, 2000)
  ]
}

function script(task: EmployeeTask, run: EmployeeRun, db: ForemanDb): Beat[] {
  const mark = task.project
  const project = mark ? db.project(mark.id) : undefined
  if (!mark || !project) return taskBeats(task)
  const story = storyOf(project)
  if (mark.kind === 'plan') {
    const asked = questionState(project.asks)
    return !project.plan && !asked.answered && !asked.skipped ? questionBeats(project, story) : planBeats(project, story)
  }
  if (mark.kind === 'part') return partBeats(task, run, project, story)
  if (mark.kind === 'accept') return acceptBeats(task, project)
  // What the person wrote in the channel (§15): she answers there.
  if (mark.kind === 'message') return [{ say: 'Reading your message against the plan.' }, call('finish_task', { status: 'done', summary: 'Noted. The plan stands as it is; tell me what to change and I’ll replan, or send the part back at its check.' }, 1500)]
  return [{ say: 'Here is what I did, and why.' }, call('finish_task', { status: 'done', summary: 'Answered the question about this part.' }, 1500)]
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

/** An employee's run as a script of real tool calls (see the top of the file). */
export class EmployeeDemoTurn implements AgentTurn {
  private stopper = new AbortController()

  constructor(private request: TurnRequest, private cb: TurnCallbacks) {}

  private async say(id: string, said: string): Promise<void> {
    const { turnId } = this.request
    const words = said.split(/(?<= )/)
    let text = ''
    for (let i = 0; i < words.length && !this.stopper.signal.aborted; i += 4) {
      text += words.slice(i, i + 4).join('')
      this.cb.item({ kind: 'assistant', id, turnId, text, streaming: true }, true)
      await sleep(110, this.stopper.signal)
    }
    this.cb.item({ kind: 'assistant', id, turnId, text: said })
  }

  async run(): Promise<void> {
    const { turnId } = this.request
    const signal = this.stopper.signal
    const started = Date.now()
    if (!bound) return this.cb.finished({ ok: false, error: 'The demo’s employees aren’t ready yet.' })
    const { core, store } = bound
    const session = store.state.sessions.find((s) => s.turnId === turnId)
    const tools = core.foremanMcp.employeeTools
    let found: ReturnType<typeof core.employeeWork.toolRun> | undefined
    try {
      if (session) found = core.employeeWork.toolRun(session.id)
    } catch {
      found = undefined
    }
    if (!session || !found || !tools) return this.cb.finished({ ok: false, error: 'This run has ended.' })
    const beats = script(found.task, found.run, store.db as ForemanDb)
    let n = 0
    for (const beat of beats) {
      if (signal.aborted) break
      const id = `${turnId}:demo-${n++}`
      if ('say' in beat) {
        await this.say(id, beat.say)
        continue
      }
      if ('limit' in beat) {
        const resetAt = new Date(Date.now() + beat.limit * 60_000)
        const time = resetAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        this.cb.limits?.([{ kind: 'session', usedPercent: 100, resetsAt: resetAt.toISOString(), state: 'blocked' }])
        return this.cb.finished({ ok: false, error: `You've hit your limit · resets ${time} (${timeZone})`, limit: { resetAt: resetAt.toISOString(), source: `resets ${time} (${timeZone})`, timeZone } })
      }
      const name = 'call' in beat ? `mcp__foreman-app__${beat.call}` : beat.show
      const input = 'call' in beat ? beat.args : beat.input
      const tool: Extract<ChatItem, { kind: 'tool' }> = { kind: 'tool', id, turnId, name, input, status: 'running' }
      this.cb.item({ ...tool })
      await sleep(beat.ms, signal)
      if (signal.aborted) break
      if ('show' in beat) {
        this.cb.item({ ...tool, status: 'done', output: beat.output })
        continue
      }
      const result = await tools.call(session.id, beat.call, beat.args)
      if (result.isError) console.error(`[demo] ${found.task.title}: ${beat.call} refused: ${result.text}`)
      this.cb.item({ ...tool, status: result.isError ? 'error' : 'done', output: result.text })
    }
    if (signal.aborted) return this.cb.finished({ ok: false, error: 'Stopped.' })
    this.cb.item({ kind: 'result', id: `result:${turnId}`, turnId, ok: true, costUsd: Math.round(beats.length * 3.1) / 100, durationMs: Date.now() - started, turns: beats.length })
    this.cb.finished({ ok: true })
  }

  async stop(): Promise<void> {
    this.stopper.abort()
  }

  async stopChild(): Promise<void> {
    throw new Error('That subagent is not running')
  }

  steer(): boolean {
    return false
  }

  async setPlanMode(): Promise<void> {}

  async setModel(): Promise<void> {}
}

// ---- the director ----

const DIRECTOR_TICK_MS = 2_000
// How long a wait shows before the director acts on it, so you can see it.
const DIRECTOR_PAUSE_MS = 6_000

/** Start the demo's channels and play the person for the decisions the stories make (see the top of the file). */
export function startDemoDirector(core: Core, store: Store): () => void {
  const db = store.db as ForemanDb
  const opened = Date.now()
  const seen = new Map<string, number>()
  const busy = new Set<string>()
  // What it tried and couldn't do: said once, never tried again.
  const failed = new Set<string>()
  const projectFor = (story: Story) => db.projects(story.orgId).find((p) => p.requirement === story.requirement)
  // A demo kept from an earlier version of the demo data may not have the story's organization or repository.
  const playable = (story: Story) => store.state.organizations?.some((o) => o.id === story.orgId) && store.state.repos.some((r) => r.id === story.repoId)

  const act = (key: string, fn: () => Promise<unknown>) => {
    if (busy.has(key) || failed.has(key)) return
    const first = seen.get(key) ?? Date.now()
    seen.set(key, first)
    if (Date.now() - first < DIRECTOR_PAUSE_MS) return
    busy.add(key)
    fn()
      .catch((err: unknown) => {
        failed.add(key)
        console.error(`[demo] The director couldn’t ${key}: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => busy.delete(key))
  }

  const tick = () => {
    for (const story of STORIES.filter(playable)) {
      const project = projectFor(story)
      if (!project) {
        if (Date.now() - opened >= story.at * 1000) act(`start ${story.requirement}`, () => core.projects.start(story.orgId, { requirement: story.requirement, repoId: story.repoId }))
        continue
      }
      if (project.phase === 'closed') continue
      for (const wait of project.waits) {
        if (wait.kind === 'questions' && story.answers && (project.asks?.length ?? 0) === 1) act(`answer ${wait.id}`, () => core.projects.answer(project.id, wait.id, story.answers!))
        if (wait.kind === 'plan' && story.approve && project.plans.length === 1)
          act(`approve ${wait.id}`, async () => {
            if (story.pause) await core.projects.setPaused(project.id, true)
            await core.projects.decide(project.id, wait.id, 'approve')
          })
      }
    }
  }
  const timer = setInterval(tick, DIRECTOR_TICK_MS)
  tick()
  return () => clearInterval(timer)
}
