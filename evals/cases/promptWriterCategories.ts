import { PROMPT_LADDERS, promptTargetFor, promptWriterMessage, promptWriterSystemPrompt, type PromptCategory, type PromptTarget, type WritePromptInput } from '../../src/shared/promptWriter'
import type { EvalCase, RunOutput, Scenario, Verdict } from '../types'
import { readAnswer } from './promptWriter'

// Write a full prompt, one eval per category (docs/prompt-writer.md, "Categories"). Each asks for a draft of one realistic
// request, with the person's answers so a single call drafts, on Claude Code with Sonnet leading (probe) and on Codex with
// GPT-6.2 Sol leading (control). It checks exactly three things in code and nothing else: the Goal is about the request,
// the models follow the target's roles, and Done when is a check with its evidence.

/** How the prompt's models are laid out: full roles for a code change, the mock roles, or a Models line. */
type Shape = 'code' | 'mocks' | 'read' | 'judge'

export interface CategoryCase {
  category: PromptCategory
  request: string
  // The person's answers; [] is a second call with every question skipped, so the writer drafts rather than asks.
  answers: { question: string; answer: string }[]
  // What the Goal must be about: each pattern is a part of the request the Goal has to carry.
  goal: RegExp[]
  shape: Shape
}

const qa = (pairs: [string, string][]) => pairs.map(([question, answer]) => ({ question, answer }))

