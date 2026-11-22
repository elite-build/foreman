import { parsePromptWriterAnswer, promptTargetFor, promptWriterMessage, promptWriterSystemPrompt, type WritePromptInput, type WritePromptResult } from '../../src/shared/promptWriter'
import type { EvalCase, RunOutput, Scenario, Verdict } from '../types'

// Write a full prompt (docs/prompt-writer.md): the system prompt the New workspace dialog's writer runs on, asked as
// the app asks it. Each case checks one part of the prompt's structure in code, from the failures the drafts of this
// writer showed in a model-graded structural eval while it was being built (none of those drafts was committed).

// The models the cases write for: Codex on its everyday model, Claude Code on Sonnet, and Codex on its smallest.
const CODEX = { agent: 'codex', model: 'gpt-6.2-sol' }
const CLAUDE = { agent: 'claude', model: 'claude-sonnet-5-5[1m]' }
const LUNA = { agent: 'codex', model: 'gpt-6-luna' }

const targetOf = (input: WritePromptInput) => promptTargetFor(input.agent, input.model)!
/** The system prompt the app sends for this input's model. */
const systemFor = (input: WritePromptInput) => promptWriterSystemPrompt(targetOf(input))
/** The probe on the text under test, the control as the app asks it for its own model. */
const asked = (probe: WritePromptInput, control: WritePromptInput) => (system: string, scenario: Scenario) =>
  scenario === 'probe' ? { system, prompt: promptWriterMessage(probe, targetOf(probe), 'en') } : { system: systemFor(control), prompt: promptWriterMessage(control, targetOf(control), 'en') }

const NEW = { none: 'The prompt writer is new; the drafts that showed this failure (v2 and v3 in docs/prompt-writer.md) were never committed.' }

type Parsed = Exclude<WritePromptResult, { status: 'failed' }>

/** The writer's answer read as the app reads it, or why it can't be. */
export function readAnswer(output: RunOutput, input: WritePromptInput): { result: Parsed } | { fail: Verdict } {
  const parsed = parsePromptWriterAnswer(output.text, input)
  return parsed.ok ? { result: parsed.result } : { fail: { pass: false, reason: `the answer fails the app's check: ${parsed.problem}` } }
}

const fail = (reason: string): Verdict => ({ pass: false, reason })
// "unless", "if available": a hedge reads to the agent as permission to skip what the person asked.
const HEDGE = /\bunless\b|\bif (?:available|possible|needed|feasible)\b|\bwhere possible\b/i
const line = (prompt: string, label: string) => prompt.split('\n').find((l) => l.startsWith(`${label}:`)) ?? ''
const numbersIn = (s: string) => new Set(s.match(/\d+(?:\.\d+)?/g) ?? [])

/** Every number in the prompt came from the person: a number nobody gave is an invented requirement. */
// Model names carry versions ("gpt-6.2-sol", "opus" (Opus 5.5)) that are the writer's own, not requirements anyone invented.
const MODEL_NAMES = /gpt-[\d.]+-[a-z]+|\((?:Haiku|Sonnet|Opus|Fable) [\d.]+\)/g

function inventedNumbers(prompt: string, input: WritePromptInput): string[] {
  const given = numbersIn([input.request, ...(input.answers ?? []).map((a) => a.answer)].join(' '))
  return [...numbersIn(prompt.replace(MODEL_NAMES, ''))].filter((n) => !given.has(n))
}

// prompt-writer-brief-structure

const LOGOUT: WritePromptInput = {
  request: 'users get logged out randomly, fix it',
  ...CODEX,
  answers: [
    { question: 'How long before they are logged out?', answer: 'About 30 minutes without activity' },
    { question: 'How long should a session last?', answer: '7 days' },
    { question: 'Since when?', answer: 'Since last week’s release' }
  ]
}
const THEME: WritePromptInput = {
  request: 'the theme resets after a restart',
  ...CLAUDE,
  answers: [
    { question: 'Which setting resets?', answer: 'Dark mode goes back to light' },
    { question: 'Since when?', answer: 'Since the 1.2 update' }
  ]
}

