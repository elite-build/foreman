import { z } from 'zod'
import { jobPrompt } from '../../src/shared/employeePrompts'
import { EMPLOYEE_TOOLS } from '../../src/shared/employeeTools'
import { checkQuestions, planningBody, type QuestionsInput } from '../../src/shared/projects'
import type { EvalCase, FakeTool, ToolCall } from '../types'

// The program manager's questions round with a picture (docs/project-planning.md 6.1). The picture ("map") isn't built
// yet, so the text under test is the design's draft, written here: the tool's description and arguments, and the lines
// of her task that say what she may show. When the slice that adds the map lands, `after` becomes an import from
// src/shared (employeeTools.ts and projects.ts) and the checks below become the ones Foreman itself runs.

// ---- the picture, as her tool takes it ----

const KINDS = ['person', 'screen', 'action', 'service', 'data', 'outside'] as const
const id = z.string().trim().min(1).max(32)

export interface MapItem {
  id: string
  lane: string
  label: string
  detail?: string
  example?: string
  kind: (typeof KINDS)[number]
  change?: 'new' | 'changed' | 'removed'
  open?: boolean
}
export interface MapLink {
  id?: string
  from: string
  to: string
  label?: string
  open?: boolean
}
export interface PlanMap {
  lanes: { id: string; label: string }[]
  items: MapItem[]
  links: MapLink[]
  says: string[]
}
export interface RoundInput extends QuestionsInput {
  map?: PlanMap
  questions: { question: string; why?: string; options?: string[]; about?: string }[]
}

const MAP = z
  .object({
    lanes: z.array(z.object({ id, label: z.string().trim().min(1).max(40) }).strict()),
    items: z.array(
      z
        .object({
          id,
          lane: id,
          label: z.string().trim().min(1).max(60),
          detail: z.string().trim().max(80).optional(),
          example: z.string().trim().max(300).optional(),
          kind: z.enum(KINDS),
          change: z.enum(['new', 'changed', 'removed']).optional(),
          open: z.boolean().optional()
        })
        .strict()
    ),
    links: z.array(z.object({ id: id.optional(), from: id, to: id, label: z.string().trim().max(40).optional(), open: z.boolean().optional() }).strict()),
    says: z.array(z.string().trim().min(1).max(300))
  })
  .strict()

/** project_questions as the app has it today, and what the draft adds: a picture, and what each question is about. */
const TODAY = EMPLOYEE_TOOLS.project_questions
const QUESTION = z.object({ question: z.string().trim().min(1).max(2_000), why: z.string().trim().min(1).max(500).optional(), options: z.array(z.string().trim().min(1).max(200)).max(6).optional(), about: id.optional() }).strict()

export const MAX_LANES = 4
export const MAX_IN_LANE = 4
export const MAX_ITEMS = 12

/** The model-facing text under test: her tool, and the lines of her task that say what she may show. */
export interface RoundTexts {
  description: string
  schema: z.ZodRawShape
  show: string
}

const AFTER: RoundTexts = {
  description: `${TODAY.description} map: a picture of the thing you propose (not of who does the work), given unless one sentence describes the whole change: lanes (rows, top to bottom), items (in a lane, left to right in the order you give), links (an arrow from one item to another) and says (the same in words). A question names the item or link it is about (about).`,
  schema: {
    understood: z.array(z.string().trim().min(1).max(500)).max(12).optional(),
    map: MAP.optional(),
    questions: z.array(QUESTION).min(1).max(10)
  },
  show: [
    'What you may show with your questions:',
    '- A request that changes what someone sees or does, or how parts connect, gets a picture of the thing you propose: give map with your questions. It shows the person, what they do, and what changes underneath, so they can see what you understood before they answer. Only a change one sentence describes (a typo, a rename) goes without one.',
    `- lanes are rows, at most ${MAX_LANES}. Items in a lane are drawn left to right in the order you give, at most ${MAX_IN_LANE} in a lane and ${MAX_ITEMS} in all. Show only the steps that matter for the decision.`,
    '- kind: person, screen, action, service, data or outside. change: new, changed or removed against today’s product; leave it out for what stays.',
    '- open: true on an item or a link means not decided yet. Mark what you ask about as open and name it in the question’s about. Never draw something you are asking about as if it were settled, and mark nothing open that no question is about.',
    '- says: the same picture in words, 1 to 8 lines.',
    'Foreman checks the picture and answers what to fix.'
  ].join('\n')
}