export const CATEGORY_CASES: CategoryCase[] = [
  { category: 'question', request: 'does the foreman CLI have a JSON output option for listing workspaces?', answers: [], goal: [/json/i, /workspace/i], shape: 'read' },
  { category: 'wrapper', request: 'Plan: 1. Add a pinned flag to Workspace in src/shared/types.ts. 2. Sort pinned workspaces first in the sidebar. 3. Add a test for the sort.', answers: [], goal: [/pinned/i, /sidebar/i], shape: 'code' },
  { category: 'explain', request: 'how does restoring a checkpoint work?', answers: [], goal: [/restor/i, /checkpoint/i], shape: 'read' },
  { category: 'research', request: 'should we move from Electron to Tauri? think about it, don\'t build anything', answers: [], goal: [/electron/i, /tauri/i], shape: 'judge' },
  { category: 'review', request: 'review the new workspace dialog for accessibility', answers: [], goal: [/accessib/i, /dialog/i], shape: 'judge' },
  {
    category: 'writing', request: 'write a launch post for our 1.3 release', goal: [/launch|post/i, /1\.3/], shape: 'read',
    answers: qa([['Where will the launch post be published?', 'Company blog'], ['Who is the post mainly for?', 'Existing users'], ['How long and in what tone?', 'Short (about 150 words), upbeat']])
  },
  { category: 'docs', request: 'update the README to explain the new prompt writer', answers: [], goal: [/readme/i, /prompt writer/i], shape: 'read' },
  { category: 'script', request: 'write a script that renames every .jpeg file under assets to .jpg', answers: [], goal: [/jpeg/i, /jpg/i, /assets/i], shape: 'read' },
  {
    category: 'bug', request: 'the terminal goes blank after resizing the window', goal: [/terminal/i, /resiz/i], shape: 'code',
    answers: qa([['What exactly happens to the terminal after the resize?', 'Goes blank, returns on next keypress or output'], ['When does it happen?', 'Every resize'], ['What should happen instead?', 'Content stays and reflows to the new size']])
  },
  { category: 'refactor', request: 'split core.ts into smaller files', answers: [], goal: [/core\.ts/i, /files?/i], shape: 'code' },
  {
    category: 'performance', request: 'app startup takes 8 seconds', goal: [/start/i, /2 seconds|second/i], shape: 'code',
    answers: qa([['What do you want startup time to be?', 'Under 2 seconds'], ['Which startup is the 8 seconds?', 'Cold start, first launch after boot'], ['What must stay the same?', 'Everything that loads at startup; No new dependencies']])
  },
  {
    category: 'tests', request: 'the checkpoints test is flaky', goal: [/checkpoints? test/i, /every time|reliabl|consistent|1 run in 10|flak/i], shape: 'code',
    answers: qa([['How does the checkpoints test fail?', 'Fails now and then with the same error'], ['About how often does it fail, and since when?', 'Roughly 1 run in 10'], ['What must stay the same?', 'What the test checks; The checkpoints code itself']])
  },
  {
    category: 'prompt-authoring', request: 'write a persona prompt for a QA engineer employee', goal: [/persona|prompt/i, /QA/i], shape: 'code',
    answers: qa([['What should this QA engineer persona mainly do?', 'Write test plans and test cases; Review code or pull requests for quality'], ['How should the persona behave when something is unclear or fails?', 'Ask clarifying questions before testing'], ['How long and formal should its replies be?', 'Short and direct']])
  },
  {
    category: 'feature', request: 'add keyboard shortcuts to switch between workspaces', goal: [/shortcut|ctrl|cmd/i, /workspace/i], shape: 'code',
    answers: qa([['Which shortcuts should switch workspaces?', 'Ctrl/Cmd + 1–9 for the nth workspace'], ['What else should the shortcuts do?', 'Show the shortcut next to each workspace name; Be changeable in settings'], ['What should happen when a shortcut is pressed while typing in a text field?', 'Still switch workspaces']])
  },
  { category: 'build-mock', request: 'build mock 3 from mocks/sidebar-fresh', answers: [], goal: [/mock 3/i, /sidebar-fresh/i], shape: 'code' },
  { category: 'upgrade', request: 'upgrade vitest to the next major version', answers: [], goal: [/vitest/i, /major/i], shape: 'code' },
  { category: 'infra', request: 'add a GitHub Actions job that builds the macOS installer when a tag is pushed', answers: [], goal: [/github actions|workflow|job/i, /macos/i, /tag/i], shape: 'code' },
  {
    category: 'security', request: 'check the codebase for leaked secrets and fix what you find', goal: [/secret/i], shape: 'code',
    answers: qa([['What should "fix" mean for a secret the agent finds in the files?', 'Move it to an environment variable and update the code; Remove it and list what needs rotating'], ['Should it also search git history for secrets that were committed and later deleted?', 'Yes, report them only']])
  },
  {
    category: 'data-migration', request: 'add a pinned column to the workspaces table in the database', goal: [/pinned/i, /column/i, /workspaces/i], shape: 'code',
    answers: qa([['Is pinned one flag on the workspace itself, or does each user pin workspaces for themselves?', 'One flag on the workspace, same for everyone'], ['How far should this go?', 'Only the column and its migration']])
  },
  { category: 'release', request: 'cut a release for 1.3.0', answers: [], goal: [/1\.3\.0/], shape: 'read' },
  {
    category: 'mocks', request: 'show me mocks for a usage dashboard', goal: [/usage dashboard|dashboard/i, /direction/i], shape: 'mocks',
    answers: qa([['How many design directions do you want to compare?', '2'], ['In what format should the mocks come?', 'One HTML file per state'], ['Which states should each direction show?', 'Default, with data; Empty']])
  },
  { category: 'link', request: 'https://github.com/acme/foreman/issues/151', answers: [], goal: [/151|issue/i], shape: 'read' },
  { category: 'external', request: 'what can we learn from https://github.com/pingdotgg/t3code', answers: [], goal: [/t3code/i], shape: 'judge' },
  {
    category: 'other', request: 'update my LinkedIn headline to mention Foreman', goal: [/linkedin|headline/i, /foreman/i], shape: 'read',
    answers: qa([['What is your connection to Foreman?', 'I work at Foreman'], ['How should the new headline treat your current one?', 'Keep it and add Foreman'], ['What tone do you want?', 'Plain and factual']])
  }
]

// ---- the three checks ----

export interface CategoryChecks {
  goal: Verdict
  models: Verdict
  done: Verdict
}

const ok = (reason: string): Verdict => ({ pass: true, reason })
const no = (reason: string): Verdict => ({ pass: false, reason })

/** The brief after the request: the person's words come first, then a blank line. */
const briefOf = (prompt: string, request: string) => prompt.slice(prompt.indexOf(request) + request.length).trim()

/** The Goal line, or for an unlabelled prompt its first paragraph. */
export function goalOf(prompt: string, request: string): string {
  const brief = briefOf(prompt, request)
  const labelled = brief.split('\n').find((l) => /^\s*Goal:/i.test(l))
  return (labelled ?? brief.split(/\n\s*\n/)[0]).replace(/^\s*Goal:\s*/i, '').trim()
}

const ROLE_START = /^\s*-?\s*(Explore|Plan|Build|Verify|Design|Extend|Check|Lead|Models|Done when|Goal|Context|Constraints|Roles)\b/i

/**
 * A role's text ("- Build …" and the lines under it, up to the next role or label), read below the request only: a
 * request may itself start "Plan: 1. …". Empty when the prompt has none.
 */