/** A Codex brief: the request first, then a Goal that says the outcome, the person's facts, their constraint and a check. */
export function codexBrief(output: RunOutput): Verdict {
  const read = readAnswer(output, LOGOUT)
  if ('fail' in read) return read.fail
  if (read.result.status !== 'draft') return fail(`status ${read.result.status}, not a draft, after the person answered`)
  const p = read.result.prompt
  if (p.split('\n')[0].trim() !== LOGOUT.request) return fail('the first line is not the request as typed')
  const goal = line(p, 'Goal')
  if (!goal) return fail('no Goal line')
  if (goal.toLowerCase().includes(LOGOUT.request)) return fail(`the Goal repeats the request: ${goal}`)
  if (!/7 days|seven days|30 min/i.test(goal)) return fail(`the Goal carries none of the person's specifics: ${goal}`)
  // Each fact reaches the prompt, and Context carries at least one of them (the Goal may hold the rest).
  const context = line(p, 'Context')
  const facts = [/30 min/i, /7 days|seven days/i, /release/i]
  if (!facts.some((re) => re.test(context))) return fail(`Context carries none of the person's facts: ${context}`)
  const lost = facts.filter((re) => !re.test(p))
  if (lost.length) return fail(`facts the person gave are missing: ${lost.map((re) => re.source).join(', ')}`)
  if (!/cause/i.test(line(p, 'Constraints'))) return fail('Constraints don’t say to fix the cause')
  const done = line(p, 'Done when')
  if (!/fail/i.test(done) || !/pass/i.test(done)) return fail(`Done when has no check that fails before and passes after: ${done}`)
  if (!/command/i.test(done)) return fail('Done when asks for no commands as evidence')
  if (HEDGE.test(p)) return fail(`a hedge: “${p.match(HEDGE)![0]}”`)
  const invented = inventedNumbers(p, LOGOUT)
  return invented.length ? fail(`numbers nobody gave: ${invented.join(', ')}`) : { pass: true, reason: 'request first; Goal, Context, Constraints and Done when each do their job' }
}

/** A Claude brief: the person's facts, a Done when, no hedge and no number nobody gave. A code change uses labelled lines for its roles. */
export function claudeBrief(output: RunOutput): Verdict {
  const read = readAnswer(output, THEME)
  if ('fail' in read) return read.fail
  if (read.result.status !== 'draft') return fail(`status ${read.result.status}, not a draft, after the person answered`)
  const p = read.result.prompt
  if (!p.startsWith(THEME.request)) return fail('the prompt doesn’t start with the request as typed')
  if (!/dark/i.test(p) || !/1\.2/.test(p)) return fail('the person’s facts (dark mode, the 1.2 update) are missing')
  if (!/done when/i.test(p)) return fail('no “Done when”')
  if (HEDGE.test(p)) return fail(`a hedge: “${p.match(HEDGE)![0]}”`)
  const invented = inventedNumbers(p, THEME)
  return invented.length ? fail(`numbers nobody gave: ${invented.join(', ')}`) : { pass: true, reason: 'the facts and a Done when' }
}

export const promptWriterBriefStructure: EvalCase<string> = {
  id: 'prompt-writer-brief-structure',
  title: 'Write a full prompt: the Goal says the outcome with the person’s specifics, and each part does its job',
  source: 'docs/prompt-writer.md, Evals: v2 put the request in the Goal line, so the Goal only repeated it (graded 1 of 2), listed places to look in Context and hedged its constraints (“unless that is the actual cause”).',
  before: NEW,
  after: systemFor(LOGOUT),
  build: asked(LOGOUT, THEME),
  check: (output, scenario) => (scenario === 'probe' ? codexBrief(output) : claudeBrief(output))
}

// prompt-writer-explain-read-only