// ---- what Foreman would say of a round (the draft's checks, pure) ----

/** What Foreman refuses: today's checks on the questions, and a picture that can't be drawn as given. */
export function roundProblems(input: RoundInput): string[] {
  const asked = checkQuestions(input, { answered: false, skipped: false, open: false, left: 3 })
  const problems = asked.ok ? [] : [...asked.problems]
  const map = input.map
  const targets = new Set([...(map?.items ?? []).map((i) => i.id), ...(map?.links ?? []).flatMap((l) => (l.id ? [l.id] : []))])
  for (const [n, q] of (input.questions ?? []).entries()) if (q.about && !targets.has(q.about)) problems.push(`Question ${n + 1} is about “${q.about}”, which isn’t an item or a link of the picture.`)
  if (!map) return problems
  const lanes = new Set(map.lanes.map((l) => l.id))
  const items = new Set(map.items.map((i) => i.id))
  if (!map.lanes.length || map.lanes.length > MAX_LANES) problems.push(`A picture has 1 to ${MAX_LANES} lanes; this one has ${map.lanes.length}.`)
  if (!map.items.length || map.items.length > MAX_ITEMS) problems.push(`A picture has 1 to ${MAX_ITEMS} items; this one has ${map.items.length}. Show the steps that matter for this decision.`)
  if (items.size < map.items.length) problems.push('Two items share an id.')
  for (const lane of map.lanes) if (map.items.filter((i) => i.lane === lane.id).length > MAX_IN_LANE) problems.push(`Lane “${lane.label}” has more than ${MAX_IN_LANE} items.`)
  for (const i of map.items) if (!lanes.has(i.lane)) problems.push(`Item “${i.label}” is in lane “${i.lane}”, which isn’t one of the lanes.`)
  for (const l of map.links) for (const end of [l.from, l.to]) if (!items.has(end)) problems.push(`A link names “${end}”, which isn’t an item.`)
  if (!map.says.length || map.says.length > 8) problems.push('says: the same picture in words, 1 to 8 lines.')
  return [...new Set(problems)]
}

/**
 * What Foreman remarks on: a question about something drawn as settled, and something drawn as not decided that no
 * question is about. A question about a link covers the items it joins, and one about an item covers the links at it.
 */
export function roundRemarks(input: RoundInput): string[] {
  const map = input.map
  if (!map) return []
  const remarks: string[] = []
  const abouts = new Set((input.questions ?? []).flatMap((q) => (q.about ? [q.about] : [])))
  const item = (x: string) => map.items.find((i) => i.id === x)
  for (const [n, q] of (input.questions ?? []).entries()) {
    const thing = q.about ? (item(q.about) ?? map.links.find((l) => l.id === q.about)) : undefined
    if (thing && !thing.open) remarks.push(`Question ${n + 1} is about “${thing.label ?? q.about}”, which isn’t marked as not decided.`)
  }
  const asked = (x: string) => abouts.has(x)
  for (const i of map.items) if (i.open && !asked(i.id) && !map.links.some((l) => l.id && asked(l.id) && (l.from === i.id || l.to === i.id))) remarks.push(`“${i.label}” is marked as not decided, and no question is about it.`)
  for (const l of map.links) if (l.open && !(l.id && asked(l.id)) && !asked(l.from) && !asked(l.to)) remarks.push(`The link from “${item(l.from)?.label ?? l.from}” to “${item(l.to)?.label ?? l.to}” is marked as not decided, and no question is about it.`)
  return remarks
}