export function roleText(prompt: string, request: string, role: string): string {
  const lines = briefOf(prompt, request).split('\n')
  const start = lines.findIndex((l) => new RegExp(`^\\s*-?\\s*${role}\\b`, 'i').test(l))
  if (start < 0) return ''
  const end = lines.findIndex((l, i) => i > start && ROLE_START.test(l))
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}
const names = (text: string) => [...text.matchAll(/model "([^"]+)"/g)].map((m) => m[1])
const SELF = /\byou\b|\byourself\b|the lead/i
// A part the lead does itself: it says so, or (in Codex's labelled form, "Plan: write the plan …") names no model at all.
const byLead = (line: string) => SELF.test(line) || names(line).length === 0

/** 1. The Goal carries what the request asks for, in more than the request's own words. */
export function checkGoal(prompt: string, c: CategoryCase): Verdict {
  const goal = goalOf(prompt, c.request)
  if (!goal) return no('no Goal')
  const missing = c.goal.filter((re) => !re.test(goal))
  if (missing.length) return no(`the Goal leaves out ${missing.map((re) => re.source).join(', ')}: “${goal.slice(0, 160)}”`)
  if (goal.toLowerCase().replace(/[.?!]+$/, '') === c.request.toLowerCase().replace(/[.?!]+$/, '')) return no('the Goal only repeats the request')
  return ok('the Goal carries the request')
}