const EXPLAIN: WritePromptInput = {
  request: 'how does restoring a checkpoint work?',
  ...LUNA,
  answers: [{ question: 'What are you trying to find out?', answer: 'Why a restore lost a file I had just created' }]
}
const EXPLAIN_CLAUDE: WritePromptInput = { request: 'explain how the export queue decides what runs next', ...CLAUDE }
const RUNS_THINGS = /report what changed|run the (?:relevant |project’s |project's )?tests|fix failures/i

/** An explanation stays read only: no report of changes, no tests to run, and the person's purpose in it. */
export function explainReadOnly(output: RunOutput, scenario: Scenario): Verdict {
  const input = scenario === 'probe' ? EXPLAIN : EXPLAIN_CLAUDE
  const read = readAnswer(output, input)
  if ('fail' in read) return read.fail
  if (scenario === 'control' && read.result.status === 'ask') return read.result.questions.length <= 3 ? { pass: true, reason: 'asked first' } : fail('more than three questions')
  if (read.result.status !== 'draft') return fail(`status ${read.result.status}, not a draft`)
  const p = read.result.prompt
  if (!/read[- ]only|don[’']t change|do not change|no (?:code )?changes/i.test(p)) return fail('nothing says read only')
  if (RUNS_THINGS.test(p)) return fail(`asks an explanation to run or report changes: “${p.match(RUNS_THINGS)![0]}”`)
  if (scenario === 'probe' && !/lost|created/i.test(p)) return fail('the person’s purpose (a restore lost a new file) is missing')
  return { pass: true, reason: 'read only, nothing to run, purpose carried' }
}

export const promptWriterExplainReadOnly: EvalCase<string> = {
  id: 'prompt-writer-explain-read-only',
  title: 'Write a full prompt: a request to explain stays read only and carries what the person wants to find out',
  source: 'docs/prompt-writer.md, Evals: v3’s profile for other agents added “Report what changed, what you ran and what it showed” to an explanation (graded 0: evidence where none belongs) and padded its Goal with topics nobody raised.',
  before: NEW,
  after: systemFor(EXPLAIN),
  build: asked(EXPLAIN, EXPLAIN_CLAUDE),
  check: explainReadOnly
}

// prompt-writer-precise-drafted

const RENAME: WritePromptInput = { request: 'Rename the `oneShotDraft` method in src/main/core.ts to `draftOneShot` and update its callers.', ...CLAUDE }
const VAGUE: WritePromptInput = { request: 'make the sidebar better', ...CLAUDE }

/**
 * Write a full prompt is for a thorough prompt with its models chosen, so even a request that already says what and
 * where is drafted: its words kept, its models named, a Done when. Nothing comes back unchanged for being precise.
 */
export function preciseDrafted(output: RunOutput, scenario: Scenario): Verdict {
  const input = scenario === 'probe' ? RENAME : VAGUE
  const read = readAnswer(output, input)
  if ('fail' in read) return read.fail
  if (read.result.status === 'unchanged') return fail(scenario === 'probe' ? 'a precise request came back unchanged' : 'a vague request came back unchanged')
  if (scenario === 'control') return { pass: true, reason: read.result.status }
  if (read.result.status !== 'draft') return fail(`status ${read.result.status}`)
  const p = read.result.prompt
  if (!/model "/.test(p)) return fail('the draft names no model')
  return /done when/i.test(p) ? { pass: true, reason: 'drafted with its models and a Done when' } : fail('the draft has no Done when')
}

export const promptWriterPreciseDrafted: EvalCase<string> = {
  id: 'prompt-writer-precise-drafted',
  title: 'Write a full prompt: a precise request is still drafted with its models, and a vague one never comes back unchanged',
  source: 'docs/prompt-writer.md, Evals: v2 and v3 padded an exact rename with words that repeated it; since Write a full prompt became the thorough path, a precise request gets its roles and check rather than coming back unchanged.',
  before: NEW,
  after: systemFor(RENAME),
  build: asked(RENAME, VAGUE),
  check: preciseDrafted
}

// prompt-writer-asks-for-specifics

const VAGUE_BUG: WritePromptInput = { request: 'users get logged out randomly, fix it', ...CODEX }
const VAGUE_BUG_CLAUDE: WritePromptInput = { request: 'the export button does nothing sometimes', ...CLAUDE }
const NOT_AN_ANSWER = /i[’']?ll (?:paste|type|share)|^other\b|yes,? i have/i
const PRESUMED = /\b(?:web|mobile|ios|android|browsers?|desktop|devices?)\b/i

function cleanQuestions(result: Parsed): Verdict | null {
  if (result.status !== 'ask') return null
  for (const q of result.questions) {
    const bad = q.options.find((o) => NOT_AN_ANSWER.test(o))
    if (bad) return fail(`an option that isn’t an answer: “${bad}”`)
    const presumed = [q.question, ...q.options].find((t) => PRESUMED.test(t))
    if (presumed) return fail(`presumes a fact about the product: “${presumed}”`)
  }
  return { pass: true, reason: `${result.questions.length} clean questions` }
}

/** A vague bug gets questions with concrete options (a duration, a number), none presuming the product. */
export function asksForSpecifics(output: RunOutput, scenario: Scenario): Verdict {
  const input = scenario === 'probe' ? VAGUE_BUG : VAGUE_BUG_CLAUDE
  const read = readAnswer(output, input)
  if ('fail' in read) return read.fail
  const clean = cleanQuestions(read.result)
  if (scenario === 'control') return clean ?? { pass: true, reason: read.result.status }
  if (!clean) return fail(`status ${read.result.status}: a vague bug should be asked about first`)
  if (!clean.pass) return clean
  const concrete = read.result.status === 'ask' && read.result.questions.some((q) => q.options.some((o) => /\d|minute|hour|second|day|week/i.test(o)))
  return concrete ? clean : fail('no option offers a concrete value (a duration or a number), only categories')
}

export const promptWriterAsksForSpecifics: EvalCase<string> = {
  id: 'prompt-writer-asks-for-specifics',
  title: 'Write a full prompt: a vague bug is asked about with concrete options, not categories',
  source: 'docs/prompt-writer.md, Evals: v2 asked “what do you notice?” with options like “After being idle for a while”, so “about 30 minutes” and “sessions last 7 days” never reached the prompt; early runs offered “Web only” and “I’ll paste it”.',
  before: NEW,
  after: systemFor(VAGUE_BUG),
  build: asked(VAGUE_BUG, VAGUE_BUG_CLAUDE),
  check: asksForSpecifics
}

// prompt-writer-several-constraints

const CLEANUP: WritePromptInput = { request: 'clean up the settings code', ...CODEX }
const CLEANUP_ANSWERED: WritePromptInput = {
  ...CLEANUP,
  answers: [
    { question: 'What is wrong with it?', answer: 'The same validation is copied in about four places' },
    { question: 'What must stay the same?', answer: 'Behaviour stays identical; No new dependencies; Small enough to review in one sitting' }
  ]
}

/** What must not change is asked as several picks; given several, every one reaches the prompt. */
export function severalConstraints(output: RunOutput, scenario: Scenario): Verdict {
  const input = scenario === 'probe' ? CLEANUP : CLEANUP_ANSWERED
  const read = readAnswer(output, input)
  if ('fail' in read) return read.fail
  if (scenario === 'probe') {
    if (read.result.status !== 'ask') return fail(`status ${read.result.status}: “clean up” names no problem and should be asked about`)
    return read.result.questions.some((q) => q.multi) ? { pass: true, reason: 'a question takes several picks' } : fail('no question takes several picks, so only one constraint can come back')
  }
  if (read.result.status !== 'draft') return fail(`status ${read.result.status}, not a draft, after the person answered`)
  const p = read.result.prompt
  const missing = [
    ['identical behaviour', /identical|same|unchanged|no behaviou?r change/i],
    ['no new dependencies', /dependenc/i],
    ['small enough to review', /review|small/i],
    ['validation in about four places', /validat/i]
  ].filter(([, re]) => !(re as RegExp).test(p))
  return missing.length ? fail(`missing: ${missing.map(([name]) => name).join(', ')}`) : { pass: true, reason: 'every constraint and the problem carried' }
}

export const promptWriterSeveralConstraints: EvalCase<string> = {
  id: 'prompt-writer-several-constraints',
  title: 'Write a full prompt: what must not change takes several picks, and every pick reaches the prompt',
  source: 'docs/prompt-writer.md, Evals: with one pick per question, a cleanup’s “what must stay the same?” carried one of the person’s three constraints (identical behaviour, no new dependencies, small).',
  before: NEW,
  after: systemFor(CLEANUP),
  build: asked(CLEANUP, CLEANUP_ANSWERED),
  check: severalConstraints
}