// ---- the project she is given ----

/** A small repository, read through repo_files and repo_read. It settles who may change a subscription: asking that is asking what she could have read. */
const REPO: Record<string, string> = {
  'README.md': 'Atlas: invoices and reports for small teams. A team subscribes monthly or yearly and pays by card. web/ is the app, server/ the API, docs/ what we decided and why.',
  'docs/billing.md': [
    '# Billing',
    'Only a team’s owner can open Settings › Billing. Admins and members never see it.',
    'That holds for every subscription action, including any added later (pause, downgrade): decided with finance in March, see docs/decisions.md.',
    'Subscriptions are held by the card provider (Stripe); Atlas stores the status it reports: active, past_due or canceled.',
    'Cancel takes effect at the end of the paid period; the team keeps read access to its invoices and reports after that.'
  ].join('\n'),
  'docs/decisions.md': '# Decisions\n2026-03-11: Subscription changes are owner-only, now and for anything we add. Finance wants one accountable person per team.',
  'web/settings/billing/BillingPage.tsx': [
    "if (role !== 'owner') return <NotAllowed />",
    '<h1>Billing overveiw</h1>',
    '<Plan /> <NextInvoice />',
    '<Button>Change plan</Button> <Button danger>Cancel subscription</Button>'
  ].join('\n'),
  'server/billing/subscriptions.ts': "export type Status = 'active' | 'past_due' | 'canceled'\nexport async function cancelAtPeriodEnd(teamId: string) { /* asks the card provider to stop at the period's end */ }"
}

const ROSTER = [
  { id: 'e-pm01', name: 'Priya', role: 'Program manager', askMeAbout: 'projects, plans', state: 'approved' },
  { id: 'e-rv02', name: 'Ravi', role: 'Software engineer', askMeAbout: 'the server, billing', state: 'approved' },
  { id: 'e-me03', name: 'Mei', role: 'Frontend engineer', askMeAbout: 'the web app, settings pages', state: 'approved' },
  { id: 'e-qn04', name: 'Quinn', role: 'QA engineer', askMeAbout: 'tests, what was checked', state: 'approved' }
]

const REQUEST = {
  probe: 'Let customers pause their subscription instead of cancelling.',
  control: 'Fix the typo on the billing page.'
}

const shape = (schema: unknown): z.ZodRawShape => (schema as z.ZodObject<z.ZodRawShape>).shape

function tools(variant: RoundTexts): FakeTool[] {
  return [
    { name: 'repo_files', description: 'List the files of the atlas repository.', schema: {}, reply: () => Object.keys(REPO).join('\n') },
    { name: 'repo_read', description: 'Read one file of the atlas repository.', schema: { path: z.string() }, reply: (args) => REPO[String(args.path)] ?? `No such file: ${String(args.path)}` },
    {
      name: 'project_questions',
      description: variant.description,
      schema: variant.schema,
      reply: (args) => {
        const input = args as unknown as RoundInput
        const problems = roundProblems(input)
        if (problems.length) return `Foreman didn’t accept your questions:\n${problems.map((p) => `- ${p}`).join('\n')}\nFix them and call project_questions again.`
        const remarks = roundRemarks(input)
        return remarks.length
          ? `Foreman recorded your questions (round 1), and remarks:\n${remarks.map((r) => `- ${r}`).join('\n')}\nCall project_questions again to change them, or finish_task done.`
          : 'Foreman recorded your questions (round 1). Now finish_task done: the person’s answers start your next run.'
      }
    },
    { name: 'project_plan', description: EMPLOYEE_TOOLS.project_plan.description, schema: shape(EMPLOYEE_TOOLS.project_plan.schema), reply: () => 'Foreman didn’t accept the plan:\n- Ask before you plan: call project_questions with what you need to know, then finish_task done.' },
    { name: 'finish_task', description: EMPLOYEE_TOOLS.finish_task.description, schema: shape(EMPLOYEE_TOOLS.finish_task.schema), reply: () => 'Recorded. End your turn.' }
  ]
}