/** 2. Every model is the target family's, written as its agent takes it, and each part of the work has the model its rules give. */
export function checkModels(prompt: string, c: CategoryCase, target: PromptTarget): Verdict {
  const ladder = PROMPT_LADDERS[target.family]
  const at = ladder.findIndex((r) => r.profile === target.profile)
  const family = ladder.map((r) => r.name)
  const [fast, , strongRung] = [ladder[0].name, ladder[1].name, ladder[Math.max(at, 2)].name]
  const all = names(prompt)
  if (!all.length) return no('names no model')
  const foreign = all.filter((n) => !family.includes(n))
  if (foreign.length) return no(`models outside the ${target.family} family: ${[...new Set(foreign)].join(', ')}`)
  // Claude Code's subagent tool takes an alias, so each is followed by the version it means.
  if (target.family === 'claude' && /model "[a-z]+"(?! \()/.test(prompt)) return no('a Claude model without its version')
  const has = (line: string, name: string) => names(line).includes(name)
  if (c.shape === 'code') {
    const [explore, plan, build, verify] = ['Explore', 'Plan', 'Build', 'Verify'].map((r) => roleText(prompt, c.request, r))
    if (!explore || !plan || !build || !verify) return no('a code change without all four roles (Explore, Plan, Build, Verify)')
    if (!has(explore, fast) && !(at === 0 && byLead(explore))) return no(`Explore isn't on ${fast}: ${explore.trim().slice(0, 120)}`)
    if (!has(plan, strongRung) && !(at >= 2 && byLead(plan))) return no(`Plan isn't on ${strongRung}: ${plan.trim().slice(0, 120)}`)
    const builders = target.family === 'claude' ? ['haiku', 'sonnet'] : ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol']
    if (!names(build).some((n) => builders.includes(n))) return no(`Build names no builder (${builders.join(', ')})`)
    if (!has(verify, strongRung) || !/fresh/i.test(verify)) return no(`Verify isn't a fresh ${strongRung}: ${verify.trim().slice(0, 120)}`)
    const climb = family.slice(0, -1).join(' → ')
    return prompt.includes(climb) ? ok(`roles on ${[...new Set(all)].join(', ')}, climbing ${climb}`) : no(`no climb (${climb})`)
  }
  if (c.shape === 'mocks') {
    const extender = target.family === 'claude' ? 'haiku' : 'gpt-6.1-terra'
    const redo = target.family === 'claude' ? 'sonnet' : 'gpt-6.2-sol'
    if (!has(roleText(prompt, c.request, 'Design'), strongRung)) return no(`Design isn't on ${strongRung}`)
    if (!has(roleText(prompt, c.request, 'Extend'), extender)) return no(`Extend isn't on ${extender}`)
    return all.includes(redo) ? ok(`design on ${strongRung}, extend on ${extender}, redo on ${redo}`) : no(`no redo on ${redo}`)
  }
  const line = roleText(prompt, c.request, 'Models')
  if (!line) return no('no Models line')
  if (!has(line, fast) && at !== 0) return no(`the Models line doesn't put the reading on ${fast}`)
  if (c.shape === 'judge' && !has(line, strongRung) && !(at >= 2 && SELF.test(line))) return no(`the judgement isn't on ${strongRung}`)
  return ok(`Models line: ${[...new Set(names(line))].join(', ') || 'the lead'}`)
}

/** 3. Done when is a check that can fail, and says what to hand back as evidence. */
export function checkDone(prompt: string, c: CategoryCase): Verdict {
  const at = prompt.search(/done when/i)
  if (at < 0) return no('no Done when')
  const done = prompt.slice(at)
  if (c.shape === 'code') {
    if (!/\b(test|check|lint|typecheck|type check|build|measured|timed|rerun|runs)\b/i.test(done)) return no('Done when names no check to run')
    if (!/\b(pass|passes|fails?|under|matches|same)\b/i.test(done)) return no('Done when says nothing that passes or fails')
    // Evidence is what the check showed: the commands and their output, or for a prompt, each case's input and reply.
    return /\b(report|show)\b/i.test(done) && /command|input|output|reply/i.test(done) ? ok('a check that passes or fails, and what it showed as evidence') : no('Done when asks for no evidence (commands, or inputs and outputs)')
  }
  if (c.shape === 'mocks') return /index/i.test(done) && /open|link/i.test(done) && /model/i.test(done) ? ok('every file reachable from the index, and which model made each') : no('Done when misses the index or which model made each file')
  const words = (done.match(/\S+/g) ?? []).length
  if (words < 12) return no(`Done when is too thin to check (${words} words)`)
  // What comes back, said either as an instruction ("hand back", "report") or as what is true when it has ("you've walked
  // through the flow, naming the files").
  return /\b(hand(?:ed)? back|give|gives|given|report|show|list|say|mark|answer|tell|deliver|walk(?:ed)? through|nam(?:e|es|ing)|stopped to ask|options?)\b|\byou(?:'ve| have)\b/i.test(done)
    ? ok('says what to hand back')
    : no('Done when says nothing to hand back')
}

export function checkCategoryPrompt(prompt: string, c: CategoryCase, target: PromptTarget): CategoryChecks {
  return { goal: checkGoal(prompt, c), models: checkModels(prompt, c, target), done: checkDone(prompt, c) }
}

// ---- the cases ----

const PROBE = { agent: 'claude', model: 'claude-sonnet-5-5[1m]' }
const CONTROL = { agent: 'codex', model: 'gpt-6.2-sol' }
const inputOf = (c: CategoryCase, on: typeof PROBE): WritePromptInput => ({ request: c.request, ...on, answers: c.answers })
const targetOf = (input: WritePromptInput) => promptTargetFor(input.agent, input.model)!

function verdictFor(output: RunOutput, c: CategoryCase, scenario: Scenario): Verdict {
  const input = inputOf(c, scenario === 'probe' ? PROBE : CONTROL)
  const read = readAnswer(output, input)
  if ('fail' in read) return read.fail
  if (read.result.status !== 'draft') return no(`status ${read.result.status}, not a draft`)
  const checks = checkCategoryPrompt(read.result.prompt, c, targetOf(input))
  const parts = (['goal', 'models', 'done'] as const).map((k) => `${checks[k].pass ? '✓' : '✗'} ${k}: ${checks[k].reason}`)
  return { pass: parts.every((p) => p.startsWith('✓')), reason: parts.join(' · ') }
}

function categoryCase(c: CategoryCase): EvalCase<string> {
  const probe = inputOf(c, PROBE)
  const control = inputOf(c, CONTROL)
  return {
    id: `prompt-writer-category-${c.category}`,
    title: `Write a full prompt, ${c.category}: the Goal carries the request, the models follow the roles, Done when is a check`,
    source: 'docs/prompt-writer.md, Evals: the person asked for one eval per category, checking only the Goal, the models and the definition of done, after a 24-category review where brief prompts named no model.',
    before: { none: 'Models on every prompt and the roles are new in this version; the drafts without them were never committed.' },
    after: promptWriterSystemPrompt(targetOf(probe)),
    // The probe on the text under test (Claude Code, Sonnet leading); the control as the app asks it for Codex, GPT-6.2 Sol leading.
    build: (system, scenario) =>
      scenario === 'probe'
        ? { system, prompt: promptWriterMessage(probe, targetOf(probe), 'en') }
        : { system: promptWriterSystemPrompt(targetOf(control)), prompt: promptWriterMessage(control, targetOf(control), 'en') },
    check: (output, scenario) => verdictFor(output, c, scenario),
    runs: 1
  }
}

export const PROMPT_WRITER_CATEGORY_CASES: EvalCase<string>[] = CATEGORY_CASES.map(categoryCase)