/** The round Foreman would have kept: the last one it accepted. */
export function acceptedRound(calls: ToolCall[]): RoundInput | undefined {
  return calls
    .filter((c) => c.name === 'project_questions')
    .map((c) => c.args as unknown as RoundInput)
    .filter((r) => !roundProblems(r).length)
    .at(-1)
}

/** Whether a question asks who may pause. Words, so approximate: it is the one check here that reads phrasing. */
export function asksWhoMayPause(question: string): boolean {
  // "Who can pause?", "Should admins be able to pause?", "Is it right that only the owner can pause?". Not "Where should the owner see pause?".
  return /\bwho\b[^?.]*\b(can|may|should|is allowed to|gets to)\b[^?.]*\bpaus/i.test(question) || /\b(admins?|members?|anyone|everyone|only (the|a) (team(’s|'s)? )?owners?)\b[^?.]*\b(can|may|able to|allowed to)\b[^?.]*\bpaus/i.test(question)
}

export const planRoundOpenSteps: EvalCase<RoundTexts> = {
  id: 'plan-round-open-steps',
  title: 'The program manager draws what she asks about as not decided, and asks nothing the repository answers',
  source:
    'Two trials of the draft format on 2026-11-18 (docs/project-planning.md 12 and 14): a model asked “who can pause?” about a step it had drawn as settled, and another drew an undecided branch as a decided arrow. Both rounds were valid data, so only a check on open and about catches them.',
  before: { none: 'The picture is new in docs/project-planning.md (not built yet): project_questions has never taken a map, so no earlier text can be compared.' },
  after: AFTER,
  build: (variant, scenario) => {
    const requirement = REQUEST[scenario]
    return {
      system: `You are Priya, an AI employee of Acme, run by Foreman.\n\n## Your instructions\n\n${jobPrompt('program-manager')}`,
      prompt: [
        planningBody({ project: { title: requirement.replace(/\.$/, ''), requirement, slug: 'p' }, organization: 'Acme', repos: ['atlas'], roster: ROSTER }),
        variant.show,
        'In this run you read the repository with repo_files and repo_read.'
      ]
        .filter(Boolean)
        .join('\n\n'),
      tools: tools(variant),
      maxTurns: 16
    }
  },
  check: (output, scenario) => {
    if (output.calls.some((c) => c.name === 'project_plan')) return { pass: false, reason: 'planned in the task that asks' }
    const round = acceptedRound(output.calls)
    if (!round) return { pass: false, reason: output.calls.some((c) => c.name === 'project_questions') ? `no round Foreman would accept: ${roundProblems(output.calls.findLast((c) => c.name === 'project_questions')!.args as unknown as RoundInput).join(' ')}` : 'never asked: no project_questions call' }
    if (scenario === 'control') return round.questions.length > 4 ? { pass: false, reason: `${round.questions.length} questions for a typo` } : { pass: true, reason: `asked ${round.questions.length} before planning a small change` }
    const first = output.calls.findIndex((c) => c.name === 'project_questions')
    if (!output.calls.slice(0, first).some((c) => c.name === 'repo_read')) return { pass: false, reason: 'asked before reading any file of the repository' }
    if (!round.map) return { pass: false, reason: 'drew nothing for a request that changes what a customer sees' }
    const remarks = roundRemarks(round)
    if (remarks.length) return { pass: false, reason: remarks.join(' ') }
    const read = round.questions.find((q) => asksWhoMayPause(q.question))
    if (read) return { pass: false, reason: `asked what docs/billing.md settles: “${read.question}”` }
    return { pass: true, reason: `${round.questions.length} questions, ${round.map.items.filter((i) => i.open).length + round.map.links.filter((l) => l.open).length} things drawn as not decided, each with its question` }
  }
}
